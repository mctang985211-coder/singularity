# Singularity 自改进与 RSI 源码审计

日期：2026-10-06（Asia/Shanghai）。源码基点：Singularity nested Git `fa7c5999bbf9467731cabea87bb9ed2e60b23355`；外层 Harness Git `c525f427bfea015c018b1d83782f4cfb3965085d`。范围：Evolution、supervision/review/handoff、实验、晋升、回滚与 recovery 的实际消费路径。只读调查；未运行实验、审批、测试、重启或修改业务资产。

## 判断

**当前实现具有“经实验验证、经人批准的可复用资产改进”能力；没有证据证明具有可自行改进自身实现与改进算法的完整 RSI，更没有证明 graph4 已经产生这种能力。** 这不是空的提案账本：三个目标确有执行器、实验、生产写入和恢复入口。但这些执行器的范围与批准条件是源码显式固定的；`runtime_policy`、`decomposition_policy` 及 L4 Harness 变化没有执行闭环。[S1][S2][S3]

为避免把重试叫作学习，本报告用三个层次：

1. **任务恢复**：同一目标重新执行、复用已验证产物；不必改变后续 Agent 的能力。
2. **资产级自改进**：修改 Skill、能力注册或 TaskTemplate，独立复验后发布，使后续任务使用新的版本。Singularity 已实现这一层的机制。[S1][S4][S5]
3. **递归自改进（本报告的强 RSI 定义）**：系统能改进自己的候选生成、评估、调度、资源管理或平台实现，并用同样可信的评估证明这种改进提高了后续改进能力。当前 L4 和相关 policy 目标不能通过现有执行器达成；现有重复实验仅标识重复，不聚合长期学习成绩。[S2][S3][S18]

需要把“源码具备路径”“受控集成测试跑通”“真实任务自主获益”分开判断。前两者不能自动证明第三者。仓库还保存了 2026-10-04 的真实模型 xv6 改进正例，下面单独说明其支持范围；本报告没有复跑该历史实验。[S20][S21][S38]

## 真实实现了什么

| 环节 | 实际机制 | 能力边界与结论 |
|---|---|---|
| 自动发现 | terminal review 或 graph selected 触发扫描；`all` 接受所有失败节点和 verified root；成功子任务不自动诊断；实验 replay 子树排除再次触发 | 自动启动诊断真实存在，但不是持续的全任务优化搜索；需要活着的 root Agent。[S6][S7] |
| 分工 | 普通子任务诊断返回原 parent；root 或带共享提案的诊断启动 supervisor；已有 focused reviewer 归原 supervisor | 不是每个失败都强制新开监督树，属于已有的减法；supervisor 的决策仍由模型按提示作出。[S8][S9] |
| 候选 | `skill`、`capability`、`task_definition` 可进入 candidate/prepared；其余目标拒绝 | L1–L3 的固定资产执行面。L4 Harness 改动明确要求另走人工实现/验证工作流。[S1][S2] |
| Skill 改进 | 现有同名 Skill 的 `SKILL.md` 替换；execution sidecar 从 baseline 派生，仅更新内容 digest | 不能靠这个路径新建普通 Skill，不能同名更新 knowledge Skill，不能变更声明中的能力/工具/verifier，也不能写资源文件。[S3] |
| 能力改进 | 修改一个完整 capability row；可带新 execution Skill 与 MCP 定义；先做 runtime admission precheck | 能扩展挂载和授权配置，确有运行时写入消费者；这仍不等于生成/部署新的平台或 MCP 实现。[S4][S10] |
| 模板改进 | 冻结完整 baseline/candidate 模板库；发布下一个版本；修改现有 child criteria 要 positive/negative 示例和 independent parent oracle | 覆盖可复用任务契约和分解 recipe；不是任意修改现存 Task 的验收标准。[S5][S11] |
| 实验 | 同一输入 digest、同一 model selection、隔离 workspace，两边均通过真实 `taskRuntime.replayTask`；要求 observed 与独立 holdout | 有真实执行，不是仅把诊断投票当实验。样本由调用者挑选，都是当前图的 terminal tasks。[S12][S13] |
| 晋升 | 从账本重建报告，核对文件字节；重新读 Task/Run/evidence、judge/model/provider binding 与 production baseline | 门禁是实质验证，不只信任六个自然语言 gate answer；但依赖部署具有完整证据接口。[S14][S15] |
| 决定与发布 | `evolution_decide` 请求一次人批准，`evolution_apply` 再请求生产写入批准 | 这是有人批准的改进链，不是无批准的自治平台自改。自动通过 HITL 的外部脚本不改变源码这条边界。[S2][S16] |
| 回滚 | 已 applied 提案可调用 rollback，经批准恢复 baseline；template 更新以新版本追加旧内容，初次发布可删除；不覆写另一 writer 的变化 | 有耐久的回滚执行器；本 supervisor baseline 没有授予 `evolution_rollback`，也没看到自动监测发布后退化再回滚的控制路径。[S17][S19] |
| 下一轮 | root 通过 `task_recover` 新开 recovery/improvement Run；保留原始 acceptance；同 request key 幂等 | 不是改写旧 Run。默认 3 次 recovery、2 次 improvement、每 store 8 个 reviewer/supervisor 运行；有界循环能控成本，但不是无限 RSI。[S22][S23] |

