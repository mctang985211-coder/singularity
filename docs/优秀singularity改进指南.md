# 优秀 Singularity 改进指南

## 1. 文档目的与证据边界

本文合并两部分审查：

1. memory、父子问答、节点 Prompt 与工具引导审查；
2. 全部角色、全部 Agent 可见工具和 Task 递归分解审查。

同时保留原指南关于 RSI 定位、状态与验收、TypeScript 工程治理和论文路线的结论。本文是**改进目标与实施方案，不是完成证明**。章节中“当前”描述审查时的基线。生产行为以 [当前架构](architecture.md) 为准；本轮修改与离线验收见 [实施对照](guide-implementation-20261024.md)，此前工程治理范围见 [工程收尾验收](nonrun-completion.md)。

阅读时必须区分四类信息：

- **当前已落地**：审查时当前工作树中的实现，不等于已经通过全部验证或真实效果实验。
- **建议修改**：本文提出的 P0/P1/P2 方案，尚未实施时不能当成现有能力。
- **历史实跑**：按原运行版本解释，只用于发现机制问题，不能替代当前版本复验。
- **研究结论**：必须来自冻结的真实任务对照，不能从源码、测试数量、工具调用次数或单次演示推断。

## 2. 总体判断与修改优先级

Singularity 应继续发展为一个**以 Task 契约和可核查证据为基础、面向领域任务的有界 workflow/method 演化系统**。当前内核值得保留，不建议推倒重写。

它演化的是 `workflowGuidance / templates / skills / tools`，不是基础模型权重；proposer、critic、宿主协议、评分器和保护检查不随候选一起演化，因此不应宣称强 RSI。

两轮工具审查得到的中心结论是：

> 静态角色 Prompt 已经比较克制，但部分工具没有形成“知道是什么 → 判断何时用 → 正确调用 → 理解返回 → 知道下一步”的闭环。子 Task 少分解、memory 和问答低使用，都不能只靠增加提示文字解决。

修改优先级如下：

| 优先级 | 需要解决的问题 | 修改方向 |
|---|---|---|
| P0 | 普通父 Task 不能像 root 一样回收 verified 子产物 | 泛化准确 direct-child 的封存产物提交，保留父级独立验收；必要时委派 integration child |
| P0 | ambient Skill 可绕过固定 Method 和消费记录 | 执行业务与验收只使用 pinned Skill，或将外部 Skill 的内容和 digest 正式冻结进 Run |
| P0 | 状态、unknown 和证据语义漂移 | 保留当前五项结果投影、`review-inconclusive` 和结构化事件引用，补齐回归，不倒退 |
| P1 | 子 Task 没有显式原子性检验，分解成本和等待语义不清楚 | 增加有界判断、动态 next 和分解成本说明；不追求树深 |
| P1 | memory 两阶段调用、角色语义和触发不明确 | 只读目录与显式 prepare 分离，prepare 直接返回正文；按真实来源和角色暴露 |
| P1 | 父子问答缺少升级场景与行动卡 | 明确何时问、如何答、`resolves` 和 requestKey；通知中给出下一步 |
| P1 | 工具 Schema、Prompt sections、执行准入不统一 | 用同一角色工具策略驱动三者；移除 `present`，整理 jobs、read、submit 和 Method Tool 元数据 |
| P2 | 测试验证的是机制，不是模型选择和真实递归交付 | 增加完整装配合同测试、二/三层端到端用例和真实模型行为实验 |

最终判据不是“更多工具被调用”或“树更深”，而是：**该用时能用，调用后真正消费结果；该拆时能拆，无需拆时不拆，每层都能交付并通过独立验收。**

## 3. 不可牺牲的基础

以下能力是项目最有价值的资产，简化时必须保留：

1. **单一事实来源**：统一 Envelope、append/fold、命令幂等、版本门和闭合 Schema。
2. **冻结合同**：Task 的目标、输入、产物和 criteria 不被 Method、handoff、记忆或父回答偷偷改写。
3. **独立验收**：执行者不能自评；保护 verifier 的非 pass 不能被模型推翻。
4. **准确来源**：Run 固定 Method、输入、artifact、producer、实现摘要和原生轨迹。
5. **合法终局**：区分业务失败、验收失败、运行故障和取消；无赢家与证据不足可以正常结束。
6. **实验隔离**：evolve/validation/heldout 按 family/source 分离，私有输入和评估轨迹不越权。
7. **诚实测量**：缺失不补零、成本未知不补零、trial 不冒充独立 family、旧收益不按新 head 重算。
8. **工程门禁**：严格 TypeScript、依赖方向、构建摘要、协议清单和关键行为反例。

当前工作树已经沿原指南方向落地了一部分改进，不应继续把它们写成未开始的待办：

- `executionPhase / searchOutcome / reportReview / publication / businessOutcome` 已形成独立投影，见 `assembly/src/rsi-state.ts`。
- reviewer 语义无法判定与基础设施不可用已开始区分为 `review-inconclusive` 和 `infrastructure-failure`，见 `assembly/src/native-solve.ts:253-290`。
- 原生事件引用可以复用 `{sessionId,eventSeq,rootId?,from?,count?}`，并由宿主核对冻结读取范围；字符串引用仍不等于机器证明，见 `assembly/src/review.ts:276-284`。
- acceptance、proposal、publication 使用各自审核片段；authoring 和 proposal review 共用三项 criteria。
- 报告数值由宿主冻结，作者引用 round 并解释机制与限制。
- ESLint/Prettier、公开 core CI、上下文审计、文档身份目录、实验封存与重放工具已经进入当前工程树。
- 公开授权仍保持 `private/UNLICENSED`；远端 GitHub job 并未因本地配置存在就被证明已经执行。真实 pilot、跨机器复验和论文级对照仍未完成。

