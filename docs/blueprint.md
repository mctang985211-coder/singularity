# Singularity 重构蓝图

> 单一入口。审查从这里开始。
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

## 2.3 RRSI 对照表：接了什么、半接了什么、缺了什么

| RRSI 上游 | 端口位置 | 接线状态 |
|---|---|---|
| `evaluate.py: aggregate`（加权 per-trial、missing 计 0 不缩分母） | `strategy/measure.ts` | ✅ 已接 |
| `schedule.py: edit_budget`（退火编辑预算） | `strategy/schedule.ts` | ✅ 已接（`method-draft` 强制；进 supervisor 提示） |
| `critic.py`（评估前泄漏筛查） | `strategy/screen.ts` | ✅ 已接（`method-draft` 调用） |
| `selection.py` 的准入规则（噪声底线/成本规则） | `strategy/selection.ts:admit` | ✅ 已接（门禁 `method_publish`） |
| `history.py: History`（每条 edit 的 component/hypothesis/分数/verdict） | `strategy/history.ts` | ⚠️ **半接：函数在，输入是空的** |
| `history.py: stall_flag / exploration` | 同上 | ⚠️ 半接（派生自空输入） |
| `components.py: novelty`（从未出现在获胜 edit 里的结构组件） | `strategy/selection.ts:noveltyOf` | ❌ **恒为常数 1** |
| `calibrate.py`（噪声带实测） | `strategy/measure.ts` | ⚠️ 半接（`repetition` 由调用方声明，重复调用短路到第一份报告） |
| **每轮 k 个候选 → argmax 选优** | — | ❌ **缺失**（`selectRound` 零调用） |
| `analyst.py` / `digester.py` | — | ❌ 缺失（由 supervisor LLM 替代） |
| `Domain.guards`（非补偿性领域判据） | `pipeline/guards.ts` + adapter `guard()` | ⚠️ 真实约束只有 token 上限与 adapter guard；`rules.guards[].bound` 恒被盖 `ok: true` |

**结论**：**算法引进了，闭环没有。** 细节见 §3 根因五。

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

## 已完成

| 阶段 | 产出 | 状态 |
|---|---|---|
| **S0** | 核心脉络 spec：六实体、五关系、权威写入表、保证阶梯 G1–G4、53 种类 → 38 载荷 | 完成 |
| **S0-C** | 对 DSH 的更正：`ignorable` 默认即拒绝；`storageDomain` 是第二个持久面 | 完成 |
| **E1** | 最小验证实验：storageDomain 与 session lease 的实测对比 | 完成 |
| **S1** | 协议框架：一个信封 + 一条追加路径 + 一个 fold 引擎 + 一个版本闸 + 一个拒绝契约 + 7 条门禁 | 完成（存储层待换） |
| **S2** | 纵切：Task 契约 → Run → 独立判决 → G4 派生的 receipt → 唯一读投影 → agent/UI 同源 | 完成 |

**S1/S2 的实测**：`src` 1341 行 / 测试 948 行 / 15 文件 / **41 测试** / **7 门禁**，`pnpm verify` 全绿。

## 待做（每项含退出条件）

| 阶段 | 做什么 | 退出条件（可机械判定） | 前置 |
|---|---|---|---|
| **S3'** | **存储层换会话事件**：删 `ProtocolLog` 的 fsync/读回/size/摘要链，降为纯内存测试后端；写 `SessionEventSink`（形态抄 `EventStoreSet`，接 DSH `session-persistence-jsonl`）；`envelope` 对齐会话事件信封 | 两个进程各自 `write` 打开同一 session → 第二个拿 `SessionAlreadyOwnedError`；杀持有者 → 后继立刻接管；纵切冒烟仍绿 | E1 |
| **S4** | **E4 Method 的前半**：Environment Revision（不可变 manifest + 内容摘要）+ Run 准入钉住它 | 版本不可变有反例测试（改动即 digest 变）；Run 绑定的 revision 与 receipt 一致 | S3' |
| **S5** | **G3 指针**：`pointer/switched` 事实 + reducer 的 CAS 校验。**不写 intent 文件** | 陈旧 `expected.generation` 被具名拒绝；崩溃后重放得到同一 active revision；**无第二个持久化文件** | S4 |
| **S6** | **E4 Method 的后半**：draft → 双侧冻结评估 → 发布/弃置状态机 | 非法跃迁（如未评估即发布）由 reducer 拒绝；同一草稿的两次评估不覆盖 | S5 |
| **S7** | **M 阶段：把 RRSI 闭环接上**（本次诊断的三处断点 + 多候选 argmax） | `admissions[].novelty` 随声明与 incumbent 历史**变化**（首次 ≥1 / 已接受过为 0 / 两条编辑为 2）；`HistoryEntry.mechanism` 等于声明值 | S6 |
| **S8** | **G2 与 bubble 批次**：一轮内多组件原子 | 半途崩溃后该轮要么全可见要么全不可见 | S6 |
| **S9** | **领域数值**：`direction` 联合 + 真实取数器 + `guards.bound` 真实比较 | 一个"越小越好"的测量能直接驱动晋升 | S7 |

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
| `src/protocol/envelope.ts` | 155 | 一个信封（闭合成员 + 摘要覆盖 body） |
| `src/protocol/log.ts` | 203 | 一条追加路径（**待换为会话事件**） |
| `src/protocol/registry.ts` | 156 | 一个版本闸 + 保证阶梯 + G3 单实例 |
| `src/protocol/fold.ts` | 75 | 一个 fold 引擎（两个作用域：整库 fail-closed / 单 subject 隔离） |
| `src/protocol/refusal.ts` | 65 | 一个拒绝契约 |
| `src/task/contract.ts` | 108 | 可裁定的契约（判据绑定已注册验证器） |
| `src/task/protocol.ts` | 268 | 5 种 kind + **三条写在 reducer 里的不变量** |
| `src/task/view.ts` | 195 | 唯一读投影 + G4 派生 receipt + agent 渲染 |
| `scripts/gates.mjs` | 244 | **7 条门禁** |
| `scripts/slice.mjs` | 119 | 端到端冒烟（第 7 条门禁跑它） |

