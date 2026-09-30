# 第 11 项 A4：直属父子澄清

现行变更（2026-10-01）：[计划 G 节](../2026-09-20-vrtc-code-change-plan.md#g-原图续跑与角色装配)覆盖本票早期的 Agent 截止、reviewer watchdog 和按问答来源恢复的限制；当前无 Agent 总时长上限，业务 worker 按持久相位恢复原身份。原交付证据仍作历史事实。

你是 Singularity A4 的实现主代理。工作区为 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层仓库为 `/home/ROXY/code/bb_work/harness`。**只交付第 11 项 A4，整票停在进度审核；不开始 S4-E/A5/A6。**

前置第 9 项 A2+A1 已于 2026-09-25 验收，证据见[最终进度审核](../history/2026-09-25-a2-a1-progress-review.md)；当时 Singularity 为 `2ec39d1`、外层为 `aa23e6c`。施工时重新核对实际 HEAD、两仓状态及适用 AGENTS.md。先读[公共执行合同](README.md)、[唯一计划 F.1](../2026-09-20-vrtc-code-change-plan.md)、[深入架构 §7](../exploration-evolution-architecture.md)与[主 guide §1.4–1.5](../singularity-harness-guide.md)。F.1 是行为与所有权正本；本 prompt 只固定交付顺序、验收证据和停止点。修改前按公共合同保存 Git 基线。

## 本票要让谁得到什么

子 Run 不确定时，以 `task_ask_parent({requestKey,question,blocking?})` 向**直属 Task 父节点**提问；父节点即使处于 `waiting_children` 也能用 `task_answer({questionId,requestKey,answer,resolves})` 答复。问答经真实 DSH Session/inbox 持久送达；阻塞只作用于对应 Run 和问题，既有 batch、写闸、预算与裁判保持有效。`resolves:true` 解除该项阻塞，不声称自然语言答案正确，也不改契约或权限。

先列一张简短的「要求 → 所有者/实际入口 → 正反例」对照，再动代码。不要重新选择消息架构；若同版本 DSH 公开接口与 F.1 有具体冲突，提交可复现的最小冲突和所需合同调整，保持本票未完成，不叠加第二套通信系统。

## 所有权和复用

- `task` 只持久化 question/answer 的稳定身份、双方 Run、Session 正文引用、messageId 和阻塞/解除事实；旧空 `pendingQuestionIds`/`blockingQuestionIds` 可读，新写入不维护这两份索引。问答正文不复制入 Task、Graph 或新聊天日志。
- `agent-runtime` 持有唯一 Agent handle，复用 DSH Session flush、inbox、`steer/followup` 和 `agents.resume`，负责按同 messageId 投递、对账、冷恢复；`context` 从问答事实呈现未处理问题和回答引用；`task-runtime` 只负责 Run 阻塞效果、写闸、结算及恢复；`agent-singularity` 工具仅适配真实调用者与 schema。不要因为工具名带 task 就把消息收发主体塞进 task/runtime。
- 发送 Session 的真实 `tool/call` 正文先持久并 flush，再原子提交 Task 意图，最后投递 DSH inbox 并 flush 收件 Session 后报告 delivered。直接服务入口也须验证同一真实来源。恢复按 Task 意图补缺失投递，已有同 messageId 的 inbox/history 不重复投递；claim 后但模型尚未读到的消息必须能从领域事实再呈现。回答解除阻塞后，下一次执行请求仍须先把尚未被模型看见的回答送入模型输入。
- 身份只从 live caller、当前 Run 和 Task 父关系取得；不接受模型指定收件人或授权字段。`parentRunId` 的 replay 实验血缘不是 Task 父关系。`subagents.sendMessage` 要求 continuable activation，实验性 Agent Team mailbox 带来第二 roster/task board，均不作为本票投递实现。
- 沿用现有 Run wallTime、根截止与无进展规则，不加 `maxQuestionsPerRun`、独立问答预算、第二 mailbox、通用消息框架或回答分类器。`waiting_children` 的 batchId 和写闸始终保持；回答不能让父节点重新获得写权。

## 按接口顺序交接

主代理先确认事实形状与现有 Task/Run 入口。可委派子代理，但**每人一次只领一个子目标**，标明其负责模块、输入接口、定向验收和停止点；共享文件有依赖就串行交接，不能把整票或「跨包实现 + 全量测试 + guide」交给一人。子代理不回退他人改动，不宣布整票完成。

1. **问答事实与身份（task 所有）**：最少事件/reducer、幂等 requestKey、同 key 异内容拒绝、旧空字段读取与新事件形状；交接只包含 runtime 需要的窄接口。验收持久化重开后身份和阻塞派生不变，拒绝零副作用。
2. **投递与恢复（agent-runtime 所有）**：真实 `tool/call` 来源、两侧 Session flush、同 messageId 的 DSH 投递/对账、离线父恢复；交接可读来源与投递结果接口，不在 task 再造 inbox。先用确定性崩溃点固定重复/丢失反例。
3. **执行协调（task-runtime、context、工具依接口接线）**：连接阻塞写闸、父在 `waiting_children` 回答、下一请求回答呈现、普通/replay/恢复结算。主代理负责跨包调用方与 A4-5 的唯一结算所有者；不要让 task-runtime 反向依赖 context 的渲染实现。
4. **独立故障复核与集成**：只给复核者一个明确风险组（来源/权限、投递重启、阻塞写闸或结算）；主代理收敛发现、跑整票检查并更新文档。接口交接和内部提交都不是整票通过。

## A4 完成闸

使用真实 Task store、DSH inbox/Session、执行闸和实际工具门；scripted provider 可替代模型输出，不可替代本票正在接线的服务。新增行为先有未修复代码会失败的正反例，验证外部结果、重启读回和关键副作用。

- **A4-1**：子问等待中父、父答子，及三层转问均不因父等子而同步死锁；问题/答案在实际模型请求可见，Task 身份、DSH 消息和写闸结果一致。
- **A4-2**：两个阻塞乱序作答只解除各自问题；`blocking:false` 正常送达而不阻塞；`resolves:false` 与改契约建议保持 open。错父、根/reviewer/无 Run ask、同 key 异内容、终态迟到、截止或预算耗尽按 F.1 拒绝或只留审计，并断言无越权投递/写入/提交；同 key 同内容返回原身份。`waiting_children` 永不因问答获得写权；parentless replay ask 具名拒绝且零副作用，replay 中真实 Task 父子为正例。
- **A4-3**：分别在 Task 意图已持久未投递、目标入箱未 flush、入箱已 flush、claim 后未请求模型四点终止重开；重试保持原 question/answer 和各自 messageId、一次领域效果，未被模型看见的内容恢复后仍可呈现。覆盖 `active` 与 `waiting_children`，普通与适用的 replay 路径。
- **A4-4**：父离线恢复、根截止取消、正文来源不可读具名失败；伪造或其他 Session 的正文引用在领域意图落库前拒绝。未答项取消、迟到答案不复活 Run。正文只存在发送 Session，消息来源不伪装 human，不新增 Graph 边；旧空 question-id 字段可读，新事件不写它们。
- **A4-5**：沿本票触及的普通、replay、取消/恢复调用链确认 Run 结算由同一所有者执行；`task-runtime/src/index.ts` 只配置/持有 handle/装配，不保留另一份同名结算逻辑或空转发。只收敛本票触及的职责，不以拆完所有大文件或降到 400 行以下为验收。

整票集成后按[公共执行合同](README.md#必跑检查)依次完成 build、unit、integration、verify-persistence、`agent-singularity` 类型检查和 diff 检查；构建与读取构建产物的测试不要并行。若增加持久事件，同批按[persistence 规则](../persistence-changes/README.md)记录旧数据可读性和回滚限制。记录每项验收对应的入口、测试、结果与未覆盖范围；不以测试数量代替结论。不调用付费模型、不推送或部署。

完成后更新[主 guide](../singularity-harness-guide.md)的当前事实、[唯一计划](../2026-09-20-vrtc-code-change-plan.md)第 11 项状态及受影响合同，保存一份 `docs/history/` 交付记录。只提交本票改动和外层子模块指针，报告提交号、独立复核与已知限制后**停在进度审核**；交付方最多填“待验收”，由后续审核决定“已验收”。未满足任一 A4-1～A4-5 时保持返工，不改弱合同，也不提前开 S4-E。
