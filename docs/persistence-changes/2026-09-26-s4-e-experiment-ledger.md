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
`experiment_started` also carries `storeId`: optional at fold time so the
records written before this field stay loadable, required by the promotion
gate, which refuses an experiment that records no task store.
Ledger formatVersion remains 1; the eight older kinds and their validation
are byte-identical, and new lines are append-only.

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
this change requires a ledger without experiment records. New code reads old
ledgers unchanged; the live ledger regression runs against a byte-identical
archive of the production `proposals.jsonl` (21 lines, including records
without `reportDigest`/`skillContent`/`approvalRef`).

This is not a SessionEventMap root. The four tracked event fingerprints and
their schema inventory are unchanged; `verify-persistence` covers only those
roots and stays green. Coverage: `evolution/tests/unit/experiment*.spec.ts`
(record validation, fold, resume), `evolution/tests/unit/ledger-roots.spec.ts`
(legacy ledger), `tests/integration/experiment-runner.spec.ts` and
`tests/integration/evolution-replay-experiment.spec.ts` (real runs).
