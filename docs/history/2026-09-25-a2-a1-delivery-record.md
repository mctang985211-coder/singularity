# 第 9 项 A2+A1（Agent 状态上下文）交付记录（2026-09-25）

> 后续[进度审核](2026-09-25-a2-a1-progress-review.md)发现 Q1–Q4 可达反例，已把本票改为返工。本页保留实现方当时的交付声明、检查与独立复核结论，不代表最终验收。

本文件是第 9 项交付组的详细交付记录，供进度审核核对；验收结论以[建设计划文首唯一表](../2026-09-20-vrtc-code-change-plan.md)为准，审核通过后才填已验收。

| 字段 | 内容 |
|---|---|
| 状态 | **交付待进度审核（2026-09-25）** |
| 执行 agent | 实现主代理（Kimi Code CLI 会话）+ 研究/勘探子代理（3）、实现子代理（2，子目标 2、子目标 3）、独立复核子代理（1，未参与实现的新上下文） |
| 任务链接 | [专项 prompt](../execution-prompts/09-a2-a1-context.md)；合同：计划 D 节、E 节「A2+A1：读取路径不能再承担恢复」、主 guide §1.4 |
| 开始日期 | 2026-09-24（子目标 1 `4a510ed`）；本组续作于 2026-09-25 |
| 验收日期 | 未验收——待进度审核 |
| 前置验收记录 | 第 8 项 R1（2026-09-24，完成轮 3 `pass / path2-limited-goal`）；第 8a 项 R3（2026-09-24，R3-1/2/3 全通过）。提交 `85b6952`/`6735a34` 与本仓唯一表核对一致；R1 仓库外证据目录只读未动 |
| 修改前基线 | Singularity `792b793`；外层 harness `563cc6e1f4`（两仓工作区干净；两仓均无 AGENTS.md） |
| 交付版本 | `4a510ed`（子目标 1，显式恢复屏障/纯读拆分，既有交接事实）+ `f90d05b`（子目标 2，context 读取核心）+ `0f41d91`（子目标 3，装配接线/工具适配/迁移删除/旁路封闭）+ `6e0f651`（独立复核缺口闭合） |

## 验收项对应（A2-1～A2-6）

