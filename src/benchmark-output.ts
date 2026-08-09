export type NodeTestCounts = {
  tests: number | null;
  passed: number | null;
  failed: number | null;
};

/** Parse the summary emitted by Node's TAP reporter across Node versions. */
export function parseNodeTestCounts(output: string): NodeTestCounts {
  const value = (label: string) => {
    const pattern = new RegExp(
      `^(?:#|\\u2139(?:\\uFE0F)?)\\s+${label}\\s+(\\d+)\\s*$`,
      'm',
    );
    const match = output.match(pattern);
    return match ? Number.parseInt(match[1], 10) : null;
  };

  return {
    tests: value('tests'),
    passed: value('pass'),
    failed: value('fail'),
  };
}

export function formatAcceptance(
  verification: { status?: string; counts?: Partial<NodeTestCounts> } | null | undefined,
): string {
  const passed = verification?.counts?.passed;
  const tests = verification?.counts?.tests;
  if (Number.isFinite(passed) && Number.isFinite(tests)) return `${passed}/${tests}`;
  if (verification?.status === 'passed') return 'passed (count unavailable)';
  if (verification?.status === 'failed') return 'failed';
  return 'n/a';
}
