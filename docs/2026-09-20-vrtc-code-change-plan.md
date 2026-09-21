# VRTC-KISS 建设计划

更新：2026-09-21。保留原文件名作为稳定入口；原临时计划在 [历史快照](history/2026-09-21-vrtc-plan-snapshot.md)。
方向与实现事实以 [工作指南](singularity-harness-guide.md)为准；本文仅描述建设顺序、代码落点与可验收结果。
基线备份：Singularity `b00915c`，外层 harness `6c5eb49894`。

## 当前排期

### 唯一派发顺序与完成闸

本次顺序修订基线：Singularity `5a4f3b9`，外层 `dbca57cca7`；修改前两个仓库的相关内容均已提交。以下顺序取代本文件旧段落中的并行/提前试点建议，不新增另一份路线图，不安排提前运行的临时产品版本。所有新增要求均待实现。

下表同时作为可填写的任务流程表，保持一套顺序。`待填` 不表示已验收；负责人栏可填 agent 名称或任务链接。交付记录栏填写本文件内的验收记录锚点，提交、日期和阻塞详情放入下方单项模板，避免表格过宽。

| 次序 | 一次派发的范围 | 状态 | 负责人/任务 | 交付记录 | 进入下一项的条件 |
|---|---|---|---|---|---|
| 1 | T1：统一规范化契约 | 已验收（2026-09-21，独立子代理复核） | Kimi Code 主代理（4 实现/测试子代理 + 1 只读复核子代理 + 1 复核修复子代理） | 见「T1：统一规范化契约 执行与验收记录」 | 契约规范化、持久化与普通分解/replay 一致性全部验收 |
| 2 | S1-V 切片 2：验证器自测与输入身份 | 待派发（下一项） | 待填 | 待填 | 正负样本执行、裁判版本与受保护输入校验完整；P4 组合验收回归通过（本轮已复跑 26 项） |
| 3 | S1-C：能力预检与版本绑定 | 待前置 | 待填 | 待填 | provider 预检、侧车契约、Run 绑定内容与旧版本读取完整；所有实际支持入口共用校验 |
| 4 | A3：非阻塞运行与恢复 | 待前置 | 待填 | 待填 | 非阻塞推进、工作区写入归属、显式提交、取消/恢复、根预算与普通/replay 一致性完整 |
| 5 | T2 + T3：契约审核与恢复（一个交付组） | 待前置 | 待填 | 待填 | off/all、审核持久化、批准后重检及崩溃恢复一起验收，不单独交付不可恢复的 all |
| 6 | A0：真实根契约入口 | 待前置 | 待填 | 待填 | 根 intake 复用已完成审核/恢复协议；真实目标、独立 AC 与幂等激活完整 |
| 7 | A2：任务导航与合法动作 | 待前置 | 待填 | 待填 | 授权任务查询、合法动作、版本分页完整，覆盖 A0 未激活与 A3 等待状态 |
| 8 | A1：全局上下文投影 | 待前置 | 待填 | 待填 | 复用 A2 读取域，根目标/契约/决定/证据投影完整，恢复与压缩不丢核心事实 |
| 9 | A4：父子澄清 | 待前置 | 待填 | 待填 | 父子与三层问答、消息故障恢复、写闸及多阻塞处置完整 |
| 10 | S4-E：评估基础（S4 内的子票） | 待前置 | 待填 | 待填 | 可比实验、真实 run/evidence 来源、冻结评价合同、回归与候选版本闸全部通过 |
| 11 | A5 + S2-E：诊断与缺口交接（一个交付组） | 待前置 | 待填 | 待填 | 事件触发、因果诊断、缺口出口与候选交接记录完整；自动候选执行尚不启用 |
| 12 | A6 + S2-R + S3：自主改进与恢复（一个交付组） | 待前置 | 待填 | 待填 | 自主组合/候选实现、独立评估、人审应用、原分支恢复及回滚共同验收 |

状态填写：`待前置 → 待派发 → 进行中 → 待验收 → 已验收`；有未解决缺陷填 `返工`，因外部条件无法继续填 `阻塞` 并记录原因。实现者宣称完成仅进入待验收；“已验收”需要下述完成闸证据。依赖票的状态不能因内部部分提交而提前推进。每次更新本表，同时更新本文对应票据状态及主 guide，记录冲突时先核实证据。

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

