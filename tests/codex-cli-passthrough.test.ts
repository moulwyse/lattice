import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import {
  codexIntegrationPaths,
  disableCodexIntegration,
  enableCodexIntegration,
  type UserPathStore,
} from '../src/codex-integration.js';
import {
  isProcessAlive,
  terminateProcessTree,
} from '../src/managed-process.js';
import { sidecarPaths, stopSidecar } from '../src/sidecar.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'cli.js');
const activeCliPids = new Set<number>();

type Fixture = {
  root: string;
  workspace: string;
  localApplicationData: string;
  fakeNativePath: string;
  fakePidLog: string;
  fakeArgvPath: string;
  env: NodeJS.ProcessEnv;
  userPathStore: UserPathStore;
};

type CliResult = {
  pid: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
};

let fixture: Fixture | undefined;

function requireFixture() {
  if (!fixture) throw new Error('Codex passthrough fixture is not initialized');
  return fixture;
}

function fakeNativeSource() {
  return `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

if (process.env.FAKE_CODEX_PID_LOG) {
  appendFileSync(process.env.FAKE_CODEX_PID_LOG, String(process.pid) + '\\n');
}
if (process.env.FAKE_CODEX_ARGV_PATH) {
  writeFileSync(
    process.env.FAKE_CODEX_ARGV_PATH,
    JSON.stringify(process.argv.slice(2)),
    'utf8',
  );
}
if (process.env.FAKE_CODEX_ECHO_STDIN !== '0') {
  process.stdout.write(Buffer.concat(chunks));
}
if (process.env.FAKE_CODEX_STDERR) {
  process.stderr.write(process.env.FAKE_CODEX_STDERR);
}
const waitForFile = process.env.FAKE_CODEX_WAIT_FOR_FILE;
if (waitForFile) {
  const waitDeadline =
    Date.now() + Number(process.env.FAKE_CODEX_WAIT_FOR_FILE_TIMEOUT_MS || '20000');
  while (!existsSync(waitForFile) && Date.now() < waitDeadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS || '0');
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}
const requestedExitCode = Number(process.env.FAKE_CODEX_EXIT_CODE || '0');
process.exitCode = Number.isInteger(requestedExitCode) ? requestedExitCode : 1;
`;
}

