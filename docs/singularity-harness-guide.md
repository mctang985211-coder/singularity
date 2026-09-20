# Singularity Harness 工作指南

这份指引回答的是"**要做什么**"：方向、边界、阶段、现状。**"怎么做"是次级内容**，集中在 §5，
且允许随实现演进被推翻。读法：动手前读 §1–§3；实现时查 §5；改完回填 §4。
所有主张都带 `文件:行号` 出处；**只有 `初始想法.md` 里的原话标"人类亲笔"**（出处形如
`初始想法.md:1 [字符a-b]`）——那是唯一的人类输入；`细化想法1.md` / `细化想法3.md` 里复述人类原意的地方标
"**人类思路（经细1 / 细3 转述）**"（那两份是 AI 写的抽象与评审，转述不能当亲笔证据）；其余标"AI 推导"。
**拿不出出处的断言不写进本文档。**

---

## 1. 北极星与原则

### 1.1 三目标与人类原意

**北极星**：构建"**自生长，自进化，自决断**的 harness 架构"（`初始想法.md:1 [字符 54-127]`，人类亲笔），
第一个应用场景是 BUCKYBALL DSA 芯片设计。目标不是"让 agent 更聪明"，而是让外层读到 trace 之后
改造 **harness 本身**（`细化想法1.md:1985-1993`；原话在 `:1010-1014`，Meta-Harness 一节："核心不是'让 agent 更聪明'，
而是让一个 outer agent 阅读 execution traces，然后修改围绕固定模型的 harness"）。

**系统定义句（冻结）**：*A verifier-driven, capability-closed, recursively self-decomposing task runtime
with evidence propagation and review-gated evolution.*（`细化想法4.md:38`，文末复述 `:2254`）
—— 而不是传统意义上的 multi-agent framework（`细化想法4.md:40`）。

人类原话要点（全部出自 `初始想法.md:1`，**人类亲笔**，权重最高）：

| # | 要点 | 字符区间 | 落到本文档 |
|---|---|---|---|
| 1 | 找可借鉴的工程，DSH 自带的最好 | 1-53 | §1.3 / §5.1 |
| 2 | 自生长 / 自进化 / 自决断 | 54-127 | §2.1 |
| 3 | 预设 task + skill/tool 分层切分；每个 task 都是完整、可验证、可确保正确性的节点 | 128-401 | §2.2 |
| 4 | 不给 agent 写死 workflow，但保证"不会产生无 skill 可用的情况" | 402-512 | §2.3 / §2.4 |
| 5 | 在验证指标推动下生长；最原子 task 完成后逐级返回验收指标直到原点 | 514-597 | §2.5 |
| 6 | 以 session id 排列的 memory；子 task 先读父上下文、找 skill 再干活；可临时 fork 父对话交接 | 608-826 | §2.6 / §2.3 |
| 7 | 工具面两种候选（全节点同一 tool 列表 vs 按 task 动态加载 MCP） | 837-908 | §2.4 |
| 8 | 每次 session 结束调一次 review 工具产出评估表；沿 task 长 review 结构；改动点交人类审核 | 922-1008, 1093-1320 | §2.7 / §2.9 |

一句话收敛（AI 推导版）：**让 Agent 自主搜索完成目标的任务结构，让 Harness 自主积累完成这些任务的经验，
但所有结构变化都必须由可验证证据驱动，并通过受控晋升进入下一代 Harness**（`细化想法3.md:130`）。

### 1.2 原则

以下 12 条按来源分两档：**10 条 RFC 冻结原则**（`细化想法4.md:25-34`）+ **2 条细3 建议**（`细化想法3.md:9`、`:11`，
属 AI 评审意见，**尚未冻结**）。实现层可以变（adapter / backend / 新 capability provider /
新 verifier / 新 domain TaskDefinition / 新 evolution operator），这一层不变（`细化想法4.md:19-23`；
可变清单的原文枚举见 `:2165-2184`）。

| # | 原则 | 出处 |
|---|---|---|
| 1 | Task 是语义一等公民，Session 是执行实例，两者绝不合并 | `细化想法4.md:25`；`细化想法2.md:89-128` |
| 2 | Agent 自主生成 workflow / 分解；Harness 负责 Admission、Capability、Dependency、Verification | `细化想法4.md:26`；`细化想法3.md:3`（人类思路，经细3 转述） |
| 3 | Task decomposition lineage 是 Tree；Task dependency 是 DAG | `细化想法4.md:27`；`细化想法2.md:398-460` |
| 4 | 成功状态由 Verifier + Evidence 决定，而不是 Agent 的自然语言声明 | `细化想法4.md:28`；`细化想法2.md:1606` |
| 5 | 父子默认用结构化 Handoff 传信息；深层上下文按需 Query / Reference；Fork 只作 escalation | `细化想法4.md:29`；`细化想法3.md:7`（人类思路，经细3 转述） |
| 6 | Skill / Tool 不直接绑定 Task，只能通过 Capability Resolution 间接绑定 | `细化想法4.md:30`；`细化想法2.md:756-799` |
| 7 | Review 不直接修改 production canon，只产生 Diagnosis 与 Evolution Candidate | `细化想法4.md:31`；`细化想法3.md:71`（人类思路，经细3 转述） |
| 8 | 所有 Evolution Candidate 必须过 Replay / Regression / Validation Gate，必要时人审后才能 Promote | `细化想法4.md:32`；`细化想法1.md:1066-1084` |
| 9 | Execution、Evidence、Review、Evolution 是不同逻辑图，用 ID / lineage 互相引用，不合并为一棵物理树 | `细化想法4.md:33`；`细化想法1.md:1`（该处的对象集是 Task / Session / Memory / Review）；`细化想法2.md:5-7` |
| 10 | DSH 负责通用 Agent runtime substrate；Singularity 负责 Task / Verification / Capability / Evidence / Review / Evolution | `细化想法4.md:34`；`细化想法3.md:96` |
| 11 | 验证闭包：父 task 的每条 acceptance criterion 必须能映射到一个或多个 child evidence，并有 deterministic 或至少 auditable 的聚合规则 | `细化想法3.md:9` |
| 12 | Review ≠ Judge：一等公民是 Diagnosis，Score 只是辅助字段 | `细化想法3.md:11-37`；`细化想法4.md:1049` |

附加口径（不是原则，是判据）：**"没有 Skill"是合法的系统状态**，必须转成可观察的 CapabilityGap，
而不是静默失败（`细化想法4.md:643`；`细化想法3.md:61-69`）。

### 1.3 元原则：能抄现成的绝不自己写（DSH 优先）

先找 DSH 是否已有；有就直接用，并把它当作给定底座（`初始想法.md:1 [字符 1-53]`，人类亲笔）。研究顺序按细1 给的那条：
DSH → Singularity → Meta-Harness → EvoHarness → Recuris → OpenViking → better-harness / self-evolving-harness
（`细化想法1.md:1989`）。细2 另有一份**不同的**清单——"先深读三个"（DSH Agent Teams → DSH Skill +
Session Reference + Agent Preset → EvoAgentX，再看 GEPA / OpenEvolve / Graphiti / singularity-claude，
`细化想法2.md:1842-1860`）；两份清单不构成同一条固定顺序。这条只写原则，**具体清单与落点在 §5.1**。
唯一自建范围（不得扩张）：Task / TaskRun 状态机、AcceptanceCriterion、Verifier 注册表、EvidenceBundle、
capability 表 + admission、依赖驱动的顺序级联、TaskHandoff、composite 父验收。

---

## 2. 要做什么

每条格式：**主张（祈使句）** + 想解决的问题 + 出处 + 现状（已实现 / 部分 / 未建 / 未确证）。
"现状"依据 §4 的实跑与缺口表，拿不准的写"未确证"。

### 2.1 系统形态与平面划分

- **2.1.1 建"元 Harness"，而不是给 Singularity 加一棵任务树。** 问题：harness 自己不会长出新的任务结构与能力。
  出处：`初始想法.md:1 [字符 54-127]`（人类亲笔）；`细化想法1.md:1`（"其实不是'给 Singularity 加一个任务树'这么简单，而是……构建一个……元 Harness"）；`细化想法1.md:1797-1858,1985-1993`。现状：**部分**（Task 语义层已建；Review 平面轻量版已建——ReviewRecord + Diagnosis + 升级评审 agent，见 §2.7.1–§2.7.5；Evolution 平面已建准入轨道 v1 与生效机制，见 §2.7.6/§2.7.7，Evolution Graph 未建）。
- **2.1.2 只预设 Goal + Constraints + Acceptance Criteria + Available Capabilities，不预设固定 workflow。** 问题：避免把某条领域流程（ISA → Microarchitecture → RTL → Integration → Verification）写死成系统前提。
  出处：`细化想法4.md:56-75`；`细化想法2.md:290-292`。现状：**已实现**（T0 只预设判据、不预设拆法；2026-09-18 W25 起，BB 域阶段地图以 root 可按需加载的 `bb-pipeline` skill 落地——参考地图而非写死 workflow，见 §4.3 W25 与 §4.1 M6；其骨架段的步骤序列已于 2026-09-20 W27 义务化改写（§4.2 #30 关闭））。
- **2.1.3 按六个平面组织（Task → Capability → Execution → Evidence/Verification → Review → Evolution），并至少维护四种逻辑关系：Task Decomposition Tree / Task Dependency DAG / Execution Lineage / Review·Evolution Graph。** 问题：给所有对象与服务一个不变的层次归属；混成一棵物理树会让"这次为什么失败"无法横向追查。
  出处：`细化想法4.md:125-171,175-231`；`细化想法1.md:1797-1858`；`细化想法2.md:5-7,1720-1734`；`细化想法3.md:39-59`。现状：**部分**（Task / Execution 两平面已建；Decomposition Tree 与 Dependency DAG 已实现；Review lineage 轻量图已建——`reviewRefs` / `relatedTaskIds` 跨任务互引，见 §2.7.4；Evolution Graph 未建）。
- **2.1.4 划死包边界与 adapter：Singularity 不重造 Session / Skill / MCP / Memory / Subagent。** 问题：重复造轮子既无价值，又与 DSH 职责冲突。
  出处：`细化想法4.md:83-119,1573-1635`；`细化想法2.md:1623-1659`；`细化想法1.md:1858`；`细化想法3.md:96`。现状：**已实现**。落位：层 3 域能力 = buckyball 的 5 个 skill（ball-align / check / chip-designer / verify / waveform）+ `nix develop -c bbdev …` + 本地验证（verify 节点经 bbdev MCP 跑本地工具链；verify-runner 的 ci-dispatch VERDICT 只作参考——2026-09-18 人类裁决，见 §4.3 末条）；层 2 Task 语义 = 本仓自建三包（task / verifier / task-runtime）+ 四个 `task_*` 工具，只解决契约 / 准入 / 依赖 / 验收 / 证据；层 1 图与环境 = graph / graphs / layout / agent-runtime / agent-singularity / graph-web / map + env-builder（多 agent 拓扑、生命周期、可视化）；**其余一切归层 0 的 DSH**。

### 2.2 任务

- **2.2.1 真正的核心单位是 Task Contract，`acceptance` 是其中最重要的部分：固定的是 Contract，不是 Workflow。** 问题：Task 若只是一句目标就没有边界与判据，自主分解会失控、验收会退化成"人说了算"。
  出处：`细化想法1.md:88-151`（`:149`）；`细化想法4.md:447-469`。现状：**已实现**（TaskSpec + AcceptanceCriterion）。
- **2.2.2 每个 task 必须是完整、可验证、可确保正确性的节点；大 task 切小 task 及其 skill，直到原子级别。** 问题：把 core 级设计任务切成"每步都能单独验收"的节点，避免整段返工。
  出处：`初始想法.md:1 [字符 184-223]`、`[字符 262-291]`、`[字符 340-401]`（人类亲笔）。现状：**已实现**。
- **2.2.3 分解是 Tree、依赖是 DAG：DecompositionEdge 与 DependencyEdge 分开建模。** 问题：共享依赖（如 ISA 定义同时喂给 decoder 与 simulator）强制成树会重复复制上下文。
  出处：`细化想法4.md:27`（"分解是 Tree"半句出自这里）；`细化想法2.md:398-460,1613`；`细化想法1.md:202-264`（这处讲的是"底层应是任务 DAG、UI 可以仍表现为 tree"）。现状：**已实现**（`dependsOn` 兄弟索引 + 无环准入，`task-runtime/src/admission.ts:24-29,91-93`；边类型 `DependencyEdge` 在 `task/src/types.ts:47`）。
- **2.2.4 状态迁移由 Harness 提交，Agent 只能提议；准入先拒后跑。** 问题：状态若由 Agent 自宣，合法性判断就被推给执行期。状态机：CREATED → ADMISSION → READY → (DECOMPOSE | EXECUTE) → …
  出处：`细化想法4.md:376-409`（`:409`："Agent 可以提出状态转换，但 Harness 执行合法性检查并提交最终状态"）；`细化想法2.md:1602-1619`。现状：**已实现**（最小版）。
- **2.2.5 DECOMPOSE 必须过 Decomposition Verifier：覆盖父判据？依赖完整？无环？子可验证？Capability 可满足？其中包含原子性判定——允许 `CanSplit = false`，否则不许继续 split。** 问题：分解动作本身缺少准入检查会变成新的失控源；而把"写一个 XOR gate"拆成 choose symbol / choose net names / place pin… 是无意义递归。
  出处：`细化想法4.md:431-443`；`细化想法2.md:231-292`；`细化想法1.md:1484-1551`（`:1521-1534`）。现状：**部分**（准入已实现，判定器未形式化；对照 KISS §6 的组合检查 C2/C3/C4 见 §4.2 #26）。
- **2.2.6 TaskDefinition 版本化且 immutable：任何改动必须产生新 version，不许原地改。** 问题：没有版本化就无法 replay / rollback / bisect，evolution 里的 candidate 与 champion 也没有对齐基准。
  出处：`细化想法2.md:1602-1619`（`:1609`："TaskSpec 是 immutable/versioned，修改产生新 revision"）；`细化想法4.md:235-280`（`:278-280`："版本化的 immutable canonical definition……修改 TaskDefinition 必须产生新 version"）。现状：**已实现**（最小版：`definitionRef` 带 version，包内没有原地改定义 API，`task/src/types.ts:20,35`）。

### 2.3 执行

- **2.3.1 TaskRun ≠ Session：TaskRun 必须绑定一个 DSH Session，但一次 Task 可有多次 Run。** 问题：`task_id = session_id` 会让 retry、换模型重跑、A/B skill、regression 全部变难。
  出处：`细化想法3.md:5`（人类思路，经细3 转述）；`细化想法2.md:89-128,208-227`；`细化想法4.md:331-372`。现状：**已实现**（TaskDefinition / TaskInstance / TaskRun）。
- **2.3.2 父子默认走结构化 Handoff，不复制父 transcript。** 问题：父 session 原文整体复制会造成 context explosion，也让父子通信没有可审计边界。
  出处：人类亲笔只支持前半句——`初始想法.md:1 [字符 673-720]`（"子 task 先阅读父 task 的上下文"）、`[字符 754-789]`（"可临时 fork 一份父对话专门用于交接"）；"默认走结构化 handoff、不复制父 transcript"是 **AI 推导**（`细化想法1.md:268-382`，`:282-284` 明确反对把完整 parent transcript 当 child context）；`细化想法4.md:792-879`。现状：**已实现**（`buildHandoff` / `renderWorkerPrompt`）。**（本条属"部分人类亲笔"）**
- **2.3.3 Push small, Pull deep：child = fresh session + TaskSpec + 判据 + Handoff + skill 目录 + 父会话指针；深层历史用 session-reference / query / trace 按需拉取。** 问题：给少了交接不清，给多了每轮都付 token 且破坏 prefix reuse。
  出处：`细化想法3.md:7`（人类思路，经细3 转述）；`细化想法2.md:464-564`；`细化想法4.md:792-879`。现状：**已实现**（handoff 已实现；父会话指针已在 worker prompt 的 `## Parent session` 小节渲染：`task-runtime/src/handoff.ts:117-121`，断言见 `task-runtime/tests/unit/handoff.spec.ts:92,162`；深层历史按 seq 精确读，全文检索仍关闭——见 §4.3 第 4 条；2026-09-20 W27 起 handoff 增 `assumptions`（调用方声明 + 依赖兄弟证据引用自动并入，`task-runtime/src/orchestrate.ts:659`，M7 实证三条并入））。
- **2.3.4 Fork 只作 escalation，不是默认。** 问题：每个节点都 fork 会复制思维背景、放大 context；人类自己也点过名："这种方式也可能造成上下文灾难"。
  出处：`初始想法.md:1 [字符 754-826]`（人类亲笔）；`细化想法2.md:568-603`；`细化想法4.md:29`。现状：**已实现**（默认 fresh）。
- **2.3.5 Worker 的 preset 应按任务能力选择，而不是无条件继承父 preset。** 问题：现在 Worker spawn 直接继承父 preset，没有按任务选能力组合。
  出处：`细化想法2.md:866-947`；`细化想法4.md:712-788`。现状：**部分**（`capability → preset` 已接线：spawn 前 `resolvePreset` 取命中能力的首个 preset（`task-runtime/src/orchestrate.ts:582`）并随 spawn 请求下发（`:611`），按 resolver 选择未实现）。

### 2.4 能力

- **2.4.1 Task 只提 capability requirement，经 Capability Resolver 产出 CapabilityManifest；不写 `skills: [...]` 直接绑技能列表。** 问题：skill v1 被 v2 替换时 TaskSpec 不该改。
  出处：`细化想法4.md:583-608`；`细化想法1.md:696-754`；`细化想法2.md:756-799`。现状：**已实现**（`requiredCapabilities` + resolver）。
- **2.4.2 用 DSH skill subsystem 的 progressive disclosure（catalog → 按需取正文），不重造 skill loader。** 问题：Skill Registry 与按需加载不值得自己实现。Skill 另有成熟度生命周期 EXPERIMENTAL → VALIDATED → HARDENED → STABLE → DEPRECATED，evolution 生成 candidate version。
  出处：`细化想法2.md:691-750`；`细化想法4.md:647-708`。现状：**已实现**（catalog 与加载）/ **未建**（成熟度约定——与 skill 契约一起进侧车注册表，规范见 §2.4.8，缺口见 §4.2 #29）。
- **2.4.3 Capability 三态 CLOSED / PARTIALLY_CLOSED / GAP；允许 task 先进入执行。** 问题：要求 task 一生成就列全能力会限制自由生长，Capability Resolver 会变成新的"隐藏 workflow"。
  出处：`细化想法3.md:61-69`；`细化想法4.md:612-643`。现状：**部分**（现行是 fail-closed 整批拒绝；对照 KISS §7 的 GAP 阶梯见 §4.2 #27、临时计划阶段 3）。
- **2.4.4 缺口是合法状态与信号，不是终态：找 sibling skill → 组合多个 skill → 请求父 → 临时 procedure → 提新 skill proposal → 人 / 受控晋升。** 问题：agent 卡在"想做事但没工具"会静默失败。
  出处：`细化想法1.md:1555-1602`；`细化想法4.md:612-643`；`细化想法2.md:296-394`。现状：**未建**（现路径 = `decomposable: true` 再分解 + 人工补能力表；对照 KISS §7 的 L1–L4 阶梯见 §4.2 #27 与 #21）。
- **2.4.5 工具面分三层：L0 Universal Control / L1 Task·Capability Scoped / L2 Dynamic·Temporary（只给 Evolution Sandbox 或受授权 builder）；不给所有 task 全量 tool list，也不做 per-task 特制 profile。** 问题：tool schema 本身就是每轮 token 成本；`task_1234_special_profile` 式做法不可维护。
  出处：`细化想法4.md:712-788`；`细化想法1.md:758-824`（这一处给的是**两级**：Universal Core Tools + Task Capability Tools）；三级 L0 / L1 / L2 出自 `细化想法1.md:893-920`（`:910`：Level 2 只给 Evolution Plane）；`细化想法2.md:803-862`。现状：**部分**（L1 已落地——capability 声明的 tools/skills 经 grant 收敛为 worker 的 allow-list 与 skill 钉册，见 §4.2 #1 与 §5.1；按能力的 MCP 挂载亦于 2026-09-18 由 W21 进入 L1——spawn 级 per-env 接缝，见 §4.3 W21 记录；L0/L2 分层仍按 §4.3 裁决后置；**L0/L2 的开启条件**见 §4.2 #31 与临时计划阶段 7）。
- **2.4.6 工具面两种候选都先认下：全节点同一 system prompt + 同一 tool 列表，与按 task 动态加载 MCP tool。** 问题：不给 agent 写死 workflow 的同时要保证"不会产生无 skill 可用的情况"。
  出处：`初始想法.md:1 [字符 402-427]`、`[字符 467-512]`、`[字符 837-908]`（人类亲笔）；`细化想法1.md:758-824`。现状：**部分**（`capability → preset` 已接线；"按 task 动态加载 MCP tool"已由 W21 落地为 spawn 级 per-env 挂载——能力行声明 server 名、spawn 时物化并挂载，见 §4.3 W21 记录与 §5.1 MCP 行）。
- **2.4.7 Capability 与 Permission 分开建模，不可互相替代：Capability 回答"能不能完成这个任务"，Permission 回答"允许对什么环境做什么操作"。** 问题：两者混成一个字段会让"能力缺口"与"权限不足"互相掩盖——前者该走 capability evolution，后者该走人审提权。
  出处：`细化想法4.md:1382-1414`（`:1407-1414`）。现状：**部分**（capability 表已建；permission 分级机制已接线、默认姿态未翻，见 §4.2 缺口 4）。
- **2.4.8 Skill 层也要有契约；领域包只装知识与义务，不装步骤序列。** 问题：skill 在本包只是字符串名字（准入零校验、spawn 才炸），没有"提供什么能力、前置是什么、由谁验证"的契约；领域包里写步骤序列等于把 workflow 从后门搬回来（KISS 军规 2）。
  出处：KISS §4.2（Skill 必填字段：`capability_provided` 受控词表 / `precondition` / `inputs` / `outputs` / `required_tools` / `verifier_ref`（未验不入库）/ `reliability`）；KISS §12（领域包最小定义 = 义务模板 + 骨干 Skill 集 + 参考 Verifier 集；领域包不允许出现步骤序列；自检 = 模板删除测试）；KISS §5.1（顺序翻译为 assumptions + 证据依赖；义务模板是提问式——"你必须回答'你的差分参考在哪'"，不是"你必须做 BEMU"）；`细化想法2.md:691-750`（成熟度生命周期）。现状：**规范冻结（2026-09-20，W26）**——① Skill 契约走侧车注册表（不改 DSH loader：上游 frontmatter 只支持 name/description/whenToUse/metadata，证据见 §4.2 #29），字段同上 + 成熟度 EXPERIMENTAL→…→DEPRECATED 一并入册；"未验不入库"在 evolution apply（skill 类）处强制（落点见临时计划阶段 3.2 / 5）。② 领域包内容规范：允许阶段→能力映射与判据/环境硬事实，**禁止步骤序列**；自检用模板删除测试（删掉全部骨架样例，新任务仍能合理分解才算合规）。③ 知识型 skill 先行样例 `bb-obligations` 已落盘（§4.3 W26）；bb-pipeline 骨架已于 2026-09-20 W27 义务化改写（§4.2 #30 关闭，M7 复核），其 `obligations.yml` 为机器可读义务模板正本。机制未建部分（侧车注册表本体、准入期 skill 校验）照旧登记 §4.2 #29。

### 2.5 证据与验收

- **2.5.1 Agent 不负责宣布完成；成功路径固定：Artifact → Verifier → VerificationResult → EvidenceBundle → Acceptance Aggregation。** 问题："Done." / "Tests passed." / "Looks correct." 不能成为成功条件。
  出处：`细化想法4.md:475-497`；`细化想法2.md:1606-1612`。现状：**已实现**。
- **2.5.2 AcceptanceCriterion 必须含 verificationMode（deterministic / simulation / formal / measurement / review / composite）+ requiredEvidence + mandatory。** 问题：acceptance 要是可执行、可绑证据的判据，而不是描述性文字。
  出处：`细化想法4.md:499-518`。现状：**已实现**（六种 mode 都在类型里，`task/src/types.ts:6-7`；`formal` 与 `review` 由同一个 `ReviewVerifier` 接收（`verifier/src/review-verifier.ts:3,9-11`），而它恒返回 `inconclusive`（`:13-20`）——即 **formal 有路由、永不自动通过**，与 review 同走人工判读；带 command 的强制只覆盖 deterministic / simulation / measurement，`task-runtime/src/admission.ts:5,67-69`；对照 KISS §4.1/§4.3 的四值语义（UNKNOWN 二分）与 AC 级 verifier 引用见 §4.2 #24）；2026-09-20 W27 起判据增可选 `requiresArtifact` 证据依赖字段（缺产物 spawn 前落 blocked + 义务登记，见 §4.2 #20 与 §4.1 M7 段）。
- **2.5.3 EvidenceBundle / EvidenceClaim 是跨 task 传递正确性的载体；父只能消费 evidence。** 问题：父子之间传"正确性"缺少可审计载体。
  出处：`细化想法4.md:544-579`。现状：**已实现**（EvidenceStore：`.dsh/task-evidence/`）。
- **2.5.4 父验收 = 组合正确性：子全绿不等于父 verified；父判据须定义 criterion → evidence refs → aggregation rule，最终仍由 parent-level verifier 验组合结果。** 问题：把"孩子都绿了"当成父任务完成。
  出处：`细化想法4.md:520-540`；`细化想法3.md:9`。现状：**部分**（composite 判据已实现，聚合规则未形式化；对照 KISS §6 见 §4.2 #26）。
- **2.5.5 逐级返回验收指标直到任务原点，父做 synthesis 而不是只收 success / fail。** 问题：上层要验的是组合正确性，不是子节点自报成功。
  出处：`初始想法.md:1 [字符 514-528]`、`[字符 564-597]`（人类亲笔）；`细化想法1.md:1363-1428`。现状：**已实现**（composite 父验收 + 失败传播 + 证据回传）。

### 2.6 记忆

- **2.6.1 建以 session id 排列的 memory 系统：子 task 先读父上下文 → 接受指令 → 找到对应 skill → 开始工作。** 问题：没有它，每个节点各干各的，agent 就没有"对全局的掌握能力、对任务更深的了解能力"。
  出处：`初始想法.md:1 [字符 608-664]`、`[字符 673-752]`（人类亲笔）。现状：**已实现**（M0 append-only session log + task store + handoff + 血缘）。
- **2.6.2 四层记忆 M0 Raw / M1 Task / M2 Experience / M3 Evolution，不建"一个大 Memory"。** 问题：四层用途完全不同，混在一起就退化成 transcript dump。
  出处：`细化想法1.md:386-404`；`细化想法4.md:883-959`。现状：**部分**（M0 / M1 已实现，M2 / M3 未建）。
- **2.6.3 Context 分 L0–L5；两条硬约束：TaskSpec / Verification / Evidence 不进 chat context；压缩只换对话摘要，原始事件留在 raw session log 可回放。L1 任务契约常驻、不许被 compaction 丢掉。** 问题：compaction 不能改变任务含义。
  出处：`细化想法2.md:607-644`；`细化想法4.md:883-959`（`:894-898` 两条硬约束；`:915-919`：M0 raw session log 可回放）。现状：**已实现（每轮重注入为 2026-09-18 并行工作，本批文档代理复核代码确认）**——chat 不是结构化状态（契约 / 判据 / 证据）的正本，正本在 task store 与 EvidenceStore；契约双通道送达：spawn 时注入一次（判据表写进 worker prompt，`task-runtime/src/handoff.ts:76-82`），同一契约同时渲染为带标记的 `<worker-contract>` 块（`task-runtime/src/contract.ts:62-87` 的 `renderWorkerContract`，接线于 `task-runtime/src/orchestrate.ts:609`），并注册进 worker 自己作用域的 system-prompt section（`agent-runtime/src/contract-reinjection.ts:75-79` 的 `installWorkerContract`，接线于 `agent-runtime/src/index.ts:255`）——agent-loop 每步把渲染结果重投影到 surface 节点 0，compaction 从不选 system 节点 0，渲染不变则零额外事件（机制与上游行号证据见 `contract-reinjection.ts:9-27` 的模块注释）；`task_read` 按需重取不变。端到端集成测试 `tests/integration/worker-contract.spec.ts`：fold 遮蔽 spawn prompt 后契约仍在 surface 首位、surface 丢失契约后恰好一次写回。
