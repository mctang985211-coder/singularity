# Task 自主构造与契约审核建设指导

日期：2026-09-21。状态：设计合同；T1「统一规范化契约」已实现并验收（2026-09-21，源码/测试锚见主 guide §5.6 与[历史执行记录](history/2026-09-24-vrtc-execution-records.md) T1 节），T2/T3「契约审核与恢复」已实现并验收（2026-09-23，源码/测试锚见主 guide §5.10 与历史执行记录「T2+T3：契约审核与恢复 执行与验收记录」）；正文其余部分仍是目标语义，落地边界以标注为准。
本次编辑前工作区干净，已有提交作为备份：Singularity `7be57a1`，外层 harness `9f818152bb`。保留 P1–P4 的实现与验证记录。T2/T3 交付时的修改前基线为 Singularity `6d85c5e` / 外层 `4d5d4b7`。

方向入口为 [主指南](singularity-harness-guide.md)，派发顺序以 [建设计划](2026-09-20-vrtc-code-change-plan.md)为准；本文件细化 Task 契约与生成审核，不替代两者。

后续 [探索与自进化架构](exploration-evolution-architecture.md)细化上下文、非阻塞批次、问父与 supervisor。T1–T3 只建设子任务契约/审核，均已交付；根 intake 属 A0（A0 + R0 已交付，来源/恢复返工 2026-09-23 关闭）。当前唯一顺序以建设计划为准：R2、R1、R3 已验收，下一项为第 9 项 A2+A1；context 职责及完整消费设计见主 guide §1.4 与计划 D/E 节，不将上下文主体继续放进 task。

后续恢复合同已固定在计划 F.4，尚未实现：task_recover 为失败原目标创建新 Run/Session，本次 task_decompose 依据持久恢复关联进入按 Run 的新批次准入；复用证据通过本次成员绑定解析，原 AC、旧已消费提案和旧终态不改。下文“一父一批”仍描述当前 T2/T3 行为，不能据此把 A6 写成重新消费旧 proposal，也不能在 A6 前放宽当前闸。

## 1. 要解决的问题

人无法预先列出全部任务。系统应约束“什么样的任务可接受、怎样执行和证明完成”，允许节点生成新的具体任务。模板帮助发现义务和复用经验，不决定任务是否合法。找不到模板不是错误，也不要求先做全库搜索才能生成任务。

“任务语言已完成”不能只看 TypeScript interface：需要可序列化结构、字段语义、机器校验、持久化与重放规则、授权边界，以及从提案到执行的完整路径。自然语言语义无法全部机械证明，必须明确哪些检查是结构性的、哪些判断具有不确定性。

本轮建设限定当前父任务下的子任务批次。T1–T3 不改根入口；后续 A0 单独解决真实根契约激活（已交付并验收；来源/恢复返工 2026-09-23 关闭，见 §1）。根目标修订、Task 模板库、通用规划器、OR/循环组合语言不在 T1–T3 范围。

**根目标语义边界（A0 已实现；来源/恢复返工已关闭，2026-09-23）**：原请求及澄清需有可读取且由服务校验归属的来源——已由 `assertRootContractOrigin` 落实（store↔session、顶层会话、本人消息三规则，工具与服务入口共用，拒绝均在首次写入前且具名，日志不可读 fail-closed）。该判定是归因纪律加顶层会话判定，不证明来源真实性，也不校验「该顶层会话是某 graph 的 root session」（该规则仍在 `task_intake` 工具面）。影响目标/验收的歧义先澄清，方法选择自主决定；给假设加标签不授权据此激活猜定目标。可选契约审核 `off/all` 与必要澄清是两回事，不为所有任务强制人审。非 composite 判据或摘要正确只证明结构/身份，不证明目标解释正确；R1 完成轮 3 证明了固定场景的澄清消费与有限目标形成，但不构成通用语义证明，不预建通用需求解析器。当前次序见建设计划；R3 已验收。

