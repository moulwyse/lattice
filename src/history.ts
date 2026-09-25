import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  claudeProjectsDirectory,
  claudeSurface,
  codexSessionsDirectory,
  codexSurface,
  jsonLines,
  logFiles,
  type AgentUsage,
} from './agent-sessions.js';
import { claudeInputPrice, claudeMessageCost, type ClaudeUsage } from './pricing.js';
import { discoverRepositories } from './repositories.js';
import { sourceFileBytes } from './source-bytes.js';
import { BYTES_PER_TOKEN, failureReason, taskName } from './stats.js';

/**
 * One task in the history: an ordinary Claude Code or Codex chat, or a
 * `lattice run` task. Savings compare what Lattice sent with the whole files
 * its pages came from; chats are read back from the agents' own logs, so
 * chats from before this version count too.
 */
export type HistoryEntry = {
  id: string;
  kind: 'chat' | 'task';
  agent: 'claude-code' | 'codex' | 'lattice';
  surface: AgentUsage['surface'] | null;
  title: string;
  project: string;
  root: string;
  startedAt: string;
  endedAt: string;
  model: string | null;
  status: 'passed' | 'failed' | 'other' | null;
  tokens: { input: number; cached: number; output: number };
  /** Provider-reported for tasks, list-price estimate for Claude Code chats. */
  costUsd: number | null;
  lattice: {
    /** Lattice context requests in a chat, loaded pages in a task. */
    calls: number;
    pages: number;
    files: number;
    sentBytes: number;
    fileBytes: number;
    savedBytes: number;
  };
  savedTokens: number;
  savedUsd: number | null;
  changedFiles: number | null;
  verificationMs: number | null;
  reason: string | null;
};

