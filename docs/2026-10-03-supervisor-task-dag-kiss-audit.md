# Singularity 复核：先修 supervisor 闭环，再让 Task/Skill 驱动生长

施工进展与验证口径见 [Task / Skill 自改进实现](2026-10-03-task-skill-implementation.md)；本页的源码结论保留为施工前审计记录。

日期：2026-10-03。复核对象：[原评审](2026-10-03-verify-supervisor-core-gaps-review.md)。
方法：三个 GPT-6 Sol、xhigh 子代理分别只读检查 supervisor/verify、Task/DAG、Evolution/KISS，主代理复查接线并运行定向测试。源码基线：Singularity `d7f7e2273875727d5a405d5106d6e1083f710c07`；外层 harness `145f505bbaf72f4e1a8cfc67c8819908cf82338c`。文中源码路径相对 `packages/singularity/`；部署配置例外标为 harness 路径。

## 1. 结论

**原稿抓准了方向性缺口：Task 模板没有成为可解析、可执行、可改进的一等对象，标准 supervisor 路径也没有完成候选到生产续跑的闭环。它不能原样作为施工规格：部分事实错误，部分因果推断过强，优先级把真实接线问题排在了复杂的新机制之后。**

现有代码已经提供 Task 契约、递归分解、兄弟依赖 DAG、独立验证、诊断、双侧实验、应用与恢复。这些部件有价值。问题集中在部件之间的职责、目标和续跑协议，而非所有机制都不存在。

建议围绕这一条路径建设：

> 父任务识别未满足结果 → 优先匹配已有 Task 模板 → 绑定参数或生成标准契约 → 选择 Skill 与已注册 Tool/MCP → 执行并验证 → supervisor 提出具体模板/Skill/能力变更 → 对照验证 → 人审核 → 应用 → 由负责父任务重新规划受影响工作 → 记录真实效果。

**首版先证明一个失败可以沿这条路径自行处理。** 通用原子性证明、标量目标函数、全局学习平台和自动缓存都不应成为它的前置条件。

## 2. 原稿事实校正

| 原稿说法 | 复核结论与依据 |
|---|---|
| supervisor 只有 1 bit，所以关闭是必然 | 聚合验收以通过为准，但观测含逐判据 verdict、passed/total、日志和 metrics；没有禁止模型使用 metrics。真正缺的是成功后“更快/更省”的冻结比较规则。`agent-singularity/src/coordination/handoff-rules.ts:175,283`；`evolution/src/evolution.ts:950`。 |
| `rootIndependenceDefects` 防根恒真判据 | **错误。** 只要求至少一个 mandatory 非 composite 判据，`true` 也符合；无恒真/恒假语义检查。`task-runtime/src/admission.ts:139`；`task-runtime/tests/unit/admission.spec.ts:575`。 |
| 每条 mandatory 都必须 command | **修法过宽。** command 模式已经要求非空命令；composite 有合法无命令验收。实际陷阱是无 mode/command 默认 review，而内置 review/formal verifier 恒 inconclusive。应拒绝隐式不可结算判据，或提供明确可用的结算路径。`task-runtime/src/admission.ts:163`；`normalize.ts:240`；`verifier/src/review-verifier.ts:31`。 |
| 坏 child 判据永久污染根，只能人重发契约 | 同一父 Run 的 composite 确实受所有失败成员阻塞；新 root Run 可以只复用 verified 成员，再生成修正子契约。**根自身判据有错**才缺同店修订通道。`verifier/src/composite-verifier.ts:108`；`task-runtime/src/recovery.ts:475`；`service/root-recovery.ts:311,396`。 |
| `^\$ ` 相比 `^[$] ` 恒假 | 单引号传给 `rg` 时两者均匹配字面 `$ `。事故可能来自 shell/JSON 转义；必须提供完整原 command、传参和日志才能归因。孤立正则片段不足以证明恒假。 |
| `TaskDefinition` 是生产版本化空壳 | `TaskDefinition` 只在测试兼容夹具中。真实缺口是生产 `definitionRef` 固定写 root@1/subtask@1，没有模板解析和参数绑定；`contractVersion=1` 是数据格式版本。`tests/support/legacy-root.ts:30`；`task-runtime/src/service/root-intake.ts:847`；`service/admission.ts:311`；`task/src/contract.ts:6`。 |
| 整个迭代默认关闭 | Evolution 九个工具默认 off；自动复盘默认 all，supervisor 与 task_recover 仍注册。两种开关须区分。`agent-singularity/src/index.ts:73,179,223,230`；`coordination/supervision.ts:20`。 |
| 改进完全无度量、结果不可观测 | 双侧 experiment 已保存冻结输入、判据、outcome、cost。缺的是 apply 后 proposal → 新生产 Run → 结果的明确关联和自动复评。`evolution/src/experiment/runner.ts:88`；`experiment/record.ts:340`；`evolution/src/types.ts:139`；`task/src/types.ts:223`。 |
| 未知成本拒绝晋升 | 仅冻结预算声明 maxTokens 时成立；未声明则跳过这项成本闸。`evolution/src/promotion/binding.ts:679,720`。 |
| 义务机制不存在 | 有模板读取和展示用覆盖检查，没有驱动未满足义务的闭环。当前“请求能力/记录义务”就算 covered，不能表示义务已满足。`task-runtime/src/obligation.ts:90,118`；`context/src/reads/task-status.ts:22`。 |
| task_definition 不可迭代，Tool/MCP 只能有限调整 | **成立。** 只有 skill/capability 有可执行候选与提交器；capability 只能引用既有授权面，MCP server 表仍硬编码于源码。`evolution/src/types.ts:27`；`capability-candidate.ts:309`；`task-runtime/src/mcp-servers.ts:43`。 |

