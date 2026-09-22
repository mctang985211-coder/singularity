# A3 非阻塞运行与恢复：事件/状态迁移矩阵与受控模型 fixture 合同

日期：2026-09-22。状态：实现前合同（深入架构 §10 末段纪律：先提交本矩阵与 fixture 设计，评审后实现）。
前置：T1（`741dcb2`）、S1-V 切片 2（`c2912af`）、S1-C（`eaa024f`）均已验收；前置接口已逐项源码核对。
依据：[深入架构](exploration-evolution-architecture.md) §7.1/§7.2/§7.4 与 §10 A3 行；[建设计划](2026-09-20-vrtc-code-change-plan.md)文首唯一顺序第 4 行完成闸。

本票只做 A3：T2/T3、A0、A4、A5 均不实现；问答等待字段仅作为持久化挂载点出现（`task_ask_parent`/`task_answer` 工具不建）。

**合同评审记录（2026-09-22，独立只读评审子代理）**：初版经评审发现 8 项缺陷并已修正——(1) factCount 原定义依赖事件日志而 `TaskSnapshot` 不含日志 → 改为快照可计算的子树条目代理（§3.5）；(2) drain 未排除发起调用自身 → 必死锁 → 补 `excludeCallId`（§3.3）；(3) 兼容性表述错误（旧读者并非"忽略"未知事件而是 fail-closed 拒绝打开 store）→ 如实改写（§1.2）；(4) 恢复会重启计时 → 期限一律从持久化 `run.startedAt` 起算（§3.5/§3.6）；(5) 出生即 submitted 绕过形状校验 → `TaskStarted` 的 reducer 增加出生相位形状校验（§1.2）；(6) 升级后在途旧 run 无出口 → 明示 needs-recovery 的唯一动作是取消重开（§3.6）；(7) pid 活性探测边界（EPERM 视为存活、pid 复用、多机共享 DSH_HOME 失效）→ 补入 §3.4；(8) 验证权未收口 → 明示 driver 不再持有 verify 权、验证仅三入口（§3.1）。另补：通知 seam 指名（§3.1）、`task_verify` 自检与提交验收会产生两份 evidence bundle 的预期行为说明（§3.1）。

## 1. 持久化变更（task 包）

### 1.1 新类型

```ts
export type ExecutionPhase = 'active' | 'waiting_children' | 'submitted'

export interface SubmissionRecord {
  summary: string            // 提交者自述（worker）或运行时生成（runtime）
  evidenceRefs: string[]     // 提交者指名的证据/产物引用
  notes?: string
  submittedAt: string        // 与事件 timestamp 同源
  origin: 'worker' | 'runtime'  // runtime：批次结算自动提交 / 无 worker 的 criteria replay
}

export interface NoProgressRecord {
  kind: 'unsubmitted-idle'   // A3 唯一种类
  rounds: number             // 连续无进展轮次
  factCount: number          // 上次标记时该 run 子树的事实计数（见 §3.6）
  markedAt: string
}
```

`TaskRun` 新增可选字段：`executionPhase?: ExecutionPhase`、`batchId?: string`、`submission?: SubmissionRecord`、`pendingQuestionIds?: string[]`、`blockingQuestionIds?: string[]`（A4 挂载点，A3 恒不写入非空值）、`noProgress?: NoProgressRecord`。旧 run 无这些字段：终态原样读取；非终态缺 `executionPhase` 走 needs-recovery 派生诊断（§3.7），不默认 active 重跑。

新 run 出生时 `executionPhase: 'active'`；无 worker 的 replay（`spawn: false`）出生即 `submitted`（origin runtime）。

### 1.2 新事件（`task/event` 根内新增 kind，same-version）

```ts
RunPhaseChanged: {
  phase: ExecutionPhase
  batchId?: string                 // waiting_children 必填：b-<parentTaskId>（确定性，一个任务只分解一次）
  submission?: SubmissionRecord    // submitted 必填
  pendingQuestionIds?: string[]    // A4 写入；A3 reducer 只做形状校验并携带
  blockingQuestionIds?: string[]   // 同上
  reason?: string
}
RunProgressMarked: {
  kind: 'unsubmitted-idle'
  rounds: number
  factCount: number
  note: string                     // 可观察的未提交诊断文本
}
```

