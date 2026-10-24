# 阶段 B 设计（真实执行纵切）

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

> 历史 B 阶段设计；当前任务运行合同见 [phase-g2-design](phase-g2-design.md)。 历史正文按基线保留。

> **状态：部分实现。S1 与 S3 验证器部分已落地，S2/S4/S5/S6 待完成。2026-10-09 复核纠正了 §2 的跨实体提交边界与 §5 的预算退出条件；K1 尚未达到。**
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

**下一次重要审核在 A+B 完成时**（review §5）。A 的提交边界纠正见 `docs/context.md` §12；B 必须按 K1 逐条提供观测，不能用独立 DSH 勘探实验替代产品执行路径。

## 1. B 的十条硬约束

| # | 约束 | 出处 / 强制机制 |
|---|---|---|
| 1 | **不建 group / router / 嵌套组** | review §6："无当前消费者的完整嵌套组能力不作为提前建平台的理由" |
| 2 | **不建通用沙箱平台** | review R08："先实现当前实验实际需要的隔离" |
| 3 | **不新增没有消费者的事实种类** | 根因三（契约声明了但没有消费者）；每个 kind 必须写下消费者与门禁 |
| 4 | **不把不变量放进提示词** | 根因四；不变量进 reducer，或进"全日志纯投影"（§2） |
| 5 | **不重造持久化/重放/迁移** | `src-names-no-durable-write` 是绝对门禁，**作用域是 `src/`**（测试与探针必须真的落到 `mkdtemp` 目录上才能行使沙箱，所以它们不在规则里）；durability 只属于 DSH |
| 6 | 单文件 ≤ 400 行 | 门禁 `source-size`；**按责任分文件，不按行数** |
| 7 | `src/` 里 `conditional: true` 至多一个 | 门禁 `single-conditional-owner`；**B 不引入第二个条件更新**，指针切换留在 D |
| 8 | 已冻结格式增加必填字段 → **升版本，且不写兼容层** | review §5 末；"不能由'本机没有旧账本'推导'同版本格式可随意改变'" |
| 9 | 派生状态永不持久化 | 门禁式拒绝 `derived-not-persistable` |
| 10 | **装载期断言所需的上游缝存在，缺一即具名拒绝装载** | 实测陷阱（证据 B）：一个插件在 `inject` 依赖缺席时**静默不存在**（`ctx.authorization` 在 credentials provider 出现前是 `undefined`）。"静默缺席的能力"正是旧仓的病，不能靠运行期撞见 |

## 2. 架构决定：局部 reducer、跨实体命令检查与派生投影

单 subject reducer 保持纯函数；它的局部输入限制不表示跨实体约束只能在读取时发现。

**事实**（逐行读过）：一个 fact 只被**它自己 subject** 的 reducer 检查（`memory-log.ts` 的 `stateKey`，`fold.ts` 的 `applyFacts` 按 `entry.subject` 分桶）；而 `foldSubjects` 是**全日志**读，`foldSubject` 是**隔离**读（`fold.ts:56,70`）。

**张力**：分解天然跨 subject——父声明子，而子的工作在子的 subject 上。上游旧系统在这里有两个坏选项，两个都踩过：

- 把汇总**落盘**（父 subject 上再记一份"子已完成"）→ 同一事实两份，就是根因二（"同一事实在会话日志与自有文件里两份"）；
- 交给**调用方约定**或提示词 → 根因四（"该由数据结构保证的事，交给了提示词"）。

**决定**：

1. 分解的**边**是父 subject 上的事实（父的事实，闭合，可纯判：唯一、非空、无环、不可改）。
2. 子的执行是子 subject 上的事实（契约、责任、run、verdict **一律不复制到父**）。
3. **父的"完成"不落盘——它是投影。** 于是"父任务不会提前完成"不是被禁止的，而是**不存在可违反的事实**；"失败如实传播"= 投影点名失败的子。这比再加一个门禁更强，也与 receipt 的既有做法一致（协议**不声明** receipt kind，想存它会被 `unknown-kind` 拒绝）。

**提交边界**：Run 绑定的 Revision 存在且摘要一致、被指派 Agent 已开通、依赖已通过验收等跨实体前置条件，由可信领域命令服务在同一控制 store 的串行提交边界内检查已提交状态，然后提交完整事实。不能在队列外先读后写，不能把当前可变 registry 捕获进历史 reducer。`projectBindings` 等全日志投影继续承担读取与诊断，但不能成为执行主路径唯一的检查。使用具体领域命令协调，不预建通用事务/钩子引擎。

## 3. 事实面（**证据 A、B 都已到并复核；六行全部定案**）

