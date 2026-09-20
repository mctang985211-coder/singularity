# Singularity Harness 工作指南

复核日期：2026-09-21。审计基线：Singularity `b00915c`，外层 harness `6c5eb49894`。
这两个提交保存了修改前的已跟踪及非忽略新增文件；第三方 DSH 子模块原有未跟踪文件不在这两个提交内。

本文是当前方向与进度的入口；[建设计划](2026-09-20-vrtc-code-change-plan.md)规定下一步落点和验收。
[术语表](../CONTEXT.md)定义概念。[历史指南](history/2026-09-21-harness-guide-snapshot.md)保留旧 §4.2 #1–#33、W/M 记录和操作经验，历史结论不能直接当成当前事实。

设计依据是 `/home/ROXY/code/ref/docs/VRTC-最小架构-KISS版-v2.0.md`，其正文版本为 **v2.1-KISS**，下称 KISS；旧 RFC 为同目录 `细化想法4.md`。
本次不修改外部参考文档。下面区分“源码事实”“建设目标”“本次设计选择”；设计选择是工程推导，不冒充此前的人类裁决。

## 1. 方向与边界

构建由可验证契约约束、允许节点自主分解的任务运行时。图是执行拓扑，Task 是语义单位，TaskRun 是一次执行，Session 是会话载体；不能把节点结束等同于任务通过。

1. **Task 固定目标、约束、验收，不固定 workflow。** 父节点与子节点都可提出分解，Harness 负责准入、依赖、资源授权和验收。依据：KISS §0、§3、§5。
2. **按验证边界拆任务。** 有独立输入、产物、验收且拆分有收益才拆；不要把每次 tool/skill 调用都变成节点。依据：KISS §4.1、§6、§12。
3. **Task 声明 capability，执行时选择 skill。** 运行前建立可行路径，运行中允许在授权范围内选择方法。依据：KISS §2、§3 I2、§11 第 3 条。
4. **通过由 verifier 与 evidence 决定。** 子全通过只是组合验收的一项输入，父目标还需要自己的判据。依据：KISS §6 C1–C4。
5. **缺口可见、升级有出口。** 缺能力时可规划和求助，不能把 `decomposable` 当成能力已具备，也不能靠无限分解消除缺口。依据：KISS §7。
6. **先可靠验收，再自动生长能力。** 复盘可提案，生产能力、验证标准与权限的变更走验证和既有授权边界。依据：KISS §8.1、§9、§12。

DSH 提供 agent/session、skill 发现与加载、preset、MCP、上下文与原生审批。Singularity 负责任务契约、能力选择、证据、组合验收、缺口恢复与复盘。继续使用现有服务，不另造通用 skill loader 或全局调度平台。

**当前阶段判断**：已有递归执行和证据记录的工程骨架；P3 能力保障与 KISS 的验证闭包尚未完成。Review/Evolution 有较完整的机械链路，不等于前置正确性条件已满足。下一阶段应补执行与验收的约束，不继续扩大 Evolution 自动化。

## 2. Task 与 Skill 怎样协作

### 2.1 选择：派发前解析，节点内按需加载

| 方案 | 收益 | 成本与边界 | 定位 |
|---|---|---|---|
| Task 契约直接写死 skill | 已知任务的选择成本低 | 换实现会改契约；易形成任务与技能一一对应；仍不能保证工具可用 | 不作为契约模型；固定实现可留在一次 run 的记录中 |
| 每个子节点拿 Task 后从全库找 skill | 探索自由度高 | 每个节点重复检索；找不到或权限不足到执行期才暴露；结果难复现 | 缺口恢复或探索场景使用 |
| Task 提 capability，Harness 派发前解析，子节点按需加载正文 | 复用配置、提前发现已知缺口，减少重复搜索与正文注入 | 需要可追溯的解析结果和明确的运行期缺口出口 | **默认方向** |

第三种更适合当前重复的 BB 工程任务；这是机制上的成本判断，**没有 A/B 数据证明它在所有任务上最快**。检索开销、总 token、首个有效工具调用延迟、成功率及 GAP 率应一起比较。开放任务允许补充发现，但发现一个 skill 不等于获得它需要的工具或权限。

**绑定发生在 TaskRun，不发生在 Task Contract。** Task 说“需要验证能力”，部署表选择实现；worker 决定具体如何使用已选方法。Skill 是指导内容，grant 是注册与授权，`skill` 调用是读取正文，三者不是自动执行脚本。

### 2.2 当前执行链路（源码事实）

