# G2 合同：完整求解、真实依赖与读面板

日期：2026-10-11。复核基线：`35b0c7c`。本文替换 G1 基线上的旧 G2 实施设计。
**已有接线不等于本合同已实现。** 用户裁定与反例见 [context.md §18](context.md#18-g1g2-接手审核与用户裁定2026-10-11基线-35b0c7c)；
剩余顺序只在 [assembly-blueprint.md §9](assembly-blueprint.md#9-剩余构建顺序与检查点) 维护，本文定义 G2 行为与接口边界。

## 1. 不可降低的行为合同

| 项 | 合同 |
|---|---|
| Run | 一次完整求解，投递前开始，submit 后独立验证结算；同一 Task 只有一个未结算 Run，idle/live 不判任务完成 |
| 会话归属 | 一个 control 可有多个根；计划从父 Task 责任和 Agent session 引用解析准确父，child 不借最近工具调用者的模型/preset |
| 重试 | 普通 verifier fail 且剩余 maxRuns 时向同一 child 会话投递反馈并开始下一 Run；耗尽/不可推进通知父；运行时异常明确失败 |
| 子任务 | 领域声明最小模板集合，各自构造可裁定 TaskContract；不同 goal 不再自动复制父输入和同一完整 verifier |
| 节点能力 | 每个节点拥有完整 DSH standard 预设与 Singularity 工具；child 可工作并继续分解自己负责的 Task，沿用责任、计划、模板与预算校验 |
| 依赖 | 只有 verified 解锁；上游封存产物按真实摘要进入后序 Run 的输入，顺序控制与产物交付缺一不可 |
| 父任务 | waiting 时允许读取/协调，拒绝冲突写与 submit；child verified/supports 不生成父 pass；父产物必须独立验收 |
| 读面 | 工具/API/UI 读同一 committed cut；准确 Task/Run/session/依赖/receipt 来源可查，读取不提交事实、不调度 |
| 度量 | G2 不保留闲置 metric 配置/类型；真实度量声明与消费者一起移到 G3 |

## 2. 最小领域模板与输入产物

沿用 `program`（执行程序并判产物）和 `source`（判提交源码）两种提交装置，不建两套 Task/Run 协议。
装置固定提交位置、可交付产物、受保护输入、verifier 实现及 selftest；领域字面量不进入通用 driver/scheduler/client。

领域模板提供以下信息，装配接口先按实际领域实例冻结并写 spec，不能只预留一个无人消费的泛化模板框架：

| 声明 | 装配用途 |
|---|---|
| 稳定 template 身份与真实内容摘要 | 模型选择受支持模板，driver 构造固定 TaskContract；模板不能改变父验收 |
| 可判定目标、criterion、verifier ref/version/implementation digest | child 的独立验收；verifier 必须有真实 pass/fail selftest |
| 域内输入来源或上游 child 产物来源 | Task 契约固定来源引用；不是让模型自填输入字节/摘要 |
| 产物名与工作区目标 | submit 封存实际字节；后序按指定产物交付，不读 producer 的可变工作目录 |
| 允许的 supports 与参数/依赖形状 | 完整计划校验；supports 是工作关系，不是父验收证据 |

上游产物的摘要在上游完成前未知。不得伪造 placeholder digest 或改写已准入 TaskContract；
任务模板/契约固定来源引用，后序 Run 开始前解析已 verified Run 的封存产物，绑定真实摘要到现有 inputs/Bubble。
源文件在装载后变化不影响已经摘要并授权的字节；缺失、摘要不符或错误 producer 的产物具名拒绝。
输入个数和模板个数按真实依赖需要决定，旧“恰好一个输入”限制不能继续锁死依赖交付。

letters 是程序装置回归域；SHA256 是源码/独立判据域。两者不需要相同子模板。
G2 的依赖正例必须能观察“前序产物被后序实际使用”，不能把两份相同完整任务叫真实分解。

## 3. 计划权限与发布

模型提出批内 key、受支持 template/参数、dependsOn、supports、maxRuns；真实 task/session/agent ID 由 driver 稳定派生。
caller 来源始终是真实 `exec.agent`。责任、模板、参数、依赖闭合/DAG、supports、预算与输入来源完整校验后，才有副作用。

- 非本人计划、未知模板、循环、缺失 key/产物绑定均拒绝；不能先 admit/assign 再以最后 decompose 的失败充当拒绝。
- 单个 subject 的持有者/形状不变量留在 reducer；跨 Task 的存在/责任/依赖检查在唯一提交队列内，读面由 core 统一投影。
- 合法批次最后由一个完整 decomposition 事实发布；准备项未发布时不可执行。多个 admit/append 没有跨进程崩溃原子保证。
- 合法准备崩溃时按稳定操作身份继续或明确停止；不能因第一次半准备就把修正非法提案变成已提交成功。
- 不额外存第二份计划、调度 JSON 或通用事务状态；必要的模板/来源绑定扩充对应版本化领域事实。

## 4. Run、提交与父写入闸

开始求解前检查权限、依赖输入、revision/Bubble、资源与剩余预算，记录 Run 后再投递。
根任务 Run 跨越分解等待，child 是各自 Task 的 Run；父等待结束继续同一次求解，不能为掩盖等待另造父 Run。
父写入闸必须覆盖授予的 shell/fs/MCP 和 submit，不能只阻止 `startRun`。
父 waiting 由已发布计划的未完成委派工作派生，禁止冲突写；失败耗尽进入明确不能推进状态，不自动宣布父成功。
不授予无法纳入 drain 的后台执行能力。

submit 使用当前准确 Run，关闭新写准入并 drain（排除当前 submit call），封存请求内容与产物/输入字节，再在队列外独立验证。
正确输出但非零退出/信号终止/超时不是 pass；异常/取消/持久化失败不返回成功空结果。
同 Task 并发第二 Run 拒绝；下一尝试不能覆盖前一次封存内容。
同 callId 同内容重送返回原结果，异内容冲突；终态后无关事实与聊天不能改正式 receipt。

语义改变按 Task/Run 对应协议升版本，明确拒绝旧解释；不复用旧版字段偷偷改语义，不加入兼容路径。
`projectTree` 的依赖完成与父验收完成必须分开；更新 `complete` 等投影语义及其消费者，不能只改提示词。

## 5. 调度与 DSH 固定端口

使用显式运行端口表达 open/resume、投递、drain/等待、读取来源和 close；接口复用 core/DSH 类型。
controller 从日志重建责任/Run/计划；进程内 handle 只管理 live lease，不充当“是否需要下一 Run”的事实。

- ready 且无未结算 Run 才可开始尝试；不是“没有会话才 ready”。预算来自核心事实，不靠内存计数。
- child 第一条指令与失败反馈由契约、冻结输入和判决生成，不含领域硬编码。
- 模型/preset/parent 来自自己的准确父。即使由 B 的工具调用触发全 control 推进，A 的 child 仍归 A。
- 投递与等待分开。`followup` 发消息，`whenIdle` 只表示会话静默；decompose 不能等待整个 child 求解才返回。
- child 验收完成后推进后序并唤醒准确父；fail 有预算时向原 child 反馈；耗尽/blocked/运行时错误向父返回具体原因。
- 投递的来源/截止使用 DSH transcript 可识别引用，必要关联补入现有 Run；不得新造通知协议或消息账本。
- create/resume 使用同一 unpublished setup 绑定 preset、prompt、限制/guard；自建 child 不冒充无来源 Web 根。
- open/deliver/close 失败返回消费者；disposer 归唯一 owner，关闭失败不忽略。

正常的计划/结算推进与启动恢复各有明确触发，异常不借 propose 的最近 caller 重扫补偿。
提交已结算但后续派发失败时，两者分别可观察，不能返回成功空列表或让模型误以为需要再次提交。

私有宿主 `0.2.0-rc.2` 已核实的缝继续复用：完整 standard 配置加 Singularity overlay；create/resume 经 setup 中的 `composeFrom` 挂载准确父的实际 preset scope，未挂载则拒绝创建；模型路由显式传入；
可选服务经 `ctx.get` 解析；已有 live 写句柄不得再次 resume；父关闭不级联关闭 child；`followup` 用合法消息构造入口。
任务节点通过公开 `ctx.agents.create/resume` 使用独立主会话；交接消息使用任务协议的准确来源。

## 6. 封存、恢复与只读面板

先补 Run 提交内容与实际控制/session/transcript 来源封存合同，receipt 继续从事实派生。
当前 control cutoff 用于当前状态快照，正式 Run cutoff 用于已完成凭证；两个含义不混用。
公开 receipt 投影 API 必须检查完整连续合法前缀，不能只核对末尾 seq 与数组长度；可信 store 的校验不能替代公开入口自己的合同。
Progress 读面使用 snapshot formatVersion 3，同 cut 展示 Task/计划、Method、轮次、发布、消费与日志预算，并提供 Run/判决、parent/child 准确 session 引用、依赖产物摘要和可读 receipt 来源。
使用原生会话读/打开入口，不复制聊天窗口。工具与 Web route 共用一个 read 端口，client 不解释第二套状态机。

只读路由沿用实际 Web connection 门；非 GET 拒绝；初始化/刷新/重连不写事实，不触发 advance/recover。
面板载入失败显示具名错误，不降为“没有任务”；宿主注入缺失不能被静默未激活掩盖。
client/js/css 随构建产物和访问域一起验证，不靠 host TS 的行数门禁代替审阅。

| 崩溃窗口 | 必须证明 |
|---|---|
| 合法计划准备中、尚未发布 | 不能派发半计划；同批合法准备可辨认，非法提案未产生可执行项 |
| child 创建后、绑定前 | 同一稳定 session 关联可辨认，完成合法绑定或释放 orphan handle，不随机再建 |
| Run 开始后、投递前/后 | 重建同 Run/准确父子关系；确认 DSH 投递来源，未知结果不猜测重送 |
| submitted/drain/验证途中 | 写闸保持关闭，继续处理同封存提交；恢复不允许改字节 |
| verdict/终态提交后、答复前 | 重送识别原内容与原结果，receipt 不随当前日志变化 |
| unload、关闭过程中出错 | 撤销准入、取消/排空、释放 child lease/监听/路由，错误可观察；Web 根归宿主 |

## 7. Spec 顺序与产品证据

按 [spec-policy](spec-policy.md) 先写接口和失败 spec，覆盖执行、隔离、重送、准入、会话/尝试、产物依赖、父验收、封存与错误出口。
固定 stderr/自动重扫等错误行为的旧 spec 要替换；同次删除其连带注释、失效规则与重复检查。

真实浏览器出口必须观察完整链：child-1 真求解并 verified → child-2 收到冻结产物并真求解 → 父被唤醒、继续并独立 submit/验收。
另验 fail→同会话下一 Run→耗尽通知、A/B 根并存、waiting 拒写、运行时错误、在飞 SIGKILL 与 unload。
“存在一个 child 非 running”“恰好一个 child session”“提案结束后重启”均不足以证明上述出口。
断言事实/来源关联，不能依赖模型回复字面量或用探针接管产品关键步骤。

具体构建工作包与 G2 出口见装配蓝图 W1—W5；此处不再另列一份施工路线。

## 8. 原 G2 变异记录的证据边界

以下仅保留现有门禁要求的历史查找标识；编辑与 witness 在 mutation baseline。它们不证明新合同已实现，
被替换规则的变异在对应实现提交更新/删除，不能为旧绿色结果保留陈旧限制。

| 历史 claim | 对应范围 |
|---|---|
| `mutate:assembly-m24-plan-belongs-to-holder`、`mutate:assembly-m25-transfer-belongs-to-holder` | 计划/交接责任 |
| `mutate:assembly-m26-parent-waits-for-a-running-child` | 旧 startRun 闸，不覆盖新的完整求解写闸 |
| `mutate:assembly-m27-initial-source-not-overwritten`、`mutate:assembly-m29-staging-writes-the-loader-bytes` | 初始/输入字节 |
| `mutate:assembly-m28-one-input` | 每模板单输入的闭合 name/source 合同 |
| `mutate:runtime-m30-seams-resolve-through-get` | Cordis 服务解析 |
| `mutate:assembly-m31-children-own-their-tasks`、`mutate:assembly-m32-advance-after-settle` | 子 Task 归属与前序结算后的依赖启动；完整产品链另验 |
