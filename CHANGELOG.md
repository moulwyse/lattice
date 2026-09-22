# Changelog

Lattice was originally created and developed by Moulwyse.

All notable public changes will be documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
intends to use semantic versioning after the first public release.

## [Unreleased]

### Fixed

- Install instructions use the prebuilt release package. `npm install --global
  github:moulwyse/lattice#<tag>` fails on npm 11 and later for every release,
  because npm prepares a global Git dependency without its dev dependencies
  and the TypeScript build cannot find `tsc`.

## [2.0.0] - 2026-09-23

MAJOR release. Lattice now completes ordinary tasks on ordinary repositories:
v1.0.0 only passed its bundled reset-token fixture. Defaults, the worker
protocol and task results changed incompatibly; see the
[upgrade guide](docs/release-v2.0.0.md).

### Breaking changes

- `lattice run` and `lattice continue` apply a verified patch to the
  workspace by default. Pass `--no-apply` to verify only.
- Worker protocol v5 adds `create_file`, `delete_file` and `PATCH_REVISION`
  turns. `providerProtocolVersion` is 5, and verified patches cached by
  v1.0.0 are ignored.
- Task results are `passed`, `failed` or `cancelled`; `partial` is no
  longer produced. Per-criterion evidence is informational and criteria are
  derived from the goal instead of fixture-specific text.
- The ordinary Codex worker is isolated: it runs in an empty scratch
  directory without user MCP servers, hooks, plugins, network access or web
  search, and answers from granted pages only.
- Runs started in a repository subdirectory operate on the repository root.
- The Lattice-first hook policy denies ordinary tools at most once per turn.
- The verification allowlist adds the repository's own `test*`, `lint`,
  `check`, `typecheck` and `build` package scripts and excludes watch,
  dev-server and UI scripts.
- `create_file` refuses hidden paths.

### Fixed

- Tasks outside the bundled reset-token fixture no longer always fail: the
  task compiler derived hard-coded reset-token criteria, and acceptance
  evidence only recognized fixture vocabulary, so every other task ended as
  `partial`/`FAILED` even when verification passed. Task status is now decided
  by the verification commands; criteria are derived from the goal's clauses
  and attributed to tests generically.
- A passed `lattice run`/`lattice continue` now applies the verified patch to
  the workspace (fingerprint-checked `git apply`); previously the diff was
  only stored under `.lattice/`. Use `--no-apply` to verify only.
- Verification no longer fails for projects with dependencies: installed
  `node_modules` directories are linked into the isolated worktree.
- Uncommitted work no longer blocks a run: the worktree reproduces the
  workspace's dirty and untracked state, and the diff contains only the
  transaction's own changes.
- A patch with no verification command can no longer pass.
- Indexing is about 50x faster on large repositories (one batched
  `git hash-object` per 256 files instead of 2-5 Git processes per file).
- Test detection no longer misses root `test/` and `tests/` directories;
  config detection no longer matches every path containing "config".
- TypeScript ESM imports such as `./x.js` resolve to `x.ts` during context
  selection; complete pages no longer report one extra trailing line.
- `replace_text` works on CRLF checkouts (the Git for Windows default):
  model edits with LF line endings are matched against the file's own
  convention, and `replace_file` preserves the file's line endings.
- Runs started from a repository subdirectory operate on the repository root
  instead of failing with `ENOENT` during the transaction.
- An untracked nested Git repository (or dirty submodule) in the workspace no
  longer makes every transaction fail; thousands of dirty paths no longer hit
  the Windows command-line limit.
- Ctrl+C in `lattice codex` / `lattice claude` reaches the native CLI once
  instead of force-killing it on Windows or arriving twice (exit) on POSIX.
- A missing executable (for example `git` or `npm` not on PATH) is reported as
  an error instead of crashing Lattice with an unhandled `error` event.
- The per-turn worker deadline now actually aborts Claude turns (it previously
  never reached the Claude query); the default deadline is 5 minutes and
  `LATTICE_WORKER_TIMEOUT_MS` overrides it.
- A hanging verification command is reported as failed verification (exit
  124) instead of aborting the run; stored verification output is bounded.
- The Lattice-first hook policy denies at most once per turn, so a turn can
  no longer be blocked completely when the Lattice MCP tools are unavailable;
  `codex-raw` / `lattice codex --raw` bypass the hooks like the Claude raw mode.
- The worker prompt's repository map is ranked by task relevance and capped at
  12,000 characters instead of listing every file and symbol.
