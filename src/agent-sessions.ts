import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { claudeInputPrice, claudeMessageCost, type ClaudeUsage } from './pricing.js';

/**
 * Token usage of ordinary Claude Code and Codex sessions (desktop app, CLI
 * or IDE), read from the session logs both agents keep on disk. Neither log
 * records cost: Claude Code cost is estimated from list prices per model, and
 * Codex sessions have no cost estimate.
 */
export type AgentUsage = {
  agent: 'claude-code' | 'codex';
  surface: 'desktop' | 'cli' | 'ide' | 'other';
  sessions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Estimated from list prices; null when no message had a priced model. */
  estimatedCostUsd: number | null;
  /** Input tokens of priced messages and their value at the uncached input price. */
  pricedInputTokens: number;
  pricedInputUsd: number;
  lastAt: string | null;
};

/** One session's usage in one working directory. */
export type SessionRecord = Omit<AgentUsage, 'sessions'> & { id: string; cwd: string };

function normalized(path: string) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** `path` is the directory or one of its subdirectories. */
export function insideDirectory(path: unknown, directory: string) {
  if (typeof path !== 'string' || path === '') return false;
  const root = normalized(directory);
  const value = normalized(path);
  return value === root || value.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Parsed JSONL entries; `mustContain` skips unrelated lines before parsing. */
export function jsonLines(path: string, mustContain?: string) {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const values: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || (mustContain && !line.includes(mustContain))) continue;
    try {
      values.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A session that is still being written can end in a partial line.
    }
  }
  return values;
}

export function logFiles(directory: string, suffix: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(directory)) return [];
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...logFiles(path, suffix, depth - 1));
    else if (entry.name.endsWith(suffix)) found.push(path);
  }
  return found;
}

export function claudeSurface(entrypoint: unknown): AgentUsage['surface'] | null {
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (entrypoint === 'cli') return 'cli';
  if (typeof entrypoint === 'string' && /vscode|jetbrains|ide/i.test(entrypoint)) return 'ide';
  // SDK sessions are automation, including Lattice's own Claude worker, whose
  // usage is already counted with its task.
  if (typeof entrypoint === 'string' && entrypoint.startsWith('sdk')) return null;
  return 'other';
}

function emptyRecord(agent: AgentUsage['agent'], id: string, cwd: string): SessionRecord {
  return {
    id,
    cwd,
    agent,
    surface: 'other',
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: null,
    pricedInputTokens: 0,
    pricedInputUsd: 0,
    lastAt: null,
  };
}

/**
 * Claude Code writes one JSONL transcript per session under
 * `<config>/projects/<encoded cwd>/`. An assistant message is logged once per
 * content block with the same usage, so usage is counted once per message id.
 * A session that moved between directories yields one record per directory.
 */
function claudeSessions(env: NodeJS.ProcessEnv) {
  const base = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  const records: SessionRecord[] = [];
  for (const path of logFiles(base, '.jsonl')) {
    const seen = new Set<string>();
    const byDirectory = new Map<string, SessionRecord>();
    for (const entry of jsonLines(path, '"assistant"')) {
      if (entry.type !== 'assistant' || typeof entry.cwd !== 'string' || entry.cwd === '') continue;
      const surface = claudeSurface(entry.entrypoint);
      if (!surface) continue;
      const message = (entry.message ?? {}) as Record<string, unknown>;
      const usage = message.usage as ClaudeUsage | undefined;
      const id = String(message.id ?? entry.requestId ?? entry.uuid ?? '');
      if (!usage || !id || seen.has(id)) continue;
      seen.add(id);
      const record = byDirectory.get(entry.cwd) ?? emptyRecord('claude-code', path, entry.cwd);
      byDirectory.set(entry.cwd, record);
      record.surface = surface;
      const cacheRead = number(usage.cache_read_input_tokens);
      const input =
        number(usage.input_tokens) + number(usage.cache_creation_input_tokens) + cacheRead;
      record.inputTokens += input;
      record.cachedInputTokens += cacheRead;
      record.outputTokens += number(usage.output_tokens);
      const cost = claudeMessageCost(message.model, usage);
      if (cost !== null) {
        record.estimatedCostUsd = (record.estimatedCostUsd ?? 0) + cost;
        record.pricedInputTokens += input;
        record.pricedInputUsd += input * (claudeInputPrice(message.model) ?? 0);
      }
      if (typeof entry.timestamp === 'string' && (!record.lastAt || entry.timestamp > record.lastAt)) {
        record.lastAt = entry.timestamp;
      }
    }
    records.push(...byDirectory.values());
  }
  return records;
}

