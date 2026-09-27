# A6：capability 表文件的组合身份（formatVersion 4 内，无版本变化）

kind: persistence-change

Evolution 外部账本 `proposals.jsonl` 的记录仍统一用 `formatVersion: 4`。本记录覆盖的 root 不是 SessionEventMap 根，`verify-persistence` 不涉及此账本（同 S4-E/K2/K3 记录的分工）；兄弟 `.schema.json` 因此重复**未变化**的事件根清单（见文末）。

## 变化内容（相对本记录之前）

`prepared` 行新增一个可选的 `capabilityTable`（仅 capability prepare 写，EVO-2 的“内容漂移”缺口）：

```json
"capabilityTable": {
  "baselineSha256": "<hex64>",
  "applySha256": "<hex64>",
  "rollbackSha256": "<hex64>"
}
```

三个值都是**整份 deploy 配置表文件**（`Config.capabilityConfig`，即重启读回 registry 的那份 `config.yml`）的 SHA-256：

- `baselineSha256`：prepare 读到的文件本身；
- `applySha256`：apply 把候选行写进去之后的那份文件（`applyCapabilityRowToConfig({text: baseline, name, entry})` 的结果）；
- `rollbackSha256`：rollback 在 apply 留下的文本上再写一次（恢复基线行，或删掉候选新增的行）之后的那份文件。

**只存摘要，不存文件**：该文件的第二个 YAML 文档就是 deployment 放凭据的地方，所以账本与沙箱里永远只出现这三个 hash，绝不出现它的任何一行字节（`capability-config.ts` 的拒绝文案同样只点文件、行名与摘要）。三个值的生产者是 `prepareCapability`（`capability-config.ts:capabilityTableIdentity`，纯函数，读一次文件、算两次编辑），消费者是提交路径的两处比对：

1. **提交门**（`commit.ts:commitIntent`，意图行之后、首次写之前，经 `CommitHost.tableWriteRefusal`）：`apply` 要求文件仍等于 `baselineSha256` 或 `applySha256`；`rollback` 要求 `applySha256` 或 `rollbackSha256`；不符即 `capability-table-changed` 具名拒绝——零字节、零 registry 行、零 skill 文件、意图保持开放（EVO-2“零应用”）。
2. **文本写路径**（`capability-config.ts:writeCapabilityRowToConfig`）：同一条比对再做一次，并在 `before-write` 缝之后重读文件，把“读入后、落盘前被写走”的窗口也关掉；`rollback` 与 `apply` 共用这一条路径（`entry: null` 即删行）。

## 半成品行不准入与写前最后一次比对（EVO-2 P1/P2，本记录同日扩展）

上面三个摘要只回答“表文件还是不是我冻结的那份”。它们不回答另一个问题：一次被拒的提交**已经把行装进了进程内 registry**（capability 提交的顺序是先在进程里装行、后写部署的表文件），而 row-only 候选（L1 组合现成能力）连一个文件都没有，K2/K3 那条“开放意图按目录拒绝”对它完全看不见。这两半一起补：

- **row-keyed 准入闸（P1）**：`EvolutionService.openIntentCapabilities()` 与 `openIntentTargets()` 是同一次 fold 的两个投影（同一个 `openIntents` 列表），给出每个开放意图的 `intent.capability?.name`。task-runtime 侧结构读 `EvolutionCommitLedger` 增加同名成员；**两个读都必须答**——只答文件读的服务按 `commit-ledger-unreadable` 具名拒绝（fail-closed），因为“半回答”的账本正是半成品行的来源。`precheckProviders` 对每一行先问这一行是否被开放意图移动：是则以 `commit-intent-open` **按行名**具名拒绝，且该行**完全不解析**（不产出 skill verdict、不进 revision），载体是 `CapabilityProviderPrecheck.refusals`；`providerRefusals`、`providerDefectLines` 与 `capability_list` 都渲染这条行级拒绝，run binding 的 `selectedProviders` 不选被拒行的 provider。`TaskRuntime.applyCapabilityRow` 的 `options.commitRow` 是 `commitTargets` 的同类自豁免：提交自己正在安装的那一行照旧可验证，其他意图的行照旧被拒。
- **写前最后一次比对（P2）**：`writeCapabilityRowToConfig` 把整份字节比对搬进 `writeFileAtomic` 的 `onStaged` 钩子（`commit.ts` 的钩子现在被 await），即“暂存文件已 fsync、rename 之前”那一点；`Config.capabilityConfigProbe` 因此多一个 `staged` 阶段，而它是**最后一个可注入的缝**——比对之后到 rename 之间没有代码。POSIX rename 是无条件替换，所以这是本条唯一能确定性演示“在缝里写入的第三方字节不会被覆盖”的形态：在 `staged` 写入的字节会被具名 `capability-table-changed` 拒绝，暂存文件被删除，文件保持第三方字节，registry 的行按 P1 不可准入，意图保持开放、不记任何完成；若 `staged` 读到的正是本方向自己写出的那份（崩溃重试），比对通过、rename 写同样字节并结算。
- **重启不清除开放意图**：重启后 registry 从文件重载（被拒的表写入没进去，行通常不在表里），但账本里的开放意图仍然按行名拒绝该行，直到 `reconcile` 结算；结算之后行在 registry、在文件、可准入。表里的行与文件不一致的窗口因此始终由一个事实（开放意图）兜住。

本次扩展**不新增也不修改任何持久字段**：账本行仍是 `formatVersion: 4` 的同一批 kind 与字段，新增的都是读入口（`openIntentCapabilities()`）与准入判据（行级拒绝、staged 比对），因此没有第二次切换、没有迁移、本目录的 schema 兄弟也不必 `--write`。

