# K2 交付记录：应用与回滚可恢复（待验收）

- 合同：[execution-prompts/12b-k2-evolution-commit.md](../execution-prompts/12b-k2-evolution-commit.md)；公共合同：execution-prompts/README.md。
- 基线：Singularity `274cb30`（K1 已验收）、外层 `d39f44c5d3`；开工前两仓工作树干净（外层 thirdparty/deepseek-harness 未跟踪变更保留未动）。
- 交付：Singularity `c0c1393`（代码+测试）、`5b503d8`（guide/计划/持久化记录/本记录）及文档收口提交（见 git log）；外层指针 `b1ebb2b` 及收口指针提交（见 git log）。日期 2026-09-27。无真实模型费用、无推送、无部署。
- 返工（2026-09-27 同日，独立审查定位四处缺口）：基线 Singularity `9ef0441`（上一交付）、外层 `5b12e0f`；返工交付 Singularity `5cba90f`（代码+测试+lib 产物）与本记录所在的文档提交（见 git log）；外层指针提交见外层 git log。触发、行为变更、红绿证据、真实进程退出机制与模拟边界见下文"返工"段。无真实模型费用、无推送、无部署。
- 执行：实现主代理 + 三个 coder 子代理（分工见文末）。

## 新行为一句话

`evolution_apply`/`evolution_rollback` 经唯一提交入口：人审与晋升/基线重检后先把意图（proposal、方向、approvalRef、目标、前后内容身份、可恢复字节来源）落盘为 `commit_intent`，再同目录 tmp+fsync+原子 rename 替换生产并回读校验，最后记完成行闭合意图；启动/恢复先对账开放意图（旧则补做、新则仅补账、第三态具名停止保留意图），意图未结目标在 provider 准入具名拒绝。

## 验收编号 → 证据

| 编号 | 真实入口 | 测试与实际结果 |
|---|---|---|
| K2-1 | 工具 `evolution_apply`/`evolution_rollback` → `EvolutionService.apply/rollback`（evolution/src/evolution.ts:1295/1638）→ commit.ts `commitIntent` | 恰好一次：单元 evolution.spec.ts K2 段（恢复后再 apply 被状态机拒绝且账本行数不变；新鲜提交行序 `commit_intent→applied`）；工具单元 agent-singularity/tests/unit/evolution-commit-tools.spec.ts（10 例：开放意图零审批对账、无意图仍先人审、拒绝零写零账）；P3 漂移/P2 候选漂移在提交路径零写拒绝（evolution.spec.ts 既有段+K2 段）。unit 59 文件 1823 例全绿 |
| K2-2 | `Config.commitProbe` 三窗口注入（intent-recorded/write-staged/write-renamed）+ 同目录新实例重开 → `reconcile()`；**返工后追加真实子进程 SIGKILL 证据** | 单元 evolution.spec.ts：3 窗口×{apply,rollback} 注入中断后重开对账得 completed-redone/completed-written、恰一条完成行、approvalRef 取自意图、再 reconcile 为空、tmp 残留不视为已应用；完成后重开无动作；普通异常区分用例（chmod 0555 真实写失败→无完成行、意图开放、恢复权限后 redone）。单元 commit-durability.spec.ts（返工新增 21 例：来源→意图→rename 的持久化操作顺序、来源目录链与账本目录链各自 fsync、账本/生产目录/来源/来源链 fsync 失败与来源漂移/越界/目标越界各自具名零写、staging 残留清理（提交与"仅补账"结算两处）、写失败截回与"截回也失败"具名、短写不落半行）。集成 k2-evolution-commit.spec.ts（原十例 + 返工七例：**六个真实 SIGKILL 子进程用例**（apply/rollback × 三窗口，父测试断言 signal/死 pid/意图唯一/生产完整版本/残留/补做与仅补账/恰好一条完成行）+ 一例"异常不是退出"对照 + 一例 env 门控嵌套子进程用例）。integration 57 文件 451 例全绿 + 1 例（子进程用例，普通运行跳过） |
| K2-3 | task-runtime `precheckProviders`（checkRootContract/checkDerivedBatch/replayTask 三准入点共用）软读 `openIntentTargets`；`SingularityAgent` 启动与 `adoptRootThroughBarrier` 先对账 | 集成用例 7：意图开放时 root intake 与 decomposeAndRun 均具名拒绝 `commit-intent-open`、零新 run，同 stack 未注册任何 evolution 工具（off 不旁路），无关 skill 照常准入；屏障对账后同一入口放行；evolution_list/openIntentTargets/list 查询后账本逐字节不变。单元 provider-precheck.spec.ts +7、startup-reconcile.spec.ts 4 例（off 也启动对账）、proposal-lifecycle.spec.ts +3。已绑定 Run 版本不变：provider-version-binding.spec.ts 5 例（含不热换反例）回归全绿 |
| K2-4 | `reconcileIntent` 第三态分支；rollback 意图前生产==已应用内容检查（evolution.ts:1657-1665） | 集成用例 8：外部篡改后屏障 warn 具名、reconcile blocked、生产原样、账本不变、意图保留、准入仍拒；用例 9：s1 applied→s2 applied→rollback s1 零写具名拒绝（生产仍 s2）→rollback s2 恢复 s1 内容。单元 evolution.spec.ts K2 段同覆盖（篡改/来源丢失/生产缺失 blocked 三态） |
| K2-5 | formatVersion 3 load/append 版本闸；九工具+服务唯一提交入口 | 集成用例 10：v3 账重开后真工具 rollback 全链路有效；单元 ledger-version.spec.ts（v1/v2/无版本/混合具名拒绝零写）；evolution-replay-experiment.spec.ts 端到端行序含 commit_intent 且完成行 intentId/approvalRef 与意图一致。grep：`writeProduction` 无命中；生产写仅 commit.ts staging+rename。构建与公共回归见下 |

