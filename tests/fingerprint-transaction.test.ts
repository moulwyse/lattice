import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryGrantIdentity } from '../src/edit-grants.js';
import { fingerprint } from '../src/fingerprint.js';
import { telemetry } from '../src/telemetry.js';
import {
  assertMatchingWorktreeFingerprint,
  transact,
} from '../src/transaction.js';
import { repository, type TestRepository } from './helpers.js';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import type { ChangeOperation, InternalPatchIR } from '../src/types.js';

const repositories: TestRepository[] = [];
const temporaryPaths: string[] = [];
afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.cleanup();
  for (const path of temporaryPaths.splice(0)) await removeDirectoryWithRetry(path);
});

async function worktreeFingerprint(
  repo: TestRepository,
  path: string,
  autocrlf: 'true' | 'false' = 'false',
) {
  const worktree = mkdtempSync(join(tmpdir(), 'lattice-v2-worktree-test-'));
  rmSync(worktree, { recursive: true, force: true });
  temporaryPaths.push(worktree);
  await execa(
    'git',
    ['-c', `core.autocrlf=${autocrlf}`, 'worktree', 'add', '--detach', worktree, 'HEAD'],
    { cwd: repo.path },
  );
  const result = await fingerprint(worktree, path);
  await execa('git', ['worktree', 'remove', '--force', worktree], { cwd: repo.path });
  return result;
}

async function internalPatch(
  workspace: string,
  changes: ChangeOperation[],
  verificationCommands: string[],
): Promise<InternalPatchIR> {
  const identity = await repositoryGrantIdentity(workspace);
  return {
    schemaVersion: 1,
    ...identity,
    summary: 'transaction test',
    changes,
    verificationCommands,
  };
}

describe('Git-aware fingerprints', () => {
  it('treats a clean CRLF source and LF worktree as the same tracked content', async () => {
    const repo = await repository(
      { 'src/value.txt': 'first\r\nsecond\r\n' },
      { autocrlf: 'true', attributes: '*.txt text eol=lf\n' },
    );
    repositories.push(repo);
    writeFileSync(join(repo.path, 'src/value.txt'), 'first\r\nsecond\r\n');
    const source = await fingerprint(repo.path, 'src/value.txt');
    const isolated = await worktreeFingerprint(repo, 'src/value.txt');
    expect(source.kind).toBe('git');
    expect(isolated.value).toBe(source.value);
    expect(isolated.rawSha256).not.toBe(source.rawSha256);
  });

  it('preserves UTF-8 BOM identity through a clean worktree', async () => {
    const repo = await repository({
      'src/bom.js': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const x = 1;\n')]),
    });
    repositories.push(repo);
    const source = await fingerprint(repo.path, 'src/bom.js');
    const isolated = await worktreeFingerprint(repo, 'src/bom.js');
    expect(isolated.value).toBe(source.value);
    expect(source.byteLength).toBe(16);
  });

  it('treats an LF source and CRLF worktree as the same tracked content', async () => {
    const repo = await repository(
      { 'src/value.txt': 'first\nsecond\n' },
      { autocrlf: 'false' },
    );
    repositories.push(repo);
    const source = await fingerprint(repo.path, 'src/value.txt');
    const isolated = await worktreeFingerprint(repo, 'src/value.txt', 'true');
    expect(isolated.value).toBe(source.value);
    expect(isolated.rawSha256).not.toBe(source.rawSha256);
  });

  it('uses raw SHA-256 for untracked files', async () => {
    const repo = await repository({ 'src/tracked.js': 'tracked\n' });
    repositories.push(repo);
    writeFileSync(join(repo.path, 'scratch.js'), 'scratch\r\n');
    const result = await fingerprint(repo.path, 'scratch.js');
    expect(result.kind).toBe('raw');
    expect(result.value).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.byteLength).toBe(Buffer.byteLength('scratch\r\n'));
  });

  it('rejects a tracked source symlink whose target is outside the repository', async (context) => {
    const repo = await repository({ 'src/tracked.js': 'tracked\n' });
    const external = await repository({
      'secret.js': 'export const secretOutsideRepository = true;\n',
    });
    repositories.push(repo, external);
    const relativePath = 'src/external-secret.js';
    try {
      symlinkSync(
        join(external.path, 'secret.js'),
        join(repo.path, relativePath),
        'file',
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) {
        context.skip(`OS denied test symlink creation (${code})`);
        return;
      }
      throw error;
    }
    await execa('git', ['add', '--', relativePath], { cwd: repo.path });

    await expect(fingerprint(repo.path, relativePath)).rejects.toThrow(
      /repository read escapes workspace/,
    );
  });
});

