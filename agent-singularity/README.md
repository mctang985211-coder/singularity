# dsh-singularity-agent

[中文](README.zh.md) | English

Purpose: The Singularity root agent's tool surface — delegation, task coordination, review, method search and human decisions — plus the services it owns (HITL, escalation, proposal review, the coordination driver).

Package: `@dangosys/dsh-singularity-agent`

Dependencies: graphs, agent-runtime, context, task, task-runtime, evolution

config.yaml: `methodTools` (`off` | `on`, default `on` — the six `method_*` tools are the one way a method changes) — whether this composition registers the six `method_*` tools on the global layer; `off` registers none, so no model surface (root or granted worker) can read, draft or publish a method. `supervision.coordinationBudget` sets the coordination allowance a store's coordination agents spend. A value this build cannot execute, or a configuration member it does not read, refuses to start and names what it refused.

The retired `evolution` switch and the nine `evolution_*` tools no longer exist: method search on a current-protocol graph runs through `method_draft` → `method_evaluate` → `method_publish` / `method_discard` / `method_rollback`, concluded by the session's explicit completion tool (`supervisor_complete` / `reviewer_complete`), with rounds driven by the one coordination driver. A graph without the protocol marker is sealed history, served read-only. See the [workspace README](../README.md) for the main path and the [evolution plane README](../evolution/README.md) for the v5 method ledger and the RRSI strategy.

### Tools

27 tools are registered in every composition; the six `method_*` ones only when `methodTools` is `on` (33 then). The root agent's allow-list (agent-runtime's `ROOT_CORE_TOOLS` + `escalate`) names the 27 minus the coordination-only completion tools and `task_ask_parent` (a root has no parent), plus the preset's `skill` loader and, when the method tools are registered, `method_list` and `method_draft` — a root may observe and propose, never publish.

1. graph_spawn — root-only, create a setup-phase worker with a restricted setup grant and wait for its final response; objective work goes through task_decompose.
2. graph_mark_ready — root-only, mark the caller's graph ready after environment setup.
3. hitl_ask — ask a human a text question and wait for the answer.
4. hitl_approve — ask a human to approve/reject and wait; only `allowed-once` grants, everything else fails closed.
5. task_read — read the caller's contract, task and run (root sees child statuses; before acceptance, the named not-activated state).
6. capability_list — print the capability table with each tool label's expansion and the provider verdict for every declared skill.
7. task_library — read this graph's TaskTemplate and Skill library; read-only for every role — a method changes through a draft, never by editing the library in place.
8. task_template_list — read full TaskTemplate contracts; bind a method through `requiredCapabilities` as `method:<skill-name>`.
9. context_read — read one record of the caller's own graph domain (`task`, `run`, `evidence`, `review`, `diagnosis`, `session`), paged; no argument can widen the domain.
10. task_intake — root sessions only: submit the root contract; the runtime normalizes and judges it, then activates it or answers with a proposal id.
11. task_decompose — propose/admit one child batch and return its batch id at once (or a proposal id when the deployment reviews generated tasks).
12. task_submit_result — hand in a finished run (summary + evidence); the runtime closes write admission, drains in-flight calls and hands the run to the verifier.
13. task_ask_parent — ask the caller's own direct parent one question; `blocking` (default true) holds the run until an answer with `resolves: true`.
14. task_answer — answer one child's question (`questionId`, `requestKey`, `answer`, `resolves`); `resolves: true` releases exactly that block.
15. task_cancel — cancel the caller's own in-flight child batch.
16. task_proposal_read — read one saved proposal: status, policy, complete batch, digests, recorded decision.
17. task_proposal_continue — re-check and admit a proposal this session submitted; a proposal still waiting is reported as waiting.
18. task_proposal_cancel — withdraw a proposal this session submitted before its batch is admitted.
19. task_status — paged project status: the caller's task, its direct children and dependency neighbours, or the whole graph.
20. task_verify — worker self-check: re-run the verifier and record evidence; no task status changes.
21. task_review_pack — read-only evidence pack for one exact review source, including durable coordination attempts for its diagnoses.
22. task_review_agent — start one read-only review session for one source; the reviewer records its own Diagnosis by calling `reviewer_complete` (observation, conclusion, confidence, optional judgements and proposals).
23. supervisor_complete — conclude the round this session was assigned: `businessAction` (continue | recover | finish), `reason`, `evidenceRefs`, optional `trialCandidateRef`. The platform derives the rest, and the call closes the session's writes.
24. reviewer_complete — conclude this review: `observation`, `conclusion`, `confidence`, optional scope, refs, judgements and proposals; writes the Diagnosis and closes the session's writes.
25. task_diagnose — persist a Diagnosis (postmortem observation, scope, localized cause, confidence, optional proposals); suggestions never execute.
26. task_budget_extend — ask a human to raise a configured root run ceiling; records one budget-extension fact and answers a same-key retry from the record.
27. escalate — raise an L4 card (capability gap, exhausted budget, UNKNOWN(verifier)); shown through the approval seam and recorded in the escalation ledger only after an explicit approve.
28. method_list — read this library's method state: the effective revision and pointer, every draft with its status and last verdict, which Runs are explicitly trying which candidate, and the compact refutation history.
29. method_draft — propose one candidate method: one asset kind (Skill, capability or TaskTemplate), its stable identity, the complete new content, the evidence it answers and the independent mechanism under test; the base revision must be the active one and the frozen edit budget applies.
30. method_evaluate — measure one draft through the one evaluation pipeline: the frozen cohort (both sides of every sample with its original acceptance), the frozen [0,1] quality scale, the objective and the budget; writes one `EvaluationReport` and the strategy's decision record.
31. method_publish — publish one evaluated candidate as the library's effective revision: the expected active revision and generation are the compare-and-swap pair the one approval shows; a pointer anyone else moved refuses the call.
32. method_discard — discard one candidate with a named outcome (measured-rejected or unmeasured-declined) and remove its working directory; no approval, the active revision never moves.
33. method_rollback — restore one revision this library published before, through the same pointer transaction and one approval showing the reverse switch.

