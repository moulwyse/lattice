# Final pre-release audit

## Verdict

**READY FOR HUMAN APPROVAL.** The local release candidate passes every
locally verifiable check after documented safe corrections. This is not legal
approval and not publication approval: 13 checklist items remain
`BLOCKED: HUMAN`.

Nothing was published. No Git repository was initialized, no remote or commit
was created, and no push, npm publication, release, deployment, upload, form,
message, or external contact occurred.

## 1. Date, scope, path, and environment

- Audit date: 2026-07-31.
- Time zone: Asia/Baku (Azerbaijan Standard Time).
- Exact audited export path within the workspace: `work/lattice-public`.
- The host-absolute path is intentionally omitted from this public artifact to
  avoid publishing a local username; the logical path above uniquely identifies
  the audited directory in this workspace.
- Validation method: fresh disposable sibling copy with no `.git`,
  `node_modules`, `dist`, or `.lattice` at creation.
- Operating system: Windows NT 10.0.26200.0, AMD64.
- Node.js: `v24.18.0`.
- npm: `11.16.0`.
- Git: `2.55.0.windows.3`.
- PowerShell: `5.1.26100.8875`.
- Validation began at `2026-07-31T10:06:46.0448160Z`.

Lattice context search was attempted first, as required by the working method,
but automatic indexing refused an unsafe broad host root. The audit therefore
continued with ordinary read-only filesystem inspection and local commands.

## 2. Original repository integrity

The exact historical fingerprint algorithm from `PUBLIC_EXPORT_REPORT.md` was
rerun against the original source without modifying it:

- expected and observed non-generated files: 83;
- expected and observed aggregate SHA-256:
  `70b7d2224fc959ce49ffcf35a11cd68787c4bf4f20bc48dc4ef9d5a21b394d48`;
- expected and observed HEAD:
  `a3323621b767cf47752ec7a0680ac833c93c85e3`;
- existing pre-export dirty status: unchanged;
- export-owned modifications in the original: none;
- shared public files still byte-identical to the original: 68;
- copied files deliberately changed at the public boundary: 10;
- source files intentionally omitted from the public export: 5.

An initial comparison used a different aggregate construction that included
file sizes and therefore produced a non-comparable digest. No change was made;
the audit stopped, recovered the documented historical algorithm, and reproduced
the expected value exactly. No original `.git` history entered the export.

The export contains no `.git` directory. `git remote -v` exits 128 because the
directory is not a Git repository, so no remote exists there.

## 3. Reproducible command results

Commands were run in the disposable validation copy. Durations are wall-clock
measurements from the audit wrapper; tool-reported durations are also retained
where available.

| Command | Exit | Wall time | Exact result |
| --- | ---: | ---: | --- |
| `npm run scan:public` (before install) | 0 | 414 ms | `116 files`, all text, `0 blocking finding(s)`; narrow synthetic-email, protocol-vocabulary, and example-user-path exemptions reported |
| `npm ci` | 0 | 3,277 ms | `added 75 packages, and audited 76 packages`; `found 0 vulnerabilities` |
| `npm run build` | 0 | 1,984 ms | `tsc` completed with no diagnostics |
| first `npm test` | 1 | 52,185 ms | 15 files passed, 1 failed; 419 tests passed, 1 failed, 2 skipped; invalid uniqueness assertion observed 10 launches but only 9 unique, already-terminated Windows PIDs |
| targeted unchanged rerun | 0 | 4,733 ms | failing test passed once unchanged, supporting an intermittent PID-reuse diagnosis |
| final full `npm test` | 0 | 48,984 ms | 16 files passed; 420 tests passed, 2 skipped; Vitest duration 46.57 s |
| `npm run lint` | 0 | 1,797 ms | `tsc --noEmit` completed with no diagnostics |
| `npm run format:check` | 0 | 321 ms | all 116 clean-copy text files passed at that stage; completed export rechecked separately |
| `npm run package:check` | 0 | 961 ms | dry-run package inspection passed; 111 files |
| `npm audit` | 0 | 1,045 ms | `found 0 vulnerabilities` |
| `node .\\dist\\cli.js --version` | 0 | 160 ms | exact output below |
| `node .\\dist\\cli.js --about` | 0 | 172 ms | exact output below |
| `node .\\dist\\cli.js doctor --workspace .` | 0 | 670 ms | exact output summary below; no inference |
| `npm run benchmark` | 0 | 4,013 ms | mock status `passed`; 2 fixture files changed; no provider token usage |

