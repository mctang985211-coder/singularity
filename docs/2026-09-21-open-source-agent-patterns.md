# 开源 Agent 框架模式研究：上下文、协作与有证据的演进

调研日期：2026-09-21。本文是架构决策的外部证据，不是 Singularity 已实现能力的清单。来源均为项目官方文档或源码，已通过 HTTPS 实际获取；没有运行这些项目，也没有验证其与 DSH 的集成。文中的“建议”是结合 Singularity 目标作出的设计判断，不应作为来源原文或上游能力承诺引用。

## 1. 研究结论

可以借鉴成熟项目的局部机制，但没有证据支持另起一套 Agent runtime。Singularity 应继续由既有 DSH 执行 Agent、由自身 Task/Graph/Verifier/Evolution 维持领域事实，只补齐这几处协议：

1. **显式传递全局目标与局部义务，按引用读取证据**。子节点需要可追溯的任务上下文，不需要默认复制所有祖先聊天。
2. **把向父节点提问作为持久化的请求与回复**。不能让父节点同步等待子节点结束，同时要求同一父节点执行槽回答子节点。
3. **运行历史与模型当前看到的上下文分开**。摘要可以压缩，原始事件及其引用应保留，供 supervisor 检查因果链和失败证据。
4. **优化候选必须通过外部可执行评价**。反思文本只是候选生成输入；训练轨迹、选优验证集与最终盲测不能混为一谈。
5. **发现任务与取得执行权是两个动作**。目录、系统提示词和模型选择不能替代机器准入、依赖检查及唯一领取。

以下分别列明来源事实、可借鉴部分及不能直接移植的部分。

## 2. LangGraph：明确状态边界，恢复时考虑重放

### 已核实的来源事实

- 子图可以使用与父图不同的状态 schema，由包装节点显式映射输入和输出；官方说明这适合每个 agent 保留私有消息历史的场景。另一种方式是父子共享部分状态键，子图仍可保留私有键。[L1]
- 子图的 per-invocation 模式每次调用从新的状态开始，但可继承父图 checkpointer 支持调用期间的中断与恢复；per-thread 模式跨调用积累状态。文档明确警告，同一 per-thread 子图并行调用可能写入相同 namespace 并产生 checkpoint 冲突。[L1]
- `interrupt` 需要 checkpointer 和 thread ID；恢复时节点从头执行，节点中断之前的代码会再次运行。官方要求中断前的副作用具有幂等性，并说明多个中断可按各自 ID 提供恢复值。[L2]
- checkpointer 保存线程内图状态，store 保存应用定义的跨线程数据；内存 checkpointer 不具备进程重启后的持久性。[L3]

### 对 Singularity 的建议

上下文继承应是一个明确的投影：根目标及版本、硬约束、父验收中分配给子节点的义务、子契约、输入证据引用、相关兄弟任务摘要、资源与权限边界。节点私有推理和完整聊天继续留在自己的运行历史。改变上下文投影需要留下版本或事件记录，不能靠重新拼一段自然语言就悄悄改变任务。

“继承全局观”与“共享可写状态”要分开。子节点读到父目标不代表有权修改父目标；看到同级任务不代表可以执行或改写它。父子合并返回的应是结构化产物与证据，而不是把整段子聊天当成父状态事实。

提问、审批、恢复、派发均要预期重复投递与重放。可以借鉴 stable request ID 与恢复值配对的方式，但应使用 DSH 和 Singularity 的现有持久化边界，不引入 LangGraph checkpoint 数据库作为第二事实源。

### 不能从来源推出的结论

LangGraph 提供图运行与恢复机制，不会自动证明子任务覆盖父目标，也不会替 Singularity 决定谁有权回答问题。其同名 graph、thread、node 与本项目领域对象不能直接等同。

## 3. AutoGen：类型化通信与显式终止条件

### 已核实的来源事实

