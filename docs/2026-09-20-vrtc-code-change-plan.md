# VRTC-KISS 对照：代码改动临时计划（2026-09-20）

**性质**：临时计划，不是规范。它是 `docs/singularity-harness-guide.md` §4.2 新登记缺口
#20–#31（2026-09-20 对照审计）的代码落点说明；按指南的维护约定，**方向以指南 §2 为准，
本文件与 §2 冲突时以 §2 为准**，本文件只在"某条缺口具体动哪个文件、先动哪一步"上有内容。

**对照基线**：`/home/ROXY/code/ref/docs/VRTC-最小架构-KISS版-v2.0.md`（简称 KISS §x）。
KISS 第 8 章明说判决召回 / 验证债 / 变异测试是"之后"；第 12 章给出落地顺序
（先建约束再建内容），并点名"刹车没装好，不踩油门"。本计划按该顺序排。

**现状一句话**：Task 契约层、Verifier 执行层（跑命令 + 独立性由编排器结构保证）、
Review/Diagnosis、Evolution 准入轨道都已建；缺的是 KISS 第 5.1、6、7、9 章那几件
"约束类"机制（义务与证据依赖、组合检查、GAP 阶梯、Retro），加上 4.2 #23/#24/#25 三个
"声明了但没读者/没字段"的偏差。

**目标形态**：Task ∈ {LEAF, COMPOSITE}（用能否写出独立 Verifier 判定，而不是执行步骤数）；
主干由证据依赖 + 义务模板拉出，不由流程规定；每个 PASS 有独立 Evidence；每次执行回流成能力。

---

## 进度（2026-09-20 更新）

本表是同步锚点：**别的写者只改指南时，这一节负责把"计划里哪几步已作废"标出来**。
状态句一律带日期 + 证据锚（指南维护约定 ①）。

| 阶段 | 状态 | 证据锚 |
|---|---|---|
| 0 文档 | ✅ 完成 | W23（§4.2 #20–#31、§4.3 记录、§6/§5.2 事实修正） |
| 1.1 `assumptions` 接线 | ✅ 完成 | W27（`DecomposeChildSpec.assumptions` `task-runtime/src/index.ts:185`；合并点 `orchestrate.ts:659`）；M7 实证（C 的 handoff.assumptions 恰三条） |
| 1.2 证据依赖 `requiresArtifact` | ✅ 完成 | W27（`task/src/types.ts:25`；admission 形状校验 `admission.ts:73-76`；存在性判 spawn 前 `orchestrate.ts:194`）；M7 实证（探针 B 未 spawn 直接 blocked） |
| 1.3 预算外置 + 强制出口 | ✅ 完成（`wallTimeMs` 在飞强制；`maxToolCalls`/`tokens` post-hoc；`attempts`/`noProgressRounds` 只声明未强制） | W29（`Config.budget`/`noProgressRounds` `task-runtime/src/index.ts:238-246`、schema `:377-383`、默认值 `:270-277`；`budgetExhaustedReason` `orchestrate.ts:473-476`、`awaitWorker` `:526-551`、落点 `:853-862`/`:1147-1152`；post-hoc `budgetBreaches` `:486-507`）。ESCALATE 出口仍未建（阶段 3.1） |
| 1.4 `verifierRef` 向后兼容 | ✅ 完成 | W29（`AcceptanceCriterion.verifierRef?` `task/src/types.ts:34`；未知 id 创建/分解期整批拒绝并列已注册 id `task-runtime/src/index.ts:624-627,1022-1040`；注册表按 id 取 verifier `verifier/src/index.ts:150-156`；档案 `docs/persistence-changes/2026-09-20-verifier-ref-unknown-kind.md`） |
| 2.1 四值语义 / UNKNOWN 二分 | ✅ 完成（UNKNOWN 二分落地；`status` 仍三值、未升四值） | W29（`unknownKind?: 'task'/'verifier'` `task/src/types.ts:114,125,197`；command verifier 标 `task` `verifier/src/command-verifier.ts:96,103,106`；注册表标 `verifier` `verifier/src/index.ts:157-177,185-191`；编排器分渲染 `orchestrate.ts:215-220`） |
| 2.2 Verifier owner/version/selftest | ✅ 完成（软：无 selftest 的注册记 warning 不拒绝） | W29（`Verifier` 元数据 `task/src/types.ts:629-642`、`VerifierSelftest` `:622-628`；`register()` warning `verifier/src/index.ts:93-97`；三个内置 verifier 已带 `command-verifier.ts:74-78`、`composite-verifier.ts:22-33`、`review-verifier.ts:7-19`） |
| 3.1 L4 ESCALATE 出口 | ⬜ 待做 | #22/#27 未动 |
| 3.2 L1/L2 组合与生成 | ⬜ 待做 | #27 未动 |
| 3.3 Obligation 最小版 | ✅ 完成（登记 + 覆盖检查） | W27（`ObligationRecorded` `task/src/types.ts:692`；`task-runtime/src/obligation.ts`；出口 `task-status.ts:31,44`）；M7 实证（`obligations: 1 recorded`、`0/7 covered`）。全局调度器按计划不做 |
| 4 Retro + 分层接受度量 | ⬜ 待做 | #28 未动 |
| 5 领域包 · 内容面 | ✅ 完成 | W26（`bb-obligations/SKILL.md` 先行样例）+ W27（`bb-pipeline` 骨架义务化，章节改为 阶段地图/义务提问/判据硬提醒/边界）；#30 已关闭 |
| 5 领域包 · 机制面（侧车 skill 注册表） | ⬜ 待做 | #29 未动；规范已冻结（§2.4.8，W26） |
| 6 质量与执行纪律 | ⬜ 待做 | — |
| 7 P3 激活前置 | ⬜ 待做 | — |

