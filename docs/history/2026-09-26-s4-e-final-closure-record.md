# 第 12 项 S4-E 收尾返工记录（2026-09-26）

被审基线 `6657e5e`（对 `7c8af54` 仅文档差异）。合同：[收尾派发](../execution-prompts/12-s4-e-final-closure.md)（其文本与计划 F.2 新裁决覆盖历史 prompt 的旧 replay/兼容/实验时限要求）、[返工复审](2026-09-26-s4-e-rework-review.md)（四处问题）、[持久化说明](../persistence-changes/2026-09-26-s4-e-experiment-ledger.md)。历史交付/审核/返工记录原样保留，本记录不改写它们。

交付方式：主代理先派 explore 核实复审反例真实性与删除范围的消费者盘点（四个反例全部属实，其中三处的旧合同要求已被本轮裁决撤回、一处仍为必修），按五问审查确认原计划本身即 KISS 化删除方案、不简化，随后串行派四个窄目标子代理，最后主代理独立组合验收。

## 复审四处的关闭方式

| 复审发现 | 关闭方式 | 实现 |
|---|---|---|
| EVAL-4：旧格式实验记录使全账 fold 抛错，"旧账可读"不成立 | 按新裁决放弃兼容：ledger 新写统一 `formatVersion: 2`，加载遇 v1/无版本/混合行在首个新写前具名抛错，旧账归档切换 | `evolution/src/evolution.ts` `load()` 版本闸（行号 + 所见版本） |
| Q1：实验截止在复制快照后按新 Run 起点重锚 | 按新裁决整条删除实验级 `wallTimeMs` 与实验 `durationMs`；Run 时限只剩既有 `rootBudget.wallTimeMs`/`Config.budget.wallTimeMs` | evolution/task-runtime/工具三层同批删除 |
| Q1：gate 不校验成本 | 按新裁决固定语义：`gate` 只记录六项回答与证据引用（超额实验可留 gated 审计事实），`decide(PROMOTE)`/`apply` 写前经同一个 `checkPromotion` 复检 | 现状保留，文档口径对齐；未在 gate 塞第二套检查 |
| Q3：无 ref 裁判只冻结 mode，冻结后换 @2 仍可晋升 | 必修项落地：实验冻结时任一 AC 缺 `verifierRef`/ref 未注册/注册表无版本即具名抛错，零落账零 Run；不加 mode→verifier helper | `experiment.ts` `frozenCriterionOf` 三分支拒绝；`promotion.ts` null-ref 分支删除 |

## 提交与删除范围（四个串行子任务）

1. **`4ce9362` 删 v1 replay、生命周期收窄到 Skill**：删 `replay-experiment.ts`、`config-edit.ts`、`prepare-champion.ts` 整文件与 `EvolutionService.replay`、`runReplayExperiment`、v1 报告/断言符号、非 Skill 的 prepare/apply/rollback 执行器（各自最后消费者逐一核对无残留）；`candidate()` 对非 Skill targetType 在首个持久写前具名拒绝（27 文件，+1327/−5072）。`compareReplaySides` 及其词表因 `@2` 比较器复用保留。
2. **`a83fd2d` 删实验级时限全链**：`ExperimentBudget.wallTimeMs`、`ReplayTaskOptions.wallTimeMs`、`runDeadlineAt`/`runDeadlineInstantOf`、`runDeadlineMs` 第 5 参、实验 `durationMs`（含报告↔store 时长漂移核对；反伪造仍由 runId/reviewRef/evidenceRefs/摘要核对覆盖）；`maxTokens` 总额与逐侧累计耗尽不启动保留；`agentOptions` 会话传播保留（23 文件，+376/−977）。
3. **`0c2179d` 裁判显式锚定**：冻结三分支拒绝 + 晋升核对收窄；九个测试文件的实验夹具改显式 pin；`ReplaySideSummary.durationMs` 死字段清理。红证据：integration 复现审核反例（无 ref 实验曾整跑成功 `verdict: fixed`）→ 改后工具入口具名拒绝、零 spawn 零落账。
4. **`eb2035b` 账本 v2**：全部写入点 `formatVersion: 2`；`load()` 版本闸；删除为兼容保留的 `replayed` 只读路径（状态值/记录变体/fold/`ReplayedView`/状态弧/`LEDGER_APPLIED_TARGET_TYPES`）与 `ChampionSource`（capability-only，v2 无准入路径）；`MECHANICAL_TARGET_TYPES` 收窄 `['skill']`（13 文件，+483/−858）。

