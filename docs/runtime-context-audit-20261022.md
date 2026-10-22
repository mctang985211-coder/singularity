# 2026-10-22 真实运行的上下文与用量审计

结论：膨胀来自 Singularity 自动追加的全局关系快照、过重通知、自动父背景摘要，以及未触发的原生压缩。不是模型需要更多全局信息，也未发现缓存重复计账。修复删除重复输入通路，复用 DSH 原生压缩，不新增 memory store、协议或调度层。

## 范围与取证

只读解压两次运行的全部原生 session，使用各自冻结 checkout 的 `openPersistence(root, 'zstd')`，以 `read` 打开，没有续跑、改写原始事件或发起审计模型请求。最新旧宿主在 `2026-10-22T08:17:45.699Z` 正常退出，避免继续消耗。

| 指标 | 前次 chip-rsi-launch-20261022 | 最近 chip-rsi-restart-20261022 |
| --- | ---: | ---: |
| Session 数（含 control） | 108 | 53 |
| 成功主调用 | 4,573 | 1,833 |
| 主调用未缓存输入 | 21,393,046 | 14,001,105 |
| 主调用缓存读取 | 571,354,112 | 215,953,280 |
| 主调用输出，已含 reasoning | 10,886,471 | 4,136,021 |
| 原生主调用 token 总量 | 603,633,629 | 234,090,406 |
| 额外 memory 调用 / tokens | 41 / 4,595,981 | 16 / 2,170,746 |
| 已知合计 tokens | 608,229,610 | 236,261,152 |
| 最大单次输入（含缓存） | 486,519 | 485,259 |
| 自动 runtime-context 快照 | 997 | 357 |
| 仅全局 cutoff 改变的快照 | 688（69.0%） | 247（69.2%） |
| 原生 compaction 次数 | 0 | 0 |

未缓存输入、cacheRead、cacheWrite、output 是离散桶；reasoning 已在 output 中，不能再相加。上述 token 总量不能直接换算美元费用。最新运行已知合计约 91.4% 是缓存读取。失败请求缺少可靠服务端计量时，实际费用仍可能更高。

## 1. 全局关系注入为什么越跑越大

旧 `assembly/src/index.ts` 每次 assemble 都把整个 `coordinationOf` 放入 `singularity:responsibility`，另有自动 `singularity:rsi-state`。direction 带全局 `cutoff`；任意并行分支增加事实，其他节点快照也变化。

DSH RuntimeContextProjection 比较文本后将变化内容追加为普通 `user/message`。提示中的 “supersedes earlier snapshots” 不执行替换；旧消息全部留在实时上下文中，后续每一步继续重读。只去掉 cutoff 能减少约 69% 重发，但仍会在真实进度变化时反复追加，因此本次直接删除两类自动注入。

可定位证据：

- 前次根 `singularity-1359b5f5e969db61c78782cfcc7c6142` 的 seq 23 / 31 / 46 各 2,867 bytes，仅 cutoff 10 / 11 / 13 不同。`task-54cd573045f7dd4f` seq 65 / 76 / 87 的责任正文各 17,914 bytes，只有 cutoff 改变。
- 最近 `singularity:agent:task-3e0870b953348a22` seq 9 的 dispatch 为 33,423 字符，direction 19,530 字符，兄弟完整 goal 12,767 字符；同一 root goal 又在 supportPath 重复。
- 最近根 `singularity-48659c88feb18b47c57fa6f16d8f8497` seq 164 的 runtime-context 为 21,680 字符。整轮 357 条共 3,956,792 字符，占 user 文本 82%；按后续调用次数计算累计回放约 140,336,930 字符。字符回放不是可直接宣称节省的 tokens。
- 最近上述 task seq 625 输入为 485,259 tokens，117 次成功调用累计 36,644,343 tokens。

现在工具准入仍读取实时 waiting/canPlan/search，删除提示正文不放松执行限制。当前责任通过 `summary` 读取，关系通过 `workflow` 分页读取。dispatch 仅保留一次 root 目的预览（512 字符且标明是否完整）、关系 ID、支持标准与接口；完整授权合同仍可读取。

