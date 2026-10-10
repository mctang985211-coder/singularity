# 装配前质量审核

日期：2026-10-10。审核基线：`singularity-core` **`1a7dc126915bd4efa715ccbf250d54bc1e0ea583`**；旧 Singularity `6a0eddec10519bc8c30ed9c7bb9998865f89754f`；DSH checkout `639ed015397290b3745d163aafe02ffee4aa3f84`，实际宿主 `0.2.0-rc.2`；RRSI `be50316e1db05914068a973f322770ef08ed7ba1`。

**结论：可以开始装配层建设；“装配前置全部完成”还需要收窄。** 提交、领域状态机、真实验证与测量、两轮选择和发布原语已经有可运行证据；多会话权限、批准重送、完整发布依据和跨轮历史仍有以下缺口。建议先做 G0 修复，再接标准 Web 聊天中的单任务纵切。后续设计见 [assembly-blueprint.md](assembly-blueprint.md)。

本文记录本次独立核验，不替换 [第一轮 review](review.md) 或前几轮历史记录。没有修改产品源码、旧仓或运行中的 profile。

## 核验与已成立的部分

- `1a7dc12` 上独立运行 `pnpm verify`：**327 tests / 29 test files / 21 gates**，构建、测试、门禁与门禁自检均通过。门禁内的控制 store、执行、恢复、测量、round、发布、CD 与领域对照探针随之运行。
- 追加反例使用真实 DSH JSONL 控制 store 或纯内存协议管线；临时目录执行后删除。审批来源和晚到测量用明确标注的 double；没有真实用户被发问，也没有模型调用。
- 检查了 [live-campaign.md](live-campaign.md) 及其原始日志。它证明模型产物、子任务依赖、验证、测量、receipt 与两轮决定能相连；本次没有重跑需要网络和凭据的 live campaign。
- 未重跑旧仓全量测试或所有变异。旧仓用于接口、行为和装配方式对照；通过本次门禁不能推导本文新发现已受测试保护。

值得保留的实现：持久化屏障失败后不公开希望状态；重开先确认屏障再 adopt；跨实体检查放在唯一提交队列；未知载荷拒绝；执行者与验证/测量服务分离；缺失 trial 保留固定分母；内容绑定与领域版本明确。这些已经比第一轮架子扎实。

## A01 · P1：`forAgent` 没有绑定调用者

依据：[forAgent 返回原命令引用](../src/task/commands.ts:260)、[Run 的身份判断](../src/task/responsibility.ts:97)、[actor 来自角色表](../src/protocol/memory-log.ts:159)。

**实测：** A 持有 `A-task`；部署同时持有 B，B 的 identity 与 A 不同。`commands.forAgent('B').startRun({ taskId: 'A-task', ... })` 成功；随后 B 的 `failRun` 也成功。两条事实都被盖上 `scheduler-A`，因此 reducer 看到的是调度服务身份，无法知道命令来自 B。

裁掉 `recordVerdict` 是有效的能力限制，但只回答“能不能调用验证方法”，没有回答“能操作谁的任务”。当前 held identities 与固定 scheduler actor 的关系也不能直接支持多个各自独立的 executor。

**修法：** 在可信命令面绑定真实 Agent/session/control；首次提交的责任和作用域检查在 store 的串行 `require` 内执行。把提交服务身份与实际 executor 区分，Run 固定实际 agent/session 引用，receipt 能指出真正执行会话。工具参数不接受 caller/actor/session/control，也不让模型任意 assign/reassign。不能只在工具描述或可见性上约束。

**验收：** B 启动、关闭、分解 A 的任务均拒绝；不同 control 的任务拒绝；合法 B 能执行自己的任务；交接后旧会话不再开展新工作。原调用者对已提交命令的重送仍识别原结果，不能把责任已变化的当前检查提前到命令识别之前。

## A02 · P1：批准命令的重送会再次询问并冲突

依据：[approve 先 ask 再 emit](../src/release/commands.ts:127)。

**实测（native seam double，每次产生新审计 ID）：** 相同 `commandId`、revision、draftDigest 和原始请求调用两次；第一次成功，第二次再次 ask，随后 `command-conflict`。观察到 `asks = 2`。批准已提交但答复丢失后的恢复，因此不能通过这一高层命令完成。

原因是请求身份与结果身份混在一起：新的 `approvalId` 被纳入提交 payload，事实层幂等不能阻止 emit 之前的外部操作。单纯捕获冲突返回成功，会掩盖同 ID 不同请求。

