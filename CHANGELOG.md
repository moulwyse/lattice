# Changelog

Lattice was originally created and developed by Moulwyse.

All notable public changes will be documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
intends to use semantic versioning after the first public release.

## [Unreleased]

## [1.0.0] - 2026-09-06

### Added

- Sanitized GPT-6 Astra / medium evidence: one RAW/Lattice pair, 16,872 versus
  4,005 fresh-input-plus-output tokens (76.26% reduction), 4/4 pristine tests
  on both arms. Source-only diffs match; full diffs differ. No dollar-cost claim.
- `npm run benchmark:astra -- --confirm-live` and a Windows convenience launcher.
- Updated Astra/Luna/Opus artwork and a versioned one-command GitHub installation.

### Changed

- First major version of the unified package. Existing CLI commands are retained;
  Claude Code remains Beta and the transparent Codex lifecycle remains experimental.
  A major version does not promote these integrations to production-stable status.
- Codex SDK/CLI pinned to 0.153.4, plus benchmark isolation and checkpoint recovery.
- Safer context reads, atomic metadata writes, bounded parallel indexing, Unicode
  Git path handling, and updated vulnerable transitive dependencies.

The following details include changes accumulated since v0.1.1, including the
previous Claude Code Beta prerelease.

### Added

- A credential-free paired index/context performance driver that compares a
  prior build against the current build and requires identical indexed records
  and context pages. It does not measure model-token savings.
- An opt-in Claude Code Beta inside the main `lattice-v2` package, using the
  existing `lattice` CLI with project-scoped MCP and hooks, reversible removal,
  RAW bypass, provider-reported usage/cost telemetry, a total USD budget, and no
  transferred Codex savings claim.
- Claude Code Beta local tests and the historical `v0.2.0-claude-beta.1`
  prerelease record.
- A sanitized owner-run GPT-5.6 Luna paired result with exact controls,
  machine-readable metrics, task fixture, patch identity, and explicit
  limitations.
- A public, spend-gated RAW Codex versus Lattice benchmark driver that defaults
  to one pair and stores unsanitized output under ignored local state.
- A benchmark result card for the README.
- Sanitized task-specific paired records for GPT-5.6 Sol and a community-run
  Claude Opus 5 reproduction, with explicit acceptance and generalization
  boundaries.
- A cross-provider README card and unified Codex + Claude Code installation
  path.

### Changed

- Clean tracked-file fingerprinting skips unnecessary alternate newline-policy
  probes. Index reads run in bounded batches of four while preserving sorted
  output. Initial context selection stops reading candidates once its page
  budget is full.
- Repositioned the README around repository-scale execution efficiency while
  keeping bounded context, edit grants, fingerprints, and verification as the
  disclosed mechanism.
- Moved the task-specific owner-run evidence and its non-generalization warning
  into the first screen of the README.
- Replaced Claude's pre-benchmark status with the observed community-run Opus 5
  result without transferring Codex claims or calling it independent task
  selection.

### Fixed

- Updated and pinned the Codex SDK/CLI to 0.153.4 so ASTRA benchmark requests
  are not rejected for an obsolete client version.
- Codex paired benchmarks disable inherited hooks/plugins and MCP for both arms,
  without changing normal sessions. Per-arm checkpoints preserve model outcomes
  before cleanup; locked Windows directories no longer hide the original failure.
  Cleanup/infrastructure failures stop further arms and invalidate savings claims.
- Git index discovery now handles Unicode names and literal pathspec characters.
- Source extraction and fingerprints use the same captured bytes.
- Sequential Codex launcher tests check children after each launch instead of
  treating reused historical Windows PIDs as leaked children.
- Windows process-tree cancellation now bounds `taskkill` and falls back to the
  exact child process on restricted hosts, preventing launcher hangs and locked
  temporary workspaces.
- Live benchmark runners fail before model use when the current Codex task
  disables network access for spawned commands.
- Node TAP acceptance summaries now support both `#` and `ℹ` prefixes and
  preserve successful legacy verification status when counts are unavailable.

### Security

- Context reads revalidate repository boundaries and reject files changed since
  indexing; optional package manifests use the same safe-read boundary.
- JSON metadata writes use exclusive temporary files and atomic replacement
  instead of truncating a potentially linked destination.
- Updated vulnerable transitive dependency versions: fast-uri 3.1.7, hono
  4.13.7, nanoid 3.3.18, and qs 6.16.0.

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
