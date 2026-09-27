# K4 精简重做交付记录：复盘与执行预算分离（待验收）

- 合同：[execution-prompts/12d-k4-review-budget.md](../execution-prompts/12d-k4-review-budget.md)「本次收敛」与验收表；公共合同 execution-prompts/README.md。日期 2026-09-27。
- 基线：Singularity `780cbdb`（精简合同冻结后的收口提交；上一轮交付 `500f0d9`/返工 `f670e83` 已被[独立审核](2026-09-27-k4-review.md)判返工，`25af727` 为未验收中止现场）、外层 `658d28f`（仅子模块指针）。开工时内层工作树干净；外层 `thirdparty/deepseek-harness` 未跟踪遗留保留未动、未提交。
- 交付：Singularity 代码提交 `469ce64`，加收口提交（guide/计划/README/A5 prompt/持久化记录 + 本记录，见 `git log` 顶部）；外层仅该子模块指针提交。无真实模型费用、无推送、无部署。
- 执行：实现主代理 + 7 个 coder 子代理（分工见文末）；主代理负责接口冻结、删除与集成判断、文档同步、收口提交。

## 新行为一句话

扩额只有一次调用：`task_budget_extend({requestKey, maxRuns?, deadlineAt?})` 把请求与 DSH 宿主执行上下文交给 `TaskRuntime.extendRootBudget(sessionId, host, request)`，runtime 校验根会话、派生 store、按 store+requestKey 幂等、自己冻结整份生效读数与用量，再调用装配期装入的私有审批回调（`registerRootBudgetApproval`，agent-singularity 构造期用 `defineRootBudgetApproval` 装一次；回调走现有 DSH `approval.request()`，仅 `allowed-once` 放行）；获批准后 claim 携冻结读数进入 `recordBudgetExtensionIn`，在 store 串行区重检每个维度并判幂等。reviewer 只在 ledger 每 store 串行区 `admitReviewAgent` 内重读持久 `started`、判额度/触发、spawn 并写行，等待输出在区外；已落行即耗一次，重启从文件重读。

## 验收编号 → 真实入口 / 测试 / 结果

| 编号 | 真实入口 | 测试与实际结果 |
|---|---|---|
| K4-1 | 终态根会话经真实 gate 调 `task_review_agent`；ledger JSONL 每 store 串行受理 | `tests/integration/k4-review-after-deadline.spec.ts` 3 例（真实复盘链执行、零新 Run/Task、额度耗尽拒绝、worker 面无此工具）；`k4-review-ledger-restart.spec.ts` 1 例（真 JSONL 重开后旧计数生效）。`agent-singularity/tests/unit/review-agent.spec.ts` 33 例，其中「two concurrent admissions for one store admit exactly one run」「with the cap at two and one row on the file, exactly one more admission lands」「a row readable before its append resolves spends one run, not two」（受控 append 持行、区内计数）「an append that fails writes no row, spends nothing…」「a fresh import derives the count from the file alone」「two concurrent executions with one allowance admit exactly one reviewer」「a spawn that fails before its row was written spends nothing」「a spawn that fails after its row was written spends exactly one run」。通过 |
| K4-2 | `task_budget_extend` → `extendRootBudget`（单次）→ 装配期装入的审批回调 → 真实 DSH 渠道 | `tests/integration/k4-budget-extend.spec.ts` 3 例（native `ApprovalService`：终态根会话真实调用、卡片含 store/两上限/用量/拟改总额且无 binding 行、渠道审计对与 `approval:<调用 callId>`、拒绝/取消零写、重试不再发问、同相位业务写仍拒、worker 面无工具）；`agent-singularity/tests/unit/budget-extend.spec.ts` 13 例（含「declares no argument that could approve anything」「hands the runtime the request and the host execution, and never asks the approval channel itself」「never reads a throwing channel as an approval」「refuses a new request by name when this deployment installed no approval」）；`task-runtime/tests/unit/budget-extension.spec.ts` 17 例含「a session log full of allowed asks for this key and call authorizes nothing」（返工前的 requestKey 文本注入路径）与「refuses a request that carries a field of its own / inherited from the request prototype, asking nobody and writing nothing」；worker、跨 graph、不可解析 graph 均在打开 store 前具名拒绝。通过 |
| K4-3 | store 写队列串行提交（幂等 + 整份冻结读数重检） | `task-runtime/tests/unit/budget-extension.spec.ts`「two requests frozen off one reading cannot both stand…」「two callers racing the identical request land one event and answer both from the record」「a ceiling moved between the freeze and the commit is refused, not re-based」；`task/tests/unit/budget-extensions.spec.ts` 16 例未改仍绿；`tests/integration/k4-budget-consumers.spec.ts` 例 3（两批准同一读数、提问都持有 → 一问冻结读数相同、恰一落账一具名拒绝、事件仅 +1）；`k4-budget-reopen.spec.ts` 2 例（两度重开读数一致、重试 answer-from-record 零追加零新审批、按总额耗尽不从零计）。通过 |
| K4-4 | 批次准入 / 子 Run 启动 / replay / 在飞 watchdog / 收尾都经 `resolveRootBudget` | `k4-budget-consumers.spec.ts` 例 1/2（批准前 replay 具名拒绝零写、批准后沿原 verifier 启动且原 Run/Review/Task 不变、批次与 replay 读同一总额、已持 4 后拒绝下一次）；`task-runtime/tests/unit/orchestrate.spec.ts` 3 例（子等待期扩额不被旧截止取消、嵌套批次 wait 存活、扩额不延长 per-Run 窗口）。独立复核另核对 `rootDeadlineOf`/`remainingRunMsFromStore` 每次循环重读（`orchestrate.ts:1642-1697`）。通过 |
| K4-5 | 模型工具/schema、服务入口、批准渠道、持久事实四段接线；查询零写 | 四段均有真实消费者（工具与 runtime 入口、装配期 `ctx.effect` 注册、DSH 原生审计对、`TaskBudgetExtended` 事实）；拒绝/重复请求前后事件日志逐字节相同（单测断言）；`docs/` 现状描述已同步（guide §5.21、唯一计划 12d 行、A5 prompt 接口段、持久化记录、agent-prompt-contracts、architecture）。无新预算平台、无第二份额度账、无 receipt/token 服务。通过 |

