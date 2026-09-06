# Paired live benchmark

For a **local-only performance comparison with zero model calls**, see
[Local index/context performance](#local-indexcontext-performance) below.

This directory contains the public driver for the RAW Codex versus Lattice
reset-token comparison. It is evaluation infrastructure, not a product demo:
both arms make a live model call and the result can vary with the model,
provider, account, cache state, and service load.

Published one-pair records are documented for
[GPT-6 Astra / medium](../docs/evidence/owner-run-gpt-6-astra.md),
[GPT-5.6 Luna](../docs/evidence/owner-run-gpt-5.6-luna.md),
[GPT-5.6 Sol](../docs/evidence/owner-run-gpt-5.6-sol.md), and a
[community-run Claude Opus 5 reproduction](../docs/evidence/community-run-claude-opus-5.md).
They are task-specific smoke tests, not population-level claims.

For one **GPT-6 Astra / medium** pair on Windows, double-click
`START-ASTRA-BENCHMARK.cmd` in the repository root. Doing so explicitly starts a
live, quota-consuming pair using your existing Codex login. The launcher keeps
the console open and saves timestamped results under `.lattice/evaluation/`.
It does not upload anything or initiate a login. From an ordinary terminal on
any supported platform, the equivalent is:

```sh
npm run benchmark:astra -- --confirm-live
```

The launcher fixes repetitions to one, uses the same paired driver, and only
prints a savings headline when both arms pass and the comparison is valid.

## Safety gate

The driver refuses to make a model call unless `--confirm-live` is present. The
default is one pair: one RAW Codex arm and one Lattice arm. Each arm starts with
one provider turn, but retries, context faults, or protocol repairs can add
turns. `BENCH_REPETITIONS` accepts integers from 1 through 10.

Transport, authentication, configuration, and timeout failures are classified
as infrastructure failures. If one happens before provider usage is returned,
the driver stops immediately, writes an invalid-sample artifact, exits nonzero,
and does not spend quota attempting the remaining arm. Such an artifact is a
diagnostic record, not a token or latency benchmark.

Raw artifacts can contain provider session identifiers, absolute temporary
paths, model output, and complete diffs. They are written only to the ignored
`.lattice/evaluation/` directory unless `BENCH_OUTPUT_DIRECTORY` is explicitly
changed. Review and sanitize them before publication.

## Run one pair

Prerequisites:

- the repository dependencies are installed with `npm ci`;
- Git is available;
- Codex is installed and authenticated;
- the selected model is available to the authenticated account.
- the command can reach the model provider. Run it from a normal terminal, or
  use **Full access** when intentionally launching it from a Codex task. A
  network-restricted Codex task sets `CODEX_SANDBOX_NETWORK_DISABLED`; the
  driver detects that marker and exits before starting either paid arm.

PowerShell:

```powershell
$env:BENCH_MODEL = 'gpt-5.6-luna'
$env:BENCH_REASONING_EFFORT = 'medium'
$env:BENCH_REPETITIONS = '1'
npm run benchmark:paired -- --confirm-live
```

macOS or Linux:

```sh
BENCH_MODEL=gpt-5.6-luna \
BENCH_REASONING_EFFORT=medium \
BENCH_REPETITIONS=1 \
npm run benchmark:paired -- --confirm-live
```

If that exact model identifier is unavailable, select an available model and
publish the new identifier with the result. Do not label a run with a model it
did not use.

## Run one Claude Code Beta pair

This command creates two fresh temporary copies of the bundled reset-token
fixture and runs RAW Claude Code against Lattice Claude. It does not run either
arm from the Lattice source repository. RAW receives bypass permissions only
inside its generated temporary fixture so the non-interactive agent can edit
and verify its candidate; web tools, customizations, MCP servers, and session
persistence are disabled.

PowerShell:

```powershell
$env:BENCH_MODEL = 'claude-opus-5'
$env:BENCH_REASONING_EFFORT = 'high'
$env:BENCH_MAX_BUDGET_USD = '1'
npm run benchmark:claude -- --confirm-live
```

macOS or Linux:

```sh
BENCH_MODEL=claude-opus-5 \
BENCH_REASONING_EFFORT=high \
BENCH_MAX_BUDGET_USD=1 \
npm run benchmark:claude -- --confirm-live
```

The driver saves both raw results, full diffs, provider-reported usage and
cost, timing, permission denials, and pristine acceptance output under the
ignored `.lattice/evaluation/` directory. Review those artifacts before
sharing them because they can contain local paths and provider session IDs.
Current drivers parse both `# tests` and Node's `ℹ tests` TAP summaries. When a
legacy or unfamiliar reporter omits parseable counts, the report preserves the
verification process status as `passed (count unavailable)` rather than
printing the misleading `n/a/n/a`.

## Controls implemented by the driver

- the same task and bundled fixture are used by both arms;
- each arm starts in a fresh temporary Git repository;
- the fixed Git author and commit date produce the same baseline commit;
- both Codex arms override the MCP table to empty and disable global hooks and
  plugins for that client only (ordinary Lattice/Codex sessions are unchanged);
- model tool network access and web search are disabled;
- Lattice uses the same model and reasoning setting;
- verified-patch reuse is disabled;
- run order alternates across repeated pairs;
- each candidate is copied into a separate clean directory and checked against
  pristine acceptance tests;
- full provider-reported input, cached input, output, and reasoning usage is
  recorded when available;
- every temporary directory is checked before cleanup.

The Codex driver writes an atomic `*-checkpoint.json` for each arm **before**
removing any temporary directory, then updates it with cleanup diagnostics.
If Windows keeps a directory locked (`EBUSY`), bounded retries are attempted;
the original model result/error and any returned usage remain in the checkpoint.
Verification directories and retained worktrees are cleaned only after that
checkpoint (the worktrees live inside the disposable fixture repository).
Cleanup failure stops further arms and marks the comparison invalid. No process
is force-killed, and the driver never modifies global hooks or credentials.
Infrastructure failures and failed arms without usage also stop further spending.
An invalid run has no publishable savings percentage; inspect its JSON/report,
resolve the underlying error, then rerun from a normal terminal. An interrupted
cleanup leaves a checkpoint with `cleanup.status: "pending"` and its paths.
Reported arm elapsed time includes execution and acceptance/result collection,
but excludes fixture setup, checkpoint writes, and temporary-directory cleanup.
Each Codex arm also has its own SQLite runtime-state directory under the output
directory. It does not reuse the desktop app's live state database. Authentication
remains in the normal Codex credential store; credentials are not copied into
benchmark outputs.

The driver does not create an independent evaluation. For a credible broader
claim, use evaluator-selected tasks and the protocol in
[`docs/evaluation.md`](../docs/evaluation.md).

## Local index/context performance

This separate driver measures repository indexing and initial context selection,
not model execution. It needs Node.js, Git, installed dependencies, and two
compiled builds. It does not require provider authentication or call a model.

Before changing source code, save the baseline build inside the ignored local
state directory (PowerShell):

```powershell
npm run build
New-Item -ItemType Directory -Path .lattice/perf-baseline -ErrorAction Stop
Copy-Item -LiteralPath dist -Destination .lattice/perf-baseline/dist -Recurse
```

After making the source changes, rebuild and compare:

```powershell
npm run build
node benchmarks/local-index-performance.mjs --baseline-dist .lattice/perf-baseline/dist --pairs 3 --output .lattice/local-performance.json
```

Use a fresh baseline directory; do not overwrite an earlier baseline. Keep both
builds in an environment where their dependencies resolve, and record the
baseline revision and dependency versions. This example uses the current
checkout's dependencies for both builds, isolating the source-code comparison.

Each arm indexes an isolated clone of the same generated repository: 64
JavaScript modules with 80 exports each, plus a package manifest. Run order
alternates across pairs. Full file records, fingerprints, scripts, and the exact
eight selected context pages must match, or the command fails. The report
contains every timing sample and paired reductions. Temporary fixture repos
are removed on completion.

Run without concurrent builds/tests for less noisy timing. This is one synthetic
workload with warm OS caches, not a cold-cache or repository-scale guarantee.
An indexing speedup is **not** a measurement of token/cost savings, model quality,
or end-to-end coding speed. Use the spend-gated paired live drivers separately
to measure those outcomes.
