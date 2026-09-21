# VRTC-KISS 建设计划

更新：2026-09-21。保留原文件名作为稳定入口；原临时计划在 [历史快照](history/2026-09-21-vrtc-plan-snapshot.md)。
方向与实现事实以 [工作指南](singularity-harness-guide.md)为准；本文仅描述建设顺序、代码落点与可验收结果。
基线备份：Singularity `b00915c`，外层 harness `6c5eb49894`。

## 当前排期

先期确定性任务的派发入口：[执行 prompt 与公共合同](execution-prompts/README.md)。按 P1 → P2 → P3 顺序执行；每项完成必须同步本计划及主 guide，不能只更新测试或执行日志。

| 任务 | 当前状态 | 前置 | 完成边界 |
|---|---|---|---|
| [P1 类型闸](execution-prompts/01-root-agent-typecheck.md) | 已完成（2026-09-21，见 P1 节） | 已满足 | root-agent 严格类型检查零错误，build 实际执行类型检查 |
| [P2 Skill 内容绑定](execution-prompts/02-skill-content-binding.md) | 已完成（2026-09-21，见 P2 节） | P1 验收通过：`agent-singularity` build 为 `tsc --noEmit && tsdown`，类型错误即失败 | 单文件 Skill prepare/replay/审核/apply 内容身份一致；旧记录读取与回滚保留 |
| [P3 生产基线检查](execution-prompts/03-skill-champion-check.md) | 已完成（2026-09-21，见 P3 节） | P2 验收通过：候选内容身份字段、兼容规则与读取/检查入口见 P2 节交接，P3 必须复用该身份语义，不另建摘要体系 | 串行 apply 拒绝过期 Skill 候选，不覆盖变化的生产文件 |
| [P4 独立父验收与证据身份](execution-prompts/04-parent-acceptance-evidence-identity.md) | 已完成（2026-09-21，见 P4 节） | P3 验收通过：串行 apply 已能拒绝过期候选；P4 只动 task/verifier/task-runtime 与 task_decompose 声明面，不改 Evolution 链路 | 父 AC `childEvidence` 映射不完整即拒绝；`requiresArtifact` 只认 verified 参考产物；独立父级组合检查可机械执行 |

这些是 S1-C/S4 的有限工程切片。P2 不证明证据来源真实，P3 不承诺跨进程原子更新；完成后不将整张 S 票标为完成。

| 票据 | 状态（2026-09-21） | 依赖 | 交付范围 |
|---|---|---|---|
| S0 | 已完成，验证结果见文末 | 无 | 文档去漂移、术语统一、worker 能力查询 |
| S1-V | 部分：verifier 返回边界校验已建；父级证据映射、独立父级组合检查与证据身份收紧已落地（P4，切片 1+3）；verifier selftest 执行与输入身份（切片 2）待建 | S0 | 可信验收、父级组合检查、有效产物引用 |
| S1-C | 部分：多 preset 冲突已在解析期拒绝；单文件 Skill 候选的晋升链路内容身份已绑定（P2），生产基线已在 apply 前复检（P3） | S0 | provider 预检、skill 分类契约、run 解析快照 |
| S2-E | 部分：已有手动 L4 工具与 raised 台账 | S0 | 自动缺口记录、supervisor 交接、人审改进与例外上报、结构化拒绝 |
| S2-R | 待建；已有 blocked/obligation 记录 | S1 最小切片、S2-E；与 S3 联合验收 | agent 补齐缺口后的系统恢复、预算与判决处置 |
| S3 | 待建 | S1 最小切片、S2 交接/恢复协议；与 S2-R 联合验收 | L1 复用/组合与 L2 沙箱生成，验证后提交人审改进 |
| S4 | 部分：报告自洽、摘要与机械晋升最低闸已建；单文件 Skill 候选内容绑定（P2）与生产基线检查（P3）已完成 | S3；验证底座可提前 | 结构化 Retro、分层指标、自动接受硬闸 |

