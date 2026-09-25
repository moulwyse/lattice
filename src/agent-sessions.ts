import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Token usage of ordinary Claude Code and Codex sessions (desktop app, CLI
 * or IDE) in one repository, read from the session logs both agents keep on
 * disk. Neither log records cost, so only tokens are counted.
 */
export type AgentUsage = {
  agent: 'claude-code' | 'codex';
  surface: 'desktop' | 'cli' | 'ide' | 'other';
  sessions: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  lastAt: string | null;
};

type SessionTotals = Omit<AgentUsage, 'sessions'>;

function normalized(path: string) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** The session ran in the repository or one of its subdirectories. */
function insideRepository(cwd: unknown, repositoryRoot: string) {
  if (typeof cwd !== 'string' || cwd === '') return false;
  const root = normalized(repositoryRoot);
  const directory = normalized(cwd);
  return directory === root || directory.startsWith(`${root}${sep}`);
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function jsonLines(path: string) {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const values: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A session that is still being written can end in a partial line.
    }
  }
  return values;
}

function files(directory: string, suffix: string, depth = 4): string[] {
  if (depth < 0 || !existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...files(path, suffix, depth - 1));
    else if (entry.name.endsWith(suffix)) found.push(path);
  }
  return found;
}

function claudeSurface(entrypoint: unknown): AgentUsage['surface'] | null {
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (entrypoint === 'cli') return 'cli';
  if (typeof entrypoint === 'string' && /vscode|jetbrains|ide/i.test(entrypoint)) return 'ide';
  // SDK sessions are automation, including Lattice's own Claude worker, whose
  // usage is already counted with its task.
  if (typeof entrypoint === 'string' && entrypoint.startsWith('sdk')) return null;
  return 'other';
}

/**
 * Claude Code writes one JSONL transcript per session under
 * `<config>/projects/<encoded cwd>/`. An assistant message is logged once per
 * content block with the same usage, so usage is counted once per message id.
 */
function claudeSessions(repositoryRoot: string, env: NodeJS.ProcessEnv) {
  const base = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  if (!existsSync(base)) return [];
  const prefix = resolve(repositoryRoot).replace(/[^A-Za-z0-9]/g, '-').toLowerCase();
  const sessions: SessionTotals[] = [];
  for (const project of readdirSync(base, { withFileTypes: true })) {
    if (!project.isDirectory() || !project.name.toLowerCase().startsWith(prefix)) continue;
    for (const path of files(join(base, project.name), '.jsonl')) {
      const seen = new Set<string>();
      const totals: SessionTotals = {
        agent: 'claude-code',
        surface: 'other',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        lastAt: null,
      };
      let counted = false;
      for (const entry of jsonLines(path)) {
        if (entry.type !== 'assistant' || !insideRepository(entry.cwd, repositoryRoot)) continue;
        const surface = claudeSurface(entry.entrypoint);
        if (!surface) continue;
        const message = (entry.message ?? {}) as Record<string, unknown>;
        const usage = message.usage as Record<string, unknown> | undefined;
        const id = String(message.id ?? entry.requestId ?? entry.uuid ?? '');
        if (!usage || !id || seen.has(id)) continue;
        seen.add(id);
        counted = true;
        totals.surface = surface;
        const cacheRead = number(usage.cache_read_input_tokens);
        totals.inputTokens +=
          number(usage.input_tokens) + number(usage.cache_creation_input_tokens) + cacheRead;
        totals.cachedInputTokens += cacheRead;
        totals.outputTokens += number(usage.output_tokens);
        if (typeof entry.timestamp === 'string' && (!totals.lastAt || entry.timestamp > totals.lastAt)) {
          totals.lastAt = entry.timestamp;
        }
      }
      if (counted) sessions.push(totals);
    }
  }
  return sessions;
}

function codexSurface(originator: unknown): AgentUsage['surface'] {
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
function codexSessions(repositoryRoot: string, env: NodeJS.ProcessEnv) {
  const base = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const sessions: SessionTotals[] = [];
  for (const path of files(base, '.jsonl')) {
    const entries = jsonLines(path);
    const meta = entries.find((entry) => entry.type === 'session_meta')?.payload as
      | Record<string, unknown>
      | undefined;
    if (!meta || !insideRepository(meta.cwd, repositoryRoot)) continue;
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
    sessions.push({
      agent: 'codex',
      surface: codexSurface(meta.originator),
      inputTokens: number(total.input_tokens),
      cachedInputTokens: number(total.cached_input_tokens),
      outputTokens: number(total.output_tokens),
      lastAt: lastAt ?? (typeof meta.timestamp === 'string' ? meta.timestamp : statSync(path).mtime.toISOString()),
    });
  }
  return sessions;
}

/** Totals per agent and surface, largest first. Unreadable logs are skipped. */
export function collectAgentSessions(
  repositoryRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentUsage[] {
  const groups = new Map<string, AgentUsage>();
  let sessions: SessionTotals[] = [];
  try {
    sessions = [...claudeSessions(repositoryRoot, env), ...codexSessions(repositoryRoot, env)];
  } catch {
    return [];
  }
  for (const session of sessions) {
    const key = `${session.agent}:${session.surface}`;
    const group = groups.get(key) ?? {
      agent: session.agent,
      surface: session.surface,
      sessions: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      lastAt: null,
    };
    group.sessions += 1;
    group.inputTokens += session.inputTokens;
    group.cachedInputTokens += session.cachedInputTokens;
    group.outputTokens += session.outputTokens;
    if (session.lastAt && (!group.lastAt || session.lastAt > group.lastAt)) group.lastAt = session.lastAt;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.inputTokens - left.inputTokens);
}
