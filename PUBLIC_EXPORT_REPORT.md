# Lattice public export report

Prepared for Moulwyse. This report describes the local export only. It is not a
publication record or a legal opinion.

## 1. Source directory inspected

The inspected source was the existing private source repository. Its local path
is intentionally withheld from the public export.

- Git HEAD: `a3323621b767cf47752ec7a0680ac833c93c85e3`
- Existing private remote: present in the source repository, not copied, and
  intentionally redacted from this public report.
- The source already contained modified and untracked work before export.
- Pre-export content fingerprint: 83 non-generated files,
  SHA-256 `70b7d2224fc959ce49ffcf35a11cd68787c4bf4f20bc48dc4ef9d5a21b394d48`.
- Post-export fingerprint is identical. The original repository content was not
  modified by this export.

The fingerprint excludes Git internals, dependency installs, compiled output,
coverage, and `.lattice/` runtime state. Git status was inspected before and
after; no export-owned change appeared in the original.

## 2. Public-export directory created

A separate sibling directory, `work/lattice-public`, was created. It contains no
`.git` directory and is not a Git repository.

## 3. Files copied

An explicit allowlist copied source needed to build and test the project:

- `src/`;
- `tests/`;
- `fixtures/`;
- `tsconfig.json`;
- `vitest.config.ts`;
- `package.json` and `package-lock.json`;
- selected architecture/protocol documentation, subsequently rewritten for the
  public boundary.

Sixty-eight source files remain byte-identical to the inspected source,
including the runtime implementation, Codex integration implementation,
fixtures, and the pre-existing test suite.

## 4. Files excluded

The following were not copied:

- original `.git/` history and remote metadata;
- `.lattice/` indexes, tasks, handoffs, logs, benchmarks, cache, and worktrees;
- `node_modules/`, `dist/`, coverage, build output, caches, archives, and logs;
- the source repository's local Codex configuration and all user-level Codex
  state;
- the working `lattice.config.json`;
- a private rewrite report;
- internal architecture and integration assessment documents;
- private benchmark raw data, model transcripts, raw telemetry, recordings, and
  provider credentials (none were copied).

No ignored or untracked item was copied merely because it existed.

## 5. Files modified

Ten copied paths were deliberately changed:

- `.gitignore` and `.latticeignore` were replaced with public-safe generated and
  sensitive-state exclusions;
- `README.md` was rewritten as the public entry point;
- `docs/architecture.md`, `docs/protocol.md`, and
  `docs/persistence-schemas.md` were rewritten without internal assessment
  material;
- `package.json` and `package-lock.json` received public release version and
  metadata;
- `src/cli.ts` received `--version`/`--about` authorship output;
- `src/mcp-server.ts` received the public release version.

No context, transaction, provider, or verification behavior was intentionally
removed.

## 6. New documentation created

The export adds:

- installation, quick-start, configuration, providers, security, limitations,
  evaluation, architecture, protocol, persistence, and troubleshooting guides;
- contribution, conduct, security-reporting, support, trademark/fork, citation,
  changelog, dependency, third-party-notice, and release-checklist files;
- issue and pull-request templates;
- a safe configuration example;
- local format and public-export scanners;
- build/test, quality, dependency-review, security-scan, and release-preparation
  workflows that do not publish.

## 7. Attribution locations

The statement “Lattice was originally created and developed by Moulwyse.” and
the verified author link `https://github.com/moulwyse` appear in the public
identity documents. Attribution is present in:

- README;
- NOTICE;
- AUTHORS;
- CITATION metadata;
- package metadata;
- CLI `--version` and `--about`;
- contribution and release documentation.

The intended canonical repository is consistently
`https://github.com/moulwyse/lattice`.

## 8. License information

The project source is prepared under the standard Apache License 2.0. The
export includes:

- full `LICENSE` text;
- `NOTICE` with original-project attribution;
- Apache-2.0 package and citation metadata;
- project-name/fork guidance that makes no registered-trademark claim.

Moulwyse must still confirm ownership and the right to publish every source and
fixture file. This preparation is not legal advice.

## 9. Dependency and license findings

Direct runtime dependencies are `@openai/codex-sdk`, `commander`, `execa`, and
`zod`; direct development dependencies are `@types/node`, `typescript`, and
`vitest`. Exact requested and locked versions, sources, licenses, and
compatibility caveats are in `DEPENDENCIES.md`.

Automated lockfile inventory found 111 non-root entries and no missing declared
license field:

- MIT: 80;
- Apache-2.0: 12;
- MPL-2.0: 12;
- ISC: 5;
- BSD-3-Clause: 1;
- 0BSD: 1.

The clean platform install added 75 applicable packages and `npm audit` reported
0 known vulnerabilities. Metadata review is not a substitute for manual or
legal license review.