## 三个关键反例的红/绿证据

1. **旧批准换基线复用 / requestKey 文本注入授权** — 返工前 RED（`task-runtime/tests/unit/zz-red-k4-injection.spec.ts`，临时文件已删，字节副本在 `/tmp/k4-red-scratch/`，日志 `/tmp/k4-red-a.log`）：人只批准 `k-a` 的 10→20，调用者把另一请求的 binding 文本嵌进 `requestKey` 后提交 `k-b|9999` 被**接受**，store 读回 `maxRuns 10 → 9999`；真实工具 + 真实渠道路径同样落 `k-b 21 → 9999`（A2b）。对照例 A1（同名不同请求、无注入）被拒、A3（自身请求）通过。**返工后 GREEN**：`budget-extension.spec.ts:475` 用同一注入构造（伪造 `approval/asked` + `requestKey` 内嵌摘要）断言零事件；`task-runtime/src/index.ts` 已无任何按调用者文本判授权的路径（grep `reason.includes`/`budgetExtensionApprovalBinding` 为 0 命中）。
2. **旧批准 + 替换 baseline** — 返工前**未复现**（日志 `/tmp/k4-red-b.log`）：`B1` 报 `holds no ask … carrying this request's binding`，`B1c` 被 store 逐维重检拒绝；唯一可达路径就是第 1 条的 requestKey 文本通道。返工后该通道关闭，且公开入口不再接受任何读数（`baseline` 等字段具名拒绝），"拒绝后重新请求必须重新审批"由「asks a person again after a refusal」（tool 单测）钉住。
3. **持久行可读、append 尚未返回时双计** — 在复审点名的 `f670e83` 形状上 RED（提取件 sha256 `fa8527d7913a6a0ec24c49551348922ef558aee92b6f94f53429369cfd4e79ca`，与 `git show f670e83:agent-singularity/src/review-agent-ledger.ts` 逐字节一致；日志 `/tmp/k4-red-c.log`）：受控交错观测 `{"rows":1,"readInWindow":true,"spent":2}`，一行耗掉两次额度（cap=2、已用 1 时不再放行）。返工后 GREEN：`review-agent.spec.ts:431` 同一交错持行，`started` 只能是 1（既非 0 也非 2），文件一行即一次消耗；`agent-singularity/src/review-agent-ledger.ts` 已无任何进程内计数缓存（`persistedRows`/`claims`/`reserve`/`effective` 0 命中）。

## 删除清单（返工段）

- `task-runtime/src/index.ts`：`budgetExtensionDraft` 零写查询、旧 `extendRootBudget(sessionId, commit)` 公开提交、`RootBudgetExtensionDraft`/`RootBudgetExtensionOutcome`/`RootBudgetExtensionCommit`/`RootBudgetExtensionBaseline`、`budgetExtensionApprovalBinding`、`budgetApproval` 日志扫描与 `budgetDimensionMoved`。
- `agent-singularity/src/tools/budget-extend.ts`：工具内的 draft→审批→commit 接力、binding 渲染与缺失抛错、工具自己调 `ctx.approval`。
- `agent-singularity/src/review-agent-ledger.ts`：`persistedRows`、`claims`、`knownRows`、`effectiveReviewAgentRuns`、`reserveReviewAgentRun`、`ReviewAgentReservation`、独立 `appendReviewAgentRun`（写行只剩 `admission.start`）。
- `agent-singularity/src/tools/review-agent.ts`：预留/归还与 `count → reserve` 两步判定（改由串行区一次性判定）。
- 保留（合同要求不得误删）：请求内容身份幂等、持久整份读数重检、零写展示查询 `countReviewAgentRuns`、store 侧事实形状。

## 公共检查（最终树实测，全部 exit 0）

