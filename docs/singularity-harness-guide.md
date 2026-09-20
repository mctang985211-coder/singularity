# Singularity Harness 工作指南

复核日期：2026-09-21。审计基线：Singularity `b00915c`，外层 harness `6c5eb49894`。
这两个提交保存了修改前的已跟踪及非忽略新增文件；第三方 DSH 子模块原有未跟踪文件不在这两个提交内。

本文是当前方向与进度的入口；[建设计划](2026-09-20-vrtc-code-change-plan.md)规定下一步落点和验收。
[术语表](../CONTEXT.md)定义概念。[历史指南](history/2026-09-21-harness-guide-snapshot.md)保留旧 §4.2 #1–#33、W/M 记录和操作经验，历史结论不能直接当成当前事实。

设计依据是 `/home/ROXY/code/ref/docs/VRTC-最小架构-KISS版-v2.0.md`，其正文版本为 **v2.1-KISS**，下称 KISS；旧 RFC 为同目录 `细化想法4.md`。
本次不修改外部参考文档。下面区分“源码事实”“建设目标”“本次设计选择”；设计选择是工程推导，不冒充此前的人类裁决。

## 1. 方向与边界

构建由可验证契约约束、允许节点自主分解的任务运行时。图是执行拓扑，Task 是语义单位，TaskRun 是一次执行，Session 是会话载体；不能把节点结束等同于任务通过。

1. **Task 固定目标、约束、验收，不固定 workflow。** 父节点与子节点都可提出分解，Harness 负责准入、依赖、资源授权和验收。依据：KISS §0、§3、§5。
2. **按验证边界拆任务。** 有独立输入、产物、验收且拆分有收益才拆；不要把每次 tool/skill 调用都变成节点。依据：KISS §4.1、§6、§12。
3. **Task 声明 capability，执行时选择 skill。** 运行前建立可行路径，运行中允许在授权范围内选择方法。依据：KISS §2、§3 I2、§11 第 3 条。
4. **通过由 verifier 与 evidence 决定。** 子全通过只是组合验收的一项输入，父目标还需要自己的判据。依据：KISS §6 C1–C4。
5. **缺口可见、升级有出口。** 缺能力时可规划和求助，不能把 `decomposable` 当成能力已具备，也不能靠无限分解消除缺口。依据：KISS §7。
6. **先可靠验收，再自动生长能力。** 复盘可提案，生产能力、验证标准与权限的变更走验证和既有授权边界。依据：KISS §8.1、§9、§12。

DSH 提供 agent/session、skill 发现与加载、preset、MCP、上下文与原生审批。Singularity 负责任务契约、能力选择、证据、组合验收、缺口恢复与复盘。继续使用现有服务，不另造通用 skill loader 或全局调度平台。

**当前阶段判断**：已有递归执行和证据记录的工程骨架；P3 能力保障与 KISS 的验证闭包尚未完成。Review/Evolution 有较完整的机械链路，不等于前置正确性条件已满足。下一阶段应补执行与验收的约束，不继续扩大 Evolution 自动化。

### 1.1 需要干预的建设倾向

2026-09-21 的工程判断：核心方向保留，建设范围收缩。KISS 是目标约束清单，不是要求一次实现所有对象、四值判决、成熟度、召回和进化管理的产品清单。已有 Evolution 链路保留使用；新增工作优先支持一个能验证、能失败、能恢复的小型端到端任务。

- **自由探索的单位是方法选择。** 节点可选择工具、skill、尝试路径或有价值的分解；不必为每个思考和工具调用建立 Task。研究型任务可以验收可追溯结论、实验结果和仍未解决的问题，不能要求未知问题一开始就具备答案或完整执行路径。
- **验证强度与交付风险匹配。** 工程交付采用客观判据；启发式判断明确标记不确定性。Capability 预检只证明声明资源可用，不能承诺搜索路径必然成功，也不能自动证明自然语言契约完整。
- **自进化分级、可回退。** 首个实现闭环选 skill/能力映射这一类候选，但完整目标仍包括 Task 模板、上下文、preset、routing、Verifier、admission 与 runtime policy 的改进。Supervisor 可以生成、实现和验证这些候选；敏感等级决定验证与人审要求，不能把高风险改进永久改成“由人来实现”。依据：细化想法1 §十三、细化想法3 的四级 mutation hierarchy、细化想法4 §30–§33。
- **元数据只记录当前决策会用的内容。** Skill 契约在 provider 准入或晋升真正消费时再加入；先让选定能力可用、运行可追溯。不要先建全领域能力本体、五级成熟度平台或通用语义规划器。
- **每次建设交付一个自主闭环。** 下一条主线是“小任务独立父验收 → 明确缺口 → agent 复用/组合或生成候选 → 沙箱验证 → 人审改进 → 生效并恢复 → 可回放记录”。人为设置缺口是测试输入，不是让人编写缺失能力。恢复协议与最小 L1/L2 同批验收；完整侧车平台不应阻塞该闭环。

