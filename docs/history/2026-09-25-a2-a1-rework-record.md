# 第 9 项 A2+A1 定向返工记录（2026-09-25）

> 结论摘要：**Q1、Q2、Q4 关闭并经红/绿反例复现；Q3 的两条子项中“中途读失败不得伪装成完整页”已关闭，“单个事件超过 16 KiB 后仍可续读”在冻结 `context_read` 四参数下不可表达，按[返工 prompt](../execution-prompts/09-a2-a1-review-rework.md)的要求报告最小合同冲突并**保持返工**。A2-1～A2-6 既有测试、R2 取消交错、重启首写闸与旧数据行为全部保留且复跑通过。整票状态以[建设计划文首唯一表](../2026-09-20-vrtc-code-change-plan.md)为准。

| 字段 | 内容 |
|---|---|
| 状态 | **返工（Q1/Q2/Q4 关闭；Q3 一子项为冻结接口冲突）** |
| 执行 agent | 实现主代理（Kimi Code CLI 会话）+ 1 个缺陷组子代理（Q3/Q4，独立文件所有权，未参与 Q1/Q2 实现）+ 1 个独立复核子代理（审计 `bee6a96`，只读） |
| 任务链接 | [定向返工 prompt](../execution-prompts/09-a2-a1-review-rework.md)；合同：计划 D/E 节、[进度审核 Q1–Q4](2026-09-25-a2-a1-progress-review.md) |
| 开始日期 | 2026-09-25 |
| 被审基线 | Singularity `0fc8bc6`（`wip/task-runtime-20260917`）；外层 harness `87260b857f`；DSH thirdparty `0d1f50007f`（两仓修改前工作区干净，无 AGENTS.md） |
| 交付版本 | Singularity `bee6a96`（实现+测试+构建产物）+ `6ae5aa0`（独立复核响应：store 缺失判定、页面收尾行保留、非有限分页输入、成员读取失败及对应反例） |
| 前置验收记录 | 第 8 项 R1、第 8a 项 R3 已验收（提交与唯一表核对一致，见原[交付记录](2026-09-25-a2-a1-delivery-record.md)）；本组前置即本次审核判返工 |

## Q1：模型请求必须有可信契约

**原反例**：`bindings.ts` 用 `catch { graph = undefined }` 吞掉 graph 查询异常，已绑定 worker 被误归为 unbound；`assembly.ts` 对 `unbound` 一律放行，缺契约即进入模型；已运行 reviewer 的 ledger 冲突/不可读也走同一放行分支。

**修复（`bee6a96` + `6ae5aa0`）**

- `graphs/src/index.ts:50-67` 新增可区分的注册表事实 `SESSION_NOT_IN_GRAPH` / `SessionNotInGraphError`（消息与原先一致），`graphForSession` 在“无图发布该会话”时抛它。
- `context/src/bindings.ts:363-373`（`graphOfSession`）把这个**事实**与**读取失败**分开：只有该错误码是“没有图”，其余异常（注册表就绪失败、图 store 读失败等）是具名 `unreadable` 失败。
- `context/src/bindings.ts:180-215`：`CallerUnbound` 新增 `placement: 'outside' | 'failed'`。`outside` 仅用于“任何图都不发布它且无委派记录”；成员 store 不可读、ledger 冲突/不可读、委派无法落图、注册表查询异常全部是 `failed`；“store 报不存在”按图 store 自己的 spawn 边区分（见独立复核发现 1）。
- `context/src/assembly.ts:157-170`：`unbound` 不再无条件放行；`failed` 抛 `AssemblyRefusalError`（名字即 refusal），`outside` 与无 agent 的诊断组装保持原行为。
- `context/src/bindings.ts:319-336`（`reviewerFailure`）：ledger 源的失败按其**契约形状**（`name` + `kind`）识别，而不是只按类身份，因为该 seam 由别的包实例实现（src/lib 两份类身份会让具名冲突退化为 `unreadable`）。
- ledger 与“会话自身有 Run”的边界：有本 run 的会话由 run 绑定，文件级 ledger 不可读不会让整批 worker 停摆；但任何**点名该会话的冲突行**（`binding-conflict`）仍拒绝。该边界写在 `bindings.ts` 的注释里，供审核判断。

