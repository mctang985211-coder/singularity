# 普通 Task 的自主分阶段、递归分解与模板发布：源码证据审计

日期：2026-10-06。范围：只读当前源码、已有测试及历史运行记录；未启动新模型任务、构建或仿真，也未修改线上配置。本文区分“运行时自撰 Task 实例合同”和“发布可复用 TaskTemplate”。

## 判断

普通 worker 已有入口生成下一阶段的自撰 Task、等待该批任务结束后再生成下一批，并允许子任务继续递归分解。因此不能把这项能力的不足归因于完全缺少架构入口。入口是 `task_decompose`，并非必须调用 Supervisor 或 Evolution。默认所有 capability worker 的基线工具包含它和 `task_template_list`；每次分解仍受当前任务身份、运行阶段、深度、批大小、能力与合同检查约束。[工具说明](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/task-decompose.ts:14)、[worker 基线](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/capability.ts:74)、[spawn grant](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/orchestration/spawn.ts:62)

“把探索成果变成新阶段 Task”已有脚本集成测试；“真实模型选择并递归执行已有模板”也有历史小规模证据。不过，现有证据没有证明真实模型在未知探索结果出现后自主创建多个新阶段，更没有证明其自主创作、发布并跨任务改进可复用模板。两类证据不应混在一起。[分阶段测试](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/k1-exploration.spec.ts:214)、[历史真实模型记录](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-03-live-task-growth.json:7)

## 1. 运行时 Task 生长已有机制

| 问题 | 当前机制与边界 | 直接证据 |
|---|---|---|
| 普通 worker 能否自撰下一阶段任务？ | 能。子合同可携带 objective、验收条件、能力、依赖和 decomposable；找不到适用模板时允许完整标准合同。 | [task_decompose 参数](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/task-decompose.ts:39)、[无模板绑定](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/task-template.ts:155) |
| 能否根据探索结果再分一批？ | 能。同一父 run 的批结束后恢复 active，可执行自己的工作、再准入一批，或提交自身结果。一个父 run 的多批串行；批内可声明依赖。 | [批结束行为](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/task-decompose.ts:176)、[active 检查](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/admission.ts:134) |
| 子任务能否继续递归？ | 能。默认允许运行时拆分，即使父最初把该子任务认定为 leaf；但不会突破绝对深度或批大小。 | [leaf 准入策略](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/admission.ts:180)、[默认开关](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/config.ts:165) |
| 能否分解别人的任务？ | 不能。当前 run 必须属于当前 task，且绑定调用者 session。 | [身份检查](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/admission.ts:117) |
| 能否一边子批执行一边父继续写/再拆？ | 不支持该模式。父在 waiting_children 期间不能写、bash、再次分解或提交结果；批结束后继续。 | [工具返回规则](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/task-decompose.ts:186) |
| 标记 decomposable 能否获得缺失能力？ | 不能。它允许把缺能力的复合责任留给下一层拆分；不会给当前 worker 凭空赋予缺失工具或能力。 | [缺能力检查](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/admission.ts:212)、[grant 收缩](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/grants.ts:69) |
| 是否必经人工审查？ | 动态子批默认 generatedTaskReview=off，按机器准入规则运行；资产晋升另有审查流程。 | [默认 review](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/config.ts:121)、[默认值](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/config.ts:161) |

工具确实被组装注册，而非只有类型声明。基线工具清单还包含 proposal 的 read/continue/cancel。是否最终暴露给某部署取决于组装与 grant；本审计确认当前源码装配注册了分解和模板列表工具。[注册](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/index.ts:202)、[基线 proposal 工具](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/capability.ts:84)、[未挂载工具边界](/home/ROXY/code/bb_work/harness/packages/singularity/agent-runtime/src/grants.ts:64)

机器准入检查包括非空批、`parent.depth + 1 <= maxDepth`、每批子数上限、完整合同、同批依赖合法与无环；未解决的阻塞问题也会拦截新分解。[结构护栏](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/admission.ts:233)、[合同与依赖](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/admission.ts:281)、[阻塞问题](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/admission.ts:140)

当前源码默认 `maxDepth=4`、`maxChildren=8`、`allowRuntimeDecomposition=true`。这里深度以 root=0 计，maxChildren 是**每批**上限；多批共享整树 run 预算，不意味着无限增长。[定义](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/config.ts:109)、[默认值](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/config.ts:165)、[root 预算](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/root-budget.ts:8)

用户原述 `.dsh/config.yml` 在本次检查中不存在；读取到的是仓库根 `config.yml`，不能据此声称已核验 live-loaded 配置。根配置给出 maxToolCalls=600、rootBudget.maxRuns=600，而上述三项只有注释，因此源码加载路径会采用默认值。[根配置](/home/ROXY/code/bb_work/harness/config.yml:180)、[运行时默认合并](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/runtime.ts:166)

