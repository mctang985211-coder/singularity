---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-28-a6-recovery-attempt

## Summary

Adds the recovery-attempt surface to the `task/event` root's stored types (A6, VRTC plan §F.4): the optional `recovery?: RunRecovery` field on `TaskRun` — carried inside the `TaskStarted` payload's run — with the reuse citations it holds (`RunMemberReuse`), the derivation that reads a run's members (`runMemberTaskIds`), and the reducer's own validation of the record.

A recovery attempt is what a failed root task's new attempt *is*: which diagnosis asked for it (`sourceDiagnosisId`), under which caller key (`requestKey`), which failed run of the same task it recovers (`sourceRunId`, absent when the failure had no run), when it was opened (`requestedAt`), and which already verified siblings it reads at its **leading** member positions instead of re-running them (`reusedMembers`). The attempt is the run's own field rather than a separate record because the questions the entry has to answer — "is this key already answered?", "is an attempt of this diagnosis in flight?" — are the run's identity and the run's own status; a second table keyed by the attempt would be a second place where "in flight" is answered, and the two could disagree.

Nothing else about the store changes: no new event kind, no new snapshot member, no renamed field. What a member of the run's sequence *is* changes in one respect: `runMemberTaskIds` now returns the pinned siblings first and the run's own batch members after them, which is the sequence a parent criterion's `childIndex` names.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [What the reducer decides](#what-the-reducer-decides)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-28-a6-recovery-attempt
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; no kind is added, renamed or removed, and no payload type text changes |

The added members (declared in `task/src/types.ts` with JSDoc, as every member must be):

- `TaskRun.recovery?: RunRecovery` — optional, carried transitively inside the `TaskStarted` payload's `run`, beside `providerBinding`, `executionPhase`, `batches` and `submission`. Absent on every run that is not a recovery attempt: a first attempt, a child, a replay. Written once, with the run's own start; never rewritten.
- `RunRecovery = { sourceDiagnosisId, requestKey, sourceRunId?, requestedAt, reusedMembers: RunMemberReuse[] }` — the diagnosis the attempt was asked for, the caller's key, the failed run of the same task it recovers (absent when the failure had no run), when it was opened, and the reuse citations in position order.
- `RunMemberReuse = { childIndex, taskId, sourceRunId, evidenceId, criterionId?, artifactRefs, inputRefs }` — one citation: the position it pins (its own index in the list), the verified sibling task, the sibling's own verified run, the evidence bundle under it, the criterion the original acceptance map narrows that position to, and the artifact/input references the declaration rests on. All lists are open (possibly empty) and every field is an identity the store can be asked about.

The changed derivation (same declaration, changed meaning — stated here because a reader of the field needs it):

- `runMemberTaskIds(run)` — the run's member ids are now `run.recovery.reusedMembers.map(member => member.taskId)` followed by the batch members in admission order. With no recovery, or with no reuse declared, the result is the previous concatenation exactly; a store written before this build answers the same as it always did.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and every change lives inside types the payload text refers to (`TaskStarted`'s text stays `{ run: TaskRun }`). Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="what-the-reducer-decides"></a>
## What the reducer decides

`TaskState.assertRunRecovery` runs inside `start()` — the one place a run is created — and refuses, before anything is applied:

- a record whose `sourceDiagnosisId`, `requestKey` or `requestedAt` is empty;
- a record opened for a task that has a parent (a recovery attempt is the store's own root task's, and a child is re-run by a batch of its parent);
- a `sourceDiagnosisId` this store holds no `Diagnosis` record of for that task;
- a `sourceRunId` that names no run, another task's run, or a run that does not exist;
- a citation whose `childIndex` is not its own position in the list (the pinned slots are the run's *leading* positions, so the sequence it reads has no unfilled slot inside it and a created member can never be placed before a pinned one);
- a citation of a task that is not a child of the run's own task, of a sibling that is not `verified`, of a run that is not that sibling's or not `verified`, of an evidence bundle that is not that run's, of an artifact the bundle does not hold (by artifact id or kind), of a criterion the sibling does not declare or whose verdict in that bundle is not `pass`, or of an input reference the sibling does not declare (`requiresArtifact`, `acceptsArtifact`, `protectedInputs`).

The policy half deliberately stays out of the reducer and lives at the runtime's entry: whether the source task is in a failing terminal state, whether the named source run is failed, whether the original contract's projections agree, whether the diagnosis names the source, whether an attempt of that diagnosis is in flight under another key, whether the required capability rows resolve and their providers pass the pre-check, and whether the K4 ceilings in force allow one more run. Both layers refuse on their own (plan §F.4: 两层的直接调用入口各自重检), and the store's own rules are the ones no writer can skip.

The other entry the record touches is `TaskService.startRunIn`, which accepts `options.manifest` and writes the task's `CapabilityResolved` in the *same commit* as `TaskRetried` + `TaskStarted`: a recovery attempt re-resolves the rows the deployment holds now (a capability applied after the first attempt failed is part of what the attempt is for), and the resume path rebuilds a run's authorization from that record. Omitted — every ordinary start — the manifest the task was admitted with stands, which is the only manifest there was.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: an added optional event-body property is a minimum-decision `same-version` case. Old stores contain no `recovery` field, so replaying them is unchanged; a build that predates the field reads a store written by this one with every other member intact and ignores the addition (there is no reader that must interpret it to replay). A store written by this build is never replayed by mixed-version code — a task store is scoped to one root session and writer and reducer ship together. The reuse semantics are additive by construction: with no `recovery`, `runMemberTaskIds` is the previous concatenation.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, digests unchanged — no `--write` needed). New evidence for the record and its readers:

- the reducer's refusals and the stored shape: `task-runtime/tests/unit/recovery.spec.ts` (a first attempt, an answered key, an attempt in a new process over the same log, an in-flight exclusion, a settled attempt releasing the diagnosis, the request-shape/caller/success-source/cross-store/wrong-run/wrong-diagnosis refusals, the capability-gap and ceiling refusals, and five reuse-citation refusals — each asserting the refusal named its item and that the store gained no run);
- the reuse reading its own position and the original acceptance judging the attempt: `tests/integration/a6-recovery.spec.ts` (a failed member re-run while its passed sibling is read: the sibling keeps exactly one run, the attempt's member sequence is the sibling first, and the composite verdict names `child #0 (<sibling>)` from the *old* run's evidence) and the artifact-gap case (a blocked member's product produced and consumed by the attempt, with the original map satisfied at its position);
- the restart boundaries: the two cases in `task-runtime/tests/unit/recovery.spec.ts` under "the persistent boundaries across a restart" (an attempt with no batch yet is resumed, not cancelled or duplicated, and the ceiling still counts it; an attempt whose submission was recorded but never settled is judged after the restart, with no second run).
