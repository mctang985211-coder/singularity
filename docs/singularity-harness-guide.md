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
  出处：`初始想法.md:1 [字符 54-127]`（人类亲笔）；`细化想法1.md:1`（"其实不是'给 Singularity 加一个任务树'这么简单，而是……构建一个……元 Harness"）；`细化想法1.md:1797-1858,1985-1993`。现状：**部分**（Task 语义层已建，Review / Evolution 平面未建）。
- **2.1.2 只预设 Goal + Constraints + Acceptance Criteria + Available Capabilities，不预设固定 workflow。** 问题：避免把某条领域流程（ISA → Microarchitecture → RTL → Integration → Verification）写死成系统前提。
  出处：`细化想法4.md:56-75`；`细化想法2.md:290-292`。现状：**已实现**（T0 只预设判据、不预设拆法）。
- **2.1.3 按六个平面组织（Task → Capability → Execution → Evidence/Verification → Review → Evolution），并至少维护四种逻辑关系：Task Decomposition Tree / Task Dependency DAG / Execution Lineage / Review·Evolution Graph。** 问题：给所有对象与服务一个不变的层次归属；混成一棵物理树会让"这次为什么失败"无法横向追查。
  出处：`细化想法4.md:125-171,175-231`；`细化想法1.md:1797-1858`；`细化想法2.md:5-7,1720-1734`；`细化想法3.md:39-59`。现状：**部分**（Task / Execution 两平面已建；Decomposition Tree 与 Dependency DAG 已实现，Review / Evolution Graph 未建）。
- **2.1.4 划死包边界与 adapter：Singularity 不重造 Session / Skill / MCP / Memory / Subagent。** 问题：重复造轮子既无价值，又与 DSH 职责冲突。
  出处：`细化想法4.md:83-119,1573-1635`；`细化想法2.md:1623-1659`；`细化想法1.md:1858`；`细化想法3.md:96`。现状：**已实现**。落位：层 3 域能力 = buckyball 的 5 个 skill（ball-align / check / chip-designer / verify / waveform）+ `nix develop -c bbdev …` + verify-runner 的 ci-dispatch VERDICT；层 2 Task 语义 = 本仓自建三包（task / verifier / task-runtime）+ 四个 `task_*` 工具，只解决契约 / 准入 / 依赖 / 验收 / 证据；层 1 图与环境 = graph / graphs / layout / agent-runtime / agent-singularity / graph-web / map + env-builder（多 agent 拓扑、生命周期、可视化）；**其余一切归层 0 的 DSH**。

### 2.2 任务

- **2.2.1 真正的核心单位是 Task Contract，`acceptance` 是其中最重要的部分：固定的是 Contract，不是 Workflow。** 问题：Task 若只是一句目标就没有边界与判据，自主分解会失控、验收会退化成"人说了算"。
  出处：`细化想法1.md:88-151`（`:149`）；`细化想法4.md:447-469`。现状：**已实现**（TaskSpec + AcceptanceCriterion）。
- **2.2.2 每个 task 必须是完整、可验证、可确保正确性的节点；大 task 切小 task 及其 skill，直到原子级别。** 问题：把 core 级设计任务切成"每步都能单独验收"的节点，避免整段返工。
  出处：`初始想法.md:1 [字符 184-223]`、`[字符 262-291]`、`[字符 340-401]`（人类亲笔）。现状：**已实现**。
- **2.2.3 分解是 Tree、依赖是 DAG：DecompositionEdge 与 DependencyEdge 分开建模。** 问题：共享依赖（如 ISA 定义同时喂给 decoder 与 simulator）强制成树会重复复制上下文。
  出处：`细化想法4.md:27`（"分解是 Tree"半句出自这里）；`细化想法2.md:398-460,1613`；`细化想法1.md:202-264`（这处讲的是"底层应是任务 DAG、UI 可以仍表现为 tree"）。现状：**已实现**（`dependsOn` + 无环准入，`task/src/types.ts:47`）。
- **2.2.4 状态迁移由 Harness 提交，Agent 只能提议；准入先拒后跑。** 问题：状态若由 Agent 自宣，合法性判断就被推给执行期。状态机：CREATED → ADMISSION → READY → (DECOMPOSE | EXECUTE) → …
  出处：`细化想法4.md:376-409`（`:409`："Agent 可以提出状态转换，但 Harness 执行合法性检查并提交最终状态"）；`细化想法2.md:1602-1619`。现状：**已实现**（最小版）。
- **2.2.5 DECOMPOSE 必须过 Decomposition Verifier：覆盖父判据？依赖完整？无环？子可验证？Capability 可满足？其中包含原子性判定——允许 `CanSplit = false`，否则不许继续 split。** 问题：分解动作本身缺少准入检查会变成新的失控源；而把"写一个 XOR gate"拆成 choose symbol / choose net names / place pin… 是无意义递归。
  出处：`细化想法4.md:431-443`；`细化想法2.md:231-292`；`细化想法1.md:1484-1551`（`:1521-1534`）。现状：**部分**（准入已实现，判定器未形式化）。
- **2.2.6 TaskDefinition 版本化且 immutable：任何改动必须产生新 version，不许原地改。** 问题：没有版本化就无法 replay / rollback / bisect，evolution 里的 candidate 与 champion 也没有对齐基准。
  出处：`细化想法2.md:1602-1619`（`:1609`："TaskSpec 是 immutable/versioned，修改产生新 revision"）；`细化想法4.md:235-280`（`:278-280`："版本化的 immutable canonical definition……修改 TaskDefinition 必须产生新 version"）。现状：**已实现**（最小版：`definitionRef` 带 version，包内没有原地改定义 API，`task/src/types.ts:20,35`）。

### 2.3 执行

