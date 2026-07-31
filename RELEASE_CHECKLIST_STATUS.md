# Release checklist status

Audit date: 2026-07-31. This document reports the 36 original items in
`RELEASE_CHECKLIST.md`; it does not alter that file's checkboxes. Each item has
exactly one permitted status.

## Ownership and legal

1. **Confirm Moulwyse has the right to publish every source and fixture file — BLOCKED: HUMAN.** Evidence: all files were inventoried and no obvious copied customer or benchmark data was found, but ownership cannot be inferred from file content. Support: `PUBLIC_FILE_REVIEW.csv`, `FINAL_RELEASE_AUDIT.md`. Human action: confirm authorship, contributor permissions, and publication rights for every file.
2. **Confirm Apache-2.0 is the intended license — BLOCKED: HUMAN.** Evidence: `LICENSE`, `NOTICE`, `package.json`, and `CITATION.cff` consistently state Apache-2.0. Human action: Moulwyse must explicitly choose and approve that license.
3. **Review `LICENSE`, `NOTICE`, `AUTHORS.md`, `CITATION.cff`, and `TRADEMARKS.md` — PASS.** Evidence: each file was read completely and checked for internal consistency, public attribution, active placeholders, and unsupported trademark claims. Support: the five named files and `FINAL_RELEASE_AUDIT.md`.
4. **Review direct and transitive dependency licenses; obtain legal advice if needed — BLOCKED: HUMAN.** Evidence: all 111 non-root lock entries were rebuilt in `DEPENDENCY_INVENTORY.csv`; no license metadata is missing, and 12 entries declare MPL-2.0. Support: `package-lock.json`, `DEPENDENCIES.md`, `DEPENDENCY_INVENTORY.csv`. Human action: decide legal compatibility and obtain advice if appropriate.
5. **Confirm no third-party source or benchmark data was copied without rights — BLOCKED: HUMAN.** Evidence: manual review found no raw private benchmark set, customer data, or vendored dependency source; standard third-party legal material and synthetic fixtures remain. Human action: confirm provenance and rights for project source, fixtures, and standard governance text.

## Privacy and security

6. **Run `npm run scan:public` from a clean export — PASS.** Evidence: exit 0; 116 files scanned in 414 ms in the clean validation copy, followed by a final scan of the completed export with zero blocking findings. Support: `npm run scan:public`, `scripts/scan-public-export.mjs`, `FINAL_RELEASE_AUDIT.md`.
7. **Run the hosting platform's secret scanner — BLOCKED: HUMAN.** Evidence: no repository or hosting platform was created. Human action: run and review the platform scanner after an approved private repository exists and before making it public.
8. **Manually search for private paths, credentials, model conversations, provider sessions, raw telemetry, `.lattice/`, logs, recordings, and customer data — PASS.** Evidence: every file, including hidden files, was read or structurally inspected; targeted full-tree searches and the strengthened scanner found no blocking material. Synthetic/test vocabulary is recorded in `PUBLIC_FILE_REVIEW.csv`. Support: `PUBLIC_FILE_REVIEW.csv`, `PUBLIC_FILE_MANIFEST.sha256`, `FINAL_RELEASE_AUDIT.md`.
9. **Review all fixtures as synthetic — PASS.** Evidence: all files under `fixtures/`, fixture builders, and test fixtures were read; identifiers and data are artificial and use reserved/example values. Support: `fixtures/`, `tests/helpers.ts`, `PUBLIC_FILE_REVIEW.csv`.
10. **Enable and test GitHub private vulnerability reporting — BLOCKED: HUMAN.** Evidence: no GitHub repository exists. Human action: enable and test the platform feature after approved repository creation.
11. **Replace the Code of Conduct private-contact placeholder — BLOCKED: HUMAN.** Evidence: `CODE_OF_CONDUCT.md` intentionally directs readers to a private channel to be configured and does not invent contact data. Human action: provide a consented, monitored private address or form.
12. **Confirm workflows receive no secrets when running untrusted pull requests — PASS.** Evidence: all workflows use `permissions: contents: read`; no `pull_request_target`, `${{ secrets.* }}`, write permission, release, publish, or artifact upload exists; checkout credentials are not persisted. Support: `.github/workflows/*.yml` and workflow review in `FINAL_RELEASE_AUDIT.md`.
13. **Review optional integration behavior and recovery on each supported OS — BLOCKED: HUMAN.** Evidence: Windows MCP, launcher, hooks, session sync, ownership checks, and cleanup passed against Codex CLI `0.145.0` in an isolated profile; Darwin ARM64 and Linux x64 dependency resolution passed. Native macOS/Linux runtime and recovery were not run, and transparent auto-enable is now explicitly documented as Windows-only. Human action: run the checked-in OS matrix and native manual-MCP tests on macOS/Linux before expanding support claims.

## Build and behavior

