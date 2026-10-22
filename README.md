# singularity-core

以 Task 为一等公民的领域 workflow 与 RSI 内核、DSH 插件。Task 节点表达冻结责任，通过分解、依赖和产物关系组成 workflow，独立 ReviewRun 判断交付。根任务终局后可异步改进 workflow 策略、TaskTemplate、Skill、Tool，经测评和发布审核切换唯一方法指针。

当前协议为 Task v23、Strategy v9、Measure v5、Review v5，读投影为 v13。新协议只用于新图，不提供旧图兼容或迁移。

按[终局实施计划](docs/task-first-domain-rsi-plan.md)实现有界搜索、合法无赢家终局、完整 Task 契约、可选模板、workflow 策略及逐节点协调。冻结 suite 可以通过同一原生 Task 路径执行 case × trial 对照；工程检查与领域提升结论分别记录。当前工程与实验出口以计划状态表为准，不把离线测试当作迁移收益。
| 阅读入口 | 用途 |
|---|---|
| [Task / Workflow RSI 终局计划](docs/task-first-domain-rsi-plan.md) | 第 1/6 节架构、第 9 节唯一施工顺序，完整审查与验收反例 |
| [blueprint](docs/blueprint.md) | 目标、架构与文档导航 |
| [assembly-blueprint](docs/assembly-blueprint.md) | 现有装配边界与历史施工依据 |
| [phase-g2-design](docs/phase-g2-design.md) | 当前任务运行合同 |
| [context](docs/context.md) | 未关闭问题、用户裁定与证据边界 |
| [standalone-dsh](docs/standalone-dsh.md) | 私有 DSH 环境、构建与验证命令 |

开发需要 Linux、Node ≥22.19、pnpm 11.18.0、bubblewrap，以及有权使用的**带补丁 DSH 0.2.0-rc.2 安装**。项目保持私有、未授予开源许可；DSH 可由固定源码和补丁重建。没有该依赖时会明确失败，不会安装 registry 同名包。版本和补丁产物摘要见 [dsh-baseline.json](dsh-baseline.json)，准备步骤见 [standalone-dsh](docs/standalone-dsh.md)。

```sh
pnpm install --frozen-lockfile
pnpm build-private-dsh -- /path/to/new-private-dsh
pnpm setup:host /path/to/new-private-dsh/installed/node_modules/@deepseek-ai
pnpm run doctor
pnpm verify
```

`setup:host` 只验证并生成被 Git 忽略的 `.singularity/` 本地解析配置；checkout 和用户目录可以改变。`pnpm verify` 执行离线 build、测试和 gates，不调用模型。生产效果必须依据[原生实跑证据](docs/e2e-testing.md)。

复杂领域可以先交给一个普通 DSH session 准备环境、Task/suite、初始方法和评分计算器，再审核实际文件：

```sh
export DSH_HOME=/path/to/private-setup-home
node scripts/singularity.mjs env setup ./environment-request.md \
  --workspace /path/to/new-staging --patch /path/to/model-route-only.yml
node scripts/singularity.mjs env approve /path/to/new-staging --reviewer your-name
```

该入口使用原生 headless profile，不创建 Singularity Task、Bubble 或 RSI，准备完成即退出等待一次审核。模型路由补丁不能挂载 Singularity。配置清单、审核与冻结摘要见[环境准备说明](docs/env-setup.md)。

部署前在 `deployment/profile/cordis.patch.yml` 配置模型路由和控制标识，通过 `SINGULARITY_DOMAIN` 指定领域目录，并在独立 DSH home 配置凭据。领域外部工具与只读参考路径也必须在本机存在。

```sh
export DSH_HOME=/path/to/private-home
export DSH_CONTROL_INSTALLED=/path/to/new-private-dsh/installed/node_modules/@deepseek-ai
export SINGULARITY_DOMAIN=/path/to/reviewed-environment/domain
node scripts/deploy.mjs
node scripts/host-runtime.mjs --host 127.0.0.1 --port 7331 --no-open
```

CLI 使用与网页相同的原生服务和认证。把宿主启动时提供的 token 放在 `SINGULARITY_TOKEN`，不要写进命令或报告；也可以使用 `SINGULARITY_COOKIE`。CLI 不读取 host.log，不启动浏览器。

