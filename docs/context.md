# context.md —— 跨轮工作记忆

> **每轮结束更新此文件。** 只放"下一轮必须知道、丢了会走错路"的东西。
> 长文档：`docs/blueprint.md`（蓝图）、`docs/review.md`（第一轮审核 + K1/K2 检查点）、
> `docs/rrsi-upstream-reference.md`（上游逐行对照）、`docs/adr/`（已定决策）。
> **`docs/debugging.md`（写代码前先读）**：六类缺陷的根因、"量不变量而不是量耗时"、
> 变异证明配方、以及"不可能触发的规则要删掉而不是补测试"这条纪律。
> 上一轮更新：2026-10-09（A 提交边界纠正；B 部分实现，剩余动作见 §11/§12）。
> 本轮更新：控制路径收敛（一条决定/记录路径、一个队列、O(1) 提交），六处报告的缺陷逐条确认并修掉。

---

## 0. 已定决策（不要重新讨论）

| ADR | 决策 |
|---|---|
| [0001](adr/0001-rrsi-port-boundary.md) | **移植 RRSI 的决策层，绝不移植它的执行体。** 只移植纯决策/正则化函数 + 机械约束；不移植轮次编排（git worktree/branch/fast_forward/自有 JSONL）与 LLM agent 管线（proposer/critic/analyst/digester 的 agent loop）——因为 **bubble 就是候选 worktree，环境指针就是 fast_forward，agent runtime 就是那些 agent**。Python checkout 保留为**可执行规格**与向量来源。**五处有意收紧必须记账并各有反例测试**（`rounds−1` 退火、+25% 成本上界、删 `w_n·ν`、`ΔC` 未知拒绝、适配器核验替代 diff 分类）。 |

---

## 1. 位置与基线

| 对象 | 位置 | 基线 |
|---|---|---|
| **新仓** | `/home/ROXY/code/singularity-core` | `main`；提交 `7b4e5cf`(S1) `4f6b2e6`(S2) `798c6d9`(蓝图) `d849430`(反例修复) |
| 旧仓（**冻结为行为参照**） | `/home/ROXY/code/bb_work/harness/packages/singularity` | `6a0edde` |
| DSH 源码 | `/home/ROXY/code/bb_work/harness/thirdparty/deepseek-harness` | 审核基线 `639ed01` |
| DSH 已装产物 | `/home/ROXY/.local/node-v22.23.3-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` | **`0.2.0-rc.2`** |
| RRSI 上游 | `/home/ROXY/code/rrsi` | `be50316` |
| 探针 | `/home/ROXY/code/singularity-probe/probe.mjs`（storageDomain vs session lease）、`/home/ROXY/code/dsh-carry-probe/probe.mjs`（F01 承载）、`/home/ROXY/code/rrsi-verify/repro.mjs`（RRSI 反例） | 全部可重跑 |

**依赖铁律**：npm 上 `@deepseek-ai/dsh-*` 是 `0.0.1-rc.1`，本地是 `0.2.0-rc.2`。**永不从 registry 装**。

## 2. 方向：review §5 的 A–F 阶段（取代原 S3′–S9）

| 阶段 | 交付 | 退出条件 | 状态 |
|---|---|---|---|
| **A** | 专用控制 store、DSH 承载、串行提交、严格边界、命令结果识别 | 双进程互斥；并发命令正确；屏障失败不返回成功；提交后/答复前崩溃可识别原结果 | **完成纠正**：三个提交边界 P1 已修复，108 测试、9 门禁通过；实现限制与下一阶段见 §12 |
| **B** | 最小 E3、Task 分解与责任、初始不可变 Revision、最小 Bubble、真实 verifier 与固定来源 receipt | 根/子任务执行与依赖推进；产物独立验收；SIGKILL 后恢复同 session/责任/绑定 | **部分实现**：S1 与 S3 验证器部分已落地；S2/S4/S5/S6 待完成（**K1 尚未达到**） |
| **C** | 冻结双侧输入、真实领域取数、非补偿约束、真实重复与噪声依据 | 好候选通过；高分越界拒绝；缺失分母正确；每份报告有真实 trials | 未开始 |
| **D** | draft 状态机、E6 原生审批、决定重算、唯一指针切换 | 批准绑定具体差异；陈旧/内容变化拒绝；head 不引用半成品 | 未开始 |
| **E** | 显式 round、真实历史与 frozen deltas、m≥2 选优、探索/剪枝消费者、消费反馈 | 至少两轮；第二轮读第一轮；历史不被新 head 改写 | 未开始（**K2**） |
| **F** | 关键行为回归、领域任务集对照、部署替代 | 恢复/边界满足新契约 | 未开始 |

**下一次重要审核在 A+B 完成时**。先纠正 A 的提交边界，再补齐 B 并逐条验收 K1；K1 通过后进入 C。

## 3. 反例清单：状态与归属

| # | 反例 | 状态 |
|---|---|---|
| E01 | DSH 固定词表：`plugin:singularity:event` 无 `ignorable` → `SessionFormatUnsupportedError` | **已确认并深化，见 §4.1** |
| E02 | 并发两次 emit → 两次成功、`seq=[0,0]`、重开 `chain-broken` | **已修**（提交队列）；回归：`gate.spec.ts` 的 `serializes concurrent commits` |
| E03 | 用验证器名填 `actor` → 可达 verified | **已修**（emit 无 actor 参数；角色由 kind 声明、身份由部署绑定；reducer 同时校验角色与身份）；回归：`task-invariants.spec.ts` 的 identity 共享用例 + slice 冒烟 |
| E04 | 合法日志换空注册表重开 → `unregistered-verifier` | **已修**（shape 纯函数 vs 可用性命令期检查）；回归：`replay never consults what this deployment can run today` |
| E05 | 加 default-import 写者 + 仅注释中的导出引用 → 7/7 门禁通过 | **已修**（剥离注释/字符串；拒绝 default/namespace fs 导入）；回归：`gates.mjs --probe` 的两个探针文件 |
| E06 | unknown 字段被接受；`detail:123` 变空串；无 Run 的已准入 Task → `failed` | **已修**（载荷按 kind 闭合；错类型拒绝而非归一化；缺失理由保持缺失；新增 `awaiting-run`） |
| E07 | `digestOf({v:NaN})===digestOf({v:null})`；`undefined` 同 `{}` | **已修**（`assertLosslessJson`）；回归：`refuses a content identity JSON cannot round-trip` |
| E08 | `ruleFor('toString'\|'constructor'\|'__proto__')` 返回继承属性；`declare` 先改 owner 后拒绝 | **已修**（own-key 查询；全部校验成功后才发布）；回归：`refuses an inherited member name` + `declaration is all-or-nothing` |
| E09 | A=.6/B=.8：发布 B 前 B 的 Δ=+.2；发布后 B=0、A=−.2 | **已独立复核确认**（`history.ts:77-92,107`；上游 `loop.py:320` 冻结 ΔS） |
| E10 | B 被成本拒绝后 `bestQuality` 仍 .8 | **已确认**（`history.ts:123,156`）；上游 S* 只取被接受 head（`loop.py:335` 在 `if winner is not None` 内） |
| E11 | B 换 scope → A 从 `measured` true 变 false | **已确认**；措辞更正：选的是**最高 round 的候选评估的 scope**（字典序 tie-break），不是"最新时间" |
| E12 | 计划 2 trials、missing=1、仅一条观测 → quality=1 | **已确认但被高估**，见 §4.2 |

