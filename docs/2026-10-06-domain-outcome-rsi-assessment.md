# 通用 Singularity：领域结果如何参与 Task / Skill / Tool 的改进评判

研究日期：2026-10-06。Singularity 源码基线 `fa7c5999bbf9467731cabea87bb9ed2e60b23355`。本文补充 [graph4 架构评估](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-cosyvoice-architecture-assessment.md:1) 和 [Evolution 源码审计](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-rsi-source-audit.md:1)。研究只增加文档，没有修改运行时代码、部署合同、技能、验收器或 live graph，没有执行硬件构建或仿真。

## 1. 结论与问题定位

**Singularity 已预留通用的任务参数、执行方法、工具提供者和结果验收位置；尚未打通“用可配置的领域结果指标，评判可复用执行资产的改进”这条完整路径。** 芯片周期数可以参与某个 Task 的达标判断，但不能直接成为当前 Evolution 对两个已成功方法的晋升目标。

不需要为芯片设计增加专用角色、芯片字段或硬件搜索引擎。需要补的是通用实验评估 Interface：领域 Task 声明目标和评估配置，Skill 提供探索方法，Tool 产生测量证据，独立评估器比较两侧结果，Evolution 冻结并消费判决，随后发布被证明更好的 Task / Skill / capability-MCP 资产。

| 层次 | 当前已有的入口 | 当前缺口 | 归因 |
| --- | --- | --- | --- |
| Task | 自撰合同、递归分解、模板 primitive 参数、独立判据 | 本部署性能模板没有真正的强数值验收，参数 schema 也是空的 | 领域模板/fixture 配置不足；不是通用 Task 无入口 |
| Skill / system context | 每个 Run 冻结并装入所绑定 Skill 的完整正文 | 本轮方法没有要求 baseline、候选搜索、性能回归、方法迁移；通用 supervisor 把成功目标固定为 tool calls | 领域方法要求不足，以及通用 supervisor 策略限制 |
| Tool / MCP | 已有仿真、周期观测、PPA、回归工具；能力候选可改变执行提供者 | 有测量结果不等于有可信比较；本地回归结果会覆盖字段，没有自动 champion/history | 领域工具/证据组织问题 |
| Verifier | command 可运行任意领域 checker；也能注册有 selftest 的 Verifier | 返回 pass/fail/inconclusive，不是现成的业务数值优化协议 | 达标入口存在 |
| Evolution | 冻结、双侧执行、holdout、候选绑定、gate、apply、rollback | 成功目标只有 `tool-call-reduction`，比较器不读取芯片周期/面积等结果，也没有可配置业务评估器槽位 | 通用实验评判 Interface 不足，不能只补 prompt |
| 性能阶梯 | 实验与版本有持久账本 | 没有数值结果、晋升父版本与后续消费效果组成的领域性能阶梯 | 需接通结果证据，展示可由现有账本投影 |
| 实跑证据 | graph4 有配置调查、设计适配、真实 RTL 数值交付；历史 xv6 有方法发布后被新 root 消费 | graph4 没有领域性能的 baseline/candidate/apply/transfer 闭环 | 示例证据也缺，但不是唯一缺口 |

因此不是“没有架构入口 / 没有 prompt / 只缺案例”三选一。**任务执行入口已有；实验比较入口偏窄；领域方法和强验收尚未配置完整；实际样例也未证明性能自改进。** [S1–S10]

## 2. 源码实际能让什么参与评判

### 2.1 有效的通用配置位置

`TaskTemplate.parametersSchema` 支持 string / number / integer / boolean；`contract` 支持绑定参数，`decomposition` 是可复用 direct-child recipe。因此 chip、workload、资源上限、测量策略文件路径、阈值和搜索预算，可以由领域模板表达。复杂配置可放在被保护的输入文件中，不需要塞到通用内核。[S1]

