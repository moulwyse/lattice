import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  collectAgentSessions,
  scanAgentSessions,
  type AgentUsage,
  type SessionRecord,
} from './agent-sessions.js';
import { metadata } from './core.js';
import { readClaudeIntegrationState } from './claude-integration.js';
import { codexIntegrationPaths, readCodexIntegrationState } from './codex-integration.js';
import { sessionCount, taskCount, translate, type Language, type MessageKey } from './i18n.js';
import { discoverRepositories, rememberRepository } from './repositories.js';
import { sourceFileBytes } from './source-bytes.js';
import { readUserSettings } from './user-settings.js';

export { sourceFileBytes };
import { LATTICE_VERSION } from './version.js';

const USAGE_LOG = 'mcp-usage.jsonl';
const USAGE_LOG_LIMIT_BYTES = 2 * 1024 * 1024;

export type RecentTask = {
  name: string;
  status: 'passed' | 'failed' | 'other';
  files: number;
  verificationMs: number | null;
  reason: string | null;
  at: string;
  /** Set when tasks of several projects are listed together. */
  project?: string;
};

/**
 * Estimates, marked as such wherever they are shown. Pruned context is what
 * Lattice kept out of the model compared with sending the whole files its
 * pages came from, in chats and in `lattice run` tasks.
 */
export type StatsEstimates = {
  prunedBytes: number;
  prunedTokens: number;
  /** Provider-reported task cost plus Claude Code sessions at list prices. */
  costUsd: number;
  /** Pruned tokens at the average uncached input price; null without a price. */
  savedUsd: number | null;
  /** Some sessions (Codex, unknown models) have tokens but no cost estimate. */
  unpricedSessions: boolean;
};

export type LatticeStats = {
  schemaVersion: 1;
  version: string;
  latestVersion: string | null;
  repository: string;
  index: { files: number; bytes: number } | null;
  context: {
    calls: number;
    pages: number;
    bytes: number;
    /** Whole size of the files the served pages came from, for calls that recorded it. */
    fileBytes: number;
    /** `fileBytes` minus what those calls actually sent. */
    savedBytes: number;
  };
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
    contextCharacters: number;
    /** Whole files behind the pages of tasks that recorded them, minus the pages. */
    prunedBytes: number;
  };
  recentTasks: RecentTask[];
  agents: AgentUsage[];
  integrations: { claude: boolean; codex: boolean | null };
  estimates: StatsEstimates;
};

/** One project in the view across all repositories. */
export type ProjectStats = { name: string; stats: LatticeStats };

const RECENT_TASKS = 10;

/** Rough size of a token for `lattice stats`; provider tokenizers differ. */
export const BYTES_PER_TOKEN = 4;

/**
 * Append one context-serving event for `lattice stats`. Only counts are kept,
 * never paths or content. Best effort: statistics must never fail a tool call.
 */
export function recordContextUsage(
  repositoryRoot: string,
  entry: { tool: string; pages: number; bytes: number; fileBytes?: number },
) {
  rememberRepository(repositoryRoot);
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
  const totals = { calls: 0, pages: 0, bytes: 0, fileBytes: 0, savedBytes: 0 };
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
        // Entries written before file sizes were recorded have no baseline.
        if (typeof entry.fileBytes === 'number' && Number.isFinite(entry.fileBytes)) {
          totals.fileBytes += entry.fileBytes;
          totals.savedBytes += Math.max(0, entry.fileBytes - numberOrZero(entry.bytes));
        }
      } catch {
        // Skip a torn line from an interrupted write.
      }
    }
  }
  return totals;
}

/** A short, readable task name such as `fix-reset-token` from its goal text. */
const FILLER_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'that', 'this', 'it', 'with', 'from', 'by', 'is',
  'и', 'в', 'на', 'с', 'к', 'по', 'для', 'что', 'чтобы', 'из', 'у', 'о', 'це', 'що', 'та', 'й', 'з', 'до',
]);

export function taskName(goal: unknown, fallback: string) {
  if (typeof goal !== 'string') return fallback;
  const words = goal
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '' && !FILLER_WORDS.has(word));
  const slug = words.slice(0, 4).join('-');
  return (slug || fallback).slice(0, 28);
}