使用新 `workflowDirection` 对两轮共 87 条历史 dispatch 的准确冻结 control 前缀离线重放：前次 `task-54cd573045f7dd4f` seq 9 的 direction 从 16,985 字符降至 1,698；最近 `task-3e0870b953348a22` seq 9 从 19,530 降至 1,744。自动 responsibility 正文通路已删除。这是同一历史输入的文本体积对照，不是新长跑的 token 节省比例。复演脚本和逐条结果为审计目录的 `payload-delta.mjs/json`。

## 2. 通知与读接口也在重放已有内容

最近根 seq 211 的 plan-outcome 为 52,767 字符，其中 child goals 17,270、verdicts 33,170。前次最大通知 55,045 bytes。它们将已经交付的合同和完整审核论证再次自动推送给父节点。

现在 plan-outcome 仅通知父 ID、完成数量和读取入口；branch-outcome 仅发 task/run/status、artifactDigest 与 criterion verdict。完整证据与 detail 保存在原处。`summary` 的任务索引默认 20、最多 100 项，仅当前 Run 和紧凑状态，保留冻结 producer 的准确 Run 边界。

没有把所有工具调用都判为浪费：最近 969 次 trajectory 请求中，同 session 同参数重复仅 3 次，主要是获取不同证据分页。method 读取最大 38,233 字符是仍存在的显式开销；本次保留现有资产接口，不扩展成另一套检索机制。

## 3. 父背景 memory 没有压缩工作会话

旧 memory 在每个子节点执行前自动把父 `deriveMessages()` 全量送模型，包含 reasoning、工具内容、system、过时快照，以及 `source.sections` 对正文的重复副本。生成 checkpoint 只服务子节点，不删除父会话任何内容。

前次四个兄弟各处理同一份 308,307 bytes 父对话，最大单次摘要指令 659,609 bytes。最近根 seq 149 / 152 / 155 / 158 各处理同一份 522,180 字符父对话；16 次摘要中 4 次打满 32,768 output，只有 reasoning，没有可用 JSON。

现在不在启动时自动摘要。首次显式 `singularity_memory()` 才为接收 scope 准备一次，后续复用已有 checkpoint 或失败记录；带 ref 的读取不调用模型。完整序列化请求上限 32 KiB，选近期 user/assistant 正文，单条最多 4096 bytes，排除 reasoning、工具结果、system/developer 与宿主快照；继承笔记和证据也有上界。思考强度继承源会话设置，输出额度保留 32768 tokens。仍绑定完整原始来源前缀的 digest，兼容读取旧 checkpoint，不把摘要变成验收事实。

取舍：精简笔记可能遗漏旧细节，节点需要通过原有 scoped reads 查询。不会先付费给所有兄弟购买背景，也不另建共享摘要缓存或自定义长期 memory 系统。

## 4. 已安装压缩插件不等于发生过压缩

旧 route 声明 1,000,000 contextWindow、393,216 maxTokens、max reasoning。DSH 默认阈值为 `min(800000, 1000000 - 393216 - 65536) = 541248`。两轮峰值都约 486k，没有达到阈值，原生日志确实零 compaction。

四个 preset 使用 `thresholdRatio: 0.7`，按用户要求在本轮 1M 窗口的 700k 触发；保留原生默认 `retainRatio: 0.16`、`headroomTokens: 65536` 与原有摘要输出额度 `maxTokens: 32768`。执行原生范围选择、工具配对、surface replace 与恢复，durable events 不删除。它是工作会话减负，父背景 memory 是跨节点工作笔记，两者不混用。

新实验保持 max reasoning，父背景也不降思考档位；工作输出预留从 393,216 调为 196,608，使 `1M - 输出预留 - 65536` 大于 700k，避免原生容量保护把实际压缩线提前。provider 自动重试从 20 次降为 5 次。保留真实模型窗口声明；这些是部署策略，不向内核硬塞特定 provider 上限。前次单次 output 曾达 83,755 tokens，最近达 45,913 tokens；这类长尾与失败重试会进一步放大用量。

