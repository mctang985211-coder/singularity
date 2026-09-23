# P3 / P4 完善交付记录（2026-09-17 夜）

> 历史交付记录；这里 P3/P4 是早期 RFC 阶段编号，不是后来的同名执行票。工具名单、源码坐标和工作树状态只描述当时。当前状态见 [工作指南](../singularity-harness-guide.md)，旧缺口编号见 [历史指南](2026-09-21-harness-guide-snapshot.md)。

本记录说明本轮在 **P3（能力真授权）** 与 **P4（Review 记录）** 上补了什么、为什么这样做、验证到什么程度、还差什么。

**一句话**：`capability` 声明的 `tools`/`skills` 从"只记账"变成**真的作用于被 spawn 的 worker**；`ReviewRecord` 从"只有终态与判据"扩展为**八维机械观测事实 + 五项可得的工程量指标**（六项里有一项没有可信来源，故意不记）。两处都保持轻量：不引入 LLM 评判、不新增事件类型、不引入新依赖。

---

## 0. 范围与边界

- 本轮**只做 P3 / P4**。P5（Evolution）由另一个进程同时在进行，本轮**一个字未碰**下列文件（mtime 可证）：

| 冻结文件 | mtime（本轮开工前） |
|---|---|
| `agent-singularity/src/evolution.ts` | 2026-09-17 22:09 |
| `agent-singularity/src/tools/evolution-*.ts` | 15:50–15:56 |
| `tests/integration/evolution-tools.spec.ts` | 20:01 |
| `docs/singularity-harness-guide.md` | 21:41 |

- **全部改动未提交**：工作树 `56 M / 2 D / 21 ??`。原因是并发写者（P5）的进行中改动会被 `git commit -a` 一起扫进来，所以本轮刻意不提交。
- 未重启、未 kill 任何进程（`./dsh web` 在 pid 1882925 上继续跑）；未执行 `tools/scripts/install-all.sh`；未跑 `verify-persistence --write`。

---

## 1. P3：capability 的 `tools` / `skills` = 真授权

### 1.1 机制与落点

| 文件 | 角色 |
|---|---|
| `agent-runtime/src/grants.ts`（新） | 授权执行点。`resolveGrant`（`:94`）算 allow 清单；`applyWorkerGrant`（`:176`）在未发布窗口调 `agentCtx.tools.restrict({ allow })`（`:181`）再授予技能 |
| `agent-runtime/src/skill-file.ts`（新） | `SKILL.md` 的解析与定位：`parseSkillFile`（`:68`）、`findSkillFile`（`:136`）、`readSkillFile`（`:160`） |
| `agent-runtime/src/types.ts` | `WorkerCapabilityGrant`（`:39`）、`WorkerGrant`（`:53`）、`SpawnRequest.grant`（`:82`） |
| `agent-runtime/src/index.ts:250` | 接入点：`agentPresets.mount` → `permissionPresets.set` **之后**调 `applyWorkerGrant`（此时 preset 的行已在继承面上，可被 restrict） |
| `task-runtime/src/capability.ts` | 标签→真名映射与校验：`TOOL_LABELS`（`:48`）、`resolveToolLabels`（`:69`）、`WORKER_BASELINE_LABELS`（`:100`）、`workerBaseline`（`:118`）、`resolveCapabilities`（`:136`，准入期展开） |
| `task-runtime/src/index.ts:441` | 把 `request.grant` 透传给 `agentRuntime.spawn` |
| `agent-singularity/src/tools/capability-list.ts` | 输出真实授权面：label→真名、baseline 全量、四条图例（fail-closed / 技能不可隐藏 / 权限姿态） |

**allow 清单的构成**（`grants.ts`）：能力的工具面 ∪ baseline ∩ 当前可见面 ∪（该能力自带 preset 时保留 preset 自己的工具面）。

- 末项是**有意的取舍**：`bb-verify` 这类 preset 注册的工具（`buckyball_bbdev_*`）在另一个仓库里、我们无法枚举，纯 allow 会把它们全部剪掉、能力当场变瘸；`research: { preset: standard }` 同理。判据是"能力自己点了 composition = 该 composition 就是授权"。骑默认 preset 的能力只拿声明 + baseline。

### 1.2 标签 → 真 DSH 工具名（`capability.ts:48`）