## 4. 方向性更正（别再写错）

### 4.1 F01 承载实验的结论（推翻我原方案的前提）

实验：`/home/ROXY/code/dsh-carry-probe/`（子代理执行，含独立双进程 lease 复现）。**已确认**：

1. **运行时事件词表是生成的、且只扫仓内**：`packages/core/session/src/known-event-types.ts` 由 `scripts/gen-persistence-catalog.ts` 生成，输入 `globSync('packages/*/*/src/**/*.{ts,tsx}')`。装好的 0.2.0-rc.2 里 `KNOWN_SESSION_EVENT_TYPES.size = 59`，`has('plugin:singularity:event') = false`。**仓外插件的扩展事件按构造不在表内。**
2. **`SessionEventMap` 的类型增强有效，但运行时不可见**：用一个仓外文件声明 merge augmentation，`tsc` 通过（负对照报 TS2322）——类型层可扩展；但运行时集合**前后都是 false**，`typeof SessionEventMap` 是 `undefined`（类型被擦除）。
3. **没有受支持的注册路径**：`known-event-types.ts` 原文写着"event-name registration was rejected"；`.agents/notes/.../2026-08-30-retain-ignorable-external-session-events.md` 记录"Register mounted plugin event names as known. **Not adopted**"。`ignorable: true` 是**唯一**支持的兼容机制。
4. **活跃会话的正规写入路径无法设置该标记**：`core/session/src/index.ts:744` 构造 `deepFreeze({type, seq, time, data, ...surfaceMetadata})`——**没有 `ignorable`**。
5. **未标记的未知类型不是"被跳过"，而是让整份会话在本 build 下永久不可读**：写进去 → 重开 → `SessionFormatUnsupportedError`，整份日志拒绝解释。
6. **`flush` 才是持久性屏障**（接口原文）：`append` 是 best-effort（本实例上已接受、已排序、可见），**只有 resolved `flush` 承诺崩溃后仍在**。JSONL 后端的 `append` 已 fsync，但**活跃路径会缓冲**（`enqueueLive()` → `this.buffered`），所以活会话上的 `session.append` 在 `await ctx.sessions.flush(session)` 之前**不持久**。`flush` 返回 `false` 表示没有持久化监听者参与 → **必须当作失败**。
7. **正规写入缝存在，且不是第二个写句柄**：`ctx.sessions.get(id)` → `session.append(type, data)` → `await ctx.sessions.flush(session)`。先例：`packages/feedback/message-feedback/src/index.ts:231,236,240`（只为持久性断言开 **read** 句柄）、`packages/deliverables/workspace-changes/src/recorder.ts:354`。
8. **写句柄独占已实测**：同实例/第二实例/子进程持锁时 `SessionAlreadyOwnedError`；read 句柄不受影响；子进程 SIGKILL 后可立即接管（上游 `lease.two-process.e2e.ts` 就是这么做的，子代理也独立复现）。

**因此控制 store 的形态（阶段 A 剩余工作）——A1/A2 已按证据修正**：

handoff §3 的 A1 写"选一个**已知的、log-only**的 DSH 事件类型"，A2 写"活会话用 `ctx.sessions.get(id).append(knownType, …)`"。**这两条与 handoff 自己的禁止项"借用一个已知 DSH 事件名塞不相符的业务载荷"冲突**，而 DSH 生成文件的原文给出裁决：

> "**Downstream (out-of-repo) plugin events are outside this list by construction.** The persisted `SessionEvent.ignorable` marker is the compatibility mechanism; **event-name registration was rejected** because it does not classify omission safety and would make reads composition-dependent."（`packages/core/session/src/known-event-types.ts:11-19`）

**59 个已知类型里没有一个是给我们用的**；挑一个承载 `{protocol:'singularity.control',…}` 就是在污染它的语义，也正好是那个禁止项。因此按 DSH 自己的 doctrine 落地：

- **控制 store 是它自己的一个 DSH session**（稳定 id，由 graph/environment 派生），与执行 agent 的 transcript **分开**——正是 review U01 要求的"控制 store 与 transcript 分开使用稳定身份和链接"，且"多个物理日志可以复用同一存储机制"。
- 每条控制记录 = 该 session 里的一条**我们自己的事件类型** `plugin:singularity:control`，**带 `ignorable: true`**（其余消费者跳过它，因此不毒化任何人的读取），`data = {protocol, version, kind, payload}`。
- 写入用**我们自己的 write 句柄** + `await handle.flush()` + `close()`（A3）。**`ignorable` 只能从这个路径设置**——活跃缝 `Session.append` 设不了。
- **A2（活会话缝）对我们的词表不可用**：它设不了 `ignorable`，于是在 agent 的 session 里写我们自己的类型会让整份会话**永久不可读**。若将来需要在 agent 的 transcript 里留一条**链接**，那是另一个决定，不是控制记录的载体。
- **装载时由我们做全部语义校验**：读该 session 的日志 → 选出 `type === plugin:singularity:control` 的事件 → `assertEnvelope(data)` + 内层 protocol/version/kind/payload 严格校验。**不得只凭 DSH 事件类型判断归属。**
- **DSH 只保证**信封形状 + 词表成员 + 深冻结物化（`adoptSessionEvent`）+ 崩溃屏障（`flush`）+ 跨进程 lease；**每一个语义检查都是我们的**。

**A4 已完成**（本轮）：`ProtocolLog` 的文件存储实现删除，`src/protocol/memory-log.ts` 的 `MemoryLog` 成为纯内存事实管线（提交队列 / 发射者纪律 / 命令识别 / `adopt` 重放校验），门禁 `single-durable-writer` 收紧为 **`no-durable-writer`（零持久写者）**且自检仍全绿。持久性从此只有一个归属：DSH。

**会打破它的因素**：非无损 JSON 或超大载荷 → `materializeAppendBatch` 抛 `TypeError`，记录根本不落；选到 **surface** 宿主类型会拖入 message 形状与 `surfaceManager.validateNext` → 必须选 log-only；**在更新版 harness/词表/格式下 resume 会整份会话拒绝**（`assertVersion`、`validateStoredEvents`）→ **我们的事实随日志一起死**；`Session.append` 在写入时不拒绝未标记的未知类型，伤害只在下次读出现；卡住的写者无限持有 flock（**故意无过期**）→ 没有基于租约超时的恢复。

**另一处更正**：review §7 的 E01 复核脚本用的导入路径 `dsh-session-persistence/lib/types/storage-contract.js` **在装好的 build 里不存在**；`validateStoredEvents` 由 `dsh-session-persistence/lib/index.js` 导出。复核时要用后者。

**A1/A3/A5 已落地**（同一轮，子代理执行 + 我修掉它报出的一个真实缺口）：

