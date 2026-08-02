#!/usr/bin/env node
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'lattice-frontier-evidence-'));
const rawReportPath = join(temporaryRoot, 'vitest.json');
const outputPath = resolve(root, 'docs/evidence/economy-frontier.json');
const vitestPath = resolve(root, 'node_modules/vitest/vitest.mjs');

try {
  const result = spawnSync(
    process.execPath,
    [
      vitestPath,
      'run',
      'tests/economy-frontier.test.ts',
      '--reporter=json',
      `--outputFile=${rawReportPath}`,
    ],
    { cwd: root, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }

  const report = JSON.parse(readFileSync(rawReportPath, 'utf8'));
  const assertions = report.testResults.flatMap(
    (testResult) => testResult.assertionResults,
  );
  const groups = new Map();
  for (const assertion of assertions) {
    const name = assertion.ancestorTitles[0] ?? 'ungrouped';
    const group = groups.get(name) ?? { name, total: 0, passed: 0, failed: 0 };
    group.total += 1;
    if (assertion.status === 'passed') group.passed += 1;
    else group.failed += 1;
    groups.set(name, group);
  }

  const evidence = {
    schemaVersion: 1,
    evidenceType: 'credential-free-safety-frontier',
    command: 'npm run evidence:frontier',
    source: 'tests/economy-frontier.test.ts',
    modelCall: false,
    status: report.success ? 'passed' : 'failed',
    totals: {
      cases: report.numTotalTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numPendingTests + report.numTodoTests,
    },
    groups: [...groups.values()],
    limitations: [
      'These are deterministic unit and contract cases, not live model runs.',
      'This is project-maintainer evidence, not an independent evaluation.',
      'The result does not establish model quality, token, latency, or cost savings.',
    ],
  };

  if (
    evidence.totals.cases !== 240 ||
    evidence.totals.passed !== 240 ||
    evidence.totals.failed !== 0 ||
    evidence.groups.length !== 5
  ) {
    throw new Error('frontier evidence shape changed; review before publishing');
  }

  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Frontier evidence passed: ${evidence.totals.passed}/${evidence.totals.cases} cases\n`,
  );
  process.stdout.write(`Sanitized report: ${outputPath}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
