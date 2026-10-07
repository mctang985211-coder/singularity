# 当前 RSI 协议与本轮优化（2026-10-07）

本说明描述当前源码中的协议；历史自动 review-scan、evolution-handoff、agent task_recover 已删除。平台 RsiLoopDriver 是图的唯一自动开轮者。此轮修改没有重启现场服务，也没有改已有图、原 Task 合同或生产 Skill。

## 最新现场推动的改进

2026-10-07 16:13（Asia/Shanghai）的最新只读快照中，graph11 的 3 个根 Run 均已 verified，图已 done。方法 v8 已完成实验与发布，第 3 轮 Run 的 proposalIds 引用 `prop-sha-stream-r4-frontier-v8`，冻结的 guidance Skill contentDigest 从前两轮的 `74d41a...` 变为 `fa7abb...`。这证明了发布、新绑定与后续业务验收的连接。

第三轮提交明确保留第二轮 RTL：3456 cycles / 10744 generic cells / 1032 FF，score 约 3.357；本轮增加 R=5/R=6 越过 cell 上限的真实测量、价格探针与拒绝理由，没有新的可交付 RTL 提升。这是有效负结果，不能将图的 done 或方法发布算成每轮质量增长。现场还留下第一轮 prepared 的 v7 候选；新驱动要求本轮可执行候选明确结案，但不回写历史提案。

该实验四侧均 verified：observed score 2.3890→2.7254，约 +14.1%；候选侧工具调用 82/83，对照侧 62/52，故不是 agent 成本下降的证明。它使用 Yosys generic cells，不证明物理面积或时序。case-a 参与过候选形成，只提供既有任务的回归证据，不能算干净的未见 holdout。需用未参与候选形成的新任务验证迁移，并报告全部探索开销。

旧驱动开第 3 轮时仍携带全部 7 个成功子任务复用，第三轮没有新开子任务。新源码在方法 improve 轮明确传 `reuses: []`，不再自动沿用旧成员的验收事实；失败 recovery 继续允许无影响的成功成员复用。图的 workspace 仍会延续，不能把新成员执行称为干净起点实验。该变化只影响更新后的 driver 新开出的 Run，不改写已完成的第三轮。

## Task、模板与 Skill

- **Task** 是固定目标、输入、结果归属、验收和 requiredCapabilities 的实例。
- **TaskTemplate** 是参数化可复用合同，可附直接子级的分解 recipe。
- **Skill** 是执行、调查、分解和检查的方法，须保留适用条件与反例，不替代 Task 验收。
- **Capability** 绑定 required Skill、工具/MCP、preset 和权限；preset 是工具组合，不是新的业务角色。

模型先查 `capability_list` 和 `task_template_list`，读完整合同与 appliesTo。合适时使用精确 templateRef（id/version/digest）与参数；不合适时直接写完整的一次性合同。准入不会把它自动写进共享模板目录，也不要求为了执行一个 Task 先出版模板。

运行后，worker 在提交 summary/artifacts 中保存有复用价值的发现，附 Task/Run、batch、evidence 和失效条件。Supervisor 读取实际任务树、Review、Diagnosis 与资产字节，选择值得提炼的 TaskTemplate 或 Skill 候选，沿既有 Evolution 链实验和发布。没有新 draft registry 或审批 agent。

普通 worker 没有共享资产发布权限；模型自撰合同与模型提炼共享模板是两步。当前实现提供了这条路径的工具与提示，不保证每次运行自动找到有效模板，也不会把每个 Task 强制变成模板。

graph11 的 case-a..d 使用已注册 `sha-design-evidence@1` 模板，case-e/f、整合与 root 使用自撰合同。这是模板与临时合同合理混用的实例；未发现该模板由 graph11 自动出版的证据。应提炼重复的 case 合同和已验证决策条件，不把整个历史四批流程固定成必须照搬的树。

## 审核与验收的层次

1. TaskRuntime 准入检查合同与能力，冻结 Run 绑定。
2. root/worker 完成业务工作，所有业务子代理委派使用 `task_decompose`。
3. verifier 对原 Task 的 mandatory criteria 独立验收。自检与 supervisor 草案审核都不替代它。
4. supervisor 比较可复用候选：propose → candidate → prepare → 双侧 replay/holdout → gate → decide → apply。
5. evaluator 判两侧质量/成本关系，保存固定输入、输出和证据；它无执行者对话和工具，但不要求不同模型。
6. 后续独立执行绑定发布的确切版本并验收，才能证明消费与效果。

