# K3 交付记录：完整 Skill 改进单位（待验收）

> 审查后返工（2026-09-27，两项可达缺陷）见[返工记录](2026-09-27-k3-rework-record.md)；本记录保留首轮交付证据。

- 合同：[execution-prompts/12c-k3-skill-unit.md](../execution-prompts/12c-k3-skill-unit.md)；公共合同：execution-prompts/README.md。
- 基线：Singularity `f823853`（K2 已验收，证据 [K2 审核](2026-09-27-k2-review.md)）、外层 `1d19c45f`；开工前两仓工作树干净（外层 thirdparty/deepseek-harness 未跟踪，保留未动）。
- 交付：Singularity `9998026`（代码+测试+lib 产物）与本记录所在的文档提交（guide/计划/角色合同/持久化记录/本记录，见 git log）；外层指针提交见外层 git log。日期 2026-09-27。无真实模型费用、无推送、无部署。
- 执行：实现主代理 + 五个 coder 子代理 + 一个独立复核子代理（分工见文末）。

## 新行为一句话

已有 Skill 的同名改进单位从"单文件 SKILL.md"扩为完整对象：指导型仅 SKILL.md；执行型（sidecar 且 resources=[]）为 SKILL.md + SKILL.contract.json——prepare 冻结完整对象并由生产派生候选 sidecar（只重算 content.skillMdSha256，其他字段逐项保持，模型不提交 sidecar）；冻结/报告/晋升门/apply 复检比较同一完整身份；apply/rollback 经同一 commit_intent 逐文件原子替换、写后完整对象可加载复检才记完成，崩溃按文件对账恢复，准入闸按目录阻断开放意图。

## 验收编号 → 证据

| 编号 | 真实入口 | 测试与实际结果 |
|---|---|---|
| K3-1 | 真实工具链 evolution_propose→candidate→prepare→replay→gate→decide→apply（两次真实人审）→ `EvolutionService.*`；执行型 fixture skill 经 capability 表注册、verifier 'command' 真实注册 | `tests/integration/k3-skill-unit.spec.ts` K3-1 例：旧正文败/新正文过、回归+holdout 不退化；candidate 侧 Run 绑定快照含候选正文+派生 sidecar 字节；apply 后生产两文件=候选字节且 sidecar 逐字段仅摘要变（未人工改摘要）；新 Run 经真实准入绑定新对象；旧绑定 Run 快照不变。通过 |
| K3-2 | prepare / checkPromotion / apply（工具与服务双入口） | k3 spec K3-2 十例：knowledge sidecar、resources≠[]、坏摘要（content-mismatch）、沙箱 sidecar 非摘要字段篡改、frontmatter 改名（skill-name-mismatch）、裁判漂移（verifier-unknown）、权限漂移（capability-unknown/tool-not-covered）各具名拒绝零写零行；指导型全链正例通过。单元补充：evolution.spec.ts K3 段（prepare 拒绝面、P2/P3 漂移、伪造账本推导检查直测、champion sidecar 篡改）；skill-promotion-gate.spec.ts 按侧身份 12 例。通过 |
| K3-3 | 实验冻结（experimentCandidate P2）与 checkPromotion/apply 复检 | k3 spec K3-3 五例：prepare 后改 sandbox SKILL.md/sidecar→冻结拒绝零 run；decide 后改生产 SKILL.md/sidecar→apply P3 拒绝不烧人审；双侧工作区隔离（快照 digest 各自等于冻结值、互不含对方字节）。通过 |
| K3-4 | `Config.commitProbe(stage, target)` 四窗口 × apply/rollback + 同目录重开 reconcile；真实 SIGKILL 子进程（env 门控嵌套 vitest，沿用 K2 机制） | k3 spec K3-4：四窗口（intent-recorded / write-renamed@SKILL.md 混合 / write-renamed@sidecar / commit-verified）×双向——混合态被断言非任一完整版本且准入具名拒绝，重开对账后生产=完整目标、完成行恰一条、staging 清空、恢复后新 Run 加载完整对象；第三方改任一文件→blocked 具名零写；两 proposal 同目标竞争第二者被同目录闸拒绝、结算后恢复提交。SIGKILL 子集：apply 三窗口+rollback 混合窗口（父断言 signal/死 pid/ESRCH/磁盘状态）；普通运行跳过 1 子例。单元：commit-durability.spec.ts 两文件持久化段（来源/目标 fsync 失败各自具名零写等）。通过 |
| K3-5 | 九工具+服务唯一提交协议；公开检查 | k3 spec K3-5 例：v4 账重开读回、两文件已应用对象经工具整对象回滚、九工具均被真实驱动；grep 清场：`unsupportedCandidateEntries`/`writeProduction`/src 下 `single-file｜单文件` 零命中（assembly.spec.ts 有"九工具无单文件误导"断言）。公共检查见下，全绿。通过 |

## 删除清单

- evolution.ts：`unsupportedCandidateEntries` 及"只接受单文件"晋升拒绝分支（替换为"恰好固定文件集"边界）；单文件 `commitTarget`/`target` 单值意图字段；模块头与 JSDoc 单文件陈述。
- commit.ts：单文件 CommitRequest 字段（改 files）；`productionRelative` 单文件措辞。
- 工具/prompt：evolution-{propose,candidate,prepare,replay,apply,rollback,list} 与 root prompt 的全部"single-file/单文件"表述（grep 双向清场零命中）。
- 未新建：目录打包器、patch DSL、版本服务、资源扫描框架、兼容 reader、第二提交器（commit.ts 仍是唯一生产写路径，复核者核实）。

## 公共检查（实际结果，主代理复跑）

