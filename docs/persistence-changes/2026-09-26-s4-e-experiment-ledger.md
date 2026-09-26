# S4-E: Evolution ledger 的双侧实验格式

kind: persistence-change

Evolution 外部账本 `proposals.jsonl` 的记录统一用 `formatVersion: 2`。写边界与加载同一判据：`load` 逐行拒绝 v1/无版本/混合；`append` 共用漏斗与 `recordExperimentStart`（在幂等成功返回之前）于持久写前对旧版本记录具名抛错，账本字节不变（[定点返工交付](../history/2026-09-26-s4-e-final-closure-rework-record.md)，`assertLedgerFormatVersion`，evolution.ts:765/1702/1730/1790）。fold 只接受当前可写形状：非 Skill 仅 proposed；candidate 必带 Skill mutation；prepared 必有 captured 基线与 skillContent/skillBaseline；decided 必有 approvalRef。不做双格式 fold、在线迁移或忽略未知行。

新格式的可执行候选只保留单文件 Skill 替换；其他改进方向仍可记录为建议，但不能进入旧候选执行链。`experiment_started` 固定样本角色和观测结果、输入快照、候选与生产基线内容身份、模型选择、可选总 `maxTokens`、裁判版本、比较器版本和 `frozenDigest`；`experiment_sample` 逐样本、侧与重复次数记录真实 task/run/review/evidence、工作区快照、结果、裁判身份和 reported/unknown 成本。Skill 实验报告为 `experiment-report.json` 的 `formatVersion: 2`；此报告版本与 ledger 版本是两个字段。旧 v1 replay 报告不能晋升，`replayed` 状态/记录不再新写，仅服务该报告的生产实现和测试删除。实验级 `wallTimeMs`/`durationMs` 不进入新账；普通 Review 的 `durationMs` 与根运行时限不受影响。当前仍在使用的 `SKILL.contract.json` v1 侧车也不受此切换影响。

旧数据处置：2026-09-26 只读盘点的外层 `harness/.dsh/evolution/proposals.jsonl` 有 21 行、2 条 `replayed`，两项曾应用的提案最终均已 `rolledback`。执行切换者须重新核对现场状态，按原字节归档旧账，然后从空的新账启动；不自动删除或改写旧文件。若出现未回滚的 applied，停止切换并由旧版本处置具体对象。旧账不保证在新代码中回滚；新格式 applied 的重开和回滚必须验收。归档是操作步骤，不是兼容 reader。

验收从公开服务和真实工具入口覆盖：旧账及混合账零新写；伪造旧版本实验记录也零新写；新账可重开、应用、回滚；非 Skill v1 replay 或带实验 `wallTimeMs` 的直调在首个持久写前拒绝；模型可见 schema/说明/成功返回不引导旧请求。`verify-persistence` 只覆盖 SessionEventMap 的四个根，不能代替此账本的专项验证。
