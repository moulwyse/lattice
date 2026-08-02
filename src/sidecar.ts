import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { rm as removeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { rawHash, readJson, safeReadPath } from './core.js';
import {
  editGrantMappingDigest,
  loadEditGrantRegistry,
  repositoryGrantIdentity,
} from './edit-grants.js';
import { fingerprint } from './fingerprint.js';
import { buildIndex, searchIndex } from './indexer.js';
import { isProcessAlive, terminateProcessTree } from './managed-process.js';
import {
  SIDECAR_PROTOCOL_VERSION,
  SidecarAttachRequestSchema,
  SidecarContextRequestSchema,
  SidecarDetachRequestSchema,
  SidecarResponseSchema,
  SidecarStateSchema,
  SidecarTelemetryArtifactSchema,
  type SidecarResponse,
  type SidecarState,
} from './sidecar-protocol.js';
import type { RepositoryIndex } from './types.js';

const HeartbeatRequestSchema = SidecarDetachRequestSchema;
const ShutdownRequestSchema = SidecarAttachRequestSchema;
const MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_LEASE_TTL_MS = 15_000;
const DEFAULT_IDLE_SHUTDOWN_MS = 30_000;
const MIN_STARTUP_LEASE_GRACE_MS = 1_000;

export type SidecarPaths = {
  directory: string;
  state: string;
  lock: string;
  log: string;
  telemetry: string;
};

export type SidecarLease = {
  state: SidecarState;
  leaseId: string;
  detach(nativeProcessLifetimeMs?: number): Promise<void>;
  stopHeartbeat(): void;
};

export type SidecarServer = {
  state(): SidecarState;
  closed: Promise<void>;
  close(): Promise<void>;
};

export function sidecarPaths(workspace: string): SidecarPaths {
  const directory = join(resolve(workspace), '.lattice', 'sidecar');
  return {
    directory,
    state: join(directory, 'state.json'),
    lock: join(directory, 'sidecar.lock'),
    log: join(directory, 'sidecar.log'),
    telemetry: join(directory, 'telemetry.json'),
  };
}

type RepositoryBinding = {
  workspace: string;
  repositoryId: string;
};

function canonicalPath(path: string) {
  const value = realpathSync.native(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function canonicalWorkspace(workspace: string) {
  const root = realpathSync.native(resolve(workspace));
  if (!statSync(root).isDirectory()) {
    throw new Error(`sidecar workspace is not a directory: ${workspace}`);
  }
  return root;
}

async function repositoryBinding(
  workspace: string,
  signal?: AbortSignal,
): Promise<RepositoryBinding> {
  signal?.throwIfAborted();
  const root = canonicalWorkspace(workspace);
  const identity = await repositoryGrantIdentity(root, { signal });
  signal?.throwIfAborted();
  return {
    workspace: root,
    repositoryId: identity.repositoryId,
  };
}

function sameCanonicalPath(left: string, right: string) {
  try {
    return canonicalPath(left) === canonicalPath(right);
  } catch {
    return false;
  }
}

function stateMatchesRepository(
  state: SidecarState,
  binding: RepositoryBinding,
) {
  return (
    state.repositoryId === binding.repositoryId &&
    sameCanonicalPath(state.workspace, binding.workspace)
  );
}

function assertExistingMetadataPath(
  path: string,
  container: string,
  kind: 'directory' | 'file',
) {
  if (!existsSync(path)) return;
  const link = lstatSync(path);
  if (link.isSymbolicLink()) {
    throw new Error(`sidecar metadata ${kind} cannot be a symlink or junction: ${path}`);
  }
  const target = canonicalPath(path);
  const root = canonicalPath(container);
  if (
    target !== root &&
    !target.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new Error(`sidecar metadata escapes the repository: ${path}`);
  }
  const stats = statSync(path);
  if (
    (kind === 'directory' && !stats.isDirectory()) ||
    (kind === 'file' && !stats.isFile())
  ) {
    throw new Error(`sidecar metadata ${kind} has an invalid type: ${path}`);
  }
}

function protectedSidecarPaths(workspace: string, create: boolean) {
  const root = canonicalWorkspace(workspace);
  const metadataDirectory = join(root, '.lattice');
  if (create) mkdirSync(metadataDirectory, { recursive: true });
  assertExistingMetadataPath(metadataDirectory, root, 'directory');

  const paths = sidecarPaths(root);
  if (create) mkdirSync(paths.directory, { recursive: true });
  assertExistingMetadataPath(paths.directory, metadataDirectory, 'directory');
  for (const path of [paths.state, paths.lock, paths.log, paths.telemetry]) {
    assertExistingMetadataPath(path, paths.directory, 'file');
  }
  return paths;
}

function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function visibleState(state: SidecarState) {
  const { token: _token, ...visible } = state;
  return visible;
}

async function removeOwnedState(paths: SidecarPaths, pid = process.pid) {
  try {
    const state = readSidecarState(paths.state);
    if (state && state.pid !== pid) return;
  } catch {
    // Invalid state is stale and safe to remove with the matching lock.
  }
  const ownedTemporaryFiles = existsSync(paths.directory)
    ? readdirSync(paths.directory)
        .filter(
          (name) => name.includes(`.${pid}.`) && name.endsWith('.tmp'),
        )
        .map((name) => join(paths.directory, name))
    : [];
  for (const path of [paths.state, paths.lock, ...ownedTemporaryFiles]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await removeFile(path, { force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          attempt >= 8 ||
          !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '')
        ) {
          throw error;
        }
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, 40 * (attempt + 1)),
        );
      }
    }
  }
}

