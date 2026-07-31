import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm as removeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CodexHookRegistrationSchema,
  installCodexSyncHooks,
  removeCodexSyncHooks,
  type CodexHookRegistration,
} from './codex-hooks.js';
import {
  NativeCodexTargetSchema,
  targetWouldRecurse,
  validateNativeCodexTarget,
  type NativeCodexTarget,
} from './codex-launcher.js';
import { runManagedProcess } from './managed-process.js';

const SHIM_MARKER = 'Lattice managed Codex shim';
const USER_PATH_VALUE_ENV = 'LATTICE_INTEGRATION_USER_PATH_VALUE';
const USER_PATH_NULL_ENV = 'LATTICE_INTEGRATION_USER_PATH_NULL';
const MCP_SERVER_NAME = 'lattice';

const McpRegistrationIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    fingerprintSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    command: z.string().min(1),
    arguments: z.array(z.string()),
  })
  .strict();

export const CodexIntegrationStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    enabledAt: z.string().datetime(),
    cliPath: z.string().min(1),
    nodeExecutable: z.string().min(1),
    stateDirectory: z.string().min(1),
    shimDirectory: z.string().min(1),
    statePath: z.string().min(1),
    shimPaths: z
      .object({
        codex: z.array(z.string()).min(1),
        raw: z.array(z.string()).min(1),
      })
      .strict(),
    originalUserPath: z.string().nullable(),
    enabledUserPath: z.string(),
    nativeTarget: NativeCodexTargetSchema,
    nativeVersion: z.string().min(1).nullable(),
    bridge: z
      .object({
        mechanism: z.literal('mcp'),
        serverName: z.literal('lattice'),
        configured: z.boolean(),
        createdByLattice: z.boolean(),
        preExisting: z.boolean(),
        configurationError: z.string().nullable(),
        registrationIdentity: McpRegistrationIdentitySchema.nullable().optional(),
      })
      .strict()
      .optional(),
    hooks: CodexHookRegistrationSchema.optional(),
  })
  .strict();

export type CodexIntegrationState = z.infer<
  typeof CodexIntegrationStateSchema
>;

export type PublicCodexIntegrationState = Omit<
  CodexIntegrationState,
  'originalUserPath' | 'enabledUserPath'
>;

export type CodexIntegrationPaths = {
  stateDirectory: string;
  shimDirectory: string;
  statePath: string;
};

export type UserPathStore = {
  read(): Promise<string | null>;
  write(value: string | null): Promise<void>;
};

export type CodexCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type CodexCommandRunner = (
  target: NativeCodexTarget,
  arguments_: readonly string[],
) => Promise<CodexCommandResult>;

type McpRegistrationHooks = {
  /**
   * Persist the exact transport intent before the external `mcp add` write.
   * This makes a later disable/recovery ownership-safe even if the process
   * exits between the Codex configuration write and post-write inspection.
   */
  onOwnershipIntent?: (
    bridge: NonNullable<CodexIntegrationState['bridge']>,
  ) => void | Promise<void>;
};

export type NativeCodexResolutionOptions = {
  env?: NodeJS.ProcessEnv;
  candidatePaths?: readonly string[];
  excludedPaths?: readonly string[];
  excludedDirectories?: readonly string[];
  targetOverride?: NativeCodexTarget;
  nodeExecutable?: string;
};

export type CodexIntegrationOptions = {
  cliPath: string;
  env?: NodeJS.ProcessEnv;
  paths?: Partial<CodexIntegrationPaths>;
  userPathStore?: UserPathStore;
  nativeTarget?: NativeCodexTarget;
  nativeCandidatePaths?: readonly string[];
  bridge?: CodexIntegrationState['bridge'];
  registerMcp?: boolean;
  registerHooks?: boolean;
  hooksPath?: string;
  hooks?: CodexHookRegistration;
  codexCommandRunner?: CodexCommandRunner;
  verifyNative?: boolean;
};

export type McpBridgeInspection = {
  supported: boolean;
  exists: boolean;
  fingerprintSha256: string | null;
  error: string | null;
};

type InternalMcpBridgeInspection = McpBridgeInspection & {
  definition: unknown | null;
};

export type McpBridgeRemoval = {
  removed: boolean;
  outcome:
    | 'not-owned'
    | 'absent'
    | 'removed'
    | 'changed'
    | 'unverifiable'
    | 'failed';
  warning: string | null;
};

