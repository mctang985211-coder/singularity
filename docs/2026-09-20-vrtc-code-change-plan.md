# VRTC-KISS 建设计划

更新：2026-09-21。保留原文件名作为稳定入口；原临时计划在 [历史快照](history/2026-09-21-vrtc-plan-snapshot.md)。
方向与实现事实以 [工作指南](singularity-harness-guide.md)为准；本文仅描述建设顺序、代码落点与可验收结果。
基线备份：Singularity `b00915c`，外层 harness `6c5eb49894`。

## 当前排期

| 票据 | 状态（2026-09-21） | 依赖 | 交付范围 |
|---|---|---|---|
| S0 | 已完成，验证结果见文末 | 无 | 文档去漂移、术语统一、worker 能力查询 |
| S1-V | 部分：verifier 返回边界校验已建 | S0 | 可信验收、父级组合检查、有效产物引用 |
| S1-C | 部分：多 preset 冲突已在解析期拒绝 | S0 | provider 预检、skill 分类契约、run 解析快照 |
| S2-E | 部分：已有手动 L4 工具与 raised 台账 | S0 | 自动缺口记录、supervisor 交接、人审改进与例外上报、结构化拒绝 |
| S2-R | 待建；已有 blocked/obligation 记录 | S1 最小切片、S2-E；与 S3 联合验收 | agent 补齐缺口后的系统恢复、预算与判决处置 |
| S3 | 待建 | S1 最小切片、S2 交接/恢复协议；与 S2-R 联合验收 | L1 复用/组合与 L2 沙箱生成，验证后提交人审改进 |
| S4 | 部分：报告自洽、摘要与机械晋升最低闸已建 | S3；验证底座可提前 | 结构化 Retro、分层指标、自动接受硬闸 |

旧计划的阶段 1.1/1.2（assumptions/requiresArtifact）、1.4（verifierRef）、3.3（义务记录）已有代码；不重复建设。
阶段 1.3 预算、2.1 四值判决、2.2 verifier selftest 只有部分完成。阶段 3.1 L4 已有工具，但无自动与恢复闭环。
侧车契约从旧阶段 5 前移到 S1-C，避免先生成技能再补“什么算有效技能”的规则。

**实施粒度与人审职责修正（2026-09-21）**：这些票是责任分组，不要求完整平台齐备后才建自主闭环。先选一个小型任务，以 S1 的最小验证/能力契约、S2 的缺口交接/恢复和 S3 的自主补路径共同交付。Supervisor 诊断、实现候选并组织验证，人类只审核改进与证据，批准后系统应用并恢复。“人工补能力后恢复”不作为阶段完成条件；fixtures 只能用于底层测试。依据：细化想法4 §33、KISS §7/§12 第 3 步。完整侧车平台可以后置，实际候选的最小契约和验证不可省。

## S1-V：先保证验的是目标

落点：`task/src/types.ts`、`verifier/src/index.ts`、`verifier/src/composite-verifier.ts`、`task-runtime/src/admission.ts`、`task-runtime/src/orchestrate.ts`。

分成三个可独立验收的切片：

1. **父级验收**：为客观的小型任务建立父 AC → 子证据映射；实现至少一个独立父级组合检查。默认 composite 的“子全 verified”只能作为汇总，不足以代表根目标。
2. **验证器自测与输入身份**：将当前 selftest 描述落为可执行正负样本；注册/晋升时执行。记录 verifier 版本，固定测试与阈值来源，明确 worker 可写产物与受保护验收输入的边界。
3. **证据依赖有效性**：把当前全 store 的 kind/id 存在性匹配收敛为明确的产物来源、版本/摘要与所需验证状态；普通原始输入与“必须已验证的参考产物”分开表达。不能把失败 run 的同名产物当作正确性证据。

