---
name: task-coordination
description: Coordinate a complete Task objective through independent child results, evidence, acceptance, and parent questions. Use when a root or intermediate Task owns a result that requires coordinating other Tasks.
---

# Task coordination

Keep the complete objective and original acceptance. Before implementation, identify independently checkable results or distinct responsibilities another Task can own. Delegate those results and judge how their verified evidence combines. Complete a local result directly; several tool calls do not by themselves justify several Tasks. An atomic leaf takes explicit inputs and delivers one independently checkable result within its capabilities and budget.

## Establish the contract

Normalize clear requests and state assumptions. An assumption is not an answer: it must never settle a condition the user did not confirm. When missing information changes objective, scope or acceptance, ask the user before root intake; a checkout cannot answer for the user. Include only requirements supported by their words and answers.

Read the Task template catalog summaries already presented in context. The root uses task_template_list with catalogPath to inspect relevant branches and fixes its chosen prefixes in intake templateScope. Children inherit that scope or narrow it; general templates remain available. Read a fitting template in full with task_template_list and its exact templateRef, then bind the reference and parameters. Otherwise author a complete standard contract. A template decomposition recipe is invoked with task_decompose templateRef/templateParameters and expands only direct children and their dependsOn edges; each child owns its own descendants. Keep each objective self-contained, declare relevant capability requirements, and select at least one real Skill that guides that work. A capability name is an execution requirement, never a substitute for a Skill name. Do not attach this coordination Skill to a purely local task just to satisfy the guidance requirement; choose instructions for that result.

Every contract needs concrete result acceptance. At least one mandatory root criterion must judge the delivered result beyond the conjunction of children. Use an authoritative checker where it covers the result; retain separate criteria for separate requirements. Give deterministic criteria exact commands and known artifact paths. Do not make a mandatory criterion depend on a review that may never happen. Protected acceptance inputs remain unchanged.

Before root intake activates a contract there is no root Task. Follow the intake or decomposition result for any pending proposal. Read its recorded contract with task_proposal_read and revise a refusal against the stated reason. Do not resubmit identical content while review is pending.

Environment setup belongs to graph_spawn and graph_mark_ready, before the user's task tree. After root activation, delegate objective work, including engineering investigation, through task_decompose. The root itself coordinates and does not inspect repositories, edit files, run commands or use generic subagents.

## Delegate and integrate results

Define only children at your own level. A subsystem with separate results or responsibilities belongs to a child that can coordinate and decompose it. Give that child result boundaries and mark it decomposable; let it choose its descendants. Use dependsOn only where a child consumes a sibling's verified result. Do not prescribe depth, fixed stages, or descendants merely to enlarge the graph.

Decomposition returns at admission, before children finish. One unfinished batch is allowed at a time. After handling pending questions, end your current turn; the batch-end message resumes you. Repeated polling does not advance child execution. While waiting_children, read, query, diagnose and answer children; do not implement shared work, decompose again or submit. At batch end, inspect each child's terminal result and evidence, assess them against your own acceptance, then delegate remaining independent work or submit your result with task_submit_result. Nothing is submitted on your behalf. Only the verifier marks a Task verified; task_verify is a self-check.

An undecidable local contract or scope question goes to the direct parent through task_ask_parent, after reading task_read, task_status and context_read. State what is known and the specific missing decision. Answer a child's recorded question promptly with task_answer, evidence, and resolves:true only when settled. Questions alter no contract or permissions.

Going idle is not submission. Submit the delivered result and evidence, or report the concrete failure. task_cancel abandons your own Run and its in-flight batch; it is not a way to obtain another coordination turn.

## Review and improve the reusable method

Read settled evidence with task_review_pack and record explanations with task_diagnose. Diagnoses do not execute repairs. Read existing review attempts before requesting another independent review. A stopped tree remains reviewable on the reviewer's own allowance. Continuing exhausted work requires a human budget decision through task_budget_extend; raising a whole-total ceiling neither reopens a Task nor starts a Run.

For an evidenced shared gap, improve the Task definition or Skill method first. A capability or MCP change is appropriate when the granted execution means are missing. Use only evolution tools your current role actually exposes. Freeze candidate inputs and compare baseline and candidate under the original independent acceptance before requesting human decide/apply. Preserve Skill roles, verifiers, permissions and presets. For a verified source, tool-call-reduction must reduce the complete executed Run subtree on observed cases without increasing holdouts. Unknown cost proves no improvement. A change to direct child goals or dependencies belongs in a published TaskTemplate.decomposition recipe; replay must actually consume that candidate recipe under the original parent oracle. Apply before replanning: the root opens a new attempt or the responsible parent submits a new batch that consumes the applied definition. Existing admitted or verified Tasks and Runs remain fixed.

Escalate an unavailable capability, exhausted budget or UNKNOWN verifier verdict with what is missing, what was tried and the proposed next decision.