export type HistoryTotals = {
  entries: number;
  withLattice: number;
  chats: number;
  tasks: { total: number; passed: number; failed: number; other: number };
  sentBytes: number;
  fileBytes: number;
  savedBytes: number;
  savedTokens: number;
  savedUsd: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

const LATTICE_TOOL = /lattice_(?:search|read)_context$/;
const TITLE_LENGTH = 80;

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function emptyLattice(): HistoryEntry['lattice'] {
  return { calls: 0, pages: 0, files: 0, sentBytes: 0, fileBytes: 0, savedBytes: 0 };
}

/** The repository a directory belongs to: the nearest folder with Git or Lattice state. */
function projectRoot(directory: string, cache: Map<string, string>) {
  const start = resolve(directory);
  const cached = cache.get(start);
  if (cached) return cached;
  let current = start;
  let root = start;
  for (;;) {
    if (existsSync(join(current, '.git')) || existsSync(join(current, '.lattice'))) {
      root = current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  cache.set(start, root);
  return root;
}

/** Short one-line title from a prompt; system-injected text starts with `<`. */
function titleFrom(text: unknown) {
  if (typeof text !== 'string') return null;
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line || line.startsWith('<') || line.startsWith('[Image')) return null;
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}

function promptText(content: unknown) {
  if (typeof content === 'string') return titleFrom(content);
  if (!Array.isArray(content)) return null;
  for (const block of content as Record<string, unknown>[]) {
    if (block?.type === 'tool_result') return null;
    const title = titleFrom(block?.text);
    if (title) return title;
  }
  return null;
}

type LatticeResult = { key: string; paths: string[]; bytes: number };

/**
 * Lattice context results anywhere inside a log entry. The MCP result text is
 * JSON with `source: "terra-sidecar"`; agents may wrap it in further JSON
 * strings. `key` is the tool call id when one is in scope, so a result logged
 * twice (Codex writes an event and a response item) counts once.
 */
function latticeResults(value: unknown, key: string | null, found: LatticeResult[], depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (!value.includes('terra-sidecar')) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return;
    }
    const result = parsed as { source?: unknown; pages?: unknown; bytesUsed?: unknown };
    if (result && result.source === 'terra-sidecar' && Array.isArray(result.pages)) {
      found.push({
        key: key ?? createHash('sha256').update(value).digest('hex'),
        paths: (result.pages as { path?: unknown }[])
          .map((page) => page?.path)
          .filter((path): path is string => typeof path === 'string'),
        bytes: number(result.bytesUsed),
      });
      return;
    }
    latticeResults(parsed, key, found, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) latticeResults(item, key, found, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = record.tool_use_id ?? record.call_id;
    const scope = typeof id === 'string' && id !== '' ? id : key;
    for (const item of Object.values(record)) latticeResults(item, scope, found, depth + 1);
  }
}

/** Adds the unique results of one chat to its Lattice totals. */
function addLatticeResults(entry: HistoryEntry, results: LatticeResult[]) {
  const seen = new Set<string>();
  const files = new Set<string>();
  for (const result of results) {
    if (seen.has(result.key)) continue;
    seen.add(result.key);
    entry.lattice.calls += 1;
    entry.lattice.pages += result.paths.length;
    entry.lattice.sentBytes += result.bytes;
    const whole = sourceFileBytes(entry.root, result.paths);
    // A deleted or moved repository has no baseline: count what was sent only.
    if (whole > 0) {
      entry.lattice.fileBytes += whole;
      entry.lattice.savedBytes += Math.max(0, whole - result.bytes);
    }
    for (const path of result.paths) files.add(path);
  }
  entry.lattice.files = files.size;
}

function newChat(
  id: string,
  agent: 'claude-code' | 'codex',
  cwd: string,
  roots: Map<string, string>,
  at: string,
): HistoryEntry {
  const root = projectRoot(cwd, roots);
  return {
    id,
    kind: 'chat',
    agent,
    surface: null,
    title: '',
    project: basename(root) || root,
    root,
    startedAt: at,
    endedAt: at,
    model: null,
    status: null,
    tokens: { input: 0, cached: 0, output: 0 },
    costUsd: null,
    lattice: emptyLattice(),
    savedTokens: 0,
    savedUsd: null,
    changedFiles: null,
    verificationMs: null,
    reason: null,
  };
}

function touch(entry: HistoryEntry, at: unknown) {
  if (typeof at !== 'string') return;
  if (at < entry.startedAt) entry.startedAt = at;
  if (at > entry.endedAt) entry.endedAt = at;
}

/** Lattice's own worktrees and SDK automation are tasks, not chats. */
const isLatticeWorktree = (cwd: string) => /[\\/]\.lattice[\\/]/.test(cwd);

function claudeChats(env: NodeJS.ProcessEnv, roots: Map<string, string>) {
  const chats: HistoryEntry[] = [];
  for (const path of logFiles(claudeProjectsDirectory(env), '.jsonl')) {
    let chat: HistoryEntry | null = null;
    let automated = false;
    const seen = new Set<string>();
    const results: LatticeResult[] = [];
    let title: string | null = null;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      // Parse only the lines that matter: prompts, usage and Lattice results.
      const wanted =
        (!title && line.includes('"user"')) || line.includes('"usage"') || line.includes('terra-sidecar');
      if (!wanted) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : '';
      if (!cwd) continue;
      if (claudeSurface(entry.entrypoint) === null || isLatticeWorktree(cwd)) {
        automated = true;
        break;
      }
      const at = typeof entry.timestamp === 'string' ? entry.timestamp : statSync(path).mtime.toISOString();
      chat ??= newChat(`claude:${path}`, 'claude-code', cwd, roots, at);
      touch(chat, entry.timestamp);
      chat.surface = claudeSurface(entry.entrypoint);
      const message = (entry.message ?? {}) as Record<string, unknown>;
      if (entry.type === 'user') {
        if (!title && entry.isMeta !== true && entry.isSidechain !== true) title = promptText(message.content);
        if (line.includes('terra-sidecar')) latticeResults(message.content, null, results);
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const usage = message.usage as ClaudeUsage | undefined;
      const id = String(message.id ?? entry.requestId ?? entry.uuid ?? '');
      if (!usage || !id || seen.has(id)) continue;
      seen.add(id);
      const cacheRead = number(usage.cache_read_input_tokens);
      chat.tokens.input += number(usage.input_tokens) + number(usage.cache_creation_input_tokens) + cacheRead;
      chat.tokens.cached += cacheRead;
      chat.tokens.output += number(usage.output_tokens);
      if (typeof message.model === 'string' && !message.model.startsWith('<')) chat.model = message.model;
      const cost = claudeMessageCost(message.model, usage);
      if (cost !== null) chat.costUsd = (chat.costUsd ?? 0) + cost;
    }
    if (!chat || automated || (chat.tokens.input === 0 && !title)) continue;
    chat.title = title ?? basename(path, '.jsonl').slice(0, 8);
    addLatticeResults(chat, results);
    chat.savedTokens = Math.round(chat.lattice.savedBytes / BYTES_PER_TOKEN);
    const price = claudeInputPrice(chat.model);
    chat.savedUsd = price === null ? null : chat.savedTokens * price;
    chats.push(chat);
  }
  return chats;
}

function codexChats(env: NodeJS.ProcessEnv, roots: Map<string, string>) {
  const chats: HistoryEntry[] = [];
  for (const path of logFiles(codexSessionsDirectory(env), '.jsonl')) {
    const entries = jsonLines(path);
    const meta = entries.find((entry) => entry.type === 'session_meta')?.payload as
      | Record<string, unknown>
      | undefined;
    if (!meta || typeof meta.cwd !== 'string' || meta.cwd === '' || isLatticeWorktree(meta.cwd)) continue;
    const at = typeof meta.timestamp === 'string' ? meta.timestamp : statSync(path).mtime.toISOString();
    const chat = newChat(`codex:${path}`, 'codex', meta.cwd, roots, at);
    chat.surface = codexSurface(meta.originator);
    const results: LatticeResult[] = [];
    let title: string | null = null;
    for (const entry of entries) {
      touch(chat, entry.timestamp);
      const payload = (entry.payload ?? {}) as Record<string, unknown>;
      if (entry.type === 'turn_context' && typeof payload.model === 'string') chat.model = payload.model;
      if (!title && payload.type === 'message' && payload.role === 'user') title = promptText(payload.content);
      if (!title && payload.type === 'user_message') title = titleFrom(payload.message);
      if (payload.type === 'token_count') {
        const usage = (payload.info as Record<string, unknown> | null | undefined)?.total_token_usage as
          | Record<string, unknown>
          | undefined;
        if (usage) {
          chat.tokens = {
            input: number(usage.input_tokens),
            cached: number(usage.cached_input_tokens),
            output: number(usage.output_tokens),
          };
        }
      }
      latticeResults(payload, null, results);
    }
    if (chat.tokens.input === 0 && !title) continue;
    chat.title = title ?? basename(path, '.jsonl').slice(-8);
    addLatticeResults(chat, results);
    chat.savedTokens = Math.round(chat.lattice.savedBytes / BYTES_PER_TOKEN);
    chats.push(chat);
  }
  return chats;
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function latticeTasks(root: string) {
  const directory = join(root, '.lattice', 'tasks');
  if (!existsSync(directory)) return [];
  const tasks: HistoryEntry[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    const task = readJson(path);
    if (!task || typeof task.status !== 'string') continue;
    const telemetry = (task.telemetry ?? {}) as Record<string, unknown>;
    const transitions = Array.isArray(telemetry.runtimeStateTransitions)
      ? (telemetry.runtimeStateTransitions as { at?: unknown }[])
      : [];
    const fallback = statSync(path).mtime.toISOString();
    const first = transitions[0]?.at;
    const last = transitions.at(-1)?.at;
    const nested = (task.task ?? {}) as Record<string, unknown>;
    const goal = typeof task.goal === 'string' ? task.goal : typeof nested.goal === 'string' ? nested.goal : null;
    const status = task.status === 'passed' || task.status === 'failed' ? task.status : 'other';
    const input = number(telemetry.modelInputTokens);
    const cost = typeof telemetry.costUsd === 'number' ? telemetry.costUsd : null;
    const sent = number(telemetry.loadedContextCharacters);
    const whole = number(telemetry.sourceFileBytes);
    const savedBytes = whole > 0 ? Math.max(0, whole - sent) : 0;
    const savedTokens = Math.round(savedBytes / BYTES_PER_TOKEN);
    const model = typeof task.model === 'string' ? task.model : null;
    const rate = cost !== null && cost > 0 && input > 0 ? cost / input : claudeInputPrice(model);
    const rejected = task.lastRejectedAttempt as { changedFiles?: unknown } | undefined;
    tasks.push({
      id: `task:${path}`,
      kind: 'task',
      agent: 'lattice',
      surface: null,
      title: titleFrom(goal) ?? taskName(goal, String(task.taskId ?? name).slice(0, 8)),
      project: basename(root),
      root,
      startedAt: typeof first === 'string' ? first : fallback,
      endedAt: typeof last === 'string' ? last : fallback,
      model,
      status,
      tokens: { input, cached: number(telemetry.cachedInputTokens), output: number(telemetry.outputTokens) },
      costUsd: cost,
      lattice: {
        calls: number(telemetry.workerTurns),
        pages: number(telemetry.loadedPageCount),
        files: number(telemetry.loadedPageCount),
        sentBytes: sent,
        fileBytes: whole,
        savedBytes,
      },
      savedTokens,
      savedUsd: rate === null ? null : savedTokens * rate,
      changedFiles:
        number(telemetry.changedFileCount) ||
        (Array.isArray(rejected?.changedFiles) ? rejected.changedFiles.length : 0),
      verificationMs: typeof telemetry.verificationDurationMs === 'number' ? telemetry.verificationDurationMs : null,
      reason: status === 'passed' ? null : failureReason(task, telemetry),
    });
  }
  return tasks;
}

/** Every chat and `lattice run` task on this machine, newest first. */
export function collectHistory(env: NodeJS.ProcessEnv = process.env): HistoryEntry[] {
  const roots = new Map<string, string>();
  let chats: HistoryEntry[] = [];
  try {
    chats = [...claudeChats(env, roots), ...codexChats(env, roots)];
  } catch {
    chats = [];
  }
  const projects = discoverRepositories(
    chats.map((chat) => chat.root),
    env,
  );
  const tasks = projects.flatMap((root) => {
    try {
      return latticeTasks(root);
    } catch {
      return [];
    }
  });
  return [...chats, ...tasks].sort((left, right) => right.endedAt.localeCompare(left.endedAt));
}

export function historyTotals(entries: HistoryEntry[]): HistoryTotals {
  const totals: HistoryTotals = {
    entries: entries.length,
    withLattice: 0,
    chats: 0,
    tasks: { total: 0, passed: 0, failed: 0, other: 0 },
    sentBytes: 0,
    fileBytes: 0,
    savedBytes: 0,
    savedTokens: 0,
    savedUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  for (const entry of entries) {
    if (entry.kind === 'chat') totals.chats += 1;
    else {
      totals.tasks.total += 1;
      totals.tasks[entry.status ?? 'other'] += 1;
    }
    if (entry.lattice.calls > 0 || entry.lattice.pages > 0) totals.withLattice += 1;
    totals.sentBytes += entry.lattice.sentBytes;
    totals.fileBytes += entry.lattice.fileBytes;
    totals.savedBytes += entry.lattice.savedBytes;
    totals.savedTokens += entry.savedTokens;
    totals.savedUsd += entry.savedUsd ?? 0;
    totals.inputTokens += entry.tokens.input;
    totals.outputTokens += entry.tokens.output;
    totals.costUsd += entry.costUsd ?? 0;
  }
  return totals;
}