### 晋升并非只改一个状态字符串

`apply` 重查 candidate 与 baseline 后调用统一 `commitIntent`，记录耐久 intent，写生产资产，验证，再追加 completion。启动时 `reconcile()` 消费未完成 intent。这是可以恢复的生产变更机制；“耐久性恢复”应与“根据性能退化主动回滚”区别开来。[S14][S17][S24]

生产效果确有消费者：能力 commit 先写配置，再调用 runtime `applyCapabilityRow`，替换内存注册表；模板查询每次读取绑定的模板根；run binding 从冻结目录读原 Skill 字节。因此新 admission/新 Task 可使用发布资产，既有 Run 继续使用原快照。平台资产变好也不保证模型实际会选择合适的新模板或指导，仍需要下一轮行为证据。[S10][S25]

## graph4 的现场证据

现场读取时间：2026-10-06 13:18（Asia/Shanghai）；并复用协调者保存的只读 API 快照。持久证据位于 [2026-10-06-cosyvoice-architecture-evidence.json](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-cosyvoice-architecture-evidence.json:1)；原快照调查位置为 `/tmp/singularity-architecture-audit-20261006/task.json`、`evolution.json`。目标 store：`sg-t-0663b378-ecc5-46f0-a395-177624bc06f9`；root：`t-c07d1494-7083-4e71-8224-def2de2ab98a`。

| 观察 | 数值/归属 | 推论 |
|---|---|---|
| graph4 snapshot | 31 Tasks、26 Runs、23 Reviews、0 Diagnoses、0 带 recovery 的 Runs | 此快照没有进入 reviewer diagnosis → supervisor → recovery/improvement 的闭环。运行仍在继续，不能把未完成观察推成全平台永远不具备能力。 |
| 全局 Evolution GET | 5 proposals、0 experiments；2 个 proposed、3 个 prepared，0 gated/decided/applied | 当前账本未证明发生过完成实验或资产发布。 |
| 5 个 proposal 的 sourceRefs | 全部引用 `root-contract-scope-defect-chip-delivery`、`t-6fd38b7f…`、`t-afe3bc31…` 等；与 graph4 的 taskId/diagnosisId 集合相交为空 | 它们是另一个图的历史提案，不能算 graph4 的自改进产物。 |
| graph4 原始 criteria | 共 68 条：67 条无 `verifierRef`，剩余 1 条为 `review`；所有 31 个 Task 至少含 1 条无 ref criterion | 当前已记录任务没有一个能原样满足 Evolution freeze 的每条 criterion 必须 pin registered/versioned verifier 的入口条件。 |