原稿的“60–65% 落地度”“学习层 0%”没有可复算口径；关键词零命中不证明功能不存在。原稿引用的 0 轮、3 次 closed、判据事故没有附可复查的 store/ledger/session 原件，本次不将这些数字作为已复现实测。`ChildEvidenceRef` 当前也没有子契约 digest 字段，不能称现成的 digest-pinned 判据引用（`task/src/types.ts:54`）。

## 3. 原稿漏掉的直接阻塞

### 3.1 supervisor 挂着 reviewer 的相冲突 persona

`COORDINATION_PRESET` 固定为 singularity-reviewer（`agent-singularity/src/coordination/handoff-rules.ts:11`）；该 preset 要求“只读、只判定、不调用任何写工具”，输出六维 judgement（`bundle/presets/singularity-reviewer.patch.yml:37`）。supervisor 的首请求却要求构造候选、记录提案、启动恢复（`handoff-rules.ts:283`）。preset 会在实际 spawn setup 中挂载（`agent-runtime/src/index.ts:508`）。

这是源码可确认的角色冲突；对具体模型关闭行为的影响仍需实际请求与运行验证。最小修法是复用宿主装配，去掉共享 preset 的特定 reviewer 职责，把 reviewer/supervisor 各自稳定政策装入独立 section。无需再造 agent runtime。

### 3.2 所有 child 诊断都启动 supervisor，恢复入口却只接受 root

自动扫描接收 child/root 的 failed/verified review（`agent-singularity/src/coordination/review-scan.ts:43`）。每个 Diagnosis 都交 supervisor，空建议也一样（`coordination/review-run.ts:384`）。可是 `task_recover` 明确只开 root 新 Run，child 被拒（`evolution/src/service/core.ts:814`；`task-runtime/src/service/root-recovery.ts:145`）。

默认 reviewer/supervisor 共享 8 次启动额度（`coordination/supervision.ts:20`；`coordination/ledger.ts:479`）。四个先完成的 child 各占两次，就可能让 root 的复盘和恢复无额度。**当前 harness/config.yml:238–243 已把额度改为一百万且 Evolution off，因此这不是本部署实测关闭的已证实原因，但默认部署存在这个结构问题。**

普通子任务故障先交真实父 Run，利用已有 Diagnosis 消息投递（`coordination/review-scan.ts:50`）。确有共享 Task/Skill/能力变更时才进入 supervisor；把负责恢复的父 Run 明确交接给它。子节点成功也不需要每次固定启动两名复盘代理。

### 3.3 候选到审批、应用、续跑没有完整交接结果

