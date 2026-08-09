import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeCommandArguments } from '../src/claude-command.js';
import {
  CLAUDE_HAIKU_4_5_MODEL,
  CLAUDE_OPUS_5_MODEL,
  CLAUDE_SONNET_5_MODEL,
  parseClaudeReasoningEffort,
  resolveClaudeModelSettings,
} from '../src/claude-model-settings.js';
import {
  claudeProviderUsage,
  claudeQueryOptions,
} from '../src/claude-worker.js';
import { applyCodexLatticePolicy } from '../src/codex-lattice-policy.js';
import {
  readClaudeSessionModelState,
  runClaudeSessionSyncValue,
} from '../src/claude-session-sync.js';
import {
  claudeIntegrationStatus,
  disableClaudeIntegration,
  enableClaudeIntegration,
} from '../src/claude-integration.js';
import {
  CLAUDE_WORKER_OUTPUT_SCHEMA,
  parseClaudeResponse,
} from '../src/providers/claude/protocol.js';
import { runManagedProcess } from '../src/managed-process.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('Claude provider protocol', () => {
  it('uses an Anthropic-compatible object schema without a root union', () => {
    expect(CLAUDE_WORKER_OUTPUT_SCHEMA).toMatchObject({
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: { enum: ['context_request', 'patch'] },
        requests: { type: 'array' },
        patch: { type: 'object' },
      },
    });
    expect(CLAUDE_WORKER_OUTPUT_SCHEMA).not.toHaveProperty('oneOf');
    expect(CLAUDE_WORKER_OUTPUT_SCHEMA).not.toHaveProperty('anyOf');
    expect(CLAUDE_WORKER_OUTPUT_SCHEMA).not.toHaveProperty('allOf');
    const wireSchema = JSON.stringify(CLAUDE_WORKER_OUTPUT_SCHEMA);
    expect(wireSchema).not.toContain('minLength');
    expect(wireSchema).not.toContain('minItems');
    expect(wireSchema).not.toContain('pattern');
  });

  it('accepts canonical handle-only patches', () => {
    const response = parseClaudeResponse(JSON.stringify({
      kind: 'patch',
      patch: {
        summary: 'update',
        changes: [{
          editHandle: 'E1',
          operation: 'replace_text',
          replacements: [{ oldContent: 'before', newContent: 'after' }],
        }],
        verificationCommands: ['npm test'],
      },
    }));
    expect(response.kind).toBe('patch');
  });

  it('accounts for Anthropic cache creation and cache reads without hiding input', () => {
    const usage = claudeProviderUsage({
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 40,
        cache_read_input_tokens: 60,
        output_tokens: 25,
      },
    } as never);
    expect(usage).toEqual({
      input_tokens: 200,
      cached_input_tokens: 60,
      output_tokens: 25,
      reasoning_output_tokens: 0,
    });
  });

  it('records provider-reported cost without estimating hidden prices', () => {
    const usage = claudeProviderUsage({
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 20,
        output_tokens: 4,
      },
      total_cost_usd: 0.0123,
    } as never);
    expect(usage.cost_usd).toBe(0.0123);
  });

  it('rejects the historical Codex action envelope', () => {
    expect(() => parseClaudeResponse(JSON.stringify({
      contextRequest: null,
      patch: {
        kind: 'patch',
        patch: {
          summary: 'update',
          changes: [{
            editHandle: 'E1',
            operation: 'replace_file',
            replacementContent: 'after',
          }],
          verificationCommands: ['npm test'],
        },
      },
    }))).toThrow(/Claude worker protocol error/);
  });
});

