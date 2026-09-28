# Buckyball × CosyVoice2：自由生长实跑合同

本票的目的，是用真实 Buckyball 设计任务检验 Singularity 的 **Task 固定目标与验收、节点自行生长、Skill 按需读取、工具给出事实**。不要预先创建“模型→chip→Ball→验证”的节点图，不指定子任务数量、层数、顺序或角色。旧插件只供查已有代码和判据，不能把其 CI/PR 工作流搬进本图。

## 固定的目标，不固定做法

首个 root 仅解决一个真实切片：使 [固定官方来源](../history/2026-09-28-cosyvoice2-slice-source.md)中的 CosyVoice2 flow encoder `PreLookaheadLayer` 无 context 推理，以官方 `flow.pt` 对应权重和冻结输入 `[1,25,512]` float32，在 **Buckyball 的 BEMU** 中运行并输出完整 `[1,25,512]` 张量；冻结的独立判据与官方 PyTorch 参考比较全部元素和边界位置。这个目标不宣称整套 CosyVoice2、RTL 或新芯片完成，也不预先要求新 Ball、新 chip 或任何特定算法映射。若现有 CPU 路径能达到目标，应如实标出 Ball 加速为零；若无法导入、构建或仿真，应留下真实失败，不能改验收题。

后续是否需要芯片拓扑、专用 Ball、编译 lowering 或 RTL，由实际切片证据和新的目标决定；它们不是本票预生成的子节点。根节点和子节点都可以在自己的 Task 内选择实现，也可在出现**独立可验收的结果边界**时调用 `task_decompose`，让子节点继续作同样决定。允许不同的合法任务图；成功不能以命中预设形状为条件。

| 内容 | 本实验的归属 |
| --- | --- |
| Task | 根目标/不可变判据和节点运行中提出的独立子目标；不把工具调用或 skill 名变成任务 |
| Skill | Buckyball `.agents/skills` 中的 `chip-designer`、`ball-align`、`check`、`verify`、`waveform` 等按需指导，以及部署的 `bb-pipeline`/`bb-obligations` 提问清单；不决定任务顺序 |
| Tool | Buckyball checkout 的 `bbdev` MCP 提供构建、校验和仿真事实；旧 `legacy-harness-plugins` 的索引/audit 代码仅作参考，未装配就不得假称工具可用 |
| 环境 | `env-builder` 管隔离检出与 session 绑定，不拥有 Task 或验证结论；Singularity 持有 graph、TaskRun、Review 和判据 |

旧插件的 `verify-runner` 直接调用 CLI 并预设 CI/PR 流程，和本部署的本地 MCP 验证面不同；不迁整包。`workload-audit` 只做目录与交接文档静态审计，即使返回 ACCEPT 也不能替代完整张量比较。

## 实跑前冻结夹具（试验部署工作，不是 Agent 的任务图）

