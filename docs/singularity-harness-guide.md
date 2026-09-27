# Singularity Harness 工作指南

当前进度（2026-09-27）：R1/R2/R3、A2+A1、A4、S4-E 的原范围验收记录保留。整体复盘确认四处架构问题，依次派 K1 → K2 → K3 → K4，再继续 A5 → A6。**K1 已验收**（[交付记录](history/2026-09-27-k1-delivery-record.md) + [返工记录](history/2026-09-27-k1-rework-record.md)，§5.18；2026-09-27 返工闭合交还顺序、批次成员事实与跨 graph/接管失败两条真实入口证据），[独立审核](history/2026-09-27-k1-review.md)已通过。**K2 已验收**（§5.19；[交付记录](history/2026-09-27-k2-delivery-record.md) + [独立审核](history/2026-09-27-k2-review.md)）。**K3 已验收**（§5.20；[交付记录](history/2026-09-27-k3-delivery-record.md) + [返工记录](history/2026-09-27-k3-rework-record.md)）：Skill 改进单位扩为完整对象——指导型仅 SKILL.md，执行型带 sidecar 时为 SKILL.md + SKILL.contract.json 两个固定文件（resources=[]）；候选 sidecar 由生产派生、只重算 `content.skillMdSha256`，不借内容更新提权；冻结/报告/晋升门/apply 复检比较同一完整身份；apply/rollback 经同一提交协议逐文件原子替换、记完成前做完整对象可加载复检；ledger 切换 formatVersion 4，实验报告 formatVersion 3。**K4 已交付，待验收**（§5.21；[交付记录](history/2026-09-27-k4-delivery-record.md)）：复盘与执行预算分离——终态/截止根可经 gate 窄入口调 `task_review_agent` 复盘（reviewer 只受自身每 store 额度与单次 watchdog 约束），唯一扩额工具 `task_budget_extend` 经 DSH 人审追加已配置维度的总上限，Task store 持久 `TaskBudgetExtended` 事实（store+requestKey 幂等、串行重检基线），有效限额由唯一解析器供准入/driver/watchdog/replay 全路径消费，旧用量不清零。A5/A6 未实施。状态以[唯一执行表](2026-09-20-vrtc-code-change-plan.md)为准。

| 已确认的问题 | 修正合同与唯一所有者 |
|---|---|
| ~~分解一次、子全终态即自动提交父，限制正常探索~~（K1 已验收） | [K1](execution-prompts/12a-k1-exploration.md)：runtime 交还父执行权，Run 内多批次、父主动提交；Task 保留事实（§5.18） |
| ~~生产写入先于应用账本，崩溃后无正常对账路径~~（K2 已验收） | [K2](execution-prompts/12b-k2-evolution-commit.md)：evolution 持久意图、原子替换、恢复与准入阻断（§5.19；同日返工补账本/来源持久化与真实进程退出证据；复审返工补同目标未结意图闸） |
| ~~执行型 Skill 带 sidecar，但候选只能改正文~~（K3 已验收） | [K3](execution-prompts/12c-k3-skill-unit.md)：evolution 按完整支持对象评估/应用，runtime 复用校验（§5.20） |
| ~~原根截止同时封死事后学习与下一次尝试~~（K4 已交付，待验收） | [K4](execution-prompts/12d-k4-review-budget.md)：reviewer 用自身额度/超时，runtime 支持经人审追加执行总上限，旧用量不重置（§5.21） |

A5 保持**失败自动、成功按需，共用诊断链**，待 K4 验收才派发。允许无需改进、证据不足、空建议；不做成功价值分类器。具体入口与 REV-1～REV-5 见[计划 F.3](2026-09-20-vrtc-code-change-plan.md)。正常任务内调整方法归 K1，修改共享能力才进入 Evolution；旧记录和下文落地事实不能作为保留已判错误规则的理由。

本文负责方向、职责与当前事实；[术语表](../CONTEXT.md)定义概念。[历史指南](history/2026-09-21-harness-guide-snapshot.md)保留旧编号和操作经验。深入实施参考：[Task 契约与可选人审](task-contract-construction-guide.md)、[有目标的探索/自进化架构](exploration-evolution-architecture.md)、[角色与 System Prompt 合同](agent-prompt-contracts.md)。[开源机制调研](2026-09-21-open-source-agent-patterns.md)记录一手来源。

设计依据为 `/home/ROXY/code/ref/docs/VRTC-最小架构-KISS版-v2.0.md`（正文 v2.1-KISS）与同目录 `细化想法4.md`。本文区分源码事实、建设目标和设计选择；文档中的设计不代表代码已经实现。

## 1. 方向与边界

构建由可验证契约约束、允许节点自主分解的任务运行时。图是执行拓扑，Task 是语义单位，TaskRun 是一次执行，Session 是会话载体；不能把节点结束等同于任务通过。

1. **Task 固定目标、约束、验收，不固定 workflow。** “固定”指接受契约后不随意改题，不指所有任务必须由人预先编写。父节点与子节点均可按规范生成任务，不要求命中模板；Harness 负责准入、依赖、资源授权和验收。依据：KISS §0、§3、§5。
2. **按验证边界拆任务。** 有独立输入、产物、验收且拆分有收益才拆；不要把每次 tool/skill 调用都变成节点。依据：KISS §4.1、§6、§12。
3. **Task 声明 capability，执行时选择 skill。** 运行前建立可行路径，运行中允许在授权范围内选择方法。依据：KISS §2、§3 I2、§11 第 3 条。
4. **通过由 verifier 与 evidence 决定。** 子全通过只是组合验收的一项输入，父目标还需要自己的判据。依据：KISS §6 C1–C4。
5. **缺口可见、升级有出口。** 缺能力时可规划和求助，不能把 `decomposable` 当成能力已具备，也不能靠无限分解消除缺口。依据：KISS §7。
6. **先可靠验收，再自动生长能力。** 复盘可提案，生产能力、验证标准与权限的变更走验证和既有授权边界。依据：KISS §8.1、§9、§12。

DSH 提供 agent/session、skill 发现与加载、preset、MCP、上下文与原生审批。Singularity 负责任务契约、能力选择、证据、组合验收、缺口恢复与复盘。继续使用现有服务，不另造通用 skill loader 或全局调度平台。

**当前阶段判断（2026-09-26）**：递归执行、证据、审核、恢复骨架和根契约入口已经接线；A0、R2、R1、R3 各按原有限合同验收。第 9 项已建立 `context` 包读取、装配和迁移路径并经 Q1–Q4 返工验收。第 11 项 A4 的非根 Session/Run 冷恢复、answer 补投及 replay 真实父子路径已有证据，收尾返工把恢复期唤醒（问答投递与 owner notice）移到屏障 ready 之后，见 §5.16 与[收尾记录](history/2026-09-26-a4-barrier-wake-record.md)。

R0 的默认工具面收敛、R2 的 marker 顺序及无用途 API 清理保留有效，不重做整套框架。R1 的 V6 历史更正保留：按现存记录至少 175461 输入/输出 token、58 次工具调用（含缓存至少 501349），首轮完整日志缺失，为下界而非精确全量；后续各轮尝试另计（补验证轮 入+出 51036 / 工具调用 17 / 缓存读 168704；完成轮 1 61435+19961 / 23 / 199936；完成轮 2 57421+21536 / 22 / 239872；完成轮 3 25051+7733 / 14 / 106752），各轮缓存写列一律为**未报告**——原始 `usage` 对象没有该字段，真报 0 才算 0。自主改进闭环仍未交付。

R1 的 [专项 prompt 与 V1–V6 验收指标](execution-prompts/07-r1-supplemental-validation.md) 已完成无模型返工与三个完成轮：判据修订为 `s3-criteria/2`（固定答复逐字比对与「每个必需 verifier 均 pass」都进入最终 verdict，两处漏验各有红/绿反例），三次生产修复（假设不得替代确认、缺失条件先问用户且不得由环境代答、契约只承载用户答复支持的内容且判据须可裁定）落在根 prompt / `task_intake` 说明。模型确实消费了澄清答复；一次通过只证明该固定场景，不推断普遍澄清能力。

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
- **新增概念要有当前用途。** 模块、导出、字段和状态说明实际消费者及删除后会失败的行为；审计/恢复也是用途。优先复用已有记录和 DSH 接口，不为未使用 API 再造消费系统。S4-E 的 Evolution ledger 只读写单一新格式，旧格式在写前抛错；切换前归档实际旧账，不建兼容或迁移层。
- **重构依据重复职责和实际失败。** 正常执行、replay、恢复共用关键迁移规则；内存管理活跃 handle，持久记录保存恢复事实。先收敛准入、运行推进、工作区归属的职责，不预定 pull 化、通用 effect 框架或分布式锁平台。
- **实现自由不等于架构重新选型。** 后续合同已在计划 D/E/F 固定接口、归属、恢复和验收；私有模块组织与等价实现自主决定。新证据确与合同冲突时在唯一计划修订，不能自行更改权限、候选支持范围或把缺陷改名为增强，也不照历史字段全集施工。

### 1.4 包职责与 Agent 状态上下文（2026-09-24，取代上一轮 A2 收缩方案）

**目标是底层编排框架支撑 Agent 发现问题、形成任务、验证并改进能力。** 框架固定真实来源、权限、契约、生命周期、预算、独立验证和经批准的应用；Agent 决定查什么、如何理解失败、采用什么方法及提出什么候选。实际失败产生新的诊断/候选，不因设想某种失败就给核心增加状态、分类器或固定补救流程。已有正确性保证仍须保留。

上轮把 A2 缩为 worker 只能看本人/直属子和一句根目标，不能满足依赖协作、祖先约束和深层取证。**默认相关性、读取授权和输出长度必须分开**：默认少推相关信息，但已授权的依赖证据及祖先原文须能按引用拉取。“兄弟”本身既不是可读凭证，也不是禁止依据。`task_status` 已提交 `scope=related|graph`（默认 related）分页实现，超长条目使分页停滞的缺陷已按 §5.15 Q4 修复（首条目放不下即具名 `context-too-large` 并给 `context_read` 引用与 `offset+1`）；Q3 的单事件续读已由 [Q3 收尾](history/2026-09-25-a2-a1-q3-closure-record.md)交付（同一四参数工具、上限 50000 字节），整项已验收。

源码核实后固定本组读取域为**当前 graph**：同域任务/关联证据与会话可按引用主动读，跨 graph 拒绝；默认摘要按相关性选择。group 当前是成员/router 拓扑，不是读取 ACL，不建设推测中的隐藏组权限。原始 Session 查询按 cwd 授权偏宽，该旁路已随 context 接线同批封死（有效工具面 + 执行闸双重），同 cwd 的不同 graph 互读反例在 `tests/integration/context-assembly.spec.ts`。读取同域事实不授予运行或接管任务的权限。

源码基线 `21ac1a1`：`task/src` 6 文件约 4,955 行；`task-runtime/src` 18 文件约 13,578 行，入口约 5,722 行；`agent-singularity/src/evolution.ts` 约 2,038 行。均为含注释物理行数，只定位集中点，不以减行数验收。真正的集中点包括 runtime 的 Session 观测、`orchestrate.reviewEnrichment` 的复盘派生，以及工具包内完整 Evolution 生命周期。目前 Singularity **没有 memory 包**；DSH 的 `session-query`、`session-reference`、`system-prompt`、compaction 已提供历史读取、引用、装配和压缩基础。

| 职责 | 当前归属 / 建设归属 | 接口与禁止承担的工作 |
|---|---|---|
| 契约、Task/Run/提案及其已提交事实 | 现有 `task` | 持久化、reducer、快照及原子提交；既有 Evidence/Review/Diagnosis 历史继续可读。不在这里构造 prompt、检索历史、评分、规划或选择候选 |
| 准入、批次、提交、取消、恢复、执行预算与写闸 | 现有 `task-runtime` | 唯一执行状态与副作用仲裁；提供已存在事实及必要只读执行观测，不维护第二套上下文/记忆库，不承载 supervisor 推理 |
| 目标/约束/依赖/产物/历史的相关性组织、来源引用、按需读取与上下文装配 | **`context` 包**（A2+A1 已提交实现，Q1–Q4 定向返工与 [Q3 收尾](history/2026-09-25-a2-a1-q3-closure-record.md)完成，2026-09-25 已验收） | 读既有来源，供模型工具和 prompt 两个实际消费者共用；不复制任务真相、不改变相位，不默认调用 LLM 生成摘要。这里承担当前所谓“工作记忆”的读取组织 |
| 长期经验与共享知识 | 现有 Skill/文件、DSH 历史与 Evolution 记录；**暂不另建 memory 包** | 当前项目状态从权威记录重建；经验带来源、适用范围及验证状态。只有出现明确跨任务写入/检索消费者，才定独立 memory 持久合同，不让 memory 变成第二个 Task store |
| Agent 创建、身份与消息投递 | 现有 `agent-runtime` + DSH Session/inbox | A4 已接线（恢复期唤醒只在屏障 ready 后，收尾返工）：通信主体在 agent-runtime（`messages.ts` 投递对账、`worker-resume.ts` 受控恢复）；问题/答案正文沿 Session 持久记录，context 负责呈现，task-runtime 只管阻塞执行效果与取消恢复；不把消息收发器搬进 task |
| 判据执行与 Evidence 生成 | 现有 `verifier` | 独立产物判断；不决定候选是否值得晋升 |
| 复盘事实、诊断读包及 reviewer 协调 | A5 的事后分析归 `agent-singularity/src/review/`；终态基础派生留 runtime | context 提供授权事实读取，Agent 产生解释/实验建议；task 保留原历史记录，runtime 保留终态唯一写入与基础派生，不依赖可选 reviewer 装配。Session 历史/指标直接取 DSH；只有真实重复的领域提取才抽共用函数。未出现独立装配需求不新增 review 包 |
| 候选、对照实验、晋升/回滚 | **`evolution` 包**（S4-E 已迁入并扩展：双侧实验、晋升闸、ledger 唯一实现；§5.17） | 已有完整生命周期及账本独立归属；Agent 构建候选，evolution 组织验证/批准后的应用。task-runtime 只接执行/恢复，不实现候选策略或评估平台 |
| 模型工具 schema、工具绑定与组合装配 | 现有 `agent-singularity` | 薄适配到上述所有者；业务职责不能因为工具名含 task 就归入 task 包 |

新 `context` 是 Singularity 的领域读取模块，复用 DSH 基础；不改上游 DSH 来承载 Singularity 任务语义。依赖方向：`agent-singularity → context → task / graphs / task-runtime 的只读观测 / DSH 查询与装配`；`task-runtime → task / agent-runtime`。**task、task-runtime、agent-runtime 不反向导入 context/evolution。** context 经 DSH 装配扩展接入模型请求；runtime 只提供事实，不能为让旧调用通过保留一份旧上下文实现。

