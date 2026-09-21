---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-task-contract-normalization

## Summary

Adds optional fields to types carried inside `task/event` payloads, all from the T1 batch (construction guide `docs/task-contract-construction-guide.md` §4/§8, "unified normalized contract"): `TaskInstance.contract?: TaskContract` (carried inside the `TaskCreated` payload's `TaskInstance`) and `TaskDecomposed.admission?: DecompositionAdmission`. T1 gives every creation entry one normalized contract data definition (version 1, defaults filled, criterion ids fixed before hashing, `assumptions` and `constraints` persisted rather than left in a spawn prompt); a stored instance's `objective`, `acceptanceCriteria` and `requestedCapabilities` are projections of that contract and are refused when they disagree with it; and a decomposition event can carry the batch identity it was admitted under — the proposal digest plus the `AdmissionContext` limits, keeping enforced values (`maxDepth`, `maxChildren`, `wallTimeMs`) apart from audit-only ones. No event kind, envelope, or payload type text changes — both fields sit on types the payload text refers to.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-task-contract-normalization
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; both added fields live on types the payload text refers to |

`TaskInstance.contract` is a `TaskContract` (`task/src/contract.ts`): `{ contractVersion: 1, objective, acceptanceCriteria, assumptions, constraints, requiredCapabilities }` — the closed set of contract facts, with every array present, criterion ids already fixed, and text stored verbatim. `TaskState.assertContract` refuses a creation whose contract declares an unknown version, carries a malformed string list or a non-string objective, or disagrees with the instance's projection fields (compared through `canonicalize`, so key order is not a difference) instead of letting either side stand in for the other.

`TaskDecomposed.admission` is a `DecompositionAdmission`: `{ proposalDigest, context }`, where `context` is an `AdmissionContext` — `{ maxDepth, maxChildren, wallTimeMs?, auditOnly: { maxToolCalls?, tokens?, attempts? } }`. `TaskState.assertAdmission` refuses an empty or non-string digest, a non-object context or `auditOnly`, a non-integer or negative `maxDepth`/`maxChildren`, and a non-finite optional limit, so an unusable batch record is never stored. `TaskService.decomposeIn` passes the optional admission through to the event.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and both additions sit on transitively referenced types (`TaskInstance` via the `TaskCreated` payload member, `TaskEventPayloads.TaskDecomposed`). Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: adding an optional event-body property is a minimum-decision `same-version` case, twice over. Both fields are optional everywhere they appear — `contract` is absent on every task created before the field existed (its three projection fields remain the whole contract, read exactly as before, with nothing invented for the parts the store never held: no assumptions, no constraints, no version), and `admission` is absent on every decomposition admitted before the field existed. Old stores contain neither field, so replaying them under the new build is unchanged; older readers ignore both without changing replay. The envelope keeps `ignorable: true`, writer and reducer ship together, and a task store is scoped to one root session, so a single store is never replayed by mixed-version code. The one behavior the batch adds is a refusal, not a rewrite: an event whose contract or admission record is malformed is rejected on apply rather than silently stored, valid payloads are stored verbatim, and an absent field is never mistaken for a malformed one. The external Evolution ledger (`proposals.jsonl`) is untouched.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, digests unchanged — no `--write` needed): `verify-persistence: OK — 4 event roots match docs/persistence-schema.json.` New coverage in `task/tests/unit/task-state.spec.ts`: a contract-bearing creation is stored and read back unchanged, key-order spellings compare equal, each projection disagreement (objective, acceptance criteria, requested capabilities), an unknown version and a non-string assumption are refused with the task count unchanged, a contract-less task still applies, a well-formed admission applies, eleven malformed admission variants (including array-valued `context`/`auditOnly`) are refused leaving the parent decomposable, and an admission-less decomposition still applies. The end-to-end half — contract persisted, read back from the event log, and byte-identical after reopening the store — is `tests/integration/task-contract.spec.ts` (T1-D), which asserts the same two fields through the real `TaskService` + `TaskRuntime` + `VerifierRegistry`.
