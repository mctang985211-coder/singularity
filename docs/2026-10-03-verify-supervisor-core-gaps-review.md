# Singularity 核心功能构建评审：verify / supervisor 的错位与构建缺口

施工进展与验证口径见 [Task / Skill 自改进实现](2026-10-03-task-skill-implementation.md)；本页的源码结论保留为施工前审计记录。

> 来源：kimi-code session `6f117dc6-ad24-4028-95fa-301dd937e0c8`（2026-10-02 ~ 10-03，工作区 `/home/roxy/code`）。
> 方法：该 session 内共 12 轮对话，累计派出 40+ 只读子代理逐段核对 `packages/singularity/` 源码（含一次 17 分片的全文档落地核查），本文全部代码结论有 `文件:行` 支撑，关键引用已二次抽查。

> 后续复核（2026-10-03）：三个 GPT-6 Sol / xhigh 子代理与主代理对照当前源码发现部分事实及施工建议需要校正，详见 [Supervisor / Task / DAG / KISS 复核](2026-10-03-supervisor-task-dag-kiss-audit.md)。其中“根准入防恒真”“每条 mandatory 必须 command”“坏 child 永久污染根”“supervisor 仅有 1 bit”等表述不能直接作为实施依据；后续施工请同时读取复核中的接线缺陷与最小闭环建议。

---

## 一、明确结论

**Singularity 目前建成的是"约束层"，不是"进化层"。verify / supervisor 这条核心链路的构建方向不正确：它把"判定的每一步机械化、发布的每一步过人"做对了，却把"改进"这个核心功能架空了——唯一能自动发生的"改进"是不改任何东西的重跑，唯一能真正改 world 的通道不接收用户定义的迭代对象（task 树），且改进之后没有任何机制测量它是否带来了提升。**

用 session 里的原话概括现状：**"强约束、弱驱动、不学习"——墙和刹车装好了，发动机接在提示词上，油箱是空的。**

七份设计文档（VRTC 教程 v1.1 / KISS v2.0 / 初始想法 / 细化想法 1–4）对代码的加权落地度约 **60–65%**，且分布极不均匀：

| 层 | 落地度 | 状态 |
|---|---|---|
| 验证 / 准入 / 演化治理（约束层） | 80%+ | 代码强制、语义一致，是真实成果 |
| 运行时驱动（义务引擎、分解门） | 30–50% | 空壳或不存在 |
| 学习层（trajectory、经验记忆、趋势度量） | ~0% | 整层缺失 |

**核心影响**：用户预期的"task / skill / verify / supervisor 构成自进化闭环"目前不成立。自进化在这次实测运行中表现为"只有诊断、没有进化"——0 次 recovery/improvement 轮、0 个 evolution 提案被 apply，且系统无法自愈它自己写坏的判据。

---

## 二、核心功能为什么不正确：四个结构性错位

### 2.1 supervisor 的目标函数只有 1 bit，"无可提升"是必然输出

supervisor 被要求的全部决策是：*"Decide whether one more round is justified under the original acceptance criteria"*（`agent-singularity/src/coordination/handoff-rules.ts:285`）。

- 评分 = 判据命令 + 退出码，`exitCode === 0 ? 'pass' : 'fail'`（`verifier/src/command-verifier.ts:115`），mandatory 交集聚合——**1 bit，无质量/成本/并行度维度**。
- supervisor 上下文里其实**喂了** `metricsLine`（tokens / toolCalls / retries / humanInterventions，`handoff-rules.ts:191-206`），但没有任何指令允许拿它做决策——只是只读摆设。这恰好踩中 Dream-RSI 明令禁止的模式（"bookkeeping only"的数字摆进了决策视野，却没有可攀爬的目标）。
- 实测：3 轮 supervisor 复核全部 `closed`，理由是"再跑只会重演同一失败"——推理完全正确，但这是因为问题本身只有 1 bit 答案。**给它更好的 prompt 也变不出一个可攀爬的量。**

### 2.2 改进通道接错了对象：task 树完全不可迭代

用户明确定义迭代对象 = **对 agent 可见的 task 树、skill 树、tool/MCP**（session 第 2 轮）。现状：

| 迭代对象 | 现状 | 代码依据 |
|---|---|---|
| skill 树 | ✅ 可走 propose→…→apply 全链（最成熟） | `APPLYABLE_TARGET_TYPES` 含 `skill` |
| tool / MCP | ⚠️ 半步：capability 行可改，但不得引新 tool / 新 MCP server / 改 permission/preset | `evolution/src/capability-candidate.ts:322-354` |
| **task 树** | ❌ **一格都动不了** | `task_definition` 在词汇表 `PROPOSAL_TARGET_TYPES` 里，但 `APPLYABLE_TARGET_TYPES = ['skill','capability']`（`evolution/src/types.ts:27`）；"Other target types stay recorded suggestions … never evaluated and never promoted"（`evolution-propose.ts:29`） |