这些是现场快照的派生计数，不是源码保证；持久证据 JSON 保存现场数据与调查结果，原始快照可用于重新计算。API 本身调用 `evolution.list()` 和 `experiments()`，没有 store 过滤；proposal 列表只能按 status/targetType/targetId 筛选，因此必须用 sourceRefs 或 experiment.storeId 做归属判断。[S26]

现场最重要的确定性障碍是 **正常 admission 接受的 Task 不一定能被 Evolution 复验**。正常 child admission 仅在 `verifierRef` 存在时检查其形状；Evolution 对每个 task acceptance criterion 调 `frozenCriterionOf`，遇到缺 ref 就在创建 `experiment_started` 前拒绝。给新 candidate 模板补 ref 不会修改旧 sample Task 的 recorded criteria。由这些现存 terminal tasks 选择样本时，无论 skill、capability 还是 task_definition，都会遇到同一入口断裂。[S27][S28][S12]

旧图的 `prop-admission-pins-verifier-refs` rationale 恰好描述了该断裂，其状态仍是 `proposed`。这是诊断能被记录、平台修复却无法通过已有执行面落地的实例；它不是本轮 graph4 的进展。该提案的自述不是独立证据，以上源码路径和本轮 recorded criteria 才是本报告判断依据。[S1][S27][S28]

**字段格式必须分清：当前 `acceptanceCriteria[].verifierRef` 应写注册 id `"command"`；注册表中它的 `version` 为 `"1"`，Evolution 再把这两者冻结。** `command@1` 是人可读的判决身份表达，不是现有 `verifierRef` 字段格式。normalizer 原样搬运 ref；VerifierRegistry 直接用完整字符串做 Map lookup，没有拆 `@`。因此旧图 v3 candidate 中的 `verifierRef: "command@1"` 除了不能修正旧样本，也不是当前内置 command verifier 的合法 id。[S37][S28]

## 对效率和 RSI 的关键限制

### 1. 成功优化的机器目标过窄

唯一可显式声明的 objective 是 `tool-call-reduction`：baseline/candidate 都 verified，observed-success 样本每个严格减少工具次数，holdout 不增加次数；counter 缺失就是 inconclusive。这能有效阻止“减少 coordinator 调用，却把工作塞给更多 child”的假优化，因为 tool calls 汇总完整执行子树。[S29][S30]

但少工具调用不能证明少 token、少钱或更快。调用一次耗时构建与调用一次 `task_read` 在此目标里都是一次；参数中也没有 latency、美元成本或 task throughput 的改进目标。`maxTokens` 是可选的预算上限，不是 token-reduction 目标；未提供该上限时，晋升允许 token 成本未知。[S13][S29][S31]

**还有一个具体预算口径缺口：** `costOf` 汇总子 Run 的 toolCalls 后，以 `{ ...review.metrics, toolCalls: aggregate }` 返回，tokens 仍来自根 review。根 review.tokens 取该根 Run 的单个 `run.sessionId` 观测，sessionTokens 也只读取对应 Session projection。因此分解实验的 child Run tokens 不进入这个声称“whole experiment”的 maxTokens 总数。promotion 的总和仅累加每个 side 中上述 tokens，没有另外汇总其子 Run。[S30][S31][S32]

预算还属于每个 side 结束后的计数：开始下一侧前若已达上限则停止，结束后若超限则拒绝晋升；不会提前保证正在执行的一侧绝不超限。`reportedTokensSpent` 把未知 tokens 计为 0，未知成本在有 maxTokens 的最终 promotion 才被拒绝。这是后验选择与停止机制，应避免当作完整实时成本控制。[S33][S31]

### 2. suggestion 与必须先发布的变更混在一起，会阻断 recovery

> 2026-10-07：`coordinateRecovery` 已随 `task_recover` 工具一起删除（supervisor 只存在于平台 RSI loop，轮次由 driver 直接调 `recoverRootTask` 打开）。下面这条对旧入口的审计结论作为历史记录保留；它描述的 proposal 门槛在今天的链路里不存在。

