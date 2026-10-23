# 2026-10-23：节点提示、环境准备与 RSI 的简化审查

修改基线为 `ddebbb3`（先保存用户工作区的 checkpoint）；当前 Task v25，只接纳新图。旧实验保持原样，不用新代码回放旧图来改写结论。

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

v24 的无 suite 发布缺口由后述 v25 修复关闭；完整 pilot、跨机器复现和硬件消融仍未补做，不把工程修复当作迁移收益。

## 环境准备的最小边界

当前默认只准备同领域多任务内容、验收标准、评分策略和 Agent 试分工具。任务 contract 放在 suite 中，评分规则和调用帮助归 scorer；不预设 Method、Skill、TaskTemplate、任务分解、独立 Task、求解器或启动/验证脚手架。未用的 inputs/templates/verifiers 可省略，显式 null 等错误值仍拒绝；宿主直接提供空 Method seed，由 Singularity 自行探索 RSI。

删除默认 `SETUP_REVIEW.md` 和重复评分手册；检查结果留在原生 session 最终答复与 `.env-setup/run.json`。manifest 只要求 version/domain/files；旧 task/review 字段可选且仍须列入 files。既有路径、摘要冻结与日志隔离保留，没有新增验证框架或调度器。详见 [env setup](env-setup.md)。

按同一 WORKSPACE/REQUEST 占位和 checkout 路径计算：`4518d0c` 的提示/接口材料 2040 + 3062 = 5102 bytes；`232ec46` 为 1397 + 2314 = 3711 bytes，减少约 27%。源码入口从八个缩至四个，附最小结构与独立验收语义供直接使用，扩展时才查源码。该数字不包含原生 DSH 提示和历史消息，不等于完整请求成本。

## 体积与验证范围

以下为 `4518d0c` 在同一 DSH 装配下的统计，仅统计 Singularity policy 与自有工具 schema 的 JSON UTF-8 bytes，不含原生工具、历史消息、dispatch 或 runtime context：

| 角色 | 原 policy + tools | 新 policy + tools |
|---|---:|---:|
| root | 9477 | 8854 |
| task | 9755 | 9139 |
| review | 7991 | 8243 |
| improve | 5656 | 4876 |

review 的静态片段略增，因为原本散落在 dispatch/context 的用途区分被集中到 policy；这些外部重复文本已经删除。该表不是完整请求 token 数，也不证明运行成本同比下降。

`4518d0c` 相对本轮检查点的生产源码、preset 和 setup 入口合计净删 11891 bytes（包含新增的单一 policy 文件；不含测试、文档及构建产物）。复杂 chip 优化没有重跑，不能据此声称已提高其收束率或得到 RSI 领域收益。

## 新运行与工程验证

较早证据位于 `/home/ROXY/singularity-next/simplification-validation-20261023/`：`business-r4` 的 root `task-27b2f07e820e9da2` 自主委派一子任务并通过独立 root 验收，合计 33 步；各角色收到共享预算，显式/自动 mem 均为零。此前创建时序、persona 与手写启动参数失败保留在相邻目录。旧 setup 使用中间版本，80 步/118 次调用、20,673B 审核文件、12,803B 验证脚本、15 个文件且无 suite；其源码漂移见 `setup-source-drift.json`，不能充当固定源码的前后对照。

本次证据位于 `/home/ROXY/singularity-next/minimal-env-validation-20261023/`。沿用既有 LiteLLM 模型/凭据，评测并行度 1。相同的小型 JSON 聚合请求产生 evolve 求和、validation 去重计数、heldout 最大值三个独立 family/source，各一 trial。两轮 builder 自主退出，均未批准或自行部署：

| 实跑版本 | session | 步数/工具调用 | manifest 文件/总字节 |
|---|---|---:|---:|
| `96523dc` | `session-26671c46-01d1-489d-b714-14a2ef591a63` | 56 / 77 | 9 / 22179 |
| `232ec46` | `session-c82d7ccb-f77f-4f2b-aecf-a155c87f031e` | 36 / 58 | 7 / 8818 |

