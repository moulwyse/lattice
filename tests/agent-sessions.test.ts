import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { collectAgentSessions } from '../src/agent-sessions.js';
import { renderDashboard } from '../src/dashboard.js';
import { collectStats, formatStats } from '../src/stats.js';

function directory() {
  return mkdtempSync(join(tmpdir(), 'lattice-sessions-test-'));
}

function lines(values: unknown[]) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n{partial`;
}

function assistant(cwd: string, id: string, usage: Record<string, number>, entrypoint = 'claude-desktop') {
  return {
    type: 'assistant',
    cwd,
    entrypoint,
    timestamp: '2026-09-25T10:00:00.000Z',
    message: { id, model: 'claude-opus-5-5', usage },
  };
}

/** A repository plus Claude Code and Codex logs with sessions inside and outside it. */
function fixture() {
  const repository = resolve(directory());
  const claudeHome = directory();
  const codexHome = directory();
  const project = join(claudeHome, 'projects', repository.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(project, { recursive: true });
  const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 50 };
  writeFileSync(
    join(project, 'desktop.jsonl'),
    lines([
      { type: 'user', cwd: repository },
      assistant(repository, 'msg_1', usage),
      assistant(repository, 'msg_1', usage),
      assistant(join(repository, 'src'), 'msg_2', usage),
      assistant(repository, 'msg_3', usage, 'sdk-ts'),
      assistant('C:/elsewhere', 'msg_4', usage),
    ]),
  );
  writeFileSync(join(project, 'terminal.jsonl'), lines([assistant(repository, 'msg_5', usage, 'cli')]));

  const day = join(codexHome, 'sessions', '2026', '09', '25');
  mkdirSync(day, { recursive: true });
  const tokenCount = (input: number, cached: number, output: number) => ({
    type: 'event_msg',
    timestamp: '2026-09-25T11:00:00.000Z',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
    },
  });
  writeFileSync(
    join(day, 'rollout-inside.jsonl'),
    lines([
      { type: 'session_meta', payload: { cwd: repository, originator: 'Codex Desktop' } },
      tokenCount(500, 400, 20),
      tokenCount(900, 700, 40),
    ]),
  );
  writeFileSync(
    join(day, 'rollout-outside.jsonl'),
    lines([
      { type: 'session_meta', payload: { cwd: directory(), originator: 'codex_cli_rs' } },
      tokenCount(5_000, 0, 5),
    ]),
  );
  return { repository, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome } };
}

describe('agent session usage', () => {
  test('counts Claude Code messages once, per surface, inside the repository only', () => {
    const { repository, env } = fixture();
    const groups = collectAgentSessions(repository, env);
    const claudeDesktop = groups.find((group) => group.agent === 'claude-code' && group.surface === 'desktop');
    // msg_1 is logged twice and counted once; msg_2 ran in a subdirectory;
    // the SDK message and the one outside the repository are skipped.
    expect(claudeDesktop).toMatchObject({ sessions: 1, inputTokens: 2_220, cachedInputTokens: 2_000, outputTokens: 100 });
    expect(groups.find((group) => group.surface === 'cli')).toMatchObject({
      agent: 'claude-code',
      sessions: 1,
      inputTokens: 1_110,
    });
  });

  test('takes the last running total of each Codex session in the repository', () => {
    const { repository, env } = fixture();
    const codex = collectAgentSessions(repository, env).filter((group) => group.agent === 'codex');
    expect(codex).toEqual([
      {
        agent: 'codex',
        surface: 'desktop',
        sessions: 1,
        inputTokens: 900,
        cachedInputTokens: 700,
        outputTokens: 40,
        lastAt: '2026-09-25T11:00:00.000Z',
      },
    ]);
  });

  test('missing log directories mean no sessions', () => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: directory(), CODEX_HOME: directory() };
    expect(collectAgentSessions(directory(), env)).toEqual([]);
  });

  test('sessions appear in Lattice stats and on the start screen', () => {
    const { repository, env } = fixture();
    const stats = collectStats(repository, { ...env, LATTICE_SETTINGS_PATH: join(directory(), 's.json') });
    const report = formatStats(stats, 'ru');
    expect(report).toContain('Сессии Claude Code и Codex в этом репозитории');
    expect(report).toContain('Claude Code · десктоп: 1 сессия');
    expect(report).toContain('Codex · десктоп: 1 сессия');
    const screen = renderDashboard({ stats, project: 'p', branch: null, engine: null }, 'en', false);
    expect(screen).toContain('AGENT SESSIONS');
    expect(screen).toMatch(/Claude Code · desktop\s+1 session/);
    expect(screen).toMatch(/Tokens\s+4,230 sent/);
    const boxLines = screen.split('\n').filter((line) => /^\s*[┌│└]/.test(line));
    expect(new Set(boxLines.map((line) => [...line].length)).size).toBe(1);
  });
});
