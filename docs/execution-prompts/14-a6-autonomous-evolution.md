# 第 14 项 A6 + S2-R + S3：候选闭环与原目标新尝试

你是本票实现主代理。唯一行为合同是[计划 F.4](../2026-09-20-vrtc-code-change-plan.md) 的行为与验收段，公共纪律见[执行入口](README.md)。工作区 `/home/ROXY/code/bb_work/harness`，子模块 `packages/singularity`。A5 已验收；修改前核对两仓 HEAD/状态并保存基线。你只读本票合同、F.4 行为与验收段、README 适用公共合同及必要接口；**源码阅读、构建、测试全部下发给你的子代理**。你负责按下述顺序交接接口、集成判断、独立审核、文档和提交。每个子代理只领一个有验收结果的子目标，不整票转派；不读历史大包，不研究新架构。

## 范围与顺序

1. `evolution` 消费具体 `diagnosisId`，在可信 supervisor 委派下幂等启动候选；空建议、关闭开关、无额度或未知执行目标具名停止。候选仅限已有 Skill 同名更新，或**一条 capability 整行变更**及可选的新 execution Skill（`SKILL.md` + 现有 sidecar，`resources=[]`）。L1 用已有授权能力，L2 的 Skill 内容由 Agent 生成。新工具、verifier 实现、权限、任意资源包直接拒绝。
2. 复用 S4-E 双侧真实评估：同一冻结契约，缺 provider 的基线记录真实 `not-admitted`，候选走原准入、执行、独立 verifier、回归与 holdout。候选同时加载 capability override 和额外 Skill 根；不得把准入或 scripted 输出充作任务修复。复用 K2/K3 唯一意图、应用和回滚协议，联合提交 capability 行与完整 Skill；完成事实晚于全部对账及可加载检查。生产半成品不准入。
3. `task_recover({sourceDiagnosisId, requestKey})` 只给可信 supervisor。调用链固定为工具适配 → evolution 核对交接身份，**能力变更才核对批准及已应用** → task-runtime 重检本 store 的失败源、原契约、依赖、provider、预算和幂等 → 原执行 driver 开新根 Run/Session。纯产物缺口只核对来源与生产所需能力，不要求不存在的 EvolutionProposal。旧失败、Review、Evidence 不改；不重置 K4 累计额度，不热换在途 Run。成功来源和无适用比较器的优化建议不得应用或恢复。
4. 恢复时复用 K1 多批次及普通准入/验证/结算。有效兄弟证据以具体 Run/Evidence/输入/产物身份绑定到**原 AC 的 childEvidence 位置**；坏引用拒绝并列出受影响项，由 Agent 新提案补做。产物缺口沿 producer/dependsOn/Obligation 新建或执行合法生产任务；不要求待生产的产物预先存在，也不为产物修复强造 EvolutionProposal。受影响消费者仍过原依赖闸；根提交前检查产物与 evidence 确已满足，再由原根 AC 独立验收。
5. 逐接口完成候选/提交 → 评估 → 恢复 → supervisor 接线 → 组合验收，前一接口定向验收后再交给下一子代理。删除被替换的生产路径和消费者；不加第二调度器、状态机、预算账、事务平台、兼容壳或“以后再接”的空入口。

## 验收：逐项给出公开入口、事实和拒绝副作用