`coordinateRecovery` 用 `diagnosis:<id>` 找关联的 **全部** Evolution proposals，然后要求每个都是 applied 且未 rolledback；它没有“必要前置变更”字段，也没有排除不能执行的 policy suggestion、REJECT 或 KEEP_FOR_FURTHER_RESEARCH 提案。于是为同一 diagnosis 记录一个没有执行器的 `runtime_policy` 建议，就可能让其 root recovery 永远过不了这条门。这是实质控制流耦合，不是单纯 UI 困惑。[S34][S1]

改进方向是显式声明 recovery 依赖的 proposalIds；其余建议可留研究账本，并保持 provenance。该建议属于审计推论，本次未改源码。

### 3. repetition 并不等于重复学习或统计稳健

调用者可提高 repetition 得到新的实验；同一 key 会复用现有 records，避免重复执行/重复收费，这是正确的幂等处理。可是晋升只读“该 proposal 最新实验”并重建那一次结果，没有要求 N 次重复稳定获胜，没有估计波动/置信区间，也没有把历轮开销、失败提案和所有 guard 样本做长期累计评估。较小 holdout 的一次成功只能证明那次被选择的样本上的效果。[S18][S35]

当前 supervisor prompt 要读已有诊断、避免重复提案，这提供了局部记忆；它不能据此证明有跨图的自动教训检索、样本池维护或候选搜索策略更新。账本 list 的筛选维度和 handoff 查询都是 status/target/diagnosis 关联，晋升执行范围固定；“长期学习”在本审计范围内未出现独立的实现消费者。[S8][S26][S1]

### 4. 没有证明发布后的闭环收益或自动退化回滚

改进 experiment 是发布前测试；之后 task_recover 会执行原目标并产生 review，但 recovery 本身不要求成本一定更低才算 verified，原 acceptance 对产物是否通过负责。不同层面的成功不应混用：PROMOTE 前 `improved`、发布后产物 verified、发布后成本继续下降，分别需要证据。[S29][S23]

`evolution_rollback` 是已实现的明确工具与批准入口；supervisor 默认权限列表却只有 propose/candidate/prepare/replay/gate/decide/apply/list，没有 rollback。当前链中没有根据发布后的成本退化触发它的源码消费路径。intent reconciliation 修复中断提交，并不撤回性能差但已经完整提交的版本。[S17][S19][S24]

### 5. 历史真实模型正例存在，但只支持有限资产改进

保存的 `2026-10-04-live-xv6-supervisor-repair-run2.json` 记录真实模型 `deepseek/deepseek-v4.1-flash` 的一次通过案例：v1 recipe 将 completion 放在 fix 前，原真实 grader 69/70；诊断→模型 supervisor→双臂实验 fixed、holdout 两边 verified→发布 v2→第二个 fresh checkout 的 root 消费 v2→grader 70/70。它的 proposal 走完整 proposed 到 applied，candidate 字节和发布字节一致；属于有分量的资产改进证据，不应把平台概括为“只有 mock”。[S38]

不过这是缺失依赖/错误顺序的特设单案例，原 acceptance byte-identical，未触及 criterionRepair、成功成本优化或 L4。测试驱动者自动回答人批准；受控 watchdog 在停滞后提醒，保存证据记录 3 次 nudge。其方法/limits 明示一次机器运行及 grader/model 延迟影响。前一份同日历史证据为 failed；本报告未独立重放两份底层会话、仿真与账本。正例足以支持“真实模型能在这条有限链上修复模板并被下一次任务使用”，不足以支持无人推动、低成本、长期稳健或平台自身 RSI。[S38][S39]

### 6. scripted 测试证明控制面，不能代替真实改进证据

`success-cost-evolution.spec.ts` 确实调用真实工具链、运行时与 verifier；但其 model 行为由脚本固定，candidate 产物直接在 fixture 中写入，读取次数由 candidateReads 参数决定，reviewer/supervisor 的提出与调用也预编排。它证明 cost 子树统计、门禁和生产绑定管线能工作，不能证明真实 LLM 自发找到有效改进。[S20]