第二轮包缩小约 60%，只含声明、suite、三个输入、score CLI 和 manifest，没有 Method/Skill/TaskTemplate、独立 Task、审核手册或启动/验证脚本。规则与帮助放在 score CLI。两次输入字节和模型轨迹不同，第一轮退出前 wrapper 曾继续编辑（已载入函数、保存的提示和四个映射接口未变），第二轮另有原生 300 秒 stream idle timeout 重试；这些是描述性记录，不是固定源码的严格成本 A/B 对照。逐文件摘要见 `builder-v2-evidence.json`，最终七个文件摘要均未改变。独立 `loadDomain/matrixOf` 与三任务正反/缺失试分通过，结果分别为 10、4、-3，正确 1、错误/缺失 0，见 `independent-score-check.json`。

`runtime/` 使用 `232ec46` 启动临时宿主，不配置 methodFile；宿主创建空 seed（`empty-seed.json`）。CLI suite 只启动第一个 evolve 业务 root `task-89b90105488b2bbd`；它委派一个 child，实际调用公共 CLI，再主动提交并独立 accepted。业务 root、child、两次独立验收的原生步骤分别为 9、6、8、8；各角色收到共享步数，显式与自动 mem 均为零。封存原生轨迹 472919B，RSI subject 9231B，轨迹正文按需读取。

RSI 实跑暴露 authoring 规则页缺少可填写模板：Agent 先读规则，后来还跨文件查格式，直到读取默认 search 才取得模板。`19884ec` 把模板和规则合并到同一按需页，默认 search 只给 authoring ref，静态 authoring 读取也不再计算反馈。原生结构集成测试从该分页页取得模板、填入真实证据并通过提案准入；该页面调整尚未新跑模型，不据此宣称步数减少。

同一运行还暴露 capabilities 参数歧义：root 为普通 CLI 搜索不存在的 Method 绑定名。最后只删短 `skills`/`capabilities` 的 DSH schema 说明，明确它们可选，原生工具和公开 CLI 无需绑定；没有增加默认 Method、全局提示或 helper。运行进程仍使用启动时已载入的 `232ec46`，后续页面和 schema 调整只做工程回归，不能宣称其模型收益已验证。

RSI `improve-2afd2edddcec458835c98e11` 冻结一个候选、执行一轮 evolve 对照后主动提交报告，没有为用完六槽而继续添加资产。候选只增加 1011B workflowGuidance，没有 Skill/Tool/模板。baseline/candidate 各一个 trial，均 accepted、quality=1，封存成本分别为 411639/198927 tokens；这个点估计不能归因于修改。独立 reviewer 不收到 workflowGuidance，其成本差占总差约 44%，单 family/单 trial 也不足 paired 统计门槛。

封存后迁移检查实际因九个原生插件缺少 execution-profile 实现证据而返回 `insufficient-evidence`，尚未执行 validation/heldout；不能把它描述成已完成迁移测试或只因样本少拒绝发布。空 seed 仍为发布指针，候选未发布。

最终 cutoff118，报告独立验收 `review-94c8667bb13e2a80d215978a` 完成并判 partial：作者把 reviewer 成本差的 43.8% 写成“most”，又把封存原业务相对重测 baseline 的 39.2% 降幅写成 20.6%。宿主据此将 improve 和 root RSI 标为 failed，业务 root 仍为 verified；没有将主动收尾或单轮成本点估计冒充 RSI 成功。验收用了 31 个原生步骤，仍有明显取证成本，本轮没有通过放松准确性要求消除它。完整状态、原生日志与最终检查保留在 `runtime/{snapshot,report,native-evidence,final-check}.json`；所有 Task 终局后停止本次自建临时宿主，launcher exit 0，未修改原始报告或旧实验。