且整个 evolution 链路默认关闭：`DEFAULT_EVOLUTION: 'off'`（`agent-singularity/src/index.ts:73`），supervisor 被明令 "you never call evolution_decide, evolution_apply or evolution_rollback"（`handoff-rules.ts:286`）。

**用户三类迭代对象里的第一类（task 树），恰恰是故障发生地，也恰恰完全不在改进通道上。**

### 2.3 判据属主错位：系统无法自愈自己写坏的判据

- 判据由模型在 `task_intake`/`task_decompose` 时自拟，随 `TaskCreated` 写入；落库后 immutable（`task-runtime/src/admission.ts:258-259`）。
- composite 是对全部成员的硬合取（`composite-verifier.ts:109-120`），无 waive / exempt / dry-run / supersedes / re-score。
- 实测事故：实现子任务把判据写成 `^\$ `（应为 `^[$] `）——一个字符的作者级口误产生一条**恒假** mandatory 判据，永久污染根合取；补进两条已验证的等价子任务也清不掉它。修复权只能交回人（重发契约）。
- 防护是不对称的：`rootIndependenceDefects` 只防**根**任务的**恒真**判据（`admission.ts:139-146`，"不能用恒真命令、模型自述或 heuristic 冒充确定性根通过"），**不防恒假、不管子任务**。
- 更深的陷阱：无 command 的判据静默落入 `review` 模式 → ReviewVerifier 恒 inconclusive → mandatory 永远不过（`task-runtime/src/normalize.ts:240-242` + `review-verifier.ts:6`）。

**这是"自进化是否可信"目前最有价值的反例：一套号称能自我改进的架构，恰恰无法自我修复它自己写坏的判据。**

### 2.4 改进成果无度量、无回路

- apply 之后没有任何 `{world version → 任务结果}` 的记录：`applied` 记录只含 `targets / approvalRef / intentId / actor / at`（`evolution/src/types.ts:139-151`）。
- 无跨轮趋势 / 回归趋势实现（`trend|longitudinal` 全库零命中）；graph archive 只存 `{graph, agentIds, archivedAt}`，不可寻址、无任务结果。
- apply 后无自动复评/重跑。一次改进的"效果"只在下一次有人跑任务时隐式体现，且不被记下来。

**"自进化是否带来提升"在数据上不可观测——今天它还不是一个可测量的命题。**

---

## 三、构建缺口清单（17 分片核查的聚合）

### 3.1 三块系统性缺口

1. **义务驱动引擎不存在。** 文档（KISS §5.1）的"唯一生长信号"是未满足义务；代码注释明写 `An obligation is raised, never scheduled`（`task/src/service/records.ts:206`），唯一消费者是 `task_status` 的一行展示。真正的驱动是 LLM 主动调 `task_decompose`——即提示词驱动。**生长覆盖率没有机械保证。**
2. **分解门与原子性判定不存在。** 教程 §6 自称"被调用最频繁的判定"，代码中 `isAtomic|atomicity|should_decompose` 零命中；只有调用方自声明的 `decomposable: boolean`。**"子任务是否覆盖父判据"没有机械检查**（仓库自己的 `docs/history/2026-09-18-questionnaire-execution.md:74` 承认）。教程 C1–C4 只有 C2 落地。
3. **学习层整体缺失。** `trajectory|experience memory|failure pattern` 零命中（军规 I4"每条轨迹沉淀为可复用资产"未落地）；`escapeRate|suspect|mutationDetection|verificationDebt|diversity|halfLife|reliability|maturity` 零命中（KISS §8 六机制、§10 五仪表盘整层未建）。**"每次执行都让系统变强"在代码里没有载体。**

### 3.2 文档↔代码方向相反的七处（最高价值）

| # | 文档要求 | 代码实际 |
|---|---|---|
| 1 | 全局义务调度 `pick_unmet_obligation` | "raised, never scheduled"（`records.ts:206`） |
| 2 | 子 task 继承父上下文 / session memory tree | 只注入 structured handoff + 按需 Pull（`context/src/reads/contract.ts:164`） |
| 3 | `session-reference/query/trace`（细化想法4 §19） | 执行期**封禁** `session_trace/search`，逼向 `context_read`（`agent-runtime/src/raw-session-guard.ts:7-15`） |
| 4 | L3 允许"引入新 Tool"（KISS §7） | "never authorizes a new tool"（`capability-candidate.ts:326`） |
| 5 | 权限分级、不能全 danger-full-access | worker 默认 `danger-full-access`（`agent-runtime/src/worker-resume.ts:17`） |
| 6 | 人审按风险分级 | L1–L4 无豁免 + decide/apply 两次审批（`evolution-decide.ts:12`） |
| 7 | Evolution 分支模型（MAIN / Candidate） | "this build creates no real branch"（`evolution/src/types.ts:95`） |

