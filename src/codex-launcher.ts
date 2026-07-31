import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { z } from 'zod';
import {
  runInheritedProcess,
  type InheritedProcessResult,
} from './managed-process.js';

export const CODEX_LAUNCHER_DEPTH_ENV = 'LATTICE_CODEX_LAUNCH_DEPTH';

export const NativeCodexTargetSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z.string().min(1),
    prefixArguments: z.array(z.string()),
    sourcePath: z.string().min(1),
    sourceKind: z.enum(['native-executable', 'official-npm-entry', 'injected']),
  })
  .strict();

export type NativeCodexTarget = z.infer<typeof NativeCodexTargetSchema>;

export type LauncherInfrastructureLease = {
  detach(nativeProcessElapsedMs?: number): Promise<void>;
};

export type CodexLaunchOptions = {
  target: NativeCodexTarget;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  raw?: boolean;
  signal?: AbortSignal;
  wrapperPaths?: readonly string[];
  attachInfrastructure?: (
    cwd: string,
    signal: AbortSignal,
  ) => Promise<LauncherInfrastructureLease | null>;
  onInfrastructureError?: (error: Error) => void;
};

export type CodexLaunchResult = InheritedProcessResult & {
  raw: boolean;
  infrastructure: 'disabled' | 'attached' | 'degraded';
  infrastructureError: string | null;
};

function canonicalPath(path: string) {
  const absolute = resolve(path);
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // A missing path is rejected separately; canonicalization is still useful
    // for recursion checks in tests and diagnostics.
  }
  canonical = normalize(canonical);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function targetWouldRecurse(
  target: NativeCodexTarget,
  wrapperPaths: readonly string[],
) {
  const forbidden = new Set(wrapperPaths.map(canonicalPath));
  return (
    forbidden.has(canonicalPath(target.command)) ||
    forbidden.has(canonicalPath(target.sourcePath))
  );
}

export function validateNativeCodexTarget(
  value: unknown,
  wrapperPaths: readonly string[] = [],
) {
  const target = NativeCodexTargetSchema.parse(value);
  if (!isAbsolute(target.command) || !isAbsolute(target.sourcePath)) {
    throw new Error('native Codex target paths must be absolute');
  }
  if (targetWouldRecurse(target, wrapperPaths)) {
    throw new Error('Codex launcher recursion prevented: target resolves to a Lattice shim');
  }
  return target;
}

function compactError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
}

/**
 * Starts the official Codex process immediately with inherited terminal
 * streams. Optional Lattice infrastructure warms concurrently and cannot
 * prevent the foreground process from starting or alter its exit result.
 */
export async function launchNativeCodex(
  arguments_: readonly string[],
  options: CodexLaunchOptions,
): Promise<CodexLaunchResult> {
  const target = validateNativeCodexTarget(options.target, options.wrapperPaths);
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  };
  const inheritedDepth = Number(
    baseEnvironment[CODEX_LAUNCHER_DEPTH_ENV] ?? 0,
  );
  if (!Number.isFinite(inheritedDepth) || inheritedDepth > 0) {
    throw new Error('Codex launcher recursion prevented');
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const raw = options.raw === true;
  let infrastructure: CodexLaunchResult['infrastructure'] = raw
    ? 'disabled'
    : 'degraded';
  let infrastructureError: string | null = null;
  const infrastructureController = new AbortController();
  const infrastructurePromise =
    raw || !options.attachInfrastructure
      ? null
      : Promise.resolve()
          .then(() =>
            options.attachInfrastructure!(cwd, infrastructureController.signal),
          )
          .then((lease) => {
            infrastructure = lease ? 'attached' : 'degraded';
            return lease;
          })
          .catch((error: unknown) => {
            if (infrastructureController.signal.aborted) return null;
            infrastructureError = compactError(error);
            options.onInfrastructureError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
            return null;
          });

  const childEnvironment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    [CODEX_LAUNCHER_DEPTH_ENV]: String(inheritedDepth + 1),
  };
  let result: InheritedProcessResult | null = null;
  try {
    result = await runInheritedProcess(
      target.command,
      [...target.prefixArguments, ...arguments_],
      {
        cwd,
        env: childEnvironment,
        signal: options.signal,
      },
    );
  } finally {
    infrastructureController.abort(
      new Error('native Codex process exited before infrastructure startup completed'),
    );
    const lease = await infrastructurePromise;
    if (lease) {
      await lease.detach(result?.elapsedMs).catch((error: unknown) => {
        infrastructure = 'degraded';
        infrastructureError ??= compactError(error);
        options.onInfrastructureError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
  }

  if (!result) throw new Error('native Codex process did not produce a result');
  return {
    ...result,
    raw,
    infrastructure,
    infrastructureError,
  };
}