`requiredCapabilities → capability.skills → Run binding` 真正决定执行者得到什么方法。冻结 Skill 正文被装入 contract context，不是放在磁盘上等待模型碰巧读取；所以可以在领域 Skill 里要求“先测基线、提出假设、验证候选、保留失败、提炼方法”。这不要求给所有 worker 无条件加优化任务。[S2]

`CommandVerifier` 支持 deterministic / simulation / measurement，按外部 command 的退出状态判断，并保存日志。领域 checker 能重算输出、解析真实周期、验证固定阈值；也可以注册专门 Verifier。平台不必理解 cycles 是芯片周期，或 latency 是服务响应时间。[S3]

但本轮 `bb-metric-measure@1` 的 `parametersSchema` 没有属性，mandatory command 是通用 `leaf_accept.py`；“指标满足阈值”只在 optional review 中。此部署不是强数值阈值合同的正例。通用清单检查的假阳性已有隔离反例，见前报告。[S4]

### 2.2 两个不同的 objective 不应混淆

Task 的 `objective` 是任务自然语言目标；Evolution 的 `ExperimentObjective` 是机器评判策略。后者类型、工具 schema、运行时验证均只允许 `tool-call-reduction`，不是任意字符串，也不是可注册比较器名。[S5]

现有比较器读取两侧的 outcome / criterion verdict / command，以及 agent 工具调用数；即使某工具报告芯片从 `C0` 变成 `C1 < C0`，两侧都 verified 时，这些数值没有进入晋升公式。`ReviewMetrics` 记录 agent 工程投入，不含通用业务结果数值。把 cycles 写到 evidence 或 prompt 中，不会自动改变 comparer。[S6]

Supervisor system policy 还明确要求：`For a verified source, evolution_replay must freeze objective tool-call-reduction`。Root 和 Worker policy 则把业务方法交给冻结 Skill。Role policy 确实注册进实际 agent setup。因此只有增加领域性能探索提示，仍会撞上成功实验的硬限制。[S7]

另一个容易误解的地方：账本允许记录 `tool` 目标，但当前可执行 apply target 只有 `skill`、`capability`、`task_definition`。现有 Tool/MCP 更新路径主要通过 capability candidate 绑定提供者，不应把记录了一个 tool proposal 说成已经任意修改并发布了工具源码。[S8]

### 2.3 现架构能做的最小性能案例

可以在**源 Task 开始前**冻结真实性能判据：功能正确且 `cycles ≤ T`。如果旧方法产物功能正确但未达该阈值，新方法达标，就可以沿现有 failure repair 路径比较 failed → verified；独立 holdout Task 仍须两侧通过。原 acceptance、checker、阈值与输入保持不变。[S6]

这种案例可以证明“资产更新帮助任务达到更好的性能目标”。它不提供两个已达标结果间的任意数值晋升，也不会自动支持一直改善的阶梯。不能看完候选后抬高阈值、把成功任务改成失败任务来绕过限制。

Holdout 的 maintained 目前来自判据结果，不是自动数值无退化。若想保证其周期不增加，必须在 holdout 原合同中预先冻结对应周期上限，或接入下述通用结果比较。一次仅有功能正确的 holdout 不能证明性能迁移。[S6]

另外，新 demo 每条判据都应在准入时明确 `verifierRef: "command"` 或实际注册 ID，版本由 registry 冻结；不能填 `command@1`。graph4 现存所有 Task 至少有一条缺 ref，不能直接拿来做 Evolution 样本，候选模板补 ref 不会修复旧样本。[S9]

## 3. 最小的通用改进 Interface

建议在现有 frozen experiment 处补一个 EvaluationSpec，而不是新增芯片子系统。以下是**设计建议，不是当前已支持的 schema**：

```yaml
evaluation:
  evaluatorRef: domain-outcome-comparator
  policyFile: fixture/evaluation.json
```

领域策略文件声明所需指标、测量条件、方向、最小收益、holdout 退化容限和资源约束。比如芯片任务选端到端 cycles 为主指标，面积/时序为约束；另一任务可以选测试覆盖、质量分数或服务吞吐。内核只认评估器的固定身份、输入、输出、判决和证据。

