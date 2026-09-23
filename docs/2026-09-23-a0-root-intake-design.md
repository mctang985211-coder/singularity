# A0：真实根契约入口 — 设计与验收合同

日期：2026-09-23。状态：待实施，架构复核后修订；代码基线 Singularity `fda3d29`，修订前备份 `1430103` / 外层 `31bcf3a`。行为与验收为合同，下文内部方法名/数据落点是实施建议，允许在保持同一行为且减少重复的前提下调整并记录理由。
范围依据：[深入架构](exploration-evolution-architecture.md) §5.0 与 §10 A0 行、[建设计划](2026-09-20-vrtc-code-change-plan.md)文首唯一顺序第 6 行完成闸。
本文件只定义 A0：根 intake + setup/激活分离 + 真实目标与独立顶层 AC + 复用 T2/T3 审核/恢复 + 幂等激活。派发时与 R0 默认运行面收敛同组，见建设计划；组后进入 R1 真实运行，不直接派发 A2。不做 A1/A2/A4、契约修订入口、模板库、blocked 恢复（S2-R）。

## 1. 行为合同

1. **setup/激活分离**：`graphs.create` 创建 graph + root session，**不再创建根任务**。根 store（`sg-t-<rootSessionId>`）在 intake 时按需创建，可以先存在而没有任何任务。
2. **根 intake**：root agent（唯一调用者）从用户请求构造规范化根契约——objective、assumptions、constraints、mandatory AC，且**至少一条 mandatory 判据的 `verificationMode !== 'composite'`**。这是结构门槛；独立根检查还须验证实际交付物，不能用恒真命令、模型自述或 heuristic 冒充确定性根通过。沿 P4 的 command/实际 verifier 路径验收，缺独立顶层判据 → 具名拒绝、零副作用。没有模板也能生成。准入不承诺识别任意命令的真实语义，语义有效性另用独立场景判据验证。
3. **审核**：机器校验后按 `Config.generatedTaskReview` 同一开关语义审核根契约（同一 `TaskProposal` 记录、同一四个事件、同一决定绑定三个摘要、同一批准后重检、同一 requestKey 幂等、同一 reconcile 恢复遍、同一 `ProposalReviewService` 渠道）。`off` 记 `policy-off` 并在同一调用内继续激活；`all` 出生 `pending_review`，批准前**零根任务、零派发**；草案被拒绝零派发，可修订重提（新内容新提案，`supersedes` 链接）。直接服务入口（不经工具）受同一闸。
4. **激活**：批准（或 off 的 policy-off 记录）后 `continueProposal` 重检通过才激活：一次原子提交落根任务（携带契约）+ 根 run（出生 `active`，`sessionId=rootSessionId`）+ 提案消费记录（命名铸出的 taskId/runId）；随后进程内绑定 session、闸置 `active`、声明工作区、绑定 provider。激活幂等：同一接受事件不创建第二个根任务/第二个根 run。
5. **不冒充**：契约接受前 `task_read`/`task_status` 对根 session 返回「尚未激活」视图（含待审/待续跑提案状态），graph name 不出现在任何 objective 位置。缺契约不是崩溃，是具名状态。
6. **旧图不改历史**：旧 store 已有的根任务（objective=graph name、仅 composite 判据）按历史读取/验收/完成，budget/reconcile 原样工作；这些 store 上的 intake 具名拒绝（根任务已存在）。目标改变 = 新 graph/新目标绑定，不迁移、不改写已有任务。
7. **预算**：根 run 的 `startedAt` 就是接受时点，A3 根预算语义零改动；接受前无根任务，`resolveRootBudget` 走既有具名恢复诊断。
8. **根 session 边界**：根 run 终态后根 session 被闸置 `terminal`（A3 既有行为）；`task_intake` 是写动作、不在协调放行表——终态根 run 上的迟到 intake 被闸/状态双重拒绝，不在已终态根 run 上复活执行。该行为变化如实记录。
9. **worker 工具面不扩张**：`task_intake` 只进 ROOT_TOOLS；不新增任何管理/HITL 工具；worker baseline 不变。
10. **用户意图可追溯**：根提案与已接受根契约可追到实际用户请求及必要澄清，优先复用现有持久 Session 事件引用；只有既有记录无法关联时才增加最小来源引用。来源归属由 runtime 校验，不能接受模型伪造的“用户已确认”。模型推导的假设单独呈现；会改变目标、范围或验收的歧义用已有 root 澄清渠道解决，未解决不能当已确认要求激活。`off` 不强制每份契约人审，也不授权模型猜测用户要求；明确请求可自主规范化，普通实现方法自主选择。不新增自然语言蕴含验证器。

## 2. 数据与事件合同