- **2.3.1 TaskRun ≠ Session：TaskRun 必须绑定一个 DSH Session，但一次 Task 可有多次 Run。** 问题：`task_id = session_id` 会让 retry、换模型重跑、A/B skill、regression 全部变难。
  出处：`细化想法3.md:5`（人类思路，经细3 转述）；`细化想法2.md:89-128,208-227`；`细化想法4.md:331-372`。现状：**已实现**（TaskDefinition / TaskInstance / TaskRun）。
- **2.3.2 父子默认走结构化 Handoff，不复制父 transcript。** 问题：父 session 原文整体复制会造成 context explosion，也让父子通信没有可审计边界。
  出处：人类亲笔只支持前半句——`初始想法.md:1 [字符 673-720]`（"子 task 先阅读父 task 的上下文"）、`[字符 754-789]`（"可临时 fork 一份父对话专门用于交接"）；"默认走结构化 handoff、不复制父 transcript"是 **AI 推导**（`细化想法1.md:268-382`，`:282-284` 明确反对把完整 parent transcript 当 child context）；`细化想法4.md:792-879`。现状：**已实现**（`buildHandoff` / `renderWorkerPrompt`）。**（本条属"部分人类亲笔"）**
- **2.3.3 Push small, Pull deep：child = fresh session + TaskSpec + 判据 + Handoff + skill 目录 + 父会话指针；深层历史用 session-reference / query / trace 按需拉取。** 问题：给少了交接不清，给多了每轮都付 token 且破坏 prefix reuse。
  出处：`细化想法3.md:7`（人类思路，经细3 转述）；`细化想法2.md:464-564`；`细化想法4.md:792-879`。现状：**已实现**（handoff 已实现；父会话指针已在 worker prompt 的 `## Parent session` 小节渲染：`task-runtime/src/handoff.ts:96-102`，断言见 `task-runtime/tests/unit/handoff.spec.ts:85,128`；深层历史按 seq 精确读，全文检索仍关闭——见 §4.3 第 4 条）。
- **2.3.4 Fork 只作 escalation，不是默认。** 问题：每个节点都 fork 会复制思维背景、放大 context；人类自己也点过名："这种方式也可能造成上下文灾难"。
  出处：`初始想法.md:1 [字符 754-826]`（人类亲笔）；`细化想法2.md:568-603`；`细化想法4.md:29`。现状：**已实现**（默认 fresh）。
- **2.3.5 Worker 的 preset 应按任务能力选择，而不是无条件继承父 preset。** 问题：现在 Worker spawn 直接继承父 preset，没有按任务选能力组合。
  出处：`细化想法2.md:866-947`；`细化想法4.md:712-788`。现状：**部分**（`capability → preset` 已接线 `task-runtime/src/orchestrate.ts:193`，按 resolver 选择未实现）。

### 2.4 能力

- **2.4.1 Task 只提 capability requirement，经 Capability Resolver 产出 CapabilityManifest；不写 `skills: [...]` 直接绑技能列表。** 问题：skill v1 被 v2 替换时 TaskSpec 不该改。
  出处：`细化想法4.md:583-608`；`细化想法1.md:696-754`；`细化想法2.md:756-799`。现状：**已实现**（`requiredCapabilities` + resolver）。
- **2.4.2 用 DSH skill subsystem 的 progressive disclosure（catalog → 按需取正文），不重造 skill loader。** 问题：Skill Registry 与按需加载不值得自己实现。Skill 另有成熟度生命周期 EXPERIMENTAL → VALIDATED → HARDENED → STABLE → DEPRECATED，evolution 生成 candidate version。
  出处：`细化想法2.md:691-750`；`细化想法4.md:647-708`。现状：**已实现**（catalog 与加载）/ **未建**（成熟度约定）。
- **2.4.3 Capability 三态 CLOSED / PARTIALLY_CLOSED / GAP；允许 task 先进入执行。** 问题：要求 task 一生成就列全能力会限制自由生长，Capability Resolver 会变成新的"隐藏 workflow"。
  出处：`细化想法3.md:61-69`；`细化想法4.md:612-643`。现状：**部分**（现行是 fail-closed 整批拒绝）。
- **2.4.4 缺口是合法状态与信号，不是终态：找 sibling skill → 组合多个 skill → 请求父 → 临时 procedure → 提新 skill proposal → 人 / 受控晋升。** 问题：agent 卡在"想做事但没工具"会静默失败。
  出处：`细化想法1.md:1555-1602`；`细化想法4.md:612-643`；`细化想法2.md:296-394`。现状：**未建**（现路径 = `decomposable: true` 再分解 + 人工补能力表）。
- **2.4.5 工具面分三层：L0 Universal Control / L1 Task·Capability Scoped / L2 Dynamic·Temporary（只给 Evolution Sandbox 或受授权 builder）；不给所有 task 全量 tool list，也不做 per-task 特制 profile。** 问题：tool schema 本身就是每轮 token 成本；`task_1234_special_profile` 式做法不可维护。
  出处：`细化想法4.md:712-788`；`细化想法1.md:758-824`（这一处给的是**两级**：Universal Core Tools + Task Capability Tools）；三级 L0 / L1 / L2 出自 `细化想法1.md:893-920`（`:910`：Level 2 只给 Evolution Plane）；`细化想法2.md:803-862`。现状：**部分**（唯一落点是 agent preset，见 §5.1）。
- **2.4.6 工具面两种候选都先认下：全节点同一 system prompt + 同一 tool 列表，与按 task 动态加载 MCP tool。** 问题：不给 agent 写死 workflow 的同时要保证"不会产生无 skill 可用的情况"。
  出处：`初始想法.md:1 [字符 402-427]`、`[字符 467-512]`、`[字符 837-908]`（人类亲笔）；`细化想法1.md:758-824`。现状：**部分**（`capability → preset` 已接线；动态 MCP 已裁决后置，见 §4.3）。