例如领域 adapter 可以冻结以下规则：`speedup = C_baseline / C_candidate`，训练集几何平均 speedup 至少为 `1 + δ`，每个 holdout 满足 `C_candidate ≤ (1 + ε) × C_baseline`，同时 correctness 和资源约束通过。`δ`、`ε`、聚合方法与时钟/计时区间都在搜索前固定。这里用的是抽象参数，没有预填本 demo 的实际收益。

这一个 Interface 应封装下面的行为：

1. **冻结评估规则。** 冻结 evaluator 的版本与代码/资源摘要、策略文件、数据集、聚合规则及 measurement 条件。两侧用同一评估器；更新某个工具时，不能同时偷换负责评价该工具的 judge。
2. **读取可信的两侧证据。** 输出 measurements 与来源，绑定 experiment / side / sample / Task / Run / artifact / simulator or provider identity；数值缺失、条件不一致或来源无法验证即 inconclusive。不要把业务结果塞成 agent 的 `ReviewMetrics`。
3. **重算晋升。** correctness 是硬门，主指标按固定规则改善，holdout 不超过约定退化范围，约束满足；gate / apply 在现有重新检查链上重算结果，不能只信模型或外部工具打印的 `improved: true`。
4. **形成可投影阶梯。** 扩展现有 experiment / apply 证据，保留所有候选与失败，记录前一 champion 资产版本、两侧数值和新任务消费记录。性能阶梯由账本投影；不需要另造一套学习数据库。

首版只需要一个主指标加硬约束。现有 tool-call reduction 与领域结果比较已经是两种真实需求，足以支持这个 seam；尚无必要引入多目标搜索框架、专家角色或自动权重学习。

配套 prompt 也应通用：Reviewer 检查“任务达标事实、领域目标和执行投入”；Supervisor 读取被冻结的 evaluation，依据其判决发布最小资产变化。领域 Skill 决定如何搜方案，Tool 决定如何测量。**不是让 root 理解并自行设计每个领域的奖惩函数。**

性能收益与执行成本应分开报告。例如芯片更快但 agent 更贵，仍可能满足用户目标；只有合同指定投入上限时才由此拒绝。若声称效率 RSI，则必须统计完整执行树和失败探索的总成本，不能只计最后成功候选。当前 experiment 的 toolCalls 汇总子 Run，而 tokens 仍保留根 Review 范围，需先修正这个口径。[S10]

## 4. 可使用的短芯片设计题目

推荐把 **“单核激活批次的设计方法自改进”** 拆成两级：第一级复用 Hibiki 已编译硬件，只考察 hart 0 上的 GELU / LEAKY_RELU 批次，实现并优化软件 mapping / 指令与搬运排程，检验 Task / Skill / Tool 更新能否改善真实 RTL 周期；第二级再做 ActBall 微架构探索，检验方法更新能否生成更好的硬件。

第一级反馈更短，但属于固定硬件上的方法优化；只有第二级真实改变 RTL/硬件配置并重新构建、测量，才证明了硬件设计探索。两级都能检验通用自改进链，不能把它们的证据混为一谈。

选择理由：

- 已有 `act_test.c` 覆盖 GELU / LEAKY_RELU，包含 8 与 256 元素、多个 slope 和浮点边界；Hibiki 原始 RTL 日志为 PASSED / exit 0。该日志没有给出本 demo 所需周期基线，仍要补周期测量与独立 holdout。[D1]
- 当前 RTL 按 read request / read response / compute / write request / write response 逐行推进，有可研究的微架构空间；潜在收益须实测，不能从状态数预填收益。[D2]
- 不选完整 CosyVoice：现有 RTL 分区 campaign 已用约 8.66 小时，且属于仿真完成过程，没有方法资产性能晋升阶梯。[S11]
- 不把 SMatMul `lane4/8/16/32.toml` 直接当搜索轴：当前执行 RTL 有固定 16 维实现，配置文件存在不证明参数参与生成。SNAKE 现有数值测试还发现 FAILED，不能当现成绿色性能基线。[D1]