## 4. Agent 可见工具的完整地图

### 4.1 角色与工作态

下表中的 `S:` 表示 `singularity_` 前缀。

| 角色 | 原生工具 | Singularity 工具 | 工作态数量 |
|---|---|---|---:|
| root | `read/read_image/glob/grep` | `S:read/memory/submit/decompose_task/stop_explorations/answer/retry_task` | 11 |
| 普通 Task | `bash/write/edit/read/read_image/glob/grep/job_output/job_list/job_kill/skill/web_fetch/web_search/present` | `S:read/memory/submit/decompose_task/stop_explorations/answer/retry_task/ask_parent/run_method` | 23 |
| acceptance reviewer | 与普通 Task 相同，但无 `present` | `S:read/memory/submit/decompose_task/answer` | 18 |
| improve | `read/write/edit/glob/grep` | `S:read/memory/propose_method/submit` | 9 |
| proposal/publication reviewer | `read/glob/grep` | `S:read/submit` | 5 |

动态规则：

- root 等待时从 11 缩到 10，隐藏 submit。
- 普通 Task 等待时从 23 缩到 11，只保留只读、memory、问答、停止、重试和允许的规划。
- acceptance reviewer 等待时从 18 缩到 8。
- improve 非 ready 时由 pre-step 阻止新的模型 step；pending 期间不依靠模型轮询。
- proposal/publication 的 5 个工具以当前源码 `assembly/src/review.ts:42-45` 为准，不能用旧实跑中的较大工具面替代当前判断。

### 4.2 实际请求核对

本次直接只读打开了历史原生 session 的 `request/header.tools`，确认普通 Task 的 23 个、acceptance reviewer 的 18 个和 improve 的 9 个工具确实送达过模型。

`subagent/subagent_fork/send_message/workflow/todo_write/get_goal/create_goal` 未出现在所核查的会话中，不能仅因 DSH base 存在这些包就声称它们对 Singularity Agent 暴露。

历史捕获同时给出了工具 Schema 的 UTF-8 字节量级：

| 角色 | 工具 Schema 总字节 | 最大单项 |
|---|---:|---|
| 普通 Task | 16,469 | `singularity_decompose_task`，3,265 |
| acceptance reviewer | 14,127 | `singularity_decompose_task`，3,251 |
| improve | 6,606 | `singularity_read`，1,657 |

这些数字说明完整工具面比静态 role policy 更厚，但**字数不是主要根因**。不能为了减少 Schema 而破坏必要合同，也不能把递归分解不足简单归因于分解工具最大。

### 4.3 工具引导的总体评价

| 工具或规则 | 评价 | 核心缺口 |
|---|---|---|
| 共享协议与 role policy | 较好 | 权限、预算、等待和独立验收较简洁；具体场景的行动提示不足 |
| `S:read` | 中等 | kind 多、ref 含义变化、分页与默认返回不统一、缺少按当前任务给出的调用卡 |
| `S:decompose_task` | 机制完整、使用闭环不足 | 普通父 Task 的产物回收不对称；原子性与成本判断不足 |
| `S:submit` | root 路径好，普通 Task 有歧义 | 非 root 不能复用子产物；path 精确值和同步验收语义需要说明 |
| `S:memory` | 不合格 | 两阶段返回、隐式模型调用、角色差异和使用时机不清 |
| `S:ask_parent/answer` | 协议可靠、引导不完整 | 升级场景、行动卡、`resolves` 与等待后的 next 不足 |
| `S:run_method` | 调用格式较好 | Method Tool 自身缺少“是什么、何时用”的说明 |
| `S:propose_method` | 较好 | 有预算、准入、异步状态和结束 turn 说明，可作为其他工具的范例 |
| review submit | 较好 | dispatch 有 reads/output 模板；evidence 空数组和字符串引用的证明强度仍需区分 |
| `S:stop_explorations/retry_task` | 基本合格 | 补充 ID 来源、适用场景和返回后的 next 即可 |
| DSH `present` | 不应暴露在内部 Task | 与封存及独立验收形成第二套“完成”语义 |
| DSH jobs | 机制可用、等待时冲突 | 后台任务管理说明与 Singularity 等待限制不一致 |
| DSH `skill` | pinned provider 设计好，目录边界不闭合 | 文件系统 Skill 可绕过固定 Method 和消费记录 |
| DSH web | 领域策略决定 | 是否允许网络、如何引用和冻结证据应由合同说明 |
| DSH bash/write/edit/read 等 | 基本可用 | Bubble 安全边界有效；无效提权参数和遗留 section 可继续收敛 |

## 5. P0：先修复 Task 递归分解与交付闭环

### 5.1 子 Task 少分解不是单纯提示问题

当前普通 Task 只收到：

> Execute atomic work or delegate smaller complete responsibilities.