function fakePids(value = requireFixture()) {
  if (!existsSync(value.fakePidLog)) return [];
  return readFileSync(value.fakePidLog, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

async function runCli(
  arguments_: readonly string[],
  options: {
    stdin?: Buffer;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeoutMs?: number;
    launcher?: 'direct' | 'cmd-shim' | 'powershell-shim';
  } = {},
): Promise<CliResult> {
  const value = requireFixture();
  const childEnvironment: NodeJS.ProcessEnv = {
    ...value.env,
    FAKE_CODEX_PID_LOG: value.fakePidLog,
    FAKE_CODEX_ARGV_PATH: value.fakeArgvPath,
    FAKE_CODEX_ECHO_STDIN: '1',
    FAKE_CODEX_EXIT_CODE: '0',
    FAKE_CODEX_STDERR: '',
    ...options.env,
  };
  delete childEnvironment.LATTICE_CODEX_LAUNCH_DEPTH;

  const launcher = options.launcher ?? 'direct';
  const integrationPaths = codexIntegrationPaths(value.env);
  const invocation =
    launcher === 'cmd-shim'
      ? {
          command:
            value.env.ComSpec ??
            join(value.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
          arguments: [
            '/d',
            '/c',
            'call',
            join(integrationPaths.shimDirectory, 'codex.cmd'),
            ...arguments_,
          ],
        }
      : launcher === 'powershell-shim'
        ? {
            command: join(
              value.env.SystemRoot ?? 'C:\\Windows',
              'System32',
              'WindowsPowerShell',
              'v1.0',
              'powershell.exe',
            ),
            arguments: [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              join(integrationPaths.shimDirectory, 'codex.ps1'),
              ...arguments_,
            ],
          }
        : {
            command: process.execPath,
            arguments: [cliPath, 'codex', ...arguments_],
          };
  const child = spawn(
    invocation.command,
    invocation.arguments,
    {
      cwd: options.cwd ?? value.workspace,
      env: childEnvironment,
      detached: false,
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  if (!child.pid) throw new Error('test CLI process did not start');
  const pid = child.pid;
  activeCliPids.add(pid);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });

  let timedOut = false;
  let termination: Promise<void> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    termination ??= terminateProcessTree(pid);
    void termination.catch(() => undefined);
  }, options.timeoutMs ?? 15_000);
  timeout.unref();

  try {
    child.stdin.end(options.stdin ?? Buffer.alloc(0));
    const closed = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveClose, rejectClose) => {
      child.once('error', rejectClose);
      child.once('close', (exitCode, signal) =>
        resolveClose({ exitCode, signal }),
      );
    });
    await termination;
    if (timedOut) {
      throw new Error(
        `fake Codex passthrough timed out after ${options.timeoutMs ?? 15_000}ms`,
      );
    }
    return {
      pid,
      ...closed,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    };
  } finally {
    clearTimeout(timeout);
    if (isProcessAlive(pid)) await terminateProcessTree(pid);
    activeCliPids.delete(pid);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

function readFakeArguments() {
  return JSON.parse(
    readFileSync(requireFixture().fakeArgvPath, 'utf8'),
  ) as string[];
}

function expectNoLatticeProgress(output: Buffer) {
  const text = output.toString('utf8');
  expect(text).not.toContain('task.compiled');
  expect(text).not.toContain('heartbeat');
  expect(text).not.toContain('[worker.');
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'lattice-codex-cli-'));
  const workspace = join(root, 'ordinary workspace');
  const localApplicationData = join(root, 'local app data');
  const fakeDirectory = join(root, 'fake native Codex');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(localApplicationData, { recursive: true });
  mkdirSync(fakeDirectory, { recursive: true });

  const fakeNativePath = join(fakeDirectory, 'fake codex.mjs');
  const fakePidLog = join(root, 'fake-codex-pids.log');
  const fakeArgvPath = join(root, 'fake-codex-argv.json');
  writeFileSync(fakeNativePath, fakeNativeSource(), 'utf8');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LOCALAPPDATA: localApplicationData,
  };
  let storedUserPath: string | null = process.env.PATH ?? null;
  const userPathStore: UserPathStore = {
    async read() {
      return storedUserPath;
    },
    async write(value) {
      storedUserPath = value;
    },
  };
  fixture = {
    root,
    workspace,
    localApplicationData,
    fakeNativePath,
    fakePidLog,
    fakeArgvPath,
    env,
    userPathStore,
  };

  await enableCodexIntegration({
    cliPath,
    env,
    userPathStore,
    nativeTarget: {
      schemaVersion: 1,
      command: process.execPath,
      prefixArguments: [fakeNativePath],
      sourcePath: fakeNativePath,
      sourceKind: 'injected',
    },
    verifyNative: false,
    registerMcp: false,
  });
});