function canonicalPath(path: string) {
  let value = resolve(path);
  try {
    value = realpathSync.native(value);
  } catch {
    // Missing candidates are filtered separately.
  }
  value = normalize(value);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function pathWithin(path: string, directory: string) {
  const candidate = canonicalPath(path);
  const root = canonicalPath(directory);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isFile(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function nativeTargetFilesPresent(target: NativeCodexTarget) {
  return isFile(target.command) && isFile(target.sourcePath);
}

function publicIntegrationState(
  state: CodexIntegrationState,
): PublicCodexIntegrationState {
  const {
    originalUserPath: _originalUserPath,
    enabledUserPath: _enabledUserPath,
    ...visible
  } = state;
  return visible;
}

function localApplicationData(env: NodeJS.ProcessEnv) {
  return (
    env.LOCALAPPDATA ??
    (process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Local')
      : join(homedir(), '.local', 'share'))
  );
}

export function codexIntegrationPaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<CodexIntegrationPaths> = {},
): CodexIntegrationPaths {
  const stateDirectory = resolve(
    overrides.stateDirectory ??
      join(localApplicationData(env), 'Lattice', 'codex-integration'),
  );
  const shimDirectory = resolve(
    overrides.shimDirectory ?? join(stateDirectory, 'bin'),
  );
  return {
    stateDirectory,
    shimDirectory,
    statePath: resolve(
      overrides.statePath ?? join(stateDirectory, 'integration.json'),
    ),
  };
}

function atomicJson(path: string, value: unknown) {
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

export function readCodexIntegrationState(
  paths: CodexIntegrationPaths = codexIntegrationPaths(),
) {
  if (!existsSync(paths.statePath)) return null;
  return CodexIntegrationStateSchema.parse(
    JSON.parse(readFileSync(paths.statePath, 'utf8')) as unknown,
  );
}

function powershellExecutable(env: NodeJS.ProcessEnv) {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
  const bundled = systemRoot
    ? join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
    : null;
  return bundled && existsSync(bundled) ? bundled : 'powershell.exe';
}

/**
 * Reads and writes HKCU\Environment\Path through the documented .NET API.
 * Passing values through the child environment avoids command interpolation,
 * PowerShell quoting, and setx.exe's historical truncation behavior.
 */
export function windowsUserPathStore(
  env: NodeJS.ProcessEnv = process.env,
): UserPathStore {
  if (process.platform !== 'win32') {
    throw new Error('automatic Codex PATH integration is currently Windows-only');
  }
  const powershell = powershellExecutable(env);
  return {
    async read() {
      const script =
        "$v=[Environment]::GetEnvironmentVariable('Path','User');" +
        "if($null -eq $v){[Console]::Out.Write('-')}else{" +
        "[Console]::Out.Write([Convert]::ToBase64String(" +
        '[Text.Encoding]::UTF8.GetBytes($v)))}';
      const result = await runManagedProcess(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          env,
          timeoutMs: 5_000,
        },
      );
      const encoded = result.stdout.trim();
      return encoded === '-'
        ? null
        : Buffer.from(encoded, 'base64').toString('utf8');
    },
    async write(value) {
      const script =
        `$isNull=[Environment]::GetEnvironmentVariable('${USER_PATH_NULL_ENV}','Process');` +
        `$v=[Environment]::GetEnvironmentVariable('${USER_PATH_VALUE_ENV}','Process');` +
        "if($isNull -eq '1'){$v=$null};" +
        "[Environment]::SetEnvironmentVariable('Path',$v,'User')";
      await runManagedProcess(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        {
          env: {
            ...env,
            [USER_PATH_VALUE_ENV]: value ?? '',
            [USER_PATH_NULL_ENV]: value === null ? '1' : '0',
          },
          timeoutMs: 5_000,
        },
      );
    },
  };
}

export const defaultCodexCommandRunner: CodexCommandRunner = async (
  target,
  arguments_,
) => {
  const result = await runManagedProcess(
    target.command,
    [...target.prefixArguments, ...arguments_],
    {
      timeoutMs: 10_000,
      reject: false,
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

export async function verifyNativeCodexTarget(
  target: NativeCodexTarget,
  runner: CodexCommandRunner = defaultCodexCommandRunner,
) {
  const result = await runner(target, ['--version']);
  const version = (result.stdout || result.stderr)
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.slice(0, 200);
  if (result.exitCode !== 0 || !version) {
    throw new Error(
      `native Codex version check failed: ${compactCommandError(result)}`,
    );
  }
  if (!/^codex-cli(?:\s|$)/i.test(version)) {
    throw new Error(
      `resolved command did not identify itself as official codex-cli: ${version}`,
    );
  }
  return version;
}

function compactCommandError(result: CodexCommandResult) {
  return (result.stderr || result.stdout || `exit code ${String(result.exitCode)}`)
    .replace(/[\r\n]+/g, ' ')
    .replace(
      /\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      '$1=<redacted>',
    )
    .slice(0, 300);
}

function compactUnexpectedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .replace(
      /\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      '$1=<redacted>',
    )
    .slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutName(entry: Record<string, unknown>) {
  const { name: _name, ...definition } = entry;
  return definition;
}

/**
 * Codex versions have emitted both an array of named entries and keyed
 * server maps. Normalize either representation without retaining the raw
 * output outside this process: MCP entries can contain environment values.
 */
function listedMcpServerDefinitions(value: unknown) {
  const entries = new Map<string, unknown>();
  const addNamedEntries = (items: unknown[]) => {
    for (const item of items) {
      if (!isRecord(item) || typeof item.name !== 'string') continue;
      entries.set(item.name, withoutName(item));
    }
  };
  const addKeyedEntries = (record: Record<string, unknown>) => {
    for (const [name, definition] of Object.entries(record)) {
      if (isRecord(definition)) entries.set(name, definition);
    }
  };

  if (Array.isArray(value)) {
    addNamedEntries(value);
    return entries;
  }
  if (!isRecord(value)) return entries;
  const servers = value.servers ?? value.mcpServers ?? value.mcp_servers;
  if (Array.isArray(servers)) {
    addNamedEntries(servers);
  } else if (isRecord(servers)) {
    addKeyedEntries(servers);
  } else {
    addKeyedEntries(value);
  }
  return entries;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function canonicalMcpPathValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalMcpPathValues);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === 'command' && typeof child === 'string' && isAbsolute(child)) {
        return [key, canonicalPath(child)];
      }
      if (key === 'args' && Array.isArray(child)) {
        return [
          key,
          child.map((argument) =>
            typeof argument === 'string' && isAbsolute(argument)
              ? canonicalPath(argument)
              : canonicalMcpPathValues(argument),
          ),
        ];
      }
      return [key, canonicalMcpPathValues(child)];
    }),
  );
}

