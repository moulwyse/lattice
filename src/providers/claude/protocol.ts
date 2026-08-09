import { rawHash } from '../../core.js';
import type {
  ProtocolTurnDiagnostics,
  WorkerResponse,
} from '../../types.js';
import {
  ExternalResponseSchema,
  WorkerProtocolError,
  type ParseOptions,
} from '../codex/protocol.js';

const contextRequestSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['context_request'] },
    requests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          pathHint: { type: 'string' },
          symbol: { type: 'string' },
        },
        required: ['reason', 'pathHint', 'symbol'],
        additionalProperties: false,
      },
    },
  },
  required: ['kind', 'requests'],
  additionalProperties: false,
} as const;

const replaceFileSchema = {
  type: 'object',
  properties: {
    editHandle: { type: 'string' },
    operation: { type: 'string', enum: ['replace_file'] },
    replacementContent: { type: 'string' },
  },
  required: ['editHandle', 'operation', 'replacementContent'],
  additionalProperties: false,
} as const;

const replaceTextSchema = {
  type: 'object',
  properties: {
    editHandle: { type: 'string' },
    operation: { type: 'string', enum: ['replace_text'] },
    replacements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          oldContent: { type: 'string' },
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

const patchSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['patch'] },
    patch: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        changes: {
          type: 'array',
          items: { oneOf: [replaceFileSchema, replaceTextSchema] },
        },
        verificationCommands: {
          type: 'array',
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
 * Anthropic structured-output tools require an object at the schema root and
 * reject top-level oneOf/anyOf/allOf. Unsupported string/array constraints are
 * also omitted from this wire schema. Keep the variant fields optional here;
 * the canonical protocol parser below enforces every semantic constraint and
 * triggers the existing repair turn for incomplete responses.
 */
export const CLAUDE_WORKER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['context_request', 'patch'] },
    requests: contextRequestSchema.properties.requests,
    patch: patchSchema.properties.patch,
  },
  required: ['kind'],
  additionalProperties: false,
} as const;

function describe(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
    .join('; ');
}

function versionResponse(
  parsed: ReturnType<typeof ExternalResponseSchema.parse>,
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

/**
 * Claude receives the canonical protocol directly. Unlike the Codex adapter,
 * this parser deliberately rejects historical provider envelopes and legacy
 * context-fault shapes.
 */
export function parseClaudeResponse(
  raw: string,
  options: ParseOptions = {},
): WorkerResponse {
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
    const message = 'Claude worker returned malformed JSON';
    finish(message);
    throw new WorkerProtocolError(message, raw.slice(0, 4096), true);
  }

  const kind =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).kind
      : null;
  diagnostics.detectedEnvelopeShape =
    kind === 'patch'
      ? 'canonical_patch'
      : kind === 'context_request'
        ? 'canonical_context_request'
        : 'non_canonical';

  const parsed = ExternalResponseSchema.safeParse(value);
  if (!parsed.success) {
    const message = `Claude worker protocol error: ${describe(parsed.error)}`;
    diagnostics.normalizationResult = 'rejected';
    finish(message);
    throw new WorkerProtocolError(message, raw.slice(0, 4096), true);
  }

  const response = versionResponse(parsed.data);
  try {
    assertDistinctHandles(response);
  } catch (error) {
    const message = `Claude worker protocol error: ${
      error instanceof Error ? error.message : String(error)
    }`;
    diagnostics.normalizationResult = 'rejected';
    finish(message);
    throw new WorkerProtocolError(message, raw.slice(0, 4096), false);
  }

  diagnostics.normalizationResult =
    response.kind === 'patch' ? 'canonical_patch' : 'canonical_context_request';
  finish(null);
  return response;
}
