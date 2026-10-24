# 改进指南实施与离线验收对照

2026-10-24。适用版本：Task v27、Review v8、Strategy v10、Measure v6、snapshot v15，仅用于新图。本页是[优秀 Singularity 改进指南](优秀singularity改进指南.md)的实施记录；生产行为从[当前架构](architecture.md)进入。

指南中的代码、接口、Prompt、工程治理及离线验收修改已经落实。真实模型行为实验现已按用户后续要求准备启动，范围仅为本次指南验收；独立 pilot、正式研究对照和跨机器实跑仍暂不执行；这些项目的结果不能由离线测试替代。未宣称方法收益、迁移收益或论文结论。

## 修改与验收对应

| 指南章节 | 实施结果 | 验收与权威来源 |
|---|---|---|
| §5.3–5.6 递归交付 | 普通父 Task 与 root 均可引用准确 verified direct-child Run；复制封存字节，父级重新独立验收；多结果使用声明 artifact inputs 的 integration child。保留所有未结算子节点暂停父执行的规则，并明确成本。 | [submission](../assembly/src/submission.ts)、[recursive-delivery 测试](../assembly/tests/recursive-delivery.spec.ts)：二/三层大文本和二进制、冷恢复、工作区篡改、多输入集成、错误/缺失/未通过/非直接来源、父级失败与祖先重复责任反例。来源、字节和权限由宿主保证；内容标准由独立验收判断。 |
| §5.7 原子性判断 | 实现前做有界判断，摸底后只重新判断一次；动态 next 区分初始判断、等待和协调交付。单一产物不等于原子责任；不设树深或拆分率目标。 | [prompts](../assembly/src/prompts.ts)、[coordination](../assembly/src/coordination.ts)、recursive-delivery 的原子任务与祖先重复反例。模型实际决策质量留给行为实验。 |
| §6 ambient Skill | 删除内部 preset 的 filesystem provider；每个会话隔离原生 SkillRegistry，只注册 pinned Method provider；未绑定、同名外部内容不能混入；等待时目录为空。 | [method-run](../assembly/src/method-run.ts)、[完整 preset 测试](../assembly/tests/root-tools.spec.ts)、[method-context](../assembly/tests/method-context.spec.ts)、[method 冷恢复测试](../assembly/tests/method.spec.ts)。绑定、digest、消费和 caliber 仍按原冻结身份处理。 |
| §7 memory | `{}` 只列目录；`{prepare:true}` 显式准备一次并直接返回正文；`{ref}` 读取已有 checkpoint。root/review 无 prepare；显式 RSI predecessor 给出调用入口；失败持久化且不重复购买；无第二个 store。 | [driver-execution](../assembly/src/driver-execution.ts)、[memory-view](../assembly/src/memory-view.ts)、[memory-native](../assembly/tests/memory-native.spec.ts)、完整 preset 测试。review 不得读取被审对象叙述。实际消费与收益未作推断。 |
| §8 问答与拒绝 | 工具说明列出缺输入、权限矛盾、能力缺口和合同冲突的升级场景；阻塞问题结束 turn；原生问题通知带 answer 调用卡；解释 resolves/requestKey；拒绝返回 ok:false、原因、detail 和按角色可执行的 next。 | [coordination](../assembly/src/coordination.ts)、[agent](../assembly/src/agent.ts)、[coordination 回归](../assembly/tests/coordination.spec.ts)。准确父子 Run、权限、幂等、阻塞与恢复由宿主执行；回答不改合同。 |
| §9.1 read | template 列表含 entries/total/nextFrom/complete；review/improve 的 Method 默认分页，4096 字节、上限 8192；UTF-8 边界可重组；dispatch 有按身份读取卡；解释 artifact 默认 Run 选择及 sealed 与 verified 的区别。 | [read](../assembly/src/read.ts)、[pages](../assembly/src/pages.ts)、[inputs](../assembly/tests/inputs.spec.ts)、[lifecycle](../assembly/tests/lifecycle.spec.ts)、method-context 的大 Method 反例。trajectory index 只提供索引，判断仍需事件页。 |
| §9.2 submit 与 evidence | path 逐字复制冻结 artifact；说明同步等待验收及子通过不能代替父验收；review pass 必须有证据或匹配的保护 pass，空证据不能建立语义成功。 | agent、submission、[review](../assembly/src/review.ts)、[review 反例](../assembly/tests/review.spec.ts)。结构化事件引用由宿主校验冻结范围；字符串引用保持语义引用的强度。 |
| §9.3、§9.5 分解、stop、retry | 说明稳定 key、真实依赖、supports、固定 maxRuns、required/exploration、显式绑定、共享预算与暂停代价；返回 next；stop/retry 说明 ID 来源、适用条件和后续动作。 | agent、[surfaces](../assembly/src/surfaces.ts)、scheduler 与 decomposition/coordination/agent-face 回归。无额外计划文件或原子性审批。 |
| §9.4 Method Tool | 新增 Tool 必须有简短 description；旧冻结资产保持身份；运行目录送达用途、call、candidatePath；明确 artifact 字段是 stdout 文本。 | [method](../assembly/src/method.ts)、method-run、[rsi-proposal 反例](../assembly/tests/rsi-proposal.spec.ts)。未绑定工具仍拒绝；原生工具和公共 CLI 无需 Method 绑定。 |
| §9.6 原生工具 | 内部 preset 删除 present。分解、阻塞问答和封存屏障前检查在途工具及运行/停止中的自有 jobs，先收集或取消；等待时保留 job_list/job_kill，隐藏 job_output 与不适用说明。网络仍按领域合同限制；Bubble 提权拒绝保持。 | [execution](../assembly/src/execution.ts)、[execution 回归](../assembly/tests/execution.spec.ts)、完整 preset 的等待态/清理回归、[bubble-approval](../assembly/tests/bubble-approval.spec.ts)。后台 job 不形成 Task 交付或验收。 |
| §10 统一能力与上下文 | 一份角色/状态策略决定注册约束、请求工具、原生 sections 和执行准入；jobs section 显式关联三个工具；未来宿主工具默认不可见且不可执行；目录受固定 Skill provider 控制。 | [tool-policy](../assembly/src/tool-policy.ts)、agent/index/driver-execution、完整 preset 的四角色与 root/Task 等待态检查、review 证据等待态回归；[上下文审计](context-governance.md)保留完整来源与真实请求测量入口。 |
| §11 状态与验收语义 | 保持五项独立结果投影、review-inconclusive / infrastructure-failure、保护非 pass、结构化轨迹证据与宿主冻结数值；未增加状态机或评分器。 | [rsi-state](../assembly/src/rsi-state.ts)、[native-solve](../assembly/src/native-solve.ts)、async-rsi/native-solve/review/evaluation-cost 等回归。具体进入、退出条件和事实来源见当前架构。 |
| §12–13 离线验收 | 完整装配所有 shipped preset 插件；递归交付、等待态、Skill、memory、问答、jobs、来源与独立验收均有离线行为反例。 | `pnpm verify`：严格类型、构建、98 个 spec 文件、1084 项测试、8 项 gates、上下文/真实 tarball/文档审计。模型选择、消费率和完整任务收益留给显式实跑。 |
| §14 工程与制品治理 | 保持 core/native/实验分层、ESLint/Prettier、公开 core CI、私有宿主摘要、文档身份、旧实验只读 fixture、private/UNLICENSED 与第三方通知；预注册、源码/dirty/锁/宿主/请求/原生证据封存及 SHA256 重放工具已交付。 | [工程收尾](nonrun-completion.md)、[研究工具](../research/README.md)、[experiment](../tests/experiment.spec.ts)、[原生证据导出](../scripts/evidence-export.mjs)、context/distribution/docs 审计。没有改动公开许可或触发远端 CI。 |
| §15–17 研究纪律与边界 | 已实现研究合同校验：真实来源与 family/split 隔离、独立 pilot 要求、比较臂和主张匹配、固定预算/顺序/缺失规则、heldout 前冻结及可复验制品。没有编造 pilot、样本量、独立 family、费用或迁移结论。 | [研究合同与操作说明](../research/README.md)。真实独立 pilot、H0/强基线/消融、跨机器复验属于实跑项目，本次暂缓。 |

