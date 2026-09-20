---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-17-singularity-custom-events-initial

## Summary

Baseline for the four custom Session event types declared by the singularity workspace (`graph/event`, `graphs/event`, `layout/event`, `task/event`), including the `ReviewRecorded` member of the task payload union. Gives later transitions a starting point stored in this tree.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-17-singularity-custom-events-initial
baseline: true
changes:
  - root: "event:graph/event"
    previous: null
    after: "f97245856a7303e50d23f5ff83c72f07f816de6b259d6633bf0dc5e154b3221e"
    decision: same-version
  - root: "event:graphs/event"
    previous: null
    after: "2a75c5fb3153994d18895e11870380006540691a6aea33bc04ab47fb8ce16d4f"
    decision: same-version
  - root: "event:layout/event"
    previous: null
    after: "f6c87e2eaf9370beacbacdca1a7a37bbd427a041304bd24c7171f0669cf114fd"
    decision: same-version
  - root: "event:task/event"
    previous: null
    after: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    decision: same-version
```

<a id="registered-shapes"></a>
## Registered shapes

| Root | Payload | Current shape |
|---|---|---|
| `event:graph/event` | `GraphEvent` | Union of 5 kinds: `agent/add`, `agent/status`, `group/add`, `member/add`, `edge/add`; replayed by `GraphState` per graph store |
| `event:graphs/event` | `GraphsEvent` | Union of 4 kinds: `graph/add`, `graph/select`, `graph/ready`, `graph/remove`; replayed by `GraphsState` in the `graphs-registry` store |
| `event:layout/event` | `LayoutEvent` | Union of 2 kinds: `node/set`, `node/remove`; replayed by `LayoutState` per layout store |
| `event:task/event` | `TaskEvent` | Discriminated union over 17 `TaskEventPayloads` members on a `kind` tag, with envelope fields `taskId`, optional `runId`/`sessionId`/`parentTaskId`, `timestamp`, `actor`, `payload`, `schemaVersion: 1`; replayed by `TaskState` per task store |

The newest `TaskEventPayloads` member is `ReviewRecorded: { review: ReviewRecord }`: one lightweight terminal record per run, written exactly once when the run reaches its terminal state. `ReviewRecord` carries `taskId`, optional `runId` and `sessionId`, `outcome` (`verified` / `failed` / `cancelled` / `blocked`), `evidenceRefs`, `anomalies`, optional `localizedCause` (failed only), and optional `relatedTaskIds`.

<a id="compatibility"></a>
## Compatibility

This baseline introduces no transition: all four roots are new (`previous: null`) and record the shapes current producers already write. All four events persist with the envelope's `ignorable: true`, so a build that does not know a type skips it instead of refusing the log. Later changes classify per the fixed rules in this directory's README; digest fingerprints cover the declaration-level contract (event name + payload type text), so changes inside the referenced payload types are acknowledged by record alone.

<a id="verification"></a>
## Verification

`node scripts/verify-persistence.mjs --write` generated `docs/persistence-schema.json` (4 event roots); `--check` passes and is wired as `pnpm run verify-persistence`. Negative probes against the checker all exit 1: an undocumented member, a duplicate event name, and a documented-but-unrecorded new event (reported as drift). `pnpm build` in `packages/singularity` passed for all 12 workspace packages. In the harness root, `pnpm test` passed 273 unit tests (47 files) and `pnpm test:integration` passed 87 integration tests (17 files).