## 2. 已有基础与实际缺口

| 现有能力 | 源码锚 | 不能据此推断的能力 |
|---|---|---|
| Task 契约、实例、Run、AC 类型 | `task/src/contract.ts`、`task/src/types.ts` | 完整不可变 TaskDefinition 注册库；R3 后测试专用 `TaskDefinition` 仅在 `tests/support/legacy-root.ts` |
| 节点动态提交 objective、AC、能力、依赖、assumptions；T2/T3 已有生成审核 | `agent-singularity/src/tools/task-decompose.ts` | 必须从已有模板选择；结构准入保证用户语义正确 |
| AC 默认值与自动编号 | `task-runtime/src/normalize.ts:normalizeDecomposition`（T1 前为 `task-runtime/src/index.ts:normalizeCriteria`，已删除） | 工具 schema 是所有入口的统一运行时校验 |
| 深度、数量、依赖无环及部分判据结构准入 | `task-runtime/src/admission.ts` | 父目标与所有子契约之间的自然语言蕴含证明 |
| P4 父证据映射、独立判据、原始/已验证输入区分 | `independentAcceptanceDefects`、composite verifier | C3 假设满足性完整证明、任何父任务都已有独立判据 |
| A3 非阻塞顺序执行；T2/T3 提案审核/幂等恢复 | `decomposeAndRun`、`continueProposal`、`reconcileStore` | 任意外部副作用 exactly-once；多进程竞争写同一 store |

T1 已将 assumptions/constraints 存入 `TaskInstance.contract` 并渲染至 handoff；旧记录缺字段不伪造历史。预算来自运行时配置及 A3 根预算规则，不能声称可由生成契约任意覆盖。能力缺口路径可能记录 Obligation；纯预检与执行入口分开，不能通过重复调用有副作用的入口实现重检。

## 3. 区分四种操作

| 操作 | 执行主体 | 准入与审核 |
|---|---|---|
| 生成当前目标下的 Task 实例 | 执行节点/父节点 | 机器准入始终执行，契约人审可配置 |
| 形成可复用 Task 模板 | supervisor 根据轨迹提出 | 模板适用条件、固定基准及回归验证后走改进晋升 |
| 修改已接受的 Task 目标、AC 或约束 | 单独契约修订提案 | 保留原版本，明确重新授权；T1–T3 不提供修改入口 |
| 新增生产能力、工具或权限 | 对应改进/授权流程 | 不受任务生成审核开关影响 |

现有 task_definition Evolution 候选并不意味着已经有模板生产注册执行器。一次性 Task 生成无需先走 Evolution prepare/replay/holdout；共享模板晋升也不能借一次任务批准直接完成。

## 4. 首版契约结构

T1 在 task 包中形成唯一的规范化契约数据定义；工具输入适配到它，admission 消费它，存储与 handoff 引用同一份。类型、工具 schema 与 runtime validator 必须有一致性测试；不要求一次重写整个 schema 工具链。

S1-V 切片 2（2026-09-21）另在 AC 上加入 `protectedInputs`（受保护验收输入）：准入固定 `{ path, sha256 }`、判决前复检，当前事实、源码/测试锚与边界见主 guide §5.7；它不改变 T2/T3 的审核范围。

S1-C（2026-09-22）把"Task 只提需求、Run 固定实现"落成机制：`requiredCapabilities` 仍是契约里的需求名（不写死 Skill），provider 预检、类型化侧车契约与 run 级内容绑定（`TaskRun.providerBinding`：registry 修订、provider 角色与内容摘要、preset/MCP 身份）见主 guide §5.8；它不改变本文件的契约字段与审核范围。

