# Singularity 确定性构建任务

日期：2026-09-21。本目录保存执行合同，完成状态以建设计划为准；P1–P4、T1、S1-V 切片 2、S1-C 与 A3 已完成（见建设计划记录）；T2/T3 与 A0–A2、A4–A6 待执行。
准备文档前备份：Singularity `6fe9c26`，外层 harness `1afb656`。

## 派发顺序

1. [P1：严格类型检查](01-root-agent-typecheck.md)
2. [P2：单文件 Skill 内容绑定](02-skill-content-binding.md)，基于 P1 验收后的代码执行。
3. [P3：过期 Skill 候选拒绝](03-skill-champion-check.md)，基于 P2 验收后的代码执行。
4. [P4：独立父验收与证据身份](04-parent-acceptance-evidence-identity.md)，基于 P3 验收后的代码执行；S1-V 切片 2（verifier selftest 执行）不在本票。

下一项见 [建设计划](../2026-09-20-vrtc-code-change-plan.md)文首唯一顺序（唯一顺序第 5 项 T2+T3 交付组：契约审核与恢复；第 4 项 A3 已于 2026-09-22 验收）。唯一后续顺序以建设计划文首表为准；不要按文件名、T/A/S 编号或历史段落自行推定下一项。T2/T3 在 A3 完成后作为一个交付组执行，其他交付组同样只以计划明确列出的范围为准。

全局上下文、父子澄清、任务发现和 supervisor 的协议见 [深入架构](../exploration-evolution-architecture.md) §10，角色文本见 [Prompt 合同](../agent-prompt-contracts.md)。S1 验证/能力合同与 A3 生命周期已交付；审核（T2/T3）完整交付后建 A0；评估 S4-E 先于自动主管/候选执行。不得先写 ask_parent 再忽略父工具同步等待，也不能只换 prompt 宣称机制已实现。每次仅派发计划指定的一票或一个交付组，不另建提前运行版。

每次将对应 prompt 文档路径交给执行 agent，要求阅读全文并执行。各项依次集成，不在同一工作区并行修改共享模块和 guide。

每份 prompt 都要求先读取本文件的公共合同。用户派发其中一项仅授权计划指定的该项/交付组及其必要测试、文档同步，不自动授权其他任务。文件名与 P/T 编号保持稳定；具体提交与测试数量由执行者记录实测值。

## 公共执行合同

你是此任务的实现 agent。按指定 prompt 实现和验证，不仅输出方案。已固定的行为规则不再自行改题；允许查阅本仓库源码和依赖 API 来落实规则，无需做外部方案研究。

### 工作区和必读文件

- 外层仓库：`/home/ROXY/code/bb_work/harness`。
- Singularity 子模块：`/home/ROXY/code/bb_work/harness/packages/singularity`。
- 最高优先级当前 guide：`/home/ROXY/code/bb_work/harness/packages/singularity/docs/singularity-harness-guide.md`。
- 当前计划：`/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-09-20-vrtc-code-change-plan.md`。
- 术语：`/home/ROXY/code/bb_work/harness/packages/singularity/CONTEXT.md`。
- 持久化规则：`/home/ROXY/code/bb_work/harness/packages/singularity/docs/persistence-changes/README.md`。
- 本目录指定给你的单项 prompt。

方向固定：Task 提出目标与能力需求，节点可按规范直接构造任务，无须命中模板；Run 绑定执行实现。生成实例可选契约人审，机器准入始终保留；supervisor 负责实现、验证共享改进，人类审核改进及其证据。不能把普通能力缺口改成要求人类编写 Skill，也不能把底层修复宣称为 supervisor/自动恢复已完成。

### 修改纪律

1. 读取适用的 AGENTS.md，检查两个仓库的状态和当前提交。确认前置任务已落地；若没有，报告缺少的前置条件，不自行实现其他任务。
2. 修改前建立 Git 基线备份：记录当前 HEAD；有相关未提交修改时先检查、提交保存，再在外层只提交对应子模块指针。不要混入其他子模块、临时文件或不相关修改，不要重置用户工作。
3. 优先修改现有模块与 API；不加通用版本平台、调度器、策略框架。禁止为了测试通过删验收、降低检查或将错误默认为成功。
4. 新行为先用可确定性失败的反例测试固定，再实现。测试必须检查外部结果、持久化状态和关键副作用；不能只断言私有 helper 被调用。
5. 全部运行在临时 fixture 中。不要修改真实生产 Skill/config、重启服务、调用真实模型或运行 BB 仿真。
6. 旧 ledger 读取、已应用对象回滚是明确保留的合同。涉及持久化字段时记录兼容性；外部 Evolution ledger 不伪装成 SessionEventMap 根，也不能只凭事件指纹没变就宣布兼容。

