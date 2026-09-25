import { join } from 'node:path';
import type { CodexOptions } from '@openai/codex-sdk';
import { resolveClaudeModelSettings } from './claude-model-settings.js';
import { ClaudeWorker } from './claude-worker.js';
import { ContextKernel, repositoryMapForTask } from './context.js';
import { metadata, writeJson } from './core.js';
import {
  createEditGrantRegistry,
  persistContextSnapshot,
  syncEditGrantRegistry,
} from './edit-grants.js';
import { Events, type Event } from './events.js';
import { buildIndex } from './indexer.js';
import { lowerProviderPatch, PatchLoweringError } from './patch-lowerer.js';
import {
  resolveCodexModelSettings,
  type ModelPolicy,
} from './model-settings.js';
import { newSession, saveSession, saveTask, type TaskResult } from './persistence.js';
import { WorkerProtocolError } from './protocol.js';
import { repositoryRoot } from './repository.js';
import { RuntimeStateMachine } from './state-machine.js';
import { compileTask, withRepositoryVerification } from './task.js';
import { telemetry, timed } from './telemetry.js';
import { applyVerifiedPatch, transact, type TransactionResult } from './transaction.js';
import {
  loadVerifiedPatch,
  persistVerifiedPatch,
  verifiedPatchCacheKey,
} from './verified-cache.js';
import {
  CodexWorker,
  MockWorker,
  type PatchRevisionFeedback,
  type Worker,
} from './worker.js';
import type {
  Evidence,
  InternalPatchIR,
  PatchResponse,
  TaskIR,
} from './types.js';

export type RunOptions = {
  worker: 'codex' | 'claude' | 'mock';
  model?: string;
  reasoningEffort?: string;
  modelPolicy?: ModelPolicy;
  maxBudgetUsd?: number;
  json?: boolean;
  signal?: AbortSignal;
  retainWorktree?: boolean;
  events?: Events;
  useVerifiedCache?: boolean;
  /** Apply the verified diff to the workspace after the task passes. */
  apply?: boolean;
  /** Optional per-client overrides, used to isolate controlled benchmarks. */
  codexConfig?: CodexOptions['config'];
};

type VerificationTest = { name: string; result: 'passed' | 'failed' };

// Reporter lines for node:test/TAP, Vitest/Jest, pytest -v and go test -v.
const passedTestLine = [
  /^\s*(?:\u2714|\u2713|\u221a)\s+(.+?)(?:\s+\([^)]*\)|\s+\d+(?:\.\d+)?\s*m?s)?$/,
  /^\s*ok\s+\d+\s+-\s+(.+)$/i,
  /^\s*(\S+::\S+)\s+PASSED\b/,
  /^\s*--- PASS:\s+(\S+)/,
];
const failedTestLine = [
  /^\s*(?:\u2716|\u2717|\u00d7)\s+(.+?)(?:\s+\([^)]*\)|\s+\d+(?:\.\d+)?\s*m?s)?$/,
  /^\s*not ok\s+\d+\s+-\s+(.+)$/i,
  /^\s*(\S+::\S+)\s+FAILED\b/,
  /^\s*--- FAIL:\s+(\S+)/,
];

function parseVerificationTests(output: string): VerificationTest[] {
  const tests: VerificationTest[] = [];
  for (const line of output.split(/\r?\n/)) {
    const passed = passedTestLine.map((pattern) => line.match(pattern)).find(Boolean);
    if (passed) {
      tests.push({ name: passed[1].trim(), result: 'passed' });
      continue;
    }
    const failed = failedTestLine.map((pattern) => line.match(pattern)).find(Boolean);
    if (failed) tests.push({ name: failed[1].trim(), result: 'failed' });
  }
  return tests;
}

const evidenceStopWords = new Set([
  'add', 'and', 'are', 'but', 'can', 'does', 'ensure', 'fix', 'for', 'from', 'has',
  'have', 'implement', 'into', 'its', 'make', 'must', 'not', 'preserve', 'should',
  'support', 'that', 'the', 'then', 'this', 'update', 'when', 'with',
]);

/** Lowercased word stems, split on camelCase, snake_case and punctuation. */
function stems(text: string) {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  return [
    ...new Set(
      words
        .filter((word) => word.length >= 3 && !evidenceStopWords.has(word))
        .map((word) => word.slice(0, 5)),
    ),
  ];
}

export function testSupportsCriterion(criterion: string, testName: string) {
  const criterionStems = stems(criterion);
  if (criterionStems.length === 0) return false;
  const testStems = new Set(stems(testName));
  const shared = criterionStems.filter((stem) => testStems.has(stem)).length;
  return shared >= Math.max(1, Math.ceil(criterionStems.length * 0.6));
}

/**
 * Per-criterion evidence is informational: a criterion is `passed` only when a
 * named test that shares most of its vocabulary passed, `failed` when every
 * such test failed, and `unresolved` when no test output can be attributed to
 * it. Task status is decided by the verification commands, not by this map.
 */
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
      result: passingTest ? 'passed' : matchedTest ? 'failed' : 'unresolved',
      verificationCommand: command,
      testName: matchedTest?.name,
      changedFiles,
    };
  });
}