- AutoGen Core 把消息定义为可序列化数据，通过 `RoutedAgent` 按消息类型和条件路由。[A2]
- direct messaging 可以作为 request/response：等待发送方法会获得接收方 handler 的返回值，接收方异常也可传播回发送方。broadcast 是单向发布，订阅方返回值会被丢弃，因此不能把广播 handler 的返回值当成回复。[A2]
- AgentChat 的终止条件读取新增消息，可组合 AND/OR；内置条件包括消息数、token、超时、handoff、外部停止等。终止条件有状态并在一次 run 结束后重置。[A3]
- 本次读取的官方 README 明确标记 **maintenance mode**：不再添加新功能，后续由社区维护，并建议新用户考虑 Microsoft Agent Framework。本文未继续审计后者，不能将 README 的推荐当作其已适配本项目的证据。[A1]

### 对 Singularity 的建议

父子澄清应有明确的 `question`、`answer`、`cancel` 等消息类型，并用 request ID、发送方、接收方、任务及契约版本关联。聊天文本可以承载解释，状态转换不能只依赖检测“已完成”“请继续”等词句。

自由探索还要有明确终止条件：预算耗尽、连续无进展、任务取消、目标已验证。这些是运行边界；“agent 说完成”仍不能代替 Task 的 verifier 验收。

### 不直接移植的部分

AutoGen 的 direct messaging 示例证明请求与回复的 API 语义，**不证明**父节点等待子任务时，再由子节点回问父节点一定无死锁。Singularity 必须根据 DSH 的 activation、事件投递与执行锁设计可让出执行槽的协作协议，单独验收父等子、子问父、重启与迟到回复。

现阶段借鉴类型化消息和终止机制即可；增加 AutoGen runtime 会引入另一套调度、状态和生命周期，而且该项目已有维护模式提示。

## 4. OpenHands：上下文视图不覆盖原始事件；阻塞委托有边界

### 已核实的来源事实

- SDK 的 context condenser 文档将 conversation 定义为 append-only event log。压缩用特殊 `Condensation` 事件描述，通过 `View` 生成当前模型可见消息，而不是删除历史事件。[O1]
- 文档描述的常规压缩会把较早的一部分事件替换为摘要，保留较新的上下文；还区分软触发与必须处理上下文溢出的硬触发。[O1]
- 本次版本的 `DelegateExecutor` 为子 agent 创建独立 `LocalConversation`，复用工作目录，默认继承父确认策略，并在父持久化目录下保存子 conversation。执行 task 时向子 conversation 发送任务文本，然后收集最终响应。[O2]
- 同一实现明确使用 blocking delegation：为子任务启动线程，随后 `thread.join()` 等待所有线程结束。该代码路径没有实现“父 agent 在等待期间继续处理子节点澄清”的通用协议。[O2]

### 对 Singularity 的建议

上下文压缩应影响模型输入投影，不影响 supervisor 能否定位原始 tool call、结果、异常、verifier evidence 和决策。摘要中的结论需要能回到事件或产物引用。不能只给 supervisor 一个“任务失败”的总结，然后要求它沿 graph 可靠定位根因。

父子身份、运行 ID、task ID、事件序号和产物摘要是跨节点诊断的最低索引。跨节点时间顺序本身不能证明因果，应通过发起请求、消费产物、依赖和派发关系追踪。

子会话独立、产物显式返回、资源边界随任务配置，这些原则可以借鉴。共享工作目录只是这份实现的事实，不是 Singularity 必须采用的策略；候选修复仍应服从自身 sandbox 和审批边界。

### 不直接移植的部分

不要把阻塞 `delegate` 包装成父子双向协作协议。线程并行不能自动解决父 agent 逻辑等待的问题，也不能证明任务恢复幂等。OpenHands 的事件与压缩实现可作为参考，但不能替换 DSH 已有 session/event 机制。

## 5. SWE-agent / mini-SWE-agent：让探索循环保持简单

### 已核实的来源事实

- SWE-agent 官方 README 明确说明当前主要开发投入已转到 mini-SWE-agent，并推荐后续使用较简单的 mini-SWE-agent。[S1]
- mini-SWE-agent 的 `DefaultAgent` 将 system template 和 instance template 分离；每步执行 model query，再执行环境 actions，把 observations 加入 messages。[S2]
- 同一实现检查 step、cost、wall-time 等运行限制；每轮的 `finally` 都调用保存方法。序列化包含消息、配置、模型调用和成本、退出状态、submission 及 trajectory format。[S2]