export function readSidecarState(path: string): SidecarState | null {
  if (!existsSync(path)) return null;
  try {
    return SidecarStateSchema.parse(readJson<unknown>(path));
  } catch {
    return null;
  }
}

function shouldIgnoreWatchPath(path: string) {
  const normalized = path.replaceAll('\\', '/');
  return normalized
    .split('/')
    .some((part) =>
      ['.git', '.lattice', 'node_modules', 'dist', 'build', 'coverage'].includes(part),
    );
}

function invalidatePersistedGrants(
  workspace: string,
  changedPaths: readonly string[],
) {
  const changed = new Set(changedPaths.map((path) => path.replaceAll('\\', '/')));
  const invalidateAll = changed.has('*');
  const editGrantDirectory = join(workspace, '.lattice', 'edit-grants');
  const errors: string[] = [];
  if (existsSync(editGrantDirectory)) {
    assertExistingMetadataPath(
      editGrantDirectory,
      join(workspace, '.lattice'),
      'directory',
    );
    for (const name of readdirSync(editGrantDirectory).filter((entry) =>
      entry.endsWith('.json'),
    )) {
      const path = join(editGrantDirectory, name);
      try {
        safeReadPath(workspace, relative(workspace, path));
        const taskId = name.slice(0, -'.json'.length);
        const value = loadEditGrantRegistry(workspace, taskId);
        if (value.taskId !== taskId) {
          throw new Error('edit grant registry task does not match its filename');
        }
        let dirty = false;
        for (const grant of value.grants) {
          if (
            grant.path &&
            (invalidateAll || changed.has(grant.path.replaceAll('\\', '/')))
          ) {
            grant.invalidated = true;
            dirty = true;
          }
        }
        if (dirty) {
          value.mappingSha256 = editGrantMappingDigest(value);
          atomicJson(path, value);
        }
      } catch (error) {
        errors.push(
          `edit grant invalidation skipped for ${name}: ${boundedError(error)}`,
        );
      }
    }
  }
  // Context snapshots are immutable evidence. Authoritative edit grants are
  // invalidated above; consumers re-check current source fingerprints.
  return errors;
}

function response(
  state: SidecarState,
  ok: boolean,
  data?: unknown,
  error?: string,
): SidecarResponse {
  return SidecarResponseSchema.parse({
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    repositoryId: state.repositoryId,
    ok,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
  });
}

