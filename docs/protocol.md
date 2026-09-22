# Worker protocol

The worker protocol is versioned structured data. A provider returns either a
bounded request for more context or a proposed patch. Provider output is
untrusted until normalized, schema-validated, and bound to edit grants.

## Context request

```json
{
  "schemaVersion": 1,
  "kind": "context_request",
  "requests": [
    {
      "reason": "Need the implementation of the failing function",
      "pathHint": "src/example.ts",
      "symbol": "example"
    }
  ]
}
```

`pathHint` and `symbol` are hints, not filesystem authority. The context kernel
decides whether and how to grant a page within task budgets.

## Patch response

```json
{
  "schemaVersion": 1,
  "kind": "patch",
  "patch": {
    "schemaVersion": 1,
    "summary": "Describe the bounded change",
    "changes": [
      {
        "editHandle": "E1",
        "operation": "replace_text",
        "replacements": [
          {
            "oldContent": "synthetic old text",
            "newContent": "synthetic new text"
          }
        ]
      }
    ],
    "verificationCommands": ["npm test"]
  }
}
```

Handles are opaque and session-bound. Operations and line ranges must be
permitted by the matching grant:

| Operation | Target | Permitted when |
| --- | --- | --- |
| `replace_text` | `editHandle` | any editable grant; `oldContent` must be unique and inside the granted range |
| `replace_file` | `editHandle` | the complete file was granted |
| `delete_file` | `editHandle` | the complete file was granted |
| `create_file` | `path` + `content` | the path is new, repository-relative, not ignored by Git, and has no hidden (dot) segment |

`create_file` is the only change that carries a path; it can never overwrite an
existing file. Hidden paths (`.envrc`, `.vscode/`, `.github/`, `.husky/`,
`.git/`, `.lattice/`, ...) are refused because tool configuration there can run
code on its own. Test pages are granted read-only, so existing tests cannot be
edited, but new test files can be created.

`replace_text` matches `oldContent` exactly first; if the granted file uses a
single line-ending convention (for example CRLF on a Windows checkout), LF-only
`oldContent`/`newContent` are converted to it. `replace_file` content is
likewise written with the file's own line endings.

## Verification and application

The transaction runs in an isolated Git worktree that reproduces the
workspace's uncommitted state and links its installed `node_modules`
directories, so verification sees the same sources and dependencies as the
user. A task passes when at least one allowlisted verification command ran and
every command exited with 0. The allowlist contains common `npm`/`npx` test,
lint and build commands plus the repository's own `test*`, `lint`, `check`,
`typecheck` and `build` package scripts.

Per-criterion evidence is informational: each clause of the goal is attributed
to named tests that share most of its vocabulary, and is reported as `passed`,
`failed`, or `unresolved`.

`lattice run` and `lattice continue` apply a passed patch to the workspace with
`git apply` after re-checking every source fingerprint; `--no-apply` only
verifies and prints the diff. Runs started in a subdirectory operate on the
repository root. A verification command that exceeds its deadline counts as a
failed verification (exit code 124).

## Patch revision

If lowering rejects a patch (for example `replace_text` source not found) or
its verification fails, the worker receives a `PATCH_REVISION` turn with the
rejection reason and a bounded detail (the lowering error, or the failing
command with the tail of its output) and returns a complete corrected patch or
a context request. At most two revisions are made, within the task's turn
budget. Manual handoffs record the rejection as a failed task.

## Normalization and repair

The Codex adapter accepts the canonical envelope and a deliberately limited set
of mechanically normalizable shapes. It records only hashes and structural
diagnostics needed to explain normalization. Invalid output receives at most
the configured number of repair turns; the runtime does not silently treat
invalid prose as a patch.

## Lowering

Lowering resolves each handle against a registry and produces internal changes
with repository identity, base commit, exact paths, and expected fingerprints.
The internal patch IR is separate from the provider protocol so provider
convenience cannot expand mutation authority.

## Versioning

Unknown schema versions fail closed. Backward compatibility before Lattice 1.0
is best effort and any protocol change must be documented in the changelog.

The canonical TypeScript definitions are in `src/types.ts`; Zod validation for
Codex responses is in `src/providers/codex/protocol.ts`.