## 5. 用量异常的判定与披露

核对原生 token-meter folds、provider 适配器和逐条计量，未发现把缓存再计入 uncached 或把 reasoning 再计一次。最近 1,833 条成功调用的 reportedTotal 与四桶之和完全相符。前次失败 attempt 按原生“最后样本替换/重试关闭槽”复算也无额外差额。

确有低报边界：memory 与 compaction 是额外请求，不进入原生 UI tokenUsage。现在 `singularity_read(kind=usage)` 保留原有 tokenUsage/tokens，另加 `audit`：native、memory、compaction 分项、已知 tokens 与样本完整性。不修改旧实验的冻结成本和比较基线，不伪造供应商账单。

最近另有 231 条 assistant/attempt，223 次 retry，失败记录均为零 usage，主要是断流。零样本不能证明供应商未收费。失败、在途与缺失样本应作为费用不确定性，不能将已知合计称为完整费用；减少重试上限和输出长尾只是控制风险，不能补出真实账单。

## 验证与重新运行

原生 Loader/host 测试验证没有自动关系注入、没有启动时摘要、显式 memory 幂等、等待状态仍限制工具。原生自动压缩测试验证 690k 不压缩、730k 触发 `surfaceOp.op=replace`，旧文本离开 `deriveMessages()`，但仍在 durable events 中；父背景继承 max 思考设置。另覆盖有界多字节/转义输入、旧 checkpoint、辅助用量和缺失计量、零用量失败请求的不确定性、通知大小、分页与冻结证据权限。`pnpm verify` 通过：93 个测试文件、1025 项测试、8 项门禁。完整日志为审计目录的 `verify-final.log`。

使用新 checkout、新 DSH_HOME、新 controlId 重新运行，防止携带旧膨胀上下文、改变旧 executionProfile 或与已有 identified 通知正文冲突。复用已批准的 69 文件环境包并逐 SHA 核对。按用户最终要求，本次评测并行度为 1，OpenAI Chat Completions 接口为 `https://ccapi.cgdoem.cn/v1`，模型 ID 为 `cn:deepseek-v4.1-flash`，max 思考不变，700k 压缩线；密钥仅存私有 home，不入 Git。范围仍是局部 INT8 数据通路、模块 Verilator + Yosys + OpenSTA，禁止全芯片 Verilator、bebop-p2e 与商业 EDA。现有合成任务不能作为 CosyVoice 整模加速或未知领域迁移的论文结果。

修复代码 `2b7921b030acab243290f4dfc9f6a276dcee0419` 已推送到 `codex/chip-rsi-storage-recovery-20261022`。新实验位于 `/home/ROXY/singularity-next/chip-rsi-context-fix-20261022`，control 为 `chip-local-rsi-context-fix-20261022`，root 为 `task-89e15b1fd8015c52`。2026-10-22 17:01:57（Asia/Shanghai）的原生记录有 7 次成功主响应、零失败 attempt、零父背景模型调用、零被禁止的自动上下文 section；请求 header 实测为 ccapi / `cn:deepseek-v4.1-flash` / max / maxTokens 196608。启动时源码及 69 个批准文件均无漂移。该时间点 root 正在运行，尚无 RSI 测评或收益结论。启动证据为新实验目录的 `startup-evidence.json` 与 `context-startup-evidence.json`。

修复阻断了已证实的重复输入通路；尚未完成的新长跑不能用于宣称节省比例或 RSI 质量提高。

原始审计工件位于 `/home/ROXY/singularity-next/context-audit-20261022/`：`previous-report.md`、`latest-findings.md`、`previous-audit.mjs`、`previous-detail.mjs`、`audit-latest.mjs`、`audit-runtime-detail.mjs` 及对应 JSON。旧实验日志原地保留，不进入 Git。
