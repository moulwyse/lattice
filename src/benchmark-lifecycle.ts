import type { CodexOptions } from '@openai/codex-sdk';
import { isBenchmarkInfrastructureFailure } from './benchmark-failure.js';

/** Per-client overrides only: never modify the user's global Codex setup. */
export function isolatedBenchmarkCodexConfig(
  stateDirectory?: string,
): NonNullable<CodexOptions['config']> {
  return {
    mcp_servers: {},
    features: { hooks: false, plugins: false },
    ...(stateDirectory ? { sqlite_home: stateDirectory } : {}),
  };
}

type CleanupAction = { path: string; remove: () => Promise<void> };
export type RegisterBenchmarkCleanup = (action: CleanupAction) => void;
export type BenchmarkCleanup = {
  status: 'pending' | 'complete' | 'failed';
  pendingPaths: string[];
  errors: { path: string; code?: string; syscall?: string; message: string }[];
};

/** Persist the model outcome before any cleanup can fail or be interrupted. */
export async function captureBenchmarkArm<T extends object>(options: {
  run: (register: RegisterBenchmarkCleanup) => Promise<T>;
  failure: (error: unknown) => T;
  checkpoint: (result: T & { cleanup: BenchmarkCleanup }) => void;
}): Promise<T & { cleanup: BenchmarkCleanup }> {
  const actions: CleanupAction[] = [];
  let result: T;
  try {
    result = await options.run((action) => actions.push(action));
  } catch (error) {
    result = options.failure(error);
  }
  const cleanup: BenchmarkCleanup = {
    status: 'pending',
    pendingPaths: actions.map((action) => action.path),
    errors: [],
  };
  // If the checkpoint cannot be written, stop before deleting the evidence.
  options.checkpoint({ ...result, cleanup });
  for (const action of actions.reverse()) {
    try {
      await action.remove();
      cleanup.pendingPaths = cleanup.pendingPaths.filter((path) => path !== action.path);
    } catch (error) {
      const details = error as NodeJS.ErrnoException | null;
      cleanup.errors.push({
        path: action.path,
        code: typeof details?.code === 'string' ? details.code : undefined,
        syscall: typeof details?.syscall === 'string' ? details.syscall : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  cleanup.status = cleanup.errors.length ? 'failed' : 'complete';
  const completed = { ...result, cleanup };
  options.checkpoint(completed);
  return completed;
}

export function benchmarkStopReason(run: {
  status: string;
  usage?: unknown;
  failureClass?: string | null;
  error?: string | null;
  cleanup?: BenchmarkCleanup;
}): string | null {
  if (run.cleanup?.status === 'failed') {
    return 'temporary-directory cleanup failed; see per-arm checkpoint for paths and errors';
  }
  if (isBenchmarkInfrastructureFailure(run)) {
    return `${run.failureClass}: ${run.error ?? 'infrastructure failure'}`;
  }
  if (run.status !== 'passed' && !run.usage) {
    return `arm failed without usage data: ${run.error ?? 'no completed model turn'}`;
  }
  return null;
}
