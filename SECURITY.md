# Security policy

## Supported versions

This repository is an early public export. Once version 0.1.0 is released, the
latest 0.1.x release will receive best-effort security fixes. Unreleased
commits, older snapshots, experimental integrations, and modified forks are not
covered by a support guarantee.

## Reporting a vulnerability

Do not open a public issue and do not paste exploit details, credentials,
private source code, model conversations, provider session data, or `.lattice/`
artifacts into a public channel.

The intended reporting channel is **GitHub private vulnerability reporting** on
the canonical repository. That feature must be enabled by the maintainer before
the repository is announced. If the “Report a vulnerability” button is absent,
do not disclose the report publicly; contact the maintainer through a private
channel already published on the maintainer's verified GitHub profile.

No security email address is invented in this export. Configuring and testing a
private reporting channel is a blocking manual release-checklist item.

Include:

- affected Lattice version or commit;
- operating system and Node.js version;
- minimal reproduction with secrets and personal paths removed;
- impact and preconditions;
- whether the optional Codex integration is enabled.

Acknowledgement and remediation times depend on maintainer availability. Please
allow time for triage before public disclosure.

## Security boundaries

Lattice is a local orchestration tool, not a sandbox:

- it reads files from a selected repository and can send selected context to a
  configured remote provider;
- it can run allowlisted repository verification commands;
- its local `.lattice/` directory can contain sensitive source excerpts, diffs,
  task goals, and diagnostics;
- agent-generated edits can still be incorrect or malicious;
- provider authentication is managed by the provider tooling, not stored in
  `lattice.config.json`;
- the optional transparent Codex integration changes user-level PATH, hooks,
  and MCP configuration only after an explicit enable command.

Use a low-privilege account, a disposable branch or clone, provider-side spend
limits, and repositories without production secrets. Review every diff.

## Public-export scanner

`npm run scan:public` checks the export for common credential patterns,
personal absolute paths, forbidden private-artifact directories, raw log or
transcript artifacts, and dangerous structured-data keys. It reports findings
and never modifies files.

The scanner distinguishes implementation vocabulary in source/tests from
serialized public artifacts. For example, a TypeScript type named
`system_prompt` can be necessary to parse provider input, while a checked-in
JSON record containing that field is a likely raw artifact. These narrow
source/test exemptions are reported by the scanner and do not exempt secret
values or personal paths.

Automated scanning cannot prove absence of secrets. Perform a manual review and
use the hosting platform's secret scanning before every release.

## Dependency and supply-chain policy

Install with `npm ci`, review lockfile changes, keep workflow permissions
read-only by default, and do not run untrusted pull-request code with secrets.
See [DEPENDENCIES.md](DEPENDENCIES.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
