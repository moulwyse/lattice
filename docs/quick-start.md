# Quick start

This path exercises Lattice without a model account or private repository.

## 1. Install the release

```sh
npm install --global https://github.com/moulwyse/lattice/releases/download/v0.1.0/lattice-v2-0.1.0.tgz
```

Or clone the repository and build the exact source:

```sh
npm ci
npm run build
```

## 2. Inspect identity and environment

```sh
lattice --version
lattice --about
lattice doctor --workspace .
```

`doctor` can report that Codex authentication is unavailable. That does not
block the mock benchmark.

## 3. Run the deterministic benchmark

```sh
lattice benchmark --worker mock --workspace .
```

Expected behavior:

1. a temporary synthetic reset-token repository is created;
2. Lattice indexes it and grants bounded context;
3. the mock worker proposes two fixture-specific edits;
4. Lattice applies and verifies the edits;
5. the CLI reports `Status: passed` and an artifact location.

The benchmark is a functional smoke test, not a general AI benchmark and not
evidence of token savings.

## 4. Try manual handoff

From a disposable Git repository:

```sh
lattice run "Describe the small change to make" --worker manual
```

Lattice prints a request path and a response path beneath `.lattice/`. Review
the request before sharing it with any external model. Save only a response that
matches the documented protocol, then validate and continue:

```sh
lattice handoff validate <task-id>
lattice continue <task-id>
```

The manual workflow deliberately makes context transfer visible. The generated
files may contain private source and must not be committed or posted publicly.

## 5. Clean local artifacts

The `.lattice/` directory is runtime state. Keep it ignored. Remove it only
after confirming that no active session, worktree, or audit artifact is needed.
The public-export scanner reports runtime artifacts; it never deletes them.
