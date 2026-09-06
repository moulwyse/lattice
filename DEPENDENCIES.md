# Direct dependency inventory

This inventory is derived from `package.json` and the locked versions in
`package-lock.json` at public-export preparation time. It is informational, not
legal advice. Transitive dependencies remain governed by the lockfile and their
own license files.

## Runtime

| Package | Requested | Locked | Declared license | Source | Compatibility caveat |
| --- | --- | --- | --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | `0.3.220` | `0.3.220` | SEE LICENSE IN README.md | [npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | Claude Code Beta hooks, API, authentication, and usage fields can change independently of Lattice. Read the package's license terms. |
| `@openai/codex-sdk` | `0.153.4` | `0.153.4` | Apache-2.0 | [npm](https://www.npmjs.com/package/@openai/codex-sdk) | Pinned SDK/CLI with GPT-6 Astra support. External provider API, authentication, and usage fields can change independently of Lattice. |
| `commander` | `^13.0.0` | `13.1.0` | MIT | [npm](https://www.npmjs.com/package/commander) | CLI parsing behavior must be retested before a major upgrade. |
| `execa` | `^9.5.2` | `9.6.1` | MIT | [npm](https://www.npmjs.com/package/execa) | Process cancellation and Windows command behavior are part of Lattice's execution boundary. |
| `zod` | `^4.4.3` | `4.4.3` | MIT | [npm](https://www.npmjs.com/package/zod) | Schema semantics are security-relevant; a major upgrade requires protocol tests. |

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

As of the 2026-09-06 dependency review, the lockfile contains 213 non-root
package entries, including platform-specific optional packages. Every entry has
a declared license field (some refer to a package document):

| Declared license | Lockfile entries |
| --- | ---: |
| MIT | 164 |
| Apache-2.0 | 12 |
| MPL-2.0 | 12 |
| ISC | 10 |
| BSD-3-Clause | 3 |
| BSD-2-Clause | 1 |
| 0BSD | 1 |
| Unlicense | 1 |
| SEE LICENSE IN LICENSE.md | 8 |
| SEE LICENSE IN README.md | 1 |

These counts are an automated metadata inventory, not a legal conclusion or a
substitute for reading the licenses. The installed package count varies by
platform because not every optional platform package applies.
