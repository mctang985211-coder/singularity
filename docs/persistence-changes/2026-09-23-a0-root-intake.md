---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-23-a0-root-intake

## Summary

Extends the T2/T3 proposal payloads with a second **kind** — a root contract — without adding, removing or renaming anything the four proposal events already declare. `TaskProposal` becomes a discriminated union: `kind: 'decomposition' | 'root'` (absent means `decomposition`, so every stored record still reads as it was), the decomposition arm is unchanged, and the root arm (`TaskProposalRoot`) carries a `RootProposalIdentity` (`contractVersion`, `storeId`, `rootSessionId`, `requestKey`, `contractDigest`) plus the single normalized `TaskContract` the proposal asks to run, instead of a `batch` of children. `TaskProposalConsumption` becomes the same kind of union: the batch arm (`kind?: 'batch'`, `batchId` + `childTaskIds`) is unchanged, and the root arm (`kind: 'root'`, required) names the one root task and root run an activation minted. `ROOT_PROPOSAL_TASK_ID` (`'root-proposal'`) joins the module as the reserved envelope `taskId` a root proposal's events carry, so an intake's events can name no task that exists and no real task can impersonate one. `TaskService` gains one entry, `admitRootProposalIn`, which writes the root task, its admission, its capability manifest, its run and the proposal's consumption in **one** commit; the reducer gains the kind-branched identity/consumption assertions and the one-root gate (a store that already holds a root task refuses a root intake, in the same commit that would have written the second one). No event kind, no event name and no payload type text changes — the four proposal events and their payload type names (`TaskProposal`, `TaskProposalConsumption`, `TaskProposalDecisionClaim`, `TaskProposalPhaseChange`) are exactly what they were; what moves is the shape of the types those names refer to.

This is the store-side half of the A0 delivery group (design `docs/2026-09-23-a0-root-intake-design.md` §2; implementation notes in `docs/singularity-harness-guide.md` §5.11). The runtime half — `intakeRootContract`, the root's review/activation ladder, `adoptRoot`, the recovery pass for root proposals — lives in `task-runtime/src/index.ts` and writes only through the entries above.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Kind discrimination and the root activation](#kind-discrimination-and-the-root-activation)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-23-a0-root-intake
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the four `TaskProposal*` members keep their names and their payload type texts, whose shapes gain a second kind |

What the four members now carry (`task/src/proposal.ts`, with JSDoc on every member as this directory requires):

- `TaskProposalSubmitted: { proposal: TaskProposal }` — `TaskProposal` is `TaskProposalDecomposition | TaskProposalRoot`. The decomposition arm is byte-for-byte the record T2/T3 wrote (`kind?: 'decomposition'`, `identity: DecompositionIdentity`, `batch: readonly TaskProposalChild[]`); the root arm is `{ kind: 'root', identity: RootProposalIdentity, contract: TaskContract }`. `proposalId` is `p-` + `rootProposalDigest(identity)` for a root contract, the same derivation and prefix as `taskProposalId` for a batch.
- `TaskProposalDecided: TaskProposalDecisionClaim` — unchanged: the decision binds `proposalDigest` + `admissionContextDigest` (+ `reviewContextDigest` for an approval), whichever kind the proposal is.
- `TaskProposalPhaseChanged: TaskProposalPhaseChange` — unchanged; the tightening, re-check and stale edges apply to both kinds.
- `TaskProposalAdmitted: TaskProposalConsumption` — `TaskProposalBatchConsumption | TaskProposalRootConsumption`. The batch arm is unchanged (`kind?: 'batch'`); the root arm is `{ kind: 'root', proposalId, proposalDigest, reviewContextDigest, rootTaskId, rootRunId, admittedAt, reason? }`.

