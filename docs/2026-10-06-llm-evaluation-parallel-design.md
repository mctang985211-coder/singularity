# LLM 主导的通用评价与普通 Task DAG 并行：原因和改造设计

日期：2026-10-06，Asia/Shanghai。Singularity 基线 `fa7c5999bbf9467731cabea87bb9ed2e60b23355`。本次为源码研究、现有并发用例复验与改造设计；没有修改运行时代码、部署合同或 live graph。延续 [业务结果 RSI 研究](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-domain-outcome-rsi-assessment.md:1)，依据用户补充，进一步缩小评价 Interface，避免要求各领域人工实现评估器。

## 1. 评价可以由 LLM 主导，不需要逐领域硬编码

**可以把“选评价维度、生成评估方法、调用取证工具、综合判断效果”交给 LLM。** 通用内核不需要内置 chip cycles、面积、质量分数或各领域阈值，也不必要求每次由人写新 evaluator。

适合的实现是一个通用的、带工具的 LLM Judge。它输入原任务合同与原始证据，先产生评估计划，冻结后比较 baseline/candidate 的实际执行结果。LLM 必要时可以生成测量/检查脚本，并通过现有工具执行；这样每次适配由 agent 完成，通用平台只保存计划、证据与判决。

“全部交给 LLM”要区分两件事：

| 工作 | 可由谁负责 | 平台保留的责任 |
| --- | --- | --- |
| 确定哪些目标体现任务收益 | LLM 从用户目标和合同推导 | 保存依据；不得把新偏好当成用户已确认要求 |
| 生成 rubric、采样/取证方法、必要脚本 | LLM；已有方法优先复用 | 在候选执行前固定计划身份和受保护输入 |
| 构建、仿真、数值计算和原始数据读取 | LLM 选择并调用真实 Tool | 保存真实工具结果、来源、运行身份和错误 |
| 评判可读性、方案取舍、因果解释与综合收益 | 独立 LLM Judge | 明确为模型判决，保存支持/反对证据与不确定性 |
| 检查身份、预算、原验收、双侧输入一致、发布目标 | 现有 runtime | 机械执行；模型意见不会重写这些事实 |

所以可以自动化整个评价过程，但不能让模型仅凭文本猜出硬件周期或替工具生成“测量事实”。这不是芯片特例，测试是否执行、延迟是否测得、文件是否来自这次 Run 等领域都需要实际证据。

### 1.1 最小 Interface

不需要为各种指标设计庞大的固定参数表。Task 保留自然语言目标；LLM 产生一份计划文件，内核固定它的身份。示意如下，**这是建议，不是当前支持的类型**：

```ts
interface EvaluationPlan {
  goal: string
  rubricRef: { path: string; sha256: string }
  judgeBindingDigest: string
}

interface EvaluationJudgement {
  verdict: 'improved' | 'not-improved' | 'regressed' | 'inconclusive'
  findings: { claim: string; evidenceRefs: string[] }[]
  uncertainties: string[]
}
```

rubric 文本可以包含任意领域的取证和比较规则、资源约束、主观取舍；可复用 Skill 指导生成，Tool 提供测量。在实验中还需引用两侧 Task/Run、样本、数据与产物身份，继续使用已有冻结与绑定机制。Judge 的模型、prompt、Skill、工具权限与计划一起冻结，不以一个可被换写的文件路径当作固定评价器。

执行流程：

1. 从用户目标/原合同生成计划，读取已知 baseline 事实可以帮助选取证方法；在选择和执行 candidate 前固定评价计划。原 acceptance 继续保留。
2. 从相同输入分别执行旧方法与候选方法，使用相同计划和 judge binding。独立 holdout 不参与选择 candidate。
3. Judge 从原始日志、产物和真实工具结果取证，必要时执行被冻结的检查；综合两侧结果，输出判决、证据引用和不确定性。
4. Evolution 检查原验收、身份、预算和证据完整性，再消费该判决决定 gate；apply 复查同一判决所依据的固定证据。LLM 调用的完整响应保存，机械复查不把“重新采样 LLM 得到另一答案”当成确定重算。
5. 发布后由 fresh worker 消费更新资产，在独立新任务上验证效果；据此继续下一轮。

