# context.md —— 当前接手状态

本页替换当前状态；历史证据从 Git 查证，施工顺序只在 [终局计划](task-first-domain-rsi-plan.md) 维护。

2026-10-20：Task v23 / Strategy v9 / Measure v5 / Review v5 / snapshot v13。流程修复起点 `7bd91bb`，未回退 Git；保留现有 Task/workflow、冻结输入、独立验收、case×trial、取消与 champion 验证底座。

`184556` 的 RSI 报告通过但六槽零评测。已按原生事件修复预测下游节点必须有被引 session 的错误条件、critic 入场前索要迁移证明与混淆 before/after、acceptance 用途提示，以及提案同步等待与依赖作者重发恢复。`kind=search` 提供派生 phase/next/预算与作者模板；资产、规则、反馈分页。提案冻结后立即返回，由宿主继续筛选/测评、幂等恢复作者；待办期间关闭作者写入与新模型 step。没有新增持久状态源。当前搜索的 evolve 评测 rootId 读取已修正，并保留跨根/私有集隔离。

实际 letters 已自主完成两轮筛选、测评、独立发布和作者自动恢复；最终报告通过独立验收，源根 RSI completed，后续业务根实际消费发布方法并 accepted。不能将单输入单次成本下降解释为迁移。Buckyball 在 cutoff551 已 completed：两候选、一轮测评、报告 accepted，outcome=insufficient-evidence，无发布。候选 A 质量不变、成本增加 43.66%；B 因 root 将公开清单中的私有检查冻结进子标准，丢失一次观察，且子业务失败被错记 runtime。现已把公开任务输入与 verifier-only manifest 分离，明确委派职责，保留子失败原因；969 项回归、7 gates 和新生成六题真实 RISC-V/BEMU 正反例均通过。本次未新跑模型 RSI。准确 native seq、日志和证据见 [RSI 修复取证](rsi-repair-evidence.md)。工作合同统一见 [RSI agent 工作合同](rsi-agent-contract.md)。原始运行与冻结 checkout 保留，host.log 凭据不输出。

尚未验收：Buckyball 完整逐题 pilot、复杂任务稳定收敛和陌生任务迁移。六题合成 suite 每 split 一族不足三族统计门；不覆盖 MLIR/RTL/PPA，无另一机器复现或论文级收益结论。报告 accepted、测评轮次、发布与领域收益严格区分。

## 18. G1/G2 接手审核与用户裁定（2026-10-11，基线 `35b0c7c`）

以下保留历史合同与验证记录；其中完整 Method 提交、批次拒绝等旧行为，以本页当前状态和终局计划为准。

### 18.1 用户裁定与长期约束

以 `/home/ROXY/code/docs` 的 KISS 目标为准；旧 Singularity 只读参考，开发和运行使用 `/home/ROXY/singularity-next/`。所有节点拥有独立 DSH 主会话；普通子节点保留文件、命令、编程和 Skill 能力，部署 root 仅协调与受限只读，必须委派实现。模型自主分解和探索，不预制候选、解答、子树、轮次或工具顺序。

Task 只声明目标、冻结输入、交付物和可判断的标准。模板是可选来源；审核实现归独立 ReviewRun。执行节点不参与方法治理，改进归根任务关闭后的 RSI 链。历史实验只读，新实验使用新协议，不建兼容桥。

SHA256 领域只提供一份完整 RTL `sha256.v`、一份固定 Yosys 综合指导及必要 `task.json`，不提供脚本、候选提示、预设子树或额外 RTL。交付 `rtl/sha256.v`，只改 `sha256_w_mem` 模块，core/K 模块字节、端口、复位、SHA224/SHA256 功能和逐周期时序保持。完整 core 面积基线 64858.4544 µm²，改善至少 1%。成本仅含一次业务 root、子任务和独立验收截至提交的原生轨迹，最多为基线 125%；RSI 分析、提案和发布审核用量永不参与比较。使用 max reasoning，不设 campaign token 预算闸门。整轮结束后统一封存 token-meter 的 tokenUsage 原生投影供 RSI 与脚本读取，与 ui-chat 的 StatsPills 同口径；缺失 usage 遵循该投影语义，不估算、不预留，也不停止后续请求。

### 18.2 当前状态与效果验收边界

