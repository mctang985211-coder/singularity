---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-20-obligation-recorded

## Summary

Adds `ObligationRecorded: { obligation: Obligation }` as the 20th member of the `TaskEventPayloads` union behind `task/event`, and adds the optional `requiresArtifact?: string[]` field to `AcceptanceCriterion` (carried inside the `TaskCreated` payload's `TaskInstance`). Both belong to the same VRTC batch (guide §4.2 #20/#21, temporary plan `docs/2026-09-20-vrtc-code-change-plan.md` phases 1.2 and 3.3): an Obligation is the structured "what is still missing" record a failure, block, or capability gap raises (goal + criterion + source task; a question, never an action), and `requiresArtifact` is how a criterion declares its evidence dependencies (KISS §5.1). The snapshot gains an `obligations` array.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-20-obligation-recorded
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the union gains the `ObligationRecorded` member |

The new member (declared in `task/src/types.ts` with JSDoc, as every member must be):

`ObligationRecorded: { obligation: Obligation }` where `Obligation` is `{ obligationId, goal, criterion, sourceTaskId }`. Reducer discipline (`TaskState.recordObligation`): the id is unique across the store, goal and criterion must be non-empty, and the source task must exist. Writes go through `TaskService.recordObligationIn`; the writers are the orchestrator's missing-artifact block path (`task-runtime/src/orchestrate.ts`) and the capability-gap rejection (`task-runtime/src/index.ts`).

`AcceptanceCriterion.requiresArtifact` is an optional string array on a type the `TaskCreated` payload references transitively; admission validates the shape only (non-empty strings), and existence is judged at spawn time by the orchestrator.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and both changes live inside types the payload text refers to. Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: adding an ordinary event type and adding an optional event-body property are both minimum-decision `same-version` cases. Old stores contain no `ObligationRecorded` events and no `requiresArtifact` fields, so replaying them under the new build is unchanged; older readers ignore both without changing replay. The envelope keeps `ignorable: true`, so a build that does not know the type skips the event entirely; writer and reducer ship together, and a task store is scoped to one root session, so a single store is never replayed by mixed-version code.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, digests unchanged — no `--write` needed). `pnpm build` in `packages/singularity` passed for all workspace packages. New unit coverage: the reducer accepts and accumulates obligations and rejects a repeated id / empty fields / an unknown source task (`task/tests/unit/task-state.spec.ts`); `recordObligationIn` persists, refuses a repeated id, rejects malformed obligations before anything persists, and obligations survive the append → close → open replay round trip (`task/tests/unit/task-service.spec.ts`); the cascade blocks a child whose `requiresArtifact` is missing without spawning it, names the item in the blocked record, and registers it as an obligation, and a present artifact lets the child run (`task-runtime/tests/unit/orchestrate.spec.ts`). In the harness root, `pnpm test` passed 638 unit tests (59 files) and `pnpm test:integration` passed 130 integration tests (24 files).
