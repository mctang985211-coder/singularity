# A6 + S2-R + S3 交付记录：候选闭环与原目标新尝试（待验收）

- 合同：[execution-prompts/14-a6-autonomous-evolution.md](../execution-prompts/14-a6-autonomous-evolution.md)、[计划 F.4](../2026-09-20-vrtc-code-change-plan.md)、公共合同 [execution-prompts/README.md](../execution-prompts/README.md)。日期 2026-09-28。
- 状态：**待验收**，不是已验收。EVO-2～EVO-5 的机制与拒绝副作用已实现并在收尾中修掉三条假绿/断路；EVO-1 真实 Agent 冻结案例判定 **FAIL**，所以整票不能 PASS。
- 派发基线：Singularity `58a290e` / 外层 `b2815b272a`（A6 合同冻结）；实施基线：Singularity `02b4d00` / 外层 `75908eebe3`（补齐同源单在途合同后的最终派发点）。中断检查点：`117df061` / `0763852b`；发现闭合检查点：`fcc0d076` / `86d33ad7`。
- 交付版本：收尾代码提交 `9e4f7e988fa9908333e69a59fabd404e2834b38d`；文档提交与最终外层 SHA 由最终交接读取（提交不能自指自己的 SHA）。外层只允许更新 `packages/singularity` 指针。既有 `thirdparty/deepseek-harness/{.tmpscan/,bad.txt}` 未跟踪文件属于用户现场，保留不动、不提交。
- 未推送、未部署、未运行 BB 仿真；生产 `/home/ROXY/code/bb_work/harness/config.yml` 与生产 Skill 未被实验修改。

## 验收编号 → 公开入口 / 事实 / 测试 / 结果

| 编号 | 公开入口与事实所有者 | 正反例、拒绝副作用与证据 | 结论 |
|---|---|---|---|
| EVO-1 | 临时 fixture `/home/ROXY/code/bb_work/a6-evo1-2026-09-28`；Harness 被测 Agent 使用 `config.yml` 的免费 `step-5-preview`，与子代理模型及 K3 账分离 | L1/1 真实运行 180.131s，源根未形成冻结预期；L1/2 900.220s，proposal 已写但 typed `mutation` 被当作字符串；L1/3 取消中断且仍计第三次。L2/1 870.875s、25/25 请求响应、47523 输入/26142 输出/437504 cache-read token，模型生成 Skill/sidecar 文本，但 7 次 candidate 均因字符串参数拒绝；无物化、verifier、holdout、人审或应用。`l1-run-9` 与 `wiring-*` 明确为 scripted，不计真实通过。证据：[EVO-1-assessment.md](/home/ROXY/code/bb_work/a6-evo1-2026-09-28/evidence/EVO-1-assessment.md)、[manifest.json](/home/ROXY/code/bb_work/a6-evo1-2026-09-28/evidence/manifest.json) 及逐轮原始 requests/responses/tool-calls/usage。生产零应用；未打印凭据，196 个证据文件扫描 API key 命中 0。 | **FAIL**；整票保持待验收 |
| EVO-2 | `EvolutionService.propose/candidate/prepare/runExperiment/checkPromotion/gate/decide/apply/rollback`；`capability-candidate.ts`、`capability-config.ts`、普通 provider precheck 与 K2/K3 commit intent | `capability-experiment.spec.ts`：缺 provider 基线走真实准入 `not-admitted`、无伪 Run，candidate 走原 driver/verifier，回归和 holdout；`a6-capability-row-gate.spec.ts`、`a6-joint-commit-death.spec.ts`：table 三摘要、提交门+写缝重检、半成品行零准入、第三方漂移/拒绝零写。收尾新增成功 Diagnosis/verified Run 在 experiment/resume/promotion/apply 前重读并拒绝，零实验/应用/新业务 Run；`evolution_list` row-only 与 row+Skill 公开查询不再 TypeError，所有模型可见工具和 root evolution protocol 不再声称 capability 只能记录。 | PASS（机制） |
| EVO-3 | `task_recover({sourceDiagnosisId, requestKey})` → evolution `coordinateRecovery` → task-runtime `recoverTask`；事实落在原 task store | `a6-evolution-chain.spec.ts`、`a6-recovery*.spec.ts`、`task-runtime/tests/unit/recovery.spec.ts` 覆盖能力缺口和纯产物缺口、同 key 幂等、同源在途换 key、跨 graph/错 diagnosis/成功源/未批准应用/超额零新 Run；`deriveReuse` 从 store 自动绑定两字段调用，允许通过成员位于失败成员之后；坏引用列位置并重做，消费者依赖闸和根提交再次查 artifact/evidence，旧失败可读。 | PASS |
| EVO-4 | K2/K3 联合提交恢复；task-runtime adopt/reconcile；`tests/support/process-death.ts` 的真子进程 `SIGKILL` + 新进程 | `a6-joint-commit-death.spec.ts` 覆盖联合提交 5 个持久边界；`a6-process-restart.spec.ts` 覆盖新 Run 后/批次准入前、准入后/spawn 前、新根结算前。收尾 RED 证明结算窗口旧测试把 workspace 未接管造成的假 `failed` 当绿；GREEN 改为 verifier 前安全接管，同一 Run 经原 AC `verified`、一次 Review、map pass、同 key 零重复、预算不归零；活跃/第三方 owner 保持具名拒绝。 | PASS |
| EVO-5 | supervisor handoff grant/prompt；普通 normalize/admission/gate/driver/settlement/K4 budget；直接 evolution/runtime 服务入口各自重检 | `a6-supervisor.spec.ts` 证明 `task_recover` 只在 supervisor 面可见，普通 root 不可见；`a6-recovery-ownership.spec.ts` 与 recovery unit 证明直调所有权重检；capability experiment、取消/rollback/重启与正例共用原执行链和累计上限，无第二预算账、恢复调度器或 verifier。候选业务 Run 计原 store，上限满时零准入；实验模型用量只在 evolution 证据中记录。 | PASS（机制） |

