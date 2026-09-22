# dsh-singularity-agent

[中文](README.zh.md) | English

Purpose: Singularity graph worker delegation, readiness and cancellable human-in-the-loop tools.

Package: `@dangosys/dsh-singularity-agent`

Dependencies: graphs, tools

config.yaml: none

### Tools

All 23 are registered on the global layer; the root agent's allow-list (ROOT_TOOLS in `@dangosys/dsh-singularity-agent-runtime`) names exactly these, so the root surface and this list cannot drift apart.

1. graph_spawn: create a worker node through Singularity runtime and wait for its response.
2. graph_mark_ready: mark the calling agent's graph ready.
3. hitl_ask: wait for a human text answer; cancel with the tool execution.
4. hitl_approve: wait for an explicit approve/reject decision; cancel with the tool execution.
5. task_read: read the caller's task contract and (for the root) child task statuses.
6. capability_list: print the configured capability table — the legal capability names, with each tool label's expansion.
7. task_decompose: admit a child batch and return its batch id at once (reason + children with objective / acceptance criteria / dependsOn / decomposable); the runtime runs the children in dependency order while the caller keeps working.
8. task_submit_result: hand in a finished run — a summary plus evidence references; the runtime closes write admission, drains in-flight writes, then the verifier decides.
9. task_cancel: cancel the caller's own in-flight batch; the children settle as cancelled.
10. task_status: print the task tree with run / phase / evidence / review / diagnosis summaries.
11. task_verify: worker self-check — re-run the verifier, record evidence, never change task status.
12. task_review_pack: read-only evidence pack for one task (reviews, parent/child summaries, dependency edges, escalation verdict).
13. task_review_agent: spawn ONE read-only review agent when the pack's escalation criterion (E1–E4) fires and the per-store budget has room; persists its six-dimension judgement as a Diagnosis.
14. task_diagnose: persist a Diagnosis (proposals are suggestions only; nothing auto-executes).
15. evolution_propose: register an evolution proposal (optionally transcribed from a Diagnosis).
16. evolution_candidate: record the candidate's full version set and optional structured mutation.
17. evolution_prepare: materialize a mechanical mutation into the proposal sandbox plus the champion snapshot.
18. evolution_replay: replay the candidate against this graph's terminal historical tasks; writes the candidate-vs-champion report.
19. evolution_gate: record the six gate answers (regression evidence refs must exist).
20. evolution_decide: record PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH — only after a native human approval.
21. evolution_apply: promote a decided PROMOTE (skill / agent_preset / capability, L1–L3, materialized) into production; second human approval, names every production path it writes.
22. evolution_rollback: restore the champion snapshot (or delete the apply product when there was no champion); human approval again.
23. evolution_list: read the ledger with filters and history.

Graphs are created from New graph. Repository installs are done by the agent with bash (clone + build per repo docs), then `env_register_component`.

### Web APIs

none

### Service state

1. ctx.singularityAgent: tool registration host; root agents receive exactly the 21 tools listed above (ROOT_TOOLS allow-list)
2. ctx.hitl: the canvas answerer on the native interaction seams — hitl_ask asks through ctx.userQuestions, hitl_approve through ctx.approval (native audit events + fail-closed); ctx.hitl only bridges those waterfalls to the pending cards the canvas answers over GET/POST /singularity/hitl, removed on answer, cancellation or service disposal
3. ctx.evolution: the append-only evolution ledger (`proposals.jsonl` under `$DSH_HOME/evolution`) plus per-proposal sandboxes (`sandbox/<proposalId>/`) where evolution_prepare materializes a candidate's structured mutation and the champion snapshot, and where evolution_replay writes the candidate-vs-champion comparison report (`replay-report.json`) after running the candidate against the graph's terminal historical tasks; beyond ledger and sandbox, the only writes are evolution_apply / evolution_rollback promoting a PROMOTE-decided skill / agent_preset / capability into production (champion snapshot restored on rollback, apply product deleted when there was no champion) — each gated by its own native human approval, L4 and the bookkeeping-only types always refused; provided on the agent's own fiber, not by a child plugin, because the evolution_* tools read it through the context they were registered with
