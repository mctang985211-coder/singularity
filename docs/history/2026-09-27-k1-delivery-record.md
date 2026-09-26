# K1 交付记录：子批次结束后继续探索（2026-09-27，待验收）

合同：`docs/execution-prompts/12a-k1-exploration.md`。基线：Singularity `41d45b5`、外层 harness `b4c7f99e29`（2026-09-26 修正前排期基线）。交付为六个提交：`3738712`（A 事实）→ `c212c35`（B driver）→ `2b424c9`（C 恢复/投递）→ `473c535`（D 工具/prompt/context/文档）→ `3ab5aac`（E 集成与验收 spec）→ `a17d0cc`（集成检查残留清理），外加主代理对外层未跟踪部署注释的同步（`.dsh/profiles/web/cordis.patch.yml`，不入提交）。

## 新行为一句话

批次结束（子全终态）→ 确认各子 Session 写入/受管理进程停止并归还工作区 → 父 Run 持久化 `waiting_children → active`（解除批次写闸，未决 blocking 问答仍单独阻塞）→ 父 Session 收到 `m-batchend-<batchId>` 结果消息 → 父读结果、继续工作、追加一批或 `task_submit_result`；只有父主动提交才做父独立验收。runtime 不再替父提交，Task 不再一生只分解一次。

## 验收编号 → 证据

| 编号 | 结果 | 证据位置 |
|---|---|---|
| K1-1 | 真实工具/DSH loop（scripted provider 只替代模型）：调查批结束父非终态回 active、收 `m-batchend-*`；父据结果派实施批（`requiresArtifact` 消费前批产物）、综合后主动提交，原父 composite+command verifier 判 verified；全程 0 次 `task_diagnose`/`evolution_*`，根 AC 与 intake 一致 | `tests/integration/k1-exploration.spec.ts`「carries one parent through an investigation batch and an implementation batch into its own acceptance」 |
| K1-2 | 在途第二批拒（工具面+runtime 双具名）；waiting_children 提前提交拒；同 requestKey 同内容回原批次、异内容具名拒绝零副作用；晚批准记 `expired`（重检 run/提案/批次状态）无消费无 spawn；空批次 `at least one child` 拒且零写入 | `k1-exploration.spec.ts` K1-2 三用例；单元 `task-runtime/tests/unit/proposal-lifecycle.spec.ts` |
| K1-3 | 两批局部 #0 在 run 累积序列为 0 与 2，互不混淆；批内读法/越界/错成员记录/失败成员引用均具名失败；后批合法消费前批产物；父独立 command AC 失败时成员全过仍 failed | `k1-exploration.spec.ts` K1-3 五用例；`tests/integration/parent-acceptance.spec.ts`（改写后回归） |
| K1-4 | 普通与 replay 各覆盖：批次结束持久化前重开（同批只执行一次：1 admission/1 TaskStarted/0 新 spawn）；active 已持久未唤醒重开（同 Run/Session 续，投递恰一次，二次 reconcile 不重复）；问答未解越过批次结束仍阻塞写；取消/截止交错不复活（终态投递 `skipped` 零副作用）；旧 `b-<taskId>` 批次具名停止不猜归属 | `k1-exploration.spec.ts` K1-4 五用例；`a3-recovery.spec.ts`、`a4-question-cold-recovery.spec.ts`（切片C改写+新增） |
| K1-5 | 根 maxRuns 跨两批累计（两批+根=3 run 后第三批具名拒绝），重开 store 不重置；源码/工具/schema/prompt 无自动父提交/一次性分解引导（切片D 清场+负向断言，集成检查子代理全 src 复核）；A4 问答与父独立验收回归全绿 | `k1-exploration.spec.ts` K1-5 两用例；回归：`a4-question-loop/recovery/cold-recovery`、`parent-acceptance` 随全量通过 |

## 源码锚（交付态）

- 事实（task）：`batchIdFor(parentRunId, proposalId)` `task/src/proposal.ts:610`；`TaskProposalBatchConsumption.parentRunId` 必填；`TaskDecomposed` 带 `batchId/parentRunId/proposalId`；`TaskRun.batches`（准入序）与 `runMemberTaskIds` `task/src/types.ts:413,516`；相位新边 `waiting_children→active`（带 batchId、回 active 清 `run.batchId`）`task/src/service/state.ts:675`；分解一次硬闸已删（原 `state.ts:350`）；consumption 绑定校验 `state.ts:1759`（旧形状具名拒绝）。
- childIndex：`CompositeTaskSource.runMembersIn` `verifier/src/composite-verifier.ts:25`（`verifyIn:313` 传 runId）；task 实现 `task/src/index.ts:223 runMembersIn`；旧 `childrenIn`/`decomposeIn` 已删。
- driver（task-runtime）：`finishBatch` `orchestrate.ts:2543`（子 drain→归还工作区→持久化 active→gate setPhase 保留 questionsBlocked→投递）；`owedBatchResults` `orchestrate.ts:2474`；批次结果身份/正文 `m-batchend-<batchId>` store 重投影 `orchestrate.ts:2378,2393`；`redeliverBatchResult` `index.ts:6852`（fold 幂等、终态 `skipped`）；`batchRecordIn` `index.ts:4987`（取消/失败/重投全部经 store 批次事实，无 id 解析）；同 Run 在途提案唯一 `index.ts:2716 inFlightProposalsOf`；`continueProposalIn` run 级重检；`submitResult` waiting_children 拒保留。
- 恢复（task-runtime）：`reconcileStore` 分派 `index.ts:5680-5775`——waiting_children 有批次记录→重建 driver、查不到→`stopUnidentifiedBatch` 具名 cancelled（:5027/:5703）；active 且 batches 非空的委派父→工作区接管门后 `resumeAdoptedWorker` 同 Run/Session（不走取消分支）；active 无批次叶子→原取消分支不变；欠投对账 `deliverBatches` :5929 + 屏障延迟（ready 后实投）+ `wakeUnclaimedBatchResults` :6087。
- 消费面（agent-singularity/agent-runtime/context）：`task-decompose`/`task-submit-result`/`task-proposal-*`/`task-intake`/`task-read`/`task-cancel`/`task-ask-parent` 描述同步；`root.prompts.ts` 批次段重写（交还执行权、父主动提交）；`context/src/projections.ts` 分解指导块（删 "split only once"）与 `render.ts`（`run member #N`）同步；无新增事实源。