## 收尾发现与 RED → GREEN

1. **EVO-4 新根结算假绿**：旧 `a6-process-restart.spec.ts` 在真实 SIGKILL 后要求恢复 Run 为 `failed`，错误原因是新进程在 workspace ownership 重建前调用 verifier。先把公开结果改成同 Run 原 AC `verified`，得到 RED（expected verified / received failed）；`adoptRootThroughBarrier` 现只在存在 submitted Run 时先安全重建 ownership，再走共同 `reconcileStore`。定向 29 通过+1 跳过，recovery/workspace unit 54 通过。
2. **成功来源可先应用、恢复才拒绝**：审计复现真实 `propose → candidate → prepare → experiment → gate → decide(PROMOTE) → apply`，source Task/Run 为 verified 时仍写 registry/config。新增真实 store unit/integration 先 RED，后在实验启动/续跑、`checkPromotion` 与 `apply` 重读可解析 Diagnosis 的源 Task/Run；`decide(PROMOTE)` 经同一检查。成功源和“决定后、应用前才变为 verified”均零生产写。
3. **capability prepared 的公开查询断路**：`evolution_list.execute` 对 row-only 读 `undefined.contract`，对 row+Skill 读合法 `skillBaseline:null.name`。两个公开工具用例先 RED，按 targetType 渲染后 GREEN；同时修正 propose/prepare/replay/gate/decide/apply/rollback 与 root prompt 的 skill-only 陈述，并允许 row-only rollback 进入真实人审门。
4. **拒绝顺序回归**：来源门禁一度把通用 S4-E 的占位 `diagnosis:d1` 当成必须存在，抢先覆盖既有“候选内容漂移”反例；integration RED 显示错误拒绝。门禁收窄为只从当前 store 中实际可解析的 Diagnosis 推导成功/失败，重新 build 后原漂移拒绝恢复，四份关键 integration 30 通过+1 跳过。

## 真实 Agent 实验详情