每项开始先检查前一项完成记录以及自己消费的接口/测试证据。未完成、部分完成、仅 fixture 通过但真实模块未接线，均不得满足前置。发现前置缺陷，先在该前置范围修复并重验，再继续；不通过新建“后续补齐”条目消除阻塞。交付组可分内部提交，但只有整组验收后才更新完成状态并派发下一项。除表中三个交付组外仍一次只派发一票。

S1-V 切片 2 不冒充 C3 自然语言完整证明；S4-E 不冒充所有改进对象的执行器。明确不支持的扩展与已支持路径的缺陷要分开记录。真实模型效果实验使用已完成模块和冻结评估入口，记录授权、预算及效果结果；确定性协议测试不能替代效果证据，实验也不能豁免本表完成闸。

先期确定性任务的派发入口：[执行 prompt 与公共合同](execution-prompts/README.md)。P1–P4 已完成，T1 见下方 T1 节；下一项按文首唯一顺序为 S1-V 切片 2。Task 主线合同见 [Task 自主构造建设指导](task-contract-construction-guide.md)，上下文/协作/主管主线见 [探索与自进化架构](exploration-evolution-architecture.md)及 [Prompt 合同](agent-prompt-contracts.md)。统一依赖顺序如下；每项完成必须同步本计划及主 guide，不能只更新测试或执行日志。

| 任务 | 当前状态 | 前置 | 完成边界 |
|---|---|---|---|
| [P1 类型闸](execution-prompts/01-root-agent-typecheck.md) | 已完成（2026-09-21，见 P1 节） | 已满足 | root-agent 严格类型检查零错误，build 实际执行类型检查 |
| [P2 Skill 内容绑定](execution-prompts/02-skill-content-binding.md) | 已完成（2026-09-21，见 P2 节） | P1 验收通过：`agent-singularity` build 为 `tsc --noEmit && tsdown`，类型错误即失败 | 单文件 Skill prepare/replay/审核/apply 内容身份一致；旧记录读取与回滚保留 |
| [P3 生产基线检查](execution-prompts/03-skill-champion-check.md) | 已完成（2026-09-21，见 P3 节） | P2 验收通过：候选内容身份字段、兼容规则与读取/检查入口见 P2 节交接，P3 必须复用该身份语义，不另建摘要体系 | 串行 apply 拒绝过期 Skill 候选，不覆盖变化的生产文件 |
| [P4 独立父验收与证据身份](execution-prompts/04-parent-acceptance-evidence-identity.md) | 原交付有遗漏；本轮三个组合漏洞已修复并回归，见 P4 修复节 | P3 已满足；历史 f6886cf 的全绿记录不能替代本轮反例 | 普通/replay 同检输入；父映射拒绝 heuristic 子判据；插件不能跳过映射；原 P4 合同回归通过 |

T1 不在本表（确定性 prompt 切片）中：它是 Task 自主构造接续组的第一票，执行与验收记录见下方 T1 节。

P1–P4 是构建基础与 S1-V/S1-C/S4 的有限工程切片。P2 不证明证据来源真实，P3 不承诺跨进程原子更新；完成后不将整张 S 票标为完成。

### Task 自主构造接续票（设计已明确，代码待建）

节点已能生成任务实例；本组补统一语言与治理，不能描述为从零新增动态分解。模板是可选参考，模板未命中不阻止生成。Task 生成审核与 Evolution 晋升审核分开，默认 off 的目标策略不改变现有生产能力/权限审批。

| 票据 | 状态 | 前置 | 范围与验收入口 |
|---|---|---|---|
| T1 统一规范化契约 | 已完成（2026-09-21，见 T1 执行与验收记录） | P4 已满足 | Task 字段语义/摘要/持久化、分解与 replay 共用结构校验、handoff 一致；详细指导 §4、§8 T1-A–F |
| T2 可选契约人审 | 待执行，与 T3 同组 | T1/A3 | off/all、不可变提案、摘要绑定、批准后重检；组内先完成契约规则，不单独宣称产品完成 |
| T3 审核恢复与幂等派发 | 待执行，与 T2 同组 | T1/A3；组内复用 T2 | 四个崩溃点恢复、requestKey 去重、单父分解竞争、节点修订；整组完成才开放 all |

