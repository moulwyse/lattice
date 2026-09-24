# Claude Opus 5.5 / high: owner-run paired evidence

Date: 2026-09-24. One local RAW-first pair on the public reset-token fixture,
measured with the v2.0.1 code (Claude Agent SDK `0.3.281`, bundled Claude Code
`2.1.281`). This is a maintainer-operated result, not independent evaluation.

## Result

| Metric | Plain Claude Code | Lattice | Reduction |
| --- | ---: | ---: | ---: |
| Fresh input | 35,194 | 3,941 | 88.80% |
| Output | 2,085 | 806 | 61.34% |
| Fresh input + output | 37,279 | 4,747 | **87.27%** |
| Cached input | 194,670 | 0 | Not applicable |
| Total input including cache | 229,864 | 3,941 | 98.29% |
| Provider-reported cost | $0.36213 | $0.04764 | **86.84%** |
| Model turns | 8 | 1 | Not applicable |
| Model execution | 23.873 s | 7.503 s | 68.57% |
| End-to-end | 35.001 s | 10.344 s | **70.45%** |
| Pristine acceptance | 4/4 | 4/4 | Not applicable |

Cost is the provider-reported figure for each arm. Cached input is reported
separately and is not counted as fresh input. Most of the difference on this
task comes from turn count: plain Claude Code explored and verified in eight
model turns, while Lattice supplied bounded context up front and finished in
one.

## Controls

- Exact requested model: `claude-opus-5-5`; reasoning effort: `high`; budget
  cap $1 per arm.
- Windows; Node.js 24.21.0.
- One plain Claude Code arm followed by one Lattice arm.
- Task text, identical in both arms: fix reset token behavior: consume a valid
  token once, reject a second consumption and expired tokens, record a
  password-reset audit event, and preserve login behavior. The plain arm's
  prompt also tells it to work only inside the repository, avoid network
  access, and run `npm test`. Lattice derives its acceptance criteria from the
  same task text; no fixture-specific criteria were added.
- Fixture: [fixtures/reset-token](../../fixtures/reset-token). Both baseline
  commits: `f6c505fee72f1a32bc19ac63cc5418383ddf5e71`; the baseline suite
  fails 2 of 4 tests in both arms.
- Plain arm: fresh temporary repository, Claude Code safe mode, no Lattice MCP
  server, web tools off, permissions bypassed only inside the generated fixture.
- Lattice arm: native provider tools off, strict empty MCP configuration,
  verified-patch cache off, isolated transactional worktree. Zero context
  faults and zero protocol repair turns.
- Independent pristine directories ran the original tests against each
  candidate's source.
- Both arms passed; the pair was recorded as valid.

## Patch and acceptance checks

Both arms changed the same two files, `src/auth/service.js` and
`src/auth/token-repository.js`. The `token-repository.js` changes are identical.
The `service.js` changes are functionally equivalent and differ only in whether
the audit call is wrapped in braces. Normalized diff SHA-256:

- plain Claude Code:
  `16950e90f531146371559c6f9cae51f2a8c1ef55a7bd2e8785ade89442f32fd8`
- Lattice:
  `b8baf1cb6f9727b7d3d795beabbcbc0b01104a273be69da2deae9385eb8ae5b0`

Original acceptance tests: valid token consumed once; expired token rejected;
successful reset recorded in audit; existing login unchanged.

## Reproduce

From a checkout of v2.0.1, install dependencies with `npm ci`. A Claude Code
login or API access with the requested model is required.

```sh
BENCH_MODEL=claude-opus-5-5 \
BENCH_REASONING_EFFORT=high \
BENCH_MAX_BUDGET_USD=1 \
npm run benchmark:claude -- --confirm-live
```

This explicitly spends model quota on one pair. Results remain under ignored
`.lattice/evaluation/`.

Two earlier attempts on the same day made no model call and are not counted:
the first failed because the bundled Claude Code was not logged in, and the
second because Claude Code `2.1.220` does not support `claude-opus-5-5`. The
second failure is fixed in v2.0.1.

## Limitations and publication boundary

One fixed fixture with five source files, one RAW-first pair, no confidence
interval and no independent task selection. The fixture is public and
maintainer-authored. On a repository this small, the saving mostly reflects
fewer model turns rather than less repository content; larger repositories and
harder tasks will show a different ratio. This is a smoke test, not proof of
quality parity or generalized savings.

Only [allowlisted metrics](owner-run-claude-opus-5-5.json) and reviewed
narrative are published. Provider sessions, account configuration, absolute
local paths and unreviewed logs remain excluded.
