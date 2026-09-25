# 第 11 项 A4 返工交付记录（冷恢复闭合）

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **待验收**（交付方最高可填状态），2026-09-26 |
| 执行 agent / 任务链接 | 返工实现主代理 + 3 个子代理（①agent-runtime 受控恢复 / ②task-runtime 接线与闭环 / ③静默路径可达性复核）；[返工 prompt](../execution-prompts/11-a4-rework.md)、[进度审核](2026-09-25-a4-progress-review.md)、[计划 F.1](../2026-09-20-vrtc-code-change-plan.md) |
| 返工审核结论 | 主代理逐项核对 F.1 原文后裁定返工要求**全部合理**：F.1（2026-09-24 冻结）明文「已知问答等待的 worker 重启后恢复同一 Session/Run」，晚于且优先于 A3（2026-09-22）「worker session 续跑属 S2-R」的边界声明；原交付把「非根父不复活」记为已知限制属合同误判。无合同削弱、无 scope 扩张 |
| 返工前基线 | Singularity `300a6bf` / 外层 `a9bbaa8`（原始交付：`bf686f4`→`dcf3f9b`） |
| 交付版本 | Singularity `44e2ec4`（子目标1）→ `7233706`（子目标2）+ 文档提交（见末节 git log）；外层指针提交见末节 |
| 前置文档处置 | 进度审核提交 `300a6bf` 已将全部共享文档置返工态；本记录为返工收口 |

## 阻断 1：问答等待 worker 复活（F.1「恢复同一 Session/Run」）

**修复**：
- `agent-runtime` 新增窄入口 `AgentRuntime.resumeWorkerAgent(request)`（`agent-runtime/src/index.ts:449`，主体 `worker-resume.ts:186`）：从调用方传入的 store/graph 事实（Run 绑定、capabilitySnapshot、preset、grant 输入）恢复**同一 Session** 为 live Agent；setup 与 spawn 共享唯一 `workerSetup` 组合（无第二份）；具名失败 `session-missing`/`session-unreadable`/`ownership-conflict`(可重试)/`binding-mismatch`/`not-in-graph`/`member-facts-missing`/`takeover-refused`，除接管外全部只读判定、零写入零新 Agent；不唤醒（唤醒由调用方经投递/notice 决定）。
- `task-runtime` 接线两处：`index.ts:5360`（store pass：问答等待 active worker）与 `:5418-5435`（有问答参与的 waiting_children 非根父），共享 `resumeAdoptedWorkerSession`（`index.ts:5616`）；批 driver 收养处 `orchestrate.ts:2060-2065` → `awaitAdoptedQuestionWait`（`:2124`，deadline 同源 `awaitWaitingTerminal`）。屏障内先对账受管理写入/进程、恢复 Session、闸在模型首个请求前就绪（`applyResumedSessionGate`），再按持久意图补投；pending 未 claim 的消息由 runtime `plugin/notice` 唤醒（不伪装 human、不入问答正文）。失败处置：`ownership-conflict` 留待重试不顶替；其余具名失败经 `settleRunFromRuntime(failed)` 带诊断结算终态，**不留永远 running 的死等 Run**；wallTime/根截止自原 startedAt 继续，过期取消、迟到答案不复活；无问答在途 run 仍走 A3 旧取消规则。

**验收（先红后绿）**：`tests/integration/a4-question-cold-recovery.spec.ts`（9 例）在未修复代码上 9/9 全败（`git stash` 对 `task-runtime/src` 验证：停在「recovered Session not live」/投递 60s 超时），修复后全绿：
- 二层闭环（`:827`）：子提问阻塞 → 终止重开 → 子 Run/Session 身份不变且 live → 父答 → 答案进子的实际模型请求 → 子解除阻塞并提交 → 父批次正常结束。
- 三层闭环（`:678`）：孙→非根父→根→非根父→孙跨重启全链；中间层恢复后能收问、转问、作答。
- 反例：Session 不可恢复 → 具名失败 + Run 终态不复活（`:1243`）；恢复后截止过期 → 取消 + 迟到答案不复活（`:1297`）；无问答在途 run 仍取消（既有 `a4-question-recovery.spec.ts` 反例不回退）。
- 单元侧：`agent-runtime/tests/unit/worker-resume.spec.ts` 27 例（校验矩阵/拒绝零副作用/共用组合）；`tests/integration/a4-worker-resume.spec.ts` 9 例（真恢复链：同 sessionId、工具面逐项相同、raw-session guard 仍在、恢复后零模型请求、投递 unavailable→delivered）。

## 阻断 2：A4-3 组合故障（真实 Task/Session 链，非手工 intent）

`a4-question-cold-recovery.spec.ts` 从真实 `QuestionAsked`/`QuestionAnswered` 与 JSONL 落盘边界注入四点：

| 崩溃点 | 用例 | 断言 |
|---|---|---|
| ①意图已持久未投递 | 闭环开场 + `:1007` 前段 | 恢复后补投恰好一次，同 messageId |
| ②入箱未 flush | `:1007`（移除 artifact 尾部 splice 字节模拟；真实 append-through 后端无法自造该状态，已注明） | 重开后重投，终态恰好一份 |
| ③入箱已 flush 未 claim | `:1046` | `already-present` 不重复入箱，runtime notice 唤醒 |
| ④claim 后未进 history | `:1091` | 补投后 history 恰好一条 |