- **A2-1（三层真实链请求内容）**：装配监听器 `context/src/assembly.ts:118` → 投影 `context/src/projections.ts`（根简报走 parentTaskId 链、本人完整契约、持久 TaskHandoff 信封）→ 数据源 `ctx.task.openStore` 真实 store。测试：`tests/integration/context-assembly.spec.ts`（三层链实际装配含根目标/硬约束/本人契约/handoff，兄弟依赖 evidence/review 经 `context_read` 按引用读，related 视图不含无关历史）；兄弟（非父子）依赖读另钉在 `context/tests/unit/reads.spec.ts:93-105`。**PASS（独立复核）**。
- **A2-2（域隔离）**：同 cwd 两 graph 互读具名拒绝（`context-assembly.spec.ts:181-266`，经真实 `ctx.tools.execute` + pre-execute/guard）；猜 id 不授权（`context/src/bindings.ts:291` 先解析 live caller 再在该域内查引用；session 引用先查 graph 成员）；四个原始 session 工具在有效工具面（root allow-list / worker baseline / reviewer baseline / gate 白名单）与执行兜底（`agent-runtime/src/raw-session-guard.ts`，三处 setup 安装 `tools.guard` 单调拒绝）同时封死，preset/MCP 重放行反例见 `tests/integration/worker-grant.spec.ts` 与 `context-assembly.spec.ts:242-265`；reviewer 只按 ledger 委派域读取（`bindings.ts:378 reviewerOf`），不冒充 root/业务 Run。**PASS**。
- **A2-3（重建）**：压缩后契约仍在（section 落 surface 节点 0，依据上游 `compaction-basic/src/region.ts:129-131`；`tests/integration/worker-contract.spec.ts` 折迭用例）；重启后首次装配不经 spawn/onRunBound（`context-assembly.spec.ts:270-305`：崩溃后新进程 `adoptRoot` 直接装配出契约，断言零 spawn）；replay 不串根（`context-assembly.spec.ts:308-362` 断言不含 champion 根目标；根由「run 的 session 即图根 session」认定，不取第一个 parentless task）；未激活/等待/终态/缺失/无绑定/失效引用/超限各有具名结果（`context/tests/unit/binding.spec.ts`、`reads.spec.ts`、`limits.spec.ts`）；重复装配不累加（监听器按名替换 section/context + 字节相同断言 + 新增对真实 `RuntimeContextProjection` 的去重实证，`worker-contract.spec.ts` 末例）。**PASS**。
- **A2-4（读取零副作用）**：冷/热查询与装配前后 store 事件数、gate 相位、spawn 数、stand-in body 记录、**approval 与 verifier 调用计数**全等（`context-assembly.spec.ts` 零副作用用例 + `context/tests/unit/side-effects.spec.ts`，后者结构性证明 context 可见的 runtime 面只有 `recoveryStatus`/`readRunBinding`/`gate.phaseOf`/`allowsRuntimeDecomposition`）；重启后首写受闸（`a3-recovery.spec.ts:1400-1478`）；普通/replay 首请求不依赖 spawn 后缓存（绑定只读持久事实，全 `context/src` 无 `runForSession`/`lookupRun` 调用）；R2 取消反例保留（`cancellation-gate.spec.ts` 两例全绿；第 2 例因果锚随子目标 1 删除读路径闸回填而重锚到唯一剩余的 store→gate 写路径——恢复屏障，交错/迟到写具名拒绝/闸保持 terminal 断言原样）。**PASS**。
- **A2-5（冻结 schema 与恢复门）**：三工具与 D 节逐字段一致（`task_read({})`、`task_status({scope,offset,limit})`、`context_read({kind,ref,offset,limit})`；review ref=`{taskId,runId|null}`；Task 类 offset=UTF-8 字节、session=DSH 事件 offset；`CONTEXT_OUTPUT_LIMIT_BYTES=16*1024` 唯一常量；核心契约超限具名 `context-too-large` 不静默裁剪）；reviewer 绑定失败零模型输入（`beforePrompt` 写+读回 ledger，失败 → dispose handle + 节点 failed + 零 followup：`agent-runtime/src/index.ts` spawn 失败分支；`context-assembly.spec.ts:406-432`、`agent-runtime/tests/unit/agent-runtime.spec.ts:789-808`）；恢复失败阻断新执行但诊断可读、重复激活不重复 driver、waiting_children 恢复不自锁、直接服务调用不能旁路恢复门（`a3-recovery.spec.ts:1369-1538`、`root-intake-recovery.spec.ts:600-609`、`graphs-lifecycle.spec.ts`）。**PASS**。
- **A2-6（迁移闭合，按调用链）**：旧位置无同一职责的生产实现/旧调用/同名转发（`renderWorkerPrompt`、`renderWorkerContract`、`task-runtime/src/contract.ts`、`contract-reinjection.ts`、runtime 侧 `renderRunBinding`、`root-store.ts`、`run-phase.ts`、task_read/task_status 旧跨记录渲染均删除；grep 全仓确认）；runtime 的执行绑定校验（`bindRunProviders`/`readRunBinding`）、持久 handoff（`buildHandoff`/`recordHandoffIn`）、恢复闸仍在原所有者；依赖方向：仅 agent-singularity 导入 context，task/task-runtime/agent-runtime 零反向导入。**PASS**。

## 实际检查（主代理实跑，2026-09-25；独立复核复跑 unit/integration 数字一致）

| 命令（cwd） | 结果 |
|---|---|
| `pnpm build`（packages/singularity） | 12 包全部通过（含新 context 包） |
| `pnpm vitest run --project unit packages/singularity`（外层） | 47 文件 / 1502 项全过（R3 基线 44/1461） |
| `pnpm vitest run --project integration packages/singularity`（外层） | 39 文件 / 285 项全过（R3 基线 38/268；含新 context-assembly.spec 与去重实证新例） |
| `pnpm run verify-persistence`（packages/singularity） | OK — 4 event roots 与 schema 一致（持久化格式零变化；reviewer ledger 格式未变） |
| `git diff --check`（packages/singularity） | 干净 |
| `pnpm exec tsc --noEmit`（agent-singularity） | 零错误 |

## 跨入口/组合反例

普通执行、replay、恢复、无 Run reviewer 四个装配消费者同批接线并各有反例（context-assembly.spec.ts a–f）；同 cwd 双 graph × 猜 id × 原始工具三面组合拒绝；取消窗口读 × 恢复屏障陈旧读；屏障失败/取消/重试（零 spawn、具名 recovery-failed、显式重试重登记）。拒绝路径均断言零意外写入/派发/审核副作用（store 事件数、gate 计数、spawn 数、approval/verifier 计数）。

## 既有复杂度处置（本票触及文件）

