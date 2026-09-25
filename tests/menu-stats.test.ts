import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fileCount, LANGUAGES, MESSAGES, translate, languageFromLocale } from '../src/i18n.js';
import {
  LatticeMcpBridge,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOL_NAMES,
  type McpBridgeDependencies,
} from '../src/mcp-server.js';
import { renderDashboard, renderLogo, runStartScreen, type DashboardData } from '../src/dashboard.js';
import {
  collectStats,
  formatBytes,
  formatStats,
  recordContextUsage,
  sourceFileBytes,
  taskName,
} from '../src/stats.js';
import { compareVersions, fetchLatestRelease } from '../src/update-check.js';
import { readUserSettings, updateUserSettings } from '../src/user-settings.js';

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'lattice-menu-test-'));
}

const originalSettingsPath = process.env.LATTICE_SETTINGS_PATH;
afterEach(() => {
  if (originalSettingsPath === undefined) delete process.env.LATTICE_SETTINGS_PATH;
  else process.env.LATTICE_SETTINGS_PATH = originalSettingsPath;
});

function settingsEnv(language?: string) {
  const path = join(temporaryDirectory(), 'settings.json');
  if (language) writeFileSync(path, JSON.stringify({ schemaVersion: 1, language }));
  // Empty agent log directories keep the developer's real sessions out of tests.
  return {
    ...process.env,
    LATTICE_SETTINGS_PATH: path,
    LATTICE_NO_UPDATE_CHECK: '1',
    CLAUDE_CONFIG_DIR: temporaryDirectory(),
    CODEX_HOME: temporaryDirectory(),
  };
}

/** A repository with an index, two tasks and one MCP usage entry. */
function repositoryWithState() {
  const root = temporaryDirectory();
  writeFileSync(join(root, 'lattice.config.json'), '{}');
  const base = join(root, '.lattice');
  mkdirSync(join(base, 'index'), { recursive: true });
  mkdirSync(join(base, 'tasks'), { recursive: true });
  mkdirSync(join(base, 'logs'), { recursive: true });
  writeFileSync(
    join(base, 'index', 'index.json'),
    JSON.stringify({ files: [{ size: 4_000 }, { size: 6_000 }] }),
  );
  writeFileSync(
    join(base, 'tasks', 'a.json'),
    JSON.stringify({
      status: 'passed',
      goal: 'Fix reset token behavior: consume once',
      telemetry: {
        modelInputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 300,
        costUsd: 0.01,
        verifiedPatchCacheHit: true,
        runtimeStateTransitions: [{ at: '2026-09-20T10:00:00.000Z' }],
      },
    }),
  );
  writeFileSync(
    join(base, 'tasks', 'b.json'),
    JSON.stringify({
      status: 'failed',
      telemetry: {
        modelInputTokens: 500,
        cachedInputTokens: null,
        outputTokens: 100,
        costUsd: 0.005,
        runtimeStateTransitions: [{ at: '2026-09-21T10:00:00.000Z' }],
      },
    }),
  );
  writeFileSync(
    join(base, 'logs', 'mcp-usage.jsonl'),
    `${JSON.stringify({ tool: 'lattice_search_context', pages: 2, bytes: 1_000 })}\n{torn`,
  );
  return root;
}

describe('translations', () => {
  test('every language has every message with the same placeholders', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const english = MESSAGES.en;
    for (const { code } of LANGUAGES) {
      const messages = MESSAGES[code];
      expect(Object.keys(messages).sort()).toEqual(Object.keys(english).sort());
      for (const key of Object.keys(english) as (keyof typeof english)[]) {
        expect(messages[key].trim(), `${code}.${key}`).not.toBe('');
        expect(placeholders(messages[key]), `${code}.${key}`).toEqual(placeholders(english[key]));
      }
    }
  });

  test('fills placeholders and maps locales', () => {
    expect(translate('ru', 'dashSent', { count: '5' })).toBe('5 отправлено');
    expect(languageFromLocale('uk-UA')).toBe('uk');
    expect(languageFromLocale('pt-BR')).toBeNull();
  });
});

describe('user settings', () => {
  test('round-trips the language and ignores unknown values', () => {
    const env = settingsEnv();
    expect(readUserSettings(env)).toEqual({ schemaVersion: 1 });
    updateUserSettings({ language: 'pl' }, env);
    expect(readUserSettings(env).language).toBe('pl');
    writeFileSync(env.LATTICE_SETTINGS_PATH, JSON.stringify({ language: 'xx' }));
    expect(readUserSettings(env).language).toBeUndefined();
  });
});

