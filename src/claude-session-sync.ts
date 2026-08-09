import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
export const CLAUDE_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1_000;

export const ClaudeEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const ClaudeHookInputSchema = z
  .object({
    session_id: z.unknown().optional(),
    cwd: z.unknown().optional(),
    hook_event_name: z.unknown().optional(),
    model: z.unknown().optional(),
    effort: z.unknown().optional(),
  })
  .passthrough();

export const ClaudeSessionModelStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    workspace: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: ClaudeEffortSchema.nullable(),
    hookEvent: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ClaudeSessionModelState = z.infer<
  typeof ClaudeSessionModelStateSchema
>;

export type ClaudeSessionSyncDependencies = {
  discover(start: string): Promise<RepositoryDiscovery>;
  ensure(workspace: string): Promise<SidecarLease>;
  now(): Date;
  env: NodeJS.ProcessEnv;
};

export function claudeSessionModelStatePath(workspace: string) {
  return join(workspace, '.lattice', 'claude-session.json');
}

function atomicState(path: string, value: ClaudeSessionModelState) {
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

export function readClaudeSessionModelState(
  workspace: string,
  options: { now?: Date; maxAgeMs?: number } = {},
): ClaudeSessionModelState | null {
  const path = claudeSessionModelStatePath(workspace);
  if (!existsSync(path)) return null;
  try {
    const state = ClaudeSessionModelStateSchema.parse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    const age = (options.now ?? new Date()).getTime() - Date.parse(state.updatedAt);
    if (age < 0 || age > (options.maxAgeMs ?? CLAUDE_SESSION_MAX_AGE_MS)) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

export async function readClaudeHookInput(input: Readable) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_HOOK_INPUT_BYTES) {
      throw new Error(`Claude hook input exceeds ${MAX_HOOK_INPUT_BYTES} bytes`);
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function configuredEffort(env: NodeJS.ProcessEnv) {
  const parsed = ClaudeEffortSchema.safeParse(
    env.CLAUDE_EFFORT ?? env.CLAUDE_CODE_EFFORT_LEVEL,
  );
  return parsed.success ? parsed.data : undefined;
}

function hookEffort(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const parsed = ClaudeEffortSchema.safeParse(
    (value as { level?: unknown }).level,
  );
  return parsed.success ? parsed.data : undefined;
}

export async function runClaudeSessionSyncValue(
  value: unknown,
  overrides: Partial<ClaudeSessionSyncDependencies> = {},
) {
  const rawHook = ClaudeHookInputSchema.parse(value);
  const stringValue = (candidate: unknown) =>
    typeof candidate === 'string' && candidate.trim().length > 0
      ? candidate.trim()
      : undefined;
  const hook = {
    sessionId: stringValue(rawHook.session_id) ?? 'unknown-claude-session',
    cwd: stringValue(rawHook.cwd) ?? process.cwd(),
    event: stringValue(rawHook.hook_event_name) ?? 'ClaudeHook',
    model: stringValue(rawHook.model),
  };
  const dependencies: ClaudeSessionSyncDependencies = {
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
  const previous = readClaudeSessionModelState(repository.root, { now });
  const model = hook.model ?? previous?.model;
  const reasoningEffort =
    hookEffort(rawHook.effort) ??
    configuredEffort(dependencies.env) ??
    previous?.reasoningEffort ??
    null;
  const state = model
    ? ClaudeSessionModelStateSchema.parse({
        schemaVersion: 1,
        sessionId: hook.sessionId,
        workspace: repository.root,
        model,
        reasoningEffort,
        hookEvent: hook.event,
        updatedAt: now.toISOString(),
      })
    : null;
  if (state) atomicState(claudeSessionModelStatePath(repository.root), state);

  const shouldWarm =
    hook.event === 'SessionStart' || hook.event === 'UserPromptSubmit';
  if (shouldWarm) {
    const lease = await dependencies.ensure(repository.root);
    lease.stopHeartbeat();
    await lease.detach().catch(() => undefined);
  }
  return {
    synced: Boolean(state),
    repository,
    state,
    warmed: shouldWarm,
  };
}

export async function runClaudeSessionSync(
  input: Readable,
  overrides: Partial<ClaudeSessionSyncDependencies> = {},
) {
  return runClaudeSessionSyncValue(await readClaudeHookInput(input), overrides);
}

