import { describe, expect, it, vi } from 'vitest';
import {
  benchmarkStopReason,
  captureBenchmarkArm,
  isolatedBenchmarkCodexConfig,
} from '../src/benchmark-lifecycle.js';

const failure = (error: unknown) => ({ status: 'failed', error: String(error) });
const locked = () => Object.assign(new Error('fixture is locked'), {
  code: 'EBUSY', syscall: 'rmdir',
});

describe('benchmark outcome durability', () => {
  it('checkpoints before cleanup and removes nested resources first', async () => {
    const order: string[] = [];
    const result = await captureBenchmarkArm({
      run: async (register) => {
        register({ path: 'root', remove: async () => { order.push('root'); } });
        register({ path: 'verification', remove: async () => { order.push('verification'); } });
        return { status: 'passed', usage: { inputTokens: 123 } };
      },
      failure,
      checkpoint: (run) => { order.push(run.cleanup.status); },
    });
    expect(order).toEqual(['pending', 'verification', 'root', 'complete']);
    expect(result.usage).toEqual({ inputTokens: 123 });
    expect(result.cleanup.pendingPaths).toEqual([]);
    expect(benchmarkStopReason(result)).toBeNull();
  });

  it('keeps successful model data when a locked root cannot be removed', async () => {
    const snapshots: unknown[] = [];
    const result = await captureBenchmarkArm({
      run: async (register) => {
        register({ path: 'locked-root', remove: async () => { throw locked(); } });
        return { status: 'passed', usage: { inputTokens: 123 }, unifiedDiff: 'exact diff' };
      },
      failure,
      checkpoint: (run) => { snapshots.push(structuredClone(run)); },
    });
    expect(result).toMatchObject({
      status: 'passed', usage: { inputTokens: 123 }, unifiedDiff: 'exact diff',
      cleanup: {
        status: 'failed', pendingPaths: ['locked-root'],
        errors: [{ path: 'locked-root', code: 'EBUSY', syscall: 'rmdir' }],
      },
    });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ cleanup: { status: 'pending', errors: [] } });
    expect(benchmarkStopReason(result)).toContain('cleanup failed');
  });

  it('does not replace an original provider failure with EBUSY', async () => {
    const result = await captureBenchmarkArm({
      run: async (register) => {
        register({ path: 'root', remove: async () => { throw locked(); } });
        throw new Error('original provider failure');
      },
      failure,
      checkpoint: () => {},
    });
    expect(result.error).toBe('Error: original provider failure');
    expect(result.cleanup.errors[0].code).toBe('EBUSY');
  });

  it('cleans a registered workspace even if fixture setup fails', async () => {
    const remove = vi.fn(async () => {});
    const result = await captureBenchmarkArm({
      run: async (register) => {
        register({ path: 'partial-fixture', remove });
        throw new Error('git init failed');
      },
      failure,
      checkpoint: () => {},
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(result.cleanup.status).toBe('complete');
    expect(result.error).toContain('git init failed');
  });

  it('records verification cleanup failure without skipping other cleanup', async () => {
    const remove = vi.fn(async () => {});
    const result = await captureBenchmarkArm({
      run: async (register) => {
        register({ path: 'root', remove });
        register({ path: 'verification', remove: async () => { throw locked(); } });
        return { status: 'passed', usage: { inputTokens: 123 } };
      },
      failure,
      checkpoint: () => {},
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(result.cleanup.pendingPaths).toEqual(['verification']);
    expect(benchmarkStopReason(result)).toContain('cleanup failed');
  });

  it('retains evidence and throws if the first checkpoint cannot be saved', async () => {
    const remove = vi.fn(async () => {});
    await expect(captureBenchmarkArm({
      run: async (register) => {
        register({ path: 'root', remove });
        return { status: 'passed' };
      },
      failure,
      checkpoint: () => { throw new Error('disk full'); },
    })).rejects.toThrow('disk full');
    expect(remove).not.toHaveBeenCalled();
  });

  it('stops before another paid arm on infrastructure or missing-usage failures', () => {
    expect(benchmarkStopReason({
      status: 'failed', failureClass: 'infrastructure_network',
      error: 'stream disconnected', usage: { inputTokens: 10 },
    })).toContain('infrastructure_network');
    expect(benchmarkStopReason({ status: 'failed' })).toContain('without usage data');
    expect(benchmarkStopReason({ status: 'failed', usage: { inputTokens: 10 } })).toBeNull();
  });

  it('creates independent configs disabling global hooks, plugins and MCP for both arms', () => {
    const raw = isolatedBenchmarkCodexConfig();
    const lattice = isolatedBenchmarkCodexConfig();
    expect(raw).toEqual({ mcp_servers: {}, features: { hooks: false, plugins: false } });
    expect(lattice).toEqual(raw);
    raw.mcp_servers = { unexpected: { enabled: true } };
    expect(lattice.mcp_servers).toEqual({});
  });

  it('can isolate the state database without moving or copying credentials', () => {
    const config = isolatedBenchmarkCodexConfig('C:/fixture-output/raw-state');
    expect(config.sqlite_home).toBe('C:/fixture-output/raw-state');
    expect(config.mcp_servers).toEqual({});
    expect(config).not.toHaveProperty('cli_auth_credentials_store');
    expect(isolatedBenchmarkCodexConfig()).not.toHaveProperty('sqlite_home');
  });
});