```sh
export SINGULARITY_URL=http://127.0.0.1:7331
pnpm run doctor --host --domain "$SINGULARITY_DOMAIN"
node scripts/singularity.mjs task run ./request.json --request-id my-task-001 --learning off --wait
node scripts/singularity.mjs task status <task-or-session-id>
node scripts/singularity.mjs task cancel <session-id>
```

`request.json` 是完整 TaskContract，例如：

```json
{
  "goal": "写出 2 + 3 的结果",
  "artifact": "result.txt",
  "inputs": [],
  "criteria": [{ "criterionId": "correct", "statement": "result.txt 仅包含 5 和一个换行" }]
}
```

`--learning on|off` 冻结是否启动异步学习，默认开启；`--wait` 等待业务结果，`--wait-learning` 继续等待学习终局。自然语言文件也可直接提交；显式学习开关使用完整 JSON 契约。重发同一请求时保留 `--request-id`、文件内容和工作目录，宿主使用同一 session/prompt 身份恢复。

```sh
node scripts/singularity.mjs experiment run ./suite.json --request-id experiment-001 --wait
node scripts/singularity.mjs experiment report <task-or-session-id> --output ./report.json
```

实验要求 suite 与已部署领域的冻结 suite 摘要完全一致。当前 CLI 只启动第一个 evolve case 的业务 root；有效候选请求 round 后，原生 driver 才执行 evolve 的完整 case×trial 比较，冻结 champion 后再验证 validation/heldout。完整 pilot 逐题执行入口尚未接通，冻结 suite 不会自动补跑其他业务案例。validation/heldout 契约不会随 CLI 提案输入公开。报告从 committed snapshot 导出 suite、campaign 终局、逐轮测量及证据，不维护第二套实验真相。suite 配置与隔离边界见[终局计划](docs/task-first-domain-rsi-plan.md)。

独立迁移目前仅在配置 suite 的发布路径强制执行。无 suite 的单题路径仍可经审核发布，不能将其发布结果当作领域泛化证据；统一发布门槛仍是计划 T08 的未完成项。

`singularity-assembly.evaluationParallelism` 默认 1，可在新实验中设为 4，使固定 suite 内的独立 trial 并行；轮次和发布仍按序推进。并行度进入 execution profile，改变后应开始新实验。同一 search 内相同方法、矩阵、profile 和计分口径的完整 incumbent 证据可复用，保留原 Task/Run 来源；私有验证重新执行。领域 measurement 可以返回 `{quality, metrics: {name: {value, unit}}, detail}`，公式及系数由领域模块定义并随实现摘要固定，各项原始指标保留在 trial 记录和 RSI 反馈。需要标准通过比例时可选 `suite.scoring: "criteria"`，与自定义 measurement 互斥。

仓库只保留 [domain/reference](domain/README.md) 一份配置参考供 env setup agent 阅读。领域适配器、任务、评分器与工具链检查由它生成到用户指定的独立环境包；部署必须显式设置 `SINGULARITY_DOMAIN`，内核没有领域默认值。`pnpm verify:domain -- /path/to/environment` 执行该包自己的 `verify.mjs`。

Git 回退后应重新执行 `pnpm build`，再部署到独立 home/controlId 并检查最终配置。旧日志、旧运行补丁和旧 bundle 不能自动组成一次可恢复的新实验；例如历史草案的 `environmentApproval` 不是当前插件配置字段，审核摘要在启动前核对，不应把该字段继续传给插件。

在原生界面提交完整 TaskContract JSON，或提交自然语言要求：后者作为一条明确的 `request` criterion，与领域可选默认模板的标准一同冻结，不自动拆解或改写含义。没有默认模板时使用 `result.txt`。agent 自主探索、声明子契约并逐层独立验收；简单根任务允许一次完整责任委派。根成功或失败后先返回业务结果，再封存轨迹，异步分析和评估方法候选。通过独立审核的测评赢家可切换唯一方法指针，后续任务固定使用该版本。Singularity map 与右侧 DSH 会话面板读取同一 committed snapshot。模型请求没有 campaign token 预算闸门；成本仅统计一次业务 root、子任务及独立验收截至提交的轨迹，RSI 分析、提案及发布审核用量不参与比较；读取 `token-meter` 的原生 `tokenUsage` 投影，封存至 `subject.json` 的 `summary.usage` 和逐会话 `tokenUsage`，RSI 与 `node scripts/usage-report.mjs <subject.json>` 读取同一统计，口径与 `ui-chat` 的 StatsPills 一致。缺失 usage 遵循原生投影语义，不补算，也不停止模型请求。