### 对 Singularity 的建议

节点本地探索可以继续采用简单的“观察 → 选择工具 → 执行 → 观察”循环。结构化任务、验收、预算、协作中断应由外围协议提供，不必把每一种探索策略固化为一张 workflow。

system prompt 主要说明稳定的角色与边界；本次 task、运行态、可用目录以及证据应通过结构化上下文和工具注入。系统提示词不能硬编码一个迟早过期的完整 task 列表。

### 不直接移植的部分

单 agent 的轨迹保存不是多 agent 的事务或恢复方案；上述源码也不提供 graph task discovery、唯一领取或父目标覆盖证明。保持循环简单不等于省略这些领域约束。

## 6. GEPA：轨迹驱动的候选生成，评价驱动的选择

### 已核实的来源事实

- `GEPAAdapter` 将集成点拆为 `evaluate` 与 `make_reflective_dataset`。前者返回每个样本的输出、分数和可选轨迹；后者按待优化组件提取反思数据。轨迹对优化引擎是不透明数据，解释轨迹仍由 adapter 负责。[G1]
- adapter 契约要求输出、分数与输入样本数量一致；capture traces 时轨迹也逐样本对应。组件候选不能原地修改。[G1]
- `optimize` 接受 `trainset`、`valset`、候选及预算/停止条件；源码会在 `valset=None` 时使用训练集 loader 作为 validation loader。[G2]
- validation 分数用于候选追踪和选优，API 也允许多种选择策略。因此“有 valset 参数”不等于“有未用于选优的独立最终测试集”。[G1][G2]

### 对 Singularity 的建议

supervisor 先从真实轨迹提取“失败点、相关上下文、证据、待修改组件、预期变化”，再生成候选，而不是靠一段自评宣布需要永久修改 system prompt 或 skill。首次闭环可限制每个候选只改一个有身份的组件，以便归因和回滚。

本项目的 observed/holdout 机械不退化闸是基础，但需要进一步固定评价契约。若一个所谓 holdout 集被反复用于选优，应该明确标记它是选择验证集；用于最终独立评估的样本应与候选生成、调参和选优反馈分离。优化预算、次数与失败样本也应留档，不能只展示获胜候选。

GEPA 可作为以后离线优化 adapter 的候选依赖，前提是本项目已有稳定的候选身份、评价数据、指标和 sandbox 执行接口。本轮建议先借鉴协议，不引入新的在线调度系统，也不把 GEPA 作为“任意代码自进化已解决”的证明。

## 7. Task 发现：本次调研的证据边界与具体建议

以上来源提供状态隔离、通信、轨迹和优化机制，但本次已读取材料没有提供一个可直接移植、同时满足 Singularity TaskDefinition、TaskInstance、能力准入和 Graph 所有权的任务目录。因此下面是**本项目设计建议**，不是某个上游已经完整实现的功能：

| 查询对象 | 返回什么 | 不意味着什么 |
| --- | --- | --- |
| 当前图内任务实例 | 可见范围内的任务摘要、状态、依赖、owner 和版本 | 可见就可执行 |
| 可复用任务定义 | 定义 ID、版本、目标适用范围、输入、验收及能力需求 | 命中定义就满足当前输入 |
| 节点可用能力 | 实际可装配的 skill/tool/verifier 与约束 | 模型自称掌握某能力就可调用 |

推荐的节点协议是：先理解已分配契约和全局义务；只在需要复用或分解时查询定义；对拟执行实例使用机器预检；再由受控派发或原子领取取得执行权。目录中没有合适定义时，按 Task 契约规范生成候选，走相同机器准入与可选契约人审，不应默认转交人类代写任务。

机器预检至少应给出结构化原因：依赖证据缺失、能力缺失、版本不匹配、已被领取、权限或预算不允许。prompt 告诉 agent 遇到这些状态该采取什么动作；判断本身属于 runtime，不能放在 prompt 里靠模型猜。

