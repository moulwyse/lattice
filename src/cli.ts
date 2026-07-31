#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runResetTokenBenchmark } from './benchmark.js';
import { runCodexCommand } from './codex-command.js';
import { runCodexSessionSync } from './codex-session-sync.js';
import {
  codexIntegrationStatus,
  disableCodexIntegration,
  doctorCodexIntegration,
  enableCodexIntegration,
} from './codex-integration.js';
import { doctor } from './doctor.js';
import { Events } from './events.js';
import { continueHandoff, startHandoff, validateHandoff } from './handoff.js';
import {
  listSessions,
  loadSession,
  newSession,
  resetSession,
} from './persistence.js';
import { runTask } from './runtime.js';
import { runMcpServer } from './mcp-server.js';
import { parseModelPolicy, parseReasoningEffort } from './model-settings.js';
import {
  inspectSidecarCommand,
  runSidecarCommand,
  stopSidecarCommand,
} from './sidecar-command.js';

const program = new Command()
  .name('lattice')
  .description('Lattice repository context and execution layer')
  .version('Lattice 0.1.0 by Moulwyse')
  .option('--about', 'show project authorship, repository, and license')
  .action((options) => {
    if (!options.about) {
      program.help();
      return;
    }
    console.log(`Lattice 0.1.0

Originally created and developed by Moulwyse.
Original author: https://github.com/moulwyse
Canonical repository: https://github.com/moulwyse/lattice
License: Apache-2.0`);
  });

const cliPath = fileURLToPath(import.meta.url);

function isCliEntrypoint(argument: string | undefined) {
  if (!argument) return false;
  const candidate = resolve(argument);
  try {
    return realpathSync.native(candidate) === realpathSync.native(cliPath);
  } catch {
    return candidate === cliPath;
  }
}

function eventStream(json: boolean) {
  const events = new Events();
  events.on((event) => {
    if (json) {
      console.error(JSON.stringify(event));
    } else {
      console.error(`[${event.type}] ${event.message}`);
    }
  });
  return events;
}

function printResult(result: Awaited<ReturnType<typeof runTask>>, json: boolean) {
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`Task: ${result.taskId}`);
  console.log(`Status: ${result.status}`);
  if (result.error) console.log(`Error: ${result.error}`);
  if (result.modelConfiguration) {
    const configuration = result.modelConfiguration as {
      modelSource: string;
      reasoningEffortSource: string;
    };
    console.log(
      `Model: ${String(result.model ?? 'inherited')} (${configuration.modelSource})`,
    );
    console.log(
      `Reasoning: ${String(result.reasoningEffort ?? 'inherited')} (${configuration.reasoningEffortSource})`,
    );
  }
  console.log(`Telemetry: ${JSON.stringify(result.telemetry)}`);
}

export async function executeRun(
  goal: string,
  options: {
    worker: 'codex' | 'mock' | 'manual';
    json?: boolean;
    workspace?: string;
    retainWorktree?: boolean;
    signal?: AbortSignal;
    model?: string;
    reasoningEffort?: string;
    modelPolicy?: string;
    verifiedCache?: boolean;
  },
) {
  const workspace = resolve(options.workspace ?? process.cwd());
  if (options.worker === 'manual') {
    const state = await startHandoff(workspace, goal);
    const value = {
      status: 'manual_handoff_required',
      taskId: state.taskId,
      sessionId: state.sessionId,
      requestPath: state.requestPath,
      responsePath: state.responsePath,
      continueCommand: `lattice continue ${state.taskId}`,
    };
    if (options.json) console.log(JSON.stringify(value));
    else {
      console.log('Manual handoff required.');
      console.log(`Request: ${state.requestPath}`);
      console.log('Send this request to ChatGPT/Sol.');
      console.log(`Save the returned canonical JSON as: ${state.responsePath}`);
      console.log(`Continue with: lattice continue ${state.taskId}`);
    }
    return;
  }

  const controller = new AbortController();
  const events = eventStream(Boolean(options.json));
  const heartbeat = setInterval(
    () => console.error(JSON.stringify({ type: 'heartbeat', at: new Date().toISOString() })),
    10_000,
  );
  const interrupt = () => controller.abort(new Error('cancelled by user'));
  const cancel = () => controller.abort(options.signal?.reason);
  process.once('SIGINT', interrupt);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const result = await runTask(workspace, goal, {
      worker: options.worker,
      json: options.json,
      signal: controller.signal,
      retainWorktree: options.retainWorktree,
      model: options.model,
      reasoningEffort: parseReasoningEffort(options.reasoningEffort),
      modelPolicy: options.modelPolicy
        ? parseModelPolicy(options.modelPolicy, '--model-policy')
        : undefined,
      useVerifiedCache: options.verifiedCache,
      events,
    });
    printResult(result, Boolean(options.json));
    if (result.status === 'failed' || result.status === 'cancelled') process.exitCode = 1;
    else if (result.status === 'partial') process.exitCode = 2;
  } finally {
    clearInterval(heartbeat);
    process.removeListener('SIGINT', interrupt);
    options.signal?.removeEventListener('abort', cancel);
  }
}

