# S4-E 收尾独立审核（2026-09-26）

**结论：第 12 项继续返工，不派第 13 项 A5。** 被审范围 `6657e5e...e8c0799`，外层 `882d3ffefb`；实现到 `eb2035b`，末提交仅文档。修改前工作树干净。原[收尾交付](2026-09-26-s4-e-final-closure-record.md)保留，本文覆盖其完成自评。依据是被审版本 `e8c0799` 中的收尾合同与计划 F.2；本轮没有新增评估器、恢复机制或兼容要求。当前[定点返工](../execution-prompts/12-s4-e-final-closure.md)已根据本审核重写。

## Standards

独立标准审查发现 3 项，均属于本票删除闭合；不按文件长度要求重构。

1. `evolution/src/evolution.ts:636,755,1634` 仍有非 Skill mutation 校验、无 mutation candidate→gated、允许 v2 非 Skill candidate 的 fold。`evolution/tests/unit/evolution.spec.ts:2891` 还手写 v2 capability candidate/gated 来维持旧路径；与“只保留 Skill 候选、删除旧生产状态分支”不符。无 mutation 的 Skill candidate 可成功落账，却既不能 prepare 也不能得到 gate 必需的实验。删除这些分支及仅支撑它们的测试，工具 schema 同步必填 mutation。
2. `evolution.ts:521,527,841,846,863` 保留无生产读者的 `presetRoot/configFile` 配置、属性和初始化，仅测试还消费；注释称供旧账使用，但 `load` 已拒旧账。与 guide §1.4–1.5 的实际消费者规则及果断断兼容原则不符，随票删除。
3. `evolution.ts:335,1665,1676,1704` 仍以兼容旧账为由允许 v2 decided 缺 `approvalRef`、prepared 缺 `skillContent/skillBaseline`。新写与重开应共用单一当前形状：必需身份缺失直接拒绝，不再保留前绑定/前基线时代的解释。

## Spec

独立合同审查发现前三项；主代理补核第四项。以下均已通过公开入口复现。

1. **P1：直调能写坏新账。** `evolution.ts:1834,1878` 的 `recordExperimentStart/Sample` 接收整条记录，写入校验不检查 `formatVersion`；传 `1` 仍成功追加。分别实测账本出现 `[2,1]`、`[2,2,1]`，新实例重开才被 `load` 拒绝。违反“不混写、写前拒绝”；版本约束须在实际写边界成立，包括幂等调用，不是只给 `load` 加检查。
2. **P2：prepare 仍接受无法评估的新建 Skill。** `evolution.ts:992,1587` 在生产 SKILL.md 不存在时先写 sandbox，再追加 `champion: missing` 的 prepared；工具返回提示 replay，`experiment.ts:516` 又必拒。仅支持替换已存在文件的合同应在 prepare 写前拒绝；保持对生产内容的一次读取，移除当前无消费者的 missing/删除目录回滚分支。
3. **P2：模型仍被引导发旧请求。** `tools/evolution-propose.ts:32,106` 对非 Skill 建议无条件提示 `next: evolution_candidate`；真实 capability 提议返回已复现。`evolution-list.ts:18` 还说无 mutation 可直接 gate。`evolution-apply.ts:24` 的拒绝文案新增“human edits production by hand”，也与人只审核改进的方向冲突。应按当前可执行路径写说明和成功返回，其他建议只记录。
4. **P2：底层旧参数被静默忽略。** `task-runtime/src/index.ts:4541` 删除 `ReplayTaskOptions.wallTimeMs` 后没有拒绝额外参数；真实 runtime/AgentLoop 直调带 `wallTimeMs: 1` 成功返回、spawn 1 次、Run 从 2 增为 3。违反删除全链后旧调用写前拒绝的合同。入口直接拒绝不支持的 options；不恢复旧时限，不加适配层。

## 本轮验证

- 定向 unit：7 文件、355 通过（evolution 的 ledger-version/ledger-roots/evolution/experiment-orchestrator/skill-promotion-gate；runtime 的 root-budget/orchestrate）。
- 定向 integration：5 文件、36 通过（evolution-replay-experiment、s4e-q3-freeze-binding、replay-execution-binding、replay-workspace、evolution-tools）。证明这些已有正反例未退化，不代表下列缺口通过。
- [7 条反例补丁](2026-09-26-s4-e-closure-counterexamples.patch)：6 条 unit + 1 条 integration **全部按预期为红**，原因分别为旧版本 start/sample 成功写入、非 Skill 返回错误下一步、v2 非 Skill candidate 被加载、空 mutation candidate 成功、缺生产文件 prepare 成功、旧 runtime 参数创建 Run。临时测试副本已删除，运行时代码及生产账本未修改。
- 未重跑 build/全量 suite/类型/persistence；本次已有确定反例，不重复这些检查。交付记录中的全量结果仍为执行者报告。未调用付费模型。

反例补丁只追加到被审版本既有 fixture，不引入新测试底座。复现：先在 Singularity 目录 `git apply docs/history/2026-09-26-s4-e-closure-counterexamples.patch`；再在外层运行：

```sh
pnpm vitest run --project unit packages/singularity/evolution/tests/unit/experiment.spec.ts -t 'review audit'
pnpm vitest run --project integration packages/singularity/tests/integration/replay-execution-binding.spec.ts -t 'review audit'
```

单纯复现后可 `git apply -R` 还原该补丁；实现者修复时将这些断言归入现有用例并保留。另须验证无版本/混合版本、当前账重开回滚、九工具模型可见面、保留根时限和合法 Skill 全链，不把返工变成通用防御平台。

汇总：Standards 3 项，主要问题为旧生命周期仍被 v2 fold 接受；Spec 4 项，主要问题为公开写入口可污染 v2 账本。当前唯一派发仍为[第 12 项收尾](../execution-prompts/12-s4-e-final-closure.md)，不是 A5。
