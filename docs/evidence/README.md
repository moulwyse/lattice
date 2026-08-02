# Public evidence

This directory contains sanitized, reproducible evidence for Lattice's local
credential-free checks. It does not contain raw model conversations, provider
sessions, private repository content, or claims about general model quality.

## Reproduce the v0.1.0 smoke test

From the tagged source or installed GitHub release:

```sh
lattice benchmark --worker mock
```

The command creates a temporary synthetic Git repository, selects bounded
context, applies two known edits through the normal transaction path, runs the
fixture's acceptance checks, and reports `Status: passed` when the local
pipeline works.

See [`mock-benchmark-v0.1.0.json`](mock-benchmark-v0.1.0.json) for the sanitized
release-candidate result. Timing fields are omitted because a single local run
does not support a performance claim. The full evaluation standard remains in
[`docs/evaluation.md`](../evaluation.md).

## Reproduce the safety frontier

From a source checkout with dependencies installed:

```sh
npm run evidence:frontier
```

The command executes 240 deterministic cases covering task-risk classification,
fail-closed provider responses, repository path confinement, exact patch
lowering, and the live-evaluation budget guard. It then regenerates the
sanitized [`economy-frontier.json`](economy-frontier.json) summary. CI rejects a
change when the checked-in summary no longer matches the executable cases.

This evidence makes no model call. It validates local safety and control
behavior; it does not establish model quality or token, latency, or cost
savings.
