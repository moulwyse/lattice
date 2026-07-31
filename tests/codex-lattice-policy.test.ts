import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import {
  applyCodexLatticePolicy,
  LATTICE_FIRST_CONTEXT,
} from '../src/codex-lattice-policy.js';

const cleanups: string[] = [];

afterEach(async () => {
  for (const path of cleanups.splice(0)) await removeDirectoryWithRetry(path);
});

function fixture() {
  const workspace = mkdtempSync(join(tmpdir(), 'lattice-policy-workspace-'));
  const localData = mkdtempSync(join(tmpdir(), 'lattice-policy-state-'));
  cleanups.push(workspace, localData);
  const now = new Date('2026-07-22T12:00:00.000Z');
  return {
    workspace,
    dependencies: {
      discover: async () => ({
        safe: true as const,
        root: workspace,
        source: 'git' as const,
      }),
      now: () => now,
      env: { LOCALAPPDATA: localData },
    },
  };
}

function hook(
  workspace: string,
  hookEventName: string,
  options: { turnId?: string; toolName?: string } = {},
) {
  return {
    session_id: 'session-1',
    turn_id: options.turnId ?? 'turn-1',
    cwd: workspace,
    hook_event_name: hookEventName,
    ...(options.toolName ? { tool_name: options.toolName } : {}),
  };
}

describe('Codex Lattice-first policy', () => {
  test('injects mandatory guidance and blocks repository tools until Lattice is attempted', async () => {
    const { workspace, dependencies } = fixture();

    await expect(
      applyCodexLatticePolicy(
        hook(workspace, 'UserPromptSubmit'),
        dependencies,
      ),
    ).resolves.toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: LATTICE_FIRST_CONTEXT,
      },
    });

    const denied = await applyCodexLatticePolicy(
      hook(workspace, 'PreToolUse', { toolName: 'Bash' }),
      dependencies,
    );
    expect(denied).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    expect(
      denied?.hookSpecificOutput.permissionDecisionReason,
    ).toContain('lattice_search_context');

    await expect(
      applyCodexLatticePolicy(
        hook(workspace, 'PreToolUse', {
          toolName: 'mcp__lattice__lattice_search_context',
        }),
        dependencies,
      ),
    ).resolves.toBeNull();

    await expect(
      applyCodexLatticePolicy(
        hook(workspace, 'PreToolUse', { toolName: 'Bash' }),
        dependencies,
      ),
    ).resolves.toBeNull();
  });

  test('resets enforcement independently for every Codex turn', async () => {
    const { workspace, dependencies } = fixture();
    await applyCodexLatticePolicy(
      hook(workspace, 'UserPromptSubmit'),
      dependencies,
    );
    await applyCodexLatticePolicy(
      hook(workspace, 'PreToolUse', {
        toolName: 'lattice_read_context',
      }),
      dependencies,
    );
    await applyCodexLatticePolicy(
      hook(workspace, 'UserPromptSubmit', { turnId: 'turn-2' }),
      dependencies,
    );

    await expect(
      applyCodexLatticePolicy(
        hook(workspace, 'PreToolUse', {
          turnId: 'turn-2',
          toolName: 'apply_patch',
        }),
        dependencies,
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  test('fails open outside a safe repository', async () => {
    const { workspace, dependencies } = fixture();
    const unsafe = {
      ...dependencies,
      discover: async () => ({
        safe: false as const,
        root: null,
        source: 'none' as const,
        reason: 'not a repository',
      }),
    };

    await expect(
      applyCodexLatticePolicy(
        hook(workspace, 'PreToolUse', { toolName: 'Bash' }),
        unsafe,
      ),
    ).resolves.toBeNull();
  });
});
