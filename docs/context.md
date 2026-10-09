# context.md —— 跨轮工作记忆

> **每轮结束更新此文件。** 它只放"下一轮必须知道、丢了会走错路"的东西。
> 长文档不放这里：`docs/blueprint.md`（蓝图）、`docs/review.md`（第一轮审核与 K1/K2 检查点）。
> 上一轮更新：2026-10-09（第一轮审核已落实，开始 Phase A）。

---

## 1. 位置与基线

| 对象 | 位置 | 基线 |
|---|---|---|
| **新仓（我们在建的）** | `/home/ROXY/code/singularity-core` | 分支 `main`；已提交 S1(`7b4e5cf`) / S2(`4f6b2e6`) / 蓝图(`798c6d9`) |
| 旧仓（**冻结为行为参照**，不迁移其包结构） | `/home/ROXY/code/bb_work/harness/packages/singularity` | `6a0edde` |
| DSH 源码 | `/home/ROXY/code/bb_work/harness/thirdparty/deepseek-harness` | 审核基线 `639ed01` |
| DSH 已装产物 | `/home/ROXY/.local/node-v22.23.3-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` | **`0.2.0-rc.2`** |
| RRSI 上游 | `/home/ROXY/code/rrsi` | `be50316` |
| 探针（可重跑） | `/home/ROXY/code/singularity-probe/probe.mjs` | storageDomain vs session lease 实测 |

**依赖铁律**：npm 上 `@deepseek-ai/dsh-*` 是 `0.0.1-rc.1`，本地是 `0.2.0-rc.2`。**永不从 registry 装**；指向 checkout 或 CLI 已装的那份。

## 2. 治理文档与当前方向

- `docs/blueprint.md` —— 目标 / 已实现 / 根因 / 理由 / 计划 / 架子。§7 的五个问题已被 review 逐条回答。
- `docs/review.md` —— **权威方向**。§2 基础问题（F01–F06）先做，再按 §5 的 A–F 阶段推进。§6 是 K1/K2 检查点，§7 是反例表 E01–E12。

**review 的收敛目标（三件事）**：一个事实只有一个权威来源；一项领域规则只有一个实现；一次方法改进能由真实执行事实证明。**文件数/事件种类数/行数只是辅助指标。**

**阶段（review §5，取代我原先的 S3′–S9）**

| 阶段 | 交付 | 退出条件 | K |
|---|---|---|---|
| **A** | 专用控制 store、DSH 承载实验、串行提交、严格边界、命令结果识别 | 双进程互斥；并发命令正确；屏障失败不返回成功；提交后/答复前崩溃可识别原结果 | — |
| **B** | 最小 E3、Task 分解与责任、初始不可变 Revision、最小 Bubble、真实 verifier 与固定来源 receipt | 根/子任务执行与依赖推进；产物独立验收；SIGKILL 后恢复同一 session/责任/绑定 | **K1** |
| **C** | 冻结双侧输入、真实领域取数、非补偿约束、真实重复与噪声依据 | 好候选通过；高分越界拒绝；缺失分母正确；每份报告有真实 trials | — |
| **D** | draft 状态机、E6 原生审批、决定重算、唯一指针切换 | 批准绑定具体差异；陈旧/内容变化拒绝；head 不引用半成品 | — |
| **E** | 显式 round、真实历史与 frozen deltas、m≥2 选优、探索/剪枝消费者、消费反馈 | 至少两轮；第二轮读第一轮；历史不被新 head 改写 | **K2** |
| **F** | 关键行为回归、领域任务集对照、部署替代 | 恢复/边界满足新契约 | — |

**下一次重要审核在 A+B 完成时**。若 A 的"扩展事件承载"实验失败，**先改适配契约，不向 B 叠功能**。

## 3. 我必须在改动中修掉的实测反例（丢了会重犯）

| # | 反例 | 归属 |
|---|---|---|
| E01 | DSH 运行时事件词表是**固定生成集合**；仓外插件扩展 `SessionEventMap` 不改变它。`plugin:singularity:event` 无 `ignorable` → `SessionFormatUnsupportedError`；加标记 → 接受 | F01 |
| E02 | 同一 `ProtocolLog` 并发两次 `emit` → 两次成功、磁盘 `seq=[0,0]`、重开 `chain-broken` | F02 |
| E03 | 用验证器名填 `actor`、无产物引用 → Run 可达 verified | F03 |
| E04 | 合法 Task 日志换空当前注册表重开 → `unregistered-verifier` | F04 |
| E05 | 临时副本加 default-import 写者 + 仅注释中出现的导出 → **7/7 门禁通过** | F06 |
| E06 | unknown contract/payload 字段被接受；`detail:123` 变空串；无 Run 的已准入 Task → `phase=failed` | F06 |
| E07 | `digestOf({v:NaN})===digestOf({v:null})`；`digestOf({v:undefined})===digestOf({})` | U02 |
| E08 | `ruleFor('toString'\|'constructor'\|'__proto__')` 返回继承属性而非 `unknown-kind`；`declare` 先改 G3 owner 后拒绝 → 留下未注册 owner | U07 |
| E09 | A=.6、B=.8：发布 B 前 B 的 Δ=+.2；发布后 B 的 Δ=0、A 的 Δ=−.2（历史被新 head 改写） | R03 |
| E10 | B=.8 被成本拒绝后 `bestQuality` 仍为 .8（不能当上游 S*） | R03 |
| E11 | B 换 scope → A 从 measured=true 变 false | R02 |
| E12 | 计划 2 trials、missing=1、仅一条质量 1 观测 → quality=1, expected=2, incomplete=true | R06 |