**红/绿证据**

- 单测（`context/tests/unit/binding.spec.ts`，新 describe `a binding failure is not "outside the deployment" (Q1)`）：在 `0fc8bc6` 的解析器上 5 例全红——`expected undefined to be 'outside'`、`expected 'unbound' to be 'unreadable'`、三处 `expected undefined to be 'failed'`；修复后全绿。
- 装配集成（`tests/integration/context-assembly.spec.ts`，新 describe `a binding that cannot be read refuses the request (Q1)`）：3 例在修复前全部得到“assembly 没有拒绝”（`expected the assembly to refuse by name, got undefined`），修复后 `unreadable` / `unreadable`（重启后首请求）/ `unreadable`、`binding-conflict` 具名拒绝；同批断言工具门（`task_read`/`task_status`/`context_read`）返回同一名字，且不再出现契约正文。
- **零模型输入**（`tests/integration/context-binding-zero-input.spec.ts`，真实 DSH loop + 真实装配 + 计数 adapter）：2 例在修复前红——被误判为 unbound 的 worker 请求真的发给了 provider（等待具名拒绝超时，`expected 0 to be greater than 0`），修复后 worker 的 `requestsOf` 为空、root 第二个请求数停在修复前的计数；loop 记录的 `agent/error` 是 `AssemblyRefusalError`（`unreadable`）。
- 真实 ledger 集成（`context-assembly.spec.ts` 同 describe）：真 reviewer 由 `task_review_agent` 正常发布并可装配后，把 `agents.jsonl` 写成半行 → 装配与 `task_read` 均具名 `unreadable`；再追加一行同会话冲突记录 → 具名 `binding-conflict`。

## Q2：reviewer 委派者归属

**原反例**：只比对 ledger 的 root store，未核实 `actor` 属于该 graph，他图 actor 的记录仍授权读取整域。

**修复**：`context/src/bindings.ts:449-500`（`reviewerOf` 内的 `delegatorStanding`）：委派者必须是**被委派 graph 实际发布的成员**（`graphs.view` 的成员表，与会话引用检查同源）。他图 actor → `cross-graph`（详情点出所属图）；任何图都不发布的 actor → `unbound`；成员表读取失败 → `unreadable`。三者都使 reviewer 失去该 graph 读取域（`placement: 'failed'`），模型/用户传入的 id 不参与授权。

**红/绿证据**

- 单测（新 describe `a delegation must come from a session of the graph it delegates into (Q2)`）：合法正例（`s-root` 作为委派者）红绿均通过（修复未收紧合法路径）；他图委派者、未知委派者、成员表不可读三例在 `0fc8bc6` 上全部拿到 `review-only` 契约（红），修复后分别 `cross-graph` / `unbound` / `unreadable`。
- 集成（`context-assembly.spec.ts` 新 describe `a delegation is only believed from the graph it delegated into (Q2)`）：真 reviewer 真发布后，仅把 ledger 行的 `actor` 改成另一图已发布成员 `s-other-worker`（store 未变，故 store 检查抓不到）→ 装配 `AssemblyRefusalError(cross-graph)`，`context_read` 拒绝且不出现委派任务正文；该图的 session 引用同样拒绝。

## Q3：Session 详情不可丢

**修复（`context/src/projections.ts`，`sessionRead`）**

- 中途失败（`projections.ts:975-990`）：第一窗口之后的任何 `readEvent` 失败返回具名 `unreadable`，详情给出失败 seq 与“没有返回局部事件”；``SESSION_QUERY_ABORTED`` 仍原样抛出；首个窗口保留原 `stale-reference`/`unreadable` 映射。
- “窗口不前进”（`:999-1008`）：查询层在没有未读事件时也不前进（空窗口）→ 具名 `unreadable`，不再返回 `hasMore: true` 的空页。
- 大事件（`:1015-1030`、`:1065`、`:1075`）：整块事件先量后加，页面只承载**完整事件**；页面首事件放不下 → 具名 `context-too-large`（给出 seq、正文字节数、“offset 以整个事件为单位”、`offset: seq+1` 的显式续读指令）；后续事件放不下 → 页面止于该事件 seq（`hasMore: true`，脚注点名该 seq 与字节数），不再截断正文、不再把 `nextOffset` 推过未展示内容。

