import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, parse, resolve } from 'node:path';
import { promisify } from 'node:util';

export type RepositoryDiscovery =
  | {
      safe: true;
      root: string;
      source: 'git' | 'lattice-config';
    }
  | {
      safe: false;
      root: null;
      source: 'none' | 'unsafe';
      reason: string;
    };

function canonical(path: string) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function unsafeAutomaticRoot(path: string) {
  const root = canonical(path);
  const home = canonical(homedir());
  const parsedRoot = canonical(parse(path).root);
  const homeParent = canonical(dirname(homedir()));
  const unixSharedHomes = new Set(['/home', '/users']);
  return (
    root === parsedRoot ||
    root === home ||
    root === homeParent ||
    unixSharedHomes.has(root.replaceAll('\\', '/'))
  );
}

// node:child_process instead of execa: discovery runs in every hook call,
// where loading execa alone costs more than the Git process itself.
const execGit = promisify(execFile);

async function gitRoot(start: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    const result = await execGit('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      timeout: 2_000,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const stdout = result.stdout.trim();
    if (!stdout) return null;
    const path = resolve(stdout);
    return existsSync(path) ? realpathSync(path) : null;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return null;
  }
}

/**
 * The Git top-level directory that contains `start`, or `start` itself outside
 * Git. Task state, worktrees and patch paths are repository-relative, so a
 * run started from a subdirectory must operate on the repository root.
 */
export async function repositoryRoot(start: string) {
  const workspace = resolve(start);
  const root = await gitRoot(workspace);
  if (!root) return workspace;
  try {
    if (realpathSync(workspace) === root) return workspace;
  } catch {
    // A missing start directory is reported by the caller's own access.
  }
  return root;
}

function explicitProjectRoot(start: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let current = existsSync(start) ? realpathSync(start) : resolve(start);
  for (;;) {
    signal?.throwIfAborted();
    if (existsSync(resolve(current, 'lattice.config.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function discoverRepository(
  start = process.cwd(),
  options: { forceUnsafe?: boolean; signal?: AbortSignal } = {},
): Promise<RepositoryDiscovery> {
  options.signal?.throwIfAborted();
  const discoveredGitRoot = await gitRoot(start, options.signal);
  const candidate =
    discoveredGitRoot ?? explicitProjectRoot(start, options.signal);
  if (!candidate) {
    return {
      safe: false,
      root: null,
      source: 'none',
      reason: 'no Git repository or lattice.config.json project marker found',
    };
  }
  if (!options.forceUnsafe && unsafeAutomaticRoot(candidate)) {
    return {
      safe: false,
      root: null,
      source: 'unsafe',
      reason: `automatic indexing refused for unsafe root: ${candidate}`,
    };
  }
  return {
    safe: true,
    root: candidate,
    source: discoveredGitRoot ? 'git' : 'lattice-config',
  };
}
