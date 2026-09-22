import { dirname, join } from 'node:path';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execa } from 'execa';
import { removeDirectoryWithRetry } from './cleanup.js';
import { repositoryGrantIdentity } from './edit-grants.js';
import { fingerprint } from './fingerprint.js';
import {
  isProcessAlive,
  ManagedProcessError,
  runManagedProcess,
  type ManagedProcessResult,
} from './managed-process.js';
import { metadata, safePath, uid } from './core.js';
import type {
  ChangeOperation,
  Fingerprint,
  InternalPatchIR,
  Telemetry,
} from './types.js';

export type VerificationResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type TransactionResult = {
  status: 'passed' | 'failed';
  worktree: string;
  changedFiles: string[];
  diff: string;
  verification: VerificationResult[];
  fingerprints: { path: string; before?: Fingerprint; after?: Fingerprint }[];
};

export function assertMatchingWorktreeFingerprint(
  path: string,
  expected: string,
  source: Fingerprint,
  worktree: Fingerprint,
) {
  if (worktree.value === expected) return;
  throw new Error(
    [
      `worktree fingerprint mismatch: ${path}`,
      `sourceIdentity=${expected}`,
      `worktreeIdentity=${worktree.value}`,
      `sourceRawSha256=${source.rawSha256}`,
      `worktreeRawSha256=${worktree.rawSha256}`,
      `sourceBytes=${source.byteLength}`,
      `worktreeBytes=${worktree.byteLength}`,
    ].join('; '),
  );
}

const MAX_STORED_OUTPUT_CHARACTERS = 256 * 1024;

/** Keep the tail of verification output: runners print their summary last. */
function boundedOutput(output: string) {
  return output.length <= MAX_STORED_OUTPUT_CHARACTERS
    ? output
    : `[lattice] ${output.length - MAX_STORED_OUTPUT_CHARACTERS} earlier characters omitted\n${output.slice(-MAX_STORED_OUTPUT_CHARACTERS)}`;
}

function commandParts(command: string) {
  // The allowlist intentionally contains simple commands only. Shell interpretation is never used.
  return command.trim().split(/\s+/);
}

const isMetadataPath = (path: string) => path === '.lattice' || path.startsWith('.lattice/');

/**
 * Paths whose working-tree state differs from HEAD (modified, staged, deleted,
 * renamed or untracked, excluding ignored files and Lattice metadata).
 */
export async function dirtyWorkspacePaths(workspace: string) {
  const status = await execa(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { cwd: workspace },
  );
  const paths = new Set<string>();
  for (const entry of status.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const path = entry.slice(3).replaceAll('\\', '/');
    if (!isMetadataPath(path)) paths.add(path);
  }
  return [...paths].sort();
}

/**
 * Reproduce the user's uncommitted working-tree state inside the isolated
 * worktree and stage it, so the worktree index becomes the transaction base:
 * source fingerprints match, and `git diff` afterwards contains only the
 * transaction's own changes.
 */
async function mirrorDirtyState(workspace: string, directory: string, paths: string[]) {
  const staged: string[] = [];
  for (const path of paths) {
    const source = safePath(workspace, path);
    const target = safePath(directory, path);
    const sourceStat = lstatOrUndefined(source);
    const targetStat = lstatOrUndefined(target);
    // Nested repositories and submodules are separate Git trees: the parent
    // index records at most a pointer to them, so they are never mirrored.
    if (sourceStat?.isDirectory() || targetStat?.isDirectory()) continue;
    if (!sourceStat) {
      rmSync(target, { force: true });
      staged.push(path);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
    if (sourceStat.isSymbolicLink()) mirrorSymlink(source, target);
    else copyFileSync(source, target);
    staged.push(path);
  }
  if (staged.length === 0) return;
  // Pathspecs travel over stdin: thousands of dirty paths would otherwise
  // exceed the Windows command-line limit.
  await execa(
    'git',
    ['--literal-pathspecs', 'add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'],
    { cwd: directory, input: staged.join('\0') },
  );
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function mirrorSymlink(source: string, target: string) {
  const link = readlinkSync(source);
  try {
    symlinkSync(link, target);
  } catch (error) {
    // Without symlink privileges (Windows), Git's core.symlinks=false layout
    // stores the link text as a plain file and keeps the recorded link mode.
    if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    writeFileSync(target, link, 'utf8');
  }
}

const dependencyDirectory = 'node_modules';
const dependencySearchSkip = new Set(['.git', '.lattice', dependencyDirectory]);

/** Installed dependency directories of the workspace and its nested packages. */
function dependencyDirectories(workspace: string, relative = '', depth = 0): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(workspace, relative), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === dependencyDirectory) found.push(child);
    else if (depth < 3 && !dependencySearchSkip.has(entry.name)) {
      found.push(...dependencyDirectories(workspace, child, depth + 1));
    }
  }
  return found;
}

/**
 * Link installed dependencies into the fresh worktree so verification commands
 * such as `npm test` run against the same packages as the user's checkout.
 * Returns the created links; they must be removed before the worktree is.
 */
