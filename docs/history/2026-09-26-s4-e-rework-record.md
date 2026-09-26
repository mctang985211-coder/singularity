# 第 12 项 S4-E 返工记录：Q1～Q4 关闭（2026-09-26）

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **待验收**（交付方最高可填状态），2026-09-26 |
| 执行 agent / 任务链接 | 返工实现主代理 + 五个串行子代理（Q2 比较 → runtime 执行管道 → Q4 快照隔离 → Q3 冻结绑定 → Q1 成本兑现）+ 一个收尾（结算竞态）；[返工 prompt](../execution-prompts/12-s4-e-review-rework.md)、[进度审核](2026-09-26-s4-e-progress-review.md)、[计划 F.2](../2026-09-20-vrtc-code-change-plan.md) |
| 返工审核结论 | 主代理逐项裁定返工要求**全部真实、必要、无更简替代**：派两个 explore 子代理在代码上核实四组反例全部成立（Q4 由 explore 在 /tmp 独立复现，数字与审核逐字一致）；DSH 无对口实现可替代（Q3 的 per-agent 固定模型选择复用 DSH 现有 `SpawnRequest.agentOptions`/`AgentOptions`，不新造机制）；修法符合 KISS（详见各节收窄点） |
| 返工前基线 | Singularity `e98bed1` / 外层 `299277fab9`（被审实现 `4de0056` + 审核文档提交） |
| 交付版本 | Singularity `a5d0372`（Q2）→ `295e851`（执行管道）→ `c0990fd`（Q4）→ `dc5b1e3`（Q3）→ `970684a`（Q1）→ `470b935`（结算竞态收尾）+ 本文档提交；外层指针见同批提交 |
| 前置文档处置 | 进度审核提交 `e98bed1` 已将共享文档置返工态；本记录为返工收口，原[交付记录](2026-09-26-s4-e-delivery-record.md)保留为交付方报告，不删改失败历史 |

## Q1：成本约束兑现（整个实验的上限）

**修复**：
- 编排器（`evolution/src/experiment.ts`）：每侧启动前从 ledger 累计已结算样本的 token 四桶总和（`reportedTokensSpent`，与 runtime `budgetBreaches` 同口径；未上报的侧不贡献、不当 0）；声明 `maxTokens` 且已耗尽 → 具名拒绝启动下一侧；声明 `wallTimeMs` 时实验截止 = `experiment_started.at + wallTimeMs`，剩余窗口经 R2 管道作为该侧 per-run `wallTimeMs` 传入（在途到点由 runtime 真实取消并落 `budget exhausted` 终态 review）；重启/重复调用不重置（ledger 是唯一事实源）。
- 逐侧真实耗时：`experiment_sample` 增可选 `durationMs`（run 自己的 review durationMs，缺失时回落 replay outcome 口径，均不填 0）；fold 可选容忍旧行，闸在声明 wallTimeMs 时强制要求。
- 闸（`evolution/src/promotion.ts`）：声明 maxTokens → 每侧必须有 `metrics.tokens`（仅 toolCalls 具名拒绝），全样本全侧总和与上限比较；声明 wallTimeMs → 实验实际耗时（`report.at − experiment_started.at`，连重启间隔都诚实计入）与上限比较；两者同时声明都查；`==` 上限放行，超过才拒；观测滞后造成的实际超支留记录并拒绝；未声明约束时维持 unknown 可观察不可推断。
- 文案改真：`experiment.ts`/`replay.ts` 模块头「不执行预算」段、`evolution-replay.ts` 的 budget 参数描述。

**验收（红→绿，全部持久化为回归）**：审核反例逐条入库——`maxTokens:1`/四侧各 15 拒绝（红时到达 applied）；每侧未超总和超拒绝；仅 toolCalls 缺 tokens 点名拒绝；恰好==上限放行；双上限分别超限各拒、均不超放行；声明 wallTimeMs 无 durationMs 拒绝；伪造 durationMs（与 store review 交叉核对）拒绝；额度耗尽少跑一侧（spawn/ledger 计数）；取消后 resume 累计不重计不超窗；实际超支照实记录。红证据：回退源码后 13 failed / 60 passed（`/tmp/q1-red-final.txt`）。

