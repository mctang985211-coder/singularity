---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-execution-receipts

## Summary

Introduces the execution receipt (RRSI refactor batch 2b): `TaskSnapshot.receipts?` (one immutable receipt per sealed Run, in sealing order) and one new event kind, `RunReceiptSealed: { receipt: ExecutionReceipt }`, written only by `TaskService.recordReceiptIn` and checked by the reducer's `assertReceiptRecord`. A receipt carries the Run's contract facts, the environment revision pin it was admitted against (`RevisionPin { revisionId, digest }`), its business input, its terminal review (as a reference plus the store's own criteria and evidence refs), the models its session log really called, the assets it consumed (`skills`, `templates`), the execution subtree frozen at sealing time, the drain conclusion, and an explicit completeness statement. The receipt's own `digest` is `sha256(canonicalize(receipt without digest))`.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-execution-receipts
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
| `event:task/event` | `TaskEvent` | Unchanged declaration text; `TaskEventPayloads` gained the member `RunReceiptSealed`, and `TaskSnapshot` gained the optional `receipts` array |

The added members, in full:

- `TaskEventPayloads.RunReceiptSealed: { receipt: ExecutionReceipt }` — one sealed Run's execution receipt (`task/src/receipt.ts`, `formatVersion: 1`, self-digesting).
- `TaskSnapshot.receipts?: readonly ExecutionReceipt[]` — absent on a store whose Runs predate the receipt protocol, so an old snapshot replays unchanged and every reader treats absence as "no receipt".

The reducer (`task/src/service/state.ts`, case `RunReceiptSealed`) calls `assertReceiptRecord(snapshot, receipt)` before appending: the run exists and is terminal with the receipt's own `outcome`, the run has no receipt yet, the frozen subtree is exactly that run's descendants, the review reference and criteria digest match the store's record, every evidence reference belongs to a bundle inside the subtree, the contract and environment facts match the stored task/run/binding, completeness agrees with its own missing-fact list, and the receipt's digest is its own content's. A receipt that disagrees with the store is refused, so no caller and no model can supply one.

## Compatibility

`same-version`, for two reasons that hold together. First, the declaration-level fingerprint does not move: digests cover event *name* + *payload type text*, and `event:task/event`'s payload text is still `TaskEvent`; a new member of the `TaskEventPayloads` union is a transitively referenced type, exactly like `TaskSnapshot`'s fields (see "Limitations" in the README — `node scripts/verify-persistence.mjs --write` was run for this record and is a no-op, the after digest equal to the before digest). Second, old records can omit the addition and older readers can ignore it without changing replay: `receipts` is optional, the new event kind is *added* rather than required, every singularity event persists with the envelope's `ignorable: true`, and a build that does not know `RunReceiptSealed` skips it and reads the same tree. The writer and the reducer ship together, and a task store is scoped to one root session, so no store is replayed by mixed-version code.

A Run admitted before environment revisions existed carries no `environmentRevisionId`; the sealer treats that by absence and writes nothing for it (an old graph is history and is never re-sealed), so no old store gains a receipt it never had.

## Verification

- `node scripts/verify-persistence.mjs --write && node scripts/verify-persistence.mjs --check` — OK, 4 event roots match `docs/persistence-schema.json` (the `event:task/event` digest is unchanged: `196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861`).
- New unit tests (from the harness root, `node node_modules/vitest/vitest.mjs run --project unit <paths>`):
  - `task/tests/unit/receipt-record.spec.ts` — 16 cases: the store accepts a corroborated receipt and refuses a second one, a foreign outcome, a non-terminal run, a mismatched criteria/contract digest, review criteria the record does not hold, an evidence reference outside the subtree, a foreign binding digest, bound skills that are not that run's binding, a subtree that does not descend, completeness that contradicts its own missing facts, a drain fact that contradicts the drain conclusion, unobserved model use, a missing review that is not recorded, and a tampered digest.
  - `task-runtime/tests/unit/session-facts.spec.ts` — 7 cases: injected skills without invented calls, only a successful `skill` result counting as loaded, `request/header` deduplication with counts, `task_decompose` observation with and without its successful result, human interventions and compactions, an empty log versus an unreadable one, and the shared failure/skill-name readers.
  - `task-runtime/tests/unit/receipt-seal.spec.ts` — 6 cases: the settlement seals a complete receipt and a repeat is answered from the store; an old-protocol run is unsupported and writes nothing; a missing session log is recorded as an incomplete fact; an unconfirmed drain waits for its log inside the bounded window; an unreadable run is refused before any log is read; a sealing failure leaves the terminal state, the review and the queue intact.
  - `task-runtime/tests/unit/receipt-usage.spec.ts` — 5 cases: a complete subtree aggregates, a partly reported member leaves one side absent, neither side complete is unknown, a non-terminal member is incomplete, and the frozen subtree ignores a replay admitted after the sealing.
- New integration tests (`--project integration`):
  - `tests/integration/receipt-seal-recovery.spec.ts` — a terminal run whose receipt could not be written is made up exactly once; a batch child is inside its parent's frozen subtree and both are sealed; an old-protocol run is reported unsupported with zero writes; a replay admitted after the sealing is not counted into the sealed run's subtree.
  - `tests/integration/receipt-consumer-parity.spec.ts` — the reading a consumer takes from a receipt equals the pre-replacement walk over `parentRunId` plus the review metrics, in the complete, partly-reported, unknown and non-terminal cases, and on a real sealed run; `requireReceiptFacts` names a fact it could not establish instead of assuming it.
- `task` and `task-runtime` unit suites: green (1233 passed, 1 skipped) with no regression in their pre-existing tests.