- 相位覆盖：`active`（问答等待 worker）与 `waiting_children`（非根父）均覆盖。
- **answer 侧跨重启补投 + 下一请求可见**：`:1141`（集成正例）。
- **replay**：可达组合 `:1379`——replay 经真实 `task_decompose` 分解出子任务，子向 replay（waiting_children 且参与问答）提问，重启后 replay run 被恢复、问题一次投递、答案进子请求、批次正常结算。排除依据：`runReplayTask` 自身（实验 outcome/预算/报告）是调用域对象，跨重启续跑属 A6/S2-R，已在用例注释与 `resumeAdoptedWorker` 文档写明；replay candidate overlay roots 不在 run 记录（恢复用 run 自身 binding），批结算的 replay run 不再带进程内 lineage anomaly（持久血缘在 replayed task contract 上，已断言）。

## 可疑路径可达性复核（返工子目标3，被审 SHA `300a6bf`）

| 嫌疑 | 判定 | 依据 |
|---|---|---|
| `releaseAskingSessions` 缺 question index 静默返回 | **不可达**（生产链） | 两个调用点都读真实 `TaskService.snapshotIn`；`TaskState` 构造即初始化空索引（`task/src/service/state.ts:155-176`），重开路径从空 value 逐条 replay 事件，索引恒存在；pre-A4 旧 JSONL 重开有定向测试（`task/tests/unit/questions.spec.ts:708-729`）。结算路径不能因读不到索引而失败，静默返回是刻意安全分支 |
| `reconcileQuestionDeliveries` 报告缺项丢意图 | **遗漏分支不可达** | 下游 `reconcileAgentMessageDeliveries` 对每条 intent 恰好返回一条报告（含 `refused`），1:1 保序（`agent-runtime/src/messages.ts:378-392`）；可达坏情况（snapshotIn 抛/缺索引抛/closing 抛）均有 warn 出口 |
| 结算钩子与 `settleRunFromRuntime` 双触发重算 | **可达但无重复副作用** | `releaseAskingSessions` 值相等 guard（`question.ts:730`）拦截第二次写入，decision token 不二次推进；两读都在终态写入之后，不存在旧值盖回窗口 |

处置：三项均按返工 prompt「无法触发则记录依据，不为防御手工畸形对象扩票」处理，未改代码。

## 整票重验（主代理实跑，串行）

- `pnpm build`（Singularity 12 包）：通过，lib 产物入库。
- `pnpm vitest run --project unit packages/singularity`：**52 文件 / 1689 测试全通过**。
- `pnpm vitest run --project integration packages/singularity`：**49 文件 / 358 测试全通过**（含 a4-question-cold-recovery 9、a4-worker-resume 9、原 a4-* 全套与 a3 回归）。
- `pnpm run verify-persistence`：OK（本返工未增持久事件；A4 事件记录仍为 [2026-09-25-a4-questions.md](persistence-changes/2026-09-25-a4-questions.md)）。
- `git diff --check`：干净；`pnpm exec tsc --noEmit`（agent-singularity）：0 错误。
- 环境注记：子目标2期间 `worker-contract.spec.ts` 曾因他方重负载出现单例 120s 超时，同文件单跑 8/8 通过；主代理整票重跑该文件随全量通过，未放宽任何预算。
- 未运行：付费模型、推送、部署。

## 既有复杂度处置

- 新增 `agent-runtime/src/worker-resume.ts`（恢复唯一主体）与 `tests/integration/a4-question-cold-recovery.spec.ts`；`task-runtime/src/index.ts`/`orchestrate.ts`/`question.ts` 原地接线（恢复编排属其既有职责）；无新增包、无转发层、无第二 roster/mailbox。
- 既有的两处内联终态收敛（A4-5）不回退；`orchestrate.ts` replay 异常分支的内联终态仍归后续票（同一所有者内）。

## 独立复核

原始三路风险组复核（来源/权限、投递/重启、阻塞写闸/结算，被审 `d8e2d12`）结论在进程内范围仍然成立且其应修项已随 `829718e` 关闭；本轮返工新增一路可达性复核（上述三项，被审 `300a6bf`）。返工的两个子目标均有「未修复代码先红」证据。

## 文档同步

主 guide（当前进度/当前阶段判断/§1.4 归属表/§3/G12/§4.1 复核表/§5.16 重写恢复段与已知边界）、计划文首唯一表第 11 行（待验收）与派发段、`docs/execution-prompts/README.md` 当前项、本记录。

## 模拟与未覆盖范围

仅模型输出 scripted；Task store、DSH Session/inbox、agent-runtime 恢复、闸、工具瀑布、context 装配、JSONL persistence 全真。未覆盖：replay driver 自身跨重启续跑（A6/S2-R，排除依据见上）；A4-3 点②的字节级模拟边界（已注明）；恢复屏障内首个工具调用的「store is recovering」具名拒绝依赖模型重试（A2 §E 既有语义，未改）；付费模型效果实验（不属本票）。

## 未解决缺陷 / 已知边界

无未解决缺陷。保留边界见主 guide §5.16 末节；原交付记录的限制 1（非根父不复活）已由本返工关闭，其余（投递只认 live 目标、不 drain 同 step 在途写、store 原始事件门不拒未知键等）仍为设计合同或后续票事项。

## 最终验收结论

交付方结论：**待验收**（进度审核两项阻断均有真实链路红绿证据关闭，A4-1～A4-5 与公共检查重验通过；状态上限按合同留给进度审核）。

## 下一项

唯一顺序第 12 项 S4-E；前置 = 本票经进度审核验收。本返工未开始 S4-E/A5/A6。