- High-risk tasks no longer force whole files of any size into context (files
  above ~48 KB were impossible); a faulted file that does not fit the budget
  falls back to the slice around the requested symbol.
- `lattice continue` records a patch that cannot be lowered as a failed task
  instead of leaving it `running`.
- Codex developer instructions are merged at the front of the argument list
  (never after `--`), multi-line TOML strings are read correctly, and nothing
  is injected when existing instructions cannot be merged safely.
- The Windows Codex integration preserves `%VAR%` entries and the
  `REG_EXPAND_SZ` type of the user PATH, so disable restores it exactly.
- Sidecar: watching works for nested directories on Linux, watcher errors no
  longer crash it, a stale lock from a crashed sidecar is recovered, reindexing
  is serialized, and state is written only when it changes.
- MCP bridge: a failed sidecar attachment is retried on the next call instead
  of failing the whole session, a stopped sidecar is re-attached once, and
  reading a file larger than `maxBytes` returns its truncated beginning.
- Claude and Codex hooks start about 45% faster (one Git process, no sidecar
  module on tool events).
- `.mjs`/`.cjs` tests are selected as context under `node --test`.
- The installers never delete an existing directory that is not a Lattice
  checkout, stop on `git`/`npm` failures, update an existing installation,
  no longer close the PowerShell window on failure under `irm | iex`, and write
  shims that work with non-ASCII profile paths.
- `lattice doctor` no longer creates `.lattice/` in the inspected directory and
  checks Node.js against the supported engine range.

### Added

- Worker protocol v5: `create_file` (new path + content) and `delete_file`
  (complete-file grant) operations.
- Indexing of Python, Go, Rust, Java, Kotlin, C#, Ruby, PHP, Swift, C/C++,
  CSS, HTML, Vue, Svelte, YAML, TOML and shell files; doc comments no longer
  contribute symbols.
- Repository package scripts named `test*`, `lint`, `check`, `typecheck` and
  `build` are added to the verification allowlist.
- Vitest/Jest, pytest and `go test` reporter lines are recognized as evidence.
- Patch revision turns: a patch rejected by edit-grant lowering, or one whose
  verification fails, is returned to the worker with the concrete error for up
  to two corrected patches.
- Codex worker structured output (`outputSchema`), with an automatic retry
  without it if the provider rejects the schema.
- `LATTICE_REF` and `LATTICE_INSTALL_DIR` for the installers.

### Security

- `.lattice/` (sidecar token, indexes, task results, worktrees) is added to the
  clone-local `.git/info/exclude`, so it cannot be committed by accident.
- `create_file` cannot create hidden paths such as `.envrc`,
  `.vscode/tasks.json`, `.github/workflows` or `.husky`, because verified
  patches are applied automatically.
- Dependency links are removed from retained worktrees, and worktrees left by a
  crashed run are cleaned up link-first, so no recursive delete of `.lattice/`
  can reach the user's `node_modules`.
- The Codex worker runs in an empty scratch directory without network access,
  web search, MCP servers, hooks or plugins, so it answers from granted pages.
- `.mcp.json` no longer receives an unused absolute workspace path; a file
  Lattice creates is excluded locally, and a tracked one triggers a warning.
- The hook policy state lives in the per-user state directory instead of the
  shared temporary directory on Linux and macOS.

### Changed

- The Codex prompt module now re-exports the shared prompt instead of
  duplicating it.
- The ordinary Codex worker inherits model and provider settings but no longer
  user MCP servers, hooks or plugins (previously only benchmarks isolated it).
- Watch, dev-server and UI package scripts (`test:watch`, `test:ui`, ...) are
  not allowlisted for verification because they never exit.
- Codex `max` reasoning effort is accepted.
- `START-ASTRA-BENCHMARK.cmd` asks for confirmation before spending quota.
- `* text=auto` in `.gitattributes`; files committed with mixed line endings
  are normalized.
- Evidence note: in v1.0.0 the Lattice arm of the reset-token benchmarks also
  received five hand-written acceptance criteria that the RAW arm did not, and
  the RAW/Lattice Codex configurations differed from ordinary use. Published
  v1.0.0 comparisons should be re-measured with this release.

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

[Unreleased]: https://github.com/moulwyse/lattice/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/moulwyse/lattice/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/moulwyse/lattice/compare/v0.1.1...v1.0.0
[0.1.1]: https://github.com/moulwyse/lattice/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/moulwyse/lattice/releases/tag/v0.1.0