supervisor 的工具面到 gate 为止，不能调用 decide/apply（`coordination/handoff-rules.ts:14`）。完成 watcher 只认“已 task_recover”“回复 closed”，其他结果记 interrupted（`coordination/evolution-handoff.ts:176`）。**候选已 gated、等待人审**没有稳定结算状态、审批承接者或应用后的唤醒路径。

现有 decide/apply 工具内部已经调用人审（`agent-singularity/src/tools/evolution-decide.ts:63`；`evolution-apply.ts:127`）。最小方案可让受委派 supervisor 请求这两个已有受审工具，并正确配置 ask 审批策略；也可由现有 root 承接，但必须落库 proposalId、负责人和续跑位置，再用已有消息投递。不要仅写“人决定并应用”却不指定是谁请求审批、是谁处理批准后续工作。

结算应从持久事实识别提案等待审批、应用后等待续跑、已关闭和真正中断；复用现有 proposal 状态，不另造一套完整审批状态机。恢复顺序也应先处理必要能力变更，再开新尝试；目前 prompt 先建议 recover，随后才建议构造候选（`handoff-rules.ts:285`）。

### 3.4 成功源有 improve 入口，却被标准演化路径拒绝

task_recover 的 improve 会保持原验收开新 Run。标准诊断来源可解析且已 verified 时，Evolution 明确拒绝实验/晋升，因为没有“更快/更省”比较器（`evolution/src/evolution.ts:950`）。现有 A7 用例最后的 improvement 全复用通过成员，没有新成员执行（`tests/integration/a7-multi-round-recovery.spec.ts:455`）。

需要明确两种目标：失败修复看原验收转为通过；成功优化看验收保持通过且指定成本/质量目标改善。选择一个测量范围完整的指标即可，不必引入通用标量 V。引用缺失、成本未知或外部状态不可比时，明确记录无法比较。

### 3.5 根能力缺口可能在 supervisor 启动前就被挡住

根 intake 对 missing capability 直接拒绝（`task-runtime/src/service/root-intake.ts:674`），此时尚无业务 Run 的终态 Review，自动 review → Diagnosis → supervisor 链不能处理这次缺口。应让 intake 保留待处理契约/缺口并有明确承接路径；不要要求人先编写 Skill 才能启动号称能补能力的系统。协调能力需求与实际执行能力需求也应区分，避免 root 被迫具备所有叶节点资源。

## 4. Task、Skill、原子叶节点与 DAG 的最小定义

保持三个事实清楚：**Task 规定结果，Skill 提供方法，Tool/MCP 提供动作。** 模板是可复用 Task 的定义；实例是某次绑定后的不可变契约；Run 记录实际执行及能力绑定。用户希望先匹配现有 Task，适合成为生成入口的默认策略；检索无适用模板时仍允许生成合法新契约，避免模板库成为任务白名单。

最小模板需要：id、不可变版本/内容摘要、适用条件、参数 schema、产物/验收声明、能力要求。实例同时记录模板引用、参数绑定和最终 contractDigest。实现选择及 Skill/Tool/MCP 身份继续固定在 Run。Task 可以给出建议 Skill，实际绑定与可用性仍由准入解析，避免用 Skill 名代替能力要求。

现有 `task_decompose` 输入没有模板引用与参数绑定，直接接收模型写出的完整子契约（`agent-singularity/src/tools/task-decompose.ts:26`）。可以增加模板匹配/实例化路径，仍统一进入已有 normalize/admission；无需维护两个 Task 执行系统。

**原子叶 Task 的操作定义：** 对明确输入产出一个可以单独验收的结果，在当前能力和预算下可由一个执行者完成；没有需要独立承担、独立验收的下层结果。它可以调用多个工具。是否原子依赖目标粒度和能力，不能靠任务名、固定深度或工具调用次数证明。

模型负责提出边界并解释判断。代码检查参数、引用、能力可用、依赖无环、判据可运行、证据绑定与预算；父/根验收检查组合结果。把模型的原子性或自然语言覆盖判断包装成新的 boolean gate，仍不会得到机械保证。

