# Third-party notices

Lattice uses third-party packages installed from the npm registry. The direct
dependencies and their lockfile-declared licenses are listed in
[DEPENDENCIES.md](DEPENDENCIES.md):

- `@openai/codex-sdk` — Apache-2.0;
- `commander` — MIT;
- `execa` — MIT;
- `zod` — MIT;
- `@types/node` — MIT;
- `typescript` — Apache-2.0;
- `vitest` — MIT.

Copyright notices and full license texts for installed packages are distributed
with those packages and can be inspected after `npm ci`. Transitive dependency
names, versions, integrity hashes, sources, and declared license metadata are
recorded in `package-lock.json`. The current lockfile includes packages
declaring MIT, Apache-2.0, MPL-2.0, ISC, BSD-3-Clause, and 0BSD licenses; see the
counts in `DEPENDENCIES.md`.

This file summarizes package metadata and does not replace third-party license
texts or constitute legal advice. No ownership of third-party projects is
claimed.
