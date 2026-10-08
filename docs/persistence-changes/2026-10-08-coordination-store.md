---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-08-coordination-store

## Summary

Replaces the coordination ledger's three-row protocol (`claim`/`started`/`settled` in `$DSH_HOME/review-agents/agents.jsonl`) with a file-based store holding exactly two row kinds — `assignment` (written and fsynced before an agent is spawned) and `completion` (written once a session's work item ends) — in `$DSH_HOME/coordination/assignments.jsonl` (`formatVersion: 1`), the RRSI refactor's batch 4a. Nothing here is a Session event: the store declares no `SessionEventMap` member, so the event fingerprint inventory does not move. The retired ledger file is never read and never written again, and the two retired environment names (`SINGULARITY_REVIEW_LEDGER_DIR`, `SINGULARITY_REVIEW_AGENT_BUDGET`) are not silently honoured — the driver logs the directory it really uses at startup and names a retired variable it still sees.

## Table of Contents

- [Declaration](#declaration)
- [Registered shapes](#registered-shapes)
- [Compatibility](#compatibility)
- [Verification](#verification)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-08-coordination-store
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
| `event:task/event` | `TaskEvent` | Unchanged declaration text; this batch adds no `SessionEventMap` member anywhere in the workspace (the fingerprint inventory is untouched, and `--write` rewrites the same four roots) |

The store's own file (`agent-singularity/src/coordination/store.ts`), one JSON object per line:

- `assignment` — `{ formatVersion: 1; kind: 'assignment'; graphId; storeId; epoch; role: 'supervisor' | 'reviewer'; subject; sessionId; actor; digest; model?; at }`. The `subject` is a round (`{ kind: 'round'; businessRound; searchRound; source: { taskId; runId } }`) or a review (`{ kind: 'review'; businessRound: number | null; source: { taskId; runId: string | null }; requestKey: string | null }`). Appended with `flush: true` (and one directory fsync when the file is created), so the row is on the device before the spawn begins.
- `completion` — `{ formatVersion: 1; kind: 'completion'; graphId; storeId; epoch; role; sessionId; result; at }` where `result` is `{ kind: 'completed'; businessAction: 'continue' | 'recover' | 'finish'; reason; evidenceRefs; trialCandidateRef: string | null; methodDecision; searchNext; approval? }`, `{ kind: 'reviewed'; diagnosisId; confidence }`, `{ kind: 'protocol-failure'; detail }` or `{ kind: 'interrupted'; detail }`.

A row whose `formatVersion` is not `1` or whose `kind` is neither of the two is refused by name (`coordination-store: unrecognized row <n> in <file>`), and a corrupt line is refused rather than skipped. The retired `review-agents/agents.jsonl` (rows of `formatVersion: 2`, kinds `claim`/`started`/`settled`) is not read at all: a legacy row cannot be misread as a current one because the reader refuses it by version and kind.

## Compatibility

`same-version` — nothing in the event contract moves. The declaration-level fingerprint covers event name plus payload type text, and no `SessionEventMap` member is added, changed or removed by this batch (`node scripts/verify-persistence.mjs --write` is a no-op that rewrites the same four roots). The coordination file lives outside every event store: it is created on first write and never replayed by a session-log reader, so an old store and an old log replay unchanged.

Old data is not migrated and not read. `$DSH_HOME/review-agents/agents.jsonl` and any deployment setting `SINGULARITY_REVIEW_LEDGER_DIR` / `SINGULARITY_REVIEW_AGENT_BUDGET` keep their files and their variables, but no current code path reads either: a legacy graph is sealed history (its records are read through the legacy readers) and a current graph schedules through the new store. An operator moving a deployment sees the effective directory in the startup log instead of a silent fallback, which is the intended behaviour change (risk R20).

## Verification

- `node scripts/verify-persistence.mjs --write && node scripts/verify-persistence.mjs --check` — OK, 4 event roots match `docs/persistence-schema.json`; the `event:task/event` digest is unchanged (`196cc188ad25ba96df9a04597d81352c73fd2c9aae593c63b64e54d0de22a861`) and `--write` produced no diff.
- New unit tests (from the harness root, `./node_modules/.bin/vitest run --project unit <paths>`):
  - `coordination-store.spec.ts` — 11 cases: an unwritten file is a state; a row is readable from a fresh read the moment the append returns; an assignment is durable by session; an unrecognized version/kind and a corrupt line are refused by name; a completion is visible to listeners and to the work-item projection; a binding read resolves the caller and projects the context seam; two disagreeing rows for one session are a conflict; the serial region never interleaves two pieces of work for one graph and does not block another graph; a rejected region does not poison the queue; the allowance precedence.
  - `assignment-plan.spec.ts` — 13 cases: assign/reuse/in-flight/resume/refused; budget exhaustion with its numbers; subject conflict; bounded retry of an interrupted attempt and `attempts-exhausted`; re-materializing the same session id; a stored session with an open turn resuming; a settled session never handed a second assignment; store mismatch; key stability and epoch/role/round separation.
  - `reducer.spec.ts` — 18 cases: nothing to decide; claim; protocol failure once a turn ended without the tool; a spent allowance suspending instead of retrying; continue/recover/finish and their disagreements; the round count stopping the loop without rewriting the outcome; a next round already open; an explicit trial candidate riding through; no live root; the epoch producing a fresh work item.
  - `session-facts.spec.ts` — 12 cases: presence from the registry, the persistence stat, a list-only backend, or an unaskable one; a closed versus an open turn; an unreadable log leaving the turn facts absent; the completion call; the allowance and settle readings; a set read and the flush barrier.
  - `facts-reader.spec.ts` — 8 cases: the round wire; a settled completion mapped to exactly the declared fields; interrupted and protocol-failed rows; a review work item not counting as a round; another store's rows; ordering; per-round diagnosis identity.
  - `completion-tools.spec.ts` — 13 cases: the supervisor payload's checks (empty reason, no evidence, unrecorded refs, an action outside the vocabulary, an empty trial ref); the reviewer payload's checks (judgements, proposals, unresolvable refs, role mismatch); the derived method decision and search step.
  - `supervision.spec.ts` — 7 cases: the shipped allowance, its precedence, the retired env name being unread, the graph round cap, and the coordination directory.
- New `agent-runtime` unit tests: `coordination-seal.spec.ts` (4 cases), `coordination-resume.spec.ts` (6 cases).
- New integration tests (`--project integration`): `coordination-driver.spec.ts` (4 cases) — assignment durable before model input, supervision of a verified round, the completion opening the next round through `recoverRootTask`, a protocol failure with exactly one supervisor spawn, a restart reusing the same work item, and a sealed legacy graph never scheduled; `coordination-completion.spec.ts` — the completion tools' authority and the write seal over the real runtime.
