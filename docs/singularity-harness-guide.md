# Singularity Harness 工作指南

最新进度审核（2026-09-24）：R2 Q1 的补充返工 `8f9086e` 已验收。取消窗口内读取与跨取消完成点的陈旧读取都不能重开写闸；本轮构建、1461 项单测、268 项集成及持久化检查通过，独立只读复核未见本票合同内可达违约。当前可派 [R1 补验证](execution-prompts/07-r1-supplemental-validation.md)，限 Q4/Q5 的 S3 澄清和实验账；A2 仍待前置。原失败与分轮交付证据见[唯一建设计划](2026-09-20-vrtc-code-change-plan.md)；§5.12 保留未证实的其他取消边界，不将 Q1 验收泛化为全部取消竞态安全。

方向复核：2026-09-23，代码基线 `fda3d29`（T2/T3 交付）。该次文档修改前备份：Singularity `1430103`、外层 harness `31bcf3a`，包含 A0 草案与架构审查原文；第三方 DSH 原有未跟踪文件未纳入。
历史更新（2026-09-23）：A0 Q2/Q3 已验收；R2 首轮 `250a04f` 当时交付待审，后续审核发现跨取消完成点缺陷并由 `8f9086e` 修复。分轮证据见 §5.12 与建设计划，当前状态以上方 2026-09-24 审核为准。
那次只修订指导与派发合同，未实现补救任务、未复跑历史测试。各票已有实跑记录仍按其日期与提交读取；返工记录单列，不覆盖历史结论。

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

**当前阶段判断（2026-09-24）**：递归执行、证据、审核、恢复骨架和根契约入口已经接线。A0 Q2/Q3 与 R2 Q1 已按各自合同验收：根来源/恢复见 §5.13；取消期间及跨完成点的查询回填见 §5.12。R1 的 S1/S2 有历史真实模型与 verifier 证据，但 S3 把未澄清的季度/数据来源写入已激活目标，原 driver 又误判通过；这项 Q4/Q5 仍待补验证。§5.12 的其他取消边界未由 Q1 验收覆盖。当前唯一可派票是 R1，A2 待其验收。

R0 的默认工具面收敛、R2 的 marker 顺序及无用途 API 清理保留有效，不重做整套框架。R1 实验账需补记被覆盖的首轮 S1：按现存记录至少 175461 输入/输出 token、58 次工具调用；完整首轮日志缺失，不能声称全部尝试的原始证据齐全。一次场景通过不证明成功率提升，自主改进闭环仍未交付。

R1 使用已可派发的 [专项 prompt 与 V1–V6 验收指标](execution-prompts/07-r1-supplemental-validation.md)：先修真实问答夹具并证明新判据拒绝旧失败轨迹，再作一次真实 S3，保留全部尝试并更正历史账。答复只说未提供数据，不等于确认季度或限定来源；保留未知与执行用户明确要求的无数据说明分别判定，不能靠“写了假设”通过。当前没有新增真实模型验证结果。

### 1.1 需要干预的建设倾向

2026-09-21 的工程判断：核心方向保留，建设范围收缩。KISS 是目标约束清单，不是要求一次实现所有对象、四值判决、成熟度、召回和进化管理的产品清单。已有 Evolution 链路保留使用；新增工作优先支持一个能验证、能失败、能恢复的小型端到端任务。

- **自由探索包括方法选择和任务构造。** 节点可选择工具、skill、尝试路径，也可针对未满足义务生成有验收边界的任务契约；模板是可选参考，不是准入白名单。不必为每个思考和工具调用建立 Task。研究型任务可以验收可追溯结论、实验结果和仍未解决的问题，不能要求未知问题一开始就具备答案或完整执行路径。
- **验证强度与交付风险匹配。** 工程交付采用客观判据；启发式判断明确标记不确定性。Capability 预检只证明声明资源可用，不能承诺搜索路径必然成功，也不能自动证明自然语言契约完整。
- **自进化分级、可回退。** 首个实现闭环选 skill/能力映射这一类候选，但完整目标仍包括 Task 模板、上下文、preset、routing、Verifier、admission 与 runtime policy 的改进。Supervisor 可以生成、实现和验证这些候选；敏感等级决定验证与人审要求，不能把高风险改进永久改成“由人来实现”。依据：细化想法1 §十三、细化想法3 的四级 mutation hierarchy、细化想法4 §30–§33。
- **元数据只记录当前决策会用的内容。** Skill 契约在 provider 准入或晋升真正消费时再加入；先让选定能力可用、运行可追溯。不要先建全领域能力本体、五级成熟度平台或通用语义规划器。
- **每次建设完成所承诺的有限行为。** 基础执行先验证真实目标进入、执行、根验收和失败报告；自主改进仍按后续交付组完成“缺口 → agent 实现候选 → 独立验证 → 人审 → 应用并恢复”。不把尚未开放的自主恢复作为基础执行的隐含依赖，也不把基础执行通过称作自进化完成。缺口 fixture 是测试输入，不是让人补写 Skill。

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

### 1.3 架构收敛约束（2026-09-23）

原排期把局部交付完整性扩大成了真实运行前的长建设链，本次纠正。保留不变量，不冻结所有机器层实现，也不以文件行数或 prompt 词数判断正确性。唯一执行顺序及 R0/R1/R2 验收写在建设计划；[补救指挥 prompt](execution-prompts/05-architecture-remediation.md)只负责执行该顺序。

后续单票用[派发模板](execution-prompts/task-dispatch-template.md)固定真实场景、验收和停止条件：新增工作须对应当前合同或具体可达缺陷，必要检查通过后收尾；不把设想的未来场景自动转成补丁或必建任务。该约束不减少权限、验收与恢复所需的正确性保障。

- **目标来自用户，方法由节点选择。** 根契约保留原请求的可读取来源，区分明确要求与推导假设。会改变目标、交付范围或验收的歧义先澄清；普通实现方法不逐项请人批准。`generatedTaskReview=off` 不等于允许捏造用户要求，结构校验也不证明自然语言语义正确。来源的机械部分（store↔session、顶层会话、会话日志里的本人消息）由 §5.13 在统一服务入口校验；部署自己的提示词不再占用人类输入标记。
- **默认运行只提供当前角色需要的能力。** 沿用 DSH preset/scoped tools，root 协调业务任务；诊断、候选实施与晋升按角色及部署启用。BB 指导属于领域配置。关闭进化暴露面不删除历史账本、既有校验或授权规则，也不能让后台自动触发绕过关闭策略。
- **新增概念要有当前用途。** 模块、导出、字段和状态说明实际消费者及删除后会失败的行为；审计/恢复也是用途。优先复用已有记录和 DSH 接口，不为未使用 API 再造消费系统。已持久化的历史字段兼容读取，不为瘦身做无收益迁移。
- **重构依据重复职责和实际失败。** 正常执行、replay、恢复共用关键迁移规则；内存管理活跃 handle，持久记录保存恢复事实。先收敛准入、运行推进、工作区归属的职责，不预定 pull 化、通用 effect 框架或分布式锁平台。
- **未来设计不是逐字段施工清单。** A1/A2/A4 等尚未实现的结构在派发前按实际场景复定；必要权限、证据、取消和恢复不变量保持，非必要字段与通用化可删。修订须同步唯一计划，不能由实现者把已承诺行为的缺陷改名为增强。

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
  -> provider 预检（用实际 worker 的 cwd/preset 发现路径校验已配置 skill 等资源，S1-C）
  -> 保存 Task（含规范化 contract）/ CapabilityManifest / 批次准入记录
  -> 按 dependsOn 顺序运行就绪子任务
  -> 检查 requiresArtifact -> Handoff + 独立 Session
  -> grant tools / 注册 skills / 挂载 MCP / 选择 preset
  -> worker 按需调用 skill，执行或继续 task_decompose
  -> verifier -> EvidenceBundle -> task 状态 -> 父验收