function sendJson(reply: ServerResponse, status: number, value: unknown) {
  const content = Buffer.from(JSON.stringify(value), 'utf8');
  reply.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': content.length,
    'cache-control': 'no-store',
  });
  reply.end(content);
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_REQUEST_BYTES) throw new Error('sidecar request is too large');
    chunks.push(bytes);
  }
  if (length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function resolveHint(index: RepositoryIndex, hint: string) {
  const normalized = hint.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const extension = extname(normalized);
  const base = extension ? normalized.slice(0, -extension.length) : normalized;
  const candidates = [
    normalized,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return candidates
    .map((path) => index.files.find((file) => file.path === path))
    .find(Boolean);
}

async function contextPages(
  workspace: string,
  index: RepositoryIndex,
  request: z.infer<typeof SidecarContextRequestSchema>,
) {
  const selected = new Map<string, string>();
  if (request.pathHint) {
    const file = resolveHint(index, request.pathHint);
    if (file) selected.set(file.path, `path hint: ${request.pathHint}`);
  }
  if (request.symbol) {
    for (const file of index.files.filter((candidate) =>
      candidate.symbols.includes(request.symbol!),
    )) {
      selected.set(file.path, `symbol: ${request.symbol}`);
    }
  }
  if (request.query) {
    for (const result of searchIndex(index, request.query, request.maxPages * 2)) {
      selected.set(result.path, `search: ${request.query}`);
    }
  }

  const pages: {
    path: string;
    fingerprint: string;
    content: string;
    reason: string;
  }[] = [];
  let bytesUsed = 0;
  for (const [path, reason] of selected) {
    if (pages.length >= request.maxPages) break;
    const full = safeReadPath(workspace, path);
    const bytes = readFileSync(full);
    if (bytes.includes(0) || bytesUsed + bytes.length > request.maxBytes) continue;
    const sourceFingerprint = await fingerprint(workspace, path);
    if (
      sourceFingerprint.rawSha256 !== rawHash(bytes) ||
      sourceFingerprint.byteLength !== bytes.length
    ) {
      throw new Error(`repository source changed while granting context: ${path}`);
    }
    // Reject a symlink/junction swap between reading the bytes and computing
    // the fingerprint rather than serving content with the wrong identity.
    safeReadPath(workspace, path);
    pages.push({
      path,
      fingerprint: sourceFingerprint.value,
      content: bytes.toString('utf8'),
      reason,
    });
    bytesUsed += bytes.length;
  }
  return { pages, bytesUsed };
}

function createWatcher(
  workspace: string,
  onPaths: (paths: string[]) => void,
): FSWatcher | null {
  try {
    return watch(
      workspace,
      { recursive: process.platform === 'win32' || process.platform === 'darwin' },
      (_event, filename) => {
        const path = filename?.toString().replaceAll('\\', '/');
        if (!path) {
          onPaths(['*']);
          return;
        }
        if (shouldIgnoreWatchPath(path)) return;
        onPaths([path]);
      },
    );
  } catch {
    return null;
  }
}

export async function startSidecarServer(
  workspace: string,
  options: {
    idleShutdownMs?: number;
    leaseTtlMs?: number;
    foreground?: boolean;
  } = {},
): Promise<SidecarServer> {
  const binding = await repositoryBinding(workspace);
  const root = binding.workspace;
  const paths = protectedSidecarPaths(root, true);
  let lockDescriptor: number;
  try {
    lockDescriptor = openSync(paths.lock, 'wx', 0o600);
    writeFileSync(
      lockDescriptor,
      JSON.stringify({ schemaVersion: 1, pid: process.pid, at: new Date().toISOString() }),
    );
  } catch (error) {
    throw new Error(`sidecar lock is already held: ${boundedError(error)}`);
  }

  const started = Date.now();
  const token = randomBytes(32).toString('hex');
  const leases = new Map<
    string,
    { expiresAt: number; clientKind: 'launcher' | 'mcp' | 'diagnostic' }
  >();
  const activeContextGrants = new Map<
    string,
    { path: string; fingerprint: string }
  >();
  let index: RepositoryIndex | null = null;
  let watcher: FSWatcher | null = null;
  let invalidationTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let reaper: NodeJS.Timeout | undefined;
  let closing = false;
  const assistedMcpLeases = new Set<string>();
  const pendingChangedPaths = new Set<string>();
  const idleShutdownMs =
    options.idleShutdownMs ??
    Number(process.env.LATTICE_SIDECAR_IDLE_MS || DEFAULT_IDLE_SHUTDOWN_MS);
  const leaseTtlMs =
    options.leaseTtlMs ??
    Number(process.env.LATTICE_SIDECAR_LEASE_TTL_MS || DEFAULT_LEASE_TTL_MS);

  let currentState: SidecarState = {
    schemaVersion: 1,
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    repositoryId: binding.repositoryId,
    workspace: root,
    pid: process.pid,
    port: 1,
    token,
    status: 'warming',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    indexedFiles: 0,
    activeLeases: 0,
    bridgeClients: 0,
    activeContextGrantCount: 0,
    mode: 'passive-index-only',
    lastInvalidatedPaths: [],
    telemetry: {
      startupMs: 0,
      attachCount: 0,
      lastAttachMs: null,
      initialIndexMs: null,
      incrementalInvalidationMs: null,
      nativeCodexProcessLifetimeMs: null,
      bridgeRequestCount: 0,
      bridgeInitializeCount: 0,
      contextBytesSupplied: 0,
      contextEstimatedTokensSupplied: 0,
      contextGrantCount: 0,
      activeContextGrantCount: 0,
      errors: [],
    },
  };

  const persist = () => {
    currentState.updatedAt = new Date().toISOString();
    currentState.activeLeases = leases.size;
    currentState.bridgeClients = [...leases.values()].filter(
      (lease) => lease.clientKind === 'mcp',
    ).length;
    currentState.activeContextGrantCount = activeContextGrants.size;
    currentState.telemetry.activeContextGrantCount =
      activeContextGrants.size;
    for (const leaseId of assistedMcpLeases) {
      if (leases.get(leaseId)?.clientKind !== 'mcp') {
        assistedMcpLeases.delete(leaseId);
      }
    }
    currentState.mode =
      assistedMcpLeases.size > 0
        ? 'mcp-assisted-context'
        : 'passive-index-only';
    atomicJson(paths.state, currentState);
    atomicJson(paths.telemetry, {
      schemaVersion: 1,
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      repositoryId: currentState.repositoryId,
      workspace: currentState.workspace,
      pid: currentState.pid,
      status: currentState.status,
      updatedAt: currentState.updatedAt,
      indexedFiles: currentState.indexedFiles,
      mode: currentState.mode,
      telemetry: currentState.telemetry,
    });
  };
  const recordError = (error: unknown) => {
    if (closing) return;
    currentState.status = index ? 'ready' : 'degraded';
    currentState.telemetry.errors.push(boundedError(error));
    currentState.telemetry.errors = currentState.telemetry.errors.slice(-20);
    try {
      persist();
    } catch {
      // Persistence is part of sidecar ownership. If it becomes unavailable,
      // close the IPC service instead of running without recoverable state.
      setImmediate(() => void close().catch(() => undefined));
    }
  };
  const cancelIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  let settleClosed!: () => void;
  const closed = new Promise<void>((resolveClosed) => {
    settleClosed = resolveClosed;
  });

  const server = createServer(async (request, reply) => {
    const requestStarted = performance.now();
    const suppliedAuthorization = request.headers.authorization ?? '';
    const expectedAuthorization = `Bearer ${token}`;
    const suppliedBytes = Buffer.from(suppliedAuthorization, 'utf8');
    const expectedBytes = Buffer.from(expectedAuthorization, 'utf8');
    const authorized =
      suppliedBytes.length === expectedBytes.length &&
      timingSafeEqual(suppliedBytes, expectedBytes);
    if (!authorized) {
      sendJson(reply, 401, response(currentState, false, undefined, 'unauthorized'));
      return;
    }
    try {
      if (request.method === 'GET' && request.url === '/v1/status') {
        sendJson(reply, 200, response(currentState, true, visibleState(currentState)));
        return;
      }
      if (request.method !== 'POST') {
        sendJson(reply, 404, response(currentState, false, undefined, 'not found'));
        return;
      }
      const body = await readBody(request);
      if (request.url === '/v1/attach') {
        const value = SidecarAttachRequestSchema.parse(body);
        if (value.repositoryId !== currentState.repositoryId) {
          throw new Error('repository identity mismatch');
        }
        const leaseId = randomUUID();
        leases.set(leaseId, {
          expiresAt: Date.now() + leaseTtlMs,
          clientKind: value.clientKind,
        });
        cancelIdle();
        currentState.telemetry.attachCount += 1;
        if (value.clientKind === 'mcp') {
          currentState.telemetry.bridgeInitializeCount += 1;
        }
        currentState.telemetry.lastAttachMs =
          performance.now() - requestStarted;
        persist();
        sendJson(reply, 200, response(currentState, true, { leaseId, leaseTtlMs }));
        return;
      }
      if (request.url === '/v1/heartbeat') {
        const value = HeartbeatRequestSchema.parse(body);
        if (
          value.repositoryId !== currentState.repositoryId ||
          !leases.has(value.leaseId)
        ) {
          throw new Error('unknown sidecar lease');
        }
        const lease = leases.get(value.leaseId)!;
        leases.set(value.leaseId, {
          ...lease,
          expiresAt: Date.now() + leaseTtlMs,
        });
        sendJson(reply, 200, response(currentState, true, { leaseId: value.leaseId }));
        return;
      }
      if (request.url === '/v1/detach') {
        const value = SidecarDetachRequestSchema.parse(body);
        if (value.repositoryId !== currentState.repositoryId) {
          throw new Error('repository identity mismatch');
        }
        leases.delete(value.leaseId);
        assistedMcpLeases.delete(value.leaseId);
        if (value.nativeProcessLifetimeMs !== undefined) {
          currentState.telemetry.nativeCodexProcessLifetimeMs =
            value.nativeProcessLifetimeMs;
        }
        persist();
        scheduleIdle();
        sendJson(reply, 200, response(currentState, true, { detached: value.leaseId }));
        return;
      }
      if (request.url === '/v1/context') {
        const value = SidecarContextRequestSchema.parse(body);
        if (value.repositoryId !== currentState.repositoryId) {
          throw new Error('repository identity mismatch');
        }
        const requestingLease = value.leaseId
          ? leases.get(value.leaseId)
          : undefined;
        if (value.leaseId && !requestingLease) {
          throw new Error('unknown sidecar lease');
        }
        if (!index) throw new Error('Terra index is still warming');
        const loaded = await contextPages(root, index, value);
        currentState.telemetry.bridgeRequestCount += 1;
        currentState.telemetry.contextBytesSupplied += loaded.bytesUsed;
        currentState.telemetry.contextEstimatedTokensSupplied += Math.ceil(
          loaded.bytesUsed / 4,
        );
        currentState.telemetry.contextGrantCount += loaded.pages.length;
        for (const page of loaded.pages) {
          activeContextGrants.set(`${page.path}\0${page.fingerprint}`, {
            path: page.path,
            fingerprint: page.fingerprint,
          });
        }
        if (
          loaded.pages.length > 0 &&
          requestingLease?.clientKind === 'mcp' &&
          value.leaseId
        ) {
          assistedMcpLeases.add(value.leaseId);
        }
        persist();
        sendJson(reply, 200, response(currentState, true, loaded));
        return;
      }
      if (request.url === '/v1/shutdown') {
        const value = ShutdownRequestSchema.parse(body);
        if (value.repositoryId !== currentState.repositoryId) {
          throw new Error('repository identity mismatch');
        }
        sendJson(reply, 200, response(currentState, true, { stopping: true }));
        setImmediate(() => void close());
        return;
      }
      sendJson(reply, 404, response(currentState, false, undefined, 'not found'));
    } catch (error) {
      sendJson(reply, 400, response(currentState, false, undefined, boundedError(error)));
    }
  });

  const scheduleIdle = (delayMs = idleShutdownMs) => {
    if (closing || leases.size > 0 || !Number.isFinite(idleShutdownMs)) return;
    if (idleTimer) return;
    idleTimer = setTimeout(() => void close(), Math.max(0, delayMs));
    idleTimer.unref();
  };

  const reindex = async (changedPaths: string[]) => {
    if (closing) return;
    const invalidatedAt = Date.now();
    try {
      const changed = new Set(
        changedPaths.map((path) => path.replaceAll('\\', '/')),
      );
      if (changed.has('*')) {
        activeContextGrants.clear();
      } else {
        for (const [key, grant] of activeContextGrants) {
          if (changed.has(grant.path.replaceAll('\\', '/'))) {
            activeContextGrants.delete(key);
          }
        }
      }
      if (activeContextGrants.size === 0) {
        assistedMcpLeases.clear();
      }
      const invalidationErrors = invalidatePersistedGrants(root, changedPaths);
      index = await buildIndex(root);
      if (closing) return;
      currentState.status = 'ready';
      currentState.indexedFiles = index.files.length;
      currentState.lastInvalidatedPaths = [...changedPaths].sort();
      currentState.telemetry.incrementalInvalidationMs = Date.now() - invalidatedAt;
      currentState.telemetry.errors.push(...invalidationErrors);
      currentState.telemetry.errors =
        currentState.telemetry.errors.slice(-20);
      persist();
    } catch (error) {
      recordError(error);
    }
  };

  const queueInvalidation = (paths: string[]) => {
    if (closing) return;
    for (const path of paths) pendingChangedPaths.add(path);
    if (invalidationTimer) clearTimeout(invalidationTimer);
    invalidationTimer = setTimeout(() => {
      const changedPaths = [...pendingChangedPaths];
      pendingChangedPaths.clear();
      void reindex(changedPaths);
    }, 200);
    invalidationTimer.unref();
  };

  const close = async () => {
    if (closing) return closed;
    closing = true;
    const closeErrors: unknown[] = [];
    currentState.status = 'stopping';
    try {
      persist();
    } catch (error) {
      closeErrors.push(error);
    }
    cancelIdle();
    if (invalidationTimer) clearTimeout(invalidationTimer);
    if (reaper) clearInterval(reaper);
    try {
      watcher?.close();
    } catch (error) {
      closeErrors.push(error);
    }
    watcher = null;
    try {
      await new Promise<void>((resolveClose, rejectClose) => {
        try {
          server.close((error) => {
            if (
              error &&
              (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
            ) {
              rejectClose(error);
            } else {
              resolveClose();
            }
          });
          server.closeAllConnections();
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
          ) {
            resolveClose();
          } else {
            rejectClose(error);
          }
        }
      });
    } catch (error) {
      closeErrors.push(error);
    }
    try {
      await removeOwnedState(paths);
    } catch (error) {
      closeErrors.push(error);
    } finally {
      try {
        closeSync(lockDescriptor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EBADF') {
          closeErrors.push(error);
        }
      }
      settleClosed();
    }
    if (closeErrors.length === 1) throw closeErrors[0];
    if (closeErrors.length > 1) {
      throw new AggregateError(closeErrors, 'sidecar shutdown cleanup failed');
    }
  };

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('invalid sidecar address');
    currentState.port = address.port;
    currentState.telemetry.startupMs = Date.now() - started;
    persist();

    reaper = setInterval(() => {
      const now = Date.now();
      for (const [lease, value] of leases) {
        if (value.expiresAt <= now) {
          leases.delete(lease);
          assistedMcpLeases.delete(lease);
        }
      }
      try {
        persist();
      } catch (error) {
        recordError(error);
      }
      if (leases.size === 0) scheduleIdle();
    }, Math.min(1_000, Math.max(100, Math.floor(leaseTtlMs / 3))));
    reaper.unref();
    // Publishing the state file makes the newborn sidecar discoverable before
    // a client owns a lease. On slower hosts, an aggressively small test/dev
    // idle window can otherwise expire between the health check and the first
    // authenticated attach. Preserve the configured post-detach idle behavior,
    // but give the initial owner a small, bounded attach grace period.
    scheduleIdle(Math.max(idleShutdownMs, MIN_STARTUP_LEASE_GRACE_MS));

    const initialIndexStarted = Date.now();
    void buildIndex(root)
      .then((value) => {
        if (closing) return;
        index = value;
        currentState.status = 'ready';
        currentState.indexedFiles = value.files.length;
        currentState.telemetry.initialIndexMs = Date.now() - initialIndexStarted;
        persist();
        watcher = createWatcher(root, queueInvalidation);
        if (!watcher) {
          currentState.telemetry.errors.push(
            'recursive file watching is unavailable on this platform',
          );
          persist();
        }
      })
      .catch(recordError);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'sidecar startup failed and cleanup was incomplete',
      );
    }
    throw error;
  }

  return {
    state: () => structuredClone(currentState),
    closed,
    close,
  };
}

