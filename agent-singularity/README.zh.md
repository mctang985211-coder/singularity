# dsh-singularity-agent

[English](README.md) | 中文

Purpose（用途）: Singularity 根 agent 的工具面——委派、任务协同、评审、方法搜索与人工决策——以及它自有的服务（HITL、升级账本、提案评审、协同驱动器）。

Package（包名）: `@dangosys/dsh-singularity-agent`

Dependencies（依赖）: graphs, agent-runtime, context, task, task-runtime, evolution

config.yaml: `methodTools`（`off` | `on`，默认 `on`——六个 `method_*` 工具是方法变更的唯一途径）——本组合是否在全局层注册六个 `method_*` 工具；`off` 一个不注册，任何模型面（root 或授权 worker）都不能读、起草或发布方法。`supervision.coordinationBudget` 设定一个 store 的协同代理可用的额度。本构建无法执行的取值、或本插件不读取的配置项，都会拒绝启动并点名。

旧的 `evolution` 开关与九个 `evolution_*` 工具已不存在：新协议图上的方法搜索走 `method_draft` → `method_evaluate` → `method_publish` / `method_discard` / `method_rollback`，由会话自己的完成工具（`supervisor_complete` / `reviewer_complete`）明确结案，轮次由唯一的协同 driver 驱动。没有协议标记的图是封存历史，只读服务。主路径见[工作区 README](../README.md)，v5 方法账本与 RRSI 策略见 [evolution 平面 README](../evolution/README.md)。

### Tools

无论开关如何，始终注册 27 个工具；只有当 `methodTools` 为 `on` 时额外注册六个方法工具（此时共 33 个）。根 agent 的允许列表（agent-runtime 的 `ROOT_CORE_TOOLS` + `escalate`）列出这 27 个中去掉协同专用完成工具与 `task_ask_parent`（根没有父任务）后的工具，加上预设提供的 `skill` 加载器，以及（方法工具已注册时）`method_list` 与 `method_draft`——根可以观察和提案，永远不能发布。

