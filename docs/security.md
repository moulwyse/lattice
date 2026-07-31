# Security and privacy guide

This guide complements the vulnerability-reporting policy in
[`../SECURITY.md`](../SECURITY.md).

## Data flow

Lattice can read:

- tracked and untracked files inside the discovered repository;
- Git status, branch, diff, attributes, and worktree information;
- repository package scripts and configuration;
- local Lattice state beneath `.lattice/`;
- observed Codex session model settings when the optional integration is active.

Depending on the selected worker, bounded source pages, task text, repository
maps, prior failures, and patch protocol data can be sent to a remote provider.
Do not assume “bounded” means “non-sensitive.”

## Local state

`.lattice/` may contain indexes, sessions, task states, handoffs, edit grants,
worktree records, logs, benchmarks, sidecar state, and verified patches. Some
files intentionally contain exact source excerpts or diffs. Protect the
directory like source code and keep it out of commits, bug reports, recordings,
and public evaluation data.

Lattice hashes some values for integrity, but hashing does not make all metadata
anonymous.

## Repository boundaries

Repository discovery rejects dangerously broad automatic roots. File reads use
canonical-path checks intended to stop relative traversal and symlink/junction
escapes. Patch changes are bound to repository identity, base commit,
fingerprints, context epoch, and edit grants.

These controls reduce accidental scope expansion. They do not make untrusted
code safe to execute.

## Command execution

Verification runs repository commands from a narrow allowlist. Those commands
can execute arbitrary scripts defined by the target repository. Run Lattice
only on repositories you trust, in a disposable environment, without ambient
production credentials.

## Remote providers

Before a live run:

1. read the provider's current data and retention terms;
2. use a dedicated low-privilege account and hard spending limit;
3. select a repository with no secrets;
4. confirm model and effort settings in `doctor`;
5. record every external model invocation in evaluations;
6. review the resulting diff and verification output.

Lattice does not guarantee that provider-side caches, logs, or training controls
match local expectations.

## Transparent integration

`lattice integration codex enable` can modify user-level integration state. The
implementation uses ownership markers and tries to preserve non-Lattice state,
but an interrupted process or future provider format change can leave partial
configuration.

Automatic persistent-PATH integration is currently Windows-only. On macOS and
Linux, use the explicitly documented manual MCP registration instead; it does
not install the launcher or hooks. Do not improvise shell-profile edits from the
Windows instructions.

Before enabling:

- close unrelated Codex sessions;
- back up the reported user configuration files;
- run the integration doctor;
- review PATH, shim, hook, and MCP paths;
- know how to invoke the raw Codex bypass.

After disabling, inspect warnings and run the doctor again. Never recursively
delete a user configuration directory to remove the integration.

## Verified-patch cache

The experimental cache can reuse a patch only when its task and repository
fingerprints match the cache key and verification still passes. Cached patches
are local sensitive artifacts. Disable with `--no-verified-cache` for
independent evaluations or whenever provenance is uncertain.
