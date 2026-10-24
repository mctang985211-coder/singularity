# RSI 流程修复取证

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

更新：2026-10-20；修复起点 `7bd91bb`。这是实现与运行记录，施工顺序仍由 [终局计划](task-first-domain-rsi-plan.md) 持有。历史运行、冻结 checkout 和 Buckyball 源树未回写；本次没有回退 Git，保留既有输入、隔离和取消修复。

## 2026-10-20：Buckyball 已结束，未发布改进

最新运行 `/home/ROXY/singularity-next/buckyball-rsi-repair-20261019-204028` 的终态 cutoff **551**，不是仍在死锁：业务根 `task-ca03bed06dd40662` verified / accepted，`rsi.status=completed`；搜索 `improve-75bc0b101949dfe70a545d0e` verified / accepted，`search.outcome=insufficient-evidence`。报告审核 `review-8b80db9ae8a277b7c9159acb` completed，`improvement-reported=pass`。一轮真实测评 `round-7af0be5fc39a02e0826dd226` completed，winner=null；两份候选均通过独立筛选。作者在还剩四槽时选择如实结束，预算是上限，不要求耗尽或找到赢家。

终态与根因摘要分别保存于该目录 `terminal-snapshot-20261020.json`、`failure-diagnosis-20261020.json`。它们补充历史证据，没有修改控制事实或补写历史分数。下文 2026-10-19 cutoff75 是当时观测，已由此终态更新。

| 比较对象 | 实际观察 | 宿主结论 |
|---|---|---|
| incumbent | 4/4，质量均为 1；成本 50,639,276 | 基线完整 |
| 候选 A | 4/4，质量均为 1；成本 72,750,152 | 成本增加约 43.66%，没有质量收益，正确拒绝 |
| 候选 B | 3/4 有观察，质量均为 1；另一次记为 infrastructure-failure | 缺测，不能按完整候选评分或发布 |

这里的成本为被冻结业务 trial 及其子任务、验收的原生计费 token；不包含 RSI 作者和方法治理。每个 split 只有一族，仍低于三族统计门，即使没有流程错误也不能据此宣布领域迁移。

### 丢失的 trial：职责泄漏与错误归因

候选 B 的评测根 `task-51b59b919f716e87`，原生 session `singularity:agent:trial-13067e78e724bd51fc0d7828`：

1. root 原生 seq262 委派 repair `task-2ccee059e1bbd242` 和依赖其产物的 audit `task-9fca50236a4f7e6d`。它从公开 `inputs/verification.json` 抄出私有 oracle argv，冻结成 repair 的 `frozen-check` 标准，要求孩子执行。
2. oracle 本来只向宿主 verifier 挂载。repair 实际执行得到 `MODULE_NOT_FOUND`，原生 seq379 向父询问。私有文件没有向 worker 挂载是正确隔离；公开输入暴露其执行配方并诱导错误委派才是问题。父后来解释其为宿主检查，也不能回写已冻结子标准。
3. repair 提交了真实补丁和公开 BEMU/scalar 证据。独立验收 `review-f216f8e73d2257df3748db01` 对另外三项标准通过，对不可执行的 frozen-check 判 unknown；这个判决不能改成 pass。
4. scheduler 在必需子责任未通过时调用 `failRun` 没有传 cause，默认 runtime。`observeSolve` 按此事实将父根记为基础设施缺测，掩盖了候选生成不可履行 workflow 的业务失败。这不是缺少宿主 oracle 环境，也不是异步 RSI 再次死锁。

### 本次修复与边界

- **公开契约与宿主配方分离。** `buckyballTaskInput` 只导出 version、repository、source、policy 和 `verificationDigest`。完整 argv、私有文件及工具摘要保存在 verifier-only 的 canonical manifest。verifier 先校验 manifest 字节摘要和公开投影，再执行原有隔离检查。生成器及漂移探针使用同一布局，不再把完整 manifest 放进 worker 输入。
- **委派提示明确所有权。** root 只冻结子节点凭声明输入/工具可履行的责任；宿主模板检查在封存后运行，不能变成子命令或额外标准。四角色 native 测试确认这句话确实送达 root 模型请求。
- **失败原因沿责任传播。** 必需子任务验收/业务失败传播为 parent business；实际 runtime 或 cancelled 仍传播为基础设施失败。现有测评据此记录失败观察或缺测，不增加新状态、重试机制或故障判词规则。