Reducer 校验（`task/src/service/state.ts`）：

- `RunPhaseChanged`：run 存在且 `status === 'running'`（防迟到的真正守卫是相位迁移闸：submitted 之后同相/回退/再提交一律拒绝；run 在 TaskVerifying 后 status 仍 running，所以相位闸是主防线）；合法迁移仅 `active→waiting_children`、`active→submitted`、`waiting_children→submitted`；其余一律抛错。写入 run 的相位字段；对 `submission`/`batchId` 做形状校验（ submitted 必有良好形状的 submission，waiting_children 必有 batchId）。
- `RunProgressMarked`：run 存在且 `status === 'running'` 且 `executionPhase === 'active'`；写入 `run.noProgress`。
- `TaskStarted`（`start()`）对出生相位字段做同等**形状**校验（与 assertProviderBinding 同级）：`executionPhase` 缺省为合法；声明时必须是已知相位值；出生 `submitted` 必须携带良好形状的 `submission`（origin runtime）且不得有 `batchId`；出生 `active` 不得携带 `submission`/`batchId`。出生字段由 runtime 构造，reducer 只做形状校验（不重复迁移语义）。
- 两事件的 reducer 校验不依赖时间戳与 actor 内容。

持久化纪律：`task/event` 根指纹将移动 → 新增 `docs/persistence-changes/2026-09-22-a3-coordination-phases.md` + `.schema.json`，实跑 `verify-persistence`（`--write` 并记录原因）。兼容性（经评审修正的准确表述）：只加事件类型与可选字段，**新构建读旧日志完全兼容**（旧记录无新字段、无新事件）；**旧构建打开含新事件的 store 会在回放时具名拒绝**（`TaskState.apply` 对未知 event kind fail-closed 抛错——`ignorable: true` 只对未知 event *type* 放行，不覆盖同 type 下的未知 kind）。这是可取的 fail-closed 行为，不宣称旧读者能忽略。

### 1.3 服务入口（task/src/index.ts）

- `changeRunPhaseIn(storeId, taskId, runId, actor, payload)`：写 `RunPhaseChanged`。
- `markRunProgressIn(storeId, taskId, runId, actor, payload)`：写 `RunProgressMarked`。
- `decomposeIn` 扩展（或新增 `admitBatchIn`）：子任务创建/准入/依赖/`TaskDecomposed`/`CapabilityResolved`(+`CapabilityGapDetected`)/父 `RunPhaseChanged(waiting_children)` 在**同一次 commit** 落库（原子准入）。这是写入收敛边界的第一步（先持久化准入关闭状态）。

## 2. 状态迁移矩阵（实现目标，与深入架构 §7.2 对齐）

| 当前相位 | 触发及前提 | 下一状态与效果 |
|---|---|---|
| active | 有效分解批次通过全部准入（含工作区归属、根预算预留） | 原子提交后父 run → `waiting_children`（batchId 记录）；工具立即返回 batchId；runtime 拥有的 driver 排空父在途写后开始按依赖串行启动子节点 |
| active | 有效 `task_submit_result`（caller=run 绑定 session） | 先提交 `RunPhaseChanged(submitted)`（准入关闭），再排空在途写与受管理后台进程，最后 verifier 排他执行 → verified/failed；排空不可确认 → failed + 不可验收诊断 |
| waiting_children | 全部子任务终态 | runtime 自动提交父 run（origin runtime）→ 排空 → 父验收（既有 composite/P4 规则不变）→ verified/failed；父 agent 收到 followup 通知，无需第二次自述 |
| waiting_children / submitted | 父模型调用写/shell/再次分解/重复提交/任务外副作用工具 | 运行时工具执行闸 deny（结构化原因），无状态变化；读取/状态/诊断/人问/受控取消放行 |
| 任意非终态 | graph 取消 / batch 取消（`task_cancel`，仅本批次父 run 的 session）/ 根期限到达 / 不可恢复基础设施失败 | 按原因 cancelled 或 failed；取消未启动子节点（cancelled-before-start），中止在途子 agent，回收工作区归属，对账受管理进程 |
| 任意终态 | 迟到的提交/分解/写入 | 拒绝执行效果并保留诊断（提交去重由相位唯一性保证：第二次提交返回已记录结果，不改状态） |
| active（worker）idle 且无提交 | `whenIdle` 观察 | `RunProgressMarked(rounds+1)`；rounds=1 时经 `agent.followup` 发一次提醒；达到 `noProgressRounds` 上限 → failed（无进展预算停止，保留诊断）；已知等待（waiting_children/submitted）不标记 |
| 重启后非终态 run | 恢复对账（§3.7） | submitted → 补验证；waiting_children → 重启批次 driver；active（worker）→ cancelled + 恢复诊断；缺相位（旧记录）→ 不改状态，task_read/task_status 派生显示 needs-recovery |

