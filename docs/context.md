# context.md —— 跨轮工作记忆

> **每轮结束更新此文件。** 只放"下一轮必须知道、丢了会走错路"的东西。
> 长文档：`docs/blueprint.md`（蓝图）、`docs/review.md`（第一轮审核 + K1/K2 检查点）。
> 上一轮更新：2026-10-09（第二轮：修完审查 §2 的全部反例；F01 承载实验与 RRSI 复核均已回）。

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
| **A** | 专用控制 store、DSH 承载、串行提交、严格边界、命令结果识别 | 双进程互斥；并发命令正确；屏障失败不返回成功；提交后/答复前崩溃可识别原结果 | **进行中**：串行提交 ✅、命令识别 ✅、严格边界 ✅、DSH 承载实验 ✅（见 §4.1）；**剩余：把存储接到已知 DSH 事件类型上** |
| **B** | 最小 E3、Task 分解与责任、初始不可变 Revision、最小 Bubble、真实 verifier 与固定来源 receipt | 根/子任务执行与依赖推进；产物独立验收；SIGKILL 后恢复同 session/责任/绑定 | 未开始（**K1 检查点**） |
| **C** | 冻结双侧输入、真实领域取数、非补偿约束、真实重复与噪声依据 | 好候选通过；高分越界拒绝；缺失分母正确；每份报告有真实 trials | 未开始 |
| **D** | draft 状态机、E6 原生审批、决定重算、唯一指针切换 | 批准绑定具体差异；陈旧/内容变化拒绝；head 不引用半成品 | 未开始 |
| **E** | 显式 round、真实历史与 frozen deltas、m≥2 选优、探索/剪枝消费者、消费反馈 | 至少两轮；第二轮读第一轮；历史不被新 head 改写 | 未开始（**K2**） |
| **F** | 关键行为回归、领域任务集对照、部署替代 | 恢复/边界满足新契约 | 未开始 |

**下一次重要审核在 A+B 完成时**。A 的承载实验已成功 → 可以进 B。

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

**因此控制 store 的形态（这是阶段 A 的剩余工作）**：

- **每个控制记录一条 DSH 事件，事件类型必须是"已知的、log-only（非 surface）"类型**；`data` 完全由我们拥有。
- 外层形状：`{ protocol: 'singularity.control', version: 1, kind: <我们的闭合集>, payload: <我们的 JSON> }` 作为该事件的 `data`。
- **活会话**（root agent 持有写句柄时）：`ctx.sessions.get(id).append(knownType, envelope)` → **必须** `await ctx.sessions.flush(session)`；`false` 即失败。
- **非活会话**：自己开 `write` 句柄 → `append` → `await handle.flush()` → `close()`。
- **绝不从活跃缝设置 `ignorable`**（也设不了），绝不用它夹带外来类型。
- **装载时由我们做全部语义校验**：拒绝未知 `protocol`；拒绝不支持的 `version`；`kind` 必须在我们闭合集内；按 kind 严格校验 `payload`；拒绝未知字段与重复。
- **不得只凭 DSH 事件类型判断归属**：读日志 → 选 `data.protocol` 属于我们的事件 → 逐个校验。
- **DSH 只保证**信封形状 + 词表成员 + 深冻结物化（`adoptSessionEvent`）；**每一个语义检查都是我们的**。

**会打破它的因素**：非无损 JSON 或超大载荷 → `materializeAppendBatch` 抛 `TypeError`，记录根本不落；选到 **surface** 宿主类型会拖入 message 形状与 `surfaceManager.validateNext` → 必须选 log-only；**在更新版 harness/词表/格式下 resume 会整份会话拒绝**（`assertVersion`、`validateStoredEvents`）→ **我们的事实随日志一起死**；`Session.append` 在写入时不拒绝未标记的未知类型，伤害只在下次读出现；卡住的写者无限持有 flock（**故意无过期**）→ 没有基于租约超时的恢复。

**另一处更正**：review §7 的 E01 复核脚本用的导入路径 `dsh-session-persistence/lib/types/storage-contract.js` **在装好的 build 里不存在**；`validateStoredEvents` 由 `dsh-session-persistence/lib/index.js` 导出。复核时要用后者。

### 4.2 RRSI：**我现在亲自读过上游源码**（此前只读 README）

**完整对照件：[`docs/rrsi-upstream-reference.md`](rrsi-upstream-reference.md)**（逐条带行号，并明确标注未读范围）。

已逐行读：`selection.py` `components.py` `evaluate.py` `schedule.py` `history.py` `calibrate.py` `domain.py` 接口 `loop.py` 的 `round()` 与 `readjudicate()`。
**未读**：`propose.py` `analyst.py` `digester.py` `critic.py` `driver.py` `config.py` `gitops.py` `llm.py` 及 `loop.py` 其余 ≈1400 行。

**我此前的一处符号错误**：蓝图 §2.3 写「每轮 **k** 个候选」——实际是**每轮 `cfg.m` 个候选**（`loop.py:292`，标签 A..H），**`k` 是每任务 trial 数**。review 的 R01 已指出，我当时只改了口径没改蓝图正文。

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

`src` 1721 行 / `tests` 1306 行 / 15 个源+测试文件；**55 测试**；**7 门禁 + 门禁自检**。

- `src/protocol/{refusal,envelope,registry,fold,log}.ts` —— 一个拒绝契约、一个信封、一个版本闸+保证词表+发射者纪律、一个 fold 引擎、一条追加路径（提交队列 + 命令识别 + 提交前 dry-run）。
- `src/task/{contract,protocol,view}.ts` —— 契约（shape 纯 / 可用性命令期）、5 种 kind、唯一读投影 + G4 派生 receipt。
- `scripts/gates.mjs` —— 7 条门禁 + `--probe` 自检（每个静态检测器都必须能失败）。
- `scripts/slice.mjs` —— 端到端冒烟（第 7 条门禁跑它）。

**S2 的三条不变量（写在 reducer 里，必须保留）**：判据由它命名的验证器实现裁决；执行者不自判自己的 run（角色 + 身份双重校验）；每条判据都有 pass 才 verified（拒绝时点出缺哪条）。

**门禁自检两次抓到真实缺陷**（这是它的价值）：`no-unreferenced-export` 曾有一条"入口文件存在即算引用"的捷径使它永不可能失败；剥离字符串后 `single-durable-writer` 失效（import 说明符是字符串），所以**说明符读原文、名字引用读剥离文本**。

**判定要删/要换**：`ProtocolLog` 的文件存储实现（fsync/读回/size/摘要链）——按 §4.1 换成"已知 DSH 事件类型 + `append` + `flush`"；`ProtocolLog` 降为纯内存测试后端。门禁 `single-durable-writer` 届时应收紧为**零持久写者**。

## 6. 下一轮的第一批动作

1. **阶段 A 收尾**：按 §4.1 建 `SessionEventSink`——选一个**已知 log-only** DSH 事件类型，`data` 里承载 `{protocol, version, kind, payload}`；`append` + `await flush`（`false` 即失败）；`ProtocolLog` 降为内存后端；门禁收紧为"零持久写者"。
2. **补一个我们自己的双进程控制 store 探针**（F02 的退出条件）：两个进程各以 `write` 打开同一 session，第二个拿 `SessionAlreadyOwnedError`；杀持有者后立即接管。
3. 更新 `docs/blueprint.md`：阶段表换成 review §5 的 A–F，骨架数据更新，**不把未实现标为已完成**。
4. 进阶段 B（真实执行纵切），K1 检查点在 B 完成后。