首版 TaskTemplate 也使用已有 task_definition 链，不需另建出版入口。候选带参数 schema 与固定原始验收；recipe 实验必须执行真实直接子分解，并保留独立父级结果 oracle。新模板出现在目录供新 Task 绑定；已有 Task/Run 的定义不变。

## 角色与委派

root 是目标与总结果负责人；parent 是协调自己结果的 worker，leaf 是无子级执行的 worker。reviewer 做按需只读调查；supervisor 改进方法；driver、verifier、evaluator、HITL 是平台服务。repair、proposal、experiment 是阶段或记录，不是额外 agent。

worker 保留 preset 的调查工具时，原生 `subagent*`、`workflow`、`ralph` 不再进入 grant，执行 guard 同时阻止本地注册绕过。显式 capability 请求这些委派工具会被具名拒绝。这个限制覆盖支持的 DSH 原生工具名；自定义改名的第三方工具仍须在部署中审查，不能据此宣称封住任意进程执行。

setup 仍是 root 负责的准备阶段，不属于业务 TaskRun：`graph_spawn` 只允许 root，使用文件、命令、jobs 和组件注册的窄 grant，无业务合同/共享发布/递归委派工具；`graph_mark_ready` 只由 root 完成。setup 仍不是业务预算的一个 Run。

协调 binding 从已有 claim 保留 role 和 exact source Run；supervisor 上下文准确标明方法监督，避免误标成 reviewer 或误读新一轮的 Run。无需增加持久事件。

## 轮次结案与控制

`iterationRounds=N` 表示最多 N 次业务执行，包含原始执行；相邻执行之间最多 N−1 次方法改进机会。最终轮保留实际业务结局：最后失败不显示成功完成，也不强制做一次无人消费的末尾发布。

- 可执行候选（Skill、TaskTemplate、capability）都必须明确处理；一个 proposal 结束不能覆盖同轮其他必要候选。
- 已应用候选由平台携 proposalIds 开下一轮。
- 无合理共享变更且无未处理可执行候选时，supervisor 可以返回 fenced JSON `{"outcome":"no_change","reason":"..."}`；这表示有效负结果，不能当方法进步。
- 未完成候选在提醒上限后记录 blocked，不以空发布假装完成。runtime_policy 等本构建不执行的研究建议不堵住正常结案。
- 清除或替换 RSI 配置会使旧 state 失效；开轮前重读启用与配置，旧 watcher 无权继续开轮。这撤销调度权限，不强制中断已运行 supervisor，也不撤销已经发生的发布。
- 开轮报错后先查 request key 对应事实，区分未写入的准入拒绝与已记录的失败 Run。

图的 model+rsi PATCH 通过一个预检与事件事务提交，非法 RSI 不再留下已改变的 model。设置 RSI 清 progress 后继续同一个冻结目标，不创建新学习 epoch，也不替换 Task；新目标应创建新图。

## 简洁性与剩余限制

现有事实层、执行层、方法层分工已足以实现受控资产 RSI。优先统一委派、结案与消费证据，避免增加常驻角色、第二调度队列或草案数据库。目录选择是模型工具策略，不是强制模板匹配器；提炼质量仍需真实任务验证。

root 仍保留经授权的手动 Evolution 工具，自动轮的 supervisor 是唯一自动方法负责人；后续可进一步约束手动和自动发布的并发。协调预算与轮数尚未联合预检，完整树 token 成本口径也需另行核对。不要把有限实验、发布、一次绑定外推成长期自增强。

本次保留图设置的 create/set/clear/reopen 与 HTTP 回归，增加结案、停止、fresh improve 和模板发布后消费的行为验证。脚本模型测试证明协议控制，不代替真实模型自主找到改进的证据。

## 验证与交付

整个 13 包工作区构建通过，最后的 root 提示和 driver 修正后再次构建 agent-runtime、agent-singularity。graph-web 类型检查通过。联合定向测试 23 个文件、388 项全部通过；持久 schema 的 4 个事件 roots、476 个源码文件大小检查和 `git diff --check` 通过。未执行全仓测试。

新增完整链路回归在同一场景中通过真实 supervisor claim、Evolution 工具、4 个双侧实验 Run、gate/decide/apply 和 native 审批记录发布首版 TaskTemplate，随后由 driver 开恢复轮，新 child Run 的精确模板 id/version/digest 与 prepared/published 一致，原父验收通过，旧合同与 Run 不变。模型与审批回答为测试预设，其余关键运行和发布服务是真实实现；它证明链路可执行，不证明自主发现或泛化收益。