- `src/control/session-store.ts`：控制 store 落在**它自己的 DSH session** 上（`plugin:singularity:control` + `ignorable: true`，自己的 write 句柄 + `flush`）。DSH 只搬字节，语义全在 `src/protocol/`。
- **子代理报出的缺口（它正确地没有即兴补）：跨进程命令识别不成立**——`MemoryLog.adopt` 不重建命令表，且信封里没有命令身份，所以后继进程只能把重投当作首次提交（被 reducer 以 `illegal-transition` 拒绝，fail-closed 但不满足 A 的退出条件）。
- **修法：把 `commandId` 放进信封**（它是**来源**，不是载荷），`adopt` 据此重建命令表（`requestDigest` 由被采纳的事实重算）。**为什么放信封**：崩溃后后继进程必须**只凭事实**就能辨认重投；命令 id 只活在写者内存里，恢复就不可能。信封现在 **12 个成员**。
- **回归**：`gate.spec.ts` 的 `recognises a lost reply from the facts alone, after a successor adopts them`；`scripts/control-probe.mjs` 第 4b 节由 GAP 变为 `ok`（**failures: 0, gaps: 0**）。
- **一个运维陷阱已被机制化堵住**：pnpm 11.18 的 `autoInstallPeers` 默认为 true 且运行前有 deps 检查，所以一次 `pnpm verify` 会真的去 registry 装 peer（**该 registry 上确实存在 0.2.0-rc.2**，尽管 `npm view <pkg> version` 返回的是 latest 标签 `0.0.1-rc.1`）。已提交 `pnpm-workspace.yaml` 设 `autoInstallPeers: false` + `verifyDepsBeforeRun: false`（`.npmrc` 的同名键被证明无效）；`pnpm-lock.yaml` 与 HEAD **逐字节一致**，`node_modules` 未被改动。
- **两个运行时解析文件**（brief 未点名，但 vitest 与裸 node **不读 tsconfig `paths`**）：`vitest.config.ts`（把 4 个包 alias 到已装 build）与 `scripts/dsh-control-runtime.mjs`（`module.register` 的 resolve hook）。tsconfig 的 `paths` 指向 **`<pkg>/lib/types/index.d.ts`**——0.2.0-rc.2 里**没有 `lib/index.d.ts`**。
- **依赖形态**：4 个 `@deepseek-ai/*` 是 **peerDependencies**（宿主提供），不是 devDependencies。

**A 的退出条件逐条状态**（诚实标注，不把未证明的算作已证明）：

| 退出条件 | 状态 |
|---|---|
| 双进程互斥 | ✅ 探针第 2 节观测：第二写者拿 `SessionAlreadyOwnedError`；read 句柄不受影响 |
| 并发命令正确 | ✅ 提交队列串行化 + `gate.spec.ts` 回归 |
| 提交后/答复前崩溃可识别原结果 | ✅ **本轮修好**：`commandId` 进信封，`adopt` 重建命令表；探针 4b 由 GAP 变 `ok`，`failures: 0, gaps: 0` |
| **屏障失败不返回成功** | ✅ **纠正后验收**：首次与重送均不能绕过失败屏障；读取保持旧已提交状态；只有显式重开并成功确认屏障后恢复。旧测试的“失败后重送成功”断言撤回，见 §12。 |

### 4.2 RRSI：**我现在亲自读过上游源码**（此前只读 README）

**完整对照件：[`docs/rrsi-upstream-reference.md`](rrsi-upstream-reference.md)**（逐条带行号，覆盖范围见其 §0）。

**算法面已全覆盖（≈2500 行）**：`config.py` `components.py` `schedule.py` `evaluate.py` `calibrate.py` `selection.py` `history.py` `analyst.py` `digester.py` `propose.py` `critic.py` `domain.py` 接口、`loop.py` 除 :420-452 外全部（`Run` 状态/git/evidence/baseline、`round()`、`readjudicate()`、`_draft()`、`_evaluate()`）。
**仍未读（纯管道 ≈400 行）**：`gitops.py` `llm.py` `driver.py` `__init__.py` `loop.py`:420-452、`rrsi.py`。

**我此前的一处符号错误**：蓝图 §2.3 写「每轮 **k** 个候选」——实际是**每轮 `cfg.m` 个候选**（`loop.py:292`，标签 A..H），**`k` 是每任务 trial 数**；`config.py:60-61` 两者默认都是 2，所以极易写混。review 的 R01 已指出，我当时只改了口径没改蓝图正文（**现已按行号重写 §2.3**）。

**读 `config.py` 得到的权威符号表**（`:31-46`）：`T=20` `k=2` `m=2` `b_min/b_max=1/4` `w=3` `m_draft=1` `delta_z=2.0` `beta0=0.10` `beta1=40` `w_s/w_c/w_n=100/15/0.5` `n_prune=4`；工程旋钮 `repair_rounds=5` `invalid_missing_frac=0.15` `n_fail_traces=22` `n_success_traces=6` `eval_parallel=1`。**单位**：`ΔC` 是相对值，`beta0=0.10` = "10% token 增量免费"，`beta1=40` = "每 +1pp 的 S 换 +40% 成本"。

**我此前整条漏掉的机制（读全后才看到）**：

1. **测量前四道具名门**：`no_proposal`（未 done 或零改动，`loop.py:495`）→ `critic_reject`（含 `repair_rounds` 次修复，`:550`）→ **按 diff 重新打标签**后破坏保留槽也算拒（`:523-530`）→ `smoke_fail`（liveness 冒烟，`:566`）；评估期再加 `eval_invalid`（崩溃或缺失率超限，重试一次，`:599`）。**被筛掉的候选有具名归因且不进 `T_t`/`g_t`。**
2. **归因 scoreboard**（`loop.py:159-178`）：每条编辑的 `predicted_affected` 被核对命中率，`unpredicted_regressions` = 退化超过 `regression_threshold(k)` 且未被预测的任务；`attribution.jsonl` 的**最近 20 行**回喂 proposer（`scoreboard()`:152-157）。
3. **证据管线**：`build_traces`（**最差任务的 worst trial + 最好任务的 best trial**，`n_fail=22`/`n_success=6`，`:134-150`）→ **只读 digester 子代理**（工具 jail 在渲染目录、三套 schema、6000 字符硬顶，`digester.py:41-73`）→ **analyst 三镜报告**（failure_modes/capability_gaps/success_habits，合并/拆分/按影响排序/entity-free/沿用旧模式名，`analyst.py:52-102`）→ **跨轮 `global_analysis`**（`loop.py:265-267`）。
4. **propose.py 的 `done()` 是机械执行点**（`:328-369`）：预算、保留槽、`component ∈ K`、六个必填字段都在这里**回弹重做**；且明确 **"THERE IS NO ABORT ACTION"**（`:107-111`）。每条编辑还有**预测与三段反事实**（`trigger_condition`/`predicted_affected`/`retroactive_check`/`regression_weight`，`:91-104`）——端口只有 4 个字段。
5. **critic 是两层且只管意图**：确定性预检（凭据 + 领域 patterns）命中即拒、不进 LLM；LLM 层有**六条具名理由**（泄漏/退化/评分器作弊/未声明捆绑/**运行期记忆化**/无界工作），并明说"运行期正确性不是你的职责，确定性 compile/smoke 在你之后处理"（`critic.py:50-102`）。
6. **winner 必须是 `H_t` 的后代**（`git merge-base --is-ancestor`，`loop.py:403-406`）。

