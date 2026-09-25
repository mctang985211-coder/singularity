# S4-E 执行与验收记录

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **待验收**，2026-09-26 |
| 执行 agent / 任务链接 | 实现主代理 + 四个串行子代理（迁移 → replay 工作区 → 双侧编排器 → 晋升闸）；派发 prompt [12-s4-e-skill-evaluation.md](../execution-prompts/12-s4-e-skill-evaluation.md) |
| 开始日期 / 验收日期 | 2026-09-26 / 待进度审核 |
| 前置验收记录 | A4 [最终审核](2026-09-26-a4-final-review.md)：A4-1～A4-5 已验收，S4-E 可派发 |
| 修改前基线 | Singularity `443db2bddb6a977a3fb495ee6df40df6ea85733e` / 外层 `667919ab02` |
| 交付版本 | Singularity `94c398b`（迁移）→ `fe2c221`（replay 工作区）→ `5bbcced`（双侧编排器+报告 v2）→ `82df342`（工具接入）→ `c91eed6`（晋升闸）；文档与外层指针见本记录同批提交 |
| 验收项对应 | 见下「EVAL 对应表」 |
| 实际检查 | 见下「实跑检查」（全部在最终 HEAD 由主代理复跑） |
| 跨入口/组合反例 | 各子目标红→绿：迁移为行为保持（1694/365 起点全绿 + 旧账回归）；replay 工作区 9 例（未实现时 7 失败）；编排器 10 个变异各命中目标测试（脚本 `/tmp/s4e-red-evidence.sh`，跑后还原）；工具接入红证据 `/home/ROXY/code/bb_work/s4-e-tool-red-evidence-20260926.txt`（新 spec 6 失败→全绿）；闸红证据 `/tmp/s4e-gate-red.txt`（旧闸上 41 例中 39 失败→全绿） |
| 既有复杂度处置 | `agent-singularity/src/evolution.ts`（2038 行）与 `replay.ts`（295 行）**迁出**至新包 `evolution`，原文件与 `src/index.ts:57-91` 再导出已删；`config-edit.ts` 同迁；九个 `evolution-*` 工具瘦身为薄适配（`evolution-replay.ts` 370→110、`evolution-prepare.ts` 121→83；champion 解析/报告组装迁入 `evolution/src/replay-experiment.ts`、`prepare-champion.ts`）；三跳再导出收敛为消费者直指 `@dangosys/dsh-singularity-evolution`；`repoRoot` 相对深度硬编码改为 `Config.repoRoot` 显式注入（装配方以原表达式求值，`assembly.spec.ts`/`ledger-roots.spec.ts` 钉住默认根）；`assertCapabilityRowProviders` 及其 8 条单测**删除**（EVAL-4 后不可达；活体消费者为 task-runtime 准入侧，自有测试保留）；`replay-experiment.ts` 的 skill 旧编排分支**删除**（无消费者）；`REPLAY_RELATIONS`/`ReplayRelation`、`effectNote` 等重复/单文件导出收敛；`task-runtime/src/index.ts`（5700+ 行）本票只新增 `workspace` 选项贯穿与 `workspacePathFor` 只读出口，其余整理仍属后续票（E 节原安排）；`orchestrate.ts` 未动结构 |
| 独立复核 | 未做——留待进度审核（各子目标红→绿反例与全量回归如上） |
| 文档同步 | 本记录；[持久化说明](../persistence-changes/2026-09-26-s4-e-experiment-ledger.md)；主 guide §1.4/§4.1/§5.17 与计划文首唯一表、F.2 状态（同批提交） |
| 模拟与未覆盖范围 | scripted provider 只替代模型输出；未调用付费模型、未做统计效果实验（确定性 fixture 只证明协议）；拒绝矩阵多用夹具合成的已完成实验（回归退化另有真实运行用例）；evolution 包单测经相对路径驱动 agent-singularity 工具源（测试层引用，非生产反向依赖）；bundle 不挂 evolution 插件（避免双实例，服务由 agent-singularity 装配）；恢复记录在途样本的 `initialDigest` 取冻结摘要（目录已被 run 写入，不重算）；replay driver 跨重启续跑仍属 A6/S2-R；`replayLineage` 进程内 Map 的既有边界不变 |
| 未解决缺陷 / 阻塞 | 无本票新增缺陷。既有：`a4-question-cold-recovery.spec.ts` 偶发抖动（基线 `fe2c221` 上复现，单跑 15/15 通过，主代理全量复跑 394/394 通过）；G9 的 task-runtime/agent-runtime 等包 tsc 基线错误未变（未新增） |
| 最终验收结论 | **待验收**（交付方自评 EVAL-1～EVAL-5 证据齐；结论待进度审核） |
| 下一项 | 第 13 项 A5 + S2-E；前置=本票经进度审核验收 |

## EVAL 对应表