- 最新 SHA256 max 实跑 `/home/ROXY/singularity-next/sha256-max-20261015-154731/` 已停止并保留现场，冻结 Task v15 / Review v5 / snapshot v9 与最简领域；control `singularity-sha256-max-20261015-154731`，root `session-b6c4f915-f0ac-4949-9c6e-7b9662692166`。全新 home/control，预算 300000000 原生 tokens，启动 tasks/known/reserved/unknown 均为零；root 与实际 child 原生请求均为 reasoningEffort=max。父背景 checkpoint 成功；子节点的原生 TokenMeter 把 reasoning 按字符估算为过高上下文，触发压缩，8192 输出额度导致四次截断，而 BasicCompaction 吞掉错误继续下一步。本轮未完成任务验收或 RSI；原始事件、费用与停止记录见 anomaly-diagnosis.json、memory-anomaly-evidence.json。取消产生的未知 usage 与之前的摘要截断分开记录。
- 前一已停止 SHA256 实跑为 `/home/ROXY/singularity-next/sha256-root-20261015-040521/`，使用冻结的 Task v14 / Review v3 / snapshot v8。根实际分解，但生成的子合同把系统遍历及每种变体实测列为验收义务。`task-db07eb87ba823d75` 原生会话 seq1058 已记录面积 64105.232 µm²、schedule/functional verifier exit=0，seq1084、1156 仍选择追加搜索并等待 2592 个候选。领域 measurement 每次仅运行固定综合流，遍历脚本由节点自行生成；达标后缺少停止协调、把探索变成必需覆盖和父生成错误优先级标准均有实际记录。可追溯摘录、准确 session/seq 和冻结脚本摘要见该目录 execution-analysis.json；局部输出不代表根验收或 RSI 收益。
- Task v18 / Review v5 / snapshot v9 阶段的历史验证：父背景 memory、责任投影、可停止探索和最简 SHA256 领域已构建通过；全量回归 73 个文件、757 项测试通过，7 项门禁通过。原生 host 集成验证默认生成父背景、子模型未读取前不注入、工具回读、动态责任上下文和等待执行限制；轮后直接封存 token-meter 的 tokenUsage 原生投影，冷读结果与 ui-chat 视图逐字段一致，四个原生计费桶相加且 reasoning 不重复计数，缺失 usage 不阻断本节点、同伴节点、后续根任务或 RSI；取消测试覆盖后代、待办问答、未完成审核与冷恢复。私有 DSH 的 TokenMeter、BasicCompaction 修复经 278 项定向测试并安装，原有 Session 补丁产物校验未变；真实 Loader 预设验证自动摘要截断终止回合、保留 MAX_TOKENS 和原生用量来源。原始 child 会话 seq380 离线计价由 806378 修正为 115774，低于 800000 触发阈值，替换后重新估算且不负向归零。验证及复演结果保存在最新实验目录的 repair-validation.json、token-meter-before.json、token-meter-after.json。本轮实跑已停止，尚无复杂任务收敛或 RSI 收益结论；前一 Task v14 的测试仅为历史证据。
- `sha256-memory-20261015-023610` 因 root 持续原子求解而停止；`sha256-root-20261015-033722` 启动时发现 Bubble 把实现工具注册到 agent 自有 scope，也已停止。各轮保留原生 usage 与零账启动记录，不重置已发生费用，不恢复旧协议实验。
- 隔离重构实跑位于 `/home/ROXY/singularity-next/assembly-rewrite-20261015-001246/`：抽取 `task-6cc92339a853891e` 独立通过后才启动计数 `task-240d7ce3a0ff9576`，父 `task-8c96b924fcdf5025` 复用其封存的 `35\n`，三个独立审核、五项标准全通过。七个模型会话均只有一个 system 版本，method/模板按需读取。RSI 已冻结候选，预算中断前尚未发起评估、发布或提交报告；已知 2,938,875 tokens，另有一个缺 usage 的中断事件，不猜计费。host 已停止；审计入口为该目录的 workload-evidence.json。此实跑验证 Task v13 接口与两阶段业务链，不能代替当前 Task v17 修复或复杂任务效果验证。
- 基于 `f892376` 的 Task v10、Review v1、snapshot v6 历史验证包含 657 项测试、7 项协议门禁和五个离线探针；提示与工具说明修正另经构建、43 项方法/分解测试和 32 项读面/分解测试复验。该历史结果不代表当前 Task v23、Review v5、snapshot v13 的验证，也不证明领域收益。
- Task v12、Review v2、snapshot v7 的历史完整 verify 通过 674 项测试与 7 项门禁；等待责任的 `assembly-m26-parent-waits-for-a-running-child` 变异被捕获。测试覆盖问答持久化、真实 Cordis Skill scope、方法固定版本、按文件工具授权、证据分页、审核贡献引用、原父 Run 通知及已提交孩子的冷恢复；验证日志位于实验目录 core-v12-final-verify.log，离线检查不等于复杂任务收敛。
- 隔离实例位于 `/home/ROXY/singularity-next/task-rsi-20261014-core-v10/`。`letters3` 根 `task-0ba8dbedac505bea` 独立审核通过；RSI `improve-6a418dd39b84a823e81c73da` 自主提交候选、完成独立双侧测评并决定无赢家，报告经 `review-05005d3b91989f6d1016295b` 通过，control seq 73 记录 completed。该实例费用 3,866,739 tokens，无未知 usage；它证明流程闭环，未发布新方法，也不证明复杂任务机制有效。
- 首次 SHA256 根 `task-e2f97f93931e506f` 包办探索，最终记录 80 次 bash、2 次 singularity_read、零分解；按用户纠正中断，未提交验收。已知费用 4,592,384 tokens，取消产生 1 条未知 usage，按声明上下文和输出上限保守预留 1,131,072；该预留不是实际可比较候选费用，旧实例不继续调用。
- `sha256-task`、`sha256-plan` 提示验证仍延后分解至基线测量之后，已中断，各保守预留 1 条未知 usage。历史 `sha256-workflow` 使用 high reasoning，启动额度 67,663,909 tokens，继承累计费用保守上界 232,336,091。根 `task-92e516555123d8df` 先给计划，第一个工具为分解；control seq 15 形成 schedule `task-35e120a79d93827d` → integration `task-833f0219b5daacbd`，均支持父标准。根及 schedule 随后收到用户纠正的原生 steer，交付路径见 `workflow-correction-delivery-*.json`，不将该干预冒充默认提示的独立行为证明。
- 原历史实例和已中断实例只读。旧累计费用详见实验目录 `inherited-accounting.json`、各 `*-experiment.json` 和原生事件，保留原余额与未知 usage；本轮按用户明确要求独立从零计费。
- SHA256 workflow 的保存终点：26 个任务、9 次分解、8 次提交、6 次通过、1 次失败、1 次审核未完成；根任务未提交。9 个分解没有 handoff，父子问答为零；方法消费事实仅 4 条。费用 53,854,161 tokens；该旧接线实例只读，不把局部审核冒充根闭环。逐任务审计入口为实验目录 core-v12-audit.json。
- 待完成：原生端到端与复杂领域协作效果验收、RSI 比较测评。本轮先修复并验证，未启动新实跑。当前 SHA256 没有自动面积 measurement，RSI 的通用 pass 质量不能被称为面积收益；面积和行为标准仍由独立审核判断。无赢家、无候选、证据不足或未达标均如实记录。

