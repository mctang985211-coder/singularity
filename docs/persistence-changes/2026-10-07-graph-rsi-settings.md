---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-graph-rsi-settings

## Summary

Lets a graph carry the settings for an autonomous recursive-self-improvement loop and the driver's position in it. The additions are declaration-level: `GraphRecord` gains optional `rsi?: RsiConfig` and `rsiProgress?: RsiProgress`, and `GraphsEvent` gains the two ordinary event types `{ kind: 'graph/rsi'; id; rsi: RsiConfig | null }` and `{ kind: 'graph/rsi-progress'; id; progress: RsiProgress }`. `rsi: null` clears the config; a set or a clear also drops stored driver progress. Clearing disables the loop; setting resumes/reconciles the same frozen root task and its recorded runs. It does not create a new objective epoch, alter the root's acceptance contract, or discard historical rounds. A new objective requires a new graph. All of it is additive and absent-by-default, so the decision is `same-version`: a record written before this change omits both fields and reads as a graph that runs no improvement loop and reports no progress, which is exactly what it meant.

`RsiConfig` carries the launch/UI objective text (`task`), the total iteration count (`iterationRounds`, an integer >= 1) and the human-review toggle (`humanReview`: true queues HITL approval gates for a person, false lets the platform auto-resolve them). Changing `task` in this config does not rewrite an already frozen task. The registry validates a config by name on `create` and `setPins` — a non-blank `task`, an integer `iterationRounds >= 1`, a boolean `humanReview`, and no field outside those three — and stores it verbatim. `setModel` and `setRsi` delegate to `setPins`; `PATCH /singularity/graphs/:id` sends both settings through that same serialized entry. All supplied settings are validated before one batch of the existing `graph/model` and `graph/rsi` events is appended and one final snapshot is broadcast. A malformed RSI config cannot leave a new model pin behind. The request type `GraphPinsUpdate` is not persisted; this transactional entry adds no event type or stored field. The driver reads the stored config and writes `rsiProgress` through `markRsiProgress`.

## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-graph-rsi-settings
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
| `event:graphs/event` | `GraphsEvent` | Added two event types (`graph/rsi`, `graph/rsi-progress`); no type renamed or removed |

The added members (declared with JSDoc, as every event member must be):

- `GraphsEvent` — `{ kind: 'graph/rsi'; readonly id: string; readonly rsi: RsiConfig | null }` — sets, replaces, or clears (`null`) one graph's RSI config. Reducer: `GraphsState.apply` (`graphs/src/service/state.ts`) drops both the existing `rsi` and `rsiProgress` before re-adding. This resets driver bookkeeping only; a configured driver reconciles the same root contract and recorded rounds.
- `GraphsEvent` — `{ kind: 'graph/rsi-progress'; readonly id: string; readonly progress: RsiProgress }` — the driver's live position (`round` 1-based, `phase` one of `running`/`publishing`/`debugging`/`done`/`failed`, optional `note`); the reducer replaces the stored progress and never touches the config.
- `GraphRecord.rsi?: RsiConfig` — the persisted loop settings, written on `graph/add` when the create body carried one.
- `GraphRecord.rsiProgress?: RsiProgress` — the persisted loop position, absent until `markRsiProgress` writes one.

## What old records do

| Old record | New build reading it |
|---|---|
| `graph/add` whose graph has no `rsi` and no `rsiProgress` | applies unchanged; the graph runs no improvement loop and reports no progress |
| any `GraphsEvent` written before these kinds existed | applies unchanged; the new kinds are simply never seen |

An old build reading a new `graph/rsi` or `graph/rsi-progress` event skips it via the envelope's `ignorable: true` and then reads the graph without loop settings or progress — a lost setting, never a wrong one, and a graph with no config runs no loop rather than one with the wrong objective.

## Compatibility

`same-version`, by the table's "add an optional event-body property" and "add an ordinary event type" rows: both record fields are optional and absent-by-default, no existing field changes type or optionality, and no event is removed or renamed. The declaration-level fingerprint does not move, because the digest covers the event name and the payload type text (`GraphsEvent`); `RsiConfig` and `RsiProgress` are transitively referenced types, which records acknowledge by declaration alone. The sibling `.schema.json` therefore repeats the unchanged after digest and the `--write` run left the inventory byte-identical.

## Verification

`node scripts/verify-persistence.mjs --check` passes (4 event roots, `event:graphs/event` digest unchanged). Retained specs in `tests/integration/graphs-lifecycle.spec.ts` cover valid create and progress event replay, invalid create without environment/session side effects, set/replace/repeated-set/clear dropping progress while preserving the graph root, old records without RSI fields, and unknown-graph refusals. They drive the registered HTTP route against the real registry to check invalid RSI plus valid model, invalid model plus valid RSI, empty updates, successful combined updates with one append/broadcast, persistence failure, and serialization while model validation awaits. Replay opens a new registry over a detached copy of the persisted event envelopes; the session persistence backend itself is mocked. Route unit specs retain create and all settings forwarding cases.

From the harness root, `pnpm exec vitest run --project unit --project integration packages/singularity/graph-web/tests/unit/routes.spec.ts packages/singularity/tests/integration/graphs-lifecycle.spec.ts packages/singularity/tests/integration/graph-model.spec.ts packages/singularity/tests/integration/graph-web.spec.ts` passes all 48 tests across 4 suites. No live graph was changed for this verification.