多参数由领域计划和工具承担，内核只处理通用协议。只有计划生成未能确定用户目标时才按已有问答合同澄清；不要求每次都人工审批一个评分公式。

### 1.2 不能把自改进与改判据混成一次变化

同一实验使用同一 plan / judge。若候选同时改方法与打分规则，就无法判断变化来自更好的产物还是更宽松的评价。评价方法本身也可以由 LLM 提出改进，但那是下一项独立资产改进，必须用独立的已知正/负样本检验；随后新实验固定新版本，旧实验保留原规则。

独立 Judge 的身份指职责、上下文和权限分开，不要求每次启动一群模型投票。它先读证据而非执行者的成功摘要；对于主观指标保留模型判决性质。机械验证或真实测量已经能回答的事实，以工具结果为依据。

### 1.3 当前源码与上述方案之间的差距

- 当前 `ReviewVerifier` 没有调用 LLM，review/formal 恒返回 inconclusive。[E1]
- 现有 Reviewer 是 LLM 因果诊断者，可以解释 Task/Skill/Tool 问题，但诊断不结算验收，也不决定业务收益。[E2]
- 当前 `heuristic=true` 的 mandatory 判据即使返回 pass 也不会满足 mandatory acceptance。这是明确控制流，不能把一个模糊模型评分直接当作已接好的验收接口。[E3]
- VerifierRegistry 已有通用注册 Interface；现有 replay / freeze / promotion 也已有证据身份。不必从头建实验平台。[E4]
- 当前成功优化仍固定 tool-call-reduction。需接入通用 judge verdict，并修改 Supervisor 的强制 tool-call policy；只生成一份 rubric 不会改变晋升比较器。[E5]

首版可以让通用 LLM Judge 只负责 **Evolution 两个成功方法的收益比较**，继续用原 mandatory verifier 保证任务达标；涉及主观验收的任务，再显式声明接受何种判决与不确定性。这两个用途不应由同一个未标记的 pass 混在一起。详细源码核查见 [LLM evaluation 来源审计](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-llm-evaluation-source-audit.md:1)。

## 2. graph 并非底层完全不能并发，普通 child batch 没有并行调度

精确表述是：**当前普通 Task 子树的业务执行按同一工作区串行推进；底层 runtime 已能让独立工作区的 replay 同时在途。** DAG 可以表达独立依赖关系，但当前 driver 不利用它并发启动 ready children。

本次实际运行已有集成用例：第一个 replay 停留在 ws-a，第二个 ws-b replay 完成 verified，随后取消第一个，并验证两侧产物不互相出现、ownership 全部释放。该用例在同一个 task store 中运行，说明不是只能多进程/多 store 并行。模型被测试 worker hook 替换；结论仅覆盖 runtime、workspace、verifier、取消与隔离接线，不证明真实模型吞吐或普通 DAG 并行。[P1]

### 2.1 原因与源码锚点

| 原因 | 具体实现 | 为什么单改 scheduler 不够 |
| --- | --- | --- |
| 只找一个 ready child | `pending.find(...)`，启动后 `await driveChildRound` | batch 不维护多个在途任务，依赖等待会阻塞后续独立任务 [P2] |
| 一个 batch 一个执行目录 | `OrchestrateEnv.workspacePath/workerCwd` 共享给普通 children | 两个 worker 的相对输出、配置生成和验收输入会冲突 [P3] |
| 同 checkout 一位写者 | ownership stack 按 run→batch→child→verifier 交接 | 第二个 child 不是原 batch 顶层 owner 的合法接收者 [P4] |
| 恢复只重建一条路径 | `children.length > 1` 直接报错 | 即使首次运行并发，重启会拒绝恢复 [P5] |
| 参数也限定一位写者 | `maxConcurrentWrites !== 1` 拒绝启动 | 把配置改成 4 不会解锁并行 [P6] |
| 依赖产物借共享目录交接 | handoff 提供 evidence IDs，worker/command 默认在共用目录工作 | 隔离之后必须显式物化依赖产物，不能假定文件还在原位置 [P7] |
| 外部 Tool 可能有全局写路径 | Buckyball output 按 chip 命名，config-install 扫所有芯片 | 只换 agent cwd 不能隔离公共 MCP 服务/构建目录 [P8] |

