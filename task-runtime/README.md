# dsh-singularity-task-runtime

Purpose: Orchestrate Singularity task trees: root contract intake, decomposition admission,
capability resolution, worker/verifier execution, recovery, and handoff.

Package: `@dangosys/dsh-singularity-task-runtime`

Dependencies: task, agentRuntime, graphs, sessionQuery

config.yaml: `capabilities`, `defaultPreset`, `verifyTimeoutMs` (default 10 min), `maxDepth` (default 4),
`maxChildren` (default 8), `budget`, `allowRuntimeDecomposition` (default true), `generatedTaskReview`
(`off` | `all`, default `off`), `supervision` (the per-source round caps, default 3 recoveries / 2 improvements —
also read from the `singularitySupervision` service), `runBindingRoot`, `rootBudget`, `writeDrainTimeoutMs` (default 30 s)

### Tools

none (task tools live in `@dangosys/dsh-singularity-agent`)

### Web APIs

none

### Service state

1. ctx.taskRuntime: intakeRootContract / adoptRoot / submitRootContractProposal / decomposeAndRun /
   submitDecompositionProposal / continueProposal / decideProposal / cancelProposal /
   proposalIn / proposalsForParent / extendRootBudget / registerRootBudgetApproval /
   recoverRootTask / recoveryStatus / replayTask / submitResult / cancelBatch / cancelGraph /
   awaitBatch / reconcileStore / askParentQuestion / answerParentQuestion / runForSession /
   workspacePathFor / providerLoadReport / listCapabilities / applyCapabilityRow /
   capabilityProviderReport / readRunBinding / allowsRuntimeDecomposition /
   registerTerminalReviewListener
2. event subscriptions: `tools/pre-execute`, `tools/result` (the write gate), `task/change` (the run watcher)

## Design notes

Rationale displaced from `src` by the two-line comment rule, kept verbatim and grouped by source file.


### src/admission.ts

heuristic label, would be a declaration nobody acts on.

silently falling back to the conjunction is the degradation the marker
exists to prevent.

judge is something other than the composite conjunction.
Why it is a rule of its own and not folded into {@link contractDefects}: a
decomposition child may legitimately be judged by "my children verified" —
its parent owns the goal it was delegated — while a *root* has nobody above
it, so a root whose only mandatory criterion is the composite conjunction is
satisfied by its own decomposition and by nothing else. That is the shape the
graph entry used to mint from its fixed spec, and it is exactly the shape
this rule refuses to call a root goal. Applying it to every contract would
break the delegated-children case; applying it to nothing would let a root
re-enter through the old shape.
Structural, and only structural: it says which *kind* of judge the contract
names, never whether that judge is any good. A `command` that is a constant
truth, a model's self-report, or a `heuristic` criterion are all outside what
a shape rule can decide — §1.2 says so in as many words ("不能用恒真命令、
模型自述或 heuristic 冒充确定性根通过"), and P4 already labels a heuristic
verdict as never a deterministic pass. What this rule does buy is that the
root's acceptance cannot be *only* the conjunction of what it delegated.
`label` names the contract under validation (`root contract`, `root
contract of session "s-…"`); the reason is prefixed with it, like every other
contract rule's.

absent one: nothing executable was handed to the judge.

entry wrote it — an ordinary decomposition child, a replay candidate, or
(later) a template instance. Texts, ids, modes, and the fixed form of a
criterion's protected acceptance inputs only; nothing here judges whether a
criterion is any good, and nothing here needs the store.
The ordinary decomposition path and the replay path share this function so
that a rule can never hold on one and not on the other. The *parent* task's
own criteria are deliberately not put through it: a parent that already
exists was admitted when it was created, and T1 does not re-open contracts
that predate the normalized one — `checkDecomposition` still applies
{@link independentAcceptanceDefects} to the parent, which is its own P4
promise about a declaration the parent itself carries.
`label` names the task under validation (`child 0 ("t-1")`, `replay of
"t-1"`); every reason is prefixed with it.

every later verdict ambiguous. One reason per duplicated id, however many
times it repeats.

candidate, because `protectedInputDefects` is the only place that shape
is described. The declared (string) form is refused here too — reaching
admission with paths instead of digests means the runtime's fixing step
was bypassed, and no unfixed identity may be persisted.

before its ids are minted (`TaskRuntime.deriveBatch` / `checkDerivedBatch`
deliberately mint nothing), so a refusal names the child's position — and the
same verdict comes out either way, because only the id in the message differs.

forms appear in `dependency "…" → "…"` messages only — the edges this
function builds are the plan's own, checked for duplicates and cycles before
any id exists.

verdict is `ok`, so admission is atomic for the whole batch.

every decomposition — a parent that demands independent acceptance can
never silently decompose under the bare conjunction.

declarations a child carries about its parent's acceptance.

snapshot), so admission only refuses a malformed declaration.

registry), so admission only refuses a malformed declaration.


### src/capability.ts

approval breaks ties (`ask` > `never`), declaration order breaks what remains.

