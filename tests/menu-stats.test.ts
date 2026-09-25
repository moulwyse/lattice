import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LANGUAGES, MESSAGES, translate, languageFromLocale } from '../src/i18n.js';
import {
  LatticeMcpBridge,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOL_NAMES,
  type McpBridgeDependencies,
} from '../src/mcp-server.js';
import { renderMenu, runMenu } from '../src/menu.js';
import { collectStats, formatBytes, formatStats, recordContextUsage } from '../src/stats.js';
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
  return { ...process.env, LATTICE_SETTINGS_PATH: path, LATTICE_NO_UPDATE_CHECK: '1' };
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
    expect(translate('ru', 'version', { version: '2.1.0' })).toBe('Версия 2.1.0');
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
    expect(stats.context).toEqual({ calls: 1, pages: 2, bytes: 1_000 });
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
    expect(text.match(/none yet/g)).toHaveLength(2);
  });

  test('records usage counts only', () => {
    const root = temporaryDirectory();
    recordContextUsage(root, { tool: 'lattice_read_context', pages: 1, bytes: 42 });
    const log = readFileSync(join(root, '.lattice', 'logs', 'mcp-usage.jsonl'), 'utf8');
    expect(JSON.parse(log)).toMatchObject({ tool: 'lattice_read_context', pages: 1, bytes: 42 });
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
    expect(response.result.content[0].text).toContain('Статистика Lattice');
    expect(response.result.content[0].text).toContain('Задачі через Lattice');
    expect(MCP_SERVER_INSTRUCTIONS).toContain('lattice_stats');
    await bridge.close();
  });
});

describe('interactive menu', () => {
  test('renders numbered items with the selection marked', () => {
    const text = renderMenu({ header: ['Lattice'], title: 'Main', labels: ['One', 'Two'], selected: 1, hint: 'hint' });
    expect(text).toContain('1  One');
    expect(text).toMatch(/›.*2 {2}Two/);
  });

  test('asks for a language first, opens stats and quits', async () => {
    const root = repositoryWithState();
    const env = settingsEnv();
    const input = new PassThrough() as PassThrough & NodeJS.ReadStream;
    Object.assign(input, { isTTY: true, setRawMode: () => input });
    const output = new PassThrough() as PassThrough & NodeJS.WriteStream;
    let written = '';
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });
    const done = runMenu({ cliPath: 'unused', cwd: root, env, terminal: { input, output } });
    // Send each key only once its screen is drawn, so slow hosts cannot race.
    let seen = 0;
    const after = async (text: string, keys: string) => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = written.indexOf(text, seen);
        if (found >= 0) {
          seen = found + text.length;
          break;
        }
        if (Date.now() > deadline) throw new Error(`menu never showed: ${text}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      // Let the prompt attach its listener after the screen is written.
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      input.write(keys);
    };
    await after('Choose your language', '2'); // Русский
    await after('Главное меню', '2'); // Статистика
    await after('Нажмите Enter', '\r'); // back from the stats screen
    await after('Главное меню', 'q');
    await done;
    expect(readUserSettings(env).language).toBe('ru');
    expect(written).toContain('Choose your language');
    expect(written).toContain('Главное меню');
    expect(written).toContain('Статистика Lattice');
    expect(written).toContain('всего 2: 1 успешно');
  });
});
