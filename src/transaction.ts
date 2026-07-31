import { dirname, join } from 'node:path';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execa } from 'execa';
import { removeDirectoryWithRetry } from './cleanup.js';
import { repositoryGrantIdentity } from './edit-grants.js';
import { fingerprint } from './fingerprint.js';
import { runManagedProcess } from './managed-process.js';
import { metadata, safePath, uid } from './core.js';
import type {
  ChangeOperation,
  Fingerprint,
  InternalPatchIR,
  Telemetry,
} from './types.js';

export type VerificationResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type TransactionResult = {
  status: 'passed' | 'failed';
  worktree: string;
  changedFiles: string[];
  diff: string;
  verification: VerificationResult[];
  fingerprints: { path: string; before?: Fingerprint; after?: Fingerprint }[];
};

export function assertMatchingWorktreeFingerprint(
  path: string,
  expected: string,
  source: Fingerprint,
  worktree: Fingerprint,
) {
  if (worktree.value === expected) return;
  throw new Error(
    [
      `worktree fingerprint mismatch: ${path}`,
      `sourceIdentity=${expected}`,
      `worktreeIdentity=${worktree.value}`,
      `sourceRawSha256=${source.rawSha256}`,
      `worktreeRawSha256=${worktree.rawSha256}`,
      `sourceBytes=${source.byteLength}`,
      `worktreeBytes=${worktree.byteLength}`,
    ].join('; '),
  );
}

function commandParts(command: string) {
  // The allowlist intentionally contains simple commands only. Shell interpretation is never used.
  return command.trim().split(/\s+/);
}

async function assertCleanWorkspace(workspace: string) {
  const status = await execa('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: workspace,
  });
  const relevant = status.stdout.split(/\r?\n/).filter((line) => {
    if (!line) return false;
    const path = line.slice(3).replaceAll('\\', '/').replace(/^"|"$/g, '');
    return path !== '.lattice' && !path.startsWith('.lattice/');
  });
  if (relevant.length > 0) {
    throw new Error(`unsupported dirty workspace: ${relevant.slice(0, 8).join(', ')}`);
  }
}

export async function transact(
  workspace: string,
  patch: InternalPatchIR,
  allowlist: string[],
  metrics: Telemetry,
  retain = false,
  signal?: AbortSignal,
  verificationTimeoutMs = 120_000,
  onVerificationStart?: () => void,
): Promise<TransactionResult> {
  signal?.throwIfAborted();
  if (patch.schemaVersion !== 1) {
    throw new Error(`unsupported internal patch version: ${patch.schemaVersion}`);
  }
  const identity = await repositoryGrantIdentity(workspace);
  if (identity.repositoryId !== patch.repositoryId) {
    throw new Error('internal patch repository identity mismatch');
  }
  if (identity.baseCommit !== patch.baseCommit) {
    throw new Error(
      `internal patch base commit mismatch: expected=${patch.baseCommit}; actual=${identity.baseCommit}`,
    );
  }
  const { changes, verificationCommands: commands } = patch;
  for (const command of commands) {
    if (!allowlist.includes(command)) {
      throw new Error(`verification command not allowlisted: ${command}`);
    }
  }

  const sourceFingerprints = new Map<string, Fingerprint>();
  for (const change of changes) {
    safePath(workspace, change.path);
    if (change.operation !== 'create') {
      const current = await fingerprint(workspace, change.path);
      sourceFingerprints.set(change.path, current);
      if (current.value !== change.expectedFingerprint) {
        throw new Error(
          `stale source: ${change.path}; expected=${change.expectedFingerprint}; actual=${current.value}`,
        );
      }
    }
  }
  await assertCleanWorkspace(workspace);
  signal?.throwIfAborted();

  const id = uid();
  const directory = join(metadata(workspace), 'worktrees', id);
  mkdirSync(join(metadata(workspace), 'worktrees'), { recursive: true });
  let worktreeAttempted = false;
  try {
    worktreeAttempted = true;
    await execa(
      'git',
      [
        '-c',
        'core.autocrlf=false',
        'worktree',
        'add',
        '--detach',
        directory,
        patch.baseCommit,
      ],
      { cwd: workspace, cancelSignal: signal },
    );
    const fingerprints: TransactionResult['fingerprints'] = [];
    const semanticChanges: ChangeOperation[] = [];

    for (const change of changes) {
      signal?.throwIfAborted();
      const source = sourceFingerprints.get(change.path);
      const before =
        change.operation === 'create' ? undefined : await fingerprint(directory, change.path);
      if (change.operation !== 'create') {
        assertMatchingWorktreeFingerprint(
          change.path,
          change.expectedFingerprint!,
          source!,
          before!,
        );
      }

      const target = safePath(directory, change.path);
      if (change.operation === 'delete') {
        unlinkSync(target);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, change.replacementContent!, 'utf8');
      }
      const after =
        change.operation === 'delete' ? undefined : await fingerprint(directory, change.path);
      fingerprints.push({ path: change.path, before, after });
      if (
        change.operation === 'modify' &&
        before?.kind === 'git' &&
        after?.kind === 'git' &&
        before.value === after.value
      ) {
        await execa('git', ['checkout', '--', change.path], { cwd: directory });
      } else {
        semanticChanges.push(change);
      }
    }

    for (const change of semanticChanges) {
      if (change.operation === 'create') {
        await execa('git', ['add', '--intent-to-add', '--', change.path], { cwd: directory });
      }
    }

    const verification: VerificationResult[] = [];
    onVerificationStart?.();
    const verificationStarted = Date.now();
    let passed = true;
    for (const command of commands) {
      signal?.throwIfAborted();
      const [executable, ...arguments_] = commandParts(command);
      const result = await runManagedProcess(executable, arguments_, {
        cwd: directory,
        reject: false,
        timeoutMs: verificationTimeoutMs,
        signal,
      });
      verification.push({
        command,
        exitCode: result.exitCode ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (result.exitCode !== 0) {
        passed = false;
        break;
      }
    }
    metrics.verificationDurationMs = Date.now() - verificationStarted;
    const diff = (
      await execa('git', ['diff', '--no-ext-diff', '--binary'], { cwd: directory })
    ).stdout;
    return {
      status: passed ? 'passed' : 'failed',
      worktree: directory,
      changedFiles: semanticChanges.map((change) => change.path),
      diff,
      verification,
      fingerprints,
    };
  } finally {
    if (worktreeAttempted && !retain) {
      const removal = await execa('git', ['worktree', 'remove', '--force', directory], {
        cwd: workspace,
        reject: false,
      });
      await removeDirectoryWithRetry(directory);
      if (removal.exitCode !== 0) {
        const prune = await execa('git', ['worktree', 'prune'], {
          cwd: workspace,
          reject: false,
        });
        if (prune.exitCode !== 0) {
          throw new Error(
            `failed to clean isolated worktree: remove=${removal.stderr}; prune=${prune.stderr}`,
          );
        }
      }
    }
  }
}