见 `assembly/src/prompts.ts:10`。它没有定义原子责任、判断时机、分解收益和停止条件。动态责任投影也只让 root 得到 `remaining.decompose=true`，普通 Task 始终显示 `executionMode:"work"`，见 `assembly/src/coordination.ts:175-187`。

历史 1024 步运行中：

- 共 1,343 次工具调用；
- `singularity_decompose_task` 只有 4 次，全部来自 root；
- 控制事实只有 root 的 `task/decomposed`；
- 子 Task 首个 assistant 计划直接列出读合同、测量、多个变体和提交，没有原子性检验。

原始材料位于 `/home/ROXY/singularity-next/convergence-audit-20261023/`，运行范围见 [审计记录](convergence-audit-20261023.md)。

但 root 已经把工作分成了单一设计和 refinement，部分子 Task 保持原子是合理的。不能把“没有继续拆”直接判为模型错误，必须构造真正需要再分解的对照场景。

### 5.2 普通父 Task 缺少 root 的产物回收路径

root 可以使用：

```text
verified direct child → 宿主复制封存字节 → root 自己的独立验收
```

实现却明确拒绝非 root 使用 `sourceTaskId/sourceRunId`，见 `assembly/src/submission.ts:70-89`。

普通父 Task 只能提交自己 workspace 的文件。复用子产物时，主要只能经 `singularity_read(kind=artifact)` 分页读取文本，再自行写入或加工。`readArtifact` 按 UTF-8 解码，见 `assembly/src/read.ts:538-566`，所以大型文本转写低效，二进制产物不能形成通用闭环。

因此，当前是“协议允许嵌套分解”，但“普通父 Task 缺少与 root 对称的多层交付能力”。这是比 Prompt 更优先的修改点。

### 5.3 分解会暂停父 Task 自己的执行

`src/task/tree.ts:92-99` 规定，只要还有未结算子节点，父 Task 就进入等待。等待会影响 write/edit、bash、Method Tool 和后台 job 管理；包括 exploration 在内的所有子节点未结算都会形成等待。

这能防止父节点重复执行 delegated work，却也意味着普通 Task 无法自然地“委派独立调查，同时继续自己的实现”。分解不是轻量并行调用，而是明显的执行模式切换。

修改前应先明确：

- required 前置责任未结算时，是否继续禁止父执行；
- 独立 exploration 运行时，是否允许父执行不相关的工作；
- 提交前是否仍必须停止未选 exploration；
- 后台 jobs 在等待期间如何收集和取消。

如果暂时保留现有等待规则，就必须在分解工具说明中明确代价，不能让模型以为可以自由 hybrid 执行。

### 5.4 开始执行后再分解，输入交接会变难

子合同只能使用 protected inputs 或已 verified 的 sealed artifact inputs，见 `assembly/src/inputs.ts:164-180`。父 Task 当前 workspace 中未验收的中间文件，不能直接成为新子节点的声明输入。

有界摸底可以帮助选择责任边界，但应在重大实现之前作出分解判断。写到一半再拆，可能导致重复工作、无法交接，甚至需要失败后按原合同重试。

### 5.5 每层分解都有真实成本

每个新子 Task 都增加：

- 子节点执行和一次独立 acceptance；
- 父节点协调、通知和恢复成本；
- 共享 workflow 步数预算消耗；
- 重新选择并绑定 Skills/Tools 的认知成本。

root 生成的合同若把多个变体、测量、比较和报告打包进一个叶子，也会迫使该叶子承担原本可以并行的探索。父节点不应为了减少直接子节点数量，把多个独立责任压进一个叶子的合同。

### 5.6 推荐修改：泛化 verified direct-child 提交

建议允许任何拥有 direct children 的父 Task，将某个 verified direct child 的准确 Run 产物作为自己的候选提交给独立验收。

必须保留：

- 只能引用 direct child；
- 必须给出准确 `sourceTaskId/sourceRunId`；
- 源 Run 必须 verified；
- 复制封存字节，不读取可变 workspace；
- 父 Task 仍须独立验收，子通过不等于父通过；
- 保留祖先责任重复检查，避免无意义的一层转发；
- 按协议版本门用于新图，旧图只读。

需要组合多个子产物时，优先委派 integration child，通过声明的 artifact inputs 接收上游结果，再由父 Task 复用集成后的封存产物。不要先新增共享 workspace 或任意 artifact 下载工具。

相关修改面：`assembly/src/agent.ts`、`assembly/src/submission.ts`、提交与调度测试。必须增加普通父 Task 的二/三层文本与二进制交付、多子节点集成、错误 sourceRun、未 verified source 和父级独立验收反例。

### 5.7 推荐修改：显式但有界的原子性判断

普通 Task 的稳定 Prompt 可调整为：

```text
Before substantial execution, explicitly test whether the assigned responsibility is atomic: one executor can produce the declared artifact and satisfy the criteria with bounded investigation and the remaining shared budget. Decompose only into smaller complete responsibilities with declared inputs, distinct deliverables and a real coordination benefit. A single final artifact does not prove the work is atomic. Do not split trivial steps or pursue tree depth. Re-evaluate once after bounded reconnaissance before major implementation.
```

同时：

- root 的“fewest child contracts”应解释为最少的可独立完成责任，而不是最少节点数。
- 动态 `summary/next` 应区分 root 必须委派、普通 Task 先判断 execute/delegate、已有 children 后协调与提交。
- 不新增 `plan.json`、原子性审批或另一套持久状态。
- 真正原子的任务不调用分解工具也是成功，不能设置分解率目标。

