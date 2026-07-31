import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Readable } from 'node:stream';
import { z } from 'zod';
import { metadata } from './core.js';
import {
  discoverRepository,
  type RepositoryDiscovery,
} from './repository.js';
import { ensureSidecar, type SidecarLease } from './sidecar.js';

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const MAX_ROLLOUT_TAIL_BYTES = 512 * 1024;
const MAX_ROLLOUT_SELECTION_AGE_MS = 60 * 1_000;
export const CODEX_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1_000;

const ReasoningEffortSchema = z.enum([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

const CodexHookInputSchema = z
  .object({
    session_id: z.unknown().optional(),
    cwd: z.unknown().optional(),
    hook_event_name: z.unknown().optional(),
    model: z.unknown().optional(),
    reasoning_effort: z.unknown().optional(),
    model_reasoning_effort: z.unknown().optional(),
    reasoningEffort: z.unknown().optional(),
  })
  .passthrough();

export const CodexSessionModelStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    workspace: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: ReasoningEffortSchema.nullable(),
    hookEvent: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type CodexSessionModelState = z.infer<
  typeof CodexSessionModelStateSchema
>;

export type CodexSessionSyncDependencies = {
  discover(start: string): Promise<RepositoryDiscovery>;
  ensure(workspace: string): Promise<SidecarLease>;
  now(): Date;
  env: NodeJS.ProcessEnv;
};

export function codexSessionModelStatePath(workspace: string) {
  return join(workspace, '.lattice', 'codex-session.json');
}

function atomicState(path: string, value: CodexSessionModelState) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readCodexSessionModelState(
  workspace: string,
  options: { now?: Date; maxAgeMs?: number } = {},
): CodexSessionModelState | null {
  const path = codexSessionModelStatePath(workspace);
  if (!existsSync(path)) return null;
  try {
    const state = CodexSessionModelStateSchema.parse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    const age = (options.now ?? new Date()).getTime() - Date.parse(state.updatedAt);
    if (age < 0 || age > (options.maxAgeMs ?? CODEX_SESSION_MAX_AGE_MS)) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

export async function readCodexHookInput(input: Readable) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_HOOK_INPUT_BYTES) {
      throw new Error(`Codex hook input exceeds ${MAX_HOOK_INPUT_BYTES} bytes`);
    }
    chunks.push(value);
    const buffered = Buffer.concat(chunks).toString('utf8');
    const newline = buffered.indexOf('\n');
    const candidate = newline >= 0 ? buffered.slice(0, newline) : buffered;
    try {
      return JSON.parse(candidate) as unknown;
    } catch (error) {
      if (newline >= 0) throw error;
      // The JSON value may span more than one stream chunk. Keep reading until
      // it becomes complete, but never wait for EOF once it is parseable.
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function topLevelTomlString(raw: string, key: string) {
  const assignment = new RegExp(`^${key}\\s*=\\s*(["'])(.*?)\\1\\s*(?:#.*)?$`);
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line.startsWith('[')) break;
    const match = assignment.exec(line);
    if (match) return match[2];
  }
  return undefined;
}

function codexConfigDefaults(
  workspace: string,
  env: NodeJS.ProcessEnv,
) {
  const paths = [
    join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'),
    join(workspace, '.codex', 'config.toml'),
  ];
  let model: string | undefined;
  let reasoningEffort: z.infer<typeof ReasoningEffortSchema> | undefined;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    model = topLevelTomlString(raw, 'model') ?? model;
    const configuredReasoning = topLevelTomlString(
      raw,
      'model_reasoning_effort',
    );
    const parsedReasoning = ReasoningEffortSchema.safeParse(configuredReasoning);
    if (parsedReasoning.success) reasoningEffort = parsedReasoning.data;
  }
  return { model, reasoningEffort };
}

function sessionDate(sessionId: string) {
  const compact = sessionId.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(compact) || compact[12]?.toLowerCase() !== '7') {
    return null;
  }
  const milliseconds = Number.parseInt(compact.slice(0, 12), 16);
  if (!Number.isSafeInteger(milliseconds)) return null;
  const value = new Date(milliseconds);
  return Number.isNaN(value.getTime()) ? null : value;
}

function datedSessionDirectory(root: string, date: Date, utc: boolean) {
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = utc ? date.getUTCDate() : date.getDate();
  return join(
    root,
    String(year),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  );
}