function linkDependencies(workspace: string, directory: string) {
  const links: string[] = [];
  for (const relative of dependencyDirectories(workspace)) {
    const target = join(directory, relative);
    if (!existsSync(dirname(target)) || existsSync(target)) continue;
    symlinkSync(
      join(workspace, relative),
      target,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    links.push(target);
  }
  return links;
}

function unlinkDependencies(links: string[]) {
  for (const link of links) {
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch {
        // The worktree removal below reports anything that is still present.
      }
    }
  }
}

/** Linked dependency directories left inside a worktree (never followed). */
function linkedDependencyDirectories(directory: string, relative = '', depth = 0): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(directory, relative), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === dependencyDirectory && entry.isSymbolicLink()) {
      found.push(join(directory, child));
    } else if (entry.isDirectory() && depth < 3 && !dependencySearchSkip.has(entry.name)) {
      found.push(...linkedDependencyDirectories(directory, child, depth + 1));
    }
  }
  return found;
}

type WorktreeOwner = { schemaVersion: 1; pid: number; createdAt: string; retained?: boolean };

const STALE_WORKTREE_MS = 24 * 60 * 60 * 1_000;
const ownerPath = (worktrees: string, id: string) => join(worktrees, `${id}.owner.json`);

function readOwner(path: string): WorktreeOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorktreeOwner;
    return value.schemaVersion === 1 && Number.isInteger(value.pid) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Remove isolated worktrees whose owning Lattice process crashed. Dependency
 * links are removed first so no recursive delete can reach the user's real
 * `node_modules` through a junction. Retained (debug) worktrees are kept.
 */
async function cleanupStaleWorktrees(workspace: string) {
  const worktrees = join(metadata(workspace), 'worktrees');
  let removed = false;
  for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const owner = readOwner(ownerPath(worktrees, entry.name));
    if (!owner || owner.retained) continue;
    const age = Date.now() - Date.parse(owner.createdAt);
    if (isProcessAlive(owner.pid) && age < STALE_WORKTREE_MS) continue;
    const directory = join(worktrees, entry.name);
    unlinkDependencies(linkedDependencyDirectories(directory));
    await execa('git', ['worktree', 'remove', '--force', directory], {
      cwd: workspace,
      reject: false,
    });
    await removeDirectoryWithRetry(directory);
    rmSync(ownerPath(worktrees, entry.name), { force: true });
    removed = true;
  }
  if (removed) await execa('git', ['worktree', 'prune'], { cwd: workspace, reject: false });
}

/**
 * Apply a verified transaction diff to the user's workspace. Every modified or
 * deleted source must still carry the fingerprint the patch was verified
 * against, and `git apply --check` must accept the whole diff before any file
 * is written.
 */
export async function applyVerifiedPatch(
  workspace: string,
  patch: InternalPatchIR,
  diff: string,
) {
  for (const change of patch.changes) {
    if (change.operation === 'create') {
      if (existsSync(safePath(workspace, change.path))) {
        throw new Error(`cannot apply: created path now exists: ${change.path}`);
      }
      continue;
    }
    const current = await fingerprint(workspace, change.path);
    if (current.value !== change.expectedFingerprint) {
      throw new Error(`cannot apply: source changed since verification: ${change.path}`);
    }
  }
  if (!diff.trim()) return;
  const patchFile = join(metadata(workspace), 'logs', `apply-${uid()}.patch`);
  writeFileSync(patchFile, diff.endsWith('\n') ? diff : `${diff}\n`, 'utf8');
  try {
    await execa('git', ['apply', '--check', '--binary', patchFile], { cwd: workspace });
    await execa('git', ['apply', '--binary', patchFile], { cwd: workspace });
  } finally {
    rmSync(patchFile, { force: true });
  }
}