**落地时对计划的偏离（据实记录）**：
- 义务模板正本改成机器可读的 `.agents/skills/bb-obligations/obligations.yml`（JSON-as-YAML，
  零新依赖），而不是计划里说的"skeleton 散文改写成提问"——散文与机器可读两份并存，
  `obligation.ts` 扫 `*.yml`。比计划更强：覆盖检查可机械跑。
- `bb-obligations` 的尾部契约声明块暴露一个开口问题：**知识型 skill 的 `verifier_ref` 豁免**
  （它没有执行 verifier，校验形态是义务模板覆盖检查）。这一条需要规范细化后回填，
  否则 §2.4.8 "未验不入库" 会对知识型 skill 产生一条无法满足的硬约束。
- 缺产物 blocked 与 #22 同坑（无重试出边），W27 已互注，排期合并。

**复核基线（2026-09-20 11:50 实测，独立于 W27 自述）**：`pnpm build` 绿 / `verify-persistence`
OK（4 roots 指纹一致）/ 单测 **638（59 文件）** / 集成 **130（24 文件）**——与 W27 + M7 记录一致。

---

## 阶段 0 · 文档（已完成，本批）

- `docs/singularity-harness-guide.md`：§4.2 追加 #20–#31（12 条）；3 处过期事实修正（§6 工具数、
  §6 素材份数、§5.2 阈值）；§4.3 记 2026-09-20 对照审计；§2.2 / §2.4 / §2.5 / §2.7 / §2.8 对应条目
  加指回 §4.2 的交叉引用（§2.3 无对应条目，§2.4.5 记入 L0/L2 开启条件）。
- `harness/.agents/skills/bb-pipeline/SKILL.md`（非本仓，机器本地）：登记为 #30。
- 本文件：临时计划。
- 不改任何代码，不跑 `pnpm build`，不改持久化（无 session 事件变更，故
  `docs/persistence-changes/` 无需新档案，`scripts/verify-persistence.mjs --check` 应保持指纹不变）。

---

## 阶段 1 · Task 契约与结构（KISS §12 第 1 步：能拒绝一个不合格定义）

### 1.1 `assumptions` 接线（#20，最小可落地切片）

- 位置：`task-runtime/src/orchestrate.ts:596-605` 的 `buildHandoff({...})` 调用点，与
  `task-runtime/src/handoff.ts:50` 的 `assumptions` 字段。
- 做法：编排器在 spawn 前，把"该子任务依赖的兄弟任务的产物/证据引用"与任务自带的假设
  （`DecomposeChildSpec` 增可选 `assumptions?: string[]`）合起来传给 `buildHandoff`；
  `renderWorkerPrompt` / `renderWorkerContract` 已渲染该字段，无需改渲染层。
- 判据：单测断言 handoff.assumptions 非空且包含依赖证据 id；现有
  `task-runtime/tests/unit/handoff.spec.ts` 扩展。
- 不做：假设未满足时的自动阻塞（留给 1.2）。

### 1.2 证据依赖字段（#20 主体）

- 位置：`task/src/types.ts:9-16` `AcceptanceCriterion`。
- 做法：增可选 `requiresArtifact?: string[]`（产物/证据 kind 或 id），admission 只做
  结构校验（字段类型、非空串）；**不**在准入期判"产物是否存在"——存在性判定需要 store
  上下文，放在 spawn 前（编排器可读 snapshot）。
