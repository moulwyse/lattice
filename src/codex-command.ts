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

function unquoteTomlString(val: string): string {
  val = val.trim();
  if (val.startsWith('"""') && val.endsWith('"""')) {
    val = val.slice(3, -3);
  } else if (val.startsWith("'''") && val.endsWith("'''")) {
    val = val.slice(3, -3);
  } else if (val.startsWith('"') && val.endsWith('"')) {
    val = val.slice(1, -1);
  } else if (val.startsWith("'") && val.endsWith("'")) {
    val = val.slice(1, -1);
  }
  return val
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function getGlobalDeveloperInstructions(env?: NodeJS.ProcessEnv): string | null {
  try {
    const codexHome = env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex');
    const configPath = join(codexHome, 'config.toml');
    if (!existsSync(configPath)) return null;
    const content = readFileSync(configPath, 'utf8');
    const match = content.match(/^\s*developer_instructions\s*=\s*(.*)$/m);
    if (!match || !match[1]) return null;
    return unquoteTomlString(match[1]);
  } catch {
    return null;
  }
}

function injectRoutingInstructions(
  args: readonly string[],
  routingInstructions: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  let existingInstructions: string | null = null;
  const filteredArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-c' || arg === '--config') {
      const next = args[i + 1];
      if (next && next.startsWith('developer_instructions=')) {
        existingInstructions = unquoteTomlString(next.slice('developer_instructions='.length));
        i++; // consume next
        continue;
      } else {
        filteredArgs.push(arg);
        if (next !== undefined) {
          filteredArgs.push(next);
          i++;
        }
        continue;
      }
    } else if (arg.startsWith('-cdeveloper_instructions=')) {
      existingInstructions = unquoteTomlString(arg.slice('-cdeveloper_instructions='.length));
      continue;
    } else if (arg.startsWith('--config=developer_instructions=')) {
      existingInstructions = unquoteTomlString(arg.slice('--config=developer_instructions='.length));
      continue;
    }

    filteredArgs.push(arg);
  }

  if (existingInstructions === null) {
    existingInstructions = getGlobalDeveloperInstructions(env);
  }

  const merged = existingInstructions
    ? `${existingInstructions}\n\n${routingInstructions}`
    : routingInstructions;

  return [...filteredArgs, '-c', `developer_instructions=${JSON.stringify(merged)}`];
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
    nativeArguments = injectRoutingInstructions(nativeArguments, LATTICE_ROUTING_INSTRUCTIONS, options.env);
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
