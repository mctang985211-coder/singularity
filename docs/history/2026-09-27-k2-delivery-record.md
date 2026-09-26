# K2 交付记录：应用与回滚可恢复（待验收）

- 合同：[execution-prompts/12b-k2-evolution-commit.md](../execution-prompts/12b-k2-evolution-commit.md)；公共合同：execution-prompts/README.md。
- 基线：Singularity `274cb30`（K1 已验收）、外层 `d39f44c5d3`；开工前两仓工作树干净（外层 thirdparty/deepseek-harness 未跟踪变更保留未动）。
- 交付：Singularity `c0c1393`（代码+测试）、`5b503d8`（guide/计划/持久化记录/本记录）及文档收口提交（见 git log）；外层指针 `b1ebb2b` 及收口指针提交（见 git log）。日期 2026-09-27。无真实模型费用、无推送、无部署。
- 执行：实现主代理 + 三个 coder 子代理（分工见文末）。

## 新行为一句话

`evolution_apply`/`evolution_rollback` 经唯一提交入口：人审与晋升/基线重检后先把意图（proposal、方向、approvalRef、目标、前后内容身份、可恢复字节来源）落盘为 `commit_intent`，再同目录 tmp+fsync+原子 rename 替换生产并回读校验，最后记完成行闭合意图；启动/恢复先对账开放意图（旧则补做、新则仅补账、第三态具名停止保留意图），意图未结目标在 provider 准入具名拒绝。

## 验收编号 → 证据

| 编号 | 真实入口 | 测试与实际结果 |
|---|---|---|
| K2-1 | 工具 `evolution_apply`/`evolution_rollback` → `EvolutionService.apply/rollback`（evolution/src/evolution.ts:1295/1638）→ commit.ts `commitIntent` | 恰好一次：单元 evolution.spec.ts K2 段（恢复后再 apply 被状态机拒绝且账本行数不变；新鲜提交行序 `commit_intent→applied`）；工具单元 agent-singularity/tests/unit/evolution-commit-tools.spec.ts（10 例：开放意图零审批对账、无意图仍先人审、拒绝零写零账）；P3 漂移/P2 候选漂移在提交路径零写拒绝（evolution.spec.ts 既有段+K2 段）。unit 59 文件 1823 例全绿 |
| K2-2 | `Config.commitProbe` 三窗口注入（intent-recorded/write-staged/write-renamed）+ 同目录新实例重开 → `reconcile()` | 单元 evolution.spec.ts：3 窗口×{apply,rollback} 注入中断后重开对账得 completed-redone/completed-written、恰一条完成行、approvalRef 取自意图、再 reconcile 为空、tmp 残留不视为已应用；完成后重开无动作；普通异常区分用例（chmod 0555 真实写失败→无完成行、意图开放、恢复权限后 redone）。集成 k2-evolution-commit.spec.ts 用例 1–6（端到端：账本行序列从文件读回、生产字节完整、恢复后经真准入加载）。integration 57 文件 444 例全绿 |
| K2-3 | task-runtime `precheckProviders`（checkRootContract/checkDerivedBatch/replayTask 三准入点共用）软读 `openIntentTargets`；`SingularityAgent` 启动与 `adoptRootThroughBarrier` 先对账 | 集成用例 7：意图开放时 root intake 与 decomposeAndRun 均具名拒绝 `commit-intent-open`、零新 run，同 stack 未注册任何 evolution 工具（off 不旁路），无关 skill 照常准入；屏障对账后同一入口放行；evolution_list/openIntentTargets/list 查询后账本逐字节不变。单元 provider-precheck.spec.ts +7、startup-reconcile.spec.ts 4 例（off 也启动对账）、proposal-lifecycle.spec.ts +3。已绑定 Run 版本不变：provider-version-binding.spec.ts 5 例（含不热换反例）回归全绿 |
| K2-4 | `reconcileIntent` 第三态分支；rollback 意图前生产==已应用内容检查（evolution.ts:1657-1665） | 集成用例 8：外部篡改后屏障 warn 具名、reconcile blocked、生产原样、账本不变、意图保留、准入仍拒；用例 9：s1 applied→s2 applied→rollback s1 零写具名拒绝（生产仍 s2）→rollback s2 恢复 s1 内容。单元 evolution.spec.ts K2 段同覆盖（篡改/来源丢失/生产缺失 blocked 三态） |
| K2-5 | formatVersion 3 load/append 版本闸；九工具+服务唯一提交入口 | 集成用例 10：v3 账重开后真工具 rollback 全链路有效；单元 ledger-version.spec.ts（v1/v2/无版本/混合具名拒绝零写）；evolution-replay-experiment.spec.ts 端到端行序含 commit_intent 且完成行 intentId/approvalRef 与意图一致。grep：`writeProduction` 无命中；生产写仅 commit.ts staging+rename。构建与公共回归见下 |

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

- `pnpm build`（packages/singularity）：exit 0（lib 跟踪产物同步）。
- `pnpm vitest run --project unit packages/singularity`（外层根）：59 文件 / 1823 例全过（K1 基线 57/1759）。
- `pnpm vitest run --project integration packages/singularity`：57 文件 / 444 例全过（基线 56/434）。
- `pnpm run verify-persistence`：OK，4 事件根匹配；`git diff --check`：干净。
- `agent-singularity` `pnpm exec tsc --noEmit`：exit 0；`task-runtime` tsc 维持 8 个既有基线错误（未新增）。
- 决定性验证（子代理 C 执行并已复原）：屏障摘除 `reconcileEvolutionCommits()` 恰好 8 条依赖用例变红；闸 `readCommitGate` 短路恰好 2 条准入用例变红。

## 未覆盖项 / 已知边界

- 合同明确排除：多文件与非 skill 候选的执行器（K3 范围，仍具名拒绝）；分布式锁（单进程部署约束保留）；真实模型效果实验（本票不授权）。
- 崩溃注入为进程内测试缝（注入点中断+同目录重开），非独立 OS 进程 kill——仓库既定 crash 语义（K1 同）；普通异常与进程退出注入分别覆盖。
- 其余：无。

## 子代理分工

- coder A：evolution 包提交机制核心——fv3 记录/fold 不变式、commit.ts 原子写与对账、服务重接线、单元测试。
- coder B：九工具接入（开放意图免重复人审）、provider 准入闸、宿主启动/恢复屏障对账及各自单元测试。
- coder C：集成级崩溃窗口/篡改/竞争/准入/重开证据（k2-evolution-commit.spec.ts 十例）与变异-回滚决定性验证。

## 移交后续票

K3：在同一提交机制上扩对象范围（完整 Skill 单位），前置接口（commit_intent 形状、reconcile、准入闸）已固定；审核通过后才派发。
