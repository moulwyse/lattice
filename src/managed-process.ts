import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type ManagedProcessResult = {
  pid: number;
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
};

export type ManagedProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  reject?: boolean;
};

export type InheritedProcessResult = {
  pid: number;
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  cancelled: boolean;
};

export type InheritedProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  forwardSignals?: readonly NodeJS.Signals[];
};

export class ManagedProcessError extends Error {
  constructor(
    message: string,
    readonly result: ManagedProcessResult,
  ) {
    super(message);
    this.name = 'ManagedProcessError';
  }
}

export function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessAlive(pid);
}

async function runTaskkill(pid: number, timeoutMs = 2_000) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const killer = spawn(
      'taskkill',
      ['/PID', String(pid), '/T', '/F'],
      {
        detached: false,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // The taskkill process can close between the timeout and kill call.
      }
      finish(new Error(`taskkill timed out while terminating process tree: ${pid}`));
    }, timeoutMs);
    timeout.unref();
    killer.once('error', (error) => finish(error));
    killer.once('close', (code) => {
      if (code === 0 || code === 128) finish();
      else finish(new Error(`taskkill exited with code ${String(code)} for process tree: ${pid}`));
    });
  });
}

async function posixProcessTree(rootPid: number) {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn('ps', ['-eo', 'pid=,ppid='], {
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      child.stdout.destroy();
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'));
      else reject(new Error(`failed to inspect process tree for ${rootPid}`));
    });
  });
  const children = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const ordered: number[] = [];
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) {
      visit(child);
      ordered.push(child);
    }
  };
  visit(rootPid);
  return [...ordered, rootPid];
}

async function waitForAllToExit(pids: readonly number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isProcessAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

function executable(
  command: string,
  arguments_: readonly string[],
): { command: string; arguments: string[] } {
  if (
    process.platform !== 'win32' ||
    !['npm', 'npm.cmd', 'npx', 'npx.cmd'].includes(command.toLowerCase())
  ) {
    return { command, arguments: [...arguments_] };
  }
  const npx = command.toLowerCase().startsWith('npx');
  const configuredNpm = process.env.npm_execpath;
  const npmCli =
    configuredNpm && existsSync(configuredNpm)
      ? configuredNpm
      : join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cli = npx ? join(dirname(npmCli), 'npx-cli.js') : npmCli;
  if (!existsSync(cli)) {
    throw new Error(`cannot resolve Windows ${npx ? 'npx' : 'npm'} CLI`);
  }
  return {
    command: process.execPath,
    arguments: [cli, ...arguments_],
  };
}

/**
 * Terminates the exact child tree and waits until its root process is gone.
 * Windows requires taskkill /T because npm and cmd create intermediary
 * processes. Children are never detached.
 */
export async function terminateProcessTree(pid: number) {
  if (!isProcessAlive(pid)) return;
  if (process.platform === 'win32') {
    try {
      await runTaskkill(pid);
    } catch {
      // Some restricted Windows hosts can start taskkill but prevent it from
      // completing. Fall back to the exact process so cancellation never
      // leaves the foreground launcher waiting forever. Normal hosts still
      // take the taskkill /T path above and terminate the complete tree.
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  } else {
    const tree = await posixProcessTree(pid);
    for (const processId of tree) {
      try {
        process.kill(processId, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    if (!(await waitForAllToExit(tree, 1_000))) {
      for (const processId of tree.filter(isProcessAlive)) {
        try {
          process.kill(processId, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    if (!(await waitForAllToExit(tree, 2_000))) {
      throw new Error(`failed to terminate child process tree: ${pid}`);
    }
  }
  if (!(await waitForExit(pid, 2_000))) {
    throw new Error(`failed to terminate child process tree: ${pid}`);
  }
}

/**
 * Runs a captured, non-detached process and owns its complete lifecycle.
 * Timeout and cancellation terminate the process tree before this promise
 * settles. Streams, listeners, and timers are always released in finally.
 */
export async function runManagedProcess(
  command: string,
  arguments_: readonly string[],
  options: ManagedProcessOptions = {},
): Promise<ManagedProcessResult> {
  options.signal?.throwIfAborted();
  const resolved = executable(command, arguments_);
  const child = spawn(resolved.command, resolved.arguments, {
    cwd: options.cwd,
    env: options.env,
    detached: false,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid === undefined) {
    throw new Error(`failed to start child process: ${command}`);
  }
  const pid = child.pid;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));

  let timedOut = false;
  let cancelled = false;
  let termination: Promise<void> | undefined;
  const terminate = (reason: 'timeout' | 'cancelled') => {
    if (termination) return;
    timedOut ||= reason === 'timeout';
    cancelled ||= reason === 'cancelled';
    termination = terminateProcessTree(pid);
    void termination.catch(() => undefined);
  };
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => terminate('timeout'), options.timeoutMs);
  timeout?.unref();
  const cancel = () => terminate('cancelled');
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();

  try {
    const closed = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    await termination;
    const result: ManagedProcessResult = {
      pid,
      command,
      ...closed,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
      cancelled,
    };
    if (timedOut) {
      throw new ManagedProcessError(
        `child process timed out after ${options.timeoutMs}ms: ${command}`,
        result,
      );
    }
    if (cancelled) {
      throw new ManagedProcessError(`child process cancelled: ${command}`, result);
    }
    if (options.reject !== false && result.exitCode !== 0) {
      throw new ManagedProcessError(
        `child process exited with code ${String(result.exitCode)}: ${command}`,
        result,
      );
    }
    return result;
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

/**
 * Runs an interactive foreground process with the current terminal attached
 * directly. No stdin, stdout, or stderr bytes pass through JavaScript buffers.
 *
 * The returned exit code/signal belongs to the child so a CLI entry point can
 * mirror it. Cancellation owns and terminates the complete process tree.
 */
export async function runInheritedProcess(
  command: string,
  arguments_: readonly string[],
  options: InheritedProcessOptions = {},
): Promise<InheritedProcessResult> {
  options.signal?.throwIfAborted();
  const resolved = executable(command, arguments_);
  const startedAt = performance.now();
  const child = spawn(resolved.command, resolved.arguments, {
    cwd: options.cwd,
    env: options.env,
    detached: false,
    windowsHide: false,
    shell: false,
    stdio: 'inherit',
  });
  if (child.pid === undefined) {
    throw new Error(`failed to start foreground process: ${command}`);
  }
  const pid = child.pid;
  let cancelled = false;
  let termination: Promise<void> | undefined;
  const terminate = () => {
    if (termination) return;
    cancelled = true;
    termination = terminateProcessTree(pid);
    void termination.catch(() => undefined);
  };
  const cancel = () => terminate();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();

  const forwardedSignals =
    options.forwardSignals ?? (['SIGINT', 'SIGTERM', 'SIGHUP'] as const);
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of forwardedSignals) {
    const handler = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill(signal);
      } catch (error) {
        // The child can close between the status check and signal delivery.
        // Its close event remains the authoritative lifecycle result.
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const closed = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    await termination;
    return {
      pid,
      command,
      ...closed,
      elapsedMs: performance.now() - startedAt,
      cancelled,
    };
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
  }
}