```

源码入口：`task-runtime/src/normalize.ts` 的 `normalizeDecomposition`、`task-runtime/src/index.ts` 的 `decomposeAndRun`、`task-runtime/src/capability.ts` 的 `resolveCapabilities`、`task-runtime/src/orchestrate.ts` 的 `driveBatch`（`runChildrenCascade` 被 A3 取代：准入与推进分离，见 `docs/2026-09-22-a3-coordination-design.md`）、`agent-runtime/src/grants.ts` 的 `applyWorkerGrant`。

- `resolveCapabilities` 只查表并展开工具标签，返回 `closed` 或 `gap`；虽然类型含 `partial`，实现不产生它。`closed` 表示声明的名字已命中，**不表示 skill 前置条件或产物契约已闭包**。
- 节点提交的批次先经过 `normalizeDecomposition`（唯一规范化入口，T1）：闭合字段集、默认值、criterion id 固定、批次摘要；被拒绝的批次在铸 id 和落库之前返回，且零副作用。之后才进入结构准入与能力解析。
- 缺 capability 且子任务未标 `decomposable`：拒绝整批子任务，另在父任务记录 Obligation。标了 `decomposable` 可以准入并启动规划 worker；执行安全仍依赖后续分解与授权约束。
- 多个命中能力的 skill/tool 合并，preset 只能有一个不同的声明值；同名合并，不同名在能力解析时拒绝，不再按能力顺序选第一个（2026-09-21 样本改造）。无声明才使用部署默认 preset。
- 准入 provider 预检（2026-09-22 S1-C）：在子任务落库前用实际 worker 的 cwd/preset 发现路径检查已配置 skill——发现不到、frontmatter 名不符、侧车非法（未知执行 verifier、工具声明不被覆盖、内容身份不匹配、不支持的资源形态）均整批拒绝且零副作用；普通分解、replay 与直接服务调用共用。MCP 启动失败仍在 spawn 阶段记录。闭包语义不变：闭包仍由配置表条目决定；知识型/无侧车（guidance）skill 可加载但不计为执行 provider。
- Run 绑定实际实现（2026-09-22 S1-C）：run 启动时把选定 skill 物化为 run 级快照并逐字节复检准入身份，worker 经 overlay 加载快照字节而非可变生产路径；`TaskRun.providerBinding` 记录 registry 修订、各 provider 角色与内容摘要、preset/MCP 身份；worker 合同块/spawn prompt/`task_read` 同源渲染选定实现摘要，正文按需读。apply 新版本不热替换在途 run；旧内容不可读时明确拒绝，不静默回退。
- DSH skill grant 保证内容在 worker 的 skill 层注册；全局目录仍可能显示其他 skill，**没有按 worker 隐藏目录的保证**。工具授权另由 grant 限制；preset 自带工具与 MCP 挂载也是授权面的一部分。
- 本次修复：worker baseline 增加只读 `capability_list`。原先 `task_decompose` 指示先查能力表，但 worker 过滤器把它剔除，导致递归节点只能猜能力名。`graph_spawn`、Evolution 与平台审批工具仍不进入 worker baseline。

### 2.3 最小建设目标（1–3 已由 S1-C 交付）

先保留显式能力表作为唯一 provider 选择入口；不要立即引入向量检索、自动排名或通用规划器。

1. **准入期预检已选实现**（2026-09-22 S1-C 已交付，§5.8）：skill 可发现性、frontmatter 名一致、侧车契约合法（执行型 verifier 已注册、requiredTools 被能力展开工具覆盖、内容身份匹配）在子任务落库前校验。多个 preset 冲突检查此前已完成。预检不能保证 MCP 启动成功，spawn 仍需实际校验，失败指向相同的缺口类型。
2. **worker 收到自己的精简能力摘要**（2026-09-22 S1-C 已交付）：合同块/spawn prompt/`task_read` 同源渲染本 run 选中的 capability、skill 名称/角色/用途与内容短摘要及 registry 修订；通过 DSH 按需读正文。全局 skill catalog 的 token 成本仍存在。
3. **run 记录实际选择**（2026-09-22 S1-C 已交付）：`TaskRun.providerBinding` 在名称快照之外记录 capability 表修订（registry revision）、每个 provider 的角色与内容摘要、preset/MCP 身份与快照根；`capabilitySnapshot: string[]` 保留为投影。
4. **运行中发现缺口**（仍未实现）：先检查已授权能力能否回答，再提出有验收标准的获取/分解任务；无可行路径则上报。加载另一份指导不扩权，不自动安装工具，不修改当前 Task 的 AC（"加载未选 skill 不扩大工具权限"已有 S1-C 回归测试，缺口处置流程仍属后续票）。

一个 capability 可有多种 skill 实现，一个 skill 也可服务多个任务。首版仍由部署选择一组实现；有真实替换需求和测量数据后，再做多候选排序。

### 2.4 执行型与知识型 Skill

KISS §4.2 的 Skill 指能提供可验证能力的执行实现；DSH 的 `SKILL.md` 还承载领域知识。两者需要明确区分，避免“知识没有执行 verifier，所以整个能力机制建不动”。

| 类型 | 内容与验证要求 | 是否能单独关闭执行能力缺口 |
|---|---|---|
| 执行型 | 声明提供的 capability、前置条件、输入/输出、required tools、verifier 引用；用正负样本验证实现效果 | 经契约和验证检查后才可以 |
| 知识型 | 来源、适用范围、内容版本、结构/引用检查；义务模板需能解析并验证覆盖规则 | 不可以；只能帮助发现义务和选择方法 |

**本次设计选择**：侧车元数据采用带类型的契约，知识型不伪造执行 verifier，也不计入执行闭包；它仍需内容检查和变更审查。这是对 DSH 内容类型的划分，不是给执行型 skill 开"未验入库"豁免。

类型化侧车契约已落地（2026-09-22 S1-C，见 §5.8）：侧车为 skill 目录内 `SKILL.contract.json`，执行型/知识型判别联合，闭合字段集与内容身份（含受支持多文件资源）；成熟度五阶段、成功率衰减与统计排名仍后置。侧车负责元数据，DSH 继续负责正文加载。统一校验入口 `validateSkillProvider` 被配置载入、provider 替换（capability 行 apply 与运行表替换）、候选晋升与准入预检共用：`evolution_apply` 不是唯一防线。

领域包包含义务模板、执行 skill 与参考 verifier。模板只提问，不规定 C→BEMU→Compiler→RTL 的固定步骤。`dependsOn` 可以表达本次任务中确实存在的证据依赖；它不是被禁用的 API。

## 3. 建设顺序与完成条件

执行只使用 [建设计划](2026-09-20-vrtc-code-change-plan.md)文首唯一表。补救返工顺序为 A0 → R2 → R1：A0 Q2/Q3 和 R2 Q1 均已验收；当前派第 8 项 [R1 补验证](execution-prompts/07-r1-supplemental-validation.md)，A2 暂不派发。已有证据保留、每票独立审核后再派下一票。R1 使用同一生产实现，按固定 S3 场景与实验账判据验收。

### 上下文、协作与诊断的方向决定

节点默认继承结构化契约与 handoff，不复制祖先完整聊天；全局观由真实根目标/硬约束、当前任务的贡献、相关决定与证据引用构成，细节按授权范围查询。沿用 DSH scoped system prompt 和 Session 原始日志，摘要仅改变视图，不能替代原始证据。Task DAG、Agent Graph、Session lineage 分别拥有事实，按 id 关联。

父子澄清必须采用非阻塞协议。A3 已使 `task_decompose` 准入后返回并区分 idle 与提交验收；持久父子问答仍未建。DSH 的 send_message 要求 continuable activation，当前 Singularity spawn 未接该生命周期。沿用现有 agent-runtime handle 所有权和原生 inbox/steer/resume，后续 A4 增加任务域问答；不引入第二套 agent loop/Team task board。

协调主相位与阻塞问题分别记录，逐级询问不丢原批次或开放写权限；消息入箱不等于模型已消费，必须覆盖 claim 后中断的恢复。派发子节点和开始验收前均关闭新写入并确认在途写入收敛。对应故障窗口与竞态反例纳入 A3/A4，不能只靠 prompt 维持这些不变量。

任务列表分开表达可见、可准入、可运行和调用者合法动作；可见不等于可领取。首版 runtime 分派，节点可查询与提出新 Task，不做全局工作窃取。Supervisor 按去重 incident 触发、沿实际依赖与证据逐步下钻，先只读诊断，再由候选节点实现和独立验证，最后人审应用；不设每节点常驻主管，不以诊断自述取代正确性证据。

根契约入口已实现（§5.11），其来源归属与恢复入口已返工关闭（§5.13）：setup 与目标激活分离，graph name 不再代替 objective，缺独立判据具名拒绝，旧任务不原地改题；根契约的来源由统一服务入口机械校验（store↔session、顶层会话、会话自身日志里的本人消息），模型自报不能替代，`adoptRoot` 无根时经既有恢复遍完成恢复。这些是机械合同，不能推给模型实验；目标解读及有效澄清仍由 R1 的具体场景验证，schema/hash 不证明语义正确。A1/A2/A4 仍待建，设计方向见[深入架构](exploration-evolution-architecture.md)。

### Task 自主构造与可选人审

**方向已确定，T2/T3 已实现并验收（2026-09-23）**：节点可以复用、组合或直接生成任务实例，不以“先找不到模板”为必要条件。现有 `task_decompose` 已允许现场给出 objective/AC/capability；T1 已收敛 Task 语言与持久化合同，T2/T3 交付组已落地生成审核策略、提案生命周期与崩溃恢复（§5.10），整组已验收。

区分三类变更：当前目标下的新任务实例经机器准入、可选契约人审后执行；共享模板作为 Evolution 改进候选验证并晋升；已接受的根目标/AC、生产能力及权限变化走各自已有或待建的变更协议。任务生成人审开关仅影响第一类，不能绕过后两类的治理。

`Config.generatedTaskReview: off | all` 已实现，默认 `off`（闭合 schema，未知值拒启，见 `task-runtime/src/index.ts`）：`off` 保持既有自主分解行为并把策略记在提案上（`policy-off`，不伪记批准），`all` 审核整批规范化契约与内容身份，批准并重检通过后才准入。机器校验在两种模式下都执行；无审核人、取消或拒绝不能自动视作批准（渠道不可用保持待审并说明原因）。审核等待是提案状态（`pending_review`），不借用 Task 的能力/证据 `blocked` 状态。节点负责生成与修订，人只审核契约，不代写任务，也不提前判定任务成功。

详细规范、模块落点、状态机、异常路径与 T1–T3 验收见 [Task 自主构造建设指导](task-contract-construction-guide.md)。规范限定可表达的结构与治理边界，不试图穷举人类任务，也不声称能机械证明自然语言契约完整。

详细规范、模块落点、状态机、异常路径和 T1–T3 验收见 [Task 自主构造建设指导](task-contract-construction-guide.md)。规范限定可表达的结构与治理边界，不试图穷举人类任务，也不声称能机械证明自然语言契约完整。

详细票据见 [建设计划](2026-09-20-vrtc-code-change-plan.md)。以下是依赖顺序，不是任务执行 workflow。

先期工程记录见[执行入口](execution-prompts/README.md)与建设计划，详细实现见 §5。本次仅重开有具体反例的 A0/R2/R1，不撤销其他历史验收；A2 合同草案在补救关闭后核对。S4-E 评估基础先于自动候选执行，不阻塞 R1 基础验证。已有机械保障不替代自主修复与恢复，也不证明自然语言验收完整或证据来源真实。

| 顺序 | 建设目标 | 完成条件 |
|---|---|---|
| S0 | 文档基线与递归能力发现 | 状态统一；worker 能查询能力表且没有获得管理工具 |
| S1 | 可信验收与可追溯能力绑定 | 错产物不通过；父 AC 有组合验证；不存在的 skill 和冲突 preset 在派发前拒绝；run 可定位实际实现 |
| S2 | 缺口处置、supervisor 交接与恢复 | 缺口持久化、去重；将诊断/候选工作交给 agent；补足后系统恢复受影响任务；与 S3 同批验收 |
| S3 | L1 复用/组合，再 L2 生成 | 制造 GAP 后由 agent 自动补路径；新候选通过验证并经人审晋升后系统恢复，无需人工补写能力 |
| S4 | Retro 与自动接受规则 | observed/holdout 分开过关；按变更目标使用不同指标；坏候选被拒绝 |

上表 S 编号表示责任领域，实际派发及拆分以建设计划为准。S1 受支持合同和 S4-E 评估是候选晋升前置。A6/S2-R/S3 完整交付：故障可注入，但解决路径由 agent 产出，不能止于人工填配置。L3 引入新工具继续走权限流程。长期记忆、通用全局调度器、复杂 skill 成熟度系统后置，均不替代已承诺行为的完整验收。

运行可行性已由 A3 统一落地（2026-09-22，§5.9）：状态迁移、效果交接、恢复和根预算归属集中在 Task runtime；普通/replay/恢复共用规则，工作区写入归属覆盖跨批次/跨根冲突。新建子任务、候选或 Run 不重置总预算；反复同一失败、改写计划不能自动计为进展。硬限额必须可执行，未知费用不记零。

迭代有效性由 S1-C/S4-E/S2-R 衔接：S1-C 已固定 Run 实际加载的版本，apply 不热换在途实现；可比的基线/候选实验与应用后恢复仍待 S4-E/S2-R。后续比较须从相同初始输入在隔离工作区执行，证据适用性决定能否复用成功兄弟结果；任务内经验不自动晋升共享能力。模型成功率与成本改善需真实实验，协议通过不等于已证明进步。

## 4. 当前实现与缺口

### 4.1 源码复核表

本表汇总各票已注明的交付事实；2026-09-23 文档复核重点核对根入口、默认工具、provider 预检及根预算的现有接线，未重新运行全部测试。状态描述明确范围，不把“类型有字段”算成整项完成；函数名是定位锚，行号以当前 checkout 为准。

| 能力 | 当前事实与限制 | 源码锚 |
|---|---|---|
| Task / TaskRun / 递归分解 | 有独立对象、事件存储、结构准入、树与依赖 DAG、顺序级联；原子性和自然语言 AC 覆盖不由机器证明 | `task/src/types.ts`；`task-runtime/src/admission.ts:checkDecomposition` |
| Task 语言与生成审核 | 已能现场生成子任务，无模板命中要求。T1 已收敛为单一规范化契约与身份（§5.6）：`TaskContract` 数据定义、闭合字段集与默认值、criterion id 固定、单契约/整批摘要、`contract` 与 assumptions/constraints 持久化，普通分解/replay/root 共用同一入口与结构校验。T2/T3 已补生成提案审核（§5.10）：`Config.generatedTaskReview: off/all`（默认 `off`）、不可变提案记录（整批契约内容 + 策略 + 两个上下文指纹）、`off` 只记 `policy-off` / `all` 批准并重检后才准入、提案决定绑定摘要、四个崩溃点的恢复与 requestKey 幂等。A0 让根契约走同一套记录与审核（§5.11，`TaskProposal.kind` 判别字段）。模板库与契约修订入口仍未建 | `task/src/contract.ts`；`task/src/proposal.ts`；`task-runtime/src/normalize.ts`；`task-runtime/src/proposal.ts`；`task-runtime/src/index.ts:submitDecompositionProposal`、`submitRootContractProposal`、`continueProposal`、`decideProposal`、`reconcileProposals`；`task/src/service/state.ts:assertContract`、`decideProposal` |
| Task 定义版本 | 有 `definitionRef`；普通子任务使用 `subtask@1`，根任务使用 `root@1`，不等于完整不可变定义库和变更授权机制。T1 固定的是契约内容身份（`contractDigest`/`proposalDigest`），未建模板库 | `task-runtime/src/index.ts:decomposeAndRun`；`task/src/contract.ts:contractDigest` |
| 根目标入口 | **A0 已实现，Q2/Q3 返工已关闭（§5.11、§5.13）**：`graphs.create` 只建 graph + root session 并调 `adoptRoot`，不再建根任务；`task_intake` 用真实用户目标构造契约（至少一条 mandatory 非 composite 判据，否则具名拒绝零副作用），经可选审核后一次原子提交激活根任务 + 根 run；契约接受前 `task_read`/`task_status` 返回具名「尚未激活」视图，graph name 不再进入 objective；旧图的根任务按历史读取/验收/完成，其上 intake 具名拒绝；终态根 session 不复活。**来源与归属**由统一服务入口（提交/续跑/恢复三处共用 `assertRootContractOrigin`）机械校验：store 必须等于该 session 自己的 store、会话必须是顶层会话（`origin: 'subagent'`/`delegationDepth` 拒绝）、会话自身日志必须有 `source.kind === 'user'` 的本人消息；日志不可读即具名拒绝，全部发生在首次写入之前（不创建 store）。本运行时的 `spawn`/`prompt` 提示词改记自有来源 `runtime-prompt`，不再冒充人类输入。`adoptRoot` 无根任务时先跑既有恢复遍再读回（`ready`/`approved` 激活并绑定、`pending_review` 重发、空 store 具名 `adopted:false` 零写入）。仍未建：契约修订入口（修订=新提案）、模板库、A1 上下文投影；模型对请求的解读与有效澄清属 R1 具体场景；服务层不校验「该顶层会话属于某 graph」（该规则仍在工具层） | `graphs/src/index.ts:create`（改调 `adoptRoot`）；`task-runtime/src/index.ts:intakeRootContract`、`submitRootProposalOnce`、`continueRootProposalIn`、`reconcileRootProposal`、`assertRootContractOrigin`、`adoptRoot`、`nothingAdoptedDetail`、`admitRootProposalIn`；`agent-runtime/src/{index,types}.ts`（`RuntimePromptSource`/`runtimePrompt`）；`agent-singularity/src/tools/{task-intake,root-store}.ts`；`task-runtime/src/admission.ts:rootIndependenceDefects` |
| Capability | 配置表解析、准入 provider 预检与真实 grant 已建；执行型/知识型侧车契约经统一校验，run 级内容绑定固定实际实现（§5.8）；没有可行性证明或多候选选择 | `capability.ts:resolveCapabilities`；`provider-precheck.ts`；`sidecar.ts:validateSkillProvider`；`run-binding.ts`；`grants.ts:grantSkills` |
| Handoff / 上下文 | fresh session、handoff、父会话引用、契约系统投影已有；实际主要传父目标/依赖证据/assumptions，worker 摘要含本 run 选定 capability/skill 绑定（S1-C）；根全局 brief、带来源决定和动态有界 ContextView 待建；原始 session query 按 cwd 授权，不等于图/group 隔离 | `handoff.ts`、`orchestrate.ts:buildHandoff`；`run-binding.ts:renderRunBinding`；`agent-runtime/src/contract-reinjection.ts` |
| 父子交互 / 生命周期 | A3 已改非阻塞（§5.9）：task_decompose 准入后立即返回 batchId，父进入 waiting_children（运行时闸只放行读/状态/诊断/task_cancel），子全部终态后父由 runtime 自动提交验收；worker 经 task_submit_result 显式提交，session idle 不再是完成证据（无进展相位机：标记→一次提醒→到限停止）；取消/恢复/卸载经 cancelBatch/cancelGraph/dispose/reconcileStore。A0 之后根 session 的生命周期不同：契约接受前没有 run（读作「尚未激活」），接受后根 run 出生 `active` 并自决工作，终态即 session 置 `terminal`、迟到 intake 被闸/状态双重拒绝（§5.11）。取消进行中（`cancelGraph` 已关闸、取消未落盘）时，只读查询与协调读不能把闸改回 `active`；取消已经跑完、只留旧读取的返回值时同样不能（闸按自己的决定计数丢弃陈旧值）：重启恢复（waiting_children/终态）仍照 store 补闸，合法 active 执行不受影响（§5.12）。持久 question/answer 与问答等待仍属 A4（字段挂载点已持久化）。DSH send_message 不能直接用于未注册 continuable activation 的这些子节点 | `task-runtime/src/index.ts:decomposeAndRun`、`adoptRoot`、`orchestrate.ts:driveBatch/observeWorkerRun`、`gate.ts`、`agent-singularity/src/tools/{task-submit-result,root-store}.ts`；`agent-runtime/src/index.ts:spawn` |
| 任务导航 / 诊断 | task_read 当前任务、task_status 整树；review pack 有局部证据及父子摘要，只读 reviewer 可写 Diagnosis；无合法动作投影、因果遍历协议或自动 supervisor incident 调度 | `agent-singularity/src/tools/{task-read,task-status,task-review-pack,review-agent}.ts` |
| Evidence 依赖 | `requiresArtifact` 只认 verified run 且带 pass 判据的证据；`acceptsArtifact` 只要求存在。普通分解缺失时 blocked + Obligation；replay 的 spawn 开/关路径使用同一检查，缺失时在建任务/Run 前抛错，零派发/零成功记录。不自动生成上游，不验证匹配证据的版本和适用性 | `orchestrate.ts:missingRequiredArtifacts`、`runReplayTask` |
| Obligation | 记录缺能力/缺产物；模板 coverage 由任务声明 capability 或文字提及匹配；不是义务已被证据满足，更不是防漏的硬闸 | `task-runtime/src/obligation.ts:checkObligationCoverage` |
| 判决 | `pass/fail/inconclusive`；部分 unknown 有 task/verifier 分类；没有 PARTIAL 状态与剩余义务自动派发；未通过 mandatory 判据仍走失败路径；`heuristic` 标记的判据永远不计入确定性通过 | `task/src/types.ts:VerificationResult`；`orchestrate.ts:unmetMandatory` |
| Verifier 边界 | 注册即执行可执行自测（`VerifierSelftest.samples` 正负样本；缺样本、描述性样本或漏检样本拒绝注册，唯一例外是调用者显式声明的 `{ testDouble: true }` 并记录警告）。判决与 claim 记录**实际注册实例**的 `version`（插件自报一律被覆盖；版本归属规则见 §5.7：只有实际判决、或由 registry 归因到已解析裁判实例的拒绝才带版本，未知 ref 与不支持 mode 的拒绝不带）。criterion 声明的受保护验收输入在准入时固定 `{ path, sha256 }`（读不到即整批拒绝），判决前复检：缺失或被改 → `fail` 点名路径且不派发；store 里畸形声明（绕过准入口直写）得到点名条目的可读 `fail`，不是崩溃。仍未建：verifier 与执行者的独立性隔离（`owner` 只是元数据）、证据来源真实性认证、自测样本“有意义”的证明；KISS §8.2 的裁决召回未建（R2 已撤回无消费者的 `(verifierRef, version)` 查询入口 `evidenceByVerifier`，§5.12） | `verifier/src/index.ts:register`、`selftestGate`、`verifyCriterion`；`verifier/src/protected-inputs.ts`；`task-runtime/src/protected-inputs.ts` |
| 父验收 | 默认无映射 composite 保持子全 verified；childEvidence 必须存在且来自 verified run，被引用子判据为 heuristic 时拒绝。registry 在自定义 verifier 执行前同样检查映射，合法映射仍须通过所选 verifier，插件不能覆盖映射规则。父 mandatory heuristic 不计确定性通过；requiresIndependentAcceptance 缺映射时准入拒绝 | `composite-verifier.ts:entryDefect`；`verifier/src/index.ts:verifyCriterion`；`admission.ts:independentAcceptanceDefects` |
| 预算 | A3 已建根预算（§5.9）：`Config.rootBudget`（wallTimeMs/maxRuns/maxConcurrentWrites=1，闭合 schema，未知成员具名拒启）；run 期限 = min（配置 wallTimeMs，根剩余），从持久化 run.startedAt 起算、重启不重计时；maxRuns 按 runId 记账、崩溃重数不退款不重置；replay 经 rootTaskStoreId 根绑定共享 store 根总额；无进展相位机（标记→一次提醒→到限停止）已接线。tools/tokens 仍仅终态软统计（unknown 不记零）；attempts 仅声明 | `root-budget.ts:resolveRootBudget/checkRunStart/hasRootLimits`；`orchestrate.ts:observeWorkerRun`、`budgetBreaches`；`task-runtime/src/index.ts:Config` |
| L4 上报 | root 的 `escalate` 工具与台账已有；模型主动调用，批准后才记 raised；运行时只输出提示，无自动触发、无处理结果/恢复闭环 | `agent-singularity/src/tools/escalate.ts`；`orchestrate.ts:escalationHint` |
| blocked 恢复 | blocked 无恢复出边；TaskRetried 只接受 failed，父分解一次的限制仍在；补能力后不会自动续跑原图 | `task/src/service/state.ts`；`task-runtime/src/index.ts:decomposeAndRun` |
| Review / Evolution | 已有工具链；机械候选 PROMOTE/apply 要求 observed、holdout 各自非空且不退化，报告按明细重算并校验记录时摘要。单文件 Skill 候选内容已绑定（P2）：prepare 记录实际物化 SKILL.md 的 SHA-256，replay 报告携带同一身份，`replayed` 记录写入前、晋升预检与 decide(PROMOTE)/apply 服务入口均复检候选文件，apply 只写入已校验字节。生产基线已固定（P3）：prepare 用同一次读取的生产文件得到 champion 快照与 `skillBaseline` 摘要，apply 工具在人审前、服务在实际写入前复检生产目标仍等于该基线（captured 要求普通文件摘要一致，missing 要求目标仍不存在；缺失/内容不同/类型改变/符号链接路径均明确拒绝），过期候选不写生产、不记 applied，也不自动覆盖或改写原 proposal。未实现其他 targetType 的内容绑定、真实证据来源校验、分层指标或自动 Retro | `agent-singularity/src/evolution.ts:prepare`、`readSkillCandidate`、`checkPromotion`、`checkProductionBaseline`、`writeProduction`；`replay.ts:assertReplayReport` |
| root-agent 构建类型闸 | `agent-singularity` 的 `build` 为 `tsc --noEmit && tsdown`，类型错误即构建失败；工作区根 `pnpm build`（`pnpm -r run build`）经过同一检查。2026-09-21 前该包 `pnpm build` 只有 tsdown，不保证严格类型检查通过 | `agent-singularity/package.json` scripts.build |
| 身份与枚举的类型来源 | 工具侧 `sessionId(exec)` 直接返回上游 `Agent.id` 的 `SessionId`，不再降级为 `string`；`DiagnosisProposal.targetType` 与 `evolution_propose` 的 targetType 由 `@dangosys/dsh-singularity-task` 的 `ProposalTargetType` 标注并经运行时校验，不是任意字符串断言 | `agent-singularity/src/tools/task-diagnose.ts:toProposals`；`src/tools/evolution-propose.ts:isProposalTargetType`；`src/evolution.ts:validateMutation` |

### 4.2 优先修复的断层

| 编号 | 问题与影响 | 建设票 / 历史对应 |
|---|---|---|
| G1 | 父 composite 曾仅对子状态求合取，不能证明根目标；同环境执行 verifier 也不等于测试与阈值不可被修改。P4 已落地最小机械版（切片 1+3：父 AC `childEvidence` 映射、独立父级组合检查、`heuristic` 标注、原始输入与已验证参考产物区分）；S1-V 切片 2 已落地 verifier 自测的实际执行（注册闸）与声明式受保护验收输入的准入身份固定 + 判决前复检。剩余：C3 假设满足性的完整证明、未声明保护范围的输入仍不受保护（这是边界，不是“已保护”）、证据来源真实性认证、自测样本“有意义”的证明 | S1-V / 旧 #25、#26 |
| G2 | provider 预检、run 级内容绑定与统一校验入口已由 S1-C 落地（§5.8）：不存在的 skill、未知执行 verifier、工具声明不满足、冲突 preset 在落库前拒绝；run 可定位并实际加载绑定的旧版本。单文件 Skill 候选内容身份（P2）与生产基线（P3）保持。剩余：`closed` 仍不证明自然语言契约完整或搜索路径必然成功；skill 晋升执行器只支持单文件；证据来源真实性认证未建 | S1-C / 旧 #29 |
| G3 | 缺产物曾只查存在且 blocked 无恢复，证据驱动生长断在登记之后。P4 已把存在性收紧为 verified 参考产物并区分原始输入（`acceptsArtifact`）；blocked 仍无恢复出边，补产物后不会自动续跑原图 | S1-V、S2-R / 旧 #20、#21、#22 |
| G4 | 上报依赖模型调用且批准前不落账；任务阻塞、通知与人类决策混在一起 | S2-E / 旧 #27；已有工具不能标为待建 |
| G5 | 判决仍三值，缺 PARTIAL/UNKNOWN 的任务级恢复处置。A3 已实现根时间/run 数/唯一写入预算及无进展停止；tools/tokens 仍为软统计、attempts 仅声明，不能一概写成预算未接线 | S2-R / 旧 #23、#24；根预算已由 A3 交付 |
| G6 | 类型化侧车契约与知识型定位已由 S1-C 交付（§5.8），建设依赖倒置已解除；L1 复用/组合与 L2 生成候选仍待 S3，候选须经同一校验与验证闭包 | S1-C → S3 / 旧 #29 |
| G7 | 已补报告自洽、机械晋升最低闸、单文件 Skill 候选内容绑定（P2）与生产基线检查（P3）；证据来源绑定、分层指标和自动 Retro 未建，当前不能宣称防止裁判弱化或过拟合 | S4 / 旧 #28 |
| G8 | `task_decompose`/`escalate` 部分拒绝返回普通文本，上层不能可靠用工具错误信号判定 | S2-E / 旧 #33 |
| G9 | 类型闸只覆盖 `agent-singularity`；其余 Singularity 包的 `build` 仍只有 tsdown，未接 `tsc --noEmit`，其严格类型状态未经本闸保证 | P1 范围外，待独立评估 |
| G10 | 动态生成已存在，无生成提案审核协议的风险已由 T1+T2/T3 关闭（§5.6、§5.10）：统一可持久化契约、闭合字段集、内容摘要与准入记录（T1）；`generatedTaskReview` 策略、不可变提案与整批内容、决定绑定三个摘要、批准后重检、requestKey 幂等与四个崩溃点恢复（T2/T3，2026-09-23 已验收）。仍未建：Task 模板库（模板不是合法性白名单）、契约修订入口、多进程并发写同一 store 的恰好一次保证 | T1、T2/T3 交付组 / Task 自主构造指导 |
| G11 | 根 objective/AC 入口过弱；上下文传递缺根目标、祖先决定来源与新鲜度；根目标错了时全局传播不能补救。**A0 已实现、Q2/Q3 返工已关闭（§5.11、§5.13）**：根任务延迟到真实用户目标/AC 被接受后激活，graph name 不再进入 objective，缺独立顶层判据具名拒绝；根契约的来源与归属由统一服务入口机械校验（store↔session、顶层会话、会话自身日志的本人消息；不可读即具名拒绝），本运行时提示词不再冒充人类输入，`adoptRoot` 无根时经既有恢复遍完成恢复；仍未建：A1 的上下文投影（根目标/祖先决定来源与新鲜度），以及「模型对用户请求的解读是否正确」的语义证明——机器准入只管结构、判据种类与来源归因，该项属 R1 | A0（返工关闭）→ A1 |
| G12 | 父同步等子的循环等待已由 A3 解除（§5.9：分解立即返回 batchId、waiting_children 运行时写闸、显式提交、无进展停止，idle 不再等同执行结束）。仍缺：持久 question/answer 与问答等待（task_ask_parent/task_answer 属 A4）；不能仅添加 ask_parent 或开放 send_message | A3（已交付）→ A4 |
| G13 | task_status 全树文本不表达执行权/合法动作；session 同 cwd 可读比 group 边界宽；reviewer 局部 pack 不等于跨图因果 debug | A2/A5 |
| G14 | root/worker prompt 与当前方向有漂移：L4/manual、直接问人、make command exit 0、分解意图矛盾；未来工具必须随真实协议接线再写入提示。**R0 已关闭工具面的漂移部分（2026-09-23，已验收，§5.11）**：allow-list 与 prompt 由同一开关布尔派生（off 时提示词不含进化协议段、工具面不含九个 `evolution_*`），并新增根 intake 段（`task_intake`、未激活视图、审核策略、激活前不得 `task_decompose`）；其余角色模板（A1–A6）仍逐票同步 | R0（已验收）→ A0–A6 逐票同步 Prompt 合同 |
| G15 | 根工具无条件暴露进化链、通用 prompt 混入 BB 指导；runtime 职责集中，未使用接口/仅诊断摘要易被误读为完整保证；缺真实模型运行反馈。**R0 部分关闭（2026-09-23，已验收，§5.11）**：进化链改由装配开关决定是否注册（off = 只注册 19 个常驻工具，on = 28 个，与之前逐名相同），BB 句子从通用 root prompt 移除、领域指导归部署的领域 skill；不新增主管、不合并审批。R1 已补真实运行反馈（2026-09-23）。**R2 已关闭「未使用接口/仅诊断摘要」部分与取消写闸返工（Q1，§5.12）**：`evidenceByVerifier` 无消费者已撤回；`templateDigest` 标明仅诊断、无身份保证；三个无消费者导出（`TaskProposalKind`/`TaskProposalDecision`/`TASK_PROPOSAL_ID_PREFIX`）收回；取消进行中的写闸不再被只读查询/协调读解除，跨取消完成点的陈旧读取也被闸的决定计数丢弃（`closingStores` + `applyStorePhase`，两轮交付 `250a04f`/`8f9086e`）。仍待：runtime 职责集中（drivers 推状态模型）按证据保留、不预定 pull 化；§5.12 记的四项既有取消边界（spawn 续跑、另两条 store 派生写相位入口、`closingStores` 非重入计数、`unload` 无 store 记录）未修 | R0（证据保留）+ R2 Q1（已关闭）+ R1（返工） |

历史记录中的 M1–M9 为此前会话的实跑声明，保留于历史指南。本次回归结果见建设计划 S0；本次没有重跑 LLM、BB 构建仿真或生产 Evolution 链路。旧环境可用性、外部 bbdev 缺陷和部署阈值在使用前需重新读取对应部署，不能从旧日志推断当前状态。

各票的实现范围与剩余边界见上表及 §5；提交、日期和实跑证据统一查建设计划对应验收记录，不在此重复整段交付流水。P4 原交付与后续修复须分别读取；S1-V 切片 2 于 2026-09-21 开始、22 日验收。当前已交付的机械保障不代表根入口、问答、自然语言完整性或自主修复已完成。

## 5. 实现时的关键约束

### 5.1 验收先于自动生长

P4 `f6886cf` 的完成声明经复核发现三个组合路径漏洞，本轮修复 replay 输入检查、子 heuristic 引用及自定义 verifier 绕过。原 739 项通过不足以证明这些规则成立；新增交叉路径正反例见 `tests/integration/parent-acceptance.spec.ts`，修复验证记录见建设计划 P4 修复节。原提交的历史结论不作为当前验收证据。

现有 command verifier 与 worker 共享 checkout：外部进程运行命令只提供执行分离，不保证 worker 无法修改测试、脚本或阈值。建设目标是固定验收输入的来源与版本，保护判据，记录 verifier 版本及证据产物身份；自述 JSON 和退出 0 均不能单独证明领域正确性。

**父级验收与证据身份已落地（2026-09-21 P4，S1-V 切片 1+3）**：父 AC 用可选字段 `childEvidence` 声明“需要哪些子任务的哪条判据/哪类证据”——子任务按分解 batch 位置（0 基，与 `dependsOn` 同一索引词汇）指向，可再窄化到子判据 id 与证据引用（evidence id / artifact kind / artifact id 三种拼写），composite 在父验收期对照 store 校验该映射真实存在且证据来自子任务的 verified run，不完整则拒绝并在 reason 逐字点名缺失项；缺省（无映射）完全保持现行“子全 verified”合取行为。独立父级组合检查有两条可机械执行的形式：映射断言本身，以及父 AC 的确定性 `command`（接口/数值级判据，子全 verified 但组合错误时父必须拒绝）。`heuristic: true` 标记的父 AC 是自然语言条款：verdict 显式带 heuristic 标注，且不计入确定性通过。`requiresArtifact` 收紧为“已验证参考产物”（产出 run 终态 verified 且 bundle 带 pass 判据），原始输入改用 `acceptsArtifact`（存在即可，任意 run 状态）；契约级标记 `requiresIndependentAcceptance` 要求映射存在，新建/分解路径 admission 对映射缺失/被删/形状畸形响亮拒绝，不静默降级为合取；replay 路径与普通分解共用同一校验规则。

范围边界：映射按 batch 位置指向，不做通用自然语言蕴含求解器，也不做 C3 假设满足性的完整证明（只做映射指向存在性的结构检查）；verifier selftest 正负样本的实际执行与声明式输入身份固定已由切片 2 落地（见 §5.7），证据来源真实性认证、blocked 缺产物后的自动恢复（S2-R）均未建；**未声明保护范围的输入不受保护**（这是边界，不是“已保护”）。旧任务（无新字段）读取、回放、验收行为不变；`requiresArtifact` 的收紧对旧声明同样生效——失败 run 的同名产物不再满足依赖，这是本票的修复点而非兼容性破坏。另有三个已知边界如实记录：replay 任务按设计无父无子，携带 `childEvidence` 映射的候选契约失败关闭（当前 replay 不存在“能通过”的父级映射表达）；`evidenceRef` 的三种拼写只匹配 `EvidenceBundle`（evidence id / artifact kind / artifact id），真实链子上 `TaskRun.artifacts` 恒空，匹配不依赖它；composite `entryDefect` 的逐条目子任务状态检查位于“子全 verified”合取闸门之后，当前调用路径下不可达，属防御性分支（未验证子任务由合取闸门拒绝并点名）。

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

### 5.7 验证器自测与受保护验收输入（2026-09-21 开始，22 日验收，S1-V 切片 2）

范围（S1-V 三个切片中，父级验收与证据依赖由 P4 交付；本票只做切片 2，不重做父级映射与产物依赖语义，也不提前做 S1-C 的统一校验入口）：

- **可执行自测与注册闸**：`Verifier.selftest` 从描述性文字改为可执行样本 `{ role, name, criterion, expect, store? }`（`task/src/types.ts:VerifierSelftestSample`）。`VerifierRegistry.register` 改为 async：注册前按顺序真实执行每个样本——只带 criterion 的走 `verify()`，带 `store` 视图的（目前只有 composite，且由 registry 自己的实例执行）走导出的纯函数 `judgeCompositeCriterion`——再用与生产完全相同的校验（数量、criterionId、verifierId、状态、unknownKind）比对 `expect`（`pass`/`fail`/`not-pass`）。漏检负样本、正样本未被通过、缺样本、混合形状、无法执行的 store 样本都使该裁判**不可用**并给出点名原因；结论来自执行。三个内建各自带真实样本（command：`true`→pass、`false`→fail；review：已知好/坏样本都不得被判 pass——不可自动通过裁判的等价形态；composite：满足/不满足 `childEvidence` 映射的两个 store 样本）。生产注册只有 `register` 一条替换路径（已核实无其他入口）；测试替身必须由调用者显式声明 `{ testDouble: true }` 并记警告（警告经 cordis logger 输出，未挂载 logger 的上下文不会打印，但跳过本身就是显式声明，不是静默推断），没有“缺 selftest 就跳过”或“形状不对就降级”的静默后门。内建经幂等 `ready()` 注册，cordis `Service.init` 调用它，`verifyRun` 也先 await；ready 之前注册表为空、派发拒绝（fail-closed）。
- **裁判版本**：`verifyCriterion` 用**实际注册实例**的 `version` 覆盖/移除插件自报值并写入 `VerificationResult.verifierVersion`，`claim()` 同步复制；版本变更不改写历史证据（事件只追加）。版本归属规则：registry 自己做出、且解析出了裁判实例的拒绝（受保护输入失配、映射不通过）带该实例版本；无法解析出裁判的判决（未知 ref、不支持 mode、裁判抛出）不带版本——不冒充“裁判给出了判决”。按 `(verifierRef, version)` 查询证据的索引入口曾在本票交付、无生产消费者，2026-09-23 R2 已撤回（§5.12）。
- **受保护验收输入**：`AcceptanceCriterion.protectedInputs` 由调用者按路径声明（`CriterionSpec` 与工具 schema 接受字符串）。`decomposeAndRun` 在唯一规范化入口**之前**用 `fixSpecProtectedInputs` 对着会话 checkout 逐个读文件、把路径替换为 `{ path, sha256 }`；路径读不到或 checkout 无法解析则整批拒绝、零副作用。固定形态由 `contractDefects`（经 `protectedInputDefects`）在普通分解与 replay 共用的规则里校验，内容摘要覆盖固定后的身份。replay：候选契约的字符串形态按 replay 调用者的 checkout 固定；冠军任务已存的固定形态原样携带，不重读、不发明。判决前 registry 用 `protectedInputDefects(request.cwd, inputs)` 复检：缺失或被改 → 该判据 `fail`（点名路径与摘要变化）且**不派发**裁判。未声明（或空声明）的判据不读、不检查，也不得被描述为“已保护”。
- **渲染消费者**：spawn prompt 与 worker 契约块的判据表新增 `protected inputs` 列（未声明为 `—`），并加一条“不得修改声明的受保护输入”的行为规则；`task_read` 的判据行同样列出声明路径；`task_decompose` schema 增加 `protectedInputs`；review record 与 review pack 带 `verifierId`/`verifierVersion`（如 ` [command@1]`）。

源码锚：`verifier/src/index.ts`（`register`、`selftestGate`、`executeSamples`、`stampVersion`、`verifyCriterion`、`ready`、`[Service.init]`）、`verifier/src/{command,review,composite}-verifier.ts`、`verifier/src/protected-inputs.ts`；`task-runtime/src/protected-inputs.ts`、`task-runtime/src/index.ts`（`decomposeAndRun`、`replayTask`、`sessionEnv`/`envPathForSession`）、`task-runtime/src/admission.ts:contractDefects`、`task-runtime/src/normalize.ts`（`protectedInputs` 进入闭合字段集、形状规则仍在 admission）、`task-runtime/src/{contract,handoff}.ts` 的判据表、`task/src/types.ts` 的样本/版本/受保护输入类型、`task/src/contract.ts:sha256Hex`。

测试锚：`verifier/tests/unit/verifier-registry.spec.ts`（注册闸正反例、testDouble 显式通道、版本覆盖、受保护输入失配/缺失且不派发、索引与旧证据）、`verifier/tests/unit/{composite,command}-verifier.spec.ts`（可执行样本）、`task-runtime/tests/unit/protected-inputs.spec.ts`（fixing、形状、摘要敏感度、零副作用）、`task-runtime/tests/unit/{orchestrate,admission,normalize,contract,handoff,review-record}.spec.ts`、`agent-singularity/tests/unit/task-tools.spec.ts`（schema 与渲染、review pack）、`tests/integration/verifier-selftest-inputs.spec.ts`（真实 TaskService+TaskRuntime+VerifierRegistry：worker 改写受保护脚本的反例、合法正例、未声明边界、注册闸、版本与索引、拒绝零副作用，结论全部从持久化事件日志读回）。实跑命令与数量见建设计划「S1-V 切片 2 执行与验收记录」。

未覆盖/边界（如实记录）：criterion 只保护**它声明的**路径，未声明的不受保护；没有内容来源真实性认证（字节是谁在何时产生的仍不可证）；自测样本由裁判自己声明，本票只证明“能区分声明的样本”，不证明样本有意义；`verifierIds()` 同步读取，未 ready 的手工构造上下文会看到空表（生产由 `Service.init` 覆盖，集成测试显式 `await ready()`）；`targetType: verifier` 的 Evolution 候选仍只记账、无机械执行器，显式拒绝不变；KISS §8.2 的裁决召回（漏检裁判的历史 PASS 自动降级重验）未建——`(verifierRef, version)` 查询入口（`evidenceByVerifier`）已在 2026-09-23 R2 因无消费者撤回（§5.12），召回有真实消费者时按新票重建。

### 5.8 能力预检与版本绑定（2026-09-22 S1-C）

范围（建设计划 §S1-C 四点：provider 预检、类型化侧车契约、统一校验入口、run 摘要与选定内容绑定；效率对比实验不属本票，记为票后工作，本票不声称任何效率结论）：

- **准入期 provider 预检**：`task-runtime/src/provider-precheck.ts` 的 `precheckProviders` 在 `decomposeAndRun` 与 `replayTask` 落库/spawn 之前执行（`index.ts` 两处挂点），用实际 worker 视角（会话 checkout 的 cwd 上溯 + DSH_HOME + 用户根；replay 含候选 overlay 根）检查每条命中能力声明的 skill：发现不到、frontmatter 名不符、侧车非法均整批拒绝、零副作用（无任务事件、无 spawn、无 Obligation 写入）；verifier 词表经 `registeredVerifierIds` 软取（先 `ready()`，不可列举时执行型 fail-closed）。preset 冲突、未知工具标签、未知 MCP server 的既有拒绝不变；MCP 启动失败仍在 spawn 阶段记录。闭包语义不变：能力闭包仍由配置表条目决定；知识型/无侧车（guidance）skill 可加载但不计为执行 provider。发现原语与 spawn 的 `grantSkills` 共用同一实现（`agent-runtime/src/skill-file.ts`，task-runtime 经其导出复用）。
- **类型化侧车契约**：`task/src/skill-contract.ts`（skill 目录内 `SKILL.contract.json`，`type: execution | knowledge` 判别联合，闭合字段集，`contractVersion` 1；执行型含 capabilities/precondition/inputs/outputs/requiredTools/verifier ref/内容身份；知识型含 source/scope/contentCheck/内容身份）；`task-runtime/src/sidecar.ts` 的 `loadSkillSidecar`/`validateSkillProvider` 为统一校验入口（结构化 defect 码）。内容身份覆盖 `SKILL.md` 精确字节与受支持多文件资源（`references/`、`scripts/` 一层 UTF-8 文本，逐文件 sha256）；符号链接、更深嵌套、非普通文件、受支持位置的二进制等形态显式拒绝并点名，不宣称单文件摘要覆盖全部执行环境。无侧车 = guidance：可加载、非执行 provider、非 defect。最小样例：`task-runtime/tests/fixtures/skills/`（ball-align、workload-tests 知识型；verify 执行型）。首版不做成熟度五级与成功率衰减。
- **统一校验四消费者**：配置载入（`Service.init` → `providerLoadReport`，逐条 warn 报告但**不硬 fail**——载入视角没有 worker checkout，"载入找不到"≠"worker 用不了"，硬闸在准入预检）、provider 替换（`EvolutionService.assertCapabilityRowProviders` 与 `TaskRuntime.applyCapabilityRow` 共用 `precheckReplacedCapabilityRow`；替换必经验证，移除不需要）、候选晋升（`assertSkillCandidateProvider`，叠加在 P2/P3 内容身份与生产基线检查之上）、准入预检。同一非法输入四个入口给出同一 defect 码；没有合法执行 verifier 的执行型 skill 不能被计为有效 provider（`executionProviders` 是唯一计数入口，知识型/guidance 恒不在其中）。skill 晋升执行器只写单个 `SKILL.md`：携带侧车/资源的候选**显式拒绝**（不静默丢弃、不记录生产上不存在的 execution-provider；目录整体晋升属后续票）。
- **Run 绑定与摘要**：`task-runtime/src/run-binding.ts` 在 run 启动时把选定 skill 物化为 run 级快照（默认 `<DSH_HOME|~/.dsh>/singularity/run-bindings/<storeId>/<runId>/skills/`，在 worker 写区之外；`Config.runBindingRoot` 可覆盖），逐字节比对准入身份后经 `WorkerGrant.skillRoots` overlay 加载——worker 实际加载快照字节，不是保存摘要后仍读可变生产路径。`TaskRun.providerBinding`（可选字段，旧事件无此字段可读）持久化 registry 修订、各 provider 角色与内容摘要、preset/MCP 身份、快照根与 uncovered 列表。worker 合同块/spawn prompt/`task_read` 三视图同源渲染选定实现摘要（`renderRunBinding`，含快照路径与修订），正文按需经 skill 工具读；review pack 打印绑定记录（只读事实，不回读盘）。`createRootTask` 重入与 `task_read` 展示前经 `readRunBinding` 复检快照身份：缺失/被改 → 具名拒绝，不静默回退生产路径。evolution apply 不热替换在途 run；新 run 绑定新内容（"换版本用新 Run"）；retry 入口当前不存在（`attempts` 仅声明），worker 无恢复 spawn 路径，如实记录。

源码锚：上述加 `task-runtime/src/verified-read.ts`（自 `agent-singularity/src/evolution.ts` 下移的唯一 verified-read 实现，evolution 改为引用）、`task/src/types.ts:TaskRun.providerBinding`、`task/src/service/state.ts:assertProviderBinding`（只校验形状）、`agent-singularity/src/tools/capability-list.ts`（provider 状态行）、`task-runtime/src/index.ts`（预检挂点、`providerLoadReport`、`applyCapabilityRow`、`readRunBinding` 服务方法）、`task-runtime/src/orchestrate.ts`（`bindRunProviders` 两创建点、`skillRootsForRun`）。

测试锚：`task/tests/unit/skill-contract.spec.ts`、`task-runtime/tests/unit/{sidecar,verified-read,provider-precheck,provider-load,run-binding,carried-precheck,capability}.spec.ts`、`tests/integration/{provider-precheck,worker-binding,provider-promotion,provider-version-binding,knowledge-provider,recursive-capability,run-skill-loading}.spec.ts`、`agent-singularity/tests/unit/{evolution,task-tools}.spec.ts`。实跑命令与数量见建设计划「S1-C 执行与验收记录」。

未覆盖/边界（如实记录）：配置载入只报告不硬 fail（语义与理由见 `providerLoadReport` docblock）；skill 晋升执行器只支持单文件 `SKILL.md`（含侧车/资源候选显式拒绝）；guidance 快照的 `uncovered` 复检只覆盖"快照出现身份未覆盖条目"方向（记录列出的源目录条目本来就不复制进快照，反向不是差异）；MCP 工具覆盖是前缀判定，server 真实工具表只有 spawn 才知道；run 快照无 GC/配额（A3/S2-R 领域）；`mcpServers[].templateDigest` 只记录渲染、无回读复检（R2 起类型文档标明：仅诊断、无身份保证；spawn 对缺失 server 具名失败）；worker 仍可读到部署 catalog 里未选 skill 的正文（DSH 无 per-agent 隐藏；授权面未变，有加载未选 skill 不扩权的回归）；预检视角不含仅 DSH 自带发现可见的 skill（该形态会 fail-closed 误拒，模块文档已点名）；快照只保证字节=准入身份，不证明内容正确；`contentCheck` 只识别并携带引用，没有 gate 执行它；效率对比实验（固定任务集与真实模型）是票后工作，不凭 token 变化宣布更高效。

### 5.9 非阻塞运行与恢复（2026-09-22 A3）

范围（建设计划文首表第 4 行完成闸：非阻塞推进、工作区写入归属、显式提交、取消/恢复、根预算与普通/replay 一致性；问答工具 task_ask_parent/task_answer 属 A4，本票只留持久化字段挂载点；设计合同与验收映射见 `docs/2026-09-22-a3-coordination-design.md`）：

- **准入与推进分离**：`decomposeAndRun` 两阶段（`task-runtime/src/index.ts`）——既有准入链（受保护输入固定→规范化→结构准入→能力缺口→provider 预检→verifierRef）顺序不变，新增父 run 相位必须 active、根预算预留、工作区归属检查，任何拒绝零副作用；原子提交（`admitBatchIn` 单次 commit）后工具 signal 失效（所有权转移给 per-batch AbortController），立即返回 `{ batchId, childTaskIds }`。推进函数 `driveBatch`（`orchestrate.ts`）可重入：每轮从 store 重读子状态，内存只缓存 handle/watcher；验证/依赖规则沿用原 cascade（`runChildrenCascade` 已删除，无第二套状态分支）。driver 失败经 `failBatchFromRuntime`：父 run failed + 诊断 + 通知 owner，不 fire-and-forget。`awaitBatch` 供服务/测试消费。
- **协调相位与显式提交**：TaskRun 持久化 `executionPhase`（active/waiting_children/submitted）+ `batchId`/`submission`/`noProgress`，及 A4 挂载点字段（`pendingQuestionIds`/`blockingQuestionIds`，无消费者）；新事件 `RunPhaseChanged`/`RunProgressMarked`（same-version；reducer 迁移闸只放行 active→waiting_children、active→submitted、waiting_children→submitted）。`task_submit_result`（新工具，ROOT_TOOLS 与 worker baseline 同步）：runtime `submitResult` 身份/状态重检 → 先落相位事件 → drain → verifier 排他执行 → 既有 unmetMandatory/终态 review；迟到提交读回已记录结果（去重靠相位唯一性）。session idle 不再是完成证据：active idle 无提交 → RunProgressMarked 计数 → 一次 followup 提醒 → 到限停止（诊断保留）；根 run 不挂无进展相位机（用户输入间合法 idle）。
- **写入收敛与执行闸**：`gate.ts` ExecutionGate 经 `tools/pre-execute`（prepend）+ `tools/result` 接线（Service.init；run-stack 等直构 harness 不在其内，闸的拒绝断言只在真实 loop 套件）；相位 ≠ active 时只放行 18 个协调工具（读/状态/诊断/问答挂载点/`task_cancel`），写/shell/再次分解/提交一律 deny，在途调用登记计入（发起提交/分解的调用经 `excludeCallId` 排除）。写入收敛三步共用：先持久化准入关闭 → `drainSession`（有界等在途写 + kill/wait 受管理 jobs）→ 启动子批次/转 verifier；不可确认 → 明确的不可验收诊断，禁止超时假定停止。
- **工作区唯一写入归属**：`workspace.ts` WorkspaceRegistry——realpath 规范化的 checkout 身份、归属栈（run→batch→子 run→verifier）、marker 文件（`<runBindingRoot>/workspace-owners/<sha256>.json`，pid 活性 + 尽力记录进程 starttime；每次写入使用自己的临时文件名，2026-09-23 前置缺陷修复——固定临时名曾让同一进程内两条链（子运行提交链的 verifier 层、批次 driver 的结算）并发改同一 marker 时互相吞掉临时文件、`rename` 抛 ENOENT；落地的写决定 marker 内容，归属交接仍由调用方串行）；冲突在副作用前抛 `WorkspaceBusyError`（结构化），无隐含等待队列；verifier 占排他执行期，栈顶属别的 store 具名拒绝验证（不兜底照常验证）；stale 标记仅恢复路径 `reconcileAdopt` 接管。单进程 registry + marker，不宣称跨进程锁；多管理进程接管同一工作区由 marker+pid 探测拒绝。
- **取消/恢复/卸载**：`cancelBatch`（仅该批次父 run 的 session 可调，闸放行表内）/ `cancelGraph`（graphs.remove 钩子在 stopGraph 前调用）/ dispose effect（abort 全部 driver → 有界结算 → 关闸 → 释放标记）。等待相位的子 run 仍竞争 [终态｜期限｜批次 abort]（`awaitWaitingTerminal`），嵌套批次取消有界结算；未启动子节点标 cancelled-before-start；两合法结算路径撞同一 run 时以 store 为仲裁。恢复 `reconcileStore`（store 打开/根收养时，按 run 粒度幂等——在飞 driver 的批次跳过）：先复用 S1-C `readRunBinding` 快照复检（被改 → 具名拒绝，不静默回退），再按相位机处置（submitted → 补验证；waiting_children → 按深度降序重启 driver；active 非根 → cancelled+诊断）；旧无相位 run 不改状态、不重跑，`task_read`/`task_status` 派生 needs-recovery，唯一合法动作是取消。
- **根预算**：`root-budget.ts`——owner = store 根任务（其 run 经 `rootTaskStoreId` 绑定回本 store；replay 的 parentless task 共享该根总额，不另建账本）；硬限制仅根截止（从根 run startedAt 计）/maxRuns（按 runId 记账、崩溃重数不退款不重置）/maxDepth（既有）/并发写=1（其他值构造期拒绝）；token/工具费用只作终态软统计（budgetBreaches，unknown 不记零）；闭合 schema + `hasRootLimits`（区分未配置与空配置），调用方配无法执行的硬限制 → `assertRootBudgetConfig` 具名拒启。普通/replay/恢复三入口同守（`replayTask` 不跳过 `checkRunStart`）。进展计数用快照可计算的子树条目和（tasks+runs+edges+evidence+handoffs+reviews+diagnoses+obligations），自然语言“有进展”与重复失败调用不清零；到限停止并保留诊断，不调用尚不存在的主管入口（A5）。
- **signal 转移**：工具 `exec.signal` 只管准入段；原子提交后批次由 per-batch AbortController 拥有；取消源 = cancelGraph/cancelBatch/根期限/dispose；有测试证明工具返回/abort 后批次继续、graph 取消才停止。

源码锚：上述加 `task/src/types.ts`（ExecutionPhase/SubmissionRecord/NoProgressRecord、TaskRun 新字段）、`task/src/index.ts`（`changeRunPhaseIn`/`markRunProgressIn`/`admitBatchIn`；`cancel` 源状态放宽为 running/verifying——行为收紧修复点，已写入持久化记录）、`task/src/service/state.ts`（迁移闸）、`agent-singularity/src/tools/{task-submit-result,task-cancel,run-phase}.ts` 与 `task-decompose.ts`（立即返回）、`agent-runtime/src/prompts/root.prompts.ts`、`task-runtime/src/handoff.ts`（显式提交协议）、`graphs/src/index.ts`（remove 钩子）。

测试锚：`task-runtime/tests/unit/{orchestrate,gate,workspace,root-budget}.spec.ts`、`task/tests/unit/coordination.spec.ts`、`agent-singularity/tests/unit/task-tools.spec.ts`；集成 `tests/integration/a3-coordination-loop.spec.ts`（真实 DSH loop + scripted provider，6 项）、`a3-recovery.spec.ts`（真实 JSONL 重开 6 崩溃点 + 验证中断 3 例 + 取消竞态，13 项）、`a3-workspace.spec.ts`（跨根/replay/直调冲突与 replay 预算共享，5 项）、`coordination-tools.spec.ts`（4 项）。实跑命令与数量见建设计划「A3 执行与验收记录」。

未覆盖/边界（如实记录）：A4 问答工具与 waiting_answer 显示未建（挂载点字段已持久化、无消费者）；子任务按依赖串行，无并行工作窃取；进程崩溃时在途 active worker run 不恢复现场（cancelled+诊断，worker session 续跑属 S2-R）；工作区归属不防御共享文件系统上的外部 unmanaged 写入者（含多机共享 DSH_HOME 时 pid 探测失效）；pid 复用可把陈旧标记误判为活；replayLineage 为进程内 Map（重启后补验证的 replay 终态 review 不带 lineage tag）；根 run 终态后根 session 被闸置 terminal（迟到写入拒绝的合同结果；对用户续聊是行为变化，A0/A4 领域）；`waitRunSettled` 的 2s 尾部窗口等的是同进程结算簿记（非写进程停止），超时仅 notify 并照常采纳，该分支无测试；token/工具费用只有终态软统计；真实模型质量实验为票后工作。

### 5.10 契约审核与恢复（2026-09-23 T2+T3，已验收）

范围（建设计划文首表第 5 行完成闸：`off`/`all` 策略、审核持久化、批准后重检与崩溃恢复一起交付；模板库、契约修订入口、blocked 恢复属后续票，根契约入口已实现，A0 来源/恢复返工见 §5.11。整组已验收，实施细节与实跑记录见建设计划「T2+T3：契约审核与恢复 执行与验收记录」）：

- **策略与提案记录**：`Config.generatedTaskReview: off | all`（默认 `off`，闭合 schema；未知值构造期拒启，批次不能自带该字段）。每次分解先写成不可变提案 `TaskProposal`（`task/src/proposal.ts`）：`proposalId` 由内容派生（`p-` + `decompositionDigest(identity)`，重试不产生第二个身份）、`requestKey`（缺省由父任务/父 run/调用会话/批次摘要派生）、完整规范化批内容（每个子契约、`dependsOn`、`decomposable`、`requiresIndependentAcceptance`）、出生策略、`admissionContext` 与 `admissionContextDigest`、`reviewContext` 与 `reviewContextDigest`。`off` 出生即 `ready` 并记 `policy-off`（不伪记批准）；`all` 出生 `pending_review`。状态表（`ready/pending_review/approved/rejected/cancelled/stale/admitted/expired`）由 reducer 逐边校验：`approved` 必须先落 `approved → ready` 才可准入，等待中的提案不因策略改回 `off` 释放，一次消费只产生一个批次。
- **服务入口与闸**：`submitDecompositionProposal` 先跑纯预检（受保护输入固定、唯一规范化、结构/能力缺口/provider/verifierRef）——坏批次按名字拒绝、零副作用、**不弹审批**；同一 key+同一内容答原提案（`existing: true`，等待中的再问一次审核），同 key 不同内容具名拒绝。`continueProposal` 是唯一把提案变成任务的入口：重检父任务状态、父 Run 是否仍在 active、限额指纹、能力解析指纹与批次内容，任何一处移动即 `stale` 并点名差异，父 Run 结束即 `expired`，全部通过才在一次 `admitBatchIn` 里同时落子任务、依赖边、父相位与提案消费。`decomposeAndRun` 是这两步的组合，直接调用（不经工具）受同一闸约束。
- **决定与绑定**：`decideProposal` 是唯一决定入口（工具层没有任何决定参数或 approvalRef）。决定携带 `proposalDigest` + `admissionContextDigest` +（批准必须）`reviewContextDigest`，reducer 与存储记录逐项比对，篡改摘要被拒；迟到批准（父 Run 已结束/离开决定相位）写 `expired` 而不是批准；`cancelProposal` 只允许提交会话撤回。决定由渠道写 `decidedBy`（`approval:<ownerSessionId>`），模型无法自行生成可信凭据。
- **审核渠道**：`agent-singularity/src/proposal-review.ts` 的 `ProposalReviewService` 在 service 装配处挂 `ctx.proposalReviewChannel`（不在任何 agent 工具面），按 store id 解析 owner 会话，经既有 `ctx.approval.request` 提问；渲染按 §5 展示父目标/AC、每个子任务的目标/判据/假设/约束/依赖/声明能力与当前解析、限额（区分强制与审计）、父上未满足义务、判据的确定性与 heuristic 标注、提案 id、批次摘要与两个上下文指纹，并显式写明"名称不是字节、verifier 只有 id"的边界。请求非阻塞（不 await 人），答复过后记录决定；渠道不可用/被撤回/无回答者只保持 `pending_review` 并说明原因，绝不转批准。
- **工具面**：`task_decompose` 组合「提交 + 续跑」，`all` 下返回 proposalId 与诊断（零子任务、零 spawn、父未分解）；新增 `task_proposal_read`（读已存记录与诊断）、`task_proposal_continue`（重检并准入）、`task_proposal_cancel`（撤回自己的批次）。三者进 root allow-list 与 worker baseline（它们是提出批次的那个节点的任务域动作，不是平台管理）；渠道本身不在任何工具面，worker 没有任何工具可以决定提案。闸把 read/cancel 归入协调放行表，`task_proposal_continue` 是写（`waiting_children` 下等同再分解，拒绝）。
- **幂等与恢复**：同一请求（同 key 同内容）在进程内与重启后都不产生第二个提案/子任务/run；`reconcileStore` 的提案遍（在 run 遍与工作区接管之后）对 `pending_review` 只**重发**审核请求（材料取自store 里保存的批次），对 `ready`/`approved` 续跑重检；进程内按 store+父串行，两个获批提案竞争同一父只有一批准入，落败方具名 `stale`/`expired`；准入提交与 spawn 之间崩溃由 A3 的批次恢复驱动**同一批**（consumption 里的子任务 ids），在途 run 只结算不重跑。
- **known wait**：`openProposalOf`（`task-runtime/src/proposal.ts`）让"自己的批次正在等审核"的 run 不被无进展规则计数或停止（`orchestrate.ts` 的等待分支），等待仍受该 run 自己的期限与批次 abort 约束——审核不暂停执行时钟。

源码锚：`task/src/proposal.ts`、`task/src/service/state.ts`（`submitProposal`/`decideProposal`/`changeProposalPhase`/`admitProposal`）、`task/src/types.ts`（四个 `TaskProposal*` 事件与 `TaskSnapshot.proposals`）、`task-runtime/src/proposal.ts`、`task-runtime/src/index.ts`（`submitDecompositionProposal`/`continueProposal`/`decideProposal`/`cancelProposal`/`reconcileProposals`/`admitPrecheckedBatch`/`Config.generatedTaskReview`）、`task-runtime/src/gate.ts`、`task-runtime/src/orchestrate.ts`（known wait 分支）、`agent-singularity/src/proposal-review.ts`、`agent-singularity/src/tools/{task-decompose,task-proposal-read,task-proposal-continue,task-proposal-cancel,proposal-parameters}.ts`、`agent-runtime/src/prompts/root.prompts.ts`、`task-runtime/src/handoff.ts`、`task-runtime/src/capability.ts:WORKER_BASELINE_TOOLS`。

测试锚：`task/tests/unit/proposal.spec.ts`（记录、reducer 与摘要固定向量）、`task-runtime/tests/unit/proposal-lifecycle.spec.ts`（策略/决定/重检/requestKey/恢复/known wait）、`agent-singularity/tests/unit/proposal-review.spec.ts`（渲染与渠道）、`agent-singularity/tests/unit/task-proposal-tools.spec.ts`（三个工具）、`tests/integration/proposal-review.spec.ts`（真实 DSH loop + scripted provider，15 项：`off` 记录、`all` 零点、非法输入不弹审批、拒绝/取消/无回答者、模型协议 fixture、直接服务调用、篡改摘要、迟到批准、能力解析变化、worker 工具面、闸分类、known wait、replay 不入审）、`tests/integration/proposal-recovery.spec.ts`（真实 JSONL 重开，12 项：四个崩溃点、off→all 补审、all→off 不释放、限额变化、同请求幂等、兄弟不重跑、两提案竞争）。

未覆盖/边界（如实记录）：审核上下文的内容身份只到「本批解析到的 manifest + provider 侧车内容摘要 + 判据 pin 的 verifier id」——无侧车的 guidance skill 记 `contractDigest: null`，verifier 不记版本/配置（注册表只给 id 词表），所以"同一 id 换了行为"不会让已审提案失效，渲染文本与 `reviewContextOf` 的 docblock 都如实写明；`SKILL.md` 的字节身份属 S1-C 的 run binding，在 spawn 时固定，晚于批准，因此审核覆盖的是名称解析而非字节；恢复重发审核请求在 owner 会话不可问（无 live agent、审批策略 `never`、store id 不合法）时只保持 `pending_review` 并给出原因，渠道返回 `requested: true` 只表示"已把问题交给回答者"（不表示已读、已回答）；单进程串行 + store 自身拒绝保护并发，多进程同时写同一 store 与"工具外部副作用恰好一次"不在范围；replay 不进审核（`replayTask` 不建提案、不请求审核），根入口（A0）当时未建——已由 §5.11 交付，根契约走同一套记录、审核与恢复，未复制第二套生命周期；等待期不暂停 wallTime/根期限，等太久由既有期限结束 run，迟到批准只令提案失效；模型协议 fixture 只证明接线与状态，真实模型的修订质量属票后实验。

### 5.11 根入口与默认运行面（2026-09-23，A0 返工 / R0 证据保留）

范围：根 intake、setup/激活分离、独立 AC、同套审核/恢复和默认运行面收敛。实现已提交，原复核记于 `2e3175a`。本节余下内容描述**当时**的验收事实与当时的缺口；来源归属（Q2）与 adoptRoot 恢复（Q3）两个缺口已由本文 §5.13 的返工关闭，其余验收项沿用。模板库、契约修订入口、A1/A2/A4 仍不在范围。

当时缺口（已被 §5.13 关闭，保留为历史）：intake 服务只信任传入的 store/session，没有验证具体用户请求及澄清来源；工具层的 root 判断不能覆盖直调。adoptRoot 对「有已批准提案、尚无根任务」提前返回，未经过恢复遍。修复需覆盖这些入口及拒绝反例，不增加需求库、语义分类器或通用恢复平台。

- **setup 与激活分离**：`graphs/src/index.ts:create` 只创建 graph + root session，随后调用 `taskRuntime.adoptRoot`（打开 store、收养已有根、重建工作区归属），不再创建根任务；新 graph 的 store 里没有任务（`adopted: false`），`createRootTask` 已删除——没有绕过审核的建根入口。根 store（`sg-t-<rootSessionId>`）在 intake 时按需创建。
- **根 intake 与独立判据**：`intakeRootContract`（submit + continue 的组合）是工具与直接服务调用共用的唯一入口；契约级规则复用 `normalizeDecomposition` 与 `contractDefects`，新增 `admission.ts:rootIndependenceDefects`——至少一条 mandatory 判据 `verificationMode !== 'composite'`，缺则具名拒绝、零副作用（缺提案、缺任务、缺 run、缺 spawn、不弹审批）；`protectedInputs` 对根 session 的 checkout 固定（复用 S1-V 切片 2）。
- **审核同闸**：根契约与批次共用同一开关（`Config.generatedTaskReview`）、同一四个事件、同一决定绑定（三个摘要）、同一 requestKey 幂等、同一 `reconcileStore` 提案遍与同一 `ProposalReviewService` 渠道（`ROOT_REVIEW_TOOL_NAME = 'task_intake'`，渲染为「Root contract review」卡）。`off` 出生即 `ready`、记 `policy-off` 并在同一调用内激活；`all` 出生 `pending_review`，批准前零根任务/零派发/零唤醒，草案被拒绝零派发、可修订重提（新内容新提案 + `supersedes`）。
- **激活与幂等**：一次原子提交（`task/src/index.ts:admitRootProposalIn`）落根任务 + 根 run（出生 `active`，`sessionId = rootSessionId`）+ 消费记录（命名铸出的 taskId/runId），随后进程内绑定 session、闸置 `active`、声明工作区、绑定 provider、给 root session 发通知。同一接受事实重放（重复 intake、重复 `continueProposal`、恢复遍）从消费记录作答，不产生第二个根任务/run。
- **不冒充**：契约接受前 `task_read`/`task_status` 对根 session 返回具名「尚未激活」视图（`agent-singularity/src/tools/root-store.ts`），含开放提案的 id/状态/策略与「用 `task_intake` 接受目标」的动作说明；任何 objective 位置都不出现 graph name（也不出现 graph id 之外的图标识），缺契约是具名状态而不是崩溃或代用目标。
- **旧图不改历史 / 终态不复活**：旧 store 的根任务（objective=graph name、仅 composite 判据）按历史读取、验收、完成；其上的 intake 具名拒绝（store 已有根任务）。根 run 终态后根 session 被闸置 `terminal`（A3 行为），迟到 intake 被闸（`phase "terminal"`，`task_intake` 是写动作、不在协调放行表）与状态双重拒绝，不在已终态根 run 上复活执行。
- **worker 工具面不扩张**：`task_intake` 只进 `ROOT_TOOLS`（并由装配常驻注册），worker baseline 不变、无任何决定类工具；`tests/integration/root-intake.spec.ts` 从真实 `ToolRuntime` 读回 worker 的工具名集合断言这一点。
- **R0 默认运行面收敛**：装配开关 `evolution: 'off' | 'on'`（默认 `off`，闭合 schema；未知值或未读成员构造期拒启）。两种 composition 的实际工具集：**off** — `agent-singularity` 只注册 19 个常驻工具（含 `task_intake`、`escalate`，`skill` 由 preset 平面挂载、不在常驻注册面），九个 `evolution_*` 不注册，root allow-list 20 名（19 个 root 核心名 + `escalate`），根 prompt 无进化协议段；**on** — 注册 28 名（19 + 9），root allow-list 29 名，与 R0 之前逐名相同。allow-list 与 prompt 由同一布尔派生（`agent-runtime/src/index.ts:rootToolsFor` 消费 `ctx.singularityEvolution`，软读，缺失即 off），二者不可能互相矛盾；关闭只撤注册，不删账本、不降授权校验。Buckyball（BB）句子从通用 root prompt 无条件移除，领域指导归部署的领域 skill（`bb-pipeline`），不再内嵌进角色文本。不新增主管角色、不合并审批：提案决定仍只有审核渠道这一条写入路径（`decideProposal`）。

源码锚：`task/src/proposal.ts`（`kind` 联合、`RootProposalIdentity`、`rootProposalDigest`/`rootProposalId`、`ROOT_PROPOSAL_TASK_ID`、`TaskProposalRootConsumption`）、`task/src/service/state.ts`（按 kind 分支的身份/消费断言与一次性建根闸）、`task/src/index.ts:admitRootProposalIn`、`task-runtime/src/admission.ts:rootIndependenceDefects`、`task-runtime/src/index.ts`（`intakeRootContract`、`submitRootContractProposal`、`continueRootProposalIn`、`activateRootContract`、`adoptRoot`、`reconcileRootProposal`/`rebindActivatedRoot`、`serializeRootIntake`）、`agent-singularity/src/index.ts`（常驻注册与 `EvolutionExposure`）、`agent-singularity/src/proposal-review.ts`（`ROOT_REVIEW_TOOL_NAME`、`renderRootReview`）、`agent-singularity/src/tools/{task-intake,root-store,task-read,task-status}.ts`、`agent-runtime/src/index.ts`（`ROOT_CORE_TOOLS`/`rootToolsFor`）、`agent-runtime/src/prompts/root.prompts.ts`、`graphs/src/index.ts:create`、`graphs/src/prompts/setup.prompts.ts`。

测试锚：单测 `task/tests/unit/proposal.spec.ts`（根变体：固定向量、reducer 拒绝表、消费绑定、旧记录读取）、`task-runtime/tests/unit/{proposal-lifecycle,orchestrate,protected-inputs}.spec.ts`（根 intake 策略/重检/幂等、`adoptRoot` 重入、独立判据规则、受保护输入）、`agent-singularity/tests/unit/{assembly,proposal-review,task-tools,task-proposal-tools}.spec.ts`（两种 composition 的工具集与拒启、根审核渲染、工具面与未激活视图）、`agent-runtime/tests/unit/agent-runtime.spec.ts`（两条 allow-list 与 prompt 同源）。集成 `tests/integration/graphs-lifecycle.spec.ts`（`graphs.create` 调 `adoptRoot` 且不建根任务）、`tests/integration/root-intake.spec.ts`（真实 DSH loop + scripted provider，11 项：来源可追溯、缺独立判据零副作用、子全通过但根判据失败、真实产物与受保护脚本改写、off/all 与直接服务调用同闸、拒绝草案与修订、终态不复活、worker 工具面）、`tests/integration/root-intake-recovery.spec.ts`（真实 JSONL 重开，7 项：待审重开重发审核、批准已存未激活补激活、已提交未绑定重绑定、激活幂等、旧图不改历史、off→all 补审、all→off 不释放）、`tests/integration/proposal-review.spec.ts`（批次审核 15 项，期望已按「根契约也有自己的审核」迁移：批次 ask 用 `review.batchAsks` 读）、`tests/integration/{worker-grant,evolution-tools,worker-binding,worker-contract,worker-mcp,run-skill-loading}.spec.ts`（R0：off 默认 composition 的正例、on 的回归、根面名单含 `task_intake` 且 worker 面不含它）。实跑命令与数量见建设计划「A0 + R0 执行与验收记录」。

未覆盖/边界（如实记录）：

- **根提案审核上下文指纹边界同 §5.10**：`reviewContextOf` 只覆盖本契约解析到的 manifest 名称与判据 pin 的 verifier id，不覆盖 provider 字节与 verifier 版本；「同一 id 换了行为」不会让已审的根提案失效。
- **`task_intake` schema 不声明 `childEvidence`**：根契约在任何批次存在之前提交，映射按批次位置（0 基）指向子判据的 id，此刻没有任何批次位置可指；schema 因此拒收该键，而不是接收一个 runtime 永远无法判定的映射。子契约（`task_decompose`）仍可用它。
- **legacy fixture 的用途边界**：`tests/support/legacy-root.ts:seedLegacyRoot` 只用于测试历史形态（objective=graph name、仅 composite 判据）的读取/验收/完成与「其上 intake 具名拒绝」。它经 store 自己的写入入口种状态、明确标注「测试夹具，不是生产路径」，`src/` 不引用它，也不提供任何建新根的捷径——新根一律走真实 intake。
- **工作区冲突时提案先落库的顺序选择**：`submitRootContractProposal` 先落提案，激活才 claim checkout。冲突（`WorkspaceBusyError`，点名持有者 store/task/run 与起始时间）使激活整段拒绝、零根任务零 run，但提案留在记录上（`ready`）——记录的是「谁问过」，效果另算；持有者释放后同一提案可由 `continueProposal` 续跑，不必重提。实测：第二根 intake 返回拒绝文本时该 store 已有 1 条 `TaskProposalSubmitted`、0 task、0 run。
- **跨进程并发只依赖 store 自身拒绝**：进程内按 store 串行（`serializeRootIntake`），第二个进程的并发激活由 reducer 的一次性建根闸拒绝（store 已有根即拒），不引入跨进程锁，也不承诺「工具外部副作用恰好一次」。
- **崩溃点「激活已提交未绑定」的重绑定门是 `adoptRoot`**：`reconcileStore` 的提案遍只处理 `ready`/`pending_review`/`approved`（`isOpenProposal` 不含 `admitted`），其 `rebindActivatedRoot` 分支在一次恢复激活之后冗余执行；进程死亡后的重绑定由 graph 入口 `adoptRoot` 承担（绑定 + 相位派生），补通知只在 `rebindActivatedRoot` 内（通知是须知，不是唤醒义务）。
- **根 intake 缺独立判据是结构规则**：它判定判据种类，不判定命令是否恒真或目标解读是否正确；语义澄清由 R1 场景验证，来源存在与归属由 A0 机械校验，两者不能互相替代。
- **未激活前的提案读取/续跑（本组交付内已修复，复核 A6 端到端证实）**：根 session 在契约激活前没有绑定 run，`task_proposal_read`/`task_proposal_continue` 原先以 `no task run is bound to session` 失败；现对该具名状态回退解析本 session 自有的根 store（`agent-singularity/src/tools/root-store.ts:proposalStoreFor`），其他错误原样抛出，服务层 owner/调用者校验不变；测试锚 `agent-singularity/tests/unit/task-proposal-tools.spec.ts`。剩余边界：`task_proposal_cancel` 仍是 run 解析（该状态下没有提示文本指向它，需要时按同一修法开放）；回退触发依赖该具名错误文案，runtime 提供结构化判别时可再收敛。
- **根预算零改动**：接受前无根任务，`resolveRootBudget` 走既有具名恢复诊断；`run.startedAt` 即接受时点，A3 记账语义不变。A3 等待窗口本轮未调整（无因窗口失配的失败）。

### 5.12 按证据整理运行时（2026-09-23 R2，取消写闸返工）

原交付与复核已提交在 `d5b0bb6`：`gatePhaseFromStore` 修复了恢复绑定，却在取消尚未持久化时把 terminal 回写为 active。**该缺陷（复核 Q1）已关闭**：2026-09-24 进度审核先证实「跨取消完成点的延迟查询」仍会重开闸（首轮修复只覆盖窗口内的读取），补充返工把它并入同一守卫体系后交付 `8f9086e`；两轮返工记录与实跑数量见建设计划「R2 Q1 返工执行与验收记录」与其后的「R2 Q1 补充返工执行与验收记录」。以下先记关闭与证据，再保留原实现事实（原复核已成立的部分本轮未改，不能据此宣称 R2 之外的工作已完成）。

- **Q1 关闭（两条轨迹：窗口内的读取、跨完成点的陈旧读取）**：`cancelGraph` 的顺序本身是承诺——先关闸（每个绑定 session 置 terminal），再 abort/等待 driver，最后才把取消落盘（`settleRunFromRuntime` → `markRunStatusIn`），所以窗口内 store 仍写 `running`/`active`，而闸已生效。两个守卫各覆盖一条轨迹，缺一不可：(a) **窗口内的读取**——运行时记「本进程正在关闭的 store」集合（`closingStores`：在 gate 循环前建立、`finally` 清除），`gatePhaseFromStore` 在 store 关闭期间不移动**已持有相位**的 session；取消没触及的 session（无相位）仍照旧取 store 相位。(b) **跨完成点的读取**——闸自己数做过的相位决定（`ExecutionGate.decisions`：`setPhase`/`setTerminal` 即本进程的决定），查询在**读取前**取 `decisionToken`、store 派生相位经 `applyStorePhase(…, token)` 应用，期间只要有决定落地（取消、结算、准入、spawn 续跑），该值就比闸旧、被丢弃。取消的决定先于它的落盘，所以窗口内读取取到的 token 是**新**的，只有 (a) 能拦；`finally` 清掉集合后旧值才到达，只有 (b) 能拦。没有第二份相位、没有给全部状态排单调等级、没有新锁/调度器/事件体系。
- **C1 反例（真实回填路径 + 真实工具管线，两例）**：`tests/integration/cancellation-gate.spec.ts`。(1) **窗口内**：call-through spy 暂停真实 `cancelGraph` 的**落盘**（暂停点只控制等待处，store 实现照跑），先断言窗口两侧事实（gate=`terminal`，store 仍 `running`/`active`），再由根 session 的真实 turn 依次发起 `graph_spawn`（读前）拒绝、`task_proposal_read`（经 `proposalStoreFor`→`runForSession`→`lookupRun`）成功且 gate 仍 `terminal`、`graph_spawn`（读后）拒绝，释放屏障后取消落地。(2) **跨完成点**：call-through spy 只扣住真实 `task.runIn` 的**返回**（store 已读回旧对象，测试另断言该 park 是本查询的读取、查询当时仍未作答），真实 `task_proposal_read` 因此停在读取中；真实 `cancelGraph` **完整跑完**并从 store 读回 run=`cancelled`、gate=`terminal` 后释放，断言 gate 仍 `terminal`（丢弃而非应用）、该查询仍读取成功、随后经真实管线发起的 `graph_spawn` 被 `phase "terminal"` 拒绝。两例都断言 stand-in 工具体零执行（只证明工具体未被触达，不证明真实文件写入）、无在途写，并先在合法 `active` 相位放行同一个写工具（C3 见证）。**未修复实现上该契约两处都红**：窗口内例 `expected 'active' to be 'terminal'`；跨完成点例在首轮修复后仍红（正是审核的复现），红/绿记录见计划两节返工记录。
- **C2 正例（恢复不因修复退化）**：`tests/integration/a3-recovery.spec.ts` 新用例——第二次启动（真实 JSONL）后经 `runForSession` 绑定，`waiting_children` 父 session 与终态子 session 经真实 `ctx.tools.execute` 均拒写（stand-in 体按次断言未执行），协调读（`task_read`）仍可用且读后相位不变；原「重绑定 gate 相位」用例未改、仍绿。
- **C4 相关窗口（调用顺序依据，不枚举假想并发）**：逐点核对 `setPhase`/`setTerminal` 与相邻 store 写入——`admitBatch`（`admitBatchIn` → setPhase `waiting_children`）、根激活（`admitRootProposalIn` → `active`）、`submitResult` 与批次代父提交（`changeRunPhaseIn` → `submitted`）、`onRunSettled`（结算写 → `terminal`）、`adoptRoot`/`rebindActivatedRoot`（读回 snapshot 派生）、worker/replay 启动（`startRunIn` → `active`）**全部先落盘、后移闸**；只有 `cancelGraph` 是「先关闸、后落盘」，因此只有它存在该窗口，未为其他入口添加假想反例。补充返工另核对了「store 派生相位在决定之后应用」这一族：查询路径的两处应用已并入 `applyStorePhase`（token 判有效性），`adoptRoot`/`rebindActivatedRoot` 两条绑定门仍是裸写（见边界 2），spawn 续跑写的是「本进程刚起了一个 run」的决定而非 store 读取（见边界 1）；三者都未被本票宣称已安全。

以下保留原实现事实（原复核已成立，本轮未改）：

- **职责/调用方映射**（准入 / 运行推进 / 工作区归属三块四问表：事实在哪、谁持久化、谁是消费者、哪些是内存投影）：完整表见建设计划「R2：按证据整理运行时 执行与验收记录」A 节。结论要点：准入链（受保护输入固定 → 规范化 → 结构/能力准入 → 提案记录 → 原子准入提交）全部从 store 或调用方输入判定，普通/replay/root 共用一套规则；推进侧 store 是事件真相，内存只有 handle（sessions 指针缓存、drivers 在飞表、executionGate 相位、per-batch AbortController）；工作区归属进程内栈是权威、marker 只给后来的进程。
- **关闭的实际缺陷 1（marker 顺序）**：全栈并发 release 时最后一次 rename 可落在最后一次 delete 之后，留下命名本进程活 pid 的残留 marker，栈空但工作区在进程退出前不可 claim/reconcileAdopt（先红 5/5）。修复=`workspace.ts` 按 workspace 的 marker 变更串行链（调用序=落盘序），协议语义不变；回归 6/6 + 全量。部署路径上释放本由调用方串行，修复是把模块自身承诺升级为与栈一致。
- **关闭的实际缺陷 2（gate 相位重绑定）**：`lookupRun` 重绑定门（`runForSession`，全部任务工具的入口）不还原 gate 相位——进程重启后恢复的 waiting_children 父 session 对写/bash/再分解/提交不设防（真实 JSONL 重开 + park 在父 drain，先红）。修复=两条重绑定路径都从 store 的 run 记录派生相位（与 `adoptRoot` 同规则，`rootSessionPhase` 泛化为 `runGatePhase`），未建第二份相位。
- **观察项判定（A0+R0 O1）**：根身份=首个 parentless 任务、replay 也造 parentless——判定无真实故障路径（replay 的 champion 要求同 store 已有终态任务，A0 store 里根必在 replay 前；预算 owner 按 session 绑定解析并有多绑定具名拒绝），保留并说明。
- **公共面收敛**：`evidenceByVerifier` 无生产/审计消费者 → 撤回方法与 3 个测试（KISS §8.2 召回不建）；`templateDigest` 无消费者依赖执行身份 → 类型文档标明仅诊断、无身份保证；`TaskProposalKind`/`TaskProposalDecision`/`TASK_PROPOSAL_ID_PREFIX` 无文件外消费者 → 收回导出（结构可读性不变）。
- **保留项（有理由）**：drivers 推状态模型、`replayLineage` 进程内 Map、`serializeParent` 互斥、T2/T3 提案生命周期、A3 的 workspace/取消/恢复规则全部按调用方证据保留，未動；跨进程 marker 无 CAS、双 claim 同 tick 窗口、共享文件系统外部写入者均为既有边界，本轮未改也未宣称。

源码锚：`task-runtime/src/gate.ts`（本轮新增 `decisions` 计数与 `decisionToken`/`applyStorePhase`；`setPhase`/`setTerminal` 为决定写入）、`task-runtime/src/index.ts`（`closingStores` 字段、`cancelGraph` 的建立/清除、`gatePhaseFromStore(sessionId, run, storeId, token)` 的守卫与 `applyStorePhase` 应用、`lookupRun` 两处取 token；原有 `runGatePhase`/`lookupRun`）、`task-runtime/src/workspace.ts`（`queueMarkerMutation` 与 claim/push/release/reconcileAdopt/close 入链）、`verifier/src/index.ts`（`evidenceByVerifier` 移除）、`task/src/proposal.ts`（三个导出收回）、`task/src/types.ts:RunMcpServerBinding`（诊断标注）。

测试锚：`tests/integration/cancellation-gate.spec.ts`（C1 两例 + C3，真实 loop/闸/工具管线；窗口内例暂停落盘，跨完成点例扣住真实读取的返回）、`task-runtime/tests/unit/gate.spec.ts`（`applyStorePhase` 组：当前 token 应用、陈旧 token 丢弃、决定使 token 前进）、`tests/integration/a3-recovery.spec.ts`（既有重绑定 gate 相位用例 + 上轮新增「第二次启动后 waiting_children/终态经真实管线拒写、协调读可用」）、`task-runtime/tests/unit/workspace.spec.ts`（并发 mutation 两例）、`verifier/tests/unit/verifier-registry.spec.ts` 与 `tests/integration/verifier-selftest-inputs.spec.ts`（撤回后回归）。

未覆盖/边界（如实记录）：两轮返工各由一名只读独立复核子代理实际执行复核。首轮确认缺陷关闭（窗口内轨迹）、恢复路径不受影响、C4 调用顺序审计成立、C1 非空洞；补充返工轮的复核确认**两条轨迹都关闭**（全部查询路径的 store 派生写入只经 `applyStorePhase`，两分支的 token 都取在被判定的读取之前），**两个守卫各自承重**（token 单独用会在窗口内例上失败：取消的决定先于落盘，窗口内读取取到的是新 token；`closingStores` 单独用会在跨完成点例上失败：集合已清），**未发现回归**（`decisions` 只被 `decisionToken`/`applyStorePhase` 读取，`decide`/`phaseOf`/`inFlightWrites`/`drainSession`/`waitRunSettled`/`unload` 观察到的相位表形状不变），并逐点检查了「丢弃 store 值是否会丢合法迁移」：本进程的相位决定都发生在自己的落盘之后、run 相位轴在 store 内单调（active→waiting_children→submitted），唯二「先于落盘的决定」正是 `cancelGraph` 与 `unload`（丢弃旧值就是目的），重开恢复（token=0）、reconcile 重启、`onRunSettled`、同 session 第二个 run、旧无相位记录都不受影响；当一个**本身陈旧的宽松决定**（边界 1/2 的路径）在先时，矫正会被推迟到下一次读取而不会丢失，符合「不永久锁死」。另记四项**未关闭的既有边界**——超出本票「只修查询回填」的授权，未修，如实上报：(1) 子批次 driver 的 spawn 续跑（`orchestrate.ts` 两处：先 `startRunIn` 落子 run，再在 `env.spawn` 之后无条件 `setPhase(session,'active')`）若被取消插在中间，会把取消刚置的 `terminal` 改回 `active`；若取消的结算同时抢先，`settleChildRun` 的提前返回不再 `onRunSettled`，该 session 可能停在 active 而 run 已 cancelled。它是「本进程刚起了一个 run」的决定而非 store 读取，token 既不能拦也不该拦；复核确认机制存在，但未证实前提「`env.spawn` 可在批次 signal abort 后返回」（DSH 的 signal 语义是创建期生效），未建探针；(2) `adoptRoot`（`index.ts:1675-1679`）与 `rebindActivatedRoot`（`:4097-4106`）是两条**裸写**的 store 派生相位门：形状与已修缺陷完全相同（读回相位后在决定之后应用），但复核只由调用图给出「未证明可达」（`adoptRoot` 的生产调用方 `graphs.create` 另铸 root session、且与 `graphs.remove` 同由 graphs 的 `transition` 串行；`rebindActivatedRoot` 需要已关闭的根 session 与一个未消费的根提案同时在场），按「无可达证据不扩张」保留原样、**未关闭也不声称安全**；(3) `closingStores` 是集合而非重入计数，同一 store 的两次并发 `cancelGraph` 会在先完成者处删条目（`graphs.remove`/`create` 由 graphs 自身 `transition` 串行，直调服务属调用方竞争，未覆盖）；(4) `unload` 的 terminal 同样没有 store 记录，但其 pre-execute 钩子随 `[Service.init]` 的 effect 先撤除，只读复核按 disposables 顺序论证，未实测。未跑真实模型/BB/部署；marker 的跨进程边界保持，A2 草案待前置；召回重建与否由未来消费者决定。

### 5.13 根契约来源归属与恢复入口（2026-09-23 A0 返工 Q2/Q3）

范围：只返工第 6 项 A0 的两个关闭条件（计划的「补救交付复核」Q2/Q3）——根契约的**来源归属**与 `adoptRoot` 的**恢复入口**。R0 工具面收敛、A0 其余验收项、T1–T3/A3 交付全部保留，未重做；不新建权限平台、语义分类器或第二套恢复机制。返工在 `de85ae0` 的基础上完成，交付保存为 `cce3157` / 外层 `2c299b7`，本轮进度审核通过；验收与实跑记录见建设计划「A0 返工（Q2/Q3）执行与验收记录」。

- **统一入口的来源与归属判定（Q2）**：`task-runtime/src/index.ts:assertRootContractOrigin(storeId, rootSessionId)`，由三个可能让根契约生效/被询问的入口共用——`submitRootProposalOnce`（开 store 之前）、`continueRootProposalIn`（激活阶梯首次写入之前）、`reconcileRootProposal`（恢复提案遍，重发审核之前）。三条机械规则：(a) `storeId` 必须等于 `rootTaskStoreId(rootSessionId)`；(b) 会话必须是**顶层会话**（头部 `origin === 'subagent'` 或 `delegationDepth > 0` 即委派子会话，拒绝）；(c) 会话自身持久日志中必须有至少一条 `user/message` 且 `source.kind === 'user'`（DSH 的宿主证实人类输入标记，见 `thirdparty` 的 `tool-goal/src/authority.ts:hasDirectHumanInput` 与「省略 source 的 followup/steer 解析为 user」规则）。会话日志经 `sessionPersistence` 只读打开（`rootSessionLog`）读取；无 reader、会话缺失、打开/读取失败均**具名拒绝**（fail-closed：读不到 ≠ 假设有）。全部拒绝发生在该入口首次写入之前：被拒的 intake 不创建 store、不落提案、不建任务/run、不 spawn、不弹审批、不唤醒。
- **生产者归因（同一缺陷的写侧）**：`agent-runtime/src/index.ts` 的 `spawn`（父节点委派任务）与 `prompt`（`graphs.create` 的 setup 文本）原先把提示词写成 `source.kind === 'user'`，等于让部署自己的声音占用人格输入标记——新图 root session 仅凭 setup 提示词即可通过来源闸（复核 D1），委派子会话也能（D2）。现改为本运行时自有来源 `RuntimePromptSource`（合并扩展 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap`：`{ kind: 'runtime-prompt', channel: 'spawn' | 'prompt' }`，无 `form`），消息内容、顺序、驱动回合与持久化行为不变；`notify` 保持 `plugin`。工具描述与规则文本同步改准（本人消息 = `source.kind === 'user'`）。
- **`adoptRoot` 的恢复入口（Q3）**：无根任务时不再提前返回，而是先跑既有 `reconcileStore`（运行遍 + 工作区 + 提案遍）再读回：`ready`/`approved` 由既有续跑阶梯激活并绑定（崩溃点「批准已存未激活」由该公共入口自动恢复），`pending_review` 重发审核请求，仍未产生根则返回 `{ adopted: false }` 并在 `detail` 写明「本次恢复遍未创建任务/run/提案」与仍未关闭的提案 id/状态（`nothingAdoptedDetail`）。空 store 零写入、已激活幂等（同 ids、一条消费）、旧图逐字节不变。`RootAdoption` 类型与 `RootIntakeResult` 未改，无新增事件、持久化字段或导出。
- **测试纪律**：恢复夹具的 `reopen` 改为只经 `adoptRoot`，`openStore` + `reconcileStore` 的显式调用在该 spec 中不再存在；请求来源在夹具里以本人消息（`source.kind === 'user'`）落盘建模（`tests/support/scripted-loop.ts:recordRequest`、`tests/support/run-stack.ts`、`task-runtime/tests/support/person-request.ts`），不把部署自己的提示词当请求。

