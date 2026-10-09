# Singularity 重构蓝图

> 单一入口。审查从这里开始。
> 第一轮审核、补充遗漏与后续构建检查点：[review.md](review.md)。
> 证据基础：旧仓 `packages/singularity` @ `6a0edde` 的只读审计、DSH 源码与已装 `0.2.0-rc.2` 的实测、新骨架 `singularity-core` 的 S1/S2。
> 历史工作件（按需查证）：`~/Documents/singularity-refactor-plan.md`（冗余总账）、`singularity-rrsi-diagnosis.md`（RSI 断点）、`singularity-s0-spine.md`（核心脉络）、`singularity-s0-correction.md`（对 DSH 的更正）、`singularity-probe-results.md`（实测）、`singularity-f1-design.md`。

---

# 1. Singularity 想实现什么

## 1.1 目标（用户口述 + 仓库文档一致的部分）

构建一个**面向领域任务的 RSI 系统**：可进化对象是 **Task 模板 / Skill / Tool**；搜索能力来自 **RRSI**；Singularity 负责**内部调度**，为 agent 提供基建，让它在探索中**沿 task 树往下走、或自己构造 task 并发布分解**；得到的**轨迹与 skill 交给 RRSI 赋能的结构去进化**；**bubble 是控制变量的沙箱**，提供环境管理；**graph 在 bubble 里**。

用一句话概括这个目标：

> 让一个 agent 团队在**可复现的隔离环境**里做领域工作，把工作中长出的方法（模板/Skill/能力）经**受控实验**验证后发布，使**下一次任务的起点比上一次高**——而且这个提升是可审计、可回滚、可复现的。

"面向领域"的含义不是让内核懂芯片，而是：**领域提供目标、验收与测量手段；内核只负责让'什么叫更好'这件事可判定、可复现、不可自证。**

## 1.2 六个实体与五条关系（内核的不可约部分）

| 实体 | 是什么 | 不可变量 |
|---|---|---|
| **E1 Task** | 一份契约：目标、输入、验收判据、所需能力 | 接受后不改题；每条判据可裁定且绑定一个已注册验证器 |
| **E2 Run** | 对 E1 的一次尝试 | 准入时钉住一个环境版本；终态封存执行凭证；多次 Run 互不覆盖 |
| **E3 Agent node** | 一个可继续的会话 + 一个角色 | 可见节点必有活会话；一 group 恰好一 router，router 是唯一对外端点 |
| **E4 Method** | 可复用资产：Skill / TaskTemplate / capability 行 / MCP 定义 | 不可变版本；变更只有 draft → 双侧冻结评估 → 指针切换一条路径 |
| **E5 Evidence** | 独立验证器对"产物是否满足判据"的裁决 | **绝不能由执行者自述**；缺失事实标 incomplete，不填默认 |
| **E6 Human decision** | 对发布/越界的批准 | 针对一个具体差异；批准后必须重检；不是模型的参数 |

| 关系 | 方向 |
|---|---|
| R1 | Task → Run（一次尝试） |
| R2 | Run → Environment revision（钉住） |
| R3 | Agent → Task（负责；委派改变责任） |
| R4 | Agent ↔ Agent（spawn / handoff 是**持久边**；临时消息不是） |
| R5 | Draft → Evaluation → Revision → Pointer（方法变更的单一路径） |

**一句话脉络**：一个 Agent node 在隔离工作区里、对**钉住某个不可变 Method 版本**的契约 Task 做尝试；任何对可复用方法的变更都必须先过**冻结的双侧评估**与**一次人工批准**，才允许切换**一个指针**。

## 1.3 与 RRSI 的分工（上游 README 的 "Method to code" 表）

