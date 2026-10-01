# dsh-singularity-agent-runtime

[中文](README.zh.md) | English

Purpose: Own Singularity root and worker agents on the graph — compose their scoped world, publish members, deliver tracked messages, resume a persisted worker.

Package: `@dangosys/dsh-singularity-agent-runtime`

Dependencies: agents, agentDefaultModel, agentPresets, graph, layout, permissionPresets, sessions, sessionPersistence, sessionQuery

config.yaml: none

### Tools

none

### Web APIs

none

### Service state

1. ctx.agentRuntime: createRoot / ensureRoot / spawn / resumeWorkerAgent / prompt / stopAgents / stopGraph / ensureAgentMessageDelivered / readToolCallBody / reconcileAgentMessageDeliveries
2. event `agentRuntime/spawned`: emitted after a child is published; carries parentId + sessionId

## Design notes

**Root composition.** `createRoot` and `resumeRoot` assemble one root through the same `rootSetup` (`src/index.ts`): mount the preset, apply the `danger-full-access` permission preset, pin the session's approval policy to `ask` (the preset bundles `never`, which would auto-reject `hitl_approve`), register the `singularity:root` prompt section (order 70), restrict the tool surface, and install both seals. The allow-list is 21 core tools plus `escalate`, plus the nine `evolution_*` names iff `ctx.get('singularityEvolution')?.enabled` is true — a prompt never names a tool the surface does not carry. `sealRootTools` restricts root-local registrations to the same list, and `sealRawSessionReads` denies the four raw cross-session readers at execution for every agent this runtime owns, so a preset or MCP merge cannot lift the seal. Every root and worker composition is serialized per graph store; a graph stop drains admitted creation before releasing agents.

**Worker composition.** `spawn` and `resumeWorkerAgent` share one `workerSetup` (`src/index.ts`): mounted preset, the resolved permission preset, the stable `singularity:worker` policy section (order 75, `interpolate: false`) for task workers, the capability grant, and the raw-session seal. A spawn is published as an `agent/add` node plus a `spawn` edge, announces `agentRuntime/spawned`, then runs the caller's `beforePrompt` door and sends the kickoff — attributed to `runtime-prompt`/`spawn`, never to a person. A spawn that carries neither a prompt nor `taskWorker: true` is refused; a rollback disposes the handle and marks a published node `failed`.

**Message delivery.** The task store owns the message identity; this package relays it. `relayMessage` takes the recorded `messageId` (never mints one), and the source is `agent-message`/`relay`, not `user`. Delivery order is reconcile → `agent.steer` → flush → confirm: `delivered` is returned only after the target's `session/flush` barrier and a read-back of its own log, and the fold counts both history and the `agent/inbox/spliced` replay, so a claimed-but-unwritten message is re-delivered and a claimed-and-recorded one is not. A target with no live agent is `unavailable` with zero side effects.

**Worker resume.** `resumeWorkerAgent` (`src/worker-resume.ts`) resumes the same Session, same composition, same grant and permission, and leaves it idle. Before the resume every declared fact is checked against the durable record — ownership, the Session header's preset and lineage against the graph's spawn edge, the declared capability plane against `TaskRun.capabilitySnapshot`, the permission the log actually recorded — and a contradiction refuses with a stable code (`session-missing`, `session-unreadable`, `ownership-conflict`, `binding-mismatch`, `not-in-graph`, `member-facts-missing`, `takeover-refused`) without touching any store. The graph node's `running` status is repaired to `idle` only after all checks pass.

**Grants.** `applyWorkerGrant` restricts the worker's inherited tool surface to capability ∪ baseline (plus the preset plane when `keepPresetTools`), fails closed on a capability tool the composition does not offer, registers granted skills into the worker's own layer (the replay overlay's extra roots are registered first and win), and mounts granted MCP servers after the restriction with `failOnStartupError: true`. `RUN_CODE_NAME` is never allowed.

**Prompts and skills.** Root and worker prompt texts live in `src/prompts/` and are registered as system-prompt sections; the worker policy is unconditional, anything task- or deployment-dependent is the context package's projection. `src/skill-file.ts` is the grant-time fallback for compositions that mount no skill discovery: it searches project roots upward from the worker cwd, `$DSH_HOME/skills`, and `~/.agents/skills`.