describe('update check', () => {
  test('compares release versions numerically', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('v2.1.0', '2.1.0')).toBe(0);
    expect(compareVersions('2.0.1', '2.1.0')).toBe(-1);
  });

  test('reads the release tag and only a Lattice package asset', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v9.0.0',
          assets: [
            { name: 'other.tgz', browser_download_url: 'https://example.com/other.tgz' },
            {
              name: 'lattice-v2-9.0.0.tgz',
              browser_download_url:
                'https://github.com/moulwyse/lattice/releases/download/v9.0.0/lattice-v2-9.0.0.tgz',
            },
          ],
        }),
      ),
    ) as unknown as typeof fetch;
    await expect(fetchLatestRelease({ fetchImpl })).resolves.toEqual({
      version: '9.0.0',
      tag: 'v9.0.0',
      packageUrl:
        'https://github.com/moulwyse/lattice/releases/download/v9.0.0/lattice-v2-9.0.0.tgz',
    });
  });

  test('treats network failures and bad payloads as unknown', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(fetchLatestRelease({ fetchImpl: failing })).resolves.toBeNull();
    const malformed = (async () => new Response('{"tag_name":"latest"}')) as unknown as typeof fetch;
    await expect(fetchLatestRelease({ fetchImpl: malformed })).resolves.toBeNull();
  });
});

describe('stats', () => {
  test('totals tasks, tokens, cost and served context without writing', () => {
    const root = repositoryWithState();
    const stats = collectStats(root, settingsEnv());
    expect(stats.index).toEqual({ files: 2, bytes: 10_000 });
    expect(stats.context).toEqual({ calls: 1, pages: 2, bytes: 1_000, fileBytes: 0, savedBytes: 0 });
    expect(stats.tasks).toMatchObject({
      total: 2,
      passed: 1,
      failed: 1,
      other: 0,
      inputTokens: 1_500,
      cachedInputTokens: 200,
      outputTokens: 400,
      verifiedCacheHits: 1,
      lastTaskAt: '2026-09-21T10:00:00.000Z',
    });
    expect(stats.tasks.costUsd).toBeCloseTo(0.015);
    expect(stats.integrations.claude).toBe(false);
  });

  test('formats a localized report', () => {
    const root = repositoryWithState();
    const text = formatStats(collectStats(root, settingsEnv()), 'ru');
    expect(text).toContain('Статистика Lattice');
    expect(text).toContain('всего 2: 1 успешно, 1 с ошибкой, 0 прочих');
    expect(text).toMatch(/10[\s ]%/);
    expect(formatBytes(1_536, 'en')).toBe('1.5 KB');
  });

  test('an empty repository reports nothing yet', () => {
    const text = formatStats(collectStats(temporaryDirectory(), settingsEnv()), 'en');
    expect(text).toContain('not built yet');
    expect(text.match(/none yet/g)).toHaveLength(3);
  });

  test('names recent tasks from their goal, newest first', () => {
    const stats = collectStats(repositoryWithState(), settingsEnv());
    expect(stats.recentTasks.map((task) => [task.name, task.status])).toEqual([
      ['b.json', 'failed'],
      ['fix-reset-token-behavior', 'passed'],
    ]);
    expect(taskName('Исправь сброс токена!', 'x')).toBe('исправь-сброс-токена');
  });

  test('counts chat savings against the whole source files', () => {
    const root = repositoryWithState();
    const log = join(root, '.lattice', 'logs', 'mcp-usage.jsonl');
    writeFileSync(
      log,
      [
        // Written before file sizes were recorded: no baseline, no savings.
        { tool: 'lattice_search_context', pages: 2, bytes: 1_000 },
        { tool: 'lattice_search_context', pages: 3, bytes: 2_000, fileBytes: 10_000 },
        { tool: 'lattice_read_context', pages: 1, bytes: 800, fileBytes: 600 },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    );
    const stats = collectStats(root, settingsEnv());
    expect(stats.context).toEqual({
      calls: 3,
      pages: 6,
      bytes: 3_800,
      fileBytes: 10_600,
      savedBytes: 8_000,
    });
    const text = formatStats(stats, 'en');
    expect(text).toContain('Saved against reading the whole files: 7.8 KB of 10.4 KB (75.5%), ≈2,000 tokens.');
    expect(formatStats(stats, 'ru')).toContain('Экономия против чтения целых файлов');
    const screen = renderDashboard(
      { stats, project: 'p', branch: null, engine: null },
      'en',
      false,
    );
    expect(screen).toMatch(/│ Tokens\s+1,500 sent\s+~2,000 pruned \(est\.\)\s+│/);
    // Without session prices, the tasks' effective rate ($0.015 / 1,500) values it.
    expect(stats.estimates.savedUsd).toBeCloseTo(0.02);
    expect(screen).toMatch(/│ Est\. cost\s+\$0\.015\s+~\$0\.02 saved \(est\.\)\s+│/);
    for (const { code } of LANGUAGES) {
      // The detail column has 29 cells; a compact count is at most six.
      for (const key of ['dashPruned', 'dashSavedUsd'] as const) {
        const detail = translate(code, key, { count: '999.9K', amount: '$999.999' });
        expect([...detail].length, `${code}.${key}`).toBeLessThanOrEqual(29);
      }
      expect([...translate(code, 'dashEstCost')].length, code).toBeLessThanOrEqual(11);
    }
    const boxLines = screen.split('\n').filter((line) => /^\s*[┌│└]/.test(line));
    expect(new Set(boxLines.map((line) => [...line].length)).size).toBe(1);
  });

  test('without recorded file sizes the report shows no savings line', () => {
    const stats = collectStats(repositoryWithState(), settingsEnv());
    expect(formatStats(stats, 'en')).not.toContain('Saved against');
    expect(renderDashboard({ stats, project: 'p', branch: null, engine: null }, 'en', false)).not.toContain(
      'pruned',
    );
  });

  test('measures distinct source files inside the repository only', () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.js'), 'x'.repeat(300));
    writeFileSync(join(root, 'b.js'), 'y'.repeat(50));
    const outside = join(temporaryDirectory(), 'secret.txt');
    writeFileSync(outside, 'z'.repeat(1_000));
    expect(
      sourceFileBytes(root, ['src/a.js', 'src/a.js', 'b.js', 'missing.js', '../x', outside, 'src']),
    ).toBe(350);
    expect(sourceFileBytes(join(root, 'nope'), ['b.js'])).toBe(0);
  });

  test('records usage counts only', () => {
    const root = temporaryDirectory();
    recordContextUsage(root, { tool: 'lattice_read_context', pages: 1, bytes: 42 });
    const log = readFileSync(join(root, '.lattice', 'logs', 'mcp-usage.jsonl'), 'utf8');
    expect(JSON.parse(log)).toMatchObject({ tool: 'lattice_read_context', pages: 1, bytes: 42 });
  });
});

