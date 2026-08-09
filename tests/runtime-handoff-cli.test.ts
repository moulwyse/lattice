import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { resetTokenFixture } from '../src/benchmark.js';
import { removeDirectoryWithRetry } from '../src/cleanup.js';
import { writeJson } from '../src/core.js';
import { grantForPage, loadEditGrantRegistry } from '../src/edit-grants.js';
import {
  continueHandoff,
  startHandoff,
  validateHandoff,
} from '../src/handoff.js';
import { loadTask } from '../src/persistence.js';
import { buildEvidence, runTask } from '../src/runtime.js';
import { compileTask } from '../src/task.js';
import { recordTurnUsage, telemetry } from '../src/telemetry.js';
import {
  isProcessAlive,
  ManagedProcessError,
  runManagedProcess,
} from '../src/managed-process.js';
import {
  buildContextFaultPrompt,
  buildInitialWorkerPrompt,
  buildProtocolRepairPrompt,
  selectNewContextPages,
  STABLE_WORKER_PREFIX_SHA256,
  withTimeout,
  type WorkerInput,
} from '../src/worker.js';
import { fixtureFiles, repository, type TestRepository } from './helpers.js';
import type { ContextPage, EditGrantRegistryIR, TaskIR } from '../src/types.js';

const repositories: TestRepository[] = [];
const temporaryPaths: string[] = [];
afterEach(async () => {
  for (const repo of repositories.splice(0)) await repo.cleanup();
  for (const path of temporaryPaths.splice(0)) await removeDirectoryWithRetry(path);
});

const goal =
  'Fix reset token behavior: consume a valid token once, reject a second consumption and expired tokens, record a password-reset audit event, and preserve login behavior.';
const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

function outputLines(output: string) {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

function runCli(arguments_: string[], timeoutMs = 55_000) {
  return runManagedProcess(process.execPath, [cliPath, ...arguments_], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    timeoutMs,
  });
}

function patchedToken(content: string) {
  return content.replace(
    '    if (!token || token.expiresAt <= this.now()) return undefined;\n    return token;',
    '    if (!token || token.expiresAt <= this.now()) return undefined;\n    if (token.used) return undefined;\n    token.used = true;\n    return token;',
  );
}

function patchedService(content: string) {
  return content
    .replace(
      "const { TokenRepository } = require('./token-repository.js');",
      "const { TokenRepository } = require('./token-repository.js');\nconst { recordAudit } = require('./audit.js');",
    )
    .replace(
      '    return this.tokens.consume(value);',
      "    const token = this.tokens.consume(value);\n    if (token) recordAudit({ type: 'password_reset', token: value });\n    return token;",
    );
}

function promptRegistry(
  task: TaskIR,
  pages: readonly ContextPage[],
  sessionId = 'prompt-session',
): EditGrantRegistryIR {
  return {
    schemaVersion: 1,
    taskId: task.id,
    sessionId,
    repositoryId: 'repo:prompt',
    baseCommit: 'prompt-base',
    epoch: 1,
    nextHandle: pages.length + 1,
    grants: pages.map((page, index) => ({
      schemaVersion: 1,
      handle: `E${index + 1}`,
      taskId: task.id,
      sessionId,
      repositoryId: 'repo:prompt',
      baseCommit: 'prompt-base',
      path: page.path,
      fingerprint: page.fingerprint.value,
      permissions: ['replace_file'] as const,
      epoch: 1,
      contextPageId: page.id,
      invalidated: false,
    })),
    mappingSha256: 'prompt-only',
  };
}

