# 阶段 B 设计（真实执行纵切）

> **状态：设计中。§1/§2/§5/§6/§7 已定；§3/§4 等两份证据，不由猜测填。**
> 上游依据：[`review.md`](review.md) §5（B 行）与 §6（K1 12 场景）；[`blueprint.md`](blueprint.md) §1.2（六实体）。
> 本文不是计划的重写，而是把 B 落到"哪个事实、哪条不变量、哪个强制点、哪个消费者"这一层。
> 证据基础：`src/protocol/fold.ts`、`src/protocol/memory-log.ts`、`src/task/protocol.ts`、`src/task/view.ts` 的逐行阅读。

---

## 0. B 的交付与退出条件（照抄 review，不改写）

**交付**：最小 E3、Task 分解与责任、初始不可变 Revision、最小 Bubble、真实 verifier 与固定来源 receipt。

**退出条件**（可机械判定）：

| # | 退出条件 | 判据形态 |
|---|---|---|
| ① | 根/子任务执行与依赖推进 | 真实的父提出分解 → 两个子任务有明确依赖 → 依赖满足才推进 |
| ② | 产物独立验收 | pass/fail 来自实际执行与固定产物；换掉产物/输入/验证器实现后旧 verdict 不放行 |
| ③ | SIGKILL 后恢复同一 session/责任/绑定 | 在执行边界与结算边界各杀一次，重启后同 session、同责任、同 revision/bubble 绑定 |

**下一次重要审核在 A+B 完成时**（review §5）。A 已收口（`docs/context.md` §4.1 末尾表）。

## 1. B 必须遵守的约束（不依赖待补证据）

| # | 约束 | 出处 / 强制机制 |
|---|---|---|
| 1 | **不建 group / router / 嵌套组** | review §6："无当前消费者的完整嵌套组能力不作为提前建平台的理由" |
| 2 | **不建通用沙箱平台** | review R08："先实现当前实验实际需要的隔离" |
| 3 | **不新增没有消费者的事实种类** | 根因三（契约声明了但没有消费者）；每个 kind 必须写下消费者与门禁 |
| 4 | **不把不变量放进提示词** | 根因四；不变量进 reducer，或进"全日志纯投影"（§2） |
| 5 | **不重造持久化/重放/迁移** | `no-durable-writer` 是绝对门禁；durability 只属于 DSH |
| 6 | 单文件 ≤ 400 行 | 门禁 `source-size`；**按责任分文件，不按行数** |
| 7 | `src/` 里 `conditional: true` 至多一个 | 门禁 `single-conditional-owner`；**B 不引入第二个条件更新**，指针切换留在 D |
| 8 | 已冻结格式增加必填字段 → **升版本，且不写兼容层** | review §5 末；"不能由'本机没有旧账本'推导'同版本格式可随意改变'" |
| 9 | 派生状态永不持久化 | 门禁式拒绝 `derived-not-persistable` |

## 2. 架构决定：写侧不变量是单 subject 的，读侧不变量是全日志的（**已定**）

这是 B 最重要的一条，它由现有引擎的语义直接推出，不需要新证据。

**事实**（逐行读过）：一个 fact 只被**它自己 subject** 的 reducer 检查（`memory-log.ts` 的 `stateKey`，`fold.ts` 的 `applyFacts` 按 `entry.subject` 分桶）；而 `foldSubjects` 是**全日志**读，`foldSubject` 是**隔离**读（`fold.ts:56,70`）。

**张力**：分解天然跨 subject——父声明子，而子的工作在子的 subject 上。上游旧系统在这里有两个坏选项，两个都踩过：

- 把汇总**落盘**（父 subject 上再记一份"子已完成"）→ 同一事实两份，就是根因二（"同一事实在会话日志与自有文件里两份"）；
- 交给**调用方约定**或提示词 → 根因四（"该由数据结构保证的事，交给了提示词"）。

**决定**：