async function clientRequest(
  state: SidecarState,
  endpoint: string,
  body?: unknown,
  timeoutMs = 2_000,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const request: RequestInit =
    body === undefined
      ? {
          method: 'GET',
          headers: { authorization: `Bearer ${state.token}` },
          signal: requestSignal,
        }
      : {
          method: 'POST',
          headers: {
            authorization: `Bearer ${state.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        };
  const result = await fetch(`http://127.0.0.1:${state.port}${endpoint}`, request);
  const parsed = SidecarResponseSchema.parse(await result.json());
  if (parsed.repositoryId !== state.repositoryId) {
    throw new Error('sidecar response repository identity mismatch');
  }
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.data;
}

export async function pingSidecar(
  state: SidecarState,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!isProcessAlive(state.pid)) return false;
  try {
    await clientRequest(state, '/v1/status', undefined, 750, signal);
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function defaultCliPath() {
  const besideModule = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (existsSync(besideModule)) return besideModule;
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
}

async function waitForSidecar(
  paths: SidecarPaths,
  timeoutMs: number,
  binding: RepositoryBinding,
  signal?: AbortSignal,
  child?: ChildProcess,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const state = readSidecarState(paths.state);
    if (state && !stateMatchesRepository(state, binding)) {
      throw new Error('sidecar state repository binding mismatch');
    }
    if (state && (await pingSidecar(state, signal))) return state;
    if (child && child.exitCode !== null) {
      throw new Error(`sidecar exited during startup with code ${String(child.exitCode)}`);
    }
    if (Date.now() >= deadline) throw new Error('sidecar startup timed out');
    await delay(40, undefined, signal ? { signal } : undefined);
  }
}

function lockOwnerIsAlive(path: string) {
  if (!existsSync(path)) return false;
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as {
      pid?: unknown;
    };
    return (
      typeof lock.pid === 'number' &&
      lock.pid > 0 &&
      isProcessAlive(lock.pid)
    );
  } catch {
    return false;
  }
}

async function clearStaleState(
  paths: SidecarPaths,
  signal?: AbortSignal,
) {
  // A PID from an unauthenticated stale file can have been reused by an
  // unrelated process. Only an authenticated shutdown path may terminate it.
  for (const path of [paths.state, paths.lock]) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      signal?.throwIfAborted();
      try {
        rmSync(path, { force: true });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await delay(
          40 * (attempt + 1),
          undefined,
          signal ? { signal } : undefined,
        );
      }
    }
    if (lastError) throw lastError;
  }
}