`waiting_answer` 对外显示态与 `pendingQuestionIds`/`blockingQuestionIds` 的写入属 A4；本票仅在类型与 reducer 形状校验上预留。

## 3. 机制设计

### 3.1 准入与推进分离（不新建 workflow 引擎）

`decomposeAndRun` 改为两阶段：

1. **准入（调用方 signal 管辖）**：现有全部检查（受保护输入固定 → 规范化 → 结构准入 → 能力缺口 → provider 预检 → verifierRef）顺序不变；新增：父 run 相位必须是 `active`（否则拒绝，含 waiting_children 中的再次分解——与 reducer 的 decompose-once 一致但更早拒绝）、根预算预留检查（§3.5）、工作区归属检查（§3.4）。任何拒绝零副作用。
2. **原子提交**：§1.3 的一次 commit。提交后调用方 signal 失效（所有权转移，§3.8）。
3. **推进（runtime 管辖）**：`startBatchDriver(storeId, parentTaskId, parentRunId, batchId)` 注册进 `batches: Map<batchId, {controller, promise}>`，立即返回 `{ batchId, childTaskIds }`。driver 出错必须捕获 → 父 run failed + 记录 + 通知 owner（followup），不得 fire-and-forget。`ctx.effect` 注册 dispose：abort 全部 controller 并等待结算。

- 驱动函数从 `runChildrenCascade` 抽出为**可重入推进**：每轮从 store 重读子任务状态（终态采纳、未启动才启动），内存只缓存 handle 与 watcher。现有验证/依赖规则（missingRequiredArtifacts、handoff、绑定、spawn、verify、review 记录）全部沿用，不复制第二套状态分支。
- owner 通知 seam：父 run 终态/无进展提醒经 `ctx.agents.get(sessionId)?.followup(...)`（live agent 才发，best-effort，消息 `source: { kind: 'plugin', plugin: 'task-runtime', form: 'notice' }`，沿用 DSH tool-jobs 的通知先例）；agent 不在线只记录不报错。

子 run 的等待改为 `driveChildRun` 竞争：`waitRunTerminal(store, runId)`（submission 路径/嵌套批次/取消写入的终态；经 `task/change` 每 commit 一次的快照实现，先订阅再读初始快照防竞态，settle 后取消订阅）｜ worker `whenIdle`（相位机：active→无进展标记；waiting_children/submitted→只等终态，不再监听 idle，避免空转）｜ 期限（min(run wallTime, 根剩余)，从 `run.startedAt` 起算）｜ 批次 abort。嵌套分解不再是递归调用：子 worker 自己的 `task_decompose` 在 runtime 注册新 driver，外层 driver 只观察子 run 终态。

**验证权唯一**（评审修正）：driver 不再持有 verify 权——`runChildrenCascade` 现有的 idle→verify 子验证段与内联父验收段整体删除；run 的验证只有三个入口：`submitResult` 的续跑、批次结算时的父自动提交续跑、恢复路径的补验证。三者互斥靠相位唯一性（submitted 只进入一次）与单进程 driver 登记（已登记的批次不重复启动）。`task_verify` 自检在 active 相位放行，会落一份 `EvidenceProduced`；提交后验收再 verify 一次 → 同一 run 可能有两份 evidence bundle——这是"自检≠验收"的预期行为，review 的 evidenceRefs 如实列出两份，文档明示。

