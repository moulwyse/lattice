# Release checklist

No item should be inferred from a successful local build. Check each item
against the exact release candidate.

## Ownership and legal

- [ ] Confirm Moulwyse has the right to publish every source and fixture file.
- [ ] Confirm Apache-2.0 is the intended license.
- [ ] Review `LICENSE`, `NOTICE`, `AUTHORS.md`, `CITATION.cff`, and
      `TRADEMARKS.md`.
- [ ] Review direct and transitive dependency licenses; obtain legal advice if
      needed.
- [ ] Confirm no third-party source or benchmark data was copied without rights.

## Privacy and security

- [ ] Run `npm run scan:public` from a clean export.
- [ ] Run the hosting platform's secret scanner.
- [ ] Manually search for private paths, credentials, model conversations,
      provider sessions, raw telemetry, `.lattice/`, logs, recordings, and
      customer data.
- [ ] Review all fixtures as synthetic.
- [ ] Enable and test GitHub private vulnerability reporting.
- [ ] Replace the Code of Conduct private-contact placeholder.
- [ ] Confirm workflows receive no secrets when running untrusted pull requests.
- [ ] Review optional integration behavior and recovery on each supported OS.

## Build and behavior

- [ ] Install from an empty dependency state with `npm ci`.
- [ ] Run `npm run build`.
- [ ] Run `npm test` and record passed, failed, and skipped counts.
- [ ] Run `npm run lint` and `npm run format:check`.
- [ ] Run `npm run package:check` and inspect the complete file list.
- [ ] Verify `lattice --version`, `lattice --about`, and `lattice doctor`.
- [ ] Run the credential-free mock benchmark.
- [ ] Confirm the documented installation and quick start exactly match output.
- [ ] Mark every unavailable live provider test as not tested.

## Documentation and project setup

- [ ] Review README support labels, limitations, and evaluation wording.
- [ ] Confirm the canonical repository and author links.
- [ ] Confirm the separate evaluation repository link remains labeled
      unavailable until public.
- [ ] Create repository labels matching issue templates.
- [ ] Enable Discussions only if it will be moderated.
- [ ] Review branch protection and least-privilege Actions settings.
- [ ] Confirm `FUNDING.yml` contains no active unverified account.
- [ ] Confirm package publication remains disabled until intentionally reviewed.

## Final diff and publication

- [ ] Review every file in the export, including hidden files.
- [ ] Compare the original source fingerprint and Git status to the pre-export
      snapshot.
- [ ] Confirm no `.git` directory exists in the export before intentional
      initialization.
- [ ] Update `PUBLIC_EXPORT_REPORT.md` with exact final command results.
- [ ] Create Git history only after all prior items are complete.
- [ ] Publish only with explicit owner approval.