function findCodexRollout(
  sessionId: string,
  env: NodeJS.ProcessEnv,
  now: Date,
) {
  const codexHome = env.CODEX_HOME ?? join(homedir(), '.codex');
  const sessionsRoot = join(codexHome, 'sessions');
  const dates = [sessionDate(sessionId), now].filter(
    (value): value is Date => value !== null,
  );
  const directories = new Set<string>();
  for (const date of dates) {
    for (const offset of [-1, 0, 1]) {
      const candidate = new Date(date.getTime() + offset * 24 * 60 * 60 * 1_000);
      directories.add(datedSessionDirectory(sessionsRoot, candidate, true));
      directories.add(datedSessionDirectory(sessionsRoot, candidate, false));
    }
  }
  directories.add(join(codexHome, 'archived_sessions'));
  const suffix = `-${sessionId}.jsonl`;
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    try {
      const filename = readdirSync(directory).find((name) => name.endsWith(suffix));
      if (filename) return join(directory, filename);
    } catch {
      // Session logs are an optional precision source. Config fallback remains
      // available if Codex is rotating a directory while this hook runs.
    }
  }
  return null;
}

function readTail(path: string) {
  const descriptor = openSync(path, 'r');
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, MAX_ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function codexRolloutReasoningEffort(
  sessionId: string,
  model: string,
  env: NodeJS.ProcessEnv,
  now: Date,
) {
  const path = findCodexRollout(sessionId, env, now);
  if (!path) return undefined;
  try {
    const lines = readTail(path).split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as {
          timestamp?: unknown;
          type?: unknown;
          payload?: { model?: unknown; effort?: unknown };
        };
        if (entry.type !== 'turn_context' || entry.payload?.model !== model) {
          continue;
        }
        const timestamp =
          typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
        const age = now.getTime() - timestamp;
        if (
          !Number.isFinite(age) ||
          age < -5_000 ||
          age > MAX_ROLLOUT_SELECTION_AGE_MS
        ) {
          return undefined;
        }
        const effort = ReasoningEffortSchema.safeParse(entry.payload.effort);
        return effort.success ? effort.data : undefined;
      } catch {
        // The first tail line can be partial. Ignore malformed/non-JSON lines.
      }
    }
  } catch {
    // Reading Codex's append-only session log is best effort and read-only.
  }
  return undefined;
}

export async function runCodexSessionSyncValue(
  value: unknown,
  overrides: Partial<CodexSessionSyncDependencies> = {},
) {
  const rawHook = CodexHookInputSchema.parse(value);
  const stringValue = (value: unknown) =>
    typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  const reasoningValue = (value: unknown) => {
    const parsed = ReasoningEffortSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  };
  // Codex 0.145 can invoke SessionStart while its TUI still reports
  // "model: loading". Keep startup warmup tolerant, then let
  // UserPromptSubmit replace config fallbacks with the exact active model.
  const hook = {
    sessionId: stringValue(rawHook.session_id) ?? 'unknown-codex-session',
    cwd: stringValue(rawHook.cwd) ?? process.cwd(),
    event: stringValue(rawHook.hook_event_name) ?? 'CodexHook',
    model: stringValue(rawHook.model),
    reasoningEffort:
      reasoningValue(rawHook.reasoning_effort) ??
      reasoningValue(rawHook.model_reasoning_effort) ??
      reasoningValue(rawHook.reasoningEffort),
  };
  const dependencies: CodexSessionSyncDependencies = {
    discover: overrides.discover ?? discoverRepository,
    ensure:
      overrides.ensure ??
      ((workspace) => ensureSidecar(workspace, { clientKind: 'launcher' })),
    now: overrides.now ?? (() => new Date()),
    env: overrides.env ?? process.env,
  };
  const repository = await dependencies.discover(hook.cwd);
  if (!repository.safe) return { synced: false as const, repository };

  metadata(repository.root);
  const now = dependencies.now();
  const configured = codexConfigDefaults(repository.root, dependencies.env);
  const previous = readCodexSessionModelState(repository.root, {
    now,
  });
  const model = hook.model ?? configured.model ?? previous?.model;
  const rolloutReasoningEffort = hook.model
    ? codexRolloutReasoningEffort(
        hook.sessionId,
        hook.model,
        dependencies.env,
        now,
      )
    : undefined;
  const reasoningEffort =
    hook.reasoningEffort ??
    rolloutReasoningEffort ??
    configured.reasoningEffort ??
    previous?.reasoningEffort ??
    null;
  const state = model
    ? CodexSessionModelStateSchema.parse({
        schemaVersion: 1,
        sessionId: hook.sessionId,
        workspace: repository.root,
        model,
        reasoningEffort,
        hookEvent: hook.event,
        updatedAt: now.toISOString(),
      })
    : null;
  if (state) atomicState(codexSessionModelStatePath(repository.root), state);

  const lease = await dependencies.ensure(repository.root);
  lease.stopHeartbeat();
  await lease.detach().catch(() => undefined);
  return {
    synced: Boolean(state),
    repository,
    state,
    warmed: true as const,
  };
}

export async function runCodexSessionSync(
  input: Readable,
  overrides: Partial<CodexSessionSyncDependencies> = {},
) {
  return runCodexSessionSyncValue(await readCodexHookInput(input), overrides);
}
