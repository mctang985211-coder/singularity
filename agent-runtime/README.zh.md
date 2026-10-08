# dsh-singularity-agent-runtime

[English](README.md) | 中文

功能：在 graph 上管理 Singularity root 与 worker agent——组装其受限世界、发布成员、投递可追踪消息、恢复持久化 worker。

Package: `@dangosys/dsh-singularity-agent-runtime`

Dependencies: agents, agentDefaultModel, agentPresets, graph, layout, permissionPresets, sessions, sessionPersistence, sessionQuery

config.yaml: none

### Tools

none

### Web APIs

none

### Service state

1. ctx.agentRuntime: createRoot / ensureRoot / spawn / resumeWorkerAgent / prompt / stopAgents / stopGraph / ensureAgentMessageDelivered / readToolCallBody / reconcileAgentMessageDeliveries
2. 事件 `agentRuntime/spawned`：子节点发布后发出，携带 parentId + sessionId

## Design notes

**Root 组装。** `createRoot` 与 `resumeRoot` 通过同一个 `rootSetup`（`src/index.ts`）组装 root：挂载 preset、应用 `workspace-isolated` 权限预设（本轮气泡）、把会话审批策略钉为 `ask`，使 `hitl_approve` 一定能到达 answerer、注册 `singularity:root` 提示段（order 70）、限制工具面并安装两道封印。允许列表为核心工具加 `escalate`；九个 `evolution_*` 属于 supervisor，deployment 的开关只决定 root 的提示词文本。`sealRootTools` 用同一列表约束 root 本地注册；`sealRawSessionReads` 对本运行时拥有的每个 agent 在执行层拒绝四个原始跨会话读取工具，preset 或 MCP 合并都无法解除。每个 root/worker 组装按 graph store 串行；停止图时先排空已接纳的创建，再释放 agent。

**Worker 组装。** `spawn` 与 `resumeWorkerAgent` 共用 `workerSetup`（`src/index.ts`）：挂载 preset、应用解析出的权限预设、为 task worker 注册稳定的 `singularity:worker` 策略段（order 75，`interpolate: false`）、应用能力授权、安装原始会话封印。spawn 发布 `agent/add` 节点与 `spawn` 边、发出 `agentRuntime/spawned`、运行调用方的 `beforePrompt` 门，最后发送 kickoff——归属为 `runtime-prompt`/`spawn`，绝不记作人的输入。既无 prompt 又未声明 `taskWorker: true` 的 spawn 直接拒绝；回滚会释放 handle 并把已发布节点标记为 `failed`。

**消息投递。** 消息身份归 task store 所有，本包只负责投递。`relayMessage` 使用已记录的 `messageId`（绝不新造），来源是 `agent-message`/`relay` 而非 `user`。顺序为 reconcile → `agent.steer` → flush → confirm：只有在目标 `session/flush` 屏障之后回读其自身日志，才返回 `delivered`；折叠同时统计历史与 `agent/inbox/spliced` 重放，因此"已 claim 但未落历史"的消息会补投，而已 durable 记录的消息不会重复。目标没有存活 agent 时返回 `unavailable`，零副作用。

**Worker 恢复。** `resumeWorkerAgent`（`src/worker-resume.ts`）恢复同一个 Session、同一组装、同一授权与权限，并保持 idle。恢复前每个声明事实都要与持久记录核对——所有权、Session header 的 preset 与血缘同 graph 的 spawn 边、声明的能力面同 `TaskRun.capabilitySnapshot`、日志实际记录的权限——矛盾时以稳定错误码（`session-missing`、`session-unreadable`、`ownership-conflict`、`binding-mismatch`、`not-in-graph`、`member-facts-missing`、`takeover-refused`）拒绝，且不触碰任何存储。graph 节点的 `running` 状态只在全部检查通过后才修正为 `idle`。

**授权。** `applyWorkerGrant` 把 worker 继承的工具面限制为 capability ∪ baseline（`keepPresetTools` 时再加 preset 面），composition 未提供的 capability 工具直接失败关闭；把授权 skill 注册进 worker 自己的层（replay overlay 的额外根先注册且优先）；在限制之后挂载 MCP server，`failOnStartupError: true`。`RUN_CODE_NAME` 永不允许。

**提示词与 skill。** root 与 worker 提示文本位于 `src/prompts/`，注册为 system-prompt 段；worker 策略只写无条件规则，任何依赖任务或部署的内容由 context 包投影。`src/skill-file.ts` 是未挂载 skill discovery 时授权路径的兜底：从 worker cwd 向上搜索项目根、`$DSH_HOME/skills` 与 `~/.agents/skills`。