源码锚：`task-runtime/src/index.ts`（`assertRootContractOrigin`、`rootSessionLog`、`originRefusal`、`submitRootProposalOnce`、`continueRootProposalIn`、`reconcileRootProposal`、`adoptRoot`、`nothingAdoptedDetail`）、`agent-runtime/src/types.ts`（`RuntimePromptSource` + `MessageSourceMap` 合并）、`agent-runtime/src/index.ts`（`runtimePrompt`、`spawn`、`prompt`）、`agent-singularity/src/tools/task-intake.ts`（描述里的来源规则）、`tests/support/{scripted-loop,run-stack}.ts`、`task-runtime/tests/support/person-request.ts`。

测试锚：单测 `task-runtime/tests/unit/proposal-lifecycle.spec.ts`（来源规则组：跨归属 store、无本人消息/仅通知、不可读/无 reader、已存跨归属提案不能被续跑或询问；`adoptRoot` 重入与空 store）、`agent-runtime/tests/unit/agent-runtime.spec.ts`（`spawn`/`prompt` 两条门都带 `runtime-prompt`）、`task-runtime/tests/unit/{orchestrate,protected-inputs,carried-precheck,review-record}.spec.ts`（harness 以本人消息建模）；集成 `tests/integration/root-intake.spec.ts`（工具与直调 × 合法/缺失/跨归属、setup 提示词驱动的会话被拒、委派子会话的 store 被拒、worker 工具面无 `task_intake`）、`tests/integration/root-intake-recovery.spec.ts`（只经 `adoptRoot` 的恢复：批准已存未激活、`pending_review` 重发、空 store 零写入、已激活幂等、旧图不变）、`tests/support` 消费者（`a3-*`、`proposal-*`、`worker-*`、`provider-*`、`graphs-lifecycle` 等）。实跑命令与数量见建设计划返工记录。