### 必跑检查

先在 Singularity 目录完成 `pnpm build`，再运行以下测试，禁止与清理 lib 的构建并行：

```sh
# 工作目录：/home/ROXY/code/bb_work/harness
pnpm vitest run --project unit packages/singularity
pnpm vitest run --project integration packages/singularity
```

```sh
# 工作目录：/home/ROXY/code/bb_work/harness/packages/singularity
pnpm run verify-persistence
git diff --check
```

在 `agent-singularity` 目录运行 `pnpm exec tsc --noEmit`。P1 已消除该包已知基线错误，后续各票不得重新引入。保留仓库已跟踪的必要 lib 构建输出，避免无关产物变更。

### 进入下一项前的完成闸

每票/交付组必须留下接口交接记录：实际支持范围、状态与权限规则、正常和拒绝路径、取消/恢复/旧数据行为、源码/测试锚及未支持扩展。已承诺能力不能用 TODO、stub、人工补台账或“下票接线”满足验收；无支持入口必须显式拒绝且无副作用。前置有缺陷时先修复并重验，再推进依赖票，不把缺陷改名成后续增强。

测试必须跨真实模块接口覆盖本票全部路径；scripted provider 只替代模型输出，不能替代本票正在交付的 runtime、store、verifier 或 DSH 接线。故障注入使用临时 fixture；通过场景测试不代表可提前部署新图版本，也不替代其他验收项。

普通执行、replay 和恢复共用状态规则；涉及它们的改动必须检查三者一致性。真实模型实验与确定性构建测试分开记录；本公共合同不自动授权真实模型费用或生产操作。未做效果实验可以如实交付已通过的机制，但不得声称已提高成功率。依赖效果结论的晋升必须有相应证据。

### 构建与复核质量 Prompt

执行本目录任一任务时，将以下要求作为验收的一部分；无需另建质量路线或质量平台：

```text
先固定本票基线与验收合同，列出“要求 → 实际入口/消费者 → 测试”的对应关系。
对新增规则逐一检查普通执行、replay、恢复、直接服务调用及可替换插件路径；
不适用的入口写明原因，不能仅因共享了某个 helper 就宣称行为一致。

至少选择与本票相关的规则组合构造反例，例如映射 × 自定义 verifier、
父证据 × 子 heuristic、输入依赖 × replay。有拒绝反例，也要有合法正例，
证明修复没有通过全部拒绝、绕过原 verifier 或扩大权限来获得测试通过。
拒绝路径检查无意外派发/写入/成功状态；关键结论从实际 store/evidence 读回。

修复测试先在未修复代码上复现预期失败，记录失败原因；测试必须穿过
实际接线。仅在风险需要时补有针对性的变异测试，不以重复全量测试代替新反例。
复核时从公开入口追踪到状态写入，重点寻找声明了但未消费的字段和替换路径。

已知边界必须对照原合同：承诺行为未实现就是缺陷，不能改称范围外、
补一条说明或将失败固化为测试后宣布完成。新发现的本票缺陷应修复并回归；
超出授权范围的修复明确上报，保持未完成，不能自行降低验收。
报告实跑命令、断言范围、模拟部分与未覆盖项；测试数量和全绿不是完整性证明。
独立审查须是实际执行过的审查；子代理失败不能记作已通过。
```

这些要求提高可审查性，不保证模型或实现必然正确。验收核心的交付应经过独立复核；未复核时明确记录，不能由实现者自述替代证据。

### Guide 同步是完成条件

每项任务都必须修改以下两个文件，不能只追加执行日志或只改本 prompt：

1. `docs/singularity-harness-guide.md`：更新 §4.1 当前事实、相关 G 缺口与 §5 约束/样本。写明本次实现范围、源码/测试锚和仍未完成部分；过期的当前态描述必须修正。不要把单文件 Skill 保障泛化到所有候选或所有并发模型。
2. `docs/2026-09-20-vrtc-code-change-plan.md`：更新对应 P/T/A/S 任务或交付组状态，记录备份提交、实际验证命令/结果/测试数量、接口交接，以及唯一顺序中下一项的前置条件。历史验证记录保持原样，新结果单列；同步深入指导与 Prompt 合同对应状态，不将其他待建票标为完成，不在文末另写竞争排期。

变更持久化合同还需写对应记录。历史快照不修改，原始构想文件不修改。未达到全部验收项时保留“未完成/部分”，明确失败项；不能用“核心完成”掩盖剩余合同。

### 最终交付

提供代码与 guide 修改，按指定验收编号列出对应测试位置和结果，报告实际执行命令、未覆盖范围、基线提交和当前 Git 状态。只有全部验收通过且两个 guide 同步，才声明该任务完成。不推送、不部署。
