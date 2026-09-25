<p align="center">
  <img src="docs/assets/lattice-mark.png" alt="Lattice mark: a bounded repository slice ending in a verified result" width="128">
</p>

<h1 align="center">Lattice</h1>

<p align="center"><strong>An optimized execution system for repository-scale coding tasks.</strong></p>

<p align="center">
  Lattice moves deterministic repository work out of the model loop so strong
  coding models can focus on solving the task.
</p>

![Lattice: don't send the repo, send what matters](docs/assets/brand-hero.jpg)

One package includes both the **Codex** and **Claude Code** adapters.

Live paired results on the same reset-token task, plain agent versus Lattice.
These are separate single-task runs, not a model ranking:

| Pair | Fresh input + output | Cost | End-to-end time | Acceptance |
| --- | ---: | ---: | ---: | --- |
| **Claude Opus 5.5** / high, v2.0.1 | 37,279 → 4,747 (**87.3% less**) | $0.362 → $0.048 (**86.8% less**) | 35.0 s → 10.3 s (**70.4% less**) | 4/4 both arms |
| **GPT-6 Astra** / medium, v1.0.0 | 16,872 → 4,005 (**76.3% less**) | Not measured | 70.2 s → 27.0 s (**61.6% less**) | 4/4 both arms |

> **Evidence boundary:** each row is one owner-run pair on one small,
> maintainer-authored fixture (five source files), not independent task
> selection or a general savings claim. The ratio will differ on larger
> repositories and harder tasks.
>
> - **Opus 5.5:** both arms received the same task text, and the patches are
>   functionally equivalent. Most of the difference comes from Lattice finishing
>   in one model turn where Claude Code used eight.
>   [Record](docs/evidence/owner-run-claude-opus-5-5.md).
> - **Astra:** measured with v1.0.0, whose Lattice arm also received five
>   hand-written acceptance criteria that the plain arm did not, so it is not
>   like-for-like. Arm time excludes setup, checkpoint and cleanup.
>   [Record](docs/evidence/owner-run-gpt-6-astra.md).
>
> Historical v1.0.0 records for
> [Sol](docs/evidence/owner-run-gpt-5.6-sol.md),
> [Luna](docs/evidence/owner-run-gpt-5.6-luna.md) and the community-run
> [Opus 5](docs/evidence/community-run-claude-opus-5.md) pair remain published.

[![Build and test](https://github.com/moulwyse/lattice/actions/workflows/ci.yml/badge.svg)](https://github.com/moulwyse/lattice/actions/workflows/ci.yml)
[![Quality](https://github.com/moulwyse/lattice/actions/workflows/quality.yml/badge.svg)](https://github.com/moulwyse/lattice/actions/workflows/quality.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022-339933.svg)](package.json)
[![Release](https://img.shields.io/github/v/release/moulwyse/lattice?display_name=tag)](https://github.com/moulwyse/lattice/releases)

## Install both integrations and verify in 30 seconds

You need [Git](https://git-scm.com/downloads) and Node.js `20.19+` or `22.12+`.
The local verification below needs no model account and makes no model call.
Run it from the Git repository where you want to use Lattice.

```powershell
# Windows (PowerShell):
irm https://raw.githubusercontent.com/moulwyse/lattice/main/scripts/install.ps1 | iex
```

```sh
# Linux / macOS (Bash):
curl -fsSL https://raw.githubusercontent.com/moulwyse/lattice/main/scripts/install.sh | bash
```

Or install the prebuilt release package:

```sh
npm install --global https://github.com/moulwyse/lattice/releases/download/v2.1.0/lattice-v2-2.1.0.tgz
lattice benchmark --worker mock
```

Or build from canonical source:

```sh
git clone https://github.com/moulwyse/lattice.git
cd lattice
npm ci
npm run build
npm link
lattice doctor --workspace .
lattice benchmark --worker mock
```

Installing straight from Git (`github:moulwyse/lattice#v2.1.0`) fails on npm 11 and later: npm prepares a global Git dependency without its dev dependencies, so the TypeScript build cannot find `tsc`.

A healthy verification ends with `Status: passed`. The unified package includes
the Codex and Claude Code adapters; each integration remains opt-in so Lattice
does not silently change either agent. Continue with the
[Codex setup](docs/quick-start.md) or [Claude Code setup](docs/claude-code.md).

Created and led by **[Moulwyse](https://github.com/moulwyse)**.

This repository is the original and canonical home of Lattice.

> **v2.1.0 scope:** review the [limitations](docs/limitations.md) and
> [security model](SECURITY.md) before using Lattice on a sensitive repository.
> Install the prebuilt release package or use the installer; `@moulwyse/lattice` is not yet available in the public npm registry. Transparent Codex
> hooks stay experimental.
> See the [release and upgrade guide](docs/release-v2.0.0.md).

## How it works

Lattice indexes a local repository, selects bounded task-relevant context,
coordinates an agent run, validates edits against repository fingerprints, and
records local execution state. The optimization comes from moving deterministic
repository operations outside the model loop while keeping context selection,
edit authority, and verification visible.

![How Lattice bounds context and verifies a patch](docs/assets/lattice-flow.svg)

## Why Lattice

- **Bounded context:** the agent receives explicit task-relevant pages instead
  of an unrestricted repository dump.
- **Verified edits:** stale or out-of-scope patches are rejected against edit
  grants and repository fingerprints.
- **Visible state:** local artifacts record what was selected, changed, and
  verified without hiding the execution path.
- **Cross-provider:** one installation includes tested Codex and Claude Code
  paths with explicit stability labels, RAW bypasses, and separate evidence.

Lattice was originally created and developed by Moulwyse.

## Unified installation: Codex + Claude Code

You need [Git](https://git-scm.com/downloads) and a supported
[Node.js](https://nodejs.org/en/download) version (`20.19+` or `22.12+`). You
do not need an API key to install Lattice or run its local demo.

### Run the unified v2.1.0 release

Install the prebuilt release package globally through npm on Windows, macOS, or Linux:

```sh
npm install --global https://github.com/moulwyse/lattice/releases/download/v2.1.0/lattice-v2-2.1.0.tgz
lattice --version
lattice benchmark --worker mock
```

The package contains both provider adapters. Codex is the default worker, and
the Claude Code integration is available alongside it. Running the package
enables neither integration until you choose it for your environment or
repository.

The benchmark is local, deterministic, credential-free, and makes no model
call. It is a functional smoke test, not evidence of general quality or token
savings.

### Build from source

#### Windows (PowerShell)

Copy and run these commands:

```powershell
git clone https://github.com/moulwyse/lattice.git
Set-Location lattice
npm ci
npm run build
npm link
lattice --version
lattice benchmark --worker mock
```

The final command is a credential-free self-test. A successful installation
ends with a passed benchmark and creates no model charges.

To connect Lattice to an already installed and authenticated Codex environment:

```powershell
codex login status
lattice integration codex doctor --workspace .
lattice integration codex enable
lattice integration codex status --workspace .
```

The Windows integration registers the Lattice MCP server and installs its
Lattice-owned launcher and synchronization hooks. Restart Codex after enabling
it. Lattice never asks you to paste a Codex API key into its configuration.

#### macOS or Linux

Install and run the same local self-test:

```sh
git clone https://github.com/moulwyse/lattice.git
cd lattice
npm ci
npm run build
npm link
lattice --version
lattice benchmark --worker mock
```

On Linux (Bash, Zsh, Fish), enable the launcher, MCP bridge and hooks:

```sh
codex login status
lattice integration codex enable
# Open a new terminal and restart Codex.
lattice integration codex doctor
```

Linux setup includes shell PATH configuration and supports Arch/Omarchy.
A native Linux lifecycle smoke test is included in CI; live Omarchy validation
remains pending. For macOS or manual MCP setup, see
[platform support](docs/installation.md#platform-support).

If `npm link` is unavailable or requires global permissions, skip it and run
the CLI from the cloned directory as `node dist/cli.js <command>`.

### Use it on a repository

Open a terminal in the repository you want to work on and run:

```sh
lattice doctor --workspace .
```

Resolve any reported error, then open that repository in Codex. On Windows
and Linux, the enabled integration installs the launcher, MCP bridge and
session synchronization hooks. Hook activation still depends on the Codex client.

### Undo the integration

Windows:

```powershell
lattice integration codex disable
npm uninstall --global lattice-v2   # after npm link: npm unlink --global lattice-v2
```

Linux automatic integration:

```sh
lattice integration codex disable
npm uninstall --global lattice-v2   # after npm link: npm unlink --global lattice-v2
```

The disable command removes only integration state that Lattice recognizes as
its own. Full installation, troubleshooting, and safety notes are in the
[installation guide](docs/installation.md).

## What is included

| Capability | Status | Notes |
| --- | --- | --- |
| Local repository discovery and index | Available | Respects repository boundaries and ignore rules. |
| Bounded context pages and edit grants | Available | Local deterministic controls; covered by tests. |
| Fingerprint-checked patch application | Available | Rejects stale or out-of-scope edits; a verified patch is applied to the workspace (`--no-apply` only verifies). |
| Mock worker and deterministic fixture benchmark | Available | Runs without a model account or API credential. |
| Manual handoff workflow | Available | The operator transfers a bounded request and response. |
| Direct Codex SDK worker | Beta | Requires an authenticated Codex environment; exercised by published owner-run paired smoke tests. |
| Transparent Codex launcher, hooks, sidecar, and MCP bridge | Experimental | Alters user-level integration state when explicitly enabled; inspect before use. |
| Adaptive model selection and verified-patch cache | Experimental | Opt-in; exact behavior and limits are documented. |
| Claude Code | [Available](docs/claude-code.md) | Included in the same package; locally tested and exercised by published Opus 5.5 and Opus 5 pairs. |
| Gemini, Cursor, Grok, or other providers | Not implemented | No adapter for these providers is included in this repository. |

“Available” describes implemented and locally tested behavior, not a production
support guarantee. See [provider status](docs/providers.md) for the precise
boundary.

## Claude Code

Claude Code is an opt-in integration inside the main Lattice package.
There is one package, one installation, and one CLI: `lattice`. Existing Codex
commands and defaults remain unchanged.

Install the same unified release through npm:

```sh
npm install --global https://github.com/moulwyse/lattice/releases/download/v2.1.0/lattice-v2-2.1.0.tgz
lattice --version
```

Enable it only in the repository where you want Claude Code to use Lattice:

```sh
lattice integration claude enable --workspace .
lattice integration claude status --workspace .
lattice claude
```

Use `lattice claude --raw` to launch the same bundled Claude Code while
bypassing Lattice for that child process. Undo only the project integration
with `lattice integration claude disable --workspace .`; uninstall the unified
package with `npm uninstall --global lattice-v2`.

The integration has passed local build and contract tests with Claude Agent SDK
`0.3.281` and its bundled Claude Code `2.1.281`. An owner-run Opus 5.5 pair on
the public fixture observed 87.3% less fresh input plus output, 86.8% lower
provider-reported cost, and 70.4% lower end-to-end time, with 4/4 pristine
acceptance tests in both arms. This is one task-specific signal, not a universal
Claude claim. Claude Code, Agent SDK, hook, and MCP behavior may change.

Read the [install, RAW bypass, and removal guide](docs/claude-code.md)
before enabling it. Maintainers and reviewers can use the concise
[Claude Code OSS project brief](docs/claude-for-oss.md).

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`, matching the locked development toolchain;
- Git for repository and worktree features;
- Windows, macOS, or Linux with a filesystem accessible to Node.js;
- Codex authentication only when using the Codex worker;
- Claude authentication or API access only when using Claude Code or the
  direct Claude worker.

The final local release audit ran on Windows. GitHub Actions now builds and
tests the public repository on Ubuntu, Windows, and macOS with Node.js 20 and
22. Dependency resolution was also checked for Linux x64 and Darwin ARM64.
Hosted CI is valuable compatibility evidence, but it is not the same as a full
interactive Codex integration test on every platform.

## Start screen and stats

Run `lattice` in a terminal to see the start screen: the version, project,
Git branch and active agent integration, a **Metrics** box (context sent
against the indexed repository size, tokens, provider-reported cost) and a
**Worktree pipeline** box with the latest tasks, their changed files and
whether each patch was verified or rejected. Every number is measured; the
screen does not estimate savings.

The first start asks for a language (English, Русский, Українська, Polski,
Deutsch, Español); change it later with `lattice language <code>`. On every
start Lattice checks GitHub and, only when a newer release exists, asks whether
to install it. Without a terminal, `lattice` prints its help.

Inside Codex or Claude Code, ask for **Lattice stats**: the agent calls the
`lattice_stats` MCP tool and shows the same report as `lattice stats`. The
report covers the index size, context sent to agents over MCP, tasks run
through Lattice with their tokens and provider cost, and integration status.
Only counts are recorded, never file content. It does not claim savings;
those come only from paired benchmarks.

Set `LATTICE_NO_UPDATE_CHECK=1` to skip the update check. Language and the last
update check are stored in `%LOCALAPPDATA%\Lattice\settings.json` or
`~/.local/share/Lattice/settings.json`.

## Core commands

```text
lattice
lattice stats [--json]
lattice update [--yes]
lattice language [en|ru|uk|pl|de|es]
lattice run "<task>" --worker mock
lattice run "<task>" --worker manual
lattice run "<task>" --worker codex
lattice run "<task>" --worker claude
lattice run "<task>" --worker codex --no-apply
lattice continue <task-id>
lattice handoff validate <task-id>
lattice session new|show|reset
lattice doctor
lattice benchmark --worker mock
lattice integration codex status|doctor|enable|disable
lattice integration claude status|enable|disable
lattice claude [--raw]
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
   worktree that reproduces your uncommitted work and installed dependencies,
   and runs allowlisted verification commands. A rejected patch or a failed
   verification is returned to the worker for up to two corrections.
6. A verified patch is applied to your workspace with `git apply` after every
   source fingerprint is re-checked (`--no-apply` only verifies).
7. State and diagnostics are written beneath the repository-local `.lattice/`
   directory, which Lattice adds to `.git/info/exclude`; keep it private.

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
scanner checks source files while ignoring expected generated directories in a
working clone (`.git`, `node_modules`, `dist`, and `.lattice`). CI and release
preparation invoke the scanner directly in strict export mode. Both modes
report suspicious artifacts and exit non-zero; neither deletes files. The
scanner is defense in depth, not proof that a repository is safe.

## Security and privacy

Lattice reads source code in the repository you point it at. Context sent to a
remote model is subject to that provider's terms, account settings, and
retention policy. Local metadata can contain source excerpts, diffs, goals, and
diagnostics. Treat `.lattice/` as sensitive: Lattice adds it to the clone-local
`.git/info/exclude` so it is not committed, but remove it before sharing a
repository copy.

The optional transparent Codex integration can create Lattice-owned launch
shims, an MCP registration, and Codex hooks in user-level configuration. It is
never enabled by installation. Run `lattice integration codex doctor`, review
the reported paths, and keep a configuration backup before enabling it. The
disable command removes only state that Lattice recognizes as its own.

Automatic persistent-PATH setup supports Windows and Linux (Bash, Zsh, Fish).
Linux live Omarchy sessions and macOS automatic integration remain unverified.
See [installation](docs/installation.md) and [provider status](docs/providers.md).

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
- The credential-free reset-token benchmark is a deterministic functional
  fixture, not evidence of model quality or savings.
- The Opus 5.5 result is one owner-run pair on one small, maintainer-authored
  fixture; it is not independent task selection.
- The Astra, Luna, Sol and Opus 5 pairs were measured with v1.0.0, whose Lattice
  arm received extra fixture-specific acceptance criteria; re-measure before
  citing them.

The complete list is in [`docs/limitations.md`](docs/limitations.md).

## Evaluation

Performance claims should come from paired, isolated runs with provider-reported
usage, evaluator-owned tasks, disclosed failures, and a predeclared acceptance
rule. The proposed protocol is documented in
[`docs/evaluation.md`](docs/evaluation.md).

The release includes a sanitized, reproducible
[credential-free smoke-test result](docs/evidence/mock-benchmark-v0.1.0.json).
The current source also publishes a CI-checked
[240-case safety-frontier result](docs/evidence/economy-frontier.json) covering
risk classification, fail-closed protocol handling, path confinement, exact
patch lowering, and the live-evaluation budget guard. Reproduce it with
`npm run evidence:frontier`. These are deterministic local checks, not live
model results or evidence of token savings.

The source also includes sanitized paired records for
[Claude Opus 5.5](docs/evidence/owner-run-claude-opus-5-5.md),
[GPT-5.6 Luna](docs/evidence/owner-run-gpt-5.6-luna.md),
[GPT-5.6 Sol](docs/evidence/owner-run-gpt-5.6-sol.md), and a
[community-run Claude Opus 5 reproduction](docs/evidence/community-run-claude-opus-5.md),
plus the [spend-gated public drivers](benchmarks/README.md). Each record is one
RAW run and one Lattice run on one fixed fixture. None is population-level or
independent task-selection evidence. Raw provider sessions, private
configuration, local paths, and unreviewed transcripts remain excluded.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Bug reports and pull requests must not
contain secrets, personal paths, private source, model transcripts, or
provider session data.

## Support

See [SUPPORT.md](SUPPORT.md). Security vulnerabilities belong in the private
reporting path described by [SECURITY.md](SECURITY.md), not in public issues.

Lattice is independently built and maintained. To support its development,
discuss sponsorship, or help with access to testing infrastructure, contact
[ptech1500@gmail.com](mailto:ptech1500@gmail.com?subject=Lattice%20support).

You can also support the project through
[Patreon](https://www.patreon.com/c/moulwyse). Patreon support helps cover
cross-platform testing, CI, reproducible benchmarks, and model access.

Please do not send credentials, API keys, or private source code by email.

## License and authorship

Licensed under the [Apache License 2.0](LICENSE). Attribution and provenance are
recorded in [NOTICE](NOTICE), [AUTHORS.md](AUTHORS.md), and
[CITATION.cff](CITATION.cff). Project-name guidance for forks is in
[TRADEMARKS.md](TRADEMARKS.md).

Lattice was originally created and developed by Moulwyse.

- Original author: <https://github.com/moulwyse>
- Canonical repository: <https://github.com/moulwyse/lattice>