export function codexSurface(originator: unknown): AgentUsage['surface'] {
  if (typeof originator !== 'string') return 'other';
  if (/desktop/i.test(originator)) return 'desktop';
  if (/vscode|jetbrains|ide/i.test(originator)) return 'ide';
  if (/cli|exec/i.test(originator)) return 'cli';
  return 'other';
}

/**
 * Codex writes `sessions/YYYY/MM/DD/rollout-*.jsonl`. The first entry holds the
 * session's cwd; `token_count` events carry a running total, so the last one
 * is the session total.
 */
function codexSessions(env: NodeJS.ProcessEnv) {
  const base = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const records: SessionRecord[] = [];
  for (const path of logFiles(base, '.jsonl')) {
    const entries = jsonLines(path);
    const meta = entries.find((entry) => entry.type === 'session_meta')?.payload as
      | Record<string, unknown>
      | undefined;
    if (!meta || typeof meta.cwd !== 'string' || meta.cwd === '') continue;
    let total: Record<string, unknown> | null = null;
    let lastAt: string | null = null;
    for (const entry of entries) {
      const payload = entry.payload as Record<string, unknown> | undefined;
      if (payload?.type !== 'token_count') continue;
      const info = payload.info as Record<string, unknown> | null | undefined;
      const usage = info?.total_token_usage as Record<string, unknown> | undefined;
      if (usage) {
        total = usage;
        if (typeof entry.timestamp === 'string') lastAt = entry.timestamp;
      }
    }
    if (!total) continue;
    records.push({
      ...emptyRecord('codex', path, meta.cwd),
      surface: codexSurface(meta.originator),
      inputTokens: number(total.input_tokens),
      cachedInputTokens: number(total.cached_input_tokens),
      outputTokens: number(total.output_tokens),
      lastAt:
        lastAt ??
        (typeof meta.timestamp === 'string' ? meta.timestamp : statSync(path).mtime.toISOString()),
    });
  }
  return records;
}

export const claudeProjectsDirectory = (env: NodeJS.ProcessEnv) =>
  join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
export const codexSessionsDirectory = (env: NodeJS.ProcessEnv) =>
  join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');

/** Every session record in both agents' logs. Unreadable logs are skipped. */
export function scanAgentSessions(env: NodeJS.ProcessEnv = process.env): SessionRecord[] {
  try {
    return [...claudeSessions(env), ...codexSessions(env)];
  } catch {
    return [];
  }
}

/** Totals per agent and surface for one repository, largest first. */
export function collectAgentSessions(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  records: SessionRecord[] = scanAgentSessions(env),
): AgentUsage[] {
  const groups = new Map<string, AgentUsage & { ids: Set<string> }>();
  for (const record of records) {
    if (!insideDirectory(record.cwd, repositoryRoot)) continue;
    const key = `${record.agent}:${record.surface}`;
    const group = groups.get(key) ?? {
      agent: record.agent,
      surface: record.surface,
      sessions: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      pricedInputTokens: 0,
      pricedInputUsd: 0,
      lastAt: null,
      ids: new Set<string>(),
    };
    group.ids.add(record.id);
    group.sessions = group.ids.size;
    group.inputTokens += record.inputTokens;
    group.cachedInputTokens += record.cachedInputTokens;
    group.outputTokens += record.outputTokens;
    if (record.estimatedCostUsd !== null) {
      group.estimatedCostUsd = (group.estimatedCostUsd ?? 0) + record.estimatedCostUsd;
    }
    group.pricedInputTokens += record.pricedInputTokens;
    group.pricedInputUsd += record.pricedInputUsd;
    if (record.lastAt && (!group.lastAt || record.lastAt > group.lastAt)) group.lastAt = record.lastAt;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ ids: _ids, ...group }) => group)
    .sort((left, right) => right.inputTokens - left.inputTokens);
}