没有放宽独立验收、私有 oracle、固定模型、成本规则、样本族数、迁移门槛或发布条件。旧结果保留为当时真实记录，不补成 4/4，也不伪造赢家。

### 修复验证

- 修改前的反例 `/tmp/buckyball-failure-cause-red.log` 复现：子责任业务失败，父却得到 runtime。修复后覆盖 fail/unknown、剩余重试额度、依赖阻塞与真实 runtime 的传播；native solve 覆盖 business/runtime/cancelled 的测评分类及封存轨迹。
- 三文件 70 项定向回归通过，日志 `/tmp/buckyball-root-repair-targeted.log`。真实受限 verifier 回归覆盖正常正反例、worker 无法读取 oracle/manifest、公开 policy 被改及私有 bytes 被改均被拒绝；保留工具漂移检查。
- `pnpm verify` **退出 0：92 文件 / 969 测试 / 7 gates**，日志 `/tmp/buckyball-root-repair-verify-final.log`。其中 TS2322 输出来自故意破坏类型的构建反例，最终类型/构建与门禁通过。
- 新独立目录 `/home/ROXY/singularity-next/buckyball-contract-repair-20261020-1100` 保留当前源码副本与新生成 domain，未改旧运行。实际 RISC-V 编译、BEMU 与独立 host scalar 比较中，六份 known-pass 全 pass、六份 known-fail 全 fail；compiler-pin-drift 为 unknown，wrong-stride-hypothesis 为 fail。证据为其中 `private-oracle/selftest-results.json`、`private-oracle/probes/results.json`、`private-oracle/execution-evidence.json`；日志 `/tmp/buckyball-contract-repair-generator.log`。六份公开输入均无 checks/immutableFiles。

本次未新跑付费模型 RSI。以上验证修复了契约暴露、验证执行与失败归因；不能据此声称新提示已在完整模型搜索中产生改进，或一族 pilot 已达到论文级迁移证据。

## 原故障：按 Agent 实际收到和产出的东西判断

复核目录：`/home/ROXY/singularity-next/buckyball-commandcode-rsi-20261019-184556`。业务根 `task-ffd8377981b0ba92` 失败；RSI `improve-553eca5da1111cbb54482c7f` 的报告通过独立验收，但 **六个候选槽、零评测 round**。不能把 report accepted / RSI completed 解释为完成了改进实验。

| 证据 | 根因 | 修复 |
|---|---|---|
| 作者 method 结果 seq15 共 31,697 字符，同时塞入全部资产、格式、规则、状态、反馈和模板 | 控制状态与长材料混在一个工具结果，作者必须自行判断执行权与恢复动作 | `kind=search` 返回短状态与作者模板；资产、规则、详细反馈分开按需分页 |
| 作者提案结果 seq124/144/186/348，均为 `predicted_affected must name Tasks with cited native evidence` | 预测列表包含已有真实契约但尚未启动的下游节点；旧校验错误要求每个预测节点拥有被引 session，也不返回合法 ID | 先验证每份原生证据的读取权限，再允许预测其 workflow 内的实际 Task；错误列出允许 ID |
| `review-02b5be3f983fbc6383a149a4` 的 proposal-safe：`partial on untested ... transfer` | 入场前筛选要求入场后才能取得的实测迁移证明 | pre-execution screen 判断机制是否有可检验的迁移假设；实测和发布仍走原测评与独立审核 |
| 同一 critic 声称候选关键文本已存在于 incumbent，但冻结 `baseline.workflowGuidance` 为空 | 混淆 before/after，造成错误“没有实际机制”判决 | 把实际修改字段的 `comparison.before/after` 放到 subject 开头，并明确本次审核用途 |
| 业务 acceptance 把自己称为 publication-style review；未使用可读的封存生产轨迹 | 审核用途混淆，实际执行证据被当成不可核查 loose files | dispatch 和动态上下文明确 acceptance；引导读 sealed source trajectory，必要时做有界取证 |
| 提案调用同步等待 critic/selftest；重启的冻结批次依赖作者重新调用 paths | 作者工具调用承担宿主长任务，恢复进度依赖模型再次做对动作 | 准入冻结 bytes 后立即返回；driver 自动推进冻结批次、测评和事实通知，无需作者重发 |

