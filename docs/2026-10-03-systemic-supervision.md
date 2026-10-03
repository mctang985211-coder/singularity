# 跨节点复盘与按需 Reviewer 协作

TaskRuntime 仍是唯一业务调度器。ReviewRecord 是每次 Run 终态的机械事实，不等于启动 Reviewer。Reviewer 只读调查，Supervisor 汇总一项诊断的改进决策；已有演化实验和审批决定是否发布。

## 触发

- 默认 `autoReview: all`：失败 Task 的终态立即触发 Reviewer；成功子节点只留 ReviewRecord，成功根验收后触发一次整图复盘。
- `failed` 只自动复盘失败，`off` 关闭自动复盘。显式 `task_review_agent` 可调查任一已有 exact review。
- 实验 replay 根及其执行后代不自动复盘；其评估由原实验负责。沿现有 Run parent 链识别，无第二套执行标记。
- source 默认调查、显式 requestKey、共享额度、重启去重沿用原协调 ledger。默认 reviewer 与 supervisor 共用每图 8 次额度。

## 证据与根因

`task_review_pack` 优先保留 exact source 的判据、原日志、Run 及冻结 Skill；附首 20 个 Task 的紧凑 DAG 导航，包含父子、依赖、模板版本、Run/session/review/diagnosis 引用。大图由 `task_status scope: graph` 续页；原合同、证据和会话由 `context_read` 按需分页。缺失计数保持 unknown，不把整个图日志灌入 prompt。

有效 Reviewer delegation 可以只读同 graph 任一 Task/Run/证据/session；Worker 仍限自身枝域、祖先与依赖。失效 delegation 不扩大读取域，跨 graph 仍拒绝。Reviewer 没有写、执行、调度或演化权限。

Reviewer 追踪失败依赖的上游，区分独立缺陷与下游症状；比较共同模板/Skill 的冻结版本和成功反证。相同报错或共同 Skill 只能产生假设。结论必须说明机制、受影响范围、支持和冲突证据；证据不足就说明缺失事实。模型负责因果判断，运行时只验证引用确属此 store，不声称机械证明了根因。

原 Diagnosis 字段直接承载 `scope`、多 `reviewRefs`、`evidenceRefs`、`relatedTaskIds`；自动调查不再硬编码单节点。触发源永远排在 reviewRefs 首位以保持恢复 Run 身份；新增引用必须真实存在，未阅读的图邻居不自动纳入结论。

## 局部深挖与全局决策

Supervisor 首请求获得诊断范围、多源引用与同一 review pack；可以读取其他已有诊断，再用 `task_review_agent(taskId, runId, reason, requestKey)` 调查具体因果问题。每个聚焦 Reviewer 返回持久 Diagnosis 和工具结果；委派关系通过已有 ledger 识别，它的报告不会另开 Supervisor，重启扫描同样如此。

这是按需扇出调查、汇总决策，复用业务 DAG、消息与账本；没有新增研究 Task 图或聊天室。Supervisor 所有权仍按 diagnosis，而非把所有 graph 的不同诊断强并为一个全局常驻 agent。不同诊断可以有各自 Supervisor；同一诊断或其聚焦调查不会重复派发。

Supervisor 优先改 Task 内容、直接子 DAG 配方、相关 Skill。针对多个受影响 Task 的共享改进可引用多份诊断；应用后通知明确 implicated 且有 exact review 的各个原委派父 Run，按 parent Run 去重。成功对照未列入 relatedTaskIds 时不收到修复通知。

## 成功任务的优化

从完整执行子树的重复工作、重复读取、重试、分解开销、工具使用与 Skill 不匹配入手。无具体可验证改进时只记录诊断，不派 Supervisor。

复用已有 `tool-call-reduction` 实验：baseline/candidate 都实际执行，原验收不变，observed 的完整业务 Run 子树调用数严格下降，独立 verified holdout 不退化且调用数不增长，缺计数不通过。它证明业务执行成本改善；Reviewer/Supervisor/实验本身的总成本净收益目前没有完整测量。

## 验证范围

`tests/integration/systemic-review.spec.ts` 用脚本模型驱动真实 AgentLoop、TaskRuntime、工具及 command verifier：两个失败兄弟和成功反证，跨节点原证据读取与落盘，Supervisor 两次聚焦调查、报告汇总、激活重扫不嵌套；默认成功叶零复盘、根验收后一次整图调查、无提案零 Supervisor、显式叶调查可用。

新增单测验证虚构跨图引用拒绝、历史触发源不漂移、图导航分页、Worker/Reviewer 权限边界、实验自动复盘隔离，以及共享发布通知多个原父 Run。原 Task/Skill/MCP 对照实验、审批发布和恢复集成继续验证。

本轮检查：unit 2282 通过、0 失败；integration 全量先为 638 通过、2 失败、8 跳过，两项测试在 Task 已准入但 Run/Agent 尚未发布时提前读取状态，修正等待后相关两文件 5/5 通过，合计覆盖 640 通过、8 跳过。脚本 Reviewer 的旧虚构证据引用已改为真实 exact source；没有为了通过测试放宽证据校验。build、verify-persistence、source-size、git diff 检查通过；source-size 检查 481 个源码文件，每个最多 2000 行。

本轮未声称真实模型已自主找到跨节点根因或取得长期净收益；本轮结果验证机制接线。实现与备份在独立工作区，未合并或部署到原 `/home/roxy/code/harness`。