- **2.6.4 记忆工程 DSH 内置优先，先不要接 Graphiti。** 问题：需要跨几十 / 几百个 task 做语义经验检索的场景还没出现，长期记忆应晚于协议定义（P6，`细化想法4.md:2003-2005`）。
  出处：`细化想法2.md:646-687,1627-1639`；`细化想法4.md:1780-1786`。现状：**部分**（M0 / M1 落地；语义记忆按裁决后置）。

### 2.7 复盘与进化

- **2.7.1 每次 session 结束调一次 review 工具，产出针对这次 task 的评估表。** 问题：执行完就散，没有任何东西沉淀下来指导下一次。
  出处：`初始想法.md:1 [字符 922-1008]`（人类亲笔）。现状：**已实现（轻量版，2026-09-17）**——每个终态 run 一条 ReviewRecord（存储层强制：与终态一致、每 run 至多一条、`failed` 必带 `localizedCause`、非 failed 禁带、`logTail` 同样仅 failed、`blockedBy` 仅 blocked，`task/src/service/state.ts:216-252`；编排器所有终态分支各写一条，共享 `recordTerminalReview`（`task-runtime/src/orchestrate.ts:415-427`，级联各终态调用点 `:618-754`）），无评分，经 `task_status` 行尾可读（`agent-singularity/src/tools/task-status.ts:30-39`）；同日按 graph8 语料评估（M1，P1）把 record 丰富化为自包含复盘单元：`durationMs`、逐判据 `criteria`（command/exitCode/logRef）、failed 带截断 `logTail`（≤40 行 / ≤2048 字符，`verifier/src/index.ts` 的 `logTail`）、blocked 带结构化 `blockedBy`。八维与工程量指标**已建（并行工作，2026-09-18 本批复核确认）**：record 增 `dimensions`（八维机械事实，只记可机械观察的事实、不打分，`task/src/types.ts:340-351`）与 `metrics`（工程量计数器：tokens / toolCalls / humanInterventions / retries / evidenceLogs，`:374-402`——time 已由 `durationMs` 承载、artifactCount 因部署无 ArtifactRef 写入方而如实空缺），编排器终态时按 store 快照与会话观察派生（`task-runtime/src/orchestrate.ts:263-334`），端到端断言 `tests/integration/review-metrics.spec.ts`；八维中六个非机械维度的结论走 §2.7.2 的 `task_review_agent` 判读。e2e 实证见 §4.1 末段。
- **2.7.2 Review 是 data-first 而不是 agent-first：TaskRun 结束 → 结构化 ReviewRecord → persist；只有复杂情况才 spawn Review Agent。ReviewRecord 至少含八维（Outcome correctness / Task specification quality / Acceptance quality / Decomposition quality / Capability coverage / Skill fit / Tool fit / Context efficiency），并同时记录六项工程量指标（tokens / time / retry count / tool calls / human interventions / artifact count）。** 问题：每个 Task 都养常驻 Review Agent 会让 session 数 ×2、context 与存储爆炸。
  出处：`细化想法3.md:11`（人类思路，经细3 转述）；`细化想法2.md:1063-1105`；`细化想法4.md:963-1049,1023-1052`。现状：**已建（并行工作，2026-09-18 本批文档代理复核代码确认）**——data-first 底座与升级判据都在：`task_review_pack` 输出机械事实包并在末尾印机器可判的升级行；升级判据是纯函数 `computeEscalation`（E1 最新 review 为 failed / E2 failed 却无 logTail 与 evidence / E3 判据 inconclusive / E4 能力覆盖为 gap，`agent-singularity/src/tools/review-escalation.ts:32-36,84-108`）；只有判据命中且预算有余才 spawn 一个**只读** review agent——`task_review_agent`（`agent-singularity/src/tools/review-agent.ts:184-309`）：grant 恰为 `REVIEWER_BASELINE`（`:54-66`，无 shell / 写 / 嵌套 spawn / evolution 工具），看门狗超时取消，六维判读（`adequate | inadequate | unknown` + 证据引用 + rationale，归一化 `:136-158`，证据不足强制 unknown）落为一条 `Diagnosis`；每 root store 的启动预算由 append-only 台账看守（`agent-singularity/src/review-agent-ledger.ts`，默认 1，`SINGULARITY_REVIEW_AGENT_BUDGET` 可调）。八维事实与工程量指标随每条 ReviewRecord 记录（见 §2.7.1）。**偏差如实记录**：评审 agent 的真实 LLM 判读质量未经实跑评估，验证到单测 / 集成层。
- **2.7.3 Review ≠ Judge：核心产物是 Diagnosis（observedFailure / scope / localizedCause / evidenceRefs / confidence / proposals），不是分数。** 问题：`skill_fit = 0.41` 这类分数无法告诉 evolution agent"为什么"，review 树会变成评分树而不是能 debug Harness 的树。
  出处：`细化想法3.md:11-37`；`细化想法4.md:1053-1140`；`细化想法1.md:506-630`。现状：**已实现（轻量版，2026-09-17，W8）**——Diagnosis 落地为 `DiagnosisRecorded` 事件（`observedFailure / scope / localizedCause / evidenceRefs / reviewRefs / confidence(high|medium|low) / proposals / relatedTaskIds`，无评分，`task/src/types.ts:537-568`；reducer 强制 id 唯一、字段齐全、至少一条证据或 review 引用、proposals 九类 targetType，`task/src/service/state.ts:269-329`），由调用方按需触发（data-first，无常驻 reviewer agent）：只读 `task_review_pack` 组证据包 + 写 `task_diagnose` 持久化（`agent-singularity/src/tools/task-review-pack.ts`、`task-diagnose.ts`，均在 ROOT_TOOLS）。**2026-09-18 并行工作补两字段（本批复核确认）**：可选 `producedBy`（谁写的——`agent` / `human`，带 sessionId，缺席按 human 读，`task/src/types.ts:522-528,555-560`）与 `judgements`（六维逐维结论 `adequate | inadequate | unknown` + 证据引用 + rationale，`:561-567`；六维枚举 `JUDGED_DIMENSIONS` `:484-491`）；reducer 同样强制校验——producedBy.kind 枚举、judgements 每条维度合法、verdict 枚举、证据引用非空、rationale 非空（`task/src/service/state.ts:298-326`）；持久化档案 `docs/persistence-changes/2026-09-17-diagnosis-judgements.*`（same-version，digest 不变）。生产者之二为升级路径的 `task_review_agent`（见 §2.7.2）。
- **2.7.4 review lineage 是独立因果结构：Execution Graph → Evidence Graph → Diagnosis Graph → Evolution Graph，允许 DAG / graph 而非严格 tree。** 问题：一个问题可能跨多个 task（verification 失败的真因可能在 parent microarchitecture 的 timing assumption），不能只沿 `parent_task_id` 向上爬。
  出处：`细化想法3.md:39-59`；`细化想法4.md:1053-1140`。现状：**已实现（轻量版，2026-09-17，W8）**（已裁决采用 graph schema）——Diagnosis 的 `reviewRefs` 可引用多条 ReviewRecord、`relatedTaskIds` 跨任务引用（reducer 校验指向本 store 内已存在 task）；Evolution Graph 仍属 P5。
- **2.7.5 复盘要综合父 task 与子 task，判断"这样长出来的节点是否合适"；用局部证据 + 父 review 摘要 + 相关祖先约束，而不是重读整条 ancestry。** 问题：单节点视角看不出节点是否长对；重读全链 token 是 O(depth × full transcript)。
  出处：`初始想法.md:1 [字符 1093-1168]`（人类亲笔；原文档在 1135 / 1137 之间只有一个逗号，引成两段会漏掉它）；`细化想法1.md:634-692`。现状：**已实现（轻量版，2026-09-17，W8）**——`task_review_pack` 从 task store 快照组装：本任务全部 ReviewRecord 全文（criteria/logTail/blockedBy）+ 子任务逐条 review 摘要 + 父任务 review 摘要 + 依赖边，不回放原始会话、不爬整条 ancestry。
- **2.7.6 Review 只产生 Candidate，不直接改 production：Sandbox 做 replay / regression / held-out / deterministic verifier → candidate vs champion → 人审 → Promote / Rollback。EvolutionProposal 的 targetType 共九类（skill / tool / capability / task_definition / decomposition_policy / agent_preset / workflow_policy / verifier / runtime_policy），且必须带 `targetId` + `baseVersion`。** 问题："Agent 失败 → 自己改 skill → 自己评价 → 成功"是 self-confirming loop。
  出处：`细化想法3.md:71`（人类思路，经细3 转述）；`细化想法2.md:1220-1269`；`细化想法4.md:1144-1180,1184-1200`。现状：**准入轨道 v1 已建（2026-09-17，W10）**——EvolutionProposal 注册表落地为 append-only JSONL 台账（`.dsh/evolution/proposals.jsonl`，路径推导照 verifier 的 `.dsh/task-evidence` 模式；`agent-singularity/src/evolution.ts`），独立于 task store（平面分离，只以 ID 互引）；九类 targetType 复用 W8 冻结枚举，`targetId` + `baseVersion` 必填；状态机 `proposed → candidate → prepared → replayed → gated → decided`（candidate 带 mutation 必须先经 prepared，机械型再过 replayed，不带可 candidate→gated 直达，见 §2.7.7），记录 immutable、迁移只追加、回放与写入共用同一 fold 校验（跳态/重复 id 拒绝）；工具面 `evolution_propose / candidate / prepare / replay / gate / decide / apply / rollback / list`（ROOT_TOOLS，`agent-runtime/src/index.ts:37-45`）只记账、物化到沙箱，或（W16 起，仅机械三类）经再次人审写生产；没有任何级别自动改 production。Sandbox 物化已建（2026-09-18，W14，见 §2.7.7）。**Replay / regression 执行器与 candidate vs champion 对比已建（2026-09-18，W15，细节见 §2.7.7 与 §4.3 W15 记录）**：回放对象 = 本图 task store 里已有终态（verified/failed）且带 ReviewRecord 的历史任务，champion 侧恒为该任务的自包含历史记录（绝不重跑 champion）；跨图回放不建——champion 的证据、判据与 env 检出锚点都长在本图，跨图没有可对比基线。回放只是对比实验：回放任务作为独立无父任务落同一 store（objective 与 review anomalies 带 `evolution-replay:<proposalId>`、run 的 parentRunId 指向 champion run），历史树与生产零写入；生效只走 W16 的人工批准 apply 通道（§2.7.7），自动生效仍禁止；对照 KISS §8.1/§9 的分层接受度量与结构化 Retro 见 §4.2 #28。
- **2.7.7 Evolution 分四级（L1 执行适配不改 canonical / L2 capability evolution / L3 workflow evolution 需历史 replay + holdout regression / L4 harness evolution 原则上人工批准），并走 branch model + validation gate：不直接覆盖 main，candidate branch 记完整版本集合，最小 Gate 六问，决策 PROMOTE / REJECT / KEEP FOR FURTHER RESEARCH。** 问题：不同敏感度的 mutation 若走同一套流程，一次普通失败会一路改到 verifier，最终形成 reward hacking。
  出处：`细化想法3.md:71-94`；`细化想法4.md:1184-1283,1287-1357`；`细化想法1.md:1088-1149`。现状：**轨道 v1 已建（2026-09-17，W10）**——L1–L4 级别字段落地且 v1 全部级别一视同仁走人类批准（保守符合 §2.9.2 红线）；branch model 只建记账部分：`evolution_candidate` 记完整版本集合（`versionSet: Record<string,string>`，非空、值非空），不建真分支、不覆盖 main；Gate 六问按 `细化想法4.md:1329-1357` 原文逐字转写为六个必填文本字段，replay/regression 问项必须附证据引用（task store 证据 id 或文件路径，校验存在性、不执行）；决策值冻结为 PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH，`evolution_decide` 先经原生 approval seam 人审，approve 才落账。mutation 分型与沙箱物化已建（2026-09-18，W14）：candidate 可选携带结构化 `mutation`，按 targetType 分型——四类机械型（skill `{name,content}` / agent_preset `{presetId,files:[{path,content}]}` / capability `{name,entry}` / task_definition `{baseVersion,definition}`，全部路径字段强制相对、无 `..`、无绝对路径）与五类记账型（tool / decomposition_policy / workflow_policy / verifier / runtime_policy 自由结构化描述，`mechanical: false` 只记账）；状态机随之扩为 proposed→candidate→prepared→gated→decided；`evolution_prepare`（ROOT_TOOLS）把机械型 mutation 物化到 `.dsh/evolution/sandbox/<proposalId>/`（skill→`skills/<name>/SKILL.md`、preset→`.agent-presets/<presetId>/…`、capability→`capability-table.patch.yml`（注释写明 config.yml doc1 task-runtime 行整行替换语义）、task_definition→`task-definition.json`），并把 champion（当前生产版本）快照落 `champion/`（skill/preset 读生产根、capability 取当前生效表条目、task_definition 取 task store 中 baseVersion 匹配实例的实存字段；目标不存在记 champion: null），写路径经 resolveWithin 复核、永远不出沙箱。**Replay / regression 执行器已建（2026-09-18，W15）**：机械型路径收紧为 candidate→prepared→**replayed**→gated——`evolution_replay`（ROOT_TOOLS，`agent-runtime/src/index.ts:40`）对本图终态历史任务逐 targetType 重放候选：capability 以 `capabilityOverrides` 整行覆盖该 run 的能力解析、skill 以 `extraSkillRoots` 把沙箱 skill 注册进回放 worker 自己的 skill 层（遮蔽生产同名 skill 只对该 worker 生效），两者都走真实 spawn+verify 链（`task-runtime/src/index.ts:576` 的 `replayTask` → `orchestrate.ts:829` 的 `runReplayTask`）；task_definition 不 spawn worker，候选定义判据直接经 verifier 重跑（deterministic criteria replay）；**agent_preset v1 记 manual**——agent-presets 的发现根在构造期固定（`resolvedRoots`，`resolve(id)` 只扫这些根），沙箱物化的 preset 无法挂载，报告如实登记 manual 而不硬造执行。对比报告落 `sandbox/<id>/replay-report.json`（schema 与 not-worse/worse/inconclusive/manual 判词在 `agent-singularity/src/replay.ts`；champion 侧恒为历史 ReviewRecord，observed 与 holdout 分组、holdout 为空如实写未执行），台账追加 `replayed` 记录，`evolution_gate` 对机械型强制 `regressionEvidenceRefs` 含该报告路径且文件仍在。**Promotion / Rollback 生效机制已建（2026-09-18，W16）**——状态机扩为 decided(PROMOTE) → `applied` →（可选）`rolledback`（append-only 新 kind，带目标清单与人审证据引用 `approvalRef`；decision=REJECT/KEEP_FOR_FURTHER_RESEARCH 没有 applied 后继，fold 与写入共用同一状态机拒绝）；新工具 `evolution_apply` / `evolution_rollback`（ROOT_TOOLS）各自再过一次原生 `ctx.approval.request`——reason 带提案摘要与即将写入的生产路径清单，reject/取消/无应答零写入、状态原地停留（decide 之外的人审第二闸门，§2.9.2）。apply 收紧到三类机械型且须已物化、限 L1–L3：**skill** 把沙箱 `skills/<name>/SKILL.md` 写到 `$DSH_HOME/skills/<name>/SKILL.md`（文件级——champion 快照只含 SKILL.md，目录里其它文件不动；skill-filesystem 带 watch，落盘即生效）；**agent_preset** 整目录替换 `.dsh/.agent-presets/<presetId>/`（发现每次 resolve 重读 roots，落盘即生效）；**capability** 对 `config.yml` 文档 1 task-runtime 行 `capabilities:` 里对应条目做文本级手术（`agent-singularity/src/config-edit.ts`——只动该条目，文档 2 的 api 块与其余所有行字节级不变，无整文件 YAML 往返、无新依赖），并随即调新增的 `TaskRuntime.applyCapabilityRow`（`task-runtime/src/index.ts`）做运行期整行覆盖，本进程即刻生效、config.yml 保证重启后一致（插件 config 本是启动期加载，如实记录这一接缝）。rollback 从 champion 快照恢复（skill/preset 复制回去、capability 行取 `champion/capability-table.entry.yml`），champion 为 null 则删除 apply 产物。task_definition（无注册表，W14 保真上限）、五个记账型、L4 一律拒绝并回人工操作指引——只记账+人工的边界不变。

### 2.8 自决断的边界

- **2.8.1 "自决断"是 constrained planner，不是超级自主 Agent：只暴露七个动作 EXECUTE / DECOMPOSE / ASK_PARENT / REQUEST_CAPABILITY / RETRY / BLOCK / ESCALATE_HUMAN；可执行性由 Task State、Dependency State、Capability State、Budget Policy 决定。** 问题：无边界自主性会把合法性判断推给执行期。
  出处：`细化想法4.md:413-427`；`细化想法1.md:1432-1481`（早期列 11 个动作，冻结版收敛为 7 个）。现状：**部分**（模型在 `task_*` 工具面上自由选动作，action 集合未形式化；**预算路径缺失**，对照 KISS §5"预算即法律"见 §4.2 #23）。
- **2.8.2 Agent mutable 与 Controller mutable 分离：任务 / 记忆 / skill proposal 归前者；routing / approval / system policy / capability 授权 / task contract schema / acceptance policy 归后者。** 问题：不让 Task Evolution 与 Skill Evolution 共用一个 mutation。
  出处：`细化想法1.md:972-987`（Agent mutable / Controller mutable 六项清单原文）；`:924-956`（"不要让两者共用一个 mutation"，即技能面与任务面分开的动机）；`细化想法4.md:1184-1283`。现状：**未建**。
- **2.8.3 Level 2 runtime mutation（运行时生成 tool / 动态挂载）只允许 Evolution Plane 使用，普通 task agent 不得自造 tool。** 问题："Agent creates tool → tool creates capability → capability 改变未来 agent 行为"已属控制面改造，不该混在普通任务执行里。
  出处：`细化想法1.md:893-920`；`细化想法2.md:1468-1470`。现状：**部分**（DSH `cordis_define/run/stop/undefine` 只在受控预设下可用，授权面未建；对照 KISS §8.5 的独立性预算见 §4.2 #31）。
- **2.8.4 明确禁止：为拿高分修改 Verifier；不能因"AI 自主性"取消 admission / verification。** 问题：Verifier 可被 Agent 修改会迅速 reward hacking。
  出处：`细化想法2.md:1617-1619`；`细化想法4.md:2052-2066`（Non-Goals 1/2/9）。现状：**部分**（现在没有任何工具能改 verifier，等于事实上禁止；成文的变更门禁需自建，`细化想法2.md:1617-1619`）。

### 2.9 人机

- **2.9.1 人只治理高风险 mutation：verifier / system policy / permission escalation / stable skill promotion / production tool installation / workflow policy promotion。** 问题：不能让数百个自动生成 task 都拿 `danger-full-access`，也不能让 Agent 直接看到内部 database / scheduler / verifier state。
  出处：`细化想法4.md:1361-1414`；`细化想法2.md:951-992`。现状：**部分**（人审通道已有并收敛到原生 seam（§5.5），权限分级机制已接线、默认姿态未翻（§4.2 缺口 4））。
- **2.9.2 复盘结论与修改点必须交人类审核，不能自动生效。** 问题：自进化不能绕过人。
  出处：`初始想法.md:1 [字符 1293-1320]`（人类亲笔）；`细化想法4.md:32`。现状：**已实现（轨道 v1，2026-09-17，W10）**——Evolution 决策全部经原生 `ctx.approval.request` 人审（reject / 取消 / 无应答均不落账，proposal 停留 gated；`agent-singularity/src/tools/evolution-decide.ts`），落账的 PROMOTE 也只是台账记录、不自动生效；replay 执行器已建（W15，§2.7.7），但其产物只是对比报告，决策仍全员人审。**2026-09-18 W16 起为人审双闸门**：`evolution_decide` 一次、`evolution_apply` 一次（reason 列出提案摘要与全部生产写入路径），`evolution_rollback` 再过一次；任一闸门 reject/取消/无应答都零写入、状态原地停留，且不可 apply 的提案在开口问人之前就被拒绝（不烧人审）。

---

## 3. 边界与阶段

### 3.1 Non-Goals（明确不做的事）

合并三份素材与现存文档后，第一版明确不做（`细化想法4.md:2052-2066` 是原文清单）：

| 不做 | 出处 |
|---|---|
| 把 Task / Session / Memory / Review 合并成同一棵物理树 | `细化想法4.md:33`；`细化想法2.md:5-7`；`细化想法1.md:1` |
| 默认 fork 全部 parent conversation / 复制完整父上下文 | `细化想法4.md:29,2052-2066`；`细化想法2.md:490-497,597` |
| 建"一个大 Memory"、把 memory 做成 transcript dump、复杂 semantic memory graph | `细化想法1.md:386-388`；`细化想法3.md:126`；`细化想法4.md:2003-2005,2052-2066` |
| 完全开放式 Agent self-modification / 自动修改 verifier / 自动升级 production permission / 为"AI 自主性"取消 admission 与 verification | `细化想法4.md:2052-2066`；`细化想法2.md:1617-1619` |
| 普通 task agent 自造 tool 或拿到全部 MCP tools；L2 runtime tool 只给 Evolution Plane | `细化想法4.md:712-788,2052-2066`；`细化想法1.md:910-920`；`细化想法2.md:1468-1470` |
| 每个 task 一个常驻 reviewer agent；Review 做成打分或 LLM judge | `细化想法4.md:2052-2066`；`细化想法3.md:11-37`；`细化想法2.md:1085-1089`；`细化想法1.md:512` |
| candidate 因 reviewer 说"看起来更好"直接写入主 Harness | `细化想法1.md:1066-1084`；`细化想法4.md:31-32` |
| 无意义递归拆分（XOR gate 拆成 choose symbol / choose net names / place pin…） | `细化想法1.md:1536-1551` |
| 把 Singularity 做成 agent graph framework；自建 Session / Skill / MCP / Memory / Subagent | `细化想法1.md:1858`；`细化想法2.md:1623-1659,1644-1648`；`细化想法3.md:96` |
| 把 DSH Agent Teams 当作 Task runtime（借数据结构 / revision / mailbox / Task DAG 思路，不借组织层级） | `细化想法2.md:1044-1059` |
| per-task 特制 profile（`task_1234_special_profile`）；`skills: [...]` 直接绑技能列表 | `细化想法2.md:803-862,760-775`；`细化想法4.md:30` |
| 立即引入复杂 evolutionary population search | `细化想法4.md:2052-2066` |
| 预算 / 并发调度完整语义、Task overlay 可视化、跨图任务迁移、Artifact store、一 Task 多 Run 的 retry 路径 | 本仓现状口径（§4.2 / §4.3），在出现真实消费者之前不建 |

### 3.2 阶段与进入条件

三份素材的阶段编号不一致，显式对齐如下（细1 三阶段 = 粗粒度叙事；细2 P0–P5 与细4 P0–P6 = 同一套细分，
细4 多出 P6）：

| 细1 阶段 | 细2 | 细4 | 内容 | 进入/完成条件 |
|---|---|---|---|---|
| Phase 1（`细化想法1.md:1690-1732`） | P0（`细化想法2.md:1740-1758`） | P0 Semantics Freeze（`细化想法4.md:1910-1929`） | TaskSpec / TaskDefinition / TaskInstance / TaskRun / 状态机 / AcceptanceCriterion / Verifier / EvidenceBundle | — |
| Phase 1 | P1（`细化想法2.md:1760-1776`） | P1 Recursive Task Runtime（`:1931-1944`） | task_create / decompose / start / complete / fail、Task DAG、TaskRun ↔ Session | §47 是**整版** MVP DoD（`:2011-2048`；细4 没有单列 P1 门槛）：闭环跑通且全程可用 ID 追溯 |
| Phase 1 | P2（`细化想法2.md:1778-1790`） | P2 Handoff / Context（`:1946-1957`） | session-reference / query / trace / compaction + TaskHandoff | 未显式给出 |
| Phase 1 | P3（`细化想法2.md:1792-1809`） | P3 Capability Runtime（`:1959-1969`） | DSH Skills / Agent Presets / MCP + CapabilityResolver | 未显式给出 |
| **Phase 2**（`:1734-1763`） | P4（`细化想法2.md:1813-1821`） | P4 Review / Diagnosis（`:1971-1985`） | 先 TaskRun → ReviewRecord，再 ReviewRecord → Diagnosis；暂不允许自动改 production | 两步按此先后完成 |
| **Phase 3**（`:1765-1793`） | P5（`细化想法2.md:1825-1838`） | P5 Evolution（`:1987-2001`） | Proposal / Candidate / Sandbox / Replay / Regression / Validation Gate / Human Approval / Promotion / Rollback | 先决：P4 闭环稳定——"只有这一闭环稳定以后才进入 Evolution"（`:2048`）；每次晋升过 §32 Gate 六问（`:1329-1357`）。**2026-09-17 准入轨道 v1 落地（W10）**：Proposal / Candidate（记版本集合）/ Validation Gate（六问台账）/ Human Approval（原生 approval seam）/ 决策台账已建；Sandbox 物化已建（2026-09-18，W14：mutation 分型 + `evolution_prepare` 沙箱落盘 + champion 快照）；Replay / Regression 执行已建（2026-09-18，W15：同图回放 + per-run overlay + 对比报告 + 状态机收紧 prepared→replayed→gated，agent_preset 记 manual）；Promotion / Rollback 生效机制已建（2026-09-18，W16：机械三类 decided→applied→rolledback + apply/rollback 各一次原生 approval，L4 与记账型按红线永远人工）。**全链真机闭环（2026-09-18）**：graph14 上 capability（`research` 行加 `permission`）与 skill（champion missing 新建）两条 proposal 各走完 proposed→candidate→prepared→replayed→gated→decided→applied→rolledback 八跳，每跳 approve 均经画布 HTTP 代答（零 mux 客户端）；见 §4.1 M3 段 |
| —（细1 无此阶段） | —（细2 无） | P6 Experience / Semantic Memory（`:2003-2005`） | Engram / Reference Memory、Graphiti、OpenViking 类经验记忆 | P0–P5 已有实际运行数据（`:1780-1786`） |

**现在在哪一阶段**：Phase 1 / P0–P1 的闭环已实跑（§4.1）；P2 部分落地（handoff、血缘、按需读已接线，
契约每轮重注入已落地（§2.6.3），全文检索关闭）；P3 部分落地（capability resolve / preset / tools·skills 真授权已接线
（§4.2 #1），按 resolver 选能力组合未实现）。**Phase 2（P4 Review）
轻量版已落地**（2026-09-17：每终态 run 一条 ReviewRecord、无评分、失败带 localizedCause，见 §2.7.1 与
§4.1 末段；同日 W8 落地 ReviewRecord → Diagnosis 第二步，见 §2.7.3–§2.7.5；完整八维评估仍未建）。**Phase 3（P5 Evolution）
准入轨道 v1 已落地**（2026-09-17，W10：proposal/candidate/gate/decision 台账 + 全员人审，见 §2.7.6/§2.7.7；2026-09-18 W14
落地 mutation 分型 + 沙箱物化，同日 W15 落地 replay/regression 执行器与 candidate vs champion 对比——agent_preset
记 manual；同日 W16 落地 apply/rollback 生效机制（机械三类 + apply/rollback 各一次人审，L4 与记账型按红线永久
人工），P5 主链 Proposal→…→Promotion/Rollback 闭环已通；**2026-09-18 M3 正式构建真机全链闭环**：graph14 上 capability
与 skill 两条 proposal 各八跳走完、promotion 生效与 rollback 复原均实测，见 §4.1 M3 段与 §3.2 P5 行），P6 未开始。阶段判断与素材一致：已过"概念不清"、进入
**protocol design 阶段**，继续堆 agent / memory / MCP 项目的收益已低于继续定义协议（`细化想法3.md:98`）。
先冻结的主链闭环：TaskSpec → Task Admission → Capability Resolution → TaskRun/Session → Artifact + Evidence →
Verifier → Parent Acceptance → Review/Diagnosis → Evolution Proposal → Replay/Regression → Promotion
（`细化想法3.md:100-122`）。

---

## 4. 现在到哪了

本节只写状态，不写做法。总判：**没有跑偏**——task / verifier / task-runtime 三个新包加上四个 `task_*`
工具，正对 RFC 的 MVP 闭环，且经真实 LLM 会话实跑；上游 `origin/main` 与全部 11 个远端分支对这些概念
零命中，上游未合并分支的主题（画布视觉 / env 侧栏 / PR 标记）与本层正交。

### 4.1 已跑通（实跑证据）