**我已自证的关键事实**（不再依赖转述）：

- `loop.py:335` `S* = max(S*, S_{t+1})` **在 `if winner is not None` 之内** → 被拒候选永不抬高 S*（E10 成立）。
- `loop.py:363` readjudicate 里 `S_star = max(x["S"] for x in fr["trajectory"][:t+1])`。
- `history.py:91-92` 把 `ΔS`/`ΔC` **按测量时刻写进记录**，`:143-150` 直接读记录 → **ΔS 冻结**（E09 成立）。
- `history.py:36-38,83` **一条记录 = 一条 edit**，带 `t`（轮）与 `variant` → 端口「候选序号充当 round」确实是错的。
- `components.py:107` 用 `set()` → **两条同机制编辑的 novelty 是 1**。
- `selection.py:90` 带内成本规则**含 novelty 项**；`:107-118` 准入顺序 = 噪声底线 → 成本规则 → guards。
- `evaluate.py:110-114` `aggregate` **只遍历 `rewards`**，`missing` 只计数；而模块 docstring 声称 "full denominator"、`TaskResult.rewards` 注释说 "missing trials -> 0.0"（= scorer 的义务）→ **上游本身就有"注释描述义务、代码不实现"的缺口**，端口是忠实复制。我此前说"端口这块是错的"措辞不准。
- `schedule.py:48` 除以 `T`、`budget_table` 用 `range(T)` → 末轮拿不到 `b_min`，端口改成 `/ (rounds−1)` 的记载准确。
- `calibrate.py:68,103` k=1 单次评估时 bootstrap 的 pstdev 为 0 → **δ=0**，端口加下限是真实加固。
- 端口**缺失的是整整一条证据管线**：analyst（失败模式/成功习惯，跨轮累积到 `global_analysis`，`loop.py:249-268`）→ `directives.json`(`:285-288`) → propose → critic/smoke 门(`selection.py:57`) → 并行评估(`:301-302`) → **`attribute`**(`:323`) → history。另有 `constitution()`（SKILL.md + PATTERNS.md，`domain.py:109`）、每变体 `prep.json`/`eval.json`、`harness_tree` 与 **winner 必须是 `H_t` 的后代**(`loop.py:403-406`)。

### 4.3 RRSI 复核的更正（子代理独立复核，含对审查的修正）

1. **E12 被高估**：`aggregateEvaluation` 忠实复制上游 `rrsi/evaluate.py:110-120`，上游同样不在 S 里用 `tr.missing`。上游的契约是**领域 scorer 把 missing trial 物化为 reward 0.0**（`evaluate.py:53`）；端口的 adapter 正是这么做的（`observe.ts:100-104` 为每个 trial 推一条 quality-0 观测并把 `missing` 加一）。E12 的输入是手工构造、违反调用方契约的，**没有 pipeline 路径会产出它**；且 `selection.ts:145-146` 会拒绝任何 `missing > 0` 的聚合。**准确表述：文档/API 契约缺口（`input.missing` 对 `quality` 是 no-op），不是 pipeline 可见的分母 bug，也不是与上游的分歧。**
2. **R06 必须拆开**：`measure.ts` 与 `score.ts` 的注释是**对调用方的义务描述**，不是函数行为。`quality` 对 `missing:1` 与 `missing:0` 相同 → `missing` 从不进入平均。
3. **E11 措辞**：选的是**最高 round 的候选评估的 scope**（`history.ts:69-75`，字典序 tie-break），不是"最新时间"。可观测翻转与审查所述一致。
4. **E10 的上游对照成立**：上游 `S*` 是**只对已接受 head** 的 running max（`loop.py:335` 在 `if winner is not None` 内；`readjudicate` 用 `max(x["S"] for x in trajectory)`；初值为 baseline S）。被拒候选永不抬高它，所以 `bestQuality` 不能当 `S*`。
5. **E09 是真实分歧且精确复现**：唯一精度是"最新 head"按 round 选（`history.ts:77-78`），baseline 按 `contentDigest` 键（`:90-92`）。
6. **R05 确认**：`noveltyOf(['skill','skill'],{})===1`（`selection.ts:61` 的 `new Set` 去重）；`['skill','capability']===2`；`['text','parameter']===0`；`STRUCTURAL_MECHANISM_KINDS = ['skill','capability','task-template']`。**我在 F1 设计里写"2 条编辑 → novelty 2"是错的。**
7. **F1 的两处更正**（review §5 末尾，仍未做）：生产 history consumer（`method-shared.ts:498` 的 `recordDecision` → `deriveDecision` 构造空 HistoryFacts，`bestQuality` = 本次 baseline）必须一并接通；**已冻结/已分发的格式增加必填字段要升版本**——不能由"本机没有旧账本"推导"同版本格式可随意改变"。
8. **`G1–G4` 不是互斥级别**，而是可组合属性；已在代码里落地为 `guarantees: {appended, atomicFact?, conditional?, derived?}`（`derived` 是唯一禁止持久化的一维）。**正确的 G3 约束是**：每个 Environment 一个 active revision；publish/rollback 共用一条权威切换路径；expected revision + generation 在提交队列内检查。
9. **DSH `append([a,b])` 不是多记录崩溃原子事务**；有业务原子性的操作应表达成**一条完整事实**。
10. **内容块不必为"无第二文件"塞进日志**；先准备并验证完整不可变内容，再提交引用；**不允许生效指针引用半成品**。同 revision ID 内容改写必须拒绝。

## 5. 当前代码状态（`pnpm verify` 全绿）

`src`/`tests` 共 44 个 `.ts` 文件；**181 测试**；**10 门禁 + 门禁自检**（含 `dsh-alignment` 与三条跑真实进程的行为门禁）。
**这份清单要按 §12.1 变成被门禁检查的账本**——它上一次是错的（见 §12.1 的实测）。

**一条事实只有一条路径**（本轮收敛，`docs/debugging.md` 记了根因）：`MemoryLog.decide` 判全部规则并封信封但**不记录**，`record` 才让它进入日志。控制 store 的提交区是**全栈唯一队列**——它是唯一跨越真实写入的地方；命令层与 `MemoryLog` 自己的队列都已删除。读侧：`load()` 是一个真正的 **cut**（`stateAt(p,v,s,cut)`），头部读 O(1)，写侧提交的 reducer 调用数从 51 降到 **1**。