The first test failure is not hidden. The test correctly verified ten completed
launches and no live child processes, but additionally assumed every terminated
Windows process would retain a globally unique PID. Windows may reuse a PID
after termination. `tests/codex-cli-passthrough.test.ts` was corrected to keep
the actual leak assertions (every observed PID is dead and the active set is
empty) while removing only that invalid platform assumption. The complete suite
then passed.

### Exact CLI output

`--version`:

```text
Lattice 0.1.0 by Moulwyse
```

`--about`:

```text
Lattice 0.1.0

Originally created and developed by Moulwyse.
Original author: https://github.com/moulwyse
Canonical repository: https://github.com/moulwyse/lattice
License: Apache-2.0
```

`doctor` returned JSON with Node `v24.18.0` and `ok: true`; Git available but
`repository: false`; worker `codex`; authentication available; no model or
reasoning override; policy `inherit`; write permission true; worktree support
false; the documented command allowlist; and no local line-ending override.
No credentials, tokens, or model request were printed or used.

### Mock benchmark output

Stable human-readable result:

```text
Status: passed
[task.compiled] Compiled task
[index.completed] Indexed 6 files
[context.initial_selected] Loaded 5 pages
[cache.verified_patch_stored] Stored exact verified patch
[task.passed] Task passed
```

The synthetic run changed two fixture files and completed verification. Raw
mock telemetry and the disposable absolute artifact path are deliberately not
copied into the public export. All model-token fields were unavailable because
the mock worker made no external inference call.

No live Codex, Anthropic, or other provider inference was performed during the
initial pre-release audit. A later owner-authorized Codex compatibility check is
recorded in section 12 without rewriting the original command history.

## 4. Scanner and file-by-file review

All 121 final files, including `.github`, `.gitignore`, and `.latticeignore`,
were classified and reviewed. `PUBLIC_FILE_REVIEW.csv` records path, category,
size, hash, status, and notes. `PUBLIC_FILE_MANIFEST.sha256` hashes every other
final file in deterministic path order; a file cannot contain its own final
cryptographic hash, so the manifest's documented self-entry uses a sentinel.

Inspection covered credentials, access tokens, cookies, authorization values,
email/phone data, names, local paths and identifiers, conversations, raw prompts
and payloads, telemetry, billing, private-repository references, internal
assessments, legacy private naming, unsupported claims, third-party material,
benchmark rights, customer data, misleading validation language, and unsupported
provider claims.

Findings after safe fixes:

- no credential, token, cookie, private key, authorization value, or billing data;
- no real email or phone number; only reserved `.invalid` synthetic addresses;
- no private absolute host path or local username;
- no raw model transcript, provider payload, private benchmark result, log,
  recording, runtime database, `.lattice` state, or customer data;
- no reference to the legacy private project name;
- no Claude Code or other unsupported-adapter claim;
- no universal token/latency claim and no owner-run result presented as independent;
- implementation uses prompt, session, authorization, and telemetry vocabulary,
  while tests use synthetic values; these are code semantics, not captured data;
- the provider prompt file is an implementation template, not a captured prompt;
- `LICENSE`, `NOTICE`, Contributor Covenant text, Mozilla attribution, dependency
  metadata, and notices are the identified third-party/legal materials.

Scanner exemptions remain narrow: reserved synthetic addresses, protocol field
vocabulary in source/tests, and the explicit synthetic example-user path.
They do not exempt secret-shaped values or real personal paths.

## 5. Package dry-run review