旧计划的阶段 1.1/1.2（assumptions/requiresArtifact）、1.4（verifierRef）、3.3（义务记录）已有代码；不重复建设。
阶段 1.3 预算、2.1 四值判决、2.2 verifier selftest 只有部分完成。阶段 3.1 L4 已有工具，但无自动与恢复闭环。
侧车契约从旧阶段 5 前移到 S1-C，避免先生成技能再补“什么算有效技能”的规则。

**实施粒度与人审职责修正（2026-09-21）**：这些票是责任分组，不要求完整平台齐备后才建自主闭环。先选一个小型任务，以 S1 的最小验证/能力契约、S2 的缺口交接/恢复和 S3 的自主补路径共同交付。Supervisor 诊断、实现候选并组织验证，人类只审核改进与证据，批准后系统应用并恢复。“人工补能力后恢复”不作为阶段完成条件；fixtures 只能用于底层测试。依据：细化想法4 §33、KISS §7/§12 第 3 步。完整侧车平台可以后置，实际候选的最小契约和验证不可省。

## P1：root-agent 严格类型闸（2026-09-21 已完成）

修改前回退点：Singularity `6fe9c26`（外层 harness `1afb6567`）。基线备份提交：Singularity `c3cf7b3`（提交 prompt 派发文档），外层 harness `1497abcf5`（仅提交对应子模块指针）。

实现范围（只改类型来源与 build 配置，未改业务流程、审批次数、持久化格式或工具输入输出合同）：

- **SessionId 来源**：`agent-singularity/src/tools/` 下 10 个本地 `sessionId(exec)` helper 原先把上游 `Agent.id`（已是 `SessionId`）声明成 `string` 再传给要求 `SessionId` 的服务。改为直接返回上游身份类型 `SessionId`（`@deepseek-ai/dsh-session`），不再抹掉品牌后硬转。身份缺失/为空的拒绝保持不变。落点：`task-read.ts`、`task-status.ts`、`task-verify.ts`、`task-review-pack.ts`、`evolution-gate.ts`、`evolution-prepare.ts`（含 `definitionChampion` 的 `caller`）、`evolution-propose.ts`、`evolution-replay.ts`、`review-agent.ts`、`task-diagnose.ts`。
- **proposal targetType**：`task-diagnose.ts` 的本地 `TARGET_TYPES` 改为标注为 `@dangosys/dsh-singularity-task` 的 `ProposalTargetType`，并新增 `toProposals` 运行时校验（数组、对象、枚举成员、字符串字段），不再把模型字符串断言成合法 targetType；`evolution-propose.ts` 中原有的 `targetType as ProposalTargetType` 断言同样换成真实校验 `isProposalTargetType`。工具 schema 的 `enum` 拒绝在参数边界已经存在，本次补的是 handler 侧的类型正确性。
- **mutation 收窄**：`evolution.ts` 的 `validateMutation` 增加 `asserts mutation is Record<string, unknown>`，把已有的运行时拒绝（`mutation must be an object`）正确表达给 TypeScript；非法输入仍然抛错，行为不变。
- **build 类型闸**：`agent-singularity/package.json` 的 `build` 从 `tsdown` 改为 `tsc --noEmit && tsdown`（沿用 `map` 包的既有写法）。工作区根 `pnpm build` 是 `pnpm -r run build`，因此同样经过该检查。

测试锚：`agent-singularity/tests/unit/task-tools.spec.ts`（task_diagnose 非法 targetType、非数组 proposals、五个工具缺失身份拒绝）、`agent-singularity/tests/unit/evolution.spec.ts`（evolution_propose 非法 targetType、三个 evolution 工具缺失身份拒绝）。既有 mutation 反例测试（`evolution.spec.ts` 的 mutation schemas 组）未改动。

验证（2026-09-21，实际执行）：