验收：子任务都通过但组合接口错误，父必须拒绝；删掉父 AC 的证据映射必须拒绝；负样本可检出；修改验收脚本不能把错误产物变成 PASS；同名过期/失败证据不能满足要求已验证参考的依赖。自然语言蕴含留作有标记的启发式判断。

## S1-C：Task 只提需求，Run 固定实现

落点：`task-runtime/src/capability.ts`、`task-runtime/src/index.ts`、`agent-runtime/src/grants.ts`、`task-runtime/src/handoff.ts`、`task/src/types.ts`。DSH skill 发现/加载服务继续复用。

1. **便宜的预检先落地**：多 preset 冲突检查已完成，同名声明允许合并，异名在 `resolveCapabilities` 阶段拒绝，普通分解与 replay 共用。待建部分是用实际 worker 的 cwd/preset 发现路径检查已配置 skill 等资源。已知不可用的配置在子任务落库前拒绝，失败的 MCP 启动仍在 spawn 阶段记录。
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
- 正常 GAP 交给执行/父节点尝试授权内的检索与组合；需要改进能力时交给 supervisor 消费轨迹/Diagnosis，生成并验证候选。复用现有工具组织该角色，不能把缺口通知人类当作自主处置已完成。
- 将“通知发生”与“同意处置”分开：通知只说明 what/tried/suggested，新增权限、生产修改、残余风险签收分别走授权。
- 人审请求提供候选 diff、失败原因、基线对比、正负样本、回归/holdout 结果和回滚对象；审核的交付物是已经实现并验证的改进，不是让人填写缺失实现的任务单。
- 定义 raised → 等待/已决策/已解决的最小事件合同，关联 Task/Obligation；拒绝或取消仍保留缺口状态，不假装修复。
- 用上游工具框架支持的错误机制返回准入拒绝；上层能区分拒绝、运行失败和人类未批准。先查 DSH 声明，不自造 `isError` 文本。

验收：模型不响应也能看见缺口；可解决的 GAP 进入 agent 处置；重启/重复触发不重复通知；拒绝候选不丢记录、不提权、不把任务标成功；审核通过能关联到系统待恢复任务。L4 用于自主路径不可行、预算耗尽或需外部决策的例外。现有批准后记录的行为变化必须带持久化协议记录，不能静默改变历史日志含义。

## S2-R：恢复已有图，而非重建一批任务

落点：`task/src/service/state.ts`、`task/src/index.ts`、`task-runtime/src/index.ts`、`task-runtime/src/orchestrate.ts`、`task-runtime/src/obligation.ts`。

先写状态与事件合同再编码：blocked 原因、待满足条件、解决证据、重新准入、恢复尝试。契约保持原样；条件重检后创建或继续合适的 Run，不能改已有证据和终态。父任务“只分解一次”的现有约束意味着恢复必须有独立入口，不能再次调用原 decompose 批次。

本票同时消解两类停滞：能力补齐和产物补齐。优先支持显式绑定的生产者/依赖关系与父级一次重规划，不先做全局义务调度器。

预算与判决：为 attempts/noProgressRounds 接入实际计数与停止动作；tools/tokens 要么保持明确的软限额，要么接入运行中计数后再宣称硬限额。定义 PARTIAL/UNKNOWN 的任务级处置；UNKNOWN(verifier) 修裁判，UNKNOWN(task) 补取证，均不变成 PASS。四值升级需同步 reducer、工具、UI 和持久化 schema。

验收：人为移除一个 provider/参考产物，agent 按 S3 自动构造解决路径；涉及候选晋升时经人审，随后系统恢复原受阻分支；已通过兄弟不重跑；历史失败仍可追溯；重启后状态一致；连续无进展达到上限只上报一次；坏 verifier 不触发无限重试。`coverage` 统计要区分“声明覆盖”和“证据满足”。

## S3：先复用，再生长 Skill