根配置注释仍写“每条任务链一次分解”，与目前同一 run 多批实现和测试不符，应视为陈旧文档，不能据此判断不能分阶段。[陈旧注释](/home/ROXY/code/bb_work/harness/config.yml:195)、[同 run 再分批测试](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/tests/unit/proposal-recovery.spec.ts:313)

## 2. 自撰合同与可复用模板不是同一件事

`TaskContractInput` 明确接受完整合同，或带 digest 的固定版本模板加参数。没有 templateRef 仍可正常绑定自撰合同；模板库不是任务创建的唯一入口。[输入类型](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/template.ts:121)、[自由合同绑定](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/task-template.ts:155)、[无匹配模板提示](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/task-template.ts:302)

`templateScope` 约束模板引用范围，而不是禁止作者提出新任务。子 scope 只能继承或收窄，不能扩大；模板查询受同样边界限制；空 scope 仅可见 explicit general 模板。模板固定 objective/criteria 等完整合同，不能通过绑定参数之外的额外字段任意改写。[继承与收窄](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/task-template.ts:158)、[模板合同禁止覆盖](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/task-template.ts:180)、[模板可见性](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/task-template.ts:239)、[工具描述](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/task-template-list.ts:33)

可复用 `TaskTemplate` 是另一类资产：不可变版本、digest、完整合同，并可含直接子任务的 decomposition recipe。服务提供 `registerTaskTemplate`，以 `<id>@<version>.json` 排他写入，同版本同内容可重复注册，同版本冲突拒绝；这不是普通 worker 的注册/发布工具。[模板类型](/home/ROXY/code/bb_work/harness/packages/singularity/task/src/template.ts:100)、[注册实现](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/task-template.ts:104)、[服务接口](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/service/runtime.ts:233)、[普通 worker 工具清单](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/capability.ts:74)

受治理的模板创作/升级入口是 Evolution 的 `targetType=task_definition`。它支持无既有 baseVersion 的第一个模板版本；候选必须是完整模板、已有模板必须追加版本，修改子验收要给 criterionRepair 和原独立 oracle；既有任务合同与 binding 保持固定。最终生产 apply 要有 PROMOTE 决策，并获得该次精确生产写入的人类批准。[目标类型与完整流程](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-propose.ts:25)、[新模板](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-propose.ts:37)、[候选校验](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/task-definition.ts:89)、[验收修复](/home/ROXY/code/bb_work/harness/packages/singularity/evolution/src/task-definition.ts:99)、[生产批准](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/evolution-apply.ts:94)

Supervisor baseline 包含这一套 Evolution 工具，普通 worker baseline 不包含它。因此普通 worker 的常规动作是创建任务实例、把可复用经验交给具备 Evolution grant 的角色形成资产候选，而不是直接通过 baseline 发布模板。不能把这一点绝对化成操作系统写权限限制：worker 本身有 filesystem/bash baseline，未经治理地写库文件和受控模板发布是不同问题。[Supervisor grant](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/coordination/handoff-rules.ts:14)、[普通基线](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/capability.ts:68)

## 3. 测试分别证明了什么

### 脚本集成：探索后实施的多批机制

`k1-exploration` 的测试脚本先提出 survey batch，取已验证调查产物的 evidenceId，再据此构造 implementation batch 的 requiresArtifact，最后父任务提交自己的结果。两批成员累计，父合同验收原文保持不变，全程没有 diagnosis/Evolution 调用。[测试明确标注 script](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/k1-exploration.spec.ts:215)、[第一批与第二批](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/k1-exploration.spec.ts:225)、[消费探索证据](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/k1-exploration.spec.ts:280)、[累计成员](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/k1-exploration.spec.ts:311)、[冻结父验收](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/k1-exploration.spec.ts:352)

这证明生产循环、工具分发、证据引用和批恢复机制可以走通；**不证明真实模型会自行选择这个流程**。本审计未运行测试；主审计代理 2026-10-06 报告定向复验该 test 正常通过，1 passed / 15 skipped。该复验依然是脚本集成，不能升级成真实模型自主性证据。

单元测试还覆盖普通 leaf 自行拆成 depth=2 的两孙任务、maxChildren 拒绝、关闭 runtime decomposition 时 leaf 拒绝，以及同一 run 第二个 batch；这些是机制边界证据。[递归单元测试](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/tests/unit/decomposition-orchestration.spec.ts:831)、[批大小与开关](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/tests/unit/decomposition-orchestration.spec.ts:881)、[第二批测试](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/tests/unit/proposal-recovery.spec.ts:313)

### 历史 live：真实模型递归和复用已有模板

`2026-10-03-live-task-growth.json` 记录模型 `deepseek/deepseek-v4.1-flash`、passed、两个输入分别 38 和 36 requests，两棵图都有 depth=2、依赖边、至少两个模板实例及 verified 结果。[记录元数据](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-03-live-task-growth.json:5)、[第一案例](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-03-live-task-growth.json:29)、[第二案例](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-03-live-task-growth.json:93)

