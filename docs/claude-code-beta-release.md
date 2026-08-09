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
- a disclosed protocol and sanitized paired live evidence.

Verified locally with Claude Agent SDK `0.3.220` and bundled Claude Code
`2.1.220`. A sanitized community-run Opus 5 paired smoke test is included as
task-specific evidence: both arms passed, while Lattice observed 81.44% less
fresh input plus output, 82.77% lower provider cost, and 70.83% lower
end-to-end time. The legacy report did not preserve per-test counts or patch
identity, and the result is not a universal performance claim.

> Beta warning: Claude Code, Agent SDK, hooks, MCP configuration, models, and
> behavior may change.

## Release gate

- [x] unified package compiles;
- [x] targeted Claude and stable Codex integration tests pass;
- [x] complete unified suite passes;
- [x] mock benchmark passes without a model call;
- [x] npm package dry-run contains no private or generated state;
- [x] public export and secret scans pass;
- [ ] GitHub Actions matrix passes after an authorized push;
- [ ] create tag `v0.2.0-claude-beta.1`;
- [x] support registry-free npm installation from the GitHub prerelease tag;
- [ ] create a GitHub prerelease, not a stable release.