## 10. Build result

Pass.

- Environment: Windows, Node.js `v24.18.0`.
- Clean documented install: `npm ci` completed.
- Packages installed/audited: 75/76.
- Vulnerabilities reported by npm: 0.
- `npm run build`: passed.
- `npm run lint` (`tsc --noEmit`): passed.
- `npm run format:check`: final clean rerun passed, 118 text files checked.

Build and tests ran in a disposable sibling copy so `lattice-public` remained
free of `node_modules/`, `dist/`, and runtime artifacts.

## 11. Test result

Pass.

- Test files: 16 passed, 0 failed.
- Tests: 420 passed, 2 skipped, 0 failed (422 discovered).
- Duration reported by the final post-runtime Vitest rerun: 47.18 seconds.
- The skips are environment-conditional filesystem/platform tests.
- Added public-metadata tests verify package attribution, publication disabled,
  exact `--version`, and exact `--about`.

Additional behavior checks:

- `lattice --version`: passed;
- `lattice --about`: passed;
- `lattice doctor`: exited successfully and reported real environment state;
- example configuration JSON: parsed successfully;
- mock reset-token benchmark: `passed`, changed 2 fixture files, no model usage;
- `npm pack --dry-run`: passed, inspected 111 package files, published nothing.

No live Codex inference was performed.

## 12. Secret-scan result

Pass. `scripts/scan-public-export.mjs` inspected the complete export for common
provider/GitHub/cloud token shapes, private-key headers, bearer values,
credential-like assignments, private configuration filenames, generated/raw
artifact paths, and suspicious structured-data fields. It produced no blocking
finding and modified or deleted nothing.

The scanner is report-only and is also wired into a read-only GitHub workflow.
It is defense in depth, not proof of absence.

## 13. Privacy-scan result

Pass. The scanner checked every exported file name and every text file for:

- personal absolute user paths;
- `.lattice/`, `.codex/`, Git history, build/dependency/cache directories;
- transcript, recording, request/response payload, session-dump, raw telemetry,
  log, archive, and database artifacts;
- structured fields associated with raw prompts, conversations, tools,
  authorization, cookies, credentials, billing, and provider sessions.

Narrow reported exemptions are limited to implementation/test vocabulary in
`src/` and `tests/`, plus the explicit synthetic
`tests/mcp-server.test.ts` path for an `example` user. These exemptions do not
disable secret-value or personal-path scanning.

## 14. Remaining manual-review items

Before publication, Moulwyse must:

- confirm IP ownership and the Apache-2.0 licensing decision;
- manually approve all 121 final exported files and the package dry-run list;
- enable and test GitHub private vulnerability reporting;
- replace the Code of Conduct private-contact placeholder with a consented,
  tested private channel;
- run GitHub-hosted workflows and platform secret scanning;
- verify branch protection, Actions permissions, labels, and moderation;
- test documented Node.js 20/22 CI jobs on GitHub;
- decide whether and when npm publication should ever be enabled;
- back up and live-test optional Codex integration recovery on each claimed OS;
- approve any external repository creation, remote, push, announcement, or
  funding account.

## 15. Experimental features

- transparent Codex launcher, hook, MCP, session-sync, and sidecar integration;
- adaptive model policy;
- exact verified-patch cache;
- compatibility behavior around current Codex configuration formats.

These features are labeled experimental in the README and provider/security
documentation.

## 16. Unsupported features

No Claude Code, Gemini, Cursor, Grok, or other provider adapter is included.
Architecture portability is not represented as implementation. There is no
hosted service, enterprise control plane, SLA, automatic updater, or npm release.

## 17. Known limitations

- Codex SDK support is beta and was not live-tested during export validation.
- Context selection can omit relevant code.
- Fingerprints and passing tests do not prove semantic or security correctness.
- Verification commands can execute scripts from the target repository.
- Worktrees are not operating-system or network sandboxes.
- Provider usage metadata can be absent or change meaning.
- Performance savings vary; the bundled mock benchmark is functional evidence
  only and supports no general token/latency claim.
- CLI, MCP, package-identifier, and persistence compatibility are not stable
  before 1.0.
- Automated privacy/secret and license-metadata scans require human review.

See `docs/limitations.md` for the full list.

## 18. Suggested GitHub repository description

> Open-source context and execution layer for coding agents, originally created
> by Moulwyse.

## 19. Suggested repository topics

- `coding-agents`
- `ai-agents`
- `codex`
- `developer-tools`
- `context-management`
- `verification`
- `mcp`
- `open-source`

`claude-code` is intentionally excluded because this repository has no Claude
Code adapter.

## 20. Intended package name

The public project name is **Lattice**. The package name and MCP server
identifier remain `lattice-v2` temporarily to preserve compatibility with the
working implementation. The local release version is `0.1.0`.