`npm pack --dry-run --json` reported:

- name/version: `lattice-v2@0.1.0`;
- archive name: `lattice-v2-0.1.0.tgz`;
- package size: 116,779 bytes;
- unpacked size: 502,815 bytes;
- file count: 111;
- SHA-1 reported by npm: `bd6595d44eec1046b60a1bc7112fd0068d613d23`;
- integrity: `sha512-E73/ACYM7pHuZ6RfjhSVC513jxQGpIbFQLFyZke4ixxEeEsmj4pFZjlL2yxImTwG16eWbW/dbA2lnJ55ZlkHDA==`.

Complete path groups: 11 top-level public legal/project documents; 76 compiled
`dist` JavaScript/declaration files including the Codex provider subdirectory;
11 documentation files; one example configuration; five reset-token fixture
files required by the credential-free benchmark; and `package.json`.

The complete inspected top-level/non-`dist` list is:

```text
AUTHORS.md
CHANGELOG.md
CITATION.cff
DEPENDENCIES.md
docs/architecture.md
docs/configuration.md
docs/evaluation.md
docs/installation.md
docs/limitations.md
docs/persistence-schemas.md
docs/protocol.md
docs/providers.md
docs/quick-start.md
docs/security.md
docs/troubleshooting.md
examples/lattice.config.example.json
fixtures/reset-token/package.json
fixtures/reset-token/src/auth/audit.js
fixtures/reset-token/src/auth/service.js
fixtures/reset-token/src/auth/token-repository.js
fixtures/reset-token/tests/reset-token.test.js
LICENSE
NOTICE
package.json
README.md
SECURITY.md
SUPPORT.md
THIRD_PARTY_NOTICES.md
TRADEMARKS.md
```

Every `dist` path corresponds to reviewed TypeScript source and contains only
`.js`/`.d.ts`; no source map is included. The dry run contains no `.git`,
private `.github` configuration, top-level tests, raw benchmark artifacts,
private reports, runtime state, logs, recordings, `.env`, private configuration,
source maps, caches, personal data, or publication credentials. No tarball was
published. `package.json` remains `"private": true`.

## 6. Workflow security review

Every workflow under `.github/workflows` was read completely.

- Repository permission is `contents: read` only.
- No workflow requests write permission.
- No `pull_request_target` trigger exists.
- No workflow references repository secrets.
- No release, npm publish, package upload, deployment, or artifact upload exists.
- Checkout uses `persist-credentials: false`.
- Official actions are pinned to exact reviewed commits with version comments:
  `actions/checkout` v4.4.0,
  `actions/setup-node` v4.4.0, and
  `actions/dependency-review-action` v4.9.0.
- Pull-request builds do execute the submitted code, but receive neither secrets
  nor write credentials; this is documented risk, not an undisclosed privilege.
- The public-export scanner is report-only.

Hosted secret scanning, branch protection, labels, Discussions moderation, and
repository-level Actions settings are platform actions and remain human-blocked.

## 7. Documentation accuracy and attribution

README, every document, every governance/legal file, package metadata, workflow,
and template were read completely. Internal Markdown links (24 Markdown files)
were checked with zero broken relative targets.

Documentation now accurately distinguishes implemented core behavior,
experimental Codex integration, unsupported adapters, planned/nonexistent
services, local/mock testing, absent live provider testing, owner-run evidence,
and absent independent validation. The separate evaluation repository is marked
unavailable. Codex limitations are visible. Installation and quick-start commands
match the package and CLI, including the actual Node requirement
`^20.19.0 || >=22.12.0`.

The statement `Lattice was originally created and developed by Moulwyse.` is
present consistently where intended, including README, NOTICE, AUTHORS,
CITATION, package metadata, CLI output, CHANGELOG, and release documentation.
Author links use `https://github.com/moulwyse`; canonical links use
`https://github.com/moulwyse/lattice`. Ordinary commands received no intrusive
new attribution output.

## 8. Dependency and third-party review

