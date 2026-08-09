import { cpSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeDirectoryWithRetry } from './cleanup.js';
import { metadata, writeJson } from './core.js';
import { Events } from './events.js';
import { runManagedProcess } from './managed-process.js';
import { runTask } from './runtime.js';
import type { RunOptions } from './runtime.js';

const benchmarkGoal =
  'Fix reset token behavior: consume a valid token once, reject a second consumption and expired tokens, record a password-reset audit event, and preserve login behavior.';

export function resetTokenFixture() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const externalCandidates = [
    join(moduleDirectory, '..', '..', 'tests', 'fixtures', 'sample-repository'),
    join(moduleDirectory, '..', 'tests', 'fixtures', 'sample-repository'),
  ];
  for (const external of externalCandidates) {
    if (
      existsSync(join(external, 'src', 'auth', 'token-repository.js')) &&
      existsSync(join(external, 'tests', 'token.test.js'))
    ) {
      return { path: external, source: 'external' as const };
    }
  }
  return {
    path: join(moduleDirectory, '..', 'fixtures', 'reset-token'),
    source: 'bundled' as const,
  };
}

export async function runResetTokenBenchmark(
  artifactWorkspace: string,
  worker: 'mock' | 'codex' | 'claude',
  events = new Events(),
  signal?: AbortSignal,
  modelSettings: Pick<
    RunOptions,
    'model' | 'reasoningEffort' | 'modelPolicy' | 'maxBudgetUsd'
  > = {},
) {
  signal?.throwIfAborted();
  const fixture = resetTokenFixture();
  const workspace = mkdtempSync(join(tmpdir(), 'lattice-v2-reset-token-'));
  cpSync(join(fixture.path, 'package.json'), join(workspace, 'package.json'));
  cpSync(join(fixture.path, 'src'), join(workspace, 'src'), { recursive: true });
  cpSync(join(fixture.path, 'tests'), join(workspace, 'tests'), { recursive: true });
  writeFileSync(join(workspace, '.gitignore'), '.lattice/\nnode_modules/\n', 'utf8');
  try {
    await runManagedProcess('git', ['init'], { cwd: workspace, signal });
    await runManagedProcess(
      'git',
      ['config', 'user.email', 'lattice@example.invalid'],
      { cwd: workspace, signal },
    );
    await runManagedProcess('git', ['config', 'user.name', 'Lattice Benchmark'], {
      cwd: workspace,
      signal,
    });
    await runManagedProcess('git', ['config', 'core.autocrlf', 'false'], {
      cwd: workspace,
      signal,
    });
    await runManagedProcess('git', ['add', '.'], { cwd: workspace, signal });
    await runManagedProcess('git', ['commit', '-m', 'reset-token baseline'], {
      cwd: workspace,
      signal,
    });

    const baseline = await runManagedProcess('npm', ['test'], {
      cwd: workspace,
      reject: false,
      signal,
    });
    const result = await runTask(workspace, benchmarkGoal, {
      worker,
      events,
      signal,
      ...modelSettings,
    });
    const artifact = {
      schemaVersion: 1,
      benchmark: 'reset-token-v2',
      fixtureSource: fixture.source,
      fixturePath: fixture.path,
      worker,
      createdAt: new Date().toISOString(),
      baseline: {
        status: baseline.exitCode === 0 ? 'passed' : 'failed',
        exitCode: baseline.exitCode,
        stdout: baseline.stdout,
        stderr: baseline.stderr,
      },
      result,
    };
    const path = join(metadata(artifactWorkspace), 'benchmarks', 'reset-token-v2.json');
    const workerPath = join(
      metadata(artifactWorkspace),
      'benchmarks',
      `reset-token-v2-${worker}.json`,
    );
    writeJson(path, artifact);
    writeJson(workerPath, artifact);
    return { artifact, path, workerPath };
  } finally {
    const resolved = join(tmpdir(), workspace.substring(tmpdir().length));
    if (resolved === workspace && workspace.startsWith(tmpdir())) {
      await removeDirectoryWithRetry(workspace);
    }
  }
}