当前是**父子分解树 + 同批兄弟执行依赖 DAG**（`task/src/types.ts:68,91,680`）。先保留这两个视图，并把 Run/版本史放在图外；在实例化的执行依赖图中，下游消费上游产物与其摘要。父任务可以在看到结果后继续生长下一批，所以完整 DAG 不必在首轮就生成。跨批依赖或共享子任务要等真实案例需要时扩展，首次施工不必重写为通用图编译器。

### 节点 prompt 应直接指导可执行选择

稳定角色政策由人维护，当前契约/状态来自持久投影，领域方法来自 Skill。最小 worker 指导可以写成：

```text
你负责当前 Task 的结果。读取契约、输入、未满足判据和当前能力。
优先检查可见 Task 模板的适用条件；适用则绑定参数，无适用者提出标准新契约。
若结果可在当前能力/预算内由你独立完成，执行并交付一个可独立验收的结果。
若存在不同结果边界或职责，提出直接子 Task，只写本层；子节点决定自己的后代。
每个子 Task 说明回答哪项父结果，声明产物和真实 dependsOn；不按工具调用造节点。
批次结束后核对组合结果；缺口就继续处理，完成则提交给 verifier。
判据有错、能力缺失或需要父决定时，记录原始证据并交真实父任务处理。
```

supervisor 的最小指导应对应实际工具和协议：

```text
读取指定 Task/Run 的失败事实、契约、绑定版本和原始证据。
判断下一步是当前任务内修正、Task 模板变更、Skill 变更还是外部能力接入。
当前任务内修正交负责父 Run；共享变更只提出证据支持的最小差异。
保持用户目标和环外验收固定，物化候选，运行对照与必要回归，提交差异供人审核。
等待审核期间持久记录 proposalId 和续跑位置；应用后通知负责父任务重新规划。
记录变更版本、实际新 Run、验收与成本；无可执行改进时说明依据并关闭。
```

这些文本是目标合同；对应检索、模板变更、审批承接工具尚未打通前，不应作为已可执行能力写入生产 prompt。实际 prompt 必须只列该角色可用且能够结算的动作。

## 5. 哪些改进方向值得保留，哪些应收窄

| 原建议 | KISS 处理 |
|---|---|
| Task 模板进入 Evolution | 保留。先补模板产物格式、解析/绑定、候选物化、对照运行、提交/回滚和旧实例语义；加一枚 APPLYABLE_TARGET_TYPES 不会完成这些工作。 |
| 父任务拥有子判据、两层 oracle | 保留属主与环外验收原则。现有子契约已由父提出；先记录来源、版本和受保护输入，避免只为属主迁移增建判据平台。父子角色不同不自动产生独立性。 |
| soundness + agreement dry-run | 仅作为冻结样本上的一致性检查：要求有已标注正反例，输出这些样本中的误报/漏报；无样本不能空集通过。不能证明任意未来输入上的蕴含，也不能把旧坏判据的 verdict 当 oracle。初始准入可先检查 mode、可运行性与已有 checker，判据修订时再检查固定反例。 |
| 从父续跑改成影响锥 + 双臂 | 父任务需要先消费新版本并重新规划，随后才有新的执行依赖图和受影响集合。按新输入/绑定重做受影响后继，并重验相关祖先的组合结果；有可复用证据再保留其他成员。对照实验两侧各从同一冻结基线开始，不能用局部缓存代替 baseline。 |
| 统一 nodeId 带来免费 replay | 撤回“免费”保证。taskId 是事件身份，contractDigest 是内容身份，执行复用键是另一件事。缓存还需判据/verifier、Skill/Tool/MCP 身份、模型/prompt、环境、输入、可控外部状态；相同键也须定义产物存续、重验证及副作用复用规则。MCP templateDigest 目前明确不是执行身份（`task/src/types.ts:143`）。 |
| world version + 标量 V | 先记录每个变更对应的新 Run、实际绑定、结果和成本。world 可以是执行所消费的一组固定引用，不必每次复制所有东西；标量 V 没有首版必要性。保留 categorical experiment verdict，效果结论注明样本范围。 |
| 义务引擎、轨迹学习、趋势仪表盘 | 先把 obligation 的“未回答/已有证据/满足/阻塞”接进父任务上下文与结果处理，用已有 records 消费。一次成功修复沉淀为模板/Skill+反例即可；不要在消费闭环前建独立记忆库和五个仪表盘。 |
| MAIN/Candidate 分支 | 已有隔离 sandbox、baseline 和 candidate；git 分支不是比较实验的必要条件。只在候选工程修改实际需要时使用 worktree，不为文档名词造分支平台。 |
| 两次人审、权限分级 | 先补审批承接与批准后恢复。后续可将一次批准绑定精确候选 digest、写入目标和回滚计划，并在提交前复检；内容变化需要新批准。工具面限制与 OS 权限是不同机制，不能因 danger-full-access 名称就推断实际 grant 失效。 |

