import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  LatticeMcpBridge,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INSTRUCTIONS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOL_NAMES,
  runMcpServer,
  type McpBridgeDependencies,
} from '../src/mcp-server.js';
import type { SidecarLease } from '../src/sidecar.js';
import type { SidecarState } from '../src/sidecar-protocol.js';

function state(): SidecarState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    repositoryId: 'repository-id',
    workspace: 'C:/safe/repository',
    pid: process.pid,
    port: 42_001,
    token: 'a'.repeat(64),
    status: 'ready',
    startedAt: now,
    updatedAt: now,
    indexedFiles: 3,
    activeLeases: 1,
    bridgeClients: 1,
    mode: 'mcp-assisted-context',
    lastInvalidatedPaths: [],
    telemetry: {
      startupMs: 10,
      attachCount: 1,
      lastAttachMs: 5,
      initialIndexMs: 7,
      incrementalInvalidationMs: null,
      nativeCodexProcessLifetimeMs: null,
      bridgeRequestCount: 0,
      bridgeInitializeCount: 1,
      contextBytesSupplied: 0,
      contextEstimatedTokensSupplied: 0,
      contextGrantCount: 0,
      errors: [],
    },
  };
}

function dependencies() {
  const detach = vi.fn(async () => undefined);
  const stopHeartbeat = vi.fn();
  const lease: SidecarLease = {
    state: state(),
    leaseId: '11111111-1111-4111-8111-111111111111',
    detach,
    stopHeartbeat,
  };
  const discover = vi.fn<McpBridgeDependencies['discover']>(async () => ({
    safe: true,
    root: 'C:/safe/repository',
    source: 'git',
  }));
  const ensure = vi.fn<McpBridgeDependencies['ensure']>(async () => lease);
  const status = vi.fn<McpBridgeDependencies['status']>(async () => ({
    running: true,
    state: {
      status: 'ready',
      mode: 'mcp-assisted-context',
      indexedFiles: 3,
    },
  }));
  const context = vi.fn<McpBridgeDependencies['context']>(async () => ({
    pages: [
      {
        path: 'src/auth/service.ts',
        fingerprint: 'git:abc123',
        content: 'export class AuthService {}\n',
        reason: 'search: AuthService',
      },
    ],
    bytesUsed: 28,
  }));
  return {
    dependencies: { discover, ensure, status, context },
    lease,
    detach,
    stopHeartbeat,
    discover,
    ensure,
    status,
    context,
  };
}

function rpc(
  id: number,
  method: string,
  params: unknown = {},
) {
  return { jsonrpc: '2.0' as const, id, method, params };
}

async function initialize(bridge: LatticeMcpBridge) {
  return bridge.handle(
    rpc(1, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'lattice-test-client', version: '1.0.0' },
    }),
  );
}

async function initializeWithRoots(bridge: LatticeMcpBridge) {
  return bridge.handle(
    rpc(1, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: true } },
      clientInfo: { name: 'lattice-test-client', version: '1.0.0' },
    }),
  );
}

function resultOf(response: Awaited<ReturnType<LatticeMcpBridge['handle']>>) {
  expect(response).not.toBeNull();
  expect(response).not.toHaveProperty('error');
  return (response as { result: unknown }).result;
}