**修法：** 在等待人之前识别原始请求和已有完成结果；同请求并发合并为一个在途 ask，不占用提交队列。持久记录原始请求摘要与批准结果的关联。崩溃在“DSH 已答允许、控制事实未提交”之间时，只在能精确关联原 ask、call、内容和结果时恢复；否则呈现待重新批准，不自动制造授权。已有完成结果的重送不再 ask。

**验收：** 丢答复重送只返回第一次结果；同 ID 改内容拒绝且不发问；同请求并发只问一次；拒绝/取消/不可用不发布；上述崩溃边界有确定的恢复规则。

## A03 · P1：RSI 发布还没有绑定 selection 与报告

依据：[draft/approve/publish 的公开合同](../src/release/commands.ts:81)、[publish 的检查](../src/release/commands.ts:146)、[CD 探针的未观测项](../scripts/cd-probe.mjs:998)。

**实测（真实 store +审批 double）：** 一份 created Revision 可以直接 draft、approve、publish；日志没有任何 measure 或 strategy 事实，指针照样移动。源码也明确允许“没有 round 选中”的 head。

这对可信初始版本装载可以合理；对“只有冻结评估后的胜者可发布”的 RSI 产品入口则不充分。CD 探针由探针作者把 winner 交给 release，不等于产品已强制这个连接。其“输家发布被拒”目前证明的是批准属于另一 revision，不能证明“输家即使单独获得批准也不能走 RSI 发布”。

**修法：** 装配层提供 `draftFromDecision`/`requestPublish`，只能从已提交决定解析 winner；draft 固定该决定、报告、读截止范围、双侧版本和策略/噪声依据。原生 ask 向人展示这份具体内容；发布在提交队列中重检同一依据、批准与 head generation。初始版本装载作为具名的部署操作，不能混入模型的 RSI 发布工具。

**验收：** 未评估、非胜者、winner=null、批准后换报告/内容/依据的请求拒绝；唯一有效胜者可被真实 Web 人审发布。模型不能供应 `approvedBy` 或把测试自动允许的 answerer 装进产品 profile。

## A04 · P1：只有 revision ID 的 CAS 不能识别 A→B→A

依据：[EnvironmentState](../src/environment/protocol.ts:47)、[pointer 的比较](../src/environment/protocol.ts:236)。

**实测：** 指针经过 A→B→A 后，携带旧 `expected: 'A'` 的更新仍被接受。接口只有 revision ID，无 generation；它无法表达“这是第一次看到 A 时冻结的发布依据”。这正是第一轮 U04 要求 generation 的用途。

**修法：** 为每个 Environment 的切换维护单调 generation；publish/rollback 共用同一切换路径，比较 expected revision + generation。批准依据也绑定该 generation；更新不自动换基准。新增持久字段进入新领域版本。

**验收：** A→B→A 后旧 generation 拒绝；同 revision/generation 的并发更新只成功一个；同 command 的已提交重送返回原结果；rollback 不倒退 generation。

## A05 · P1：accepted history 在换 head 后丢掉此前采用的机制

依据：[publishedAssetsBelow](../src/strategy/published-assets.ts:77)、[上游 accepted_edits](../../rrsi/rrsi/history.py:129)、[上游 novelty](../../rrsi/rrsi/components.py:106)。

**实测：** A 无结构 → B 新增 skill `count` 并采用 → C 保留 `count`、新增 tool `tokenizer` 并采用。B 时 `acceptedAssets=['skill']`；C 时只剩 `['tool']`，再测 skill 的 novelty 为 1，而 C 的 manifest 仍含该 skill。

当前实现只找“提出当前 head 的那轮”的 edits；增量 edits 不是 head 的完整采用历史。现有 spec 验证了旧 cutoff 不变，却没有验证新 cutoff 下的连续继承。上游用 accepted edit records 累计 counts，这项差异尚未列入分歧账本。

**修法：** 用同一控制日志、截止范围和真实发布关联推导累计 adopted edits，保留“选中但未发布”的区别；按当前移植词表计算 novelty。采用历史与当前资产清单是不同读法，不能拿最新一次 diff 当二者。rollback 不改写过去采用事实；将来如果需要描述当前分支的资产谱系，再定义该用途。无需新持久化历史文件。

