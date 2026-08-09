import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { execa } from 'execa';
import {
  benchmarkNetworkPreflightError,
  classifyBenchmarkFailure,
  isBenchmarkInfrastructureFailure,
} from '../dist/benchmark-failure.js';
import {
  formatAcceptance,
  parseNodeTestCounts,
} from '../dist/benchmark-output.js';
import { removeDirectoryWithRetry } from '../dist/cleanup.js';
import { runTask } from '../dist/runtime.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(scriptDirectory);
const fixture = join(projectDirectory, 'fixtures', 'reset-token');
const outputDirectory = resolve(
  process.env.BENCH_OUTPUT_DIRECTORY ?? join(projectDirectory, '.lattice', 'evaluation'),
);
const repetitions = Number.parseInt(process.env.BENCH_REPETITIONS ?? '1', 10);
const goal =
  'Fix reset token behavior: consume a valid token once, reject a second consumption and expired tokens, record a password-reset audit event, and preserve login behavior.';
const model = process.env.BENCH_MODEL ?? 'gpt-5.6-luna';
const reasoningEffort = process.env.BENCH_REASONING_EFFORT ?? 'medium';
const outputTag = model.replace(/[^a-zA-Z0-9._-]+/g, '-');
const jsonOutputPath = join(outputDirectory, `raw-vs-lattice-${outputTag}-live-summary.json`);
const reportOutputPath = join(outputDirectory, `raw-vs-lattice-${outputTag}-live-report.md`);
const fixedGitDate = '2000-01-01T00:00:00Z';
const liveRunConfirmed = process.argv.includes('--confirm-live');

if (!liveRunConfirmed) {
  process.stderr.write(
    'This benchmark runs two live arms per repetition and can consume paid quota. Additional repair or context turns are possible.\n' +
      'Review benchmarks/README.md, set BENCH_MODEL and BENCH_REPETITIONS, then rerun with --confirm-live.\n',
  );
  process.exitCode = 2;
  process.exit();
}

if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  throw new Error('BENCH_REPETITIONS must be an integer from 1 through 10');
}

const networkPreflightError = benchmarkNetworkPreflightError();
if (networkPreflightError) {
  process.stderr.write(`${networkPreflightError}. No benchmark arm was started.\n`);
  process.exitCode = 2;
  process.exit();
}

function assertTemporaryDirectory(path, prefix) {
  const resolvedPath = resolve(path);
  const resolvedTemporaryRoot = resolve(tmpdir());
  if (
    dirname(resolvedPath) !== resolvedTemporaryRoot ||
    !basename(resolvedPath).startsWith(prefix)
  ) {
    throw new Error(`refusing to clean unexpected temporary directory: ${resolvedPath}`);
  }
}

