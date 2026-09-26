# 第 12 项 S4-E 收尾返工：截止、成本闸、裁判与旧账

你是本票实现主代理。工作区 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层 `/home/ROXY/code/bb_work/harness`。被审 Singularity `7c8af54`、外层 `c33cc63336`；核实实际 HEAD，修改前按[公共合同](README.md)保存 Git 基线。本次只关闭[返工复审](../history/2026-09-26-s4-e-rework-review.md)的四处缺口，重验原 [Q1～Q4](12-s4-e-review-rework.md) 与[计划 F.2 的 EVAL-1～EVAL-5](../2026-09-20-vrtc-code-change-plan.md)，停在进度审核。前置未通过前不实施 A5/A6。

主代理只读主 guide 当前态与 §5.17、计划 F.2、上述复审和公共合同。延续已有 evolution 作为实验/晋升/账本所有者、runtime 作为执行所有者、verifier 作为裁判派发所有者；复用现有 Run 截止和 DSH 模型绑定。不要建第二时钟、第二账本、通用兼容平台或新的调度器。Q2/Q4 的已通过行为保持，不重做。

## 必须关闭的反例

1. **Q1 绝对截止。** `experiment_started.at + frozen.budget.wallTimeMs` 是整个实验唯一截止瞬时。复制、precheck、排队、replay 准入和子执行不能重新起算；截止后不得启动下一 Run/worker，截止时在途执行按现有取消路径落具名终态并保存已耗成本。用可控慢复制/准备或已过期的 ledger 截止复现当前错误，断言未派发且账本/Run 状态正确；合法未过期正例仍运行。沿现有 deadline 传递窄化接口，运行时在最终派发点核对剩余量。不能仅在晋升时拒超时，也不能只在复制后重算而放过 runtime precheck 延迟。
2. **Q1 gate 成本。** `gate`、`decide(PROMOTE)`、`apply` 从同一真实实验/Run 证据核对已声明的 token、wallTime 指标完整且整个实验未超上限；任何一处拒绝前零该步落账/生产改写。保留现有人审次数，不以 gate 的六个答案替代机器判据。将已有 `maxTokens=1`、四侧各 15 tokens 测试改为 **gate 即拒绝**，同时覆盖仅 toolCalls、时间缺报、恰等上限与合法正例；直接服务入口和工具入口一致。不复制三份成本算法。
3. **Q3 无 ref 裁判。** 对没有 `verifierRef` 的判据，运行前通过 verifier 的真实 mode 派发规则确定本次裁判身份/版本，或在无法固定时于首次 Run 前具名拒绝；不能等运行后从当前 registry 补填。冻结前 `@1`、首次 Run 前换 `@2` 的实际 Review/晋升反例必须拒绝且生产文件不变；固定裁判的无漂移正例与显式 ref 正例保持。只加窄的只读解析入口，不在 evolution 复制派发规则；该问题不要求认证同版本不同代码。
4. **EVAL-4 旧实验账。** 使用返工前 `e98bed1` 真实服务写入合法 `experiment_started`（字符串 model、比较器 `@1`、旧样本形状），当前版本重开后须可读取同账提案并回滚其中旧 applied 对象。旧实验不得作为新版 PROMOTE 证据；新写账仍用当前严格形状。不以只含更早生命周期记录的 21 行夹具代替。旧格式识别只在读取层处理实际旧形状，维持 append-only、digest 与现有账本语义；不要迁移或覆写旧行，也不要让损坏账静默通过。

## 施工与完成闸

先按上面四项列“入口→所有者→测试反例/正例”，每个子代理一次只领一个有界落点；共享 `experiment/promotion/evolution` 先交接接口再串行修改，主代理负责整票集成、旧版交叉回归、文档和提交。其他 agent 与你共享工作区，不回退他人改动。临时反例在被审基线上确认红，修复后入库；仅旧账夹具需要用旧版写入，入库测试可保存实际字节夹具及生成依据。四项任一失败即返工，不能改成边界、只留后续票或让测试接受错误结果。

按公共合同完整运行 build、unit、integration、persistence、类型与 diff 检查，并保留原真实双侧工具→Run/verifier→gate→两次人审→apply→rollback 正例。对 EVAL-1～EVAL-5 分别报告可达入口、实跑证据、取消/重启、旧账与行为所有者；无需付费模型。同步主 guide、唯一计划第 12 项、持久化说明及一份收尾记录；旧失败历史不改写。提交 Singularity 改动及外层仅该子模块指针，最高填待验收，停下等待独立进度审核。不推送或部署。
