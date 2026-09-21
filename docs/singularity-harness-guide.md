# Singularity Harness 工作指南

复核日期：2026-09-21。审计基线：Singularity `8469388`（T1 修改前），外层 harness `63c25a14b0`。
这两个提交保存了修改前的已跟踪及非忽略新增文件；第三方 DSH 子模块原有未跟踪文件不在这两个提交内。

本文是当前方向与进度的入口；[建设计划](2026-09-20-vrtc-code-change-plan.md)规定下一步落点和验收。
[术语表](../CONTEXT.md)定义概念。[历史指南](history/2026-09-21-harness-guide-snapshot.md)保留旧 §4.2 #1–#33、W/M 记录和操作经验，历史结论不能直接当成当前事实。

深入实施入口：[Task 契约与可选人审](task-contract-construction-guide.md)、[有目标的探索/自进化架构](exploration-evolution-architecture.md)、[角色与 System Prompt 合同](agent-prompt-contracts.md)。[开源机制调研](2026-09-21-open-source-agent-patterns.md)记录已读取的一手来源；新协议均标记待建，不能用设计替代当前实现事实。

设计依据是 `/home/ROXY/code/ref/docs/VRTC-最小架构-KISS版-v2.0.md`，其正文版本为 **v2.1-KISS**，下称 KISS；旧 RFC 为同目录 `细化想法4.md`。
本次不修改外部参考文档。下面区分“源码事实”“建设目标”“本次设计选择”；设计选择是工程推导，不冒充此前的人类裁决。

## 1. 方向与边界

构建由可验证契约约束、允许节点自主分解的任务运行时。图是执行拓扑，Task 是语义单位，TaskRun 是一次执行，Session 是会话载体；不能把节点结束等同于任务通过。

1. **Task 固定目标、约束、验收，不固定 workflow。** “固定”指接受契约后不随意改题，不指所有任务必须由人预先编写。父节点与子节点均可按规范生成任务，不要求命中模板；Harness 负责准入、依赖、资源授权和验收。依据：KISS §0、§3、§5。
2. **按验证边界拆任务。** 有独立输入、产物、验收且拆分有收益才拆；不要把每次 tool/skill 调用都变成节点。依据：KISS §4.1、§6、§12。
3. **Task 声明 capability，执行时选择 skill。** 运行前建立可行路径，运行中允许在授权范围内选择方法。依据：KISS §2、§3 I2、§11 第 3 条。
4. **通过由 verifier 与 evidence 决定。** 子全通过只是组合验收的一项输入，父目标还需要自己的判据。依据：KISS §6 C1–C4。
5. **缺口可见、升级有出口。** 缺能力时可规划和求助，不能把 `decomposable` 当成能力已具备，也不能靠无限分解消除缺口。依据：KISS §7。
6. **先可靠验收，再自动生长能力。** 复盘可提案，生产能力、验证标准与权限的变更走验证和既有授权边界。依据：KISS §8.1、§9、§12。

DSH 提供 agent/session、skill 发现与加载、preset、MCP、上下文与原生审批。Singularity 负责任务契约、能力选择、证据、组合验收、缺口恢复与复盘。继续使用现有服务，不另造通用 skill loader 或全局调度平台。

**当前阶段判断**：已有递归执行和证据记录的工程骨架；KISS 的 P3（Capability Runtime）能力保障与验证闭包尚未完成（与 §3 的 P3 执行票不是同一件事）。Review/Evolution 有较完整的机械链路，不等于前置正确性条件已满足。下一阶段应补执行与验收的约束，不继续扩大 Evolution 自动化。

### 1.1 需要干预的建设倾向

2026-09-21 的工程判断：核心方向保留，建设范围收缩。KISS 是目标约束清单，不是要求一次实现所有对象、四值判决、成熟度、召回和进化管理的产品清单。已有 Evolution 链路保留使用；新增工作优先支持一个能验证、能失败、能恢复的小型端到端任务。

- **自由探索包括方法选择和任务构造。** 节点可选择工具、skill、尝试路径，也可针对未满足义务生成有验收边界的任务契约；模板是可选参考，不是准入白名单。不必为每个思考和工具调用建立 Task。研究型任务可以验收可追溯结论、实验结果和仍未解决的问题，不能要求未知问题一开始就具备答案或完整执行路径。
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
  -> normalizeDecomposition（唯一规范化入口：闭合字段集、默认值、criterion id、批次摘要）
  -> checkDecomposition + resolveCapabilities（查部署配置表）
  -> 保存 Task（含规范化 contract）/ CapabilityManifest / 批次准入记录
  -> 按 dependsOn 顺序运行就绪子任务
  -> 检查 requiresArtifact -> Handoff + 独立 Session
  -> grant tools / 注册 skills / 挂载 MCP / 选择 preset
  -> worker 按需调用 skill，执行或继续 task_decompose
  -> verifier -> EvidenceBundle -> task 状态 -> 父验收