describe('verification evidence and runtime persistence', () => {
  it('records exact per-turn provider usage and derives only non-cached input', () => {
    const metrics = telemetry();
    recordTurnUsage(
      metrics,
      'initial',
      {
        input_tokens: 1_000,
        cached_input_tokens: 750,
        output_tokens: 80,
        reasoning_output_tokens: 20,
      },
      123,
    );
    recordTurnUsage(
      metrics,
      'context_fault',
      {
        input_tokens: 400,
        cached_input_tokens: 300,
        output_tokens: 40,
        reasoning_output_tokens: 10,
      },
      45,
    );
    expect(metrics.turnUsage).toEqual([
      {
        turnNumber: 1,
        kind: 'initial',
        inputTokens: 1_000,
        cachedInputTokens: 750,
        nonCachedInputTokens: 250,
        outputTokens: 80,
        reasoningTokens: 20,
        costUsd: null,
        elapsedMs: 123,
        rawResponseSha256: null,
        detectedEnvelopeShape: null,
        normalizationResult: null,
        validationError: null,
      },
      {
        turnNumber: 2,
        kind: 'context_fault',
        inputTokens: 400,
        cachedInputTokens: 300,
        nonCachedInputTokens: 100,
        outputTokens: 40,
        reasoningTokens: 10,
        costUsd: null,
        elapsedMs: 45,
        rawResponseSha256: null,
        detectedEnvelopeShape: null,
        normalizationResult: null,
        validationError: null,
      },
    ]);
    expect(metrics.modelInputTokens).toBe(1_400);
    expect(metrics.cachedInputTokens).toBe(1_050);
    expect(metrics.nonCachedInputTokens).toBe(350);
  });

  it('prevents green tests from proving an unrelated criterion', () => {
    const task = {
      schemaVersion: 2 as const,
      id: 'task',
      goal: 'change docs',
      constraints: [],
      invariants: [],
      acceptanceCriteria: [{ id: 'ac-1', text: 'documentation is accurate' }],
      risk: 'low' as const,
      scope: { include: [], exclude: [] },
      budget: { maxTokens: 1, maxPages: 1, maxFaults: 1, maxTurns: 1 },
      allowedVerificationCommands: ['npm test'],
    };
    const evidence = buildEvidence(
      task,
      'passed',
      ['src/value.js'],
      'npm test',
      'all tests passed',
    );
    expect(evidence[0].result).toBe('unresolved');
  });

  it('satisfies passing-test criteria when required verification ends at 3/4', () => {
    const task = compileTask(goal);
    const evidence = buildEvidence(
      task,
      'failed',
      ['src/auth/token-repository.js', 'src/auth/service.js'],
      'npm test',
      [
        '\u2716 valid reset token can be consumed once (1ms)',
        '\u2714 expired reset tokens cannot be consumed (1ms)',
        '\u2714 successful password reset records audit event (1ms)',
        '\u2714 login behavior remains unchanged (1ms)',
      ].join('\n'),
    );
    expect(
      evidence.filter((item) => item.result === 'passed').map((item) => item.criterionId),
    ).toEqual(['ac-3', 'ac-4', 'ac-5']);
    expect(
      evidence.filter((item) => item.result === 'unresolved').map((item) => item.criterionId),
    ).toEqual(['ac-1', 'ac-2']);
  });

  it('runs the mock worker through a real isolated transaction with complete telemetry', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const result = await runTask(repo.path, goal, { worker: 'mock' });
    expect(result.status).toBe('passed');
    expect(result.schemaVersion).toBe(2);
    expect(result.task.schemaVersion).toBe(2);
    expect(result.telemetry.schemaVersion).toBe(2);
    expect(result.internalPatch.schemaVersion).toBe(1);
    expect(result.changedFiles).toEqual([
      'src/auth/token-repository.js',
      'src/auth/service.js',
    ]);
    expect(result.evidence).toHaveLength(5);
    expect(result.evidence.every((item: { schemaVersion: number }) => item.schemaVersion === 1)).toBe(
      true,
    );
    expect(result.evidence.every((item: { result: string }) => item.result === 'passed')).toBe(true);
    expect(result.telemetry.workerTurns).toBe(1);
    expect(result.telemetry.pageFaults).toBe(0);
    expect(result.telemetry.protocolRepairTurns).toBe(0);
    expect(result.telemetry.editGrantCount).toBeGreaterThanOrEqual(2);
    expect(result.telemetry.resolvedEditGrantCount).toBe(2);
    expect(result.telemetry.editGrantMappingSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.telemetry.rejectedEditGrantReason).toBeNull();
    expect(result.telemetry.patchLoweringDurationMs).not.toBeNull();
    expect(result.telemetry.providerProtocolVersion).toBe(4);
    expect(result.telemetry.internalPatchVersion).toBe(1);
    expect(
      result.telemetry.runtimeStateTransitions.map(
        (transition: { to: string }) => transition.to,
      ),
    ).toEqual([
      'CREATED',
      'COMPILED',
      'INDEXED',
      'CONTEXT_GRANTED',
      'WORKER_RUNNING',
      'RESPONSE_NORMALIZED',
      'RESPONSE_VALIDATED',
      'PATCH_LOWERED',
      'TRANSACTION_RUNNING',
      'VERIFYING',
      'PASSED',
    ]);
    expect(result.telemetry.terminalStateReason).toContain('acceptance evidence passed');
    expect(result.telemetry.turnUsage).toEqual([
      expect.objectContaining({
        turnNumber: 1,
        kind: 'initial',
        inputTokens: null,
        cachedInputTokens: null,
        nonCachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        rawResponseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        detectedEnvelopeShape: 'canonical_patch',
        normalizationResult: 'canonical_patch',
        validationError: null,
      }),
    ]);
    expect(result.telemetry.promptManifests).toEqual([
      expect.objectContaining({
        turnNumber: 1,
        kind: 'initial',
        stablePrefixSha256: STABLE_WORKER_PREFIX_SHA256,
      }),
    ]);
    expect(JSON.stringify(result.telemetry)).not.toContain('apiKey');
    expect(result.telemetry.modelInputTokens).toBeNull();
    expect(loadTask(repo.path, result.taskId).status).toBe('passed');
  });

  it('reuses only an exact verified patch and reruns Aegis without a model turn', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const first = await runTask(repo.path, goal, { worker: 'mock' });
    expect(first.status).toBe('passed');
    expect(first.telemetry.verifiedPatchCacheHit).toBe(false);
    expect(first.telemetry.workerTurns).toBe(1);

    const second = await runTask(repo.path, goal, { worker: 'mock' });
    expect(second.status).toBe('passed');
    expect(second.telemetry.verifiedPatchCacheHit).toBe(true);
    expect(second.telemetry.verifiedPatchCacheKey).toBe(
      first.telemetry.verifiedPatchCacheKey,
    );
    expect(second.telemetry.workerTurns).toBe(0);
    expect(second.telemetry.modelInputTokens).toBeNull();
    expect(second.changedFiles).toEqual(first.changedFiles);
    expect(second.unifiedDiff).toBe(first.unifiedDiff);
    expect(
      second.telemetry.runtimeStateTransitions.map(
        (transition: { to: string }) => transition.to,
      ),
    ).toEqual([
      'CREATED',
      'COMPILED',
      'INDEXED',
      'CONTEXT_GRANTED',
      'PATCH_LOWERED',
      'TRANSACTION_RUNNING',
      'VERIFYING',
      'PASSED',
    ]);
  }, 40_000);

  it('persists telemetry and failure stage when the transaction cannot use Git', async () => {
    const path = mkdtempSync(join(tmpdir(), 'lattice-v2-non-git-'));
    temporaryPaths.push(path);
    for (const [relativePath, content] of Object.entries(fixtureFiles)) {
      const full = join(path, relativePath);
      const parent = dirname(full);
      await import('node:fs').then(({ mkdirSync }) => mkdirSync(parent, { recursive: true }));
      writeFileSync(full, content);
    }
    const result = await runTask(path, goal, { worker: 'mock' });
    expect(result.status).toBe('failed');
    expect(result.failureStage).toBe('patch_lowering');
    expect(result.telemetry.rejectedEditGrantReason).toBe('permission_denied');
    expect(result.telemetry.loadedPageCount).toBeGreaterThan(0);
    expect(result.telemetry.turnUsage).toHaveLength(1);
    expect(result.telemetry.turnUsage[0].kind).toBe('initial');
    expect(result.telemetry.promptManifests).toHaveLength(1);
    expect(loadTask(path, result.taskId).telemetry).toEqual(result.telemetry);
  });

  it('persists cancellation before any worker is created', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const controller = new AbortController();
    controller.abort(new Error('test cancellation'));
    const result = await runTask(repo.path, goal, {
      worker: 'mock',
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(loadTask(repo.path, result.taskId).status).toBe('cancelled');
    expect(result.telemetry.workerTurns).toBe(0);
  });

  it('enforces timeout cancellation without leaving a live timer', async () => {
    const parent = new AbortController();
    const started = Date.now();
    await expect(
      withTimeout(20, parent.signal, (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      ),
    ).rejects.toThrow('worker timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('sends only newly faulted pages without duplicating task, map, protocol, or old pages', () => {
    const sent = new Set<string>();
    const page = (id: string, path = `${id}.ts`, content = id) =>
      ({
        id,
        kind: 'file',
        path,
        fingerprint: { kind: 'git', value: `git:${id}`, rawSha256: id, byteLength: 1 },
        startLine: 1,
        endLine: 1,
        content,
        reason: 'test',
        provenance: 'fresh-index',
        estimatedTokens: 1,
        invalidated: false,
      }) as const;
    expect(selectNewContextPages([page('initial')], sent).map((item) => item.id)).toEqual([
      'initial',
    ]);
    expect(
      selectNewContextPages([page('initial'), page('fault')], sent).map((item) => item.id),
    ).toEqual(['fault']);
    expect(selectNewContextPages([page('initial'), page('fault')], sent)).toEqual([]);

    const metrics = telemetry();
    const task = compileTask('UNIQUE_TASK_GOAL repair reset tokens');
    const initialPage = page('initial', 'src/old.js', 'OLD_PAGE_CONTENT');
    const faultPage = page('fault', 'src/new.js', 'NEW_PAGE_CONTENT');
    const registry = promptRegistry(task, [initialPage, faultPage]);
    const input: WorkerInput = {
      workspace: 'C:/dynamic/workspace',
      task,
      pages: [initialPage],
      repositoryMap: [{ path: 'src/repository-only.js', symbols: ['RepositoryOnly'] }],
      signal: new AbortController().signal,
      metrics,
      editGrants: registry,
    };
    const initial = buildInitialWorkerPrompt(input, input.pages);
    expect(initial.text).toContain('UNIQUE_TASK_GOAL');
    expect(initial.text).toContain('src/repository-only.js');
    expect(initial.text).toContain('OLD_PAGE_CONTENT');
    expect(initial.text).not.toContain(`\"id\":\"${task.id}\"`);
    expect(initial.text).not.toContain('maxTokens');
    expect(initial.text).not.toContain('startLine');
    expect(initial.text).not.toContain('endLine');
    expect(initial.text).not.toContain('[\"src/old.js\"');
    expect(initial.text).toContain('allowedVerificationCommands');

    const continuation = buildContextFaultPrompt(metrics, [faultPage], registry);
    expect(continuation.text).toContain('src/new.js');
    expect(continuation.text).toContain('"editHandle":"E2"');
    expect(continuation.text).not.toContain('git:fault');
    expect(continuation.text).toContain('NEW_PAGE_CONTENT');
    expect(continuation.text).not.toContain('UNIQUE_TASK_GOAL');
    expect(continuation.text).not.toContain('src/repository-only.js');
    expect(continuation.text).not.toContain('src/old.js');
    expect(continuation.text).not.toContain('OLD_PAGE_CONTENT');
    expect(continuation.text).not.toContain('CANONICAL_OUTPUT_PROTOCOL');
    expect(continuation.manifest).toEqual(
      expect.objectContaining({
        kind: 'context_fault',
        stablePrefixCharacters: 0,
        taskCharacters: 0,
        repositoryMapCharacters: 0,
        protocolCharacters: 0,
      }),
    );
  });

  it('keeps the stable prompt prefix identical across tasks and sessions', () => {
    const makeInput = (taskGoal: string, workspace: string): WorkerInput => {
      const task = compileTask(taskGoal);
      return {
        workspace,
        task,
        pages: [],
        repositoryMap: [{ path: `${workspace}/dynamic.js`, symbols: [] }],
        signal: new AbortController().signal,
        metrics: telemetry(),
        editGrants: promptRegistry(task, []),
      };
    };
    const first = buildInitialWorkerPrompt(makeInput('Task alpha', 'workspace-a'), []);
    const second = buildInitialWorkerPrompt(makeInput('Task beta', 'workspace-b'), []);
    expect(first.manifest.stablePrefixSha256).toBe(STABLE_WORKER_PREFIX_SHA256);
    expect(second.manifest.stablePrefixSha256).toBe(STABLE_WORKER_PREFIX_SHA256);
    expect(first.manifest.stablePrefixSha256).toBe(second.manifest.stablePrefixSha256);
    expect(first.manifest.stablePrefixCharacters).toBe(
      second.manifest.stablePrefixCharacters,
    );
    expect(first.text).not.toBe(second.text);
    expect(first.text).toContain(
      'Return exactly one top-level action with kind context_request or patch.',
    );
    expect(first.text).toContain('"oneOf"');
    expect(first.manifest.protocolCharacters).toBeGreaterThan(0);
  });

  it('keeps protocol repair compact and forbids a combined response', () => {
    const metrics = telemetry();
    const repair = buildProtocolRepairPrompt(
      metrics,
      '$: ambiguous response: both actions are present',
    );
    expect(repair.text).toContain('$: ambiguous response');
    expect(repair.text).toContain('top-level kind is context_request or patch');
    expect(repair.text).toContain('Never combine actions');
    expect(repair.text).not.toContain('LATTICE_WORKER_PROTOCOL_V3');
    expect(repair.manifest.stablePrefixCharacters).toBe(0);
    expect(repair.manifest.protocolCharacters).toBe(0);
    expect(repair.text).not.toContain('UNIQUE_TASK_GOAL');
    expect(repair.text).not.toContain('src/repository-only.js');
    expect(repair.text).not.toContain('OLD_PAGE_CONTENT');
    expect(repair.manifest.taskCharacters).toBe(0);
    expect(repair.manifest.repositoryMapCharacters).toBe(0);
    expect(repair.manifest.contextCharacters).toBe(0);
  });
});

describe('manual handoff', () => {
  it('continues context requests and a patch on the same task without model telemetry', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const first = await startHandoff(repo.path, goal);
    const request = JSON.parse(readFileSync(first.requestPath, 'utf8'));
    expect(request.schemaVersion).toBe(1);
    expect(request.protocolVersion).toBe(3);
    expect(request.grantedContextPages[0].editHandle).toMatch(/^E[1-9]\d*$/);
    expect(JSON.stringify(request.grantedContextPages)).not.toContain(
      'expectedFingerprint',
    );
    expect(JSON.stringify(request.grantedContextPages)).not.toContain('git:');
    writeJson(first.responsePath, {
      kind: 'context_request',
      requests: [{ reason: 'Need password reset service', pathHint: 'src/auth/service.js' }],
    });
    const continued = await continueHandoff(repo.path, first.taskId);
    expect(continued.state.taskId).toBe(first.taskId);
    expect(continued.state.round).toBe(2);
    expect(continued.state.requestPath).toMatch(/request-2\.json$/);

    const token = continued.state.pages.find((page) =>
      page.path.endsWith('token-repository.js'),
    )!;
    const service = continued.state.pages.find((page) => page.path.endsWith('service.js'))!;
    const registry = loadEditGrantRegistry(repo.path, first.taskId);
    writeJson(continued.state.responsePath, {
      kind: 'patch',
      patch: {
        summary: 'Implement reset-token requirements',
        changes: [
          {
            editHandle: grantForPage(registry, token)!.handle,
            operation: 'replace_file',
            replacementContent: patchedToken(token.content),
          },
          {
            editHandle: grantForPage(registry, service)!.handle,
            operation: 'replace_file',
            replacementContent: patchedService(service.content),
          },
        ],
        verificationCommands: ['npm test'],
      },
    });
    expect(validateHandoff(repo.path, first.taskId).kind).toBe('patch');
    const finished = await continueHandoff(repo.path, first.taskId);
    expect(finished.state.taskId).toBe(first.taskId);
    expect(finished.result?.status).toBe('passed');
    expect(finished.result?.telemetry.modelInputTokens).toBeNull();
    expect(finished.result?.telemetry.workerTurns).toBe(0);
  });

  it('decodes raw-fingerprint patches only for persisted protocol v2 handoffs', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const handoff = await startHandoff(repo.path, goal);
    const token = handoff.pages.find((page) =>
      page.path.endsWith('token-repository.js'),
    )!;
    const legacyResponse = {
      kind: 'patch',
      patch: {
        summary: 'Persisted v2 response',
        changes: [
          {
            path: token.path,
            operation: 'modify',
            expectedFingerprint: token.fingerprint.value,
            replacementContent: patchedToken(token.content),
          },
        ],
        verificationCommands: ['npm test'],
      },
    };
    const statePath = join(
      repo.path,
      '.lattice',
      'handoffs',
      handoff.taskId,
      'state.json',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.protocolVersion = 2;
    writeJson(statePath, state);
    writeJson(handoff.responsePath, legacyResponse);
    expect(validateHandoff(repo.path, handoff.taskId)).toMatchObject({
      kind: 'patch',
      patch: { changes: [{ editHandle: expect.stringMatching(/^E\d+$/) }] },
    });

    state.protocolVersion = 3;
    writeJson(statePath, state);
    expect(() => validateHandoff(repo.path, handoff.taskId)).toThrow(
      /editHandle|operation/,
    );
  });

  it('rejects unsafe and capture-locally legacy migration attempts', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const handoff = await startHandoff(repo.path, goal);
    const statePath = join(
      repo.path,
      '.lattice',
      'handoffs',
      handoff.taskId,
      'state.json',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.protocolVersion = 2;
    writeJson(statePath, state);
    const token = handoff.pages.find((page) =>
      page.path.endsWith('token-repository.js'),
    )!;

    for (const change of [
      {
        path: token.path,
        operation: 'modify',
        expectedFingerprint: 'capture-locally',
        replacementContent: token.content,
      },
      {
        path: '../outside.js',
        operation: 'modify',
        expectedFingerprint: token.fingerprint.value,
        replacementContent: 'outside',
      },
    ]) {
      writeJson(handoff.responsePath, {
        kind: 'patch',
        patch: {
          summary: 'Unsafe migration',
          changes: [change],
          verificationCommands: ['npm test'],
        },
      });
      expect(() => validateHandoff(repo.path, handoff.taskId)).toThrow(
        /capture-locally|not granted/,
      );
    }
  });

  it('reports the exact missing response path and rejects invalid JSON', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const handoff = await startHandoff(repo.path, goal);
    expect(() => validateHandoff(repo.path, handoff.taskId)).toThrow(handoff.responsePath);
    writeFileSync(handoff.responsePath, 'not json');
    expect(() => validateHandoff(repo.path, handoff.taskId)).toThrow('malformed JSON');
  });

  it('invalidates persisted pages whose source fingerprint changed', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const handoff = await startHandoff(repo.path, goal);
    const original = handoff.pages.find((page) => page.path.endsWith('token-repository.js'))!;
    const originalRegistry = loadEditGrantRegistry(repo.path, handoff.taskId);
    const originalGrant = grantForPage(originalRegistry, original)!;
    writeFileSync(
      join(repo.path, original.path),
      `${readFileSync(join(repo.path, original.path), 'utf8')}\n// external mutation\n`,
    );
    writeJson(handoff.responsePath, {
      kind: 'context_request',
      requests: [{ reason: 'Reload changed token source', pathHint: original.path }],
    });
    const continued = await continueHandoff(repo.path, handoff.taskId);
    const refreshed = continued.state.pages.find((page) => page.path === original.path)!;
    expect(refreshed.fingerprint.value).not.toBe(original.fingerprint.value);
    expect(refreshed.provenance).toBe('fresh-index');
    const refreshedRegistry = loadEditGrantRegistry(repo.path, handoff.taskId);
    expect(refreshedRegistry.epoch).toBe(originalRegistry.epoch + 1);
    expect(
      refreshedRegistry.grants.find((grant) => grant.handle === originalGrant.handle)
        ?.invalidated,
    ).toBe(true);
    expect(grantForPage(refreshedRegistry, refreshed)?.handle).not.toBe(
      originalGrant.handle,
    );
  });
});

