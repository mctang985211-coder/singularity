# dsh-singularity-agent

[English](README.md) | 中文

功能：Singularity 图内 worker 派发、就绪标记与可取消的人工交互工具。

包名：`@dangosys/dsh-singularity-agent`

依赖：graphs, tools

依赖的config.yaml配置：无

### 可调用Tools

全部 21 个工具注册在全局层；root agent 的 allow-list（`@dangosys/dsh-singularity-agent-runtime` 的 ROOT_TOOLS）恰好就是这份清单，两者不会漂移。

1. graph_spawn：通过 Singularity runtime 创建 worker 节点并等待其回复。
2. graph_mark_ready：将调用 agent 所属的图标记为就绪。
3. hitl_ask：等待人工文本回答，随工具执行取消。
4. hitl_approve：等待明确的 approve/reject 决定，随工具执行取消。
5. task_read：读取调用者的任务契约（root 另可见子任务状态）。
6. capability_list：打印生效的能力表——合法能力名及每个工具标签展开后的真实工具名。
7. task_decompose：准入并启动一批子任务（reason + 子任务清单：objective / acceptance criteria / dependsOn / decomposable）。
8. task_status：打印任务树，带 run / 证据 / review / diagnosis 摘要。
9. task_verify：worker 自检——重跑 verifier、记录证据，绝不改变任务状态。
10. task_review_pack：只读证据包（本任务 reviews 全文、父/子摘要、依赖边、升级判定行）。
11. task_review_agent：当 pack 的升级判据（E1–E4）命中且每 store 预算有余时，spawn 一个只读评审 agent，把六维判读落为一条 Diagnosis。
12. task_diagnose：持久化一条 Diagnosis（proposals 只是建议，绝不自动执行）。
13. evolution_propose：登记一条 evolution 提案（可从 Diagnosis 转录）。
14. evolution_candidate：记录 candidate 的完整版本集合与可选的结构化 mutation。
15. evolution_prepare：把机械型 mutation 物化到提案沙箱，并落 champion 快照。
16. evolution_replay：对本图已终态的历史任务重放候选，写 candidate vs champion 对比报告。
17. evolution_gate：记录 Gate 六问（regression 证据引用必须真实存在）。
18. evolution_decide：记录 PROMOTE / REJECT / KEEP_FOR_FURTHER_RESEARCH——先过一次原生人审才落账。
19. evolution_apply：把已 PROMOTE 的提案（skill / agent_preset / capability，限 L1–L3、已物化）写进生产；第二次人审，reason 列出全部生产写入路径。
20. evolution_rollback：从 champion 快照恢复（无 champion 则删除 apply 产物）；同样先过人审。
21. evolution_list：只读台账，带过滤与 history。

通过 New graph 创建图。仓库安装由 agent 用 bash（clone + 按仓库文档 build）完成，再调用 `env_register_component`。

### 注册的 Web API：

无

### 维护的 Service 状态

1. ctx.singularityAgent：注册上述 tools；root agent 恰好只保留上面这 21 个（ROOT_TOOLS allow-list）
2. ctx.hitl：原生交互 seam 的画布 answerer——hitl_ask 走 ctx.userQuestions、hitl_approve 走 ctx.approval（审计事件与 fail-closed 由原生层负责）；ctx.hitl 只把这两条 waterfall 桥接成待处理卡片，由画布经 GET/POST /singularity/hitl 回答，回答、取消或服务卸载后移除
3. ctx.evolution：只追加的 evolution 台账（`$DSH_HOME/evolution/proposals.jsonl`）外加每提案沙箱（`sandbox/<proposalId>/`）——evolution_prepare 把 candidate 携带的结构化 mutation 与 champion 快照物化到这里，evolution_replay 对图中已终态的历史任务重放候选后把 candidate vs champion 对比报告（`replay-report.json`）也写到这里；台账与沙箱之外唯一的写入是 evolution_apply / evolution_rollback 把 PROMOTE 决定的 skill / agent_preset / capability 落到生产（rollback 从 champion 快照恢复，champion 不存在则删除 apply 产物），每次各过一次原生人审，L4 与记账型永远拒绝；由 agent 自身 fiber 提供而非子插件——evolution_* 工具是通过注册时那个 context 读它的