最后一项是源码直接确认的调度/恢复耦合，不声称它解释了 `184556` 所有失败。该轮第二个 critic 对 validator 的条件错误和未建立 Skill/Tool 可达绑定给出了具体反例，这些是合理拒绝，不能为了产生赢家而绕过。所复核原生轨迹没有 tool-result pruning 事件，不能把本轮失败归因于裁剪。

## 实现边界

`rsi-state.ts` 只把现有 Run、batch、round 事实投影为 ready / screening / evaluating / reporting / completed / failed；没有另一套持久状态。工具准入、实际模型 schema、动态上下文和宿主推进共用该投影。待办期间不再发起作者模型 step；筛选拒绝或轮次结算后，宿主用事实 seq 标识的幂等消息恢复同一会话。

`propose_method` 只做整批静态预检和附件冻结，立即返回 screening。后台使用这些封存 bytes，不读取作者后续改写的文件。非持久化故障结算为明确槽结果；持久化写失败仍上抛，重启从同一事实恢复。取消不当作卸载损坏，其它卸载/写入错误仍保留。报告的待办准入检查移到封存前；底层 forCall 直接调用也无法先封存报告再因待定批次失败，回归确认拒绝前后控制事实不变。

分页资产只返回 Method bytes，不再附带旧入口的 rootCapabilities。Buckyball 首批候选把工具探测要求也写给 coordinator，存在角色歧义；这不等于实际越权执行，critic 认为其“不能探测就标为 inferred”的路径仍符合能力边界。最终作者 system 补回两句：root 只读、委派、提交已验证子产物，命令/实现/集成由委派 Task 执行。原生四角色测试直接检查这条边界与可执行路径送达模型请求；不声称已运行的冻结作者收到这次后补内容。

独立 critic、候选 selftest、固定模型与根绑定、私有 split、成本上限、样本/族数、发布审核及 CAS 指针条件均保留。没有预制候选、注入解答或让作者自行测评。

## 离线验证

2026-10-19 `pnpm verify`：92 文件、965 测试、7 gates 全通过，日志 `/tmp/singularity-rsi-repair-final.log`。覆盖静态拒绝不扣槽、准入立即返回、待办期间写入/提案/提交关闭、拒绝后自动恢复、删除可变提案后的冻结恢复、取消、轮次与发布中断，以及四角色真实 native 请求中的 prompt/schema 送达；当前最终验证见上节。

私有 split 的显式 rootId 定向回归也通过：`/tmp/singularity-rsi-private-read-regression.log`；最终全量运行包含该回归。

另用实际 Task 命令构造“有契约、无 Agent/Run/session”的下游节点：同根预测可越过证据检查进入独立审核；无关 Task 被拒绝。该单元夹具没有模型宿主，审核启动后按预期结算 screen-failed，不能算模型评测证据。

## 真实模型验证

两次运行均使用用户现有 `commandcode / deepseek/deepseek-v4.1-flash`，reasoning=max。原生会话在各自 `home/sessions/**/session.v4.jsonl.zstd`，控制事实与附件也在各自 home；`host.log` 含私有 token，不作为公开附件。

### letters 生命周期

运行目录：`/home/ROXY/singularity-next/rsi-repair-letters-20261019-2025`。启动快照已含异步生命周期修复；随后主树把重复的 method 作者界面进一步收敛为分页 authoring，故该目录不代表最终作者读取界面的全部调整。