## 6. P0：关闭 ambient Skill 对固定 Method 的绕行

普通 Task 和 acceptance review 挂载了 `skill-filesystem`，见 `assembly/presets/singularity-next.patch.yml:34-37`。

`mountMethodSkills` 只对自己注册的 pinned provider 记录消费，见 `assembly/src/method-run.ts:203-260`。文件系统 Skill 由另一 provider 合并进目录，其内容可能：

- 不属于固定 Method；
- 随文件变化；
- 不进入 pinned Skill 消费记录；
- 影响业务结果和 RSI 比较的可归因性。

历史运行中 `skill` 调用为零，只能说明尚未观察到使用，不能证明边界安全。

建议：

1. 业务执行和验收角色只暴露 Method 绑定的 Skill；检查 preset 与部署层 provider，不能只隐藏 `skill` 工具名称。
2. 如果确需外部 Skill，将内容、digest 和来源正式冻结进 Run，并纳入消费与比较口径。
3. 增加“同名 pinned Skill 优先”“未绑定外部 Skill 不可见/不可调用”“外部 Skill 不改变 caliber”“冷恢复仍读取同一 digest”的反例。
4. 不通过扩大 `consumeMethod` 的事后记账掩盖未冻结内容；先解决内容身份。

## 7. P1：让 memory 成为可理解、可选择的能力

### 7.1 先明确它是什么

当前 memory 是：

- 父会话为某个具体子 Task/Run 准备的工作笔记；
- 或显式链接的上一轮 RSI → 下一轮 RSI 笔记；
- 绑定合同、Run、Method 和读取范围；
- 不是通用长期记忆、语义检索库或子节点向父节点汇报的通道。

必要信息的优先级应是：

```text
冻结合同 → 声明输入和 sealed artifact → 明确 handoff → 非权威 memory 笔记
```

自包含的原子 Task 不调用 memory 可能是正确行为，不能强制每个 Task 调用。

### 7.2 当前调用合同的问题

无参数 `singularity_memory({})` 可能先生成一次摘要，然后只返回目录和 `inherited`；必须再用 `singularity_memory({ref: inherited})` 才返回 checkpoint 正文，见 `assembly/src/driver-execution.ts:353-359`、`assembly/src/memory-view.ts:125-140`。

这会导致：

- 不知道需要第二次调用；
- 把空目录误认为没有记忆；
- 只想分页浏览却触发模型摘要；
- 第一次调用发生，但正文没有进入后续决策。

统一描述也不适合所有角色：reviewer 为保持独立性不准备父背景；root 没有自己的 parent；improve 只有存在显式 predecessor 链接时才有明确的跨轮来源。

此外，摘要只选择近期 user/assistant 正文，排除工具结果和宿主消息，见 `assembly/src/parent-memory.ts:145-169`。这是合理的成本控制，但父 Agent 若主要通过工具工作，memory 可能天然缺少新信息。

历史运行中，memory 只有一次 reviewer 空目录调用，没有父背景模型调用。旧轨迹不能直接代表当前效果，却说明仅增加描述不会自动产生有效使用。

### 7.3 推荐的新调用合同

保留现有 checkpoint、权限和持久化实现，只调整模型接口：

| 调用 | 语义 |
|---|---|
| `{}` | 只读目录，绝不触发模型调用 |
| `{prepare:true}` | 明确准备当前继承笔记，最多一次，并直接返回正文 |
| `{ref:"memory-..."}` | 读取已有 checkpoint，不触发模型调用 |

配套修改：

- root/review 使用准确的只读描述；没有实际用途时不暴露 prepare。
- improve dispatch 检测到已有 RSI predecessor 时，给出明确 memory 入口。
- 可选摘要失败时返回状态和“无需它也可继续”的 next。
- 笔记只作为线索；依赖前通过 `evidenceRefs` 读取原始 sealed evidence。
- 不恢复所有子节点启动时的自动全文摘要，不增加第二个 memory store。

调整后的工具描述可以写成：

```text
Read optional parent or linked previous-RSI working notes; they are not requirements or proof. Use when the contract and handoff omit useful rejected paths, decisions, or open questions. `{}` lists existing notes without a model call; `{prepare:true}` prepares and returns your inherited notes at most once; `{ref}` reads a checkpoint. Follow evidenceRefs to the original sealed evidence before relying on them.
```

### 7.4 memory 的去留由适用场景实验决定

至少比较：

- 合同和 handoff 已完整：不应强制调用；
- 有明确 rejected paths/open questions：应准备一次并真正消费；
- 有 RSI predecessor：应读取跨轮笔记，但不把笔记当证据；
- 摘要失败：不重复购买，业务继续；
- reviewer：不得越权读取被审对象叙述。

衡量正确触发率、笔记消费率、任务完成率、额外 token 和等待成本。如果 business parent memory 在真正适用的场景中仍无收益，应删除或缩减，而不是为了证明原设计正确而强制使用。

## 8. P1：保留受限父子问答，补齐升级和行动提示

### 8.1 当前机制值得保留

父子问答已经具备：