- 根 → 子 → 孙三层递归 + composite 根验收（4 节点全 verified）。
- 依赖排序与证据传递：依赖任务的 `TaskVerified` 之后下游才 `TaskStarted`，handoff 只带依赖任务的证据。
- 失败传播：子 fail → 依赖它的后续子任务 blocked → 父 composite fail → 父 fail。
- 调用方中断：取消 root 会话的 turn → 在飞 worker 收到 `tool call aborted` → 父 / 子 run 双 `TaskCancelled`。
- 验收超时：到 `verifyTimeoutMs` 杀整棵命令树，判据 inconclusive，run `TaskFailed`，归因写进 details。
- 血缘与检索：`agent-runtime.spawn` 写入 `parentSession / origin:'subagent' / delegationDepth /
  isSeeded:false`；`tool-session-query` 挂到全局层，worker prompt 渲染"父会话"小节。

以上六条的出处（2026-09-18 复核补齐；均为 2026-09-16 首轮冒烟的 v2 任务事件流，已随 v2→v3 迁移移到
`.dsh/sessions-v2-legacy/_no-cwd/`，gitignored）：第 1 条 = `sg-t-d53af3c6-…/session.v2.jsonl.zstd`
（4 条 TaskCreated / 4 条 TaskVerified，根 composite 判据收口于 seq 32-34）；第 2 条 =
`sg-t-a4671b1e-…`（seq 8 DependencyAdded，依赖 seq 16 TaskVerified，下游 seq 17 HandoffCreated 的
`relevantEvidence` 恰为依赖 run 的证据、seq 18 才 TaskStarted）；第 3 条 = `sg-t-c2e8cf08-…`
（seq 16 子 `TaskFailed` → seq 17 下游 `TaskBlocked`（reason 原文 `dependencies […] did not verify`）→
seq 20 根 `TaskFailed`）；第 4 条 = `sg-t-05134550-…`（seq 10-11 父子双 `TaskCancelled`，reason 原文
`aborted by caller`）；第 5 条 = `sg-t-053612d7-…`（seq 11 `TaskFailed`，reason 原文
`task-runtime: verification of run "…" timed out after 600000ms`；"杀整棵命令树"的执行器行为见
`verifier/src/command-verifier.ts:30-35` 的 `killTree`）；第 6 条为代码事实（spawn meta 写在
`agent-runtime/src/index.ts:237-244`，父会话小节渲染在 `task-runtime/src/handoff.ts:117-121`），
任务侧血缘在上述每条事件流的 `HandoffCreated`（带 parentRunId）里可直接读到。

对照 §3.2：这等于 Phase 1 / P0–P1 的 MVP DoD 闭环（`细化想法4.md:2011-2048`）已跑通。

**2026-09-17 版本验证**（W1–W4 落地后，全量 + 一次真实 e2e 冒烟）：

- 静态：`pnpm install` / `pnpm build`（12 包）通过；单测 **273 全绿（47 文件）**，集成 **87 全绿（17 文件）**；
  `pnpm run verify-persistence` 通过（4 个事件 root 与 `docs/persistence-schema.json` 指纹一致）。
- e2e 冒烟（graph7 / env project31，真实 LLM 网关）：重启 `./dsh web` 时新 `config.yml` task-runtime 行
  通过启动校验（无配置报错，服务正常起在 3080）；root 依次调 `task_read` → **`capability_list`**（返回 8 条
  能力表，内容与 `config.yml` 的逐字拷贝一致）→ `task_decompose`（1 个子任务）→ `task_status` →
  `graph_mark_ready`；worker 经 bash 写 `w5-smoke.txt`；command verifier 通过 → `EvidenceProduced` →
  `TaskVerified` → 父 composite 判据收口；**两条终态 run 各落一条 `ReviewRecorded`**（字段
  taskId/runId/sessionId/outcome/evidenceRefs/anomalies，根任务另带 relatedTaskIds）；`task_status` 行尾
  带 `review: verified` 摘要。证据：任务事件流
  `.dsh/sessions/_no-cwd/sg-t-83220fed-fd7a-47d4-b408-e34df110f4f7/session.v3.jsonl.zstd`
  （子 run seq 13、根 run seq 17）；验收日志
  `.dsh/task-evidence/sg-t-83220fed-fd7a-47d4-b408-e34df110f4f7/r-83024e50-1002-4881-91c7-db1ccef52ea6/ac1-{1,2}.log`；
  root 转录 `.dsh/sessions/--home-ROXY-code-bb_work-harness-environment-project31--/83220fed-fd7a-47d4-b408-e34df110f4f7/session.v3.jsonl.zstd`
  （以上均为 gitignored 运行时数据）。

**2026-09-17 W11 收官验证**（W1–W10 全量落地后：静态全量 + graph9–graph12 四图真实运行 + P4→P5 链实测）：

- 静态：`pnpm install` / `pnpm build`（12 包）通过；`verify-persistence` 通过（4 roots 指纹一致）；
  单测 **323 全绿（48 文件）**，集成 **90 全绿（17 文件）**。
- **过程大发现：运行中的 `./dsh web`（02:54 启动）是当日旧代码**——W5–W10 的改动（orchestrate 的
  enriched record、evolution 工具等）不在进程里。graph9 在其上跑完四结局但 `ReviewRecorded` 缺
  criteria/logTail/durationMs/blockedBy，才暴露进程陈旧；杀旧 node 子进程（python launcher 死了
  node 不会死）重启后复跑。教训：改完代码必须重启 web 才算"新代码在跑"。
- **env 复用机制实证**：`POST /singularity/graphs/graph8/delete` → 归档 graph8 + env-clean worker
  把 project32 的 buckyball 检出 git reset 到干净树（**检出保留**，HEAD b9267bb2 不变）→ 新图
  `envId:"project32"` 直接复用，零 clone。这是设计的重绑定路径，不是 hack。
- **结局语料**（四结局新代码实跑 + 超时结局旧代码实跑、新代码仅单测覆盖；graph9 现场按约定保留，故复跑用 octocat/Hello-World 降级——真实性代价：
  判据对象从 buckyball 换成演示仓库，但验收/编排/record 链路是同一套代码，结论不受影响）：
  - verified：graph12 任务A `t-92943bf7` — record 带 `criteria`（exit 0、logRef）+ `durationMs`。
  - failed：graph12 任务B `t-06a24eef` — record 带 `localizedCause` + `criteria`（exit 1）+
    **`logTail`（非空："grep exit 1: symbol absent"）** + `durationMs`。
  - blocked：graph12 任务C `t-1a6d6e5a` — 无 run 的 record 带 **`blockedBy`** + `relatedTaskIds`。
  - cancelled：graph10 任务D `t-97495595`（worker bash `sleep 300` 在飞时驾驶员取消 root turn）→
    `TaskCancelled "aborted by caller"` + record **只有 `durationMs`**（evidenceRefs 空）；父 run 同样
    cancelled。注意取消只在 worker 在飞阶段生效：进入 verify 阶段后 abort 信号不传给 verifier
    （graph9 的 D 因此跑满 `sleep 600` 撞 `verifyTimeoutMs` 落 failed-timeout，而非 cancelled）。
  - 准入拒绝：graph12 探测批（`requiredCapabilities:["fly-to-moon"]` 未标 decomposable）→ 原文
    `task_decompose rejected: task-runtime: admission rejected decomposition of "t-435cda82-…":
    capability gap: child 0 is missing [fly-to-moon] and may not decompose`；整批原子拒绝、零事件落库。
- **P4→P5 链实测**（graph12 root）：`task_review_pack` ✓（criteria/logTail/父子摘要/依赖边齐全）→
  `task_diagnose` ✓（`DiagnosisRecorded` 落库，`diag-w11-graph12-B`，proposals 一条 targetType=verifier）→
  `evolution_propose` ✗ **运行时报 `cannot get property "evolution" without inject`**——见 §4.2 #15，
  五个 `evolution_*` 工具同样全灭，台账零写入（fail-closed 成立）；`evolution_decide` 的 HITL 挂起/画布
  代答因此未上演。（该断线与同批取证的取消路径幽灵已于同日 W12 修复，见 §4.2 末 W12 实施记录；本段保留
  W11 原样取证。）
- 证据（均 gitignored）：任务事件流 `.dsh/sessions/_no-cwd/sg-t-{f16991b8…(graph9), 9b8d52cf…(graph10),
  a72dda5b…(graph12)}/session.v3.jsonl.zstd`；验收日志 `.dsh/task-evidence/sg-t-a72dda5b-…/r-cf7e47ae-…/ac2-1.log`；
  root 转录在对应 `environment/projectN` 目录的会话存储下。

**2026-09-17 M2 收官复核**（W12 两处修复的实跑复核；web 服务于 20:07 重启加载 20:02 重建的 lib，
node PID 1882925）：

- 静态：`pnpm build`（12 包）通过；`verify-persistence` 通过（4 roots 指纹一致）；单测 **324 全绿
  （48 文件）**，集成 **92 全绿（18 文件）**。
- **P4→P5 全链（graph12 root 会话续投，任务 B `t-06a24eef`）**：`task_review_pack` ✓ → 复用诊断
  `diag-w11-graph12-B` → `evolution_propose` 双路径 ✓（fromDiagnosis 转录 `m2-prop-diag`
  L2 verifier/command-verifier；手动填参 `m2-prop-manual` L1 workflow_policy/cancel-cascade-policy）→
  `evolution_candidate` ✓（versionSet：taskDefinition/verifier/runtimePolicy 三项）→ `evolution_gate` ✓
  （六问逐一作答，regressionEvidenceRefs 指向盘上真实 `ac2-1.log` 与 evidence id，存在性校验通过）→
  `evolution_decide`：20:15 发起后挂起 15 分 01 秒，期间台账零写入（"不答不落账"成立，转录 seq 149
  `approval/asked` 无 `approval/decided`，`proposals.jsonl` 维持 4 行）→ 驾驶员经画布 HTTP 代答 approve
  （前置：mux 客户端对网关转发的 waterfall 答 `next` 委托，见 §4.2 #17）→ seq 150
  `approval/decided allowed-once`、seq 151 工具返回 decided，台账落第 5 行 `decided PROMOTE`
  （12:30:44Z）→ `evolution_list` 全量输出，`m2-prop-diag` history 四跳完整
  （proposed→candidate→gated→decided）。台账 `.dsh/evolution/proposals.jsonl`；root 转录
  `environment/project35` 会话存储 `a72dda5b-…/session.v3.jsonl.zstd`。
- **#14 取消路径复核（graph13，env project36 新建只 clone）**：X（`sleep 300` worker 在飞）时
  `session/cancel` root turn（20:37:23）→ X `TaskCancelled "aborted by caller"` + cancelled record
  （durationMs 51236）；Y（dependsOn X、未启动）无 run `TaskBlocked`（reason 原文
  `cancelled by the caller before this child started`）+ 恰一条 blocked record
  （`blockedBy:[{X, cancelled}]`、evidenceRefs 空、带 anomalies）；父 run cancelled 收口；事件流
  `.dsh/sessions/_no-cwd/sg-t-1805b4f6-04ce-4ac2-a9a6-b7a74fae1610/session.v3.jsonl.zstd` seq 14–19，
  全 store 无 admitted 残留。一次成功，无需重试。
- 新发现：approval 瀑布被网关转发器优先认领、无浏览器客户端时画布 answerer 收不到，记 §4.2 #17。

**2026-09-18 M3 正式构建全周期验收**（P5 收官的第五段复核：W16 生效机制首次真机走完；web 服务于 08:44 重启加载 08:41 重建的 lib，node PID 2701584）：

- 静态：`pnpm build`（12 包）通过；`verify-persistence` OK（4 roots 指纹一致）；单测 **568 全绿（57 文件）**，集成 **114 全绿（22 文件）**。
- **env 复用被拒，降级新建**：唯一带 buckyball 检出的 env `project32` 仍绑在 graph9 上（`create` 对已注册图的环境直接拒绝 `environment "project32" already bound`），而 graph 现场按约定全部保留、18G 的 buckyball 全新 clone 超出时间盒；故本轮新建 clone-only env `project37`（graph14，`octocat/Hello-World`，HEAD 7fd1a60）——与 W11 同一条降级先例：判据对象从 buckyball 换成演示仓库，验收/编排/review/进化链路是同一套代码。setup worker 成功 clone 并 `env_register_component`；root 调 `graph_mark_ready` 前撞网关 429（HTTP 429 RATE_LIMIT）中断一轮，驾驶员续投一轮后 ready。
- **任务 1：capability 型全周期**（mutation = 给能力表 `research` 行加 `permission: workspace-write`，whole-row 语义）。X `t-e504bab7-…` 判据 `cd octocat/Hello-World && git grep -q definitely-not-a-real-symbol-xyz` 按设计 exit 1 → `TaskFailed "mandatory criteria not satisfied: ac1-1 fail"` + failed ReviewRecord（`localizedCause` 一句，durationMs 16358）；根 `t-1a77ff8a-…` 随之 composite failed。随后：`task_review_pack(X)` ✓ → `task_diagnose` 落 `m3-diag-cap-research`（proposal 指向 capability `research`）→ `evolution_propose m3-prop-cap`（fromDiagnosis 转录）→ `evolution_candidate`（versionSet 三项 + capability mutation）→ `evolution_prepare`（沙箱 `.dsh/evolution/sandbox/m3-prop-cap/`：`capability-table.patch.yml` + `champion/capability-table.entry.yml`，champion `captured`）→ `evolution_replay`（**overlay 下真实重放**：新 replay 任务 `t-132911a6-…` 以同一 command 重跑，champion failed → candidate failed、无判据差异，**verdict `not-worse`**，报告落 `sandbox/m3-prop-cap/replay-report.json`）→ `evolution_gate` 六问 6/6（regressionEvidenceRefs = 报告路径 + 真实 evidence id，存在性校验通过）→ `evolution_decide`。
- **两个"不答不落账"实测**：`evolution_decide` 于 08:51:37.512 发起 approval，**挂起 104.7s 期间台账保持 10 行、config.yml sha 不变**，直到驾驶员 08:53:22 经 `POST /singularity/hitl` approve 才落 `decided PROMOTE`；`evolution_apply` 于 08:54:05.327 发起，**挂起 78.9s 期间台账 11 行、config.yml 仍 `c3baf695…`**，08:55:24 代答 approve 后才写生产。六次 approval（两条链各 decide/apply/rollback）全部 `asked → decided allowed-once` 成对。
- **生效核验**：`config.yml` 前后只差一行——`research: { preset: standard }` → `research: { preset: standard, permission: workspace-write }`；文档 2 `api:` 块 sha256 前后一致（`2880ba11…`），doc1 除该行外全部行 sha 一致（`78b4737a…`），`.dsh/skills` 与 `.dsh/.agent-presets` 未受影响。运行期覆盖即时生效：apply 后 `capability_list` 实返 `research — … permission: workspace-write`，无需重启。
- **回滚核验**：`evolution_rollback`（同样先挂起、代答后才写）→ config.yml research 行复原、`capability_list` 复原为 `permission: (none — the worker keeps danger-full-access)`、台账落 `rolledback`。**注意文本归一化**（见 §4.2 #18）：复原后的行写作 `research: { skills: [], tools: [], preset: standard }`——与 apply 前文本不同但语义相同（champion 快照取自运行注册表，配置 schema 会把缺省数组补成 `[]`）。
- **任务 2：skill 型短链（champion missing）**（`m3-prop-skill`，L2 skill，base dev）。`evolution_candidate(mutation: {name, content})` → `evolution_prepare`：champion `null`（生产 skill 根无此 skill）→ `evolution_replay`（skill overlay `extraSkillRoots`，新 replay 任务 `t-820f08ff-…`，verdict `not-worse`）→ gate 6/6 → decide → `evolution_apply` 写出 `.dsh/skills/m3-smoke-skill/SKILL.md`（approval `call_00_ET_rN3FTS…`）→ **技能发现实测**：`skills/list`（cold-readable Remote，`GET`/RPC `skills/list`）立即从 31 条变 32 条、含 `m3-smoke-skill` 及该文件路径，证明 skill 根 watch 是活的、写入即生效 → `evolution_rollback` 删除该目录，`skills/list` 回到 31 条。`evolution_list` 收官实返 4 条（两条 M3 各带八跳 history + 两次 approvalRef，外加 M2 两条）。
- **#17 修复的真机表现**：本轮全程未启动任何 mux 客户端（只用 `m1-driver` RPC 与 `m2-http` HTTP）。`evolution_decide` 的 approval 一发起，`GET /singularity/hitl` 立即返回 `kind: "approve"` 的完整卡片（六问全文 + version set），`POST` 同端点 approve 即落 `allowed-once`——画布 answerer 在零客户端拓扑下直达，`prepend` 修复成立（§4.2 #17 的"真机零客户端未复跑"边界就此关闭）。
- 证据（均 gitignored）：台账 `.dsh/evolution/proposals.jsonl`（21 行）、沙箱 `.dsh/evolution/sandbox/{m3-prop-cap,m3-prop-skill}/`（含两份 `replay-report.json`）、任务事件流 `.dsh/sessions/_no-cwd/sg-t-ed1fdfa5-5f64-474b-9a85-a6075ae4cba1/session.v3.jsonl.zstd` seq 0–37、root 转录 `.dsh/sessions/--home-ROXY-code-bb_work-harness-environment-project37--/ed1fdfa5-…/session.v3.jsonl.zstd`（seq 123/138/166/237/252/267 六条 approval 对）、config 前后快照 `.dsh/m3-config-pre-apply.yml`。

**2026-09-18 M4 #12 spawn 失败收敛实跑复核**（W17 后重建 lib 重启 web，node PID 2866265 → 探针生效重启 2866614 → 清场重启 2868559）：

- **探针规程（可逆、唯一 config 改动）**：改动前记录 `config.yml` sha256 `714efe37…` 与 task-runtime capabilities 区块快照（`.dsh/m4-config-pre-probe.sha256` / `.dsh/m4-config-block-pre-probe.txt`）；在 `config.yml` 文档 1 capabilities 表加一行 `broken-probe: { preset: ghost-preset }`（preset 发现根无此 preset，assertPreset 预检必炸——刻意构造 spawn 失败语料），重启 web 使启动期加载生效。root 调 `capability_list` 实返 9 条、末行 `broken-probe — tools: [] skills: [] preset: ghost-preset`（root 转录 seq 20），探针在场确认。
- **触发（graph15，复用 project37 零 clone）**：删 graph14 归档 + env-clean（检出保留），`POST /singularity/graphs {name, envId:"project37"}` 建 graph15（rootSessionId `8dcf56b5-…`）。root 按指令 `capability_list` → `task_read` → 唯一一次 `task_decompose` 拆两个子任务：P（`t-456dc62e-…`，requiredCapabilities `[broken-probe]`）与 Q（`t-8400d4bc-…`，requiredCapabilities `[research]`，dependsOn=[P]）。
- **事件序列核验**（任务事件流 `.dsh/sessions/_no-cwd/sg-t-8dcf56b5-6ff5-4788-b793-a912a298bc13/session.v3.jsonl.zstd` seq 0–21）：P：seq 10 `CapabilityResolved`（manifest 原文 `{"broken-probe": {…, "preset": "ghost-preset"}}`）→ seq 12 `HandoffCreated` → seq 13 `TaskStarted`（**run 先建**，run `r-3d8d98e4-…`、`agentPreset: "ghost-preset"` 已记进 run）→ seq 14 `TaskFailed`，reason 原文 `spawn failed: task-runtime: preset "ghost-preset" granted by capabilities [broken-probe] is not mountable: agent-presets: preset "ghost-preset" not found (available: standard, ptc, minimal, cordis, bb-verify, singularity-reviewer)` → seq 15 `ReviewRecorded`（outcome failed、**localizedCause 与 reason 逐字同文**、evidenceRefs `[]`、durationMs 8）。Q：seq 16 **无 run 的 `TaskBlocked`**（reason 原文 `dependencies [t-456dc62e-…] did not verify`）→ seq 17 **恰一条**无 run 的 blocked ReviewRecord（`blockedBy:[{taskId: P, outcome: "failed"}]`、evidenceRefs `[]`、带 anomalies 与 relatedTaskIds）。父：seq 18–21 composite 判据收口 `TaskFailed`（reason 原文 `root-children-verified fail (unverified children: t-456dc62e-…(failed), t-8400d4bc-…(blocked))`）+ failed ReviewRecord。`task_status` 收官实返 3 任务 failed/failed/blocked，**全 store 无 admitted 残留**（root 转录 seq 37）。root 收到的编排反馈（`task_decompose` 工具返回，转录 seq 32）原文：`decomposed t-bcf106ab-… into 2 children: - t-456dc62e-…: failed run r-3d8d98e4-… - t-8400d4bc-…: blocked`——spawn 失败当场进编排反馈，不再静默。
- **清场**：删 `broken-probe` 行后 `config.yml` sha256 复原为 `714efe37…`（与探针前逐字节一致）；再重启 web（PID 2868559）清内存表，root 会话续投（`session/prompt` RPC）再调 `capability_list` 实返 8 条、无 broken-probe（root 转录 seq 55）。服务保持运行，graph15 现场按约定保留。

**2026-09-18 M5 能力 MCP 化真机验收**（W21 接线、W22 撤 dispatch 条目后的首次真实挂载验收；web 服务于 21:06 重启加载 21:06 重建的 lib，node PID 3259552）：

- 静态：`pnpm build` 通过；`verify-persistence` OK（4 roots 指纹一致）；单测 **615 全绿（58 文件）**，集成 **117 全绿（23 文件）**。
- **环境与偏离记录**：新建 env `project38`（graph16，`DangoSys/buckyball` @ `4005744d`）。setup worker **未遵守图名里"只 clone 不 build"的硬约束**：实跑 `scripts/nix/build-all.sh` 多轮至 `BUILD_ALL_EXIT=0`（prompt  adherence 问题，非机制问题；副作用是 nix store 与工具链在验收前已焐热）。setup worker 另报告 upstream HEAD 的 Verilator flow 断裂（`BBSimHarness.sv` 为空致 `%Error: --top-module 'BBSimHarness' was not found`，其称上游 check CI 在 `4005744d` 与前一提交均失败）——buckyball 侧问题，不在本仓修复面。
- **验收 1 · bbdev MCP 冷启动实测**：worker spawn 挂 bbdev server（`nix develop` + FastMCP + 45 工具同步）实测 **TaskStarted →  worker turn/start = 3746ms**（任务 V）与 **3916ms**（任务 R），随后首个模型请求各再 +33ms / +9ms；无超时、零重试。语义边界：本机 nix store 已被 setup 焐热，这是"热 store、冷进程"数据；无 store 的真·冷机首挂会更慢，未实测。
- **验收 2 · check-ball-registration 端到端**（graph16 任务 V `t-2150b084-…`，run `r-2b159d49-…`）：`CapabilityResolved` manifest `closure:closed`、`mcpServers:[bbdev]`；run `capabilitySnapshot:["check","mcp:bbdev"]`；worker 工具面 67 个、其中 **`mcp__bbdev__*` 45 个**；worker 真调 `mcp__bbdev__validate(chip="toy")`（转录 seq 22），返回 `passed:true`、**10 项 checks 全过**（本指南与任务书旧称"九项"，实测为十项，见 §5.2 行修正）、`chip_balldomain=examples/cores/toy/configs/balldomains/default.toml`；worker 将 JSON 落盘 `m5-validate-result.json` 并 read 复读自校；deterministic 判据（检查该文件为合法 JSON 且 `passed is True`）exit 0 → `TaskVerified`；ReviewRecord 字段齐全（criteria 带 command/exitCode/logRef、durationMs 20525、dimensions/metrics）。
- **验收 3 · 本地回归抽查**（任务 R `t-72781cf8-…`，`run-bemu-regression` + `bb-verify` preset，工具面 62 个）：`mcp__bbdev__bbdev_bemu_batch(chip="toy", test="elf-tests")` submit 成功（trace_id `1da84124b9e796ffd96dc8f7d37cc724`，daemon port 5187）→ `task_status` 返回 `queued` → **`task_cancel` 两次均 HTTP 400 `trace_id is required`（新缺口 #19，任务未能取消）** → 任务自然跑完：终态 `success/returncode 0`（submit → 完成 ≤68s）。判据 exit 0 → verified，durationMs 103473。submit/poll 链路与本地 bemu 工具链的真机可达性就此证实；未发起任何 workload build。
- **验收 4 · root 隔离**：graph16 root 的 `request/header` 工具面 22 个、**零 `mcp__*`**；root 全程 tool/call 仅 `graph_spawn / graph_mark_ready / capability_list / task_read / task_decompose / task_status`。worker 面有、root 面无，与集成断言 `worker-mcp.spec.ts`（"mcp__ tools visible there, nowhere else"）真机互证。
- **验收 5 · 失败语义**（graph17，env `project39` 只有 `octocat/Hello-World`）：声明 `check-ball-registration` 的子任务 F（`t-1061f8d9-…`）：`TaskStarted` 后 **13ms** `TaskFailed`，reason 原文 `spawn failed: task-runtime: MCP server "bbdev" binds {repoRoot:buckyball} but this run's env (/home/ROXY/code/bb_work/harness/environment/project39) has no "buckyball" checkout` → `ReviewRecorded`（failed、localizedCause 逐字同文、evidenceRefs `[]`、durationMs 13）→ 父 composite failed 收口并点名 unverified child。全 store 无 admitted 残留。
- 证据（均 gitignored）：任务事件流 `.dsh/sessions/_no-cwd/sg-t-{1cce288d-176b-4bf1-b526-aa5b648a6506 (graph16), 78a10ad1-6017-47cc-8e10-085d2f724cd8 (graph17)}/session.v3.jsonl.zstd`；worker 转录 `environment/project38` 会话存储 `s-d32a9aa7-…`（V）/ `s-45c07ef3-…`（R）；验收日志 `.dsh/task-evidence/sg-t-1cce288d-…/r-{2b159d49-…/ac1-1.log, 967e0fa3-…/ac2-1.log}`（成功静默、0 字节）；落盘产物在 project38 检出内 `m5-validate-result.json` 与 `m5-bemu-trace.txt`（含三次调用的原始返回与 worker 的缺陷根因分析）。graph16/graph17 与 project38/project39 现场保留。

**2026-09-18 M6 环境复用 + root skill 通道真机验收**（W24/W25 的实机复核；web 服务于 23:18 重启加载 23:18 重建的 lib，node PID 3515836）：

- 静态：`pnpm build` 绿；`verify-persistence` OK（4 roots 指纹一致）；单测 **616 全绿（58 文件）**，集成 **130 全绿（24 文件）**。
- **skill 发现**：`skills/list`（cold-readable Remote）实返 32 条（M3 回滚后基线 31），含 `bb-pipeline`，路径逐字 `harness/.agents/skills/bb-pipeline/SKILL.md`，`modelInvocable:true`。
- **复用循环**：m6-a（graph18，`createEnv:true` + `repos:["octocat/Hello-World"]`）→ 新建 env `project40`、响应 `reused:false`（现存 octocat env 全部被绑定，正确跳过），约 70s ready（root 派 1 个 setup worker clone，HEAD 7fd1a60）；`POST /singularity/graphs/graph18/delete` → env-clean 后 project40 `available:true, bound:false, sessionCount:0`，检出保留且干净（`.git/HEAD` mtime 未动）；m6-b（graph19，同参数）→ **`reused:true`、envId 同为 project40、约 10s ready、零 clone**——root 转录只有 `graph_mark_ready`（无 graph_spawn），setup prompt 原文 `Planned repositories: (none). Already present (do not reinstall): octocat/Hello-World.`，检出 `.git/HEAD` mtime 全程未变。
- **root skill 面**：m6-b root 的 `request/header` 工具面 23 个、含 `skill`、零 `mcp__*`（对照 graph16 root 的 22 个无 skill）；root 实调 `skill {"name":"bb-pipeline"}` 返回全文（base directory = 仓根 `.agents/skills/bb-pipeline`），并逐字复述五个章节标题（BB 领域任务划分参考 / 阶段地图 / 典型分解骨架 / 判据写法硬提醒 / 边界）。
- **互斥对照**（HTTP 原文）：无参数 → 400 `graphs: provide exactly one of createEnv, envId, workspace`；`envId+workspace` → 400 `graphs: envId cannot combine with createEnv, workspace, or fresh`；**`createEnv:true+workspace` 同给不报错，workspace 分支优先**（探针产物 graph20/project41，图已删、env 保留 available 且带 label `w`）——W24 任务书原预期"互斥报错"作废，以该实现语义为准（见 §5.2 前置条件）。
- 证据（均 gitignored）：root 转录 `.dsh/sessions/--home-ROXY-code-bb_work-harness-environment-project40--/{fb51e404-…(m6-a), a5a5824d-…(m6-b)}/session.v3.jsonl.zstd`；web 日志 `/tmp/dsh-web-m6.log`（无配置报错）。
- 现场：graph19 + project40 保留（复用机制实机现场）；graph18/graph20 已归档；现存 graph1–17 与 project1–39 一律未碰。