未覆盖/边界（如实记录）：(1) 来源闸的强度是**归因纪律**（谁写的消息）加**顶层会话**判定，不是来源真实性证明——宿主自身若以 `source.kind === 'user'` 伪造消息仍会被采信，DSH 把该标记定义为宿主证实的人类输入，机械检查无法进一步区分；(2) **澄清的两条通道**：人在会话里自己输入的请求/答复都是 `user` 消息（满足本规则）；经 `hitl_ask` 之类的工具通道返回的答复是工具结果（`userQuestions` 不写会话事件），**不**作为来源接受，`approval/asked`/`approval/decided` 是运行时记录的批准决定（审核渠道与自动答复者都会产生），也不当作「用户请求」——只有工具答复、没有本人消息的会话会被具名拒绝（fail-closed；正常流程里用户的原始目标本就是一条本人消息，R1 的语义场景若遇到该形态再复定）；(3) 服务层不校验「该顶层会话是某 graph 的 root session」（该规则仍在 `task_intake` 工具；直调属受信代码边界）；(4) 会话日志不可读时不能激活、也不能继续/重发等待中的根契约（fail-closed 的代价，部署需保证日志可用；复核 B5 实测）；(5) 每次 `adoptRoot` 都会重发等待中提案的审核请求（无决策则不激活、不外泄，噪声级）；(6) `decideProposal` 对来源不成立的历史记录仍写决定（记录级事实），其激活必被来源闸拒绝；(7) 本运行时的提示词来源词汇是新的可观测导出，只由 `spawn`/`prompt` 使用（持久化纪律见 `docs/persistence-changes/2026-09-23-runtime-prompt-source.md`：四根指纹未动，属传递类型变更）；(8) 语义解读与有效澄清仍未验证，属 R1。