- 准确父子 Task/Run 绑定；
- requestKey 幂等和直接父节点权限检查；
- blocking 问题限制执行；
- 原生消息恢复投递；
- answer 只能引用可见且 verified 的 Task 证据。

见 `assembly/src/coordination.ts:123-208`、`src/task/tree.ts:71-88`。

当前是“子节点可问、父节点只能答”，不是双向自由聊天。父节点没有主动追问或纠偏子节点的 Singularity 工具，也没有通用中间进度汇报通道。如果产品需要真正的双向主动对话，必须另行明确协议和调度，不能用 Prompt 假装能力已经存在。

### 8.2 应明确何时必须考虑询问

典型触发条件：

- 必需输入不存在或与合同不一致；
- 合同要求修改只读输入、引用树或越权路径；
- 必需 capability 未绑定，纠正一次明确 refusal 后仍无法履行；
- 合同内部矛盾，继续执行只能猜测验收意图。

不应询问的场景：

- 普通实现错误或单次实验失败；
- 可由子任务自行决定的技术方案；
- 要求父节点修改冻结合同或授予额外权限。

历史反例中，子 Task 面对“修改冻结仓库”的矛盾合同，尝试提权而不是询问，见 [RSI agent 工作合同](rsi-agent-contract.md)。当前提示已针对此类问题改善，但仍需真实模型场景验证。

### 8.3 给问题、答案和 refusal 增加行动语义

建议：

- `ask_parent` 返回 `status` 和 `next: "End this turn; the host will resume you with the answer."`。
- question 通知附带 `singularity_answer` 的调用模板，采用与 review dispatch 相同的行动卡风格。
- 明确 `resolves:true` 是最终解答并释放该问题；`false` 只是补充信息，问题仍未解决。
- 每个新答案版本使用新的 requestKey；只有不确定投递时才用相同 key 和相同内容重试。
- 回答只能澄清，不得改变合同或权限。
- 工具 refusal 统一带 `ok:false`、命名原因和下一步，避免模型把 `{"refused":...}` 当成成功继续推进。

零问答不等于失败；完整合同本应减少问答。但“该问未问”和“问了以后不会答”必须成为行为验收场景。

## 9. P1：逐项修正工具说明、返回与角色边界

### 9.1 `singularity_read`

需要补的是分类型使用合同，而不是继续增长通用描述：

- 为当前角色和当前 dispatch 提供可复制的 kind 调用卡。
- 统一分页结束语义；template 列表目前只返回数组切片，缺少统一的 next 信息，见 `assembly/src/read.ts:227-245`。
- review/improve 的 method 默认可能返回完整 assets，只有显式 from/count 才分页，见 `assembly/src/read.ts:280-306`。大 Method 应有有界默认视图。
- `task` 是较完整状态读取，不能与紧凑 summary 混为同一成本预期。
- artifact 省略 runId 时优先 verified，否则可能回退到最近 sealed Run。必须明确 **sealed 不等于 verified**，消费前检查 status 和准确 runId。
- trajectory index 仍只是元数据，引用和判断必须读取实际事件页。

### 9.2 `singularity_submit`

普通 Task 的 `path` 必须与冻结合同中的 artifact 完全相等，见 `assembly/src/submission.ts:54-57`。即使绝对路径指向同一个文件，也可能因字符串不等而拒绝。

参数描述应直接写：

```text
Copy assigned.contract.artifact exactly. Submit that declared file for independent acceptance; do not substitute another output path.
```

同时说明它不只封存，还会等待独立验收结果。root 的 direct-child source 提交保留为正面范例，并按第 5 节泛化到普通父 Task。

review submit 的 dispatch `reads` 和 `output` 模板是当前较好的设计。仍需注意：evidence 数组可以为空，字符串引用也不全是机器可解析证明，见 `src/review/protocol.ts:80-87`。是否允许空 evidence 应按 verdict 和声明类型由宿主裁定，不能只靠 Prompt 要求“最好有证据”。

### 9.3 `singularity_decompose_task`

除第 5 节的结构修改外，还应补充：

- `key` 是稳定身份；不确定投递时只能以相同 key 和相同内容重试。
- `dependsOn` 是直接子节点之间的真实前置关系；外部 verified artifact 通过 inputs 复用。
- `supports` 是父 criterionId 的贡献声明，不等于父验收自动通过。
- `maxRuns` 是该子合同的固定尝试上限，不是要求模型用满的实验配额。
- required/exploration 的选择和每层独立验收成本。
- parent bindings 不继承，子合同必须显式选择 Skills/capabilities。

返回 `opened` 后应继续明确“结束 turn，结果由宿主恢复”，并说明父执行何时暂停。

### 9.4 `singularity_run_method` 与 Method Tool

`methodContext` 已提供可调用的工具名和 candidatePath，这是好的部分。`MethodTool` 却仍只有 `name/source/verifier`，没有用途说明，见 `assembly/src/method.ts:37-44`。

建议为新 Method Tool 增加简短 `description`，同时表达：

- 做什么；
- 什么时候应该使用；
- 输入或候选文件是什么。

将该描述与现有 `call/candidatePath` 一起送达，并说明返回的 `artifact` 实际是 stdout 文本。不要让模型只能读源码猜用途。

历史运行还发生过三次未绑定 Method Tool 调用，随后模型改用公共 bash wrapper。后续 schema 已补充“原生工具和公开 CLI 无需绑定”，但真实行为是否改善仍需新运行验证。绑定、实际执行和验收证据不能混为一谈。