function assertNestedWorktree(workspace, worktree) {
  const expectedRoot = resolve(workspace, '.lattice', 'worktrees');
  const resolvedWorktree = resolve(worktree);
  const relation = relative(expectedRoot, resolvedWorktree);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`)) {
    throw new Error(`refusing to clean unexpected Lattice worktree: ${resolvedWorktree}`);
  }
}

async function command(workspace, file, args, options = {}) {
  return execa(file, args, {
    cwd: workspace,
    reject: false,
    ...options,
  });
}

function itemCounts(items = []) {
  return Object.fromEntries(
    [...new Set(items.map((item) => item.type))].map((type) => [
      type,
      items.filter((item) => item.type === type).length,
    ]),
  );
}

async function createWorkspace(system, repetition) {
  const prefix = `raw-vs-lattice-${system}-${repetition}-`;
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  cpSync(join(fixture, 'package.json'), join(workspace, 'package.json'));
  cpSync(join(fixture, 'src'), join(workspace, 'src'), { recursive: true });
  cpSync(join(fixture, 'tests'), join(workspace, 'tests'), { recursive: true });
  writeFileSync(join(workspace, '.gitignore'), '.lattice/\nnode_modules/\n', 'utf8');

  const gitEnvironment = {
    ...process.env,
    GIT_AUTHOR_DATE: fixedGitDate,
    GIT_COMMITTER_DATE: fixedGitDate,
  };
  await command(workspace, 'git', ['init']);
  await command(workspace, 'git', [
    'config',
    'user.email',
    'lattice@' + 'example.invalid',
  ]);
  await command(workspace, 'git', ['config', 'user.name', 'Codex Benchmark']);
  await command(workspace, 'git', ['config', 'core.autocrlf', 'false']);
  await command(workspace, 'git', ['add', '.']);
  const commit = await command(
    workspace,
    'git',
    ['commit', '-m', 'reset-token baseline'],
    { env: gitEnvironment },
  );
  if (commit.exitCode !== 0) throw new Error(`failed to create baseline commit: ${commit.stderr}`);
  const commitId = await command(workspace, 'git', ['rev-parse', 'HEAD']);
  const baseline = await command(workspace, 'npm', ['test']);
  return {
    workspace,
    commit: commitId.stdout.trim(),
    baseline: {
      status: baseline.exitCode === 0 ? 'passed' : 'failed',
      exitCode: baseline.exitCode,
      counts: parseNodeTestCounts(`${baseline.stdout}\n${baseline.stderr}`),
      stdout: baseline.stdout,
      stderr: baseline.stderr,
    },
  };
}

async function independentlyVerify(sourceWorkspace, system, repetition) {
  const prefix = `raw-vs-lattice-verify-${system}-${repetition}-`;
  const verificationWorkspace = mkdtempSync(join(tmpdir(), prefix));
  try {
    cpSync(join(fixture, 'package.json'), join(verificationWorkspace, 'package.json'));
    cpSync(join(fixture, 'tests'), join(verificationWorkspace, 'tests'), { recursive: true });
    cpSync(join(sourceWorkspace, 'src'), join(verificationWorkspace, 'src'), {
      recursive: true,
    });
    const started = Date.now();
    const verification = await command(verificationWorkspace, 'npm', ['test']);
    const combined = `${verification.stdout}\n${verification.stderr}`;
    return {
      status: verification.exitCode === 0 ? 'passed' : 'failed',
      exitCode: verification.exitCode,
      elapsedMs: Date.now() - started,
      counts: parseNodeTestCounts(combined),
      stdout: verification.stdout,
      stderr: verification.stderr,
      pristineTests: true,
    };
  } finally {
    assertTemporaryDirectory(verificationWorkspace, prefix);
    await removeDirectoryWithRetry(verificationWorkspace);
  }
}

function normalizedUsage(usage) {
  if (!usage) return null;
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.cached_input_tokens;
  const freshInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = usage.output_tokens;
  return {
    inputTokens,
    cachedInputTokens,
    freshInputTokens,
    outputTokens,
    reasoningTokens: usage.reasoning_output_tokens,
    freshPlusOutputTokens: freshInputTokens + outputTokens,
  };
}

async function runRawCodex(repetition) {
  const setup = await createWorkspace('raw', repetition);
  const { workspace } = setup;
  const started = Date.now();
  try {
    const codex = new Codex({
      config: {
        // Replace the complete MCP table for the RAW arm. Supplying only an
        // `enabled = false` leaf creates an incomplete server entry on newer
        // Codex builds, which is rejected before the benchmark can start.
        mcp_servers: {},
      },
    });
    const thread = codex.startThread({
      model,
      modelReasoningEffort: reasoningEffort,
      workingDirectory: workspace,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('raw Codex benchmark timed out')),
      180_000,
    );
    const modelStarted = Date.now();
    let turn;
    try {
      turn = await thread.run(goal, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const modelElapsedMs = Date.now() - modelStarted;
    const verification = await independentlyVerify(workspace, 'raw', repetition);
    const diff = await command(workspace, 'git', ['diff', '--no-ext-diff', '--binary']);
    const changed = await command(workspace, 'git', ['diff', '--name-only']);
    const status = await command(workspace, 'git', ['status', '--short']);
    return {
      schemaVersion: 1,
      system: 'raw_codex',
      repetition,
      status: verification.status,
      baselineCommit: setup.commit,
      baseline: setup.baseline,
      usage: normalizedUsage(turn.usage),
      providerTurns: 1,
      modelElapsedMs,
      elapsedMs: Date.now() - started,
      threadId: thread.id,
      itemCounts: itemCounts(turn.items),
      changedFiles: changed.stdout.split(/\r?\n/).filter(Boolean),
      gitStatus: status.stdout,
      unifiedDiff: diff.stdout,
      finalResponse: turn.finalResponse,
      independentVerification: verification,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 1,
      system: 'raw_codex',
      repetition,
      status: 'failed',
      baselineCommit: setup.commit,
      baseline: setup.baseline,
      elapsedMs: Date.now() - started,
      failureClass: classifyBenchmarkFailure(message),
      error: message,
    };
  } finally {
    assertTemporaryDirectory(workspace, `raw-vs-lattice-raw-${repetition}-`);
    await removeDirectoryWithRetry(workspace);
  }
}

function latticeUsage(telemetry) {
  if (!telemetry || telemetry.modelInputTokens === null) return null;
  const freshInputTokens = telemetry.nonCachedInputTokens ?? Math.max(
    0,
    telemetry.modelInputTokens - (telemetry.cachedInputTokens ?? 0),
  );
  const outputTokens = telemetry.outputTokens ?? 0;
  return {
    inputTokens: telemetry.modelInputTokens,
    cachedInputTokens: telemetry.cachedInputTokens ?? 0,
    freshInputTokens,
    outputTokens,
    reasoningTokens: telemetry.reasoningTokens ?? 0,
    freshPlusOutputTokens: freshInputTokens + outputTokens,
  };
}

async function removeRetainedWorktree(workspace, worktree) {
  assertNestedWorktree(workspace, worktree);
  await command(workspace, 'git', ['worktree', 'remove', '--force', worktree]);
  await removeDirectoryWithRetry(worktree);
  await command(workspace, 'git', ['worktree', 'prune']);
}

async function runLattice(repetition) {
  const setup = await createWorkspace('lattice', repetition);
  const { workspace } = setup;
  const started = Date.now();
  let retainedWorktree;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Lattice benchmark timed out')),
      180_000,
    );
    let result;
    try {
      result = await runTask(workspace, goal, {
        worker: 'codex',
        model,
        reasoningEffort,
        modelPolicy: 'inherit',
        useVerifiedCache: false,
        retainWorktree: true,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    retainedWorktree = result.transaction?.worktree;
    const verification = retainedWorktree
      ? await independentlyVerify(retainedWorktree, 'lattice', repetition)
      : {
          status: 'failed',
          exitCode: null,
          elapsedMs: null,
          counts: { tests: null, passed: null, failed: null },
          stdout: '',
          stderr: 'Lattice produced no retained transaction worktree',
          pristineTests: true,
        };
    const protocolOperations = result.internalPatch?.changes.map((change) => ({
      path: change.path,
      operation: change.operation,
    })) ?? [];
    return {
      schemaVersion: 1,
      system: 'lattice',
      repetition,
      status: result.status === 'passed' && verification.status === 'passed'
        ? 'passed'
        : 'failed',
      baselineCommit: setup.commit,
      baseline: setup.baseline,
      usage: latticeUsage(result.telemetry),
      providerTurns: result.workerTurns ?? result.telemetry?.workerTurns ?? null,
      modelElapsedMs: result.telemetry?.stageMs?.worker ?? null,
      elapsedMs: Date.now() - started,
      threadId: result.threadId,
      itemCounts: { provider_turn: result.telemetry?.workerTurns ?? 0 },
      changedFiles: result.changedFiles ?? [],
      unifiedDiff: result.unifiedDiff ?? '',
      finalResponse: null,
      pageFaults: result.telemetry?.pageFaults ?? null,
      protocolRepairTurns: result.telemetry?.protocolRepairTurns ?? null,
      verifiedPatchCacheHit: result.telemetry?.verifiedPatchCacheHit ?? null,
      promptManifests: result.telemetry?.promptManifests ?? [],
      protocolOperations,
      internalStatus: result.status,
      failureStage: result.failureStage ?? null,
      failureClass: result.error ? classifyBenchmarkFailure(result.error) : null,
      error: result.error ?? null,
      independentVerification: verification,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      schemaVersion: 1,
      system: 'lattice',
      repetition,
      status: 'failed',
      baselineCommit: setup.commit,
      baseline: setup.baseline,
      elapsedMs: Date.now() - started,
      failureClass: classifyBenchmarkFailure(message),
      error: message,
    };
  } finally {
    if (retainedWorktree) await removeRetainedWorktree(workspace, retainedWorktree);
    assertTemporaryDirectory(workspace, `raw-vs-lattice-lattice-${repetition}-`);
    await removeDirectoryWithRetry(workspace);
  }
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function summarizeValues(values) {
  if (values.length === 0) return null;
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  return {
    mean: average,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    standardDeviation: Math.sqrt(variance),
  };
}

function aggregate(systemRuns) {
  const passed = systemRuns.filter((run) => run.status === 'passed');
  const metric = (selector) => summarizeValues(
    passed.map(selector).filter((value) => Number.isFinite(value)),
  );
  return {
    runs: systemRuns.length,
    passed: passed.length,
    passRate: systemRuns.length === 0 ? null : passed.length / systemRuns.length,
    inputTokens: metric((run) => run.usage?.inputTokens),
    cachedInputTokens: metric((run) => run.usage?.cachedInputTokens),
    freshInputTokens: metric((run) => run.usage?.freshInputTokens),
    outputTokens: metric((run) => run.usage?.outputTokens),
    reasoningTokens: metric((run) => run.usage?.reasoningTokens),
    freshPlusOutputTokens: metric((run) => run.usage?.freshPlusOutputTokens),
    modelElapsedMs: metric((run) => run.modelElapsedMs),
    elapsedMs: metric((run) => run.elapsedMs),
    providerTurns: metric((run) => run.providerTurns),
    changedFiles: metric((run) => run.changedFiles?.length),
  };
}

function savingPercent(rawValue, latticeValue) {
  if (!Number.isFinite(rawValue) || !Number.isFinite(latticeValue) || rawValue === 0) return null;
  return ((rawValue - latticeValue) / rawValue) * 100;
}

function comparison(raw, lattice) {
  const compare = (field) => ({
    rawMean: raw[field]?.mean ?? null,
    latticeMean: lattice[field]?.mean ?? null,
    latticeSavingPercent: savingPercent(raw[field]?.mean, lattice[field]?.mean),
  });
  return {
    inputTokens: compare('inputTokens'),
    cachedInputTokens: compare('cachedInputTokens'),
    freshInputTokens: compare('freshInputTokens'),
    outputTokens: compare('outputTokens'),
    reasoningTokens: compare('reasoningTokens'),
    freshPlusOutputTokens: compare('freshPlusOutputTokens'),
    modelElapsedMs: compare('modelElapsedMs'),
    elapsedMs: compare('elapsedMs'),
  };
}

function number(value, digits = 0) {
  if (!Number.isFinite(value)) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function percent(value) {
  return Number.isFinite(value) ? `${number(value, 1)}%` : 'n/a';
}

function buildReport(artifact) {
  const raw = artifact.aggregates.rawCodex;
  const lattice = artifact.aggregates.lattice;
  const comparisonData = artifact.comparison;
  const metricRow = (label, field, unit = '') => {
    const rawValue = raw[field]?.mean;
    const latticeValue = lattice[field]?.mean;
    const saving = comparisonData[field]?.latticeSavingPercent;
    return `| ${label} | ${number(rawValue, 1)}${unit} | ${number(latticeValue, 1)}${unit} | ${percent(saving)} |`;
  };
  const runRows = artifact.runs.map((run) =>
    `| ${run.repetition} | ${run.system === 'raw_codex' ? 'RAW Codex' : 'Lattice'} | ${run.status} | ${number(run.usage?.freshInputTokens)} | ${number(run.usage?.cachedInputTokens)} | ${number(run.usage?.outputTokens)} | ${number(run.usage?.freshPlusOutputTokens)} | ${number(run.elapsedMs)} ms | ${formatAcceptance(run.independentVerification)} |`,
  );
  const validityWarning = artifact.validity.valid
    ? ''
    : `> **Invalid performance sample:** ${artifact.validity.reason}. No savings percentage from this execution is publishable.\n\n`;
  return `# RAW Codex vs Lattice - live benchmark\n\n` +
    `Created: ${artifact.createdAt}\n\n` +
    validityWarning +
    `Controls: model \`${model}\`, reasoning \`${reasoningEffort}\`, one task, one fixture, and an identical baseline commit. Every run starts in a fresh repository. Lattice verified-patch reuse is disabled. Each candidate is verified in a separate clean directory with pristine acceptance tests.\n\n` +
    `## Result\n\n` +
    `- RAW Codex: ${raw.passed}/${raw.runs} successful runs.\n` +
    `- Lattice: ${lattice.passed}/${lattice.runs} successful runs.\n` +
    `- A positive reduction means Lattice used less of the metric than RAW Codex.\n\n` +
    `| Mean across successful runs | RAW Codex | Lattice | Lattice reduction |\n` +
    `|---|---:|---:|---:|\n` +
    `${metricRow('Total input', 'inputTokens')}\n` +
    `${metricRow('Cached input', 'cachedInputTokens')}\n` +
    `${metricRow('Fresh input', 'freshInputTokens')}\n` +
    `${metricRow('Output', 'outputTokens')}\n` +
    `${metricRow('Fresh + output', 'freshPlusOutputTokens')}\n` +
    `${metricRow('Model execution time', 'modelElapsedMs', ' ms')}\n` +
    `${metricRow('End-to-end elapsed time', 'elapsedMs', ' ms')}\n\n` +
    `## Every run\n\n` +
    `| Pair | System | Status | Fresh | Cached | Output | Fresh + output | End-to-end | Acceptance |\n` +
    `|---:|---|---|---:|---:|---:|---:|---:|---:|\n` +
    `${runRows.join('\n')}\n\n` +
    `## Interpretation\n\n` +
    `RAW Codex receives the ordinary autonomous task and operates the repository itself. Lattice indexes the repository first, supplies bounded task-relevant context, and accepts a structured patch. This compares two execution systems around the same model; it is not an isolated model benchmark. Cached input remains context traffic but is accounted for separately, so the primary expensive-traffic metric is fresh input plus output.\n`;
}

