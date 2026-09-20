# VRTC-KISS 建设计划

更新：2026-09-21。保留原文件名作为稳定入口；原临时计划在 [历史快照](history/2026-09-21-vrtc-plan-snapshot.md)。
方向与实现事实以 [工作指南](singularity-harness-guide.md)为准；本文仅描述建设顺序、代码落点与可验收结果。
基线备份：Singularity `b00915c`，外层 harness `6c5eb49894`。

## 当前排期

| 票据 | 状态（2026-09-21） | 依赖 | 交付范围 |
|---|---|---|---|
| S0 | 已完成，验证结果见文末 | 无 | 文档去漂移、术语统一、worker 能力查询 |
| S1-V | 待建；复用已有 verifier/evidence | S0 | 可信验收、父级组合检查、有效产物引用 |
| S1-C | 待建；复用已有 capability/grant | S0 | provider 预检、skill 分类契约、run 解析快照 |
| S2-E | 部分：已有手动 L4 工具与 raised 台账 | S0 | 自动缺口记录/通知、决策生命周期、结构化拒绝 |
| S2-R | 待建；已有 blocked/obligation 记录 | S1-V、S1-C、S2-E | 缺口补齐后的有限恢复、预算与判决处置 |
| S3 | 待建 | S1-V、S1-C、S2-R | L1 复用/组合优先，L2 沙箱生成后置 |
| S4 | 待建；复用已有 review/evolution | S3 | 结构化 Retro、分层指标、自动接受硬闸 |

旧计划的阶段 1.1/1.2（assumptions/requiresArtifact）、1.4（verifierRef）、3.3（义务记录）已有代码；不重复建设。
阶段 1.3 预算、2.1 四值判决、2.2 verifier selftest 只有部分完成。阶段 3.1 L4 已有工具，但无自动与恢复闭环。
侧车契约从旧阶段 5 前移到 S1-C，避免先生成技能再补“什么算有效技能”的规则。

## S1-V：先保证验的是目标

落点：`task/src/types.ts`、`verifier/src/index.ts`、`verifier/src/composite-verifier.ts`、`task-runtime/src/admission.ts`、`task-runtime/src/orchestrate.ts`。

分成三个可独立验收的切片：

1. **父级验收**：为客观的小型任务建立父 AC → 子证据映射；实现至少一个独立父级组合检查。默认 composite 的“子全 verified”只能作为汇总，不足以代表根目标。
2. **验证器自测与输入身份**：将当前 selftest 描述落为可执行正负样本；注册/晋升时执行。记录 verifier 版本，固定测试与阈值来源，明确 worker 可写产物与受保护验收输入的边界。
3. **证据依赖有效性**：把当前全 store 的 kind/id 存在性匹配收敛为明确的产物来源、版本/摘要与所需验证状态；普通原始输入与“必须已验证的参考产物”分开表达。不能把失败 run 的同名产物当作正确性证据。

验收：子任务都通过但组合接口错误，父必须拒绝；删掉父 AC 的证据映射必须拒绝；负样本可检出；修改验收脚本不能把错误产物变成 PASS；同名过期/失败证据不能满足要求已验证参考的依赖。自然语言蕴含留作有标记的启发式判断。

## S1-C：Task 只提需求，Run 固定实现

落点：`task-runtime/src/capability.ts`、`task-runtime/src/index.ts`、`agent-runtime/src/grants.ts`、`task-runtime/src/handoff.ts`、`task/src/types.ts`。DSH skill 发现/加载服务继续复用。

1. **便宜的预检先落地**：用实际 worker 的 cwd/preset 发现路径检查已配置 skill；多 preset 冲突必须拒绝并说明是哪两项能力冲突。不要沿用“首个胜出”作为长期协议。已知不可用的配置在子任务落库前拒绝，失败的 MCP 启动仍在 spawn 阶段记录。
2. **类型化侧车契约**：执行型包含 capability、precondition、inputs、outputs、required tools、verifier 引用和内容身份；知识型包含来源/范围/内容身份与内容检查引用，不参与执行闭包。为 BB 两个知识 skill 和至少一个执行 skill 建最小样例。首版不做五级成熟度与成功率衰减。
3. **统一校验入口**：配置载入、provider 替换、候选晋升都使用同一校验；`evolution_apply` 不是唯一防线。没有合法执行 verifier 的执行型 skill 不能被计为有效 provider。
4. **run 摘要和记录**：worker 获取当前 run 的选定 capability/skill 摘要，正文按需读；记录 registry 修订、skill 内容摘要及 preset/MCP 身份，沿用现有快照机制扩展，不把 skill id 写入 Task 契约。

验收：不存在的 skill、未知执行 verifier、工具声明不满足、冲突 preset 均在预检拒绝；知识型可加载但不能关闭执行 GAP；替换 provider 不改 Task AC；老 run 能定位旧内容；子节点递归分解无需猜能力名；加载未选 skill 不扩大工具权限。

效率验证留在此票完成后：固定任务集与模型、环境，对比“全库自主检索”与“预选摘要+按需正文”的成功率、总 token、首个有效调用延迟、检索次数、GAP 率。不得只凭 token 降低宣布更高效，也不承诺全局 catalog 已裁剪。

## S2-E：把上报变成可追踪出口

落点：`agent-singularity/src/escalation.ts`、`agent-singularity/src/tools/escalate.ts`、`task-runtime/src/orchestrate.ts`、`task-runtime/src/index.ts`、工具错误返回适配。