### 3.3 空壳字段（有类型、无生产者）——最可执行的一批修复

- `TaskDefinition` 版本化空壳：`definitionRef:{taskType, version:1}`，version 恒 1，无注册表、无升版路径（`task/src/types.ts:71`）——**这正是用户"task 模板"设想与文档（细化想法4 §5.1）的交集，也是唯一没落地的那一层**。
- `CapabilityManifest.closure:'partial'` 无生产者；`EvidenceBundle.artifacts` 自环恒空；`requiredEvidence` 只有渲染消费者；`Diagnosis.relatedTaskIds` 无自动生产者、`reviewRefs` 由 review agent 硬编码单条（`review-run.ts:368`）；`markRunProgressIn` 唯一生产者是测试；六问 gate 答案只校验 `nonEmpty`。

### 3.4 落地最强的部分（应保留的克制）

Task 契约与内容寻址（`task/src/contract.ts:13,118`）；准入拒绝全套（`admission.ts:165/203/181`）；Verifier registry + 可执行 selftest 闸（`verifier/src/index.ts:171-192`）；UNKNOWN 二分 `task|verifier`（`task/src/types.ts:323`）；childEvidence 映射 + `requiresIndependentAcceptance`（`admission.ts:124-131`）；DAG 环检测（`admission.ts:325`、`graph/src/service/state.ts:117-118`）；ReviewRecord 八维 + "never a score"；Evolution 全链状态机 + 双边实验 + 两次人审 + L4 禁 apply；三道工具面 fail-closed。

---

## 四、用户要求的改进方向（对话中逐步明确的设计约束）

按对话顺序，用户给出了五条方向性约束，构成功能重构的边界条件：

1. **迭代对象不是 RSI 式探索策略**，而是对 agent 可见的 **task 树、skill 树、tool/MCP**。（第 2 轮）
2. **verify 指标住在 task 里**：task = 任务简述 + 可替换参数 + 可替换但必须可机械执行的验收指标 + 所需的结构化 skill。节点派生必须**先解析到已有 task，没有才按标准语法新建**。（第 4 轮）
3. **task 本身就是 supervisor 的改进内容**：supervisor 评估 task/skill 质量、判断是否需要变更 → **人审核通过** → 从派发该 task 的父 task 续跑，把新 task/skill 列表暴露给它，观察是否有改进。（第 4 轮）
4. **supervisor 及各节点默认 prompt 不是可自迭代对象**，由人类实现，不进入自迭代环路。（第 7–9 轮；附带好处：归因干净——环内变化只能来自 task/skill/tool）
5. **以 DAG 为 graph 中心构建**。（第 10 轮）

## 五、对话中达成并论证的关键技术共识

这些是 session 中经过多轮辩论（含用户两次纠正 agent）后收敛的设计原则，应作为重构的约束：

1. **两层尺子**：
   - Layer A（oracle，环外，永不进改进写集）：项目自有测试、真实交付物的可观测行为。
   - Layer B（task 判据，可改）：定位为 Layer A 的**派生视图**。修订受理条件 = 在已记录证据上通过两条机械检查：**soundness**（判据过 ⇒ oracle 过，挡住"放松尺子洗白"）与 **agreement**（oracle 过的样本判据也应过，专抓 `^\$ ` 这类诚实写错）。
   - ⚠️ 易写错的规则：不是"新判据不得比旧判据放松"（这会禁止修复恒假判据），而是"**相对 oracle 不得放松**"。
2. **判据属主上移到父 task**：子 task 只持 digest-pinned 引用（照 `ChildEvidenceRef` 模式 + `protectedInputs` 钉死机制），子 task 的改进写集里没有判据；判据由其属主（父）在父的循环里修。链条在根终止，根由人对着用户原始请求审。真正的安全属性 = **判方与被判方属于不同层，且顶层由人对着环外事实审**。
3. **prompt 管提案质量，代码管受理资格**。本库哲学是"散文陈述规则、代码执行规则"（reviewer 工具面、supervisor 工具面、两次人审、`rootIndependenceDefects` 四处皆如此）。可信 = 机械执行 + 权威来源在改进者的写集之外。
4. **效率指标放对照、不放 gate**：成本是双臂对照量/上限（`promotion/binding.ts:690` 的立场），进 `unmetMandatory` 就会被"把工作搬出测量窗口"满足。
5. **实验纪律**（复用现有、不要重造）：历史任务是 case 不是 baseline，两侧都必须重跑（`replay/comparer.ts:548`）；holdout 非空 + 至少一个 observed-failure（`evolution-replay.ts:76-97`）；判词沿用 categorical `EXPERIMENT_VERDICTS`，**不要新造数值分数**（保住 "Review ≠ Judge" 教条）；未知成本拒绝晋升。
6. **DAG 两层结构**：执行 DAG（每版 world 一张，无环、内容寻址、可 memoize——世界会变的前提下唯一站得住的"免费 replay"）+ 版本史（环在 DAG 之外）。统一节点身份 `nodeId = H(task模板@version, 参数绑定, skill集@version, 上游产物digest)` 之后，复用/失效/diff 三件事同时机械化。"从父 task 续跑"应修正为"**重跑影响锥（后继闭包）+ 双臂**"。自进化环不是 DAG，硬塞进一张图要么破坏禁环不变量、要么失去"同一节点的下一版"。

