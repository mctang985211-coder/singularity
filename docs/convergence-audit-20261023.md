# 2026-10-23：1024 步后仍未进入根验收的审计与修复

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

需要优化的是业务 workflow 的收束策略，以及预算失败后的 RSI 续接。这轮已经得到可用的局部 RTL 改进，却把单次业务求解变成连续追逐更高分的搜索，最终没有提交根验收。增加 1024 上限只会延后这一问题。

## 审计范围

最新实验为 `/home/ROXY/singularity-next/chip-rsi-litellm-restart-20261022`，control 为 `chip-local-rsi-litellm-20261022-r2`，源码为 `2b7921b030acab243290f4dfc9f6a276dcee0419`。业务根是 `task-99125d74346964c8`，原生 session 是 `singularity-f50987814a8cbf32e73852a7037fffe3`。读取其全部 16 个原生 zstd session、127 个 control facts，并对照前一 LiteLLM 实验中真正完成验收的业务根。未续跑、修改旧日志、重新计分或执行 EDA。

以下时间均为 Asia/Shanghai。实验里的 `host-exit.json` 是第一次启动失败的旧记录，不能作为最终停机时间。最终控制事实准确记录了 10 月 23 日 **04:08:24.705** 的预算失败。

完整本地取证在 `/home/ROXY/singularity-next/convergence-audit-20261023/`：`workflow-report.md`、`runtime-findings.md`、`runtime-session-table.md/json`、原生 facts/steps/calls 与对应读取脚本。大体积 session 和详细推理不入 Git。读取器使用匹配私有安装的原生 Cordis/JSONL persistence，只打开 read handle；没有修改完整性 baseline 来绕过冻结 checkout 的宿主摘要检查。

## 1. 1024 是整棵 workflow，计数没有重复

| 工作范围 | Session 数 | step/start | 主调用已知 tokens |
| --- | ---: | ---: | ---: |
| 根协调 | 1 | 40 | 5,196,650 |
| 实现子 Task | 7 | 708 | 156,234,621 |
| 独立 acceptance review | 7 | 276 | 22,586,902 |
| 合计 | 15 | **1,024** | **184,018,173** |

control session 不执行模型步骤。去重后的原生 `step/start`、`assistant/message`、`step/end` 均为 1024；最大单 session 为 138 步。一步内多个工具不重复计步。

`driver-execution.ts` 在业务 Task 的原生 pre-step 准入处汇总根、后代和独立审核的步骤，借用的 root chat 从本 Task dispatch 的步骤开始，排除旧任务前缀。control seq124 将根标为 business failure，原因是 `workflow step limit 1024 exhausted`；seq125 因父 Run 已结束而终止最后探索；seq126 关闭根。没有 root `run/submitted` 或根验收记录。

## 2. 已经产出改进，根却不断抬高下一节点的目标

| 时间 | control seq | 事实与剩余预算 |
| --- | ---: | --- |
| 10-22 23:27 | 25 | 两个 required 设计、资源共享 exploration、依赖 CSA 的 refinement exploration |
| 10-23 00:14:54 | 48 | direct 子任务通过独立验收，quality=4.005342 |
| 00:17:42 | 57 | 追加 direct refinement，要求严格提升、至少三个实测变体 |
| 01:05:59 | 68 | 两个 required 均通过；已用439步，剩585 |
| 01:41:00 | 80 | refinement 通过，quality=5.787878；剩456步 |
| 01:42:16 | 84 | 再追加 area-trim refinement |
| 02:59:36 | 99 | CSA refinement 通过，quality=4.891923 |
| 03:01:34 | 103 | 又追加最后 merge exploration；剩195步 |
| 03:11:09 | 108 | area-trim 产物已测5.888390，功能及完整性通过，但变体数量不足，被判partial |
| 03:22:52 | 119、120 | 同一最佳产物补齐报告后通过；释放最后merge时只剩116步 |
| 04:08:24 | 124–126 | 总预算用尽，根失败，没有提交验收 |

根的两项验收是 correctness/design-integrity，目标是改善局部 signed INT8 PE。连续质量分数本身没有“全局最优已找到”的终止信号。根把下一节点反复定义成“必须胜过当前最好，并至少测三个通过变体”，增加了原始合同没有要求的过程义务。

area-trim 首次提交已从 5.787878 提高到 **5.888390236954082**；审核依冻结子合同正确指出只有两种新增通过变体，未达到三个。重试补做退步变体和报告，再次审核后最佳分数没有变化。这里应修创建合同的策略，不能让 reviewer 忽略已冻结的条款。

最后 merge 的新候选最高仅 **5.273760**，低于起点5.888390。它持续运行局部 RTL/EDA 探针，并未挂死；但其合同要求严格胜过起点，handoff 还禁止提交退步产物，因而没有合适的负探索完成路径。根虽然可以停止 exploration，却不知道只剩116步，仍承诺等这个“最后一轮”再提交 fallback。此前每次独立审核还需要30–48步，最终根审核没有预留空间。

根实际输入没有展示 maxSteps、已用或剩余步骤。`cutoff` 只是控制事实位置，不是步数或剩余额度。这是运行时提供信息不足，不能全归因于模型决策。

这些分数是按批准公式计算的**局部合成算子质量比**，基线为1；5.888不是整模推理加速倍数，也不是跨任务 RSI 方法收益。正确性/完整性通过不能自动替代根独立验收。

