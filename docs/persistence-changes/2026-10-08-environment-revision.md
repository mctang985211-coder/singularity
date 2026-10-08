---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-environment-revision

## Summary

Introduces the environment-revision core (RRSI refactor batch 1b): an immutable, manifest-addressed revision store for a graph's skills, task templates and capability rows under `$DSH_HOME/singularity/environments/<libraryId>/{revisions,drafts}/`, with `pointer.json` as the single effective pointer, `pointer-intent.json` as the persisted in-flight switch, `completions.jsonl` as the append-only switch log, and `protocol.json` as the new-protocol marker (file-based storage, no Session events). On the task store side it adds four additive optional fields: `TaskRun.environmentRevisionId?` / `TaskRun.trialCandidateRef?` (carried inside the `TaskStarted` payload's `TaskRun`) and `RunProviderBinding.environmentRevisionId?` / `RunProviderBinding.trialCandidateRef?` (on the `TaskRun.providerBinding` record), recording which immutable environment revision a run was admitted against and which unpublished candidate an explicit trial bound. The reducer gained shape-only validation of these fields (valid revision-id shape when present; a run's trial candidate ref must differ from its environment revision id), gated on presence exactly like `providerBinding`.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-environment-revision
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the added fields live on the `TaskStarted` payload's `TaskRun` and on its transitively referenced `RunProviderBinding` |

New fields, all optional:

- `TaskRun.environmentRevisionId?: string` — the `EnvironmentRevisionManifest.revisionId` (`^[a-z0-9][a-z0-9-]{0,63}$`) this run was admitted against; absent on every run written before environment revisions existed (an old-protocol run, which readers including the receipt sealer treat by absence).
- `TaskRun.trialCandidateRef?: string` — the unpublished candidate revision an explicit trial bound; same id shape, never equal to `environmentRevisionId` on the same run.
- `RunProviderBinding.environmentRevisionId?: string` — the revision this binding's bytes were read from. The field is optional at the store layer for replay compatibility; the writer side (batch 2a's `run-binding.ts` rework) always sets it for new-protocol bindings.
- `RunProviderBinding.trialCandidateRef?: string` — same value as the run's own `trialCandidateRef` on a trial binding.

The reducer checks (`task/src/service/checks/runs.ts::assertEnvironmentRevision`, called from `TaskState.start`, plus `assertBindingEnvironment` inside `assertProviderBinding`) judge shape only and only when a field is present: id shape, and the not-equal rule between a run's two refs. Old stores carry none of these fields and replay unchanged.

The environment revision store itself (`task-runtime/src/environment/{revision,store,pointer,draft,index}.ts`) is file-based and declares no `SessionEventMap` member: revisions are immutable directories with a self-digesting `manifest.json` (`formatVersion: 1`), drafts are the single mutable region, and pointer switches follow a ten-step transaction (CAS on `{revisionId, generation}`, persisted intent, freeze-by-rename, verified read-back, atomic pointer write, read-back, completion record, intent clear) with `reconcileEnvironmentPointer` settling any crash window. A library root with the legacy mutable layout (an `index.json` / flat `skills/` without `protocol.json`) never gets a pointer and is served read-only.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: adding optional event-body properties. The declaration-level fingerprint does not move because digests cover event name + payload type text (`TaskEvent`), and the added fields sit on transitively referenced types — the same situation as `2026-09-22-run-provider-binding`. Replaying an old store under this build is unchanged: the new checks are gated on field presence, no old record carries them, and no reader invents them. Older readers ignore the fields without changing replay. The envelope keeps `ignorable: true`, writer and reducer ship together, and a task store is scoped to one root session, so a store is never replayed by mixed-version code. The revision/draft/pointer files live outside any event store and are never created for legacy-layout libraries.

<a id="verification"></a>
## Verification

- `node scripts/verify-persistence.mjs --check` — OK, all event roots match `docs/persistence-schema.json` (no `--write`: no digest moved).
- New unit tests (from harness root, `node node_modules/vitest/vitest.mjs run --project unit <paths>`), 31 tests green:
  - `task-runtime/tests/unit/environment-revision.spec.ts` — digest stability against key order, tampered-manifest refusal, pure edit functions, version+1 on a shared base, `task-coordination` retirement refusal, `expectedVersion` refusal, capability-row derivation.
  - `task-runtime/tests/unit/environment-store.spec.ts` — initial-revision seeding, freeze-by-rename, tamper detection via `verifyRevisionDirectory`, draft/active isolation, legacy-layout refusal.
  - `task-runtime/tests/unit/environment-draft.spec.ts` — draft id allocation, staging isolation, serialized concurrent stages, discard finality, freeze without pointer movement.
  - `task-runtime/tests/unit/environment-pointer.spec.ts` — ten-step publish with probe order, CAS refusals, third-party drift refusal (before and mid-window), read-back failure without completion, concurrent publish single-winner, rollback, open-intent exclusion, and crash injection at all six stages with reconcile settling each to exactly one switch.
