import { z } from 'zod';
import { rawHash } from '../../core.js';
import type { ProtocolTurnDiagnostics, WorkerResponse } from '../../types.js';

const ContextRequestWireSchema = z
  .object({
    kind: z.literal('context_request'),
    requests: z
      .array(
        z
          .object({
            reason: z.string().min(1),
            pathHint: z.string().optional(),
            symbol: z.string().optional(),
          })
          .strict()
          .refine((request) => request.pathHint || request.symbol, {
            message: 'pathHint or symbol is required',
          }),
      )
      .min(1),
  })
  .strict();

const ProviderReplaceFileChangeWireSchema = z
  .object({
    editHandle: z.string().regex(/^E[1-9]\d*$/, 'must be a task-scoped edit handle'),
    operation: z.literal('replace_file'),
    replacementContent: z.string(),
  })
  .strict();

const ProviderReplaceTextChangeWireSchema = z
  .object({
    editHandle: z.string().regex(/^E[1-9]\d*$/, 'must be a task-scoped edit handle'),
    operation: z.literal('replace_text'),
    replacements: z
      .array(
        z
          .object({
            oldContent: z.string().min(1),
            newContent: z.string(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const ProviderChangeWireSchema = z.discriminatedUnion('operation', [
  ProviderReplaceFileChangeWireSchema,
  ProviderReplaceTextChangeWireSchema,
]);

const PatchWireSchema = z
  .object({
    kind: z.literal('patch'),
    patch: z
      .object({
        summary: z.string().min(1),
        changes: z.array(ProviderChangeWireSchema).min(1),
        verificationCommands: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

export const ExternalResponseSchema = z.discriminatedUnion('kind', [
  ContextRequestWireSchema,
  PatchWireSchema,
]);

const contextRequestOutputSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['context_request'] },
    requests: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          pathHint: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          symbol: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['reason', 'pathHint', 'symbol'],
        additionalProperties: false,
      },
    },
  },
  required: ['kind', 'requests'],
  additionalProperties: false,
} as const;

const replaceFileOutputSchema = {
  type: 'object',
  properties: {
    editHandle: { type: 'string', pattern: '^E[1-9]\\d*$' },
    operation: { type: 'string', enum: ['replace_file'] },
    replacementContent: { type: 'string' },
  },
  required: ['editHandle', 'operation', 'replacementContent'],
  additionalProperties: false,
} as const;

const replaceTextOutputSchema = {
  type: 'object',
  properties: {
    editHandle: { type: 'string', pattern: '^E[1-9]\\d*$' },
    operation: { type: 'string', enum: ['replace_text'] },
    replacements: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          oldContent: { type: 'string', minLength: 1 },
          newContent: { type: 'string' },
        },
        required: ['oldContent', 'newContent'],
        additionalProperties: false,
      },
    },
  },
  required: ['editHandle', 'operation', 'replacements'],
  additionalProperties: false,
} as const;

const patchOutputSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['patch'] },
    patch: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        changes: {
          type: 'array',
          minItems: 1,
          items: { anyOf: [replaceFileOutputSchema, replaceTextOutputSchema] },
        },
        verificationCommands: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
        },
      },
      required: ['summary', 'changes', 'verificationCommands'],
      additionalProperties: false,
    },
  },
  required: ['kind', 'patch'],
  additionalProperties: false,
} as const;

/**
 * The SDK requires one root object. Nullable branches keep the response
 * structurally constrained while the local validator enforces exactly one action.
 */
export const CODEX_WORKER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    contextRequest: { anyOf: [contextRequestOutputSchema, { type: 'null' }] },
    patch: { anyOf: [patchOutputSchema, { type: 'null' }] },
  },
  required: ['contextRequest', 'patch'],
  additionalProperties: false,
} as const;

export type ParseOptions = {
  onDiagnostics?: (diagnostics: ProtocolTurnDiagnostics) => void;
};

export class WorkerProtocolError extends Error {
  constructor(
    message: string,
    readonly rawOutput: string,
    readonly repairable = false,
  ) {
    super(message);
    this.name = 'WorkerProtocolError';
  }
}