## 单版本切换与旧行

`formatVersion` 不变（仍是 4），没有第二次切换、不做在线迁移：

- **旧行可折**：字段可选，`prepared` 行没有它时 fold 正常折叠（`preparedCapabilityTable(undefined) → undefined`），因此 K2/K3 时期写下的账本仍可加载、回滚、对账；现场 `.dsh/evolution/` 下当前没有活动账本（只有 v1 归档件与旧 sandbox），新账从空的 v4 启动。
- **无兼容 reader**：本 build 不为“没有冻结身份的旧 prepare”保留一条不比对就写的通路——同一个 capability proposal 若其 prepare 没记录 `capabilityTable`（旧行，或该 deployment 根本没命名表文件），它的表写入按 `capability-table-unfrozen` 具名拒绝，什么也不写；人要处理就重新 prepare 一个候选（prepare 会读表并冻结三个摘要）。
- **fold 形状校验**：`capabilityTable` 出现时必须是恰好这三个 hex64 摘要（`preparedCapabilityTable`），skills prepare 携带它、capability prepare 少一个字段、字段不是合法摘要，都在 fold 具名拒绝；手写伪造行与真实 append 走同一判据。

## 旧数据处置（2026-09-28 核对）

现场 `<repo>/.dsh/evolution/` 无活动 `proposals.jsonl`：K2 切换时旧 v1 账已原字节归档为 `proposals.jsonl.v1-archived-2026-09-27`，其后未产生 v4 行；`sandbox/` 下旧物化目录保留原样、新账不引用（同 K2/K3 记录）。因此没有未闭合 applied、没有开放意图、没有旧 prepare 需要“无冻结身份”的协商；新字段只对本次改动之后 prepare 的候选生效。

## 验收（确定性测试，临时 fixture，零模型费用）

- 冻结身份本身与两个方向的落点：`evolution/tests/unit/capability-config.spec.ts`“the capability table's frozen composed identity”段（纯函数三摘要；新增行 → `rollbackSha256 == baselineSha256`；替换行 → rollback 落在 writer 自己的渲染上）；
- 反例(a) 同名行在 prepare 后被第三方改：`capability-candidate.spec.ts`“refuses apply with no side effect at all when the table's own row moved since prepare”（具名 `capability-table-changed`、文件保持第三方版本、registry 未被写、无 skill 文件、无完成行、intent 开放）与“refuses rollback the same way when the table moved after the apply”；
- 反例(b) `before-write` 缝里改其他行：同文件“refuses a table a third party rewrote at the write seam, and never overwrites it”与 `capability-config.spec.ts` 的 `before-write` 用例；
- 正例与幂等：`capability-candidate.spec.ts`“lands on exactly the states prepare froze when nothing moves: apply, then rollback”（apply/rollback 各落在冻结摘要上）、“accepts the file its own write already left”（重试写同样的字节并结算），以及既有两个 probe 用例（停在 registry 行与表文件之间、以及表文件已写之后，重开实例 `reconcile` 仍以 `completed-*` 结算）保持绿；
- 恢复路径：同文件“reports a reconciliation blocked by the moved table, and settles nothing over it”（表被第三方改动后 `reconcile` 报 `blocked` + `capability-table-changed`，不写文件、不记完成、intent 保持开放）；
- fold 形状：`evolution.spec.ts`“A6: a malformed capabilityTable on a capability prepared record fails the fold”与“A6: a capabilityTable on a skill prepared record fails the fold”；
- **P1 半成品行不准入**（新增）：`tests/integration/a6-capability-row-gate.spec.ts` 四条——(1) 表写入被 `before-write` 缝的第三方字节拒后：行确实进了进程内 registry、文件保持第三方字节、无 `applied`、意图开放，且**普通准入**（`capabilityProviderReport` 的行级 `commit-intent-open`、以及真实 `decomposeAndRun` 的具名拒绝与零 task/run/evidence）；(2) `staged` 缝注入第三方字节：具名 `capability-table-changed`、文件逐字节保持、行不可准入、无完成；(3) 正例：结算后的 apply 行可准入且文件含该行，rollback 把行从 registry 与文件同时移除（文件逐字节回到基线）；(4) 模拟重启（同目录、新实例）：开放意图仍按行拒绝该行，只有 `reconcile` 结算后才可准入。task-runtime 单测：`provider-precheck.spec.ts`“a capability row an open intent moves is refused by name, and only that row is affected”“a service that offers only the file read is refused too”“no ledger write is ever performed”；
- **P2 写前最后一次比对**（新增）：`capability-config.spec.ts`“verifies the file one last time at the staged seam, immediately before the rename”（具名拒绝、文件保持第三方字节、无 `.tmp-` 残留）与“accepts a file that reads as this write's own result at the staged seam”（重试仍结算）；既有的原子写用例的 probe 序列相应变成 `['before-write', 'staged', 'written']`。

## 兄弟 schema 文件

本次改动不动任何 `SessionEventMap` 根（声明与 payload 文本都不变），`pnpm run verify-persistence` 的清单也不需要 `--write`。按本目录惯例（K2/K3 记录：账本不是 SessionEventMap 根，故无 schema 兄弟），本记录的唯一“登记形状”是上面那段 `prepared` 行；`2026-09-28-a6-capability-table-identity.schema.json` 与 `2026-09-28-a6-recovery-attempt.schema.json` 同形——重复当前**未变化**的事件根清单，作为“本次没有根指纹移动”的声明。