| label | 真名 | 上游注册源 |
|---|---|---|
| `filesystem` | `read`, `write`, `edit` | `fs/tool-fs` |
| `search` | `glob`, `grep` | `fs/tool-fs-search` |
| `bash` | `bash` | `shell/tool-bash` |
| `jobs` | `job_output`, `job_list`, `job_kill` | `jobs/tool-jobs` |
| `skill` | `skill` | `skill/tool-skill` |
| `session-history` | `session_event_read`, `session_event_trace`, `session_trace` | `session-query/tool-session-query` |
| `ask-user` | `ask_user_question` | `interaction/tool-ask-user` |
| `web` | `web_fetch`, `web_search` | `web/tool-web` |
| `todo` | `todo_write` | `todo/tool-todo` |
| `goal` | `get_goal`, `create_goal`, `update_goal` | `goal/tool-goal` |
| `subagent` | `subagent`, `subagent_fork`, `send_message`, `interrupt_agent`, `list_agents` | `subagent/tool-subagent*` |

- **准入期硬校验**：未知 label 在 `task_decompose` **之前**抛错并列出词表（`capability.ts:74`）→ 整批拒绝、零持久化，不会拖到 spawn 才炸。
- `read_image` **故意不放进 `filesystem`**：它只在挂载 `attachments` 时才注册，写进 label 会让每个文件类能力依赖一个它从未声明的面。

### 1.3 worker baseline（16 个真名）及依据

`read, write, edit, bash, job_output, job_list, job_kill, glob, grep, skill, session_event_read, session_event_trace, session_trace, ask_user_question, task_decompose`

依据来自 **worker 自己的 prompt**（`task-runtime/src/handoff.ts`），不是拍的：验收命令要 `bash`（`:108`）、长跑要 `job_output`/`job_kill`、改代码要 `read`/`write`/`edit`、定位要 `glob`/`grep`、取回父会话上下文要 `session_event_read`/`session_trace`（`:100`）、需要人决策走 `ask_user_question`（`:109`）、可分解子任务要 `task_decompose`（`:68`，叶子拿到也无害——准入按 `decompositionStatus` 拒绝）。

### 1.4 明确不做 / 做不到

1. **技能只能"授予"，不能"隐藏"**。DSH 没有 per-agent 隐藏技能的 API（`skill-filesystem` 以 rank 200 扫描 `.agents/skills`，对所有 agent 可见）。我们做到的：把声明的技能注册进**该 worker 自己的 skill layer**（只对该 agent 可见、正文精确），做不到：让目录里只剩授权项。这条边界写在 `grants.ts:20-26` 与 `capability_list` 输出里，**不假装做到了**。
2. **权限默认姿态故意不翻**：所有 worker 仍是 `danger-full-access`。机制已接线（capability `permission` → 最严者胜 → `permissionPresets.set`），但一旦翻成 approval=ask，无人值守时 HITL 请求到不了画布（指南 §4.2 #17），worker 会直接挂死。策略留给人。
3. **baseline 缺失项静默丢弃**（composition 没挂载的工具本来就拿不到）；只有 capability **自己声明**的工具缺失才是硬报错。
4. **`graph_spawn` 的 setup worker 没有授权轴**：它的 prompt 要 `bash` + `env_register_component` + 长跑安装，按 baseline 限制会把它剪瘸，需单独决策。

---

## 2. P4：ReviewRecord 的八维 + 六项工程量指标

### 2.1 本轮的解释性裁决（请复核）

素材对八维只给了两个"至少包含"的清单，并且**明确否定打分表形态**（`细化想法3.md:11-37`：`skill_fit = 0.41` 告诉不了 evolution agent"为什么"；`细化想法4.md:1086`：Review 要回答"哪个组件为什么导致结果"），从未给任何一维评分口径。

因此本轮把八维实现为 **可机械观测的事实**：无评分、无 LLM 判断、无 transcript 正文；每一维只记能从现有数据推导出的量，**推不出来就整维省略**。为什么仍在 `Diagnosis`（§2.7.3）里，这里不重复。这样既满足"至少含八维"，又守住 §4.3 已裁决的"无评分、不养常驻 reviewer"。

### 2.2 新增字段

