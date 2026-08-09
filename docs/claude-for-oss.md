# Lattice for Claude Code — OSS project brief

Lattice is an Apache-2.0 open-source execution system for repository-scale
coding tasks. It moves deterministic repository discovery, bounded context
selection, edit authorization, patch application, and verification outside the
model loop so the coding model can focus on the task itself.

Repository: <https://github.com/moulwyse/lattice>

## Claude Code integration

The main `lattice-v2` package contains both the Codex and Claude Code adapters.
Claude Code remains an opt-in Beta and does not replace the stable Codex path.
The integration includes:

- project-scoped MCP and lifecycle hooks;
- interactive `lattice claude` launch and explicit `--raw` bypass;
- a transactional Claude Agent SDK worker with isolated Git worktrees;
- model, effort, cancellation, and hard USD-budget controls;
- provider-reported token, cost, and latency telemetry;
- reversible enable, disable, and uninstall paths;
- credential-free contract tests and spend-gated live benchmark drivers.

The checked dependency pair is Claude Agent SDK `0.3.220` with bundled Claude
Code `2.1.220`. API, model, hook, and MCP behavior may change, which is why the
integration is visibly labeled Beta.

## Current public evidence

A community member ran the public paired driver on a separate machine using
`claude-opus-5` at `high` effort and a $1 cap per arm:

| Metric | RAW Claude Code | Lattice | Reduction |
| --- | ---: | ---: | ---: |
| Fresh input + output | 21,020 | 3,901 | **81.44%** |
| Provider-reported cost | $0.2802955 | $0.0482850 | **82.77%** |
| End-to-end time | 46.624 s | 13.598 s | **70.83%** |

Both independent pristine-test verification commands passed. The legacy report
did not preserve individual test counts or patch identity, so neither is
claimed. The complete sanitized record and limitations are published in
[`docs/evidence/community-run-claude-opus-5.md`](evidence/community-run-claude-opus-5.md).

This is one fixed-task reproduction, not a universal savings claim. Broader
validation requires evaluator-selected tasks, all failures, paired statistics,
and a predeclared non-inferiority rule.

## Why Claude for OSS would help

Continued Claude access would be used to maintain the public integration rather
than to hide a private evaluation:

1. test Claude Code and Agent SDK compatibility as versions change;
2. run capped paired evaluations across a larger public task set;
3. publish successes, failures, provider usage, cost, and acceptance evidence;
4. improve Windows, macOS, and Linux installation and removal paths;
5. keep the Beta useful to contributors without requiring them to finance all
   compatibility testing individually.

No contributor is asked to share an API key. Raw provider sessions, local
paths, credentials, and private source remain excluded from public evidence.

## Install and inspect

```sh
npm install --global https://github.com/moulwyse/lattice/releases/download/v0.2.0-claude-beta.1/lattice-v2-0.2.0-claude-beta.1.tgz
lattice benchmark --worker mock
lattice integration claude enable --workspace .
lattice claude
```

The first benchmark is deterministic and makes no model call. Users can bypass
Lattice without uninstalling it through `lattice claude --raw`.

Contact and support routes are listed in the repository's
[Support section](../README.md#support).
