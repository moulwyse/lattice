# Limitations

Lattice is an early public release. Its controls make context and edits more
explicit; they do not guarantee correct code, lower cost, or safe execution.

## Context quality

- Relevant code can be omitted by ranking, ignore rules, or budget limits.
- Estimated tokens are not provider billing counters.
- Symbol extraction and import resolution are intentionally lightweight and can
  be incomplete for dynamic or uncommon language features.
- A model can request more context, but the request can still be insufficient
  or misdirected.

## Patch and verification quality

- Fingerprints detect stale inputs; they do not prove semantic correctness.
- Passing tests prove only what those tests cover.
- Repository verification commands can execute untrusted package scripts.
- A clean patch can still introduce security, performance, licensing, or
  maintainability problems.
- Worktree isolation depends on Git and does not isolate the operating system,
  network, user credentials, or external services.

## Provider behavior

- The unified prerelease package includes the stable Codex path and an opt-in
  Claude Code Beta. Enabling Claude changes only project-scoped configuration;
  it does not replace Codex commands or defaults.
- Live Codex inference was not run during the initial export validation. Two
  later owner-run, capped Windows compatibility smoke tests passed; they do not
  establish general performance or independent validation.
- Model identifiers and reasoning levels can change independently of Lattice.
- Provider-reported usage may be absent or use definitions that differ across
  versions.
- Retries, tool-mediated calls, subagents, and failed requests must be counted
  explicitly in any evaluation; Lattice cannot infer undisclosed external work.
- Claude Code, Agent SDK, hook input, MCP startup, model identifiers, and effort
  behavior may change independently of Lattice. The Beta is locally verified
  only against its disclosed pinned dependency pair.
- The Claude Code Beta has one community-operated Opus 5 pair on one public
  fixture. Both verification commands passed, but per-test counts and patch
  identity were unavailable in the shared legacy report. It is not evidence of
  population-level non-inferiority or universal savings.

## Optional integration

- Transparent Codex integration is experimental and changes user-level state.
- Its automatic persistent-PATH/launcher/hook lifecycle is currently
  Windows-only. macOS and Linux can use manual stdio MCP registration, but that
  path has not been run natively during this release audit.
- It does not route every native file operation through Lattice.
- MCP registration or hooks can be configured but unused in a particular turn.
- Provider updates can change configuration formats or launcher behavior.

## Performance claims

- The bundled mock benchmark validates a deterministic workflow only.
- The published GPT-5.6 Luna result is one owner-run pair on one fixed fixture;
  it records an observed result but does not establish general savings or
  independent validation.
- The published GPT-5.6 Sol result is also one owner-run pair on the same fixed
  fixture. The accepted patches differed by one blank line.
- The Opus 5 result is a community-operated reproduction of the
  maintainer-supplied task, not independent task selection.
- Small pilots do not establish general task-success non-inferiority.
- Mean reductions can be dominated by a few large tasks; paired ratios,
  medians, confidence intervals, and all failures are required.
- Cached traffic, warm indexes, run order, rate limits, network conditions, and
  provider service load can distort results.
- Raw and Lattice patches need not be byte-identical for both to be correct.

## Compatibility

- Public CLI, MCP, and persistence formats can change before 1.0.
- The locked development toolchain requires Node.js `^20.19.0` or
  `>=22.12.0`; earlier Node 20/22 releases are unsupported.
- Non-Git repositories have fewer isolation and integrity features.
- Windows junctions, filesystem permissions, antivirus tools, and unusual Git
  configurations may affect path and process behavior.
- Darwin ARM64 and Linux x64 dependency resolution passed in disposable installs,
  but this is not equivalent to native build, test, sandbox, filesystem-watch,
  or recovery validation on macOS/Linux.

## Operational limits

- There is no hosted control plane, SLA, enterprise support, automatic update
  service, or remote telemetry backend.
- `.lattice/` cleanup and retention are the operator's responsibility.
- The public scanner recognizes common leak patterns but cannot prove that
  source is free of secrets or copyrighted third-party material.
