import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeJson } from './core.js';
import { userSettingsPath } from './user-settings.js';

/**
 * Repositories where Lattice ran, so `lattice` outside a repository can show
 * every project. Kept next to the user settings; only absolute paths are
 * stored. Best effort: the list never blocks a command.
 */
export function knownRepositoriesPath(env: NodeJS.ProcessEnv = process.env) {
  return join(dirname(userSettingsPath(env)), 'repositories.json');
}

export function readKnownRepositories(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const value = JSON.parse(readFileSync(knownRepositoriesPath(env), 'utf8')) as {
      repositories?: unknown;
    };
    return Array.isArray(value.repositories)
      ? value.repositories.filter((path): path is string => typeof path === 'string' && path !== '')
      : [];
  } catch {
    return [];
  }
}

const remembered = new Set<string>();

export function rememberRepository(root: string, env: NodeJS.ProcessEnv = process.env) {
  const path = resolve(root);
  const file = knownRepositoriesPath(env);
  if (remembered.has(`${file}\0${path}`)) return;
  remembered.add(`${file}\0${path}`);
  try {
    const known = readKnownRepositories(env);
    if (known.includes(path)) return;
    writeJson(file, { schemaVersion: 1, repositories: [...known, path] });
  } catch {
    // An unwritable profile only means this project is found from session logs.
  }
}

/** The nearest ancestor holding Lattice state, or null. */
function latticeRoot(start: string, cache: Map<string, string | null>) {
  const visited: string[] = [];
  let directory = resolve(start);
  let found: string | null = null;
  for (;;) {
    if (cache.has(directory)) {
      found = cache.get(directory) ?? null;
      break;
    }
    visited.push(directory);
    try {
      if (statSync(join(directory, '.lattice')).isDirectory()) {
        found = directory;
        break;
      }
    } catch {
      // Not here; keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const path of visited) cache.set(path, found);
  return found;
}

/**
 * Remembered repositories plus every directory an agent session ran in that
 * has Lattice state, deduplicated by real path. Missing repositories drop out.
 */
export function discoverRepositories(
  sessionDirectories: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
) {
  const cache = new Map<string, string | null>();
  const candidates = new Set<string>();
  for (const path of readKnownRepositories(env)) {
    if (existsSync(join(path, '.lattice'))) candidates.add(resolve(path));
  }
  for (const directory of sessionDirectories) {
    const root = latticeRoot(directory, cache);
    if (root) candidates.add(root);
  }
  const unique = new Map<string, string>();
  for (const path of candidates) {
    let real = path;
    try {
      real = realpathSync.native(path);
    } catch {
      continue;
    }
    // Worktrees Lattice creates under `.lattice/worktrees` are not projects.
    if (/[\\/]\.lattice[\\/]/.test(real)) continue;
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (!unique.has(key)) unique.set(key, real);
  }
  return [...unique.values()].sort();
}