1. graph_spawn — 仅 root 可调用，以受限 setup grant 创建环境搭建阶段的 worker，并等待其最终回复；目标工作交给 task_decompose。
2. graph_mark_ready — 仅 root 可调用，环境搭建完成后把调用者的图标记为就绪。
3. hitl_ask — 向人提出文本问题并等待回答。
4. hitl_approve — 请人批准/拒绝并等待；只有 `allowed-once` 放行，其余结果一律按拒绝处理。
5. task_read — 读取调用者的合同、任务与 run（根会看到子任务状态；合同被接受前返回具名的 not-activated 状态）。
6. capability_list — 打印能力表：每个工具标签的展开，以及每个已声明 skill 的 provider 判定。
7. task_library — 读取本图的 TaskTemplate 与 Skill 库；对任何角色都只读——方法变更只能走 draft，绝不就地编辑库。
8. task_template_list — 读取完整的 TaskTemplate 合同；经 `requiredCapabilities` 以 `method:<skill-name>` 绑定方法。
9. context_read — 按引用读取调用者所在图域的一条记录（`task`、`run`、`evidence`、`review`、`diagnosis`、`session`），分页；没有任何参数可以扩大域。
10. task_intake — 仅根会话：提交根合同；运行时规范化并判定它，然后激活，或返回提案 id 等评审。
11. task_decompose — 提议/准入一批子任务，立即返回 batch id（当部署评审生成任务时返回提案 id）。
12. task_submit_result — 交回已完成的 run（摘要 + 证据）；运行时关闭写入准入、排空在途调用并把 run 交给 verifier。
13. task_ask_parent — 向调用者自己的直接父任务提问；`blocking`（默认 true）会阻塞该 run，直到收到 `resolves: true` 的回答。
14. task_answer — 回答某个子任务的问题（`questionId`、`requestKey`、`answer`、`resolves`）；`resolves: true` 只解除该问题造成的阻塞。
15. task_cancel — 取消调用者自己仍在途的子批次。
16. task_proposal_read — 读取一个已保存提案：状态、策略、完整批次、摘要指纹与已记录的决策。
17. task_proposal_continue — 重新校验并准入本会话提交的提案；仍在等待的提案如实报告为等待。
18. task_proposal_cancel — 在其批次被准入前撤回本会话提交的提案。
19. task_status — 分页的项目状态：调用者自身任务、直接子任务与依赖邻居，或整张图。
20. task_verify — worker 自检：重跑 verifier 并记录证据；不改变任务状态。
21. task_review_pack — 针对一个确切评审来源的只读证据包，并标注每条诊断的协同尝试记录。
22. task_review_agent — 为一个来源启动一次只读评审会话；评审 agent 通过调用 `reviewer_complete` 记录自己的 Diagnosis（观察、结论、置信度，可选 judgements 与 proposals）。
23. supervisor_complete — 结束本会话被指派的本轮：`businessAction`（continue | recover | finish）、`reason`、`evidenceRefs`，可选 `trialCandidateRef`。其余由平台派生，调用即关闭该会话的写权限。
24. reviewer_complete — 结束本次评审：`observation`、`conclusion`、`confidence`，可选 scope、refs、judgements 与 proposals；写入 Diagnosis 并关闭该会话的写权限。
25. task_diagnose — 持久化一条 Diagnosis（复盘观察、范围、定位原因、置信度，可选建议）；建议永不自动执行。
26. task_budget_extend — 请人提高一个已配置的根运行上限；记录一条预算扩展事实，同一 key 的重试直接从记录作答。
27. escalate — 上报 L4 卡片（能力缺口、预算耗尽、UNKNOWN(verifier)）；先经批准通道展示，仅在明确批准后写入升级账本。
28. method_list — 读取本库的方法状态：生效版本与指针、每个 draft 的状态与最近判定、哪些 Run 正在显式试用哪个候选，以及紧凑的否证历史。
29. method_draft — 提议一个候选方法：一种资产类别（Skill、capability 或 TaskTemplate）、其稳定身份、完整新内容、所回答的证据与被检验的独立机制；基线版本必须是当前生效版本，冻结的编辑预算生效。
30. method_evaluate — 经唯一评估管线测量一个 draft：冻结的 cohort（每个样本的双侧及其原始验收）、冻结的 [0,1] 质量标尺、目标与预算；写出唯一 `EvaluationReport` 与策略决策记录。
31. method_publish — 把一个已评估候选发布为本库的生效版本：预期生效版本与代次是审批所展示的 compare-and-swap 对；指针被他人移动过则拒绝调用。
32. method_discard — 以具名结果（measured-rejected 或 unmeasured-declined）弃置一个候选并删除其工作目录；无需审批，生效版本不动。
33. method_rollback — 恢复本库此前发布过的某个版本，经同一指针事务与一次展示反向切换的审批。

### Web APIs

none — HITL 卡片由 graph-web 提供（`GET/POST /singularity/hitl`），graph-web 挂载本插件以获得 `ctx.hitl`。

### Service state

1. ctx.singularityAgent：工具注册宿主（始终 27 个；`methodTools: on` 时 33 个）；根允许列表是 agent-runtime 的 `ROOT_CORE_TOOLS` + `escalate`（方法工具开启时再加 `method_list`/`method_draft`）。
2. ctx.hitl：位于 `ctx.userQuestions` / `ctx.approval` 之上的画布应答者；待决卡片经 graph-web 列出并回答。
3. ctx.proposalReviewChannel：T2/T3 评审通道——渲染已保存的主题，通过批准通道向 store 属主会话提问，并以 `approval:<owner session>` 记录决策。
4. ctx.escalation：追加式升级账本 `$DSH_HOME/escalations.jsonl`（未设置 `DSH_HOME` 时为 `<repoRoot>/.dsh`）；可用 `root` 配置覆盖。
5. ctx.singularityMethods：`{ enabled }`——本组合实际解析出的方法工具开关，供 agent-runtime 读取以保持根允许列表与提示词同步。
6. ctx.singularitySupervision：本组合解析出的监督策略——协同额度，以及 task-runtime 恢复入口读取的每 store 轮数上限（`maxImprovementRoundsFor` / `maxRecoveryRoundsFor`）。
7. ctx.evolution：旧 v4 演化账本（`$DSH_HOME/evolution/proposals.jsonl`），只读挂载，使封存的旧图保留其历史投影；不再有任何模型工具写它。其未结 commit intent 由 task-runtime 的激活屏障对账，本插件不结算；账本不可读时本插件按名拒绝启动。当前方法账本是各库的 `<root>/methods.jsonl`（`formatVersion: 5`），归 evolution 平面所有。
8. 协同存储：`$DSH_HOME/coordination/assignments.jsonl`（可用 `SINGULARITY_COORDINATION_DIR` 覆盖目录，`SINGULARITY_COORDINATION_BUDGET` 覆盖每 store 上限）——追加式文件只有两种行：`assignment`（spawn 之前写入并 fsync）与 `completion`（工作项结束时由会话自己的完成工具或平台写入）。旧 `$DSH_HOME/review-agents/agents.jsonl` 与旧变量名 `SINGULARITY_REVIEW_LEDGER_DIR` / `SINGULARITY_REVIEW_AGENT_BUDGET` 完全不再读取；driver 在启动日志里打印真正生效的目录。

