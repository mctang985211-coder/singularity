# A4 返工后二次进度审核：仍需收口恢复唤醒时序

审核基线：Singularity `300a6bf` → `ee3a4bd`，外层指针 `3dc320d`。第 11 项仍为**返工**；此记录裁定返工交付，不覆盖原交付和返工记录。

## 已关闭的两项原阻断

- 非根 worker 恢复：`agent-runtime/src/worker-resume.ts` 复用 DSH `agents.resume` 和原 `workerSetup`；`task-runtime/src/index.ts` 在恢复屏障中恢复已知问答等待的 active worker 和参与问答的 waiting_children 非根父。`a4-question-cold-recovery.spec.ts` 的二层、三层用例验证原 Session/Run、答案进入实际请求及批次结束；`a4-worker-resume.spec.ts` 验证工具面与权限拒绝。无问答在途仍按 A3 结算。
- 故障恢复：真实 Task/Session 测试覆盖四个投递窗口、answer 跨重启补投及 replay 树内真实父子正例。点②以删去尚未 flush 的尾部 splice 字节模拟，和 append-through 后端的边界相符；不要求运行 replay driver 自身跨重启续跑，后者属于 A6/S2-R 的实验记录与预算恢复。

## 新发现的验收阻断

`reconcileStore` 在 `adoptRoot` 恢复屏障**仍为 `recovering`** 时调用 `reconcileQuestionDeliveries` 和 `wakeUnclaimedQuestionMessages`。DSH `steer`/notice 可以立即启动收件 Agent 的模型请求；它若随即调用 `task_answer`、`task_ask_parent` 或 `task_submit_result`，业务入口的 `assertRecoveryReady` 会具名拒绝。框架没有在屏障就绪后自动重试该工具或再次唤醒这个会话。现有冷恢复闭环测试把首次工具输出停在 `adoptRoot` 返回之后（如 `a4-question-cold-recovery.spec.ts` 的 `recovered.promise`），因此绕开了这一可达交错。把“模型重试即可”列为边界不能证明 A2 的“恢复完成后才开放业务输入”和 A4 的父答子续跑承诺。

只需把**会唤醒模型的恢复投递/notice** 放在同一 store 的就绪闸之后，并使原问答身份、一次投递、gate 与取消/失败语义不变；实现方式由本票选择，不新增持久队列或通用调度器。以不等待模型的 scripted 请求注入该交错，证明第一笔合法问答工具调用不因本轮恢复被拒，且屏障失败/取消没有模型输入或业务写入。当前测试不证明此点。

其余保留边界：全体 worker 的通用热恢复属 S2-R；replay driver 自身的实验恢复属 A6/S2-R；点②的字节模拟可接受。阻塞确立前已放行的在途写仍按 A3 原规则处理。

## 验证

- 实跑 A4 定向 integration：4 文件、37 例通过；`verify-persistence`、`agent-singularity` 的 `tsc --noEmit`、`git diff --check` 通过。这些检查与交付方记录的全量通过一致，但没有覆盖上述交错。
- 未运行付费模型；未改运行时代码。下一票为[窄返工 prompt](../execution-prompts/11-a4-barrier-wake-rework.md)。通过二次验收前不派 S4-E。
