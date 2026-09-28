# 前端以外真实模型纵向验收：INCONCLUSIVE

基线：Harness `4ac2b08`，Singularity `38a4b1b`。完整原始记录和脱敏轨迹见 [`assessment.md`](/home/ROXY/code/bb_work/a6-final-vertical-2026-09-28/evidence/assessment.md) 及其同目录 `l1-run-*`。本轮只改临时快照夹具，未改生产代码、Skill 或配置。

验收目标是同一 graph/store 中由真实模型消费用户目标并调用 `task_intake`，形成失败源 Review 和 Diagnosis，自行提交候选、通过双侧验证及受控 DSH 审批，应用后调用 `task_recover`，使新根 Run 按原不可变 AC 通过。脚本化集成测试 4/4 通过，只证明接线。

三次 `step-5-preview` 网关尝试均已计入额度：第 1 次真实 `task_intake` 成功，但子任务要求尚不存在的 `a6-l1-release-row`，`task_decompose` 在准入时以 capability gap 拒绝，根 Run 保持 running，无失败 Review；第 2 次夹具路径错误，进程启动后中断，用量未知；第 3 次真实 `task_intake` 成功，但模型在等待窗口内未调用 `task_decompose`。两次完整尝试分别用时 230.58 秒和 206.01 秒；报告 token 与未配对请求见原始记录。没有 Diagnosis、候选、审批请求、应用、`task_recover` 或新根验收轨迹。

**结论**：此次案例无法通过最终纵向验收，也未证明产品代码有缺陷。A6 的分项验收仍有效，不能据此宣称前端以外已由一条真实模型链全线贯通。下一次验收须先冻结可准入、随后由独立 verifier 判失败的源任务及不变的根 AC，再运行完整链；受控审批输入须标明为夹具替身。
