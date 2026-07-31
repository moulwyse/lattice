import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ensureSidecar,
  sidecarPaths,
  sidecarStatus,
  stopSidecar,
  type SidecarLease,
} from '../src/sidecar.js';
import {
  isProcessAlive,
  terminateProcessTree,
} from '../src/managed-process.js';
import { repository, type TestRepository } from './helpers.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(projectRoot, 'dist', 'cli.js');
const sidecarEnvironment = {
  LATTICE_SIDECAR_IDLE_MS: '200',
  LATTICE_SIDECAR_LEASE_TTL_MS: '3000',
};

async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error('condition did not become true');
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    }
  }
  throw lastError;
}

async function fixtureRepository(marker: string) {
  return repository({
    'package.json': JSON.stringify({
      private: true,
      name: `sidecar-lifecycle-${marker}`,
    }),
    'src/index.js': `module.exports = ${JSON.stringify(marker)};\n`,
  });
}

describe('managed sidecar process lifecycle', () => {
  const repositories: TestRepository[] = [];
  const leases: SidecarLease[] = [];
  const childPids = new Set<number>();

  afterEach(async () => {
    for (const lease of leases.splice(0)) {
      lease.stopHeartbeat();
      await lease.detach().catch(() => undefined);
    }
    for (const fixture of repositories) {
      await stopSidecar(fixture.path).catch(() => undefined);
    }
    for (const pid of childPids) {
      if (isProcessAlive(pid)) await terminateProcessTree(pid);
    }
    childPids.clear();
    for (const fixture of repositories.splice(0)) await fixture.cleanup();
  });

  async function managedLease(fixture: TestRepository) {
    const lease = await ensureSidecar(fixture.path, {
      cliPath,
      env: sidecarEnvironment,
      heartbeat: false,
      startupTimeoutMs: 8_000,
    });
    leases.push(lease);
    childPids.add(lease.state.pid);
    return lease;
  }

  test(
    'starts through built CLI, shares one same-repository process, and exits after the final detach',
    async () => {
      const fixture = await fixtureRepository('shared');
      repositories.push(fixture);
      const paths = sidecarPaths(fixture.path);

      const first = await managedLease(fixture);
      const second = await managedLease(fixture);

      expect(first.state.pid).toBe(second.state.pid);
      expect(first.state.repositoryId).toBe(second.state.repositoryId);
      expect(isProcessAlive(first.state.pid)).toBe(true);
      expect(existsSync(paths.state)).toBe(true);
      expect(existsSync(paths.lock)).toBe(true);

      await first.detach();
      expect(isProcessAlive(first.state.pid)).toBe(true);
      await second.detach(123);

      await eventually(() => {
        expect(isProcessAlive(first.state.pid)).toBe(false);
        expect(existsSync(paths.state)).toBe(false);
        expect(existsSync(paths.lock)).toBe(false);
      });
      const telemetry = JSON.parse(readFileSync(paths.telemetry, 'utf8')) as {
        telemetry: { nativeCodexProcessLifetimeMs: number | null };
        token?: unknown;
      };
      expect(telemetry.telemetry.nativeCodexProcessLifetimeMs).toBe(123);
      expect(telemetry).not.toHaveProperty('token');
    },
    30_000,
  );

  test(
    'keeps sidecars for different repositories isolated',
    async () => {
      const firstRepository = await fixtureRepository('first');
      const secondRepository = await fixtureRepository('second');
      repositories.push(firstRepository, secondRepository);

      const first = await managedLease(firstRepository);
      const second = await managedLease(secondRepository);

      expect(first.state.pid).not.toBe(second.state.pid);
      expect(first.state.repositoryId).not.toBe(second.state.repositoryId);
      expect(first.state.workspace).toBe(firstRepository.path);
      expect(second.state.workspace).toBe(secondRepository.path);

      await Promise.all([first.detach(), second.detach()]);
      await eventually(() => {
        expect(isProcessAlive(first.state.pid)).toBe(false);
        expect(isProcessAlive(second.state.pid)).toBe(false);
      });
    },
    30_000,
  );

  test(
    'replaces copied live state without signaling or attaching the wrong repository',
    async () => {
      const firstRepository = await fixtureRepository('copy-source');
      const secondRepository = await fixtureRepository('copy-target');
      repositories.push(firstRepository, secondRepository);
      const first = await managedLease(firstRepository);
      const firstPaths = sidecarPaths(firstRepository.path);
      const copiedPaths = sidecarPaths(secondRepository.path);
      mkdirSync(copiedPaths.directory, { recursive: true });
      writeFileSync(copiedPaths.state, readFileSync(firstPaths.state));
      writeFileSync(copiedPaths.lock, readFileSync(firstPaths.lock));

      const second = await managedLease(secondRepository);

      const copiedStatus = await sidecarStatus(secondRepository.path);
      expect(copiedStatus).toMatchObject({
        running: true,
        state: {
          pid: second.state.pid,
          repositoryId: second.state.repositoryId,
          workspace: secondRepository.path,
        },
      });
      expect(second.state.pid).not.toBe(first.state.pid);
      expect(second.state.repositoryId).not.toBe(first.state.repositoryId);
      expect(isProcessAlive(first.state.pid)).toBe(true);
      expect(readFileSync(firstPaths.state, 'utf8')).toContain(
        first.state.repositoryId,
      );
    },
    30_000,
  );

  test(
    'cancels a bounded sidecar wait without signaling an unverified lock PID',
    async () => {
      const fixture = await fixtureRepository('cancel-wait');
      repositories.push(fixture);
      const paths = sidecarPaths(fixture.path);
      mkdirSync(paths.directory, { recursive: true });
      writeFileSync(
        paths.lock,
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid })}\n`,
      );
      const controller = new AbortController();
      const startedAt = Date.now();
      const pending = ensureSidecar(fixture.path, {
        cliPath,
        env: sidecarEnvironment,
        heartbeat: false,
        startupTimeoutMs: 8_000,
        signal: controller.signal,
      });
      setTimeout(
        () => controller.abort(new Error('cancelled sidecar wait')),
        75,
      ).unref();

      await expect(pending).rejects.toThrow(/cancelled sidecar wait/i);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(isProcessAlive(process.pid)).toBe(true);
    },
    30_000,
  );

  test(
    'recovers from a valid stale state and dead sidecar PID',
    async () => {
      const fixture = await fixtureRepository('stale');
      repositories.push(fixture);
      const paths = sidecarPaths(fixture.path);

      const original = await managedLease(fixture);
      const staleState = original.state;
      await original.detach();
      await eventually(() => {
        expect(isProcessAlive(staleState.pid)).toBe(false);
        expect(existsSync(paths.state)).toBe(false);
        expect(existsSync(paths.lock)).toBe(false);
      });

      writeFileSync(paths.state, `${JSON.stringify(staleState, null, 2)}\n`);
      writeFileSync(
        paths.lock,
        `${JSON.stringify({ schemaVersion: 1, pid: staleState.pid })}\n`,
      );

      const replacement = await managedLease(fixture);
      expect(replacement.state.pid).not.toBe(staleState.pid);
      expect(replacement.state.repositoryId).toBe(staleState.repositoryId);
      expect(isProcessAlive(replacement.state.pid)).toBe(true);
      expect(existsSync(paths.state)).toBe(true);
      expect(existsSync(paths.lock)).toBe(true);
    },
    30_000,
  );

  test(
    'explicit stop leaves no process, state, lock, or temporary sidecar artifact',
    async () => {
      const fixture = await fixtureRepository('stop');
      repositories.push(fixture);
      const paths = sidecarPaths(fixture.path);
      const lease = await managedLease(fixture);
      const pid = lease.state.pid;

      expect(await stopSidecar(fixture.path, 5_000)).toBe(true);
      await eventually(() => {
        expect(isProcessAlive(pid)).toBe(false);
        expect(existsSync(paths.state)).toBe(false);
        expect(existsSync(paths.lock)).toBe(false);
      });

      const remaining = readdirSync(paths.directory);
      expect(
        remaining.filter(
          (name) =>
            name === 'state.json' ||
            name === 'sidecar.lock' ||
            name.endsWith('.tmp'),
        ),
      ).toEqual([]);
    },
    30_000,
  );

  test(
    'never terminates an unauthenticated PID from persisted state',
    async () => {
      const fixture = await fixtureRepository('untrusted-pid');
      repositories.push(fixture);
      const paths = sidecarPaths(fixture.path);
      const original = await managedLease(fixture);
      expect(await stopSidecar(fixture.path, 5_000)).toBe(true);

      const sleeper = spawn(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 1000)'],
        {
          detached: false,
          windowsHide: true,
          stdio: 'ignore',
        },
      );
      if (!sleeper.pid) throw new Error('sleeper process did not start');
      childPids.add(sleeper.pid);
      const forgedState = {
        ...original.state,
        pid: sleeper.pid,
        port: 9,
        token: 'f'.repeat(64),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(paths.state, `${JSON.stringify(forgedState, null, 2)}\n`);
      writeFileSync(
        paths.lock,
        `${JSON.stringify({ schemaVersion: 1, pid: sleeper.pid })}\n`,
      );

      expect(await stopSidecar(fixture.path, 250)).toBe(false);
      expect(isProcessAlive(sleeper.pid)).toBe(true);
    },
    30_000,
  );
});
