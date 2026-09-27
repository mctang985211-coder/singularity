---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-k4-budget-extension

## Summary

Adds the approved-budget-extension surface to the `task/event` root: one new kind (`TaskBudgetExtended`), the types behind it (`TaskBudgetExtension`, `TaskBudgetExtensionClaim`, `BudgetExtensionProposal`, `BudgetRaise`, `TaskBudgetExtensionIndex`, `BudgetExtensionRequest`, `ApprovedBudgetCeilings`), the derivation vocabulary (`budgetExtensionRequestDigest`, `canonicalBudgetInstant`, `approvedBudgetCeilings`, `emptyBudgetExtensionIndex`, `describeBudgetExtension`), a `budgetExtensions` member on `TaskSnapshot` (all extensions in record order, indexed by request key) and one `TaskService` entry (`recordBudgetExtensionIn`).

The record says what a person raised, per dimension, as an absolute pair — the ceiling in force when the request was read → the ceiling approved now — with the request's content identity, the session that asked and the reference the approval channel minted for the question it put to the person (`approval:<ApprovalRequestId>`, read back by the runtime out of the channel's own `approval/asked` + `approval/decided` record on that session's log). It deliberately does not say how much was *added*: an increment applied to a value that moves is not an authorization, and the pair is what lets the next request be recognised as a raise from a known value.

The same change resolves the runtime's root budget from those facts (`root-budget.ts`): `ResolvedRootBudget` keeps `configured` (what the deployment's `rootBudget` resolves to against the root's own start) beside the ceilings in force, so an approved dimension is enforced everywhere a configured one is, without the deployment's own numbers being lost. Nothing persisted moves by that: the configuration is not in the store, and deliberately stays out of it.

The fact's producer is the model-facing tool `task_budget_extend` (`agent-singularity/src/tools/budget-extend.ts`): it reads the query (`TaskRuntime.budgetExtensionDraft`), puts the store, both ceilings, the usage and the request's approval binding to a person through the workspace's approval channel, and hands the committing entry (`TaskRuntime.extendRootBudget`) only the identity of that tool call — which reads the channel's own record of the ask and its `allowed-once` decision back out of the asking session's log, and refuses everything else. A rejection, a cancellation, an unavailable answerer, a call the channel never recorded and an approval of another store, request or tool all write nothing.

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
id: 2026-09-27-k4-budget-extension
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; one kind is added (`TaskBudgetExtended`), and no existing kind, payload type text or field is renamed or removed |

The changed members (all declared with JSDoc, as every member must be):

- `TaskBudgetExtended: { extension: TaskBudgetExtensionClaim }` — the new kind. The envelope names the tree's root task (a parentless task) and the asking session; the claim carries `requestKey`, `requestDigest`, the raise pairs (`maxRuns?: BudgetRaise<number>`, `deadlineAt?: BudgetRaise<string>`) and `approvalRef` / `requestedBy`. At least one pair is required; a payload without the asking session, without an approval reference, or naming a session that is not the store's own root session is refused by the reducer.
- `TaskSnapshot.budgetExtensions?: TaskBudgetExtensionIndex` — optional at the type level for the same reason as `proposals` and `questions` (a hand-built snapshot predates it), always present on this build's own value, with `all` (record order) and `byRequestKey` (one key names at most one extension). The stored record adds one reducer-derived field, `recordedAt`, taken from the event's own timestamp and never from the caller.
- No existing type changes shape: `ResolvedRootBudget` is a runtime type (never persisted) and gains `configured`, and every stored member keeps its declaration, so a store written by this build replays on it exactly as it was written.

Derivations (one implementation each, shared by the writers and the readers):

