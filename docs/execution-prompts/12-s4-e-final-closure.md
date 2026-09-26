# 第 12 项 S4-E 收尾：删除余下旧路径，闭合写前拒绝

你是实现主代理。工作区 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层 `/home/ROXY/code/bb_work/harness`。本轮被审交付 `e8c0799` / 外层 `882d3ffefb` 已被[收尾审核](../history/2026-09-26-s4-e-final-closure-review.md)判返工；核对实际 HEAD，按[公共合同](README.md)保存基线。读主 guide §5.17、[计划 F.2](../2026-09-20-vrtc-code-change-plan.md)及本次审核即可，历史 prompt 不作当前指令。完成本票并经独立审核后才可进入 A5。

## 固定合同

本阶段只有“替换已存在单文件 SKILL.md → 双侧真实实验 → gate 记录回答/证据 → decide/apply 两次人审 → rollback”的可执行路径。其他方向可记录建议；记录不授予执行资格。无 mutation 的候选、新建 Skill、非 Skill 候选均不建空壳流程。A6 后续按 F.4 建新的 capability 双侧评估。

实验只支持可选总 `maxTokens`，没有实验级时间预算；普通 Run 的部署时限仍有效。进入实验的每条 AC 必须显式 pin 已注册且有版本的 verifierRef。gate 只记录回答/证据；PROMOTE/apply 用现有同一检查拒绝超额、漂移、缺指标和伪证，不把第二个晋升闸塞进 gate。

Evolution ledger 只读写 `formatVersion: 2`，旧版/缺版本/混合版在写前报错。普通 Task replay、Review.durationMs、根时限、当前 SKILL.contract.json v1 侧车继续使用。真实旧账切换前由操作方核对最终状态、原字节归档、从空新账启动；本票只做 fixture 验证及现场只读盘点，不部署、改写真实账本或建迁移程序。

## 只关闭以下缺口

### 1. 账本入口只接受当前版本和当前形状

落点为 evolution 的既有记录校验、fold 和写入口。当前 `recordExperimentStart/Sample` 可把调用者提供的 v1 记录写进 v2 账，重开才失败。让这两个入口在持久写及幂等成功返回前检查版本；正常写、重开使用相同规则。直接抛错，不忽略、重写版本或自动补字段；不新建版本平台/helper。

fold 也只接受本阶段可写的生命周期：非 Skill 只能 proposed；candidate 必须有 Skill mutation；prepared 必须有已捕获基线与内容身份；decided 必须有人审引用。删除旧非 Skill mutation 校验、无 mutation candidate→gated、bookkeeping prepared、前绑定/前基线兼容形状；仍需拒绝非法状态，不以删除检查实现瘦身。保留建议的多种 targetType，不能误删普通建议记录。

验收：两个 record 入口分别直调 v1、无版本记录，含重复 experiment identity 情形，具名拒绝且账本字节不变；合法 v2 记录重开成功。伪造 v2 非 Skill candidate、无 mutation candidate、prepared 缺内容/基线、decided 缺人审引用均拒绝；完整当前 Skill 账可重开、应用、回滚。只服务旧格式的 fixture 改为入口拒绝验证，不能将 version 从 1 改成 2 后继续测试旧生命周期。

### 2. Skill 路径从服务到模型说明一致

在 candidate 服务与工具 schema 中要求 `mutation: { name, content }`，只校验当前闭合形状；缺失或旧形状在 candidate 落账前拒绝。prepare 在任何 sandbox/ledger 写前确认现有生产 SKILL.md，并用同一次读取生成基线快照/摘要；缺文件直接报错。删除仅供新建 Skill/旧账使用的 champion-missing、回滚删目录和相应旧说明，保留当前替换/恢复原字节路径。

逐一核对 root Evolution 协议及九个工具的 schema、说明、成功/拒绝返回。尤其 `evolution_propose` 对非 Skill 建议不得再返回 `next: evolution_candidate`；`evolution_list` 不再宣传无 mutation 直接 gate；prepare/apply/rollback 不再宣传新建 Skill；不引导人类手写生产改进。建议成功只说明已记录和当前支持范围。

同批删除已无生产消费者的 `presetRoot/configFile` 配置/属性/初始化、旧 mutation 类型/导出和仅依赖它们的夹具；按真实消费者确认，不为 A6 预留兼容壳，不借机清空仍服务普通 Task/Run/Verifier 的能力。

验收：缺 mutation 零 candidate 写；缺生产 Skill 零 prepared/零 sandbox 写；非 Skill 建议可记录且不给错误下一步；旧候选入口服务直调拒绝。模型工具面与真实成功返回均检查，不能只 grep 三个已删除的符号。合法 Skill 双侧 Run/verifier→gate→两次人审→apply→rollback 通过。

### 3. 底层 replay 直调拒绝已删除参数

落点仅 `task-runtime/src/index.ts:replayTask` 的公开 options 边界。现状带 `wallTimeMs` 会静默忽略并 spawn；在任何 Task/Run/工作区写前按当前 options 字段集拒绝未知键，复用现有就地校验，不加旧字段适配器、第二计时器或通用校验框架。

验收：真实 runtime 直调带旧 `wallTimeMs` 具名拒绝，Task/Run/spawn/工作区均无新增；合法 replay（包括 model/workspace 绑定）仍通过，配置根时限的 Run 仍按现有规则取消。Evolution 实验 budget 的旧字段拒绝保持。

## 执行与交付

先应用[7 条反例补丁](../history/2026-09-26-s4-e-closure-counterexamples.patch)确认红证据，再实施并将用例归入现有测试。补丁是被审版本的检查材料，接口变化时只调整接线，不改弱结果断言。新增必要拒绝场景按上文验收补齐；不做假想输入矩阵。

若委派：账本版本写边界、Skill 生命周期、工具模型说明、runtime options 各是一个窄子目标；共享 evolution.ts 的工作串行交接。子代理只跑相关测试，主代理负责跨入口组合、删除清单、文档及公共检查，不能将本票整包转派。

按公共合同完成 build、unit、integration、persistence、类型和 diff 检查，保留 Q2/Q4 及 EVAL-1～EVAL-5 现行正例。旧删除工作无需重做；本票不增加评估种类、自动 reviewer、恢复调度、helper 或兼容层。

同步主 guide、唯一计划、持久化说明及一份交付记录，逐项填入拒绝时的实际副作用与重开结果；历史审核原样保留。提交 Singularity 和外层仅该子模块指针，最高填待验收，停止等待进度审核。不调用付费模型、不推送或部署。
