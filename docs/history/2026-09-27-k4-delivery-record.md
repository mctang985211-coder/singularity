# K4 交付记录：复盘与执行预算分离（返工已交付，待验收）

- 合同：[execution-prompts/12d-k4-review-budget.md](../execution-prompts/12d-k4-review-budget.md)；公共合同：execution-prompts/README.md。
- 基线：Singularity `6a50e90`（K3 已验收，证据 [K3 审核](2026-09-27-k3-review.md)）、外层 `3d573bb18f`；开工时内层工作树干净（外层 thirdparty/deepseek-harness 未跟踪遗留，保留未动、未提交）。首版交付 `500f0d9`、外层指针 `520df36487`；[独立审核](2026-09-27-k4-review.md)判返工。返工基线：Singularity `f54d6ec`、外层 `47e63a4065`，工作树干净。
- 交付：Singularity 返工分项提交 `9cd0768`（K4-1 额度预留）、`8a947c3`（K4-2/K4-5 审批渠道绑定）、`edda0da`（K4-3 串行重检+恰一次）、`04bb578`（K4-1 过期读收口），加收口提交（lib 产物+guide/计划/README+本记录，见 git log 顶部）；外层仅子模块指针提交。日期 2026-09-27。无真实模型费用、无推送、无部署。
- 执行：实现主代理 + coder 子代理（首版分工见 2026-09-27 初版记录；返工分工见文末）。

## 新行为一句话

复盘与执行预算分离：`task_review_agent` 进 gate 协调清单，原根截止/终态/Run 数用尽不再阻止只读复盘（reviewer 只受自身每 store 额度与单次 watchdog 约束，取用为进程内原子预留）；新增唯一工具 `task_budget_extend({requestKey, maxRuns?, deadlineAt?})`，只给可信根协调会话、终态亦可调用，经 DSH 人审（展示 store/原总上限/累计用量/拟改后总上限与 approval binding）追加已配置维度的总上限；`extendRootBudget` 只接收调用身份 `callId`，从调用者会话日志核对渠道审计对后落库；Task store 持久 `TaskBudgetExtended` 事实（store+requestKey 幂等且并发恰一次、串行重检整份基线读）；`resolveRootBudget` 输出配置+有效双上限供准入/启动/replay/watchdog/收尾全路径消费；扩额不唤活终态、不恢复业务写、不自动启动工作、旧用量不清零。

## 验收编号 → 证据

| 编号 | 真实入口 | 测试与实际结果 |
|---|---|---|
| K4-1 | 终态根会话经真实 gate 调 `task_review_agent`（reviewer ledger JSONL 计数） | `tests/integration/k4-review-after-deadline.spec.ts` 3 例：根被树截止取消 + maxRuns=2 用尽 + latestReview 存在 → 真实复盘链执行（reviewer spawn、judgement 落 Diagnosis、graph 增量恰 `['agent/add','edge/add']`、task store 零新 Run/Task、同相位 graph_spawn 仍 late call）；reviewer 额度耗尽仍拒 spawn；worker 工具面无此工具。`k4-review-ledger-restart.spec.ts`：真 JSONL 重开后旧计数仍生效（不清零）。返工加：并发只放行一个（`review-agent.spec.ts` 25→26 例，含过期计数读收口）。通过 |
| K4-2 | `task_budget_extend` 工具 → `budgetExtensionDraft`（零写）→ DSH 人审 → `extendRootBudget`；replay 经 `replayTask` | `agent-singularity/tests/unit/budget-extend.spec.ts`（真 `ApprovalService` + 受控 answerer）：卡片含 store/原上限/用量/拟上限与 binding；批准落事件可从 store 读回且 `approvalRef` 为渠道签发 UUID；拒绝/取消零事件零写；同 key 同内容走 recorded 不再发问；异内容拒绝；worker 面无工具。`task-runtime/tests/unit/budget-extension.spec.ts` 16 例：`made-up`/空/随机 callId、异 store/异 requestKey/异维度/异工具/另一会话/三种非允许决定/无 reader 全部具名拒绝零写。`tests/integration/k4-budget-extend.spec.ts` 3 例（native 渠道）；`k4-budget-consumers.spec.ts` 例 1/2：批准前 replay 具名拒绝零写，批准后真实 replay `verified`、仍沿原 verifier、原 Run/Review/Task 逐字段不变。通过 |
| K4-3 | store 写队列串行提交（整份基线读重检 + 幂等恰一次）；run-stack 真实重开 | `task/tests/unit/budget-extensions.spec.ts` 16 例（并发同 key 一条事件、同 key 异内容一成功一具名拒绝、跨维双提交拒绝、漏读维度拒绝）；`task-runtime/tests/unit/budget-extension.spec.ts` 3 例（顺序跨维、并发跨维、同 key 并发恰一次）；`k4-budget-consumers.spec.ts` 例 3：同基线并发恰一落账一具名拒绝 `moved since this request was read`，事件只多一条、snapshot 其余全等。`k4-budget-reopen.spec.ts`：提交前后真实重开读数一致、同 key 重试在新进程 answer from record（零追加）；旧计数+新 Run 按批准总额耗尽，不从零计。通过 |
| K4-4 | 批次准入 `admitPrecheckedBatch`、子 Run 启动 `startChildRound`、replay、在飞 watchdog、收尾 `finishBatch` 均经 `resolveRootBudget` 有效值 | `k4-budget-consumers.spec.ts` 例 2：总额用尽整批拒 → 批准后同请求纳入并 `verified`。`task-runtime/tests/unit/orchestrate.spec.ts`：子等待期间扩额不被旧截止取消；worker 停在嵌套批次 waiting_children 存活；扩额不延长本 Run 自身窗口（per-Run `budget exhausted: wallTimeMs` 仍生效）。`k4-budget-reopen.spec.ts` 例 2：恢复入口读同一有效限额。扩额不唤活终态：snapshot 除 budgetExtensions 外逐字段深等；不自动启动：事件增量恰一条。全仓 grep 无硬读 `config.rootBudget` 原值残留。通过 |
| K4-5 | 模型工具/schema、服务方法、人审渠道、持久事实四段接线；查询零写 | 四段均有真实消费者；`budgetExtensionDraft` 零写（拒绝/查询前后 snapshot 全等有断言）；root prompt K4 段已注入并有断言（含"不得出现 task_recover"）。返工后审批来源由渠道审计对核验（见 K4-2）。公共检查见下，全绿。无新预算平台/第二账。通过 |

