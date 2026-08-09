# Community-run Claude Opus 5 paired result

Date: 2026-08-09

Classification: **one community-run paired smoke test** on the maintainer's
public reset-token fixture. The operator ran the published driver on a separate
machine. This is a community reproduction, not independent task selection and
not a universal efficiency claim.

## Result

| Metric | RAW Claude Code | Lattice | Lattice reduction |
| --- | ---: | ---: | ---: |
| Fresh input | 19,251 | 3,282 | 82.95% |
| Output | 1,769 | 619 | 65.01% |
| **Fresh input + output** | **21,020** | **3,901** | **81.44%** |
| Cached input | 85,949 | 0 | 100.00% |
| Total input, including cached | 105,200 | 3,282 | 96.88% |
| **Provider-reported cost** | **$0.2802955** | **$0.0482850** | **82.77%** |
| Model execution time | 35.242 s | 8.710 s | 75.29% |
| **End-to-end elapsed time** | **46.624 s** | **13.598 s** | **70.83%** |

Both arms ended with status `passed`. In this driver, that requires the
independent pristine-test verification command to exit successfully. The
legacy report parser did not extract the individual TAP counts, so this record
does **not** claim `4/4` or byte-identical patches. The parser is corrected for
future runs; this historical record remains unchanged.

Machine-readable sanitized data:
[`community-run-claude-opus-5.json`](community-run-claude-opus-5.json).

## Controls

- Model: `claude-opus-5`
- Effort: `high`
- Maximum SDK budget: $1 per arm
- One RAW Claude Code run and one Lattice run
- Same fixed task and fresh repository per arm
- RAW used a strict empty MCP configuration
- Lattice verified-patch reuse disabled
- Independent verification used pristine fixture tests
- Provider-reported usage and cost
- No failure or excluded run in the shared result

## Task

Fixture: [`fixtures/reset-token`](../../fixtures/reset-token)

> Fix reset token behavior: consume a valid token once, reject a second
> consumption and expired tokens, record a password-reset audit event, and
> preserve login behavior.

## Reproduce or challenge

Run the public driver from a source checkout with your own authenticated Claude
environment:

```sh
BENCH_MODEL=claude-opus-5 \
BENCH_REASONING_EFFORT=high \
BENCH_MAX_BUDGET_USD=1 \
npm run benchmark:claude -- --confirm-live
```

On PowerShell, assign the same values through `$env:` variables. Raw artifacts
remain under the ignored `.lattice/evaluation/` directory and may contain local
paths or provider session identifiers; sanitize them before sharing.

This record establishes one observed cross-provider result. It does not prove
non-inferiority across a task population, remove the need to publish failures,
or guarantee the same savings under different models, caches, tasks, or load.