mkdirSync(outputDirectory, { recursive: true });
const runs = [];
let abortedAfterInfrastructureFailure = null;
benchmarkLoop:
for (let repetition = 1; repetition <= repetitions; repetition += 1) {
  const systems = repetition % 2 === 1
    ? [runRawCodex, runLattice]
    : [runLattice, runRawCodex];
  for (const runSystem of systems) {
    const label = runSystem === runRawCodex ? 'RAW Codex' : 'Lattice';
    process.stdout.write(`[${new Date().toISOString()}] start ${label}, repetition ${repetition}\n`);
    const result = await runSystem(repetition);
    runs.push(result);
    process.stdout.write(
      `[${new Date().toISOString()}] finish ${label}, repetition ${repetition}: ${result.status}, fresh=${result.usage?.freshInputTokens ?? 'n/a'}, output=${result.usage?.outputTokens ?? 'n/a'}, elapsed=${result.elapsedMs}ms\n`,
    );
    if (isBenchmarkInfrastructureFailure(result) && !result.usage) {
      abortedAfterInfrastructureFailure = {
        repetition,
        system: result.system,
        failureClass: result.failureClass,
        error: result.error,
      };
      process.stderr.write(
        `Benchmark stopped after ${result.failureClass}; the paired result would be invalid and continuing could waste quota.\n`,
      );
      break benchmarkLoop;
    }
  }
}

