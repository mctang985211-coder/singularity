# 2026-10-23：节点提示、环境准备与 RSI 的简化审查

修改基线为 `ddebbb3`（先保存用户工作区的 checkpoint）；当前 Task v24，只接纳新图。旧实验保持原样，不用新代码回放旧图来改写结论。

## 真实问题在哪里

取证目录：`/home/ROXY/singularity-next/convergence-audit-20261023/`。`workflow-report.md`、`workflow-root-inputs.json`、`workflow-tool-calls.json`、`runtime-session-table.json` 可交叉核对原生事件、控制事实、合同和成本。该审计没有续跑或改写原实验。

- chip r2 根 `task-99125d74346964c8` 在整图 1024 步耗尽后失败：root 40、实现 708、独立审核 276。已经有六个 verified child，最高局部质量 5.888390，却没有 root submit，也没有 root acceptance。
- root 自行追加“严格超过当前最好”和“至少三个成功变体”，把有限探索变成只能正提升才能结束的合同。一个质量已提高的候选还因变体数量不足重试，补报告后设计质量不变。
- 模型实际输入未展示总步数、已用和剩余。`cutoff` 是事实位置。上一场业务根曾在 563 步正常收尾，后续才遇到 RSI 的 provider 并发问题；不能把不同故障混为一谈。
- 已批准 chip 包的 goal 要求面积和延迟都降低，实际评分允许加权折中；最高分候选面积约为基线 3.76 倍。八个模板重复同一指导，workflow 又复制一份，还让无执行权限的 root 先测量。这些是领域包的合同问题，内核短提示不能修正已经冻结的冲突。
- 旧长跑没有默认父背景调用，也没有重复全局关系注入。最大上下文约 412790 tokens，低于原生 700000 压缩触发线；不能据此宣称 compaction 失效。大量显式 trajectory 分页、源码、工具输出和长探索仍会累积。此次没有增建 mem 层或修改压缩阈值。

## 简化后的责任分配

`assembly/src/prompts.ts` 是节点 system policy 的唯一来源：一份共同协议，加 root/task/review/improve 的短角色职责。其余位置按所拥有的信息组织：

| 位置 | 拥有的内容 |
|---|---|
| 节点 policy | Task/Run/Method、冻结合同、有限求解、等待时结束 turn、交付与验收、mem 和 compaction 的边界 |
| DSH `defineTool` | 工具用途；参数的含义、枚举、引用来源、分页单位/限额和调用格式放在 schema description |
| dispatch / outcome | 本次合同、准确身份、固定方法、证据输入、输出模板和完成事实 |
| Method / template / Skill / Tool | 领域过程和能力，不再复制节点协议与工具手册 |
| native runtime context | 一行实时已用/总步数及剩余；完整责任和关系仍按需读取 |

删除 preset 的重复角色宣言、review-purpose 动态指令、outcome 的“继续整合并验证”、问答和 RSI 分派中的重复行为提示。保留 persona 的空 `prefix` 和 cwd 事实：DSH schema 要求该字段，空字符串不承担第二份角色规则。

root 在合同证据足够时选择 verified direct-child 产物提交，组合有必要才委派集成；探索允许有证据的无增益结果。独立 root acceptance 仍不可省略。mem 解释与真实实现一致：无 ref 的显式调用按需准备一次有界父背景，ref 只读已有 notes，RSI 历史不注入业务，notes 不构成验收证据。没有新增计时器、比例软截止、自动提交或第二份完成状态。

## 预算从原生日志投影

模型每次请求看到 `Workflow steps used N/1024; remaining M, shared with children and acceptance.`，与 pre-step guard 共用计数。预算包括后代、acceptance reviewer 及其取证子节点；review 分支可回溯同一个业务根。借用根会话只计本 Task dispatch 起的步骤，旧 Task 的步骤不进入新预算。

运行期间优先读 DSH live Session 的 `snapshotEvents()`，冷会话才读 persistence。当前正在创建、尚未注册的会话直接使用 system-prompt assembly 持有的原生 Session。预算是投影，没有缓存计数器。缺失冷历史仍抛错，不把持久化错误记作零步。

实跑暴露了两个离线测试原先未覆盖的装配边界：首次写盘前读取预算会报 session not found；删除 persona 文案时漏掉其必需 `prefix`。已分别补充未发布会话/冷历史反例和真实 persona 装配测试。早期失败会话单独保留，新运行使用新 home/control/request。

## RSI：让证据选择修改方向

删除“多槽最后一槽必须触及未试资产类型”和“停滞两轮后首槽必须删除资产”。它们会把资产覆盖率当作进展，在没有能力缺口时推动添加 Skill/Tool，或在没有删除依据时强制删资产。连同 `untried`、`prune`、固定无效的 `editBudget` 批次字段和相关准入分支一起移除，没有换成另一套配额。

保留最多六槽、每批 1–3 个单机制候选、实际 diff/绑定检查、证据引用、critic、selftest、真实对照和发布门。静态预检失败不冻结槽，冻结后失败消耗槽。允许直接提交诚实的无赢家报告。最小充分修改可以是删除；新增能力需要证据。