export async function attachSidecar(
  state: SidecarState,
  options: {
    heartbeat?: boolean;
    clientKind?: 'launcher' | 'mcp' | 'diagnostic';
    signal?: AbortSignal;
  } = {},
): Promise<SidecarLease> {
  const data = (await clientRequest(state, '/v1/attach', {
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    repositoryId: state.repositoryId,
    clientKind: options.clientKind ?? 'launcher',
  }, 2_000, options.signal)) as {
    leaseId?: unknown;
    leaseTtlMs?: unknown;
  };
  const leaseId = z.string().uuid().parse(data.leaseId);
  const leaseTtlMs = z.number().positive().parse(data.leaseTtlMs);
  let detached = false;
  const heartbeat =
    options.heartbeat === false
      ? undefined
      : setInterval(() => {
          void clientRequest(state, '/v1/heartbeat', {
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            repositoryId: state.repositoryId,
            leaseId,
          }).catch(() => undefined);
        }, Math.max(250, Math.floor(leaseTtlMs / 3)));
  heartbeat?.unref();
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
  };
  return {
    state,
    leaseId,
    stopHeartbeat,
    async detach(nativeProcessLifetimeMs?: number) {
      if (detached) return;
      detached = true;
      stopHeartbeat();
      await clientRequest(state, '/v1/detach', {
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        repositoryId: state.repositoryId,
        leaseId,
        ...(nativeProcessLifetimeMs === undefined
          ? {}
          : { nativeProcessLifetimeMs }),
      }).catch(() => undefined);
    },
  };
}