### 18.3 当前结构边界

TaskContract = goal / artifact / inputs / criteria / optional skills / capabilities / template；模板和自行编写的任务使用同一完整合同，模板工具返回已填好的样板。guidance 可选且只解释工作方法，不能代替标准；原模板标准保留，新增要求写入合同。criteria 仅有稳定 ID 与效果。测量实现仍单独固定 verifier ref、version、implementation digest。子任务关联父标准，精确重复的祖先契约和输入拒绝；模板来源不参与重复规避。

部署入口与 RSI 测评根使用 singularity-root：提供任务读取、父背景读取、分解、停止未选探索、回答、重试和准确子 Run 提交，保留 Bubble 约束的 read/read_image/glob/grep。创建具体 agent 后在其 agent.ctx 过滤继承工具，并对 agent 自有工具应用 prompt schema 过滤和执行 guard；DSH restrict 只约束继承工具，不能直接屏蔽 Bubble 自行注册的 write/edit。root Bubble 始终只读，不挂载 shell 或 Skill 执行工具；原生搜索仅额外挂载确定的 ripgrep 可执行文件。root 必须委派；最终选择直接孩子的已验证 Run，宿主在现有提交 drain 屏障内把封存字节复制到 root 声明的产物，仍执行 root 的独立验收。sourceTaskId / sourceRunId 绑定提交请求；其他分支、未验证 Run 和非 root 的复用请求拒绝。普通子节点保留 singularity-next，可自行原子求解或分解；不新增工作流协议或 memory store。