- `TaskProposal` 增加判别字段 `kind: 'decomposition' | 'root'`（既有记录缺省按 `'decomposition'` 读取，旧事件不改写）。
- **decomposition 提案**：现状不变（identity.parentTaskId/parentRunId 必填，batch=子批次）。
- **root 提案**：identity 无 parentTaskId/parentRunId，改为 `rootSessionId`；载荷携带**单份规范化根契约**（`contract`，不是 children 批次）。事件信封的 taskId 使用保留根标记（实现者定形，reducer 按 kind 校验，禁止用真实任务 id 冒充）。
- 四个事件复用：`TaskProposalSubmitted` / `TaskProposalDecided`（绑定 proposalDigest + admissionContextDigest + 批准必须的 reviewContextDigest）/ `TaskProposalPhaseChanged` / `TaskProposalAdmitted`。
- 摘要单点实现按 kind 分支：root 的 proposalDigest 覆盖 storeId/rootSessionId/requestKey/契约摘要；`reviewContextDigest`/`admissionContextDigest` 语义不变（根契约声明的 requiredCapabilities 参与解析指纹；缺省为空）。
- **消费绑定（kind=root）**：`TaskProposalAdmitted` 与根任务 `TaskCreated`/`TaskAdmitted`、根 run `RunStarted` 同一原子提交；消费记录命名铸出的 taskId/runId。`admitBatchIn` 的 batchId 词汇不适用根（无 `b-<parent>`），根消费用独立具名字段（实现者定形），但「一次消费只产生一个根任务」由 reducer 强制：store 已有根任务时根提案准入拒绝。
- requestKey：缺省由 storeId/rootSessionId/契约内容摘要派生（同内容同 key 答原提案；修订自然得到新 key）；调用方显式给 key 时沿用「同 key 不同内容具名拒绝」。
- 持久化纪律：逐事件 before/after 写入 `docs/persistence-changes/2026-09-23-a0-root-intake.md`；根指纹移动时 `--write` 并记录原因。

## 3. 模块落点与接口交接

### 阶段 A（task 包）

先检查既有提案/Session 来源与原子提交接口；以下按 root/decomposition 区分身份是建议，不要求为每个建议方法新增一个导出。对外新增面须有本票实际调用方；根与子提案共用审核/恢复规则，不能复制两套生命周期。
- `task/src/proposal.ts` / `task/src/types.ts`：`kind` 判别联合、root 身份与 `contract` 载荷、摘要分支、事件载荷类型。
- `task/src/service/state.ts`：`assertProposalIdentity`/`assertProposalTask`/`assertConsumptionBinding` 按 kind 分支；root 准入闸（store 已有根任务即拒）；状态机/决定绑定两种 kind 共用。
- `task/src/index.ts`：`submitProposalIn`/`decideProposalIn`/`changeProposalPhaseIn`/消费入口支持 kind；根准入为单提交（task+run+消费）。
- 单测：`task/tests/unit/proposal.spec.ts` 根变体（摘要固定向量、reducer 拒绝表、消费绑定、旧事件读取）。
- **交接**：root 提案的记录形状、事件、reducer 规则、消费原子提交入口签名。

### 阶段 B（task-runtime + tests/support）
- 根契约规范化（复用 normalize 的契约级规则；单契约 criterion id 缺省确定性生成）+ `contractDefects` 复用 + **新规则**「至少一条 mandatory 非 composite 判据」（独立导出，具名拒绝）；protectedInputs 对根 session checkout 固定（复用 fixSpecProtectedInputs）。
- 服务入口：`submitRootContractProposal`（纯预检→策略→落提案；off 组合续跑）、`intakeRootContract`（submit+continue 组合，工具与直调共用）、`continueProposal`/`decideProposal`/`cancelProposal` 支持 kind=root。根重检 ladder：store 根任务存在性（自身已消费→幂等回答；他者→expired）、admissionContext 指纹、reviewContext 指纹；无父任务/父 Run 项。
- 激活：`continueProposal` 根分支在原子提交后做进程内激活（sessions 绑定、闸 `active`、workspace claim、`bindRunProviders`），并给 root session 发唤醒/通知（沿用既有 owner 通知机制）。
- `createRootTask` **删除**，拆为：`adoptRoot(storeId, rootSessionId)`（开 store + reconcile + workspace rebuild；已有根任务/run 则重绑定，等价原收养分支，供 graphs 与恢复使用）+ intake 激活路径。无任何绕过审核的建根入口。
- `reconcileProposals` 覆盖根提案（pending_review 重发、ready/approved 续跑；按 store 串行）；崩溃点：①决定已存未激活→重检补激活；②激活已提交未绑定→重绑定/补通知，不建第二个根任务/run。
- 根预算零改动（补回归：接受前具名诊断、接受后正常记账）。
- `task_intake` 闸分类：写动作（不进协调放行表）。
- `tests/support/run-stack.ts` / `scripted-loop.ts`：新运行集成测试默认经过真实 intake/激活入口；既有状态机单测可在其测试层级 seed 状态，旧图兼容测试使用明确命名的 legacy fixture。不能把所有原有集成用例统一改走旧图，再以全绿宣称新入口兼容；至少普通执行、父验收、审核与恢复经新入口组合覆盖。**不提供生产绕路**。
- 单测：proposal-lifecycle 根用例、根 intake 策略/重检/幂等、独立判据规则、adoptRoot 重入。