**2026-09-20 M7 VRTC 运行时语义真机验收**（W27 的实机复核；web 服务于 03:05 重启加载 03:05 重建的 lib，node PID 509507）：

- 静态：`pnpm build`（packages/singularity）绿；`verify-persistence` OK（4 roots 指纹不变）；单测 **638 全绿（59 文件）**，集成 **130 全绿（24 文件）**。
- **skill 面**：`skills/list` 实返 33 条（M6 基线 32 +1），`bb-pipeline` 与 `bb-obligations` 均在；bb-pipeline 改写核验：章节为 阶段地图 / 义务提问 / 判据写法硬提醒 / 边界——旧"典型分解骨架"步骤序列已删，新节明示"顺序用判据的 `requiresArtifact` 声明证据依赖"；`bb-obligations/obligations.yml` 实测 7 条模板。
- **建图 m7**（graph21，`envId:"project41"` 显式复用）：`reused:true`，约 5s ready、无 setup worker（root 转录只有 `graph_mark_ready`）。
- **分解与事件序列**（任务事件流 `.dsh/sessions/_no-cwd/sg-t-5091dda2-c2db-4b32-a048-48d3f0f6d32e/session.v3.jsonl.zstd`；root 首次分解即带上两个新字段，无需重投）：对照组 A（`t-f0ffc9a9`，判据 `cd octocat/Hello-World && test -f README`）seq 16→20 TaskStarted→TaskVerified；**探针 B（`t-27aac232`，判据带 `requiresArtifact:["m7_missing_trace"]`）无 HandoffCreated、无 TaskStarted（未 spawn）**：seq 22 `TaskBlocked`（reason 原文 `missing required artifacts: m7_missing_trace (criterion ac2-1)`）→ seq 23 恰一条 blocked ReviewRecord（anomalies 逐字同文、evidenceRefs `[]`、无 runId）→ seq 24 **`ObligationRecorded`**（goal 原文 `artifact/evidence "m7_missing_trace" required by task "t-27aac232-…" criterion ac2-1 does not exist in the task store`）；C（`t-39b16ba2`，dependsOn A）等到 A verified 后才 spawn（seq 25→30 TaskVerified），**C 的 handoff `assumptions` 恰三条**——声明的一条原文 + 自动并入的两条 `dependency evidence "evidence-r-006e4d40-…" is verified and available as a reference`，assumptions 接线与依赖证据自动并入双实证；父 composite failed 收口并点名 `t-27aac232-…(blocked)`（预期结局）。B 无 worker 会话目录（未 spawn 旁证）。
- **义务覆盖行**：root `task_status` 末尾实返 `obligations: 1 recorded` + `obligation coverage: 0/7 covered; uncovered: algorithm-correctness ("算法功能正确性（对 golden 参考）怎么判？") — satisfied, or forgotten?; …`（7 条全列——本图只有 `research` 能力，设计行为）。
- 偏差：零。无 429、无重投、无 spawn 失败。
- 现场：graph21 与 project41 保留；web 运行中（PID 509507）。

### 4.2 缺口与偏差（按优先级，均已取证）

| # | 问题 | 证据 | 建议 | 末次复核 |
|---|---|---|---|---|
| 1 | `capability.tools/skills` 曾是空接缝（只记账不授权），内置表把 buckyball 名字硬编码进库代码；**`preset` 那条是已接线的** | `task-runtime/src/index.ts:274-283,195`；`capability.ts:48-60` | **已解决（tools/skills 真授权已接线，并行工作，2026-09-18 本批复核确认；坐标 W21 刷新）**：capability 的 `tools` 写标签词表（`TOOL_LABELS`，`task-runtime/src/capability.ts:72-84`），解析时展开为真实 DSH 工具名，未知标签在落库前整批响亮拒绝并列出词表（`resolveToolLabels`，`capability.ts:93-103`；调用点 `task-runtime/src/index.ts:520`，持久化在其后的 `:546`）；worker spawn 时 grant = capability 面 ∪ baseline 面 ∪（命中能力自带 preset 时的）preset 面（`workerGrant`，`task-runtime/src/orchestrate.ts:194-204`；MCP 面由 `authorizedGrant` 并入，`:213-222`），经 `tools.restrict({allow})` 收敛继承面（`agent-runtime/src/grants.ts:100-117,249-262`），capability 声明而组合未提供的工具在 spawn 前响亮失败（`grants.ts:67-77`）；`skills` 经 `grantSkills` 把被授权 skill 钉进 worker 自己的 skill 层（`grants.ts:180-209`；诚实边界：DSH 无按 agent 隐藏 skill 的 API，grant 保证"在场"，不保证"只见这些"，`grants.ts:25-31`）。表已下沉 `config.yml` 文档 1 task-runtime 行（与代码默认**语义等价**、非逐字——配置 schema 会把缺省数组补成 `[]`，见本表 #18），`DEFAULT_CAPABILITIES` 保留兜底（`task-runtime/src/index.ts:287,316`）；`capability_list` 已补（见本表 #3）。集成断言 `tests/integration/worker-grant.spec.ts`。§4.3 第 1 条裁决就此执行完毕（2026-09-18） | 2026-09-18 |
| 2 | worker 没有 `ask_parent` 通道，但 worker prompt 却写着"向父级升级" | 当时 `task-runtime/src/handoff.ts:109`（"escalate conflicts through your parent"，修复后该行已改写）；全仓无 `ask_parent` 实现 | **已修复（2026-09-17）**：措辞改为符合实际能力的两条规则——人决策走 `ask_user_question`、无法继续则带原因 fail、由编排器阻断下游并上报父任务（`task-runtime/src/handoff.ts:138-139`）；`ask_parent` 工具仍未建 | 2026-09-18 |
| 3 | root 无从知道合法能力名（无 `capability_list`），"猜名 → 缺口 → 整批拒绝"是系统性的 | 当时 `task-decompose.ts` 无任何能力名提示 | **已修复（2026-09-17）**：`capability_list` 已注册（`agent-singularity/src/tools/capability-list.ts`）并加入 ROOT_TOOLS（`agent-runtime/src/index.ts:30`）；`task_decompose` 参数描述提示先查它（`task-decompose.ts:62-63`）；e2e 实证见 §4.1 末段 | 2026-09-18 |
| 4 | 权限模型未接线：root / worker 一律 `danger-full-access` | `agent-runtime/src/index.ts:161,190,251`（`:241` 已是 `isSeeded:false`） | **分级已接线、默认姿态未翻（2026-09-17）**：capability 新增可选 `permission` 字段（`task-runtime/src/index.ts:285-290` schema、`task/src/types.ts:125-135` manifest）；spawn 路径按"最严者胜"（sandbox 序 `read-only` > `workspace-write` > `danger-full-access`，approval 序 `ask` > `never`，`task-runtime/src/capability.ts:221-226,235-262` 的 `resolvePermission`）解析后经 spawn 请求的 `permissionPreset` 落到 `permissionPresets.set`（`task-runtime/src/orchestrate.ts:466,601-612`、`agent-runtime/src/index.ts:251`）；未声明保持 `danger-full-access`，root 的 createRoot/resumeRoot 不动；未知 preset 名在 spawn 前响亮失败（orchestrate 预检 + 原生 `resolve` 兜底）。机制交付、策略留人：`config.yml` / DEFAULT_CAPABILITIES 均未声明 permission。**M3 真机复核（2026-09-18）**：evolution 链首次把该 `permission` 字段真实写入生产 `config.yml`（capability `research` 行 `permission: workspace-write`，人工 approve 后），运行期 `capability_list` 即时反映、rollback 复原——"默认姿态未翻"仍然成立，但字段本身的写入/运行期覆盖/回滚机械面已真机走通（详见 §4.1 M3 段与 §4.2 #18） | 2026-09-18 |
| 5 | HITL 双实现（自建 `ctx.hitl` vs 原生 user-questions / approval）：自建那套没有 answerer 抽象、没有审计事件、没有 fail-closed | `agent-singularity/src/hitl.ts` | **已收敛（2026-09-17）**：`hitl_ask` → `ctx.userQuestions.ask`（`tools/ask.ts:20`）、`hitl_approve` → `ctx.approval.request`（`tools/approve.ts:19`，原生审计对 + fail-closed）；`ctx.hitl` 重写为两条 waterfall 的画布 answerer（`hitl.ts:62,69`），画布 UI（SSE + GET/POST 路由）不变；root session approval policy 钉 `'ask'`（`agent-runtime/src/index.ts:54-56`，调用点 `:162,191`）否则 `danger-full-access` 捆绑的 `'never'` 会让 approve 到不了 answerer。落地形态与链路证据见 §5.5 | 2026-09-18 |
| 6 | 契约每轮重注入 / 防 compaction 丢弃曾未实现（§2.6.3 声称的 L1 常驻覆盖不到）；当时只保证 spawn 时注入一次 + `task_read` 按需重取 | 当时 `task-runtime/src/handoff.ts` 只在 spawn prompt 写判据表；`packages/singularity` 内 `compaction` 零命中 | **已解决（2026-09-18，并行工作，本批复核确认）**：契约改走上游既有机制——渲染为 `<worker-contract>` 标记块（`task-runtime/src/contract.ts:62-87`，接线 `orchestrate.ts:609`），注册进 worker 自己作用域的 system-prompt section（`agent-runtime/src/contract-reinjection.ts:75-79`，接线 `agent-runtime/src/index.ts:255`）；agent-loop 每步把渲染结果重投影到 surface 节点 0，compaction 从不选 system 节点 0，渲染不变零额外写入、surface 丢失契约恰好一次写回（机制与上游行号证据见 `contract-reinjection.ts:9-27` 模块注释）。这正是 §4.3 上游 v3 采纳第 ① 条的落地。集成测试 `tests/integration/worker-contract.spec.ts`（fold 遮蔽 spawn prompt 后契约仍在 surface 首位）。`task_read` 按需重取保留为第二通道 | 2026-09-18 |
| 7 | `task_verify` 的工具描述写 **"Records no task status"**，但底层 `verifyRun` 会写 evidence（终态 run 会报错） | `agent-singularity/src/tools/task-verify.ts:33-35`；`verifier/src/index.ts:127`（`verifyRun` 末尾 `recordEvidenceIn`） | **已修复（2026-09-17）**：描述诚实化为 "Records evidence but no task status" 并声明终态报错前置（`task-verify.ts:33-35`）；终态 run 先回友好错误文本（`:45-46`） | 2026-09-18 |
| 8 | 能力名缺项 / 重复：缺 `integrate-model` / `build-*` / `dispatch-verification`；三个 verify 能力名配置完全相同 | `task-runtime/src/index.ts:274-283`；§5.2 | **已解决（2026-09-18，W21；dispatch 条目同日经人类裁决撤下）**：能力名补齐已落地——表重写后新增 `build-chip-config` / `build-compiler` / `build-workload` / `build-kernel`（`mcpServers: [bbdev]`）、`integrate-model`（skill 形态：`workload-tests`）；`check-ball-registration` 解锁（`mcpServers: [bbdev]` → `mcp__bbdev__validate`，`verify` / `check` 两个 skill 本就按 MCP 工具名写）；三个 verify 条目不再指向占位插件——统一挂 spawn 级 `bbdev` MCP server + `bb-verify` 组合，`run-verilator-regression` 另加 `waveform` skill（RTL 失败要 cycle 级定性）；三者表面相似是因为授权粒度就是整个 server，区分落在判据命令上（§5.3 已写明）。`dispatch-verification` 曾在 W21 上表（挂 W20 的 `bb-dispatch-mcp`），同日 2026-09-18 人类裁决"dispatch/CI 脚本只作编写 MCP 的参考、不作验证路径"，经裁决不入表，W22 撤下（能力行、`bb-dispatch` 注册项与包一并拆除，现表 13 条，三处逐字一致：`DEFAULT_CAPABILITIES` / config.yml 文档 1 / `config.yml.example`）。机制裁决与逐项理由见 §4.3 W21 记录及末条人类裁决。**已经 M5 真机验证（2026-09-18）**：graph16 上 `check-ball-registration` 与 `run-bemu-regression` 两个 worker 真实挂载 bbdev（各 45 个 `mcp__bbdev__*` 工具在 worker 面、root 面为零），`mcp__bbdev__validate` 真调真过、bemu batch submit/poll 链路真机可达——逐项证据见 §4.1 M5 段；唯一新缺口是 bbdev 侧 `task_cancel` 不可用（#19） | 2026-09-18 |
| 9 | 多余 / 残留：`verifier/pnpm-lock.yaml` 嵌套 lockfile；7 个 `canvas-*` 目录上游已删，本仓只剩残留目录（无源码，只有 `node_modules`） | `git status`；上游 `188bd03` | **已修复（2026-09-17）**：`verifier/.npmrc` / `verifier/pnpm-lock.yaml` / 失效 overrides 已删（`verifier/package.json` 无 overrides）；7 个 `canvas-*` 残留目录已删（活着的 `canvas-view` 包保留） | 2026-09-18 |
| 10 | 环检测 DFS 三 / 四份拷贝（graph / task / admission） | `graph/src/service/state.ts:93-104` 等 | **已修复（2026-09-17）**：task 包导出共享 `reaches`（`task/src/types.ts:50`），task/state 与 task-runtime/admission 复用（`task/src/service/state.ts:1`、`task-runtime/src/admission.ts:1`）；graph 不依赖 task 层，保留自有副本（`graph/src/service/state.ts:93`） | 2026-09-18 |
| 11 | README 未更新（包表与工具清单都没提新包 / 新工具）；`lib/` 是入库产物，必须跟着源码提交 | `git diff -- README.md` 为空；`git ls-files` 19 个 lib | **已修复（2026-09-17）**：README 补 task / verifier / task-runtime 三行与 `task_*` 工具（`packages/singularity/README.md:26-29`）及持久化纪律一节（`:45`）；`lib/` 已随源码重建 | 2026-09-18 |
| 12 | spawn 失败被 catch 静默吞掉：只标 outcome，不写 TaskFailed / ReviewRecorded、不改任务状态——子任务永停 `admitted`（幽灵），root 的 composite cause 混入永远不到终态的子任务，这类基建失败永远不进事件流 | graph8 任务事件流 `.dsh/sessions/_no-cwd/sg-t-ca1d0bf0-4794-423e-8625-99a545d826da/session.v3.jsonl.zstd`：seq 31 `HandoffCreated t-c1a8b845…` 之后该任务无任何后续事件；根 `TaskFailed` reason 原文 `mandatory criteria not satisfied: root-children-verified fail (unverified children: …, t-c1a8b845-df48-4a68-918e-de91eae255f3(admitted))` | **已修复（2026-09-17）**：run 创建提前到 spawn 之前，spawn catch 命名捕获并把该 run 收敛为 `TaskFailed`（reason `spawn failed: <message>`）+ 紧跟一条 `ReviewRecorded`（outcome=failed、localizedCause 同文、evidenceRefs=[]）（`task-runtime/src/orchestrate.ts:584-621`）；依赖者照常 blocked、父 composite 照常失败收口（单测 `task-runtime/tests/unit/orchestrate.spec.ts`、`review-record.spec.ts`）。**W11 实跑复核（2026-09-17 夜）：graph9–graph12 未再出现 spawn 失败幽灵，但该路径本轮未被真实触发**。**M4 实跑验证（2026-09-18，graph15，探针 `broken-probe: { preset: ghost-preset }` 刻意引爆 spawn）**：P `HandoffCreated`→`TaskStarted`（run 先建）→`TaskFailed`（reason 原文含 `spawn failed:` 与 `ghost-preset`）→`ReviewRecorded`（failed、localizedCause 逐字同文、evidenceRefs `[]`）；Q 无 run `TaskBlocked` + 恰一条 blocked record（`blockedBy:[{P, failed}]`）；父 composite failed 收口；全 store 无 admitted 残留——事件流 `.dsh/sessions/_no-cwd/sg-t-8dcf56b5-6ff5-4788-b793-a912a298bc13/session.v3.jsonl.zstd` seq 10–21，探针已清场（config.yml sha256 复原、重启后 `capability_list` 8 条无探针行），详见 §4.1 M4 段 | 2026-09-18 |
| 13 | 能力表 `research.preset: 'default'` 悬空：preset 发现根里没有 `default`（内置 cordis/minimal/ptc/standard + `.dsh/.agent-presets/bb-verify`），准入不校验 preset 存在性，spawn 时才由上游抛 `agent-presets: preset "default" not found (available: …)` | graph8 子任务 D 的 `CapabilityResolved` manifest 原文 `{"capabilities": {"research": {"skills": [], "tools": [], "preset": "default"}}, "missing": [], "closure": "closed"}`（同上事件流 seq 17）；错误格式见上游 `thirdparty/deepseek-harness/packages/preset/agent-presets/src/index.ts:380` | **已修复（2026-09-17）**：`DEFAULT_CAPABILITIES` 与 `config.yml` 文档 1 / `config.yml.example` 注释块同步改 `'standard'`（`task-runtime/src/index.ts:282`、`config.yml:142`、`config.yml.example:126`）；orchestrate 新增 `assertPreset` 预检，悬空 preset 在 spawn 前抛带能力名/preset 名的错误，经同一条 catch 落成 failed+record（`task-runtime/src/orchestrate.ts:449-461,601`、`task-runtime/src/index.ts:702-709`）；admission 全量 preset 校验要跨服务，留作 backlog。**修复已经 graph12 实跑验证（2026-09-17 夜）**：新代码下 `capability_list` 实返 `research — … preset: standard`，全部子任务 spawn 无悬空 preset 错误。**注**：M3 rollback 后 `config.yml:142` 该行文本为归一化形态 `research: { skills: [], tools: [], preset: standard }`，与代码默认语义等价（见 #18）。（W21 整表重写后该行回到简写形态 `research: { preset: standard }`——语义不变，且 W19 的 config-text champion 机制从此钉的是新文本——2026-09-18） | 2026-09-18 |
| 14 | **取消路径幽灵（W11 新发现）**：取消在飞子任务后，cascade 的 aborted 分支只给剩余子任务填 outcomes，**不落 TaskBlocked/TaskCancelled 事件、不写 ReviewRecord**——剩余子任务永停 `admitted`。与 #12 同类但路径不同（#12 修的是 spawn 失败） | graph10 任务事件流 `.dsh/sessions/_no-cwd/sg-t-9b8d52cf-1481-464d-8651-74afc5da10b1/session.v3.jsonl.zstd`：D（t-97495595）`TaskCancelled` 后，C（t-e0d1da13）只有 Created/Admitted/DependencyAdded/CapabilityResolved，无任何终态事件；`task-runtime/src/orchestrate.ts` aborted 分支（`for (const rest of remaining) outcomes[rest] = …` 后直接 break） | **已修复（2026-09-17，W12）**：收敛未启动子任务改走 `blockRemaining()` 一条路径（`task-runtime/src/orchestrate.ts:525-531`）——在飞取消分支（`:639-645`）与循环顶 abort 分支（`:549`）的剩余子任务落**无 run 的 `TaskBlocked`**（reason 原文 `cancelled by the caller before this child started`，常量 `:76`）+ 恰一条无 run 的 `blocked` ReviewRecord（带 `anomalies`，依赖被取消子任务者另带 `blockedBy`），outcome 相应报 `blocked`；verifier 缺失的收敛分支同纪律（`:688`）。**取舍（为何不落 `TaskCancelled`）**：reducer 的 `TaskCancelled` 只接受 `running` 任务（`task/src/service/state.ts:164-169`），而无 run 的 record 只允许 `blocked`（`task/src/service/state.ts:231-237`），未启动的子任务两条都够不着；"被调用方取消"由 reason 文本承载，状态机不动。单测：`task-runtime/tests/unit/orchestrate.spec.ts`（在飞取消 ⇒ `['cancelled','blocked']`、恰一条 record、全 store 无 `admitted`；预取消 ⇒ 整批 blocked）、`task-runtime/tests/unit/review-record.spec.ts`。另有机制事实需记下：**verify 阶段不响应 abort**（`withTimeout` 无 signal），取消语料只能在 worker 在飞窗口制造。**已经 M2 实跑复核（2026-09-17 晚，graph13）**：X（`sleep 300` 在飞）取消后 X `TaskCancelled`+cancelled record、Y（dependsOn X、未启动）无 run `TaskBlocked`（reason 原文逐字一致）+ 恰一条 blocked record（`blockedBy:[{X, cancelled}]`）、父 run cancelled 收口、全 store 无 admitted 残留；证据 `.dsh/sessions/_no-cwd/sg-t-1805b4f6-04ce-4ac2-a9a6-b7a74fae1610/session.v3.jsonl.zstd` seq 14–19（详见 §4.1 M2 段） | 2026-09-18 |
| 15 | **evolution 工具运行时断线（W11 新发现，P5 阻塞）**：`EvolutionService` 经 `ctx.plugin(EvolutionService)` 注册在 SingularityAgent 的子 fiber，而 `SingularityAgent.inject`（现 `agent-singularity/src/index.ts:73`）未声明 `'evolution'`——cordis 对未声明的服务访问直接抛 `cannot get property "evolution" without inject`，五个 `evolution_*` 工具在真实运行时全部不可用。单测直构造服务、集成测试未经插件上下文驱动工具，所以没拦住 | graph12 root 转录（`environment/project35` 会话存储）：`evolution_propose` / `evolution_list` 均返回该错误原文；台账 `.dsh/evolution/` 零创建（fail-closed 成立）；对照：`ctx.hitl` 能用是因为消费方 graph-web 声明了 `inject: […, 'hitl']`（`graph-web/src/index.ts:39`） | **已修复（2026-09-17，W12）**：原建议的"`SingularityAgent.inject` 补 `'evolution'`（一行）"**不可行**——`evolution` 恰恰由本插件自己的子 fiber 提供，父 fiber 声明它只会永远停在 PENDING；W12 实测（把 `'evolution'` 加进 inject）插件停在 PENDING、body 从不执行——工具一个都不注册（`await ctx.plugin(...)` 会立即返回而不是报错），比原缺陷更糟；而且它无法自行解除：唯一的提供者恰恰由那段永不执行的 body 创建。改为让 ledger 服务挂在消费它的 fiber 上：`new EvolutionService(ctx)`（`agent-singularity/src/index.ts:78-81`，注释写明缘由），五个工具照旧读 `ctx.evolution`；HitlService 保持子插件（它 inject `userQuestions`/`approval` 需要等待，且消费方 graph-web 是声明 inject 的跨插件消费者）。**审计顺带发现同类断线的第二处并一并修**：`hitl_ask`/`hitl_approve` 从本插件 ctx 读 `ctx.userQuestions` / `ctx.approval`，而 inject 漏声明（这两个服务由 sibling 插件提供，声明是安全的，不会死锁）→ `SingularityAgent.inject` 补 `'userQuestions', 'approval'`（`agent-singularity/src/index.ts:73`）。新增插件上下文级集成测试 `packages/singularity/tests/integration/evolution-tools.spec.ts`：真实 `ctx.plugin(SingularityAgent)` + sibling 依赖插件，驱动 `evolution_propose` / `evolution_list` 落账与读回（修复前该测试原文报 `cannot get property "evolution" without inject`），并驱动 `hitl_approve` 验证 approval 解析。**已经 M2 实跑复核（2026-09-17 晚，graph12 root 会话续投）**：新构建下五个 `evolution_*` 工具全部真实跑通、无 inject 报错；propose 双路径、candidate、gate、decide（画布代答 approve）、list 全链落账，台账 5 行、history 四跳完整；证据 `.dsh/evolution/proposals.jsonl` 与 project35 root 转录（详见 §4.1 M2 段） | 2026-09-18 |
| 16 | **setup 委派路线是 root 自由心证（W11 新发现）**：setup prompt 只说"delegate to a worker"，root 可能选 `graph_spawn`（graph9/10/12）也可能选 `task_decompose`（graph11）——后者烧掉根任务唯一一次分解额度，且 setup 判据若写成 review 模式永不通过，根任务直接 failed | graph11 任务事件流 `.dsh/sessions/_no-cwd/sg-t-3977348d-c27b-4253-9ded-231e98a346b3/session.v3.jsonl.zstd`：seq 4-6 root 对 setup 调 `task_decompose`（1 child，ac1-2/ac1-3 `manual review required`）→ 父子双 failed | setup prompt 显式禁 `task_decompose`（或拆分 setup 专用工具）；在硬约束写进图名后 graph12 未复发，可作临时缓解。**已修复（2026-09-17，W13）**：分工逐字写进两条 prompt——root 侧「环境安装一律 `graph_spawn`，`task_decompose` 只许用于用户 objective，根任务只有一次分解额度，花在 setup 上直接失败」（`agent-runtime/src/prompts/root.prompts.ts:4,6`）、setup 侧「用 `graph_spawn` 委派，**never with `task_decompose`**」（`graphs/src/prompts/setup.prompts.ts:8`）。**只改措辞**：准入逻辑与工具白名单不动，`task_decompose` 对 setup 仍是"合法但错误"的调用，硬约束仍只有"同链一次分解"这一条护栏；prompt 文案无自动化断言，真机（root 收到 setup prompt 后的选路）未复跑 | 2026-09-18 |
| 17 | **approval 瀑布被网关转发器优先认领（M2 新发现）**：真实 web 部署里 `ctx.approval.request` 的瀑布先被 api-remotes 的转发监听器认领——无浏览器 mux 客户端时请求无限挂起、画布 `GET /singularity/hitl` 待办恒空；画布 answerer（HitlService）只有在某 mux 客户端对该 waterfall 答 `next` 委托后才收到。集成测试没拦住：`tests/integration/hitl.spec.ts` 在同一 ctx 上直派瀑布，不经过网关转发器 | graph12 root 转录 seq 149 `approval/asked` 后 15 分 01 秒无 `approval/decided`（12:15:43Z → 12:30:44Z），期间两次 `GET /singularity/hitl` 实返 `{"pending":[]}`、`ss -tnp` 确认 3080 零客户端连接；驾驶员以 mux 客户端连 `/api/remote.mux` 开 `$events` 流、对该 waterfall 答 `{kind:'next'}` 后画布卡片立即出现，再 `POST /singularity/hitl` approve → seq 150 `approval/decided allowed-once` 落账；机制：`thirdparty/deepseek-harness/packages/api/remotes/src/index.ts` `forwardWaterfall`（`:135-158`）只在队列关闭或客户端委托/作答时才调 `next()`，零客户端时 `settled` 永不落定——它按注册顺序抢在画布 answerer 之前（api-remotes 属 web-app bundle，先于本仓 singularity bundle 装载） | 三个候选：① 画布 UI 内嵌 approval 呈现（浏览器 mux 客户端直接作答）、② HitlService 注册前移、③ 转发器加零客户端自动 `next()` 回退。**已修复（2026-09-17，W13，选 ②）**：候选 ② 是唯一不动 `thirdparty/` 就能落地的——`ctx.on(..., { prepend: true })` 把监听插到既有监听之前（`thirdparty/deepseek-harness/vendor/cordis/src/events.ts:255`），画布 answerer 抢在转发器之前认领，零 mux 客户端时请求立即成为画布卡片（`agent-singularity/src/hitl.ts:62-74`，两条瀑布同改）；转发器退到 `next()` 之后。**上游升级要重核**：本修复依赖 cordis waterfall 的"先注册先认领 + `prepend` 插队"语义与 `forwardWaterfall` 的认领条件（`:135-158`），两者任一改动都会让画布重新收不到请求。**取舍**：浏览器 mux 客户端不再收到 singularity agent 的 approval/单问 user-question（画布成为本部署唯一 HITL 面，与 §5.5 的设计一致）；候选 ③ 需改上游且要判"零客户端"，否决。**集成测试**：`tests/integration/hitl.spec.ts` 新增两例——先注册一个永不调用 `next()` 的"park 型转发器"（等价零客户端）再建 `HitlService`，断言卡片可见、转发器未被调用、画布作答后 `allowed-once`；修复前该两例即失败（`hitl.list()` 为空，正是 M2 的"待办恒空"）。**验证边界关闭（2026-09-18，M3）**：真机零客户端拓扑已复跑——graph14 全程零 mux 客户端，`evolution_decide` 一发起 approval，`GET /singularity/hitl` 即返回完整 approve 卡片（六问全文 + version set），`POST` 同端点 approve 后转录落 `approval/decided allowed-once`；两条链共 6 次 approval 全部同路径成功，其中 decide 挂起 104.7s、apply 78.9s 期间台账与 config.yml 零写入（详见 §4.1 M3 段） | 2026-09-18 |
| 18 | **capability rollback 的文本归一化（M3 新发现，非功能性偏差）**：`evolution_rollback` 恢复 champion 快照时，复原后的 `config.yml` 行**语义相同但文本不同**于 apply 前的原文。apply 前该行写作 `research: { preset: standard }`，rollback 后写成 `research: { skills: [], tools: [], preset: standard }` | M3 真机：apply 前 `config.yml` sha `c3baf695…`，apply 后 `65c09a2f…`（仅 research 行变），rollback 后 `129763b4…`——`diff` 显示唯一差异就是 research 行多了 `skills: [], tools: []`；doc2 `api:` 块与其余行 sha 全程一致。根因：`evolution_prepare` 的 capability champion 取自 `ctx.taskRuntime.listCapabilities()`（运行注册表），而配置 schema（`task-runtime/src/index.ts:285-290` 的 `Capability`）把缺省数组补成 `[]`，故快照已是归一化形态，写回即带出（§4.1 M3 段） | 不影响行为（同一 preset、无 permission，`capability_list` 逐字复原）。**已修复（2026-09-18，W19）**：capability prepare 的 champion 改取源文本锚点——`prepared` 记录新增 `championSource` 三态字段（`agent-singularity/src/evolution.ts:149-151`）：config.yml doc1 有该条目 → `config-text`（快照加存该条目逐字源文本 `champion/capability-table.source.txt`，rollback 经 `restoreCapabilityRowSource` 逐字写回，`config-edit.ts:209-231`）；条目只在代码默认表 → `code-default`（快照存注册表语义副本供对比，rollback = 删 config.yml 行恢复默认生效 + 运行期覆盖回默认条目，`evolution.ts:1066-1071`）；能力不存在 → `missing`（语义不变）。运行期覆盖（applyCapabilityRow）语义不变。向后兼容：M3 的 m3-prop-cap 等无 `championSource` 的旧记录按注册表形态照旧回放/回滚（`evolution.ts:1072-1075`），fold 对伪造 championSource 响亮拒绝。单测：`evolution.spec.ts` config-text sha256 往返逐字复原、code-default 删行往返、pre-W19 记录旧语义回放 | 2026-09-18 |
| 19 | **bbdev MCP `task_cancel` 不可用（M5 新发现，buckyball 侧缺陷）**：`mcp__bbdev__bbdev_task_cancel(trace_id=…)` 真实调用两次均返回 HTTP 400 `trace_id is required`——API 路由 `POST /task/{trace_id}/cancel` 的 path_params 在 iii/motia 运行时下回填为空，handler 在入队取消事件之前就 return 400，取消请求从未生效 | graph16 任务 R 的 worker 实调取证：worker 转录 seq 30 / seq 35 两次 400，原始返回落盘 `environment/project38/DangoSys/buckyball/m5-bemu-trace.txt` §3/§3b。根因定位（worker 自查 + 驾驶员复核源码）：同源缺陷在 `/result/{trace_id}` 上已被项目自己记录并绕过（`bbdev/mcp/common.py:214` 注释 "HTTP /result path_params are broken"，`task_status` 因此改直读 iii 文件状态库），而 `task_cancel`（`bbdev/mcp/tools/task_cancel.py:15` 直 POST、`bbdev/api/steps/common/02_cancel_api.step.py:14` 取 `request.path_params`）没有等价兜底。副作用：submit 出去的任务无法取消，本次 elf-tests batch 跑到自然结束（returncode 0，≤68s）——长任务"submit 后立即 cancel"的取证/止损路径因此不存在 | 属 buckyball 仓 bbdev 的缺陷，不在本仓修复面；submit → task_status 轮询链正常。后续（buckyball 侧）：给 `task_cancel` 加与 `task_status` 同款的文件态兜底，或修 iii 的 path_params 回填。在此之前，长任务不要把"可调 cancel"写进操作假设 | 2026-09-18 |

