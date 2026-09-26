# 第 12 项 S4-E 返工：兑现实验条件与晋升判据

本文件只记录首次返工历史，**不得作为当前派发指令**。当前只派[第 12 项收尾](12-s4-e-final-closure.md)并遵守[计划 F.2](../2026-09-20-vrtc-code-change-plan.md)；下文旧 Evolution replay、实验时限及兼容要求均不再执行。

你是 S4-E 返工实现主代理。只关闭[进度审核 Q1～Q4](../history/2026-09-26-s4-e-progress-review.md)，重验 EVAL-1～EVAL-5 后停在进度审核；不开始 A5/A6。工作区 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层 `/home/ROXY/code/bb_work/harness`。被审实现 `4de0056`，外层 `cbe09ce05a`；核对实际 HEAD，先按[公共合同](README.md)保存相关基线。

必读：主 guide 当前态与 §5.17、[唯一计划 F.2](../2026-09-20-vrtc-code-change-plan.md)、上述审核和[原派发合同](12-s4-e-skill-evaluation.md)。已完成的 evolution 迁移和旧账回滚继续保留。修复放在当前规则所有者，复用 DSH 的模型选择、现有 Run/provider 绑定、预算和 verifier；不加通用实验平台、第二预算账或新 scheduler。

## 固定修复与验收

### Q1：成本约束必须兑现

`promotion.ts` 目前只检查 reported/unknown，没有比较上限。冻结预算的 `maxTokens`/`wallTimeMs` 已明确为**整个实验**的上限，不能按每侧各给一份额度，也不能以注释“不负责执行预算”取消合同。

- 在现有实验编排/Run 预算入口落地总额和截止；复用已有 token 统计口径，重启或重复调用不重置已发生消耗。达到截止取消在途执行；已知额度耗尽不启动下一侧。观测滞后可能导致的实际超限仍须留记录并拒绝晋升，不伪报严格零超支。
- gate/decide/apply 都从实际证据验证相应指标齐全且未超限；token 与时间分别判断，二者同时声明就都检查。只有 toolCalls 不证明 token 已知，时间使用真实耗时/时间来源；unknown 不能填 0。未声明成本约束时维持 unknown 可观察但不可推断的语义。
- 验收：1 token 上限、四侧各 15 tokens 必须拒绝；每侧未超但总和超也拒绝；仅 toolCalls 缺目标指标、恰好达到上限、两种上限同时存在、取消/重开后累计均有正反例。非法结果零 PROMOTE/applied/生产改写。

### Q2：历史成功样本不能被同败掩盖

比较主体仍在 `evolution/src/replay.ts`。observed-failure 必须本次基线失败、候选通过；历史 verified 的 observed-regression/holdout 要能在本次基线复现通过，候选也保持通过。本次基线失败就无法证明对比，具名 inconclusive/拒绝晋升；不得把两侧同败记为 maintained。保持原 F.2 未见 holdout 的使用边界，不增加自动选样或评分器。

验收：目标修复 + 历史 verified 的 holdout 两侧同败，及 observed-regression 同形反例，都必须阻止 gate→PROMOTE→apply；历史成功、本次两侧均通过是正例。覆盖报告重算和直接服务入口，不能仅改最终呈现文字或篡改预期为“保持”。

### Q3：冻结条件必须约束实际 Run

当前冻结 model 字符串没有传到 spawn，裁判版本只在执行后读取。保持 `evolution` 持有实验定义，runtime 持有执行绑定，装配层提供可信配置；工具层不能是唯一校验处。

- 运行前从真实配置/注册表冻结实际模型选择（含影响运行的既有选项）、本次使用的 tools/provider 配置与 verifier 身份/版本。沿窄的 replay 选项和已有 `agentOptions` 传给真实 worker；子执行若发生，也遵守同一实验绑定。runtime 不导入 evolution。
- 每侧依据实际 Session/Run/provider 与 Review 判决核对冻结条件；不支持固定的可变来源在运行/晋升时具名拒绝。不能只比较实验开始值与晋升时当前值，也不能拿模型自报或 fixture 自填的字符串当实际身份。候选侧只允许本票已批准比较的 Skill 内容差异。
- 验收：冻结 A 后两侧之间将默认模型改 B、结束前改回 A；结果要么所有真实请求仍使用绑定的 A，要么拒绝漂移，不能混用并晋升。裁判在冻结后首次执行前换版本、工具/provider 在两侧间变化，均验证实际生效身份；无漂移的真实 runtime/verifier 正例仍可走两次人审。断言实际请求与持久来源，不只断言 report 字段。

### Q4：输入隔离不能被链接绕过

所有者为 `evolution/src/experiment.ts` 的冻结/复制步骤。在首次 Run 前检查快照链接：逃出快照根、循环或不可读目标具名拒绝；内部链接可解析为快照内实际内容并复制成每侧私有文件，摘要覆盖实际内容。复用文件系统 API，不建通用文件隔离服务。不能在摘要里只记链接文本，却让执行读写共同目标；也不能静默忽略输入来凑相同 digest。

验收：审核 Q4 的外部绝对链接反例在任何 Run 启动前拒绝、原文件未变；内部链接支持路径中 baseline 写入不改变 source 或 candidate；普通无链接工作区继续运行双侧。测试真实复制和工作区，不以两个不同路径字符串证明隔离。此保证针对工作区输入，不扩张为 OS 级任意恶意程序沙箱。

## 交接、完成闸与停止

主代理先列 Q1～Q4 的所有者、依赖接口、反例、正例和证据；每个子代理一次一个窄目标，共享 `experiment/replay/promotion` 文件串行交接，明确不独占工作区、不回退他人改动。先固定 Q2 比较规则及 Q3 所需执行接口，再接实验编排的 Q3/Q4 与 Q1 总额检查，最后由主代理组合验收。内部完成不等于整票完成。

把上述反例保留在仓库，在被审基线上确认应拒绝测试为红，再修到绿；至少一条真实工具→双侧 Run/verifier→gate→两次人审→apply→rollback 正例保持。沿原 EVAL-3 重验重复、取消和重启的证据/预算，EVAL-4/5 重验旧 ledger/旧 applied 回滚及单一行为所有者。数据变化按 persistence 合同记录兼容性，旧账无新身份时不得默认获得新晋升资格。

按公共合同完成 build、unit、integration、persistence、类型与 diff 检查；只报告实跑范围。更新主 guide、唯一计划第 12 项与一份返工记录，保留原失败历史；提交本票改动及外层指针，最高填待验收。任一 Q 或原 EVAL 合同失败继续返工；不把它写为已知边界，不新派“以后增强”，不启动 A5，不付费跑模型、不推送或部署。
