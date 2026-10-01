---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-a7-improvement-rounds

## Summary

Gives the recovery attempt the new contract's two kinds by adding a **required** `kind: 'recovery' | 'improvement'` to `RunRecovery` (the payload type behind every `TaskStarted` a recovery opens). `recovery` re-runs a failed source, `improvement` re-runs a verified one; both are judged by the same original acceptance criteria, and each source task spends its two caps separately — the runtime counts `kind` across the task's own runs and refuses the round past the cap with the coded `iteration-cap`. Two reducer rules move with it: `assertRunRecovery` requires the member (a record without one cannot be counted against the cap it spends), and `TaskState.start` admits `verified → running` for the one run that declares itself an improvement round. The caller's request gains `mode: 'recovery' | 'improve'` (default `recovery`), which is request-side only and is not itself persisted; the stored `kind` is what a later read counts.

The required member is not same-version-shaped: it is added to a record kind that already exists in stored logs, so an attempt written before this change carries no `kind` and this build refuses it by name instead of guessing. The decision below is therefore `version-bump`, the consequence is stated (an old recovery attempt is a stopped old state, no migration or compatibility reader exists), and the declaration-level fingerprint does not move: digests cover the event name and the payload type text (`TaskEvent`), so a change inside the transitively referenced types is acknowledged by this record alone.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [What old records do](#what-old-records-do)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-a7-improvement-rounds
baseline: false
changes:
  - root: "event:task/event"
    previous: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    after: "196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861"
    decision: version-bump
```

<a id="registered-shapes"></a>
## Registered shapes

| Root | Payload | Current shape |
|---|---|---|
| `event:task/event` | `TaskEvent` | Unchanged declaration; no event type is added, renamed or removed, and no payload type text moves |

The changed member (declared in `task/src/types.ts` with JSDoc, as every member must be):

- `RunRecovery.kind: 'recovery' | 'improvement'` (**required**) — which round of iteration the attempt is. `recovery` re-runs a failed source, `improvement` re-runs a verified one; the improvement run must stay green against the original criteria, and a failed improvement returns the source to the failed path so subsequent rounds spend the recovery cap.
- `RunRecovery.sourceRunId` keeps its spelling and its optionality, re-documented: the failed run a `recovery` recovers, the verified run an `improvement` re-earns the criteria from.

Reducer and entry rules, so a reader of the shape sees where it is enforced:

- `TaskState.start` (`task/src/service/state.ts`) admits `verified → running` exactly when `run.recovery?.kind === 'improvement'`; every other run keeps the old `admitted|ready → running` rule.
- `assertRunRecovery` (`task/src/service/checks/runs.ts`) refuses a record whose `kind` is neither value, naming the member; the position check now labels the source run by kind (`the failed run` / `the verified run`).
- `RootRecoveryRequest.mode?: 'recovery' | 'improve'` (`task-runtime/src/recovery.ts`) is the caller's side of the same fact; the request digest includes the derived `kind`, so one key cannot name an attempt of one kind and be replayed as the other. **Not persisted:** no event carries a request.
- `recoveryRoundsOf` counts the two kinds across the task's runs (a row written before `kind` existed would count as a recovery, but such a row is refused by the reducer first), and the runtime reads the caps from the `singularitySupervision` service or its own `supervision` config, falling back to the shipped `3`/`2`.

<a id="what-old-records-do"></a>
## What old records do

| Old record | New build reading it |
|---|---|
| `TaskStarted` whose run carries no `recovery` | applies unchanged (an ordinary first attempt) |
| `TaskStarted` with a `recovery` record **without** `kind` | **refused by name**: `task: run recovery of "…" requires kind "recovery" or "improvement" (an attempt without one cannot be counted against the cap it spends)` |
| every `RunRecovery` member added before this change (`requestDigest`, `unboundMembers`, …) | kept and read as before |

The first row is what almost every stored run is. The second row is the decision this record exists to state: the new contract's caps are counted *by kind*, so an attempt whose kind was never recorded cannot be placed on either side of the accounting — reading it as a recovery would be a guess about a persisted fact, and the store refuses guesses by name elsewhere (A3, A4, K1 all took the same stance). There is **no compatibility reader, no migration and no old/new switch**: a store that holds such a record is not opened by this build, and the deployment archives or abandons it rather than having a cap counted from a guessed kind.

<a id="compatibility"></a>
## Compatibility

`version-bump`, by the table's "make an optional property required / add a required property" row, and deliberately not the same-version row a merely optional addition would take. The property is required on a record kind that already exists in stored logs, so a record written by this build carries a field a record of the same event kind written before it cannot have, and the new reader refuses the old record rather than defaulting it.

Everything else in this change is same-version-shaped and would have been recorded as such on its own: no event type is added, renamed or removed; `TaskRun.recovery`'s optionality does not move; the `verified → running` edge only admits a run that declares itself an improvement round; and the request-side `mode` is not persisted. The strongest decision governs the root, so the root is `version-bump`.

Reading direction, stated plainly for both sides:

- **New build ← old records**: readable for every record except a recovery attempt without `kind` (table above). No stored record becomes unrepresentable, and no field is reinterpreted silently.
- **Old build ← new records**: refused, by name, at replay — the old reducer has no `kind` check to consult but the old `start` refuses `verified → running`, so at minimum every improvement round's `TaskStarted` stops an old build; `TaskState.apply` is fail-closed. The envelope's `ignorable: true` lets a build skip an unknown event *type*; it does not cover a new member inside an event the old build already knows.

What this record does **not** change: the upstream Session header and the event envelope (no `schemaVersion` move — that is upstream-owned and is never done here), the four `task/event`-root declaration fingerprints, and the store's per-root-session scoping. The fingerprint does not move because the digests cover the event name and the payload type text (`TaskEvent`); the sibling `.schema.json` therefore repeats the unchanged after digest, and no `--write` run was needed.

<a id="verification"></a>
## Verification

`node scripts/verify-persistence.mjs --check` passes with the unchanged inventory (4 event roots, `event:task/event` digest unchanged — no `--write` needed; the change lives inside the types the payload text refers to). `pnpm build` in `packages/singularity/task` and `packages/singularity/task-runtime` both completed (including their dts pass). The two packages' unit suites are green: `npx vitest run --project unit packages/singularity/task/tests packages/singularity/task-runtime/tests` — 32 files, 1084 tests.

New coverage, conclusions read back from the store's own snapshot or the refusal it produced:

- `task-runtime/tests/unit/recovery.spec.ts` — an improvement round of a verified source is accepted with `kind: 'improvement'`, its named verified source run, the verified positions bound (the member keeps its one run), and the goal moving `verified → running` while its old facts stay readable; a verified source that names no mode is refused with the improvement door in the message; `mode: 'improve'` on a failed source and a mode that is neither value are refused by name; the recovery cap refusal is an `IterationCapRefusal` with `code === 'iteration-cap'` and the "no run was opened" text, and so is the improvement cap; a failed improvement round returns the source to `failed` and the next round is a `recovery` that spends the recovery cap, counted separately from the improvement attempt; the caps read from the plugin's own `supervision` config when no service is exposed; the same key under another mode is refused as different content; the new attempt's kickoff notice carries the prior round's review facts (per-criterion verdicts and the metrics line) and no score; the resumed attempt's notice carries the same facts.
- `task/tests/unit/task-state.spec.ts`, `task/tests/unit/task-service.spec.ts` and the rest of the `task` suite — unchanged and green, which is the point of the old-path preservation: with both caps at their defaults and no verified source recovered, every stored transition is the one the previous build wrote.