program
  .command('run')
  .description('Run a task')
  .argument('<goal>', 'task goal')
  .option('--worker <worker>', 'codex, mock, or manual', 'codex')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .option('--model <model>', 'override Codex model; omit to inherit Codex config')
  .option(
    '--reasoning-effort <effort>',
    'minimal, low, medium, high, or xhigh; omit to inherit Codex config',
  )
  .option('--model-policy <policy>', 'inherit or adaptive')
  .option('--json', 'emit one JSON result to stdout')
  .option('--retain-worktree', 'retain the isolated worktree for debugging')
  .option('--no-verified-cache', 'disable exact verified-patch reuse')
  .action(async (goal, options) => {
    if (!['codex', 'mock', 'manual'].includes(options.worker)) {
      throw new Error(`unsupported worker: ${options.worker}`);
    }
    await executeRun(goal, options);
  });

program
  .command('continue')
  .description('Continue a persisted manual handoff')
  .argument('<task-id>')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .option('--json')
  .action(async (taskId, options) => {
    const output = await continueHandoff(resolve(options.workspace), taskId);
    if (options.json) console.log(JSON.stringify(output));
    else if (output.response.kind === 'context_request') {
      console.log('Additional context handoff required.');
      console.log(`Request: ${output.state.requestPath}`);
      console.log(`Save response as: ${output.state.responsePath}`);
      console.log(`Continue with: lattice continue ${taskId}`);
    } else {
      console.log(`Task: ${taskId}`);
      console.log(`Status: ${output.result?.status}`);
    }
  });

const handoff = program.command('handoff').description('Manual handoff utilities');
handoff
  .command('validate')
  .argument('<task-id>')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action((taskId, options) => {
    validateHandoff(resolve(options.workspace), taskId);
    console.log('Manual response is valid');
  });

const session = program.command('session').description('Session management');
session
  .command('new')
  .option('--worker <worker>', 'worker name', 'codex')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action((options) => console.log(JSON.stringify(newSession(resolve(options.workspace), options.worker))));
session
  .command('show')
  .argument('[session-id]')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action((id, options) => {
    const workspace = resolve(options.workspace);
    console.log(JSON.stringify(id ? loadSession(workspace, id) : listSessions(workspace), null, 2));
  });
session
  .command('reset')
  .argument('[session-id]')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action((id, options) => {
    const workspace = resolve(options.workspace);
    const target = id ?? listSessions(workspace)[0]?.id;
    if (!target) throw new Error('No session is available to reset');
    resetSession(workspace, target);
    console.log(`Session reset: ${target}`);
  });

program
  .command('doctor')
  .description('Check runtime, repository, authentication, and line endings')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action(async (options) => console.log(JSON.stringify(await doctor(resolve(options.workspace)), null, 2)));

const sidecar = program
  .command('sidecar')
  .description('Run or inspect the repository-scoped Lattice sidecar')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action(async (options) => {
    await runSidecarCommand(resolve(options.workspace), {
      foreground: true,
      persistent: true,
    });
  });
sidecar
  .command('serve')
  .description('Run the managed sidecar process')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action(async (options) => {
    await runSidecarCommand(resolve(options.workspace), {
      foreground: false,
      persistent: false,
    });
  });
sidecar
  .command('status')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action(async (options) => {
    console.log(JSON.stringify(await inspectSidecarCommand(resolve(options.workspace)), null, 2));
  });
sidecar
  .command('stop')
  .option('--workspace <path>', 'repository workspace', process.cwd())
  .action(async (options) => {
    const stopped = await stopSidecarCommand(resolve(options.workspace));
    console.log(stopped ? 'Lattice sidecar stopped' : 'Lattice sidecar is not running');
  });