## 8. 来源记录与可复核性

所有条目访问日期均为 **2026-09-21**。GitHub 主分支 SHA 通过官方 GitHub API 获取，以下固定链接对应本次取回的版本。LangGraph 同时读取在线 Markdown 文档和固定版本的文档源码；在线页面以后可能变化，应优先按固定链接复核。

| 编号 | 已实际读取的来源 | 固定版本 |
| --- | --- | --- |
| L1 | [LangGraph 子图文档源码](https://github.com/langchain-ai/docs/blob/74799b14f8fa4364843717904edb6406f6e4bcb2/src/oss/langgraph/use-subgraphs.mdx)，[在线 Markdown](https://docs.langchain.com/oss/python/langgraph/use-subgraphs.md) | docs `74799b14f8fa4364843717904edb6406f6e4bcb2` |
| L2 | [LangGraph interrupt 文档源码](https://github.com/langchain-ai/docs/blob/74799b14f8fa4364843717904edb6406f6e4bcb2/src/oss/langgraph/interrupts.mdx)，[在线 Markdown](https://docs.langchain.com/oss/python/langgraph/interrupts.md) | 同上 |
| L3 | [LangGraph persistence 文档源码](https://github.com/langchain-ai/docs/blob/74799b14f8fa4364843717904edb6406f6e4bcb2/src/oss/langgraph/persistence.mdx)，[在线 Markdown](https://docs.langchain.com/oss/python/langgraph/persistence.md) | 同上 |
| A1 | [AutoGen README](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/README.md) | `027ecf0a379bcc1d09956d46d12d44a3ad9cee14` |
| A2 | [AutoGen Message and Communication notebook](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/docs/src/user-guide/core-user-guide/framework/message-and-communication.ipynb) | 同上 |
| A3 | [AutoGen Termination notebook](https://github.com/microsoft/autogen/blob/027ecf0a379bcc1d09956d46d12d44a3ad9cee14/python/docs/src/user-guide/agentchat-user-guide/tutorial/termination.ipynb) | 同上 |
| O1 | [OpenHands condenser README](https://github.com/OpenHands/software-agent-sdk/blob/856d99d48e4b11c70c5f1cab21e7830570dbc324/openhands-sdk/openhands/sdk/context/condenser/README.md) | `856d99d48e4b11c70c5f1cab21e7830570dbc324` |
| O2 | [OpenHands DelegateExecutor](https://github.com/OpenHands/software-agent-sdk/blob/856d99d48e4b11c70c5f1cab21e7830570dbc324/openhands-tools/openhands/tools/delegate/impl.py)，[参数定义](https://github.com/OpenHands/software-agent-sdk/blob/856d99d48e4b11c70c5f1cab21e7830570dbc324/openhands-tools/openhands/tools/delegate/definition.py) | 同上 |
| S1 | [SWE-agent README](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/README.md) | `3ea751c087f32b16e039a2233dd6eefecef325d5` |
| S2 | [mini-SWE-agent DefaultAgent](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py) | `04d809ceab9df28f9adaed044884180159172930` |
| G1 | [GEPA adapter 契约](https://github.com/gepa-ai/gepa/blob/30f709de556c076cf2631cbadc3b1cc7fd25b459/src/gepa/core/adapter.py) | `30f709de556c076cf2631cbadc3b1cc7fd25b459` |
| G2 | [GEPA optimize API](https://github.com/gepa-ai/gepa/blob/30f709de556c076cf2631cbadc3b1cc7fd25b459/src/gepa/api.py) | 同上 |

此外取回了 OpenHands SDK 和 GEPA 的 README，用于确认项目范围；未将其宣传性 benchmark 数字作为本项目选择依据。没有依据未读取的论文、第三方博客或 README 中的外链推导结论。

本研究不声称这些协议单独足以保证自进化正确。实际工程仍须验证任务与候选身份、事件因果、恢复幂等、权限、评价独立性和生产晋升，相关实现步骤由本项目架构指南及建设计划统一安排。