| 20 | **【对照缺口·偏差】顺序是顺序边、不是证据依赖（KISS §5.1）**：领域主干顺序只以 `dependsOn` 表达；契约里没有"证据依赖"（`requires_artifact`），`assumptions` 是死字段（恒空），下游契约不注入上游产物/证据引用——上游产物已存在时"合法跳过"因此无法被契约识别 | `task/src/types.ts:119` 声明 `TaskHandoff.assumptions`，唯一赋值点 `task-runtime/src/handoff.ts:50` 只搬调用方入参，编排器 `task-runtime/src/orchestrate.ts:596-605` 不传；`:602-604` 只把依赖任务的 evidence id 放进 handoff `relevantEvidence`；`requiresArtifact`/`requires_artifact` 全包零命中（2026-09-20 grep，范围：task / task-runtime / verifier / agent-runtime / agent-singularity 的 src） | **已解决（2026-09-20，W27；M7 真机复核）**：`AcceptanceCriterion` 增可选 `requiresArtifact`（`task/src/types.ts:25`），admission 只做结构校验，存在性放 spawn 前（`task-runtime/src/orchestrate.ts:194` 的 `missingRequiredArtifacts`，按 evidence id / artifact kind / artifact id 三种拼法匹配）；缺产物 → 不 spawn、落无 run 的 `TaskBlocked` + 恰一条 blocked ReviewRecord（anomalies 逐字点名缺失项；blockedBy 留空——缺失物不是任务）+ 每缺失项一条 `ObligationRecorded`；assumptions 接线同批（`DecomposeChildSpec.assumptions` + spawn 前自动并入依赖兄弟证据引用，`orchestrate.ts:659`）；产物已存在则合法跳过（单测覆盖）。M7：graph21 探针 B 未 spawn 直接 blocked + 义务登记、C 的 handoff.assumptions 恰三条（§4.1 M7 段） | 2026-09-20 |
| 21 | **【对照缺口·方向性待建】无 Obligation 概念（KISS §2/§5）**：生长信号"还缺什么"（Obligation）在代码里不存在；分解完全由调用方 `task_decompose` 的 children 列表决定，没有"义务→能力→分解"的链路，也没有义务模板覆盖检查（漏桥闸） | `obligation` 全包零命中（2026-09-20 grep）；分解入口 `agent-singularity/src/tools/task-decompose.ts:75-91`；失败/阻塞不产出"还缺什么"的结构化记录（见 #22） | **最小版已落地（2026-09-20，W27；M7 复核）**：登记 = `ObligationRecorded` 事件（`task/src/types.ts:692`，reducer 校验 id 唯一 / goal·criterion 非空 / sourceTask 存在），登记点 = 缺产物阻塞（挂该子任务）与能力缺口整批拒绝（挂父任务，`task-runtime/src/index.ts:552`）；覆盖检查 = `task-runtime/src/obligation.ts`（扫 `.agents/skills/*/obligations.yml` 全部模板、JSON-as-YAML 解析零新依赖、findRepoRoot 8 层向上找 `.git`），出口在 `task_status` 末尾覆盖行（best-effort，漏覆盖只提示不阻塞）；模板正本 `.agents/skills/bb-obligations/obligations.yml`（7 条）。全局调度器不做（计划口径）。M7：义务登记与 `0/7 covered` 覆盖行实返（§4.1 M7 段） | 2026-09-20 |
| 22 | **【对照缺口·偏差】BLOCKED 是死胡同、无 L4 ESCALATE（KISS §5/§7）**：依赖未验证 → 下游 `TaskBlocked` 后没有上游义务生长、没有重规划、没有上报；blocked 无出边（状态机只能从 `failed` 重试），该分支永久终止 | `task-runtime/src/orchestrate.ts:553-573`（`blockRemaining` 只写 blocked 与无 run 的 record）、`:583-588`（ready 空 → blockRemaining → break）；`task/src/service/state.ts:62`（`TaskRetried` 只接受 `failed`）；KISS §7 形态的 escalation 事件全包未建（`agent-singularity/src/tools/review-escalation.ts` 是评审升级判据，语义不同） | blocked 时把"缺的依赖/能力"登记为义务并触发上游生长或 ESCALATE（KISS §5.1 第 1–2 步、§7 L4 上报也是 Task）；W27（2026-09-20）新增的"缺产物 blocked"路径同样无重试出边（`TaskRetried` 只接受 failed），与本条同坑、一并排期 | 2026-09-20 |
| 23 | **【对照缺口·偏差】预算死字段（KISS §5/§8.6）**：`budgetPolicy`（tokens/wallTimeMs/attempts）声明后零读者；无超限 ESCALATE、无 no-progress 闸；粒度阈值虽已外置（深度/批量，见 §5.3），预算路径整条缺失 | `task/src/types.ts:25` 是唯一定义，src 内无读者（唯二提及为 `agent-singularity/src/tools/evolution-prepare.ts:24` 的注释与构建产物 `lib/index.d.ts`；2026-09-20 grep）；`task-runtime/src/index.ts:198-217` 的 Config 只有 verifyTimeoutMs / maxDepth / maxChildren / allowRuntimeDecomposition；`escalat`、no-progress 检测在 task / task-runtime / verifier / agent-runtime src 零命中 | KISS §5"预算即法律"与 §8.6"粒度外置"：先把预算外置进 config，再给编排器加"耗尽 → ESCALATE"的强制出口；`attempts` 与 retry 分支（§3.1 Non-Goals 现列为不建）一起排期 | 2026-09-20 |
| 24 | **【对照缺口·偏差】判据三值、无 UNKNOWN 二分、AC 不挂 verifier（KISS §4.1/§4.3）**：只有 `pass`/`fail`/`inconclusive`；`inconclusive` 与 `fail` 同收敛，不区分"没测过（UNKNOWN_TASK）"与"裁判坏了（UNKNOWN_VERIFIER）"；AC 不挂 `verifier_ref`，按 `verificationMode` 分发到内置 verifier | `task/src/types.ts:81,92`（三值）；`task-runtime/src/orchestrate.ts:731-743`（unmet 不区分 inconclusive 与 fail）；`verifier/src/review-verifier.ts:13-20`（review/formal 恒 inconclusive）；`task/src/types.ts:9-16`（AC 无 verifier 引用）、`:576-580`（`Verifier` 只有 id/supports/verify）；`UNKNOWN_TASK`/`UNKNOWN_VERIFIER` 全包零命中 | 补四值语义，或至少在 review / 升级判据里区分两种 UNKNOWN；AC 增可选 `verifierRef`（缺省按 mode 分发，向后兼容）——KISS §12 第 2 步"刹车"的一部分 | 2026-09-20 |
| 25 | **【对照缺口·偏差】Verifier 注册表无 owner/version/selftest（KISS §4.3）**：注册表只有 id；I3"执行者不裁判"没有 owner 字段可判；判决召回（KISS §8.2）缺 `(verifier_ref, verifier_version)` 索引键；"未验不入库 / 每个验证器能区分已知正负样本"无 selftest 载体。现行分离靠结构：verifier 在编排器侧跑，worker 的 `task_verify` 只写证据不改状态（§4.2 #7） | `verifier/src/index.ts:87-93`（`Map<id, Verifier>` 仅查重）；内置 id 硬编码 `verifier/src/command-verifier.ts:74`、`composite-verifier.ts:22`、`review-verifier.ts:7`；`task/src/types.ts:576-580`；`agent-singularity/src/tools/task-verify.ts:33-35`；`selftest` 全包零命中（2026-09-20 grep） | 注册表增 `owner` / `version` / `selftest {positiveCases, negativeCases}` 元数据；与 §4.2 #7 的描述诚实化不冲突 | 2026-09-20 |
| 26 | **【对照缺口·偏差】组合验收只有"子全 verified"的合取、缺 C2/C3/C4（KISS §6）**：无 C2（子保证的合取覆盖父 AC 的机械检查）、无 C3（子假设可满足性与无环）、无 C4（独立组合不变量 verifier）——军规 6 点名"父任务只做子结果的逻辑与 → 错" | `verifier/src/composite-verifier.ts:47-53`（unverified 列表 → fail）；`task/src/types.ts:592-606`（root 固定一条 composite 判据）；组合检查代码全包零命中（2026-09-20 grep） | 父契约允许独立 `composite_verifier_ref`（C4）；C2 做成脚本（数值/接口变量上可机械判定，自然语言条款退 LLM 并标注启发式判定） | 2026-09-20 |
| 27 | **【对照缺口·方向性待建】GAP 阶梯未建（KISS §7/I2）**：能力缺口 = 整批原子拒绝 + `CapabilityGapDetected` 事件（reducer 为 no-op 断言），事件之后无任何下游动作；没有 L1 组合 / L2 生成 / L3 引入 / L4 上报的阶梯，也没有"缺口是合法状态"的处置（现行 fail-closed 与 §2.4.3"允许 task 先进入执行"相反，指南自标"部分"） | `task-runtime/src/index.ts:521-530`（missing 且未标 decomposable → 整批 throw）、`:560-562`（落事件）；`task/src/service/state.ts:64`（no-op）；L1–L4 阶梯代码未建（`agent-singularity/src/evolution.ts:46` 的 L1–L4 是 mutation 敏感度级别，语义不同） | KISS §12 第 3 步"先只做 L1/L2/L4"：先补 L4 出口（ESCALATE 事件 = 一条任务），再做 L1/L2 组合与生成 | 2026-09-20 |
| 28 | **【对照缺口·方向性待建】Retro 与分层接受度量未建（KISS §9/§8.1）**：无轨迹回流——ReviewRecord / Diagnosis / 提案全部 caller-triggered，失败轨迹不自动产出结构化提案；接受规则只有 Gate 六问（自由文本），没有按 targetType 分层的接受度量（§8.1：Verifier 类提案禁用通过率、需逃逸率/变异检出率；Task 模板需难度归一化通过率）；replay 的 observed/holdout 合并成一个总评、holdout 可空仍可 not-worse，且 verdict 不约束 gate/decide/apply（gate 只查报告存在性） | `task/src/service/state.ts:255-256`（诊断 caller-triggered）；`agent-singularity/src/replay.ts:119-124`（组内总评）；`agent-singularity/src/tools/evolution-replay.ts:310-321`（observed+holdout 一起过总评）；`agent-singularity/src/evolution.ts:896-904`（gate 只查引用存在）；被拒提案有落账（decided 记录与可选 `note`：`agent-singularity/src/evolution.ts:274-290`；落账入口 `:932-950`）但无分层度量 | KISS §12 第 4 步"轨迹存储 + 最简 Retro + 分层接受规则"；在此之前不引入任何自动接受 | 2026-09-20 |
| 29 | **【对照缺口·偏差】Skill 层无契约（KISS §4.2/§8.6）**：skill 在本包内只是字符串名字——能力表的 `skills` 原样拷贝、准入期零校验（对比 tools 走标签词表、mcpServers 走注册表校验），名字不存在要到 spawn 才响亮失败；没有 `capability_provided` / `precondition` / `inputs` / `outputs` / `required_tools` / `verifier_ref` / `reliability` 任何字段；成熟度 EXPERIMENTAL→…→DEPRECATED 见 §2.4.2 自标"未建" | `task-runtime/src/capability.ts:210-216`（skills 原样拷贝）vs `:93-103`（tools 标签展开）、`:9-17`（mcpServers 校验）；`agent-runtime/src/grants.ts:200-205`（spawn 才失败）；DSH 侧 SKILL.md frontmatter 只支持 name / description / whenToUse / metadata 与两个布尔（`thirdparty/deepseek-harness/packages/skill/skill-filesystem/src/index.ts:797-840`），无 allowed-tools / version / verifier 位 | 侧车 skill 注册表（不改 DSH loader）：`capability_provided` / `precondition` / `verifier_ref` / `reliability`；"未验不入库"在 evolution apply（skill 类）处强制；规范已冻结（2026-09-20，§2.4.8）：字段与成熟度入侧车注册表、"未验不入库"在 evolution apply（skill 类）处强制——机制本体未建，落点见临时计划阶段 3.2 / 5 | 2026-09-20 |
| 30 | **【对照缺口·偏差】领域包含步骤序列（KISS §12）**：现有领域包 `bb-pipeline` 含"典型分解骨架"（三条带 `dependsOn` 箭头的步骤序列），与 KISS §12"领域包里不允许出现步骤序列"冲突；KISS 对应自检是"模板删除测试" | `harness/.agents/skills/bb-pipeline/SKILL.md`（2026-09-20 读取）的"典型分解骨架"一节；对照 KISS §5.1 义务模板（问"你的差分参考在哪"，而不是"你必须做 BEMU"） | **已解决（2026-09-20，W27；M7 复核）**：bb-pipeline "典型分解骨架"一节的三条 dependsOn 步骤序列整节删除，改写为义务提问式七行表（问题 + 通常由哪个能力回答），节顶部指明 `bb-obligations` 的 `obligations.yml` 为义务模板正本，并写明顺序用判据 `requiresArtifact` 声明、不写 dependsOn 链条；阶段→能力映射表与判据硬提醒（环境事实）保留；`skill-file.spec.ts` 解析用例未改且通过。M7：改写后章节实测为 阶段地图/义务提问/判据写法硬提醒/边界，`skills/list` 正常发现 | 2026-09-20 |
| 31 | **【对照缺口·计划内后置】KISS §8 其余机制未建（§8.2–§8.5）**：判决召回、验证债、验证器变异测试、独立性预算均未建；KISS §12 把它们排在"之后"，属计划内后置。其中 §8.5"能用工具验证的不用模型、能不用同一模型的就不用"与现行"评审 agent 用部署默认模型与 preset、无第二裁判"是同一件事，引入 agent 判读时需记独立性预算 | `suspect` / `debt` / `diversity` / `success_rate` / `selftest` 全包零命中（2026-09-20 grep）；`agent-singularity/src/tools/review-agent.ts:240-246`（评审 agent 单模型单 preset） | 按 KISS §12 排期；判决召回依赖 #24 / #25 先落地（version 与 owner） | 2026-09-20 |
| 32 | **env `sessionIds` 只增不减，老 env 永远不可复用（M6 前置取证）**：每次 spawn 都 `attachSession`（`graphs/src/index.ts:65-68`），停止/终态无对称 detach；available 判定要求 `sessionIds` 为空，故老 env 只剩"删图时 env-clean 清空"（`env-builder/src/service/store.ts:341-351` 的 `markClean`）一条清理路径 | `GET /singularity/graph-envs` 实返（2026-09-18 M6 前置）：project1–14 全部 `bound:false` 但 `available:false`（sessionCount 1–4，图绑定早已不在）；代码调查：无 detach 对称操作 | backlog：session 停止时 detach，或 available 判定改"无 active session"。不阻塞 W24 复用——经删图释放的 env 正常可复用（M6 实证 project40） | 2026-09-20 |

（各行"已修复 / 部分解决"状态标注于 2026-09-17；#4 / #5 同日落地（机制接线 / 原生收敛），#8 已由 W21 关闭（2026-09-18，spawn 级 MCP 挂载 + 表重写，见 §4.3 W21 记录）；#14 / #15 为 W11 收官实跑（2026-09-17 夜）新取证、同日 W12 修复（见下方 W12 实施记录）、当晚 M2 实跑复核通过（见 §4.1 M2 段）；#16 / #17 分别为 W11 收官实跑与 M2 复核新取证，同日 W13 修复（见下方 W13 实施记录）；#17 的真机零客户端边界与 #4 的 permission 字段实写已由 M3 正式构建验收（2026-09-18）关闭/复核，新取证 #18 见 §4.1 M3 段；#12 的"修复证据只有单测"限定已由 M4 实跑复核（2026-09-18，graph15 探针实爆，见 §4.1 M4 段）关闭。**2026-09-18 审计（A5）+ 文档回填（W18）**：#1 的 tools/skills 真授权与 #6 的契约每轮重注入均已由并行工作落地、本批复核代码确认，状态改为"已解决"；全表 `file:line` 坐标逐行刷新，新增"末次复核"列。）；#19 为 M5（2026-09-18，graph16）新取证，属 buckyball 仓 bbdev 侧缺陷。 **2026-09-20 VRTC 对照审计**：#20–#31 为对照 VRTC-KISS v2.1 新增登记（对照基线 `/home/ROXY/code/ref/docs/VRTC-最小架构-KISS版-v2.0.md`，本文档简称"KISS §x"；其第 8 章"之后"与第 12 章"第一阶段不做"清单是本表的排期依据；其中 8 条【对照缺口·偏差】、4 条【方向性待建 / 计划内后置】）。同批复核旧行 #1 / #4 / #10 / #12 / #14 / #19：坐标无漂移，末次复核视为 2026-09-20（批量复核，不逐行改日期；理由同下条）。；#32 为 M6 前置调查（2026-09-18 取证）补登记，与本批 #20–#31 无重叠。2026-09-20 W27 落地 #20 / #21 / #30（§4.3 W27 记录），M7 真机复核（§4.1 M7 段）

本表只记"已实现部分里的偏差"。§2 中标 **未建** 的条目（Evolution Graph、M2 / M3 记忆、capability 缺口处置）是**方向上的待建**，不是偏差：它们对应 §3.2 的 P4 / P5 / P6，按阶段推进即可。（`capability_list` 在 §2 里没有对应条目，它只是缺口 1 / 3 的前置工具。）**2026-09-20 起**：#20–#31 是**对照外部基线（VRTC-KISS v2.1）的缺口**，与前 19 行的性质不同——前 19 行来自本仓自身实现的偏差，这 12 条来自与 KISS 的逐条对照，其中 8 条是**当前实现与 KISS 明确要求的差距**（#20/#22/#23/#24/#25/#26/#29/#30），3 条是**KISS 要求但本仓尚未建的机制**（#21/#27/#28），1 条是 KISS 第 8 章排在"之后"的**计划内后置**（#31）；代码落点与排期见临时计划 `docs/2026-09-20-vrtc-code-change-plan.md`。

### 4.3 已裁决（2026-09-16）

1. **`capability.tools` 要真授权**（不是元数据）。前置顺序固定：先补 `capability_list`（否则模型靠猜名，
   且 `tools.restrict` 对未知工具名直接抛错）→ 再把 manifest 的 tools 落到 spawn 的 agent 级 allow-list。
   **已执行（2026-09-18，并行工作，W18 复核确认）**：两步都落地——`capability_list`（§4.2 #3）与 grant 收敛
   allow-list（§4.2 #1；`agent-runtime/src/grants.ts:212-223` 的 `tools.restrict({allow})`）。注意实际实现对
   未知名字的姿态比裁决文本更进一步：未知**工具标签**在 admission 解析期就整批拒绝
   （`task-runtime/src/capability.ts:69-79`），根本走不到 `tools.restrict`。
2. **动态 MCP 后置**（不立项）。当时的唯一落点是 agent preset；2026-09-18 起工具面有第二个落点——
   capability grant 的 allow-list 收敛（§4.2 #1 / §6），MCP 无运行时挂载 API 的事实不变（§5.1）。
   **Follow-up（2026-09-18，W21）**：本裁决的"后置"到 W21 为止——上游仍无动态挂载 API，但 spawn 的
   setup 回调本身就是挂载点（`ctx.plugin()` 返回可 await 的 Fiber），W21 把能力行 `mcpServers` 接到了
   这个接缝上（per-env 绑定、fail-loud 启动），"按 task 动态加载 MCP"就此落地，见下方 W21 记录与 §5.1。
3. **review lineage 采用 graph 形态**，但只取"schema 是图、写入是一次"的轻量做法：ReviewRecord 记
   `taskId / runId / sessionId / outcome / evidenceRefs / anomalies` + 可选的跨任务引用（`relatedTaskIds` 或边）；
   **不建 review 引擎、不养常驻 reviewer**。既避免将来 schema 迁移，又不把 P4 做重。
4. **血缘 + 会话检索已落地**：见 §4.1。**全文检索仍关闭**（base 的 `openAt: never`），worker 按 seq / 事件
   精确读；要开 search 需在 `config.yml` 文档 1 加 `session-query-sqlite` 行并把 `openAt` 改成
   `first-search | startup`。

**Review 的方向（已裁决，同上日期）**：按想法文件里那几条意见做，**不接入 `packages/harness-evolve`**
（结构过重、与 task 图未接线，不适配当前架构）。要照抄的是细1 §六–§七（`细化想法1.md:506-692`；Review 不是打分器：Execution →
Evidence → Review → FailureLocalization → mutation proposal；分 L0–L3 四层；用"局部证据 + 父 review 摘要 +
相关祖先约束"，不重读整条 ancestry）、细3（Review≠Judge、Data-first、不为每个 task 养常驻 reviewer）、
细4 §22–27（ReviewRecord / 维度 / Diagnosis / lineage graph 形态）。实现上保持**轻**：每个 run 终态写一条
ReviewRecord（无评分），失败才写 `localizedCause`，消费方现阶段只有人。

**能力（capability）的交付形态（已裁决 2026-09-17）**：所有能力**都构建为独立的 MCP server**，供"认为自己需要 verify 的节点"按需消费；
**以前的 verify 类插件（`ball-designer` / `chip-designer` / `verify-runner`）只作参考**——它们属老旧架构，已移出 harness 到
`/home/ROXY/code/bb_work/legacy-harness-plugins/`（保留 prompt 供参考）。因此 `task-runtime` 现有能力表（含指向 `bb-verify` preset 的三条）
**暂不改动**：现在还没到用 BB 验证 singularity 运行能力的阶段，那张表只是占位 + 参考，将来接 MCP server 时再重写。
**Follow-up（2026-09-18，W20/W21）**："将来"已到——W20 把 CI dispatch/fetch 通道做成独立 MCP server
（`packages/singularity/bb-dispatch-mcp`），W21 把 buckyball 仓自带的 bbdev MCP server 经 spawn 级接缝接进能力表
并重写了整张表（§4.2 #8 关闭）；bb-verify preset 里的旧 cordis 插件行（七个 `buckyball_bbdev_*` 工具 +
CI-dispatch playbook）随之退役，playbook 职责回到 `verify` skill。逐项见下方 W21 记录。
**Follow-up（2026-09-18，W22，按本节末条人类裁决执行）**：dispatch 链路整体撤下——`bb-dispatch-mcp` 包删除
（vendored ci-dispatch.mjs 的参考原件仍在 `legacy-harness-plugins/verify-runner/scripts/`）、`bb-dispatch`
注册项与 `dispatch-verification` 能力行移除（能力表 14 → 13 条）；历史记录不抹，上方 W20/W21 两段保持原文。

**采纳的上游 v3 能力（已裁决 2026-09-17）**：① **system prompt 作为 surface 节点 0、以 in-history 追加、每步重投影**
（补 §4.2 缺口 6「契约每轮重注入 / 防 compaction 丢弃」；实施前先实测本网关是否接受中段 `role: system`）。
**①已落地（2026-09-18，并行工作，W18 复核确认）**：worker 契约以 system-prompt section 形式注册到 worker 自己的
作用域，loop 每步重投影、compaction 不吃节点 0——见 §2.6.3 与 §4.2 #6（`agent-runtime/src/contract-reinjection.ts`、
`task-runtime/src/contract.ts`、`tests/integration/worker-contract.spec.ts`）；
② **持久化类型变更纪律**（照抄上游的 `persistence-schema.json` 指纹 + `persistence-changes/**` + 校验脚本，给我们四类自定义事件建登记）。
其余 v3 新特性（`present`、`/export`、`mcp-resources`、`auto-review`、SSH 执行世界、终端控制器）列为备选，按需再上。