function mcpRegistrationFingerprint(
  serverName: string,
  definition: unknown,
) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonicalJsonValue({
          serverName,
          definition: canonicalMcpPathValues(definition),
        }),
      ),
      'utf8',
    )
    .digest('hex');
}

async function inspectCodexMcpBridgeInternal(
  target: NativeCodexTarget,
  runner: CodexCommandRunner = defaultCodexCommandRunner,
): Promise<InternalMcpBridgeInspection> {
  let result: CodexCommandResult;
  try {
    result = await runner(target, ['mcp', 'list', '--json']);
  } catch (error) {
    return {
      supported: false,
      exists: false,
      fingerprintSha256: null,
      error: compactUnexpectedError(error),
      definition: null,
    };
  }
  if (result.exitCode !== 0) {
    return {
      supported: false,
      exists: false,
      fingerprintSha256: null,
      error: compactCommandError(result),
      definition: null,
    };
  }
  try {
    const entries = listedMcpServerDefinitions(
      JSON.parse(result.stdout) as unknown,
    );
    const definition = entries.get(MCP_SERVER_NAME);
    return {
      supported: true,
      exists: definition !== undefined,
      fingerprintSha256:
        definition === undefined
          ? null
          : mcpRegistrationFingerprint(MCP_SERVER_NAME, definition),
      error: null,
      definition: definition ?? null,
    };
  } catch {
    return {
      supported: false,
      exists: false,
      fingerprintSha256: null,
      error: 'codex mcp list returned invalid JSON',
      definition: null,
    };
  }
}

export async function inspectCodexMcpBridge(
  target: NativeCodexTarget,
  runner: CodexCommandRunner = defaultCodexCommandRunner,
): Promise<McpBridgeInspection> {
  const { definition: _definition, ...inspection } =
    await inspectCodexMcpBridgeInternal(target, runner);
  return inspection;
}

function configuredMcpTransport(definition: unknown) {
  if (!isRecord(definition)) return null;
  const transport = isRecord(definition.transport)
    ? definition.transport
    : definition;
  if (
    typeof transport.command !== 'string' ||
    !Array.isArray(transport.args) ||
    !transport.args.every((argument) => typeof argument === 'string')
  ) {
    return null;
  }
  return {
    command: transport.command,
    arguments: transport.args as string[],
  };
}

function sameMcpArgument(actual: string, expected: string) {
  if (isAbsolute(actual) && isAbsolute(expected)) {
    return canonicalPath(actual) === canonicalPath(expected);
  }
  return actual === expected;
}

function matchesExpectedMcpTransport(
  definition: unknown,
  expectedCommand: string,
  expectedArguments: readonly string[],
) {
  const configured = configuredMcpTransport(definition);
  return (
    configured !== null &&
    sameMcpArgument(configured.command, expectedCommand) &&
    configured.arguments.length === expectedArguments.length &&
    configured.arguments.every((argument, index) =>
      sameMcpArgument(argument, expectedArguments[index]!),
    )
  );
}

export async function registerCodexMcpBridge(
  target: NativeCodexTarget,
  nodeExecutable: string,
  cliPath: string,
  runner: CodexCommandRunner = defaultCodexCommandRunner,
  hooks: McpRegistrationHooks = {},
): Promise<NonNullable<CodexIntegrationState['bridge']>> {
  const inspection = await inspectCodexMcpBridge(target, runner);
  if (!inspection.supported) {
    return {
      mechanism: 'mcp',
      serverName: MCP_SERVER_NAME,
      configured: false,
      createdByLattice: false,
      preExisting: false,
      configurationError: inspection.error,
      registrationIdentity: null,
    };
  }
  if (inspection.exists) {
    return {
      mechanism: 'mcp',
      serverName: MCP_SERVER_NAME,
      configured: false,
      createdByLattice: false,
      preExisting: true,
      configurationError:
        'an MCP server named lattice already exists and was not overwritten',
      registrationIdentity: null,
    };
  }
  const registrationArguments = [cliPath, 'mcp-server'];
  const ownershipIntent: NonNullable<CodexIntegrationState['bridge']> = {
    mechanism: 'mcp',
    serverName: MCP_SERVER_NAME,
    configured: false,
    createdByLattice: true,
    preExisting: false,
    configurationError:
      'Lattice MCP registration is pending external write verification',
    registrationIdentity: {
      schemaVersion: 1,
      fingerprintSha256: null,
      command: nodeExecutable,
      arguments: registrationArguments,
    },
  };
  await hooks.onOwnershipIntent?.(ownershipIntent);
  const result = await runner(target, [
    'mcp',
    'add',
    MCP_SERVER_NAME,
    '--',
    nodeExecutable,
    ...registrationArguments,
  ]);
  if (result.exitCode !== 0) {
    return {
      mechanism: 'mcp',
      serverName: MCP_SERVER_NAME,
      configured: false,
      createdByLattice: false,
      preExisting: false,
      configurationError: compactCommandError(result),
      registrationIdentity: null,
    };
  }
  const registered = await inspectCodexMcpBridgeInternal(target, runner);
  if (!registered.supported) {
    // `mcp add` succeeded, so retain durable ownership even when the
    // post-write inspection surface is temporarily unavailable. Raw mode can
    // still suppress the bridge and disable can verify the exact transport on
    // a later run instead of leaving an unowned global registration.
    return {
      mechanism: 'mcp',
      serverName: MCP_SERVER_NAME,
      configured: false,
      createdByLattice: true,
      preExisting: false,
      configurationError:
        `Codex accepted the Lattice MCP registration but it could not be verified: ${registered.error ?? 'inspection unavailable'}`,
      registrationIdentity: {
        ...ownershipIntent.registrationIdentity!,
      },
    };
  }
  if (
    !registered.exists ||
    !registered.fingerprintSha256 ||
    !matchesExpectedMcpTransport(
      registered.definition,
      nodeExecutable,
      registrationArguments,
    )
  ) {
    throw new Error(
      'Codex MCP registration could not be verified as the exact Lattice command after creation; the current same-name entry was left unchanged',
    );
  }
  return {
    mechanism: 'mcp',
    serverName: MCP_SERVER_NAME,
    configured: true,
    createdByLattice: true,
    preExisting: false,
    configurationError: null,
    registrationIdentity: {
      schemaVersion: 1,
      fingerprintSha256: registered.fingerprintSha256,
      command: nodeExecutable,
      arguments: registrationArguments,
    },
  };
}

