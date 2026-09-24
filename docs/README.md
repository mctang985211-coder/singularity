# Singularity 文档入口

## 当前工作

| 用途 | 唯一入口 |
|---|---|
| 方向、当前事实与缺口 | [主 guide](singularity-harness-guide.md) |
| 进度、派发顺序与验收记录 | [建设计划](2026-09-20-vrtc-code-change-plan.md)文首唯一表 |
| 审核进度并准备下一票 | [进度审核指挥 prompt](execution-prompts/progress-review-and-dispatch.md) |
| 实施当前任务 | [派发入口](execution-prompts/README.md)中的当前派发 |
| 填写后续单票 | [任务模板与 A2+A1 示例](execution-prompts/task-dispatch-template.md) |
| 修改与检查纪律 | [公共执行合同](execution-prompts/README.md) |
| 大模块归属与随票迁移 | [主 guide §1.5](singularity-harness-guide.md#15-既有大模块的处理原则2026-09-24)及[建设计划 E 节](2026-09-20-vrtc-code-change-plan.md) |

专项设计通过主 guide 按需读取，不要求每票通读全部 docs。设计、原始审查和历史完成记录不能替代当前代码事实；当前进度不在本页复制维护。
职责整理随触及它的功能票完成并验收；400 行仅触发检查，不另立全仓整理前置或按行数评分。

## 保留与清理

`history/` 保存旧问卷、交付证据、审查与指南快照；其中“当前”“待建”“下一项”均指当时，不能直接派发。`persistence-changes/` 和 `persistence-schema.json` 是兼容链及检查输入，必须保留。P1–P4 原始执行合同保留稳定路径并标明已完成，便于回归与已有引用。

2026-09-23 清理前备份：Singularity `131ff54` / 外层 `5f6e702`。以下五份文档从 docs 根移到 history，内容保留，仅改历史说明与导航链接：

- [2026-09-11 架构审查](history/2026-09-11-architecture-review.md)
- [2026-09-16 初始施工计划](history/2026-09-16-task-runtime-build-plan.md)
- [2026-09-17 用户问卷](history/2026-09-17-open-questions.md)
- [2026-09-17 早期 P3/P4 交付记录](history/2026-09-17-p3-p4-completion.md)
- [2026-09-18 问卷执行记录](history/2026-09-18-questionnaire-execution.md)

删除 `2026-09-20-d1-doc-backfill.patch`：一次性旧版指南回填补丁，目标内容和行号已被后续指南取代，没有当前消费方，不应再次应用；原文件仍可从上述备份读取。2026-09-23 的 Kimi 审查保留原路径及原意见，页首注明哪些结论未采纳。历史正文中的旧路径作为当时记录保留；当前导航使用本页链接。

上述文档清理当时的检查：43 份 Markdown 的围栏、97 个本地链接、15 份 JSON 解析及 `git diff --check` 通过；5 份归档正文除历史说明/导航外与备份一致，持久化 4 根匹配。该次清理未改代码或调整代码票状态；后续补救交付复核及当前返工状态见建设计划，不由本段旧检查说明覆盖。