caller then keeps the default posture). `resolveSpec` (the permissionPresets
registry's `resolve`) doubles as existence validation — an unknown preset
name fails loudly here, before the spawn.


### src/gate.ts

assumes a stop: `confirmed: false` with named `pending` entries is the
honest answer for a call that did not settle or a job that is still not
terminal, and the caller must refuse verification on it (§3.3).
Order matters: the in-flight calls first (they are the writes this process
can see finish), then the jobs this session started (kill, then wait for a
terminal status within whatever window is left). The jobs step is skipped
entirely when the deployment gave no service or no agent — there is nothing
to reconcile, which is not the same as "nothing running".

are reconciled only when both the service and the agent authorizing the kills
are there. The rule lives in one place so the three call sites cannot drift.

a jobs call that threw, a job that could not be waited for, a job whose status
is still not terminal. None of them is read as "stopped".


### src/normalize.ts

refused, not trimmed, and an omitted collection is the caller's `[]`.

needs the whole batch, which this entry never sees as a graph.

reaches the store, and the cast is the boundary that says so.

a parent-level `childEvidence.criterionId` can only point at an id that was
fixed before its parent's criteria were accepted.
A criterion that carried a defect is left out of the returned list: the batch
is refused as a whole, and the contract must describe only what a well-formed
declaration asked for.

is defaulted — the one decision here: a command means the verifier can
execute it, no command means a reviewer reads it. Absent means exactly
`undefined`: a declared `null` is a declaration, and defaulting it
would hand the criterion a judge the caller never named.

*before* this entry ran, so what is hashed here is the byte identity,
never the caller's paths.

records what the caller asked for, not a tidied version of it.

needs the whole list, and a batch that returns at all is one the digest could
describe. A refusal is a value, never a throw.

this build knows — reading a future contract with today's reader is the one
failure a version field exists to prevent.

with a digest of a different value, so the batch is refused, not hashed.

Why not the batch scheme (`ac<child>-<j>`): a root contract has no batch
position to be numbered by, so the child half of that name would have to be
invented — and an invented `ac1-2` on a root would read as "the second
criterion of the first child", which is a decomposition this contract is not.
The form is fixed here rather than left to the caller because an absent id
must be deterministic: the digest covers it, and two writers of the same root
contract must not produce two identities.

its canonical {@link TaskContract} out, or every reason it was refused.
It shares the contract-level rules with {@link normalizeDecomposition} rather
than restating them: the same closed field set per criterion (an undeclared
key is refused by name, never dropped), the same verbatim text rule (blankness
is refused, bytes are not rewritten), the same defaults (an omitted list is
`[]`, an omitted `mandatory` is `true`, an absent mode follows the command),
and the same criterion-id fixing — with the root's own id scheme
({@link rootCriterionId}).
What it does *not* do: structural admission. `contractDefects`, the root's
own independent-criterion rule (`admission.ts:rootIndependenceDefects`), the
protected-input shape rule and every capability/provider/verifier question are
asked by the intake entry over the value this returns, exactly as the
decomposition path asks them over a normalized batch. And it writes nothing:
the caller has the whole contract or a list of reasons, and a refused root
contract leaves no id, no event and no file read behind it.
The `contractVersion` gate is the batch's: absent is this build's version (the
caller that does not version its input means the current language), and a
declared version whose field semantics this build does not know is refused
rather than read with today's reader.


### src/obligation.ts

env root cannot walk to the filesystem root and pick up an unrelated repo).
`undefined` when no repo root is found within the cap.

yields an empty list. A malformed file throws — see parseObligationTemplates.