### 4.1 第一级的具体入口

使用真实已有 `hibiki-tokgen-ctest-act_test-baremetal` 作为 seed；Hibiki 的 tokgen 已挂 ActBall 和 TraceBall，不必先新建 chip。领域 Tool 用 workload-build 的 CTest 路线构建排程候选，再通过 `bbdev_bebop_verilator_sim` 开启 pmctrace / ctrace / no_wave，复用冻结 RTL。新增 benchmark 的周期起止点和完整批次输出检查仍须由独立 fixture 准备。[D1][D3]

将多个独立的 GELU / LEAKY_RELU 小批次组成固定工作量，每个批次都必须输出并校验。由 agent 自行发现合法的 mapping 和排程优化；不提供候选代码或最佳解。冻结 ELF 产物与 simulator 身份，候选方法只能改善执行这一工作量的方式，不能减少工作量。

Task 参数可配置 `chip`、`workloadSet`、`evaluationPolicy`、`maxCandidates` 和 budget。Skill 要求测量→假设→候选→回归→方法提炼；Tool 负责真实测量。使用新通用 evaluation 时比较两侧业务周期；使用现架构时只在预先冻结阈值的 failed→verified 条件成立后走 repair。

### 4.2 第二级：硬件试题合同草案

下面是可用于配置领域 Task 的任务文本；**夹具、周期 checker 与评估配置尚需准备，本文没有部署或运行这个 demo**。不把优化补丁、最佳参数或已知解法交给执行 agent。

> 在指定冻结源码基线上，改进单核 ActBall 的 GELU / LEAKY_RELU 实现。保持既有 ISA、数值合同、bank 几何、时钟目标和其它 Ball 行为。自行调查瓶颈，提出并实际测试至少两个有不同机制的候选方案；在固定总预算内可以提前淘汰有证据表明不可行的方案。保留所有候选与失败证据。
>
> 训练任务先使用 32 / 256 元素 workload；夹具拥有未用于选择方法的 64 / 128 / 192 元素及独立 seed/slope 任务，均须满足 active 几何。允许修改范围、golden、checker、数据种子、计量起止点、性能阈值、面积/时序上限在执行前固定。所需新增性能基准是领域 fixture，不能让 agent 改判据为自己开绿灯。
>
> Tool 通过项目 MCP 构建并运行真实 RTL，记录输入已经准备好至输出可读取的完整端到端周期，覆盖 DMA、必要同步及硬件执行；CPU golden 校验放在计时区间外。Ball pmctrace elapsed 作为瓶颈分析辅证。BEMU 用于正确性预筛。固定 workload、频率与资源条件，不用宿主仿真 wall time 或 BEMU latency 代替芯片性能。
>
> 在同源独立 checkout 比较旧版方法和候选方法。提炼可复用的领域 Skill 或 Task recipe，通过实际 Evolution 绑定进行 replay、gate 和 apply。发布后必须让 fresh worker 从原始源码使用新版资产完成独立新任务，并验证性能收益；不能直接复制上次优化产物冒充方法迁移。若新方法只对训练数据有效，或耗尽预算仍未改善，保留明确失败结论。

面积与时钟约束要用可靠的领域测量；只有 generic synthesis 时只能声称固定流程下的 gate proxy，不把它冒充真实工艺面积或真实 Fmax。测量越复杂，短反馈越难，应先冻结最小可信条件。

若进一步要求新芯片拓扑，可先准备单 tile / 单 core / Act+Trace 的领域 fixture，再把设计方法与微架构改进交给 agent。冷配置生成、RTL elaboration 和 simulator build 是这一级新增成本，不能假定现成硬件路线的耗时仍适用。[D3]

### 4.3 怎样产生 RSI 证据

单条 `RTL v0 → v1 → v2` 曲线只证明设计优化。要证明 Singularity 执行方法的自改进，证据还必须包括：

