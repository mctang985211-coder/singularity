---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-27-a5-diagnosis-open-target

## Summary

Opens the target type of a recorded diagnosis suggestion, on the `task/event` root: `DiagnosisProposal.targetType` changes from the nine-member union `ProposalTargetType` to a non-empty `string`, the reducer's `PROPOSAL_TARGET_TYPES` whitelist and `task_diagnose`'s `enum` are deleted, and the field's non-emptiness is the only shape rule left. Everything else about the `DiagnosisRecorded` payload is unchanged: `observedFailure`, `scope`, `localizedCause`, `evidenceRefs`, `reviewRefs`, `confidence`, `proposals`, `relatedTaskIds`, `producedBy` and the optional `judgements` keep their declarations and their checks.

The change is a **widening** of one existing field, not a new field: an old record's value — one of the nine — is still a valid non-empty string, so every stored diagnosis replays unchanged. What moves is the *writer's* freedom: a diagnosis whose conclusion is "this should change" may now name a surface no executor exists for, and that name is refused by the entry that would convert it into something executable (`evolution_propose`'s `fromDiagnosis`, which validates against Evolution's own vocabulary before the first ledger write) rather than at the moment of recording.

`ProposalTargetType` keeps its declaration and its nine members in the same file, as **Evolution's** mutation-surface vocabulary (`evolution/src/evolution.ts` iterates it, `evolution-list`/`evolution-propose` filter by it, and `APPLYABLE_TARGET_TYPES` narrows it further to what this build can execute). It is no longer the diagnosis's vocabulary: no task-side reader or writer consults it any more.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [What the store now accepts](#what-the-store-now-accepts)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-27-a5-diagnosis-open-target
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; no event kind is added, renamed or removed, and no payload type text moves |

The changed member (`task/src/types.ts`, declared with JSDoc as every member must be):

- `DiagnosisProposal.targetType: string` — the open, non-empty name of the surface a suggestion points at. Before this change it was `ProposalTargetType`, a union of nine string literals. The *property* is neither added nor made required or optional: it was required and non-empty before and is required and non-empty now, which is why old records need no tolerance and new ones need no default.

The checks that moved:

- `TaskState.recordDiagnosis` (`task/src/service/state.ts`) dropped `PROPOSAL_TARGET_TYPES` and its `includes` refusal; it now refuses `targetType` that is not a non-empty string (`!nonEmpty(proposal.targetType)` → `proposal target type must be a non-empty string`) and keeps every other proposal rule (non-empty `targetId` and `rationale`).
- `task_diagnose` (`agent-singularity/src/tools/task-diagnose.ts`) dropped its `TARGET_TYPES`/`TARGET_TYPE_SET`/`isProposalTargetType` trio and the `enum` on the model-facing schema; `toProposals` refuses a `targetType` that is not a non-empty string, at the arguments boundary as before.
- What did **not** move: `ProposalTargetType`'s declaration (still exported, still nine members, now documented as Evolution's vocabulary), and the checks that are about *executability* — `evolution/src/evolution.ts`'s `APPLYABLE_TARGET_TYPES`, `validateMutation`, `candidate`, `prepare`, `checkPromotion` and `apply` all keep refusing a target type they cannot run, and the conversion entry `evolution_propose`'s `fromDiagnosis` now refuses a transcribed name it does not record, by name, before `ctx.evolution.propose` is reached (zero ledger writes).

No other stored shape moves. The task store's other readers and writers of a diagnosis — `context_read`'s `diagnosis` projection, `task_review_pack`'s diagnosis block, `task_status`'s count — read `targetType` as a string already.

<a id="what-the-store-now-accepts"></a>
## What the store now accepts

Three sentences, because the point of the change is easy to overstate:

- **Recording.** A diagnosis proposal with `targetType: "prompt_template"` (or any other non-empty name) is stored, replayed and read back like any other. Nothing validates the name at the store — a diagnosis explains, and a suggestion is data.
- **Transcribing.** `evolution_propose({ fromDiagnosis: { diagnosisId, proposalIndex } })` refuses a name outside the nine it records, with the diagnosis id and the proposal index in the message, and with zero ledger writes and no sandbox directory. That refusal is the only place the executable side is decided, and it stays with the package that owns the executable vocabulary.
- **Choosing.** A reviewer's own reply may carry proposals, and `review-agent-run` validates them for shape (non-empty `targetType`/`targetId`/`rationale`) only — the same openness as `task_diagnose`.

<a id="compatibility"></a>
## Compatibility

`version-bump` by the fixed table's "change an existing type" row — the minimum the rules allow for a change to a member of the persisted shape, even though the change is a widening and every old record remains readable. The sibling `.schema.json` therefore repeats the unchanged after digest: the fingerprint covers the event name plus the payload type text (`TaskEvent`), and `targetType` lives inside the transitively referenced `Diagnosis`/`DiagnosisProposal` — the same situation as `2026-09-26-k1-multi-batch`, which is likewise `version-bump` with an unmoved digest. The row is taken conservatively on purpose: `same-version` is the decision for additions old writers could ignore, and this is a change to a type the payload itself names, so it is recorded rather than argued down.

Reading direction, both ways:

- **New build ← old records**: fully compatible. Every stored value is one of the nine, and each is a non-empty string; the reducer's remaining check accepts all nine, the projection renders them verbatim, and a store written before this change replays into an equal snapshot. This is the one direction a widening cannot break, and it is the direction the ticket's "旧记录原样可读" requirement names.
- **Old build ← new records**: readable only while every stored `targetType` is one of the nine. A record carrying any other name is refused *by name* at replay by the old reducer (`task: diagnosis "…" proposal target type must be one of skill, tool, …`), whose `apply` is fail-closed — the envelope's `ignorable: true` lets a build skip an unknown event *type*, not an unknown value inside a kind it already knows. That is the rollback limit: reverting this change is safe for a store that holds no diagnosis suggestion outside the nine, and a store that holds one cannot be opened by the older build at all. There is no migration, no dual reader and no tolerance flag; the values are data, and silently dropping or rewriting them would be a second, unrecorded change.

No format version moves: the upstream Session header and the event envelope are untouched (never done here), and `task/event` keeps the digest it had.

<a id="verification"></a>
## Verification

`pnpm build` in `packages/singularity` passed for all workspace packages (the `agent-singularity` build includes its `tsc --noEmit` pass). `pnpm run verify-persistence` passes with the unchanged inventory: 4 event roots, `task/event` digest `196cc188…a861` — the declaration moved no fingerprint, so no regeneration was needed and the sibling `.schema.json` carries the same after digest.

The change was made test-first: the cases below were run red against the pre-change source (the reducer refused the unknown name, `task_diagnose` rejected it at the arguments boundary, the reviewer still padded six `unknown` judgements, the pack printed no handoff mark, and `fromDiagnosis` refused without naming the diagnosis), and every one of them passes now.

New and changed coverage, all conclusions read back from the store's own snapshot (replayed, where the case says so) or from the ledger file, never from a writer's return value:

- `task/tests/unit/task-state.spec.ts` — the reducer's proposal rules: an unknown target type (`prompt_template`) and an old nine-type value (`runtime_policy`) are both accepted and read back verbatim; `''` and a non-string are refused with the store untouched; the `targetId`/`rationale` rules are unchanged. The old "nine frozen target types" case became this one.
- `task/tests/unit/task-service.spec.ts` — the reopen round trip (`recordDiagnosisIn`, then a fresh `TaskService` over the same session log): a diagnosis carrying `prompt_template` and one carrying `task_definition` both replay into an equal snapshot and read back with their own values. The malformed-diagnosis case now also pins the empty-target-type refusal with zero persisted events.
- `agent-singularity/tests/unit/task-tools.spec.ts` — `task_diagnose` records a `prompt_template` proposal and renders it, refuses a whitespace-only target type with nothing persisted, and the model-facing schema carries `targetType` as a plain string (no `enum`).
- `evolution/tests/unit/evolution.spec.ts` — `evolution_propose` from a diagnosis whose proposal names `prompt_template`: named refusal carrying the diagnosis id and the target type, `svc.list()` empty, `proposals.jsonl` absent, no sandbox. The manual-path vocabulary refusal is unchanged, and the transcribing case (`task_definition` → `proposed`) still passes.
- `agent-singularity/tests/unit/task-review-pack-judgements.spec.ts` — the pack's diagnosis block: a diagnosis with proposals is marked `handoff: pending` exactly once, a conclusion without proposals gets no mark, and an interrupted attempt (a real claim/started/settled `interrupted` triplet in the ledger) shows as `[interrupted]` with no `pending` invented for it.
- `agent-singularity/tests/unit/review-agent.spec.ts` — the reviewer's reply contract and the deleted paths: the first request no longer contains the pack-only restriction (`and nothing else`, `from the review pack`) and no longer demands the six judgements (`Include all six dimensions`), it names `context_read` and `postmortem observation`; a reply with no judgements and no proposals records the conclusion as it stands (the diagnosis has no `judgements` key and `proposals: []`); a reply carrying a judgement that cites nothing, or a verdict outside the vocabulary, is refused by name with the attempt settled `interrupted` and **no** diagnosis recorded; a timeout and an unparseable reply both leave `interrupted` with the reason named and record no diagnosis; a grounded proposal with an unknown target type is recorded.
- `context/tests/unit/reads.spec.ts` (with `context/tests/support/stack.ts` extended) — `context_read` `kind: 'diagnosis'` reads the new shape back as the record holds it: an observation written by the caller, a `prompt_template` proposal, and no `judgements` key at all when none was judged.
- `tests/integration/k4-review-after-deadline.spec.ts` — the same no-diagnosis conclusion on a real store: an explicit `task_review_agent` call with a 5 ms watchdog against a reviewer that never answers leaves the store's `diagnoses` array exactly as it was, and the ledger holds one attempt settled `interrupted` with `timed out` on the note.
- `tests/integration/a5-failure-auto-trigger.spec.ts` — the first request the scripted adapter really received carries neither the pack-only restriction nor the six-judgement demand, and names `context_read`; the spec's scripted reviewer was moved to the new reply shape (observation + conclusion + confidence, judgements only where the case asserts one), as was `k4-review-after-deadline`'s. No assertion in either spec changed meaning.

One more end-to-end case in `tests/integration/a5-failure-auto-trigger.spec.ts` closes the same loop from the other side: the automatically accepted reviewer records a suggestion (`prompt_template`) with no judgements, and the pack the root then reads shows `proposal prompt_template reviewer: …` with `handoff: pending` — the suggestion is on the record, and nothing has been opened for it.

Suites run: the unit projects of `packages/singularity/{task,agent-singularity,evolution,task-runtime,context,agent-runtime}` — 61 files / 1931 tests passed; the review-chain integration specs (`a5-failure-auto-trigger`, `k4-review-after-deadline`, `k4-review-ledger-restart`, `context-assembly`, `evolution-tools`, `review-metrics`) — 6 files / 39 tests passed.