- **2.4.7 Capability 与 Permission 分开建模，不可互相替代：Capability 回答"能不能完成这个任务"，Permission 回答"允许对什么环境做什么操作"。** 问题：两者混成一个字段会让"能力缺口"与"权限不足"互相掩盖——前者该走 capability evolution，后者该走人审提权。
  出处：`细化想法4.md:1382-1414`（`:1407-1414`）。现状：**部分**（capability 表已建；permission 分级未接线，见 §4.2 缺口 4）。

### 2.5 证据与验收

- **2.5.1 Agent 不负责宣布完成；成功路径固定：Artifact → Verifier → VerificationResult → EvidenceBundle → Acceptance Aggregation。** 问题："Done." / "Tests passed." / "Looks correct." 不能成为成功条件。
  出处：`细化想法4.md:475-497`；`细化想法2.md:1606-1612`。现状：**已实现**。
- **2.5.2 AcceptanceCriterion 必须含 verificationMode（deterministic / simulation / formal / measurement / review / composite）+ requiredEvidence + mandatory。** 问题：acceptance 要是可执行、可绑证据的判据，而不是描述性文字。
  出处：`细化想法4.md:499-518`。现状：**已实现**（六种 mode 都在类型里，`task/src/types.ts:7`；`formal` 与 `review` 由同一个 `ReviewVerifier` 接收（`verifier/src/review-verifier.ts:3,9-11`），而它恒返回 `inconclusive`（`:13-19`）——即 **formal 有路由、永不自动通过**，与 review 同走人工判读；带 command 的强制只覆盖 deterministic / simulation / measurement，`:15`）。
- **2.5.3 EvidenceBundle / EvidenceClaim 是跨 task 传递正确性的载体；父只能消费 evidence。** 问题：父子之间传"正确性"缺少可审计载体。
  出处：`细化想法4.md:544-579`。现状：**已实现**（EvidenceStore：`.dsh/task-evidence/`）。
- **2.5.4 父验收 = 组合正确性：子全绿不等于父 verified；父判据须定义 criterion → evidence refs → aggregation rule，最终仍由 parent-level verifier 验组合结果。** 问题：把"孩子都绿了"当成父任务完成。
  出处：`细化想法4.md:520-540`；`细化想法3.md:9`。现状：**部分**（composite 判据已实现，聚合规则未形式化）。
- **2.5.5 逐级返回验收指标直到任务原点，父做 synthesis 而不是只收 success / fail。** 问题：上层要验的是组合正确性，不是子节点自报成功。
  出处：`初始想法.md:1 [字符 514-528]`、`[字符 564-597]`（人类亲笔）；`细化想法1.md:1363-1428`。现状：**已实现**（composite 父验收 + 失败传播 + 证据回传）。

### 2.6 记忆

- **2.6.1 建以 session id 排列的 memory 系统：子 task 先读父上下文 → 接受指令 → 找到对应 skill → 开始工作。** 问题：没有它，每个节点各干各的，agent 就没有"对全局的掌握能力、对任务更深的了解能力"。
  出处：`初始想法.md:1 [字符 608-664]`、`[字符 673-752]`（人类亲笔）。现状：**已实现**（M0 append-only session log + task store + handoff + 血缘）。
- **2.6.2 四层记忆 M0 Raw / M1 Task / M2 Experience / M3 Evolution，不建"一个大 Memory"。** 问题：四层用途完全不同，混在一起就退化成 transcript dump。
  出处：`细化想法1.md:386-404`；`细化想法4.md:883-959`。现状：**部分**（M0 / M1 已实现，M2 / M3 未建）。
- **2.6.3 Context 分 L0–L5；两条硬约束：TaskSpec / Verification / Evidence 不进 chat context；压缩只换对话摘要，原始事件留在 raw session log 可回放。L1 任务契约常驻、不许被 compaction 丢掉。** 问题：compaction 不能改变任务含义。
  出处：`细化想法2.md:607-644`；`细化想法4.md:883-959`（`:894-898` 两条硬约束；`:915-919`：M0 raw session log 可回放）。现状：**部分**——chat 不是结构化状态（契约 / 判据 / 证据）的正本，正本在 task store 与 EvidenceStore：spawn 时注入一次（判据表写进 worker prompt，`task-runtime/src/handoff.ts:56-62`），之后由 `task_read` 按需重取；但 **L1 契约每轮重注入与防 compaction 丢弃都未实现**（包内没有任何 compaction 拦截 / 重注入代码），见 §4.2 缺口 6。
- **2.6.4 记忆工程 DSH 内置优先，先不要接 Graphiti。** 问题：需要跨几十 / 几百个 task 做语义经验检索的场景还没出现，长期记忆应晚于协议定义（P6，`细化想法4.md:2003-2005`）。
  出处：`细化想法2.md:646-687,1627-1639`；`细化想法4.md:1780-1786`。现状：**部分**（M0 / M1 落地；语义记忆按裁决后置）。

### 2.7 复盘与进化

- **2.7.1 每次 session 结束调一次 review 工具，产出针对这次 task 的评估表。** 问题：执行完就散，没有任何东西沉淀下来指导下一次。
  出处：`初始想法.md:1 [字符 922-1008]`（人类亲笔）。现状：**未建**（P4 轻量 ReviewRecord 已裁决，待实现）。