/** The first line of the error without the provider's generic wrapper text. */
function failureReason(task: Record<string, unknown>, telemetry: Record<string, unknown>) {
  const reason = [task.error, telemetry.rejectedEditGrantReason, telemetry.terminalStateReason].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  if (!reason) return null;
  return reason
    .split(/\r?\n/)[0]
    .replace(/^(Claude Code|Codex) returned an error result:\s*/i, '')
    .slice(0, 60);
}

function taskTotals(base: string) {
  const recent: RecentTask[] = [];
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
    contextCharacters: 0,
    prunedBytes: 0,
  };
  const directory = join(base, 'tasks');
  if (!existsSync(directory)) return { totals, recent };
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
    totals.contextCharacters += numberOrZero(telemetry.loadedContextCharacters);
    if (typeof telemetry.sourceFileBytes === 'number') {
      totals.prunedBytes += Math.max(
        0,
        telemetry.sourceFileBytes - numberOrZero(telemetry.loadedContextCharacters),
      );
    }
    if (telemetry.verifiedPatchCacheHit === true) totals.verifiedCacheHits += 1;
    const transitions = Array.isArray(telemetry.runtimeStateTransitions)
      ? (telemetry.runtimeStateTransitions as { at?: unknown }[])
      : [];
    const last = transitions.at(-1)?.at;
    const at = typeof last === 'string' ? last : statSync(path).mtime.toISOString();
    if (!totals.lastTaskAt || at > totals.lastTaskAt) totals.lastTaskAt = at;
    const nested = (task.task ?? {}) as Record<string, unknown>;
    const status = task.status === 'passed' || task.status === 'failed' ? task.status : 'other';
    recent.push({
      name: taskName(task.goal ?? nested.goal, String(task.taskId ?? name).slice(0, 8)),
      status,
      files:
        numberOrZero(telemetry.changedFileCount) ||
        (Array.isArray((task.lastRejectedAttempt as { changedFiles?: unknown } | undefined)?.changedFiles)
          ? ((task.lastRejectedAttempt as { changedFiles: unknown[] }).changedFiles.length)
          : 0),
      verificationMs:
        typeof telemetry.verificationDurationMs === 'number' ? telemetry.verificationDurationMs : null,
      reason: status === 'passed' ? null : failureReason(task, telemetry),
      at,
    });
  }
  recent.sort((left, right) => right.at.localeCompare(left.at));
  return { totals, recent: recent.slice(0, RECENT_TASKS) };
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

export function estimate(stats: Omit<LatticeStats, 'estimates'>): StatsEstimates {
  const prunedBytes = stats.context.savedBytes + stats.tasks.prunedBytes;
  const prunedTokens = Math.round(prunedBytes / BYTES_PER_TOKEN);
  let costUsd = stats.tasks.costUsd;
  let pricedTokens = 0;
  let pricedUsd = 0;
  let unpricedSessions = false;
  for (const group of stats.agents) {
    if (group.estimatedCostUsd !== null) costUsd += group.estimatedCostUsd;
    pricedTokens += group.pricedInputTokens;
    pricedUsd += group.pricedInputUsd;
    if (group.inputTokens > group.pricedInputTokens) unpricedSessions = true;
  }
  // Prefer the sessions' own model mix; otherwise the tasks' effective rate.
  const inputPrice =
    pricedTokens > 0
      ? pricedUsd / pricedTokens
      : stats.tasks.costUsd > 0 && stats.tasks.inputTokens > 0
        ? stats.tasks.costUsd / stats.tasks.inputTokens
        : null;
  return {
    prunedBytes,
    prunedTokens,
    costUsd,
    savedUsd: inputPrice === null ? null : prunedTokens * inputPrice,
    unpricedSessions,
  };
}

