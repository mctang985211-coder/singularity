---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-17-diagnosis-judgements

## Summary

Enriches `Diagnosis` — the payload of the `DiagnosisRecorded` member of `task/event` — with two optional fields: `producedBy` (who wrote the diagnosis) and `judgements` (an agent's or a person's per-dimension conclusion over the six review dimensions the mechanical fact table cannot settle). Motivation is §2.7.3 read with the owner's ruling: `ReviewRecord.dimensions` deliberately records only what is mechanically observable, and "was this specification adequate" is not a parsing problem — it is a judgement, made by a review agent when the case is complex. Putting that judgement in `Diagnosis` (not `ReviewRecord`) keeps the review record a fact sheet, keeps the one-record-per-run invariant intact, and reuses the diagnosis's existing evidence/review-ref discipline. Neither field is a score: a judgement's `verdict` is a coarse `adequate`/`inadequate`/`unknown` call, and `unknown` is the required answer when the evidence does not settle a dimension.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-17-diagnosis-judgements
baseline: false
changes:
  - root: "event:task/event"
    previous: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    after: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    decision: same-version
```

<a id="registered-shapes"></a>
## Registered shapes

| Root | Payload | Current shape |
|---|---|---|
| `event:task/event` | `TaskEvent` | Unchanged declaration; the `DiagnosisRecorded` member's `Diagnosis` gains two optional fields |

New optional fields on `Diagnosis` (all in `task/src/types.ts`, all JSDoc-documented):

| Field | Presence | Content |
|---|---|---|
| `producedBy?: DiagnosisProvenance` | when the writer declares who it is | `{ kind: 'agent' \| 'human'; sessionId?: string }` — absent on old records, read as human-written (the only writer there was) |
| `judgements?: ReviewJudgement[]` | when the writer made explicit calls | one entry per judged dimension: `{ dimension; verdict: 'adequate' \| 'inadequate' \| 'unknown'; evidenceRefs: string[]; rationale: string }` |

Supporting types added beside them: `JudgedDimension` (the six non-mechanical dimensions, snake_case spellings of the `ReviewDimensions` members), `JUDGED_DIMENSIONS`, `JudgementVerdict`, `JUDGEMENT_VERDICTS`, `ReviewJudgement`, `DiagnosisProvenance`. All are additive type declarations; no existing field changed type or optionality.

`outcome_correctness` and `capability_coverage` are deliberately **not** judgeable: the first is the verifier's own verdict tally and the second the admission-time `closed`/`partial`/`gap` closure, so both are mechanical and need no agent. The six judgeable dimensions are exactly the ones whose facts are counts and shapes with no verdict attached.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and this change lives inside the transitively referenced `Diagnosis` type. Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: every addition is an optional event-body property, nested one level inside the payload. Old records simply omit both fields, and old readers ignore them on replay — `TaskState.recordDiagnosis` still validates every pre-existing invariant and now additionally validates the two additions only when present, so no absent shape can reject a record and no old record is invalidated. The two additions are themselves validated for integrity: a `judgement` must name a judged dimension and a known verdict, carry a rationale, and rest on at least one non-empty evidence ref (an `unknown` verdict cites the refs it considered rather than nothing); `producedBy.kind` must be `agent` or `human`, and a present `sessionId` must be non-empty. The envelope keeps `ignorable: true`, so a build that does not know the type skips the event entirely.

<a id="verification"></a>
## Verification

`node scripts/verify-persistence.mjs --check` reports OK — 4 event roots match `docs/persistence-schema.json`; the inventory was not regenerated because no declaration-level digest moved. New coverage: the reducer rejects a judgement with empty `evidenceRefs`, an unknown dimension, an unknown verdict, and a bad producer kind (`task/tests/unit/diagnosis-judgements.spec.ts`); `task_review_pack` renders the escalation decision, the six judgement dimensions, and the agent judgement block apart from the mechanical facts (`agent-singularity/tests/unit/task-review-pack-judgements.spec.ts`).
