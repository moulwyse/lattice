# Architecture

Lattice separates repository understanding, worker inference, and write
authority. The central design goal is to make context grants and patch authority
bounded, inspectable, and verifiable.

## Components

### Repository discovery

`repository.ts` finds the nearest Git root or an explicit
`lattice.config.json` marker. It rejects dangerously broad automatic roots such
as a filesystem root or user home.

### Index and task compiler

`indexer.ts` records paths, fingerprints, imports, exports, symbols, test/config
classification, and package scripts. `task.ts` compiles a goal into a versioned
task IR with scope, risk, budgets, invariants, acceptance criteria, and allowed
verification commands.

### Context kernel

`context.ts` ranks repository records for a task and creates bounded
`ContextPage` objects. Pages carry exact line ranges, content, provenance,
token estimates, and file fingerprints. A worker can request additional pages
through a versioned context-fault message.

### Edit grants and patch lowering

The provider sees opaque edit handles rather than unrestricted paths.
`edit-grants.ts` binds each handle to a task, session, repository identity, base
commit, context epoch, path, fingerprint, and allowed operations.

`patch-lowerer.ts` validates the provider response and lowers authorized
changes into an internal patch IR. Stale, unknown, out-of-scope, or structurally
invalid changes are rejected before transaction execution.

### Transaction and verification

`transaction.ts` applies changes against expected fingerprints, preferentially
inside an isolated Git worktree. Verification commands are matched against the
allowlist and executed with bounded process controls. The result contains
evidence for acceptance criteria, a unified diff, and telemetry.

### Workers

`worker.ts` defines the worker interface and includes:

- a deterministic fixture-specific mock;
- a Codex SDK worker with a versioned prompt/response protocol;
- manual handoff through the persistence layer.

The provider adapter does not own repository mutation. It proposes a response
that the Lattice runtime validates.

### Persistence

`persistence.ts` stores versioned indexes, tasks, sessions, handoffs, edit
grants, transaction state, logs, benchmarks, and verified patches below
`.lattice/`. This directory is repository-local sensitive runtime state.

### Optional Codex integration

The transparent integration consists of ownership-checked launcher shims,
Codex hooks, an official MCP registration, a repository-scoped sidecar, and
session-setting synchronization. It is an adapter around the same repository
and context primitives, not a separate authority model.

## Runtime sequence

1. discover repository;
2. compile task;
3. build or load an index;
4. grant initial context and edit handles;
5. run or continue the worker;
6. normalize and validate the response;
7. satisfy bounded context faults or lower the patch;
8. execute a fingerprint-checked transaction;
9. run allowlisted verification;
10. persist terminal state, evidence, diff, and diagnostics.

Every runtime transition is recorded. Cancellation, protocol repair, context
faults, and verification failure have explicit states rather than being folded
into a successful response.

## Trust boundaries

Lattice trusts the operator to choose a repository and provider. It treats
worker output as untrusted structured input. It relies on Git and the local
operating system for filesystem/process isolation and on repository tests for
semantic validation.

The optional provider integration is not a sandbox. Native tools can still read
files outside the Lattice context path if the surrounding agent is permitted to
do so. See [security](security.md) and [limitations](limitations.md).

## Compatibility identifiers

The package and MCP server currently retain the identifier `lattice-v2` to avoid
breaking existing local setups. Public release versioning begins at 0.1.0. Any
future rename requires a documented migration.