模型接线复用 DSH 的异步 `system-prompt/assemble` scoped waterfall（静态 section provider 仍是同步接口），由 context 在组装时读源；复用 DSH 动态 context snapshot、压缩和引用读取，不增加刷新循环或第二份日志。不可变契约、可变项目事实与稳定角色政策各有一个来源；实际请求装配、普通分解、replay、恢复的消费者须一起迁移。包数可以增加两个明确所有者（context、后续 evolution），但旧实现要被替换，不能在原巨型模块之上叠一层空转发。

A2 与 A1 合成一个可验收交付组：授权概览、按引用取细节、实际 prompt 消费、重启/压缩重建一起交付。内部依次分为显式恢复/纯读分离、读取投影、模型接线、独立验收，不能每个子代理都承担整组。具体场景、读取授权和迁移清单见[建设计划 D/E 节](2026-09-20-vrtc-code-change-plan.md)。唯一顺序在 R1 后先安排有限的 R3 合同归位，再派 A2+A1；A4/S4-E/A5/A6 的职责迁移分别随各自票的行为同批验证。该组已提交原实现、Q1/Q2/Q4 定向返工与 [Q3 单事件续读收尾](history/2026-09-25-a2-a1-q3-closure-record.md)，整组回归已在收尾里跑过，现已验收；证据见[交付记录](history/2026-09-25-a2-a1-delivery-record.md)、[返工记录](history/2026-09-25-a2-a1-rework-record.md)、[复审记录](history/2026-09-25-a2-a1-progress-review.md)与[Q3 收尾记录](history/2026-09-25-a2-a1-q3-closure-record.md)。