- 行为：缺产物 → 该子任务不 spawn，落 `TaskBlocked`（或 KISS 说的 `BLOCKED`）并把缺失项
  写成义务（与阶段 3 的 obligation 记录对接）。
- 判据：单测（缺产物 → blocked，且 record 的 `blockedBy`/anomalies 点名缺失产物）；
  集成断言沿用 `tests/integration/` 既有 task 链 harness。
- 风险：`AcceptanceCriterion` 进 `TaskCreated` 事件载荷，新增**可选**字段为增量扩展，
  需在 `docs/persistence-schema.json` 复核指纹是否变化；若变化，按 §4.3 第 ② 条纪律
  加 `docs/persistence-changes/` 档案。

### 1.3 预算外置 + 强制出口（#23）

- 位置：`task-runtime/src/index.ts:198-217`（`Config`）与 `:359-366`（构造期解析默认）。
- 做法：`Config` 增 `budget: { maxToolCalls?, tokens?, wallTimeMs?, attempts? }` 与
  `noProgressRounds?`；默认值取保守常数（KISS 建议 max_tool_calls 15、max_depth 8–12，
  现有 `config.yml` 的 4/8 更保守，**先不动**，只在文档写明是本部署的保守取值）。
- 强制出口：任一耗尽 → 不做静默降级，缺省走"ESCALATE"（阶段 4 的 L4 出口建好前，
  记为 `TaskFailed` + `localizedCause: budget exhausted: <which>`，并在工具输出里写明
  "这是预算耗尽，不是判据失败"）。
- 判据：单测（预算耗尽走该分支且 reason 文案固定）。
- 依赖：与 4.2 #23 同一条，`attempts` 与 retry 分支（§3.1 Non-Goals 现列为不建）一起排期。

### 1.4 `assumptions` 与 `verifierRef` 的向后兼容

- `AcceptanceCriterion.verifierRef?`（#24 的一部分）：缺省时按 `verificationMode` 分发到内置
  verifier（现行行为），显式给出时要求该 id 已在注册表内，否则**创建/分解期**拒绝（不是 spawn 期）。
- 判据：单测（未知 verifierRef → 整批拒绝，报错列出已注册 id）。

---

## 阶段 2 · Verifier 四值与元数据（KISS §12 第 2 步：刹车）

### 2.1 四值语义（#24）

- 位置：`task/src/types.ts:79-96`（`VerificationResult` / `EvidenceClaim` 的 `status`）
  与 `task-runtime/src/orchestrate.ts:731-743`（unmet 收敛点）。
- 做法：`status` 扩为 `pass | fail | partial | unknown`，或保持现值并加
  `unknownKind?: 'task' | 'verifier'`（**改动更小**：不动状态机与全部既有 reducer 分支，
  只加一个可选判别字段 + 判定规则）。
- 判定规则：`inconclusive` 且 details 表明超时/命令没跑起来 → `unknown`（task 没测到）；
  verifier 自身抛错 / 无 verifier 支持该 mode → `unknown`（verifier 坏了）。两者都要在
  编排器反馈文本里区分（KISS §4.3：混淆这两个会让系统永远在测同一件事）。
- 后续动作：UNKNOWN → 生成取证任务或修 verifier 任务（阶段 3 的义务登记，或先只
  写进 review 的 anomalies 与 escalation 判据 E3 的文本）。
- 判据：单测覆盖两条路径；`review-escalation.ts:99` 的 E3 判据同步更新。
- 风险：`status` 进事件载荷与持久化；选"加可选字段"路线可避免指纹变更。

### 2.2 注册表元数据 + selftest（#25）

- 位置：`verifier/src/index.ts:87-93` 的 `register()`；`task/src/types.ts:576-580` 的 `Verifier`。
- 做法：`Verifier` 增可选 `version` / `owner` / `selftest { positiveCases, negativeCases }`；
  `register()` 在**未提供 selftest 的注册**上记 warning（不拒绝，先软后硬：等三个内置
  verifier 都补了 selftest 再翻成硬拒绝，避免一次性打断既有测试替身）。
- 三层校验不要混：注册自检（selftest）；task 级判据自检；criterion 级指标（`mandatory` 与
  四值裁决）。KISS §12 第 2 步只要求前两者。
- 判据：`verifier/tests/unit/verifier-registry.spec.ts` 增例；`ReviewRecord` 侧不改。

---

## 阶段 3 · GAP 阶梯与义务（KISS §12 第 3 步：先只做 L1/L2/L4）

