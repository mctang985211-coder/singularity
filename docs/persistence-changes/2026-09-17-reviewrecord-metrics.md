---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-17-reviewrecord-metrics

## Summary

Enriches `ReviewRecord` — the payload of the `ReviewRecorded` member of `task/event` — with the eight review dimensions and the six engineering-effort indicators that P4 left unbuilt (the P4 design corpus names all eight dimensions and lists the six indicators; it defines neither a scoring scale for the former nor a unit for the latter). Motivation and shape follow §2.7.3 (Review ≠ Judge): `dimensions` records only facts a reader can mechanically check (counts, declared modes, granted and actually-called names, raw token buckets) and `metrics` records counters; neither carries a score, an LLM judgement, or transcript text, so Diagnosis stays the place that answers "why". The two additions are optional throughout and are omitted rather than defaulted when their source is unavailable.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-17-reviewrecord-metrics
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the `ReviewRecorded` member's `ReviewRecord` gains two optional fields |

New optional fields on `ReviewRecord` (all in `task/src/types.ts`, all JSDoc-documented):

| Field | Presence | Content |
|---|---|---|
| `dimensions?: ReviewDimensions` | every record whose task was readable | the eight dimensions as observed facts: `outcomeCorrectness`, `taskSpecification`, `acceptance`, `decomposition`, `capabilityCoverage`, `skillFit`, `toolFit`, `contextEfficiency` — each itself optional, each omitted when its source is missing |
| `metrics?: ReviewMetrics` | when at least one counter was collectable | `tokens?` (whole-session `tokenUsage` projection), `toolCalls?` (`{calls, failures}`), `humanInterventions?`, `retries?`, `evidenceLogs?` |

Supporting types added beside them: `ReviewTokenUsage`, `ReviewToolCall`, `ReviewToolCallTotals`, `ReviewDimensions`, `ReviewMetrics`, and the per-dimension fact shapes. All are additive type declarations; no existing field changed type or optionality.

Two indicators are deliberately **not** recorded: `time` is already the top-level `durationMs` (run `startedAt` → terminal transition, verification included) and is not duplicated; `artifactCount` has no producer at all (`ArtifactRef` is written by nobody and `TaskRun.artifacts` is always empty), so `evidenceLogs` — criteria carrying a `logRef` — stands in, named for what it actually measures.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and this change lives inside the transitively referenced `ReviewRecord` type. Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: every addition is an optional event-body property, nested inside an optional property. Old records simply omit both fields, and old readers ignore them on replay — `TaskState.recordReview` validates only the pre-existing invariants (one record per terminal run, cause/log-tail/blocker direction) and reads no member of either addition, so no absent or unexpected shape can reject a record. The envelope keeps `ignorable: true`, so a build that does not know the type skips the event entirely.

<a id="verification"></a>
## Verification

`node scripts/verify-persistence.mjs --check` reports OK — 4 event roots match `docs/persistence-schema.json`; the inventory was not regenerated because no declaration-level digest moved. `pnpm build` in `packages/singularity` passed for all workspace packages. New coverage: the cascade writes `dimensions` and `metrics` from an injected observation and omits both when the session services are absent (`task-runtime/tests/unit/review-record.spec.ts`); `task_review_pack` renders the metrics clause and the dimension lines while keeping log text out (`agent-singularity/tests/unit/task-tools.spec.ts`); an integration run drives the real `TaskService`/`TaskRuntime` with the real token projection and reads the recorded fields back out of the persisted `task/event` log (`tests/integration/review-metrics.spec.ts`). In the harness root, `pnpm exec vitest run --project unit` and `--project integration` both passed.
