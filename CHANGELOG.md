# Changelog

Lattice was originally created and developed by Moulwyse.

All notable public changes will be documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
intends to use semantic versioning after the first public release.

## [Unreleased]

### Added

- Public contribution, security, support, evaluation, and release processes.

### Changed

- None.

### Security

- None.

## [0.1.0] - Unreleased draft

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

[Unreleased]: https://github.com/moulwyse/lattice/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/moulwyse/lattice/releases/tag/v0.1.0