T1 已交付统一契约、身份与准入记录；T2/T3 后按唯一派发顺序补齐 S1 验证与能力合同。S2/S3 消费已验收的运行、评估与诊断接口，不能提前用人工补能力替代。T3 的审核交接恢复不等于 S2-R 的能力/产物缺口恢复。

本组文档规划基线：Singularity `7be57a1`，外层 `9f818152bb`；工作区相关修改已在这些提交中保存。本次仅修改文档，P1–P4 的测试结果沿用各自历史记录，不将其算作 T1–T3 验收。

### 全局上下文、协作与 Supervisor 接续票

2026-09-21 设计基线：Singularity `9900959`、外层 `51b6e2f`；DSH `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`。下表均为待建；详细字段/状态/故障合同以深入架构对应章节为准，开源参考见 [一手来源调研](2026-09-21-open-source-agent-patterns.md)。

| 票据 | 状态 | 前置 | 单票完成边界 |
|---|---|---|---|
| A0 真实根契约入口 | 待执行 | T1、S1-V 切片 2、T2/T3 组 | setup/graph 与业务根 Task 激活分离，真实目标与独立顶层 AC，审核/恢复完整，旧图不改历史 |
| A1 全局上下文投影 | 待执行 | A0/A2、S1-C | root brief、贡献、决定/证据、来源版本和授权读取；压缩不丢契约 |
| A2 Task 导航与合法动作 | 待执行 | A0/A3、S1-C | 可见域与结构化任务切片、revision/分页、owner/阻塞/allowedActions，不能看见即领取 |
| A3 非阻塞批次与协调相位 | 待执行 | T1、S1-V 切片 2、S1-C | 统一迁移与串行推进、工作区写入归属、显式提交、根预算、取消/恢复及 replay 一致性 |
| A4 父子澄清 | 待执行 | A1/A2/A3 | 问题身份与父子授权、持久投递；逐级问答保留批次与写闸；入箱/消费/处理分离，claim 后故障可恢复；未知回答及部分回答不解除全部阻塞 |
| A5 因果诊断与主管触发 | 待执行，与 S2-E 同组 | A1/A2/A4、S4-E | 真实依赖/证据下钻、可验证引用、事件去重/预算、持久候选交接；不提前执行候选 |
| A6 自主修复与恢复 | 待执行，与 S2-R/S3 同组 | A5/S2-E 组及 S4-E | agent 实现验证候选、人审、应用/恢复、版本重检与回滚；无人工补 Skill、坏候选被拒 |

按本节开头唯一派发顺序执行。A0 使用已完成的 T2/T3，默认 off 仍是用户可选策略，不作为跳过审核协议建设的理由。S4-E 在自动主管和候选链之前完成；各表的前置表达接口依赖，不构成另一套并行派发顺序。

每票同步其角色 Prompt 与实际工具面，使用真实 DSH loop + scripted provider 验证协调协议；真实模型质量实验另记。A3 先提交状态/事件矩阵与循环等待反例，再实现，不新建 workflow 引擎；A4 不直接假定当前 spawn 可用 DSH continuable send_message；A5 不用 UI 拓扑/时间先后替代证据因果。

本轮交付只有设计/来源/Prompt 文档与排期，未新增运行时代码、配置、事件或部署。文档链接、结构与 diff 检查不代表上述票据已通过运行测试。

本轮备份仍为 `9900959` / `51b6e2f`；收尾时工作区已接续他处提交的 P4 终审文档更新，当前 HEAD 为 Singularity `f6886cf` / 外层 `cf6a4d6314`，这些更新已保留。对本轮 8 份文档的 42 个本地链接及代码围栏检查通过，`git diff --check` 通过；未运行构建、运行时测试或真实模型实验。研究子代理已完成一手来源调研与协议复核，复核后的合同仍须在 A3/A4 用实际运行测试验收。