新宿主可用 `singularity-assembly.methodFile` 指定初始 method JSON：必须显式包含 `workflowGuidance`（可空，最多 8192 UTF-8 字节）、`templates`（可空）、`skills`、`tools`，不含方法级 `rootTemplate`。`scripts/rsi-campaign.mjs` 仅保留为单题连续运行诊断工具，现已使用同一原生 HTTP 客户端；其本地文件只记录诊断脚本进度，正式 suite 实验使用上述 CLI。重复同题不构成迁移验证。
冻结 Task 的模板来源按原摘要保留，后续方法可修改或删除该模板。业务启动材料携带固定方法的短策略与全局方向；`singularity_read(kind=workflow)` 分页提供同一根内的关系元数据，不扩大产物或会话正文权限。`bound/delivered/read/invoked` 分别记录绑定、宿主送达、读取和调用，不证明模型遵循了策略。RSI 通过 `roots`、`sessions`、`usage`、`steps` 和 `trajectory` 按需查询历史；`subject` 按 UTF-8 字节分页，跟随 `next` 直到 `complete`。提案只写 analysis 和带 value 的 edit.changes，宿主保留未改字段与冻结源码；新批次先对同一份 bytes 做 JSON/schema、派生 Method、实际 diff 与冻结 evolve case/family ID 的纯静态预检，任一文件失败则整批不冻结、不扣槽；通过后才冻结这些 bytes，pending 按附件恢复。每个搜索任务最多冻结 6 个槽、repair=0，冻结后的证据、reserved/prune、critic、duplicate 与 smoke 失败仍消耗额度；相同 digest 不重抽，恢复不重置。critic 通过后才加载/selftest，再进入原生评估。没有待处理提案/评估即可如实提交报告，结果为 `improved / no-improvement / insufficient-evidence`；无需为了结束而发布。

RSI 每次开始或恢复读取 `kind=search` 的 phase、next、预算和 `authoring.proposal/report`；资产、规则、详细反馈分别按需分页。提案准入立即返回，宿主自动继续冻结批次并恢复作者；待定期间关闭作者写入。审核者使用 dispatch 的 `output.template`。三种标准 JSON、证据引用和提交时序见 [RSI agent 工作合同](docs/rsi-agent-contract.md)。

模型请求的流式输出、错误分类、重试和最终失败由 DSH 原生 agent loop、`llm-retry` 与 provider `retryPolicy` 负责。当前部署为 normal 模式、最多重试 20 次，10% 抖动指数退避从 500 毫秒到 3 分钟。部分推理、文本或未执行的工具调用后发生 TRANSPORT 断流，仍可由原生重试恢复；失败 chunks 保存在 `assistant/attempt`，不会进入成功消息或执行其中的工具。不可重试错误和重试耗尽保留原生 `turn/end` 原因，Task 层按该事实记录当前 Run 失败；取消和 attempt 用量同样遵循原生语义。直接 `ctx.llm.stream()` 的背景摘要仍由原生调用者决定重试。

委派区分必须验收的 `required` 责任与可择优、可停止的 `exploration` 分支。全局关系与 RSI 状态不再自动追加到对话；当前责任按需读 `singularity_read(kind=summary)`，任务索引默认每页 20 项，完整关系读 `workflow`。完成通知只发标识和状态，详情按需读取。`singularity_memory()` 首次显式请求才准备本节点的父背景，输入最多 32 KiB、输出额度保留 32768 tokens，后续请求复用 checkpoint；传 ref 只读。单会话压缩由 DSH 原生 BasicCompaction 真正替换上下文，四个 preset 在模型窗口的 70% 触发（本轮 1M 窗口为 700k），保留原生默认尾部策略与 32768 tokens 摘要额度，原始事件不删除。`kind=usage` 的 `audit` 另外披露 memory、compaction 和未知用量，不改原生面板及冻结比较口径。根因与两次真实运行的数据见[上下文与用量审计](docs/runtime-context-audit-20261022.md)。领域规则及外部工具验证属于独立环境包，默认工程回归不执行 EDA、CPU benchmark 或外部领域框架。
