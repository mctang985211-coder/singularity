# 当前架构与结果语义

更新：2026-10-24。Task v27、Strategy v10、Measure v6、Review v8、snapshot v15，仅用于新图。本页是当前架构入口；阶段设计、审查和实跑记录说明各自版本的行为与证据范围。

Singularity 是固定模型与执行底座上的、有界领域 workflow/method 演化系统。可修改资产只有 workflowGuidance、template、skill、tool。proposer、critic、宿主协议、评分器和保护检查不参与候选演化。

## 一条事实路径

```mermaid
flowchart LR
  Task[冻结 Task 合同] --> Run[固定 Method 的 Run]
  Run --> Seal[封存产物、输入与原生轨迹]
  Seal --> Review[独立验收与保护检查]
  Review --> Close[业务终局]
  Close --> Search[有界提案、筛查与 evolve 对照]
  Search --> Submit[封存解释报告]
  Submit --> Validation[私有验证与发布审核]
  Validation --> Report[独立报告验收]
```

全部控制事实继续走统一 Envelope → append → fold → projection。命令幂等、版本门、闭合 Schema、冻结输入生产者和实现摘要不变。没有新增状态库、调度服务或 workflow DSL。

业务 root 不执行实现；它委派有界责任，选择 verified direct-child 的封存产物，再接受独立 root 验收。所有父 Task 均可提交准确 verified direct-child Run 的封存字节，文本和二进制使用同一路径；子任务通过不能代替父级独立验收。组合多个结果时委派 integration child，使用声明的 artifact inputs。方法、handoff、记忆和父回答均不能修改冻结合同。

## 五个独立结果

[rsi-state.ts](../assembly/src/rsi-state.ts) 是工具准入与展示的投影入口。`singularity_read(kind=search)` 与 snapshot 的 `task.semantics` 共用它，业务 root 与对应 RSI Task 展示相同结果。

| 字段 | 含义与权威事实 |
|---|---|
| `executionPhase` | ready：作者可提案/提交；screening：宿主处理冻结 batch；evaluating：宿主处理 round；validating：提交后私有验证尚未结束；reporting：等待报告验收；completed：报告已有终局判断；failed：运行故障；cancelled：取消。来自 Run、batch、round、transfer 与取消事实。 |
| `searchOutcome` | 尚未封存报告为 null。随后按冻结测量给出 improved / no-improvement / insufficient-evidence；有 transfer 结果时使用该结果，否则检查 evolve 轮次的质量观察完整性、成对证据和决定。improved 不要求发布成功，也不代表广泛领域迁移。 |
| `reportReview` | not-submitted / pending / accepted / rejected / unavailable。来自报告 Run 的提交、独立 verdict 与失败原因；rejected 仍可对应 executionPhase=completed。 |
| `publication` | not-published → validating → validated → reviewing → reviewed → approved → published；负验证为 withheld，审核非 pass 为 rejected，审核运行失败为 failed。published 需要此 search 的 release draft 与实际 pointer/switched 事实。 |
| `businessOutcome` | 业务 root 的 task/closed.reason：accepted / failed / cancelled，未关闭时为 null。报告失败和发布拒绝不会改写业务结果。 |

`rsi/status` 仍是调度和恢复所用的控制事实；其中 completed/failed 不用于解释改善或发布。读取端使用上述语义投影。发布按历史事实归属到准确 round；后续生产 head 改变不会改算旧 search 的收益。

## 谁负责验收

| 责任方 | 检查范围 | 证据强度 |
|---|---|---|
| 宿主 | Schema、身份、绑定、预算、实际 diff、输入/artifact/producer/实现摘要；冻结分数、成本、轮次与发布事实 | 确定性事实与完整性验证 |
| 保护 verifier / 外部 scorer | 固定输入与产物上的验收和评分；非 pass 不能被 reviewer 改为 pass | 确定性验证，仍保留工具不可用原因 |
| 独立 ReviewRun | 冻结 subject 上的语义判断；proposal 按证据与机制、完整性与隔离、保持与可执行性三项筛查 | 独立语义判断，不等于机器证明 |
| 领域实验 | 真实任务的对照、统计区间、成本、消融与未见任务迁移 | 实验结论，不从测试数或单次演示推断 |

