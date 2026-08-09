export type BenchmarkFailureClass =
  | 'infrastructure_network'
  | 'infrastructure_authentication'
  | 'infrastructure_configuration'
  | 'infrastructure_timeout'
  | 'execution';

export interface ClassifiedBenchmarkRun {
  failureClass?: string | null;
}

const ENABLED_ENVIRONMENT_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * Detects a host-level network boundary before a live benchmark spends time
 * starting an arm. Codex sets this marker for commands spawned from a task
 * whose permission profile denies network access.
 */
export function benchmarkNetworkPreflightError(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const disabled = environment.CODEX_SANDBOX_NETWORK_DISABLED
    ?.trim()
    .toLowerCase();
  if (!disabled || !ENABLED_ENVIRONMENT_VALUES.has(disabled)) return null;

  return (
    'live benchmark blocked before any model request: the current Codex ' +
    'permission profile disables network access for spawned commands ' +
    '(CODEX_SANDBOX_NETWORK_DISABLED=1). Run the benchmark from a normal ' +
    'terminal, or switch the Codex task to Full access, then retry'
  );
}

export function classifyBenchmarkFailure(message: unknown): BenchmarkFailureClass {
  const normalized = String(message ?? '').toLowerCase();
  if (
    normalized.includes('stream disconnected') ||
    normalized.includes('error sending request') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnrefused') ||
    normalized.includes('enotfound') ||
    normalized.includes('failed to connect')
  ) {
    return 'infrastructure_network';
  }
  if (
    normalized.includes('not logged in') ||
    normalized.includes('unauthorized') ||
    normalized.includes('authentication') ||
    normalized.includes('api key')
  ) {
    return 'infrastructure_authentication';
  }
  if (
    normalized.includes('config.toml') ||
    normalized.includes('invalid transport') ||
    normalized.includes('configuration')
  ) {
    return 'infrastructure_configuration';
  }
  if (normalized.includes('timed out') || normalized.includes('timeout')) {
    return 'infrastructure_timeout';
  }
  return 'execution';
}

export function isBenchmarkInfrastructureFailure(run: ClassifiedBenchmarkRun): boolean {
  return typeof run.failureClass === 'string' &&
    run.failureClass.startsWith('infrastructure_');
}
