# Owner-run GPT-5.6 Luna paired result

Date: 2026-07-31

Classification: **one owner-run paired smoke test**. This is public evidence of
one observed result, not independent validation and not a universal efficiency
claim.

## Claim under test

Can the same coding model solve the same repository task with the same verified
outcome when Lattice performs deterministic repository operations outside the
model loop and supplies bounded task-relevant context?

## Result

| Metric | RAW Codex | Lattice | Lattice reduction |
| --- | ---: | ---: | ---: |
| Fresh input | 70,686 | 9,936 | 85.94% |
| Output | 2,708 | 605 | 77.66% |
| **Fresh input + output** | **73,394** | **10,541** | **85.64%** |
| Cached input | 342,016 | 40,192 | 88.25% |
| Total input, including cached | 412,702 | 50,128 | 87.85% |
| Reasoning output | 742 | 198 | 73.32% |
| Model execution time | 100.142 s | 18.641 s | 81.39% |
| **End-to-end elapsed time** | **100.768 s** | **22.296 s** | **77.87%** |

Both candidates passed 4/4 pristine acceptance tests and produced a
byte-identical patch.

Machine-readable sanitized data:
[`owner-run-gpt-5.6-luna.json`](owner-run-gpt-5.6-luna.json).

## Task and fixture

Fixture: [`fixtures/reset-token`](../../fixtures/reset-token)

Task given to both arms:

> Fix reset token behavior: consume a valid token once, reject a second
> consumption and expired tokens, record a password-reset audit event, and
> preserve login behavior.

The untouched baseline passed 2/4 tests. The task was therefore not already
solved. Both candidates changed the same two files:

- `src/auth/service.js`
- `src/auth/token-repository.js`

## Paired controls

- Model: `gpt-5.6-luna`
- Reasoning effort: `medium`
- Repetitions: one RAW run and one Lattice run
- Same task and deterministic fixture
- Same baseline Git commit
- Fresh temporary repository for each arm
- Agent tool network access disabled
- Web search disabled
- RAW arm started with the Lattice MCP server disabled
- Lattice model policy set to inherit the declared model
- Lattice verified-patch reuse disabled
- One provider turn in each arm
- No model reroute detected in either recorded session
- Independent verification in a separate clean directory using pristine tests
- No failed, retried, or excluded run in this one-pair record

## Usage accounting

Usage comes from provider-reported metadata for the complete model turn in each
arm.

```text
fresh input = input tokens - cached input tokens
primary traffic = fresh input + output tokens
```

The SDK-reported reasoning-output field is shown separately. Tool activity
inside the provider turn is included only to the extent that the provider
includes it in its usage counters; no character-based token estimate is used.

End-to-end time starts immediately before the execution system runs and ends
after the candidate is independently verified. It excludes temporary fixture
creation and the initial baseline test. Local indexing and verification time
are therefore included in the Lattice number rather than hidden.

## Acceptance and patch identity

| Check | RAW Codex | Lattice |
| --- | ---: | ---: |
| Baseline before editing | 2/4 | 2/4 |
| Pristine tests after editing | 4/4 | 4/4 |
| Changed files | 2 | 2 |
| Patch SHA-256 | `ab85bad70e46d638503b96fcf885f28f1d2c3aca8f19e883c06fa28621d9b616` | Same |

Patch identity is stronger than required for task success; independently
correct patches can differ. It is reported here because it occurred in this
pair, not because future evaluations must require it.

## Reproduce or challenge the result

The exact public paired driver is in
[`benchmarks/paired-reset-token.mjs`](../../benchmarks/paired-reset-token.mjs),
with spend safeguards and operating instructions in
[`benchmarks/README.md`](../../benchmarks/README.md).

The driver runs two live arms per repetition and refuses to run without an
explicit `--confirm-live`. Each arm starts with one provider turn; retries,
context faults, or repairs can add turns. It writes full local artifacts under
the ignored `.lattice/evaluation/` directory. Do not publish those raw
artifacts without a privacy and secret review.

Different provider versions, model availability, caches, service load, and
hardware can produce different numbers. A contradictory rerun is useful
evidence and should not be discarded.

## What this proves

- The recorded pair completed the same fixed task successfully in both arms.
- Under the recorded conditions, Lattice used 85.64% less fresh input plus
  output and completed 77.87% faster end to end.
- The observed reduction did not come from a different accepted patch or a
  lower declared reasoning setting.

## What this does not prove

- that the same reduction holds for other tasks, repositories, models, or
  providers;
- that Lattice is non-inferior across a task population;
- that the result has been independently reproduced;
- that local compute, disk, or memory costs are zero;
- that byte-identical output is necessary for quality;
- that one pair supplies a confidence interval or stable average.

For a broader evaluation, use the preregistered paired methodology in
[`docs/evaluation.md`](../evaluation.md) and publish every attempted run,
including failures.