**T1 已实现部分（2026-09-21）**：数据定义 `task/src/contract.ts:TaskContract`（含 `contractVersion`、`assumptions`、`constraints`），唯一规范化与校验入口 `task-runtime/src/normalize.ts:normalizeDecomposition`（三层闭合字段集、默认值、criterion id 固定、未知版本拒绝），身份算法 `canonicalize`/`contractDigest`/`decompositionDigest`，批次准入记录 `TaskDecomposed.admission`（`proposalDigest` + `AdmissionContext`），以及普通分解/replay/root 三个入口的持久化与共用结构校验（`task-runtime/src/admission.ts:contractDefects`）。下表的 `contractVersion`、`assumptions`、`constraints`、`requiredCapabilities`、`dependsOn`、输入/证据、复合声明、分解意图各行的**当前实现状态**以主 guide §5.6 与历史执行记录 T1 节为准。

**T2/T3 已实现部分（2026-09-23，已验收）**：本节 §5–§7 描述的策略、提案生命周期与恢复已落地，源码锚见主 guide §5.10、测试锚见历史执行记录 T2+T3 记录。三个上下文指纹——规范化单任务契约摘要（`contractDigest`）、整批提案摘要（`decompositionDigest`）、准入上下文指纹（`admissionContextDigest`，`task/src/proposal.ts`）——都已实现，并新增审核上下文指纹 `reviewContextDigest`（本批解析到的 manifest 折叠摘要 + 判据 pin 的 verifier 身份）与 `capabilityManifestDigest`。批准同时绑定 `proposalDigest` + `admissionContextDigest` + `reviewContextDigest`，reducer 逐项比对。仍未实现：Task 模板库、契约修订入口、多进程并发写同一 store 的恰好一次保证；**根契约入口（A0）已于 2026-09-23 交付并验收，其来源归属与 `adoptRoot` 恢复入口的返工（Q2/Q3）同日关闭**（见 §1 与历史执行记录「A0 返工（Q2/Q3）执行与验收记录」）。

保留当前字段词汇，新增字段明确版本。以下是目标语义，不是当前工具参数示例：

| 内容 | 首版规定 | 校验边界 |
|---|---|---|
| `contractVersion` | 首个规范化新合同版本为 1，与 template version、事件 envelope version 分开 | 未知版本明确拒绝 |
| `objective` | 自包含目标/交付物，非空 | 不用禁词表冒充“可判定性证明” |
| `acceptanceCriteria` | 至少一条 mandatory AC；唯一 criterionId、描述、mode、证据需求与适用 verifier | 机器检查形状、重复与可解析性；不能证明 command 检查得足够好 |
| `assumptions` | 显式数组，省略规范化为空；持久化，不只放提示词 | 不能通过字符串匹配声称 C3 已证明 |
| `constraints` | 显式数组，省略为空；列明执行范围/限制并持久化 | 文本不是权限授予，权限仍由运行时强制 |
| `requiredCapabilities` | 需求名称，沿用当前解析与缺口规则 | 不写死 Skill，不将 decomposable 当成能力已具备 |
| `dependsOn` | 当前批次的子索引，顺序有语义 | 越界、自依赖、环拒绝；不是预设领域 workflow |
| 输入/证据 | AC 内沿用 `acceptsArtifact` / `requiresArtifact` / `requiredEvidence` | 保留 P4 原始输入与 verified 参考产物区别 |
| 受保护验收输入 | AC 内 `protectedInputs` 由调用者声明路径（字符串），准入时固定为 `{ path, sha256 }`（读不到即整批拒绝、零副作用），判决前复检：缺失或被改 → `fail` 点名路径且不派发裁判 | 只保护显式声明的路径；未声明的不受保护，也不得被描述成“已保护”；固定的是字节身份，不认证内容来源真实性 |
| 复合声明 | 沿用 `childEvidence`、`requiresIndependentAcceptance`、`heuristic` | 不把映射存在性夸大为完整父目标证明 |
| 分解意图 | 沿用 `decomposable` | depth/maxChildren 仍受部署与父级限制 |

