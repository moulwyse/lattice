# Installation

This guide covers the GitHub release package and source installation. For most
people, the short version is:

```sh
npm install --global github:moulwyse/lattice#v0.2.0-claude-beta.1
lattice benchmark --worker mock
```

The package is hosted as a GitHub release asset while npm registry publication
remains intentionally disabled. One package installs both the Codex and Claude
Code adapters; provider accounts are needed only when that provider is used.
To build directly from the canonical source:

```sh
git clone https://github.com/moulwyse/lattice.git
cd lattice
npm ci
npm run build
npm link
lattice benchmark --worker mock
```

The benchmark is local, deterministic, and credential-free. Passing it proves
that the CLI, transaction path, Git worktree flow, and fixture verification can
run on the current machine. It does not make a remote model call.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`, matching the locked development toolchain;
- npm with lockfile support;
- Git for repository discovery, clean-state checks, and isolated worktrees;
- a writable local clone of the repository you want to work on.

Codex is optional and is needed only for `--worker codex` or the optional Codex
integration. Claude authentication or API access is optional and is needed only
for `--worker claude`, `lattice claude`, or the Claude Code Beta integration.

## GitHub release installation

The release tarball is produced by `npm pack` from the tagged commit and
attached to the matching GitHub release. Install or upgrade it with:

```sh
npm install --global github:moulwyse/lattice#v0.2.0-claude-beta.1
```

Verify the command and run the no-model smoke test:

```sh
lattice --version
lattice benchmark --worker mock
```

Uninstall with `npm uninstall --global lattice-v2`.

## Source installation

The package is intentionally not published to the npm registry yet.

```sh
git clone https://github.com/moulwyse/lattice.git
cd lattice
npm ci
npm run build
```

Run without installing globally:

```sh
node dist/cli.js --version
node dist/cli.js --about
node dist/cli.js doctor --workspace /path/to/repository
```

Or create a local command link:

```sh
npm link
lattice --version
```

`npm ci` must be run from the Lattice repository, not from the target
repository. Generated `node_modules/` and `dist/` directories are not source
and must not be committed.

If the shell cannot find `lattice` after `npm link`, restart the terminal and
try `lattice --version`. If global npm links are unavailable, skip `npm link`
and replace every `lattice` command in this guide with
`node /absolute/path/to/lattice/dist/cli.js`.

## Verify the installation

The credential-free validation path is:

```sh
npm test
npm run scan:public
node dist/cli.js benchmark --worker mock
```

The npm scan command is intended for a normal source checkout: it ignores
expected generated directories such as `.git`, `node_modules`, `dist`, and
`.lattice`, while still scanning source and documentation for private or raw
artifacts. CI and release preparation use the scanner's strict export mode.

The mock benchmark creates a temporary synthetic Git repository, applies a
known fix through the normal Lattice transaction path, runs its tests, and
writes an artifact below `.lattice/` in the selected artifact workspace. Do not
commit that directory.

## Codex prerequisites

For direct Codex execution, install and authenticate the official Codex tooling
separately. Confirm it before using Lattice:

```sh
codex login status
lattice doctor --workspace /path/to/repository
```

Lattice does not accept or store a Codex credential in
`lattice.config.json`. Authentication, model availability, billing, and
provider retention are controlled by the Codex environment and account.

The transparent integration is optional and never enabled during installation.
Read [security](security.md) and [providers](providers.md) before running
`lattice integration codex enable`.

## Connect to Codex on Windows

Run the diagnostic before making any user-level integration change:

```powershell
codex login status
lattice integration codex doctor --workspace .
```

If the diagnostic is clean, enable and verify the integration:

```powershell
lattice integration codex enable
lattice integration codex status --workspace .
codex mcp list
```

Restart Codex after enabling the integration. The command registers the
Lattice MCP server and creates Lattice-owned launcher and synchronization hook
state. It does not copy a Codex credential into Lattice. To revert it, run
`lattice integration codex disable` before removing the source clone.

## Platform support

Automatic launcher, hook, and persistent-PATH setup is currently Windows-only.
On macOS or Linux, do not run the automatic enable command. After building, the
read-only MCP bridge can instead be registered explicitly with the official
Codex CLI:

```sh
codex mcp add lattice -- node /absolute/path/to/lattice/dist/cli.js mcp-server
codex mcp list
```

Use an absolute path. This manual registration provides the three bounded
repository-context tools, but it does not install the transparent launcher or
session-sync hooks. Remove only this named registration with:

```sh
codex mcp remove lattice
```

Native macOS/Linux execution still requires verification on those operating
systems; dependency resolution alone is not a runtime test.

## First repository check

Open a terminal in the repository you want Lattice to inspect:

```sh
lattice doctor --workspace .
```

Healthy output should identify the intended repository and report the expected
Codex and integration state. A missing Codex login is normal when you only want
the local mock workflow. Do not continue if the reported repository root or
integration paths point somewhere unexpected.

The simplest no-model functional check remains:

```sh
lattice benchmark --worker mock
```

For a real Codex-backed transaction, read the repository's configuration and
security documentation first, then use:

```sh
lattice run "describe the bounded repository task" --worker codex
```

## Uninstall

If a global link was created:

```sh
npm unlink --global lattice-v2
```

If the optional Codex integration was enabled, disable it first:

```sh
lattice integration codex disable
```

Inspect any warning rather than deleting user configuration manually. Removing
the Lattice source directory does not automatically remove repository-local
`.lattice/` data.