- `src/protocol/{refusal,envelope,registry,fold,log}.ts` —— 一个拒绝契约、一个信封、一个版本闸+保证词表+发射者纪律、一个 fold 引擎、一条追加路径（提交队列 + 命令识别 + 提交前 dry-run）。
- `src/task/{contract,protocol,view}.ts` —— 契约（shape 纯 / 可用性命令期）、5 种 kind、唯一读投影 + G4 派生 receipt。
- `scripts/gates.mjs` —— **9 条门禁** + `--probe` 自检（每个静态检测器都必须能失败；三条读真实树的门禁各有独立探针）。新增的第 9 条 `control-store-probe` 跑 `scripts/control-probe.mjs`，它是阶段 A 四条退出条件**唯一**的端到端证据。**为什么要加它**：v2 版本变更把那个探针弄坏时，没有任何自动路径会报警，直到我手动跑它——「证据必须在每次提交上被机械检查」这条，我此前漏在了 `pnpm verify` 之外。
- `dsh-baseline.json` —— **DSH 基线的单一事实来源**；门禁 `dsh-alignment` 强制它。
- `src/control/session-store.ts` + `scripts/control-probe.mjs` —— 控制 store 与双进程探针（见 §4.1）。
- `tests/control-barrier.spec.ts` —— **屏障失败可失败性**（假介质：接受 append、屏障拒绝）+ 该用例自身的变异证明（见 §4.1 末尾表）。
- `src/environment/{protocol,binding}.ts` + 两个 spec（**S1 已落地**）——修订一条被创建一次、**摘要由 reducer 自己算**（不可借身份）、同 id 同内容幂等 / 异内容 `revision-conflict`；`assertPinnedRevision` 与 `projectBindings` 判 `unknown-revision`（含继承键 `constructor` 用例；投影**拒绝**首个不可绑定的 run，不静默跳过）。
- `src/verifier/implementation.ts` + `scripts/verifier-command.mjs` + 两个 spec（**S3 验证器半边已落地**）——部署声明 `implementationDigest` 与 selftest；`assertVerifierRunnable` 要求 selftest **既有 pass 又有 fail 样本**（"没失败过的门禁不算门禁"用在验证器上）；`runVerifierSelftest` 把"实现说谎"记为数据而不是抛出；真实执行器由退出码判决、**执行后**再哈希产物字节。
- `src/task/shape.ts` —— 任务协议的共享形状读取器（从 `protocol.ts` 切出，因它越过 400 行门禁）。
- `src/task/decomposition.ts` + `src/task/tree.ts` + 两个 spec（**S2 已落地**）——一条完整事实的分解（`dependsOn`/`supports`/`maxRuns`，无环、覆盖面、子 id 唯一，声明 `atomicFact`）与全日志投影 `projectTree`。**只有 `verified` 满足依赖**；停止/阻塞沿链具名传播；预算耗尽即 `stopped`；**父的完成是派生量，子任务结束永不等于父任务被接受**。三个承重性质各有变异证明：把“任何终止都算满足”（旧仓的 bug）、把“未 verified 的子任务算作接受判据”、把“只有 missing 才传播”分别注入，对应用例都失败。

**S2 的三条不变量（写在 reducer 里，必须保留）**：判据由它命名的验证器实现裁决；执行者不自判自己的 run（角色 + 身份双重校验）；每条判据都有 pass 才 verified（拒绝时点出缺哪条）。

**门禁自检两次抓到真实缺陷**（这是它的价值）：`no-unreferenced-export` 曾有一条"入口文件存在即算引用"的捷径使它永不可能失败；剥离字符串后 `single-durable-writer` 失效（import 说明符是字符串），所以**说明符读原文、名字引用读剥离文本**。

## 6. DSH 版本对齐（本轮的"对齐到最新"落成了机制）

**事实**（2026-10-09 实测）：

| | 版本/提交 |
|---|---|
| **宿主（我们运行其中的 DSH CLI）** | **`0.2.0-rc.2`** |
| 本地核心包（`dsh-session` / `-persistence` / `-persistence-jsonl`） | `0.2.0-rc.2` |
| `@deepseek-ai/cordis` | **`4.0.4`**（**独立版本线**，不与 `dsh-*` 同号） |
| checkout（`thirdparty/deepseek-harness`） | `639ed01539` = `v0.2.0-rc.2` 发布合并 |
| 上游 HEAD | `d743267388641bc76f17c45ce8b4c231aed1d32c`（已前进） |
| 上游最新 tag | **`v0.2.1-alpha.2`**（alpha） |
| registry `latest` | **`0.0.1-rc.1`（陈旧，远落后于宿主）** |
| registry `next` | `0.2.0-rc.2` |
| registry `alpha` | `0.2.1-alpha.2` |

**决定：对齐到宿主运行的版本（`0.2.0-rc.2`），不是对齐到最新发布的。**

理由：这四个包是 **peerDependencies，由宿主 DSH profile 在运行时提供**。声明 `0.2.1-alpha.2` 就是声明一个**宿主不提供的版本**，运行时必然不成立。"最新"在这里有三个候选，而**只有宿主实际提供的那个是对齐目标**。

**搬家条件（写进基线文件，不是写在这里就算）**：当宿主 CLI 被升级时——更新 `dsh-baseline.json` 的 `dshVersion` 与逐包条目，然后重跑 `pnpm verify` 与 `node scripts/control-probe.mjs`。在此之前**不升级**。

**机制（这才是"对齐"的落地）**：`dsh-baseline.json` 是单一事实来源，门禁 **`dsh-alignment`** 强制四处不得漂移：

1. 基线声明的每个包版本 == **宿主实际安装**的版本（逐包，因为 cordis 是独立版本线）；
2. `package.json` 的 `peerDependencies` == 基线（漏声明就是"宿主无法提供我们没命名的东西"）；
3. `tsconfig.json` 的每个 `paths` 目标都在基线 `installRoot` 之内（**tsconfig 无法计算，只能靠门禁**）；
4. `vitest.config.ts` 与 `scripts/dsh-control-runtime.mjs` 里出现的每个安装路径都等于基线 `installRoot`。

这条门禁第一次运行就抓到**我基线文件里的一个真实错误**（把 cordis 写成了 `0.2.0-rc.2`），自检第三次抓到探针自身的问题（探针还在覆盖一个已不存在的顶层 `version` 键——改成按包覆盖后才触发）。

**陷阱**：registry 的 `latest` 是 `0.0.1-rc.1`。照 `latest` "升级"会是**大幅降级**。这也是"永不从 registry 装"这条规则的实质原因，而不是洁癖。

## 8. 旧仓行为参照（证据 A，本轮到齐）

**交付物**：[`docs/legacy-behaviour-reference.md`](legacy-behaviour-reference.md)（266 行，每条带 `path:line`；只读、未跑构建、旧仓未改动）。

**我自己复核过的五处承重结论**（不转述）：

1. **分解门是机构不是提示词**：`task-runtime/src/orchestration/child.ts:576-582` 要求每个 `dependsOn` 都在 `verified` 集合里；`:658-663` 对 terminal-but-unverified 的依赖**阻塞并带具名理由**。只有 `verified` 满足依赖。回归：`tests/integration/a3-coordination-loop.spec.ts:450-453`、`a6-recovery.spec.ts:333-340`。
2. **责任转移不变量不存在**：搜 `cannot continue|no longer continue|不可继续|责任转移`，仅三处命中且全无关（run 继续 `observe.ts:254`/`drivers.ts:567`、proposal 归属 `proposals.ts:407`）；`task-runtime/src/handoff.ts:20-21` **自认**"只持久化 handoff 的数据"。→ **B 的责任不变量是新建，不是移植。**
3. **二维 CAS**：`pointer.ts:371-376`（`revisionId` + `generation`）与**中途重检** `:415-422`（第三方移动了指针则拒绝、不覆盖）。
4. **verifier 版本是手写字面量**：`command-verifier.ts:181` `'1'`（`review-`/`composite-` 同）；`verifier/src/index.ts:374-380` 的 `stampVersion` **覆盖** verifier 自报的版本。`index.ts:432` `artifactRefs: []` **恒空**——判决不绑定任何具体产物。
5. **group 是只写不读**：`group/add`/`member/add` 只出现在 reducer（`graph/src/service/state.ts:32,35`）与类型联合（`graph/src/types.ts:43-44`），**无生产生产者**；`groups` 不在消费者投影里（`map/src/types.ts:30-36`）。

