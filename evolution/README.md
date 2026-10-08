# dsh-singularity-evolution

Purpose: The evolution plane — one method draft ledger, one evaluation pipeline,
one publish pointer switch, and the read-only projection of a legacy ledger.

A method changes through exactly one path: a `draft` on the method ledger, one
`evaluate` that freezes both sides and runs them, one report, and a publish or
rollback that switches the environment pointer. Every graph's library lives at
`$DSH_HOME/singularity/environments/<rootSessionId>`; a draft materializes in
that library's draft directory and the ledger records its id.

The pipeline freezes one `EvaluationPlan` before anything runs: both sides'
revisions, the input snapshot, the model selection, the sample's own original
acceptance, the scoring rules, the budget and the strategy policy. Both sides go
through the same `freezeSide`, so a run cannot be judged by another criterion
set. Each side runs in its own workspace built from the frozen input and each
run's facts come from the runtime's own sealed `ExecutionReceipt` — never from a
second read of evidence the runtime already read. `TrialResult` is the only
side-fact schema this plane keeps; `EvaluationReport` is the only report schema.

An llm-outcome evaluation freezes its rubric, its measurement commands and the
independent judge's exact prompt; the judge answers once, and the answer, its
input and both digests are written beside the report. A missing usage stays
unknown. Monetary cost stays unknown until the host supplies an authoritative
pricing source.

For a snapshot, `snapshot.paths` selects the relative files or subdirectories the
Task needs; the selection and its digest are frozen and re-checked when each side
is built. Each side gets an independent copy, using filesystem copy-on-write when
available, and hashing streams file content instead of buffering whole files.
For contracts that carry absolute workspace paths, `snapshot.rebaseFrom` maps
their workspace root into each side.

Package: `@dangosys/dsh-singularity-evolution`

Dependencies: workspace `task`, `task-runtime`; peers `cordis` + `dsh-session` +
`dsh-sandbox` + `dsh-sandbox-policy` + `dsh-subprocess`.

config.yaml: optional `root` (default `$DSH_HOME/evolution`, the ledger
directory), `skillRoot` (default `$DSH_HOME/skills`, the legacy production
root), `libraryId`, `taskTemplatesRoot`, `capabilityConfig` and the injected
`repoRoot` / `modelSelection` — the members the legacy v4 service and the
assembly still name.

### Tools

none (the six `method_*` tools are adapters in `@dangosys/dsh-singularity-agent`)

### Web APIs

none

### Service state

1. `ctx.evolution` — the legacy v4 ledger: read-only projection plus the one
   recovery that settles an open `commit_intent` from the bytes the intent
   recorded (`reconcile` / `openIntentTargets` / `openIntentCapabilities`). No
   new protocol state is stored here.

2. The method ledger `<root>/methods.jsonl` (`formatVersion: 5`) — one line per
   draft fact: `draft` / `plan` / `trial` / `evaluation` / `discard` /
   `published` / `rolledback`.

## Design notes

**One draft protocol, no version set.** A `draft` line carries the revision the
candidate was written against and the candidate revision it proposes. The four
states are `draft → evaluated → discarded | published`; one wrong transition
refuses the whole ledger rather than folding into a state no legitimate sequence
could produce. The fields the old protocol hand-filled — a version set, six gate
answers, an always-true `mechanical` flag and a derivable `champion` — are not
merely ignored: a line that carries them is refused (`validateDraftRecord`).

**A candidate's content digest is content, never identity.** `CandidateRevision.digest`
is `candidateContentDigestOf(files)` — the candidate's own files, in path order.
The draft id, the revision id and the staging timestamp are identity and live in
`revisionId` / `manifestDigest`. This is what makes the strategy's same-bytes
refutation reachable: two drafts carrying the same bytes freeze the same content
digest, so the second one is closed by name without a measurement.

**One validator, two modes.** `validateEvaluation` is the only validation entry:
`evaluate` runs it before a report is recorded, and a publish runs it again in
`pre-publish` mode — the same checks against the same frozen plan, so a receipt,
a cost, a criterion, the baseline revision, the model or the candidate that moved
between the two is a named refusal.