- `pnpm build`（`packages/singularity`）：exit 0；tracked `lib/` 随提交重建（`task-runtime/lib/{index.js,index.d.ts}`、`task/lib/{index.js,index.d.ts}`、`agent-singularity/lib/index.js`）。
- `pnpm vitest run --project unit packages/singularity`：63 文件 / 1990 例通过，0 跳过。
- `pnpm vitest run --project integration packages/singularity`：63 文件 / 506 通过 + 2 跳过（既有门控子例）；上一轮偶发的 `worker-contract.spec.ts:200` 超时本轮两度全量均未复现（8/8，约 5.2–5.8s）。
- `pnpm run verify-persistence`：OK，4 事件根匹配；`git diff --check`（两仓）干净；`agent-singularity``pnpm exec tsc --noEmit`：exit 0。
- 独立复核（另一子代理，未复用交付测试）实跑同一组检查并自写 9 个探针（见下）。

## 400 行以上文件处置

- `task-runtime/src/index.ts`（8015 行，保留）：服务门面的既有归属；本轮在同一文件内删除两段旧机制并收口为一次调用，未迁出、未加转发层。`agent-singularity/src/review-agent-ledger.ts`（290 → 247 行，保留）：额度所有者唯一，删缓存换单入口。`agent-singularity/src/tools/budget-extend.ts`（230 → 249 行，保留）：工具卡与审批回调同属人审面。`task/src/{index,service/state,budget}.ts`（保留）：事实形状与串行重检未改，仅补文档。无同名转发层、无第二事实源。

## 接口交接（返工后）

- 支持范围：`task_budget_extend` 仅可信根协调会话（worker/跨 graph/不可解析 graph 具名拒绝，且在打开 store 前）；store 由会话推导；终态可调用；至少一维；只升已配置维度；请求字段集闭合（含继承可枚举字段）。
- 正常路径：一次调用 → runtime 冻结读数 + 用量 → 装配期审批回调（DSH 原生卡片与审计对）→ 获准后 store 串行区重检 → 一条 `TaskBudgetExtended`（整份冻结读数 + `approval:<hostCallId>` 审计引用）。
- 拒绝路径：无人审装配/请求带旧字段/无 callId/根会话不符/未知-未配置-非提升维度/键冲突/读数漂移/重复值不同内容 —— 各具名拒绝，零预算事件、零新 Run、零审批（幂等重复连审批都不发）。
- 取消/恢复/旧数据：人审拒绝或取消零写；重启从事件重建有效限额（不按 now 重算、不回退、不清零）；reviewer 旧计数重启不清零。上一轮 `500f0d9`（无 `baseline`）形状的记录仍 fail-closed 拒放，处置与持久化记录一致。
- 未支持扩展（合同排除）：A5 自动扫描与精确源协议、A6 `task_recover`/supervisor、增量/相对时长/token 新账/`approved` 参数、第二预算账。

## 已知边界（对照合同）

- 首次扩额某维时 store 无法按配置复算该维（配置不在 store 内），链式权威自该维第一条起；合同未要求 store 复算配置基线。
- store 的 `recordBudgetExtensionIn` 是**记录原语而非授权边界**：`approvalRef` 是审计引用、store 不校验也不得校验（第二授权源、receipt/token 服务均为合同排除）；进程内插件代码与既有 `commitIn` 同级属受信平面。模型/工具面唯一请求入口是 `extendRootBudget`，它总是经装配期审批回调。独立复核以 `recordBudgetExtensionIn` 伪造 `approvalRef` 的探针证实了这一点，判定为信任平面事实而非本票缺陷。
- reviewer 受理串行区为进程内；跨进程共享同一 ledger 文件未覆盖（单 writer 部署前提，跨进程并发写由既有 session 持久化租约排除），独立复核未构造两进程探针。
- `registerRootBudgetApproval` 为公开服务方法：同进程插件可替换装配的审批（模型面不可达，与既有服务注册同级）。
- 本轮未做真实模型实验，不声称提高成功率；未推送、未部署、未运行 BB 仿真。

## 子代理分工

1. R1（coder，反例复现）：三条关键反例的红/绿证据，含 `f670e83` 提取件逐字节核验；未修改生产代码。
2. R2（coder，task-runtime）：单次调用入口、装配期审批注册、删除接力与日志扫描、关闭请求字段集、package 单测。
3. R3（coder，agent-singularity ledger）：`admitReviewAgent` 每 store 串行受理、reviewer 工具接线、删除计数缓存与预留、单测。
4. R4（coder，agent-singularity 工具）：工具一次调用接线、审批卡片、构造期装配、工具与 assembly 单测。
5. R5（coder，集成）：scripted-loop/run-stack 装配审批、三份 K4 集成重接、公共检查首轮。
6. R6（coder，独立对抗复核）：K4-1～K4-5 逐项核对 + 5 个自写探针 + 公共检查；发现继承字段与 store 信任边界两点。
7. R7（coder，复核收口）：闭合继承可枚举字段、补 store 信任边界文档、重跑全部公共检查。
