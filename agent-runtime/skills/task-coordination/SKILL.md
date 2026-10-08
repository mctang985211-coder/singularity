---
name: task-coordination
description: Turn a task and metrics into verifiable results, useful child tasks and reusable methods in the graph library. Applies across domains.
---

# Task coordination

Start with the user's task and metrics. Read the available environment and graph library with task_library, capability_list and task_template_list. Investigate useful unknowns, state measurement assumptions and decide ordinary engineering choices from evidence. Ask for user decisions that materially change the objective or authority. An exploratory Task may deliver facts, measurements or a promising next goal.

Each Task defines this execution's result, inputs, acceptance and capabilities. Choose a few checks that observe its result, reusing available tools or adding a small task-specific check when needed. Commands start at the Run workspace root and use workspace-relative paths and the Task's explicit inputs so independent replay can reuse them. Select the small input set needed for a comparison with snapshot.paths; snapshot.rebaseFrom relocates declared paths in existing absolute contracts. At least one mandatory root criterion checks the combined delivery. Preserve authoritative checks, protected inputs and resource limits.

Read a fitting template's full contract and conditions, then bind its exact reference and parameters. Otherwise author the contract this task needs. A TaskTemplate records reusable goals and optional direct-child decomposition; a Skill records methods, paths, conditions and experience. The graph library is their shared home. Useful exploratory or decomposable goals can become temporary templates, and useful experience can become Skills, with Task/Run and evidence references.

Define useful direct children with owned results, inputs, checks and capabilities; they choose their descendants. Parallelize independent work with distinct ownership and real dependsOn edges. One unfinished batch at a time: answer questions, yield for its end, read results and integrate artifacts. Choose the next action from evidence. Ask task_ask_parent for decisions beyond your authority, answer with task_answer, and submit with task_submit_result. task_verify provides a useful self-check; submission performs independent acceptance. Reuse unchanged evidence and use task_budget_extend for an authorized budget change.

During RSI, the supervisor reviews the actual tree and library, decides what to retain or modify, and compares promising TaskTemplate or Skill candidates through Evolution. Acceptance judges each task execution; reusable paths and experience guide future tasks. An LLM can supply a frozen llm-outcome measurement plan. Compare real executions under comparable budgets, report seen cases as regression evidence and test fresh tasks for transfer when available. Inspect later exact template and Skill bindings. Weigh task effects together with recorded tokens, cache traffic, tool work and model cost; mark unavailable readings unknown. Retain useful negative results and applicability conditions, and stop when the evidence or budget warrants it.