Run 直接固定方法版本，Bubble 冻结输入附件、artifact 输入的 producerRunId、模型、工具、工作区和作用域。审核按该固定 Run 读取直接 producer 的封存字节、结论和轨迹前缀，不从时间或 latest 重建来源。提交以路径封存实际字节，`working → submitted` 为唯一提交路径；独立审核绑定准确产物和标准，执行者不能自判。审核的 fail 是完成判断，运行失败另记。取证子 Task 各自独立审核，ReviewRun 不触发审核审核者。

执行、审核、RSI 各有小接口面。system prompt 只写稳定工作规则，派发只送当前合同、工作区、固定方法引用、父子边和可选 handoff。method 工具按需返回 guidance、绑定的 Skill/Tool 目录及读取/调用样例，Skill 正文由原生工具读取；无自动消费记账。产物正文按 UTF-8 字节分页读取（默认 16384，最大 32768）；轨迹先分页列出事件索引（默认 20，最大 100）；指定 eventSeq 后按 UTF-8 字节读取该原生事件（默认 4096，最大 8192），next/complete 明确标记余下内容。模板索引按需分页返回名称、目标和所需 producer 模板（默认 20，最大 100），按 ID 与显式 producer 映射读取完整合同；当前固定模板未提供映射时直接返回本 Task 的冻结合同，保留附加标准，不扩大 Skill / Tool 授权。完整方法和候选格式归 RSI 或独立审核按引用读取。子任务继承方法，普通执行节点不能创建或切换候选。

执行节点可有界摸底以决定责任边界，独立结果先委派再求解；单一最终文件不代表原子责任。孩子自行探索后代，父不重复接管其工作。分解显式声明 `requirement: required | exploration`：required 必须 verified，exploration 可择优并由父用 `singularity_stop_explorations` 记录理由停止。停止不产生通过证据、不满足输入依赖，仍依赖被停分支的探索必须一并停止。任何孩子结算即通知父判断证据是否足够，无需等全部探索结束才协调。宿主每次请求前投影当前标准、已委派责任、未通过的必需工作、活动探索、待回答问题和 canSubmit，并据此限制等待期间的执行及提交。

父仍须完成集成与独立验收，保留证据如何影响选择。handoff 区分决策、假设、排除路径及已验证证据，父会话历史不整体复制。RSI 的 subject.json 仅含冻结摘要，完整轨迹通过 singularity_read 分页读取。模型只用 singularity_propose_method 提交完整方法；宿主绑定 incumbent/round，先审查、再复用封存业务基线并冷启动候选，决策后独立审核发布。提案与发布审核仅暴露文件读写、封存材料读取和判断提交，不提供执行、网页或委派工具；无赢家或发布被拒时恢复原 RSI 会话，可在剩余额度内修订或如实结束。

结构化 memory 是给子 Task 的父背景，默认在子执行前尝试生成；摘要失败以原生 log-only 事件保存原因，目录标记 ready/failed，失败背景不阻断业务 Task，持久化和来源完整性错误仍传播；不把摘要直接注入子 system prompt。`singularity_memory()` 提供可读分支的统一分页目录（from/count 默认 20、最大 100），inherited 标出本节点继承引用，传 ref 才读完整 checkpoint。root 看整棵树，普通节点按现有任务可见范围且不跨根，独立审核及其取证后代仅看同一审核分支，RSI 可读关联执行分支。目录只投影原生 checkpoint 的身份、适用 Task/Run、来源截止位置与当前 Run 状态，不生成新摘要；历史 Run 与当前 Run 分开标记。checkpoint 固定 formatVersion、scope、sources、decisions、evidenceRefs、hypotheses、openQuestions、exclusions。模型按子责任筛选父会话与继承背景中的决定、依据、假设、疑问和排除路径；宿主从事实投影合同/方法身份、来源前缀及精确 verified Run 的证据身份与状态。checkpoint 和模型调用写入原生 log-only 事件，读取/恢复校验来源摘要、原始输入/输出和证据范围；不另建 memory store。JSON schema 不保证叙述语义保真，父声称 verified 不能提升为验收事实，其他分支的摘要不能增加本节点责任。

