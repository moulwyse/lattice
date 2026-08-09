# Provider status

Lattice separates repository context and patch validation from the worker that
proposes a change. That architecture can support provider adapters, but this
repository does not claim adapters that are not present and tested.

## Included workers

### Mock worker — available

The mock worker recognizes only the bundled reset-token fixture. It exists to
exercise context faults, edit grants, transactions, verification, telemetry,
and cancellation without external inference. It is not a general coding agent.

### Manual handoff — available

Manual mode writes a bounded request and waits for a canonical JSON response.
The operator chooses how and whether to give that request to an external model.
No external call is made by Lattice.

### Codex SDK worker — beta

The direct worker uses `@openai/codex-sdk`. It can inherit or override model and
reasoning settings and records provider-reported usage when supplied. Unit and
integration tests use local fakes and do not prove live-account compatibility.
No live Codex inference was performed as part of the public-export validation.

The installed Codex version, account, model catalog, authentication, pricing,
and retention policy are external dependencies. Run a capped smoke test before
relying on the adapter.

### Owner-run compatibility smoke test

After the initial export audit, Moulwyse ran two capped Windows smoke tests on
2026-07-31. These are owner-run compatibility checks, not independent
validation and not performance benchmarks:

- official Codex CLI `0.145.0` connected to the public MCP bridge, invoked
  `lattice_status` and `lattice_search_context`, received three bounded pages,
  and completed successfully;
- the locked `@openai/codex-sdk` `0.144.5` worker completed the reset-token
  fixture in one model turn with zero page faults or protocol repairs; the
  verified patch changed two files and passed acceptance.

Across both smoke tests, provider metadata reported 21,027 non-cached input
tokens and 770 output tokens. These figures describe only connectivity tests
and support no general cost, quality, or latency claim. The model was inherited
from the authenticated Codex configuration rather than hard-coded by Lattice.

### Owner-run paired performance smoke test

A separate 2026-07-31 owner-run pair compared RAW Codex with Lattice on the
public reset-token fixture using `gpt-5.6-luna` at `medium` reasoning. Both arms
passed 4/4 pristine tests and produced a byte-identical patch. In that pair,
Lattice used 85.64% less fresh input plus output and completed 77.87% faster end
to end.

The complete controls, metric definitions, sanitized data, public driver, and
limitations are in the
[paired evidence record](evidence/owner-run-gpt-5.6-luna.md). It is one fixed,
owner-run pair, not independent validation or a general performance claim.

## Optional Codex integration — experimental

The integration can create a Lattice-owned launcher shim, register the local MCP
bridge, synchronize visible session settings through hooks, and run a
repository-scoped sidecar. It is opt-in:

```sh
lattice integration codex doctor
lattice integration codex enable
lattice integration codex status
lattice integration codex disable
```

It does not intercept every native repository read. The current boundary is
“Lattice-first”: an enabled Codex environment is instructed to attempt a
Lattice context tool before ordinary repository tools; later reads and edits
can still use native tooling. Status distinguishes configured infrastructure
from observed context grants.

Review user-level paths before enabling it. See [security](security.md).

The automatic launcher, hook, and persistent-PATH lifecycle is currently
Windows-only. Windows enable/status/doctor/shim/hook/disable behavior was tested
against Codex CLI `0.145.0` in an isolated `CODEX_HOME`. On macOS and Linux,
manual stdio MCP registration is documented, but native runtime behavior has
not been executed and transparent auto-enable is not supported.

## Claude Code adapter — beta

The Claude Code Beta is included as an opt-in provider inside the main
`lattice-v2` prerelease package. It uses the same `lattice` CLI. The stable
Codex commands, integration state, and default worker are not replaced.

The local build and contract suite is verified with Claude Agent SDK `0.3.220`
and bundled Claude Code `2.1.220`. A separate community-operated Opus 5 pair on
the public reset-token fixture passed both independent verification commands
and observed 81.44% less fresh input plus output, 82.77% lower
provider-reported cost, and 70.83% lower end-to-end time. The legacy report did
not preserve per-test counts or patch identity. This is one task-specific
reproduction, not a general Claude performance claim.

Installation, removal, RAW bypass, version boundaries, and the broader paired
evaluation protocol are documented in the
[Claude Code Beta overview](claude-code.md) and the
[sanitized community-run record](evidence/community-run-claude-opus-5.md).

## Other providers not included

No Gemini, Cursor, Grok, or other provider adapter is present in this export.
Those providers are unsupported until a contribution includes:

- an official SDK or documented local interface;
- model and effort mapping without invented identifiers;
- cancellation and error semantics;
- complete provider-reported usage accounting;
- credential-free contract tests;
- a disclosed, capped live-validation result;
- security and retention documentation.

Architecture portability is not implementation or validation.