## 返工（2026-09-27 同日，独立审查定位）

触发：K2 交付后独立审查（Sol 定位）认定四处缺口，都属合同 K2-2 与第 1/2 条要求的行为或证据，不是范围外增强：①`evolution.ts:2211` 的 `append()` 只 `appendFile`、不 fsync，断电可留下"生产已是新内容、意图行丢失"；②`commit.ts:340` 的 `syncDirectory` 吞掉全部错误，rename 后的目录 fsync 失败仍被当成成功并记完成；③可恢复来源在意图前既未确认存在/未验证、也未稳定；④`tests/integration/k2-evolution-commit.spec.ts:133` 的 `commitProbe` 只是普通异常，不能冒充真实进程退出。四处在同一票内闭合，未改验收、未写成已知边界。返工后再经同一审查者独立复核（逐条核验 + 变异测试），下述数字与结论取自这些实跑。

### 行为变更

| # | 变更 | 落点 |
|---|---|---|
| 1 | 账本唯一 durable append：`open('a')` → 写整行（write-all 语义）→ fsync 文件 → close → fsync 账本 root 与 `mkdir` 新建目录链（每个新建目录 + 命名它的父目录）；写失败把文件截回追加前长度（截回失败则具名说明"可能留半行"，绝不假装干净），fsync 失败具名抛错且不把该行当已持久；`append` 漏斗与 `recordExperimentStart` 共用（账本不再有第二条写门） | `evolution/src/evolution.ts` `appendLedgerLine`/`ledgerDirectories` |
| 2 | rename 后目录 fsync 失败 = 具名失败：点名目录与目标、"may or may not be durable"、意图保留、不记完成、不得当作已结算；`syncDirectory` 不再吞错 | `commit.ts` `writeFileAtomic`/`syncDirectory` |
| 3 | 来源在意图前确认并稳定：目标先于写入 confine（`productionRelative`）→ 来源限账本 root 内（`ledgerRelative`）→ `host.readSource` 重读重验摘要 → `syncSource` fsync 文件并从来源目录一路 fsync 到 ledger root；任一步失败 = 具名停止、零行零写 | `commit.ts` `commitIntent`/`syncSource`/`sourceDirectories` |
| 4 | 完成行只在 rename 可持久后出现：对账 `completed-written` 分支先清该目标 staging 残留 → fsync 生产目录 → 才记完成；目录 fsync 失败具名停止、意图保留（否则"先拒绝记完成、下一次 reconcile 又照记"就等于宣称安全） | `commit.ts` `reconcileIntent`/`syncTargetDirectory` |
| 5 | staging 残留：提交与"仅补账"结算都清理**本目标** `.SKILL.md.tmp-` 前缀的残留（同目录、跳过目录项、失败具名停止），其他目标与第三方文件不动（单写者 + 进程内串行前提写在 JSDoc） | `commit.ts` `sweepStaging` |
| 6 | 真实进程退出证据 + 异常/退出分离：集成 spec 新增 env 门控嵌套子进程用例与六个真实 SIGKILL 端到端用例、一例对照用例；`crashProbe`→`throwingProbe`，集成/单元/工具单测里"抛异常＝进程退出"的措辞全部清除 | `tests/integration/k2-evolution-commit.spec.ts`；`evolution/tests/unit/evolution.spec.ts`；`agent-singularity/tests/unit/evolution-commit-tools.spec.ts` |