测试辅助 `promotion-experiment.ts` 明确说明 sides 是直接构造的 settled rows，而非真正执行。`scripted-loop.ts` 明确替换 model provider、持久层和人批准 seam，其他组件真实。不能把这些测试当成“已经在生产做出持续 RSI”的演示；同样，不能因为测试使用脚本就说实际 Evolution executor 是假的。[S21][S36]

## 对总架构判断的含义

Evolution 提供的不可变输入/判据、双臂真实执行、holdout、绑定溯源、生产 baseline 冲突检查及耐久 commit，有助于让一次改进可检验、可回退；这些复杂度有明确目的。[S12][S14][S17]

但它目前对本轮任务的帮助尚未兑现：graph4 没有 diagnosis/experiment/apply/recovery，且正常任务进入实验的 verifier pin 合同断裂。调度层修复提案又只有建议状态。因而准确定位是 **“一个带实验和人工发布门的 Agent 资产治理/改进框架，有限的真实模型资产改进已有历史正例，本轮闭环没有发生，持续 RSI 与效率收益未证实”**。直接宣称“已有强 RSI”“已证明高效”都会超过证据。[S1][S27][S28][S29][S38]

建议先建立一个真实模型、真实交付、能复验的最小改进案例：原任务与 judge 在 admission 时可冻结；选择至少一个独立 holdout；candidate 行为必须通过实际绑定改变；完整执行树 token、工具次数与 wall time 同时记账；发布后重新执行并对比；人为制造一次退化验证 rollback。然后再谈跨任务持续收益和 L4 自改。此处是研究建议，本次没有执行该案例。

## 源码锚点

每个锚点均为绝对文件路径与一基行号；正文中的判断沿这些实现定位。未将 README、规划文档当作实现证据。

