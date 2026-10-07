# 通用 LLM 评估：当前接线与最小增量

日期：2026-10-06。源码基点：Singularity nested Git `fa7c5999bbf9467731cabea87bb9ed2e60b23355`；外层 Harness Git `c525f427bfea015c018b1d83782f4cfb3965085d`。本次只读源码调查，仅新增此文档；未调用真实模型、运行实验、测试或修改代码。

## 直接判断

**可以让 LLM 根据任务设计评估，并用通用运行器判断 task/skill/tool 改进收益；不需要每进入一个领域就新增专用 verifier。当前 Singularity 已有动态任务判据、通用命令执行器和 LLM 诊断，但尚未把“LLM 设计的评估计划 → 独立 judge 的裁决 → 改进收益晋升”连起来。** 最小增量是一个统一的、可冻结的 EvaluationPlan，加一个通用 LLM judge 和通用收益比较协议；无需逐领域扩展编排器。[F1][F2][F3][F4]

“不硬编码”应指任务相关 rubric、检查方法、阈值和收益指标按任务生成。仍应有少量固定平台语义：证据来自哪个 Run、双方是否使用同一评估计划、未知如何处理、哪些原始要求不能放宽。否则一次“改进”可以通过换尺子得到。[F5][F6]

下面先列当前事实，再给建议；建议部分均未实现。

## 当前已有与缺口

| 能力 | 源码事实 | 对用户设想的含义 |
|---|---|---|
| 动态设计任务检查 | `task_intake` 接受 Agent 提供的 description、command、mode、verifierRef、protectedInputs；目标从用户要求形成，admission 后固定。[F1] | LLM 已经能为每个任务写检查内容。领域知识可来自任务、仓库、文档与工具，不必写成平台分支。 |
| 通用执行 checks | `CommandVerifier` 支持 deterministic/simulation/measurement，运行任意 criterion.command，以退出码判定并保存日志；selftest 只证明 exit 0/非 0 的执行语义。[F2] | 动态生成脚本可以复用现有命令 verifier。执行器能正确运行不等于脚本覆盖了用户的要求。 |
| 通用 LLM 事后诊断 | reviewer 是独立 spawn 的模型 Agent，读取 Task DAG、原始 evidence、session、模板，并返回 observation/conclusion/confidence、六维 adequacy judgement 和改进建议。[F3] | 已经有跨领域 reasoning 和 task/skill/tool_fit 诊断，能发现哪些证据不足、哪些行为值得改善。 |
| reviewer 的授权与结果 | reviewerGrant 只授读工具；prompt 明确 `Do not score, and do not modify anything`；judgement 限六维 `adequate/inadequate/unknown`，必须引用当前图的实际记录，最终写 Diagnosis。[F3][F7] | 它不是执行验收或收益比较的 judge；也不能主动运行新的编译/仿真来取证。引用校验证明 ref 存在，不证明模型的解释正确。 |
| mode review/formal | 内置 `ReviewVerifier` 是占位，id=`review`、version=`1`，所有 review/formal 返回 inconclusive、`manual review required`，完全没有模型调用。[F8] | 把 criterion 改成 mode review 不会自动得到 LLM 评审。 |
| heuristic | heuristic 是证据性质标签；`unmetMandatory` 对任何 mandatory heuristic criterion，无论返回什么 verdict，都算未满足。[F9] | 当前不能把 `heuristic:true` 加到 LLM judgement 后期待任务 verified。应明确建模“LLM judgement 的可信等级”，不能去掉标签冒充确定性证明。 |
| verifier 扩展点 | 通用 Verifier 接口可 register；必须 version/selftest 等证据才能进入 Evolution；mandatory review/formal 允许显式非占位 `review` 的注册 settling verifier。[F4][F8][F10] | 可一次注册 `llm_judge` 来服务多个领域，不需要修改各领域源码。当前还没有这样的内置实现。 |
| supervisor | 读取 reviewer diagnosis、可再委派 reviewer，但明确 discussion/vote 不是实验；成功改善必须 `tool-call-reduction`，调用原双臂链，最后两次人批准。[F11] | 模型可以提建议、选实验样本，但无法自由定义已有 promotion 接受的收益标准。 |
| promotion 比较 | comparer 固定 failure→verified repair，或 verified 双方的 toolCalls 减少与 holdout 不退化；promotion 必须读这些计算结果、原 Task/Run/evidence 和冻结 judge。[F12][F5] | 没有 rubric score、质量偏好、时间/token/金额等动态收益计划的消费路径。LLM 说“更好”目前不是 promotion 的依据。 |
| 结构化裁决 | VerificationResult 主要是 pass/fail/inconclusive、verifier 身份、日志、details；ReviewCriterion 投影又只保留 verdict/身份/command/exit/log；FrozenCriterion 没有 judge model/prompt/rubric 身份。[F13] | 仅把分数写进 details 不能形成可信的动态收益闭环；需要规范的 evaluation record 和被冻结的 LLM judge 身份。 |