1. 分解的**边**是父 subject 上的事实（父的事实，闭合，可纯判：唯一、非空、无环、不可改）。
2. 子的执行是子 subject 上的事实（契约、责任、run、verdict **一律不复制到父**）。
3. **父的"完成"不落盘——它是投影。** 于是"父任务不会提前完成"不是被禁止的，而是**不存在可违反的事实**；"失败如实传播"= 投影点名失败的子。这比再加一个门禁更强，也与 receipt 的既有做法一致（协议**不声明** receipt kind，想存它会被 `unknown-kind` 拒绝）。

**代价（诚实记账）**：跨 subject 的**存在性**判定（"run 钉住的 revision 真的被创建过吗"）**不是 reducer 不变量**，只能是全日志投影。投影必须**拒绝**（具名），不是仅仅报告。凡属这一类，本文逐条标出，不假装它在 reducer 里。

## 3. 事实面（**证据 A 已到并复核；E3 一行仍等证据 B**）

证据 A = [`legacy-behaviour-reference.md`](legacy-behaviour-reference.md)。其中的承重结论我**自己复核过原文**：分解门（`child.ts:576-582,658-663`）、责任不变量（搜不到，三处命中都是无关的 run 继续/proposal 归属拒绝；`handoff.ts:20-21` 自认"只持久化数据"）、二维 CAS（`pointer.ts:371-376,415-422`）、verifier 版本是字面量 `'1'` 且 `stampVersion` 覆盖（`command-verifier.ts:181`、`index.ts:374-380`）、`artifactRefs: []`（`index.ts:432`）、group 无生产者。

| 领域 | 种类（定） | subject | 不变量 | 强制点 | 消费者 |
|---|---|---|---|---|---|
| **R3 责任** | `task/assigned{agentId, agentIdentity}`、`task/reassigned{from, agentId, agentIdentity}` | task | 指派一次；转移的 `from` 必须**等于当前责任人**；**`run/started` 只接受当前责任人的身份** | **reducer** | K1 §6 |
| **分解** | `task/decomposed{children:[{taskId, dependsOn:[…]}]}`——**一条完整事实** | 父 task | 一次性（不可改）；子 id 非空、唯一、≠父；`dependsOn` 必须在声明内；**无环** | **reducer**（纯，形状+无环） | 投影的就绪判定 |
| **初始 Revision** | `revision/created{revisionId, manifest}` | 环境 | 内容摘要由 reducer **重算并自校验**（篡改即拒）；同 id 同内容 = 幂等；同 id 异内容 = 具名拒绝；**没有任何 kind 能改已创建的 revision** | **reducer** | `run/started` 的钉住 + 投影的存在性 |
| **最小 Bubble** | `bubble/opened{runId, inputs:[{name,digest}], workspace:{kind,ref}}` | task | 一次 run 一个 bubble；只对 running 的 run；**每条 verdict 的输入摘要必须等于该 run 的 bubble 所声明的输入** | **reducer**（同 subject，所以是纯判） | K1 §7 的输入绑定 |
| **真实 verifier** | `evidence/produced` 增必填 `implementationDigest`；criterion 增 `implementationDigest`；verifier 实现须带 `selftest` 样本 | task | 实现摘要与 criterion 声明不一致即拒；**selftest 必须既有 pass 样本又有 fail 样本** | **reducer** + 部署期 selftest | K1 §7 / §11 |
| **E3 agent node** | **待证据 B**：引用 DSH 的 session/agent 对象，还是自建模 | — | — | — | 责任（只有活着的 agent 可被指派） |

**两处关键：为什么 bubble 的输入绑定**能**在 reducer 里**。bubble 与 evidence 都以 task 为 subject，所以"verdict 的输入摘要 = run 的 bubble 声明的输入摘要"是**单 subject 纯判**——不需要 §2 那条"跨 subject 只能靠投影"的代价条款。跨 subject 的只剩 revision 的存在性一条。

**E3 的"可见节点必有活会话"：按旧仓事实降级为 ordering，不伪装成不变量。** 旧仓是靠"先 `agents.create` 解析、后提交 `agent/add`"的顺序（`agent-runtime/src/index.ts:243`→`:277`）做到的，reducer 只校验非空字符串 id、且不持会话句柄（`graph/src/service/state.ts:47-48`、`graph/src/index.ts:80-82`）。**我们的日志同样判不了 DSH 会话的存活**（那是运行期事实，不是日志事实）。所以这一条要么如实写成 ordering + 由投影把 session id 露出来供消费者查，要么不做；**绝不写一个判不了它的 reducer 来假装有保证**。

