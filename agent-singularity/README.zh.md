# dsh-singularity-agent

[English](README.md) | 中文

Purpose（用途）: Singularity 根 agent 的工具面——委派、任务协同、评审、演化与人工决策——以及它自有的服务（HITL、升级账本、提案评审、评审账本）。

Package（包名）: `@dangosys/dsh-singularity-agent`

Dependencies（依赖）: graphs, agent-runtime, context, task, task-runtime, evolution

config.yaml: `evolution`（`off` | `on`，默认 `off`）——本组合是否在全局层注册九个 `evolution_*` 工具。`off` 只注册其余 24 个工具，任何 agent 面都调不到演化链；`on` 注册全部 33 个。本构建无法执行的取值、或本插件不读取的配置项，都会拒绝启动并点名。

### Tools

无论开关如何，始终注册 24 个工具；只有当 `evolution` 为 `on` 时额外注册九个演化工具。根 agent 的允许列表（agent-runtime 的 `ROOT_TOOLS`）列出这 24 个中去掉 `task_ask_parent`（根没有父任务）和 `task_recover`（受委派 supervisor 的专属入口）后的工具，再加上预设提供的 `skill` 加载器。

1. graph_spawn — 创建环境搭建阶段的 worker，并等待其最终回复；目标工作交给 task_decompose。
2. graph_mark_ready — 环境搭建完成后把调用者的图标记为就绪。
3. hitl_ask — 向人提出文本问题并等待回答。
4. hitl_approve — 请人批准/拒绝并等待；只有 `allowed-once` 放行，其余结果一律按拒绝处理。
5. task_read — 读取调用者的合同、任务与 run（根会看到子任务状态；合同被接受前返回具名的 not-activated 状态）。
6. capability_list — 打印能力表：每个工具标签的展开，以及每个已声明 skill 的 provider 判定。
7. context_read — 按引用读取调用者所在图域的一条记录（`task`、`run`、`evidence`、`review`、`diagnosis`、`session`），分页；没有任何参数可以扩大域。
8. task_intake — 仅根会话：提交根合同；运行时规范化并判定它，然后激活，或返回提案 id 等评审。
9. task_decompose — 提议/准入一批子任务，立即返回 batch id（当部署评审生成任务时返回提案 id）。
10. task_submit_result — 交回已完成的 run（摘要 + 证据）；运行时关闭写入准入、排空在途调用并把 run 交给 verifier。
11. task_ask_parent — 向调用者自己的直接父任务提问；`blocking`（默认 true）会阻塞该 run，直到收到 `resolves: true` 的回答。
12. task_answer — 回答某个子任务的问题（`questionId`、`requestKey`、`answer`、`resolves`）；`resolves: true` 只解除该问题造成的阻塞。
13. task_cancel — 取消调用者自己仍在途的子批次。
14. task_proposal_read — 读取一个已保存提案：状态、策略、完整批次、摘要指纹与已记录的决策。
15. task_proposal_continue — 重新校验并准入本会话提交的提案；仍在等待的提案如实报告为等待。
16. task_proposal_cancel — 在其批次被准入前撤回本会话提交的提案。
17. task_status — 分页的项目状态：调用者自身任务、直接子任务与依赖邻居，或整张图。
18. task_verify — worker 自检：重跑 verifier 并记录证据；不改变任务状态。
19. task_review_pack — 针对一个确切评审来源的只读证据包，并标注每条带建议 Diagnosis 的 A6 交接状态。
20. task_review_agent — 为一个来源启动一次只读评审尝试；评审 agent 记录自己的 Diagnosis（观察、结论、置信度，可选 judgements 与 proposals）。
21. task_diagnose — 持久化一条 Diagnosis（复盘观察、范围、定位原因、置信度，可选建议）；建议永不自动执行。
22. task_budget_extend — 请人提高一个已配置的根运行上限；记录一条预算扩展事实，同一 key 的重试直接从记录作答。
23. task_recover — 受委派 supervisor 的入口：为一条已记录 Diagnosis 开启某个失败根目标的新尝试；永不出现在根的工具面。
24. evolution_propose — 登记一条演化提案（可从 Diagnosis 转录）。
25. evolution_candidate — 记录候选的版本集与其唯一的结构化变更。
26. evolution_prepare — 把变更物化进提案沙箱，并生成 champion 快照。
27. evolution_replay — 运行双边实验（baseline 对 candidate）并写下对比报告。
28. evolution_gate — 记录六项 gate 答案；回归证据引用必须存在。
29. evolution_decide — 在原生人工批准后记录 PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH。
30. evolution_apply — 把已决定 PROMOTE 的变更（同名 skill 对象，或一行 capability 及其可选新 skill）应用进生产；第二次人工批准，并列出每个生产路径。
31. evolution_rollback — 在人工批准后恢复 champion 快照（或移除 apply 产物）。
32. evolution_list — 按状态过滤并读取演化账本与历史。
33. escalate — 上报 L4 卡片（能力缺口、预算耗尽、UNKNOWN(verifier)）；先经批准通道展示，仅在明确批准后写入升级账本。

