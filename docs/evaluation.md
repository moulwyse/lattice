# Evaluation protocol

The purpose of an evaluation is to test whether Lattice is non-inferior in
evaluator-defined task success while measuring its effect on fresh model usage
and elapsed time. It is not to make an optimization claim from a single demo.

## Stages

- **Smoke test:** one paired run to validate the harness.
- **Pilot:** at least 20 evaluator-selected tasks to find protocol defects.
- **Technical evaluation:** approximately 100 varied tasks.
- **Acquisition-grade evidence:** approximately 300 tasks plus security, IP,
  dependency, and source due diligence.

The numbers are guidance, not a substitute for power analysis.

## Pre-registration

Before revealing tasks or running either arm, record:

- task population and sampling rule;
- acceptance tests and a non-inferiority margin agreed by the evaluator;
- model, version, reasoning effort, account tier, and provider region if known;
- hardware class, operating system, dependencies, permissions, network policy,
  timeout, concurrency, and spending limits;
- retry and failure policy;
- run-order randomization;
- primary and secondary metrics;
- inclusion, exclusion, and stopping rules.

Lattice configuration must be frozen before the hidden task set is revealed.

## Paired isolation

For each task, RAW and Lattice start from byte-identical clean repository
snapshots. Each run uses an isolated model session, clean tool state, empty
writable workspace, and no artifacts, messages, summaries, caches, or execution
traces from the paired run.

Both arms receive the same task, model, effort, permissions, network policy,
dependency state, timeout, concurrency, acceptance tests, and spending cap.
Record manual interventions; undisclosed intervention invalidates the run.

Disable verified-patch reuse and unrelated warm caches unless cache behavior is
a declared subject of the evaluation.

## Usage accounting

Token usage is measured exclusively from provider-reported usage metadata and
summed across every model call initiated during the run, including retries,
subagents, tool-mediated model calls, failed calls, and any evaluator-owned
wrapper calls.

Report separately:

- input tokens;
- cached input tokens;
- non-cached or fresh input where the provider definition permits;
- output tokens;
- reasoning tokens if reported;
- the exact composite metric formula.

Tool payloads are included when and only when the provider reports them as model
usage; the limitation must be disclosed. Never substitute character estimates
for billing counters.

The evaluator records every external model invocation and network request
attributable to either arm. Undisclosed external inference invalidates the
affected run. Local CPU time, index size, disk writes, and peak memory should be
reported separately rather than hidden as “free.”

## Outcomes

Use evaluator-owned tests and inspect the final diff. Publish a paired outcome
table:

| Outcome | Count |
| --- | ---: |
| RAW pass, Lattice pass | |
| RAW pass, Lattice fail | |
| RAW fail, Lattice pass | |
| RAW fail, Lattice fail | |

Report the success-rate difference with a confidence interval appropriate for
paired binary outcomes. Do not require byte-identical patches; independently
correct patches can differ.

For tokens and elapsed time, calculate the Lattice/RAW ratio for each task,
paired median reduction, and bootstrap confidence intervals. Show means as a
secondary metric. Report results both with all attempted tasks and for
successful pairs, without hiding failures or capped runs.

## Artifacts and privacy

Safe public artifacts may contain:

- the frozen methodology;
- sanitized aggregate metrics;
- acceptance-test outcomes;
- synthetic or already-public task identifiers.

Do not publish raw prompts, system instructions, conversations, tool payloads,
provider session identifiers, authorization data, private repository contents,
or unreviewed logs. Retain raw evidence only in an evaluator-controlled secure
location with an explicit deletion policy.

The intended public evidence repository is
<https://github.com/moulwyse/lattice-evaluation>. It is unavailable until it is
actually public; this source export does not claim otherwise.

## Due diligence

A black-box benchmark can establish a performance signal but cannot replace
transactional due diligence. Source and security review, confirmation of IP
rights, dependency/license review, and controlled source inspection or escrow
are a separate stage outside this performance protocol.
