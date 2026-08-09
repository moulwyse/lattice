import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  discoverRepository,
  type RepositoryDiscovery,
} from './repository.js';

const POLICY_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const POLICY_CLEANUP_LIMIT = 500;

export const LATTICE_FIRST_CONTEXT =
  'MANDATORY LATTICE-FIRST REPOSITORY POLICY: If this turn needs to inspect, search, understand, review, debug, modify, test, or explain files in the active repository, call `lattice_search_context` or `lattice_read_context` from the `lattice` MCP server before any ordinary repository read, search, shell, or edit tool. Use the bounded Lattice result first. After one Lattice attempt, ordinary tools are allowed for edits, verification, unsupported data, or fallback if Lattice fails. Do not claim Lattice was used unless you actually called it. This policy does not apply to tasks unrelated to repository contents.';

export const LATTICE_PRE_TOOL_MATCHER =
  '^(?:Bash|Read|Grep|Glob|Edit|Write|apply_patch|exec_command|shell_command|powershell|bash|read_file|file_search|grep|glob|write_file|edit_file|(?:mcp__lattice__)?lattice_(?:search_context|read_context))$';

export const LATTICE_POST_TOOL_MATCHER =
  '^(?:mcp__lattice__)?lattice_(?:search_context|read_context)$';

const REPOSITORY_TOOL_NAMES = new Set([
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'apply_patch',
  'exec_command',
  'shell_command',
  'powershell',
  'bash',
  'read_file',
  'file_search',
  'grep',
  'glob',
  'write_file',
  'edit_file',
]);

const HookInputSchema = z
  .object({
    session_id: z.unknown().optional(),
    turn_id: z.unknown().optional(),
    prompt_id: z.unknown().optional(),
    agent_id: z.unknown().optional(),
    cwd: z.unknown().optional(),
    hook_event_name: z.unknown().optional(),
    tool_name: z.unknown().optional(),
  })
  .passthrough();

const PolicyStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    workspace: z.string().min(1),
    attemptedAt: z.string().datetime().nullable(),
    attemptedTool: z.string().min(1).nullable(),
    succeededAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();

type PolicyState = z.infer<typeof PolicyStateSchema>;

export type CodexLatticePolicyDependencies = {
  discover(start: string): Promise<RepositoryDiscovery>;
  now(): Date;
  env: NodeJS.ProcessEnv;
};

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isLatticeContextTool(toolName: string | undefined) {
  return Boolean(
    toolName &&
      /^(?:mcp__lattice__)?lattice_(?:search_context|read_context)$/.test(
        toolName,
      ),
  );
}

function policyDirectory(env: NodeJS.ProcessEnv) {
  return resolve(
    env.LOCALAPPDATA ?? tmpdir(),
    'Lattice',
    'codex-integration',
    'turn-policy',
  );
}

function policyStatePath(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  turnId: string,
) {
  const id = createHash('sha256')
    .update(`${sessionId}\0${turnId}`)
    .digest('hex');
  return join(policyDirectory(env), `${id}.json`);
}

function atomicState(path: string, value: PolicyState) {
  mkdirSync(dirname(path), { recursive: true });
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

function readState(
  env: NodeJS.ProcessEnv,
  sessionId: string,
  turnId: string,
  workspace: string,
  now: Date,
) {
  const path = policyStatePath(env, sessionId, turnId);
  if (!existsSync(path)) return null;
  try {
    const state = PolicyStateSchema.parse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    const age = now.getTime() - Date.parse(state.updatedAt);
    if (
      state.sessionId !== sessionId ||
      state.turnId !== turnId ||
      resolve(state.workspace) !== resolve(workspace) ||
      age < 0 ||
      age > POLICY_STATE_MAX_AGE_MS
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function cleanOldStates(env: NodeJS.ProcessEnv, now: Date) {
  const directory = policyDirectory(env);
  if (!existsSync(directory)) return;
  try {
    for (const name of readdirSync(directory).slice(0, POLICY_CLEANUP_LIMIT)) {
      if (!name.endsWith('.json')) continue;
      const path = join(directory, name);
      try {
        if (now.getTime() - statSync(path).mtimeMs > POLICY_STATE_MAX_AGE_MS) {
          rmSync(path, { force: true });
        }
      } catch {
        // Cleanup is opportunistic and must never affect a Codex turn.
      }
    }
  } catch {
    // The policy remains functional even if stale state cannot be cleaned.
  }
}

function contextOutput(
  hookEventName: 'SessionStart' | 'UserPromptSubmit' | 'SubagentStart',
) {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: LATTICE_FIRST_CONTEXT,
    },
  };
}

function implicitTurnId(input: z.infer<typeof HookInputSchema>) {
  return `claude-current:${stringValue(input.agent_id) ?? 'main'}`;
}

function denyRepositoryTool(toolName: string) {
  const reason =
    `Lattice-first policy blocked ${toolName}: call ` +
    '`lattice_search_context` or `lattice_read_context` once for this repository turn, then retry. If Lattice fails, the attempted call unlocks normal fallback tools.';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      additionalContext: `${LATTICE_FIRST_CONTEXT}\n\n${reason}`,
    },
  };
}

