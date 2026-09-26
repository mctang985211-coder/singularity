# 第 12 项 S4-E 定点返工交付记录（2026-09-26，第二轮）

被审基线 `e8c0799` / 外层 `882d3ffefb`，经[收尾独立审核](2026-09-26-s4-e-final-closure-review.md)判返工。本轮基线：Singularity `39a472d`（被审版之上仅审核文档一提交）、外层 `3fc4d03744`，两树均干净。合同：[定点返工](../execution-prompts/12-s4-e-final-closure.md)、主 guide §5.17、计划 F.2、本次审核。历史记录原样保留。

## 反例评估（执行修改前，四个 explore 子代理）

按"真实性（是否必然在真实大模型运行中出现）/ 修复层级（门禁、补丁、还是让 agent 得不到错误信息）/ 简洁性"逐条裁决：

| 反例 | 模型可达性裁决 | 修复层级 |
|---|---|---|
| CE3 非 Skill 返回 `next: evolution_candidate` | 必然：工具返回是模型唯一行为指引面 | (c) 改工具返回，让 agent 得不到错误指引 |
| CE5 无 mutation candidate 落账 | 必然：schema 非必填 + list 宣传 + 成功返回零拒绝信号；落账后 proposalId 永久死端 | (c) schema 必填 + (a) 服务写边界 |
| CE6 缺生产 SKILL.md 仍 prepared | 必然：targetId 自由字符串，幻觉/错名直达 prepare；工具文案宣传 champion:null 正常 | (a) prepare 写前拒绝 + 工具文案 |
| CE1/CE2 record* 直调 v1 混写 | 模型不可达（唯一生产调用方 experiment.ts 内版本为字面量 2），但属持久性门禁：一条坏行整账重开即拒、同进程调用方见"成功" | (a) 写边界（复用 load 判据） |
| CE4 fold 接受非 Skill candidate | 模型不可达（candidate 服务已拒非 skill），fold 是文件来源行的唯一检测点，放行后 gate/decide 会继续推进 | (a) fold 形状门禁 |
| CE7 replayTask 静默忽略 wallTimeMs | 模型不可达（evolution_replay 无 options 通道），但公开 API 静默忽略违反 A3 §3.5 同型先例与 EVAL-3 | (a) 入口闭集拒绝 |

**结论：执行原计划，不简化。** 七条或模型必然踩中，或属固定合同（F.2 写前拒 v1、EVAL-3 旧参数即拒、fold 当前形状）明示的门禁；实现者无权自行收缩验收合同。方案本身是净删除（src 9 文件 +357/−373），无新平台/helper/兼容层。

红证据：基线上应用[反例补丁](2026-09-26-s4-e-closure-counterexamples.patch)复跑，unit 6 条 + integration 1 条全部按预期为红（start/sample v1 写入成功、非 Skill 返回错误下一步、fold 接受非 Skill candidate、空 mutation candidate 成功、缺生产文件 prepare 成功且写 sandbox、旧 wallTimeMs 创建 Run）。

## 实现（四波串行；evolution.ts 共享故波 1→2→3 串行，runtime 并行）

1. **Skill 生命周期服务侧**（`evolution/src/evolution.ts`）：`candidate()` mutation 改必填（无条件 `validateMutation`，落账恒含 mutation）；`nextStates` 删 candidate→gated 弧；`prepare()` 把生产 SKILL.md 读取提到任何 sandbox/ledger 写之前，缺失即具名拒绝，同一次读取产出 champion 快照与 skillBaseline；删除 `ChampionState 'missing'`、apply 基线 missing 分支、rollback `rm -rf` 删目录分支。
2. **replayTask options 闭集**（`task-runtime/src/index.ts`）：`assertReplayOptions`（1570 附近，仿 `assertClosedRootBudget`）为 `replayTask` 方法体第一条语句，七字段闭集，未知键具名拒绝；`wallTimeMs`/`durationMs` 单独说明已删除。
3. **写边界 + fold**（`evolution.ts`）：`assertLedgerFormatVersion`（:765）三处复用——load（:1702）、append 漏斗（:1730）、`recordExperimentStart` 队列回调首句（:1790，先于幂等成功返回）。fold：candidate 要求 skill+mutation；prepared 要求 captured 基线与 skillContent/skillBaseline；decided 要求 approvalRef（已核 decide() 写路径 1053-1066 恒写，写与重开同规则）；删除 validateMutation 的 agent_preset/capability/task_definition 分支、bookkeeping prepared、无前绑定/前基线兼容形状；`presetRoot`/`configFile` 配置/属性/初始化及全部测试接线删除（装配 `agent-singularity/src/index.ts:191` 只传 repoRoot+modelSelection 已证零生产读者）。
4. **九工具模型面**（`agent-singularity/src/tools/`）：propose 成功返回按 targetType 分岔（非 Skill 只报已记录与当前支持范围，无 `next:`）；candidate schema `mutation` 必填；prepare/apply/rollback/list 删除 champion-null、新建 Skill、"human edits production by hand"、"无 mutation 可直接 gate" 等旧文案；`MECHANICAL_TARGET_TYPES`/`mutationMechanical` 零消费者后连定义删除。root 协议段（`root.prompts.ts:8`）复核与终态一致，未改。

