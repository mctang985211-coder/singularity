# S4-E Q1～Q4 返工复审（2026-09-26）

**裁决：第 12 项继续返工；第 13 项 A5 + S2-E 尚无前置。** 审核 `e98bed1..7c8af54`，外层被审指针 `c33cc63336`。返工保留了双侧实验、Q2 比较修正和 Q4 输入隔离，但四个可达缺口仍违反[返工合同](../execution-prompts/12-s4-e-review-rework.md)及[计划 F.2](../2026-09-20-vrtc-code-change-plan.md)。交付方的[返工记录](2026-09-26-s4-e-rework-record.md)是自评，不能替代本次验收。

## Standards：职责与兼容

**1 项阻断（EVAL-4）。** `evolution/src/evolution.ts` 加载账本时对全账调用 `foldExperiments`；`experiment.ts:1447` 再用当前 `assertFrozenExperiment` 校验。旧版合法 `experiment_started` 的字符串 model、`experiment-comparer@1` 和旧样本形状不能通过当前新证据校验，使同账的 `get`、`list`、旧 applied `rollback` 均在加载时失败。独立审查用 `e98bed1` 版写入合法旧实验记录，旧版重开成功，当前 `7c8af54` 重开报 `frozen.model must be ... structured`。现有 21 行旧账夹具没有实验记录，不能证明此合同。只需旧行可读、旧 applied 可回滚；旧实验不自动成为新版晋升证据。持久化说明中“New code reads old ledgers unchanged”当前不成立。

新增快照遍历和执行身份绑定有当前消费者，未见必须为减行数而拆出的通用层。终态仲裁存在相似代码，但本轮未取得行为分歧，不以猜测重开范围。

## Spec：返工合同

| 项 | 明确反例与影响 | 定位 |
|---|---|---|
| Q1：绝对截止 | 复制前计算 `remainingMs`，复制及 runtime precheck 后才以新 Run 开始时间重锚该时长。2500 个普通输入文件、50 ms 实验上限的只读探针中，进入 replay 已过 933 ms，仍传入 50 ms；可在实验截止后启动 Run。事后拒绝晋升不能兑现“到截止取消在途/无剩余不启动”。 | `evolution/src/experiment.ts:1294–1310`；`task-runtime/src/orchestrate.ts:2856–2857` |
| Q1：gate 成本闸 | `gate` 仅重建报告、查证据引用，不校验成本指标和总额；现有测试明确让 `maxTokens=1`、四侧各 15 tokens 的实验成功写入 `gated`，仅 `decide` 拒绝。合同要求 gate/decide/apply 各自验证。 | `evolution/src/evolution.ts:1251–1311`；`evolution/tests/unit/skill-promotion-gate.spec.ts:975–987` |
| Q3：无 ref 裁判 | 无 `verifierRef` 的判据仅冻结 mode，执行后再比当前注册表。独立审查沿真实 runtime/verifier 集成入口，冻结时 `q3-unpinned@1`，首次 Run 前换成 `@2`；四侧 Review 均由 `@2` 裁决，`checkPromotion→gate→PROMOTE→apply` 成功且生产文件改写。 | `evolution/src/experiment.ts:617–645`；`evolution/src/promotion.ts:474–497` |

Q2 历史成功样本本次同败的拒绝和正常维持样本的正例，定向 **3/3** 通过；Q4 链接物化与隔离的本轮定向集成回归也通过。本代理复跑集成 **5 文件 / 41 项**、单元 **5 文件 / 131 项**，均通过；这些绿色用例没有覆盖上述反例。本轮未重跑全量 build/测试、未运行模型。Q1/Q3 的只读临时探针及旧账复现由独立审查执行，临时文件已清理。

下一次只派[第 12 项收尾返工](../execution-prompts/12-s4-e-final-closure.md)，先使以上反例在被审版复现，再修到绿并重验 EVAL-1～EVAL-5；不将缺口移给 A5/A6，不把未实现写为“已知边界”。
