# Task / Skill / MCP 自改进实现

日期：2026-10-03。按 [KISS 审计](2026-10-03-supervisor-task-dag-kiss-audit.md) 在独立 worktree 实施；[原评审](2026-10-03-verify-supervisor-core-gaps-review.md)与审计保留施工前事实。

## 已实现的闭环

Task 规定结果，Skill 提供方法，Tool/MCP 提供动作。父节点优先检索可见模板，绑定参数或生成标准契约；执行和验收仍走唯一 TaskRuntime。普通 child 诊断交真实父 Run；共享模板、Skill 或能力变更才交 supervisor。Supervisor 物化候选、对照实验、请求已有工具的人审，批准后应用；根按原契约开新 Run，child 由持久消息唤醒负责父 Run 重新规划。恢复记录关联实际 proposalIds。

唯一协调宿主为 `singularity-coordinator`，reviewer/supervisor 分别装配稳定政策，删除相冲突的 reviewer preset。审批模式为 ask，proposal ledger 承接等待、决定、应用和重启；不另建审批或调度状态机。最新默认自动复盘失败节点与成功根，成功叶只留事实；Supervisor 可以按需委派只读调查并汇总跨节点证据，见 [跨节点复盘](2026-10-03-systemic-supervision.md)。自然结算与重复交接交错时重读已有账本终态，避免把已关闭会话误判为失联并重复启动。

## Task 模板与 DAG

- 模板是 `<id>@<version>.json`，含必填 `catalogPath`、适用条件、参数 schema、完整契约和可选直接子节点 `decomposition` 配方。库默认在 `$DSH_HOME/singularity/task-templates`，未设置 DSH_HOME 时在 `~/.dsh/singularity/task-templates`。`task_template_list` 是唯一模型检索入口。
- root 选择 `templateScope` 分类前缀，child 继承或收窄；`general` 分类保持可见。目录由同一模板库计算，不另建索引或 Task 管理器。`task_template_list` 先给有界摘要和分页，再按精确引用读取全文；每次可执行模型请求先装配范围内摘要。
- 全部实例进入同一持久 Task 图；实例不自动成为通用模板，只有经 Evolution 对照验证和审批后才发布可复用定义。
- 实例固定模板引用、参数与最终 contractDigest；无适用模板可提交标准契约，两者共用 normalize/admission。旧 Task 契约、旧 Run 的 Skill/MCP/模型绑定保持固定。
- worker／reviewer 的 Task、状态、Run 与 session 读取限定为职责子树、祖先和直接依赖；root／supervisor 保留其图的全局视野。模板分类范围与执行实例视野分别约束检索和运行上下文。
- 原子叶以明确输入产出一个可独立验收的结果；一次执行可调用多个工具。节点只写自己的直接子任务，按真实产物声明兄弟依赖，不把工具调用转换成 Task。现有拓扑保持父子分解树与同批兄弟依赖 DAG，不新增通用图编译器。
- Supervisor 可经 `task_definition` 改进 Task 内容与 `decomposition.children[].dependsOn` 前后关系。配方通过同一 `task_decompose` 展开、归一化、准入与调度，冻结引用和参数进入提案身份。晋升核对真实工具调用／返回、批次消费、子合同及依赖边；仅写 JSON 或伪造引用不能晋升。旧图不原地接线，批准后由负责父节点或新 root Run 消费新定义。
- `task_definition` 候选为 `{template,criterionRepair?}`。两侧冻结完整同格式模板库及摘要，session overlay 继承到新后代；父/根原验收保持不变，新 child 必须实际消费候选版本。
- 首次发布采用 `baseVersion: 'absent'`、version 1；更新追加 N+1。更新回滚追加原内容为 N+2，首次发布回滚移除新 v1；历史实例及实验记录保留。发布与回滚复用已有 file commit 和重启对账。
- 修改 child 判据须提供已有固定正反例，同原独立 oracle 的终态记录交叉验证，再重放 oracle 与候选判据；恒真候选不能洗白负例。该检查只证明冻结样本，不声称证明所有未来输入。已接受根契约的原地改题入口未开放。

