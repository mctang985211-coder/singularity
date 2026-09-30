# 第 11 项 A4 定向返工：非根冷恢复与故障闭环

现行变更（2026-10-01）：[计划 G 节](../2026-09-20-vrtc-code-change-plan.md#g-原图续跑与角色装配)覆盖本票早期的 Agent 截止、reviewer watchdog 和按问答来源恢复的限制；当前无 Agent 总时长上限，业务 worker 按持久相位恢复原身份。原交付证据仍作历史事实。

你是 A4 返工实现主代理。工作区为 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层为 `/home/ROXY/code/bb_work/harness`。只完成当前第 11 项；重验后停在进度审核，不开始 S4-E。先读[公共执行合同](README.md)、[计划 F.1](../2026-09-20-vrtc-code-change-plan.md#f1-a4有持久来源的直属父子问答)、[A4 原 prompt](11-a4-parent-child-clarification.md)与[进度审核](../history/2026-09-25-a4-progress-review.md)。确认实际 HEAD、工作树与适用 AGENTS.md；修改前记录并保存 Git 基线。

## 要修的可达断点

当前恢复只保留问答等待的非根 Run 和 gate，没有把它的 Session 恢复为 live Agent。父回答时投递 `unavailable`，子无法读答案；三层非根父也不能收孙的问题。F.1 已要求同一 Session/Run 续跑，不能把它划给 S2-R 或新增替代节点。四崩溃点现有证据主要来自手工 intent 的投递层测试，尚未证明真实 Task/Run 的普通、replay、回答侧闭环。

## 实施顺序与所有权

1. **agent-runtime：受控非根恢复。** 在唯一 AgentHandle 所有者内复用 DSH `agents.resume`，从已发布 graph 成员、持久 Session preset/grant/Run 绑定恢复原 Session，重装该角色实际工具面、prompt、原权限和 raw-session guard。不得新建第二 roster、mailbox 或 Agent。不存在/冲突/不可安全接管的来源具名失败，不能用新 Session 替代。此子目标只交付窄恢复入口和定向测试。
2. **task-runtime：按事实接线。** 显式 `adoptRoot`/`reconcileStore` 与 batch adoption 对已知问答等待的 active worker、适用的 waiting_children 非根父，在恢复屏障内先对账原有受管理写入/进程、恢复同一 Session，再按持久问答重建 gate 与补投；模型首个请求前闸与上下文必须就绪。原 wallTime/根截止继续计时，过期取消、迟到答案不复活；无法安全接管具名失败，不留永远 running 的死等 Run。无问答在途仍按旧 A3 恢复规则处理。只处理本票已知问答路径，不泛化为所有 worker 热恢复或 S2-R 的新 Run 恢复。
3. **恢复与结算复核。** 对照原 A4-5 检查本票触及的取消、恢复与 replay 结算链。`releaseAskingSessions` 缺 index 静默返回、投递对账缺报告静默遗漏是审查发现的可疑路径；先判定当前持久 store 和生产调用方能否触发。可触发则以最小反例修复，无法触发则记录依据，不为防御手工畸形对象扩展本票。结算钩子和直接重算若有可达重复副作用再收敛；不借机拆完大文件或新增转发层。

依接口串行交接。若使用子代理，每人一次只领上述一个所有者/风险组，主代理负责实际接线、整票验收和文档；不要将“跨包恢复 + 全套测试 + guide”整包转派。所有人不得回退他人改动。

## 完成闸

- **冷恢复真实闭环**：用真实 Task store、DSH Session/inbox、agent-runtime、runtime gate 与 shipped 问答工具（仅模型输出可 scripted）构造至少一条子→等待父→子、三层孙→非根父→根→非根父→孙的跨进程路径；重启后每个保留的 Run/Session 身份不变，问题和答案进入实际模型请求，解除对应 block 后子能提交，父批次能结束。离线、过期、恢复来源损坏、无问答在途均有相反断言；不以直接手动取消子节点代替成功续跑。
- **A4-3 组合故障**：从真实 `QuestionAsked`/`QuestionAnswered` 与 JSONL Session 落盘边界注入“意图后未投递、入箱未 flush、入箱已 flush、claim 后未请求模型”四点；测试集合覆盖 `active`/`waiting_children` 及普通/有真实 Task 父子的 replay 适用路径，答案侧至少有跨重启补投与下一请求可见的集成正例。按实际不同的状态转移选最小组合，不要求四点 × 两相位 × 两模式的笛卡尔积；共享路径用调用链和代表例证明，差异路径加对应反例。每例断言同一 question/answer/messageId、一次领域效果、无重复入箱、阻塞/主相位正确。生产调用链不可达的组合记录入口及排除依据，不以手工 intent 例冒充闭环覆盖。
- **整票重验**：A4-1～A4-5 原完成闸仍有效；新行为先有失败反例，再修复。运行公共合同的 build、unit、integration、verify-persistence、`agent-singularity` 类型检查与 diff 检查，串行构建和读取产物的测试。只报告真实通过范围；不得因现有 19 例通过而跳过新反例。无需付费模型、推送或部署。

更新主 guide、唯一计划第 11 项和一份历史返工交付记录，说明正常/拒绝/取消/重启/replay 的结果、持久兼容性与已知边界；提交 Singularity 与外层对应子模块指针，**状态最高写“待验收”**。未达到任一原完成闸就保持返工，停在进度审核。