## 返工逐条（2026-09-27，先复现再修，同入口验证）

1. **K4-2/K4-5 审批来源**。复现：公开直调 `extendRootBudget` 传 `approvalRef:'made-up'` 被接受并落库（`promise resolved … "approvalRef": "made-up" … maxRuns 10→20`）；工具在无任何渠道记录时自造 `approval:${callId}` 即落库。修改：提交输入改 `callId`（`task-runtime/src/index.ts:2904` 起），新增 `budgetApproval()`（`:2970-3004`）从调用者会话日志核对 `approval/asked{toolName,callId,reason 含 binding}`+`decided=allowed-once`，binding=sha256(canonicalize({storeId,requestDigest}))（`:1635-1637`），落库保存渠道签发的 `approval:<uuid>`；工具只交 `callId`（`agent-singularity/src/tools/budget-extend.ts:217`）、卡片渲染 binding（`:100`）。修后：真服务正例通过；伪造/异 store/异内容/异工具/异会话/非允许决定/无 reader 全部具名拒绝零写（单测 13 例 + 独立复核 5 探针）。
2. **K4-3 整份基线串行重检**。复现：同一完整基线 A 升 maxRuns、B 延 deadlineAt 双双落账（`promise resolved … instead of rejecting`；并发版 `expected [… ] to have a length of 1 but got 2`）。修改：claim 增必填整份读数 `baseline`（`task/src/budget.ts:113,142`）；reducer 按维对全份读数与 `approvedBudgetCeilings` 串行比较（`task/src/service/state.ts:1286-1307`）；runtime 两趟全份判定（`task-runtime/src/index.ts:3130-3152`，`judgeBudgetDimension:3177`），删除旧 `judgeBudgetRaise`（未 named 维度直接放行）。修后：跨维/同维并发均一成功一具名拒绝，事件恰 +1，拒绝侧零 Run/Task；漏读任一有限维度被拒。
3. **K4-3 同 key 恰一次**。复现：两个并发同 key 同内容提交落两条 `TaskBudgetExtended`（状态一条；`expected [{…}, {…}] to have a length of 1 but got 2`）。修改：查重移入 store 串行区（`task/src/index.ts:737-758`），新增 `serialIn`/`appendIn`（`:778,:802`），append 只在串行区确认无重复后发生；reducer 幂等优先于漂移检查。修后：同 key 同内容并发返回同一条记录、事件恰一条；同 key 异内容一成功一具名拒绝；重开后事实一致。
4. **K4-1 reviewer 额度原子预留**。复现：两个并发 `task_review_agent`（真实 ledger，额度 1）都读 used=0、都 spawn（`expected "vi.fn()" to be called once, but got 2 times`；探针 `spawns=2 ledgerRows=2 diagnoses=2`）。修改：`agent-singularity/src/review-agent-ledger.ts` 进程内 claim（`reserveReviewAgentRun:165`、`effectiveReviewAgentRuns:133`、count 向上播种 `:91`、append 递增 `:186`），gate 在 count 后同步预留（`src/tools/review-agent.ts:209-227`），拒绝用既有具名预算耗尽消息；spawn/append 失败归还、超时保持已消耗、重启不清零。过期计数读交错一并收口（`04bb578`）。修后：单测 26 例、集成 4 例、独立复核 7 探针全过。
5. **独立 integration 超时**（`tests/integration/worker-contract.spec.ts:200`）。复现核实：审核日志 `/tmp/k4-integration.log` 该用例报 179042ms 触发 120s 超时（超时定时器迟到 59s、整文件约 52x 放慢、无断言失败与代码栈）；同树另有一次全量绿 `/tmp/k4-int.log`；定向重跑两次均 ~0.8s 通过。判定：资源饥饿下的偶发、非确定性缺陷，未改超时/断言；返工后全量 integration 两度全绿（该文件 5.7s）。