提案筛查判断“是否值得安全地测试”；发布审核判断已冻结的独立测量。发布不再复用提案 critic 的“缺少性能/迁移测量不能拒绝”说明。审核标准仍随冻结 subject 提供，节点 policy 不再重复拼接每条标准。

没有把无 suite 的既有发布路径冒充迁移保证，也没有补做完整 pilot、跨机器复现或硬件消融。这些仍是原计划中明确的缺口。

## 环境准备的有限交付

`scripts/env-setup.mjs` 将 setup 模板从约 4067 降至 2024 UTF-8 bytes（约减半）；默认源码地图从 17 个入口缩到 8 个，移除长篇计划、宿主实现和 CLI 源码。只按需读取有关接口。env setup 仍是一个普通 DSH headless session，不增加调度器。

生成包须将加权折中写清楚，单项硬门写入 criteria；不要求全局最优、持续超过最新分数或成功变体配额。baseline、不同有效候选和无效候选足以验证评分区分。root 协调、worker 执行；领域资产不复制系统协议；验证通过后写 review/manifest 并结束。审核文件只保留简短结果和限制，公式/算例与源码来源引用已有包文件和 context map，删除重复抄写要求。启动示例明确 `evaluationParallelism=1` 是 host config 字段。凭据未修改。

## 体积与验证范围

同一 DSH 装配下，仅统计 Singularity policy 与自有工具 schema 的 JSON UTF-8 bytes，不含原生工具、历史消息、dispatch 或 runtime context：

| 角色 | 原 policy + tools | 新 policy + tools |
|---|---:|---:|
| root | 9477 | 8854 |
| task | 9755 | 9139 |
| review | 7991 | 8243 |
| improve | 5656 | 4876 |

review 的静态片段略增，因为原本散落在 dispatch/context 的用途区分被集中到 policy；这些外部重复文本已经删除。该表不是完整请求 token 数，也不证明运行成本同比下降。

本轮修改涉及的生产源码、preset 和 setup 入口合计净删 11891 bytes（包含新增的单一 policy 文件；不含测试、文档及构建产物）。复杂 chip 优化没有重跑，不能据此声称已提高其收束率或得到 RSI 领域收益。

## 新运行与工程验证

证据根目录：`/home/ROXY/singularity-next/simplification-validation-20261023/`。模型沿用现有 LiteLLM 路由 `cn:deepseek-v4.1-flash`，评测并行度 1；没有修改凭据，也没有启动并行评测。

`business-r4/` 使用主仓显式参考领域，learning=false，新 control `simplification-business-r4-20261023`。根 `task-27b2f07e820e9da2` 自主委派一个完整子任务，子产物独立 verified 后调用 root submit，再通过独立 root acceptance，于 cutoff30 closed accepted。`report.json` 与 `native-evidence.json` 记录 root 10、worker 6、child review 7、root review 10，合计 33 个原生步骤（含提交后的终局回答，不等同封存 comparison cost）。所有角色实际输入均出现共享预算，显式 mem 调用与自动父摘要均为零。完成后停止本次拥有的临时宿主，保留会话与证据。

这只是一个小业务交付闭环，没有执行模型 RSI、硬件搜索或统计对照，不能从一次成功推导成本降低或长期收束改善。此前失败的 `business/`、`business-r3/` 保留原记录：分别暴露创建时序与 persona schema 错误；另有一次手写启动脚本漏传 contractFor 的 goal，属于实验脚本错误。

`environment/` 的普通 setup session `session-d68fc320-6016-42d1-a209-02abfa305fe3` 自主退出，exitCode=0，approval=pending；没有启动宿主、Task 或 RSI。它用了 80 步、118 次工具调用，审核文档 20673 bytes、验证脚本 12803 bytes，仍明显偏重。独立重跑 `node verify.mjs` 通过 manifest、domain/contract/method、verifier 的正反 selftest 和评分样例：464B 基线质量 1，107B 有效候选质量 4.336449，123B 无效候选为 business-failure。15 个包文件无符号链接，未批准或部署；没有 suite，不提供迁移证据。

这次 setup 启动于约 3 KB 提示、15 个源码入口的中间版本。其读源码和反复润色记录促成最终 2 KB / 8 入口及删除审核文档重复抄写要求；最终版本只完成工程检查，尚无新的模型运行成本或收束率数据。期间本轮代码工作也改变了 source map 中的 `assembly/src/index.ts` 和 `docs/env-setup.md`，格式接口未变；生成审核的来源说明没有完整覆盖宿主源码漂移，以实验根的 `setup-source-drift.json` 为准。不能把这次并行开发中的 setup 当作固定源码下的前后对照。

工程检查：build 通过；93 文件、1027 项测试通过；修正 persona 后另行通过真实 persona 的原生装配测试；最终 setup 模板的 6 项入口测试通过；最终 8 项 gates 通过；`git diff --check` 通过。测试中的 TypeScript mutation 反例会刻意输出类型错误，测试自身均通过。这些结果只证明覆盖的工程行为。