当前数据流实际是：**LLM 写任务判据 → verifier 判任务 → reviewer 解释既成判决 → supervisor 选候选 → 固定 comparer 决定实验结果**。缺的不是让 LLM 再说一段评价，而是让它设计和执行的评估成为有身份、能被双方复用和被晋升消费的证据。[F1][F3][F8][F12]

## 建议：一个通用评估计划，而非每领域一个评估器

### EvaluationPlan 的内容按任务生成

建议由已有 coordinator/supervisor 生成一份结构化计划，再由独立 evaluator 审视它与原用户目标的关系。计划只需包括以下几类信息，无须把芯片、论文、软件等领域塞进枚举：

| 字段 | 目的 |
|---|---|
| `goalRef`、`acceptanceDigest`、candidate identity | 确认评价的是原任务及哪项改动。 |
| `rubric` | 每项要求的含义、可观察证据、反例、unknown 条件；引用原要求，而不是只写一个抽象分数。 |
| `checks`、`evidenceRequests` | 生成脚本或选择现有工具/测试/参考样例，声明输入、输出和资源预算。LLM 可以读仓库后自行适配。 |
| `metrics`、`decisionRule` | 例如质量不退化且 wall time 降低，或冻结 rubric 的关键维度改善且预算满足；用通用的比较/约束表达。 |
| `samples`、holdout 与校准反例 | observed 与留出样本的来源；评价是否区分正确与错误、完整与仅“文件存在”。 |
| `judge` | evaluator model route、配置、prompt version/digest、rubric/checks digest、取证工具授权。 |
| `budget`、重复与不确定性处理 | 控制 evaluation 自身的资源，规定双方判断不一致或证据不足时如何结束。 |

这是新设计。现有 Task criterion/protectedInputs、experiment frozen block、judge registry 与 ledger report 可承载其大部分基础，不需要新建一套 DAG 或复制 Evolution 状态机。[F1][F5][F10]

任务相关检查内容可以动态，**计划必须在看 baseline/candidate 的比较结果之前冻结**。若生成候选后才设计评估，要限制 evaluator 只依据原任务、source failure 和独立参考确定尺子，不能根据 candidate 恰好做到的事情裁剪目标。holdout 的选择依据也应记录；模型见过所有样本时，换一个字段名叫 holdout 不构成独立留出。

### 最小执行流程

1. **拟定与质疑计划。** coordinator/supervisor 根据原任务生成 rubric/checks；独立 evaluator 检查每条原要求是否被覆盖、检查是否只测替代指标，并针对空产物、错误内容、伪造 summary 设计少量反例。无需默认再开一群评分 Agent：一次独立计划审查，证据冲突时再追加复核。
2. **冻结计划。** 运行器校验引用、工具可用性和计划格式，固化 rubric、checks、输入、judge model/prompt 与 decisionRule 的 digest。双方用同一份计划和输入；候选执行者不能写 evaluator 目录或 judge 提示。
3. **复用双臂执行。** 沿现有 replay 路径执行 baseline/candidate，不把 candidate 的解释当结果。指标从全执行树和运行器记录取得；领域结果由 evaluator 请求独立工具取证，raw output/exit/status 留存。生成脚本走隔离执行，不授 evaluator 修改交付物或基线。
4. **独立 judge。** 一个通用 `llm_judge` 在相同 rubric 下读取匿名 A/B 产物、原始证据和必要参考，逐项输出满足/不满足/unknown、精确 evidence refs、理由。能用工具复核的事实先复核；无法确定的项保留 unknown。顺序盲化/对调复判仅在高风险或明显位置偏好时使用，避免每个低影响任务都承担多模型投票成本。
5. **确定地消费裁决。** 通用 comparer 根据冻结 decisionRule 汇总结构化结论、测量数值和关键验收，而不重新让 candidate 选择如何解释分数。证据不足或冲突给 inconclusive；有实质收益且 guards 不退化才进入既有 gate/approve/apply。记录评估自身开销，使收益不是通过增加大量评估成本得到。

动态 LLM 评估和稳定比较规则能并存：平台只实现通用“约束、比较、未知、证据身份”语义，任务为它填入 rubric、测量与阈值。无需每个新领域新增一个 `if domain === ...`；也不应允许比较阶段任意执行一段候选自己提供的代码来决定它是否获胜。

### 四项通用增量即可形成第一版

