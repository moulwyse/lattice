import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import {
  codexIntegrationPaths,
  codexIntegrationStatus,
  disableCodexIntegration,
  enableCodexIntegration,
  nativeTargetFromIntegration,
  readCodexIntegrationState,
  registerCodexMcpBridge,
  type CodexCommandRunner,
  type UserPathStore,
} from '../src/codex-integration.js';
import { runCodexCommand } from '../src/codex-command.js';
import {
  CODEX_LAUNCHER_DEPTH_ENV,
  launchNativeCodex,
  type NativeCodexTarget,
} from '../src/codex-launcher.js';
import { isProcessAlive } from '../src/managed-process.js';
import { discoverRepository } from '../src/repository.js';

type IntegrationFixture = {
  root: string;
  cliPath: string;
  nativeScript: string;
  paths: ReturnType<typeof codexIntegrationPaths>;
  target: NativeCodexTarget;
  originalUserPath: string;
  pathStore: UserPathStore;
  readPath: ReturnType<typeof vi.fn>;
  writePath: ReturnType<typeof vi.fn>;
  currentPath(): string | null;
};

function target(command: string, script: string): NativeCodexTarget {
  return {
    schemaVersion: 1,
    command: resolve(command),
    prefixArguments: [resolve(script)],
    sourcePath: resolve(script),
    sourceKind: 'injected',
  };
}

