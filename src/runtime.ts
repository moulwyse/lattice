import { join } from 'node:path';
import { ContextKernel } from './context.js';
import { metadata, writeJson } from './core.js';
import {
  createEditGrantRegistry,
  persistContextSnapshot,
  syncEditGrantRegistry,
} from './edit-grants.js';
import { Events, type Event } from './events.js';
import { buildIndex } from './indexer.js';
import { lowerProviderPatch } from './patch-lowerer.js';
import {
  resolveCodexModelSettings,
  type CodexModelOverrides,
} from './model-settings.js';
import { newSession, saveSession, saveTask, type TaskResult } from './persistence.js';
import { WorkerProtocolError } from './protocol.js';
import { RuntimeStateMachine } from './state-machine.js';
import { compileTask } from './task.js';
import { telemetry, timed } from './telemetry.js';
import { transact, type TransactionResult } from './transaction.js';
import {
  loadVerifiedPatch,
  persistVerifiedPatch,
  verifiedPatchCacheKey,
} from './verified-cache.js';
import { CodexWorker, MockWorker, type Worker } from './worker.js';
import type {
  Evidence,
  InternalPatchIR,
  PatchResponse,
  TaskIR,
} from './types.js';

export type RunOptions = CodexModelOverrides & {
  worker: 'codex' | 'mock';
  json?: boolean;
  signal?: AbortSignal;
  retainWorktree?: boolean;
  events?: Events;
  useVerifiedCache?: boolean;
};

type VerificationTest = { name: string; result: 'passed' | 'failed' };

function parseVerificationTests(output: string): VerificationTest[] {
  const tests: VerificationTest[] = [];
  for (const line of output.split(/\r?\n/)) {
    const passed =
      line.match(/^\s*(?:\u2714|\u2713)\s+(.+?)(?:\s+\([^)]*\))?$/) ??
      line.match(/^\s*ok\s+\d+\s+-\s+(.+)$/i);
    if (passed) {
      tests.push({ name: passed[1].trim(), result: 'passed' });
      continue;
    }
    const failed =
      line.match(/^\s*(?:\u2716|\u00d7)\s+(.+?)(?:\s+\([^)]*\))?$/) ??
      line.match(/^\s*not ok\s+\d+\s+-\s+(.+)$/i);
    if (failed) tests.push({ name: failed[1].trim(), result: 'failed' });
  }
  return tests;
}

function testSupportsCriterion(criterion: string, testName: string) {
  const normalizedCriterion = criterion.toLowerCase();
  const normalizedTest = testName.toLowerCase();
  if (normalizedCriterion.includes('audit')) return normalizedTest.includes('audit');
  if (normalizedCriterion.includes('login')) return normalizedTest.includes('login');
  if (normalizedCriterion.includes('expired')) return normalizedTest.includes('expired');
  if (
    normalizedCriterion.includes('token') ||
    normalizedCriterion.includes('consume') ||
    normalizedCriterion.includes('consumption')
  ) {
    return (
      !normalizedTest.includes('expired') &&
      normalizedTest.includes('token') &&
      (normalizedTest.includes('valid') || normalizedTest.includes('once')) &&
      normalizedTest.includes('consum')
    );
  }
  return false;
}

function relevantFiles(criterion: string, changedFiles: string[]) {
  const normalized = criterion.toLowerCase();
  if (normalized.includes('audit')) return changedFiles.filter((path) => path.includes('service'));
  if (normalized.includes('login')) return changedFiles.filter((path) => path.includes('login'));
  if (
    normalized.includes('token') ||
    normalized.includes('expired') ||
    normalized.includes('consume') ||
    normalized.includes('consumption')
  ) {
    return changedFiles.filter((path) => path.includes('token-repository'));
  }
  return changedFiles;
}

export function buildEvidence(
  task: TaskIR,
  _status: 'passed' | 'failed',
  changedFiles: string[],
  command: string | undefined,
  commandOutput: string,
): Evidence[] {
  const verificationTests = parseVerificationTests(commandOutput);
  return task.acceptanceCriteria.map((criterion) => {
    const matchingTests = verificationTests.filter((test) =>
      testSupportsCriterion(criterion.text, test.name),
    );
    const passingTest = matchingTests.find((test) => test.result === 'passed');
    const matchedTest = passingTest ?? matchingTests[0];
    return {
      schemaVersion: 1,
      criterionId: criterion.id,
      criterion: criterion.text,
      result: passingTest ? 'passed' : 'unresolved',
      verificationCommand: command,
      testName: matchedTest?.name,
      changedFiles: relevantFiles(criterion.text, changedFiles),
    };
  });
}

