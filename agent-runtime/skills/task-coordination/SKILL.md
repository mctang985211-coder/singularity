---
name: task-coordination
description: Coordinate a complete Task objective through independent child results, evidence, acceptance, and parent questions. Use when a root or intermediate Task owns a result that requires coordinating other Tasks.
---

# Task coordination

Own the objective and original acceptance. Investigate consequential unknowns, delegate verifiable results, integrate accepted artifacts and author the next contracts. Implement local results when authorized. Evidence chooses the next useful action, without fixed-depth trees or an investigation for every decision.

## Establish the contract

Normalize requests and state assumptions. An assumption is not an answer: ask for unresolved user decisions that change objective, scope or acceptance; decide ordinary engineering choices from facts.

Consult capability_list and relevant task_template_list branches for intake templateScope; children inherit or narrow it. Read a template's appliesTo conditions and full contract before binding its exact reference and parameters. When no template fits, author a complete one-off contract and proceed; do not create or publish a shared template just to admit the Task. Give direct children clear result ownership, inputs, acceptance, capabilities and guidance Skills. Capability names are not Skill names.

A Task is an instance with a goal, explicit inputs, result ownership, acceptance and required capabilities. A TaskTemplate is a parameterized reusable contract, optionally carrying a direct-child decomposition recipe. A Skill teaches how to investigate, execute, decompose and check under stated applicability conditions; it does not replace the Task's acceptance. A parent is a worker coordinating its own result, not another agent role. An atomic leaf takes explicit inputs, produces its owned result and submits to independent acceptance.

Use a few command criteria and existing authoritative checkers for ordinary Tasks. Commands start from the current Run workspace root and read the Task's explicit case/delivery manifest; never glob across siblings for evidence. At least one mandatory root criterion checks the delivered result beyond child PASS. Children check their own results; parents aggregate under separate acceptance. Template mappings refer only to this Task's own children, never siblings. Artifact paths are not Evidence IDs. Preserve correctness, resource limits and protected inputs.

Intake is complete and atomic, never a placeholder. Follow pending proposal results via task_proposal_read instead of repeating them. Setup belongs to graph_spawn/graph_mark_ready; root executes repository work through real Tasks and owns synthesis and contracts.

## Delegate and integrate

Resolve approach-changing unknowns through bounded distinguishing investigations, delegating independently useful evidence results. Define direct children only and let substantial children choose descendants. Parallelize independent work, with distinct file ownership in shared workspaces and dependsOn only for consumed sibling results.

One unfinished batch is allowed at a time. Answer pending questions, then yield for batch end rather than poll. Read outcomes and failures, directly integrate accepted artifacts, and decide on local work, another batch or submission. Independent-comparison clean inputs do not prohibit ordinary child integration. Ask task_ask_parent only for decisions beyond your authority; answer children with task_answer and resolves:true when settled. Submit through task_submit_result; task_verify is an optional self-check and idle is not submission.

## Accumulate reusable methods

Skill advice is a falsifiable hypothesis with applicability conditions: retain failures and checks without forbidding a whole approach. Preserve reusable findings from executed contracts and batches in task_submit_result summaries or artifacts with exact Task/Run, batch and evidence references. Repeated contracts, or a contract defect corrected and validated in a later instance, can justify a parameterized TaskTemplate or Skill candidate. A one-off contract needs no publication. Store reusable contracts/methods, never optimized RTL answers.

The authorized Supervisor consolidates findings from the actual task tree and its recorded diagnoses, using task_review_pack and context_read. A justified template candidate uses the existing Evolution task_definition chain; method advice uses Skill. Draft review and business acceptance are separate: the external verifier judges each Task, while the supervisor compares the reusable candidate under unchanged original acceptance and publication policy. Advance through real comparison, gate and apply, then inspect whether later Tasks bind the exact catalog templateRef/parameters or published Skill.

Choose llm-outcome for quality/performance or tool-call-reduction for overhead; an LLM may supply a frozen plan, while real Tools establish outcomes under unchanged acceptance. Use comparable model budgets and independent holdouts unused in forming the candidate. A previously inspected or used case is regression evidence, not a clean holdout; validate transfer on unseen tasks when available and report it as unverified otherwise. Check performance and recorded model cost; deterministic artifact rechecks are not independent solves. Recipe comparison must exercise the actual direct-child decomposition under its original parent oracle. Extract reusable decision conditions from successive batches; do not turn the entire observed task history into a mandatory fixed workflow tree.

Reuse enough evidence to decide. Inspect later bindings and results, using counterexamples for another justified candidate within budget; proposals and publication alone establish no gain. Existing admitted or verified Tasks and Runs remain fixed. Stop honestly when no reasonable action or allowance remains. Missing capabilities or UNKNOWN verdicts need concrete reasons; exhausted work requires the recorded budget decision through task_budget_extend.