describe('Codex integration lifecycle', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  function fixture(): IntegrationFixture {
    const root = mkdtempSync(join(tmpdir(), 'lattice-codex-integration-'));
    cleanups.push(() => removeDirectoryWithRetry(root));
    const cliPath = join(root, 'lattice-cli.mjs');
    const nativeScript = join(root, 'official-codex.mjs');
    writeFileSync(cliPath, 'export {};\n');
    writeFileSync(nativeScript, 'process.exit(0);\n');
    const paths = codexIntegrationPaths(
      {},
      {
        stateDirectory: join(root, 'state'),
        shimDirectory: join(root, 'state', 'bin'),
        statePath: join(root, 'state', 'integration.json'),
      },
    );
    const originalUserPath = [
      join(root, 'before'),
      join(root, 'official-bin'),
      join(root, 'after'),
    ].join(delimiter);
    let currentPath: string | null = originalUserPath;
    const readPath = vi.fn(async () => currentPath);
    const writePath = vi.fn(async (value: string | null) => {
      currentPath = value;
    });
    return {
      root,
      cliPath,
      nativeScript,
      paths,
      target: target(process.execPath, nativeScript),
      originalUserPath,
      pathStore: { read: readPath, write: writePath },
      readPath,
      writePath,
      currentPath: () => currentPath,
    };
  }

  function successfulRunner() {
    const calls: { target: NativeCodexTarget; arguments: readonly string[] }[] = [];
    let entry: Record<string, unknown> | null = null;
    const runner = vi.fn<CodexCommandRunner>(async (native, arguments_) => {
      calls.push({ target: native, arguments: [...arguments_] });
      if (arguments_.length === 1 && arguments_[0] === '--version') {
        return {
          exitCode: 0,
          stdout: 'codex-cli 0.144.5\n',
          stderr: '',
        };
      }
      if (arguments_.join('\0') === ['mcp', 'list', '--json'].join('\0')) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify(
            entry ? [{ name: 'lattice', ...entry }] : [],
          )}\n`,
          stderr: '',
        };
      }
      if (arguments_[0] === 'mcp' && arguments_[1] === 'add') {
        const separator = arguments_.indexOf('--');
        entry = {
          enabled: true,
          transport: {
            type: 'stdio',
            command: arguments_[separator + 1],
            args: arguments_.slice(separator + 2),
          },
        };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (arguments_[0] === 'mcp' && arguments_[1] === 'remove') {
        entry = null;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected fake Codex call: ${arguments_.join(' ')}`);
    });
    return {
      runner,
      calls,
      currentEntry: () => entry,
      replaceEntry(value: Record<string, unknown> | null) {
        entry = value;
      },
    };
  }

  test('enables, reports, and exactly disables the official MCP integration', async () => {
    const integration = fixture();
    const fake = successfulRunner();

    const enabled = await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      codexCommandRunner: fake.runner,
    });

    expect(enabled.changed).toBe(true);
    expect(enabled.state.nativeVersion).toBe('codex-cli 0.144.5');
    expect(enabled.state.nativeTarget).toEqual(integration.target);
    expect(enabled.state.originalUserPath).toBe(integration.originalUserPath);
    expect(enabled.state.enabledUserPath).toBe(
      [integration.paths.shimDirectory, integration.originalUserPath].join(
        delimiter,
      ),
    );
    expect(integration.currentPath()).toBe(enabled.state.enabledUserPath);
    expect(enabled.state.bridge).toMatchObject({
      mechanism: 'mcp',
      serverName: 'lattice',
      configured: true,
      createdByLattice: true,
      preExisting: false,
      configurationError: null,
      registrationIdentity: {
        schemaVersion: 1,
        fingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        command: resolve(process.execPath),
        arguments: [resolve(integration.cliPath), 'mcp-server'],
      },
    });

    const shimPaths = [
      ...enabled.state.shimPaths.codex,
      ...enabled.state.shimPaths.raw,
    ];
    expect(shimPaths).toHaveLength(process.platform === 'win32' ? 6 : 2);
    expect(shimPaths.every(existsSync)).toBe(true);
    expect(
      shimPaths.every((path) =>
        readFileSync(path, 'utf8').includes('Lattice managed Codex shim'),
      ),
    ).toBe(true);
    expect(
      enabled.state.shimPaths.raw.every((path) =>
        readFileSync(path, 'utf8').includes('--raw'),
      ),
    ).toBe(true);
    expect(readCodexIntegrationState(integration.paths)).toEqual(enabled.state);
    expect(nativeTargetFromIntegration(integration.paths)).toEqual(
      integration.target,
    );

    expect(fake.calls.map((call) => call.arguments)).toEqual([
      ['--version'],
      ['mcp', 'list', '--json'],
      [
        'mcp',
        'add',
        'lattice',
        '--',
        resolve(process.execPath),
        resolve(integration.cliPath),
        'mcp-server',
      ],
      ['mcp', 'list', '--json'],
    ]);

    const status = await codexIntegrationStatus({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: fake.runner,
    });
    expect(status).toMatchObject({
      configured: true,
      enabled: true,
      userPathContainsShim: true,
      shimsPresent: true,
      nativeTargetPresent: true,
      recursionSafe: true,
      bridgeInspection: {
        supported: true,
        exists: true,
        ownership: 'matched',
      },
    });
    expect(status.state).not.toHaveProperty('originalUserPath');
    expect(status.state).not.toHaveProperty('enabledUserPath');

    const enableAgain = await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      codexCommandRunner: fake.runner,
    });
    expect(enableAgain).toEqual({ changed: false, state: enabled.state });
    expect(fake.runner).toHaveBeenCalledTimes(6);

    const disabled = await disableCodexIntegration({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: fake.runner,
    });
    expect(disabled).toEqual({
      changed: true,
      restoration: 'exact',
      bridgeRemoved: true,
      bridgeCleanup: 'removed',
      complete: true,
      pendingBridgeCleanup: false,
      pendingHookCleanup: false,
      warnings: [],
    });
    expect(integration.currentPath()).toBe(integration.originalUserPath);
    expect(integration.writePath).toHaveBeenLastCalledWith(
      integration.originalUserPath,
    );
    expect(fake.calls.at(-1)?.arguments).toEqual([
      'mcp',
      'remove',
      'lattice',
    ]);
    expect(shimPaths.some(existsSync)).toBe(false);
    expect(existsSync(integration.paths.statePath)).toBe(false);

    await expect(
      disableCodexIntegration({
        paths: integration.paths,
        userPathStore: integration.pathStore,
        codexCommandRunner: fake.runner,
      }),
    ).resolves.toEqual({
      changed: false,
      restoration: 'not-installed',
      bridgeRemoved: false,
      bridgeCleanup: 'not-owned',
      complete: true,
      pendingBridgeCleanup: false,
      pendingHookCleanup: false,
      warnings: [],
    });
    expect(fake.runner).toHaveBeenCalledTimes(8);
  });

  test('installs and removes owned Codex session sync hooks with the integration', async () => {
    const integration = fixture();
    const fake = successfulRunner();
    const hooksPath = join(integration.root, 'codex-home', 'hooks.json');

    const enabled = await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      codexCommandRunner: fake.runner,
      registerHooks: true,
      hooksPath,
    });

    expect(enabled.state.hooks).toMatchObject({
      schemaVersion: 1,
      path: resolve(hooksPath),
      createdFile: true,
    });
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(hooks.hooks.SessionStart).toHaveLength(1);
    expect(hooks.hooks.UserPromptSubmit).toHaveLength(1);

    const disabled = await disableCodexIntegration({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: fake.runner,
    });
    expect(disabled).toMatchObject({
      complete: true,
      pendingHookCleanup: false,
    });
    expect(existsSync(hooksPath)).toBe(false);
  });

  test('persists recoverable ownership when post-add MCP inspection is unavailable', async () => {
    const integration = fixture();
    let listCalls = 0;
    let entry: Record<string, unknown> | null = null;
    const runner: CodexCommandRunner = vi.fn(async (_target, arguments_) => {
      if (arguments_.slice(0, 3).join(' ') === 'mcp list --json') {
        listCalls += 1;
        if (listCalls === 1) {
          return { exitCode: 0, stdout: '[]', stderr: '' };
        }
        if (listCalls === 2) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'temporary post-add inspection failure',
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            entry ? [{ name: 'lattice', ...entry }] : [],
          ),
          stderr: '',
        };
      }
      if (arguments_[0] === 'mcp' && arguments_[1] === 'add') {
        const separator = arguments_.indexOf('--');
        entry = {
          enabled: true,
          transport: {
            type: 'stdio',
            command: arguments_[separator + 1],
            args: arguments_.slice(separator + 2),
          },
        };
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (arguments_[0] === 'mcp' && arguments_[1] === 'remove') {
        entry = null;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected fake Codex call: ${arguments_.join(' ')}`);
    });

    const enabled = await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      codexCommandRunner: runner,
      verifyNative: false,
    });

    expect(enabled.state.bridge).toMatchObject({
      configured: false,
      createdByLattice: true,
      configurationError: expect.stringContaining(
        'temporary post-add inspection failure',
      ),
      registrationIdentity: {
        fingerprintSha256: null,
        command: resolve(process.execPath),
        arguments: [resolve(integration.cliPath), 'mcp-server'],
      },
    });
    expect(readCodexIntegrationState(integration.paths)).toEqual(enabled.state);

    const status = await codexIntegrationStatus({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: runner,
    });
    expect(status.bridgeInspection?.ownership).toBe('unverifiable');

    entry = {
      ...entry,
      env: { USER_ADDED_SETTING: 'preserve-me' },
    };
    const disabled = await disableCodexIntegration({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: runner,
    });
    expect(disabled).toMatchObject({
      bridgeCleanup: 'unverifiable',
      complete: false,
      pendingBridgeCleanup: true,
    });
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      env: { USER_ADDED_SETTING: 'preserve-me' },
    });
    expect(existsSync(integration.paths.statePath)).toBe(true);
    expect(
      (runner as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([, arguments_]) => arguments_[1] === 'remove',
      ),
    ).toHaveLength(0);

    entry = null;
    await expect(
      disableCodexIntegration({
        paths: integration.paths,
        userPathStore: integration.pathStore,
        codexCommandRunner: runner,
      }),
    ).resolves.toMatchObject({
      bridgeCleanup: 'absent',
      complete: true,
      pendingBridgeCleanup: false,
    });
    expect(existsSync(integration.paths.statePath)).toBe(false);
  });

  test('protects a pre-existing lattice MCP server from overwrite and removal', async () => {
    const integration = fixture();
    const runner = vi.fn<CodexCommandRunner>(async (_native, arguments_) => {
      if (arguments_[0] === '--version') {
        return {
          exitCode: 0,
          stdout: 'codex-cli 0.144.5\n',
          stderr: '',
        };
      }
      if (arguments_[1] === 'list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ name: 'lattice', enabled: true }]),
          stderr: '',
        };
      }
      throw new Error(`pre-existing MCP entry must not be changed: ${arguments_}`);
    });

    const enabled = await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      codexCommandRunner: runner,
    });

    expect(enabled.state.bridge).toEqual({
      mechanism: 'mcp',
      serverName: 'lattice',
      configured: false,
      createdByLattice: false,
      preExisting: true,
      configurationError:
        'an MCP server named lattice already exists and was not overwritten',
      registrationIdentity: null,
    });
    expect(runner).toHaveBeenCalledTimes(2);

    const disabled = await disableCodexIntegration({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: runner,
    });
    expect(disabled.bridgeRemoved).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  test('does not claim or remove a same-name entry replaced during registration', async () => {
    const integration = fixture();
    let listCount = 0;
    const calls: string[][] = [];
    const runner = vi.fn<CodexCommandRunner>(async (_native, arguments_) => {
      calls.push([...arguments_]);
      if (arguments_[1] === 'list') {
        listCount += 1;
        return {
          exitCode: 0,
          stdout:
            listCount === 1
              ? '[]'
              : JSON.stringify([
                  {
                    name: 'lattice',
                    enabled: true,
                    transport: {
                      type: 'stdio',
                      command: 'user-replacement.exe',
                      args: ['serve'],
                    },
                  },
                ]),
          stderr: '',
        };
      }
      if (arguments_[1] === 'add') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected call: ${arguments_.join(' ')}`);
    });

    await expect(
      registerCodexMcpBridge(
        integration.target,
        process.execPath,
        integration.cliPath,
        runner,
      ),
    ).rejects.toThrow(/exact Lattice command/i);
    expect(calls.filter((arguments_) => arguments_[1] === 'remove')).toEqual(
      [],
    );
  });

  test('rejects a native target inside the managed shim directory', async () => {
    const integration = fixture();
    const recursiveTargetPath = join(
      integration.paths.shimDirectory,
      'codex-recursive.mjs',
    );
    const recursive = target(process.execPath, recursiveTargetPath);

    await expect(
      enableCodexIntegration({
        cliPath: integration.cliPath,
        paths: integration.paths,
        userPathStore: integration.pathStore,
        nativeTarget: recursive,
        registerMcp: false,
        verifyNative: false,
      }),
    ).rejects.toThrow(/recursion prevented/i);
    expect(integration.writePath).not.toHaveBeenCalled();
    expect(existsSync(integration.paths.statePath)).toBe(false);
  });

  test('rolls back shims, state, and an MCP registration when PATH write fails', async () => {
    const integration = fixture();
    const fake = successfulRunner();
    const failingPathStore: UserPathStore = {
      read: async () => integration.originalUserPath,
      write: async () => {
        throw new Error('injected user PATH write failure');
      },
    };

    await expect(
      enableCodexIntegration({
        cliPath: integration.cliPath,
        paths: integration.paths,
        userPathStore: failingPathStore,
        nativeTarget: integration.target,
        codexCommandRunner: fake.runner,
      }),
    ).rejects.toThrow('injected user PATH write failure');

    expect(existsSync(integration.paths.statePath)).toBe(false);
    expect(
      existsSync(integration.paths.shimDirectory)
        ? readdirSync(integration.paths.shimDirectory)
        : [],
    ).toEqual([]);
    expect(fake.calls.at(-1)?.arguments).toEqual([
      'mcp',
      'remove',
      'lattice',
    ]);
  });

  test('persists ownership before MCP add and retains it when rollback cannot verify removal', async () => {
    const integration = fixture();
    let listCalls = 0;
    let entry: Record<string, unknown> | null = null;
    let intentWasDurableBeforeAdd = false;
    const unavailableRunner = vi.fn<CodexCommandRunner>(
      async (_native, arguments_) => {
        if (arguments_.join('\0') === ['mcp', 'list', '--json'].join('\0')) {
          listCalls += 1;
          if (listCalls === 1) {
            return { exitCode: 0, stdout: '[]', stderr: '' };
          }
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'temporary inspection outage',
          };
        }
        if (arguments_[0] === 'mcp' && arguments_[1] === 'add') {
          intentWasDurableBeforeAdd = existsSync(integration.paths.statePath);
          const separator = arguments_.indexOf('--');
          entry = {
            enabled: true,
            transport: {
              type: 'stdio',
              command: arguments_[separator + 1],
              args: arguments_.slice(separator + 2),
            },
          };
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected fake Codex call: ${arguments_.join(' ')}`);
      },
    );
    const failingPathStore: UserPathStore = {
      read: async () => integration.originalUserPath,
      write: async () => {
        throw new Error('injected user PATH write failure');
      },
    };

    await expect(
      enableCodexIntegration({
        cliPath: integration.cliPath,
        paths: integration.paths,
        userPathStore: failingPathStore,
        nativeTarget: integration.target,
        codexCommandRunner: unavailableRunner,
        verifyNative: false,
      }),
    ).rejects.toThrow(/could not be rolled back/i);

    expect(intentWasDurableBeforeAdd).toBe(true);
    expect(readCodexIntegrationState(integration.paths)?.bridge).toMatchObject({
      createdByLattice: true,
      registrationIdentity: {
        fingerprintSha256: null,
        command: resolve(process.execPath),
        arguments: [resolve(integration.cliPath), 'mcp-server'],
      },
    });
    expect(
      existsSync(integration.paths.shimDirectory)
        ? readdirSync(integration.paths.shimDirectory)
        : [],
    ).toEqual([]);

    const recoveryRunner = vi.fn<CodexCommandRunner>(
      async (_native, arguments_) => {
        if (arguments_.join('\0') === ['mcp', 'list', '--json'].join('\0')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              entry ? [{ name: 'lattice', ...entry }] : [],
            ),
            stderr: '',
          };
        }
        if (arguments_[0] === 'mcp' && arguments_[1] === 'remove') {
          entry = null;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected recovery call: ${arguments_.join(' ')}`);
      },
    );
    await expect(
      disableCodexIntegration({
        paths: integration.paths,
        userPathStore: integration.pathStore,
        codexCommandRunner: recoveryRunner,
      }),
    ).resolves.toMatchObject({
      complete: false,
      pendingBridgeCleanup: true,
      bridgeCleanup: 'unverifiable',
    });
    expect(entry).not.toBeNull();
    expect(existsSync(integration.paths.statePath)).toBe(true);

    entry = null;
    await expect(
      disableCodexIntegration({
        paths: integration.paths,
        userPathStore: integration.pathStore,
        codexCommandRunner: recoveryRunner,
      }),
    ).resolves.toMatchObject({
      complete: true,
      pendingBridgeCleanup: false,
      bridgeCleanup: 'absent',
    });
    expect(existsSync(integration.paths.statePath)).toBe(false);
  });

  test('never removes a same-name MCP entry changed after Lattice registration', async () => {
    const integration = fixture();
    const fake = successfulRunner();
    const enabled = await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      codexCommandRunner: fake.runner,
    });
    const shimPaths = [
      ...enabled.state.shimPaths.codex,
      ...enabled.state.shimPaths.raw,
    ];

    fake.replaceEntry({
      enabled: true,
      transport: {
        type: 'stdio',
        command: 'user-owned-server.exe',
        args: ['serve'],
      },
    });
    const disabled = await disableCodexIntegration({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: fake.runner,
    });

    expect(disabled).toMatchObject({
      changed: true,
      bridgeRemoved: false,
      bridgeCleanup: 'changed',
      complete: true,
      pendingBridgeCleanup: false,
      warnings: [expect.stringContaining('has changed')],
    });
    expect(integration.currentPath()).toBe(integration.originalUserPath);
    expect(shimPaths.some(existsSync)).toBe(false);
    expect(existsSync(integration.paths.statePath)).toBe(false);
    expect(fake.currentEntry()).toMatchObject({
      transport: { command: 'user-owned-server.exe' },
    });
    expect(
      fake.calls.filter((call) => call.arguments[1] === 'remove'),
    ).toHaveLength(0);

    await expect(
      disableCodexIntegration({
        paths: integration.paths,
        userPathStore: integration.pathStore,
        codexCommandRunner: fake.runner,
      }),
    ).resolves.toMatchObject({ changed: false, complete: true });
    expect(fake.currentEntry()).toMatchObject({
      transport: { command: 'user-owned-server.exe' },
    });
  });

  test('treats an already absent owned MCP registration as idempotently cleaned', async () => {
    const integration = fixture();
    const fake = successfulRunner();
    await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      codexCommandRunner: fake.runner,
    });
    fake.replaceEntry(null);

    const disabled = await disableCodexIntegration({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: fake.runner,
    });

    expect(disabled).toMatchObject({
      bridgeRemoved: false,
      bridgeCleanup: 'absent',
      warnings: [],
    });
    expect(integration.currentPath()).toBe(integration.originalUserPath);
    expect(existsSync(integration.paths.statePath)).toBe(false);
  });

  test('restores PATH and shims when matching MCP removal fails', async () => {
    const integration = fixture();
    const fake = successfulRunner();
    const runner = vi.fn<CodexCommandRunner>(async (native, arguments_) => {
      if (arguments_[0] === 'mcp' && arguments_[1] === 'remove') {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'injected MCP removal failure',
        };
      }
      return fake.runner(native, arguments_);
    });
    const enabled = await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      codexCommandRunner: runner,
    });
    const shimPaths = [
      ...enabled.state.shimPaths.codex,
      ...enabled.state.shimPaths.raw,
    ];

    const disabled = await disableCodexIntegration({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      codexCommandRunner: runner,
    });

    expect(disabled).toMatchObject({
      changed: true,
      bridgeRemoved: false,
      bridgeCleanup: 'failed',
      complete: false,
      pendingBridgeCleanup: true,
      warnings: [expect.stringContaining('injected MCP removal failure')],
    });
    expect(integration.currentPath()).toBe(integration.originalUserPath);
    expect(shimPaths.some(existsSync)).toBe(false);
    expect(existsSync(integration.paths.statePath)).toBe(true);

    await expect(
      disableCodexIntegration({
        paths: integration.paths,
        userPathStore: integration.pathStore,
        codexCommandRunner: fake.runner,
      }),
    ).resolves.toMatchObject({
      complete: true,
      pendingBridgeCleanup: false,
      bridgeCleanup: 'removed',
    });
    expect(existsSync(integration.paths.statePath)).toBe(false);
  });

  test('public status omits original and enabled user PATH values', async () => {
    const integration = fixture();
    const secretPath = 'PATH_SECRET_SENTINEL_DO_NOT_EXPOSE';
    await integration.pathStore.write(secretPath);
    await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      registerMcp: false,
      verifyNative: false,
    });

    const status = await codexIntegrationStatus({
      paths: integration.paths,
      userPathStore: integration.pathStore,
    });

    expect(JSON.stringify(status)).not.toContain(secretPath);
    expect(status.state).not.toHaveProperty('originalUserPath');
    expect(status.state).not.toHaveProperty('enabledUserPath');
  });

  test('re-resolves a stale stored native target outside the shim directory', async () => {
    const integration = fixture();
    await enableCodexIntegration({
      cliPath: integration.cliPath,
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      registerMcp: false,
      verifyNative: false,
    });
    rmSync(integration.nativeScript);

    const recovered = nativeTargetFromIntegration(integration.paths, {
      candidatePaths: [process.execPath],
    });

    expect(recovered).toMatchObject({
      command: resolve(process.execPath),
      sourcePath: resolve(process.execPath),
      sourceKind: 'native-executable',
    });
    await disableCodexIntegration({
      paths: integration.paths,
      userPathStore: integration.pathStore,
      nativeCandidatePaths: [process.execPath],
    });
  });

  test('raw command prepends a per-invocation disable for the owned MCP bridge', async () => {
    const integration = fixture();
    const localApplicationData = join(integration.root, 'raw-local-data');
    const env = {
      ...process.env,
      LOCALAPPDATA: localApplicationData,
      RAW_CODEX_ARGUMENTS_PATH: join(integration.root, 'raw-arguments.json'),
    };
    const paths = codexIntegrationPaths(env);
    writeFileSync(
      integration.nativeScript,
      `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.RAW_CODEX_ARGUMENTS_PATH, JSON.stringify(process.argv.slice(2)));
`,
    );
    await enableCodexIntegration({
      cliPath: integration.cliPath,
      env,
      userPathStore: integration.pathStore,
      nativeTarget: integration.target,
      bridge: {
        mechanism: 'mcp',
        serverName: 'lattice',
        configured: true,
        createdByLattice: true,
        preExisting: false,
        configurationError: null,
        registrationIdentity: {
          schemaVersion: 1,
          fingerprintSha256: 'a'.repeat(64),
          command: process.execPath,
          arguments: [integration.cliPath, 'mcp-server'],
        },
      },
      verifyNative: false,
    });
    const attachInfrastructure = vi.fn();
    const nativeArguments = ['--model', 'fake-model', 'prompt with spaces'];

    const result = await runCodexCommand(nativeArguments, {
      raw: true,
      cwd: integration.root,
      env,
      attachInfrastructure,
    });

    expect(result.exitCode).toBe(0);
    expect(attachInfrastructure).not.toHaveBeenCalled();
    expect(
      JSON.parse(readFileSync(env.RAW_CODEX_ARGUMENTS_PATH, 'utf8')),
    ).toEqual([
      '-c',
      'mcp_servers.lattice.enabled=false',
      ...nativeArguments,
    ]);
    process.exitCode = undefined;
    await disableCodexIntegration({
      env,
      userPathStore: integration.pathStore,
      codexCommandRunner: async () => ({
        exitCode: 0,
        stdout: '[]',
        stderr: '',
      }),
    });
    expect(existsSync(paths.statePath)).toBe(false);
  });
});

