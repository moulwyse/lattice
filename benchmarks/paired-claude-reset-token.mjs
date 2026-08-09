import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { benchmarkNetworkPreflightError } from '../dist/benchmark-failure.js';
import {
  formatAcceptance,
  parseNodeTestCounts,
} from '../dist/benchmark-output.js';
import { removeDirectoryWithRetry } from '../dist/cleanup.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = dirname(scriptDirectory);
const cliPath = join(projectDirectory, 'dist', 'cli.js');
const fixture = join(projectDirectory, 'fixtures', 'reset-token');
const outputDirectory = resolve(
  process.env.BENCH_OUTPUT_DIRECTORY ?? join(projectDirectory, '.lattice', 'evaluation'),
);
const model = process.env.BENCH_MODEL ?? 'claude-opus-5';
const reasoningEffort = process.env.BENCH_REASONING_EFFORT ?? 'high';
const maxBudgetUsd = Number.parseFloat(process.env.BENCH_MAX_BUDGET_USD ?? '1');
const outputTag = model.replace(/[^a-zA-Z0-9._-]+/g, '-');
const jsonOutputPath = join(
  outputDirectory,
  `raw-claude-vs-lattice-${outputTag}-live-summary.json`,
);
const reportOutputPath = join(
  outputDirectory,
  `raw-claude-vs-lattice-${outputTag}-live-report.md`,
);
const goal =
  'Fix reset token behavior: consume a valid token once, reject a second consumption and expired tokens, record a password-reset audit event, and preserve login behavior.';
const fixedGitDate = '2000-01-01T00:00:00Z';

if (!process.argv.includes('--confirm-live')) {
  process.stderr.write(
    'This benchmark runs one paid RAW Claude Code arm and one paid Lattice arm.\n' +
      'Review benchmarks/README.md, set the model and budget, then rerun with --confirm-live.\n',
  );
  process.exit(2);
}
if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
  throw new Error('BENCH_MAX_BUDGET_USD must be a positive finite number');
}

