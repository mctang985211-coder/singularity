---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-17-diagnosis-recorded

## Summary

Adds `DiagnosisRecorded: { diagnosis: Diagnosis }` as the 19th member of the `TaskEventPayloads` union behind `task/event`, completing the P4 sequence TaskRun → ReviewRecord → Diagnosis (guide §2.7.3–§2.7.5, §3.2 P4). A diagnosis is the review's core product — an explanation (`observedFailure` / `scope` / `localizedCause` / `confidence` in high|medium|low, never a score) grounded in `evidenceRefs` / `reviewRefs`, with `proposals` as structured suggestions that never auto-execute (§2.7.6: no automatic production changes in P4) and `relatedTaskIds` for cross-task lineage (§2.7.4: the diagnosis graph is a DAG, not a tree). The snapshot gains a `diagnoses` array.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-17-diagnosis-recorded
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the union gains the `DiagnosisRecorded` member |

The new member (declared in `task/src/types.ts` with JSDoc, as every member must be):

`DiagnosisRecorded: { diagnosis: Diagnosis }` where `Diagnosis` is `{ diagnosisId, taskId, observedFailure, scope, localizedCause, evidenceRefs, reviewRefs, confidence: high|medium|low, proposals: { targetType, targetId, rationale }[], relatedTaskIds? }` and `targetType` is the frozen nine-type enum of §2.7.6 (`skill / tool / capability / task_definition / decomposition_policy / agent_preset / workflow_policy / verifier / runtime_policy`), kept name-aligned for the P5 Evolution registry.

Reducer discipline (`TaskState.recordDiagnosis`): a diagnosis is caller-triggered, not lifecycle-bound; the id is unique across the store (a repeat write is rejected, diagnoses are immutable); the task must exist and match the envelope; all text fields must be non-empty; confidence must be one of the three enum values; at least one evidence or review ref is required; every proposal names one of the nine target types plus target id and rationale; `relatedTaskIds` must name existing tasks in the store. Writes go through `TaskService.recordDiagnosisIn` and the `task_diagnose` tool; evidence assembly is the read-only `task_review_pack` tool.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and this change lives inside the union member list the payload type refers to. Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: adding an ordinary event type is the minimum-decision case. Old stores contain no `DiagnosisRecorded` events, so replaying them under the new build is unchanged. The envelope keeps `ignorable: true`, so a build that does not know the type skips the event entirely; writer and reducer ship together, and a task store is scoped to one root session, so a single store is never replayed by mixed-version code.

<a id="verification"></a>
## Verification

`node scripts/verify-persistence.mjs --write` regenerated `docs/persistence-schema.json` (4 event roots, digests unchanged); `pnpm run verify-persistence` passes. `pnpm build` in `packages/singularity` passed for all workspace packages. New unit coverage: reducer accepts one diagnosis and accumulates several per task, rejects a repeated id / unknown or mismatched task / empty fields / stray confidence / missing refs / bad proposal target / unknown relatedTaskIds (`task/tests/unit/task-state.spec.ts`); `recordDiagnosisIn` persists, refuses a repeated id, rejects malformed diagnoses before anything persists, and diagnoses survive the append → close → open replay round trip (`task/tests/unit/task-service.spec.ts`); `task_review_pack` assembles the nested pack (own reviews in full with criteria/logTail/blockedBy, parent and children summaries, dependency edges) and `task_diagnose` persists, renders proposals as suggestions-only, and surfaces store rejections as text (`agent-singularity/tests/unit/task-tools.spec.ts`). In the harness root, `pnpm test` passed 295 unit tests (47 files) and `pnpm test:integration` passed 87 integration tests (17 files).