describe('benchmark and CLI contracts', () => {
  it.each(['timeout', 'cancellation'] as const)(
    'terminates a spawned CLI process tree on %s before repository cleanup',
    async (mode) => {
      const path = mkdtempSync(join(tmpdir(), 'lattice-v2-child-cleanup-'));
      temporaryPaths.push(path);
      const childScript = [
        "const { spawn } = require('node:child_process');",
        "const nested = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' });",
        "process.stdout.write(JSON.stringify({ childPid: nested.pid }) + '\\n');",
        'setInterval(() => {}, 1000);',
      ].join('');
      const controller = new AbortController();
      const cancellation =
        mode === 'cancellation'
          ? setTimeout(
              () => controller.abort(new Error('test cancellation')),
              250,
            )
          : undefined;
      let failure: ManagedProcessError | undefined;
      try {
        await runManagedProcess(process.execPath, ['-e', childScript], {
          cwd: path,
          timeoutMs: mode === 'timeout' ? 250 : 5_000,
          signal: controller.signal,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ManagedProcessError);
        failure = error as ManagedProcessError;
      } finally {
        if (cancellation) clearTimeout(cancellation);
      }
      expect(failure).toBeDefined();
      const nestedPid = Number(
        JSON.parse(outputLines(failure!.result.stdout)[0]).childPid,
      );
      expect(failure!.result[mode === 'timeout' ? 'timedOut' : 'cancelled']).toBe(
        true,
      );
      expect(isProcessAlive(failure!.result.pid)).toBe(false);
      expect(isProcessAlive(nestedPid)).toBe(false);
      await removeDirectoryWithRetry(path);
      expect(existsSync(path)).toBe(false);
    },
  );

  it('passes the exact external fixture with semantic diffs and leaves source untouched', async () => {
    const fixture = resetTokenFixture();
    expect(fixture.source).toBe('external');
    const paths = [
      'package.json',
      'src/auth/token-repository.js',
      'src/auth/service.js',
      'src/auth/audit.js',
      'src/auth/login.js',
      'tests/token.test.js',
    ];
    const externalBefore = new Map(
      paths.map((path) => [path, readFileSync(join(fixture.path, path))]),
    );
    const repo = await repository(Object.fromEntries(externalBefore));
    repositories.push(repo);
    const workspaceBefore = new Map(
      paths.map((path) => [path, readFileSync(join(repo.path, path))]),
    );

    const baseline = await execa('npm', ['test'], { cwd: repo.path, reject: false });
    expect(baseline.exitCode).toBe(1);
    expect(baseline.stdout).toMatch(/pass 2/);
    expect(baseline.stdout).toMatch(/fail 2/);

    const result = await runTask(repo.path, goal, { worker: 'mock' });
    expect(result.status).toBe('passed');
    expect(result.changedFiles).toEqual([
      'src/auth/token-repository.js',
      'src/auth/service.js',
    ]);
    expect(result.verificationCommands[0].exitCode).toBe(0);
    expect(result.verificationCommands[0].stdout).toMatch(/pass 4/);
    expect(result.verificationCommands[0].stdout).toMatch(/fail 0/);
    expect(result.telemetry.workerTurns).toBe(1);
    expect(result.telemetry.pageFaults).toBe(0);
    expect(result.contextPages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tests/token.test.js'),
        expect.stringContaining('src/auth/token-repository.js'),
        expect.stringContaining('src/auth/service.js'),
        expect.stringContaining('src/auth/audit.js'),
      ]),
    );
    expect(result.unifiedDiff).toContain('diff --git a/src/auth/token-repository.js');
    expect(result.unifiedDiff).toContain('if (!token) return undefined');
    expect(result.unifiedDiff).toContain('this.tokens.delete(value)');
    expect(result.unifiedDiff.match(/\+\s+this\.tokens\.delete\(value\);/g)).toHaveLength(2);
    expect(result.unifiedDiff).toContain('diff --git a/src/auth/service.js');
    expect(result.unifiedDiff).toContain('recordAudit');
    for (const path of result.changedFiles as string[]) {
      const record = result.transaction.fingerprints.find(
        (item: { path: string }) => item.path === path,
      );
      expect(record.before.value).not.toBe(record.after.value);
    }
    for (const [path, bytes] of workspaceBefore) {
      expect(readFileSync(join(repo.path, path))).toEqual(bytes);
    }
    for (const [path, bytes] of externalBefore) {
      expect(readFileSync(join(fixture.path, path))).toEqual(bytes);
    }
    expect((await execa('git', ['diff', '--exit-code'], { cwd: repo.path })).exitCode).toBe(0);
  });

  it('preserves the 2-pass/2-fail baseline and reaches 4/4 with the mock worker', async () => {
    const artifacts = mkdtempSync(join(tmpdir(), 'lattice-v2-artifacts-'));
    temporaryPaths.push(artifacts);
    const child = await runCli([
      'benchmark',
      '--worker',
      'mock',
      '--workspace',
      artifacts,
      '--json',
    ]);
    expect(isProcessAlive(child.pid)).toBe(false);
    expect(outputLines(child.stdout)).toHaveLength(1);
    const output = JSON.parse(outputLines(child.stdout)[0]);
    expect(output.artifact.baseline.status).toBe('failed');
    expect(output.artifact.baseline.stdout).toMatch(/pass 2/);
    expect(output.artifact.baseline.stdout).toMatch(/fail 2/);
    expect(output.artifact.fixtureSource).toBe('external');
    expect(output.artifact.result.status).toBe('passed');
    expect(output.artifact.result.changedFiles).toEqual([
      'src/auth/token-repository.js',
      'src/auth/service.js',
    ]);
    expect(output.artifact.result.verificationCommands[0].stdout).toMatch(/pass 4/);
    expect(output.artifact.result.verificationCommands[0].stdout).toMatch(/fail 0/);
    expect(output.artifact.result.telemetry.workerTurns).toBe(1);
    expect(output.artifact.result.telemetry.pageFaults).toBe(0);
    expect(output.artifact.result.telemetry.protocolRepairTurns).toBe(0);
    expect(output.artifact.result.evidence).toHaveLength(5);
    expect(
      output.artifact.result.evidence.every(
        (item: { result: string }) => item.result === 'passed',
      ),
    ).toBe(true);
    expect(output.artifact.schemaVersion).toBe(1);
    expect(output.artifact.result.telemetry.terminalStateReason).toContain(
      'acceptance evidence passed',
    );
    expect(existsSync(output.path)).toBe(true);
  }, 60_000);

  it('keeps JSON mode stdout to exactly one valid JSON object', async () => {
    const repo = await repository(fixtureFiles);
    repositories.push(repo);
    const child = await runCli([
      'run',
      goal,
      '--worker',
      'mock',
      '--workspace',
      repo.path,
      '--json',
    ]);
    const stdout = outputLines(child.stdout);
    const stderr = outputLines(child.stderr);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).not.toContain('heartbeat');
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.status).toBe('passed');
    expect(stderr.some((line) => line.includes('task.compiled'))).toBe(true);
    expect(isProcessAlive(child.pid)).toBe(false);

    const small = await repository({
      'package.json': JSON.stringify({ private: true }),
      'src/value.js': 'module.exports = 1;\n',
    });
    repositories.push(small);
    for (let iteration = 0; iteration < 2; iteration += 1) {
      const repeated = await runCli(
        [
          'run',
          `Inspect value ${iteration}`,
          '--worker',
          'manual',
          '--workspace',
          small.path,
          '--json',
        ],
        15_000,
      );
      const repeatedStdout = outputLines(repeated.stdout);
      expect(repeatedStdout).toHaveLength(1);
      expect(JSON.parse(repeatedStdout[0]).status).toBe(
        'manual_handoff_required',
      );
      expect(isProcessAlive(repeated.pid)).toBe(false);
    }
  }, 60_000);
});