`ReviewRecord`（`task/src/types.ts:420`）新增两个**可选**字段：`dimensions?`（`:444`）、`metrics?`（`:446`）。

- `ReviewDimensions`（`:340`，每维本身可选）：`outcomeCorrectness` / `taskSpecification` / `acceptance` / `decomposition` / `capabilityCoverage` / `skillFit` / `toolFit` / `contextEfficiency`。
- `ReviewMetrics`（`:374`）：`tokens?` / `toolCalls?` / `humanInterventions?` / `retries?` / `evidenceLogs?`。

### 2.3 八维：数据来源 → 推导 → 何时省略

| 维 | 来源 | 推导（纯机械） | 省略条件 |
|---|---|---|---|
| outcome correctness | 本次 `outcome` + `criteria` | 抄终态；未达标判据 id 列表 | 不省略 |
| task specification | `taskIn()` 的 objective / criteria | objective 非空、判据条数、带 command 的条数 | 不省略 |
| acceptance | 同上 | 逐条 mode / hasCommand / mandatory | 不省略 |
| decomposition | `taskIn()` + `snapshotIn().edges` | depth、decompositionStatus、子任务数、入/出边数 | 不省略 |
| capability coverage | `snapshot.capabilities[taskId]` | closure / missing / granted | manifest 未落盘 |
| skill fit | manifest `skills` + 会话里的 `skill` 调用 | granted / loaded / loadedOutsideGrant | 无 manifest；或读不到日志时只留 granted |
| tool fit | manifest `tools`（准入期已展开）+ 会话工具调用 | granted / called(name,count) / calledOutsideGrant（减 baseline） | 同上 |
| context efficiency | 会话 token 投影 + compaction | tokens、compactions | 两者都取不到（避免 `{}` 占位） |

### 2.4 六项指标：取数路径与已知局限

| 指标 | 取数 | 局限（已写进 JSDoc） |
|---|---|---|
| `tokens` | `sessionProjections.snapshot(session, ['tokenUsage'])`（上游 `token-meter` 的 `tokenUsage` 投影，4 个桶） | **root 会话是长驻的，这是全会话累计、不是 per-run，系统性偏高**；取不到就省略 |
| `time` | **不重复造**：顶层 `durationMs` 仍在（run `startedAt` → 终态迁移，含验证） | `metrics` 的 JSDoc 明说 time 为何不在里面 |
| `toolCalls` | 一次会话日志读取：`tool/call` 计数 + `tool/result` 失败计数 | DSH 没有宿主投影，是日志派生；读不到就省略 |
| `humanInterventions` | 同一遍日志：`approval/asked` + `hitl_ask`/`hitl_approve`/`ask_user_question` 的 tool/call（按 `callId` 去重，`hitl_approve` 会同时产生 approval 事件） | **会话作用域归因**：worker 只有 `ask_user_question`，`hitl_*` 是 root 工具，整棵树的介入次数挂在 root 的记录上；子任务记 0 不等于"没人介入过" |
| `retries` | `TaskInstance.runIds.length - 1` | **当前编排器没有 retry 分支，结构性恒为 0**；读取者不得据此推断"重试过、没重试"。无 run 时省略 |
| `evidenceLogs` | `criteria` 中带 `logRef` 的条数 | 以实际度量命名，**不叫 artifactCount** |
| ~~`artifactCount`~~ | **未建，故意不记** | `ArtifactRef` 在仓库里没有生产者，`run.artifacts` 生产恒为 `[]`——记它等于伪数据 |

### 2.5 采集落点与"绝不让 review 失败"

- 唯一 chokepoint：`task-runtime/src/orchestrate.ts` 的 `recordReview`（`:426` 取 enrichment，`:441-442` 注入两个可选字段）。
- 新增可选 seam `OrchestrateEnv.observeSession?`（`:130`），实现落在 `task-runtime/src/index.ts`（`observeSession` `:555`、`sessionTokens` `:607`、软解析 `ctx.get(...)`）。**`orchestrate.ts` 保持零 cordis 依赖**，单测可注入桩。
- 整个组装包在 try/catch 里：任何读取失败退化为**省略字段**，绝不让 review 写入失败（`:323-325`）。
- 渲染：`agent-singularity/src/tools/task-review-pack.ts` 的 `renderMetrics`（`:40`）/`renderDimensions`（`:58`）/`renderReview`（`:107`），并把"会话口径""恒 0"直接打在行内防误读；**不塞 transcript 正文**。