本组合还以非服务形式接线图级机制：注册到 context 视图服务上的协同绑定源与协同/方法事实读取器、逐图协同 driver（唯一开轮处），以及 task-runtime 询问的根预算审批回调。

## Design notes

- 目录布局：`src/index.ts` 是装配点。`src/services/` 放已挂载的服务（hitl、escalation、proposal-review 及其渲染）；`src/coordination/` 放协同存储、纯 assignment 计划与 reducer、逐图 driver、完成负载、监督提示、事实读取器与身份辅助；`src/tools/` 放 `define*Tool` 入口——六个 `method_*` 工具及其共享平面（`method-shared.ts`）与渲染（`method-render.ts`）、`completion-tools.ts` 的 `supervisor_complete` 与 `reviewer_complete`，以及 task/HITL 工具面；`src/shared.ts` 收拢共用辅助。重构前的顶层模块路径已不存在，消费者直接导入负责模块。
- `src/shared.ts` 收拢工具共用的辅助函数：`text()`、`sessionId(exec, tool)`、`message()`、`undeclaredParameters()`、`denialReason()` / `approvalAnswer()`、`adaptRead()`、`proposalStoreFor()`、`questionCall()`。每个辅助函数全包只有一份实现。
- 人工闸门只读原生结果词表，不接受参数伪装：只有 `allowed-once` 才允许记录决策、发布或升级；`rejected` / `cancelled` / `unavailable` 都会具名报告且不写任何东西。
- 协同存储是协同工作唯一的持久记录。`assignment` 在图自己的串行区内写入并落盘（flush）之后才 spawn，spawn 的门会在任何模型输入之前回读它；一个 assignment 只由一条 `completion` 结案，重复调用完成工具按既有记录应答。会话是否存在、turn 是否收尾、额度是否已花，全部来自 DSH 自身（`ctx.agents`、`ctx.sessionPersistence`、`ctx.sessionQuery`），不再保存第二份事实。唯一的 driver 取事实、纯 reducer 决策一次、执行一步：事件唤醒 + 两秒兜底，且从不 await 监督会话；turn 结束却没有调用完成工具的会话被记为协议失败且不再催问（要重来只能显式提升 `rsi.epoch`）。
- `supervisor_complete` / `reviewer_complete` 的图、源 Run、角色与权限全部取自该会话的 assignment，方法决定、审批来源与搜索步由本轮真实记录派生——这些都没有参数可传。调用即关闭该会话的写权限（组合在 spawn 与 resume 两条路径上都安装执行期 guard），读、证据与发现仍可用。
- 六个 `method_*` 工具是三个平面（`method-shared.ts`）上的薄适配：环境平面（task-runtime 的版本/草稿/指针服务）、方法账本平面（evolution 包的 v5 管线）与策略平面（RRSI 决策记录）。它们先读图的协议标记：封存的旧图被具名回答，这个面不写入它。发布与回滚只经 task-runtime 的 CAS 事务（`expected.revisionId` + `expected.generation`）移动一个指针；账本的 `published`/`rolledback` 记录只在事务成功后写入。
- 拒绝是返回值而非静默丢弃：未声明参数、未知 store、未知记录与冲突账本行都以具名原因拒绝，模型或操作者可以据此行动。
- 重构前的长文设计说明保留在 `packages/singularity/docs/`（singularity-harness-guide.md、exploration-evolution-architecture.md、agent-prompt-contracts.md）。
