---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-parent-acceptance-evidence-identity

## Summary

Adds optional fields to types carried inside `task/event` payloads, all from the same P4 batch (execution prompt `docs/execution-prompts/04-parent-acceptance-evidence-identity.md`, plan S1-V slices 1+3): `AcceptanceCriterion.acceptsArtifact?: string[]`, `AcceptanceCriterion.childEvidence?: ChildEvidenceRef[]`, and `AcceptanceCriterion.heuristic?: boolean` (all carried inside the `TaskCreated` payload's `TaskInstance`), plus `TaskInstance.requiresIndependentAcceptance?: boolean` (same payload). The batch implements the minimal mechanical parent acceptance (KISS §6 C2/C4): a parent criterion may declare which child of its decomposition batch — by position — it rests on, optionally narrowed to a child criterion and an evidence reference, judged at parent-acceptance time against the store; `requiresArtifact` is tightened to a verified reference product while `acceptsArtifact` keeps the raw-input (existence-only) semantics as its own field; a criterion may be labeled heuristic, which is never counted as a deterministic pass; and the contract-level marker refuses a creation or decomposition whose task demands independent acceptance without a map. No event kind, envelope, or reducer rule changes — the reducer copies payloads verbatim and validates none of the new fields.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-parent-acceptance-evidence-identity
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; every added field lives on a type the payload text refers to |

`ChildEvidenceRef` is `{ childIndex: number; criterionId?: string; evidenceRef?: string }`: a child named by its 0-based position in the parent's decomposition batch (the only child identity that exists when the parent's criteria are authored, since child task ids are minted at decomposition time), optionally narrowed to one of the child's criteria and one evidence id / artifact kind / artifact id. Admission validates the shape only; the composite verifier judges the mapping at parent-acceptance time and an incomplete mapping fails the criterion naming the missing items.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and every added field sits on a transitively referenced type (`AcceptanceCriterion` via `TaskInstance`, `TaskInstance` itself). Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest — the same situation as `2026-09-20-obligation-recorded`'s `requiresArtifact` field and `2026-09-20-verifier-ref-unknown-kind`'s `verifierRef`.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: adding an optional event-body property is a minimum-decision `same-version` case, four times over. Old stores contain none of the new fields, so replaying them under the new build is unchanged: every field is optional everywhere it appears, the reducer validates and copies none of them, and every reader treats absence exactly as before (no map keeps the composite conjunction as the whole verdict, no `acceptsArtifact` adds no raw-input gate, no heuristic label keeps a passing verdict counting, no marker adds no admission rule). Older readers ignore the fields without changing replay. The one deliberate behavior change inside an old field is `requiresArtifact`'s tightened match — a reference is now satisfied only by evidence from a verified run carrying a passing verdict, where a failed run's same-named product used to count; that is the point of the batch, it fails closed, and it changes no stored bytes. The envelope keeps `ignorable: true`, writer and reducer ship together, and a task store is scoped to one root session, so a single store is never replayed by mixed-version code. The external Evolution ledger (`proposals.jsonl`) is untouched.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, digests unchanged — no `--write` needed). `pnpm build` in `packages/singularity` passed for all workspace packages. New coverage: the composite verifier's map judgement and heuristic label (`verifier/tests/unit/composite-verifier.spec.ts`); the admission shape checks, the marker-without-map refusal, and the heuristic/map exclusivity (`task-runtime/tests/unit/admission.spec.ts`); the tightened `requiresArtifact` match, the raw-input `acceptsArtifact`, the heuristic closure, and the admission refusals persisting nothing (`task-runtime/tests/unit/orchestrate.spec.ts`); and the whole chain on the real `TaskService` + `TaskRuntime` + `VerifierRegistry`, read back from the persisted event log, including the replay path sharing the admission rule (`packages/singularity/tests/integration/parent-acceptance.spec.ts`). In the harness root, `pnpm vitest run --project unit packages/singularity` passed 636 unit tests (25 files) and `--project integration` passed 103 integration tests (20 files); `agent-singularity`'s `pnpm exec tsc --noEmit` reported 0 errors.
