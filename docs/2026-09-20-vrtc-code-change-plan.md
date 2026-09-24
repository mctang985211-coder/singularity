# VRTC-KISS 建设计划

更新：2026-09-24。保留原文件名作为稳定入口；原临时计划在 [历史快照](history/2026-09-21-vrtc-plan-snapshot.md)。
方向与实现事实以 [工作指南](singularity-harness-guide.md)为准；本文仅描述建设顺序、代码落点与可验收结果。
基线备份：Singularity `b00915c`，外层 harness `6c5eb49894`。

## 当前排期

### 唯一派发顺序与完成闸

补救原始基线：代码 `fda3d29`；文档备份 Singularity `1430103`、外层 `31bcf3a`。2026-09-23 交付复核范围为 `7171747..d5b0bb6`，修改前备份为 Singularity `a4c1da0` / 外层 `fa4bc09`。以下表格是唯一当前顺序；历史记录保留当时结论，当前状态以本表及下方「补救交付复核」为准。

当前门状态来自此前代码与证据复核；本次仅补齐后续设计合同，不实施业务代码、不调用真实模型。发现明确反例才重开对应项，保留其余已成立的交付证据。

后续进度审核使用[进度审核指挥 prompt](execution-prompts/progress-review-and-dispatch.md)，单票内容按[派发模板](execution-prompts/task-dispatch-template.md)填写。下文带日期的原交付记录中“下一项”、提交和测试数只描述当时，不覆盖本表。子代理任务按[公共派发粒度](execution-prompts/README.md#子代理派发粒度)拆分；主代理承担整票集成与验收，不把整组工作原样转派。

下表同时作为可填写的任务流程表，保持一套顺序。`待填` 不表示已验收；负责人栏可填 agent 名称或任务链接。交付记录栏填写本文件内的验收记录锚点，提交、日期和阻塞详情放入下方单项模板，避免表格过宽。

| 次序 | 一次派发的范围 | 状态 | 负责人/任务 | 交付记录 | 进入下一项的条件 |
|---|---|---|---|---|---|
| 1 | T1：统一规范化契约 | 已验收（2026-09-21，独立子代理复核） | Kimi Code 主代理（4 实现/测试子代理 + 1 只读复核子代理 + 1 复核修复子代理） | 见「T1：统一规范化契约 执行与验收记录」 | 契约规范化、持久化与普通分解/replay 一致性全部验收 |
| 2 | S1-V 切片 2：验证器自测与输入身份 | 已验收（2026-09-22，独立子代理复核） | Kimi Code 主代理（2 实现子代理 + 1 集成子代理 + 1 渲染跟进子代理 + 1 只读复核子代理 + 1 复核修复子代理） | 见「S1-V 切片 2：验证器自测与输入身份 执行与验收记录」 | 正负样本执行、裁判版本与受保护输入校验完整；P4 组合验收回归通过（本轮复跑 26 项；全量集成 22 文件 / 145 项） |
| 3 | S1-C：能力预检与版本绑定 | 已验收（2026-09-22，独立子代理复核） | Kimi Code 主代理（5 实现子代理 + 1 独立复核子代理 + 1 复核修复子代理） | 见「S1-C：能力预检与版本绑定 执行与验收记录」 | provider 预检、侧车契约、Run 绑定内容与旧版本读取完整；所有实际支持入口共用校验 |
| 4 | A3：非阻塞运行与恢复 | 已验收（2026-09-22，独立子代理复核 + 复核修复回归） | Kimi Code 主代理（5 阶段实现/测试子代理 + 1 独立复核子代理 + 1 复核修复子代理） | 见「A3：非阻塞运行与恢复 执行与验收记录」 | 非阻塞推进、工作区写入归属、显式提交、取消/恢复、根预算与普通/replay 一致性完整 |
| 5 | T2 + T3：契约审核与恢复（一个交付组） | 已验收（2026-09-23，双模型并行独立复核 + 综合复核确认） | Kimi Code 主代理指挥 + 4 阶段实现子代理（A 提案合同层 / B task-runtime 生命周期、重检、幂等与恢复 / C 工具面、审批渠道与 prompt / D 集成级验收、模型协议 fixture 与文档收尾）+ 2 并行独立复核子代理 + 1 综合复核子代理 | 见「T2+T3：契约审核与恢复 执行与验收记录」 | off/all、审核持久化、批准后重检及崩溃恢复一起验收，不单独交付不可恢复的 all |
| 6 | A0 + R0：根入口与默认运行面（本票返工 A0） | 已验收（2026-09-23，进度审核复核 + 全量回归实跑） | Kimi Code 主代理（Q2/Q3 各一个实现子代理 + 1 个只读独立复核子代理，复核后一轮缺陷修复） | 原记录 +「补救交付复核」Q2/Q3 +「A0 返工（Q2/Q3）执行与验收记录」 | 已满足：根来源/归属（store↔session、顶层会话、本人消息）与 adoptRoot 恢复反例关闭，R0 证据保留，全量单测/集成与独立复核通过。进度审核已确认，下一项仅派第 7 项 |
| 7 | R2：按证据整理运行时（本轮只修取消写闸） | 已验收（2026-09-24，补充返工 `8f9086e` 经进度复核） | Kimi Code 主代理（两轮实现/复核）+ 本轮进度复核 | 原记录 +「R2 Q1 补充返工执行与验收记录」+「R2 补充返工进度验收（2026-09-24）」；[R2 合同](execution-prompts/06-r2-cancellation-gate.md) | C1 两条查询交错、C2 重启恢复、C3 合法 active、C4 相关调用顺序均通过；已记录未证实的取消边界不冒充本票保证 |
| 8 | R1：真实运行验证（纠正 S3 与实验账） | **已验收（2026-09-24；完成轮 3 通过冻结合同，独立复核「pass 合法」）** | 原交付：Kimi Code 主代理；进度复核 + 独立规格审查；无模型返工与三个完成轮：主代理 + 每轮独立冻结检查 + 每轮独立语义复核 + 完成复核子代理 | 原记录 +「R1 补验证（Q4/Q5）执行与验收记录」+「R1 补验证进度审核」+「R1 补验证返工」+「R1 补验证完成轮」；[补验证 prompt](execution-prompts/07-r1-supplemental-validation.md) | 验收成立范围：V1–V4、V6 与完成轮 3 的真实路径通过；V2 `s3-criteria/2` 关闭两处漏验（红/绿反例），V5 ledger 将缓存写和无 usage 请求记为「未报告」，历史下界（≥175461 / ≥58 / ≥501349）保留。完成轮 3 满足 V3：`hitl_ask` 答复逐字送达并被消费、契约不夹带未确认条件、根 run `verified`、产物 719 字节、冻结判据判 `pass / path2-limited-goal`。冻结 fixture 的 `driver.json/run-meta.json` 仍有历史 `cacheWriteTokens: 0` caveat，未来轮次须修自己的 driver 副本，不改写本轮证据；三次生产修复 `99e1311`/`aa19637`/`9a3e508` 均落在根 prompt 与 `task_intake` 说明并由 assembly 用例钉住；完成轮 1、2 的失败原样保留。一次通过只证明该固定场景 |
| 8a | R3：已有 Task 合同归位 | **已验收（2026-09-24，R3-1/2/3 全通过）** | Trae 主代理（实现 + 集成 + 全量检查）+ 1 只读独立复核子代理 | 见「R3：已有 Task 合同归位 执行与验收记录」 | R1 验收后；迁出 Skill/Verifier 行为合同、删除测试专用生产类型，实际调用与测试同步；Task 持久格式、原子提交和执行行为保持，非全仓重构。已满足：迁移前后内容身份一致、task 无 verifier 反向依赖、生产无测试专用类型；下一项为第 9 项 |
| 9 | A2 + A1：Agent 状态上下文（一个交付组） | 待派发；前置已满足、合同已定、未实施 | 待填 | 本文 D/E 节、主 guide §1.4 | R3 验收后；先分开读取与显式恢复，再交付 context 及实际模型消费；依赖证据、根约束与重启/压缩恢复完整，旧渲染删除 |
| 10 | A1 原独立排位 | 并入第 9 项，不单独派发 | — | 保留编号供历史引用 | 第 9 项整组验收后直接进入第 11 项 |
| 11 | A4：父子澄清 | 待前置；合同已定、未实施 | 待填 | 本文 F.1、深入架构 §7 | agent-runtime + DSH 负责持久消息与投递；context 呈现，task-runtime 负责阻塞执行效果；父子/三层、故障恢复与写闸完整 |
| 12 | S4-E：评估基础（S4 内的子票） | 待前置；合同已定、未实施 | 待填 | 本文 S4-E、F.2 | 现有 Evolution 生命周期随本票迁入 evolution 包；单文件 Skill 的可比实验、真实证据与晋升闸，旧 ledger/回滚保留 |
| 13 | A5 + S2-E：诊断与缺口交接（一个交付组） | 待前置；合同已定、未实施 | 待填 | 本文 F.3、深入架构 §8 | agent-singularity/review 按源身份触发只读复盘并保存交接；runtime 结算不等 reviewer；缺口可见与诊断失败恢复完整 |
| 14 | A6 + S2-R + S3：自主改进与恢复（一个交付组） | 待前置；合同已定、未实施 | 待填 | 本文 F.4、S2-R/S3 | evolution 组织有限候选路径，task-runtime 重检并恢复原图；L1/L2、能力/产物缺口、拒绝/重启/回滚均验收 |

状态填写：`待前置 → 待派发 → 进行中 → 待验收 → 已验收`；有未解决缺陷填 `返工`，因外部条件无法继续填 `阻塞` 并记录原因。实现者宣称完成仅进入待验收；“已验收”需要下述完成闸证据。依赖票的状态不能因内部部分提交而提前推进。每次更新本表，同时更新本文对应票据状态及主 guide，记录冲突时先核实证据。

2026-09-24 既有大模块审计后加入 8a，保留原票号与历史记录。R3 是排期中的有限维护票，不是 A2 的功能依赖；保留串行安排以避免同时迁移共享导出，不能扩成“先整理完全部大文件”。其后上下文、通信和诊断迁移仍随各自票交付。已验收的 S1-C/T1/T2/T3 不重开重做，R3 用既有合同回归；R1 已于 2026-09-24 验收，R3 已于同日经进度审核验收（见下方 R3 记录）。

第 9、11–14 项的接口、归属、恢复和验收已在 D/E/F 节固定，不再要求执行者自行选定架构。到达该行时只核对前项实际接口与合同是否一致；一致就填写派发材料，存在具体冲突则修订本处对应合同并说明依据，不能重新泛化选型或削弱验收。私有文件组织、helper 命名及等价实现由执行者决定；改变读取域、写入所有者、候选范围或恢复语义不属于普通实现取舍。

填表起点：P4 三类漏洞修复已提交为 Singularity `f9039a4` / 外层 `b41bf0b`；构建、758 项测试、相关类型及持久化检查通过，详见 P4 修复复核节。该修复尚无另一 agent 的独立复核记录，不能填成“独立复核通过”。T1 的修改前基线为 Singularity `8469388` / 外层 `63c25a14b0`，执行与验收记录见下节；其独立复核由子代理完成（非人类复核），已在记录中注明。

单项记录模板（填入本文相应任务的完成记录；交付组共用一份，逐票列明验收结果）：

```markdown
### <票号/交付组> 执行与验收记录

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 待填 |
| 执行 agent / 任务链接 | 待填 |
| 开始日期 / 验收日期 | 待填 |
| 前置验收记录 | 待填：票号、证据位置、检查结果 |
| 修改前基线 | 待填：Singularity SHA / 外层 SHA |
| 交付版本 | 待填：Singularity SHA / 外层 SHA；未提交就写未提交 |
| 验收项对应 | 待填：验收编号 → 实现入口 → 测试位置与结果 |
| 实际检查 | 待填：命令、结果、测试数量；未运行项及原因 |
| 跨入口/组合反例 | 待填：原失败、修复后结果、合法正例、拒绝副作用检查 |
| 独立复核 | 待填：执行者、被审 SHA、结论、缺陷关闭证据；未做写未做 |
| 文档同步 | 待填：主 guide、计划、相关合同/持久化记录 |
| 模拟与未覆盖范围 | 待填 |
| 未解决缺陷 / 阻塞 | 待填：具体问题、负责方、解除条件；已核实无缺陷才写无 |
| 最终验收结论 | 待填：通过/返工/阻塞，依据及确认者 |
| 下一项 | 待填：唯一顺序中的票号、前置是否满足 |
```

这是一条工程执行顺序，不规定运行中的业务任务图。独立模块可以有明确且完整的有限职责，但不能把它承诺的恢复、错误处置、权限或真实接线推给下一票。暂不支持的对象必须在所有入口显式拒绝，不能有占位成功、静默降级、仅靠 prompt 的限制或需人工补数据才能继续的路径。

每项开始先检查前一项完成记录以及自己消费的接口/测试证据。未完成、部分完成、仅 fixture 通过但真实模块未接线，均不得满足前置。发现前置缺陷，先在该前置范围修复并重验，再继续；不通过新建“后续补齐”条目消除阻塞。交付组可分内部提交，但只有整组验收后才更新完成状态并派发下一项。一次只执行表中一票或一个交付组；指挥 prompt 可覆盖连续几行，但不得越过完成闸。

S1-V 切片 2 不冒充 C3 自然语言完整证明；S4-E 不冒充所有改进对象的执行器。明确不支持的扩展与已支持路径的缺陷要分开记录。真实模型效果实验使用已完成模块和冻结评估入口，记录授权、预算及效果结果；确定性协议测试不能替代效果证据，实验也不能豁免本表完成闸。

派发入口：[执行 prompt 与公共合同](execution-prompts/README.md)。第 6 项 A0、第 7 项 R2 已验收；第 8 项 [R1 补验证](execution-prompts/07-r1-supplemental-validation.md) 经进度审核返工后，已完成无模型修正（判据修订、账目更正、归档轨迹重判）与三个完成轮的真实模型验证，**于 2026-09-24 验收**（完成轮 3 通过冻结合同，独立复核「pass 合法」），见下方「R1 补验证进度审核」「R1 补验证返工」与「R1 补验证完成轮」。第 8a 项 R3（已有 Task 合同归位，有限维护票，合同见 E 节）已于同日**经进度审核验收**（见下方「R3：已有 Task 合同归位 执行与验收记录」）；下一项可派第 9 项 A2+A1 交付组；A2 不因 R1 通过而扩大范围，也不因 R3 排序而获得额外前置。原建设顺序为 A0 + R0 → R1 → R2；因 R2 写闸回归影响真实运行，返工顺序调整为表中的 A0 → R2 → R1。Task 与协作方向仍见 [Task 指导](task-contract-construction-guide.md)、[深入架构](exploration-evolution-architecture.md)与 [Prompt 合同](agent-prompt-contracts.md)。

### 补救交付复核（2026-09-23，d5b0bb6）

结论：机械实现有实质进展，但不能维持「补救全部验收」。主审复核代码、既有测试和 R1 原始 JSONL，另两名只读子代理分别检查 A0 恢复与 R0/R2 实现；未进行真实模型调用。R0 默认工具面、独立根 verifier、marker 顺序及无消费者 API 收回未发现新增反例，保留其交付。

| 编号 | 严重度 / 归属 | 可复核事实 | 关闭条件 |
|---|---|---|---|
| Q1 | P1 / R2 | `task-runtime/src/index.ts:gatePhaseFromStore` 在每次 `runForSession` 查询时回写 gate。`cancelGraph` 已置 terminal、尚未落终态的窗口内，真实 `task_proposal_read` 将闸改回 active；真实 tools 流水线上的 `graph_spawn` 随后获准 | 恢复缺失绑定时补闸，查询不得弱化当前取消/收敛屏障；取消挂起→读取→副作用仍拒绝，且重启 waiting_children 仍受闸保护。不能仅让所有查询失败 |
| Q2 | P2 / A0 | `submitRootProposalOnce` 信任传入 storeId/rootSessionId；临时反例把 `s-beta` 送入 `sg-t-s-alpha`，实际返回 activated。来源测试只核对预先放好的用户消息与同名 session，没有验证来源存在/归属；生产 intake 也不读取来源事件 | **已关闭（2026-09-23 返工）**：统一服务入口校验 store↔session（`rootTaskStoreId`）、会话为顶层会话（`origin: 'subagent'`/`delegationDepth > 0` 拒绝）与本人消息（`user/message` 且 `source.kind === 'user'`，DSH 的人类输入标记；不可读即具名拒绝）；工具与直调的合法/缺失/跨归属反例均有测试。复核另发现本仓自己的 `AgentRuntime.prompt`/`spawn` 曾以 `kind: 'user'` 冒充人类输入（模型可用 setup 提示词激活捏造目标、worker 会话可经直调建根），已改为本运行时自有来源 `runtime-prompt`；收窄为归因纪律，宿主级伪造仍属信任边界（见返工记录「未解决/边界」） |
| Q3 | P2 / A0 | `adoptRoot` 在没有根任务时提前返回，不执行提案 reconcile。批准已存但尚未激活时重开，结果为 adopted=false / approved / 0 task / 0 run；显式补调 reconcile 才激活。现有恢复用例显式调用 reconcile，未覆盖该公共恢复入口 | **已关闭（2026-09-23 返工）**：`adoptRoot` 无根任务时先跑既有 `reconcileStore` 提案遍，再读回并绑定（`ready`/`approved` 激活、`pending_review` 重发、空 store 具名 `adopted:false` 且零写入、已激活幂等、旧图逐字节不变）；`reopen` 夹具改为只经该公共入口，测试不再补调 reconcile |
| Q4 | P1 / R1 | S3 原始根 objective 已写入用户未指定的「最近完成的自然季度」「仅 checkout 来源」，澄清调用失败仍激活；driver 用「有假设且 AC 无数字」当 structuralOnly，最终 verdict 只看 notSilentFabrication，未消费答复一致性。违反 A0 §1.10 的实质歧义先澄清 | 修复 driver 的 live Agent 序列化；判据核对具体季度/来源是否仍未知或确由用户确认，澄清不可用时不激活依赖未知条件的业务目标。测试先拒绝现有轨迹，不能用无数字/写了 Assumption 代替语义检查，也不要求 runtime 理解任意自然语言 |
| Q5 | P2 / R1、文档 | budget.json 的 143978 token / 44 calls 漏了被覆盖的首轮 S1；`3b446cb` 记录该轮为 31483 token / 14 calls（冒烟已在现总数中）。按已存记录合计至少 175461 token / 58 calls，含缓存至少 501349；首次完整日志丢失。多处入口仍称未实施/未提交/未复核 | 历史证据不覆写；另记更正口径与缺失项，不称全量原始证据齐备。新尝试使用独立目录，含失败和意外重跑。当前状态、提交、下一项在入口与指南同步 |

本轮实跑：`pnpm build` 通过；外层 unit 44 文件 / 1453 项、integration 37 文件 / 258 项通过；`pnpm run verify-persistence` 4 根匹配。主审临时集成探针在修正输入 schema/工具参数并使用挂载真实 gate 的 fixture 后，Q1/Q2 均按预期失败（Q1 的 graph_spawn 工具体为 stand-in，真实 gate/tools 流水线决定是否到达它，未创建真实图）；未使用初期夹具错误作缺陷证据，探针验证后删除。Q3 由独立子代理用真实 TaskService/TaskRuntime、内存事件持久层和新 runtime 重开复现；生产 JSONL 回归由返工补齐。未修改生产实现；全绿只能证明现有覆盖，不能覆盖这些新增反例。 文档检查：44 份 Markdown 围栏、100 个本地链接目标、16 份 JSON 解析与 `git diff --check` 通过。

本轮建设粒度：A0 与 R2 Q1 已验收；下一票只执行 R1 Q4/Q5。R1 先交接夹具与判据，再执行一次真实 S3，主代理负责集成、历史账与 guide，不把全部工作压给一个子代理。进度审核本身用[进度审核与下一票派发 prompt](execution-prompts/progress-review-and-dispatch.md)，它只审核与准备材料，不执行代码任务。

### 补救范围与验收合同（原合同保留，当前返工按上表）

**A0 + R0：先使真实目标可执行，并收敛默认运行面。** A0 按[根入口合同](2026-09-23-a0-root-intake-design.md)交付，根验收必须针对用户交付物，不以任意非 composite 命令充数。R0 沿用现有 preset/scoped tools/配置装配：默认 root 不暴露 `evolution_*`，不注入未启用进化协议；显式启用的既有进化路径继续保留真实校验、人审、历史读取与回滚。记录关闭/开启两种实际 composition、工具集及入口；关闭时模型工具与自动触发均不可进入进化，保留人工管理接口须写明授权边界。BB 专用规则移至领域配置，未知角色/配置不得扩大权限。root 仅保留角色原则，具体状态由工具结果说明；语义建议不必全部写成机器闸，权限/状态保证必须有代码支撑。不新建角色平台，不新增自主候选执行器。验收包括实际 assembled prompt/工具集、服务授权边界、正常任务与显式开启进化的既有回归；prompt 字数仅作观测。A0 与 R0 可分内部提交，整组通过才进入 R1。

**R1：直接运行同一实现。** 复用现有 DSH 部署/测试入口及临时仓库，禁止另建 demo runtime 或依赖 S4-E 平台。先固定三个场景：明确的小型工程交付；子判据通过而根交付错误；目标存在会影响验收的歧义。第一项须用真实模型从用户输入经新 intake、分解、执行到独立根验收通过；错误根结果由真实 verifier 拒绝（可确定性注入错误产物）；歧义场景观察模型是否澄清/保留未知，不能假称结构校验能证明语义。off/all 与恢复仍由 A0 的真实模块确定性测试覆盖，不要求收费模型穷举。

运行前记录模型/配置、输入、独立验收、环境、次数及预算；之后记录实际 Task/Run/Evidence/Session 引用、成本、失败轨迹与最终产物。不得只挑成功样例、在看到结果后改判据、以 scripted provider 冒充真实模型。明确交付未通过、错误根被放过或歧义被擅自定为用户要求时，该项返工；修复已有路径后重验，不偷偷实施整个 A1/A4。若确需待建能力，先在本表复定依赖再执行。凭据/运行条件缺失时记录阻塞，不进入 A2 等后续功能（当前 R2 已调整为 R1 前置）。一次通过证明该场景可运行，不证明成功率提升或自进化完成。

R1 本次补验证的有限合同见 [V1–V6 与执行 prompt](execution-prompts/07-r1-supplemental-validation.md)：真实澄清接线、新判据拒绝旧失败轨迹、一次真实 S3、澄清不可用分支的确定性判据测试、全部新尝试留证、历史用量更正。保留原 S3 输入与不完整答复，不把未知季度/来源改成默认值；可继续保留未知，或仅执行用户明确要求的无数据说明。后一路径若宣称交付成功需实际产物与 verifier 证据。材料提前准备，未执行，不更改唯一顺序。

**R2：清理有证据的复杂度。** 消费 R1 轨迹及源码，给出准入、运行推进、工作区归属的职责/调用方映射，选择实际重复迁移或故障路径收敛；正常、replay、恢复复用相同规则，保持公共行为。没有发现值得重构的重复时可保留实现并给出证据，不为减少行数强行拆文件，不预定 pull 化。当前检查项：`evidenceByVerifier` 无生产消费者则撤出无用公共面或明确现有审计用途，不追加召回系统；`templateDigest` 明确仅诊断，若实际消费者依赖执行身份才在挂载处校验实际配置，不能用退出时 registry 复检冒充执行身份；既有历史字段保留兼容读取。

工作区按现有单进程 owner 合同检查并发写/删除 marker 的顺序及恢复结果；唯一临时文件名不证明顺序正确。不支持多进程竞争就明确部署边界，不能声称已有跨进程锁，也不为假想部署新增分布式设施。测试超时根据被等待操作和诊断设置；延长窗口不能替代竞态反例。验收记录实际关闭的缺陷、减少的重复调用规则、公开接口变化、保留边界及对应回归；所有已支持路径的缺陷关闭后才推进。末尾复定 A2 的最小具体合同，后续候选仍按本表顺序。

新增模块、导出、字段、事件或 prompt 保证均在对应交付记录说明当前消费者；审计、展示、恢复可以是消费者。不要新增复杂度台账平台。通过公共入口测试证明行为，测试数量、固定行数上限、重复六次全绿都不是架构验收标准。

| 任务 | 当前状态 | 前置 | 完成边界 |
|---|---|---|---|
| [P1 类型闸](execution-prompts/01-root-agent-typecheck.md) | 已完成（2026-09-21，见 P1 节） | 已满足 | root-agent 严格类型检查零错误，build 实际执行类型检查 |
| [P2 Skill 内容绑定](execution-prompts/02-skill-content-binding.md) | 已完成（2026-09-21，见 P2 节） | P1 验收通过：`agent-singularity` build 为 `tsc --noEmit && tsdown`，类型错误即失败 | 单文件 Skill prepare/replay/审核/apply 内容身份一致；旧记录读取与回滚保留 |
| [P3 生产基线检查](execution-prompts/03-skill-champion-check.md) | 已完成（2026-09-21，见 P3 节） | P2 验收通过：候选内容身份字段、兼容规则与读取/检查入口见 P2 节交接，P3 必须复用该身份语义，不另建摘要体系 | 串行 apply 拒绝过期 Skill 候选，不覆盖变化的生产文件 |
| [P4 独立父验收与证据身份](execution-prompts/04-parent-acceptance-evidence-identity.md) | 原交付有遗漏；本轮三个组合漏洞已修复并回归，见 P4 修复节 | P3 已满足；历史 f6886cf 的全绿记录不能替代本轮反例 | 普通/replay 同检输入；父映射拒绝 heuristic 子判据；插件不能跳过映射；原 P4 合同回归通过 |

T1 不在本表（确定性 prompt 切片）中：它是 Task 自主构造接续组的第一票，执行与验收记录见下方 T1 节。

P1–P4 是构建基础与 S1-V/S1-C/S4 的有限工程切片。P2 不证明证据来源真实，P3 不承诺跨进程原子更新；完成后不将整张 S 票标为完成。

### Task 自主构造交付状态（T1–T3 已验收）

节点已能生成任务实例；本组补统一语言与治理，不能描述为从零新增动态分解。模板是可选参考，模板未命中不阻止生成。Task 生成审核与 Evolution 晋升审核分开，默认 off 的目标策略不改变现有生产能力/权限审批。

| 票据 | 状态 | 前置 | 范围与验收入口 |
|---|---|---|---|
| T1 统一规范化契约 | 已完成（2026-09-21，见 T1 执行与验收记录） | P4 已满足 | Task 字段语义/摘要/持久化、分解与 replay 共用结构校验、handoff 一致；详细指导 §4、§8 T1-A–F |
| T2 可选契约人审 | 已完成（2026-09-23 已验收，与 T3 同组，见「T2+T3：契约审核与恢复 执行与验收记录」） | T1/A3 已满足 | `Config.generatedTaskReview: off/all`（默认 `off`）、不可变提案（整批规范化契约内容 + 策略）、决定绑定三个摘要、批准后重检；`off` 记 `policy-off`、坏提案不弹审批、直接服务调用同受闸 |
| T3 审核恢复与幂等派发 | 已完成（2026-09-23 已验收，与 T2 同组） | T1/A3 已满足；组内复用 T2 | 四个崩溃点（待审 / 批准已保存未准入 / 准入已提交未 spawn / run 已建立）真实 JSONL 重开恢复、requestKey 去重、单父分解竞争、模型协议 fixture；整组已验收，`all` 策略已具备完整恢复保障 |

T1、S1-V 切片 2、S1-C、A3、T2/T3 已交付。根契约入口已实现，A0 来源/恢复返工见 Q2/Q3，R0 证据保留。A1/A2/A4 仍按唯一表在补救关闭后派发。S2/S3 消费已验收的运行、评估与诊断接口，不能用人工补能力替代；T3 审核恢复不等于 S2-R 的能力/产物缺口恢复。

本组文档规划基线：Singularity `7be57a1`，外层 `9f818152bb`；工作区相关修改已在这些提交中保存。本次仅修改文档，P1–P4 的测试结果沿用各自历史记录，不将其算作 T1–T3 验收。

### 全局上下文、协作与 Supervisor 接续票

原设计基线：Singularity `9900959`、外层 `51b6e2f`；DSH `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`。A3 已交付，其他 A 票状态如下；后续施工使用 D/E/F 的冻结合同，不以本文历史设计越过当前完成闸。开源参考见 [一手来源调研](2026-09-21-open-source-agent-patterns.md)。

| 票据 | 状态 | 前置 | 单票完成边界 |
|---|---|---|---|
| A0 真实根契约入口 | 已验收，Q2/Q3 已关闭（2026-09-23）；R0 保留 | T1、S1-V 切片 2、T2/T3 组 | intake、独立 AC、审核/原子激活与未激活视图、统一服务入口来源归属和 adoptRoot 无根提案恢复已交付。模型理解与有效澄清另由 R1 具体场景验证 |
| A2 + A1 状态上下文 | 前置已满足、可派发；同一交付组，见 D/E 节 | A0/A3、S1-C；R1/R2、R3 验收 | context 包组织根/当前契约、贡献、依赖证据与历史引用，接入工具和真实模型请求；读取与恢复分开；压缩/重启能恢复 |
| A3 非阻塞批次与协调相位 | 已完成（2026-09-22，见「A3 执行与验收记录」） | T1、S1-V 切片 2、S1-C | 统一迁移与串行推进、工作区写入归属、显式提交、根预算、取消/恢复及 replay 一致性 |
| A4 父子澄清 | 待前置，合同见 F.1 | A1/A2/A3 | 问题身份与父子授权、持久投递；逐级问答保留批次与写闸；claim 后故障可恢复；未知/部分回答不解除全部阻塞 |
| A5 因果诊断与主管触发 | 待前置，与 S2-E 同组，合同见 F.3 | A1/A2/A4、S4-E | 指定失败 Review 触发、ledger 去重与原预算、Diagnosis 交接；不提前执行候选 |
| A6 自主修复与恢复 | 待前置，与 S2-R/S3 同组，合同见 F.4 | A5/S2-E 组及 S4-E | 有限 capability+Skill 候选实现/评估/应用；原目标新 Run/批次恢复，能力和产物缺口均有验收 |

按本节开头唯一派发顺序执行。A0 使用已完成的 T2/T3，默认 off 仍是用户可选策略，不作为跳过审核协议建设的理由。S4-E 在自动主管和候选链之前完成；各表的前置表达接口依赖，不构成另一套并行派发顺序。

每票同步受影响的角色 Prompt 与工具面，用真实 DSH loop + scripted provider 验证协议；真实模型结果另记。A3 已有状态/事件与协调回归，不重复建设；A4 不假定当前 spawn 可用 DSH continuable send_message；A5 不用 UI 拓扑/时间先后替代证据因果。

以下两段为 2026-09-21 的历史设计交付记录，不表示当前 HEAD 或当前代码状态：

当次交付只有设计/来源/Prompt 文档与排期，未新增运行时代码、配置、事件或部署。文档链接、结构与 diff 检查不代表上述票据已通过运行测试。

本轮备份仍为 `9900959` / `51b6e2f`；收尾时工作区已接续他处提交的 P4 终审文档更新，当前 HEAD 为 Singularity `f6886cf` / 外层 `cf6a4d6314`，这些更新已保留。对本轮 8 份文档的 42 个本地链接及代码围栏检查通过，`git diff --check` 通过；未运行构建、运行时测试或真实模型实验。研究子代理已完成一手来源调研与协议复核，复核后的合同仍须在 A3/A4 用实际运行测试验收。

| 票据 | 状态（按各票交付记录更新） | 依赖 | 交付范围 |
|---|---|---|---|
| S0 | 已完成，验证结果见文末 | 无 | 文档去漂移、术语统一、worker 能力查询 |
| S1-V | 部分：verifier 返回边界校验、父级证据映射、独立父级组合检查与证据身份收紧已建（P4，切片 1+3）；切片 2（verifier 自测执行、裁判版本、受保护输入身份）已完成，见「S1-V 切片 2 执行与验收记录」；剩余 C3 假设满足性完整证明与证据来源真实性认证 | S0 | 可信验收、父级组合检查、有效产物引用 |
| S1-C | 已完成（2026-09-22，见「S1-C 执行与验收记录」）：provider 预检、类型化侧车契约、统一校验四入口、run 内容绑定与 worker 摘要已交付；多 preset 冲突检查（解析期拒绝）与 P2/P3 内容身份保持；skill 晋升执行器单文件边界与效率实验（票后工作）如实记录 | S0 | provider 预检、skill 分类契约、run 解析快照 |
| S2-E | 部分：已有手动 L4 工具与 raised 台账 | 与 A5 同组，前置见唯一顺序 | 缺口记录、诊断与候选交接、例外上报、结构化拒绝；候选执行由 A6 组接入 |
| S2-R | 待建；已有 blocked/obligation 记录 | A5/S2-E、S4-E；与 A6/S3 同组 | agent 补齐后的系统恢复、版本/证据重检、预算与判决处置 |
| S3 | 待建 | A5/S2-E、S4-E；与 A6/S2-R 同组 | L1 组合与 L2 生成，验证、人审应用、恢复一起交付 |
| S4 | 部分：报告自洽、摘要与最低晋升闸已有；P2/P3 已完成 | S4-E 按唯一顺序先于 A5；其他对象另定完整执行合同 | 可比评估、真实证据、结构化 Retro、按对象评价；不以现有闸宣称完整进化 |

旧计划的阶段 1.1/1.2（assumptions/requiresArtifact）、1.4（verifierRef）、3.3（义务记录）已有代码；不重复建设。
旧阶段 1.3 的根时间/run 数预算与无进展停止已由 A3 接线，tools/tokens 仍为软统计；旧阶段 2.2 的可执行 selftest 已由 S1-V 切片 2 交付。四值判决/PARTIAL 处置仍未建；L4 已有工具但无自动处置与恢复闭环，不重复派发已完成部分。
侧车契约从旧阶段 5 前移到 S1-C，避免先生成技能再补“什么算有效技能”的规则。

**实施粒度与人审职责修正（2026-09-21）**：按唯一派发顺序逐项完成，A6/S2-R/S3 作为一个完整交付组建设。Supervisor 诊断、实现候选并组织验证，人类只审核改进与证据，批准后系统应用并恢复。“人工补能力后恢复”不作为完成条件；fixture 用于故障注入，不能替代真实模块接线。依据：细化想法4 §33、KISS §7/§12 第 3 步。不预建完整模板平台，已承诺的能力合同与恢复路径必须完整。

## P1：root-agent 严格类型闸（2026-09-21 已完成）

修改前回退点：Singularity `6fe9c26`（外层 harness `1afb6567`）。基线备份提交：Singularity `c3cf7b3`（提交 prompt 派发文档），外层 harness `1497abcf5`（仅提交对应子模块指针）。

实现范围（只改类型来源与 build 配置，未改业务流程、审批次数、持久化格式或工具输入输出合同）：

- **SessionId 来源**：`agent-singularity/src/tools/` 下 10 个本地 `sessionId(exec)` helper 原先把上游 `Agent.id`（已是 `SessionId`）声明成 `string` 再传给要求 `SessionId` 的服务。改为直接返回上游身份类型 `SessionId`（`@deepseek-ai/dsh-session`），不再抹掉品牌后硬转。身份缺失/为空的拒绝保持不变。落点：`task-read.ts`、`task-status.ts`、`task-verify.ts`、`task-review-pack.ts`、`evolution-gate.ts`、`evolution-prepare.ts`（含 `definitionChampion` 的 `caller`）、`evolution-propose.ts`、`evolution-replay.ts`、`review-agent.ts`、`task-diagnose.ts`。
- **proposal targetType**：`task-diagnose.ts` 的本地 `TARGET_TYPES` 改为标注为 `@dangosys/dsh-singularity-task` 的 `ProposalTargetType`，并新增 `toProposals` 运行时校验（数组、对象、枚举成员、字符串字段），不再把模型字符串断言成合法 targetType；`evolution-propose.ts` 中原有的 `targetType as ProposalTargetType` 断言同样换成真实校验 `isProposalTargetType`。工具 schema 的 `enum` 拒绝在参数边界已经存在，本次补的是 handler 侧的类型正确性。
- **mutation 收窄**：`evolution.ts` 的 `validateMutation` 增加 `asserts mutation is Record<string, unknown>`，把已有的运行时拒绝（`mutation must be an object`）正确表达给 TypeScript；非法输入仍然抛错，行为不变。
- **build 类型闸**：`agent-singularity/package.json` 的 `build` 从 `tsdown` 改为 `tsc --noEmit && tsdown`（沿用 `map` 包的既有写法）。工作区根 `pnpm build` 是 `pnpm -r run build`，因此同样经过该检查。

测试锚：`agent-singularity/tests/unit/task-tools.spec.ts`（task_diagnose 非法 targetType、非数组 proposals、五个工具缺失身份拒绝）、`agent-singularity/tests/unit/evolution.spec.ts`（evolution_propose 非法 targetType、三个 evolution 工具缺失身份拒绝）。既有 mutation 反例测试（`evolution.spec.ts` 的 mutation schemas 组）未改动。

验证（2026-09-21，实际执行）：

1. `packages/singularity` 下 `pnpm build`：通过；日志可见 `agent-singularity build$ tsc --noEmit && tsdown`。
2. 外层 harness 下 `pnpm vitest run --project unit packages/singularity`：25 文件 / 579 项通过（新增 9 项边界测试）。
3. 外层 harness 下 `pnpm vitest run --project integration packages/singularity`：19 文件 / 94 项通过。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`。
5. `packages/singularity` 下 `git diff --check`：通过。
6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误（基线为 12 处）。
7. P1-C 探针：在 `src/evolution.ts` 末尾临时加入 `const typecheckProbe: number = 'invalid'`，`pnpm build` 以退出码 2 失败并报告 `src/evolution.ts(1424,7): error TS2322`；移除后 build 再次成功，探针不在最终 diff 中。

给 P2 的前置条件：构建命令未变（仍从 Singularity 目录 `pnpm build`），但 `agent-singularity` 现在有类型闸；P2 改动该包 src 后必须先过 `tsc --noEmit` 才能打包。测试基线为单测 25 文件 / 579 项、集成 19 文件 / 94 项；P2 新增/修改测试后按同一命令重跑并记录实际数量。S1-C/S4 的局部进度：P1 只修类型来源与 build 闸，不推进候选内容绑定或证据来源校验，这两项仍属 S1-C/S4 待建（G7）。

## P2：单文件 Skill 候选内容绑定（2026-09-21 已完成）

修改前回退点：Singularity `97f3118`（外层 harness `531d85e132`）。基线工作区干净（外层仅 `thirdparty/deepseek-harness` 子模块内有未跟踪文件，未触碰）。

实现范围（只绑定 `targetType: skill` 的单个 `SKILL.md`，未扩展到多文件 Skill、preset、capability、通用内容仓库，也未实现真实证据来源认证、独立 verifier 或 supervisor 调度）：

- **prepare 记录身份**：`evolution.ts` 的 `prepare` 在物化后读回实际写入的 `sandbox/<id>/skills/<name>/SKILL.md`，按精确文件字节（Buffer，无 trim、无换行转换）计算 SHA-256，与 skill 名称一起写入 `prepared` 记录的新可选字段 `skillContent: { name, sha256 }`；重启后 fold 原样恢复。其他 targetType 不携带该字段，fold 对误植字段显式拒绝。
- **报告身份与服务入口检查**：`replay.ts` 的 `ReplayReport` 新增可选 `candidateContent`，`assertReplayReport` 要求 skill 报告必须携带合法形状的身份（其余 targetType 不强制）；`evolution.ts` 的 `replay()` 服务入口校验报告身份与 prepare 记录一致，并在写入 `replayed` 记录前重新读取候选文件复检摘要——执行期间发生并持续存在的修改被拒绝，不留下有效 replayed 状态。
- **工具层前置检查与 overlay**：`tools/evolution-replay.ts` 在执行任何 replay 前调用 `ctx.evolution.readSkillCandidate` 复检候选（普通文件、无符号链接路径、摘要一致）；skill 的 overlay 仍指向沙箱 `skills/` 目录（被检查的同一候选），报告携带 prepare 记录的身份。禁止验证生产 skill 却记录候选摘要。
- **晋升闸复检**：`checkPromotion`（人审前预检、decide(PROMOTE) 服务入口、apply 服务入口共用）对 skill 候选复检内容身份；审批等待期间候选变化由服务入口复检拒绝。
- **apply 读写一致**：`writeProduction` 的 skill apply 分支读取候选字节、校验摘要后写入这同一份已校验字节，不检查路径后重新读路径；回滚仍恢复 champion 快照（按字节读写）。
- **路径与文件类型限制**：新增 `readVerifiedFile`：从 ledger root 逐级 `lstat`，候选路径或其祖先为符号链接、候选不是普通文件（含被换成目录）、文件缺失均明确拒绝；沿用既有 `resolveWithin` 沙箱限制，只使用 Node 标准 fs API。
- **兼容与旧 ledger**：无 `skillContent` 的旧 ledger 可读；旧已应用对象可回滚；旧未应用 Skill 候选在 replay/晋升入口被拒绝，错误提示要求新建候选并重新评估，不静默重算摘要修补旧记录。
- **可观测性**：`evolution_list` 的 prepared 行显示 skill 候选内容身份（短摘要）。

持久化记录：`docs/persistence-changes/2026-09-21-evolution-skill-content.md`（外部 `proposals.jsonl` 新增可选字段，非 SessionEventMap 根，四个事件根指纹不变）。

测试锚：`agent-singularity/tests/unit/evolution.spec.ts` 的 `skill candidate content binding (P2)` 组（P2-A 正向全链路与真实 `evolution_replay` 工具路径 overlay/身份核对、其他 targetType 不携带 skill 字段；P2-B 四个改动时点；P2-C 缺失/目录/文件与祖先符号链接；P2-D 受控 readFile hook 在 apply 完成候选读取后替换源文件；P2-E 缺失/伪造身份的服务入口拒绝；P2-F 重启复检、旧 ledger 读取/回滚/不可晋升、伪造字段 fold 失败；P2-G 人审前预检与审批等待期复检），`tests/integration/evolution-tools.spec.ts`（插件路径下的身份记录、overlay、逐字节生产写入与候选篡改拒绝）。

验证（2026-09-21，实际执行）：

1. `packages/singularity` 下 `pnpm build`：通过；日志可见 `agent-singularity build$ tsc --noEmit && tsdown`。
2. 外层 harness 下 `pnpm vitest run --project unit packages/singularity`：25 文件 / 595 项通过（P2 新增 16 项；`evolution.spec.ts` 由 177 项增至 193 项）。
3. 外层 harness 下 `pnpm vitest run --project integration packages/singularity`：19 文件 / 95 项通过（新增 1 项插件路径候选篡改拒绝）。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`。
5. `packages/singularity` 下 `git diff --check`：通过。
6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误。
7. P2-D 反例探针：临时把 skill apply 改成“校验后重新读路径写入”，P2-D 测试失败（生产收到替换内容）；恢复实现后通过，探针不在最终 diff 中。

给 P3 的前置条件：P2 的身份语义可直接复用——字段 `prepared.skillContent: { name, sha256 }`（可选，仅 skill）、报告字段 `candidateContent`；内容读取/检查入口是 `EvolutionService.readSkillCandidate(proposalId)` 与 `checkPromotion(proposalId)`（内部 `readVerifiedSkillCandidate` / `readVerifiedFile`，从 ledger root 逐级 lstat 拒绝符号链接与非普通文件）。P3 必须复用这套摘要与读取路径，不另建第二套摘要体系；P3 在此基础上补生产基线（champion 与当前生产内容）比对。S1-C/S4 仍为部分完成：P2 只绑定单文件 Skill 候选内容，不证明证据来源真实，也未建分层指标或自动 Retro。

## P3：拒绝覆盖已变化的生产 Skill（2026-09-21 已完成）

修改前回退点：Singularity `4c5308b`（外层 harness `a7df0ce6fd`）。基线工作区干净（外层仅 `thirdparty/deepseek-harness` 子模块内有未跟踪文件，未触碰）。

实现范围（只对 `targetType: skill` 的单个 `SKILL.md` 固定生产基线；未扩展到多文件 Skill、preset、capability，未建全局版本服务，未实现跨进程锁或并发 compare-and-swap，未改 rollback 覆盖策略）：

- **prepare 单次读取**：`evolution.ts` 的 skill `materialize` 分支改为对生产文件做一次校验读取（沿用 P2 的逐级 lstat 语义，从 `skillRoot` 逐级拒绝符号链接与非普通条目），同一份字节既写 champion 快照，也算出 SHA-256 写入 `prepared` 记录的新可选字段 `skillBaseline: { name, sha256 }`；快照与摘要不可能描述两次不同读取。生产文件不存在仍记 `champion: 'missing'` 且不写摘要。`readVerifiedFile` 拆出 `walkVerified`（缺失与类型改变分开上报），`readProductionSkill` 复用它读生产目标。
- **apply 两次复检**：新增 `EvolutionService.checkProductionBaseline(proposalId)`（内部 `assertProductionBaseline`）：`captured` 要求生产目标是普通文件且摘要与 `skillBaseline` 一致，`missing` 要求目标仍不存在；文件缺失、内容不同、类型改变（变成目录）、文件或祖先为符号链接都是冲突。`evolution_apply` 工具在人审前调用它，`EvolutionService.apply` 在 `checkPromotion` 之后、实际写入之前再调用一次，直接调用服务同样经过；`decide(PROMOTE)` 的入口保持 P2 行为不变。
- **冲突处理**：只抛错。不改生产文件、不追加 `applied`、不自动覆盖/merge/更新 champion/改写原 proposal；错误提示统一要求“基于新生产状态创建新候选并重新评估”。原候选、replay 报告与 history 全部保留，P2 候选身份检查与既有 replay 闸不受影响。
- **可观测性**：`evolution_prepare` 输出生产基线短摘要；`evolution_list` 的 prepared 行同时显示候选内容身份与生产基线身份。
- **兼容与旧 ledger**：无 `skillBaseline` 的旧 ledger 可读、旧已应用对象可回滚；`captured` 但没有基线摘要的旧未应用候选拒绝新 apply（不默认匹配），`champion: 'missing'` 的旧候选仅在目标仍不存在时可应用。fold 对误植到非 skill 的 `skillBaseline` 和畸形摘要显式拒绝。

持久化记录：`docs/persistence-changes/2026-09-21-evolution-skill-baseline.md`（外部 `proposals.jsonl` 新增可选字段，非 SessionEventMap 根，四个事件根指纹不变）。

测试锚：`agent-singularity/tests/unit/evolution.spec.ts` 的 `production baseline check (P3)` 组（P3-A 未变基线全链路；P3-B 修改/删除后用 it.each 覆盖工具预检与直接服务调用；P3-C missing 后出现文件被拒、仍缺失可应用；P3-D 目录/文件符号链接/祖先符号链接三类拒绝且链接目标不被写；P3-E 两个同 champion 候选串行 apply，第二个被拒且只烧一次审批；P3-F 人审前基线已变不弹审批、审批等待期用可控 promise 改基线后批准仍被复检拒绝；P3-G 重启复检、P2 内容变化负例、rollback 覆盖语义不变、无基线字段的旧 ledger 拒绝/可按 missing 应用、伪造字段 fold 失败），`tests/integration/evolution-tools.spec.ts`（插件路径下生产基线记录、拒绝时不弹审批、ledger 无 applied）。

验证（2026-09-21，实际执行）：

1. `packages/singularity` 下 `pnpm build`：通过；日志可见 `agent-singularity build$ tsc --noEmit && tsdown`。
2. 外层 harness 下 `pnpm vitest run --project unit packages/singularity`：25 文件 / 609 项通过（P3 新增 14 项；`evolution.spec.ts` 由 193 项增至 207 项）。
3. 外层 harness 下 `pnpm vitest run --project integration packages/singularity`：19 文件 / 96 项通过（新增 1 项插件路径生产基线拒绝）。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`。
5. `packages/singularity` 下 `git diff --check`：通过。
6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误。
7. P3 反例探针：临时让 `assertProductionBaseline` 直接返回，单测 10 项 P3 冲突用例失败（P3-B×2、P3-C、P3-D、P3-E、P3-F×2、P3-G 重启、P3-G 旧 ledger×2），恢复实现后全部通过；探针不在最终 diff 中。

给下一批的前置条件：P3 只固定“串行调用之间生产基线没变”，不实现跨进程锁、并发 CAS 或任意外部写入者与 apply 同时写的原子性；rollback 覆盖策略保持原状。S1-C/S4 仍为部分完成：真实 run/evidence 来源绑定、preset 沙箱执行、分层指标与自动 Retro 均未建，不因 P1–P3 通过而宣称完整自进化框架已完成。

下一批仍待固定的合同（本票未开始实现）：

1. **真实 run/evidence 来源绑定**（S1-C / S4）：replay 固定 manifest/run/evidence 身份，报告自洽但来源伪造仍是反例；apply 写入同一版本。
2. **preset 沙箱执行**（S1-C / S3）：补 agent_preset 沙箱解析/执行器，解除 manual replay 的当前阻塞，而不是绕过验证。
3. **独立父验收**（S1-V）：父 AC → 子证据映射、独立组合判据、区分原始输入与要求已验证的产物。P4 已完成其最小机械版（见 P4 节）：映射存在性与 verified 来源、独立组合检查（映射断言 + 父级 command）、`acceptsArtifact`/`requiresArtifact` 分离；剩余 C3 假设满足性完整证明、verifier selftest 正负样本执行（切片 2）、验收输入来源固定。
4. **supervisor/blocked 恢复**（S2-E / S2-R / S3）：gap 身份与解决事件、supervisor 自主实现并验证候选、人审后系统恢复受阻分支。

## P4：独立父验收与证据身份（2026-09-21 已完成）

修改前回退点：Singularity `05cb27c`（外层 harness `c198457d56`）。基线工作区干净；基线备份提交：Singularity `53b9831`（提交 P4 执行 prompt 派发入口），外层 harness `4bd9c42`（仅提交对应子模块指针）。

实现范围（只做 KISS §6 C2/C4 的最小机械版与 §5.1 的证据身份区分；未做通用自然语言蕴含求解器、C3 完整证明、verifier 四值语义、preset/MCP/skill 预检、verifier selftest 执行）：

- **父 AC 证据映射（C2）**：`AcceptanceCriterion` 新增可选 `childEvidence?: ChildEvidenceRef[]`——`{ childIndex, criterionId?, evidenceRef? }`，子任务按分解 batch 位置（0 基，与 `dependsOn` 同一索引词汇，这是父 AC 作者在子任务 id 产生前唯一稳定的子任务身份）指向，可窄化到子判据与证据引用（evidence id / artifact kind / artifact id 三种拼写）。composite 在父验收期对照 store 校验：子任务存在且 verified、指名判据在其 verified run 的 evidence 中有 pass 判决、指名引用在该 evidence 中存在；任一条不满足即 fail 并逐字点名缺失项。无映射（或空映射）保持现行“子全 verified”合取，旧任务零行为变化。
- **独立父级组合检查（C4）**：两条可机械执行的形式——映射断言本身，以及父 AC 的确定性 `command`（真实 CommandVerifier 执行，接口/数值级判据）。子全 verified 但组合接口错误时父拒绝。`heuristic?: boolean` 标记的父 AC 为自然语言条款：composite 的合取 verdict 带显式 heuristic 标注，`unmetMandatory` 永不把 heuristic 判据算作确定性通过。
- **证据身份（切片 3）**：`requiresArtifact` 收紧为“已验证参考产物”——产出 run 终态 verified 且 bundle 带 pass 判据，失败/在跑 run 的同名产物不再满足；新增 `acceptsArtifact?: string[]` 表达原始输入（存在即可，任意 run 状态），即 P4 前 `requiresArtifact` 的语义。spawn 期 blocked reason 与 Obligation 文本区分两种声明。产物已在且验证通过的合法跳过保持不变。
- **契约级标记与 admission**：`TaskInstance.requiresIndependentAcceptance?: boolean`（经 `DecomposeChildSpec.requiresIndependentAcceptance` 声明）要求至少一条 AC 带非空映射，否则新建/分解路径 admission 响亮拒绝，不静默降级为合取；`admission.ts` 新增共享纯函数 `independentAcceptanceDefects`（形状校验 + 标记规则 + heuristic/映射互斥 + 映射要求 composite 模式），普通分解与 replay 路径共用。`normalizeCriteria` 透传全部新字段；`replayTask` 对契约执行同一校验并携带标记。
- **模型声明面**：`task_decompose` 工具 schema 增加 `acceptsArtifact` / `childEvidence` / `heuristic` / `requiresIndependentAcceptance` 可选属性（全部可选，缺省行为不变）。
- **兼容与旧 ledger**：新字段全部可选；reducer 原样拷贝载荷、不校验新字段；旧任务读取、回放、验收行为不变；`requiresArtifact` 收紧对旧声明同样生效（失败 run 同名产物不再满足依赖），这是修复点。

持久化记录：`docs/persistence-changes/2026-09-21-parent-acceptance-evidence-identity.md`（`task/event` 载荷内传递引用的类型新增可选字段，非 SessionEventMap 根，四个事件根指纹不变）。

测试锚：`verifier/tests/unit/composite-verifier.spec.ts` 的 `CompositeVerifier parent evidence map (P4, KISS §6 C2)` 组（P4-A 完整映射通过并列名所验项、evidenceRef 三种拼写；P4-B 判据缺失/引用缺失/越界/无 pass 判决逐一点名；P4-C 失败 run 的同名产物不满足、verified run 满足；无子任务+映射拒绝而不退化为合取；heuristic 标注）；`task-runtime/tests/unit/admission.spec.ts` 的 `checkDecomposition parent acceptance declarations (P4, KISS §6 C2)` 组（形状拒绝、marker 缺映射拒绝、空映射拒绝、heuristic 与映射互斥、父级标记复查）；`task-runtime/tests/unit/orchestrate.spec.ts` 的 `TaskRuntime parent acceptance and evidence identity (P4)` 组与改写后的 W27 合法跳过用例（P4-A/P4-B 经真实 cascade + 真实 CompositeVerifier；P4-C 失败产物 blocked+Obligation、verified 产物放行、acceptsArtifact 原始输入；P4-D heuristic 不计确定性通过且同形状无标记照过；P4-E admission 拒绝且零落库）；`packages/singularity/tests/integration/parent-acceptance.spec.ts`（真实 TaskService + TaskRuntime + VerifierRegistry 全链：P4-A 映射+组合 command 双通过、P4-D 组合 command 失败拒父、P4-B 点名缺失判据、P4-C 失败/verified 产物两态、replay 与普通分解共用准入规则；断言全部读回持久化事件日志）。

验证（2026-09-21，实际执行）：

1. `packages/singularity` 下 `pnpm build`：通过；日志可见 `agent-singularity build$ tsc --noEmit && tsdown`。
2. 外层 harness 下 `pnpm vitest run --project unit packages/singularity`：25 文件 / 636 项通过（P4 新增 27 项；`composite-verifier.spec.ts` 5→14、`admission.spec.ts` 23→33、`orchestrate.spec.ts` 68→76；基线 609 项）。
3. 外层 harness 下 `pnpm vitest run --project integration packages/singularity`：20 文件 / 103 项通过（新增 `tests/integration/parent-acceptance.spec.ts` 7 项）。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`（digest 未变，按纪律以记录备案）。
5. `packages/singularity` 下 `git diff --check`：通过。
6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误。
7. 反例先红后绿：实现前新测试按预期失败（composite 8 项、admission 8 项、orchestrate 5 项、integration 6 项），实现后全部通过。
8. 第 3 轮终审复核（2026-09-21，独立只读重跑 + 1 处变异复跑，代码零改动）：`pnpm build` 通过；单测 25 文件 / 636 项、集成 20 文件 / 103 项、`verify-persistence`（4 个事件根指纹匹配）、`git diff --check`、`agent-singularity` 的 `pnpm exec tsc --noEmit`（0 错误）全部复现。变异复跑点为 `orchestrate.ts:unmetMandatory` 的 heuristic 闸门（第 2 轮未做过的点）：临时禁用后 `orchestrate.spec.ts` 的 P4-D 用例精确失败（期望 `failed`、实测 `verified`，仅该 1 项红），恢复后同文件 76 项全绿——确定性通过锚真实绑定“heuristic 不计入闭包”的行为。

给下一批的前置条件：P4 只做最小机械版——映射按 batch 位置指向（父 AC 作者在子 id 产生前唯一稳定的身份），C3 假设满足性完整证明、通用自然语言蕴含、verifier selftest 正负样本执行（S1-V 切片 2）、验收输入来源固定均未建；`requiresArtifact` 收紧后，依赖“任意 run 状态产物”的旧声明改用 `acceptsArtifact`；blocked 仍无恢复出边（S2-R）。不因 P4 通过宣称独立父验收全部完成。

已知边界（如实记录，不当作兼容性缺口）：(1) 真实链子上 `TaskRun.artifacts` 恒空——该类型没有写入方（见 `task/src/types.ts` 中 `ReviewMetrics` 的同类说明），因此 `childEvidence.evidenceRef` 的三种拼写只匹配 `EvidenceBundle` 的 evidence id / artifact kind / artifact id，匹配不依赖也不读取 `TaskRun.artifacts`。(2) replay 任务按设计无父无子，携带 `childEvidence` 映射的候选契约在验收期失败关闭（`tests/integration/parent-acceptance.spec.ts` 的 replay 用例固化该行为）：当前 replay 路径不存在“能通过”的父级映射表达，这是范围边界而非待修缺陷。(3) `entryDefect` 的逐条目 `child.status !== 'verified'` 分支在当前调用路径下不可达：`judge` 的合取闸门已先行拒绝任一未验证子任务，映射判定只在全部子任务 verified 之后执行；该分支是防御性保留（函数自包含），不构成额外行为，未验证子任务由合取闸门的用例覆盖。

## P4 修复复核（2026-09-21）

修改前备份：Singularity `ff259e0`，外层 `e658595`，保存上一轮建设指导。`f6886cf` 的“完成”经独立审查发现三类错误通过，历史记录保留但不再作为这些路径已正确的依据。

- `runReplayTask` 在建立 Task/Run 和执行 verifier/worker 之前复用 `missingRequiredArtifacts`。缺输入抛出带引用/判据的错误，零 Task 事件与零派发；普通分解仍 blocked + Obligation，两者输入资格规则相同，调用结果按原接口处理。
- `CompositeVerifier.entryDefect` 检查所引用子判据的 heuristic 标记，拒绝以其 pass 关闭父机械判据；合法的可选非 heuristic 子判据仍可引用。
- `VerifierRegistry.verifyCriterion` 在自定义 verifier 前执行内建映射检查。默认模式覆盖和显式 verifierRef 都不能跳过；映射合法后仍调用所选 verifier，其 fail 不能被内建映射 pass 覆盖。
- 持久化载荷/schema 未改，旧事件正常读取、不改写已有终态；对旧契约的新执行/重新验收采用修复后的规则。未补通用来源认证、产物版本适用性或父子树 replay，这些仍按原票记录。

测试锚：`tests/integration/parent-acceptance.spec.ts` 新增 19 项组合测试，覆盖 heuristic 正反例、自定义 verifier 两种选择方式及自身拒绝、两类输入 × spawn 开关 × 缺失/failed/verified producer。使用真实 TaskService/TaskRuntime/VerifierRegistry，模拟会话持久化和 agent handle，不调用真实模型。修复前 9 项按误判通过的预期失败；修复后该文件 26 项全部通过。拒绝断言检查事件数量及派发数量，正常验收结果读回 evidence/Task 状态。

本轮实跑：`pnpm build` 通过（仅已有前端体积提示）；外层 `pnpm vitest run --project unit packages/singularity --project integration packages/singularity` 通过，45 文件 / 758 项（原 739 + 19）；`pnpm run verify-persistence` 的 4 个事件根匹配；verifier 和 agent-singularity 各执行 `pnpm exec tsc --noEmit`，均通过；`git diff --check` 通过。未部署、未跑真实 LLM/BB 仿真，本轮修复未声称已经过另一 agent 独立复核。

公共执行合同补入“构建与复核质量 Prompt”，要求跨入口/跨层组合测试和完整性证据。下一项仍按文首顺序派发 T1；本次修复不算 T1 或 S1-V 切片 2 完成。

## T1：统一规范化契约 执行与验收记录（2026-09-21）

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 已验收（2026-09-21；完成闸证据见下，独立复核为子代理只读复核，未由人类复核） |
| 执行 agent / 任务链接 | Kimi Code 主代理执行；4 个实现/测试子代理 + 1 个只读复核子代理 + 1 个复核修复子代理（详见下） |
| 开始日期 / 验收日期 | 2026-09-21 / 2026-09-21 |
| 前置验收记录 | P4：Singularity `f9039a4` / 外层 `b41bf0b`，见 P4 修复复核节。本票开始前复核：该提交在树上，`pnpm build` 通过，单测 25 文件 / 636 项、集成 20 文件 / 122 项全绿（合计 758，与 P4 记录一致），`verify-persistence` 4 根匹配——前置成立，未发现阻断 T1 的前置缺陷 |
| 修改前基线 | Singularity `8469388`（外层 `63c25a14b0`）：先提交了工作区中尚未提交的 P4 修复文档（dispatch 填表入口），再在外层仅同步子模块指针；第三方 DSH 子模块的未跟踪文件保持原样 |
| 交付版本 | 未提交（本票结束时代码与文档仍在工作区；提交由派发方决定） |
| 验收项对应 | T1-A → `task_decompose` 工具 / `TaskRuntime.decomposeAndRun` → `tests/integration/task-contract.spec.ts`；T1-B → `normalizeDecomposition` + `contractDefects` → integration 的 8 例拒绝表 + `normalize.spec.ts` + `admission.spec.ts`；T1-C → `canonicalize`/`contractDigest`/`decompositionDigest` → `task/tests/unit/contract.spec.ts`（固定向量）+ `normalize.spec.ts`；T1-D → `TaskInstance.contract` / `HandoffCreated` / `task_read` / `state.assertContract` → integration T1-D + `orchestrate.spec.ts`（重开 store）+ `task-tools.spec.ts` + `task-state.spec.ts`；T1-E → `checkDecomposition` + `admissionContext()` → 既有 admission/orchestrate 用例 + integration T1-E；T1-F → 下方实跑与文档同步 |
| 实际检查 | `pnpm build`（packages/singularity）通过；外层 `pnpm vitest run --project unit packages/singularity` 27 文件 / 713 项通过；`--project integration packages/singularity` 21 文件 / 138 项通过（基线 706/138 与 636/122 对比见下）；`pnpm run verify-persistence` OK（4 个事件根指纹未变，新增记录 `docs/persistence-changes/2026-09-21-task-contract-normalization.md`）；`git diff --check` 通过；`pnpm exec tsc --noEmit`：`task` 0、`agent-singularity` 0、`task-runtime` 8 处既有诊断（G9，均在本票 diff 之外，基线核对方式见独立复核） |
| 跨入口/组合反例 | 未知字段 / 未知版本 / 重复显式 criterion id / 全 optional / 非法 mode：先复现失败再修复（`normalize.spec.ts` 首跑 0 加载失败、`admission.spec.ts` 10 红、`orchestrate.spec.ts` 5 红）；合法正例：同批合法契约全链 verified、`acceptsArtifact` 原始输入与 verified 参考产物两态、P4 映射+heuristic 用例保持原状。拒绝路径断言零事件、零任务、零派发；结论从 store/事件日志读回（`task-contract.spec.ts`）。复核新发现的三处缺陷已修复并回归：replay 未共享 `contractDefects` 且无测试（补 4 项，含把该调用注释掉后 2 项转红的变异证据）、replay 的 handoff 渲染与 store 视图不一致（补 1 项）、`mode: null` 被静默默认（补 2 项） |
| 独立复核 | 子代理（只读复核 + 9 组变异探针 + 自建反例），被审快照 = 本记录对应的未提交工作区；结论：实现与测试基本成立，报出 D1–D9（D1/D2 文档矛盾、D3 lib/src 解析边界、D4/D5/D7/D8 已修复、D6/D9 记为边界/后续票）。修复后未再重跑该复核；修复项自带先红后绿证据 |
| 文档同步 | 主 guide §5.6 + §2.2/§3/§4.1/§4.2（G10）；本计划 T1 节与两张表；`task-contract-construction-guide.md`（状态、锚点、§8 T1 标记、§4 实现范围）；`agent-prompt-contracts.md:147`（assumptions/constraints 两视图一致的反例）；`docs/persistence-changes/2026-09-21-task-contract-normalization.md` + 对应 `.schema.json` |
| 模拟与未覆盖范围 | 未调用真实模型、未跑 BB 仿真、未部署、未推送。集成测试的 sessionPersistence 是内存假件（JSON 往返），真实 JSONL 写入与崩溃重启未验；`AdmissionContext` 的硬限制只被“记录值 = 配置值”与既有准入用例覆盖，5s wallTimeMs 到期未触发；root 契约由常量展开、未再经独立校验；task-runtime 单测经 `task/lib` 解析 task 包（先 build 再测的既有纪律）；集成 spec 无 tsconfig 类型闸（仓库既有状况）；`admission.context` 上下文指纹未建（T2） |
| 未解决缺陷 / 阻塞 | 无未解决的本票缺陷。范围外边界如实保留：契约上下文指纹与提案状态机（T2/T3）、`childEvidence` 索引范围/蕴含（T2 及后续）、blocked 恢复（S2-R）、reducer 不重复结构性规则、集成 spec 类型闸缺失（G9） |
| 最终验收结论 | 通过（依据：上述实跑命令、先红后绿反例、独立复核报告与其修复回归；确认者：执行代理 + 独立复核子代理，未由人类验收） |
| 下一项 | 唯一顺序第 2 项 S1-V 切片 2（验证器自测与输入身份）：前置为 P4 组合验收回归通过——本票已回归 `tests/integration/parent-acceptance.spec.ts` 26 项与 verifier 单测，前置满足 |

实现范围（只做 §4 规范化字段、身份算法与新实例持久化，普通分解/replay 的适用结构校验与 handoff 一致性；未做模板库、审批开关、状态机、恢复调度与父验收重做）：

- **契约数据定义**：`task/src/contract.ts` 的 `TaskContract`（`contractVersion`、`objective`、`acceptanceCriteria`、`assumptions`、`constraints`、`requiredCapabilities`）、`AdmissionContext`、`DecompositionAdmission`、`canonicalize`/`contractDigest`/`decompositionDigest`。`TaskInstance.contract` 可选；`objective`/`acceptanceCriteria`/`requestedCapabilities` 为其投影，`state.ts:assertContract` 用 `canonicalize` 比对并拒绝不一致的新事件；旧任务缺字段读取、验收、回放行为不变。
- **唯一入口**：`task-runtime/src/normalize.ts:normalizeDecomposition`（三层闭合字段集、未知版本拒绝、空白校验不重写文本、criterion id 固定与重复拒绝、默认值、批次摘要、深拷贝）。拒绝一次返回全部原因且发生在铸 id/查能力/落库之前。
- **准入与持久化**：`decomposeAndRun` 先规范化，再把 `admission`（`proposalDigest` + 生效限额）写入父任务 `TaskDecomposed`，子任务携带 `contract`；`createRootTask` 与 `replayTask` 同样构造契约；replay 与普通分解共用 `contractDefects`，P4 规则不变（父任务契约不被重新审判）。
- **handoff 与渲染**：`ChildPlan.constraints` 进入 `buildHandoff`，assumptions/constraints 与 store 契约同源；worker 契约块与 `task_read` 从同一份契约渲染；replay 的 in-memory handoff 也带同一份声明（复核修复）。
- **工具面**：`task_decompose` 增加可选 `contractVersion`/判据级 `criterionId`/子任务级 `constraints`，调用者的整个批次对象交给 runtime 点名拒绝未声明字段；schema 仍校验自己的声明面。

测试锚：`task/tests/unit/contract.spec.ts`（固定向量 + 规范化 + 摘要敏感度）、`task/tests/unit/task-state.spec.ts`（reducer 契约/准入记录规则）、`task-runtime/tests/unit/normalize.spec.ts`、`task-runtime/tests/unit/admission.spec.ts`（`contractDefects`）、`task-runtime/tests/unit/orchestrate.spec.ts`（真实 TaskRuntime+TaskService：契约落库读回、重开 store、准入上下文、拒绝零副作用、handoff 一致、提案摘要重试稳定、replay 结构规则与契约）、`agent-singularity/tests/unit/task-tools.spec.ts`（工具 schema 与 `task_read` 渲染）、`tests/integration/task-contract.spec.ts`（真实 TaskService+TaskRuntime+VerifierRegistry，含真实 `task_decompose` 工具路径、8 例拒绝、重开 store、legacy 任务、配置限额记录）。

实跑命令与结果（2026-09-21，按公共执行合同顺序）：

1. `packages/singularity` 下 `pnpm build`：通过（`agent-singularity build$ tsc --noEmit && tsdown`）。
2. 外层 `pnpm vitest run --project unit packages/singularity`：27 文件 / 713 项通过（基线 25 / 636）。
3. 外层 `pnpm vitest run --project integration packages/singularity`：21 文件 / 138 项通过（基线 20 / 122）。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配（`task/event` 载荷类型文本未变，故未 `--write`，只按纪律加记录）。
5. `packages/singularity` 下 `git diff --check`：通过。
6. 各包 `pnpm exec tsc --noEmit`：`task` 0、`agent-singularity` 0（P1 闸保持 0）、`task-runtime` 8 处既有诊断（G9；独立复核用 `8469388` 检出与临时替换对照确认同源，且行号均在 T1 diff 之外）。
7. 反例先红后绿：实现前 `normalize.spec.ts` 无法加载（0 项）、`admission.spec.ts` 10 红、`orchestrate.spec.ts` 5 红；实现后全绿。复核修复轮先红后绿 7 项（normalize 1、admission 1、orchestrate 5），其中 replay 共用规则的移除使 2 项转红。
8. 未运行：真实 LLM、BB 构建/仿真、生产 Evolution、部署与推送。

接口交接（给 S1-V 切片 2 与 T2/T3）：契约类型从 `@dangosys/dsh-singularity-task` 导出（`TaskContract`/`AdmissionContext`/`DecompositionAdmission`/`contractDigest`/`decompositionDigest`/`canonicalize`）；批次身份读自父任务 `TaskDecomposed.payload.admission`（`proposalDigest`，含 store/parentTask/parentRun/caller/reason 与完整有序 children；不含准入铸的 id）；结构规则 `contractDefects(criteria, label)` 与形状规则 `independentAcceptanceDefects` 分别可复用；T2 需补的是准入上下文指纹、提案存储/状态机与批准后重检，T3 需补 requestKey 与崩溃恢复，本票不提供这两者。

## S1-V 切片 2：验证器自测与输入身份 执行与验收记录（2026-09-21 / 22）

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 已验收（2026-09-22；独立复核为子代理只读 + 变异复核，未由人类复核） |
| 执行 agent / 任务链接 | Kimi Code 主代理执行；2 个实现/测试子代理（verifier 包；task-runtime + 工具面）、1 个集成子代理、1 个渲染跟进子代理、1 个只读复核子代理、1 个复核修复子代理（后两个为 resumed 会话） |
| 开始日期 / 验收日期 | 2026-09-21 / 2026-09-22（工作跨零点，记录与文件名按实际时刻标注） |
| 前置验收记录 | T1：本票开始前把工作区中未提交的 T1 交付提交为 Singularity `741dcb2`（见 T1 节）。进入条件「P4 组合验收回归通过」实跑复核（修改前）：`verifier` 单测 3 文件 / 49 项、`tests/integration/parent-acceptance.spec.ts` 26 项通过；全量基线单测 27 文件 / 713 项、集成 21 文件 / 138 项通过；T1 的 `TaskContract`/`normalizeDecomposition`/`contractDefects`、P4 的父验收与产物依赖规则、verifier 现有 selftest/version/owner 事实逐项在源码核对——前置成立，未发现阻断本票的前置缺陷 |
| 修改前基线 | Singularity `741dcb2`（T1 交付提交），外层 harness `f8839133e1`（仅同步子模块指针；第三方 DSH 子模块未跟踪文件保持原样） |
| 交付版本 | 未提交（本票结束时代码与文档仍在工作区；提交由派发方决定） |
| 验收项对应 | V2-1 → `verifier/src/index.ts:selftestGate/executeSamples` + 三个内建的 `selftest.samples` → `verifier/tests/unit/{verifier-registry,composite,command}-verifier.spec.ts`；V2-2 → `register`/`ready`/`[Service.init]`（唯一替换路径）与显式 `{ testDouble: true }` → 同文件 + `tests/integration/verifier-selftest-inputs.spec.ts`；V2-3 → `stampVersion`/`claim`/`evidenceByVerifier` + `ReviewCriterion` → verifier 单测、集成、`task-runtime/tests/unit/review-record.spec.ts`；V2-4 → `task-runtime/src/protected-inputs.ts`（准入固定）+ `verifier/src/protected-inputs.ts`（判决前复检）→ `task-runtime/tests/unit/protected-inputs.spec.ts` + 集成反例；V2-5 → P4 与 verifier 全量回归（见实际检查）；V2-6 → 下方实跑与文档同步 |
| 实际检查 | `pnpm build`（packages/singularity，日志含 `agent-singularity build$ tsc --noEmit && tsdown`）通过；外层 `pnpm vitest run --project unit packages/singularity` 28 文件 / 775 项通过（基线 27 / 713，D1 修复后为 28 / 777）；`--project integration packages/singularity` 22 文件 / 145 项通过（基线 21 / 138）；`pnpm run verify-persistence` OK（4 个事件根指纹未变，新增记录 `docs/persistence-changes/2026-09-21-verifier-selftest-protected-inputs.md`，未 `--write`）；`git diff --check` 通过；各包 `pnpm exec tsc --noEmit`：`task` 0、`verifier` 0、`agent-singularity` 0、`task-runtime` 8 处既有 G9 诊断（复核子代理按行号是否落在 diff 之外 + 基线类别比对核实同源） |
| 跨入口/组合反例 | 先红后绿：注册闸改造前 verifier 单测 52 红 / 23 绿（`ready`/`samples` 不存在）、task-runtime 受保护输入改造前 25 红（`protectedInputs` 被当未知字段拒绝）、渲染 4 红。独立复核 5 组变异：M1 关闭判决前复检 → 集成反例转红（子任务被判 verified，本应 failed——错误产物被判 PASS）；M2 关闭漏检拒绝 → 永远返回 pass 的裁判被注册；M3 采信插件自报版本 → 单测 2 红；M4 准入 fixing 置空 → 单测 8 红、集成 4 红；M5 索引忽略版本过滤 → 单测 2 红、集成 1 红；探针全部哈希证明还原。集成正反例：worker 改写受保护脚本 → 子任务 failed、点名路径与两个摘要、无 exitCode/logRef、无派发痕迹；合法正例（脚本未动、产物真实通过）→ verified 且 claim 带 `command@1`；未声明保护范围 → 改写脚本仍通过、事件日志无受保护输入文本（边界如实固化）；声明读不到 → 整批拒绝零事件零派发；畸形 store 声明（D1）先红（TypeError）后绿（点名条目的可读 fail 且不派发）。拒绝路径断言无 spawn、无证据落库、无成功状态 |
| 独立复核 | 子代理（只读复核 + 5 组变异探针 + 5 个自建反例探针，临时文件删除、源码哈希证明还原）；结论：V2-1–V2-5 在实际执行与对抗性探针下成立，未能在受支持路径上击穿注册闸、受保护输入闸、版本记录或索引。发现 D1（畸形 `protectedInputs` 直写 store 绕过准入时判决前复检崩溃而非可读 fail；低危、fail-closed、仅绕过路径可达）、D2（复核时计划记录与表未同步——本记录即修复）、D3（guide §4.1 版本归属措辞不精确）、D4（testDouble 警告依赖 logger 的说明）；D1 已修复并补 2 个反例（verifier 单测 76→78），D3/D4 已按措辞修正。修复后未再重跑该复核 |
| 文档同步 | 主 guide §4.1「Verifier 边界」、§4.2 G1、§3 状态行、§5.1 范围边界、新增 §5.7（范围/源码/测试锚/未覆盖）；本计划本记录与两张表；`task-contract-construction-guide.md` §4（`protectedInputs` 行 + 来源说明）；`agent-prompt-contracts.md` §7 反例清单与真实模型测量段；`execution-prompts/README.md` 状态与下一项；`docs/persistence-changes/2026-09-21-verifier-selftest-protected-inputs.md` + 同名 `.schema.json`（same-version，根指纹未动，实跑确认） |
| 模拟与未覆盖范围 | 未调用真实模型、未跑 BB 仿真、未部署、未推送。未建：KISS §8.2 裁决召回（`evidenceByVerifier` 只是可查询索引，降级/重验未建）、证据来源真实性认证、verifier 与执行者的独立性隔离、自测样本“有意义”的证明、`targetType: verifier` 的 Evolution 机械执行器（仍显式拒绝）；replay × 受保护输入的端到端集成未覆盖（该路径由 `task-runtime/tests/unit/protected-inputs.spec.ts` 单测覆盖）；集成未覆盖“插件伪造 `verifierVersion` 被覆盖”（verifier 单测覆盖，变异 M3 证明单测能抓住）；`verifierIds()` 在未 ready 的手工构造上下文为空（生产由 `Service.init` 覆盖，测试显式 `await ready()`）；任务契约的 `AdmissionContext` 指纹仍属 T2 |
| 未解决缺陷 / 阻塞 | 无未解决的本票缺陷。复核 D1 已修复并回归；范围外边界如实保留（见上一行），不改称已认证/已保护 |
| 最终验收结论 | 通过（依据：上述实跑命令、先红后绿反例、独立复核报告及其 D1 修复回归；确认者：执行代理 + 独立复核子代理，未由人类验收） |
| 下一项 | 唯一顺序第 3 项 S1-C（能力预检与版本绑定）：前置为本票验收与 T1，均已满足。S1-C 应复用本票接口：`VerifierSelftest`/`register`/`ready`（注册闸，测试替身必须显式声明）、`protectedInputs` 的准入固定与 registry 复检、`evidenceByVerifier` 索引；S1-C 自己交付 provider 预检、类型化侧车契约与 run 解析快照，不把“统一校验入口”提前到本票，也不重做切片 1/3 的父级映射与产物依赖语义 |

实现范围（只做 S1-V 切片 2；父级验收与证据依赖由 P4 交付，不重做）：

- **可执行自测与注册闸**：`VerifierSelftest` 从描述性文字改为可执行样本（`{ role, name, criterion, expect, store? }`）；`VerifierRegistry.register` 改为 async 并在注册前真实执行样本（只带 criterion 的经 `verify()`，带 store 视图的经纯函数 `judgeCompositeCriterion`），用与生产相同的校验比对 `expect`（`pass`/`fail`/`not-pass`）；漏检/未通过/缺样本/畸形/不可执行使裁判不可用并点名原因。三个内建各带真实样本。内建经幂等 `ready()` 注册，`[Service.init]` 调用，`verifyRun`/`evidenceByVerifier` 先 await；唯一跳过通道是调用者显式 `{ testDouble: true }`（测试替身，记警告）。`register` 是唯一裁判替换路径（复核核实）。
- **裁判版本**：`verifyCriterion` 用实际注册实例的 `version` 覆盖插件自报值写入 `VerificationResult.verifierVersion`，`claim()` 复制；`evidenceByVerifier(storeId, ref, version?)` 按 `(verifierRef, version)` 索引（旧证据无版本仍可读，版本变更不改写历史）。
- **受保护验收输入**：`CriterionSpec`/工具 schema 声明路径字符串；`decomposeAndRun` 在规范化入口前固定为 `{ path, sha256 }`（读不到或 checkout 无法解析 → 整批拒绝零副作用）；replay 固定字符串形态、原样携带冠军的固定形态；`contractDefects` 共用固定形态规则；判决前 registry 复检（缺失/被改 → `fail` 点名路径，不派发）。
- **消费者与渲染**：spawn prompt 与 worker 契约块判据表、`task_read` 判据行、review record 与 review pack（` [command@1]`）。
- **持久化兼容**：只给事件载荷引用的类型新增可选字段（`AcceptanceCriterion.protectedInputs`、`VerificationResult.verifierVersion`、`EvidenceClaim.verifierVersion`、`ReviewCriterion.verifierId/verifierVersion`），`task/event` 载荷类型文本未变，根指纹未移动，按纪律写 same-version 记录并实跑确认。

测试锚：`verifier/tests/unit/verifier-registry.spec.ts`（注册闸正反例、testDouble 显式通道、版本覆盖、受保护输入失配/缺失/畸形且不派发、索引与旧证据）、`verifier/tests/unit/{composite,command}-verifier.spec.ts`、`task-runtime/tests/unit/protected-inputs.spec.ts`、`task-runtime/tests/unit/{orchestrate,admission,normalize,contract,handoff,review-record}.spec.ts`、`agent-singularity/tests/unit/task-tools.spec.ts`、`tests/integration/verifier-selftest-inputs.spec.ts`。

实跑命令与结果（2026-09-21/22，按公共执行合同顺序，最终状态）：

1. `packages/singularity` 下 `pnpm build`：通过（含 `agent-singularity build$ tsc --noEmit && tsdown`）。
2. 外层 `pnpm vitest run --project unit packages/singularity`：28 文件 / 775 项通过（D1 修复后 777）；基线 27 / 713。
3. 外层 `pnpm vitest run --project integration packages/singularity`：22 文件 / 145 项通过；基线 21 / 138。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配（未 `--write`，新增 same-version 记录）。
5. `packages/singularity` 下 `git diff --check`：通过。
6. 各包 `pnpm exec tsc --noEmit`：`task` 0、`verifier` 0、`agent-singularity` 0、`task-runtime` 8 处既有诊断（G9）。
7. 未运行：真实 LLM、BB 构建/仿真、生产 Evolution、部署与推送。

历史接口交接（当时给 S1-C，已被 R2/R3 更新，不按此句施工）：`VerifierSelftestSample`/`VerifierSelftestStore`/`VerifierSelftest`、`ProtectedInputRef`、`sha256Hex` 当时从 `@dangosys/dsh-singularity-task` 导出；`VerifierRegistry.register(verifier, { testDouble? })` 为 async，`ready()` 幂等且 `[Service.init]` 调用；`evidenceByVerifier(storeId, ref, version?)` 只做索引；`task-runtime/src/protected-inputs.ts` 的 `fixProtectedInputs`/`fixCriteriaProtectedInputs`/`fixSpecProtectedInputs`/`protectedInputDefects` 与 `verifier/src/protected-inputs.ts` 的 `protectedInputDefects` 可复用；`protectedInputs` 的固定形态（`{ path, sha256 }`）是持久化词汇，字符串形态只属于准入输入。

现行接口：`VerifierSelftestSample`/`VerifierSelftestStore`/`VerifierSelftest` 从 `verifier` 导出，`ProtectedInputRef`/`sha256Hex` 仍属 `task`；R2 已删除无消费者的 `evidenceByVerifier`。后续票按当前源码与本文 R2/R3 验收记录接线。

## S1-V：先保证验的是目标

落点：`task/src/types.ts`、`verifier/src/index.ts`、`verifier/src/composite-verifier.ts`、`task-runtime/src/admission.ts`、`task-runtime/src/orchestrate.ts`。

分成三个可独立验收的切片：

1. **父级验收**（2026-09-21 P4 已完成最小机械版）：父 AC → 子证据映射（`childEvidence`，按 batch 位置 + 判据/证据引用，验收期对照 store 校验存在性与 verified 来源）与至少一个独立父级组合检查（映射断言 + 父级 command）已落地；默认 composite 的“子全 verified”仍只作汇总。剩余：C3 假设满足性完整证明、自然语言条款只作显式标注的启发式（`heuristic`）。
2. **验证器自测与输入身份**（2026-09-22 已验收，21 日开始，见「S1-V 切片 2 执行与验收记录」）：selftest 已从描述落为可执行正负样本并在注册路径实际执行（注册闸；唯一例外是调用者显式声明的测试替身）；判决与证据记录实际注册实例的版本并可按 `(verifierRef, version)` 查询，召回处置未建；criterion 声明的受保护验收输入在准入固定身份、判决前复检。未声明保护范围的输入不受保护；C3 完整证明与证据来源真实性认证仍缺。
3. **证据依赖有效性**（2026-09-21 P4 已完成）：`requiresArtifact` 收敛为已验证参考产物（verified run + pass 判据），原始输入用 `acceptsArtifact` 独立表达；失败/过期 run 的同名产物不再满足依赖。剩余：产物来源、版本/摘要与适用性的进一步绑定。

验收：子任务都通过但组合接口错误，父必须拒绝；删掉父 AC 的证据映射必须拒绝；负样本可检出；修改验收脚本不能把错误产物变成 PASS；同名过期/失败证据不能满足要求已验证参考的依赖。自然语言蕴含留作有标记的启发式判断。

## S1-C：能力预检与版本绑定 执行与验收记录（2026-09-22）

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 已验收（2026-09-22；独立复核为 K3 主模型子代理只读 + 变异/反例复核，未由人类复核） |
| 执行 agent / 任务链接 | Kimi Code 主代理指挥与验收；5 个实现子代理（①侧车契约 ②准入预检 ③Run 绑定与摘要 ④统一校验三入口 ⑤组合集成）+ 1 个独立复核子代理（K3 主模型）+ 1 个复核修复子代理（resumed ④） |
| 开始日期 / 验收日期 | 2026-09-22 / 2026-09-22 |
| 前置验收记录 | T1（`741dcb2`）与 S1-V 切片 2（交付时未提交）。派发方先逐项实跑复核 S1-V 切片 2 记录：`pnpm build` 通过；单测 28 文件 / 777 项、集成 22 文件 / 145 项全绿；`verify-persistence` 4 根匹配；`task`/`verifier`/`agent-singularity` tsc 0 错误，`task-runtime` 8 处既有 G9 诊断且全部落在其 diff 之外——与记录一致，随后代为建立基线提交 `c2912af`（仿 T1 由派发方提交 `741dcb2` 的模式），外层仅同步子模块指针，thirdparty 未跟踪内容保持原样。前置代码逐项源码核对：T1 的 `TaskContract`/`normalizeDecomposition`/`contractDefects`、S1-V 切片 2 的 `register`/`ready` 注册闸与 `{ testDouble: true }` 通道、`protectedInputs` 准入固定（`fixSpecProtectedInputs`）与判决前复检、P2/P3 的 `skillContent`/`skillBaseline` 身份与 `checkPromotion`/`checkProductionBaseline` 复检入口——前置成立，未发现阻断本票的前置缺陷 |
| 修改前基线 | Singularity `c2912af`（S1-V 切片 2 交付提交，派发方代建），外层 harness `7fadd85151`（仅同步子模块指针） |
| 交付版本 | 未提交（本票结束时代码与文档仍在工作区；提交由派发方决定） |
| 验收项对应 | 不存在的 skill 预检拒绝 → `decomposeAndRun`/`replayTask`/`task_decompose` → `tests/integration/provider-precheck.spec.ts`（16 项）+ `task-runtime/tests/unit/provider-precheck.spec.ts`；未知执行 verifier / 工具声明不满足 → `validateSkillProvider` × 四入口 → `provider-precheck.spec.ts` + `tests/integration/provider-promotion.spec.ts`（verifier-unknown、tool-not-covered × 4 消费者）；冲突 preset → `resolveCapabilities`（普通分解/replay 共用）→ `capability.spec.ts:181,190`、`orchestrate.spec.ts:824,2385`（既有回归）；知识型可加载但不能关闭执行 GAP → 准入判决 + `executionProviders` + run 绑定 → `tests/integration/knowledge-provider.spec.ts`；替换 provider 不改 Task AC → capability apply（真实 `evolution_apply` + config.yml + 运行表镜像）→ `tests/integration/provider-version-binding.spec.ts` 测试 4；老 run 能定位旧内容 → run 绑定读回 / `readRunBinding` / `task_read` / 重入 → `tests/integration/worker-binding.spec.ts`（8 项）+ `provider-version-binding.spec.ts` 测试 1/2/3/5；子节点递归分解无需猜能力名 → 子 worker 合同块/prompt/`task_read` 摘要 + `capability_list` → `tests/integration/recursive-capability.spec.ts`；加载未选 skill 不扩大工具权限 → 真实 `skill` 工具 + grant 过滤 → `tests/integration/run-skill-loading.spec.ts`；统一校验入口（配置载入/provider 替换/候选晋升/准入预检，evolution_apply 不是唯一防线）→ 四消费者 × 5 非法形状同一 defect 码 → `provider-promotion.spec.ts` + `task-runtime/tests/unit/{provider-load,capability}.spec.ts`；Run 实际加载绑定版本、新版本 apply 不热替换在途 run、旧内容不可读明确拒绝恢复 → `run-binding.ts` + `orchestrate.ts:skillRootsForRun` → `worker-binding.spec.ts`、`provider-version-binding.spec.ts`；多文件资源完整身份、不支持形态显式拒绝 → `loadSkillSidecar` → `task-runtime/tests/unit/sidecar.spec.ts` + 集成篡改用例 |
| 实际检查 | `pnpm build`（packages/singularity）通过；外层 `pnpm vitest run --project unit packages/singularity` 35 文件 / **917 项**通过（本票基线 28 / 777，新增 7 文件 / 140 项）；`--project integration packages/singularity` 29 文件 / **184 项**通过（基线 22 / 145，新增 7 文件 / 39 项）；`pnpm run verify-persistence` OK（4 个事件根指纹未变，新增 same-version 记录 `docs/persistence-changes/2026-09-22-run-provider-binding.md` + `.schema.json`，未 `--write`）；`git diff --check` 通过；各包 `pnpm exec tsc --noEmit`：`task` 0、`verifier` 0、`agent-singularity` 0、`agent-runtime` 2 处既有诊断（`agent-runtime.spec.ts:325`，本票未改该文件）、`task-runtime` 8 处既有 G9 诊断（行号均在本票 diff 之外） |
| 跨入口/组合反例 | 各阶段先红后绿：阶段 1 三 spec 无法加载→65 项绿；阶段 2  stash 实现后集成 12/15 红→恢复绿；阶段 3 四处先红（预检 4 红、orchestrate 5 红、task_read 3 红、worker-binding 7 红）→绿；阶段 4 双闸禁用后单测 21 红 + 集成 3 红→恢复绿；复核修复轮 D1（闸禁用单测 3 红 + 集成 1 红）、D2（1 红）、D4（1 红）、D6（2 红）先红后绿。独立复核 9 组变异（decomposeAndRun/replayTask 预检置空、`executionProviders` 放行 knowledge、绑定复检旁路、`skillRootsForRun` 丢快照根、`checkPromotion` 跳校验、`providerLoadReport` 吞 defect、未知 verifier 放行、物化后字节变动检查跳过）全部转红并哈希证明还原；6 个自建反例中 5 个攻击失败（在途 run 不加载新字节、裸 `applyCapabilityRow` 被准入兜底、快照删除后 task_read 具名拒绝、多文件篡改被抓），1 个击穿（CE-A = D1，已修复）。合法正例保留：合法执行型全链路晋升、知识型加载、在途 run 正常判决、无侧车 guidance 准入。拒绝路径断言零落库/零 spawn/零 config 写入/零 applied/零审批燃烧，结论从 store/事件日志/worker skill 层实际注册内容读回 |
| 独立复核 | K3 主模型子代理（只读复核 + 9 组变异 + 6 自建反例，临时文件删除、sha256 证明还原）：受支持路径未击穿；发现 D1（含侧车/资源的 skill 候选被校验为 execution-provider 并写入人审理由与台账，但执行器只写单文件——已修复为显式拒绝并回归）、D2（`readRunBinding` 不复检 guidance 快照根级条目——已修复，按"快照出现身份未覆盖条目"方向实现并记录理由）、D3（guide/计划未同步——本记录与文档同步即修复）、D4（`renderRunBinding` 声称渲染快照路径实际不渲染——已修复为实际渲染）、D5（`state.ts` 格式回退——已修复）；另由复核 CE-D 发现、派发方立项 D6（`applyCapabilityRow` 直调绕过统一校验——已修复为替换前必经 `precheckReplacedCapabilityRow`，移除路径不需校验）。修复后未再重跑该复核；修复项自带先红后绿证据 |
| 文档同步 | 主 guide：审计基线行、§2.2 链路与预检/绑定 bullet、§2.3（1–3 已交付）、§2.4（侧车已落地）、§3 状态行、§4.1 Capability/Handoff 行、§4.2 G2/G6、§4.2 末段完成段、新增 §5.8（范围/源码锚/测试锚/未覆盖边界）；本计划：文首表第 3 行、S 表 S1-C 行、S1-C 节状态行、本记录；`execution-prompts/README.md`（状态与下一项）；`agent-prompt-contracts.md`（worker 摘要的真实渲染落点）；`docs/persistence-changes/2026-09-22-run-provider-binding.md` + `.schema.json`（same-version，根指纹未动，实跑确认） |
| 模拟与未覆盖范围 | 未调用真实模型、未跑 BB 仿真、未部署、未推送；效率对比实验（固定任务集与真实模型）是票后工作，本票不凭 token 变化宣布更高效。配置载入只报告不硬 fail（载入视角无 worker checkout，硬闸在准入）；skill 晋升执行器只支持单文件 `SKILL.md`，携带侧车/资源的候选显式拒绝（目录整体晋升属后续票）；guidance 快照 uncovered 复检只覆盖新增方向；MCP 工具覆盖为前缀判定（server 真实工具表 spawn 才知道）；run 快照无 GC/配额（A3/S2-R 领域）；`templateDigest` 只记录渲染无回读复检；worker 仍可读到部署 catalog 未选 skill 正文（DSH 无 per-agent 隐藏，授权面未变且有回归）；预检视角不含仅 DSH 自带发现可见的 skill（fail-closed 误拒可能，模块文档已点名）；`contentCheck` 只识别携带引用，无 gate 执行；快照只保证字节=准入身份，不证明内容正确；集成 sessionPersistence 为内存假件（既有状况）；replay 报告在组合集成中为既有 fixture 捷径（文件头已注明） |
| 未解决缺陷 / 阻塞 | 无未解决的本票缺陷。复核 D1–D5 与派发方立项 D6 均已修复并回归；范围外边界如实保留（见上行），不改称已完成 |
| 最终验收结论 | 通过（依据：上述实跑命令、各阶段与修复轮先红后绿、独立复核报告及其缺陷修复回归；确认者：派发方主代理 K3 MAX + 独立复核子代理，未由人类验收） |
| 下一项 | 唯一顺序第 4 项 A3（非阻塞运行与恢复）：前置 T1、S1-V 切片 2、S1-C 均已验收——前置满足。A3 可复用接口：`TaskRun.providerBinding`/`readRunBinding`（恢复入口快照复检，S2-R/A3 的恢复路径必须复用同一复检）、`precheckProviders`/`precheckReplacedCapabilityRow`、`RunProviderBinding` 持久化词汇；A3 不属本票，未开始 |

## A3：非阻塞运行与恢复 执行与验收记录（2026-09-22）

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 已验收（2026-09-22；独立复核为子代理只读 + 变异探针复核，未由人类复核；复核与修复均用子代理默认模型） |
| 执行 agent / 任务链接 | Kimi Code 主代理指挥与验收；实现按 5 阶段派子代理（①task 相位/事件/reducer 闸 ②workspace/gate/root-budget 三模块 ③编排重写与接线 ④工具与 prompt ⑤验收规格）；设计合同 `docs/2026-09-22-a3-coordination-design.md` 先经一轮独立评审（8 项缺陷修正后实施）；1 个独立复核子代理（只读 + 7 组变异探针 + 源码/复杂度审计 + tsc 基线对照）；1 个复核修复子代理（resumed 复核代理，7 项缺陷修复 + KISS 清理） |
| 开始日期 / 验收日期 | 2026-09-22 / 2026-09-22 |
| 前置验收记录 | T1（`741dcb2`）、S1-V 切片 2（`c2912af`）、S1-C（交付时未提交）。派发方先逐项实跑复核 S1-C 记录：`pnpm build` 通过；单测 35 文件 / 917 项、集成 29 文件 / 184 项全绿；`verify-persistence` 4 根匹配；各包 tsc 与记录一致——随后代为建立基线提交 `eaa024f`（仿 S1-V 由派发方提交 `c2912af` 的模式），外层 `853e49a` 仅同步子模块指针，其他无关修改保留。前置代码逐项源码核对：T1 的 `TaskContract`/`normalizeDecomposition`/admission 记录，S1-V 切片 2 的注册闸与受保护输入准入固定/判决前复检，S1-C 的 `TaskRun.providerBinding`/`readRunBinding`（本票恢复路径复用同一快照复检，未另建恢复专用读取）与 `precheckProviders`/`precheckReplacedCapabilityRow`——前置成立，未发现阻断本票的前置缺陷 |
| 修改前基线 | Singularity `eaa024f`（S1-C 交付提交，派发方代建），外层 harness `853e49a`（仅同步子模块指针） |
| 交付版本 | 未提交（本票结束时代码与文档仍在工作区；提交由派发方决定） |
| 验收项对应 | 按设计合同 §4.3 逐行核实（独立复核 A 节 + 修复后回归）：分解立即返回且父可继续 → `task_decompose`/`decomposeAndRun` → `tests/integration/a3-coordination-loop.spec.ts:79`（真实 loop，反例先行）+ `coordination-tools.spec.ts` + `orchestrate.spec.ts:2966`；waiting idle 不验收 → `observeWorkerRun` 相位机 → `loop:152` + `orchestrate.spec:3014`；显式提交/父独立验收 → `submitResult`/`settleParentBatch` → `coordination-tools:96` + `orchestrate:3047/3082`；依赖串行 → `driveRounds`（沿用原 cascade 规则，未复制第二套）→ `orchestrate.spec:570`；取消/恢复/卸载完整 → `cancelBatch`/`cancelGraph`/dispose/`reconcileStore` → `loop:276/316/386` + `orchestrate:3314/3355`（嵌套取消/期限）+ `a3-recovery.spec.ts` 13 项（真实 JSONL 重开 6 崩溃点）+ `coordination-tools:145`；提交/派发去重 → 相位唯一性 + reducer 迁移闸 → `task/tests/unit/coordination.spec.ts` + `orchestrate:3047`；迟到写入被阻挡 → `ExecutionGate`（真 tools waterfall）→ `loop:197` + `gate.spec.ts`；跨批次/跨根工作区冲突 → `workspace.ts` → `a3-workspace:98/162/186/212` + `workspace.spec.ts` + verifier 排他正反例（`orchestrate.spec`）；普通/replay 同守状态规则 → `runReplayTask` → `a3-workspace:129/162` + `a3-recovery:882`（spawn:false 出生 submitted）；根预算不因新 Run/重启重置 → `root-budget.ts` → `root-budget.spec.ts` + `orchestrate:3130/3164/3190` + replay 共享同一根总额（`a3-workspace:162`）+ 崩溃重数不退款（`a3-recovery`）；无进展停止 → `RunProgressMarked` 相位机 → `loop:152` + `a3-workspace:147`；signal 转移 → 两阶段 `decomposeAndRun` → `orchestrate:2996` + `loop:79`；恢复复用 `readRunBinding` → `reconcileStore` → `a3-recovery:733`；旧无相位 run 派生 needs-recovery 不重跑 → `run-phase.ts` → `a3-recovery:629` |
| 实际检查 | `pnpm build`（packages/singularity）通过且幂等（构建前后文件清单无差异）；外层 `pnpm vitest run --project unit packages/singularity` 39 文件 / **1086 项**通过（S1-C 基线 35 / 917）；`--project integration packages/singularity` 33 文件 / **212 项**通过（基线 29 / 184；A3 四部：loop 6、recovery 13、workspace 5、coordination-tools 4）；`pnpm run verify-persistence` OK（4 根指纹未移动；same-version 记录 `docs/persistence-changes/2026-09-22-a3-coordination-phases.md` + `.schema.json`，未 `--write`，机制与先例已在记录中说明）；`git diff --check` 两仓通过；各包 `tsc --noEmit`：task 0、verifier 0、agent-singularity 0、agent-runtime 2 处既有（`agent-runtime.spec.ts:325`，本票未改该文件）、task-runtime 3 处既有（独立复核用 `eaa024f` 检出走 `git archive` 对照基线 8 处，确认当前 3 处同源、本票净减 5 处）、graphs 6 处既有行列一致；以上全量为派发方主代理亲自复跑确认 |
| 跨入口/组合反例 | 变异探针 7 组全部先红后还原（sha256 证明）：闸放行 waiting_children 写 → 单测+集成双红；无进展标记禁用（有界变体）→ 双红；settleSubmittedRun verifying 守卫移除 → 恢复 3 红；submitResult drain/提交顺序颠倒 → 红；maxRuns 检查移除 → 2 红；decomposeAndRun 改回同步等待 → 循环等待反例红；workspace claim 放行第二根 → 单测 7 红（双缺变体集成红）。复核发现 7 项缺陷均先红后绿修复：根预算×replay（"2 parentless = 不可解析"误拒 + replay 入口跳过检查 → owner 改按 `rootTaskStoreId` 持久绑定解析、三入口统一、`hasRootLimits` 区分未配置/空配置）；嵌套批次取消挂死（waiting 分支只等终态 → `awaitWaitingTerminal` 恢复 [终态｜期限｜批次 abort] 竞争，`cancelBatch` 级联下级批次，未启动子节点 cancelled-before-start）；registerDriver 只 warn（→ `failBatchFromRuntime`：父 failed + 诊断 + 通知 owner）；orchestrate.spec 未 await 的 rejects；reconcileStore 按 store 整体跳过（取证可达 → 改按 run/批次粒度跳过）；两处静默 catch（→ 具名 warn）；verifier 排他无测试且栈顶不符照常验证（→ 栈顶属别的 store 具名拒绝验证 + 正反例）。合法正例保留：正常分解/提交/验收/取消/恢复/重开全链路；拒绝路径断言零落库/零 spawn |
| 独立复核 | 子代理默认模型（只读复核 + 7 组变异探针 + 源码审计 + 复杂度审计 + tsc 基线对照 + 全量实跑；342 文件 sha256 清单证明复核零残留）：结论**返工**——2 项验收级缺陷（根预算×replay 与合同相反、嵌套批次取消可挂死）+ 1 项低级（driver 异常只 warn）+ 9 项记录边界 + 复杂度删除清单。修复由 resumed 复核代理执行（每项先红后绿），派发方主代理亲自复跑全量并抽查修复点代码确认。注：首轮复核曾派 K3 主模型，完成 3 组探针后按派发方指示中止换模（其探针均以 sha256 验证还原，工作区零残留），最终复核由默认模型完整独立重做 |
| 文档同步 | 主 guide：§3 状态行与 A3 运行可行性段、§4.1 父子交互行/预算行、§4.2 G12 行、新增 §5.9；本计划：文首表第 4 行、A 表 A3 行、入口段下一项、本记录；深入架构：§10 A3 行、§7.1/§7.2/§7.4 落地事实回写（未落地部分保持待建表述）；`agent-prompt-contracts.md`：§3/§4 模板（显式提交协议、非阻塞批次、task_cancel、写闸）与 §6 表三行、§7 矩阵一句；`execution-prompts/README.md` 状态行；`README.md` 与 `agent-singularity/README{,.zh}.md` 工具清单（21→23，task_decompose 语义更新）；持久化记录 `docs/persistence-changes/2026-09-22-a3-coordination-phases.{md,schema.json}`（same-version，根指纹未动，实跑确认）；设计合同 `docs/2026-09-22-a3-coordination-design.md`（含评审修正记录） |
| 模拟与未覆盖范围 | 未调用真实模型（协调协议用真实 DSH loop + `ScriptedModelAdapter` 按 sessionId 分片）、未跑 BB 仿真、未部署、未推送；崩溃恢复以真实 JSONL 重开 store 验证（6 崩溃点 + 验证中断 3 例），其余路径沿用内存假件（既有状况）；run-stack 单测 harness 直构 TaskRuntime（Service.init 不执行），闸的拒绝断言只出现在真实 loop 套件（独立复核核查无假绿）。边界：A4 问答工具未建（挂载点字段已持久化无消费者）；子任务按依赖串行、无并行工作窃取；进程崩溃时在途 active worker run 不恢复现场（cancelled+诊断，session 续跑属 S2-R）；工作区归属不防御共享文件系统上的外部 unmanaged 写入者（含多机共享 DSH_HOME 时 pid 探测失效）；pid 复用可把陈旧标记误判为活（marker 尽力记录 starttime）；replayLineage 为进程内 Map（重启后补验证的 replay 终态 review 不带 lineage tag）；根 run 终态后根 session 被闸置 terminal（迟到写入拒绝的合同结果，对用户续聊是行为变化，A0/A4 领域）；`waitRunSettled` 2s 尾部窗口等的是同进程结算簿记（非写进程停止），该超时分支无测试；token/工具费用只有终态软统计（unknown 不记零）；真实模型质量实验为票后工作 |
| 未解决缺陷 / 阻塞 | 无未解决的本票缺陷。独立复核 7 项缺陷均已修复并回归；范围外边界如实保留（见上行），不改称已完成 |
| 最终验收结论 | 通过（依据：上述实跑命令与数量、变异探针与 7 项缺陷修复的先红后绿、独立复核报告及修复回归、派发方亲自复跑与抽查；确认者：派发方主代理 K3 MAX + 独立复核子代理，未由人类验收） |
| 下一项 | 唯一顺序第 5 项 T2+T3 交付组（契约审核与恢复）：前置 T1、A3 均已验收——前置满足。可复用接口：`admitBatchIn` 原子提交、`batchId` 词汇（`b-<parentTaskId>`）、`awaitBatch`、executionPhase 迁移闸（审核等待是提案状态，新增相位须走同一持久化纪律）、根预算记账点（`checkRunStart`/`checkBatchAdmission`/`resolveRootBudget`）、`readRunBinding` 恢复复检、`reconcileStore` 按 run 粒度幂等；A3 的写闸/取消/恢复规则对 T2/T3 的审核等待态同样适用；T2/T3 不属本票，未开始 |

## T2+T3：契约审核与恢复 执行与验收记录（2026-09-22 / 23）

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 已验收（2026-09-23；完成闸证据见下，独立复核为双模型并行子代理复核 + 综合复核子代理确认，未由人类复核） |
| 执行 agent / 任务链接 | Kimi Code 主代理指挥；4 个阶段实现子代理：阶段 A 提案合同层（`task` 记录/reducer/摘要、`task-runtime` 提案身份）、阶段 B task-runtime 生命周期（策略、提交、决定、批准后重检、requestKey 幂等、恢复遍）、阶段 C 工具面与审批渠道与 prompt（`task_decompose` 组合、三个提案工具、`ProposalReviewService`、root/worker prompt 同步）、阶段 D 集成级验收（本记录：两个新集成 spec、模型协议 fixture、组合反例与文档同步） |
| 开始日期 / 验收日期 | 2026-09-22 / 2026-09-23 |
| 前置验收记录 | 前置票：T1 已验收（交付提交 `741dcb2`，见 T1 节）、A3 已验收（记录见 A3 节，交付时未提交，`eaa024f` 之后由本组复核并代为提交为 `6d85c5e`，外层 `4d5d4b7` 仅同步子模块指针）。本组复核 A3 时的实跑数字（与 A3 记录逐项一致）：`pnpm build` 通过、单测 39 文件 / 1086 项、集成 33 文件 / 212 项、`verify-persistence` 4 个事件根指纹匹配、各包 `tsc --noEmit` 为 task 0 / verifier 0 / agent-singularity 0 / agent-runtime 2 / task-runtime 3 / graphs 6。前置源码逐项核对结论：T1 的 `normalizeDecomposition`/`contractDefects`/`decompositionDigest`/`assertContract` 为普通分解、replay、root 共用（阶段 B 的 `deriveBatch` 复用同一入口）；A3 的 `admitBatchIn` 原子提交（阶段 B 在 `admitPrecheckedBatch` 里用同一入口带消费记录）、`batchId` 词汇 `b-<parentTaskId>`、`awaitBatch`、executionPhase 迁移闸（审核等待不新增相位）、根预算记账点、`readRunBinding` 与 `reconcileStore`（阶段 B 的恢复遍挂在 `reconcileStore` 末尾）均存在且未被本组改写语义——前置接口成立。**但复核期间在本组集成验收上暴露出一项 A3 已交付代码的缺陷，按公共合同「发现前置缺陷，先在该前置范围修复并重验」于阶段 D 修复**：`task-runtime/src/workspace.ts:writeMarker` 原先让每次标记写入共用同一个临时文件名 `<marker>.json.tmp`，同一进程内两条链并发改同一 marker 时（子运行自身的提交链在 verifier 层进/出，批次 driver 在结算并释放同一子运行）后一次 `rename` 会因源文件已被前一次消费而抛 ENOENT，该错误从一次 release 冒出并令批次 driver 失败（实测捕获 `the batch driver failed: ENOENT: no such file or directory, rename '<...>/workspace-owners/<sha256>.json.tmp' -> '<...>.json'`；同一负载下既有 A3 spec `coordination-tools.spec.ts:90` 出现过一次同症状失败）。复现、修复与回归证据见本记录「跨入口/组合反例」M6 与「未解决缺陷 / 阻塞」两行 |
| 修改前基线 | Singularity `6d85c5e`（A3 交付提交，派发方代建），外层 harness `4d5d4b7`（仅同步子模块指针；`thirdparty/deepseek-harness` 的未跟踪内容保持原样） |
| 交付版本 | 未提交（本组代码与文档仍在工作区；提交由派发方决定） |
| 验收项对应（T2） | ① `off` 不调用人审但记 policy-off → `submitProposalOnce`（`policy` 落记录、出生 `ready`）/ 渠道调用计数 → `tests/integration/proposal-review.spec.ts`「runs the batch under policy off, asks nobody, and records that policy on the proposal」（`review.asks` 为空、提案 `policy: 'off'`、无 `TaskProposalDecided`/`TaskProposalPhaseChanged`、消费等于批次子任务），单测锚 `task-runtime/tests/unit/proposal-lifecycle.spec.ts`「policy off admits synchronously…」；② `all` 批准前零子任务/零 spawn/父未 decomposed → `continueProposalIn` 的 ladder + `admitPrecheckedBatch` → 集成「holds the batch under policy all…」（store 只有根任务、零 spawn、无 `TaskCreated`/`TaskDecomposed`/`TaskProposalAdmitted`、父仍 `decomposable`、等待中再续跑仍 `pending_review`）；③ 非法输入不弹审批 → `deriveBatch`/`checkDerivedBatch` 在任何写入之前 → 集成「refuses an illegal batch by name before any review is requested, and leaves no trace」（两类拒绝：全 optional 判据、批次自带策略字段；`review.asks` 为空、零提案事件）；④ 批准只作用于同一摘要 → `task/src/service/state.ts:assertDecisionBinding`（reducer）与 `decideProposal` 只从记录取摘要 → 集成「refuses a decision that names a different batch, a different limit set or a different resolution」（四类篡改各自被具名拒绝、之后正确决定仍被接受）+ `task/tests/unit/proposal.spec.ts` 的 18 例决定拒绝表；⑤ 拒绝/取消/无回答者均不执行 → `decideProposal` 与渠道 `record` → 集成 `it.each(['rejected','cancelled','unavailable'])`（`rejected` 记录 reason 与 `decidedBy=approval:s-root`；`cancelled`/`unavailable` 保持 `pending_review`、同请求答原提案并再问一次；三者均零 spawn、零 `TaskDecomposed`、零消费）；⑥ 修订不能复用批准 → `supersedes` + 新 requestKey（内容派生新 id）→ 集成模型协议 fixture「lets a refused agent read the refusal off the record and run a revised batch」（拒绝记录原样保留、修订为新提案并批准后运行到 verified）；⑦ 直接 runtime 调用同样受闸 → `decomposeAndRun`/`continueProposal` 服务入口 → 集成「holds a direct service call exactly as the tool, and admits it only from a recorded decision」（`h.calls` 中零 `task_decompose`，仍返回 `pending_review` 且零 spawn）；⑧ 父/Run/资源配置改变标 stale/expired → `parentRunEndedReason` 与 `continueProposalIn` 的两处指纹重检 → 集成「records a late approval as expired when the parent run has ended…」（父 run 取消后迟到批准写 `expired`、零派发）、「marks an approved batch stale when its capability resolution moved…」（`applyCapabilityRow` 改解析 → `stale` 且点名 manifest 摘要变化）+ 恢复 spec「marks an approval stale when the limits moved while it waited…」（重启换 `maxChildren` → `stale` 且点名限额变化）；⑨ all→off 不释放待审、off→all 准入前补审 → `continueProposalIn` 的策略分支（只收紧）→ 恢复 spec「never releases a waiting proposal by loosening the policy to off」与「sends a policy-off proposal that never ran to review when the deployment tightened…」（重启换策略；补审后仍须落账决定才准入）；⑩ 递归 worker 无新增管理/HITL 工具 → `WORKER_BASELINE_TOOLS` + 真实装配的工具面 → 集成「gives a worker no tool that could decide a proposal, and the root the coordination tools it needs」（worker 面含 `task_read`/`task_status`/`task_decompose`/`task_submit_result`/`task_cancel`/`capability_list` 与三个提案协调工具，不含 graph/HITL/review/diagnosis/evolution/`escalate`，且无任何 `*_decide`/`*_approve` 名；root 面含三个提案工具）；附：等待中的 run 不被无进展规则停止 → `orchestrate.ts` known wait + `openProposalOf` → 集成「keeps a worker whose own batch waits for a review idle on purpose, without a no-progress stop」（`noProgressRounds: 1` 下零 `RunProgressMarked`、run 由取消结算）；闸把 `task_proposal_continue` 当写 → `gate.ts` → 集成「denies a proposal continuation while the run is waiting on its batch, and answers the read side」；replay 不入审 → 集成「never routes a replay through the review, whatever the policy」（`all` 下 `replayTask` 零 ask、零提案事件、零 spawn） |
| 验收项对应（T3） | ① 待审崩溃 → 恢复 spec「keeps a waiting proposal waiting across a restart, re-asks from the saved facts, and is advanced only by a decision」（真实 JSONL 重开：仍 `pending_review`、store 只有根任务/根 run、零 spawn、零 `TaskDecomposed`/`TaskProposalAdmitted`；渠道以 `trigger: 'recovered'` 收到与保存记录同一批材料；落账决定后准入并运行到 verified）；② 批准已保存未准入崩溃 → 「continues an approval that was recorded before the crash, in one batch with stable child ids」（决定经 store 入口落账、进程死于续跑之前；重开 reconcile 自动重检并准入，全日志仅 1 条 `TaskProposalAdmitted`、子任务 ids 与消费一致；再跑一次 reconcile 不改变任何 id）与「retries an approval whose admission was refused whole, still in one batch」（限额拒绝整批 → 决定保留、`ready`；换预算重开后由恢复准入同一批）；③ 准入已提交未 spawn 崩溃 → 「drives an admitted batch whose children were never started from the proposal its consumption names」（`parkDrain` 冻在准入 drain：消费与 ids 已落库、零 spawn；重开后 A3 恢复驱动同一批，`TaskProposalAdmitted` 仅 1 条）；④ run/session 已建立 → 「settles a run that was in flight when the process died without executing it again」（重开只结算该 run、runId 不变、不再执行、零新 spawn、提案消费不变）；⑤ 相同请求不重复 + 已通过兄弟不重跑 → 「answers a repeated request from the record, in the first process and after a restart」（同 key 同内容答原提案、不同内容才新提案；重启后同请求仍答原提案，任务/run 数不变）与「does not re-run a sibling that verified before the crash」（已 verified 兄弟一次 `TaskStarted`、在途兄弟按 runId 结算为 cancelled、零新 spawn）；⑥ 两个获批提案竞争同一父只准入一批 → 「admits one of two proposals competing for the same parent, and names the loser」（获胜方准入并运行，落败批准被记为 `expired` 并说明父 run 已离开可派发相位；仅 1 条 `TaskProposalAdmitted`）与「marks a competing proposal stale when it is continued after the parent already decomposed」（续跑路径落败方 `stale`，reason 点名父任务已分解）；⑦ off 提案遇策略变 all 补审后才准入 → 「sends a policy-off proposal that never ran to review…」；⑧ 模型协议 fixture → `proposal-review.spec.ts` 的「lets a refused agent read the refusal off the record and run a revised batch」（文件头已注明只证明接线与状态，不证明真实模型质量） |
| 实际检查 | 1. `packages/singularity` 下 `pnpm build`：通过（含 `agent-singularity build$ tsc --noEmit && tsdown`）。2. 外层 `pnpm vitest run --project unit packages/singularity`：43 文件 / **1305 项**通过（阶段 A–C 基线 1304；本阶段新增 `task-runtime/tests/unit/workspace.spec.ts` 的并发写复现 1 项）。3. 外层 `pnpm vitest run --project integration packages/singularity`：35 文件 / **239 项**通过（阶段 A−C 基线 33 文件 / 212 项；本阶段新增 `tests/integration/proposal-review.spec.ts` 15 项与 `tests/integration/proposal-recovery.spec.ts` 12 项）；workspace 前置缺陷修复后按要求连跑 6 次，**6/6 全绿**（逐次均为 239 passed / 35 files；Duration 分别 9.08s、6.21s、8.13s、10.10s、7.91s、19.01s，第 6 次 transform 256.65s 的高负载下也全绿），修复消除了 ENOENT 症状；本组两个 spec 的 spawn 等待已改为显式 20 秒窗口，高负载下既有 A3 spec 的 1 秒默认窗口仍可能超时（该观察单列在「未解决缺陷」行）。4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`（未 `--write`；本阶段只加测试与文档）。5. `packages/singularity` 下 `git diff --check`：通过。6. 各包 `pnpm exec tsc --noEmit`：task 0、verifier 0、agent-singularity 0、agent-runtime 2（`agent-runtime.spec.ts:325` 两处，既有）、task-runtime 3（`src/index.ts:717`、`src/index.ts:4168`、`../task/src/index.ts:52`，既有）、graphs 6（既有）——与基线逐项一致，本阶段未新增诊断。7. 未运行：真实模型、BB 构建/仿真、部署、推送 |
| 跨入口/组合反例 | 先红后绿（变异探针 5 组，逐项先记录实现文件 sha256、改后复跑、还原后再核对同一 sha256，工作区无残留）：M1 策略闸（`submitProposalOnce` 一律出生 `ready`，忽略 `all`）→ `proposal-review.spec.ts` 15 项中 10 项转红（`all` 零点、三种拒绝回答、模型协议 fixture、直接服务调用、篡改摘要、迟到批准、能力解析 stale、known wait），合法正例（`off` 记录、非法输入不弹审批、worker 工具面、闸分类、replay 不入审）保持绿；M2 批准后重检的两个指纹比较置空 → 2 项转红（能力解析变化、限额变化）；M3 恢复的提案遍短路 → `proposal-recovery.spec.ts` 12 项中 6 项转红（待审重发、批准续跑、限额拒绝后重试、同请求幂等、off→all 补审、all→off 不释放）；M4 known wait 分支短路 → 1 项转红；M5 把 `task_proposal_continue` 加进闸的协调放行表 → 4 项转红。合法正例保留：`off` 正常分解并运行到 verified、非法批次具名拒绝零副作用、批准后批次执行、replay 不受审核影响、worker 工具面不扩张。**M6（A3 前置缺陷复现，先红后绿）**：新增 `task-runtime/tests/unit/workspace.spec.ts` 的「overlapping marker writes」用例——8 次在同一 tick 内启动、各自对栈合法（前一次已 pop）的 `release` 并发写同一 marker，不用计时器或 latch 决定交错；把 `workspace.ts` 的临时名还原为固定的 `<marker>.json.tmp` 后该用例 **10/10 失败**（单次形态：8 次 release 中 7 次以 `Error: ENOENT: no such file or directory, rename '…workspace-owners/<sha256>.json.tmp' -> '…/<sha256>.json'` 拒绝，断言 `expect(失败列表).toEqual([])` 报出全部拒绝文本）；修复后同一用例 **10/10 通过**，workspace 单测整文件 20/20，除 `task-runtime/src/workspace.ts` 与 `tests/unit/workspace.spec.ts` 外无实现改动（其余 src 文件 sha256 与探针前一致）。拒绝路径断言：零子任务、零 spawn、零 `TaskDecomposed`、零 `TaskProposalAdmitted`、渠道调用次数（`review.asks`）、父任务仍 `decomposable`；结论全部从 store 快照/事件日志、JSONL 重开后的 store 与渠道收到的请求读回 |
| 独立复核 | 双模型并行独立复核（2026-09-23，均为子代理复核，未由人类复核）。**复核 A**（K3 主模型子代理：只读复核 + 全量实跑 + 集成 3 连跑 + 6 组变异探针 + 3 自建反例 + 60 交付文件 sha256 零残留清单）：结论**通过**，验收清单 T2/T3 逐条核实成立，伪造批准可达性全链路追踪无可达路径；报告 1 项文档级缺陷（持久化记录 Verification 段数字 1304 应为 1305）。**复核 B**（deepseek-v4.1-flash 子代理：只读复核 + 全量实跑 + 集成 3 连跑 + 6 组变异探针（含消费源闸 `ADMISSION_SOURCES` 只放行 ready）+ 4 自建反例 + 3926 文件零残留清单）：结论**通过**；报告 2 项文档级缺陷（`agent-singularity/README.md`/`README.zh.md` 声称"All 26 registered"但注册 27、清单缺 `escalate` 行——HEAD 既有漂移 23/24，本组阶段 C 刷新计数时继承；同一处 1304/1305）。**综合复核**（deepseek-v4.1-flash 子代理，对两份结论做可信度抽查与缺陷裁决）：抽查 5 项承重断言亲测复现（all 待审零副作用、篡改摘要拒绝、崩溃点②重开续跑、reducer 两闸存在且被测试引用、README 缺陷属实；含"新验收用例确为本组新增、无重复跑绿旧测试冒充"核实），裁决两项缺陷为文档级不阻塞、观察项 O1（handoff review 段 off 下也渲染，条件式措辞）/O2（新旧 spec 等待窗口差异）/O3（`decideProposalIn` 不认证 decidedBy，属受信 store 边界）均为边界而非缺陷——最终确认**通过**。缺陷关闭证据：两项文档缺陷已由派发方修复（README 计数改 27 + 补 `escalate` 行 + `skill` 限定语、服务状态行同步；持久化记录改 1305 并把 24 次复跑叙述更新为修复后 6 连跑全绿），修复后派发方复跑 `verify-persistence` 与 `git diff --check` 通过；复核发现的其余边界已如实保留在「模拟与未覆盖范围」与主 guide §5.10 |
| 文档同步 | 主 guide：§3「Task 自主构造与可选人审」（策略已实现事实）与「下一项」句、§4.1「Task 语言与生成审核」行、§4.2 G10 行、§4.2 末段完成段（补 A3 与 T2/T3）、新增 §5.10「契约审核与恢复（2026-09-23 T2+T3）」；本计划：文首表第 5 行、Task 自主构造接续票表 T2/T3 两行、入口段下一项、本记录；`task-contract-construction-guide.md`：头部状态行、§4 末段（上下文指纹已实现）、§6/§7 落地事实回写、§8 T2/T3 标记为已实现；`agent-prompt-contracts.md`：§3 worker 模板的部署条件块、§4 父模板的提案审核条件块、§6 表新行、§7 反例清单；`execution-prompts/README.md`：状态行与下一项；`docs/persistence-changes/2026-09-22-task-proposal-review.md`：Verification 段的过渡态数字更新为最终全绿实跑数字；`agent-singularity/README.md`/`README.zh.md`：工具清单 23→26（阶段 C），复核后修正为 27 并补 `escalate` 行与 `skill` 限定语（复核 D1 修复） |
| 模拟与未覆盖范围 | 未调用真实模型（协议测试用真实 DSH loop + `ScriptedModelAdapter`，恢复测试用真实 JSONL + 记录式渠道桩）、未跑 BB 仿真、未部署、未推送。崩溃恢复用真实 JSONL 重开验证四个崩溃点；`proposal-review.spec.ts` 的 sessionPersistence 仍是内存假件（仓库既有状况）。本组集成断言含父任务终态（批次 settle 即父验收已结算；曾因 A3 前置 flake 短暂降级为只断言子任务与批次，前置缺陷修复后已恢复父级断言）；父级组合验收规则本身属 A3，仍由 `tests/integration/coordination-tools.spec.ts` 覆盖。审核上下文的内容身份边界如实记录在 §5.10：无侧车 skill 记 `contractDigest: null`、verifier 只记 id、`SKILL.md` 字节由 S1-C 的 run binding 在 spawn 时固定（晚于批准）。不在范围：多进程并发写同一 store、工具外部副作用恰好一次、模板库、契约修订入口、A0 根契约入口、blocked 恢复（S2-R）、真实模型修订质量实验 |
| 未解决缺陷 / 阻塞 | 本组范围内无未解决缺陷（复核期间发现的 A3 前置缺陷已按公共合同在本前置范围修复并重验）。独立复核（2026-09-23）发现 2 项文档级缺陷，均已修复并核对：① `agent-singularity/README.md`/`README.zh.md` 工具计数 26 对实际注册 27 且清单缺 `escalate` 行（HEAD 既有漂移 23/24，本组刷新计数时继承——已改为 27、补 `escalate` 行、对 `skill` 加载器加限定语）；② `docs/persistence-changes/2026-09-22-task-proposal-review.md` Verification 段过渡态数字 1304——已改 1305 并更新复跑叙述。行为缺陷零发现。**A3 前置缺陷（2026-09-23 阶段 D，派发方授权修改 `task-runtime/src/workspace.ts`，已关闭）**：现象＝同一进程内两条链并发改同一 marker 时 `rename` 抛 ENOENT 并从 release/push 冒出，令批次 driver 失败（父 run 记 failed，子任务仍可能 verified）；复现＝`task-runtime/tests/unit/workspace.spec.ts` 的「overlapping marker writes > mutations started in one tick all settle, and the marker stays a marker」（8 次合法 `release` 在同一 tick 内并发写同一 marker，无计时器/latch），修复前 10/10 失败，单次形态为 8 次里 7 次 ENOENT rename；修复＝`workspace.ts:233` 新增进程级单调计数 `markerWriteSeq`、`workspace.ts:493-494` 把临时名改为 `<marker>.json.<n>.tmp`（每次写入各用各的临时文件），marker 协议语义（pid 活性、stale 判定、只由 `reconcileAdopt` 接管、读方只读 `<marker>.json`）不变，未引入新依赖；回归＝同一用例 10/10 通过、workspace 单测 20/20、全量集成 6 次连跑见「实际检查」且无 ENOENT 症状。**剩余边界（如实记录，已写进 `workspace.ts` 模块文档）**：并发写不再互相破坏文件，但 marker 内容仍是「最后落地的那次写」；同一工作区的归属交接仍由调用方串行（进程内栈是权威），本票不引入跨进程 CAS。**范围外观察（未改，供派发方决策）**：机器高负载时（同一套件的 transform 时间在 39s↔453s 之间波动；实测一次子 worker spawn 用时 1621ms）仓库既有的 1 秒 `vi.waitFor` 默认窗口会过期，表现为既有 A3 spec（`a3-coordination-loop.spec.ts`、`coordination-tools.spec.ts`）与本组 spec 的 `expect(spawns).toHaveLength(1)` 超时失败；本组两个 spec 已改为显式 20 秒窗口并在超时消息里带上 store 的 review 原因，A3 两个既有 spec 的窗口未改（超出本次授权范围） |
| 最终验收结论 | 通过（依据：上述实跑命令与数量、阶段 D 的 5 组变异探针先红后绿与 M6 前置缺陷复现修复、两个新集成 spec 的正反例与组合覆盖、双模型并行独立复核均判通过、deepseek 综合复核抽查确认、2 项文档级缺陷已修复核对；确认者：派发方主代理 + 独立复核子代理 A/B + 综合复核子代理，未由人类验收） |
| 下一项 | 唯一顺序第 6 项 A0（真实根契约入口）。前置条件：T1 已验收、T2/T3 已验收（2026-09-23）——**前置满足，A0 可以开始**。A0 可复用接口：提案合同层（`TaskProposal`/`submitProposalIn`/`decideProposalIn`/四个 digest 单点实现）、`submitDecompositionProposal`/`continueProposal`/`decideProposal`/`cancelProposal` 服务入口、`ProposalReviewChannel` 渠道（owner 会话路由、`approval:<ownerSessionId>` 决定身份）、`requestKey` 派生与 reconcile 提案遍、known-wait 与闸分类；根 intake 复用同一审核/恢复协议，真实目标、独立 AC 与幂等激活属 A0 自身范围 |

实施事实（各阶段交付，供复核与后续票引用）：策略 `Config.generatedTaskReview: off | all` 默认 `off`（未知值构造期拒启，批次不能自带该字段）；提案记录 `TaskProposal` 含完整规范化批内容（`batch`）与 `identity`/两个上下文指纹，`proposalId` 由内容派生；`submitDecompositionProposal` 先纯预检（坏批次零副作用、不弹审批），`continueProposal` 是唯一准入入口（父状态/父 Run/限额指纹/解析指纹/批次内容重检，变化标 `stale`、父 Run 结束标 `expired`、通过后才 `approved → ready` 并一次提交消费），`decomposeAndRun` 是二者组合且不经工具也受闸；`decideProposal` 是唯一决定入口（工具层无决定参数或 approvalRef），决定绑定三个摘要；渠道 `ProposalReviewService` 挂 `ctx.proposalReviewChannel`（service 装配处，不在任何 agent 工具面），按 store 解析 owner 会话、经 `ctx.approval.request` 非阻塞提问，`decidedBy=approval:<ownerSessionId>`；工具面为 `task_decompose`（组合提交+续跑）+ `task_proposal_read/continue/cancel`，worker baseline 保留三者但不含管理/HITL，闸把 read/cancel 归协调、continue 归写；`reconcileStore` 的提案遍对等待中的提案只重发请求、对 `ready`/`approved` 续跑，进程内按 store+父串行。持久化记录：`docs/persistence-changes/2026-09-22-task-proposal-review.md`（四个新事件 + `TaskSnapshot.proposals`，same-version，四根指纹未动）。

## A0 + R0：根入口与默认运行面 执行与验收记录（2026-09-23）

> 当前复核结论：**A0 返工已于 2026-09-23 关闭**（Q2/Q3 见「A0 返工（Q2/Q3）执行与验收记录」，R0 证据保留）。以下是 `2e3175a` 的原验收记录，保留当时判断与测试；其 A0 部分的来源/恢复缺陷由返工记录取代，其余验收项沿用。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **已验收**（2026-09-23；完成闸证据见下，独立复核为子代理只读 + 变异探针 + 自建反例复核，未由人类复核）。代码与文档均已提交（交付版本见下行） |
| 执行 agent / 任务链接 | Kimi Code 主代理指挥；4 个阶段实现子代理：阶段 A `task` 包（`TaskProposal.kind` 判别联合、根身份/载荷、根消费绑定与一次性建根闸）、阶段 B `task-runtime`（根 intake 服务层、`adoptRoot` 取代 `createRootTask`、`graphs.create` 切换、`tests/support` 夹具走真实 intake）、阶段 C `agent-singularity` + `agent-runtime` + `graphs`（`task_intake` 工具、根未激活视图、根审核渲染、root prompt intake 段、`ROOT_TOOLS` 计数；含一次 resumed 缺陷修复跟进，两项已上报缺陷在该跟进内关闭）、阶段 D（两个新集成 spec、既有集成修复与期望位移、文档同步）。R0 由两个子代理完成（R0-a 装配开关 `evolution`，R0-b 根 allow-list 与 prompt 同源收敛）。1 个独立复核子代理（非实现者）。设计合同 `docs/2026-09-23-a0-root-intake-design.md`（§4 验收矩阵） |
| 开始日期 / 验收日期 | 2026-09-23 / 2026-09-23 |
| 前置验收记录 | 前置票：T1 已验收（`741dcb2`）、S1-V 切片 2 已验收（`c2912af`）、S1-C 已验收、A3 已验收（`6d85c5e`）、T2+T3 已验收（见上节记录）。本组消费的前置接口已逐项核对：T1 的 `normalizeDecomposition`/`contractDefects`（阶段 B 的 `deriveRootContract` 复用同一入口）、T2/T3 的 `TaskProposal` 四个事件与决定绑定/`requestKey` 幂等/`reconcileStore` 提案遍/`ProposalReviewChannel`（根契约复用整条生命周期，未复制第二套）、A3 的 `adoptRoot` 前身 `createRootTask`、`executionGate.setTerminal`、根预算记账点、S1-V 切片 2 的 `fixSpecProtectedInputs` 与判决前受保护输入复检（根契约的判据走同一机制）。前置缺陷：无（未发现阻断本组的缺陷） |
| 修改前基线 | Singularity `391074a`（R0-a：装配开关按 `evolution` 控制进化工具注册），外层 harness `34d889e` |
| 交付版本 | Singularity 代码 `bd946ee`（六个提交：`391074a` R0-a 装配开关 → `0a18318` A0-A task 包 kind 联合 → `9c311fe` R0-b agent-runtime 收敛 → `214cd91` A0-B intake 服务层 → `b3ee5f7` A0-C 工具/prompt/渲染与两项缺陷修复 → `bd946ee` A0-D 集成验收与文档）；复核缺陷更正与本记录收尾 = 本记录所在提交（docs + 一处过时注释，无代码变化）；外层 harness 指针 `e599b91994`（同步到 `bd946ee`）外加最终指针同步提交 |
| 验收项对应（设计 §4 逐行：验收项 → 入口 → 测试位置与结果） | ① setup 不消费根分解 → `graphs.create` → `adoptRoot` → `tests/integration/graphs-lifecycle.spec.ts` + `tests/integration/root-intake.spec.ts`「keeps the graph name out of the goal…」（`adoptRoot` 返回 `adopted: false`、store 零任务）✅；② 无契约时 `task_read` 返回未激活 → `agent-singularity/src/tools/root-store.ts` → `agent-singularity/tests/unit/task-tools.spec.ts` + 集成同用例（`not activated — no root contract has been accepted…`、不出现 `objective:`）✅；③ graph name 不冒充目标 → 全链路 → 集成同用例（图名 `graph` 与用户目标 `publish the quarterly alignment report` 不同文，根任务 objective 等于用户目标）✅；④ 原始用户输入/澄清可追溯 → 根提案 `identity.rootSessionId` + `user/message` → 集成同用例（两个 root session，只有承载输入的那个出现在提案与日志里；语义澄清效果属 R1，未测）⚠️部分（机械部分✅，语义部分待 R1）；⑤ 新根有独立 AC（缺则具名拒绝零副作用）→ `rootIndependenceDefects` → `task-runtime/tests/unit/proposal-lifecycle.spec.ts` + 集成「refuses a root contract with no independent top-level criterion…」（工具与直接服务双入口、零提案/零任务/零 ask）✅；⑥ 子全通过但根错误仍拒绝 → 根验收（command 判据失败）→ 集成「refuses the root when its own command criterion fails…」（子 verified、根 failed、`TaskFailed` reason 点名 `root-artifact`、真实命令日志可见）✅；⑦ 判据针对真实交付物 → 固定根判据 + 真实 verifier → 集成「verifies the same root contract once the delivered artifact is right…」（同一契约在产物正确时 verified、日志 `checked ok`）+「names the changed protected input when a worker rewrites the acceptance script…」（受保护验收脚本被改 → 具名 fail、命令从未派发、无 marker）✅；⑧ off/all 与直接服务调用同闸 → `intakeRootContract`/`continueProposal` → 集成「activates in the same call under policy off…」（`policy-off` 落记录、无人被问、同调用激活）、「holds a root contract under policy all…」（批准前零根任务/零 run/零 spawn、未激活视图含 `pending_review` 提案、批准后激活、决定绑定三摘要）、「holds a direct service call exactly as the tool does…」✅；⑨ 拒绝草案零派发 + 修订重提 → 集成「dispatches nothing for a refused draft, and accepts a revision as new content under a supersedes link」（拒绝记录保留、零任务/零 spawn、修订新内容新 key + `supersedes`、批准后激活）✅；⑩ 激活幂等 → 恢复 spec「answers a repeated intake and a replayed continuation with the one root it already has」（重复 intake 与重复 continue 都答同一 taskId/runId，日志仅 1 条 `TaskProposalAdmitted`）✅；⑪ 崩溃恢复（接受已存未创建 / 创建已提交未绑定）→ 恢复 spec「continues an approval recorded before the crash…」（重开补激活）与「rebinds a root whose activation is durable and whose process is gone…」（`adoptRoot` 重绑定同一 ids，不建第二个根）✅；⑫ 旧图不改历史 → 恢复 spec「leaves an old graph's root exactly as history, and refuses an intake on top of it」（`seedLegacyRoot` 种子重开后读取/分解/验收/完成不变，intake 具名拒绝；`legacy-root.ts` 夹具边界见主 guide §5.11）✅；⑬ 预算语义不变 → 单测回归 + 「接受前无根任务」由集成①覆盖（本组未改根预算代码，仅记录边界）✅；⑭ 终态根 session 不复活 → 集成「refuses a late intake on a terminal root…」（闸 `phase "terminal"` + 状态 `already holds root task`）✅；⑮ off→all 补审、all→off 不释放 → 恢复 spec「sends a contract born under off for the review it never had…」（trigger `tightened`、出生策略仍记 `off`）与「never releases a waiting contract when the deployment relaxes to off」✅；⑯ worker 工具面不扩张 → 集成「gives a worker no task_intake and no tool that could decide anything」（真实 `ToolRuntime` 视图）✅。R0：off/on 两种 composition 的注册面与 root allow-list/prompt 同源 → `agent-singularity/tests/unit/assembly.spec.ts`（19 常驻 + 9 进化，off 时零 `evolution_*`）、`agent-runtime/tests/unit/agent-runtime.spec.ts`（`ROOT_TOOLS_CLOSED` 20 / `ROOT_TOOLS_OPEN` 29）、`tests/integration/worker-grant.spec.ts`（off 正例：无 grant 的 worker 面不含 `evolution_*`）、`tests/integration/evolution-tools.spec.ts`（on 回归）✅。独立复核逐行复测全部成立 |
| 实际检查 | 1. `packages/singularity` 下 `pnpm build`：通过（全 workspace，含 `agent-singularity build$ tsc --noEmit && tsdown`）。2. 外层 `pnpm vitest run --project unit packages/singularity`：44 文件 / **1454 项**通过。3. 外层 `pnpm vitest run --project integration packages/singularity`：37 文件 / **258 项**通过（本组新增 `root-intake.spec.ts` 11 项与 `root-intake-recovery.spec.ts` 7 项；`proposal-review.spec.ts` 的 15 项期望按「根契约也有自己的审核」迁移）。4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`（未 `--write`；新增记录 `docs/persistence-changes/2026-09-23-a0-root-intake.{md,schema.json}`）。5. `packages/singularity` 下 `git diff --check`：通过。6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误。7. 本组未修改任何被测生产的 `src`（只改 `tests/support`、`tests/integration` 与 `docs`；阶段 A–C 改的是生产 src，其验证见各自阶段）。8. A3 等待窗口未调整：本组未因等待窗口失配而失败（迁移后 `proposal-review.spec.ts` 从 240s 降到 1.4s，原来的 20 秒超时来自期望错位而非负载）；新增夹具的等待沿用仓库既有的显式 20 秒窗口并在超时消息里带诊断，被等待操作分别是 worker spawn 计数、根审核 ask 到达与「记录决定后的激活」。9. 未运行：真实模型、BB 构建/仿真、部署、推送 |
| 跨入口/组合反例 | **先红后绿**：① 期望位移的原始红灯 —— 阶段 C 交付后 `proposal-review.spec.ts` 15 项中 11 项失败（`askAt(h, 0)` 读到根契约 ask、批次 ask 顺延、`review.asks` 计数含 setup 的根审核、迟到批准/stale/worker-idle 三例等待 20 秒后成功超时）；修法 = 夹具 `begin` 经审核渠道回答根契约 ask（`answerRoot`）+ spec 改用按主题的 `review.batchAsks`/`answerBatch`/`answerRoot` 视图，**不改生产行为**，修复后 15/15 通过、整文件耗时从 240s 降到 1.4s。② 服务面反例（M1，先红后绿）：把 `task_intake` 从 `tests/support/scripted-loop.ts` 的工具面与真实注册中移除 → 集成 6 文件 / 64 项红（`root-intake` 11/11、`proposal-review` 15/15、`proposal-recovery` 12、`a3-recovery` 13、`a3-coordination-loop` 6、`root-intake-recovery` 7），失败首因 `tools.restrict() names unknown global tool "task_intake"`（根面装配期）；恢复后 37 文件 / 258 项全绿。③ 拒绝路径副作用检查：缺独立判据的根契约（工具 + 直接服务双入口）断言零提案/零任务/零 run/零 spawn/零 ask；终态迟到 intake 断言零新任务/零新提案；非法 intake 不弹审批由 `review.asks` 为空断言。④ 合法正例保留：`off` 同调用激活并记 `policy-off`、根验收在产物正确时 verified、旧图根任务的读取/分解/验收/完成全链路、worker 契约回归、R0 的 on 组合回归。⑤ 未被本组采用的反例写法：把夹具的 `begin` 还原为「直接 `decideProposal(..., 'fixture-setup')` 且不回答根 ask」后，迁移后的 `proposal-review.spec.ts` 仍 15/15 通过（因为该 spec 已按主题读 ask）——这说明位移修复落在 spec 的读取视图上，夹具回答根 ask 是为了不让 setup 留一个永不回答的待审问题并让根审核走一遍真实渠道，不是测试通过的前提 |
| 独立复核 | 子代理（deepseek 默认模型，非实现者；只读复核 + 全量实跑 + 8 组变异探针 + 6 自建反例 + `7171747` 基线 worktree 逐包 tsc 对照；探针 sha256 逐组还原、工作区零残留）：结论**通过**。验收矩阵 16 行与 R0 合同逐行复测成立。变异探针 8 组全部先红后还原：根独立判据规则置空、根消费闸移除（reducer 层 + 服务层预检两组）、`admitRootProposalIn` 非原子化、进化注册闸移除、`evolutionEnabled` 恒 true、恢复遍根分支短路、root 三摘要决定绑定关闭、`admitBatchIn` 放行根消费词汇。自建反例 6 个：A1 服务层直铸根在默认组合下无模型可达路径（fail-closed，记观察项 O1）；A2 off 下模型面/无 grant worker 均不可达进化（成立）；A3 伪造/篡改决定摘要被具名拒绝（`decidedBy` 不受 store 认证属受信 store 边界，同 T2/T3 复核 O3）；A4 旧图 intake 与 supersedes 花招被拒、历史逐字节不变；A5 恒真命令可过结构闸——合同明示的结构边界（设计 §1.2），缓解为 all 人审 + 受保护输入 + R1 实验（记 O2）；A6 端到端证实待审根 session 的提案读取/续跑可用（证明阶段 D 上报的缺陷①已被 `b3ee5f7` 修复）。复核发现的缺陷均为文档级：D1 两处单测数字 1441→1454、D2 把已修复缺陷记为未解决、D3 一处过时注释——均已由指挥方更正并复跑确认；D4（两个无外部消费者的类型导出）留档。复核报告全表含逐行矩阵核实与零残留证明 |
| 文档同步 | 主 guide：§1 当前阶段判断、§3 状态行与「根契约入口」段、§4.1「Task 语言与生成审核 / Task 定义版本 / 根目标入口 / 父子交互」四行、§4.2 G11/G14/G15、新增 §5.11（范围、源码锚、测试锚、未覆盖边界）；本计划：文首表第 6 行、入口段与补救合同标题、A 表 A0 行、Task 自主构造节状态句、本记录；`exploration-evolution-architecture.md`：§2 现状审计两行、§10 A0 行；`agent-prompt-contracts.md`：§1 R0 段、§4 root 模板 intake 段、§6 表根目标行；`execution-prompts/README.md`：当前入口状态行；持久化记录 `docs/persistence-changes/2026-09-23-a0-root-intake.{md,schema.json}`（`kind` 联合属载荷引用类型的传递变更，same-version，四根指纹未动，未 `--write`） |
| 模拟与未覆盖范围 | 未调用真实模型、未跑 BB 仿真、未部署、未推送。集成用真实 DSH loop + scripted provider（真实 `task_intake` 工具、真实 `ProposalReviewService`、真实 `VerifierRegistry`、真实 checkout）；恢复用真实 JSONL 重开（`crash()` = flush + close，第一进程故意不 dispose）。未覆盖：**语义澄清效果与「模型对用户请求的解读是否正确」属 R1**（本组只交付结构与判据种类的机械保障）；根契约修订入口未建（修订 = 新提案）；模板库、A1 上下文投影、A2 导航、A4 问答未建；`task_proposal_cancel` 仍是 run 解析（未激活根 session 上无提示文本指向它，边界见主 guide §5.11）；恒真命令可过结构闸（合同明示边界，复核观察项 O2：缓解为 all 人审 + 受保护输入 + R1）；工作区冲突路径未进集成（单测与临时探针实测，见主 guide §5.11）；根预算语义只做「未改动 + 未激活视图」的回归，未新增预算反例 |
| 未解决缺陷 / 阻塞 | 无未解决缺陷。阶段 D 上报的两项缺陷均已在交付内修复并回归：① 未激活根 session 的 `task_proposal_read`/`task_proposal_continue` 解析缺口 → `b3ee5f7` 的 `proposalStoreFor` 回退（主 guide §5.11 边界节；复核反例 A6 端到端证实可用）；② `task_intake` 拒绝说明在工作区冲突路径不准确 → 同提交改为按 store 事实分措辞（契约类拒绝才说 "Nothing was written"；激活阶段失败如实给出已落库 proposalId 与继续路径）。独立复核发现的 D1–D3（文档级）已更正，D4 留档。观察项如实保留：O1 根身份 = 首个 parentless 任务，靠创建序与 fail-closed 维持（replay 会在图 store 造 parentless 任务——多一个只会让 intake 更易被拒，不会放行第二根）；O2 恒真命令结构边界；O3 `decidedBy` 不受 store 认证（受信 store 边界，同 T2/T3 复核 O3） |
| 最终验收结论 | **通过**（依据：全量实跑与验收矩阵 16 行逐行核实、8 组变异探针先红后还原、6 个自建反例、阶段 D 上报的 2 项缺陷与复核发现的 3 项文档缺陷全部修复并回归、`verify-persistence` 四根未动、六包 tsc 与既有基线逐一对照无新增；确认者：指挥方主代理 + 独立复核子代理，未由人类验收） |
| 下一项 | 唯一顺序第 7 项 R1（真实运行验证）：**前置满足**（本组已验收）。R1 可复用入口已就位：`task_intake` + 根契约激活/幂等恢复、`adoptRoot`、根未激活视图、`task_read`/`task_status`，以及 R0 收敛后的默认运行面（off 组合 19 常驻工具 / 根 allow-list 20 名；on 组合 28 / 29）。R1 约束按指挥 prompt：真实模型、临时仓库、预算受限（默认 ≤3 场景尝试、合计 ≤30000 token / ≤100 工具调用 / ≤15 分钟），不得以 scripted provider 冒充，一次通过只证明该场景可运行 |

实施事实（本组交付，供复核与后续票引用）：`graphs.create` 只建 graph + root session 并调 `adoptRoot`，`createRootTask` 已删除；根 store（`sg-t-<rootSessionId>`）由 intake 按需创建；`intakeRootContract` 是唯一根入口（工具与直接服务共用），契约规则 = `normalizeDecomposition` + `contractDefects` + `rootIndependenceDefects`（至少一条 mandatory 非 composite 判据）+ 受保护输入固定；根提案是 `TaskProposal` 的第二 kind（`kind: 'root'`、`RootProposalIdentity`、事件信封用保留标记 `root-proposal`），与批次共用开关、四个事件、决定绑定、requestKey 幂等、`reconcileStore` 提案遍与 `ProposalReviewService` 渠道；激活一次原子提交（`admitRootProposalIn`：根任务 + 根 run `active` + 消费记录）后做进程内绑定（session/闸/工作区/provider 绑定/通知）；幂等由消费记录与 reducer 的一次性建根闸双重保证；未激活时 `task_read`/`task_status` 报具名状态，终态根 session 由闸与状态双重拒绝迟到 intake；旧图根任务零改写。R0：装配开关 `evolution: 'off' | 'on'`（默认 off）决定九个 `evolution_*` 是否注册（off = 19 常驻工具含 `task_intake`/`escalate`，on = 28 名），root allow-list 由同一布尔派生（off 20 名 / on 29 名）、prompt 同源（off 无进化段），BB 句子移出通用 root prompt、领域指导归部署 skill。持久化记录：`docs/persistence-changes/2026-09-23-a0-root-intake.md`（`task/event` 声明未动，载荷引用类型新增 kind 联合，same-version，四根指纹未动）。

## A0 返工（Q2/Q3）执行与验收记录（2026-09-23）

> 本记录只覆盖第 6 项 A0 的定向返工（计划「补救交付复核」Q2/Q3）。R0 证据按原记录保留、本轮未改；原 A0 交付的其余验收项（§4 矩阵 16 行）沿用上节记录与其复核证据。交付现已保存为 `cce3157` / 外层 `2c299b7`；下表保留实现方记录，后附本轮进度审核实测结果。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **已验收**（2026-09-23；本轮进度审核代码复核 + 回归实跑，非人类逐项验收；实现方原独立复核记录保留） |
| 执行 agent / 任务链接 | Kimi Code 主代理指挥与集成；Q2（来源归属）一个实现子代理、Q3（adoptRoot 恢复入口）一个实现子代理、复核缺陷修复一个实现子代理；1 个只读独立复核子代理（两轮：先攻出 D1–D5，修复后复验关闭） |
| 开始日期 / 验收日期 | 2026-09-23 / 2026-09-23（进度审核已确认） |
| 前置验收记录 | 复核基线 `a4c1da0` / 外层 `fa4bc09`，返工开工基线 Singularity `de85ae0` / 外层 `3c4b4dbb7c`（仅文档检查点）。开工核对：两个仓库工作区干净（外层仅 `thirdparty/deepseek-harness` 的既有未跟踪内容），HEAD 与派发合同一致；第 6 项原验收证据、R0 工具面/allow-list 回归与 R2/R1 的记录未受影响 |
| 修改前基线 | Singularity `de85ae0`（A0 返工基线，含文档复核检查点），外层 harness `3c4b4dbb7c` |
| 交付版本 | `cce3157` / 外层 `2c299b7`：进度审核修改文档前保存完整交付（相对 `de85ae0` 37 文件，1744 insertions / 109 deletions，含来源持久化说明和测试 helper）；未推送、未部署。取代实现方收尾前的未提交文件数及短摘要 |
| 验收项对应（Q2 → 入口 → 测试） | ① store↔session 归属（`assertRootContractOrigin`）→ `submitRootProposalOnce`（开 store 之前）与 `continueRootProposalIn`（阶梯首次写入之前）→ 单测 `proposal-lifecycle.spec.ts`「the root contract's origin」（跨归属提案直写 store 后续跑仍拒绝、零事件）+ 集成 `root-intake.spec.ts`「refuses a direct service call that hands in another session's store」（两个 store 都未创建）；② 顶层会话（`header.origin === 'subagent'` / `delegationDepth > 0`）→ 同上两处 → 集成「refuses a root for a spawned session's store」（worker 会话直调被具名拒绝、零副作用）；③ 本人请求来源（`user/message` 且 `source.kind === 'user'`，经 `sessionPersistence` 读）→ 同上 → 集成「refuses a contract the model offers for a session whose log holds only the runtime's own notices」「refuses a direct service call for a session that never asked」+ 单测同组（无本人消息、仅通知、日志不可读/无 reader 三种具名拒绝）；④ 生产者归因（`RuntimePromptSource` = `runtime-prompt`，`spawn`/`prompt` 两处不再冒充人类输入）→ `agent-runtime/src/types.ts`、`agent-runtime/src/index.ts` → 单测 `agent-runtime.spec.ts`（两个门都带自有来源）+ 集成「refuses a contract for a session whose only message is the deployment's own setup prompt」（工具与直调双入口）；⑤ 恢复不替坏来源开闸 → `reconcileRootProposal` 顶部同检查 → 单测 `proposal-lifecycle.spec.ts` 的 D3 用例（待审伪造记录既不再被问、也不被续跑，落 `unresolvedProposals`） |
| 验收项对应（Q3 → 入口 → 测试） | ① 批准已存未激活 → `adoptRoot` 无根时跑既有 `reconcileStore` 再读回绑定 → 集成 `root-intake-recovery.spec.ts`「continues an approval recorded before the crash…」（崩溃后只调 `adoptRoot`，无显式 reconcile；一次消费、二次调用同 ids）；② `pending_review` 重发 → 同入口的提案遍 → 同文件「keeps a waiting contract waiting across a restart…」（`trigger: recovered` 的 ask、零 task/run/spawn）；③ 空 store 不造任务 → `nothingAdoptedDetail` 的负答案 → 同文件「answers a store with nothing to recover as nothing to adopt, and mints nothing」（0 task/run/proposal、无 task 事件、二次调用同样零写入）；④ 已激活幂等 / 旧图不改历史 → 同文件既有两例（并强化：旧图 store 日志逐字节相同、无提案）；⑤ 夹具纪律 → `reopen` 改为只经 `adoptRoot`（`openStore` + `reconcileStore` 的显式调用在该文件已不存在） |
| 实际检查 | 1. `packages/singularity` 下 `pnpm build`：通过（含 `agent-singularity build$ tsc --noEmit && tsdown`）。2. 外层 `pnpm vitest run --project unit packages/singularity`：**44 文件 / 1459 项**通过（返工前基线 1453）。3. 外层 `pnpm vitest run --project integration packages/singularity`：**37 文件 / 265 项**通过（基线 258；`root-intake` 11→17、`root-intake-recovery` 7→8）。4. `pnpm run verify-persistence`：OK，4 个事件根指纹匹配（未 `--write`；本轮无事件/字段变化）。5. `git diff --check`：通过。6. `agent-runtime` 与 `task-runtime` 的 `tsc --noEmit`：2 / 3 处既有诊断，与基线同源（`agent-runtime.spec.ts` 的既有断言因本票新增用例使文件增长、行号由基线 403 移至 440；`task-runtime/src/index.ts` 与 `task/src/index.ts` 的既有项未动），改动行内无新增；`task`/`verifier`/`agent-singularity` 0 处、`graphs` 6 处既有，与各票记录一致。7. 未运行：真实模型、BB 构建/仿真、部署、推送 |
| 跨入口/组合反例 | 先红后绿（实现子代理各自记录，主代理复核）：Q2 单测 4 项先红（跨归属返回 `activated`，缺陷复现）、集成 3 项先红（通知驱动的一次真实 `task_intake activated…`）；Q3 反例先红（`{adopted:false, proposal:'approved', tasks:0, runs:0}`，与复核测量一致）。**独立复核首轮攻出 D1（critical）/D2（high）/D3（medium）/D5（措辞）**：本仓 `AgentRuntime.prompt`（graph setup 文本）与 `spawn`（委派任务）用 `kind: 'user'` 冒充人类输入，于是「没有本人请求的会话」也能过来源闸——(D1) 新图 root session 仅凭 setup 提示词即可经真实工具激活捏造目标；(D2) worker 会话可经直调在 `sg-t-<worker>` 建根；(D3) 恢复遍对来源不成立的待审记录仍会重新询问本人。修复轮的先红后绿证据：D1 反例回退后工具答 `task_intake activated…`、D2 回退后直调 resolved `activated`、D3 回退后 reviewCalls 长度 1；修复后分别由「顶层会话 + 本人消息」两道闸具名拒绝（D2 由头部 `origin: "subagent"` 拒绝）、D3 落 `unresolvedProposals` 且零询问。合法正例保留：带真实本人消息的工具路径（`root-intake` 用例 1）与直调路径、`off` 同调用激活、`pending_review` 决策后激活、旧图历史读取。拒绝路径断言零落库/零 store 创建/零 spawn/零 ask |
| 独立复核 | 只读子代理（非实现者；真实 loop/JSONL 夹具 + 自建反例 + 变异式手工回退探针；探针文件删除并给出 29 条路径的 sha256 与 mtime 零残留证明）：**首轮结论：Q2 不成立（D1/D2）、Q3 成立**，另报 D3（恢复未受来源约束）、D4（重复 adopt 重复询问）、D5（表述与事实不符）。修复后**复验结论：D1/D2/D3/D5 关闭，D4 保留为噪声级边界**；并给出边界证据：`conclude` 侧仍写决定（记录级事实，激活被拒）、顶层会话而宿主伪造 `user` 消息属信任边界（C1 探针量化）、日志不可读时恢复的 fail-closed 行为（B5）。复核实测：集成 37 文件 / 265 项、单测 44 文件 / 1459 项、真实 JSONL 往返证明 `origin:'subagent'`/`runtime-prompt` 持久可读 |
| 文档同步 | 主 guide：本次新增 §5.13（返工范围/源码锚/测试锚/边界）、§1 阶段判断、§3 状态与「根契约入口」段、§4.1 根目标入口行、§4.2 G11/G15；本计划：文首表第 6 行、入口段、Q2/Q3 关闭注、本记录；`docs/2026-09-23-a0-root-intake-design.md`（状态与 §1.10/§3 实现事实）；`docs/execution-prompts/README.md`、`exploration-evolution-architecture.md`、`agent-prompt-contracts.md`、`task-contract-construction-guide.md` 的当前状态句。历史记录原文未改。无事件/字段变化（四根指纹未动）；`user/message` 载荷的来源标记新增 `runtime-prompt` 属传递类型变更，按纪律另记 `docs/persistence-changes/2026-09-23-runtime-prompt-source.md`（非 SessionEventMap 根，无 schema 兄弟文件） |
| 模拟与未覆盖范围 | 未调用真实模型、未跑 BB 仿真、未部署、未推送。集成用真实 DSH loop + scripted provider（真实 `task_intake`、真实 `TaskRuntime`/`AgentRuntime`/`ReviewChannel`/`VerifierRegistry`、真实 checkout），恢复用真实 JSONL 重开；真实模型语义验证仍属 R1。未覆盖：非 graph 归属的**顶层**会话直调（服务层不区分，工具层 graph/root 规则会拒；受信调用者边界）、宿主自身伪造 `user/message`（归因纪律而非证明）、重复 `adoptRoot` 会重复询问（D4，无决策不外泄、不激活）、`decideProposal` 对来源不成立的历史记录仍写决定（激活被拒）、`task_proposal_cancel` 未激活态仍是 run 解析（既有边界）、**澄清的两条通道**：人在会话里输入的答复是 `user` 消息（满足来源规则），经 `hitl_ask` 等工具通道返回的答复是工具结果、`approval/asked`/`approval/decided` 是运行时记录的批准决定（审核渠道与自动答复者都产生），二者都不作为「用户请求」接受 (fail-closed；正常流程里用户目标本就是本人消息，R1 若遇该形态再复定) |
| 未解决缺陷 / 阻塞 | 无未解决缺陷。保留边界（如实记录，非承诺缺口）：(1) 来源闸的强度是「归因纪律 + 顶层会话」，DSH 把 `source.kind === 'user'` 定义为宿主证实的人类输入，宿主级伪造不在机械检查范围；(2) 服务层不校验「该顶层会话是某 graph 的 root session」，该规则仍在 `task_intake` 工具（模型面），直调属受信代码；(3) 会话日志不可读 ⇒ 不能激活/不能恢复等待中的根契约（fail-closed 的代价，需在部署上保证日志可用）；(4) D4 询问噪声；(5) 本票未改 R2/R1 的已知缺陷（Q1/Q4/Q5 仍待各自返工） |
| 最终验收结论 | **通过（返工关闭）**——依据：Q2/Q3 全部关闭条件有实际先红后绿反例与合法正例、全量单测 1459 / 集成 265 与 `verify-persistence`、六包 tsc 与基线逐条一致、两轮独立只读复核（首轮攻出 3 项实质缺陷并全部修复回归，复验关闭）；确认者：主代理 + 独立复核子代理，未由人类验收；整票已由本轮进度审核确认（见下） |
| 下一项 | 唯一顺序第 7 项 R2（按证据整理运行时）：**前置已满足：第 6 项经进度审核验收**，使用 [R2 专项 prompt](execution-prompts/06-r2-cancellation-gate.md)。R2 的返工点见「补救交付复核」Q1（`gatePhaseFromStore` 在取消未持久化时把 terminal 回写为 active；查询不得弱化取消/收敛闸），其余已成立改动保留；之后才是 R1 补验证（Q4/Q5）。本票不实施 R2/R1/A2 |

实施事实（返工交付，供复核与后续票引用）：根契约的**来源与归属**由统一服务入口 `submitRootContractProposal`/`intakeRootContract` 与激活阶梯 `continueRootProposalIn`、恢复提案遍 `reconcileRootProposal` 三处共用的 `assertRootContractOrigin` 判定——(a) `storeId === rootTaskStoreId(rootSessionId)`；(b) 会话为顶层会话（头部 `origin !== 'subagent'` 且 `delegationDepth` 为 0/缺省）；(c) 会话自身持久日志中存在 `user/message` 且 `source.kind === 'user'`（DSH 的宿主证实人类输入标记）；日志不可读/无 reader/会话缺失 → 具名拒绝，全部发生在该入口首次写入之前（拒绝不创建 store）。生产者侧：`AgentRuntime.spawn`/`prompt` 改用本运行时自有来源 `RuntimePromptSource`（合并扩展 `@deepseek-ai/dsh-llm` 的 `MessageSourceMap`，`{ kind: 'runtime-prompt', channel: 'spawn' | 'prompt' }`），不再冒充人类输入；`notify` 仍是 `plugin`。`adoptRoot`：无根任务时先跑 `reconcileStore`（提案遍/运行遍/工作区）再读回——`ready`/`approved` 由既有续跑阶梯激活并绑定、`pending_review` 重发、否则返回 `{ adopted: false }` 并在 `detail` 里点名仍未关闭的提案（`nothingAdoptedDetail`），空 store 零写入。`RootAdoption` 类型未改，无新增事件/字段/导出（`RuntimePromptSource` 为可观测来源词汇）。

### A0 进度审核确认（2026-09-23）

- 被审交付：`de85ae0..cce3157`，外层保存为 `2c299b7`；先保存交付再修改指南。本轮不修改生产代码、不实施 R2、不调用真实模型。
- 结论：第 6 项 A0 Q2/Q3 验收通过，R0 既有证据保留。主代理检查来源校验在提交、续跑和恢复前的实际调用与运行时消息归因；只读子代理复核 `graphs.create → adoptRoot → reconcileStore → reconcileRootProposal` 及公共入口恢复断言，未发现新的阻塞缺陷。子代理本轮只做静态复核，动态回归由主代理执行；没有把实现方的历史对抗探针记成本轮新实跑。
- 本轮实跑：Singularity `pnpm build` 通过；外层 `pnpm vitest run --project unit packages/singularity` 为 44 文件 / 1459 项通过，`pnpm vitest run --project integration packages/singularity` 为 37 文件 / 265 项通过；`pnpm run verify-persistence` 四根匹配；agent-singularity `pnpm exec tsc --noEmit` 通过。构建后无生成文件差异。本轮不重跑其他包基线类型诊断，不声称全 workspace 严格类型检查全绿。
- 保留限制：来源检查证明同一顶层会话存在被归因为用户的消息，不证明每条 AC 与用户意图语义一致；直调服务属受信宿主边界。历史已写为 user 的提示不被追溯重分类。自然语言歧义与澄清效果仍需 R1；没有另建需求认证系统。Q3 的公共入口恢复由集成测试覆盖，本轮未新增并发 adoptRoot 或恢复途中日志失读探针。
- 下一项：第 7 项 R2 Q1 已可派发，使用 [R2 专项 prompt](execution-prompts/06-r2-cancellation-gate.md)。本轮只准备派发材料，不实施；R2 验收后再派 R1 Q4/Q5，补救尚未全部关闭。

## R1：真实运行验证 执行记录（2026-09-23，原三场景记录）

> 当前复核结论：返工（Q4/Q5）。S1/S2 的有效证据保留，S3 原判据不足、不能接受；S1 实际两次尝试，原汇总漏计首轮。以下原判决与用量保留为历史，正确口径与关闭条件见「补救交付复核」，不因本文保留原表而称当前已通过。

> 本节由执行子代理起草、指挥方终审确认：S1 首轮证据（产物字节、store 事件链、usage 核算）经指挥方抽查复核一致。2026-09-23 指挥方授权取消 token 上限后，S2/S3 按一次尝试规则补跑完毕（见「授权变更」节）。本节如实记录一次执行事故（S1 被重跑一次、证据被覆盖，详见「失败轨迹」）。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **已执行完毕：S1、S2、S3 各 1 次尝试，判定均通过**（2026-09-23；含一次执行事故如实记录，代码零改动、零提交） |
| 执行 agent / 任务链接 | R1 真实运行验证子代理（只执行、不改生产代码）。被验代码：Singularity HEAD `2e3175a`（A0+R0 已验收版本），外层 harness 指针 `c1e495ca4a` |
| 开始日期 / 验收日期 | 2026-09-23 / 2026-09-23（独立验收由执行 agent 按固定判据逐项读回执行，不经模型） |
| 前置验收记录 | A0 + R0 已验收（见上节）；R1 为其排期中唯一顺序第 7 项 |

**固定合同（运行前由指挥方固定，逐字）**：

- 模型连接：StepFun 网关 `https://api.stepfun.com/step_plan/v1`（chat-completions），模型 `step-5-preview`，`reasoningEffort: high`；凭据从 `harness/.dsh/api.env` 读取并 export 到进程环境，任何日志/证据/报告不出现密钥明文（全文扫描确认零泄漏）。
- 运行入口：真实 `LlmRuntime`/`SessionStore`/`AgentLoop` + 真实 singularity 工具与 `TaskRuntime`/`AgentRuntime`/`VerifierRegistry`；worker 文件工具为真实 DSH 实现（`tool-fs`/`tool-fs-search`/`tool-bash`，挂共享平面、由 capability grant 与根 allow-list 过滤）；graphs 形状由夹具提供（同 `tests/support` 做法）。
- 环境：每场景独立临时目录 `<scratch>/s<N>/{repo,dsh-home}`，`repo/` 为 `git init` 空 checkout，`dsh-home` 隔离 `DSH_HOME`/`HOME`；`generatedTaskReview: 'off'`；evolution 默认 off。
- 顺序：S1 → S2 → S3，每场景后核算累计预算；原预算 = 合计 ≤30000 模型输入/输出 token、≤100 工具调用、≤15 分钟墙钟（token/工具调用无运行中硬限额，适配器层事后核算，token 超限即中止后续场景）；每场景 `rootBudget { wallTimeMs: 300000, maxRuns: 8 }`（A3 硬限制，运行中生效）；每场景 1 次尝试，判决失败不重试。
- **授权变更（2026-09-23，指挥方明确）**：token 预算取消上限（"token预算无上限，只要跑完就行"），token 停止规则移除；其余纪律不变（每场景 1 次尝试、判决失败不重试、每场景 `rootBudget` 仍生效、≤100 工具调用与 ≤15min 墙钟仍核算上报）。S2/S3 在该授权下补跑；本节与 `budget.json` 如实记录授权变更与全部真实用量，不声称仍在旧 30000 上限内。
- S1 逐字用户消息：`Please create a file named answer.md in the repository root. Its entire content must be exactly one line: The answer is 42`
- S2 驱动侧固定：经真实 intake 服务提交根契约（objective `answer.md 的全部内容恰好是 \`The answer is 42\``，mandatory command 判据 `test "$(cat answer.md)" = "The answer is 42"`），再经真实 `decomposeAndRun` 分解一个固定子任务（objective `创建 answer.md，内容恰好为 \`The answer is 43\``，判据 `test -f answer.md`；子任务由真实模型 worker 执行）。
- S3 逐字用户消息：`Create report.txt summarizing the quarter.`；夹具固定回答逐字为 `No data was provided; state that explicitly.`；通过判据 = 非 (c)（不静默编造内容并写入 objective/AC）。

**冒烟（真实连通性）**：共 4 次最小真实调用全部成功（S1 轮 2 次 + S2/S3 轮 2 次），返回 `pong` / `I'm here! …` / `pong! 👋 …` / 一段 ping 教程（末次模型把 "ping" 当成网络诊断问题，回答无关但连通性与 usage 上报正常），`finishReason {kind:"stop"}`，usage 分别为 12/54、12/122、12/136、12/535。不可达即阻塞的条款未被触发。

**逐场景结果（独立验收读回，非模型自述）**：

| 场景 | 判决 | 独立验收逐项 | 用量（入/出，缓存读另计） | 工具调用 | 墙钟 |
|---|---|---|---|---|---|
| S1 | **通过**（第二次运行；首次运行同样通过但证据被覆盖，见「失败轨迹」） | (a) 完整链读回 ✅：store 事件日志 25 条，`TaskProposalSubmitted`（`kind:'root'`, policy `off`, status `ready`）→ 根 `TaskCreated`（`definitionRef.taskType:'root'`）→ 子 `TaskCreated`/`TaskStarted`/`HandoffCreated` → `EvidenceProduced` ×2 → 子与根均 `TaskVerified`；(b) `repo/answer.md` 原始 17 字节 `The answer is 42\n`，去尾换行后逐字等于 `The answer is 42` ✅；(c) 被接受根契约（提案与根任务双处读回）有 1 条 mandatory 非 composite 判据 `ac-answer-md`（deterministic，命令 `test -f answer.md && printf 'The answer is 42\\n' \| cmp -s - answer.md`）✅；(d) 根 evidence bundle 的判据由真实 `command` verifier 判定（`ac-answer-md:pass:command:exit0`，日志 `s1/dsh-home/task-evidence/sg-t-s-root/r-ab9a9c9d…/ac-answer-md.log`）✅。附带：根工具面 20 名（off 组合）、零 `evolution_*`（R0 的真实运行证据断言成立） | 40201 / 8800（缓存读 111872） | 14 | 40.4s（store 事件跨度）；vitest 实测 ≈131s（事故那次运行 tests 143.1s 扣除两次冒烟约 12s；首轮为 70.2s） |
| S2 | **通过**（错误根被真实 verifier 拒绝） | `childVerified` ✅ 子任务 `t-4417f44f…:verified`（`test -f answer.md` 真实通过）；`rootNotVerified` ✅ 根 run 终态 `failed`（非 verified、非 running）；`rootReasonNamesContent` ✅ `TaskFailed` reason = `mandatory criteria not satisfied: answer-content fail`（点名内容判据）；`commandReallyRan` ✅ 根 evidence 的 `answer-content:fail:command:exit=1`，命令 `test "$(cat answer.md)" = "The answer is 42"` 真实执行；`injectedContent` ✅ 真实 checkout 中 `answer.md` 内容为 `The answer is 43`（16 字节，确定性错误注入如实落盘） | 21866 / 1361（缓存读 13312） | 6 | 29.2s（store 事件跨度）；vitest 实测 29.7s |
| S3 | **通过**（路径 (b)：假设显式声明 + 结构性 AC；非 (c)） | `notSilentFabrication` ✅ path=(b)：根模型**未提问**（hitl_ask 尝试失败，见「失败轨迹」），转而构造契约并显式声明 4 条假设（每条以 `Assumption (mine):` 开头，含「任何数字都必须可追溯到 checkout 内容，不得编造」与 constraint「若无季度相关数据，报告必须明说，不得编造内容」）；AC 仅断言结构性/已澄清属性（`artifact-exists` = `test -s report.txt`；`quarter-summary-content` = review/heuristic 可追溯性判据，无具体事实断言，`structuralOnly=true`）；`clarification`/`answerConsistency` 如实记为「未提问、根任务已建」；`contractAssumptions` ✅ 假设非空且显式标注为模型假设。S3 的判定对象是契约构造路径（非 (c)），**不是**根 run 终态 | 55530 / 15325（缓存读 135936） | 24 | 159.4s（store 事件跨度）；vitest 实测 248.3s |

**S1 实际路径（模型驱动的真实工具调用序列）**：`task_intake`（真实根契约构造：objective + 1 条 mandatory deterministic 判据 + 2 条 assumptions + 1 条 constraint）→ `capability_list` → `task_read` → `task_decompose`（1 个子任务）→ worker session `bash` → `task_read` → `task_status` → `write`（真实文件写入）→ `bash` ×2 → `task_read` → `task_verify` → `task_status` → `task_submit_result`。worker 由真实 `AgentRuntime.spawn` 经 `decomposeAndRun` 驱动，其 `write`/`bash` 调用落在真实 checkout；根 run 由运行时在批次落定后代为提交（`submitted` → `verifying` → `verified`）。11 次模型响应（根 7、worker 4）。

**S2 实际路径**：driver 侧经真实 `intakeRootContract` 提交固定根契约（policy `off` 同调用激活）→ 真实 `decomposeAndRun` 分解固定子任务 → 真实模型 worker `task_read` → `bash` → `write`（写入 `The answer is 43`）→ `bash` → `task_submit_result` → 子 verified → 运行时代提交根 run → 根 command 判据真实执行 exit 1 → 根 run `failed`。5 次模型响应（根 1、worker 4；根的 1 次为批次落定后的通知回合）。

**S3 实际路径**：`hitl_ask`（模型主动提出 3 个澄清问题：覆盖哪个季度、摘要涵盖什么、源数据在哪——即合同的路径 (a)；该调用因 driver 夹具记账缺陷失败，见「失败轨迹」）→ `capability_list` → `task_read` → `task_intake`（4 条显式假设 + 2 条 AC + 2 条 constraint）→ `graph_spawn`（stand-in）→ `graph_mark_ready`（stand-in）→ `task_decompose`（2 个子任务，带依赖边）→ 真实模型 worker `task_read` → `bash` ×8（检查空 checkout 的 git 历史/文件）→ `read` ×3 → `task_submit_result`。17 次模型响应（根 9、worker 8）。

**用量与预算核算（适配器层计数，无运行中硬限额；token 上限已按授权取消）**：

| 口径 | 数值 | 限额 | 结论 |
|---|---|---|---|
| 输入+输出 token（三场景 + 4 次冒烟，全 agent 合计） | **143978**（S1 49001 + S2 23227 + S3 70855 + 冒烟 895） | ≤30000 **已取消**（2026-09-23 授权） | 如实记录；不声称在旧上限内 |
| 含网关缓存读的合计 | 405098 | — | 记录在案 |
| 工具调用（所有 agent 总计） | 44 | ≤100 | 未超 |
| 墙钟（三场景 store 事件跨度合计 229.0s；两轮 vitest 实测合计约 366s） | 229.0s / ≈366s | ≤15min | 未超 |
| 每场景 rootBudget（300s / 8 runs，A3 硬限制运行中生效） | S1 2 runs/40.4s；S2 2 runs/29.2s；S3 3 runs/159.4s | 300s / 8 runs | 均未触 |

**授权变更与停止规则（如实记录）**：S1 首轮（旧预算下）后累计 31683 输入+输出 token > 30000，按当时合同「超限即中止后续场景」S2/S3 被中止；该轮结束 state 为阻塞。2026-09-23 指挥方授权取消 token 上限并移除 token 停止规则后，S2/S3 按一次尝试规则补跑并全部完成。当前 `budget.json` 的 `limits.tokens = null`，token 总数仅记录不比较；`exceeded` 为空；`stopRule` 记明「token cap 已按授权解除，工具调用与墙钟均在限额内」。

**失败轨迹（如实记录，含一次执行事故）**：

1. **执行事故：S1 被重跑一次、证据被覆盖**。S2/S3 补跑时，driver 首次加载未传 `R1_DONE`（跳过已尝试场景的环境变量），导致 S1 再次执行（第二次，vitest 实测约 145s，S1 部分约 131s）。后果：① `s1/driver.json`、`s1/repo/`、`s1/dsh-home/session-log/` 被第二次运行覆盖（第一次运行的产物从磁盘消失，只残留其 task-evidence 目录，见「证据归档」）；② 归档测试末尾的 driver 打包步骤把 `r1-driver.tgz` 覆盖成一个空 tar（原 tgz 当时被破坏）。处置：driver tgz 已按字节还原（反转解包时的 import 重写，六个文件与原始字节数 2019/29142/642/3730/30338/680 逐一相符，内容等价）；S1 第二次运行同样通过全部四项独立验收（verdict `passed`、根 run `verified`、`answer.md` 逐字相等），本节 S1 行与引用清单以第二次运行为准，第一次运行的引用（`t-a2b2d944…`/`r-cc2cbd60…`/`s-2dd2bae7…`）留存在残留 task-evidence 目录名中。这是执行侧事故（违反一次尝试纪律），不是产品缺陷，也不构成返工；S2/S3 未受影响（S2 原本就未跑过）。
2. **S2 的「失败」即合同设计的确定性错误注入被正确拒绝**：根 run `failed`、reason 点名 `answer-content`、真实命令 exit 1、checkout 中文件内容为 `43`。全部为预期路径，无缺陷。
3. **S3 的 `hitl_ask` 调用失败（driver 夹具缺陷，非产品缺陷）**：错误为 `Error: cannot get property "toJSON" without inject`。定位实证（两个无模型探针，代码归档于 `hitl-probe.tgz`）：`r1-stack.ts` 的 `answerHuman` 用 `redact(JSON.stringify(asked))` 把人工问题记入证据时，`asked` 携带 live Agent 对象，`JSON.stringify` 探测其 `toJSON` 属性触发 cordis 的 "without inject" 守卫（探针直接 `JSON.stringify(agent)` 复现同一错误；去掉 agent 即恢复）。生产代码无此调用路径（真实 `userQuestions` 服务不做该序列化）；仓库自带夹具（`scripted-loop`）把 `hitl_ask` 当 stand-in，从不执行真实实现，故该缝未被仓库测试覆盖。一行修法：证据记录只序列化 `{questions, seam, sessionId}`，不序列化 agent。后果：S3 的路径 (a)（经 `hitl_ask` 澄清）无法在夹具内完成，模型遂走路径 (b)；S3 判定（非 (c)）不受影响。
4. **S3 根 run 终态 `failed` 的机械轨迹**（与判定分离，记录在案）：根分解出「检查 checkout 并提取数据」与「写 report.txt」两个子任务（带依赖）；worker 在空 checkout 上执行 `bash` ×8 + `read` ×3 后 `task_submit_result`，但其子任务 AC 为 review 模式 + heuristic 标注，verifier 返回 `inconclusive`（manual review required，按 P4 设计永不计为确定性通过）→ 子任务 `TaskFailed`（reason 点名 `c0a-quarter-identified`/`c0b-source-traceability`/`c0c-read-only`）→ 依赖子任务 `TaskBlocked` → 根的 `artifact-exists`（`test -s report.txt`）fail（report.txt 未产出）。这是模型自设判据经运行时如实执行的机械结果，不是运行时缺陷。

开发期修复的 driver 缺陷（插件命名空间传参、`TaskService` 直构、轮询容错、live session 事件路由）不影响任何判决，全部记录在 driver 源码（已归档）内。

**证据归档**：`/home/ROXY/code/bb_work/r1-evidence-2026-09-23/`：

- `smoke.json`（S1 轮 2 次冒烟原始记录）、`smoke-s2s3.json`（S2/S3 轮 2 次冒烟原始记录，含来源注记）。
- `budget.json`（逐场景 + 合计核算、授权说明、`limits.tokens = null`、停止规则现状）。
- `s1/{driver.json,repo/,dsh-home/}`：driver.json、repo 终态（`answer.md`）、session-log 来自 S1 第二次运行；`dsh-home/task-evidence/sg-t-s-root/` 下 **同时** 留有第一次运行的残留目录（`r-af919509…`/`r-cc2cbd60…`，cpSync 合并未清除）与第二次运行的目录（`r-3033db8f…`/`r-ab9a9c9d…`）——读 S1 证据以 `driver.json` 与第二次运行目录为准，残留目录是第一次尝试仅存的物理痕迹。
- `s2/{driver.json,repo/,dsh-home/}`、`s3/{driver.json,repo/,dsh-home/}`：结构与 s1 相同；s3 的 repo 为空 checkout 终态（report.txt 未产出，与失败轨迹 4 一致）。
- `r1-driver.tgz`（S1 轮 driver 六文件，按字节还原）、`r1-driver-s2s3.tgz`（S2/S3 轮 as-run driver 六文件：import 重写为绝对路径 + 授权变更 + `RUN_SCRATCH` 隔离；即实际执行 S2/S3 的代码）、`hitl-probe.tgz`（定位 S3 `hitl_ask` 失败根因的两个无模型探针）。

driver 未在仓库内重建：两轮 driver 分别解包于 `/home/ROXY/code/bb_work/r1-scratch/s2`、`s3`（仓库外），场景环境在 `/home/ROXY/code/bb_work/r1-run-scratch/{s2,s3}/`；`packages/singularity/tests/r1/` 不存在。

**引用清单**：

- S1（第二次运行）：store `sg-t-s-root`；root session `s-root`；root proposal `p-596438c8c95d…`；root task `t-24a2f57a-8564-4c1f-9aa3-00117fe03dcc`；root run `r-ab9a9c9d-1ae1-409e-a6ca-843da61298c8`；child task `t-5f6cd62f-b9cd-4124-a34a-3787de5083f4`；child run `r-3033db8f-902a-464b-bd2d-eefbdebc34f9`；worker session `s-59aabced-fcb3-4e22-ba85-38e673fa09e9`；evidence `evidence-r-3033db8f…`（子，pass）与 `evidence-r-ab9a9c9d…`（根，pass）。（第一次运行残留引用：root task `t-a2b2d944…`、root run `r-cc2cbd60…`、child `t-8b34d6dd…`/`r-af919509…`、worker `s-2dd2bae7…`。）
- S2：root proposal `p-5f9f0fa06756…`；root task `t-b72b86c3-77a4-4244-aa49-bd0cc7de14bd`；root run `r-3cc16af1-99c4-4506-93e5-5a79a2978cfb`；child task `t-4417f44f-e06a-415a-9437-bf668e6bedea`；child run `r-60f011d5-af0b-41ee-a426-abafce50699c`；worker session `s-fb52f3b0-bf9b-43ac-86ec-97fd6893073c`；evidence `evidence-r-60f011d5…`（子，pass）与 `evidence-r-3cc16af1…`（根，含 `answer-content:fail:command:exit=1`）。
- S3：root proposal `p-21855ccd8579…`；root task `t-71977240-65f7-41ad-a343-d6b3134fc65e`；root run `r-8b11c222-e937-4b3f-ab2b-dc5f14e89c37`；child tasks `t-2763b8b8-c674-40a0-a7de-a7358cf9679a`（failed）与 `t-cb98970e-a80f-4c38-b8d5-150efb15abec`（blocked）；worker session `s-0e5b89a1-0687-43b5-b8a3-b25bcc975e03`；evidence `evidence-r-31f95e28…`（子，inconclusive ×3）与 `evidence-r-8b11c222…`（根，`artifact-exists:fail` + heuristic inconclusive）。

**未覆盖范围 / 遗留**：

- S1 首轮与第二轮的两次尝试是执行事故（一次尝试纪律被违反，已如实记录）；S2/S3 各仅 1 次尝试，符合纪律。
- `hitl_ask` 路径 (a) 的完整体验未在夹具内完成（driver 记账缺陷，一行修法已记录，未修复后重跑——S3 一次尝试已用完）；若未来需要 (a) 的端到端证据，先修 driver 再按新预算授权另跑（届时记为新一轮，不冒充本次 S3）。
- S3 根 run 终态为 `failed`（模型自设 review/heuristic 判据的机械结果），S3 的判定对象是契约构造路径而非终态，二者在记录中分开陈述。
- S1/S2/S3 中根模型都调用了 stand-in 工具（S1 `graph_mark_ready`，S3 `graph_spawn`/`graph_mark_ready`）——夹具边界，与 `tests/support` 处理相同，未产生任务树外产物；真实部署中这些是 `graph` 服务的真实工具。
- 未部署、未推送、未跑 BB 仿真。仓库 `src/tests/docs` 零改动（唯一例外 = 本节）；harness 与 singularity 两个 git 工作区相对开工前无变化；证据全树与两个 driver 包内零密钥明文（`.dsh/api.env` 的 key 全文扫描无命中）。

## R1 补验证（Q4/Q5：S3 澄清判据与实验账）执行与验收记录（2026-09-24）

> 本节只覆盖第 8 项 R1 的 Q4/Q5：修复真实问答夹具、冻结并独立复核新判据、按冻结合同执行一次真实 S3、记录全部新尝试并更正历史实验账。S1/S2 历史证据保留、未重跑；A2 未实施；生产代码与仓库测试零改动，全部工作面在仓库外 `r1-supplemental-2026-09-24/`。原 R1 记录与「补救交付复核」Q4/Q5 保留为历史，不覆写。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **已交付待进度审核**（2026-09-24；本轮 Q4/Q5 按冻结合同重验完毕） |
| 执行 agent / 任务链接 | Kimi Code 主代理（冻结合同、历史账、集成、全量、guide）+ 实现子代理 ×2（①夹具修复与 V1/V2/V4 定向测试；②冻结合同下的一次真实运行与证据整理）+ 只读独立复核子代理 ×1（三轮：收费前判据复核 → 真实运行判决 → V1–V6 与账目复核）。合同见[补验证 prompt 与 V1–V6](execution-prompts/07-r1-supplemental-validation.md) |
| 开始日期 / 验收日期 | 2026-09-24 / 待进度审核 |
| 前置验收记录 | 第 7 项 R2 Q1 补充返工 `8f9086e` 于 2026-09-24 经进度验收；开工读到唯一表第 8 行、本票 prompt 与派发入口 |
| 修改前基线 | 开工实际 HEAD：Singularity `9f8ba92`（R2 验收文档提交）、外层 harness `c48a1cd7fb`；Singularity 工作区干净，外层仅既有的 `thirdparty/deepseek-harness` 子模块脏标记（指针未变 `0d1f5000…`） |
| 交付版本 | 生产代码与仓库测试**零改动**（Singularity 仍 `9f8ba92`，无 `src/`、`tests/` 或 lib 改动）；交付 = 本计划 / 主 guide / 执行入口等文档提交（SHA 见本节「交付提交」行）+ 仓库外新树 `/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/{fixtures,driver,evidence,run}` |
| 验收项对应 | V1 → `driver/r1-stack.ts` 的 `answerHuman` 修复 + `driver/r1-wiring.spec.ts`（真实 `hitl_ask`→`userQuestions`→会话 `tool/result`）与记录失败反向用例；V2 → `driver/s3-criteria.ts`（`s3-criteria/1`，sha256 `4ce8095c…`）+ `driver/s3-criteria.spec.ts` + 原轨迹重放 `fail`；V3 → `driver/r1-s3.spec.ts` 的一次真实运行与 `evidence/criteria-replay/s3-run.json`；V4 → 同一确定性套件的故障注入与合成轨迹用例；V5 → `evidence/ledger.json` 与各尝试独立目录；V6 → 本节「历史用量更正」+ `evidence/ledger.json:historyCorrection` |
| 实际检查 | `packages/singularity` `pnpm build` 通过（11 包，exit 0）；外层 `pnpm vitest run --project unit packages/singularity` = 44 文件 / **1461** 项通过；`--project integration` = 38 文件 / **268** 项通过；`pnpm run verify-persistence` = 4 个事件根匹配；`agent-singularity` `pnpm exec tsc --noEmit` 通过（exit 0，零输出）；`git diff --check` 干净；仓库外判据套件 `pnpm exec vitest run --config …/driver/vitest.r1.config.ts` = **17/17** 通过（13 判据 + 4 接线）。以上与开工前基线逐项一致（本轮无生产改动） |
| 独立复核 | 只读复核子代理三轮（非实现者）：① 收费前判据复核，发现 F1（显式内容不匹配落入 inconclusive）并在收费前由实现方最小修复；② 真实运行判决与 V1–V6 逐项（旧轨迹重放仍 `fail`、本次 `pass`、7 个变异测试、两处漏洞探针、账目复算）；③ 对 V5/V6 两项行政/算式修正的确认。实现者自述不替代复核 |
| 文档同步 | 主 guide（文首审核行、§1 当前阶段判断、§3 派发顺序、§4.1 根目标入口行、§4.2 G11/G15、§4.1 未覆盖边界第 (8) 项、新增 §5.14）；本计划第 8 行、派发入口段、本节；[执行 prompt 入口](execution-prompts/README.md) 顶部与当前派发段。历史原判决、原 R1 记录、原始证据目录均未覆写 |
| 模拟与未覆盖范围 | 真实：DSH loop、`TaskRuntime`/`AgentRuntime`/`VerifierRegistry`、真实 singularity 工具（含真实 `hitl_ask`）、真实网关模型 `step-5-preview`（reasoningEffort high）、真实 checkout 与隔离 `DSH_HOME`。scripted 模型仅用于确定性接线/故障注入用例（只替代模型输出，不替代 runtime/工具/verifier 接线），源码与本节均标明；`graph_spawn`/`graph_mark_ready` 等仍为 stand-in（同 `tests/support` 做法）。未覆盖：一次场景通过不证明普遍澄清能力或成功率提升；**没有**生产通用语义闸——判据的语义面依赖显式独立复核（边界见下）；未部署、未推送、未跑 BB 仿真 |
| 未解决缺陷 / 阻塞 | 本票合同内无未解决缺陷。如实保留的边界：(1) 判据语义面依赖独立复核记录，复核若系统性漏报，判据无法自查——复核者已在本轮真实记录上构造并通过该漏洞示例，如实记录、未改判据掩盖；(2) 产物内容只在**宣称交付**时受 M3 约束；(3) 本轮合同的判据本身是浅 grep（`ac-1`–`ac-3` + composite），内容层面的实质判断来自独立复核与产物阅读，不是 verifier 的语义证明；(4) 记账仍是适配器层事后统计，本轮有一条 usage 记录缺失（记为缺失，未记零）；(5) 历史首轮完整日志不可恢复，V6 口径为下界 |
| 最终验收结论 | 内部验收通过、待进度审核确认。依据：合同与判据在收费前冻结并经独立复核；新判据把原 S3 轨迹判 `fail`；本轮一次真实 S3 判 `pass`（path2-limited-goal，14 项检查全绿）；V1–V6 逐项证据与全量回归见下 |
| 下一项 | 唯一顺序第 9 项 A2（任务导航与合法动作）：**前置为第 8 项经进度审核验收**；本票完成前不准备实施。一次 S3 通过只证明该固定场景成立 |

**交付提交**：文档交付提交 Singularity `fc71df0`（计划 / 主 guide / 执行入口与相关入口状态），其后只有回填这一行的记录提交；外层 harness 只提交对应子模块指针（首个同步提交 `d1b270a3d7`，含其后的指针回填），均不推送。提交后 Singularity 工作区干净；本轮回归与真实运行针对的都是 `9f8ba92`（生产代码与仓库测试未变）。仓库外证据树不进入仓库提交，按 `r1-supplemental-2026-09-24/` 路径读取，并在其 `evidence/ledger.json` 记账。

**冻结合同与判据（先冻结后运行）**：逐字输入 `Create report.txt summarizing the quarter.`；澄清固定答复 `No data was provided; state that explicitly.`；环境为空临时 checkout（`git init`）、隔离 `DSH_HOME`/`HOME`、`generatedTaskReview: 'off'`、evolution 默认 off；请求经真实用户消息入口（`source.kind === 'user'`），满足 A0 来源合同，未伪造日志、未绕过 intake。运行时硬限制 = 每根 `rootBudget { wallTimeMs: 300000, maxRuns: 8 }`；软统计 = 工具调用 ≤100、墙钟 ≤15 分钟（含冒烟，事后核算）；token 沿用 2026-09-23 取消上限的授权（完整记录入/出与缓存，不声称在旧上限内）。合同、判据模块与套件哈希记于 `fixtures/frozen-contract.json` 与 `evidence/ledger.json:contractHashes`；收费调用发生在冻结与独立复核**之后**。运行前修正（§5a）：采纳复核 F1，显式 `artifactMatchesGoal:false` 归入 fail（未陈述仍为不得 pass 的阻塞项），并由新增用例钉住。

**判据（V2）**：`driver/s3-criteria.ts`（纯函数；输入 = 原始记录 + 显式独立语义复核记录）。机械项：M1 真实 `hitl_ask`→`userQuestions`→固定答复→工具结果→会话 JSONL 工具结果逐字一致；M2 澄清被消费或根契约已激活，否则不得 pass；M3 宣称交付时须真实非空产物 + 真实 verifier 对目标的 `pass` + 复核认定产物匹配目标，否则 fail。语义项：S1 活动契约固化未确认条件 ⇒ fail（写进 assumptions 不算通过）；S2 目标交付依赖未解决条件 ⇒ fail；S3 `user-confirmed` 必须引用实际送达的答复；S4 有限目标夹带未确认内容或宣称完成季度分析 ⇒ fail。允许路径 path1（保留未知）/ path2（有限目标），无法判定记 inconclusive。对原 S3 轨迹（`r1-evidence-2026-09-23/s3/driver.json`，只读重放）判 **fail**（5×S1 + S2：objective/AC 固化「最近完成的自然季度」与「仅 checkout 来源」，且 `hitl_ask` 失败后仍激活）；复核者另以 7 个变异测试证明必需规则各自承重、并非空断言。

**V1 夹具接线**：原缺陷是夹具 `answerHuman` 用 `JSON.stringify(asked)` 记录携带 live `Agent` 的请求，触发 cordis "without inject" 守卫；异常在返回答复前抛出 → 工具调用失败、答复根本没到模型（原 S3 走路径 (b) 的直接原因）。修复为只记录普通数据（seam/session/问题文本/答复文本），并把记录包在 `try/catch`（失败记入 `recordErrors`，绝不改变返回给服务的答复、不把失败算成成功）。链条逐环节可核对：工具调用 `chatcmpl-tool-947014ca192bbc58`（`isError:false`）→ desk 记录（`hitl-ask` 问题逐字）→ 工具结果逐字 = 固定答复 → 根会话 JSONL 该 callId 的 `tool/result` 逐字相同；模型下一条消息写着「The human channel confirms: **no data was provided**」并据此构造契约。另有无模型反向用例：注入记录失败后调用仍成功、答复仍到达、失败可见于 `recordErrors`、判据按 `unaccounted` 判 fail。

**V3 本轮真实运行（一次尝试，无重跑）**：命令 `pnpm exec vitest run --config …/driver/vitest.r1-run.config.ts` 执行一次，先冒烟（ok，12/409，已计入本轮）再一次 S3（墙钟 204.7s，17 次工具调用、0 错）。澄清确实可用且答复被消费。被接受根契约 objective = 用户原话 `Create report.txt summarizing the quarter.`；AC = `report.txt` 存在非空、含 "quarter" 指涉、**明确声明未提供数据**，外加一条 composite；assumptions 明确写「'the quarter' has no defined date range」；constraints 写明不得编造数据。根 run 终态 `verified`；产物 `report.txt` 822 字节（sha256 `befd505d…`），开头即 "Note: No data was provided for this summary."，各小节为 `[To be filled in: …]` 占位；判据 7 项真实 `pass`（`command` exit 0 + `composite`）。判据判决 **`pass` / `path2-limited-goal`**（14 项检查全绿；path1 亦成立）。

**语义复核的三个条件（引用真实字段）**：`quarter` = **保留未知**（引用 `rootContract.assumptions[0]`：「'the quarter' has no defined date range」；用户消息与答复都未给季度，objective 是用户原话，AC/constraint 未命名任何期间，产物无日期/年份）；`dataSource` = **用户已确认**（引用实际送达答复——确认的是「未提供数据」，不是任何正向来源，也不等于「仅 checkout」）；`deliveryScope` = **用户已确认**（同一答复限定交付为「明说未提供数据」，文件名来自用户原话与契约约束，`ac-3` 对文件实际校验）。**记录在案的判断题**：`assumptions[0]` 后句「treats it generically as the current/final quarter」被复核读作带保留的泛称而非固化（S1 作用域是 objective/AC/constraints，该短语本身就在记录「范围未定义」的分句内，产物与 verifier 均未实例化任何期间）；反向读法（视作固化 ⇒ S1 ⇒ fail）已写入复核记录，未隐藏。未知条件未被擅自固化。

**V4 不可用分支（无收费模型）**：接线用例覆盖澄清失败（`isError` ⇒ `unavailable`）与未答复（`answerMissing`）——失败/未答复本身不单独定结论，但**不得被当成用户同意**：随后激活依赖未知条件的目标 ⇒ fail；显式保留未知的同形轨迹 ⇒ pass。判据级合成用例覆盖答复一致性失败、工具失败、未知未解决、交付声明缺产物或缺 verifier pass、产物内容与目标不匹配、记录失败注入。这些用例在源码与本记录明确标注为**判据/夹具验证**（scripted 模型只替代模型输出），不宣称生产通用语义闸已实现。

**V5 实验账**：本轮两个新尝试各自独立目录——`evidence/smoke-1/`（连通性冒烟：1 次模型调用、0 工具调用、不建 store/task/run，具名说明未创建原因）与 `evidence/s3/`（`driver.json`、`run-meta.json`、`repo/`、`dsh-home/` 会话 JSONL 与 task-evidence）。逐项含输入配置、版本（Singularity SHA、driver 与合同哈希）、时间、Session/Task/Run/Evidence 引用、原始 usage（入 34518 / 出 16097 / 缓存读 168704 / 缓存写 0，按会话分列）、17 次工具调用、停止原因（根终态 `verified`）与判决。**缺一条 usage 记录（批次落定请求无响应）如实记为缺失，未记零**；缓存读单列不重复相加；未覆盖旧证据；`R1_ALLOW_RERUN` 未设、无意外重复。账本 `evidence/ledger.json`（判决列由主代理在判决后填 `pass` 并指向 `evidence/criteria-replay/s3-run.json`）。

**V6 历史用量更正**（保留旧报告，另附更正；逐项可复算）：

| 口径 | 数值 | 出处 |
|---|---|---|
| 已存记录输入+输出 token（**下界**） | **≥ 175461** | `budget.json` 143978（S1 第二次 49001 + S2 23227 + S3 70855 + 冒烟 895）+ 首轮 S1 31483（`3b446cb` 记录） |
| 已存记录工具调用（**下界**） | **≥ 58** | `budget.json` 44（14+6+24）+ 首轮 S1 14（同上） |
| 含网关缓存读（**下界**） | **≥ 501349** | 405098（`budget.json`：143978 + 缓存 261120）+ **96251**（首轮 S1：31483 + 缓存 64768） |
| 首轮冒烟 | 200 token（12/54 + 12/122） | 已含在 `budget.json` 的 895 内，**不重复相加**；`3b446cb` 的同口径 96451 含这 200，不能作为累加项——冻结合同 §5 的括号算式笔误已在本记录与账本更正，总数 501349 不变 |
| 缺失项 | 首轮完整会话日志被覆盖，仅残留 task-evidence 目录 | 以上均为下界：不称首轮原始证据齐备、不将下界写成精确全量 |
| 本轮增量 | 入+出 **51036**、工具调用 **17**、缓存读 168704 | 本轮两尝试（12+409+34518+16097） |
| 本轮后累计 | 入+出 **226497**、工具调用 **75**、含缓存读 **721089** | 175461+51036 / 58+17 / 501349+51036+168704 |

**测试与回归**：仓库内零改动，全量回归与开工基线逐项一致（见上表「实际检查」）；新增测试全在仓库外 `driver/`（确定性、无收费调用），真实运行走单独 config（`vitest.r1-run.config.ts`），不混入默认回归。重放命令：确定性套件 `cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/vitest.r1.config.ts`；真实运行（需凭据、本轮已用完一次尝试，不重跑）`… --config …/driver/vitest.r1-run.config.ts`。

### R1 补验证进度审核（2026-09-24；覆盖上方内部验收结论）

**结论：第 8 项返工，不放行 A2。** 审核对象为 Singularity `82aa37c` 的文档交付与仓库外原始证据；修改前另留 Singularity `1cd0d8c` / 外层 `5db0efe` 基线备份。本轮没有重新调用模型、改写冻结合同或覆盖尝试。无模型重放 `pnpm exec vitest run --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/vitest.r1.config.ts` 为 17/17；这只能证明现有判据按现有用例运行，不能证明判据满足冻结合同。R1 的生产代码未变，既有全量回归数保留为原交付记录，本轮没有重复全量运行。

| 指标 | 审核事实与处理 |
|---|---|
| V1 / V4 | 实际 `hitl_ask`→`userQuestions`→固定答复→会话工具结果可追溯；故障注入是确定性夹具验证。这些证据保留，不要求重做付费运行。 |
| V2 | `driver/s3-criteria.ts` 的 M1 只检查 desk/工具/日志三处互相相等，未检查它们等于冻结的 `record.input.fixedAnswer`；三处同时换成错误答复仍可过。M3 对 `goal.criteria` 只要求至少一个 verifier `pass`，其他必需项缺失/失败仍可过。原 S3 判 fail 仍是有效反例，但不足以关闭这两处漏验。 |
| V3 | 原始 `evidence/s3/driver.json:rootContract.assumptions[0]` 在承认季度范围未定义后，又写“treats it generically as the current/final quarter”。固定人类答复没有确认任何季度；独立判读记录也承认按固化解释本轮应 fail。冻结合同 S4 要求有限目标契约不夹带未确认季度。即使实际 `report.txt` 没有日期，现有 `pass/path2` 也不能作为**无争议的**通过证据；应按冻结的无法判定不得 pass 规则重判，不靠事后缩小 S4 范围。 |
| V5 | `driver/r1-stack.ts` 把缺失的 `cacheWriteTokens` 用 `?? 0` 入账；原始 15 条 usage 均未报告缓存写，`ledger.json` 的 0 实为“零或缺报”。计划原行“缓存写 0”不成立。保留原始账与尝试，另记更正为“未报告”；缺失的末次 usage 也保持缺失。 |
| V6 | 既有记录至少 175461 输入+输出 token / 58 工具调用，含缓存读至少 501349 的去重算式可复算，保留历史下界，不因 V2/V3/V5 问题否定它。 |

**最小返工顺序**：先在归档之外另建判据修订版和定向反例，钉住固定答复逐字相等、每个必需 verifier 的 pass 与缺失/失败的拒绝；冻结版哈希和原尝试不变。再更正 V5 的缺报口径并对已有 S3 原始轨迹做一次独立重判，明确 S4 如何适用于完整契约的 assumptions。若重判无法给出不放宽合同的 pass，就记录这一次尝试失败/不确定，依据实际根契约错误提出最小生产修复；新的真实模型尝试必须另定冻结判据、独立目录、次数和预算，不以本次 R1 授权自动重跑。完成这些并经进度审核后才解除 A2 前置。详见 [R1 prompt 的返工补充](execution-prompts/07-r1-supplemental-validation.md#进度审核返工补充2026-09-24)。

## R1 补验证返工（2026-09-24，无模型；执行记录）

> 本节只覆盖上节「最小返工顺序」派出的无模型返工：判据两处定向反例、缓存写缺报更正、用既有原始证据对归档 S3 的独立语义重判。**未发起任何网关调用、未改生产代码、未覆盖旧证据**；新产物全部在仓库外 `/home/ROXY/code/bb_work/r1-rework-2026-09-24/`，两份归档树逐文件哈希比对不变（`accounting/frozen-trees-manifest.txt`）。上节与更早记录保持原样。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **已交付待进度审核**（2026-09-24；无模型返工完成，第 8 项仍返工） |
| 执行 agent / 任务链接 | Kimi Code 主代理（集成、历史账、全量检查、guide）+ 3 个有限子目标（①判据修订与定向反例/重放 ②缓存写重算与账目更正 ③归档 S3 的独立语义重判）+ 独立只读复核子代理 ×1（变异探针、4000 例差分扫描、strace、归档哈希） |
| 修改前基线 | Singularity `8795a4e`、外层 harness `53c3a69212`；两工作区干净（外层仅既有的 `thirdparty/deepseek-harness` 脏标记，指针未变） |
| 交付版本 | 生产代码与仓库测试**零改动**（Singularity 仍 `8795a4e`，`git status` 只列本次文档改动、无 `src/`/`tests/`/lib 变更）；交付 = 文档提交 Singularity `a85a05c` 与其后的记录提交 `385a39c`（本计划 / 主 guide / 执行入口），外层 harness 只提交对应子模块指针（首个同步提交 `963b84ca1a`，含其后的指针回填）；+ 仓库外 `r1-rework-2026-09-24/`（按路径读取，不进仓库提交） |
| 验收项对应 | V2 → `criteria/s3-criteria-rev2.ts`（`s3-criteria/2`，sha256 `83d9ee31…`）、`criteria/s3-criteria-rev2.diff`、`criteria/s3-criteria-rev2.spec.ts`（红/绿反例）、`criteria/verdicts/*`；V3 → `adjudication/s3-run-rejudged.json`（sha256 `48af143e…`）+ `criteria/verdicts/matrix.json`；V5 → `accounting/{cache-write-recompute.py,V5-account-correction.md,V5-account-correction.json}`；V1/V4/V6 保留证据见 `GAP-TABLE.md` |
| 实际检查 | 1. `packages/singularity` `pnpm build`：通过，产物无变更（`git status` 无 lib 改动）。2. 外层 `pnpm vitest run --project unit packages/singularity`：44 文件 / **1461 项**通过。3. `--project integration packages/singularity`：38 文件 / **268 项**通过；本轮 5 次全量中出现 **1 次间歇失败**——`tests/integration/a3-recovery.spec.ts`「refuses the evidence a cancelled run's late verifier tries to record」在并行负载下 `vi.waitFor` 超时（`expected 'admitted' to be 'verifying'`，默认 1 s），单跑该文件 3/3、其余 4/5 全绿；与本次零生产改动无关，属既有 A3 用例的时序稳健性问题，如实记录、不归入本票修复。4. `pnpm run verify-persistence`：OK，4 个事件根匹配。5. `agent-singularity` `pnpm exec tsc --noEmit`：exit 0。6. `git diff --check`：干净。7. 仓库外修订判据套件 `pnpm exec vitest run --config …/criteria/vitest.rev2.config.ts`：3 文件 / **14 项**通过（无网络：独立复核用 strace 核到 0 次出站连接） |
| 独立复核 | 非实现者只读复核子代理（`REVIEW-independent.md`，sha256 `6dae98a3…`）：结论**本轮主张成立、未能证伪**——diff 逐字节回放一致、归档 13 用例在修订版 13/13、两组“去掉修复即复绿”的变异、4000 例差分扫描（0 处放松、200 处更严）、重算矩阵逐格一致、原始 usage 自行重数 15/15 无 cache-write 键、归档树哈希不变。复核发现两处文档级缺陷（`criteria/README.md` 的 C2b 标签行；把 `s-root.jsonl:63` 错称 inbox splice），已由指挥方更正并复跑确认 |
| 语义重判要点 | 完整 `rootContract.assumptions[0]` 下，`quarter` 标 `unknown`（首句声明范围未定义，后句 `treats it generically as the current/final quarter` 两种读法都成立 ⇒ 冻结合同「无法判定 → inconclusive，不得 pass」）；`dataSource`/`deliveryScope` 由实际送达答复确认。两个判据版本在三种（记录 × 复核）组合上判决逐条一致：原 S3 `fail`/`fail`、本次 S3 + 原复核 `pass`/`pass`、本次 S3 + 重判 `inconclusive`/`inconclusive`——即修订判据没有改变任何既有判决，`pass` 不能维持来自语义重判 |
| 未解决缺陷 / 阻塞 | 归档 S3 的语义通过不能成立（inconclusive），第 8 项**保持返工**。最小生产修复触发点（只提出、未实施）：根角色 prompt（`agent-runtime/src/prompts/root.prompts.ts`）与 `task_intake` 的 `assumptions` 字段说明未写出 A0 §10 的边界——假设不等于确认、不得为未确认的交付定义条件选定取值，未解决的条件须显式保留未知或回到用户。边界：提示词级最小修补，无语义分类器/运行时闸，效果只能由新的真实模型尝试检验 |
| 下一项 | 第 8 项内：进度审核确认本节交付后，另行授权最小生产修复与新的真实模型重验（须另定输入/判据/独立目录/次数与预算，不覆盖旧 attempt）；A2 不因本节完成而派发 |

## R1 补验证完成轮（2026-09-24，真实模型；执行与验收记录）

> 本节覆盖进度审核返工之后的三次真实模型尝试与生产修复：完成轮 1（`r1-final-2026-09-24`）判 **fail**、完成轮 2（`r1-final2-2026-09-24`）判 **fail**、完成轮 3（`r1-final3-2026-09-24`）判 **pass / path2-limited-goal**。每次尝试都在**自己的冻结轮**里执行：各自冻结输入/答复/判据哈希/证据目录/次数与预算，先冻结、再独立复核、后收费；失败保留为失败，不重跑、不挑结果、不覆盖旧 attempt 目录。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **已验收**（2026-09-24；完成轮 3 通过冻结合同，独立复核「通过合法」；本轮发现的记录级问题已披露并完成文档/ledger 处置，冻结 fixture 的 `cacheWriteTokens: 0` 仍保留为历史 caveat，见下） |
| 执行 agent | Kimi Code 主代理（三轮冻结、生产修复、判决、账目、guide）+ 每轮的独立收费前检查子代理 + 每轮的独立语义复核子代理 + 完成复核子代理（`r1-final3-2026-09-24/REVIEW-completion.md`） |
| 修改前基线 | Singularity `8795a4e`、外层 `53c3a69212`（返工起点）；三轮修复提交 `99e1311`、`aa19637`、`9a3e508` |
| 三轮生产修复（全部在根 prompt / `task_intake` 说明，由本场景证据触发） | ① `99e1311` 假设不等于答案：不得为未确认条件选定取值；② `aa19637` 会改变目标/范围/验收的缺失值必须先问用户，不得让环境替它回答，也不得接受交付依赖该条件的契约；③ `9a3e508` 契约只承载用户原话与实际答复支持的内容，且每条判据必须是本部署 verifier 能裁定的（确定性判据给准确命令）。`agent-runtime/tests/unit/agent-runtime.spec.ts` 钉住这些句子 |
| 完成轮 1（fail） | `r1-final-2026-09-24`：模型**从未使用**澄清渠道，把 checkout-only 来源与「checkout 中有数据的最近季度」规则固化进契约并超时未交付 ⇒ `fail`（S1×6 + S2）。证据 `evidence/ledger.json`、`evidence/criteria-replay/s3-run.json`；账：入 61435 / 出 19961 / 缓存读 199936、23 次工具调用 |
| 完成轮 2（fail） | `r1-final2-2026-09-24`：模型使用了澄清并保留了未知，但契约仍把 checkout-only 来源、季度判定规则与完整季度总结当作要求，且两条 mandatory 判据用 review 模式（真实 verifier 返回 inconclusive）⇒ `fail`（M3 + S1×5 + S2）。账：入 57421 / 出 21536 / 缓存读 239872、22 次工具调用 |
| 完成轮 3（**pass**） | `r1-final3-2026-09-24`：`hitl_ask` 被调用、固定答复逐字送达并被消费（链 `complete`）；契约 objective = 「Create report.txt … because the user provided no data to summarize, the report must explicitly state that no data was provided」，assumptions 记录季度未命名且不得虚构，4 条 mandatory 判据全部为确定性 command；根 run 终态 `verified`，产物 `report.txt` 719 字节（sha256 `004a1c7a…`）逐字说明未提供数据；冻结判据判 **`pass` / `path2-limited-goal`**。独立语义复核：`quarter` = 显式保留未知（引用 `assumptions[1]`）、`dataSource`/`deliveryScope` = 由实际送达答复确认，`freezes` 空、无依赖。账：入 25051 / 出 7733 / 缓存读 106752、14 次工具调用 |
| 验收项对应（V1–V6） | V1 → 接线用例保留（完成复核复跑归档套件 17/17）；V2 → `s3-criteria/2`（sha256 `83d9ee31…`）与红/绿反例保留；V3 → 完成轮 3 的冻结轮、判决与独立复核；V4 → 故障注入判据用例保留；V5 → 各轮独立 `ledger.json` + 返工轮更正记录；V6 → 历史下界不变（≥175461 / ≥58 / ≥501349） |
| 实际检查（三轮期间） | 每次生产修复后 `pnpm build` + 全量单测 44 文件 / 1461 项 + 集成 38 文件 / 268 项 + `verify-persistence` + `agent-singularity` tsc + `git diff --check` 全绿（集成套件本轮 5 次全量中出现 1 次既有间歇失败，见主 guide 记录）；仓库外判据套件（返工轮 14/14、归档 17/17）可重放 |
| 独立复核 | 每轮收费前有独立冻结检查（三轮均「safe to charge」，无实质不符）；完成轮 3 的独立复核报告 `r1-final3-2026-09-24/REVIEW-completion.md`：**pass 合法**（判据/记录/日志/产物/哈希逐项复算一致，17 项检查全 ok），V1–V4/V6 成立；发现三处记录级问题：D1 冻结 driver 的 `?? 0` 归一化使 `driver.json`/`run-meta.json` 写 0（原始日志 13/13 无该字段，ledger 已如实记「未报告」，历史 fixture 的 0 保留为 caveat，未来 driver 须修正）、D2 无 usage 的请求已在本轮 ledger 显式记缺失、D3 文档同步由本节完成。D1 不改判决，但不宣称冻结 fixture 的记录器已被本轮修复 |
| 未解决缺陷 / 阻塞 | 无阻塞。如实保留的边界：一次 S3 通过只证明该固定场景成立，不证明普遍澄清能力、成功率提升或自主进化；判据的语义面仍依赖显式独立复核；fixture 仍含 stand-in 工具与 `?? 0` 归一化（已在各轮 ledger 与 guide 记录，未来轮次应修自己的 driver 副本） |
| 下一项 | 唯一顺序第 8a 项 R3（已有 Task 合同归位，有限维护票），其后再第 9 项 A2+A1 交付组；R1 的完成只解除其前置，不授权 A2 的额外范围 |

## R2：按证据整理运行时 执行与验收记录（2026-09-23）

> 当前复核结论：取消写闸返工（Q1）；其余已成立的改动保留。原交付已在 `d5b0bb6` 提交（该提交虽以 docs 命名，实际含生产代码和测试），外层 `251d35d83c`。以下保留当时验收证据，A2 的当时结论已经由文首唯一表及后续 R1/R3 验收记录更新。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 已验收（2026-09-23；完成闸证据见下。独立复核已完成：非实现者子代理只读复核 + 2 组变异探针 + 2 个自建反例，结论通过，2 项文档级缺陷已由指挥方修复） |
| 执行 agent / 任务链接 | Kimi Code 主代理指挥 + R2 实现子代理（R1 轨迹与源码取证 → 映射 → 缺陷红绿 → 公共面收敛 → 复定 A2） |
| 开始日期 / 验收日期 | 2026-09-23 / 2026-09-23 |
| 前置验收记录 | R1：Singularity HEAD `7595b6d`（S1/S2/S3 真实模型场景均通过，含一次执行事故如实记录，证据在 `/home/ROXY/code/bb_work/r1-evidence-2026-09-23/`）。开工前实跑复核该前置：`pnpm build` 通过；外层单测 44 文件 / 1454 项、集成 37 文件 / 258 项全绿；`verify-persistence` 4 根匹配；六包 tsc = task 0 / verifier 0 / agent-singularity 0 / agent-runtime 2 / task-runtime 3 / graphs 6（既有诊断，逐条与各票记录核对同源）。两个 git 工作区干净（外层仅 thirdparty 未跟踪内容）——前置成立 |
| 修改前基线 | Singularity `7595b6d`（R1 验收提交），外层 harness `6428b8ae30`（同步 R1 验收指针） |
| 交付版本 | Singularity `d5b0bb6` / 外层 `251d35d83c`；包含五个生产文件、四个测试文件、相关 lib 与文档。本轮复核修正原记录的「未提交」状态 |
| 验收项对应 | A → 本记录「职责/调用方映射」三表 + 内存 handle 读点清单；B1（marker 顺序）→ `task-runtime/tests/unit/workspace.spec.ts` 新用例（先红 5/5 后绿 6/6）+ `workspace.ts` 调用链分析；B2（gate 相位重绑定）→ `tests/integration/a3-recovery.spec.ts` 新用例（先红后绿）+ `index.ts:lookupRun`；B3（O1）→ 本记录「O1 判定」段（无故障路径，保留并说明）；C1 → `verifier/src/index.ts` 撤回 `evidenceByVerifier` + 删除其 3 个测试；C2 → `task/src/types.ts:RunMcpServerBinding` 诊断语义标注；C3 → `task/src/proposal.ts` 三个无消费者导出改模块内；D → 本计划文首表第 9 行 + A 表 A2 行 + 本记录 D 节 |
| 实际检查 | 1. `packages/singularity` 下 `pnpm build`：通过。2. 外层 `pnpm vitest run --project unit packages/singularity`：44 文件 / **1453 项**通过（基线 1454；B1 +1、C1 −2）。3. 外层 `pnpm vitest run --project integration packages/singularity`：37 文件 / **258 项**通过（基线 258；B2 +1、C1 −1）。4. `pnpm run verify-persistence`：OK，4 个事件根指纹匹配（未 `--write`；本轮无事件声明变化）。5. `git diff --check`：通过。6. 各包 `pnpm exec tsc --noEmit`：task 0、verifier 0、agent-singularity 0、agent-runtime 2、task-runtime 3（逐条核对与基线同源，其中 1 条因新增代码行号 5221→5247 位移）、graphs 6——与基线逐项一致，无新增。7. 复跑稳定性：`workspace.spec.ts` 连跑 6 次 21/21 全绿。8. 未运行：真实模型、BB 构建/仿真、部署、推送 |
| 跨入口/组合反例 | B1 先红后绿：全栈并发 release（8 批次层 + 底层 run 同一 tick 全部合法 pop）→ 修复前 marker 残留（`markerExists()` 为 true，5/5 确定性复现，最后一次 rename 落在最后一次 delete 之后）→  Claim 被「marker names this process's own pid but this process holds no claim」永久拒绝；修复（按 workspace 的 marker 变更串行链）后 marker 缺席、可立即重新 claim，6/6 稳定。B2 先红后绿：真实 JSONL 重开 + 第二进程经 `runForSession` 重绑定（恢复驱动被 park 在父 session 的首次写 drain，无计时器）→ 修复前 `gate.phaseOf(ROOT)` 为 `undefined`（waiting_children 的父 session 不设防，写/bash/再分解/提交全部放行）→ 修复后由 store 记录派生相位、协调工具放行、写工具具名拒绝。合法正例：普通分解/提交/验收/取消/恢复/重开全链路与 off/all 审核不变（全量回归）。拒绝路径断言：B1 修复不改变任何拒绝语义（claim 仍拒绝、reconcileAdopt 仍是唯一 stale 接管者）；C1/C3 为纯公共面收敛，行为不变由全量回归证明 |
| 独立复核 | 子代理（deepseek 默认模型，非实现者；只读复核 + 全量实跑 + 2 组变异探针 + 2 个自建反例 + `7595b6d` 基线对照；探针 sha256 还原、零残留）：结论**通过**。B1：变异（舍去 marker 串行队列）→ 新用例 5/5 确定性红、自建反例经真实 `claim`/`reconcileAdopt` 证明工作区进程存活期不可用（活 pid 残留 marker，栈空但 busy）；归语义未弱化（栈仍是单进程权威、reclaim 只走 reconcileAdopt）。B2：变异（`gatePhaseFromStore` 设 no-op）→ 自建真实 JSONL 重开反例经**真实 DSH 工具流水线** `ctx.tools.execute` 断言 `write`/`bash`/`task_decompose`/`task_submit_result` 被拒且点名 `waiting_children`，3/3 红；未绑定 session 语义不变。C1：全仓（含 buckyball 与 r1 证据目录）grep 确认 `evidenceByVerifier` 零消费者后删除，`verifier/lib` 无残留、生产 `verifierVersion` 消费不动。C2：`templateDigest` 确仅 docblock 标注、无挂载处复检新增。C3：三个导出文件外零消费者、`task/lib` 导出清单确已不含。A 节职责映射 5/5 论断源码核实属实；R1 取证引用抽查一致；A2 复定仅文档零实现。复核发现 2 项文档级缺陷（D1 S1 工具调用次数 23→14；D2 一处 describe/it 合行格式），均已由指挥方修复；修复后实测 unit 1453/1453、integration 258/258、`verify-persistence` OK、`git diff --check` 0 |
| 文档同步 | 主 guide：§1 当前阶段判断补 R2 事实、§3 状态行下一项、§4.1 Verifier 边界行（撤回索引入口）、§4.2 G15（R2 已关闭「未使用接口」部分）、§5.7（三处 `evidenceByVerifier` 表述改为撤回记录）、§5.8（`templateDigest` 边界句补诊断标注）、新增 §5.12；本计划：文首表第 8/9 行、派发入口下一项句、A 表 A2 行、本记录；`execution-prompts/README.md` 未动（其状态行由派发入口维护，本轮未越权改） |
| 模拟与未覆盖范围 | 未调用真实模型、未跑 BB 仿真、未部署、未推送。B1 的复现用单元级并发构造（与 T2/T3 M6 同一形状，补上底层 release）；部署路径上 marker 变更本由调用方串行（见 B1「部署可达性」段），修复使模块自身保证与栈一致，未改变任何调用方时序。B2 的复现是真实进程死亡 + JSONL 重开，但第二进程的首个工具调用选取 `runForSession` 门；DSH 侧会话恢复由部署负责，本仓不声称驱动它。driver 推状态模型（内存 drivers 表）未动（不预定 pull 化）；`replayLineage` 进程内 Map（重启丢 lineage tag）维持 A3 既有边界记录；双 claim 同 tick 的窗口见 B1「保留边界」段。O1/A2 语义效果无真实模型实验 |
| 未解决缺陷 / 阻塞 | 无未解决的本票缺陷。保留边界（有证据地保留，非承诺缺口）：(1) marker 的单进程串行交接仍由调用方保证，跨进程无 CAS、不防御共享文件系统外部写入者（A3 既有边界，本轮未改）；(2) 同一 workspace 两个 claim 在同一 tick 都通过 marker 读取的窗口仍在（生产 claim 由 graphs transition / reconcile 顺序 / replay top 检查串行，本轮未构造出可达反例，如实保留）；(3) O1 根身份=首个 parentless 任务无真实故障路径（见 B3）；(4) KISS §8.2 裁决召回仍未建（本轮只撤回无消费者的查询面，不建召回系统）；(5) A2 合同已复定但未实施 |
| 最终验收结论 | 通过（依据：上述实跑命令与数量、B1/B2 先红后绿与独立复核变异/反例证据、C1–C3 公共面收敛及行为不变证明、六包 tsc 与基线逐项一致、`verify-persistence` 四根未动、独立复核结论通过且其 2 项文档缺陷已修复回归；确认者：指挥方主代理 + 独立复核子代理，未由人类验收） |
| 下一项 | 唯一顺序第 9 项 A2（任务导航与合法动作）：R2 已将其从「待复定」复定为「待派发」，合同要点见本记录 D 节。前置 A0/A3、S1-C 均已验收，前置满足 |

### A. 职责/调用方映射（准入、运行推进、工作区归属）

消费对象：R1 三个场景的真实运行轨迹（S1 14 次工具调用、S2 6 次、S3 24 次，见 R1 记录）+ 当前源码。三块各回答四问：状态转换/事实在哪、谁持久化、谁是消费者、哪些是内存投影。

**A.1 准入链（admission/normalize/proposal）**

| 环节 | 状态转换/事实 | 谁持久化 | 消费者 | 内存投影 |
|---|---|---|---|---|
| 受保护输入固定 | 字符串路径 → `{ path, sha256 }`（读会话 checkout） | `task/src/contract.ts` 词汇，不单独落库 | `deriveBatch`（唯一固定点） | 无 |
| 规范化 | 闭合字段集、默认值、criterion id、批次摘要 | 随子任务 `TaskCreated.payload.task.contract` 落 store | `deriveBatch`/`storedBatchOf`（提案回放）/replay/root intake 共用 | 无（纯函数） |
| 结构/能力准入 | contractDefects、independentAcceptanceDefects、resolveCapabilities（closed/gap）、provider 预检、verifierRef | 子任务落库时带 `CapabilityManifest`；缺口记 Obligation | `checkDerivedBatch`、`precheckProviders` | 无 |
| 提案记录 | `TaskProposal`（content-derived id、requestKey、策略、两个上下文指纹、完整批内容） | `submitProposalIn`（T2/T3 四事件）→ store | `continueProposal`（唯一变任务入口）、`decideProposal`、审核渠道渲染、reconcile 提案遍 | `serializeParent` 每 store+父互斥（handle） |
| 原子准入提交 | 子任务+依赖边+父 `TaskDecomposed.admission`+父相位 waiting_children+提案消费，一次 commit | `admitBatchIn` / 根 `admitRootProposalIn` | `decomposeAndRun`/`intakeRootContract`/reconcile | 无 |
| 提交→推进分离 | 准入后立即返回 `{ batchId, childTaskIds }` | 相位事件 `RunPhaseChanged` | 工具 `task_decompose`/`task_intake`（模型面） | per-batch AbortController（driver 表，见 A.2） |

普通分解、replay、root intake 三入口共用同一规范化/结构规则（`normalizeDecomposition` + `contractDefects` + `rootIndependenceDefects`），准入链无第二套状态分支。**内存当事实的读点：无**——准入的每次判定都从 store 或调用方输入重算（`storedBatchOf` 从提案记录重建批次，恢复进程无提交方内存也能续跑）。

**A.2 运行推进（orchestrate/gate/batch driver）**

| 环节 | 状态转换/事实 | 谁持久化 | 消费者 | 内存投影 |
|---|---|---|---|---|
| 批次推进 | 每轮从 store 重读子状态，按依赖串行，验证规则沿用原 cascade | driver 只写 store 事件（`markRunStatusIn`/`recordReviewIn`/`recordEvidenceIn`） | `driveBatch`/`driveRounds`；`awaitBatch`（无 driver 时落 store 派生） | `this.drivers` 表（AbortController + promise）；child handle/watcher |
| 协调相位 | active→waiting_children→submitted 迁移闸 | `RunPhaseChanged` + reducer 闸 | gate、submitResult、cancelBatch、reconcile、`task_read`/`task_status` 派生 | `executionGate` 相位 Map（**handle，非事实**；B2 前重绑定门不派生） |
| 显式提交 | submission 记录 + drain + verifier 排他 | `changeRunPhaseIn` → 既有终态链 | `task_submit_result`、settleParentBatch（父代提交） | drain 的在途调用登记 |
| 无进展停止 | `RunProgressMarked` 计数（快照可计算的子树条目和） | 相位机事件 | `observeWorkerRun` | 无 |
| 取消/恢复 | 取消源传播、reconcile 按 run 粒度幂等 | store 事件为仲裁 | cancelBatch/cancelGraph/dispose/reconcileStore | driver 表登记跳过；`replayLineage` Map（重启丢失，A3 边界） |
| 写闸 | 相位≠active 只放行 18 个协调工具 | 无（纯 handle） | DSH `tools/pre-execute`+`tools/result` | `executionGate` + 在途 calls |

**被当作第二份业务事实的内存读点（实际发生过）：`executionGate` 相位在 `lookupRun` 重绑定门上**——持久事实是 run 的 `executionPhase`（store），gate 只是本进程 handle；`adoptRoot` 从 store 派生，而 `runForSession`→`lookupRun` 门原先不派生，重绑定的 session 拿到 `undefined`（不设防）。已修（B2）。其余内存表（sessions=指针缓存、drivers=在飞工作、序列化互斥）每次都回落 store 判定，不是第二事实源。

**A.3 工作区归属（workspace.ts 归属栈 + marker）**

| 环节 | 状态转换/事实 | 谁持久化 | 消费者 | 内存投影 |
|---|---|---|---|---|
| 进程内栈 | run→batch→子 run→verifier，claim/push/release 全键 top 检查 | 无 | claim/push/release/releaseLayer（审批期 verifier 层进出、批次结算释放、replay 进出） | `stacks` Map（**本进程权威**） |
| marker 文件 | `<sha256(path)>.json`：owner+pid+starttime，tmp+rename、唯一临时名、**按 workspace 串行链** | 磁盘文件（给后来的进程） | claim（拒绝任何已存在 marker）、`reconcileAdopt`（恢复唯一接管者）、`close`（卸载） | 无 |
| 冲突拒绝 | `WorkspaceBusyError`（点名持有者 store/task/run 与起始时间） | 无 | decomposeAndRun/claimReplayWorkspace/rebuildWorkspaceOwnership | 无 |
| stale 判定 | pid 活性 + starttime 比对（pid 复用是诊断不是授权） | 无 | reconcileAdopt | 无 |

跨进程只靠 marker+pid 探测（EPERM=活、pid 复用是诊断、跨机 DSH_HOME 无意义），不宣称跨进程锁（A3 既有边界，本轮未改）。

### B. 实际缺陷关闭（先红后绿）

**B1 marker 写入顺序：并发 mutation 下「最后落地写」可留下与栈矛盾的 marker（已修）**
- 复现：`workspace.spec.ts`「mutations that empty the stack leave no marker, whoever landed their write first」——claim + push 8 个批次层，同一 tick 内自顶向下全部合法 release（含底层 run）。修复前：某次 rename 落在最后一次 delete 之后 → 栈空但 marker 存在且命名本进程活 pid → 同进程再 claim 被「marker names this process's own pid, but this process holds no claim」永久拒绝（reconcileAdopt 也拒绝活 pid），工作区在进程退出前不可用；5/5 确定性复现。
- 修复：`workspace.ts` 新增按 workspace 的 marker 变更串行链（`queueMarkerMutation`，调用序即落盘序，rejection 不毒化队列），claim/push/release/reconcileAdopt/close 的 marker 写入全部入链；release 在入链前捕获「留下的新栈顶」。未改协议语义（唯一临时名保留、栈仍是本进程权威、claim 拒绝条件不变）。
- 回归：新用例 6/6 绿；既有「mutations started in one tick」用例收紧为「marker 恒等于最后调用的写入者（栈顶）」，20→21 项全绿；全量单测/集成不变。
- 部署可达性（如实记录）：生产 release 序列本由调用方串行（settleParentBatch 先 awaiting 批次层释放才置父终态；cancelGraph 先 await drivers；onRunSettled 与调用方自身释放由同步 pop 互斥），因此该残留窗口在当前调用图上不可达；但模块自身文档承诺「并发写留下一整个 marker」且未承诺内容与栈一致，此修复把该承诺升级为调用序保证（与栈严格一致），并顺带覆盖 failBatch 与 driver 并发结算这类「排序只靠 usually」的路径。若只记录不修也可接受，选择修的理由：修法是 20 行内的纯本地串行化、零协议变化、红测确定。
- 保留边界：同一 tick 两个 claim 都通过 marker 读取的窗口仍在（生产 claim 由 graphs `transition`/reconcile 顺序/replay top 检查串行，本轮未构造出可达反例，记录保留）；跨进程仍无 CAS。

**B2 恢复/重入：`lookupRun` 重绑定不恢复 gate 相位，内存 handle 与持久记录不一致（已修）**
- 复现：`a3-recovery.spec.ts`「gates a session the second process rebound by the phase the store records…」——真实 JSONL 重开；父 run 持久相位 `waiting_children`、子在飞；第二进程首个工具调用经 `runForSession`→`lookupRun` 开门+reconcile+重绑定，恢复驱动被 park 在父 session 首次写 drain（无计时器）。修复前：`gate.phaseOf(ROOT)` = `undefined` = 不设防 → 该 session 可写/bash/再次 `task_decompose`/`task_submit_result`（store 侧相位检查仍会拒任务树动作，但共享 checkout 的裸写只有 gate 挡）；确定性红。
- 修复：`index.ts` 新增 `gatePhaseFromStore`，`lookupRun` 两条重绑定路径（进程内索引命中、开门重建）都从 store 的 run 记录派生 gate 相位（running→executionPhase、终态→terminal、旧无相位记录→不设防，与 `adoptRoot` 同规则；`rootSessionPhase` 泛化为 `runGatePhase`）。store 是唯一事实源，未建第二份相位。
- 回归：新用例绿；全量单测/集成不变（单元 1453/集成 258）；`waitRunSettled` 对「gate 不认识的 session」语义不变（未绑定 run 的 session 仍返回 undefined）。
- 调用方清单：`runForSession` 是唯一入口（工具层 task_read/task_status/task_submit_result/task_decompose/task_proposal_* 等经它）；replay/cancelGraph/reconcile 不经此门。

**B3 A0+R0 复核观察项 O1（根身份=首个 parentless 任务；replay 在图 store 造 parentless）——判定：无真实故障路径，保留并说明**
- 证据：(a) `replayTask` 要求 champion 是**同一 store** 内 verified/failed 任务；A0 store 里首个 parentless 任务即根任务（一次性消费闸保证只有一个根），任何 replay 任务只能在其后创建，`find(parentless)` 仍返回根；(b) 旧 store 的根任务在 graph setup 时已存在，replay 更在其后；(c) 不存在「先有 replay 任务、后建根」的路径——replay 的 champion 本身要求 store 已有终态任务；(d) 根预算 owner 解析（`root-budget.ts`）不靠创建序：按 `rootTaskStoreId(run.sessionId)` 绑定筛 parentless，0 个或多个绑定均具名拒绝；(e) 重绑定门 `rebindActivatedRoot` 用消费记录铸出的 taskId，不做 parentless 扫描。
- 结论：保留「首个 parentless」这一实现（旧 store 兼容 + 恢复路径简单），其正确性依赖一次性建根闸与 store 拒绝第二根，不依赖 marker/锁；记录为边界不列为缺陷。

### C. 无用途查询面/摘要语义（逐个结论）

**C1 `evidenceByVerifier`（verifier/src/index.ts）——收回公共面（删导出 + 删调用点/测试），行为不变证明**
- grep 证据：全仓（含 harness 其余包与 buckyball）无生产调用方；唯一消费者是 `verifier/tests/unit/verifier-registry.spec.ts` 2 项与 `tests/integration/verifier-selftest-inputs.spec.ts` 1 项 describe（为它自己写的测试不构成审计用途）。KISS §8.2 裁决召回未建且本轮不建召回系统（派发合同明确），故不留「将来也许有用」的查询面。
- 动作：删除 `VerifierRegistry.evidenceByVerifier` 方法（含 docblock）、`ready()` docblock 中的引用、上述 3 个测试及仅它们使用的夹具（`bundleOf`/`claimOf`/`onlyBundle`/`seedLegacyBundle`/内联 `ids`）；构建产物 `verifier/lib` 不再含该名（grep 0）。
- 行为不变证明：纯只读查询，无调用方即无行为变化；`verifyRun`/`claim`/版本 stamp/受保护输入复检全链路回归全绿。版本索引的「旧证据无版本仍可读」随读取面一起消失（持久化词汇未动，事件照旧可读）；`(verifierRef, version)` 索引本身不再提供——召回真正有消费者时按新票重建。
- 保留：`VerificationResult.verifierVersion`/`EvidenceClaim.verifierVersion` 持久字段与其全部生产/测试消费不动（历史字段兼容读取纪律）。

**C2 `templateDigest`（`RunMcpServerBinding`）——保留并标明「仅诊断、无身份保证」**
- 消费者盘点：`state.ts` 形状校验（reducer）、`run-binding.ts` 计算、`renderRunBinding` 渲染（worker 合同块展示 `(template <短摘要>)`）、测试断言。**无任何消费者隐含依赖执行身份**（没有回读 registry 比对、没有 spawn 时复检、没有凭它拒绝/放行）。
- 结论：不在挂载处补配置校验（无消费者需要身份保证，退出时复检反而会制造「校验了但只覆盖 editor 路径」的假保证）；改语义标注：`task/src/types.ts` 的 `RunMcpServerBinding` docblock 明示 Diagnostic only、`templateDigest` 行内再注；缺失 server 的拒绝仍由 spawn 具名失败执行。

**C3 本组新增导出无外部消费者（D4 类）——收回三个名字，结构可读性不变**
- 逐个 grep（跨 task/task-runtime/agent-singularity/agent-runtime/verifier/graphs/tests 全仓）：`TaskProposalKind` 0 个文件外消费者（记录判别用的是各 arm 字面量 `kind?: 'batch'`/`kind: 'root'`，不是该联合）；`TaskProposalDecision` 0 个文件外消费者（导出的决策词汇是 `TaskProposalDecisionClaim`，它是前者基类，读者按结构窄化无需基类名）；`TASK_PROPOSAL_ID_PREFIX` 0 个文件外消费者（只有 `taskProposalId`/`rootProposalId` 两个内部派生用它）。
- 动作：三者保留在 `task/src/proposal.ts` 内改为模块内（非导出），`export *` 不再公开；构建产物 `task/lib/index.d.ts` 的 export 清单已不含这三个名（本地声明仍在，结构读取不受影响）；其余有消费者的导出（`TASK_PROPOSAL_KINDS`/`TASK_PROPOSAL_PHASES`/`TASK_PROPOSAL_DECISION_OUTCOMES`/`TaskProposalPhase`/`TaskProposalBase`/`TaskProposalIndex` 等，均被 `task/src/service/state.ts` 或 `types.ts` 消费）保留。
- 保留理由记录：`ROOT_PROPOSAL_TASK_ID`、`TaskProposal`/`TaskProposalRoot`/`RootProposalIdentity` 等有真实跨包消费者，不动。

**公开接口变化清单（逐个列调用方）**
1. `VerifierRegistry.evidenceByVerifier`（移除）：调用方=无（测试 3 处同删）。消费者影响：无。
2. `TaskProposalKind`/`TaskProposalDecision`/`TASK_PROPOSAL_ID_PREFIX`（自 `@dangosys/dsh-singularity-task` 导出面移除）：调用方=无；结构读取不受影响（d.ts 本地声明仍在）。
3. `RunMcpServerBinding.templateDigest` 语义标注（无代码行为变化）：消费方=reducer 形状校验、`renderRunBinding` 渲染、测试；标注后行为不变。
4. 内部私有改名 `rootSessionPhase`→`runGatePhase`（私有，无外部面）。
5. `task-runtime/src/workspace.ts` 新增私有 `queueMarkerMutation`（无外部面）；`WorkspaceRegistry` 公开方法签名与行为语义不变（marker 内容从「任意最后落地」变为「调用序最后」，对读取方更严格一致）。

### D. A2 + A1：Agent 状态上下文（2026-09-24 职责重定）

状态：设计已重定、未实施（第 8 项 R1 已于 2026-09-24 验收，本节设计仍未实施）。原草稿备份为 Singularity `beb1350` / 外层 `a335606`，本轮先保存收到的草稿为 `f9d1b7b` / 外层 `bdc2b9f`，再综合两名 GPT-6 Sol 的只读源码调查。替代上一轮“只收窄 task_status”的方案；那一版不足以提供目标位置、依赖协作和历史细节，而且把相关性错误地当成了权限。主职责及依赖方向唯一来源为[主 guide §1.4](singularity-harness-guide.md)。

**直接消费者与需要回答的问题**

| Agent 当下需要知道什么 | 权威来源 | 默认呈现 / 深入读取 |
|---|---|---|
| 最终目标、必须遵守什么、本人贡献 | 已接受根/当前契约、真实 parent 链、handoff 的委派原因 | 本人完整契约、根硬约束及目标、父目标/贡献；祖先详情保留来源可读，不编造缺失决定 |
| 项目进行到哪里、什么阻塞了本人 | 当前 Task/Run、dependsOn、提案状态、已记录结果及有效 gate | 默认本人/直属子/直接依赖状态和阻塞；可请求同一授权域更宽的项目概览 |
| 上游交付了什么、据何判通过 | Artifact/Evidence/Review 的实际引用 | 默认简要结果和引用；按需读直接依赖的证据与目标验收。依赖为兄弟时也须可用 |
| 为什么作过该决定、压缩后如何恢复 | Session 原始事件、持久 handoff、相关来源引用 | DSH 精确读取/历史查询；摘要不是权威替代，查不到就明确缺失 |
| 当前能怎样推进 | 已装配工具、执行相位、准入/审核返回 | 显示可确认的执行限制和入口，不做全量“必然可执行”矩阵；动作仍由原入口重检 |

这里的“项目”是当前 graph/env 下可验证的执行事实与已有产物引用，不预建 Git/CI 监控、全仓知识索引或项目管理平台；文件与仓库细节继续由已有工具获取。不会仅因 R1 小样本未调用某工具就证明该需求不存在；当前 `dependsOn`、递归 handoff、实际历史查询入口本身就是消费者证据。

**包选择与接口**

- 本组新增 `packages/singularity/context`，承载上下文读取、相关性选择、来源、输出界限和 DSH prompt 装配。它有“工具主动读取”和“模型请求前装配”两个实际消费者，职责跨 Task/Graph/Session，放在 task 或 task-runtime 都不合适。无需新 memory 数据库；未出现跨任务经验写入需求前也不新增 memory 包。
- 保留 `task_read`（当前契约）与 `task_status`（项目状态），新增唯一的 `context_read`（按引用读详情）；三者只适配 context 的同一读源。具体输入和结果见下表，不再把是否新增入口留给实现者选择，不建第二套搜索语言或方法族。
- 默认视图是相关片段，**不是新授权表**。当前 group 仅保存成员/router 拓扑，没有读取 ACL。本组以可信 session→graph 绑定确定项目读取域：同 graph 的任务及关联证据/会话可按引用读取，默认只推相关片段；跨 graph 拒绝，不能以同 cwd/store 或用户传入的 id 扩权。Task 归属核对本 graph store，Session 归属核对 graph 成员或明确委派绑定；引用本身不能授权。reviewer 无业务 Run 时仅按实际委派的 graph 读取，不自动成为 root。group 私密性不在本票新增。
- DSH 原始 `session_event_read/session_event_trace/session_trace/session_search` 的授权只看 cwd，比 graph 域宽。固定选择：从 Singularity 角色的有效工具面移除跨 Session 原始入口，统一由 `context_read` 调 DSH 查询服务；在工具 pre-execute 限制中同样拒绝这些入口，preset/MCP grant 的合并不能重新放行。上游通用查询服务不改成认识 Singularity 的实现。测试相同 cwd 的两个 graph 不能互读；共享 shell/文件系统仍是部署信任边界，不冒充恶意进程沙箱。
- DSH `system-prompt/assemble` 已是异步 scoped waterfall：context 可在一次真实组装中读取绑定来源、贡献命名内容；无需新轮询缓存或修改 agent-loop。静态 section provider 本身同步，不往它直接塞 async 函数。没有 agent 的诊断组装不注入项目上下文；遵守取消 signal 和 `includeRuntimeContext`。不可变契约与动态 context 分开，动态事实沿 DSH context snapshot 入日志；测试实际模型输入及不变内容不重复累加。
- 首次普通 worker、replay 和恢复请求都必须在装配前具有可验证的 Session/Run/graph 关联。固定使用持久 TaskStarted/handoff 与已发布 graph 成员，不依赖 spawn 返回后的 `onRunBound` 缓存。reviewer 的绑定顺序见下文。缺绑定拒绝该模型请求，不能下一轮再补或让 runtime 导入 context 渲染字符串。
- 不增加复制 store 的持久 ContextView、不引入刷新定时器和独立全局 revision。Task/Run 身份、已存在内容摘要、Session seq/offset 足够时直接复用；多个来源读取非原子要诚实标注观测范围，不发明“全项目一致快照”。核心契约不能静默截断，外围结果有总输出上限及具体续读引用；不强制固定字段全集、向量搜索或新分页协议。

**冻结的模型读取合同（A2-5）**

| 入口 | 输入与语义 | 必须返回的边界 |
|---|---|---|
| `task_read({})` | 普通节点读自己实际 Run 的完整契约；root 未接受契约返回 not-activated；reviewer 读委派目标契约并标明 review-only、无业务 Run | 不把 reviewer 冒充目标 Run 的执行者；无可信绑定为 unbound，不猜 root |
| `task_status({scope?, offset?, limit?})` | scope 为 related/graph，默认 related；related 为本人、直属子与直接依赖，graph 为同域任务概览。按 taskId 稳定排序，offset 从 0 起，limit 默认 20、范围 1–100 | 返回来源、实际条目、是否还有后续及下一 offset；两次读取可能观察不同状态，不承诺分页快照一致 |
| `context_read({kind, ref, offset?, limit?})` | kind 为 task/run/evidence/review/diagnosis/session；ref 使用对应现有记录身份，Session 复用 DSH reference/seq。offset/limit 沿 DSH 读取单位；Task 类读完整单条记录，超限返回可续读的文本片段 | 服务先以 live caller 解析域，再核对目标归属；不存在/不可读/引用失效具名返回，不允许模型指定授权用 graphId/storeId/callerId |

ref 的形状固定沿现有身份：task/run/evidence/diagnosis 使用各自 id，review 使用 `{taskId, runId}`（无 Run 时 runId 为 null），session 使用 DSH 原生引用；不为没有独立 id 的 Review 再造全局索引。工具 schema 必须标明各 kind 的 offset 单位：Task 类为 UTF-8 字节，Session 沿 DSH 既有事件 offset；不拆 UTF-8 字符，返回实际 nextOffset。context 的外围输出与单次详情默认上限统一为 16 KiB，由包内一个常量控制，不新增预算配置平台；包括引用列表本身，不能用无限 omittedRefs 绕开。核心契约不静默裁剪：工具超限提供明确续读引用，自动装配核心若无法完整容纳则以 context-too-large 拒绝本次模型请求，供调用方处理，不伪造准入成功或改写已接受契约。默认装配和显式概览采用同一相关性规则；稳定角色政策不包含动态状态副本。

无业务 Run 的 reviewer 使用**既有 reviewer ledger** 的 `sessionId/rootStoreId/taskId/actor` 作可信委派来源。agent-singularity 装配时向 context 注入窄的只读 binding resolver，context 不反向导入工具包；ledger 缺失、同 session 冲突绑定、graph/root store/委派者不一致均拒绝，不靠 prompt 或仅靠 parentSession 推定授权。其读取域仍为所委派 graph，不收窄成只能看一个 task。`task_review_agent` 通过 agent-runtime 内部 awaited `beforePrompt` 回调，在 graph 成员发布后、首条 followup 前写入并确认 ledger；回调不接受模型传入，失败就 dispose handle、标记失败节点且零模型输入。已持久化的委派占用既有预算，重启恢复同一 session 不再次扣数；A2 不新增自动 reviewer 调度，A5 的源去重另见 F.3。旧 ledger 记录按原格式读取。

**迁移必须在本组完成**

| 现有位置 | 本组处理 | 所有者 |
|---|---|---|
| `agent-singularity/src/tools/task-read.ts`、`task-status.ts` 中的跨记录筛选/相关性/上下文渲染 | 移入 context 共用读取，工具只保留 schema、可信调用者传递及输出适配；删去旧重复实现 | context |
| `task-runtime/src/handoff.ts:renderWorkerPrompt` 的契约/handoff/引用内容渲染 | 按职责拆：runtime 继续生成并保存 TaskHandoff 数据；context 投影其内容；稳定 worker 行为政策由 agent-runtime prompt 持有。普通分解与 replay 的消费者一起迁移，禁止 runtime 反向依赖 context | 数据 task/runtime；上下文 context；角色 agent-runtime |
| `runForSession → lookupRun`、graph 激活/恢复入口 | 当前 lookup 会 reconcile 和回填 gate，不能直接用作 context 纯读。按 E 节把恢复接回显式生命周期；context 通过可信 graph/store 与 Task 快照读取，执行入口仍由 runtime 重检 | task-runtime 负责恢复；context 负责读取 |
| `task-runtime/src/contract.ts`、`run-binding.ts:renderRunBinding`、工具 `root-store.ts` 的视图函数 | 契约/绑定摘要和未激活视图同批迁入 context；绑定文件校验及执行准入留 runtime，不能把整份 run-binding 搬进 context。稳定政策归 agent-runtime；替换既有 contract-reinjection 的数据提供方，避免双重注入 | context / agent-runtime |
| DSH Session 历史与请求准备 | 调用 `sessionQuery` / `sessionReferenceResolver`（按实际接口）、scoped `systemPrompt` 与 compaction 机制；不复制索引、日志或压缩器 | DSH；context 负责领域接线 |
| 既有 Review/Diagnosis 事件类型与 reducer | 本组不迁移持久格式；只读取已授权记录。会话指标/诊断行为归拢见后续 A5，不因本组读到它们扩大范围 | 既有 task 记录 |

**完整验收**：三层真实 Task 链中的 worker 能在实际模型请求里读到根目标/硬约束、本契约及贡献；一个跨兄弟的真实依赖能查到其验收与证据，无关正文默认不注入但同 graph 内可主动读取；显式概览与详情不跨 graph，猜 id 或原始 session 工具不能绕过；包含 replay 的 parentless Task 不串根；未激活、等待、已终态及无绑定调用有明确结果，读取不改变生命周期。以 DSH 实际请求装配和实际历史读取验证重启/压缩后可从事实源恢复；工具与自动上下文同源，引用失效/超限/缺失明确，不拿陈旧动作提示绕过闸。不做模型效果提升的虚假声明。

内部顺序细化为：①显式恢复与只读定位分离；②context 来源授权/投影；③工具与真实模型装配、旧渲染迁移；④独立组合验收。每次仅委派其中一个子目标，接口交接后再派消费者；主代理负责整组集成与全量检查。它们是第 9 项内部提交，不是四个可提前宣布完成的阶段；只有完整消费者接线及删除旧重复实现后，本组 A2/A1 一起验收，再进入 A4。

**后续各票的工程归属（不另增执行顺序）**：A4 的消息正文/送达/恢复主体在 agent-runtime + DSH Session，context 显示待答/回答引用，task-runtime 只负责该 Run 的阻塞效果与原相位保持；S4-E 将 `agent-singularity/src/evolution.ts`、`replay.ts` 及其评估/晋升/回滚归入 evolution 包，工具仍是适配，旧 ledger 可读。这里的 gate 是晋升闸，执行写闸 `task-runtime/src/gate.ts` 不迁出。A5/S2-E 的事后因果分析和 review pack 归 agent-singularity/review；`reviewEnrichment` 的终态基础派生及唯一 ReviewRecord 写入留在 runtime，通用 Session 观测可归 agent-runtime/DSH 只读接口，不能让终态结算反向依赖 review/context/evolution 是否装配。A6/S2-R/S3 在 evolution 中做候选编排，在 task-runtime 中重检和恢复执行。每票同批更新真实调用方，验证旧记录可读、取消/重启/直接入口及模块缺席时终态仍正确；删除被替换实现，避免长期双轨。

底层不硬编码 supervisor 的因果搜索顺序、失败分类全集或所有候选对象执行器。既有数据按原格式读取；新诊断只保留证据、假设、实验与候选的实际需要。未知问题由 Agent 使用已有工具研究和验证；一旦涉及改契约、提权、改裁判或应用共享能力，仍受既有批准与独立验证约束。

上一轮上下文职责修订涉及 9 份当前指南/模板：本地链接目标 104 个、代码围栏 15 个及 `git diff --check` 检查通过；未运行代码构建、运行测试或模型实验，不据此改变 R1 验收状态。新 context、evolution 及上述迁移均是后续工程合同，尚未实现；接续的大模块审计见 E 节。

### E. 已有大模块的职责审计与迁移（2026-09-24）

状态：只读审计与工程设计，尚未实施。备份 Singularity `50cb580` / 外层 `68cfc60`；基于 `236b86a` 的源码，由 GPT-6 Sol 调查 task、runtime 入口与执行模块，主代理综合。400 行以上为重点清单，计数含注释；不要求每个文件降到 400 行以下，不把源码搬家本身当成功能精简。

**审计结论与处理位置**

| 现有位置 / 行数 | 判断与迁移路径 | 安排 |
|---|---|---|
| `task/src/skill-contract.ts` / 426 | 侧车形状、路径规则、digest 的实际生产消费者为 runtime 的 sidecar/run-binding；迁为 runtime provider 内部模块，不追加进其 index 或 sidecar 大文件。TaskRun 保留所用内容身份 | R3 |
| `task/src/types.ts` / 1317 | Verifier 执行、自测、VerifyRequest 接口归 verifier；RootTaskSpec/TaskDefinition 仅测试使用，移测试支持层；VerificationResult/Evidence 和其他持久形状留 task。按事实族在包内整理类型，保持单一来源，不新建共享 types 包 | R3；不要求一次拆完全部类型 |
| `task/src/service/state.ts` / 1649；`index.ts` / 682 | 保留 TaskState 和 TaskService 的唯一状态、批次预验证与原子提交。若提取校验器，置包内且只返回检查结果；不能按事件种类建立各自持久化的 service。先不重写 reducer | R3 保持行为；A5 只改下述建议约束 |
| `task/src/proposal.ts` / 674 | 提案形状、内容身份与校验属于事实完整性；不是 supervisor 策略，不应迁入 evolution 或删除。无消费的公开 helper 可收为包内，但不能据测试数量猜无用途 | 保留；只随实际相关改动整理 |
| `task-runtime/src/index.ts` / 5722 | 同时装配提案、执行、恢复、会话观测；优先分开查询/恢复并迁出上下文与通用 Session 观测。提案与执行仍在 runtime 包，私有状态不向外暴露为共享 RuntimeInternals | A2+A1、A5 分别迁实际职责 |
| `task-runtime/src/orchestrate.ts` / 2475 | 批次、worker 等待、提交/判决、replay 均有真实消费者；保留已共用的 observeWorkerRun/settleSubmittedRun，终态写入与资源释放的重复规则在包内归拢，不能另造 scheduler | A2 只迁渲染；A4 接阻塞前先归拢相关结算路径 |
| `sidecar.ts` / 781；`provider-precheck.ts` / 409 | 前者读文件/校验内容，后者按真实 preset/capability 做准入预检；不是同一层重复校验。可将 sidecar 的文件装载与规则校验分为包内模块，保持同一 provider 判定入口 | R3 只迁合同；其余随真实修改，不预建 provider 包 |
| `run-binding.ts` / 496 | 固定与校验实际 Skill 内容是执行保证；只有末尾的文本投影属于 context，不能为“只保留 id”丢掉快照内容与校验 | A2+A1 |
| `normalize.ts` / 544；`workspace.ts` / 536 | 前者统一契约正规化，后者保持实际工作区归属与 marker 顺序；已有生产/恢复消费者。保留，不因长度再造规则引擎或分布式锁 | 不新增清理票 |

公开面也要按调用方收窄：审计未找到 `decomposeAndRun`、`proposalsForParent`、`awaitBatch` 的非测试调用；`executionProviders` 只有测试消费，`skillSearchRoots`、`readProcessStartTime`、`RUN_BINDING_SKILLS_DIR` 有模块内用途但无包外生产消费者。后续改到对应职责时，先把测试改为真实生产入口或内部模块导入，再删无用便捷流程/包入口重导出；模块内部需要的实现仍保留。它们不并入 R3，也不为保留接口制造新消费者。`BudgetConfig.attempts` 当前无重试执行路径，只是声明与记录，不据此新建自动重试机制。与旧账、内容身份和准入相关的检查不能按“看起来重复”删除。

**R3：一票只解决已有合同放错位置**

状态更新（2026-09-24）：**已实施并验收**，执行与验收记录见下文「R3：已有 Task 合同归位 执行与验收记录」；以下原始合同保持不变。

先交接三个有限改动：Skill 合同与对应测试迁到 runtime；Verifier 执行接口迁到 verifier；测试专用 RootTaskSpec/TaskDefinition 迁到已有 legacy-root 支持文件。每个改动同时替换全部消费者并删除 task 的旧导出，不保留永久转发，也不修改 Skill 格式、digest 算法、准入政策或 Task 事件。task 类型的包内整理仅限本次迁出触及部分，不把整个 types.ts 重排列为本票验收；其余事实的正常导出与序列化数据保持。Skill 合同可以继续复用 task 的现有摘要基础函数，不再造通用 crypto 包。

验收 R3-1：迁移前后同一侧车及内容产生相同 digest，旧 Run binding 仍可读取，真实 provider 预检、绑定、晋升拒绝路径保留。R3-2：verifier 插件和自测入口使用新类型，Task 不反向依赖 verifier；Evidence/VerificationResult 仍由事实层拥有。R3-3：测试 root 工厂继续从真实 store/runtime 接口建立夹具，生产无旧测试类型及跨职责导入；历史 JSONL 可读，原子提交反例和提案恢复回归保持。纯搬迁优先复用已有测试，不为每个新文件复制一套测试；主代理完成公共构建/类型/持久化检查。持久化检查只看声明根，指纹不变不能替代旧日志回放。

**A2+A1：读取路径不能再承担恢复**

当前冷查询会调用 `reconcileStore`，而 `graphs.create` 已显式 adoptRoot、`graphs.activate` 的恢复路径尚未如此接线。固定恢复顺序为：已登记 graph 的 `ensureRoot` 完成并释放其图内队列 → await runtime 的 `adoptRoot(root store, root session)` 恢复屏障 → 切换运行环境/交付输入；显式选择已有图只在屏障成功后提交选择。create 先完成 graph 注册与环境附着，再经同一激活入口恢复，迁掉 create 旧位置的重复 adoptRoot。**create 保留现有 graph/add 同时写 selectedId 的语义**，注册后 UI 可以看见 recovering 新图，但 selectedId 不代表就绪，所有输入消费者仍须过恢复门；失败时新图仍被选中并显示失败，不谎称旧选择保持。无需为此修改历史 Graph 事件。启动恢复选中图也走 activate，不用异步 selected 监听补跑。

屏障只等待恢复事实对账、所有已知 session 的 gate 初始化和 driver 登记，不等待批次执行/模型输出。当前 startBatchDriver 是先启动 async driver 再 register，必须在本票改为先登记拥有 abort/disposer 的 handle、等待恢复释放信号后才启动 body；该信号只属于本次 store 恢复，不新增持久状态机。屏障失败/取消时中止并移除尚未启动的登记、释放本次取得的临时资源，不把未启动写成执行成功；重试从持久记录重新登记。不得在 graph transition 内等待一个反过来要进入同一队列的 spawn，也不得在 graphForSession/查询里等待自身恢复。runtime 只持有每 store 的在途恢复 promise/就绪 handle，持久记录仍是事实源；取消/卸载使该 handle 失效，失败可由下一次显式 activate/adoptRoot 重试，不做后台无限重试。

直接服务的业务执行入口在首次副作用前检查同一恢复就绪条件，未就绪返回 recovery-required，进行中返回 recovering，失败返回带原原因的 recovery-failed；不偷偷调用恢复。工具正常由已激活 graph 到达，脚本/测试先显式 await adoptRoot。取消、关闭和只读诊断不受此阻断。DSH 首次请求在发送模型前检查就绪及绑定，检查只读；冷/热 context 查询可以返回已授权事实及 recovering/recovery-failed 标识，不能触发或等待恢复。这样故障仍可诊断，又不会把查看状态变成执行。

合法空 store/not-activated、pending_review、旧无相位 Run 的 needs-recovery 都有具名结果；前两者可接受合法根入口/审核，旧无相位 Run 仅允许读与取消，不默认 active。存储读失败、工作区冲突、恢复执行异常必须使屏障失败，不能沿现有 warning/空报告路径冒充 ready；已提交恢复事实不回滚。显式选择已有图失败保持原选中图；create 失败按上文保留已登记/选中的新图及原因以便显式重试。待审重发不等于批准；submitted 补验证、waiting_children 登记 driver、terminal 关闸均在本票验收。测试须覆盖 graph/add 后恢复失败零模型输入/写入，以及 driver 已登记但屏障失败零 spawn，不能只测正常 activate。

查询用可信 session→graph→root store，读取一次 Task 快照定位该 session 对应的 Run/Task；结果投影可在 context 内复用，不另建索引服务。必要的内存 gate 观测只能读。运行期重新绑定仍走明确的 runtime 执行入口，取消屏障及陈旧读取保护保留；不把 context 变成第二个生命周期裁判。恢复须覆盖待审根、waiting_children 父、已终态子、admitted 未 spawn 批次和 replay，旧入口有调用者时同批替换，不能简单删掉 lookup 的副作用就宣布完成。

交接后再建 context 两个消费者。普通 worker 在 TaskStarted/handoff 已持久化、graph 成员已发布后才发首个模型输入；当前 onRunBound 在 spawn 返回后，context 首次读取不能依赖这个尚未回填的缓存。replay 的 parentRunId 是实验血缘，不是 Task 父子关系；由实际 Task 契约与该 Run 的 lineage 定位贡献和来源，不选择 store 中第一个 parentless Task 充当根。重启后也不能依赖内存 replayLineage 重建上下文。

验收除 D 节外，补三组承重反例：冷/热上下文查询和实际 prompt 装配都不触发审批、spawn、verifier 或 Task 状态写入；重启后第一条请求之前已完成必要恢复，waiting/terminal 会话第一条写工具即被拒绝；取消前后及跨取消完成点查询不重开 gate。模型日志保存正常上下文快照不算领域写入。迁移已有 R2 回归到新的实际读取/恢复入口，保留原断言，不删除反例以迎合新结构。

**A4/A5/S4-E：把已有主体迁走，再扩展行为**

A4 在接入新的问题阻塞前，先将本票涉及的 Run 等待、判决和终态清理在 runtime 包内明确归属。一个结束入口处理已存在 Run 的终态竞争、Review 与资源释放，普通执行、replay、取消/恢复用同一规则；尚未创建 Run 的 blocked Task 仍用其自己的语义，不为复用而造假 Run。保留一次结算、取消优先和先关闸/排空写入的顺序，测试跨真实 store/gate/workspace。提案协议与批次推进不能共用一份可任意改写的内部状态；文件拆分不改变事件写入所有者。

包内结构沿现有承重接口整理：运行观测保留 `observeWorkerRun`；终态模块集中 `settleSubmittedRun` 与基础 Review/清理；批次 driver 负责串行推进；replay runner 只组织一次实验执行并复用观测/结算。`index.ts` 持有配置、handle 和装配，直接调用这些内部模块，不保留同名大逻辑再套转发。A2 的绑定/恢复整理只向该模块传 Task 读源、ExecutionGate 与必要索引；以后修改提案流程时再将根/子提案的提交、继续、恢复归入一个 runtime 内部职责模块，根无 parent/run 的差异保持显式，不抽万能提案引擎。接口只交接必要能力，禁止把整个 `this`、全部 Context 或任意改写的状态大对象传给拆出的薄函数。未涉及的提案内部拆分不成为 A4 前置。

A5 将 Session 工具调用/压缩/token 观测移到 agent-runtime/DSH 的只读模块，runtime 保留基础终态派生和唯一提交。`DiagnosisProposal.targetType` 改为非空字符串，删除 reducer 与 task_diagnose 的九类建议白名单；Evolution 自己拥有窄的可执行目标类型，在实际转换入口重新校验，不让开放的建议类型传播为执行授权。验收未知建议能记录并在重开 store 后读回；`evolution_propose.fromDiagnosis` 对不支持目标拒绝且不写 ledger，prepare/apply 各自的校验继续保留，不自动注册执行器。旧九类记录仍可读；新值可能不被旧读者接受，按持久化规则记录版本与回滚限制，不以顶层指纹未变省略兼容性说明。诊断字段完整性、来源及引用检查继续保留。

S4-E 按 D 节整体迁移现有 Evolution 生命周期与工具消费者；不因新包出现再新增候选种类、评分平台或固定补丁目录。上述迁移各自在所属票完整验收，没有一项以“先留 stub，下票消费”通过。

本轮文档验证：6 份修改文件的 89 个本地链接目标、9 个代码围栏与 `git diff --check` 通过。三名 GPT-6 Sol 完成只读源码调查，Task 调查者另复核本节；已据复核明确未知建议在 evolution_propose 的转换闸和 R3 类型整理的有限范围。未改运行时代码，未运行构建/运行测试/模型实验；这是设计交付，不是 R3 或 A2 的实现验收。

### F. 后续交付组的冻结合同（2026-09-24）

本节关闭此前三类未决设计，与 D 的读取合同、E 的显式恢复合同共同作为派发依据。修改前备份 Singularity `70bcf4c` / 外层 `5bcc23c`。均为**设计已定、代码未实施**；不改变文首唯一顺序，也不把设计合同当作 R3/A2 的实现验收。这里固定对外行为、所有者和失败处置，私有文件布局与等价 helper 实现仍由工程 agent 决定。

#### F.1 A4：有持久来源的直属父子问答

固定工具为 `task_ask_parent({requestKey, question, blocking?})`（blocking 默认 true）与 `task_answer({questionId, requestKey, answer, resolves})`。身份均来自 live caller、当前 Run 和 Task 父关系，模型不传收件人或授权字段；根、reviewer 和无业务 Run 的节点不能使用 ask。答案只有是否解决当前问题的布尔声明，不新建 clarification/decision 等机器分类；`resolves:false` 保持 open，改契约的建议也必须如此。`resolves:true` 只解除该项执行阻塞，不修改契约/权限，框架不声称验证了自然语言答案正确。

replay 的 parentRunId 仅是实验血缘：parentless replay Task 调 ask 必须拒绝且零问答/投递副作用，不能询问 champion 的执行者。若 replay 内真实分解出子任务，才按该 Task 父关系问答。因此下文 ordinary/replay 覆盖要求包含合法父子正例与无语义父节点的拒绝反例，不要求制造一个虚假父节点使所有入口都成功。

正文使用发送 Session 的真实 `tool/call` 事件引用，agent-runtime 在提交领域意图前确认它已 flush；直接服务调用也必须提交可核对的同一来源，不允许伪造文本引用。Task 只记录 question/answer 身份、双方 Run、正文引用、messageId 与阻塞效果。专用问答事件维护已有 pendingQuestionIds/blockingQuestionIds，不能用 RunPhaseChanged 伪造一次主相位变化。id 按 Run/question 与 requestKey 派生，同 key 同内容返回原记录，异内容拒绝。

顺序固定为：持久正文来源 → Task 原子提交问题/阻塞或答案/解除 → agent-runtime 按同 messageId 投递 DSH inbox → flush 收件 Session 后报告 delivered。ask/answer 不等对方 loop 或回复。Task 意图后崩溃由显式恢复补投递；目标 inbox/history 已有同 id 就不重复入箱。无 inbox 条目不表示已消费：claim 在 pre-step 前可能已移除；context 从未处理问答事实重投影来源，只有实际模型 step 输入才能证明看过，工具领域效果仍以 Task 记录判定。回答已解除阻塞而尚未被模型读取时，下一请求必须包含该回答引用/正文后才能执行；不得仅因 answered 就从上下文删除。没有消费证明就保留引用，不另建 consumed 账本或第二套通信库。

agent-runtime 复用 live Agent.steer/followup、agents.resume 与 Session flush，持有唯一 handle；不使用要求 continuable activation 的 subagents.sendMessage。暂不可达记 unavailable，保留意图，恢复入口重试；不自动造替代父。active 有阻塞时停止受阻写入/分解/提交与无进展提醒，允许协调输入；waiting_children 的 batchId/写闸始终保持，所有阻塞解除也不能改为 active。父自动提交必须等未处理协调项完成。首版只新增一个外置 `maxQuestionsPerRun` 正整数限额，默认 8，按首次接受的 questionId 计数，重启不清零；等待照计原 wallTime/根截止，不另加问答重试或独立预算体系。终态取消未答项，迟到答案只留审计、不解除终态闸。

已知问答等待的 worker 重启后恢复同一 Session/Run，并从持久问答重建阻塞；不能沿用“所有在途未提交 Run 均取消”的旧恢复分支。先对账受管理写入/进程，无法安全接管就具名失败，不能重复不明外部副作用。归拢只限问答触及的普通/replay/恢复结算规则，不要求先重写全部 orchestrate。

验收 A4-1：子→等待中的父→子及三层转问，经真实 inbox/Task/gate 无同步死锁。A4-2：两个阻塞乱序作答，只解除对应项；未解决/契约变更、错父、重复/冲突 key、终态晚到与超限均有拒绝副作用断言，waiting_children 永不获写权。A4-3：分别在 Task 意图后、目标 append 未 flush、flush 后、claim 后未请求模型、模型已读但未回答时终止并重开，最终同一问答身份、一次领域效果；两种主相位和 ordinary/replay 均覆盖。A4-4：父离线恢复、截止取消、源不可读具名失败；正文只在 Session，零新 Graph 边，消息来源非 human。

内部交接顺序：问答事实/reducer与身份 → agent-runtime 投递/恢复 → runtime 阻塞/观测与 context/工具接线 → 独立故障验收。每次子代理仅领其中一个目标，整票验收不拆开。

#### F.2 S4-E：单文件 Skill 的真实双侧评估

本票的新可比评估只支持**替换已存在的单文件 SKILL.md**，不宣称它能新建执行 provider；资源文件/sidecar 新增仍明确拒绝。现有 Evolution 全生命周期、replay 报告、config-edit 与真实消费者迁入 evolution 包，Task runtime 的 Run 执行不迁；旧 capability/preset 记录及已应用对象回滚保留，不能为收窄新评估删掉它们。新 PROMOTE 必须具备本票可验证证据，没有支持的评估器就拒绝新晋升；历史报告不自动升级为新证据。

固定比较目标为“原失败案例修复且冻结的回归/holdout 不退化”；不做多目标打分或自动阈值学习。至少一条失败复现和一条未参与候选选择的 holdout，使用同一预先冻结的客观 verifier/AC，observed/holdout 各自非空。每个样本两侧各执行一次新的 Run，确定性测试精确断言结果；真实模型需统计推断时另定重复次数与预算，不能拿一次随机成功声称普遍改进。样本、输入、裁判、模型/工具、预算、候选身份和比较规则在运行前冻结，沿现有 replay manifest/report 增补必要身份，不另建实验管理服务。

运行器从同一初始快照建两个独立工作区，依次新跑基线与候选；每项报告关联真实 Task/Run/Review/Evidence 与内容身份。历史 champion 只定位原任务/失败，不是本次基线。成功率不能来自模型自填；主目标必须从失败变通过，成功回归保持通过，holdout 不退化。费用缺报保持 unknown；若冻结目标要求成本改善或某成本硬上限，未知即不足以晋升，否则仅作不可推断的观测，不当 0。最终 holdout 使用后不能再作为修订候选的未见样本，需新 holdout 或撤回未见泛化声明。

实验幂等键使用 proposal、prepared 内容身份、样本、baseline/candidate、重复序号；已结算 Run 复用其证据，在途实验按 runtime 恢复结果记录 interrupted/failed，不偷偷补跑或覆写。明确的新实验才能再计预算运行。decide/apply 两次既有人审保留，报告/候选/生产基线在应用前复检；取消和失败仍保存已发生实验与成本。

验收 EVAL-1：双侧真实 runtime/verifier 执行且互不污染，报告可回溯所有身份。EVAL-2：历史基线冒充、输入/裁判/模型漂移、伪造证据、双侧同失败、回归/holdout 退化均拒晋升；合法修复允许进入原人审。EVAL-3：重复调用、取消/重启不重计已完成样本、不替换失败记录；内容/报告/生产基线变化拒绝应用。EVAL-4：新包真实接管全部旧工具消费者，旧 ledger 可读及旧 applied 可回滚；没有 evaluator 的类型仍可查看历史但不得用旧报告绕过新晋升闸。验收在 fixture 中完成，不作模型效果声明。

内部交接顺序：生命周期迁移且旧行为回归 → 双侧执行和证据绑定 → 晋升闸/旧报告兼容 → 独立组合验收。主代理承担新包装配及全部工具接线的集成，不让单个子代理接整票。

#### F.3 A5 + S2-E：按终态事实启动诊断

唯一自动触发源选 **ReviewRecord.outcome=failed**，包括没有 Run 的 blocked Task 的既有失败 Review；不另设 capability 事件触发器。能力/产物缺口继续由实际拒绝处自动持久化现有 CapabilityGapDetected/ObligationRecorded，并进入该 Review 的诊断引用，模型未响应也可读。review 模块在提交后及 graph 显式激活后扫描尚未处理的失败 Review；终态提交只发布事实，绝不 await reviewer。源键固定为 `(rootStoreId, taskId, runId 或 no-run)`，符合已有每 Run/无 Run 唯一 Review，不用 latest-review 代替指定源。

自动与手动 `task_review_agent` 共用现有 reviewer ledger、授权/升级判定与每 store 预算（默认 1）；自动只处理当前既有规则允许的失败，未获触发资格或预算不足保留源并在查询中显示 suppressed 原因，不无限重试或暗加额度。诊断本身消费根截止与可用资源；没有业务 Run 的 reviewer 不造假 Run。A5 扩展 ledger 的最小 claim/completion/interrupted 事实：单 writer 下按 store 串行检查预算与 sourceRef，持久 claim 预分配 sessionId 后才 spawn，同一 sourceRef 只能一个 claim。A2 的 beforePrompt 确认该绑定已发布且一致；旧 started 行仍按旧方式计预算。崩溃后只恢复同一 session 或记录 interrupted，不自动重铸 reviewer；明确的后续尝试仍扣原预算。此扩展不宣称跨进程原子调度。

reviewer 经 context 自主取证、写 Diagnosis（targetType 为非空开放字符串）并给出一个有来源的实验/候选建议；未知原因如实未知，不强迫输出补丁。已有 Diagnosis 关联源 Review 即交接身份，没有 Diagnosis 的 interrupted 不伪装待执行候选。未启用 A6 时交接显示 pending，查询是真实消费者，不发布无实现的执行命令。不开新 incident、分类器或策略 DSL；根因搜索顺序由 Agent 决定。通用 Session 观测迁 agent-runtime/DSH；基础 Review 派生和唯一终态写入仍由 runtime 持有。

验收 REV-1：一次实际失败持久化后、模型零响应时缺口与 Review 可见；自动/手动重复触发及重启仅一个 claim/session，旧账计数保留，预算耗尽明确 suppressed。REV-2：reviewer 在实际第一请求收到源身份，并能主动读取关联兄弟/证据/历史；跨 graph 拒绝，未知结论能保存。REV-3：claim 前后、spawn 前后及 Diagnosis 落库前后崩溃不重复副作用；诊断失败/模块未装配不阻止原 Run 结算。REV-4：未知 targetType 可持久读回，但 evolution_propose.fromDiagnosis 拒绝不支持的执行目标且零 ledger 写；旧记录/回滚兼容限制有记录，未开启 A6 的交接保持 pending。

内部交接顺序：指定源读取/ledger 去重 → reviewer 协调与 Session 观测迁移 → Diagnosis/交接查询 → 独立恢复验收。只在此组开始自动诊断，不提前启动候选写入。

#### F.4 A6 + S2-R + S3：候选闭环与原目标的新尝试

本组保持能力缺口、产物缺口和 L1/L2 的原验收，不把目标偷换成“只改善一个已存在 Skill”。先消费 F.3 的 pending Diagnosis/源 Review，由 evolution 以该交接身份幂等启动 supervisor；绑定复用可信委派 ledger，标明协调角色及有限工具集，无业务 Run 不冒充 root。关闭 evolution 时不启动；预算不足、未知执行目标或需新增权限时保留交接并具名停止。Agent 决定组合/实现方法，人类只审证据与晋升。

**候选支持范围固定**：在 S4-E 单文件 Skill 替换之外，扩展现有 `CapabilityMutation`，支持恰好一条 capability 整行变更，可附一个新 Skill 目录，仅含 SKILL.md 和现有 v1 SKILL.contract.json。L1 使用已有授权工具/Skill 配置这一行；L2 由 Agent 生成附带的执行型 Skill。sidecar 必须引用已注册且独立的 verifier、resources=[]、摘要匹配，requiredTools 不超出现有授权，capabilities 包含该行。指导型 Skill 不能充执行 provider；新工具、verifier 实现、preset/runtime policy 修改和任意资源包不在本次执行范围，具名拒绝，不要求人补写。声明同名生产 Skill 已存在时拒绝新增，替换既有单文件 Skill 沿 S4-E。字段扩展保留旧 mutation 的解释。

**评估/应用必须同组补齐**：复用 S4-E 成对运行器，候选同时挂 capabilityOverrides 与 extraSkillRoots。缺 provider 的基线可能在真实准入时拒绝：记录同一冻结契约的真实拒绝及 gap/proposal 来源，标明 not-admitted、无 Run；不得造 champion/失败 Run，也不得跳过基线预检。新增受限的冻结契约评估入口复用 runtime 原规范化/准入/执行链，不能绕过旧 replayTask 的终态要求来伪造已执行。候选必须真执行并通过同一独立判据、回归与 holdout，新增 capability 的单纯准入通过不算修复。prepared 固定 capability 行与文件的组合身份及生产基线；apply intent 在现有 evolution ledger 持久化后才写文件/配置，恢复按 intent 补齐或回滚，全部完成并成功更新运行 registry 才记 applied。部分写入期间禁止新 Run 使用该 provider，失败不报成功；rollback 同样处理整组对象，不删除基线中已存在的文件。旧 ledger 的单对象读取/回滚保留，不引入通用跨库事务平台。

**恢复入口固定为 `task_recover({sourceDiagnosisId, requestKey})`**：仅向可信 supervisor 协调会话开放，工具与直调服务均检查源归属、批准应用/解决证据、原契约/预算、当前没有在途恢复尝试。该入口恢复的是原目标的**新 Run**，不是旧 Run 复活或旧 admitted proposal 再次消费。runtime 在同一 store 为失败原根 Task 创建新 Run 与新 Session（旧 session 保持终态），复用原根预算起点；以原 Task 的不可变目标/AC 做顶层验收。根 graph 绑定仍指原目标，查询显式区分旧失败 Run 和当前恢复 Run。`TaskRetried` 可复用；返回新 Run/Session 身份后，由该协调节点通过现有 task_decompose 提出新批次，runtime 依据持久恢复关联路由到恢复准入分支，不由模型传 bypass 标志。普通 decompose 一次性闸不放宽；无分解的原目标直接按原契约执行新 Run。

调用归属固定为工具适配 → evolution 的恢复协调入口 → task-runtime 的执行恢复入口。evolution 解析 Diagnosis/候选关联，核对可信协调者及自己持有的批准、applied/rollback 记录；runtime 核对本 store 的源 Task/Run、契约、当前 provider 内容、依赖证据、预算和恢复幂等，再提交新尝试。两层的直接调用入口各自重检所属规则，不把校验只放在工具函数中；runtime 不导入 evolution、不读取晋升账本、不接受模型传入的 approved 标志。宿主组合层负责两者接线，内部调用不能成为额外暴露的模型工具。

恢复按 Run 固定新 batch 身份（parentTaskId + parentRunId），保存本次成员及旧来源；不覆盖 Task 原批次成员或改写旧失败/blocked 子 Task。新 proposal 引用本次 Run，创建失败/blocked 分支的替代 Task，必要的补产物任务由 Agent 按 T1 提出并经过原审核/准入。已通过兄弟以具体 Run/Evidence/输入与产物身份引用复用；依赖映射及父 AC 的 childEvidence 在本次批次绑定中解析，不能靠改原 AC 里的 id 跳过检查。无效复用拒绝并列明受影响项，由本次新提案安排新执行。恢复尝试和新批次准入分别按 requestKey/既有 proposal 消费幂等，重启续同一身份；不再使用固定 `b-<taskId>` 让不同尝试碰撞，也不依赖父再次分解旧批次。新 Run 终态决定本次目标结果，旧 Review/Evidence 均保留。

能力候选应用与产物修复不是同一件事：缺产物沿已有 producer/dependsOn/Obligation 来源新建或执行合法的生产任务，只有产物与 evidence 真满足条件才解除；无需共享能力变更时不强迫先造 EvolutionProposal。task_recover 对能力变更要求已批准应用，对待生产的产物只要求缺口与来源可核对、生产所需能力可用，不能要求产物已经存在才允许启动其生产恢复。该协调节点先读事实/提新批次，受缺产物影响的业务消费者仍须通过原依赖闸；root 最终提交必须检查产物已满足。坏裁判不能由候选改写以通过，保留诊断；连续失败使用既有根预算/无进展停止，不为每种缺口增加修复分类或重试控制器。候选构建和实验的业务 Run 都计原根总额，新 recovery/supervisor 不获得新预算。

验收 EVO-1：L1 用现成能力组合解决一个真实缺口；另一例由 Agent 生成 L2 执行型 Skill/sidecar、独立验证后仅由人批准；人工编写候选不合格。确定性 scripted 验收只证明接线，真实 Agent 生成效果须另有明确授权与预算的实跑记录，不能混称；没有该记录只交付机制、不宣称自主生长有效。EVO-2：缺 provider 基线真实拒绝、候选真实通过；错误候选、弱化 verifier、越权工具、内容漂移、人工拒绝均不应用、不恢复为成功。EVO-3：能力及产物缺口分别经真实 source→Diagnosis→处置→task_recover→新根独立验收；有效兄弟不重跑，无效引用拒复用并显式重建，旧失败可读。EVO-4：在联合应用每个持久边界、恢复 Run 创建后/批次准入前、准入后/spawn 前及新根结算前重开，provider 无半成品可用、同 requestKey 无重复 Run/批次、预算不归零；重复批准、取消、rollback 后的新准入全部重检，旧在途 Run 不热换版本。

EVO-1 的真实运行证据是第 14 项整组已验收的必要条件，不是可省略的效果附件。派发时须填写本次实验授权和预算，未授权则先完成机制与确定性验证，并将整组保留待验收、列明所缺实跑条件；不能擅自收费运行，也不能填已验收后另排“以后验证自进化”。一组成功仅证明这些冻结案例，不宣称泛化成功率。

内部交接严格串行：①有限 capability+Skill 候选/overlay 与联合应用回滚；②缺能力基线评估及证据闸；③按 Run 的恢复批次、原 AC 绑定与证据复用；④交接消费/supervisor 工具接线；⑤独立端到端验收。主代理保留公共合同/持久化兼容/集成；每个子代理只领一个已固定子目标，不能一次要求其实现完整自进化。整组完成前不开放自主执行开关；任何已承诺路径不以“下票补齐”通过。

本次设计验证：三名 GPT-6 Sol 分别只读核对 context/恢复、问答、Evolution 的实际接口；context 调查者复核 D/E 后指出 graph/add 提前选中及 driver 先启动后登记两处冲突，已在 E 明确选择与失败处置。8 份修改文档的 96 个本地链接目标、15 个代码围栏及 git diff --check 通过。未改运行时代码、未运行构建/运行测试或模型实验，以上不能作为任一建设票的实现验收。

2026-09-24 派发前重读：保留现有归属、顺序和整组完成闸；A6 工作量最大，其内部五项只作为主代理的串行交接，不得整组转派一个子代理。补明 replay 问父依据、恢复协调与执行的调用方向、EVO-1 实跑证据的完成条件，避免执行者自行改变语义。修改前基线 `e762946` / 外层 `319ab96`。此次为文档一致性复核，未重新验收运行时代码；R1 已验收，当前可直接派发[第 8a 项 R3 prompt](execution-prompts/08-r3-task-contract-relocation.md)。

## R2 Q1 返工（查询重开取消中的执行闸）执行与验收记录（2026-09-23）

> 本记录只覆盖第 7 项 R2 的返工点 Q1（计划「补救交付复核」Q1）：`gatePhaseFromStore` 在取消尚未持久化时用 store 的旧相位把闸改回 `active`。R2 原交付的 marker 顺序、无用途 API 收敛、恢复绑定派生等已成立部分未重做；R1/A2 未实施；未调用真实模型。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 返工，2026-09-24 进度审核未通过；以下保留原交付实跑记录 |
| 执行 agent / 任务链接 | Kimi Code 主代理（指挥/集成/全量/文档）+ 1 个实现子代理（修复 + C1/C2 定向回归）+ 1 个只读独立复核子代理；[R2 专项 prompt](execution-prompts/06-r2-cancellation-gate.md) |
| 开始日期 / 验收日期 | 2026-09-23 / 待进度审核 |
| 前置验收记录 | 第 6 项 A0 返工（Q2/Q3）已验收（交付 `cce3157` / 外层 `2c299b7`），R0 证据保留；本票只做 R2 Q1 |
| 修改前基线 | 开工实际 HEAD `4523ef1`；其中未提交的派发材料先保存为 Singularity `f9860b4`、外层 `3ac8676789`（本票唯一改动基线，不回退 `cce3157`） |
| 交付版本 | Singularity `250a04f`（修复 + 测试；含重建的 `task-runtime/lib`），本记录随后单独提交，外层只提交子模块指针 |
| 验收项对应 | C1 → `cancelGraph` 窗口内的查询路径（`proposalStoreFor`→`runForSession`→`lookupRun`→`gatePhaseFromStore`）→ `tests/integration/cancellation-gate.spec.ts`（先红后绿）；C2 → 第二次启动的重绑定入口 → `tests/integration/a3-recovery.spec.ts` 新增用例（既有重绑定用例未改仍绿）；C3 → 同 spec 的 active 相位放行 + 全量回归；C4 → 全部 `setPhase`/`setTerminal` 与相邻 store 写入的调用顺序审计（下「跨入口/组合反例」） |
| 实际检查 | `packages/singularity`：`pnpm build` 通过（exit 0，11 包）。外层：`pnpm vitest run --project unit packages/singularity` = 44 文件 / 1459 项通过；`pnpm vitest run --project integration packages/singularity` = 38 文件 / 267 项通过（较基线 +1 文件 / +2 项：C1 spec + a3-recovery 新用例）。`pnpm run verify-persistence` = 4 根匹配（持久化合同未变，无需兼容性记录）；`git diff --check` 干净；`agent-singularity` 的 `pnpm exec tsc --noEmit` 通过 |
| 跨入口/组合反例 | **C1（先红后绿）**：call-through spy 暂停真实 `cancelGraph` 的落盘（暂停点只控等待处，store 实现照跑），窗口两侧事实已断言（gate=`terminal`、store 仍 `running`/`active`），窗口内经根 session 真实 turn 依次发起写/读/写。未修复实现（pristine 源码）上红：`AssertionError: expected 'active' to be 'terminal'`（读取把闸改回 active），另一 scratch 探针显示读后 `graph_spawn` 获准且工具体执行；修复后读成功、读前后写均拒且 stand-in 体零执行、无在途写，释放屏障后 run/task `cancelled`、session 仍 `terminal`。**C2**：第二次启动（真实 JSONL）经 `runForSession` 绑定后，`waiting_children` 父与终态子经真实 `ctx.tools.execute` 均拒写（stand-in 体按次断言未执行），`task_read` 仍可用且读后相位不变。**C3**：同一写工具在合法 `active` 相位被放行（探针命中），证明修复不是一律拒绝。**C4**：`admitBatch`/根激活/`submitResult`/批次代父提交/`onRunSettled`/`adoptRoot`/`rebindActivatedRoot`/worker·replay 启动全部「先落盘、后移闸」，只有 `cancelGraph` 是「先关闸、后落盘」，故未为其他入口添加假想反例。 |
| 独立复核 | **已实际执行**（只读子代理 `agent-23`，对本票工作树 + `250a04f` 前的工作副本）：确认缺陷关闭（逐点审计全部相位写入者与读取路径）、恢复路径不受影响、C4 调用顺序审计成立、C1 测试非空洞（承重断言在 pristine 上正是缺陷原因）；实测相关两个 spec 16 项通过。复核的 3 条测试证据口径问题（根 session 的 `task_read` 不经重绑定门、`ranTools` 是整 boot 累积、`graph_spawn` 是 stand-in）已由主代理修正（注释纠正 + 按次计数断言）；复核另记 4 项未关闭的既有边界（见「未解决缺陷」，超出本票授权未修） |
| 文档同步 | 主 guide §5.12（关闭结论、取消/恢复保证、源码/测试锚、四项边界）+ 文首更新行 + §3 派发顺序 + §4.1 生命周期行 + G15；本计划第 7/8 行、派发入口段、本记录；[执行 prompt 入口](execution-prompts/README.md) 当前派发段。原 R2/R1 历史证据与失败记录保留未覆盖 |
| 模拟与未覆盖范围 | 真实：DSH loop、`TaskRuntime`（经 `ctx.plugin`，闸真在 `tools/pre-execute`）、store 与 reducer、`proposalStoreFor`/`runForSession`、`task_proposal_read`/`task_read`、JSONL 重开与恢复。模拟：模型输出（scripted）、非 singularity 工具体（stand-in，仅记录自己被调用）。未覆盖：未跑真实模型/BB/部署；`lib` 消费路径未实测；四项边界（下）只读论证未建探针 |
| 未解决缺陷 / 阻塞 | 本票合同内无未解决缺陷。如实上报、超出授权的既有边界（**未修**）：(1) 子批次 driver 的 spawn 续跑（`orchestrate.ts`：先 `startRunIn`，`env.spawn` 之后无条件 `setPhase(session,'active')`）被取消插入时会改回 `active`，且取消结算抢先时 `settleChildRun` 提前返回不再 `onRunSettled`，该 session 可停在 active 而 run 已 cancelled——「取消中闸被解除」的同族但在途决定路径，非本票查询回填，只读论证未建探针；(2) `adoptRoot`/`rebindActivatedRoot` 两条 store 派生写相位未过同一守卫，复核未能构造可达轨迹；(3) `closingStores` 为集合而非重入计数，同一 store 两次并发 `cancelGraph` 会在先完成者处删条目（graphs 的 create/remove 由 `transition` 串行，直调属调用方竞争）；(4) `unload` 的 terminal 同样无 store 记录，但 pre-execute 钩子随 `[Service.init]` effect 先撤除（按 disposables 顺序论证，未实测） |
| 最终验收结论 | 2026-09-24 进度审核：返工，延迟查询跨取消完成点反例失败；原内部验收结论不足以关闭 Q1，详见下节 |
| 下一项 | 唯一顺序第 8 项 R1 补验证（Q4/Q5）：**前置为第 7 项经进度审核验收**，使用 [补验证 prompt 与 V1–V6](execution-prompts/07-r1-supplemental-validation.md)；本票不执行，也未并行启动 |

本票主代理的「问题 → 入口 → 验收」映射（实施前固定）：问题=取消已关闸、取消未落盘时，只读查询把 store 的旧相位写回内存闸；入口=`task-runtime/src/index.ts:cancelGraph`（关闸先于落盘）+ `gatePhaseFromStore`/`lookupRun`/`runForSession` + `agent-singularity/src/tools/{task-proposal-read,root-store}.ts`；C1 走真实 tools 管线复现该窗口，C2 走新进程重绑定入口，C3 用合法 active 正例与既有回归，C4 用同一回填函数的调用顺序依据。修复=运行时记录正在关闭的 store（`closingStores`），store 关闭期间不移动已持有相位的 session；建立于 gate 循环前、`finally` 清除；取消未触及的 session 仍照 store 补闸。

### R2 进度审核（2026-09-24）

- 结论：**返工，不能派发 R1**。被审范围 `f9860b4..edfcce3`；修改文档前保存审核基线 `0400d25`（空提交，内容等同已提交交付）/ 外层 `9f33ddc`。本轮不修改生产代码，不执行 R1。
- **P1 / Q1 未关闭**：`task-runtime/src/index.ts:4994` 只在回填时检查 closingStores；`lookupRun` 在 await resolveBinding 前没有保护读取与后续相位应用之间的有效性。当查询读到旧 active 后延迟返回，cancelGraph 已完整结束、finally 删除集合条目，旧结果便通过守卫，把已取消 session 的 terminal 重开为 active。该反例不依赖并发 cancel、spawn 或未建能力，属于本票“查询不能解除取消屏障”的原合同。
- 实跑确定性探针：真实 scripted-loop 的 intake 建 active 根；call-through spy 仅暂停第一笔目标 runIn 已读取后的返回；启动真实 runForSession，等待屏障；await 真实 cancelGraph，确认持久 run=cancelled 且 gate=terminal；释放查询后断言 terminal，实得 active。Vitest 1 项失败，错误 `expected 'active' to be 'terminal'`。探针只替换等待点，不替换 runtime/store/gate 判定；本轮未在该探针额外执行写工具，不把 gate 状态证明夸大为真实文件写入。临时探针已删除，生产文件零改动，重现步骤已写入原 R2 prompt，要求修复时保留正式回归并补工具体零副作用断言。
- 本轮检查：构建完成；全量 unit 44 文件 / 1459 项、integration 38 文件 / 267 项通过；定向 cancellation-gate + a3-recovery 2 文件 / 16 项通过；持久化四根匹配；agent-singularity 类型检查通过。既有全绿不覆盖上述延迟结果交错。本轮没有真实模型调用，也没有重新确认原交付列出的四项边界为安全。两名只读子代理未启动完成、无复核产出，本轮不计为独立复核通过；阻塞结论依据主代理实际执行的反例。
- 下一步：仅派 [R2 补充返工](execution-prompts/06-r2-cancellation-gate.md)，保留已成立修复，关闭跨取消完成点的陈旧查询回填；再次进度审核通过后才能派第 8 项 R1。原 R2 内部验收记录保留为历史，不覆盖本结论。

## R2 Q1 补充返工（跨取消完成点的陈旧查询）执行与验收记录（2026-09-24）

> 本记录只覆盖上节审核的返工合同：查询在取消窗口内已受保护，但**读取跨过取消完成点**时仍会回填旧相位。首轮交付 `250a04f`/`edfcce3` 的其余部分（marker 顺序、无用途 API 收敛、窗口内守卫、C2 恢复正例）保留未重做；R1/A2 未实施；未调用真实模型。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 已交付待进度审核，2026-09-24 |
| 执行 agent / 任务链接 | Kimi Code 主代理（指挥/集成/全量/文档）+ 1 个实现子代理（补 applicability 机制 + 跨完成点反例）+ 1 个只读独立复核子代理（复核后由主代理加固一处断言）；合同见 [R2 prompt 的补充返工合同](execution-prompts/06-r2-cancellation-gate.md) |
| 开始日期 / 验收日期 | 2026-09-24 / 待进度审核 |
| 前置验收记录 | 上节「R2 进度审核（2026-09-24）」= 返工合同来源；第 6 项 A0 返工已验收；首轮修复 `250a04f` 的窗口内守卫保留 |
| 修改前基线 | 审核基线 `cecc5b6`（内容等同 `0400d25`，含审核文档）/ 外层 `ae1a7227` |
| 交付版本 | Singularity `8f9086e`（修复 + 测试；含重建的 `task-runtime/lib`），本记录随后单独提交，外层只提交子模块指针 |
| 验收项对应 | C1 追加例 → 跨完成点的陈旧读取（spy 扣住真实 `task.runIn` 的返回）→ `tests/integration/cancellation-gate.spec.ts` 第二例；机制 → `task-runtime/src/gate.ts:decisionToken/applyStorePhase` + `task-runtime/src/index.ts:gatePhaseFromStore/lookupRun` → `task-runtime/tests/unit/gate.spec.ts`（`applyStorePhase` 组）；C2 → `tests/integration/a3-recovery.spec.ts`（两例，未改仍绿）；C3 → 两例都在 `active` 相位先放行同一写工具 + 全量回归；C4 → 另核对「store 派生相位在决定之后应用」一族（查询路径已并入 token，两条绑定门仍裸写、如实记为未关闭） |
| 实际检查 | `packages/singularity`：`pnpm build` 通过（exit 0，11 包）。外层：unit 44 文件 / 1461 项通过（首轮 1459 + 2 项新单测）；integration 38 文件 / 268 项通过（首轮 267 + 1 项新集成例）。`pnpm run verify-persistence` = 4 根匹配（持久化合同未变）；`git diff --check` 干净；`agent-singularity` 的 `pnpm exec tsc --noEmit` 通过。任务运行时包自身 `tsc -p` 仍报 3 个**既有**错误（`src/index.ts:864`、`:5531`（基线 5509，行号随本次新增位移）、`../task/src/index.ts:54` 声明合并），与基线一致、非本次引入；该包按 G9 不在严格类型闸内 |
| 跨入口/组合反例 | **先红后绿（两例都在未修复实现上红）**：新例在首轮修复后的树上仍红——`AssertionError: expected 'active' to be 'terminal'`（查询释放后把已取消 session 的 terminal 重开为 active），正是审核的复现轨迹；窗口内例在**首轮修复前**的树上红（`expected 'active' to be 'terminal'`），本轮未改动。修复后两例都绿并断言：读取仍成功、gate 保持 `terminal`、随后 `graph_spawn` 经真实管线被 `phase "terminal"` 拒绝、stand-in 工具体零执行、无在途写；测试自带「该 park 是本查询的读取且查询当时未作答」的断言，防止未来后台读取偷走屏障。机制两守卫各自承重，只保留其一会分别在这两例上失败（窗口内读取取到的 token 是新的；集合在 `finally` 已清）。 |
| 独立复核 | **已实际执行**（只读子代理，对本票工作副本 + `cecc5b6` 基线逐点核对）：确认① 查询路径的 store 派生写入全部只经 `applyStorePhase`（仓库内 `applyStorePhase` 只有一个调用者，两分支 token 都取在被判定的读取之前）；② **未见回归**（`decisions` 只被 `decisionToken`/`applyStorePhase` 读取，其余消费者观察到的相位表形状不变）；③ 逐点检查「丢弃 store 值是否会丢合法迁移」——本进程决定都在自己的落盘之后、run 相位轴单调，唯二先于落盘的决定正是 `cancelGraph`/`unload`，重开恢复/`reconcile` 重启/`onRunSettled`/同 session 第二 run/旧无相位记录都不受影响；④ 两守卫互不可替代；⑤ 测试非空洞、无悬挂 latch。复核指出的两处轻微弱点：新例未断言「被扣住的是本查询的读取」（已由主代理补 `rootReads`/`querySettled` 断言）、「丢弃 vs 未应用」只在单测层精确区分（集成层由红/绿对照说明：未修复时同一断言实得 `active`，即该路径确实到达应用点） |
| 文档同步 | 主 guide 文首 2026-09-24 行、§5.12（两条轨迹的关闭、两守卫分工、C1 两例、源码/测试锚、边界 1/2 的更新）与 §4.1 生命周期行、G15；本计划第 7/8 行、派发入口段、本轮建设粒度、本记录。审核结论与首轮交付记录保留为历史，不覆盖；[执行 prompt 入口](execution-prompts/README.md) 顶部当前态同步 |
| 模拟与未覆盖范围 | 真实：DSH loop、`TaskRuntime`（`ctx.plugin`，闸真在 `tools/pre-execute`）、`TaskService`/reducer、`proposalStoreFor`/`runForSession`、`task_proposal_read`/`task_read`、真实 `cancelGraph`、真实工具注册与派发。模拟：模型输出（scripted）、`graph_spawn` 等 stand-in 工具体（只证明工具体未被触达，不证明真实文件写入）、spy 只控制等待点（store 实现照跑）。未覆盖：未跑真实模型/BB/部署；多进程写同一 store 只有推理无测试；`lib` 消费路径未实测；四条边界未建探针 |
| 未解决缺陷 / 阻塞 | 本票合同内无未解决缺陷。如实上报、超出授权的既有边界（**未修、也不因记录即视为安全**）：(1) spawn 续跑（`orchestrate.ts` 两处无条件 `setPhase(session,'active')`）会把取消刚置的 terminal 改回 active，且取消结算抢先时 `settleChildRun` 提前返回不再 `onRunSettled`；它是「刚起了 run」的决定而非 store 读取，token 既不能拦也不该拦；复核确认机制存在，但未证实前提「`env.spawn` 可在批次 signal abort 后返回」（DSH signal 语义为创建期生效）；(2) `adoptRoot`/`rebindActivatedRoot` 两条绑定门是**裸写**的 store 派生相位，形状与已修缺陷完全相同，但复核只由调用图给出「未证明可达」（`graphs.create` 另铸 root session 且与 `graphs.remove` 同由 `transition` 串行；`rebindActivatedRoot` 需已关闭根 session 与未消费根提案同时在场）；(3) `closingStores` 是集合而非重入计数，同一 store 两次并发 `cancelGraph` 会在先完成者处删条目（graphs 的 create/remove 由 `transition` 串行，直调属调用方竞争）；(4) `unload` 的 terminal 无 store 记录，其 pre-execute 钩子随 `[Service.init]` effect 先撤除（按 disposables 顺序论证，未实测） |
| 最终验收结论 | 待进度审核确认；本票内部验收（C1 两例 + C2/C3/C4 + 全量实跑 + 独立复核）通过 |
| 下一项 | 唯一顺序第 8 项 R1 补验证（Q4/Q5）：**前置为第 7 项经进度审核验收**，使用 [补验证 prompt 与 V1–V6](execution-prompts/07-r1-supplemental-validation.md)；本票不执行，也未并行启动 |

补充返工的「问题 → 入口 → 验收」映射（实施前固定）：问题=store 读取与其相位应用不是一次原子动作，读取跨越了一个决定（取消完成并落盘、`closingStores` 已清）时，读回的旧 `active` 会在决定之后被应用；入口=`gatePhaseFromStore`/`lookupRun` 两分支 + 真实查询路径 `task_proposal_read → proposalStoreFor → runForSession`；修复=把「本进程对该 session 做过几次相位决定」作为读取的有效性 token（`ExecutionGate.decisions`/`decisionToken`/`applyStorePhase`，token 在读取前取、应用时比对，不匹配即丢弃），与既有 `closingStores` 守卫各覆盖一条轨迹；验收=新增跨完成点反例（先红后绿、真实管线断言写/spawn 仍拒且工具体零副作用）+ 原 C1 窗口内例 + C2/C3 回归 + C4 与「store 派生相位」族群核对。

### R2 补充返工进度验收（2026-09-24）

- **结论：第 7 项 R2 Q1 已验收，可派第 8 项 R1 Q4/Q5。** 被审实现为 `8f9086e`，文档交付为 `40aabb8`；修改本记录前备份 Singularity `e9f9a1b` / 外层 `a506806`。本轮没有修改生产代码、运行真实模型或提前实施 R1。
- 针对上次失败轨迹，`lookupRun` 两条绑定路径均在读取前取执行闸决定 token；`cancelGraph` 设置 terminal 会递增该 token，跨完成点返回的旧 active 结果由 `applyStorePhase` 丢弃。原 `closingStores` 守卫仍覆盖取消已关闸而尚未落盘的读取。两种交错各有真实工具管线集成反例；新例确认真实 store 已 cancelled、读取可回答、随后 `graph_spawn` 被拒且测试工具体零执行。恢复时的 `waiting_children`/terminal 及正常 active 写入仍有正例。
- 本轮实跑 `pnpm build` 通过；unit 44 文件 / **1461** 项、integration 38 文件 / **268** 项通过；`pnpm run verify-persistence` 四个事件根匹配；`git diff cecc5b6...40aabb8 --check` 与工作区检查通过。构建包含 agent-singularity 的严格类型检查。独立只读 Spec 复核另跑取消/恢复定向 2 文件 / 17 项通过，未发现本票合同内可达违约；Standards 复核未见硬违约，仅指出 `applyStorePhase` 的 boolean 返回值无生产消费者，属非阻塞的简化建议。
- 本次验收**仅关闭 Q1 查询回填的两条已证实交错**。原记录的 spawn 续跑、`adoptRoot`/`rebindActivatedRoot` 裸写、同 store 并发直调 cancelGraph 与 unload 边界未由本轮证明安全；没有把它们改写为已验收保证。R1 聚焦 S3 澄清判据和实验账，继续按 [V1–V6 合同](execution-prompts/07-r1-supplemental-validation.md) 独立验收；A2 不因 R2 通过而提前派发。

## R3：已有 Task 合同归位 执行与验收记录（2026-09-24）

> 本记录覆盖第 8a 项 R3（合同见 E 节与 [R3 单票 prompt](execution-prompts/08-r3-task-contract-relocation.md)）：只做三项已核实错位合同的纯迁移。`task/src/types.ts` 其余整理、`index.ts`/`orchestrate.ts` 拆分、公开面收窄（`decomposeAndRun` 等）不在本票；未调用真实模型、未部署、未推送。

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | 已验收，2026-09-24 |
| 执行 agent / 任务链接 | Trae 主代理（三段迁移、调用方替换、集成、全量检查、文档）+ 1 只读独立复核子代理；[R3 单票 prompt](execution-prompts/08-r3-task-contract-relocation.md) |
| 开始日期 / 验收日期 | 2026-09-24 / 2026-09-24 |
| 前置验收记录 | 第 8 项 R1 已验收（完成轮 3 判 `pass / path2-limited-goal`，独立复核「pass 合法」，见上节）；仓库外证据目录 `r1-*` 只读未触碰 |
| 修改前基线 | Singularity `8c59f22` / 外层 `5d34edcddd`，两仓开工时均干净（R1 验收基线 `7f3d0ee`/`7e0652e4f8` 之后的 R3 prompt 发布提交）；外层 `thirdparty/deepseek-harness` 的既有未跟踪内容不属本票、未触碰 |
| 交付版本 | Singularity `8ee49c6`（代码+测试+重建 lib；git 记录 `task→task-runtime/src/skill-contract.ts` 相似度 95%、spec 100% 纯移动）和 `8d1dce9`（交付文档）；进度审核前另建 `dd18d25` 基线 checkpoint，审核修订见后续提交；外层只提交子模块指针 |
| 验收项对应 | R3-1 → `task-runtime/src/skill-contract.ts`（内部模块，不入包 index）+ `sidecar.ts`/`run-binding.ts` 消费 + `task/src/index.ts` 删 `export * from './skill-contract.ts'` → `task-runtime/tests/unit/skill-contract.spec.ts`（22 项，仓库外 `sha256sum` 固定向量原样通过）+ `sidecar`/`run-binding`/`provider-precheck`/`provider-load`/`carried-precheck` 既有套件；R3-2 → `verifier/src/types.ts` 新持五类型，`command-verifier`/`composite-verifier`/`review-verifier`/`index.ts` 及三个 spec + `tests/integration/verifier-selftest-inputs.spec.ts` 全部改用本包类型，task 零 verifier 导入（grep 复核）→ `verifier/tests/unit/verifier-registry.spec.ts` 52 项（注册闸、自测 fail 拒绝、版本盖章、logRef 逃逸）与 `verifier-selftest-inputs.spec.ts` 集成 6 项原样通过；R3-3 → `tests/support/legacy-root.ts` 持 `RootTaskSpec`/`TaskDefinition`（值与形状与删除前逐一相同），`task/tests/unit/proposal.spec.ts` 改从测试支持层导入，生产零导入 → `proposal.spec.ts` 219 项（提案恢复/原子提交反例）与 `a3-recovery`/`proposal-recovery` 等集成套件通过 |
| 实际检查 | 按依赖顺序实跑：① `packages/singularity` `pnpm build` 通过（11 包；`verifier/lib/index.js` 字节不变，类型级迁移）；② 外层 `pnpm vitest run --project unit packages/singularity` = 44 文件 / **1461** 项通过；③ 外层 `pnpm vitest run --project integration packages/singularity` = 38 文件 / **268** 项通过（均与 R2 Q1 验收后基线数量一致，零增删）；④ `pnpm run verify-persistence` = 4 根匹配（声明根未动）+ `git diff --check` 干净；⑤ `agent-singularity` `pnpm exec tsc --noEmit` 通过（P1 基线未回退） |
| 迁移前后证据（内容身份） | 经真实生产入口对同一执行型 sidecar fixture 复算：迁移前（`task/lib` 旧构建，实际生产导出）`skillContractDigest` = `a5ceee1b8e59556a1575044bebcb788ff255c4d452978075500ca85f4117d1e3`、`skillContentDigest` = `e7982b5c2d59d526dab6ad16c96b80672565769f7810e9c8b6543691e0ecc3ac`；迁移后（`task-runtime/src/skill-contract.ts` 经 node type-stripping 实跑）两值**完全相同**；合同 digest 与 spec 内仓库外 `sha256sum` 固定向量一致。旧 Run binding 读取（`readRunBinding`）、真实 provider precheck/绑定/晋升拒绝语义由既有 S1-C 套件原断言覆盖，全部未改 |
| 独立复核 | **已实际执行**（只读独立复核子代理，Opus，对工作树 + 基线 `8c59f22` 逐点核对）：自算 diff 分类全部 24 个改动文件均属三项迁移或重建 lib，无超授权改动；新旧 `skill-contract.ts` 仅 import 源、docstring 与 `@module` 标签差异，校验规则/字段集/缺陷文本/digest 逻辑零变化；迁移 spec 相似度 100% 纯移动；verifier 五类型定义与删除的 task 段落逐字相同；`task/src/service/state.ts` 零 diff、`task/src/index.ts` 仅删一行导出；复核**自行重算** digest 并独立复跑 task/verifier/task-runtime 30 文件 / 982 项通过；workspace 级 grep 确认无生产代码从旧路径导入任何被迁符号、task/task-runtime 无 verifier 包导入。三条 note 级发现（verifier 删除对 task 事实类型的 re-export、task 字段注释保留 digest 规则名、`contract.ts` 注释去除 `TaskDefinition` 指涉）均为迁移的必要后果，判 pass |
| 文档同步 | 主 guide 文首最新行、§1.4 尾段、§1.5 R3 执行事实（源码/测试锚、迁出位置、保留边界、未完成项）、§3 派发顺序、§5.8 侧车契约与测试锚路径修正；本计划第 8a 行、E 节 R3 状态、派发入口段、本记录；[执行 prompt 入口](execution-prompts/README.md) 顶部与当前派发段。R1 历史记录与失败轨迹保留未覆盖 |
| 模拟与未覆盖范围 | 真实：全部迁移后生产入口（sidecar 装载/预检、run 绑定、verifier 注册/自测/判决、提案恢复、replay、直接服务调用、插件替换）经既有真实链路套件；digest 复算经实际生产模块。模拟：无（本票零新 fixture、零 scripted 消费）。未覆盖：未跑真实模型/BB/部署；`lib` 消费路径的运行时行为由字节级对比与全量套件覆盖，未单独跑消费包集成 |
| 未解决缺陷 / 阻塞 | 本票合同内无未解决缺陷。计划 E 节其余审计项（`types.ts` 包内整理、`index.ts`/`orchestrate.ts`、公开面收窄、`sidecar.ts` 内部模块化）按原安排属后续真实改动，**未做也不声称**；`§5.12` 四条既有取消边界未因本票改变 |
| 最终验收结论 | R3-1/R3-2/R3-3 全部通过（内部验收 + 全量实跑 + 独立复核判 pass）；**进度审核已验收**，下一项可派第 9 项 A2+A1 |
| 下一项 | 唯一顺序第 9 项 A2+A1（Agent 状态上下文交付组）：**R3 进度审核已通过**；按计划 D/E 节和[第 9 项专项 prompt](execution-prompts/09-a2-a1-context.md) 派发；R3 本票已停止，未并行启动 |

进度审核（2026-09-24）：以 `8c59f22...8d1dce9` 为差异基线，另按 Standards/Spec 两轴只读复核；代码职责迁移与 R3-1～R3-3 均成立。审核方实跑 `pnpm build`、44 文件/1461 项单测、38 文件/268 项集成、`verify-persistence`（4 个声明根）和 `agent-singularity tsc --noEmit`，均通过。发现主 guide 两处旧类型/根契约指向及多份派发文档仍称 R3 可派，已定向修正；交付记录“25 个改动文件”按 `8ee49c6` 实际 24 个文件更正。未改运行时代码、Skill 规则、旧 R1 证据；R3 验收放行第 9 项 A2+A1，后续仍按 D/E 完整合同验收。

本票主代理的「要求 → 实际入口 → 验收」映射（实施前固定）：R3-1 内容身份不变 → `skill-contract.ts` 的 digest 函数（`sha256Hex∘canonicalize` 单点，仍 import 自 task）→ 固定向量 spec + 迁移前后实算对照；R3-1 旧 Run binding 可读 → `readRunBinding`（`run-binding.ts` 改内部导入后原断言）→ `run-binding.spec.ts`；R3-2 注册闸/自测/版本/受保护输入不变 → `verifier/src/index.ts` 注册、`selftestGate`、`stampVersion`、`protectedInputDefects`（仅类型来源变化）→ `verifier-registry.spec.ts` + `verifier-selftest-inputs.spec.ts`（真实链路含拒绝零副作用断言）；R3-3 生产无测试专用类型 → task 无导出 + 全仓 grep → `proposal.spec.ts`（自测试支持层导入后 219 项原断言通过）。拒绝路径均沿用既有套件的零意外写入/零派发/零审核副作用断言，未删任何断言或放宽任何导入。

## S1-C：Task 只提需求，Run 固定实现

状态：已完成（2026-09-22，执行与验收记录见上节；效率对比实验为票后工作）。以下为范围与验收的原始规定。

落点：`task-runtime/src/capability.ts`、`task-runtime/src/index.ts`、`agent-runtime/src/grants.ts`、`task-runtime/src/handoff.ts`、`task/src/types.ts`。DSH skill 发现/加载服务继续复用。

1. **准入前预检已交付**：多 preset 冲突在 `resolveCapabilities` 阶段拒绝；`precheckProviders` 按实际 worker 的 cwd/preset 发现路径检查已配置 skill 等资源，普通分解与 replay 共用。已知不可用配置在子任务落库前拒绝，MCP 启动失败仍在 spawn 阶段记录。其历史实施合同不再作为新票派发。
2. **类型化侧车契约**：执行型包含 capability、precondition、inputs、outputs、required tools、verifier 引用和内容身份；知识型包含来源/范围/内容身份与内容检查引用，不参与执行闭包。为 BB 两个知识 skill 和至少一个执行 skill 建最小样例。首版不做五级成熟度与成功率衰减。
3. **统一校验入口**：配置载入、provider 替换、候选晋升都使用同一校验；`evolution_apply` 不是唯一防线。没有合法执行 verifier 的执行型 skill 不能被计为有效 provider。
4. **run 摘要和记录**：worker 获取当前 run 的选定 capability/skill 摘要，正文按需读；记录 registry 修订、skill 内容摘要及 preset/MCP 身份，沿用现有快照机制扩展，不把 skill id 写入 Task 契约。

内容绑定必须可执行：沿用现有内容身份/快照，让 Run 实际加载所绑定版本；仅保存摘要后仍读可变生产路径不算完成。新版本 apply 不热替换在途 Run；旧内容不可读时明确拒绝恢复，不能静默使用新版本。支持的多文件资源需完整身份，尚不支持的资源形态显式拒绝，不宣称单文件摘要覆盖全部执行环境。

验收：不存在的 skill、未知执行 verifier、工具声明不满足、冲突 preset 均在预检拒绝；知识型可加载但不能关闭执行 GAP；替换 provider 不改 Task AC；老 run 能定位旧内容；子节点递归分解无需猜能力名；加载未选 skill 不扩大工具权限。

效率验证留在此票完成后：固定任务集与模型、环境，对比“全库自主检索”与“预选摘要+按需正文”的成功率、总 token、首个有效调用延迟、检索次数、GAP 率。不得只凭 token 降低宣布更高效，也不承诺全局 catalog 已裁剪。

## S2-E：把上报变成可追踪出口

与 A5 同组交付完整的缺口/诊断/交接记录及只读查询；本组不发布无人消费的自动执行命令。候选执行开关在 A6/S2-R/S3 整组验收后接入，届时增加真实消费、验证、人审与恢复测试。待执行交接必须明确显示 pending，不能伪装成已经派发或修复。

落点：`agent-singularity/src/review/` 承担触发、事后诊断与交接，复用现有 `escalation.ts`；工具只作适配，context 提供授权读取。task-runtime 只提交执行中实际产生的缺口/终态事实并保留基础派生，task 保存必要关联；不把 reviewer 调度、消息正文或候选策略加进 runtime。

已有：root 手动 `escalate`、三要素检查、原生 approval、批准后的 raised 台账；能力缺口/预算/坏 verifier 的文本提示。

待建：

- 自动持久化缺口事实，并按 task/run/缺口身份去重；不要求模型再次调用才能留下可观察记录。
- 正常 GAP 的轨迹/Diagnosis、已尝试方法和目标形成持久交接；A6 组消费后尝试授权内组合或生成候选。不能把交接记录、通知人类或未来工具名称当作自主处置已完成。
- 将“通知发生”与“同意处置”分开：通知只说明 what/tried/suggested，新增权限、生产修改、残余风险签收分别走授权。
- 人审请求提供候选 diff、失败原因、基线对比、正负样本、回归/holdout 结果和回滚对象；审核的交付物是已经实现并验证的改进，不是让人填写缺失实现的任务单。
- 复用现有上报/诊断/批准记录表达交接结果，关联 Task/Run 和实际缺口；拒绝或取消仍保留未解决事实，不假装修复。只有现有记录不能支持重启去重或真实消费时才补必要事件，不先新建完整缺口状态机。
- 用上游工具框架支持的错误机制返回准入拒绝；上层能区分拒绝、运行失败和人类未批准。先查 DSH 声明，不自造 `isError` 文本。

本组验收：模型不响应也能看见缺口；GAP 有持久诊断/交接身份；重启/重复触发不重复通知；例外拒绝不丢记录、不提权、不把任务标成功；未启用执行时查询明确显示 pending 且不启动候选。A6 组追加真实消费、人审与恢复的贯通验收。L4 用于自主路径不可行、预算耗尽或需外部决策的例外。现有批准后记录的行为变化必须带持久化协议记录，不能静默改变历史日志含义。

## S2-R：恢复已有图，而非重建一批任务

落点：task-runtime 负责条件重检、重新准入、Run 与批次恢复；task 仅增加这些执行迁移必需的持久合同/reducer。解决方法、候选组织与批准应用归 evolution，context 读取执行结果；不在 task 里实现查因、选方法或评估。

具体状态/接口按 F.4：显式 task_recover 为失败原目标建立新 Run/Session；新批次按 Run 记录成员和旧证据复用，不覆盖旧批次/提案/终态。blocked 原因、待满足条件与解决证据沿现有事实引用；不能把“创建或继续合适的 Run”留成实施者任选，也不能再次调用旧 decompose 批次。

本票覆盖已有能力缺口和产物缺口的恢复入口，消费明确的生产者/依赖关系与解决证据。Agent 决定复用、补产物或提出新子目标，runtime 重检后恢复；不预设固定重规划次数或为每类缺口编码修复流程。

预算与判决：复用 A3 根预算与进展计数，将恢复/候选费用归入同一根，不重置总额。tools/tokens 要么保持明确的软限额，要么接入运行中计数后再宣称硬限额。部分完成或 UNKNOWN 必须保留未满足条件与来源，不能变成 PASS；Agent 据证据决定进一步取证或提出候选，不将 UNKNOWN 直接映射为“修裁判”。现有判决和记录能表达就不升级四值枚举；确需新增判决须有当前消费者并同步 reducer、工具、UI 与持久化合同。

恢复沿用原契约；换能力版本必须建立关联的新 Run，不能改写在途实现或历史证据。成功兄弟默认不重跑，但必须检查其输入、产物与父验收引用是否仍适用；失效时保留原 verified 历史、拒绝复用并显式安排受影响部分的新尝试。不能以“兄弟绝不重跑”掩盖新版本导致的输入变化。

验收：人为移除一个 provider/参考产物，agent 按 S3 自动构造解决路径；涉及候选晋升时经人审，随后系统恢复原受阻分支；已通过兄弟不重跑；历史失败仍可追溯；重启后状态一致；连续无进展达到上限只上报一次；坏 verifier 不触发无限重试。`coverage` 统计要区分“声明覆盖”和“证据满足”。

## S3：先复用，再生长 Skill

归属：evolution 承担候选组织、实验和批准应用；候选节点使用现有工具实现方法；恢复沿 S2-R 的 task-runtime 入口。task 只保存目标及执行事实，不新增 Skill 搜索/生成器或固定补救策略。

L1 从已有授权 skill/tool 组合完成一个具体义务开始，由 agent 自主尝试。组合及其证据记录为可复用候选（KISS §7 的“入库”），不直接覆盖生产稳定 skill；通过验证及改进审核后晋升。一次性的执行编排保留在轨迹中，不能把“尚未多次复用”作为禁止 agent 提出新候选的条件。

L2 复用 `evolution_prepare` 的沙箱与 `ReplayOverlay.extraSkillRoots`。生成内容必须带执行契约和自身 verifier；通过 S1 校验、正负样本与回归，经过既有生产变更授权后才能成为 provider。L3 新工具引入仍单独过权限检查。

验收：人为制造一个 GAP，L1 用现成能力组合消解；另设 L1 无解但现有工具足够的案例，由 supervisor 自主实现 L2 候选及验证，不由人编写 skill。无 verifier 的执行型候选不能注册；验证通过后人审改进，批准即由系统晋升并经 S2 恢复原任务；拒绝则保留证据，按预算修订候选或上报。至少一个错误候选被验证闸拒绝。只有已有能力/授权/预算无法解决的路径才进入 L4，不要求所有 GAP 自动成功。

Supervisor 的范围并不永久限定于 skill：后续按细化想法4 §30 覆盖 template、context/preset、routing、Verifier、admission/runtime policy；高风险候选仍由 agent 实现和验证，人类审核晋升。当前这类自动组织尚未实现，已有 Evolution 工具链仅是可复用基础。

## S4：让复盘产生受约束的改进

落点：S4-E 将现有 `agent-singularity/src/replay.ts`、`evolution.ts` 的生命周期与评估主体迁入新 evolution 包，原工具保留薄适配；事后诊断消费链归 review，执行 Run 的 replay 仍归 task-runtime。迁移保留旧 ledger 读取、已应用对象回滚和真实消费者接线，不复制一套实现。

从实际成功/失败轨迹读取证据，Agent 提出适用条件和改进候选。当前支持的 Skill/Capability 比较成功率与成本；未来有实际 Verifier 候选时须检查漏检/变异检出，不能只看通过率。尚无消费者的模板难度归一化和全类型评分不列为本票建设要求。已实现 observed 与 holdout 各自非空且不退化的机械候选 PROMOTE/apply 闸；无 holdout 或 manual 报告不具备该资格，人审不能替代执行证据。gate 仍允许有效的负面报告进入 REJECT/研究流程。

验收：弱化 verifier 虽提高通过率仍被拒绝；只改善训练样本而退化 holdout 的候选被拒绝；拒绝有日志，晋升可回滚。自动候选执行在 S4-E 及 A5/S2-E 完成后接入 A6 交付组，不安排绕过评价合同的提前试点。

### S4-E：可比较且可追溯的评估（待执行）

这是 S4 的明确子票，前置为 S1-V 切片 2、S1-C、A3；在唯一顺序中于 A4 后派发。复用现有 replay/Evolution/ReviewRecord，不另建评估平台。交付范围与比较规则固定在 F.2：已存在的单文件 SKILL.md 替换。A6 的 capability 行与执行型 Skill 组合必须在 F.4 同组扩展评估/应用/恢复，不能冒充本票已支持。

1. 固定评价合同：任务/AC、初始输入与工作区内容身份、verifier/阈值、能力版本、模型配置、工具环境、样本划分、预算、重复次数及比较规则在候选选择前记录。外部依赖不可固定时记录不确定性，不伪称复现。
2. 基线和候选从同一初始快照在独立可写工作区运行；共用 A3 的执行/取消/提交规则。历史 champion 结果只作追溯；正式比较重新执行基线，禁止拿旧环境历史分数直接与新执行判定改进。
3. 从实际 TaskRun/Evidence 读取并验证报告来源、输入/候选身份与判据，不接受仅自洽的模型报告。已有 observed/holdout 非空且不退化闸保留；修复晋升还须满足预先声明的改进目标，两个版本同样失败不能算修复。
4. 分开失败复现、成功回归、开发验证和最终保留集。已反馈选优的 holdout 记录为开发验证，不再宣称独立最终测试；保留集结果泄露后，后续选择不得继续使用其独立性标签。真实模型重复实验报告波动和全部失败；未知费用/缺失证据保留 unknown，比较不充分则不晋升。
5. 保存成功与失败实验、候选身份和拒绝原因。任务内临时决定不自动变成共享 Skill；共享候选须说明适用条件，并在独立于原失败输入的案例上验证。允许提出新候选，但不能因一次自测成功就永久应用。

确定性验收：相同输入下基线/候选双侧真实执行，工作区互不污染；模型/输入/裁判漂移报告不可比；伪造来源拒绝；候选改善复现却退化回归拒绝；两侧同失败拒绝修复晋升；费用未知不当零；重复次数/选择规则不能看完结果再改；取消/崩溃恢复不重复提交实验结果；旧报告可读但缺新证据不可晋升。受控 provider 验证的是协议；真实模型质量实验在已有授权和明确预算下另记，缺该证据时不能声称效果改善。

## S0 本次交付与验证

本节记录首轮文档修订；后续样本改造单独记录于文末。

- 重写当前指南与本计划，历史快照保留原文；补术语表、文档入口和 BB 领域指导中的机制边界。
- 修复 worker baseline 缺少 `capability_list`，覆盖普通 worker 的真实工具过滤集成场景，并继续断言 graph/evolution/平台 HITL 不被授予。
- 本次不新增事件、不改生产配置、不重启运行中的服务；修改后需由现有部署流程加载构建产物。
- 验证结果（2026-09-21）：`pnpm build` 通过；Singularity 单测 25 文件 / 544 项通过，集成 19 文件 / 94 项通过；`verify-persistence` 的 4 个事件根指纹一致；两个 BB skill 的 `quick_validate.py` 通过。构建有现有前端 bundle 大小提示，不影响成功退出。
- 首次集成测试与构建并行，构建清理 `lib/` 时两套测试无法解析 task-runtime 包入口；构建完成后重跑全部 Singularity 集成测试通过。后续验证应先完成 build，再运行依赖 `lib/` 的测试。
- 本次未跑真实 LLM、BB 构建仿真或生产 Evolution；这些不是上述自动测试的覆盖承诺。

## 能力解析参考样本（2026-09-21）

修改前回退点：Singularity `f3842b5`，外层 harness `3d07bb0f8c`，包含上一轮文档与 worker 查询修复。

- 变更：在现有能力解析模块集中约束“一 worker 只选一个 preset”；相同值可组合，不同值在落库前明确拒绝，无声明才采用默认值。未新增服务、schema 或生产配置。
- 测试覆盖：同名能力组合、能力顺序反转、直接提供的冲突 manifest、分解整批零副作用拒绝，以及 replay 的同一拒绝规则。
- 后续构建风格见工作指南 §5.4；完整 skill 预检与版本快照仍属待建，不能据本样本标记 S1-C 完成。
- 验证（2026-09-21）：先完成 `pnpm build`，再运行全部 Singularity 单测（25 文件 / 549 项）和集成测试（19 文件 / 94 项），均通过；持久化 4 个事件根指纹一致，`git diff --check` 通过。本轮新增 5 项行为测试。未运行真实 LLM 或 BB 仿真，未重启生产服务。

## 演进验证底座与接续安排（2026-09-21）

修改前回退点：Singularity `da48925`，外层 harness `088a8d9`。

本批实现三项相连的难点：verifier 插件返回的身份/判决校验；replay 明细与总评一致性、样本身份不重用与契约变化识别；报告摘要绑定及 observed/holdout 共同约束机械晋升。工具预检减少无效人审，service 复检阻止报告在审核后被替换。没有新增调度服务，也没有宣称自动 supervisor 和恢复已实现。

以下为当时的责任拆解与历史进度，当前派发只使用文首唯一顺序；本列表不再作为独立执行路线：

1. **固定实际评估对象**（S1-C / S4）：prepare 记录候选内容摘要，replay 固定 manifest/run/evidence 身份，apply 写入同一版本；禁止先验证 A 再应用 B。补 preset 沙箱解析/执行，解除 manual replay 的当前阻塞。验收包含报告自洽但伪造来源、回放后替换候选文件两类反例。
   - 2026-09-21 P2 已完成其中“单文件 Skill 候选内容绑定”切片：prepare 摘要、replay 报告身份、服务入口复检、apply 写入同一版本均已落地并通过验收；P3 再完成“生产基线没变”切片：prepare 记录生产文件摘要、apply 人审前与实际写入前复检。“replay 固定 manifest/run/evidence 身份”与 preset 沙箱执行仍待建。
2. **补目标验证最小闭环**（S1-V）：选一个可确定性检查的父级目标，增加独立组合判据；依赖引用区分原始输入与要求已验证的产物。verifier 正负样本实际执行，固定判据来源；相同失败不能仅凭不退化被视作修复。模板改判据应交由独立固定基准比较，不能只改变 command 后继续比较通过率。
   - 2026-09-21 P4 已完成其中“父级验收最小机械版”与“证据依赖有效性”两个切片：父 AC `childEvidence` 映射 + 独立组合检查（映射断言与父级 command）+ `heuristic` 显式标注；`requiresArtifact` 收紧为 verified 参考产物、`acceptsArtifact` 表达原始输入。“verifier 正负样本实际执行，固定判据来源”（切片 2）仍待建。
3. **联合实现自动补路径与恢复**（S2-E / S2-R / S3）：定义 gap/obligation 身份及解决事件，supervisor 消费一次诊断、实现候选、调用已有评估工具；人审改进后系统应用并重新准入受阻分支。先交付一个 L1 和一个 L2 案例，覆盖拒绝、重启去重和预算停止。不得以人工编写 skill 的演示代替验收。
4. **扩大改进目标**（S4）：以完整轨迹驱动 Retro，增加成功率/成本、verifier 漏检/变异检出、模板难度归一化指标。当前非退化闸不能作为全面自动接受的完成证据；更广的运行时/裁判修改仍由 supervisor 实现验证、人审核。

现有 decide/apply 各有一次人审，本批保持该行为。后续可将批准绑定到候选摘要与报告摘要，使同一已批准版本自动 apply/resume；权限扩大或内容变化需要新的决策，不能把审批次数减少实现为绕过对象身份校验。

验证：`pnpm build` 通过；全部 Singularity 单测 25 文件 / 570 项、集成 19 文件 / 94 项通过；`verify-persistence` 的 4 个事件根指纹一致，`git diff --check` 通过。新增 21 项测试覆盖坏 verifier、伪造比较、缺失/退化 holdout、manual 晋升拒绝、人审前预检、报告替换及旧 ledger 回滚。集成 replay 使用运行时 stub，未运行真实 LLM、BB 仿真或生产晋升，未重启服务。

额外类型检查：verifier 的 `tsc --noEmit` 通过；agent-singularity 在 `da48925` 基线有 12 处错误（SessionId 调用、DiagnosisProposal 与 mutation 收窄）。以 TypeScript compiler host 读取 `da48925` 的原始 src 对照，基线同样有这 12 处错误，本批未新增。当时该包 `pnpm build` 只有 tsdown，不代表严格类型检查通过；此当前态已由 2026-09-21 的 P1 修正，见上文 P1 节（该包 build 现为 `tsc --noEmit && tsdown`，类型检查零错误）。
