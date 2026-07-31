# Troubleshooting

## `doctor` reports no repository

Run it from inside a Git repository or pass an explicit path:

```sh
lattice doctor --workspace /path/to/repository
```

For a non-Git project, create a reviewed `lattice.config.json` at the intended
project root. Do not put the marker in a home directory or broad parent folder.

## Automatic indexing is refused as unsafe

Lattice refuses filesystem roots, a user's home directory, and broad shared
home roots. Move the project into a dedicated repository directory. Do not
disable the check just to index an entire home.

## Codex authentication is unavailable

The mock and manual workflows still work. For the direct Codex worker, verify
the official tooling separately:

```sh
codex login status
lattice doctor
```

Do not paste a credential into project configuration.

## The requested model or effort fails

An accepted CLI string does not prove account availability. Remove explicit
overrides to inherit provider configuration, or select an identifier documented
by the currently installed provider:

```sh
lattice run "<task>" --worker codex
```

Run `lattice doctor` to see which setting source won.

## Patch rejected as stale or unauthorized

The repository changed after context was granted, or the worker referenced an
unknown edit handle. Start a fresh task or allow Lattice to request a refreshed
page. Do not bypass fingerprint validation.

## Verification command rejected

Only documented commands are allowed. Prefer an existing repository script such
as `npm test` or `npm run build`. Expanding the allowlist is a code change with
security implications.

## Worktree creation fails

Check:

```sh
git status --short
git worktree list
git config --get core.autocrlf
```

Resolve stale worktrees using normal Git procedures. Do not recursively delete
computed worktree paths. Non-Git mode has fewer isolation guarantees.

## Codex integration is configured but inactive

The automatic transparent integration commands are currently Windows-only. On
macOS or Linux, inspect the manual registration with `codex mcp list`; do not
expect Lattice-owned launcher or hook state.

“Configured” means Lattice-owned shim, hook, or MCP state was found. “Active”
requires an observed Lattice context grant in the repository-scoped sidecar.

```sh
lattice integration codex doctor --workspace .
lattice integration codex status --workspace .
lattice sidecar status --workspace .
```

The integration is Lattice-first, not universal interception. A Codex turn can
still use native repository tools after the first context attempt.

## Integration disable reports pending cleanup

Do not manually wipe the Codex configuration directory. Read the ownership
warning, close active sessions, rerun:

```sh
lattice integration codex disable
lattice integration codex doctor
```

If the state is still ambiguous, preserve the files and open a sanitized bug
report. Remove absolute paths, credentials, session data, and hook payloads.

## Public-export scan fails

The scanner prints category and relative path, never deletes the file. Inspect
each finding. Generated directories (`.lattice/`, `dist/`, `node_modules/`,
coverage), raw logs/transcripts, personal absolute paths, and credential-like
values must be removed from the export, not merely added to an ignore file.

Some test/source identifiers are classified as implementation vocabulary and
reported as exemptions. Secret-value and personal-path checks still apply to
those files.
