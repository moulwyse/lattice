import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { collectHistory, historyTotals } from '../src/history.js';
import { renderHistoryDetail, renderHistoryList, runHistoryMenu } from '../src/menu.js';
import { rememberRepository } from '../src/repositories.js';

function directory() {
  return resolve(mkdtempSync(join(tmpdir(), 'lattice-history-test-')));
}

function lines(values: unknown[]) {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

/** The text of a lattice_search_context result, as the MCP bridge returns it. */
function latticeResult(paths: string[], bytesUsed: number) {
  return JSON.stringify(
    {
      schemaVersion: 1,
      source: 'terra-sidecar',
      pages: paths.map((path) => ({ path, fingerprint: 'git:1', content: 'x', reason: 'match' })),
      bytesUsed,
    },
    null,
    2,
  );
}

/** A repository with two source files (10,000 and 30,000 bytes). */
function repository() {
  const root = join(directory(), 'shop');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'cart.ts'), 'c'.repeat(10_000));
  writeFileSync(join(root, 'src', 'checkout.ts'), 'k'.repeat(30_000));
  return root;
}

function environment() {
  return {
    ...process.env,
    LATTICE_SETTINGS_PATH: join(directory(), 'settings.json'),
    CLAUDE_CONFIG_DIR: directory(),
    CODEX_HOME: directory(),
  };
}

