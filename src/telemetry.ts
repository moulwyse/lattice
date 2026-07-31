import type {
  ProtocolTurnDiagnostics,
  Telemetry,
  TurnKind,
  Usage,
} from './types.js';

export type ProviderUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export const emptyUsage = (): Usage => ({
  modelInputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null,
});

export function telemetry(): Telemetry {
  return {
    schemaVersion: 2,
    ...emptyUsage(),
    initialContextCharacters: 0,
    initialContextEstimatedTokens: 0,
    loadedPageCount: 0,
    loadedContextCharacters: 0,
    pageFaults: 0,
    workerTurns: 0,
    protocolRepairTurns: 0,
    stageMs: {},
    verificationDurationMs: null,
    changedFileCount: 0,
    nonCachedInputTokens: null,
    turnUsage: [],
    promptManifests: [],
    editGrantCount: 0,
    resolvedEditGrantCount: 0,
    rejectedEditGrantReason: null,
    editGrantMappingSha256: null,
    patchLoweringDurationMs: null,
    providerProtocolVersion: 4,
    internalPatchVersion: 1,
    runtimeStateTransitions: [],
    terminalStateReason: null,
    verifiedPatchCacheHit: false,
    verifiedPatchCacheKey: null,
  };
}

export const timed = async <T>(
  metrics: Telemetry,
  stage: string,
  operation: () => Promise<T>,
) => {
  const started = Date.now();
  try {
    return await operation();
  } finally {
    metrics.stageMs[stage] = (metrics.stageMs[stage] ?? 0) + Date.now() - started;
  }
};

export function recordTurnUsage(
  metrics: Telemetry,
  kind: TurnKind,
  usage: ProviderUsage | null,
  elapsedMs: number,
) {
  const nonCachedInputTokens = usage
    ? Math.max(0, usage.input_tokens - usage.cached_input_tokens)
    : null;
  metrics.turnUsage.push({
    turnNumber: metrics.turnUsage.length + 1,
    kind,
    inputTokens: usage?.input_tokens ?? null,
    cachedInputTokens: usage?.cached_input_tokens ?? null,
    nonCachedInputTokens,
    outputTokens: usage?.output_tokens ?? null,
    reasoningTokens: usage?.reasoning_output_tokens ?? null,
    elapsedMs,
    rawResponseSha256: null,
    detectedEnvelopeShape: null,
    normalizationResult: null,
    validationError: null,
  });
  metrics.workerTurns = metrics.turnUsage.length;
  if (!usage) return;
  const add = (current: number | null, value: number) => (current ?? 0) + value;
  metrics.modelInputTokens = add(metrics.modelInputTokens, usage.input_tokens);
  metrics.cachedInputTokens = add(metrics.cachedInputTokens, usage.cached_input_tokens);
  metrics.outputTokens = add(metrics.outputTokens, usage.output_tokens);
  metrics.reasoningTokens = add(metrics.reasoningTokens, usage.reasoning_output_tokens);
  metrics.totalTokens = null;
  metrics.nonCachedInputTokens = Math.max(
    0,
    metrics.modelInputTokens - metrics.cachedInputTokens,
  );
}

export function recordProtocolDiagnostics(
  metrics: Telemetry,
  diagnostics: ProtocolTurnDiagnostics,
) {
  const turn = metrics.turnUsage.at(-1);
  if (!turn) throw new Error('cannot record protocol diagnostics before worker usage');
  Object.assign(turn, diagnostics);
}