program
  .command('mcp-server')
  .description('Run the read-only Lattice context bridge over MCP stdio')
  .action(async () => {
    await runMcpServer();
  });

program
  .command('codex-session-sync', { hidden: true })
  .description('Synchronize active Codex session settings into Lattice')
  .action(async () => {
    // Hooks are synchronization hints, never a reason to interrupt Codex.
    // The launcher and MCP bridge remain independent fallback paths.
    await runCodexSessionSync(stdin).catch(() => undefined);
  });

program
  .command('codex')
  .description('Launch the official Codex CLI with transparent Lattice infrastructure')
  .allowUnknownOption(true)
  .allowExcessArguments(true);

async function codexIntegrationView(workspace: string, checkVersion = false) {
  const [integration, repositoryState] = await Promise.all([
    doctorCodexIntegration({ checkVersion }),
    inspectSidecarCommand(workspace),
  ]);
  const sidecarState = repositoryState.sidecar.state;
  const observedTelemetry =
    sidecarState?.telemetry ??
    ('lastTelemetry' in repositoryState.sidecar
      ? repositoryState.sidecar.lastTelemetry?.telemetry
      : undefined);
  const bridgeConfigured =
    integration.integration.state?.bridge?.configured === true &&
    integration.integration.bridgeInspection?.ownership === 'matched';
  const bridgeActive =
    repositoryState.sidecar.running &&
    sidecarState !== null &&
    sidecarState.mode === 'mcp-assisted-context' &&
    (observedTelemetry?.contextGrantCount ?? 0) > 0;
  return {
    schemaVersion: 1,
    nativeCodex: integration.nativeCodex,
    integration: integration.integration,
    wrapperPath: integration.wrapperPath,
    rawBypassPath: integration.rawBypassPath,
    recursionCheck: integration.recursionCheck,
    mechanism: integration.mechanism,
    repository: repositoryState.repository,
    sidecar: repositoryState.sidecar,
    ipcAvailable: repositoryState.sidecar.running,
    bridge: {
      mechanism: 'official-mcp',
      configured: bridgeConfigured,
      active: bridgeActive,
      requestCount: observedTelemetry?.bridgeRequestCount ?? 0,
      contextBytesSupplied: observedTelemetry?.contextBytesSupplied ?? 0,
    },
    mode: bridgeActive ? 'mcp-assisted-context' : 'passive-index-only',
    limitation:
      'Lattice-first hooks require one context-tool attempt before the first ordinary repository tool in each turn; later native reads and edits are not transparently routed through Lattice or Aegis.',
  };
}

function printCodexIntegrationView(
  view: Awaited<ReturnType<typeof codexIntegrationView>>,
) {
  console.log(
    `Codex: ${view.nativeCodex.found ? 'native connected' : 'native not found'}`,
  );
  console.log(
    `Native path: ${view.nativeCodex.target?.sourcePath ?? 'unavailable'}`,
  );
  console.log(`Wrapper: ${view.wrapperPath[0] ?? 'not configured'}`);
  console.log(`Mechanism: ${view.mechanism}`);
  console.log(
    `Lattice integration: ${view.integration.enabled ? 'enabled' : 'disabled'}`,
  );
  console.log(
    `Lattice sidecar: ${view.sidecar.running ? view.sidecar.state?.status : 'stopped'}`,
  );
  console.log(
    `Repository: ${view.repository.safe ? view.repository.root : 'no safe repository detected'}`,
  );
  console.log(`Terra indexed files: ${view.sidecar.state?.indexedFiles ?? 0}`);
  console.log(
    `Bridge: ${view.bridge.active ? 'active' : view.bridge.configured ? 'configured, not observed' : 'unavailable'}`,
  );
  console.log(`Mode: ${view.mode}`);
}

const integration = program
  .command('integration')
  .description('Manage optional integrations');
const codexIntegration = integration
  .command('codex')
  .description('Manage the transparent official Codex integration');
codexIntegration
  .command('enable')
  .description('Enable the Codex launcher, MCP bridge, and session sync hooks')
  .action(async () => {
    const result = await enableCodexIntegration({
      cliPath,
      registerHooks: true,
    });
    console.log(
      result.changed
        ? 'Codex integration enabled. Open a new terminal before using codex.'
        : 'Codex integration is already configured.',
    );
    console.log(`Native Codex: ${result.state.nativeTarget.sourcePath}`);
    console.log(`Wrapper: ${result.state.shimDirectory}`);
    console.log(
      `MCP bridge: ${result.state.bridge?.configured ? 'configured' : `not configured (${result.state.bridge?.configurationError ?? 'disabled'})`}`,
    );
    console.log(
      `Session sync: ${result.state.hooks ? 'configured (review once with /hooks)' : 'not configured'}`,
    );
    console.log('Raw bypass: codex-raw  (or: lattice codex --raw)');
  });
