# dsh-singularity-task

[中文](README.zh.md) | English

Purpose: Persist the task decomposition tree, dependency DAG, run state machine, proposals, questions and budget extensions, and expose the task service to the runtime.

Package: `@dangosys/dsh-singularity-task`

Dependencies: sessionPersistence

config.yaml: none

### Tools

none

### Web APIs

none

### Service state

1. ctx.task: store open/create (`createStore` / `openStore` / `snapshotIn` / `commitIn`), reads (`taskIn` / `runIn` / `runMembersIn` / `runMemberSlotsIn`), task and run lifecycle writes (`createTaskIn` / `admitTaskIn` / `rejectTaskIn` / `admitBatchIn` / `admitRootProposalIn` / `startRunIn` / `markRunStatusIn` / `changeRunPhaseIn` / `markRunProgressIn` / `addDependencyIn` / `recordHandoffIn` / `askParentQuestionIn` / `answerParentQuestionIn`), record writes (`recordEvidenceIn` / `recordReviewIn` / `recordDiagnosisIn` / `recordObligationIn`), proposal writes (`submitProposalIn` / `decideProposalIn` / `changeProposalPhaseIn` / `consumeProposalIn`) and `recordBudgetExtensionIn`.

2. event `task/change`: broadcast TaskSnapshot after a commit.

3. persisted `task/event` (SessionEventMap): replay is one `TaskState.apply` per record; the payload roots are fingerprinted in `docs/persistence-schema.json`.

4. `EventStoreSet` (`src/service/store.ts`): the shared event-sourced store factory over `sessionPersistence` — open/create with header, replay validation, serial writes, per-commit broadcast and disposal — exported for the graph plane's stores (per-graph topology, layout geometry and the graphs registry).

## Design notes

The store is event-sourced: `TaskService` opens one session per store id and replays its `task/event` records through `TaskState.apply`, which is the single owner of the snapshot. Every write is one `commitIn`: the batch is applied to a clone inside the store's single write queue and appended only if the reducer accepted it, so a refused event is never persisted and concurrent callers cannot interleave a decision with its append. That machinery is the shared `EventStoreSet` factory in `src/service/store.ts`, parameterized by the event type, the reducer state, the snapshot and the change-event name, wrapping `sessionPersistence` — task instantiates it with `task/event`, `TaskState` and `task/change`, and the graph plane's stores (per-graph topology and layout, plus the graphs registry) use the same factory. `compact` (the factory's append step) drops `undefined`-valued keys (through `definedKeys`, the same rule `canonicalize` uses) because the session log accepts only lossless JSON.

`TaskContract` is the one data definition every creation entry adapts to; a task's `objective`, `acceptanceCriteria` and `requestedCapabilities` are projections of it and the reducer refuses a disagreement. Content identities are deliberately separate: `contractDigest` and `decompositionDigest` describe what was asked for, `admissionContextDigest` the limits in force, and `reviewContextDigest` what the batch resolved against (capability manifests and judging verifier instances, normalized so registry order does not move the identity). Ids minted at admission are not inside any digest, so a retry keeps one identity.

A batch is identified by `(parentRunId, proposalId)` — `batchIdFor` spells the pair — because a parent decomposes more than once; each admission appends its members to the parent's children and one batch to that run's accumulation, in order, so a later batch never renumbers an earlier one. Records written before that identity existed carry none of the three fields and are read as the decomposition they were, never guessed at.

`ExecutionPhase` is the admission gate, not the run status: `active → waiting_children` closes the writing gate for an admitted batch, `waiting_children → active` hands execution back, and either phase may go to `submitted`. A phase-less run from before the protocol is never defaulted — its only legal continuation is cancellation. A recovery attempt (A6) is the run's own `recovery` field, so "is this attempt in flight?" is answered by the run's status; `runMemberSlots` merges the siblings an attempt pins with the members its own batches admit, and `runMemberTaskIds` is the same sequence with the holes left out.

Questions keep only identity and citations: `questionIdOf` derives the id from the asking run and the request key, `answerIdOf` from the question and the answer key; the bodies stay in the senders' Sessions. Blocking is derived from the question records — no phase, run field or second index carries it — and a question is open only while both runs are running.

A proposal is carried whole (every child's normalized contract, not only digests) because an approval, a canvas view and a resumed review render it from the stored facts. Its lifecycle is a status table, not a task status; an approval binds the dossier digest and both context fingerprints; the consumption lands in the same commit as the children (or the root task and run), so a crash is recovered from the log alone and one proposal can never become two batches.

A budget extension records the pair (ceiling in force → ceiling approved) per dimension plus the whole reading the person was shown. The chain is checked dimension by dimension inside the write queue: a raise must name the value actually in force, the first raise of a dimension states the deployment's own configured value, and one request key names one request whose repeat is answered from the record.

`src/index.ts` is the barrel and the service facade; the reducer lives under `src/service/`: `state.ts` holds the `TaskState` class and the task/run lifecycle handlers, `questions.ts`, `records.ts` and `proposals.ts` hold their fact families, `store.ts` holds `EventStoreSet` (the shared factory the sibling graph and graphs packages consume), and `checks/` holds the shape, identity and transition checks as functions over a snapshot (`primitives.ts` is the shared leaf: copy, predicates, index guards, lookups). Extracted checks only return or throw; there is no second store and no per-event persisted state.