**2026-09-17 实施记录（W1–W4，验证见 §4.1 末段）**：W1 卫生 + 小缺口——删 `verifier/` 嵌套 lockfile /
`.npmrc` / 失效 overrides 与 7 个 `canvas-*` 残留目录；README 补 task / verifier / task-runtime 三行与
`task_*` 工具（`packages/singularity/README.md:26-29`）；`reaches` 收敛为 task 包共享导出
（`task/src/types.ts:50`）；handoff 措辞诚实化（`task-runtime/src/handoff.ts:109-110`）；`task_verify`
描述诚实化 + 终态前置报错（`agent-singularity/src/tools/task-verify.ts:33-46`）。W2 能力面——`capability_list`
工具（`agent-singularity/src/tools/capability-list.ts` + ROOT_TOOLS `agent-runtime/src/index.ts:26`）；
capability 表逐字下沉 `config.yml` 文档 1 task-runtime 行（代码默认兜底 `task-runtime/src/index.ts:90-99,108`）。
W3 P4 轻量 ReviewRecord——`ReviewRecorded` 事件 + `recordReviewIn` + reducer 强制
（`task/src/service/state.ts:56,204-233`），编排器终态分支全写 record（`task-runtime/src/orchestrate.ts:159-170`），
`task_status` 行尾带 review 摘要（`agent-singularity/src/tools/task-status.ts:30-35`）。W4 持久化纪律——
`scripts/verify-persistence.mjs`（--check/--write）+ `docs/persistence-schema.json`（4 roots）+
`docs/persistence-changes/2026-09-17-singularity-custom-events-initial.*` 首条档案 + graph / graphs / layout / task
事件成员 JSDoc 补齐（§4.3 上游 v3 能力第 ② 条的落地）。W8 P4 第二步 ReviewRecord → Diagnosis——`DiagnosisRecorded`
事件 + `recordDiagnosisIn` + reducer 强制（id 全 store 唯一、不可变、字段齐全、至少一条 evidence/review 引用、
proposals 九类 targetType 对齐 §2.7.6，`task/src/service/state.ts:262-293`）；`task_review_pack`（只读证据包：
本任务 reviews 全文 + 父/子 review 摘要 + 依赖边）与 `task_diagnose`（写，proposals 只是建议不自动执行）两工具进
ROOT_TOOLS（`agent-runtime/src/index.ts:30-31`），root prompt 加一句复盘指引；`task_status` 行尾追加 `diag: <n>`；
持久化第三条档案 `docs/persistence-changes/2026-09-17-diagnosis-recorded.*`（digest 不变，same-version）。

**2026-09-17 实施记录（W10，P5 Evolution 准入轨道 v1，验证：build 全绿、verify-persistence 4 roots 不变、
单测 323 / 集成 90）**：`EvolutionService`（`agent-singularity/src/evolution.ts`，照 HitlService 插件服务范式，
持久化为 append-only JSONL `.dsh/evolution/proposals.jsonl`，目录推导照 verifier 的 `.dsh/task-evidence` 模式；
记录 immutable、状态迁移只追加、回放与写入共用同一 fold 强制状态机 `proposed → candidate → gated → decided`
与 id 唯一）；五个工具进 ROOT_TOOLS（`agent-runtime/src/index.ts:34-38`）：`evolution_propose`（必填
baseVersion/level/sourceRefs≥1，可 `fromDiagnosis` 从 W8 Diagnosis.proposals 转录）、`evolution_candidate`
（记完整 versionSet）、`evolution_gate`（Gate 六问按 `细化想法4.md:1329-1357` 原文逐字转写为必填字段 +
regression 证据引用校验存在性不执行）、`evolution_decide`（内嵌原生 `ctx.approval.request`，approve 才落
PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH，reject/取消/无应答不落账；v1 全级别人审不豁免）、
`evolution_list`（只读过滤 + history 展示）；root prompt 加一句轨道指引。不走 session 事件，故无持久化指纹变更。
**未建**（红线）：PROMOTE 自动生效、Rollback 机制。（sandbox 物化见 W14，replay/regression 执行与 candidate vs champion 对比见 W15。）

**2026-09-17 实施记录（W12，修 W11 实跑确认的两个缺陷；验证：`pnpm build`（12 包）全绿 / `verify-persistence` 4 roots 指纹不变 / 单测 324（48 文件）/ 集成 92（18 文件））**：① §4.2 #15 evolution 工具运行时断线——W11 建议的"`inject` 补 `'evolution'`（一行）"**实测不可行**：`evolution` 服务由本插件自己的子 fiber 提供，父 fiber 声明即永停 PENDING（body 不执行、工具零注册，且唯一的提供者由那段 body 创建，无法自行解除；比原缺陷更糟），故改为 `new EvolutionService(ctx)` 把 ledger 服务挂在消费它的 fiber 上（`agent-singularity/src/index.ts:51-54`，注释写明缘由）；同一审计发现 `hitl_ask`/`hitl_approve` 从本插件 ctx 读 `ctx.userQuestions`/`ctx.approval` 却未声明 inject（这两个服务由 sibling 插件提供，声明安全），一并补进 `SingularityAgent.inject`（`agent-singularity/src/index.ts:46`）。新增插件上下文级集成测试 `tests/integration/evolution-tools.spec.ts`：真实 `ctx.plugin(SingularityAgent)` + sibling 依赖插件，驱动 `evolution_propose`/`evolution_list` 落账与读回（修复前该测试原文复现 `cannot get property "evolution" without inject`），并驱动 `hitl_approve` 验证 approval 解析。② §4.2 #14 取消路径幽灵——`blockRemaining()` 统一收敛未启动子任务（`task-runtime/src/orchestrate.ts:256-276`，reason 常量 `:62`，调用点 `:316-318` 循环顶 abort / `:405-407` 在飞取消 / `:451-452` verifier 缺失），落无 run 的 `TaskBlocked` + 恰一条无 run 的 blocked ReviewRecord，outcome 报 `blocked`；单测 `task-runtime/tests/unit/orchestrate.spec.ts`（新增"预取消"一例）、`review-record.spec.ts`（原"永不落 record"断言改为落 blocked record）。**inject 核对表（本次审计结论）**：本工作区经 `ctx.plugin(X)` 注册的服务只有两个——`hitl`（消费方 graph-web 已声明 `inject`，✓）与 `evolution`（#15，✗ 已修）；此外本插件 ctx 上的 `userQuestions`/`approval` 未声明（已修）；其余消费点皆为已声明的 inject（agent-runtime / task / task-runtime / graph / graphs / layout / verifier）或刻意的软解析（`ctx.get?.('verifier' | 'agents' | 'taskRuntime' | 'envBuilder' | 'agentPresets' | 'permissionPresets')`）。**偏差**：本轮未实跑复核——#15 需重启 `./dsh web` 后重跑 P4→P5 链（graph12 指令可复用），#14 需在 worker 在飞窗口制造取消语料。

**2026-09-17 实施记录（W13，清尾三项；验证：`pnpm build`（12 包）全绿 / `verify-persistence` 4 roots 指纹不变 / 单测 324（48 文件）/ 集成 94（18 文件，+2 为本轮新增））**：① §4.1 W11 段两处事实修正——"五结局语料（新代码）"改为"四结局新代码实跑 + 超时结局旧代码实跑、新代码仅单测覆盖"（超时实跑记录只在 graph9 的旧代码进程里，新代码超时路径只有单测）；`evolution_decide` 的挂起时长由"约 14 分钟"改为实测 15 分 01 秒（seq 149 `approval/asked` 12:15:43Z → seq 150 `approval/decided` 12:30:44Z，差 901.7 s）。② §4.2 #16 prompt 分工。③ §4.2 #17 瀑布认领顺序。**未改上游**：`thirdparty/` 零改动，故 §5.6 无需登记 patch。**偏差**：#17 的真机拓扑（重启 web、零浏览器 mux 客户端下走一遍 `evolution_decide`）本轮未复跑，验证只到集成测试层；#16 是 prompt 层改动，无自动化断言。

**2026-09-18 实施记录（W14，P5 正式构建第一片：EvolutionProposal mutation 表示 + 沙箱物化；验证：`pnpm build`（12 包）全绿 / `verify-persistence` 4 roots 指纹不变 / 单测 474（55 文件；`evolution.spec.ts` 77 测、本轮 +58，基线 324→474 的其余增量来自同树并行 worker）/ 集成 105（21 文件，+1 为本轮新增））**：candidate 记录可选携带 `mutation`，按 targetType 分型 schema 校验（九类逐项：skill `{name,content}` / agent_preset `{presetId,files:[{path,content}]}` / capability `{name,entry}` / task_definition `{baseVersion,definition}` 为四类机械型，路径字段一律强制相对、无 `..`、无绝对路径、无反斜杠，`task_definition` 还要求 `mutation.baseVersion` 与提案 baseVersion 一致；tool / decomposition_policy / workflow_policy / verifier / runtime_policy 五类自由结构化、记账标 `mechanical: false`；未知键、非对象 mutation 一律拒绝）；状态机扩为 `proposed → candidate → prepared → gated → decided`——带 mutation 的 candidate 必须经 prepared 才能 gate（跳态响亮拒绝并在报错里指向 `evolution_prepare`），不带 mutation 允许 candidate→gated 直达（graph12 时代 5 行台账 fixture 回放无漂移，回放与写入共用同一 fold，伪造 `mechanical` 标志的记录在 fold 处响亮失败）；新工具 `evolution_prepare`（ROOT_TOOLS，`agent-runtime/src/index.ts:36`）把机械型 mutation 物化到 `<ledger root>/sandbox/<proposalId>/`（skill→`skills/<name>/SKILL.md`、preset→`.agent-presets/<presetId>/…`、capability→`capability-table.patch.yml`（注释写明整行替换语义，正文 JSON 即合法 YAML 1.2）、task_definition→`task-definition.json`），同时落 champion 快照于 `champion/`（skill/preset 由服务读生产根 `$DSH_HOME/skills`、`.dsh/.agent-presets`——只读；capability / task_definition 由工具层解析后传入，保持平面分离：capability 取 `taskRuntime.listCapabilities()` 当前生效条目，task_definition 取本图 task store 中 `definitionRef` 匹配 baseVersion 的第一个实例之实存字段——store 无 definitions 注册表，`decompositionPolicy`/`budgetPolicy` 不在实例上，快照只含实存字段，这是已知的保真上限）；生产目标缺失记 `champion: null`（`champion: 'missing'`）；所有写路径先经 schema 校验再过 `resolveWithin` 复核，单测断言生产根只读、ledger root 下除台账外只有 `sandbox/`；`evolution_list` 展示 prepared 状态、沙箱路径与 champion 状态，root prompt 轨道指引同步一句。ledger `formatVersion` 仍为 1（新增 kind `prepared` 是增量扩展；旧代码回放含 prepared 的新台账会在状态机校验处响亮失败，不静默漂移）；不走 session 事件，无持久化指纹变更。**未建**（红线不变）：replay/regression 执行、candidate vs champion 对比（W15 取 `champion/` 锚点）、PROMOTE 自动生效与 Rollback（W16）。**偏差**：未实跑 `./dsh web` 驱动 `evolution_prepare`（验证到集成测试层）；`docs/persistence-changes` 无需新档案（本平面非 session 事件）。

**2026-09-18 实施记录（W15，P5 正式构建第二片：replay/regression 执行器 candidate vs champion；验证：`pnpm build`（12 包）全绿 / `verify-persistence` 4 roots 指纹不变 / 单测 536（57 文件；本轮 +44：`evolution.spec.ts` 77→109、`orchestrate.spec.ts` 41→48、`grants.spec.ts` 13→18）/ 集成 113（22 文件，+1 为本轮新增的 prepared→replayed→gated 链；另有 15 个既有测试因 ROOT_TOOLS 新增 `evolution_replay` 而失败、其白名单/工具替身断言同步更新——`agent-runtime.spec.ts` 的 root 白名单断言 1 处、worker-grant.spec.ts 2 处、worker-contract.spec.ts 1 处））**：① **overlay 接缝**（最小侵入点 = 回放专用，普通 run 永不携带）——`ReplayOverlay { capabilityOverrides?, extraSkillRoots?, presetOverride? }`（`task-runtime/src/orchestrate.ts:766`）：capabilityOverrides 按整行替换语义只合并进该次能力解析（`TaskRuntime.replayTask`，`task-runtime/src/index.ts:558`）；extraSkillRoots 经 `WorkerGrant.skillRoots`（`agent-runtime/src/types.ts:82`）在 spawn 时把 `<root>/<name>/SKILL.md` 全部注册进该 worker 自己的 skill 层（`agent-runtime/src/grants.ts:133` 的 `applySkillRoots` + `skill-file.ts:159` 的 `listSkillFiles`）——skill registry 的层级语义保证"最近层同名直接胜"，故沙箱 skill 只遮蔽该 worker、生产目录只读，同一 worker 内先注册先胜故 overlay 先于 granted 解析；presetOverride 只接 roster 已注册 preset。② **回放执行**（新工具 `evolution_replay`，ROOT_TOOLS；`agent-singularity/src/tools/evolution-replay.ts`）：入参 `{ proposalId, taskIds, holdoutTaskIds? }`，要求 prepared 机械型；同图回放——champion = 本图 store 里 verified/failed 且带 ReviewRecord 的历史任务，champion 侧恒取该记录（outcome/criteria/durationMs），绝不重跑；回放任务 = 同 store 独立无父新任务（objective 带 `[evolution-replay:<proposalId>]`、run.parentRunId 指向 champion run、review anomalies 带 lineage），历史树零改动。逐 targetType：capability/skill 走真实 spawn+verify 链（`runReplayTask`，`orchestrate.ts:829`，复用 cascade 的终态 record 纪律——recordTerminalReview 已提为模块级共享）；task_definition 为 deterministic criteria replay（spawn:false，候选 `task-definition.json` 的判据直接过 verifier）；**agent_preset v1 = manual**：调研结论——`AgentPresets` 的 `resolvedRoots` 构造期固定、`resolve(id)` 只扫这些根、无 per-mount 自定义根 API，加根等于改全局服务状态（碰生产），故 manual 登记（报告 mode:'manual' + manualReason，台账 verdict 'manual'），`replay.ts` 的校验器硬性拒绝非 preset 类 manual 报告。③ **报告**：`sandbox/<id>/replay-report.json`（formatVersion 1：逐任务 {taskId, champion:{outcome,criteria 摘要,durationMs}, candidate: 同款, verdictMatch, criteriaDiff}，observed 与 holdout 分组、holdout 空则 `executed:false` 如实写未执行，总评 not-worse/worse/inconclusive/manual——worse = outcome 降档或共享判据 pass→翻 fail，cancelled 记 inconclusive 而非 worse）；台账追加 `replayed` 记录（report 相对路径 + 逐任务 relation 摘要）。④ **状态机收紧**：机械型 candidate→prepared→replayed→gated（prepared→gated 直达被取代，跳态报错指向 evolution_replay；记账型 prepared→gated 与无 mutation candidate→gated 不变；graph12 时代旧台账回放无漂移）；`evolution_gate` 对 replayed 提案强制 regressionEvidenceRefs 含报告路径且文件仍存在（报告路径按台账根解析、不走 repoRoot）。⑤ **红线保持**：回放全是"新任务 + 新 run + 新 evidence"，生产配置/生产 skill/历史任务零写入；ledger `formatVersion` 仍为 1（新增 kind `replayed` 是增量扩展）；任务事件只用既有 kinds，无持久化指纹变更，`docs/persistence-changes` 无需新档案。**偏差**：单测的 spawn/verify 全 mock（照 orchestrate.spec.ts harness），未调真 LLM；`./dsh web` 真实驱动 `evolution_replay` 未实跑（验证到集成测试层）；回放 worker 在 allowRuntimeDecomposition 部署下仍可自行 task_decompose（此时走 nested cascade 的 adoption 路径，record 缺 lineage anomaly——仅 objective 与报告可辨，记入已知边界）。

**2026-09-18 实施记录（W16，P5 正式构建第三片：PROMOTE 生效机制 apply + rollback；验证：`pnpm build`（12 包）全绿 / `verify-persistence` 4 roots 指纹不变 / 单测 568（57 文件；本轮 +32：`evolution.spec.ts` 109→139、`capability.spec.ts` 17→19）/ 集成 114（22 文件，+1 为本轮新增的 skill 全链 decided→applied→rolledback；另有 3 处既有白名单断言随 ROOT_TOOLS 新增两工具同步更新——`agent-runtime.spec.ts` 1 处、worker-grant.spec.ts 2 处、worker-contract.spec.ts 1 处）**：① **状态机终版**——decided(PROMOTE) → `applied` →（可选）`rolledback`；append-only 新 kind `applied` / `rolledback` 各带 `targets`（生产写入清单）与 `approvalRef`（人审证据引用，`approval:<callId>`），fold 与写入共用同一校验（伪造 kind、空 targets、无 approvalRef、decided 非 PROMOTE 后的 applied 一律响亮失败）；applied 后继仅 rolledback、rolledback 为终态（再 apply 须重新走 propose 全链——台账 immutable，不原地复活）。② **apply 范围**（红线执行面）：仅三类机械型、须已物化（`prepared.sandbox` 存在）、限 L1–L3；`APPLYABLE_TARGET_TYPES = ['skill','agent_preset','capability']` 与 L4 判定进了状态机本身（`evolution.ts` 的 `applyable()`），task_definition / 五记账型 / L4 / 无 mutation 的手工 candidate 在工具层先拒并回人工指引（不烧人审），服务层状态机再拒一次。③ **生产写入点与生效时机**——skill：沙箱 `skills/<name>/SKILL.md` → `$DSH_HOME/skills/<name>/SKILL.md`（文件级；champion 快照只含 SKILL.md，目录里未被快照的文件不动；skill-filesystem watch，落盘即生效）；agent_preset：沙箱 `.agent-presets/<presetId>/` 整目录替换 `$DSH_HOME/.agent-presets/<presetId>/`（rm+cp；发现每次 resolve 重读 roots，落盘即生效）；capability：`config-edit.ts` 对 `config.yml` 文档 1 task-runtime 行 `capabilities:` 里对应条目做文本级手术（单行 flow 行替换/插入/删除，块形条目按缩进整段替换；删空时表头塌缩为 `capabilities: {}`；文档 2 api 块与其余所有行字节级不变——无整文件 YAML 往返、无新依赖，与 tools/scripts 的手写子集解析同一精神），随即调新增的 `TaskRuntime.applyCapabilityRow(name, entry|null)`（`task-runtime/src/index.ts`，整行覆盖/删除运行期注册表）——本进程后续 admission 即刻生效，config.yml 保证重启后一致（插件 config 本是启动期加载，这一接缝如实写进工具输出与 README）。④ **rollback**——仅 applied 态可达，同样先 approval；champion captured：skill 写回快照 SKILL.md、preset 整目录从 `champion/.agent-presets/<presetId>` 恢复、capability 行取 `champion/capability-table.entry.yml` 恢复；champion missing：删除 apply 产物（skill/preset 目录整删、capability 行删除），删除语义写进 approval reason 与 targets（`(deleted — the apply had created it)`）。⑤ **写入纪律**——生产写先于台账 append（写失败则提案停留 decided/applied 可重试，不产生假账）；所有路径经 `resolveWithin` 复核；工具输出如实写明生效时机（skill/preset 立即；capability 运行期覆盖立即 + 重启一致），approval 拒绝/取消/无应答零写入并有单测逐出口断言。ledger `formatVersion` 仍为 1（旧代码回放含 applied/rolledback 的新台账会在状态机校验处响亮失败，不静默漂移）；不走 session 事件，`docs/persistence-changes` 无需新档案。**偏差**：`./dsh web` 真实拓扑下驱动 `evolution_apply`/`evolution_rollback`（含画布人审卡点）未实跑，验证到集成测试层；capability 运行期覆盖只影响本进程后续 admission，在飞 run 不追溯（设计如此，输出文案已写明）。

**2026-09-18 实施记录（并行工作，P4 升级路径整片：ReviewRecord 维度/指标 + `task_review_agent`；本批文档代理 W18 复核代码确认，证据锚逐一见 §2.7.1/§2.7.2/§2.7.3）**：ReviewRecord 增 `dimensions`（八维机械事实，`task/src/types.ts:340-351`）与 `metrics`（工程量计数器，`:374-402`），编排器终态时派生（`task-runtime/src/orchestrate.ts:263-334`），集成断言 `tests/integration/review-metrics.spec.ts`；升级判据纯函数 E1–E4（`agent-singularity/src/tools/review-escalation.ts:32-36,84-108`）；新工具 `task_review_agent`（ROOT_TOOLS，`agent-runtime/src/index.ts:35`；实现 `agent-singularity/src/tools/review-agent.ts:184-309`）spawn 只读评审 agent（grant = `REVIEWER_BASELINE`，`keepPresetTools: false`），把六维判读归一化（证据不足强制 `unknown`）后落为带 `producedBy: {kind:'agent'}` + `judgements` 的 Diagnosis；启动预算由 append-only 台账看守（`agent-singularity/src/review-agent-ledger.ts`，默认每 root store 1 个）；Diagnosis 两新字段的 reducer 校验在 `task/src/service/state.ts:298-326`，持久化档案 `docs/persistence-changes/2026-09-17-diagnosis-judgements.*`（same-version）。**偏差**：评审 agent 的真实 LLM 判读质量未经实跑评估。

**2026-09-18 审计与 remediation 记录**：四路并行审计（A2–A5）复核本轮并行工作，其中 A5 专审本文档，开出四类失真清单（状态与现实相反 / 过时矛盾 / 行号漂移 / 无出处断言），本文档本批改动（W18）逐条复核后修正——每项修正的证据锚见 §2 / §4.2 对应条目。同批代码侧 W17：evolution 台账 fold 与写入共用校验复校、`evolution_decide` 强制携带 `approvalRef`（`agent-singularity/src/evolution.ts:894-906`）、`config-edit.ts` 对多条匹配行拒绝猜测（`agent-singularity/src/config-edit.ts:109-126`，报错原文 "refusing to guess"）。W18（本批，纯文档）：§2.6.3 / §2.7.1–2.7.3 / §2.4.5 / §3.2 状态词更新，§4.2 全表坐标刷新并加"末次复核"列，§4.1 首段六条补出处，§5.1 / §5.3 / §5.4 / §6 同步，§6 维护约定硬化三条（见该节）。

**2026-09-18 实施记录（W19，修 §4.2 #18：capability 晋升回滚的文本保真度；验证：`pnpm build`（12 包）全绿 / `verify-persistence` 4 roots 指纹不变 / 单测 588（57 文件；`evolution.spec.ts` 150→159）/ 集成 114（22 文件））**：capability 型提案的 prepare champion 捕获改为源文本锚点——`prepared` 记录新增可选 `championSource` 字段（`'config-text' | 'code-default' | 'missing'`，类型与三态语义 `agent-singularity/src/evolution.ts:133-151`）：config.yml doc1 task-runtime 行里有该条目 → 快照加存该条目**逐字源文本**（`champion/capability-table.source.txt`，含原始键序与省略），rollback 经 `restoreCapabilityRowSource` 逐字写回（`config-edit.ts:209-231` 的读/还原对，与 `editCapabilityRow` 共用同一份行定位 `locateCapabilityRow`，`:129`）；条目只存在于代码默认表 → `code-default`（快照存注册表语义副本供对比报告，rollback = 从 config.yml 删除该条目恢复默认生效 + 运行期覆盖回默认条目，`evolution.ts:1066-1071`）；能力不存在 → `missing`（语义不变）。注册表形态副本（`champion/capability-table.entry.yml`）仍写——它仍是 candidate-vs-champion 对比锚点与运行期覆盖载荷，只是不再是 config-text 情形的回滚文本来源。运行期覆盖（`applyCapabilityRow`）语义不变。向后兼容：无 `championSource` 的旧台账记录（M3 的 m3-prop-cap 等）按注册表形态照旧回放/回滚（`evolution.ts:1072-1075`），fold 对伪造 championSource（未知值 / 非 capability / 与 champion 状态不一致）响亮拒绝。ledger `formatVersion` 仍为 1（增量可选字段）；不走 session 事件，无持久化指纹变更。单测：config-text 往返整文件 sha256 前后一致（#18 原始场景：注册表条目 `{skills:[],tools:[],preset:standard}`、源行 `{preset: standard}`）、code-default rollback 后行消失且 sha256 复原、pre-W19 记录按旧归一化语义回滚、`readCapabilityRowSource`/`restoreCapabilityRowSource` 覆盖 flow/块形/CRLF/行已消失再插入。**偏差**：未实跑 `./dsh web` 驱动新路径（验证到单测/集成层）；M3 已落账的归一化行（`config.yml:142`）是历史记录，不回刷。

**2026-09-18 实施记录（W21，§4.2 #8：BB 域能力接 MCP + 能力表重写；验证：`pnpm build`（12 包）全绿 / `verify-persistence` 4 roots 指纹不变 / 单测 637（60 文件；本轮 +28：`mcp-servers.spec.ts` 新建 14、`orchestrate.spec.ts` 48→53、`capability.spec.ts` 19→23、`grants.spec.ts` 18→21、`evolution.spec.ts` 159→161）/ 集成 118（23 文件，+3 为本轮新增的 `worker-mcp.spec.ts`））**：① **接缝选型 = 路线 a（spawn 级挂载），弃路线 b（wrapper 间接层）**——核心约束是 bbdev MCP server 的脚本在 per-env 检出里（`environment/projectN/<owner>/<repo>`，owner 都不固定：实跑 env 挂的是 fork `mctang985211-coder/buckyball`），静态 preset 文件与 wrapper 脚本都拿不到"这个 worker 属于哪个 env"（MCP 子进程只继承 scrub 过的环境，cwd 是 harness 进程的）；而 spawn 时这一切可解析：caller session → 图 → envId → envBuilder 记录（path + components[].dir）。实现照 W15 skillRoots 先例：能力行新增 `mcpServers` 字段（`CapabilityConfig`/`CapabilityManifest` 各加可选数组，后者进 `CapabilityResolved` 事件载荷——声明级指纹不变，档案 `docs/persistence-changes/2026-09-18-capability-manifest-mcp-servers.*`，same-version）；代码内注册表 `MCP_SERVER_REGISTRY`（`task-runtime/src/mcp-servers.ts`）记录 serverName / command 模板 / cwd 模板 / 超时语义，模板占位 `{envRoot}` 与 `{repoRoot:<repo>}`；准入期 `resolveCapabilities` 校验未知名（列出词表整批拒绝，与未知 tool 标签同纪律），spawn 期 `authorizedGrant`（`task-runtime/src/orchestrate.ts`）经 `OrchestrateEnv.resolveMcpEnv` 物化模板（cascade 与 replay 两条 spawn 路径都走它），装进 `WorkerGrant.mcpServers`；agent-runtime 的 `applyWorkerGrant` 在 restrict 与 skill 钉册**之后**逐台 `await agentCtx.plugin(McpClient, spec)`（`grants.ts` 的 `mountMcpServers`）——`ctx.plugin()` 返回 `Fiber & PromiseLike`，await 它在加载完成时 settle、启动失败即 reject，挂载固定 `failOnStartupError: true`，失败经 spawn catch 落成 failed run + ReviewRecord（与悬空 preset 同纪律）。顺序是硬约束：mcp 工具注册在 worker **自己的** scope 层，`tools.restrict` 只收敛继承面、且 allow 名单只允许点继承面已有的名字——先挂载会让 `keepPresetTools` 分支把不可 restrict 的 `mcp__*` 名字喂进 allow 而抛错。② **注册表两条**：`bbdev`（env 检出自带的 FastMCP server，45 个 `bbdev_*`/`validate` 工具，submit/poll 形态，`{repoRoot:buckyball}/scripts/claude/run_mcp_server.sh`，脚本内部 `nix develop -c python3 -u bbdev/mcp/__main__.py`）；`bb-dispatch`（W20 包的 bin，经 `import.meta.url` 解析本仓位置，command 用 `process.execPath` 而非 PATH 查 node；cwd 绑 env 检出——dispatch 工具默认以 server cwd 为 repo）。**tracked 文件零机器绝对路径**：bbdev 路径全部来自 env 记录，bb-dispatch 路径运行时解析。③ **能力表 14 条**（三处逐字一致：`DEFAULT_CAPABILITIES` / config.yml 文档 1 / `config.yml.example` 注释块）：三个 verify 条目从"指向占位 bb-verify 插件"改为真实语义（`mcpServers: [bbdev]` + `bb-verify` 组合；`run-verilator-regression` 加 `waveform` skill——RTL 失败是 cycle 级问题）；`check-ball-registration` 解锁；`build-*` 四条上表（注意：`config --install` 无 MCP 封装——bbdev API 有 `/config/install` 而 MCP 工具面没有——该步走 bash，server 覆盖后续 `validate`）；`dispatch-verification` 挂 `bb-dispatch`；`integrate-model` 按 R4 保持 skill 形态（`workload-tests`）；`analyze-waveform` / `research` 不动（`research` 语义不动；文本随整表重写从 M3 归一化形回到简写 `research: { preset: standard }`，见 §4.2 #13 注——W19 的 config-text champion 从此钉新文本）。授权粒度是整个 server：三个 verify 条目表面相似是诚实的（同一台 server 的 45 个工具），区分落在判据命令与 skill 指引上，§5.3 已写明这一点。④ **bb-verify preset MCP 化**（`.dsh/.agent-presets/bb-verify/`，机器本地、gitignored；生成源是 legacy verify-runner dispatch，已移走，故直接改实物）：删掉 cordis 插件行（`file://…/dsh-plugin/bb-verify/index.ts` 的七个 `buckyball_bbdev_*` 工具 + CI-dispatch playbook；插件实物仍在 buckyball 仓备查但不再被任何 preset 挂载），persona 改写为 MCP 时代口径（mcp__bbdev__* + task 验收链，不再是 VERDICT 行 / report.md），新增 `tool-skill` 行（授权的 verify/waveform/check skill 没有 loader 就到不了模型），tool-fs / tool-fs-search / 0.4 折叠组保留。旧工具名引用点全仓清扫：src 零残留（只剩测试 fixture，已改中性名 `verify_console`），`verify` / `check` 两个 skill 本就按 MCP 工具名写（无需改），`docs/verify-agent-node-design.md` 与 `docs/2026-09-17-p3-p4-completion.md` 是历史设计/记录文档，不回改。⑤ **grants/review 配套**：`capabilitySnapshot` 带 `mcp:<server>` 标记（run 记录可见 server 面）；review 的 `toolFit.calledOutsideGrant` 不再把被授权 server 的 `mcp__*` 调用误报为越权（`orchestrate.ts` 的 `reviewEnrichment`）；evolution 的 capability mutation 键清单加 `mcpServers`（`evolution.ts` 校验 + `evolution-candidate.ts` 文案）；`capability_list` 渲染该字段。**偏差 / 验证边界**：`./dsh web` 真机驱动一条带 `mcpServers` 能力的分解链未实跑（集成层用真 mcp-client + 真 bb-dispatch-mcp 子进程证明了挂载/限制/失败语义，但 bbdev server 本体（nix develop 冷启动、45 工具同步）只在 M5 真机才能验收；注册表里 `bbdev` 条目指向的脚本路径形态由单测钉死）；`worker-mcp.spec.ts` 的 server 从 `src/index.ts` 起（Node type stripping，免构建），注册表模板指向 `bin/cli.mjs`（构建产物）——两者的等价性由 bb-dispatch-mcp 自己的 stdio 冒烟测试兜底；工具**调用**链（tools/call 过注册表到 MCP 再回来）是 mcp-client 自身已测的机械面，本接缝只断言到场与失败语义。
**Follow-up（2026-09-18，W22，按下方人类裁决执行）**：dispatch 链路撤下——② 的 `bb-dispatch` 注册项、③ 的
`dispatch-verification` 能力行（表回到 13 条）与 `worker-mcp.spec.ts` 对 bb-dispatch-mcp 的依赖一并移除
（该 spec 改用自带最小 fixture server，接缝断言不变）；spawn 级 MCP 挂载机制本身保留，`bbdev` 注册项保留。