describe('Claude model selection', () => {
  it('maps risk to conservative adaptive Claude settings', () => {
    const workspace = temporaryDirectory('lattice-claude-model-');
    writeFileSync(
      join(workspace, 'lattice.config.json'),
      JSON.stringify({ modelPolicy: 'adaptive' }),
    );
    const low = resolveClaudeModelSettings(workspace, {}, 'low');
    expect(low).toMatchObject({
      model: CLAUDE_HAIKU_4_5_MODEL,
      modelSource: 'adaptive-policy',
    });
    expect(low.reasoningEffort).toBeUndefined();
    expect(resolveClaudeModelSettings(workspace, {}, 'medium')).toMatchObject({
      model: CLAUDE_SONNET_5_MODEL,
      reasoningEffort: 'medium',
    });
    expect(resolveClaudeModelSettings(workspace, {}, 'high')).toMatchObject({
      model: CLAUDE_OPUS_5_MODEL,
      reasoningEffort: 'xhigh',
    });
  });

  it('keeps Opus 5 adaptive thinking enabled at xhigh effort', () => {
    const workspace = temporaryDirectory('lattice-claude-opus-5-');
    const previousDisableThinking = process.env.CLAUDE_CODE_DISABLE_THINKING;
    process.env.CLAUDE_CODE_DISABLE_THINKING = '1';
    try {
      const options = claudeQueryOptions(
        workspace,
        {
          model: CLAUDE_OPUS_5_MODEL,
          reasoningEffort: 'xhigh',
          modelPolicy: 'adaptive',
          modelPolicySource: 'lattice-config',
          policyRisk: 'high',
          modelSource: 'adaptive-policy',
          reasoningEffortSource: 'adaptive-policy',
          maxBudgetUsd: 1.25,
        },
        new AbortController(),
      );
      expect(options.model).toBe(CLAUDE_OPUS_5_MODEL);
      expect(options.effort).toBe('xhigh');
      expect(options.thinking).toEqual({ type: 'adaptive' });
      expect(options.maxBudgetUsd).toBe(1.25);
      expect(options.strictMcpConfig).toBe(true);
      expect(options.mcpServers).toEqual({});
      expect(options.outputFormat).toMatchObject({ type: 'json_schema' });
      expect(options.env?.CLAUDE_CODE_DISABLE_THINKING).toBeUndefined();
    } finally {
      if (previousDisableThinking === undefined) {
        delete process.env.CLAUDE_CODE_DISABLE_THINKING;
      } else {
        process.env.CLAUDE_CODE_DISABLE_THINKING = previousDisableThinking;
      }
    }
  });

  it('captures the resolved effort supplied by current Claude tool hooks', async () => {
    const workspace = temporaryDirectory('lattice-claude-effort-sync-');
    let ensureCalls = 0;
    const dependencies = {
      discover: async () => ({
        safe: true,
        root: workspace,
        start: workspace,
        reason: 'test',
      }) as never,
      ensure: async () => {
        ensureCalls += 1;
        return {
          stopHeartbeat() {},
          async detach() {},
        } as never;
      },
      now: () => new Date('2026-07-28T12:00:00.000Z'),
      env: {} as NodeJS.ProcessEnv,
    };
    await runClaudeSessionSyncValue({
      session_id: 'claude-opus-session',
      cwd: workspace,
      hook_event_name: 'SessionStart',
      model: CLAUDE_OPUS_5_MODEL,
    }, dependencies);
    const captured = await runClaudeSessionSyncValue({
      session_id: 'claude-opus-session',
      cwd: workspace,
      hook_event_name: 'PreToolUse',
      effort: { level: 'xhigh' },
    }, dependencies);
    expect(captured.warmed).toBe(false);
    expect(ensureCalls).toBe(1);
    expect(readClaudeSessionModelState(workspace, {
      now: new Date('2026-07-28T12:00:00.000Z'),
    })).toMatchObject({
      model: CLAUDE_OPUS_5_MODEL,
      reasoningEffort: 'xhigh',
      hookEvent: 'PreToolUse',
    });
  });

  it('validates Claude-specific effort levels', () => {
    expect(parseClaudeReasoningEffort('max')).toBe('max');
    expect(() => parseClaudeReasoningEffort('minimal')).toThrow(
      /Claude reasoning effort/,
    );
  });

  it('validates and resolves a provider-scoped spend cap', () => {
    const workspace = temporaryDirectory('lattice-claude-budget-');
    writeFileSync(
      join(workspace, 'lattice.config.json'),
      JSON.stringify({ providers: { claude: { maxBudgetUsd: 2.5 } } }),
    );
    expect(resolveClaudeModelSettings(workspace).maxBudgetUsd).toBe(2.5);
    expect(() => resolveClaudeModelSettings(workspace, {
      maxBudgetUsd: 0,
    })).toThrow(/positive finite number/);
  });
});