### 3.1 L4 ESCALATE 出口（先做这个）

- 位置：新工具 + reducer 事件，参考现有 `HitlService` / `EvolutionService` 的平面内服务范式
  （`agent-singularity/src/index.ts` 的服务注册纪律，见 §4.2 #15 的教训：**子 fiber 提供的服务
  不要写进父 fiber 的 inject**）。
- 做法：`escalate` 的载荷按 KISS §7 的"缺什么、试过什么、建议什么"+ 验收标准
  "人类能在 10 分钟内据此做决策"；落一条 append-only 记录（与 `evolution` 台账同纪律），
  人审通道复用 `ctx.approval` / 画布 answerer（§5.5）。
- 触发点三个：能力缺口（#27）、预算耗尽（1.3）、UNKNOWN 收敛（2.1）。
- 判据：集成测试驱动一个缺口 → 台账出现一条 escalation，工具输出含三项要素。

### 3.2 L1/L2（KISS §7）

- L1 组合：现有 skill 组合出新 skill → 落沙箱 + 走既有 evolution 轨道（不要把组合写进
  能力表；能力表是部署配置）。
- L2 生成：用已有 tool 生成新 skill → **必须自带 `verifier_ref`**，在
  `agent-singularity/src/evolution.ts` 的 skill 类 apply 前强制（即 #29 的"未验不入库"）。
- 顺序：先 L4 出口（3.1）→ 再 L1（复用 evolution_replay 的 overlay 机制，`ReplayOverlay.extraSkillRoots`）
  → 最后 L2。
- 判据：人为制造一个缺口（沿用 §4.1 M4 的探针手法：config.yml 加一条指向不存在 preset 的能力行），
  系统能自动组合或生成出路径，或给出 L4 卡片。

### 3.3 Obligation 最小版（#21）

- 先只做两件事，且都是静态可判：
  1. **登记**：失败/阻塞/缺口时，把"还缺什么"写成一条结构化义务记录（目标 + 判据 + 来源任务），
     带进 review 的 anomalies / 一个新的 `ObligationRecorded` 事件。Obligation 是问题不是动作。
  2. **覆盖检查**：领域包的义务模板（见阶段 5）与当前任务图的义务集合做覆盖比对，
     未覆盖的问"是被满足了还是被漏了"，漏了才提示补。
- 不做：全局调度器（`pick_unmet_obligation` 那种"拓扑就绪 × 性价比"的调度）——KISS 自己也把
  它放在循环里，但当前编排器是"一次分解 + 依赖级联"，先不引入第二套调度。
- 判据：单测（义务登记 + 覆盖检查命中/未命中两例）。

---

## 阶段 4 · Retro 与分层接受度量（KISS §12 第 4 步）

### 4.1 最简 Retro

- 位置：`agent-singularity/src/`（与 `evolution.ts` 同层的平面内服务）。
- 做法：**不改**现行的 caller-triggered 诊断（§2.7.3 是已冻结的人审口径），只加一条
  "轨迹汇总"出口：读一个 root store 的全部终态 record + diagnosis，产出**结构化提案**
  （失败模式三元组 / 成功模式签名 / 对四库的增改废），被拒提案也落账。
- 触发：人/root 显式调用（例如 `retro_run`），或人审同意后接一个定时器；**不做自动生效**。
- 判据：单测（给定一段合成轨迹，产出提案结构合法且被拒提案有日志）。

### 4.2 分层接受度量（§8.1）

- 与 4.1 同批：提案按 targetType 分类审判，Verifier 类提案**禁用通过率**，改为逃逸率 /
  变异检出率（依赖阶段 2.2 的 version/owner 与 §8.4 的变异测试）；Task 模板用难度归一化
  通过率；Skill / Capability 用通过率 + 成本。
- held-in / held-out 接受规则：`agent-singularity/src/replay.ts:119-124` 的
  `overallReplayVerdict` 需要**分组**调用（observed 与 holdout 各自出判词，再由接受规则合并），
  以及"至少一侧改善"的要求；同时把 verdict 接进 gate 的判定（现在
  `evolution.ts:896-904` 只查报告存在性）——`worse` 不应能继续走到 decide。
- 判据：单测（observed 不退化 ∧ holdout 不退化 ∧ 至少一侧改善 → 接受；其余 → 拒绝并记原因）。

---

## 阶段 5 · 领域包内容（与阶段 3.3 同批）