## 6. 文档维护

- 文档分类见 [docs 入口](README.md)；负责进度的 agent 使用[进度审核与下一票派发 prompt](execution-prompts/progress-review-and-dispatch.md)，按代码和证据更新唯一表，不自动执行下一票。
- 子代理只接一个可独立验收的子目标，交接基线、改动、证据和剩余项；主代理负责集成和两个 guide，同一交付组未完整验收不得推进。具体约束见[公共派发粒度](execution-prompts/README.md#子代理派发粒度)。
- 每次派发同时执行 [公共合同中的质量 Prompt](execution-prompts/README.md)：检查规则实际消费位置、替换入口和跨层组合，保留先失败后通过的反例及合法正例；不能把合同缺陷改名为已知边界。指南中的完成状态必须与这些证据一致。
- 本文只维护方向和当前事实，建设计划只维护票据与验收；实施日志进入带日期记录。
- 每项完成状态必须写清范围、复核日期、源码/测试锚；区分声明、接线、自动测试、真实端到端运行。
- 同一改动同步更新本文的状态和建设计划。部分完成继续标“部分”，不可用“完成（核心未做）”。
- 新设计写成“建设目标/设计选择”；与 KISS 的差距保留为明确缺口，不以已有代码反过来宣称目标已达成。
- 历史材料只作来源，不与当前指南竞争规范地位。旧编号查询历史快照，新工作使用 S/G 编号。