不能只因 fixture 名叫 `startScriptedLoop` 就否认它是真实模型：该测试的 script 为 `()=>[]`，随后覆盖 `llm/stream`，向上游 `/v1/chat/completions` 发真实请求，把模型返回的 tool_calls 交还运行循环；read/write 工具执行真实文件操作。[空脚本](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:44)、[真实模型调用](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:82)、[tool_calls 回传](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:103)、[真实文件工具](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:49)

但任务输入已经明确要求 root 协调 transformation 子责任，由其 worker 选择可独立验收的转换子任务；现有 transform 模板提供 squares/absolute 两子 recipe，四个模板均由测试预先注册。完整树不是脚本直接发送给模型，然而递归方向有明确题目与模板提示。[预制模板和 recipe](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:26)、[测试注册模板](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:77)、[root 任务输入](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:116)

其断言检查 d2、依赖、模板实例、合同、guidance、scope 隔离与原 checker 通过，没有同一父 run 多 batch、探索发现触发下一阶段、模型创作并发布模板、或改进后迁移新任务的断言。JSON 也仅保留图摘要与请求数量，缺少完整决策轨迹。因此最准确描述是**真实模型在明确任务与可用 recipe 提示下完成递归执行，并在两个简单数值输入上复用已有模板**；这不是开放式芯片架构探索或 RSI 闭环实证。[断言](/home/ROXY/code/bb_work/harness/packages/singularity/tests/integration/live-task-growth.spec.ts:126)、[记录局限](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-03-live-task-growth.json:148)

### graph4：真实运行的分层，不足以单独证明探索驱动的多阶段

本轮 root 指令允许在 `[[bb]]` scope 内参考 35 个模板，未匹配时写完整标准合同。运行叙事记录了 7 个一级任务，以及若干 d2/d3 递归分支，因此实际芯片任务中的递归并非只有测试夹具。[root 指令](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/root-prompt.md:28)、[初始图](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/evidence/progress-log.md:173)、[后续分解](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/evidence/progress-log.md:253)、[另一分支](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/evidence/progress-log.md:332)

日志还有发现 full RTL 不可行后问答与分区执行改变的记录。这证明执行过程中发生适应，但仅凭这些段落不能证明“同一父 run 根据开放式探索结果新建多轮 Task batch”，更不能证明模板资产经晋升并改善下一轮。[执行调整](/home/ROXY/code/bb_work/cv-fullstack-run-2026-10-05/evidence/progress-log.md:465)

## 4. 缺口归类与最小增强

1. **架构入口已存在。** 不需要为普通 worker 再发明一种“探索任务”或新的递归 API。应复用 self-authored Task contract、现有 batch、依赖与不可变父验收。
2. **有效规则可见性需要改进。** `templatesFor` 实际消费 `allowsRuntimeDecomposition()` 来决定是否自动投影可见模板目录，并提示无模板可自撰合同；并非只有孤立 interface 声明。但该提示没有按当前 leaf/depth/phase 给出有效 canDecompose 判定及拒绝原因。worker 稳定 prompt 的主动阶段分解指引由主审计负责展开；旧测试/注释里的丰富 effective-rule context 不能当作当前提示已投影的证据。[目录自动投影](/home/ROXY/code/bb_work/harness/packages/singularity/context/src/index.ts:191)、[工具规则](/home/ROXY/code/bb_work/harness/packages/singularity/agent-singularity/src/tools/task-decompose.ts:14)
3. **真实多阶段示例仍缺。** 最小补证应让真实模型先调查未知瓶颈，必须引用第一批 evidence 才能提出第二批候选；保留每批合同、提出者、理由、调用轨迹和原验收，禁止测试脚本替它选方案。
4. **可复用资产改进应另立成功条件。** 让具备 Evolution grant 的角色从任务实例抽出模板/skill/tool 候选，经 replay/gate/decide/apply 晋升，然后在未见过的任务实例上验证收益。普通实例创建成功、现有模板复用成功、芯片性能提升，都不能独自替代这条链的证据。
5. **并行提升应有资源与隔离边界。** 当前 root budget 只支持一个并发写者；同父批串行也是明确协议。任务树中的多个节点不能直接等同于并发芯片构建。应先用隔离 checkout/工作产物和可调资源仲裁补足测量实验并行，再讨论解除单写者限制。[单写者预算](/home/ROXY/code/bb_work/harness/packages/singularity/task-runtime/src/root-budget.ts:8)

芯片性能 demo 的具体工作负载、现有测量链与当前证据边界，见独立[芯片性能来源审计](/home/ROXY/code/bb_work/harness/packages/singularity/docs/2026-10-06-chip-performance-demo-source-audit.md)。本文没有声称已经完成任何新的 RSI demo。
