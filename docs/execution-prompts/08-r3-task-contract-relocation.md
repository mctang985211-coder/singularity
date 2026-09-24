# 第 8a 项 R3：已有 Task 合同归位

这是当前唯一可派发的实现票。R1 已于 2026-09-24 验收；本票完成后才可进入第 9 项 A2+A1。

## 可直接派发的 prompt

```text
你是 Singularity 第 8a 项 R3 的实现主代理。只执行“已有 Task 合同归位”，完成后停在进度审核，不派发 A2+A1。

工作区：
- /home/ROXY/code/bb_work/harness/packages/singularity
- 外层仓库：/home/ROXY/code/bb_work/harness

先读：
1. docs/singularity-harness-guide.md（当前状态、§1.5）
2. docs/2026-09-20-vrtc-code-change-plan.md（唯一执行表、E 节 R3 合同）
3. docs/execution-prompts/README.md（公共执行合同）
4. docs/execution-prompts/task-dispatch-template.md

前置事实：第 8 项 R1 已验收，Singularity 7f3d0ee、外层 7e0652e4f8；证据目录
r1-rework-2026-09-24、r1-final-2026-09-24、r1-final2-2026-09-24、
r1-final3-2026-09-24 只读。R1 完成轮 3 的 pass 证明固定场景可运行，不能把它扩展成
通用语义保证。完成轮 3 的历史 fixture 仍有 `cacheWriteTokens: 0` 记录器 caveat，
不要修改或重跑这些历史证据，也不要把 R1 账目修补混入 R3。

目标（只做以下三个职责迁移）：
1. Skill 合同：将 task/src/skill-contract.ts 中由运行时消费的侧车形状、路径和 digest
   规则迁入 task-runtime 的 provider/sidecar 内部模块；TaskRun 继续保存所使用的内容身份。
2. Verifier 合同：将 Verifier、VerifierSelftest、VerifyRequest 及其执行接口归入
   verifier；更新插件、自测、command/review/composite 和真实调用方。Evidence、
   VerificationResult 及持久事实仍由 task 持有，task 不得反向依赖 verifier。
3. 测试专用类型：将仅测试使用的 RootTaskSpec、TaskDefinition 工厂或等价便利类型
   移到已有 tests/support/legacy-root.ts（或同一测试支持层）；生产代码不能继续导入
   测试专用 root 类型。

必须保持不变：
- Skill 格式、frontmatter、内容 digest 算法和侧车语义；
- Task/Run/Evidence/Review 持久化形状、事件根、原子提交顺序和旧 JSONL 读取；
- provider 预检、运行绑定、晋升拒绝、旧 Run binding 读取和 replay/恢复行为；
- Verifier 的注册、自测闸、版本记录、受保护输入和实际判决结果。

范围外（触及即停止并报告）：
- 不重写整个 task/src/types.ts，不把所有 400 行以上文件机械拆分；
- 不迁移 Task/Run/Proposal/Review/Diagnosis 的持久事实；
- 不创建 shared-types、repository、effect、通用 provider framework 或第二套 digest；
- 不实现 A2/context、A4、S4-E、A5、A6，不改变业务语义、权限、审核策略或 Skill 格式；
- 不保留 task 的错误旧导出、永久 re-export 或同名转发层来掩盖双重事实源。

执行纪律：
- 先检查 AGENTS.md、两个仓库状态和实际 HEAD；修改前建立 Git checkpoint。
- 主代理负责整票集成、调用方替换、公共构建、全量相关测试、独立复核和两个 guide。
- 若委派子代理，一人一次只做一个可独立验收目标：Skill 迁移、Verifier 迁移、
  测试类型迁移三者按依赖顺序交接；不要把整票转派给一个子代理。
- 子代理不得修改共享 guide，不得回退其他人的改动；上下文不足先交接基线、证据、
  当前改动和唯一剩余目标，再续跑。
- 先用真实生产入口写出迁移前失败/缺失反例，再实现；拒绝路径检查零意外写入、
  零派发和零审核副作用。不要通过删断言、放宽导入或改测试期待来过验收。

验收合同：
- R3-1：同一 SKILL.md/sidecar 在迁移前后产生完全相同的内容身份；旧 Run binding
  可读；真实 provider precheck、绑定和晋升拒绝正反例通过；无第二套 digest。
- R3-2：verifier 插件、自测入口和 command/review/composite 使用 verifier 新类型；
  task 无 verifier 反向依赖；Evidence/VerificationResult 仍由 task 持有；注册闸、
  版本覆盖、受保护输入和自测失败的拒绝副作用不变。
- R3-3：测试 root factory 从真实 store/runtime 接口构造；生产代码无测试专用类型、
  task 错误旧导出和跨职责导入；历史 JSONL 可读；原子提交反例、提案恢复、普通执行、
  replay、直接服务调用和插件替换路径回归通过。

必跑检查（按依赖顺序，不与清理 lib 的 build 并行）：
1. 在 packages/singularity 执行 `pnpm build`。
2. 在外层执行 `pnpm vitest run --project unit packages/singularity`。
3. 在外层执行 `pnpm vitest run --project integration packages/singularity`。
4. 在 packages/singularity 执行 `pnpm run verify-persistence` 和 `git diff --check`。
5. 在 agent-singularity 执行 `pnpm exec tsc --noEmit`。
记录实跑命令、结果、测试数量、未覆盖项和基线/交付提交；无模型调用、无部署、无推送。

文档与停止条件：
- 更新 docs/singularity-harness-guide.md：§1.5 当前事实、R3 的源码/测试锚、迁出位置、
  保留边界和未完成项；不要把 R3 写成 A2 前置功能。
- 更新 docs/2026-09-20-vrtc-code-change-plan.md：第 8a 行和 E 节 R3 记录，填写基线、
  交付版本、R3-1–R3-3 对应证据、实际检查、独立复核、未解决缺陷和下一项前置。
- 更新 docs/execution-prompts/README.md（如状态有变化），保留历史 R1 记录与失败轨迹。
- 只有 R3-1–R3-3 全部通过并完成独立复核，才填“交付待进度审核”；有任何合同缺口就
  保留返工，不派 A2+A1。完成后停下，等待 progress-review-and-dispatch.md。
```

### 主代理的最小交接顺序

1. Skill 合同迁移与 runtime 消费者替换；先交接新类型路径和 digest 回归。
2. Verifier 执行接口迁移与所有插件/自测消费者替换；确认 task 不反向依赖。
3. 测试专用 root 类型迁移；从真实 store/runtime 入口重建夹具。
4. 主代理做整票组合回归、独立复核与 guide 同步。

这四步是 R3 内部顺序，不是可分别宣布完成的票；任何一步失败都停在 R3。
