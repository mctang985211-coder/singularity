# S4-E: two-sided experiment records in the evolution ledger

kind: persistence-change

The external `proposals.jsonl` ledger gains two record kinds,
`experiment_started` (the frozen experiment: samples with roles and observed
outcomes, input snapshot digest, candidate and production-baseline content
identities, model identity, budget, comparer version, and `frozenDigest`) and
`experiment_sample` (one line per sample per side per repetition: the new
runId/taskId, reviewRef, evidenceRefs, workspace path with its initial
snapshot digest, outcome, criteria with verifier id/version, and a cost that
is `reported` with the run's metrics or `unknown` with a reason — never 0).
`experiment_started` also carries `storeId`: optional at fold time, required
by the promotion gate, which refuses an experiment that records no task store.
Ledger formatVersion remains 1; the eight older kinds and their validation
are byte-identical, and new lines are append-only. The 2026-09-26 rework adds
three field deltas: `experiment_sample` carries an optional
`durationMs` (the run's real duration; optional at fold time, required by the
promotion gate whenever the frozen budget declares `wallTimeMs`);
`experiment_started.frozen.model` is the structured selection
`{provider, model, reasoningEffort?, maxTokens?, label}` (a bare string is
refused by record validation); and the frozen snapshot digest covers
symlink-resolved bytes (link names/text are no longer digest inputs — trees
without links are bit-identical to before). The comparer is
`experiment-comparer@2`: reports written under `@1` are refused by name
("cannot re-derive"), because a historical verified sample whose baseline
fails this time is now `inconclusive`, never `maintained`.

A skill proposal no longer takes a `replayed` record: its evaluation is the
experiment, and the report is `sandbox/<proposalId>/exp-<experimentId>/experiment-report.json`
with `formatVersion: 2`. The v1 replay report shape, assertions and the
manual path for `agent_preset` are unchanged; a v1 report is not accepted as
promotion evidence for a skill, and target types with no two-sided evaluator
(capability, agent_preset, task_definition, config-edit) are refused at
decide(PROMOTE)/apply while their historical records remain readable and
their applied records remain rollbackable (including the pre-W19
registry-form capability rollback).

Old readers fail to fold a ledger that contains the new kinds (the unknown
kind is refused by the transition checks). The repository has a single
reader/writer, so this is accepted and stated here: downgrading the code past
this change requires a ledger without experiment records. The live ledger
regression covers a byte-identical 21-line archive of the production
`proposals.jsonl`, including older lifecycle records without `reportDigest`,
`skillContent` or `approvalRef`; it contains no S4-E experiment records.
Current code refuses a pre-rework `experiment_started` with string
`frozen.model` and comparer `@1` during whole-ledger fold, including unrelated
reads and historical applied rollback. The current [F.2 KISS decision](../2026-09-20-vrtc-code-change-plan.md)
accepts this incompatibility: the caller must use the old version to handle
applied objects, then archive or migrate that ledger before using the new
format. No compatibility reader or silent partial fold is planned. The
unshipped experiment-level `wallTimeMs`/`durationMs` fields are also scheduled
for deletion by the [closure prompt](../execution-prompts/12-s4-e-final-closure.md);
the new build must reject records carrying that removed budget field rather
than silently treating it as unbounded. This paragraph records the new
decision; preceding field descriptions describe the current, pre-closure
implementation.

This is not a SessionEventMap root. The four tracked event fingerprints and
their schema inventory are unchanged; `verify-persistence` covers only those
roots and stays green. Coverage: `evolution/tests/unit/experiment*.spec.ts`
(record validation, fold, resume), `evolution/tests/unit/ledger-roots.spec.ts`
(legacy ledger), `tests/integration/experiment-runner.spec.ts` and
`tests/integration/evolution-replay-experiment.spec.ts` (real runs).
