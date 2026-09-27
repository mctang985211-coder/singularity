---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-28-a6-recovery-binding-facts

## Summary

Extends the recovery-attempt surface added by [2026-09-28-a6-recovery-attempt](2026-09-28-a6-recovery-attempt.md) after the independent review found that the public two-field chain never bound a passed sibling: the attempt's request named no `reuses`, and the entry read `request.reuses ?? []`, so the binding had to be *derived* from the store's own facts. Three stored additions and one semantic widening:

- `RunRecovery.requestDigest?` — the identity of the **request** the attempt answers (the source run it names and the citations its caller declared). Without it, a retry of the two-field request was compared against the *binding* the attempt derived, so a same-key retry was refused by name (both digests are over different inputs by construction).
- `RunRecovery.unboundMembers?` — the positions of the failed run that read a passed sibling the attempt could **not** bind, each with every reason it could not. This is what the plan's "无效引用拒绝并列出受影响项" needs on a path where the reference is derived rather than declared: the position is left for the attempt's own members (done again) and the finding is a durable record, never a silent omission.
- `RunMemberReuseRefusal` — the type of one such entry.
- `RunMemberReuse.childIndex` — widened from "must be the entry's own index in the list" (the leading positions) to "the absolute position in the run's member sequence this entry claims". Every record the previous rule accepted still satisfies the widened one, so nothing written before this change becomes unreadable; what changed is that a passed sibling standing **after** a failed member can be bound at the position the original acceptance map names for it, instead of being forced to re-run.

The changed derivation (same declaration, changed meaning — stated because a reader of the field needs it): `runMemberTaskIds(run)` is now "the filled slots, in slot order", and `runMemberSlots(run)` is the primitive: the claimed positions plus the batch members filling the positions nothing claims, ascending, with an unfilled position answering `undefined`. `TaskService.runMemberSlotsIn` is the positional read (the composite judge's source, `CompositeTaskSource.runMemberSlotsIn`); `runMembersIn` is the same sequence without the holes.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Why the widening is safe](#why-the-widening-is-safe)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-28-a6-recovery-binding-facts
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; no kind is added, renamed or removed, and no payload type text changes |

The added members (declared in `task/src/types.ts` with JSDoc, as every member must be), all optional and all inside types the payload text refers to:

- `RunRecovery.requestDigest?: string` — the canonical digest of `{sourceRunId, declared citations}`, written with the run. A retry under the same request key is compared against it; a record that predates the field is compared by the binding it carries (what its caller's request stated, under the previous rule where a request always declared its citations).
- `RunRecovery.unboundMembers?: RunMemberReuseRefusal[]` — one entry per position the derivation could not bind: `{childIndex, taskId?, criterionId?, reasons}`. Empty or absent when nothing was left unbound.
- `RunMemberReuseRefusal` — the type above.
- `RunMemberReuse.childIndex` — now "the absolute position claimed", unique within one record, and the reducer checks it against the failed run's own member sequence (`runMemberSlots(sourceRun)[childIndex]`).

Derivations and reads (one implementation each):

- `runMemberSlots(run)` — the positional sequence: claimed positions plus batch members filling the free positions ascending; an unfilled position is `undefined`.
- `runMemberTaskIds(run)` — the filled slots, in slot order.
- `TaskService.runMemberSlotsIn(storeId, runId)` — the positional read over the store; `runMembersIn` keeps its element type and answers the same sequence without the holes.
- `VerifierRegistry`'s composite judge reads `runMemberSlotsIn` (`CompositeTaskSource`), so an unfilled position fails a judgement by name (`#N (unfilled)`) instead of shifting the members behind it.

The declaration-level fingerprint does not move: digests cover event name + payload type text (`TaskEvent`), and every change lives inside types the payload text refers to. Per this directory's README, such changes are acknowledged by record alone; the sibling `.schema.json` therefore repeats the unchanged after digest.

<a id="why-the-widening-is-safe"></a>
## Why the widening is safe

A record written under the previous rule carries `childIndex === its own index in reusedMembers`, which is a strict subset of the positions the widened rule accepts. The reducer's new checks are therefore all *consequences* of facts such a record already satisfied (the cited sibling is the failed run's member at that position — trivially true when the positions were the leading ones), and no stored attempt changes meaning.

Why the previous restriction existed, and why it was wrong: it kept the member sequence free of holes (claimed positions first, batch members after). But the batch driver really does start a member **after** a failed one — a failed member is terminal and leaves the round's pending list (`orchestrate.ts`: `TERMINAL_TASK_STATUSES` contains `failed`, `pending` filters those out, `ready` is the ascending list of pending members whose dependencies verified, and `blockUnstarted` only runs when nothing is ready) — so a failed member at position 0 with a passed sibling at position 1 is a shape a real run reaches, and the leading rule would have forced that sibling to be re-run. The slot model keeps the positions stable in that shape (the claimed position stays the sibling's; the attempt's own members fill the free ones, ascending) at the cost of a position that is *claimed and not yet filled* reading as a hole — which every reader now states instead of silently shifting.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: every added property is optional, no event kind changes, and the one widened field's new domain contains the old one. A store written by this build replays on it exactly as written; a store written before it carries no `requestDigest`/`unboundMembers` and only leading claimed positions, both of which this build reads through the stated fallback (one line, at the retry comparison) and the widened rule. Nothing is deleted, renamed or made required.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence` passes with the unchanged inventory (4 event roots, digests unchanged — no `--write` needed).

- The derivation and the slot model, at the entry's own level: `task-runtime/tests/unit/recovery.spec.ts` — "binds a passed sibling that stands after the failed member, at the position the map names" (positions, the sibling's run count, the attempt's slots), "reports a passed sibling it cannot bind, with the reasons, and leaves the position open" (the reasons in the answer *and* on the attempt's record), "binds the sibling the map asks for and reports only the position it cannot, in one attempt" (one attempt, one bound position, one reported), plus the two explicit-declaration cases that pin the strict path and the widened position rule.
- The judge's positional read: `verifier/tests/unit/composite-verifier.spec.ts` — "an unfilled position fails by name instead of shifting the members behind it (A6)".
- The public chain: `tests/integration/a6-evolution-chain.spec.ts` — "binds the passed sibling at its own position from the store's facts, through the two-field tool alone" (the real `task_recover` tool, no `reuses` in the request: the attempt binds position 1, the sibling keeps its one run, the original map's verdict names both positions, and the same key answers with the same attempt), and `tests/integration/a6-recovery.spec.ts` — "derives the binding from the failed run, reports the position it cannot bind, and redoes it".
