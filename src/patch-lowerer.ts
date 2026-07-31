import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { safeReadPath } from './core.js';
import { assertRegistryIdentity } from './edit-grants.js';
import type { GrantIdentity } from './edit-grants.js';
import type {
  EditGrant,
  EditGrantRegistryIR,
  InternalPatchIR,
  ProviderPatchIR,
  Telemetry,
} from './types.js';

export class PatchLoweringError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'PatchLoweringError';
  }
}

function reject(metrics: Telemetry, reason: string, message: string): never {
  metrics.rejectedEditGrantReason = reason;
  throw new PatchLoweringError(message, reason);
}

function assertGrantBinding(
  grant: EditGrant,
  identity: GrantIdentity,
  registry: EditGrantRegistryIR,
  metrics: Telemetry,
) {
  if (grant.taskId !== identity.taskId) {
    reject(metrics, 'task_mismatch', `edit handle belongs to another task: ${grant.handle}`);
  }
  if (grant.sessionId !== identity.sessionId) {
    reject(metrics, 'session_mismatch', `edit handle belongs to another session: ${grant.handle}`);
  }
  if (grant.repositoryId !== identity.repositoryId) {
    reject(
      metrics,
      'repository_mismatch',
      `edit handle belongs to another repository: ${grant.handle}`,
    );
  }
  if (grant.baseCommit !== identity.baseCommit) {
    reject(metrics, 'base_commit_mismatch', `edit handle base commit mismatch: ${grant.handle}`);
  }
  if (grant.epoch !== identity.epoch || grant.epoch !== registry.epoch) {
    reject(metrics, 'epoch_mismatch', `edit handle epoch is invalid: ${grant.handle}`);
  }
  if (grant.invalidated) {
    reject(metrics, 'invalidated_handle', `edit handle is invalidated: ${grant.handle}`);
  }
}

export function lowerProviderPatch(
  providerPatch: ProviderPatchIR,
  registry: EditGrantRegistryIR,
  identity: GrantIdentity,
  metrics: Telemetry,
  workspace?: string,
): InternalPatchIR {
  const started = Date.now();
  metrics.resolvedEditGrantCount = 0;
  metrics.rejectedEditGrantReason = null;
  try {
    try {
      assertRegistryIdentity(registry, identity);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = message.includes('task mismatch')
        ? 'task_mismatch'
        : message.includes('session mismatch')
          ? 'session_mismatch'
          : message.includes('repository mismatch')
            ? 'repository_mismatch'
            : message.includes('base commit')
              ? 'base_commit_mismatch'
              : message.includes('epoch')
                ? 'epoch_mismatch'
                : 'registry_integrity';
      reject(metrics, reason, message);
    }

    const seenHandles = new Set<string>();
    const seenPaths = new Set<string>();
    const changes = providerPatch.changes.map((change) => {
      const keys = Object.keys(change);
      const forbidden = keys.filter(
        (key) =>
          !['editHandle', 'operation', 'replacementContent', 'replacements'].includes(key),
      );
      if (forbidden.length > 0) {
        reject(
          metrics,
          'provider_transaction_field',
          `provider patch contains forbidden fields: ${forbidden.join(', ')}`,
        );
      }
      if (seenHandles.has(change.editHandle)) {
        reject(
          metrics,
          'duplicate_handle',
          `duplicate conflicting edit handle: ${change.editHandle}`,
        );
      }
      seenHandles.add(change.editHandle);
      const grant = registry.grants.find((candidate) => candidate.handle === change.editHandle);
      if (!grant) {
        reject(metrics, 'unknown_handle', `unknown edit handle: ${change.editHandle}`);
      }
      assertGrantBinding(grant, identity, registry, metrics);
      if (!['replace_file', 'replace_text'].includes(change.operation)) {
        reject(
          metrics,
          'unsupported_operation',
          `unsupported provider operation: ${String(change.operation)}`,
        );
      }
      if (!grant.permissions.includes(change.operation)) {
        reject(
          metrics,
          'permission_denied',
          `edit handle is read-only: ${change.editHandle}`,
        );
      }
      const normalizedPath = grant.path.replaceAll('\\', '/').toLowerCase();
      if (seenPaths.has(normalizedPath)) {
        reject(
          metrics,
          'duplicate_path',
          `multiple edit handles resolve to the same path: ${grant.path}`,
        );
      }
      seenPaths.add(normalizedPath);
      let replacementContent: string;
      if (change.operation === 'replace_file') {
        replacementContent = change.replacementContent;
      } else {
        if (!workspace) {
          reject(
            metrics,
            'workspace_required',
            'replace_text lowering requires the trusted workspace',
          );
        }
        const source = readFileSync(safeReadPath(workspace, grant.path), 'utf8');
        const lines = source.split(/(?<=\n)/);
        const grantedContent = lines
          .slice((grant.startLine ?? 1) - 1, grant.endLine ?? lines.length)
          .join('');
        replacementContent = source;
        for (const replacement of change.replacements) {
          if (!grantedContent.includes(replacement.oldContent)) {
            reject(
              metrics,
              'replacement_outside_grant',
              `replace_text source is outside granted context: ${change.editHandle}`,
            );
          }
          const first = source.indexOf(replacement.oldContent);
          if (first < 0 || first !== source.lastIndexOf(replacement.oldContent)) {
            reject(
              metrics,
              first < 0 ? 'replacement_source_missing' : 'replacement_source_ambiguous',
              `replace_text source must occur exactly once: ${change.editHandle}`,
            );
          }
          const current = replacementContent.indexOf(replacement.oldContent);
          if (
            current < 0 ||
            current !== replacementContent.lastIndexOf(replacement.oldContent)
          ) {
            reject(
              metrics,
              'replacement_conflict',
              `replace_text replacements conflict: ${change.editHandle}`,
            );
          }
          replacementContent =
            replacementContent.slice(0, current) +
            replacement.newContent +
            replacementContent.slice(current + replacement.oldContent.length);
        }
      }
      metrics.resolvedEditGrantCount += 1;
      return {
        path: grant.path,
        operation: 'modify' as const,
        expectedFingerprint: grant.fingerprint,
        replacementContent,
      };
    });

    return {
      schemaVersion: 1,
      repositoryId: registry.repositoryId,
      baseCommit: registry.baseCommit,
      summary: providerPatch.summary,
      changes,
      verificationCommands: [...providerPatch.verificationCommands],
    };
  } finally {
    metrics.patchLoweringDurationMs = Date.now() - started;
  }
}

/**
 * Future create support is capability-shaped but deliberately not reachable
 * from the current Provider Patch schema.
 */
export function validateCreateChildDestination(
  repositoryRoot: string,
  directoryGrant: EditGrant,
  destination: string,
  destinationExists: boolean,
  overwriteGranted = false,
) {
  if (!directoryGrant.permissions.includes('create_child')) {
    throw new PatchLoweringError('directory handle lacks create-child permission', 'permission_denied');
  }
  if (isAbsolute(destination) || destination.replaceAll('\\', '/').split('/').includes('..')) {
    throw new PatchLoweringError('unsafe create destination', 'unsafe_destination');
  }
  const parent = resolve(repositoryRoot, directoryGrant.path);
  const target = resolve(repositoryRoot, normalize(destination));
  const withinParent = relative(parent, dirname(target));
  if (withinParent.startsWith('..') || isAbsolute(withinParent)) {
    throw new PatchLoweringError(
      'create destination is outside the granted directory',
      'unsafe_destination',
    );
  }
  if (destinationExists && !overwriteGranted) {
    throw new PatchLoweringError('create destination already exists', 'destination_exists');
  }
  return target;
}