主代理集成：重建 `lib` 后发现 `evolution-tools.spec.ts` 经包名解析此前跑的是旧产物——"refuses a skill gate without an experiment" 因 prepare 新拒绝而未达 prepared；按票规则只调接线（补生产 Skill fixture 并断言 prepare 成功），断言未减弱。

## 逐项验收（拒绝时的实际副作用与重开结果）

| 票验收项 | 结果与证据 |
|---|---|
| record 入口直调 v1/无版本（含重复 experiment identity） | 具名拒绝（`... declares formatVersion 1 — this build reads and writes formatVersion 2 only`），账本字节不变，新实例 `list()` 正常；`experiment.spec.ts` "the ledger write boundary is formatVersion 2" 4 条 |
| 合法 v2 记录重开 | 成功（evolution.spec.ts 重开正例全绿） |
| 伪造 v2：非 Skill candidate / 无 mutation candidate / prepared 缺内容/基线 / decided 缺人审引用 | fold 各具名拒绝，账本字节不变，第二实例同样拒绝；"the fold admits only the current lifecycle" 5 条 |
| 完整当前 Skill 账重开/应用/回滚 | 通过（evolution-replay-experiment 10 条、evolution-tools 7 条经真实工具全链） |
| 只服务旧格式 fixture | 改为入口拒绝验证；v1 归档 fixture 字节未动，其拒绝由 ledger-version/ledger-roots 覆盖；未把 v1 改 v2 续测旧生命周期 |
| 缺 mutation 零 candidate 写 | 服务直调与工具 schema 双拒（"missing required property \"mutation\""） |
| 缺生产 Skill 零 prepared/零 sandbox 写 | prepare 写前拒绝：err instanceof Error、账本字节不变、root 下无 sandbox、状态停 candidate |
| 非 Skill 建议可记录且不给错误下一步 | 成功返回 "stays a recorded suggestion…"，无 `next:`，账本仅 proposed、无 sandbox |
| 旧候选入口服务直调 | 拒绝（非 skill targetType 具名拒绝；无 mutation 具名拒绝） |
| 模型工具面与真实成功返回 | 经 evolution-tools.spec.ts / assembly.spec.ts 真实执行核对，非仅 grep |
| replayTask 带旧 wallTimeMs | 具名拒绝，零 spawn、Run 数不变、无工作区写（replay-execution-binding.spec.ts:231） |
| 合法 replay / 根时限 | 全绿（root-budget 25、orchestrate 122、replay-workspace 9）；`assertExperimentBudget` 旧字段拒绝保持 |

## 公共检查（主代理在最终工作树独立重跑）

- `pnpm build`（packages/singularity）通过，被跟踪 lib 产物已刷新。
- unit **57 文件 / 1719 全绿**；integration **54 文件 / 407 全绿**（含此前基线抖动项 a4-question-cold-recovery，本轮全量亦通过）。
- `verify-persistence` OK（4 根不变；本账本非 SessionEventMap 根）；`git diff --check` 干净；`evolution`、`agent-singularity` `tsc --noEmit` 0 错（task-runtime 6 条基线既有错误，无新增）。
- 删除清单 grep 核对：`champion.*missing`、`presetRoot`/`configFile`、`MECHANICAL_TARGET_TYPES`/`mutationMechanical`、`review audit` 字样在 src/tests 零残留；`wallTimeMs` 在 evolution 仅剩删除说明与既有 budget 拒绝；Q2/Q4 及 EVAL-1～EVAL-5 现行正例全部保持。

## 现场旧账只读盘点（不部署、不改写）

`/home/ROXY/code/bb_work/harness/.dsh/evolution/proposals.jsonl`：21 行全 v1，md5 `9b527f0d…` 与库内归档 fixture 一致，本轮未动；两 applied 均已 rolledback，`m2-prop-diag` 悬挂 decided 的事实不变。切换仍按操作方步骤：核对最终状态 → 原字节归档 → 空新账启动。

## 未覆盖与边界（沿既有记录，非新增豁免）

确定性 fixture 证明协议，不声称统计效果；未调用付费模型。`PreparedView` 字段类型保持宽松、由 fold 强制（视图非写边界）。`ChampionState` 收窄为 `'captured'` 后，v2 账中含旧 `champion:'missing'` 的行在 load 即拒——该形状本票起不可写。其余边界（进程内 agentOptions 传播、独立账本各自版本等）沿[原收尾交付](2026-09-26-s4-e-final-closure-record.md)记录。

最高填**待验收**，停止等待独立进度审核；未启动 A5/A6。
