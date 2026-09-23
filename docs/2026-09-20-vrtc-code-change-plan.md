# VRTC-KISS 建设计划

更新：2026-09-23。保留原文件名作为稳定入口；原临时计划在 [历史快照](history/2026-09-21-vrtc-plan-snapshot.md)。
方向与实现事实以 [工作指南](singularity-harness-guide.md)为准；本文仅描述建设顺序、代码落点与可验收结果。
基线备份：Singularity `b00915c`，外层 harness `6c5eb49894`。

## 当前排期

### 唯一派发顺序与完成闸

本次补救修订基线：代码 `fda3d29`；文档备份 Singularity `1430103`、外层 `31bcf3a`。以下表格是唯一派发顺序，替代旧的 A0 完成即直接派发 A2 的安排。不新增另一份路线图或临时产品版本；已完成记录保留，新补救任务均待实施。

本次仅修订 8 份指导/派发文档，52 个本地链接、代码围栏及 diff 检查通过；未改运行时代码，未运行构建、代码测试或真实模型。历史 1544 项测试记录不作为本次重新验证结果。

后续进度审核使用[进度审核指挥 prompt](execution-prompts/progress-review-and-dispatch.md)，单票内容按[派发模板](execution-prompts/task-dispatch-template.md)填写。本表是当前顺序；下文带日期的交付记录中“下一项”、提交和测试数只描述当时，不覆盖本表。本次文档维护不改变任何代码票的验收状态。

下表同时作为可填写的任务流程表，保持一套顺序。`待填` 不表示已验收；负责人栏可填 agent 名称或任务链接。交付记录栏填写本文件内的验收记录锚点，提交、日期和阻塞详情放入下方单项模板，避免表格过宽。

| 次序 | 一次派发的范围 | 状态 | 负责人/任务 | 交付记录 | 进入下一项的条件 |
|---|---|---|---|---|---|
| 1 | T1：统一规范化契约 | 已验收（2026-09-21，独立子代理复核） | Kimi Code 主代理（4 实现/测试子代理 + 1 只读复核子代理 + 1 复核修复子代理） | 见「T1：统一规范化契约 执行与验收记录」 | 契约规范化、持久化与普通分解/replay 一致性全部验收 |
| 2 | S1-V 切片 2：验证器自测与输入身份 | 已验收（2026-09-22，独立子代理复核） | Kimi Code 主代理（2 实现子代理 + 1 集成子代理 + 1 渲染跟进子代理 + 1 只读复核子代理 + 1 复核修复子代理） | 见「S1-V 切片 2：验证器自测与输入身份 执行与验收记录」 | 正负样本执行、裁判版本与受保护输入校验完整；P4 组合验收回归通过（本轮复跑 26 项；全量集成 22 文件 / 145 项） |
| 3 | S1-C：能力预检与版本绑定 | 已验收（2026-09-22，独立子代理复核） | Kimi Code 主代理（5 实现子代理 + 1 独立复核子代理 + 1 复核修复子代理） | 见「S1-C：能力预检与版本绑定 执行与验收记录」 | provider 预检、侧车契约、Run 绑定内容与旧版本读取完整；所有实际支持入口共用校验 |
| 4 | A3：非阻塞运行与恢复 | 已验收（2026-09-22，独立子代理复核 + 复核修复回归） | Kimi Code 主代理（5 阶段实现/测试子代理 + 1 独立复核子代理 + 1 复核修复子代理） | 见「A3：非阻塞运行与恢复 执行与验收记录」 | 非阻塞推进、工作区写入归属、显式提交、取消/恢复、根预算与普通/replay 一致性完整 |
| 5 | T2 + T3：契约审核与恢复（一个交付组） | 已验收（2026-09-23，双模型并行独立复核 + 综合复核确认） | Kimi Code 主代理指挥 + 4 阶段实现子代理（A 提案合同层 / B task-runtime 生命周期、重检、幂等与恢复 / C 工具面、审批渠道与 prompt / D 集成级验收、模型协议 fixture 与文档收尾）+ 2 并行独立复核子代理 + 1 综合复核子代理 | 见「T2+T3：契约审核与恢复 执行与验收记录」 | off/all、审核持久化、批准后重检及崩溃恢复一起验收，不单独交付不可恢复的 all |
| 6 | A0 + R0：根入口与默认运行面（一个交付组） | 待派发 | 待填 | 待填 | 根目标来源、独立 AC、off/all 与激活恢复完整；默认工具/prompt 按角色收敛；见下方补救合同 |
| 7 | R1：真实运行验证 | 待前置 | 待填 | 待填 | 同一实现的真实模型任务经新入口满足根验收，错误根结果不误过；运行证据和阻塞处置完整 |
| 8 | R2：按证据整理运行时 | 待前置 | 待填 | 待填 | 关闭已发现的一致性缺陷、收敛重复职责及无用途接口，核对 marker 边界；不预定驱动重写 |
| 9 | A2：任务导航与合法动作 | 待复定 | 待填 | 待填 | 按 R1/R2 记录收紧具体读取场景；授权、合法动作与有界结果完整，分页仅在有实际需求时建设 |
| 10 | A1：全局上下文投影 | 待复定 | 待填 | 待填 | 复用 A2 读取域，根目标/贡献/必要证据有来源，恢复与压缩不丢核心事实；不照搬字段全集 |
| 11 | A4：父子澄清 | 待复定 | 待填 | 待填 | 父子与三层问答、消息故障恢复、写闸及多阻塞处置完整 |
| 12 | S4-E：评估基础（S4 内的子票） | 待复定 | 待填 | 待填 | 先服务一种候选对象：可比实验、真实证据、冻结评价与回归闸；不建全对象评估平台 |
| 13 | A5 + S2-E：诊断与缺口交接（一个交付组） | 待复定 | 待填 | 待填 | 一个真实失败场景的事件触发、因果诊断与候选交接完整；自动候选执行尚不启用 |
| 14 | A6 + S2-R + S3：自主改进与恢复（一个交付组） | 待复定 | 待填 | 待填 | 一类实际需要的候选贯通自主组合/实现、独立评估、人审应用、原分支恢复与回滚 |

