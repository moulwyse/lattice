import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  codexIntegrationPaths,
  nativeTargetFromIntegration,
  readCodexIntegrationState,
  resolveNativeCodex,
} from './codex-integration.js';
import { launchNativeCodex } from './codex-launcher.js';
import { discoverRepository } from './repository.js';
import { ensureSidecar } from './sidecar.js';

export const LATTICE_ROUTING_INSTRUCTIONS =
  'For repository discovery and source reads, prefer the available Lattice MCP context tools.\n' +
  'Use lattice_search_context to locate relevant repository content and lattice_read_context for bounded reads.\n' +
  'Use native shell/filesystem reads only when Lattice cannot provide the required information or runtime/generated state must be inspected.\n' +
  'Use native editing tools normally.';

const TOML_ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\',
};

/**
 * Parse one TOML string value (basic, literal, or their multi-line forms)
 * starting at `start`. Returns null for anything that is not a complete
 * string, so callers can refuse to guess.
 */
export function parseTomlString(text: string, start: number) {
  const multiLine = text.startsWith('"""', start) || text.startsWith("'''", start);
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;
  const delimiter = multiLine ? quote.repeat(3) : quote;
  let index = start + delimiter.length;
  if (multiLine && text.startsWith('\r\n', index)) index += 2;
  else if (multiLine && text[index] === '\n') index += 1;
  let value = '';
  while (index < text.length) {
    if (text.startsWith(delimiter, index)) {
      return { value, end: index + delimiter.length };
    }
    const character = text[index];
    if (!multiLine && (character === '\n' || character === '\r')) return null;
    if (quote === "'" || character !== '\\') {
      value += character;
      index += 1;
      continue;
    }
    const escape = text[index + 1];
    if (escape === undefined) return null;
    if (escape in TOML_ESCAPES) {
      value += TOML_ESCAPES[escape];
      index += 2;
    } else if (escape === 'u' || escape === 'U') {
      const length = escape === 'u' ? 4 : 8;
      const hex = text.slice(index + 2, index + 2 + length);
      if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) return null;
      value += String.fromCodePoint(Number.parseInt(hex, 16));
      index += 2 + length;
    } else if (multiLine && /[ \t\r\n]/.test(escape)) {
      // Line-ending backslash: trim the newline and following whitespace.
      const rest = /^\\[ \t]*\r?\n[ \t\r\n]*/.exec(text.slice(index));
      if (!rest) return null;
      index += rest[0].length;
    } else {
      return null;
    }
  }
  return null;
}

type ConfiguredInstructions =
  | { kind: 'none' }
  | { kind: 'value'; value: string }
  | { kind: 'unreadable' };

/**
 * `developer_instructions` from a Codex config file. Only a top-level string
 * is understood; a value in a profile or an unusual form is reported as
 * unreadable so the launcher never replaces instructions it cannot merge.
 */
