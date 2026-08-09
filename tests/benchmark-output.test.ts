import { describe, expect, test } from 'vitest';
import {
  formatAcceptance,
  parseNodeTestCounts,
} from '../src/benchmark-output.js';

describe('live benchmark test output', () => {
  test.each([
    '# tests 4\n# pass 4\n# fail 0',
    'ℹ tests 4\nℹ pass 4\nℹ fail 0',
    'ℹ️ tests 4\nℹ️ pass 4\nℹ️ fail 0',
  ])('parses Node TAP summary variants', (output) => {
    expect(parseNodeTestCounts(output)).toEqual({
      tests: 4,
      passed: 4,
      failed: 0,
    });
  });

  test('reports a successful legacy verification without inventing counts', () => {
    expect(formatAcceptance({
      status: 'passed',
      counts: { passed: null, tests: null },
    })).toBe('passed (count unavailable)');
  });
});
