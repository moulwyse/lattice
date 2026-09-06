# GPT-6 Astra / medium: owner-run paired evidence

Date: 2026-09-06. One local RAW-first pair on the public reset-token fixture.
This is a maintainer-operated result, not independent evaluation.

## Result

| Metric | RAW Codex | Lattice | Reduction |
| --- | ---: | ---: | ---: |
| Fresh input | 16,100 | 3,751 | 76.70% |
| Output | 772 | 254 | 67.10% |
| Fresh input + output | 16,872 | 4,005 | **76.26%** |
| Cached input | 52,736 | 12,160 | 76.94% |
| Total input including cache | 68,836 | 15,911 | 76.89% |
| Model execution | 69.289 s | 23.359 s | 66.29% |
| Arm elapsed | 70.218 s | 26.969 s | **61.59%** |
| Pristine acceptance | 4/4 | 4/4 | Not applicable |

Arm elapsed includes execution and acceptance/result collection, but excludes
fixture setup, checkpoint writes and cleanup. Token savings are not measured
dollar savings; provider cost was not measured. Cached input is reported
separately and is not silently counted as fresh input.

## Controls

- Exact requested model: `gpt-6-astra`; reasoning effort: `medium`.
- Codex SDK and bundled CLI: `0.153.4`; Windows; Node.js 24.19.0.
- One RAW arm followed by one Lattice arm; one provider turn each.
- Task: consume a valid reset token once, reject reuse and expired tokens,
  record a password-reset audit event, and preserve login behavior.
- Fixture: [fixtures/reset-token](../../fixtures/reset-token).
- Both baseline commits: `d397dc435b42f0ed76336154f72d50a9b0afb5b6`.
- Hooks and plugins disabled for both benchmark clients, MCP table empty,
  independent SQLite state directory per arm. Normal user sessions are unchanged.
- No verified-patch cache reuse; zero Lattice context faults and protocol repairs.
- Independent pristine directories used the original tests and candidate source.
- Both arms passed; both cleanups completed; the pair was recorded as valid.

## Patch and acceptance checks

Both source-only unified diffs matched after extracting the `src/` sections
and trimming surrounding whitespace. SHA-256:
`bf74f4be21cc86186d5ae8e425502cd0c551b8398030024ee42b78a5c603453a`.

**Full patches are not identical.** RAW additionally added an audit-rejection
test. Lattice changed only the two source files. Neither candidate's modified
tests were used to decide pristine acceptance.

Original acceptance tests: valid token consumed once; expired token rejected;
successful reset recorded in audit; existing login unchanged.

## Reproduce

From a checkout of this release, install dependencies with `npm ci`.
An authenticated Codex account with access to the requested model is required.

```sh
npm run benchmark:astra -- --confirm-live
```

This explicitly spends model quota on one pair. Results remain under ignored
`.lattice/evaluation/`. The driver saves each arm before cleanup and suppresses
savings claims for incomplete or infrastructure-invalid comparisons.

## Limitations and publication boundary

One fixed fixture, one RAW-first pair, no confidence interval and no independent
task selection. The fixture is public and maintainer-authored; this is a smoke
test, not proof of quality parity or generalized savings. Earlier client/startup
failures had no complete accepted usage pair and are not converted into savings.
They are not included in the percentage above.

Only [allowlisted metrics](owner-run-gpt-6-astra.json) and reviewed narrative
are published. Private provider sessions, account configuration, absolute local
paths and unreviewed logs remain excluded. This sanitized record is not a full
independently audited provider transcript.