`package.json` has `"private": true`; no npm package is intended or authorized
for publication in this step.

## 21. Exact human-controlled next steps

From PowerShell, before Git initialization:

```powershell
Set-Location .\work\lattice-public
npm ci
npm test
npm run lint
npm run format:check
npm run scan:public
npm run package:check
node .\dist\cli.js --version
node .\dist\cli.js --about
node .\dist\cli.js doctor --workspace .
```

Then complete every blocking manual item in `RELEASE_CHECKLIST.md` and inspect
all hidden files. Only after explicit approval from Moulwyse:

```powershell
git init -b main
git add .
git diff --cached --check
git status --short
git commit -m "Initial public release of Lattice"
```

After Git initialization, the scanner must be told that local `.git/` metadata
is expected:

```powershell
$env:LATTICE_ALLOW_GIT_METADATA='1'
npm run scan:public
Remove-Item Env:\LATTICE_ALLOW_GIT_METADATA
```

Repository creation and publication are separate external actions. Review the
staged commit once more, create `moulwyse/lattice` through a human-controlled
GitHub session, add the exact repository URL as `origin`, and push only after a
second explicit approval. Do not enable npm publication as part of that push.

## 22. Explicit confirmation that nothing was published

Nothing was published. No Git repository was initialized in `lattice-public`;
no remote was created or changed; no commit was created; no Git push, npm
publish, GitHub repository creation, form submission, message, upload, or
deployment occurred.

## Final summary

Completed: separate allowlisted export, authorship, Apache-2.0 materials,
governance/security documentation, scanners, workflows, clean build, full local
tests, CLI checks, mock benchmark, complete transitive dependency inventory,
file-by-file review, final manifests, and package dry run.

Excluded: original history, user/private configurations, runtime state,
dependencies, compiled output, assessments, raw evaluation material, and all
unsupported provider ports.

Failed during the final audit: the first `npm test` run exposed one invalid test
assumption that terminated Windows PIDs cannot be reused. The test still
observed all ten launches and no leaked process. After removing only that
platform-invalid uniqueness assertion, the complete suite passed: 16 test files,
420 passed tests, 2 skipped, 0 failed. No final build, test, CLI, benchmark,
scan, audit, formatting, or packaging check fails.

Manual review: IP/license confirmation, complete human file review, private
reporting/contact setup, hosted CI/secret scanning, native macOS/Linux
validation, and every publication action.

Safety assessment: the 121-file local export is **READY FOR HUMAN APPROVAL**.
Thirteen legal, ownership, contact, platform, and publication decisions remain
human-blocked. It is not yet approved for publication or Git initialization.

## 23. Final pre-release audit addendum

The 2026-07-31 final audit read every exported file and all lockfile entries,
reproduced the original 83-file fingerprint and unchanged Git state, rebuilt a
111-entry dependency inventory, hardened workflow action pinning and checkout
credentials, corrected documentation metadata, strengthened the public scanner,
and created `FINAL_RELEASE_AUDIT.md`, `RELEASE_CHECKLIST_STATUS.md`,
`DEPENDENCY_INVENTORY.csv`, `PUBLIC_FILE_REVIEW.csv`, and
`PUBLIC_FILE_MANIFEST.sha256`.

The final clean validation environment was Windows NT 10.0.26200.0, Node.js
`v24.18.0`, npm `11.16.0`, Git `2.55.0.windows.3`, and PowerShell
`5.1.26100.8875`. Exact command durations, the initial test finding and fix,
complete package review, workflow review, scanner findings, modified-file list,
and human blocks are preserved in `FINAL_RELEASE_AUDIT.md`.

No live provider inference occurred during the initial audit, and no publication
or irreversible action occurred.

## 24. Post-audit runtime verification

At Moulwyse's later explicit request, the public export was tested against an
authenticated official Codex installation on Windows. Direct MCP, isolated
launcher/MCP/hook/session-sync enable-and-cleanup, one live CLI/MCP smoke test,
and one live locked-SDK fixture benchmark passed. Exact bounded results and
usage are recorded in `FINAL_RELEASE_AUDIT.md`; they are owner-run compatibility
evidence, not independent performance validation.

Darwin ARM64 and Linux x64 lockfile resolution also passed in disposable
installs. Native macOS/Linux execution was unavailable and remains untested.
Documentation now states that automatic persistent-PATH launcher/hook setup is
Windows-only, while macOS/Linux use manual stdio MCP registration. The hosted
CI definition now covers Ubuntu, Windows, and macOS on Node.js 20 and 22 but has
not run. A final clean rerun passed scan, format, install, build, 420 tests with
2 skips, lint, a 111-file package dry run, and audit with zero vulnerabilities.
Nothing was published, uploaded, committed, pushed, or deployed.
