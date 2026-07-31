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

Handles are opaque and session-bound. A response cannot introduce an arbitrary
path. Operations and line ranges must be permitted by the matching grant.

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
