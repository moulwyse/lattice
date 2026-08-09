# Claude Code Beta: trust boundary and compatibility

The provider-neutral Lattice core retains the local index, bounded context
grants, canonical patch protocol, fingerprint checks, isolated transaction,
acceptance verification, verified cache, and telemetry. The model worker,
session synchronization, project integration, and usage adapter are
Claude-specific.

## Two operating paths

- `lattice run ... --worker claude` is transactional. The Claude Agent SDK
  receives no native filesystem tools. It can request bounded context and
  propose a typed patch; Lattice validates and verifies the patch in an
  isolated Git worktree.
- `lattice claude` is interactive. Claude Code owns native tools and edits.
  Lattice provides read-only MCP context and hooks that require one Lattice
  attempt before ordinary repository access, then fail open if Lattice is
  unavailable. This is MCP-assisted context, not a claim that every native
  edit passes through Lattice's transaction layer.

## Project-scoped configuration

```sh
lattice integration claude enable --workspace .
lattice integration claude status --workspace .
lattice integration claude disable --workspace .
```

Enable creates or merges:

- `.mcp.json`: a local stdio server named `lattice`;
- `.claude/settings.local.json`: owned lifecycle and tool hooks;
- `.lattice/claude-integration.json`: an ownership receipt.

Writes are atomic and enable is idempotent. Existing settings are preserved.
Disable removes only entries that still match the receipt.

## Verified versions

The local suite uses Claude Agent SDK `0.3.220`, pinned exactly, with bundled
Claude Code `2.1.220`. The unified package supports Node.js `^20.19.0` or
`>=22.12.0`. No later Claude version is declared verified until the same suite
has been rerun.

The adapter uses explicit isolated settings, strict MCP configuration,
structured output for the canonical worker response, adaptive thinking when
supported, the low–max effort ladder, provider-reported usage and cost, and one
total `maxBudgetUsd` across all turns.

## Usage and cost accounting

For live Claude results, the adapter reads SDK metadata:

- fresh input = `input_tokens + cache_creation_input_tokens`;
- cached input = `cache_read_input_tokens`;
- total input = all input fields;
- output = `output_tokens`;
- cost = provider-reported `total_cost_usd`.

Lattice records each model turn, repair turn, failed result that carries usage,
elapsed time, and aggregate cost. Local indexing and patch verification use no
hidden external model.

## Validation boundary

Local tests establish implementation behavior only. They do not establish
Claude quality, savings, or non-inferiority. See the
[live-evaluation protocol](claude-code-live-evaluation.md).