## 删除清单（返工段）

- `agent-singularity/src/tools/budget-extend.ts`：自造 `approval:${exec.callId}`（原 :201）。
- `task-runtime/src/index.ts`：`extendRootBudget` 的"approvalRef 非空即提交"校验（原 :2839-2844）；旧 `judgeBudgetRaise`（未 named 维度直接放行、只查 named 维度）。
- `task/src/index.ts`：队列外查重与早返回（原 :735-746）；`commitIn` 内联的无条件 append 路径。
- `task/src/service/state.ts`：旧 named-only 漂移检查（原 :1244-1257）。
- 首版删除清单（orchestrate 一次性读数/定时器、文档过期标记、冗余字段等）仍有效，见初版记录（同一文件历史版本）。

## 公共检查（返工后实测，全部 exit 0）

- `NODE_OPTIONS=--max-old-space-size=8192 pnpm build`（packages/singularity）：16s；lib 产物 5 文件重建并随收口提交（`agent-singularity/lib/index.js`、`task-runtime/lib/{index.d.ts,index.js}`、`task/lib/{index.d.ts,index.js}`）。
- `pnpm vitest run --project unit packages/singularity`：63 文件 / 1978 例全过，0 跳过。
- `pnpm vitest run --project integration packages/singularity`：63 文件 / 506 过 + 2 跳过（k2/k3 既有 `EXIT_WINDOW` 门控）；`worker-contract.spec.ts` 8/8、5.7s。
- `pnpm run verify-persistence`：OK，4 事件根匹配（payload 新字段 `baseline` 为 `same-version`，指纹不移动；记录见 [persistence-changes/2026-09-27-k4-budget-extension.md](../persistence-changes/2026-09-27-k4-budget-extension.md)）。
- `agent-singularity` `pnpm exec tsc --noEmit`：exit 0（P1 基线保持清零）。
- `git diff --check`（两仓）：干净。

## 复杂度与 400 行以上文件处置（返工段）

- `task-runtime/src/index.ts`（保留）：返工在既有 `budgetExtensionDraft`/`extendRootBudget`/判定函数内收口（callId 渠道核对、全份基线判定），该文件是 runtime 服务门面既有归属，不迁出不拆分。
- `task/src/index.ts`、`task/src/service/state.ts`（保留）：查重/串行/append 在原 store 队列原语内重排（`serialIn`/`appendIn`），无新模块。
- `agent-singularity/src/review-agent-ledger.ts`、`src/tools/review-agent.ts`（保留）：claim 在原额度所有者内，JSONL 格式未改。
- 首版处置仍有效：`task-runtime/src/orchestrate.ts`（保留，watchdog 改为每次重读有效限额）、`agent-singularity/src/index.ts`（保留，一行注册）、`task/src/budget.ts`（首版新增的唯一领域形状文件，返工仅扩字段与白名单）。
- 无同名转发层、无第二事实源；未新建额度策略分类、自动审批、定时重试、成本预测、新预算平台、第二预算账、自动扫描（A5）、`task_recover`（A6）。

## 接口交接（返工后）

