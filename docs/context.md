# context.md —— 当前接手状态

本页在每轮结束时**替换当前状态**，只保留未关闭问题、已批准合同索引和证据边界。
历史解释从固定基线实测记录与 Git 查证；剩余施工顺序只在 [assembly-blueprint §9](assembly-blueprint.md#9-剩余构建顺序与检查点) 维护。

## 18. G1/G2 接手审核与用户裁定（2026-10-11，基线 `35b0c7c`）

### 18.1 用户裁定与长期约束

以 `/home/ROXY/code/docs` 的原始需求共同主干为准，旧 Singularity 只读复用；私有运行环境固定为 `/home/ROXY/singularity-next/`。全部节点是可独立继续的普通 DSH 主 agent。只提供编排基建，模型自主探索、分解、编程与验收；不使用导演脚本、预制候选、固定子树或工具顺序。

原生人类入口创建根 Task；节点仅可重试自己的失败 Run，保留同一契约、冻结输入和资产版本；新增任务统一分解准入。
统一 TaskTemplate、Skill、Tool 不可变 Revision 与单一发布指针。仅根验收后创建的改进任务树可评估并自动固化候选；模型没有直接发布入口。未发布冻结版本可用于探索；每个 Run 固定版本、绑定和真实使用记录，根契约受保护。Independent Review → 真实评估 → 发布审核通过后自动固化。

以最简单的直接实现施工；先用最小公开行为 spec 固定真实轨迹已确认的错误，再修复。debug 与产品验收以真实 RTL 运行轨迹为准，不依赖复杂 spec。遇到无法从代码与既有裁定解决的分叉，带详细背景及选项提问。不兼容、不兜底，修复时删除作废代码和注释。

### 18.2 当前状态与效果验收边界

- 原生界面入口已接纳根 Task/Run，Bubble 挂载在预设选择后同样生效；前端 ReactFlow map 和节点自身 DSH 会话读取同一 committed snapshot。
- 2026-10-13 接手基线为 `67c7ffe` 及现有未提交改动。真实重试关联、失败 flush 屏障和统一资产链已实现。清理时删除手工 approval 发布入口、独立 approval seam 及失效 release/cd/round 探针，发布只接受准确独立审核证据；发布历史变异检查迁至现有公开行为测试并确认捕获。清理后全量串行回归曾通过 61 个文件、706 项，保留的五个离线协议探针通过。19:15 起按实际恢复断点修改现有工具说明、共用读取范围和提案计费；本次未新增或运行 spec，以真实会话验证启动，类型检查、构建、摘要、gates 与 diff 检查通过。新构建已部署并重启私有 DSH（PID `1485313`，端口 `7331`）；离线检查不证明自主分解、独立验收或 RSI 效果完成。
- 实际 SHA256 运行使用 `singularity-autonomous-v9`，根 `task-9eb7334b7e8f58b0`、Run `run-b19e96b4d2c43016` 与原生会话 `session-b0cbc80c-72dc-48f7-867c-4fa09911da8c`。模型自行提交局部测得 62225.9296 µm² 的产物（基线 64858.4544 µm²），自动创建 `review-4e7ab1c2610dc03d800556c1` 独立审核节点；根任务已由该独立节点通过验收，面积复测为 62225.9296 µm²（改善 4.0589%）；初始发布审核 `review-c35d880485916981445bbdc3` 已通过，统一发布指针自动切换至 `method-960772a2c32183c83f0607b1`；编排自动创建 `improve-71e04a36c02d7533f4eed028`、Run `run-d13c4db552ef49b7` 并冻结真实探索轨迹。候选评估和改进赢家发布仍待实际验证。
- 只修改 `sha256_w_mem.v`；保持端口、复位、SHA224/SHA256 和逐周期时序，整核面积至少改善 1%。包含审核的原生 token 成本增幅不超过 25%，high 思考，总预算 3 亿 tokens。用户要求运行启动后停止监控，由用户报告实际断点；没有固定轮次、候选数或根/子节点数量。
- 自主任务链、独立审核、自动固化及后续使用发布版本仍需真实运行验证；无赢家、预算耗尽、未改善或证据不足如实报告。
- 私有 DSH 已重载，原改进 session 通过 retry 开启 `run-9a2930ea2b07825f`。`round-clean-1:bootstrap:evaluation` 于正式 seq199 补录基线 trial，准确引用 Task `task-268756582a71ebe4` 的 verified 重试 Run `run-dcdad2ee18eada48`，面积 64002.6336 µm²（改善 1.3196%），quality 0.9868047919439782，包含审核成本 32,661,485；未重新求解基线。候选 `method-fc46476332460066eaa0e1a8` 已进入 Task `task-2c78b4b37f2e318d` / Run `run-4e811a597dd79f43`（seq206 启动，seq209 evaluation/opened）。尚无候选结果、轮次决定或 RSI 赢家发布完成事实。
- 2026-10-13 19:21（北京时间）实测确认恢复：改进 session 在 seq1440 重发同一冻结 `round-clean-1` 请求；现有 `evolve → createNativeSolve → openChildSession` 恢复原候选 `run-4e811a597dd79f43`，候选 seq415 的 continuation 明确引用原 Task/Run，seq416 请求使用原 yingjun/deepseek-v4.1-flash/high 路由，seq418 调用 bash 检查原工作区，seq419 成功返回原候选文件清单与校验值。已确认候选实际执行后停止监控。控制日志仍为 212 项事实，唯一指针仍为 `method-960772a2c32183c83f0607b1`，未新增 Task/Run 或重复基线；候选尚无正式提交、独立判决、trial 或轮次决定。
- 启动检查点原生已知费用 170,506,427 tokens，预留 1,131,072，剩余 128,362,501，无新增未知 usage。本对基线成本 32,661,485，25% 上限 40,826,856.25；恢复前候选提案和求解成本下界已为 46,922,000（增幅 43.66%），尚未包含审核和新恢复开销，因此本对按冻结规则不能发布赢家；正式无赢家决定仍须真实结算。重启前局部 RTL 62233.4368 µm² 与四项测试通过不代替封存独立验收。
- 本次沿既有端口完成三处修改：公开 evolve 说明同 round/冻结请求可幂等继续，明确同步调用中断后没有在飞 worker；task_status 与 history 共用原读取范围，改进节点可只读所属 evaluation，trial 间保持隔离；proposalCostOf 从原批次事件起点计到恢复请求，纳入新增消息并保留原基线/计划事实。计费范围和读取范围已实现并装载，候选正式 costBasis 与权限行为仍需后续实际调用核验。当前候选的 yosys/iverilog/sky130hd gaps 是固定 Revision 的未覆盖声明，不另建注册库或改写 Run 绑定。新构建的资产 Tool 消费、故障 flush 与赢家发布仍待实际证据。
- 21:14 已按用户选择实现两路独立求解/验收链：基线冻结 evaluation 口径后启动候选，基线链结束后释放第二路；各链独立封存和记录 trial，全部结算后按固定 slot 提交候选和决定，发布审核仍在决定后。恢复可从本轮基线或先完成的候选 trial 读取原提案计费范围。类型检查、构建、新鲜度、gates、diff 与 111 项相关回归通过，未新增 spec。现有 PID `1485313` 的单候选仍实际执行，未为并行加载再次中断；新构建供下次宿主启动装载，真实两路重叠及吞吐尚未验证。

### 18.3 当前结构边界

唯一事实提交队列保留；文件、程序、模型、会话句柄在队列外运行，进程内资源不决定 Task/Run/预算。
同 Task 一个未结算 Run；Task v9 的 `working → submitting → submitted` 固定请求、程序/产物/输入摘要与 transcript 前缀。
预约端口复用 `Decision { envelope, fresh }`，只有新预约执行副作用；在飞同请求明确拒绝，结算后重送返回原结果。
父提交闸等待派发工作结束；失败和证据不足的分支保留为轨迹，父 criterion 只由父自己的独立验收接受。输入依赖只消费 verified 封存产物。
正式 receipt 固定在目标 Run 首次终态，并逐项核验公开完整前缀的序号、摘要与链。
程序与 verifier 共用有界进程端口，取消/关闭等待真正退出，并终止继承进程组中的后代。
审核和改进通用模板进入统一 Revision，具体对象是 Run 的冻结输入；递归子任务继承准确冻结输入。资产、验收和发布审核采用已发布版本或部署 seed，恢复保留审核 Run 原版本。改进输入包含经过封存摘要核验的真实原生会话轨迹。候选使用准入读取准确独立审核证据。每批原生提案成本包含改进节点及其候选编程分解树，按准确会话事件范围计算并均摊到候选；基线只计本批求解与验收，候选另计自己的资产审核；最终发布审核计入 25% 成本上限。验收恢复复用首次冻结的审核输入并核对结构化判决，不使用临时执行路径创建新审核；评估恢复复用已提交 trial 与提案成本范围，发布审核固定草案时的事实前缀。
能力绑定、prompt、Skill 加载、Tool 执行和消费来源统一读取 Run 固定的资产 Revision。绑定在启动时从该版本 Skill 和同名 Tool 解析并冻结，未覆盖能力保留为缺口；绑定 Skill 内容默认进入执行上下文，消费来源区分 context 送达与显式加载，送达不证明行为效果；Tool 成功执行才记录消费。新根合同仅保存人类目标，候选模板指导独立进入执行上下文，同时送达既有验收命令、可读参考目录与测量模块入口。完整版本必须包含审核与改进模板，加载、分解和发布不临时补建 Revision。唯一发布指针只影响新 Run，已有 Run 与重试继续使用各自固定版本。

TaskTemplate 的 applicability 与 decomposition.children 表达可复用领域职责及直接孩子关系，和 Skill/Tool 共用一个 Revision。agent 在实质候选探索或连续实验批次前建立职责，孩子承担剩余工作，父节点复用封存结果完成集成及独立验收，保留全部编程能力。agent 可通过 useTemplateDecomposition 选择该 Run 绑定的定义，也可声明当前分解；只展开选定的直接孩子，相同声明幂等，实例 key 冲突拒绝。系统 prompt 每次按 Run 固定的 purpose 选择求解、审核或改进职责，共用工具能力和合同协议；领域探索的分解触发条件不送达审核节点。审核优先在当前职责内形成有界检查与判决，避免自由合同准入递归，读取范围包含明确冻结的候选和 basis，不扩展到无关资产。改进输入优先提供由原生事实导出的职责、关系、判决、封存产物、消费和会话位置摘要，完整冻结轨迹按需读取。RSI 仍比较完整方法，costSummary 拆分执行、提案与资产审核，仅作投影，25% 总成本合同不变。
审核和求解等待返回同 Task 当前有效的结算 Run；witness、产物与评测来源跟随该 Run，恢复复用已验证结果。评测保留 evaluation/opened 的冻结计划，实际重试结果须匹配同 Task、冻结输入和执行上下文。
标准 `session/event` 的 `turn/end error/aborted/max-tokens` 关联准确责任 session 的 working Run；本 session 的 flush 等待失败事实持久化，外层在屏障后读取 committed 状态。卸载等待持久化，主动卸载先撤销监听。

### 18.4 W1/W2 检查点与证据边界

W1/W2 已完成端口回归及四类私有 DSH 真实浏览器出口：

| 出口 | 脱敏证据 |
|---|---|
| 完整求解、独立验证、实际三工具与磁盘摘要来源 | `/tmp/singularity-w1-live.json`、同名 png |
| 成功 propose 后在飞 SIGKILL，同 session/Task/Run/工作区恢复，仅一个 Run 最终 verified | `/tmp/singularity-w2-working-fixed.json`、同名 png |
| durable submitted 后 SIGKILL，同封存 submission/source 恢复，后续只读 status，不重新执行程序 | `/tmp/singularity-w2-submitted-final.json`、同名 png |
| 原生 Stop 的 turn/end aborted/user 形成准确 Run failed，另一 session 的 working Task 不变 | `/tmp/singularity-w2-aborted.json`、同名 png |

当前检查点通过 core build、assembly 独立 typecheck、完整测试、assembly build、静态门禁自检和 diff 检查。
定向变异已核验同 Task 活动 Run、请求身份摘要、receipt 终态 cutoff/连续序号及随重构迁移的现行目标。
W3 真实链验收替换旧 G2 产品探针；W4/W5 的 G2 主链与完整面板验收已通过，入口见 [实跑测试](e2e-testing.md)。
真实 provider `stream_read_error` 在接线修复前已观察；修复后标准错误端口有 Session/driver spec，但没有再次遭遇真实 provider 故障。
探针缺陷造成的失败保留在 `/tmp/singularity-w2-working.json` 与 `/tmp/singularity-w2-submitted.json`，不计成功产品证据。

### 18.5 不要重建的基础

保留单一信封/控制 store/提交队列、闭合成员和版本边界；已验证值的缓存可复用，不重复重放/声明。
ControlSessionStore 拥有独立 DSH 控制 session/write lease/flush 屏障；读 cut 没有写权限，屏障失败不能返回成功。
根 Web Agent 借用宿主句柄，child 独占句柄及 disposer 归创建 owner；恢复准确 session，不能再次 resume live writer。
每个节点挂载完整 DSH standard 预设与 Singularity 工具；child 创建与恢复继承准确父的实际 preset scope，父未挂载时拒绝创建。
RRSI 只移植决定/正则化约束，见 [ADR0001](adr/0001-rrsi-port-boundary.md)；已接受分歧见 [divergence-ledger](divergence-ledger.md)，不顺手改回上游算法。
开发和验收只用 [私有 DSH](standalone-dsh.md)，旧 harness 只读参考。W9 目前仅受控演示通过，真实领域 RSI 与改善效果待验收。

核心采用 Task v9：同一 Task 只保留一个未结算 Run，阶段为 `working → submitting → submitted`。
`run/submitting` 先绑定可信请求身份与内容摘要并关闭新写，`run/submitted` 再封存程序/产物/输入摘要及 session/transcript 来源；
独立判决绑定封存产物。底层直接 verifier 路径保留，进入判决后不能再开始提交。
定向反例入口：`mutate:core-w1-single-active-run`、`mutate:core-w1-reserved-request-digest`。
W2 receipt 来源入口：`mutate:core-w2-receipt-terminal-cutoff`、`mutate:core-w2-receipt-every-sequence`。

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