## Skill、外部工具与 MCP

- 每个可执行 Task（root、协调父节点、原子叶）必须经 `requiredCapabilities` 选择至少一份可读、非空指导 Skill；根准入、子节点、恢复和重放共用检查。Skill 正文从该 Run 的冻结快照完整进入模型请求，缺失或篡改时拒绝执行。包内提供 `task-coordination` 与 `task-execution` 的基本方法，业务能力仍显式配置；叶节点应选择其结果对应的方法。
- 已有 Skill 同名更新沿原候选、双侧实验、人审和提交路径执行。Supervisor 优先改 Task 定义、DAG 配方和绑定 Skill 内容，录得工具能力缺口后再改 Tool／MCP。
- capability 候选为 `{rows,skill?,mcpServers?}`，恰好一个整行变更，可只授予已有 native tools 或 MCP，不强迫生成 Skill。新 execution Skill 仍使用 SKILL.md 与既有侧车格式。
- 删除核心 BB server 表。部署 `mcpServers` 是唯一注册来源，同一 parser 校验部署和候选；新增定义包含 serverName、description、command、args/env/cwd 与可选调用时限。capability 引用 registry id，实际工具名使用 `mcp__<serverName>__<tool>`。
- 候选配置复用 session binding 传给实际新后代：准入、Skill discovery、MCP 解析与调用均使用该侧 overlay，基线和生产配置独立。中断实验沿已有 ledger 结算，再由新的冻结 replay 重入；不声称中断 side 透明续跑。候选 registry 在隔离实验中挂载，真实启动 stdio server 并调用工具。摘要、registry revision 与 Run binding 冻结并在晋升前重读；审批呈现完整 mutation、启动定义、配置摘要和实际写入目标。
- 行与新定义一次写入部署配置，再更新 runtime registry；复用已有 commit intent、原子文件替换与 reconcile。回滚恢复行并移除新定义与可选新 Skill，已有 Run 保持实际绑定。开放 intent 阻断相关新准入。
- Native tools 必须已有授权；发布新 verifier、permission、preset/runtime policy 与任意资源包仍没有执行器，不伪装为已有自动能力。

部署显式选择指导方法，例如 `coordinate-tasks: {skills: [task-coordination]}` 与 `execute-task: {skills: [task-execution]}`；领域任务可选择已有领域 Skill。包内方法的存在不自动授予 capability。旧格式模板不能混入新目录；备份旧库后重新发布带 `catalogPath` 的模板并重新计算引用，历史契约与引用仍保留作诊断。未绑定指导的历史 Run 可以读取，但不能沿用旧绑定继续执行，需要有指导的新 Task。

## 验收与成功优化

不可结算的 mandatory review/formal 占位判据在准入拒绝，支持相应 mode 的已注册 verifier 可用，composite 保留。根缺能力时保留契约并记录义务；执行叶仍须具备声明能力。义务满足只认匹配 criterion id 的最新 verified Run 与 passing evidence。

成功源可冻结 `objective: 'tool-call-reduction'`：两侧原验收均通过，每个观察样本完整实际 Run 子树的工具调用严格减少，独立 holdout 不增长。任一后代 Review 或计量缺失为不可比较；晋升重读实际子树。失败修复保持原比较规则，不新增标量评分平台。

## 验证与备份

第一轮提交：Singularity `2d791cf`，外层 harness `8b68f0f`。build 成功；unit 2190 通过，integration 585 通过、5 跳过。

第二轮 build 成功；unit 93 个文件、2237 通过；串行全量 integration 84 个文件、609 通过、5 跳过。持久化 schema 检查通过，4 个 event roots 与指纹一致。所有 462 个手写源文件（含测试）均不超过 2000 行，source-size 检查接入 build；跟踪的生成 lib 统一重建提交。删除六个超长旧测试并迁移其原有用例，公共 fixture 只留一份。

真实模型 `deepseek/deepseek-v4.1-flash` 使用生产 prompt 与工具 schema，生成两个原子叶、一个真实产物依赖：`[3,7,-2] → [9,49,4] → {count:3,sum:62}`。TaskRuntime/AgentRuntime 执行实际 read/write 与受保护 command verifier，根和两叶均 verified。计划与执行记录见 [live DAG smoke](2026-10-03-live-dag-smoke.json)。