**净结果**：**COPY** = 分解 DAG + verified-only 门 + 阻塞带理由、节点状态规则、二维 CAS、bubble 的 clone-per-round + 冻结方法卷绑定、verdict 行为 + **verifier selftest 门（必须既有 pass 样本又有 fail 样本）**、receipt 的"固定来源"目标。**REUSE-DSH** = 会话 create/resume、`$DSH_HOME` 掩蔽、工作区租约。**DROP** = `GroupNode`/`group/add`/`member/add`/`routerFor`/"router 是唯一对外端点"、`artifactRefs: []` 与 `id@version` 字符串绑定、`BubbleManifest`、整棵 `$DSH_HOME/singularity/environments/…` 目录形状 + `intent.json` + `completions.jsonl`。

**三处"注释描述了义务、代码没实现"**（旧仓的复发模式，必须防）：

1. `bubble.ts:4-8` 声称 bubble 隐藏 checkout 与 `$DSH_HOME`；bubble **无任何隐藏代码**（无 env scrub、无 read-deny），方法卷只是**多加**一个 skill root（`spawn.ts:99-104`）。掩蔽在 DSH sandbox（`docs/bubble-mcp-requirements.md:7`）。
2. `bubble.ts:246-248` 声称 clone"自包含"，但本地 `git clone` **硬链接**对象库到母港，母港 `gc`/prune 会改共享 inode。
3. RRSI 的 `CandidateFact.edits` **被读**（`selection.ts:117-118`、`history.ts:110,129`、`screen.ts:51-54`）而**两个生产生产者恒为 `[]`**（`method-shared.ts:554-563`、`methods.ts:296-302`）→ **机制新颖度/机制产出/简化信号静默恒空**。这比"字段没填"更坏：恒 0 会被发现，**被读的恒空不会**。

**三处 RRSI 死字段独立复核确认**（无一处被证伪）：`incumbentMechanismCounts`（`selection.ts:111,118` 只读；唯一生产调用方 `observe.ts:177-184` 不传；`selectRound` 无生产调用方）；`edits`（见上）；`consumption`（`history.ts:20,30`；`foldHistory` **从不引用** → 连读者都没有，**可直接删**）。

**"graph 在 bubble 里"在旧仓不是真的**：bubble 目录下没有任何 graph store/service/`TaskSnapshot`；`graphId` 只出现在分支名与一个 manifest 字符串里。`round-N` 只是目录嵌套，graph 留在自己的 store。review R08 说"目录嵌套本身不能定义'graph 在 bubble 里'"——已证实。

## 9. B 的直接后果（由证据 A 推出，不待证据 B）

- 责任不变量**新建**（旧仓没有），门牙咬在 `run/started` 只接受当前责任人身份 → 新增具名拒绝码 `not-responsible`（`REFUSAL_CODES` 26 → 27，必须配反例测试）。
- 分解用**一条完整事实**（`task/decomposed` 携带全部子与边），不是 N 条 `DependencyAdded` + 一条 `TaskDecomposed`——依据 context §4.3 第 9 条（DSH 的 `append([a,b])` 不是崩溃原子事务）。
- revision 不可变用 **reducer 自校验**（同 id 异内容拒 + 内容摘要重算），**不是**旧仓的 path-exists（`store.ts:222-223`，且无 chmod）。
- receipt **派生 + 内容寻址 + 含实现摘要**；**不采用**旧仓"完全不提 verifier"换来的固定来源（那与 `artifactRefs: []` 是同一种病）。
- `task` 协议升 **v2**（`evidence/produced` 与 criterion 各增必填 `implementationDigest`），**v1 按 `version-mismatch` 具名拒绝，不写兼容层**。

## 10. 证据 B：已装 DSH 的缝实测（11 个可重跑脚本）

**交付物** `/home/ROXY/code/dsh-phase-b-probe/`（`REPORT.md` + 11 个脚本 + `out/*.txt`；`singularity-core` 未被触碰）。**我复核过的承重声明**：`ctx.agents: AgentRegistry`（`dsh-agent`）、`AgentLoop implements AgentFactory`（`dsh-agent-loop`）、`agentTeams: TeamService`、`approval: ApprovalService` + `'approval/asked'`/`ApprovalRequestId`、`callId?: ToolCallId` **且无摘要**、`trustedIdentity|principal` **零命中**、`static inject: string[]`。

**存在**：`ctx.agents.create({sessionId,…})` / `resume({resumeSessionId})`（用**桩 LlmAdapter** 跑完整轮，无网络无凭据）；`ctx.subagents`（spawn/fork/`startContinuable`/`sendMessage`/`listChildren`/`listDescendants`）；`ctx.agentTeams`（**实验性**，只有 Team 局部 role）；`ctx.approval.request` 四态。

**不存在**（据此定案，别再找）：通用 group 服务；group router / 唯一对外端点；绑定到角色的**受信身份**；持久化的审批授予（只有审计对 `approval/asked`+`approval/decided` 与 policy 旋钮）；审批的载荷摘要绑定；`@deepseek-ai/dsh-approval`；**活跃 append 缝上的 `ignorable`**。
两个近似物**不是**它们：`groups` 的命中是客户端 UI 的 `ConversationGroupRegistry` 与模型目录的 `ModelProviderGroup`；`ConfiguredAgentIdentities` 是 launcher 配置 `agent id → {sessionId, resume}`（只在 `dsh-agent-loop` 包内消费），不是主体认证。

**八个实测陷阱**（每一个都会安静地毁掉一个假定）：

1. **`session.append(unknownType, …)` 正常 resolve、写入一条无 `ignorable` 的持久行，然后让整份会话报废**——之后每次读与 `ctx.agents.resume()` 都抛 `SessionFormatUnsupportedError`。外来事件必须走裸 `SessionHandle` + `ignorable: true`（这正是 A 的设计）。
2. `ctx.sessions.create()` 看着像持久，其实**什么都不写**（`flush()` 返回 `participated=false`，且不报错）。
3. 插件的 `inject` 依赖缺席时**静默不存在**（`ctx.authorization` 在 credentials provider 出现前是 `undefined`）→ 已成为 B 的约束 10：**装载期断言所需缝存在**。
4. `resume()` 会写，所以需要 write 租约。
5. 可继续子代理发 `subagent/start` 而**没有配对的 `subagent/end`**——等那一对会挂死。
6. 可继续子代理 spawn 后**不驻留**（`ctx.agents.get` → `undefined`，roster `inactive`）；陈旧 id 会让 `membership`/`sendMessage` 抛错。→ **上游自己都不把"驻留"做成持久事实**，所以 E3 的"可见节点必有活会话"只能是 ordering。
7. 裸日志路径由会话 **`cwd`** 决定，不是只由 id 决定。
8. 续尾拒绝是**裸 `Error`**，`instanceof` 匹配不到已导出的错误类。

