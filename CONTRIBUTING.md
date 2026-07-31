# Contributing to Lattice

Thank you for helping improve Lattice. Lattice was originally created and
developed by Moulwyse.

## Before opening work

1. Search existing issues and discussions.
2. For a substantial behavior, provider, persistence, or protocol change, open
   a proposal first.
3. Keep each pull request focused and explain its security and compatibility
   impact.
4. Never include credentials, personal paths, private repositories, provider
   session state, model transcripts, `.lattice/` data, or customer material.

Security vulnerabilities follow [SECURITY.md](SECURITY.md), not this workflow.

## Local development

Requirements: Node.js `^20.19.0` or `>=22.12.0` and Git.

```sh
npm ci
npm run build
npm test
npm run lint
npm run format:check
npm run scan:public
npm run package:check
```

Tests must be deterministic and credential-free by default. Live-provider tests
must be opt-in, hard-capped, clearly labeled, and safe when credentials are
absent. Use synthetic fixture names and values.

## Pull requests

A pull request should include:

- the problem and scope;
- the approach and important tradeoffs;
- exact verification commands and results;
- new or changed security, privacy, or provider behavior;
- documentation and tests for public behavior;
- a statement that the diff contains no private artifacts.

Do not silently weaken repository-boundary checks, fingerprint validation,
command allowlists, integration ownership checks, or telemetry redaction.

## Compatibility

The public API and storage formats are not stable before 1.0. Changes to CLI
flags, MCP schemas, persisted metadata, package name, or provider settings must
include a migration note. The package name `lattice-v2` and MCP server name
`lattice-v2` are temporarily retained for compatibility even though the public
project name is Lattice.

## Licensing

Unless explicitly marked otherwise, intentionally submitted contributions are
provided under the Apache License 2.0 as described in section 5 of that license.
Do not submit material you do not have the right to contribute.

## Conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