集成中的演化模型和审批回应为可控脚本，MCP 是实际 stdio 子进程；真实模型 smoke 的请求循环由 runner 控制。上述证据证明机制可执行和一个小 DAG 可完成，长期真实模型自主自改进的质量仍需业务任务实测。

第三轮实现将方法从硬编码 root prompt 移入正式 Skill，并补齐每 Task 指导、分类范围、请求前摘要、DAG 配方执行与晋升校验。构建和声明生成通过，unit 2253 通过；最终串行 integration 627 通过、6 按配置跳过（含 opt-in live 用例，已另行启用通过）。469 个手写源文件（含测试）全部 ≤2000 行，持久化 schema 与 diff 检查通过。独立包 `tsc --noEmit` 仍会报告源码／lib 重复声明与旧测试类型问题，未将其计为通过。

真实模型增长验证：两组独立输入分别完成 5 个 Task、深度 2 的责任树与产物依赖 DAG；根、中间节点、原子叶全部 verified。同一 `transform-numbers` 配方和 `summarize-transforms` 模板被再次消费，每个 Run 绑定指导，30 个无关 web 模板未进入请求。结果 `[3,7,-2] → {count:3,sumSquares:62,sumAbsolute:12}`、`[2,-5] → {count:2,sumSquares:29,sumAbsolute:7}`，实际请求分别 38／36 次。证据见 [live Task growth](2026-10-03-live-task-growth.json)，可按其命令启用复验。

第三轮备份：Singularity 与外层 harness 均使用 `backup/self-develop-20261003-round3`。Supervisor 内容／依赖修复、Skill 更新和 MCP 注册发布由脚本驱动真实工具与审批链验证；真实模型验证了递归 Task 生长和复用，尚未证明长期真实模型自主 Supervisor 的收益。

第四轮（复杂业务测试第一批）由主线程指挥子代理实施：有独立验收器的跨模块工程任务实跑、缺陷失败的修复链、新输入复测。基线为 main 合并 `7d9038a`（图生命周期与模型钉扎）；本轮计数相对第三轮记录的差异（unit +8、integration +11 中的 +9）均来自该合并，隔离本批新文件复跑确认与本批无关。

- 新增 `tests/integration/live-log-pipeline.spec.ts`（opt-in，`SINGULARITY_LIVE_LOG_PIPELINE=1`）：真实模型交付跨模块日志分析 CLI——parse／aggregate／report 三个可执行模块加 cli.mjs 端到端串接；独立 checker 从受保护输入自行重算全部期望值并分阶段裁决，`cli` 阶段实际执行 cli.mjs 重跑全管线。两组输入（12 行 6 INFO/3 WARN/3 ERROR；8 行 4/2/2）均 root verified、深度 2、3 条依赖边、4 个模板实例加 1 个模型自撰 CLI 契约、30 个无关模板未进入任何请求；52／50 次请求。证据见 [live log pipeline](2026-10-03-live-log-pipeline.json)，可按其命令启用复验。
- 新增 `tests/integration/log-pipeline-evolution.spec.ts`（默认集成套件，脚本化模型）：缺陷模板 v1（目标要求 `byLevel`，判据仍核 `perLevel`）使 aggregate 叶被真实 command verifier 判败；诊断经持久消息送达负责父 Run 而非 root；supervisor 走完 task_definition 全链（propose→candidate→prepare→replay→gate→decide→apply，decide／apply 经真实人审缝），双侧对照 baseline 败、candidate 过、holdout 双过；发布 v2 后父 Run 原地重规划并消费新版本，旧失败 Run 绑定与 v1 内容保持冻结。三次连跑确定通过，约 3.5 s。
- 新输入复测：live case-2 的模板库处于修复后状态（v1 缺陷与 v2 修复并存，当前版本 v2），快照确认 aggregate 任务消费 version 2 且 root verified——修复定义在新输入上由真实模型复现通过。
- 共享夹具 `tests/support/log-pipeline.ts` 承载场景、期望值重算与模板库注册；live 侧新增受限 bash 工具（cwd 锁定 checkout、60 秒进程组强杀），因交付物是可执行脚本。断言全部按用例重算，无硬编码期望值。
- 验证：unit 96 文件 2261 通过；integration 91 文件 644 项、636 通过 7 跳过，`a4-question-cold-exchange` 并行全量下偶发失败、单跑 8 通过（第三轮已知的并行 flake 集，非本轮引入）。build（含 source-size，476 文件）与 verify-persistence 通过。未改动生产代码。
- 遗留：根最终提交轮在 480 秒等待窗内偶发被取消（本轮 live 共 6 次运行中 2 次，通过等待完成后未再提交），live spec 保留 watchdog 与进度快照；独立包 `tsc --noEmit` 的重复声明与旧测试类型问题仍未收尾；中断恢复未在本轮新增用例（已有 a6-process-restart 等脚本化覆盖）；真实模型自主 Supervisor 改进仍未验证（本轮 supervisor 决策为脚本）。