### 阶段 C（agent-singularity + agent-runtime + graphs）
- 新工具 `task_intake`（仅 ROOT_TOOLS；schema 闭合；调 `intakeRootContract`；渲染 activated/pending_review/拒绝诊断）。
- `task_read`/`task_status` 根路径：store 缺失或无根任务 → 「尚未激活」具名视图 + 开放提案状态；绝不渲染 graph name 为 objective。worker 路径不变。
- `proposal-review.ts`：kind=root 渲染（根契约全文、无父段落；owner 路由不变）。
- `graphs/src/index.ts`：`create` 改调 `adoptRoot`；rollback 语义不变。`graphs-lifecycle.spec.ts` 同步。
- `agent-runtime/src/prompts/root.prompts.ts`：intake 段（收目标→构造根契约→`task_intake`；审核策略同 task_decompose 的条件块措辞；激活前不得 `task_decompose`；`task_read` 会报未激活）；不把未实现工具写入 prompt。ROOT_TOOLS += `task_intake`；README 计数同步。
- 单测：task-tools、proposal-review 渲染、prompt 装配/工具面一致性。

### 阶段 D（集成验收 + 文档）
- 新 `tests/integration/root-intake.spec.ts`（真实 DSH loop + scripted provider）与 `tests/integration/root-intake-recovery.spec.ts`（真实 JSONL 重开）。
- A3 等待窗口只在实际阻塞本票验证时调整，记录被等待操作与失败诊断；不强制统一 20 秒或重复六遍。marker 顺序与所有权的正确性由定向反例验证，交由 R2 核对；本票若发现已支持路径错误仍须先修复，不能仅延长超时后宣布通过。
- 文档同步（见 §6）。

## 4. 验收矩阵（§10 A0 行 → 入口 → 测试）

| 验收项 | 入口 | 测试 |
|---|---|---|
| setup 不消费根分解 | graphs.create/adoptRoot | graphs-lifecycle + root-intake 集成 |
| 无契约时 task_read 返回未激活 | task_read/task_status | 工具单测 + root-intake 集成 |
| graph name 不冒充目标 | 全链路 | root-intake 集成（用不同的图名与用户目标检查来源；不禁止用户目标恰好与图名同文） |
| 原始用户输入/澄清可追溯，假设不冒充要求 | intake/Session 引用/task_read | 真实模块来源与归属检查；语义澄清效果由组后 R1 实验验证 |
| 新根有独立 AC（缺则具名拒绝零副作用） | 根校验规则 | 单测 + 集成反例 |
| 子全通过但根错误仍拒绝 | 根验收（command 判据失败） | root-intake 集成 |
| 判据针对真实交付物，heuristic 不冒充确定性通过 | 固定根判据 + 实际 verifier | 受保护外部检查验证产物；失败不能通过更换 AC 或恒真命令消除 |
| off/all：off 记 policy-off 直接激活；all 批准前零根任务/零派发、批准后激活 | intake/continue/decide | 集成（含直接服务调用同闸） |
| 拒绝草案零派发；修订重提合法 | decide/cancel/重提 | 集成 |
| 激活幂等：同一接受事件不建第二个根任务/run | continue/恢复 | 恢复 spec |
| 崩溃恢复：「接受已保存未创建」「创建已提交未派发（绑定缺失）」重开续跑 | reconcile 提案遍/激活恢复 | 恢复 spec（真实 JSONL） |
| 旧图不改历史：旧根读取/验收/完成不变，intake 具名拒绝 | adoptRoot/intake | 恢复 spec + 单测 |
| 预算语义不变：接受前具名诊断、接受后计时 | root-budget | 单测回归 |
| 终态根 session 不复活 | gate + intake | 集成（terminal 后 intake 拒绝） |
| off→all 补审、all→off 不释放（根提案同规则） | reconcile/策略分支 | 恢复 spec |
| worker 工具面不扩张、无决定类工具 | 装配工具面 | 集成断言 |

规则组合覆盖：off/all × 接受/拒绝 × 激活崩溃点 × 旧图/新图。关键反例先复现失败再修复；拒绝路径断言零落库/零 spawn/零唤醒；结论从 store/事件日志读回。

## 5. 明确不做

A2 导航、A1 上下文投影、A4 问答、根目标修订（契约修订提案入口仍不提供，修订=新提案）、模板库、blocked 恢复（S2-R）、真实模型实验、部署/推送。暂不支持的对象在所有入口显式拒绝。

## 6. 文档同步（完成条件）

主 guide §3/§4.1 根目标行/§4.2 G11、G14、G15 与本票实现约束；建设计划第 6 行及 A0 + R0 共用验收记录（逐项写 A0/R0 证据、基线、反例、复核和未覆盖范围，下一项 R1）；深入架构 §2/§5.0/§10；Prompt 合同的部署状态；execution-prompts/README.md 当前入口。涉及事件变化时写持久化记录（必要时更新根指纹并记录原因）。本文件不预先指定主 guide 的新增小节编号，避免多个实现任务争写同一编号。