Task store 的事件写队列不是必须消除的原因。它只串行提交事实，worker 模型/工具执行可以并行；保持有序提交有助于身份与预算一致。事实上上面的并发用例正是在同一 store 的现有队列上通过的。[P9]

Evolution 自己的双侧 runner 当前也串行，并带“前侧结算成本后决定下一侧”的预算逻辑。普通 DAG 变并行之后，不会自动把 experiment runner 变并行。[P10]

## 3. 可实施的最小并行改造

保留每个 checkout 单写者。把执行单位从“整个图共用一份可写环境”调整为“每个需要并行的 Run 有独立执行环境”，所有并发都受通用容量约束。

### 3.1 执行合同与持久事实

建议把 placement 放在 Run 上，一次尝试具有一次明确的运行地点。下面是**待实施类型草案**：

```ts
interface RunPlacement {
  workspaceId: string
  inputSnapshotDigest: string
  toolEnvId: string
  dependencyEvidenceRefs: string[]
}
```

运行前物化所选输入和依赖产物，为 Run 固定 workspace / tool environment；placement 随 Run start 事实持久化。cwd、MCP root/component 路径、构建输出、日志、verifier 和保护输入都从同一个 placement 解析，不能只覆盖 spawn 的 cwd。保留原 Task/Run/Session 身份，不新增第二套任务账本。

LLM 可以判断可独立的目标、编写 dependsOn 和建议资源声明；runtime 执行已声明依赖与实际隔离，不能仅凭“修改不同文件”的自然语言承诺解除同 checkout 的锁。

### 3.2 有界 ready 调度

将 driver 改为维护 ready 与 in-flight 集合：

1. 从 store 读取依赖结果，按固定顺序选择尚未启动且依赖 verified 的节点。
2. 在一个串行准入事务里检查并预留 run budget / 并发名额，防止多个分支各看到最后一个可用名额。
3. 为选中节点准备独立 placement，启动并登记，继续启动其余可运行且有容量的节点。
4. 在途任务完成或依赖状态变化后重新计算 ready；**无 ready 但有在途任务时等待，不能把“依赖还在跑”误判为失败。**
5. 真实依赖失败只阻断依赖它的后继；独立分支继续。父任务等完整 batch 收口后再集成和提交。

图级/运行时容量是新通用配置，例如 `maxActiveWorkers`。不要把每工作区的 `maxConcurrentWrites` 改成多写者。`waiting_children` 的协调父节点不能一直占用其子节点必须取得的执行名额，否则递归分解会产生名额死锁；工具作业的资源占用另由 tool resource claim 负责。

### 3.3 Tool 资源与结果集成

Tool/capability 描述真正共享的资源，运行时做互斥或容量 claim：工具服务根、固定端口、输出目录、仿真/综合资源、CPU/内存等。隔离环境能消除的冲突优先隔离，不能隔离的明确串行。资源等待作为可观察的调度状态，不把它写成业务任务失败。

独立 worker 产出不可变 artifacts 或 patch，依赖消费者从明确版本获取输入。写入主 checkout 的整合由一个有明确 acceptance 的 Task 完成；有冲突就报告/解决，不对不同工作区的修改自动覆盖。PPA、功能仿真等可从相同不可变设计快照独立读；候选设计之间用不同 snapshots。