| 编号 | 必须为 PASS 的外部结果与反例 |
|---|---|
| EVO-1 | 冻结两个临时案例：L1 由真实 Agent 组合现成授权能力解决一个真实缺口；L2 由真实 Agent 产出新 execution Skill/sidecar，独立 verifier 通过后进入 DSH 人审，批准前生产零变更。记录原始模型请求、工具轨迹、候选文件身份、验证和判决；人工手写候选或 scripted Agent 只能证明接线，不能证明本项。agent 越权或人审拒绝时零应用。 |
| EVO-2 | 缺 provider 的基线沿真实准入返回 `not-admitted`、无伪造 Run/champion；候选真实执行并通过同一冻结判据、回归及 holdout。错误候选、弱化 verifier、越权工具、内容漂移、人审拒绝都零应用、零成功恢复；成功来源的“更快/更省”缺冻结比较器时保留建议，零晋升/应用/新 Run。 |
| EVO-3 | 能力缺口与产物缺口各自走真实 source → Diagnosis → 处置 → `task_recover` → 新根原 AC 独立验收。相同 diagnosis/key 重试只返回同一新尝试；成功源、跨 graph、错误 diagnosis、**能力变更无批准应用**或超额均零新 Run；纯产物缺口无 EvolutionProposal 时，在来源和生产能力有效的前提下仍可开新尝试。有效兄弟不重跑；无效引用拒复用并显式补做；产物未真正满足时消费者依赖闸及根提交拒绝；旧失败事实可读。 |
| EVO-4 | 联合提交的每个持久边界，以及新 Run 创建后/批次准入前、准入后/spawn 前、新根结算前，分别注入死亡并重开：provider 无半成品可用，同 key 无重复 Run/批次，预算不归零。重复批准、取消、回滚后新准入重检；第三方改变具名停止；旧在途 Run 仍用原版本。不得以同进程异常模拟冒充跨进程重开。 |
| EVO-5 | 从公开 `task_recover` 和新批次追踪到既有规范化、准入、执行闸、driver、结算和 Task 预算事实；直接服务入口也重检其所有权规则。候选构建/评估中的业务 Run 计原 store 累计上限，额度已满时零准入、不自动续额；实验模型费用另记。取消/重启与合法正例均通过；evolution 仅协调候选及能力变更的批准应用，runtime 不依赖 evolution 账本或模型自填的 approved 标志。 |

**真实 Agent 实验授权**：仅在临时 fixture 中使用 `/home/ROXY/code/bb_work/harness/config.yml` 已配置的免费 `step-5-preview`，它是 Harness 被测 Agent 的模型，**不是 Kimi 派发模型**。先冻结两个案例的输入、原 AC、独立 verifier、holdout 与预计工具权限，再运行；每例最多 3 次、每次最多 15 分钟，合计模型运行不超过 90 分钟。保留每次失败和费用/用量记录，不改生产 Skill/config，不打印凭据，不部署。DSH 人审在临时 fixture 用受控允许/拒绝输入验证门；不能把模拟回答称为真人批准，也不能由 Agent 自批。若模型或配置不可用，如实停在待验收并给具体阻塞；不能用机制测试冒充 EVO-1 实跑。

## 交付前审核闸

先以定向 RED→GREEN 验证新增行为与拒绝副作用，穿过真实模块接口；每项至少一个合法正例和一个能改变最终结果的反例。**Kimi 主代理交付前另派自己的独立只读子代理**，按 EVO-1～EVO-5 逐项给 `PASS/FAIL`、入口、证据、拒绝副作用，并主动找能让假成功通过的反例；审核者不得只读测试名、测试总数或实现者摘要。任何 FAIL 都在本票修复、让独立子代理重审通过后再回来，不改合同、不写作“已知边界”、不转给下一票。未实跑真实 Agent、未跨进程重开或未覆盖直接入口均不能报整票 PASS。

最终代码树的公共 build、unit、integration、verify-persistence、`tsc --noEmit`、`git diff --check` 各跑一次，由集成子代理执行；只在具体失败处定向复跑。全量绿不代替 EVO 判决，已知无关 flake 须给文件和可复现边界，不把本票失败归成 flake。同步主 guide、唯一计划、第 14 行和必要的持久化记录，交付记录简列 EVO-1～EVO-5 的输入/结果/持久副作用/审查结论、真实 Agent 运行证据、删除清单、检查结果及两仓 SHA。只提交本票和外层子模块指针，最高填**待验收**；不推送、不部署、不派下一票。