### 红绿证据（未修源码先复现）

- 缺口 1：新 `evolution/tests/unit/commit-durability.spec.ts` 对未修源码 `11 failed | 3 passed (14)`；代表失败：`the source file is fsynced: … expected -1 to be greater than or equal to 0`、`expected '' to match /simulated ledger fsync failure/`、`expected '' to match /simulated production directory fsync …/`、`expected true to be false`（植入的 `.SKILL.md.tmp-…` 未被清理）。以最终测试字节对回退源码复跑同样 `11 failed | 3 passed`（3 条通过是刻意保留的"本就正确"行为）。
- 缺口 1 补充轮（复核 F1/F3/F4/F7 之后）：三个新用例对回退源码 `5 failed | 13 passed (18)`（来源目录链、写失败截回、目标越界、结算清理各一条 + 一条连带）。
- 缺口 2：用 `git archive HEAD` 取纯净源码跑最终测试字节 → `2 failed | 5 passed | 11 skipped`，失败正是两个 `write-staged` 用例的"结算后残留为空"：`expected [ Array(1) ] to deeply equal []` + `[ ".SKILL.md.tmp-1089037-98e8418b3528" ]`；其余五个窗口与该对照用例在未修源码上即通过，说明本轮的实修点只有残留（真实死亡留下、回退前不会被清理），断言不是空转。
- 绿：`pnpm vitest run --project unit packages/singularity/evolution` 7 文件 / 310 例；`k2-evolution-commit.spec.ts` 17 passed + 1 skipped（跳过的是子用例，普通运行不会杀任何进程）；全量见"必跑检查"。

### 真实进程退出是怎么证的

- 机制：父测试用 `process.execPath` 启动 `node_modules/vitest/vitest.mjs run --project integration --pool=threads <本 spec> -t <唯一子用例名>`，窗口/方向/工作区经 env 传入；子进程在**同一个 workspace** 上 boot 同一 stack、同一 `EvolutionService`，`commitProbe` 在指定窗口执行 `process.kill(process.pid,'SIGKILL')`。`--pool=threads` 是用例体与 `spawnSync` 启动的那个进程同体的前提——独立复核实测：去掉它父进程只能看到 `status 1 / signal null`，加上它才是 `SIGKILL / null`。
- 父测试断言（每条都从磁盘读回）：`child.signal === 'SIGKILL'`、`child.status === null`；子进程提交前写下的 marker 的 pid == `child.pid` ≠ 本进程 pid，且 `process.kill(pid,0)` 抛 `ESRCH`；账本恰好一条 `commit_intent`、无完成行；生产逐字节等于意图命名的两个完整版本之一；`write-staged` 留下带子进程 pid 的 staging 残留（普通异常不会留下——`catch` 会删），其余窗口没有；重开后 open intent 可见、准入具名拒绝（`commit-intent-open`）、宿主 `adoptRoot` 屏障结算；`write-renamed` 以 inode+mtimeMs+size 不变证"仅补账"，其余窗口以生产等于意图 `contentSha256` 且残留被清证"补做"；恰好一条完成行、再次 reconcile 为空、账本逐字节不变。
- 异常与退出的区分：`throwingProbe` 的 JSDoc 与消息明说 "a throw, not a process exit"；对照用例断言异常可被同一进程捕获、staging 已被写者自己的错误路径删除、同一实例随后自行结算（`completed-redone`）。
- 模拟边界：真实进程退出证明的是"崩溃点落在正确顺序上"，不是断电语义；断电/页缓存/重排由确定性 fs 操作注入断言"发了哪些持久化操作、顺序如何、失败如何处置"——`vi.mock('node:fs/promises')` 只替换 fs 调用，服务、fold、账本、驱动都是真的，注入的 fsync 失败只表示"调用报错"，不表示"数据丢了"。真实 EIO 无法稳定制造，故用注入；`proposals.jsonl` 为目录的用例是真失败、无注入。