- 支持范围：`task_budget_extend` 仅可信根协调会话（worker/跨 graph 具名拒绝）；store 由会话推导；终态可调用；至少一维；只升已配置维度。
- 正常路径：draft（零写）→ 人审（渠道写 asked/decided）→ commit 只交 `callId` → runtime 重算 binding 核对渠道记录 → store 串行幂等+整份基线重检 → 一条 `TaskBudgetExtended`（含整份基线读数、渠道 `ApprovalRequestId`）。
- 拒绝路径：无渠道记录/伪造 callId/异 store/异 requestKey/异内容/异工具/异会话/非允许决定/无 reader/空 callId/基线漂移（含跨维度）/同 key 异内容/未配置维度/非提升/无字段——各具名拒绝零预算事件零新 Run；reviewer 拒绝侧零 reviewer、零 ledger 行、零 Diagnosis。
- 取消/恢复/旧数据：人审拒绝/取消零写；重启从事件重建有效限额（不按 now 重算、不回退、不清零）；reviewer 旧计数重启不清零。返工改变 payload 形状（`baseline` 必填）：首版 `500f0d9` 形状的记录在新 reducer 下重放具名拒绝（fail-closed，单票合同允许一次切换；K4 未验收、无已发布 store）。
- 未支持扩展（合同明确排除）：A5 自动扫描与精确源协议、A6 `task_recover`/supervisor、增量/相对时长/token 新账/approved 参数。

## 已知边界（对照合同）

- 首次扩额某维的 `previous` 取自调用方读取、store 无法按配置复算（配置不在 store 内）；返工后整份读数随记录持久化，链式权威不变。合同未要求 store 复算配置基线。
- `TaskService.recordBudgetExtensionIn` 是内部原语而非授权边界：绕过 runtime 直接调用时，配置有界但尚无扩展动过的维度可不进基线；产品唯一调用方是 `extendRootBudget`，模型/工具面无入口，进程内插件级调用与既有 `commitIn` 同级。
- 审批信任锚是调用者会话日志的渠道审计对：能向该日志写 `task_budget_extend` 问询的进程内代码可伪造记录；产品中仅 `budget-extend.ts` 以此工具名问询（grep），模型面不可达。
- reviewer claim 为进程内状态：跨进程并发写由 session 持久化 flock 租约排除；重启不清零（持久行仍权威）。
- 已删除旧边界：并发同 key 重复事件（本票修复为恰一次）。
- 其余原边界仍有效：`task_review_agent` 不计入 admission drain 在途写；reviewer 超时证据为既有单测；`decomposeAndRun` 被拒留 ready 提案（T2/T3 既有协议）；`tests/support/scripted-loop.ts` 注册真实工具使全量集成行为面变化（已全绿）。

## 子代理分工

首版（2026-09-27 初版交付）：

1. SG1（task+task-runtime）：`TaskBudgetExtended` 事实/快照/reducer、有效限额解析、watchdog 读数修正、`budgetExtensionDraft`/`extendRootBudget` 与全拒绝面、持久化记录草稿、相关单测。
2. SG2（gate+复盘链）：`task_review_agent` 入协调清单、残留绑定审计、K4-1 两个集成文件（含反例先红）。
3. SG3（agent-singularity+agent-runtime）：`task_budget_extend` 工具/人审卡/注册/ROOT_CORE_TOOLS/gate 条目、工具单测与终态集成。
4. SG4（组合验收）：replay/批次/恢复消费同一有效限额、同基线两批准竞态、真实重开、per-Run 窗口、waiting 分支、root prompt 注入与 `agent-prompt-contracts.md` 标记。
5. SG5（集成）：build、全量 unit/integration、verify-persistence、diff --check、agent-singularity tsc；逐字段消费者/唯一事实源复核。

返工（2026-09-27）：

1. A1（coder，task-runtime+agent-singularity）：审批渠道绑定（callId+binding 核验）、工具接线、scripted-loop native 选项、相关单测/集成测试。
2. A3（coder，agent-singularity）：reviewer 额度原子预留；后续恢复该代理收口过期计数读交错（`04bb578`）。
3. A2（coder，task+task-runtime）：claim 整份基线、store 串行重检与恰一次、判定函数重写、并发反例测试。
4. V（coder，独立对抗复核）：18 个自写探针证伪四项修复（未发现反例）；全量私跑 unit 98 文件 2106 例。
5. I（coder，集成）：build + 全量 unit/integration + verify-persistence + tsc + diff --check，全部 exit 0。
6. E1/E2（explore）：审批接线地图、K4-1/K4-3 代码路径地图；I0（coder）：worker-contract 超时定向复现。
