# Owner-run GPT-5.6 Sol paired result

Date: 2026-08-09

Classification: **one owner-run paired smoke test** on the public reset-token
fixture. It is not independent validation and not a universal efficiency claim.

## Result

| Metric | RAW Codex | Lattice | Lattice reduction |
| --- | ---: | ---: | ---: |
| Fresh input | 23,741 | 9,978 | 57.97% |
| Output | 1,244 | 577 | 53.62% |
| **Fresh input + output** | **24,985** | **10,555** | **57.75%** |
| Cached input | 111,872 | 46,336 | 58.58% |
| Total input, including cached | 135,613 | 56,314 | 58.47% |
| Reasoning output | 181 | 187 | -3.31% |
| Model execution time | 62.791 s | 26.369 s | 58.01% |
| **End-to-end elapsed time** | **63.409 s** | **30.658 s** | **51.65%** |

Both candidates passed 4/4 pristine acceptance tests. They changed the same
two files from the same baseline. The patches were **not byte-identical**: RAW
included one additional blank line in `src/auth/service.js`; the executable
changes matched.

Machine-readable sanitized data:
[`owner-run-gpt-5.6-sol.json`](owner-run-gpt-5.6-sol.json).

## Controls

- Model: `gpt-5.6-sol`
- Reasoning effort: `medium`
- One RAW run and one Lattice run
- Same task, fixture, baseline commit, and fresh repository per arm
- RAW Lattice MCP table replaced with an empty table
- Agent tool network and web search disabled
- Lattice verified-patch reuse disabled
- One provider turn per arm
- Independent verification in fresh directories with pristine tests
- No failed, retried, or excluded run in this pair

Usage is provider-reported. Fresh input is total input minus cached input; the
primary traffic metric is fresh input plus output. End-to-end time includes
Lattice indexing and independent verification, rather than hiding local work.

## Task

Fixture: [`fixtures/reset-token`](../../fixtures/reset-token)

> Fix reset token behavior: consume a valid token once, reject a second
> consumption and expired tokens, record a password-reset audit event, and
> preserve login behavior.

The untouched baseline passed 2/4 tests. Both accepted candidates changed
`src/auth/service.js` and `src/auth/token-repository.js`.

## Boundary

This record proves only what happened in this pair. It does not establish
non-inferiority across a task population, a stable average, or the same savings
for other repositories, models, reasoning levels, caches, or service load.
Reproduce it with the spend-gated public driver in
[`benchmarks/paired-reset-token.mjs`](../../benchmarks/paired-reset-token.mjs)
and publish contradictory runs as well as successful ones.
