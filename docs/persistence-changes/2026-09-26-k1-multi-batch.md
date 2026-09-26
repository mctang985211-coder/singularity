---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-26-k1-multi-batch

## Summary

Identifies a decomposition batch by the pair `(parentRunId, proposalId)` and lets one parent run have more than one, on the `task/event` root: `TaskProposalBatchConsumption` gains a **required** `parentRunId`, its `batchId` becomes the derived `b-<parentRunId>-<proposalId>` (`batchIdFor`), `TaskDecomposed` may carry the same three-field identity (`batchId`/`parentRunId`/`proposalId`, all three or none), `TaskRun` gains the optional `batches` accumulation the reducer derives from those events, and `RunPhaseChanged` gains the `waiting_children → active` edge that closes a batch and clears the run's current `batchId`. The composite verifier's `childIndex` — already a persisted property of an acceptance criterion — stops meaning "position in the one decomposition batch" and starts meaning "stable position in the judged run's accumulated members", and the run's members are read for the run (`TaskService.runMembersIn`) instead of for its task.

Two of those are *not* same-version-shaped: a required property is added to a batch consumption that already exists in stored records, and the equality that checks a consumption's batch id is replaced, so a `TaskProposalAdmitted` record written before this change is refused by name instead of read. The decision below is therefore `version-bump`, and the operational consequence is stated: an old in-flight batch is a stopped old state, and a recovery that meets one stops by name — it never guesses which run or which proposal it belonged to, and no compatibility reader, migration or "old batch" switch exists.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Why the batch identity is a pair](#why-the-batch-identity-is-a-pair)
- [What old records do](#what-old-records-do)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-26-k1-multi-batch
baseline: false
changes:
  - root: "event:task/event"
    previous: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    after: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    decision: version-bump
```

<a id="registered-shapes"></a>
## Registered shapes

| Root | Payload | Current shape |
|---|---|---|
| `event:task/event` | `TaskEvent` | Unchanged declaration; no event type is added, renamed or removed, and no payload type text moves |

The changed members (all declared in `task/src/types.ts` and `task/src/proposal.ts` with JSDoc, as every member must be):

- `TaskDecomposed` gains `batchId?: string`, `parentRunId?: RunId`, `proposalId?: string` — the batch identity, **all three or none**. A record written before this change carries none of them and is read exactly as it was: the parent's children accumulate as before and no run accumulation is invented for it.
- `TaskProposalBatchConsumption` gains `parentRunId: RunId` (**required**) and its `batchId` is now `batchIdFor(identity.parentRunId, proposalId)`, i.e. `b-<parentRunId>-<proposalId>`. The old `b-<parentTaskId>` spelling is no longer a batch id this build accepts from a consumption.
- `TaskRun.batchId` keeps its type and changes its meaning: it is the run's *current unfinished* batch (`waiting_children`), and the `waiting_children → active` edge clears it, so a run that returned to `active` reads with no batch id while `batches` keeps the history.
- `TaskRun.batches?: TaskRunBatch[]` is new: one entry per batch this run admitted, in admission order, each `{ batchId, proposalId, memberTaskIds }`. Optional and, unlike every writer-supplied field, reducer-derived — `TaskStarted` refuses a run that carries it at birth.
- `RunPhaseChanged` keeps `batchId?: string` unchanged as a type; which phases require it is a reducer rule, and it now covers both batch edges (`active → waiting_children`, `waiting_children → active`) and still refuses it for `submitted`. A3's record (`active → waiting_children` with `b-<parentTaskId>`) remains readable: the field's shape check is non-emptiness.
- `AcceptanceCriterion.childEvidence[].childIndex` keeps its type and changes its meaning: the stable 0-based position in the judged **run's** accumulated members, not the position in one batch. `dependsOn`'s batch-local indices are untouched — a later batch consumes an earlier batch's products through Artifact/Evidence references, not through a cross-batch index language.

Derivations (one implementation each, shared by every writer and reader):

- `batchIdFor(parentRunId, proposalId)` in `task/src/proposal.ts` — the only spelling of a batch id.
- `runMemberTaskIds(run)` in `task/src/types.ts` — a run's members: `batches[].memberTaskIds` concatenated in admission order.
- `TaskService.runMembersIn(storeId, runId)` — the same sequence resolved to tasks, and the source `CompositeTaskSource.runMembersIn` the composite judge reads.

<a id="why-the-batch-identity-is-a-pair"></a>
## Why the batch identity is a pair

A parent decomposes more than once — one batch per delegation round — so a batch id derived from the task (`b-<parentTaskId>`) cannot say which batch a run waits on, and a reader that derived one from a task id would read the wrong batch after the second admission. The pair that names exactly one batch is the run that opened and closed it (`active → waiting_children → active`) and the proposal whose consumption created its members: `admitBatchIn` now requires that consumption and derives the id from the same two values the reducer re-derives, so the `TaskDecomposed` identity, the phase change's batch id and the consumption cannot be three spellings of one batch. The admission-time `TaskDecomposed` event carries the identity, and the reducer refuses an event that names only part of it, names a run of another task, repeats a batch the run already holds, or spells an id other than `batchIdFor` of the pair it names.

<a id="what-old-records-do"></a>
## What old records do

| Old record | This build |
|---|---|
| `TaskDecomposed` with `childTaskIds` (+ `admission`) | applies unchanged: children accumulate, `decompositionStatus` becomes `decomposed`, no run accumulation |
| `RunPhaseChanged` `active → waiting_children` with `b-<parentTaskId>` | applies unchanged (batch id shape is still "non-empty"); the run simply has no `batches` entry for it |
| `RunPhaseChanged` `waiting_children → submitted` with a batch id | applies unchanged, batch id kept |
| `TaskStarted` with a phase-less run | applies unchanged |
| `TaskProposalAdmitted`, batch arm, `batchId: b-<parentTaskId>`, no `parentRunId` | **refused by name**: `task: proposal "…" consumption requires the parent run its batch belongs to; a consumption from before batches were identified by run and proposal is refused, not guessed at` |

The last row is the decision this record exists to state. An in-flight batch admitted before this change has no recorded proposal binding, so this build cannot tell which run admitted it, which proposal it was, or which members the second batch of that parent would be — and a recovery that guessed would hand a later reader a batch that is not the one the record describes. It is therefore a **stopped old state**: a store that holds such a consumption is not opened by this build (replay is fail-closed and throws the message above, naming the proposal), the deployment archives or abandons it rather than migrating it, and the recovery path that meets the refusal stops there instead of inventing an owner. Implementing that stop is the recovery slice's work; this record only fixes the decision and the shape it is read under. There is **no compatibility reader, no migration and no old/new switch** — a batch with no proposal binding has no identity to reconstruct, and inventing one is exactly what the K1 contract forbids.

A run that admitted batches before this change and is replayed afterwards keeps its stored fields, contributes no members to `runMembersIn`, and is therefore judged by nothing rather than by guessed members: a composite criterion over such a run answers `inconclusive` (`no child tasks`), which is the honest reading of "this run's membership was never recorded".

<a id="compatibility"></a>
## Compatibility

`version-bump`, by the table's "add a required property… change an existing type" row, and deliberately not the same-version row that a merely *optional* addition would take. Two changes decide it, and they are the same fact seen twice:

- `parentRunId` is required on a batch consumption, and the arm it is required on already exists in stored records: a `TaskProposalAdmitted` written by this build carries a field that a record of the same event kind written before it cannot have, and the new reader cannot read the old record — it refuses it by name. That is not a shape old records can "omit and still be read".
- the check the consumption's `batchId` is held to is *replaced*, not loosened: `batchIdFor(parentRunId, proposalId)` instead of `b-<parentTaskId>`. The old spelling is not accepted as an alternative, so a stored consumption whose id is well-formed under the old rule is refused under the new one.

Everything else in this change is same-version-shaped and would have been recorded as such on its own: the `TaskDecomposed` identity is optional and all-or-none, `TaskRun.batches` is a new optional projection field, `RunPhaseChanged`'s declaration does not move, and no event type is added, renamed or removed. The strongest decision governs the root, so the root is `version-bump`.

Reading direction, stated plainly for both sides:

- **New build ← old records**: readable for every record except an old batch consumption (table above). No stored record becomes unrepresentable, and no field is reinterpreted silently.
- **Old build ← new records**: refused, by name, at replay — the old reducer compares `batchId` with `b-<parentTaskId>` and refuses the new id, and `TaskState.apply` is fail-closed. The envelope's `ignorable: true` lets a build skip an unknown event *type*; it does not cover a different value inside an event the old build already knows. This is the same fail-closed stance as `2026-09-22-a3-coordination-phases` and `2026-09-25-a4-questions`, and no rollback path is claimed: a rollback has to happen before a store writes a batch under the new identity, or accept that the store's admitted batches cannot be read by the old build either.

What this record does **not** change: the upstream Session header and the event envelope (no `schemaVersion` move — that is upstream-owned and is never done here), the four `task/event`-root declaration fingerprints, and the store's per-root-session scoping. `node scripts/verify-persistence.mjs --write` rewrote `docs/persistence-schema.json` byte-identically: the digests cover the event name and the payload type text (`TaskEvent`), so a change inside the transitively referenced types is acknowledged by this record alone, which is why the sibling `.schema.json` repeats the unchanged after digest.

<a id="verification"></a>
## Verification

`pnpm build` in `packages/singularity` passed (the `task` and `verifier` packages rebuilt, including their dts pass); `node scripts/verify-persistence.mjs --write` rewrote `docs/persistence-schema.json` byte-identically (4 event roots, `task/event` digest unchanged) and `pnpm run verify-persistence` passes. `pnpm vitest run --project unit packages/singularity/task packages/singularity/verifier` reports the expected downstream breakage — 5 `task-runtime` test files (128 cases), all through `TaskRuntime.admitPrecheckedBatch` building a consumption without `parentRunId`, which the new reducer refuses by name — and one new compile error in `../task-runtime/src/index.ts:2873` (the same call site) against the five errors that file already reported before this change. That is this change's interface delta, owned by the follow-up slice, which also has to move that call site onto `batchIdFor` and drop its own `b-<parentTaskId>` derivation. The two packages this change owns are green.

New coverage, all reading conclusions back from the public snapshot (`snapshotIn`/`runIn`/`runMembersIn`/`taskIn`) or the event log, never from a writer's return value:

- `task/tests/unit/coordination.spec.ts` — the `waiting_children → active` edge (batch id required, absent/empty refused, the current `batchId` cleared, `batches` kept) and `active → waiting_children` after a return; a run refusing to be born with `batches`; the new refusal texts on the batch edges and the submitted phase; a service-level happy batch (identity written on `TaskDecomposed`, run `batches` and `runMembersIn` naming the members, the lossless-JSON round trip); `admitBatchIn` requiring the consumption and the parent run it names; a batch whose phase change cannot apply persisting nothing with the proposal left `ready`; a parent run accumulating two batches with the first's members never renumbered and a second run holding only its own; `decomposeIn` contributing no run accumulation.
- `task/tests/unit/task-state.spec.ts` — a second `TaskDecomposed` under a new proposal applying (the once-in-a-life gate is gone), the same `(run, proposal)` batch refused by name with the snapshot untouched, a batch identity that is not the pair it names / names another task's run refused, and the empty-batch rule still holding per batch.
- `task/tests/unit/proposal.spec.ts` — `batchIdFor`'s shape and its two halves moving independently; the consumption's `parentRunId` required, the old `b-<taskId>` shape refused by name, a foreign parent run and a foreign batch id refused with the derived id in the message; the stored consumption carrying `parentRunId`; the two `b-${PARENT}` assertions replaced by the derived id; and a hand-built store holding such a consumption failing `openStore` with exactly that refusal, which is the stop this record decides.
- `verifier/tests/unit/composite-verifier.spec.ts` — the run-level `childIndex` across two batches (the second batch's first member is position 1, not 0), an out-of-range index naming the accumulated member count, historical members resolving to their own run, and a run that admitted no batch answering `no child tasks`; `verifier-registry.spec.ts`'s task-service double implements `runMembersIn`, so the registry's dispatch tests judge the real membership source.
