# K1 返工记录：交还顺序、批次成员事实与两条真实入口证据（2026-09-27，待验收）

合同：[K1](../execution-prompts/12a-k1-exploration.md)、[公共合同](../execution-prompts/README.md)。返工前基线：Singularity `1bf89a0`（标签 `baseline-k1-rework-20260927`）、外层 harness `bf000ae37b`。返工交付：`d86c9fd`（源码/测试/lib）→ `f9589e9`（本记录与 guide/计划同步）→ `b2c12b6`（测试 jobs 回调显式类型，消除新增 tsc 隐式 any；task-runtime 既有基线错误数保持 8）；外层 harness 子模块指针为同批提交。原[交付记录](2026-09-27-k1-delivery-record.md)保持原样；本记录取代其中“未覆盖项”1、3。

## 逐条复现 → 修改 → 修后结果

### 1. `finishBatch` 先归还工作区、后确认子停止（固定行为 2）

- **复现**（我复核）：把 `task-runtime/src/{orchestrate,index}.ts` 临时换回基线源码、运行新用例 `orchestrate.spec.ts:3925`，得到 `expected { kind: 'run', … } to match object { kind: 'batch', … }` —— batch 层在子 drain 之前就被弹掉，父 Run failed 时连父自己的 run 层也被释放，marker 消失：工作区在“子写入未确认停止”时已被交还。
- **修改**：`finishBatch`（`task-runtime/src/orchestrate.ts:2512` 文档顺序、`:2559-2672` 实现）把 batch 层的归还移到**子 drain 与父 drain 都确认之后、`waiting_children → active` 持久化之前**；两条未确认分支（子、父）具名结算父 `failed` 并**保留 batch 层**，不持久化相位、不开闸、不投递。取消、截止、“父已被他人结算”三条终态清理仍按原语义先归还再结束（取消仍是 `cancelled`，绝不唤活终态），文档注释同步。
- **修后结果**：`orchestrate.spec.ts:3925`（未确认 → 保留 batch 层、marker 名 batch、父 failed/waiting_children、闸仍拒写、无 `m-batchend-*`）、`:3984`（确认后归还 → marker 名父 run 层、父 active、闸放行、消息恰一次）、`:4023`（取消回归：父 cancelled、栈与 marker 全清）。

### 2. 当前批次操作消费其持久成员；缺记录/读失败具名失败

- **复现**（我复核）：基线源码下运行 `orchestrate.spec.ts:4967`，`awaitBatch` 对“父 Run 读失败”的批次**不 reject 而是 resolve**（返回第一批 verified 成员 + 第二批成员的结果表）；其余反例由子代理在基线源码上同样记录（见子代理分工）。
- **修改**（`task-runtime/src/orchestrate.ts`、`task-runtime/src/index.ts`）：
  - `batchItems` 改按批次成员构造（批内位置），调用方 `driveRounds`/`convergeAdmission`/`blockUnstartedChildren` 全部改为该批次记录的成员；`failParentRun.relatedTaskIds` 记批次成员。
  - `batchMembers` 缺记录改为具名 throw；删除纯透传 `membersOf`；`finishBatch` 删除 `?? items.map(...)` 回退；`driveBatch` 删除吞读错的 `try/catch` 与 `.catch(() => [])`（成员不可读时 driveBatch 以具名错误拒绝，由 `registerDriver` 的 belt 结算）。
  - `deriveChildOutcomes` 的成员参数改为必填，删除“缺成员→父 Task 全部历史子”回退；`awaitBatch`/`redeliverBatchResult` 改为消费 `batchRecordIn` 返回的成员；`batchRecordIn` 把 store 读失败与“批次未记录”分开（不再 `catch → undefined`），并一次性返回成员。
- **修后结果**：`orchestrate.spec.ts:4967`（读失败 → `awaitBatch`/`redeliverBatchResult` 具名 reject；恢复后可读回记录）、`:4784`（读失败具名、belt 阻塞未启动成员、不误报旧成员）、`:4841`（失败记录的 `relatedTaskIds` 只含本批成员）、`:4933`（Run 记录不含该批 → 具名拒绝，不再 `[]` 收尾）、`:4901`（两批正例：各自消费自己的成员、消息只带本批成员）。

### 3. K1-3 跨 graph 引用与 K1-4 写入接管失败：补真实入口证据