**红/绿证据（`context/tests/unit/reads.spec.ts` 新用例，Q3/Q4 子代理执行并 A/B）**

| 用例 | 修复前 |
|---|---|
| 第二窗口失败 | 返回成功页（`# context_read session s-flaky … seq 0..49`），局部事件被当完整页 |
| 窗口不前进 | 返回 `events: seq 0..-1` 且 `more follows from seq 0` 的不前进空页 |
| 单事件 20 000 字节 | 截断正文并标注 cut，`nextOffset` 推过事件尾部 |
| 短事件 + 大事件同页 | 只报 `more follows from seq 1`，后续读在 seq 1 继续截断；修复后页面止于 seq 1、`nextOffset === 1`，再读 seq 1 得具名 `context-too-large` |

工具门复核（`tests/integration/context-read-limits.spec.ts`，真实工具 + 真实 JSONL 日志）：3 例在修复前的 `projections.ts` 上全红（含真实 cut 文案 `… seq 1 is cut at the 16384-byte output bound`），修复后全绿——包括“第二窗口失败”用例（60 事件 + `limit:100`，`readEvent` 第 2 次注入失败）返回 `context_read unreadable` 且**不出现** `events shown` 或任何事件正文。

**未关闭子项：事件内续读是冻结接口冲突（本票保持返工）**

冻结合同（计划 D 节）规定：`context_read` 只有四参数 `{kind, ref, offset, limit}`；Session 的 `offset/limit` 沿 **DSH 既有事件 offset**（事件 seq 与事件条数），16 KiB 是包内唯一输出上限。DSH 的 session 读取单位是**整个事件**（`sessionQuery.readEvent` 返回完整事件；`tool-session-query` 的 `session_event_read` 亦声明 “one full unabridged event”），没有任何 API 能表达“某事件正文内的第 N 字节”。因此单个事件正文超过 16 KiB 时，在冻结接口下**不存在**可表达的续读游标：

- 若仍要返回该事件，只能截断正文并把 `nextOffset` 推过事件（正是 Q3 禁止的行为）；
- 若把 `nextOffset` 停在原 seq，调用方会拿到同一页，构成不前进分页（等价于 Q4 禁止的行为）；
- 现状（已实现并测试）：**不截断、不跳过、不伪造成功**——该事件具名 `context-too-large`，正文一字不示，并给出 `offset: seq+1` 让调用方自行决定跳过；调用方也可用同一 seq 之外的日志位置继续。

最小合同修订（需计划所有者决定，本票不自行改题）：

1. 允许 Session 的 `offset` 承载“事件内位置”（例如 `{seq, byteOffset}` 复合游标），或
2. 允许 `ref` 指向单个事件（`{sessionId, seq}`，计划原文已有“Session 复用 DSH reference/seq”一说）并对该情形把 `offset/limit` 解释为该事件正文的 UTF-8 字节，或
3. 明确接受“>16 KiB 单事件不经 `context_read` 读取”，并为角色提供另一条有界通道（会动到 D 节已封闭的原始 Session 工具面）。

在这次修订被批准前，Q3 不能声称完成；本票按 prompt 要求保持返工。

## Q4：状态分页必须推进

**修复**：`context/src/projections.ts:665-682`——页面首条目放不下时（`shown === 0` 且本页非空）具名 `context-too-large`：点名 taskId、摘要行字节数、说明“同 offset 的零条目页会永远重复”、给出 `context_read` kind:"task" 的详情引用与 `offset+1` 的继续方式。其余不变：按 taskId 排序、`nextOffset = offset + shown`、`hasMore = nextOffset < entries.length`、短条目不被跳过、越界 offset 仍是空成功页。