**验收：** skill→保留 skill 加 tool→下一轮 skill 不再新颖；拒绝或仅选中未发布不增加 adopted counts；固定 cutoff 不变；bootstrap 与 rollback 的口径具名。

## A06 · P1：已决定的 round 投影可以显示另一个 winner

依据：[projectRound 重新计算](../src/strategy/view.ts:329)、[decideRound 的读与提交](../src/strategy/commands.ts:168)。

**投影缝反例（受控 MeasureSlice double）：** 已提交决定为 `winner=null`、理由为 slot 尚未测量；稍后该 evaluation 可读为质量 0.8、incumbent 0.6，再调用 `projectRound` 得到 `winner=0`。保存的决定仍是 null。这里核实的是投影 API，未宣称执行了真实晚到实验或 Web 恢复。

`historyCutoff` 固定历史基线，却没有固定决定采用的候选测量截止范围；`projectRound` 不读取已提交 decision 来区分历史决定与当前预览。改变部署 calibration 也能重算出不同预览。Web 若直接把它当“已作出的决定”，会与发布依据分叉。

**修法：** 开放 round 使用预览；关闭 round 使用决定自己的 calibration、候选报告引用及 decision cut 重算，并核对保存结果。晚到事实保留为后来观测，不改写已关闭结果，也不凭当前预览发布。只保存确定性重算所需来源，不复制一套权威 report。

**验收：** 决定后补测、换 calibration、追加日志，历史 winner/理由/Δ 均不变；新的预览明确标成预览；发布读取已提交决定；固定依据重算不一致具名拒绝。

## 装配交付缺口与复杂度判断

这些是下一阶段要建设的消费者，不应伪装成现有原语的局部 bug：

| 部位 | 现状与下一步 |
|---|---|
| 执行与提交 | `AgentCommands` 没有 submit；真实 campaign 由脚本调用模型并接管产物。开放完整 DSH 工具前补“提交→关闭写入准入→drain→固定产物→验证→结算”。旧仓 [drivers](../../bb_work/harness/packages/singularity/task-runtime/src/service/drivers.ts:289) 与 [gate](../../bb_work/harness/packages/singularity/task-runtime/src/gate.ts:1) 可作行为参照。idle 不能算成功。 |
| 创建与恢复装配 | [当前 runtime](../src/runtime/agent-session.ts:201) 创建/恢复时没有传 `setup`/parent/preset；宿主已经支持 unpublished `setup`。把 preset、工具限制与 prompt 安装放进该路径，create/resume 使用同一装配函数。 |
| Web 根会话 | 用户 Web 聊天已有真实 Agent 与写句柄，不能为它再开一个派生 session。绑定现有 Agent；仅自管 child 由装配层持有 disposer。 |
| receipt | 当前是控制前缀的凭证；尚无实际 agent transcript 的冻结范围、真实模型路由/用量/工具消费来源。新增封存来源引用，保持凭证派生；不要用 bubble 的声明冒充真实模型调用证据。 |
| 资产与实验适配 | `edits` 仍是声明。实际 diff/target 核验、TaskTemplate/Skill/Tool 加载与消费、工作区和保护输入、真实 trial 单位必须由产品适配器接上；reserved slot 不能仅由模型勾 exploratory。 |
| 包与宿主装载 | `build` 仅 `tsc --noEmit`，测试靠绝对路径 alias/hook。发布可装载 JS 与类型入口；profile 按宿主解析 peers，产品不使用测试 loader 或 `/home/ROXY` 路径。 |

复杂度比第一轮明显增加，但主要是把原先遗漏的规则做实。下一步应把脚本中真正需要的执行消费者移到一个装配包；领域规则仍由现有 core 实现，脚本继续作验收。不要为 profile、Web、工具分别构造 store、fold、任务调度器或恢复账本。文件/证据预算可以帮助控制体积，不能代替多会话权限与真实产品路径的测试。

本次不要求搬回完整 group/router、critic/analyst/digester pipeline 或上游整个执行体。[ADR-0001](adr/0001-rrsi-port-boundary.md) 的移植边界继续成立；D9 的 S* 缺省是已接受差异，此次没有把它冒充未处理 bug。A05 是另一个独立的 history 问题。

**下一检查点：G1，标准 Web 会话发起任务 → 真工具执行 → 显式提交 → 独立验证 → 固定来源 receipt → 同会话恢复。** 子任务纵切 G2 与人审 RSI 发布 G3 随后交回，各自材料见装配蓝图。
