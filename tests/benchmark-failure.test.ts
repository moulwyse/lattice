import { describe, expect, test } from 'vitest';
import {
  benchmarkNetworkPreflightError,
  classifyBenchmarkFailure,
  isBenchmarkInfrastructureFailure,
} from '../src/benchmark-failure.js';

describe('live benchmark failure classification', () => {
  test.each([
    'stream disconnected before completion',
    'error sending request for url (https://api.openai.com/v1/responses)',
    'connect ECONNRESET 127.0.0.1:443',
  ])('marks network transport failures as infrastructure: %s', (message) => {
    expect(classifyBenchmarkFailure(message)).toBe('infrastructure_network');
  });

  test('separates authentication, configuration, and timeout failures', () => {
    expect(classifyBenchmarkFailure('API key is missing')).toBe(
      'infrastructure_authentication',
    );
    expect(classifyBenchmarkFailure('invalid transport in mcp_servers.lattice')).toBe(
      'infrastructure_configuration',
    );
    expect(classifyBenchmarkFailure('raw Codex benchmark timed out')).toBe(
      'infrastructure_timeout',
    );
  });

  test('does not mislabel an ordinary execution failure as infrastructure', () => {
    const failureClass = classifyBenchmarkFailure('acceptance tests failed');
    expect(failureClass).toBe('execution');
    expect(isBenchmarkInfrastructureFailure({ failureClass })).toBe(false);
  });

  test('recognizes every infrastructure class', () => {
    expect(isBenchmarkInfrastructureFailure({
      failureClass: 'infrastructure_network',
    })).toBe(true);
    expect(isBenchmarkInfrastructureFailure({ failureClass: null })).toBe(false);
  });

  test.each(['1', 'true', 'YES', 'on'])(
    'fails preflight when the host disables spawned-command network: %s',
    (value) => {
      expect(benchmarkNetworkPreflightError({
        CODEX_SANDBOX_NETWORK_DISABLED: value,
      })).toContain('CODEX_SANDBOX_NETWORK_DISABLED=1');
    },
  );

  test('allows live preflight outside a network-disabled Codex sandbox', () => {
    expect(benchmarkNetworkPreflightError({})).toBeNull();
    expect(benchmarkNetworkPreflightError({
      CODEX_SANDBOX_NETWORK_DISABLED: '0',
    })).toBeNull();
  });
});