**给 D 的预告（现在记账，届时不用重查）**：原生审批**绑定到确切的 `ToolCallId` + agent，没有载荷摘要、不复制参数**；`allowed-once` 是唯一授予且**不持久**。所以 D 的"批准绑定具体差异"**不能**靠审批缝自带——必须由我们自己的事实绑定内容摘要，审批只提供"人授权过"这一件事。

## 11. K1 交回材料（见 `docs/k1-evidence.md`）

**逐条证据已写完**：12 场景 + 真实模型调用，每条给出观测与证据位置；三处**未观测/未做**的单列在文档末尾（不混进通过项）。三条行为检查是**门禁**而非"记得要跑"的脚本：`control-store-probe`、`root-child-slice`、`recovery-probe`，各自有合成失败探针。

**本轮新增的观测**：
- `scripts/slice-b.mjs`（门禁）——真实纵切 22 项全过：父提出分解 → 子有依赖与责任 → run 钉住真实 revision → bubble 声明真实输入 → **真实验证器 spawn 出去读产物并裁决** → verdict 落为事实 → 结算 → receipt（cutoff + 真实消费 + 产物摘要）。
- `scripts/recovery-probe.mjs`（门禁）——两个边界各一次真实 SIGKILL，21 项全过。**它抓到我命令边界的一个真实缺陷**：前置条件原先在 store 解析命令身份之前求值，丢失答复因此无法通过命令面恢复；修法是把前置条件放进 append 路径（身份之后、reducer 之前），变异证明顺序改回去即以那句拒绝失败。
- `scripts/model-smoke.mjs`——**真实模型补全**（宿主 profile 的 commandcode 路由，`deepseek/deepseek-v4.1-flash`），实测 16 chunks / 收敛 / `"four"` / 2956ms，只断言结构性三条。**两段**：§1 一次真实补全；§2 **真实模型驱动真实 agent turn**——手工挂载 runtime track 用的同一组插件（persistence/sessions/agents/llm/tools/systemPrompt/projections/agentLoop）但**不注册桩适配器**，实测 `turn/start … assistant/message … turn/end`，并从记录的 `assistant/message` 事件读出模型产出文本。断言只取结构性三条。**刻意不做门禁**（依赖网络与凭据）。

**仍未做**：把"真实模型"与"真实 Task 管线"接成同一条（见 `k1-evidence.md` 倒数第二行，并注意不能断言判决为 pass）；group/router（上游没有，且无消费者）。

## 11. 下一轮的第一批动作

**已完成（本轮）**：S1（`src/environment/**`，提交 `d1bed1a`）与 **v2a + S3 验证器半边**（提交 `bbb3dd7`）——`TASK_VERSION = 2`、criterion 与 verdict 各带必填 `implementationDigest`（reducer 比对，**换掉实现即不放行**）、可用性检查也吃摘要、`RevisionRef` 增 `environmentId`、`protocol.ts` 切出 `shape.ts`、`verifierIdentityOf` 与 registry key **统一为全摘要**（此前一个截 12 位、一个是查找键，是静默漏配的隐患）。

**已完成（本轮）**：
- **S2**（提交 `d07c148`）：`src/task/decomposition.ts` + `src/task/tree.ts`。一条完整事实的分解（`dependsOn`/`supports`/`maxRuns`，无环、覆盖面、子 id 唯一，声明 `atomicFact`）+ 全日志投影 `projectTree`。**只有 `verified` 满足依赖**，停止/阻塞沿链具名传播，预算耗尽即 `stopped`，父的完成是派生量。
- **task@3 + agent@1**（提交 `bf1fdbf`）：`task/assigned`/`task/reassigned` + **`run/started` 的责任门**（只接受当前责任人的**身份**；新码 `not-responsible`）；`bubble/opened` + **verdict 的输入绑定**（新码 `evidence-input-mismatch`，同 subject 纯判）；`agent@1` 的 `agent/opened` **引用**真实 DSH 会话且**不声称存活**。一次升版本承载全部"改变历史解释"的变更，v1/v2 按 `version-mismatch` 具名拒绝、无兼容层。
- 四条承重规则各有变异证明：去掉责任门、去掉输入绑定、把"任何终止都算满足依赖"、把"未 verified 的子任务算作接受判据"——每次都只有对应用例失败，文件逐字节还原。

**B 的最后一段已全部完成**（提交 `c26c0be`，证据见 `docs/k1-evidence.md`）：S6 真实纵切（`slice-b` 22 项）、两个边界各一次真实 SIGKILL（`recovery-probe` 21 项）、K1 12 场景逐条交回、完整 `pnpm verify` 输出。仍**未做**的是"真实模型 → 真实产物 → 我们的真实验证器 → 命令边界"接成一条（模型产出内容、真实验证器裁决、verdict 经命令边界落为事实；**不能断言判决为 pass**）——这一条属 C，见 §12。

## 12. C 阶段（可信评估）的进入方式：先冻接口，再四路并行

**C 的退出条件（`review.md` §5 冻结原文）**：好候选通过；高分但越界拒绝；缺失分母正确；每份报告有真实 trials。对应 R02 / R06 / R08。

### 12.1 先修掉那个已经发生的病：账本会烂

**实测**：`c26c0be` 时 `context.md` 声称"36 个文件 / 140 测试 / 9 门禁"；同一提交的真实值是
**44 个 `.ts` 文件 / 177 测试 / 11 门禁**。差了 8 个文件、37 个测试、2 条门禁，**没有任何东西发现**。

这正是旧仓"根因一：形状繁殖没有门禁"在**文档层**的复现：`no-unreferenced-export` 管住了导出，
`dsh-baseline.json` + `dsh-alignment` 管住了版本路径，而"我们声明了多少种协议/kind、各自谁写谁读"
**没有任何机械检查**。

**机制（C 的第 0 项，且是唯一必须串行的前置）**：`protocol-baseline.json` + 一条门禁
`protocol-inventory`。文件逐行列出 `(protocol, version, kind)` 与它的**生产者**与**读者**；
门禁用真实 registry 枚举声明集，与文件**双向**比对：

- 声明了而文件里没有 → "你新增了一个形状，把它的消费者写下来"；
- 文件里有而没声明 → "账本记着一个没人声明的形状"。

形状与 `dsh-baseline.json` 相同，而那条路已经**抓到过一个真实错误**。这就是为什么选它，而不是再写一段散文。

### 12.2 高并行的前提：第 0 轮只冻接口（串行、小）

C 比 B 更依赖接口先定：四个工作流都要编译同一组类型。所以第 0 轮**只**做一件事——
把 `measure@1` 与 `strategy@1` 的**闭合形状与拒绝码**定下来（`MeasurementContext` 的口径摘要、
`TrialPlan` 的固定槽位、`Observation`、`Aggregate`、`RoundInput`），**不写实现**。