- **复现/缺口**：原交付记录“未覆盖项”1、3 承认两条只有替代测试（同 store 错成员 + `context-assembly` 域隔离 + verifier 单测；接管失败分支无直接集成用例）。
- **修改**：新增 `tests/integration/k1-graph-boundary.spec.ts`（5 例），复用多 graph 夹具 `tests/support/assembly-stack.ts`（真实 JSONL store、TaskRuntime/driver、VerifierRegistry、工具面；仅模型为 stub）：
  - K1-3：g2 经真实 command verifier 产出真实 evidence；g1 父的 composite 判据 `childEvidence.evidenceRef` 指向该跨 graph 记录 → 父提交 `failed`，store 内判据 `fail` 且点名成员与缺失引用；同一 id 在 g2 经 `context_read` 可读、在 g1 具名 `not-found`；store B 前后逐字节一致、g1 无该 id 的 artifact/claim。正控：同 boot 同流程、条目指向成员自身判据 → `verified`。
  - K1-4：真实驱动出“非根委派父 `active` 且批次已结束未提交”，真实 marker + `adoptRoot` 恢复 → 该 run 具名 `failed`（`index.ts:5792-5802` 分支原文）、不唤醒、不 spawn、不复活；另两例：marker 指向**另一存活 pid**（经 `WorkspaceRegistry` 注入 pid 写出）同一具名停止；无 marker 时接管门放行（差分证明 marker 是停止原因）。
  - 夹具：`assembly-stack.crash()` 先过持久化屏障再关句柄；新增 relayed 记录（包装真实 `ensureAgentMessageDelivered`）。
- **修后结果**：5 例全绿（连续四次运行稳定）；`context-assembly`、`worker-contract` 等 5 个既有装配类 spec 同跑 39 例全绿。

## 删除清单（无兼容开关、无第二路径）

- `orchestrate.ts`：`membersOf`（纯透传）；`batchMembers` 的 `undefined` 返回；`finishBatch` 的 `items` 参数与 `?? items.map(...)` 成员回退；`driveBatch` 的成员读取 `try/catch` 与 `.catch(() => [])`；`deriveChildOutcomes` 的 `memberTaskIds ?? parent.childTaskIds` 回退与可选参数；`batchItems` 的“父 Task 全部历史子”来源；`failParentRun` 的 `parentTask.childTaskIds`。
- `index.ts`：`batchRecordIn` 的 `catch { return undefined }`（读失败原样上抛）与调用方的 `?.find(...)?.memberTaskIds` 二次查找；`blockUnstartedChildren` 的 `parentTaskId` 参数与缺失父任务的静默 `[]`。
- 未新增 helper/兼容分支；`settleRunFromRuntime` 的 run 级 `relatedTaskIds` 保留（无批次身份的通用结算入口），理由见下。

## 公共必跑检查（集成后全量实跑）

| 检查 | 结果 |
|---|---|
| `pnpm build`（packages/singularity） | exit 0；`task-runtime/lib` 跟踪产物同步（随源码提交） |
| `pnpm vitest run --project unit packages/singularity` | 57 文件 / 1759 用例全绿（基线 1751；新增 8 例） |
| `pnpm vitest run --project integration packages/singularity` | 56 文件 / 434 用例全绿（基线 55/429；新增 1 文件 5 例） |
| `pnpm run verify-persistence` | OK — 4 event roots 与 schema 一致 |
| `git diff --check`（含暂存与新增文件） | 干净 |
| `agent-singularity` `pnpm exec tsc --noEmit` | exit 0，0 错误 |

## 未覆盖项（对照合同排除）

1. replay driver 根自身跨重启续跑仍属 A6/S2-R 既定边界（合同 §5 明示，本票只覆盖 replay 树内父子）。
2. 接管失败用例只证明具名 `failed` 分支与接管门差分；装配夹具的 spawned session 无持久日志，接管**成功**后的正向续跑不在该夹具可达（该正向路径由 `k1-exploration.spec.ts` 的 JSONL 重开窗口覆盖）。
3. `settleRunFromRuntime`（run 级取消/恢复通用入口，无批次身份）的 `relatedTaskIds` 仍按该 Run 所属 Task 的子列表；批次内操作已全部改为批次成员（本记录“删除清单”），此为明确保留并给理由的 run 级语义。
4. K1-3 用例的 g1 根经 `intakeRootContract`/`decomposeAndRun`/`submitResult` 服务入口驱动（与工具同一实现）；工具面本身由 K1-1 的真实 DSH loop 覆盖。

## 子代理分工

| 子目标 | 子代理与范围 | 交接要点 |
|---|---|---|
| 批次成员事实 | ① 一批次成员：删回退/透传（orchestrate/index + 单测） | 基线失败记录、5 例新增、删除锚、保留项理由 |
| 真实入口证据 | ② 跨 graph 与接管失败证据（新 spec + assembly-stack 夹具） | 5 例新增、夹具改动与爆炸半径、差分对照 |
| 交还顺序 | ③ `finishBatch` 顺序与真实 workspace/gate 测试（orchestrate + 单测） | 先红后绿、取消回归、取消/截止清理保留理由 |

主代理负责：基线、集成、独立复现（①/③ 各一次，换回基线源码复跑后按 md5 还原）、全量检查、删除清单核对、两个 guide 同步与本记录、提交。
