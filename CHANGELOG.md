# Changelog

Lattice was originally created and developed by Moulwyse.

All notable public changes will be documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
intends to use semantic versioning after the first public release.

## [Unreleased]

### Added

- An opt-in Claude Code Beta inside the main `lattice-v2` package, using the
  existing `lattice` CLI with project-scoped MCP and hooks, reversible removal,
  RAW bypass, provider-reported usage/cost telemetry, a total USD budget, and no
  transferred Codex savings claim.
- Claude Code Beta local tests and a draft prerelease record for
  `v0.2.0-claude-beta.1`; no tag or GitHub prerelease is created by this change.
- A sanitized owner-run GPT-5.6 Luna paired result with exact controls,
  machine-readable metrics, task fixture, patch identity, and explicit
  limitations.
- A public, spend-gated RAW Codex versus Lattice benchmark driver that defaults
  to one pair and stores unsanitized output under ignored local state.
- A benchmark result card for the README.

### Changed

- Repositioned the README around repository-scale execution efficiency while
  keeping bounded context, edit grants, fingerprints, and verification as the
  disclosed mechanism.
- Moved the task-specific owner-run evidence and its non-generalization warning
  into the first screen of the README.

### Fixed

- Windows process-tree cancellation now bounds `taskkill` and falls back to the
  exact child process on restricted hosts, preventing launcher hangs and locked
  temporary workspaces.

### Security

- None.

## [0.1.1] - 2026-08-02

### Added

- Reproducible, CI-checked public evidence for 240 deterministic safety-frontier
  cases.
- Regression coverage for simultaneous sidecar bootstrap attempts.

### Changed

- Clarified the boundary between local safety evidence and live-model
  performance claims.

### Fixed

- Concurrent launchers now attach to the healthy repository sidecar after a
  competing bootstrap process loses the exclusive lock.
- CLI and MCP server version output now share the public package version.

## [0.1.0] - 2026-08-01

### Added

- Initial source release of the repository context index, task compiler,
  bounded context kernel, edit grants, transaction verification, persistence,
  mock worker, manual handoff, Codex SDK worker, MCP bridge, sidecar, and
  optional Codex integration.
- Apache License 2.0, attribution, citation, dependency inventory, public-export
  scanner, GitHub templates, and least-privilege CI workflows.
- Credential-free deterministic fixture benchmark.

### Security

- Repository-root safety checks, canonical path validation, edit
  fingerprinting, structured provider protocol validation, command allowlist,
  integration ownership checks, and sensitive-state documentation.

### Known limitations

- Codex support is beta and was not live-tested during export preparation.
- Transparent Codex integration, adaptive model policy, and verified-patch
  caching are experimental.
- Other provider adapters are not included.
- Public CLI, MCP, and persistence compatibility is not stable before 1.0.

[Unreleased]: https://github.com/moulwyse/lattice/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/moulwyse/lattice/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/moulwyse/lattice/releases/tag/v0.1.0