已有：root 手动 `escalate`、三要素检查、原生 approval、批准后的 raised 台账；能力缺口/预算/坏 verifier 的文本提示。

待建：

- 自动持久化缺口事实，并按 task/run/缺口身份去重；不要求模型再次调用才能留下可观察记录。
- 将“通知发生”与“同意处置”分开：通知只说明 what/tried/suggested，新增权限、生产修改、残余风险签收分别走授权。
- 定义 raised → 等待/已决策/已解决的最小事件合同，关联 Task/Obligation；拒绝或取消仍保留缺口状态，不假装修复。
- 用上游工具框架支持的错误机制返回准入拒绝；上层能区分拒绝、运行失败和人类未批准。先查 DSH 声明，不自造 `isError` 文本。

验收：模型不响应也能看见缺口；重启/重复触发不重复通知；拒绝不丢记录、不提权、不把任务标成功；决策能关联到待恢复任务。现有批准后记录的行为变化必须带持久化协议记录，不能静默改变历史日志含义。

## S2-R：恢复已有图，而非重建一批任务

落点：`task/src/service/state.ts`、`task/src/index.ts`、`task-runtime/src/index.ts`、`task-runtime/src/orchestrate.ts`、`task-runtime/src/obligation.ts`。

先写状态与事件合同再编码：blocked 原因、待满足条件、解决证据、重新准入、恢复尝试。契约保持原样；条件重检后创建或继续合适的 Run，不能改已有证据和终态。父任务“只分解一次”的现有约束意味着恢复必须有独立入口，不能再次调用原 decompose 批次。

本票同时消解两类停滞：能力补齐和产物补齐。优先支持显式绑定的生产者/依赖关系与父级一次重规划，不先做全局义务调度器。

预算与判决：为 attempts/noProgressRounds 接入实际计数与停止动作；tools/tokens 要么保持明确的软限额，要么接入运行中计数后再宣称硬限额。定义 PARTIAL/UNKNOWN 的任务级处置；UNKNOWN(verifier) 修裁判，UNKNOWN(task) 补取证，均不变成 PASS。四值升级需同步 reducer、工具、UI 和持久化 schema。

验收：人为缺一个 provider/参考产物，补齐后恢复原受阻分支；已通过兄弟不重跑；历史失败仍可追溯；重启后状态一致；连续无进展达到上限只上报一次；坏 verifier 不触发无限重试。`coverage` 统计要区分“声明覆盖”和“证据满足”。

## S3：先复用，再生长 Skill

L1 从已有授权 skill/tool 组合完成一个具体义务开始；一次成功的临时组合不强制立即注册复合 skill。只有重复出现、接口稳定且独立验证成立，才沉淀候选，避免技能库随任务数量膨胀。

L2 复用 `evolution_prepare` 的沙箱与 `ReplayOverlay.extraSkillRoots`。生成内容必须带执行契约和自身 verifier；通过 S1 校验、正负样本与回归，经过既有生产变更授权后才能成为 provider。L3 新工具引入仍单独过权限检查。

验收：人为制造一个 GAP，L1 用现成能力组合消解；L1 无解时 L2 产生可验证候选；无 verifier 的候选不能注册；补齐能力经 S2 恢复原任务。失败路径留完整上报，不要求所有 GAP 自动成功。

## S4：让复盘产生受约束的改进

落点：`agent-singularity/src/replay.ts`、`agent-singularity/src/evolution.ts`、`agent-singularity/src/tools/evolution-replay.ts`、现有 ReviewRecord/Diagnosis 消费链。

输入完整成功/失败轨迹，输出问题模式、适用条件和改进候选。Skill/Capability 比成功率与成本；Verifier 比漏检/变异检出，禁止只看通过率；Task 模板做难度归一化。observed 与 holdout 分开过关，无 holdout 的结果不能获得自动生产晋升资格；回归结果约束 gate/decide/apply。

验收：弱化 verifier 虽提高通过率仍被拒绝；只改善训练样本而退化 holdout 的候选被拒绝；拒绝有日志，晋升可回滚。自动候选生成可以先行试验，自动接受须等上述闸门完成。

## S0 本次交付与验证

- 重写当前指南与本计划，历史快照保留原文；补术语表、文档入口和 BB 领域指导中的机制边界。
- 修复 worker baseline 缺少 `capability_list`，覆盖普通 worker 的真实工具过滤集成场景，并继续断言 graph/evolution/平台 HITL 不被授予。
- 本次不新增事件、不改生产配置、不重启运行中的服务；修改后需由现有部署流程加载构建产物。
- 验证结果（2026-09-21）：`pnpm build` 通过；Singularity 单测 25 文件 / 544 项通过，集成 19 文件 / 94 项通过；`verify-persistence` 的 4 个事件根指纹一致；两个 BB skill 的 `quick_validate.py` 通过。构建有现有前端 bundle 大小提示，不影响成功退出。
- 首次集成测试与构建并行，构建清理 `lib/` 时两套测试无法解析 task-runtime 包入口；构建完成后重跑全部 Singularity 集成测试通过。后续验证应先完成 build，再运行依赖 `lib/` 的测试。
- 本次未跑真实 LLM、BB 构建仿真或生产 Evolution；这些不是上述自动测试的覆盖承诺。