### 独立复核结论（返工后）

- 八条主张逐条核验：持久化 append 与目录链、来源确认与稳定、目录 fsync 具名与"仅补账"先 fsync、staging 清理、无格式变化、真实退出机制、异常/退出区分、会话交接不绕过晋升检查。其中 F1（来源目录链未 fsync → 意图可能命名无法解析的来源）被证伪并已修；F2（单元 spec 仍称"抛异常＝进程退出"）措辞残留并已修；F3（"写失败文件未被触碰"过度声明）改为真的截回 + 文档精确化；F4（目标 confine 在写入之后）提前到写入前；F7（"仅补账"结算不清残留）补齐。
- 变异测试（复核者执行，逐项复原并校验哈希）：删账本文件 fsync / 删来源 fsync / 删 staging 清理 / 删"仅补账"目录 fsync / rename 后 fsync 退回 best-effort / 子进程改抛异常 / 清理前缀放宽为任意 `.tmp-` / 整行写改单次 `write` / 去掉子进程会话交接 / 来源链只留文件自身目录 / 删截回 / 删结算清理 / 去掉提前 confine——每一项都被对应用例变红，无存活变异。
- 复核给出的未覆盖项记入下文"未覆盖项"。

## 删除位置

- `evolution/src/evolution.ts`：`writeProduction` 方法（原 :1438-1469，两处裸 `writeFile` 写生产）整体删除；模块头与 apply/rollback JSDoc 中「生产写先于账本 append」旧陈述重写为意图先落盘规则。
- `evolution/tests/unit/evolution.spec.ts`：旧 P3-G「rollback 覆盖语义」用例被 K2 行为（生产≠已应用内容零写拒绝）取代。
- 未新增事务框架/补偿注册表/重试队列/转发层；无旧 reader/兼容路径。

## 持久化

ledger 单版本切换 `formatVersion: 3`（新增 `commit_intent`；`applied`/`rolledback` 必填 `intentId`），v1/v2 在 load 与写边界具名拒绝，无迁移/双读。现场真实旧账 `.dsh/evolution/proposals.jsonl`（21 行 v1，两条 applied 均已 rolledback，无未闭合 applied/意图）按原字节归档为 `proposals.jsonl.v1-archived-2026-09-27`（sha256 `39291998…a261bb` 归档前后一致），新账从空启动。记录：[persistence-changes/2026-09-27-k2-evolution-commit-intent.md](../persistence-changes/2026-09-27-k2-evolution-commit-intent.md)（非 SessionEventMap 根，无 schema 兄弟文件）。`verify-persistence` 4 事件根 OK。

## 400 行以上触及文件处置

- `evolution/src/evolution.ts`（1902→2387）：保留为账本/状态机/fold/晋升门所有者；提交机制包内拆分至新 `evolution/src/commit.ts`（350 行），阻止主文件继续膨胀。
- `task-runtime/src/index.ts`（约 7 千行）：仅两处接入——`adoptRootThroughBarrier` 首步对账、precheck 注入 commitLedger；属既有恢复屏障/准入职责，不新建包。
- `task-runtime/src/provider-precheck.ts`：准入闸内聚于既有 precheck 判定链；`sidecar.ts` 仅增两个 defect code 词表成员。
- `agent-singularity/src/index.ts`：启动对账接于既有装配插件 `Service.init`。
- `evolution/tests/unit/evolution.spec.ts`（3342→4036）：测试文件，K2 用例集中尾部新段。
- `tests/integration/k2-evolution-commit.spec.ts`（716，新增）：整票集成证据集中一处，与 k1-exploration.spec.ts 同例；`tests/support/run-stack.ts` +16 纯增量可选 `workspace` 参数（同目录重开所需）。

## 必跑检查（实际结果）

原交付（`c0c1393`，保留原样）：`pnpm build` exit 0；unit 59 文件 / 1823 例；integration 57 文件 / 444 例；`verify-persistence` OK；`git diff --check` 干净；`agent-singularity` tsc exit 0，`task-runtime` tsc 维持 8 个既有基线错误；决定性验证（子代理 C 执行并已复原）：屏障摘除 `reconcileEvolutionCommits()` 恰好 8 条依赖用例变红，闸 `readCommitGate` 短路恰好 2 条准入用例变红。

