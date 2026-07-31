import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  LATTICE_POST_TOOL_MATCHER,
  LATTICE_PRE_TOOL_MATCHER,
} from './codex-lattice-policy.js';

const HOOK_EVENTS = [
  {
    event: 'SessionStart',
    matcher: 'startup|resume|clear|compact',
    statusMessage: 'Starting Lattice for this repository',
  },
  {
    event: 'UserPromptSubmit',
    statusMessage: 'Synchronizing Lattice with this turn',
  },
  {
    event: 'PreToolUse',
    matcher: LATTICE_PRE_TOOL_MATCHER,
    statusMessage: 'Enforcing Lattice-first repository access',
  },
  {
    event: 'PostToolUse',
    matcher: LATTICE_POST_TOOL_MATCHER,
    statusMessage: 'Recording Lattice activation',
  },
] as const;
const HOOK_RUNNER_MARKER = 'Lattice managed Codex hook runner';

export const CodexHookRegistrationSchema = z
  .object({
    schemaVersion: z.literal(1),
    path: z.string().min(1),
    command: z.string().min(1),
    commandWindows: z.string().min(1),
    createdFile: z.boolean(),
    installedFingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/),
    runnerPath: z.string().min(1).optional(),
    runnerFingerprintSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();

export type CodexHookRegistration = z.infer<
  typeof CodexHookRegistrationSchema
>;

type HooksDocument = Record<string, unknown> & {
  hooks?: Record<string, unknown>;
};

function fingerprint(bytes: string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function shellLiteral(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function windowsLiteral(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function codexHooksPath(env: NodeJS.ProcessEnv = process.env) {
  return resolve(env.CODEX_HOME ?? join(homedir(), '.codex'), 'hooks.json');
}

export function codexSyncHookCommands(
  nodeExecutable: string,
  cliPath: string,
  runnerPath?: string,
) {
  const hookPath = resolve(dirname(cliPath), 'codex-hook.js');
  return {
    command: `${shellLiteral(resolve(nodeExecutable))} ${shellLiteral(hookPath)}`,
    commandWindows: runnerPath
      ? resolve(runnerPath)
      : `${windowsLiteral(resolve(nodeExecutable))} ${windowsLiteral(hookPath)}`,
  };
}

function installWindowsRunner(
  path: string,
  nodeExecutable: string,
  cliPath: string,
) {
  const hookPath = resolve(dirname(cliPath), 'codex-hook.js');
  const raw = [
    '@echo off',
    `REM ${HOOK_RUNNER_MARKER}`,
    `${windowsLiteral(resolve(nodeExecutable))} ${windowsLiteral(hookPath)}`,
    'exit /b 0',
    '',
  ].join('\r\n');
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8');
    if (!current.includes(HOOK_RUNNER_MARKER)) {
      throw new Error(`refusing to overwrite non-Lattice hook runner: ${path}`);
    }
    if (current === raw) return { changed: false, fingerprint: fingerprint(raw) };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw, { encoding: 'utf8', mode: 0o700 });
  return { changed: true, fingerprint: fingerprint(raw) };
}

function parseHooksDocument(raw: string | null): HooksDocument {
  if (raw === null) {
    return {
      description: 'Lattice synchronization hooks for Codex.',
      hooks: {},
    };
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Codex hooks.json must contain a JSON object');
  }
  const document = parsed as HooksDocument;
  if (
    document.hooks !== undefined &&
    (!document.hooks ||
      typeof document.hooks !== 'object' ||
      Array.isArray(document.hooks))
  ) {
    throw new Error('Codex hooks.json "hooks" must contain a JSON object');
  }
  document.hooks ??= {};
  return document;
}

function atomicHooks(path: string, document: HooksDocument) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    writeFileSync(temporary, raw, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    return raw;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function matchesHandler(
  value: unknown,
  commands: { command: string; commandWindows: string },
) {
  return (
    isRecord(value) &&
    value.type === 'command' &&
    (value.command === commands.command ||
      value.commandWindows === commands.commandWindows)
  );
}

function eventHasHandler(
  groups: unknown,
  commands: { command: string; commandWindows: string },
) {
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        isRecord(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some((handler) => matchesHandler(handler, commands)),
    )
  );
}

export function installCodexSyncHooks(options: {
  nodeExecutable: string;
  cliPath: string;
  path?: string;
  runnerPath?: string;
}) {
  const path = resolve(options.path ?? codexHooksPath());
  const createdFile = !existsSync(path);
  const raw = createdFile ? null : readFileSync(path, 'utf8');
  const document = parseHooksDocument(raw);
  const hooks = document.hooks as Record<string, unknown>;
  const runnerPath = options.runnerPath
    ? resolve(options.runnerPath)
    : undefined;
  const runner = runnerPath
    ? installWindowsRunner(runnerPath, options.nodeExecutable, options.cliPath)
    : undefined;
  const commands = codexSyncHookCommands(
    options.nodeExecutable,
    options.cliPath,
    runnerPath,
  );
  let changed = runner?.changed ?? false;
  for (const definition of HOOK_EVENTS) {
    const { event } = definition;
    const current = hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`Codex hooks.json ${event} must be an array`);
    }
    if (eventHasHandler(current, commands)) continue;
    const groups = (current ?? []) as unknown[];
    groups.push({
      ...('matcher' in definition ? { matcher: definition.matcher } : {}),
      hooks: [
        {
          type: 'command',
          command: commands.command,
          commandWindows: commands.commandWindows,
          timeout: 15,
          statusMessage: definition.statusMessage,
        },
      ],
    });
    hooks[event] = groups;
    changed = true;
  }
  const installedRaw = changed
    ? atomicHooks(path, document)
    : (raw ?? `${JSON.stringify(document, null, 2)}\n`);
  return {
    changed,
    registration: CodexHookRegistrationSchema.parse({
      schemaVersion: 1,
      path,
      ...commands,
      createdFile,
      installedFingerprintSha256: fingerprint(installedRaw),
      ...(runnerPath
        ? {
            runnerPath,
            runnerFingerprintSha256: runner?.fingerprint,
          }
        : {}),
    }),
  };
}

function removeOwnedRunner(registration: CodexHookRegistration) {
  if (!registration.runnerPath || !registration.runnerFingerprintSha256) return;
  if (!existsSync(registration.runnerPath)) return;
  const raw = readFileSync(registration.runnerPath, 'utf8');
  if (fingerprint(raw) === registration.runnerFingerprintSha256) {
    rmSync(registration.runnerPath, { force: true });
  }
}

export function removeCodexSyncHooks(registration: CodexHookRegistration) {
  if (!existsSync(registration.path)) {
    removeOwnedRunner(registration);
    return { changed: false, outcome: 'absent' as const, warning: null };
  }
  const raw = readFileSync(registration.path, 'utf8');
  if (
    registration.createdFile &&
    fingerprint(raw) === registration.installedFingerprintSha256
  ) {
    rmSync(registration.path, { force: true });
    removeOwnedRunner(registration);
    return { changed: true, outcome: 'removed' as const, warning: null };
  }

  let document: HooksDocument;
  try {
    document = parseHooksDocument(raw);
  } catch (error) {
    return {
      changed: false,
      outcome: 'unverifiable' as const,
      warning: `Lattice hook cleanup skipped because hooks.json is no longer valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const hooks = document.hooks as Record<string, unknown>;
  const commands = {
    command: registration.command,
    commandWindows: registration.commandWindows,
  };
  let removed = false;
  for (const { event } of HOOK_EVENTS) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const keptGroups: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const keptHandlers = group.hooks.filter((handler) => {
        const matched = matchesHandler(handler, commands);
        removed ||= matched;
        return !matched;
      });
      if (keptHandlers.length > 0) {
        keptGroups.push({ ...group, hooks: keptHandlers });
      }
    }
    if (keptGroups.length > 0) hooks[event] = keptGroups;
    else delete hooks[event];
  }
  if (!removed) {
    return { changed: false, outcome: 'changed' as const, warning: null };
  }
  atomicHooks(registration.path, document);
  removeOwnedRunner(registration);
  return { changed: true, outcome: 'removed' as const, warning: null };
}