**红/绿证据**

- 单测（`context/tests/unit/reads.spec.ts`）：修复前首条目超限返回 `- more: yes — continue with offset 3` 的同一页（不前进）；修复后具名 `context-too-large` 且不含 `hasMore/nextOffset`；“较大页在超限条目前停住”一例红绿均通过（防过度拒绝的回归护栏）。
- 工具门（`tests/integration/context-read-limits.spec.ts`）：真实 `task_status` 在修复前返回不含 `context-too-large` 的页；修复后返回具名拒绝，并用同一引用实读该 task 的 `context_read` 分页成功；`limit:2` 的行走在超限条目处按拒绝提示 `offset+1` 跳过并走到 `this is the end of the scope`，全程断言 `nextOffset !== offset`。

## 实际检查（主代理实跑，2026-09-25；顺序按公共合同）

| 命令（cwd） | 结果 |
|---|---|
| `pnpm build`（packages/singularity） | 13 包全部通过（含重建 `graphs`/`context` 的 `lib` 产物） |
| `pnpm vitest run --project unit packages/singularity`（外层） | 47 文件 / 1521 项全过（返工前基线 47 / 1502；+19 项：绑定 10、Session/状态页 5、工具门 0、其余为原用例） |
| `pnpm vitest run --project integration packages/singularity`（外层） | 41 文件 / 296 项全过（返工前基线 39 / 285；+2 文件 / +11 项；含原 `worker-contract.spec.ts`、`cancellation-gate.spec.ts`、`root-intake.spec.ts` 未改动即通过） |
| `pnpm run verify-persistence`（packages/singularity） | OK — 4 event roots 与 schema 一致（持久化格式零变化） |
| `git diff --check`（packages/singularity） | 干净 |
| `pnpm exec tsc --noEmit`（agent-singularity） | 退出码 0、零输出 |
| 定向红/绿 A/B | 见各节；A/B 通过 `git stash push/pop` 只回退生产文件，回退后 `diff` 校验与暂存前一致 |

红证据原文（摘要）保存在本记录各节；完整输出可由上述命令在当前提交重跑复现。

## 保留行为复核

- **A2-1～A2-6**：`tests/integration/context-assembly.spec.ts`、`worker-contract.spec.ts`、`context/tests/unit/*` 原有断言零删除、零弱化（`git diff` 中测试文件的删除行只有 import 与 helper 搬迁）；三层链、域隔离、replay 不串根、重启后无 spawn 装配、重复装配不累加、零副作用全部保留。
- **R2 两条取消交错**：`cancellation-gate.spec.ts` 2 例全绿（本票未改 gate/恢复路径）。
- **重启首写闸与旧数据**：`a3-recovery.spec.ts`（19 例）、`root-intake-recovery.spec.ts`（8 例）、`proposal-recovery.spec.ts`（12 例）全绿。
- **拒绝规则未削弱**：本票只新增拒绝与具名结果；`context/tests/unit/side-effects.spec.ts` 仍证明读路径只观察 runtime 的只读面（新增的 `graphs.view`/`graphForSession` 是注册表读，不是 runtime 写）。

## 既有复杂度处置（本票触及的 400 行以上文件）

| 文件 | 处置 |
|---|---|
| `context/src/bindings.ts`（433 → 636） | **保留**：本票在同一文件内区分“事实 vs 读取失败”并新增委派者归属核对（`graphOfSession` / `delegatorStanding` / `reviewerFailure`）；未拆文件、未加第二套权限表。 |
| `context/src/projections.ts`（1000 → 1086） | **保留**：只改 `taskStatus` 与 `sessionRead` 两个函数及两个小 helper（`blockFits`/`oversizedEventDetail`/`notShownEventLine`/`eventTextBytes`）；未按行数机械切分。 |
| `graphs/src/index.ts`（452 → 471） | **保留**：新增可区分事实的错误类型与抛出点，其余注册表逻辑不动。 |
| `context/tests/unit/reads.spec.ts`（440 → 590）、`context/tests/support/stack.ts`（783 → 814）、`tests/integration/context-assembly.spec.ts`（493 → 710） | 测试/fixture 增长（新增反例与注入钩子），无生产职责变化。 |

