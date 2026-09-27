# K4 交付记录：复盘与执行预算分离（待验收）

- 合同：[execution-prompts/12d-k4-review-budget.md](../execution-prompts/12d-k4-review-budget.md)；公共合同：execution-prompts/README.md。
- 基线：Singularity `6a50e90`（K3 已验收，证据 [K3 审核](2026-09-27-k3-review.md)）、外层 `3d573bb18f`；开工时内层工作树干净（外层 thirdparty/deepseek-harness 未跟踪遗留，保留未动、未提交）。
- 交付：Singularity 本次提交（代码+测试+lib 产物+guide/计划/A5 prompt/持久化记录/本记录，见 git log）；外层仅子模块指针提交。日期 2026-09-27。无真实模型费用、无推送、无部署。
- 执行：实现主代理 + 五个 coder 子代理串行（分工见文末）；集成与组合验收均由子代理执行，主代理汇总、文档同步与收口。

## 新行为一句话

复盘与执行预算分离：`task_review_agent` 进 gate 协调清单，原根截止/终态/Run 数用尽不再阻止只读复盘（reviewer 只受自身每 store 额度与单次 watchdog 约束）；新增唯一工具 `task_budget_extend({requestKey, maxRuns?, deadlineAt?})`，只给可信根协调会话、终态亦可调用，经 DSH 人审（展示 store/原总上限/累计用量/拟改后总上限）追加已配置维度的总上限；Task store 持久 `TaskBudgetExtended` 事实（store+requestKey 幂等、异内容拒绝、提交时串行重检基线），`resolveRootBudget` 输出配置+有效双上限供准入/启动/replay/watchdog/收尾全路径消费；扩额不唤活终态、不恢复业务写、不自动启动工作、旧用量不清零。

## 验收编号 → 证据

| 编号 | 真实入口 | 测试与实际结果 |
|---|---|---|
| K4-1 | 终态根会话经真实 gate 调 `task_review_agent`（reviewer ledger JSONL 计数） | `tests/integration/k4-review-after-deadline.spec.ts` 3 例：根被树截止取消 + maxRuns=2 用尽 + latestReview 存在 → 真实复盘链执行（reviewer spawn、judgement 落 Diagnosis、graph 增量恰 `['agent/add','edge/add']`、task store 零新 Run/Task、同相位 graph_spawn 仍 late call）；reviewer 额度耗尽仍拒 spawn；worker 工具面无此工具。`k4-review-ledger-restart.spec.ts`：真 JSONL 重开后旧计数仍生效（不清零）。reviewer 超时停止由既有单测 `agent-singularity/tests/unit/review-agent.spec.ts:312` 锁定。反例先红：gate 未改前同场景 deny "late call"（记录于派发交接）。通过 |
| K4-2 | `task_budget_extend` 工具 → `budgetExtensionDraft`（零写）→ DSH 人审 → `extendRootBudget`；replay 经 `replayTask` | `agent-singularity/tests/unit/budget-extend.spec.ts` 9 例：人审卡含 store/原上限/用量/拟上限；批准落事件可从 store 读回；拒绝/取消零事件零写；同 key 同内容走 recorded 不再发问（人审计数断言）；异内容拒绝；自填 approved/approvalRef 在 schema 层具名拒绝；worker 面无工具。`tests/integration/k4-budget-extend.spec.ts` 3 例：终态根批准落一条 `TaskBudgetExtended`（含批准引用与 previous/next）、重试走记录；拒绝/取消零写；同相位业务写仍 late call。`tests/integration/k4-budget-consumers.spec.ts` 例 1/2：批准前 replay 具名拒绝零写（deadline 已过 / maxRuns 用尽），批准后真实 replay `verified`、仍沿原 verifier（verifierId/criterion 与冠军一致）、原 Run/Review/Task 逐字段不变。通过 |
| K4-3 | store 写队列串行提交（reducer 重检基线）；run-stack 真实重开 | `k4-budget-consumers.spec.ts` 例 3：同一基线两个批准并发 `extendRootBudget`，恰好一个落账、另一个具名拒绝（"moved since this request was read"），事件只多一条、snapshot 其余全等。`k4-budget-reopen.spec.ts` 例 1：提交前/后两次真实重开——读数随 store 与进程无关、批准 deadline 为绝对瞬时不按重启重算、用量与 acceptedAt 不变、同 key 重试在新进程 answer from record（零追加）。例 2 与 consumers 例 2：旧计数+新 Run 按批准总额耗尽（maxRuns 2→4，用满 4 后 replay/新批再拒），不从零计。单测：`task/tests/unit/budget-extensions.spec.ts`（幂等/异内容/基线漂移/重放重建）、`task-runtime/tests/unit/budget-extension.spec.ts`（服务拒绝面全集）。通过 |
| K4-4 | 批次准入 `admitPrecheckedBatch`、子 Run 启动 `startChildRound`、replay、在飞 watchdog（`awaitWorker`/`awaitWaitingTerminal`）、收尾 `finishBatch` 均经 `resolveRootBudget` 有效值 | `k4-budget-consumers.spec.ts` 例 2：总额用尽整批拒 → 批准后同请求纳入并 `verified`。`task-runtime/tests/unit/orchestrate.spec.ts` 新增 3 例：子等待期间扩额不被旧截止取消（先红固定：还原旧一次性 timer 即 `expected 'failed' to be 'running'`）；worker 停在自身嵌套批次 waiting_children 同样存活；扩额不延长本 Run 自身窗口（per-Run `budget exhausted: wallTimeMs` 仍生效、startedAt 不变）。`k4-budget-reopen.spec.ts` 例 2：恢复入口（重开 adoptRoot → assertRecoveryReady → replay）读同一有效限额。扩额不唤活终态：提交后 snapshot 除 budgetExtensions 外逐字段深等（k4-budget-extend.spec.ts 增补断言）；不自动启动：事件增量恰一条。全仓 grep 无硬读 `config.rootBudget` 原值的残留判断（SG5 复核）。通过 |
| K4-5 | 模型工具/schema、服务方法、人审渠道、持久事实四段接线；查询零写 | 四段均有真实消费者（SG5 逐字段复核：载荷每字段有消费方，snapshot.budgetExtensions 唯一事实源，无第二份账）；`budgetExtensionDraft` 零写（拒绝/查询前后 snapshot 全等有断言）。root prompt K4 段已注入（`agent-runtime/src/prompts/root.prompts.ts`）并有断言锁定（含"不得出现 task_recover"守 A6 未实施）。公共检查见下，全绿。无新预算平台/第二账（实验 maxTokens 账与根限额仍各自独立）。通过 |