- **S1**：[Evolution candidate 允许的目标](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/evolution.ts:113)；[执行器目标常量](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/types.ts:28)。
- **S2**：[L4 与不支持目标拒绝、发布效果](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-apply.ts:9)；[apply 的批准请求](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-apply.ts:113)。
- **S3**：[Skill prepare 的新建、knowledge、resources 限制](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/evolution.ts:157)；[sidecar 不能变更执行声明](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/evolution.ts:705)。
- **S4**：[capability prepared identity](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/evolution.ts:310)；[能力门禁](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/capability.ts:235)。
- **S5**：[TaskTemplate 版本与判据修复](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/task-definition.ts:84)；[candidate 确实被 replay child/recipe 消费的检查](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/task-definition.ts:143)。
- **S6**：[自动 review 接受范围、实验子树排除](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/review-scan.ts:48)；[terminal/selected triggers](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/review-scan.ts:291)。
- **S7**：[root 不 live 则不启动 reviewer](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/review-scan.ts:176)；[graph selected 事件驱动](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/trigger.ts:15)。
- **S8**：[needsSupervisor 与原 parent 归属](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/handoff-rules.ts:273)；[supervisorPrompt 的复用、手动决策策略](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/handoff-rules.ts:347)。
- **S9**：[claim 后 spawn supervisor](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/evolution-handoff.ts:164)。
- **S10**：[commit 写配置并调用 runtime](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/service/core.ts:348)；[runtime 实際更新 capability/MCP 注册表](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/lifecycle.ts:225)。
- **S11**：[模板 positive/negative 与 independent parent oracle 校验](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/freeze.ts:714)；[guard 复验](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/task-definition.ts:208)。
- **S12**：[冻结样本、模型、输入](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/runner.ts:47)；[隔离 workspace 与真实 replayTask](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/runner.ts:171)。
- **S13**：[sample/holdout role 选择](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-replay.ts:67)；[工具完整参数及 budget](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-replay.ts:206)。
- **S14**：[apply 重查/commit](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/evolution.ts:504)；[Skill promotion 重读所有证据](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/skill.ts:34)。
- **S15**：[report 与 ledger 精确字节一致性](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/binding.ts:745)；[production baseline 冲突](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/evolution.ts:738)。
- **S16**：[decide 单次人批准与 apply 第二门](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-decide.ts:60)。
- **S17**：[rollback service](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/evolution.ts:859)；[rollback 工具批准](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-rollback.ts:79)。
- **S18**：[晋升只选最新实验](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/binding.ts:750)；[实验 newest-first](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/service/core.ts:1195)。
- **S19**：[supervisor 权限没有 rollback](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/handoff-rules.ts:14)。
- **S20**：[真实工具链中的预编排 supervisor/model 行为与写入 candidate 产物](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/success-cost-evolution.spec.ts:67)；[children 流量回归验证](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/success-cost-evolution.spec.ts:164)。
- **S21**：[promotion fixture 明示执行是构造 rows](/home/ROXY/code/bb_work/harness/packages/singularity/tests/support/promotion-experiment.ts:7)。
- **S22**：[supervision 默认 caps](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/supervision.ts:20)；[根据自身 runs 计数](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/supervision.ts:66)。
- **S23**：[runtime caps](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/root-recovery.ts:108)；[recovery 原合同检查](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/root-recovery.ts:311)；[request key 幂等](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/root-recovery.ts:281)。
- **S24**：[intent→install→verify→completion](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/commit.ts:245)；[startup reconcile](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/index.ts:246)；[reconcile 中来源字节校验](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/commit.ts:263)。
- **S25**：[模板根与 runtime 查询消费](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/runtime.ts:193)；[frozen Run binding 内容复查](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/run-binding.ts:298)。
- **S26**：[GET 全局账本](/home/ROXY/code/bb_work/harness/packages/singularity/graph-web/src/web/api/evolution.ts:25)；[list 无 store filter](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/service/core.ts:735)；[现场调查持久证据](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-cosyvoice-architecture-evidence.json:1)。
- **S27**：[正常 admission 允许 verifierRef 缺省](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/admission.ts:298)。
- **S28**：[freeze 缺 verifierRef 拒绝](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/freeze.ts:257)；[所有原 task criteria 逐一冻结](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/freeze.ts:613)。
- **S29**：[成本目标比较与总体结果](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/comparer.ts:65)。
- **S30**：[子 Run tools 完整汇总、tokens 保留根记录](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/record.ts:102)。
- **S31**：[可选 maxTokens 与 side 成本未知检查](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/binding.ts:685)；[仅累加 side.tokens 的 whole experiment 检查](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/binding.ts:725)。
- **S32**：[Review 仅观测自己的 run.sessionId](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/settlement.ts:39)；[metrics.tokens 来自该 observation](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/settlement.ts:145)；[token projection 是单 session](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/env.ts:388)。
- **S33**：[未知 tokens 计 0、side 开始前预算检查](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/record.ts:419)。
- **S34**：[全部关联 proposal 必须 applied 才开 root recovery](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/service/core.ts:922)。
- **S35**：[repetition/key 与幂等 resume](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/spec.ts:36)；[跨实验 key 冲突与已有 side 跳过](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/runner.ts:108)。
- **S36**：[scripted-loop 明示替换组件与真实组件](/home/ROXY/code/bb_work/harness/packages/singularity/tests/support/scripted-loop.ts:3)。
- **S37**：[command verifier 的 id/version 分开声明](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/command-verifier.ts:63)；[registry 的 ids/versions 分开提供](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/index.ts:235)；[ref 原样精确 lookup](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/index.ts:300)；[normalizer 不解析 @](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/normalize.ts:260)。
- **S38**：[2026-10-04 live xv6 正例方法与 assertions](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-04-live-xv6-supervisor-repair-run2.json:5)；[初次 grader 69/70](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-04-live-xv6-supervisor-repair-run2.json:62)；[第二次 grader 70/70](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-04-live-xv6-supervisor-repair-run2.json:483)；[nudgeCount](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-04-live-xv6-supervisor-repair-run2.json:494)；[证据 limits](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-04-live-xv6-supervisor-repair-run2.json:645)。
- **S39**：[live test 自动批准 seam](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-xv6-supervisor-repair.spec.ts:486)；[watchdog 提醒控制](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-xv6-supervisor-repair.spec.ts:688)；[前一次 live 失败记录](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-04-live-xv6-supervisor-repair.json:6)。