报告作者解释机制、观察和限制，`results` 引用实际 round；数值由宿主冻结并供给 reviewer。作者不承担重复抄算，提交之后发生的私有验证与发布也不要求作者预测。

## 非通过与缺测

| 事实 | 测评处理 |
|---|---|
| 明确 fail/partial，或候选导致不可履行 workflow、业务未交付 | 保留失败观察与成本，使用冻结评分规则；不从分母中删除。保护检查的明确失败不会因 reviewer 写 unknown 而变成随机缺测。 |
| 独立 reviewer 无法解决语义判断 | `review-inconclusive`，保存缺测、原始原因、轨迹与已知费用；不声称基础设施故障。缺少合同要求的证明应判 fail/partial。 |
| 没有审核证据、保护检查 unknown、provider/宿主/EDA 不可用 | `infrastructure-failure`，保留准确缺测原因。 |

质量缺测不补零。`projectEvaluation` 保留计划分母，只有完整观察才产生 `quality`，否则为 null；case/family 质量独立投影。成本为已记录用量的简单加法：包含失败、取消或中途暂停任务已经记录的部分，缺样本不加入，空集合为 0，绝不使整轮总数变成 null。缺样本和完整性保留为审计信息，已知 token 总量不代表完整账单。成本不设完整性、比例或增幅门禁；缺失或上涨的成本不再否决质量增益，已记录成本下降仍可支持噪声带内的收益判断。质量平局按 slot。`pairedReport` 仍要求完整的质量配对和保护检查；质量改善，或质量不下降且已记录成本可靠下降，均可建立改善，费用覆盖率仅作审计。trial 不增加独立 family 数量。

Finding 的 `evidence` 可引用 subject/file 字符串，原生轨迹引用复用 `{sessionId,eventSeq,rootId?,from?,count?}`。结构化引用会由宿主核对冻结可读范围和事件页；字符串仅是语义引用，不构成可机器核验的事件证明。页参数与提案共用 [evidence.ts](../src/review/evidence.ts)，不会因提交 finding 扩权。

## 上下文来源

[prompts.ts](../assembly/src/prompts.ts) 提供共享角色规则，以及仅按 acceptance / proposal / publication 分派的小片段；不再给每个 reviewer 同时注入三种用途。工具 Schema 负责参数，dispatch 负责具体身份与合同，subject 负责冻结事实与标准，Method/Skill 负责领域方法。提案格式、模板和规则只在按需 authoring 页提供，详见 [RSI 接口](rsi-agent-contract.md)。

评估上下文成本时须包含原生 DSH 规则、工具 Schema、dispatch、合同、Method、方向、handoff、Skill 目录与实际读取页。源码文字变短不能证明完整请求或模型费用下降。

## 验证入口

| 命令 | 范围与依赖 |
|---|---|
| `pnpm verify:core` | lint/format、上下文与元数据审计；公共纯协议、决策、统计与投影 spec，加依赖方向、无持久写、领域隔离、协议清单和 mutation 清单检查；不需要私有 DSH、.singularity 或模型。PR CI 使用此入口。 |
| `pnpm verify:native` | 配置固定 patched DSH 后，严格 TypeScript、构建摘要、真实宿主集成 spec 与全部 gates。 |
| `pnpm verify` | lint/format、原生制品通知与摘要审计；完整离线构建、core/native 全部 spec 与八项 gates；不调用模型。 |
| `pnpm verify:domain -- /path/to/environment` | 显式执行外部领域包提供的 verify.mjs；未提供时明确 SKIP。 |

测试分组仅在 [test-groups.mjs](../scripts/test-groups.mjs) 定义。公共依赖安装禁止自动下载 DSH peers；native 仍验证固定宿主摘要。TypeScript 的公共编译选项与宿主路径配置分开，完整严格类型检查属于 native build。真实模型/领域实验必须另外显式触发，不混入 verify。

