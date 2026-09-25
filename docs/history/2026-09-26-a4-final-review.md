# A4 收尾返工最终审核（2026-09-26）

| 项 | 结论 |
|---|---|
| 审核对象 | Singularity `97abf30..18c9eba`，实现提交 `d7c0c50`；外层指针 `1317b78b78` |
| 裁决 | **A4-1～A4-5 已验收**；第 12 项 S4-E 可派发 |
| 本轮实跑 | `pnpm vitest run --project integration packages/singularity/tests/integration/a4-question-cold-recovery.spec.ts packages/singularity/tests/integration/a4-worker-resume.spec.ts packages/singularity/tests/integration/a3-recovery.spec.ts packages/singularity/tests/integration/cancellation-gate.spec.ts`：4 文件、43 例通过；全量 build、unit 1689、integration 364、持久化检查及类型检查引用[交付方实跑记录](2026-09-26-a4-barrier-wake-record.md)，本轮未重复执行 |

原阻断是屏障仍 `recovering` 时投递或 notice 唤醒模型，令首笔合法业务工具被恢复门拒绝且没有后续唤醒。现在 `reconcileStore` 把恢复期问答补投登记到同一屏障，`adoptRoot` 在恢复遍、gate 初始化及 `ready` 后才发出 notice 和补投，再释放 driver。六个新增真实 Task/Session 集成例不在模型调用前等待 `adoptRoot`，覆盖 question、pending inbox、answer、屏障失败、取消和根激活；旧代码上红、新代码上绿的记录见交付记录。普通直接 `reconcileStore` 的报告与投递仍保持原入口。

审批渠道的 `requestProposalReview` 是独立的人审写入口；其异步决定在 `recovering` 时会被具名拒绝并保留 `pending_review`，下次显式激活可重新发问。它没有唤醒 A4 的问答 Agent，也不是本票承诺的自动审批重试。`ready` 之后开始的普通取消与在途消息投递可并发；本轮 A4 屏障验收针对**尚未开始的延迟唤醒**，不能将其写成任意并发取消后的零消息保证。业务闸仍负责取消后的写入拒绝。若后续出现可达的越权写入或丢失持久意图，按对应当前合同返工，不预建额外消息事务。

标准与范围：本轮未发现新增第二 mailbox、持久唤醒账或无消费者包装；通信仍由 agent-runtime/DSH 承担，Task 留问答身份，runtime 管阻塞、结算与恢复。A4-5 继续依据既有调用链和前两轮审核的结算证据，本次变更没有增加另一结算所有者。未运行付费模型，不据此声称问答语义正确或 S4-E 已完成。

下一票按[第 12 项 prompt](../execution-prompts/12-s4-e-skill-evaluation.md)执行；其 EVAL-1～EVAL-5 全部在本票内闭合，A5/A6 不承担 S4-E 的迁移、双侧 Run、证据闸或旧 ledger 回滚缺口。