/** Corrected patches the worker may send after a rejected or failing one. */
export const MAX_PATCH_REVISIONS = 2;
const MAX_FEEDBACK_CHARACTERS = 6_000;

/** The failing command and the tail of its output, where runners summarize. */
function verificationFeedback(transaction: TransactionResult) {
  const failing =
    transaction.verification.find((result) => result.exitCode !== 0) ??
    transaction.verification.at(-1);
  if (!failing) return 'no verification command ran';
  const output = `${failing.stdout}\n${failing.stderr}`.trim();
  return `${failing.command} exited with ${failing.exitCode}\n${output.slice(-MAX_FEEDBACK_CHARACTERS)}`;
}

/** A task passes only when at least one required verification command ran and all passed. */
export function verifiedTaskStatus(transaction: {
  status: 'passed' | 'failed';
  verification: unknown[];
}) {
  return transaction.status === 'passed' && transaction.verification.length > 0
    ? ('passed' as const)
    : ('failed' as const);
}

export async function runTask(requestedWorkspace: string, goal: string, options: RunOptions) {
  const workspace = await repositoryRoot(requestedWorkspace);
  const task = compileTask(goal);
  const modelSettings =
    options.worker === 'codex'
      ? resolveCodexModelSettings(workspace, options, task.risk)
      : options.worker === 'claude'
        ? resolveClaudeModelSettings(workspace, options, task.risk)
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
    goal: task.goal,
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
            ...('maxBudgetUsd' in modelSettings && modelSettings.maxBudgetUsd
              ? { maxBudgetUsd: modelSettings.maxBudgetUsd }
              : {}),
          },
  };
  saveTask(workspace, result);

  let worker: Worker | undefined;
  let detachCancellation = () => undefined as void;
  try {
    options.signal?.throwIfAborted();
    events.emit('task.compiled', 'Compiled task', { taskId: task.id });
    stage = 'index';
    const index = await timed(metrics, 'index', () => buildIndex(workspace));
    if (index.files.length === 0) throw new Error('Fresh index contains zero source files.');
    withRepositoryVerification(task, index.scripts);
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
    detachCancellation = () => options.signal?.removeEventListener('abort', abort);
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
      worker =
        options.worker === 'mock'
          ? new MockWorker()
          : options.worker === 'claude'
            ? new ClaudeWorker(
                modelSettings as ReturnType<typeof resolveClaudeModelSettings>,
              )
            : new CodexWorker(
                modelSettings as ReturnType<typeof resolveCodexModelSettings>,
                options.codexConfig,
              );
      const input = () => ({
        workspace,
        task,
        pages: kernel.pages,
        repositoryMap: repositoryMapForTask(
          index,
          task,
          new Set(kernel.pages.map((page) => page.path)),
        ),
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
      let revisions = 0;
      const canRevise = () =>
        Boolean(worker?.revise) &&
        revisions < MAX_PATCH_REVISIONS &&
        metrics.workerTurns < task.budget.maxTurns;
      // A rejected patch or a failed verification goes back to the worker with
      // the concrete error instead of ending the task on the first attempt.
      const revise = async (feedback: PatchRevisionFeedback) => {
        revisions += 1;
        result.patchRevisions = revisions;
        machine.transition('PATCH_REVISION', feedback.reason);
        events.emit('patch.revision_requested', `Returned ${feedback.reason} to the worker`);
        stage = 'worker';
        machine.transition('WORKER_RUNNING', 'patch revision turn');
        const revised = await timed(metrics, 'worker', () => worker!.revise!(input(), feedback));
        machine.transition('RESPONSE_NORMALIZED');
        machine.transition('RESPONSE_VALIDATED');
        return revised;
      };
      for (;;) {
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
        try {
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
        } catch (error) {
          if (!(error instanceof PatchLoweringError) || !canRevise()) throw error;
          workerResponse = await revise({ reason: error.reason, detail: error.message });
          continue;
        }
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
        if (verifiedTaskStatus(transaction) === 'passed' || !canRevise()) break;
        workerResponse = await revise({
          reason: 'verification_failed',
          detail: verificationFeedback(transaction),
        });
      }
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
    result.status = verifiedTaskStatus(finalTransaction);
    if (result.status === 'passed') {
      machine.transition(
        'PASSED',
        `required verification passed; acceptance evidence ${evidence.length - unresolvedCriteria.length}/${evidence.length} attributed`,
      );
    } else {
      result.failureStage = 'verification';
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
    result.applied = false;
    if (result.status === 'passed' && options.apply) {
      try {
        await applyVerifiedPatch(workspace, finalPatch, finalTransaction.diff);
        result.applied = true;
        events.emit('patch.applied', `Applied ${finalTransaction.changedFiles.length} verified file change(s)`);
      } catch (error) {
        result.applyError = error instanceof Error ? error.message : String(error);
        events.emit('patch.apply_failed', result.applyError as string);
      }
    }
    session.threadId = worker?.threadId;
    saveSession(session);
    events.emit(`task.${result.status}`, `Task ${result.status}`);
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
    detachCancellation();
    await worker?.dispose?.().catch(() => undefined);
    result.lifecycleEvents = lifecycleEvents;
    saveTask(workspace, result);
    writeJson(join(metadata(workspace), 'logs', `${task.id}.json`), lifecycleEvents);
    stopRecording();
  }
}
