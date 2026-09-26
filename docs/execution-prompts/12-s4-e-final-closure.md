# 第 12 项 S4-E 收尾：只保留当前 Skill 实验路径

你是实现主代理。工作区 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层 `/home/ROXY/code/bb_work/harness`。核对 HEAD 并按[公共合同](README.md)保存修改前基线。只读主 guide §5.17、[计划 F.2](../2026-09-20-vrtc-code-change-plan.md)及[复审反例](../history/2026-09-26-s4-e-rework-review.md)。**本文件和计划 F.2 的新裁决覆盖历史 prompt 的旧 replay/兼容/实验时限要求。**本票完成前不派 A5/A6。

## 目标与删除范围

当前 agent 仍可从 `evolution_replay` schema 看见实验 `wallTimeMs` 和非 Skill v1 replay，`evolution_candidate/evolution_gate` 仍引导旧流程，root prompt 也没有把唯一可执行对象说清。只改服务端拒绝会让 agent 继续发旧请求。本票从**模型可见入口 → 服务直调 → 持久写入**同批切断它们；修改前列实际调用方和删除清单，不按文件名机械清空。

1. **只暴露单文件 Skill 双侧实验。** `evolution_replay` 工具只描述并执行该路径；删除非 Skill v1 replay 的分发、渲染及无生产消费者的 `runReplayExperiment`、v1 report/比较器、`EvolutionService.replay`、新写 `replayed` 状态等相关代码。`evolution_candidate/prepare/gate/decide/apply/rollback` 的 agent 可执行说明与直调入口都按本阶段支持的 Skill 候选收窄；不再提供 capability、agent_preset、task_definition 的旧候选→replay→gate 假执行路径。`evolution_propose`/Diagnosis 仍可记录其他方向的**建议**，但记录建议不得自动获得 candidate、replay 或 apply 权限；A6 将按 F.4 引入新的 capability 双侧评估，不复活 v1 replay。root 的 Evolution 协议段及相关当前文档只指向真实可走通的 Skill 路径。旧报告不能作为新晋升证据。这里的“删除旧版”专指 Evolution 的 v1 replay，不删当前仍在使用的 `SKILL.contract.json` v1 侧车协议或普通 Task replay。
2. **删除实验级时间预算的全链路。** 从 `evolution_replay` 的 `budget` schema、说明、返回文案，`ExperimentBudget`/report/ledger、编排器/晋升检查，到仅为实验期限增加的 `ReplayTaskOptions.wallTimeMs`、会话传播和测试中删除该能力；实验 `durationMs` 若无其他当前消费者一并删除。普通 Review 的 `durationMs` 和现有根运行时限继续使用。S4-E 只支持可选 `maxTokens` 实验总额；配置了 `rootBudget.wallTimeMs` 才由 runtime 限制 Run，未配置就不声称时间上限。模型可见 schema 没有旧字段；直接服务调用带额外字段在首个持久写前抛错，不能静默忽略。不要保留标记 deprecated 的旧字段或第二套计时器。
3. **实验裁判必须显式锚定。** 普通 Task/verifier 的 mode 派发不变；S4-E 冻结前发现任一 AC 缺 `verifierRef`、ref 未注册或版本缺失，直接抛错且零实验落账/Run。显式 ref 的已有冻结/Review 核对继续使用，冻结 `@1` 后首次 Run 前换 `@2` 不得晋升。不加 mode→verifier 查询 helper、不自动补 ref、不用执行后读到的身份补造冻结值。

`gate` 只记录六项回答和证据引用，允许失败或超额实验留下审计事实；`gated` 不表示可晋升。`decide(PROMOTE)` 和 `apply` 继续各自在写前用**同一个**现有晋升检查拒绝超额、缺失指标、伪造或漂移证据；不要把第二套晋升检查塞入 gate。

## 数据与验收

这是**不兼容的 Evolution ledger 切换**：新写记录统一采用 `formatVersion: 2`，读取 v1、无版本或混合记录在写入任何新记录前具名抛错；不保留双格式 reader、在线迁移、旧 `replayed` 状态或回退 helper。实际外层 `harness/.dsh/evolution/proposals.jsonl` 在本轮只读盘点有 21 行、2 条 `replayed`，两项曾 `applied` 的提案最终均 `rolledback`。实现 agent 再核对现场；部署切换前把旧账原字节归档并从空的新账启动，不自动删除或改写用户数据。若现场出现未回滚的 applied，先停下并报告具体对象，由旧版本处理后再切换；不得假装新版本会回滚旧数据。旧账拒绝、v2 重开/回滚、新旧 schema 不混写各有确定性验证。不要为旧账写迁移程序。

整票验收：从真实模型可见 root prompt、九个工具 schema/说明及成功返回文字检查，不再诱导旧请求；伪造直调非 Skill 旧 replay、实验 `wallTimeMs` 或旧账均在副作用前拒绝；合法 Skill 双侧 Run/verifier→gate→两次人审→apply→rollback 仍通过，Q2/Q4 正例及 EVAL-1～EVAL-5 的现行部分不退化。新代码中不保留仅服务 v1 replay 的生产导出、状态分支、报告/fixture 或调用方；只保留有当前消费者的公共 Task/Run/Verifier 能力。测试从公开入口验证行为，不为删除的私有 helper 新增镜像测试。

按公共合同跑 build、unit、integration、persistence、类型和 diff；报告删去的生产符号与真实消费者、直调拒绝副作用、旧账盘点/切换前置、未运行项。同步主 guide、唯一计划、当前工具/prompt 指导和持久化说明；历史审核记录原样保留。提交 Singularity 与外层仅该子模块指针，最高填待验收，停止等待独立审核。不调用付费模型、不推送或部署。
