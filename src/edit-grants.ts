import { resolve } from 'node:path';
import { execa } from 'execa';
import { metadata, rawHash, readJson, writeJson } from './core.js';
import { fingerprint } from './fingerprint.js';
import type {
  ContextPage,
  ContextSnapshot,
  EditGrant,
  EditGrantRegistryIR,
  EditPermission,
} from './types.js';

export type GrantIdentity = {
  taskId: string;
  sessionId: string;
  repositoryId: string;
  baseCommit: string;
  epoch: number;
};

const registryPath = (workspace: string, taskId: string) =>
  `${metadata(workspace)}/edit-grants/${taskId}.json`;
const snapshotPath = (workspace: string, taskId: string) =>
  `${metadata(workspace)}/tasks/${taskId}-context.json`;

function canonicalRegistryValue(registry: Omit<EditGrantRegistryIR, 'mappingSha256'>) {
  return {
    schemaVersion: registry.schemaVersion,
    taskId: registry.taskId,
    sessionId: registry.sessionId,
    repositoryId: registry.repositoryId,
    baseCommit: registry.baseCommit,
    epoch: registry.epoch,
    nextHandle: registry.nextHandle,
    grants: [...registry.grants]
      .sort((left, right) => left.handle.localeCompare(right.handle, 'en', { numeric: true }))
      .map((grant) => ({
        schemaVersion: grant.schemaVersion,
        handle: grant.handle,
        taskId: grant.taskId,
        sessionId: grant.sessionId,
        repositoryId: grant.repositoryId,
        baseCommit: grant.baseCommit,
        path: grant.path,
        fingerprint: grant.fingerprint,
        permissions: [...grant.permissions].sort(),
        epoch: grant.epoch,
        contextPageId: grant.contextPageId,
        invalidated: grant.invalidated,
        startLine: grant.startLine,
        endLine: grant.endLine,
        complete: grant.complete,
      })),
  };
}

export function editGrantMappingDigest(
  registry: Omit<EditGrantRegistryIR, 'mappingSha256'>,
) {
  return rawHash(Buffer.from(JSON.stringify(canonicalRegistryValue(registry)), 'utf8'));
}