这一步就是 S0/B 那个"先抽主干"的动作。它的代价只有一轮，收益是后面四路**互不阻塞**。
之后的任何接口改动都是**升版本**，也就是所有人停下来——所以第 0 轮的产出必须是**真的要用的形状**，
不是"先占个位"。

### 12.3 四路并行（文件域互不相交，各自 owner）

| 工作流 | 独占文件 | 交付 | 对应 |
|---|---|---|---|
| **W1 口径与聚合** | `src/measure/{context,plan,aggregate}.ts`、`tests/measure-*.spec.ts`、`tests/measure-fixtures.ts` | 口径 = 一个摘要（数据集/输入、契约、模型身份、环境、metric 方向与单位与归一化、权重、trial 计划、判断策略）；`TrialPlan` 是**固定槽位**；`aggregate(plan, observations)` 的分母来自**计划**，缺失按冻结策略显式计入 | **缺失分母正确**；R02、R06 |
| **W2 决策层移植** | `src/strategy/{selection,novelty,budget,noise,history}.ts`、`tests/strategy-*.spec.ts`、`tests/vectors/*.json`、`scripts/strategy-vectors.mjs`、`docs/divergence-ledger.md` | RRSI 纯决策函数 + **五处有意收紧各一条反例**；与 Python checkout 的差分向量 + 分歧账本；硬约束在 argmax **之前**判定 | **好候选通过 / 高分但越界拒绝**；R01、R03、R05、R09；ADR 0001 |
| **W3 真实执行器** | `src/measure/execution.ts`、`scripts/measure-runner.mjs`、`scripts/measure-probe.mjs` | k 次 trial，每次一个**稳定身份**与**独立执行证据**；观测只接受来自**按摘要登记的**测量实现（复用 `src/verifier/**` 的纪律，不另造一套）；顺带把"真实模型产出 → 真实验证器裁决 → 命令边界"接成一条 | **每份报告有真实 trials**；R06、R08 |
| **W4 显式轮次** | `src/round/{protocol,submit}.ts`、`tests/round-*.spec.ts`、`scripts/round-probe.mjs` | 一轮 = 一条事实，冻结 incumbent、候选集合、预算、历史截止范围与口径；**`done()` 式提交闸**作为提交区里的 `require`（超预算/标签不符/槽位违反被拒）；保留探索槽是**计划里的槽位**而不是提示词里的一句话 | R01、R04、R05、R07 |

**串行点（单一 owner = 协调者，任何工作流都不许碰）**：
`src/protocol/**`、**`src/task/**`（冻结在 `task@3`）**、`scripts/gates.mjs`、`tests/fixtures.ts`、`docs/**`。

**`src/task/**` 为什么能冻住**：C 关于任务的新事实都放进新协议、挂在**同一个 subject**（task id）上——
"多协议一条日志"就是这个设计的回报。若真需要任务侧的新字段，那是**一次** `TASK_VERSION` 升级，
由协调者批量决定，不是一个工作流顺手加。

### 12.4 老仓六个根因在 C 的暴露面与机制（不是意图，是闸）

| 旧仓根因 | C 最容易复发的样子 | 机制 |
|---|---|---|
| 形状繁殖没有门禁 | C 新增的协议最多 | §12.1 的可检查账本 + `no-duplicate-type-body` + **"加字段 ⇒ 升版本"**，没有第二种加法 |
| 自建上游已有的东西 | 自己写调度器 / 测量框架 / 又一个会话层 | 执行与会话用 DSH；观测的信任复用 `src/verifier/**`；RRSI **只作规格与向量**，永不作为运行时（ADR 0001） |
| 契约声明了没有消费者 | `strategy` 的 kind 先于轮次存在 | 每个新 kind **与它的生产者、读者同一次提交**落地；账本那一行必须写明两者 |
| 该由数据结构保证的交给提示词 | 保留探索槽、预算、"禁止自述数字" | 提交闸是提交区里的 `require`；保留槽是**冻结计划里的槽位**；观测只来自按摘要登记的实现 |
| RRSI 只引进一半 | 公式搬对了、约束掉光了（旧仓实测） | 五处收紧各一条反例；差分向量 + 分歧账本；约束落在命令与门禁里并各有变异证明 |
| 两次大重构没换掉根因 | C 是第三次大加法 | 全部靠上面的闸，不靠"这次注意"；§12.1 那个**已经发生的漂移**就是"账本必须被检查"的实证 |

### 12.5 明确不做（写下来，免得下一个人以为是漏了）

通用沙箱平台、group/router、`storageDomain`、发布/审批状态机（那是 D）、第二套轮次编排、
第二个状态存储、Python 侧的任何运行时调用、给已冻结版本加成员。

### 12.6 第 2 轮（串行整合）与判据

1. 新探针**与门禁接线在同一次提交**（B 的教训：行为检查掉在自动路径外，坏了没人报）。
2. 一条真实的端到端探针：**m ≥ 2 个候选从同一 incumbent 起草** → 各 k 次 trial 真实执行 →
   一个**高分但违反硬约束**的候选必须在 argmax 之前被拒 → 选择 → 发布 → **第二轮读第一轮的事实**
   （R04 的两轮要求）。
3. 证据文档 `docs/c-evidence.md`，格式同 `k1-evidence.md`：逐条观测 + **未观测项单列**。
4. 每条新规则一次变异证明；MISSED 的当场删规则（`debugging.md` §2）。

### 12.7 并行工作流的规矩（B 已证有效的四条，重复使用）

1. 一个文件域一个 owner；共享文件只有协调者动。
2. 每个工作流自带 fixture 文件（`measure-fixtures.ts` / `strategy-fixtures.ts`），不碰 `tests/fixtures.ts`。
3. 交付时报告**量出来的数字**，不是"能跑"。
4. 每轮边界更新 §5 的清单——而 C 之后这份清单是被门禁检查的，不再靠自觉。

**剩余（B 的最后一段）**：

1. **S6 真实纵切**（一件脚本 + 一个探针）：根任务提出并执行分解 → 子任务有明确依赖与责任 → run 钉住**真实已创建**的 revision → `bubble/opened` 声明真实输入 → **真实验证器在真实产物上执行**（经 `runProductionVerdict`）→ verdict 落为事实 → 结算 → receipt（含 cutoff 与真实消费）。**预算耗尽必须实际停止调度**（`projectTree` 的 `stopped` + 命令边界的拒绝），不能只证明声明没被改大。
2. **执行与结算边界各 SIGKILL 一次**：重启后同一 session/身份/责任/绑定可恢复；已提交结果不重复创建或结算；外部不确定操作明确呈现。
3. **K1 12 场景逐条交回**：每条给出观测与证据引用（`review.md` §6 的表；1–5 由 A/S2 满足，6–12 归 B）。**独立探针不能替代产品执行闭环**——但 DSH 生命周期的崩溃恢复探针（并行路线）提供场景 9 的底层观测。
4. 完整 `pnpm verify` + `node scripts/control-probe.mjs` 输出、固定提交。