### 9.5 `propose_method`、stop、retry 和问答工具

- `singularity_propose_method` 已包含预算、准入、槽消耗、异步 screening 和结束 turn，是值得复用的说明模式。
- `stop_explorations` 和 `retry_task` 基本合格，补充 ID 来源、何时使用和返回后的 next 即可，不必重写。
- `ask_parent/answer` 按第 8 节补齐触发与行动卡，不增加自由聊天工具。

### 9.6 DSH 原生工具

#### `present`

`present` 只是向用户声明当前文件，不复制或封存内容，也不触发独立验收。它与 `singularity_submit` 形成两套完成语义，建议从内部 Task preset 删除。历史实跑没有调用它，删除比继续解释更便宜。

#### jobs

DSH 指引要求跟踪、收集和取消后台任务；Singularity 等待状态却会隐藏并阻止 `job_output/job_list/job_kill`。原生完成通知能唤醒 Agent，但 Agent 可能无法读取或清理对应 job。

至少应要求分解前收集或取消不再需要的 jobs，并明确等待期间是否允许 `job_list/job_kill` 做清理。`job_output(wait:true)` 与“等待时结束 turn”的关系也要明确。后台 job 不是 Singularity child，其完成不等于 Task 产物或验收完成。

#### web

`web_fetch/web_search` 不应一概删除，但网络资料是否允许、如何引用、是否需要冻结进证据，应由领域合同和比较 caliber 决定。proposal/publication 不应因此获得浏览能力。

#### bash/write/edit

Bubble 禁止提权和运行时“不要设置 sandbox_permissions”的提示有效，相关安全回归已通过。可以继续裁掉永远无效的提权参数，减少模型尝试无效路径，但不能把文案问题误报成现有安全漏洞。

`read/read_image/glob/grep` 的原生说明基本清楚，不需要为了形式统一而重写。

## 10. P1：统一 Prompt、工具 Schema 和执行准入

### 10.1 静态政策与动态行动卡分工

稳定 system policy 只保留：

- 冻结合同与权限；
- 独立验收和证据边界；
- 有限工作、共享预算与停止；
- 角色真正需要作出的判断。

动态 dispatch、outcome、question 和工具返回负责：

- 当前身份和合同；
- 当前可用输入与准确调用示例；
- 当前阶段的 `reads/output/next`；
- 等待、拒绝和恢复后的下一步。

RSI 的动态 `next` 和 review dispatch 的 `reads/output` 是当前较好的范例。不要把所有示例重新塞回公共 system Prompt，也不要恢复每步重复全局快照。

### 10.2 用同一角色工具策略驱动三层行为

`assembly/src/index.ts:132-150` 当前只过滤等待时的工具 Schema，没有同步处理所有原生 sections；method review 也只删除 bash/pwsh/write/edit 四类 section。

建议以一份角色/状态工具策略同时决定：

1. 实际注册和 prompt.tools；
2. 原生 Prompt sections 与 Skill catalog；
3. 执行 admission/guard。

`tool:jobs` 这类一个 section 对应多个工具的情况需要显式归属映射，不能只按工具名猜测。普通 Task 和 acceptance review 也应有明确 allowlist，避免未来宿主升级悄悄增加 Agent 能力。

### 10.3 评估完整上下文，而非只数字符串

每次评估必须包含：

- system policy 与 DSH 原生规则；
- 工具 Schema 和示例；
- dispatch、contract、method、direction、handoff；
- workflow/template guidance 与 Skill 目录；
- 实际读取的格式、规则、反馈和分页结果。

每个规则只保留一个权威来源。权限和状态由宿主执行，Prompt 只解释模型需要作出的判断。`pnpm audit:context` 和原生 capture 应继续用于测量，但字节下降不能直接换算成账单或质量收益。

## 11. 状态、验收与 RSI 语义：保留已收敛成果

### 11.1 不新建状态机框架

不要引入第二套持久状态、通用 workflow DSL、XState 或新的调度服务。继续使用现有控制事实，只统一投影和命名。

面向使用者和维护者的视图必须分别回答：

- `executionPhase`：当前谁在做什么，是否等待宿主或子任务；
- `searchOutcome`：improved / no-improvement / insufficient-evidence；
- `reportReview`：报告是否被独立接受；
- `publication`：候选是否通过验证、审核并切换生产指针；
- `businessOutcome`：业务 root 是否 accepted、failed 或 cancelled。

`RSI completed` 不必然代表找到改进，`RSI failed` 也可能只是报告验收失败。`assembly/src/rsi-state.ts` 继续作为轻量投影入口，不在 UI、CLI、Prompt 和文档中分别发明终局含义。

### 11.2 保留 unknown 的新分类

至少区分：

1. 产物未能证明满足冻结合同；
2. reviewer 因语义或证据不足而无法判断；
3. verifier、provider、EDA 或宿主环境不可用。

当前 `review-inconclusive` 与 `infrastructure-failure` 的区分应保留并补齐反例。候选自身造成的不可履行 workflow 不能被隐藏成随机基础设施缺失；明确 fail/partial 也不能被改写成 unknown 来逃避失败分母。

### 11.3 数值事实由宿主生成

