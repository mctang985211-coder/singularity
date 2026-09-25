# VRTC-KISS 建设计划

更新：2026-09-24。保留原文件名作为稳定入口；原临时计划在 [历史快照](history/2026-09-21-vrtc-plan-snapshot.md)。
方向与实现事实以 [工作指南](singularity-harness-guide.md)为准；本文仅描述建设顺序、代码落点与可验收结果。
本轮文档精简前基线：Singularity `8b689ac`，外层 harness `70aa6d9`。旧建设基线见历史执行记录。

## 当前排期

### 唯一派发顺序与完成闸

下表是唯一当前顺序，也供填写进度。已完成票的逐轮证据见[历史执行记录](history/2026-09-24-vrtc-execution-records.md)；其中的“下一项”只描述当时，不覆盖本表。只有明确反例才重开已验收票；`待填` 不表示通过。

进度审核使用[指挥 prompt](execution-prompts/progress-review-and-dispatch.md)，单票按[派发模板](execution-prompts/task-dispatch-template.md)填写，子代理按[公共派发粒度](execution-prompts/README.md#子代理派发粒度)拆分；主代理负责整票集成与验收。

| 次序 | 一次派发的范围 | 状态 | 负责人/任务 | 交付记录 | 进入下一项的条件 |
|---|---|---|---|---|---|
| 1 | T1：统一规范化契约 | 已验收（2026-09-21） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | 普通分解/replay 契约规范化、持久化一致 |
| 2 | S1-V 切片 2：验证器自测与输入身份 | 已验收（2026-09-22） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | 自测执行、裁判版本、受保护输入校验 |
| 3 | S1-C：能力预检与版本绑定 | 已验收（2026-09-22） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | provider 预检、侧车契约、Run 绑定与旧版本读取 |
| 4 | A3：非阻塞运行与恢复 | 已验收（2026-09-22） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | 非阻塞推进、写入归属、显式提交、取消/恢复与根预算 |
| 5 | T2 + T3：契约审核与恢复 | 已验收（2026-09-23） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | off/all、审核持久化、批准后重检与崩溃恢复 |
| 6 | A0 + R0：根入口与默认运行面 | 已验收（2026-09-23） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | Q2/Q3 来源归属与 adoptRoot 恢复反例关闭；R0 证据保留 |
| 7 | R2：按证据整理运行时 | 已验收（2026-09-24） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | Q1 两条取消交错、恢复及合法 active 路径通过；其他取消边界未证明 |
| 8 | R1：真实运行验证 | 已验收（2026-09-24） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | 完成轮 3 `pass / path2-limited-goal` 且独立复核通过；失败轮与用量缺报保留；仅证明固定场景 |
| 8a | R3：已有 Task 合同归位 | 已验收（2026-09-24） | — | [历史记录](history/2026-09-24-vrtc-execution-records.md) | R3-1–R3-3 全通过；内容身份、Task 依赖与旧数据行为保持 |
| 9 | A2 + A1：Agent 状态上下文（一个交付组） | **返工（2026-09-25 复审：Q1/Q2/Q4 关闭；Q3 大事件仍不可续读）** | 实现主代理 + 子代理 | 本文 D/E 节；[交付记录](history/2026-09-25-a2-a1-delivery-record.md)、[进度审核及复审](history/2026-09-25-a2-a1-progress-review.md)、[返工记录](history/2026-09-25-a2-a1-rework-record.md)、[Q3 收尾 prompt](execution-prompts/09-a2-a1-q3-closure.md) | 按 D 节已定的单事件引用补齐 Q3 的有界续读，复验 Q1–Q4、A2-1～A2-6 和公共检查；整组经独立审核通过后才派 A4 |
| 10 | A1 原独立排位 | 并入第 9 项，不单独派发 | — | 保留编号供历史引用 | 第 9 项整组验收后直接进入第 11 项 |
| 11 | A4：父子澄清 | 待前置；合同已定、未实施 | 待填 | 本文 F.1、深入架构 §7 | agent-runtime + DSH 负责持久消息与投递；context 呈现，task-runtime 负责阻塞执行效果；父子/三层、故障恢复与写闸完整 |
| 12 | S4-E：评估基础（S4 内的子票） | 待前置；合同已定、未实施 | 待填 | 本文 F.2 | 现有 Evolution 生命周期随本票迁入 evolution 包；单文件 Skill 的可比实验、真实证据与晋升闸，旧 ledger/回滚保留 |
| 13 | A5 + S2-E：诊断与缺口交接（一个交付组） | 待前置；合同已定、未实施 | 待填 | 本文 F.3、深入架构 §8 | agent-singularity/review 按源身份触发只读复盘并保存交接；runtime 结算不等 reviewer；缺口可见与诊断失败恢复完整 |
| 14 | A6 + S2-R + S3：自主改进与恢复（一个交付组） | 待前置；合同已定、未实施 | 待填 | 本文 F.4 | evolution 组织有限候选路径，task-runtime 重检并恢复原图；L1/L2、能力/产物缺口、拒绝/重启/回滚均验收 |

### 五问复核：保留领域差异，直接用现成底座

本轮按“作用 → 必要性 → DSH 是否已有 → 其他开源实现能否直接承担 → KISS”复核**整张排期**。已验收的第 1–8a 项是历史事实，不因复核重写旧提交；若发现可达重复职责，随实际触及票删除旧路径。下表中的“复用”指调用现成接口并删除重复实现，不是把另一个项目的源码逐字复制进来。DSH 源码对照见[本地复用核查](history/2026-09-25-dsh-reuse-audit.md)，外部项目一手来源见[开源机制调研](2026-09-21-open-source-agent-patterns.md)。

| 范围 | 作用与必要性 | DSH / 其他开源项目 | 五问后的处置 |
|---|---|---|---|
| 已验收 1–8a：契约、证据、准入、执行、恢复、人审 | 让任意生成的 Task 有独立裁判并能在失败后保持事实；是 VRTC 骨干 | DSH 有 Agent、Session、Skill 与 approval，但没有 Singularity Task/Run/Verifier 组合验收；Agent Team 的 task board 也没有这些语义 | 保留领域事实和已验收实现；继续调用 DSH 底座，不复刻其 loop、日志、批准或 Skill loader |
| 第 9 项 D/E：可信项目上下文与显式恢复 | 让模型读到当前契约和同 graph 证据，同时不让读取触发恢复；已存在两个真实消费者 | DSH 已有 prompt waterfall、Session query/reference、compaction；其原始查询仅按 cwd 授权，缺 graph 域 | 保留 context 的绑定/授权/投影和 runtime 的业务恢复闸；删除任何第二日志、索引、压缩器或会话恢复器；Q3 只补有界事件正文适配 |
| 第 11 项 A4：直属父子澄清 | 子节点不确定时能问等待中的父，回答仅解除对应业务阻塞；否则递归执行会卡住或猜测 | DSH inbox、steer/followup、resume 可用；实验性 Agent Team 有 mailbox，但绑定它的 Lead/roster/task board 与现有 graph/Task 双轨，且不支持此处的独立业务 Run | 只保留 Task 问答身份/阻塞事实和最窄投递对账；复用 DSH inbox，不建通用 mailbox、聊天日志或 Team task board；删单独的提问次数预算 |
| 第 12 项 S4-E：候选的可比验证 | 晋升 Skill 前证明确实修复且不破坏已通过任务；没有它人审缺证据 | DSH 没有 Task/Run/verifier 对照评估；GEPA 提供候选优化接口，但不直接执行本项目 Skill、权限闸和回滚 | 保留现有 Evolution/replay 的扩充及双侧 Run 证据；不建通用实验服务、优化器或第二套 replay runtime |
| 第 13 项 A5：失败后自主诊断 | 让 supervisor 从失败 Review 启动、取证并交接一个有来源的改进建议 | DSH 已有 Session 查询/指标来源和 Agent 生命周期，没有 Review/Diagnosis/source 去重；OpenHands condenser 不替代领域诊断 | 保留唯一失败源、已有 reviewer ledger 的最小 claim 与 Diagnosis；直接读 DSH 观测，不强制迁出一个通用 Session 观测模块；不建 incident/分类器 |
| 第 14 项 A6：能力生长与原目标再尝试 | L1/L2 缺口要由 Agent 产出候选、经独立验证和人审后恢复原目标；是自进化闭环 | DSH Skill loader/approval 可直接用；LangGraph/AutoGen/OpenHands 的状态或通信不能代替本项目 TaskRun、证据、应用/回滚账 | 保留有限 capability/Skill 候选、现有 Evolution 闸和 task-runtime 新 Run；复用原准入/执行/验证路径，不复制 scheduler、事务平台或任意对象执行器 |

其他开源项目的机制可借鉴，但目前没有经接口、持久身份和权限验证后能**直接替换整票**的实现；不能因相似名称把未知兼容性记成“已复用”。若施工时发现同版本 DSH 的公开接口已完整覆盖某个拟建行为，删掉该拟建实现及验收中的内部步骤，保留外部结果与 Singularity 的领域检查。没有当前消费者的功能、配置和状态不预建。

状态填写：`待前置 → 待派发 → 进行中 → 待验收 → 已验收`；有未解决缺陷填 `返工`，因外部条件无法继续填 `阻塞` 并记录原因。实现者宣称完成仅进入待验收；“已验收”需要下述完成闸证据。依赖票的状态不能因内部部分提交而提前推进。每次更新本表，同时更新本文对应票据状态及主 guide，记录冲突时先核实证据。

2026-09-24 既有大模块审计后加入 8a，保留原票号与历史记录。R3 是排期中的有限维护票，不是 A2 的功能依赖；保留串行安排以避免同时迁移共享导出，不能扩成“先整理完全部大文件”。其后上下文、通信和诊断迁移仍随各自票交付。已验收的 S1-C/T1/T2/T3 不重开重做，R3 用既有合同回归；R1 已于 2026-09-24 验收，R3 已于同日经进度审核验收（见历史执行记录）。

第 9、11–14 项的接口、归属、恢复和验收已在 D/E/F 节固定，不再要求执行者自行选定架构。到达该行时只核对前项实际接口与合同是否一致；一致就填写派发材料，存在具体冲突则修订本处对应合同并说明依据，不能重新泛化选型或削弱验收。私有文件组织、helper 命名及等价实现由执行者决定；改变读取域、写入所有者、候选范围或恢复语义不属于普通实现取舍。

单项记录模板（新票的详细记录存入 `docs/history/`，文首表链接；交付组共用一份，逐票列明验收结果）：

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
| 既有复杂度处置 | 待填：本票触及的 400 行以上文件逐个写保留/删去/迁出/包内拆分及依据；已声明迁出的旧实现与调用方删除位置；明确留到哪张票的事项及触发条件。只查本票范围，不按行数或导出数判定 |
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

派发入口：[执行 prompt 与公共合同](execution-prompts/README.md)。第 9 项 A2+A1 的[复审](history/2026-09-25-a2-a1-progress-review.md)确认 Q3 仍未关闭；当前只派[Q3 收尾返工](execution-prompts/09-a2-a1-q3-closure.md)，整组独立验收后才进入第 11 项 A4。历史补救、R1 和 R3 的逐轮证据见[执行与验收记录](history/2026-09-24-vrtc-execution-records.md)。

## 当前施工合同（D/E/F）

### D. A2 + A1：Agent 状态上下文（2026-09-24 职责重定）

状态：实现方于 2026-09-25 交付 `4a510ed`、`f90d05b`、`0f41d91`、`6e0f651`；[进度审核](history/2026-09-25-a2-a1-progress-review.md)发现 A2-2/A2-3/A2-5 的可达反例，**第 9 项返工、整组未验收**。原交付证据保留于[交付记录](history/2026-09-25-a2-a1-delivery-record.md)，职责及依赖方向见[主 guide §1.4](singularity-harness-guide.md)。

**定向返工（2026-09-25，提交 `bee6a96` + 复核响应 `6ae5aa0`）**：Q1（绑定事实读取失败具名拒绝模型请求、零模型输入）、Q2（委派者属于所委派 graph）、Q3 的“中途读失败不得返回局部成功页”、Q4（状态分页必前进）已有红/绿反例，见[返工记录](history/2026-09-25-a2-a1-rework-record.md)。**复审未关闭**：单个事件正文超过当时上限（16 KiB）时，当时工具只能具名拒绝并提示 `offset: seq+1` 跳过，不能取得该事件正文。D 节现固定采用同一四参数工具的单事件引用按字节续读；这是当前可派[Q3 收尾返工](execution-prompts/09-a2-a1-q3-closure.md)，不是放宽 Q3 验收。实现及整组复验前仍保持返工。**2026-09-25 追加裁决（计划所有者）**：上限由 16 KiB 改为与部署一致的 50000 字节（见下「读取合同」段），字节窗口与省略措辞直接复用 `@deepseek-ai/dsh-output-retention`，不再自行维护切分算法与省略句式；游标与按行预算仍属本包。

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
| `context_read({kind, ref, offset?, limit?})` | kind 为 task/run/evidence/review/diagnosis/session；Task 类按现有记录 id。Session 的 `ref: sessionId` 按事件 seq/条数分页；`ref: {sessionId, seq}` 定位一个事件，其 `offset/limit` 按该事件正文的 UTF-8 字节分页 | 服务先以 live caller 解析域，再核对目标归属；不存在/不可读/引用失效具名返回，不允许模型指定授权用 graphId/storeId/callerId |

ref 的形状固定沿现有身份：task/run/evidence/diagnosis 使用各自 id，review 使用 `{taskId, runId}`（无 Run 时 runId 为 null），session 列表使用 DSH sessionId，单事件使用 `{sessionId, seq}`；不为 Review 或 Session 再造全局索引。Session 列表的 `offset/limit` 仍是事件 seq/条数，遇超限事件停在该 seq、给单事件引用，不自动跳过；单事件引用用 `sessionQuery.readEvent({sessionId,seq,before:0,after:0})` 取同一事件，按已有 `extractSessionEventText` 文本视图的 UTF-8 字节分页，`offset/limit` 是正文中的字节位置/页量。单事件成功页的模型可见文本是含 `sessionId,seq,offset,nextOffset,hasMore,body` 的 JSON 对象，`body` 为本页原文片段，偏移只计原文而不计 JSON 包装；最终页说明返回列表 `offset=seq+1`。每页重新核对同 graph 成员，校验取回的 seq；`ProjectedRead` 的续读字段与可见 JSON 一致，连续 `body` 必须还原整段正文。工具 schema 必须说明两种单位；不拆 UTF-8 字符，非边界 offset 或越界 offset 具名 `stale-reference`，返回实际 nextOffset。单事件 `seq/offset` 必须是非负安全整数，`limit` 必须是正安全整数；缺省 `limit` 用当前上限，显式值钳在 4～当前上限字节，保证一个 UTF-8 字符可前进；非空正文的 `offset >= 正文字节数` 具名 `stale-reference`，空正文只接受 offset 0 的终页。非法引用/数值具名拒绝，不调用 DSH。context 的外围输出与单次详情上限统一为 **50000 字节**（与部署自身的工具结果内联上限一致：基础 bundle 为 `@deepseek-ai/dsh-spill-policy` 设的 `maxInlineBytes: 50000`，所以一次 Singularity 读取不会被平台自己的 spill 策略替换成预览），**包括单事件 JSON 转义后的完整字节数**，由包内一个常量控制，不新增预算配置平台；包括引用列表本身，不能用无限 omittedRefs 绕开。有界与省略的**机制不另造一套**：字节窗口、不切断 UTF-8 字符以及「省略了什么」的措辞取自 `@deepseek-ai/dsh-output-retention`（`TextRetainer`、`describeOmitted`/`formatRetentionNotice`），该库把「如何继续读」明确留给工具；本包只保留它没有对应物的两样：游标 `nextOffset` 与按行的页预算（`OutputBudget`）。核心契约不静默裁剪：工具超限提供明确续读引用，自动装配核心若无法完整容纳则以 context-too-large 拒绝本次模型请求，供调用方处理，不伪造准入成功或改写已接受契约。默认装配和显式概览采用同一相关性规则；稳定角色政策不包含动态状态副本。

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

验收 A2-6（职责迁移闭合）：本组声明由 context 接管的跨记录筛选、相关性、契约/绑定文本投影与原始 Session 读取接线，均有实际工具和请求消费者；旧位置不再保留同一职责的生产实现或同名转发。runtime 的执行绑定校验、持久 handoff 和恢复闸继续由原所有者执行。按迁移前后真实入口与调用方核对，不以文件行数、导出数或整个旧文件是否存在作判据；有旧实现与新实现双轨即本组未完成。

内部顺序细化为：①显式恢复与只读定位分离；②context 来源授权/投影；③工具与真实模型装配、旧渲染迁移；④独立组合验收。每次仅委派其中一个子目标，接口交接后再派消费者；主代理负责整组集成与全量检查。它们是第 9 项内部提交，不是四个可提前宣布完成的阶段；只有 A2-1～A2-6 与完整消费者接线均通过，本组 A2/A1 才一起验收，再进入 A4。

**后续各票的工程归属（不另增执行顺序）**：A4 的消息正文/送达/恢复主体在 agent-runtime + DSH Session，context 显示待答/回答引用，task-runtime 只负责该 Run 的阻塞效果与原相位保持；S4-E 将 `agent-singularity/src/evolution.ts`、`replay.ts` 及其评估/晋升/回滚归入 evolution 包，工具仍是适配，旧 ledger 可读。这里的 gate 是晋升闸，执行写闸 `task-runtime/src/gate.ts` 不迁出。A5/S2-E 的事后因果分析和 review pack 归 agent-singularity/review；`reviewEnrichment` 的终态基础派生及唯一 ReviewRecord 写入留在 runtime，通用 Session 事实直接读 DSH，不把“迁出观测模块”当成建设目标。终态结算不反向依赖 review/context/evolution 是否装配。A6/S2-R/S3 在 evolution 中做候选编排，在 task-runtime 中重检和恢复执行。每票同批更新真实调用方，验证旧记录可读、取消/重启/直接入口及模块缺席时终态仍正确；删除被替换实现，避免长期双轨。

底层不硬编码 supervisor 的因果搜索顺序、失败分类全集或所有候选对象执行器。既有数据按原格式读取；新诊断只保留证据、假设、实验与候选的实际需要。未知问题由 Agent 使用已有工具研究和验证；一旦涉及改契约、提权、改裁判或应用共享能力，仍受既有批准与独立验证约束。

### E. 已有大模块的职责审计与迁移（2026-09-24）

状态：R3 已验收；第 9 项已提交迁移实现，但进度审核判返工、整组未验收；其余迁移随所属票实施。400 行以上只是重点检查触发条件，不能把搬文件或降行数当作精简完成。

**审计结论与处理位置**

| 现有位置 / 行数 | 判断与迁移路径 | 安排 |
|---|---|---|
| `task/src/skill-contract.ts` / 426 | 侧车形状、路径规则、digest 的实际生产消费者为 runtime 的 sidecar/run-binding；迁为 runtime provider 内部模块，不追加进其 index 或 sidecar 大文件。TaskRun 保留所用内容身份 | R3 |
| `task/src/types.ts` / 1317 | Verifier 执行、自测、VerifyRequest 接口归 verifier；RootTaskSpec/TaskDefinition 仅测试使用，移测试支持层；VerificationResult/Evidence 和其他持久形状留 task。按事实族在包内整理类型，保持单一来源，不新建共享 types 包 | R3；不要求一次拆完全部类型 |
| `task/src/service/state.ts` / 1649；`index.ts` / 682 | 保留 TaskState 和 TaskService 的唯一状态、批次预验证与原子提交。若提取校验器，置包内且只返回检查结果；不能按事件种类建立各自持久化的 service。先不重写 reducer | R3 保持行为；A5 只改下述建议约束 |
| `task/src/proposal.ts` / 674 | 提案形状、内容身份与校验属于事实完整性；不是 supervisor 策略，不应迁入 evolution 或删除。无消费的公开 helper 可收为包内，但不能据测试数量猜无用途 | 保留；只随实际相关改动整理 |
| `task-runtime/src/index.ts` / 5722 | 同时装配提案、执行、恢复、会话观测；先分开查询/恢复并迁出上下文。A5 只删除与 DSH 或 review 重复的观测扫描，不强制为搬文件新建模块；提案与执行仍在 runtime 包，私有状态不向外暴露为共享 RuntimeInternals | A2+A1、A5 分别处理实际职责 |
| `task-runtime/src/orchestrate.ts` / 2475 | 批次、worker 等待、提交/判决、replay 均有真实消费者；保留已共用的 observeWorkerRun/settleSubmittedRun，终态写入与资源释放的重复规则在包内归拢，不能另造 scheduler | A2 只迁渲染；A4 接阻塞前先归拢相关结算路径 |
| `sidecar.ts` / 781；`provider-precheck.ts` / 409 | 前者读文件/校验内容，后者按真实 preset/capability 做准入预检；不是同一层重复校验。可将 sidecar 的文件装载与规则校验分为包内模块，保持同一 provider 判定入口 | R3 只迁合同；其余随真实修改，不预建 provider 包 |
| `run-binding.ts` / 496 | 固定与校验实际 Skill 内容是执行保证；只有末尾的文本投影属于 context，不能为“只保留 id”丢掉快照内容与校验 | A2+A1 |
| `normalize.ts` / 544；`workspace.ts` / 536 | 前者统一契约正规化，后者保持实际工作区归属与 marker 顺序；已有生产/恢复消费者。保留，不因长度再造规则引擎或分布式锁 | 不新增清理票 |

公开面也要按调用方收窄：审计未找到 `decomposeAndRun`、`proposalsForParent`、`awaitBatch` 的非测试调用；`executionProviders` 只有测试消费，`skillSearchRoots`、`readProcessStartTime`、`RUN_BINDING_SKILLS_DIR` 有模块内用途但无包外生产消费者。后续改到对应职责时，先把测试改为真实生产入口或内部模块导入，再删无用便捷流程/包入口重导出；模块内部需要的实现仍保留。它们不并入 R3，也不为保留接口制造新消费者。`BudgetConfig.attempts` 没有执行消费者；触及预算配置时删除未执行的声明并核对旧记录读取，不为保留它新建自动重试。与旧账、内容身份和准入相关的检查不能按“看起来重复”删除。

每票只对**本票触及**的既有复杂度负责：在本票完成记录中说明大文件实际承担什么、哪项职责留下、哪项已迁出或删除、旧调用方如何改接；计划留给其他票的事项注明触发票号，不把“稍后整理”用来推迟本票已承诺的迁移。已迁出的职责在本票交付时删除旧实现，不留下第二事实源、同名转发层或共享可变的 `RuntimeInternals`。审核以实际调用链和职责所有者为证据；行数、导出数和文件规模仅用于定位，不是验收指标。没有具体违反当前合同的行为或重复所有权，不新开独立整理票。

第 9 项子目标 1 的 `4a510ed` 已把恢复屏障写入 runtime 入口；后续上下文投影在 `context/src`，未堆回该入口。原[交付记录](history/2026-09-25-a2-a1-delivery-record.md)和[返工审核](history/2026-09-25-a2-a1-progress-review.md)须一起读取。单独 R4“移动公开面与声明区”暂不排入唯一顺序：单搬声明或转发不能解决类体职责，若 A2 后发现具体的重复规则或调用缺陷，在触及该职责的票内按反例收敛。

**R3：一票只解决已有合同放错位置**

状态更新（2026-09-24）：**已实施并验收**，执行与验收记录见[历史记录](history/2026-09-24-vrtc-execution-records.md)的 R3 节；以下原始合同保持不变。

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

A5 的 Session 工具调用/压缩/token 观测直接读 DSH 的 Session query 与 projection；runtime 保留基础终态派生和唯一提交，reviewer 经 context 读授权后的历史。若实际发现两处相同的领域字段提取，才在现有所有者内抽一个只读函数供它们调用；不以“迁移”为目标再造通用观测模块、第二次日志扫描或一层同名转发。`DiagnosisProposal.targetType` 改为非空字符串，删除 reducer 与 task_diagnose 的九类建议白名单；Evolution 自己拥有窄的可执行目标类型，在实际转换入口重新校验，不让开放的建议类型传播为执行授权。验收未知建议能记录并在重开 store 后读回；`evolution_propose.fromDiagnosis` 对不支持目标拒绝且不写 ledger，prepare/apply 各自的校验继续保留，不自动注册执行器。旧九类记录仍可读；新值可能不被旧读者接受，按持久化规则记录版本与回滚限制，不以顶层指纹未变省略兼容性说明。诊断字段完整性、来源及引用检查继续保留。

S4-E 按 D 节整体迁移现有 Evolution 生命周期与工具消费者；不因新包出现再新增候选种类、评分平台或固定补丁目录。上述迁移各自在所属票完整验收，没有一项以“先留 stub，下票消费”通过。

### F. 后续交付组的冻结合同（2026-09-24）

本节与 D 的读取合同、E 的显式恢复合同共同作为派发依据。A4/S4-E/A5/A6 均为**合同已定、代码未实施**；不改变文首唯一顺序。这里固定对外行为、所有者和失败处置，私有文件布局与等价 helper 实现由工程 agent 决定。

#### F.1 A4：有持久来源的直属父子问答

固定工具为 `task_ask_parent({requestKey, question, blocking?})`（blocking 默认 true）与 `task_answer({questionId, requestKey, answer, resolves})`。身份均来自 live caller、当前 Run 和 Task 父关系，模型不传收件人或授权字段；根、reviewer 和无业务 Run 的节点不能使用 ask。答案只有是否解决当前问题的布尔声明，不新建 clarification/decision 等机器分类；`resolves:false` 保持 open，改契约的建议也必须如此。`resolves:true` 只解除该项执行阻塞，不修改契约/权限，框架不声称验证了自然语言答案正确。

replay 的 parentRunId 仅是实验血缘：parentless replay Task 调 ask 必须拒绝且零问答/投递副作用，不能询问 champion 的执行者。若 replay 内真实分解出子任务，才按该 Task 父关系问答。因此下文 ordinary/replay 覆盖要求包含合法父子正例与无语义父节点的拒绝反例，不要求制造一个虚假父节点使所有入口都成功。

正文使用发送 Session 的真实 `tool/call` 事件引用，agent-runtime 在提交领域意图前确认它已 flush；直接服务调用也必须提交可核对的同一来源，不允许伪造文本引用。Task 只记录 question/answer 身份、双方 Run、正文引用、messageId 与阻塞效果。待答与阻塞从这些问答事实派生；A3 预留的 `pendingQuestionIds`、`blockingQuestionIds` 当前无非空生产写入，A4 不启用它们作为第二份持久索引，并在同票从新写入形状撤掉，旧空字段仍须可读。不能用 RunPhaseChanged 伪造一次主相位变化。id 按 Run/question 与 requestKey 派生，同 key 同内容返回原记录，异内容拒绝。

顺序固定为：持久正文来源 → Task 原子提交问题/阻塞或答案/解除 → agent-runtime 按同 messageId 投递 DSH inbox → flush 收件 Session 后报告 delivered。ask/answer 不等对方 loop 或回复。Task 意图后崩溃由显式恢复补投递；目标 inbox/history 已有同 id 就不重复入箱。无 inbox 条目不表示已消费：claim 在 pre-step 前可能已移除；context 从未处理问答事实重投影来源，只有实际模型 step 输入才能证明看过，工具领域效果仍以 Task 记录判定。回答已解除阻塞而尚未被模型读取时，下一请求必须包含该回答引用/正文后才能执行；不得仅因 answered 就从上下文删除。没有消费证明就保留引用，不另建 consumed 账本或第二套通信库。

agent-runtime 复用 live Agent.steer/followup、agents.resume 与 Session flush，持有唯一 handle；不使用要求 continuable activation 的 subagents.sendMessage，也不挂载会带来另一套 roster/Task board 的实验性 Agent Team mailbox。暂不可达记 unavailable，保留意图，恢复入口重试；不自动造替代父。active 有阻塞时停止受阻写入/分解/提交与无进展提醒，允许协调输入；waiting_children 的 batchId/写闸始终保持，所有阻塞解除也不能改为 active。父自动提交必须等未处理协调项完成。问答继续受已有 Run wallTime、根截止和无进展停止规则约束；不新增 `maxQuestionsPerRun`、问答重试预算或独立计费账。终态取消未答项，迟到答案只留审计、不解除终态闸。

已知问答等待的 worker 重启后恢复同一 Session/Run，并从持久问答重建阻塞；不能沿用“所有在途未提交 Run 均取消”的旧恢复分支。先对账受管理写入/进程，无法安全接管就具名失败，不能重复不明外部副作用。归拢只限问答触及的普通/replay/恢复结算规则，不要求先重写全部 orchestrate。

验收 A4-1：子→等待中的父→子及三层转问，经真实 inbox/Task/gate 无同步死锁。A4-2：两个阻塞乱序作答，只解除对应项；未解决/契约变更、错父、重复/冲突 key、终态晚到与已有截止/预算耗尽均有拒绝副作用断言，waiting_children 永不获写权。A4-3：分别在 Task 意图已持久但未投递、目标入箱未 flush、入箱已 flush、claim 后未请求模型时终止并重开，最终同一问答身份、一次领域效果；两种主相位和 ordinary/replay 均覆盖。A4-4：父离线恢复、截止取消、源不可读具名失败；正文只在 Session，零新 Graph 边，消息来源非 human；旧空 question-id 预留字段可读，新事件不再写它们。A4-5（结算归属）：本票触及的普通、replay、取消/恢复 Run 结算均经过同一所有者；`index.ts` 在这些路径只作配置、handle 与装配，不保留另一份同名结算逻辑或薄转发。以调用链及 A4-1～A4-4 的结果核对，不要求顺手拆完 `index.ts` 的无关职责。

内部交接顺序：问答事实/reducer与身份 → agent-runtime 投递/恢复 → runtime 阻塞/观测与 context/工具接线 → 独立故障验收。每次子代理仅领其中一个目标，整票验收不拆开。

#### F.2 S4-E：单文件 Skill 的真实双侧评估

本票的新可比评估只支持**替换已存在的单文件 SKILL.md**，不宣称它能新建执行 provider；资源文件/sidecar 新增仍明确拒绝。现有 Evolution 全生命周期、replay 报告、config-edit 与真实消费者迁入 evolution 包，Task runtime 的 Run 执行不迁；旧 capability/preset 记录及已应用对象回滚保留，不能为收窄新评估删掉它们。新 PROMOTE 必须具备本票可验证证据，没有支持的评估器就拒绝新晋升；历史报告不自动升级为新证据。

固定比较目标为“原失败案例修复且冻结的回归/holdout 不退化”；不做多目标打分或自动阈值学习。至少一条失败复现和一条未参与候选选择的 holdout，使用同一预先冻结的客观 verifier/AC，observed/holdout 各自非空。每个样本两侧各执行一次新的 Run，确定性测试精确断言结果；真实模型需统计推断时另定重复次数与预算，不能拿一次随机成功声称普遍改进。样本、输入、裁判、模型/工具、预算、候选身份和比较规则在运行前冻结，沿现有 replay manifest/report 增补必要身份，不另建实验管理服务。

运行器从同一初始快照建两个独立工作区，依次新跑基线与候选；每项报告关联真实 Task/Run/Review/Evidence 与内容身份。历史 champion 只定位原任务/失败，不是本次基线。成功率不能来自模型自填；主目标必须从失败变通过，成功回归保持通过，holdout 不退化。费用缺报保持 unknown；若冻结目标要求成本改善或某成本硬上限，未知即不足以晋升，否则仅作不可推断的观测，不当 0。最终 holdout 使用后不能再作为修订候选的未见样本，需新 holdout 或撤回未见泛化声明。

实验幂等键使用 proposal、prepared 内容身份、样本、baseline/candidate、重复序号；已结算 Run 复用其证据，在途实验按 runtime 恢复结果记录 interrupted/failed，不偷偷补跑或覆写。明确的新实验才能再计预算运行。decide/apply 两次既有人审保留，报告/候选/生产基线在应用前复检；取消和失败仍保存已发生实验与成本。

验收 EVAL-1：双侧真实 runtime/verifier 执行且互不污染，报告可回溯所有身份。EVAL-2：历史基线冒充、输入/裁判/模型漂移、伪造证据、双侧同失败、回归/holdout 退化均拒晋升；合法修复允许进入原人审。EVAL-3：重复调用、取消/重启不重计已完成样本、不替换失败记录；内容/报告/生产基线变化拒绝应用。EVAL-4：新包真实接管全部旧工具消费者，旧 ledger 可读及旧 applied 可回滚；没有 evaluator 的类型仍可查看历史但不得用旧报告绕过新晋升闸。EVAL-5（迁移闭合）：`evolution` 包承担候选、实验、决定、应用与回滚的唯一实现，`agent-singularity` 中原 Evolution 位置只保留有真实调用方的薄工具适配；全部生产消费者已改接新所有者，旧生命周期实现和同名转发删除。以实际调用链和原账读取/回滚回归核对，不以搬走的行数判定。验收在 fixture 中完成，不作模型效果声明。

内部交接顺序：生命周期迁移且旧行为回归 → 双侧执行和证据绑定 → 晋升闸/旧报告兼容 → 独立组合验收。主代理承担新包装配及全部工具接线的集成，不让单个子代理接整票。

#### F.3 A5 + S2-E：按终态事实启动诊断

唯一自动触发源选 **ReviewRecord.outcome=failed**，包括没有 Run 的 blocked Task 的既有失败 Review；不另设 capability 事件触发器。能力/产物缺口继续由实际拒绝处自动持久化现有 CapabilityGapDetected/ObligationRecorded，并进入该 Review 的诊断引用，模型未响应也可读。review 模块在提交后及 graph 显式激活后扫描尚未处理的失败 Review；终态提交只发布事实，绝不 await reviewer。源键固定为 `(rootStoreId, taskId, runId 或 no-run)`，符合已有每 Run/无 Run 唯一 Review，不用 latest-review 代替指定源。

自动与手动 `task_review_agent` 共用现有 reviewer ledger、授权/升级判定与每 store 预算（默认 1）；自动只处理当前既有规则允许的失败，未获触发资格或预算不足保留源并在查询中显示 suppressed 原因，不无限重试或暗加额度。诊断本身消费根截止与可用资源；没有业务 Run 的 reviewer 不造假 Run。A5 扩展 ledger 的最小 claim/completion/interrupted 事实：单 writer 下按 store 串行检查预算与 sourceRef，持久 claim 预分配 sessionId 后才 spawn，同一 sourceRef 只能一个 claim。A2 的 beforePrompt 确认该绑定已发布且一致；旧 started 行仍按旧方式计预算。崩溃后只恢复同一 session 或记录 interrupted，不自动重铸 reviewer；明确的后续尝试仍扣原预算。此扩展不宣称跨进程原子调度。

reviewer 经 context 自主取证、写 Diagnosis（targetType 为非空开放字符串）并给出一个有来源的实验/候选建议；未知原因如实未知，不强迫输出补丁。已有 Diagnosis 关联源 Review 即交接身份，没有 Diagnosis 的 interrupted 不伪装待执行候选。未启用 A6 时交接显示 pending，查询是真实消费者，不发布无实现的执行命令。不开新 incident、分类器或策略 DSL；根因搜索顺序由 Agent 决定。通用 Session 事实直接取自 DSH，基础 Review 派生和唯一终态写入仍由 runtime 持有。

验收 REV-1：一次实际失败持久化后、模型零响应时缺口与 Review 可见；自动/手动重复触发及重启仅一个 claim/session，旧账计数保留，预算耗尽明确 suppressed。REV-2：reviewer 在实际第一请求收到源身份，并能主动读取关联兄弟/证据/历史；跨 graph 拒绝，未知结论能保存。REV-3：claim 前后、spawn 前后及 Diagnosis 落库前后崩溃不重复副作用；诊断失败/模块未装配不阻止原 Run 结算。REV-4：未知 targetType 可持久读回，但 evolution_propose.fromDiagnosis 拒绝不支持的执行目标且零 ledger 写；旧记录/回滚兼容限制有记录，未开启 A6 的交接保持 pending。REV-5（观测与终态分工）：本票涉及的通用 Session 历史与指标继续使用 DSH 查询/投影，runtime 保留基础 Review 派生与唯一 `ReviewRecord` 提交，review 模块只负责事后解释和协调；没有第二次全日志扫描、第二份终态写入或因可选 review 未装配而卡住原 Run 的路径。只有两个实际消费者确需相同领域提取时才抽一个窄的只读函数，不把文件迁移本身作为验收。以真实调用方和 REV-1～REV-4 回归核对。

内部交接顺序：指定源读取/ledger 去重 → reviewer 协调与 DSH 读取接线 → Diagnosis/交接查询 → 独立恢复验收。只在此组开始自动诊断，不提前启动候选写入。

#### F.4 A6 + S2-R + S3：候选闭环与原目标的新尝试

本组保持能力缺口、产物缺口和 L1/L2 的原验收，不把目标偷换成“只改善一个已存在 Skill”。先消费 F.3 的 pending Diagnosis/源 Review，由 evolution 以该交接身份幂等启动 supervisor；绑定复用可信委派 ledger，标明协调角色及有限工具集，无业务 Run 不冒充 root。关闭 evolution 时不启动；预算不足、未知执行目标或需新增权限时保留交接并具名停止。Agent 决定组合/实现方法，人类只审证据与晋升。

**候选支持范围固定**：在 S4-E 单文件 Skill 替换之外，扩展现有 `CapabilityMutation`，支持恰好一条 capability 整行变更，可附一个新 Skill 目录，仅含 SKILL.md 和现有 v1 SKILL.contract.json。L1 使用已有授权工具/Skill 配置这一行；L2 由 Agent 生成附带的执行型 Skill。sidecar 必须引用已注册且独立的 verifier、resources=[]、摘要匹配，requiredTools 不超出现有授权，capabilities 包含该行。指导型 Skill 不能充执行 provider；新工具、verifier 实现、preset/runtime policy 修改和任意资源包不在本次执行范围，具名拒绝，不要求人补写。声明同名生产 Skill 已存在时拒绝新增，替换既有单文件 Skill 沿 S4-E。字段扩展保留旧 mutation 的解释。

**评估/应用必须同组补齐**：复用 S4-E 成对运行器，候选同时挂 capabilityOverrides 与 extraSkillRoots。缺 provider 的基线可能在真实准入时拒绝：记录同一冻结契约的真实拒绝及 gap/proposal 来源，标明 not-admitted、无 Run；不得造 champion/失败 Run，也不得跳过基线预检。新增受限的冻结契约评估入口复用 runtime 原规范化/准入/执行链，不能绕过旧 replayTask 的终态要求来伪造已执行。候选必须真执行并通过同一独立判据、回归与 holdout，新增 capability 的单纯准入通过不算修复。prepared 固定 capability 行与文件的组合身份及生产基线；apply intent 在现有 evolution ledger 持久化后才写文件/配置，恢复按 intent 补齐或回滚，全部完成并成功更新运行 registry 才记 applied。部分写入期间禁止新 Run 使用该 provider，失败不报成功；rollback 同样处理整组对象，不删除基线中已存在的文件。旧 ledger 的单对象读取/回滚保留，不引入通用跨库事务平台。

**恢复入口固定为 `task_recover({sourceDiagnosisId, requestKey})`**：仅向可信 supervisor 协调会话开放，工具与直调服务均检查源归属、批准应用/解决证据、原契约/预算、当前没有在途恢复尝试。该入口恢复的是原目标的**新 Run**，不是旧 Run 复活或旧 admitted proposal 再次消费。runtime 在同一 store 为失败原根 Task 创建新 Run 与新 Session（旧 session 保持终态），复用原根预算起点；以原 Task 的不可变目标/AC 做顶层验收。根 graph 绑定仍指原目标，查询显式区分旧失败 Run 和当前恢复 Run。`TaskRetried` 可复用；返回新 Run/Session 身份后，由该协调节点通过现有 task_decompose 提出新批次，runtime 依据持久恢复关联路由到恢复准入分支，不由模型传 bypass 标志。普通 decompose 一次性闸不放宽；无分解的原目标直接按原契约执行新 Run。

调用归属固定为工具适配 → evolution 的恢复协调入口 → task-runtime 的执行恢复入口。evolution 解析 Diagnosis/候选关联，核对可信协调者及自己持有的批准、applied/rollback 记录；runtime 核对本 store 的源 Task/Run、契约、当前 provider 内容、依赖证据、预算和恢复幂等，再提交新尝试。两层的直接调用入口各自重检所属规则，不把校验只放在工具函数中；runtime 不导入 evolution、不读取晋升账本、不接受模型传入的 approved 标志。宿主组合层负责两者接线，内部调用不能成为额外暴露的模型工具。

恢复按 Run 固定新 batch 身份（parentTaskId + parentRunId），保存本次成员及旧来源；不覆盖 Task 原批次成员或改写旧失败/blocked 子 Task。新 proposal 引用本次 Run，创建失败/blocked 分支的替代 Task，必要的补产物任务由 Agent 按 T1 提出并经过原审核/准入。已通过兄弟以具体 Run/Evidence/输入与产物身份引用复用；依赖映射及父 AC 的 childEvidence 在本次批次绑定中解析，不能靠改原 AC 里的 id 跳过检查。无效复用拒绝并列明受影响项，由本次新提案安排新执行。恢复尝试和新批次准入分别按 requestKey/既有 proposal 消费幂等，重启续同一身份；不再使用固定 `b-<taskId>` 让不同尝试碰撞，也不依赖父再次分解旧批次。新 Run 终态决定本次目标结果，旧 Review/Evidence 均保留。

能力候选应用与产物修复不是同一件事：缺产物沿已有 producer/dependsOn/Obligation 来源新建或执行合法的生产任务，只有产物与 evidence 真满足条件才解除；无需共享能力变更时不强迫先造 EvolutionProposal。task_recover 对能力变更要求已批准应用，对待生产的产物只要求缺口与来源可核对、生产所需能力可用，不能要求产物已经存在才允许启动其生产恢复。该协调节点先读事实/提新批次，受缺产物影响的业务消费者仍须通过原依赖闸；root 最终提交必须检查产物已满足。坏裁判不能由候选改写以通过，保留诊断；连续失败使用既有根预算/无进展停止，不为每种缺口增加修复分类或重试控制器。候选构建和实验的业务 Run 都计原根总额，新 recovery/supervisor 不获得新预算。

验收 EVO-1：L1 用现成能力组合解决一个真实缺口；另一例由 Agent 生成 L2 执行型 Skill/sidecar、独立验证后仅由人批准；人工编写候选不合格。确定性 scripted 验收只证明接线，真实 Agent 生成效果须另有明确授权与预算的实跑记录，不能混称；没有该记录只交付机制、不宣称自主生长有效。EVO-2：缺 provider 基线真实拒绝、候选真实通过；错误候选、弱化 verifier、越权工具、内容漂移、人工拒绝均不应用、不恢复为成功。EVO-3：能力及产物缺口分别经真实 source→Diagnosis→处置→task_recover→新根独立验收；有效兄弟不重跑，无效引用拒复用并显式重建，旧失败可读。EVO-4：在联合应用每个持久边界、恢复 Run 创建后/批次准入前、准入后/spawn 前及新根结算前重开，provider 无半成品可用、同 requestKey 无重复 Run/批次、预算不归零；重复批准、取消、rollback 后的新准入全部重检，旧在途 Run 不热换版本。EVO-5（修复路径复用执行链）：`task_recover` 与新根/新批次沿用已有规范化、准入、执行闸、driver、结算和 Task 预算事实；evolution 只协调候选与已批准的应用，不复制第二套执行状态机、终态提交或 Task 预算账。以能力缺口与产物缺口的真实调用链、取消/重启反例核对；实验费用记录仍由 evolution 保留，不与 Task 执行预算混为一账。

EVO-1 的真实运行证据是第 14 项整组已验收的必要条件，不是可省略的效果附件。派发时须填写本次实验授权和预算，未授权则先完成机制与确定性验证，并将整组保留待验收、列明所缺实跑条件；不能擅自收费运行，也不能填已验收后另排“以后验证自进化”。一组成功仅证明这些冻结案例，不宣称泛化成功率。

内部交接严格串行：①有限 capability+Skill 候选/overlay 与联合应用回滚；②缺能力基线评估及证据闸；③按 Run 的恢复批次、原 AC 绑定与证据复用；④交接消费/supervisor 工具接线；⑤独立端到端验收。主代理保留公共合同/持久化兼容/集成；每个子代理只领一个已固定子目标，不能一次要求其实现完整自进化。整组完成前不开放自主执行开关；任何已承诺路径不以“下票补齐”通过。

## 历史执行与验收记录

P1–R3 的原始合同、失败轨迹、复核与测试结果已移至[2026-09-24 执行记录](history/2026-09-24-vrtc-execution-records.md)。其中当时的“当前状态”和“下一项”只作历史证据；本页文首唯一表及 D/E/F 是现行派发依据。
