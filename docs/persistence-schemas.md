# Persistence schemas

Lattice writes runtime state beneath `<repository>/.lattice/`. These files are
private execution artifacts, not a public interchange format.

## Directory classes

| Directory | Purpose | Sensitivity |
| --- | --- | --- |
| `index/` | repository structure and fingerprints | repository metadata |
| `sessions/` | worker/session state and observed settings | provider and task metadata |
| `tasks/` | compiled task IR, transitions, evidence, diff | goals and source-derived data |
| `handoffs/` | manual request/response files | source excerpts and model output |
| `edit-grants/` | handle-to-path authority registries | paths and fingerprints |
| `worktrees/` | isolated transaction bookkeeping | repository state |
| `logs/` | local diagnostics | potentially sensitive |
| `benchmarks/` | local benchmark artifacts | task output and metrics |
| `cache/verified-patches/` | exact reusable verified patches | source diffs |

Never commit or publish this directory.

## Versioned records

Public TypeScript record definitions live in `src/types.ts`. Important
boundaries include:

- `TaskIR.schemaVersion = 2`;
- `RepositoryIndex.version = 2`;
- `ContextSnapshot.schemaVersion = 1`;
- `EditGrantRegistryIR.schemaVersion = 1`;
- provider and internal patch schema version 1;
- telemetry schema version 2.

Readers validate versions before use. Unknown versions should fail closed or
require an explicit migration.

## Integrity bindings

Persisted authority is bound to some or all of:

- repository identity;
- Git base commit;
- task and session identifiers;
- context epoch;
- raw SHA-256 file fingerprint and byte length;
- edit-grant mapping SHA-256;
- expected pre-edit content.

The bindings detect stale or substituted state. They are not encryption and do
not make persisted source private.

## Atomicity and cleanup

The implementation creates metadata directories inside the canonical
repository and rejects symlink/junction escapes. Transactions use isolated
worktrees when possible and keep explicit terminal state.

Operators should retain failed state only as long as needed for debugging.
Before sharing any repository copy, inspect and remove `.lattice/` through a
verified, repository-scoped operation. The public scanner reports its presence
but intentionally does not delete it.

## Compatibility

Persistence is not stable before 1.0. A release that changes a schema must add a
changelog entry and either provide a migration or clearly document that old
local state must be discarded.