**人类裁决（2026-09-18，人类指令，权重最高）**：dispatch 与所有 CI 脚本只能作为编写 MCP 的参考，
**不得作为验证路径**；所有验证工作只能由 verify 节点调用 MCP 工具直接在本地跑工具链
（bemu / verilator / validate，判据走本地证据）。据此 W22 撤下 W20/W21 建成的 dispatch 链路：
`packages/singularity/bb-dispatch-mcp` 包整删（vendored `ci-dispatch.mjs` 的参考原件留在
`legacy-harness-plugins/verify-runner/scripts/`，不丢）、`MCP_SERVER_REGISTRY` 删 `bb-dispatch` 项、
能力表删 `dispatch-verification`（三处逐字一致，14 → 13 条）、`config.yml` / `config.yml.example` 同步、
`worker-mcp.spec.ts` 换成测试自带 fixture server。本裁决约束将来所有工作：任何"派发 CI 拿 VERDICT"的
设计都不再是合法验证路径，本地验证轮才是。

**2026-09-20 VRTC 对照审计（纯文档，W23）**：以 `/home/ROXY/code/ref/docs/VRTC-最小架构-KISS版-v2.0.md`
（v2.1-KISS）为基线逐条比对本包实现。结论：**方向一致**——Task 契约层、Verifier 执行层（独立性由编排器结构
保证）、Review / Diagnosis、Evolution 准入轨道已建，§2 的 12 条冻结原则与 KISS 内核不冲突；**缺 12 项约束类
机制**，全部登记进 §4.2 #20–#31（8 条【对照缺口·偏差】+ 3 条【方向性待建】+ 1 条【计划内后置】），并按 KISS §12
"先建约束再建内容"的落地顺序写出代码落点临时计划 `docs/2026-09-20-vrtc-code-change-plan.md`（阶段 1 契约与
结构 → 阶段 2 Verifier 四值与元数据 → 阶段 3 GAP 阶梯与义务 → 阶段 4 Retro 与分层接受度量 → 阶段 5 领域包内容
→ 阶段 6 质量纪律 → 阶段 7 P3 激活前置）。**本批只改文档、不动代码**：不涉及 session 事件与持久化 schema，
`pnpm run verify-persistence` 预期无变化，`docs/persistence-changes/` 无需新档案。
同批修正本指南 3 处过期事实：§6 root 白名单 21 → 22（2026-09-18 后新增 `skill`）；§6 素材文件 5 → 7 份
（`ref/docs` 2026-09-20 实为 7 个文件，新入档两份已标注）；§5.2 补记生效的深度 / 宽度阈值并指向 §4.2 #23。
§2.2 / §2.4 / §2.5 / §2.7 / §2.8 的对应条目加指回 §4.2 的交叉引用。**未做**：只按 KISS 补齐任务 / 技能 /
验证 / 编排 / 复盘 / 进化通用机制，不改 buckyball 具体内容；`bb-pipeline` 领域包"典型分解骨架"（步骤序列）
的改写（#30）排在 #21 义务模板落地时同批，本轮只登记。

**2026-09-18 实施记录（W24，图↔工作目录预绑定与默认复用；验证：`pnpm build` 全绿 / `verify-persistence` 4 roots 指纹不变 / 单测 616（58 文件）/ 集成 130（24 文件，+12 为本轮新增 `graphs-reuse.spec.ts`，+1 为同树并行工作））**：动因——`createEnv:true` 分支无条件 `store.create()`（每次建图全量新建），`envId` 复用被"独占绑定 + 现场保留"顶住（§4.1 M3 的 `already bound`）；按人类口径"每个 graph 预先绑定一个工作目录、多环境并存按名/按内容复用"落地。① `EnvRecord` 加可选 `label`（`env-builder/src/service/types.ts:15`；manifest.json 快照式，可选字段向后兼容），store 加 `findByLabel` / `findByRepos`（url 归一化去 `.git`/尾斜杠并小写，请求 refs 先过 `parseRepoRef`，任一解析失败即不命中——刻意保留既有"planComponent 失败回滚删 env"语义）。② `GraphsService.create()` 环境解析段重写（`graphs/src/index.ts:124-216` 附近）：`envId` 路径报错带占用者 graph id/name 与 delete 释放指引（`assertReusable`，只改 create 预检、state 层硬约束文案未动，回放零影响）；`workspace` 路径按 label 匹配（available 取最小 projectN；占用报错逐条列原因 + 释放指引；无匹配新建打标）；`createEnv:true` 带 repos 时先 `findByRepos` 匹配 available（命中转复用），`fresh:true` 强制新建；模式互斥校验（envId 不与其他组合；全无报 `provide exactly one of …`；**createEnv+workspace 同给时 workspace 优先**，M6 实测）。③ setup prompt 幂等（`graphs/src/prompts/setup.prompts.ts`，签名不变）：`installing` 组件照旧派 worker，`ready/modified` 列 "already present, do not reinstall"，全 ready 指引直接 `graph_mark_ready`；新建场景文本与旧版逐字节一致。④ HTTP：`POST /singularity/graphs` 响应加 `reused`；`GET /singularity/graph-envs` 加 `label`。graph 事件 schema 未动（label 只存 EnvRecord），无持久化指纹变更。**已经 M6 真机验证（2026-09-18，见 §4.1 M6 段）**：`reused:false→true` 循环、零 clone、10s vs 70s ready、幂等 prompt 逐字实证。边界：`reused` 只在 HTTP 响应与 `CreateGraphResult`，不进 GraphRecord/事件流（重启后无 reuse 历史可查，需求未要求）。（回填改名说明：本批内部批次号原为 W23，因 2026-09-20 VRTC 审计批次已占用该标签，回填时改名 W24。）

**2026-09-18 实施记录（W25，BB 任务划分指引 = bb-pipeline skill + root skill 通道；验证与 W24 同批基线：单测 616 / 集成 130 / 指纹不变）**：动因——root 分解零领域指引（root prompt 纯流程性，能力语义只能 `capability_list` 现查），legacy 六插件的流水线知识（workload→chip→ball→review→verify，出处 `legacy-harness-plugins/harness-evolve/docs/bb-integration.md:14-23`）在 singularity 侧无载体；按自生长原则交付形态定为"可参考地图、非写死 workflow"，**不建 TaskDefinition 注册表**（任务结构由 agent 自主长出，划分只做指引）。① 新 tracked skill `/.agents/skills/bb-pipeline/SKILL.md`（harness 仓根，零配置发现：root cwd=env 根→向上找 `.git`→仓根；`git check-ignore` 实测不排除；frontmatter + 中文正文：参考地图声明 / 阶段→能力映射 / 分解骨架 / 判据硬提醒 / 边界段）。② ROOT_TOOLS 21→22 加 `'skill'`（`agent-runtime/src/index.ts:31-34`；工具本体由上游 tool-skill 注册，standard preset 自带 tool-skill + skill-filesystem，`tools.restrict` 的 restrictableNames 覆盖继承面，故白名单即生效）；root prompt 末尾加一句英文指针（`root.prompts.ts:6`）。③ 测试：四处白名单断言同步（`agent-runtime.spec.ts` / `worker-grant.spec.ts` / `worker-contract.spec.ts` / `worker-mcp.spec.ts`——skill 属 preset 平面，测试 harness 里 root 改挂独立 `preset:root-standard` 平面）；`skill-file.spec.ts` 新增用例解析仓里真实的 bb-pipeline SKILL.md；`worker-grant.spec.ts` 新增真实 skill-filesystem 发现+加载断言。**已经 M6 真机验证**：`skills/list` 32 条含 bb-pipeline；m6-b root 工具面 23 含 `skill`、实调加载成功并复述章节标题（§4.1 M6 段）。边界：自定义 preset 起 root 若无 tool-skill，白名单里的 `skill` 会在 root setup 抛 unknown tool（既有 fail-loud 语义）。**已知偏差**：其"典型分解骨架"一节含步骤序列，与 KISS §12 冲突，已登记 §4.2 #30，改写排在 W27（与 #21 义务模板同批）。（回填改名说明：原内部批次号 W24，同上缘由改名 W25。）

**2026-09-20 实施记录（W26，skill 契约与领域包内容规范冻结 + 知识型 skill 先行样例；纯文档/内容，零代码，`verify-persistence` 无变化）**：① §2.4.8 新开（#29/#30 的规范补丁）：Skill 层契约走侧车注册表（不改 DSH loader）与领域包"不装步骤序列"两条规范就此冻结为方向层口径。② 知识型 skill 先行样例 `/.agents/skills/bb-obligations/SKILL.md` 落盘（挂临时计划阶段 5 的先行样例）：义务提问式内容（7 条 BB 域义务 + 各自证据形态与通常回答能力），尾部附侧车契约声明块（schema 预览，loader 不消费），并如实标注"知识型 skill 的 verifier_ref 豁免"为待规范细化的开口问题。③ bb-pipeline 的骨架改写（#30）本批不动，排在 W27 与 #21 义务模板同批。④ BB 仓 5 个外部 skill 的处置（动作 4）：按建议选 ③ 并存、等任务树成型再收编——决定权在用户，本批不改它们。

**2026-09-20 实施记录（W27，VRTC 计划阶段 1.1+1.2+3.3 + 阶段 5 第一弹：证据依赖 / 假设接线 / 义务最小版 / 领域包义务化；验证：`pnpm build`（packages/singularity）绿 / `verify-persistence` 4 roots 指纹不变（digest 前后一致）/ 单测 638（59 文件，+22）/ 集成 130（24 文件））**：① assumptions 接线（#20 最小切片）：`DecomposeChildSpec.assumptions?: readonly string[]`（`task-runtime/src/index.ts:185`），spawn 前把调用方声明假设 + 依赖兄弟证据引用合并进 `buildHandoff`（`orchestrate.ts:659`），渲染层不动（`handoff.ts:111` / `contract.ts:80` 已渲染）；`task-decompose.ts:46` 工具参数同步。② requiresArtifact（#20 主体）：`AcceptanceCriterion.requiresArtifact?: string[]`（`task/src/types.ts:25`），admission 只结构校验（`admission.ts:73-76`），存在性放 spawn 前（`orchestrate.ts:194`，三种拼法匹配）；缺产物 → 不 spawn、无 run `TaskBlocked` + 恰一条 blocked ReviewRecord（anomalies 逐字点名，blockedBy 留空——缺失物不是任务）+ 每缺失项登记义务；产物已在则合法跳过（单测）。③ Obligation 最小版（#21）：`ObligationRecorded` 事件路线（`task/src/types.ts:692`；reducer 校验 id 唯一、goal/criterion 非空、sourceTask 存在；`TaskSnapshot.obligations`）；登记点两处（缺产物阻塞挂子任务、能力缺口整批拒绝挂父任务 `task-runtime/src/index.ts:552`）；覆盖检查 `task-runtime/src/obligation.ts`（扫 `.agents/skills/*/obligations.yml`、JSON-as-YAML 解析零新依赖、findRepoRoot 8 层向上找 `.git`），出口 `task_status` 末尾覆盖行（best-effort）；模板正本 `.agents/skills/bb-obligations/obligations.yml`（7 条）。全局调度器不做（任务书明确）。④ bb-pipeline 义务化（#30）：骨架节三条 dependsOn 序列整节删除 → 义务提问七行表 + 指明 obligations.yml 正本 + "顺序用 requiresArtifact 声明"；映射表与判据硬提醒保留；`skill-file.spec.ts` 解析用例未改且通过。⑤ 持久化：指纹未变（digest 只哈希载荷类型文本，联合成员与传递引用变更不动指纹），按 "acknowledged by record alone" 惯例补档案 `docs/persistence-changes/2026-09-20-obligation-recorded.{md,schema.json}`（previous==after，same-version）。副作用：6 个既有测试文件的 TaskSnapshot 字面量补 `obligations: []`。**已经 M7 真机验证（2026-09-20，graph21，见 §4.1 M7 段）**：缺产物探针未 spawn 直接 blocked + 义务登记、依赖证据自动并入 handoff.assumptions、`task_status` 覆盖行实返、改写后 bb-pipeline 正常发现。边界：覆盖匹配的"义务提及"为子串匹配（朴素但静态可判）；缺产物 blocked 无重试出边（与 #22 同坑，已互注）；覆盖行在无 env 根的上下文静默省略。



> **本节内容可随实现演进，允许将来被推翻。** 与 §2 冲突时以 §2 为准；本节只提供当前可用的落点、
> 命令与踩坑记录。

### 5.1 能抄现成的（改代码前先来这里查）

| 需求 | 别自己写，用 DSH 现成 | 位置 / 用法 |
|---|---|---|
| 工具集与 system prompt 组装 | **agent preset**（内置 `standard` / `ptc` / `minimal` / `cordis`） | `agentPresets.mount(agentCtx, id)`；`default: standard` 已配在 web bundle |
| 一次性委派（无验收） | `subagent`（自包含 prompt，返回结果） | 需要"做完就行"的活，不要上图 |
| 批量扇出 / 多角度审计 | `workflow`（JS 编排脚本） | 脚本只有 agent / pipeline / parallel / phase / log |
| 多轮 fresh-agent 迭代 | `ralph`（共享 workspace，结构化报告跨轮） | 仅当人明确要求时；**新版默认关**（base bundle 与 `standard` preset 都写 `disabled: true`，`packages/bundle/base/cordis.patch.yml:426-431`），要用得在 `$DSH_HOME/cordis.patch.yml` 或 `--patch` overlay 里加 `- id: tool-ralph` / `disabled: false` |
| 后台任务 | `job_list / job_output(wait) / job_kill` + `ctx.jobs.start()` | 完成走 in-session 通知，不要轮询 |
| 会话检索 / 追踪 / 回放 | `ctx.sessionQuery` 服务已挂（精确读 / 标题 / 血缘 trace 可用），但 base bundle 以 `openAt: never` 关闭了全文检索 | `packages/bundle/base/cordis.patch.yml:120-134` 管全文检索；5 个 `session_*` 模型工具已由 web profile patch 挂上（`config.yml` 文档 1 的 `tool-session-query` insert 行，按包路径挂），落在全局工具层：worker 直接可见，root 被 ROOT_TOOLS 白名单挡住。要开全文检索就改 `session-query-sqlite` 的 `openAt`。历史是 append-only 日志推导出来的，别另存对话历史 |
| 长上下文 | `compaction-basic`（0.8/0.16）+ tool-result pruner + `/compact` | 别自己写摘要；契约 / 证据的正本不在 chat（在 task store / EvidenceStore），且 worker 契约已每轮重注入、compaction 吃不掉（§2.6.3，§4.2 缺口 6 已解决） |
| 技能 | `skill-filesystem`（`.dsh/skills`、**`.agents/skills`**、自定义根，带 watch）+ `skill` 工具 | buckyball 的 5 个 skill 实际挂在用户根 `~/.agents/skills`（其仓 `install.sh -g` 的产物）；root 的领域参考 = harness 仓根 `.agents/skills/`（tracked、零配置命中：root cwd=env 根向上找 `.git` 到仓根）：`bb-pipeline`（2026-09-18 W25）与 `bb-obligations`（2026-09-20 W26 知识型样板；其 `obligations.yml` 于 W27 成为义务模板正本） |
| MCP | `@deepseek-ai/dsh-mcp-client` 一行一 server，工具名 `mcp__<server>__<tool>` | 无运行时挂载 API；静态组合按 preset 给不同 agent 不同 server 集；**按能力挂载走 spawn 级接缝**：能力行声明 `mcpServers`（注册表 `task-runtime/src/mcp-servers.ts`），spawn 时按该 run 的 env 检出解析模板、在 worker 自己的 scope 上挂 mcp-client 实例（`agent-runtime/src/grants.ts` 的 `mountMcpServers`），见 §4.3 W21 记录 |
| 权限 / 沙箱 | `permissionPresets`（内置 `workspace-write` / `danger-full-access`；sandbox 还有 `read-only`）+ `tools.restrict`（agent 级白名单）+ sandbox **fail-closed** | 提权要一句理由，路径固定单向；**capability `permission` 字段 → spawn 档位的分级机制已接线（最严者胜），未声明仍一律 `danger-full-access`，见 §4.2 缺口 4** |
| HITL（人介入） | `ask_user_question` 工具 + `ctx.userQuestions` + `ctx.approval` | 见 §5.5：root 的 `hitl_*` 已落到这两条原生 seam 上，画布 UI 是它们的 answerer |
| 目标 / 计划 / 待办 | `create_goal` / `/goal`（+ goal-round-driver 自动续跑）、`/plan`、`todo_write` | todo **无 owner / 依赖 / 验收**，不能当任务系统 |
| 插件与配置 | profile + bundle patch（**按 row id 整段替换 config**，无深合并）+ `config.yml` 两文档 | `./dsh web --dump-config` 看真实插件树 |
| 软依赖服务 | `ctx.get('name')` | 永远不要用 `ctx.<name>` 读未声明的服务 |
| 启动环境管理 | `./dsh`（sync-api → api.env / settings.yaml → patch → env 注入 → `NODE_USE_ENV_PROXY=1`） | 别在别处复制网关事实。本地 UA 代理只在 `config.yml` 的 `api:` 块写着 `proxy:` 时才起（`dsh:106-126`）；现在没写，运行时直连 upstream、经宿主网络代理（`https_proxy`）出网 |

**必须自建、且只有这一小块**：Task / TaskRun 状态机、AcceptanceCriterion、Verifier 注册表、
EvidenceBundle、capability 表 + admission、依赖驱动的顺序级联、TaskHandoff、composite 父验收。

⚠️ **别误用**：DSH 的 `agent-team`（`team_task_create/…`，`blocked_by` / `write_scopes`）是**协作板**，
`write_scopes` 只是建议性前缀，没有验收 / 证据，且包在 `experimental/` 下——不是 Task 语义的替代品。

**工具面的落点：agent preset、capability grant、（2026-09-18 起）spawn 级 MCP 挂载。** "按任务改 system prompt / 换整套工具组合"的落点是 agent 创建时的
`agentPresets.mount(agentCtx, id)`。新增一种能力 = 在 `.dsh/.agent-presets/<id>/` 落一个预设目录
（发现无缓存：每次调用重读 roots，运行中新增的预设无需重启即可见，
`packages/preset/agent-presets/src/discovery.ts:4-6`）。人类原意里"全部节点同一工具列表 vs 按任务动态加载"
在 DSH 里不是二选一：`capability → preset` 已经接线（spawn 前 `resolvePreset`，`task-runtime/src/orchestrate.ts:582` → `:611`），
前者 = 所有能力指向同一 preset，后者 = 每个能力一个 preset，靠 `defaultPreset` + 按能力覆盖共存。
第二个落点是 2026-09-18 接线的 capability grant：`tools` 标签展开 + baseline +（自带 preset 时的）preset 面收敛为
worker 的 `tools.restrict` allow-list，`skills` 钉进 worker 自己的 skill 层——机制与证据见 §4.2 #1。
第三个落点是同日 W21 接线的 spawn 级 MCP 挂载：mcp-client 仍无上游"动态挂载 API"，
但 `ctx.plugin()` 返回可 await 的 Fiber（启动失败即拒绝），于是能力行声明的 `mcpServers` 名字
在 spawn 的 setup 里按该 run 的 env 检出物化并挂载（模板 `{envRoot}` / `{repoRoot:<repo>}` 占位，
注册表 `task-runtime/src/mcp-servers.ts`，挂载 `agent-runtime/src/grants.ts` 的 `mountMcpServers`）；
工具以 `mcp__<server>__<tool>` 落在 worker **自己的** 工具层，`tools.restrict` 管不到那一层
（restrict 只收敛继承面），所以授权语义 = "声明即挂载、挂载即在场"，启动失败 = spawn 响亮失败。
机制、裁决沿革与验证边界见 §4.3 W21 记录。

### 5.2 真实场景速查

**前置条件（缺一不可）**：1）`./dsh web` 起来了（`http://127.0.0.1:3080`），LLM 网关事实只在 `config.yml`
的 `api:` 块改。2）环境绑定，**默认复用优先（2026-09-18 W24 起）**：`POST /singularity/graphs` 三种互斥入口——`envId:"projectN"` 精确复用；`workspace:"<名>"` 命名工作区（有 available 匹配→复用；被占用→报错带占用 graph 与 delete 释放指引；无→新建并打标）；`createEnv:true + repos:[...]` 先按 repo url 集合匹配 available env（available = 未绑定 + 有组件 + 无残留 session），命中即复用零 clone，`fresh:true` 强制全新。`envId` 不与任何其他参数同给；`createEnv+workspace` 同给时 workspace 优先（M6 实测）。复用命中时 setup prompt 只列 `installing` 组件、ready 组件标 do-not-reinstall，全 ready 时 root 直接 `graph_mark_ready`。新建路径不变：root 派 env 安装 worker → **agent 自己 `git clone` + 按仓库文档 build** → `env_register_component` → `graph_mark_ready`；env-builder 只做登记与校验（`.git` + origin 一致），**不注入任何 token**，私有仓库需要人先在宿主机备好凭据。
3）检出目录形状：`environment/projectN/<owner>/<repo>`（**不是** `environment/projectN` 本身）——验收命令
必须以 `cd <owner>/<repo> && …` 开头，否则 cwd 会在 env 根上扑空。4）`bbdev` 不在 PATH，一律
`nix develop -c bbdev …`；EDA 工具（dc_shell / vcs / vivado）缺哪个就哪个车道 blocked。

**标准流程**：

```
人: 建图（目标文本）→ 等 ready → 把 objective 发给 root（UI 聊天，或 session/prompt RPC）
root: task_read → task_decompose（reason + children：objective / acceptance criteria / dependsOn / decomposable?）
运行时: 准入 → 逐个 spawn worker（handoff = 目标+判据表+约束，不复制父上下文）→ whenIdle
       → verifier 在 env 检出目录跑判据命令 → EvidenceBundle 落 store → verified/failed
       → 依赖失败的后续子任务 blocked → 全部子任务 verified 后 root 的 composite 判据收口
人: 需要决策时回答 hitl_ask / hitl_approve（root）或 ask_user_question（worker）
```

监控与取证：任务事件在 `.dsh/sessions/_no-cwd/sg-t-<rootSessionId>/session.v3.jsonl.zstd`；
验收日志在 `.dsh/task-evidence/<storeId>/<runId>/<criterionId>.log`；拓扑在 `/singularity/graph?graphId=…`。

| 场景 | 能力名 | 验收命令（cwd=`<owner>/repo`） | 必需条件 |
|---|---|---|---|
| Ball 契约 / 代码改动 | `design-ball` | `nix develop -c bbdev workload --build --chip <c>` | buckyball 检出 + nix + 契约 5 项先锁定 |
| bemu 功能回归 | `run-bemu-regression` | `nix develop -c bbdev bebop-bemu batch --chip <c> --test elf-tests --clean-before`（exit 0） | 同上；worker 迭代走 `mcp__bbdev__bbdev_bemu_batch` submit/poll（M5 实测 toy/elf-tests submit→完成 ≤68s；spawn 级挂载冷启动 3.7–3.9s 热 store）；**`mcp__bbdev__bbdev_task_cancel` 当前不可用（#19），长任务别指望取消止损** |
| RTL / Verilator | `run-verilator-regression` | `nix develop -c bbdev bebop-verilator clean\|verilog\|build --jobs 16 --chip <c>` 后 `sim --binary <stem>` | 同上；单次调用易超时，见 §5.3；失败定性走 `waveform` skill |
| Ball 注册校验 | `check-ball-registration` | 无 CLI 等价物：worker 调 `mcp__bbdev__validate(chip=…)`（实测十项 checks，旧称"九项"已修正）；判据两种写法都成立——`mode: review`（人读 worker 证据），或让 worker 把 JSON 落文件后用 deterministic 命令校验文件内容（M5 实测后者 exit 0 自动闭环） | env 检出含 buckyball（MCP server 经 `nix develop` 起）；2026-09-18 起已接线，同日 M5 真机验证（graph16，chip=toy → passed:true，见 §4.1 M5 段） |
| 波形调试 | `analyze-waveform` | 无退出码判据 → 产物是人看的证据，不要写成 criterion.command | 波形在 `<repo>/log/<ts>-…/waveform/` |
| chip 骨架 / 切分 / 集成 | `design-chip` | `chip/skeleton` 冒烟 sim → `slices` 逐 stem → `integrate` batch → `bind` 逐 model `workload/kernel --build` | 五个 chip 矩阵 + KERNEL_MODELS 白名单 |
| 模型接入 | `integrate-model` | 接入改动本身无机械命令面（skill 形态：`workload-tests`）；验证轮拆成 verify 子任务本地跑 | 本地工具链就绪（nix + buckyball 检出） |
| 本地验证轮 | `verify-ball-functional` / `run-bemu-regression` / `run-verilator-regression` | verify 节点经 bbdev MCP 本地跑 bemu / verilator / validate（submit/poll），判据走本地证据（exit code / 日志 / 波形）；CI dispatch 只作参考，不是验证路径（2026-09-18 人类裁决） | 同上 |
| 构建前置 | `build-chip-config` / `build-compiler` / `build-workload` / `build-kernel` | 判据命令仍是 CLI（exit 0）；worker 迭代走对应 `mcp__bbdev__bbdev_*_build` submit/poll | nix + 持久根已 bootstrap；`config --install` 无 MCP 封装，worker 经 bash 跑 CLI 后用 `mcp__bbdev__validate` 自检 |

### 5.3 写法规范与陷阱

