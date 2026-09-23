# dsh-singularity-agent

[中文](README.zh.md) | English

Purpose: Singularity graph worker delegation, readiness and cancellable human-in-the-loop tools.

Package: `@dangosys/dsh-singularity-agent`

Dependencies: graphs, tools

config.yaml: `evolution` (`off` | `on`, default `off`) — whether this composition registers the nine `evolution_*` tools on the global layer. Off (the shipped default, `DEFAULT_EVOLUTION`) registers 18 of the tools below and none of the evolution chain: no agent surface can call one, including a spawned worker with no grant, which otherwise keeps the global layer. On registers all 27, with the chain's validation, approvals, history reads and rollback unchanged. A value this build does not implement, or a configuration member it does not read, refuses to start and names what it refused.

### Tools

18 of the 27 are registered on the global layer in every composition; the nine `evolution_*` tools only when `evolution` is `on`, so a default deployment's global layer carries the first 18 (numbered 1–17 and 27 below) and a deployment that turned the chain on carries all 27. The root agent's allow-list (ROOT_TOOLS in `@dangosys/dsh-singularity-agent-runtime`) names exactly these 27 plus the `skill` loader the mounted preset provides, and reads which of the nine exist from `ctx.singularityEvolution` — a root surface and this list that drift apart is what the switch is there to prevent.

1. graph_spawn: create a worker node through Singularity runtime and wait for its response.
2. graph_mark_ready: mark the calling agent's graph ready.
3. hitl_ask: wait for a human text answer; cancel with the tool execution.
4. hitl_approve: wait for an explicit approve/reject decision; cancel with the tool execution.
5. task_read: read the caller's task contract and (for the root) child task statuses.
6. capability_list: print the configured capability table — the legal capability names, with each tool label's expansion.
7. task_decompose: admit a child batch and return its batch id at once (reason + children with objective / acceptance criteria / dependsOn / decomposable); the runtime runs the children in dependency order while the caller keeps working. Where the deployment reviews generated tasks, the call answers with a proposal id and nothing admitted instead — the batch waits for a recorded decision.
8. task_submit_result: hand in a finished run — a summary plus evidence references; the runtime closes write admission, drains in-flight writes, then the verifier decides.
9. task_cancel: cancel the caller's own in-flight batch; the children settle as cancelled.
10. task_proposal_read: read one saved proposal by id — its status and policy, the complete batch it carries, the digest, both context fingerprints, the decision on record and the batch it became. Read-only, and there is no argument that could claim a status.
11. task_proposal_continue: continue a proposal this session submitted — the runtime re-checks it (parent state, limits, capability resolution, judging verifiers) and admits the batch if it still passes and carries an approval; a proposal still waiting is reported as waiting, and nothing is ever advanced by this call alone.
12. task_proposal_cancel: withdraw a proposal this session submitted before its batch is admitted; only the proposing session may, and the record is kept.
13. task_status: print the task tree with run / phase / evidence / review / diagnosis summaries.
14. task_verify: worker self-check — re-run the verifier, record evidence, never change task status.
15. task_review_pack: read-only evidence pack for one task (reviews, parent/child summaries, dependency edges, escalation verdict).
16. task_review_agent: spawn ONE read-only review agent when the pack's escalation criterion (E1–E4) fires and the per-store budget has room; persists its six-dimension judgement as a Diagnosis.
17. task_diagnose: persist a Diagnosis (proposals are suggestions only; nothing auto-executes).
18. evolution_propose: register an evolution proposal (optionally transcribed from a Diagnosis).
19. evolution_candidate: record the candidate's full version set and optional structured mutation.
20. evolution_prepare: materialize a mechanical mutation into the proposal sandbox plus the champion snapshot.
21. evolution_replay: replay the candidate against this graph's terminal historical tasks; writes the candidate-vs-champion report.
22. evolution_gate: record the six gate answers (regression evidence refs must exist).
23. evolution_decide: record PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH — only after a native human approval.
24. evolution_apply: promote a decided PROMOTE (skill / agent_preset / capability, L1–L3, materialized) into production; second human approval, names every production path it writes.
25. evolution_rollback: restore the champion snapshot (or delete the apply product when there was no champion); human approval again.
26. evolution_list: read the ledger with filters and history.
27. escalate: report an unsettlable gap/budget/UNKNOWN(verifier) to a human (L4) — shown through the native approval seam and recorded in the append-only ledger (`.dsh/escalations.jsonl`) only after an explicit approve; reject/cancel/unavailable records nothing.

Graphs are created from New graph. Repository installs are done by the agent with bash (clone + build per repo docs), then `env_register_component`.

### Web APIs

none

### Service state

1. ctx.singularityAgent: tool registration host; root agents receive exactly the tools listed above that this composition registered — 18 of them, or all 27 once `evolution` is `on` (ROOT_TOOLS allow-list, plus the preset-provided `skill` loader)
2. ctx.hitl: the canvas answerer on the native interaction seams — hitl_ask asks through ctx.userQuestions, hitl_approve through ctx.approval (native audit events + fail-closed); ctx.hitl only bridges those waterfalls to the pending cards the canvas answers over GET/POST /singularity/hitl, removed on answer, cancellation or service disposal
3. ctx.proposalReviewChannel: the T2/T3 review channel mounted on this fiber — the task runtime resolves it softly and asks it when a decomposition proposal waits for a human (policy `all`). It renders the saved batch (parent, every child, limits, obligations, both context fingerprints), asks through the native approval seam on the store owner's session, and records the answer as a `TaskProposalDecided` through `taskRuntime.decideProposal` under its own decider identity (`approval:<owner session>`); no agent tool accepts an approval credential, and a proposal nobody can be asked about stays `pending_review` with the reason.
4. ctx.evolution: the append-only evolution ledger (`proposals.jsonl` under `$DSH_HOME/evolution`) plus per-proposal sandboxes (`sandbox/<proposalId>/`) where evolution_prepare materializes a candidate's structured mutation and the champion snapshot, and where evolution_replay writes the candidate-vs-champion comparison report (`replay-report.json`) after running the candidate against the graph's terminal historical tasks; beyond ledger and sandbox, the only writes are evolution_apply / evolution_rollback promoting a PROMOTE-decided skill / agent_preset / capability into production (champion snapshot restored on rollback, apply product deleted when there was no champion) — each gated by its own native human approval, L4 and the bookkeeping-only types always refused; provided on the agent's own fiber, not by a child plugin, because the evolution_* tools read it through the context they were registered with. Constructed whatever `evolution` says — with the chain off it is simply unreachable (no tool to call it through, no automatic trigger anywhere in this deployment), because closing the exposure surface does not delete the ledger, its validation or its authorization rules
5. ctx.singularityEvolution: `{ enabled: boolean }`, provided on this fiber — the switch this assembly actually resolved. Not a second gate, but the fact a sibling reads to keep its own surface in step (`ctx.get('singularityEvolution')?.enabled ?? false`; agent-runtime's root allow-list is the consumer). Absent when this plugin is not mounted, and that absence reads as `false`: a composition nobody turned evolution on for is not assembled as if somebody had
