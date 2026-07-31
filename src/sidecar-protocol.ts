import { z } from 'zod';

export const SIDECAR_PROTOCOL_VERSION = 1 as const;

export const SidecarTelemetrySchema = z
  .object({
    startupMs: z.number().nonnegative(),
    attachCount: z.number().int().nonnegative(),
    lastAttachMs: z.number().nonnegative().nullable(),
    initialIndexMs: z.number().nonnegative().nullable(),
    incrementalInvalidationMs: z.number().nonnegative().nullable(),
    nativeCodexProcessLifetimeMs: z.number().nonnegative().nullable(),
    bridgeRequestCount: z.number().int().nonnegative(),
    bridgeInitializeCount: z.number().int().nonnegative(),
    contextBytesSupplied: z.number().int().nonnegative(),
    contextEstimatedTokensSupplied: z.number().int().nonnegative(),
    contextGrantCount: z.number().int().nonnegative(),
    activeContextGrantCount: z.number().int().nonnegative().optional(),
    errors: z.array(z.string()),
  })
  .strict();

export const SidecarStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(SIDECAR_PROTOCOL_VERSION),
    repositoryId: z.string().min(1),
    workspace: z.string().min(1),
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65_535),
    token: z.string().min(32),
    status: z.enum(['warming', 'ready', 'degraded', 'stopping']),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    indexedFiles: z.number().int().nonnegative(),
    activeLeases: z.number().int().nonnegative(),
    bridgeClients: z.number().int().nonnegative(),
    activeContextGrantCount: z.number().int().nonnegative().optional(),
    mode: z.enum(['passive-index-only', 'mcp-assisted-context']),
    lastInvalidatedPaths: z.array(z.string()),
    telemetry: SidecarTelemetrySchema,
  })
  .strict();

export type SidecarState = z.infer<typeof SidecarStateSchema>;

export const SidecarTelemetryArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocolVersion: z.literal(SIDECAR_PROTOCOL_VERSION),
    repositoryId: z.string().min(1),
    workspace: z.string().min(1),
    pid: z.number().int().positive(),
    status: z.enum(['warming', 'ready', 'degraded', 'stopping']),
    updatedAt: z.string().datetime(),
    indexedFiles: z.number().int().nonnegative(),
    mode: z.enum(['passive-index-only', 'mcp-assisted-context']),
    telemetry: SidecarTelemetrySchema,
  })
  .strict();

export const SidecarEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(SIDECAR_PROTOCOL_VERSION),
    repositoryId: z.string().min(1),
  })
  .strict();

export const SidecarAttachRequestSchema = SidecarEnvelopeSchema.extend({
  clientKind: z.enum(['launcher', 'mcp', 'diagnostic']).default('launcher'),
}).strict();

export const SidecarDetachRequestSchema = SidecarEnvelopeSchema.extend({
  leaseId: z.string().uuid(),
  nativeProcessLifetimeMs: z.number().nonnegative().optional(),
}).strict();

export const SidecarContextRequestSchema = SidecarEnvelopeSchema.extend({
  leaseId: z.string().uuid().optional(),
  query: z.string().max(1_000).optional(),
  pathHint: z.string().max(1_000).optional(),
  symbol: z.string().max(500).optional(),
  maxPages: z.number().int().min(1).max(8).default(4),
  maxBytes: z.number().int().min(1).max(100_000).default(40_000),
})
  .strict()
  .refine((value) => Boolean(value.query || value.pathHint || value.symbol), {
    message: 'query, pathHint, or symbol is required',
  });

export const SidecarContextPageSchema = z
  .object({
    path: z.string().min(1),
    fingerprint: z.string().min(1),
    content: z.string(),
    reason: z.string(),
  })
  .strict();

export const SidecarResponseSchema = z
  .object({
    protocolVersion: z.literal(SIDECAR_PROTOCOL_VERSION),
    repositoryId: z.string().min(1),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict()
  .refine((value) => (value.ok ? value.error === undefined : Boolean(value.error)), {
    message: 'successful responses cannot contain error; failed responses require error',
  });

export type SidecarResponse = z.infer<typeof SidecarResponseSchema>;
