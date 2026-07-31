import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  attachSidecar,
  sidecarContext,
  sidecarPaths,
  sidecarStatus,
  startSidecarServer,
  type SidecarServer,
} from '../src/sidecar.js';
import {
  SIDECAR_PROTOCOL_VERSION,
  SidecarResponseSchema,
  type SidecarState,
} from '../src/sidecar-protocol.js';
import { fixtureFiles, repository, type TestRepository } from './helpers.js';
import {
  createEditGrantRegistry,
  loadEditGrantRegistry,
  persistContextSnapshot,
} from '../src/edit-grants.js';
import { fingerprint } from '../src/fingerprint.js';
import type { ContextPage } from '../src/types.js';
import { removeDirectoryWithRetry } from '../src/cleanup.js';

type ContextResult = {
  pages: {
    path: string;
    fingerprint: string;
    content: string;
    reason: string;
  }[];
  bytesUsed: number;
};

async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw lastError;
}

async function waitUntilReady(server: SidecarServer) {
  await eventually(() => {
    expect(server.state().status).toBe('ready');
    expect(server.state().indexedFiles).toBeGreaterThan(0);
  }, 15_000);
}

async function request(
  state: SidecarState,
  endpoint: string,
  options: {
    token?: string;
    body?: unknown;
  } = {},
) {
  const response = await fetch(`http://127.0.0.1:${state.port}${endpoint}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${options.token ?? state.token}`,
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return {
    status: response.status,
    body: SidecarResponseSchema.parse(await response.json()),
  };
}

describe('in-process sidecar server', () => {
  const servers: SidecarServer[] = [];
  const repositories: TestRepository[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
    await Promise.all(repositories.splice(0).map((fixture) => fixture.cleanup()));
  });

  async function fixtureServer() {
    const fixture = await repository(fixtureFiles);
    repositories.push(fixture);
    const server = await startSidecarServer(fixture.path, {
      idleShutdownMs: 60_000,
      leaseTtlMs: 10_000,
      foreground: true,
    });
    servers.push(server);
    await waitUntilReady(server);
    return { fixture, server, state: server.state() };
  }

  test('enforces authentication, protocol version, and repository identity', async () => {
    const { state } = await fixtureServer();

    const unauthorized = await request(state, '/v1/status', {
      token: 'not-the-sidecar-token',
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toMatchObject({
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      repositoryId: state.repositoryId,
      ok: false,
      error: 'unauthorized',
    });

    const wrongVersion = await request(state, '/v1/attach', {
      body: {
        protocolVersion: SIDECAR_PROTOCOL_VERSION + 1,
        repositoryId: state.repositoryId,
      },
    });
    expect(wrongVersion.status).toBe(400);
    expect(wrongVersion.body.ok).toBe(false);
    expect(wrongVersion.body.error).toContain('protocolVersion');

    const wrongRepository = await request(state, '/v1/attach', {
      body: {
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        repositoryId: 'different-repository',
      },
    });
    expect(wrongRepository.status).toBe(400);
    expect(wrongRepository.body).toMatchObject({
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      repositoryId: state.repositoryId,
      ok: false,
      error: 'repository identity mismatch',
    });
  });

  test('serves bounded repository context through the authenticated bridge', async () => {
    const { server, state } = await fixtureServer();

    const result = (await sidecarContext(state, {
      pathHint: 'src/auth/service.js',
      maxPages: 2,
      maxBytes: 20_000,
    })) as ContextResult;

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      path: 'src/auth/service.js',
      reason: 'path hint: src/auth/service.js',
    });
    expect(result.pages[0].fingerprint).toMatch(/^(git|raw):/);
    expect(result.pages[0].content).toContain('class AuthService');
    expect(result.bytesUsed).toBeGreaterThan(0);
    expect(server.state().mode).toBe('passive-index-only');
    expect(server.state().telemetry).toMatchObject({
      bridgeRequestCount: 1,
      contextBytesSupplied: result.bytesUsed,
      activeContextGrantCount: 1,
    });
    expect(server.state().activeContextGrantCount).toBe(1);
    expect(
      server.state().telemetry.contextEstimatedTokensSupplied,
    ).toBeGreaterThan(0);
  });

  test('tracks two concurrent leases independently', async () => {
    const { server, state } = await fixtureServer();
    const first = await attachSidecar(state, { heartbeat: false });
    const second = await attachSidecar(state, {
      heartbeat: false,
      clientKind: 'mcp',
    });

    expect(first.leaseId).not.toBe(second.leaseId);
    expect(server.state().activeLeases).toBe(2);
    expect(server.state().bridgeClients).toBe(1);
    expect(server.state().mode).toBe('passive-index-only');
    expect(server.state().telemetry.attachCount).toBe(2);

    await sidecarContext(state, {
      pathHint: 'src/auth/service.js',
      maxPages: 1,
      maxBytes: 20_000,
    });
    expect(server.state().mode).toBe('passive-index-only');

    await sidecarContext(state, {
      leaseId: second.leaseId,
      pathHint: 'src/auth/service.js',
      maxPages: 1,
      maxBytes: 20_000,
    });
    expect(server.state().mode).toBe('mcp-assisted-context');
    expect(server.state().activeContextGrantCount).toBe(1);

    await first.detach();
    expect(server.state().activeLeases).toBe(1);

    await second.detach();
    expect(server.state().activeLeases).toBe(0);
    expect(server.state().bridgeClients).toBe(0);
    expect(server.state().mode).toBe('passive-index-only');
  });

  test('reindexes a changed file and serves only the current content', async () => {
    const { fixture, server, state } = await fixtureServer();
    const path = join(fixture.path, 'package.json');
    const content = readFileSync(path, 'utf8');
    const page: ContextPage = {
      id: 'sidecar-invalidation-page',
      kind: 'config',
      path: 'package.json',
      fingerprint: await fingerprint(fixture.path, 'package.json'),
      startLine: 1,
      endLine: content.split(/\r?\n/).length,
      content,
      reason: 'sidecar invalidation test',
      provenance: 'test',
      estimatedTokens: Math.ceil(content.length / 4),
      invalidated: false,
    };
    const registry = await createEditGrantRegistry(
      fixture.path,
      'sidecar-invalidation-task',
      'sidecar-invalidation-session',
      [page],
    );
    persistContextSnapshot(fixture.path, registry, [page]);
    const snapshotPath = join(
      fixture.path,
      '.lattice',
      'tasks',
      `${registry.taskId}-context.json`,
    );
    const originalSnapshot = readFileSync(snapshotPath, 'utf8');
    await sidecarContext(state, {
      pathHint: 'package.json',
      maxPages: 1,
      maxBytes: 20_000,
    });
    expect(server.state().activeContextGrantCount).toBe(1);
    const replacement = JSON.stringify(
      {
        private: true,
        latticeInvalidationMarker: 'current-content',
      },
      null,
      2,
    );

    writeFileSync(path, `${replacement}\n`);

    await eventually(
      () => {
        expect(server.state().lastInvalidatedPaths).toContain('package.json');
        expect(
          server.state().telemetry.incrementalInvalidationMs,
        ).not.toBeNull();
        expect(
          loadEditGrantRegistry(fixture.path, registry.taskId).grants[0]
            .invalidated,
        ).toBe(true);
        expect(server.state().activeContextGrantCount).toBe(0);
        expect(readFileSync(snapshotPath, 'utf8')).toBe(originalSnapshot);
      },
      8_000,
    );

    const result = (await sidecarContext(state, {
      pathHint: 'package.json',
      maxPages: 1,
      maxBytes: 20_000,
    })) as ContextResult;
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].content).toContain('latticeInvalidationMarker');
    expect(result.pages[0].content).toContain('current-content');
    expect(server.state().activeContextGrantCount).toBe(1);
  });

  test('never re-signs a tampered edit-grant registry during invalidation', async () => {
    const { fixture, server } = await fixtureServer();
    const sourcePath = join(fixture.path, 'package.json');
    const content = readFileSync(sourcePath, 'utf8');
    const page: ContextPage = {
      id: 'tampered-registry-page',
      kind: 'config',
      path: 'package.json',
      fingerprint: await fingerprint(fixture.path, 'package.json'),
      startLine: 1,
      endLine: content.split(/\r?\n/).length,
      content,
      reason: 'tampered registry regression',
      provenance: 'test',
      estimatedTokens: Math.ceil(content.length / 4),
      invalidated: false,
    };
    const registry = await createEditGrantRegistry(
      fixture.path,
      'tampered-registry-task',
      'tampered-registry-session',
      [page],
    );
    const registryPath = join(
      fixture.path,
      '.lattice',
      'edit-grants',
      `${registry.taskId}.json`,
    );
    const tampered = JSON.parse(readFileSync(registryPath, 'utf8')) as {
      grants: { invalidated: boolean }[];
    };
    tampered.grants[0].invalidated = true;
    const tamperedBytes = `${JSON.stringify(tampered, null, 2)}\n`;
    writeFileSync(registryPath, tamperedBytes);

    writeFileSync(
      sourcePath,
      `${JSON.stringify({ private: true, changed: 'tamper-trigger' }, null, 2)}\n`,
    );

    await eventually(
      () => {
        expect(server.state().lastInvalidatedPaths).toContain('package.json');
        expect(server.state().telemetry.errors.join('\n')).toContain(
          'edit grant invalidation skipped',
        );
      },
      8_000,
    );
    expect(readFileSync(registryPath, 'utf8')).toBe(tamperedBytes);
    expect(() =>
      loadEditGrantRegistry(fixture.path, registry.taskId),
    ).toThrow(/integrity mismatch/i);
  });

  test('rejects sidecar metadata redirected through a symlink or junction', async () => {
    const fixture = await repository(fixtureFiles);
    repositories.push(fixture);
    const outside = mkdtempSync(join(tmpdir(), 'lattice-sidecar-outside-'));
    try {
      symlinkSync(outside, join(fixture.path, '.lattice'), 'junction');
      await expect(
        startSidecarServer(fixture.path, {
          idleShutdownMs: 60_000,
          leaseTtlMs: 10_000,
        }),
      ).rejects.toThrow(/symlink|junction|escapes/i);
      expect(existsSync(join(outside, 'sidecar'))).toBe(false);
    } finally {
      await removeDirectoryWithRetry(outside);
    }
  });

  test('public status never serializes the bearer token', async () => {
    const { fixture, state } = await fixtureServer();
    const status = await sidecarStatus(fixture.path);

    expect(status.running).toBe(true);
    expect(status.state).not.toHaveProperty('token');
    expect(JSON.stringify(status)).not.toContain(state.token);
  });

  test('closes deterministically and removes owned state and lock files', async () => {
    const { fixture, server, state } = await fixtureServer();
    const paths = sidecarPaths(fixture.path);
    expect(existsSync(paths.state)).toBe(true);
    expect(existsSync(paths.lock)).toBe(true);

    await server.close();
    await server.closed;
    await server.close();

    expect(existsSync(paths.state)).toBe(false);
    expect(existsSync(paths.lock)).toBe(false);
    await expect(
      fetch(`http://127.0.0.1:${state.port}/v1/status`, {
        headers: { authorization: `Bearer ${state.token}` },
      }),
    ).rejects.toThrow();
  });
});