### Web APIs

none — the HITL cards are served by graph-web (`GET/POST /singularity/hitl`), which mounts this plugin for `ctx.hitl`.

### Service state

1. ctx.singularityAgent: tool registration host (27 always; 33 with `methodTools: on`); the root allow-list is `ROOT_CORE_TOOLS` + `escalate` (+ `method_list`/`method_draft` when the method tools are on) in agent-runtime.
2. ctx.hitl: the canvas answerer on `ctx.userQuestions` / `ctx.approval`; pending cards are listed and answered through graph-web.
3. ctx.proposalReviewChannel: the T2/T3 review channel — renders the saved subject, asks the store owner's session through the approval seam, records the decision as `approval:<owner session>`.
4. ctx.escalation: append-only escalation ledger at `$DSH_HOME/escalations.jsonl` (`<repoRoot>/.dsh` when `DSH_HOME` is unset); config override `root`.
5. ctx.singularityMethods: `{ enabled }` — the method-tool exposure this assembly resolved, read by agent-runtime to keep the root allow-list and prompt in step.
6. ctx.singularitySupervision: the supervision policy this assembly resolved — the coordination allowance, plus the per-store round caps the task runtime's recovery entry reads (`maxImprovementRoundsFor` / `maxRecoveryRoundsFor`).
7. ctx.evolution: the legacy v4 evolution ledger (`$DSH_HOME/evolution/proposals.jsonl`), mounted read-only so a sealed legacy graph keeps its history projection; no model tool writes it any more. Its open commit intents are reconciled by the task runtime's activation barrier, not settled here; an unreadable ledger refuses this plugin's startup by name. The current method ledger is each library's `<root>/methods.jsonl` (`formatVersion: 5`), owned by the evolution plane.
8. Coordination store: `$DSH_HOME/coordination/assignments.jsonl` (directory override `SINGULARITY_COORDINATION_DIR`, per-store cap `SINGULARITY_COORDINATION_BUDGET`) — append-only rows of exactly two kinds: `assignment` (written and fsynced before an agent is spawned) and `completion` (written once its work item ends, by the session's own completion tool or by the platform). The retired `$DSH_HOME/review-agents/agents.jsonl` and the retired `SINGULARITY_REVIEW_LEDGER_DIR` / `SINGULARITY_REVIEW_AGENT_BUDGET` names are not read at all; the driver prints the directory it really uses at startup.

This assembly also wires the graph-scoped machinery rather than exposing it as services: the coordination binding source and coordination/method facts readers registered on the context view service, the per-graph coordination driver (the only place a supervision round is opened), and the root-budget approval callback the task runtime asks.

## Design notes

- Layout: `src/index.ts` is the assembly. `src/services/` owns the mounted services (hitl, escalation, proposal-review + its rendering); `src/coordination/` owns the coordination store, the pure assignment plan and reducer, the per-graph driver, the completion payloads, the supervision prompt, the facts reader and identity helpers; `src/tools/` owns the `define*Tool` entries — the six `method_*` tools with their shared planes (`method-shared.ts`) and rendering (`method-render.ts`), `supervisor_complete` and `reviewer_complete` (`completion-tools.ts`), and the task/HITL surface; `src/shared.ts` owns the helpers they share. The pre-refactor top-level module paths are gone — every consumer imports the owning module directly.
- `src/shared.ts` owns the helpers the tool surface used to copy: `text()`, `sessionId(exec, tool)`, `message()`, `undeclaredParameters()`, `denialReason()` / `approvalAnswer()`, `adaptRead()`, `proposalStoreFor()` and `questionCall()` — `message()` is also what the coordination and service modules use. One implementation per helper, per package.
- The approval gates read the native outcome vocabulary, never an argument: only `allowed-once` lets a decision, a publish or an escalation be recorded; `rejected` / `cancelled` / `unavailable` are reported by name and write nothing.
- The coordination store is the only durable record of coordination work. One `assignment` is written (and flushed to the device) inside the graph's serial region before its session is spawned, and the spawn's own door reads it back before any model input; exactly one `completion` closes an assignment, and a repeat of a completion call is answered from the record. Session liveness, the turn facts and the spent allowance come from DSH itself (`ctx.agents`, `ctx.sessionPersistence`, `ctx.sessionQuery`), never from a second record. The one driver reads facts, reduces them once and executes that step — event-woken, with a two-second fallback — and never awaits a supervision session; a session whose turn ends without its completion tool is recorded as a protocol failure and is not asked again (bumping the graph's `rsi.epoch` is the explicit way to try the round once more).
- `supervisor_complete` and `reviewer_complete` derive everything about the caller — graph, source Run, role, authority — from the assignment the session is recorded under, and derive the method decision, the approval source and the search step from what the round actually recorded; they take no argument for any of it. Calling one closes the session's write access at execution time (a guard installed by the composition on both the spawn and the resume path), while reads, evidence and findings stay available.
- The six `method_*` tools are thin adapters over three planes (`method-shared.ts`): the environment plane (the task runtime's revision/draft/pointer service), the method ledger plane (the evolution package's v5 pipeline) and the strategy plane (the RRSI decision records). They read the graph's protocol marker first: a sealed legacy graph is answered by name and nothing in this surface writes it. Publish and rollback move exactly one pointer through the task runtime's CAS transaction (`expected.revisionId` + `expected.generation`); the ledger's `published`/`rolledback` record is written only after the transaction succeeds.
- Refusals are values, not silent drops: undeclared tool parameters, unknown store ids, unknown records and conflicting ledger rows are refused by name with the reason, so a model or an operator can act on the exact fact.
- Long-form design rationale for the pre-refactor layout lives in `packages/singularity/docs/` (singularity-harness-guide.md, exploration-evolution-architecture.md, agent-prompt-contracts.md).