逻辑职责保持清楚即可，不要求每项再建一个包：Task 保存契约与状态，能力解析决定执行资源，运行时驱动会话，Verifier 产生证据，Review/Evolution 消费终态记录。图与画布展示这些事实；禁止把业务决策复制进 UI 或不同工具处理函数。

### 1.2 Supervisor 与人审的职责（2026-09-21 纠偏）

此前“先人工补能力，再替换成 L1/L2”的排期撤回。它把开发调试手段误写成了产品路径，与用户的自主进化目标及 KISS §12 第 3 步的验收不符。人类审核 supervisor 提出的改进及验证证据，不承担正常情况下的技能编写、能力配置、重规划或手动恢复。

| 角色 | 正常职责 | 边界 |
|---|---|---|
| 执行节点 / 父节点 | 执行、发现缺口、当前授权内检索/组合方法、重规划/分解 | 不修改根契约，不直接覆盖生产能力 |
| Supervisor（外层改进角色） | 消费轨迹与 Diagnosis，定位原因，构造并实现候选，组织 sandbox/replay/regression，提交改进差异与证据 | 不是凭自身结论批准改进；复用现有 Review/Evolution 工具，不要求每节点常驻 supervisor |
| Verifier / Validation Gate | 独立检查任务产物与候选改进，比较基线、回归与 holdout | 人审不能代替客观验证，候选不能通过弱化当前验收来过关 |
| 人类 | 审核 supervisor 的改进点、风险及证据；批准或拒绝晋升 | 无需亲自补 skill；授权后由系统应用、重检并恢复 |

这是目标职责分配；当前已有 review agent 与 Evolution 工具，不等于已有自动 supervisor 调度闭环。该缺口纳入 S2/S3，不能再用人工作业替代验收。

来源对照：细化想法1 §十三/§二十要求 outer agent 改 Harness、缺技能后搜索/组合/生成并受控晋升；细化想法2 §四要求显式能力解析与缺口处置；细化想法3 要求当前阶段闭包和分级 mutation；细化想法4 §12、§30–§33 明确阶段闭包、候选验证及 Human Governance；KISS §7、§12 要求 L1/L2/L4 与自动补路径的验收。

这些材料也保留 **L4 例外上报**：已有能力无法解决、需要新的外部权限/资源、预算耗尽或残余 UNKNOWN 时，由系统提供 what/tried/suggested 请求决策。正常缺口应先走适用的 L1/L2，L3 按权限策略；不能默认送给人。KISS 的 GAP L1–L4 与 RFC 的 mutation Level 1–4 是两套编号，不混用。

**当前阶段闭包不等于整个 Task 的未来路径全部已知。** 只要当前动作有能力、预算与授权，可先执行探索；遇到新缺口再进入恢复/进化。当前配置查表和 fail-closed 准入只是实现现状，目标仍包含 PARTIALLY_CLOSED。Supervisor 不得为了消除 GAP 虚报能力已具备。

## 2. Task 与 Skill 怎样协作

### 2.1 选择：派发前解析，节点内按需加载

