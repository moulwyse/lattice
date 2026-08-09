export type BenchmarkFailureClass =
  | 'infrastructure_network'
  | 'infrastructure_authentication'
  | 'infrastructure_configuration'
  | 'infrastructure_timeout'
  | 'execution';

export interface ClassifiedBenchmarkRun {
  failureClass?: string | null;
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