```text
父节点 / 可分解子节点
  capability_list -> task_decompose(children.requiredCapabilities)
  -> checkDecomposition + resolveCapabilities（查部署配置表）
  -> 保存 Task / CapabilityManifest
  -> 按 dependsOn 顺序运行就绪子任务
  -> 检查 requiresArtifact -> Handoff + 独立 Session
  -> grant tools / 注册 skills / 挂载 MCP / 选择 preset
  -> worker 按需调用 skill，执行或继续 task_decompose
  -> verifier -> EvidenceBundle -> task 状态 -> 父验收
```

源码入口：`task-runtime/src/index.ts` 的 `decomposeAndRun`、`task-runtime/src/capability.ts` 的 `resolveCapabilities`、`task-runtime/src/orchestrate.ts` 的 `runChildrenCascade`、`agent-runtime/src/grants.ts` 的 `applyWorkerGrant`。

- `resolveCapabilities` 只查表并展开工具标签，返回 `closed` 或 `gap`；虽然类型含 `partial`，实现不产生它。`closed` 表示声明的名字已命中，**不表示 skill 前置条件或产物契约已闭包**。
- 缺 capability 且子任务未标 `decomposable`：拒绝整批子任务，另在父任务记录 Obligation。标了 `decomposable` 可以准入并启动规划 worker；执行安全仍依赖后续分解与授权约束。
- 多个命中能力的 skill/tool 合并，preset 使用首个声明值；多 preset 冲突尚未检测。Skill 不存在到 spawn 的 `grantSkills` 才报错。
- DSH skill grant 保证内容在 worker 的 skill 层注册；全局目录仍可能显示其他 skill，**没有按 worker 隐藏目录的保证**。工具授权另由 grant 限制；preset 自带工具与 MCP 挂载也是授权面的一部分。
- 本次修复：worker baseline 增加只读 `capability_list`。原先 `task_decompose` 指示先查能力表，但 worker 过滤器把它剔除，导致递归节点只能猜能力名。`graph_spawn`、Evolution 与平台审批工具仍不进入 worker baseline。

### 2.3 最小建设目标（尚未实现）

先保留显式能力表作为唯一 provider 选择入口；不要立即引入向量检索、自动排名或通用规划器。

1. **准入期预检已选实现**：skill 可发现、所需工具/MCP/preset 可配置、多个 preset 无冲突。预检不能保证 MCP 启动成功，spawn 仍需实际校验，失败要指向相同的缺口类型。
2. **worker 收到自己的精简能力摘要**：选中的 capability、skill 名称/用途、工具边界和未解决缺口；通过 DSH 按需读正文。当前 handoff 没有这个专门摘要，不应写成已实现。全局 skill catalog 的 token 成本仍存在。
3. **run 记录实际选择**：除了现有名称快照，还需记录 capability 表修订、skill 内容摘要或版本、preset/MCP 配置身份。现有 `capabilitySnapshot: string[]` 不足以复现内容。
4. **运行中发现缺口**：先检查已授权能力能否回答，再提出有验收标准的获取/分解任务；无可行路径则上报。加载另一份指导不扩权，不自动安装工具，不修改当前 Task 的 AC。

一个 capability 可有多种 skill 实现，一个 skill 也可服务多个任务。首版仍由部署选择一组实现；有真实替换需求和测量数据后，再做多候选排序。

### 2.4 执行型与知识型 Skill

KISS §4.2 的 Skill 指能提供可验证能力的执行实现；DSH 的 `SKILL.md` 还承载领域知识。两者需要明确区分，避免“知识没有执行 verifier，所以整个能力机制建不动”。

| 类型 | 内容与验证要求 | 是否能单独关闭执行能力缺口 |
|---|---|---|
| 执行型 | 声明提供的 capability、前置条件、输入/输出、required tools、verifier 引用；用正负样本验证实现效果 | 经契约和验证检查后才可以 |
| 知识型 | 来源、适用范围、内容版本、结构/引用检查；义务模板需能解析并验证覆盖规则 | 不可以；只能帮助发现义务和选择方法 |

**本次设计选择**：侧车元数据采用带类型的契约，知识型不伪造执行 verifier，也不计入执行闭包；它仍需内容检查和变更审查。这是对 DSH 内容类型的划分，不是给执行型 skill 开“未验入库”豁免。

侧车注册表尚未建设，确切 schema 留在实现票中。第一版只加入上述决策必需字段；成熟度五阶段、成功率衰减与统计排名后置。注册表负责元数据，DSH 继续负责正文加载。`evolution_apply` 检查也不是唯一入口：启动配置与新增/替换 provider 都必须经过同一校验。

领域包包含义务模板、执行 skill 与参考 verifier。模板只提问，不规定 C→BEMU→Compiler→RTL 的固定步骤。`dependsOn` 可以表达本次任务中确实存在的证据依赖；它不是被禁用的 API。