首版不允许生成节点通过新字段提高预算。有效预算、分解上限及相关部署配置作为准入上下文保存，标清硬限制与软审计项；审核后运行时重新读取并检查，资源授权不由契约文本自行扩大。未来独立引入请求预算时只能在继承限额内收紧。

研究型任务也必须有验收：例如产出可复现实验记录、适用条件、反例与未解决项；不能将“猜到正确答案”设为未知探索的唯一目标，也不能以“进行了研究”直接判 PASS。新增执行 verifier 属另一条能力改进路径，节点不能在同一提案里注册一个总返回 pass 的裁判。

### 身份与规范化

区分三个身份：规范化单任务契约摘要、整批分解提案摘要、当前准入上下文指纹。不要让易变的 registry 状态混入目标内容，也不要只批准 objective 字符串。

提案身份覆盖 store/parentTask/parentRun/caller、schema 版本、完整有序 children、reason；子契约所有字段和依赖均在摘要范围。规范化时先补明确默认值，再按对象键稳定排序序列化并 SHA-256；数组保序，文本不做 trim/换行重写，空白校验与字节身份分开。摘要算法必须单点实现并有固定向量测试。

准入生成 TaskId/RunId，不能让随机 id 导致同一提案重试变成不同操作。现有自动 criterionId 按批次位置生成可保留，但规范化后必须固定并包含于摘要；重排 children 是新提案。

`childEvidence` 指向的是该任务将来自己的分解批次，不是它在当前兄弟批次的位置。T1 只能检查其结构；该任务真正分解时才能核对索引范围。父 AC 一旦接受不能为了适配新分解而修改映射；模型需提交满足已有映射的方案，或走尚未提供的契约修订协议。此限制要展示为诊断，不静默改题。

## 5. 契约人审策略

建设选择：运行时配置 `generatedTaskReview: off | all`，默认 `off`。已实现（2026-09-23 T2/T3，见主 guide §5.10）：闭合 schema（未知值构造期拒启），批次不能自带该字段。首版不提供 risk-based 或“仅无模板时审核”，避免引入不可靠分类器和模板来源绕过。

| 模式 | 机器准入 | 人审 | 派发 |
|---|---|---|---|
| off | 必须通过 | 跳过，审计记 policy-off，不能伪记 human-approved | 准入提交后执行 |
| all | 必须通过，坏提案不弹审批 | 对整批规范化契约审核 | 批准且重新准入通过后执行 |

该模式适用于所有来源的新子批次，包括模型直接构造、模板实例化与递归节点调用。既有 replay 是评估入口，T1 共用契约校验；T2 不给历史回放重复加入此类人审。必须保留 replay 的已有调用者与沙箱约束，不能新增由普通节点传 `isReplay` 跳过审核的参数。

审批请求至少展示父目标与 AC、每个子任务目标/AC、假设/约束、依赖、声明能力及当前解析、预算/分解限额、未满足义务说明、确定性与启发式标注、提案 id 与完整摘要。大批次按已有 maxChildren 限制处理，不能只展示截断摘要却批准隐藏契约。

审核结果只回答“按这份契约执行是否合适”。人批准不代表验收通过、不授予新权限、不关闭 GAP。节点负责根据拒绝理由修订；人可指出问题，无需填补实现。

审核策略由部署管理，普通节点不可自行切换。提交时保存策略；若 all 待审期间改成 off，该提案仍等待原审批。off 提案尚未准入而当前策略变成 all，则必须补审。首版只允许收紧待处理操作的审批要求，不自动放宽。

## 6. 提案生命周期与执行交接

以下是 T2/T3 的提案合同，属于 TaskProposal，不扩展 TaskStatus 来塞审批状态。**已实现（2026-09-23，已验收）**：状态机、决定绑定、批准后重检与四个崩溃点的恢复都落地了，源码/测试锚见主 guide §5.10 与历史执行记录 T2+T3 记录；本节描述与实现一致，未落地的部分逐条标注。单提案对应一批分解，整批批准或拒绝；首版不支持部分批准，避免破坏 dependsOn。