14. **Install from an empty dependency state with `npm ci` — PASS.** Evidence: final post-runtime disposable copy, exit 0 in 2,915 ms; 75 packages added, 76 audited, 0 vulnerabilities.
15. **Run `npm run build` — PASS.** Evidence: final post-runtime copy, exit 0 in 1,922 ms; TypeScript completed without diagnostics.
16. **Run `npm test` and record passed, failed, and skipped counts — PASS.** Evidence: the first audit run exposed one invalid Windows PID-uniqueness assumption (exit 1); after the documented safe test correction, the final post-runtime full rerun exited 0 in 49,738 ms: 16 files passed, 0 failed; 420 tests passed, 2 skipped, 0 failed; Vitest reported 47.18 seconds. Support: `tests/codex-cli-passthrough.test.ts`, `FINAL_RELEASE_AUDIT.md`.
17. **Run `npm run lint` and `npm run format:check` — PASS.** Evidence: final post-runtime lint exit 0 in 1,811 ms; final clean-copy format check exit 0 in 365 ms and checked 118 text files.
18. **Run `npm run package:check` and inspect the complete file list — PASS.** Evidence: final post-runtime exit 0 in 847 ms; `npm pack --dry-run` contained exactly 111 reviewed files, package size 116,779 bytes, unpacked size 502,815 bytes. Support: complete list in `FINAL_RELEASE_AUDIT.md`.
19. **Verify `lattice --version`, `lattice --about`, and `lattice doctor` — PASS.** Evidence: all three commands exited 0; exact outputs are recorded in `FINAL_RELEASE_AUDIT.md`.
20. **Run the credential-free mock benchmark — PASS.** Evidence: `npm run benchmark` exited 0 in 4,013 ms; status `passed`, two synthetic fixture files changed, and all provider token fields were unavailable because no model call occurred.
21. **Confirm the documented installation and quick start exactly match output — PASS.** Evidence: commands and output were compared with `README.md`, `docs/installation.md`, and `docs/quick-start.md`; the supported Node engine was corrected to `^20.19.0 || >=22.12.0`.
22. **Mark every unavailable live provider test as not tested — PASS.** Evidence: provider and limitation documentation now records the two owner-run Windows Codex smoke tests exactly, keeps macOS/Linux live behavior untested, and keeps unsupported providers unsupported. No unavailable test is represented as passing or independent.

## Documentation and project setup

23. **Review README support labels, limitations, and evaluation wording — PASS.** Evidence: `README.md` was read completely; experimental, unsupported, owner-run/local, and independently unvalidated behavior is distinguished and no universal savings claim appears.
24. **Confirm the canonical repository and author links — PASS.** Evidence: canonical links resolve textually to `https://github.com/moulwyse/lattice`; author links resolve textually to `https://github.com/moulwyse` across public metadata.
25. **Confirm the separate evaluation repository link remains labeled unavailable until public — PASS.** Evidence: `README.md` and `docs/evaluation.md` label it unavailable; no active misleading public-evaluation link is supplied.
26. **Create repository labels matching issue templates — BLOCKED: HUMAN.** Evidence: templates were reviewed, but no repository exists. Human action: create and verify labels after approved repository creation.
27. **Enable Discussions only if it will be moderated — BLOCKED: HUMAN.** Evidence: no repository exists and no moderator was assumed. Human action: decide moderation ownership before enabling Discussions.
28. **Review branch protection and least-privilege Actions settings — BLOCKED: HUMAN.** Evidence: workflow YAML is least privilege locally, but branch protection and repository-level Actions settings do not exist. Human action: configure and review platform settings after repository creation.
29. **Confirm `FUNDING.yml` contains no active unverified account — PASS.** Evidence: `.github/FUNDING.yml` contains only commented guidance and no active funding identifier.
30. **Confirm package publication remains disabled until intentionally reviewed — PASS.** Evidence: `package.json` contains `"private": true`; no workflow publishes to npm or creates a release.

## Final diff and publication

31. **Review every file in the export, including hidden files — PASS.** Evidence: all 121 final files are represented in `PUBLIC_FILE_REVIEW.csv`; every text file was scanned and manually classified, and hashes are in `PUBLIC_FILE_MANIFEST.sha256` subject to the documented self-reference exception.
32. **Compare the original source fingerprint and Git status to the pre-export snapshot — PASS.** Evidence: historical algorithm reproduced 83 files and SHA-256 `70b7d2224fc959ce49ffcf35a11cd68787c4bf4f20bc48dc4ef9d5a21b394d48`; HEAD remains `a3323621b767cf47752ec7a0680ac833c93c85e3` and no export-owned status change appeared.
33. **Confirm no `.git` directory exists in the export before intentional initialization — PASS.** Evidence: forced recursive filesystem inspection found no `.git`; `git remote -v` exited 128 because the export is not a repository.
34. **Update `PUBLIC_EXPORT_REPORT.md` with exact final command results — PASS.** Evidence: the report preserves its historical account and now includes the final audit correction, command, count, and limitation updates.
35. **Create Git history only after all prior items are complete — BLOCKED: HUMAN.** Evidence: Git was intentionally not initialized. Human action: resolve all earlier human blocks, approve the final contents, then explicitly authorize initialization.
36. **Publish only with explicit owner approval — BLOCKED: HUMAN.** Evidence: no publication or other external action occurred. Human action: approve a separately reviewed repository creation/push step if and when desired.

## Totals

- PASS: 23
- FAIL: 0
- BLOCKED: HUMAN: 13
- NOT APPLICABLE: 0
- Total: 36