### Web APIs

none — HITL 卡片由 graph-web 提供（`GET/POST /singularity/hitl`），graph-web 挂载本插件以获得 `ctx.hitl`。

### Service state

1. ctx.singularityAgent：工具注册宿主（始终 24 个；`evolution: on` 时 33 个）；根允许列表是 agent-runtime 的 ROOT_TOOLS。
2. ctx.hitl：位于 `ctx.userQuestions` / `ctx.approval` 之上的画布应答者；待决卡片经 graph-web 列出并回答。
3. ctx.proposalReviewChannel：T2/T3 评审通道——渲染已保存的主题，通过批准通道向 store 属主会话提问，并以 `approval:<owner session>` 记录决策。
4. ctx.escalation：追加式升级账本 `$DSH_HOME/escalations.jsonl`（未设置 `DSH_HOME` 时为 `<repoRoot>/.dsh`）；可用 `root` 配置覆盖。
5. ctx.singularityEvolution：`{ enabled }`——本组合实际解析出的开关，供同类 assembly 读取以保持工具面同步。
6. ctx.evolution：演化账本（`$DSH_HOME/evolution/proposals.jsonl`）与各提案沙箱；无论开关如何都会构造，链路关闭时不可达。
7. 评审账本：`$DSH_HOME/review-agents/agents.jsonl`（可用 `SINGULARITY_REVIEW_LEDGER_DIR` 覆盖路径，`SINGULARITY_REVIEW_AGENT_BUDGET` 覆盖上限）——reviewer 与 supervisor 两种角色共用的追加式 claim/started/settled 行。

## Design notes

- 目录布局：`src/index.ts` 是装配点。`src/services/` 放已挂载的服务（hitl、escalation、proposal-review 及其渲染）；`src/coordination/` 放评审账本、单次评审尝试、自动扫描、A6 交接规则与身份辅助；`src/tools/` 放 33 个 `define*Tool` 入口与 `shared.ts`。重构前的顶层路径保留为薄转发，因为测试与 support fixture 会按这些路径导入。
- `tools/shared.ts` 收拢每个工具原先复制粘贴的辅助函数：`text()`、`sessionId(exec, tool)`、`message()`、`undeclaredParameters()`、`denialReason()` / `approvalAnswer()`、`adaptRead()`、`proposalStoreFor()`、`questionCall()`。每个辅助函数全包只有一份实现。
- 人工闸门只读原生结果词表，不接受参数伪装：只有 `allowed-once` 才允许记录决策、apply 或升级；`rejected` / `cancelled` / `unavailable` 都会具名报告且不写任何东西。
- 评审账本是协同尝试唯一的持久记录。`admitReviewAgent` 在按（账本文件, 根 store）划分的串行区内做决定，先写 claim 再创建 reviewer，并把 `started` 行计为已花费的运行；无人持有的开放行会被回收为 `interrupted`（若 store 已持有其 diagnosis 则为 `recorded`）。已 started 的 supervisor 行就是交接的终态事实，永不被回收。
- 交接决策是纯粹函数（`handoff-rules.ts`）：由部署开关、diagnosis、账本尝试与配额决定，具名停止（`no-suggestions`、`evolution-off`、`unsupported-target`、`requires-new-authority`、`budget-exhausted`、`handoff-conflict`）让 diagnosis 保持可读且待处理。supervisor 从不决定或应用升级——由人来做。
- 拒绝是返回值而非静默丢弃：未声明参数、未知 store、未知记录与冲突账本行都以具名原因拒绝，模型或操作者可以据此行动。
- 重构前的长文设计说明保留在 `packages/singularity/docs/`（singularity-harness-guide.md、exploration-evolution-architecture.md、agent-prompt-contracts.md）。