async function gitValue(
  workspace: string,
  arguments_: string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const result = await execa('git', arguments_, {
    cwd: workspace,
    reject: false,
    timeout: 2_000,
    cancelSignal: signal,
  });
  signal?.throwIfAborted();
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export async function repositoryGrantIdentity(
  workspace: string,
  options: { signal?: AbortSignal } = {},
) {
  const gitRoot = await gitValue(
    workspace,
    ['rev-parse', '--show-toplevel'],
    options.signal,
  );
  const baseCommit =
    (await gitValue(workspace, ['rev-parse', 'HEAD'], options.signal)) ??
    'NON_GIT';
  const normalizedPath = resolve(gitRoot ?? workspace).replaceAll('\\', '/');
  const normalizedRoot =
    process.platform === 'win32'
      ? normalizedPath.toLowerCase()
      : normalizedPath;
  return {
    repositoryId: `repo:${rawHash(Buffer.from(normalizedRoot, 'utf8'))}`,
    baseCommit,
  };
}

function permissionsFor(page: ContextPage): readonly EditPermission[] {
  if (
    !['file', 'dependency', 'symbol'].includes(page.kind) ||
    page.fingerprint.kind !== 'git'
  ) {
    return [];
  }
  return page.complete === false
    ? (['replace_text'] as const)
    : (['replace_file', 'replace_text'] as const);
}

function addGrant(registry: EditGrantRegistryIR, page: ContextPage) {
  const grant: EditGrant = {
    schemaVersion: 1,
    handle: `E${registry.nextHandle}`,
    taskId: registry.taskId,
    sessionId: registry.sessionId,
    repositoryId: registry.repositoryId,
    baseCommit: registry.baseCommit,
    path: page.path,
    fingerprint: page.fingerprint.value,
    permissions: permissionsFor(page),
    epoch: registry.epoch,
    contextPageId: page.id,
    invalidated: page.invalidated,
    startLine: page.startLine,
    endLine: page.endLine,
    complete: page.complete !== false,
  };
  registry.nextHandle += 1;
  registry.grants.push(grant);
  return grant;
}

function refreshDigest(registry: EditGrantRegistryIR) {
  registry.mappingSha256 = editGrantMappingDigest(registry);
  return registry;
}

export async function createEditGrantRegistry(
  workspace: string,
  taskId: string,
  sessionId: string,
  pages: ContextPage[],
) {
  const identity = await repositoryGrantIdentity(workspace);
  const registry: EditGrantRegistryIR = {
    schemaVersion: 1,
    taskId,
    sessionId,
    ...identity,
    epoch: 1,
    nextHandle: 1,
    grants: [],
    mappingSha256: '',
  };
  for (const page of pages) {
    const current = await fingerprint(workspace, page.path);
    if (
      current.value !== page.fingerprint.value ||
      current.rawSha256 !== page.fingerprint.rawSha256 ||
      current.byteLength !== page.fingerprint.byteLength
    ) {
      throw new Error(`stale context while issuing edit grant: ${page.path}`);
    }
    addGrant(registry, page);
  }
  refreshDigest(registry);
  persistEditGrantRegistry(workspace, registry);
  return registry;
}

export function persistEditGrantRegistry(
  workspace: string,
  registry: EditGrantRegistryIR,
) {
  refreshDigest(registry);
  writeJson(registryPath(workspace, registry.taskId), registry);
}

export function loadEditGrantRegistry(workspace: string, taskId: string) {
  const registry = readJson<EditGrantRegistryIR>(registryPath(workspace, taskId));
  if (registry.schemaVersion !== 1) {
    throw new Error(`unsupported edit grant registry version: ${registry.schemaVersion}`);
  }
  const expected = editGrantMappingDigest(registry);
  if (registry.mappingSha256 !== expected) {
    throw new Error(
      `edit grant registry integrity mismatch: expected=${expected}; stored=${registry.mappingSha256}`,
    );
  }
  if (new Set(registry.grants.map((grant) => grant.handle)).size !== registry.grants.length) {
    throw new Error('edit grant registry contains duplicate handles');
  }
  for (const grant of registry.grants) {
    if (
      grant.taskId !== registry.taskId ||
      grant.sessionId !== registry.sessionId ||
      grant.repositoryId !== registry.repositoryId ||
      grant.baseCommit !== registry.baseCommit
    ) {
      throw new Error(`edit grant registry binding mismatch: ${grant.handle}`);
    }
  }
  return registry;
}

export async function syncEditGrantRegistry(
  workspace: string,
  registry: EditGrantRegistryIR,
  pages: ContextPage[],
) {
  const previouslyActive = registry.grants.filter((grant) => !grant.invalidated);
  let changedIdentity = false;
  for (const grant of previouslyActive) {
    try {
      if ((await fingerprint(workspace, grant.path)).value !== grant.fingerprint) {
        changedIdentity = true;
      }
    } catch {
      changedIdentity = true;
    }
  }
  for (const page of pages) {
    const current = await fingerprint(workspace, page.path);
    if (
      current.value !== page.fingerprint.value ||
      current.rawSha256 !== page.fingerprint.rawSha256 ||
      current.byteLength !== page.fingerprint.byteLength
    ) {
      registry.grants
        .filter((grant) => grant.path === page.path)
        .forEach((grant) => {
          grant.invalidated = true;
        });
      persistEditGrantRegistry(workspace, registry);
      throw new Error(`stale context while issuing edit grant: ${page.path}`);
    }
  }
  changedIdentity ||= pages.some((page) =>
    previouslyActive.some(
      (grant) =>
        grant.path === page.path &&
        grant.fingerprint !== page.fingerprint.value,
    ),
  );
  if (changedIdentity) {
    registry.grants.forEach((grant) => {
      grant.invalidated = true;
    });
    registry.epoch += 1;
  }

  for (const page of pages) {
    const existing = registry.grants.find(
      (grant) =>
        !grant.invalidated &&
        grant.epoch === registry.epoch &&
        grant.contextPageId === page.id &&
        grant.path === page.path &&
        grant.fingerprint === page.fingerprint.value,
    );
    if (!existing) addGrant(registry, page);
  }
  persistEditGrantRegistry(workspace, registry);
  return registry;
}

export function assertRegistryIdentity(
  registry: EditGrantRegistryIR,
  identity: GrantIdentity,
) {
  if (new Set(registry.grants.map((grant) => grant.handle)).size !== registry.grants.length) {
    throw new Error('edit grant registry contains duplicate handles');
  }
  for (const field of [
    'taskId',
    'sessionId',
    'repositoryId',
    'baseCommit',
    'epoch',
  ] as const) {
    if (registry[field] !== identity[field]) {
      const label =
        field === 'taskId'
          ? 'task'
          : field === 'sessionId'
            ? 'session'
            : field === 'repositoryId'
              ? 'repository'
              : field === 'baseCommit'
                ? 'base commit'
                : field;
      throw new Error(`edit grant ${label} mismatch`);
    }
  }
  if (registry.mappingSha256 !== editGrantMappingDigest(registry)) {
    throw new Error('edit grant registry integrity mismatch');
  }
}

export function grantForPage(registry: EditGrantRegistryIR, page: ContextPage) {
  return registry.grants.find(
    (grant) =>
      !grant.invalidated &&
      grant.epoch === registry.epoch &&
      grant.contextPageId === page.id &&
      grant.path === page.path &&
      grant.fingerprint === page.fingerprint.value,
  );
}

export function providerContextPage(
  registry: EditGrantRegistryIR,
  page: ContextPage,
) {
  const grant = grantForPage(registry, page);
  if (!grant) throw new Error(`context page has no active edit grant: ${page.path}`);
  return {
    editHandle: grant.handle,
    path: page.path,
    symbol: page.symbol,
    startLine: page.startLine,
    endLine: page.endLine,
    content: page.content,
    permissions: [...grant.permissions],
    complete: page.complete !== false,
  };
}

export function persistContextSnapshot(
  workspace: string,
  registry: EditGrantRegistryIR,
  pages: ContextPage[],
) {
  const snapshot: ContextSnapshot = {
    schemaVersion: 1,
    taskId: registry.taskId,
    sessionId: registry.sessionId,
    repositoryId: registry.repositoryId,
    baseCommit: registry.baseCommit,
    epoch: registry.epoch,
    editGrantMappingSha256: registry.mappingSha256,
    pages,
  };
  writeJson(snapshotPath(workspace, registry.taskId), snapshot);
  return snapshot;
}