`package-lock.json` lockfile v3 was parsed entry by entry. The rebuilt
`DEPENDENCY_INVENTORY.csv` contains all 111 non-root package entries with path,
name, version, direct/transitive relation, development/optional flags, declared
license, exact registry source, missing-metadata flag, and review note.

- Registry sources: 111/111 from `https://registry.npmjs.org/`.
- Missing declared license metadata: 0.
- MIT: 80.
- Apache-2.0: 12.
- MPL-2.0: 12.
- ISC: 5.
- BSD-3-Clause: 1.
- 0BSD: 1.
- Direct runtime: `@openai/codex-sdk` 0.144.5 (Apache-2.0), `commander`
  13.1.0 (MIT), `execa` 9.6.1 (MIT), `zod` 3.25.76 (MIT).
- Direct development: `@types/node` 22.20.1 (MIT), `typescript` 5.9.3
  (Apache-2.0), `vitest` 4.1.10 (MIT).
- The 12 MPL-2.0 entries are `lightningcss` and its optional platform packages,
  reached through development tooling; they are not copied into this repository
  or included as package source.
- Vendored dependency code: none found.
- Copied dependency source/assets: none found.
- Project fixture: synthetic and required only for local/mock behavior.

`DEPENDENCIES.md` now matches objective lockfile and Node-engine metadata.
Metadata review is not legal advice. License compatibility, redistribution
rights, and the right to publish remain `BLOCKED: HUMAN`.

## 9. Files modified during this audit

Safe corrections:

- `package.json`, `package-lock.json`: corrected the Node engine to match locked tooling.
- `README.md`, `CONTRIBUTING.md`, `docs/installation.md`,
  `docs/limitations.md`, `docs/providers.md`, `docs/security.md`,
  `docs/troubleshooting.md`, `DEPENDENCIES.md`: synchronized the engine
  requirement, live compatibility evidence, and validation/platform boundaries.
- `docs/architecture.md`: corrected two source-file references.
- `.github/workflows/ci.yml`, `.github/workflows/quality.yml`,
  `.github/workflows/dependency-review.yml`,
  `.github/workflows/release-prep.yml`,
  `.github/workflows/security-scan.yml`: pinned current official action commits;
  checkout workflows now disable credential persistence.
- `src/eval-budget.ts`, `tests/economy-frontier.test.ts`: replaced three legacy
  private-name identifiers with public Lattice identifiers; behavior is unchanged.
- `CHANGELOG.md`: added the required original-creator statement.
- `scripts/scan-public-export.mjs`: added CSV/checksum text coverage, legacy-name,
  email, and phone checks with narrow synthetic allowlisting.
- `tests/codex-cli-passthrough.test.ts`: removed only the invalid cross-time PID
  uniqueness assumption while retaining all process-leak assertions.
- `PUBLIC_EXPORT_REPORT.md`: redacted original private path/remote details and
  appended exact final audit results without erasing export history.

New review artifacts:

- `DEPENDENCY_INVENTORY.csv`
- `FINAL_RELEASE_AUDIT.md`
- `RELEASE_CHECKLIST_STATUS.md`
- `PUBLIC_FILE_MANIFEST.sha256`
- `PUBLIC_FILE_REVIEW.csv`

No architecture, provider behavior, token-saving behavior, transaction logic,
verification behavior, or package-publication setting was changed.

## 10. Remaining concerns and human blocks

There are no unresolved locally verifiable failures. The 13 human-blocked items
are:

1. ownership and publication rights;
2. final Apache-2.0 licensing choice;
3. legal dependency-license compatibility;
4. third-party/source/fixture/benchmark provenance rights;
5. hosting-platform secret scanning;
6. private vulnerability-reporting setup;
7. a consented private Code of Conduct contact;
8. optional integration and recovery testing on every claimed OS;
9. repository labels;
10. Discussions moderation decision;
11. branch protection and repository-level Actions settings;
12. authorization to create Git history;
13. explicit publication approval.