- `budgetExtensionRequestDigest({requestKey, maxRuns?, deadlineAt?})` in `task/src/budget.ts` — the request identity: the key and the totals, over the canonical form of each. The `previous` ends are deliberately outside it: they are readings, not requests.
- `canonicalBudgetInstant(value)` — the canonical UTC spelling of the absolute instant a deadline denotes, or `undefined` for one that denotes none (an unreadable value, a bare local time, a duration in words). Readers normalize through it; the reducer additionally requires the *stored* form to be canonical.
- `approvedBudgetCeilings(extensions)` — the ceilings the store's extensions leave in force: each dimension keeps the `next` of the last extension that moved it, and a dimension no extension names answers `undefined` (the deployment's own value still stands).
- `emptyBudgetExtensionIndex()` and `describeBudgetExtension(extension)` — the empty index a fresh store answers, and the one phrase a refusal uses to say what a request key already holds.

<a id="what-the-reducer-decides"></a>
## What the reducer decides

`TaskState.apply('TaskBudgetExtended')` validates the whole payload before anything is applied, and commits nothing when it refuses:

- **Where the raise is rooted.** The envelope must carry the asking session and the record's `requestedBy` must be the same session, that session must be the store's own root session (`rootTaskStoreId(requestedBy) === snapshot.id`), and the envelope's task must be a parentless task of the store. A delegated worker, another session's tree and a child task are each refused by name.
- **The shape of a raise.** The claim's field set is closed (an unread field is refused rather than stored); one request key is non-empty; the approval reference is non-empty; each pair states a positive whole run count or two canonical absolute instants; and each pair only moves up.
- **The identity.** The declared `requestDigest` must be the identity of the key and totals the record carries — refusing a record whose identity disagrees with its content, the same discipline proposals keep.
- **The chain.** A dimension an earlier extension already moved has to be asked for from the value *that* extension left: the reducer re-reads the ceilings the store holds (`approvedBudgetCeilings`) and refuses a record written against an older reading. Two grants approved against one reading therefore cannot both stand, and neither is silently re-based on the other's result — the entry's serial re-read, inside the store's single write queue, is what decides between them.
- **Idempotency.** A repeat under the same key with the same identity applies nothing (no second fact), and the same key at different content is refused by name. The service entry answers a repeat of a stored request from the record, so the retry path appends no event at all.

What it deliberately does not do: it starts no run, resumes none, un-settles none, creates no task, child or candidate, opens no gate and recovers no store. An extension moves ceilings and nothing else, and the ceilings it moves are only ever read through `resolveRootBudget`.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: an ordinary added event type, plus added optional event-body properties, are both minimum-decision `same-version` cases. The declaration-level fingerprint does not move — digests cover the event name plus the payload type text `TaskEvent`, and the new kind lives inside the transitively referenced `TaskEventPayloads` union — so per this directory's README the change is acknowledged by record alone, and the sibling `.schema.json` repeats the unchanged after digest (the same situation as `2026-09-25-a4-questions` and `2026-09-26-k1-multi-batch`).

A new build reading old records is fully compatible: a store written before this change holds no extension events, its `budgetExtensions` index replays empty, and its budget resolves exactly as it did (`configured` equals what is in force; no approved ceiling is invented for a dimension nobody raised). The `task-service.spec.ts` assertion on the empty snapshot a `createStore` returns was extended with the new empty index; no other expectation moved.

An old build opening a store that contains a `TaskBudgetExtended` event refuses it by name at replay (`task: unknown event kind "TaskBudgetExtended"`): the envelope's `ignorable: true` lets a build skip an unknown event *type*, but not an unknown kind under the known `task/event` type. That is the intended fail-closed behaviour — an older build cannot tell an approved ceiling from a note, and enforcing the configured ceiling while a person's grant sits unread in the log is exactly the failure this record exists for. It is also the rollback limit: a rollback must happen before any store records an extension, or accept that the store does not open until the newer build is restored. Nothing else about the change is hard to revert: the types, derivations and entries are additive, and `ResolvedRootBudget.configured` is a runtime type with no persisted counterpart.

<a id="verification"></a>
## Verification

`pnpm run build` in `task` and in `task-runtime` passed (both `lib/` rebuilt, the dts pass included). `node scripts/verify-persistence.mjs --check` passes with 4 event roots unchanged, `task/event` digest `196cc188…a861` — the declaration moved no fingerprint, which is why no inventory regeneration was needed and why the sibling `.schema.json` carries the same after digest.

