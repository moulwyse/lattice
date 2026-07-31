import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { metadata, rawHash, readJson, writeJson } from './core.js';
import type { InternalPatchIR, RepositoryIndex, TaskIR } from './types.js';

export type VerifiedPatchCacheArtifact = {
  schemaVersion: 1;
  key: string;
  createdAt: string;
  providerProtocolVersion: 4;
  internalPatch: InternalPatchIR;
};

function pathFor(workspace: string, key: string) {
  return join(metadata(workspace), 'cache', 'verified-patches', `${key}.json`);
}

export function verifiedPatchCacheKey(
  task: TaskIR,
  index: RepositoryIndex,
  identity: { repositoryId: string; baseCommit: string },
) {
  const canonical = {
    schemaVersion: 1,
    providerProtocolVersion: 4,
    repositoryId: identity.repositoryId,
    baseCommit: identity.baseCommit,
    task: {
      goal: task.goal,
      constraints: task.constraints,
      invariants: task.invariants,
      acceptanceCriteria: task.acceptanceCriteria.map((criterion) => criterion.text),
      risk: task.risk,
      scope: task.scope,
      allowedVerificationCommands: task.allowedVerificationCommands,
    },
    files: [...index.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => [
        file.path,
        file.fingerprint.value,
        file.fingerprint.rawSha256,
        file.fingerprint.byteLength,
      ]),
  };
  return rawHash(Buffer.from(JSON.stringify(canonical), 'utf8'));
}

export function loadVerifiedPatch(workspace: string, key: string) {
  const path = pathFor(workspace, key);
  if (!existsSync(path)) return undefined;
  const artifact = readJson<VerifiedPatchCacheArtifact>(path);
  if (
    artifact.schemaVersion !== 1 ||
    artifact.providerProtocolVersion !== 4 ||
    artifact.key !== key ||
    artifact.internalPatch.schemaVersion !== 1
  ) {
    return undefined;
  }
  return artifact;
}

export function persistVerifiedPatch(
  workspace: string,
  key: string,
  internalPatch: InternalPatchIR,
) {
  const artifact: VerifiedPatchCacheArtifact = {
    schemaVersion: 1,
    key,
    createdAt: new Date().toISOString(),
    providerProtocolVersion: 4,
    internalPatch,
  };
  writeJson(pathFor(workspace, key), artifact);
  return artifact;
}
