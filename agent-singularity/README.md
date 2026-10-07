# dsh-singularity-agent

[中文](README.zh.md) | English

Purpose: The Singularity root agent's tool surface — delegation, task coordination, review, evolution and human decisions — plus the services it owns (HITL, escalation, proposal review, review ledger).

Package: `@dangosys/dsh-singularity-agent`

Dependencies: graphs, agent-runtime, context, task, task-runtime, evolution

config.yaml: `evolution` (`off` | `on`, default `off`) — whether this composition registers the nine `evolution_*` tools on the global layer. Off registers the other 23 tools and no chain tool on any surface; on registers all 32. A value this build cannot execute, or a configuration member it does not read, refuses to start and names what it refused.

See the [current RSI protocol](../docs/2026-10-07-rsi-optimization.md) for role boundaries, template construction, round settlement and migration.

### Tools

23 tools are registered in every composition; the nine `evolution_*` ones only when `evolution` is `on`. The root agent's allow-list names those 23 minus `task_ask_parent` (a root has no parent), plus the preset's `skill` loader.

1. graph_spawn — root-only, create a setup-phase worker with a restricted setup grant and wait for its final response; objective work goes through task_decompose.
2. graph_mark_ready — root-only, mark the caller's graph ready after environment setup.
3. hitl_ask — ask a human a text question and wait for the answer.
4. hitl_approve — ask a human to approve/reject and wait; only `allowed-once` grants, everything else fails closed.
5. task_read — read the caller's contract, task and run (root sees child statuses; before acceptance, the named not-activated state).
6. capability_list — print the capability table with each tool label's expansion and the provider verdict for every declared skill.
7. context_read — read one record of the caller's own graph domain (`task`, `run`, `evidence`, `review`, `diagnosis`, `session`), paged; no argument can widen the domain.
8. task_intake — root sessions only: submit the root contract; the runtime normalizes and judges it, then activates it or answers with a proposal id.
9. task_decompose — propose/admit one child batch and return its batch id at once (or a proposal id when the deployment reviews generated tasks).
10. task_submit_result — hand in a finished run (summary + evidence); the runtime closes write admission, drains in-flight calls and hands the run to the verifier.
11. task_ask_parent — ask the caller's own direct parent one question; `blocking` (default true) holds the run until an answer with `resolves: true`.
12. task_answer — answer one child's question (`questionId`, `requestKey`, `answer`, `resolves`); `resolves: true` releases exactly that block.
13. task_cancel — cancel the caller's own in-flight child batch.
14. task_proposal_read — read one saved proposal: status, policy, complete batch, digests, recorded decision.
15. task_proposal_continue — re-check and admit a proposal this session submitted; a proposal still waiting is reported as waiting.
16. task_proposal_cancel — withdraw a proposal this session submitted before its batch is admitted.
17. task_status — paged project status: the caller's task, its direct children and dependency neighbours, or the whole graph.
18. task_verify — worker self-check: re-run the verifier and record evidence; no task status changes.
19. task_review_pack — read-only evidence pack for one exact review source, including durable coordination attempts for its diagnoses.
20. task_review_agent — start one read-only review attempt for one source; the reviewer records its own Diagnosis (observation, conclusion, confidence, optional judgements and proposals).
21. task_diagnose — persist a Diagnosis (postmortem observation, scope, localized cause, confidence, optional proposals); suggestions never execute.
22. task_budget_extend — ask a human to raise a configured root run ceiling; records one budget-extension fact and answers a same-key retry from the record.
23. evolution_propose — register an evolution proposal (optionally transcribed from a Diagnosis).
24. evolution_candidate — record the candidate's version set and its one structured mutation.
25. evolution_prepare — materialize a mutation into the proposal sandbox plus the champion snapshot.
26. evolution_replay — run the two-sided experiment (baseline vs candidate) and write the comparison report.
27. evolution_gate — record the six gate answers; regression evidence refs must exist.
28. evolution_decide — record PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH after a native human approval.
29. evolution_apply — promote a decided PROMOTE (same-name skill object, or one capability row with its optional new skill) into production; second human approval, every production path named.
30. evolution_rollback — restore the champion snapshot (or remove the apply product) after a human approval.
31. evolution_list — read the evolution ledger with status filters and history.
32. escalate — raise an L4 card (capability gap, exhausted budget, UNKNOWN(verifier)); shown through the approval seam and recorded in the escalation ledger only after an explicit approve.

### Web APIs

none — the HITL cards are served by graph-web (`GET/POST /singularity/hitl`), which mounts this plugin for `ctx.hitl`.

### Service state

1. ctx.singularityAgent: tool registration host (23 always; 32 with `evolution: on`); the root allow-list is ROOT_TOOLS in agent-runtime.
2. ctx.hitl: the canvas answerer on `ctx.userQuestions` / `ctx.approval`; pending cards are listed and answered through graph-web.
3. ctx.proposalReviewChannel: the T2/T3 review channel — renders the saved subject, asks the store owner's session through the approval seam, records the decision as `approval:<owner session>`.
4. ctx.escalation: append-only escalation ledger at `$DSH_HOME/escalations.jsonl` (`<repoRoot>/.dsh` when `DSH_HOME` is unset); config override `root`.
5. ctx.singularityEvolution: `{ enabled }` — the switch this assembly resolved, read by a sibling assembly to keep its surface in step.
6. ctx.evolution: the evolution ledger (`$DSH_HOME/evolution/proposals.jsonl`) plus per-proposal sandboxes; constructed whatever the switch says, unreachable with the chain off.
7. Review ledger: `$DSH_HOME/review-agents/agents.jsonl` (overrides `SINGULARITY_REVIEW_LEDGER_DIR`, cap `SINGULARITY_REVIEW_AGENT_BUDGET`) — append-only claim/started/settled rows for both the reviewer and supervisor roles.

## Design notes

- Layout: `src/index.ts` is the assembly. `src/services/` owns the mounted services (hitl, escalation, proposal-review + its rendering); `src/coordination/` owns the coordination ledger, read-only reviewer attempts, the graph RSI driver and identity helpers; `src/tools/` owns the 32 `define*Tool` entries; `src/shared.ts` owns the helpers they share. The pre-refactor top-level module paths are gone — every consumer imports the owning module directly.
- `src/shared.ts` owns the helpers the tool surface used to copy: `text()`, `sessionId(exec, tool)`, `message()`, `undeclaredParameters()`, `denialReason()` / `approvalAnswer()`, `adaptRead()`, `proposalStoreFor()` and `questionCall()` — `message()` is also what the coordination and service modules use. One implementation per helper, per package.
- The approval gates read the native outcome vocabulary, never an argument: only `allowed-once` lets a decision, an apply or an escalation be recorded; `rejected` / `cancelled` / `unavailable` are reported by name and write nothing.
- The review ledger is the only durable record of coordination attempts. `admitReviewAgent` runs each decision inside one serial region per (ledger file, root store), writes the claim before the reviewer exists and counts the `started` row as the spent run; an open row no live process owns is recovered as `interrupted` (or `recorded` when the store already holds its diagnosis). Supervisor attempts use the same durable claim/start/settlement facts, read back when the platform reconciles a round.
- Refusals are values, not silent drops: undeclared tool parameters, unknown store ids, unknown records and conflicting ledger rows are refused by name with the reason, so a model or an operator can act on the exact fact.
- Long-form design rationale for the pre-refactor layout lives in `packages/singularity/docs/` (singularity-harness-guide.md, exploration-evolution-architecture.md, agent-prompt-contracts.md).
