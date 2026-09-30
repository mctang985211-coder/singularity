# dsh-singularity-agent

[English](README.md) | 中文

功能：Singularity 图内 worker 派发、就绪标记与可取消的人工交互工具。

包名：`@dangosys/dsh-singularity-agent`

依赖：graphs, tools

依赖的config.yaml配置：`evolution`（`off` | `on`，默认 `off`）——本组合是否把九个 `evolution_*` 工具注册到全局层。关闭（出厂默认，`DEFAULT_EVOLUTION`）时只注册下面另外 23 个，进化链一个都不注册：任何 agent 面都调不到，包括无 grant 的 spawn worker（它否则会保留全局层）。开启时注册全部 32 个，进化链的校验、人审、历史读取与回滚语义不变。本构建不实现的值、或它不读取的配置字段，构造期具名拒启。

### 可调用Tools

33 个里始终注册在全局层的是 24 个；九个 `evolution_*` 只在 `evolution: on` 时注册。默认部署的全局层携带这 24 个（即下面整份清单去掉 24–32 号），显式开启的部署携带全部 33 个。root agent 的 allow-list（`@dangosys/dsh-singularity-agent-runtime` 的 ROOT_TOOLS）就是这 24 个去掉 `task_ask_parent`（root 没有可问的父任务）与 `task_recover`（A6：唯一调用者是交接委派出的 supervisor）外加挂载 preset 提供的 `skill` 加载器，并从 `ctx.singularityEvolution` 读取这九个是否真实存在——root 面与这份清单漂移正是该开关要防的事。

1. graph_spawn：通过 Singularity runtime 创建 worker 节点并等待其回复。
2. graph_mark_ready：将调用 agent 所属的图标记为就绪。
3. hitl_ask：等待人工文本回答，随工具执行取消。
4. hitl_approve：等待明确的 approve/reject 决定，随工具执行取消。
5. task_read：读取调用者的任务契约（root 另可见子任务状态）；根契约尚未接受时返回具名的「尚未激活」视图与当前开放提案。
6. capability_list：打印生效的能力表——合法能力名及每个工具标签展开后的真实工具名。
7. context_read：按引用读取调用者自己图域内的一条记录——`task`、`run`、`evidence`、`review`、`diagnosis`，或一段 `session` 日志/单个事件（按 seq 或字节偏移分页）。没有任何参数能扩大这个域（别的图的引用是具名拒绝），它取代的原始跨会话读取工具在所有 runtime 拥有的 agent 上被封死。
8. task_intake：接受本 root session 的根契约——用户目标及其验收判据、假设、约束与声明能力；runtime 负责规范化与准入判定，把它激活为本图的根任务，或在部署开启人审时返回 proposalId 且什么都不激活。只有 root session 可调；没有任何参数能批准任何东西。
9. task_decompose：准入一批子任务并立即返回 batchId（reason + 子任务清单：objective / acceptance criteria / dependsOn / decomposable）；runtime 按依赖串行推进，调用方可继续工作。部署开启生成任务人审时，该调用改为返回 proposalId 且什么都不准入——批次等待已落账的决定。
10. task_submit_result：提交已完成的 run——摘要加证据引用；runtime 先关闭写入准入、排空在途写，再由 verifier 判定。
11. task_ask_parent：向调用者自己的直属父任务提一个问题（`requestKey`、`question`、可选 `blocking`）。收件人由调用者的 run 决定——没有收件人参数，正文也从这次调用自身读回。`blocking` 默认 `true`：在一条 `resolves: true` 的回答落账前，写入、shell 命令、再分解与 `task_submit_result` 都被拒绝，回答随后以消息和上下文到达调用方；`false` 则问题挂起期间该 run 照常工作。root、reviewer 与无父节点的 replay 任务被具名拒绝，既不产生问题也不产生投递。
12. task_answer：按 id 回答某个子任务的问题（`questionId`、`requestKey`、`answer`、`resolves`）。`resolves: true` 声明该问题已解决，并只解除提问 run 上那一条阻塞（`resolves: false` 保持开放、什么都不解除）；它不改变契约、权限或任务状态，框架也不为回答内容背书。问题必须是发给调用者自己 run 的——发给别的 run 的问题会被拒。
13. task_cancel：取消调用者自己派发的在途批次；子任务结算为 cancelled。
14. task_proposal_read：按 id 读取已保存的提案——状态与策略、完整批次内容、摘要、两个上下文指纹、已落账决定及它变成的批次。只读，且没有任何参数能声称某种状态。
15. task_proposal_continue：继续本会话提交过的提案——runtime 重检（父任务状态、限额、能力解析、裁判 verifier）后，仍合格且有批准才准入；仍在待审的提案如实报告为待审，仅凭本调用绝不推进任何东西。
16. task_proposal_cancel：在批次准入前撤回本会话提交过的提案；只有提交它的会话可以，且记录保留。
17. task_status：打印任务树，带 run / 相位 / 证据 / review / diagnosis 摘要。
18. task_verify：worker 自检——重跑 verifier、记录证据，绝不改变任务状态。
19. task_review_pack：面向一个精确 review 源（taskId + 待复盘的 run，或 runId=null 表示无 Run 的 Review）的只读证据包：本任务 reviews 全文、父/子摘要、依赖边、该源在 ledger 中的复盘尝试；每条带建议的 Diagnosis 标注其 A6 交接状态——已委派给的 supervisor、正在启动的协调者，或具名未启动原因（evolution 开关关闭、目标不支持、store 额度用尽、尚未有人消费）。只报事实——是否启动 reviewer 由别处决定（失败 Review 自动受理；成功源只有显式调用才会被复盘）。
20. task_review_agent：为一个精确 review 源（taskId、runId、可选 reason 与 requestKey）spawn 一个只读评审 agent；同一源只有一个默认尝试，重复调用返回该尝试而不是再起一个，尝试终结后再次复盘必须给出新的 requestKey，新尝试受每 store 额度约束；reviewer 自己落一条 Diagnosis——复盘观察、结论（有据建议/无需改进/证据不足）与置信度，judgements 与 proposals 均可省；超时或不可解析的答复把尝试记为 interrupted，不伪造 Diagnosis。终态为 `failed` 的 Review 会被自动受理（插件在记录落盘时和 graph 激活时扫描 store），成功源只有显式调用才会被复盘。
21. task_diagnose：持久化一条 Diagnosis（proposals 只是建议，绝不自动执行）。
22. task_budget_extend：经原生人审（卡片展示 store、当前生效上限、已计用量与拟改后的总上限）申请提高一个已配置的根上限——新的 `maxRuns` 总额（Agent 无运行时长截止），以 `requestKey` 为键；落一条 `TaskBudgetExtended` 事实，同键重试直接读回已有记录不再发问；不唤活任何终态、不自行启动任何工作、已计用量继续累计。
23. task_recover：为一个已记录 Diagnosis（sourceDiagnosisId + requestKey）开启失败根目标的新尝试——runtime 在同一 store 开一个全新 Run/Session，由原不可变验收判据判定；工具之下每层各自重检（调用者必须是该交接委派的可信 supervisor、诊断所依赖的能力变更必须已获批且已应用，store 自身事实/上限/幂等由 runtime 重查）。绝不出现于 root 面。
24. evolution_propose：登记一条 evolution 提案（可从 Diagnosis 转录）。
25. evolution_candidate：记录 candidate 的完整版本集合与可选的结构化 mutation。
26. evolution_prepare：把机械型 mutation 物化到提案沙箱，并落 champion 快照。
27. evolution_replay：对本图已终态的历史任务重放候选，写 candidate vs champion 对比报告。
28. evolution_gate：记录 Gate 六问（regression 证据引用必须真实存在）。
29. evolution_decide：记录 PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH——先过一次原生人审才落账。
30. evolution_apply：把已 PROMOTE 的提案（同名 skill 对象，或一条 capability 行加可选新 skill；限 L1–L3、已物化）写进生产；第二次人审，reason 列出全部生产写入路径——capability 行还包含部署自己 `config.yml` 里的行文本，在完成记录落账前写入。
31. evolution_rollback：从 champion 快照恢复（无 champion 则删除 apply 产物）；同样先过人审。
32. evolution_list：只读台账，带过滤与 history。
33. escalate：把无法自行解决的问题上报给人（KISS §7 L4：能力缺口、预算耗尽、UNKNOWN(verifier) 判决）——卡片先经原生 approval seam 展示，显式批准后才记入只追加台账（`.dsh/escalations.jsonl`）；拒绝/取消/无人作答不落账。