describe('transparent native Codex launcher', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  function launcherFixture() {
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'lattice-codex-launcher-')),
    );
    cleanups.push(() => removeDirectoryWithRetry(root));
    const script = join(root, 'fake-native-codex.mjs');
    const artifact = join(root, 'invocation.json');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';
const [artifact, ...arguments_] = process.argv.slice(2);
const delay = Number(process.env.FAKE_CODEX_DELAY_MS || 0);
if (delay > 0) await new Promise((resolveWait) => setTimeout(resolveWait, delay));
writeFileSync(artifact, JSON.stringify({
  pid: process.pid,
  arguments: arguments_,
  cwd: process.cwd(),
  depth: process.env.${CODEX_LAUNCHER_DEPTH_ENV}
}));
if (process.env.FAKE_CODEX_BLOCK === '1') {
  await new Promise(() => setInterval(() => undefined, 1_000));
}
process.exit(Number(process.env.FAKE_CODEX_EXIT_CODE || 0));
`,
    );
    return {
      root,
      script,
      artifact,
      target: target(process.execPath, script),
    };
  }

  test('forwards exact arguments and returns the native exit code in raw mode', async () => {
    const fixture = launcherFixture();
    const attachInfrastructure = vi.fn();
    const arguments_ = [
      '--model',
      'gpt-5.6',
      'prompt with spaces',
      '--',
      '--literal-option',
    ];

    const result = await launchNativeCodex(arguments_, {
      target: {
        ...fixture.target,
        prefixArguments: [fixture.script, fixture.artifact],
      },
      cwd: fixture.root,
      raw: true,
      env: {
        FAKE_CODEX_EXIT_CODE: '23',
        [CODEX_LAUNCHER_DEPTH_ENV]: '0',
      },
      attachInfrastructure,
    });

    expect(result).toMatchObject({
      exitCode: 23,
      signal: null,
      cancelled: false,
      raw: true,
      infrastructure: 'disabled',
      infrastructureError: null,
    });
    expect(attachInfrastructure).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(fixture.artifact, 'utf8'))).toMatchObject({
      arguments: arguments_,
      cwd: resolve(fixture.root),
      depth: '1',
    });
  });

  test('degrades on an infrastructure failure without changing native success', async () => {
    const fixture = launcherFixture();
    const infrastructureError = new Error('injected sidecar startup failure');
    const onInfrastructureError = vi.fn();

    const result = await launchNativeCodex([], {
      target: {
        ...fixture.target,
        prefixArguments: [fixture.script, fixture.artifact],
      },
      cwd: fixture.root,
      env: { [CODEX_LAUNCHER_DEPTH_ENV]: '0' },
      attachInfrastructure: async () => {
        throw infrastructureError;
      },
      onInfrastructureError,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      raw: false,
      infrastructure: 'degraded',
      infrastructureError: 'injected sidecar startup failure',
    });
    expect(onInfrastructureError).toHaveBeenCalledWith(infrastructureError);
    expect(existsSync(fixture.artifact)).toBe(true);
  });

  test('starts native Codex from the user home without granting an index root', async () => {
    const fixture = launcherFixture();
    const attachInfrastructure = vi.fn(async (cwd: string) => {
      const repository = await discoverRepository(cwd);
      expect(repository.safe).toBe(false);
      return null;
    });

    const result = await launchNativeCodex([], {
      target: {
        ...fixture.target,
        prefixArguments: [fixture.script, fixture.artifact],
      },
      cwd: homedir(),
      env: { [CODEX_LAUNCHER_DEPTH_ENV]: '0' },
      attachInfrastructure,
    });

    expect(result.exitCode).toBe(0);
    expect(result.infrastructure).toBe('degraded');
    expect(attachInfrastructure).toHaveBeenCalledWith(
      resolve(homedir()),
      expect.any(AbortSignal),
    );
  });

  test('aborts unfinished infrastructure when a short native command exits', async () => {
    const fixture = launcherFixture();
    const onInfrastructureError = vi.fn();
    let infrastructureSignal: AbortSignal | undefined;
    const attachInfrastructure = vi.fn(
      async (_cwd: string, signal: AbortSignal) => {
        infrastructureSignal = signal;
        signal.throwIfAborted();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    );

    const result = await launchNativeCodex(['--version'], {
      target: {
        ...fixture.target,
        prefixArguments: [fixture.script, fixture.artifact],
      },
      cwd: fixture.root,
      env: { [CODEX_LAUNCHER_DEPTH_ENV]: '0' },
      attachInfrastructure,
      onInfrastructureError,
    });

    expect(result.exitCode).toBe(0);
    expect(result.infrastructureError).toBeNull();
    expect(onInfrastructureError).not.toHaveBeenCalled();
    expect(infrastructureSignal?.aborted).toBe(true);
    expect(attachInfrastructure).toHaveBeenCalledWith(
      resolve(fixture.root),
      expect.any(AbortSignal),
    );
  });

  test('detaches attached infrastructure with the measured native lifetime', async () => {
    const fixture = launcherFixture();
    const detach = vi.fn(async () => undefined);

    const result = await launchNativeCodex(['status'], {
      target: {
        ...fixture.target,
        prefixArguments: [fixture.script, fixture.artifact],
      },
      cwd: fixture.root,
      env: {
        FAKE_CODEX_DELAY_MS: '40',
        [CODEX_LAUNCHER_DEPTH_ENV]: '0',
      },
      attachInfrastructure: async () => ({ detach }),
    });

    expect(result.infrastructure).toBe('attached');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(20);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledWith(result.elapsedMs);
  });

  test('rejects wrapper recursion and inherited launcher depth before spawn', async () => {
    const fixture = launcherFixture();
    const launchTarget = {
      ...fixture.target,
      prefixArguments: [fixture.script, fixture.artifact],
    };

    await expect(
      launchNativeCodex([], {
        target: launchTarget,
        wrapperPaths: [fixture.script],
      }),
    ).rejects.toThrow(/recursion prevented/i);
    await expect(
      launchNativeCodex([], {
        target: launchTarget,
        env: { [CODEX_LAUNCHER_DEPTH_ENV]: '1' },
      }),
    ).rejects.toThrow(/recursion prevented/i);
    expect(existsSync(fixture.artifact)).toBe(false);
  });

  test('cancellation terminates the inherited native process before returning', async () => {
    const fixture = launcherFixture();
    const controller = new AbortController();
    const running = launchNativeCodex([], {
      target: {
        ...fixture.target,
        prefixArguments: [fixture.script, fixture.artifact],
      },
      cwd: fixture.root,
      signal: controller.signal,
      env: {
        FAKE_CODEX_BLOCK: '1',
        [CODEX_LAUNCHER_DEPTH_ENV]: '0',
      },
    });

    const deadline = Date.now() + 5_000;
    while (!existsSync(fixture.artifact) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    const artifact = JSON.parse(readFileSync(fixture.artifact, 'utf8')) as {
      pid: number;
    };
    expect(isProcessAlive(artifact.pid)).toBe(true);

    controller.abort(new Error('test cancellation'));
    const result = await running;

    expect(result.cancelled).toBe(true);
    expect(isProcessAlive(artifact.pid)).toBe(false);
  });
});
