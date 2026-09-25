---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-25-a4-questions

## Summary

Adds the A4 parent/child question surface to the `task/event` root: two new kinds (`QuestionAsked`, `QuestionAnswered`), the types behind them (`QuestionRecord`, `QuestionAnswerRecord`, `TaskQuestionIndex`, `QuestionMessageRef`, the ask/answer inputs and results), the derivation vocabulary (`questionIdOf`, `answerIdOf`), four pure snapshot helpers (`questionOf`, `openQuestionsOf`, `blockingQuestionsOf`, `questionsAwaitingAnswerOf`), a `questions` member on `TaskSnapshot`, and two `TaskService` entries (`askParentQuestionIn`, `answerParentQuestionIn`). The store records the identity of a question and of each answer, the two runs involved, a citation into the sending Session's own `tool/call` event (`{sessionId, seq}`), the delivery `messageId`, the request key, the content digest (never the body text), the `blocking` flag and the answer's `resolves` flag — and nothing else. Blocking is *derived* from those records; no phase event is written for it. The same change retires the A3 question-id mount points from the write shape: `RunPhaseChanged.pendingQuestionIds` / `blockingQuestionIds` and the two `TaskRun` fields stay declared and still replay, but no entry of this build accepts them any more.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Identity, idempotency and the refusal surface](#identity-idempotency-and-the-refusal-surface)
- [Blocking is derived, and the A3 mount points are retired](#blocking-is-derived-and-the-a3-mount-points-are-retired)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-25-a4-questions
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
| `event:task/event` | `TaskEvent` | Unchanged declaration; the union gains `QuestionAsked` and `QuestionAnswered` members |

The two new members (declared in `task/src/types.ts` with JSDoc, as every member must be):

- `QuestionAsked: { question: QuestionRecord }`, where `QuestionRecord` is `QuestionAsk` (`childRunId`, `requestKey`, `questionDigest`, `questionRef`, `messageId`, `blocking`) plus the derived `questionId`, the resolved `parentRunId`, `askedAt`, and the optional `answers` list that is absent at ask time;
- `QuestionAnswered: { answer: QuestionAnswerRecord }`, where `QuestionAnswerRecord` is `QuestionAnswer` (`questionId`, `parentRunId`, `requestKey`, `answerDigest`, `resolves`, `answerRef`, `messageId`) plus the derived `answerId` and `answeredAt`.

`QuestionMessageRef` is `{ sessionId: string; seq: number }` — the sending Session and the seq of its own `tool/call` event; `seq` is a non-negative integer and the Session must be the sending run's own (the reducer refuses a citation into any other Session). The body text itself is never persisted here: the record is a citation, and the Session that sent it holds the message.

`TaskSnapshot` gains the optional-but-always-present `questions?: TaskQuestionIndex` (`{ all, byId }`), following the `proposals?` precedent: optional at the type level because hand-built snapshots (a verifier selftest view, a test double) predate it, and always present — empty members included — on a snapshot produced by this build's reducer. A snapshot with no index is refused by every helper and by the reducer rather than read as "no questions".

Reducer discipline (`task/src/service/state.ts`):

- `QuestionAsked` (`askQuestion`): the record's shape is checked first (non-empty id/requestKey/messageId/askedAt, a lowercase SHA-256 digest, a boolean `blocking`, a well-formed body reference, and no pre-seeded `answers` — an answer is its own event); the id must be exactly `questionIdOf({childRunId, requestKey})`; the asking run must exist and be running; the envelope must name that run and its task; the asking task must have a direct parent task (a root or parentless replay task has nobody to ask — refused by name, never given a synthetic parent); that task's *current* run must be the one the record names and must be running; the cited Session must be the asking run's own; and a second question under one id is refused.
- `QuestionAnswered` (`answerQuestion`): shape, a derived-id check, an existing question, the answering run equal to the question's `parentRunId` (a wrong parent, including the new run of a restarted task, is refused by name), both runs running, the question not already resolved, the citation in the answering run's own Session, the envelope naming the answering run / child task / parent task, and no repeat of an answer id. A late answer after either run settled applies nothing: no terminal run is revived and no new fact is stored.
- `TaskState`'s constructor initialises `questions: { all: [], byId: {} }`, so a store written before A4 replays into a snapshot that carries the (empty) index and the helpers answer `[]` for it.

Service entries (`task/src/index.ts`):

- `askParentQuestionIn(storeId, ask, actor)` derives the question id, answers a repeated key from the store (`created: false`, zero events, no snapshot change) when the content digest *and* the `blocking` declaration agree, refuses a disagreement in either by name, then resolves the addressee (the child task's direct parent, and that task's current run) and commits one `QuestionAsked` event whose envelope names the child run, the child task and the parent task.
- `answerParentQuestionIn(storeId, answer, actor)` looks the question up, answers a repeated key (`created: false`) before any openness check — a retry of an answer that resolved its question must get its own record back, not "already resolved" — refuses a digest or `resolves` disagreement, then commits one `QuestionAnswered` event. The reducer is the gate for the rest.

<a id="identity-idempotency-and-the-refusal-surface"></a>
## Identity, idempotency and the refusal surface

Ids are derived, never minted: `questionId = 'q-' + sha256(canonicalize({childRunId, requestKey}))` and `answerId = 'a-' + sha256(canonicalize({questionId, requestKey}))`, computed by `questionIdOf` / `answerIdOf` and re-derived by the reducer, so a stored id that does not match its own identity is refused. One key addresses one question (and one answer key one answer), which is what makes a retry after a crash address the record that already exists instead of asking the parent twice; an open question accepts several answers under different keys, and `resolves: true` on any of them closes it.

The content digest is the idempotency comparison and the body reference is not: a repeat that offers a different digest is refused by name (`request key "…" is already bound to question "…"`), while the first write's `questionRef`/`messageId` stay the ones on record — the retry returns them rather than re-citing the body. A repeat that flips `blocking` (or, for an answer, `resolves`) with the same digest is refused too: the store never keeps one declaration and reports the other as delivered.

<a id="blocking-is-derived-and-the-a3-mount-points-are-retired"></a>
## Blocking is derived, and the A3 mount points are retired

No `RunPhaseChanged` is written for a question, and no phase is invented: `blockingQuestionsOf(snapshot, runId)` computes what a run waits on from the question records alone. A question is open when no answer has resolved it *and* both runs are still running, so a question whose child or parent settled stops blocking by derivation — the terminal cancellation the plan requires needs no cancellation event, and a late answer is refused rather than applied. `openQuestionsOf` and `questionsAwaitingAnswerOf` apply the same rule from the asking and the answering side.

A3's `pendingQuestionIds` / `blockingQuestionIds` stay **declared and readable** and stop being written:

- `RunPhaseChanged` still carries the two optional fields and the reducer still shape-checks and carries them, so a store written by A3 replays to exactly the snapshot it had (including a non-empty value an older build could have written);
- `TaskService.changeRunPhaseIn` refuses a payload that carries either field *before* anything is queued, so this build cannot write a second index that could disagree with the question records;
- the two `TaskRun` fields keep their declaration for the same reason — a stored run's shape must not lose a field a record can carry.

Deleting the fields instead would be the table's "remove a property" case (`version-bump`) while delivering nothing: old records that carry them would become unrepresentable, and the read path would have to lie about a field the log holds. Keeping them as read-only shape is the `same-version` decision recorded above.

<a id="compatibility"></a>
## Compatibility

`same-version` per the fixed rules: an ordinary added event type and added optional event-body properties are both minimum-decision `same-version` cases. The declaration-level fingerprint does not move (digests cover the event name plus the payload type text `TaskEvent`, and the new kinds live inside the transitively referenced `TaskEventPayloads` union); per this directory's README, such changes are acknowledged by record alone, and the sibling `.schema.json` therefore repeats the unchanged after digest — the same situation as `2026-09-23-a0-root-intake`, `2026-09-22-a3-coordination-phases` and `2026-09-22-run-provider-binding`.

New build reading old records is fully compatible: a store written before A4 holds no question events, its runs simply have no question fields, the `questions` index replays empty, and every derivation answers `[]` for it. A3's phase-change records that carry question ids still apply with those fields carried (nothing new reads them); this build's entries cannot write another one.

An old build opening a store that contains these events refuses it, by name, at replay: `TaskState.apply` is fail-closed and throws `task: unknown event kind "QuestionAsked"` / `"QuestionAnswered"`. The envelope's `ignorable: true` only lets a build skip an unknown event *type*; it does not cover an unknown kind under the already-known `task/event` type. This is the intended fail-closed behaviour, and the record does not claim older readers can ignore the addition.

Rollback limits: reverting this change (or shipping an older build against a store that already holds A4 events) makes the store unopenable — the unknown kinds are a replay refusal, not a skipped record — and, were the records dropped, the blocking derivation for in-flight questions would disappear with them, so a participant could be left waiting for an answer the store no longer records. There is no downgrade path: a rollback has to happen before any store writes A4 events, or accept losing the question facts (and the runs that waited on them) rather than reading them wrongly. Reverting the *write* side alone is safe for stores that hold no A4 events: the new kinds and helpers are additive, and the retired A3 fields keep their declarations, so an old build's records still read.

<a id="verification"></a>
## Verification

`pnpm build` in `packages/singularity` passed for all workspace packages (`task/lib` rebuilt; the dts pass type-checks the sources). `pnpm exec tsc --noEmit` in `task` reports the same four pre-existing errors in `../task-runtime/src/index.ts` it reports at `bf686f4` with these changes stashed (a stale `task/lib` import and an unrelated schema/comparison mismatch) and no error in `task/src` or `task/tests`. `node scripts/verify-persistence.mjs --write` rewrote `docs/persistence-schema.json` byte-identically (4 event roots, `task/event` digest unchanged), and `pnpm run verify-persistence` passes.

New coverage, all reading conclusions back from the store's event log or the public snapshot (`snapshotIn`/`runIn`/`questionOf`), never from a writer's return value:

- `task/tests/unit/questions.spec.ts` (new, 61 tests) — the two fixed identity vectors (the SHA-256 of the canonical identity texts, computed outside the repository) plus the run/key coverage; a legal ask and a legal answer applied by the reducer, including a `blocking: false` question and a `resolves: false` answer that keeps the question open while a later key resolves it; an ask refusal table (bad id, unknown child run, foreign task envelope, envelope run mismatch, missing/mismatched parent task envelope, a parent run that is not the current one, a citation into another Session, malformed digest, missing keys, non-boolean flag, malformed body reference, missing time, pre-seeded answers, duplicate id) where every refusal also asserts the snapshot is untouched; an answer refusal table (bad id, unknown question, wrong parent run, envelope run/task/parent mismatches, foreign citation, malformed digest, non-boolean `resolves`, missing time, duplicate id, late answer to a resolved question) on an untouched snapshot; an ask on a parentless task refused by name; terminal asks on a cancelled child or parent run; late answers after either run settled, with the question record left unanswered; the four helpers over tenant snapshots (open vs blocking vs awaiting-answer, two blocking questions each removed by its own answer, a terminal run voiding open questions with no further event, and an absent index being a refusal rather than "none"); the service entries writing exactly one event per accepted call, returning the original record with `created: false` and zero events for same-key/same-content retries (including a retry after a reopen and a retry of an answer that resolved its question), refusing same-key/different-digest and same-key/different-declaration with zero events and an unchanged snapshot, refusing a wrong parent, a parentless ask, a foreign-session citation, a late ask or answer after a terminal run, and an unknown question; a fake-persistence reopen deriving the same ids, answers and blocking state; and the legacy half — new writes never carrying `pendingQuestionIds`/`blockingQuestionIds` (and `changeRunPhaseIn` refusing a payload that carries them, writing nothing), an old `RunPhaseChanged` record with non-empty question ids replaying unchanged and readable, and a fresh store's empty snapshot carrying the empty question index.
- `task/tests/unit/task-service.spec.ts` — one assertion updated: the empty snapshot a `createStore` returns now carries `questions: { all: [], byId: {} }`. No other suite changed; `proposal.spec.ts`, `coordination.spec.ts`, `task-state.spec.ts`, `contract.spec.ts`, `diagnosis-judgements.spec.ts` are green under the new reducer.

`pnpm vitest run --project unit packages/singularity/task/tests` passed 7 files / 445 tests; the wider `packages/singularity/task` filter (which also selects `task-runtime`, unchanged) passed 27 files / 945 tests; the whole unit project (`pnpm vitest run --project unit`, all packages) passed 83 files / 1724 tests.