1. 用全新隔离 graph/env 克隆 Buckyball，**在运行前锁定可从该克隆取得的 commit**，记录实际 checkout、所有相关 gitlink 与工作树摘要；不复用当前有既存修改的本地检出，也不把远端默认 HEAD 当成本地 HEAD。graph 的 `repos` 是 `owner/repo`，setup 负责 checkout 并 `env_register_component`。本地 Buckyball `.agents/skills` 是 git submodule；初始化它，并把本次选定的领域 skill 与 `bb-pipeline`、`bb-obligations` 放到 **env 根的 `.agents/skills`**，记录字节摘要。运行 cwd 在 env 根，skill 搜索不会向下发现仓库内同名文件；须用 `capability_list` 与 Run binding 检查实际 provider/skill 来源。缺失或版本冲突即停止，不默默用用户全局同名 skill 代替。
2. 锁定 CosyVoice 源码 commit、官方模型 revision、`flow.pt` SHA-256，核对权重能加载到该层。冻结非退化输入、提取出的参数、官方 `eval()` 完整输出、shape/dtype、预先选定的数值容差和独立 checker。官方权重若无法取得或与源码不匹配，报告 fixture 阻塞；固定种子随机权重只能改称“算子探针”，不能冒充模型切片通过。
3. checker 必须在根 `task_intake` **之前**固定，并做至少一个坏输出反例：改动一个输出或把 BEMU 失败伪装成成功时返回非零。它直接核验权威 bbdev `trace_id` 的终态与实际 BEMU 输出，再比较完整张量；拒绝仅凭 agent 写入的 `passed` JSON、日志摘要、文件存在或测试源中的自报。checker、黄金输出、输入和权重身份作为根判据的 `protectedInputs`。工作节点不得修改它们；字节漂移由运行时拒绝。
4. 在临时部署确认 `bbdev` MCP 可启动，`capability_list` 中实际存在所需能力；长构建/仿真由节点经 MCP submit 并轮询 `bbdev_task_status` 至终态，根命令只复核终态证据，不能重跑构建。当前 `verifyTimeoutMs=600000`，checker 本身须在此时间内结束。若希望观察自然失败后的诊断/候选，临时 profile 显式设置 `evolution:on` 并保留 DSH 审批；当前默认 off。不要为制造自进化轨迹而人为制造失败。

## 给真实 root 的唯一用户目标

> 在当前 Buckyball 环境中，完成 CosyVoice2 `PreLookaheadLayer` 无 context 推理切片：使用本图已冻结的官方源码、权重、输入和独立验收，使 BEMU 实际运行并产生通过完整输出比较的结果。先用 `task_intake` 接受这一目标和提供的不可变根判据。你可依据现场证据决定是否分解、生成什么子 Task、选择现有 chip 或新设计、读取哪份 skill；每个子 Task 都须有自己的真实验收，且可以继续分解。请用 `capability_list` 确认授权，使用 Buckyball 的 MCP 获取构建/仿真结果。若发现无法完成的能力或输入缺口，如实记录并使用运行时的求助/诊断机制；不得弱化根判据、手写成功状态或为了展示图而拆分。

根合同由试验控制端随用户消息提供：一个 mandatory 的独立 command 判据执行预先冻结的 checker，并声明上述 `protectedInputs`；可以另加 composite 判据观察子任务结算，但不能以它取代独立判据。不要让 root 模型自行编写根 checker、选择通过阈值或改动官方输入。仓库路径以 setup 实际记录为准，判据命令从 env 根进入其 checkout 后运行。

## 验收本次实验

- **功能 PASS**：真实用户消息 → root `task_intake`；同一 graph/store 的任务与实际 BEMU 工具轨迹可追踪；根 `task_submit_result` 后独立 checker 在冻结输入上通过。若只有 host CPU/JIT 对照，没有 BEMU 输出，不能判本目标 PASS。
- **自由生长已观察**：原始会话显示节点因具体证据自行提出可验收子目标，子节点可继续分解，能力由配置授予而 skill 正文由节点按需读取；没有预置子任务脚本。若根单节点完成，功能可以 PASS，但“节点生长”仍未被这一轮证明；下一轮可扩大真实目标与独立判据，不能为了凑图改本轮判据或强制加孩子。
- **失败也有价值**：准入拒绝、真实构建/仿真失败、数值不符、模型停止或审查未通过都保留原始轨迹及旧事实，按所停边界判 FAIL/INCONCLUSIVE。不能把脚本模型测试、不同 Run 的局部成功拼成一条纵向成功。若自然产生 Diagnosis/Evolution，另核对候选来源、双侧验证、受控审批和 `task_recover`；没有发生就不宣称自进化闭环已实跑。

交付只需：固定夹具清单及哈希、根合同与原始会话、动态 Task 图与创建原因、skill/provider 绑定、bbdev trace 与 checker 原始结果、最终判定。不要为本实验新增编排器、固定 task 模板、兼容层或旧插件整包。
