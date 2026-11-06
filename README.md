<p align="center">
  <img src="docs/assets/lattice-mark.png" alt="Lattice mark: a bounded repository slice ending in a verified result" width="96">
</p>

<h1 align="center">Lattice: Bounded Repository Context and<br>Verified Patches for Coding Agents</h1>

<p align="center">
  <strong>Moulwyse</strong><br>
  <a href="https://github.com/moulwyse">github.com/moulwyse</a> · <a href="mailto:ptech1500@gmail.com">ptech1500@gmail.com</a>
</p>

<p align="center">
  <em>Technical report · Software release v2.1.0 · September 2026</em>
</p>

<p align="center">
  <a href="https://github.com/moulwyse/lattice/actions/workflows/ci.yml"><img src="https://github.com/moulwyse/lattice/actions/workflows/ci.yml/badge.svg" alt="Build and test"></a>
  <a href="https://github.com/moulwyse/lattice/actions/workflows/quality.yml"><img src="https://github.com/moulwyse/lattice/actions/workflows/quality.yml/badge.svg" alt="Quality"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-20%20%7C%2022-339933.svg" alt="Node.js"></a>
  <a href="https://github.com/moulwyse/lattice/releases"><img src="https://img.shields.io/github/v/release/moulwyse/lattice?display_name=tag" alt="Release"></a>
</p>

---

### Abstract

Coding agents that operate on whole repositories spend a large share of their
model budget on work that is deterministic: discovering files, reading
context, checking whether an edit still applies, and running tests. We present
**Lattice**, an execution system that moves this work out of the model loop.
Lattice indexes a local repository, compiles a task into acceptance criteria
and context needs, serves the agent *bounded context pages* instead of an
unrestricted repository dump, accepts edits only under explicit *edit grants*,
validates every patch against *source fingerprints*, and verifies it in an
isolated Git worktree before applying it to the workspace. One package ships
adapters for both **Codex** and **Claude Code**, each opt-in. In a single
owner-run paired trial on a small public fixture, Claude Opus 5.5 with Lattice
used 87.3% fewer fresh input and output tokens, cost 86.8% less, and finished
70.4% faster than the same agent without Lattice, with 4/4 acceptance tests
passing in both arms. We state the narrow scope of this evidence explicitly
(§5.3) and publish a protocol for stronger evaluation.

**Keywords:** coding agents · context selection · program repair ·
verification · LLM tooling · reproducible benchmarks

---

## Contents

