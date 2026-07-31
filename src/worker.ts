import {
  Codex,
  type Thread,
  type ThreadOptions,
} from '@openai/codex-sdk';
import { rawHash } from './core.js';
import { grantForPage } from './edit-grants.js';
import {
  parseResponse,
  WorkerProtocolError,
} from './providers/codex/protocol.js';
import {
  buildContextFaultPrompt,
  buildInitialWorkerPrompt,
  buildProtocolRepairPrompt,
} from './providers/codex/prompt.js';
import {
  recordProtocolDiagnostics,
  recordTurnUsage,
  type ProviderUsage,
} from './telemetry.js';
import type {
  ContextPage,
  EditGrantRegistryIR,
  TaskIR,
  Telemetry,
  TurnKind,
  WorkerResponse,
} from './types.js';
import type { CodexModelOverrides } from './model-settings.js';

export {
  buildContextFaultPrompt,
  buildInitialWorkerPrompt,
  buildProtocolRepairPrompt,
  externalProtocol,
  STABLE_WORKER_PREFIX,
  STABLE_WORKER_PREFIX_SHA256,
} from './providers/codex/prompt.js';

export type WorkerInput = {
  workspace: string;
  task: TaskIR;
  pages: ContextPage[];
  repositoryMap: { path: string; symbols: string[] }[];
  signal: AbortSignal;
  metrics: Telemetry;
  editGrants: EditGrantRegistryIR;
  onProtocolRepair?: () => void;
};

export interface Worker {
  threadId?: string;
  run(input: WorkerInput): Promise<WorkerResponse>;
  continue(input: WorkerInput): Promise<WorkerResponse>;
}

export function selectNewContextPages(pages: ContextPage[], sentPageIds: Set<string>) {
  const selected = pages.filter((page) => !sentPageIds.has(page.id));
  selected.forEach((page) => sentPageIds.add(page.id));
  return selected;
}

export function replaceResetTokenRepository(content: string) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const clock = content.includes('this.now()') ? 'this.now()' : 'Date.now()';
  const consumeMethod = [
    '  consume(value) {',
    '    const token = this.tokens.get(value);',
    '    if (!token) return undefined;',
    `    if (token.expiresAt <= ${clock}) {`,
    '      this.tokens.delete(value);',
    '      return undefined;',
    '    }',
    '    this.tokens.delete(value);',
    '    return token;',
    '  }',
  ].join(eol);
  const replacement = content.replace(
    /^  consume\(value\) \{\r?\n(?:    .*(?:\r?\n))*?  \}/m,
    consumeMethod,
  );
  if (replacement === content) {
    throw new Error('MockWorker does not recognize the reset-token consume(value) fixture');
  }
  return replacement;
}

export function replaceResetService(content: string) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const importLine = "const { TokenRepository } = require('./token-repository.js');";
  let replacement = content.replace(
    importLine,
    `${importLine}${eol}const { recordAudit } = require('./audit.js');`,
  );
  replacement = replacement.replace(
    '    return this.tokens.consume(value);',
    [
      '    const token = this.tokens.consume(value);',
      "    if (token) recordAudit({ type: 'password_reset', token: value });",
      '    return token;',
    ].join(eol),
  );
  if (replacement === content) {
    throw new Error('MockWorker does not recognize the reset service fixture');
  }
  return replacement;
}

async function recordMockTurn<T>(
  input: WorkerInput,
  kind: Extract<TurnKind, 'initial' | 'context_fault'>,
  operation: () => Promise<T>,
) {
  const started = Date.now();
  try {
    const result = await operation();
    recordTurnUsage(input.metrics, kind, null, Date.now() - started);
    const raw = JSON.stringify(result);
    const response = result as WorkerResponse;
    recordProtocolDiagnostics(input.metrics, {
      rawResponseSha256: rawHash(Buffer.from(raw, 'utf8')),
      detectedEnvelopeShape:
        response.kind === 'patch' ? 'canonical_patch' : 'canonical_context_request',
      normalizationResult:
        response.kind === 'patch' ? 'canonical_patch' : 'canonical_context_request',
      validationError: null,
    });
    return result;
  } catch (error) {
    recordTurnUsage(input.metrics, kind, null, Date.now() - started);
    throw error;
  }
}

export class MockWorker implements Worker {
  threadId = 'mock-v2';
  private readonly sentPageIds = new Set<string>();

  async run(input: WorkerInput) {
    this.sentPageIds.clear();
    const pages = selectNewContextPages(input.pages, this.sentPageIds);
    input.metrics.promptManifests.push(buildInitialWorkerPrompt(input, pages).manifest);
    return recordMockTurn(input, 'initial', () => this.response(input));
  }

  async continue(input: WorkerInput) {
    const pages = selectNewContextPages(input.pages, this.sentPageIds);
    input.metrics.promptManifests.push(
      buildContextFaultPrompt(input.metrics, pages, input.editGrants).manifest,
    );
    return recordMockTurn(input, 'context_fault', () => this.response(input));
  }