## 删除清单

- `orchestrate.ts`：`observeWorkerRun` 的一次性 rootDeadline 缓存读、`awaitWorker`/`awaitWaitingTerminal` 的一次性定时器到点即取消、`finishBatch` 的旧读数收尾判定——统一改为每次判定/唤醒重读有效限额（`remainingRun`/`rootDeadlineOf`）；这是"扩额后仍硬读原配置截止"的重复判断本体。
- 文档：guide 文首"K4 未实施"、计划 F.3"gate 协调清单尚无 task_review_agent，A5 须同批补"、`exploration-evolution-architecture.md` §7.4"K4 尚未实施"、`agent-prompt-contracts.md` 的 `[K4 部署后]` 标记（段落已注入 root prompt）；A3 设计文档放行表补 K4 更正注。
- 接口整洁：`RootBudgetExtensionDraft.requestKey` 冗余字段（全仓无读取方）删除；`describeBudgetExtension` 单点化（task/src/budget.ts，state/task index/runtime 共用一份）。
- 未新建：额度策略分类、自动审批、定时重试、成本预测、新预算平台、第二预算账、自动扫描（A5）、task_recover（A6）。

## 公共检查（实际结果，SG5 集成子代理执行，整洁项收口后复跑）

- `pnpm build`（packages/singularity）：exit 0；lib 产物与 src 一致（仅源码变过的 4 包 lib 有 diff）。
- `pnpm vitest run --project unit packages/singularity`：63 文件 / 1961 例全过，0 跳过。
- `pnpm vitest run --project integration packages/singularity`：63 文件 / 506 过 + 2 跳过（k2/k3 既有 EXIT_WINDOW env 门控子例，非本票回归）。
- `pnpm run verify-persistence`：OK，4 事件根匹配（新事件 kind 为 `same-version`，指纹不移动；记录见 [persistence-changes/2026-09-27-k4-budget-extension.md](../persistence-changes/2026-09-27-k4-budget-extension.md)）。
- `git diff --check`（两仓）：干净。
- `agent-singularity` `pnpm exec tsc --noEmit`：exit 0（P1 基线保持清零）。

## 复杂度与 400 行以上文件处置

