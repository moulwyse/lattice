import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

// A local convenience launcher, not an alternative benchmark implementation.
if (!process.argv.includes('--confirm-live')) {
  process.stderr.write('One live RAW/Lattice pair can consume model quota. Rerun with --confirm-live.\n');
  process.exit(2);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = resolve(root, '.lattice', 'evaluation',
  `astra-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const env = {
  BENCH_MODEL: 'gpt-6-astra',
  BENCH_REASONING_EFFORT: 'medium',
  BENCH_REPETITIONS: '1',
  BENCH_OUTPUT_DIRECTORY: outputDirectory,
};

console.log(`Results: ${outputDirectory}`);
const run = await execa('npm', ['run', 'benchmark:paired', '--', '--confirm-live'], {
  cwd: root, env, stdio: 'inherit', reject: false,
});
process.exitCode = run.exitCode ?? 1;
const summaryPath = join(outputDirectory, 'raw-vs-lattice-gpt-6-astra-live-summary.json');
try {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const passed = summary.runs?.length === 2 && summary.runs.every((arm) => arm.status === 'passed');
  const tokens = summary.comparison?.freshPlusOutputTokens;
  if (summary.validity?.valid && passed && Number.isFinite(tokens?.latticeSavingPercent)) {
    console.log('\nASTRA / medium - completed pair');
    console.log(`Fresh input + output: RAW ${tokens.rawMean} -> Lattice ${tokens.latticeMean}`);
    console.log(`Token reduction: ${tokens.latticeSavingPercent.toFixed(2)}%`);
    const elapsed = summary.comparison?.elapsedMs;
    if (Number.isFinite(elapsed?.latticeSavingPercent)) {
      console.log(`Elapsed: RAW ${(elapsed.rawMean / 1000).toFixed(2)} s -> Lattice ${(elapsed.latticeMean / 1000).toFixed(2)} s`);
      console.log(`Time reduction: ${elapsed.latticeSavingPercent.toFixed(2)}%`);
    }
    console.log('This is one task-specific pair, not a universal savings estimate.');
  } else {
    console.error('\nNo accepted complete pair. Do not publish a savings claim.');
    console.error(summary.validity?.reason ?? 'Review the individual arm statuses and usage.');
    process.exitCode = 1;
  }
  console.log(`Summary: ${summaryPath}`);
} catch (error) {
  console.error(`No readable summary: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