## 4. 方向性更正（纠正我此前的表述，别再写错）

1. **"DSH 默认未知即拒绝"不能作为我们扩展事件的前提。** 那只对宿主已认识的事件成立；**仓外插件**扩展的事件必须自带 `ignorable: true` 才会被接受。因此需要一个**专用控制 store**：外层用 DSH 可承载的扩展事件，内层由 Singularity 自己强制校验 protocol/version/kind/payload。**不得借用一个已知 DSH 事件名塞入不相符的业务载荷。**
2. **删掉重复的物理层自建**：适配 DSH 后用其外层 `type/seq/time/data`；**删掉重复的连续 seq、文件摘要链、物理日志校验**（U02）。内容身份摘要仍要（revision/产物/冻结计划），但不能与物理追加链混为一谈。
3. **G1–G4 不是互斥级别**，而是可组合属性（追加持久性 / 批次可见性 / 条件更新 / 纯推导）。取消"一个事实只能一个级别"。正确的 G3 约束是：**每个 Environment 只有一个 active revision；publish/rollback 共用一条权威切换路径；expected revision + generation 在提交队列内检查。**
4. **DSH `append([a,b])` 不是多记录崩溃原子事务**（其恢复会保留 torn frame 中已完整写出的记录）。有业务原子性的操作应表达成**一条完整事实**（如一份分解批次、一个完整环境 manifest 的发布）。
5. **内容块不必为"无第二文件"塞进日志**（manifest/报告/产物/工作区）。先准备并验证完整不可变内容，再提交其引用；允许未被引用的准备产物，**不允许生效指针引用半成品**。同 revision ID 内容改写必须拒绝；"改动后 digest 变了"只证明哈希敏感，不证明不可变。
6. **重放恢复决策，不会原子创建 agent / 投递消息 / 跑 shell / 克隆 worktree。** 不可识别的外部副作用应具名暴露不确定状态，不自动重复；不承诺跨外部工具的 exactly-once。
7. **两类版本分开管**：宿主格式版本、领域事件版本、投影缓存版本、receipt 格式版本。`fold` 按 version 过滤**不是**完整状态的升级路径（U06）。
8. **RRSI 的三处更正**（R05/R06/R09）：
   - novelty 数**不同结构机制类型**：两条 skill edit 的 novelty 仍是 **1**，不是 2。**我在 F1 设计里写"2 条编辑 → novelty 2"是错的。**
   - "missing 计 0 且分母保留"**不是现有代码的行为**（E12：missing 不会补足分母）。缺失观测必须由生产者依据冻结槽位显式表达，或聚合器直接按槽位计划算。
   - `novelty ≡ 1` 的精确危害是**污染记录与搜索信息**；**m=1 的准入不会因 novelty=1 而放宽成本规则**，不能仅凭这个常数宣称已经错误发布。
9. **F1 设计的两处更正**：生产 history consumer（`deriveDecision` 构造空 HistoryFacts，`bestQuality`=本次 baseline）必须一并接通，否则字段透传无用；**已冻结/已分发的格式增加必填字段要升版本**——不能由"本机没有旧账本"推导"同版本格式可随意改变"。
10. **`appending on reopen`**：`flush` 是公开 `SessionHandle` 的崩溃持久性屏障；适配器必须遵循该接口，或明确限定并测试该后端（F01）。

## 5. 当前代码状态（S1/S2，15 文件 / 41 测试 / 7 门禁）

`src/protocol/{envelope,log,registry,fold,refusal}.ts` + `src/task/{contract,protocol,view}.ts` + `src/index.ts`；`scripts/{gates.mjs,slice.mjs}`；`tests/` 5 个文件。

**S2 已建立且必须保留的三条不变量（写在 reducer 里）**：判据由它命名的验证器裁决；执行者不自判自己的 run；每条判据都有 pass 才 verified（拒绝时点出缺哪条）。**S2 的 G4 派生 receipt 与唯一读投影 `TaskView` 也保留。**

**判定要删/要换**：`ProtocolLog` 的文件存储实现（fsync/读回/size/摘要链）——按 U02 与 F02 处理，不做修补式抢救。

## 6. 下一轮的第一批动作（本轮已启动）

1. `docs/context.md`（本文件）建立。
2. 修 §3 里属于我代码的实测反例：E02/E03/E04/E06/E07/E08（含 `phaseOf` 待运行态）。
3. F06：门禁换成 AST/符号检查，并把 E05 的两条绕过路径做成回归反例。
4. F01 实验：专用控制 store 的承载实验（DSH 外层 + Singularity 内层校验 + `flush` 屏障）。
5. 更新 `docs/blueprint.md` 的阶段表为 review §5 的 A–F，**不把未实现标为已完成**。
