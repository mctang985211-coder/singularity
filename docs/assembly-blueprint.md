# 装配层蓝图与交付计划

日期：2026-10-14。实施基线：`f892376`。本文保留该阶段的装配设计与工作包；2026-10-17 起，剩余施工顺序及新验收条件由 [Task 优先的领域 RSI 计划](task-first-domain-rsi-plan.md) 接替。下文旧状态不能视为新架构已实现。
总目标见 [blueprint.md](blueprint.md)，本轮反例见 [context.md §18](context.md#18-g1g2-接手审核与用户裁定2026-10-11基线-35b0c7c)，G2 合同见 [phase-g2-design.md](phase-g2-design.md)。

小领域原生 RSI 已形成无赢家闭环；复杂任务责任分解、SHA256 效果与发布后消费分别验收。
当前状态见 [context.md](context.md)，原始证据与工程/领域效果边界见 [e2e-testing.md](e2e-testing.md#证据边界)。

## 1. 目标与完成边界

用户已确认本次交付：**私有独立 DSH 插件的 G1/G2/G3、读面板、恢复与发布验证**。
复用旧 ReactFlow map、节点和边、详情面板及 DSH 会话桥。原生聊天与会话打开由 DSH 提供。

- G1：真实 Web agent 调工具完成一次领域任务；独立验收、固定来源 receipt、恢复与明确失败出口。
- G2：各有领域契约的子任务形成实际依赖链，上游产物进入后序输入；准确父子会话、有界重试、父独立验收；读面板展示同源事实。
- G3：进化 **TaskTemplate / Skill / Tool 求解方法资产**，共用一条 Revision → 结构检查 → 双侧评估 → 决定 → 发布审核 → 自动发布路径；资产按实际需要消费。
- RTL 是 Task 的领域产物；正确性/面积可以评测求解方法。直接改一份 RTL 仍是普通 Task/Run，不能冒充方法进化。

工程正确性和领域效果分别验收。工程闭环、恢复、边界及回归必须通过；真实领域质量/成本按事先冻结的标准，
根据实际验收证据报告达标或未达标。不保证随机搜索必胜，不为得到胜者而改判据或无限加轮。

## 2. 所有权与复用边界

| 所有者 | 责任 |
|---|---|
| DSH | Agent/Session、独占写租约、transcript、模型/工具执行、原生 BasicCompaction、持久化、Web 聊天与公开 create/resume |
| core | Task/Run/责任、ReviewRun、Revision/Bubble、独立判决、冻结评估/决定、发布不变量、同一事实的唯一投影 |
| assembly | 绑定真实 caller；准备输入/产物及按需读取的父背景；调用 create/resume、投递、drain、验证、资产加载、消费记录、发布与恢复；拥有自建 child 的 disposer |
| 领域部署 | 最小任务模板、保护输入、产物输入绑定、可选独立验收装置、方法资产与试验口径；SHA256 只提供一份 RTL 和固定综合指导 |
| Web client | 展示固定 cut 的读投影；用户交互、局部视图状态；审核和发布状态来自同一 committed snapshot |

保留一个信封、ControlSessionStore、提交队列、fold、版本闸和拒绝合同。Task/Review/Agent/Environment/measure/strategy/release
各自拥有领域事实，共用机制不要求合成一个巨大 reducer。assembly 不另存 Task/Run/head、调度日志、恢复 JSON 或历史报告。

旧 singularity 仅作只读行为与 UI 代码参考：复用完整 DSH standard 预设接线、严格工具注册、准确会话 setup、提交后 drain、child 同会话恢复、bundle/profile、
同源读路由和 disposer。复用会带回旧协议或破坏接口时直接重写。遵守 [ADR0001](adr/0001-rrsi-port-boundary.md)：
RRSI 只移植决定与正则化约束，使用现有 DSH/Task/Bubble 执行；不再搬一套 agent loop、worktree 编排或 evolution ledger。

## 3. 包与复杂度纪律

沿用 core `src/` 和现有 `assembly/` 包。现有 host 入口是 `.`、`./agent`、`./web`，client 入口是 `./client`；
是否调整文件按实际责任和依赖决定，不预建 method-driver、总线、通用事务引擎或空服务，不为总行数强拆插件。

每次新增持久字段、服务或模块，先指出**真实生产者、消费者和可证伪不变量**；已有事实可派生的值不重复持久化。
领域契约固定通用语义，shell/fs/DSH 服务通过明确端口调用；调度不借用可变的最近 parent、内部私有字段或全局上下文。
TaskTemplate、Skill、Tool 统一加载；验收程序作为 verifier Tool，审核、评估和发布共用一套流程。

体积门禁是审查触发器，不是简洁性证明。新增职责应相应删除被替代实现、无消费者配置、失效注释、重复探针和宽泛通过断言。
不得靠抬预算、换文件名或转移到 client/scripts 隐藏增长；审阅范围包括 host TS、手写 client JS/CSS 和验证脚本。

本轮确认的四项风险直接纳入原工作包，不增加一个无边界的“清理阶段”：

| 风险 | 修改归属 | 完成判据 |
|---|---|---|
| 内存承担业务含义 | W1/W4 | live 只持有资源；责任/准确父/Run/预算从事实读取；重启和 A/B 交错推进结论一致 |
| 修补路径积累 | W2/W4 | 删除 stderr 后继续、close 吞错、异常后重扫重试；正常推进与已授权验收重试保留；已提交结算与后续派发失败分别可观察 |
| 门禁偏离产品目标 | W5/W9，各包同步补反例 | 替换固定错误行为的 spec；证明完整依赖链/真实来源；删除重复检查与无独立目标的散文豁免补丁；取消文档手抄全部变异 ID 的要求，保留账本可运行校验，不新造门禁框架 |
| 历史挤占当前契约 | 文档本轮完成；W1—W8 随修复清代码注释，W9 总核对 | 当前文档各有唯一职责；context 替换状态；代码只保留当前约束与必要原因，缺陷经过留 Git |

采用简单直接实现，先用最小公开行为 spec 固定真实轨迹已确认的错误。每包收口说明被替代路径和必要检查能够区分的错误行为；
若没有替代物或新不变量，不为凑数量安排删除或测试。

## 4. 可信调用与命令身份

原生人类入口创建领域根契约；模型工具提供本节点重试、模板或自由任务分解、资产冻结、评估和提交内容。caller/control/session/actor、verifier、verdict、分数、
revision/head 和 approvedBy 来自宿主与事实；不作为可自填的模型权限。

- `forCall(exec)` 绑定 registry 内准确的 live `exec.agent`，agentless/跨会话/跨 control 操作具名拒绝。
- commandId 使用真实 DSH callId 和操作阶段稳定派生；请求摘要单独核对。同 ID 同内容返回原结果，异内容冲突，不能直接返回旧 pass。
- 原命令识别先于责任/head 等“当前前提”检查；新请求的业务检查在唯一提交队列内完成。
- 文件写入、进程、模型和独立审核在提交队列外；事实串行化不能代替副作用隔离。
- 同一 Task 同时只允许一个未结算 Run；尝试之间的提交产物按 Run 冻结。不同 Task/候选的工作区隔离。

持久语义或载荷变化按对应领域升版本，旧版明确拒绝；不引入兼容 reader、默认值或猜测恢复。
TypeScript 延续 strict、闭合 schema、不可变领域值与显式错误；新增边界不用 `any` 绕过宿主类型。

## 5. 任务运行与真实分解

**Run 覆盖一次完整求解**，根任务绑定契约后开始，child 在投递前开始，submit 后验证并结算。
根 Web Agent 是借用对象，不再取得其第二个写句柄；自建 child 由 assembly 拥有。
root、执行、审核和 RSI 分别挂载小接口面的角色预设；root 必须委派实现，仅协调与受限只读，其余角色保留责任所需的原生文件、命令、编程与 Skill 能力。child 沿用责任、计划和预算校验。

```text
契约绑定 → working（Run 已开始）
→ delegated（子节点自主执行；父协调、读取证据、停止未选探索）
→ working（保留失败探索；只有 verified 封存产物能满足输入依赖）
→ submitted（关闭新写准入、drain、冻结提交）
→ 独立验证 → verified / failed
```

运行时异常和取消明确失败，不当作普通 verifier fail 自动重试。普通验收 fail 且预算剩余时，
调度向同一 child 会话反馈并开始下一 Run；耗尽或依赖不能推进时通知准确父会话。idle/live 都不是任务终态。

领域提供可选最小模板；一次性 `TaskContract` 直接声明目标、输入、交付与标准。模型声明责任、依赖与预算，
不只改 goal 然后复制父验收。`supports` 说明子工作与父目标的关系，不能生成父 pass；父最终产物必须经独立 ReviewRun。
模板固定上游输入来源；待上游 verified 后，后序 Run/Bubble 按封存产物摘要绑定真实输入，不能改写已准入 Task 的契约。

每项委派声明 `requirement: required | exploration`。required 必须独立通过；exploration 可择优并明确停止，不以停止满足依赖或产生 pass。任一子结果结算即通知父判断证据是否足够；剩余责任、已委派责任、活动探索和待回答问题由同一事实投影，限制等待期间的执行与提交。父停止未选探索后仍须完成最终集成和独立验收。

父背景在子 Task 执行前归纳为结构化 checkpoint；模型、持久化和来源完整性错误直接传播。`singularity_memory()` 分页列出可读分支的统一目录（默认 20、最大 100），以 inherited 标出本节点的父背景引用；传 ref 按需读取完整 checkpoint。root 可发现整棵树，普通节点沿用任务可读范围且不跨根，独立审核及其取证节点仅能读自己的审核分支；RSI 可读冻结轨迹涉及的执行分支。campaign 每轮创建新的业务 root 和 RSI session，在新 root 开始前显式记录上一轮已完成 RSI 的原生来源，不增加图边。新 RSI 启动时复用标准归纳流程，从旧 RSI 的冷持久化会话生成绑定新 Task/Run 的 checkpoint；继承旧 checkpoint 中的背景和来源链。决策理由、已试及拒绝机制、无赢家原因、测量与发布引用和未决假设通过同一目录的 inherited/ref 按需读取，不自动注入会话。业务和独立审核没有这项跨轮权限，归纳用量归入 RSI，永不参与比较。目录从原生 log-only 事件投影，不含摘要正文，不新增模型调用或 memory store；同时标明适用 Task/Run、来源截止位置、当前 Run 状态及是否为最新 Run。父责任转交后仍按控制事实读取历史父会话中的 checkpoint。目录整合已生成的父背景，叶子执行后的新发现通过任务和验收证据读取。宿主绑定来源前缀、合同和 verified 证据身份，模型只筛选叙述；历史摘要不能增加当前责任，父声称通过不等于验收事实。单 Session 的阈值压缩、摘要和恢复使用 DSH 原生 BasicCompaction，assembly 不定制其摘要格式。

完整计划、权限、模板、DAG、supports、输入绑定、预算先校验，合法后再准备/发布。非法提案不留下可执行 child 或 assignment。
合法准备过程中崩溃可留下未发布准备项，但不能当作已发布计划派发；稳定操作身份用于继续合法准备或明确停止。
不把多个 admit/append 误称崩溃原子事务；计划仍以一个完整领域事实发布，不建通用事务框架。

## 6. receipt、恢复与错误出口

submit 关闭准入并排空已授予的执行能力，冻结实际提交/输入字节、请求身份和 verifier 实现，再独立验证。
进程非零退出、信号终止、超时、取消和 drain 失败明确呈现，任何“正确 stdout”不能掩盖执行失败。
验收和程序执行的职责保持分离，不拿模型文字或声明的 bubble 工具清单当实际执行证据。

正式 receipt 从**封存来源**派生：Run 的控制事实截止、实际执行 session/transcript 截止与内容引用。
后续聊天、其他 Task、晚到测量不能改变同一 Run 的正式 receipt。面板当前 cutoff 与各 Run 的封存 cutoff 分别展示。
补必要的提交/来源事实到现有 Task/Run，receipt 仍派生，不另建凭证账本。

恢复必须覆盖：准备后未发布；child 创建后未绑定；Run 已提交但指令未送达；submitted 后未记录 verdict；
终态已提交但答复丢失；发布审核已提交但指针尚未切换。DSH 持有 transcript/投递来源，core 保留必要可关联引用。
可识别操作恢复同一 session/Run/提交；无法确认的外部结果明确停止，不能猜测重送。读接口不触发恢复或执行。
完整求解 Run 的恢复先区分 working/submitted/settled，不沿用“所有 running 都重新验证”的 repair 假设。

合法计划发布、verified 结算后推进依赖与启动时显式恢复都是正常消费者；创建/投递异常没有“下次扫描自动重试”的授权。
已提交结算与随后派发失败分别报告，不把派发失败吞掉，也不诱导模型重提已经结算的 Run。

unload 撤销准入、取消/排空工作、关闭自管 child，再关闭控制 store；借用 Web 根由 DSH 管。
创建、投递、drain、持久化、验证和关闭失败都返回可观察的错误；不能只写 stderr 或返回成功的空列表。
监听、工具、路由、handle 各自只有一个 disposer；重复关闭遵循宿主合同。

## 7. G3：一条方法进化路径

固定推进链：**根任务关闭 → 封存完整轨迹 → 异步分析 → 冻结候选 → 独立测评 → 决策 → 发布审核 → 唯一指针**。

1. **终局与分析**：成功或业务失败都关闭根 Task，单次 Run 失败仍可在 agent 当前回合重试。业务结果先返回；后台等待相关原生会话静默和 flush，再封存任务关系、判决、失败原因、实际资产消费、费用及完整 transcript 引用。分析默认看摘要，按需读原文；evaluation 根不递归 RSI。
2. **候选**：只有 RSI 节点能提交工作区中的完整方法 JSON。候选可改领域 TaskTemplate、Skill、Tool；根输入、交付、标准、受保护 checker 和宿主协议固定。结构、绑定及工具正反例检查后冻结并直接测评。部署 seed 初始化当前指针。
3. **执行与消费**：Run 直接固定方法 Revision，Bubble 记录输入附件及执行快照。按当前责任送达相关指导、绑定 Skill 和 Tool 摘要；其余定义按引用读取。宿主区分模板使用、context 送达、Skill 加载和 Tool 成功执行，只有实际记录能用于发布判断，送达不等于收益。
4. **独立双侧试验**：相同保护输入、初始材料、模型、工具、验收和测量口径；新普通会话独立求解并独立审核。两条链可重叠，结束后释放名额。trial 独立落盘，依固定 slot 决定；试验间不可读取答案或无关候选。成本只计一次业务 root、子任务及独立验收截至提交的原生轨迹，按会话去重；RSI 分析、提案、评测编排和发布审核用量永不参与比较。
5. **异步和恢复**：evolve 提交 `rsi/round-requested` 后立即返回持久引用。唯一宿主推进入口从 measure / strategy / release 事实恢复未完成对象，复用完成 trial 和决定。使用现有带身份的原生消息通知结果；不建工作流存储，不要求模型重发长调用。
6. **决定与发布**：`draftFromDecision` 绑定 committed winner、evaluation/calibration、准确内容与 expected head。独立发布 ReviewRun 冻结差异、硬约束、质量和完整费用证据；批准后重检同一依据并切换唯一指针。只有后续 Run 加载并实际消费新版本，才能宣称方法更新生效。

无候选、无赢家、证据不足、审核拒绝、陈旧 head 和用量未知均有明确出口。不引入 generation，不用 RTL 成品冒充方法，不用重复综合代替独立模型试验。历史只读，新实验不做协议兼容。

模型请求不受 campaign token 预算限制。根轮次结束并等待相关原生会话静默和 flush 后，读取 token-meter 注册的 tokenUsage 原生投影，写入封存轨迹 summary.usage 及逐会话原始计费桶，供 RSI 和 usage-report 脚本共同读取。总数按 ui-chat 的 StatsPills 相加四个原生计费桶；缺失 usage、重试及替换均遵循该投影语义，assembly 不另行计量或判断未知用量，也不阻断模型请求。

## 8. 私有 profile 与产品读面

开发、构建 peers、探针和产品启动仅使用 `/home/ROXY/singularity-next/`，版本与环境见 [standalone-dsh.md](standalone-dsh.md)。
部署由现有 assembly bundle/patch 与 `singularity-next-web` profile 进入普通 DSH 启动路径；旧 harness 不参与运行。
产物从 manifest exports 装载，不用测试 loader、手写 Context 探针或绝对开发路径冒充已安装插件。

工具/API/UI 同读一个 committed cut 的 core 投影，返回 formatVersion 9/controlId/cutoff；ReactFlow map 展示 Task/计划、Method、轮次、发布、消费与日志预算，Run/session/依赖/receipt 的来源、责任类型和探索停止原因可查。对应协议为 Task v17、Review v4。
GET 不提交事实、不调度，错误具名；请求接实际 Web 访问域。client 不 fold 原始日志、不乐观写 Task 状态，原生聊天/审核不复制。
ReactFlow map 与右侧 DSH 会话面板复用旧前端，布局由运行时提供；前端不保存另一份任务状态。

## 9. 剩余构建顺序与检查点

每包先明确接口与功能，用最小公开行为 spec 固定实际轨迹已确认的缺陷，再直接修复。通过实际 RTL 运行定位质量和接线问题，完成必要回归并删除替代物。
下表列出各包交付出口；底层原语不能代替产品证据。当前工程验收状态与效果边界见 [context.md](context.md)。

| 包 / 检查点 | 前置 | 交付与退出证据 |
|---|---|---|
| **W1：执行完整性（重验 G1）** | 用户裁定已冻结 | 完整求解 Run；单 Task 并发启动拒绝；提交按 Run 冻结；同 call 异内容冲突；正确 stdout + 非零退出不能 verified；submit 后冲突写被拒 |
| **W2：来源与恢复（G1 出口）** | W1 | 固定 receipt；追加无关事实不变；公开 receipt API 拒绝非连续前缀；真实在飞/提交后 SIGKILL 恢复同 Run/会话/产物；丢答复原结果；创建/投递/drain/flush/close 错误可见；unload 无遗留写租约/监听 |
| **W3：领域分解与产物合同** | W1/W2 | 一次性契约、可选模板及独立 ReviewRun；先校验后发布计划；非法责任/模板/DAG 拒绝时不新增 child 准入/分配事实；上游输入来源固定，后序绑定已结算产物摘要；父 child 验收不同 |
| **W4：准确会话与有界调度** | W3 | 同 control 的 A/B 根计划不串父/模型/preset；live 不决定是否启动下一 Run；首 child verified 后后序实际开始并收到产物；fail 在同会话重试，预算耗尽通知准确父；非阻塞投递及父唤醒；删除借 caller 恢复和异常后自动重扫重试；崩溃不重复创建/重复执行 |
| **W5：读面板（G2 出口）** | W4 | 真实浏览器展示准确 Task/Run/child session/依赖/封存 receipt，工具/API/UI 同 cut 一致；父等待拒写、父独立验收；刷新/重连只读，重启/unload 有来源证据 |
| **W6：统一方法资产与真实消费** | G2 出口 | 冻结候选/加载接口；实际 diff 与保护输入核验；从准确 Revision 加载 TaskTemplate/Skill/Tool，由宿主记录真实消费；仅必要加载适配，共用发布流程 |
| **W7：自主领域评估与选择** | W6；预算/阈值冻结 | 产品执行 incumbent/candidate 双侧 trials；硬约束、缺失/异常、噪声与成本可查；候选数和轮次自主决定；后续评估读取冻结历史；决定追加事实后不变，良劣/越界/无胜者反例通过 |
| **W8：独立审核发布与下一 Run（G3 出口）** | W7 | 版本化发布依据绑定 committed winner；真实独立审核节点；审核重检/拒绝/陈旧/内容变化/丢答复；唯一 head 更新；统一版本完成评估→审核→发布→新 Run 使用；记录实际资产消费 |
| **W9：完整构建与发布验收** | G1/G2/G3 出口 | 私有干净测试 home/profile 装载全部 exports/client；源与产物对应；产品浏览器、边界、故障恢复/unload 回归；原始证据与有限领域效果报告；精简无独立目标的门禁/重复探针/散文豁免补丁，保留者有有效反例；删除失效入口/注释，完成后请求最终 review |

**四个检查点：W1/W2 → W3/W4/W5 → W6/W7/W8 → W9。** 受控工程演示不能替代完整领域 RSI 验收。
真实领域任务范围与阈值已冻结，见 [实跑测试](e2e-testing.md#证据边界)。
2026-10-14 实施顺序：Task 契约与 ReviewRun → 执行快照及角色接口 → 持久异步 RSI → 删除替代路径。离线工程检查、小领域真实决定、SHA256 真实领域结果和发布后消费分别验收；准确进展只在 context 维护。
工作量按这些可退出包评估，不以测试数、静态行数或“基础设施完成”推算完成百分比/精确工期。

W9 的构建验收必须补现有门禁盲区：根 typecheck 与 assembly 分开覆盖；检查 `.`/`./agent`/`./web`/`./client` 全部产物；
新鲜度涵盖打包的 core 与手写 client；host/client 均纳入领域边界审阅。部署的是同一被验证产物，不借开发源码解析侥幸装载。

交回材料：固定提交/宿主版本、脱敏 profile/preset/工具清单、命令/Task/Run/session/Revision/输入/产物/判决/receipt 来源关联；
新反例的 spec 与运行结果；真实依赖链、恢复和 unload 记录；冻结任务集/口径/预算/原始 trials；各类资产的实际 diff、决定、Web 审核和发布后消费。
最终分别给出**工程验收通过/失败**与**领域质量成本达标/未达标**，任何必要出口未通过都不宣称重构完成。
