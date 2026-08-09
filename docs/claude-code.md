# Claude Code integration — Beta

> [!WARNING]
> This integration is Beta. Claude Code, the Claude Agent SDK, hooks, MCP
> configuration, model identifiers, and provider behavior may change.

Claude Code is an opt-in section of the main Lattice package. It is not a
separate product or npm package: installation provides the same `lattice` CLI
used by Codex, and Codex remains the default worker.

## Evidence status

- Local TypeScript build: passed.
- Credential-free unit, integration, lifecycle, MCP, policy, and mock tests:
  passed.
- Verified dependency pair: Claude Agent SDK `0.3.220`, with bundled Claude
  Code `2.1.220`.
- Community-run live Claude pair: **passed in both arms**.
- Observed on one Opus 5 fixture pair: **81.44% less fresh input + output**,
  **82.77% lower provider-reported cost**, and **70.83% lower end-to-end time**.

Codex benchmark figures do not transfer to Claude. The published Claude result
comes from its own reproducible paired RAW and Lattice run with equal model,
effort, task, repository state, limits, usage accounting, and independent
pristine-test verification. It remains one fixed-task community reproduction,
not a universal claim. See the
[sanitized Opus 5 record](evidence/community-run-claude-opus-5.md).

## Install the unified Beta package

The package is hosted as a GitHub Release asset. npm is only the local package
installer; no npm account or login is required.

```sh
npm install --global https://github.com/moulwyse/lattice/releases/download/v0.2.0-claude-beta.1/lattice-v2-0.2.0-claude-beta.1.tgz
lattice --version
```

This installs `lattice` and its compatibility alias `lattice-v2`. There are no
separate Claude-specific global packages: the single installation contains
both the Codex and Claude Code adapters, while integrations remain opt-in.

Alternatively, build the same package from source:

```sh
git clone https://github.com/moulwyse/lattice.git
cd lattice
npm ci
npm run build
npm link
lattice --version
```

## Enable for one repository

Run these commands inside, or point `--workspace` at, the repository where
Claude Code should use Lattice:

```sh
lattice integration claude enable --workspace .
lattice integration claude status --workspace .
lattice claude
```

Enable writes only project-scoped `.mcp.json`,
`.claude/settings.local.json`, and an ownership receipt under
`.lattice/`. Existing MCP servers, settings, and hooks are preserved. A
different server already named `lattice` is never overwritten.

The interactive path provides read-only bounded context and Lattice-first
hooks while Claude Code retains its native edit tools. The stronger
transactional path is explicit:

```sh
lattice run "Make all existing tests pass" --worker claude \
  --model claude-opus-5 --reasoning-effort high --max-budget-usd 1
```

The direct worker disables native filesystem tools, accepts only the canonical
Lattice protocol, applies edits in an isolated Git worktree, and records
provider-reported usage and cost. `--max-budget-usd` is a total SDK budget for
the complete Lattice run, including repair turns.

## RAW bypass

```sh
lattice claude --raw
```

RAW launches the same SDK-bundled Claude Code with a strict empty MCP
configuration for that child process. It does not uninstall Lattice, edit
project configuration, or disable the Codex integration.

For paired evaluation, also use isolated sessions, clean tool state, fresh
repository copies, pinned model and effort, equal budgets, and no artifact reuse
between arms.

## Disable and uninstall

Disable the project integration first:

```sh
lattice integration claude disable --workspace .
```

Disable removes only MCP and hook entries that still match Lattice's ownership
receipt. Changed or unrelated user configuration is preserved. Repeat it for
every repository where the Beta was enabled.

Uninstall the single package only when you no longer want either provider path:

```sh
npm uninstall --global lattice-v2
```

## Model and effort synchronization

Direct Claude runs resolve settings in this order:

1. `--model` and `--reasoning-effort`;
2. `providers.claude` and provider-neutral values in `lattice.config.json`;
3. recent project hook-captured Claude session settings;
4. optional adaptive policy;
5. Claude defaults.

Interactive `/model` changes immediately control Claude Code. Documented hooks
do not guarantee that every mid-session model switch reaches a separately
launched transactional worker, so reproducible runs must pin model and effort.

## Local verification without a model call

```sh
npm ci
npm run build
npm test
npm run benchmark
npm pack --dry-run
```

The mock benchmark validates the local pipeline only. It is not evidence of
Claude quality, token savings, latency savings, or cost savings.

Further reading:

- [Trust boundary and compatibility](claude-code-integration.md)
- [Community-run Opus 5 evidence](evidence/community-run-claude-opus-5.md)
- [Broader live-evaluation protocol](claude-code-live-evaluation.md)
- [Claude Code OSS project brief](claude-for-oss.md)
- [Prerelease notes and release gate](claude-code-beta-release.md)