- 业务 root：`task-ef8b0b702f469403`；RSI：`improve-3a9b51d86754aff2c01b6828`。
- 作者原生 seq184 调用 propose；seq185 立即得到 screening；seq187 turn/end=blocked。等待时没有继续轮询或编辑。
- critic `review-674012f2595d756e06b14810` 六项通过，明确区分空 baseline 与候选 workflow 文本，未要求预先证明迁移。
- round `round-06ae651f41b199fc6d3ef280` 已完成业务测量与 strategy 决定：基线/候选质量均为 1；成本为 590,628 / 443,723 原生计费 token，单次相对成本下降约 24.87%，winner=0。
- 独立 publication `review-296098ae1eebac8caa79fda6` 通过；control seq95 release/approved、seq96 pointer/switched、seq97 rsi/round-settled=completed。作者原生 seq192 收到 factSeq=97 的自动反馈，seq193 获得 ready 和五个剩余槽；没有重发提案。
- 作者自主继续第二轮 `round-e2a760a2fe037ae01e8cb49f`：质量仍为 1，单次成本 443,723 → 431,073，winner=0；control seq186 release/approved、seq187 pointer/switched。两次筛选、测评与发布均实际发生，没有预制候选或人工发恢复指令。
- 最终报告于作者原生 seq343 提交，独立 acceptance `review-65dc306095903f1e70e477c9` 已完成，`improvement-reported=pass`。control cutoff197 确认搜索 Task verified / closure=accepted / search.outcome=improved，源业务根 `rsi.status=completed`。终态快照与精简证据保存在运行目录 `verified-snapshot.json`、`lifecycle-evidence.json`；这次不是仅有报告通过而零评测。
- 单独提交 learning=false 的后续业务根 `task-156e2cea4cca878c`，已 accepted。control seq139 bound、seq140 delivered、seq142 read 均固定已发布的 `method-2a0c0d3379fe1232abc64a1f`；验证新业务确实消费发布版本，不只改了指针。它仍使用同一冻结输入，不是迁移实验。
- 恢复后作者原生 seq211/212 读取本轮评测轨迹时带 rootId，被错误路由至只允许已关闭业务根的历史接口。主树已允许当前搜索自有的 evolve evaluation root，并按该 root 筛选封存轨迹；回归同时验证不能借此读业务根 session 或私有 split。此项修复不回写已运行的冻结 checkout。

这是无 suite 的单输入、单次生命周期诊断。成本差异不能证明统计稳定、陌生任务迁移或论文级 RSI 效果。

### Buckyball 领域流程（2026-10-19 历史观测）

运行目录：`/home/ROXY/singularity-next/buckyball-rsi-repair-20261019-204028`；root `task-ca03bed06dd40662`。冻结源码与构建摘要经 deploy 校验，host doctor 全通过；独立 checkout/home/control 使用新端口 7345。此运行含 search/authoring 工具界面；之后主树修正显式 evaluation rootId、直接报告提交，并补回作者可见的 root 能力边界，未改写这个冻结运行。

使用原六题合成 suite，摘要 `3c4118342b7d0f787bc0b672805c9bdb27d6cf1844ffcbd0afecbb4639f1afdb`。repair 与独立 audit Task 的 acceptance 均已通过；根 acceptance `review-a0d3176efa2d351513c87fa9` 也已完成，两项标准均 pass。审核实际读取封存 producer/audit 轨迹：producer 从打包 patch 重建真实 RISC-V ELF，BEMU 对独立 host C reference 完成 38 组、170,016 输出 bytes、96,048 gap bytes 比较；audit 自行生成另外 10 组，独立编译/BEMU/scalar 复验，并用错误 stride / 额外行的负控检出差异。审核没有再把可读封存轨迹当成无法取得的 loose files。

control cutoff52：业务根 verified / closure=accepted；宿主封存业务轨迹并自动启动 `improve-75bc0b101949dfe70a545d0e`。当时尚未形成领域 RSI 终态，不计作成功；最终结论见本文 2026-10-20 节。

作者原生 request/header seq11 实际仅暴露九个证据/文件/提案/报告工具；seq14 首次调用 search，seq15 返回 2,451 字符的 ready 状态与模板。随后模型沿 next 读完 subject 和分页资产、authoring，界面没有再一次返回原先 31,697 字符的混合入口。seq64 曾幻觉调用未暴露的 bash，宿主明确拒绝；不能声称模型从未偏离。请求工具名、实际 search 结果和拒绝记录保存在运行目录 `author-interface-evidence.json`。

作者 seq209 自主提交两份候选，seq210 立即返回 `screening` / slotsConsumed=2；seq212 turn/end=blocked。两个独立 proposal critic `review-568feba1c445d727220c424b`、`review-e3cf8d5f1a2b70f50f3ea0e6` 均已完成，六项标准全 pass；不是在缺少预先迁移实测时拒绝入场。control cutoff75 确认批次已结清，自动创建 `round-7af0be5fc39a02e0826dd226`，新业务评测根 `task-e759e904c6983e51` running。没有向作者追加人工恢复、候选或解答。

当时的领域观测快照与筛选/评测请求保存在运行目录 `observation-snapshot.json`、`domain-lifecycle-evidence.json`；它们记录 cutoff75 进行中的测评，不是完成或发布证明。

每个 split 仅一族仍不足最少三族统计门；完整逐题 pilot 入口、真实陌生任务集、MLIR/RTL/PPA 和另一机器复现仍是原计划中的未验收项。