export async function runTask(workspace: string, goal: string, options: RunOptions) {
  const task = compileTask(goal);
  const modelSettings =
    options.worker === 'codex'
      ? resolveCodexModelSettings(workspace, options, task.risk)
      : undefined;
  const metrics = telemetry();
  const machine = new RuntimeStateMachine(metrics);
  machine.transition('COMPILED');
  const session = newSession(workspace, options.worker);
  const events = options.events ?? new Events();
  const lifecycleEvents: Event[] = [];
  const stopRecording = events.on((event) => lifecycleEvents.push(event));
  const started = Date.now();
  let stage = 'compile';
  const result: TaskResult = {
    schemaVersion: 2,
    taskId: task.id,
    sessionId: session.id,
    status: 'running',
    telemetry: metrics,
    worker: options.worker,
    model: modelSettings?.model ?? null,
    reasoningEffort: modelSettings?.reasoningEffort ?? null,
    modelConfiguration:
      modelSettings === undefined
        ? null
        : {
            modelSource: modelSettings.modelSource,
            reasoningEffortSource: modelSettings.reasoningEffortSource,
            modelPolicy: modelSettings.modelPolicy,
            modelPolicySource: modelSettings.modelPolicySource,
            policyRisk: modelSettings.policyRisk,
          },
  };
  saveTask(workspace, result);

  try {
    options.signal?.throwIfAborted();
    events.emit('task.compiled', 'Compiled task', { taskId: task.id });
    stage = 'index';
    const index = await timed(metrics, 'index', () => buildIndex(workspace));
    if (index.files.length === 0) throw new Error('Fresh index contains zero source files.');
    machine.transition('INDEXED');
    events.emit('index.completed', `Indexed ${index.files.length} files`);

    options.signal?.throwIfAborted();
    stage = 'context';
    const kernel = new ContextKernel(workspace, index, task);
    const pages = kernel.initial();
    const editGrants = await createEditGrantRegistry(
      workspace,
      task.id,
      session.id,
      pages,
    );
    persistContextSnapshot(workspace, editGrants, pages);
    metrics.editGrantCount = editGrants.grants.length;
    metrics.editGrantMappingSha256 = editGrants.mappingSha256;
    metrics.initialContextCharacters = pages.reduce((total, page) => total + page.content.length, 0);
    metrics.initialContextEstimatedTokens = pages.reduce(
      (total, page) => total + page.estimatedTokens,
      0,
    );
    metrics.loadedPageCount = pages.length;
    metrics.loadedContextCharacters = metrics.initialContextCharacters;
    machine.transition('CONTEXT_GRANTED');
    events.emit('context.initial_selected', `Loaded ${pages.length} pages`);

    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    let worker: Worker | undefined;
    let response: PatchResponse | undefined;
    let internalPatch: InternalPatchIR | undefined;
    let transaction: TransactionResult | undefined;
    const cacheKey = verifiedPatchCacheKey(task, index, {
      repositoryId: editGrants.repositoryId,
      baseCommit: editGrants.baseCommit,
    });
    metrics.verifiedPatchCacheKey = cacheKey;

    if (options.useVerifiedCache !== false) {
      const cached = loadVerifiedPatch(workspace, cacheKey);
      if (cached) {
        stage = 'verified_cache';
        events.emit('cache.verified_patch_candidate', 'Revalidating exact cached patch');
        try {
          const cachedTransaction = await timed(metrics, 'cache_transaction', () =>
            transact(
              workspace,
              cached.internalPatch,
              task.allowedVerificationCommands,
              metrics,
              options.retainWorktree,
              controller.signal,
            ),
          );
          if (cachedTransaction.status === 'passed') {
            internalPatch = cached.internalPatch;
            transaction = cachedTransaction;
            metrics.verifiedPatchCacheHit = true;
            machine.transition('PATCH_LOWERED', 'exact verified patch cache hit');
            machine.transition('TRANSACTION_RUNNING', 'revalidated cached patch');
            machine.transition('VERIFYING', 'cached patch verification completed');
            events.emit('cache.verified_patch_hit', 'Reused and reverified exact patch');
          } else {
            events.emit('cache.verified_patch_rejected', 'Cached patch no longer verifies');
          }
        } catch (error) {
          events.emit('cache.verified_patch_rejected', 'Cached patch could not be revalidated', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (!transaction) {
      worker = options.worker === 'mock' ? new MockWorker() : new CodexWorker(modelSettings);
      const input = () => ({
        workspace,
        task,
        pages: kernel.pages,
        repositoryMap: index.files.map((file) => ({ path: file.path, symbols: file.symbols })),
        signal: controller.signal,
        metrics,
        editGrants,
        onProtocolRepair: () => {
          machine.transition('PROTOCOL_REPAIR', 'provider response validation failed');
          machine.transition('WORKER_RUNNING', 'protocol repair turn');
        },
      });

      stage = 'worker';
      machine.transition('WORKER_RUNNING');
      let workerResponse = await timed(metrics, 'worker', () => worker!.run(input()));
      machine.transition('RESPONSE_NORMALIZED');
      machine.transition('RESPONSE_VALIDATED');
      while (workerResponse.kind === 'context_request') {
        if (metrics.pageFaults >= task.budget.maxFaults) {
          throw new Error('context page-fault budget exceeded');
        }
        if (metrics.workerTurns >= task.budget.maxTurns) {
          throw new Error('worker turn budget exceeded');
        }
        metrics.pageFaults += 1;
        machine.transition('CONTEXT_FAULT');
        for (const request of workerResponse.requests) kernel.resolve(request);
        await syncEditGrantRegistry(workspace, editGrants, kernel.pages);
        persistContextSnapshot(workspace, editGrants, kernel.pages);
        metrics.editGrantCount = editGrants.grants.length;
        metrics.editGrantMappingSha256 = editGrants.mappingSha256;
        metrics.loadedPageCount = kernel.pages.length;
        metrics.loadedContextCharacters = kernel.pages.reduce(
          (total, page) => total + page.content.length,
          0,
        );
        events.emit('context.page_fault', `Resolved context fault ${metrics.pageFaults}`);
        machine.transition('CONTEXT_GRANTED');
        machine.transition('WORKER_RUNNING');
        workerResponse = await worker.continue(input());
        machine.transition('RESPONSE_NORMALIZED');
        machine.transition('RESPONSE_VALIDATED');
      }
      options.signal?.throwIfAborted();
      response = workerResponse as PatchResponse;

      stage = 'patch_lowering';
      internalPatch = lowerProviderPatch(
        response.patch,
        editGrants,
        {
          taskId: task.id,
          sessionId: session.id,
          repositoryId: editGrants.repositoryId,
          baseCommit: editGrants.baseCommit,
          epoch: editGrants.epoch,
        },
        metrics,
        workspace,
      );
      machine.transition('PATCH_LOWERED');

      stage = 'transaction';
      machine.transition('TRANSACTION_RUNNING');
      transaction = await timed(metrics, 'transaction', () =>
        transact(
          workspace,
          internalPatch!,
          task.allowedVerificationCommands,
          metrics,
          options.retainWorktree,
          controller.signal,
          120_000,
          () => machine.transition('VERIFYING'),
        ),
      );
    }
    const finalPatch = internalPatch!;
    const finalTransaction = transaction!;
    metrics.changedFileCount = finalTransaction.changedFiles.length;
    const commandOutput = finalTransaction.verification
      .map((verification) => `${verification.stdout}\n${verification.stderr}`)
      .join('\n');
    const evidence = buildEvidence(
      task,
      finalTransaction.status,
      finalTransaction.changedFiles,
      finalTransaction.verification[0]?.command,
      commandOutput,
    );
    const unresolvedCriteria = evidence.filter((item) => item.result !== 'passed');
    result.status =
      finalTransaction.status === 'failed'
        ? 'failed'
        : unresolvedCriteria.length > 0
          ? 'partial'
          : 'passed';
    if (finalTransaction.status === 'failed') result.failureStage = 'verification';
    if (result.status === 'passed') {
      machine.transition('PASSED', 'verification and acceptance evidence passed');
    } else if (result.status === 'partial') {
      machine.transition('FAILED', 'acceptance evidence incomplete');
    } else {
      machine.transition('FAILED', 'required verification failed');
    }
    Object.assign(result, {
      task,
      contextSnapshotVersion: 1,
      workerResponseVersion: response?.schemaVersion ?? null,
      providerPatchVersion: response?.patch.schemaVersion ?? null,
      internalPatch: finalPatch,
      changedFiles: finalTransaction.changedFiles,
      unifiedDiff: finalTransaction.diff,
      verificationCommands: finalTransaction.verification,
      transaction: finalTransaction,
      evidence,
      unresolvedCriteria,
      contextPages: kernel.pages.map((page) => page.id),
      pageFaults: kernel.faults,
      workerTurns: metrics.workerTurns,
      protocolRepairTurns: metrics.protocolRepairTurns,
      threadId: worker?.threadId,
      elapsedMs: Date.now() - started,
    });
    if (result.status === 'passed' && !metrics.verifiedPatchCacheHit) {
      persistVerifiedPatch(workspace, cacheKey, finalPatch);
      events.emit('cache.verified_patch_stored', 'Stored exact verified patch');
    }
    session.threadId = worker?.threadId;
    saveSession(session);
    events.emit(`task.${result.status}`, `Task ${result.status}`);
    options.signal?.removeEventListener('abort', abort);
    return result;
  } catch (error) {
    result.status = options.signal?.aborted ? 'cancelled' : 'failed';
    result.failureStage = stage;
    result.error = error instanceof Error ? error.message : String(error);
    result.elapsedMs = Date.now() - started;
    if (error instanceof WorkerProtocolError) {
      result.debug = { rawWorkerOutput: error.rawOutput };
    }
    machine.terminate(Boolean(options.signal?.aborted), result.error);
    events.emit(`task.${result.status}`, result.error);
    return result;
  } finally {
    result.lifecycleEvents = lifecycleEvents;
    saveTask(workspace, result);
    writeJson(join(metadata(workspace), 'logs', `${task.id}.json`), lifecycleEvents);
    stopRecording();
  }
}