证据 A = [`legacy-behaviour-reference.md`](legacy-behaviour-reference.md)。其中的承重结论我**自己复核过原文**：分解门（`child.ts:576-582,658-663`）、责任不变量（搜不到，三处命中都是无关的 run 继续/proposal 归属拒绝；`handoff.ts:20-21` 自认"只持久化数据"）、二维 CAS（`pointer.ts:371-376,415-422`）、verifier 版本是字面量 `'1'` 且 `stampVersion` 覆盖（`command-verifier.ts:181`、`index.ts:374-380`）、`artifactRefs: []`（`index.ts:432`）、group 无生产者。

| 领域 | 种类（定） | subject | 不变量 | 强制点 | 消费者 |
|---|---|---|---|---|---|
| **R3 责任** ✅ | `task/assigned{agentId, agentIdentity}`、`task/reassigned{from, agentId, agentIdentity}` | task | 指派一次；转移的 `from` 必须**等于当前责任人**且不能是同一人；**`run/started` 只接受当前责任人的身份**（新码 `not-responsible`） | **reducer** | K1 §6 |
| **分解** | `task/decomposed{children:[{taskId, dependsOn[], supports[], maxRuns}]}`——**一条完整事实**，声明 `atomicFact` | 父 task | 一次性（不可改）；子 id 非空、唯一、≠父；`dependsOn` 必须在声明内且不重复；**无环**；`supports` 必须是**父契约**声明的判据；`maxRuns` 为正整数且没有任何 kind 能改大它 | **reducer**（纯：形状 + 无环 + 覆盖面）；子任务是否已准入、依赖是否就绪由**串行命令边界**检查（§2） | `projectTree` 的就绪与汇总；`supports` 让“子验收支持父契约的哪一条”成为**父契约能拒绝**的声明 |
| **初始 Revision** | `revision/created{revisionId, manifest}` | 环境 | 内容摘要由 reducer **重算并自校验**（篡改即拒）；同 id 同内容 = 幂等；同 id 异内容 = 具名拒绝；**没有任何 kind 能改已创建的 revision** | **reducer**；Run 准入的存在性在串行命令边界检查 | `run/started` 的钉住 + 投影的存在性 |
| **最小 Bubble** ✅ | `bubble/opened{runId, inputs:[{name,digest}], workspace:{kind,ref}}` | task | 一次 run 一个 bubble；只对 running 的 run；**每条 verdict 必须逐项回显该 run 的 bubble 所声明的输入**（数量、名字、摘要，顺序敏感；新码 `evidence-input-mismatch`） | **reducer**（同 subject，所以是纯判） | K1 §7 的输入绑定 |
| **真实 verifier** | `evidence/produced` 增必填 `implementationDigest`；criterion 增 `implementationDigest`；verifier 实现须带 `selftest` 样本 | task | 实现摘要与 criterion 声明不一致即拒；**selftest 必须既有 pass 样本又有 fail 样本** | **reducer** + 部署期 selftest | K1 §7 / §11 |
| **E3 agent node** ✅ | `agent/opened{agentId, role, sessionId}`（**协议 `agent@1`**） | agentId | 开通一次；三字段非空；载荷闭合。**"可见节点必有活会话"是 ordering，不是不变量**（见下） | **reducer**（形状）；存活**判不了** | `task/assigned`（只能指派已开通的 agent）+ 投影露出 `sessionId`，供恢复**同一会话**（K1 §9） |

**E3 的形态（证据 B 已裁）**：**引用 DSH 的运行时对象，不自建模。** 持久层是 `SessionHandle`（字节），运行层是 `ctx.agents`（`AgentRegistry`，`dsh-agent`）配 `AgentLoop`（`dsh-agent-loop`，`implements AgentFactory`）——实测用**桩 LlmAdapter** 跑完了一整轮。我们的 `agent/opened` 只记 `sessionId`，不复制 agent 内部。

我们的这个事实正好是 DSH **launcher 层** `ConfiguredAgentIdentities` 的插件侧、可审计对应物：那里也是 `configured agent id → {id: SessionId, resume}`（`dsh-agent-loop/lib/types/index.d.ts:70`），只是它是**进程配置**，我们是**日志事实**。同一信息，后者可重放、可审计。

**"可见节点必有活会话"再次确认为 ordering，且这次有上游证据**：实测陷阱 6——DSH 自己的**可继续子代理在 spawn 之后并不驻留**（`ctx.agents.get` 返回 `undefined`，roster `inactive`），陈旧 id 会让 `membership`/`sendMessage` 抛错。**上游自己都不把"驻留"做成持久事实**，所以我们做不到，且**不假装**：如实写成 ordering + 投影露出 `sessionId` 供消费者查。