export async function removeCodexMcpBridge(
  state: Pick<CodexIntegrationState, 'bridge' | 'nativeTarget'>,
  runner: CodexCommandRunner = defaultCodexCommandRunner,
): Promise<McpBridgeRemoval> {
  if (!state.bridge?.createdByLattice) {
    return { removed: false, outcome: 'not-owned', warning: null };
  }
  const inspection = await inspectCodexMcpBridgeInternal(
    state.nativeTarget,
    runner,
  );
  if (!inspection.supported) {
    return {
      removed: false,
      outcome: 'unverifiable',
      warning: `Lattice-owned MCP registration was left unchanged because current Codex configuration could not be inspected: ${inspection.error ?? 'unknown inspection error'}`,
    };
  }
  if (!inspection.exists) {
    return { removed: false, outcome: 'absent', warning: null };
  }
  const identity = state.bridge.registrationIdentity;
  if (!identity) {
    return {
      removed: false,
      outcome: 'unverifiable',
      warning:
        'Lattice-owned MCP registration was left unchanged because this legacy integration state has no ownership identity',
    };
  }
  if (!identity.fingerprintSha256) {
    if (
      !matchesExpectedMcpTransport(
        inspection.definition,
        identity.command,
        identity.arguments,
      )
    ) {
      return {
        removed: false,
        outcome: 'changed',
        warning:
          'MCP server "lattice" no longer uses the Lattice-owned transport and was not removed',
      };
    }
    return {
      removed: false,
      outcome: 'unverifiable',
      warning:
        'Lattice-owned MCP registration was left unchanged because its full definition could not be fingerprinted after creation. Remove it explicitly with "codex mcp remove lattice", then run disable again',
    };
  }
  const identityMatches =
    inspection.fingerprintSha256 === identity.fingerprintSha256;
  if (!identityMatches) {
    return {
      removed: false,
      outcome: 'changed',
      warning:
        'MCP server "lattice" has changed since Lattice registered it and was not removed',
    };
  }
  let result: CodexCommandResult;
  try {
    result = await runner(state.nativeTarget, [
      'mcp',
      'remove',
      state.bridge.serverName,
    ]);
  } catch (error) {
    return {
      removed: false,
      outcome: 'failed',
      warning: `Failed to remove the matching Lattice MCP registration: ${compactUnexpectedError(error)}`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      removed: false,
      outcome: 'failed',
      warning: `Failed to remove the matching Lattice MCP registration: ${compactCommandError(result)}`,
    };
  }
  return { removed: true, outcome: 'removed', warning: null };
}

function pathCandidates(env: NodeJS.ProcessEnv) {
  const directories = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  if (process.platform !== 'win32') {
    return directories.map((directory) => join(directory, 'codex'));
  }
  const extensions = [
    '.exe',
    '.com',
    '.ps1',
    '.cmd',
    '.bat',
    '',
  ];
  return directories.flatMap((directory) =>
    extensions.map((extension) => join(directory, `codex${extension}`)),
  );
}

function npmCodexEntry(shimPath: string) {
  const directory = dirname(shimPath);
  const candidates = [
    join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    join(
      dirname(directory),
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    ),
  ];
  return candidates.find(isFile) ?? null;
}

function executableTarget(path: string): NativeCodexTarget | null {
  const extension = extname(path).toLowerCase();
  if (process.platform === 'win32' && ['.exe', '.com'].includes(extension)) {
    return {
      schemaVersion: 1,
      command: resolve(path),
      prefixArguments: [],
      sourcePath: resolve(path),
      sourceKind: 'native-executable',
    };
  }
  const npmEntry = npmCodexEntry(path);
  if (npmEntry) {
    return {
      schemaVersion: 1,
      command: resolve(process.execPath),
      prefixArguments: [resolve(npmEntry)],
      sourcePath: resolve(path),
      sourceKind: 'official-npm-entry',
    };
  }
  if (process.platform !== 'win32') {
    return {
      schemaVersion: 1,
      command: resolve(path),
      prefixArguments: [],
      sourcePath: resolve(path),
      sourceKind: 'native-executable',
    };
  }
  return null;
}