### 3.2 显式提交 `task_submit_result`（submitted→verifying）

- 工具参数：`{ summary: string, evidenceRefs?: string[], notes?: string }`；worker baseline 与 ROOT_TOOLS 均挂载。
- runtime `submitResult(sessionId, spec)`：身份/状态重检（runForSession 绑定、run running、phase active、caller 匹配）→ 先提交相位事件 → 排空（§3.3 drain + §3.4 归属转 verifier）→ `verifyRun`（既有 deadline/安全边距）→ `unmetMandatory` → verified/failed + 终态 review（全部沿用现有函数）。
- 工具等待验证结论并返回文本（有界：verifyTimeoutMs + margin）；崩溃后由恢复路径补验证（phase=submitted 是唯一恢复依据）。
- 迟到提交：phase 非 active → 拒绝执行效果，返回已记录提交/终态的只读摘要（去重靠相位唯一性与 reducer 迁移闸）。
- 旧行为修复点：session idle 不再是完成证据；worker prompt 改为显式提交协议（§3.9）。

### 3.3 写入收敛与运行时工具执行闸（gate.ts）

接缝（DSH 现状，无需改 DSH）：全局 `ctx.on('tools/pre-execute', (exec, next) => decision)`（`core/tools/src/index.ts:1482`，PTC 子调用同样经过），`ctx.on('tools/result', …)` 每次执行恰好一次（含失败/中止），`ctx.jobs`（`list(callerAgent)`/`kill`/`wait` 终态确认；服务缺席时视为无受管理作业）。

闸内状态（单进程 runtime 拥有）：`sessionId → { phase, inFlight: Map<callId, {name, writes}> }`。相位由 runtime 在提交成功后同步更新。**在途登记一致性规则**：只有被放行（调用了 `next()`）的调用才登记；deny 的调用不登记（其 `tools/result` 到来时移除为 no-op）；`tools/result` 按 callId 出清。

放行表（相位 ≠ active 时）：`task_read`、`task_status`、`capability_list`、`skill`、`session_search`、`session_event_read`、`session_trace`、`task_review_pack`、`task_diagnose`、`read`、`read_image`、`glob`、`grep`、`web_fetch`、`ask_user_question`、`hitl_ask`、`hitl_approve`、`task_cancel`。其余一律 deny（含 `task_decompose`、`task_submit_result`、`task_verify`、`write`、`edit`、`bash`、`job_*`、`graph_spawn`、`evolution_*`、`subagent_*`）。无 run 绑定的 session（env-clean、reviewer 等）不受闸约束。deny 返回 `{ kind: 'deny', reason }`（含相位与允许类别），不改动任何状态。

写入收敛（dispatch 与验收共用）：

1. 先持久化准入关闭（分解批次提交 / RunPhaseChanged(submitted)）。
2. `drainSession(sessionId, timeoutMs, { excludeCallId })`：等该 session 在途写类调用清空（有界；含闸登记的在途调用——这就是"在途调用也需检查"的落实），并 kill+wait 其 `ctx.jobs` 列出的受管理作业；超时仍非终态 → 不可确认清单。**发起提交/分解的工具调用自身经 `excludeCallId` 排除**（它在 drain 进行时仍在途，不排除则 drain 永远等自己——这是评审发现的阻断缺陷；该调用是协调动作，不是待排空的写）。
3. 可确认 → 启动子批次 / 转 verifier 排他执行；不可确认 → 明确的不可验收诊断（批次：父 failed + 子 blocked 未启动；提交：run failed，提交记录保留），**禁止假定已停止**。

### 3.4 工作区唯一写入归属（workspace.ts）