- 冻结输入、原 AC、command verifier、holdout 与预计工具权限分别在 `cases/L1.frozen.json`、`cases/L2.frozen.json`；生产 config 冻结 SHA-256 `8dec0095667b84245b7b30251f8a5aedf8de8df6ca3c7fdac1c27e801af13d9e`，实验后相同。
- 已知真实墙钟合计 1951.226s；L1/3 只有至少 108.336s 的产物跨度，无完整 run/usage，不能伪造精确合计。已知值低于 90 分钟总限；L1 已达每例 3 次上限，绝不再跑。L2 虽形式上还有次数，但无法补回 L1 双案例 PASS，故停止。
- 模型未返回金额字段；费用只能记录为“配置为免费模型、无金额报告”，不能从配置推导 0 元账单。受控 DSH approval allow/reject 只在 scripted wiring 到达；真实轮没到人审，不能称真人批准或真实人审拒绝已验证。
- L2 被拒参数中的 Skill/sidecar 原文保存在 `evidence/l2-run-1/model-output/`，不是候选文件；不得手工搬入 sandbox 冒充 Agent 产出。

## 删除清单与单一所有者

- `git diff --diff-filter=D 02b4d00`：**无整文件删除**。
- 替换并删除的生产分支：`task_review_pack` 的“所有建议永远 pending/A6 未装配”静态分支，改为与 supervisor handoff 消费同源的 `handoffStateLine`；verifier 对缺 childEvidence 位置的后移/压缩语义，改为位置保持并具名失败；工具与 root prompt 中 capability “只记录、不候选/不晋升/不回滚”的旧消费者陈述；恢复结算前 verifier 先跑、workspace ownership 后建的错误顺序。
- 没有第二调度器、状态机、预算账、事务平台、兼容壳或 verifier；evolution 只拥有候选/评估/批准应用协调，task-runtime 仍唯一拥有执行、恢复、依赖闸、driver、结算与 Task 预算，Task store 仍唯一保存 Run/Review/Evidence/Diagnosis 事实。

## 400 行以上文件处置

- **保留既有门面/唯一所有者**：`task-runtime/src/index.ts`（服务门面、恢复 barrier/结算）、`orchestrate.ts`（唯一 driver、共享 artifact gate 与 worker spawn）、`task/src/{index,service/state,types}.ts`（事件与 reducer）、`evolution/src/{evolution,experiment,promotion,replay,commit}.ts`（ledger/实验/晋升/提交各自既有所有者）、`agent-singularity/src/{review-agent-ledger,review-agent-run}.ts`、`task-runtime/src/{provider-precheck,gate,run-binding}.ts`。本票在原所有者内增加消费或抽窄导出，不造转发层；文件仍大，但拆分依据是职责而非行数。
- **新增深模块**：`evolution/src/capability-candidate.ts`（候选 schema/身份/prepare）、`evolution/src/capability-config.ts`（唯一 config.yml 行读写）、`task-runtime/src/recovery.ts`（恢复计划/重检/新尝试；driver 和预算仍调用既有实现）。三者都有生产消费者，删任一会使对应 capability 或 recovery 入口失败。
- **测试/夹具保留**：超过 400 行的 `a6-*.spec.ts`、capability experiment/candidate/promotion specs、recovery spec、既有 evolution/K1/provider specs 与 `tests/support/{assembly-stack,scripted-loop,promotion-experiment}.ts` 都是按公开 seam 的回归或共用 fixture，不是生产第二事实源。`evolution/tests/unit/fixtures/capability-experiment.ts` 只服务测试。
- **生成物**：`*/lib/index.js`、`*/lib/index.d.ts` 由最终 `pnpm build` 从 src 重建；不手改、不作为另一实现。

## 持久化与兼容