第五轮（困难业务实测：xv6 内核锁优化）：完整实跑通过，证据见 [live xv6 locks](2026-10-03-live-xv6-locks.json)。

- 环境（约束 ≤10G，实测 813M）：用户态 qemu-system-riscv64 8.2.2（apt 下载解包 + 缺失共享库补全，全程无 root）加 xpack riscv-none-elf-gcc 13.4.0，加 xv6-labs-2021 `lock` 分支（g.csail.mit.edu，`281b66c`）。工具链经 `/home/roxy/code/testbeds/env.sh` 注入 PATH，不污染系统。
- 独立验收：checker `checks/verify.sh` 调用实验自带评分器 `grade-lab-lock` 按阶段裁决（kalloc／bcache／regression／modules／all），评分器、测试源码与 Makefile 为受保护输入；`all` 要求满分 70/70 含 time.txt 一分。正负对照先行：pristine 树各阶段必败（基线 49/70：kalloctest test1 与 bcachetest test0 竞争失败），参考解 70/70。
- 完整实跑（`SINGULARITY_LIVE_XV6_LOCKS=1`，真实模型）：root → 协调模板 `xv6-lock-lab-optimization` → kalloc／bcache／regression 三叶（回归依赖两个修复，2 条依赖边），全部 verified；评分 49/70 → 70/70；87 次请求，76 分钟；空闲 nudge 3 次。spec 在运行时之外复跑 `checks/verify.sh all` 复核满分。
- 过程中两个工程发现转化为测试侧机制：网关瞬断的请求级退避重试（至多 8 次）；worker 纯文本结束 turn 致 Run 悬挂时，watchdog 经运行时自身 prompt 门径接力并留痕（nudges 写入证据）。nudge 只是测试侧兜底；运行时层是否应有"active Run 久无事件自动提醒"的生产机制，留作后续决策。预算教训：TCG 仿真下该任务 80 分钟不够（kalloc 已 verified、bcache 仍在迭代），本轮终态等待 3 小时；wait 超时也保底落盘证据。
- 默认套件新增 `tests/integration/xv6-locks-harness.spec.ts`（非 opt-in，仅测试床缺失时跳过）：脚本化驱动加真实评分器对 pristine 树判败的回归用例（约 10 s），并断言 verifyTimeoutMs 管线（本轮实跑配置 1 500 000 ms，默认 600 000 ms）。
- 验证：unit 96 文件 2261 通过；integration 93 文件 646 项、638 通过 8 跳过 0 失败（含两个新 spec）。build 与 verify-persistence 通过。生产代码零改动；`log-pipeline.ts` 的 `checkoutTools` 增加可选 bashTimeoutMs（默认 60 秒不变），供 xv6 侧用 1 500 秒。