L1 从已有授权 skill/tool 组合完成一个具体义务开始，由 agent 自主尝试。组合及其证据记录为可复用候选（KISS §7 的“入库”），不直接覆盖生产稳定 skill；通过验证及改进审核后晋升。一次性的执行编排保留在轨迹中，不能把“尚未多次复用”作为禁止 agent 提出新候选的条件。

L2 复用 `evolution_prepare` 的沙箱与 `ReplayOverlay.extraSkillRoots`。生成内容必须带执行契约和自身 verifier；通过 S1 校验、正负样本与回归，经过既有生产变更授权后才能成为 provider。L3 新工具引入仍单独过权限检查。

验收：人为制造一个 GAP，L1 用现成能力组合消解；另设 L1 无解但现有工具足够的案例，由 supervisor 自主实现 L2 候选及验证，不由人编写 skill。无 verifier 的执行型候选不能注册；验证通过后人审改进，批准即由系统晋升并经 S2 恢复原任务；拒绝则保留证据，按预算修订候选或上报。至少一个错误候选被验证闸拒绝。只有已有能力/授权/预算无法解决的路径才进入 L4，不要求所有 GAP 自动成功。

Supervisor 的范围并不永久限定于 skill：后续按细化想法4 §30 覆盖 template、context/preset、routing、Verifier、admission/runtime policy；高风险候选仍由 agent 实现和验证，人类审核晋升。当前这类自动组织尚未实现，已有 Evolution 工具链仅是可复用基础。

## S4：让复盘产生受约束的改进

落点：`agent-singularity/src/replay.ts`、`agent-singularity/src/evolution.ts`、`agent-singularity/src/tools/evolution-replay.ts`、现有 ReviewRecord/Diagnosis 消费链。

输入完整成功/失败轨迹，输出问题模式、适用条件和改进候选。Skill/Capability 比成功率与成本；Verifier 比漏检/变异检出，禁止只看通过率；Task 模板做难度归一化。已实现 observed 与 holdout 各自非空且不退化的机械候选 PROMOTE/apply 闸；无 holdout 或 manual 报告不具备该资格，人审不能替代执行证据。gate 仍允许有效的负面报告进入 REJECT/研究流程。

验收：弱化 verifier 虽提高通过率仍被拒绝；只改善训练样本而退化 holdout 的候选被拒绝；拒绝有日志，晋升可回滚。自动候选生成可以先行试验，自动接受须等上述闸门完成。

## S0 本次交付与验证

本节记录首轮文档修订；后续样本改造单独记录于文末。

- 重写当前指南与本计划，历史快照保留原文；补术语表、文档入口和 BB 领域指导中的机制边界。
- 修复 worker baseline 缺少 `capability_list`，覆盖普通 worker 的真实工具过滤集成场景，并继续断言 graph/evolution/平台 HITL 不被授予。
- 本次不新增事件、不改生产配置、不重启运行中的服务；修改后需由现有部署流程加载构建产物。
- 验证结果（2026-09-21）：`pnpm build` 通过；Singularity 单测 25 文件 / 544 项通过，集成 19 文件 / 94 项通过；`verify-persistence` 的 4 个事件根指纹一致；两个 BB skill 的 `quick_validate.py` 通过。构建有现有前端 bundle 大小提示，不影响成功退出。
- 首次集成测试与构建并行，构建清理 `lib/` 时两套测试无法解析 task-runtime 包入口；构建完成后重跑全部 Singularity 集成测试通过。后续验证应先完成 build，再运行依赖 `lib/` 的测试。
- 本次未跑真实 LLM、BB 构建仿真或生产 Evolution；这些不是上述自动测试的覆盖承诺。

## 能力解析参考样本（2026-09-21）

修改前回退点：Singularity `f3842b5`，外层 harness `3d07bb0f8c`，包含上一轮文档与 worker 查询修复。

