# A4 进度审核：返工

审核基线：Singularity `bf686f4` → `dcf3f9b`；外层指针 `92e843b638`。原[交付记录](2026-09-25-a4-delivery-record.md)保存实现者当时的声明；本记录是其后的独立审核结论。审核期间未改运行时代码。

## 结论与阻断证据

第 11 项 **返工**，不派 S4-E。进程内父子问答、Task 身份、DSH 投递和闸有代码与测试证据，但 F.1 承诺的冷恢复没有完成。

1. **问答等待的 worker 没有复活。** [计划 F.1](../2026-09-20-vrtc-code-change-plan.md#f1-a4有持久来源的直属父子问答)要求重启后恢复同一 Session/Run；[派发 prompt](../execution-prompts/11-a4-parent-child-clarification.md)要求 agent-runtime 复用 `agents.resume`、父离线恢复。`task-runtime/src/index.ts` 的 `reconcileStore` 对阻塞中的 active worker 只保留 Run 和闸，随后补投问答；`agent-runtime/src/index.ts` 的 `agents.resume` 生产入口仅恢复 root。重启后子 Session 不 live，回答投递返回 `unavailable`，子无法读取答案并提交；三层链中的非根父同理不能收问。恢复测试 `a4-question-recovery.spec.ts` 的首例只检查 child Run/闸与 root 收问，第二例直接取消 child 才让 batch 结束。交付记录称“非根父不复活”为已知限制，但这是本票已承诺的路径。
2. **A4-3 的组合故障证据不足。** `a4-question-delivery.spec.ts` 的四崩溃点以手工 `questionIntent()` 调投递层，没有 Task 意图、Run/闸或 replay；`a4-question-recovery.spec.ts` 只验证普通问答侧的部分恢复。交付记录承认 answer 侧跨重启只有单测、四窗口没有 replay 版本。F.1 和派发 prompt 要求两主相位及普通/适用 replay 路径。须用真实持久 Task/Session 把恢复结果接到模型下一请求，证明身份一次、答案可见和写闸正确；不能用投递层四例代替整条链。

其余保留项的裁定：阻塞确立前已放行的同 step 在途写仍依 A3 原写闸语义，F.1 未要求 ask 时 drain，**不阻断 A4**；`orchestrate.ts` 的 replay 异常内联终态仍在同一结算所有者内，本票要求只收敛触及路径，**不以文件内剩余处数判失败**，后续实际触及时再核对；DSH `inbox.ts` 对 pending 的 `message.id` 已去重，复用事实已在[DSH 核查](2026-09-25-dsh-reuse-audit.md)纠正。answer 跨重启与 replay 四窗口的缺口则属上文 A4-3 阻断，不能以共享 `ensure/fold` 单测替代真实恢复链。

维护性复核还发现两个可疑静默路径：`task-runtime/src/question.ts` 的 `releaseAskingSessions` 遇缺少 question index 直接返回，`reconcileQuestionDeliveries` 遇投递报告缺项会遗漏该意图。当前 Task reducer 生成的 snapshot 带 question index、生产投递对账逐项返回，因此它们不是已证明的 A4 阻断；返工时只需先核对旧数据与实际调用链，可达才加最小反例和修复。结算钩子与 `settleRunFromRuntime` 对同一 gate 有重复异步重算，尚无重复副作用证据。仅被测试消费的公开 helper 可在触及时收窄，不为减行数新增包装层。

## 本轮验证与边界

- 实跑：`pnpm vitest run --project integration packages/singularity/tests/integration/a4-question-recovery.spec.ts packages/singularity/tests/integration/a4-question-delivery.spec.ts`，**2 文件、19 例通过**。这些测试证明其断言范围内的行为，不证明离线 child 恢复。
- 对照代码、F.1、原 prompt、交付记录和测试断言完成审查。未重跑全量 build/unit/integration：已发现合同阻断，全量通过也不能关闭它。未运行付费模型。
- [A4 定向返工 prompt](../execution-prompts/11-a4-rework.md)固定修复与重验；完成后重新做进度审核，原始合同不降低。