- **2.7.2 Review 是 data-first 而不是 agent-first：TaskRun 结束 → 结构化 ReviewRecord → persist；只有复杂情况才 spawn Review Agent。ReviewRecord 至少含八维（Outcome correctness / Task specification quality / Acceptance quality / Decomposition quality / Capability coverage / Skill fit / Tool fit / Context efficiency），并同时记录六项工程量指标（tokens / time / retry count / tool calls / human interventions / artifact count）。** 问题：每个 Task 都养常驻 Review Agent 会让 session 数 ×2、context 与存储爆炸。
  出处：`细化想法3.md:11`（人类思路，经细3 转述）；`细化想法2.md:1063-1105`；`细化想法4.md:963-1049,1023-1052`。现状：**未建**。
- **2.7.3 Review ≠ Judge：核心产物是 Diagnosis（observedFailure / scope / localizedCause / evidenceRefs / confidence / proposals），不是分数。** 问题：`skill_fit = 0.41` 这类分数无法告诉 evolution agent"为什么"，review 树会变成评分树而不是能 debug Harness 的树。
  出处：`细化想法3.md:11-37`；`细化想法4.md:1053-1140`；`细化想法1.md:506-630`。现状：**未建**。
- **2.7.4 review lineage 是独立因果结构：Execution Graph → Evidence Graph → Diagnosis Graph → Evolution Graph，允许 DAG / graph 而非严格 tree。** 问题：一个问题可能跨多个 task（verification 失败的真因可能在 parent microarchitecture 的 timing assumption），不能只沿 `parent_task_id` 向上爬。
  出处：`细化想法3.md:39-59`；`细化想法4.md:1053-1140`。现状：**未建**（已裁决采用 graph schema）。
- **2.7.5 复盘要综合父 task 与子 task，判断"这样长出来的节点是否合适"；用局部证据 + 父 review 摘要 + 相关祖先约束，而不是重读整条 ancestry。** 问题：单节点视角看不出节点是否长对；重读全链 token 是 O(depth × full transcript)。
  出处：`初始想法.md:1 [字符 1093-1168]`（人类亲笔；原文档在 1135 / 1137 之间只有一个逗号，引成两段会漏掉它）；`细化想法1.md:634-692`。现状：**未建**。
- **2.7.6 Review 只产生 Candidate，不直接改 production：Sandbox 做 replay / regression / held-out / deterministic verifier → candidate vs champion → 人审 → Promote / Rollback。EvolutionProposal 的 targetType 共九类（skill / tool / capability / task_definition / decomposition_policy / agent_preset / workflow_policy / verifier / runtime_policy），且必须带 `targetId` + `baseVersion`。** 问题："Agent 失败 → 自己改 skill → 自己评价 → 成功"是 self-confirming loop。
  出处：`细化想法3.md:71`（人类思路，经细3 转述）；`细化想法2.md:1220-1269`；`细化想法4.md:1144-1180,1184-1200`。现状：**未建**（禁止项从现在起即刻生效）。
- **2.7.7 Evolution 分四级（L1 执行适配不改 canonical / L2 capability evolution / L3 workflow evolution 需历史 replay + holdout regression / L4 harness evolution 原则上人工批准），并走 branch model + validation gate：不直接覆盖 main，candidate branch 记完整版本集合，最小 Gate 六问，决策 PROMOTE / REJECT / KEEP FOR FURTHER RESEARCH。** 问题：不同敏感度的 mutation 若走同一套流程，一次普通失败会一路改到 verifier，最终形成 reward hacking。
  出处：`细化想法3.md:71-94`；`细化想法4.md:1184-1283,1287-1357`；`细化想法1.md:1088-1149`。现状：**未建**。

### 2.8 自决断的边界

- **2.8.1 "自决断"是 constrained planner，不是超级自主 Agent：只暴露七个动作 EXECUTE / DECOMPOSE / ASK_PARENT / REQUEST_CAPABILITY / RETRY / BLOCK / ESCALATE_HUMAN；可执行性由 Task State、Dependency State、Capability State、Budget Policy 决定。** 问题：无边界自主性会把合法性判断推给执行期。
  出处：`细化想法4.md:413-427`；`细化想法1.md:1432-1481`（早期列 11 个动作，冻结版收敛为 7 个）。现状：**部分**（模型在 `task_*` 工具面上自由选动作，action 集合未形式化）。
- **2.8.2 Agent mutable 与 Controller mutable 分离：任务 / 记忆 / skill proposal 归前者；routing / approval / system policy / capability 授权 / task contract schema / acceptance policy 归后者。** 问题：不让 Task Evolution 与 Skill Evolution 共用一个 mutation。
  出处：`细化想法1.md:972-987`（Agent mutable / Controller mutable 六项清单原文）；`:924-956`（"不要让两者共用一个 mutation"，即技能面与任务面分开的动机）；`细化想法4.md:1184-1283`。现状：**未建**。
- **2.8.3 Level 2 runtime mutation（运行时生成 tool / 动态挂载）只允许 Evolution Plane 使用，普通 task agent 不得自造 tool。** 问题："Agent creates tool → tool creates capability → capability 改变未来 agent 行为"已属控制面改造，不该混在普通任务执行里。
  出处：`细化想法1.md:893-920`；`细化想法2.md:1468-1470`。现状：**部分**（DSH `cordis_define/run/stop/undefine` 只在受控预设下可用，授权面未建）。
- **2.8.4 明确禁止：为拿高分修改 Verifier；不能因"AI 自主性"取消 admission / verification。** 问题：Verifier 可被 Agent 修改会迅速 reward hacking。
  出处：`细化想法2.md:1617-1619`；`细化想法4.md:2052-2066`（Non-Goals 1/2/9）。现状：**部分**（现在没有任何工具能改 verifier，等于事实上禁止；成文的变更门禁需自建，`细化想法2.md:1617-1619`）。

### 2.9 人机