## 3.5 有意与旧仓不同（每条给理由，不是"我们做得更好"）

| # | 旧仓 | 我们 | 理由 |
|---|---|---|---|
| 1 | N 条 `DependencyAdded` + 一条 `TaskDecomposed`（`task/src/index.ts:258-273`） | **一条** `task/decomposed` 携带全部子与边 | `docs/context.md` §4.3 第 9 条：DSH 的 `append([a,b])` **不是**多记录崩溃原子事务，有业务原子性的操作应表达成**一条完整事实** |
| 2 | "immutable" = 目标路径已存在就抛（`store.ts:222-223`），无 chmod/只读模式 | **reducer 不变量**：同 id 异内容拒 + 内容摘要自校验 | path-exists 不是不可变；自校验摘要是纯函数，且顺带得到篡改拒绝（旧仓 `revision.ts:233-240` 的同一行为，但那是重读文件） |
| 3 | receipt **存储**、且**完全不提 verifier**（`task-runtime/src/receipt.ts` 全文件无 verifier，`receipts.ts:145`） | receipt **派生**、内容寻址、含 artifact 与实现摘要 | 旧仓的"固定来源"是靠**省略** verifier 得到的——那与 `artifactRefs: []` 是同一种病（verdict 不绑定任何具体物）。我们用"在判决时刻冻结摘要"得到固定来源，且历史仍可读 |
| 4 | 责任只持久化数据，**转移不变量 NOT FOUND** | 责任有门牙，咬在 `run/started` | review 把这条列为 B 的退出条件；旧仓 `handoff.ts:20-21` 自认只存数据 |
| 5 | bubble docstring 声称隐藏 checkout 与 `$DSH_HOME`（`bubble.ts:4-8`），代码**没有**实现 | 掩蔽 **REUSE-DSH**，我们不实现、也不声称 | 实测：掩蔽在 DSH sandbox（`docs/bubble-mcp-requirements.md:7`），bubble 只是多加了一个 skill root（`spawn.ts:99-104`）。这是"注释描述了义务、代码没实现"的又一例 |
| 6 | `GroupNode`/`group/add`/`member/add`/`routerFor` | **不做** | 无生产生产者、无消费者；"router 是唯一对外端点"只有散文（`state.ts:115-118` 的 `edge/add` 没有 router 操作数） |

## 4. 派生投影（定）

现有读层是**单 subject** 的（`projectTask` / `projectReceipt`）。B 新增的**全日志**投影在本仓是第一次，边界写死：

- `projectTree(states)`：输入 `foldSubjects(...)`（全日志，fail-closed）。派生分解树、每个子的依赖就绪、父的汇总（**点名**失败的子）。**就绪规则照抄旧仓的承重行为**：只有 `verified` 满足依赖，terminal-but-unverified 视为阻塞并带具名理由（`child.ts:576-582,658-663`；回归见 `tests/integration/a3-coordination-loop.spec.ts:450-453`、`a6-recovery.spec.ts:333-340`）。
- `projectBinding(taskState, environmentStates)`：判定 run 钉住的 revision **确实被创建过**，且 `contentDigest` 与创建事实一致；不符即**具名拒绝**（§2 的代价条款，唯一一处）。
- receipt 已存在且已派生；B 追加 K1 §11 的证明：**卸载验证器实现后历史 receipt 摘要不变**，而**新**执行缺实现则具名拒绝——两者必须分开（`contract.ts` 的 shape/availability 拆分）。

## 5. B 明确不做（写下来，防止它自己长回来）

- 不做 draft 状态机、不接审批、不做指针切换（阶段 D）。
- 不做多候选、不做选优、不做 round（阶段 E）。
- 不做 group/router/嵌套组（无消费者）。
- 不做通用沙箱平台；不做缓存/可写挂载/外部服务隔离的通用能力。
- **不做预算的运行时强制**。B 只保证"**没有任何事实种类能改大已声明的预算**"（不可变性即保证），并把"声明 vs 消耗"的差额放进投影。真正的预算强制属于 C。
- 不做 `storageDomain`。
- **不为无消费者的事实预留钩子**——包括"每个 kind 一个命令期前置条件"这一层：在出现**第二个**消费者之前不加（`ControlSessionStore` 已有的命令期检查是 `not-lossless-json` 与命令身份，够了）。