工程收尾已补齐：ESLint/Prettier 门槛、core 覆盖率报告、完整上下文源审计与原生请求测量、历史文档身份目录和只读旧工程 fixture、私有制品/第三方通知审计，以及正式实验预注册、顺序计划、原生导出、聚合和不可变证据包校验/重放工具。使用与边界见 [research](../research/README.md)、[context audit](context-governance.md)、[文档目录](documentation-index.md)。

仍待实跑的证据：独立 pilot、真实任务 H0/强基线/消融、足够独立 family 的未见任务迁移、第二台机器的实际重建与评分器复验。具体正式研究的样本量与注册必须由真实独立 pilot 决定；提供了可校验合同，不把草案说成已完成研究注册。公共 CI 配置和本地无宿主复现已验证，远端 GitHub job 未在本次本地工作中触发。仓库保持 private/UNLICENSED，公开许可需权利人另行决定；元数据、打包范围和第三方通知已明确。工程回归不构成方法收益、未见任务迁移或论文贡献。

`pnpm coverage:core` 单独生成 HTML/JSON 与文本盲区报告，不设覆盖率目标；PR CI 保存报告。`pnpm format` 统一代码风格，历史原文和旧 fixture 字节不格式化。`pnpm audit:distribution --pack` 校验真实 tarball 的每个构建输出和随包通知，不发布包。实验工具不加入产品状态机或默认 verify 的实跑路径。

四项非实跑工作的交付与证据边界见[工程验收清单](nonrun-completion.md)。浏览器运行时依赖的原始许可由构建自动收集到 lib/licenses/npm，随包记录名字、版本和文件摘要。

## Agent 工具与递归交付

[tool-policy.ts](../assembly/src/tool-policy.ts) 是角色、工作态与等待态的工具能力清单，同时用于工具注册限制、Prompt 工具/section 过滤和执行 guard。普通 Task 为 22 个工具，acceptance 为 18 个；root 为 11 个；proposal/publication 为 5 个；improve 为 9 个。内部 preset 不含 present 或 skill-filesystem。每个执行/验收会话的 SkillRegistry 单独隔离，只发布本 Run 固定 Method 的绑定，外部同名 Skill 不进入目录或内容。

普通 Task 在重大实现前进行一次有界原子性判断；必要时摸底后再判断一次。无需拆分的工作可直接完成。分解仍暂停父执行，所有未结算 children（含 exploration）均形成等待，不引入并行父工作区。每层 execution/acceptance 共用 workflow 预算；maxRuns 是上限。宿主对分解后等待及 blocking 问题结束当前 turn，按原生通知恢复。

委派、阻塞问答与封存前，执行屏障同时核查在途工具与该会话仍运行的后台 jobs；先收集或取消再重试。等待期间保留 job_list/job_kill 清理，隐藏 job_output、执行及对应原生说明；后台任务不代表子 Task 交付。网络访问保持原领域合同约束，proposal/publication 没有 web 能力。

memory 的 `{}` 是无模型调用目录，`{ref}` 读取 checkpoint；Task 或有显式 predecessor 的 improve 可用 `{prepare:true}`，一次直接返回正文或持久失败，不重复购买。root/review 没有 prepare 参数。问答通知给出可复制 output 和 next；resolves:false 保持问题开放，新的答案版本使用新 requestKey。

模板目录返回 entries/from/total/nextFrom/complete；review/improve Method 默认最多 4096 UTF-8 字节，按 next/complete 继续读取。artifact 默认选择 verified，其次最近 sealed，必须检查 status 和准确 runId；封存不是验收通过。新提案新增 Method Tool 必须说明 purpose/when/input；既有固定资产保留原 digest，可按需追加描述。review 的 pass 必须引用 evidence 或有相应 protected pass，unknown 可保留空 evidence；字符串仍仅是语义引用。

[改进指南实施验收](guide-implementation-20261024.md)逐项记录递归交付、固定 Skill、memory、问答、共享工具策略及离线反例。真实模型与研究实跑按本次用户要求暂缓。