- **2.9.1 人只治理高风险 mutation：verifier / system policy / permission escalation / stable skill promotion / production tool installation / workflow policy promotion。** 问题：不能让数百个自动生成 task 都拿 `danger-full-access`，也不能让 Agent 直接看到内部 database / scheduler / verifier state。
  出处：`细化想法4.md:1361-1414`；`细化想法2.md:951-992`。现状：**部分**（人审通道已有，权限分级未接线）。
- **2.9.2 复盘结论与修改点必须交人类审核，不能自动生效。** 问题：自进化不能绕过人。
  出处：`初始想法.md:1 [字符 1293-1320]`（人类亲笔）；`细化想法4.md:32`。现状：**未建**（P5）。

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
| **Phase 3**（`:1765-1793`） | P5（`细化想法2.md:1825-1838`） | P5 Evolution（`:1987-2001`） | Proposal / Candidate / Sandbox / Replay / Regression / Validation Gate / Human Approval / Promotion / Rollback | 先决：P4 闭环稳定——"只有这一闭环稳定以后才进入 Evolution"（`:2048`）；每次晋升过 §32 Gate 六问（`:1329-1357`） |
| —（细1 无此阶段） | —（细2 无） | P6 Experience / Semantic Memory（`:2003-2005`） | Engram / Reference Memory、Graphiti、OpenViking 类经验记忆 | P0–P5 已有实际运行数据（`:1780-1786`） |

**现在在哪一阶段**：Phase 1 / P0–P1 的闭环已实跑（§4.1）；P2 部分落地（handoff、血缘、按需读已接线，
全文检索关闭）；P3 部分落地（capability resolve / preset 已接线，真授权未接线）。**Phase 2（P4 Review）
未开始**，Phase 3（P5 Evolution）未开始，P6 未开始。阶段判断与素材一致：已过"概念不清"、进入
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

对照 §3.2：这等于 Phase 1 / P0–P1 的 MVP DoD 闭环（`细化想法4.md:2011-2048`）已跑通。

### 4.2 缺口与偏差（按优先级，均已取证）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 1 | `capability.tools/skills` 是空接缝（只记账不授权），内置表把 buckyball 名字硬编码进库代码；**`preset` 那条是已接线的** | `task-runtime/src/index.ts:90-99,204`；`capability.ts:38-45` | 表下沉到 `config.yml`；tools 按 §4.3 第 1 条**真授权**执行：先补 `capability_list`，再把 manifest 的 tools 落到 spawn 的 agent 级 allow-list |
| 2 | worker 没有 `ask_parent` 通道，但 worker prompt 却写着"向父级升级" | `task-runtime/src/handoff.ts:109`（"escalate conflicts through your parent"）；全仓无 `ask_parent` 实现 | 补最小 `ask_parent` 工具，或删掉该措辞 |
| 3 | root 无从知道合法能力名（无 `capability_list`），"猜名 → 缺口 → 整批拒绝"是系统性的 | `task-decompose.ts:58` | 补 `capability_list`（RFC §41）或至少在 schema / prompt 列名字 |
| 4 | 权限模型未接线：root / worker 一律 `danger-full-access` | `agent-runtime/src/index.ts:130,158,216`（`208` 已是 `isSeeded:false`） | 用 `permissionPresets` 按能力分级（内置仅两档，`read-only` 在 sandbox 档，需自定义表）；`capability → preset` 已接线 `task-runtime/src/orchestrate.ts:193` |
| 5 | HITL 双实现（自建 `ctx.hitl` vs 原生 user-questions / approval）：自建那套没有 answerer 抽象、没有审计事件、没有 fail-closed | `agent-singularity/src/hitl.ts` | 收敛到原生 seam，保留画布 UI（落点与理由见 §5.5） |
| 6 | 契约每轮重注入 / 防 compaction 丢弃未实现（§2.6.3 声称的 L1 常驻覆盖不到）；当前只保证 spawn 时注入一次 + `task_read` 按需重取 | `task-runtime/src/handoff.ts:56-62`（判据表只在 spawn 时写进 prompt）；`packages/singularity` 内 `compaction` 零命中，无拦截 / 重注入代码 | 先用 `task_read` 按需重取兜住；每轮重注入与 compaction 拦截留到 P2 / P4 |
| 7 | `task_verify` 的工具描述写 **"Records no task status"**，但底层 `verifyRun` 会写 evidence（终态 run 会报错） | `agent-singularity/src/tools/task-verify.ts:33-35`；`verifier/src/index.ts:119` | 改用只读校验路径，或改文案 |
| 8 | 能力名缺项 / 重复：缺 `integrate-model` / `build-*` / `dispatch-verification`；三个 verify 能力名配置完全相同 | `task-runtime/src/index.ts:90-99`；§5.2 | 补名字、合并重复项 |
| 9 | 多余 / 残留：`verifier/pnpm-lock.yaml` 嵌套 lockfile；7 个 `canvas-*` 目录上游已删，本仓只剩残留目录（无源码，只有 `node_modules`） | `git status`；上游 `188bd03` | 提交前剔除；残留目录删除 |
| 10 | 环检测 DFS 三 / 四份拷贝（graph / task / admission） | `graph/src/service/state.ts:93-104` 等 | 收敛为共享工具 |
| 11 | README 未更新（包表与工具清单都没提新包 / 新工具）；`lib/` 是入库产物，必须跟着源码提交 | `git diff -- README.md` 为空；`git ls-files` 19 个 lib | 提交时同步 README + 重建 lib |

本表只记"已实现部分里的偏差"。§2 中标 **未建** 的条目（Review / Diagnosis、Evolution 四级与闸门、M2 / M3 记忆、capability 缺口处置）是**方向上的待建**，不是偏差：它们对应 §3.2 的 P4 / P5 / P6，按阶段推进即可。（`capability_list` 在 §2 里没有对应条目，它只是缺口 1 / 3 的前置工具。）