### 3.4 恢复与取消

恢复遍历所有未结算 Run 的 placement，逐工作区重建 ownership 与执行绑定，再恢复原 Session；不再假定每个 batch 只有一个 running child。已 verified 结果不重做。单支失败/取消只处理其工作区和声明资源；graph cancel 停止并 drain 全部在途 worker/tool，再释放 claims。未知执行结果保留为需核查事实，不能悄悄重启同一非幂等动作。

现有 session workspace map 是进程内记忆，常规恢复从 graph env 及一条 ownership stack 重建；新的多 Run placement 必须成为持久事实，不能靠内存 Map 扛重启。[P3][P5]

### 3.5 生产改动位置与验证要求

| 改动 | 主要位置 |
| --- | --- |
| Run placement 的类型、start 事件、校验与投影 | `task/src/types.ts` 与现有 events/reducer/schema |
| 工作区分配、依赖产物物化与工具环境绑定 | `task-runtime/src/service/env.ts`、`sessions.ts`、workspace 相关实现 |
| ready/in-flight、名额预留、收口与局部失败 | `task-runtime/src/orchestration/child.ts`、`batch.ts`、`service/drivers.ts`、root budget |
| per-Run 验收与恢复 | `orchestration/settlement.ts`、`service/root-intake.ts`、`sessions.ts` |
| 排队原因、运行地点、在途状态 | 现有 graph snapshot/context/web 投影 |
| 实验样本并行 | 在上述机制稳定后改 `evolution/src/experiment/runner.ts`，单独固定预算语义 |

必须覆盖以下可观察行为：两个无依赖节点实际重叠；diamond DAG 的汇合节点等两侧 verified；一支失败时独立分支继续；同资源节点按 claim 排队；同 workspace 第二写者仍拒绝；预算剩一名额时不能启动两份；两个运行节点中途重启恢复原身份；全图取消后没有遗漏进程/claim；普通 replay 与领域工具路径不串目录。真实吞吐另用相同工作量对照，不能仅靠测试同时 parked 的事实宣称加速倍数。

## 4. 推荐先做哪一步

评价方面，先接一个通用带工具 LLM Judge，复用当前 Review / freeze / evidence / gate，不逐领域写 evaluator；让生成的 rubric 与取证脚本成为可复用资产。保留原 mandatory 验收，逐步扩展成功方法的收益判决。

并行方面，先实现 **独立 workspace 的普通 sibling Task 并行**，配置小容量，完成失败、依赖、恢复和取消测试；再接领域工具资源 claim 与结果集成；最后启用 Evolution 样本并行。工作区、工具输出和持久恢复尚未隔离时，不开放多个 writer 到同一个环境。

这可以保持 Task / Skill / Tool 的通用架构，并让它支持真实独立探索、并行取证和基于业务结果的自改进。

## 5. 本次复验

在 Harness 根目录运行：

```sh
pnpm exec vitest run --project integration packages/singularity/tests/integration/replay-workspace.spec.ts -t 'keeps two named workspaces independent' --maxWorkers=1
```

结果：1 test passed，8 skipped（名称过滤），正常退出；总进程时长约 1.50 秒，测试体约 85 ms。测试使用独立临时环境与 worker hook，没有调用 live graph 或真实模型，也没有运行芯片构建/仿真。这不是普通 child batch 已支持并行的证据。

用户追加逐阶段探索问题后，再运行：

```sh
pnpm exec vitest run --project integration packages/singularity/tests/integration/k1-exploration.spec.ts -t 'carries one parent through an investigation batch' --maxWorkers=1
```

结果：1 test passed，15 skipped（名称过滤），正常退出；总时长约 2.28 秒，测试体约 251 ms。原验收、两个累计 batches、调查证据被第二批消费、父任务独立验收均由真实 runtime/verifier 检查；模型决策是 scripted，不能算作自主探索的真实模型实跑。