- `pnpm build`（packages/singularity）：exit 0（跟踪 lib 产物与 src 一致）。
- `pnpm vitest run --project unit packages/singularity`：60 文件 / 1915 例全过（基线 1846；+69）。
- `pnpm vitest run --project integration packages/singularity`：58 文件 / 484 过 + 2 跳过（env 门控 SIGKILL 子例）；全量另跑三次均绿（一次出现与本票无关的 a4 抖动，复跑即过）。
- `pnpm run verify-persistence`：OK，4 事件根匹配；`git diff --check`（两仓）：干净。
- `agent-singularity` 与 `evolution` `pnpm exec tsc --noEmit`：exit 0；`task-runtime` 维持 8 个既有基线错误（与本票无关，未新增）。

## 红绿与变异（摘要）

- 各子代理均先红后绿：A（新单测对旧码 245 failed；K3 段 25 failed）；B（221 failed 含报告 v2/缺 candidateRegistryRevision/幂等键）；C（目录匹配 2 例红）；D（13 例夹具+2 tsc 错误清零，两处新断言实测会红）；E（五项变异——意图只记 files[0]、commitRequest 只提 SKILL.md、sidecar 不派生、P2 跳过 sidecar、闸退按文件——逐一变红并 sha256 复原）。
- 主代理补测红证据：伪造账本推导检查（短路 `sandboxText !== expectedSidecar` → 红，复原逐字节一致）；恢复屏障告警修复（回退读 `outcome.target` → proposal-lifecycle 屏障例红）；champion sidecar 直测（关两道 champion 校验 → 新例与既有 champion 例红）。
- 独立复核（与实现分离的 coder 子代理）自跑 unit/integration 全绿、两处变异（verifyCommitted 方向身份、准入闸回退）均变红并复原；发现 1 条真实缺陷 + 2 条覆盖缺口，均同票闭合（见下）。

## 独立复核发现与闭合

1. task-runtime 恢复屏障告警读已删除的 `outcome.target`（真实探针打出 `targeting undefined`）→ 修 `src/index.ts` 的 `CommitReconcileOutcome.targets` 与告警拼接；proposal-lifecycle 屏障例改真形状替身并断言两目标路径（红绿证据见上）；k2 集成例加目标路径断言。
2. champion sidecar 篡改无直测 → 新增单元例覆盖 checkPromotion 与 rollback 两道门（伪造/篡改均具名拒绝零写）。
3. 推导一致性分支此前只被效果间接覆盖 → 新增伪造账本直测（fold/P2 都放过、推导检查具名拒绝，文案先于冻结比较）。

## 持久化

ledger 单版本切换 `formatVersion: 4`（commit_intent.files、prepared 完整身份、完成行 targets=全文件集）；实验报告 2→3。现场 `.dsh/evolution/` 无活动账本（K2 已归档 v1，其后零 v3 行），无未闭合对象需处置，新账从空启动。记录：[persistence-changes/2026-09-27-k3-skill-object-ledger.md](../persistence-changes/2026-09-27-k3-skill-object-ledger.md)（非 SessionEventMap 根，verify-persistence 不涉及）。

## 400 行以上触及文件处置

- `evolution/src/evolution.ts`（2590→3110）：保留为账本/状态机/fold/晋升门/提交协调所有者；提交机制仍在 commit.ts（623→768），未回迁主文件。
- `task-runtime/src/index.ts`（约 7.5 千行）：仅一处真实消费修复（ReconcileOutcome.targets）+ barrel 导出 skill-contract 助手，属既有装配职责。
- `promotion.ts`（1078→约 1250）：按侧身份检查属其晋升门职责；`sidecar.ts` 未改（loader 复用）。`provider-precheck.ts`：闸口径内聚于既有判定链。无新增包、无转发层、无第二事实源。

## 未覆盖项 / 已知边界

- 合同明确排除：其他资源、knowledge sidecar、角色转换、新增 provider、改 verifier/capabilities/requiredTools（均具名拒绝；A6 只加 capability 行与新 provider，计划 F.4）；分布式锁（单进程约束同 K2）；真实模型效果实验（本票不授权，机制通过不声称技能变好）。
- 如实记录：准入闸按目录匹配与按文件匹配对**合法**意图等价（fold 已保证 files[0]=SKILL.md），目录口径的差异只在畸形输入上体现（有单元例）；`packages/singularity/tests/` 无 tsconfig 覆盖为既有状况；SIGKILL 证明"崩溃点落在正确顺序"，断电/页缓存语义由 fs 注入断言覆盖（同 K2 分工）。其余：无。

## 子代理分工

- A：evolution 核心——skill-contract 助手、commit.ts 两文件、evolution.ts 全生命周期与 fold、账本 v4、单元测试（含后续直测补强）。
- B：实验冻结/报告/晋升门的完整身份与按侧修订（replay/experiment/promotion + 单元测试）。
- C：准入闸按目录匹配（provider-precheck + 单元测试）。
- D：九工具 schema/返回说明、root prompt、agent-singularity 单元测试清场。
- E：集成夹具迁移、k3-skill-unit.spec.ts（32 例）与 SIGKILL 子集、变异验证、首轮全量公共检查。
- 独立复核子代理：全 diff 审查 + 实跑 + 变异，发现上述三条并验证闭合。
- 主代理：合同落实与接口拆分、派发汇总、核心代码亲审（commit.ts/evolution.ts/promotion.ts/provider-precheck.ts 全量或逐 hunk）、复核缺陷修复、文档同步（guide §5.20 与受影响段、计划 12b/12c/F.2、角色合同、README、持久化记录、本记录）、全部公共检查复跑、提交与外层指针。

## 移交后续票

K4：复盘与执行预算分离（12d），前置接口不变；K3 审核通过后才派发。A6 只增加 capability 行与新 provider，已有 Skill 更新/实验/提交机制不再重做。