| 阶段 | 实际执行 | 应保存的证据 |
| --- | --- | --- |
| 基线 | fresh worker 用方法资产 M1 在原源码上设计和测量 | 原合同、模型、绑定、工具版本、产物、周期、成本 |
| 反馈 | agent 从失败或瓶颈发现可复用方法问题 | 有因果依据的 diagnosis，而非人工给补丁 |
| 候选 | agent 生成 M2 Skill / recipe / provider，双侧从相同原源码执行 | baseline/candidate 数值、正确性、holdout、所有失败 |
| 发布 | 原 judge 下通过 gate / apply | candidate 与 applied 的字节/版本身份一致 |
| 迁移 | fresh worker 从原源码用 M2 完成新尺寸/新 seed 任务 | 实际绑定 M2 与独立性能收益，不能复用优化好的 RTL |
| 再改进 | 用新执行反馈产生 M3，重复固定评估与迁移 | M1→M2→M3 的方法版本和结果阶梯 |

一次 M1→M2 发布并迁移，可以证明受控的执行资产自改进。至少再走一轮反馈→M3，才开始支持“可以反复执行这条链”的主张；有限短例仍不能证明改进器自身能力持续增强或长期收益递归增长。任务分解深度和芯片核心数都不是这种递归的证据。

若不改通用比较器，第一轮只能利用预先冻结性能阈值后的 failure repair；若两侧本来都达标，应该将当前成功结果比较限制记录为实验结论。接入通用 evaluation 后，才能直接用数值改善验证 successive successful methods，而不必把每一轮包装成失败修复。

### 4.4 短时间的边界

优先使用已构建 simulator 校验测量/绑定/迁移链；这只能先证明固定硬件上的方法改进。真实 RTL 候选必须重建，输入小不会自动让冷构建变快。正式探索前用一个 focused RTL case 测实际冷/热耗时，固定最多候选数与总预算；反馈时间不合适就缩小题目，不能事后将未完成实验报告为 RSI 成功。

本文不承诺一小时或任何具体提升百分比，没有将现有 PASSED 日志当作该新 demo 已跑通的证据。

## 5. 并行应如何增强

当前同一 child batch 找一个 ready Task 并等待执行结束；同 checkout 维持单写者。独立 replay workspace 的隔离能力已有，但普通 DAG batch 和 Evolution 双侧目前仍串行。[S12]

建议通用增强为：**独立 workspace placement + 有界 ready 队列 + 资源声明/claim + 不可变结果交接**。候选之间先隔离 checkout、编译输出与日志；共享固定端口、工具进程、CPU/内存、综合资源等必须有独占或容量约束。复用现有 workspace ownership、持久身份、取消和恢复规则，不删锁，也不直接给现有循环加 `Promise.all`。

任务文本中的 `maxCandidates`、`maxConcurrentTasks`、总执行预算，与工具的 CPU slot 数可以分别配置。这些是通用执行参数，与芯片核数无关。为了归因，把两种实验分开：

- 评判方法是否产生更好的芯片：同一计算资源条件下比较 RTL 周期/正确性/面积等。
- 评判并行调度是否提高执行效率：相同任务集合比较完成 wall time、总成本和资源峰值。

agent 并行、仿真进程并行、芯片内部并行是三个不同事实。更多仿真进程缩短取证时间，不证明设计芯片本身更快。

graph4 的 `DangoSys/buckyball` 指向 live checkout，不能直接拿来做冻结 replay 输入；现有 snapshot 检查拒绝越出 snapshot root 的 symlink。demo 应使用自包含的真实源码快照，再让不同候选从它生成 workspace。[S13]

## 6. 建议执行顺序

1. 在领域 Task / Skill / Tool 中准备小题、强 judge、真实周期与完整绑定，不先做芯片专用平台功能。
2. 修正普通准入与实验冻结的 verifier identity 接线；加入一个通用 evaluation Interface，连同冻结、重算晋升和结果证据一起接通；成功源 supervisor 不再硬编码 tool-call objective。
3. 完成一次真实模型 M1→M2→fresh task 迁移，再尝试 M3；只有真实数值与资产消费都出现才展示性能阶梯。
4. 在独立 workspace 和资源 claim 上补有界并行，另外做同工作量的并行效率对照。