单 Session 达到上下文阈值的压缩全权归 DSH 原生 BasicCompaction，四个 preset 使用原生摘要、范围选择、工具配对、替换与恢复，assembly 不定制其内容或 JSON 格式。

### 18.4 终局、异步推进与恢复

Run 失败不立即等于 Task 关闭：根 agent 可在当前回合重试；静默且没有新的 working Run 时才关闭根。成功和失败都可进入后续分析，evaluation 根不触发 RSI。审核尚未委派取证任务时没有计划通知；冷恢复已提交的孩子仅恢复原会话与独立验收，不给执行者重发求解指令，验收完成后从新 fold 推进依赖。

业务结果返回后，后台等待相关原生会话静默并 flush，封存轨迹和费用，再启动独立分析。RSI 通过 singularity_propose_method 提交 1–3 个候选路径，先做结构检查和独立可迁移性、权限与泄漏审查；拒绝也消耗槽位，通过后冻结 round 请求。suite 按 case×trial 隔离比较，单题 debug 才复用已封存业务基线；无赢家可以继续剩余槽位或如实结束，总计最多 6 槽、repair=0，恢复不重置。冻结 champion 后执行独立 validation 和可选 heldout，发布再经审核与 CAS。宿主从现有 measure / strategy / release 事实恢复，不另建工作流或状态文件。未执行 RSI 必须说明原因。

模型请求不设 campaign token 预算闸门，也没有未知用量的保守预留账本。根轮次结束、相关原生会话静默并 flush 后，读取 token-meter 注册的 tokenUsage 原生投影，封存 summary.usage 和逐会话四个计费桶供 RSI 与脚本读取。总数与 ui-chat 的 StatsPills 同口径：uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens，reasoning 已包含在 outputTokens。复用根会话按准确 dispatch 和本 Run 封存提交界定区间，以原生前缀投影差值排除前后 Task；缺 dispatch 或缺 billing sample 明确标记不完整，比较成本为 unknown，不估算、不取消节点或阻断后续调用。轨迹保留连续原生前缀以验证来源，压缩事务与恢复仍由 DSH 管理。

### 18.5 不要重建的基础

底层协议拥有 Task 合同、依赖图、责任、状态迁移、探索停止和验收事实；assembly 负责领域声明装载、输入物化、DSH 工具/会话接线、调度和只读投影。DSH 管理单会话压缩事务和持久化；assembly 默认生成可按需读取的结构化父背景并校验引用，handoff 只传当前委派需要的上下文。保留单一信封、ControlSessionStore、append 队列、fold、闭合 schema、版本门、身份检查、不可变附件与证据绑定。内存仅管理资源，不代表业务进度；前端读取同一 committed projection。Web 根借用宿主会话，自建会话 disposer 归创建者，卸载可中断后台等待。

部署 seed 直接初始化当前方法。候选只做结构、绑定、工具样例和受保护边界检查；任务审核与最终发布审核独立保留。发布要求 committed 决定、独立见证、实际方法消费、成本上限及匹配 expected pointer。

方法绑定贯穿上下文、原生 Skill provider、singularity_run_method 和 Bubble 工具挂载。执行不从整个方法库授权：Skill 来自当前 Task 的固定选择；Tool 只有绑定文件可挂载，Bubble 记录同一方法版本和实现摘要。domain 不自动作为执行参考路径，公共材料在部署 references 中显式声明；合同输入清单不等于全部读取权限。未覆盖 capability 明确列为 gap，不扩大方法授权。

定向反例包括 `mutate:core-w1-single-active-run`、`mutate:core-w1-sealed-request-digest`、`mutate:core-w2-receipt-terminal-cutoff`、`mutate:core-w2-receipt-every-sequence`。变异细节由现有 baseline 持有。

### 18.6 现有证据入口