const rawRuns = runs.filter((run) => run.system === 'raw_codex');
const latticeRuns = runs.filter((run) => run.system === 'lattice');
const rawAggregate = aggregate(rawRuns);
const latticeAggregate = aggregate(latticeRuns);
const expectedRunCount = repetitions * 2;
const validity = {
  valid: runs.length === expectedRunCount && !runs.some(isBenchmarkInfrastructureFailure),
  complete: runs.length === expectedRunCount,
  expectedRunCount,
  observedRunCount: runs.length,
  reason: abortedAfterInfrastructureFailure
    ? `${abortedAfterInfrastructureFailure.failureClass}: ${abortedAfterInfrastructureFailure.error}`
    : runs.some(isBenchmarkInfrastructureFailure)
      ? 'one or more arms ended with an infrastructure failure'
      : runs.length !== expectedRunCount
        ? 'the requested paired run set is incomplete'
        : null,
};
const artifact = {
  schemaVersion: 1,
  benchmark: 'raw-codex-vs-lattice-reset-token',
  createdAt: new Date().toISOString(),
  controls: {
    repetitions,
    alternatingOrder: true,
    model,
    reasoningEffort,
    goal,
    goalCharacters: goal.length,
    fixture,
    fixedGitDate,
    rawCodex: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      latticeMcpEnabled: false,
    },
    lattice: {
      sandboxMode: 'read-only provider; isolated transactional worktree',
      modelPolicy: 'inherit',
      verifiedPatchCache: false,
    },
    independentVerification: 'fresh directory, pristine package/tests, candidate src only',
  },
  baselineCommits: [...new Set(runs.map((run) => run.baselineCommit))],
  runs,
  validity,
  abortedAfterInfrastructureFailure,
  aggregates: {
    rawCodex: rawAggregate,
    lattice: latticeAggregate,
  },
  comparison: comparison(rawAggregate, latticeAggregate),
};

writeFileSync(jsonOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
writeFileSync(reportOutputPath, buildReport(artifact), 'utf8');
process.stdout.write(`${JSON.stringify({
  jsonOutputPath,
  reportOutputPath,
  validity: artifact.validity,
  aggregates: artifact.aggregates,
  comparison: artifact.comparison,
})}\n`);
if (!validity.valid) process.exitCode = 1;
