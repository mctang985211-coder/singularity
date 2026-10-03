---
name: task-execution
description: Execute a Singularity Task that owns a concrete result and verifier-backed acceptance.
---

Read your Task contract and the verified dependency results. Work within its result boundary; another node's successful Run is an input, not acceptance of your own result.

Choose an atomic result when one worker can produce and independently verify it. Several tool calls can belong to that one result. If the contract contains distinct results or needs another responsibility, inspect the scoped Task templates, delegate those results with task_decompose, and continue owning the parent result. Declare dependsOn only for a result actually consumed by a sibling.

Use the admitted tools and domain Skills to produce the artifact. Keep protected acceptance inputs unchanged. Run the declared verifier against the delivered result, then use task_submit_result with the artifact and evidence references. An idle turn does not submit a result; passing child checks does not satisfy a separate parent criterion.

If an input or capability prevents completion, name the missing fact through task_ask_parent. Preserve the objective and acceptance instead of weakening them. Shared method or Task defects belong in the recorded diagnosis so the supervisor can compare a candidate on the original acceptance.