变异的编辑、run、witness 和结果由 [mutation baseline](../mutation-baseline.json) 持有，本文只保留阅读中有用的反例入口；不要求逐项在文档复制全部变异标识。
其余入口在 [F 实测](f-evidence.md)、[G1 实测](assembly-g1.md)、[G2 合同的基线入口](phase-g2-design.md#8-原-g2-变异记录的证据边界)；它们不证明新合同已实现。

| 范围 | 现有标识 |
|---|---|
| 任务/输入/依赖 | `mutate:task-responsibility-gate`, `mutate:task-verdict-input-binding`, `mutate:task-any-terminal-satisfies`, `mutate:task-unverified-child-accepts`, `mutate:task-only-missing-propagates` |
| 提交屏障与重送 | `mutate:control-barrier-ignored`, `mutate:recovery-precondition-before-identity` |
| 发布资产与历史 | `mutate:round-novelty-publish-removed` |
| 协议成员与读者 | `mutate:protocol-copied-rule-refused`, `mutate:protocol-nested-reader-widened`, `mutate:protocol-post-declare-push`, `mutate:protocol-nested-workspace-reader-widened`, `mutate:protocol-nested-metric-reader-widened`, `mutate:protocol-nested-weights-reader-widened`, `mutate:protocol-nested-run-reader-widened`, `mutate:protocol-nested-outcome-reader-widened`, `mutate:protocol-nested-verdict-reader-widened` |

完整历史原文用 `git show 35b0c7c:docs/context.md` 查证。当前合同/状态不追加逐轮解释，关闭问题从本页移除并留在提交历史。


### 18.7 旧协作能力的逐项去向

| 旧能力与源码入口 | Core 处理 | 当前接线及理由 |
|---|---|---|
| Task 契约、依赖 DAG、冻结输入与验收（task / task-runtime） | 保留并加强 | Task / Run / Bubble / Review 单一控制日志；子支持不替代父验收，负面调查仍可独立通过。 |
| 结构化 handoff（task-runtime/src/handoff.ts） | 简化保留 | 委派事实仅保存 decisions、hypotheses、exclusions 和已验证 evidence 引用；派发父子边与准确父 Run，相关合同通过工具读取。不复制父会话或再存一份 handoff 索引。 |
| 有范围的任务与历史读取（context/src/reads/guards.ts、context/src/session） | 简化保留 | 自身分支、祖先、直接关系、交接及回答引用；增加直接同级责任可见性以复用证据，同级后代仍受边界限制。正文/轨迹分页，审核读取冻结前缀，跨根拒绝。 |
| 持久化父子问答（task-runtime/src/service/questions.ts） | 简化保留 | question / answer 绑定双方准确 Run，requestKey 幂等；阻塞问题关闭执行与提交，现有原生 inbox 恢复投递，不新增问答文件、第二消息队列或状态索引。 |
| Task→Skill/Tool capability manifest（task-runtime/src/capability.ts） | 替代 | 固定方法内按统一合同选择；按需读取、provider、调用授权和文件挂载一致。部署原生基础工具仍由 DSH 提供；领域部署与 Bubble 约束不把未实现 capability 当已授权。 |
| Run waiting_children 与 batch settlement（task-runtime/src/orchestration/batch.ts、settlement.ts） | 替代 | 等待从子事实、问题和 round 推导，命令与原生执行共用一个判定；required 必须通过，exploration 可明确停止。父等待期间可读、协调及追加不冲突规划，不重复执行委派工作；停止分支撤销未完后代执行，不自动接管。 |
| 子证据回交与原 Run 恢复（task-runtime/src/orchestration/observe.ts、replay.ts） | 保留并简化 | 每次子结果结算即交回成果引用与审核证据，通知绑定父 Run，可停止未选探索后集成；同一事实去重，重试父 Run 有独立通知身份。已提交孩子冷恢复只继续验收，不重启求解。父审核收到贡献、封存轨迹及审核引用以判断证据如何参与集成。 |
| 独立审核、轨迹与 RSI 发布（verifier / evolution / environment） | 保留与替代 | 任务和发布审核独立；真实 Task 责任、问答、资产消费、成本和轨迹用于 RSI。单一方法指针替代独立资产准入链；旧版源码存在机制不作为整体可靠性证据。 |