## 6. Task 自行生成下一阶段与节点身份

用户进一步询问：Task 是否能先分析探索，再写出下一阶段任务/模板，支撑同一种模型分层处理大型目标？**普通任务生长的入口已实现，提示方法也不是完全空白；不足之处是稳定 Worker 身份没有清楚表达这种自主权，状态投影也没有展示有效分解许可。**

### 6.1 当场生成任务与发布模板分别已有入口

| 行为 | 当前支持 | 所需路径 |
| --- | --- | --- |
| 检索并绑定已有模板 | 是 | `task_template_list` + exact `templateRef` / parameters |
| 探索后自撰下一阶段目标、判据、能力、依赖 | 是 | `task_decompose` 的 free children 合同；不需要先发布模板 |
| 一批调查结束后再生成一批实施任务 | 是 | 同一 Run 多个累计 batches，batch end 回到 active；同时只允许一批未结束 |
| 子节点自行递归分解 | 是 | 每个 worker baseline 都有 `task_decompose`；默认允许已标 leaf 的节点再拆 |
| 写一个可复用模板草稿 | worker 可产出草稿；root 可用结构化 Evolution candidate 表达 | 草稿是产物，不自动成为目录中的可执行版本 |
| 首发/更新正式 TaskTemplate | 是，有角色与评估发布限制 | Evolution `task_definition` candidate → prepare → replay/gate → decide/apply |

核心能力不应被表达成“每个阶段先创建并发布模板”。探索后直接自撰新合同即可推进业务；有可复用价值时再提炼模板。普通 worker baseline 没有 Evolution tools，root 在开关 on 时有，supervisor 在受控授权下有；不能因为磁盘能写就绕过模板版本/发布。详细入口核查见 [逐阶段分解源码审计](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-task-progressive-decomposition-source-audit.md:1)。[T1–T3]

当前默认 `allowRuntimeDecomposition=true`、`maxDepth=4`、`maxChildren=8`，本部署没有显式覆盖这些字段。leaf 是父的原子性预判，运行时仍允许节点发现自己需要下一层；达到深度/子数/根预算、等待已有 batch 或问题未解决时有明确准入限制。[T4]

本次复验 `k1-exploration.spec.ts` 的调查→实施用例。它证明：调查产物成为下一批 `requiresArtifact`，同一个父 Run 累计两批，父验收保持原样，整个过程没有调用 diagnosis/Evolution。但模型行为由脚本预编排，因此它证明机制接通，不能证明任意真实 LLM 能自主提出有效探索问题。[T5]

一个模型类型可以承担不同层的节点，平台提供独立 Session 与任务责任范围；不是一份单会话在后台替所有节点思考。父只定义本层结果和直接孩子，子节点负责自己的方案与下一层。已审计 graph4 的真实模型递归提供有限工程证据，尚未证明长期自生长搜索或性能 RSI。

历史 `2026-10-03-live-task-growth.json` 记录真实 DeepSeek 模型选择已有模板、递归到 depth 2、按依赖执行并通过根 checker；对应 spec 使用真实上游请求。测试任务明确要求协调，而且给定模板已含子 recipe，所以证据支持真实模型的递归执行和模板复用，不能外推为开放式多阶段探索、模型自主创作新模板或 RSI。[T11]

### 6.2 当前提示已经要求了什么，哪里还欠明确

