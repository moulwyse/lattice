import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { safePath, safeReadPath } from './core.js';
import { assertRegistryIdentity } from './edit-grants.js';
import type { GrantIdentity } from './edit-grants.js';
import type {
  ChangeOperation,
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

/** The file's line-ending convention, when it uses exactly one. */
function uniformLineEnding(text: string): '\r\n' | '\n' | null {
  const lineFeeds = (text.match(/\n/g) ?? []).length;
  const carriageReturnLineFeeds = (text.match(/\r\n/g) ?? []).length;
  if (lineFeeds === 0) return null;
  if (carriageReturnLineFeeds === lineFeeds) return '\r\n';
  return carriageReturnLineFeeds === 0 ? '\n' : null;
}

const withLineEnding = (text: string, eol: '\r\n' | '\n') => text.replace(/\r?\n/g, eol);

/**
 * Models usually answer with LF even when the granted file uses CRLF (the
 * default Git for Windows checkout). Match the file's own convention instead
 * of rejecting an otherwise exact edit; an exact match always wins.
 */
function alignReplacement(
  replacement: { oldContent: string; newContent: string },
  source: string,
) {
  if (source.includes(replacement.oldContent)) return replacement;
  const eol = uniformLineEnding(source);
  if (!eol) return replacement;
  const oldContent = withLineEnding(replacement.oldContent, eol);
  return oldContent !== replacement.oldContent && source.includes(oldContent)
    ? { oldContent, newContent: withLineEnding(replacement.newContent, eol) }
    : replacement;
}

const reservedSegments = new Set(['.git', '.lattice']);

/**
 * A provider-created file must be a new, plain repository-relative path. It
 * may not escape the workspace, touch Git or Lattice metadata, or overwrite
 * anything that already exists (including through a symlinked parent).
 */
function validateCreatePath(workspace: string, requested: string, metrics: Telemetry) {
  const path = requested.replaceAll('\\', '/');
  const segments = path.split('/');
  if (
    isAbsolute(requested) ||
    /^[a-z]:/i.test(path) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..') ||
    segments.some((segment) => reservedSegments.has(segment.toLowerCase())) ||
    /[\0<>:"|?*]/.test(path)
  ) {
    reject(metrics, 'unsafe_destination', `unsafe create_file path: ${requested}`);
  }
  // Dot paths hold tool configuration that can execute code on its own
  // (.envrc, .vscode/tasks.json, .github/workflows, .husky, .npmrc), and a
  // verified patch is applied automatically, so they need an explicit grant.
  if (segments.some((segment) => segment.startsWith('.'))) {
    reject(metrics, 'protected_destination', `create_file cannot create hidden paths: ${requested}`);
  }
  let target: string;
  try {
    target = safePath(workspace, path);
  } catch {
    reject(metrics, 'unsafe_destination', `unsafe create_file path: ${requested}`);
  }
  if (lstatExists(target)) {
    reject(metrics, 'destination_exists', `create_file path already exists: ${path}`);
  }
  let parent = dirname(target);
  const root = resolve(workspace);
  while (parent.length > root.length && !lstatExists(parent)) parent = dirname(parent);
  const relativeParent = relative(realpathSync.native(root), realpathSync.native(parent));
  if (relativeParent.startsWith('..') || isAbsolute(relativeParent)) {
    reject(metrics, 'unsafe_destination', `create_file parent escapes workspace: ${requested}`);
  }
  return path;
}

function lstatExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
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
    const changes = providerPatch.changes.map((change): ChangeOperation => {
      const keys = Object.keys(change);
      const allowedKeys =
        change.operation === 'create_file'
          ? ['operation', 'path', 'content']
          : ['editHandle', 'operation', 'replacementContent', 'replacements'];
      const forbidden = keys.filter((key) => !allowedKeys.includes(key));
      if (forbidden.length > 0) {
        reject(
          metrics,
          'provider_transaction_field',
          `provider patch contains forbidden fields: ${forbidden.join(', ')}`,
        );
      }
      if (change.operation === 'create_file') {
        if (!workspace) {
          reject(metrics, 'workspace_required', 'create_file lowering requires the trusted workspace');
        }
        const path = validateCreatePath(workspace, change.path, metrics);
        const normalizedPath = path.toLowerCase();
        if (seenPaths.has(normalizedPath)) {
          reject(metrics, 'duplicate_path', `multiple changes target the same path: ${path}`);
        }
        seenPaths.add(normalizedPath);
        metrics.resolvedEditGrantCount += 1;
        return { path, operation: 'create', replacementContent: change.content };
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
      if (!['replace_file', 'replace_text', 'delete_file'].includes(change.operation)) {
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
          `edit handle does not permit ${change.operation}: ${change.editHandle}`,
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
      if (change.operation === 'delete_file') {
        metrics.resolvedEditGrantCount += 1;
        return { path: grant.path, operation: 'delete', expectedFingerprint: grant.fingerprint };
      }
      let replacementContent: string;
      if (change.operation === 'replace_file') {
        const eol = workspace
          ? uniformLineEnding(readFileSync(safeReadPath(workspace, grant.path), 'utf8'))
          : null;
        replacementContent = eol
          ? withLineEnding(change.replacementContent, eol)
          : change.replacementContent;
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
        for (const requested of change.replacements) {
          const replacement = alignReplacement(requested, source);
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
        operation: 'modify',
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