### 4.3 已裁决（2026-09-16）

1. **`capability.tools` 要真授权**（不是元数据）。前置顺序固定：先补 `capability_list`（否则模型靠猜名，
   且 `tools.restrict` 对未知工具名直接抛错）→ 再把 manifest 的 tools 落到 spawn 的 agent 级 allow-list。
2. **动态 MCP 后置**（不立项）。工具面唯一落点是 agent preset（§5.1）。
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

**采纳的上游 v3 能力（已裁决 2026-09-17）**：① **system prompt 作为 surface 节点 0、以 in-history 追加、每步重投影**
（补 §4.2 缺口 6「契约每轮重注入 / 防 compaction 丢弃」；实施前先实测本网关是否接受中段 `role: system`）；
② **持久化类型变更纪律**（照抄上游的 `persistence-schema.json` 指纹 + `persistence-changes/**` + 校验脚本，给我们四类自定义事件建登记）。
其余 v3 新特性（`present`、`/export`、`mcp-resources`、`auto-review`、SSH 执行世界、终端控制器）列为备选，按需再上。

---

## 5. 怎么做（实现参考）

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
| 长上下文 | `compaction-basic`（0.8/0.16）+ tool-result pruner + `/compact` | 别自己写摘要；契约 / 证据的正本不在 chat（在 task store / EvidenceStore），但**每轮重注入未实现**——见 §2.6.3 与 §4.2 缺口 6 |
| 技能 | `skill-filesystem`（`.dsh/skills`、**`.agents/skills`**、自定义根，带 watch）+ `skill` 工具 | buckyball 的 5 个 skill 就挂在这 |
| MCP | `@deepseek-ai/dsh-mcp-client` 一行一 server，工具名 `mcp__<server>__<tool>` | 无动态挂载 API；按 preset 给不同 agent 不同 server 集 |
| 权限 / 沙箱 | `permissionPresets`（内置 `workspace-write` / `danger-full-access`；sandbox 还有 `read-only`）+ `tools.restrict`（agent 级白名单）+ sandbox **fail-closed** | 提权要一句理由，路径固定单向；**现在 root / worker 一律 `danger-full-access`、分级未接线，现状与做法见 §4.2 缺口 4** |
| HITL（人介入） | `ask_user_question` 工具 + `ctx.userQuestions` + `ctx.approval` | 见 §5.5：我们自建的 `hitl_*` 与之并存，需收敛 |
| 目标 / 计划 / 待办 | `create_goal` / `/goal`（+ goal-round-driver 自动续跑）、`/plan`、`todo_write` | todo **无 owner / 依赖 / 验收**，不能当任务系统 |
| 插件与配置 | profile + bundle patch（**按 row id 整段替换 config**，无深合并）+ `config.yml` 两文档 | `./dsh web --dump-config` 看真实插件树 |
| 软依赖服务 | `ctx.get('name')` | 永远不要用 `ctx.<name>` 读未声明的服务 |
| 启动环境管理 | `./dsh`（sync-api → api.env / settings.yaml → patch → env 注入 → `NODE_USE_ENV_PROXY=1`） | 别在别处复制网关事实。本地 UA 代理只在 `config.yml` 的 `api:` 块写着 `proxy:` 时才起（`dsh:106-126`）；现在没写，运行时直连 upstream、经宿主网络代理（`https_proxy`）出网 |

**必须自建、且只有这一小块**：Task / TaskRun 状态机、AcceptanceCriterion、Verifier 注册表、
EvidenceBundle、capability 表 + admission、依赖驱动的顺序级联、TaskHandoff、composite 父验收。

⚠️ **别误用**：DSH 的 `agent-team`（`team_task_create/…`，`blocked_by` / `write_scopes`）是**协作板**，
`write_scopes` 只是建议性前缀，没有验收 / 证据，且包在 `experimental/` 下——不是 Task 语义的替代品。

**工具面只有一个落点：agent preset。** 任何"按任务改工具面 / system prompt"的需求，唯一落点是 agent 创建时的
`agentPresets.mount(agentCtx, id)`；**MCP 没有运行时挂载 API**（`packages/mcp/mcp-client/src/index.ts`），
所以"按 task 动态加载 MCP"不要立项。新增一种能力 = 在 `.dsh/.agent-presets/<id>/` 落一个预设目录
（发现无缓存：每次调用重读 roots，运行中新增的预设无需重启即可见，
`packages/preset/agent-presets/src/discovery.ts:4-6`）。人类原意里"全部节点同一工具列表 vs 按任务动态加载"
在 DSH 里不是二选一：`capability → preset` 已经接线（`task-runtime/src/orchestrate.ts:193` → spawn），
前者 = 所有能力指向同一 preset，后者 = 每个能力一个 preset，靠 `defaultPreset` + 按能力覆盖共存。
但 `capability.tools/skills` 仍只记账不授权（§4.2 缺口 1）。

### 5.2 真实场景速查