状态填写：`待前置 → 待派发 → 进行中 → 待验收 → 已验收`；有未解决缺陷填 `返工`，因外部条件无法继续填 `阻塞` 并记录原因。实现者宣称完成仅进入待验收；“已验收”需要下述完成闸证据。依赖票的状态不能因内部部分提交而提前推进。每次更新本表，同时更新本文对应票据状态及主 guide，记录冲突时先核实证据。

`待复定` 表示方向保留、详细实现合同尚不派发。到达该行前，依据前项实际运行记录删去没有消费者的字段/通用化，写明场景、接口和验收，再转为待派发；不能跳行先建设，也不能由执行者削弱已接受的正确性合同。复定就在本表及对应专项合同内进行，不追加竞争排期。

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

派发入口：[执行 prompt 与公共合同](execution-prompts/README.md)。P1–P4 与 T1 已完成，S1-V 切片 2、S1-C、A3、T2/T3 的验收记录见下文。下一项是第 6 项 A0 + R0；使用[架构补救指挥 prompt](execution-prompts/05-architecture-remediation.md)连续处理第 6–8 项。Task 主线见 [Task 自主构造建设指导](task-contract-construction-guide.md)，协作主线见 [探索与自进化架构](exploration-evolution-architecture.md)与 [Prompt 合同](agent-prompt-contracts.md)。

### 补救范围与验收合同（R0–R2，均未实现）

