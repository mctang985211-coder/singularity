# 第 12 项 S4-E 定点返工最终复审（2026-09-26）

**结论：已验收，可派第 13 项 A5 + S2-E。** 被审提交 Singularity `52b74e8`、外层 `f067b05b28`，对照返工前 `39a472d`；交付记录为[定点返工交付](2026-09-26-s4-e-final-closure-rework-record.md)。用户给出的 `/home/ROXY/code/bb_work/docs/history/...` 不存在，实际文件位于本目录。复审中的小幅修正与本记录同批提交，未改写实现者交付记录。

## Standards

返工已删除旧 mutation/config 消费、旧生命周期及不可执行状态分支；账本写入和加载使用同一版本闸，保留 evolution 唯一行为所有者。复审发现并已修正两处实际误导或多余复杂度：

1. `evolution_prepare` 缺生产 Skill 的拒绝会把“先创建生产 Skill 再提替换案”交给模型，违背本阶段只替换现有 Skill、人只审核改进的规则。现在只说明目标不存在、本路径不能评估或晋升；工具层测试检查真实返回。
2. 单一 `replayTask` 入口的 options 闭集检查原被提成专用 helper，并带旧时限特判文案。复审内联为入口拒绝未知键；已不可达的 apply/list 空候选提示同步删除，没有新兼容层。

另发现 `materialize` 把生产快照 Buffer 转 UTF-8 字符串再写，遇非 UTF-8 字节会与同次读取的基线摘要不一致，破坏逐字节回滚承诺。改为直接写原 Buffer，新增原始字节快照测试。此缺陷早于本轮返工，但正处于本票的 Skill 基线链，随复审关闭。

## Spec

上一轮[独立审核](2026-09-26-s4-e-final-closure-review.md)的七条反例均由真实公开入口关闭：实验 start/sample 在写前拒绝旧版或无版本（含重复 identity）；fold 拒绝旧 candidate/prepared/decided 形状；candidate 必有 Skill mutation；prepare 缺生产文件零账本/沙盒写；非 Skill 建议不再提示 candidate；底层 replay 旧 options 写前拒绝。合法 Skill 双侧实验、人审、apply、rollback 与当前账重开正例保留。当前 Scope 只允许已有单文件 SKILL.md 替换；其他提议仅记录，A6 才扩 capability 执行。

返工交付中的“七条已闭合”属实，但其 prepare 拒绝文本仍留下一个模型可见错误行动指令；上述复审修正和工具断言后，EVAL-1～EVAL-5 的当前合同无剩余确定违约。真实模型效果或跨重启实验 driver 不属于 S4-E 的验收声明。

## 验证

- 被审版复跑：全量 unit 57 文件、1719 条通过；全量 integration 54 文件、407 条通过。复审前还定向复跑 unit 176、integration 21 条通过。
- 复审修正后：`pnpm build`、全量 unit 57 文件、1720 条、全量 integration 54 文件、407 条、`verify-persistence`、`agent-singularity` 的 `tsc --noEmit`、`git diff --check` 均通过。
- 最初两次 integration 重跑异常缓慢后主动终止；第三次完成 406/407，唯一失败在未改动的 A4 三层冷恢复测试：子任务可能已提交，测试仍要求父节点处于 `waiting_children`。单项可复现。测试现于检查该相位前暂缓子任务提交，再放行并检查消息送达和最终结算；同一全量命令重跑 407/407 通过。此修正只控制测试时序，没有修改 A4 运行时代码。

Evolution 真实旧账仍是 v1，未部署或改写；切换时继续执行[持久化说明](../persistence-changes/2026-09-26-s4-e-experiment-ledger.md)的核对、原字节归档和空 v2 账启动步骤。第 13 项的唯一派发入口为[当前 prompt](../execution-prompts/13-a5-s2-e-diagnosis.md)。