Additional limitations, not hidden failures: two owner-run Windows Codex smoke
tests passed, but hosted Linux/Windows/macOS CI has not run and native macOS/Linux
behavior remains untested; automated scans cannot prove absence; dependency
metadata cannot establish legal permission; neither the mock benchmark nor the
smoke tests support a general performance claim.

## 11. Final recommendation

The exact local export is **READY FOR HUMAN APPROVAL**, not automatically ready
for publication. Moulwyse should resolve the 13 human decisions, inspect this
packet, and explicitly approve the next step.

Git initialization is recommended only after those approvals. It was not done
during this audit.

## 12. Post-audit Codex and platform compatibility verification

At Moulwyse's later explicit request, runtime verification continued without
publishing or changing the private source repository.

Windows results:

- actual Codex installation: CLI `0.145.0`, authenticated through ChatGPT;
- public MCP direct handshake: protocol `2025-06-18`, server
  `lattice-v2@0.1.0`, all three tools listed;
- safe synthetic Git repository detected and indexed: 5 files;
- direct MCP search: 3 bounded pages, 2,069 bytes;
- direct MCP read: exact requested repository page returned;
- isolated integration lifecycle: MCP registration matched its ownership
  fingerprint; launcher and raw-bypass shims both reached Codex `0.145.0`;
  four hook groups loaded; synthetic session model/effort state was written;
  disable removed the owned MCP registration, hooks, shims, and state and
  restored the synthetic PATH with no warning;
- live official CLI/MCP smoke: exit 0 in 18.44 seconds, exact success response,
  11,901 non-cached input tokens and 308 output tokens;
- live locked SDK benchmark: exit 0 in 22.25 seconds, passed in one model turn,
  zero page faults, zero protocol repairs, two changed files, passing
  verification, 9,126 non-cached input tokens and 462 output tokens.

The two live checks therefore consumed 21,027 non-cached input tokens and 770
output tokens in total. They are owner-run connectivity evidence, not an
independent evaluation or a general efficiency claim. The first attempted CLI
command failed during argument parsing before inference because Windows
PowerShell split the prompt; passing the prompt through stdin fixed the harness.

Platform results:

- Darwin ARM64 lockfile installation: exit 0, 76 packages, expected Codex Darwin
  package present;
- Linux x64 lockfile installation: exit 0, 73 packages, expected Codex Linux
  package present;
- native macOS/Linux runtime: not available in this Windows environment and not
  claimed as tested;
- automatic persistent-PATH launcher/hook integration: confirmed Windows-only
  in the implementation and now stated explicitly in public documentation;
- future CI matrix: Ubuntu, Windows, and macOS on Node.js 20 and 22. It remains
  unexecuted until a repository exists and a human enables hosted Actions.

The npm registry reported stable `@openai/codex-sdk` `0.146.0` at the time of
this follow-up. The candidate remains locked to the live-tested `0.144.5`
instead of taking an unvalidated pre-1.0 minor update during release audit.

After all documentation and CI changes, a new clean disposable copy produced:

| Command | Exit | Wall time | Final result |
| --- | ---: | ---: | --- |
| `npm run scan:public` | 0 | 356 ms | 121 files; zero blocking findings |
| `npm run format:check` | 0 | 365 ms | 118 text files checked |
| `npm ci` | 0 | 2,915 ms | 75 packages added; 76 audited; zero vulnerabilities |
| `npm run build` | 0 | 1,922 ms | TypeScript passed |
| `npm test` | 0 | 49,738 ms | 16 files passed; 420 tests passed; 2 skipped; Vitest 47.18 s |
| `npm run lint` | 0 | 1,811 ms | TypeScript no-emit check passed |
| `npm run package:check` | 0 | 847 ms | 111 files; 116,779-byte package; 502,815 bytes unpacked |
| `npm audit` | 0 | 790 ms | zero vulnerabilities |

The final package SHA-1 reported by npm is
`bd6595d44eec1046b60a1bc7112fd0068d613d23`; its SHA-512 integrity value is
recorded in section 5. No publish command was run.