## 验收证据（主代理在最终 HEAD `eb2035b` 独立重跑）

- build（packages/singularity）通过；`verify-persistence` OK（4 根不变，本账本非 SessionEventMap 根）；`git diff --check` 干净；`evolution`/`agent-singularity` `tsc --noEmit` 0 错（task-runtime 6 条基线既有错误，无新增）。
- unit **57 文件 / 1706 全绿**；integration **54 文件 / 404 通过 + 1 基线既有抖动**（`a4-question-cold-recovery.spec.ts`，单跑 15/15 绿，与本票代码无关，往轮已记录）。
- 抽查：root prompt 的 Evolution 协议段只描述 Skill 双侧路径；`evolution_replay` schema 的 budget 仅 `maxTokens`/`note`；生产代码 grep 无 `runReplayExperiment`/`replayed`（账本语义）/`runDeadlineAt`/`formatVersion: 1` 写入。
- EVAL 现行部分：EVAL-1 双侧真实 Run/隔离（`experiment-runner`/`evolution-replay-experiment` 集成绿）；EVAL-2 冒充/漂移/伪证/同败/退化在 PROMOTE/apply 拒绝、无锚裁判写前拒绝（`skill-promotion-gate`、`s4e-q3-freeze-binding` 绿）；EVAL-3 幂等/取消/重启不重计、带 `wallTimeMs` 直调立即拒绝、根时限仍在（`experiment-orchestrator`、`root-budget` 绿）；EVAL-4 v2 重开/回滚通过、v1 及混合账写前具名拒绝零副作用（新 `ledger-version.spec.ts`、翻转的 `ledger-roots.spec.ts`）；EVAL-5 唯一行为所有者与模型可见入口收窄（装配测试 + 上述 grep）。

## 旧账盘点与切换前置

现场 `/home/ROXY/code/bb_work/harness/.dsh/evolution/proposals.jsonl` 本轮再核对：21 行全 `formatVersion: 1`，2 条 `replayed`，两条曾 `applied` 的提案（`m3-prop-cap`、`m3-prop-skill`）最终均 `rolledback`，**无未回滚 applied**（不触发派发文停止条件）；md5 与库内归档夹具 `evolution/tests/unit/fixtures/evolution-ledger-2026-09-26.jsonl` 一致，文件未动。**附带事实**：`m2-prop-diag` 处于 decided(PROMOTE) 未 applied 未 rolledback 的悬挂态——切换后它随旧账整体归档，新版本不处置它，特此记录。部署切换步骤（操作方执行，非本票代码）：复核现场 → 原字节归档 → 从空的新账启动。未写迁移程序。

## 未覆盖与边界（沿既有记录，非新增豁免）

确定性 fixture 证明协议，不声称统计效果；未调用付费模型。`agentOptions`/工作区绑定是进程内传播，崩溃续跑不持有（A6/S2-R 范围，晋升闸的每侧实际请求核对是兜底）。`escalations.jsonl`/`agents.jsonl` 是独立账本，各自 formatVersion 不随本账切换。覆盖率注：随 v1 只读路径删除，三个只在 v1 账本下可达的拒绝分支（champion-missing 回滚删除、非 skill applied 回滚拒绝、pre-binding 记录缺 skillContent 拒绝）在 v2 不可达，其测试改写为 v2 状态机/格式拒绝测试。

最高填**待验收**，停止等待独立进度审核；未启动 A5/A6。