1. `packages/singularity` 下 `pnpm build`：通过；日志可见 `agent-singularity build$ tsc --noEmit && tsdown`。
2. 外层 harness 下 `pnpm vitest run --project unit packages/singularity`：25 文件 / 579 项通过（新增 9 项边界测试）。
3. 外层 harness 下 `pnpm vitest run --project integration packages/singularity`：19 文件 / 94 项通过。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`。
5. `packages/singularity` 下 `git diff --check`：通过。
6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误（基线为 12 处）。
7. P1-C 探针：在 `src/evolution.ts` 末尾临时加入 `const typecheckProbe: number = 'invalid'`，`pnpm build` 以退出码 2 失败并报告 `src/evolution.ts(1424,7): error TS2322`；移除后 build 再次成功，探针不在最终 diff 中。

给 P2 的前置条件：构建命令未变（仍从 Singularity 目录 `pnpm build`），但 `agent-singularity` 现在有类型闸；P2 改动该包 src 后必须先过 `tsc --noEmit` 才能打包。测试基线为单测 25 文件 / 579 项、集成 19 文件 / 94 项；P2 新增/修改测试后按同一命令重跑并记录实际数量。S1-C/S4 的局部进度：P1 只修类型来源与 build 闸，不推进候选内容绑定或证据来源校验，这两项仍属 S1-C/S4 待建（G7）。

## P2：单文件 Skill 候选内容绑定（2026-09-21 已完成）

修改前回退点：Singularity `97f3118`（外层 harness `531d85e132`）。基线工作区干净（外层仅 `thirdparty/deepseek-harness` 子模块内有未跟踪文件，未触碰）。

实现范围（只绑定 `targetType: skill` 的单个 `SKILL.md`，未扩展到多文件 Skill、preset、capability、通用内容仓库，也未实现真实证据来源认证、独立 verifier 或 supervisor 调度）：

- **prepare 记录身份**：`evolution.ts` 的 `prepare` 在物化后读回实际写入的 `sandbox/<id>/skills/<name>/SKILL.md`，按精确文件字节（Buffer，无 trim、无换行转换）计算 SHA-256，与 skill 名称一起写入 `prepared` 记录的新可选字段 `skillContent: { name, sha256 }`；重启后 fold 原样恢复。其他 targetType 不携带该字段，fold 对误植字段显式拒绝。
- **报告身份与服务入口检查**：`replay.ts` 的 `ReplayReport` 新增可选 `candidateContent`，`assertReplayReport` 要求 skill 报告必须携带合法形状的身份（其余 targetType 不强制）；`evolution.ts` 的 `replay()` 服务入口校验报告身份与 prepare 记录一致，并在写入 `replayed` 记录前重新读取候选文件复检摘要——执行期间发生并持续存在的修改被拒绝，不留下有效 replayed 状态。
- **工具层前置检查与 overlay**：`tools/evolution-replay.ts` 在执行任何 replay 前调用 `ctx.evolution.readSkillCandidate` 复检候选（普通文件、无符号链接路径、摘要一致）；skill 的 overlay 仍指向沙箱 `skills/` 目录（被检查的同一候选），报告携带 prepare 记录的身份。禁止验证生产 skill 却记录候选摘要。
- **晋升闸复检**：`checkPromotion`（人审前预检、decide(PROMOTE) 服务入口、apply 服务入口共用）对 skill 候选复检内容身份；审批等待期间候选变化由服务入口复检拒绝。
- **apply 读写一致**：`writeProduction` 的 skill apply 分支读取候选字节、校验摘要后写入这同一份已校验字节，不检查路径后重新读路径；回滚仍恢复 champion 快照（按字节读写）。
- **路径与文件类型限制**：新增 `readVerifiedFile`：从 ledger root 逐级 `lstat`，候选路径或其祖先为符号链接、候选不是普通文件（含被换成目录）、文件缺失均明确拒绝；沿用既有 `resolveWithin` 沙箱限制，只使用 Node 标准 fs API。
- **兼容与旧 ledger**：无 `skillContent` 的旧 ledger 可读；旧已应用对象可回滚；旧未应用 Skill 候选在 replay/晋升入口被拒绝，错误提示要求新建候选并重新评估，不静默重算摘要修补旧记录。
- **可观测性**：`evolution_list` 的 prepared 行显示 skill 候选内容身份（短摘要）。

持久化记录：`docs/persistence-changes/2026-09-21-evolution-skill-content.md`（外部 `proposals.jsonl` 新增可选字段，非 SessionEventMap 根，四个事件根指纹不变）。

测试锚：`agent-singularity/tests/unit/evolution.spec.ts` 的 `skill candidate content binding (P2)` 组（P2-A 正向全链路与真实 `evolution_replay` 工具路径 overlay/身份核对、其他 targetType 不携带 skill 字段；P2-B 四个改动时点；P2-C 缺失/目录/文件与祖先符号链接；P2-D 受控 readFile hook 在 apply 完成候选读取后替换源文件；P2-E 缺失/伪造身份的服务入口拒绝；P2-F 重启复检、旧 ledger 读取/回滚/不可晋升、伪造字段 fold 失败；P2-G 人审前预检与审批等待期复检），`tests/integration/evolution-tools.spec.ts`（插件路径下的身份记录、overlay、逐字节生产写入与候选篡改拒绝）。

验证（2026-09-21，实际执行）：

1. `packages/singularity` 下 `pnpm build`：通过；日志可见 `agent-singularity build$ tsc --noEmit && tsdown`。
2. 外层 harness 下 `pnpm vitest run --project unit packages/singularity`：25 文件 / 595 项通过（P2 新增 16 项；`evolution.spec.ts` 由 177 项增至 193 项）。
3. 外层 harness 下 `pnpm vitest run --project integration packages/singularity`：19 文件 / 95 项通过（新增 1 项插件路径候选篡改拒绝）。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`。
5. `packages/singularity` 下 `git diff --check`：通过。
6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误。
7. P2-D 反例探针：临时把 skill apply 改成“校验后重新读路径写入”，P2-D 测试失败（生产收到替换内容）；恢复实现后通过，探针不在最终 diff 中。