读取与恢复的合同在计划 D/E；两者已随第 9 项验收。A5/A6 合同在 F.3/F.4；本轮 K1～K4 的详细合同只在表中所链 prompt，不复制四套施工说明。五问去重裁决以[建设计划文首复核](2026-09-20-vrtc-code-change-plan.md#五问复核保留领域差异直接用现成底座)为准：

- **读取（已提交实现并验收）**：task_read、task_status 与 context_read 由 context 读源适配；四个跨 Session 原始工具已从角色有效工具面移除并由执行闸拒绝。绑定事实读取失败具名拒绝且零模型输入，委派者必须是所属 graph 成员，状态分页必前进。超限单事件按 `ref:{sessionId,seq}` 逐页读取其可见正文（`extractSessionEventText`）的 UTF-8 字节页；上限 50000 字节与部署的 DSH inline 上限一致，字节窗口与省略措辞复用 `@deepseek-ai/dsh-output-retention`，游标与按行预算仍属本包。
- **恢复（已提交实现并随整组验收）**：graphs.activate（含启动恢复）显式 await adoptRoot，创建也汇入该门；先完成对账/写闸/driver 登记，再开放业务输入，不等批次执行。直接执行入口未就绪具名拒绝；读取路径不恢复。此实现已随第 9 项提交；整组回归已在 [Q3 收尾](history/2026-09-25-a2-a1-q3-closure-record.md)跑过，不能因局部成立跳过整组验收。
- **后续闭环**：先由 K1～K4 修正执行/提交/候选单位/预算，再接 A5 诊断和 A6 supervisor。A6 只增加 capability 行、新 provider 与失败原目标的新尝试及证据复用，已有 Skill 更新、批次推进和提交恢复复用 K1～K4；不另造修复状态机。成功来源不恢复，缺适用比较器不晋升，人不补写 Skill。

R3 是避免共享导出同时迁移的串行维护安排，不是上下文能力的技术前置；禁止借此要求先整理完所有大文件。后续每票内部交接顺序见计划 F，整组集成与验收也派子代理执行，子代理一次只领取一个确定目标。

2026-09-24 派发前重读结论：保留上述架构和顺序。计划 F 已补明 replay 实验血缘不授权问父、task_recover 先由 evolution 核对晋升再由 runtime 重检执行、EVO-1 必须有真实 Agent 运行证据才能整组验收。A6 的工作量应按接口串行交接，不能整个转派一个子代理。**第 8 项 R1 已于 2026-09-24 验收**（无模型返工 + 三个完成轮，完成轮 3 判 `pass / path2-limited-goal`，§5.14 完成轮记录）；归档 S3（补验证轮）与完成轮 1、2 的失败保留为历史。第 8a 项 R3 已按唯一执行表验收（见文首与 §1.5），不要重复派已完成的返工、补验证或 R3。

每票派发必须列出“事实所有者、行为所有者、工具/提示词消费者、迁出与删除位置”。新增模型策略不能以 enum、固定错误目录或全局状态机烙进 task；新增知识不能自动成为契约或权限。取舍由当前消费者和真实失败说明，不以“未来也许需要”为由增加核心设施。用户审核改进与证据，不负责补写实现。

### 1.5 既有大模块的处理原则（2026-09-24）

**400 行以上是重点审查触发条件，不是拆分验收线。** 本轮按用户要求调查已有实现；`task` 的大部分体量是契约、历史事实及完整性检查，不能等同于不必要功能。真正应收回的是错位的行为、仅供测试的生产接口、重复判定，以及把 Agent 的研究空间限制为预设选项的规则。具体文件、迁移顺序与验收见[建设计划 E 节](2026-09-20-vrtc-code-change-plan.md)。

- **留在 task**：Task/Run/提案/证据/Review/Diagnosis 的持久形状、引用完整性、reducer 与原子提交。记录 Diagnosis 不等于 task 在执行诊断；记录所用 Skill 身份不等于 task 应解析 Skill 文件。保留历史可读性和整批提交保障。
- **迁出 task**：Skill 侧车形状/路径/摘要规则归 task-runtime 的 provider 实现；Verifier 执行和自测接口归 verifier；仅测试使用的旧 root 构造类型归测试夹具。不要为这些迁移新建包，也不要把迁出的代码追加进 runtime 的巨型 index。
- **建议与执行分开**：Diagnosis 可以记录新改进方向，task 只校验描述、身份和证据，不按 Evolution 当前支持的对象类型拒绝建议。实际候选和应用仍由 evolution 拒绝不支持的类型、重检授权与验证；可记录不等于可执行。
- **观察与推进分开**：当前 `runForSession → lookupRun` 会恢复执行并补写内存闸，不能当作 context 的纯查询接口。事实读取不得隐式启动批次、审批、验证或恢复；恢复及首个动作前的绑定/闸初始化仍由 runtime 负责，迁移不能丢掉 R2 的取消与重启保障。
- **拆分必须减少维护负担**：优先迁出完整职责，再在原包内按提案、运行推进、终态结算等真实规则整理。每个有状态协议仍只有一个所有者；不把一个大对象拆成多个可任意读写彼此状态的 manager，不引入通用 repository、事件总线或 effect 引擎。

架构审核检查的是：修改一种规则需要找到几个地方、谁能写最终状态、调用一次读取会不会推进任务、删除旧实现后实际消费者是否仍完整。文件变短而这些问题未改善，不算完成；审计/恢复所需的字段即使模型不直接读取，也不是无消费者。后续实现者按有限合同施工，不能把这次清单当成全仓整理授权。

每票的简化义务与功能同批验收：只核对本票触及的职责和 400 行以上文件，说明留下、迁出或删除的依据；已声明迁出的旧实现、旧生产调用和同名转发须在本票交付时消失，不能让新包与旧包各保留一份判定。确实属于后续票的整理，写明触发票号和实际消费者，不因此另立全仓整理前置。

完成记录要写迁移前后的实际调用链、行为所有者、被删除的旧位置和仍保留的执行/持久事实。按这些净变化判断可维护性，不以净行数、最大文件长度或导出数量评分；没有当前合同违约或重复职责的反例，不为“代码可能继续变大”预建额外包装层。第 9、11–14 项对应完成条件见建设计划 A2-6、A4-5、EVAL-5、REV-5、EVO-5。

**R3 执行事实（2026-09-24，已验收）**：本节清单中标注 R3 的三项错位已按计划 E 节合同完成纯迁移，行为零变化：

- **Skill 合同迁出 task**：`task/src/skill-contract.ts` 全文迁为 `task-runtime/src/skill-contract.ts`（runtime provider 内部模块，**不加入** `task-runtime` 的包 index，也不并入 `sidecar.ts` 大文件）；`canonicalize`/`sha256Hex` 仍从 `@dangosys/dsh-singularity-task` 导入，无第二套 digest 基础。消费者 `task-runtime/src/{sidecar,run-binding}.ts` 改从内部模块导入；task 的 `export * from './skill-contract.ts'` 与源文件已删除。`TaskRun.providerBinding` 与 `RunSkillBinding` 的内容身份记录、`registryRevision`、预检/绑定/晋升拒绝语义不变；迁移前后同一 fixture 经真实生产入口复算的 `skillContractDigest`（`a5ceee1b…`，与 spec 内仓库外 `sha256sum` 固定向量一致）与 `skillContentDigest`（`e7982b5c…`）完全相同。测试锚：`task-runtime/tests/unit/skill-contract.spec.ts`（22 项，自 task 迁移，向量与断言未改）+ 既有 `task-runtime/tests/unit/{sidecar,run-binding,provider-precheck,provider-load,carried-precheck}.spec.ts`。
- **Verifier 执行接口归入 verifier**：`Verifier`、`VerifierSelftest`、`VerifierSelftestSample`、`VerifierSelftestStore`、`VerifyRequest` 自 `task/src/types.ts` 迁为 `verifier/src/types.ts`（verifier 依赖 task 的方向不变，`static inject = ['task']` 同构）；`VerificationMode`/`VerificationResult`/`EvidenceBundle`/`EvidenceClaim`/`AcceptanceCriterion` 等持久与契约事实仍由 task 持有，task 无任何 verifier 反向依赖。command/composite/review 三实现、注册自测闸、版本盖章（`stampVersion`）、受保护输入与 `verifyRun` 全部改用本包类型；verifier index 旧的对 task `VerificationMode`/`VerificationResult` re-export 已删除（无消费者，转发层不留）。测试锚：`verifier/tests/unit/{verifier-registry,command-verifier,composite-verifier}.spec.ts`、`tests/integration/verifier-selftest-inputs.spec.ts`（真实链路：插件先过自测闸才可注册、受保护输入改写判 fail、判决带注册实例版本）。
- **测试专用 root 类型迁至测试支持层**：`RootTaskSpec`、`TaskDefinition` 自 `task/src/types.ts` 迁入 `tests/support/legacy-root.ts`（值与形状未变，注释补充 R3 归属），`task/tests/unit/proposal.spec.ts` 改从测试支持层导入；生产代码零导入、task 无此导出。fixture 仍经真实 `createTaskIn`/`admitTaskIn`/`startRunIn`/`adoptRoot` 构造（R3-3）。
- **保留边界与未完成项**：`task/src/service/state.ts`、`proposal.ts`、事件根、原子提交顺序与旧 JSONL 读取零改动（`verify-persistence` 4 根匹配）；计划 E 节其余审计项（`types.ts` 包内整理、`index.ts`/`orchestrate.ts` 拆分、公开面收窄、`sidecar.ts` 内部模块化）**不在本票**，仍按其原安排随后续真实改动处理；R3 也不是 A2 的功能前置——A2 按第 9 项合同独立验收。实跑：`pnpm build` 通过；unit 44 文件 / 1461 项、integration 38 文件 / 268 项通过（与 R2 Q1 验收后的基线数量一致）；`git diff --check` 干净；`agent-singularity` 的 `pnpm exec tsc --noEmit` 通过；无模型调用、无部署、无推送。

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

执行只使用 [建设计划](2026-09-20-vrtc-code-change-plan.md)文首唯一表。A0、R2、R1、R3 已验收；第 9 项 A2+A1 的 Q1–Q4 定向返工与 [Q3 单事件续读收尾](history/2026-09-25-a2-a1-q3-closure-record.md)已完成，现已验收。原交付、审核、返工与收尾分别见[交付记录](history/2026-09-25-a2-a1-delivery-record.md)、[审核及复审记录](history/2026-09-25-a2-a1-progress-review.md)、[返工记录](history/2026-09-25-a2-a1-rework-record.md)。

### 上下文、协作与诊断的方向决定

节点默认继承结构化契约与 handoff，不复制祖先完整聊天；全局观由真实根目标/硬约束、当前任务的贡献、相关决定与证据引用构成，细节按授权范围查询。沿用 DSH scoped system prompt 和 Session 原始日志，摘要仅改变视图，不能替代原始证据。Task DAG、Agent Graph、Session lineage 分别拥有事实，按 id 关联。

父子澄清必须采用非阻塞协议。A3 已使 `task_decompose` 准入后返回并区分 idle 与提交验收；A4 已接线持久父子问答（恢复期唤醒在屏障 ready 后，§5.16）：`task_ask_parent`/`task_answer` 经真实 Session 正文引用与同 messageId inbox 投递，阻塞从问答事实派生，问答等待的非根 Run 重启后恢复同一 Session。DSH 的 send_message 要求 continuable activation，Singularity spawn 未接该生命周期，故未采用。沿用现有 agent-runtime handle 所有权和原生 inbox/steer/resume；未引入第二套 agent loop/Team task board。

协调主相位与阻塞问题分别记录，逐级询问不丢原批次或开放写权限；消息入箱不等于模型已消费，必须覆盖 claim 后中断的恢复。派发子节点和开始验收前均关闭新写入并确认在途写入收敛。对应故障窗口与竞态反例纳入 A3/A4，不能只靠 prompt 维持这些不变量。

任务列表显示可读取的状态与有依据的执行限制，可见不等于可领取，动作仍由 runtime 实时重检。节点可查询与提出新 Task，不做全局工作窃取。复盘由真实失败自动触发，或由 Agent/用户对成功或失败显式发起；Agent 自选取证路径，可结论为无需改进。只有有建议且具备适用评估的目标才进入候选、独立验证和人审；复用已有身份，不建 incident 平台，不以诊断自述取代正确性证据。

根契约入口已实现（§5.11），其来源归属与恢复入口已返工关闭（§5.13）：setup 与目标激活分离，graph name 不再代替 objective，缺独立判据具名拒绝，旧任务不原地改题；根契约的来源由统一服务入口机械校验（store↔session、顶层会话、会话自身日志里的本人消息），模型自报不能替代，`adoptRoot` 无根时经既有恢复遍完成恢复。这些是机械合同，不能推给模型实验；R1 只验证了一个具体澄清场景，schema/hash 不证明语义正确。A2+A1 已提交实现，进度审核返工与 Q1–Q4 定向返工（含 Q3 单事件续读收尾，§5.15）均已关闭，现已验收；A4 收尾返工（恢复期唤醒在屏障 ready 后）已验收，见 §5.16 与[最终审核](history/2026-09-26-a4-final-review.md)。

### Task 自主构造与可选人审

**方向已确定，T2/T3 已实现并验收（2026-09-23）**：节点可以复用、组合或直接生成任务实例，不以“先找不到模板”为必要条件。现有 `task_decompose` 已允许现场给出 objective/AC/capability；T1 已收敛 Task 语言与持久化合同，T2/T3 交付组已落地生成审核策略、提案生命周期与崩溃恢复（§5.10），整组已验收。

区分三类变更：当前目标下的新任务实例经机器准入、可选契约人审后执行；共享模板作为 Evolution 改进候选验证并晋升；已接受的根目标/AC、生产能力及权限变化走各自已有或待建的变更协议。任务生成人审开关仅影响第一类，不能绕过后两类的治理。

`Config.generatedTaskReview: off | all` 已实现，默认 `off`（闭合 schema，未知值拒启，见 `task-runtime/src/index.ts`）：`off` 保持既有自主分解行为并把策略记在提案上（`policy-off`，不伪记批准），`all` 审核整批规范化契约与内容身份，批准并重检通过后才准入。机器校验在两种模式下都执行；无审核人、取消或拒绝不能自动视作批准（渠道不可用保持待审并说明原因）。审核等待是提案状态（`pending_review`），不借用 Task 的能力/证据 `blocked` 状态。节点负责生成与修订，人只审核契约，不代写任务，也不提前判定任务成功。

详细规范、模块落点、状态机、异常路径与 T1–T3 验收见 [Task 自主构造建设指导](task-contract-construction-guide.md)。规范限定可表达的结构与治理边界，不试图穷举人类任务，也不声称能机械证明自然语言契约完整。

详细票据见 [建设计划](2026-09-20-vrtc-code-change-plan.md)。以下是依赖顺序，不是任务执行 workflow。

先期工程记录见[历史执行记录](history/2026-09-24-vrtc-execution-records.md)，§5 仅保留当前要用的实施边界。S4-E 评估基础先于自动候选执行；已有机械保障不替代自主修复与恢复，也不证明自然语言验收完整或证据来源真实。

| 顺序 | 建设目标 | 完成条件 |
|---|---|---|
| S0 | 文档基线与递归能力发现 | 状态统一；worker 能查询能力表且没有获得管理工具 |
| S1 | 可信验收与可追溯能力绑定 | 错产物不通过；父 AC 有组合验证；不存在的 skill 和冲突 preset 在派发前拒绝；run 可定位实际实现 |
| S2 | 缺口处置、supervisor 交接与恢复 | 缺口持久化、去重；将诊断/候选工作交给 agent；补足后系统恢复受影响任务；与 S3 同批验收 |
| S3 | L1 复用/组合，再 L2 生成 | 制造 GAP 后由 agent 自动补路径；新候选通过验证并经人审晋升后系统恢复，无需人工补写能力 |
| S4 | Retro 与自动接受规则 | observed/holdout 分开过关；按变更目标使用不同指标；坏候选被拒绝 |

上表 S 编号表示责任领域，实际派发及拆分以建设计划为准。S1 受支持合同和 S4-E 评估是候选晋升前置。A6/S2-R/S3 完整交付：故障可注入，但解决路径由 agent 产出，不能止于人工填配置。L3 引入新工具继续走权限流程。长期记忆、通用全局调度器、复杂 skill 成熟度系统后置，均不替代已承诺行为的完整验收。

运行可行性已由 A3 统一落地（2026-09-22，§5.9）：状态迁移、效果交接、恢复和根预算归属集中在 Task runtime；普通/replay/恢复共用规则，工作区写入归属覆盖跨批次/跨根冲突。新建子任务、候选或 Run 不重置总预算；反复同一失败、改写计划不能自动计为进展。硬限额必须可执行，未知费用不记零。

迭代有效性由 S1-C/S4-E/S2-R 衔接：S1-C 已固定 Run 实际加载的版本，apply 不热换在途实现；双侧比较已有 S4-E 基线；提交恢复已由 K2 验收（§5.19），完整 Skill 更新已由 K3 验收（§5.20），应用后的任务新尝试待 A6。后续比较须从相同初始输入在隔离工作区执行，证据适用性决定能否复用成功兄弟结果；任务内经验不自动晋升共享能力。模型成功率与成本改善需真实实验，协议通过不等于已证明进步。

## 4. 当前实现与缺口

### 4.1 源码复核表

本表汇总各票已注明的交付事实；2026-09-23 文档复核重点核对根入口、默认工具、provider 预检及根预算的现有接线，未重新运行全部测试。状态描述明确范围，不把“类型有字段”算成整项完成；函数名是定位锚，行号以当前 checkout 为准。

| 能力 | 当前事实与限制 | 源码锚 |
|---|---|---|
| Task / TaskRun / 递归分解 | 有独立对象、事件存储、结构准入、树与依赖 DAG、顺序级联；原子性和自然语言 AC 覆盖不由机器证明 | `task/src/types.ts`；`task-runtime/src/admission.ts:checkDecomposition` |
| Task 语言与生成审核 | 已能现场生成子任务，无模板命中要求。T1 已收敛为单一规范化契约与身份（§5.6）：`TaskContract` 数据定义、闭合字段集与默认值、criterion id 固定、单契约/整批摘要、`contract` 与 assumptions/constraints 持久化，普通分解/replay/root 共用同一入口与结构校验。T2/T3 已补生成提案审核（§5.10）：`Config.generatedTaskReview: off/all`（默认 `off`）、不可变提案记录（整批契约内容 + 策略 + 两个上下文指纹）、`off` 只记 `policy-off` / `all` 批准并重检后才准入、提案决定绑定摘要、四个崩溃点的恢复与 requestKey 幂等。A0 让根契约走同一套记录与审核（§5.11，`TaskProposal.kind` 判别字段）。模板库与契约修订入口仍未建 | `task/src/contract.ts`；`task/src/proposal.ts`；`task-runtime/src/normalize.ts`；`task-runtime/src/proposal.ts`；`task-runtime/src/index.ts:submitDecompositionProposal`、`submitRootContractProposal`、`continueProposal`、`decideProposal`、`reconcileProposals`；`task/src/service/state.ts:assertContract`、`decideProposal` |
| Task 定义版本 | 有 `definitionRef`；普通子任务使用 `subtask@1`，根任务使用 `root@1`，不等于完整不可变定义库和变更授权机制。T1 固定的是契约内容身份（`contractDigest`/`proposalDigest`），未建模板库 | `task-runtime/src/index.ts:decomposeAndRun`；`task/src/contract.ts:contractDigest` |
| 根目标入口 | **A0 已实现，Q2/Q3 返工已关闭（§5.11、§5.13）**：`graphs.create` 只建 graph + root session 并调 `adoptRoot`，不再建根任务；`task_intake` 用真实用户目标构造契约（至少一条 mandatory 非 composite 判据，否则具名拒绝零副作用），经可选审核后一次原子提交激活根任务 + 根 run；契约接受前 `task_read`/`task_status` 返回具名「尚未激活」视图，graph name 不再进入 objective；旧图的根任务按历史读取/验收/完成，其上 intake 具名拒绝；终态根 session 不复活。**来源与归属**由统一服务入口（提交/续跑/恢复三处共用 `assertRootContractOrigin`）机械校验：store 必须等于该 session 自己的 store、会话必须是顶层会话（`origin: 'subagent'`/`delegationDepth` 拒绝）、会话自身日志必须有 `source.kind === 'user'` 的本人消息；日志不可读即具名拒绝，全部发生在首次写入之前（不创建 store）。本运行时的 `spawn`/`prompt` 提示词改记自有来源 `runtime-prompt`，不再冒充人类输入。`adoptRoot` 无根任务时先跑既有恢复遍再读回（`ready`/`approved` 激活并绑定、`pending_review` 重发、空 store 具名 `adopted:false` 零写入）。仍未建：契约修订入口（修订=新提案）、模板库；A1 上下文投影已随第 9 项交付（§5.15）；R1 完成轮 3 证明固定场景下澄清答复可送达并被消费、契约可不夹带未确认条件并通过全部必需判据（§5.14 完成轮记录）；根 prompt 与 `task_intake` 说明现含三条契约边界（假设不得替代确认、缺失条件先问用户且不得由环境代答、契约只承载答复支持的内容且判据须可裁定，`99e1311`/`aa19637`/`9a3e508`）；服务层不校验「该顶层会话属于某 graph」（该规则仍在工具层） | `graphs/src/index.ts:create`（改调 `adoptRoot`）；`task-runtime/src/index.ts:intakeRootContract`、`submitRootProposalOnce`、`continueRootProposalIn`、`reconcileRootProposal`、`assertRootContractOrigin`、`adoptRoot`、`nothingAdoptedDetail`、`admitRootProposalIn`；`agent-runtime/src/{index,types}.ts`（`RuntimePromptSource`/`runtimePrompt`）；`agent-singularity/src/tools/{task-intake,proposal-store}.ts`；`task-runtime/src/admission.ts:rootIndependenceDefects` |
| Capability | 配置表解析、准入 provider 预检与真实 grant 已建；执行型/知识型侧车契约经统一校验，run 级内容绑定固定实际实现（§5.8）；没有可行性证明或多候选选择 | `capability.ts:resolveCapabilities`；`provider-precheck.ts`；`sidecar.ts:validateSkillProvider`；`run-binding.ts`；`grants.ts:grantSkills` |
| Handoff / 上下文 | **第 9 项已提交实现，Q1–Q4 定向返工与 [Q3 收尾](history/2026-09-25-a2-a1-q3-closure-record.md)完成，现已验收（§5.15）**：worker 的契约/handoff/根简报由 context 在每次真实请求装配时从 store 投影为 `singularity:worker-contract` section（order 80，压缩存活），动态项目状态走 DSH runtime-context 快照；spawn 首消息只是 agent-runtime 的稳定 kickoff + 政策 section，不再夹带渲染内容。持久 handoff 数据仍由 runtime 生成保存；worker 摘要含本 run 选定 capability/skill 绑定（S1-C）；原始 session query 按 cwd 授权的旁路已封死（执行闸单调拒绝），历史读取统一经 `context_read`；绑定事实读取失败已具名拒绝且零模型输入（Q1），委派者归属已核对（Q2） | `task-runtime/src/handoff.ts:buildHandoff`（数据）、`context/src/{assembly,projections,render}.ts`（投影）；`agent-runtime/src/prompts/worker.prompts.ts`（稳定政策） |
| 父子交互 / 生命周期 | A3 已改非阻塞（§5.9）：task_decompose 准入后立即返回批次身份，父进入 waiting_children（运行时闸只放行读/状态/诊断/task_cancel 与问答协调 task_ask_parent/task_answer）；**K1 已验收（§5.18）**：子全终态后批次结束——确认子写入停止并归还工作区、父 Run 持久化回 `active`、闸放行（未决 blocking 问答仍单独阻塞，批次结束不代答）、父 Session 收到 `m-batchend-<batchId>` 结果通知；父读结果、继续工作、追加一批或 `task_submit_result`，只有父主动提交才做父独立验收，runtime 不再替父提交。同一 Run 同时最多一个未结束批次与一个待审/待准入提案；批次身份 `(parentRunId, proposalId)`；worker 经 task_submit_result 显式提交，session idle 不再是完成证据（无进展相位机：标记→一次提醒→到限停止）；取消/恢复/卸载经 cancelBatch/cancelGraph/dispose/reconcileStore。A0 之后根 session 的生命周期不同：契约接受前没有 run（读作「尚未激活」），接受后根 run 出生 `active` 并自决工作，终态即 session 置 `terminal`、迟到 intake 被闸/状态双重拒绝（§5.11）。取消进行中（`cancelGraph` 已关闸、取消未落盘）时，只读查询与协调读不能把闸改回 `active`；取消已经跑完、只留旧读取的返回值时同样不能（闸按自己的决定计数丢弃陈旧值）：重启恢复（waiting_children/终态）仍照 store 补闸，合法 active 执行不受影响（§5.12）。A4 已接线持久 question/answer 与问答等待（恢复期唤醒在屏障 ready 后，§5.16）：问答事实经 `QuestionAsked`/`QuestionAnswered` 落库，active+阻塞对外显示 `waiting_answer`（纯派生非相位），阻塞会话的闸只放行协调动作，waiting_children 永不因问答获写权；问答等待的非根 Run 重启后经 `resumeWorkerAgent` 恢复同一 Session，恢复期的问答投递与 owner notice 等屏障 ready 后才发出（§5.16）。DSH send_message 不能直接用于未注册 continuable activation 的这些子节点 | `task-runtime/src/index.ts:decomposeAndRun`、`adoptRoot`、`orchestrate.ts:driveBatch/finishBatch/observeWorkerRun`、`gate.ts`、`task-runtime/src/question.ts`、`agent-singularity/src/tools/{task-submit-result,task-ask-parent,task-answer}.ts`；`agent-runtime/src/{index.ts:spawn,messages.ts}` |
| 任务导航 / 诊断 | `task_read` 当前任务、`task_status`（`scope=related|graph`，默认 related，稳定分页）、`context_read` 六种引用读取均为 context 同一读源的薄适配（§5.15）；review pack 有局部证据及父子摘要，只读 reviewer 经既有 ledger 委派绑定、可写 Diagnosis；**K4 起 gate 协调清单含 `task_review_agent`，原根截止/终态不阻止只读复盘（§5.21）**；自动 reviewer 触发与候选交接仍待 A5，不预建动作矩阵或机器因果遍历器 | `context/src/{bindings,projections}.ts`；`agent-singularity/src/tools/{task-read,task-status,context-read,task-review-pack,review-agent}.ts`；`task-runtime/src/gate.ts` |
| Evidence 依赖 | `requiresArtifact` 只认 verified run 且带 pass 判据的证据；`acceptsArtifact` 只要求存在。普通分解缺失时 blocked + Obligation；replay 的 spawn 开/关路径使用同一检查，缺失时在建任务/Run 前抛错，零派发/零成功记录。不自动生成上游，不验证匹配证据的版本和适用性 | `orchestrate.ts:missingRequiredArtifacts`、`runReplayTask` |
| Obligation | 记录缺能力/缺产物；模板 coverage 由任务声明 capability 或文字提及匹配；不是义务已被证据满足，更不是防漏的硬闸 | `task-runtime/src/obligation.ts:checkObligationCoverage` |
| 判决 | `pass/fail/inconclusive`；部分 unknown 有 task/verifier 分类；没有 PARTIAL 状态与剩余义务自动派发；未通过 mandatory 判据仍走失败路径；`heuristic` 标记的判据永远不计入确定性通过 | `task/src/types.ts:VerificationResult`；`orchestrate.ts:unmetMandatory` |
| Verifier 边界 | 注册即执行可执行自测（`VerifierSelftest.samples` 正负样本；缺样本、描述性样本或漏检样本拒绝注册，唯一例外是调用者显式声明的 `{ testDouble: true }` 并记录警告）。判决与 claim 记录**实际注册实例**的 `version`（插件自报一律被覆盖；版本归属规则见 §5.7：只有实际判决、或由 registry 归因到已解析裁判实例的拒绝才带版本，未知 ref 与不支持 mode 的拒绝不带）。criterion 声明的受保护验收输入在准入时固定 `{ path, sha256 }`（读不到即整批拒绝），判决前复检：缺失或被改 → `fail` 点名路径且不派发；store 里畸形声明（绕过准入口直写）得到点名条目的可读 `fail`，不是崩溃。仍未建：verifier 与执行者的独立性隔离（`owner` 只是元数据）、证据来源真实性认证、自测样本“有意义”的证明；KISS §8.2 的裁决召回未建（R2 已撤回无消费者的 `(verifierRef, version)` 查询入口 `evidenceByVerifier`，§5.12） | `verifier/src/index.ts:register`、`selftestGate`、`verifyCriterion`；`verifier/src/protected-inputs.ts`；`task-runtime/src/protected-inputs.ts` |
| 父验收 | 默认无映射 composite 保持子全 verified；childEvidence 必须存在且来自 verified run，被引用子判据为 heuristic 时拒绝；**K1 起 childIndex 指该 Run 已准入批次累积成员的 0 基稳定位置（跨批累积、不每批从零，§5.18）**。registry 在自定义 verifier 执行前同样检查映射，合法映射仍须通过所选 verifier，插件不能覆盖映射规则。父 mandatory heuristic 不计确定性通过；requiresIndependentAcceptance 缺映射时准入拒绝 | `composite-verifier.ts:entryDefect`（成员源 `runMembersIn`）；`verifier/src/index.ts:verifyCriterion`；`admission.ts:independentAcceptanceDefects` |
| 预算 | A3 已建根预算（§5.9）：`Config.rootBudget`（wallTimeMs/maxRuns/maxConcurrentWrites=1，闭合 schema，未知成员具名拒启）；run 期限 = min（配置 wallTimeMs，根剩余），从持久化 run.startedAt 起算、重启不重计时；maxRuns 按 runId 记账、崩溃重数不退款不重置；replay 经 rootTaskStoreId 根绑定共享 store 根总额；无进展相位机（标记→一次提醒→到限停止）已接线。tools/tokens 仍仅终态软统计（unknown 不记零）；attempts 仅声明。**K4 已交付（待验收，§5.21）**：已批准维度以 Task store 持久 `TaskBudgetExtended` 的绝对上限为准，`resolveRootBudget` 输出配置上限+有效上限两份，准入/启动/replay/watchdog/收尾全路径只读有效值；扩额经 `task_budget_extend` 人审、只升已配置维度 | `root-budget.ts:resolveRootBudget/checkRunStart/hasRootLimits`；`orchestrate.ts:observeWorkerRun`、`budgetBreaches`；`task-runtime/src/index.ts:Config`、`budgetExtensionDraft/extendRootBudget`；`task/src/budget.ts` |
| L4 上报 | root 的 `escalate` 工具与台账已有；模型主动调用，批准后才记 raised；运行时只输出提示，无自动触发、无处理结果/恢复闭环 | `agent-singularity/src/tools/escalate.ts`；`orchestrate.ts:escalationHint` |
| blocked 恢复 | blocked 无恢复出边；TaskRetried 只接受 failed；补能力后不会自动续跑原图 | `task/src/service/state.ts`；`task-runtime/src/index.ts:decomposeAndRun` |
| Review / Evolution | **S4-E 已验收（§5.17）**：生命周期与 ledger 主体在 `evolution`，九个工具接线；双侧新 Run、报告回读、两次人审、显式版本化裁判、写边界版本闸、当前形状 fold、Skill candidate/prepare 写前拒绝及 replayTask 闭集拒绝已验证；gate 只记录回答/证据，晋升检查在 PROMOTE/apply。**K2 已验收（§5.19）**：apply/rollback 经唯一提交入口——意图（`commit_intent`，绑定批准来源/目标/前后内容身份/可恢复来源）先经唯一 durable append 落盘、同目录临时文件 fsync+rename 原子替换、回读校验后才记完成；启动/恢复屏障先对账开放意图；意图未结目标在 provider 准入选址具名拒绝；ledger 单格式升为 `formatVersion: 3`；同日返工补齐来源在意图前稳定、目录 fsync 失败具名抛错不记完成、staging 残留清理与真实子进程 SIGKILL 证据。**K3 已验收（§5.20）**：改进单位扩为完整对象——指导型仅 SKILL.md；执行型为 SKILL.md + SKILL.contract.json 两固定文件（resources=[]），候选 sidecar 由生产派生只重算 `content.skillMdSha256`；commit_intent 携带固定文件集（逐文件前后身份与来源）、逐文件原子替换、记完成前经统一校验做完整对象可加载复检；准入闸按目录阻断开放意图；ledger 升 formatVersion 4，实验报告升 formatVersion 3 | `evolution/src/{evolution,commit,experiment,promotion,replay}.ts`；`agent-singularity/src/tools/evolution-*.ts`；`task-runtime/src/{provider-precheck.ts,index.ts:replayTask}` |
| root-agent 构建类型闸 | `agent-singularity` 的 `build` 为 `tsc --noEmit && tsdown`，类型错误即构建失败；工作区根 `pnpm build`（`pnpm -r run build`）经过同一检查。2026-09-21 前该包 `pnpm build` 只有 tsdown，不保证严格类型检查通过 | `agent-singularity/package.json` scripts.build |
| 身份与枚举的类型来源 | 工具侧 `sessionId(exec)` 直接返回上游 `Agent.id` 的 `SessionId`，不再降级为 `string`；`DiagnosisProposal.targetType` 与 `evolution_propose` 的 targetType 由 `@dangosys/dsh-singularity-task` 的 `ProposalTargetType` 标注并经运行时校验，不是任意字符串断言 | `agent-singularity/src/tools/task-diagnose.ts:toProposals`；`src/tools/evolution-propose.ts:isProposalTargetType`；`src/evolution.ts:validateMutation` |

### 4.2 优先修复的断层

| 编号 | 问题与影响 | 建设票 / 历史对应 |
|---|---|---|
| G1 | 父 composite 曾仅对子状态求合取，不能证明根目标；同环境执行 verifier 也不等于测试与阈值不可被修改。P4 已落地最小机械版（切片 1+3：父 AC `childEvidence` 映射、独立父级组合检查、`heuristic` 标注、原始输入与已验证参考产物区分）；S1-V 切片 2 已落地 verifier 自测的实际执行（注册闸）与声明式受保护验收输入的准入身份固定 + 判决前复检。剩余：C3 假设满足性的完整证明、未声明保护范围的输入仍不受保护（这是边界，不是“已保护”）、证据来源真实性认证、自测样本“有意义”的证明 | S1-V / 旧 #25、#26 |
| G2 | provider 预检、run 级内容绑定与统一校验入口已由 S1-C 落地（§5.8）：不存在的 skill、未知执行 verifier、工具声明不满足、冲突 preset 在落库前拒绝；run 可定位并实际加载绑定的旧版本。单文件 Skill 候选内容身份（P2）与生产基线（P3）保持，对象范围已由 K3 扩为完整对象（§5.20）。剩余：`closed` 仍不证明自然语言契约完整或搜索路径必然成功；证据来源真实性认证未建 | S1-C / 旧 #29 |
| G3 | 缺产物曾只查存在且 blocked 无恢复，证据驱动生长断在登记之后。P4 已把存在性收紧为 verified 参考产物并区分原始输入（`acceptsArtifact`）；blocked 仍无恢复出边，补产物后不会自动续跑原图 | S1-V、S2-R / 旧 #20、#21、#22 |
| G4 | 上报依赖模型调用且批准前不落账；任务阻塞、通知与人类决策混在一起 | S2-E / 旧 #27；已有工具不能标为待建 |
| G5 | 判决仍三值，缺 PARTIAL/UNKNOWN 的任务级恢复处置。A3 已实现根时间/run 数/唯一写入预算及无进展停止；tools/tokens 仍为软统计、attempts 仅声明，不能一概写成预算未接线 | S2-R / 旧 #23、#24；根预算已由 A3 交付 |
| G6 | 类型化侧车契约与知识型定位已由 S1-C 交付（§5.8），建设依赖倒置已解除；L1 复用/组合与 L2 生成候选仍待 S3，候选须经同一校验与验证闭包 | S1-C → S3 / 旧 #29 |
| G7 | **S4-E 已验收**：单文件 Skill 替换的双侧评估、版本化裁判、账本单格式、当前形状 fold 与模型入口已闭合；gate 保持记录语义。分层指标、自动 Retro、多目标打分不纳入；fixture 不宣称统计效果。评估对象范围已由 K3 扩为完整对象（§5.20） | S4 / 旧 #28 |
| G8 | `task_decompose`/`escalate` 部分拒绝返回普通文本，上层不能可靠用工具错误信号判定 | S2-E / 旧 #33 |
| G9 | 类型闸只覆盖 `agent-singularity`；其余 Singularity 包的 `build` 仍只有 tsdown，未接 `tsc --noEmit`，其严格类型状态未经本闸保证 | P1 范围外，待独立评估 |
| G10 | 动态生成已存在，无生成提案审核协议的风险已由 T1+T2/T3 关闭（§5.6、§5.10）：统一可持久化契约、闭合字段集、内容摘要与准入记录（T1）；`generatedTaskReview` 策略、不可变提案与整批内容、决定绑定三个摘要、批准后重检、requestKey 幂等与四个崩溃点恢复（T2/T3，2026-09-23 已验收）。仍未建：Task 模板库（模板不是合法性白名单）、契约修订入口、多进程并发写同一 store 的恰好一次保证 | T1、T2/T3 交付组 / Task 自主构造指导 |
| G11 | 根 objective/AC 入口过弱；上下文传递缺根目标、祖先决定来源与新鲜度；根目标错了时全局传播不能补救。**A0 已实现、Q2/Q3 返工已关闭（§5.11、§5.13）**：根任务延迟到真实用户目标/AC 被接受后激活，graph name 不再进入 objective，缺独立顶层判据具名拒绝；根契约的来源与归属由统一服务入口机械校验（store↔session、顶层会话、会话自身日志的本人消息；不可读即具名拒绝），本运行时提示词不再冒充人类输入，`adoptRoot` 无根时经既有恢复遍完成恢复；A1 的上下文投影（根目标/硬约束与本人契约/贡献的来源化呈现）已随第 9 项提交实现，Q1–Q4 定向返工与 [Q3 收尾](history/2026-09-25-a2-a1-q3-closure-record.md)完成，整组已验收（§5.15），「模型对用户请求的解读是否正确」的通用语义证明仍未建——机器准入只管结构、判据种类与来源归因；R1 的真实场景证明答复送达，且完成轮 3 在冻结合同下把该场景判为 `pass / path2-limited-goal`（§5.14 完成轮记录）；三条契约边界（假设不得替代确认、缺失条件先问用户、契约只承载答复支持的内容且判据须可裁定）已落在根 prompt / `task_intake` 说明。通用语义证明仍不在机器准入范围内——一次场景通过不等于普遍澄清能力 | A0（返工关闭）→ A1 |
| G12 | 父同步等子的循环等待已由 A3 解除（§5.9：分解立即返回 batchId、waiting_children 运行时写闸、显式提交、无进展停止，idle 不再等同执行结束）。持久 question/answer 与问答等待已接线；A4 的同一 Session/Run 冷恢复、组合故障与恢复期唤醒顺序（屏障 ready 后才投递/唤醒）已验收（§5.16）。未添加 ask_parent 之外的通用消息框架，send_message 仍未开放 | A3（已交付）→ A4（已验收） |
| G13 | A2 已提交 related/graph 分页视图与原始 Session 工具封闭；分页停滞（Q4）、Session 大事件不可续读（Q3）与绑定失败放行（Q1）的返工均已关闭并有正/反例证据，整组现已验收；动作是否可执行仍由 runtime 重检。reviewer 跨图因果 debug 属 A5 | A2（已验收）/A5 |
| G14 | root/worker prompt 与当前方向有漂移：L4/manual、直接问人、make command exit 0、分解意图矛盾；未来工具必须随真实协议接线再写入提示。**R0 已关闭工具面的漂移部分（2026-09-23，已验收，§5.11）**：allow-list 与 prompt 由同一开关布尔派生（off 时提示词不含进化协议段、工具面不含九个 `evolution_*`），并新增根 intake 段（`task_intake`、未激活视图、审核策略、激活前不得 `task_decompose`）；其余角色模板（A1–A6）仍逐票同步 | R0（已验收）→ A0–A6 逐票同步 Prompt 合同 |
| G15 | 根工具无条件暴露进化链、通用 prompt 混入 BB 指导；runtime 职责集中，未使用接口/仅诊断摘要易被误读为完整保证；缺真实模型运行反馈。**R0 部分关闭（2026-09-23，已验收，§5.11）**：进化链改由装配开关决定是否注册（off = 只注册 19 个常驻工具，on = 28 个，与之前逐名相同），BB 句子从通用 root prompt 移除、领域指导归部署的领域 skill；不新增主管、不合并审批。R1 已补真实运行反馈并于 2026-09-24 验收（完成轮 3 为 `pass / path2-limited-goal`，失败轮次保留）；**R2 已关闭「未使用接口/仅诊断摘要」部分与取消写闸返工（Q1，§5.12）**：`evidenceByVerifier` 无消费者已撤回；`templateDigest` 标明仅诊断、无身份保证；三个无消费者导出（`TaskProposalKind`/`TaskProposalDecision`/`TASK_PROPOSAL_ID_PREFIX`）收回；取消进行中的写闸不再被只读查询/协调读解除，跨取消完成点的陈旧读取也被闸的决定计数丢弃（`closingStores` + `applyStorePhase`，两轮交付 `250a04f`/`8f9086e`）。仍待：runtime 职责集中（drivers 推状态模型）按证据保留、不预定 pull 化；§5.12 记的四项既有取消边界（spawn 续跑、另两条 store 派生写相位入口、`closingStores` 非重入计数、`unload` 无 store 记录）未修。R1 的 V5 ledger 将缺失 cache-write/usage 记为未报告，但完成轮 fixture 的 `driver.json/run-meta.json` 历史 `0` 已披露为 caveat，未来轮次须修自己的 driver 副本；三次生产修复落在根 prompt / `task_intake` 说明。一次通过只证明该固定场景，不冒充效果验收或普遍澄清能力 | R0（证据保留）+ R2 Q1（已关闭）+ R1（已验收） |

历史记录中的 M1–M9 为此前会话的实跑声明，保留于历史指南。本次回归结果见建设计划 S0；本次没有重跑 LLM、BB 构建仿真或生产 Evolution 链路。旧环境可用性、外部 bbdev 缺陷和部署阈值在使用前需重新读取对应部署，不能从旧日志推断当前状态。

各票的实现范围与剩余边界见上表及 §5；提交、日期和实跑证据查[历史执行记录](history/2026-09-24-vrtc-execution-records.md)。P4 原交付与后续修复须分别读取。当前已接线的机械保障不代表问答语义正确性、自然语言完整性或自主修复已完成；A4 收尾返工（恢复期唤醒在屏障 ready 后）已通过[进度审核](history/2026-09-26-a4-final-review.md)。

## 5. 实现时的关键约束

### 5.1 验收先于自动生长

P4 `f6886cf` 的完成声明经复核发现三个组合路径漏洞，后续已修复 replay 输入检查、子 heuristic 引用及自定义 verifier 绕过。交叉路径正反例见 `tests/integration/parent-acceptance.spec.ts`，修复验证记录见[历史执行记录](history/2026-09-24-vrtc-execution-records.md)。原提交的历史结论不作为当前验收证据。

现有 command verifier 与 worker 共享 checkout：外部进程运行命令只提供执行分离，不保证 worker 无法修改测试、脚本或阈值。建设目标是固定验收输入的来源与版本，保护判据，记录 verifier 版本及证据产物身份；自述 JSON 和退出 0 均不能单独证明领域正确性。

**父级验收与证据身份已落地（2026-09-21 P4，S1-V 切片 1+3）**：父 AC 用可选字段 `childEvidence` 声明“需要哪些子任务的哪条判据/哪类证据”——子任务按**该 Run 已准入批次累积成员的 0 基稳定位置**指向（K1 起；`dependsOn` 仍是批内索引，两套词汇不混用），可再窄化到子判据 id 与证据引用（evidence id / artifact kind / artifact id 三种拼写），composite 在父验收期对照 store 校验该映射真实存在且证据来自子任务的 verified run，不完整则拒绝并在 reason 逐字点名缺失项；缺省（无映射）完全保持现行“子全 verified”合取行为。独立父级组合检查有两条可机械执行的形式：映射断言本身，以及父 AC 的确定性 `command`（接口/数值级判据，子全 verified 但组合错误时父必须拒绝）。`heuristic: true` 标记的父 AC 是自然语言条款：verdict 显式带 heuristic 标注，且不计入确定性通过。`requiresArtifact` 收紧为“已验证参考产物”（产出 run 终态 verified 且 bundle 带 pass 判据），原始输入改用 `acceptsArtifact`（存在即可，任意 run 状态）；契约级标记 `requiresIndependentAcceptance` 要求映射存在，新建/分解路径 admission 对映射缺失/被删/形状畸形响亮拒绝，不静默降级为合取；replay 路径与普通分解共用同一校验规则。

范围边界：映射按 Run 累积成员位置指向，不做通用自然语言蕴含求解器，也不做 C3 假设满足性的完整证明（只做映射指向存在性的结构检查）；verifier selftest 正负样本的实际执行与声明式输入身份固定已由切片 2 落地（见 §5.7），证据来源真实性认证、blocked 缺产物后的自动恢复（S2-R）均未建；**未声明保护范围的输入不受保护**（这是边界，不是“已保护”）。旧任务（无新字段）读取、回放、验收行为不变；`requiresArtifact` 的收紧对旧声明同样生效——失败 run 的同名产物不再满足依赖，这是本票的修复点而非兼容性破坏。另有三个已知边界如实记录：replay 任务按设计无父无子，携带 `childEvidence` 映射的候选契约失败关闭（当前 replay 不存在“能通过”的父级映射表达）；`evidenceRef` 的三种拼写只匹配 `EvidenceBundle`（evidence id / artifact kind / artifact id），真实链子上 `TaskRun.artifacts` 恒空，匹配不依赖它；composite `entryDefect` 的逐条目子任务状态检查位于“子全 verified”合取闸门之后，当前调用路径下不可达，属防御性分支（未验证子任务由合取闸门拒绝并点名）。

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

S4-E 已接线报告身份与 observed/holdout 非退化检查及可比较执行，合同见计划 F.2；生产提交与完整 Skill 单位修正见 K2/K3。

### 5.6 统一规范化契约（2026-09-21 T1）

`TaskContract` 和 `normalizeDecomposition` 已统一普通分解、replay 与根契约的结构准入、内容身份和持久化；模板命中不是生成前提。

### 5.7 验证器自测与受保护验收输入（2026-09-22，S1-V 切片 2）

注册时执行 verifier 正负自测，判决记实际注册版本；已声明的受保护输入在准入和判决时核对。未声明输入与证据来源真实性仍不受此机制保证。

### 5.8 能力预检与版本绑定（2026-09-22 S1-C）

provider 预检、侧车契约、统一校验和 Run 级内容绑定已交付。R3 将侧车规则迁至 `task-runtime/src/skill-contract.ts`；已有 Skill 的完整对象同名改进（含执行型 sidecar）已由 K3 验收（§5.20），效率优势未由实验确认。

### 5.9 非阻塞运行与恢复（2026-09-22 A3）

A3 已交付非阻塞批次、执行相位、工作区写入归属、显式提交、取消/恢复和根预算。父子持久问答与问题阻塞已由 A4 交付（§5.16），合同见计划 F.1。

### 5.10 契约审核与恢复（2026-09-23 T2+T3）

生成契约的 `off/all` 策略、提案身份、批准后重检及崩溃恢复已验收；根契约来源与恢复的 A0 返工见 §5.13。

### 5.11 根入口与默认运行面（2026-09-23 A0/R0）

根任务由真实输入经 `task_intake` 接受后激活，并有独立验收判据；默认工具装配已收敛。原来源归属和 `adoptRoot` 缺陷已由 §5.13 关闭。

### 5.12 按证据整理运行时（2026-09-24 R2）

取消窗口内读取及跨取消完成点的陈旧读取均不能重开写闸，Q1 已验收。其余取消边界仍以 §4.2 G15 和历史记录为准，不能把本票扩大成全部竞态安全证明。

### 5.13 根契约来源归属与恢复入口（2026-09-23 A0 返工）

统一服务入口校验 store↔session、顶层会话及本人用户消息；`adoptRoot` 无根任务时先恢复已存提案。Q2/Q3 已验收，具体反例与兼容记录见历史执行记录。

### 5.14 R1 补验证（2026-09-24）

完成轮 1、2 为 fail，完成轮 3 在冻结判据下为 `pass / path2-limited-goal`，独立复核通过；这只证明该固定场景。历史失败轨迹、语义重判和缺报口径保留在历史执行记录，旧 fixture 的缓存写 `0` 不可当作已报告用量。

上述切片的源码/测试锚、原始边界与逐轮证据见[本指南旧实施细节](history/2026-09-24-guide-implementation-records.md)和[执行记录](history/2026-09-24-vrtc-execution-records.md)。

### 5.15 A2+A1：Agent 状态上下文（2026-09-25，审核返工 + 定向返工 + Q3 收尾，现已验收）

实现方提交了 `4a510ed`（显式恢复屏障/纯读拆分）、`f90d05b`（`context` 包读取核心）、`0f41d91`（装配接线/工具适配/迁移删除/旁路封闭）、`6e0f651`（其独立复核缺口闭合）。下列为已提交代码的范围，**不表示 A2-1～A2-6 已验收**；[进度审核](history/2026-09-25-a2-a1-progress-review.md)的可达反例覆盖了原交付声明。

**定向返工（`bee6a96` + 复核响应 `6ae5aa0`）**：Q1/Q2/Q4 关闭、Q3 的“中途失败不得伪装成功”关闭，逐项红/绿证据与最小合同冲突见[返工记录](history/2026-09-25-a2-a1-rework-record.md)。修复后的当前事实：

- **绑定失败 vs 域外会话**：`context/src/bindings.ts` 的 `CallerUnbound` 带 `placement`。只有“任何图都不发布且无委派记录”是 `outside`（原行为：不注入、原样组装）；graph 查询异常、域 store 不可读、ledger 冲突/不可读、委派无法落图都是 `failed`，`context/src/assembly.ts` 对其抛出以 refusal 命名的 `AssemblyRefusalError`，模型输入为零（`tests/integration/context-binding-zero-input.spec.ts` 用真实 loop 与计数 adapter 证明）。注册表的“无图发布该会话”事实由 `graphs/src/index.ts` 的 `SessionNotInGraphError`（`SESSION_NOT_IN_GRAPH`）区分，读失败不再被读成“没有图”。**store 报“不存在”时**按图 store 自己的 `spawn` 边区分：被本图 spawn 过的会话（其 run 记录在 spawn 时就写在该 store）判 `unreadable`，未被 spawn 的成员保持计划 D 节的成员放行，root 保持 `not-activated`；边读取失败则失败关闭（独立复核发现 1）。
- **委派者归属**：reviewer 的 ledger 行只有在被委派 graph 的成员表里确实发布该行 `actor` 时才成立；他图 actor → `cross-graph`，未知 actor → `unbound`，成员表读失败 → `unreadable`（`bindings.ts` 的 `delegatorStanding`）。合法同域委派者仍拿到整域（正例保留）。
- **Session 页（Q3 收尾后）**：第二窗口之后的读失败返回具名 `unreadable`，不返回局部成功页；整块事件先量后加。列表首事件放不下仍是具名 `context-too-large`，但会给出该事件的 `ref:{"sessionId":"…","seq":N}`；按该引用读取时页面是含 `sessionId,seq,offset,nextOffset,hasMore,body` 的 JSON，`body` 是该事件可见正文（`extractSessionEventText`）的 UTF-8 字节片段，尾页说明列表续读 `offset=seq+1`。上界 50000 字节含 JSON 转义，字节窗口与省略措辞复用 `@deepseek-ai/dsh-output-retention`；具体边界与验收以[计划 D 节](2026-09-20-vrtc-code-change-plan.md)与[Q3 收尾记录](history/2026-09-25-a2-a1-q3-closure-record.md)为准。拒绝分两道门且都不读日志：违反声明形状的调用（`seq` 非整数、`sessionId` 非字符串、`ref` 不在已声明形状内）由 DSH typed-tool 门以 `invalid arguments` 点名参数拒绝，读核从不运行；通过声明类型的非法数值与引用由读核按八词表具名拒绝。工具 schema 不为把前者改写成本包词表而放宽（2026-09-25 第二轮审核应答，见同记录）。
- **状态页**：首条目放不下时具名 `context-too-large` 并给 `context_read` 引用与 `offset+1`，不再返回“同 offset 且 `hasMore: true`”的停滞页；排序、`nextOffset = offset + shown` 与越界空页语义不变。

**Q3 复审裁决（已验收）**：`context_read` 保持四参数；`ref: sessionId` 按事件 seq 分页，`ref: {sessionId,seq}` 按单事件正文 UTF-8 字节分页。每页先核对真实调用者的 graph 与目标 Session 成员资格，再由 DSH `readEvent` 取源；按 `nextOffset` 可还原全文。复审时只能拒绝或跳过超长事件；当前按[计划 D 节](2026-09-20-vrtc-code-change-plan.md)和[收尾 prompt](execution-prompts/09-a2-a1-q3-closure.md)交付，整组已复验并验收（[Q3 收尾记录](history/2026-09-25-a2-a1-q3-closure-record.md)）。

- **绑定与读取域**：`context/src/bindings.ts` 从持久事实解析调用者（已发布 graph 成员 + 持久 `TaskStarted`；reviewer 经注入的窄 `ReviewerBindingSource` 核实现有 ledger），不读 runtime 的内存绑定缓存；读取域=当前 graph，跨 graph 具名拒绝（`cross-graph`/`not-found`/`unbound`/`binding-conflict` 等 8 个具名结果词表在 `context/src/refusals.ts`）。
- **三工具一面**：`task_read({})`、`task_status({scope:related|graph,offset,limit})`、`context_read({kind,ref,offset,limit})` 由 agent-singularity 薄适配，共用 context 读源。`ref:{sessionId,seq}` 单事件分页和 `CONTEXT_OUTPUT_LIMIT_BYTES = 50000` 属 Q3 收尾合同；上限与部署的 DSH spill 策略对齐，核心契约超限仍具名 `context-too-large`，不可静默裁剪。
- **装配**：`context/src/assembly.ts` 的 scoped `system-prompt/assemble` 监听把不可变半（根简报+契约+handoff）注入 `singularity:worker-contract` section（order 80，压缩存活），动态半注入 runtime-context 平面（`singularity:state`），重复装配不累加；诊断性组装（无 agent）与 graph_spawn 普通代理不注入。root 已接受契约同样注入；reviewer 注入委派目标契约（review-only）。
- **旁路封闭**：四个原始跨 Session 工具（`session_event_read`/`session_event_trace`/`session_trace`/`session_search`）自各角色有效工具面移除，并由 `agent-runtime/src/raw-session-guard.ts` 在 createRoot/resumeRoot/spawn 三处安装 `tools.guard` 单调执行拒绝；worker/reviewer baseline 与 gate 白名单同步收口，root allow-list 增加 `context_read`。
- **迁移闭合**：`renderWorkerPrompt`、`task-runtime/src/contract.ts`、`contract-reinjection.ts`、runtime 侧 `renderRunBinding`、`root-store.ts`、`run-phase.ts` 已删除；runtime 保留执行绑定校验（`bindRunProviders`/`readRunBinding`）、持久 handoff（`buildHandoff`/`recordHandoffIn`）与恢复闸；`SpawnRequest.contract` 移除，`taskWorker`/`beforePrompt` 进入 spawn 合同。
- **测试锚**：`tests/integration/context-assembly.spec.ts`（三层链/域隔离/压缩重启/replay/reviewer/零副作用 + 返工新增的绑定失败三例与委派者归属一例）、`tests/integration/context-binding-zero-input.spec.ts`（真实 loop 的零模型输入两例）、`tests/integration/context-read-limits.spec.ts`（工具门的 Q3/Q4 三例）、`tests/integration/context-read-single-event.spec.ts`（单事件逐页还原、拒绝矩阵与平台形状门六例）、`worker-contract.spec.ts`（真实 SystemPromptProjection 与 RuntimeContextProjection 去重）、`cancellation-gate.spec.ts`（R2 反例保留，第 2 例锚定恢复屏障）、`context/tests/unit/*`（绑定/读取/界限/副作用；返工新增 9 例绑定与 5 例 Session/状态页用例）。证据、未覆盖范围（D3/D5/D8/D9 等）与独立复核结论见[交付记录](history/2026-09-25-a2-a1-delivery-record.md)；返工红/绿证据与合同冲突见[返工记录](history/2026-09-25-a2-a1-rework-record.md)。

**进度审核阻断（全部关闭）**：Q1（绑定故障放行）、Q2（委派归属）、Q3（中途读取失败与超限单事件续读）、Q4（状态分页停滞）均已关闭并有正/反例证据。详见[最终进度审核](history/2026-09-25-a2-a1-progress-review.md)、[返工记录](history/2026-09-25-a2-a1-rework-record.md)与[Q3 收尾记录](history/2026-09-25-a2-a1-q3-closure-record.md)；整组已验收，下一项为 A4。

### 5.16 父子持久问答（2026-09-26 A4 已验收）

已接线范围：直属父子问答 `task_ask_parent({requestKey,question,blocking?})` / `task_answer({questionId,requestKey,answer,resolves})`，经真实 DSH Session/inbox 投递与冷恢复续跑；阻塞只作用于对应 Run 和问题，不新增预算、mailbox、消息框架或回答分类器。恢复期的唤醒（问答投递与 owner notice）在屏障 ready 之后才发出。[交付记录](history/2026-09-25-a4-delivery-record.md)、[返工交付](history/2026-09-26-a4-rework-record.md)与[唤醒收尾](history/2026-09-26-a4-barrier-wake-record.md)保存实测证据；[最终审核](history/2026-09-26-a4-final-review.md)给出验收结论。

- **事实（task）**：`QuestionAsked`/`QuestionAnswered` 两类事件只持久 question/answer 稳定身份（`q-`/`a-` + 内容哈希）、双方 Run、正文引用 `{sessionId,seq}`、messageId、requestKey、内容 digest 与 blocking/resolves；**不存正文**。`questionId` 按 (childRunId, requestKey) 派生：同 key 同内容返回原记录、异内容具名拒绝零副作用。`TaskSnapshot.questions` 供纯派生（`openQuestionsOf`/`blockingQuestionsOf`/`questionsAwaitingAnswerOf`）；open = 无 resolving 回答且双方 run running。旧空 `pendingQuestionIds/blockingQuestionIds` 声明保留可读、新写入停止（`changeRunPhaseIn` 具名拒绝），决策 `same-version`（[persistence 记录](persistence-changes/2026-09-25-a4-questions.md)）。入口 `task/src/index.ts:askParentQuestionIn/answerParentQuestionIn`、领域模块 `task/src/question.ts`。
- **投递（agent-runtime）**：`messages.ts` 是唯一主体。正文来源 = 发送 Session 真实且已 flush 的 `tool/call`（先 `ctx.sessions.flush` 再 `sessionQuery` 读回，伪造/他 Session/篡改在 task 意图落库前具名拒绝；digest = sha256(arguments 原文)）。消息自建 `freezeMessage` + `{kind:'agent-message',form:'relay',senderSessionId}`（不伪装 human，零 DSH 改动）；顺序固定：来源 flush → task 原子提交 → `steer` 投递 → 收件 Session flush → 报 delivered。同 messageId 幂等：pending 撞 DSH `already pending` 或 fold 命中 history 即 `already-present`（fold 照 agent-team 算法，不依赖实验包）；目标不 live 记 `unavailable` 零副作用、保留意图由恢复入口重试。delivered ≠ 已消费。
- **阻塞与恢复（task-runtime）**：编排入口 `askParentQuestion`/`answerParentQuestion`（`index.ts`，身份只取 live caller + run 绑定 + store 父关系）。闸新增 per-session 阻塞态（`setQuestionsBlocked`，非相位）：阻塞会话只放行协调动作；waiting_children 相位规则不因问答改变。闸在 ask、resolving answer、恢复重建和被问方终态后重算（`releaseAskingSessions`）；active+阻塞免无进展标记，原截止继续生效。冷恢复已接回问答等待的 active worker 与有问答参与的 waiting_children 非根父的同一 Session/Run，并对账受管理工作、重建 gate、补投持久问答；被收养等待有原 deadline，失败具名结算，无问答在途 run 仍按 A3 旧规则取消。**唤醒顺序**：`reconcileStore` 的「投递 + 未 claim notice」块与恢复期根激活 notice 不在屏障 `recovering` 时执行；它们登记为 `StoreRecoveryState` 上的延迟动作（仅进程内），`adoptRoot` 在 gate 初始化与 ready 之后（release 之前）按序发出；屏障 ready 前取消或失败即丢弃。意图始终在 Task 持久事实里，下一次显式激活重跑同一决定。无屏障的直接 `reconcileStore` 调用语义不变。A4-5 的结算所有者保持原实现。
- **呈现（context）**：`singularity:questions` runtime-context（worker 与 root 均接线）：父视角列待答问题（id/子 run/ref/`task_answer` 指引），子视角列未证明看过的回答（消费证明 = 本人 Session history 存在该 messageId 的 `user/message`，无证明保留引用，不建 consumed 账本）；正文经 `context_read` 按 ref 读取。active+阻塞显示 `waiting_answer`（纯派生）。重复装配字节稳定、零写副作用。
- **工具（agent-singularity）**：`task-ask-parent.ts`/`task-answer.ts` 薄适配（身份 `exec.agent.id` + `exec.callId`，未声明键具名拒绝，schema 无收件人/授权字段）；worker baseline 含两者，root 仅 `task_answer`，reviewer 白名单不含即关闭。
- **顺带修复**：replay 工作区层补 taskId，使 replay 内真实 `task_decompose` 及「replay 中真实 Task 父子问答」正例走通（前置 A3 缺陷，红绿证据见交付记录）。
- **已知边界**：replay driver 自身的跨重启续跑属 A6/S2-R（replay 树内真实父子的问答恢复已覆盖）；全体 worker 的热恢复不泛化（S2-R）；阻塞确立时已放行的同 step 在途写仍按 A3 相位语义处理；A4-3 点2「入箱未 flush」以移除 artifact 尾部字节模拟（真实 append-through 后端无法自造该状态）；审批渠道在恢复中重发问后由人/渠道记录的决策若在 store ready 前到达仍被具名拒绝、提案保留 `pending_review`（人/渠道自己的写入口，非 runtime 唤醒，见收尾记录）。屏障内提前唤醒已由[收尾返工](history/2026-09-26-a4-barrier-wake-record.md)关闭并[验收](history/2026-09-26-a4-final-review.md)。屏障取消前的延迟动作会丢弃；ready 后已开始的投递与普通取消并发时，业务闸仍负责拒绝取消后的写入。

### 5.17 S4-E：双侧评估基线（原范围已验收）

生产替换后记账的崩溃缺口已由 K2 修复并验收（§5.19）；完整执行型 Skill 更新已由 K3 验收（§5.20）。以下保留基线交付事实，其中"格式"一段已被 K2 的 formatVersion 3 切换取代（并被 K3 的 formatVersion 4 再取代，见 §5.20），其余不能作为这两项已完成的证据。

[首次进度审核](history/2026-09-26-s4-e-progress-review.md)指出 Q1～Q4；[返工交付](history/2026-09-26-s4-e-rework-record.md)修复了部分路径及一处批次受理截止竞态。[返工复审](history/2026-09-26-s4-e-rework-review.md)列出四处问题；[收尾交付](history/2026-09-26-s4-e-final-closure-record.md)删除 v1 replay 主体、实验时限并补显式裁判。[独立审核](history/2026-09-26-s4-e-final-closure-review.md)以七条红反例发现边界未闭合；[定点返工交付](history/2026-09-26-s4-e-final-closure-rework-record.md)关闭七条反例；[最终复审](history/2026-09-26-s4-e-final-closure-rework-review.md)修正模型可见拒绝文案和 champion 字节快照后验收 EVAL-1～EVAL-5。

`evolution` 包（`packages/singularity/evolution`）是候选、实验、决定、应用、回滚及 ledger 的**唯一行为所有者**；`agent-singularity` 只装配服务和保留九个 `evolution_*` 薄工具适配（schema/调用身份/人审/呈现）。迁移删除旧主体与同名转发（`agent-singularity/src/{evolution,replay,config-edit}.ts` 及 `src/index.ts` 旧再导出），`repoRoot` 改为显式注入。依赖方向保持 `agent-singularity → evolution → task-runtime/task`，task-runtime 零导入 evolution（仅注释提及）。

- **双侧实验接线**：`evolution_replay` → `EvolutionService.runExperiment` → `replayTask(workspace, agentOptions)`，两侧各创建新 Run。`experiment_started` 记录冻结块（样本/契约/受保护输入/快照 digest、结构化模型选择、裁判身份与版本、provider 基线、预算、比较器版本），`experiment_sample` 逐侧记录 run/review/evidence、工作区与初始快照 digest、成本（reported/unknown，不填 0）。每侧 spawn 携带冻结的 agentOptions（子执行同绑），冻结后改部署默认不再影响在跑实验；快照经链接策略遍历（逃逸/循环/不可读具名拒绝，根内链接物化为每侧私有副本），摘要覆盖实际内容。
- **预算**：实验唯一上限是可选的 `maxTokens` 总额，按 ledger 逐侧累计，耗尽不启动下一侧，`decide(PROMOTE)/apply` 经同一个 `checkPromotion` 拒超额/缺指标。实验级 `wallTimeMs`/`durationMs` 已整条删除（含跨层传递与 `runDeadlineMs` 第 5 参）；Run 的时间限制只剩既有 `rootBudget.wallTimeMs`（配置了才生效）与 `Config.budget.wallTimeMs`，未配置就不声称实验时间上限。`gate` 只记录六项回答与证据引用，超额实验可留 gated 审计事实，但 gated 不是晋升通过。未声明 token 上限时 unknown 仅作观测，不推断为零。
- **晋升闸接线**：报告字节重算、store 证据回读、内容/生产基线检查保留；历史 verified 样本本次基线失败会 inconclusive，模型按实际 Session 请求头核对，provider 绑定按实际 Run 核对。进入实验的每条 AC 必须显式 pin 已注册且声明版本的 `verifierRef`——缺 ref、ref 未注册或无版本在冻结前具名抛错（零落账零 Run）；冻结 `@1` 后首次 Run 前换 `@2` 不得晋升。普通 Task 的 mode 派发不变；非 Skill 提案在 candidate 即具名拒绝，两次 DSH 人审及 apply 重检保留。
- **旧请求清理（已闭合）**：`runReplayExperiment`、`EvolutionService.replay`、`replayed` 状态与记录、v1 报告主体、capability/agent_preset 执行器已删；`evolution_propose` 对非 Skill 建议的成功返回只说明已记录与当前支持范围、不给 `next:`，`evolution_list` 不再宣传无 mutation 直达 gate，prepare/apply/rollback 不再宣传新建 Skill 或人手编辑生产。candidate 在服务与工具 schema 双层要求 `mutation: {name, content}`；prepare 在任何 sandbox/ledger 写前确认生产 SKILL.md 存在，同一次读取的原始字节用于 champion 快照及基线摘要，缺文件的拒绝不指引手工创建生产 Skill；fold 只接受当前可写形状（非 Skill 仅 proposed、candidate 必有 Skill mutation、prepared 必有已捕获基线与内容身份、decided 必有人审引用）。普通 Task replay、根时限及当前 `SKILL.contract.json` v1 侧车不受影响。
- **格式（S4-E 基线）**：Evolution ledger 只读写 `formatVersion: 2`：load 逐行拒绝 v1/无版本/混合，`append` 漏斗与 `recordExperimentStart`（含幂等成功返回之前）在持久写前以同一判据拒绝旧版本记录，账本字节不变。无双格式 reader/在线迁移/回退 helper。现场旧账（21 行 v1，applied 均已回滚，另有 `m2-prop-diag` 悬挂 decided）保持原字节未动，部署切换由操作方归档后从空的新账启动。详见[持久化说明](persistence-changes/2026-09-26-s4-e-experiment-ledger.md)。（2026-09-27 K2 更新：现行格式已为 `formatVersion: 3`，v1/v2 同样拒绝；上述现场旧账已按原字节归档为 `proposals.jsonl.v1-archived-2026-09-27`，新账从空启动——见 §5.19 与[K2 持久化记录](persistence-changes/2026-09-27-k2-evolution-commit-intent.md)。）
- **测试锚**：`tests/integration/evolution-replay-experiment.spec.ts`（工具入口双侧+端到端晋升链+幂等+非 Skill 旧请求拒绝）、`experiment-runner.spec.ts`、`replay-workspace.spec.ts`、`replay-execution-binding.spec.ts`（含 replayTask 旧选项写前拒绝）、`s4e-q3-freeze-binding.spec.ts`、`evolution-tools.spec.ts`（模型面真实成功/拒绝返回）、`evolution/tests/unit/{skill-promotion-gate,experiment,experiment-orchestrator,ledger-roots,ledger-version}.spec.ts`（experiment.spec.ts 内含账本写边界版本闸与 fold 当前形状两组定点用例）。旧路径测试改为公开入口拒绝，移除旧实现私有镜像测试。
- **边界**：确定性 fixture 证明协议，不声称统计效果；分层指标/自动 Retro/多目标打分未建；真实模型效果实验需另有授权与预算（不属本票）；agentOptions/工作区的会话级传播是进程内机制，崩溃续跑不持有绑定（同 `replayLineage`，A6/S2-R）——闸的每侧实际请求核对是兜底；worker 自己 `task_submit_result` 与截止同刻落地由 store 先写者裁定（返工记录已注明）。

### 5.18 K1：子批次结束后继续探索（2026-09-27 已验收）

修正「Task 一生只能分解一次 + 子全终态后 runtime 自动提交父」对正常探索的限制。完整合同 [K1 prompt](execution-prompts/12a-k1-exploration.md)，逐项验收证据与删除清单见[交付记录](history/2026-09-27-k1-delivery-record.md)；同日返工（`d86c9fd`，见[返工记录](history/2026-09-27-k1-rework-record.md)）修正交还顺序、批次成员事实与两条替代证据。切片提交 `3738712`（task 事实）→ `c212c35`（driver）→ `2b424c9`（恢复/投递）→ `473c535`（工具/prompt/context/文档）→ `3ab5aac`（集成与 K1-1～K1-5 spec）→ `a17d0cc`（集成检查残留清理）。

- **批次结束交还执行权（不再自动父提交）**：子全终态后 `finishBatch`（`task-runtime/src/orchestrate.ts`）按固定顺序收口：先逐个确认子 Session 写入/受管理进程停止（drain 不确认则具名结算父 failed、不开闸、**不归还工作区**），再确认父自身写入停止（同一规则与拒绝），两次确认后才归还工作区层（batch 层保留到所有写入者确认停止），然后把父 Run 持久化 `waiting_children → active`（新合法边，载荷带批次身份；`task/src/service/state.ts`），gate 放行写但保留未决 blocking 问答的独立阻塞（批次结束不代答），最后向父 Session 投递批次结果消息。父随后读结果、继续工作、追加一批或 `task_submit_result`；只有父主动提交才进入父独立验收（composite/独立判据不变）。取消父/根与截止仍直接停止，并按既有终态清理归还工作区；终态父的迟到投递为 `skipped` 零副作用，绝不唤活终态。
- **批次身份与多批事实（task）**：`batchIdFor(parentRunId, proposalId)`（`task/src/proposal.ts:610`，形状 `b-<parentRunId>-<proposalId>`）是唯一拼写；提案消费与批次绑定仍在一次原子提交（`admitBatchIn`），重复 requestKey 回原提案/批次、异内容具名拒绝。`TaskProposalBatchConsumption` 增必填 `parentRunId`，`TaskDecomposed` 落 `batchId/parentRunId/proposalId`。同一 Run 同时最多一个未结束批次（只有 `active` 可分解）与一个待审/待准入提案（`inFlightProposalsOf`）；空批次拒绝零副作用；晚到批准重检 Run/提案/批次状态（已被别批占用标 `stale`，已 submitted/终态/有 blocking 问答具名拒绝）。固定 `b-<taskId>` 及一切按 taskId 猜批次的路径已删（`cancelBatch`/`awaitBatch`/`failBatch`/`parentBatchOf` 均经 store 批次事实）。
- **Run 级累积成员与 childIndex**：`TaskRun.batches` 按准入顺序累积各批成员，旧成员不覆写，历史成员另属其原 Run（`runMemberTaskIds`，`task/src/types.ts:516`）；父 `childEvidence.childIndex` 指该 Run 累积成员的 0 基稳定位置（composite 经 `runMembersIn` 解析，`verifier/src/composite-verifier.ts:25`），两批的批内 #0 互不混淆；`dependsOn` 保持批内索引，后批消费前批产物走既有 Artifact/Evidence 引用。既有强制判据、失败成员与无效证据不因新批次被过滤。批次内操作一律消费该 Run 记录的批次成员（driver 的 items、结束时的 drain/outcomes/`relatedTaskIds`、`blockUnstartedChildren`、`awaitBatch`/`redeliverBatchResult`）：Run 记录不含该批次或成员读取失败时具名失败，不回退父 Task 的全部历史子，也不以空结果冒充批次结束；`batchRecordIn` 区分 store 读失败与「批次未记录」并随记录返回成员。
- **结果投递与恢复（复用 A4 机制）**：批次结果 = 稳定身份 `m-batchend-<batchId>` 的投递意图，正文从 store 事实重投影，经 `ensureAgentMessageDelivered` 投递、fold 幂等（重复通知不重复消费提案/写产物/提交）；`redeliverBatchResult`（`task-runtime/src/index.ts`）供恢复重投，`owedBatchResults`（`orchestrate.ts`）派生欠投。`reconcileStore`：waiting_children 且批次记录可查→重建 driver（同批只执行一次）；查不到（旧 `b-<taskId>` 在途批）→具名 cancelled 不猜归属；`active` 且 `batches` 非空的已交还委派父→工作区接管门后 `resumeAdoptedWorker` 恢复同 Run/Session 并补投（不走「取消全部未提交 worker」分支）；无批次叶子 active 维持原取消分支。批次结束持久化前/后两个重开窗口普通与 replay 同规则覆盖（K1-4）。
- **预算与回归**：根 `maxRuns` 按 runId 记账跨批累计、批次准入预留、重开不重置（耗尽时后批具名拒绝）；工具描述/root prompt/context 投影已同步新语义并经全 src 清场复核（无自动父提交/一次性分解引导残留）；A4 问答与父独立验收回归随全量通过。
- **持久化**：[version-bump 记录](persistence-changes/2026-09-26-k1-multi-batch.md)——consumption 新必填字段与批次身份等式替换使旧 `TaskProposalAdmitted` 记录在本 build 重放时具名拒绝；无兼容 reader，旧在途批次停止使用。
- **测试锚**：`tests/integration/k1-exploration.spec.ts`（K1-1～K1-5 十六例）；改写回归：`a3-recovery`、`a4-question-recovery`、`a4-question-cold-recovery`、`parent-acceptance`、`coordination-tools`、`a3-coordination-loop`、`proposal-review`、`proposal-recovery` 等 18 个集成文件；单元 `task/tests/unit/{coordination,proposal,task-state}`、`task-runtime/tests/unit/{orchestrate,gate,proposal-lifecycle}`、`verifier/tests/unit/composite-verifier`。返工新增：`tests/integration/k1-graph-boundary.spec.ts`（K1-3 两 graph 真实 store/driver/verifier 的跨 graph 引用拒绝 + 正控；K1-4 委派父工作区接管失败的具名 failed 三例），多 graph 夹具复用 `tests/support/assembly-stack.ts`；单元 `orchestrate.spec.ts` 交还顺序三例（真实 workspace registry/marker + gate）与批次成员五例。
- **未覆盖项**：replay driver 根自身跨重启续跑仍属 A6/S2-R（本票只覆盖 replay 树内父子）；`settleRunFromRuntime`（run 级取消/恢复通用入口，无批次身份）的 `relatedTaskIds` 仍按该 Run 所属 Task 的子列表，未改为批次成员（保留理由见返工记录）；接管失败用例只证明具名 `failed` 分支与接管门差分——装配夹具的 spawned session 无持久日志，接管成功后的正向续跑不在该夹具可达（该路径由 `k1-exploration.spec.ts` 的 JSONL 重开窗口覆盖）。K2/K3/K4 的前置接口（批次身份、Run 累积成员、交还语义、幂等重投）已固定。

### 5.19 K2：应用与回滚可恢复（2026-09-27 已验收）

修正「apply/rollback 先写生产、后记账，崩溃后无法对账」。完整合同 [K2 prompt](execution-prompts/12b-k2-evolution-commit.md)，逐项验收证据与删除清单见[交付记录](history/2026-09-27-k2-delivery-record.md)，[独立审核](history/2026-09-27-k2-review.md)已通过。同日返工由独立审查定位四处：账本 append 未 fsync（意图可能丢失而生产已改）、`syncDirectory` 吞掉全部错误、可恢复来源在意图前未确认/未稳定、集成"崩溃"用例只是进程内异常却冒充进程退出；四处在同一票内按证据形态闭合，未改验收、未写成已知边界。同日复审返工（第二轮，复核确认的合同缺陷，K2 固定行为 3/4）：新 apply/rollback 若只管本 proposal 的未结意图，进程内串行并不阻止第二个 proposal 覆盖第一个未结提交——P1 意图落盘后中断时生产仍是旧内容，P2 自己的基线检查照样通过、写完成，P1 的意图随后既非旧也非新只能具名 `blocked`，目标被准入长期拒绝；现在新提交先按生产目标扫描其他 proposal 的未结意图并具名阻断（零行零写），对账结算后同一目标恢复可提交，目标不同的不误挡，旧 rollback 覆盖保护不变。

- **唯一提交入口（evolution 包）**：`EvolutionService.apply/rollback` 在人审与写前重检（晋升证据、P2 候选身份、P3 生产基线）之后，先把操作意图落盘为 `commit_intent` 行——绑定 proposal、方向、批准来源（`approvalRef`）、生产目标绝对路径、写前/写后内容身份（`baselineSha256`/`contentSha256`）与相对账本 root 的可恢复字节来源——再经同目录临时文件（open/write/fsync/close）+ 原子 rename + 目录 fsync 替换生产 `SKILL.md`（从不截断生产文件），回读校验摘要后才记 `applied`/`rolledback` 完成行（带 `intentId` 闭合意图）。写失败不记完成；临时文件不是已应用结果。实现集中在 `evolution/src/commit.ts`（`writeFileAtomic`/`commitIntent`/`reconcileIntent`），服务内单队列串行同一目标的重检、写入与记账，并在新提交（apply/rollback）写入前按生产目标阻断其他 proposal 的未结意图（`evolution/src/evolution.ts:assertTargetUncommitted`：命中即具名拒绝、零行零写；单进程约束，无分布式锁）。旧的 `writeProduction` 裸写路径已删除。
- **持久化顺序（2026-09-27 返工）**：意图/完成行不是"写进文件就算数"。账本每一行经唯一 durable append（`evolution/src/evolution.ts:appendLedgerLine`：open('a') → 写整行（write-all 语义）→ fsync 文件 → fsync 账本目录，含递归 mkdir 新建的整条目录链与其父目录；写失败把文件截回追加前长度，截回失败也具名说明），任一步失败具名抛错、不当作已持久；内存只在字节落文件后记账，与文件保持一致。意图落盘**之前**，它要命名的可恢复来源必须已稳定：来源经 `CommitHost.readSource` 重读重验摘要、限定在账本 root 内（越界或等于 root 具名拒绝），并 fsync 文件与**从来源目录一路到 ledger root 的整条目录链**（否则断电可留下"意图在、来源路径不在"）；做不到就具名停止——不记任何行、不碰生产（`commit.ts:ledgerRelative`/`syncSource`/`sourceDirectories`）。目标同样在写入前 confine。production rename 之后的目录 fsync 失败不再被吞：具名抛错、意图保留、不记完成；对账的"仅补账"分支先清该目标残留、再 fsync 生产目录、才记完成（`writeFileAtomic`/`syncDirectory`/`syncTargetDirectory`/`sweepStaging`）。
- **对账（启动/恢复）**：`EvolutionService.reconcile()` 对每个开放意图：生产仍是写前内容 → 补做同一操作并记完成；已是写后内容 → 先把生产目录 fsync 稳（"完成"是"生产已持久持有该内容"的声明，rename 的持久性只来自这次目录 fsync），再**仅**补完成记录，该 fsync 失败就具名停止、不记完成（生产字节一字节不改）；缺失、既非旧也非新（第三方改动）或来源不可验证 → 具名停止、意图保留、零写，绝不覆盖第三方变化。同一意图重试/重启只得到一条完成记录（fold 拒绝无意图/不匹配/重复完成）。宿主接线：`SingularityAgent` 启动（与 `evolution` 工具开关无关）与 task-runtime `adoptRoot` 恢复屏障（graph 激活前）都先对账；blocked 不阻断接管，由准入闸守住目标。
- **准入阻断**：`precheckProviders`（task-runtime，三个真实准入点共用）软读 evolution 的开放意图目标表，命中候选的 `SKILL.md` 路径即具名拒绝（`commit-intent-open`），只阻断受影响目标，不禁止读取诊断；evolution 服务缺失无闸，服务不可读 fail-closed（`commit-ledger-unreadable`）。已绑定 Run 的版本不变（绑定快照机制不回退）；`evolution_list` 透出开放意图且查询零写。
- **rollback 收紧**：只从本提案已应用的内容恢复——意图落盘前生产必须仍等于该提案写入的内容，后续提案已改变同一目标时具名拒绝且零写（两个 proposal 竞争同一目标时只有匹配当前基线者可写）。
- **同目标提交闸（2026-09-27 复审返工）**：新提交（`apply` 与 `rollback`）在同一进程串行队列内、写入任何行或字节之前，按**生产目标**扫描其他 proposal 的未结 `commit_intent`；命中即具名拒绝（点名目标、对方意图 id、归属 proposal，并写明零行零写与"先结算该意图"），使第二个 proposal 无法覆盖第一个未结提交（否则后者既非旧也非新只能 `blocked`，目标被准入长期拒绝）。目标不同的不误挡；本提案自己的未结意图仍走"结算/重试"路径；对账结算后同一目标恢复可提交。闸是进程内、按目标、单写者前提下的（未新增锁框架/队列/兼容分支）；修复前已写入的"同一目标两个未结意图"账本仍按序对账（见边界）。
- **格式**：ledger 单版本切换为 `formatVersion: 3`（新增 `commit_intent`、完成行必填 `intentId`），v1/v2 在 load 与写边界具名拒绝，无迁移/双读。现场 v1 旧账（21 行，applied 均已回滚）已按原字节归档（`proposals.jsonl.v1-archived-2026-09-27`，sha256 校验一致），新账从空启动。详见[K2 持久化记录](persistence-changes/2026-09-27-k2-evolution-commit-intent.md)。
- **测试锚**：`evolution/tests/unit/evolution.spec.ts`（K2 段：fold 不变式、四个崩溃窗口 ×apply/rollback 经 `Config.commitProbe` 注入后重开对账、篡改/来源丢失具名停止、只读目录真实写失败与恢复、恰好一次、竞争零写、复审返工两例：同一目标两个 proposal 同基线时第二个 apply 具名拒绝 + 结算后恢复提交 + 陈旧者仍被基线拒绝，以及 rollback 方向同拒绝且零行零写）；`evolution/tests/unit/commit-durability.spec.ts`（返工新增 21 例：来源→意图→rename 的持久化操作顺序（apply/rollback，含来源目录链与账本新建目录链的整组 fsync）、账本 fsync 失败/生产目录 fsync 失败/来源 fsync 失败/来源链某目录 fsync 失败/来源漂移/来源越界/目标越界/结算时清理失败各自具名零写、staging 残留清理（提交与"仅补账"结算两处，其他文件不动）、写失败截回与"截回也失败"具名、短写不落半行；fs 操作注入只替换 `node:fs/promises` 调用）；`evolution/tests/unit/ledger-version.spec.ts`（v1/v2 拒绝）；`agent-singularity/tests/unit/{evolution-commit-tools,startup-reconcile}.spec.ts`；`task-runtime/tests/unit/{provider-precheck,proposal-lifecycle}.spec.ts`（准入闸与屏障）；`tests/integration/k2-evolution-commit.spec.ts`（二十例：原十例崩溃窗口端到端/真实准入阻断恢复/工具 off 不旁路/篡改具名停止/竞争回滚/v3 重开后回滚 + 六例真实 SIGKILL 子进程在各窗口被杀的端到端恢复 + 一例"普通异常不是进程退出"对照 + 一例 env 门控的嵌套子进程用例 + 复审返工两例：第二个 proposal 在第一个未结意图下 apply/rollback 均具名拒绝（含真实 `evolution_apply` 工具入口同拒绝）、不同目标不误挡、结算后同目标恢复提交且陈旧候选仍被基线拒绝）。
- **边界**：保障只覆盖当前单文件 Skill 候选；K3 在同一提交机制上扩对象范围。故障证据分两层且互不冒充：**真实进程退出**＝嵌套 vitest（`--pool=threads`，env 门控）在指定窗口 `process.kill(pid,'SIGKILL')`，父测试看到 signal 与已死 pid（`ESRCH`），工作区留下只有真实死亡才有的 staging 残留；**进程内异常注入**＝`Config.commitProbe` 抛普通异常（`throwingProbe`），可 catch、`finally` 会跑、同一实例可继续对账，只作廉价窗口注入，不称进程退出。fsync 语义用确定性 fs 操作注入断言（只替换 `node:fs/promises` 调用，服务/账本/fold/驱动都是真的）；它不模拟断电与页缓存，模拟边界见交付记录。服务不可读时的准入 fail-closed 会影响该部署全部带目录的 skill 候选（具名 `commit-ledger-unreadable`），这是被要求的语义，不是缺陷。同目标提交闸本身是**按目标、进程内、单写者前提**下的判定：跨进程不排除（与既有单写者部署约束一致，`new EvolutionService` 在装配中只有一处）；**修复前已写入**的"同一目标两个未结意图"账本仍被 fold 接受并按序对账（先者按生产状态 redone/written，后者具名 `blocked` 并保留意图；第三方恢复写前字节后仍可再 redone）——本票只阻止新提交造成该状态，未改旧账读入规则。工具层不在人审前另设第二闸：`evolution_apply`/`evolution_rollback` 照常先问人审，拒绝由服务在提交门口给出（工具答案文本带 `rejected:`），零写零行。

### 5.20 K3：完整 Skill 改进单位（2026-09-27 已验收）

修正「执行型 Skill 带 sidecar，但候选只能改正文」。完整合同 [K3 prompt](execution-prompts/12c-k3-skill-unit.md)，逐项验收证据与删除清单见[交付记录](history/2026-09-27-k3-delivery-record.md)。交付前独立复核发现一处真实缺陷（task-runtime 恢复屏障的告警读取已删除的 `outcome.target` 字段，日志丢失目标路径）与两处覆盖缺口（屏障告警断言只验证 K2 形状替身、champion sidecar 篡改无直测），均已在票内闭合并补红绿证据。**2026-09-27 审查返工**（[返工记录](history/2026-09-27-k3-rework-record.md)）闭合两项可达缺陷：无 sidecar 的指导型生产目录里对象自身文件之外的文件（未声明资源、词表外条目）此前被 prepare 放过，现具名拒绝零写；rollback 与恢复入口此前只查意图所列文件，外部新增 `SKILL.contract.json`（角色漂移）或未声明资源时会先写正文、到写后复检才失败（留下开放意图与已改生产），现新增**提交前整对象写前闸**（1 文件 intent 用 loader 判定、2 文件 intent 要求目录条目恰为对象自身文件），新鲜提交写前抛错零行、恢复返回 blocked 零写。

- **改进单位=完整对象**：候选输入仍是 `mutation:{name, content}`（新 SKILL.md 完整正文，未知输入字段拒绝，模型不提交 sidecar 补丁）。prepare 经 `loadSkillSidecar` 冻结生产完整对象：无 sidecar 的指导型=仅 SKILL.md（原路径不变）；带执行型 sidecar 且 `content.resources=[]` 时=SKILL.md + SKILL.contract.json 两个固定文件——候选 sidecar 由生产 sidecar 只重算 `content.skillMdSha256` 派生（`task-runtime/src/skill-contract.ts` 的 `sidecarWithSkillMd` + `serializeSkillSidecar` 确定性字节），其他字段逐项保持，不借内容更新提权（伪造账本的提权路径由晋升门的推导一致性检查具名拒绝，有直测）。knowledge sidecar、任意资源、生产目录 loader 缺陷（含未声明文件）、角色转换（无 sidecar 变有/有变无）均具名拒绝零写；指导型没有声明可比对，`loadSkillSidecar` 扫描到的未声明资源与词表外条目此前会被漏过，2026-09-27 返工后同样在 prepare 具名拒绝（"冻结的必须是完整对象"）。
- **实验与晋升按同一完整身份**：champion/candidate 双侧各自加载完整对象（overlay 机制不变，沙盒含正文+派生 sidecar，run 绑定快照逐文件复证字节）；冻结块携带完整身份（SKILL.md 字节摘要 + sidecar 精确字节 sha256 与 canonical contractDigest）与**按侧** registryRevision（候选侧=生产 provider 列表换 digest 后经同一 `registryRevision()` 重算）；晋升门按侧比对 role/contractDigest/contentDigest/registryRevision，role 双侧必须等于冻结生产值（裁判与权限不随候选弱化），候选 contentDigest 从"豁免"收窄为"等于冻结候选期望"；报告 formatVersion 3，实验幂等键覆盖完整候选身份。
- **同一提交协议覆盖两文件**（不新建第二提交器）：一行 commit_intent 绑定固定文件集（1 或 2 个，定序 SKILL.md→SKILL.contract.json）各自前后内容身份与可恢复来源；逐文件原子替换+回读校验；全部写完后 `verifyCommitted`——生产目录经统一 `validateSkillProvider` 复检为可加载完整对象、role 与文件数一致、两文件字节与 contractDigest 对上该方向承诺身份（contractDigest 即 registryRevision 现算将吸收的身份，故记完成时 registry 视角已是新对象）——才记完成行。reconcile 逐文件分类 old/new/missing/other：全新仅补账、全旧或新旧混合补做仍旧的文件、任一缺失或第三方改动具名 blocked 零写；混合状态既被开放意图阻断准入、自身也不满足声明身份。记意图行前还有一道**整对象写前闸**（`CommitHost.objectWriteRefusal`，服务侧实现，2026-09-27 返工补齐）：1 文件 intent 用 loader 判定——目录多了 sidecar（角色漂移）、受支持资源位置上的文件、或不再是其文件声称的可加载对象即拒，词表外条目按 K2 钉定的容忍语义放行；2 文件 intent 要求目录条目恰为两个目标文件与各自 staging 残留（执行型声明的身份必须点名目录里每个文件），两文件一 old 一 new 的混合态放行；目录不可列同样报拒绝。拒绝对新鲜提交是写前抛错（零行零写），对恢复是 blocked（零写、意图保持开放、批次继续）。准入闸改为按目录阻断（`commit-intent-open`）。已绑定 Run 的快照与身份不热换。
- **格式**：ledger 单版本切换 `formatVersion: 4`（commit_intent 改 `files` 数组、prepared 记录完整身份、完成行 targets=全文件集），v1/v2/v3 在 load 与写边界具名拒绝，无迁移/双读；实验报告 formatVersion 3。现场无活动账本（K2 归档后新账为空、无未闭合意图/applied），切换无需处置对象。详见[K3 持久化记录](persistence-changes/2026-09-27-k3-skill-object-ledger.md)。
- **测试锚**：`evolution/tests/unit/evolution.spec.ts` K3 段（两文件 prepare/冻结、拒绝面、指导型未声明文件拒绝、P2/P3 完整对象漂移、伪造账本推导检查直测、champion sidecar 篡改、四窗口×apply/rollback 崩溃对账、目录不可列→blocked）；`evolution/tests/unit/{commit-durability,ledger-version,skill-promotion-gate,experiment,experiment-orchestrator}.spec.ts`；`task-runtime/tests/unit/{provider-precheck,skill-contract,proposal-lifecycle}.spec.ts`；`agent-singularity/tests/unit/{assembly,evolution-commit-tools,startup-reconcile}.spec.ts`；`tests/integration/k3-skill-unit.spec.ts`（K3-1～K3-5 全链：真实注册执行型 skill 旧败新过、九工具两次人审、两文件崩溃窗口+SIGKILL 真实退出子集、篡改/竞争/混合版本不准入；返工新增：指导型生产目录未声明文件 prepare 拒绝、指导型/执行型目录漂移的新鲜 rollback 与恢复重试写前拒绝）；`k2-evolution-commit.spec.ts` 等既有集成回归适配通过。
- **边界**（均为合同明确排除或既有约束，非本票缺陷）：其他资源、knowledge sidecar、角色转换、新增 provider、变更 verifier/capabilities/requiredTools 仍具名拒绝（A6 只增加 capability 行与新 provider，见计划 F.4）；单进程部署约束同 K2（无分布式锁）；真实模型效果实验不属本票，机制通过不声称技能已自主变好；`packages/singularity/tests/` 无 tsconfig 覆盖是既有状况。prepare 拒收词表外条目、提交写前闸按 1/2 文件区分容忍面（1 文件容忍词表外条目，2 文件不容忍）是 loader 语义的直接推论：guidance 无声明可点名，执行型声明的身份必须点名每个文件；两处差异见返工记录。

### 5.21 K4：复盘与执行预算分离（2026-09-27 已交付，待验收）

修正「原根截止同时封死事后学习与下一次尝试」。完整合同 [K4 prompt](execution-prompts/12d-k4-review-budget.md)，逐项验收证据、反例与删除清单见[交付记录](history/2026-09-27-k4-delivery-record.md)。

- **复盘不继承业务根截止**：`task_review_agent` 进入 gate 协调清单（`task-runtime/src/gate.ts`），终态/截止且 maxRuns 用尽的根会话仍可发起只读复盘；reviewer 调用链只核对自身每 store 次数额度（默认 1，`review-agent-ledger.ts` JSONL，重启不清零）与单次 watchdog，角色/读取域/真实来源校验不变，spawn 只写 graph `agent/add`+`edge/add`，无假业务 Run。触发策略与精确源协议仍待 A5 替换（latestReview 选源保留）。
- **唯一扩额入口 `task_budget_extend({requestKey, maxRuns?, deadlineAt?})`**（`agent-singularity/src/tools/budget-extend.ts`）：只在 root 工具面（worker/reviewer 面无），gate 全相位放行终态亦可调用；schema 闭集无批准字段，至少一维。流程：`budgetExtensionDraft` 零写查询（store、配置/有效上限、累计用量、已有记录或拟议值）→ 同 key 同内容直接回已有记录（不再审批）→ 新请求经 DSH 人审展示 store/原总上限/累计用量/拟改后总上限 → 仅 `allowed-once` 由 `extendRootBudget` 带 `approval:<callId>` 提交。maxRuns 是批准后总 Run 数正整数、deadlineAt 是绝对 UTC；只升已配置维度（未配置=无限，传该维即拒），拒绝/取消零预算事件零新 Run。
- **持久事实（task）**：`TaskBudgetExtended` 事件（`task/src/budget.ts`）保存 requestKey、内容 digest、各维 previous/next、批准引用与来源会话；`TaskSnapshot.budgetExtensions` 为唯一事实源。reducer 以 store+requestKey 幂等（同内容零效果、异内容具名拒绝零写），并在 store 串行重检请求基线==当前有效上限——同一基线两个批准只有一个能提交，不隐式重算。持久化决策 `same-version`（[记录](persistence-changes/2026-09-27-k4-budget-extension.md)）。
- **有效限额单一解析**：`resolveRootBudget` 每维取最后批准的绝对上限、无扩额用配置解析值，同时输出 configured 与有效值；批次准入/子 Run 启动/replay/在飞 watchdog/批次收尾五个消费点全部经此解析器，无硬读配置原值的残留路径。重启从事件重建，不按 now 重算 deadline、不回退旧上限、不清零用量；per-Run 自身 wallTime 不被扩额重置，终态 Run 不重开，在飞者仅按新读数更新根约束。扩额不唤活终态、不恢复业务写、不自动启动工作；replay 是本票执行消费者（批准前过期即拒、批准后可启动、仍沿原 verifier）。
- **测试锚**：`tests/integration/k4-review-after-deadline.spec.ts`、`k4-review-ledger-restart.spec.ts`（K4-1）；`agent-singularity/tests/unit/budget-extend.spec.ts`、`tests/integration/k4-budget-extend.spec.ts`（K4-2）；`tests/integration/k4-budget-reopen.spec.ts`、`k4-budget-consumers.spec.ts`（K4-2/3/4）；`task/tests/unit/budget-extensions.spec.ts`、`task-runtime/tests/unit/{budget-extension,root-budget,orchestrate,gate}.spec.ts`。
- **边界**（合同明确排除）：自动扫描/精确源协议、requestKey 去重属 A5；`task_recover`/supervisor 属 A6；reviewer 超时证据为既有单测（`review-agent.spec.ts`）；drain 不把 `task_review_agent` 计为在途写（其效果仅一条 Diagnosis，与早已放行的 `task_diagnose` 同形）；并发下同 key 重复请求可能多写一条事件但重放状态相同（reducer 幂等裁决，顺序路径零追加）。


## 6. 文档维护

- 文档分类见 [docs 入口](README.md)；负责进度的 agent 使用[进度审核与下一票派发 prompt](execution-prompts/progress-review-and-dispatch.md)，按代码和证据更新唯一表，不自动执行下一票。
- 子代理只接一个可独立验收的子目标，交接基线、改动、证据和剩余项；集成与组合验收也按接口派子代理执行，两个 guide 由主代理汇总同步，同一交付组未完整验收不得推进。具体约束见[公共派发粒度](execution-prompts/README.md#子代理派发粒度)。
- 每次派发同时执行 [公共合同中的质量 Prompt](execution-prompts/README.md)：检查规则实际消费位置、替换入口和跨层组合，保留先失败后通过的反例及合法正例；不能把合同缺陷改名为已知边界。指南中的完成状态必须与这些证据一致。
- 本文只维护方向和当前事实，建设计划只维护票据与验收；实施日志进入带日期记录。
- 每项完成状态必须写清范围、复核日期、源码/测试锚；区分声明、接线、自动测试、真实端到端运行。
- 同一改动同步更新本文的状态和建设计划。部分完成继续标“部分”，不可用“完成（核心未做）”。
- 新设计写成“建设目标/设计选择”；与 KISS 的差距保留为明确缺口，不以已有代码反过来宣称目标已达成。
- 历史材料只作来源，不与当前指南竞争规范地位。旧编号查询历史快照，新工作使用 S/G 编号。

K2 独立审核：[验收记录](history/2026-09-27-k2-review.md)。