describe('Aegis transaction engine', () => {
  it('applies a complete replacement in an isolated worktree and leaves source untouched', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'src/value.js': 'module.exports = 1;\n',
    });
    repositories.push(repo);
    const before = await fingerprint(repo.path, 'src/value.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'module.exports = 2;\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
    );
    expect(result.status).toBe('passed');
    expect(result.diff).toContain('+module.exports = 2;');
    expect(readFileSync(join(repo.path, 'src/value.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(existsSync(result.worktree)).toBe(false);
  });

  it('supports repository paths containing spaces', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'src/path with spaces.js': 'old\n',
    });
    repositories.push(repo);
    const before = await fingerprint(repo.path, 'src/path with spaces.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/path with spaces.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'new\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
    );
    expect(result.status).toBe('passed');
  });

  it('excludes a CRLF-only rewrite when Git content identity is unchanged', async () => {
    const repo = await repository(
      {
        'src/value.js': 'first\nsecond\n',
      },
      { attributes: '*.js text eol=lf\n' },
    );
    repositories.push(repo);
    const before = await fingerprint(repo.path, 'src/value.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'first\r\nsecond\r\n',
        },
      ], []),
      [],
      telemetry(),
    );
    expect(result.status).toBe('passed');
    expect(result.changedFiles).toEqual([]);
    expect(result.diff).toBe('');
    expect(result.fingerprints[0].before?.value).toBe(result.fingerprints[0].after?.value);
    expect(result.fingerprints[0].before?.rawSha256).not.toBe(
      result.fingerprints[0].after?.rawSha256,
    );
  });

  it('rejects a real source mutation captured after context selection', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({ private: true }),
      'src/value.js': 'old\n',
    });
    repositories.push(repo);
    const captured = await fingerprint(repo.path, 'src/value.js');
    writeFileSync(join(repo.path, 'src/value.js'), 'mutated\n');
    await expect(
      transact(
        repo.path,
        await internalPatch(repo.path, [
          {
            path: 'src/value.js',
            operation: 'modify',
            expectedFingerprint: captured.value,
            replacementContent: 'worker output\n',
          },
        ], []),
        [],
        telemetry(),
      ),
    ).rejects.toThrow('stale source');
  });

  it('rejects commands outside the exact allowlist before creating a worktree', async () => {
    const repo = await repository({ 'src/value.js': 'old\n' });
    repositories.push(repo);
    const captured = await fingerprint(repo.path, 'src/value.js');
    await expect(
      transact(
        repo.path,
        await internalPatch(repo.path, [
          {
            path: 'src/value.js',
            operation: 'modify',
            expectedFingerprint: captured.value,
            replacementContent: 'new\n',
          },
        ], ['node arbitrary.js']),
        ['npm test'],
        telemetry(),
      ),
    ).rejects.toThrow('not allowlisted');
  });

  it('rejects an internal patch bound to another base commit', async () => {
    const repo = await repository({
      'src/value.js': 'old\n',
      'src/other.js': 'first\n',
    });
    repositories.push(repo);
    const captured = await fingerprint(repo.path, 'src/value.js');
    const patch = await internalPatch(
      repo.path,
      [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: captured.value,
          replacementContent: 'new\n',
        },
      ],
      [],
    );
    writeFileSync(join(repo.path, 'src/other.js'), 'second\n');
    await execa('git', ['add', 'src/other.js'], { cwd: repo.path });
    await execa('git', ['commit', '-m', 'advance base'], { cwd: repo.path });
    await expect(transact(repo.path, patch, [], telemetry())).rejects.toThrow(
      /base commit mismatch/,
    );
  });

  it('returns failed verification and cleans the worktree by default', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(9)"' },
      }),
      'src/value.js': 'old\n',
    });
    repositories.push(repo);
    const captured = await fingerprint(repo.path, 'src/value.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: captured.value,
          replacementContent: 'new\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
    );
    expect(result.status).toBe('failed');
    expect(result.verification[0].exitCode).toBe(9);
    expect(existsSync(result.worktree)).toBe(false);
  });

  it('retains a failed worktree only when explicitly requested', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(3)"' },
      }),
      'src/value.js': 'old\n',
    });
    repositories.push(repo);
    const captured = await fingerprint(repo.path, 'src/value.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: captured.value,
          replacementContent: 'new\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
      true,
    );
    expect(result.status).toBe('failed');
    expect(existsSync(result.worktree)).toBe(true);
    await execa('git', ['worktree', 'remove', '--force', result.worktree], { cwd: repo.path });
  });

  it('reports both identities, raw hashes, and lengths on a worktree mismatch', () => {
    expect(() =>
      assertMatchingWorktreeFingerprint(
        'src/value.js',
        'git:source',
        { kind: 'git', value: 'git:source', rawSha256: 'a', byteLength: 10 },
        { kind: 'git', value: 'git:other', rawSha256: 'b', byteLength: 11 },
      ),
    ).toThrow(
      /sourceIdentity=git:source.*worktreeIdentity=git:other.*sourceBytes=10.*worktreeBytes=11/,
    );
  });
});