给 P3 的前置条件：P2 的身份语义可直接复用——字段 `prepared.skillContent: { name, sha256 }`（可选，仅 skill）、报告字段 `candidateContent`；内容读取/检查入口是 `EvolutionService.readSkillCandidate(proposalId)` 与 `checkPromotion(proposalId)`（内部 `readVerifiedSkillCandidate` / `readVerifiedFile`，从 ledger root 逐级 lstat 拒绝符号链接与非普通文件）。P3 必须复用这套摘要与读取路径，不另建第二套摘要体系；P3 在此基础上补生产基线（champion 与当前生产内容）比对。S1-C/S4 仍为部分完成：P2 只绑定单文件 Skill 候选内容，不证明证据来源真实，也未建分层指标或自动 Retro。

## P3：拒绝覆盖已变化的生产 Skill（2026-09-21 已完成）

修改前回退点：Singularity `4c5308b`（外层 harness `a7df0ce6fd`）。基线工作区干净（外层仅 `thirdparty/deepseek-harness` 子模块内有未跟踪文件，未触碰）。

实现范围（只对 `targetType: skill` 的单个 `SKILL.md` 固定生产基线；未扩展到多文件 Skill、preset、capability，未建全局版本服务，未实现跨进程锁或并发 compare-and-swap，未改 rollback 覆盖策略）：