- root 稳定 policy 明确协调完整目标，工程调查和实施委派给 Task workers。[T6]
- `task-coordination` 明确：适用模板优先，无模板则自撰合同；只定义本层；批次结束检查证据后继续委派剩余工作。[T7]
- `task_decompose` 工具说明明确每个调用者拥有完整结果、子节点可继续分解；schema 有 free objective / criteria / capabilities / dependsOn / decomposable。[T1]
- graph4 绑定的 `bb-orchestrator` 也明确孙层由子决定、批后可继续派发。[T8]
- **稳定 Worker policy 主要是执行、问答和提交纪律，未显式说明“你可以分析原子性、先探索、继续生成下一批、承担下一层协调”。** 普通执行叶绑定领域 Skill，未必得到 task-coordination；工具 schema 的规则虽可见，身份层的表达仍弱。[T6]
- 当前 contract 渲染 role、depth、`decompositionStatus`，dynamic 渲染 phase 和 related tasks；`templatesFor` 实际消费 `allowsRuntimeDecomposition()`，自动注入可见模板目录和无适用模板可自撰合同的提示。因此不是完全没有可发现性。缺的是结合 leaf、深度、phase 和预算显示本 Run 有效分解许可与具体原因；不能把状态字段 leaf 当作完整权限解释。[T9]

设计文档的 Worker 模板已有较清晰描述，但那段文档不是实际稳定 prompt；其引用的 `context/src/projections.ts` 也已经拆为 reads/render。判断以真实装配和源码为准。[T10]

### 6.3 推荐的身份、方法与状态分工

**稳定 system policy 明确通用职责，Skill 承载方法，动态 context 展示实际允许动作。** 不把每个芯片探索阶段写进 system prompt，不要求为了获得核心任务分解认知而在每个叶绑一整份协调 Skill。

建议在 Worker 稳定政策开头增加下面这段内容，原有保护输入、问答、提交和权限纪律继续保留。以下是**可审查文本草案，未修改生产 prompt**：

> 你对当前 Task 的完整结果和原验收负责。根据实际范围和证据，决定直接实现局部结果，或通过 task_decompose 协调直接子任务；当前工具权限与运行状态决定允许的动作。
>
> 若重要未知会改变后续方案，先安排有明确证据产出的有限调查，再根据其结果自撰或绑定下一阶段合同。只定义当前能够确定的直接子目标，给子节点保留选择方案和安排下一层的责任。
>
> 子批次结束后，读取实际结果、失败和未解决事项，对照本 Task 的剩余要求，再决定下一批、局部实现或提交。孩子通过后，你仍负责组合结果；不要因 batch 结束就默认本 Task 已完成。
>
> 适用模板先复用；没有适用模板时可自撰合法合同。发现可复用改进时，生成有证据的 Task/Skill/Tool 候选，并通过当前获授权的共享发布路径处理。

对于 root，进一步明确“可以逐阶段委派调查并根据证据生成下一批”的身份；它仍遵守当前 root 只协调的权限。Reviewer 负责诊断原因，Supervisor 负责可复用方法改进；通用收益 Judge 的职责要与这两者区别明确，但可复用已有运行和上下文装配。

动态 context 应由 runtime 的实际规则派生 `canDecompose` 及拒绝原因、当前/最大深度与剩余已知预算；不在 prompt 另写一套可漂移的状态机。重要限制在模型决定前可见，可减少“反复调用工具才发现权限”的成本。

### 6.4 判断边界

**渐进探索和递归分解主要需要把已有入口表达清楚、配置合适方法并验证模型行为；并行与通用收益评判则确有运行时缺口。** 新增一套“下一阶段生成器”会重复 task_decompose 的职责。应先做清晰的节点身份与反馈决策提示，再用真实模型测试“调查结果确实改变下一阶段合同”，而不是只看图变大。

后续验证要使用未预排方案的任务：调查发现两种不同事实时应产生不同的下一批；本地原子问题直接完成；大型子系统自然递归；没有适用模板也能形成完整合法合同；工具/预算不足如实报告；原验收不被更改。脚本化控制面测试与真实模型决策证据分别保存。

## 源码锚点

