# 第 11 项 A4 收尾返工：恢复就绪后再唤醒问答 Agent

你是 A4 收尾返工的实现主代理。只修[二次进度审核](../history/2026-09-26-a4-second-progress-review.md)指出的恢复唤醒时序；重验后停在进度审核，**不开始 S4-E**。先读[公共合同](README.md)、[计划 E/F.1](../2026-09-20-vrtc-code-change-plan.md)、[A4 返工交付记录](../history/2026-09-26-a4-rework-record.md)。核对 Singularity `ee3a4bd`、外层 `3dc320d` 及实际工作树；修改前按公共合同保存基线。

## 可达反例

`adoptRoot` 的屏障仍标记 `recovering` 时，`reconcileStore` 已补投问答并可能发送唤醒 notice。收件 Agent 的第一个模型请求可立即调用 `task_answer`、`task_ask_parent` 或 `task_submit_result`，但业务入口的 `assertRecoveryReady` 此时拒绝。现有测试等待 `adoptRoot` 返回才放行工具，故未验证这条交错。不能把模型自行重试当作运行时完成保证。

## 实施边界

1. 在现有 `task-runtime` 恢复屏障内完成持久事实对账、受管理工作对账、同一 Session 恢复、gate 初始化和 driver 登记；**只在屏障 ready 后**触发可唤醒 Agent 的问答补投或 pending inbox notice。`agent-runtime/messages.ts` 继续负责 DSH 投递，Task 继续只保存意图。使用现有进程内恢复 handle/回调即可，不建第二 inbox、持久唤醒队列或通用任务调度器。
2. 同一 messageId 对账保持幂等；已在 inbox/history 的消息不重复，pending 未 claim 的消息能在 ready 后唤醒。恢复失败、取消、卸载时不得唤醒模型或放行业务写入，下一次显式激活仍能从持久意图补投。普通运行中的 `task_ask_parent`/`task_answer` 顺序和直接 `reconcileStore` 调用不得退化。
3. 只修这处时序及直接受影响的调用方、测试和文档。replay driver 实验恢复、全体 worker 热恢复、未 flush 点②的后端实现均不属于本票。

## 完成闸

- 先在现有真实 Task store、DSH Session/inbox、runtime gate、shipped 工具的 scripted 集成 fixture 中固定一个失败反例：恢复补投使父或子立即给出工具调用，**不使用 `recovered.promise` 等等待器替它等屏障**；旧代码可稳定得到 `recovering` 拒绝或不能完成。修后首笔合法调用成功，同一 Session/Run 完成问答与批次；问题、答案和模型输入可核对，零重复 messageId。
- 分别检查已 flush 未 claim 的 pending、意图已持久未投递、answer 补投；失败/取消屏障不发起模型请求且保留可重试意图。普通与 replay 中真实 Task 父子的共享投递路径用最少代表例和调用链证明，不做无意义的组合笛卡尔积。
- 重跑 A4-1～A4-5 相关回归以及公共合同中的 build、unit、integration、verify-persistence、`agent-singularity` 类型检查和 diff 检查；只报告实跑结果。同步主 guide、唯一计划第 11 项与一份历史收尾记录，说明唤醒时序和保留边界；提交 Singularity 与外层对应指针，状态最高写“待验收”。

若委派子代理，每人只领一个可独立验收的风险点，主代理负责接线和整票重验；不要为一次唤醒时序重构整个恢复框架。