**为什么 bubble 的输入绑定能在 reducer 里**：bubble 与 evidence 都以 task 为 subject，所以“verdict 的输入摘要 = run 的 bubble 声明的输入摘要”是单 subject 纯判。Revision、Agent 和依赖等跨实体关系按 §2 在串行命令边界检查；执行适配器同时验证实际读取的内容，摘要字符串相等不能证明实际使用了对应输入。

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
- `projectBinding(taskState, environmentStates)`：判定 run 钉住的 revision **确实被创建过**，且 `contentDigest` 与创建事实一致；不符即**具名拒绝**。执行主路径还须在串行命令提交边界复用该检查，不能只在事后读投影时发现。
- receipt 已存在且已派生；B 追加 K1 §11 的证明：**卸载验证器实现后历史 receipt 摘要不变**，而**新**执行缺实现则具名拒绝——两者必须分开（`contract.ts` 的 shape/availability 拆分）。

**已落地（S2）**：`src/task/decomposition.ts`（一条完整事实 + 无环 + 覆盖面）与 `src/task/tree.ts`（`projectTree`）。
子任务状态是 `missing | blocked | waiting | ready | running | verified | stopped`；**只有 `verified` 满足依赖**，停止与阻塞沿链**具名传播**（`"B" is blocked`），预算耗尽即 `stopped` 并点名“用了 N/N 次仍未 verified”。
父的 `complete` 是派生量：**每条判据都必须被一个 verified 且声明支持它的子任务（或父自己的 verified run）接受，并且每个声明的子任务都已 verified**——子任务“结束”永远不构成父任务被接受。

## 5. B 明确不做（写下来，防止它自己长回来）

- 不做 draft 状态机、不接审批、不做指针切换（阶段 D）。
- 不做多候选、不做选优、不做 round（阶段 E）。
- 不做 group/router/嵌套组（无消费者）。
- 不做通用沙箱平台；不做缓存/可写挂载/外部服务隔离的通用能力。
- **实现 K1 所需的最小预算停止**：预算耗尽时停止调度/执行、如实传播失败或停止，不隐式扩大额度；只保证预算声明不可变不足以满足 K1 #10。复杂成本建模与统计评估留在 C。
- 不做 `storageDomain`。
- **不为无消费者的事实预留钩子**。Revision 准入、责任指派和依赖推进已有真实消费者，应实现必要的具体命令检查；不以“没有第二个消费者”为由省略其正确性条件。

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
| 10 | 子任务失败或耗尽预算 | **B** | 停止实际调度/执行；投影点名失败/停止的子；预算不隐式扩大（§5） |
| 11 | 完成后追加消息、卸载验证器 | **B** | 派生 receipt 摘要不变；历史重放与"缺实现拒绝"分开 |
| 12 | agent / UI 读同一已提交截止范围 | **B** | 唯一投影；未启动的 task 是 `awaiting-run` 不是 `failed`；读路径不追加（既有） |

## 7. 三个待裁决问题（已全部由证据 B 裁决）

**已裁决（证据 A）**：

- **责任的门牙**：钉在 `run/started`——只接受**当前责任人的身份**。新增具名拒绝码 `not-responsible`（记账见 §8）。
- **`task` 协议升 v2**：升。`evidence/produced` 增必填 `implementationDigest`、criterion 增必填 `implementationDigest`，属"已冻结格式增加必填字段"（约束 8）→ `TASK_VERSION = 2`，**v1 日志按 `version-mismatch` 具名拒绝，不写兼容层**（review §5 末）。现有 fixture 随之升级，不留 v1 路径。
- **分解的“子任务真的存在”**：子任务自身的存在 = 它以自己的 subject 有一份 `task/admitted` 契约。分解协议明确子契约与边的发布顺序及崩溃恢复；调度命令在串行提交边界检查子任务存在与依赖就绪，投影对缺失者具名拒绝或明确呈现未完成状态，不能把声明了子 id 当成可执行。
- **bubble 输入快照的粒度（B 的边界）**：bubble 记 `inputs[]`（名字 + 内容摘要）与 `workspace{kind, ref}`；**工具/工具链版本不放进 bubble**，由 verifier 的 `implementationDigest` 覆盖。理由：R08 说"只固定 Skill 文本或 MCP 定义，不能保证背后的 Tool 实现没有变化"——而 B 里**会做出判决的工具就是验证器**，它已被实现摘要钉住；工作区工具链的测量属 C，B 不假装测过。