- Evolution ledger 仍为 formatVersion 4；实验报告仍为 formatVersion 3，无兼容壳。
- 新增/调整的持久事实记录已在 [capability table identity](../persistence-changes/2026-09-28-a6-capability-table-identity.md)、[recovery attempt](../persistence-changes/2026-09-28-a6-recovery-attempt.md)、[recovery binding facts](../persistence-changes/2026-09-28-a6-recovery-binding-facts.md) 及 sibling schema 中说明；`verify-persistence` 必须保持 4 roots 匹配。

## 必跑检查（最终树）

| 命令 | 结果 |
|---|---|
| `cd packages/singularity && pnpm build` | PASS，exit 0；14 个 workspace project 构建完成，tracked `lib` 与 src 同步 |
| `pnpm vitest run --project unit packages/singularity` | PASS，71 文件 / 2145 例通过，0 跳过 |
| `pnpm vitest run --project integration packages/singularity` | PASS，72 文件 / 565 例通过 + 4 门控跳过 |
| `cd packages/singularity && pnpm run verify-persistence` | PASS，4 event roots 匹配 `docs/persistence-schema.json` |
| `cd packages/singularity/agent-singularity && pnpm exec tsc --noEmit` | PASS，exit 0 |
| 两仓 `git diff --check` | PASS，均无输出 |

定向收尾已实跑：evolution unit 446/446；agent-runtime/agent-singularity/task-runtime 定向 unit 100/100；EVO-4 相关 integration 29 通过+1 跳过；四份关键 integration 最终 30 通过+1 跳过；多次 `pnpm build` 与 `git diff --check` 通过。最终全量数字以上表为准；公共检查全绿不覆盖 EVO-1 的真实效果失败。

## 模拟、未覆盖与解除条件

1. **阻塞整票验收的唯一效果证据**：EVO-1 L1+L2 均未取得合格真实 Agent 候选/独立验证/holdout/受控人审结果。解除需要用户重新明确授权一组符合第 14 项次数/时间约束的冻结案例；不得在本轮已耗尽的 L1 上追加第 4 次，也不得用 scripted 或手工候选替代。
2. 确定性测试只替代模型输出；Task store、Session、runtime、provider precheck、verifier、commit ledger、SIGKILL/重开均走真实模块。受控 approval 是自动化门测试，不称真人批准。
3. 通用 S4-E 服务历史上允许 opaque `sourceRefs`；本次成功源门只在当前实验 store 能解析到 Diagnosis 时判断 source Task/Run。A6 的模型工具/handoff 路径在更早处核对具体 diagnosis；未声称所有任意插件伪造的缺失 sourceRef 都由通用 evolution 服务独立封死。
4. 最终 integration 中门控 skip 的用例按测试输出如实保留；全量绿不替代 EVO-1 判决。

## 子代理分工

1. `a6_progress_audit`（GPT-6 Sol xhigh，只读）：逐 EVO 审计真实入口，复现成功源误应用、`evolution_list` 空值崩溃与 EVO-4 结算假绿；未改代码。
2. `a6_evo1_experiment`（GPT-6 Sol xhigh）：盘点中断产物、执行预算内 L2 真实 `step-5-preview`、固化原始轨迹/usage/manifest/判决；只改临时实验目录。
3. `a6_full_checks`（GPT-6 Sol xhigh）：在 `fcc0d07` 检查点独立串行跑六项公共检查，确认当时 build、2141 unit、563 integration、persistence、tsc、diff-check 全绿；不把它冒充最终树结果。
4. `a6_evo4_fix`（GPT-6 Sol xhigh）：只修 submitted 根结算前 ownership 顺序与真 SIGKILL 公开测试，留下 RED→GREEN；未提交。
5. `a6_capability_tools`（GPT-6 Sol xhigh）：只修 capability 公开工具消费者、模型可见文案、row-only rollback 与对应测试；未提交。
6. `a6_success_source_gate`（GPT-6 Sol xhigh）：只修成功来源在实验/晋升/apply 的服务重检及真实 store 反例；未提交。
7. 主代理：冻结范围、处理代理间交叉回归、汇总 guide/计划/记录、最终公共检查与内外层提交；不重跑超额模型实验。

## 最终结论与停止点

