# Direct dependency inventory

This inventory is derived from `package.json` and the locked versions in
`package-lock.json` at public-export preparation time. It is informational, not
legal advice. Transitive dependencies remain governed by the lockfile and their
own license files.

## Runtime

| Package | Requested | Locked | Declared license | Source | Compatibility caveat |
| --- | --- | --- | --- | --- | --- |
| `@openai/codex-sdk` | `^0.144.5` | `0.144.5` | Apache-2.0 | [npm](https://www.npmjs.com/package/@openai/codex-sdk) | External provider API, model catalog, authentication, and usage fields can change independently of Lattice. |
| `commander` | `^13.0.0` | `13.1.0` | MIT | [npm](https://www.npmjs.com/package/commander) | CLI parsing behavior must be retested before a major upgrade. |
| `execa` | `^9.5.2` | `9.6.1` | MIT | [npm](https://www.npmjs.com/package/execa) | Process cancellation and Windows command behavior are part of Lattice's execution boundary. |
| `zod` | `^3.24.0` | `3.25.76` | MIT | [npm](https://www.npmjs.com/package/zod) | Schema semantics are security-relevant; a major upgrade requires protocol tests. |

## Development

| Package | Requested | Locked | Declared license | Source | Compatibility caveat |
| --- | --- | --- | --- | --- | --- |
| `@types/node` | `^22.10.0` | `22.20.1` | MIT | [npm](https://www.npmjs.com/package/@types/node) | Types target Node 22; the locked Vite/Rolldown toolchain requires Node `^20.19.0` or `>=22.12.0`. |
| `typescript` | `^5.7.2` | `5.9.3` | Apache-2.0 | [npm](https://www.npmjs.com/package/typescript) | Compiler changes can alter NodeNext resolution and declarations. |
| `vitest` | `^4.1.10` | `4.1.10` | MIT | [npm](https://www.npmjs.com/package/vitest) | Test-runner major changes can affect mocks, timeouts, and child-process cleanup. |

## Review procedure

For a dependency change:

1. inspect the package's official repository and included license;
2. review the full lockfile diff, including install scripts and new transitive
   packages;
3. run `npm ci`, `npm test`, `npm run scan:public`, and `npm run package:check`;
4. run GitHub dependency review on pull requests;
5. update this file and `THIRD_PARTY_NOTICES.md` when applicable.

No dependency is vendored in this source export. `node_modules/` is excluded.

## Lockfile license-metadata summary

The lockfile contains 111 non-root package entries, including platform-specific
optional packages. Every entry has a declared license field:

| Declared license | Lockfile entries |
| --- | ---: |
| MIT | 80 |
| Apache-2.0 | 12 |
| MPL-2.0 | 12 |
| ISC | 5 |
| BSD-3-Clause | 1 |
| 0BSD | 1 |

These counts are an automated metadata inventory, not a legal conclusion or a
substitute for reading the licenses. The clean install used 75 packages on the
validation platform because not every optional platform package applied.