**前置条件（缺一不可）**：1）`./dsh web` 起来了（`http://127.0.0.1:3080`），LLM 网关事实只在 `config.yml`
的 `api:` 块改。2）环境先就绪：`POST /singularity/graphs {name, createEnv:true, repos:[...]}` → root 派 env
安装 worker → **agent 自己 `git clone` + 按仓库文档 build** → `env_register_component` → `graph_mark_ready`；
env-builder 只做登记与校验（`.git` + origin 一致），**不注入任何 token**，私有仓库需要人先在宿主机备好凭据。
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
| bemu 功能回归 | `run-bemu-regression` | `nix develop -c bbdev bebop-bemu batch --chip <c> --test elf-tests --clean-before`（exit 0） | 同上 |
| RTL / Verilator | `run-verilator-regression` | `nix develop -c bbdev bebop-verilator clean\|verilog\|build --jobs 16 --chip <c>` 后 `sim --binary <stem>` | 同上；单次调用易超时，见 §5.3 |
| Ball 注册校验 | `check-ball-registration` | 现无确定性 CLI（skill 指向未接线的 MCP）→ 暂缓上图 | 需先补工具接线 |
| 波形调试 | `analyze-waveform` | 无退出码判据 → 产物是人看的证据，不要写成 criterion.command | 波形在 `<repo>/log/<ts>-…/waveform/` |
| chip 骨架 / 切分 / 集成 | `design-chip` | `chip/skeleton` 冒烟 sim → `slices` 逐 stem → `integrate` batch → `bind` 逐 model `workload/kernel --build` | 五个 chip 矩阵 + KERNEL_MODELS 白名单 |
| 模型接入 + 一轮 CI | **缺**（建议 `integrate-model`） | `node packages/verify-runner/scripts/ci-dispatch.mjs --repo <r> --task-file <f> --layer merge`（0=PASS / 1=FAIL / 2=INFRA / 3=运行中） | `HF_TOKEN` + `bbRepoPath` / `verifyRoot` + `gh` 鉴权 |
| 构建前置（真实存在但无名字） | **缺**（建议 `build-chip-config` / `build-compiler` / `build-workload` / `build-kernel`） | `bbdev config --install`；`compiler --build`；`workload --build` | nix + 持久根已 bootstrap |
| 派发验证轮 | **缺**（建议 `dispatch-verification`） | `buckyball_verify_dispatch({ref, layer, manifest})` → 结构化 verdict | 同上 |

### 5.3 写法规范与陷阱

**能力名只写领域能力，不写工具名。** 能力表（`task-runtime/src/index.ts:90-99`，现内置）登记的是
`design-chip / design-ball / check-ball-registration / verify-ball-functional / run-bemu-regression /
run-verilator-regression / analyze-waveform / research`。**`bash`、`filesystem` 不是能力名**——写进去只会被
判"缺口"；worker 的 bash 由 `standard` 预设保证（实跑：worker 工具目录 77 个含 bash，且真在调用）。
一个未登记的名字 = "这张表里没有" → 缺口 → 整批准入拒绝（除非该子任务声明 `decomposable: true`）。
若将来真要接 `capability.tools` 授权，必须先有 `capability_list`：`tools.restrict` 对未知工具名**直接抛错**
（`core/tools/src/index.ts:1094-1098`），名字写错会让 worker 创建失败，比现在的整批拒绝更难排查。
`capability.skills` 同属空接缝：skill 目录只能按 preset / 自定义 root 分层，**没有按名字白名单裁 skill 的 API**
（`skill/skill/src/index.ts:113-120`、`skill/skill-filesystem/src/index.ts:56-58`）。

**验收标准要可判定、可执行、可独立。** 可执行模式（deterministic / simulation / measurement）**必须带
`command`**，判据是退出码；没有命令的条目不要写成可执行判据（admission 会拒）。复合任务用
`mode: 'composite'`（判据 = 所有 mandatory 子任务 verified），不要给 command。人工判读的条目写
`mode: 'review'` —— **永不自动通过**，留给 HITL。一条判据只验一件事；产物边界要能让另一个 worker 独立复验。

**分解：准入先拒后跑。** `task_decompose` 的每个 child 在落库前过准入（`admission.ts:26-80`）：父任务允许分解、
深度 / 数量上限、objective 非空、≥1 条判据、可执行判据必须有 command、依赖无环、能力缺口按声明处理。
任一条不过 → **整批拒绝、什么都不落库**（原子）。`decomposable: true` = 声明"这个子任务允许由它自己的 worker
再分解"（RFC §36 原子性由调用方判断）；它被接纳为 `decompositionStatus: 'decomposable'`，worker prompt 会
自动附加"去拆、别自己干完"的指引。未声明且无能力缺口的子任务是 leaf，其 worker 再调 `task_decompose` 会被拒
（这是护栏，不是缺陷）。同一条任务链上每个任务只允许分解一次（重试会得到 `already decomposed`）。

**三条硬性经验（实跑踩出来的）**：1）**超时按真实耗时调**——默认 `verifyTimeoutMs = 600000`（10 min），
而 `workload build --model LeNet` 实测 **18–20 min**；把长命令写进判据前，先在 `config.yml` 里放
`verifyTimeoutMs`（执行器会杀整棵命令树，不会再留孤儿进程）。2）**判据必须自带工作目录**——verifier 的 cwd
是 env 根，不是仓库检出目录。3）**一次调用跑不完的活别硬塞一个 agent turn**——CI 一轮 6–40 min，用 `--fetch`
轮询而非阻塞 `--wait`；长命令适合交给 `jobs` 或 verify-runner，不适合塞进单一判据命令。

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
（`task-runtime/src/handoff.ts:96-102`），"子任务按需拉父上下文"的闭环已经形成；仍缺的是**每轮把契约重新注入
（防 compaction 丢弃）**，记在 §4.2 缺口 6。

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
   目标是压缩永远不改变任务含义。注意这是**目标**：现在只做到"正本不在 chat（task store / EvidenceStore）
   + `task_read` 按需重取"，每轮重注入与防 compaction 丢弃还没实现（§4.2 缺口 6）。

