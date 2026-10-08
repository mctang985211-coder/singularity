---
description: "Stamp new graphs with the singularity/graph@2 protocol marker, retire stored RSI progress, and add RsiConfig.epoch."
kind: persistence-change
---

# 2026-10-08-graph-protocol-v2

## Summary

`GraphRecord` gains an optional `protocol?: GraphProtocol` (`{ id: 'singularity/graph@2', version: 2, since }`) that `GraphsService.create` stamps on every new graph; a record without the marker is a sealed legacy graph (read-only history). The marker is a creation property and is never rewritten, so sealing is derived from its absence and needs no migration write. `RsiConfig` gains optional `epoch?: number` (integer >= 1, default 1, stamped at launch): bumping it is the one explicit way to start a graph's search over.

The same change retires stored loop progress: `GraphRecord.rsiProgress`, the `RsiProgress` type, and the `GraphsEvent` member `{ kind: 'graph/rsi-progress'; id; progress }` are deleted, and `GraphsService.markRsiProgress` with them. Progress is now derived from coordination facts, not stored on the registry. `graph/rsi` no longer drops stored progress (there is none); it still sets or clears the config without touching the frozen root task.

## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-graph-protocol-v2
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
| `event:graphs/event` | `GraphsEvent` | Removed one event type (`graph/rsi-progress`); `graph/add` payloads now carry `protocol`, and `rsi` may carry `epoch`; no type renamed |

The changed members (declared with JSDoc, as every event member must be):

- `GraphRecord.protocol?: GraphProtocol` — the persisted protocol marker, written on `graph/add` at creation.
- `RsiConfig.epoch?: number` — the persisted objective epoch; absent reads as epoch 1.
- Removed: `GraphRecord.rsiProgress?: RsiProgress` and `GraphsEvent`'s `graph/rsi-progress` member. `GraphsState.apply` tolerates a persisted `graph/rsi-progress` event as a no-op, so logs written before this change still replay.

## What old records do

| Old record | New build reading it |
|---|---|
| `graph/add` whose graph has no `protocol` | applies unchanged; the graph is a sealed legacy graph and reads as `legacy-readonly` |
| `graph/add` whose graph carries `rsiProgress` | applies unchanged; the extra field rides along as inert data no reader consults |
| a `graph/rsi-progress` event | replays to nothing; the registry no longer stores progress |
| `graph/rsi` whose config has no `epoch` | applies unchanged; the config reads as epoch 1 |

An old build reading a new `graph/add` skips nothing (the kind is known) and simply ignores the extra `protocol`/`epoch` fields; a new build never emits `graph/rsi-progress`, and an old build would have skipped it via the envelope's `ignorable: true` anyway.

## Compatibility

`same-version`. The added fields are optional and the removed ones were optional and absent-by-default, so old records omit nothing they need and carry nothing that misleads. The removal rows of the decision table target changes that break replay or reads; here both directions are pinned by test: the reducer replays a persisted `graph/rsi-progress` event as a no-op (`graphs/tests/unit/legacy-replay.spec.ts`), and legacy records read as sealed history. The declaration-level fingerprint does not move, because the digest covers the event name and the payload type text (`GraphsEvent`); union membership and transitively referenced types are acknowledged by this record alone. The `--write` run left the inventory byte-identical, and the sibling `.schema.json` repeats the unchanged after digest.

## Verification

`node scripts/verify-persistence.mjs --write` regenerated the inventory byte-identical (4 event roots, `event:graphs/event` digest unchanged); `node scripts/verify-persistence.mjs --check` passes. New unit specs: `graphs/tests/unit/protocol.spec.ts` (4 tests: marked=current, unmarked=legacy-readonly, `assertCurrentGraph` throws `graph-sealed`) and `graphs/tests/unit/legacy-replay.spec.ts` (2 tests: persisted `graph/rsi-progress` replays to nothing, unmarked records carry no marker). Retained specs in `tests/integration/graphs-lifecycle.spec.ts` now cover protocol stamping, the epoch default at launch, explicit epoch set/replace, and config clear with progress cases removed; `tests/integration/rsi-loop-driver.spec.ts` observes loop positions through the driver's progress observer instead of the deleted registry field.

From the harness root, `node node_modules/vitest/vitest.mjs run --project unit packages/singularity/graphs/tests packages/singularity/task/tests packages/singularity/graph/tests` passes 492 tests across 12 files, and `--project integration` over `graphs-lifecycle.spec.ts` and `rsi-loop-driver.spec.ts` passes all 37. No live graph was changed for this verification.