```

源码入口：`task-runtime/src/normalize.ts` 的 `normalizeDecomposition`、`task-runtime/src/index.ts` 的 `decomposeAndRun`、`task-runtime/src/capability.ts` 的 `resolveCapabilities`、`task-runtime/src/orchestrate.ts` 的 `runChildrenCascade`、`agent-runtime/src/grants.ts` 的 `applyWorkerGrant`。

- `resolveCapabilities` 只查表并展开工具标签，返回 `closed` 或 `gap`；虽然类型含 `partial`，实现不产生它。`closed` 表示声明的名字已命中，**不表示 skill 前置条件或产物契约已闭包**。
- 节点提交的批次先经过 `normalizeDecomposition`（唯一规范化入口，T1）：闭合字段集、默认值、criterion id 固定、批次摘要；被拒绝的批次在铸 id 和落库之前返回，且零副作用。之后才进入结构准入与能力解析。
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

执行只使用 [建设计划](2026-09-20-vrtc-code-change-plan.md)文首的唯一派发顺序与完成闸。每票承诺的准入、执行、拒绝、取消、恢复和真实接线一起验收，存在缺口先修复再推进依赖项；T2/T3、A5/S2-E、A6/S2-R/S3 各作为一个交付组。不新增提前运行的图版本或独立试点路线，场景测试属于对应票的验收。已支持行为必须完整，未支持扩展在入口显式拒绝，二者不混称“部分可用”。

### 上下文、协作与诊断的方向决定

节点默认继承结构化契约与 handoff，不复制祖先完整聊天；全局观由真实根目标/硬约束、当前任务的贡献、相关决定与证据引用构成，细节按授权范围查询。沿用 DSH scoped system prompt 和 Session 原始日志，摘要仅改变视图，不能替代原始证据。Task DAG、Agent Graph、Session lineage 分别拥有事实，按 id 关联。

父子澄清必须采用非阻塞协议。当前父 `task_decompose` 等整个 cascade，子再等待父回答会循环等待；DSH 的 send_message 还要求 continuable activation，当前 Singularity spawn 未接该生命周期。近期保留现有 agent-runtime handle 所有权，复用原生 inbox/steer/resume，增加任务域问答记录；不引入第二套 agent loop/Team task board。先实现父模型可响应的批次推进、区分 idle 与提交验收，再开放问父工具。

协调主相位与阻塞问题分别记录，逐级询问不丢原批次或开放写权限；消息入箱不等于模型已消费，必须覆盖 claim 后中断的恢复。派发子节点和开始验收前均关闭新写入并确认在途写入收敛。对应故障窗口与竞态反例纳入 A3/A4，不能只靠 prompt 维持这些不变量。

任务列表分开表达可见、可准入、可运行和调用者合法动作；可见不等于可领取。首版 runtime 分派，节点可查询与提出新 Task，不做全局工作窃取。Supervisor 按去重 incident 触发、沿实际依赖与证据逐步下钻，先只读诊断，再由候选节点实现和独立验证，最后人审应用；不设每节点常驻主管，不以诊断自述取代正确性证据。

另一个前置是根契约入口：当前 graph name 直接成为根 objective，RootTaskSpec 仍以子全通过验收；P4 只提供独立父验收能力，不能宣称业务根目标已受保护。A0 将业务根任务延迟到真实用户目标/AC 被接受之后激活，setup 与目标执行分离，旧任务不原地改题。上述决定的字段、状态、DSH 复用点及 A0–A6 验收见 [深入架构](exploration-evolution-architecture.md)。

### Task 自主构造与可选人审

**方向已确定，完整协议待建**：节点可以复用、组合或直接生成任务实例，不以“先找不到模板”为必要条件。现有 `task_decompose` 已允许现场给出 objective/AC/capability；这不等于 Task 语言规范、持久化合同与审核闭环均已完成。`definitionRef: subtask@1` 不是命中了人工模板库的证明。

区分三类变更：当前目标下的新任务实例经机器准入、可选契约人审后执行；共享模板作为 Evolution 改进候选验证并晋升；已接受的根目标/AC、生产能力及权限变化走各自已有或待建的变更协议。任务生成人审开关仅影响第一类，不能绕过后两类的治理。

首版建设选择是 `generatedTaskReview: off | all`，默认 `off`，保持当前自主分解行为；`all` 审核整批分解及其内容身份，批准后再准入。此配置尚不存在，不得直接写入部署。机器校验在两种模式下都执行；无审核人、取消或拒绝不能自动视作批准。审核等待是提案状态，不借用 Task 的能力/证据 `blocked` 状态。节点负责生成与修订，人只审核契约，不代写任务，也不提前判定任务成功。

详细规范、模块落点、状态机、异常路径和 T1–T3 验收见 [Task 自主构造建设指导](task-contract-construction-guide.md)。规范限定可表达的结构与治理边界，不试图穷举人类任务，也不声称能机械证明自然语言契约完整。

详细票据见 [建设计划](2026-09-20-vrtc-code-change-plan.md)。以下是依赖顺序，不是任务执行 workflow。

先期确定性工程切片见 [执行 prompt](execution-prompts/README.md)：P1–P4 与 T1 已于 2026-09-21 完成并同步本文；下一项为 S1-V 切片 2（验证器自测与输入身份）。后续先完成验证/能力合同和 A3 生命周期，再完整交付审核、根目标与上下文/问答；S4-E 评估基础先于自动主管与候选执行。具体次序只在建设计划维护。P1–P4 与 T1 不替代自主修复与恢复闭环，也不宣称独立父验收全部完成（C3 完整证明与 verifier selftest 执行仍缺）。

| 顺序 | 建设目标 | 完成条件 |
|---|---|---|
| S0 | 文档基线与递归能力发现 | 状态统一；worker 能查询能力表且没有获得管理工具 |
| S1 | 可信验收与可追溯能力绑定 | 错产物不通过；父 AC 有组合验证；不存在的 skill 和冲突 preset 在派发前拒绝；run 可定位实际实现 |
| S2 | 缺口处置、supervisor 交接与恢复 | 缺口持久化、去重；将诊断/候选工作交给 agent；补足后系统恢复受影响任务；与 S3 同批验收 |
| S3 | L1 复用/组合，再 L2 生成 | 制造 GAP 后由 agent 自动补路径；新候选通过验证并经人审晋升后系统恢复，无需人工补写能力 |
| S4 | Retro 与自动接受规则 | observed/holdout 分开过关；按变更目标使用不同指标；坏候选被拒绝 |

上表 S 编号表示责任领域，实际派发及拆分以建设计划为准。S1 受支持合同和 S4-E 评估是候选晋升前置。A6/S2-R/S3 完整交付：故障可注入，但解决路径由 agent 产出，不能止于人工填配置。L3 引入新工具继续走权限流程。长期记忆、通用全局调度器、复杂 skill 成熟度系统后置，均不替代已承诺行为的完整验收。

运行可行性由 A3 统一保证：状态迁移、效果交接、恢复和根预算归属集中在 Task runtime；普通/replay/恢复共用规则，工作区写入归属覆盖跨批次/跨根冲突。新建子任务、候选或 Run 不重置总预算；反复同一失败、改写计划不能自动计为进展。硬限额必须可执行，未知费用不记零。

迭代有效性由 S1-C/S4-E/S2-R 衔接：Run 实际加载绑定版本，基线/候选从相同初始输入在隔离工作区比较，真实证据及冻结判据支撑结论；任务内经验不自动晋升共享能力。apply 不热换在途实现，换版本用新 Run；成功兄弟证据仅在仍适用时复用。模型成功率、回归和成本需真实实验，协议测试通过不等于已证明模型进步。以上均为待建指导，不修改 §4 的当前实现事实。

## 4. 当前实现与缺口

### 4.1 源码复核表

本表均复核于 2026-09-21；状态描述的是明确范围，不把“类型有字段”算成整项完成。函数名是定位锚，行号以当前 checkout 为准。

| 能力 | 当前事实与限制 | 源码锚 |
|---|---|---|
| Task / TaskRun / 递归分解 | 有独立对象、事件存储、结构准入、树与依赖 DAG、顺序级联；原子性和自然语言 AC 覆盖不由机器证明 | `task/src/types.ts`；`task-runtime/src/admission.ts:checkDecomposition` |
| Task 语言与生成审核 | 已能现场生成子任务，无模板命中要求。T1 已收敛为单一规范化契约与身份（见 §5.6）：`TaskContract` 数据定义、闭合字段集与默认值、criterion id 固定、单契约/整批摘要、`contract` 与 assumptions/constraints 持久化，普通分解/replay/root 共用同一入口与结构校验。仍无生成提案审核开关、审批摘要绑定与可恢复的审核状态（T2/T3） | `task/src/contract.ts`；`task-runtime/src/normalize.ts`；`task-runtime/src/index.ts:decomposeAndRun`、`replayTask`、`createRootTask`；`task/src/service/state.ts:assertContract` |
| Task 定义版本 | 有 `definitionRef`；普通子任务使用 `subtask@1`，不等于完整不可变定义库和变更授权机制。T1 固定的是契约内容身份（`contractDigest`/`proposalDigest`），未建模板库 | `task-runtime/src/index.ts:decomposeAndRun`；`task/src/contract.ts:contractDigest` |
| 根目标入口 | 当前 graph name 传给 createRootTask 作 objective；RootTaskSpec 默认仅子全 verified；尚无独立的根契约 intake/接受/激活流程 | `graphs/src/index.ts:create`；`task/src/types.ts:RootTaskSpec` |
| Capability | 配置表解析与真实 grant 已建；没有完整 skill 契约预检、可行性证明或多候选选择 | `capability.ts:resolveCapabilities`；`grants.ts:grantSkills` |
| Handoff / 上下文 | fresh session、handoff、父会话引用、契约系统投影已有；实际主要传父目标/依赖证据/assumptions，根全局 brief、带来源决定和动态有界 ContextView 待建；原始 session query 按 cwd 授权，不等于图/group 隔离 | `handoff.ts`、`orchestrate.ts:buildHandoff`；`agent-runtime/src/contract-reinjection.ts` |
| 父子交互 / 生命周期 | task_decompose 同步等待整批；whenIdle 后验收；没有持久 question/answer 与等待相位。DSH send_message 不能直接用于未注册 continuable activation 的这些子节点 | `task-runtime/src/orchestrate.ts:awaitWorker`；`agent-runtime/src/index.ts:spawn` |
| 任务导航 / 诊断 | task_read 当前任务、task_status 整树；review pack 有局部证据及父子摘要，只读 reviewer 可写 Diagnosis；无合法动作投影、因果遍历协议或自动 supervisor incident 调度 | `agent-singularity/src/tools/{task-read,task-status,task-review-pack,review-agent}.ts` |
| Evidence 依赖 | `requiresArtifact` 只认 verified run 且带 pass 判据的证据；`acceptsArtifact` 只要求存在。普通分解缺失时 blocked + Obligation；replay 的 spawn 开/关路径使用同一检查，缺失时在建任务/Run 前抛错，零派发/零成功记录。不自动生成上游，不验证匹配证据的版本和适用性 | `orchestrate.ts:missingRequiredArtifacts`、`runReplayTask` |
| Obligation | 记录缺能力/缺产物；模板 coverage 由任务声明 capability 或文字提及匹配；不是义务已被证据满足，更不是防漏的硬闸 | `task-runtime/src/obligation.ts:checkObligationCoverage` |
| 判决 | `pass/fail/inconclusive`；部分 unknown 有 task/verifier 分类；没有 PARTIAL 状态与剩余义务自动派发；未通过 mandatory 判据仍走失败路径；`heuristic` 标记的判据永远不计入确定性通过 | `task/src/types.ts:VerificationResult`；`orchestrate.ts:unmetMandatory` |
| Verifier 边界 | 已校验单个判据返回数量、criterion/verifier 身份及判决；异常归为 UNKNOWN(verifier)。可选 selftest 仍只描述、不执行，尚无独立性隔离 | `verifier/src/index.ts:verifyCriterion`、`register` |
| 父验收 | 默认无映射 composite 保持子全 verified；childEvidence 必须存在且来自 verified run，被引用子判据为 heuristic 时拒绝。registry 在自定义 verifier 执行前同样检查映射，合法映射仍须通过所选 verifier，插件不能覆盖映射规则。父 mandatory heuristic 不计确定性通过；requiresIndependentAcceptance 缺映射时准入拒绝 | `composite-verifier.ts:entryDefect`；`verifier/src/index.ts:verifyCriterion`；`admission.ts:independentAcceptanceDefects` |
| 预算 | wallTimeMs 在飞取消；tools/tokens 仅终态审计；attempts/noProgressRounds 仅声明 | `orchestrate.ts:awaitWorker`、`budgetBreaches`；`task-runtime/src/index.ts:Config` |
| L4 上报 | root 的 `escalate` 工具与台账已有；模型主动调用，批准后才记 raised；运行时只输出提示，无自动触发、无处理结果/恢复闭环 | `agent-singularity/src/tools/escalate.ts`；`orchestrate.ts:escalationHint` |
| blocked 恢复 | blocked 无恢复出边；TaskRetried 只接受 failed，父分解一次的限制仍在；补能力后不会自动续跑原图 | `task/src/service/state.ts`；`task-runtime/src/index.ts:decomposeAndRun` |
| Review / Evolution | 已有工具链；机械候选 PROMOTE/apply 要求 observed、holdout 各自非空且不退化，报告按明细重算并校验记录时摘要。单文件 Skill 候选内容已绑定（P2）：prepare 记录实际物化 SKILL.md 的 SHA-256，replay 报告携带同一身份，`replayed` 记录写入前、晋升预检与 decide(PROMOTE)/apply 服务入口均复检候选文件，apply 只写入已校验字节。生产基线已固定（P3）：prepare 用同一次读取的生产文件得到 champion 快照与 `skillBaseline` 摘要，apply 工具在人审前、服务在实际写入前复检生产目标仍等于该基线（captured 要求普通文件摘要一致，missing 要求目标仍不存在；缺失/内容不同/类型改变/符号链接路径均明确拒绝），过期候选不写生产、不记 applied，也不自动覆盖或改写原 proposal。未实现其他 targetType 的内容绑定、真实证据来源校验、分层指标或自动 Retro | `agent-singularity/src/evolution.ts:prepare`、`readSkillCandidate`、`checkPromotion`、`checkProductionBaseline`、`writeProduction`；`replay.ts:assertReplayReport` |
| root-agent 构建类型闸 | `agent-singularity` 的 `build` 为 `tsc --noEmit && tsdown`，类型错误即构建失败；工作区根 `pnpm build`（`pnpm -r run build`）经过同一检查。2026-09-21 前该包 `pnpm build` 只有 tsdown，不保证严格类型检查通过 | `agent-singularity/package.json` scripts.build |
| 身份与枚举的类型来源 | 工具侧 `sessionId(exec)` 直接返回上游 `Agent.id` 的 `SessionId`，不再降级为 `string`；`DiagnosisProposal.targetType` 与 `evolution_propose` 的 targetType 由 `@dangosys/dsh-singularity-task` 的 `ProposalTargetType` 标注并经运行时校验，不是任意字符串断言 | `agent-singularity/src/tools/task-diagnose.ts:toProposals`；`src/tools/evolution-propose.ts:isProposalTargetType`；`src/evolution.ts:validateMutation` |

### 4.2 优先修复的断层

| 编号 | 问题与影响 | 建设票 / 历史对应 |
|---|---|---|
| G1 | 父 composite 曾仅对子状态求合取，不能证明根目标；同环境执行 verifier 也不等于测试与阈值不可被修改。P4 已落地最小机械版（S1-V 切片 1+3）：父 AC `childEvidence` 映射的存在性与 verified 来源检查、至少一条可机械执行的独立父级组合检查（映射断言与父级 command）、`heuristic` 显式标注。剩余：C3 假设满足性的完整证明、verifier selftest 正负样本实际执行（切片 2）、验收输入来源与版本固定、证据来源真实性认证 | S1-V / 旧 #25、#26 |
| G2 | provider 未预检、run 级内容版本未固定；`closed` 被误用为可执行保证。多 preset 冲突已在解析期拒绝；单文件 Skill 候选的晋升链路内容身份（P2）与生产基线（P3）已固定，但 provider 预检与 run 解析快照仍未建 | S1-C / 旧 #29 |
| G3 | 缺产物曾只查存在且 blocked 无恢复，证据驱动生长断在登记之后。P4 已把存在性收紧为 verified 参考产物并区分原始输入（`acceptsArtifact`）；blocked 仍无恢复出边，补产物后不会自动续跑原图 | S1-V、S2-R / 旧 #20、#21、#22 |
| G4 | 上报依赖模型调用且批准前不落账；任务阻塞、通知与人类决策混在一起 | S2-E / 旧 #27；已有工具不能标为待建 |
| G5 | 三值判决、预算半接线，没有 PARTIAL/UNKNOWN 的任务级处置 | S2-R / 旧 #23、#24 |
| G6 | 缺 skill 契约与知识型定位，L1/L2 又被排在其前面，形成建设依赖倒置 | S1-C → S3 / 旧 #29 |
| G7 | 已补报告自洽、机械晋升最低闸、单文件 Skill 候选内容绑定（P2）与生产基线检查（P3）；证据来源绑定、分层指标和自动 Retro 未建，当前不能宣称防止裁判弱化或过拟合 | S4 / 旧 #28 |
| G8 | `task_decompose`/`escalate` 部分拒绝返回普通文本，上层不能可靠用工具错误信号判定 | S2-E / 旧 #33 |
| G9 | 类型闸只覆盖 `agent-singularity`；其余 Singularity 包的 `build` 仍只有 tsdown，未接 `tsc --noEmit`，其严格类型状态未经本闸保证 | P1 范围外，待独立评估 |
| G10 | 动态生成已存在，但无生成提案审核协议；不能把 Task 模板库当成合法性白名单，也不能把工具层弹窗当成完整治理。T1 已补统一可持久化契约、闭合字段集、内容摘要与准入记录（§5.6）；审核开关、提案状态机与恢复仍属 T2/T3 | T2/T3 / Task 自主构造指导 |
| G11 | 根 objective/AC 入口过弱；上下文传递缺根目标、祖先决定来源与新鲜度；根目标错了时全局传播不能补救 | A0/A1 |
| G12 | 父同步等子与子回问冲突；idle 等同执行结束，不支持有持久状态的等待与继续；不能仅添加 ask_parent 或开放 send_message | A3/A4 |
| G13 | task_status 全树文本不表达执行权/合法动作；session 同 cwd 可读比 group 边界宽；reviewer 局部 pack 不等于跨图因果 debug | A2/A5 |
| G14 | root/worker prompt 与当前方向有漂移：L4/manual、直接问人、make command exit 0、分解意图矛盾；未来工具必须随真实协议接线再写入提示 | A0–A6 逐票同步 Prompt 合同 |

历史记录中的 M1–M9 为此前会话的实跑声明，保留于历史指南。本次回归结果见建设计划 S0；本次没有重跑 LLM、BB 构建仿真或生产 Evolution 链路。旧环境可用性、外部 bbdev 缺陷和部署阈值在使用前需重新读取对应部署，不能从旧日志推断当前状态。

2026-09-21 的 P1 已关闭“root-agent 包 build 不执行严格类型检查”这一缺口：该包 `pnpm exec tsc --noEmit` 从 12 处错误降到 0，`build` 改为先 `tsc --noEmit` 再 `tsdown`，工作区根 `pnpm build` 同样经过。G9 是 P1 明确未做的剩余部分：类型闸没有推广到其他包，也未改变任何业务流程、审批次数、持久化格式或工具输入输出合同。同日的 P2 已关闭 G7 中“候选内容绑定”的单文件 Skill 切片（范围见 §5.5）；P3 再关闭其中“生产基线没变”的切片。证据来源绑定仍待建，由后续工作推进，不因 P1/P2/P3 完成而标记 S1-C/S4 完成。同日的 P4 已关闭 G1/G3 的最小机械切片（范围见 §5.1 末段）：父 AC → 子证据映射的存在性与 verified 来源检查、独立父级组合检查、原始输入与已验证参考产物的区分；C3 完整证明、verifier selftest 执行与 blocked 恢复仍属后续票，不因 P4 通过而宣称独立父验收全部完成。同日的 T1 已落地统一规范化契约、内容身份与批次准入记录（范围见 §5.6）：新实例的契约成为单一数据定义并持久化，普通分解、replay 与 root 入口共用同一规范化与结构校验；生成提案审核、审批摘要绑定与崩溃恢复仍属 T2/T3，不因 T1 通过而宣称自主构造治理完成。

## 5. 实现时的关键约束

### 5.1 验收先于自动生长

P4 `f6886cf` 的完成声明经复核发现三个组合路径漏洞，本轮修复 replay 输入检查、子 heuristic 引用及自定义 verifier 绕过。原 739 项通过不足以证明这些规则成立；新增交叉路径正反例见 `tests/integration/parent-acceptance.spec.ts`，修复验证记录见建设计划 P4 修复节。原提交的历史结论不作为当前验收证据。

现有 command verifier 与 worker 共享 checkout：外部进程运行命令只提供执行分离，不保证 worker 无法修改测试、脚本或阈值。建设目标是固定验收输入的来源与版本，保护判据，记录 verifier 版本及证据产物身份；自述 JSON 和退出 0 均不能单独证明领域正确性。

**父级验收与证据身份已落地（2026-09-21 P4，S1-V 切片 1+3）**：父 AC 用可选字段 `childEvidence` 声明“需要哪些子任务的哪条判据/哪类证据”——子任务按分解 batch 位置（0 基，与 `dependsOn` 同一索引词汇）指向，可再窄化到子判据 id 与证据引用（evidence id / artifact kind / artifact id 三种拼写），composite 在父验收期对照 store 校验该映射真实存在且证据来自子任务的 verified run，不完整则拒绝并在 reason 逐字点名缺失项；缺省（无映射）完全保持现行“子全 verified”合取行为。独立父级组合检查有两条可机械执行的形式：映射断言本身，以及父 AC 的确定性 `command`（接口/数值级判据，子全 verified 但组合错误时父必须拒绝）。`heuristic: true` 标记的父 AC 是自然语言条款：verdict 显式带 heuristic 标注，且不计入确定性通过。`requiresArtifact` 收紧为“已验证参考产物”（产出 run 终态 verified 且 bundle 带 pass 判据），原始输入改用 `acceptsArtifact`（存在即可，任意 run 状态）；契约级标记 `requiresIndependentAcceptance` 要求映射存在，新建/分解路径 admission 对映射缺失/被删/形状畸形响亮拒绝，不静默降级为合取；replay 路径与普通分解共用同一校验规则。

范围边界：映射按 batch 位置指向，不做通用自然语言蕴含求解器，也不做 C3 假设满足性的完整证明（只做映射指向存在性的结构检查）；verifier selftest 正负样本的实际执行与输入身份固定属 S1-V 切片 2，证据来源真实性认证、blocked 缺产物后的自动恢复（S2-R）均未建。旧任务（无新字段）读取、回放、验收行为不变；`requiresArtifact` 的收紧对旧声明同样生效——失败 run 的同名产物不再满足依赖，这是本票的修复点而非兼容性破坏。另有三个已知边界如实记录：replay 任务按设计无父无子，携带 `childEvidence` 映射的候选契约失败关闭（当前 replay 不存在“能通过”的父级映射表达）；`evidenceRef` 的三种拼写只匹配 `EvidenceBundle`（evidence id / artifact kind / artifact id），真实链子上 `TaskRun.artifacts` 恒空，匹配不依赖它；composite `entryDefect` 的逐条目子任务状态检查位于“子全 verified”合取闸门之后，当前调用路径下不可达，属防御性分支（未验证子任务由合取闸门拒绝并点名）。

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

报告 SHA-256 只保证 gate/decide/apply 读取的是记录时的报告；它不证明报告来自真实执行，也不固定 sandbox 文件（skill 候选的单个 SKILL.md 除外，见下）。不同 task id 只是样本身份不重用的最低检查，不证明统计独立。相同失败结果仍可能“不退化”，所以最低闸不是“改进有效”的证明。

**单文件 Skill 候选内容已绑定（2026-09-21 P2）**：prepare 为实际物化的 `sandbox/<id>/skills/<name>/SKILL.md` 记录 SHA-256（精确字节，不 trim、不转换换行），与 proposal/target/skill 名称关联，重启可恢复；skill replay 报告携带同一身份，记录报告的服务入口校验它与 prepare 一致，并在写入 `replayed` 记录前重新读取候选文件复检；replay 执行前工具层也检查同一文件，运行时 overlay 指向被检查的沙箱候选而非生产 skill；人审前预检与 decide(PROMOTE)/apply 服务入口复检身份；apply 从文件读取待应用字节、校验摘要后写入这同一份已校验字节，不检查路径后重新读路径。候选缺失、内容不同、非普通文件、候选路径或其祖先为符号链接均明确拒绝；失败不写生产、不追加成功晋升状态。旧 ledger 无新字段仍可读，旧已应用对象仍可回滚；旧未应用 Skill 候选不能直接新晋升，错误提示要求新建候选并重新评估。

范围边界：只覆盖 `targetType: skill` 的单个 `SKILL.md`。多文件 Skill、agent_preset、capability、task_definition 不携带该身份；真实证据来源认证、独立 verifier、supervisor 调度均未实现；内容身份不等于 Skill 功能正确。本保障针对正常 agent 工作流中持久存在的内容变化与 apply 的读写一致性，不覆盖恶意外部进程在 replay 期间瞬时改写又恢复、特权进程篡改 ledger、跨进程文件系统隔离。其余待补项：候选内容摘要之外的 manifest/run/evidence 身份、原始证据对照和按目标制定的改进指标；agent_preset 仍只生成 manual replay（应补沙箱 preset 执行器，而非绕过验证）；缺摘要的旧 ledger 可读、已应用对象可回滚，但后续晋升需新建候选并重新评估。L4/未支持目标缺少执行器是实现缺口，不是要求人代写改进的永久规则。

**生产基线也已固定（2026-09-21 P3）**：这是与“候选内容没变”不同的第二项检查——前者保证 apply 写出的就是被评估过的那份候选字节（P2），后者保证被评估时的生产状态没有被别人改掉（P3）。prepare 对生产文件只读一次：同一份字节既写进 `champion/skills/<name>/SKILL.md` 快照，也算出 SHA-256 写进 `prepared` 记录的新可选字段 `skillBaseline: { name, sha256 }`（快照与摘要因此不可能互相矛盾）；生产文件原本不存在时记录 `champion: 'missing'`，不写摘要。apply 在人审前由工具调用 `checkProductionBaseline` 复检，人类批准后由服务入口在实际写入前再复检一次，直接调用服务同样经过：`captured` 要求生产目标是普通文件且摘要与记录一致，`missing` 要求目标仍不存在；文件缺失、内容不同、类型改变（例如变成目录）、文件或其祖先为符号链接都算冲突，明确拒绝。冲突时不改生产文件、不记 `applied`、不自动覆盖/merge/更新 champion/改写原 proposal，错误提示要求基于新生产状态创建新候选并重新评估；拒绝后原候选、报告与历史都保留，P2 的候选身份检查与既有 replay 闸继续生效。拒绝后 rollback 合同不变：rollback 仍按 champion 快照覆盖写回，P3 没有改这套策略。

范围边界（P3）：只覆盖 `targetType: skill` 的单个 `SKILL.md`，且只保证**单进程串行调用**以及两次调用之间发生的外部修改。不实现跨进程锁、并发 compare-and-swap，也不保证任意外部写入者与 apply 同时写时的原子性；因此“串行应用两个基于同一 champion 的候选，第二个被拒绝”是确定验收的，“两个进程同时 apply”不是。旧 ledger 无 `skillBaseline` 仍可读、旧已应用对象仍可回滚；captured 但没有基线摘要的旧未应用候选拒绝新 apply（不能默认匹配），missing 的旧候选仅在目标仍不存在时可应用。P2/P3 合起来仍不证明证据来源真实、provider 预检存在或自动 Retro 已建；完整自进化框架未完成。

### 5.6 统一规范化契约（2026-09-21 T1）

T1 把“任务契约”从散落在工具 schema、runtime 局部函数与事件载荷里的字段，收敛成一份可持久化、可摘要、可校验的数据：`task/src/contract.ts` 的 `TaskContract`（`contractVersion`、`objective`、`acceptanceCriteria`、`assumptions`、`constraints`、`requiredCapabilities`）。普通分解的子任务、replay 实例与 root 都保存这份契约；`TaskInstance.objective`、`acceptanceCriteria`、`requestedCapabilities` 退化为它的投影字段，store 在写入时用 `canonicalize` 逐字段比对、拒绝内容不一致的新事件。旧任务（无新字段）读取、验收、回放行为不变，也不会被补出 assumptions/constraints/version。

唯一入口是 `task-runtime/src/normalize.ts` 的 `normalizeDecomposition`：批次/子任务/判据三层都是闭合字段集（未声明字段按名字拒绝而不是静默丢弃——这是“生成字段不能提高预算、不能写死 skill”的机械保障）；`contractVersion` 省略按当前版本 1 处理，声明成未知版本明确拒绝；objective/description/assumptions/constraints 只做空白校验，不做 trim 或换行重写；criterion id 显式声明则原样固定，否则按批次位置生成 `ac<i>-<j>`，同一子任务内重复 id 整批拒绝。拒绝一次返回全部原因，且发生在铸 task id、查能力、落库之前，因此被拒批次零副作用。

身份与摘要：`canonicalize` 单点实现（对象键稳定排序、数组保序、`undefined` 值键与 session log 的 `compact` 一致地丢弃、无法 JSON 往返的值响亮拒绝），固定向量测试的期望值来自仓库外 `sha256sum` 的同一段文本，不拿实现当自己的期望。单契约身份是 `contractDigest`；整批提案身份是 `decompositionDigest`，覆盖 store/parentTask/parentRun/caller、契约版本、reason 与完整有序 children（子契约摘要 + `dependsOn` + `decomposable` + `requiresIndependentAcceptance`）。准入铸的 task id/run id 不在摘要内，同一提案重试保持同一身份；重排 children 或改动任一契约字段都是新提案。批次准入上下文（`AdmissionContext`：硬限制 `maxDepth`/`maxChildren`/`wallTimeMs` 与仅审计的 `maxToolCalls`/`tokens`/`attempts`）与摘要一起写在父任务 `TaskDecomposed` 事件的 `admission` 字段上，由 reducer 校验形状。**上下文自身的指纹未建**（T2 的 stale 判定会用它）：本票只保证上下文内容被如实记录、易变 registry 状态不混入内容摘要。

共用点：普通分解、replay、root 三个入口都构造并保存契约；结构规则 `contractDefects`（至少一条判据、至少一条 mandatory、id 唯一、mode 合法、可执行 mode 需要有 command）由 `checkDecomposition` 与 replay 路径共用；P4 的 `independentAcceptanceDefects` 保持原样，父任务已有的契约不在分解时被重新审判（T1 不追溯收紧旧父任务）。handoff 的 assumptions/constraints 直接来自 store 里的契约，worker 的 `task_read` 从同一份契约渲染这两项，两个视图不会各说一套。

工具面：`task_decompose` 增加可选 `contractVersion`、判据级 `criterionId`、子任务级 `constraints`；工具把调用者给的整个批次对象交给 runtime，未声明的批次级字段由契约入口按名字拒绝（工具 schema 仍校验自己的声明面：类型、mode 枚举、子任务/判据闭合对象）。因此两个入口在“接受/拒绝”上不矛盾：schema 拒绝的输入直接调用 runtime 也被拒绝，schema 放行而不属于声明面的批次级字段由 runtime 点名拒绝；差异只在拒绝文本由哪一层给出。

边界：`generatedTaskReview` 开关、提案状态机、批准后重检与崩溃恢复仍属 T2/T3；`childEvidence` 仍只做结构检查，不做索引范围与蕴含证明；契约修订协议与模板库未建；新增预算/限额字段会被当未知字段拒绝，预算只能在部署配置里改（本票不引入“请求预算”）。root 的契约由 `RootTaskSpec` 常量展开、未再经独立校验；`AdmissionContext` 的硬限制只保证配置值被如实记录并由既有准入规则执行，不新增运行期强制。reducer 只校验契约的形状与版本，不重复结构性规则（全 optional、重复 id 在三个入口判定），因此直接写 store 的调用方仍可落库一份自洽但结构不合规的契约；`assertAdmission` 也只校验摘要非空，不校验摘要与所存 children 相符——那是 T2 提案绑定的职责。

验证与解析边界（T1 复核）：task-runtime 的 src 与单测按 workspace 链接解析 `@dangosys/dsh-singularity-task` 到 `task/lib`，所以 `task/src` 的改动在重新 build 之前不会反映到 task-runtime 侧测试——本票因此规定先 `pnpm build` 再跑测试；这是既有解析方式，不是 T1 引入的机制。`task-runtime` 的严格类型检查仍有 8 处既有诊断（G9，行号均在 T1 diff 之外），本票未新增、未修复。集成测试的 sessionPersistence 是内存假件并做 JSON 往返，真实 JSONL 写入与崩溃重启行为只由单测/集成 fixture 覆盖。

测试锚：`task/tests/unit/contract.spec.ts`（`canonicalize` 与两个摘要的固定向量、默认值/键序等价、内容敏感度）、`task/tests/unit/task-state.spec.ts`（reducer 契约一致性与准入记录形状）、`task-runtime/tests/unit/normalize.spec.ts`（闭合字段集、版本、默认值、id 固定与重复、摘要、深拷贝）、`task-runtime/tests/unit/admission.spec.ts`（`contractDefects` 与既有结构规则回归）、`task-runtime/tests/unit/orchestrate.spec.ts`（真实 TaskRuntime + TaskService：契约落库读回、重开 store、准入上下文、拒绝零副作用、handoff 一致、提案摘要重试稳定、replay 结构规则与契约、`mode: null` 拒绝）、`agent-singularity/tests/unit/task-tools.spec.ts`（工具 schema 传递与 `task_read` 渲染）、`tests/integration/task-contract.spec.ts`（真实 TaskService + TaskRuntime + VerifierRegistry，含真实 `task_decompose` 工具路径、八例拒绝、重开 store、legacy 任务与配置限额记录）。实跑命令、数量与未覆盖范围见建设计划「T1 执行与验收记录」。

## 6. 文档维护

- 每次派发同时执行 [公共合同中的质量 Prompt](execution-prompts/README.md)：检查规则实际消费位置、替换入口和跨层组合，保留先失败后通过的反例及合法正例；不能把合同缺陷改名为已知边界。指南中的完成状态必须与这些证据一致。
- 本文只维护方向和当前事实，建设计划只维护票据与验收；实施日志进入带日期记录。
- 每项完成状态必须写清范围、复核日期、源码/测试锚；区分声明、接线、自动测试、真实端到端运行。
- 同一改动同步更新本文的状态和建设计划。部分完成继续标“部分”，不可用“完成（核心未做）”。
- 新设计写成“建设目标/设计选择”；与 KISS 的差距保留为明确缺口，不以已有代码反过来宣称目标已达成。
- 历史材料只作来源，不与当前指南竞争规范地位。旧编号查询历史快照，新工作使用 S/G 编号。
