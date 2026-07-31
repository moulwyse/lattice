import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextKernel } from './context.js';
import { metadata, readJson, writeJson } from './core.js';
import {
  createEditGrantRegistry,
  loadEditGrantRegistry,
  persistContextSnapshot,
  providerContextPage,
  syncEditGrantRegistry,
} from './edit-grants.js';
import { buildIndex } from './indexer.js';
import { decodeLegacyHandoffResponse } from './legacy-handoff.js';
import { lowerProviderPatch } from './patch-lowerer.js';
import { loadTask, newSession, saveTask, type TaskResult } from './persistence.js';
import { parseResponse } from './protocol.js';
import { buildEvidence } from './runtime.js';
import { compileTask } from './task.js';
import { telemetry } from './telemetry.js';
import { transact } from './transaction.js';
import type { ContextPage, TaskIR, WorkerResponse } from './types.js';

export type HandoffState = {
  schemaVersion?: 1;
  protocolVersion?: 2 | 3;
  taskId: string;
  sessionId: string;
  workspace: string;
  round: number;
  task: TaskIR;
  pages: ContextPage[];
  requestPath: string;
  responsePath: string;
};

const handoffDirectory = (workspace: string, id: string) =>
  join(metadata(workspace), 'handoffs', id);
const statePath = (workspace: string, id: string) =>
  join(handoffDirectory(workspace, id), 'state.json');

function persist(state: HandoffState) {
  const suffix = state.round === 1 ? '' : `-${state.round}`;
  state.requestPath = join(handoffDirectory(state.workspace, state.taskId), `request${suffix}.json`);
  state.responsePath = join(handoffDirectory(state.workspace, state.taskId), `response${suffix}.json`);
  const registry = loadEditGrantRegistry(state.workspace, state.taskId);
  writeJson(state.requestPath, {
    schemaVersion: 1,
    protocolVersion: 3,
    taskId: state.taskId,
    sessionId: state.sessionId,
    taskIr: state.task,
    acceptanceCriteria: state.task.acceptanceCriteria,
    grantedContextPages: state.pages.map((page) =>
      providerContextPage(registry, page),
    ),
    workerOutputSchemaDescription: {
      oneOf: [
        {
          kind: 'context_request',
          requests: [{ reason: 'string', pathHint: 'optional relative path', symbol: 'optional symbol' }],
        },
        {
          kind: 'patch',
          patch: {
            summary: 'string',
            changes: [
              {
                editHandle: 'E1',
                operation: 'replace_file',
                replacementContent: 'complete resulting file content',
              },
            ],
            verificationCommands: ['npm test'],
          },
        },
      ],
    },
    validPatchExample: {
      kind: 'patch',
      patch: {
        summary: 'Implement the requested behavior',
        changes: [
          {
            editHandle: 'E1',
            operation: 'replace_file',
            replacementContent: 'export const value = 2;\n',
          },
        ],
        verificationCommands: ['npm test'],
      },
    },
    instructions: [
      'Return pure JSON only.',
      'Return exactly one action: a canonical context_request or canonical patch.',
      'Never return contextRequest and patch together.',
      'Use editHandle values exactly as granted.',
      'Patch responses must never return paths, fingerprints, repository identities, or transaction metadata.',
      'Use complete-file replacements, not diffs.',
      'Do not use Markdown code fences.',
      'Do not invent unseen repository contents.',
    ],
  });
  writeJson(statePath(state.workspace, state.taskId), state);
}

export async function startHandoff(workspace: string, goal: string) {
  const task = compileTask(goal);
  const session = newSession(workspace, 'manual');
  const index = await buildIndex(workspace);
  if (index.files.length === 0) throw new Error('Fresh index contains zero source files.');
  const kernel = new ContextKernel(workspace, index, task);
  const pages = kernel.initial();
  const registry = await createEditGrantRegistry(
    workspace,
    task.id,
    session.id,
    pages,
  );
  persistContextSnapshot(workspace, registry, pages);
  const state: HandoffState = {
    schemaVersion: 1,
    protocolVersion: 3,
    taskId: task.id,
    sessionId: session.id,
    workspace,
    round: 1,
    task,
    pages,
    requestPath: '',
    responsePath: '',
  };
  persist(state);
  const metrics = telemetry();
  metrics.initialContextCharacters = pages.reduce((total, page) => total + page.content.length, 0);
  metrics.initialContextEstimatedTokens = pages.reduce(
    (total, page) => total + page.estimatedTokens,
    0,
  );
  metrics.loadedContextCharacters = metrics.initialContextCharacters;
  metrics.loadedPageCount = pages.length;
  metrics.editGrantCount = registry.grants.length;
  metrics.editGrantMappingSha256 = registry.mappingSha256;
  saveTask(workspace, {
    schemaVersion: 2,
    taskId: task.id,
    sessionId: session.id,
    status: 'running',
    telemetry: metrics,
    worker: 'manual',
    model: null,
    task,
    contextPages: pages.map((page) => page.id),
  });
  return state;
}

