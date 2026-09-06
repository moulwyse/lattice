import { lstatSync, readFileSync } from 'node:fs';
import { execa } from 'execa';
import { rawHash, safeReadPath } from './core.js';
import type { Fingerprint } from './types.js';

async function gitObjectId(
  root: string,
  path: string,
  bytes: Buffer,
  autocrlf?: 'true' | 'false' | 'input',
) {
  const arguments_ = [
    ...(autocrlf ? ['-c', `core.autocrlf=${autocrlf}`] : []),
    'hash-object',
    `--path=${path}`,
    '--stdin',
  ];
  // Every Git policy must hash the same bytes as rawSha256, even if the
  // working file changes while these asynchronous subprocesses run.
  const result = await execa('git', arguments_, { cwd: root, input: bytes, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Tracked files use the Git index object when Git's own clean filters identify
 * the working bytes as the indexed content. The autocrlf probes cover a
 * cross-platform worktree checked out under a different host policy without
 * manually rewriting or hashing normalized strings.
 */
export async function readFingerprintedFile(
  root: string,
  path: string,
): Promise<{ bytes: Buffer; fingerprint: Fingerprint }> {
  const full = safeReadPath(root, path);
  const bytes = readFileSync(full);
  const raw = rawHash(bytes);
  const rawFingerprint: Fingerprint = {
    kind: 'raw',
    value: `sha256:${raw}`,
    rawSha256: raw,
    byteLength: bytes.length,
  };
  if (lstatSync(full).isSymbolicLink()) {
    return { bytes, fingerprint: rawFingerprint };
  }
  const tracked = await execa('git', ['--literal-pathspecs', 'ls-files', '--stage', '-z', '--', path], {
    cwd: root,
    reject: false,
  });
  const entries = tracked.stdout.split('\0').filter(Boolean);
  const indexObjectId = tracked.exitCode === 0 && entries.length === 1
    ? entries[0].match(/^\d+ ([a-f0-9]+) 0\t/)?.[1]
    : undefined;
  if (indexObjectId) {
    const currentObjectId = await gitObjectId(root, path, bytes);
    // Clean files already match. Only probe alternate checkout policies when
    // needed; preserve Git's own filters and cross-platform CRLF semantics.
    const candidates: (string | null)[] = currentObjectId === indexObjectId ? [] : await Promise.all([
      gitObjectId(root, path, bytes, 'true'),
      gitObjectId(root, path, bytes, 'input'),
      gitObjectId(root, path, bytes, 'false'),
    ]);
    const contentIdentity = candidates.includes(indexObjectId) ? indexObjectId : currentObjectId;
    safeReadPath(root, path);
    if (contentIdentity) {
      return {
        bytes,
        fingerprint: {
          kind: 'git',
          value: `git:${contentIdentity}`,
          rawSha256: raw,
          byteLength: bytes.length,
        },
      };
    }
  }
  safeReadPath(root, path);
  return { bytes, fingerprint: rawFingerprint };
}

export async function fingerprint(root: string, path: string): Promise<Fingerprint> {
  return (await readFingerprintedFile(root, path)).fingerprint;
}

export async function sameFingerprint(root: string, path: string, expected: string) {
  return (await fingerprint(root, path)).value === expected;
}