export function resolveNativeCodex(
  options: NativeCodexResolutionOptions = {},
): NativeCodexTarget {
  if (options.targetOverride) {
    const target = validateNativeCodexTarget(
      {
        ...options.targetOverride,
        sourceKind: options.targetOverride.sourceKind ?? 'injected',
      },
      options.excludedPaths,
    );
    if (
      (options.excludedDirectories ?? []).some(
        (directory) =>
          pathWithin(target.command, directory) ||
          pathWithin(target.sourcePath, directory),
      )
    ) {
      throw new Error(
        'Codex launcher recursion prevented: target is inside the Lattice shim directory',
      );
    }
    return target;
  }
  const env = options.env ?? process.env;
  const excludedPaths = new Set(
    (options.excludedPaths ?? []).map(canonicalPath),
  );
  const excludedDirectories = options.excludedDirectories ?? [];
  const candidates = options.candidatePaths ?? pathCandidates(env);
  const seen = new Set<string>();
  for (const path of candidates) {
    const canonical = canonicalPath(path);
    if (
      seen.has(canonical) ||
      excludedPaths.has(canonical) ||
      excludedDirectories.some((directory) => pathWithin(path, directory)) ||
      !isFile(path)
    ) {
      continue;
    }
    seen.add(canonical);
    const target = executableTarget(path);
    if (!target) continue;
    return validateNativeCodexTarget(target, options.excludedPaths);
  }
  throw new Error(
    'official Codex CLI was not found outside the Lattice shim directory',
  );
}

function safeBatchLiteral(path: string) {
  if (/["\r\n%]/.test(path)) {
    throw new Error(`cannot safely encode launcher path in cmd shim: ${path}`);
  }
  return path;
}

function powershellLiteral(value: string) {
  if (/[\r\n]/.test(value)) {
    throw new Error('cannot encode a newline in the PowerShell shim');
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function writeShim(path: string, content: string, executable = false) {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o755 });
  if (executable) chmodSync(path, 0o755);
}

async function removeFileWithRetry(path: string, maxRetries = 8) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await removeFile(path, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt >= maxRetries ||
        !['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(code ?? '')
      ) {
        throw error;
      }
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, 40 * (attempt + 1)),
      );
    }
  }
}

async function removeShimFiles(paths: readonly string[]) {
  for (const path of paths) await removeFileWithRetry(path);
}

function plannedShimPaths(
  paths: CodexIntegrationPaths,
): CodexIntegrationState['shimPaths'] {
  if (process.platform === 'win32') {
    return {
      codex: [
        join(paths.shimDirectory, 'codex.cmd'),
        join(paths.shimDirectory, 'codex.ps1'),
        join(paths.shimDirectory, 'codex'),
      ],
      raw: [
        join(paths.shimDirectory, 'codex-raw.cmd'),
        join(paths.shimDirectory, 'codex-raw.ps1'),
        join(paths.shimDirectory, 'codex-raw'),
      ],
    };
  }
  return {
    codex: [join(paths.shimDirectory, 'codex')],
    raw: [join(paths.shimDirectory, 'codex-raw')],
  };
}

async function createShimFiles(
  paths: CodexIntegrationPaths,
  cliPath: string,
  nodeExecutable: string,
) {
  mkdirSync(paths.shimDirectory, { recursive: true });
  const shellLiteral = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const planned = plannedShimPaths(paths);
  if (process.platform === 'win32') {
    const node = safeBatchLiteral(nodeExecutable);
    const cli = safeBatchLiteral(cliPath);
    const [codexCmd, codexPs1, codexShell] = planned.codex;
    const [rawCmd, rawPs1, rawShell] = planned.raw;
    const intended = [...planned.codex, ...planned.raw];
    try {
      writeShim(
        codexCmd,
        `@echo off\r\nsetlocal DisableDelayedExpansion\r\nrem ${SHIM_MARKER}\r\n"${node}" "${cli}" codex %*\r\nexit /b %ERRORLEVEL%\r\n`,
      );
      writeShim(
        rawCmd,
        `@echo off\r\nsetlocal DisableDelayedExpansion\r\nrem ${SHIM_MARKER}\r\n"${node}" "${cli}" codex --raw %*\r\nexit /b %ERRORLEVEL%\r\n`,
      );
      const psNode = powershellLiteral(nodeExecutable);
      const psCli = powershellLiteral(cliPath);
      writeShim(
        codexPs1,
        `# ${SHIM_MARKER}\n& ${psNode} ${psCli} codex @args\nexit $LASTEXITCODE\n`,
      );
      writeShim(
        rawPs1,
        `# ${SHIM_MARKER}\n& ${psNode} ${psCli} codex --raw @args\nexit $LASTEXITCODE\n`,
      );
      writeShim(
        codexShell,
        `#!/bin/sh\n# ${SHIM_MARKER}\nexec ${shellLiteral(nodeExecutable)} ${shellLiteral(cliPath)} codex "$@"\n`,
        true,
      );
      writeShim(
        rawShell,
        `#!/bin/sh\n# ${SHIM_MARKER}\nexec ${shellLiteral(nodeExecutable)} ${shellLiteral(cliPath)} codex --raw "$@"\n`,
        true,
      );
    } catch (error) {
      try {
        await removeShimFiles(intended);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Codex shim creation failed and partial files could not be removed',
        );
      }
      throw error;
    }
    return planned;
  }

  const [codex] = planned.codex;
  const [raw] = planned.raw;
  try {
    writeShim(
      codex,
      `#!/bin/sh\n# ${SHIM_MARKER}\nexec ${shellLiteral(nodeExecutable)} ${shellLiteral(cliPath)} codex "$@"\n`,
      true,
    );
    writeShim(
      raw,
      `#!/bin/sh\n# ${SHIM_MARKER}\nexec ${shellLiteral(nodeExecutable)} ${shellLiteral(cliPath)} codex --raw "$@"\n`,
      true,
    );
  } catch (error) {
    try {
      await removeShimFiles([codex, raw]);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Codex shim creation failed and partial files could not be removed',
      );
    }
    throw error;
  }
  return planned;
}

function samePath(left: string, right: string) {
  return canonicalPath(left) === canonicalPath(right);
}

function prependPath(directory: string, current: string | null) {
  const parts = (current ?? '')
    .split(delimiter)
    .filter((entry) => entry && !samePath(entry, directory));
  return [directory, ...parts].join(delimiter);
}