- 身份：`realpath` 规范化后的 checkout 绝对路径；无法解析 checkout 的部署（无 envBuilder）跳过归属并在记录中如实标注 `unbound`。
- 记录：进程内 `Map<workspace, owner>` + 标记文件 `<runBindingRoot>/workspace-owners/<sha256(path)>.json`（`{ path, pid, owner, since }`，tmp+rename 原子写）。进程内 Map 不宣称跨进程锁；跨进程守卫 = 标记文件 + pid 活性探测。
- owner 形态：`{ kind: 'run', storeId, taskId, runId }`（活跃写入者）｜ `{ kind: 'verifier', ... }`（验收排他期）｜ `{ kind: 'batch', storeId, batchId }`（子间隙的 runtime 持有）。
- 规则：任一时刻一个工作区最多一个 owner；冲突请求在任何副作用前抛 `WorkspaceBusyError`（结构化：workspace、现有 owner、since）。父委派时（批次提交后、首个子 spawn 前）排空并转交；子终态后经 runtime 收回/转下一个子/verifier；run 终态释放（删标记）。
- 标记冲突：pid 活且非本进程 → busy（另一活管理进程，部署入口由此被拒绝接管）；pid 死 → 陈旧标记，仅经恢复对账路径接管并记录诊断，正常 claim 遇任何现存标记一律 busy。**pid 活性探测边界（如实记录）**：`process.kill(pid, 0)` 对其他用户进程抛 EPERM——必须视为存活；pid 复用（死进程的 pid 被无关进程回收）会把陈旧标记误判为活——标记内除 `since` 外尽力记录进程启动时间（/proc/<pid>/stat starttime，读不到则省略并接受该边界）；DSH_HOME 被多机共享挂载时 pid 探测对异机进程无意义（§5 的外部写入者边界的一种具体形态）。
- 根 run 非终态期间持有其工作区（覆盖共享 checkout 的根任务）；replay 与直接服务调用走同一 claim/release。取消/重启先对账受管理进程，不抢走仍可能写入者的归属（live pid 不抢）。
- 归属栈：同一工作区的 owner 形成栈（run → 其 batch → 当前子 run → verifier → …），transfer 压栈、终态弹栈，弹栈须顶匹配（非顶弹出 = 诊断）；marker 文件始终写栈顶。恢复对账把已死树的所有非终态 run 结算后栈塌为空 → 释放标记。

### 3.5 根预算归属（root-budget.ts）

- 配置 `Config.rootBudget?: { wallTimeMs?, maxRuns?, maxConcurrentWrites? }`（闭合 schema）。可执行硬限制仅：根截止时间（从根 run `startedAt` 计——现有可追溯创建事件；A0 接入真实接受事件后语义不变）、Run 启动次数、递归深度（既有 maxDepth）、并发写入数（仅支持 1，配其他值构造期拒绝启动）。token/工具费用无运行中计数 → 只允许既有终态软统计出现在 review 记录，未知不记零；schema 拒绝任何其他硬限制字段（调用方要求无法执行的硬限制 = 拒绝启动）。
- 预算 owner：store 的根任务（`parentTaskId === undefined`）；一个 store 一棵树，replay 的 parentless task 落在同一 store 即共享同一根总额（资助根引用 = store 根绑定，不再新建账本）。旧记录缺起点（根 run 缺 startedAt 或无根）→ 明确恢复诊断，不用重启时间伪造。
- 执行：每次启动 run 前检查 `runs.length >= maxRuns` → 拒启（子任务 failed，预算原因，零 spawn）；分解准入按批次大小预留（`runs.length + children.length > maxRuns` → 整批拒绝，零副作用）。run 期限 = `min(配置 wallTimeMs, 根剩余)`，**期限一律从持久化的 `run.startedAt` 起算（含恢复后续跑——重启不重计时**，§7.4）；根期限到期在飞取消（budget-exhausted，沿用既有预算失败语义）。次数按稳定 runId 记账（TaskStarted 先于 spawn，崩溃重开从日志重数——不重复计数、不重置额度）。
- 进展计数（§2 矩阵末行）：`TaskSnapshot` 没有事件日志（评审修正），事实计数用快照可计算的子树代理——子树内 `tasks + runs + edges + evidence + handoffs + reviews + diagnoses + obligations` 条目数之和（按 parentTaskId/runId 过滤）。`RunProgressMarked`/`RunPhaseChanged` 只改写 run 字段、不产生新条目，天然不计入；`EvidenceProduced`/新子任务/依赖边/评审记录才是有效事实。自然语言"有进展"、重复同一失败调用（不产生新条目）、重复创建同目标任务（reducer 拒绝）都不清零。上限到达保留诊断并停止；不调用尚不存在的主管入口（A5）。