- **prepare 单次读取**：`evolution.ts` 的 skill `materialize` 分支改为对生产文件做一次校验读取（沿用 P2 的逐级 lstat 语义，从 `skillRoot` 逐级拒绝符号链接与非普通条目），同一份字节既写 champion 快照，也算出 SHA-256 写入 `prepared` 记录的新可选字段 `skillBaseline: { name, sha256 }`；快照与摘要不可能描述两次不同读取。生产文件不存在仍记 `champion: 'missing'` 且不写摘要。`readVerifiedFile` 拆出 `walkVerified`（缺失与类型改变分开上报），`readProductionSkill` 复用它读生产目标。
- **apply 两次复检**：新增 `EvolutionService.checkProductionBaseline(proposalId)`（内部 `assertProductionBaseline`）：`captured` 要求生产目标是普通文件且摘要与 `skillBaseline` 一致，`missing` 要求目标仍不存在；文件缺失、内容不同、类型改变（变成目录）、文件或祖先为符号链接都是冲突。`evolution_apply` 工具在人审前调用它，`EvolutionService.apply` 在 `checkPromotion` 之后、实际写入之前再调用一次，直接调用服务同样经过；`decide(PROMOTE)` 的入口保持 P2 行为不变。
- **冲突处理**：只抛错。不改生产文件、不追加 `applied`、不自动覆盖/merge/更新 champion/改写原 proposal；错误提示统一要求“基于新生产状态创建新候选并重新评估”。原候选、replay 报告与 history 全部保留，P2 候选身份检查与既有 replay 闸不受影响。
- **可观测性**：`evolution_prepare` 输出生产基线短摘要；`evolution_list` 的 prepared 行同时显示候选内容身份与生产基线身份。
- **兼容与旧 ledger**：无 `skillBaseline` 的旧 ledger 可读、旧已应用对象可回滚；`captured` 但没有基线摘要的旧未应用候选拒绝新 apply（不默认匹配），`champion: 'missing'` 的旧候选仅在目标仍不存在时可应用。fold 对误植到非 skill 的 `skillBaseline` 和畸形摘要显式拒绝。

持久化记录：`docs/persistence-changes/2026-09-21-evolution-skill-baseline.md`（外部 `proposals.jsonl` 新增可选字段，非 SessionEventMap 根，四个事件根指纹不变）。

测试锚：`agent-singularity/tests/unit/evolution.spec.ts` 的 `production baseline check (P3)` 组（P3-A 未变基线全链路；P3-B 修改/删除后用 it.each 覆盖工具预检与直接服务调用；P3-C missing 后出现文件被拒、仍缺失可应用；P3-D 目录/文件符号链接/祖先符号链接三类拒绝且链接目标不被写；P3-E 两个同 champion 候选串行 apply，第二个被拒且只烧一次审批；P3-F 人审前基线已变不弹审批、审批等待期用可控 promise 改基线后批准仍被复检拒绝；P3-G 重启复检、P2 内容变化负例、rollback 覆盖语义不变、无基线字段的旧 ledger 拒绝/可按 missing 应用、伪造字段 fold 失败），`tests/integration/evolution-tools.spec.ts`（插件路径下生产基线记录、拒绝时不弹审批、ledger 无 applied）。

验证（2026-09-21，实际执行）：

