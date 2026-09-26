# 第 12 项 S4-E：单文件 Skill 的真实双侧评估

本文件保留原派发历史；`4de0056` 的交付已被[进度审核](../history/2026-09-26-s4-e-progress-review.md)判返工。当前以[计划 F.2 的 KISS 裁决](../2026-09-20-vrtc-code-change-plan.md)及[简化收尾 prompt](12-s4-e-final-closure.md)为准；下文冲突的旧实验兼容/实验时限要求不再派发。

你是 S4-E 的实现主代理。只交付[唯一计划 F.2](../2026-09-20-vrtc-code-change-plan.md)与 EVAL-1～EVAL-5，完成后停在进度审核；不启动 A5 或 A6。先读[公共执行合同](README.md)、[主 guide 当前状态及 §1.4–1.5](../singularity-harness-guide.md)和计划文首唯一表、F.2。A4 的[最终审核](../history/2026-09-26-a4-final-review.md)是前置证据。工作区为 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层为 `/home/ROXY/code/bb_work/harness`；核对实际 HEAD 和工作树，修改前按公共合同保存基线。

## 本票交付与边界

本票让**已有单文件 `SKILL.md` 的替换候选**在同一冻结输入、裁判、模型/工具和预算下，分别运行新的基线 Run 与候选 Run，保存可追溯证据；只有原失败修复、回归及未见 holdout 不退化时才进入既有两道人审，应用前再次核对内容、报告和生产基线。历史 champion 仅定位案例，不能冒充本次基线。确定性 fixture 可证明协议，不声称统计效果。

`evolution` 新包是候选、实验、决定、应用、回滚及 ledger 的**唯一行为所有者**；`agent-singularity` 只装配服务和保留有真实调用方的薄工具适配。真实 Run、Task/Review/Evidence、执行闸继续归 `task-runtime` 等原所有者；Skill 发现/加载复用现有 DSH 和 provider 绑定，不另造执行器、实验平台、第二 replay runtime 或评分系统。旧 capability/preset/config-edit 等记录仍可读，旧 applied 仍可回滚；没有本票 evaluator 的类型不得用旧报告走新晋升。新增 capability、执行型 Skill、资源文件/sidecar 和原目标恢复属 A6，不得用它们填补本票单文件 Skill 的缺口。

## 施工前固定接口，再按依赖交接

主代理先列简表：`F.2 承诺 → 现有入口与最终所有者 → 生产消费者 → 正例/拒绝例 → 恢复与旧数据结果 → 证据`。逐个盘点 `agent-singularity/src/evolution.ts`、`replay.ts`、九个 `tools/evolution-*.ts`、服务装配、公开导出及现有测试；标明迁入、保留为薄适配或删除的具体位置。**这张表是施工检查表，不是新的持久台账。** 若同版本 API 有实证冲突，报告最小冲突并保持本票未完成，不改写 F.2 验收。

内部顺序是接口交接，不是可跳过的后续阶段：

1. 将现有 Evolution 生命周期、ledger、replay 报告与原有行为迁入 `evolution` 包；同步改接全部生产调用方和必要测试，验证旧 ledger 读取、旧 applied 回滚及原有路径。新包出现时就删除 `agent-singularity` 的旧主体和同名转发；工具适配只处理调用身份、schema、结果呈现。不要把行为移入工具或 task-runtime。
2. 在此所有者上接双侧实验：运行前冻结样本、输入快照、客观 verifier/AC、模型/工具、预算、候选内容与比较规则；observed 和 holdout 均非空，至少一条可复现失败和一条未参与选择的 holdout。两侧从相同初始快照进入隔离工作区，各有新的实际 TaskRun 和 verifier 结果；报告可追到 Task/Run/Review/Evidence 及内容身份。失败、费用缺报、取消与重启均如实记载，不把未知成本填 0。
3. 接入 gate、decide、apply 的完整生产路径：拒绝历史基线冒充、身份或环境漂移、伪造证据、双侧同失败、回归/holdout 退化；合法修复才进入既有人审。实验按 F.2 的键去重，已完成样本不重计，失败记录不被静默替换；应用前重检候选、报告及生产基线，拒绝变更。保留两次人审，不把报告通过当作批准。
4. 主代理独立组合验收并核对导出和调用链，清除旧生命周期实现、无消费者转发及重复事实源；更新 guide、唯一计划、受影响持久化说明和交付记录。整票 EVAL-1～EVAL-5 通过前不得写“完成”或进入第 13 项。

若委派子代理，每人一次只领以上**一个可独立验收的窄接口目标**，写明文件归属、前置接口、验收和停止点；共享接口先交接再派消费者。子代理不独占工作区、不回退他人修改，也不宣布整票通过。主代理负责跨包集成、全部工具消费者、全量检查及文档。上下文紧张时只续派剩余目标，不让下一阶段代理补本票缺口。

## 整票验收

- **EVAL-1**：从现有生产工具入口走两侧真实 runtime/verifier；隔离快照与工作区不串写，报告的 Task/Run/Review/Evidence、Skill 内容及冻结配置均可回溯。基线是新 Run，不能用历史 champion 结果替代。
- **EVAL-2**：合同列出的基线冒充、输入/裁判/模型漂移、伪证、双侧同失败、回归与 holdout 退化均拒绝晋升且无应用副作用；一条真实修复正例能进入原人审。成本约束触发时费用未知必须拒绝，否则仅记录 unknown。
- **EVAL-3**：重复调用、取消、重启保留已发生 Run/费用与失败；已结算样本不重复执行或重计，在途按 runtime 恢复结果记 interrupted/failed，新的实验才允许再计预算。内容、报告或生产基线变化在 apply 前拒绝。
- **EVAL-4**：全部旧工具消费者已改接新包；旧 ledger 可读，旧 applied 能回滚；不支持新评估的旧类型可以查看历史，但不能用旧报告绕过 gate。
- **EVAL-5**：从工具入口到 ledger、实验、gate、决定、应用和回滚只有 `evolution` 一处行为实现；旧 `agent-singularity` 主体与同名转发已删除，`task-runtime` 仍只执行 Run。用实际调用链和测试确认，不以文件行数或包名证明。

先以失败反例固定新规则，再实施。测试跨真实 store、Session、Task runtime 和 verifier；scripted provider 只替代模型输出。按[公共合同](README.md#必跑检查)串行完成 build、unit、integration、verify-persistence、类型检查和 diff 检查；若改变持久格式，同票写明旧 ledger 兼容与回滚并验证。不要在 fixture 之外改生产 Skill/config，不调用付费模型、不推送或部署。

报告每项验收的入口、测试、结果、模拟与未覆盖范围；已知边界必须引用 F.2 的明确排除或具名拒绝，延后能力须给出承接票号。**本票承诺的迁移、双侧 Run、证据闸、旧数据读取或回滚失败均记返工，不能改称 A6 留口**。提交 Singularity 及外层对应子模块指针；交付方最多填“待验收”，经进度审核后才可填“已验收”。