function describe(error: z.ZodError) {
  return error.issues
    .map((issue) => {
      const expected = 'expected' in issue ? ` expected=${String(issue.expected)}` : '';
      const received = 'received' in issue ? ` received=${String(issue.received)}` : '';
      return `${issue.path.join('.') || '$'}:${expected}${received} ${issue.message}`.trim();
    })
    .join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function detectEnvelopeShape(value: unknown) {
  if (!isRecord(value)) return 'non_object';
  if (
    !Object.prototype.hasOwnProperty.call(value, 'kind') &&
    (Object.prototype.hasOwnProperty.call(value, 'contextRequest') ||
      Object.prototype.hasOwnProperty.call(value, 'patch'))
  ) {
    return 'provider_action_envelope';
  }
  if (value.type === 'context_fault') return 'legacy_context_fault';
  if (value.kind === 'context_request') return 'canonical_context_request';
  if (value.kind === 'patch') return 'canonical_patch';
  return 'unknown_object';
}

function normalizeProviderEnvelope(value: unknown) {
  if (!isRecord(value)) return { value, result: null as string | null };
  const hasContext = Object.prototype.hasOwnProperty.call(value, 'contextRequest');
  const hasPatch = Object.prototype.hasOwnProperty.call(value, 'patch');
  if ((!hasContext && !hasPatch) || Object.prototype.hasOwnProperty.call(value, 'kind')) {
    return { value, result: null as string | null };
  }
  const unknown = Object.keys(value).filter(
    (key) => key !== 'contextRequest' && key !== 'patch',
  );
  if (unknown.length > 0) {
    throw new Error(`unknown action branches: ${unknown.join(', ')}`);
  }

  const rawContext = value.contextRequest;
  const context =
    isRecord(rawContext) && Array.isArray(rawContext.requests)
      ? {
          ...rawContext,
          requests: rawContext.requests.map((request) => {
            if (!isRecord(request)) return request;
            return Object.fromEntries(
              Object.entries(request).filter(([, item]) => item !== null),
            );
          }),
        }
      : rawContext;
  const patch = value.patch;
  const contextAbsent = context === undefined || context === null;
  const patchAbsent = patch === undefined || patch === null;
  const emptyContext =
    isRecord(context) &&
    context.kind === 'context_request' &&
    Array.isArray(context.requests) &&
    context.requests.length === 0 &&
    Object.keys(context).every((key) => key === 'kind' || key === 'requests');
  const parsedContext = contextAbsent
    ? undefined
    : ContextRequestWireSchema.safeParse(context);
  const parsedPatch = patchAbsent ? undefined : PatchWireSchema.safeParse(patch);

  if (!patchAbsent && !parsedPatch?.success) {
    throw new Error(`malformed patch branch: ${describe(parsedPatch!.error)}`);
  }
  if (!contextAbsent && !emptyContext && !parsedContext?.success) {
    throw new Error(`malformed contextRequest branch: ${describe(parsedContext!.error)}`);
  }
  if (parsedContext?.success && parsedPatch?.success) {
    throw new Error('ambiguous response: non-empty context request and patch are both present');
  }
  if (emptyContext) {
    if (parsedPatch?.success) {
      return { value: parsedPatch.data, result: 'provider_envelope_to_patch' };
    }
    throw new Error('empty context request requires a valid patch branch');
  }
  if (parsedContext?.success && patchAbsent) {
    return {
      value: parsedContext.data,
      result: 'provider_envelope_to_context_request',
    };
  }
  if (parsedPatch?.success && contextAbsent) {
    return { value: parsedPatch.data, result: 'provider_envelope_to_patch' };
  }
  throw new Error('provider action envelope contains no valid action');
}

function normalizeLegacyContextRequest(value: unknown) {
  if (!isRecord(value) || value.type !== 'context_fault') return value;
  return {
    kind: 'context_request',
    requests: value.queries,
  };
}

function versionResponse(
  parsed: z.infer<typeof ExternalResponseSchema>,
): WorkerResponse {
  if (parsed.kind === 'context_request') {
    return {
      schemaVersion: 1,
      kind: 'context_request',
      requests: parsed.requests,
    };
  }
  return {
    schemaVersion: 1,
    kind: 'patch',
    patch: {
      schemaVersion: 1,
      summary: parsed.patch.summary,
      changes: parsed.patch.changes,
      verificationCommands: parsed.patch.verificationCommands,
    },
  };
}

function assertDistinctHandles(response: WorkerResponse) {
  if (response.kind !== 'patch') return;
  const handles = response.patch.changes.map((change) => change.editHandle);
  if (new Set(handles).size !== handles.length) {
    throw new Error('duplicate conflicting edit handles');
  }
}

export function parseResponse(raw: string, options: ParseOptions = {}): WorkerResponse {
  const diagnostics: ProtocolTurnDiagnostics = {
    rawResponseSha256: rawHash(Buffer.from(raw, 'utf8')),
    detectedEnvelopeShape: null,
    normalizationResult: null,
    validationError: null,
  };
  const finish = (validationError: string | null) => {
    diagnostics.validationError = validationError;
    options.onDiagnostics?.({ ...diagnostics });
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    diagnostics.detectedEnvelopeShape = 'malformed_json';
    diagnostics.normalizationResult = 'rejected';
    const message = 'worker returned malformed JSON';
    finish(message);
    throw new WorkerProtocolError(message, raw.slice(0, 4096), true);
  }

  diagnostics.detectedEnvelopeShape = detectEnvelopeShape(value);
  try {
    const envelope = normalizeProviderEnvelope(value);
    value = envelope.value;
    if (envelope.result) diagnostics.normalizationResult = envelope.result;
    const normalizedContext = normalizeLegacyContextRequest(value);
    if (normalizedContext !== value) {
      diagnostics.normalizationResult = 'legacy_context_fault_to_context_request';
    }
    value = normalizedContext;
  } catch (error) {
    const message = `worker protocol error: ${
      error instanceof Error ? error.message : String(error)
    }`;
    diagnostics.normalizationResult = 'rejected';
    finish(message);
    throw new WorkerProtocolError(message, raw.slice(0, 4096), true);
  }

  const parsed = ExternalResponseSchema.safeParse(value);
  if (!parsed.success) {
    const message = `worker protocol error: ${describe(parsed.error)}`;
    diagnostics.normalizationResult ??= 'rejected';
    finish(message);
    throw new WorkerProtocolError(message, raw.slice(0, 4096), true);
  }
  const response = versionResponse(parsed.data);
  try {
    assertDistinctHandles(response);
  } catch (error) {
    const message = `worker protocol error: ${
      error instanceof Error ? error.message : String(error)
    }`;
    diagnostics.normalizationResult = 'rejected';
    finish(message);
    throw new WorkerProtocolError(message, raw.slice(0, 4096), false);
  }
  diagnostics.normalizationResult ??=
    response.kind === 'patch' ? 'canonical_patch' : 'canonical_context_request';
  finish(null);
  return response;
}
