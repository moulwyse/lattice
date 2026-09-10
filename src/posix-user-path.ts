import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import type { UserPathStore } from './codex-integration.js';

const START = '# >>> Lattice Codex PATH >>>';
const END = '# <<< Lattice Codex PATH <<<';

/** Only our exact block is removed; unrelated shell configuration is preserved. */
export function posixUserPathStore(
  shimDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  profilePaths?: string[],
): UserPathStore & { files: string[] } {
  const home = env.HOME || homedir();
  const shell = basename(env.SHELL || '/bin/bash');
  const directory = resolve(shimDirectory);
  if (/[\r\n]/.test(directory) || directory.includes(delimiter)) {
    throw new Error('Lattice PATH directory cannot contain newlines or colons');
  }
  const literal = `'${directory.replaceAll("'", "'\\''")}'`;
  let files: string[];
  let command: string;
  if (shell === 'bash') {
    const login = ['.bash_profile', '.bash_login', '.profile']
      .map((name) => join(home, name)).find(existsSync) ?? join(home, '.profile');
    files = [join(home, '.bashrc'), login];
    command = `case "$PATH" in\n  ${literal}|${literal}:*) ;;\n  *) export PATH=${literal}:"$PATH" ;;\nesac`;
  } else if (shell === 'zsh') {
    const root = env.ZDOTDIR || home;
    files = [join(root, '.zshrc'), join(root, '.zprofile')];
    command = `case "$PATH" in\n  ${literal}|${literal}:*) ;;\n  *) export PATH=${literal}:"$PATH" ;;\nesac`;
  } else if (shell === 'fish') {
    files = [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'fish', 'conf.d', 'lattice-codex.fish')];
    const fishLiteral = `'${directory.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
    command = `if test "$PATH[1]" != ${fishLiteral}\n  set -gx PATH ${fishLiteral} $PATH\nend`;
  } else {
    throw new Error(`automatic Lattice PATH setup supports bash, zsh and fish; unsupported shell: ${shell}`);
  }
  files = profilePaths ?? files;
  const block = `\n${START}\n${command}\n${END}\n`;
  function inspect(path: string) {
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
    const remainder = (raw ?? '').replace(block, '');
    if (remainder.includes(START) || remainder.includes(END)) {
      throw new Error(`Lattice PATH block was modified; restore or remove it before retrying: ${path}`);
    }
    return { path, raw, remainder, installed: raw?.includes(block) === true };
  }
  return {
    files,
    async read() {
      return files.map(inspect).every((entry) => entry.installed) ? directory : null;
    },
    async write(value) {
      const enable = (value ?? '').split(delimiter).includes(directory);
      const entries = files.map(inspect);
      const changed: typeof entries = [];
      try {
        for (const entry of entries) {
          const next = enable ? entry.remainder + block : entry.remainder;
          if (next === (entry.raw ?? '')) continue;
          mkdirSync(dirname(entry.path), { recursive: true });
          changed.push(entry);
          // Writing in place preserves existing modes and symlink targets.
          writeFileSync(entry.path, next, { encoding: 'utf8', mode: 0o600 });
        }
      } catch (error) {
        const failures: unknown[] = [error];
        for (const entry of changed.reverse()) {
          try {
            if (entry.raw === null) rmSync(entry.path, { force: true });
            else writeFileSync(entry.path, entry.raw, 'utf8');
          } catch (rollbackError) { failures.push(rollbackError); }
        }
        throw new AggregateError(failures, 'Lattice shell PATH update failed');
      }
    },
  };
}
