---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-22-a3-coordination-phases

## Summary

Adds the A3 coordination surface to the `task/event` root: two new kinds (`RunPhaseChanged`, `RunProgressMarked`), the three types behind them (`ExecutionPhase`, `SubmissionRecord`, `NoProgressRecord`), and six optional `TaskRun` fields (`executionPhase`, `batchId`, `submission`, `pendingQuestionIds`, `blockingQuestionIds`, `noProgress`, the last two being the A4 mount points A3 only shape-checks). `RunPhaseChanged` is the phase gate itself — `active → waiting_children` (carrying `b-<parentTaskId>`) and `active|waiting_children → submitted` (carrying the submission) — so replay reconstructs exactly one path through the phase and a second submission, a rollback, or a decomposition admitted after the gate closed is refused by the field rather than by the run status (which stays `running` inside verification). `RunProgressMarked` is the diagnostic record of an active worker idling without submitting. `TaskService` gains `changeRunPhaseIn`, `markRunProgressIn`, and `admitBatchIn` — the atomic batch entry that lands the children, edges, decomposition record, capability manifests, and the parent run's phase change in one commit; `decomposeIn` keeps its old behaviour for existing callers. No envelope, no existing reducer rule, and no existing event's payload changes.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Fix note: cancelling a task that is verifying](#fix-note-cancel-while-verifying)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-22-a3-coordination-phases
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the union gains `RunPhaseChanged` and `RunProgressMarked` members |

The two new members (declared in `task/src/types.ts` with JSDoc, as every member must be):

- `RunPhaseChanged: { phase: ExecutionPhase; batchId?: string; submission?: SubmissionRecord; pendingQuestionIds?: string[]; blockingQuestionIds?: string[]; reason?: string }`, where `ExecutionPhase` is `'active' | 'waiting_children' | 'submitted'`, `SubmissionRecord` is `{ summary: string; evidenceRefs: string[]; notes?: string; submittedAt: string; origin: 'worker' | 'runtime' }`, and the two question-id lists are the A4 mount points A3 never writes a non-empty value to.
- `RunProgressMarked: { kind: 'unsubmitted-idle'; rounds: number; factCount: number; note: string }`.

`TaskRun` gains the optional fields these events persist: `executionPhase?`, `batchId?`, `submission?`, `pendingQuestionIds?`, `blockingQuestionIds?`, `noProgress?` (where `NoProgressRecord` is `{ kind: 'unsubmitted-idle'; rounds: number; factCount: number; markedAt: string }`).

Reducer discipline (`task/src/service/state.ts`):

- `RunPhaseChanged` (`changeRunPhase`): the run must exist, belong to the envelope's task, and still be `running`; the only legal transitions are `active → waiting_children` (non-empty `batchId` required) and `active|waiting_children → submitted` (well-shaped `submission` required; summary non-empty, evidence refs a string list, notes a string when present, origin one of the two, submittedAt non-empty); same phase, rollback, a run without a phase, a late change on a terminal run, and an unknown target phase are refused; each phase carries only its own field, and the A4 question-id lists are shape-checked and carried unchanged.
- `RunProgressMarked` (`markRunProgress`): the run must exist, belong to the envelope's task, be `running`, and sit in phase `active`; kind must be `unsubmitted-idle`, rounds a positive integer, factCount a non-negative integer, note non-empty; the marking overwrites `noProgress` with the event's own timestamp.
- `TaskStarted` (`assertBirthPhase`): a run with no phase is a pre-protocol record and stays legal; born `active` carries neither submission nor batchId; born `submitted` (a workerless replay) requires a well-shaped submission and no batchId; `waiting_children` is not a birth phase.
- `TaskCancelled` (`cancel`): the source status may be `running` or `verifying` — see the fix note below.

Service entries (`task/src/index.ts`): `changeRunPhaseIn` and `markRunProgressIn` each write one event with the `taskId`/`runId` envelope; `admitBatchIn` writes a whole batch as one commit (per child `TaskCreated` + `TaskAdmitted`, all `DependencyAdded`, `TaskDecomposed` with the admission record, per child `CapabilityResolved` plus `CapabilityGapDetected` when the manifest has a gap, then the parent's `RunPhaseChanged(active → waiting_children, batchId: b-<parentTaskId>)`), so a batch whose last event cannot apply persists nothing. This change lands the store-side surface only; the runtime that writes these events (drain, execution gate, batch driver) arrives in a later stage of the A3 ticket, so no production caller exists yet. A3 §1 of `docs/2026-09-22-a3-coordination-design.md` is the design source.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and the new kinds live inside the transitively referenced `TaskEventPayloads` union. Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest — the same situation as `2026-09-22-run-provider-binding`, `2026-09-21-verifier-selftest-protected-inputs` and `2026-09-20-obligation-recorded`.

<a id="fix-note-cancel-while-verifying"></a>
## Fix note: cancelling a task that is verifying

`TaskCancelled` gains `verifying` as a legal source status: `cancel` in `task/src/service/state.ts` now asserts `['running', 'verifying'] → cancelled`, the same rule `fail` already applied. This is a behaviour fix inside one reducer rule, not a shape change: a run keeps `running` through verification (the phase, not the status, records the submission), so a cancellation that lands while a verifier call is in flight arrives at a task that is already `verifying`. The previous rule refused it and left a half-settled tree — the parent cancelled, the verifying child not — which also made `cancelGraph` (the documented exit for a store that cannot be recovered, and the entry `graphs.remove` calls) throw exactly when it was needed. No event payload, envelope, reducer input shape, or stored field changed, so the declaration and the compatibility conclusions below are unaffected; existing logs replay identically, since a `verifying → cancelled` transition could not be written before this rule existed and a replayed task's status is a function of its events.

Together with it, the runtime voids a verdict that arrives after such a cancellation: `settleSubmittedRun` re-reads the run after `verifyRun` returns (and after it throws) and, when the run is already terminal, writes neither `TaskVerified`/`TaskFailed` nor a second review record, returning the settled status instead.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: an ordinary added event type and added optional event-body properties are both minimum-decision `same-version` cases.

New build reading old records is fully compatible. An old store contains no new events and no new `TaskRun` fields: every new check is gated on the field being present (`executionPhase === undefined` is legal at birth, and a phase-less run replays exactly as before), the six fields are simply absent from the snapshot, and no existing transition, envelope, or payload changed. A non-terminal old run without a phase is *displayed* as `needs-recovery` by its readers and accepts no phase change or marking — a refusal the reducer states by name — but the store itself opens and replays unchanged; this is a reading rule, not a rewrite of stored data.

An old build opening a store that contains these events refuses it, by name, at replay: `TaskState.apply` is fail-closed and throws `task: unknown event kind "RunPhaseChanged"` / `"RunProgressMarked"`. The envelope's `ignorable: true` only lets a build skip an unknown event *type*; it does not cover an unknown kind under the already-known `task/event` type. This is the intended fail-closed behaviour — the record does not claim older readers can ignore the addition. Writer and reducer ship together, and a task store is scoped to one root session, so in normal operation a single store is never replayed by mixed-version code.

<a id="verification"></a>
## Verification

`pnpm exec tsc --noEmit` in `task` reported 0 errors; `pnpm build` in `packages/singularity` passed for all workspace packages. `pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, `task/event` digest unchanged); `node scripts/verify-persistence.mjs --write` rewrote `docs/persistence-schema.json` byte-identically, so there was no drift to record beyond this acknowledgement.

New coverage, all reading conclusions back from the store's event log or the public snapshot (`snapshotIn`/`taskIn`/`runIn`), never from a writer's return value:

- `task/tests/unit/coordination.spec.ts` (new, 62 tests) — the three legal phase transitions; a refusal table (same phase, rollback from `waiting_children` and from `submitted`, missing/empty batchId, missing/malformed submission including empty summary, non-list or non-string evidence refs, non-string notes, unknown origin, empty submittedAt, a `waiting_children` change carrying a submission, a `submitted` change carrying a batchId, unknown target phase, a run with no phase, and a late change on cancelled/failed runs) where every refusal also asserts the snapshot is untouched; `RunProgressMarked` recording the caller's round count as given and its refusals (no phase, `waiting_children`, `submitted`, terminal runs, unknown kind, non-positive/fractional rounds, negative/fractional factCount, empty note); the `TaskStarted` birth-shape gate (no phase legal, `active` with submission/batchId refused, `submitted` without submission refused, a well-shaped submission accepted, `waiting_children`/unknown phase refused); a hand-built pre-protocol event log replaying unchanged; `admitBatchIn` atomicity (a batch whose trailing phase change names a missing run persists zero events and the store stays writable; a batch on an already-submitted run is refused whole), the complete happy-batch snapshot (children admitted, edges, decomposition, manifests with a gap event, parent `waiting_children` with `b-root`, the 10 events in one commit and the lossless-JSON round trip), argument validation, and `decomposeIn` leaving the parent phase untouched.
- `task/tests/unit/task-service.spec.ts`, `task-state.spec.ts`, `contract.spec.ts`, `skill-contract.spec.ts`, `diagnosis-judgements.spec.ts` — unchanged suites, all green under the new reducer.

In the harness root, `pnpm vitest run --project unit packages/singularity/task` passed 22 files / 530 tests (the path filter also selects `packages/singularity/task-runtime`, whose unit suite is unchanged and green); the task package alone is 6 files / 187 tests.