export async function applyCodexLatticePolicy(
  value: unknown,
  overrides: Partial<CodexLatticePolicyDependencies> = {},
) {
  if ((overrides.env ?? process.env).LATTICE_CLAUDE_RAW === '1') return null;
  const input = HookInputSchema.parse(value);
  const event = stringValue(input.hook_event_name);
  const toolName = stringValue(input.tool_name);
  if (
    event !== 'SessionStart' &&
    event !== 'UserPromptSubmit' &&
    event !== 'SubagentStart' &&
    event !== 'PreToolUse' &&
    event !== 'PostToolUse'
  ) {
    return null;
  }
  if (
    (event === 'PreToolUse' || event === 'PostToolUse') &&
    !isLatticeContextTool(toolName) &&
    !REPOSITORY_TOOL_NAMES.has(toolName ?? '')
  ) {
    return null;
  }

  const dependencies: CodexLatticePolicyDependencies = {
    discover: overrides.discover ?? discoverRepository,
    now: overrides.now ?? (() => new Date()),
    env: overrides.env ?? process.env,
  };
  const now = dependencies.now();
  const cwd = stringValue(input.cwd) ?? process.cwd();
  const repository = await dependencies.discover(cwd);
  if (!repository.safe) return null;

  if (event === 'SessionStart') {
    cleanOldStates(dependencies.env, now);
    return contextOutput('SessionStart');
  }

  const sessionId = stringValue(input.session_id);
  const turnId =
    stringValue(input.turn_id) ??
    stringValue(input.prompt_id) ??
    implicitTurnId(input);
  if (!sessionId || !turnId) {
    if (event === 'UserPromptSubmit') return contextOutput('UserPromptSubmit');
    if (event === 'SubagentStart') return contextOutput('SubagentStart');
    return null;
  }
  const statePath = policyStatePath(dependencies.env, sessionId, turnId);
  const current = readState(
    dependencies.env,
    sessionId,
    turnId,
    repository.root,
    now,
  );

  if (event === 'UserPromptSubmit' || event === 'SubagentStart') {
    atomicState(
      statePath,
      PolicyStateSchema.parse({
        schemaVersion: 1,
        sessionId,
        turnId,
        workspace: repository.root,
        attemptedAt: null,
        attemptedTool: null,
        succeededAt: null,
        updatedAt: now.toISOString(),
      }),
    );
    return contextOutput(event);
  }

  if (isLatticeContextTool(toolName)) {
    atomicState(
      statePath,
      PolicyStateSchema.parse({
        schemaVersion: 1,
        sessionId,
        turnId,
        workspace: repository.root,
        attemptedAt: current?.attemptedAt ?? now.toISOString(),
        attemptedTool: current?.attemptedTool ?? toolName,
        succeededAt:
          event === 'PostToolUse'
            ? now.toISOString()
            : (current?.succeededAt ?? null),
        updatedAt: now.toISOString(),
      }),
    );
    return null;
  }

  if (event === 'PreToolUse' && toolName && !current?.attemptedAt) {
    return denyRepositoryTool(toolName);
  }
  return null;
}
