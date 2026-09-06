#!/usr/bin/env node
// Local infrastructure benchmark only. Does not load or call a model provider.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';

const args = process.argv.slice(2);
const argument = (name, fallback) => {
  const position = args.indexOf(name);
  return position < 0 ? fallback : args[position + 1];
};
const baselineDirectory = argument('--baseline-dist');
if (!baselineDirectory) {
  throw new Error('Usage: node benchmarks/local-index-performance.mjs --baseline-dist <prior dist directory> [--pairs 3] [--output report.json]');
}
const pairs = Number(argument('--pairs', '3'));
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 10) {
  throw new Error('--pairs must be an integer between 1 and 10');
}
const currentDirectory = new URL('../dist/', import.meta.url);
const load = async (directory) => ({
  ...await import(new URL('indexer.js', directory)),
  ...await import(new URL('context.js', directory)),
  ...await import(new URL('task.js', directory)),
});
const implementations = {
  baseline: await load(pathToFileURL(`${resolve(baselineDirectory)}/`)),
  updated: await load(currentDirectory),
};
const temporary = mkdtempSync(join(tmpdir(), 'lattice-local-index-bench-'));
const runs = [];
const signatures = new Map();
try {
  const seed = join(temporary, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.lattice/\n');
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ private: true }));
  for (let file = 0; file < 64; file += 1) {
    writeFileSync(join(seed, 'src', `target-${String(file).padStart(3, '0')}.js`),
      Array.from({ length: 80 }, (_, line) =>
        `export const target_${file}_${line} = ${file * 100 + line};\n`).join(''));
  }
  await execa('git', ['init'], { cwd: seed });
  await execa('git', ['config', 'user.name', 'Local benchmark'], { cwd: seed });
  await execa('git', ['config', 'user.email', 'lattice@example.invalid'], { cwd: seed });
  await execa('git', ['config', 'core.autocrlf', 'false'], { cwd: seed });
  await execa('git', ['add', '.'], { cwd: seed });
  await execa('git', ['-c', 'core.hooksPath=', 'commit', '-m', 'synthetic fixture'], { cwd: seed });
  for (let pair = 0; pair < pairs; pair += 1) {
    const order = pair % 2 === 0 ? ['baseline', 'updated'] : ['updated', 'baseline'];
    for (const arm of order) {
      const workspace = join(temporary, `pair-${pair}-${arm}`);
      await execa('git', ['clone', '--quiet', '--no-hardlinks', seed, workspace]);
      await execa('git', ['config', 'core.autocrlf', 'false'], { cwd: workspace });
      const api = implementations[arm];
      const task = api.compileTask('Inspect target exports');
      task.budget.maxPages = 8;
      const started = performance.now();
      const index = await api.buildIndex(workspace);
      const indexMs = performance.now() - started;
      const contextStarted = performance.now();
      const pages = new api.ContextKernel(workspace, index, task).initial();
      const contextMs = performance.now() - contextStarted;
      // Compare full indexed records and exact pages, including fingerprints,
      // ordering, metadata and contents; exclude only paths/timestamps/task ID.
      const signature = JSON.stringify({ files: index.files, scripts: index.scripts, pages });
      if (signatures.has(pair)) assert.equal(signature, signatures.get(pair));
      else signatures.set(pair, signature);
      runs.push({
        pair: pair + 1, arm, indexMs, contextMs,
        indexedFiles: index.files.length, contextPages: pages.length,
        contextCharacters: pages.reduce((sum, page) => sum + page.content.length, 0),
      });
    }
  }
  const mean = (arm, metric) => {
    const selected = runs.filter((run) => run.arm === arm);
    return selected.reduce((sum, run) => sum + run[metric], 0) / selected.length;
  };
  const baselineIndexMs = mean('baseline', 'indexMs');
  const updatedIndexMs = mean('updated', 'indexMs');
  const pairedIndexReductionsPercent = Array.from({ length: pairs }, (_, pair) => {
    const baseline = runs.find((run) => run.pair === pair + 1 && run.arm === 'baseline');
    const updated = runs.find((run) => run.pair === pair + 1 && run.arm === 'updated');
    return 100 * (1 - updated.indexMs / baseline.indexMs);
  });
  const sortedReductions = [...pairedIndexReductionsPercent].sort((a, b) => a - b);
  const middle = Math.floor(pairs / 2);
  const report = {
    schemaVersion: 1, kind: 'local-index-performance',
    createdAt: new Date().toISOString(), platform: process.platform, node: process.version,
    pairs, fixture: '64 synthetic JavaScript modules, 80 exports each, page budget 8',
    identicalIndexAndContext: true, modelCalls: 0,
    baselineIndexMs, updatedIndexMs,
    meanIndexReductionPercent: 100 * (1 - updatedIndexMs / baselineIndexMs),
    pairedIndexReductionsPercent,
    medianPairedIndexReductionPercent: pairs % 2 ? sortedReductions[middle]
      : (sortedReductions[middle - 1] + sortedReductions[middle]) / 2,
    runs,
    limitations: 'One synthetic local workload; warm OS caches; no provider, token, task-success or end-to-end model savings measured.',
  };
  const output = argument('--output');
  if (output) {
    // Output goes only to the explicit caller-selected report file.
    writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
    assert.deepEqual(JSON.parse(readFileSync(resolve(output), 'utf8')), report);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Exactly the unique temporary fixture owned by this invocation.
  await rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
}
