# 第 13 项 A5 + S2-E：从失败 Review 启动诊断并交接来源

你是本票实现主代理。工作区 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层 `/home/ROXY/code/bb_work/harness`。前置是[第 12 项最终审核](../history/2026-09-26-s4-e-final-closure-rework-review.md)通过；先核对实际 HEAD、工作树及[公共执行合同](README.md)，修改前保存 Git 基线。只读[唯一计划 F.3](../2026-09-20-vrtc-code-change-plan.md)、主 guide 的当前状态/§1.4–1.5，以及本票所需源码。不要把 A6 的候选执行或原图恢复提前并入。

## 本票交付

一个真实的失败 Review 成为唯一诊断源：失败与缺口事实先持久化，reviewer 在终态提交之后异步、可去重地启动；它从 context/DSH 取证，留下关联该源的 Diagnosis，供查询看到 pending 交接。模型决定如何调查和建议；框架不预设根因分类、补丁目录或修复策略。未启用 A6 时不发出可执行候选命令。

所有者固定：`task-runtime` 是基础 Review 派生与唯一终态写入者；既有 Task 记录持有 Review、Gap、Obligation、Diagnosis 事实；`agent-singularity/review` 负责事后扫描、reviewer 协调和交接读包；context 负责授权读取；Session 历史和指标直接使用 DSH。runtime 的原 Run 结算不得等待、反向依赖或伪装成 reviewer 成功。

## 施工顺序与完成闸

1. **源与 ledger。** 以 `ReviewRecord.outcome=failed` 为唯一自动源，包括无 Run 的 blocked Task 失败 Review；键为 `(rootStoreId, taskId, runId 或 no-run)`。终态提交后及 graph 显式激活后扫描。先复用现有 reviewer ledger，再补最小 claim/completion/interrupted 事实：单 writer 下按 store 串行检查源和预算，先持久 claim 与预分配 sessionId，后 spawn；手动与自动共用预算和绑定规则。无资格、预算不足记录可查询的 suppressed 原因，不造假 Run，不自动重铸 reviewer。
2. **实际首请求与授权。** 复用 A2 的 `beforePrompt` 委派确认，让 reviewer 首个请求取得指定 Review 源身份，并经 context 读取同 graph 的 Task、兄弟、Evidence、Session 引用；跨 graph 具名拒绝。通用 Session 事实直接读 DSH。旧 started 行按原规则计预算，恢复只续同一 session 或记 interrupted。
3. **Diagnosis 与交接。** reviewer 可保存有源引用的 Diagnosis；未知原因允许如实保存未知。`targetType` 为非空开放字符串，旧记录可读；但 `evolution_propose.fromDiagnosis` 仍在执行转换入口拒绝不支持的目标，Evolution ledger 零写。查询能看到 suppressed、interrupted、pending 及来源，不为 pending 新建执行器。
4. **组合验收后才填待验收。** 串行交接共享 ledger/绑定接口；每个子目标只处理一个接口及其定向测试。主代理集成真实调用链、公共检查、文档和提交。不得因内部一段成功先标整组完成。

验收严格按计划 **REV-1～REV-5**：模型零响应时失败 Review/Gap 可读；重复手动/自动、重启只一个 claim/session 且预算明确；第一请求确实收到源身份，跨 graph 拒绝；在 claim、spawn、Diagnosis 写前后注入崩溃不重副作用；reviewer 失败或未装配不影响原 Run 结算；未知 targetType 可重开读回而不获执行权限；DSH 观测无第二次全日志扫描或第二份终态写入。使用脚本化 Agent/模型端验证首请求和恢复；不默认调用付费模型。

本票只复用现有包与 ledger，不新增 review 包、incident、分类器、通用 Session 观测模块、策略 DSL、跨进程事务平台或兼容层。触及 400 行以上文件时先删重复职责和旧消费者；不要为降行数造转发层。只有两个实际消费者需要相同领域提取时才抽窄只读函数。当前合同的拒绝/取消/恢复行为必须同票完成，不能列作 A6 的“已知边界”。

完成后更新主 guide、唯一计划及必要的持久化说明，保留具体正反例、崩溃点、模型首请求和未覆盖项；提交 Singularity 与外层仅该子模块指针。最高填**待验收**，停止等待独立进度审核；不推送、不部署、不运行 BB 仿真。