/** Read-only: nothing is created in `repositoryRoot`. */
export function collectStats(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  sessions?: SessionRecord[],
): LatticeStats {
  const base = join(repositoryRoot, '.lattice');
  const tasks = taskTotals(base);
  const stats = {
    schemaVersion: 1 as const,
    version: LATTICE_VERSION,
    latestVersion: readUserSettings(env).lastUpdateCheck?.latestVersion ?? null,
    repository: repositoryRoot,
    index: indexTotals(base),
    context: contextUsage(base),
    tasks: tasks.totals,
    recentTasks: tasks.recent,
    agents: collectAgentSessions(repositoryRoot, env, sessions),
    integrations: {
      claude: readClaudeIntegrationState(repositoryRoot) !== null,
      codex: codexEnabled(env),
    },
  };
  return { ...stats, estimates: estimate(stats) };
}

/** Sums several projects into one view; `repository` is empty. */
export function combineStats(projects: ProjectStats[], env: NodeJS.ProcessEnv = process.env): LatticeStats {
  const sum = <K extends string>(items: Record<K, unknown>[], keys: K[]) => {
    const total = {} as Record<K, number>;
    for (const key of keys) {
      total[key] = 0;
      for (const item of items) total[key] += numberOrZero(item[key]);
    }
    return total;
  };
  const all = projects.map((project) => project.stats);
  const indexes = all.flatMap((stats) => (stats.index ? [stats.index] : []));
  const agents = new Map<string, AgentUsage>();
  for (const group of all.flatMap((stats) => stats.agents)) {
    const key = `${group.agent}:${group.surface}`;
    const current = agents.get(key);
    if (!current) {
      agents.set(key, { ...group });
      continue;
    }
    current.sessions += group.sessions;
    current.inputTokens += group.inputTokens;
    current.cachedInputTokens += group.cachedInputTokens;
    current.outputTokens += group.outputTokens;
    current.pricedInputTokens += group.pricedInputTokens;
    current.pricedInputUsd += group.pricedInputUsd;
    if (group.estimatedCostUsd !== null) {
      current.estimatedCostUsd = (current.estimatedCostUsd ?? 0) + group.estimatedCostUsd;
    }
    if (group.lastAt && (!current.lastAt || group.lastAt > current.lastAt)) current.lastAt = group.lastAt;
  }
  const lastTaskAt = all
    .map((stats) => stats.tasks.lastTaskAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);
  const stats = {
    schemaVersion: 1 as const,
    version: LATTICE_VERSION,
    latestVersion: readUserSettings(env).lastUpdateCheck?.latestVersion ?? null,
    repository: '',
    index: indexes.length > 0 ? sum(indexes, ['files', 'bytes']) : null,
    context: sum(
      all.map((stats) => stats.context),
      ['calls', 'pages', 'bytes', 'fileBytes', 'savedBytes'],
    ),
    tasks: {
      ...sum(
        all.map((stats) => stats.tasks),
        [
          'total',
          'passed',
          'failed',
          'other',
          'inputTokens',
          'cachedInputTokens',
          'outputTokens',
          'costUsd',
          'verifiedCacheHits',
          'contextCharacters',
          'prunedBytes',
        ],
      ),
      lastTaskAt: lastTaskAt ?? null,
    },
    recentTasks: projects
      .flatMap((project) => project.stats.recentTasks.map((task) => ({ ...task, project: project.name })))
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, RECENT_TASKS),
    agents: [...agents.values()].sort((left, right) => right.inputTokens - left.inputTokens),
    integrations: {
      claude: all.some((stats) => stats.integrations.claude),
      codex: all.find((stats) => stats.integrations.codex !== null)?.integrations.codex ?? null,
    },
  };
  return { ...stats, estimates: estimate(stats) };
}

/**
 * Every project Lattice knows: remembered repositories and the directories of
 * agent sessions that hold Lattice state. Session logs are read once.
 */
