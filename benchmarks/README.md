# Paired live benchmark

This directory contains the public driver for the RAW Codex versus Lattice
reset-token comparison. It is evaluation infrastructure, not a product demo:
both arms make a live model call and the result can vary with the model,
provider, account, cache state, and service load.

Published one-pair records are documented for
[GPT-5.6 Luna](../docs/evidence/owner-run-gpt-5.6-luna.md),
[GPT-5.6 Sol](../docs/evidence/owner-run-gpt-5.6-sol.md), and a
[community-run Claude Opus 5 reproduction](../docs/evidence/community-run-claude-opus-5.md).
They are task-specific smoke tests, not population-level claims.

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
- RAW Codex has the Lattice MCP server disabled;
- model tool network access and web search are disabled;
- Lattice uses the same model and reasoning setting;
- verified-patch reuse is disabled;
- run order alternates across repeated pairs;
- each candidate is copied into a separate clean directory and checked against
  pristine acceptance tests;
- full provider-reported input, cached input, output, and reasoning usage is
  recorded when available;
- every temporary directory is checked before cleanup.

The driver does not create an independent evaluation. For a credible broader
claim, use evaluator-selected tasks and the protocol in
[`docs/evaluation.md`](../docs/evaluation.md).