export function validateHandoff(workspace: string, id: string) {
  const state = readJson<HandoffState>(statePath(workspace, id));
  if (!existsSync(state.responsePath)) throw new Error(`missing response: ${state.responsePath}`);
  const raw = readFileSync(state.responsePath, 'utf8');
  const requestVersion =
    state.protocolVersion ??
    readJson<{ protocolVersion?: number }>(state.requestPath).protocolVersion;
  if (requestVersion === 2) {
    const grantPath = join(metadata(workspace), 'edit-grants', `${state.taskId}.json`);
    // Genuine v2 artifacts predate registries; deterministic page order is
    // used until continuation persists the migrated registry.
    const registry = existsSync(grantPath)
      ? loadEditGrantRegistry(workspace, state.taskId)
      : undefined;
    return decodeLegacyHandoffResponse(raw, state.pages, registry);
  }
  if (requestVersion !== 3) {
    throw new Error(`unsupported handoff protocol version: ${String(requestVersion)}`);
  }
  return parseResponse(raw);
}

export async function continueHandoff(
  workspace: string,
  id: string,
): Promise<{ state: HandoffState; response: WorkerResponse; result?: TaskResult }> {
  const state = readJson<HandoffState>(statePath(workspace, id));
  if (state.task.schemaVersion !== 2) {
    state.task = { ...state.task, schemaVersion: 2 };
  }
  const response = validateHandoff(workspace, id);
  const grantPath = join(metadata(workspace), 'edit-grants', `${state.taskId}.json`);
  const registry = existsSync(grantPath)
    ? loadEditGrantRegistry(workspace, state.taskId)
    : await createEditGrantRegistry(
        workspace,
        state.taskId,
        state.sessionId,
        state.pages,
      );

  if (response.kind === 'context_request') {
    const index = await buildIndex(workspace);
    const kernel = new ContextKernel(workspace, index, state.task);
    state.pages
      .filter((page) =>
        index.files.some(
          (file) => file.path === page.path && file.fingerprint.value === page.fingerprint.value,
        ),
      )
      .forEach((page) => kernel.add({ ...page, provenance: 'persisted-cache' }));
    response.requests.forEach((request) => kernel.resolve(request));
    state.pages = kernel.pages;
    await syncEditGrantRegistry(workspace, registry, state.pages);
    persistContextSnapshot(workspace, registry, state.pages);
    state.schemaVersion = 1;
    state.protocolVersion = 3;
    state.round += 1;
    persist(state);
    const taskResult = loadTask(workspace, state.taskId);
    taskResult.telemetry.pageFaults += 1;
    taskResult.telemetry.loadedPageCount = state.pages.length;
    taskResult.telemetry.loadedContextCharacters = state.pages.reduce(
      (total, page) => total + page.content.length,
      0,
    );
    taskResult.telemetry.editGrantCount = registry.grants.length;
    taskResult.telemetry.editGrantMappingSha256 = registry.mappingSha256;
    taskResult.contextPages = state.pages.map((page) => page.id);
    taskResult.pageFaults = kernel.faults;
    saveTask(workspace, taskResult);
    return { state, response };
  }

  const persisted = loadTask(workspace, state.taskId);
  const metrics = persisted.telemetry ?? telemetry();
  const internalPatch = lowerProviderPatch(
    response.patch,
    registry,
    {
      taskId: state.taskId,
      sessionId: state.sessionId,
      repositoryId: registry.repositoryId,
      baseCommit: registry.baseCommit,
      epoch: registry.epoch,
    },
    metrics,
    workspace,
  );
  let transaction;
  try {
    transaction = await transact(
      workspace,
      internalPatch,
      state.task.allowedVerificationCommands,
      metrics,
    );
  } catch (error) {
    const failed: TaskResult = {
      schemaVersion: 2,
      taskId: state.taskId,
      sessionId: state.sessionId,
      status: 'failed',
      failureStage: 'transaction',
      error: error instanceof Error ? error.message : String(error),
      telemetry: metrics,
      worker: 'manual',
      model: null,
      task: state.task,
    };
    saveTask(workspace, failed);
    return { state, response, result: failed };
  }
  const commandOutput = transaction.verification
    .map((verification) => `${verification.stdout}\n${verification.stderr}`)
    .join('\n');
  const evidence = buildEvidence(
    state.task,
    transaction.status,
    transaction.changedFiles,
    transaction.verification[0]?.command,
    commandOutput,
  );
  const unresolved = evidence.filter((item) => item.result !== 'passed');
  const result: TaskResult = {
    schemaVersion: 2,
    taskId: state.taskId,
    sessionId: state.sessionId,
    status:
      transaction.status === 'failed' ? 'failed' : unresolved.length > 0 ? 'partial' : 'passed',
    telemetry: metrics,
    internalPatch,
    task: state.task,
    changedFiles: transaction.changedFiles,
    unifiedDiff: transaction.diff,
    verificationCommands: transaction.verification,
    transaction,
    evidence,
    unresolvedCriteria: unresolved,
  };
  saveTask(workspace, result);
  return { state, response, result };
}
