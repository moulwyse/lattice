import { lstatSync, readFileSync } from 'node:fs';
import { execa } from 'execa';
import { rawHash, safeReadPath } from './core.js';
import type { Fingerprint } from './types.js';

async function gitObjectId(
  root: string,
  path: string,
  autocrlf?: 'true' | 'false' | 'input',
) {
  const arguments_ = [
    ...(autocrlf ? ['-c', `core.autocrlf=${autocrlf}`] : []),
    'hash-object',
    `--path=${path}`,
    path,
  ];
  const result = await execa('git', arguments_, { cwd: root, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Tracked files use the Git index object when Git's own clean filters identify
 * the working bytes as the indexed content. The autocrlf probes cover a
 * cross-platform worktree checked out under a different host policy without
 * manually rewriting or hashing normalized strings.
 */
export async function fingerprint(root: string, path: string): Promise<Fingerprint> {
  const full = safeReadPath(root, path);
  const bytes = readFileSync(full);
  const raw = rawHash(bytes);
  if (lstatSync(full).isSymbolicLink()) {
    return {
      kind: 'raw',
      value: `sha256:${raw}`,
      rawSha256: raw,
      byteLength: bytes.length,
    };
  }
  const tracked = await execa('git', ['ls-files', '--stage', '--', path], {
    cwd: root,
    reject: false,
  });
  if (tracked.exitCode === 0 && tracked.stdout.trim()) {
    const indexObjectId = tracked.stdout.trim().split(/\s+/)[1];
    const candidates = await Promise.all([
      gitObjectId(root, path),
      gitObjectId(root, path, 'true'),
      gitObjectId(root, path, 'input'),
      gitObjectId(root, path, 'false'),
    ]);
    const currentObjectId = candidates[0];
    const contentIdentity = candidates.includes(indexObjectId)
      ? indexObjectId
      : currentObjectId;
    if (contentIdentity) {
      return {
        kind: 'git',
        value: `git:${contentIdentity}`,
        rawSha256: raw,
        byteLength: bytes.length,
      };
    }
  }
  return {
    kind: 'raw',
    value: `sha256:${raw}`,
    rawSha256: raw,
    byteLength: bytes.length,
  };
}

export async function sameFingerprint(root: string, path: string, expected: string) {
  return (await fingerprint(root, path)).value === expected;
}
