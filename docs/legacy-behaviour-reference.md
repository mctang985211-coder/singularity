# Legacy behavioural reference (Singularity @ `6a0edde`, frozen read-only)

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

Paths are relative to `/home/ROXY/code/bb_work/harness/packages/singularity`. Enforcement class is
**mechanism** (reducer / fold / CAS / lease / schema), **ordering** (code sequence in one runtime),
or **convention** (prompt, docstring, comment). Verdicts: **COPY** / **REUSE-DSH** / **DROP**.
I read source only; I ran nothing.

## 1. E3 — agent node, session, role, group, router

| Thing | Where | Enforced by |
|---|---|---|
| Agent node | `graph/src/types.ts:6-14` `AgentNode{id,name,status,memberOf?,routerFor?}`; `id` **is** a `SessionId` (`:7`) | schema |
| Status | `graph/src/types.ts:3`; validated `graph/src/service/state.ts:51-52` (no-op transition refused `:66`) | reducer |
| Session | DSH owns it; node stores the id. Created `agent-runtime/src/index.ts:243`, resumed `:309`, `:336-352` | **REUSE-DSH** |
| Role | not a node field: session setup `agentPreset`/`permissionPreset`/`coordinationRole:'reviewer'\|'supervisor'` — `agent-runtime/src/types.ts:88-95`, installed `agent-runtime/src/index.ts:605-632` | ordering |
| Group | `graph/src/types.ts:16-21` `GroupNode{id,routerId,transcriptId,memberIds}` | reducer |

Kinds/payloads, all `GraphEvent`, no envelope or version field in this shape (`graph/src/types.ts:40-45`):
`agent/add{agent,root?}`, `agent/status{agentId,status}`, `group/add{group}`,
`member/add{groupId,agentId}`, `edge/add{edge}`; dispatch `GraphState.apply` (`state.ts:24-44`).

**"A visible node has a live session" — ordering, not an invariant.** `agent/add` is committed
*after* `agents.create` resolves (`agent-runtime/src/index.ts:243` → `:277`); a failed spawn marks
the published node `failed` rather than removing it (`:300-303`). The reducer validates only a
non-empty string id (`graph/src/service/state.ts:47-48`) and holds no session handle
(`graph/src/index.ts:80-82`); `live()` (`agent-runtime/src/index.ts:489-491`) checks only that the
*spawning parent* is live. Nothing at graph-read time checks liveness; the one adjacent mechanical
check requires a session to be a published graph agent before its layout is written
(`graph-web/src/web/api/routes.ts:94-97`) — membership, not liveness.

**Router: first half mechanical, second half absent.**
- "Exactly one router per group" = mechanism: a new group must contain exactly its router
  (`state.ts:80-81`), a router leads at most one group (`:79`), an agent belongs to at most one
  group (`:98-99`).
- "Router is the only outward endpoint" = convention only. `edge/add` accepts any pair of existing
  agents and rejects only self-edges/cycles (`state.ts:115-118`) — no router operand. Delivery
  addresses two session ids directly (`agent-runtime/src/messages.ts:59-60`, `:118`). The claim is
  prose only: `docs/exploration-evolution-architecture.md:201`,
  `agent-runtime/src/prompts/root.prompts.ts:3`.
- **Contradiction / dead code:** `group/add` and `member/add` have **no production producer** —
  non-test grep returns only the reducer and the type union (`state.ts:32,35`; `types.ts:43-44`).
  `groups` is absent from the consumer projection (`map/src/types.ts:30-36`); `routerFor` survives
  there but is referenced nowhere but its own declaration (`map/src/types.ts:20`).
  `docs/2026-09-20-vrtc-code-change-plan.md:139` states group is topology "…没有读取 ACL".

**Verdicts:** node + status + one-group-per-agent rules **COPY**; create-then-publish **COPY as
ordering**, not a reducer invariant; session create/resume/liveness **REUSE-DSH**;
`GroupNode`/`group/add`/`member/add`/`routerFor` **DROP** (no producer, no consumer); "router is
the only outward endpoint" **DROP** (declared, unenforced, no routing code exists).

## 2. R3 — responsibility (Agent → Task)