- `harness/.agents/skills/bb-pipeline/SKILL.md`（#30）：
  - 保留：阶段→能力名映射表、判据写法硬提醒（`cd <owner>/<repo> &&`、长任务走 submit/poll、
    `task_cancel` 不可用、`verifyTimeoutMs` 口径）——这些是**环境事实**，不是流程。
  - 改写："典型分解骨架"三条带 `dependsOn` 的步骤序列 → **义务提问式**：
    "差分参考在哪（BEMU trace / golden model）""高层到硬件的映射正确性怎么判"
    "硬件实现与参考的等价性怎么判""PPA 可达性怎么判"，每条附"通常由哪个能力回答"。
  - 自检：**模板删除测试**——删掉全部骨架示例，新任务还能合理分解吗？能，才算合规。
- 侧车 skill 注册表（#29）：`capability_provided` / `precondition` / `inputs` / `outputs` /
  `required_tools` / `verifier_ref` / `reliability {status, success_rate}`；
  落点建议放 `$DSH_HOME` 下的注册表文件（与 `evolution` 台账同纪律：append-only、版本化、
  可回滚），**不改 DSH skill loader**（上游 frontmatter 只支持 name/description/whenToUse/metadata）。
- 成熟度 EXPERIMENTAL→VALIDATED→HARDENED→STABLE→DEPRECATED（§2.4.2 自标未建）：
  与 `reliability` 一起进侧车注册表。

---

## 阶段 6 · 质量与执行纪律（对齐 KISS §10）

- 判据（criterion）本身先有质量：查"每个 leaf task 是否至少一条 deterministic/simulation/
  measurement 判据、命令是否自带 cwd、产物是否可被另一个 worker 独立复验"——做成 admission
  的**可选**检查（默认 warning，不拒绝），因为 KISS §10 第 4 项"证据完整率 100%"是硬指标，
  §2.5 的"每条判据只验一件事"是软规范。
- 证据可比性：`verificationMode` 明确口径 + 产物/环境快照引用（KISS §8.3 的"E3 环境快照"是
  后续验证债的锚点）。
- 验收器分离：criterion 级已做（verifier 在编排器侧）；**不**引入"第二个 agent 裁判"，
  除非同时按 §8.5 记独立性预算（#31）。

---

## 阶段 7 · P3 激活前置（原 §3.2 的 P3 行）

以下条件满足前，**不扩自主执行权限，也不扩并发**（KISS §12：不做完第 1–3 步不做大 Task 库、
不追求全自动）：

- 阶段 1–3 完成；
- 至少 1 个**非手工**的新 Task 由能力/ Skill 组合长出来（KISS 的"人为制造缺口系统能自动补"验收）；
- 存在一个**可复用的自产物验收工具**（能力生成时由模型自己产出 verifier 或验收脚本，
  即阶段 3.2 的 L2）；
- 编排动作（EXECUTE / DECOMPOSE / ASK_PARENT / REQUEST_CAPABILITY / RETRY / BLOCK / ESCALATE_HUMAN，
  KISS §2.8.1 七动作）至少能跑通 EXECUTE / DECOMPOSE / ESCALATE_HUMAN 三条。

> 这一节是**机制激活条件**，与人类 2026-09-17 的 B1 裁决（"全线未明确打通前保持
> danger-full-access"）不冲突：那一条讲的是权限姿态，这里讲的是机制完成度。

---

## 排期与互斥

1. **阶段 0（已完成）**：纯文档。
2. **阶段 1 + 2 可并行**（不同文件面：task / task-runtime vs verifier），但都动
   `task/src/types.ts` 时按文件边界串行。
3. **阶段 2.2 的 version 字段必须先于阶段 4.2**（判决召回与逃逸率都按版本索引）。
4. **阶段 3.3 与阶段 5 同批**（义务模板与义务登记是一件事的两头）。
5. **阶段 4 必须晚于阶段 1–3**（KISS §12 第 4 步在第 3 步之后）。
6. 每次改动：`pnpm build` → 单测 / 集成 → `pnpm run verify-persistence`；改了 `task/event`
   成员或 payload 形状时补 `docs/persistence-changes/` 档案；改了 §2 / §4 状态词描述的现实时
   同批更新 `singularity-harness-guide.md` 并在 §4.3 记一条实施记录（维护约定 ③）。

## 明确不做

- 不建第二套调度器（义务调度推迟到出现真实消费者）。
- 不把领域流程写成 SEQUENCE 或步骤（KISS 军规 2）。
- 不自动生效任何 evolution（§2.9.2 红线不变）。
- 不引入形式化验证、不把 LLM 当唯一裁判（KISS §12"第一阶段不做的事"）。
- 不为了"拆得更细"优化，只为了"验得更可靠"（KISS §12 同段）。