| 方案 | 收益 | 成本与边界 | 定位 |
|---|---|---|---|
| Task 契约直接写死 skill | 已知任务的选择成本低 | 换实现会改契约；易形成任务与技能一一对应；仍不能保证工具可用 | 不作为契约模型；固定实现可留在一次 run 的记录中 |
| 每个子节点拿 Task 后从全库找 skill | 探索自由度高 | 每个节点重复检索；找不到或权限不足到执行期才暴露；结果难复现 | 缺口恢复或探索场景使用 |
| Task 提 capability，Harness 派发前解析，子节点按需加载正文 | 复用配置、提前发现已知缺口，减少重复搜索与正文注入 | 需要可追溯的解析结果和明确的运行期缺口出口 | **默认方向** |

第三种更适合当前重复的 BB 工程任务；这是机制上的成本判断，**没有 A/B 数据证明它在所有任务上最快**。检索开销、总 token、首个有效工具调用延迟、成功率及 GAP 率应一起比较。开放任务允许补充发现，但发现一个 skill 不等于获得它需要的工具或权限。

**绑定发生在 TaskRun，不发生在 Task Contract。** Task 说“需要验证能力”，部署表选择实现；worker 决定具体如何使用已选方法。Skill 是指导内容，grant 是注册与授权，`skill` 调用是读取正文，三者不是自动执行脚本。

### 2.2 当前执行链路（源码事实）

```text
父节点 / 可分解子节点
  capability_list -> task_decompose(children.requiredCapabilities)
  -> checkDecomposition + resolveCapabilities（查部署配置表）
  -> 保存 Task / CapabilityManifest
  -> 按 dependsOn 顺序运行就绪子任务
  -> 检查 requiresArtifact -> Handoff + 独立 Session
  -> grant tools / 注册 skills / 挂载 MCP / 选择 preset
  -> worker 按需调用 skill，执行或继续 task_decompose
  -> verifier -> EvidenceBundle -> task 状态 -> 父验收
```

源码入口：`task-runtime/src/index.ts` 的 `decomposeAndRun`、`task-runtime/src/capability.ts` 的 `resolveCapabilities`、`task-runtime/src/orchestrate.ts` 的 `runChildrenCascade`、`agent-runtime/src/grants.ts` 的 `applyWorkerGrant`。

- `resolveCapabilities` 只查表并展开工具标签，返回 `closed` 或 `gap`；虽然类型含 `partial`，实现不产生它。`closed` 表示声明的名字已命中，**不表示 skill 前置条件或产物契约已闭包**。
- 缺 capability 且子任务未标 `decomposable`：拒绝整批子任务，另在父任务记录 Obligation。标了 `decomposable` 可以准入并启动规划 worker；执行安全仍依赖后续分解与授权约束。
- 多个命中能力的 skill/tool 合并，preset 只能有一个不同的声明值；同名合并，不同名在能力解析时拒绝，不再按能力顺序选第一个（2026-09-21 样本改造）。无声明才使用部署默认 preset。Skill 不存在仍到 spawn 的 `grantSkills` 才报错。
- DSH skill grant 保证内容在 worker 的 skill 层注册；全局目录仍可能显示其他 skill，**没有按 worker 隐藏目录的保证**。工具授权另由 grant 限制；preset 自带工具与 MCP 挂载也是授权面的一部分。
- 本次修复：worker baseline 增加只读 `capability_list`。原先 `task_decompose` 指示先查能力表，但 worker 过滤器把它剔除，导致递归节点只能猜能力名。`graph_spawn`、Evolution 与平台审批工具仍不进入 worker baseline。

### 2.3 最小建设目标（尚未实现）

先保留显式能力表作为唯一 provider 选择入口；不要立即引入向量检索、自动排名或通用规划器。

1. **准入期预检已选实现**：skill 可发现、所需工具/MCP/preset 可配置。多个 preset 冲突检查已完成，其余预检待建。预检不能保证 MCP 启动成功，spawn 仍需实际校验，失败要指向相同的缺口类型。
2. **worker 收到自己的精简能力摘要**：选中的 capability、skill 名称/用途、工具边界和未解决缺口；通过 DSH 按需读正文。当前 handoff 没有这个专门摘要，不应写成已实现。全局 skill catalog 的 token 成本仍存在。
3. **run 记录实际选择**：除了现有名称快照，还需记录 capability 表修订、skill 内容摘要或版本、preset/MCP 配置身份。现有 `capabilitySnapshot: string[]` 不足以复现内容。
4. **运行中发现缺口**：先检查已授权能力能否回答，再提出有验收标准的获取/分解任务；无可行路径则上报。加载另一份指导不扩权，不自动安装工具，不修改当前 Task 的 AC。