工程验证：`232ec46` 全量 93 文件/1033 测试通过；后续 authoring 调整的 4 文件/73 项回归及最后 schema 调整的 1 文件/15 项回归通过，最终 build、8 项 gates 与 diff 检查通过。类型 mutation 反例的 TS 错误属于测试预期。上述 suite 是加载、评分与收尾冒烟，不满足迁移发布所需样本，也未重跑复杂 chip 优化。

## v25：按运行故障修复执行边界

本次继续以 `81784ca` 为起点，仍归于 `ddebbb3` 之后的同一次简化。没有改凭据、启动远程模型、重新部署宿主或回放旧图。

- execution profile 以前从 assembly 自身解析 preset 插件。原生 Loader 已加载的包不一定在 assembly peers 中，导致实跑中的九项缺失。现在持有各 preset 的原生 generation lease，沿实际 entry tree/base URL 调用 Loader ESM resolver，记录各 preset 来源并 hash 实现；无法取证仍 fail closed。单测覆盖同名包在三个 preset 解析到不同实现、assembly 本身不能解析它们、修改任一实现改变 digest、真实缺失；真实 DSH preset 挂载另验证 compaction/command/pruner 的取证。
- 删掉 submission 的 `prepare` 钩子。之前 sealFiles 后就开始私有测评，但 `run/submitted` 尚未持久化，验证异常可留下 working 作者。现在先持久化提交，再通过统一 acceptance 入口做私有验证、发布和报告审核；冷恢复也走它。删除已不可达的“等 transfer 后才能 submit”旧闸，复用 submitted 阶段，没有新增生命周期状态。该语义变化升级为 Task v25，只用于新图。
- 删除无 suite 的自动发布分支，并在 release 入口统一拒绝缺少冻结独立验证的发布。合法负发布审核返回已有 witness、不 approve/publish，可继续验收诚实报告；没有吞掉结构错误或放松发布门。submitted 阶段的原生失败也会关闭仍 running 的工作，验证与后代收到取消。
- 报告 results 改为引用真实 round 和机制观察；冻结分数、成本、结果仍由宿主提供给 reviewer。作者不再被要求重复抄算已有数据；若自行声称数值仍须准确。
- builder 明确只整理用户提供的任务，不虚构 family 或跨 split 独立性；相关技术参考按只读资料/冻结输入进入，不自动激活 `.agents` 中角色、审批、旧工作流。四模型输入和统计覆盖见[启动说明](rsi-startup-and-chip-workloads.md)。

相对 `ddebbb3`，`src/`、`assembly/src/`、`scripts/` 的生产源码合计增加 216 行、删除 247 行，净减 31 行、11617 bytes；测试与人类说明文档增加。纯节点 policy 的 UTF-8 bytes 为 root 2234→1843、task 1703→1481、review 1508→2022、improve 2199→2013；这里不包含已移除的动态 review-purpose、工具 schema、DSH 提示或消息。review 本地 policy 增长是集中共同协议和筛查职责的结果，不能声称每个角色都变短。前述 builder 27% 和产物 60% 下降只属于表中历史版本，当前 builder 新增了用户任务/资料边界，未重新跑模型测量成本。

本轮日志位于 `/home/ROXY/singularity-next/profile-repair-*`；真实 native 挂载验证为 `profile-native-mounts.log`。回归覆盖报告提交先于私有试验、封存写盘中断的冷恢复不重抽、负发布审核、无 suite 不发布及验证期间取消/失败。没有从这些工程结果推断真实模型收益或芯片迁移效果。

最终验证：`pnpm build` 退出 0；`profile-repair-tests-final2.log` 为 **93 文件、1037 项全通过**；`profile-repair-gates-final.log` 为 **8 gates 全通过**；changed documentation links 和 `git diff --check` 通过。日志里的两条 TS2322 是 build mutation 反例按预期被拒绝。没有运行全芯片 Verilator。