New coverage, all conclusions read back from the store's own snapshot or event log, never from a writer's return value:

- `task/tests/unit/budget-extensions.spec.ts` (new, 11 tests) — the identity (key + totals; one instant has one canonical spelling; a bare local time and a duration denote none); the reducer's happy path with the raise recorded and nothing else moved; idempotency of a repeat at both the entry (no event appended) and the reducer (`apply` twice is one record); the same key at other totals refused with the store byte-identical; a record written against a moved ceiling refused (and the same request chained onto the value in force accepted, landing as the new total rather than the sum); a non-canonical deadline, a deadline that does not move later and a run count that does not move up all refused; an empty approval reference, a payload that raises nothing, a foreign identity and an unread field all refused with zero writes; a hand-written event naming a worker's session, a session that disagrees with the record, no session at all, or a child task each refused by name; replay (a state built from the log equals the live snapshot, and re-applying the extension events is a no-op); a reopen deriving the same records; and a fresh store answering an empty index.
- `task-runtime/tests/unit/root-budget.spec.ts` (extended) — an approved run ceiling wins over the configured one while `configured` keeps the deployment's number; only the dimension an extension moved changes; an approved deadline is the stored instant (and survives a configuration that stops setting a wall time); the last extension of a dimension is the one in force; `checkRunStart`/`checkBatchAdmission` enforce the approved total (a start refused by the configured total is allowed by the approved one, the store's count is never reset, and the batch reservation is refused whole only above the new total); and `runDeadlineMs` still measures a run's own window from its own `startedAt`, so an extension never resets it. The five expectations that built `ResolvedRootBudget` literals were updated for `configured`; no assertion changed meaning.
- `task-runtime/tests/unit/budget-extension.spec.ts` (new, 11 tests) — the query reports the configured and effective ceilings, the usage and the draft, and writes nothing (snapshot and event log unchanged); a stored key is answered from the record and the same key at other totals refused; the full refusal surface of the query (no key, no dimension, a fractional total, a non-raise read as an increment, a local time, a duration in words, a deadline that does not move later) with each reason named; an unlimited dimension refused per dimension; a worker session, an unresolvable graph and a session whose graph roots elsewhere each refused before any store is opened; the commit records the raise and moves no run, task or usage fact (with the resolver now reporting the approved deadline beside the configured one); a repeat commit returns the stored record with nothing appended; the commit's refusals (no approval reference, a stale reading, a baseline that does not name the dimension, a non-raise) all leave the store untouched; two commits approved against one reading cannot both stand, while the same request re-read is accepted as its own total; and a reopen plus a fresh process read the approved ceiling back and report both numbers.
- `task-runtime/tests/unit/orchestrate.spec.ts` (extended, end-to-end through the real entries; three K4 cases) — (1) a ceiling raised through `budgetExtensionDraft`/`extendRootBudget` while a child is parked keeps that child alive past the original deadline (the worker is neither cancelled nor failed after the old bound passes, and it settles `verified` inside the extended window), while the run that started before the grant keeps its own `startedAt`; (2) the same grant while a *worker* is parked in its own nested batch keeps that wait alive past the configured deadline (the run stays `running` in `waiting_children`, nothing is cancelled, and the nested batch's end settles it `verified`); (3) a grant that lengthens the tree's deadline does not lengthen a run's own window — with the per-run wall time the tight bound, the run is still stopped by it after the tree's ceiling moved far past it, the review naming `budget exhausted: wallTimeMs`, while `resolveRootBudget` reports the approved instant and the run keeps the `startedAt` it began with. With the pre-change one-shot timer restored in `orchestrate.ts` case 1 fails (`expected 'failed' to be 'running'`), which is the red-first evidence for the watchdog's per-judgement reading.

Suites: `pnpm exec vitest run` in `task` — 8 files / 470 tests passed; in `task-runtime` — 22 files / 581 tests passed. The whole-repository run is left to the integration slice.