| Record | Where | Says |
|---|---|---|
| Run ownership | `task/src/types.ts:280` `TaskRun.sessionId` (interface `:276`) | this run is executed by this session |
| Delegation handoff | `task/src/types.ts:378-394` `TaskHandoff`; built `task-runtime/src/handoff.ts:22-40` | parent task/run → child task + objective, constraints, parent session |
| Handoff write | `task-runtime/src/orchestration/child.ts:348-371`, id `h-${runId}`, idempotent | one handoff per child run |
| Validation | `task/src/service/records.ts:55-66` (child must be a child; run must exist) | **nothing about the parent stopping** |
| Coordination | `agent-singularity/src/coordination/store.ts:30-31`, `:48` one identity, one live session at a time | assignment written before spawn |

Read domains are derived from these facts, never granted: `context/src/bindings/resolve.ts:125`,
sources named in `context/README.md:29`.

**"After responsibility transfer, the original node cannot continue the same work" — NOT FOUND.**
Searched `task/src`, `task-runtime/src`, `agent-runtime/src`, `docs/`, `CONTEXT.md` for `cannot
continue`, `no longer continue`, `transfer`, `original node`, `责任转移`, `不可继续`. Hits are
unrelated run-continuation refusals (`task-runtime/src/orchestration/observe.ts:254`,
`service/drivers.ts:567` — a session may not continue *another* run) and proposal-ownership
refusals (`service/proposals.ts:407`). No code blocks a parent from doing what it just delegated;
the parent run is left `running` beside its children (`task/src/index.ts:279-286`).

**Verdict:** recording responsibility (run `sessionId` + `TaskHandoff` + coordination assignment)
**COPY**; the transfer invariant **DROP** — and the legacy module says so itself:
`task-runtime/src/handoff.ts:20-21` "builds and persists the DATA of a handoff and nothing else".

## 3. Task decomposition

| Step | Evidence |
|---|---|
| Root tool | `agent-singularity/src/tools/task-decompose.ts:12-20` (batch admitted atomically, then "concurrently up to the configured worker limit, respecting real dependsOn edges") |
| Plan check | `task-runtime/src/admission.ts:393-414` index range, self-dep, duplicate edge, cycle |
| Atomic admission | `task/src/index.ts:199-289` `admitBatchIn`: child `TaskCreated`+`TaskAdmitted` `:249-256`, `TaskDecomposed{childTaskIds,batchId,parentRunId,proposalId}` `:261-273`, parent phase `waiting_children` `:279-286` |
| The DAG facts | `DependencyAdded{edge}` `task/src/index.ts:258-260` → `TaskSnapshot.edges`; reducer `task/src/service/state.ts:158-167` (cycle + duplicate throws) |
| Proposal linkage | same commit `task/src/index.ts:217-240`, `:287` |

**"Advance only when dependencies are satisfied" is a mechanism**, in the batch loop:
```ts
// task-runtime/src/orchestration/child.ts:576-582 (sequential)
const verified = new Set(items.filter(i => tasks.get(i.taskId)?.status === 'verified').map(i => i.index))
const item = pending.find(i => i.dependsOn.every(d => verified.has(d)))
if (item === undefined) { await blockUnstarted(..., { reason: `dependencies [...] did not verify`, ... }) }
```
```ts
// task-runtime/src/orchestration/child.ts:658-663 (concurrent)
const blockers = dependencyTaskIds.filter(id => TERMINAL_TASK_STATUSES.has(tasks.get(id)!.status) && tasks.get(id)!.status !== 'verified')
if (blockers.length > 0) { await blockChild(..., { reason: `dependencies [${blockers.join(', ')}] did not verify`, ... }) }
```
Only `verified` satisfies a dependency; a terminal-but-unverified dependency blocks the dependent.
Integration tests that prove it: `tests/integration/a3-coordination-loop.spec.ts:243` builds
`dependsOn:[0]` and `:450-453` asserts the never-started sibling is `blocked` with the anomaly on
the record; `tests/integration/a6-recovery.spec.ts:333-340` asserts "blocked, never started" **and**
zero runs for the consumer, with an obligation naming the missing reference;
`tests/integration/task-contract.spec.ts:547` and `tests/integration/replay-workspace.spec.ts:570`
exercise `dependsOn` through admission.

**Verdict: COPY** (DAG facts + verified-only gating + block-with-reason).

## 4. Initial immutable Revision + pointer