export function collectAllProjects(env: NodeJS.ProcessEnv = process.env): ProjectStats[] {
  const sessions = scanAgentSessions(env);
  const roots = discoverRepositories(
    sessions.map((session) => session.cwd),
    env,
  );
  const names = new Map<string, number>();
  for (const root of roots) names.set(basename(root), (names.get(basename(root)) ?? 0) + 1);
  return roots
    .map((root) => ({
      // Two projects with the same folder name show their parent too.
      name: (names.get(basename(root)) ?? 0) > 1 ? `${basename(join(root, '..'))}/${basename(root)}` : basename(root),
      stats: collectStats(root, env, sessions),
    }))
    .sort(
      (left, right) =>
        right.stats.tasks.total - left.stats.tasks.total ||
        activity(right.stats) - activity(left.stats) ||
        left.name.localeCompare(right.name),
    );
}

function activity(stats: LatticeStats) {
  return stats.agents.reduce((sum, group) => sum + group.inputTokens, stats.tasks.inputTokens);
}

const SURFACE_KEYS: Record<AgentUsage['surface'], MessageKey> = {
  desktop: 'surfaceDesktop',
  cli: 'surfaceCli',
  ide: 'surfaceIde',
  other: 'surfaceOther',
};

/** For example "Claude Code · desktop" or "Codex · terminal". */
export function agentLabel(group: Pick<AgentUsage, 'agent' | 'surface'>, language: Language) {
  const agent = group.agent === 'claude-code' ? 'Claude Code' : 'Codex';
  return `${agent} · ${translate(language, SURFACE_KEYS[group.surface])}`;
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

/**
 * The `lattice stats` report. With `projects`, `stats` is their sum and the
 * report lists each project instead of one repository path.
 */
export function formatStats(stats: LatticeStats, language: Language, projects?: ProjectStats[]) {
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
  if (projects) {
    lines.push('', t('statsProjectsTitle', { count: number(projects.length) }));
    if (projects.length === 0) {
      lines.push(`  ${t('statsNoProjects')}`);
      return lines.join('\n');
    }
    for (const project of projects) {
      row(
        project.name,
        t('statsProjectValue', {
          tasks: taskCount(language, project.stats.tasks.total),
          tokens: number(
            project.stats.agents.reduce((sum, group) => sum + group.inputTokens, project.stats.tasks.inputTokens),
          ),
          pruned: number(project.stats.estimates.prunedTokens),
        }),
      );
    }
    lines.push('', t('statsAllProjects'));
  } else {
    row(t('statsRepository'), stats.repository);
  }
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
    if (stats.context.fileBytes > 0) {
      lines.push(
        `  ${t('statsSavings', {
          saved: formatBytes(stats.context.savedBytes, language),
          files: formatBytes(stats.context.fileBytes, language),
          share: new Intl.NumberFormat(language, {
            style: 'percent',
            maximumFractionDigits: 1,
          }).format(stats.context.savedBytes / stats.context.fileBytes),
          tokens: number(Math.round(stats.context.savedBytes / BYTES_PER_TOKEN)),
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

  lines.push('', t(projects ? 'statsSessionsAllTitle' : 'statsSessionsTitle'));
  if (stats.agents.length === 0) {
    lines.push(`  ${t('statsNone')}`);
  } else {
    for (const group of stats.agents) {
      row(
        agentLabel(group, language),
        t('statsSessionsValue', {
          sessions: sessionCount(language, group.sessions),
          input: number(group.inputTokens),
          cached: number(group.cachedInputTokens),
          output: number(group.outputTokens),
        }),
      );
    }
    lines.push(`  ${t('statsSessionsNoCost')}`);
  }

  const estimates = stats.estimates;
  if (estimates.prunedTokens > 0 || estimates.costUsd > 0) {
    const usd = (value: number) =>
      new Intl.NumberFormat(language, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 4,
      }).format(value);
    lines.push('', t('statsEstimatesTitle'));
    lines.push(
      `  ${t('statsPruned', {
        tokens: number(estimates.prunedTokens),
        size: formatBytes(estimates.prunedBytes, language),
      })}`,
    );
    lines.push(`  ${t('statsEstCost', { cost: usd(estimates.costUsd) })}`);
    if (estimates.savedUsd !== null) {
      lines.push(`  ${t('statsSavedUsd', { amount: usd(estimates.savedUsd) })}`);
    }
    if (estimates.unpricedSessions) lines.push(`  ${t('statsUnpriced')}`);
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
