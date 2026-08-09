# Claude Code Beta prerelease

Planned version and tag: `0.2.0-claude-beta.1` /
`v0.2.0-claude-beta.1`.

Claude Code is an opt-in integration inside the single `lattice-v2` package.
The prerelease keeps the stable Codex path and default worker unchanged.

Included:

- direct Claude Agent SDK transactional worker;
- project-scoped MCP and lifecycle hooks;
- explicit model, effort, and total USD-budget controls;
- provider-reported per-turn usage and cost telemetry;
- reversible enable, disable, uninstall, and RAW bypass paths;
- local cross-provider tests and deterministic no-model smoke benchmark;
- a disclosed protocol for future paired live evaluation.

Verified locally with Claude Agent SDK `0.3.220` and bundled Claude Code
`2.1.220`. No live Claude inference benchmark is included, and no Claude
savings claim is made.

> Beta warning: Claude Code, Agent SDK, hooks, MCP configuration, models, and
> behavior may change.

## Release gate

- [x] unified package compiles;
- [x] targeted Claude and stable Codex integration tests pass;
- [x] complete unified suite passes: 444 passed, 2 skipped;
- [x] mock benchmark passes without a model call;
- [x] npm package dry-run contains no private or generated state;
- [x] public export and secret scans pass;
- [ ] GitHub Actions matrix passes after an authorized push;
- [ ] repository owner completes GitHub authentication;
- [ ] create tag `v0.2.0-claude-beta.1`;
- [ ] upload `lattice-v2-0.2.0-claude-beta.1.tgz` as a GitHub Release asset;
- [ ] create a GitHub prerelease, not a stable release.
