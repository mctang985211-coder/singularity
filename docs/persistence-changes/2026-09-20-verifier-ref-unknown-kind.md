---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-20-verifier-ref-unknown-kind

## Summary

Adds three optional fields to types carried inside `task/event` payloads, all from the same VRTC batch (guide §4.2 #23/#24/#25, temporary plan `docs/2026-09-20-vrtc-code-change-plan.md` phases 1.3/1.4/2.1/2.2): `AcceptanceCriterion.verifierRef?` (KISS §4.1 `verifier_ref` — a criterion may pin its judge by registered id, carried inside the `TaskCreated` payload's `TaskInstance`), `unknownKind?: 'task' | 'verifier'` on `VerificationResult` (inside `EvidenceProduced`'s `EvidenceBundle`), on `EvidenceClaim` (same bundle), and on `ReviewCriterion` (inside `ReviewRecorded`'s `ReviewRecord`) — the KISS §4.3 UNKNOWN split that tells "the criterion was never tested" from "the verifier could not judge". The same batch's `Verifier` registry metadata (`version` / `owner` / `selftest`) lives on the in-memory registry only and never enters an event payload.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-20-verifier-ref-unknown-kind
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; all three fields live inside types the payload text refers to |

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and every added field sits on a transitively referenced type (`AcceptanceCriterion` via `TaskInstance`, `VerificationResult`/`EvidenceClaim` via `EvidenceBundle`, `ReviewCriterion` via `ReviewRecord`). Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest — the same situation as `2026-09-20-obligation-recorded`'s `requiresArtifact` field.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: adding an optional event-body property is a minimum-decision `same-version` case, three times over. Old stores contain no `verifierRef` and no `unknownKind`; replaying them under the new build is unchanged — both fields are optional everywhere they appear, the reducers validate neither (they copy payloads verbatim), and every reader treats absence exactly as before (dispatch by `verificationMode`; no unknown-kind tag in the failure text). Older readers ignore both fields without changing replay. The envelope keeps `ignorable: true`, writer and reducer ship together, and a task store is scoped to one root session, so a single store is never replayed by mixed-version code.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, digests unchanged — no `--write` needed). `pnpm build` in `packages/singularity` passed for all workspace packages. New unit coverage: an unknown `verifierRef` rejects the whole decomposition batch at admission listing the registered ids, a registered id is admitted and stored, and a replay contract with an unknown ref is rejected before anything persists (`task-runtime/tests/unit/orchestrate.spec.ts`); `verifierRef` dispatch by id, unknown ref / unsupported mode / a throwing verifier all settle inconclusive with `unknownKind: 'verifier'`, and the claim copies the kind (`verifier/tests/unit/verifier-registry.spec.ts`); the command verifier tags its inconclusives `unknownKind: 'task'` and distinguishes its declared selftest samples for real (`verifier/tests/unit/command-verifier.spec.ts`); the orchestrator's failure text renders `[unknown: task — …]` vs `[unknown: verifier — …]` and the review record carries the kind (`task-runtime/tests/unit/orchestrate.spec.ts`). The budget work of the same batch (Config `budget` / `noProgressRounds`, the wall-clock forced exit, the post-hoc annotations) touches no event payload. In the harness root, `pnpm test` passed 658 unit tests (59 files) and `pnpm test:integration` passed 130 integration tests (24 files).