## 独立复核

执行者：未参与实现的独立子代理（只读审计 `bee6a96`，复跑定向用例、按公开入口尝试新反例）。结论：**Q1 PASS（含一处残留）、Q2 PASS、Q3 PASS（记录级，含一处文本级缺口）、Q4 PASS**；复核实跑 unit 5/73、integration 5/39、全量 88/1812 与主代理数字一致，`git diff --check` 干净，agent-singularity `tsc --noEmit` 零错误（context 包 12 条跨包噪音，改动文件零新增）。测试完整性核对：删改只有 `failedTask` 助手搬迁与 import 替换，未削弱任何既有断言。

复核发现与处置（均在本记录“返工记录”提交之后的响应提交中实现）：

1. **Q1 残留——后端把 store 报成“不存在”时，已绑定 worker 会降级为 `member` 并以无契约请求装配**（复核用真实链路 + 重启 + 隐藏 store 复现；这正是 Q1 要禁止的形态）。处置：`bindings.ts` 对“store 不存在且非本图 root”的会话，读图 store 自己的 `spawn` 边判断它是否由本图 spawn：**被 spawn 的会话**（其 run 记录在 spawn 时就写在该 store 里）判为具名 `unreadable`；**未被 spawn 的成员**（真实情形是“本部署把它解析到别的 root 名下”）保持计划 D 节的成员放行与 root 的 `not-activated`；边读取失败则失败关闭。反例：`tests/integration/context-assembly.spec.ts` 的 “refuses a published worker whose store log stopped being listed…”（真实破坏 store 日志头 + 重启 + 用 `first.spawnEdges()` 把图 store 自己的 spawn 边带到新进程），修复前红（`expected the assembly to refuse by name, got undefined`）、修复后绿；单测 “a store the backend reports as absent binds the root's not-activated state, a member's silence, and a spawned session's refusal” 同批钉住三条分支。**注意**：该规则依赖图 store 自己的 spawn 边（部署中由 `graph` 事件持久化；重启测试需显式携带，否则夹具会少建模——复核探针的第二次启动正是如此，其 `Q1-RESTART-ASSEMBLED` 输出即该夹具差异）。
2. **Q3 文本级缺口——页面收尾两行会被静默丢弃**：`events shown`/`more follows` 与“下一事件未展示”两行原用未检查的 `budget.add` 写入；事件正文接近上限时两行都放不下，而工具适配层只回传文本（`agent-singularity/src/tools/projected-read.ts` 的 `adaptRead`），结构字段 `hasMore/nextOffset` 到不了模型，于是模型会收到一页**没有任何续读线索**的正文。复核给出精确字节窗口（≈15 988–16 049 与 ≥16 134）。处置：`sessionRead` 在加入任何事件前预留收尾行空间（`sessionClosingReserve` 按 limit、日志末 seq、字节数最大位数取上界），`blockFits` 据此判定。复核自带探针（`q3-boundary`/`q3-exact`/`q3-detail`）在修复后 `firstWithoutFooter=-1`、`firstWithoutAnySeqCue=-1`、窗口计数 24 → 0，最坏窗口（16 150 字节单事件）改为具名 `context-too-large`；新单测 “every successful page ends with its closing lines, whatever the next event measures” 在无保留版上红、有保留版绿。代价：同一页可容纳的事件正文略减（事件必须连同收尾行一起放得下），这是“页面必须能说出续读位置”的必然取舍。
3. **Q4 服务门残留——非有限数**：`limit: NaN`/`Infinity` 经**服务 API**（工具 schema 先拒绝，NaN 也非 JSON）会得到 `hasMore: true` 且 `nextOffset === offset` 的页。处置：非有限数按越界值同样夹取并在结果文本中声明；单测 “a non-finite offset or limit is clamped like any other out-of-range value” 覆盖。
4. **成员读取失败会以裸异常逃出工具门**：`sessionRead` 的成员表读取现捕获并具名 `unreadable`；单测 “a session reference whose membership cannot be read is a named unreadable, not an escape” 覆盖。
5. **已核实、保留的边界（供裁决，未改）**：注册表 `graphForSession` 会遍历各图 store；某一个图 store 的 I/O 失败会让**其它**图的会话也判 `failed`（fail-closed）。这是“图查询异常不得改写为没有图”的直接后果，当前注册表接口无法只容忍一张坏图；如需按图容错须先改注册表读接口（不在本票内）。
6. **已核实良性（不改）**：reviewer 可自任委派者（`actor === 自身 session`）——该会话的读取域仍是它自己所属的 graph，且 `reviewer` 分支不给任何工具写权限（`agent-singularity` 只按 kind 读取），无提权路径；无业务 Run 的会话 ledger **文件级**不可读不拒绝（其绑定来自 run，损坏文件不应停掉整批 worker），点名该会话的冲突仍拒绝；`reviewerFailure` 对“非 Error 实例但形状正确的抛错”退化为 `unreadable`（仍 fail-closed）；两源 actor 冲突 → `binding-conflict` ✓。

