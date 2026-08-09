# Paired live benchmark

This directory contains the public driver for the RAW Codex versus Lattice
reset-token comparison. It is evaluation infrastructure, not a product demo:
both arms make a live model call and the result can vary with the model,
provider, account, cache state, and service load.

The published 2026-07-31 owner-run result is documented in
[`docs/evidence/owner-run-gpt-5.6-luna.md`](../docs/evidence/owner-run-gpt-5.6-luna.md).

## Safety gate

The driver refuses to make a model call unless `--confirm-live` is present. The
default is one pair: one RAW Codex arm and one Lattice arm. Each arm starts with
one provider turn, but retries, context faults, or protocol repairs can add
turns. `BENCH_REPETITIONS` accepts integers from 1 through 10.

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
