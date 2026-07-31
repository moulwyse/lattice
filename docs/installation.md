# Installation

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`, matching the locked development toolchain;
- npm with lockfile support;
- Git for repository discovery, clean-state checks, and isolated worktrees;
- a writable local clone of the repository you want to work on.

Codex is optional. It is needed only for `--worker codex` or the optional Codex
integration.

## Source installation

The initial public export is intentionally not published to npm.

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

## Verify the installation

The credential-free validation path is:

```sh
npm test
npm run scan:public
node dist/cli.js benchmark --worker mock
```

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