最值得保留的是 Task / Run / 资产冻结 / 独立验收这条主线。最值得补的是“业务结果如何进入通用改进判断”，而不是新增角色层级或把芯片知识写入 Singularity 内核。

## 源码与运行证据

- **S1**：[TaskTemplate 参数与 recipe](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/template.ts:80)。
- **S2**：[冻结 Skill 进入 contract context](/home/ROXY/code/bb_work/harness/packages/singularity/context/src/reads/contract.ts:127)。
- **S3**：[CommandVerifier 模式、日志与退出状态](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/command-verifier.ts:61)；[可注册 Verifier Interface](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/types.ts:43)。
- **S4**：[部署测量模板](/home/ROXY/code/bb_work/harness/.dsh/singularity/task-templates/bb-metric-measure@1.json:11)；[领域 chip Skill](/home/ROXY/code/bb_work/harness/environment/project4/.agents/skills/bb-chip-task/SKILL.md:10)。
- **S5**：[唯一 ExperimentObjective](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/contract.ts:184)；[replay 工具 enum](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-replay.ts:206)；[其它 objective 被拒绝](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/comparer.ts:145)。
- **S6**：[原判据比较与唯一 comparer version](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/contract.ts:58)；[修复/工具成本比较](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/comparer.ts:65)；[ReviewMetrics](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/types.ts:542)；[VerificationResult](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/types.ts:321)。
- **S7**：[reviewer / supervisor policy](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/prompts/coordination.prompts.ts:2)；[root policy](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/prompts/root.prompts.ts:3)；[worker policy](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/prompts/worker.prompts.ts:7)；[实际 system section 注册](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/index.ts:499)。
- **S8**：[可执行资产目标](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/types.ts:28)；[不支持目标的 replay 拒绝](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-replay.ts:249)。
- **S9**：[缺 verifierRef 拒绝冻结](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/freeze.ts:257)；[graph4 判据统计和现场快照](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-cosyvoice-architecture-evidence.json:1)。
- **S10**：[完整子树 tools / 根 Review tokens 的计量](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/record.ts:102)。
- **S11**：[graph4 拓扑适配的实际改动与测量边界](/home/ROXY/code/bb_work/harness/environment/project4/log/hibiki-topology/topology.md:194)；[RTL campaign 8.66 小时与无实验的记录](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/evidence/progress-log.md:756)。
- **S12**：[child batch 逐一执行](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/child.ts:560)；[workspace 单写者](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/workspace.ts:262)；[双侧并行及预算限制审计](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-05-round8-performance-review.md:50)。
- **S13**：[snapshot 外部 symlink 拒绝](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/workspace.ts:23)。
- **D1**：[现成 Act 测试](/home/ROXY/code/bb_work/buckyball/examples/balls/act/workloads/ctests/act_test.c:23)；[active tokgen Act/Trace 注册](/home/ROXY/code/bb_work/buckyball/examples/cores/tokgen/configs/balldomains/default.toml:27)；[Hibiki 真实绿色 RTL 日志](/home/ROXY/code/bb_work/buckyball/log/2026-10-06-01-12-hibiki-sims.verilator.BuckyballHibikiVerilatorConfig-verilator-hibiki-tokgen-ctest-act_test-baremetal/stdout.log:3)。
- **D2**：[Act 的逐行读/算/写状态推进](/home/ROXY/code/bb_work/buckyball/examples/balls/act/arch/src/main/scala/Act.scala:390)；[真实 cycle helper](/home/ROXY/code/bb_work/buckyball/bb-tests/workloads/lib/buckyball.c:10)。
- **D3**：[本轮 Buckyball 性能/工具/demo 来源审计](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-chip-performance-demo-source-audit.md:1)，包括覆盖结果保存、参数消费链、短题真实日志、构建入口及并行输出约束。
