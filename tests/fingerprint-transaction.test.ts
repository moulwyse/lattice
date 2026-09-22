import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { repositoryGrantIdentity } from '../src/edit-grants.js';
import { fingerprint } from '../src/fingerprint.js';
import { telemetry } from '../src/telemetry.js';
import {
  applyVerifiedPatch,
  assertMatchingWorktreeFingerprint,
  transact,
} from '../src/transaction.js';
import { repository, type TestRepository } from './helpers.js';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import { metadata } from '../src/core.js';
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

  it('verifies on top of uncommitted work and diffs only the transaction changes', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: {
          test: 'node -e "const fs=require(\'fs\');process.exit(fs.readFileSync(\'src/other.js\',\'utf8\')===\'dirty\\n\'&&fs.existsSync(\'notes.js\')&&!fs.existsSync(\'src/gone.js\')?0:7)"',
        },
      }),
      'src/value.js': 'old\n',
      'src/other.js': 'clean\n',
      'src/gone.js': 'removed later\n',
    });
    repositories.push(repo);
    writeFileSync(join(repo.path, 'src/other.js'), 'dirty\n');
    writeFileSync(join(repo.path, 'notes.js'), 'untracked\n');
    rmSync(join(repo.path, 'src/gone.js'));
    const before = await fingerprint(repo.path, 'src/value.js');
    const patch = await internalPatch(
      repo.path,
      [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'new\n',
        },
      ],
      ['npm test'],
    );
    const result = await transact(repo.path, patch, ['npm test'], telemetry());
    expect(result.verification[0].stderr).toBe('');
    expect(result.status).toBe('passed');
    expect(result.diff).toContain('+new');
    expect(result.diff).not.toContain('other.js');
    expect(result.diff).not.toContain('notes.js');
    expect(result.diff).not.toContain('gone.js');

    await applyVerifiedPatch(repo.path, patch, result.diff);
    expect(readFileSync(join(repo.path, 'src/value.js'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(repo.path, 'src/other.js'), 'utf8')).toBe('dirty\n');
    expect(readFileSync(join(repo.path, 'notes.js'), 'utf8')).toBe('untracked\n');
  });

  it('runs verification against the workspace dependencies and never deletes them', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(require(\'local-dep\')===42?0:5)"' },
      }),
      'src/value.js': 'old\n',
    });
    repositories.push(repo);
    mkdirSync(join(repo.path, 'node_modules', 'local-dep'), { recursive: true });
    writeFileSync(join(repo.path, 'node_modules', 'local-dep', 'index.js'), 'module.exports = 42;\n');
    const before = await fingerprint(repo.path, 'src/value.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'new\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
    );
    expect(result.status).toBe('passed');
    expect(existsSync(result.worktree)).toBe(false);
    expect(existsSync(join(repo.path, 'node_modules', 'local-dep', 'index.js'))).toBe(true);
  });

  it('creates and deletes files in the transaction and applies them to the workspace', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: {
          test: 'node -e "const fs=require(\'fs\');process.exit(fs.existsSync(\'src/new.js\')&&!fs.existsSync(\'src/old.js\')?0:4)"',
        },
      }),
      'src/old.js': 'legacy\n',
    });
    repositories.push(repo);
    const old = await fingerprint(repo.path, 'src/old.js');
    const patch = await internalPatch(
      repo.path,
      [
        { path: 'src/old.js', operation: 'delete', expectedFingerprint: old.value },
        { path: 'src/new.js', operation: 'create', replacementContent: 'fresh\n' },
      ],
      ['npm test'],
    );
    const result = await transact(repo.path, patch, ['npm test'], telemetry());
    expect(result.status).toBe('passed');
    expect(result.changedFiles).toEqual(['src/old.js', 'src/new.js']);
    expect(result.diff).toContain('deleted file mode');
    expect(result.diff).toContain('new file mode');
    expect(existsSync(join(repo.path, 'src/new.js'))).toBe(false);

    await applyVerifiedPatch(repo.path, patch, result.diff);
    expect(readFileSync(join(repo.path, 'src/new.js'), 'utf8')).toBe('fresh\n');
    expect(existsSync(join(repo.path, 'src/old.js'))).toBe(false);
  });

  it('ignores untracked nested repositories when mirroring uncommitted work', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'src/value.js': 'old\n',
    });
    repositories.push(repo);
    mkdirSync(join(repo.path, 'tools', 'nested'), { recursive: true });
    await execa('git', ['init'], { cwd: join(repo.path, 'tools', 'nested') });
    writeFileSync(join(repo.path, 'tools', 'nested', 'a.txt'), 'nested\n');
    writeFileSync(join(repo.path, 'notes.md'), 'untracked\n');
    const before = await fingerprint(repo.path, 'src/value.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'new\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
    );
    expect(result.status).toBe('passed');
    expect(result.changedFiles).toEqual(['src/value.js']);
  });

  it('reports a hanging verification command as failed verification', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "setTimeout(() => {}, 60000)"' },
      }),
      'src/value.js': 'old\n',
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
          replacementContent: 'new\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
      false,
      undefined,
      1_500,
    );
    expect(result.status).toBe('failed');
    expect(result.verification[0].exitCode).toBe(124);
    expect(result.verification[0].stderr).toContain('verification timed out');
  }, 30_000);

  it('removes crashed-run worktrees and their dependency links, never the linked target', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'src/value.js': 'old\n',
    });
    repositories.push(repo);
    mkdirSync(join(repo.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    const worktrees = join(repo.path, '.lattice', 'worktrees');
    const stale = join(worktrees, 'stale-run');
    await execa('git', ['worktree', 'add', '--detach', stale, 'HEAD'], { cwd: repo.path });
    symlinkSync(
      join(repo.path, 'node_modules'),
      join(stale, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(Number.isInteger(exited.pid)).toBe(true);
    writeFileSync(
      join(worktrees, 'stale-run.owner.json'),
      JSON.stringify({ schemaVersion: 1, pid: exited.pid, createdAt: new Date().toISOString() }),
    );
    const before = await fingerprint(repo.path, 'src/value.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'new\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
    );
    expect(result.status).toBe('passed');
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(worktrees, 'stale-run.owner.json'))).toBe(false);
    expect(existsSync(join(repo.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
  }, 60_000);

  it('removes dependency links from a retained worktree', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(3)"' },
      }),
      'src/value.js': 'old\n',
    });
    repositories.push(repo);
    mkdirSync(join(repo.path, 'node_modules', 'dep'), { recursive: true });
    const before = await fingerprint(repo.path, 'src/value.js');
    const result = await transact(
      repo.path,
      await internalPatch(repo.path, [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'new\n',
        },
      ], ['npm test']),
      ['npm test'],
      telemetry(),
      true,
    );
    expect(existsSync(result.worktree)).toBe(true);
    expect(existsSync(join(result.worktree, 'node_modules'))).toBe(false);
    expect(existsSync(join(repo.path, 'node_modules', 'dep'))).toBe(true);
    await execa('git', ['worktree', 'remove', '--force', result.worktree], { cwd: repo.path });
  });

  it('keeps .lattice out of commits through the clone-local exclude file', async () => {
    const repo = await repository({ 'src/value.js': 'old\n' });
    repositories.push(repo);
    writeFileSync(join(repo.path, '.gitignore'), '');
    metadata(repo.path);
    metadata(repo.path);
    const exclude = readFileSync(join(repo.path, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.match(/^\/\.lattice\/$/gm)).toHaveLength(1);
    const status = await execa('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repo.path,
    });
    expect(status.stdout).not.toContain('.lattice');
  });

  it('rejects creating a Git-ignored path', async () => {
    const repo = await repository({ 'src/value.js': 'old\n' });
    repositories.push(repo);
    await expect(
      transact(
        repo.path,
        await internalPatch(
          repo.path,
          [{ path: 'node_modules/x.js', operation: 'create', replacementContent: 'x\n' }],
          [],
        ),
        [],
        telemetry(),
      ),
    ).rejects.toThrow(/ignored by Git/);
  });

  it('refuses to apply a verified patch after the source changed', async () => {
    const repo = await repository({
      'package.json': JSON.stringify({
        private: true,
        scripts: { test: 'node -e "process.exit(0)"' },
      }),
      'src/value.js': 'old\n',
    });
    repositories.push(repo);
    const before = await fingerprint(repo.path, 'src/value.js');
    const patch = await internalPatch(
      repo.path,
      [
        {
          path: 'src/value.js',
          operation: 'modify',
          expectedFingerprint: before.value,
          replacementContent: 'new\n',
        },
      ],
      ['npm test'],
    );
    const result = await transact(repo.path, patch, ['npm test'], telemetry());
    writeFileSync(join(repo.path, 'src/value.js'), 'edited meanwhile\n');
    await expect(applyVerifiedPatch(repo.path, patch, result.diff)).rejects.toThrow(
      /source changed since verification/,
    );
    expect(readFileSync(join(repo.path, 'src/value.js'), 'utf8')).toBe('edited meanwhile\n');
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