- 分数、成本、轮次结果、候选状态和发布状态由宿主计算并冻结。
- RSI 作者只解释机制、观察、限制和未验证假设。
- reviewer 核对宿主事实与解释是否一致，而不是审核模型手抄的算术。
- 报告验收失败不能被叙述成搜索没有完成，也不能抹掉已经发生的业务或测量事实。

### 11.4 让证据强度可区分

- **确定性验证**：外部 scorer、保护 verifier、digest、输入与实现身份。
- **独立语义判断**：LLM ReviewRun 对冻结 subject 的 findings。
- **实验结论**：新任务上的测量、统计区间和迁移结果。

结构化原生事件引用应继续用于轨迹声明，并由宿主核对冻结范围。字符串引用只是语义引用；不能用“独立 reviewer 看过”替代确定性复验。

## 12. 推荐实施顺序

### 第一阶段：打通递归交付和固定证据边界

1. 泛化 verified direct-child 提交到普通父 Task。
2. 增加 integration child 模式，保留父级独立验收。
3. 关闭 ambient Skill，或把外部 Skill 的内容身份正式冻结进 Run。
4. 保持五项结果投影、unknown 新分类和结构化事件引用不回退。
5. 增加二/三层文本与二进制交付、错误来源、未 verified 来源和冷恢复反例。

### 第二阶段：统一 Agent 使用界面

1. 建立角色/状态工具策略，统一注册、Schema、sections、Skill catalog 和 admission。
2. 增加原子性判断和动态 next；明确分解等待与成本。
3. 分离 memory 的只读目录和显式 prepare，prepare 直接返回正文。
4. 为问答和 refusal 增加状态、next 和调用模板。
5. 移除 `present`，整理 jobs 的等待与清理规则。
6. 补 read 分页和默认视图、submit 精确路径说明、Method Tool description。

### 第三阶段：验证行为而不是只验证存在

1. 用完整 preset 做角色与动态状态工具合同测试，不能只挂载过滤后的插件。
2. 做真正原子与明确非原子的真实模型对照，不以深度或调用率为目标。
3. 做 memory、阻塞问答、后台 job 清理和多父层集成的端到端实验。
4. 完整执行 `pnpm verify` 与相关领域验证，再运行付费实验。
5. 按结果保留、简化或删除未证明有价值的能力。

`assembly/tests/root-tools.spec.ts:33-35` 当前会过滤 preset 插件，适合验证部分角色边界，但不能发现 `present`、ambient Skill 等完整装配问题。新的工具合同测试必须覆盖完整 preset、动态等待状态和 provider 目录。

## 13. 验证证据与必须新增的验收场景

### 13.1 已有证据的范围

本轮工具审查最终有 **109 项定向测试通过**，覆盖分解、调度、读取、root 提交、权限、Method 上下文和四角色原生装配。未据此宣称完整 `pnpm verify` 已通过。

此前一次完整离线验证曾通过 93 个测试文件、1046 项测试和 8 条 gates。它与本轮不是同一工作树状态，两个数字不能拼接成“当前全量验证通过”。

历史 1024 步运行中：

| 观测 | 数量或含义 |
|---|---|
| 总工具调用 | 1,343 |
| decompose | 4，全部来自 root |
| memory | 1，reviewer 空目录调用 |
| ask_parent / answer | 0 / 0 |
| present / skill / web / stop_explorations / retry_task | 均为 0 |
| job_output | 4 |

这些观测说明“工具被挂载”与“模型在适当场景主动使用”完全不同，也不能反推所有零调用工具都没有价值。

### 13.2 必补工程场景

- 真正原子的 Task：不分解也能完成，不被强制制造子节点。
- 明确非原子的 Task：能够分解，并完成独立验收。
- 三层 Task：中间父节点能复用 verified direct-child 的文本与二进制产物。
- 多子节点集成：integration child 通过声明 inputs 组合结果，父级再次独立验收。
- 错误 sourceRun、未 verified source、非 direct child、祖先责任重复均被拒绝。
- 未绑定外部 Skill 不可见或不可调用；pinned Skill 在恢复后 digest 不变。
- 等待状态下 Prompt 中不出现不可调用工具的误导性说明。
- `present` 不出现在内部 Task 工具面。
- 后台 jobs 在分解和等待中有明确收集/取消路径。
- memory 无 ref 浏览不触发模型调用；prepare 一次直接返回正文；失败不重复购买。
- 缺失必需输入或越权合同：子 Task 询问并结束 turn，父回答后恢复，无越权写。
- reviewer 不越权读取被审对象工作叙述。

### 13.3 真实模型行为指标

不要只统计工具调用率。至少记录：

- 原子性判断是否符合场景；
- 首次调用成功率和错误参数纠正次数；
- 调用后是否真正消费 memory、子证据和返回状态；
- 该问时是否问、问后是否等待、答后是否恢复；
- 每层是否完成真实交付，而非只有节点和验收动作；
- 不必要的 memory 摘要、重复读取和无效工具尝试；
- 完整任务成功率、全部 hard guards、总成本与等待成本；
- 分解深度是否有证据支持，而不是越深越好。

## 14. TypeScript 工程与制品治理

### 14.1 验证分层

- **core**：协议、决策、统计和纯投影，不依赖私有 DSH，可在普通 CI 运行。
- **native integration**：固定 patched DSH、真实会话、恢复、权限和完整装配。
- **model/domain experiment**：显式触发，保存完整费用与证据，不混入离线 `verify`。

