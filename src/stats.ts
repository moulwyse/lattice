import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { metadata } from './core.js';
import { readClaudeIntegrationState } from './claude-integration.js';
import { codexIntegrationPaths, readCodexIntegrationState } from './codex-integration.js';
import { translate, type Language } from './i18n.js';
import { readUserSettings } from './user-settings.js';
import { LATTICE_VERSION } from './version.js';

const USAGE_LOG = 'mcp-usage.jsonl';
const USAGE_LOG_LIMIT_BYTES = 2 * 1024 * 1024;

export type LatticeStats = {
  schemaVersion: 1;
  version: string;
  latestVersion: string | null;
  repository: string;
  index: { files: number; bytes: number } | null;
  context: { calls: number; pages: number; bytes: number };
  tasks: {
    total: number;
    passed: number;
    failed: number;
    other: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number;
    verifiedCacheHits: number;
    lastTaskAt: string | null;
  };
  integrations: { claude: boolean; codex: boolean | null };
};

/**
 * Append one context-serving event for `lattice stats`. Only counts are kept,
 * never paths or content. Best effort: statistics must never fail a tool call.
 */
export function recordContextUsage(
  repositoryRoot: string,
  entry: { tool: string; pages: number; bytes: number },
) {
  try {
    const path = join(metadata(repositoryRoot), 'logs', USAGE_LOG);
    if (existsSync(path) && statSync(path).size > USAGE_LOG_LIMIT_BYTES) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Unwritable metadata only means this call is not counted.
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function numberOrZero(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function contextUsage(base: string) {
  const totals = { calls: 0, pages: 0, bytes: 0 };
  for (const name of [`${USAGE_LOG}.1`, USAGE_LOG]) {
    const path = join(base, 'logs', name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        totals.calls += 1;
        totals.pages += numberOrZero(entry.pages);
        totals.bytes += numberOrZero(entry.bytes);
      } catch {
        // Skip a torn line from an interrupted write.
      }
    }
  }
  return totals;
}

function taskTotals(base: string) {
  const totals: LatticeStats['tasks'] = {
    total: 0,
    passed: 0,
    failed: 0,
    other: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    verifiedCacheHits: 0,
    lastTaskAt: null,
  };
  const directory = join(base, 'tasks');
  if (!existsSync(directory)) return totals;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    const task = readJsonFile(path) as Record<string, unknown> | null;
    if (!task || typeof task.status !== 'string') continue;
    totals.total += 1;
    if (task.status === 'passed') totals.passed += 1;
    else if (task.status === 'failed') totals.failed += 1;
    else totals.other += 1;
    const telemetry = (task.telemetry ?? {}) as Record<string, unknown>;
    totals.inputTokens += numberOrZero(telemetry.modelInputTokens);
    totals.cachedInputTokens += numberOrZero(telemetry.cachedInputTokens);
    totals.outputTokens += numberOrZero(telemetry.outputTokens);
    totals.costUsd += numberOrZero(telemetry.costUsd);
    if (telemetry.verifiedPatchCacheHit === true) totals.verifiedCacheHits += 1;
    const transitions = Array.isArray(telemetry.runtimeStateTransitions)
      ? (telemetry.runtimeStateTransitions as { at?: unknown }[])
      : [];
    const last = transitions.at(-1)?.at;
    const at = typeof last === 'string' ? last : statSync(path).mtime.toISOString();
    if (!totals.lastTaskAt || at > totals.lastTaskAt) totals.lastTaskAt = at;
  }
  return totals;
}

function indexTotals(base: string) {
  const index = readJsonFile(join(base, 'index', 'index.json')) as
    | { files?: { size?: unknown }[] }
    | null;
  if (!index || !Array.isArray(index.files)) return null;
  return {
    files: index.files.length,
    bytes: index.files.reduce((sum, file) => sum + numberOrZero(file.size), 0),
  };
}

function codexEnabled(env: NodeJS.ProcessEnv) {
  try {
    return readCodexIntegrationState(codexIntegrationPaths(env)) !== null;
  } catch {
    return null;
  }
}

/** Read-only: nothing is created in `repositoryRoot`. */
export function collectStats(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): LatticeStats {
  const base = join(repositoryRoot, '.lattice');
  return {
    schemaVersion: 1,
    version: LATTICE_VERSION,
    latestVersion: readUserSettings(env).lastUpdateCheck?.latestVersion ?? null,
    repository: repositoryRoot,
    index: indexTotals(base),
    context: contextUsage(base),
    tasks: taskTotals(base),
    integrations: {
      claude: readClaudeIntegrationState(repositoryRoot) !== null,
      codex: codexEnabled(env),
    },
  };
}

export function formatBytes(bytes: number, language: Language) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

export function formatStats(stats: LatticeStats, language: Language) {
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
    translate(language, key, values);
  const number = (value: number) => new Intl.NumberFormat(language).format(value);
  const date = (value: string) =>
    new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );
  const lines = [`${t('statsTitle')}`, ''];
  const row = (label: string, value: string) => lines.push(`  ${label}: ${value}`);

  row(t('statsVersion'), stats.version);
  row(t('statsLatest'), stats.latestVersion ?? t('unknown'));
  row(t('statsRepository'), stats.repository);
  row(
    t('statsIndexed'),
    stats.index
      ? t('statsIndexedValue', {
          files: number(stats.index.files),
          size: formatBytes(stats.index.bytes, language),
        })
      : t('statsIndexNotBuilt'),
  );

  lines.push('', t('statsContextTitle'));
  if (stats.context.calls === 0) {
    lines.push(`  ${t('statsNone')}`);
  } else {
    lines.push(
      `  ${t('statsContextValue', {
        calls: number(stats.context.calls),
        pages: number(stats.context.pages),
        size: formatBytes(stats.context.bytes, language),
      })}`,
    );
    if (stats.index && stats.index.bytes > 0) {
      const share = stats.context.bytes / stats.context.calls / stats.index.bytes;
      lines.push(
        `  ${t('statsContextShare', {
          share: new Intl.NumberFormat(language, {
            style: 'percent',
            maximumFractionDigits: share < 0.01 ? 2 : 1,
          }).format(share),
        })}`,
      );
    }
  }

  lines.push('', t('statsTasksTitle'));
  if (stats.tasks.total === 0) {
    lines.push(`  ${t('statsNone')}`);
  } else {
    lines.push(
      `  ${t('statsTasksValue', {
        total: number(stats.tasks.total),
        passed: number(stats.tasks.passed),
        failed: number(stats.tasks.failed),
        other: number(stats.tasks.other),
      })}`,
    );
    row(
      t('statsTokens'),
      t('statsTokensValue', {
        input: number(stats.tasks.inputTokens),
        cached: number(stats.tasks.cachedInputTokens),
        output: number(stats.tasks.outputTokens),
      }),
    );
    row(
      t('statsCost'),
      new Intl.NumberFormat(language, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 4,
      }).format(stats.tasks.costUsd),
    );
    row(t('statsCacheHits'), number(stats.tasks.verifiedCacheHits));
    if (stats.tasks.lastTaskAt) row(t('statsLastTask'), date(stats.tasks.lastTaskAt));
  }

  lines.push('', t('statsIntegrations'));
  row(t('statsClaude'), stats.integrations.claude ? t('enabled') : t('disabled'));
  row(
    t('statsCodex'),
    stats.integrations.codex === null
      ? t('unknown')
      : stats.integrations.codex
        ? t('enabled')
        : t('disabled'),
  );
  lines.push('', t('statsNote'));
  return lines.join('\n');
}