describe('Claude project integration', () => {
  it('adds and surgically removes only Lattice MCP and hooks', async () => {
    const workspace = temporaryDirectory('lattice-claude-integration-');
    await runManagedProcess('git', ['init'], { cwd: workspace });
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          existing: { type: 'http', url: 'https://example.invalid/mcp' },
        },
      }),
    );
    const settingsDirectory = join(workspace, '.claude');
    mkdirSync(settingsDirectory, { recursive: true });
    writeFileSync(
      join(settingsDirectory, 'settings.local.json'),
      JSON.stringify({ permissions: { allow: ['Read'] } }),
    );

    await enableClaudeIntegration({
      workspace,
      cliPath: join(workspace, 'dist', 'cli.js'),
    });
    const enabled = await claudeIntegrationStatus(workspace);
    expect(enabled.enabled).toBe(true);
    const mcp = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.existing.url).toBe('https://example.invalid/mcp');
    expect(mcp.mcpServers.lattice.type).toBe('stdio');
    const settings = JSON.parse(
      readFileSync(join(settingsDirectory, 'settings.local.json'), 'utf8'),
    );
    expect(settings.hooks.SubagentStart).toHaveLength(1);

    const disabled = await disableClaudeIntegration(workspace);
    expect(disabled.changed).toBe(true);
    const restoredMcp = JSON.parse(
      readFileSync(join(workspace, '.mcp.json'), 'utf8'),
    );
    expect(restoredMcp.mcpServers.existing.url).toBe(
      'https://example.invalid/mcp',
    );
    expect(restoredMcp.mcpServers.lattice).toBeUndefined();
    const restoredSettings = JSON.parse(
      readFileSync(join(settingsDirectory, 'settings.local.json'), 'utf8'),
    );
    expect(restoredSettings.permissions.allow).toEqual(['Read']);
    expect(existsSync(join(workspace, '.lattice', 'claude-integration.json'))).toBe(false);
  });

  it('does not overwrite a different existing lattice MCP definition', async () => {
    const workspace = temporaryDirectory('lattice-claude-conflict-');
    await runManagedProcess('git', ['init'], { cwd: workspace });
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          lattice: { type: 'http', url: 'https://user-owned.invalid/mcp' },
        },
      }),
    );
    await expect(enableClaudeIntegration({
      workspace,
      cliPath: join(workspace, 'dist', 'cli.js'),
    })).rejects.toThrow(/preserved/);
  });

  it('preserves a pre-existing enabled-server setting on disable', async () => {
    const workspace = temporaryDirectory('lattice-claude-existing-enabled-');
    await runManagedProcess('git', ['init'], { cwd: workspace });
    const settingsDirectory = join(workspace, '.claude');
    mkdirSync(settingsDirectory, { recursive: true });
    writeFileSync(
      join(settingsDirectory, 'settings.local.json'),
      JSON.stringify({ enabledMcpjsonServers: ['existing', 'lattice'] }),
    );

    await enableClaudeIntegration({
      workspace,
      cliPath: join(workspace, 'dist', 'cli.js'),
    });
    await disableClaudeIntegration(workspace);

    const restoredSettings = JSON.parse(
      readFileSync(join(settingsDirectory, 'settings.local.json'), 'utf8'),
    );
    expect(restoredSettings.enabledMcpjsonServers).toEqual([
      'existing',
      'lattice',
    ]);
  });

  it('is idempotent and removes project files that Lattice created', async () => {
    const workspace = temporaryDirectory('lattice-claude-idempotent-');
    await runManagedProcess('git', ['init'], { cwd: workspace });
    const cliPath = join(workspace, 'dist', 'cli.js');

    const first = await enableClaudeIntegration({ workspace, cliPath });
    const second = await enableClaudeIntegration({ workspace, cliPath });
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);

    await disableClaudeIntegration(workspace);
    expect(existsSync(join(workspace, '.mcp.json'))).toBe(false);
    expect(existsSync(join(workspace, '.claude', 'settings.local.json'))).toBe(false);
  });
});

describe('Claude raw bypass', () => {
  it('uses an empty strict MCP configuration without changing global MCP state', () => {
    expect(claudeCommandArguments(['--model', 'sonnet'], true)).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--model',
      'sonnet',
    ]);
    expect(claudeCommandArguments(['--model', 'sonnet'], false)).toEqual([
      '--model',
      'sonnet',
    ]);
  });

  it('makes hook policy a no-op in raw mode', async () => {
    const output = await applyCodexLatticePolicy({
      session_id: 'raw',
      prompt_id: 'raw',
      cwd: process.cwd(),
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    }, {
      env: { ...process.env, LATTICE_CLAUDE_RAW: '1' },
    });
    expect(output).toBeNull();
  });
});

describe('Claude Lattice-first hooks', () => {
  it('uses prompt_id to gate the first repository tool until Lattice is attempted', async () => {
    const workspace = temporaryDirectory('lattice-claude-policy-repo-');
    const localData = temporaryDirectory('lattice-claude-policy-state-');
    await runManagedProcess('git', ['init'], { cwd: workspace });
    const env = { ...process.env, LOCALAPPDATA: localData };
    const base = {
      session_id: 'claude-session-1',
      prompt_id: 'claude-prompt-1',
      cwd: workspace,
    };

    const submitted = await applyCodexLatticePolicy({
      ...base,
      hook_event_name: 'UserPromptSubmit',
    }, { env });
    expect(submitted).toMatchObject({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit' },
    });

    const blocked = await applyCodexLatticePolicy({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    }, { env });
    expect(blocked).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });

    await applyCodexLatticePolicy({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__lattice__lattice_search_context',
    }, { env });
    const allowed = await applyCodexLatticePolicy({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    }, { env });
    expect(allowed).toBeNull();
  });

  it('enforces Lattice-first with the current Claude hook schema and subagents', async () => {
    const workspace = temporaryDirectory('lattice-claude-current-hooks-');
    const localData = temporaryDirectory('lattice-claude-current-state-');
    await runManagedProcess('git', ['init'], { cwd: workspace });
    const env = { ...process.env, LOCALAPPDATA: localData };
    const base = {
      session_id: 'claude-current-session',
      cwd: workspace,
    };

    await applyCodexLatticePolicy({
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Inspect the repository',
    }, { env });
    expect(await applyCodexLatticePolicy({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    }, { env })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    await applyCodexLatticePolicy({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__lattice__lattice_search_context',
    }, { env });
    expect(await applyCodexLatticePolicy({
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
    }, { env })).toBeNull();

    const subagent = {
      ...base,
      agent_id: 'agent-opus-5',
      agent_type: 'Explore',
    };
    expect(await applyCodexLatticePolicy({
      ...subagent,
      hook_event_name: 'SubagentStart',
    }, { env })).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
      },
    });
    expect(await applyCodexLatticePolicy({
      ...subagent,
      hook_event_name: 'PreToolUse',
      tool_name: 'Grep',
    }, { env })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });
});
