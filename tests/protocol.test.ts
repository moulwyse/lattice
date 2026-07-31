import { describe, expect, it } from 'vitest';
import {
  CODEX_WORKER_OUTPUT_SCHEMA,
  ExternalResponseSchema,
  parseResponse,
  WorkerProtocolError,
} from '../src/protocol.js';
import {
  recordProtocolDiagnostics,
  recordTurnUsage,
  telemetry,
} from '../src/telemetry.js';

const canonicalPatch = {
  kind: 'patch' as const,
  patch: {
    summary: 'Change value',
    changes: [
      {
        editHandle: 'E1',
        operation: 'replace_file' as const,
        replacementContent: 'export const value = 2;\n',
      },
    ],
    verificationCommands: ['npm test'],
  },
};

describe('canonical handle-only worker protocol', () => {
  it('parses a canonical non-empty context request', () => {
    expect(
      parseResponse(
        JSON.stringify({
          kind: 'context_request',
          requests: [{ reason: 'Need service', pathHint: 'src/service.ts' }],
        }),
      ),
    ).toMatchObject({ schemaVersion: 1, kind: 'context_request' });
  });

  it('retains legacy context_fault normalization at the provider adapter only', () => {
    expect(
      parseResponse(
        JSON.stringify({
          type: 'context_fault',
          queries: [{ reason: 'Need service', pathHint: 'src/service.ts' }],
        }),
      ),
    ).toMatchObject({ schemaVersion: 1, kind: 'context_request' });
  });

  it('parses a canonical provider patch containing handles and no fingerprints', () => {
    expect(ExternalResponseSchema.parse(canonicalPatch)).toEqual(canonicalPatch);
    const parsed = parseResponse(JSON.stringify(canonicalPatch));
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: 'patch',
      patch: {
        schemaVersion: 1,
        changes: [{ editHandle: 'E1', operation: 'replace_file' }],
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('expectedFingerprint');
    expect(JSON.stringify(parsed)).not.toContain('git:');
  });

  it('parses compact exact-text replacements and exposes a strict native schema', () => {
    const parsed = parseResponse(
      JSON.stringify({
        kind: 'patch',
        patch: {
          summary: 'Change one expression',
          changes: [
            {
              editHandle: 'E1',
              operation: 'replace_text',
              replacements: [
                { oldContent: 'value = 1', newContent: 'value = 2' },
              ],
            },
          ],
          verificationCommands: ['npm test'],
        },
      }),
    );
    expect(parsed).toMatchObject({
      kind: 'patch',
      patch: { changes: [{ operation: 'replace_text' }] },
    });
    expect(CODEX_WORKER_OUTPUT_SCHEMA).toMatchObject({
      type: 'object',
      required: ['contextRequest', 'patch'],
      additionalProperties: false,
    });
  });

  it('rejects a standalone empty context request and records diagnostics', () => {
    const metrics = telemetry();
    recordTurnUsage(metrics, 'initial', null, 1);
    expect(() =>
      parseResponse(JSON.stringify({ kind: 'context_request', requests: [] }), {
        onDiagnostics: (diagnostics) =>
          recordProtocolDiagnostics(metrics, diagnostics),
      }),
    ).toThrow(/requests/);
    expect(metrics.turnUsage[0]).toEqual(
      expect.objectContaining({
        rawResponseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        detectedEnvelopeShape: 'canonical_context_request',
        normalizationResult: 'rejected',
        validationError: expect.stringContaining('requests'),
      }),
    );
  });

  it('normalizes the observed empty-context combined envelope to its valid patch', () => {
    expect(
      parseResponse(
        JSON.stringify({
          contextRequest: { kind: 'context_request', requests: [] },
          patch: canonicalPatch,
        }),
      ),
    ).toMatchObject({ kind: 'patch', patch: { changes: [{ editHandle: 'E1' }] } });
  });

  it('normalizes a valid patch with an absent or null context branch', () => {
    expect(parseResponse(JSON.stringify({ patch: canonicalPatch })).kind).toBe('patch');
    expect(
      parseResponse(JSON.stringify({ contextRequest: null, patch: canonicalPatch })).kind,
    ).toBe('patch');
  });

  it('normalizes a non-empty context branch with an absent patch', () => {
    const contextRequest = {
      kind: 'context_request',
      requests: [{ reason: 'Need service', pathHint: 'src/service.ts' }],
    };
    expect(parseResponse(JSON.stringify({ contextRequest })).kind).toBe(
      'context_request',
    );
  });

  it('normalizes nullable native-schema context hints before validation', () => {
    expect(
      parseResponse(
        JSON.stringify({
          contextRequest: {
            kind: 'context_request',
            requests: [
              { reason: 'Need TargetService', pathHint: null, symbol: 'TargetService' },
            ],
          },
          patch: null,
        }),
      ),
    ).toMatchObject({
      kind: 'context_request',
      requests: [{ reason: 'Need TargetService', symbol: 'TargetService' }],
    });
  });

  it('rejects a combined non-empty request and patch as ambiguous', () => {
    expect(() =>
      parseResponse(
        JSON.stringify({
          contextRequest: {
            kind: 'context_request',
            requests: [{ reason: 'Need service', pathHint: 'src/service.ts' }],
          },
          patch: canonicalPatch,
        }),
      ),
    ).toThrow(/ambiguous/);
  });

  it('never rescues a malformed patch branch', () => {
    expect(() =>
      parseResponse(
        JSON.stringify({
          contextRequest: { kind: 'context_request', requests: [] },
          patch: {
            kind: 'patch',
            patch: {
              summary: 'Malformed',
              changes: [],
              verificationCommands: ['npm test'],
            },
          },
        }),
      ),
    ).toThrow(/malformed patch branch/);
  });

  it('rejects unknown additional action branches', () => {
    expect(() =>
      parseResponse(
        JSON.stringify({
          contextRequest: null,
          patch: canonicalPatch,
          rollback: { kind: 'rollback' },
        }),
      ),
    ).toThrow(/unknown action branches: rollback/);
  });

  it('does not increment protocol repairs for safe deterministic normalization', () => {
    const metrics = telemetry();
    recordTurnUsage(metrics, 'initial', null, 5);
    parseResponse(
      JSON.stringify({
        contextRequest: { kind: 'context_request', requests: [] },
        patch: canonicalPatch,
      }),
      {
        onDiagnostics: (diagnostics) =>
          recordProtocolDiagnostics(metrics, diagnostics),
      },
    );
    expect(metrics.protocolRepairTurns).toBe(0);
    expect(metrics.turnUsage[0]).toEqual(
      expect.objectContaining({
        detectedEnvelopeShape: 'provider_action_envelope',
        normalizationResult: 'provider_envelope_to_patch',
        validationError: null,
      }),
    );
  });

  it('rejects duplicate conflicting handles', () => {
    const change = canonicalPatch.patch.changes[0];
    expect(() =>
      parseResponse(
        JSON.stringify({
          ...canonicalPatch,
          patch: { ...canonicalPatch.patch, changes: [change, change] },
        }),
      ),
    ).toThrow(/duplicate/);
  });

  it.each([
    ['path', 'src/value.ts'],
    ['expectedFingerprint', 'git:abc'],
    ['fingerprint', 'git:abc'],
    ['repositoryId', 'repo:abc'],
    ['baseCommit', 'abc'],
    ['transactionId', 'tx'],
  ])('rejects provider transaction-integrity field %s', (field, value) => {
    const change = { ...canonicalPatch.patch.changes[0], [field]: value };
    expect(() =>
      parseResponse(
        JSON.stringify({
          ...canonicalPatch,
          patch: { ...canonicalPatch.patch, changes: [change] },
        }),
      ),
    ).toThrow(new RegExp(`patch\\.changes\\.0.*${field}`));
  });

  it('rejects unsupported create and delete operations', () => {
    for (const operation of ['create_file', 'delete_file']) {
      expect(() =>
        parseResponse(
          JSON.stringify({
            ...canonicalPatch,
            patch: {
              ...canonicalPatch.patch,
              changes: [{ ...canonicalPatch.patch.changes[0], operation }],
            },
          }),
        ),
      ).toThrow(/replace_file/);
    }
  });

  it('does not accept old Shape A or Shape B as new live responses', () => {
    expect(() =>
      parseResponse(
        JSON.stringify({
          kind: 'patch',
          patch: { changes: [{ path: 'src/value.js', diff: '@@' }] },
        }),
      ),
    ).toThrow(WorkerProtocolError);
    expect(() =>
      parseResponse(
        JSON.stringify({ kind: 'patch', patch: { 'src/value.js': 'new\n' } }),
      ),
    ).toThrow(WorkerProtocolError);
  });

  it('returns bounded raw output and readable detail for invalid output', () => {
    try {
      parseResponse(JSON.stringify({ kind: 'patch', patch: { summary: 1 } }));
      throw new Error('expected parser failure');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerProtocolError);
      expect((error as Error).message).toContain('worker protocol error');
      expect((error as WorkerProtocolError).rawOutput.length).toBeLessThanOrEqual(4096);
    }
  });
});