function claudeLog(env: ReturnType<typeof environment>, cwd: string, name: string, entries: unknown[]) {
  const folder = join(env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${name}.jsonl`), lines(entries));
}

const base = (cwd: string, at: string, entrypoint = 'claude-desktop') => ({ cwd, entrypoint, timestamp: at });

function claudeChat(env: ReturnType<typeof environment>, root: string) {
  const usage = { input_tokens: 1_000, cache_read_input_tokens: 9_000, output_tokens: 500 };
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'mcp__lattice__lattice_search_context', input: { query: 'cart' } };
  const result = latticeResult(['src/cart.ts', 'src/checkout.ts', 'src/cart.ts'], 4_000);
  claudeLog(env, root, 'chat-one', [
    { ...base(root, '2026-09-25T10:00:00.000Z'), type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { ...base(root, '2026-09-25T10:00:01.000Z'), type: 'user', message: { role: 'user', content: 'Fix the cart total when a coupon is applied' } },
    // One message logged once per content block with the same usage.
    { ...base(root, '2026-09-25T10:01:00.000Z'), type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [toolUse] } },
    { ...base(root, '2026-09-25T10:01:00.000Z'), type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage, content: [toolUse] } },
    {
      ...base(root, '2026-09-25T10:02:00.000Z'),
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: result }] }] },
      // Claude Code also keeps the raw result; it must not count twice.
      toolUseResult: [{ type: 'text', text: result }],
    },
    { ...base(root, '2026-09-25T10:20:00.000Z'), type: 'assistant', message: { id: 'msg_2', model: 'claude-opus-5-5', usage, content: [] } },
  ]);
}

describe('history', () => {
  test('reads each chat once with its Lattice savings against the whole files', () => {
    const env = environment();
    const root = repository();
    claudeChat(env, root);
    const [chat] = collectHistory(env);
    expect(chat).toMatchObject({
      kind: 'chat',
      agent: 'claude-code',
      surface: 'desktop',
      title: 'Fix the cart total when a coupon is applied',
      project: 'shop',
      model: 'claude-opus-5-5',
      startedAt: '2026-09-25T10:00:00.000Z',
      endedAt: '2026-09-25T10:20:00.000Z',
      tokens: { input: 20_000, cached: 18_000, output: 1_000 },
      // Two distinct files, 40,000 bytes whole, 4,000 sent.
      lattice: { calls: 1, pages: 3, files: 2, sentBytes: 4_000, fileBytes: 40_000, savedBytes: 36_000 },
      savedTokens: 9_000,
    });
    // Opus 5.5 input is $4 per million tokens.
    expect(chat.savedUsd).toBeCloseTo(9_000 * 4e-6, 10);
    expect(chat.costUsd).toBeGreaterThan(0);
  });

  test('reads Codex chats and counts a result logged as event and response once', () => {
    const env = environment();
    const root = repository();
    const day = join(env.CODEX_HOME, 'sessions', '2026', '09', '24');
    mkdirSync(day, { recursive: true });
    const result = latticeResult(['src/checkout.ts'], 2_000);
    writeFileSync(
      join(day, 'rollout-1.jsonl'),
      lines([
        { timestamp: '2026-09-24T09:00:00.000Z', type: 'session_meta', payload: { cwd: join(root, 'src'), originator: 'codex_cli_rs' } },
        { timestamp: '2026-09-24T09:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra' } },
        { timestamp: '2026-09-24T09:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
        { timestamp: '2026-09-24T09:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Speed up checkout' }] } },
        { timestamp: '2026-09-24T09:01:00.000Z', type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'call_1', invocation: { server: 'lattice', tool: 'lattice_read_context' }, result: { Ok: { content: [{ type: 'text', text: result }] } } } },
        { timestamp: '2026-09-24T09:01:00.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: JSON.stringify([{ type: 'text', text: result }]) } },
        { timestamp: '2026-09-24T09:05:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5_000, cached_input_tokens: 4_000, output_tokens: 300 } } } },
      ]),
    );
    const [chat] = collectHistory(env);
    expect(chat).toMatchObject({
      agent: 'codex',
      surface: 'cli',
      title: 'Speed up checkout',
      project: 'shop',
      model: 'gpt-6-astra',
      tokens: { input: 5_000, cached: 4_000, output: 300 },
      lattice: { calls: 1, sentBytes: 2_000, fileBytes: 30_000, savedBytes: 28_000 },
      savedTokens: 7_000,
      // No verified GPT price: tokens only.
      savedUsd: null,
      costUsd: null,
    });
  });

  test('skips automation, keeps chats without Lattice and lists lattice run tasks', () => {
    const env = environment();
    const root = repository();
    const usage = { input_tokens: 100, output_tokens: 10 };
    claudeLog(env, root, 'plain', [
      { ...base(root, '2026-09-23T10:00:00.000Z', 'cli'), type: 'user', message: { content: 'Explain the repo' } },
      { ...base(root, '2026-09-23T10:01:00.000Z', 'cli'), type: 'assistant', message: { id: 'a', model: 'claude-sonnet-5', usage } },
    ]);
    // Lattice's own SDK worker and its worktrees are tasks, not chats.
    claudeLog(env, root, 'worker', [
      { ...base(root, '2026-09-23T11:00:00.000Z', 'sdk-ts'), type: 'assistant', message: { id: 'b', usage } },
    ]);
    const worktree = join(root, '.lattice', 'worktrees', 'wt');
    claudeLog(env, worktree, 'worktree', [
      { ...base(worktree, '2026-09-23T12:00:00.000Z', 'cli'), type: 'assistant', message: { id: 'c', usage } },
    ]);
    mkdirSync(join(root, '.lattice', 'tasks'), { recursive: true });
    writeFileSync(
      join(root, '.lattice', 'tasks', 't.json'),
      JSON.stringify({
        status: 'failed',
        goal: 'Add coupon expiry check',
        model: 'claude-sonnet-5',
        lastRejectedAttempt: { changedFiles: ['src/cart.ts'] },
        error: 'Claude Code returned an error result: budget exceeded',
        telemetry: {
          modelInputTokens: 2_000,
          outputTokens: 50,
          costUsd: 0.004,
          loadedPageCount: 2,
          loadedContextCharacters: 8_000,
          sourceFileBytes: 40_000,
          runtimeStateTransitions: [{ at: '2026-09-22T08:00:00.000Z' }, { at: '2026-09-22T08:03:00.000Z' }],
        },
      }),
    );
    rememberRepository(root, env);
    const history = collectHistory(env);
    expect(history.map((entry) => [entry.kind, entry.title])).toEqual([
      ['chat', 'Explain the repo'],
      ['task', 'Add coupon expiry check'],
    ]);
    expect(history[0].lattice.calls).toBe(0);
    expect(history[1]).toMatchObject({
      status: 'failed',
      changedFiles: 1,
      reason: 'budget exceeded',
      costUsd: 0.004,
      lattice: { pages: 2, sentBytes: 8_000, fileBytes: 40_000, savedBytes: 32_000 },
      savedTokens: 8_000,
    });
    // The task's own rate: $0.004 for 2,000 input tokens.
    expect(history[1].savedUsd).toBeCloseTo(8_000 * 2e-6, 10);
    expect(historyTotals(history)).toMatchObject({
      entries: 2,
      withLattice: 1,
      chats: 1,
      tasks: { total: 1, passed: 0, failed: 1, other: 0 },
      savedTokens: 8_000,
    });
  });
});

describe('savings menu', () => {
  function fixture() {
    const env = environment();
    const root = repository();
    claudeChat(env, root);
    claudeLog(env, root, 'plain', [
      { ...base(root, '2026-09-23T10:00:00.000Z', 'cli'), type: 'user', message: { content: 'Explain the repo' } },
      { ...base(root, '2026-09-23T10:01:00.000Z', 'cli'), type: 'assistant', message: { id: 'a', model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 10 } } },
    ]);
    return { env, entries: collectHistory(env) };
  }

  test('lists the totals and every task with its own saving', () => {
    const { entries } = fixture();
    const text = renderHistoryList(entries, { view: 'list', selected: 0, offset: 0 }, 'ru', false, 40);
    expect(text).toContain('┌─ ЭКОНОМИЯ');
    expect(text).toMatch(/Сэкономлено\s+≈9\s000 токенов/);
    expect(text).toMatch(/С Lattice\s+1 из 2 задач/);
    expect(text).toContain('┌─ ИСТОРИЯ (2)');
    expect(text).toMatch(/│ ›1\s+\d\d\.09 \d\d:\d\d shop\s+Fix the cart total…\s+≈9\s000\s+0,036\s\$\s+│/);
    expect(text).toMatch(/│ 2\s+\d\d\.09 \d\d:\d\d shop\s+Explain the repo\s+—\s+│/);
    const boxLines = text.split('\n').filter((line) => /^\s*[┌│└]/.test(line));
    expect(new Set(boxLines.map((line) => [...line].length)).size).toBe(1);
  });

  test('a task card shows its full saving and spending', () => {
    const { entries } = fixture();
    const card = renderHistoryDetail(entries[0], 'en', false);
    expect(card).toContain('Fix the cart total when a coupon is applied');
    expect(card).toMatch(/Where\s+Claude Code · desktop/);
    expect(card).toMatch(/Lattice requests\s+1 \(3 pages, 2 files\)/);
    expect(card).toMatch(/Whole files\s+39\.1 KB/);
    expect(card).toMatch(/Saved\s+35\.2 KB ≈ 9,000 tokens \(90%\)/);
    expect(card).toMatch(/In money\s+~\$0\.036 \(est\., model input price\)/);
    expect(card).toMatch(/Tokens in\s+20,000 \(18,000 cached\)/);
    expect(renderHistoryDetail(entries[1], 'ru', false)).toContain('Lattice в этой задаче не использовался');
  });

  test('arrows move, Enter opens a task, Esc goes back and q quits', async () => {
    const { env, entries } = fixture();
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    Object.assign(input, { isTTY: true, setRawMode: () => input });
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    const screens: string[] = [];
    output.on('data', (chunk: Buffer) => screens.push(chunk.toString('utf8')));
    const done = runHistoryMenu({ terminal: { input, output }, language: 'en', env, entries });
    const key = async (sequence: string) => {
      const before = screens.length;
      input.write(sequence);
      const deadline = Date.now() + 5_000;
      while (screens.length === before && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      return screens.at(-1) ?? '';
    };
    expect(screens.at(-1)).toContain('HISTORY (2)');
    expect(await key('\x1b[B')).toMatch(/›2/);
    const card = await key('\r');
    expect(card).toContain('┌─ TASK');
    expect(card).toContain('Explain the repo');
    expect(await key('\x1b[A')).toContain('Fix the cart total');
    expect(await key('\x1b')).toContain('HISTORY (2)');
    input.write('q');
    await done;
  });
});