## 6. K1 12 场景 → 谁负责

| # | 场景 | 归属 | 满足方式 |
|---|---|---|---|
| 1 | 独立进程重开控制 store | **A** | 已观测：`scripts/control-probe.mjs` 第 1/2 节 |
| 2 | 两进程竞争、杀死持有者 | **A** | 已观测：探针第 2 节 |
| 3 | 同进程并发准入或更新 | **A** | 已观测：提交队列 + `gate.spec.ts` |
| 4 | 屏障失败；提交后答复前杀进程 | **A** | 已观测：`tests/control-barrier.spec.ts`（含变异证明）+ 探针 4b |
| 5 | 身份伪造与协议非法输入 | **A + S2** | 已观测：`unknown-emitter-role`、闭合载荷、原型 key；审批者身份属 D |
| 6 | 根节点提出并执行分解 | **B** | reducer（分解形状）+ 投影（就绪推进）+ reducer（责任咬在 `run/started`） |
| 7 | 真实验证器处理具体产物 | **B** | reducer（实现不一致即拒）+ 真实执行器 |
| 8 | 准入后方法版本更新 | **B** | reducer（revision 不可变、同 id 异内容拒）+ 投影（绑定存在性） |
| 9 | 执行与结算边界 SIGKILL | **B** | 恢复同一 session（A 已证）→ 同责任/同绑定（B 的事实 + 探针） |
| 10 | 子任务失败或耗尽预算 | **B** | 投影点名失败的子；预算不可放大（§5） |
| 11 | 完成后追加消息、卸载验证器 | **B** | 派生 receipt 摘要不变；历史重放与"缺实现拒绝"分开 |
| 12 | agent / UI 读同一已提交截止范围 | **B** | 唯一投影；未启动的 task 是 `awaiting-run` 不是 `failed`；读路径不追加（既有） |

## 7. 待裁决问题（证据 A 到后已收敛到三个，都属证据 B）

**已裁决（证据 A）**：

- **责任的门牙**：钉在 `run/started`——只接受**当前责任人的身份**。新增具名拒绝码 `not-responsible`（记账见 §8）。
- **`task` 协议升 v2**：升。`evidence/produced` 增必填 `implementationDigest`、criterion 增必填 `implementationDigest`，属"已冻结格式增加必填字段"（约束 8）→ `TASK_VERSION = 2`，**v1 日志按 `version-mismatch` 具名拒绝，不写兼容层**（review §5 末）。现有 fixture 随之升级，不留 v1 路径。
- **分解的"子任务真的存在"**：投影**拒绝**（§2 的代价条款）。子任务自身的"存在"= 它以**自己的 subject** 有一份 `task/admitted` 契约；这正是"子 id 出现在父的分解里"不足以证明的东西。
- **bubble 输入快照的粒度（B 的边界）**：bubble 记 `inputs[]`（名字 + 内容摘要）与 `workspace{kind, ref}`；**工具/工具链版本不放进 bubble**，由 verifier 的 `implementationDigest` 覆盖。理由：R08 说"只固定 Skill 文本或 MCP 定义，不能保证背后的 Tool 实现没有变化"——而 B 里**会做出判决的工具就是验证器**，它已被实现摘要钉住；工作区工具链的测量属 C，B 不假装测过。

**仍待证据 B**：

1. **E3 的形态**：引用 DSH 的 session/agent 运行时对象，还是我们自己的事实？
2. **agent 身份绑定**：现有 `subjects: Record<role, identity>` 是否要扩为 per-agent？扩了会不会破坏"执行者不自判自己的 run"的**双重校验**回归（E03 的两条用例）？
3. **verifier 的 selftest 门放在装载期还是命令期**，以及 `implementationDigest` 由谁算（部署方提供 vs 我们算）。**倾向已定**：依 `contract.ts` 已确立的 shape/availability 拆分——**形状在 fold 期、可运行性在命令期**——selftest 属**命令期**（"今天能不能跑"），装载期只校验摘要存在且形状闭合。待证据 B 只为确认没有上游缝与之冲突。