## 3. 建设顺序与完成条件

详细票据见 [建设计划](2026-09-20-vrtc-code-change-plan.md)。以下是依赖顺序，不是任务执行 workflow。

| 顺序 | 建设目标 | 完成条件 |
|---|---|---|
| S0 | 文档基线与递归能力发现 | 状态统一；worker 能查询能力表且没有获得管理工具 |
| S1 | 可信验收与可追溯能力绑定 | 错产物不通过；父 AC 有组合验证；不存在的 skill 和冲突 preset 在派发前拒绝；run 可定位实际实现 |
| S2 | 缺口处置和恢复 | 缺口持久化、去重、可上报；补足后仅恢复受影响任务；重启可继续；有有限预算 |
| S3 | L1 复用/组合，再 L2 生成 | 一个制造的 GAP 经现有能力组合消解；生成的 skill 在沙箱通过自身 verifier 和回归后才可晋升 |
| S4 | Retro 与自动接受规则 | observed/holdout 分开过关；按变更目标使用不同指标；坏候选被拒绝 |

S1 的验证与能力预检可独立建设，但两者都是自动生成生产能力的前置条件。S2 先建立恢复生命周期，再让 L1/L2 产生可消费的结果。L3 引入新工具继续走权限流程。长期记忆、通用全局调度器、复杂 skill 成熟度系统后置。

## 4. 当前实现与缺口

### 4.1 源码复核表

本表均复核于 2026-09-21；状态描述的是明确范围，不把“类型有字段”算成整项完成。函数名是定位锚，行号以当前 checkout 为准。

| 能力 | 当前事实与限制 | 源码锚 |
|---|---|---|
| Task / TaskRun / 递归分解 | 有独立对象、事件存储、结构准入、树与依赖 DAG、顺序级联；原子性和自然语言 AC 覆盖不由机器证明 | `task/src/types.ts`；`task-runtime/src/admission.ts:checkDecomposition` |
| Task 定义版本 | 有 `definitionRef`；普通子任务使用 `subtask@1`，不等于完整不可变定义库和变更授权机制 | `task-runtime/src/index.ts:decomposeAndRun` |
| Capability | 配置表解析与真实 grant 已建；没有完整 skill 契约预检、可行性证明或多候选选择 | `capability.ts:resolveCapabilities`；`grants.ts:grantSkills` |
| Handoff / 上下文 | fresh session、结构化 handoff、父会话引用、契约重注入已有；不是父 transcript 全复制 | `task-runtime/src/handoff.ts`；`agent-runtime/src/contract-reinjection.ts` |
| Evidence 依赖 | `requiresArtifact` 检查 store 中 evidence id / artifact id / kind 的存在性；缺失则 blocked + Obligation；不自动生成上游，也不验证匹配证据的通过状态、版本和适用性 | `orchestrate.ts:missingRequiredArtifacts` |
| Obligation | 记录缺能力/缺产物；模板 coverage 由任务声明 capability 或文字提及匹配；不是义务已被证据满足，更不是防漏的硬闸 | `task-runtime/src/obligation.ts:checkObligationCoverage` |
| 判决 | `pass/fail/inconclusive`；部分 unknown 有 task/verifier 分类；没有 PARTIAL 状态与剩余义务自动派发；未通过 mandatory 判据仍走失败路径 | `task/src/types.ts:VerificationResult`；`orchestrate.ts:unmetMandatory` |
| Verifier 元数据 | 可选 owner/version/selftest；register 缺 selftest 只警告、不执行自测；元数据不等于已实现独立性隔离 | `verifier/src/index.ts:register` |
| 父验收 | 默认 composite 只检查所有子任务 verified；没有 C2 覆盖映射、C3 假设满足性、C4 独立全局不变量 | `verifier/src/composite-verifier.ts:verifyIn` |
| 预算 | wallTimeMs 在飞取消；tools/tokens 仅终态审计；attempts/noProgressRounds 仅声明 | `orchestrate.ts:awaitWorker`、`budgetBreaches`；`task-runtime/src/index.ts:Config` |
| L4 上报 | root 的 `escalate` 工具与台账已有；模型主动调用，批准后才记 raised；运行时只输出提示，无自动触发、无处理结果/恢复闭环 | `agent-singularity/src/tools/escalate.ts`；`orchestrate.ts:escalationHint` |
| blocked 恢复 | blocked 无恢复出边；TaskRetried 只接受 failed，父分解一次的限制仍在；补能力后不会自动续跑原图 | `task/src/service/state.ts`；`task-runtime/src/index.ts:decomposeAndRun` |
| Review / Evolution | 有终态 ReviewRecord、Diagnosis、proposal/sandbox/replay/gate/approval/apply/rollback；不等于自动 Retro 或抗过拟合 gate | `orchestrate.ts:recordTerminalReview`；`agent-singularity/src/evolution.ts`、`replay.ts` |

