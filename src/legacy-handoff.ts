import { z } from 'zod';
import { parseResponse, WorkerProtocolError } from './protocol.js';
import type {
  ContextPage,
  EditGrantRegistryIR,
  WorkerResponse,
} from './types.js';

const LegacyChangeSchema = z
  .object({
    path: z.string().min(1),
    operation: z.literal('modify'),
    expectedFingerprint: z.string().min(1),
    replacementContent: z.string(),
  })
  .strict();

const LegacyPatchSchema = z
  .object({
    kind: z.literal('patch'),
    patch: z
      .object({
        summary: z.string().min(1),
        changes: z.array(LegacyChangeSchema).min(1),
        verificationCommands: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();

/**
 * This decoder is selected only by persisted handoff protocolVersion 2. It
 * converts old path/fingerprint responses into handle intent and never returns
 * either provider-controlled field.
 */
export function decodeLegacyHandoffResponse(
  raw: string,
  persistedPages: ContextPage[],
  registry?: EditGrantRegistryIR,
): WorkerResponse {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new WorkerProtocolError('legacy handoff returned malformed JSON', raw.slice(0, 4096));
  }
  if (
    value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'context_request'
  ) {
    return parseResponse(raw);
  }
  const parsed = LegacyPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkerProtocolError(
      `legacy handoff protocol error: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
        .join('; ')}`,
      raw.slice(0, 4096),
    );
  }
  const seen = new Set<string>();
  const changes = parsed.data.patch.changes.map((change) => {
    if (change.expectedFingerprint === 'capture-locally') {
      throw new WorkerProtocolError(
        'legacy handoff capture-locally is not supported',
        raw.slice(0, 4096),
      );
    }
    const pageIndex = persistedPages.findIndex((page) => page.path === change.path);
    const page = persistedPages[pageIndex];
    if (!page) {
      throw new WorkerProtocolError(
        `legacy handoff path was not granted: ${change.path}`,
        raw.slice(0, 4096),
      );
    }
    if (page.fingerprint.value !== change.expectedFingerprint) {
      throw new WorkerProtocolError(
        `legacy handoff fingerprint mismatch: ${change.path}`,
        raw.slice(0, 4096),
      );
    }
    const editHandle =
      registry?.grants.find(
        (grant) =>
          !grant.invalidated &&
          grant.epoch === registry.epoch &&
          grant.contextPageId === page.id &&
          grant.path === page.path &&
          grant.fingerprint === page.fingerprint.value,
      )?.handle ?? `E${pageIndex + 1}`;
    if (seen.has(editHandle)) {
      throw new WorkerProtocolError(
        `legacy handoff duplicate path: ${change.path}`,
        raw.slice(0, 4096),
      );
    }
    seen.add(editHandle);
    return {
      editHandle,
      operation: 'replace_file' as const,
      replacementContent: change.replacementContent,
    };
  });
  return {
    schemaVersion: 1,
    kind: 'patch',
    patch: {
      schemaVersion: 1,
      summary: parsed.data.patch.summary,
      changes,
      verificationCommands: parsed.data.patch.verificationCommands,
    },
  };
}