**S2 的三条不变量**（写在 reducer 里，不在提示词里）：

1. 判据由它**命名的那个**验证器裁决；
2. 执行者**永不自判**自己的 run（包括执行者本身就是注册验证器时）；
3. 只有每条判据都有 pass 才允许 verified，拒绝时**点出缺哪条**。

**G4 的示范**：执行凭证从 run 自己的事实在读取时推导，协议**不声明 receipt kind**，所以想存它会被 `unknown-kind` 拒绝；两个读者从同一批事实算出的 `receiptDigest` **由构造相同**。

## 6.4 门禁清单（重建的第一资产）

| 门禁 | 拦住的屎 | 是否已证伪 |
|---|---|---|
| `no-export-star` | 隐藏模块承诺的 barrel | ✅ |
| `single-durable-writer` | 第二个写者（S3' 后收紧为"零持久写者"） | ✅ |
| `no-unreferenced-export` | 面大于所用（旧仓 197 处） | ✅ |
| `no-duplicate-type-body` | 一个类型声明两次 | ✅ |
| `source-size` | 400 行（起始上界，不是目标） | ✅ |
| `single-g3-claim` | 第二个 CAS 实例 | ✅ |
| `vertical-slice-smoke` | 框架不再能折叠（跑真实纵切） | ✅ |

**每条都被注入探针证伪过。** 证伪过程本身抓出了 `no-unreferenced-export` 的一个真实 bug：它有一条捷径把"入口文件存在"当成引用，导致该门禁**永远不可能失败**。这条经验已写进仓库规矩：**新增门禁必须同时给出让它失败的探针。**

## 6.5 依赖约定（必须记住，否则下一个人会装错）

**npm 上发布的 `@deepseek-ai/dsh-*` 是 `0.0.1-rc.1`；本地 CLI 装的是 `0.2.0-rc.2`，两者差距很大（前者很可能不含 `storageDomain`）。**

因此新仓**不得**从 registry 装 `@deepseek-ai/*`，必须像旧 singularity 那样指向 `thirdparty/deepseek-harness`（checkout）或 CLI 已装的那份。这条在 S3' 落地时写入 `package.json` 与文档。

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

# 7. 请审查的五个点

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | **三层划分**（DSH 存储 / 我们只做协议纪律 / 领域载荷）是否同意？ | 同意就按 S3' 开始；这一条决定了后面所有事 |
| 2 | **E3 Agent node 与 E6 Human decision 的落点**：是重建（旧仓 `graph` 5 kind + DSH 审批 seam 为蓝本），还是先复用旧仓？ | 先按蓝本重建，因为旧仓那部分正是"形状繁殖"的重灾区 |
| 3 | **S7（RRSI 闭环）的优先级**：现在插队到 S4 之前，还是按顺序等 S6？ | 建议按顺序——闭环依赖环境版本与账本，早接会重复 S6 的持久化改动 |
| 4 | **`storageDomain` 是否彻底不用**？ | 当前无用途；等出现"不属于任何会话"的事实时再加，不预留 |
| 5 | **旧仓的去留**：并行维护 / 冻结只读 / 最后归档？ | 冻结只读，作为行为规格来源（89,675 行测试编码的不变量是新栈的验收清单） |
