export type Risk = 'low' | 'medium' | 'high';

export type TaskIR = {
  schemaVersion: 2;
  id: string;
  goal: string;
  constraints: string[];
  invariants: string[];
  acceptanceCriteria: { id: string; text: string }[];
  risk: Risk;
  scope: { include: string[]; exclude: string[] };
  budget: {
    maxTokens: number;
    maxPages: number;
    maxFaults: number;
    maxTurns: number;
  };
  allowedVerificationCommands: string[];
};

export type Fingerprint = {
  kind: 'git' | 'raw';
  value: string;
  rawSha256: string;
  byteLength: number;
};

export type FileRecord = {
  path: string;
  language: string;
  size: number;
  fingerprint: Fingerprint;
  imports: string[];
  exports: string[];
  symbols: string[];
  references: string[];
  isTest: boolean;
  isConfig: boolean;
};

export type RepositoryIndex = {
  version: 2;
  workspace: string;
  createdAt: string;
  git: { available: boolean; branch: string | null; status: string[] };
  files: FileRecord[];
  scripts: Record<string, string>;
};

export type ContextPage = {
  id: string;
  kind: 'file' | 'symbol' | 'test' | 'config' | 'dependency' | 'failure' | 'diff';
  path: string;
  symbol?: string;
  fingerprint: Fingerprint;
  startLine: number;
  endLine: number;
  content: string;
  reason: string;
  provenance: string;
  estimatedTokens: number;
  invalidated: boolean;
  /** False when content is an exact editable slice rather than the complete file. */
  complete?: boolean;
};

export type ContextSnapshot = {
  schemaVersion: 1;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  baseCommit: string;
  epoch: number;
  editGrantMappingSha256: string;
  pages: ContextPage[];
};

export type ContextRequest = {
  schemaVersion: 1;
  kind: 'context_request';
  requests: { reason: string; pathHint?: string; symbol?: string }[];
};

export type ProviderPatchChange =
  | {
      editHandle: string;
      operation: 'replace_file';
      replacementContent: string;
    }
  | {
      editHandle: string;
      operation: 'replace_text';
      replacements: { oldContent: string; newContent: string }[];
    };

export type ProviderPatchIR = {
  schemaVersion: 1;
  summary: string;
  changes: ProviderPatchChange[];
  verificationCommands: string[];
};

export type PatchResponse = {
  schemaVersion: 1;
  kind: 'patch';
  patch: ProviderPatchIR;
};

export type WorkerResponse = ContextRequest | PatchResponse;

export type ChangeOperation = {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  expectedFingerprint?: string;
  replacementContent?: string;
};

export type InternalPatchIR = {
  schemaVersion: 1;
  repositoryId: string;
  baseCommit: string;
  summary: string;
  changes: ChangeOperation[];
  verificationCommands: string[];
};

export type EditPermission =
  | 'replace_file'
  | 'replace_text'
  | 'delete_file'
  | 'create_child';

export type EditGrant = {
  schemaVersion: 1;
  handle: string;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  baseCommit: string;
  path: string;
  fingerprint: string;
  permissions: readonly EditPermission[];
  epoch: number;
  contextPageId: string;
  invalidated: boolean;
  startLine?: number;
  endLine?: number;
  complete?: boolean;
};

export type EditGrantRegistryIR = {
  schemaVersion: 1;
  taskId: string;
  sessionId: string;
  repositoryId: string;
  baseCommit: string;
  epoch: number;
  nextHandle: number;
  grants: EditGrant[];
  mappingSha256: string;
};

export type Usage = {
  modelInputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type TurnKind = 'initial' | 'context_fault' | 'protocol_repair';

export type ProtocolTurnDiagnostics = {
  rawResponseSha256: string | null;
  detectedEnvelopeShape: string | null;
  normalizationResult: string | null;
  validationError: string | null;
};

export type TurnUsage = {
  turnNumber: number;
  kind: TurnKind;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  nonCachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  elapsedMs: number;
} & ProtocolTurnDiagnostics;

export type PromptManifest = {
  turnNumber: number;
  kind: TurnKind;
  stablePrefixCharacters: number;
  taskCharacters: number;
  repositoryMapCharacters: number;
  contextCharacters: number;
  protocolCharacters: number;
  continuationCharacters: number;
  historyCharacters: number | null;
  stablePrefixSha256: string;
};

export type RuntimeState =
  | 'CREATED'
  | 'COMPILED'
  | 'INDEXED'
  | 'CONTEXT_GRANTED'
  | 'WORKER_RUNNING'
  | 'RESPONSE_NORMALIZED'
  | 'RESPONSE_VALIDATED'
  | 'CONTEXT_FAULT'
  | 'PATCH_LOWERED'
  | 'PROTOCOL_REPAIR'
  | 'TRANSACTION_RUNNING'
  | 'VERIFYING'
  | 'PASSED'
  | 'FAILED'
  | 'CANCELLED';

export type RuntimeTransition = {
  from: RuntimeState | null;
  to: RuntimeState;
  at: string;
  reason?: string;
};

export type Telemetry = Usage & {
  schemaVersion: 2;
  initialContextCharacters: number;
  initialContextEstimatedTokens: number;
  loadedPageCount: number;
  loadedContextCharacters: number;
  pageFaults: number;
  workerTurns: number;
  protocolRepairTurns: number;
  stageMs: Record<string, number>;
  verificationDurationMs: number | null;
  changedFileCount: number;
  nonCachedInputTokens: number | null;
  turnUsage: TurnUsage[];
  promptManifests: PromptManifest[];
  editGrantCount: number;
  resolvedEditGrantCount: number;
  rejectedEditGrantReason: string | null;
  editGrantMappingSha256: string | null;
  patchLoweringDurationMs: number | null;
  providerProtocolVersion: number;
  internalPatchVersion: number;
  runtimeStateTransitions: RuntimeTransition[];
  terminalStateReason: string | null;
  verifiedPatchCacheHit: boolean;
  verifiedPatchCacheKey: string | null;
};

export type Evidence = {
  schemaVersion: 1;
  criterionId: string;
  criterion: string;
  result: 'passed' | 'failed' | 'unresolved';
  verificationCommand?: string;
  testName?: string;
  changedFiles: string[];
};