**三个问题已由证据 B 裁决（证据 B = `/home/ROXY/code/dsh-phase-b-probe/REPORT.md`，11 个可重跑脚本 + `out/*.txt`；我自己复核了 `ctx.agents` 的声明与 `AgentLoop implements AgentFactory`、`agentTeams: TeamService`、`approval: ApprovalService` + `'approval/asked'`/`ApprovalRequestId` + `callId?: ToolCallId` 且**无摘要**、`trustedIdentity|principal` **零命中**、`static inject: string[]`）**：

1. **E3 的形态 = 引用 DSH 的运行时对象**（见 §3）。
2. **agent 身份绑定 = 完全 plugin-side**。DSH **没有**受信身份缝：无 `ctx.identity/principal/roles`，agent/approval/auth/credentials/team 诸包里没有任何 `role|principal|trust|identity` 导出；权威处处是**活着的 `Agent` 对象**，唯一叫"role"的是 Team 局部的 `'lead'|'teammate'`。**注意一个近似物不是它**：`ConfiguredAgentIdentities`（`dsh-agent-loop`）只映射 `agent id → {sessionId, resume}`，是 launcher 配置，不是主体认证，且只在包内被消费。→ 因此 `subjects: Record<role, identity>` **保持是我们的**，E03 的角色+身份双重校验**不受影响**（表是我们的，把同一身份绑给两个角色仍被拒）；E3 只在它之上增加 **agent 维度**：`task/assigned{agentId, agentIdentity}` 的身份来自**我们自己的绑定**。
3. **verifier selftest 门 = 命令期**；`implementationDigest` **由部署方提供**（我们只校验存在与一致，算不了别人的实现摘要）。按 `contract.ts` 已确立的 shape/availability 拆分：装载期只校验形状与摘要存在，**"今天能不能跑"是命令期**。上游无冲突缝（DSH 自己的 `ApprovalService` 也把 `'unavailable'` 与拒绝并列，同一思路）。

## 8. 实现切片与记账（六片全部可派发，派发不再是设计步骤）

**顺序与依赖**：当前 `task@2` 已落地，后续不得同版本随意增加已冻结/已分发载荷的必填字段。下一次改变历史解释的变更集中设计后升版本，不留兼容层；新增 kind 也要明确旧读取者的拒绝行为。**S5 已解锁**（证据 B 已裁 E3 与身份绑定）。每片都必须：门禁全绿、新增业务反例，并证明关键回归在对应坏行为下失败；变异测试不能替代正确的业务契约。

**按文件所有权分工（避免两个写者改同一个文件）**：`src/task/**`、`tests/task-fixtures.ts` 与既有任务用例**只有一个所有者**（任务协议 v2 是全阶段的耦合点）；`src/environment/**` 与 `src/verifier/**` 各自独立成文件，互不触碰 `src/task/**`，导出留待统一接线。

| 片 | 内容 | 退出条件（可机械判定） |
|---|---|---|
| **S1** | `environment` 协议 v1：`revision/created{revisionId, manifest}`；`projectBinding`；`run/started` 的消费者 | 同 id 同内容**幂等**；同 id 异内容**具名拒绝**；manifest 摘要被篡改即拒（reducer 自校验）；run 钉住**未创建**的 revision 或无投影时摘要不符 → 投影**具名拒绝** |
| **S2** ✅ | `task/decomposed` **一条完整事实**（`dependsOn`/`supports`/`maxRuns`）；`projectTree` | **已达成**：依赖非 `verified` 即不就绪；停止/阻塞沿链具名传播；越界/重复/自指/环各具名拒绝；父没有完成态事实，只有汇总 |
| **S3** | v2 必填字段：`evidence/produced` 与 criterion 各增 `implementationDigest`；verifier **selftest 门（命令期）** | 判决的实现摘要 ≠ criterion 声明的 → 具名拒绝（复用 `wrong-verifier`）；verifier **缺 fail 样本即不可运行**（"门禁必须能失败"用在验证器上）；**卸载实现后历史 receipt 摘要不变**，而新执行缺实现具名拒绝 |
| **S4** | `bubble/opened{runId, inputs[], workspace}`；verdict 的**输入绑定** | 判决的输入摘要 ≠ 该 run 的 bubble 所声明 → 具名拒绝；对已结算的 run 开 bubble / 同 run 开第二个 → `illegal-transition` |
| **S5** | E3（`agent/opened`，引用 DSH 会话）+ `task/assigned`/`task/reassigned` + `run/started` 的**责任门** + **装载期缝断言**（约束 10） | 转移后**旧责任人**启动 run → **具名拒绝**；转移的 `from` ≠ 当前责任人 → 拒绝；只能指派**已开通**的 agent；所需上游缝缺席 → **装载期具名拒绝**，不是运行期 `undefined` |
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