一个 capability 可有多种 skill 实现，一个 skill 也可服务多个任务。首版仍由部署选择一组实现；有真实替换需求和测量数据后，再做多候选排序。

### 2.4 执行型与知识型 Skill

KISS §4.2 的 Skill 指能提供可验证能力的执行实现；DSH 的 `SKILL.md` 还承载领域知识。两者需要明确区分，避免“知识没有执行 verifier，所以整个能力机制建不动”。

| 类型 | 内容与验证要求 | 是否能单独关闭执行能力缺口 |
|---|---|---|
| 执行型 | 声明提供的 capability、前置条件、输入/输出、required tools、verifier 引用；用正负样本验证实现效果 | 经契约和验证检查后才可以 |
| 知识型 | 来源、适用范围、内容版本、结构/引用检查；义务模板需能解析并验证覆盖规则 | 不可以；只能帮助发现义务和选择方法 |

**本次设计选择**：侧车元数据采用带类型的契约，知识型不伪造执行 verifier，也不计入执行闭包；它仍需内容检查和变更审查。这是对 DSH 内容类型的划分，不是给执行型 skill 开“未验入库”豁免。

侧车注册表尚未建设，确切 schema 留在实现票中。第一版只加入上述决策必需字段；成熟度五阶段、成功率衰减与统计排名后置。注册表负责元数据，DSH 继续负责正文加载。`evolution_apply` 检查也不是唯一入口：启动配置与新增/替换 provider 都必须经过同一校验。

领域包包含义务模板、执行 skill 与参考 verifier。模板只提问，不规定 C→BEMU→Compiler→RTL 的固定步骤。`dependsOn` 可以表达本次任务中确实存在的证据依赖；它不是被禁用的 API。

## 3. 建设顺序与完成条件

详细票据见 [建设计划](2026-09-20-vrtc-code-change-plan.md)。以下是依赖顺序，不是任务执行 workflow。

可先派发的确定性工程切片见 [执行 prompt](execution-prompts/README.md)：P1 类型闸 → P2 单文件 Skill 内容绑定 → P3 生产基线冲突检查。P1 已于 2026-09-21 完成并同步本文；P2、P3 仍待执行，必须逐项验收并同步本文；不替代 S2/S3 的自主修复与恢复闭环。

| 顺序 | 建设目标 | 完成条件 |
|---|---|---|
| S0 | 文档基线与递归能力发现 | 状态统一；worker 能查询能力表且没有获得管理工具 |
| S1 | 可信验收与可追溯能力绑定 | 错产物不通过；父 AC 有组合验证；不存在的 skill 和冲突 preset 在派发前拒绝；run 可定位实际实现 |
| S2 | 缺口处置、supervisor 交接与恢复 | 缺口持久化、去重；将诊断/候选工作交给 agent；补足后系统恢复受影响任务；与 S3 同批验收 |
| S3 | L1 复用/组合，再 L2 生成 | 制造 GAP 后由 agent 自动补路径；新候选通过验证并经人审晋升后系统恢复，无需人工补写能力 |
| S4 | Retro 与自动接受规则 | observed/holdout 分开过关；按变更目标使用不同指标；坏候选被拒绝 |

S1 的最小验证与能力契约是候选生产晋升的前置。S2 与 S3 按同一条缺口案例共同建设：协议可先定义，恢复测试可注入 fixture，但正式验收必须由 agent 自动产出解决路径，不能止于人工填配置。L3 引入新工具继续走权限流程。长期记忆、通用全局调度器、复杂 skill 成熟度系统后置，均不替代最小自主改进闭环。

## 4. 当前实现与缺口

### 4.1 源码复核表

本表均复核于 2026-09-21；状态描述的是明确范围，不把“类型有字段”算成整项完成。函数名是定位锚，行号以当前 checkout 为准。

