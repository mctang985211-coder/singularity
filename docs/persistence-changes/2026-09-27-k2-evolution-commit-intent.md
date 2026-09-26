# K2：Evolution ledger 的提交意图格式（formatVersion 3）

kind: persistence-change

Evolution 外部账本 `proposals.jsonl` 的记录统一用 `formatVersion: 3`。本记录覆盖的 root 不是 SessionEventMap 根，`verify-persistence` 不涉及此账本（同 S4-E 记录的分工）。

变化内容（相对 formatVersion 2）：

- 新增 `commit_intent` 行：apply/rollback 在写生产**之前**持久化的操作意图，绑定 proposalId、方向、`approvalRef`（批准来源）、生产目标绝对路径、写前/写后内容身份（`baselineSha256`/`contentSha256`）与相对账本 root 的可恢复字节来源（`source`）。它不是生命周期迁移，fold 单独折叠；同一 proposal 同时最多一个开放意图。
- `applied`/`rolledback` 行新增必填 `intentId`：完成行必须闭合一个匹配的开放意图（intentId、方向、`approvalRef`、`targets == [intent.target]` 全部一致），否则 fold 具名拒绝——v3 里不存在无意图的完成行。

单版本切换：`load` 逐行拒绝 v1/v2/无版本/混合；`append` 漏斗与 `recordExperimentStart` 在持久写前以同一判据拒绝旧版本记录，账本字节不变。v2 账本没有意图行可对账，旧代码也读不了 v3 行（未知 kind 在 fold 拒绝），两个方向都不建兼容 reader、不做在线迁移。拒绝文案点名所见版本并指引归档旧账、从空的新账启动。

旧数据处置（2026-09-27 执行）：现场真实旧账 `.dsh/evolution/proposals.jsonl` 为 21 行 v1（S4-E 切换时按记录应归档而未执行，本次一并处置）。逐行盘点确认两条 applied（`m3-prop-cap`、`m3-prop-skill`）最终均已 rolledback，无未闭合 applied、无未闭合意图（v1 无意图概念），符合归档前提。原字节经 sha256 校验（`3929199816f51cedf0acc63cf198959053d05f5cb81f25612191cffa31a261bb`，归档前后一致）整体更名为 `proposals.jsonl.v1-archived-2026-09-27`，不删除、不改写；新账从空的 v3 启动。`sandbox/` 旧物化目录保留原样，新账不引用。若归档前盘点发现未回滚的 applied，必须停止切换并由对应旧版本处置具体对象——本次盘点无此情形。

验收（确定性测试，临时 fixture，零模型费用）：v1/v2/混合账零新写且加载具名拒绝（`evolution/tests/unit/ledger-version.spec.ts`）；无意图/不匹配完成行、重复开放意图 fold 具名拒绝（`evolution/tests/unit/evolution.spec.ts` K2 段）；新账重开、应用、回滚与崩溃窗口对账全链路（`tests/integration/k2-evolution-commit.spec.ts`）。