1. [Introduction](#1-introduction)
2. [System overview](#2-system-overview)
3. [Design](#3-design)
4. [Implementation](#4-implementation)
5. [Evaluation](#5-evaluation)
6. [Security and privacy](#6-security-and-privacy)
7. [Limitations](#7-limitations)
8. [Conclusion](#8-conclusion)
- [References](#references)
- [Citation](#citation)
- [Appendix A. Installation](#appendix-a-installation)
- [Appendix B. Command reference](#appendix-b-command-reference)
- [Appendix C. Configuration](#appendix-c-configuration)
- [Appendix D. Reproducing checks](#appendix-d-reproducing-checks)

---

## 1. Introduction

Strong coding models are increasingly deployed as agents that read, edit and
test real repositories [1, 2]. In a plain agent loop the model itself decides
which files to open, re-reads context across turns, and discovers through
trial and error whether an edit applies cleanly or breaks a test. Each of these
steps costs tokens and wall-clock time, yet most of them do not require model
judgement.

Lattice is built on a simple premise: **don't send the repository, send what
matters.** Deterministic repository operations run locally and visibly; the
model is asked only for the part of the task that needs it.

**Contributions.**

- A *bounded-context* interface that gives the agent explicit task-relevant
  pages instead of an unrestricted repository view (§3.1).
- An *edit-grant and fingerprint* mechanism that rejects stale or out-of-scope
  patches before they touch the workspace (§3.2).
- An *isolated verification* step that reproduces uncommitted work and
  installed dependencies in a Git worktree and returns failures to the worker
  for bounded correction (§3.3).
- A single package with opt-in **Codex** and **Claude Code** adapters and
  explicit stability labels (§4).
- Published paired records, a credential-free functional benchmark, a
  240-case safety-frontier check, and an evaluation protocol (§5).

## 2. System overview

<p align="center">
  <img src="docs/assets/lattice-flow.svg" alt="How Lattice bounds context and verifies a patch" width="760">
</p>
<p align="center"><em><strong>Figure 1.</strong> Lattice pipeline: index, compile, bound context, grant edits, verify, apply.</em></p>

A Lattice run proceeds in seven stages:

1. **Discovery and indexing.** Lattice finds a safe repository root and builds a
   local structural index that respects repository boundaries and ignore rules.
2. **Task compilation.** The goal is converted into acceptance criteria and
   context needs.
3. **Bounded context.** The context kernel returns bounded pages rather than an
   unrestricted repository dump.
4. **Proposal.** An agent or a manual operator proposes edits against explicit
   edit grants.
5. **Verification.** Lattice checks fingerprints, applies the transaction in an
   isolated Git worktree that reproduces uncommitted work and installed
   dependencies, and runs allowlisted verification commands. A rejected patch
   or failed verification is returned to the worker for up to two corrections.
6. **Application.** A verified patch is applied to the workspace with
   `git apply` after every source fingerprint is re-checked (`--no-apply`
   only verifies).
7. **State.** State and diagnostics are written beneath the repository-local
   `.lattice/` directory, which Lattice adds to `.git/info/exclude`.

## 3. Design

### 3.1 Bounded context

The agent never receives an implicit "whole repository". It receives pages
selected for the compiled task, so the context it sees is explicit and
inspectable. A smaller context is not automatically a correct one (§7); the
selection is therefore recorded alongside the result.

### 3.2 Edit grants and fingerprints

Every editable region is covered by an explicit grant, and every source the
agent relied on carries a fingerprint. A patch that touches an ungranted path,
or that was produced against content that has since changed, is rejected
rather than merged on a best-effort basis.

### 3.3 Isolated verification

Verification runs in a separate Git worktree, not in the user's checkout. The
worktree reproduces uncommitted changes and installed dependencies so that
tests observe the same state the user would. Only allowlisted commands run.
Verification is therefore exactly as strong as the repository's tests and the
configured allowlist.

### 3.4 Visible state

Local artifacts record what was selected, what changed and what was verified,
so the execution path is not hidden from the operator.

## 4. Implementation

Lattice is a TypeScript CLI (`lattice`) for Node.js `^20.19.0` or `>=22.12.0`.
Configuration is repository-local (`lattice.config.json`). Architecture,
protocol and persistence schemas are documented in
[architecture](docs/architecture.md), [protocol](docs/protocol.md) and
[persistence schemas](docs/persistence-schemas.md).

<p align="center"><em><strong>Table 1.</strong> Capabilities in v2.1.0. "Available" means implemented and locally tested, not a production support guarantee.</em></p>

| Capability | Status | Notes |
| --- | --- | --- |
| Local repository discovery and index | Available | Respects repository boundaries and ignore rules. |
| Bounded context pages and edit grants | Available | Local deterministic controls; covered by tests. |
| Fingerprint-checked patch application | Available | Rejects stale or out-of-scope edits; `--no-apply` only verifies. |
| Mock worker and deterministic fixture benchmark | Available | Runs without a model account or API credential. |
| Manual handoff workflow | Available | The operator transfers a bounded request and response. |
| Claude Code | [Available](docs/claude-code.md) | Same package; locally tested; exercised by published Opus 5.5 and Opus 5 pairs. |
| Direct Codex SDK worker | Beta | Requires an authenticated Codex environment. |
| Transparent Codex launcher, hooks, sidecar, MCP bridge | Experimental | Alters user-level integration state when explicitly enabled. |
| Adaptive model selection and verified-patch cache | Experimental | Opt-in; behaviour and limits documented. |
| Gemini, Cursor, Grok, other providers | Not implemented | No adapter included. |

**Codex.** Codex is the default worker. On Windows and Linux, enabling the
integration registers the Lattice MCP server and installs Lattice-owned
launcher and synchronization hooks; hook activation still depends on the Codex
client. Lattice never asks for a Codex API key.

**Claude Code.** Claude Code is an opt-in, per-repository integration inside
the same package. `lattice claude --raw` launches the bundled Claude Code while
bypassing Lattice for that process. The integration has passed local build and
contract tests with Claude Agent SDK `0.3.281` and its bundled Claude Code
`2.1.281`. See the [Claude Code guide](docs/claude-code.md) and the
[OSS project brief](docs/claude-for-oss.md).

**Platforms.** GitHub Actions builds and tests on Ubuntu, Windows and macOS
with Node.js 20 and 22; dependency resolution was checked for Linux x64 and
Darwin ARM64. The final local release audit ran on Windows. Hosted CI is not a
substitute for a full interactive integration test on every platform; live
Omarchy sessions and macOS automatic integration remain unverified.

## 5. Evaluation

### 5.1 Setup

Each live record is one **paired** run on the same reset-token task: one arm
with the plain agent (RAW) and one arm through Lattice. The fixture is small
and maintainer-authored (five source files). Token counts are provider-reported
fresh input plus output.

### 5.2 Results

<p align="center"><em><strong>Table 2.</strong> Owner-run paired results, plain agent → Lattice. Separate single-task runs, not a model ranking.</em></p>

| Model / effort, version | Fresh input + output | Cost | End-to-end time | Acceptance |
| --- | ---: | ---: | ---: | --- |
| **Claude Opus 5.5** / high, v2.0.1 | 37,279 → 4,747 (**−87.3%**) | $0.362 → $0.048 (**−86.8%**) | 35.0 s → 10.3 s (**−70.4%**) | 4/4 both arms |
| **GPT-6 Astra** / medium, v1.0.0 | 16,872 → 4,005 (**−76.3%**) | not measured | 70.2 s → 27.0 s (**−61.6%**) | 4/4 both arms |

For Opus 5.5 both arms received the same task text and produced functionally
equivalent patches; most of the difference comes from Lattice finishing in one
model turn where Claude Code used eight
([record](docs/evidence/owner-run-claude-opus-5-5.md)). The Astra pair was
measured with v1.0.0, whose Lattice arm also received five hand-written
acceptance criteria the plain arm did not, so it is not like-for-like; arm time
excludes setup, checkpoint and cleanup
([record](docs/evidence/owner-run-gpt-6-astra.md)).

Historical v1.0.0 records remain published for
[GPT-5.6 Sol](docs/evidence/owner-run-gpt-5.6-sol.md),
[GPT-5.6 Luna](docs/evidence/owner-run-gpt-5.6-luna.md) and a
[community-run Claude Opus 5 reproduction](docs/evidence/community-run-claude-opus-5.md).

### 5.3 Evidence boundary

Each row in Table 2 is **one** owner-run pair on **one** small fixture. It is
not independent task selection, not population-level evidence, and not a
general savings claim. Ratios will differ on larger repositories and harder
tasks. Raw provider sessions, private configuration, local paths and
unreviewed transcripts are excluded from all records.

### 5.4 Deterministic checks

- A credential-free, reproducible
  [functional smoke test](docs/evidence/mock-benchmark-v0.1.0.json)
  (`lattice benchmark --worker mock`). It makes no model call and is not
  evidence of quality or savings.
- A CI-checked [240-case safety-frontier result](docs/evidence/economy-frontier.json)
  covering risk classification, fail-closed protocol handling, path
  confinement, exact patch lowering and the live-evaluation budget guard
  (`npm run evidence:frontier`).

### 5.5 Proposed protocol

Stronger claims require paired, isolated runs with provider-reported usage,
evaluator-owned tasks, disclosed failures and a predeclared acceptance rule.
The protocol is specified in [docs/evaluation.md](docs/evaluation.md); the
spend-gated public drivers are in [benchmarks/](benchmarks/README.md).

## 6. Security and privacy

Lattice reads source code in the repository it is pointed at. Context sent to
a remote model is subject to that provider's terms, settings and retention
policy. Local metadata under `.lattice/` can contain source excerpts, diffs,
goals and diagnostics; it is excluded from commits but should be removed
before sharing a repository copy.

The transparent Codex integration can create launch shims, an MCP registration
and hooks in user-level configuration. It is never enabled by installation;
`lattice integration codex doctor` reports the paths it would touch, and the
disable command removes only state Lattice recognizes as its own.

The public-export scanner (`npm run scan:public`) reports suspicious artifacts
and exits non-zero; it never deletes files and is defence in depth, not proof
of safety. See [SECURITY.md](SECURITY.md) and [docs/security.md](docs/security.md).

## 7. Limitations

- Lattice is an early public release, not a hosted service or a security
  boundary.
- A smaller context is not automatically a correct context.
- Verification is only as strong as the repository's tests and the command
  allowlist.
- Token and latency savings vary by task, repository, model, cache state and
  provider accounting.
- Local integration tests do not substitute for live provider evaluation.
- The Opus 5.5 result is one owner-run pair on one maintainer-authored fixture.
- The Astra, Luna, Sol and Opus 5 pairs used v1.0.0 with extra fixture-specific
  acceptance criteria in the Lattice arm; re-measure before citing them.
- `@moulwyse/lattice` is not yet published to the public npm registry.

The complete list is in [docs/limitations.md](docs/limitations.md).

## 8. Conclusion

Lattice separates what a coding agent must decide from what a tool can do
deterministically: context selection, edit authority and verification become
explicit, local and auditable. Early paired evidence on a small fixture shows
large reductions in tokens, cost and time without loss of acceptance; broader
evaluation under the published protocol is the next step.

---

## References

[1] OpenAI. *Codex.* <https://openai.com/codex>

[2] Anthropic. *Claude Code.* <https://claude.com/claude-code>

[3] Anthropic. *Claude Agent SDK.* <https://docs.claude.com/en/api/agent-sdk/overview>

[4] Model Context Protocol. <https://modelcontextprotocol.io>

[5] Git. *git-worktree documentation.* <https://git-scm.com/docs/git-worktree>

## Citation

If you use Lattice in research or evaluation work, please cite the software
([CITATION.cff](CITATION.cff)):

```bibtex
@software{moulwyse2026lattice,
  author  = {Moulwyse},
  title   = {Lattice: Bounded Repository Context and Verified Patches for Coding Agents},
  version = {2.1.0},
  year    = {2026},
  month   = sep,
  url     = {https://github.com/moulwyse/lattice},
  license = {Apache-2.0}
}
```

---

## Appendix A. Installation

Requirements: [Git](https://git-scm.com/downloads) and Node.js `20.19+` or
`22.12+`. No API key is needed to install Lattice or run its local
self-test.

**Installer.**

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/moulwyse/lattice/main/scripts/install.ps1 | iex
```

```sh
# Linux / macOS (Bash)
curl -fsSL https://raw.githubusercontent.com/moulwyse/lattice/main/scripts/install.sh | bash
```

**Prebuilt release package.**

```sh
npm install --global https://github.com/moulwyse/lattice/releases/download/v2.1.0/lattice-v2-2.1.0.tgz
lattice --version
lattice benchmark --worker mock
```

**From source.**

```sh
git clone https://github.com/moulwyse/lattice.git
cd lattice
npm ci
npm run build
npm link
lattice doctor --workspace .
lattice benchmark --worker mock
```

A healthy self-test ends with `Status: passed`. If `npm link` is unavailable,
run `node dist/cli.js <command>` from the clone. Installing straight from Git
(`github:moulwyse/lattice#v2.1.0`) fails on npm 11+, because npm prepares a
global Git dependency without dev dependencies and the build cannot find `tsc`.

**Enable Codex.**

```sh
codex login status
lattice integration codex doctor --workspace .
lattice integration codex enable
# open a new terminal and restart Codex
lattice integration codex status --workspace .
```

**Enable Claude Code** (per repository).

```sh
lattice integration claude enable --workspace .
lattice integration claude status --workspace .
lattice claude
```

**Undo.**

```sh
lattice integration codex disable
lattice integration claude disable --workspace .
npm uninstall --global lattice-v2   # after npm link: npm unlink --global lattice-v2
```

Full instructions: [installation guide](docs/installation.md),
[Codex quick start](docs/quick-start.md), [Claude Code setup](docs/claude-code.md),
[release and upgrade guide](docs/release-v2.0.0.md).

## Appendix B. Command reference

```text
lattice
lattice run "<task>" --worker mock|manual|codex|claude [--no-apply]
lattice continue <task-id>
lattice handoff validate <task-id>
lattice session new|show|reset
lattice doctor
lattice benchmark --worker mock
lattice integration codex status|doctor|enable|disable
lattice integration claude status|enable|disable
lattice claude [--raw]
lattice sidecar status|stop
lattice --version
lattice --about
```

Use `lattice <command> --help` for options. A direct Codex run can inherit the
active Codex model settings or take `--model`, `--reasoning-effort` and
`--model-policy`.

## Appendix C. Configuration

Configuration lives in `lattice.config.json`; start from
[`examples/lattice.config.example.json`](examples/lattice.config.example.json):

```json
{
  "model": "inherit",
  "reasoningEffort": "inherit",
  "modelPolicy": "inherit"
}
```

Do not commit credentials or provider session state. Precedence rules and
adaptive behaviour are described in [docs/configuration.md](docs/configuration.md).

## Appendix D. Reproducing checks

```sh
npm test               # builds, then runs the Vitest suite
npm run lint
npm run format:check
npm run scan:public
npm run package:check
npm run evidence:frontier
```

---

<sub>
<strong>Contributing.</strong> See <a href="CONTRIBUTING.md">CONTRIBUTING.md</a> and the <a href="CODE_OF_CONDUCT.md">Code of Conduct</a>. Reports and pull requests must not contain secrets, personal paths, private source, model transcripts or provider session data.
<strong>Support.</strong> See <a href="SUPPORT.md">SUPPORT.md</a>; report vulnerabilities privately as described in <a href="SECURITY.md">SECURITY.md</a>. Sponsorship and testing infrastructure: <a href="mailto:ptech1500@gmail.com?subject=Lattice%20support">ptech1500@gmail.com</a> or <a href="https://www.patreon.com/c/moulwyse">Patreon</a>. Please do not send credentials or private code by email.
<strong>License.</strong> Apache License 2.0 (<a href="LICENSE">LICENSE</a>). Provenance: <a href="NOTICE">NOTICE</a>, <a href="AUTHORS.md">AUTHORS.md</a>, <a href="CITATION.cff">CITATION.cff</a>; fork naming: <a href="TRADEMARKS.md">TRADEMARKS.md</a>. Lattice was originally created and developed by Moulwyse; this repository is its canonical home.
</sub>