| 能力 | 当前事实与限制 | 源码锚 |
|---|---|---|
| Task / TaskRun / 递归分解 | 有独立对象、事件存储、结构准入、树与依赖 DAG、顺序级联；原子性和自然语言 AC 覆盖不由机器证明 | `task/src/types.ts`；`task-runtime/src/admission.ts:checkDecomposition` |
| Task 定义版本 | 有 `definitionRef`；普通子任务使用 `subtask@1`，不等于完整不可变定义库和变更授权机制 | `task-runtime/src/index.ts:decomposeAndRun` |
| Capability | 配置表解析与真实 grant 已建；没有完整 skill 契约预检、可行性证明或多候选选择 | `capability.ts:resolveCapabilities`；`grants.ts:grantSkills` |
| Handoff / 上下文 | fresh session、结构化 handoff、父会话引用、契约重注入已有；不是父 transcript 全复制 | `task-runtime/src/handoff.ts`；`agent-runtime/src/contract-reinjection.ts` |
| Evidence 依赖 | `requiresArtifact` 检查 store 中 evidence id / artifact id / kind 的存在性；缺失则 blocked + Obligation；不自动生成上游，也不验证匹配证据的通过状态、版本和适用性 | `orchestrate.ts:missingRequiredArtifacts` |
| Obligation | 记录缺能力/缺产物；模板 coverage 由任务声明 capability 或文字提及匹配；不是义务已被证据满足，更不是防漏的硬闸 | `task-runtime/src/obligation.ts:checkObligationCoverage` |
| 判决 | `pass/fail/inconclusive`；部分 unknown 有 task/verifier 分类；没有 PARTIAL 状态与剩余义务自动派发；未通过 mandatory 判据仍走失败路径 | `task/src/types.ts:VerificationResult`；`orchestrate.ts:unmetMandatory` |
| Verifier 边界 | 已校验单个判据返回数量、criterion/verifier 身份及判决；异常归为 UNKNOWN(verifier)。可选 selftest 仍只描述、不执行，尚无独立性隔离 | `verifier/src/index.ts:verifyCriterion`、`register` |
| 父验收 | 默认 composite 只检查所有子任务 verified；没有 C2 覆盖映射、C3 假设满足性、C4 独立全局不变量 | `verifier/src/composite-verifier.ts:verifyIn` |
| 预算 | wallTimeMs 在飞取消；tools/tokens 仅终态审计；attempts/noProgressRounds 仅声明 | `orchestrate.ts:awaitWorker`、`budgetBreaches`；`task-runtime/src/index.ts:Config` |
| L4 上报 | root 的 `escalate` 工具与台账已有；模型主动调用，批准后才记 raised；运行时只输出提示，无自动触发、无处理结果/恢复闭环 | `agent-singularity/src/tools/escalate.ts`；`orchestrate.ts:escalationHint` |
| blocked 恢复 | blocked 无恢复出边；TaskRetried 只接受 failed，父分解一次的限制仍在；补能力后不会自动续跑原图 | `task/src/service/state.ts`；`task-runtime/src/index.ts:decomposeAndRun` |
| Review / Evolution | 已有工具链；机械候选 PROMOTE/apply 要求 observed、holdout 各自非空且不退化，报告按明细重算并校验记录时摘要。未实现候选内容绑定、真实证据来源校验、分层指标或自动 Retro | `agent-singularity/src/evolution.ts:checkPromotion`；`replay.ts:assertReplayReport` |
| root-agent 构建类型闸 | `agent-singularity` 的 `build` 为 `tsc --noEmit && tsdown`，类型错误即构建失败；工作区根 `pnpm build`（`pnpm -r run build`）经过同一检查。2026-09-21 前该包 `pnpm build` 只有 tsdown，不保证严格类型检查通过 | `agent-singularity/package.json` scripts.build |
| 身份与枚举的类型来源 | 工具侧 `sessionId(exec)` 直接返回上游 `Agent.id` 的 `SessionId`，不再降级为 `string`；`DiagnosisProposal.targetType` 与 `evolution_propose` 的 targetType 由 `@dangosys/dsh-singularity-task` 的 `ProposalTargetType` 标注并经运行时校验，不是任意字符串断言 | `agent-singularity/src/tools/task-diagnose.ts:toProposals`；`src/tools/evolution-propose.ts:isProposalTargetType`；`src/evolution.ts:validateMutation` |

### 4.2 优先修复的断层