describe('chat context savings', () => {
  test('the MCP bridge records the whole size of the files behind served pages', async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'service.js'), 's'.repeat(5_000));
    writeFileSync(join(root, 'src', 'login.js'), 'l'.repeat(3_000));
    const page = (path: string, content: string) => ({ path, fingerprint: 'git:1', content, reason: 'match' });
    const dependencies: McpBridgeDependencies = {
      discover: async () => ({ safe: true, root, source: 'git' }),
      ensure: async () => ({
        state: {} as never,
        leaseId: 'lease',
        stopHeartbeat: () => undefined,
        detach: async () => undefined,
      }) as never,
      status: async () => ({ running: true }),
      context: async () => ({
        pages: [page('src/service.js', 'a'.repeat(400)), page('src/service.js', 'b'.repeat(300)), page('src/login.js', 'c'.repeat(300))],
        bytesUsed: 1_000,
      }),
    };
    const bridge = new LatticeMcpBridge({ dependencies });
    await bridge.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const response = (await bridge.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: MCP_TOOL_NAMES.searchContext, arguments: { query: 'service' } },
    })) as { result: { isError?: boolean } };
    expect(response.result.isError).toBeUndefined();
    await bridge.close();
    const log = readFileSync(join(root, '.lattice', 'logs', 'mcp-usage.jsonl'), 'utf8');
    expect(JSON.parse(log)).toMatchObject({
      tool: MCP_TOOL_NAMES.searchContext,
      pages: 3,
      bytes: 1_000,
      fileBytes: 8_000,
    });
    expect(log).not.toContain('service.js');
    expect(collectStats(root, settingsEnv()).context).toMatchObject({ fileBytes: 8_000, savedBytes: 7_000 });
  });
});