export async function ensureSidecar(
  workspace: string,
  options: {
    startupTimeoutMs?: number;
    cliPath?: string;
    env?: NodeJS.ProcessEnv;
    heartbeat?: boolean;
    clientKind?: 'launcher' | 'mcp' | 'diagnostic';
    signal?: AbortSignal;
  } = {},
): Promise<SidecarLease> {
  const binding = await repositoryBinding(workspace, options.signal);
  const root = binding.workspace;
  const paths = protectedSidecarPaths(root, true);
  const startupTimeoutMs = options.startupTimeoutMs ?? 4_000;
  let existing = readSidecarState(paths.state);
  if (existing && !stateMatchesRepository(existing, binding)) {
    // The local files can have been copied from another repository. Remove
    // only those local artifacts; never signal the foreign PID they mention.
    await clearStaleState(paths, options.signal);
    existing = null;
  }
  if (existing && (await pingSidecar(existing, options.signal))) {
    return attachSidecar(existing, {
      heartbeat: options.heartbeat,
      clientKind: options.clientKind,
      signal: options.signal,
    });
  }
  if (existsSync(paths.lock)) {
    if (lockOwnerIsAlive(paths.lock)) {
      try {
        const state = await waitForSidecar(
          paths,
          startupTimeoutMs,
          binding,
          options.signal,
        );
        return await attachSidecar(state, {
          heartbeat: options.heartbeat,
          clientKind: options.clientKind,
          signal: options.signal,
        });
      } catch (error) {
        options.signal?.throwIfAborted();
        throw new Error(
          `sidecar bootstrap owner is alive but did not become healthy: ${boundedError(error)}`,
        );
      }
    }
  }
  if (existsSync(paths.state) || existsSync(paths.lock)) {
    await clearStaleState(paths, options.signal);
  }
  options.signal?.throwIfAborted();

  const logDescriptor = openSync(paths.log, 'a');
  const child = spawn(
    process.execPath,
    [options.cliPath ?? defaultCliPath(), 'sidecar', 'serve', '--workspace', root],
    {
      cwd: root,
      env: { ...process.env, ...options.env },
      // The sidecar is an intentional managed service. It must survive the
      // short-lived launcher process, while leases/heartbeats and idle
      // shutdown still give it a deterministic owner and bounded lifetime.
      detached: true,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', logDescriptor, logDescriptor],
    },
  );
  closeSync(logDescriptor);
  if (!child.pid) throw new Error('sidecar process did not start');
  child.unref();
  try {
    const state = await waitForSidecar(
      paths,
      startupTimeoutMs,
      binding,
      options.signal,
      child,
    );
    return await attachSidecar(state, {
      heartbeat: options.heartbeat,
      clientKind: options.clientKind,
      signal: options.signal,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    // Two launchers can observe an empty repository state and spawn at the
    // same time. The child that loses the exclusive lock exits, so attach its
    // parent to the healthy winner instead of degrading that native session.
    if (existsSync(paths.lock) && lockOwnerIsAlive(paths.lock)) {
      try {
        const state = await waitForSidecar(
          paths,
          startupTimeoutMs,
          binding,
          options.signal,
        );
        return await attachSidecar(state, {
          heartbeat: options.heartbeat,
          clientKind: options.clientKind,
          signal: options.signal,
        });
      } catch {
        options.signal?.throwIfAborted();
      }
    }
    // Launcher cancellation is expected when a short native command exits.
    // The detached service owns its bounded idle shutdown; waiting on taskkill
    // here would make `codex --version` wait for optional infrastructure.
    if (!options.signal?.aborted && isProcessAlive(child.pid)) {
      await terminateProcessTree(child.pid);
    }
    throw error;
  }
}

export async function sidecarStatus(workspace: string) {
  const binding = await repositoryBinding(workspace);
  const paths = protectedSidecarPaths(binding.workspace, false);
  const state = readSidecarState(paths.state);
  const lastTelemetry = (() => {
    if (!existsSync(paths.telemetry)) return null;
    try {
      const value = SidecarTelemetryArtifactSchema.safeParse(
        readJson<unknown>(paths.telemetry),
      );
      return value.success &&
        value.data.repositoryId === binding.repositoryId &&
        sameCanonicalPath(value.data.workspace, binding.workspace)
        ? value.data
        : null;
    } catch {
      return null;
    }
  })();
  if (!state || !stateMatchesRepository(state, binding)) {
    return { running: false as const, state: null, lastTelemetry };
  }
  const running = await pingSidecar(state);
  return {
    running,
    state: visibleState(state),
    lastTelemetry,
  };
}

export async function stopSidecar(workspace: string, timeoutMs = 3_000) {
  const binding = await repositoryBinding(workspace);
  const paths = protectedSidecarPaths(binding.workspace, false);
  const state = readSidecarState(paths.state);
  if (!state || !stateMatchesRepository(state, binding)) {
    if (!lockOwnerIsAlive(paths.lock)) {
      await clearStaleState(paths).catch(() => undefined);
    }
    return false;
  }
  if (!isProcessAlive(state.pid)) {
    await clearStaleState(paths);
    return false;
  }
  try {
    await clientRequest(state, '/v1/shutdown', {
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      repositoryId: state.repositoryId,
    });
  } catch {
    // A persisted PID and token are untrusted until the authenticated endpoint
    // responds. Never terminate a process based only on local metadata.
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(state.pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  if (isProcessAlive(state.pid)) {
    if (!(await pingSidecar(state))) return false;
    await terminateProcessTree(state.pid);
  }
  await clearStaleState(paths);
  return true;
}

export async function sidecarContext(
  state: SidecarState,
  request: Omit<z.input<typeof SidecarContextRequestSchema>, 'protocolVersion' | 'repositoryId'>,
) {
  return clientRequest(state, '/v1/context', {
    protocolVersion: SIDECAR_PROTOCOL_VERSION,
    repositoryId: state.repositoryId,
    ...request,
  });
}

export function repositoryRelativePath(workspace: string, path: string) {
  return posix.normalize(relative(workspace, path).replaceAll('\\', '/'));
}