**A0 + R0：先使真实目标可执行，并收敛默认运行面。** A0 按[根入口合同](2026-09-23-a0-root-intake-design.md)交付，根验收必须针对用户交付物，不以任意非 composite 命令充数。R0 沿用现有 preset/scoped tools/配置装配：默认 root 不暴露 `evolution_*`，不注入未启用进化协议；显式启用的既有进化路径继续保留真实校验、人审、历史读取与回滚。记录关闭/开启两种实际 composition、工具集及入口；关闭时模型工具与自动触发均不可进入进化，保留人工管理接口须写明授权边界。BB 专用规则移至领域配置，未知角色/配置不得扩大权限。root 仅保留角色原则，具体状态由工具结果说明；语义建议不必全部写成机器闸，权限/状态保证必须有代码支撑。不新建角色平台，不新增自主候选执行器。验收包括实际 assembled prompt/工具集、服务授权边界、正常任务与显式开启进化的既有回归；prompt 字数仅作观测。A0 与 R0 可分内部提交，整组通过才进入 R1。

**R1：直接运行同一实现。** 复用现有 DSH 部署/测试入口及临时仓库，禁止另建 demo runtime 或依赖 S4-E 平台。先固定三个场景：明确的小型工程交付；子判据通过而根交付错误；目标存在会影响验收的歧义。第一项须用真实模型从用户输入经新 intake、分解、执行到独立根验收通过；错误根结果由真实 verifier 拒绝（可确定性注入错误产物）；歧义场景观察模型是否澄清/保留未知，不能假称结构校验能证明语义。off/all 与恢复仍由 A0 的真实模块确定性测试覆盖，不要求收费模型穷举。

运行前记录模型/配置、输入、独立验收、环境、次数及预算；之后记录实际 Task/Run/Evidence/Session 引用、成本、失败轨迹与最终产物。不得只挑成功样例、在看到结果后改判据、以 scripted provider 冒充真实模型。明确交付未通过、错误根被放过或歧义被擅自定为用户要求时，该项返工；修复已有路径后重验，不偷偷实施整个 A1/A4。若确需待建能力，先在本表复定依赖再执行。凭据/运行条件缺失时记录阻塞，不进入 R2 或后续功能。一次通过证明该场景可运行，不证明成功率提升或自进化完成。

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

T1 已交付统一契约、身份与准入记录；S1 验证与能力合同（S1-V 切片 2、S1-C）与 A3 已交付；T2/T3 已验收（2026-09-23）。后续按唯一派发顺序补齐根契约入口（A0）与上下文/问答。S2/S3 消费已验收的运行、评估与诊断接口，不能提前用人工补能力替代。T3 的审核交接恢复不等于 S2-R 的能力/产物缺口恢复。

本组文档规划基线：Singularity `7be57a1`，外层 `9f818152bb`；工作区相关修改已在这些提交中保存。本次仅修改文档，P1–P4 的测试结果沿用各自历史记录，不将其算作 T1–T3 验收。

### 全局上下文、协作与 Supervisor 接续票

原设计基线：Singularity `9900959`、外层 `51b6e2f`；DSH `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`。A3 已交付，其他 A 票状态如下；未来具体字段按文首复定规则收敛，不以本文旧的详细设计越过 R1/R2。开源参考见 [一手来源调研](2026-09-21-open-source-agent-patterns.md)。

| 票据 | 状态 | 前置 | 单票完成边界 |
|---|---|---|---|
| A0 真实根契约入口 | 待派发，与 R0 同组 | T1、S1-V 切片 2、T2/T3 组 | 根来源/语义边界、独立 AC、审核与幂等激活恢复完整，旧图不改历史 |
| A1 全局上下文投影 | 待复定 | A0/A2、S1-C；R1/R2 证据 | 根目标、贡献、必要证据及来源的授权投影；压缩不丢契约，不预建字段全集 |
| A2 Task 导航与合法动作 | 待复定 | A0/A3、S1-C；R1/R2 证据 | 实际需要的授权任务切片、owner/阻塞/合法动作；分页按需要建设，不能看见即领取 |
| A3 非阻塞批次与协调相位 | 已完成（2026-09-22，见「A3 执行与验收记录」） | T1、S1-V 切片 2、S1-C | 统一迁移与串行推进、工作区写入归属、显式提交、根预算、取消/恢复及 replay 一致性 |
| A4 父子澄清 | 待复定 | A1/A2/A3 | 问题身份与父子授权、持久投递；逐级问答保留批次与写闸；claim 后故障可恢复；未知/部分回答不解除全部阻塞 |
| A5 因果诊断与主管触发 | 待复定，与 S2-E 同组 | A1/A2/A4、S4-E | 从一个真实失败场景贯通依赖/证据下钻、去重/预算、候选交接；不提前执行候选 |
| A6 自主修复与恢复 | 待复定，与 S2-R/S3 同组 | A5/S2-E 组及 S4-E | 一类有需求的候选实现、验证、人审、应用/恢复与回滚；无人工补 Skill、坏候选被拒 |

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