```text
生成草稿 -> 规范化与预检
  无效 -> 返回字段级诊断；不创建可执行子任务
  有效 -> 持久化提案
           off -> ready
           all -> pending_review -> approved -> ready
                                 -> rejected / cancelled
ready -> 重检父状态、权限、预算、能力、verifier 与契约
      -> stale（上下文失效，需新提案）
      -> admitted（绑定确定的子任务 ids）-> 交给现有执行器
```

规则：

1. 提案内容不可变；修订创建新 id 并引用 supersedes。已拒绝/取消/过期记录保留；不能把拒绝的 TaskProposal 伪装成 failed TaskRun。
2. 校验阶段与提交阶段分开：纯预检返回诊断，不重复登记 Obligation；提交时按既有机制记录事实。非法输入与无审批时均不得 spawn、创建可执行子任务或将父标为 decomposed。
3. 机器准入仍拒绝不满足当前规则的能力缺口；T2 不顺手实现 blocked 恢复。不接受以修改 mandatory、移除父 AC 或把确定性降为 heuristic 自动修正拒绝。
4. 审批绑定提案摘要、父契约/Run 身份与展示的准入上下文指纹。批准之后、正式提交之前重新检查。能力实现、有效预算或 verifier 选择变化，首版保守标 stale，重新生成并审核，不把旧批准转移给新上下文。
5. 单进程同一父分解的重检、提案消费及子任务绑定应串行；两个获批提案最多一个能成为父的实际分解。沿用父任务只允许分解一次的限制。
6. 服务入口执行所有检查；工具层只是显示与发起请求。直接调用 decomposeAndRun 不能绕过 all。低层事件 store 是受信基础设施，不向模型授予原始写事件能力。
7. pending_review 时不长持 Task/store 写锁；审批提供者不可用保持待审并返回原因，不能转 approved。显式取消为 cancelled，拒绝为 rejected。
8. 复用 DSH approval 渠道，通过已有 root/owner 路由展示审核。不要为递归 worker 增加平台管理/HITL 工具权限。模型不能自行生成可信 approvalRef。

有效审核上下文只包含该批实际解析到的 capability manifest、verifier 身份及可用版本/相关配置，不因无关 registry 条目变化作废。没有可信内容版本的资源必须标明身份保障有限，不能声称已解决 G2/G7 的真实来源绑定。

递归 worker 等待审核时，现有 wallTime 取消仍可能结束其 Run。T2 不隐式暂停或重置执行预算：若父 Run 已取消/结束，迟到批准只能令提案失效，不能继续派发。T3 的继续入口重新确认有效父 Run；更换父 Run 需要新提案并重新满足策略。真正暂停执行时钟是独立预算设计，不夹带在审核开关中。

首版建议保留 `task_decompose` 作为兼容入口，内部先提出提案，再按策略推进。新增查询/继续入口以 proposalId 操作已保存内容，不接受“approved: true”或任意外部审批凭据。具体工具命名沿用仓库习惯，规范固定的是行为。

**落地事实（2026-09-23 T2/T3，已验收）**：规则 1–8 已实现，入口与测试锚见主 guide §5.10 与历史执行记录 T2+T3 记录。store 侧：四个提案事件 `TaskProposalSubmitted`（携带整批规范化契约内容 `batch`，不只是摘要）、`TaskProposalDecided`（绑定 `proposalDigest` + `admissionContextDigest` + 批准必须的 `reviewContextDigest`）、`TaskProposalPhaseChanged`（`ready → pending_review` 收紧、`approved → ready` 重检通过、`ready|approved → stale`）、`TaskProposalAdmitted`（消费与子任务、依赖边、父相位同一提交），加上 `TaskSnapshot.proposals` 的 byId/byRequestKey/byParentTask 索引，持久化记录见 `docs/persistence-changes/2026-09-22-task-proposal-review.md`。工具面：`task_decompose` 组合「提交 + 续跑」，另有 `task_proposal_read`/`task_proposal_continue`/`task_proposal_cancel`；渠道 `ProposalReviewService` 挂在 service 装配处，不在任何 agent 工具面。规则 3（T2 不顺手实现 blocked 恢复）与规则 8（不下发平台管理/HITL 工具给递归 worker）在集成测试中被直接断言。

