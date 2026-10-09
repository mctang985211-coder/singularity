---
description: "Add RsiConfig.strategy: the graph-level switch between the regularized and unregularized RRSI strategy policies."
kind: persistence-change
---

# 2026-10-09-rsi-strategy

## Summary

`RsiConfig` gains an optional `strategy?: 'regularized' | 'unregularized'` (default `'regularized'`). It is the graph-level switch of the three-arm comparison: a graph whose config names `unregularized` evaluates, decides and folds history under `UNREGULARIZED_STRATEGY_POLICY` (every regularizer off); any other graph runs `DEFAULT_STRATEGY_POLICY`. The selected policy is frozen into every evaluation plan (`EvaluationPlan.strategy`, with policy and cohort digests) and named in the strategy decision record written beside the report, so the choice is traceable from the persisted records alone. `RsiLaunch` accepts the field at creation; `setRsi` replaces it with the config; the registry validator refuses any other value by name.

## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-rsi-strategy
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
| `event:graphs/event` | `GraphsEvent` | `graph/add` and `graph/rsi` payloads may carry `rsi.strategy`; no type renamed |

The changed member (declared with JSDoc, as every event member must be):

- `RsiConfig.strategy?: 'regularized' | 'unregularized'` — the persisted strategy switch; absent reads as `'regularized'`.

## What old records do

| Old record | New build reading it |
|---|---|
| `graph/add` or `graph/rsi` whose config has no `strategy` | applies unchanged; the graph reads as the regularized default |

An old build reading a new event skips nothing (the kinds are known) and simply ignores the extra `strategy` field; its method tools then run the regularized policy, which is the default the field encodes.

## Compatibility

`same-version`. The field is optional and absent-by-default, so old records omit nothing they need and carry nothing that misleads. The declaration-level fingerprint does not move, because the digest covers the event name and the payload type text (`GraphsEvent`); the transitively referenced `RsiConfig` change is acknowledged by this record alone. The `--write` run left the inventory byte-identical, and the sibling `.schema.json` repeats the unchanged after digest.

## Verification

`node scripts/verify-persistence.mjs --write` regenerated the inventory byte-identical (4 event roots, `event:graphs/event` digest unchanged); `node scripts/verify-persistence.mjs --check` passes. New unit specs: `agent-singularity/tests/unit/method-shared.spec.ts` (policy selection per graph strategy, last-round edit budget per arm) and `agent-singularity/tests/unit/method-evaluate.spec.ts` (the decision record's policy digest per arm); `evolution/tests/unit/evaluation-pipeline.spec.ts` (the caller-selected policy frozen into the plan and moving the scope). The integration spec `tests/integration/graphs-lifecycle.spec.ts` covers strategy validation refusal and create/setRsi persistence with replay. No live graph was changed for this verification.
