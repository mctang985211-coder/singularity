# K2：Evolution ledger 的提交意图格式（formatVersion 3）

kind: persistence-change

Evolution 外部账本 `proposals.jsonl` 的记录统一用 `formatVersion: 3`。本记录覆盖的 root 不是 SessionEventMap 根，`verify-persistence` 不涉及此账本（同 S4-E 记录的分工）。

变化内容（相对 formatVersion 2）：

- 新增 `commit_intent` 行：apply/rollback 在写生产**之前**持久化的操作意图，绑定 proposalId、方向、`approvalRef`（批准来源）、生产目标绝对路径、写前/写后内容身份（`baselineSha256`/`contentSha256`）与相对账本 root 的可恢复字节来源（`source`）。它不是生命周期迁移，fold 单独折叠；同一 proposal 同时最多一个开放意图。
- `applied`/`rolledback` 行新增必填 `intentId`：完成行必须闭合一个匹配的开放意图（intentId、方向、`approvalRef`、`targets == [intent.target]` 全部一致），否则 fold 具名拒绝——v3 里不存在无意图的完成行。

单版本切换：`load` 逐行拒绝 v1/v2/无版本/混合；`append` 漏斗与 `recordExperimentStart` 在持久写前以同一判据拒绝旧版本记录，账本字节不变。v2 账本没有意图行可对账，旧代码也读不了 v3 行（未知 kind 在 fold 拒绝），两个方向都不建兼容 reader、不做在线迁移。拒绝文案点名所见版本并指引归档旧账、从空的新账启动。

旧数据处置（2026-09-27 执行）：现场真实旧账 `.dsh/evolution/proposals.jsonl` 为 21 行 v1（S4-E 切换时按记录应归档而未执行，本次一并处置）。逐行盘点确认两条 applied（`m3-prop-cap`、`m3-prop-skill`）最终均已 rolledback，无未闭合 applied、无未闭合意图（v1 无意图概念），符合归档前提。原字节经 sha256 校验（`3929199816f51cedf0acc63cf198959053d05f5cb81f25612191cffa31a261bb`，归档前后一致）整体更名为 `proposals.jsonl.v1-archived-2026-09-27`，不删除、不改写；新账从空的 v3 启动。`sandbox/` 旧物化目录保留原样，新账不引用。若归档前盘点发现未回滚的 applied，必须停止切换并由对应旧版本处置具体对象——本次盘点无此情形。

## 写路径与持久化（2026-09-27 返工；无格式变化）

行形状没有变化：仍然是 `formatVersion: 3` 及上文列出的字段，没有新字段、没有新 kind，因此没有第二次切换，也不需要新的 schema 兄弟文件。返工固定的是这些行**怎样才算落盘**以及提交顺序：

- 账本只有一个 durable append（`evolution/src/evolution.ts` `appendLedgerLine`）：`open('a')` → 写整行（write-all 语义，短写不留半行）→ fsync 文件 → fsync 账本目录，外加递归 `mkdir` 新建目录链上的每个目录与其父目录；任何一步失败都具名抛错，调用方不得把该行当作已持久。意图行、完成行与生命周期行都走它，`recordExperimentStart` 也改走同一路径——账本不再有第二条写门。
- `commit_intent` 落盘**之前**，`source` 所指的可恢复字节必须已经稳定：限定在账本 root 内（越界或等于 root 具名拒绝）、经服务已验证读重验摘要、并 fsync 该文件与**从来源目录一路到 ledger root 的整条目录链**（只 fsync 文件与它自己那一层时，断电仍可留下"意图在、来源路径不在"）；做不到就具名停止——不记任何行、不碰生产。这样意图命名的来源必然可再读，恢复不会卡在"来源没了"。
- rename 之后的目录 fsync 不再吞错：失败具名抛错、意图保留、不记完成。对账的"仅补账"分支（生产已持有提交内容）在记完成前同样 fsync 生产目录，失败即具名停止——完成行因此只在 rename 已可持久之后出现。
- 真实进程死亡（SIGKILL，不是被捕获的异常）会在生产目录留下 `.SKILL.md.tmp-<pid>-<hex>`；提交/补做在开自己的 staging 之前清理**同一目标、同一前缀**的残留（同目录、跳过目录项、失败具名停止），其他目标的文件与第三方文件不动。

验收（确定性测试，临时 fixture，零模型费用）：v1/v2/混合账零新写且加载具名拒绝（`evolution/tests/unit/ledger-version.spec.ts`）；无意图/不匹配完成行、重复开放意图 fold 具名拒绝（`evolution/tests/unit/evolution.spec.ts` K2 段）；持久化操作顺序（含来源目录链与账本新建目录链）、各 fsync 失败与来源漂移/越界/目标越界的具名零写、staging 残留清理（提交与"仅补账"结算两处）、写失败截回与截回失败具名、短写不留半行（`evolution/tests/unit/commit-durability.spec.ts`，21 例；fs 操作注入只替换 `node:fs/promises` 调用，服务/账本/fold/驱动都是真的）；新账重开、应用、回滚与崩溃窗口对账全链路（`tests/integration/k2-evolution-commit.spec.ts`，含嵌套子进程被 SIGKILL 后由新实例对账的真实进程退出用例）。

## 同目标未结意图的唯一性（2026-09-27 复审返工；无格式变化）

行形状不变（字段与 kind 同前），也没有新 schema 文件；本段记录的是新提交在**写前**的准入规则，由提交门而非 fold 执行：

- 新提交（`apply`/`rollback`）在同一进程串行队列内、写入任何行或字节之前，按**生产目标**扫描其他 proposal 的开放 `commit_intent`；命中即具名拒绝（点名目标、对方意图 id、归属 proposal 与方向，并声明零行零写）。第二个 proposal 因此不能在第一个未结提交之上写自己的意图/生产内容——否则第一个意图的 `baselineSha256`/`contentSha256` 都不再匹配，只能 `blocked`，目标被准入长期拒绝。目标不同的不误挡；对账结算后同一目标恢复可提交。
- fold 的既有规则不变：**同一 proposal** 同时最多一个开放意图；跨 proposal 的同目标唯一性由提交门保证（fold 只逐 proposal 折叠，不看其他 proposal 的目标）。
- 边界（如实记录）：**修复前**写入的账本若已含"同一目标两个开放意图"，仍被 fold 接受并按序对账——先者按生产状态 redone/written，后者具名 `blocked` 并保留意图（第三方恢复写前字节后仍可 redone）。本规则只阻止新提交造成该状态，不改旧账读入。
- 验收：`evolution/tests/unit/evolution.spec.ts` 与 `tests/integration/k2-evolution-commit.spec.ts` 各两例（同目标第二提案 apply/rollback 具名拒绝、零行零写、结算后恢复提交、陈旧者仍被基线拒绝；真实工具入口同拒绝）。