1. `packages/singularity` 下 `pnpm build`：通过；日志可见 `agent-singularity build$ tsc --noEmit && tsdown`。
2. 外层 harness 下 `pnpm vitest run --project unit packages/singularity`：25 文件 / 609 项通过（P3 新增 14 项；`evolution.spec.ts` 由 193 项增至 207 项）。
3. 外层 harness 下 `pnpm vitest run --project integration packages/singularity`：19 文件 / 96 项通过（新增 1 项插件路径生产基线拒绝）。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`。
5. `packages/singularity` 下 `git diff --check`：通过。
6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误。
7. P3 反例探针：临时让 `assertProductionBaseline` 直接返回，单测 10 项 P3 冲突用例失败（P3-B×2、P3-C、P3-D、P3-E、P3-F×2、P3-G 重启、P3-G 旧 ledger×2），恢复实现后全部通过；探针不在最终 diff 中。

给下一批的前置条件：P3 只固定“串行调用之间生产基线没变”，不实现跨进程锁、并发 CAS 或任意外部写入者与 apply 同时写的原子性；rollback 覆盖策略保持原状。S1-C/S4 仍为部分完成：真实 run/evidence 来源绑定、preset 沙箱执行、分层指标与自动 Retro 均未建，不因 P1–P3 通过而宣称完整自进化框架已完成。

下一批仍待固定的合同（本票未开始实现）：

1. **真实 run/evidence 来源绑定**（S1-C / S4）：replay 固定 manifest/run/evidence 身份，报告自洽但来源伪造仍是反例；apply 写入同一版本。
2. **preset 沙箱执行**（S1-C / S3）：补 agent_preset 沙箱解析/执行器，解除 manual replay 的当前阻塞，而不是绕过验证。
3. **独立父验收**（S1-V）：父 AC → 子证据映射、独立组合判据、区分原始输入与要求已验证的产物。P4 已完成其最小机械版（见 P4 节）：映射存在性与 verified 来源、独立组合检查（映射断言 + 父级 command）、`acceptsArtifact`/`requiresArtifact` 分离；剩余 C3 假设满足性完整证明、verifier selftest 正负样本执行（切片 2）、验收输入来源固定。
4. **supervisor/blocked 恢复**（S2-E / S2-R / S3）：gap 身份与解决事件、supervisor 自主实现并验证候选、人审后系统恢复受阻分支。

## P4：独立父验收与证据身份（2026-09-21 已完成）

修改前回退点：Singularity `05cb27c`（外层 harness `c198457d56`）。基线工作区干净；基线备份提交：Singularity `53b9831`（提交 P4 执行 prompt 派发入口），外层 harness `4bd9c42`（仅提交对应子模块指针）。

实现范围（只做 KISS §6 C2/C4 的最小机械版与 §5.1 的证据身份区分；未做通用自然语言蕴含求解器、C3 完整证明、verifier 四值语义、preset/MCP/skill 预检、verifier selftest 执行）：

- **父 AC 证据映射（C2）**：`AcceptanceCriterion` 新增可选 `childEvidence?: ChildEvidenceRef[]`——`{ childIndex, criterionId?, evidenceRef? }`，子任务按分解 batch 位置（0 基，与 `dependsOn` 同一索引词汇，这是父 AC 作者在子任务 id 产生前唯一稳定的子任务身份）指向，可窄化到子判据与证据引用（evidence id / artifact kind / artifact id 三种拼写）。composite 在父验收期对照 store 校验：子任务存在且 verified、指名判据在其 verified run 的 evidence 中有 pass 判决、指名引用在该 evidence 中存在；任一条不满足即 fail 并逐字点名缺失项。无映射（或空映射）保持现行“子全 verified”合取，旧任务零行为变化。
- **独立父级组合检查（C4）**：两条可机械执行的形式——映射断言本身，以及父 AC 的确定性 `command`（真实 CommandVerifier 执行，接口/数值级判据）。子全 verified 但组合接口错误时父拒绝。`heuristic?: boolean` 标记的父 AC 为自然语言条款：composite 的合取 verdict 带显式 heuristic 标注，`unmetMandatory` 永不把 heuristic 判据算作确定性通过。
- **证据身份（切片 3）**：`requiresArtifact` 收紧为“已验证参考产物”——产出 run 终态 verified 且 bundle 带 pass 判据，失败/在跑 run 的同名产物不再满足；新增 `acceptsArtifact?: string[]` 表达原始输入（存在即可，任意 run 状态），即 P4 前 `requiresArtifact` 的语义。spawn 期 blocked reason 与 Obligation 文本区分两种声明。产物已在且验证通过的合法跳过保持不变。
- **契约级标记与 admission**：`TaskInstance.requiresIndependentAcceptance?: boolean`（经 `DecomposeChildSpec.requiresIndependentAcceptance` 声明）要求至少一条 AC 带非空映射，否则新建/分解路径 admission 响亮拒绝，不静默降级为合取；`admission.ts` 新增共享纯函数 `independentAcceptanceDefects`（形状校验 + 标记规则 + heuristic/映射互斥 + 映射要求 composite 模式），普通分解与 replay 路径共用。`normalizeCriteria` 透传全部新字段；`replayTask` 对契约执行同一校验并携带标记。
- **模型声明面**：`task_decompose` 工具 schema 增加 `acceptsArtifact` / `childEvidence` / `heuristic` / `requiresIndependentAcceptance` 可选属性（全部可选，缺省行为不变）。
- **兼容与旧 ledger**：新字段全部可选；reducer 原样拷贝载荷、不校验新字段；旧任务读取、回放、验收行为不变；`requiresArtifact` 收紧对旧声明同样生效（失败 run 同名产物不再满足依赖），这是修复点。

持久化记录：`docs/persistence-changes/2026-09-21-parent-acceptance-evidence-identity.md`（`task/event` 载荷内传递引用的类型新增可选字段，非 SessionEventMap 根，四个事件根指纹不变）。

测试锚：`verifier/tests/unit/composite-verifier.spec.ts` 的 `CompositeVerifier parent evidence map (P4, KISS §6 C2)` 组（P4-A 完整映射通过并列名所验项、evidenceRef 三种拼写；P4-B 判据缺失/引用缺失/越界/无 pass 判决逐一点名；P4-C 失败 run 的同名产物不满足、verified run 满足；无子任务+映射拒绝而不退化为合取；heuristic 标注）；`task-runtime/tests/unit/admission.spec.ts` 的 `checkDecomposition parent acceptance declarations (P4, KISS §6 C2)` 组（形状拒绝、marker 缺映射拒绝、空映射拒绝、heuristic 与映射互斥、父级标记复查）；`task-runtime/tests/unit/orchestrate.spec.ts` 的 `TaskRuntime parent acceptance and evidence identity (P4)` 组与改写后的 W27 合法跳过用例（P4-A/P4-B 经真实 cascade + 真实 CompositeVerifier；P4-C 失败产物 blocked+Obligation、verified 产物放行、acceptsArtifact 原始输入；P4-D heuristic 不计确定性通过且同形状无标记照过；P4-E admission 拒绝且零落库）；`packages/singularity/tests/integration/parent-acceptance.spec.ts`（真实 TaskService + TaskRuntime + VerifierRegistry 全链：P4-A 映射+组合 command 双通过、P4-D 组合 command 失败拒父、P4-B 点名缺失判据、P4-C 失败/verified 产物两态、replay 与普通分解共用准入规则；断言全部读回持久化事件日志）。

验证（2026-09-21，实际执行）：

1. `packages/singularity` 下 `pnpm build`：通过；日志可见 `agent-singularity build$ tsc --noEmit && tsdown`。
2. 外层 harness 下 `pnpm vitest run --project unit packages/singularity`：25 文件 / 636 项通过（P4 新增 27 项；`composite-verifier.spec.ts` 5→14、`admission.spec.ts` 23→33、`orchestrate.spec.ts` 68→76；基线 609 项）。
3. 外层 harness 下 `pnpm vitest run --project integration packages/singularity`：20 文件 / 103 项通过（新增 `tests/integration/parent-acceptance.spec.ts` 7 项）。
4. `packages/singularity` 下 `pnpm run verify-persistence`：OK，4 个事件根指纹匹配 `docs/persistence-schema.json`（digest 未变，按纪律以记录备案）。
5. `packages/singularity` 下 `git diff --check`：通过。
6. `agent-singularity` 下 `pnpm exec tsc --noEmit`：0 错误。
7. 反例先红后绿：实现前新测试按预期失败（composite 8 项、admission 8 项、orchestrate 5 项、integration 6 项），实现后全部通过。

给下一批的前置条件：P4 只做最小机械版——映射按 batch 位置指向（父 AC 作者在子 id 产生前唯一稳定的身份），C3 假设满足性完整证明、通用自然语言蕴含、verifier selftest 正负样本执行（S1-V 切片 2）、验收输入来源固定均未建；`requiresArtifact` 收紧后，依赖“任意 run 状态产物”的旧声明改用 `acceptsArtifact`；blocked 仍无恢复出边（S2-R）。不因 P4 通过宣称独立父验收全部完成。

## S1-V：先保证验的是目标

落点：`task/src/types.ts`、`verifier/src/index.ts`、`verifier/src/composite-verifier.ts`、`task-runtime/src/admission.ts`、`task-runtime/src/orchestrate.ts`。

分成三个可独立验收的切片：

1. **父级验收**（2026-09-21 P4 已完成最小机械版）：父 AC → 子证据映射（`childEvidence`，按 batch 位置 + 判据/证据引用，验收期对照 store 校验存在性与 verified 来源）与至少一个独立父级组合检查（映射断言 + 父级 command）已落地；默认 composite 的“子全 verified”仍只作汇总。剩余：C3 假设满足性完整证明、自然语言条款只作显式标注的启发式（`heuristic`）。
2. **验证器自测与输入身份**（待建）：将当前 selftest 描述落为可执行正负样本；注册/晋升时执行。记录 verifier 版本，固定测试与阈值来源，明确 worker 可写产物与受保护验收输入的边界。
3. **证据依赖有效性**（2026-09-21 P4 已完成）：`requiresArtifact` 收敛为已验证参考产物（verified run + pass 判据），原始输入用 `acceptsArtifact` 独立表达；失败/过期 run 的同名产物不再满足依赖。剩余：产物来源、版本/摘要与适用性的进一步绑定。

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
   - 2026-09-21 P2 已完成其中“单文件 Skill 候选内容绑定”切片：prepare 摘要、replay 报告身份、服务入口复检、apply 写入同一版本均已落地并通过验收；P3 再完成“生产基线没变”切片：prepare 记录生产文件摘要、apply 人审前与实际写入前复检。“replay 固定 manifest/run/evidence 身份”与 preset 沙箱执行仍待建。
2. **补目标验证最小闭环**（S1-V）：选一个可确定性检查的父级目标，增加独立组合判据；依赖引用区分原始输入与要求已验证的产物。verifier 正负样本实际执行，固定判据来源；相同失败不能仅凭不退化被视作修复。模板改判据应交由独立固定基准比较，不能只改变 command 后继续比较通过率。
   - 2026-09-21 P4 已完成其中“父级验收最小机械版”与“证据依赖有效性”两个切片：父 AC `childEvidence` 映射 + 独立组合检查（映射断言与父级 command）+ `heuristic` 显式标注；`requiresArtifact` 收紧为 verified 参考产物、`acceptsArtifact` 表达原始输入。“verifier 正负样本实际执行，固定判据来源”（切片 2）仍待建。
3. **联合实现自动补路径与恢复**（S2-E / S2-R / S3）：定义 gap/obligation 身份及解决事件，supervisor 消费一次诊断、实现候选、调用已有评估工具；人审改进后系统应用并重新准入受阻分支。先交付一个 L1 和一个 L2 案例，覆盖拒绝、重启去重和预算停止。不得以人工编写 skill 的演示代替验收。
4. **扩大改进目标**（S4）：以完整轨迹驱动 Retro，增加成功率/成本、verifier 漏检/变异检出、模板难度归一化指标。当前非退化闸不能作为全面自动接受的完成证据；更广的运行时/裁判修改仍由 supervisor 实现验证、人审核。

现有 decide/apply 各有一次人审，本批保持该行为。后续可将批准绑定到候选摘要与报告摘要，使同一已批准版本自动 apply/resume；权限扩大或内容变化需要新的决策，不能把审批次数减少实现为绕过对象身份校验。

验证：`pnpm build` 通过；全部 Singularity 单测 25 文件 / 570 项、集成 19 文件 / 94 项通过；`verify-persistence` 的 4 个事件根指纹一致，`git diff --check` 通过。新增 21 项测试覆盖坏 verifier、伪造比较、缺失/退化 holdout、manual 晋升拒绝、人审前预检、报告替换及旧 ledger 回滚。集成 replay 使用运行时 stub，未运行真实 LLM、BB 仿真或生产晋升，未重启服务。

额外类型检查：verifier 的 `tsc --noEmit` 通过；agent-singularity 在 `da48925` 基线有 12 处错误（SessionId 调用、DiagnosisProposal 与 mutation 收窄）。以 TypeScript compiler host 读取 `da48925` 的原始 src 对照，基线同样有这 12 处错误，本批未新增。当时该包 `pnpm build` 只有 tsdown，不代表严格类型检查通过；此当前态已由 2026-09-21 的 P1 修正，见上文 P1 节（该包 build 现为 `tsc --noEmit && tsdown`，类型检查零错误）。
