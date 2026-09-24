# Singularity 文档入口

## 当前工作

| 用途 | 唯一入口 |
|---|---|
| 方向、当前事实与缺口 | [主 guide](singularity-harness-guide.md) |
| 进度、派发顺序与冻结合同 | [建设计划](2026-09-20-vrtc-code-change-plan.md)文首唯一表与 D/E/F |
| 已验收票据、失败轨迹 | [历史执行记录](history/2026-09-24-vrtc-execution-records.md) |
| 审核进度并准备下一票 | [进度审核指挥 prompt](execution-prompts/progress-review-and-dispatch.md) |
| 实施当前任务 | [派发入口](execution-prompts/README.md)中的当前派发 |
| 填写后续单票 | [任务模板与 A2+A1 示例](execution-prompts/task-dispatch-template.md) |
| 修改与检查纪律 | [公共执行合同](execution-prompts/README.md) |
| 大模块归属与随票迁移 | [主 guide §1.5](singularity-harness-guide.md#15-既有大模块的处理原则2026-09-24)及[建设计划 E 节](2026-09-20-vrtc-code-change-plan.md) |

专项设计通过主 guide 按需读取，不要求每票通读全部 docs。设计、原始审查和历史完成记录不能替代当前代码事实；当前进度不在本页复制维护。
职责整理随触及它的功能票完成并验收；400 行仅触发检查，不另立全仓整理前置或按行数评分。

## 历史与兼容资料

`history/` 保存旧设计、交付证据和实施细节；其中的“当前”“下一项”均指记录当时，不能直接派发。`persistence-changes/` 与 `persistence-schema.json` 保留兼容链及检查输入。P1–P4 原始 prompt 保留稳定路径供回归；当前建设不从它们重新启动。