describe('lattice_stats MCP tool', () => {
  test('is advertised to agents and returns the localized report', async () => {
    const root = repositoryWithState();
    process.env.LATTICE_SETTINGS_PATH = settingsEnv('uk').LATTICE_SETTINGS_PATH;
    const dependencies: McpBridgeDependencies = {
      discover: async () => ({ safe: true, root, source: 'git' }),
      ensure: async () => {
        throw new Error('stats must not start the sidecar');
      },
      status: async () => ({ running: false }),
      context: async () => ({ pages: [], bytesUsed: 0 }),
    };
    const bridge = new LatticeMcpBridge({ dependencies });
    await bridge.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    const response = (await bridge.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: MCP_TOOL_NAMES.stats, arguments: {} },
    })) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(response.result.isError).toBeUndefined();
    const text = response.result.content[0].text;
    // The same boxed screen as in the terminal, inside a code block for chat.
    expect(text.startsWith('```text\n')).toBe(true);
    expect(text.endsWith('\n```')).toBe(true);
    expect(text).toContain('┌─ МЕТРИКИ');
    expect(text).toMatch(/│ Задачі\s+усього 2\s+✓ 1 {2}✗ 1\s+│/);
    expect(text).toContain('┌─ WORKTREE-КОНВЕЄР');
    // Chats save nothing until an integration is enabled; the screen says how.
    expect(text).toContain('Lattice не підключено до чатів');
    expect(text).toContain('lattice integration claude enable');
    expect(text).not.toContain('lattice doctor');
    expect(text).not.toMatch(/\x1b\[/);
    expect(MCP_SERVER_INSTRUCTIONS).toContain('lattice_stats');
    await bridge.close();
  });
});

describe('start screen', () => {
  const sample = (): DashboardData => ({
    project: 'my-project',
    branch: 'main',
    engine: 'claude-code',
    stats: {
      ...collectStats(repositoryWithState(), settingsEnv()),
      recentTasks: [
        { name: 'fix-reset-token', status: 'passed', files: 3, verificationMs: 2_100, reason: null, at: '2' },
        { name: 'refactor-auth', status: 'failed', files: 1, verificationMs: null, reason: 'stale fingerprint', at: '1' },
      ],
    },
  });

  test('draws the logo, status line, metrics and pipeline with aligned boxes', () => {
    const text = renderDashboard(sample(), 'en', false);
    expect(renderLogo(false)).toHaveLength(8);
    expect(text).toContain('my-project · git:main · engine:claude-code');
    expect(text).toContain('┌─ METRICS');
    expect(text).toContain('1,500 sent');
    expect(text).toContain('$0.015');
    expect(text).toMatch(/✓ fix-reset-token\s+3 files\s+verified 2\.1s · isolated wt/);
    expect(text).toMatch(/✗ refactor-auth\s+1 file\s+failed: stale fingerprint/);
    expect(text).toContain('● ready');
    const boxLines = text.split('\n').filter((line) => /^\s*[┌│└]/.test(line));
    expect(new Set(boxLines.map((line) => [...line].length)).size).toBe(1);
  });

  test('uses localized labels and plural forms', () => {
    const text = renderDashboard(sample(), 'ru', false);
    expect(text).toContain('МЕТРИКИ');
    expect(text).toContain('3 файла');
    expect(text).toContain('1 файл ');
    expect(fileCount('ru', 5)).toBe('5 файлов');
    expect(fileCount('uk', 2)).toBe('2 файли');
    expect(fileCount('en', 1)).toBe('1 file');
  });

  test('outside a repository it only shows the logo, status and a warning', () => {
    const text = renderDashboard({ stats: null, project: 'tmp', branch: null, engine: null }, 'en', false);
    expect(text).not.toContain('METRICS');
    expect(text).toContain('not a Git repository');
    expect(text).toContain('engine:none');
  });

  test('asks for a language on the first start, then prints the screen', async () => {
    const root = repositoryWithState();
    const env = settingsEnv();
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    Object.assign(input, { isTTY: true, setRawMode: () => input });
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const done = runStartScreen({ cliPath: 'unused', cwd: root, env, terminal: { input, output } });
    const deadline = Date.now() + 10_000;
    while (!written.includes('Choose your language')) {
      if (Date.now() > deadline) throw new Error('language picker never appeared');
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    input.write('2');
    // The savings menu opens and stays until q.
    while (!written.includes('ИСТОРИЯ')) {
      if (Date.now() > deadline) throw new Error('the menu never appeared');
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    input.write('q');
    await done;
    expect(readUserSettings(env).language).toBe('ru');
    expect(written).toContain('┌─ ЭКОНОМИЯ');
  });

  test('a later start prints the screen without asking', async () => {
    const env = settingsEnv('en');
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    await runStartScreen({ cliPath: 'unused', cwd: repositoryWithState(), env, terminal: { input, output } });
    expect(written).not.toContain('Choose your language');
    // Without a keyboard the menu is printed once.
    expect(written).toContain('┌─ SAVINGS');
    expect(written).toContain('HISTORY (0)');
  });
});