不要为了简化安装而下载同名 registry 包或绕过固定宿主摘要。

### 14.2 日常治理

- 保留 PR 公共 core CI；自托管原生集成继续保持最小权限。
- 保留 lint/format 门槛；覆盖率用于发现盲区，不作为数量目标。
- 当前架构是唯一生产行为入口，历史计划、审查和实验记录明确标注版本与证据范围。
- 修复代码注释、divergence ledger、Prompt 入口和协议版本漂移。
- 公开许可是独立决策；当前 private/UNLICENSED 不能被 LICENSE、NOTICE 或 tarball 审计冒充公开授权。
- 为旧实验保留只读 fixture；生产协议稳定前不承诺盲目兼容所有旧图。

### 14.3 实验制品

每次正式实验形成不可变证据包，至少包含：

- 源码 commit、dirty diff、依赖锁、DSH commit/补丁和构建摘要；
- 预注册任务、family/source、split、比较臂、停止与缺失规则；
- 初始方法、全部候选、champion、实际 diff 与资产消费记录；
- 逐 trial 原始结果、失败、取消、缺测、成本和执行顺序；
- 原生控制事实、轨迹、产物、findings、测量输出；
- 完整 Agent 可见工具 Schema、实际请求和按需读取页；
- 确定性复验、聚合脚本、整体 SHA256 manifest 和去敏说明。

关键材料不能只留在易失的 home 或 `/tmp`。报告数字应由脚本从原始 trial 记录生成。使用与边界见 [研究工具](../research/README.md)。

## 15. 论文路线：先证明一个窄问题

推荐首先研究：

> 固定基础模型和执行底座时，Task 契约、责任关系和独立验证证据，能否比信息等价的原始轨迹反馈，产生更能在同领域未见任务族上泛化的 workflow 方法修改？

不要先同时声称跨领域、跨模型、多 agent 全面优势和强 RSI。

### 比较组按主张增加

- **H0 冻结初始方法**：任何学习收益主张都需要。
- **完整 workflow 方法演化**：检验相对 H0 的未见任务效果。
- **同预算 best-of-N**：排除只是增加尝试机会。
- **只演化 Skill/Tool**：证明 workflow 组织演化的增量价值。
- **信息等价的原始轨迹 RRSI**：证明 Task 证据结构的价值。
- **单 agent 基线**：仅在主张多 agent 价值时必需。
- **分解策略消融**：仅在主张递归责任分解收益时，比较当前策略、原子性判断和交付闭环修复后的策略。

缺少哪一组，就缩小对应结论，不用设计文档代替实验。

### 实验纪律

- 先冻结任务来源、split、候选机会、停止规则、主指标和统计方法。
- 用独立 pilot 估计方差；三个 family、两个 trial 只是工程最低门，不是论文样本量。
- trial 不增加独立 family，子节点和测试向量也不增加独立工程任务数。
- baseline/candidate 采用交错或 AB/BA，记录实际顺序和模型 revision 可见性。
- heldout 在方法与分析冻结后使用；被反馈消耗的集合不得继续冒充未见集。
- 主指标使用根完整交付成功率及全部 hard guards，局部质量、PPA 和 cost 作为次级指标。
- 同时报告在线业务成本、离线搜索/审核/发布成本、全部失败和质量—成本曲线。

## 16. 明确不要做的事

- 不再建第二套状态库、workflow 执行器、队列或 memory store。
- 不为了递归而递归，不强迫每个子 Task 分解，也不以树深作为收益。
- 不通过恢复自动全文摘要或强制 memory/问答调用制造使用假象。
- 不让 ambient Skill、外部网络资料或未冻结输入绕过比较身份。
- 不新增共享 workspace 来掩盖普通父 Task 的产物回收缺口。
- 不靠提高 1024 步上限掩盖收束问题。
- 不以 Prompt 字数、节点数、工具数、测试数或代码行数作为产品收益。
- 不为产生赢家而放宽验收、降低统计门或忽略失败分母。
- 不用单次成本下降、同题新 Run 或局部高分证明迁移。
- 不把审核 accepted、报告 completed、发布成功和领域改善混为一谈。
- 不通过增加更多审核 agent 来掩盖本可由宿主完成的确定性检查。

## 17. 完成判据与最终方向

一次改进只有同时满足以下条件才算完成：

- 维护者能准确解释每个状态的进入条件、退出条件和权威事实来源。
- 每条验收规则都能说明由宿主、保护 verifier、LLM 还是实验负责。
- 每个 Agent 可见工具都有明确的用途、适用场景、调用方式、返回语义和失败后的下一步。
- 普通父 Task 能完成多层文本与二进制交付，且每层独立验收。
- 真正原子的任务不被强迫分解，明确非原子的任务能合理分解。
- 每个模型可见规则只有一个权威来源，没有重复或过期副本。
- `pnpm verify` 及相关领域验证通过，新增语义具有行为反例。
- 效果结论来自冻结的真实任务对照，而不是从测试数量、工具调用率或单次演示推断。

**最终方向：保留 Task/evidence 内核，先修复递归交付和固定证据边界，再统一 Agent 使用界面，把节省下来的复杂度预算用于真实、可复现、可反驳的领域实验。**