afterEach(async () => {
  const value = fixture;
  fixture = undefined;
  const cleanupErrors: unknown[] = [];

  for (const pid of [...activeCliPids]) {
    try {
      if (isProcessAlive(pid)) await terminateProcessTree(pid);
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      activeCliPids.delete(pid);
    }
  }
  if (value) {
    for (const pid of fakePids(value)) {
      try {
        if (isProcessAlive(pid)) await terminateProcessTree(pid);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      if (existsSync(sidecarPaths(value.workspace).state)) {
        await stopSidecar(value.workspace);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await disableCodexIntegration({
        env: value.env,
        userPathStore: value.userPathStore,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await removeDirectoryWithRetry(value.root);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      'Codex passthrough fixture cleanup failed',
    );
  }
});

describe('transparent Codex CLI passthrough', () => {
  test('preserves stdin/stdout bytes, stderr, and every native argument', async () => {
    const nativeArguments = [
      '--model',
      'fake-model',
      '--some-flag',
      'hello world',
      '--',
      'literal value with spaces',
    ];
    const input = Buffer.from([
      0x00, 0x01, 0x02, 0x0a, 0x0d, 0x41, 0x80, 0xfe, 0xff,
    ]);
    const stderrSentinel = 'FAKE_NATIVE_STDERR_ONLY\r\n';

    const result = await runCli(nativeArguments, {
      stdin: input,
      env: { FAKE_CODEX_STDERR: stderrSentinel },
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.equals(input)).toBe(true);
    expect(result.stderr.equals(Buffer.from(stderrSentinel))).toBe(true);
    expect(readFakeArguments()).toEqual(nativeArguments);
    expect(isProcessAlive(result.pid)).toBe(false);
    expect(fakePids()).toHaveLength(1);
    expect(isProcessAlive(fakePids()[0])).toBe(false);
  });

  test('mirrors the exact native exit code', async () => {
    const result = await runCli(['--fake-exit-test'], {
      env: {
        FAKE_CODEX_ECHO_STDIN: '0',
        FAKE_CODEX_EXIT_CODE: '37',
      },
    });

    expect(result.exitCode).toBe(37);
    expect(result.signal).toBeNull();
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(isProcessAlive(fakePids()[0])).toBe(false);
  });

  test('preserves a leading native option terminator exactly', async () => {
    const nativeArguments = ['--', '--literal-option', 'prompt with spaces'];

    const result = await runCli(nativeArguments, {
      env: { FAKE_CODEX_ECHO_STDIN: '0' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(readFakeArguments()).toEqual(nativeArguments);
  });

  test.skipIf(process.platform !== 'win32')(
    'generated cmd and PowerShell shims execute the transparent launcher',
    async () => {
      const nativeArguments = [
        '--model',
        'shim model',
        '--some-flag',
        'prompt with spaces',
      ];

      for (const launcher of ['cmd-shim', 'powershell-shim'] as const) {
        const result = await runCli(nativeArguments, {
          launcher,
          stdin: Buffer.from(`stdin-through-${launcher}\n`, 'utf8'),
        });

        expect(
          result.exitCode,
          result.stderr.toString('utf8'),
        ).toBe(0);
        expect(result.stdout.toString('utf8')).toBe(
          `stdin-through-${launcher}\n`,
        );
        expect(result.stderr.length).toBe(0);
        expect(readFakeArguments()).toEqual(nativeArguments);
      }
    },
  );

  test('raw mode consumes only the Lattice flag and never starts a sidecar', async () => {
    const value = requireFixture();
    writeFileSync(
      join(value.workspace, 'lattice.config.json'),
      `${JSON.stringify({ schemaVersion: 1 })}\n`,
      'utf8',
    );
    const nativeArguments = ['--model', 'raw model', 'prompt with spaces'];

    const result = await runCli(['--raw', ...nativeArguments], {
      env: {
        FAKE_CODEX_ECHO_STDIN: '0',
        FAKE_CODEX_STDERR: 'RAW_NATIVE_STDERR\n',
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.toString('utf8')).toBe('RAW_NATIVE_STDERR\n');
    expect(readFakeArguments()).toEqual(nativeArguments);
    expect(existsSync(sidecarPaths(value.workspace).directory)).toBe(false);
    expect(isProcessAlive(fakePids()[0])).toBe(false);
  });

  test('never contaminates native streams with progress or heartbeat output', async () => {
    const input = Buffer.from('native stdout sentinel\n', 'utf8');
    const result = await runCli(['--stream-test', 'argument with spaces'], {
      stdin: input,
      env: { FAKE_CODEX_STDERR: 'native stderr sentinel\n' },
    });

    expect(result.stdout.equals(input)).toBe(true);
    expect(result.stderr.toString('utf8')).toBe('native stderr sentinel\n');
    expectNoLatticeProgress(result.stdout);
    expectNoLatticeProgress(result.stderr);
  });

  test(
    'keeps native streams clean while a real repository sidecar attaches',
    async () => {
      const value = requireFixture();
      writeFileSync(
        join(value.workspace, 'lattice.config.json'),
        `${JSON.stringify({ schemaVersion: 1 })}\n`,
        'utf8',
      );
      const input = Buffer.from('native-sidecar-stdout\n', 'utf8');
      const result = await runCli(['--sidecar-integration-test'], {
        stdin: input,
        env: {
          FAKE_CODEX_STDERR: 'native-sidecar-stderr\n',
          FAKE_CODEX_DELAY_MS: '1500',
          LATTICE_SIDECAR_IDLE_MS: '200',
          LATTICE_SIDECAR_LEASE_TTL_MS: '3000',
        },
        timeoutMs: 20_000,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.equals(input)).toBe(true);
      expect(result.stderr.toString('utf8')).toBe('native-sidecar-stderr\n');
      expectNoLatticeProgress(result.stdout);
      expectNoLatticeProgress(result.stderr);

      const paths = sidecarPaths(value.workspace);
      const deadline = Date.now() + 10_000;
      while (existsSync(paths.state) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 40));
      }
      expect(existsSync(paths.state)).toBe(false);
      expect(existsSync(paths.lock)).toBe(false);
      expect(existsSync(paths.telemetry)).toBe(true);
    },
    30_000,
  );

  test(
    'completes ten sequential launches without leaking a fake Codex child',
    async () => {
      const observedPids: number[] = [];
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const input = Buffer.from(`native-run-${iteration}\n`, 'utf8');
        const nativeArguments = [
          '--iteration',
          String(iteration),
          `argument ${iteration} with spaces`,
        ];
        const result = await runCli(nativeArguments, {
          stdin: input,
          env: {
            FAKE_CODEX_STDERR: `native-stderr-${iteration}\n`,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout.equals(input)).toBe(true);
        expect(result.stderr.toString('utf8')).toBe(
          `native-stderr-${iteration}\n`,
        );
        expect(readFakeArguments()).toEqual(nativeArguments);
        expectNoLatticeProgress(result.stdout);
        expectNoLatticeProgress(result.stderr);
        expect(isProcessAlive(result.pid)).toBe(false);
        observedPids.push(fakePids().at(-1)!);
      }

      expect(observedPids).toHaveLength(10);
      // Windows may legally reuse a PID after the preceding child exits. Leak
      // safety depends on every observed PID being dead and the active set
      // being empty, not on historical PID uniqueness.
      expect(observedPids.every((pid) => !isProcessAlive(pid))).toBe(true);
      expect(activeCliPids.size).toBe(0);
    },
    60_000,
  );

  test(
    'two native sessions in one repository share one sidecar safely',
    async () => {
      const value = requireFixture();
      writeFileSync(
        join(value.workspace, 'lattice.config.json'),
        `${JSON.stringify({ schemaVersion: 1 })}\n`,
        'utf8',
      );
      const sharedEnvironment = {
        FAKE_CODEX_ECHO_STDIN: '0',
        FAKE_CODEX_WAIT_FOR_FILE: join(value.root, 'release-native-sessions'),
        FAKE_CODEX_WAIT_FOR_FILE_TIMEOUT_MS: '20000',
        LATTICE_SIDECAR_IDLE_MS: '3000',
        LATTICE_SIDECAR_LEASE_TTL_MS: '5000',
      };

      const first = runCli(['--session', 'one'], {
        env: sharedEnvironment,
        timeoutMs: 20_000,
      });
      const second = runCli(['--session', 'two'], {
        env: sharedEnvironment,
        timeoutMs: 20_000,
      });
      const paths = sidecarPaths(value.workspace);
      const deadline = Date.now() + 10_000;
      let observed:
        | { pid: number; activeLeases: number; repositoryId: string }
        | undefined;
      try {
        while (Date.now() < deadline) {
          if (existsSync(paths.state)) {
            try {
              observed = JSON.parse(readFileSync(paths.state, 'utf8')) as {
                pid: number;
                activeLeases: number;
                repositoryId: string;
              };
              if (observed.activeLeases === 2) break;
            } catch {
              // Atomic state replacement can briefly race this diagnostic read.
            }
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        }
      } finally {
        writeFileSync(sharedEnvironment.FAKE_CODEX_WAIT_FOR_FILE, '', 'utf8');
      }

      expect(observed?.activeLeases).toBe(2);
      expect(observed?.pid).toBeGreaterThan(0);
      expect(observed?.repositoryId).toMatch(/^repo:[a-f0-9]{64}$/);
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
      expect(results.every((result) => result.stdout.length === 0)).toBe(true);
      expect(results.every((result) => result.stderr.length === 0)).toBe(true);
      expect(new Set(fakePids()).size).toBe(2);
      expect(fakePids().every((pid) => !isProcessAlive(pid))).toBe(true);

      expect(await stopSidecar(value.workspace)).toBe(true);
      expect(existsSync(paths.state)).toBe(false);
      expect(existsSync(paths.lock)).toBe(false);
    },
    30_000,
  );

  test('injects routing instructions when integrated inside a safe repository', async () => {
    const value = requireFixture();
    writeFileSync(
      join(value.workspace, 'lattice.config.json'),
      `${JSON.stringify({ schemaVersion: 1 })}\n`,
      'utf8',
    );
    const result = await runCli(['--some-flag'], {
      env: { FAKE_CODEX_ECHO_STDIN: '0' },
    });
    expect(result.exitCode).toBe(0);
    const args = readFakeArguments();
    expect(args).toContain('-c');
    const devInst = args.find(a => a.startsWith('developer_instructions='));
    expect(devInst).toBeDefined();
    expect(devInst).toContain('For repository discovery and source reads, prefer the available Lattice MCP context tools');
  });

  test('merges custom developer instructions with routing instructions', async () => {
    const value = requireFixture();
    writeFileSync(
      join(value.workspace, 'lattice.config.json'),
      `${JSON.stringify({ schemaVersion: 1 })}\n`,
      'utf8',
    );
    const result = await runCli(['-c', 'developer_instructions="my custom instructions"', '--some-flag'], {
      env: { FAKE_CODEX_ECHO_STDIN: '0' },
    });
    expect(result.exitCode).toBe(0);
    const args = readFakeArguments();
    expect(args).toContain('-c');
    const devInst = args.find(a => a.startsWith('developer_instructions='));
    expect(devInst).toBeDefined();
    expect(devInst).toContain('my custom instructions');
    expect(devInst).toContain('For repository discovery and source reads, prefer the available Lattice MCP context tools');
  });

  test('merges global developer instructions from config.toml', async () => {
    const value = requireFixture();
    writeFileSync(
      join(value.workspace, 'lattice.config.json'),
      `${JSON.stringify({ schemaVersion: 1 })}\n`,
      'utf8',
    );
    const mockCodexHome = join(value.root, 'mock-codex-home');
    mkdirSync(mockCodexHome);
    writeFileSync(
      join(mockCodexHome, 'config.toml'),
      'developer_instructions = "my global instructions"\n',
      'utf8',
    );
    const result = await runCli(['--some-flag'], {
      env: {
        FAKE_CODEX_ECHO_STDIN: '0',
        CODEX_HOME: mockCodexHome,
      },
    });
    expect(result.exitCode).toBe(0);
    const args = readFakeArguments();
    expect(args).toContain('-c');
    const devInst = args.find(a => a.startsWith('developer_instructions='));
    expect(devInst).toBeDefined();
    expect(devInst).toContain('my global instructions');
    expect(devInst).toContain('For repository discovery and source reads, prefer the available Lattice MCP context tools');
  });

  test('raw mode does not inject routing instructions', async () => {
    const value = requireFixture();
    writeFileSync(
      join(value.workspace, 'lattice.config.json'),
      `${JSON.stringify({ schemaVersion: 1 })}\n`,
      'utf8',
    );
    const result = await runCli(['--raw', '--some-flag'], {
      env: { FAKE_CODEX_ECHO_STDIN: '0' },
    });
    expect(result.exitCode).toBe(0);
    const args = readFakeArguments();
    const devInst = args.find(a => a.startsWith('developer_instructions='));
    expect(devInst).toBeUndefined();
  });

  test('does not inject routing instructions outside a safe repository', async () => {
    const result = await runCli(['--some-flag'], {
      env: { FAKE_CODEX_ECHO_STDIN: '0' },
    });
    expect(result.exitCode).toBe(0);
    const args = readFakeArguments();
    const devInst = args.find(a => a.startsWith('developer_instructions='));
    expect(devInst).toBeUndefined();
  });
});