第六轮（真实 Supervisor 自主改进全链验证）：主线上报的三处生产机制缺口由修复轮落在 Singularity `446d200`、外层 `d9c690e`——recipe 晋升对不受影响叶子 holdout 回归化、受影响样本双侧真实消费；Reviewer 获只读 `task_template_list` 并沿用委派 scope；裸 diagnosisId 只在写入时规范化；`task_verify` 复用会话工作目录；spawn 继承父 root；criterionRepair 维持"候选不得替换自身最终 oracle"契约，损坏父验收走 Task intake 新合同。修复者工作区已完成首轮 all-real 闭环（21 断言全 true、202 请求、774 s、零 nudge，证据 [live supervisor repair](2026-10-04-live-supervisor-repair.json) 与[审计](2026-10-04-supervisor-repair-audit.md)）；本轮在主工作区独立核验并两次复现。

- 独立核验：审计七条结论逐条对码成立（晋升守卫未放宽、无第二套模板索引、消费者无第二种诊断解析）；21 断言与 `/tmp` 运行期原始调用记录一致；基线 unit 2290 通过、integration 647 通过 9 跳过复现；flake 清单增补 `a6-evolution-chain`（并行负载）与 `a3-coordination-loop`（串行取消），单跑均全绿；build、source-size（484 文件）、verify-persistence、diff 检查通过。
- 证据增强（`tests/integration/live-supervisor-repair.spec.ts`，不动生产语义）：token 计量复用 dsh 自带 `deriveTurnTokenUsage`（未自写计量逻辑），四相位＋全程＋每会话的 input/output/cache-read/cache-write 落盘，网关未回报的桶如实落 null 不冒充零；gate 明细（样本×双侧 outcome、六问原文）与"发布内容==冻结候选"布尔落盘；`supervisorReadProductionTemplate` 强化为与库 `@1.json` 的 id/version/decomposition 深比较；两处硬编码 true 改为计算布尔；断言 21→23 项并强制全 true；失败路径补落 tokenUsage、gate 与 run2 树快照；证据文件名可由 `SINGULARITY_LIVE_SUPERVISOR_EVIDENCE` 覆盖。
- tsc 收尾：修复 `446d200` 新引入的唯一类型错误（`evolution/src/promotion/task-definition.ts:147` 可选链，语义零变化），evolution 包 `tsc --noEmit` 由 9 条回到与 c436d9d 完全一致的 8 条先存错误，lib 同轮重建。
- 独立复现（all-real，`SINGULARITY_LIVE_REVIEWER_MODE=all-real`）两次：第一次 failed——演化链完整（proposal applied、experiment fixed、gate 6/6），但 run2 根任务两次 `task_decompose` 携带契约覆盖字段被 runtime 正确拒绝后退回"根处就地展开"形态，协调子任务断言诚实判败（证据 [reproduction](2026-10-04-live-supervisor-repair-reproduction.json)）；第二次 passed——23 断言全 true，run2 首次 decompose 即建成绑定 `log-analytics-pipeline@2` 的协调子任务并消费 v2 配方，token 全程 input 993 299／output 109 354／cache-read 2 920 960、34 turns 零缺失，197 请求、806 s、零 nudge（证据 [reproduction2](2026-10-04-live-supervisor-repair-reproduction2.json)）。run2 形态稳定性三轮累计 2/3，首次失败为模型行为抖动而非系统缺陷。
- 新发现上报（生产侧，未修）：`task_decompose` 对 `assumptions`/`requiredCapabilities` 等契约覆盖字段的拒绝文案未引导"去掉覆盖字段重新声明子任务"，是 run2 形态抖动的主要诱因；是否改善该错误引导留待决策。
- 验证：unit 2290 通过；integration 全量 647 通过 9 跳过（其间一次 19 失败为并行重建 lib 的自扰竞态，复跑消失）。失败路径证据增强未经真实失败实战检验（第二次运行通过，未触发）。
- 边界：本轮 v2 仅调整顺序、零 dependsOn，非空依赖边的发布保留未在 live 实测（由 DAG 集成回归覆盖）；token 为会话累计口径，未汇总执行子树总成本；两轮通过不证明 Reviewer 与 run2 形态的长期稳定性。

第六轮备份：Singularity 与外层 harness 均使用 `backup/self-develop-20261004-round6`。