<name>`) or a recorded obligation mentions its id or question (`via
obligation <id>`). Everything else is uncovered — reported, never blocked.


### src/orchestration/batch.ts

for. What an unresolved blocking question does is refuse the parent's
*writes* — recomputed into the gate below from the store's own facts — and a
batch ending can never answer on the parent's behalf. The batch's children
are over either way, so the parent is told so and left to its own
coordination; the items stay on the record as their audit.

child that was blocked, cancelled or adopted terminal may still hold writers
or managed jobs, and "the batch is over, you may write again" is a promise
about the checkout that only a confirmed drain can make. The union of what
could not be confirmed is named on the parent's terminal record instead.

the checkout. The two unconfirmed paths above returned before this point, and
that is the whole order: a parent failed for a convergence nobody could
confirm keeps the batch's layer exactly where it was, while a parent that is
handed its checkout back has one already.

fact the gate is told next. The write gate and the question block are separate
questions: `active` is the phase the batch gave back, and whether an
unresolved blocking question still refuses this run's writes is recomputed
from the store here rather than assumed from what this process remembers.

the same message and writes nothing when it is already there, which is what
the recovery pass relies on; the plain notice is the fallback for a
deployment with no relay, and the record of the batch end either way.

fallback notice would be a wake addressed to a terminal run — the very thing
K1 §2 forbids. Its own terminal transition already told its owner.

The first step is the parent's own drain — admission closed at the atomic
commit, so whatever the parent still had in flight has to stop before the
first child starts writing (§3.3); an unconfirmable drain blocks the children
that never started and fails the parent by name instead of assuming a stop.
Then every round re-reads the store: children already terminal are adopted,
exactly one ready child is started (the batch is serial by dependency order,
not parallel — §5's declared boundary), and the round waits for that child's
terminal state. A nested decomposition is not a recursive call: the child's
own `task_decompose` registers its own driver, and this loop only waits for
the child's run to settle.
A driver failure is a parent failed with the cause named, recorded and notified
(§3.1's "no fire-and-forget") — but never a batch reported as ended on facts the
store did not give: when the batch's members cannot be read (the parent run is
unreadable, or its record does not hold this batch), this promise rejects by
name instead of resolving with an outcome list derived from another batch's
members or from the task's whole child history. The runtime's own belt settles
the batch such a rejection names (`registerDriver` → `failBatchFromRuntime`).

children, every batch's — is exactly what would report a second batch as its
first batch's children.

Everything that verifies a run goes through here — the worker's own
`task_submit_result` (a parent's included: a batch ending hands the run back
`active` and only the parent's own submission starts its acceptance), and the
recovery path's continuation of a run that submitted before a restart. That is
what makes the paths share the budget, the drain, the verifier deadline and
the review discipline instead of separate implementations that drift (§3.1
"验证权唯一").
A drain that cannot be confirmed fails the run with the pending work named:
judging a run whose writers may still be running would produce a verdict
about bytes nothing can vouch for (§3.3).

already `verifying`, and the store refuses `verifying → verifying`; skipping
the redundant write is what lets the recovery continue a run whose phase
event already says it owes a verdict. The later `TaskVerified` needs exactly
this state, so nothing else may move it.

in-flight child `cancelled`, while a run whose submission is the thing that
failed must be failed — the driver then adopts the terminal run as it stands.

would refuse the move out of a terminal state) and no second review record.

cancellation that lands during a verifier call owns the settlement, and the store
refuses both a move out of a terminal state and evidence for a settled run.

that run's accumulated batches — never an id parsed back into a task, which is
exactly what could not survive a parent that admits more than one batch (K1).
The run is a batch member of at most one batch, so the answer is unique.
The parent-run guard is what keeps a replay's lineage (`parentRunId` naming
the champion) from being read as a batch membership: the run named must be the
parent *task*'s own run. A run whose parent has no batch entry answers
`undefined` — a membership this build cannot name is not guessed at.


### src/orchestration/child.ts

(`failBatch`, and the fallback for a driver that rejected before it settled
anything).
It is {@link blockUnstarted} over the members the caller read from the batch's
own record rather than over a `BatchContext` the caller no longer holds, so the
*rule* — a child with no run and no terminal state is blocked, one that already
ran is left to its own settlement — stays in one place and the runtime's failure
seams share it with the driver. The batch's members are passed in, never
re-derived from the parent task: a parent task's children are every batch it
ever admitted, and this call ends one batch.

but not yet charged) plus the run's own record, its content binding, the
workspace handover and the spawn.
The run is recorded *before* the spawn attempt — the discipline the cascade
always had — so a refusal at any of those steps settles a run that exists
rather than leaving a child admitted with no way to reach a terminal state.
The binding is written before the run is recorded (S1-C), and a batch resumed
in a new process rebuilds its provider verdicts here (there is nothing to
carry over, and the pre-check is the one honest replacement).

run count only grows — so it ends the batch instead of being retried. A
budget that cannot be resolved only refuses when this deployment configures
limits at all: with none, there is nothing to measure and nothing to refuse.
Both the ceilings and the count are read here rather than carried in from the
round's own snapshot: a refusal here *blocks the child*, so it may not be
made against a reading a person has since raised, and the reservation has to
count what the store holds when the start is decided (K4).

second one — the store refuses a duplicate, and skipping is the idempotent
answer.

refusal settles this child by name rather than binding unjudged bytes.

not refund the slot (§3.5).

not handed over silently — the child fails by name before any worker runs.

created under the same frozen model selection. Absent for every ordinary
batch, whose spawns are unchanged.

drives (and reports, and blocks) its own children only.

driver stops, and before it does it blocks the children that never started:
"the store holds the outcomes" is only true of the children that had a run,
and an admitted child with no run would otherwise stay non-terminal forever.


### src/orchestration/observe.ts

for children, verification, a proposal, or an answer gets none.

A deployment that cannot name the agent has no cancellation to hand over.

block is already gone — and the phase is set only for a Session this call
brought live (an already-live session keeps the phase its own binding
derived). Both are pushed before the wait, so the first request the answer
wakes is decided under the facts the store holds.

question, and for the same reason. A retry in this process or after a restart
states the same identity, so the target's own fold answers "this one is
already here" instead of the runtime keeping a ledger of what it sent.

the parent may do now. It is reprojected from the facts on every call (never
remembered, never edited between attempts), so the live delivery and a
recovery re-delivery carry the same words about the same batch.
What it deliberately does not say is that anything was submitted: the runtime
submits nothing on the parent's behalf (K1 §2), and only the parent's own
`task_submit_result` starts its acceptance.

a batch nobody names are not another batch's and not the task's children, so
the read fails by name instead of answering for a batch it cannot identify.

clears `batchId` — so every entry of its accumulated `batches` names a batch
that ended, and each ended batch owes its Session the one message under
`m-batchend-<batchId>` ({@link batchEndMessageId}), whether the process that
ended it delivered it or died before it could. The store's own accumulation is
the whole derivation: nothing is guessed from a task's children, a batch no run
records is not a candidate, and a run that is still `waiting_children`,
`submitted` or terminal owes nothing here (its batch end is not durable yet, its
acceptance is what is in flight, or it is past being told).
Being owed is a candidate, not a verdict: the target's own fold decides whether
the message is still missing when the delivery is attempted, so a second pass
over the same store re-derives the same list and delivers nothing twice.

about the batch: the store's facts are the result, and the message is the wake
that points at them.


### src/orchestration/replay.ts

is what makes the two replay modes one protocol: a spawning replay decides
its own work (`active`), a criteria replay has already handed its result in
(`submitted`, origin `runtime`).

beside it.

of this run reads. `env` stays what the caller handed in — the store, the
actor, the gate, the workspace — and this adds only what this one run binds, so
the rest of the replay is unchanged.

recorded are the ones the replay was admitted under, under the overlay's own
table. Materialized and read back before the record is written, exactly as in
a batch child — a criteria replay (no worker) binds the same way, so the run's
record cannot mean two different things depending on `spawn`.

replayed worker loads is bound content in both cases.

it for the sub-execution this worker's own decomposition may spawn.

as.
Two settlement paths can reach one run at once, and this is not hypothetical for
a replay: a replayed worker that decomposed is settled by its own batch (the
ordinary parent acceptance submits and verifies the parent run) while this path
is deciding. The arbitration is the one the batch's per-child settlement already
applies ({@link settleChildRun}, `settleRunFromRuntime` beside it): the store is
the arbiter — a run it now holds terminal stands, this settlement adds nothing,
and the outcome reports the state the store holds rather than the one this wait
was about to write. The two writes are otherwise exactly what they were: the
status event with its reason, one terminal review carrying the localized cause
and the lineage anomaly, and the settlement bookkeeping.

and this call has nothing to add to it.

bundle the verifier produced is what the comparison report names.


### src/orchestration/settlement.ts

against the run's session observation, and a breach is recorded as an
anomaly — never presented as enforcement, never flipping a verdict.
Best-effort like the enrichment read: no budget, no reader, or no
observation means no annotation.

the run cascade and the replay runner share. The dimensions and effort
metrics are derived alongside (§2.7.3) on a best-effort basis — see
{@link reviewEnrichment} — and never gate the record itself.
The record is durable before anything is told about it: the deployment's
listener (A5's review-agent trigger) is handed the fact afterwards and is
never awaited, so no settlement waits on a reviewer.

review agent, a watchdog and a diagnosis on its own time, and none of it is
this settlement's business.

-------------------------------------------------------------------------

discipline every other settlement uses: the status event, its one review
record (idempotent: a run whose review already exists is not given a second),
the gate closed for its session, and the workspace layer it held released.
A run that is already terminal is left exactly as it is: this is a settlement
entry, not an overwrite.

— a run it already holds terminal stands, and this call has nothing to add.

it are recomputed here, from the store, before this settlement reports itself
done — a caller that awaited it must not have to wait for another event to
see the wait it ended. The gate is the one capability of the live process
this needs, and a settlement that has none (a store-level one) simply has no
session to release.


### src/orchestration/verify.ts

cannot close a criterion mechanically, whatever verdict a judge returned.

-------------------------------------------------------------------------


### src/orchestration/workspace-io.ts

same child's layer, and whichever runs second finds the next holder of the
same store on top and has nothing to do. A holder from *another* store is a
real disagreement and is reported.

released when the call returns (§3.4's stack: run → batch → child run →
verifier).
A workspace held by *another store*, or by nobody at all while this
deployment claims a path, refuses the verification by name: a verifier's
commands would otherwise run in a checkout another writer holds, and that is
the one thing this rule exists to prevent (§3.4's "the verifier's execution
is exclusive too"). The checkout's own store is a different case and is
accepted: one store is one tree the runtime serializes, and a *recovery* that
rebuilt the stack holds the root's layer while a resumed verification runs.
The refusal throws, so the submission's settlement fails the run with the
reason on its review record — the same shape every other unverifiable run
gets, never a verdict about bytes nothing can vouch for.


### src/proposal.ts

the normalized contract itself.
The parent task and parent run a batch's key names have no counterpart here —
a root contract has no parent, and the task it becomes does not exist until it
is activated — so the two fields that identify the subject are the store and
the root session, and the content is the contract's own digest.

What the derivation buys, in the order it matters: the same contract asked for
again — in this process or after a restart — addresses the same proposal and is
answered from the record instead of being written twice; a revision is
different content, hence a different digest, hence a different key, which is
exactly what §6 wants a revision to be; and no caller has to keep a key of its
own to get that. A caller that *has* a stable identifier may pass it instead,
and the store then holds it to the same rule — one key names one proposal, and
a key already bound to other content is refused by name.

re-checked. `admitted` and the four terminal statuses are excluded: a task
with one of those has either a batch (the run is coordinated by A3 from
there) or nothing waiting.

re-checked (§6). `admitted` and the four terminal statuses are not open: a
task with one of those has either a batch (the run is coordinated by A3 from
there) or nothing waiting.

authorizes) is idle on purpose, and an idle that is a known wait must not
count as stagnation.
Both the task and the run are matched, not just the task: a proposal names
the run it was submitted from, and a *later* run of the same task is not
waiting on a batch its predecessor proposed.
A snapshot with no proposal index (a hand-built one, or a store written
before proposals existed) answers `undefined` — the honest reading of "this
reader cannot see proposals", which is a run to be judged by the rules that
were in force when it was created rather than one this build's proposals
hold up.

({@link capabilityManifestDigest}): two resolutions that assigned the
manifests to different children are two identities.

empty list is the honest answer for a batch whose capabilities grant no
skill at all: nothing was resolved, so nothing is claimed.

- **The manifests**, through {@link capabilityManifestDigest}, folded with
  the provider content identity the admission-time pre-check resolved for
  the same rows. The manifest itself names skills, tools, presets,
  permissions and MCP servers — *names*, not bytes — so the fold adds what
  only discovery can answer: the `contractDigest` of every accepted
  provider (`null` for a skill that declares no sidecar, which is a skill
  whose content this deployment cannot pin). The fold covers the rows *this*
  batch matched and nothing else, which is what keeps §6's "an unrelated
  registry edit does not invalidate a reviewed proposal" true: a changed row
  the batch never resolved is not in this digest.
- **The judging verifiers**, as the ids the batch's criteria pin by
  `verifierRef`. Those are the only instances this runtime can name: the
  registered registry exposes its id vocabulary (`verifierIds()`), not the
  version or the configuration each id currently stands for, so
  `version`/`configurationDigest` are left off rather than invented (§6:
  "没有可信内容版本的资源必须标明身份保障有限"). A criterion with no
  `verifierRef` is dispatched by mode inside the verifier service and this
  runtime cannot see which instance that is; its mode is part of the batch
  content (the proposal digest covers the whole contract), so a *mode*
  change is a different proposal, while a re-registration that keeps an id
  and changes the behaviour behind it is **not** visible here and does not
  invalidate a reviewed proposal.

version binding; the digest over it is order-insensitive
(`task/src/proposal.ts:reviewContextDigest` sorts), the stored list keeps
the writer's order so a reader can see which criterion came first.

verifiers). §6 requires the stale marking to name what changed — an
invalidation a reader cannot explain is a record that cannot be trusted —
and "the context changed" alone would be exactly that. The limits in force
are the other half of the re-check and have their own fingerprint
(`admissionContextDigest`), so a caller that has two of those reports the
difference itself.


### src/protected-inputs.ts

`paths` are the paths **as declared** (the caller's spellings, verbatim):
each is resolved against `cwd` for the read — an absolute path stays
absolute — while the returned ref keeps the declared spelling, so the
identity names what the caller wrote and not a tidied version of it. An
identical declaration repeated is read once and produces one entry, in
first-declaration order; two spellings of the same file stay two
declarations.
Refusals are values, never throws: a path that cannot be read (missing,
unreadable, a directory) yields a reason naming the label and the path, and a
session whose checkout directory cannot be resolved (`cwd === undefined`)
yields one reason instead of fixing the declaration against the wrong base.
That refusal is whole-batch and absolute paths are not exempt: the checkout
names the directory the criterion's judge runs in, so a batch that cannot
name it cannot promise that what it fixed is what the re-check will compare —
and the refs of a batch refused for one path are never trustworthy either.
Nothing is ever written: the files are read and left byte-identical.

caller's input is never mutated — which is also why the returned list is
typed read-only.
`label` is the position prefix a criterion is reported under (`child 0` on a
decomposition, `replay of "t-1"` on a replay); {@link criterionLabel} appends
the criterion's own id or position. A criterion whose fixing was refused is
carried unchanged — it never reaches the store, because the caller refuses
the whole batch on any reason — so no half-fixed identity can be read as a
fixed one.

readable instead of turning it into a crash.

boundary that says so, and `protectedInputDefects` is the check that
refuses anything else.

normalization entry, so the contract the store receives — and both content
identities computed over it — describe the fixed byte identity rather than
the caller's paths.
Absent declarations and every malformed shape are carried exactly as
declared, and a child nothing was fixed in is returned by reference: this
function converts the authoring form, it does not validate, so the reasons it
returns are only the ones fixing itself could produce.

carried verbatim so the caller still gets the readable normalization
refusal instead of a crash from a walk that was never meant to read it.

`path` (non-blank string) and `sha256` (lowercase 64-character hex). Shape
only — whether the file still hashes to that digest is the pre-judgement
re-check's question, and it needs the checkout, not this function.
The ordinary decomposition path and the replay path share this function (via
`admission.contractDefects`) so one rule can never hold on one and not on the
other, and the declared string form is refused here as well: reaching
admission with paths instead of digests means the runtime's fixing step was
bypassed, which is exactly the state that must not be persisted. Every reason
is prefixed with `<label> criterion "<id>"`, the label the other contract
rules use.


### src/provider-precheck.ts

underway and its completion has not been recorded, so production may not be
what the ledger says it is. One intent covers a skill directory's fixed file
set together, so a target naming any one of those files refuses the directory
as a whole — the version standing beside it may be the other half of a mixed
pair, which is not admissible either. The provider stays refused until a
reconciliation settles that commit, and every other provider in the same
pre-check is judged exactly as before.

no file at all and nothing discovery finds can stand for it. The row's grant is
not the deployment's yet — the commit that would make it so has not recorded
its completion, and for a capability commit the row is installed *before* the
table file the next restart loads, so the in-process table can hold a row the
deployment would lose. Nothing of that row is resolved here: a row that may not
be admitted is not a provider question, and reading its skills would report
verdicts for a grant that is not in force.

be established, so it is refused rather than assumed clear (fail-closed). The
absence of an evolution service is a different situation and is not refused —
a deployment with no ledger has no commit in flight.

defect with its code. Empty means the batch may proceed — which is a
statement about *loadable* providers only: this pre-check never adds a
capability to the closure, and knowledge/guidance verdicts are loadable
without being execution providers.


### src/question.ts

steps are: the refusal rules are part of the contract, and a unit test should
be able to drive them without a store.

request: an id can only ever name an event of the calling session. The read
goes through agent-runtime's `readToolCallBody`, which flushes the live
Session first — the citation must be durable before a store may record it —
and refuses by name when the event is missing, unreadable, or not a tool call.

exactly the bytes the store's record points at, and a record whose Session can
no longer be read is a refusal rather than a made-up body.

is information for the caller and a retry for the recovery pass — never a
reason to fail the call that already recorded the fact.

not a state to carry on from.


### src/recovery.ts

"无在途恢复尝试"). "In flight" is the run's own status and nothing else: a
run that is still `running` is an attempt still being made, and every
terminal status — verified, failed, cancelled, blocked — releases the
diagnosis for another key.

of the same request reproduces this digest and is answered from the record; a
different content under the same key is a refusal by name (the rule every
request key in this runtime follows).

reference, or to both, and the binding has to carry what the map names — the
map is immutable and the attempt binds to it, never around it.

product, `acceptsArtifact` as an existing raw input) has to resolve in the
store *now*. A binding whose inputs moved is not the evidence that was judged,
and re-running the position is the honest answer — reported, never silent.
The one input vocabulary this read cannot check is `protectedInputs`: those
are file identities re-checked by the verifier against the checkout, which a
store snapshot does not hold. The citation still carries them
({@link RootRecoveryReuse.inputRefs}), so a reader sees what the sibling's
criteria declared.

the members the attempt's own batches admit — the position is done again —
and this list is what makes that a reported fact rather than a silent
omission.

The derivation reads exactly four durable facts — the failed run's member
sequence, each member's own verified run and evidence bundle, the original
acceptance criteria's `childEvidence` map, and the store's current evidence
for the inputs and products those members declared — and it binds a position
only when all of them resolve:
- a member that did not pass is not a candidate: it is the work the attempt is
  for, and its position is left for the replacement an agent proposes;
- a passed member whose citation does not resolve (no verified run, no bundle,
  no passing verdict for the criterion the map names there, an artifact the
  bundle does not hold, an input or product the store no longer answers for)
  is **reported** in {@link ReuseDerivation.unbound} with every reason named —
  never bound, never silently dropped;
- a run that failed without a run (a rejected admission, a blocked task) has no
  member sequence, so nothing is derived and nothing is reported: there is no
  passed member the attempt is ignoring.
The result is deterministic: the same store answers the same citations, so two
attempts at one source bind the same members at the same positions.

carries what the store holds (an absent identity, which the check below
names), and the position goes to `unbound` with that reason.


### src/root-budget.ts

a batch that would push the tree past `maxRuns` is refused whole — before a
task, a child or an event exists — rather than admitted and then started until
the budget runs out mid-batch.

a configuration asking for any other number is a hard limit nobody can honor —
and §3.5's rule is that asking for an unenforceable hard limit refuses to
start rather than starting under a limit that is not real. Everything else
about the shape (unknown members, negative values) is the Config schema's
business, checked where the configuration is loaded.


### src/run-binding.ts

reordering of its keys does not.

on the path is refused, never followed) and hashed against the identity the
pre-check recorded before it is written, and the sidecar is carried verbatim
after its own digest and shape are checked — the declaration a reader sees in
the snapshot is the declaration the provider was validated against, not a
fresh parse that could differ.

before it is handed back to be stored.
Returns `undefined` for a run that has capability rows but no pre-check — a
caller that assembled its plan itself. Such a run's grant resolves its skills
at spawn through the deployment's own discovery, which is exactly the mutable
path this module exists to close, so **nothing is claimed**: the run records no
binding at all rather than a record that looks authoritative and describes
bytes nobody judged. Every production entry runs the pre-check, so this is the
hand-built-caller case only.
Throws — with the skill or the path named — when the admitted bytes are no
longer there, when the deployment cannot materialize at all, or when the
snapshot does not read back as the record describes it. A throw means the run
records no binding and loads no content: there is no state in which a run
claims content it did not load.

something else entirely — either way, writing into it would replace bytes
a record may already cite.

before trusting the record.
The check is the loader the pre-check uses, so "the snapshot is the admitted
content" is judged by the same rules that admitted it: the `SKILL.md` and the
declared resources must hash to the recorded content identity, the sidecar to
the recorded contract identity, the frontmatter must declare the skill's own
name, and the snapshot root must hold exactly the recorded skills — an extra
directory would be registered into a worker's layer, so it is reported rather
than ignored.
One more thing is re-read for a guidance skill: the loader names the entries
of its directory that the content identity does not cover (the same list
admission recorded as `uncovered`), and a snapshot must hold its bound content
only. An entry that appeared there since admission is therefore reported with
its name — the record described a directory that does not match these bytes —
while an entry the record lists as uncovered and absent from the snapshot is
simply a correct snapshot: materialization copies the identity's files, so a
source directory's uncovered entries never reach a run.
Returns `undefined` for a record that names no snapshot: a run that loaded no
content (a deterministic criteria replay, a run with no provider) has nothing
to re-read, which is not the same as content that failed to re-read.

supported vocabulary (the same list admission recorded as `uncovered`).
A snapshot a worker loads must hold its bound content only, so any such
entry is a difference between the record and the bytes — whether or not
the source directory had one of that name, since materialization copies
the identity's files and the source's uncovered entries never reach a
snapshot. (The other direction is therefore not a difference: an entry
the record lists as uncovered and absent from the snapshot is exactly
what a correct snapshot looks like.) Only for a snapshot that is still
the no-sidecar shape the record describes: a sidecar'd directory makes
the loader cover everything, and that mismatch is reported above.


### src/service/admission.ts

store's own submission rules still refuse a key bound to other content.

stands: the batch below clears the same rules either way, and `leaf` only
reaches admission as the name of the rule that would have refused it.

gap is a normal state with a record, not a silence). This entry writes
nothing, so the fact is carried out as a value and the L4 exit — a
separate, human-facing card the root raises with `escalate` — is named
in the refusal text.

spawned, and what discovery finds must be a provider the unified
validator accepts (registered verifier, covered tools, matching content).
It runs after the gap rejection and before the first write, so a batch
refused here leaves no task, no run, no event and no obligation — and the
same verdicts then travel with the batch (`BatchContext.providers`) instead of being
recomputed at spawn.

verifier service that cannot answer at all keeps its own error class and
message, and the continuation re-raises it instead of marking a reviewed
batch stale for a deployment's bad moment.

whole — before a task, a run or an event exists — instead of admitted and
then started until the budget runs out mid-batch. Nothing is reserved at
submission: §6 keeps the accounting where the side effect is, so a
proposal waiting for a review holds no run slot and a cancelled proposal
refunds nothing (A3's own rule: the limit counts recorded runs).
A budget that cannot be resolved (no run bound to this store as its root,
a root whose start nobody recorded) refuses the batch only when this
deployment actually configures limits: with no limits configured there is
nothing to measure, and refusing work over a budget that does not exist
would be a refusal with no promise behind it.

writer, and the batch is refused before the atomic commit rather than
handing two writers one checkout.

contract it carries, and this is the side that has to agree.

parent's `active → waiting_children` phase change and — T2/T3 §6 — the
consumption of the proposal this batch *is*, together. It is the
admission's own closing act: either the batch exists with the gate shut
behind it and the record of which proposal became it, or nothing happened
at all.
The batch is identified by the pair (this parent run, this proposal), and
the id is that pair's single spelling (`batchIdFor`, the same derivation
the reducer recomputes from the consumption): the consumption, the parent's
decomposition event and the phase change all name one batch instead of
three spellings of it — and a parent that admits a second batch later gets
an id that cannot be confused with the first's.

cancellation or the unload path reaches.


### src/service/drivers.ts

underneath would have answered, because the first side effect is what
the door guards.

only about the calls that were already in flight when it landed.

the same list the runtime's own submission used to hand over, read from the
run's projection instead of from a caller.

would keep a grandchild working in the shared checkout this cancellation is
about to release, with the children that never started still unblocked
(§3.6: the child in flight is stopped, the ones that never started are
blocked before start). Awaiting them here is what makes the whole subtree
settled by the time this call returns.

verification call stays `running` until its own turn unwinds, and the verdict
written in that window would win over a cancellation that was already asked
for — the store voids a verdict only for a run it already holds terminal
(`settleSubmittedRun`). `cancelGraph` settles the same way, which is why a
graph cancellation already voids that verdict.

children that never started are cancelled here, idempotently — a started
driver's own abort branch has already settled the parent by now, and the
store's terminal record is what makes this a no-op for it.

a rebinding that resolves a session of this store may not use the record —
which still says `running` because the settlement has not been persisted yet
— to lift a phase this cancellation already closed. The `finally` removes the
entry, so the barrier never outlives the operation and the store is the truth
for these sessions again afterwards.

is not executed — and that barrier completes its pass into a store whose
runs this cancellation is already settling, leaving no ready handle
behind. The next explicit activation is the retry.

back are live — the root's among them — so a question addressed to a
session this process just resumed is delivered here rather than left for a
retry nobody would make. Targets that are still not live come back
`unavailable`: zero side effects, no substitute parent, and the same retry
on the next activation. Nothing here can fail the pass: a store whose
deliveries cannot be decided is still a store whose facts were reconciled.
What could not be settled is *also* warned about here, so the one caller
that drops the returned report (adoption) cannot swallow it.
This block is the pass's one wake — the `steer` of an owed message and the
notice that wakes a Session holding an unread one — and a wake is a model
turn, so it may not run *inside* the barrier: the turn's first request
would meet a store that is still `recovering`, be refused by the recovery
door, and nothing would wake the Session again. A barrier in flight
therefore owns the decision, exactly as it owns the drivers it registers:
the pass hands it the deferred pass, the ready handle runs it once after
the gates and the `ready` status, and a failed or invalidated barrier
drops it. The intents live in the Task record and are re-read either way.

end and its wake leaves behind. The candidates are re-derived from the store
*here*, after the runs above were settled and resumed, so a parent this pass
brought back is among them: a run that is `active` holds no unfinished batch,
every entry of its accumulation is a batch that ended, and each ended batch
owes its Session exactly one message. Delivery is `redeliverBatchResult`,
which re-states the identity and the body from the record and lets the
target's own fold decide — so a batch whose message is already there adds
nothing, and a parent told before a restart is not told again.
The wake order is the question pass's: this is a `steer` plus, for a target
whose inbox still holds an unread copy, a notice — both are model turns, so
the block cannot run inside the barrier. Nothing here can fail the pass: the
facts are the store's, and the next activation re-derives the same list.

because that release resolves the same entry ({@link sessionWorkspaces}).
Nothing terminal resolves through it again: a decomposed child of this
session is refused by the store long before it could.


### src/service/lifecycle.ts

barrier that no longer exists, and a store mid-recovery must not answer
`ready` for a process that is on its way out.

registered through `ctx.effect` so they leave with this runtime: a gate
that outlived its runtime would deny calls on behalf of phases nobody
maintains any more.


### src/service/proposals.ts

restart, and different for a revision because a revision is different
    content. A request the store already answers is answered from the
    *record* here, before the run protocol is asked: the record is what a
    retry means (the same batch, still waiting or already admitted), and a
    retry must never build a second one.

the answer is the record itself — and a proposal still waiting gets the
review asked again, because a caller asking again is evidence that
somebody is still waiting for it.

holds are asked about before the record is written — the run is not
    already holding a batch, and it is not already holding a proposal
    (K1 §1) — because "one batch at a time" and "one proposal at a time"
    are what make the run's own state readable without counting anything.

for from the store alone (§5–§6), which is what makes a restart stop
being a boundary for approvals.

about anything else (a malformed record, a key bound to another batch)
is raised unchanged — this tolerance is narrow on purpose, and the
digest is what makes it safe.

Both answers are the record's own — a duplicate continuation cannot
build a second one.

run to ask about — so it is answered by its own step.

task's decomposition history — a run that returned to `active` after a batch
may approve another one, and the once-per-task rule is gone. Two answers,
and which one a caller gets says what to do next:
 - this run already waits on an unfinished batch: the proposal lost the race
   for that run (two processes, or a batch admitted while the review was in
   flight), so it is invalidated (`stale`) by name — the approval never
   travels to another batch, and the record stays readable;
 - the run cannot host a batch at all: it is gone, it is no longer running,
   it is no longer `active` (submitted, or terminal), or it is blocked on an
   unresolved question of its own. The continuation is **refused** by name
   with nothing written: any of those states can still move on its own (an
   answer releases a block), and invalidating a proposal for a state that
   may change would spend an approval the facts do not yet refuse.

`all`, it is sent for the review it never had. The other direction is not
a release — a waiting proposal is never freed by a policy change to `off`,
which is why this branch reads the stored policy as well as this one.
The checkout is resolved once here, for the provider pre-check the review
request and the re-check both need.

remembers, and an approval that survives a restart is continuable by
whoever reopens the store. A caller that re-presents a batch may only
*confirm* it — the re-presentation is derived and checked against the
stored identity, and any other batch is refused by name rather than
substituted for the one that was approved.

and both context fingerprints are recomputed and compared, because an
approval covers the batch as it was, under the limits and the resolution it
was reviewed with, not as any of them might have become.
Protected acceptance inputs are deliberately not re-read here: the stored
contract carries the identity that was fixed at submission (S1-V slice 2),
and a file whose bytes moved afterwards is caught where §4 puts it — the
verifier re-reads every declared input before judging and fails the
criterion naming the path, so a moved input is a judgement, never a silent
admission against bytes nobody checked.

left standing and the fault is raised by name.

context it was reviewed under, and reading that back would compare a value
with itself (§6 asks the runtime to re-read and re-check, not to re-echo).

reducer refuses a second `approved → ready`, and this branch simply does
not repeat it.

and the continuation's own ladder answer.

would answer with a goal nobody asked of this parent. The key is the
caller's, so this is a refusal by name rather than a silent re-mint.

needs to know rather than a list borrowed from another subject.


### src/service/replay.ts

digest all name one directory — or the caller's own session checkout.

table — the table this replay resolved against, not the configured one.
The overlay's extra skill roots are searched first because that is the
order the grant registers them in: a candidate skill in the sandbox is
what the replayed worker would load. Refused before anything persists.

Both are structural, both are judged here — before anything persists — and
the label names the champion this task stands in for.

declared (string) form is converted before any rule reads the criteria,
and a declaration that cannot be read, or a caller whose checkout cannot
be resolved, refuses the replay before anything persists. A champion's
stored fixed form is carried verbatim — never re-fixed, never invented —
because that historical identity is exactly what the pre-judgement
re-check has to compare against.

store's), and assumptions/constraints mirrored from the champion's own
contract when it has one — a replay runs the same task under a candidate
overlay, so the conditions it rests on travel with it. A champion created
before contracts existed declared none, and nothing is invented for it.

for it, and its contract projection carries the lineage label instead —
the spawn request itself carries no prompt and no contract text.
The replay's admission shares the batch's rules (§3.5, §3.4): it starts a
run, so the root budget must allow one — counted against the *same* root
total the tree spends, because a replay's parentless task shares its
funding root rather than getting a fresh allowance — and it writes into
one checkout, so that checkout must be claimable by this replay: the
caller's own (which the caller's tree must hold) or the workspace the
caller named (which nobody may hold). Both are checked here, before the
task is created, and both refuse with nothing persisted. A budget that
cannot be resolved refuses the replay for the same reason the batch
entries refuse: a configured hard limit nobody can measure is not a limit
this deployment may run without.

the spawn the worker's sub-execution inherits it from.

unnamed replay reports none, as it always did.

replay settles its run and returns an outcome — and the registration is
what `cancelGraph` looks for.


### src/service/root-intake.ts

apply/rollback is settled — or reported by name — before the store's runs
are adopted and before any admission can resolve a provider against a
target a commit left open. A blocked intent does not fail the barrier (the
admission gate refuses the provider it concerns, and a human settles what
production actually holds); a real read/write failure of the
reconciliation does, because half-recovered is not recovered.

(and what re-asks a waiting contract's review from the stored facts), so
it runs before the answer rather than after an explicit second call.

back. A run whose bound content is no longer readable is refused by name
rather than resumed against whatever stands at that path now.

sees the store's own workspace claim; a live or foreign holder remains a
named refusal through the existing ownership checks. Other recovery
paths keep their existing ownership order.

batch chain the pass left behind.

is blocked again from the durable facts, whether or not this process bound
it — the gate keys on the session id, and the store's runs are what name
the sessions.

here as it is everywhere else in this module.

whose own log holds no request of the person's, is a named refusal here and
leaves no store behind
(§1.10, {@link assertRootContractOrigin}) — a refused intake must not even
create the target store.

entry that opens it. A store that is already there is opened, never reset.

discovers from, and the run the activation starts will work in. It is the
root session's own graph env, exactly as a parent run's is its own.

waiting gets the review asked again, because a caller asking again is
evidence that somebody is still waiting for it.

hears it from the entry it called), and every admission rule has to pass.

rest on the store alone (§2).

(a key bound to other content, a root task that appeared between the
check above and this write) is raised unchanged.

hand, must not be able to *become* the store's root either. Every step
below this line — the expiry of a store that already holds a root, the
tightening, the stale marking, the activation commit — is a write, and the
refusal here leaves none of them attempted.

*current* policy, so a deployment that tightened to `all` sends it for the
review it never had. The other direction is not a release — a waiting
proposal is never freed by a change to `off`, which is why this reads the
stored policy as well as this one — and the review itself is requested from
the stored contract when this process can still show it.

gate. A root run with no phase would be a record the phase gate cannot
admit anything for.

a root that does not exist.

— a decision or an activation would both be operations on a root that
is already spoken for.

whose process died after the commit.


### src/service/root-recovery.ts

default.

The orchestration's viewpoint is the *caller's* session — its live agent is
what parents the spawn, exactly as a batch's round parents its children —
and the checkout it names is the tree's own: the new attempt does the same
work in the same directory the failed one did, never wherever the
coordinator happens to sit.

turn) — the same distinction the runtime itself makes when it resolves
a caller.


### src/service/runtime.ts

wrote are removed. The order matters — a marker removed while a driver
could still write would hand a checkout to the next claimer.


### src/service/sessions.ts

own hold).


### src/sidecar.ts

vocabulary does not cover, and every entry that is not a shape this contract
supports. Nothing is skipped silently — a link, a nested tree or a non-text
file is named.

frontmatter does not parse, is refused here in the parser's own words
rather than published under a name it does not declare.

of everything else in it.
The returned `content` is the identity computed from the bytes just read —
the same value a clean sidecar declares, and the honest answer for a skill
that declares nothing. `defects` empty means the directory is fully described
by its identity: every file is `SKILL.md`, the sidecar itself, or a supported
resource the declaration names. Absence of a sidecar is not a defect: the
skill is then guidance, not a provider.

supported position, a missing declared resource or a changed byte
are all refusals — a "mostly covered" identity is not an identity.

declaration does not name. A missing declared file or a changed byte is a
`content-mismatch`; a file nobody declared is `content-unsupported`, because
an identity that covers most of a directory is not an identity of it. A path
the scan already refused for its shape is not counted again here.

entry — config load, provider replacement, candidate promotion — calls this,
so `evolution_apply` is not the only defence and no entry can be the one that
skipped it.
Rules, in the order they are checked:
1. The directory exists, is a real directory, and is named after the skill.
2. The loader reads it: `SKILL.md`, the sidecar when present, the supported
   resources, and every entry whose shape the contract does not support. The
   declared content identity must equal the bytes read, and the `SKILL.md`
   frontmatter must parse and declare the granted name — the same rule, and
   the same words, the spawn's `readSkillFile` applies when it registers the
   body.
3. A sidecar the caller supplied must be the one the directory carries.
4. An execution sidecar's `verifier.ref` must be a registered verifier, and
   its `requiredTools` must be granted by the capabilities it declares it
   serves (`mcp__<server>__<tool>` counts when the capability mounts that
   server; the worker baseline is deliberately not counted — a capability
   must grant what the provider it carries needs).
5. A knowledge sidecar is checked for content and carried as knowledge: it
   never becomes an execution provider.
The verdict is a value: all defects are collected, nothing is written, and a
caller that only wants execution providers filters with
{@link executionProviders}.

different ways to be wrong, and both would publish a body under a name its
author did not give it.

that only works because every worker happens to hold a tool is not a
capability that closed a gap.


### src/skill-contract.ts

Purely declaration-level: the version, the closed field set of the declared
type, the shape of every field, and the internal consistency of the content
identity. It reads no files, so it cannot tell whether the digests are true —
that comparison needs the skill directory and lives in the loader. The
returned defects are values, not throws: a caller refusing a sidecar reports
all of them and writes nothing.

any declared field does. Call it on a sidecar that passed
{@link skillContractDefects}: an unvalidated object can carry fields this
identity would then cover without a rule saying what they mean.

{@link skillContractDigest} so a caller can name the bytes (a run recording
what it read) without claiming a sidecar it did not read.

nothing else about the object (K3): the capabilities, precondition, ports,
required tools, verifier and resources are the ones the production sidecar
declared, so the candidate's sidecar is *derived* from the production one
rather than authored — a content update that could also move a declaration
would be an undeclared privilege change. Every other field is carried over
item by item; the digest is checked first, because a value that is not a
lowercase 64-character hex SHA-256 would produce a declaration no reader could
verify and no writer should persist.

Determinism is the point: {@link skillContractDigest} hashes the canonical
key order, so the bytes on disk must be a function of the declaration alone,
not of the order a caller happened to build its object in. Two calls with the
same declaration produce the same string, and a reader can verify a file by
parsing it and re-serializing: identical bytes mean the declaration did not
move — which is exactly how the K3 derivation check compares a candidate's
sidecar with the one re-derived from the champion's bytes. The shape is
canonical keys, two-space indentation, one trailing newline.


### src/verified-read.ts

target should be, or a non-directory where a directory should be all fail
loudly, so a read can never land outside the root through a redirected path
even though the lexical path stays inside. A component that is simply absent
(ENOENT / ENOTDIR anywhere along the walk) is reported as `missing`, never
thrown — the caller decides whether absence is an error or an answer.

must not be a symbolic link. A missing file, a directory in the file's place,
or any other non-regular entry fails loudly. The bytes are returned exactly
as stored — no decoding, no newline conversion.


### src/workspace.ts

leaves every byte as it was and names why.

that names a pid this process is not.

are two different holders, and a handover that names the run but not the
instant it was taken is not the holder this stack is looking at.

markers. Throws when the path cannot be resolved (absent, a broken link, no
permission) — a workspace whose identity is unknown is not a workspace this
module will record an owner for.

Exported because it is the one honest pid-reuse check available here: compare
it with the value a marker recorded.

real deployment — a child's submission chain takes the verifier layer in and
out while the batch driver releases the child it has seen settle — and with one
shared temporary path the first `rename` takes the file away from the second,
whose release then fails with ENOENT. A counter per process rather than per
registry, because two registries in one process (a second graph's) write the
same marker path for the same workspace.

against a value no `/proc` field can equal.

rebuilds its owner description from scratch cannot reproduce the instant a
layer was taken, so the registry's full-key check is not what decides here —
and the layer actually on top is what the registry is asked to pop, so the pop
can never take a stranger's.
Returns `released: false` with the offending holder when the top is not the
caller's layer, and `released: false` alone when this process holds nothing:
the two cases mean different things, and each caller's policy decides which of
them is worth a diagnostic.

in the order they were called — the same order the stack was mutated in.
A rejected mutation is carried past, never stored: a write that failed
(a permission, a full disk) must not wedge the mutations behind it, and its
caller still sees the rejection it has to report.

already holds it, or when any marker is already there.

the ownership history: the run at the bottom keeps its claim while its batch
and current child are on top of it.

someone while a writer still believes it holds the workspace. The last
release deletes the marker; an earlier one rewrites it to the new top.

the next release already left.

success that changes nothing; a marker whose pid is alive, or whose bytes
cannot be read as a marker, is a refusal that leaves
everything in place, because adopting it would hand the checkout to a caller
while a writer that may still be running has no idea.

another process describes a writer this unload knows nothing about, and
removing it could hand a checkout to the next caller while that writer runs.

that pid. Omitted when `/proc` cannot answer for it, which is honest: the
pid-reuse comparison is then simply not available for this marker.