codexIntegration
  .command('disable')
  .description('Remove only Lattice-owned shims and MCP registration')
  .action(async () => {
    const result = await disableCodexIntegration();
    if (!result.changed) {
      console.log('Codex integration is not configured.');
    } else if (result.pendingBridgeCleanup || result.pendingHookCleanup) {
      console.log(
        'Codex launcher disabled, but owned integration cleanup is still pending. Run this disable command again after resolving the warning.',
      );
      process.exitCode = 1;
    } else {
      console.log(
        'Codex integration disabled. Open a new terminal to refresh PATH.',
      );
    }
    for (const warning of result.warnings ?? []) {
      console.log(`Cleanup warning: ${warning}`);
    }
  });
codexIntegration
  .command('status')
  .option('--workspace <path>', 'working directory to inspect', process.cwd())
  .option('--json', 'emit versioned JSON')
  .action(async (options) => {
    const view = await codexIntegrationView(resolve(options.workspace), false);
    if (options.json) console.log(JSON.stringify(view));
    else printCodexIntegrationView(view);
  });
codexIntegration
  .command('doctor')
  .option('--workspace <path>', 'working directory to inspect', process.cwd())
  .option('--json', 'emit versioned JSON')
  .action(async (options) => {
    const view = await codexIntegrationView(resolve(options.workspace), true);
    if (options.json) console.log(JSON.stringify(view));
    else {
      printCodexIntegrationView(view);
      console.log(
        `Native version: ${view.nativeCodex.inspection?.version ?? 'unavailable'}`,
      );
      console.log(
        `Bridge registration: ${view.integration.bridgeInspection?.ownership ?? 'not configured'}`,
      );
      console.log(
        `Recursion check: ${view.recursionCheck ? 'safe' : 'failed'}`,
      );
      console.log(`IPC: ${view.ipcAvailable ? 'available' : 'not active'}`);
      console.log(`Boundary: ${view.limitation}`);
    }
  });

program
  .command('benchmark')
  .description('Run the deterministic reset-token benchmark')
  .option('--worker <worker>', 'mock or codex', 'mock')
  .option('--workspace <path>', 'artifact workspace', process.cwd())
  .option('--model <model>', 'override Codex model; omit to inherit Codex config')
  .option(
    '--reasoning-effort <effort>',
    'minimal, low, medium, high, or xhigh; omit to inherit Codex config',
  )
  .option('--model-policy <policy>', 'inherit or adaptive')
  .option('--json')
  .action(async (options) => {
    if (!['mock', 'codex'].includes(options.worker)) throw new Error('worker must be mock or codex');
    const output = await runResetTokenBenchmark(
      resolve(options.workspace),
      options.worker,
      eventStream(Boolean(options.json)),
      undefined,
      {
        model: options.model,
        reasoningEffort: parseReasoningEffort(options.reasoningEffort),
        modelPolicy: options.modelPolicy
          ? parseModelPolicy(options.modelPolicy, '--model-policy')
          : undefined,
      },
    );
    if (options.json) console.log(JSON.stringify(output));
    else {
      console.log(`Benchmark artifact: ${output.path}`);
      console.log(`Status: ${output.artifact.result.status}`);
      console.log(`Telemetry: ${JSON.stringify(output.artifact.result.telemetry)}`);
    }
  });

async function interactive() {
  console.error('Lattice interactive CLI. Enter a task, or /exit.');
  const reader = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const line = (await reader.question('lattice> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/session new') {
        console.log(JSON.stringify(newSession(process.cwd(), 'codex')));
        continue;
      }
      await executeRun(line, { worker: 'codex' });
    }
  } finally {
    reader.close();
  }
}

if (isCliEntrypoint(process.argv[1])) {
  try {
    if (process.argv[2] === 'codex') {
      const forwarded = process.argv.slice(3);
      const raw = forwarded[0] === '--raw';
      if (raw) forwarded.shift();
      await runCodexCommand(forwarded, { raw });
    } else if (process.argv.length === 2) {
      await interactive();
    } else {
      await program.parseAsync();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