export function configuredDeveloperInstructions(content: string): ConfiguredInstructions {
  if (!/developer_instructions/.test(content)) return { kind: 'none' };
  const assignment = /^[ \t]*developer_instructions[ \t]*=[ \t]*/m.exec(content);
  if (!assignment) return { kind: 'unreadable' };
  const before = content.slice(0, assignment.index);
  if (/^[ \t]*\[/m.test(before)) return { kind: 'unreadable' };
  const parsed = parseTomlString(content, assignment.index + assignment[0].length);
  if (!parsed) return { kind: 'unreadable' };
  const rest = content.slice(parsed.end).split(/\r?\n/, 1)[0] ?? '';
  if (!/^[ \t]*(?:#.*)?$/.test(rest)) return { kind: 'unreadable' };
  return { kind: 'value', value: parsed.value };
}

function configuredInstructions(cwd: string, env?: NodeJS.ProcessEnv): ConfiguredInstructions {
  const codexHome = env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
  // A project config takes precedence over the user config in Codex.
  for (const path of [join(cwd, '.codex', 'config.toml'), join(codexHome, 'config.toml')]) {
    try {
      if (!existsSync(path)) continue;
      const configured = configuredDeveloperInstructions(readFileSync(path, 'utf8'));
      if (configured.kind !== 'none') return configured;
    } catch {
      return { kind: 'unreadable' };
    }
  }
  return { kind: 'none' };
}

function commandLineInstructions(value: string) {
  return parseTomlString(value.trim(), 0)?.value ?? value;
}

/**
 * Add the Lattice routing note to Codex developer instructions. The override
 * is placed before every other argument (root options are accepted ahead of
 * any subcommand, and never after `--`), and existing instructions are merged
 * rather than replaced. When they cannot be read reliably, nothing is added.
 */
export function injectRoutingInstructions(
  args: readonly string[],
  routingInstructions: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string[] {
  let existingInstructions: string | null = null;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      filteredArgs.push(...args.slice(i));
      break;
    }
    if (arg === '-c' || arg === '--config') {
      const next = args[i + 1];
      if (next && next.startsWith('developer_instructions=')) {
        existingInstructions = commandLineInstructions(next.slice('developer_instructions='.length));
        i++;
        continue;
      }
      filteredArgs.push(arg);
      if (next !== undefined) {
        filteredArgs.push(next);
        i++;
      }
      continue;
    }
    if (arg.startsWith('-cdeveloper_instructions=')) {
      existingInstructions = commandLineInstructions(arg.slice('-cdeveloper_instructions='.length));
      continue;
    }
    if (arg.startsWith('--config=developer_instructions=')) {
      existingInstructions = commandLineInstructions(
        arg.slice('--config=developer_instructions='.length),
      );
      continue;
    }
    filteredArgs.push(arg);
  }

  if (existingInstructions === null) {
    const configured = configuredInstructions(options.cwd ?? process.cwd(), options.env);
    if (configured.kind === 'unreadable') return [...args];
    if (configured.kind === 'value') existingInstructions = configured.value;
  }

  const merged = existingInstructions
    ? `${existingInstructions}\n\n${routingInstructions}`
    : routingInstructions;

  return ['-c', `developer_instructions=${JSON.stringify(merged)}`, ...filteredArgs];
}

function compactError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .replace(
      /\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      '$1=<redacted>',
    )
    .slice(0, 500);
}

function recordInfrastructureError(
  error: Error,
  env: NodeJS.ProcessEnv = process.env,
) {
  try {
    const paths = codexIntegrationPaths(env);
    const logDirectory = join(paths.stateDirectory, 'logs');
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(
      join(logDirectory, 'launcher-errors.log'),
      `${new Date().toISOString()} ${compactError(error)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Infrastructure diagnostics must never contaminate or block native Codex.
  }
}

export async function attachCodexInfrastructure(
  cwd: string,
  signal: AbortSignal,
) {
  const repository = await discoverRepository(cwd, { signal });
  if (!repository.safe) return null;
  return ensureSidecar(repository.root, {
    clientKind: 'launcher',
    signal,
  });
}

function signalExitCode(signal: NodeJS.Signals) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  if (signal === 'SIGHUP') return 129;
  return 1;
}

export async function runCodexCommand(
  arguments_: readonly string[],
  options: {
    raw?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    attachInfrastructure?: typeof attachCodexInfrastructure;
  } = {},
) {
  const paths = codexIntegrationPaths(options.env);
  let state: ReturnType<typeof readCodexIntegrationState> = null;
  let target;
  try {
    state = readCodexIntegrationState(paths);
    target = nativeTargetFromIntegration(paths, { env: options.env });
  } catch {
    // A damaged Lattice manifest must not make the official CLI unreachable.
    // The shim directory is excluded so fallback resolution cannot recurse.
    target = resolveNativeCodex({
      env: options.env,
      excludedDirectories: [paths.shimDirectory],
    });
  }
  const ownedBridgeName =
    options.raw === true &&
    state?.bridge?.createdByLattice === true
      ? state.bridge.serverName
      : null;

  const cwd = options.cwd ?? process.cwd();
  const repository = await discoverRepository(cwd).catch(() => ({ safe: false as const }));
  const isSafeRepo = repository.safe;

  let nativeArguments = [...arguments_];
  if (options.raw !== true && isSafeRepo) {
    nativeArguments = injectRoutingInstructions(nativeArguments, LATTICE_ROUTING_INSTRUCTIONS, {
      cwd,
      env: options.env,
    });
  } else if (ownedBridgeName) {
    nativeArguments = [
      '-c',
      `mcp_servers.${ownedBridgeName}.enabled=false`,
      ...nativeArguments,
    ];
  }

  const result = await launchNativeCodex(nativeArguments, {
    target,
    cwd: options.cwd,
    env: options.env,
    raw: options.raw,
    wrapperPaths: state
      ? [...state.shimPaths.codex, ...state.shimPaths.raw]
      : [],
    attachInfrastructure:
      options.attachInfrastructure ?? attachCodexInfrastructure,
    onInfrastructureError: (error) =>
      recordInfrastructureError(error, options.env),
  });
  process.exitCode =
    result.exitCode ?? (result.signal ? signalExitCode(result.signal) : 1);
  return result;
}