### 重启和幂等

T2/T3 在同一交付组中保证持久化待审、未批准零执行副作用及以下恢复交接；不得将 T2 单独标为完成后留下恢复缺口：

- 请求携带由调用上下文派生的稳定 requestKey。同一 key + 同一内容返回原提案；同一 key + 不同内容拒绝；新修订用新 key。
- pending_review 重启后仍待审；仅持久化可信批准记录才可推进。展示过审批或请求过审批不等于批准；不要复用旧会话已取消的交互结果。
- 批次准入持久化时原子记录 proposal 消费与子任务 ids，或使用能从既有事件重建的等价提交标记。崩溃后先对账，不再创建第二批任务。
- admitted 后、首个 spawn 前崩溃，应能继续派发同一批子任务。已知 run/session 则重连或检查其终态，不再新建；状态不可判明时保持待处置并返回原因，禁止宣称 exactly-once。
- 本票保证单进程提交及重启恢复；多进程同时写 store、工具外部副作用恰好一次不在范围。不同于 S2-R 的能力/产物 blocked 恢复，不借此重跑已通过兄弟。

**恢复矩阵（已实现，真实 JSONL 重开逐点验证）**：① 待审崩溃 → 重开后仍 `pending_review`、零副作用；恢复遍重发审核请求，材料取自store 里保存的批次事实，只有落账决定推进。② 批准已保存未准入崩溃 → 恢复遍重检并续跑准入，同一批只产生 1 条消费、子任务 ids 稳定，不创建第二批。③ 准入已提交未 spawn 崩溃 → 由 A3 的批次恢复驱动同一批（消费里的子任务 ids 与批次一致）。④ run/session 已建立 → 重连并结算终态（在途 run 记 cancelled + 诊断，不重跑），不新建 run/任务。身份不明的旧记录（无协调相位）派生 needs-recovery，唯一合法动作是取消，不擅自再执行。相同 requestKey + 同内容在进程内与重启后都答原提案（不同内容才新提案）；两个获批提案竞争同一父只有一批准入，落败方具名 `stale`（续跑路径：父任务已分解）或 `expired`（批准路径：父 run 已离开可派发相位）。测试锚：`tests/integration/proposal-recovery.spec.ts`（12 项）。

## 7. 持久化与模块落点

| 所有者 | 工作 | 不承担的职责 |
|---|---|---|
| task | 契约/提案类型、不可变数据、提案决定及准入关联事件、reducer 校验 | 弹审批、选模型、发起执行 |
| task-runtime | 规范化、结构/资源准入、策略判断、批准后重检、幂等交接 | 维护第二套模板库、自动批准根契约修改 |
| agent-singularity 工具 | 输入适配、调用现有审批渠道、输出提案诊断和继续指令 | 复制准入算法、凭模型输入认定已批准 |
| graph/canvas | 从已保存事实展示待审/拒绝/已准入及链接 | 本地计算第二份提案状态 |

Task 契约数据由 task 拥有，规范化规则可先在现有 task-runtime 内集中；不为了职责表创建四个新服务。构建时让普通分解、模板适配（将来）和 replay 共享适用的结构检查，权限与审核按入口目的区别处理。

新实例保存完整规范化契约或不可变引用；旧兼容字段不能成为可独立修改的第二份来源。确需保留投影字段时，统一由契约生成，并拒绝内容不一致的新事件。旧任务缺字段保持原含义，不能补成“已审批”“完整契约已验证”；新审核规则只用于新提案，不将历史任务全部卡在等待审批。