**现在怎么做**（最小落点；其余后置）：已落地 M0 = 每 session 一个 append-only 日志（压缩不删原始事件）；
M1 = task store（`.dsh/sessions/_no-cwd/sg-t-*`：契约 / 依赖 / capability / 证据 / handoff）；证据 =
`.dsh/task-evidence/`；跨会话读取 = `session_event_read` / `session_trace`（已挂 worker；**全文检索关闭**）
+ handoff 里的父会话指针。现成参数：`compaction-basic`（0.8/0.16）+ tool-result pruner（8192 阈值，保头 4096 +
尾 1024）+ 手动 `/compact`。已裁决待实现：P4 轻量 ReviewRecord（每 run 终态一条、无评分、失败才写
`localizedCause`、消费方现阶段只有人）。后置：M2 / M3、Graphiti 类时序知识图、Letta 类自维护知识库，以及
`examples/mcp-memory` 类 MCP 记忆（`细化想法2.md:659` 引用的"官方示例"在我们 vendored 的 DSH 树里**无法验证**
——没有 `examples/` 目录；真要用先核实仓库与许可）。

**没有 `/retro` 这个工具**（DSH 与想法文件里都不存在）。它想干的事拆成三件已存在的东西：压缩 =
`compaction` / `/compact`；看证据 = `session-query` + `.dsh/task-evidence/`；写记录 = P4 的 ReviewRecord。

### 5.5 人机协同

**必须人参与的五处**：私有仓库凭据；`hitl_approve` 的不可逆 / 敏感动作；是否开 PR；波形 / PMC 判读；
Ball 契约 Phase 0 确认。（§2.9 的"高风险 mutation"清单是这套机制在 P5 的扩展。）

**现有通道**：root 有 `hitl_ask` / `hitl_approve`（阻塞等待，UI 在 `GET/POST /singularity/hitl` +
`hitl/change` SSE）；worker 有 DSH 原生 `ask_user_question`（走 user-questions 的 answerer，有 session 审计、
fail-closed）。

**待收敛**：我们自建的 `ctx.hitl`（`waiter Map` + `hitl/change`）与 DSH 原生 `ctx.userQuestions` +
`ctx.approval` 是**两套并行实现**——缺什么（answerer 抽象 / 审计事件 / fail-closed）与证据见 **§4.2 缺口 5**；
结论是把 root 的 HITL 也落到原生 seam 上，保留画布 UI。

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

**残留（已上报未修）**：新版 `CreateAgentOptions` 新增 `parentAgent`（"omit for a root Agent"），我们的 `spawn`
没传 → 上游按 `agents.roots()` / `isOwnedBy` 做门禁的插件（schedule / goal / user-questions）会把 worker 当顶层 agent。
但**"最小修法 = 传 `parentAgent: parent`"要带上后半句**：`userQuestions.ask` 对"被别的 live agent 拥有的"调用方
直接抛 `DELEGATED_CALLER`（`packages/interaction/user-questions/src/index.ts:101-107`），DSH 自己的子 agent 路径
正是传 `parentAgent`（`packages/subagent/subagent-in-process-driver/src/index.ts:136`）。所以传了之后 **worker
会失去 `ask_user_question`**（§5.5 现在把它算作 worker 的 HITL 通道）。要么先补 §4.2 缺口 2 的 `ask_parent`，
要么把两者当一件事一起改。

---

## 6. 速查与维护约定

**我们的工具面（root 白名单）**：`graph_spawn`、`graph_mark_ready`、`hitl_ask`、`hitl_approve`、
`task_read`、`task_decompose`、`task_status`、`task_verify`。
**worker 工具面**：全局层的 `task_*`、`hitl_*`、`graph_*`、`session_*` + `standard` 预设全套
（bash / read / write / edit / grep / glob / skill / subagent / jobs / …）。
**服务**：`task`（任务 store）、`verifier`（验收注册表）、`taskRuntime`（编排）、`graphs`、`agentRuntime`、
`envBuilder`、`agentPresets`、`jobs`、`sessionQuery`、`permissions`、`sandbox`。
**关键路径**：任务事件 `.dsh/sessions/_no-cwd/sg-t-*/session.v3.jsonl.zstd`；证据 `.dsh/task-evidence/`；
环境 `environment/projectN/<owner>/<repo>`；网关事实 `config.yml` 第二文档。

**素材文件**：`/home/ROXY/code/ref/docs/` 下五份（`初始想法.md` 唯一人类亲笔、权重最高；`细化想法1.md`
概念原始稿；`细化想法2.md` 抽象稿；`细化想法3.md` 批判评审；`细化想法4.md` 冻结 RFC v1.0，我们实现的依据）。
`细化想法4.md:19-23` 的口径：冻结的是系统原则，不是代码级 API。

**归因口径**：只有 `初始想法.md` 里的话标"人类亲笔"（唯一的人类输入，权重最高）；`细化想法1.md` /
`细化想法3.md` 里复述人类原意的地方标"人类思路（经细X 转述）"——这两份都是 AI 写的抽象与评审，转述只能算线索，
不能当亲笔证据；其余一律"AI 推导"。（此前把细3 的若干行直接标成"人类亲笔"，已按这条口径改掉。）

**设计裁决来源**：`细化想法1.md`（原意与四条关键修改 `:1987`）= 概念原始稿；`细化想法4.md` = 冻结 RFC；
等价关系举例：细1 原子性五条（`:1521-1527`）= RFC §36；细1 工具面（`:758-920`）= RFC §15；
细1 memory（`:386-404`）= RFC §21；`细化想法3.md` = 上述结论的论证版。

**维护约定**：本指南随实现变化更新；只有一条准则——**写进来的每一句都要能被代码或实跑验证**，
验证不了的就别写。§2 是方向（改动要慢、要记出处），§5 是实现参考（可随实现演进推翻）。
**任何与 §2 冲突的实现，先在 §4.2 里记一条缺口，不要静默偏离。**
