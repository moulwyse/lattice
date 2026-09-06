# Lattice v1.0.0 — Astra, safer context and recoverable benchmarks

One package, two integrations: Codex and **Claude Code Beta**.
This major release gathers the newer code, security hardening and Astra evidence.
It does not promote Beta/experimental integrations to production-stable status.

## Install or upgrade

Git and Node.js `20.19+` or `22.12+` are required. No npm account is needed:

```sh
npm install --global github:moulwyse/lattice#v1.0.0
lattice --version
lattice doctor --workspace .
lattice benchmark --worker mock
```

Expected CLI version: `1.0.0`. The mock benchmark is local and credential-free.
npm builds the tagged source; this is not an npm-registry publication.
The package name stays `lattice-v2` for compatibility.

Existing commands and configuration formats are retained. Restart running
agent processes after upgrading. Integrations remain opt-in; installation
does not enable hooks or change your global provider settings.
Stale context now fails closed: rebuild the index if a file changed after indexing.

## What changed

- Codex SDK/CLI pinned to `0.153.4`, used for the Astra live pair.
- Context reads revalidate path boundaries and indexed source fingerprints.
- Metadata JSON is written via exclusive temporary files and atomic replacement.
- Fingerprinting and source extraction use the same captured bytes.
- Indexing processes four files at a time with deterministic ordering.
- Unicode names and literal Git pathspec characters are handled correctly.
- Benchmark checkpoints are saved before cleanup. A locked Windows directory
  cannot erase the recorded model result; incomplete comparisons are invalid.
- Both benchmark arms isolate hooks, plugins, MCP and SQLite state.
- Vulnerable transitive dependencies updated; see [security notes](../SECURITY.md).

## Evidence

[GPT-6 Astra / medium](evidence/owner-run-gpt-6-astra.md):
16,872 -> 4,005 fresh-input-plus-output tokens (**76.26% less**);
70.218 -> 26.969 seconds arm elapsed (**61.59% less**); **4/4 tests both arms**.
Source-only diffs match; full patches differ. Cost was not measured.

[Claude Opus 5 / high](evidence/community-run-claude-opus-5.md), historical
community-run pair: **81.44% fewer fresh-input-plus-output tokens**, **82.77%
lower provider-reported cost**, **70.83% lower reported elapsed time**.
Both pristine verification commands passed; per-test counts and patch identity
are unavailable in that historical record.

These separate single-task pairs are not a model ranking, independent task
selection, or a universal savings guarantee. Timing boundaries differ between
historical drivers. [Sol](evidence/owner-run-gpt-5.6-sol.md) and
[Luna](evidence/owner-run-gpt-5.6-luna.md) remain in the evidence archive.

## Use, bypass and removal

See [Codex setup](quick-start.md) and [Claude Code Beta](claude-code.md).
Claude Agent SDK remains `0.3.220` with bundled Claude Code `2.1.220`.
Claude APIs, hooks and behavior may change.

```sh
lattice integration claude enable --workspace .
lattice claude
lattice claude --raw
lattice integration claude disable --workspace .
```

Codex integration remains opt-in; the transparent launcher/hook lifecycle is
experimental and Windows-only. Run `lattice integration codex disable` to
remove its owned integration state. Uninstall with
`npm uninstall --global lattice-v2`.

To roll back the package:
`npm install --global github:moulwyse/lattice#v0.2.0-claude-beta.1`.
Restart the agent afterwards; rolling back also restores older dependencies.

## Validation boundary

Local build, tests, formatting, package inspection and public-export scanning
are separate from live evidence. The Astra pair above was completed before
release preparation; no additional paid benchmark is required to install.
GitHub Actions checks the published source across its configured platform matrix.
A passed check is not a guarantee against every vulnerability.
