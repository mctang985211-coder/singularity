# Singularity 确定性构建任务

日期：2026-09-21。以下为待执行 prompt，不是完成记录。
准备文档前备份：Singularity `6fe9c26`，外层 harness `1afb656`。

## 派发顺序

1. [P1：严格类型检查](01-root-agent-typecheck.md)
2. [P2：单文件 Skill 内容绑定](02-skill-content-binding.md)，基于 P1 验收后的代码执行。
3. [P3：过期 Skill 候选拒绝](03-skill-champion-check.md)，基于 P2 验收后的代码执行。
4. [P4：独立父验收与证据身份](04-parent-acceptance-evidence-identity.md)，基于 P3 验收后的代码执行；S1-V 切片 2（verifier selftest 执行）不在本票。

每次将对应 prompt 文档路径交给执行 agent，要求阅读全文并执行。三项依次集成，不在同一工作区并行修改 Evolution 和 guide。

每份 prompt 都要求先读取本文件的公共合同。用户派发其中一项仅授权该项及其必要测试、文档同步，不自动授权其他任务。文件名和 P 编号保持稳定；具体提交与测试数量由执行者记录实测值。

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

方向固定：Task 提出目标与能力需求，Run 绑定执行实现；supervisor 负责实现、验证改进，人类审核改进及其证据。不能把普通能力缺口改成要求人类编写 Skill，也不能把本次底层修复宣称为 supervisor/自动恢复已完成。

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

在 `agent-singularity` 目录运行 `pnpm exec tsc --noEmit`。P1 必须消除已知基线错误；P2/P3 不得重新引入。保留仓库已跟踪的必要 lib 构建输出，避免无关产物变更。

### Guide 同步是完成条件

每项任务都必须修改以下两个文件，不能只追加执行日志或只改本 prompt：

1. `docs/singularity-harness-guide.md`：更新 §4.1 当前事实、相关 G 缺口与 §5 约束/样本。写明本次实现范围、源码/测试锚和仍未完成部分；过期的当前态描述必须修正。不要把单文件 Skill 保障泛化到所有候选或所有并发模型。
2. `docs/2026-09-20-vrtc-code-change-plan.md`：更新对应 P 任务状态及 S1-C/S4 的局部进度，记录备份提交、实际验证命令/结果/测试数量，以及下一项的前置条件。历史验证记录保持原样，新结果单列。

变更持久化合同还需写对应记录。历史快照不修改，原始构想文件不修改。未达到全部验收项时保留“未完成/部分”，明确失败项；不能用“核心完成”掩盖剩余合同。

### 最终交付

提供代码与 guide 修改，按指定验收编号列出对应测试位置和结果，报告实际执行命令、未覆盖范围、基线提交和当前 Git 状态。只有全部验收通过且两个 guide 同步，才声明该 P 任务完成。不推送、不部署。
