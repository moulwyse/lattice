# Lattice v2.0.0 — real tasks on real repositories

This MAJOR release makes Lattice complete ordinary tasks on ordinary
repositories. v1.0.0 passed its bundled reset-token fixture, but any other task
ended as failed: task compilation and acceptance evidence were tuned to that
fixture, verified patches were never applied, dependencies were missing from
the verification worktree, and Windows CRLF checkouts rejected text edits.
Defaults and the worker protocol changed incompatibly, hence the major version.

## Install or upgrade

Git and Node.js `20.19+` or `22.12+` are required:

```sh
npm install --global https://github.com/moulwyse/lattice/releases/download/v2.0.0/lattice-v2-2.0.0.tgz
lattice --version
lattice doctor --workspace .
lattice benchmark --worker mock
```

The installers accept `LATTICE_REF=v2.0.0`. Expected CLI version: `2.0.0`. The
package name stays `lattice-v2`. Restart running Codex or Claude Code sessions
after upgrading so hooks and MCP servers load the new build.

## Breaking changes

- **Verified patches are applied.** `lattice run` and `lattice continue` write
  a passed patch to the workspace with a fingerprint-checked `git apply`. Use
  `--no-apply` for the previous verify-only behavior (the diff is printed).
- **Task status is `passed`, `failed` or `cancelled`.** It is decided by the
  verification commands; `partial` is no longer produced, and per-criterion
  evidence is informational. Scripts that treated exit code `2` as partial
  success only see `0` or `1` now.
- **Worker protocol v5.** Patches may use `create_file` (new, non-hidden paths)
  and `delete_file` (complete-file grants), and rejected patches or failed
  verification come back to the worker as up to two `PATCH_REVISION` turns.
  Verified patches cached by v1.0.0 are ignored.
- **Isolated Codex worker.** The worker inherits your model and provider
  settings but runs in an empty scratch directory without your MCP servers,
  hooks, plugins, network access or web search. Repository `AGENTS.md` is not
  loaded unless it is granted as context.
- **Repository root.** A run started in a subdirectory operates on the
  repository root.
- **Lattice-first hooks deny at most once per turn,** so an unavailable Lattice
  MCP server can no longer block every tool; `codex-raw` bypasses the hooks.
- **Verification allowlist.** The repository's own `test*`, `lint`, `check`,
  `typecheck` and `build` scripts are allowed; watch, dev-server and UI scripts
  are not.

## What else changed

- Uncommitted work, untracked files, nested repositories and installed
  `node_modules` are reproduced in the isolated verification worktree.
- `.lattice/` is added to the clone-local `.git/info/exclude`.
- Indexing is about 50x faster on large repositories and covers Python, Go,
  Rust, Java, Kotlin, C#, Ruby, PHP, Swift, C/C++ and more.
- The worker prompt's repository map is capped at 12,000 characters.
- Ctrl+C reaches `lattice codex` / `lattice claude` sessions once.
- The Windows Codex integration keeps `%VAR%` entries and the `REG_EXPAND_SZ`
  type of the user PATH.
- Worker turns have a working 5-minute deadline (`LATTICE_WORKER_TIMEOUT_MS`).
- Installers never delete a directory that is not a Lattice checkout.

The complete list is in the [changelog](../CHANGELOG.md).

## Evidence

v1.0.0 evidence is kept in the [evidence archive](evidence/README.md), but it
is not like-for-like: the Lattice arm also received five hand-written
acceptance criteria for the reset-token fixture that the RAW arm did not, and
the fixture used `core.autocrlf=false`. v2.0.0 has no new live measurement yet;
re-run the paired drivers before citing savings for this release.

## Roll back

v1.0.0 has no prebuilt package; install it from source with the installer:

```powershell
$env:LATTICE_REF = "v1.0.0"; irm https://raw.githubusercontent.com/moulwyse/lattice/main/scripts/install.ps1 | iex
```

```sh
curl -fsSL https://raw.githubusercontent.com/moulwyse/lattice/main/scripts/install.sh | LATTICE_REF=v1.0.0 bash
```

Disable integrations with the version that enabled them before rolling back.

## Validation boundary

Local build, type checking, 532 tests on Windows, formatting and the
public-export scan passed before release. GitHub Actions runs the suite on
Ubuntu, Windows and macOS. Live Codex and Claude turns were not re-run for this
release; the protocol changes are covered by scripted provider stand-ins.