环境合同还存在目标表述歧义：goal 写“改善 latency 和 area”，公式却是延迟0.65、面积0.35的加权折中，允许面积退步。实际基线面积10,477.5488，最佳子产物39,444.08，约增至3.76倍；延迟大幅下降使综合分数升至5.888。因此不能仅凭该分数断言根的全部目标已满足。下一次setup应明确“改善加权目标，并报告两项原值”，或明确面积硬上限；不能让根自行猜测双目标含义。这需要新批准包身份，不回写本轮已冻结goal/公式。

## 3. 为什么上一轮能结束

上一实验 `/home/ROXY/singularity-next/chip-rsi-litellm-20261022` 中，根 `task-e167ae18057dc558` 确实正常验收：四个实现子任务、六次审核，共 **563步**。根在第一轮比较后只追加一次深化，最后子任务结束就选择 quality=3.780206 的结果，在21:25:08提交，21:36:08 accepted；仍余461步。

最新根扩展到七个实现子任务、连续三条追加提升分支，追到了更高子分数，却损失了交付可靠性。两轮并不能证明模型或上下文修复存在因果退化：开放式优化目标没有稳定停止策略，前一次碰巧及时收束，这次没有。

上一轮随后 RSI 遇到429并发限流，是另一类问题。本轮无失败 attempt 或请求重试风暴；不是同一停因。

## 4. 旧上下文注入没有复发，用量仍为何高

15个工作session各只有一次552–965字符的 runtime-context，内容是 sandbox/approval/review-purpose；没有自动 responsibility、rsi-state、direction/cutoff 重注入，也没有父背景模型调用。最大单次输入 **412,790 tokens**，未达到700k，因此零 compaction 符合当前设置。

1024条主调用的计量齐全，逐条 total 与 input+output 相符，没有算术重复计账。累计输入181,376,025、输出2,642,148；实现探索占主要用量。max reasoning 下仍有单次超过50k output的长尾，后续步骤继续携带这些历史。LiteLLM 没有提供缓存拆分，不能把字段为零解读成没有供应商缓存折扣；另有一次无usage的标题请求，主调用总量不是完整账单。

276步审核里143步主要读取 trajectory、29步读取冻结 subject，12步用于自建Python模型。没有审核委派或重跑完整公共EDA wrapper。审核消耗真实存在，但不应取消独立审核来省预算；应先避免不必要的变体配额、额外审核循环，再针对未解决的声明读取证据。

另发现三次 `singularity_run_method` 都因 `chip-local-measure` 未绑定而拒绝。根自由编写的子合同省略了 skills/capabilities，文字却声称工具已绑定，子任务随后走公共bash wrapper。执行并非绑定消费的证据，不能据提示词声称工具已经使用。

## 5. 本次落地的有限修复

1. **停止准则。** 精简 root/task 提示：先为本轮选择停止条件；竞争设计和额外深化标为 exploration；允许合同支持的负探索结果；除父合同确有需要，不额外加入成功变体数量和逐轮严格提升门槛。证据支持冻结目标后选取结果提交，把可复用方法改进交给后续 RSI。review 先读完整 subject，再从保护检查和所引执行结果定位争议，针对性读取 trajectory。
2. **预算可见。** 初始紧凑 direction 带现有冻结 limits。`summary.budget` 按需返回 rootId、limits、steps、remainingSteps 及现有 nodes/plans/runs/noProgress。预算查询与原有执行保护复用同一个原生步骤汇总，包含独立审核、排除旧root聊天前缀；不引入自动快照、定时消息、模型摘要或新预算协议。
3. **绑定可见。** 现有 template 列表返回 skills/capabilities；子合同字段说明和 root 指引明确绑定不继承、应显式选择。保留准入检查，不做静默继承或bash兜底，也不回写旧实验的工具使用记录。是否真的选用仍须通过新运行的 bubble/consumption 事实验证。
4. **预算失败仍能学习。** 修复预算耗尽分支在 closeRoot 后漏掉 `schedule()` 的问题。普通提交路径会唤起异步RSI，该失败路径原先不会主动唤起；原生日志也确实停在根关闭。现在 learning 开启的失败根同样能封存轨迹并启动独立RSI；已失败的业务根不会被改成accepted，learning=false仍保持关闭。

没有提高1024上限，没有加入固定比例软截止、自动挑选/放行根产物、第二套memory或领域专用调度层。root/task基础指引分别约2.0KB/1.5KB；只在原有按需接口增加小量状态。保持 max 思考、单会话700k压缩线、串行suite评测、原评分及全部硬保护；不更改批准环境包，不运行全芯片Verilator、bebop-p2e或商业EDA。

## 6. 验证与下一次实验的判据

回归覆盖：祖先/后代读取同一预算、已关闭旧任务前缀不计入新根、独立审核计入步骤、耗尽后剩余为零、冷恢复不重置计数、预算失败无需额外外部唤醒即可进入独立RSI，以及template绑定目录可见。原有隔离、冻结验收与无自动注入测试继续执行。

本次离线检查结果记录于本地审计目录 `verify.log`。尚未启动新的付费长跑，提示策略带来的真实收束率/用量收益尚未实测，不能用单元测试宣称模型一定会及时停止。

下一次应新建home/control/session并保持同一批准suite、模型、max思考、700k和评测并行度1。先验证一个业务根：新增子任务是否实际绑定Skill/Tool；根追加工作前是否读取预算并保留最终审核余量；无增益探索是否能交回负证据；根是否在1024内完成真实独立验收。再验证业务失败同样进入RSI、后续方法是在新任务上改善，而不是继续拟合当前RTL。若仍超额，依据新的预算读取和节点轨迹设计最小调度约束，不预先叠加任意阈值或扩大预算。