通过 New graph 创建图。仓库安装由 agent 用 bash（clone + 按仓库文档 build）完成，再调用 `env_register_component`。

### 注册的 Web API：

无

### 维护的 Service 状态

1. ctx.singularityAgent：注册上述 tools；本组合恒定注册 24 个（`evolution` 开启时 33 个）；root agent 经 ROOT_TOOLS allow-list 保留其中 23 个（开启时 32 个）——`task_ask_parent` 刻意不在 root 面（root 无父可问），`task_recover` 是可信 supervisor 自己的入口（A6）
2. ctx.hitl：原生交互 seam 的画布 answerer——hitl_ask 走 ctx.userQuestions、hitl_approve 走 ctx.approval（审计事件与 fail-closed 由原生层负责）；ctx.hitl 只把这两条 waterfall 桥接成待处理卡片，由画布经 GET/POST /singularity/hitl 回答，回答、取消或服务卸载后移除
3. ctx.proposalReviewChannel：本 fiber 上挂载的 T2/T3 审核渠道——task runtime 以软解析取得它，并在分解提案等待人工审核（策略 `all`）时请求它。它渲染已保存的批次（父任务、全部子任务、限额、未满足义务、两个上下文指纹），经原生 approval seam 在 store owner 会话上提问，并把回答经 `taskRuntime.decideProposal` 落为 `TaskProposalDecided`，decidedBy 用渠道自身身份（`approval:<owner session>`）；任何 agent 工具都不接受审批凭据，问不到人的提案保持 `pending_review` 并给出原因。
4. ctx.evolution：只追加的 evolution 台账（`$DSH_HOME/evolution/proposals.jsonl`）外加每提案沙箱（`sandbox/<proposalId>/`）——evolution_prepare 把 candidate 携带的结构化 mutation 与 champion 快照物化到这里，evolution_replay 对图中已终态的历史任务重放候选后把 candidate vs champion 对比报告（`replay-report.json`）也写到这里；台账与沙箱之外唯一的写入是 evolution_apply / evolution_rollback 把 PROMOTE 决定的 skill / agent_preset / capability 落到生产（rollback 从 champion 快照恢复，champion 不存在则删除 apply 产物），每次各过一次原生人审，L4 与记账型永远拒绝；由 agent 自身 fiber 提供而非子插件——evolution_* 工具是通过注册时那个 context 读它的
