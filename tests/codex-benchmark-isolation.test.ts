import { afterEach, describe, expect, it, vi } from 'vitest';
import { Codex } from '@openai/codex-sdk';
import { isolatedBenchmarkCodexConfig } from '../src/benchmark-lifecycle.js';
import { runTask } from '../src/runtime.js';
import { CodexWorker } from '../src/worker.js';
import { fixtureFiles, repository, type TestRepository } from './helpers.js';

vi.mock('@openai/codex-sdk', () => ({
  Codex: vi.fn(function () {
    return {
      startThread: () => { throw new Error('local fake provider: no model request'); },
    };
  }),
}));

let repo: TestRepository | undefined;
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
  vi.clearAllMocks();
});

describe('benchmark-only Codex configuration', () => {
  it('leaves ordinary worker configuration inherited', () => {
    new CodexWorker();
    expect(Codex).toHaveBeenCalledWith({ config: undefined });
  });

  it('passes isolated config through the runtime to the actual worker client', async () => {
    repo = await repository(fixtureFiles);
    const config = isolatedBenchmarkCodexConfig();
    const result = await runTask(repo.path,
      'Fix reset token behavior: consume a valid token once and reject expired tokens.', {
        worker: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium',
        modelPolicy: 'inherit', useVerifiedCache: false, codexConfig: config,
      });
    expect(Codex).toHaveBeenCalledOnce();
    expect(Codex).toHaveBeenCalledWith({ config });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('local fake provider: no model request');
  }, 30_000);
});