function removePath(directory: string, current: string | null) {
  if (current === null) return null;
  return current
    .split(delimiter)
    .filter((entry) => entry && !samePath(entry, directory))
    .join(delimiter);
}

export async function enableCodexIntegration(
  options: CodexIntegrationOptions,
) {
  const env = options.env ?? process.env;
  const paths = codexIntegrationPaths(env, options.paths);
  const cliPath = resolve(options.cliPath);
  if (!isFile(cliPath)) throw new Error(`Lattice CLI was not found: ${cliPath}`);
  let existing = readCodexIntegrationState(paths);
  if (existing) {
    if (!samePath(existing.cliPath, cliPath)) {
      throw new Error(
        'Codex integration points to a different Lattice CLI; run disable and then enable to update it safely',
      );
    }
    let repaired = false;
    if (!nativeTargetFilesPresent(existing.nativeTarget)) {
      const recoveredTarget = resolveNativeCodex({
        env,
        candidatePaths: options.nativeCandidatePaths,
        targetOverride: options.nativeTarget,
        excludedDirectories: [paths.shimDirectory],
      });
      const recoveredVersion =
        options.verifyNative === false
          ? existing.nativeVersion
          : await verifyNativeCodexTarget(
              recoveredTarget,
              options.codexCommandRunner,
            );
      existing = CodexIntegrationStateSchema.parse({
        ...existing,
        nativeTarget: recoveredTarget,
        nativeVersion: recoveredVersion,
      });
      atomicJson(paths.statePath, existing);
      repaired = true;
    }
    if (options.registerHooks === true) {
      const installedHooks = installCodexSyncHooks({
        nodeExecutable: existing.nodeExecutable,
        cliPath,
        runnerPath: join(paths.stateDirectory, 'codex-hook.cmd'),
        ...(options.hooksPath ? { path: options.hooksPath } : {}),
      });
      if (
        installedHooks.changed ||
        JSON.stringify(existing.hooks) !==
          JSON.stringify(installedHooks.registration)
      ) {
        existing = CodexIntegrationStateSchema.parse({
          ...existing,
          hooks: installedHooks.registration,
        });
        atomicJson(paths.statePath, existing);
        repaired = true;
      }
    }
    const health = await codexIntegrationStatus({
      env,
      paths,
      userPathStore: options.userPathStore,
      codexCommandRunner: options.codexCommandRunner,
    });
    const ownedBridgeHealthy =
      !existing.bridge?.createdByLattice ||
      health.bridgeInspection?.ownership === 'matched';
    if (!health.enabled || !ownedBridgeHealthy) {
      throw new Error(
        'existing Codex integration is unhealthy; run "lattice integration codex disable" and then enable it again',
      );
    }
    return {
      changed: repaired,
      state: existing,
      ...(repaired ? { repaired: true as const } : {}),
    };
  }

  const nodeExecutable = resolve(process.execPath);
  const pathStore = options.userPathStore ?? windowsUserPathStore(env);
  const originalUserPath = await pathStore.read();
  const nativeTarget = resolveNativeCodex({
    env,
    candidatePaths: options.nativeCandidatePaths,
    targetOverride: options.nativeTarget,
    excludedDirectories: [paths.shimDirectory],
  });
  const nativeVersion =
    options.verifyNative === false
      ? null
      : await verifyNativeCodexTarget(
          nativeTarget,
          options.codexCommandRunner,
        );
  const enabledUserPath = prependPath(
    paths.shimDirectory,
    originalUserPath,
  );
  const enabledAt = new Date().toISOString();
  const intendedShimPaths = plannedShimPaths(paths);
  const buildState = (
    shimPaths: CodexIntegrationState['shimPaths'],
    bridgeValue: CodexIntegrationState['bridge'],
    hooksValue: CodexIntegrationState['hooks'],
  ) =>
    CodexIntegrationStateSchema.parse({
      schemaVersion: 1,
      enabledAt,
      cliPath,
      nodeExecutable,
      ...paths,
      shimPaths,
      originalUserPath,
      enabledUserPath,
      nativeTarget,
      nativeVersion,
      ...(bridgeValue ? { bridge: bridgeValue } : {}),
      ...(hooksValue ? { hooks: hooksValue } : {}),
    });
  let bridge = options.bridge;
  let hooks = options.hooks;
  let hooksChanged = false;
  let shimPaths: CodexIntegrationState['shimPaths'] | null = null;
  let state: CodexIntegrationState | null = null;
  try {
    if (!bridge && options.registerMcp !== false) {
      bridge = await registerCodexMcpBridge(
        nativeTarget,
        nodeExecutable,
        cliPath,
        options.codexCommandRunner,
        {
          onOwnershipIntent(intent) {
            bridge = intent;
            state = buildState(intendedShimPaths, intent, hooks);
            atomicJson(paths.statePath, state);
          },
        },
      );
    }
    if (!hooks && options.registerHooks === true) {
      const installedHooks = installCodexSyncHooks({
        nodeExecutable,
        cliPath,
        runnerPath: join(paths.stateDirectory, 'codex-hook.cmd'),
        ...(options.hooksPath ? { path: options.hooksPath } : {}),
      });
      hooks = installedHooks.registration;
      hooksChanged = installedHooks.changed;
    }
    shimPaths = await createShimFiles(paths, cliPath, nodeExecutable);
    state = buildState(shimPaths, bridge, hooks);
    atomicJson(paths.statePath, state);
    await pathStore.write(enabledUserPath);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (shimPaths) {
      try {
        await removeShimFiles([...shimPaths.codex, ...shimPaths.raw]);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    let removal: McpBridgeRemoval | null = null;
    if (bridge?.createdByLattice) {
      try {
        removal = await removeCodexMcpBridge(
          { bridge, nativeTarget },
          options.codexCommandRunner,
        );
        if (removal.warning) {
          rollbackErrors.push(new Error(removal.warning));
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (hooks && hooksChanged) {
      const hookRemoval = removeCodexSyncHooks(hooks);
      if (hookRemoval.warning) rollbackErrors.push(new Error(hookRemoval.warning));
    }
    const retainOwnershipReceipt =
      bridge?.createdByLattice === true &&
      (!removal ||
        !['removed', 'absent', 'changed'].includes(removal.outcome));
    if (retainOwnershipReceipt) {
      try {
        state ??= buildState(intendedShimPaths, bridge, hooks);
        atomicJson(paths.statePath, state);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    } else {
      try {
        await removeFileWithRetry(paths.statePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Codex integration enable failed and one or more changes could not be rolled back',
      );
    }
    throw error;
  }
  if (!state) throw new Error('Codex integration state was not created');
  return { changed: true as const, state };
}

export async function disableCodexIntegration(
  options: {
    env?: NodeJS.ProcessEnv;
    paths?: Partial<CodexIntegrationPaths>;
    userPathStore?: UserPathStore;
    codexCommandRunner?: CodexCommandRunner;
    nativeCandidatePaths?: readonly string[];
  } = {},
) {
  const env = options.env ?? process.env;
  const paths = codexIntegrationPaths(env, options.paths);
  const state = readCodexIntegrationState(paths);
  if (!state) {
    return {
      changed: false as const,
      restoration: 'not-installed' as const,
      bridgeRemoved: false,
      bridgeCleanup: 'not-owned' as const,
      complete: true,
      pendingBridgeCleanup: false,
      pendingHookCleanup: false,
      warnings: [] as string[],
    };
  }
  const pathStore = options.userPathStore ?? windowsUserPathStore(env);
  const current = await pathStore.read();
  const exact = current === state.enabledUserPath;
  const restored = exact
    ? state.originalUserPath
    : removePath(state.shimDirectory, current);
  await pathStore.write(restored);
  let removal: McpBridgeRemoval | null = null;
  let removalTarget = state.nativeTarget;
  if (!nativeTargetFilesPresent(removalTarget)) {
    try {
      removalTarget = resolveNativeCodex({
        env,
        candidatePaths: options.nativeCandidatePaths,
        excludedDirectories: [paths.shimDirectory],
      });
    } catch (error) {
      removal = {
        removed: false,
        outcome: 'unverifiable',
        warning: `Lattice-owned MCP registration could not be inspected during disable because native Codex was unavailable: ${compactUnexpectedError(error)}`,
      };
    }
  }
  removal ??= await removeCodexMcpBridge(
    { ...state, nativeTarget: removalTarget },
    options.codexCommandRunner,
  );
  const hookRemoval = state.hooks
    ? removeCodexSyncHooks(state.hooks)
    : { changed: false, outcome: 'absent' as const, warning: null };
  await removeShimFiles([...state.shimPaths.codex, ...state.shimPaths.raw]);
  const pendingBridgeCleanup =
    state.bridge?.createdByLattice === true &&
    !['removed', 'absent', 'changed'].includes(removal.outcome);
  const pendingHookCleanup = hookRemoval.outcome === 'unverifiable';
  if (!pendingBridgeCleanup && !pendingHookCleanup) {
    await removeFileWithRetry(state.statePath);
  }
  const warnings = [removal.warning, hookRemoval.warning].filter(
    (warning): warning is string => Boolean(warning),
  );
  return {
    changed: true as const,
    restoration: exact ? ('exact' as const) : ('surgical' as const),
    bridgeRemoved: removal.removed,
    bridgeCleanup: removal.outcome,
    complete: !pendingBridgeCleanup && !pendingHookCleanup,
    pendingBridgeCleanup,
    pendingHookCleanup,
    warnings,
  };
}

export async function codexIntegrationStatus(
  options: {
    env?: NodeJS.ProcessEnv;
    paths?: Partial<CodexIntegrationPaths>;
    userPathStore?: UserPathStore;
    codexCommandRunner?: CodexCommandRunner;
  } = {},
) {
  const env = options.env ?? process.env;
  const paths = codexIntegrationPaths(env, options.paths);
  const state = readCodexIntegrationState(paths);
  if (!state) {
    return {
      configured: false as const,
      enabled: false,
      state: null,
      userPathContainsShim: false,
      shimsPresent: false,
      nativeTargetPresent: false,
      recursionSafe: true,
      bridgeInspection: null,
    };
  }
  const pathStore = options.userPathStore ?? windowsUserPathStore(env);
  const userPath = await pathStore.read();
  const userPathContainsShim = (userPath ?? '')
    .split(delimiter)
    .some((entry) => entry && samePath(entry, state.shimDirectory));
  const allShims = [...state.shimPaths.codex, ...state.shimPaths.raw];
  const shimsPresent = allShims.every(isFile);
  const nativeTargetPresent = nativeTargetFilesPresent(state.nativeTarget);
  const recursionSafe =
    !targetWouldRecurse(state.nativeTarget, allShims) &&
    !pathWithin(state.nativeTarget.command, state.shimDirectory) &&
    !pathWithin(state.nativeTarget.sourcePath, state.shimDirectory);
  const internalBridgeInspection = state.bridge
    ? await inspectCodexMcpBridgeInternal(
        state.nativeTarget,
        options.codexCommandRunner,
      )
    : null;
  const bridgeInspection =
    internalBridgeInspection === null
      ? null
      : (({ definition: _definition, ...visible }) => visible)(
          internalBridgeInspection,
        );
  const registrationIdentity = state.bridge?.registrationIdentity;
  const currentIdentityMatches =
    internalBridgeInspection?.exists === true &&
    registrationIdentity?.fingerprintSha256 !== undefined &&
    registrationIdentity.fingerprintSha256 !== null &&
    internalBridgeInspection.fingerprintSha256 ===
      registrationIdentity.fingerprintSha256;
  const currentTransportMatches =
    internalBridgeInspection?.exists === true &&
    registrationIdentity !== undefined &&
    registrationIdentity !== null &&
    matchesExpectedMcpTransport(
      internalBridgeInspection.definition,
      registrationIdentity.command,
      registrationIdentity.arguments,
    );
  const ownership =
    !state.bridge?.createdByLattice
      ? 'not-owned'
      : !bridgeInspection?.supported
        ? 'unverifiable'
        : !bridgeInspection.exists
          ? 'absent'
          : !registrationIdentity?.fingerprintSha256 &&
              currentTransportMatches
            ? 'unverifiable'
          : currentIdentityMatches
            ? 'matched'
            : 'changed';
  return {
    configured: true as const,
    enabled:
      userPathContainsShim &&
      shimsPresent &&
      nativeTargetPresent &&
      recursionSafe,
    state: publicIntegrationState(state),
    userPathContainsShim,
    shimsPresent,
    nativeTargetPresent,
    recursionSafe,
    bridgeInspection:
      bridgeInspection === null
        ? null
        : {
            ...bridgeInspection,
            ownership,
          },
  };
}

export async function inspectNativeCodex(
  target: NativeCodexTarget,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const result = await runManagedProcess(
    target.command,
    [...target.prefixArguments, '--version'],
    {
      env: options.env,
      timeoutMs: options.timeoutMs ?? 5_000,
      reject: false,
    },
  );
  const version = (result.stdout || result.stderr)
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.slice(0, 200);
  return {
    ok: result.exitCode === 0,
    version: version || null,
    exitCode: result.exitCode,
  };
}

export async function doctorCodexIntegration(
  options: {
    env?: NodeJS.ProcessEnv;
    paths?: Partial<CodexIntegrationPaths>;
    userPathStore?: UserPathStore;
    nativeCandidatePaths?: readonly string[];
    checkVersion?: boolean;
  } = {},
) {
  const env = options.env ?? process.env;
  const paths = codexIntegrationPaths(env, options.paths);
  const status = await codexIntegrationStatus({
    env,
    paths,
    userPathStore: options.userPathStore,
  });
  const persisted = readCodexIntegrationState(paths);
  let target: NativeCodexTarget | null =
    persisted && nativeTargetFilesPresent(persisted.nativeTarget)
      ? persisted.nativeTarget
      : null;
  let resolutionError: string | null = null;
  let resolutionSource: 'stored' | 're-resolved' | 'path' | null =
    target ? 'stored' : null;
  if (!target) {
    try {
      target = resolveNativeCodex({
        env,
        candidatePaths: options.nativeCandidatePaths,
        excludedDirectories: [paths.shimDirectory],
      });
      resolutionSource = persisted ? 're-resolved' : 'path';
    } catch (error) {
      resolutionError = error instanceof Error ? error.message : String(error);
    }
  }
  const inspection =
    target && options.checkVersion !== false
      ? await inspectNativeCodex(target, { env }).catch((error: unknown) => ({
          ok: false,
          version: null,
          exitCode: null,
          error: error instanceof Error ? error.message : String(error),
        }))
      : null;
  return {
    integration: status,
    nativeCodex: {
      found: target !== null && nativeTargetFilesPresent(target),
      target,
      inspection,
      resolutionError,
      resolutionSource,
    },
    wrapperPath: status.state?.shimPaths.codex ?? [],
    rawBypassPath: status.state?.shimPaths.raw ?? [],
    recursionCheck: status.recursionSafe,
    mechanism: !status.configured
      ? 'native-unintegrated'
      : status.state?.bridge?.configured &&
          status.bridgeInspection?.ownership === 'matched'
        ? 'transparent-launcher-with-official-mcp-bridge'
        : 'transparent-launcher-passive-index-only',
    requiresNewTerminalAfterPathChange: true,
  };
}

export function nativeTargetFromIntegration(
  paths: CodexIntegrationPaths = codexIntegrationPaths(),
  options: {
    env?: NodeJS.ProcessEnv;
    candidatePaths?: readonly string[];
  } = {},
) {
  const state = readCodexIntegrationState(paths);
  if (!state) {
    return resolveNativeCodex({
      env: options.env,
      candidatePaths: options.candidatePaths,
      excludedDirectories: [paths.shimDirectory],
    });
  }
  if (
    pathWithin(state.nativeTarget.command, state.shimDirectory) ||
    pathWithin(state.nativeTarget.sourcePath, state.shimDirectory)
  ) {
    throw new Error(
      'Codex launcher recursion prevented: native target is inside the Lattice shim directory',
    );
  }
  const wrapperPaths = [
    ...state.shimPaths.codex,
    ...state.shimPaths.raw,
  ];
  const target = validateNativeCodexTarget(
    state.nativeTarget,
    wrapperPaths,
  );
  if (nativeTargetFilesPresent(target)) return target;
  return resolveNativeCodex({
    env: options.env,
    candidatePaths: options.candidatePaths,
    excludedPaths: wrapperPaths,
    excludedDirectories: [paths.shimDirectory],
  });
}
