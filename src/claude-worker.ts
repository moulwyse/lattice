import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  CLAUDE_OPUS_5_MODEL,
  type ResolvedClaudeModelSettings,
} from './claude-model-settings.js';
import {
  buildContextFaultPrompt,
  buildInitialWorkerPrompt,
  buildProtocolRepairPrompt,
} from './providers/claude/prompt.js';
import { parseClaudeResponse } from './providers/claude/protocol.js';
import { CLAUDE_WORKER_OUTPUT_SCHEMA } from './providers/claude/protocol.js';
import { WorkerProtocolError } from './protocol.js';
import {
  recordProtocolDiagnostics,
  recordTurnUsage,
  type ProviderUsage,
} from './telemetry.js';
import type { TurnKind, WorkerResponse } from './types.js';
import {
  selectNewContextPages,
  withTimeout,
  type Worker,
  type WorkerInput,
} from './worker.js';

export type ClaudeQueryFunction = (parameters: {
  prompt: string;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export function claudeQueryOptions(
  workspace: string,
  modelSettings: ResolvedClaudeModelSettings,
  abortController: AbortController,
  resume?: string,
): Options {
  const opus5 = modelSettings.model === CLAUDE_OPUS_5_MODEL;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_AGENT_SDK_CLIENT_APP:
      'lattice-claude-code-beta/0.2.0-claude-beta.1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  if (opus5) delete env.CLAUDE_CODE_DISABLE_THINKING;
  return {
    cwd: workspace,
    abortController,
    ...(modelSettings.model ? { model: modelSettings.model } : {}),
    // Opus 5 enables adaptive thinking by default. Keep it explicit here so a
    // caller's inherited Claude Code environment cannot accidentally disable
    // thinking, which is invalid at xhigh/max and changes benchmark quality.
    ...(opus5 ? { thinking: { type: 'adaptive' as const } } : {}),
    ...(modelSettings.reasoningEffort
      ? { effort: modelSettings.reasoningEffort }
      : {}),
    ...(modelSettings.maxBudgetUsd
      ? { maxBudgetUsd: modelSettings.maxBudgetUsd }
      : {}),
    ...(resume ? { resume } : {}),
    maxTurns: 1,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    outputFormat: {
      type: 'json_schema',
      schema: CLAUDE_WORKER_OUTPUT_SCHEMA,
    },
    systemPrompt:
      'You are a constrained Lattice provider. Follow the user-supplied canonical protocol and return only its JSON action.',
    env,
  };
}

export function claudeProviderUsage(result: SDKResultMessage): ProviderUsage {
  const usage = result.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  return {
    input_tokens: usage.input_tokens + cacheRead + cacheCreation,
    cached_input_tokens: cacheRead,
    output_tokens: usage.output_tokens,
    // Anthropic includes thinking in output_tokens and does not expose a
    // separate authoritative reasoning count in the Agent SDK result.
    reasoning_output_tokens: 0,
    ...(typeof result.total_cost_usd === 'number'
      ? { cost_usd: result.total_cost_usd }
      : {}),
  };
}

export class ClaudeProviderResultError extends Error {
  constructor(
    message: string,
    readonly usage: ProviderUsage,
  ) {
    super(message);
    this.name = 'ClaudeProviderResultError';
  }
}

async function runClaudeQuery(
  queryFunction: ClaudeQueryFunction,
  prompt: string,
  input: WorkerInput,
  modelSettings: ResolvedClaudeModelSettings,
  resume?: string,
) {
  const abortController = new AbortController();
  const abort = () => abortController.abort(input.signal.reason);
  input.signal.addEventListener('abort', abort, { once: true });
  if (input.signal.aborted) abort();
  let result: SDKResultMessage | undefined;
  try {
    for await (const message of queryFunction({
      prompt,
      options: claudeQueryOptions(
        input.workspace,
        modelSettings,
        abortController,
        resume,
      ),
    })) {
      if (message.type === 'result') result = message;
    }
  } finally {
    input.signal.removeEventListener('abort', abort);
  }
  if (!result) throw new Error('Claude Agent SDK returned no result message');
  const usage = claudeProviderUsage(result);
  if (result.subtype !== 'success') {
    throw new ClaudeProviderResultError(
      `Claude worker failed (${result.subtype}): ${result.errors.join('; ')}`,
      usage,
    );
  }
  return {
    finalResponse:
      result.structured_output === undefined
        ? result.result
        : JSON.stringify(result.structured_output),
    usage,
    sessionId: result.session_id,
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
    recordTurnUsage(
      input.metrics,
      kind,
      error instanceof ClaudeProviderResultError ? error.usage : null,
      Date.now() - started,
    );
    throw error;
  }
}

export class ClaudeWorker implements Worker {
  private repaired = false;
  private readonly sentPageIds = new Set<string>();
  threadId?: string;

  constructor(
    private readonly modelSettings: ResolvedClaudeModelSettings,
    private readonly queryFunction: ClaudeQueryFunction = query,
  ) {}

  async run(input: WorkerInput) {
    this.sentPageIds.clear();
    this.repaired = false;
    this.threadId = undefined;
    return this.turn(input, 'initial');
  }

  private settingsForTurn(input: WorkerInput) {
    if (this.modelSettings.maxBudgetUsd === undefined) return this.modelSettings;
    const remaining = this.modelSettings.maxBudgetUsd - (input.metrics.costUsd ?? 0);
    if (remaining <= 0) {
      throw new Error('Claude run exhausted its configured maxBudgetUsd');
    }
    return { ...this.modelSettings, maxBudgetUsd: remaining };
  }

  async continue(input: WorkerInput) {
    if (!this.threadId) throw new Error('Claude worker has no active session');
    return this.turn(input, 'context_fault');
  }

  private async turn(
    input: WorkerInput,
    kind: Extract<TurnKind, 'initial' | 'context_fault'>,
  ): Promise<WorkerResponse> {
    const grantedContextPages = selectNewContextPages(
      input.pages,
      this.sentPageIds,
    );
    const built =
      kind === 'initial'
        ? buildInitialWorkerPrompt(input, grantedContextPages)
        : buildContextFaultPrompt(
            input.metrics,
            grantedContextPages,
            input.editGrants,
          );
    input.metrics.promptManifests.push(built.manifest);

    const result = await runProviderTurn(input, kind, () =>
      withTimeout(120_000, input.signal, () =>
        runClaudeQuery(
          this.queryFunction,
          built.text,
          input,
          this.settingsForTurn(input),
          this.threadId,
        ),
      ),
    );
    this.threadId = result.sessionId;
    try {
      return parseClaudeResponse(result.finalResponse, {
        onDiagnostics: (diagnostics) =>
          recordProtocolDiagnostics(input.metrics, diagnostics),
      });
    } catch (error) {
      if (
        this.repaired ||
        !(error instanceof WorkerProtocolError) ||
        !error.repairable
      ) {
        throw error;
      }
      this.repaired = true;
      input.metrics.protocolRepairTurns += 1;
      input.onProtocolRepair?.();
      const repair = buildProtocolRepairPrompt(input.metrics, error.message);
      input.metrics.promptManifests.push(repair.manifest);
      const repaired = await runProviderTurn(input, 'protocol_repair', () =>
        withTimeout(120_000, input.signal, () =>
          runClaudeQuery(
            this.queryFunction,
            repair.text,
            input,
            this.settingsForTurn(input),
            this.threadId,
          ),
        ),
      );
      this.threadId = repaired.sessionId;
      return parseClaudeResponse(repaired.finalResponse, {
        onDiagnostics: (diagnostics) =>
          recordProtocolDiagnostics(input.metrics, diagnostics),
      });
    }
  }
}

