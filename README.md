# Lattice

An open-source context and execution layer for coding agents.

Created and led by **[Moulwyse](https://github.com/moulwyse)**.

This repository is the original and canonical home of Lattice.

> **Early public release:** review the [limitations](docs/limitations.md) and
> [security model](SECURITY.md) before using Lattice on a sensitive repository.
> The package is intentionally marked private until the release checklist is
> completed; install it from source rather than from npm.

Lattice indexes a local repository, selects bounded task-relevant context,
coordinates an agent run, validates edits against repository fingerprints, and
records local execution state. It is designed to reduce unnecessary context
movement without hiding what was read, changed, or verified.

Lattice was originally created and developed by Moulwyse.

## What is included

| Capability | Status | Notes |
| --- | --- | --- |
| Local repository discovery and index | Available | Respects repository boundaries and ignore rules. |
| Bounded context pages and edit grants | Available | Local deterministic controls; covered by tests. |
| Fingerprint-checked patch application | Available | Rejects stale or out-of-scope edits. |
| Mock worker and deterministic fixture benchmark | Available | Runs without a model account or API credential. |
| Manual handoff workflow | Available | The operator transfers a bounded request and response. |
| Direct Codex SDK worker | Beta | Requires a separately installed/authenticated Codex environment; not live-tested during this export. |
| Transparent Codex launcher, hooks, sidecar, and MCP bridge | Experimental | Alters user-level integration state when explicitly enabled; inspect before use. |
| Adaptive model selection and verified-patch cache | Experimental | Opt-in; exact behavior and limits are documented. |
| Claude Code, Gemini, Cursor, Grok, or other providers | Not implemented | No adapter for these providers is included in this repository. |

“Available” describes implemented and locally tested behavior, not a production
support guarantee. See [provider status](docs/providers.md) for the precise
boundary.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`, matching the locked development toolchain;
- Git for repository and worktree features;
- Windows, macOS, or Linux with a filesystem accessible to Node.js;
- Codex authentication only when using the Codex worker.

The final local release audit ran on Windows. Linux is represented by the
checked-in CI definitions, and the CI matrix now includes Ubuntu, Windows, and
macOS on Node.js 20 and 22. Those hosted jobs cannot be claimed as passing until
the repository exists and a human enables GitHub Actions. Dependency resolution
was checked locally for Linux x64 and Darwin ARM64, but native Linux and macOS
execution was not run during this audit.

## Install from source

```sh
git clone https://github.com/moulwyse/lattice.git
cd lattice
npm ci
npm run build
npm link
```

The repository has not been published to npm. `npm link` is optional; every
example can instead use `node dist/cli.js`.

## Credential-free quick start

```sh
npm ci
npm run build
node dist/cli.js --version
node dist/cli.js --about
node dist/cli.js benchmark --worker mock
```

To inspect a repository without making a model call:

```sh
node dist/cli.js doctor --workspace /path/to/repository
```

`doctor` reports environment state. A missing Codex login is expected if only
the local or mock workflows are used.

## Core commands

```text
lattice
lattice run "<task>" --worker mock
lattice run "<task>" --worker manual
lattice run "<task>" --worker codex
lattice continue <task-id>
lattice handoff validate <task-id>
lattice session new|show|reset
lattice doctor
lattice benchmark --worker mock
lattice integration codex status|doctor|enable|disable
lattice sidecar status|stop
lattice --version
lattice --about
```

Use `lattice <command> --help` for command-specific options. A direct Codex run
can inherit the active Codex model settings, or accept explicit
`--model`, `--reasoning-effort`, and `--model-policy` options. Model identifiers
are passed to the provider; availability depends on the installed provider and
account.

## Configuration

Configuration is repository-local in `lattice.config.json`. Start from
[`examples/lattice.config.example.json`](examples/lattice.config.example.json):

```json
{
  "model": "inherit",
  "reasoningEffort": "inherit",
  "modelPolicy": "inherit"
}
```

Do not commit credentials or provider session state. Lattice does not require
an API key field in this file. Configuration precedence and experimental
adaptive behavior are documented in
[`docs/configuration.md`](docs/configuration.md).

## How it works

1. Lattice discovers a safe repository root and builds a local structural
   index.
2. A task compiler converts the goal into acceptance criteria and context
   needs.
3. The context kernel returns bounded pages instead of an unrestricted
   repository dump.
4. An agent or manual operator proposes edits against explicit edit grants.
5. Lattice checks fingerprints, applies the transaction in an isolated Git
   worktree when available, and runs allowlisted verification commands.
6. State and diagnostics are written beneath the repository-local `.lattice/`
   directory, which must remain ignored and private.

See [architecture](docs/architecture.md), [protocol](docs/protocol.md), and
[persistence schemas](docs/persistence-schemas.md).

## Tests and quality checks

```sh
npm test
npm run lint
npm run format:check
npm run scan:public
npm run package:check
```

`npm test` builds the project before running the Vitest suite. The public-export
scanner reports suspicious artifacts and exits non-zero; it never deletes
files. The scanner is defense in depth, not proof that a repository is safe.

## Security and privacy

Lattice reads source code in the repository you point it at. Context sent to a
remote model is subject to that provider's terms, account settings, and
retention policy. Local metadata can contain source excerpts, diffs, goals, and
diagnostics. Treat `.lattice/` as sensitive, keep it out of version control,
and remove it before sharing a repository copy.

The optional transparent Codex integration can create Lattice-owned launch
shims, an MCP registration, and Codex hooks in user-level configuration. It is
never enabled by installation. Run `lattice integration codex doctor`, review
the reported paths, and keep a configuration backup before enabling it. The
disable command removes only state that Lattice recognizes as its own.

Automatic persistent-PATH setup through `lattice integration codex enable` is
currently Windows-only. On macOS and Linux, the core CLI and manual stdio MCP
registration remain available, but the transparent launcher/hook lifecycle is
not claimed as implemented. See [installation](docs/installation.md) and
[provider status](docs/providers.md).

Read [SECURITY.md](SECURITY.md) and
[`docs/security.md`](docs/security.md) before real use.

## Limitations

- This is an early public release, not a hosted service or security boundary.
- A smaller context is not automatically a correct context.
- Verification is only as strong as the repository's tests and the configured
  command allowlist.
- Token and latency savings vary by task, repository, model, cache state, and
  provider accounting.
- Local integration tests do not substitute for a live provider evaluation.
- The included reset-token benchmark is a deterministic functional fixture,
  not independent evidence of general model quality or cost reduction.

The complete list is in [`docs/limitations.md`](docs/limitations.md).

## Evaluation

Performance claims should come from paired, isolated runs with provider-reported
usage, evaluator-owned tasks, disclosed failures, and a predeclared acceptance
rule. The proposed protocol is documented in
[`docs/evaluation.md`](docs/evaluation.md).

A separate evidence repository is intended at
[moulwyse/lattice-evaluation](https://github.com/moulwyse/lattice-evaluation),
but it is **not yet public and should be treated as unavailable**. This source
export contains no raw model transcripts, raw telemetry, private
configurations, or unreviewed recordings.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Bug reports and pull requests must not
contain secrets, personal paths, private source, model transcripts, or
provider session data.

## Support

See [SUPPORT.md](SUPPORT.md). Security vulnerabilities belong in the private
reporting path described by [SECURITY.md](SECURITY.md), not in public issues.

## License and authorship

Licensed under the [Apache License 2.0](LICENSE). Attribution and provenance are
recorded in [NOTICE](NOTICE), [AUTHORS.md](AUTHORS.md), and
[CITATION.cff](CITATION.cff). Project-name guidance for forks is in
[TRADEMARKS.md](TRADEMARKS.md).

Lattice was originally created and developed by Moulwyse.

- Original author: <https://github.com/moulwyse>
- Canonical repository: <https://github.com/moulwyse/lattice>