接口交接（给 S1-C 与后续票）：`VerifierSelftestSample`/`VerifierSelftestStore`/`VerifierSelftest`、`ProtectedInputRef`、`sha256Hex` 从 `@dangosys/dsh-singularity-task` 导出；`VerifierRegistry.register(verifier, { testDouble? })` 为 async，`ready()` 幂等且 `[Service.init]` 调用；`evidenceByVerifier(storeId, ref, version?)` 只做索引；`task-runtime/src/protected-inputs.ts` 的 `fixProtectedInputs`/`fixCriteriaProtectedInputs`/`fixSpecProtectedInputs`/`protectedInputDefects` 与 `verifier/src/protected-inputs.ts` 的 `protectedInputDefects` 可复用；`protectedInputs` 的固定形态（`{ path, sha256 }`）是持久化词汇，字符串形态只属于准入输入。

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

落点：`agent-singularity/src/escalation.ts`、`agent-singularity/src/tools/escalate.ts`、`task-runtime/src/orchestrate.ts`、`task-runtime/src/index.ts`、工具错误返回适配。

已有：root 手动 `escalate`、三要素检查、原生 approval、批准后的 raised 台账；能力缺口/预算/坏 verifier 的文本提示。

待建：

- 自动持久化缺口事实，并按 task/run/缺口身份去重；不要求模型再次调用才能留下可观察记录。
- 正常 GAP 的轨迹/Diagnosis、已尝试方法和目标形成持久交接；A6 组消费后尝试授权内组合或生成候选。不能把交接记录、通知人类或未来工具名称当作自主处置已完成。
- 将“通知发生”与“同意处置”分开：通知只说明 what/tried/suggested，新增权限、生产修改、残余风险签收分别走授权。
- 人审请求提供候选 diff、失败原因、基线对比、正负样本、回归/holdout 结果和回滚对象；审核的交付物是已经实现并验证的改进，不是让人填写缺失实现的任务单。
- 定义 raised → 等待/已决策/已解决的最小事件合同，关联 Task/Obligation；拒绝或取消仍保留缺口状态，不假装修复。
- 用上游工具框架支持的错误机制返回准入拒绝；上层能区分拒绝、运行失败和人类未批准。先查 DSH 声明，不自造 `isError` 文本。

本组验收：模型不响应也能看见缺口；GAP 有持久诊断/交接身份；重启/重复触发不重复通知；例外拒绝不丢记录、不提权、不把任务标成功；未启用执行时查询明确显示 pending 且不启动候选。A6 组追加真实消费、人审与恢复的贯通验收。L4 用于自主路径不可行、预算耗尽或需外部决策的例外。现有批准后记录的行为变化必须带持久化协议记录，不能静默改变历史日志含义。

## S2-R：恢复已有图，而非重建一批任务

落点：`task/src/service/state.ts`、`task/src/index.ts`、`task-runtime/src/index.ts`、`task-runtime/src/orchestrate.ts`、`task-runtime/src/obligation.ts`。

先写状态与事件合同再编码：blocked 原因、待满足条件、解决证据、重新准入、恢复尝试。契约保持原样；条件重检后创建或继续合适的 Run，不能改已有证据和终态。父任务“只分解一次”的现有约束意味着恢复必须有独立入口，不能再次调用原 decompose 批次。

本票同时消解两类停滞：能力补齐和产物补齐。优先支持显式绑定的生产者/依赖关系与父级一次重规划，不先做全局义务调度器。