## 8. 实现切片与记账（证据 B 一到齐就可按此派发，不再临场设计）

**顺序与依赖**：S1 与 S2 都动任务协议 → **必须同一次 `TASK_VERSION = 2` 变更落地**，不能分两次改版本。S3/S4 在同一 v2 内追加 kind 与必填字段。**S5 等证据 B。** 每片都必须：门禁全绿、新增回归、且**用变异证明新回归真能失败**。

| 片 | 内容 | 退出条件（可机械判定） |
|---|---|---|
| **S1** | `environment` 协议 v1：`revision/created{revisionId, manifest}`；`projectBinding`；`run/started` 的消费者 | 同 id 同内容**幂等**；同 id 异内容**具名拒绝**；manifest 摘要被篡改即拒（reducer 自校验）；run 钉住**未创建**的 revision 或无投影时摘要不符 → 投影**具名拒绝** |
| **S2** | 任务协议 v2：`task/decomposed` **一条完整事实**；`projectTree` | 依赖非 `verified` 时子**不就绪**；terminal-but-unverified 依赖→阻塞**带具名理由**；`dependsOn` 越界/重复/自指/环各具名拒绝；父**没有**完成态事实，只有汇总 |
| **S3** | v2 必填字段：`evidence/produced` 与 criterion 各增 `implementationDigest`；verifier **selftest 门（命令期）** | 判决的实现摘要 ≠ criterion 声明的 → 具名拒绝（复用 `wrong-verifier`）；verifier **缺 fail 样本即不可运行**（"门禁必须能失败"用在验证器上）；**卸载实现后历史 receipt 摘要不变**，而新执行缺实现具名拒绝 |
| **S4** | `bubble/opened{runId, inputs[], workspace}`；verdict 的**输入绑定** | 判决的输入摘要 ≠ 该 run 的 bubble 所声明 → 具名拒绝；对已结算的 run 开 bubble / 同 run 开第二个 → `illegal-transition` |
| **S5**（等证据 B） | E3 + `task/assigned`/`task/reassigned` + `run/started` 的**责任门** | 转移后**旧责任人**启动 run → **具名拒绝**；转移的 `from` ≠ 当前责任人 → 拒绝；只有活着的 agent 可被指派 |
| **S6** | K1 探针（12 场景；含真实 SIGKILL、真实 verifier 的小任务冒烟） | 设计 §6 的表逐条有观测 |

**新增具名拒绝码的记账**（`REFUSAL_CODES` 26 → 31，每条都必须配反例测试）：

| 新码 | 为什么不能复用现有的 |
|---|---|
| `not-responsible` | 与 `self-reported-evidence` 不同：后者是"执行者自判自己的 run"，前者是"我已被免去这项责任" |
| `cyclic-dependency` | `malformed-payload` 说的是形状坏；环是**形状合法但语义坏**，消费者要能分开处理 |
| `revision-conflict` | 与 `evidence-conflict`（一条判据只能一份判决）不同：这是**同 id 异内容**的内容寻址冲突 |
| `unknown-revision` | run 钉住一个没有被创建过的 revision；与 `unknown-run`/`unknown-criterion` 同族但不同物 |
| `evidence-input-mismatch` | 判决绑定的输入与 run 的 bubble 声明不符；`wrong-verifier` 管的是**谁**判的，这条管的是**在什么输入上**判的 |

**复用、不新增**：判决实现不符 → `wrong-verifier`；分解两次 → `illegal-transition`；子 id 重复/自指/越界 → `malformed-payload`；同 run 第二个 bubble / 对已结算 run 开 bubble → `illegal-transition`。

**派发子代理时的硬要求**（防止"想偏"）：brief 必须逐字给出该片的 kind 名、payload 字段、不变量、**强制点**、**消费者**与退出条件，并写明"**不得**添加本片之外的事实种类、不得新增扩展点、不得把不变量放进注释或提示词、`src/` 内 `conditional: true` 不得出现"。

