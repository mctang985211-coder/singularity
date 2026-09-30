# 第 13 项 A5 + S2-E：失败自动、成功按需，共用诊断链

现行变更（2026-10-01）：[计划 G 节](../2026-09-20-vrtc-code-change-plan.md#g-原图续跑与角色装配)覆盖本票早期的 Agent 截止、reviewer watchdog 和按问答来源恢复的限制；当前无 Agent 总时长上限，业务 worker 按持久相位恢复原身份。原交付证据仍作历史事实。

你是本票实现主代理。派发子代理完成以下所有工作。工作区 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层 `/home/ROXY/code/bb_work/harness`。**状态（2026-09-27）：已验收；REV-3 定向返工及最终审核见 `docs/history/2026-09-27-a5-review.md`。** 核对实际 HEAD、工作树及[公共执行合同](README.md)，修改前保存 Git 基线。只读[唯一计划 F.3](../2026-09-20-vrtc-code-change-plan.md)、主 guide 当前状态/§1.4–1.5 和相关源码。不提前并入 A6，不重做 K4。

## 本票交付

已验收行为：失败 Review 自动受理诊断；成功 Review 零自动 spawn，但 Agent 或用户可按需发起同一条复盘链。用户经已有根会话表达请求，由根 Agent 调 task_review_agent，不新建用户专用 API。reviewer 从 context/DSH 取证，保存关联指定源的 Diagnosis；允许无需改进或证据不足，不强制产出候选。含建议且 A6 未启用才显示 pending。框架不预设成功价值分类器、根因分类或修复策略。

所有者固定：`task-runtime` 是基础 Review 派生与唯一终态写入者；既有 Task 记录持有 Review、Gap、Obligation、Diagnosis 事实；`agent-singularity/review` 负责事后扫描、reviewer 协调和交接读包；context 负责授权读取；Session 历史和指标直接使用 DSH。runtime 的原 Run 结算不得等待、反向依赖或伪装成 reviewer 成功。

## 施工顺序与完成闸

1. **源与 ledger。** 落实 F.3 的 `task_review_agent({taskId,runId,reason?,requestKey?})` 精确源及默认/显式尝试规则，删除 latestReview 选源。同源默认尝试供自动/显式入口共同去重；已终结后新键可再复盘，同源在途不另起，同键改内容拒绝。在 A5 票内调整 K4 同一 store 受理串行入口：先去重，需要新启动时才读持久 started 核算额度；有额度才写来源 claim/预分配 sessionId 并 spawn，beforePrompt 核对绑定且写 started，spawn 返回后出队。claim 仅服务来源去重和恢复，不另计额度、不加缓存或预留账；等待输出在队列外，不嵌套同队列。旧 started 只沿原规则计数，不猜 run 来源。reviewer 次数额度消费 K4 验收接口（终态根会话可调用、不继承业务根 maxRuns、不重置旧计数，无总时长 watchdog），本票不重建额度机制。**K4 已验收的接口**：`agent-singularity/src/review-agent-ledger.ts` 的 `admitReviewAgent(rootStoreId, work)`（现有区内 `{started, start}`，A5 须在本票调整为先来源去重、需启动才读 started；唯一写行入口）与零写展示查询 `countReviewAgentRuns`；`task_budget_extend` 的服务侧一次调用 `TaskRuntime.extendRootBudget(sessionId, host, request)`（`host = {callId, execution}`，请求闭合字段集，`approvalRef` 为审计引用 `approval:<hostCallId>`），以及装配期装入的 `defineRootBudgetApproval`。
2. **两种触发与首请求。** 终态提交后及 graph 激活后扫描 failed Review；成功仅显式受理。computeEscalation.required 不再作为自动或显式准入，删除失去消费者的阈值判断，保留原始观测。终态根会话复盘入口（gate 协调清单）与 `task_budget_extend` 人审扩额均由 K4 交付，本票只接两种触发，不重复建设；终态复盘无生产写权限。beforePrompt 确认绑定；首请求包含指定源 outcome、关注点和引用，可通过 context 自主下钻。跨 graph/错 run/缺 Review/预算不足在 claim、spawn 前拒绝；不能只改 description 而保留服务拒绝成功的条件。
3. **Diagnosis 与交接。** 删除 pack-only 提示、强制六维和无输出自动填 unknown 的路径。judgements 按需、proposals 可空；成功观察和无需改进可正常记录，超时/解析失败只记 interrupted/具名错误。既有 observedFailure 文本槽在模型面解释为“复盘观察”，不填虚假失败、不为改名迁移全账。未知 targetType 可记录，执行转换仍拒绝不支持目标且零 ledger 写。task_review_pack 查询源与状态，context_read 读 Diagnosis；无建议结论不造 pending，不消费 A6 恢复入口。
4. **组合验收后才填待验收。** 串行交接共享 ledger/绑定接口；每个子目标只处理一个接口及其定向测试。真实调用链的集成、公共检查与组合验收都由派发的子代理完成；主代理汇总证据、同步文档并提交。不得因内部一段成功先标整组完成。

验收以 **REV-1～REV-5** 为完整列表：失败自动、成功不自动、Agent 显式、用户经终态根会话发起；业务根过期仍可在 reviewer 额度内受理，reviewer 自身耗尽必须拒绝；默认去重/新键再复盘、精确源/授权/恢复、空建议不造交接、无输出不伪造诊断。使用 scripted Agent 与真实工具，不默认付费模型。成功源不恢复、无适用比较器不晋升见 F.4；本票不扩优化评估平台。

本票只复用现有包与 ledger，不新增 review 包、incident、分类器、通用 Session 观测模块、策略 DSL、跨进程事务平台或兼容层。触及 400 行以上文件时先删重复职责和旧消费者；不要为降行数造转发层。只有两个实际消费者需要相同领域提取时才抽窄只读函数。当前合同的拒绝/取消/恢复行为必须同票完成，不能列作 A6 的“已知边界”。

完成后更新主 guide、唯一计划及必要的持久化说明，保留具体正反例、崩溃点、模型首请求和未覆盖项；提交 Singularity 与外层仅该子模块指针。最高填**待验收**，停止等待独立进度审核；不推送、不部署、不运行 BB 仿真。
