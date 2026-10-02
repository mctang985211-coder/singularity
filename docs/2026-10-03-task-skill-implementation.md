# Task / Skill / MCP 自改进实现

日期：2026-10-03。按 [KISS 审计](2026-10-03-supervisor-task-dag-kiss-audit.md) 在独立 worktree 实施；[原评审](2026-10-03-verify-supervisor-core-gaps-review.md)与审计保留施工前事实。

## 已实现的闭环

Task 规定结果，Skill 提供方法，Tool/MCP 提供动作。父节点优先检索可见模板，绑定参数或生成标准契约；执行和验收仍走唯一 TaskRuntime。普通 child 诊断交真实父 Run；共享模板、Skill 或能力变更才交 supervisor。Supervisor 物化候选、对照实验、请求已有工具的人审，批准后应用；根按原契约开新 Run，child 由持久消息唤醒负责父 Run 重新规划。恢复记录关联实际 proposalIds。

唯一协调宿主为 `singularity-coordinator`，reviewer/supervisor 分别装配稳定政策，删除相冲突的 reviewer preset。审批模式为 ask，proposal ledger 承接等待、决定、应用和重启；不另建审批或调度状态机。默认只复盘失败，成功优化按需启用。自然结算与重复交接交错时重读已有账本终态，避免把已关闭会话误判为失联并重复启动。

## Task 模板与 DAG

- 模板是 `<id>@<version>.json`，含适用条件、参数 schema 和完整契约。库默认在 `$DSH_HOME/singularity/task-templates`，未设置 DSH_HOME 时在 `~/.dsh/singularity/task-templates`。`task_template_list` 是唯一模型检索入口。
- 实例固定模板引用、参数与最终 contractDigest；无适用模板可提交标准契约，两者共用 normalize/admission。旧 Task 契约、旧 Run 的 Skill/MCP/模型绑定保持固定。
- 原子叶以明确输入产出一个可独立验收的结果；一次执行可调用多个工具。节点只写自己的直接子任务，按真实产物声明兄弟依赖，不把工具调用转换成 Task。现有拓扑保持父子分解树与同批兄弟依赖 DAG，不新增通用图编译器。
- `task_definition` 候选为 `{template,criterionRepair?}`。两侧冻结完整同格式模板库及摘要，session overlay 继承到新后代；父/根原验收保持不变，新 child 必须实际消费候选版本。
- 首次发布采用 `baseVersion: 'absent'`、version 1；更新追加 N+1。更新回滚追加原内容为 N+2，首次发布回滚移除新 v1；历史实例及实验记录保留。发布与回滚复用已有 file commit 和重启对账。
- 修改 child 判据须提供已有固定正反例，同原独立 oracle 的终态记录交叉验证，再重放 oracle 与候选判据；恒真候选不能洗白负例。该检查只证明冻结样本，不声称证明所有未来输入。已接受根契约的原地改题入口未开放。

## Skill、外部工具与 MCP

- 已有 Skill 同名更新沿原候选、双侧实验、人审和提交路径执行。
- capability 候选为 `{rows,skill?,mcpServers?}`，恰好一个整行变更，可只授予已有 native tools 或 MCP，不强迫生成 Skill。新 execution Skill 仍使用 SKILL.md 与既有侧车格式。
- 删除核心 BB server 表。部署 `mcpServers` 是唯一注册来源，同一 parser 校验部署和候选；新增定义包含 serverName、description、command、args/env/cwd 与可选调用时限。capability 引用 registry id，实际工具名使用 `mcp__<serverName>__<tool>`。
- 候选配置复用 session binding 传给实际新后代：准入、Skill discovery、MCP 解析与调用均使用该侧 overlay，基线和生产配置独立。中断实验沿已有 ledger 结算，再由新的冻结 replay 重入；不声称中断 side 透明续跑。候选 registry 在隔离实验中挂载，真实启动 stdio server 并调用工具。摘要、registry revision 与 Run binding 冻结并在晋升前重读；审批呈现完整 mutation、启动定义、配置摘要和实际写入目标。
- 行与新定义一次写入部署配置，再更新 runtime registry；复用已有 commit intent、原子文件替换与 reconcile。回滚恢复行并移除新定义与可选新 Skill，已有 Run 保持实际绑定。开放 intent 阻断相关新准入。
- Native tools 必须已有授权；发布新 verifier、permission、preset/runtime policy 与任意资源包仍没有执行器，不伪装为已有自动能力。

## 验收与成功优化

不可结算的 mandatory review/formal 占位判据在准入拒绝，支持相应 mode 的已注册 verifier 可用，composite 保留。根缺能力时保留契约并记录义务；执行叶仍须具备声明能力。义务满足只认匹配 criterion id 的最新 verified Run 与 passing evidence。

成功源可冻结 `objective: 'tool-call-reduction'`：两侧原验收均通过，每个观察样本完整实际 Run 子树的工具调用严格减少，独立 holdout 不增长。任一后代 Review 或计量缺失为不可比较；晋升重读实际子树。失败修复保持原比较规则，不新增标量评分平台。

## 验证与备份

第一轮提交：Singularity `2d791cf`，外层 harness `8b68f0f`。build 成功；unit 2190 通过，integration 585 通过、5 跳过。

第二轮 build 成功；unit 93 个文件、2237 通过；串行全量 integration 84 个文件、609 通过、5 跳过。持久化 schema 检查通过，4 个 event roots 与指纹一致。所有 462 个手写源文件（含测试）均不超过 2000 行，source-size 检查接入 build；跟踪的生成 lib 统一重建提交。删除六个超长旧测试并迁移其原有用例，公共 fixture 只留一份。

真实模型 `deepseek/deepseek-v4.1-flash` 使用生产 prompt 与工具 schema，生成两个原子叶、一个真实产物依赖：`[3,7,-2] → [9,49,4] → {count:3,sum:62}`。TaskRuntime/AgentRuntime 执行实际 read/write 与受保护 command verifier，根和两叶均 verified。计划与执行记录见 [live DAG smoke](2026-10-03-live-dag-smoke.json)。

集成中的演化模型和审批回应为可控脚本，MCP 是实际 stdio 子进程；真实模型 smoke 的请求循环由 runner 控制。上述证据证明机制可执行和一个小 DAG 可完成，长期真实模型自主自改进的质量仍需业务任务实测。