变更 task 事件时先声明每个事件的 before/after 合同、必要字段与迁移决定，再修改 reducer 和工具。遵守 persistence-changes；嵌套类型变化可能不改变当前四个根的指纹，仍须记录。提案记录不能借用 EvolutionProposal 或另建一个无引用约束的临时 JSON 文件。

**落地事实（2026-09-23 T2/T3，已验收）**：职责表按原样落地——提案类型、记录与 reducer 校验在 `task`（`task/src/proposal.ts`、`task/src/service/state.ts`）；规范化、策略判断、批准后重检与幂等交接在 `task-runtime`（`task-runtime/src/proposal.ts`、`src/index.ts` 的提案入口段与 `reconcileProposals`、`src/orchestrate.ts` 的 known wait、`src/gate.ts` 的分类）；工具层只适配输入、调用渠道并渲染诊断（`agent-singularity/src/tools/{task-decompose,task-proposal-*}.ts`、`src/proposal-review.ts`）；graph/canvas 侧从已保存事实展示的读取入口是 `TaskSnapshot.proposals`，本组未新增 UI。提案走 store 自身的四个事件（`TaskProposalSubmitted`/`Decided`/`PhaseChanged`/`Admitted`），批次内容随提案整份保存，**没有**借用 EvolutionProposal、也没有新建旁路 JSON 文件；持久化纪律记录见 `docs/persistence-changes/2026-09-22-task-proposal-review.md`（same-version，四个事件根指纹未动，实跑确认）。

## 8. 分批建设与验收

### T1：统一规范化契约（2026-09-21 已实现，执行与验收记录见历史执行记录 T1 节）

范围：§4 规范化字段、身份算法与新实例持久化，普通分解/replay 的适用结构校验、handoff 一致性。无模板库、审批开关、状态机和恢复调度。已有 P4 语义保留，不重做父验收。

验收：

- T1-A：无模板服务/无模板数据时，经真实 task_decompose 工具和 runtime 创建至少两种目标不同的合法任务，均能进入执行/验证 fixture。
- T1-B：空目标、空 AC、全 optional AC、重复显式 AC id、非法 mode、未知版本与未声明字段在新合同入口拒绝；工具及直接 runtime 调用结果一致。旧 API 的自动编号适配不得虚构重复 id 输入。
- T1-C：同义默认值与不同对象键序产生同一摘要；数组重排、AC/约束/假设/依赖变化产生不同摘要；固定向量测试不调用实现自身作为期望值。
- T1-D：新实例、handoff、重开 store 后的契约一致；输入对象之后被修改不影响已保存契约。旧实例缺新字段仍可读取、验收，不虚构历史信息。
- T1-E：叶子/深度/数量/依赖环/缺能力/未知 verifier/P4 的既有拒绝不被放宽；Task 不写死 skill，不能通过生成字段提高预算或更改父 AC。
- T1-F：完整 build、单测、集成、持久化检查通过，两个主要 guide 更新事实、源码/测试锚与实测结果；不能标记 T2/T3 已完成。

### T2：按策略审核不可变提案（2026-09-23 已实现，已验收）

前置 T1 与 A3（均已验收）。范围：§5–§7 的策略、提案生命周期、审核显示、服务入口闸和批准后重检。与 T3 一次派发、整体交付；可先完成内部实现和测试，但不得单独宣布 T2 产品完成或开放不可恢复的 all。

验收：off 不调用人审但记录 policy-off；all 在批准前零子任务/零 spawn；非法输入不弹审批；批准只作用于同一摘要；拒绝/取消/无提供者均不执行；修订不能复用批准；直接 runtime 调用也受闸；父/Run/资源配置改变标 stale；all→off 不释放待审，off→all 在准入前补审；递归 worker 无新增管理工具。分别断言状态、事件、工具调用次数和父图不变。