`RootProposalIdentity` is `{ contractVersion, storeId, rootSessionId, requestKey, contractDigest }`: a root contract has no parent task and no parent run — the root task is what the proposal *becomes* — so its identity names the root session the contract is the goal of, and the request key is inside the identity (a root intake is answered by key, and the default key is derived from the store, the root session and the contract's content). `contractDigest` is T1's `contractDigest(contract)` of the contract stored beside it; the reducer refuses a submission where the two disagree.

Reducer discipline (`task/src/service/state.ts`), all of it branching on `kind` and none of it reachable from a stored record:

- `submitProposal` (`TaskProposalSubmitted`): a root record is checked as a root — the identity's fields are present and its `requestKey` equals the record's, the contract is one this build can read (version, non-empty lists, string objective), `contractDigest(contract)` equals the identity's, the decomposition-only members (parent task, parent run, reason, children) are absent, and the envelope's `taskId` must be `ROOT_PROPOSAL_TASK_ID` — and the envelope marker is refused everywhere else, in both directions (a root event may not name a task, a decomposition event may not carry the marker). Everything shared with the batch arm is shared: the birth status per policy, the id/request-key freedom, the three digests, the closed review context.
- `decideProposal`, `changeProposalPhase` — unchanged rules, applied to either kind; the decision's three digests are checked against the stored record the same way.
- `admitRootProposalIn` → `TaskProposalAdmitted` (`admitProposal` with a root consumption): the consumption must state `kind: 'root'`, carry the stored `proposalDigest` and `reviewContextDigest`, name exactly the task and run the commit contains, and the store must not already hold a root task; the task must be parentless and carry the contract the proposal committed to. The batch arm's rules (one batch id per parent, distinct child ids) are unchanged, and the two arms are kept apart by kind: a root consumption under a batch proposal (or the reverse) is refused by name.

The declaration-level fingerprint does not move, and this is the expected case rather than an exception: an inventory digest covers the event name and the payload **type text** — `'task/event': TaskEvent` — not the members of the types that text refers to. Per this directory's README, a change confined to transitively referenced types is acknowledged by record alone, which is what the sibling `.schema.json` repeats: the same after digest as `2026-09-22-task-proposal-review`. The same holds for the boundary the T2/T3 record already stated: `TaskProposalRoot`'s payload reaches the durable record only through members of types the digest text does not spell out.

<a id="kind-discrimination-and-the-root-activation"></a>
## Kind discrimination and the root activation

`kind` is a discriminant on the record and nowhere else: it is not part of either identity, so a writer that states `kind: 'decomposition'` explicitly produces the identical `proposalDigest` as one that omits it, and a record written before the field existed is read as a decomposition proposal. `TaskProposalIndex` (`all` / `byId` / `byRequestKey` / `byParentTask`) is unchanged; a root contract appears in the first three and in no `byParentTask` entry, because there is no parent task to index it under.

The activation is one commit (`task/src/index.ts:admitRootProposalIn`): `TaskCreated`, `TaskAdmitted`, optionally `CapabilityResolved`/`CapabilityGapDetected`, `TaskStarted` for the run and `TaskProposalAdmitted` with the root consumption. That is the same "children, admission, edges, phase change and consumption together" discipline as `admitBatchIn`, with a root's own vocabulary: the consumption names the minted ids instead of a `b-<parentTaskId>` batch, and the run must be born `active` in the proposal's root session. Before anything is queued, the entry refuses a proposal that is not a root contract and a consumption that does not name the task and run it creates; the store's own one-root gate is re-checked by the reducer inside the commit, so a racing second activation writes nothing even if it passed the read.

There is no second entry that creates a root task. The old graph entry's fixed `RootTaskSpec` root (`objective` = the graph's name, one composite criterion) can no longer be produced by any caller; stores that already hold one keep reading, verifying and completing it exactly as before, and a root intake on top of one is refused by name.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: no event was added, removed or renamed, no property was made required on an existing event body, and no declared payload type text changed. What changed is the shape of transitively referenced types, which this directory's README classifies as record-only acknowledgement and which the fixed table does not cover.

New build reading old records is fully compatible. Every stored proposal has no `kind` (or states `decomposition`) and is read on the decomposition arm with the same identities, digests and lifecycle; every stored consumption is on the batch arm; a store that holds no root proposal has none, and the one-root gate is satisfied by the store's own root task. `TaskInstance`, `TaskRun`, `TaskSnapshot` and the session header are untouched — a root task is an ordinary parentless task with a `contract`, written through events that already existed. Historical tasks are not re-judged: reading, verifying, replaying and completing an old root behaves exactly as it did, and no migration rewrites an objective.

Old build reading new records is refused, not misread, and the record does not claim otherwise. A build from before this change reads a root proposal's `TaskProposalSubmitted` as a decomposition proposal and refuses it by name — the reducer's batch assertion reports the missing batch (`task: proposal "p-…" batch must be an array`, the same message T2/T3's own mid-group state produced) — and the envelope marker `ROOT_PROPOSAL_TASK_ID` names no task, so the event cannot resolve a parent either. The envelope's `ignorable: true` lets a build skip an unknown event *type*; it does not cover a new shape under a known type. As in the T2/T3 record: writer and reducer ship together, a task store is scoped to one root session, and this is the intended fail-closed behaviour.

The external Evolution ledger is untouched. A root proposal is the task store's own event-sourced data, not an `EvolutionProposal`, and nothing about the root entry writes a side ledger.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory: `verify-persistence: OK — 4 event roots match docs/persistence-schema.json.` No `--write` was run and `docs/persistence-schema.json` was not touched, because no declaration moved — the four roots' digests are the ones `2026-09-22-task-proposal-review` recorded. The fingerprints were measured across the whole group (phases A and B): the inventory was read before and after the store-side and runtime-side work and reported the same four digests.

`pnpm build` in `packages/singularity` passed for every workspace package. The group's own runs on the final tree (stage D, 2026-09-23, recorded in the plan's A0 + R0 entry): unit `44 files / 1441 tests`, integration `37 files / 258 tests`, both fully green; `git diff --check` clean.

Coverage of the shapes above, read back from the store rather than from a writer's return value:

- `task/tests/unit/proposal.spec.ts` — the root arm's fixed identity vectors (`rootProposalDigest`/`rootProposalId`), the birth statuses per policy, the kind-branched refusal table (a root record with a parent, a batch record under the root marker, a contract that does not digest to its identity, an unknown contract version), the decision binding for a root proposal, and the consumption rules (a root consumption that names another task or run, a batch consumption under a root proposal and the reverse, a second activation on a store that already holds a root).
- `task-runtime/tests/unit/proposal-lifecycle.spec.ts` — the runtime ladder over the same events: submission, the review policy, the activation commit and its consumption, idempotent continuation, the post-approval re-check, the stale/expired arms, and `adoptRoot`'s adoption of an existing root.
- `tests/integration/root-intake.spec.ts` (11 cases, real DSH loop) and `tests/integration/root-intake-recovery.spec.ts` (7 cases, real JSONL restart) — the end-to-end states this record's shapes carry: the activated root and its consumption, the zero-side-effect refusals, and the crash points where the decision, the activation and the binding land in different processes.