### 4.2 优先修复的断层

| 编号 | 问题与影响 | 建设票 / 历史对应 |
|---|---|---|
| G1 | 父 composite 仅对子状态求合取，不能证明根目标；同环境执行 verifier 也不等于测试与阈值不可被修改 | S1-V / 旧 #25、#26 |
| G2 | provider 未预检、首个 preset 胜出、内容版本未固定；`closed` 被误用为可执行保证 | S1-C / 旧 #29 |
| G3 | 缺产物只查存在且 blocked 无恢复，证据驱动生长断在登记之后 | S1-V、S2-R / 旧 #20、#21、#22 |
| G4 | 上报依赖模型调用且批准前不落账；任务阻塞、通知与人类决策混在一起 | S2-E / 旧 #27；已有工具不能标为待建 |
| G5 | 三值判决、预算半接线，没有 PARTIAL/UNKNOWN 的任务级处置 | S2-R / 旧 #23、#24 |
| G6 | 缺 skill 契约与知识型定位，L1/L2 又被排在其前面，形成建设依赖倒置 | S1-C → S3 / 旧 #29 |
| G7 | Replay 总评与 gate 未形成强约束，分层指标和自动 Retro 未建 | S4 / 旧 #28 |
| G8 | `task_decompose`/`escalate` 部分拒绝返回普通文本，上层不能可靠用工具错误信号判定 | S2-E / 旧 #33 |

历史记录中的 M1–M9 为此前会话的实跑声明，保留于历史指南。本次回归结果见建设计划 S0；本次没有重跑 LLM、BB 构建仿真或生产 Evolution 链路。旧环境可用性、外部 bbdev 缺陷和部署阈值在使用前需重新读取对应部署，不能从旧日志推断当前状态。

## 5. 实现时的关键约束

### 5.1 验收先于自动生长

现有 command verifier 与 worker 共享 checkout：外部进程运行命令只提供执行分离，不保证 worker 无法修改测试、脚本或阈值。建设目标是固定验收输入的来源与版本，保护判据，记录 verifier 版本及证据产物身份；自述 JSON 和退出 0 均不能单独证明领域正确性。

组合验收先针对一个客观的小任务实现父 AC → 子证据映射和独立父级检查。不需要先做通用自然语言蕴含求解器。能机械判断的接口/数值写成检查；启发式覆盖显式标注，不能记成确定性闭包。

### 5.2 缺口恢复从有限状态开始

目标是记录缺口、选择处置、验证修复、重新检查依赖，再恢复待运行任务。先定义事件与状态迁移，保留原 Task 契约和每次尝试；不要直接把 blocked 改成 ready，或要求父节点再次提交同一批已落库子任务。

缺口通知本身与“批准新增工具/改生产 skill/接受残余风险”是不同动作。本次建议自动记录和通知缺口，后者继续请求授权；**当前实现仍是 approve 后写 raised，不能把目标写成已上线行为**。worker 可报告失败原因，由父级/root 接收；本次不把管理工具下发给 worker。

### 5.3 运行和验证

开发构建从 Singularity 目录执行 `pnpm build`；测试从外层 harness 执行：

```sh
pnpm vitest run --project unit packages/singularity
pnpm vitest run --project integration packages/singularity
```

事件声明有变化时执行持久化 schema 纪律，见 [persistence-changes](persistence-changes/README.md)；纯工具白名单改动不改变事件 schema。`pnpm run verify-persistence` 校验声明指纹。

部署配置以当前 `config.yml` 和 `capability_list` 为准。BB 验证通过项目 MCP 跑本地工具链；具体 env、preset、超时和判据 cwd 读当前部署与领域指导，不在通用架构中写死。

## 6. 文档维护

- 本文只维护方向和当前事实，建设计划只维护票据与验收；实施日志进入带日期记录。
- 每项完成状态必须写清范围、复核日期、源码/测试锚；区分声明、接线、自动测试、真实端到端运行。
- 同一改动同步更新本文的状态和建设计划。部分完成继续标“部分”，不可用“完成（核心未做）”。
- 新设计写成“建设目标/设计选择”；与 KISS 的差距保留为明确缺口，不以已有代码反过来宣称目标已达成。
- 历史材料只作来源，不与当前指南竞争规范地位。旧编号查询历史快照，新工作使用 S/G 编号。