- `task-runtime/src/index.ts`（保留）：新增 `budgetExtensionDraft`/`extendRootBudget`/信任检查与判定，消费点改读有效限额——该文件是 runtime 服务门面既有归属地，不迁出不拆分（迁出属更大议题，非本票范围）；未新增 helper 层，校验逻辑落在 `judgeBudgetExtension` 单组函数。
- `task-runtime/src/orchestrate.ts`（保留）：watchdog 读数方式修正，无新模块。
- `task/src/index.ts`、`task/src/service/state.ts`（保留）：新事实的入口/reducer 按 proposals 既有范式落位；领域形状单点在新增 `task/src/budget.ts`（唯一新文件，避免再向 types/state 堆形状逻辑）。
- `agent-singularity/src/index.ts`（保留）：一行注册；工具本体在新增 `src/tools/budget-extend.ts`。
- 无同名转发层、无第二事实源、无共享可变 RuntimeInternals（SG5 复核实际调用链）。

## 接口交接（完成闸）

- 支持范围：`task_budget_extend` 仅可信根协调会话（graph.rootSessionId===caller，worker/跨 graph 具名拒绝，reducer 再兜底）；store 由会话经 `rootTaskStoreId` 推导；终态可调用；至少一维；maxRuns=批准后总 Run 数正整数、deadlineAt=绝对 UTC；只升已配置维度（未配置=无限，传该维即拒）。
- 正常路径：draft（零写）→ 人审（allowed-once 唯一算批准）→ commit（串行重检基线）→ 一条 `TaskBudgetExtended`；同 key 同内容回已有记录不再审批。
- 拒绝路径：无字段/非正整数/非绝对 UTC/非提升/未配置维度/基线漂移/空 approvalRef/worker/跨 graph/异内容同 key——各具名拒绝且零预算事件、零新 Run、人审不被问（校验失败在 draft 阶段即拒）。
- 取消/恢复/旧数据：人审拒绝/取消零写；重启从事件重建有效限额（不按 now 重算、不回退、不清零用量）；旧账无该事件即纯配置解析，行为同前；per-Run 限时不重置、终态 Run 不重开、在飞者仅按新读数更新根约束。
- 未支持扩展（合同明确排除）：自动扫描与精确源协议/requestKey 去重（A5）、task_recover 与 supervisor（A6，直接复用本能力，不另造恢复专属预算）、增量/相对时长/token 新账/approved 参数（具名拒绝）。

## 已知边界（均为合同排除或具名拒绝，非缺口）

- 某维首次扩额的 `previous` 是调用者断言的配置读数——配置不在 store 内，reducer 无法复算首值，自该点起链式权威（持久化记录已写明）。
- 并发下同 key 重复请求可能多写一条事件，重放状态完全相同（reducer 幂等裁决；顺序路径零追加）。
- `task_review_agent` 不计入 admission drain 在途写（其效果仅一条 Diagnosis，与早已放行的 `task_diagnose` 同形）；reviewer 超时证据为既有单测；scripted-loop fixture 未挂 SingularityAgent 的 reviewer binding source（review-only 契约段断言仍由 context-assembly.spec.ts 覆盖）。
- `decomposeAndRun` 因预算被拒会留 ready 提案（T2/T3 既有协议），批次入口"零写"断言到 run/task/evidence/review 层；批准后同请求续上原提案（k4-budget-consumers 例 2 已证）。
- `tests/support/scripted-loop.ts` 现无条件注册真实 `task_review_pack`/`task_review_agent`/`task_budget_extend`（原为 stand-in），全量集成随之行为面变化并已全绿。

## 子代理分工

1. SG1（task+task-runtime）：`TaskBudgetExtended` 事实/快照/reducer、有效限额解析、watchdog 读数修正、`budgetExtensionDraft`/`extendRootBudget` 与全拒绝面、持久化记录草稿、相关单测。
2. SG2（gate+复盘链）：`task_review_agent` 入协调清单、残留绑定审计、K4-1 两个集成文件（含反例先红）。
3. SG3（agent-singularity+agent-runtime）：`task_budget_extend` 工具/人审卡/注册/ROOT_CORE_TOOLS/gate 条目、工具单测 9 例与终态集成 3 例。
4. SG4（组合验收）：replay/批次/恢复消费同一有效限额、同基线两批准竞态、真实重开、per-Run 窗口、waiting 分支、root prompt 注入与 `agent-prompt-contracts.md` 标记。
5. SG5（集成）：`pnpm build`、全量 unit/integration、verify-persistence、`git diff --check`、agent-singularity tsc；逐字段消费者/唯一事实源/gate 语义复核；整洁项收口（冗余字段删除等）后复跑全量。