const networkPreflightError = benchmarkNetworkPreflightError();
if (networkPreflightError) {
  process.stderr.write(`${networkPreflightError}. No benchmark arm was started.\n`);
  process.exit(2);
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

async function createWorkspace(system) {
  const prefix = `raw-vs-lattice-claude-${system}-`;
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
  await command(workspace, 'git', ['config', 'user.name', 'Claude Benchmark']);
  await command(workspace, 'git', ['config', 'core.autocrlf', 'false']);
  await command(workspace, 'git', ['add', '.']);
  const commit = await command(
    workspace,
    'git',
    ['commit', '-m', 'reset-token baseline'],
    { env: gitEnvironment },
  );
  if (commit.exitCode !== 0) throw new Error(`failed to create baseline: ${commit.stderr}`);
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

async function independentlyVerify(sourceWorkspace, system) {
  const prefix = `raw-vs-lattice-claude-verify-${system}-`;
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

function rawClaudeUsage(result) {
  const usage = result?.usage;
  if (!usage) return null;
  const directInput = usage.input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
  const freshInputTokens = directInput + cacheCreation;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens: freshInputTokens + cachedInputTokens,
    cachedInputTokens,
    freshInputTokens,
    outputTokens,
    reasoningTokens: 0,
    freshPlusOutputTokens: freshInputTokens + outputTokens,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
  };
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
    costUsd: telemetry.costUsd ?? null,
  };
}

async function gitEvidence(workspace) {
  const diff = await command(workspace, 'git', ['diff', '--no-ext-diff', '--binary']);
  const changed = await command(workspace, 'git', ['diff', '--name-only']);
  const status = await command(workspace, 'git', ['status', '--short']);
  return {
    unifiedDiff: diff.stdout,
    changedFiles: changed.stdout.split(/\r?\n/).filter(Boolean),
    gitStatus: status.stdout,
  };
}

function parseJsonOutput(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

async function runRawClaude() {
  const setup = await createWorkspace('raw');
  const { workspace } = setup;
  const started = Date.now();
  try {
    const prompt = `${goal}\n\nWork only inside the current repository. Do not use network access. Implement the fix and run npm test.`;
    const result = await command(
      workspace,
      process.execPath,
      [
        cliPath,
        'claude',
        '--raw',
        '--safe-mode',
        '--no-chrome',
        '--disable-slash-commands',
        '--permission-mode',
        'bypassPermissions',
        '--disallowedTools',
        'WebSearch',
        'WebFetch',
        '-p',
        prompt,
        '--model',
        model,
        '--effort',
        reasoningEffort,
        '--max-budget-usd',
        String(maxBudgetUsd),
        '--output-format',
        'json',
        '--no-session-persistence',
      ],
      { timeout: 240_000 },
    );
    const parsed = parseJsonOutput(result.stdout, 'RAW Claude Code');
    const verification = await independentlyVerify(workspace, 'raw');
    const evidence = await gitEvidence(workspace);
    return {
      schemaVersion: 1,
      system: 'raw_claude',
      status: verification.status,
      baselineCommit: setup.commit,
      baseline: setup.baseline,
      usage: rawClaudeUsage(parsed),
      providerTurns: parsed.num_turns ?? null,
      modelElapsedMs: parsed.duration_api_ms ?? null,
      elapsedMs: Date.now() - started,
      sessionId: parsed.session_id ?? null,
      providerSubtype: parsed.subtype ?? null,
      permissionDenials: parsed.permission_denials ?? [],
      finalResponse: parsed.result ?? null,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ...evidence,
      independentVerification: verification,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      system: 'raw_claude',
      status: 'failed',
      baselineCommit: setup.commit,
      baseline: setup.baseline,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    assertTemporaryDirectory(workspace, 'raw-vs-lattice-claude-raw-');
    await removeDirectoryWithRetry(workspace);
  }
}

async function removeRetainedWorktree(workspace, worktree) {
  assertNestedWorktree(workspace, worktree);
  await command(workspace, 'git', ['worktree', 'remove', '--force', worktree]);
  await removeDirectoryWithRetry(worktree);
  await command(workspace, 'git', ['worktree', 'prune']);
}

async function runLatticeClaude() {
  const setup = await createWorkspace('lattice');
  const { workspace } = setup;
  const started = Date.now();
  let retainedWorktree;
  try {
    const resultProcess = await command(
      workspace,
      process.execPath,
      [
        cliPath,
        'run',
        goal,
        '--worker',
        'claude',
        '--workspace',
        '.',
        '--model',
        model,
        '--reasoning-effort',
        reasoningEffort,
        '--max-budget-usd',
        String(maxBudgetUsd),
        '--no-verified-cache',
        '--retain-worktree',
        '--json',
      ],
      { timeout: 240_000 },
    );
    const result = parseJsonOutput(resultProcess.stdout, 'Lattice Claude');
    retainedWorktree = result.transaction?.worktree;
    const verification = retainedWorktree
      ? await independentlyVerify(retainedWorktree, 'lattice')
      : {
          status: 'failed',
          exitCode: null,
          elapsedMs: null,
          counts: { tests: null, passed: null, failed: null },
          stdout: '',
          stderr: 'Lattice produced no retained transaction worktree',
          pristineTests: true,
        };
    const evidence = retainedWorktree
      ? await gitEvidence(retainedWorktree)
      : { unifiedDiff: '', changedFiles: [], gitStatus: '' };
    return {
      schemaVersion: 1,
      system: 'lattice',
      status: result.status === 'passed' && verification.status === 'passed'
        ? 'passed'
        : 'failed',
      baselineCommit: setup.commit,
      baseline: setup.baseline,
      usage: latticeUsage(result.telemetry),
      providerTurns: result.telemetry?.workerTurns ?? null,
      modelElapsedMs: result.telemetry?.stageMs?.worker ?? null,
      elapsedMs: Date.now() - started,
      sessionId: result.threadId ?? result.sessionId ?? null,
      internalStatus: result.status,
      failureStage: result.failureStage ?? null,
      error: result.error ?? null,
      stderr: resultProcess.stderr,
      exitCode: resultProcess.exitCode,
      promptManifests: result.telemetry?.promptManifests ?? [],
      protocolRepairTurns: result.telemetry?.protocolRepairTurns ?? null,
      pageFaults: result.telemetry?.pageFaults ?? null,
      ...evidence,
      independentVerification: verification,
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      system: 'lattice',
      status: 'failed',
      baselineCommit: setup.commit,
      baseline: setup.baseline,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (retainedWorktree) await removeRetainedWorktree(workspace, retainedWorktree);
    assertTemporaryDirectory(workspace, 'raw-vs-lattice-claude-lattice-');
    await removeDirectoryWithRetry(workspace);
  }
}

function savingPercent(rawValue, latticeValue) {
  if (!Number.isFinite(rawValue) || !Number.isFinite(latticeValue) || rawValue === 0) return null;
  return ((rawValue - latticeValue) / rawValue) * 100;
}

function comparison(raw, lattice) {
  const compare = (field) => ({
    raw: raw.usage?.[field] ?? null,
    lattice: lattice.usage?.[field] ?? null,
    latticeSavingPercent: savingPercent(raw.usage?.[field], lattice.usage?.[field]),
  });
  return {
    inputTokens: compare('inputTokens'),
    cachedInputTokens: compare('cachedInputTokens'),
    freshInputTokens: compare('freshInputTokens'),
    outputTokens: compare('outputTokens'),
    freshPlusOutputTokens: compare('freshPlusOutputTokens'),
    costUsd: compare('costUsd'),
    modelElapsedMs: {
      raw: raw.modelElapsedMs ?? null,
      lattice: lattice.modelElapsedMs ?? null,
      latticeSavingPercent: savingPercent(raw.modelElapsedMs, lattice.modelElapsedMs),
    },
    elapsedMs: {
      raw: raw.elapsedMs ?? null,
      lattice: lattice.elapsedMs ?? null,
      latticeSavingPercent: savingPercent(raw.elapsedMs, lattice.elapsedMs),
    },
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
  const raw = artifact.runs.find((run) => run.system === 'raw_claude');
  const lattice = artifact.runs.find((run) => run.system === 'lattice');
  const row = (label, field, digits = 0, unit = '') =>
    `| ${label} | ${number(raw.usage?.[field], digits)}${unit} | ${number(lattice.usage?.[field], digits)}${unit} | ${percent(artifact.comparison[field]?.latticeSavingPercent)} |`;
  return `# RAW Claude Code vs Lattice - live benchmark\n\n` +
    `Created: ${artifact.createdAt}\n\n` +
    `Controls: model \`${model}\`, effort \`${reasoningEffort}\`, max budget $${maxBudgetUsd} per arm, one fixed task, fresh repositories, strict empty MCP configuration, no verified-patch reuse, and independent pristine acceptance tests.\n\n` +
    `| Result | RAW Claude Code | Lattice | Lattice reduction |\n` +
    `|---|---:|---:|---:|\n` +
    `${row('Fresh input', 'freshInputTokens')}\n` +
    `${row('Cached input', 'cachedInputTokens')}\n` +
    `${row('Output', 'outputTokens')}\n` +
    `${row('Fresh input + output', 'freshPlusOutputTokens')}\n` +
    `${row('Provider cost', 'costUsd', 4, ' USD')}\n` +
    `| Model execution time | ${number(raw.modelElapsedMs)} ms | ${number(lattice.modelElapsedMs)} ms | ${percent(artifact.comparison.modelElapsedMs.latticeSavingPercent)} |\n` +
    `| End-to-end time | ${number(raw.elapsedMs)} ms | ${number(lattice.elapsedMs)} ms | ${percent(artifact.comparison.elapsedMs.latticeSavingPercent)} |\n` +
    `| Acceptance | ${formatAcceptance(raw.independentVerification)} | ${formatAcceptance(lattice.independentVerification)} | — |\n\n` +
    `RAW status: **${raw.status}**. Lattice status: **${lattice.status}**. Publish both failures and successes.\n`;
}

mkdirSync(outputDirectory, { recursive: true });
const runs = [];
for (const [label, runner] of [
  ['RAW Claude Code', runRawClaude],
  ['Lattice Claude', runLatticeClaude],
]) {
  process.stdout.write(`[${new Date().toISOString()}] start ${label}\n`);
  const result = await runner();
  runs.push(result);
  process.stdout.write(
    `[${new Date().toISOString()}] finish ${label}: ${result.status}, fresh=${result.usage?.freshInputTokens ?? 'n/a'}, output=${result.usage?.outputTokens ?? 'n/a'}, elapsed=${result.elapsedMs}ms\n`,
  );
}

const raw = runs.find((run) => run.system === 'raw_claude');
const lattice = runs.find((run) => run.system === 'lattice');
const artifact = {
  schemaVersion: 1,
  benchmark: 'raw-claude-code-vs-lattice-reset-token',
  createdAt: new Date().toISOString(),
  controls: {
    model,
    reasoningEffort,
    maxBudgetUsdPerArm: maxBudgetUsd,
    goal,
    fixture,
    fixedGitDate,
    rawClaude: {
      safeMode: true,
      permissionMode: 'bypassPermissions in generated temporary fixture only',
      latticeMcpEnabled: false,
      webToolsEnabled: false,
      sessionPersistence: false,
    },
    lattice: {
      providerTools: [],
      strictMcpConfig: true,
      verifiedPatchCache: false,
      isolatedTransactionalWorktree: true,
    },
    independentVerification: 'fresh directory, pristine package/tests, candidate src only',
  },
  baselineCommits: [...new Set(runs.map((run) => run.baselineCommit))],
  runs,
  comparison: comparison(raw, lattice),
};

writeFileSync(jsonOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
writeFileSync(reportOutputPath, buildReport(artifact), 'utf8');
process.stdout.write(`${JSON.stringify({ jsonOutputPath, reportOutputPath, comparison: artifact.comparison })}\n`);