| 增量 | 建议接在现有位置 | 最小职责 |
|---|---|---|
| 计划准备与冻结 | experiment prepare/freeze | 增加 `evaluationRef/digest`；所有 run 绑定相同版本；admission 时能固定 judge 和原 acceptance。 |
| 通用 judge | VerifierRegistry 注册一个 `llm_judge`，支持 review 模式 | 读取冻结 plan；通过独立 session/模型和受限取证工具产出标准裁决。明确 `assurance: model-judgement`，不要叫 deterministic。 |
| 结构化评估记录 | Evidence/experiment ledger | 存 rubric verdicts、metric 数值、raw refs、judge session/model/prompt、输入/plan digest、费用与 unknown 原因；避免把分数藏进 details。 |
| 通用比较目标 | replay comparer/promotion | 支持被冻结的 metric/rubric 约束；保留现有 binding、holdout、production baseline 检查，复用已有 publish 流程。 |

初版可仅作为补充的改进选择证据，**保留当前硬验收兜底**。完成端到端验证之后，再允许明确适合人工/语义评价的 task 以通用 LLM verifier 作为 mandatory review judge。这样仍然无需领域专用 verifier；只需选择哪些要求适合模型判断。

## 哪些东西可变，哪些不应被“改进”顺手改掉

- **可变的是评估方案的生成。** 新任务、新问题可以生成不同 rubric、checks、度量和预算；同一任务的实验外可形成下一版计划。
- **一次比较内固定的是尺子。** 原任务要求、judge prompt/model、checks、输入及判定规则在双方执行前冻结。评估方法有新版本就开新实验，不能改旧报告再晋升。
- **原验收不是免费变量。** candidate 改 TaskTemplate 的执行或分解可提高通过率；若同时放宽其验收，不能用该新验收证明自己更好。现有 template criterionRepair 已要求正/反例与独立 parent oracle，且 parent oracle 当前限定 deterministic command；通用 LLM oracle 若要进入这条路径，还需要扩展其明确的 assurance 与冻结规则。[F6]
- **评估器本身的改进需要上一级固定标准。** 新 judge/rubric 作为 candidate 时，必须在未由它自己重标的样本与固定要求下证明判别力、错误接受率或评估成本改善。不能因“自己给自己分数更高”就叫 evaluator RSI。

“任意任务都能由 LLM 自动设计可靠验收”目前不能作为承诺。模型可以生成领域检查，但事实依然要来自产物、数据、可信参考与可执行工具；例如 RTL 行为需要仿真或形式证据，LLM 文字不能代替它。主观表达质量、方案完整性等可以直接用冻结 rubric 的 LLM 判断，但应保留其模型判断属性。**可以消除每领域评估器的手工编码，不能消除每领域的事实来源和测量工具。**

## 源码锚点

- **F1**：[task_intake 的目标、动态判据与 protectedInputs 参数](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/task-intake.ts:31)；[criterion 自由描述/command/ref/heuristic 数据结构](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/template.ts:5)。
- **F2**：[通用 command verifier 执行与 selftest](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/command-verifier.ts:61)。
- **F3**：[reviewer spawn 与 prompt](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/review-run.ts:287)；[六个 judgements 维度与三值裁决](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/types.ts:608)。
- **F4**：[通用 Verifier/VerifyRequest 接口](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/types.ts:42)；[注册与 positive/negative selftest 闸](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/index.ts:154)。
- **F5**：[冻结 registered verifier id/version 与 protectedInputs digest](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/freeze.ts:242)；[promotion 重查原 task 合同 digest/输入](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/binding.ts:161)；[promotion 重查 Run、judge、provider 与收益](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/promotion/skill.ts:77)。
- **F6**：[修改 template child criteria 要 criterionRepair](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/task-definition.ts:99)；[independent parent oracle 当前只接受 deterministic command 非 heuristic criterion](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/task-definition.ts:248)。
- **F7**：[reviewer 只读 grant](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/review-run.ts:38)；[judgement 格式校验](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/review-run.ts:118)；[refs 必须在图内，并写 Diagnosis](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/review-run.ts:389)。
- **F8**：[ReviewVerifier 一律 inconclusive](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/review-verifier.ts:6)；[mandatory review/formal 必须显式 settling verifier](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/admission.ts:186)。
- **F9**：[mandatory heuristic 永远算 unmet](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/verify.ts:42)；[heuristic 不可同时带 composite childEvidence](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/admission.ts:103)。
- **F10**：[registry dispatch、protectedInputs、version stamp](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/index.ts:300)。
- **F11**：[supervisor 读证据、调用 review agent、实验固定目标与批准](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/handoff-rules.ts:347)。
- **F12**：[固定 comparer 的 repair/tool-call-reduction 与 holdout 汇总](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/comparer.ts:65)。
- **F13**：[VerificationResult 没有结构化 rubric scores](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/types.ts:321)；[ReviewCriterion 只投影有限结果字段](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/verify.ts:121)；[FrozenCriterion 的当前 judge 身份字段](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/contract.ts:296)。