## Q2：历史成功样本不被同败掩盖

**修复**：`compareExperimentSides`（`evolution/src/replay.ts:633-654`）对 observed-regression/holdout 增「baseline 侧必须 verified 才有可比性」，否则样本 `inconclusive`（复用现有词，未加新 verdict）；`EXPERIMENT_COMPARER_VERSION` bump `@2`，旧报告具名「cannot re-derive」拒绝；三处语义注释重写。`promotion.ts` 无需改（inconclusive 闸已有）。

**验收**：修复前 7 failed / 64 passed（逐条失败信息存档）；端到端临时 spec 复现审核原案（修复前 `holdout:{baseline:failed,candidate:failed}`+目标 fixed 到达 applied 并改写生产；修复后 decide 具名拒绝，零落账零改写）；observed-regression 同形反例同处理；历史成功+本次两侧均通过为正例放行。裁决：verdict 拒绝落点保持在 decide/apply（与既有 both-failed 语义一致；gate 只落账人审答案）。

## Q3：冻结条件约束实际 Run

**修复**：
- 执行管道（R2，`task-runtime`/`orchestrate.ts`）：`ReplayTaskOptions.agentOptions` 逐字透传到真实 spawn（复用 DSH `SpawnRequest.agentOptions`/`AgentOptions`，agent 实例固定持有并用于每次请求）；replayed worker 的子执行经会话级传播继承同一 agentOptions 与同一绝对截止瞬时（照 `workerCwd`/`sessionWorkspaces` 先例）；per-run `wallTimeMs` 与部署预算/根截止在 `runDeadlineMs` 取 min。缺省行为逐字节不变。
- 冻结（`evolution`）：`Config.modelIdentity` 改返回结构化选择 `{provider,model,reasoningEffort?,maxTokens?,label}`（label 仅展示、不反解）；装配层注入 `agentDefaultModel.currentSelection()` 全量；resolver 给不出结构化选择 → 运行与晋升具名拒绝。frozen 块增：结构化模型选择、每判据 `verifierRef`+冻结时注册表版本+身份锚、provider 基线（capabilities/registryRevision/mcpServers/preset/skills 摘要）；编排器每侧传冻结 agentOptions。
- 核对（晋升闸，全部从持久来源读回，不认自报字符串）：模型=每侧 Session `request/header` 事件的实际 route（含子执行会话；无可读日志具名拒绝，唯一豁免为 runtime 自记的 no-worker criteria replay）；裁判=报告版本 vs 冻结值（再保留「仍注册且版本一致」）；工具/provider=每侧 `run.providerBinding` 从 store 读回，两侧唯一允许差异是目标 skill 的 contentDigest（== frozen.candidate）。

**验收**：`tests/integration/s4e-q3-freeze-binding.spec.ts` 7 例（真实 loop，仅模型输出脚本化）：冻结 A→两侧间默认改 B→结束前改回 A，所有真实请求仍为 A 且链路可继续；实际跑了 B 的轨迹（篡改会话日志）闸具名拒绝；裁判换版本/provider 平面改动/resolver 不可用各具名拒绝；红证据 `/tmp/s4e-q3-red-evidence.log`（适配后 4/4 失败）。

## Q4：快照链接不破坏输入隔离

**修复**：`evolution/src/snapshot-input.ts` 为唯一链接策略遍历（digest 与复制共用）：链接目标逃出快照根/成环/指向遍历路径上的目录/缺失/不可读/非普通文件 → 首次 Run 前具名拒绝（零 ledger/零工作区/原文件不变）；根内链接解析为实际内容——摘要按解析后字节入账（链接名/文本不再是摘要输入），复制物化为每侧私有真实文件；复制后复算等于冻结摘要的收口保留（修复后才第一次有证明力）。

