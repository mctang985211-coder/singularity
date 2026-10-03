---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-graph-model-pin

## Summary

Lets a graph pin the model its later spawns run under. Two declaration-level additions carry it: `GraphRecord` gains an optional `model?: GraphModel`, and `GraphsEvent` gains the ordinary event type `{ kind: 'graph/model'; id; model: GraphModel | null }`. `model: null` returns the graph to the deployment default. Both are additive and absent-by-default, so the decision is `same-version`: a record written before this change omits `model` and reads as a graph that follows the deployment default, which is exactly what it meant.

The pin is read by the graph registry's own `graphAgentOptions` and merged into `agentOptions` at the four spawn doors (graph creation/recovery, task-runtime worker spawn, the coordination claim-and-spawn, and `graph_spawn`). It reaches only agents spawned after the pin changes; existing sessions keep the selection they were created under.

## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-graph-model-pin
baseline: false
changes:
  - root: "event:graphs/event"
    previous: "2a75c5fb3153994d18895e11870380006540691a6aea33bc04ab47fb8ce16d4f"
    after: "2a75c5fb3153994d18895e11870380006540691a6aea33bc04ab47fb8ce16d4f"
    decision: same-version
```

## Registered shapes

| Root | Payload | Current shape |
|---|---|---|
| `event:graphs/event` | `GraphsEvent` | Added one event type (`graph/model`); no type renamed or removed |

The added members (declared with JSDoc, as every event member must be):

- `GraphsEvent` — `{ kind: 'graph/model'; readonly id: string; readonly model: GraphModel | null }` — pins, replaces, or clears (`null`) one graph's model. Reducer: `GraphsState.apply` (`graphs/src/service/state.ts`) drops the existing `model` before re-adding, so clearing leaves no `model` key.
- `GraphRecord.model?: GraphModel` — the persisted pin, written on `graph/add` when the create body carried one.

## What old records do

| Old record | New build reading it |
|---|---|
| `graph/add` whose graph has no `model` | applies unchanged; the graph follows the deployment default |
| any `GraphsEvent` written before `graph/model` existed | applies unchanged; the new kind is simply never seen |

An old build reading a new `graph/model` event skips it via the envelope's `ignorable: true` and then reads the graph as unpinned — a lost pin, never a wrong selection.

## Compatibility

`same-version`, by the table's "add an optional event-body property" and "add an ordinary event type" rows: both additions are optional and absent-by-default, no existing field changes type or optionality, and no event is removed or renamed. The declaration-level fingerprint does not move, because the digest covers the event name and the payload type text (`GraphsEvent`); the sibling `.schema.json` therefore repeats the unchanged after digest and no `--write` run was needed.

## Verification

`node scripts/verify-persistence.mjs --check` passes with the unchanged inventory (4 event roots, `event:graphs/event` digest unchanged). New coverage: `tests/integration/graph-model.spec.ts` pins, replaces, and clears a model through the service and reads the pin back from a second service replaying the same event log, so both the `graph/add` persistence and the `graph/model` reducer are exercised end to end.