### 3.6 取消 / 恢复 / 卸载

- `cancelGraph(storeId, reason)`：abort 该 store 全部批次 controller → driver 按既有 abort 语义结算（在途子 cancelled、未启动 cancelled-before-start、父 cancelled）；闸将该 store 的 session 标记终态；释放工作区标记；对账 jobs。由 `graphs.remove` 在 stopGraph 前调用，并作为服务 API 暴露。
- `cancelBatch(storeId, batchId, callerSessionId)`：仅该批次父 run 的 session 可调用（`task_cancel` 工具入口，闸放行表内）。abort controller → 在途子取消、未启动取消、父按既有 abort 分支 cancelled。
- 卸载：`TaskRuntime` 新增 `ctx.effect` dispose：abort 全部 driver → 等待有界结算 → 关闸 → 释放标记；TaskService 既有 close 在其后 flush（cordis 逆序）。
- 恢复（store 打开/根 run 收养时 `reconcileStore(storeId)`，幂等——已登记 driver 的批次跳过）：
  - 先复用 S1-C 的 `readRunBinding` 对每个待续 run 做快照复检（缺失/被改 → 具名拒绝，该 run failed + 诊断，不静默回退）。
  - 按 §2 矩阵末行处置；处理顺序按深度降序（子先于父）。
  - active 且有未确认写入风险的工作区：先对账（§3.3/§3.4）再结算。
  - 恢复不重启计时：期限从 `run.startedAt`（持久化）起算。
- 旧非终态无相位 run：不改状态、不伪造终态；`task_read`/`task_status` 派生显示 `needs-recovery`。**处置出口**：此类 run 唯一合法动作是取消（cancelGraph/换图重做）——它缺相位，准入与提交都要求 active，因此永远不能分解/提交/验证；这是预期处置，不是悬挂。

### 3.7 工具 signal 所有权转移

工具 `exec.signal` 只管辖准入段；原子提交后批次由 runtime 的 per-store/per-batch AbortController 拥有；spawn 与 awaitWorker 用批次 signal；取消源 = cancelGraph / cancelBatch / 根期限 / dispose。必须有测试：工具调用返回（或工具 signal abort）后批次继续至完成；graph 取消后批次停止。

### 3.8 工具面与 prompt 同步

- `task_decompose`：立即返回 `{ batchId, childTaskIds }` 文本；不再等待批次结果。runtime 另暴露 `awaitBatch(storeId, batchId)` 供服务/测试消费。
- 新工具 `task_submit_result`、`task_cancel`；`ROOT_TOOLS` 与 `workerBaseline` 同步挂载。
- worker prompt（handoff.ts）：显式提交协议（完成调 `task_submit_result`；idle ≠ 完成；一次提醒后无进展停止；`task_verify` 仍只是自检）。
- root prompt（root.prompts.ts）：分解立即返回 batchId；waiting_children 期间只协调不写；批次结算后收到通知；`task_cancel` 取消本批次。
- `task_read`/`task_status`：渲染相位/batchId/submission/noProgress；旧 run 派生 needs-recovery。
- `agent-prompt-contracts.md`：把 waiting_children 写闸、`task_submit_result`、取消措辞与实际工具面对齐（只写本票已实现的）。

## 4. 受控模型 fixture 与测试设计

### 4.1 真实 DSH loop + scripted provider

新 fixture `tests/support/scripted-loop.ts`：真 `LlmRuntime` + `SessionStore` + `SessionProjectionRegistry` + `SystemPrompt` + `ToolRuntime` + `AgentRegistry` + `AgentLoop({agents:[]})` + 真 `AgentRuntime.spawn` + 真 singularity 工具；模型 = 自写 `ScriptedModelAdapter extends LlmAdapter`（20 行级，按 `GenerateOptions.sessionId` 分片取脚本——已实测该字段可靠；DSH `agent-loop/tests/mock-adapter.ts` 的 chunk 构造器 `toolCallResponse`/`textResponse` 按既有相对路径 import 先例复用）。脚本项：`toolCall(name, args)` ｜ `text(str)` ｜ `idle`。`agentDefaultModel` 指 mock route。断言全部从持久面（store 事件、session 事件、adapter.requests）读回。