- 变更：在现有能力解析模块集中约束“一 worker 只选一个 preset”；相同值可组合，不同值在落库前明确拒绝，无声明才采用默认值。未新增服务、schema 或生产配置。
- 测试覆盖：同名能力组合、能力顺序反转、直接提供的冲突 manifest、分解整批零副作用拒绝，以及 replay 的同一拒绝规则。
- 后续构建风格见工作指南 §5.4；完整 skill 预检与版本快照仍属待建，不能据本样本标记 S1-C 完成。
- 验证（2026-09-21）：先完成 `pnpm build`，再运行全部 Singularity 单测（25 文件 / 549 项）和集成测试（19 文件 / 94 项），均通过；持久化 4 个事件根指纹一致，`git diff --check` 通过。本轮新增 5 项行为测试。未运行真实 LLM 或 BB 仿真，未重启生产服务。

## 演进验证底座与接续安排（2026-09-21）

修改前回退点：Singularity `da48925`，外层 harness `088a8d9`。

本批实现三项相连的难点：verifier 插件返回的身份/判决校验；replay 明细与总评一致性、样本身份不重用与契约变化识别；报告摘要绑定及 observed/holdout 共同约束机械晋升。工具预检减少无效人审，service 复检阻止报告在审核后被替换。没有新增调度服务，也没有宣称自动 supervisor 和恢复已实现。

后续按以下小批次推进，不等待 S1/S4 全平台建完：

1. **固定实际评估对象**（S1-C / S4）：prepare 记录候选内容摘要，replay 固定 manifest/run/evidence 身份，apply 写入同一版本；禁止先验证 A 再应用 B。补 preset 沙箱解析/执行，解除 manual replay 的当前阻塞。验收包含报告自洽但伪造来源、回放后替换候选文件两类反例。
2. **补目标验证最小闭环**（S1-V）：选一个可确定性检查的父级目标，增加独立组合判据；依赖引用区分原始输入与要求已验证的产物。verifier 正负样本实际执行，固定判据来源；相同失败不能仅凭不退化被视作修复。模板改判据应交由独立固定基准比较，不能只改变 command 后继续比较通过率。
3. **联合实现自动补路径与恢复**（S2-E / S2-R / S3）：定义 gap/obligation 身份及解决事件，supervisor 消费一次诊断、实现候选、调用已有评估工具；人审改进后系统应用并重新准入受阻分支。先交付一个 L1 和一个 L2 案例，覆盖拒绝、重启去重和预算停止。不得以人工编写 skill 的演示代替验收。
4. **扩大改进目标**（S4）：以完整轨迹驱动 Retro，增加成功率/成本、verifier 漏检/变异检出、模板难度归一化指标。当前非退化闸不能作为全面自动接受的完成证据；更广的运行时/裁判修改仍由 supervisor 实现验证、人审核。

现有 decide/apply 各有一次人审，本批保持该行为。后续可将批准绑定到候选摘要与报告摘要，使同一已批准版本自动 apply/resume；权限扩大或内容变化需要新的决策，不能把审批次数减少实现为绕过对象身份校验。

验证：`pnpm build` 通过；全部 Singularity 单测 25 文件 / 570 项、集成 19 文件 / 94 项通过；`verify-persistence` 的 4 个事件根指纹一致，`git diff --check` 通过。新增 21 项测试覆盖坏 verifier、伪造比较、缺失/退化 holdout、manual 晋升拒绝、人审前预检、报告替换及旧 ledger 回滚。集成 replay 使用运行时 stub，未运行真实 LLM、BB 仿真或生产晋升，未重启服务。

额外类型检查：verifier 的 `tsc --noEmit` 通过；agent-singularity 仍有 12 处错误（SessionId 调用、DiagnosisProposal 与 mutation 收窄）。以 TypeScript compiler host 读取 `da48925` 的原始 src 对照，基线同样有这 12 处错误，本批未新增。当前 `pnpm build` 不代表该包严格类型检查通过；后续改对应边界时应修正类型来源，并将 tsc 接入建设检查。