返工（`5cba90f`，全部在主代理集成后重跑）：

- `pnpm build`（packages/singularity）：exit 0（lib 跟踪产物与 src 一致，复核者另以 byte-identical 复现确认）。
- `pnpm vitest run --project unit packages/singularity`（外层根）：60 文件 / 1844 例全过（原交付基线 59/1823；新增 `commit-durability.spec.ts`）。
- `pnpm vitest run --project integration packages/singularity`：57 文件 / 451 例全过 + 1 例跳过（跳过的是 env 门控的嵌套子进程用例，只在被父测试以 env 启动时运行）。
- `pnpm vitest run --project unit packages/singularity/evolution`：7 文件 / 310 例；`k2-evolution-commit.spec.ts`：17 passed + 1 skipped。
- `pnpm run verify-persistence`：OK，4 事件根匹配；`git diff --check`：干净。
- `agent-singularity` 与 `evolution` `tsc --noEmit`：exit 0；`task-runtime` tsc 仍为 8 个既有基线错误（未新增）。
- 独立复核自跑并复原：变异测试 13 项逐一被对应用例变红（清单见"独立复核结论"），无存活变异；复核结束复核者以 `git diff | sha256sum` 与备份 `cmp` 证明工作树与其开工时逐字节一致。

## 未覆盖项 / 已知边界

- 合同明确排除：多文件与非 skill 候选的执行器（K3 范围，仍具名拒绝）；分布式锁（单进程部署约束保留）；真实模型效果实验（本票不授权）。
- 故障证据的边界（不是行为缺口）：真实进程退出证明"崩溃点落在正确顺序上"，**死亡瞬间**由磁盘状态与子进程 pid marker 界定，没有独立 trace；断电/页缓存/存储重排用确定性 fs 操作注入断言"发了哪些持久化操作、顺序、失败处置"（只替换 `node:fs/promises` 调用，服务/账本/fold/驱动真实），它不模拟真实断电——真实 EIO 无法稳定制造。真实进程退出与 fs 注入都真正执行被测代码，未被任何 mock 替代。
- 仍未被注入的分支（低危，均已具名抛错、其正向路径由用例覆盖）：账本 root 目录自身的 fsync 失败、账本追加前 `handle.stat()` 失败（注入层把 `stat` 直通真实实现）；"写失败后的截回"与"截回也失败"两条分支都已有用例。
- 其余：无。

## 子代理分工

原交付：

- coder A：evolution 包提交机制核心——fv3 记录/fold 不变式、commit.ts 原子写与对账、服务重接线、单元测试。
- coder B：九工具接入（开放意图免重复人审）、provider 准入闸、宿主启动/恢复屏障对账及各自单元测试。
- coder C：集成级崩溃窗口/篡改/竞争/准入/重开证据（k2-evolution-commit.spec.ts 十例）与变异-回滚决定性验证。

返工（2026-09-27 同日）：

- coder A（同一子代理续跑）：账本 durable append 与截回、来源确认与目录链 fsync、目标提前 confine、目录 fsync 具名失败、staging 残留清理（提交与结算两处）、`commit-durability.spec.ts`（21 例，含 fs 操作注入层）与 `evolution.spec.ts` 措辞改写。
- coder B（同一子代理续跑）：真实子进程退出证据——env 门控嵌套子进程用例与机制、六个 SIGKILL 端到端用例、异常/退出对照用例、`throwingProbe` 改名与集成 spec 头部改写、`run-stack.ts` 会话交接夹具。
- 独立审查子代理（与实现分离）：返工前定位 F1～F7（含来源目录链、写入=进程退出的措辞残留、过度声明、目标 confine 时序、结算不清理），返工后逐条复核并追加 13 项变异测试，证明每项修复都有对应用例变红、工作树复原。
- 主代理：接口拆分与派发、自身复核（两份 review finding 由主代理定位后回派）、集成、全部公共检查、guide/计划/持久化记录/本记录同步、提交与提交信息。

## 移交后续票

K3：在同一提交机制上扩对象范围（完整 Skill 单位），前置接口（commit_intent 形状、reconcile、准入闸）已固定；审核通过后才派发。
