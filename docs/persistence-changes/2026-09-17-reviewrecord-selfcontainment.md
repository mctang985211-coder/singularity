---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-17-reviewrecord-selfcontainment

## Summary

Enriches `ReviewRecord` — the payload of the `ReviewRecorded` member of `task/event` — from a criterion-granularity pointer into a self-contained postmortem unit. Motivation: the 2026-09-17 graph8 live-run corpus evaluation (M1 report, P1 finding) showed a failed record carried only `mandatory criteria not satisfied: ac2-1 fail`, forcing a human reviewer three hops (record → evidence → log) to see the command, exit code, and log. The record now carries per-criterion verdicts with command/exitCode/logRef, a bounded log tail on failure, run duration, and structured blockers on blocked outcomes.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-17-reviewrecord-selfcontainment
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the `ReviewRecorded` member's `ReviewRecord` gains four optional fields |

New optional fields on `ReviewRecord` (all in `task/src/types.ts`, all JSDoc-documented):

| Field | Presence | Content |
|---|---|---|
| `durationMs?: number` | every record with a run | run start → terminal transition, wall-clock ms |
| `criteria?: ReviewCriterion[]` | records whose run was verified | per-criterion `{ criterionId, verdict, command?, exitCode?, logRef? }` from the verifier bundle |
| `logTail?: string` | failed only (reducer rejects otherwise) | tail excerpt of a failing criterion's log, capped at 40 lines / 2048 chars by `VerifierRegistry.logTail` |
| `blockedBy?: ReviewBlocker[]` | blocked only (reducer rejects otherwise) | `{ taskId, outcome }` per dependency that did not verify; `anomalies` keeps the human-readable text |

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and this change lives inside the transitively referenced `ReviewRecord` type. Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: every addition is an optional event-body property. Old records simply omit the new fields, and old readers ignore them on replay — `TaskState.recordReview` validates only the pre-existing invariants (one record per terminal run, cause/log-tail direction) plus the new direction rules, none of which reject an absent optional field. The envelope keeps `ignorable: true`, so a build that does not know the type skips the event entirely.

<a id="verification"></a>
## Verification

`node scripts/verify-persistence.mjs --write` regenerated `docs/persistence-schema.json` (4 event roots, digests unchanged); `pnpm run verify-persistence` passes. `pnpm build` in `packages/singularity` passed for all workspace packages. New unit coverage: reducer accepts criteria/durationMs and rejects logTail on non-failed and blockedBy on non-blocked (`task/tests/unit/task-state.spec.ts`); cascade writes criteria+logTail on failed, criteria without logTail on verified, blockedBy on blocked, durationMs everywhere a run exists (`task-runtime/tests/unit/review-record.spec.ts`); `VerifierRegistry.logTail` truncates to the line/char caps and tolerates missing logs (`verifier/tests/unit/verifier-registry.spec.ts`); `task_status` renders failing criterion ids with exit codes (`agent-singularity/tests/unit/task-tools.spec.ts`). In the harness root, `pnpm test` passed 282 unit tests (47 files) and `pnpm test:integration` passed 87 integration tests (17 files).