## 离线验证记录

最终工作树的完整 `pnpm verify` 已再次通过：98 个测试文件、1084 项测试及全部工程审计，包含按角色拒绝提示与等待态回归的补充。离线 provider fixture 不产生付费模型调用。

另在显式选择的外部 NPBench 环境完成领域复验：三个真实上游 nopython 实现（hdiff、nbody、lenet）通过；错误输出、语法错误、私有文件读取、缺失 protected input 均被正确拒绝。此检查验证领域评分和隔离，不比较方法收益。原环境没有 verify.mjs；没有把 `verify:domain` 的 SKIP 当成通过。新日志保存在 `/home/ROXY/code/singularity-evidence/guide-domain.log`，原始结果在 `guide-domain-20261024/smoke.json`，历史结果未覆盖。

持久验证日志在 `/home/ROXY/code/singularity-evidence/`。指南离线实现阶段日志为 `guide-verify-offline-complete.log`；成本修复后的全量复验为 `rsi-cost-verify-20261024-final.log`。此前真实模型 runner 在用户明确“实跑暂不要求”后已停止；启动失败和中断记录保留在 `guide-live-20261024-a` 与 `guide-live-20261024-b`，不作为完成的行为实验或效果证据。

## 2026-10-24 成本策略修复与实跑恢复

按用户后续要求，成本改为已记录用量的简单加法，包含中断、失败和取消任务的已记录部分。缺少最后一个 provider usage 样本只影响审计完整性，不能让已有总数变成 null。候选选择、成对报告、search outcome、基线复用与发布流程均不以成本完整性或成本增幅设门禁；质量缺测、噪声带、保护检查及独立审核继续生效。质量持平时的已记录成本下降仍可支持改善；成本缺失或增加不再否决质量收益。版本更新为 Strategy v10 / Measure v6 / Review v8 / snapshot v15，旧图保持只读。

回归覆盖：中断取消 Run 的已知 token 保留；同一业务求解中部分会话缺样本仍累计其他会话；试次和 case 的已知费用累加；零基线、未知或超出旧上限的成本不阻止质量更好的方案获胜；成对质量改善不受费用覆盖率影响。旧 NPBench 服务已按用户要求停止，启动范围仅为本次指南行为验收实验。

成本修复后的 `pnpm verify` 已通过：98 个测试文件、1084 项测试、8 项 gates，严格类型、构建、格式、上下文、真实 tarball 与文档审计均通过。试次缺少质量观察时仍保留已记录成本，且不把质量缺测变为通过。