## 模拟与未覆盖范围

- 未做付费真实模型实验（本票合同仍只要确定性协议验证）；模型输出由 scripted provider/夹具替代，runtime/store/verifier/DSH 接线均为真实实现。
- Q3 的“事件内续读”未实现（冻结接口冲突，见上）。
- 独立复核发现的三处可达缺陷已修复并各有红/绿反例；“页面止于超限事件”时点名该事件的脚注与 `events shown` 收尾行现在由预留守住（不再 best-effort）。
- 未覆盖：`limit` 边界（0/1000/负数/非整数/非有限）在集成层只有单测覆盖；`session_event_*` 原始工具的封印属原票证据，本票未重跑专门用例。
- 未覆盖：ledger 源抛“非 `ReviewerBindingError` 形状但 kind 字段存在”的错误有单测（形状识别），但没有专门的跨包类身份集成用例。
- 未覆盖：注册表“一张坏图影响其它图”的按图容错（见复核发现 5），当前为有意的失败关闭。
- 夹具限制：重启类用例需要显式把 `GraphSpec.spawned`（图 store 自己的 spawn 边）交给新进程；本部署中该边由 `graph/event` 持久化，夹具不会自动重建。

## 未解决缺陷 / 阻塞

- **合同冲突（需计划所有者决定）**：`context_read` 在冻结四参数下无法表达“单个 DSH 事件正文内部”的续读游标，>16 KiB 单事件因此在 `context_too_large` 之外无读取路径；本轮已实现“不截断、不跳过、具名拒绝 + `offset: seq+1` 显式续读其余日志”，并保证页面收尾行不再被丢弃。解除条件：批准上文三条最小修订之一（或明确接受该边界并把对应条款写入计划 D 节）。
- **语义边界（已实现并测试，供审核判断）**：文件级 ledger 不可读不会拒绝**已有本 run** 的会话（其绑定来自 run）；点名该会话的 ledger 冲突仍拒绝。若审核要求“任何 ledger 失败都拒绝该 store 的所有会话”，该分支在一处即可翻转，但会让一个损坏的 ledger 文件同时停掉整批 worker/root。
- **失败关闭的传播面（复核发现 5）**：某一张图的图 store 读失败会让其它图的会话也判 `failed`（注册表遍历所致）。这是 `graphForSession` 语义的直接后果，按图容错须先改注册表读接口，不在本票范围。

## 最终验收结论与下一项

Q1、Q2、Q4 关闭，Q3 的“中途失败不得伪装成功”关闭、“大事件可续读”为冻结接口冲突：按 prompt 要求**保持返工**，不填“交付待进度审核”；不开始第 11 项 A4。下一步：进度审核判断是否批准最小合同修订，或按已实现行为调整 Q3 验收条款。不推送、不部署。