| Element | Where | Class |
|---|---|---|
| Ids + content addressing | `task-runtime/src/environment/revision.ts:23`,`:26`,`:29-32` (`c-<draftId>`); entry digests `:35-48`, resources `:315-318` | schema / mechanism |
| Manifest + digest | `revision.ts:66-78`; digest `:160-163` over `{formatVersion,libraryId,kind,skills,taskTemplates,capabilities}` | mechanism (self-check) |
| Tamper refusal | `revision.ts:233-240` recomputes and throws "edited outside the draft machinery" | mechanism |
| The one pointer | `task-runtime/src/environment/pointer.ts:34-44` `{revisionId,manifestDigest,generation,…}` | mechanism |
| CAS (first) | `pointer.ts:371-376` `before.revisionId !== expected.revisionId \|\| before.generation !== expected.generation` → `environment-pointer-changed` | **mechanism** |
| CAS (re-check) | `pointer.ts:415-422` a third party that moved the pointer mid-flight is refused, never overwritten | **mechanism** |
| Switch | `pointer.ts:437-456` `generation: before.generation+1`, `writeFileAtomic(pointer.json)`; read-back `:458-465` (canonical equality) | mechanism |
| Crash reconcile | `pointer.ts:509-561`; an intent whose pointer moved is `blocked`, untouched | mechanism |
| Immutability | `store.ts:219-235` freeze = `rename(draft,revision)`; `:222-223` "already exists; a frozen revision is immutable" is implemented as **target-path-exists → throw** + `syncDirectory` | mechanism (path-exists), *not* a filesystem mode |

**File layout vs fact rule.** This entire world is a **directory layout on disk**, not the fact
log: `$DSH_HOME/singularity/environments/<id>` (`store.ts:32`), `protocol.json` (`:38`),
`revisions/`+`drafts/` (`:41-46`), `manifest.json` (`:210`), `pointer.json`, `intent.json`,
`completions.jsonl` (`pointer.ts:400`,`:454`,`:487`). It carries its own serialisation, fsync order
and reconcile loop — a second durable shape owner beside the event store. The behaviour worth
keeping is the two-dimensional CAS (`revisionId` + monotonic `generation`), one authoritative
pointer, and read-back.