EVO-2～EVO-5 机制交付进入待验收；EVO-1 明确 FAIL，所以 A6 整票最高填**待验收**。不推送、不部署、不派下一票；完成内层提交和外层仅子模块指针提交后停止。

## EVO-1 候选入口定向修复与续验（2026-09-28）

原始四次实验及上文判决不改写。独立审计确认 L1/2 与 L2/1 的模型调用把 `mutation` 双重编码成字符串，typed-tool 在进入 Evolution 前拒绝；L2 原始侧车还缺必填字段与精确摘要，Skill 写死 fix 文件名。L1/1 是源根未形成预期失败，属于独立的实验来源问题。当前候选工具改为单一 `mutationJson` JSON 文本入口；新 Skill 仅提交语义声明，工具由正文计算 `content.skillMdSha256` 并固定版本、能力归属及 `resources: []`，再交现有 Evolution 校验，非法 JSON/自填派生字段零 ledger 写。旧 `mutation` 参数不再接收，K3 同名 Skill 调用者已同步。

定向 RED：新文本入口在交付版工具上因缺必填 `mutation` 被拒；GREEN：工具集成 8/8、A6 链集成 4/4、K3 集成 41 通过+1 跳过、装配单测 10/10。临时快照的 scripted L2 全链通过。原始 22G 快照搬到 `stack/harness-original-a6-20260928` 保留；新快照来自当前工作树，未覆盖旧 evidence。

同一冻结 L2 的第二次真实尝试 `evidence/l2-run-2` 使用免费 `step-5-preview`，墙钟 186.319s，42 请求/41 响应。真实 supervisor 先提交一份被现有 provider 校验拒绝的候选，随后自行提出新方案；第二份完成 candidate、prepare、双侧 experiment、gate。报告 `ledger/sandbox/sup-a6-l2-release-row-002/exp-d419fafac61fb49b/experiment-report.json` 中 fix/holdout 的基线均为 `not-admitted`，候选均为 `verified`；冻结判据 `ac-a6-l2-fix` 和 `ac-a6-l2-holdout` 均 pass，产物分别在该实验目录。模型声明 `maxTokens:400000`，但业务 Run 成本只有 toolCalls 等指标，没有 token 投影；`decide(PROMOTE)` 按既有 promotion 闸拒绝，零人审请求、零应用。模型可见预算说明已收紧：无 token 投影时不声明该可选上限。L2 第二轮证明候选与双侧验证已能实跑，**没有证明批准、应用与原目标恢复**；EVO-1 和 A6 仍待验收。L1 原三次不追加，不用脚本结果冒充真实通过。

同一冻结 L2 的第三次也是最后一次真实尝试 `evidence/l2-run-3` **通过 L2 效果验收**：`step-5-preview` 运行 267.799s，39 请求/38 响应，输入 88422、输出 18058、缓存读 348672 token。Agent 自行提交一条 capability 整行与新 execution Skill；沙盒 `SKILL.md` 的 SHA-256 `ecead6ef142cd86e0fd0b8360c6340d8edaa0793297854c036ee6fe89fc39d5a` 与其派生 sidecar 一致，正文按任务目标决定产物名，未写死 fix 文件名。`experiment.json` 的 fix/holdout 基线均为真实 `not-admitted`，候选均为 `verified`，冻结 command 判据分别 pass；本轮未声明无法核算的 `maxTokens`。受控 DSH 审批依次拒绝/允许 decide、拒绝/允许 apply；拒绝时无应用，最终只向临时部署写入行与 Skill。`run.json` 证明受保护生产文件前后摘要一致，`watchdogNudges: []`，所以夹具中发现的旧接口催促文案没有影响本次结果；该催促文案已为未来实验改成 `mutationJson`。受控 desk 是人审门的测试替身，不称真人批准。L1 原三次仍无合格证据，EVO-1 与 A6 整票仍 **FAIL / 待验收**；新 L1 冻结案例须另按合同明确授权，不能把 L2 成功或 scripted 接线替代为双案例通过。