- **E1**：[ReviewVerifier 占位](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/review-verifier.ts:6)。
- **E2**：[Reviewer policy](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/prompts/coordination.prompts.ts:2)。
- **E3**：[heuristic mandatory 不满足验收](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/verify.ts:42)。
- **E4**：[Verifier Interface](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/types.ts:43)；[注册实现](/home/ROXY/code/bb_work/harness/packages/singularity/verifier/src/index.ts:155)。
- **E5**：[唯一成功 objective](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/contract.ts:184)；[比较器](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/replay/comparer.ts:65)；[Supervisor 强制工具调用目标](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/prompts/coordination.prompts.ts:4)。
- **P1**：[两个同店独立 workspace replay 同时在途的集成测试](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/replay-workspace.spec.ts:247)。
- **P2**：[单个 ready 选择与 await](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/child.ts:560)。
- **P3**：[共用 OrchestrateEnv 与 named workspace](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/env.ts:114)；[session workspace map 与 MCP root](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/env.ts:188)；[释放后删进程内 map](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/drivers.ts:113)。
- **P4**：[child 单写者 handover](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/child.ts:453)；[ownership stack 交接](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/settlement.ts:363)；[verifier workspace 排他读取](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/settlement.ts:419)。
- **P5**：[恢复重建单条 writer 路径与多运行节点拒绝](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/sessions.ts:116)。
- **P6**：[maxConcurrentWrites 只接受 1](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/root-budget.ts:186)。
- **P7**：[dependency evidence handoff](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/child.ts:347)；[普通 child cwd](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/child.ts:476)。
- **P8**：[领域 Tool 共享输出与全芯片配置生成来源](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-chip-performance-demo-source-audit.md:89)。
- **P9**：[Task store 串行提交队列](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/service/store.ts:141)；[启动前预算检查与后续 await](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/child.ts:284)。
- **P10**：[Evolution 串行双侧循环](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/experiment/runner.ts:136)；[已审计的实验预算/并行限制](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-05-round8-performance-review.md:50)。
- **T1**：[分解工具的自撰合同、递归职责与参数](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/task-decompose.ts:13)。
- **T2**：[普通 worker control baseline](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/capability.ts:74)；[root Evolution allow-list](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/index.ts:433)。
- **T3**：[TaskTemplate 参数与 direct-child recipe](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/template.ts:80)；[Evolution 可发布对象](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/types.ts:28)。
- **T4**：[默认配置](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/config.ts:165)；[leaf 有效分解规则](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/admission.ts:175)；[实际部署配置](/home/ROXY/code/bb_work/harness/config.yml:180)。
- **T5**：[调查→实施两批与原验收保留的集成用例](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/k1-exploration.spec.ts:215)。
- **T6**：[root 稳定身份](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/prompts/root.prompts.ts:3)；[worker 稳定身份](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/prompts/worker.prompts.ts:3)；[真实装配](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/index.ts:499)。
- **T7**：[协调 Skill 的自撰与本层分解](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/skills/task-coordination/SKILL.md:14)；[batch end 后再委派](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/skills/task-coordination/SKILL.md:24)。
- **T8**：[本轮 bb-orchestrator](/home/ROXY/code/bb_work/harness/environment/project4/.agents/skills/bb-orchestrator/SKILL.md:14)。
- **T9**：[context 可分解读取声明](/home/ROXY/code/bb_work/harness/packages/singularity/context/src/bindings/types.ts:85)；[自动注入模板目录及自撰提示](/home/ROXY/code/bb_work/harness/packages/singularity/context/src/index.ts:191)；[contract 当前渲染](/home/ROXY/code/bb_work/harness/packages/singularity/context/src/render/fields.ts:202)；[dynamic 当前渲染](/home/ROXY/code/bb_work/harness/packages/singularity/context/src/reads/dynamic.ts:47)。
- **T10**：[设计文档中的 Worker 模板](/home/ROXY/code/bb_work/harness/packages/singularity/docs/agent-prompt-contracts.md:33)。
- **T11**：[真实模型递归与模板复用历史证据](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-03-live-task-growth.json:5)；[该测试真实请求与明确协调任务](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:82)。