| 验收 | 入口 | 测试与结果 | 要点 |
|---|---|---|---|
| EVAL-1 | 生产工具 `evolution_replay`（skill 候选）→ `EvolutionService.runExperiment` → `taskRuntime.replayTask`（每侧 `workspace` 独立） | `tests/integration/evolution-replay-experiment.spec.ts`（8 例）、`tests/integration/experiment-runner.spec.ts`（9 例）、`tests/integration/replay-workspace.spec.ts`（9 例）全绿 | 四条新 Run（1 失败样本+1 holdout ×2 侧）、两侧工作区互不串写（标记文件+digest 断言）、基线绑定生产字节/候选绑定沙箱字节（spawn grant 实读）、报告可回溯 Task/Run/Review/Evidence/内容身份/冻结配置（frozenDigest 独立复算）；基线=本次新 Run，历史记录仅定位样本 |
| EVAL-2 | `evolution_gate`/`evolution_decide`/`evolution_apply` → `evolution/src/promotion.ts` | `evolution/tests/unit/skill-promotion-gate.spec.ts`（41 例拒绝矩阵）+ 端到端正例（同上 spec 第二 describe：experiment→gate→decide（人审)→apply（人审）→rollback 全链） | 基线冒充（报告层+闸层双重）、输入/裁判/模型漂移、伪造证据（store 回读核对）、双败、回归/holdout 退化均具名拒绝且零应用副作用；成本约束声明时 unknown 拒绝、未声明时仅记录 unknown（不填 0）；合法修复正例进入原两次人审 |
| EVAL-3 | 编排器幂等键 `(proposalId, preparedContentDigest, sampleTaskId, side, repetition)` | `evolution/tests/unit/experiment-orchestrator.spec.ts`（7 例）+ `experiment.spec.ts`（24 例）+ 工具层幂等用例（重复调用零新 Run、同 experimentId；`repetition:1` 新实验） | 已结算样本复用不重跑不覆写；取消/重启后在途按 store 终态记 interrupted/failed 不补跑；apply 前三条反例（篡改报告/改候选/改生产基线均拒绝） |
| EVAL-4 | 全部九个工具 + 服务入口 | `tests/integration/evolution-tools.spec.ts`（capability PROMOTE 拒绝、skill 无实验不可 gate）、`evolution/tests/unit/evolution.spec.ts`（旧 capability/preset/task_definition 记录可读、旧 applied 回滚含 pre-W19 registry-form、skill 持 v1 报告拒绝晋升）、`evolution/tests/unit/ledger-roots.spec.ts`（活体旧账 21 行字节存档回归） | 无评估器类型可查看历史、可回滚旧 applied，不得用旧报告走新晋升 |
| EVAL-5 | 实际调用链核对 | 全仓 import grep：仅 `evolution` 包自身、`agent-singularity`（装配+九工具）与测试引用 `@dangosys/dsh-singularity-evolution`；`task-runtime`/`agent-runtime`/`task` 对 evolution 零导入（仅注释提及）；旧主体文件与同名转发已删（grep 零命中） | 工具→ledger/实验/gate/decide/apply/rollback 只有 evolution 一处行为实现；task-runtime 只新增 replay 显式工作区执行支撑，仍只执行 Run |

## 实跑检查（主代理在最终 HEAD `c91eed6` 复跑）

| 命令 | 结果 |
|---|---|
| `packages/singularity && pnpm build` | 通过 |
| `harness && pnpm vitest run --project unit packages/singularity` | **56 文件 / 1762 通过**（基线 1689；+73 = 新包迁移重计与新增用例） |
| `harness && pnpm vitest run --project integration packages/singularity` | **52 文件 / 394 通过**（基线 364；含 a4 既往抖动用例本次通过） |
| `packages/singularity && pnpm run verify-persistence` | OK — 4 event roots 不变（ledger 为 JSONL，新增 kind 说明见持久化记录） |
| `git diff --check` | 干净 |
| `agent-singularity && pnpm exec tsc --noEmit` | 0 错误 |
| `evolution && pnpm exec tsc --noEmit` | 0 错误 |

## 关键设计决定（主代理裁决记录）

1. **五问复核结论**（派 coding 前，三个 explore 子代理核实）：DSH 当前 checkout `0d1f5000` 无 evolution/ledger/对照评估/replay 对口实现（compaction/workflow/cordis-runner 均不对口）；开源调研（GEPA 等）仅有协议可借鉴、无可照抄实现 → 保留 F.2 原计划；简化落在：双侧 Run 复用现有 `replayTask` 全链与 `extraSkillRoots` overlay（不建执行器/实验平台/评分系统），task-runtime 唯一新增为 replay 显式工作区绑定（合同「两个独立工作区」的必要支撑），报告扩展按最小必要身份集。
2. 样本角色（observed-failure/observed-regression/holdout）从 store 历史终态**机械派生**，不由调用方标注。
3. 模型身份取 `exec.agent.options` 或部署默认选择，经 `Config.modelIdentity` 注入与闸同源；解析失败 fail-closed。
4. skill 提案不再落 `replayed` 记录：评估=实验，闸读实验；v1 报告与 manual 路径对非 skill 类型保留。
5. 闸删除项（`assertCapabilityRowProviders`、skill 旧编排分支、新建 skill 晋升）均按「EVAL-4 后不可达/无消费者」裁决删除，非降级为保留。