  private async response(input: WorkerInput): Promise<WorkerResponse> {
    const token = input.pages.find((page) => page.path.endsWith('token-repository.js'));
    const service = input.pages.find((page) => page.path.endsWith('service.js'));
    if (!token || !service) {
      return {
        schemaVersion: 1,
        kind: 'context_request',
        requests: [
          { reason: 'Need reset token repository', pathHint: 'src/auth/token-repository.js' },
          { reason: 'Need reset service', pathHint: 'src/auth/service.js' },
        ],
      };
    }
    return {
      schemaVersion: 1,
      kind: 'patch',
      patch: {
        schemaVersion: 1,
        summary: 'Make reset tokens single use and audit resets',
        changes: [
          {
            editHandle: grantForPage(input.editGrants, token)!.handle,
            operation: 'replace_file',
            replacementContent: replaceResetTokenRepository(token.content),
          },
          {
            editHandle: grantForPage(input.editGrants, service)!.handle,
            operation: 'replace_file',
            replacementContent: replaceResetService(service.content),
          },
        ],
        verificationCommands: ['npm test'],
      },
    };
  }
}

export async function withTimeout<T>(
  milliseconds: number,
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`worker timeout after ${milliseconds}ms`)),
    milliseconds,
  );
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', abort);
  }
}

export function codexThreadOptions(
  workspace: string,
  modelSettings: CodexModelOverrides = {},
): ThreadOptions {
  return {
    ...(modelSettings.model ? { model: modelSettings.model } : {}),
    ...(modelSettings.reasoningEffort
      ? { modelReasoningEffort: modelSettings.reasoningEffort }
      : {}),
    workingDirectory: workspace,
    sandboxMode: 'read-only',
  };
}

async function runProviderTurn<T extends { usage: ProviderUsage | null }>(
  input: WorkerInput,
  kind: TurnKind,
  operation: () => Promise<T>,
) {
  const started = Date.now();
  try {
    const result = await operation();
    recordTurnUsage(input.metrics, kind, result.usage, Date.now() - started);
    return result;
  } catch (error) {
    recordTurnUsage(input.metrics, kind, null, Date.now() - started);
    throw error;
  }
}

export class CodexWorker implements Worker {
  private readonly codex = new Codex();
  private thread?: Thread;
  private repaired = false;
  private readonly sentPageIds = new Set<string>();
  threadId?: string;

  constructor(private readonly modelSettings: CodexModelOverrides = {}) {}

  async run(input: WorkerInput) {
    this.sentPageIds.clear();
    this.repaired = false;
    this.thread = await withTimeout(30_000, input.signal, async () =>
      this.codex.startThread(codexThreadOptions(input.workspace, this.modelSettings)),
    );
    return this.turn(input, 'initial');
  }

  async continue(input: WorkerInput) {
    if (!this.thread && this.threadId) {
      this.thread = this.codex.resumeThread(
        this.threadId,
        codexThreadOptions(input.workspace, this.modelSettings),
      );
    }
    if (!this.thread) throw new Error('Codex worker has no active thread');
    return this.turn(input, 'context_fault');
  }

  private async turn(
    input: WorkerInput,
    kind: Extract<TurnKind, 'initial' | 'context_fault'>,
  ): Promise<WorkerResponse> {
    const grantedContextPages = selectNewContextPages(input.pages, this.sentPageIds);
    const built =
      kind === 'initial'
        ? buildInitialWorkerPrompt(input, grantedContextPages)
        : buildContextFaultPrompt(input.metrics, grantedContextPages, input.editGrants);
    input.metrics.promptManifests.push(built.manifest);
    const result = await runProviderTurn(input, kind, () =>
      withTimeout(120_000, input.signal, (signal) =>
        this.thread!.run(built.text, { signal }),
      ),
    );
    this.threadId = this.thread!.id ?? this.threadId;
    try {
      return parseResponse(result.finalResponse, {
        onDiagnostics: (diagnostics) =>
          recordProtocolDiagnostics(input.metrics, diagnostics),
      });
    } catch (error) {
      if (this.repaired || !(error instanceof WorkerProtocolError) || !error.repairable) throw error;
      this.repaired = true;
      input.metrics.protocolRepairTurns += 1;
      input.onProtocolRepair?.();
      const repair = buildProtocolRepairPrompt(input.metrics, error.message);
      input.metrics.promptManifests.push(repair.manifest);
      const repaired = await runProviderTurn(input, 'protocol_repair', () =>
        withTimeout(120_000, input.signal, (signal) =>
          this.thread!.run(repair.text, { signal }),
        ),
      );
      return parseResponse(repaired.finalResponse, {
        onDiagnostics: (diagnostics) =>
          recordProtocolDiagnostics(input.metrics, diagnostics),
      });
    }
  }
}