| 票据 | 状态（2026-09-21） | 依赖 | 交付范围 |
|---|---|---|---|
| S0 | 已完成，验证结果见文末 | 无 | 文档去漂移、术语统一、worker 能力查询 |
| S1-V | 部分：verifier 返回边界校验已建；父级证据映射、独立父级组合检查与证据身份收紧已落地（P4，切片 1+3）；verifier selftest 执行与输入身份（切片 2）待建 | S0 | 可信验收、父级组合检查、有效产物引用 |
| S1-C | 部分：多 preset 冲突已在解析期拒绝；单文件 Skill 候选的晋升链路内容身份已绑定（P2），生产基线已在 apply 前复检（P3） | S0 | provider 预检、skill 分类契约、run 解析快照 |
| S2-E | 部分：已有手动 L4 工具与 raised 台账 | 与 A5 同组，前置见唯一顺序 | 缺口记录、诊断与候选交接、例外上报、结构化拒绝；候选执行由 A6 组接入 |
| S2-R | 待建；已有 blocked/obligation 记录 | A5/S2-E、S4-E；与 A6/S3 同组 | agent 补齐后的系统恢复、版本/证据重检、预算与判决处置 |
| S3 | 待建 | A5/S2-E、S4-E；与 A6/S2-R 同组 | L1 组合与 L2 生成，验证、人审应用、恢复一起交付 |
| S4 | 部分：报告自洽、摘要与最低晋升闸已有；P2/P3 已完成 | S4-E 按唯一顺序先于 A5；其他对象另定完整执行合同 | 可比评估、真实证据、结构化 Retro、按对象评价；不以现有闸宣称完整进化 |

旧计划的阶段 1.1/1.2（assumptions/requiresArtifact）、1.4（verifierRef）、3.3（义务记录）已有代码；不重复建设。
阶段 1.3 预算、2.1 四值判决、2.2 verifier selftest 只有部分完成。阶段 3.1 L4 已有工具，但无自动与恢复闭环。
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

## S1-V：先保证验的是目标

落点：`task/src/types.ts`、`verifier/src/index.ts`、`verifier/src/composite-verifier.ts`、`task-runtime/src/admission.ts`、`task-runtime/src/orchestrate.ts`。

分成三个可独立验收的切片：

1. **父级验收**（2026-09-21 P4 已完成最小机械版）：父 AC → 子证据映射（`childEvidence`，按 batch 位置 + 判据/证据引用，验收期对照 store 校验存在性与 verified 来源）与至少一个独立父级组合检查（映射断言 + 父级 command）已落地；默认 composite 的“子全 verified”仍只作汇总。剩余：C3 假设满足性完整证明、自然语言条款只作显式标注的启发式（`heuristic`）。
2. **验证器自测与输入身份**（待建）：将当前 selftest 描述落为可执行正负样本；注册/晋升时执行。记录 verifier 版本，固定测试与阈值来源，明确 worker 可写产物与受保护验收输入的边界。
3. **证据依赖有效性**（2026-09-21 P4 已完成）：`requiresArtifact` 收敛为已验证参考产物（verified run + pass 判据），原始输入用 `acceptsArtifact` 独立表达；失败/过期 run 的同名产物不再满足依赖。剩余：产物来源、版本/摘要与适用性的进一步绑定。

验收：子任务都通过但组合接口错误，父必须拒绝；删掉父 AC 的证据映射必须拒绝；负样本可检出；修改验收脚本不能把错误产物变成 PASS；同名过期/失败证据不能满足要求已验证参考的依赖。自然语言蕴含留作有标记的启发式判断。

## S1-C：Task 只提需求，Run 固定实现

落点：`task-runtime/src/capability.ts`、`task-runtime/src/index.ts`、`agent-runtime/src/grants.ts`、`task-runtime/src/handoff.ts`、`task/src/types.ts`。DSH skill 发现/加载服务继续复用。

1. **便宜的预检先落地**：多 preset 冲突检查已完成，同名声明允许合并，异名在 `resolveCapabilities` 阶段拒绝，普通分解与 replay 共用。待建部分是用实际 worker 的 cwd/preset 发现路径检查已配置 skill 等资源。已知不可用的配置在子任务落库前拒绝，失败的 MCP 启动仍在 spawn 阶段记录。
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