**验收证据锚（实现事实见主 guide §5.10，测试位置与结果见历史执行记录 T2+T3 记录「验收项对应（T2）」行）**：`tests/integration/proposal-review.spec.ts`（真实 DSH loop + scripted provider，15 项，覆盖上列每条与闸分类、known wait、replay 不入审）、`task-runtime/tests/unit/proposal-lifecycle.spec.ts`、`task/tests/unit/proposal.spec.ts`、`agent-singularity/tests/unit/{proposal-review,task-proposal-tools}.spec.ts`。

### T3：审批恢复、准入幂等与节点修订案例（2026-09-23 已实现，已验收）

前置 T1 与 A3，组内消费 T2 的提案合同。范围：§6 的 requestKey、审批持久化恢复、准入与派发交接，复用 A3 批次推进；接入现有展示和继续入口。T2/T3 全部验收才开放 all，并允许依赖该组的 A0 开始。

验收：在“待审”“批准已保存但未准入”“准入已提交但未 spawn”“run/session 已建立”四个明确点注入崩溃并重开服务；相同请求不重复建提案/子任务/run，已通过兄弟不重跑；两个获批提案竞争同一父只准入一批；身份不明的运行不能擅自再执行。测试使用可控 promise/故障点，不用 sleep 竞争。

补一条模型协议 fixture：第一次提案被机器或人拒绝，agent 根据诊断生成新提案，批准后由系统执行并验证。fixture 证明接线与状态，不证明真实模型生成质量；真实模型实验另记成功率和失败样例，不阻塞确定性协议验收，也不冒充已实跑。

**验收证据锚**：`tests/integration/proposal-recovery.spec.ts`（真实 JSONL 重开，12 项：四个崩溃点、同请求幂等、兄弟不重跑、两提案竞争、off→all 补审、all→off 不释放、限额变化 stale；故障点用 `parkDrain`/挂起 worker 等可控 promise，不用 sleep 竞争）；模型协议 fixture 在 `tests/integration/proposal-review.spec.ts` 的「lets a refused agent read the refusal off the record and run a revised batch」（文件头注明只证明接线与状态）。整组状态为已验收，验收记录见建设计划。

### 后续才做的事

T1–T3 不需要预建大 Task 库。后续共享模板只存已观察的适用条件、目标/AC 模式和参数约束，实例化仍走相同准入。模板检索未命中直接允许构造；命中不跳过审核。模板晋升按 S4 的目标指标处理，不能仅靠“生成任务更多”判断改进。

自动 GAP 修复、PARTIAL/UNKNOWN 处置、blocked 恢复按建设计划的 A6/S2-R/S3 交付组建设，必须先完成其运行、评估与诊断前置；不要求模板平台或所有任务开启人审。审核本身不新建执行次数，但已启动的父 Run 仍受 A3 根期限约束；期限到达按取消规则结束，不能把审批拒绝解释为验收失败。取消后重提不重置根预算。

## 9. 执行与完成记录

派发 T1 或 T2/T3 交付组时阅读 [公共执行合同](execution-prompts/README.md)，以本文件对应小节及建设计划唯一顺序作为范围和验收，不扩展到其他票。修改前保存实际 Git 基线；先 build 再执行全部 Singularity 单测、集成测试、持久化检查和 diff 检查。事件兼容性与历史记录反例必须覆盖。

本节原记录的是一次“只改设计文档与派发合同”的编辑：当时没有增加运行时配置、事件、工具或生产行为，也没有重新运行 P1–P4 代码测试。此后 T1（2026-09-21）与 T2/T3（2026-09-22/23）已分别交付并留下执行与验收记录——契约字段、身份算法、策略、提案事件、工具与恢复入口都已落地，当前事实以主 guide §5.6/§5.10 与建设计划对应节为准；本文件正文中仍标为“目标/待建”的段落只描述尚未交付的部分。
