import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import {
  installCodexSyncHooks,
  removeCodexSyncHooks,
} from '../src/codex-hooks.js';
import {
  codexSessionModelStatePath,
  readCodexSessionModelState,
  runCodexSessionSync,
} from '../src/codex-session-sync.js';
import type { SidecarLease } from '../src/sidecar.js';
import type { SidecarState } from '../src/sidecar-protocol.js';

const cleanups: string[] = [];

afterEach(async () => {
  for (const path of cleanups.splice(0)) await removeDirectoryWithRetry(path);
});

function temporaryDirectory(label: string) {
  const path = mkdtempSync(join(tmpdir(), label));
  cleanups.push(path);
  return path;
}

function lease(workspace: string): SidecarLease {
  return {
    state: {
      schemaVersion: 1,
      protocolVersion: 1,
      repositoryId: 'repo-id',
      workspace,
      pid: process.pid,
      port: 42_001,
      token: 'a'.repeat(64),
      status: 'ready',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      indexedFiles: 1,
      activeLeases: 1,
      bridgeClients: 0,
      mode: 'passive-index-only',
      lastInvalidatedPaths: [],
      telemetry: {
        startupMs: 1,
        attachCount: 1,
        lastAttachMs: 1,
        initialIndexMs: 1,
        incrementalInvalidationMs: null,
        nativeCodexProcessLifetimeMs: null,
        bridgeRequestCount: 0,
        bridgeInitializeCount: 0,
        contextBytesSupplied: 0,
        contextEstimatedTokensSupplied: 0,
        contextGrantCount: 0,
        errors: [],
      },
    } satisfies SidecarState,
    leaseId: '11111111-1111-4111-8111-111111111111',
    stopHeartbeat: vi.fn(),
    detach: vi.fn(async () => undefined),
  };
}

