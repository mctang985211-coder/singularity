# 第 12 项 S4-E 简化收尾：删实验时限、拒无锚裁判

你是本票实现主代理。工作区 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层 `/home/ROXY/code/bb_work/harness`。先核对实际 HEAD，按[公共合同](README.md)保存修改前 Git 基线。读主 guide §5.17、[唯一计划 F.2](../2026-09-20-vrtc-code-change-plan.md)、[返工复审](../history/2026-09-26-s4-e-rework-review.md)。本 prompt 的新裁决覆盖历史返工 prompt 中冲突的实验级 wallTimeMs、gate 成本闸、无 ref 裁判解析和旧实验账兼容要求；其他 Q1～Q4/EVAL-1～EVAL-5 的有效行为继续验收。前置未通过前不实施 A5/A6。

## 本票只做两件事

1. **删除实验级 wallTimeMs。** S4-E 实验只接受 `maxTokens` 作为本票自己的总额上限；配置了 `rootBudget.wallTimeMs` 时，运行时现有规则仍限制 Run，未配置则不承诺实验时间上限。删除 `ExperimentBudget.wallTimeMs`、实验截止计算/传递、仅为它增加的 per-run replay 截止选项及传播、晋升中的实验时间上限判定和无消费者的 `durationMs` 字段/写入/测试。旧调用传 `wallTimeMs` 时在首个持久写前具名拒绝，不能静默忽略。不要删普通执行的根时限或扩大成通用预算重构。正例在配置根时限时证明双侧 Run 仍受它约束，负例证明传入已删除字段零实验落账、零 Run。
2. **实验要求显式且有版本的裁判。** 普通 Task/verifier 的 mode 派发语义保持；S4-E 取样冻结前若任一 AC 没有 `verifierRef`、该 ref 未注册或未声明版本，就具名拒绝且零实验落账/Run。沿已有显式 ref 冻结与 Review 核对路径，冻结 `@1` 后在首次 Run 前换成 `@2` 必须拒绝晋升。不要新增 mode→verifier 解析接口、隐式补 ref、兼容分支或“只在运行后比当前注册表”的放行路径。合法显式 ref 的双侧正例保留。

`gate` 只记录六项回答及其证据引用，允许失败/超额实验留作审计；`gated` **不表示可晋升**。不要把 `checkPromotion` 接进 gate。`decide(PROMOTE)` 与 `apply` 各自在写前调用现有检查；`maxTokens=1`、四侧各 15 tokens 或只有 toolCalls 时，PROMOTE/apply 必须拒绝且零 decided/applied/生产改写。合法修复仍可 gate→两次人审→apply→rollback。把旧测试的 gate 成功断言和状态文案统一到这个语义，不新建检查 helper。

## 格式与停止条件

本票**不兼容返工前的实验记录形状**（如字符串 model、比较器 `@1`，以及带已删除 wallTimeMs/durationMs 的当前未验收实验）：加载时直接抛错，调用者须用旧版本处理已应用对象并归档/迁移旧账后再启用新格式。不要增加旧实验格式 reader、迁移 helper、双格式 fold 或旧样本晋升资格；也不要因本票主动删除仍可用的既有生命周期路径。EVAL-4 只验收当前格式账、真实工具消费者与当前 applied 回滚，另用旧实验账证明具名失败而非静默误读。

主代理先列两项的删除清单、现有所有者/调用方、红绿反例；子代理如获委派每次只领一个窄改动，其他 agent 共享工作区，不回退他人改动。先让当前错误行为在原实现上显现，再改代码与必要测试；只在真实消费者需要时保留已有 helper，不为行数另拆模块。按公共合同完成 build、unit、integration、persistence、类型及 diff 检查；保留真实工具→双侧 Run/verifier→gate→两次人审→apply→rollback 正例，重验 Q2/Q4 与 EVAL-1～EVAL-5 的现行部分。同步主 guide、唯一计划、持久化说明和一份收尾记录，说明不兼容的数据处理方式；历史审核记录不改写。提交 Singularity 及外层仅该子模块指针，最高填待验收并停下。不调用付费模型、不推送或部署。