**Verdict:** CAS + single pointer + read-back + reconcile **COPY** (as one G3 fact rule — what
`singularity-core`'s single-G3 gate exists for); digest/manifest validation content **COPY**; the
directory tree, `intent.json`, `completions.jsonl`, draft-id shape and `EXDEV`/fsync choreography
**DROP** (shape).

## 5. Bubble

Read in full: `task-runtime/src/service/bubble.ts:1-297`; callers
`agent-singularity/src/coordination/driver.ts:432` (materialize), `:544` (settle); consumer
`task-runtime/src/orchestration/spawn.ts:99-104`, `:113`, `:121`.

| Aspect | Evidence |
|---|---|
| Location | `bubble.ts:85-92` `$DSH_HOME/singularity/environments/<rootSessionId>/bubbles/round-<N>/workspace` |
| What it clones | every component repo with a `.git` (`:44-56`), via `git clone` then `checkout rsi/<graphId>/round-<N-1>` (`:249-255`); round 1 (`:239`) first folds the mother port's dirty tree into `rsi/<graphId>/round-0`, **committing on the mother port's own repo** (`:120-131`) |
| Method volume | one frozen revision (`:156-174`), verified against its manifest (`:188-191`), copied to `.bubble/method-volume` (`:192-197`); legacy flat layout `:134-143` |
| Idempotency | `:20-30`, `:236-237` same `(round,methodRevisionId)` returns the workspace untouched |
| Lifecycle | materialize `:222-270` → workers run with `cwd:workspace` (`spawn.ts:121`) and the overlay skill root (`spawn.ts:99-104`) → settle `:278-297` commits and `push origin HEAD:refs/heads/rsi/<graphId>/round-<N>`; cleanup is **partial**: `rmSync(target)` before re-cloning (`:245`), `rmSync(volume)` before re-copying (`:193`), and no teardown of a settled round's workspace anywhere |

**What it did NOT isolate.** (i) Git objects are hard-linked by the local `git clone`; the comment
claims it "stays self-contained" (`:246-248`) but a `gc`/prune on the mother port mutates shared
inodes. (ii) The mother port is a live external dependency: `origin` is it (`:249`) and settle
**pushes back into it** (`:293`), then round N+1 reads the branch from there (`:240`,`:250`).
(iii) Tool implementations and process environment: every git call is a host `spawnSync` (`:34-41`).
(iv) `$DSH_HOME` hiding is DSH's sandbox, not this module — no env scrubbing and no read-deny here,
and the method volume is only an *additional* skill root prepended to the worker's own
(`spawn.ts:99-104`,`:113`); the masking list is `docs/bubble-mcp-requirements.md:7`
(`isolationHiddenRoots`). (v) Writable mounts: none enforced here; the workspace lease
(`task-runtime/src/service/root-recovery.ts:516-518`) serialises writers — ordering, not confinement.

**Contradiction (flagged).** `bubble.ts:4-8` says a bubble "hides the environment checkout and
`$DSH_HOME` from the round's agents: what a bubble was materialized with is all a round can see".
`bubble.ts` implements no hiding — it adds a root, removes none, and contains no chmod/deny/mount
code. The claim holds only if the deployment also mounts a DSH sandbox profile, which `spawn.ts:113`
does not require.

**"Graph inside bubble" is not real.** No graph store, graph service or `TaskSnapshot` exists under
the bubble directory. `graphId` appears only in branch names (`:121`,`:240`,`:286`) and one manifest
string (`:262`). `round-N` is the RSI round of *one* graph, materialised as directory nesting; the
graph stays in its own store outside.

**Verdict:** clone-per-round + frozen method-volume binding + settle-by-branch-push **COPY**;
`.bubble/method-volume` as skill overlay + `$DSH_HOME` masking + job/workspace confinement
**REUSE-DSH**; `BubbleManifest` as a second persisted shape for idempotency **DROP**.

## 6. Verifier and receipt

Three implementations, one selftest gate (`verifier/src/index.ts:148-152`; gate `:171-193`):

| Verifier | Actually executes | Verdict source |
|---|---|---|
| `command` (`command-verifier.ts:179-233`) | `spawn(command,{shell:true,detached:true})` `:71` or the sandbox seam `:241-254`; output → `<criterionId>.log` `:217-219` | `outcome.exitCode === 0 ? 'pass' : 'fail'` `:232`; timeout/error/no-command → `inconclusive` + `unknownKind` `:213-231` |
| `composite` (`composite-verifier.ts:220-277`) | no process: reads the store (`verifyIn` → `runMemberSlotsIn` `:271`) and judges the `childEvidence` map `:136-147` | `pass` only if every mapped child criterion has a passing verdict `:140-147`; `verify()` without store context is always `inconclusive` `:261-268` |
| `review` (`review-verifier.ts:7-38`) | nothing | always `inconclusive`, `'manual review required'` `:31-38` |

Dispatch is by `criterion.verifierRef`, else by mode (`index.ts:300-304`); missing/unsupporting is a
*verifier-side* unknown (`:305-330`); the composite judge still runs when a plugin owns the mode and
`childEvidence` is present (`:348-352`).

**(a) Binding to a concrete artifact — it does not exist.** The claim's artifact list is hard-coded
empty:
```ts
// verifier/src/index.ts:425-436
private claim(evidenceId: string, result: VerificationResult): EvidenceClaim {
  return { claimId: `${evidenceId}#${result.criterionId}`, criterionId: result.criterionId,
           status: result.status, verifierId: result.verifierId, ...,
           artifactRefs: [] /* <- always empty */
```
The bundle copies `run.artifacts` wholesale (`index.ts:286`), but no verdict names *which* artifact
it judged. The only per-criterion input binding is `protectedInputs` digests checked before judging
(`index.ts:331-345`; `verifier/src/protected-inputs.ts:1-26`), plus the criterion log
(`logRef`, `index.ts:390-397`).

**(b) Implementation version — a name string, not a content digest.** `stampVersion` overwrites
whatever the verifier returned with the registered instance's `version` (`index.ts:374-380`); the
versions are hand-written literals: `command-verifier.ts:181` `'1'`, `review-verifier.ts:9` `'1'`,
`composite-verifier.ts:222` `'1'`. Replacing an implementation while keeping `id`+`version` yields
an indistinguishable verdict.

**(c) Receipt: derived once from real records, then stored; verifiers appear nowhere in it.**
Type `task/src/receipt.ts:136-159` (digest at `:158` = `sha256(canonicalize(receipt without
digest))`, `:172-175`). Derivation `task-runtime/src/receipt.ts:136-242` reads only store records:
terminal status `:138-139`, task criteria `:205`, pinned revision `:209`, review criteria/evidence
`:220-227`, session facts for model/skill/template consumption `:153`,`:172`,`:229`, subtree
`:144`,`:231`, `sealedAt` `:234`. Stored, not re-derived: `recordReceiptIn`
`task-runtime/src/service/receipts.ts:145`; an existing receipt short-circuits as `already-sealed`
`:118-119`; the store refuses a second one `task/src/service/checks/receipt.ts:52-54` and refuses
any receipt whose `digest` is not the digest of its own content `:35-37`. **Why it is a fixed
source:** `grep -n verifier` over `task/src/receipt.ts`, `task-runtime/src/receipt.ts` and
`task-runtime/src/service/receipts.ts` has **no match** — the receipt records no verifier id and no
verifier version, so replacing a verifier cannot change it; its identity rolls up task/review
criteria digests, the revision pin, skill content digests and the seal time, all facts about the run.

**Verdict:** command/composite/review verdict behaviour + selftest gate **COPY**; `artifactRefs: []`
and the `id@version`-string binding **DROP** (the rebuild's
`verifierRef`/`verifierVersion`/`artifactDigest` at `src/task/protocol.ts:51-64` is the replacement
rule); receipt-as-stored-digest-sealed-record **COPY**.

## 7. The three RRSI-relevant state facts

**(a) `incumbentMechanismCounts` — DEAD.** Declared `evolution/src/strategy/selection.ts:111`
(re-declared/re-passed `:166`,`:173`), read only as `input.incumbentMechanismCounts ?? {}` `:118`.
The only production caller of `admit()` is `evolution/src/strategy/observe.ts:177-184`, which omits
the field. `selectRound` (`:160`) has **no production caller** (grep over `evolution/src`,
`graph-web/src`, `agent-singularity/src`, `context/src` → declaration + its own use + tests;
`evolution/tests/unit/strategy-selection.spec.ts:185,188` pass `{text:1}`). Production always
computes novelty against `{}`.

**(b) `CandidateFact.edits` — DEAD in production, and it *is* read.** Declared
`evolution/src/strategy/history.ts:16`; read at `selection.ts:117-118`, `history.ts:110,129`,
`screen.ts:51-54`. Both production producers hard-code empty:
`agent-singularity/src/tools/method-shared.ts:554-563` (`edits: []`, comment `:558-562` "the ledger
keeps no second copy of a hypothesis the report already froze") and
`graph-web/src/web/api/methods.ts:296-302` (`edits: []`). Non-empty only in tests
(`evolution/tests/integration/strategy-loop.spec.ts:55`,`:123`;
`evolution/tests/unit/strategy-history.spec.ts:21-25`). **Consequence:** every production
mechanism-novelty / mechanism-yield / simplification signal folds an empty edit list.

**(c) `HistoryFacts.consumption` — DEAD, and additionally unread.** Declared
`evolution/src/strategy/history.ts:20` (`ConsumptionFact`) and `:30`. Producers pass `[]`:
`method-shared.ts:606`, `graph-web/src/web/api/methods.ts:346`; a test passes one fact
(`evolution/tests/unit/strategy-history.spec.ts:30`). **`foldHistory` (`history.ts:64`) never
references `facts.consumption`** — `grep -n consumption evolution/src/strategy/history.ts` matches
only the declaration at `:30`. No real producer and no reader at all.

**Confirmed: all three diagnoses hold; no refutation found.** Two aggravating details: (b) is not
merely unpopulated but actively *read*, so the RRSI decision layer silently loses its mechanism
signal; (c) is unread in addition to unpopulated, so it can be deleted with no replacement.

## Uncertainty

- Source reading only at `6a0edde`; I ran no test or build.
- Whether a deployment actually mounts a DSH sandbox profile that hides `$DSH_HOME` is a
  deployment fact not readable from this package (see §5).
- `bubble.ts:44-56` inspects only two directory levels for component repos; deeper nesting is
  unhandled and unverified against a real multi-level checkout.
- DSH's own session header/preset implementation lives outside this package; I read only its callers.