### 4.2 真实 JSONL 崩溃恢复

崩溃点构造：真 `session-persistence-jsonl` 后端 + 真 TaskService/TaskRuntime（context A），用可控假 spawn（whenIdle 挂起）把批次推进到指定事件边界，`flush` 后**遗弃** A（不 dispose——模拟进程死亡）；同目录新建 context B（真 JSONL 重开）→ B 的恢复入口（`createRootTask` 收养 / `reconcileStore`）→ 断言续跑/诊断/不重复副作用（spawn 次数、run 数、预算计数）。崩溃点：分解提交后未 spawn、子在途未提交、子已提交未验证、子全终态未父验收、旧无相位 run。

### 4.3 验收项 → 入口 → 测试（最低覆盖）

| 验收项 | 入口 | 测试 |
|---|---|---|
| 分解立即返回且父可继续（循环等待反例） | `task_decompose` 工具 + `decomposeAndRun` | 集成：工具返回时子未完成；反例先行：改造前工具不返回 |
| waiting idle 不验收 | driveChildRun 相位机 | 集成：worker idle 无提交 → 不 verified；提醒一次；到限停止（诊断保留） |
| 显式提交/父独立验收 | `task_submit_result` + 父 auto-submit | 集成：提交→verified；父 composite 仍走 P4 规则（含 childEvidence） |
| 依赖串行 | driveBatch | 单测+集成：dependsOn 顺序、失败阻断、同批不并行 |
| 取消/恢复/卸载完整 | cancelGraph/cancelBatch/dispose/reconcile | 单测+集成+JSONL 重开 |
| 提交/派发去重 | 相位唯一性 + reducer | 单测：重复提交/重复分解拒绝且无副作用 |
| 迟到写入被阻挡 | 执行闸 | 集成：submitted/terminal/waiting_children 后 write/bash deny；读放行；在途写被 drain 计入 |
| 跨批次/跨根工作区冲突 | workspace.ts | 单测+集成：第二根/第二批次 busy（副作用前）、verifier 排他、stale 标记仅恢复路径接管 |
| 普通/replay 同守状态规则 | replayTask | 集成：replay worker 同样需提交；spawn:false 出生 submitted |
| 根预算不因新 Run/重启重置 | root-budget.ts | 单测：maxRuns/期限拒启；重开重数不重置；replay 共享；缺起点诊断 |
| 无进展停止 | RunProgressMarked + 相位机 | 集成：提醒一次后到限 failed |
| signal 转移 | decomposeAndRun 两阶段 | 集成：工具 signal abort/返回后批次继续；图取消才停止 |
| 恢复复用 readRunBinding | reconcileStore | 单测+JSONL：快照被改 → 具名拒绝续跑 |
| 真实 loop 协调协议 | scripted-loop fixture | 集成：真实 loop 下分解→worker 提交→父验收→root 收到结算通知 |

## 5. 边界（如实声明，不算完成项）

- 问答工具（task_ask_parent/task_answer）属 A4；本票只有持久化字段挂载点。
- 子任务仍按依赖串行；不引入并行工作窃取。
- 进程崩溃时在途的 active worker run 不恢复现场（cancelled + 诊断）；worker session 续跑属 S2-R 范畴。
- 工作区归属是单进程 registry + pid 活性标记；不防御共享文件系统上的外部 unmanaged 写入者（含多机共享 DSH_HOME 时 pid 探测对异机进程失效）。
- 根预算的 token/工具费用只有软统计；配置不可执行的硬限制会在启动/准入拒绝。
- S4-E 式"独立评估请求自带显式预算 owner"不属本票；replay 经 store 根总额记账已覆盖现有唯一调用方（evolution_replay，由 root session 发起）。
- run 快照 GC/配额仍属后续（S1-C 已记录的边界）；本票新增 workspace-owners 标记文件随释放删除。
- `spawn: false` 的 replay 无 worker，出生 submitted（origin runtime），不经提交闸。
- 根 run（绑定 root session）不挂无进展相位机——它在用户输入间合法 idle；其完成只经批次结算或图取消，根期限（若配置）仍是上限。