**能力名只写领域能力，不写工具名。** 能力表（`task-runtime/src/index.ts` 的 `DEFAULT_CAPABILITIES` 为代码兜底默认，生效表在
`config.yml` 文档 1）登记的是
`design-chip / design-ball / check-ball-registration / verify-ball-functional / run-bemu-regression /
run-verilator-regression / build-chip-config / build-compiler / build-workload / build-kernel /
integrate-model / analyze-waveform / research`。**`bash`、`filesystem` 不是能力名**——写进去只会被
判"缺口"；worker 的 bash 由 worker baseline 保证（`WORKER_BASELINE_LABELS` 含 `bash`，
`task-runtime/src/capability.ts:124-132`；早前实跑：worker 工具目录 77 个含 bash，且真在调用）。
一个未登记的名字 = "这张表里没有" → 缺口 → 整批准入拒绝（除非该子任务声明 `decomposable: true`）。
`capability.tools` 写的是**标签词表**（`filesystem` / `bash` / `jobs` / …），不是 DSH 工具名：标签在解析期展开为
真实工具名，词表外的标签在落库前整批拒绝、报错列出全部合法标签（`task-runtime/src/capability.ts:72-103`）；
展开后的名字若该 worker 的组合不提供，spawn 前响亮失败（`agent-runtime/src/grants.ts:67-77`）。
`capability.skills` 已接线为"在场保证"：被授权的 skill 钉进 worker 自己的 skill 层（`grants.ts:180-209`）；
诚实边界不变——DSH **没有按名字白名单裁 skill 目录的 API**（`skill/skill/src/index.ts:113-120`、
`skill/skill-filesystem/src/index.ts:56-58`），发现到的其它 skill 对该 worker 仍可能可见（`grants.ts:25-31`）。
`capability.mcpServers`（2026-09-18 起）写的是**代码注册表里的 server 名**（`MCP_SERVER_REGISTRY`，
`task-runtime/src/mcp-servers.ts`：现有 `bbdev`），不是路径也不是工具名：名字在准入期校验
（未知名整批拒绝、报错列出词表，`capability.ts` 的 `assertKnownMcpServers`），spawn 时按该 run 的 env 检出
物化模板并挂载；授权粒度是**整个 server**（挂一台 server 即得其全部 `mcp__<server>__*` 工具，
工具级子集在这个接缝上不可表达）。env 无检出 / 检出里没有该 repo / server 起不来，都只会让 spawn 响亮失败，
不会降级成"悄悄没工具"的 worker。

**验收标准要可判定、可执行、可独立。** 可执行模式（deterministic / simulation / measurement）**必须带
`command`**，判据是退出码；没有命令的条目不要写成可执行判据（admission 会拒）。复合任务用
`mode: 'composite'`（判据 = 所有 mandatory 子任务 verified），不要给 command。人工判读的条目写
`mode: 'review'` —— **永不自动通过**，留给 HITL。一条判据只验一件事；产物边界要能让另一个 worker 独立复验。

**分解：准入先拒后跑。** `task_decompose` 的每个 child 在落库前过准入（`task-runtime/src/admission.ts:39-96`）：父任务允许分解、
深度 / 数量上限（本部署生效值 `maxDepth: 4` / `maxChildren: 8`，外置于 `config.yml`，对照 KISS §4.1 的 8–12 是更保守的取值，见 §4.2 #23）、objective 非空、≥1 条判据、可执行判据必须有 command、依赖无环、能力缺口按声明处理。
任一条不过 → **整批拒绝、什么都不落库**（原子）。`decomposable: true` = 声明"这个子任务允许由它自己的 worker
再分解"（RFC §36 原子性由调用方判断）；它被接纳为 `decompositionStatus: 'decomposable'`，worker prompt 会
自动附加"去拆、别自己干完"的指引。未声明且无能力缺口的子任务是 leaf，其 worker 再调 `task_decompose` 会被拒
（这是护栏，不是缺陷）。同一条任务链上每个任务只允许分解一次（重试会得到 `already decomposed`）。child 可另声明 `assumptions`（假设）与判据级 `requiresArtifact`（证据依赖，2026-09-20 W27 起）：**顺序优先用证据依赖表达而不是 dependsOn 链条**——上游产物已存在时该环节合法跳过（KISS §5.1）。缺产物 = spawn 前 blocked + 义务登记，不硬跑。

**三条硬性经验（实跑踩出来的）**：1）**超时按真实耗时调**——默认 `verifyTimeoutMs = 600000`（10 min），
而 `workload build --model LeNet` 实测 **18–20 min**；把长命令写进判据前，先在 `config.yml` 里放
`verifyTimeoutMs`（执行器会杀整棵命令树，不会再留孤儿进程）。2）**判据必须自带工作目录**——verifier 的 cwd
是 env 根，不是仓库检出目录。3）**一次调用跑不完的活别硬塞一个 agent turn**——长构建 / 仿真走 bbdev MCP 的
submit/poll（`task_status` 轮询而非阻塞等待），或交给 `jobs`；不适合塞进单一判据命令。

**失败、中断、超时的语义（都已实跑验证）**：

| 情形 | 行为 |
|---|---|
| 子任务判据失败 | 该 run `TaskFailed`（证据里带 exitCode 与日志路径）→ 依赖它的后续子任务 `TaskBlocked`（不 spawn）→ 父 composite 判据 fail → 父 `TaskFailed` |
| 依赖排序 | 依赖任务的 `TaskVerified` 之后，下游才 `TaskStarted`；handoff 的 `relevantEvidence` 只带依赖任务的证据 |
| 调用方中断 | 取消 root 会话的 turn → 在飞 worker 收到 `tool call aborted` → 子 run 与父 run 都 `TaskCancelled`；无证据、无产物；会话可继续用 |
| 验收超时 | 到达 `verifyTimeoutMs` 时执行器**杀掉整棵命令树**，判据 inconclusive（details 写 `timeout after Xms`），run `TaskFailed`；终态 run 不再接受任何迟到证据（reducer 强制） |
| 安全网 | 验收器完全不守时时，编排器在 `verifyTimeoutMs + 15s` 兜底放弃，文案写明两个 deadline |
| 能力缺口 | 声明了表里没有的能力且未标 `decomposable` → 整批拒绝，root 收到错误文本；缺口被记录的语义与"拒绝"要分清 |

**什么时候不要上图**：

| 别上图 | 原因 |
|---|---|
| 单文件小改 / 改个 toml 名字 | 图的开销（1–3 min 起步 + 每子任务一次 LLM 会话）远大于改动 |
| 契约讨论、字段命名、"这段时序是不是 bug" | 本质是人类决策，没有可判定判据 |
| 波形判读 | 只能给出条件事件证据，人必须看 |
| 超过 timeout 的单步 | 不调 config 就会判超时失败 |
| 需要 vivado / FPGA 的车道 | 本机缺工具 → plan 直接 blockedLanes，人直做更快 |
| 私有仓库 clone | env-builder 不注入凭据，先人工备好 |

**血缘与检索**：`agent-runtime.spawn` 在 `ctx.agents.create` 的 `meta` 里写
`parentSession / origin:'subagent' / delegationDepth(父+1) / isSeeded:false`（照抄 DSH 自己的子 agent 路径
`subagent/subagent/src/child-agent.ts:139-153`）；worker 挂 `@deepseek-ai/dsh-tool-session-query`，按 seq 精确读
父事件（全文检索关闭）。handoff 的 `parentSessionRef` 已在 worker prompt 的 `## Parent session` 小节渲染
（`task-runtime/src/handoff.ts:117-121`），"子任务按需拉父上下文"的闭环已经形成；**每轮契约重注入亦已落地**
（2026-09-18 并行工作：契约作为 system-prompt section 每步重投影、compaction 不吃节点 0，见 §2.6.3 与 §4.2 #6）。

### 5.4 记忆、压缩与复盘的最小落点

**要做什么**（口径见 §2.6 / §2.7，这里只给最小落点）：

1. **四层记忆，不建"一个大 Memory"**（`细化想法1.md:386-404`；`细化想法4.md:902-956`）：M0 原始执行记忆
   （session 事件 / 工具调用 / 输出）、M1 任务记忆（task state / 决策 / 产物 / 验收证据）、M2 经验记忆
   （失败模式 / 可复用流程）、M3 演化记忆（review / diagnosis / mutation / regression / lineage）。
   Task、Session、Memory、Review **共享 ID 与 lineage，但不共用一棵物理树**（`细化想法1.md:1`）。
2. **上下文分层 L0–L5，两条硬约束**（`细化想法2.md:607-644`）：L0 方针常驻、**L1 任务契约常驻且不许被
   compaction 丢掉**、L2 父 handoff（有界摘要）、L3 skill 只放目录按需取正文、L4 检索（session / artifact /
   evidence）、L5 长期记忆。硬约束一：**TaskSpec / Verification / Evidence 不进 chat context**，结构化、
   每轮按需注入；硬约束二：压缩只换对话摘要，**原始事件留在 raw session log，可回放**。
3. **记忆工程 DSH 内置优先**（`细化想法2.md:646-687`）：MVP 走 session + session-query + session-reference +
   compaction + task store + artifact store；**"先不要接 Graphiti"**（时序语义图留 P6）；Letta MemFS 只借
   "重要信息常驻、长尾 lazy load"的思想，不引入其技术栈。
4. **复盘（review）**：每次 session 结束调一次 review 工具产出评估表（人类原意⑧）。Review **不是打分器**，
   产物是 `FailureLocalization` + mutation proposal（`细化想法1.md:506-692`）；Review≠Judge、Data-first、
   不为每个 task 养常驻 reviewer（`细化想法3.md:11,19-37`）；字段与形态按 `细化想法4.md:963-1143`
   （ReviewRecord / 维度 / Diagnosis / 自下而上 review 与自上而下 debug / **lineage graph**）。
5. **压缩的正确姿势**：不是"把摘要写得更聪明"，而是让不该进 chat 的东西（契约、证据）不进 chat——
   目标是压缩永远不改变任务含义。现在已到"正本不在 chat（task store / EvidenceStore）+ spawn 注入一次 +
   **契约每轮重注入（compaction 不吃 surface 节点 0，2026-09-18 并行工作落地，见 §2.6.3 / §4.2 #6）** +
   `task_read` 按需重取"。

**现在怎么做**（最小落点；其余后置）：已落地 M0 = 每 session 一个 append-only 日志（压缩不删原始事件）；
M1 = task store（`.dsh/sessions/_no-cwd/sg-t-*`：契约 / 依赖 / capability / 证据 / handoff）；证据 =
`.dsh/task-evidence/`；跨会话读取 = `session_event_read` / `session_trace`（已挂 worker；**全文检索关闭**）
+ handoff 里的父会话指针。现成参数：`compaction-basic`（0.8/0.16）+ tool-result pruner（8192 阈值，保头 4096 +
尾 1024）+ 手动 `/compact`。P4 轻量 ReviewRecord **已落地**（每 run 终态一条、无评分、失败才写
`localizedCause`，2026-09-17 W3；后又增八维事实 `dimensions` 与工程量 `metrics`，见 §2.7.1），
ReviewRecord → Diagnosis 第二步与升级评审 agent 亦已落地（§2.7.2 / §2.7.3）。后置：M2 / M3、Graphiti 类时序知识图、Letta 类自维护知识库，以及
`examples/mcp-memory` 类 MCP 记忆（`细化想法2.md:659` 引用的"官方示例"在本 vendored 树的位置已于
2026-09-18 核实：`apps/cli/config/examples/mcp-memory/` 真实存在——早前"没有 `examples/` 目录"的记录过时；
真要用仍先核实其内容与许可）。

**没有 `/retro` 这个工具**（DSH 与想法文件里都不存在）。它想干的事拆成三件已存在的东西：压缩 =
`compaction` / `/compact`；看证据 = `session-query` + `.dsh/task-evidence/`；写记录 = P4 的 ReviewRecord。

### 5.5 人机协同

**必须人参与的五处**：私有仓库凭据；`hitl_approve` 的不可逆 / 敏感动作；是否开 PR；波形 / PMC 判读；
Ball 契约 Phase 0 确认。（§2.9 的"高风险 mutation"清单是这套机制在 P5 的扩展。）

**现有通道（已收敛到原生 seam，2026-09-17）**：root 的 `hitl_ask` 走 `ctx.userQuestions.ask`
（`agent-singularity/src/tools/ask.ts`），`hitl_approve` 走 `ctx.approval.request`
（`agent-singularity/src/tools/approve.ts`，审计对 `approval/asked` + `approval/decided` 由原生层写）；
`ctx.hitl`（`agent-singularity/src/hitl.ts`）不再是独立状态机，而是这两条 waterfall 的**画布 answerer**——
注册 `user-questions/request` / `approval/request` 监听，把问题桥接成待处理卡片（`hitl/change` SSE +
`GET/POST /singularity/hitl` 不变，画布 UI 不动）。这两条监听按**优先权**注册（`{ prepend: true }`，
`hitl.ts:62-74`），抢在网关的 mux 转发器之前认领：转发器在零浏览器客户端时会把请求无限挂起且从不
`next()`（§4.2 #17），画布 answerer 必须先拿到才有得答。代价是浏览器 mux UI 不再收到 singularity agent
的 approval / 单问 user-question——**画布是本部署唯一的 HITL 面**，与"人只在画布上作答"的部署形态一致。
fail-closed 全按原生语义：无 answerer 时 ask 抛
`NO_PROVIDER`、approval 落 `'unavailable'`（工具映射为带原因的 reject）；画布呈现不了的批量提问
（多 question）走 `next()` 委托。两个配套改动：root session 的 approval policy 被钉为 `'ask'`
（`agent-runtime/src/index.ts` 的 `pinRootApprovalPolicy`——`danger-full-access` 捆绑的 `'never'` 会让
`hitl_approve` 在到达 answerer 之前被自动拒绝；root 工具白名单里没有其他 policy 门控工具，所以无副作用），
worker session 保持 `'never'`（worker 调 `hitl_approve` 现在被原生语义确定性拒绝并留审计——worker 的
HITL 通道仍是 `ask_user_question`）。链路证据：`tests/integration/hitl.spec.ts`（提问 → 卡片可见 →
回答 → 原生 ask/waterfall 收到答案；abort → `ASK_ABORTED`；批量委托 → `NO_PROVIDER`）。

### 5.6 上游升级注意（实测于 dsh-v0.1.3-alpha.2 → dsh-v0.1.6-alpha.1）

升级 submodule 后走官方 `tools/scripts/install-all.sh` 重建即可，但有若干处**必须**知道的差异（2026-09-17 按
`c389f96bf3..0d1f50007f` 逐条重核，1–4 条仍成立）：

1. **`llm-deepseek` 的协议默认值变了**：新版 `protocol` 默认 `messages`（打 `<baseURL>/messages`），而本网关只提供
   OpenAI 兼容的 `<baseURL>/chat/completions` → 症状是 `DeepSeek Messages request failed (404)`。
   修法：`tools/scripts/sync-api.mjs` 在生成 settings 时显式写 `protocol: chat-completions`（本仓已改）。
2. **扩展字段贡献者的默认值变了**：`session-log-deepseek` 的 `enabled` 由 `false` 变 `true`，会给每个请求加
   `dsh_session_log` → 严格校验的网关报 `UNKNOWN_FIELD`（与 `dsh_plugin_packages` 同类）。
   修法：`config.yml` 文档 1 里把两个贡献者都关掉（`plugin-package-inventory-deepseek`、`session-log-deepseek`）。
3. **`AgentSetup` 签名变成 `(agentCtx, agent)`**：不要再读 `agentCtx.agent`（新版把 `agent` 从 ctx 上撤掉，
   会抛 `cannot get property "agent" without inject`），用第二个参数。`exec.agent`（工具上下文）不受影响。
4. **session 格式 v2 → v3**：新写的会话/存储是 `session.v3.jsonl.zstd`；上游带 v2→v3 **读时迁移**
   （`packages/session/session-format-v2-to-v3`，静态 catalog 消费，不需要挂插件）。但迁移对**未分类事件**
   **直接拒绝**（`payload.ts`），而我们的 `graph/event`、`graphs/event`、`layout/event`、`task/event` 都是自定义类型
   → **旧的 v2 存储无法迁移**。处置：把含自定义事件的旧存储移出 `_dsh/sessions`（本次 69 个目录移到
   `.dsh/sessions-v2-legacy/`，可回退），让运行时从空状态起步；纯上游事件的会话日志不受影响、按需自动迁移。
   注意：我们的写入**已经带 `ignorable: true`**，所以**今后**的 v3 数据没有这个问题。
5. **agent preset 的默认值不再是配置字面量**：`defaultId` 现在读 `selectionPolicy()`——settings 命名空间
   `agent-presets` 的 `default` / `modeSelectionEnabled` 能盖掉 web bundle 里的 `default: standard`
   （`packages/preset/agent-presets/src/index.ts:243-259`；web 把选择器本身也藏在这个 setting 后面）。
   我们所有 spawn / createRoot 都显式传 id，所以只受"这个 id 不存在或坏了"影响：`mount()` 先 `resolve()`，
   再对 `broken` 的预设抛错（`:365-410`、`:443-456`）。
6. **启动严格性变了：可选插件坏了不再拖垮进程**。app-boot 只对 7 个 required entry id（`agent-loop` /
   `webserver` / `modules` / `connection` / `headless-runner` / `acp` / `sdk-jsonrpc-server`）fail-closed，
   其余"警告 + 继续"（`packages/boot/app-boot/src/index.ts:711-719,807-833`）。我们 profile 里绝大多数是自建
   插件 → 一个实验插件坏掉时 3080 仍能起来；代价是**坏插件不再有响亮的失败**，要靠启动 warning 才看得见。
7. **有 row id 被删/改名**：`code-runtime`（含 `-worker-thread`）→ `ptc-runtime` / `ptc-runtime-node`；
   `workflow-worker-thread` → `workflow-ptc`；`e2b/*` 整族删除；`ui-sidebar-textpreview` →
   `ui-sidebar-documentpreview`。patch 里写一个**不存在的 id 不会报错**：`applyEntryPatches` 只**警告并跳过**
   （`vendor/include/src/index.ts:110-114`；`name` 与目标行不一致同样跳过，`:117-120`），只有 `insert:` 才会加行。
   所以旧 overlay 里残留这些 id = 静默失效（只在启动 warning 里露一次），配合上面第 6 条"可选插件不再 fail-loud"
   更容易漏。已核本仓 `config.yml`：只有 `tool-session-query` 一个 insert 行，不含上述 id。
8. **新增两个我们直接能用的底座件**：`mcp-resources`（base bundle 已挂，给模型 3 个工具
   `list_mcp_resource_templates / list_mcp_resources / read_mcp_resource`；`packages/bundle/base/cordis.patch.yml:471-472`、
   `docs/tool-catalog.md:49-127`）；`present`（声明交付文件，`standard` / `ptc` / `cordis` preset 都挂；
   `packages/preset/agent-presets/presets/standard/agent.cordis.yml:261-262`）。DX 上多了一条
   `--dump-default-config`：只打印 bundle 层，不含用户层与 `--patch` overlay（`apps/cli/src/args.ts:148-149`）。
9. **system prompt 现在是 surface 节点 0，它的改动能以 in-history 追加**：`system/message` 是 surface 事件，
   agent-loop 每步重新投影（`packages/core/agent-loop/src/agent.ts:361-372`、
   `packages/core/agent-loop/src/runtime-context.ts:56-98`）；surface 被换掉（含 compaction）后
   `startsSeries` 成立，投影会把节点 0 重写成当前渲染结果、清空其后的 system 节点——即 **system prompt
   不会被压缩吃掉**。这正是 §4.2 缺口 6 缺的那条机制：把 TaskSpec / 判据摘要做成 worker 的
   `systemPrompt.section()`，由 loop 每步重渲染。**但**"in-history 追加"只在路由声明
   `systemPromptUpdate: 'in-history'` 时成立（`packages/llm/llm-deepseek/src/config.ts:77`、
   `packages/llm/llm-deepseek/src/protocols/messages/serialize.ts:56`），本网关走 `chat-completions`，
   是否被网关接受**未实测**——先在 smoke 会话上验，别直接上 root。
   **2026-09-18 后续**：缺口 6 已由并行工作按本条机制落地（worker 契约注册为 worker 作用域的
   `systemPrompt.section()`，见 §2.6.3 / §4.2 #6）；`chat-completions` 路由下投影不走 in-history 追加，
   而是改写节点 0（`runtime-context.ts` `project` 的非 in-history 分支），不依赖网关接受中段 system 消息，
   行为由 `tests/integration/worker-contract.spec.ts` 断言。

**残留（已上报未修）**：新版 `CreateAgentOptions` 新增 `parentAgent`（"omit for a root Agent"），我们的 `spawn`
没传 → 上游按 `agents.roots()` / `isOwnedBy` 做门禁的插件（schedule / goal / user-questions）会把 worker 当顶层 agent。
但**"最小修法 = 传 `parentAgent: parent`"要带上后半句**：`userQuestions.ask` 对"被别的 live agent 拥有的"调用方
直接抛 `DELEGATED_CALLER`（`packages/interaction/user-questions/src/index.ts:101-107`），DSH 自己的子 agent 路径
正是传 `parentAgent`（`packages/subagent/subagent-in-process-driver/src/index.ts:136`）。所以传了之后 **worker
会失去 `ask_user_question`**（§5.5 现在把它算作 worker 的 HITL 通道）。要么先补 §4.2 缺口 2 的 `ask_parent`，
要么把两者当一件事一起改。

---

## 6. 速查与维护约定

**我们的工具面（root 白名单，22 个，2026-09-20 逐项比对 `agent-runtime/src/index.ts:24-49` 复核；`skill` 为 2026-09-18 后新增，root 用它加载领域参考 skill）**：`graph_spawn`、`graph_mark_ready`、`hitl_ask`、`hitl_approve`、
`task_read`、`capability_list`、`task_decompose`、`task_status`、`task_verify`、`task_review_pack`、
`task_review_agent`、`task_diagnose`、`evolution_propose`、`evolution_candidate`、`evolution_prepare`、
`evolution_replay`、`evolution_gate`、`evolution_decide`、`evolution_apply`、`evolution_rollback`、`evolution_list`（`agent-runtime/src/index.ts` ROOT_TOOLS；注意 §4.2 #15：evolution_* 工具
2026-09-17 夜实跑时因 inject 漏声明全部运行时报错，同日 W12 改为把 ledger 服务挂在 agent fiber 上修复，修复已经 M2 实跑复核通过——2026-09-17 晚 graph12
root 续投跑通 P4→P5 全链，见 §4.1 M2 段与 §4.2 #15；画布代答的前置缺口另见 §4.2 #17；W15 加入 `evolution_replay`，机械型提案的 gated 前必须经过它，见 §2.7.7；W16 加入 `evolution_apply` / `evolution_rollback`，各带一次原生人审，见 §2.7.7）。
**worker 工具面（2026-09-18 起为 grant 收敛的 allow-list，不再是"全局层 + 预设全套"）**：task 链路 spawn 的 worker
必带 grant（`task-runtime/src/orchestrate.ts:638`），可见面 = capability 声明的工具（标签展开）∪ baseline ∪
（命中能力自带 preset 时的）preset 自有面（`agent-runtime/src/grants.ts:100-117`）；baseline = `WORKER_BASELINE_LABELS`
展开的 filesystem / bash / jobs / search / skill / session-history / ask-user 七组 + `WORKER_BASELINE_TOOLS` 四个
task 机械工具（`task_read` / `task_status` / `task_decompose` / `task_verify`）（`task-runtime/src/capability.ts:124-169`）。
baseline **不含** `hitl_*`（worker 的 HITL 通道是 `ask_user_question`，见 §5.5）；`graph_spawn` 刻意不在 baseline
（绕过 Task Admission，`capability.ts:156-168` 注释写明缘由）。无 grant 的 spawn（如图 setup worker）保持组合原面。
授权 skill 钉进 worker 自己的 skill 层保证在场（`grants.ts:180-209`）；capability 声明而组合未提供的工具在
spawn 前响亮失败（`grants.ts:67-77`）。**MCP 面（2026-09-18 W21 起）**：能力行 `mcpServers` 声明的 server
在 spawn setup 里按该 run 的 env 检出物化并逐台挂载（`grants.ts:219-246`，`failOnStartupError` 固定 true），
工具名 `mcp__<server>__<tool>` 落在 worker 自己的工具层——`tools.restrict` 只收敛继承面，故这层不在
allow-list 内；server 起不来 = spawn 失败 + failed run + ReviewRecord（单测 `mcp-servers.spec.ts` /
`orchestrate.spec.ts`，集成 `worker-mcp.spec.ts` 用真 mcp-client + 测试自带 fixture server）。
**服务**：`task`（任务 store）、`verifier`（验收注册表）、`taskRuntime`（编排）、`graphs`、`agentRuntime`、
`envBuilder`、`agentPresets`、`jobs`、`sessionQuery`、`permissions`、`sandbox`、`evolution`（P5 台账，
`.dsh/evolution/proposals.jsonl`）。
**关键路径**：任务事件 `.dsh/sessions/_no-cwd/sg-t-*/session.v3.jsonl.zstd`（ReviewRecord 就在这条流里，
`ReviewRecorded` 事件；Diagnosis 在 `DiagnosisRecorded` 事件）；证据 `.dsh/task-evidence/`；
环境 `environment/projectN/<owner>/<repo>`；网关事实 `config.yml` 第二文档；义务模板 `.agents/skills/*/obligations.yml`（正本 `bb-obligations/`，7 条 BB 域义务）；义务事件 `ObligationRecorded` 在任务事件流；覆盖检查出口在 `task_status` 行尾。
**env 复用**（W11 实证；2026-09-18 W24 升级为默认复用优先，M6 真机验证）：删图（`POST /singularity/graphs/<id>/delete`）归档图并派 env-clean worker 把检出 git reset 到干净树（检出保留、sessionIds 清空）；此后三条复用入口——`envId` 精确指定 / `workspace` 命名绑定 / `createEnv` 带 repos 自动匹配（`fresh:true` 强制新建）。M6 实证：同 repos 建图 `reused:true`、零 clone、约 10s ready（vs 新建约 70s）。注意 §4.2 #32：老 env 的 sessionIds 残留会让 available 恒为 false。

**素材文件**：`/home/ROXY/code/ref/docs/` 下七份（`初始想法.md` 唯一人类亲笔、权重最高；`细化想法1.md`
概念原始稿；`细化想法2.md` 抽象稿；`细化想法3.md` 批判评审；`细化想法4.md` 冻结 RFC v1.0，我们实现的依据；
`VRTC-最小架构-KISS版-v2.0.md`（v2.1-KISS，2026-09-20 入档，本轮及今后对照的 **VRTC 基线**，本文档简称
"KISS §x"，对照缺口见 §4.2 #20–#31；它与本文档的 12 条冻结原则**不是**同一套编号，冲突时以 §2 为准）；
`VRTC-可验证递归任务构建-通法教程-v1.1.md`（v1.1 教学稿，2026-09-20 入档，按需查）。
`细化想法4.md:19-23` 的口径：冻结的是系统原则，不是代码级 API。

**归因口径**：只有 `初始想法.md` 里的话标"人类亲笔"（唯一的人类输入，权重最高）；`细化想法1.md` /
`细化想法3.md` 里复述人类原意的地方标"人类思路（经细X 转述）"——这两份都是 AI 写的抽象与评审，转述只能算线索，
不能当亲笔证据；其余一律"AI 推导"。（此前把细3 的若干行直接标成"人类亲笔"，已按这条口径改掉。）

**设计裁决来源**：`细化想法1.md`（原意与四条关键修改 `:1987`）= 概念原始稿；`细化想法4.md` = 冻结 RFC；
等价关系举例：细1 原子性五条（`:1521-1527`）= RFC §36；细1 工具面（`:758-920`）= RFC §15；
细1 memory（`:386-404`）= RFC §21；`细化想法3.md` = 上述结论的论证版。

**维护约定**：本指南随实现变化更新；只有一条准则——**写进来的每一句都要能被代码或实跑验证**，
验证不了的就别写。§2 是方向（改动要慢、要记出处），§5 是实现参考（可随实现演进推翻）。
2026-09-18 审计（A5）发现本文件曾出现"状态与现实相反 / 坐标漂移 / 无出处断言"三类失真，由此硬化三条：
① **每条状态句必须带"日期 + 证据锚"**（`file:line` 或事件路径），两者缺一不写；历史实施记录（§4.3 各 W 段）
的坐标是该日期的快照，刷新现状句时不回改历史记录、只在新句给新坐标。
② **§4.2 缺口表每行带"末次复核"日期**；任何代理复核某行（无论改不改结论）都把该日期推到当天。
③ **多代理并行分工协议**：任何代理的代码改动改变了 §2 / §4 状态词所描述的现实时，必须同批更新本指南
（并在 §4.3 记一条实施记录）；只改了文档的代理（如 W18）在 §4.3 记 remediation 记录并给全表打"末次复核"。
**任何与 §2 冲突的实现，先在 §4.2 里记一条缺口，不要静默偏离。**
