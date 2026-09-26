# S4-E 进度审核（2026-09-26）

## 裁决

**第 12 项返工；不派第 13 项 A5 + S2-E。** 审核范围 `443db2b..4de0056`，外层 `cbe09ce05a`。修改文档前 Singularity 干净，外层仅有原先 `thirdparty/deepseek-harness` 未跟踪内容，未触碰。当前代码已提交，可作为返工基线。

迁移和两侧新 Run 的基本路径成立，但“记录了冻结字段”没有完整约束真实执行，晋升判据也放过了合同反例。原[交付记录](2026-09-26-s4-e-delivery-record.md)保留为交付方报告，本记录覆盖其验收自评。下一次只派[定向返工 prompt](../execution-prompts/12-s4-e-review-rework.md)。

## Standards：迁移与职责

独立子代理核对 EVAL-4/5：九个生产工具已接新 `evolution` 包，旧 `agent-singularity/src/{evolution,replay,config-edit}.ts` 与再导出删除；task/runtime 没有反向导入 evolution；旧 ledger 与旧 applied 的回滚保留。此范围未发现新增阻断，不要求重做迁移或按行数拆文件。`prepare-champion` 的原有 catch 行为不属于此次新增缺陷，未扩成返工。

## Spec：四组阻断

以下均违反原 F.2/EVAL-1～EVAL-3，不是 A5/A6 的后续能力。

| 编号 | 定位（被审版本） | 可达反例与影响 | 证据 |
|---|---|---|---|
| Q1 / 高 | `evolution/src/promotion.ts:422–433`；`experiment.ts:926–931` | 成本检查只拒 `unknown`，未把数字与上限比较；实验预算也未约束执行。`maxTokens=1`、四侧各报告 15 tokens 仍可 gate→decide→apply。仅有 toolCalls 的 reported 也不能证明 token/时间已知。超限实验能获得晋升 | 独立子代理用现有 `skill-promotion-gate.spec.ts` fixture 加临时反例，实际到达 applied |
| Q2 / 高 | `evolution/src/replay.ts:627–640` | 回归/holdout 只比较本次两侧是否更差。历史 verified 样本本次两侧都 failed 被算作 maintained，另一个目标失败修复就可晋升，违反“成功回归保持通过” | 同一临时 spec，`fixture({holdout:{baseline:'failed',candidate:'failed'}})` 实际到达 applied；observed-regression 走同一分支 |
| Q3 / 高 | `agent-singularity/src/index.ts:162–165`；`evolution/src/experiment.ts:531–590,926–931`；`task-runtime/src/index.ts:6551–6560`；`agent-runtime/src/index.ts:370`；`evolution/src/promotion.ts:394–417,544–551` | 模型只冻结默认选择的字符串，replay 未将它传到 worker；每次 spawn 重新读可变默认值。冻结 A→中途切 B→晋升前改回 A，可混用 A/B 而通过当前值检查。裁判版本也只从运行后的 Review 读取并与当前注册表比对，运行前冻结块无版本；工具/provider 配置没有完整执行绑定对照。前后相等不证明执行时相等 | 两个审查者独立源码调用链；DSH `agent-default-model.currentSelection/saveSelection` 可改设置。此项未声称已跑模型漂移集成测试 |
| Q4 / 高 | `evolution/src/experiment.ts:348–389,597–605` | 摘要对 symlink 只记录链接文本，`cp` 保留链接。source/shared 指向外部文件时 baseline 经链接改写原文件，candidate 读到改写后内容，摘要仍等于 frozen；工作区目录不同不代表输入隔离 | 本代理调用已构建 `directoryDigest` 并使用生产同形 `cp` 做临时目录反例：`sourceDigestUnchanged=true,candidateDigestMatches=true,candidateInput="baseline wrote",originalInput="baseline wrote"` |

Q1/Q2 的临时 spec 复制既有晋升夹具，分别设置上述预算/metrics 与 holdout 结果，沿现有 gate、decide、apply 服务链断言 applied；命令 `pnpm vitest run --project unit packages/singularity/evolution/tests/unit/s4e-independent-counterexamples.spec.ts -t 'independent S4-E counterexamples'`，**2 passed / 41 skipped**。这里的 pass 表示错误晋升被证实，不是合同通过。临时文件已删除；返工须把这些反例写为应拒绝的持久回归，并在当前基线取红。

复现参数沿 `skill-promotion-gate.spec.ts` 的同名 fixture/常量：Q1 使用 `budget: {maxTokens: 1}`、`metrics: {tokens: {uncachedInputTokens: 10, outputTokens: 5}}`；Q2 使用 `holdout: {baseline: 'failed', candidate: 'failed'}`。两者随后均调用 `svc.gate(PROPOSAL, gateAnswers([f.reportPath]), 'root-1')`、`svc.decide(PROPOSAL, 'PROMOTE', 'root-1', 'approval:decide')`、`svc.apply(PROPOSAL, 'root-1', 'approval:apply')`。Q1 原临时例还同时设置了 wallTimeMs；token 超限已足以证伪，不用该例替代真实时间测量的验收。

Q4 反例：`source/shared` 是指向同一临时外部文件的绝对符号链接；先摘要 source、复制 baseline、经 baseline/shared 写入，再复制 candidate 并复算两侧摘要。未调用模型、未碰生产文件，结束后清理临时目录。

## 本轮实跑与限度

- 主代理 integration：`evolution-replay-experiment`、`experiment-runner`、`replay-workspace`、`provider-promotion`、`provider-version-binding`，**5 文件 / 39 例通过**。
- 主代理 unit：`skill-promotion-gate`、`experiment-orchestrator`、`ledger-roots`，**3 文件 / 52 例通过**。
- 独立子代理：上述 Q1/Q2 反例；主代理：上述 Q4 文件系统反例。
- 交付方全量 build、unit 1762、integration 394、类型与 persistence 结果见原记录；本轮未重跑全量、未运行付费模型。现有绿色用例不能覆盖上述反例，EVAL-1～EVAL-3 不能验收；也不据定向通过宣称穷尽全部取消/并发恢复路径。

后续复审同时检查修复反例与 EVAL-1～EVAL-5 原合同、生产工具及直调服务入口。禁止把冻结身份、预算兑现或输入隔离改成声明字段，禁止将修复留给 A6。四组关闭后才考虑第 13 项。