export async function transact(
  workspace: string,
  patch: InternalPatchIR,
  allowlist: string[],
  metrics: Telemetry,
  retain = false,
  signal?: AbortSignal,
  verificationTimeoutMs = 120_000,
  onVerificationStart?: () => void,
): Promise<TransactionResult> {
  signal?.throwIfAborted();
  if (patch.schemaVersion !== 1) {
    throw new Error(`unsupported internal patch version: ${patch.schemaVersion}`);
  }
  const identity = await repositoryGrantIdentity(workspace);
  if (identity.repositoryId !== patch.repositoryId) {
    throw new Error('internal patch repository identity mismatch');
  }
  if (identity.baseCommit !== patch.baseCommit) {
    throw new Error(
      `internal patch base commit mismatch: expected=${patch.baseCommit}; actual=${identity.baseCommit}`,
    );
  }
  const { changes, verificationCommands: commands } = patch;
  for (const command of commands) {
    if (!allowlist.includes(command)) {
      throw new Error(`verification command not allowlisted: ${command}`);
    }
  }

  const sourceFingerprints = new Map<string, Fingerprint>();
  for (const change of changes) {
    safePath(workspace, change.path);
    if (change.operation !== 'create') {
      const current = await fingerprint(workspace, change.path);
      sourceFingerprints.set(change.path, current);
      if (current.value !== change.expectedFingerprint) {
        throw new Error(
          `stale source: ${change.path}; expected=${change.expectedFingerprint}; actual=${current.value}`,
        );
      }
    }
  }
  const dirtyPaths = await dirtyWorkspacePaths(workspace);
  signal?.throwIfAborted();
  await cleanupStaleWorktrees(workspace).catch(() => undefined);

  const id = uid();
  const worktrees = join(metadata(workspace), 'worktrees');
  const directory = join(worktrees, id);
  const owner: WorktreeOwner = {
    schemaVersion: 1,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(ownerPath(worktrees, id), JSON.stringify(owner), 'utf8');
  let worktreeAttempted = false;
  let dependencyLinks: string[] = [];
  try {
    worktreeAttempted = true;
    await execa(
      'git',
      [
        '-c',
        'core.autocrlf=false',
        'worktree',
        'add',
        '--detach',
        directory,
        patch.baseCommit,
      ],
      { cwd: workspace, cancelSignal: signal },
    );
    await mirrorDirtyState(workspace, directory, dirtyPaths);
    dependencyLinks = linkDependencies(workspace, directory);
    const fingerprints: TransactionResult['fingerprints'] = [];
    const semanticChanges: ChangeOperation[] = [];

    for (const change of changes) {
      signal?.throwIfAborted();
      const source = sourceFingerprints.get(change.path);
      const before =
        change.operation === 'create' ? undefined : await fingerprint(directory, change.path);
      if (change.operation !== 'create') {
        assertMatchingWorktreeFingerprint(
          change.path,
          change.expectedFingerprint!,
          source!,
          before!,
        );
      }

      const target = safePath(directory, change.path);
      if (change.operation === 'create') {
        if (existsSync(target)) throw new Error(`create target already exists: ${change.path}`);
        const ignored = await execa(
          'git',
          ['check-ignore', '-q', '--no-index', '--', change.path],
          { cwd: directory, reject: false },
        );
        if (ignored.exitCode === 0) {
          throw new Error(`create target is ignored by Git: ${change.path}`);
        }
      }
      if (change.operation === 'delete') {
        unlinkSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, change.replacementContent!, 'utf8');
      }
      const after =
        change.operation === 'delete' ? undefined : await fingerprint(directory, change.path);
      fingerprints.push({ path: change.path, before, after });
      if (
        change.operation === 'modify' &&
        before?.kind === 'git' &&
        after?.kind === 'git' &&
        before.value === after.value
      ) {
        await execa('git', ['checkout', '--', change.path], { cwd: directory });
      } else {
        semanticChanges.push(change);
      }
    }

    for (const change of semanticChanges) {
      if (change.operation === 'create') {
        await execa('git', ['--literal-pathspecs', 'add', '--intent-to-add', '--', change.path], {
          cwd: directory,
        });
      }
    }

    const verification: VerificationResult[] = [];
    onVerificationStart?.();
    const verificationStarted = Date.now();
    let passed = true;
    for (const command of commands) {
      signal?.throwIfAborted();
      const [executable, ...arguments_] = commandParts(command);
      let result: ManagedProcessResult;
      try {
        result = await runManagedProcess(executable, arguments_, {
          cwd: directory,
          reject: false,
          timeoutMs: verificationTimeoutMs,
          signal,
        });
      } catch (error) {
        // A hanging test run is a failed verification, not a runtime crash.
        if (!(error instanceof ManagedProcessError) || !error.result.timedOut) throw error;
        result = {
          ...error.result,
          exitCode: 124,
          stderr: `${error.result.stderr}\n[lattice] verification timed out after ${verificationTimeoutMs}ms`,
        };
      }
      verification.push({
        command,
        exitCode: result.exitCode ?? 1,
        stdout: boundedOutput(result.stdout),
        stderr: boundedOutput(result.stderr),
      });
      if (result.exitCode !== 0) {
        passed = false;
        break;
      }
    }
    metrics.verificationDurationMs = Date.now() - verificationStarted;
    const diff = (
      await execa('git', ['diff', '--no-ext-diff', '--binary'], { cwd: directory })
    ).stdout;
    return {
      status: passed ? 'passed' : 'failed',
      worktree: directory,
      changedFiles: semanticChanges.map((change) => change.path),
      diff,
      verification,
      fingerprints,
    };
  } finally {
    // Links are removed even from retained worktrees: a later recursive delete
    // of `.lattice/` must never be able to reach the user's node_modules.
    unlinkDependencies(dependencyLinks);
    if (retain) {
      writeFileSync(ownerPath(worktrees, id), JSON.stringify({ ...owner, retained: true }), 'utf8');
    } else {
      rmSync(ownerPath(worktrees, id), { force: true });
    }
    if (worktreeAttempted && !retain) {
      const removal = await execa('git', ['worktree', 'remove', '--force', directory], {
        cwd: workspace,
        reject: false,
      });
      await removeDirectoryWithRetry(directory);
      if (removal.exitCode !== 0) {
        const prune = await execa('git', ['worktree', 'prune'], {
          cwd: workspace,
          reject: false,
        });
        if (prune.exitCode !== 0) {
          throw new Error(
            `failed to clean isolated worktree: remove=${removal.stderr}; prune=${prune.stderr}`,
          );
        }
      }
    }
  }
}
