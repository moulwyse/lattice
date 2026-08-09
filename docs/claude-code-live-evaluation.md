# Claude Code Beta live-evaluation protocol

This is a protocol for a future paid evaluation, not a benchmark result.

## Required controls

Every paired RAW and Lattice task must use the same pinned Claude model and
effort, independent sessions, clean tool state, fresh copies of the same base
commit, identical task and acceptance criteria, equal hardware/network policy,
dependencies, permissions, timeout, concurrency, and hard USD cap. No
artifacts, caches, messages, summaries, traces, or manual intervention may pass
between arms. Verified-patch reuse must be disabled.

Record every model call and attributable network request. Undisclosed external
inference invalidates the affected run.

## Metrics

Use provider-reported SDK usage summed across every call, including retries,
context turns, repair turns, and failed results when metadata is present.
Record fresh input, cached input, output, USD cost, wall-clock and provider
time, acceptance results, verification output, final diff, normalized patch
hash, errors, retries, permission denials, missing metadata, and tool/network
inventory.

## Analysis and publication

Treat results as paired observations. Publish successes and failures. Report
per-task ratios, median paired reduction, bootstrap confidence intervals, and
the four task-success cells: both pass, RAW only, Lattice only, both fail.
Agree on a non-inferiority margin before testing.

Do not publish a Claude savings percentage until artifacts make the paired
result reproducible and acceptance is independent of either agent. Label
owner-run evidence honestly; call it independent only when an external
evaluator controlled the run.