RRSI 是 *Regularized Recursive Self-Improvement of Agent Harnesses*（[google-research/rrsi](https://github.com/google-research/rrsi)）。它提供的是**搜索与正则化**，不是任务运行时：

| RRSI 提供 | Singularity 提供 |
|---|---|
| 提案侧正则化：退火编辑预算、完整编辑历史条件化、停滞时转向未试组件 | Task 契约、分解、准入、依赖、预算 |
| 选择侧正则化：critic 预筛、噪声底线、成本规则、剪枝集、argmax | 隔离工作区、独立验收、执行凭证、人审发布 |
| 候选 = git worktree 里的一棵 harness 分支 | **bubble** = 每轮每个环境组件的独立克隆 |

所以**"引进 RRSI"= 引进它的搜索形状，而不是重写它**。这条在 §3 的根因五会被证明只做了一半。

---

# 2. 已经实现了什么

分三层判断，**不能混用**：源码有路径 ≠ 受控测试通过 ≠ 真实任务获益。

## 2.1 实测的构建健康度（2026-10-09，旧仓 @ `6a0edde`）

| 套件 | 结果 |
|---|---|
| `pnpm test:unit` | **2378 passed / 1 failed / 1 skipped**（175 文件） |
| `pnpm test:integration` | **557 passed / 5 skipped**（91 文件，全绿） |

唯一失败 `task-runtime/tests/unit/normalized-contract.spec.ts` **单独跑 6/6 通过** → 是共享 `$DSH_HOME` 的测试隔离缺陷，不是产品缺陷。

> 我最初引用的"247 个失败"来自 `docs/2026-10-07-goal-only-rsi-smoke.md`，那是最终 fixture 调整**之前**的旧结果，不代表 HEAD。**旧仓不是坏的。**

## 2.2 真正可用的能力（每条有源码位置）

| 能力 | 位置 | 状态 |
|---|---|---|
| Task 契约 / 递归分解 / 依赖 DAG / 提案 / 澄清问答 | `task`（29 种事件） | 集成测试绿 |
| 准入、批次推进、父执行权交还、按需下钻 | `task-runtime/orchestration` | `k1-exploration` / `a3-*` 绿 |
| 独立验收（command / composite / review 验证器 + 自测闸） | `verifier` | 绿 |
| 非根会话冷恢复、问答补投、崩溃后续跑 | `tests/integration/{a3,a4,a6,g-graph}-*` | 绿（含真实 SIGKILL） |
| 能力解析、provider 预检、run 级内容绑定 | `task-runtime/{capability,provider-precheck,run-binding}` | 绿 |
| **bubble**：一轮一个环境组件的独立克隆 | `task-runtime/src/service/bubble.ts` | 绿 |
| 环境版本不可变 + 指针 CAS + 持久 intent + 人审 | `task-runtime/src/environment/*` | 绿 |
| 双侧冻结评估 + 单份报告 + 发布前同验证器重检 | `evolution/src/pipeline/*` | 绿 |
| 执行凭证从真实记录封存 | `task/src/receipt.ts` | 绿 |
| **RRSI 纯函数端口**（8 模块全部有消费者） | `evolution/src/strategy/*` | 绿 |
| 上下文读取 / 引用 / 装配（唯一读投影） | `context` | 绿 |
| 图拓扑 / 画布 / 多图注册表 / HTTP+SSE / SPA | `graph` `graphs` `graph-web` `map` | 绿 |
| 真实模型正例：xv6 supervisor repair（69/70 → 发布 v2 → 新检出消费 v2 → 70/70） | `docs/2026-10-04-live-xv6-supervisor-repair-run2.json` | 有记录 |

## 2.3 RRSI 对照表（**按上游源码行号重写**）

> 本节此前是**读 README 推的**；现已逐行读过上游算法面（≈2500 行，覆盖范围见 [`docs/rrsi-upstream-reference.md`](rrsi-upstream-reference.md) §0）。
> 符号（`config.py:31-42`）：`T` 轮数 / **`k` 每任务 trial 数** / **`m` 每轮候选数** / `b_t` 编辑预算 / `w` 停滞窗 / `m_draft` 保留槽 / `δ` 噪声带。默认 `T=20, k=2, m=2`——`k` 与 `m` 都是 2，所以两者极易写混。
> **我此前写的"每轮 k 个候选"是错的**：那是 `m`。

| # | RRSI 上游（行号） | 端口位置 | 接线状态 |
|---|---|---|---|
| 1 | `evaluate.py:104-119` `aggregate`：`S_hat = Σr·w / Σw`，`C_hat = mean(tokens>0)` | `strategy/measure.ts` | ✅ 已接 |
| 2 | `schedule.py:43-50` 退火编辑预算 `b_t`（除以 `T`） | `strategy/schedule.ts` | ✅ 已接（`rounds−1` 是有意改动） |
| 3 | `critic.py:105-110` 确定性预检 + `:113-147` LLM 意图审查（**六条具名理由**） | `strategy/screen.ts` | ⚠️ **只接了结构检查**：没有"泄漏/记忆化/无界工作"这六条语义审查 |
| 4 | `selection.py:107-118` 准入顺序：噪声底线 → 成本规则 → guards | `strategy/selection.ts:admit` | ✅ 已接（门禁 `method_publish`） |
| 5 | `selection.py:84-86` 增益分支 `ΔC <= β0 + β1·ΔS`（无上界） | 同上 | ⚠️ 端口加了 25% 上界（有意收紧） |
| 6 | `selection.py:90` 带内分支 `w_s·ΔS − w_c·ΔC + **w_n·ν** > 0` | `strategy/selection.ts:costRule` | ⚠️ 端口**删除了 novelty 项**（有意），但 `w_n` 的替代（确定性 tie-break）需显式测试 |
| 7 | `selection.py:133-136` `argmax_{admissible} S'`，无则保留 incumbent | `strategy/selection.ts:selectRound` | ❌ **`selectRound` 零调用**——每轮只记一次准入 |
| 8 | `loop.py:292,301-302` **每轮 `m` 个候选，同一 incumbent，并行评估** | — | ❌ **缺失** |
| 9 | `components.py:44-46` `K`(9) / `K_STR`(4) | `strategy/policy.ts` 的 5 个资产类别 | ⚠️ **轴不同**：上游按 harness 组件 + diff 回退分类；端口按资产类别 |
| 10 | `components.py:103-108` `novelty`（`set()` 去重，只数 `K_STR`，且 `incumbent_counts==0`） | `strategy/selection.ts:noveltyOf` | ❌ **恒为常数 1**（合成机制 × 空 incumbent 计数） |
| 11 | `components.py:82-100` 声明标签需 **diff 证据**，否则回退按 diff 分类 | `draft/adapters.ts`（按适配器核验） | ⚠️ 端口改为适配器核验（有意），但**没有回退分类** |
| 12 | `history.py:36-38,83` **一条记录 = 一条 edit**，带 `t`（轮）与 `variant` | `strategy/history.ts` | ⚠️ 半接：函数在，**输入是空的**；且端口用候选序号/history 长度充当 round |
| 13 | `history.py:91-92` `ΔS`/`ΔC` **按测量时刻冻结**，`:143-150` 读回 | `strategy/history.ts:107` | ❌ 端口**按最新 head 重算所有旧候选**（E09 实测：发布 B 后 A 的 Δ 从 0 变 −0.2） |
| 14 | `history.py:129-141` `incumbent_component_counts`（读 `accepted` 标记） | `strategy/selection.ts:admit` 的 `incumbentMechanismCounts` | ❌ **从未传入**（生产调用恒为 `{}`） |
| 15 | `history.py:143-163` `g_t` / `prune_set`（**带要移除的具体已接受编辑**） | `strategy/history.ts` 的 `simplificationCandidates` | ⚠️ 只有组件级建议，无"要删哪条" |
| 16 | `history.py:189-211` `σ_t` / `U_t` / 保留槽文案 | 同上 + `coordination/prompts.ts:82` | ⚠️ 半接（派生自空输入） |
| 17 | `loop.py:294` + `propose.py:349-354` + `loop.py:523-530` **保留槽的机械约束**（`done()` 回弹 **且** critic 后按 **diff** 再验） | — | ❌ **缺失**（只在提示词里说） |
| 18 | `history.py:152-157` + `loop.py:159-178` **归因 scoreboard**（`predicted_affected` 命中率 + `unpredicted_regressions`，最近 20 行回喂） | — | ❌ **缺失**（我此前整条漏掉） |
| 19 | `loop.py:134-150` 选轨迹规则（**最差任务的 worst trial + 最好任务的 best trial**，`n_fail=22`/`n_success=6`） | — | ❌ 缺失 |
| 20 | `digester.py` **只读子代理**（工具 jail、三套 schema、6000 字符硬顶） | — | ❌ 缺失 |
| 21 | `analyst.py:121-198` 三镜报告（failure_modes / capability_gaps / success_habits），**跨轮累积模式名** | — | ❌ 缺失（由 supervisor LLM 替代，但**没有这三镜结构**） |
| 22 | `propose.py:91-104` 每条编辑的证据契约（`trigger_condition`/`predicted_affected`/`retroactive_check`/`regression_risk`） | `method-draft` 的 `edits[]{id,mechanism,hypothesis,targets}` | ⚠️ 只有 4 个字段，**无预测与反事实** |
| 23 | `propose.py:107-111` **"THERE IS NO ABORT ACTION"** | — | ⚠️ 端口允许模型不发布；上游要求必须提交候选 |
| 24 | `loop.py:495-496,550-552,566-568,599-602` 测量前**四道具名门**（`no_proposal`/`critic_reject`/`smoke_fail`/`eval_invalid`） | `pipeline/validate.ts` 的部分检查 | ⚠️ 只有部分；`smoke_fail` 与 `critic_reject` 无对应 |
| 25 | `loop.py:249-268` analyst 阶段的**跨轮 `global_analysis`** | — | ❌ 缺失 |
| 26 | `calibrate.py:89-103` `δ`：≥2 次基线评估直接观测，单次则 bootstrap | `strategy/measure.ts:calibrateNoise` | ⚠️ 半接（`repetition` 由调用方声明，重复调用短路到第一份报告） |
| 27 | `loop.py:335` `S* = max(S*, S_{t+1})` **在 `if winner is not None` 之内** | `strategy/history.ts:bestQuality` | ❌ 端口的 `bestQuality` **包含未采用的候选**（E10 实测：被成本拒绝的 B=.8 仍抬高底线） |
| 28 | `loop.py:403-406` winner 必须是 `H_t` 的**后代** | — | ❌ 缺失 |
| 29 | `domain.py:78` `guards(incumbent, candidate)`（**吃双侧**，非补偿） | `pipeline/guards.ts` + adapter `guard()` | ⚠️ adapter 那半真的吃双侧；`rules.guards[].bound` 恒被盖 `ok: true` |
| 30 | `domain.py:109` `constitution()` → SKILL.md + PATTERNS.md 交给 proposer | 部分（Skill 正文冻结进 contract context） | ⚠️ 有 Skill，**无 PATTERNS（模式库）** |
| 31 | `loop.py:348-420` 重新裁决：用**存储测量**重跑算法 2，不花新评估 | — | ❌ 缺失（端口无 readjudicate 入口） |
| 32 | `evaluate.py:131-135` `ΔC` 任一侧未知 → **0.0 放行** | `strategy/selection.ts` | ⚠️ 端口改为拒绝（**有意收紧**，应作显式策略保留） |

**结论（未变，但依据更强）**：**算法引进了，闭环没有。** 且缺的不是几个函数，而是**一条证据管线 + 一套机械约束**：选轨迹 → 只读 digester → 三镜报告（跨轮累积）→ 归因 scoreboard → 带预测/反事实的提案 → critic 语义审查 → 保留槽与预算的机械回弹 → 并行评估 → 具名门 → 冻结 Δ 与只算已接受 head 的 S*。

细节见 §3 根因五，上游逐行依据见 [`docs/rrsi-upstream-reference.md`](rrsi-upstream-reference.md)。

---

# 3. 没有实现什么，以及为什么实现得过于复杂

这一节给的是**根因**，不是现象清单。每条根因都附它造成的具体后果与证据。

## 根因一：形状繁殖没有门禁

**现象量级（数出来的）**：

| 指标 | 数量 |
|---|---|
| 持久形状的**独立所有者** | **12**（4 个 Session 事件根 + 8 个自有文件族） |
| 事实种类 | **≈53** |
| 信封形状 | **4** |
| fold / reducer | **7** |
| 版本闸 | **7** |
| 拒绝词表 | **4 套** |
| 零引用导出 | **197**（evolution 76 / agent-singularity 42 / task 34 / map 28 / graph-web 12） |
| 机械门禁 | **2**（`check-source-size`、`verify-persistence`） |

**根因**：两个门禁都**不约束形状繁殖**。新增一个持久化格式的成本是 0；删除一个的成本是手工审计全仓。

**因果链**：
1. 门禁不管形状 → 每个新需求都倾向"再开一个文件/事件根"，因为那是最短路径；
2. 形状一多 → 每个形状都要自己的 validator / fold / 版本闸 / 拒绝词表；
3. 于是出现 `graph`（465 行，拓扑+画布）与 `graphs`（1056 行，注册表）这类**看起来重复实则边界**的分包，以及 `task-runtime` 里 `admission.ts` 与 `service/admission.ts` 这类**同名两层**；
4. 人被名字误导 → 又加一层包装来"理清"，净增代码。

**证据**：`docs/persistence-schema.json` 只指纹化 4 个事件根，`methods.jsonl` / `pointer.json` / 3 个 `manifest.json` / `evaluation-report.json` / `strategy-decision.json` **都不在任何门禁内**。

## 根因二：自建上游已有的东西——而且这个错误犯了两次

**第一次（旧系统）**：库的路径本来就是 `$DSH_HOME/singularity/environments/<rootSessionId>/`——**它本来就是某个根会话的库**。但旧系统把它当成"库作用域"，另存 **8 个自有文件族**，于是每个形状都要自己写持久化 + 版本闸 + 崩溃对账。

而上游**两个面都已经有了**：

| 面 | 包 | 上游已有 |
|---|---|---|
| 会话作用域 | `dsh-session-persistence-jsonl` + `session-format*` | **`flock(2)` 跨进程租约**（进程死亡由内核释放）、不可变代际 + 独占发布、**格式迁移链 v0→v4**、fail-closed 词表 |
| 库/宿主作用域 | `dsh-storage-domain` | `defineDomain` + zod schema 闸（open 时 fail-closed）、写入先持久才 resolve、`domain/changed` |

**后果**：8 个自建形状**每一个都少了上游已有的保证**——没有 lease（所以每次写入都要自己解决并发）、没有代际（所以没有截断检测）、没有迁移链（所以只能"拒绝未知版本"，不能演进）。

**第二次（我自己，刚刚）**：我在 `singularity-core` 里写了 `ProtocolLog`——230 行，自己做 append + fsync + 读回 + size 单写者 + 摘要链。**这是把 `session-persistence-jsonl`（567 行）重造了一遍，而且更差。** 旧系统里甚至有一个已验证可抄的封装：`task/src/service/store.ts` 的 `EventStoreSet`（318 行，四个事件根都跑在它上面）。

**这条根因的特殊性**：它不是"代码写多了"，而是**架构判断错了**——把"作用域划分"当成了"需要自己实现持久化"的理由。

## 根因三：契约声明了，但没有消费者

**这不是冗余代码，是"契约说了一件没人执行的事"。** 清单：

| 声明 | 被谁校验/持久化 | 谁读它 |
|---|---|---|
| `EvaluationRules.quality.extractor` | 工具要求、账本冻结 | **无人**（真正取数在 `score.ts:numericOf`，完全不看它） |
| `EvaluationRules.guards[].bound` | 账本持久化 | **无人**——`validate.ts` 无条件记为 `ok: true` |
| `EvaluationObjective` 的 `'tool-call-reduction'` | 只出现在两处声明 | **无人**（`evaluate.ts` 与 `judge.ts` 只分支 `'llm-outcome'`） |
| `HistoryFacts.consumption` | 三处构造点 | **无人**——三处都硬编码 `[]`，`ConsumptionFact` 无生产者 |
| `OutcomeEvaluationPlan.measurements` 的命令 | 冻结进 plan | **从不执行**（只作为文本进 judge）；`OutcomeMeasurement` 是死代码 |

**后果分两档**：

- **轻**：读到字段的人**以为它被检查了**。`extractor` 是必填的、`guards.bound` 有值、`measurements` 有命令——它们长得像能力。
- **重**：`CandidateFact.edits` 硬编码 `[]`（`method-shared.ts:562`）→ **`novelty` 恒 1、`HistoryEntry.mechanism` 恒 `undefined`、`yieldByMechanism` 恒 0**。也就是说 **RRSI 的机制词汇表事实上失效**。

**根因**：契约形状先于消费者被写出来，且没有门禁检查"声明的字段是否可追溯到脉络中的实体/关系"。旧系统 §1.5 自己写过"新增概念要有当前用途"——**这条纪律没有机械执行，所以没有生效**。

## 根因四：该由数据结构保证的事，交给了提示词

这是**复杂度增长的真正引擎**。清单：

| 不变量 | 旧系统由谁保证 | 应该由谁保证 |
|---|---|---|
| 执行者不自判自己的 run | 角色 prompt + 三层 review + 独立 verifier 的"约定" | **reducer**（`evidence/produced` 的 actor 必须等于判据命名的 verifier 且不等于 run 的 actor） |
| 非法状态跃迁 | 文本 gate 答案（六个 gate answer）+ fenced JSON + 三次催问 | **reducer**（返回新状态或具名拒绝） |
| 发布只切一个指针 | 持久 intent + 人审 + 约定 | **lease（单写者）+ reducer（CAS 校验）+ 重放（崩溃对账）** |
| 未知形状即错误 | 部分（`verify-persistence` 只管 4 个事件根） | **装载即拒绝**（且上游默认就是拒绝） |

**为什么这解释了复杂度**：每当一个不变量在运行时被违反，**唯一的修法是"再加一条提示词规则"或"再加一次催问/再加一个 gate"**。补丁全落在提示词层，于是每多一种失败模式，系统就多一层文本协议；而文本协议不可机械判定，只能靠模型记得——**失败概率恒定，补丁线性增长**。

**证据**：`docs/2026-10-08-graph4-evolution-settlement.md` 记录了一次这样的失败——"the platform required gate for every decision"，一个多余的候选既不能发布也不能结案，于是加了一条"REJECT/KEEP 可以结案"的规则。**这是提示词层补丁的典型形态。**

## 根因五：RRSI 只引进了一半

上游的循环形状（README "Method to code" 表）：

```
每轮：propose k=2 候选（各自 git worktree）
    → critic 预筛（泄漏检查，在任何测量之前）
    → 双侧评估（加权 per-trial，missing 计 0 不缩分母）
    → argmax 选优（噪声底线 + 成本规则 + 带内规则）
    → fast-forward 分支；编辑历史记录每条 edit 的 (component, hypothesis, Δscore, Δcost, verdict)
```

落地情况：

| 环节 | 状态 |
|---|---|
| 退火编辑预算 | ✅ 在（`method-draft` 强制） |
| critic 预筛 | ✅ 在（`method-draft` 调用 `screenBeforeMeasurement`） |
| 双侧冻结评估 | ✅ 在，而且比上游严（原验收不可补偿、未知成本拒绝放行） |
| 准入规则（噪声/成本） | ✅ 在（`admit`，门禁 `method_publish`） |
| **每轮 k 个候选 + argmax** | ❌ **缺失**：`src` 每份报告只记一次准入（`observe.ts:199` `admissions: [admission]`），`selectRound` 零调用 |
| **编辑历史** | ❌ **三处断点**（见下） |

**编辑历史的三处断点**（`edits` 是 RRSI proposal-side 的全部输入）：

1. `method_draft` **要求模型声明** `{id, mechanism, hypothesis?, targets?}` 并逐项校验 → 只被 `screenBeforeMeasurement` 用一次 → **落盘前被丢弃**（v5 账本记录里 `grep mechanism|hypothesis|target` → **0 命中**；报告里 `edits` → **0 命中**）。
2. `candidateMeasurementOf` 用 `mechanismOf(report.kind)` **合成**一条假 edit（把"资产类别"当机制，hypothesis 是拼出来的字符串）。
3. `strategyDecisionOf` 调 `admit` 时**从不传 `incumbentMechanismCounts`**（全仓唯一提及它的 `selection.ts:166,173` 属于零调用的 `selectRound`）。

**联合后果**：`novelty ≡ noveltyOf(一条合成结构机制, {}) ≡ 1`——**一个看起来真实的常数**。而 `Admission.novelty` 会被持久化、会被 `method_publish` 读到。**这比恒 0 更危险**：恒 0 会被发现，恒 1 会被当成"每次都是新颖的"。

**根因**：引进了 RRSI 的**纯函数**，但没有引进它的**状态**。纯函数是便宜的（8 个模块 1183 行），状态是要改持久化的（`EvaluationPlan` + v5 记录）。于是挑便宜的那半做了。作者在 `method-shared.ts:560-561` 留下的注释甚至写着理由——"the ledger keeps no second copy of a hypothesis **the report already froze**"——**而这个前提是假的**（报告里没有 hypothesis）。**契约的意图是对的，实现漏了，注释把漏掉的地方说成了已满足。**

## 根因六：两次大重构都没有换掉根因

| 重构 | 规模 | 之后仍然是 |
|---|---|---|
| `fa7c599` Simplify DAG scheduling and supervisor reads | — | 12 形状 / 2 门禁 |
| `f39e2b5 → 6a0edde`（Batch 1–6 + Deletion pass） | **461 文件，+60,248 / −68,308；`ca0b71a` 一次删 45,160 行** | **12 形状 / 197 零引用导出 / 2 门禁** |

**原因**：重构以"**删除旧机制**"为单位（退役九步 `evolution_*`、退役 `RsiLoopDriver`、退役文本 gate），而不是以"**消除形状所有者 / 建立门禁**"为单位。

删掉的代码会以另一种形状回来，因为**没有任何东西阻止新增形状**。这就是为什么一次 68,000 行的删除之后，仍然有 8 个自有文件族。

**结论：往里打补丁不收敛。缺的不是清理，是约束。**

---

# 4. 重构的理由

从六条根因可以直接推出三条**可判定的失配**。它们不是审美问题，每一条都能用一个反例证伪：

| # | 失配 | 反例 | 修法 |
|---|---|---|---|
| 1 | **持久面与作用域失配**：根会话的库被当成库作用域另存文件 | 两个进程各自往 `methods.jsonl` 追加 → 需要自建锁；同一事实在会话日志与自有文件里两份 | 会话作用域走**会话事件**，库作用域走 **storageDomain**（实测见下） |
| 2 | **不变量与执行者失配**：独立性/跃迁/CAS 由提示词保证 | 执行者自判自己的 run，只需一次工具调用；旧系统为此写了三层 review + 三次催问 | 不变量进 **reducer**；单写者进 **lease**；崩溃对账进**重放** |
| 3 | **能力与消费者失配**：声明的字段/机制无人读 | `extractor` 必填无人读；`novelty ≡ 1` 被持久化并据以发布 | 每个声明必须有消费者；**门禁检查可追溯性** |

## 4.1 支撑第 1 条的实测证据（本次做的，不是推断）

| 判据 | 会话事件（`session-persistence-jsonl`） | `storageDomain`（json 后端） |
|---|---|---|
| 写入 resolve 即持久 | 是 | **实测是**（新进程读回一致） |
| schema 闸 | 上游有词表闸 | **实测是，fail-closed**（`invalid-record`，整次 open 拒绝） |
| 进程内 CAS | — | **实测是**（20 并发自增 = 20；抛错不写入） |
| **跨进程互斥** | **`flock(2)` 租约**，进程死亡由内核释放；**双进程 e2e 钉住** | **实测无互斥，且静默丢失更新**（另一进程写入的记录被整文档重写覆盖） |
| 每写成本 | 追加一行 + 不可变代际 | 整文档重写（`single` 布局） |
| 版本演进 | **迁移链 v0→v4** | 拒绝 / `compatibleVersions` / per-record 丢弃 |

**结论**：只追加账本与 G3 指针**必须**走会话事件——理由是在另一个面上"先写入的事实会静默消失"，这是 disqualifier，不是偏好。

## 4.2 方法论：能抄就抄

这条不是口号，是本次的**实际操作**——而且我先违反了一次：

| 该抄的 | 抄什么 | 结果 |
|---|---|---|
| **RRSI** | 搜索与正则化形状（退火预算、critic、argmax、编辑历史、novelty） | 已抄纯函数；**闭环待接**（§5 的 M 阶段） |
| **DSH session** | 事件信封、持久化、重放、压缩、迁移链、lease、投影注册表 | **待接**（S3'） |
| **DSH storage** | `defineDomain` + schema 闸 + 持久写 | 备而不用（当前无此类事实） |
| **旧仓 `EventStoreSet`** | 在会话事件之上的封装形态（`clone/apply/snapshot` + `load/open/snapshot/settledSnapshot/readOnlySnapshot/commit/append`） | **待抄**（S3'） |
| ~~自建~~ | ~~`ProtocolLog`~~ | **已判定为错误，S3' 替换为内存测试后端** |

---

# 5. 重构计划

原则：**每阶段只做一件能被反例证伪的事**，且每阶段的退出条件必须可机械判定。**不做"整理一遍"这类无法验收的阶段。**

**第一轮审核（[review.md](review.md) §5）用 A–F 阶段取代了本文原先的 S3′–S9**，并指出原先的安排遗漏了 E3、E6 与真实 Task 主路径，且 S9 的领域测量应在依赖它的搜索之前完成。以下以审核的顺序为准。

## 已完成

| 阶段 | 产出 | 状态 |
|---|---|---|
| **S0** | 核心脉络 spec：六实体、五关系、权威写入表、保证阶梯、53 种类 → 38 载荷 | 完成 |
| **S0-C** | 对 DSH 的更正：`ignorable` 语义；`storageDomain` 是第二个持久面 | 完成 |
| **E1** | 实测：`storageDomain` 跨进程无互斥且静默丢失更新；session 有 `flock` 租约 | 完成 |
| **S1** | 协议框架：一个信封 + 一条追加路径 + 一个 fold 引擎 + 一个版本闸 + 一个拒绝契约 + 7 条门禁 | 完成（**存储层待换**） |
| **S2** | 纵切：Task 契约 → Run → 独立判决 → 派生的 receipt → 唯一读投影 → agent/UI 同源 | 完成 |
| **审核首轮修复** | E02/E03/E04/E06/E07/E08 全部修掉；门禁换成词法剥离 + 拒绝 default/namespace 导入 + **门禁自检** | 完成（`d849430`） |
| **F01 承载实验** | DSH 事件词表是**仓内生成**的；仓外扩展事件运行时不可见；`ignorable` 是唯一机制且活跃缝设不了 → **控制 store 必须骑在"已知 log-only 类型"上** | 完成（结论见 [context.md](context.md) §4.1） |
| **RRSI 独立复核** | E09–E12 与 R05/R06 确认，并对审核自身给出两处修正（E12 被高估、R06 需拆分） | 完成 |

**当前实测**：`src` 1721 行 / `tests` 1306 行 / **55 测试** / **7 门禁 + 门禁自检**，`pnpm verify` 全绿。

## 待做（审核 §5 的顺序，每项含退出条件）

| 阶段 | 交付 | 退出条件（可机械判定） | 状态 |
|---|---|---|---|
| **A** | 专用控制 store、DSH 承载、串行提交、严格边界、命令结果识别 | 双进程互斥；并发命令正确；屏障失败不返回成功；提交后/答复前崩溃可识别原结果 | **进行中**：串行提交 ✅ 命令识别 ✅ 严格边界 ✅ 承载实验 ✅；**剩余：把存储接到已知 log-only 的 DSH 事件类型上，`append` + `await flush`（`false` 即失败）** |
| **B** | 最小 E3、Task 分解与责任、初始不可变 Revision、最小 Bubble、真实 verifier 与固定来源 receipt | 根/子任务执行与依赖推进；产物独立验收；SIGKILL 后恢复同一 session/责任/绑定 | 未开始（**K1 检查点**） |
| **C** | 冻结双侧输入、真实领域取数、非补偿约束、真实重复与噪声依据 | 好候选通过；高分越界拒绝；缺失分母正确；每份报告有真实 trials | 未开始 |
| **D** | draft 状态机、E6 原生审批、决定重算、唯一指针切换 | 批准绑定具体差异；陈旧/内容变化拒绝；head 不引用半成品 | 未开始 |
| **E** | 显式 round、真实历史与 frozen deltas、m≥2 选优、探索/剪枝消费者、消费反馈 | 至少两轮完整执行；第二轮读第一轮；历史不被新 head 改写 | 未开始（**K2**） |
| **F** | 关键行为回归、领域任务集对照、部署替代 | 恢复/边界满足新契约 | 未开始 |

**下一次重要审核在 A+B 完成时**。A 的承载实验已成功，故 A 的剩余工作是把存储接上去；若那一步失败，先改适配契约，不向 B 叠功能。

## 明确不做

- 不重造持久化、重放、压缩、迁移、投影注册表（上游有）
- 不为尚无消费者的事实预留 `StorageDomainSink`
- 不按行数拆 `task-runtime`（§1.5 纪律：400 行是审查触发线，不是拆分线）
- 不引入通用 repository / 事件总线 / effect 引擎
- 不做"整理一遍"这类无法验收的阶段

---

# 6. 重构的架子

## 6.1 三层，只有中间层是新的

```
第 1 层  存储与重放        DSH 提供，不自建
         会话作用域  → SessionEventMap（默认 required，即未知即拒绝）
                        + session-persistence-jsonl（flock 租约 / 代际 / 原子发布）
                        + session-format 迁移链 + session-projection + compaction
         库作用域    → ctx.storageDomain（defineDomain + zod 闸 + 持久写）

第 2 层  协议纪律          singularity-core ← 唯一新增的东西
         fold 引擎 · 版本闸 · 拒绝契约 · 保证阶梯 G1–G4 · 门禁清单

第 3 层  领域载荷          逐层填（Task/Run/Evidence → Revision/Pointer → Method/Draft → Bubble）
```

**第 2 层保持纯函数、无 I/O、无 cordis**；持久化在 `SessionEventSink` 适配器之后。这不是预留扩展点——是 DSH 自己 doctrine 划出的面。

## 6.2 六实体 × 落点

| 实体 | 架子里的位置 | 状态 |
|---|---|---|
| E1 Task | `src/task/contract.ts` + `protocol.ts`（5 种 kind） | **已建**（S2） |
| E2 Run | 同上（`run/started` / `run/verified` / `run/failed`） | **已建**（S2，revision 目前是声明引用，S4 起由 CAS 强制） |
| E3 Agent node | 待建（旧仓 `graph` 的 5 种 kind 是蓝本） | 待建 |
| E4 Method | 待建（`environment/revision` + `methods.jsonl` 7 kind 是蓝本） | 待建 |
| E5 Evidence | `src/task/protocol.ts` 的 `evidence/produced` + **reducer 内的独立性强制** | **已建**（S2） |
| E6 Human decision | 待建（DSH 原生审批 seam；旧仓 `method-publish` 是蓝本） | 待建 |
| G4 派生层 | `src/task/view.ts`（`TaskView` + 派生 receipt + agent 渲染） | **已建**（S2） |

## 6.3 `singularity-core` 现状（15 文件）

| 文件 | 行 | 拥有什么 |
|---|---|---|
| `src/protocol/envelope.ts` | 268 | 一个信封（闭合成员 + 摘要覆盖 body）+ 无损 JSON 域 + 闭合键规则 |
| `src/protocol/log.ts` | 314 | 一条追加路径：**提交队列**（并发命令串行化）+ **命令结果识别** + 发射者由协议决定 + 写前 dry-run（**存储层待换**） |
| `src/protocol/registry.ts` | 254 | 一个版本闸 + **可组合的保证词表** + 发射者纪律 + 声明原子性 + own-key 查询 |
| `src/protocol/fold.ts` | 80 | 一个 fold 引擎（两个作用域：整库 fail-closed / 单 subject 隔离），装载时也走 kind 的解析器 |
| `src/protocol/refusal.ts` | 88 | 一个拒绝契约（26 个具名 code） |
| `src/task/contract.ts` | 152 | 契约：**shape（纯）与可用性（命令期）分开**；闭合契约与判据 |
| `src/task/protocol.ts` | 334 | 5 种 kind + **三条写在 reducer 里的不变量** + 按 kind 闭合载荷 |
| `src/task/view.ts` | 265 | 唯一读投影（含 `awaiting-run`）+ 派生 receipt（含验证器实现与产物摘要）+ agent 渲染 |
| `scripts/gates.mjs` | 345 | **7 条门禁 + 自检**（`--probe`：每个静态检测器都必须能失败） |
| `scripts/slice.mjs` | 154 | 端到端冒烟（第 7 条门禁跑它） |

**三条不变量**（写在 reducer 里，不在提示词里）：

1. 判据由它**命名的那个验证器实现**裁决（发射者角色 = `verifier:<ref>@<version>`，所以部署必须真的持有该实现的身份）；
2. 执行者**永不自判**自己的 run——按角色**和**身份双重校验，所以把同一个身份绑给两个角色也会被拒；
3. 只有每条判据都有 pass 才允许 verified，拒绝时**点出缺哪条**。

**派生层的示范**：执行凭证从 run 自己的事实在读取时推导，协议**不声明 receipt kind**，所以想存它会被 `unknown-kind` 拒绝；两个读者从同一批事实算出的 `receiptDigest` **由构造相同**。

## 6.4 门禁清单（重建的第一资产）

| 门禁 | 拦住的屎 | 是否已证伪 |
|---|---|---|
| `no-export-star` | 隐藏模块承诺的 barrel | ✅ |
| `single-durable-writer` | 第二个写者（S3' 后收紧为"零持久写者"） | ✅ |
| `no-unreferenced-export` | 面大于所用（旧仓 197 处） | ✅ |
| `no-duplicate-type-body` | 一个类型声明两次 | ✅ |
| `source-size` | 400 行（起始上界，不是目标） | ✅ |
| `single-conditional-owner` | 第二个条件更新（CAS）实例 | ✅ |
| `vertical-slice-smoke` | 框架不再能折叠（跑真实纵切） | ✅ |

**门禁自检**：`node scripts/gates.mjs --probe` 让每个静态检测器面对一个同时违反全部六条的合成文件 + 一个"只在注释里提到别人导出"的文件，**每一个都必须触发**。它已经两次抓到真实缺陷：

1. `no-unreferenced-export` 曾有一条捷径把"入口文件存在"当成引用，导致该门禁**永远不可能失败**；
2. 加入注释/字符串剥离后 `single-durable-writer` 失效——import 的模块说明符**本身是字符串**。于是检测器现在读两个视图：**说明符读原文，名字引用读剥离文本**。

规矩：**新增门禁必须同时给出让它失败的探针。**

## 6.5 依赖约定（必须记住，否则下一个人会装错）

**npm 上发布的 `@deepseek-ai/dsh-*` 是 `0.0.1-rc.1`；本地 CLI 装的是 `0.2.0-rc.2`，两者差距很大（前者很可能不含 `storageDomain`）。**

因此新仓**不得**从 registry 装 `@deepseek-ai/*`，必须像旧 singularity 那样指向 `thirdparty/deepseek-harness`（checkout）或 CLI 已装的那份。这条在阶段 A 落地时写入 `package.json` 与文档。

**另一处路径更正**：review §7 的 E01 复核脚本用 `dsh-session-persistence/lib/types/storage-contract.js`——该文件在装好的 build 里**不存在**；`validateStoredEvents` 由 `dsh-session-persistence/lib/index.js` 导出。

## 6.6 证据基础（历史工作件，按需查证）

| 文档 | 内容 |
|---|---|
| `~/Documents/singularity-refactor-plan.md` | 五平面冗余总账（逐条 file:line）+ A/B/C/D 阶段 |
| `~/Documents/singularity-rrsi-diagnosis.md` | RSI 三处断点的证明链 + F1 设计入口 |
| `~/Documents/singularity-s0-spine.md` | 六实体/五关系/权威写入表/保证阶梯/53→38 收敛算术 |
| `~/Documents/singularity-s0-correction.md` | `ignorable` 更正、`storageDomain` 遗漏、S1 重造对账 |
| `~/Documents/singularity-probe-results.md` | 本次实测：storageDomain 丢失更新 vs session flock 租约 |
| `~/Documents/singularity-f1-design.md` | F1 详细设计（改一个字段点亮五个 RRSI 输入） |
| `~/Documents/singularity-dead-exports.tsv` | 197 个零引用导出清单 |

---

# 7. 五个待决问题：第一轮审核已给出答案

审核（[review.md](review.md) §5 末表）逐条回答，本文据此记录，不再作为待决项。

| # | 问题 | 审核结论 |
|---|---|---|
| 1 | **三层划分**（DSH 存储 / 我们只做协议纪律 / 领域载荷）是否同意？ | **保留职责分层**；纯领域规则、DSH 适配器、副作用编排均有明确边界，但**逐项核实上游保证**——不要假定上游会替我们保证语义（F01 就是这样一个反例） |
| 2 | **E3 / E6 重建还是复用？** | **E3 复用 DSH 的 create/resume 生命周期与旧仓已验证的行为**，只重建必要的领域边界；**E6 接原生审批 seam**；不依据包数决定全量重写 |
| 3 | **RRSI 闭环是否插队？** | **不插队**：实现留在可信评估（阶段 C）之后；轮次、历史、消费与决定依据的数据契约先定下来 |
| 4 | **`storageDomain` 是否彻底不用？** | **当前无真实用途就不预建**；以后按跨图共享需求与所有权选择，**不依据现有目录名决定** |
| 5 | **旧仓去留？** | **冻结为行为参照**，必要维护独立处理；新闭环与关键回归完成后归档；**不迁移只约束旧包结构的测试** |

**审核另外要求本文（蓝图）承担的责任**：更新作用域、权威写入表、版本纪律、阶段依赖与退出条件；**不得把审核建议未经实现直接改标为已完成**。本文 §5 已按此更新；`docs/context.md` 记录逐项反例的状态与剩余工作。