## 删除位置（旧实现/旧断言，不保留兼容开关）

- `orchestrate.ts` 原 `settleParentBatch` 自动父提交尾段（`origin:'runtime'` SubmissionRecord、代提交 `changeRunPhaseIn(submitted)`、`settleSubmittedRun` 调用）与「未闭合问答留 waiting_children」分支；`redriveWaitingParent` 及其调用。
- `task-runtime/src/index.ts` 本地 `batchIdFor(parentTaskId)`；`cancelBatch`/`awaitBatch`/`failBatch`/`abortDescendantBatches` 的 `b-` 前缀/slice(2) 按 taskId 猜批次路径。
- `task/src/service/state.ts`「already decomposed」硬闸；`task/src/index.ts` `decomposeIn`/`childrenIn`（仅测试消费的旧入口，测试迁 `admitBatchIn`/`runMembersIn`）。
- prompt/工具/投影中的自动提交与一次性分解引导（切片D 清场，含负向断言防回归）；失效测试断言改写（18 个集成文件 + orchestrate/gate/proposal-lifecycle/coordination/proposal/task-state/task-tools/reads 等单测）。
- 集成检查复核追加（`a17d0cc`）：只写字段 `BatchContext.lineage`（唯一读者随切片B 删除）连声明带写入点删除；`SubmissionRecord` 文档改写为「worker=自提交；runtime=无 worker 的 criteria replay 出生提交」；`index.ts` 分解拒绝文案收紧为「批次结束交还 active 后才能再分解」。

## 持久化

`docs/persistence-changes/2026-09-26-k1-multi-batch.md`（判级 **version-bump**：consumption 新增必填 `parentRunId` 且 batchId 等式被替换，旧 `TaskProposalAdmitted` 记录在本 build 重放时具名拒绝；有红/绿测试）。无兼容 reader、无迁移层；旧 in-flight `b-<taskId>` 批次为停止使用的旧状态，恢复时具名停止。`pnpm run verify-persistence` 绿（4 roots）。

## 400 行以上触及文件的处置理由

- `task/src/service/state.ts`：保留——Task 事实唯一 reducer/原子提交所有者，本票只在其中改规则，不拆。
- `task-runtime/src/index.ts`、`orchestrate.ts`：保留——配置/handle/装配与批次 driver/结算的既有归属；`finishBatch` 原位替换 `settleParentBatch`，未新增平行路径。不以行数硬拆。
- 未迁出声明之外的职责；无同名转发层、无第二事实源。

## 必跑检查（集成检查子代理独立复跑，残留修复后再次全量复跑）

`pnpm build`（packages/singularity）0 错；`vitest run --project unit packages/singularity` → 57 文件 / 1751 用例全绿；`--project integration` → 55 文件 / 429 用例全绿；`verify-persistence` OK（4 roots）；`git diff --check` 干净；`agent-singularity` `tsc --noEmit` 0 错误；build 后 lib 跟踪产物与源码同步。以上在残留修复（`a17d0cc`）后原样复跑，结果不变。确定性 provider 仅替换模型；未跑收费模型，不声称探索效率改善。

## 未覆盖项 / 已知边界

1. `tests/support/scripted-loop.ts` 不支持多 root spawn（第二 root 子树不起 turn）：K1-3 的「跨 graph 引用」反例改由同 store 错成员记录 + `context-assembly.spec.ts` 域隔离 + verifier 单测共同覆盖；跨 graph 端到端证据待夹具能力。
2. verifier composite 错误文案仍写 `child #N`（注释已注明 run 累积成员语义）；工具侧已统一 `run member #N`。
3. 委派父恢复时工作区接管失败的具名 failed 分支（`index.ts:5797`）无直接集成用例（恢复 spec 不解析真实工作区）。
4. replay driver 根自身的跨重启续跑仍属 A6/S2-R 既定边界；本票只覆盖 replay 树内父子。
5. 外层 `.dsh/m8-config-probe1/2.yml`、`m3-config-pre-apply.yml` 为未跟踪历史探针快照，其中旧注释保持原样；live 的 `cordis.patch.yml` 注释已同步（未跟踪，不入提交）。
6. composite 判据先判成员合取、后具名映射（verifier 既定顺序）；K1-3 失败成员用例按此断言。

## 移交后续票

K2/K3/K4 依赖的接口已固定：批次身份 `(parentRunId, proposalId)`、Run 累积成员序列、`finishBatch` 交还语义、`redeliverBatchResult` 幂等重投、恢复分派表。A6 恢复入口按 F.4 复用上述身份与成员序列，不另造状态机。