| 编号 | 问题与影响 | 建设票 / 历史对应 |
|---|---|---|
| G1 | 父 composite 仅对子状态求合取，不能证明根目标；同环境执行 verifier 也不等于测试与阈值不可被修改 | S1-V / 旧 #25、#26 |
| G2 | provider 未预检、内容版本未固定；`closed` 被误用为可执行保证。多 preset 冲突已在解析期拒绝 | S1-C / 旧 #29 |
| G3 | 缺产物只查存在且 blocked 无恢复，证据驱动生长断在登记之后 | S1-V、S2-R / 旧 #20、#21、#22 |
| G4 | 上报依赖模型调用且批准前不落账；任务阻塞、通知与人类决策混在一起 | S2-E / 旧 #27；已有工具不能标为待建 |
| G5 | 三值判决、预算半接线，没有 PARTIAL/UNKNOWN 的任务级处置 | S2-R / 旧 #23、#24 |
| G6 | 缺 skill 契约与知识型定位，L1/L2 又被排在其前面，形成建设依赖倒置 | S1-C → S3 / 旧 #29 |
| G7 | 已补报告自洽与机械晋升最低闸；候选内容/证据来源绑定、分层指标和自动 Retro 未建，当前不能宣称防止裁判弱化或过拟合 | S4 / 旧 #28 |
| G8 | `task_decompose`/`escalate` 部分拒绝返回普通文本，上层不能可靠用工具错误信号判定 | S2-E / 旧 #33 |
| G9 | 类型闸只覆盖 `agent-singularity`；其余 Singularity 包的 `build` 仍只有 tsdown，未接 `tsc --noEmit`，其严格类型状态未经本闸保证 | P1 范围外，待独立评估 |

历史记录中的 M1–M9 为此前会话的实跑声明，保留于历史指南。本次回归结果见建设计划 S0；本次没有重跑 LLM、BB 构建仿真或生产 Evolution 链路。旧环境可用性、外部 bbdev 缺陷和部署阈值在使用前需重新读取对应部署，不能从旧日志推断当前状态。

2026-09-21 的 P1 已关闭“root-agent 包 build 不执行严格类型检查”这一缺口：该包 `pnpm exec tsc --noEmit` 从 12 处错误降到 0，`build` 改为先 `tsc --noEmit` 再 `tsdown`，工作区根 `pnpm build` 同样经过。G9 是 P1 明确未做的剩余部分：类型闸没有推广到其他包，也未改变任何业务流程、审批次数、持久化格式或工具输入输出合同。G7 的候选内容/证据来源绑定仍待建，由 P2/P3 推进，不因 P1 完成而标记 S1-C/S4 完成。

## 5. 实现时的关键约束

### 5.1 验收先于自动生长

现有 command verifier 与 worker 共享 checkout：外部进程运行命令只提供执行分离，不保证 worker 无法修改测试、脚本或阈值。建设目标是固定验收输入的来源与版本，保护判据，记录 verifier 版本及证据产物身份；自述 JSON 和退出 0 均不能单独证明领域正确性。

组合验收先针对一个客观的小任务实现父 AC → 子证据映射和独立父级检查。不需要先做通用自然语言蕴含求解器。能机械判断的接口/数值写成检查；启发式覆盖显式标注，不能记成确定性闭包。

### 5.2 缺口恢复从有限状态开始

目标是记录缺口、选择处置、验证修复、重新检查依赖，再恢复待运行任务。先定义事件与状态迁移，保留原 Task 契约和每次尝试；不要直接把 blocked 改成 ready，或要求父节点再次提交同一批已落库子任务。

缺口通知本身与“批准新增工具/改生产 skill/接受残余风险”是不同动作。本次建议自动记录和通知缺口，后者继续请求授权；**当前实现仍是 approve 后写 raised，不能把目标写成已上线行为**。worker 可报告失败原因，由父级/root 接收；本次不把管理工具下发给 worker。

### 5.3 运行和验证

开发构建从 Singularity 目录执行 `pnpm build`；测试从外层 harness 执行：

```sh
pnpm vitest run --project unit packages/singularity
pnpm vitest run --project integration packages/singularity
```