**Publishing is one pointer switch.** A publish or rollback builds one plan (the
pointer's exact expected state, the revision to switch to and its digest) and
hands it to the runtime's own pointer transaction. This module owns no
production bytes: the revision directory already holds them, and the legacy
`proposals.jsonl` write path was retired with it.

**Snapshot link policy.** A frozen input snapshot is walked as the content it
really names: a link that resolves inside the snapshot is followed and
materialized as real content; a link whose target escapes the snapshot root,
whose chain loops, or whose target cannot be resolved is a named refusal wherever
the tree is first read. Without this, a kept link would be a shared target a run
could write through into the production checkout the snapshot was taken from.

**Legacy ledgers are history.** A graph without the new protocol marker is read
through `readLegacyMethods` — a pure projection of `formatVersion ≤ 4` lines that
adopts nothing, restores nothing, publishes nothing and writes no progress. A v5
line read through that projection is refused by name, and a v4 line read through
the v5 fold is refused too.

**Layout.** `types.ts` is the public vocabulary; `shared.ts` holds the canonical
JSON, its digests and the shape guards; `model.ts` the model-selection shape;
`draft/` the draft write door, the candidate adapters and their content digest;
`ledger/` the v5 record validators and the four-state fold; `pipeline/` the plan,
the run, the one validator, the score and the report; `evidence/` the receipts,
the consumption proofs, the snapshot builder and the independent judge;
`publish/` the publish request and the pointer switch; `history/` the legacy
projection; `service/` the ledger file and the deployment's seams; `strategy/`
the RRSI search strategy; `legacy/` the v4 service.

## RRSI strategy port

`src/strategy/` ports the RRSI search strategy as pure functions, derived from
google-research/rrsi @ be50316 (Apache-2.0, `rrsi/LICENSE`):
`rrsi/{schedule,evaluate,calibrate,selection,history}.py`. Provenance and license
notices are kept at the top of every ported file, and Python→TS test vectors live in
`tests/vectors/rrsi-vectors.json` (regenerate with
`tests/vectors/extract-rrsi-vectors.py <checkout>`; vectors are tagged
`deterministic` / `port-adapted` / `upstream-native` so a divergence is never
mistaken for an upstream output).

- `policy.ts` — the frozen `StrategyPolicy` (`rrsi-strategy@1`), the mechanism
  vocabulary (`skill / capability / task-template / text / parameter`, verified by
  candidate adapters rather than diff regexps), `DEFAULT_STRATEGY_POLICY`, the
  three-arm comparison arm `UNREGULARIZED_STRATEGY_POLICY`, `regularizersActive`
  (the grouping key for the plan §5 comparison) and `strategyPolicyDigest`.
- `schedule.ts` — annealed L0 edit budget. **Port change:** denominator
  `rounds - 1`, so `editBudgetTable(p)[p.rounds-1] === p.min` holds exactly
  (plan §4); upstream divides by `T` and only its out-of-range endpoint
  `edit_budget(T, T, …)` reaches `b_min` (rrsi/schedule.py:48, tests/test_core.py:63).
  With `b_min=1, b_max=2` the cosine quantizes to 2 until the final round; this is
  pinned literally rather than smoothed.
- `scale.ts` — the frozen [0,1] quality scale. Original acceptance is never
  compensable: `fail`/`inconclusive` yield 0 before any numeric is read, and an
  LLM judge only enters through a pre-frozen `fixed-numeric-scale` that must
  address a frozen measurement.
- `measure.ts` — Ŝ/Ĉ aggregation (missing trials keep the full denominator,
  unknown cost stays `undefined`, never 0), `poolEvaluations` over **all**
  repetitions of a frozen scope, and `calibrateNoise` with a deterministic LCG
  bootstrap (bit-identical in TS and in the extraction script). **Port change:**
  direct observation needs ≥ 3 independent solves; any path that observes no
  positive spread degrades to `declared-floor` (`policy.noise.floor`), so a single
  trial never yields a zero noise band (upstream rrsi/calibrate.py:103 collapses
  to δ = 0 at k = 1).
- `screen.ts` — structural check plus exactly one independent critic before any
  measurement (no repair chain, unlike upstream critic.py's `repair_rounds = 5`);
  refused candidates consume no replay budget and never enter measured history.
- `selection.ts` — noise floor, cost rule, argmax. **Port changes:** the gaining
  branch is capped at `maxRelativeIncrease = 0.25` (plan §4; upstream beta1 = 40 is
  unbounded, so gains above +0.375pp buy no extra allowance); unknown cost is
  `cost-inconclusive` (upstream returns ΔC = 0 and silently passes,
  rrsi/evaluate.py:131); in-band candidates need cost relief ≥ max(cost noise, 5%)
  and novelty never relaxes anything (`noveltyRelaxation: false`, vs the `+w_n·ν`
  term in rrsi/selection.py:90); a refused-at-admission baseline uses a
  pre-declared absolute token ceiling and never fabricates a relative cost.
- `history.ts` — history derived from candidate / evaluation / version /
  consumption facts (not a self-written JSONL, rrsi/history.py:60), pruning as
  `simplificationCandidates` = delete-candidate evaluations with real candidate
  ids (never "delete a component", rrsi/history.py:152), byte-identical candidates
  closed by `refutationFor` without measurement, and `mayRetest` requiring new
  evidence or a new scope. `steering: 'stop-search'` ends only the method search;
  whether the business run continues is the supervisor's own decision.
- `observe.ts` — adapts a real `EvaluationReport` into the strategy's inputs and
  produces the recomputable `StrategyDecisionRecord` (every input fingerprinted in
  the record, so a decision recomputes from the record and the report alone).