外部 Tool/MCP 接入确实需要开放：把源码内的领域 server 定义移到部署可注册的数据；记录 server 启动定义、版本来源、schema 与授权范围，探测可启动/可调用，再让 capability 引用。新增 server/工具的候选差异和实际授予范围纳入用户审查。复用 DSH 工具注册与 MCP client，不再自造 transport。无需将所有后端压成同一种可执行文件格式。

## 6. 实施顺序与最小验收

**P0：修 supervisor 接线与判据入口。** 消除 persona 冲突；普通 child 诊断先回父；候选等待审批有稳定交接和恢复；缺 mode/command 的 mandatory 不静默落入占位 verifier；缺能力契约有接收者。把“失败后下一步是什么、谁有工具、是否被唤醒”作为验收，不以 Diagnosis 数量或单测绿灯代替。

**P1：打通一个 Task 模板闭环。** 实现最小模板库、优先匹配、参数化实例和标准契约 fallback；为一个有独立项目测试的失败案例支持 task_definition 候选。冻结原目标/环外验收，比较旧模板与新模板；人审并应用后，真实父任务拿到新模板，生成新实例并完成原目标；关联 proposal、版本、Run 和结果。已有 Skill 更新同时验证，避免 Task 与 Skill 各有一套发布链。

**P2：扩展实际缺口。** 用一个外部 MCP 接入案例证明注册、授权、调用、能力绑定和回滚；用一个成功源案例证明验收保持通过且指定成本改善；用坏判据反例证明修订可纠错且无法洗白真实失败。再逐步接入义务证据状态和 DAG 影响范围。

**P3：复用与学习。** 当输入、工具、环境和副作用的复用条件明确后才做缓存；用实际历史修复驱动模板/Skill 的检索和回归集，再决定是否需要趋势与记忆系统。

每个最小用例都应经过真实模型请求与可控审批路径。至少覆盖：

1. 四个 child 先结束，root 仍能复盘/恢复；无需每个 child 都耗一名 supervisor。
2. 只产生 gated 候选时能够等待审批；重启不被误记 interrupted；批准/拒绝各有可结算出口。
3. Task 模板存在时优先复用；无适用模板仍可生成契约；叶节点产物可独立验收，依赖消费实际产物。
4. 错误 child 判据保留历史，经新计划/Run 替换当前工作；根判据修订保留用户授权与环外 oracle。
5. 应用新模板/Skill 后旧 Run 的绑定保持，负责父任务被唤醒，新 Run 的结果能归因到候选变更。

## 7. 本次验证边界

主代理运行以下已有测试，均通过：

```bash
pnpm exec vitest run --project unit \
  packages/singularity/agent-singularity/tests/unit/evolution-handoff.spec.ts \
  packages/singularity/agent-singularity/tests/unit/supervision.spec.ts \
  packages/singularity/task-runtime/tests/unit/normalize.spec.ts \
  packages/singularity/task-runtime/tests/unit/admission.spec.ts \
  packages/singularity/task-runtime/tests/unit/recovery.spec.ts
# 5 files，143 tests passed

pnpm exec vitest run --project integration \
  packages/singularity/tests/integration/a7-multi-round-recovery.spec.ts
# 1 file，2 tests passed
```

A7 脚本化模型/工具回应验证轮次、复用和停止协议，没有证明大模型自主生成合适 DAG 或完成共享模板改进。handoff 单测也用 mock spawn，没有加载真实 preset persona（`agent-singularity/tests/unit/evolution-handoff.spec.ts:98`）。本次未修改生产代码、未运行新的真实模型工程任务，也未修改部署配置；新增此复核文档供后续施工采用。