**验收**：审核原案入库（`experiment-runner.spec.ts`，真实栈：逃逸链接在任何 Run 前拒绝）；内部链接正例（baseline 写入不改变 source 或 candidate）；循环/不可读/同文本不同内容/静默凑 digest 反例；旧固化测试（`experiment.spec.ts:221-234` 链接文本哈希相等）按语义修复改写并注明理由。红：基线上 4 failed / 32 passed + integration 2 failed。

## 顺带关闭的结算竞态（返工收尾，`470b935`）

主代理全量回归发现 R2 新用例间歇失败，定性为**产品竞态**：`settleParentBatch` 的截止闸原只认根截止，批次在父 run 自身墙钟过期后仍代其提交验收（探针实测「受理点=过期后 6ms」落 verified）。修复：批次受理闸推广为该 run 自己的 `remainingRunMs`（per-run 墙钟 ∩ 根剩余 ∩ 调用方瞬时），到期按预算停取消父 run（`cancelled` + 具名 reason），不再代验。确定性反例修复前 100% 红、修复后 10 连绿；原抖动用例改确定性构造后 45 连绿；全量 unit 1798 / integration 407 全绿。**遗留边界**：worker 自己 `task_submit_result` 与截止同刻落地仍由 store 先写者裁定（与「runtime 代为受理」性质不同，触及全体 submit 路径，未在本票加闸）。

## EVAL 重验（返工后）

| 验收 | 重验结果 |
|---|---|
| EVAL-1 | 真实工具入口→双侧 Run/verifier→可追溯报告链路保持绿（`evolution-replay-experiment.spec.ts` 10 例、`experiment-runner.spec.ts` 11 例）；隔离升级为链接策略遍历+物化私有副本（Q4） |
| EVAL-2 | 拒绝矩阵 41 例 + 新增 Q1/Q2/Q3 反例全绿；正例链（experiment→gate→两次人审→apply→rollback）保持（同 spec 第二 describe） |
| EVAL-3 | 取消/重启/重复调用的幂等与预算累计由 Q1 新增用例重验（取消侧消耗计入、resume 不重跑不重计、剩余窗口锚定 ledger） |
| EVAL-4 | 旧账可读/旧 applied 回滚保持（`ledger-roots.spec.ts` 活体账字节存档回归；`evolution.spec.ts` 旧类型用例）；旧实验记录无新身份不获晋升资格（`storeId`/durationMs/structured model 缺失均具名拒绝） |
| EVAL-5 | 唯一行为所有者不变：task-runtime 只新增执行管道（零 evolution import），闸/实验/ledger 全在 evolution 包；`470b935` 的批次受理闸属 task-runtime 结算本职 |

## 实跑检查（主代理在最终 HEAD 复跑）

| 命令 | 结果 |
|---|---|
| `packages/singularity && pnpm build` | 通过（lib 随源入库，零漂移） |
| `pnpm vitest run --project unit packages/singularity` | **56 文件 / 1798 通过** |
| `pnpm vitest run --project integration packages/singularity` | **54 文件 / 407 通过** |
| `pnpm run verify-persistence` | OK — 4 event roots 不变 |
| `git diff --check`；`agent-singularity`/`evolution` tsc | 干净；0 错误 |

## 已知边界与未覆盖

- 确定性 fixture 证明协议，不声称统计效果；未调用付费模型。
- `agentOptions`/工作区的会话级传播是进程内机制，崩溃重启续跑不持有绑定（同 `replayLineage` 既有边界，A6/S2-R）；闸的每侧实际请求核对（Q3）是该缺口的兜底——续跑后实际身份与冻结不符即拒绝晋升。
- 相邻同类未动（记录在主代理裁决）：`evolution/src/evolution.ts` 的 agent_preset apply/prepare 裸 `cp`（preset 目录链接，非实验输入隔离；该类型新晋升本票已拒）。
- `a4-question-cold-recovery`/`worker-contract` 的基线既有偶发抖动与本次改动无关（单跑稳定；两文件不 import 本票代码）。

## 最终验收结论

**待验收**（返工交付自评 Q1～Q4 关闭、EVAL-1～EVAL-5 重验证据齐；结论待进度审核复审）。下一项仍为第 13 项，前置=本票经进度审核验收。