### 2.6 持久化类型纪律

- 定性：**`same-version`**。摘要覆盖的是"事件名 + 载荷类型文本"，`ReviewRecord` 是被传递引用的类型，加**可选**字段不动指纹。
- 动作：新建 `docs/persistence-changes/2026-09-17-reviewrecord-metrics.md` + `.schema.json`（体例逐字照抄 `…-reviewrecord-selfcontainment`，`previous == after == 196cc188ad…a861`，decision `same-version`，并写明故意不记 `time` 与 `artifactCount` 的理由）。
- 未跑 `--write`（`docs/persistence-schema.json` 可能有并发写者）；`--check` 保持 OK。

---

## 3. 验证（本轮实测，可复现）

| 检查 | 本轮结果 | 本轮开始前的基线 |
|---|---|---|
| `pnpm build` | **exit 0** | exit 0 |
| `vitest run --project unit` | **358 passed / 50 files** | 354 / 50 |
| `vitest run --project integration` | **102 passed / 20 files** | 100 / 19 |
| `node scripts/verify-persistence.mjs --check` | **OK — 4 event roots match** | OK |

测试是有牙的，不是"能编译"：

- **P3**：`tests/integration/worker-grant.spec.ts`（6 例）真实 `ctx.plugin` + scope 面，断言 restrict 后 worker 可见工具面确实变了、baseline 仍在。实现期间做过反向验证：临时注掉 `applyWorkerGrant` 调用后 6 例中 5 例失败（对照组照常通过），已还原。
- **P4**：`tests/integration/review-metrics.spec.ts`（2 例）把 `task/event` **从 store 里读回来**断言，而不是看写入方参数；覆盖 `toolCalls {calls:5, failures:1}`、`humanInterventions: 2`（证明 `callId` 去重生效）、`calledOutsideGrant`、`retries: 0`、`evidenceLogs`，并断言序列化结果不含 `score`/`rating`/`grade`/`confidence`。token 折叠跑的是**上游真实现**并比对字面量，避免"预期=自算"的循环论证。
- 新增单测：`agent-runtime/tests/unit/grants.spec.ts`（13）、`agent-runtime/tests/unit/skill-file.spec.ts`（6）、`review-record.spec.ts`（+3）、`task-tools.spec.ts`（+1 与反向断言）。

---

## 4. 需要人裁决的点

1. **八维实现为"机械事实"**是否符合你对素材的意图（备选：只记你能机械得到的 4 维，其余明确留白）。
2. 素材 `细化想法4.md:993-1018` 的 `ReviewRecord` 有**第 9 个桶 `efficiencyReview`**；我们把"工程量指标"并入 `metrics` + `contextEfficiency`，是否认可。
3. `retry count` 的语义：task 级（本轮记的，恒 0）还是 LLM 级（`llm/retry`，会非零）？
4. 技能"只能授予、不能隐藏"是否接受；若要隐藏，需要推上游支持 per-agent skill 作用域。
5. `graph_spawn` 的 setup worker 要不要也纳入授权轴。

---

## 5. 与 P5 的边界、后续

- 本轮**没有**更新 `docs/singularity-harness-guide.md`（P5 正在改它）。待 P5 落地后需要把两件事并进指南：§2.4 能力（真授权已落地）、§2.7.2（八维不再是"未建"）、§4.2 #1/#4 的状态、§4.3 第 1 条的执行结果。
- 建议顺序：**P5 完成 → 指南合并 → 提交本地检查点**（工作树现在 56 M / 2 D / 21 ??，全是绿的，放着不安全；但必须等并发写者停下再提交，否则会把它的半成品一起提交）。
- 仍 open 的 P3/P4 侧欠账：`artifactCount` 需要先有 `ArtifactRef` 的生产者；真机回放验证（本轮只到桩级 + 真实 API 形状核对，未在 `./dsh web` 上跑）。

---

## 6. 复现命令

```bash
cd /home/ROXY/code/bb_work/harness/packages/singularity && pnpm build
cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run --project unit
cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run --project integration
cd /home/ROXY/code/bb_work/harness/packages/singularity && node scripts/verify-persistence.mjs --check
```