function textToolValue(response: Awaited<ReturnType<LatticeMcpBridge['handle']>>) {
  const result = resultOf(response) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe('text');
  return {
    result,
    value: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

describe('Lattice MCP server', () => {
  test('returns the canonical initialize response and server instructions', async () => {
    const fake = dependencies();
    const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });

    const response = resultOf(await initialize(bridge));

    expect(response).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      },
      instructions: MCP_SERVER_INSTRUCTIONS,
    });
    expect(fake.ensure).not.toHaveBeenCalled();
    await bridge.close();
  });

  test('uses MCP client roots instead of the server process cwd and warms immediately', async () => {
    const fake = dependencies();
    const repositoryRoot = resolve('C:/safe/from-codex-root');
    fake.discover.mockImplementation(async (start) =>
      start === repositoryRoot
        ? { safe: true, root: repositoryRoot, source: 'git' }
        : {
            safe: false,
            root: null,
            source: 'unsafe',
            reason: `unsafe fallback: ${start}`,
          },
    );
    const requestClient = vi.fn(async (method: string) => {
      expect(method).toBe('roots/list');
      return {
        roots: [{ uri: pathToFileURL(repositoryRoot).href, name: 'workspace' }],
      };
    });
    const bridge = new LatticeMcpBridge({
      cwd: resolve('C:/Users/example'),
      dependencies: fake.dependencies,
      requestClient,
    });

    await initializeWithRoots(bridge);
    await bridge.handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });

    await vi.waitFor(() => expect(fake.ensure).toHaveBeenCalledWith(repositoryRoot));
    expect(requestClient).toHaveBeenCalledTimes(1);
    expect(fake.discover).toHaveBeenCalledWith(repositoryRoot);
    expect(fake.discover).not.toHaveBeenCalledWith(resolve('C:/Users/example'));
    await bridge.close();
  });

  test('refreshes the repository and lease when Codex roots change', async () => {
    const firstRoot = resolve('C:/safe/first-root');
    const secondRoot = resolve('C:/safe/second-root');
    let activeRoot = firstRoot;
    const first = dependencies();
    const second = dependencies();
    const discover = vi.fn<McpBridgeDependencies['discover']>(async (start) => ({
      safe: true,
      root: start,
      source: 'git',
    }));
    const ensure = vi.fn<McpBridgeDependencies['ensure']>(async (workspace) =>
      workspace === firstRoot ? first.lease : second.lease,
    );
    const requestClient = vi.fn(async () => ({
      roots: [{ uri: pathToFileURL(activeRoot).href }],
    }));
    const bridge = new LatticeMcpBridge({
      dependencies: { ...first.dependencies, discover, ensure },
      requestClient,
    });

    await initializeWithRoots(bridge);
    await bridge.handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    });
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledWith(firstRoot));

    activeRoot = secondRoot;
    await bridge.handle({
      jsonrpc: '2.0',
      method: 'notifications/roots/list_changed',
      params: {},
    });

    await vi.waitFor(() => expect(ensure).toHaveBeenCalledWith(secondRoot));
    expect(first.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(first.detach).toHaveBeenCalledTimes(1);
    await bridge.close();
    expect(second.detach).toHaveBeenCalledTimes(1);
  });

  test('lists only the bounded read-only Lattice tools', async () => {
    const fake = dependencies();
    const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
    await initialize(bridge);

    const response = resultOf(await bridge.handle(rpc(2, 'tools/list'))) as {
      tools: {
        name: string;
        inputSchema: Record<string, unknown>;
        annotations: Record<string, boolean>;
      }[];
    };

    expect(response.tools.map((tool) => tool.name)).toEqual([
      MCP_TOOL_NAMES.status,
      MCP_TOOL_NAMES.searchContext,
      MCP_TOOL_NAMES.readContext,
    ]);
    for (const tool of response.tools) {
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    await bridge.close();
  });

  test('reports status without starting a sidecar or model', async () => {
    const fake = dependencies();
    const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
    await initialize(bridge);

    const { value } = textToolValue(
      await bridge.handle(
        rpc(3, 'tools/call', {
          name: MCP_TOOL_NAMES.status,
          arguments: {},
        }),
      ),
    );

    expect(value).toMatchObject({
      schemaVersion: 1,
      contextBridge: 'mcp-assisted-context',
      repository: {
        safe: true,
        root: 'C:/safe/repository',
        source: 'git',
      },
      sidecar: {
        running: true,
        state: { status: 'ready', indexedFiles: 3 },
      },
    });
    expect(fake.status).toHaveBeenCalledWith('C:/safe/repository');
    expect(fake.ensure).not.toHaveBeenCalled();
    await bridge.close();
  });

  test('loads bounded context through injected sidecar dependencies', async () => {
    const fake = dependencies();
    const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
    await initialize(bridge);

    const { value, result } = textToolValue(
      await bridge.handle(
        rpc(4, 'tools/call', {
          name: MCP_TOOL_NAMES.searchContext,
          arguments: {
            query: 'AuthService',
            pathHint: 'src/auth/service.ts',
            maxPages: 2,
            maxBytes: 2_000,
          },
        }),
      ),
    );

    expect(result.isError).toBeUndefined();
    expect(value).toMatchObject({
      schemaVersion: 1,
      source: 'terra-sidecar',
      bytesUsed: 28,
      pages: [
        {
          path: 'src/auth/service.ts',
          fingerprint: 'git:abc123',
          content: 'export class AuthService {}\n',
        },
      ],
    });
    expect(fake.ensure).toHaveBeenCalledTimes(1);
    expect(fake.context).toHaveBeenCalledWith(fake.lease.state, {
      leaseId: fake.lease.leaseId,
      query: 'AuthService',
      pathHint: 'src/auth/service.ts',
      maxPages: 2,
      maxBytes: 2_000,
    });
    await bridge.close();
  });

  test('rejects traversal and unknown arguments before reaching the sidecar', async () => {
    const fake = dependencies();
    const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
    await initialize(bridge);

    const traversal = await bridge.handle(
      rpc(5, 'tools/call', {
        name: MCP_TOOL_NAMES.readContext,
        arguments: { path: '../outside/secrets.txt' },
      }),
    );
    expect(traversal).toMatchObject({
      jsonrpc: '2.0',
      id: 5,
      error: {
        code: -32602,
        message: `Invalid ${MCP_TOOL_NAMES.readContext} arguments`,
        data: [
          {
            path: 'path',
            message: expect.stringContaining('repository-relative'),
          },
        ],
      },
    });

    const extraArgument = await bridge.handle(
      rpc(6, 'tools/call', {
        name: MCP_TOOL_NAMES.status,
        arguments: { unexpected: true },
      }),
    );
    expect(extraArgument).toMatchObject({
      id: 6,
      error: {
        code: -32602,
        data: [{ path: '$' }],
      },
    });
    expect(fake.ensure).not.toHaveBeenCalled();
    expect(fake.context).not.toHaveBeenCalled();
    await bridge.close();
  });

  test('round-trips roots/list over stdio without blocking later tool calls', async () => {
    const fake = dependencies();
    const repositoryRoot = resolve('C:/safe/transport-root');
    fake.discover.mockImplementation(async (start) => ({
      safe: true,
      root: start,
      source: 'git',
    }));
    const input = new PassThrough();
    const output = new PassThrough();
    const messages: Record<string, unknown>[] = [];
    let buffered = '';
    output.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const running = runMcpServer({
      input,
      output,
      errorOutput: new PassThrough(),
      installSignalHandlers: false,
      dependencies: fake.dependencies,
    });
    input.write(
      `${JSON.stringify(
        rpc(1, 'initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { roots: { listChanged: true } },
        }),
      )}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      })}\n`,
    );

    await vi.waitFor(() =>
      expect(messages.some((message) => message.method === 'roots/list')).toBe(
        true,
      ),
    );
    const rootsRequest = messages.find(
      (message) => message.method === 'roots/list',
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: rootsRequest?.id,
        result: { roots: [{ uri: pathToFileURL(repositoryRoot).href }] },
      })}\n`,
    );
    input.write(
      `${JSON.stringify(
        rpc(2, 'tools/call', {
          name: MCP_TOOL_NAMES.status,
          arguments: {},
        }),
      )}\n`,
    );

    await vi.waitFor(() =>
      expect(messages.some((message) => message.id === 2)).toBe(true),
    );
    input.end();
    await running;
    expect(fake.discover).toHaveBeenCalledWith(repositoryRoot);
    expect(messages.find((message) => message.id === 2)).not.toHaveProperty(
      'error',
    );
  });

  test('bounds malformed and oversized transport messages and writes pure NDJSON', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    output.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    errorOutput.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));

    const running = runMcpServer({
      input,
      output,
      errorOutput,
      maxMessageBytes: 160,
      installSignalHandlers: false,
    });
    input.write('{"jsonrpc":"2.0","id":1,"method":\n');
    input.write(`${'x'.repeat(500)}\n`);
    input.end(`${JSON.stringify(rpc(7, 'ping'))}\n`);
    await running;

    const rawStdout = Buffer.concat(stdout).toString('utf8');
    expect(rawStdout.endsWith('\n')).toBe(true);
    const lines = rawStdout.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages).toEqual([
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: 'Message exceeds 160 bytes',
        },
      },
      {
        jsonrpc: '2.0',
        id: 7,
        result: {},
      },
    ]);
    expect(Buffer.concat(stderr).toString('utf8')).toBe('');
  });

  test('detaches an acquired bridge lease exactly once on close', async () => {
    const fake = dependencies();
    const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
    await initialize(bridge);
    await bridge.handle(
      rpc(8, 'tools/call', {
        name: MCP_TOOL_NAMES.readContext,
        arguments: { path: 'src/auth/service.ts' },
      }),
    );

    await bridge.close();
    await bridge.close();

    expect(fake.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(fake.detach).toHaveBeenCalledTimes(1);
  });

  describe('MCP _meta protocol compatibility (Codex CLI regression)', () => {
    test('tools/call without _meta still works', async () => {
      const fake = dependencies();
      const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
      await initialize(bridge);

      const response = await bridge.handle(
        rpc(10, 'tools/call', {
          name: MCP_TOOL_NAMES.status,
          arguments: {},
        }),
      );

      expect(response).not.toBeNull();
      expect(response).not.toHaveProperty('error');
      const { value } = textToolValue(response);
      expect(value).toMatchObject({ schemaVersion: 1 });
      await bridge.close();
    });

    test('tools/call with _meta succeeds (Codex CLI 0.144.5 injects this)', async () => {
      const fake = dependencies();
      const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
      await initialize(bridge);

      // This is the exact shape Codex CLI sends: _meta with a progressToken
      const response = await bridge.handle(
        rpc(11, 'tools/call', {
          name: MCP_TOOL_NAMES.status,
          arguments: {},
          _meta: { progressToken: 1 },
        }),
      );

      expect(response).not.toBeNull();
      expect(response).not.toHaveProperty('error');
      const { value } = textToolValue(response);
      expect(value).toMatchObject({
        schemaVersion: 1,
        contextBridge: 'mcp-assisted-context',
      });
      await bridge.close();
    });

    test('tools/call with _meta works for search_context too', async () => {
      const fake = dependencies();
      const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
      await initialize(bridge);

      const response = await bridge.handle(
        rpc(12, 'tools/call', {
          name: MCP_TOOL_NAMES.searchContext,
          arguments: { query: 'AuthService' },
          _meta: { progressToken: 'abc-123' },
        }),
      );

      expect(response).not.toBeNull();
      expect(response).not.toHaveProperty('error');
      const { value, result } = textToolValue(response);
      expect(result.isError).toBeUndefined();
      expect(value).toMatchObject({
        schemaVersion: 1,
        source: 'terra-sidecar',
      });
      await bridge.close();
    });

    test('_meta does not enter Lattice tool arguments', async () => {
      const fake = dependencies();
      const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
      await initialize(bridge);

      await bridge.handle(
        rpc(13, 'tools/call', {
          name: MCP_TOOL_NAMES.searchContext,
          arguments: { query: 'AuthService', maxPages: 2 },
          _meta: { progressToken: 42, sensitiveInfo: 'should-not-leak' },
        }),
      );

      // Verify that _meta fields never reached the sidecar context call
      expect(fake.context).toHaveBeenCalledTimes(1);
      const contextArgs = fake.context.mock.calls[0][1];
      expect(contextArgs).not.toHaveProperty('_meta');
      expect(contextArgs).not.toHaveProperty('progressToken');
      expect(contextArgs).not.toHaveProperty('sensitiveInfo');
      expect(contextArgs).toMatchObject({
        query: 'AuthService',
        maxPages: 2,
        leaseId: fake.lease.leaseId,
      });
      await bridge.close();
    });

    test('genuinely invalid tool arguments are still rejected', async () => {
      const fake = dependencies();
      const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
      await initialize(bridge);

      // status tool with unexpected arguments (even with _meta present)
      const response = await bridge.handle(
        rpc(14, 'tools/call', {
          name: MCP_TOOL_NAMES.status,
          arguments: { unexpected: true },
          _meta: { progressToken: 1 },
        }),
      );

      expect(response).toMatchObject({
        id: 14,
        error: {
          code: -32602,
          data: [{ path: '$' }],
        },
      });
      expect(fake.ensure).not.toHaveBeenCalled();
      await bridge.close();
    });

    test('unknown fields other than _meta are still rejected at envelope level', async () => {
      const fake = dependencies();
      const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
      await initialize(bridge);

      // An unknown field at the tools/call params level should still fail
      const response = await bridge.handle(
        rpc(15, 'tools/call', {
          name: MCP_TOOL_NAMES.status,
          arguments: {},
          _meta: { progressToken: 1 },
          dangerousField: 'should-be-rejected',
        }),
      );

      expect(response).toMatchObject({
        id: 15,
        error: {
          code: -32602,
          message: expect.stringContaining('tools/call params'),
        },
      });
      expect(fake.ensure).not.toHaveBeenCalled();
      await bridge.close();
    });

    test('_meta as an empty object is accepted', async () => {
      const fake = dependencies();
      const bridge = new LatticeMcpBridge({ dependencies: fake.dependencies });
      await initialize(bridge);

      const response = await bridge.handle(
        rpc(16, 'tools/call', {
          name: MCP_TOOL_NAMES.status,
          arguments: {},
          _meta: {},
        }),
      );

      expect(response).not.toBeNull();
      expect(response).not.toHaveProperty('error');
      await bridge.close();
    });
  });
});