---

## 六、落地优先级建议（session 结论的归并）

- **P0a（半天级，独立价值最大）**：准入门——每条 mandatory 判据必须有 command，具名拒绝无命令判据（消除静默恒 inconclusive 陷阱，`normalize.ts:240-242`）。
- **P0b**：判据准入 dry-run——新判据在已记录证据上跑 soundness + agreement 两条机械检查，恒真/恒假在准入期被挡住，而不是变成永久 gate。
- **P0c**：建立 Tier-1 环外评估层（项目测试/真实结果），把 `acceptanceCriteria` 降格为可追溯的假设；mandatory 判据必须能追溯到某个 Tier-1 事实。
- **P1a**：task 模板作为一等对象（`TaskDefinition` 版本化做实：注册表 + 参数声明与绑定 + 实例 digest 进审计链，复用 `protectedInputs` 钉死机制）。
- **P1b**：把 `task_definition`/task 模板加入 `APPLYABLE_TARGET_TYPES`，把 `supersedes` 修订通道从"准入前"延伸到"已跑过的 task 版本"（提案→人审→落盘管线已建好，只差延伸）。
- **P1c**：给 world version 记账 `{版本 → 任务结果}` + 含成本项的标量 V（比较时刻的派生读数，不进 `ReviewRecord`）；打开 `evolution='on'` 前先补 task store 的 diff/快照基质。
- **P2**：义务驱动引擎（让未满足义务真正成为生长信号）、分解门/原子性判定、子判据覆盖父判据的机械检查、学习层（trajectory/经验记忆/趋势仪表盘）。
- **贯穿**：capability→skill 供给修复（tutorial 只有 2 个 SKILL.md 且无 capability 行引用；config.yml 声明的 6 个 capability 无对应 SKILL.md；根任务遇 missing capability 直接拒，`root-intake.ts:674-677`）——这是供给问题，提示词改不动。

### 两条告诫

1. 任何单调性保证（`V^{m*} ≥ V^0`）只覆盖**已记录任务集上的 replay**，不等于未来任务会变好——不能宣称更多。
2. Dream-RSI §5.1 实证：给提示词加显式语义引导反而更差。抄结构与约束（目标函数、失败分类、replay、反泄漏），不抄措辞。

---

## 附：关键代码证据索引

| 结论 | 位置 |
|---|---|
| 评分=退出码 | `verifier/src/command-verifier.ts:115` |
| 判据 immutable | `task-runtime/src/admission.ts:258-259` |
| composite 硬合取 | `verifier/src/composite-verifier.ts:109-120` |
| 无命令判据静默恒 inconclusive | `task-runtime/src/normalize.ts:240-242` + `verifier/src/review-verifier.ts:6` |
| 根只防恒真 | `task-runtime/src/admission.ts:139-146` |
| supervisor 1-bit 目标 | `agent-singularity/src/coordination/handoff-rules.ts:285` |
| metrics 只读摆设 | `handoff-rules.ts:191-206` |
| supervisor 无发布权 | `handoff-rules.ts:286`；`SUPERVISOR_BASELINE` `:14-31` |
| 改进通道只接 skill/capability | `evolution/src/types.ts:27`；`agent-singularity/src/tools/evolution-propose.ts:29` |
| evolution 默认关 | `agent-singularity/src/index.ts:73` |
| 义务只记不调度 | `task/src/service/records.ts:206` |
| 改进成果无账 | `evolution/src/types.ts:139-151`；`graphs/src/types.ts:14-18` |
| 双边实验/历史非 baseline | `evolution/src/replay/comparer.ts:548`；`promotion/binding.ts:63` |
| 未知成本拒绝晋升 | `evolution/src/promotion/binding.ts:690` |
| 两次人审 | `evolution/src/tools/evolution-decide.ts:63-73`；`evolution-apply.ts:127-133` |
| 判据由父提案拼装 | `task-runtime/src/service/proposals.ts:333-338` |
| TaskDefinition 版本空壳 | `task/src/types.ts:71` |