预算与判决：复用 A3 根预算与进展计数，将恢复/候选费用归入同一根，不重置总额。tools/tokens 要么保持明确的软限额，要么接入运行中计数后再宣称硬限额。定义 PARTIAL/UNKNOWN 的任务级处置；UNKNOWN(verifier) 修裁判，UNKNOWN(task) 补取证，均不变成 PASS。四值升级需同步 reducer、工具、UI 和持久化 schema。

恢复沿用原契约；换能力版本必须建立关联的新 Run，不能改写在途实现或历史证据。成功兄弟默认不重跑，但必须检查其输入、产物与父验收引用是否仍适用；失效时保留原 verified 历史、拒绝复用并显式安排受影响部分的新尝试。不能以“兄弟绝不重跑”掩盖新版本导致的输入变化。

验收：人为移除一个 provider/参考产物，agent 按 S3 自动构造解决路径；涉及候选晋升时经人审，随后系统恢复原受阻分支；已通过兄弟不重跑；历史失败仍可追溯；重启后状态一致；连续无进展达到上限只上报一次；坏 verifier 不触发无限重试。`coverage` 统计要区分“声明覆盖”和“证据满足”。

## S3：先复用，再生长 Skill

L1 从已有授权 skill/tool 组合完成一个具体义务开始，由 agent 自主尝试。组合及其证据记录为可复用候选（KISS §7 的“入库”），不直接覆盖生产稳定 skill；通过验证及改进审核后晋升。一次性的执行编排保留在轨迹中，不能把“尚未多次复用”作为禁止 agent 提出新候选的条件。

L2 复用 `evolution_prepare` 的沙箱与 `ReplayOverlay.extraSkillRoots`。生成内容必须带执行契约和自身 verifier；通过 S1 校验、正负样本与回归，经过既有生产变更授权后才能成为 provider。L3 新工具引入仍单独过权限检查。

验收：人为制造一个 GAP，L1 用现成能力组合消解；另设 L1 无解但现有工具足够的案例，由 supervisor 自主实现 L2 候选及验证，不由人编写 skill。无 verifier 的执行型候选不能注册；验证通过后人审改进，批准即由系统晋升并经 S2 恢复原任务；拒绝则保留证据，按预算修订候选或上报。至少一个错误候选被验证闸拒绝。只有已有能力/授权/预算无法解决的路径才进入 L4，不要求所有 GAP 自动成功。

Supervisor 的范围并不永久限定于 skill：后续按细化想法4 §30 覆盖 template、context/preset、routing、Verifier、admission/runtime policy；高风险候选仍由 agent 实现和验证，人类审核晋升。当前这类自动组织尚未实现，已有 Evolution 工具链仅是可复用基础。

## S4：让复盘产生受约束的改进

落点：`agent-singularity/src/replay.ts`、`agent-singularity/src/evolution.ts`、`agent-singularity/src/tools/evolution-replay.ts`、现有 ReviewRecord/Diagnosis 消费链。

输入完整成功/失败轨迹，输出问题模式、适用条件和改进候选。Skill/Capability 比成功率与成本；Verifier 比漏检/变异检出，禁止只看通过率；Task 模板做难度归一化。已实现 observed 与 holdout 各自非空且不退化的机械候选 PROMOTE/apply 闸；无 holdout 或 manual 报告不具备该资格，人审不能替代执行证据。gate 仍允许有效的负面报告进入 REJECT/研究流程。

验收：弱化 verifier 虽提高通过率仍被拒绝；只改善训练样本而退化 holdout 的候选被拒绝；拒绝有日志，晋升可回滚。自动候选执行在 S4-E 及 A5/S2-E 完成后接入 A6 交付组，不安排绕过评价合同的提前试点。

### S4-E：可比较且可追溯的评估（待执行）

这是 S4 的明确子票，前置为 S1-V 切片 2、S1-C、A3；在唯一顺序中于 A4 后派发。复用现有 replay/Evolution/ReviewRecord，不另建评估平台。交付范围是当前有真实执行器的候选类型；无执行器类型仍拒绝晋升，后续类型需要自己的完整合同。

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