`agent-singularity` 的 `build` 是 `tsc --noEmit && tsdown`（2026-09-21 P1 起），因此 `pnpm build` 与该目录下的 `pnpm exec tsc --noEmit` 结果一致；工作区根 `pnpm build` 通过 `pnpm -r run build` 经过同一检查。构建会清理并重写 `lib/`，不要与清理 lib 的构建并行跑测试。修改该包 src 后必须先有零类型错误才能打包；不得用 `any`、`ts-ignore`、关闭 `strict` 或排除源文件来消除诊断。其余 Singularity 包尚未接入该闸（见 G9）。

事件声明有变化时执行持久化 schema 纪律，见 [persistence-changes](persistence-changes/README.md)；纯工具白名单改动不改变事件 schema。`pnpm run verify-persistence` 校验声明指纹。

部署配置以当前 `config.yml` 和 `capability_list` 为准。BB 验证通过项目 MCP 跑本地工具链；具体 env、preset、超时和判据 cwd 读当前部署与领域指导，不在通用架构中写死。

### 5.4 后续模块的参考风格

参考 `task-runtime/src/capability.ts` 的 `resolveCapabilities` / `resolvePreset` 和对应 capability、orchestrate 测试。本次样本只修复能力组合的确定性与准入时机，不代表整个文件或全部预检已完成重构。

1. **决策集中，副作用后置**：输入声明和配置，纯函数给出解析结果或明确错误；通过后才创建任务、会话或写日志。一般执行与 replay 共享规则。
2. **有冲突就显式拒绝**：两个 preset 不能靠声明顺序决定。缺省值只用于未声明，不用于掩盖互相冲突的声明。
3. **接口只暴露调用者需要的内容**：能修改现有函数解决就不加 resolver-manager、策略工厂或通用插件层。存在第二种真实实现再考虑替换接口。
4. **注释解释必要约束**：说明“一 worker 只能挂一个 preset”等原因；历史编号、完整论证与进度留在文档，避免每个函数携带一段历史报告。
5. **测试可观察合同**：能力顺序改变不改变选择、冲突整批拒绝且零任务落库、replay 同样拒绝；不按私有函数数量或类层次写测试。
6. **按职责变化拆模块**：`orchestrate.ts` 已超过千行，但不以行数为理由机械切文件。后续恢复工作应集中管理同一任务的运行/阻塞/恢复；终态观测与 Review 生成可独立收敛。每次只迁移一个职责，保证旧调用方同时更新。

### 5.5 演进验证参考样本（2026-09-21）

第二个样本是 `replay.ts` 的纯比较/报告校验与 `evolution.ts` 的晋升入口：工具在人审前预检，服务在决定及生产写入前复检。无 holdout、manual、退化或不可比较的报告可留档研究/拒绝，但不能机械晋升。坏 verifier 返回不得成为任务成功证据。

报告 SHA-256 只保证 gate/decide/apply 读取的是记录时的报告；它不证明报告来自真实执行，也不固定 sandbox 文件。不同 task id 只是样本身份不重用的最低检查，不证明统计独立。相同失败结果仍可能“不退化”，所以最低闸不是“改进有效”的证明。下一步必须补候选内容摘要、原始 run/evidence 对照和按目标制定的改进指标。

agent_preset 当前只生成 manual replay，因此暂不能通过机械 PROMOTE；应补沙箱 preset 执行器，而非绕过验证。缺摘要的旧 ledger 可读、已应用对象可回滚，但后续晋升需新建候选并重新评估。L4/未支持目标缺少执行器是实现缺口，不是要求人代写改进的永久规则。

## 6. 文档维护

- 本文只维护方向和当前事实，建设计划只维护票据与验收；实施日志进入带日期记录。
- 每项完成状态必须写清范围、复核日期、源码/测试锚；区分声明、接线、自动测试、真实端到端运行。
- 同一改动同步更新本文的状态和建设计划。部分完成继续标“部分”，不可用“完成（核心未做）”。
- 新设计写成“建设目标/设计选择”；与 KISS 的差距保留为明确缺口，不以已有代码反过来宣称目标已达成。
- 历史材料只作来源，不与当前指南竞争规范地位。旧编号查询历史快照，新工作使用 S/G 编号。