describe('Codex session synchronization', () => {
  test('stores the active /model value and warms Lattice before returning', async () => {
    const workspace = temporaryDirectory('lattice-codex-session-');
    const codexHome = temporaryDirectory('lattice-codex-session-home-');
    const activeLease = lease(workspace);
    const ensure = vi.fn(async () => activeLease);
    const now = new Date('2026-07-22T12:00:00.000Z');
    const input = Readable.from([
      JSON.stringify({
        session_id: 'codex-session-1',
        transcript_path: null,
        cwd: workspace,
        hook_event_name: 'UserPromptSubmit',
        model: 'gpt-selected-in-codex',
      }),
    ]);

    const result = await runCodexSessionSync(input, {
      discover: async () => ({ safe: true, root: workspace, source: 'git' }),
      ensure,
      now: () => now,
      env: { CODEX_HOME: codexHome },
    });

    expect(result).toMatchObject({ synced: true });
    expect(readCodexSessionModelState(workspace, { now })).toMatchObject({
      sessionId: 'codex-session-1',
      model: 'gpt-selected-in-codex',
      reasoningEffort: null,
      hookEvent: 'UserPromptSubmit',
    });
    expect(ensure).toHaveBeenCalledWith(workspace);
    expect(activeLease.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(activeLease.detach).toHaveBeenCalledTimes(1);
    expect(existsSync(codexSessionModelStatePath(workspace))).toBe(true);
  });

  test('recovers the exact /model reasoning effort from the current Codex rollout', async () => {
    const workspace = temporaryDirectory('lattice-codex-effort-');
    const codexHome = temporaryDirectory('lattice-codex-effort-home-');
    const sessionId = '019f87c7-7598-7e93-8ffd-9888e563a9b9';
    const sessionDirectory = join(codexHome, 'sessions', '2026', '07', '22');
    requireDirectory(sessionDirectory);
    writeFileSync(
      join(
        sessionDirectory,
        `rollout-2026-07-22T11-59-59-${sessionId}.jsonl`,
      ),
      `${JSON.stringify({
        timestamp: '2026-07-22T11:59:59.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-selected-in-codex', effort: 'low' },
      })}\n`,
    );
    writeFileSync(
      join(codexHome, 'config.toml'),
      'model_reasoning_effort = "medium"\n',
    );
    const activeLease = lease(workspace);
    const now = new Date('2026-07-22T12:00:00.000Z');

    await runCodexSessionSync(
      Readable.from([
        JSON.stringify({
          session_id: sessionId,
          cwd: workspace,
          hook_event_name: 'UserPromptSubmit',
          model: 'gpt-selected-in-codex',
        }),
      ]),
      {
        discover: async () => ({ safe: true, root: workspace, source: 'git' }),
        ensure: async () => activeLease,
        now: () => now,
        env: { CODEX_HOME: codexHome },
      },
    );

    expect(readCodexSessionModelState(workspace, { now })).toMatchObject({
      model: 'gpt-selected-in-codex',
      reasoningEffort: 'low',
      hookEvent: 'UserPromptSubmit',
    });
  });

  test('warms on early SessionStart and falls back to Codex config while model is loading', async () => {
    const workspace = temporaryDirectory('lattice-codex-session-loading-');
    const codexHome = temporaryDirectory('lattice-codex-home-');
    mkdirSync(join(workspace, '.codex'));
    writeFileSync(
      join(workspace, '.codex', 'config.toml'),
      'model = "gpt-project-startup"\nmodel_reasoning_effort = "high"\n',
    );
    const activeLease = lease(workspace);
    const ensure = vi.fn(async () => activeLease);

    const result = await runCodexSessionSync(
      Readable.from([
        JSON.stringify({
          session_id: 'startup-session',
          cwd: workspace,
          hook_event_name: 'SessionStart',
        }),
      ]),
      {
        discover: async () => ({ safe: true, root: workspace, source: 'git' }),
        ensure,
        env: { CODEX_HOME: codexHome },
      },
    );

    expect(result).toMatchObject({ synced: true, warmed: true });
    expect(readCodexSessionModelState(workspace)).toMatchObject({
      sessionId: 'startup-session',
      model: 'gpt-project-startup',
      reasoningEffort: 'high',
      hookEvent: 'SessionStart',
    });
    expect(ensure).toHaveBeenCalledWith(workspace);
  });

  test('does not wait for EOF after Codex writes one complete hook JSON object', async () => {
    const workspace = temporaryDirectory('lattice-codex-open-stdin-');
    const codexHome = temporaryDirectory('lattice-codex-open-stdin-home-');
    const input = new PassThrough();
    const activeLease = lease(workspace);
    const running = runCodexSessionSync(input, {
      discover: async () => ({ safe: true, root: workspace, source: 'git' }),
      ensure: async () => activeLease,
      env: { CODEX_HOME: codexHome },
    });
    input.write(
      `${JSON.stringify({
        session_id: 'open-stdin-session',
        cwd: workspace,
        hook_event_name: 'UserPromptSubmit',
        model: 'gpt-open-stdin',
      })}\n`,
    );

    await expect(running).resolves.toMatchObject({
      synced: true,
      warmed: true,
    });
    input.destroy();
  });

  test('ignores stale session settings', () => {
    const workspace = temporaryDirectory('lattice-codex-session-stale-');
    writeFileSync(join(workspace, 'lattice.config.json'), '{}\n');
    const statePath = codexSessionModelStatePath(workspace);
    const metadataPath = join(workspace, '.lattice');
    const input = JSON.stringify({
      schemaVersion: 1,
      sessionId: 'old-session',
      workspace,
      model: 'old-model',
      reasoningEffort: null,
      hookEvent: 'SessionStart',
      updatedAt: '2026-07-20T00:00:00.000Z',
    });
    // The reader is deliberately tolerant: stale/corrupt ephemeral state must
    // never prevent Lattice from falling back to Codex defaults.
    requireDirectory(metadataPath);
    writeFileSync(statePath, input);
    expect(
      readCodexSessionModelState(workspace, {
        now: new Date('2026-07-22T00:00:00.000Z'),
      }),
    ).toBeNull();
  });
});

function requireDirectory(path: string) {
  mkdirSync(path, { recursive: true });
}

describe('Codex hook ownership', () => {
  test('merges with user hooks and removes only the Lattice handlers', () => {
    const root = temporaryDirectory('lattice-codex-hooks-');
    const hooksPath = join(root, 'hooks.json');
    const userHook = {
      description: 'User hooks',
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: 'user-command' }],
          },
        ],
      },
    };
    writeFileSync(hooksPath, `${JSON.stringify(userHook, null, 2)}\n`);

    const installed = installCodexSyncHooks({
      nodeExecutable: process.execPath,
      cliPath: join(root, 'lattice-cli.js'),
      path: hooksPath,
    });
    expect(installed.changed).toBe(true);
    const merged = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(merged.hooks.SessionStart).toHaveLength(2);
    expect(merged.hooks.UserPromptSubmit).toHaveLength(1);
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    expect(merged.hooks.PostToolUse).toHaveLength(1);

    const removed = removeCodexSyncHooks(installed.registration);
    expect(removed).toMatchObject({ changed: true, outcome: 'removed' });
    expect(JSON.parse(readFileSync(hooksPath, 'utf8'))).toEqual(userHook);
  });
});
