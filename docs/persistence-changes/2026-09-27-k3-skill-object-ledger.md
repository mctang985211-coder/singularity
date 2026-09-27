# K3：Evolution ledger 的完整 Skill 对象格式（formatVersion 4）

kind: persistence-change

Evolution 外部账本 `proposals.jsonl` 的记录统一用 `formatVersion: 4`。本记录覆盖的 root 不是 SessionEventMap 根，`verify-persistence` 不涉及此账本（同 S4-E/K2 记录的分工），因此没有 schema 兄弟文件。

变化内容（相对 formatVersion 3）：

- `commit_intent` 行：单值 `target`/`baselineSha256`/`contentSha256`/`source` 改为 `files` 数组（1 或 2 项，定序 `SKILL.md` → `SKILL.contract.json`），每项携带绝对生产目标、写前/写后内容身份与相对账本 root 的可恢复字节来源。一个意图由此绑定一个完整 skill 对象的固定文件集；fold 校验 1..2 项、文件名与顺序、同目录、绝对路径与 hex64 摘要。
- `prepared` 行：`skillContent`/`skillBaseline` 从 `{name, sha256}`（仅 SKILL.md）扩为完整对象身份 `{name, sha256, contract?: {sha256, contractDigest}}`——`contract` 存在当且仅当对象带执行型 sidecar，`sha256` 是 sidecar 精确字节摘要、`contractDigest` 是 `skillContractDigest` 的规范化身份（registry revision 与 run 绑定使用的那个）。fold 要求 candidate 与 baseline 的 `contract` 存在性一致（不一致即角色转换，拒绝）。
- `applied`/`rolledback` 完成行：`targets` 必须等于意图 `files` 的全部 target（按序，1 或 2 项），不再是单元素。
- 实验报告（账本内的实验记录不因此而变，但由它们重算的 `experiment-report.json`）：`formatVersion` 2 → 3，因为冻结块现在携带完整身份与按侧的 `candidateRegistryRevision`；写出只写 3、读回校验只接受 3，旧版本具名拒绝。实验幂等键的 `preparedContentDigest` 相应改为完整候选身份的摘要（同一 v4 内自洽；现场无 v4 前样本可受影响）。

单版本切换：`load` 逐行拒绝 v1/v2/v3/无版本/混合；`append` 漏斗与 `recordExperimentStart` 在持久写前以同一判据拒绝旧版本记录，账本字节不变。v3 账本的单文件意图没有 `files` 可对账完整对象，旧代码也读不了 v4 行，两个方向都不建兼容 reader、不做在线迁移。拒绝文案点名所见版本并指引归档旧账、从空的新账启动。

旧数据处置（2026-09-27 核对）：现场 `.dsh/evolution/` 下没有活动 `proposals.jsonl`——K2 切换时旧 v1 账已按原字节归档为 `proposals.jsonl.v1-archived-2026-09-27`，其后未产生任何 v3 行。因此没有未闭合 applied、没有开放意图、没有 v3 prepared 记录需要旧版本处置；新账从空的 v4 启动。`sandbox/` 下 K2 之前的旧物化目录保留原样，新账不引用（同 K2 记录的处理）。

验收（确定性测试，临时 fixture，零模型费用）：v1/v2/v3/无版本/混合账零新写且加载具名拒绝（`evolution/tests/unit/ledger-version.spec.ts`）；files 形状畸形、两文件不同目录、完成行 targets 与意图不一致、prepared 两侧 contract 存在性不一致的手写行在 fold 具名拒绝（`evolution/tests/unit/evolution.spec.ts` K3 段）；v4 账重开读回、当前已应用两文件对象回滚与公开工具整链通过（`tests/integration/k3-skill-unit.spec.ts` K3-5 例）；报告 v2 具名拒绝、v3 写出与读回（`evolution/tests/unit/experiment.spec.ts` / `experiment-orchestrator.spec.ts`）。