- `task-runtime/src/index.ts`（≈6.0k 行）：**保留**为 runtime 入口，按计划 E 节要求核对——本票只在其内落恢复屏障与执行闸相关改动，上下文投影未堆入（独立复核确认）；replay spawn 点改为 `taskWorker` 声明，渲染移出。
- `task-runtime/src/orchestrate.ts`（≈2.4k 行）：**保留**；spawn 点不再渲染 prompt/contract，持久 handoff 写入不变。
- `task-runtime/src/handoff.ts`：**删渲染留数据**（`renderWorkerPrompt`/`WorkerPromptOptions` 删除；`buildHandoff`/`HandoffInit` 保留）。
- `task-runtime/src/contract.ts`：**整文件删除**（渲染职责归 context）。
- `task-runtime/src/run-binding.ts`：`renderRunBinding` 文本半**迁出**至 `context/src/run-binding.ts`；物化/校验/准入保留。
- `task-runtime/src/gate.ts`、`capability.ts`：白名单/标签表更新（删三原始 session 工具与 `session-history` 标签，加 `context_read`），机制不变。
- `agent-runtime/src/contract-reinjection.ts`：**删除**（机制由 context 装配取代）；新增 `prompts/worker.prompts.ts`（稳定 worker 政策）与 `raw-session-guard.ts`（四工具执行封印），均为小文件。
- `agent-singularity/src/tools/`：`root-store.ts`、`run-phase.ts` 删除；`task-read.ts`/`task-status.ts` 瘦身为薄适配；新增 `context-read.ts`、`projected-read.ts`、`proposal-store.ts`。
- `context/`（新包）：`bindings.ts`(≈425)、`projections.ts`(≈1000)、`render.ts`、`assembly.ts`、`limits.ts`、`refusals.ts`、`not-activated.ts`、`run-binding.ts`。`projections.ts` 超 400 行触发检查：它按六个引用 kind × 四种角色的投影规则组织，每段有真实消费者（工具/装配），未再拆的依据是按职责分段而非按行数压缩。
- 留给后续票：`task-review-pack.ts` 的独立 binding 摘要（A5）；E 节审计表其余项按原安排随触及票处理（非本票范围）。

## 独立复核

执行者：未参与实现的独立子代理（只读复核 + 实跑 unit/integration 复现数字）。被审 SHA：`6735a34..0f41d91`（含 `4a510ed`/`f90d05b`/`0f41d91`）。结论：**A2-1～A2-6 与迁移删除全部 PASS，可交付待进度审核**。发现 9 项（D1–D9）：D1（文档同步）由本记录与配套 guide/计划更新关闭；D2（审批/verifier 计数）、D4（快照去重实证）、D6/D7（陈旧注释）由 `6e0f651` 关闭并回归通过；D3/D5/D8/D9 转为未覆盖/已知项（见下节），复核判断均不构成返工。

## 模拟与未覆盖范围

- 未做付费真实模型实验（本票合同明确确定性协议验证即可）；模型输出由 scripted provider/夹具替代，runtime/store/verifier/DSH 接线均为真实实现。
- D3：`agent-singularity/tests/unit/task-tools.spec.ts` 直调工具 `execute`（不经真实注册表/pre-execute）；工具面路径由 `context-assembly.spec.ts`、`worker-grant.spec.ts`、`a3-recovery.spec.ts`、`cancellation-gate.spec.ts` 经真实管道覆盖。
- D5：无「两次成功激活且存在在飞 waiting driver ⇒ 只 spawn 一次」专案用例；去重为结构性（driver 按 key 早返回 + adoptRoot join 在飞屏障），相邻形态（重试成功、重复 adoptRoot 已结算）有测试。
- D8：装配 section 插入位置为启发式（`AssembledSection` 无 order 字段）；已核对当前部署前置 section 集合无偏差。
- D9：`worker-contract.spec.ts` 判据命令经真实 command verifier 执行，文件耗时约 60s（断言不依赖该判决）。
- 子目标 2 交接注记：未激活视图的未决提案行用手搭 snapshot 单测（未经真实 `submitProposalIn` 构造）；单个 session 事件正文超 16 KiB 时按事件边界截断并显式标注；指向他图 store 的 task 类引用具名 `not-found`（成员/委派域不一致处才用 `cross-graph`）；context 包目录内 `tsc --noEmit` 剩 4 条 task/task-runtime 跨包声明同一性既有噪音（基线复现，非本票引入）。

## 未解决缺陷 / 阻塞

无已知合同违反；无阻塞。

## 最终验收结论与下一项

实现侧证据齐全、独立复核 PASS：**交付待进度审核**。「已验收」须由进度审核（`execution-prompts/progress-review-and-dispatch.md`）确认后填写；通过前不派第 11 项 A4。不推送、不部署。
