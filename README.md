# singularity-core

面向领域任务的 RSI 内核与 DSH 插件。Task 表达冻结责任，独立 ReviewRun 判断交付；根任务终局后异步改进 TaskTemplate、Skill、Tool，经独立测评和发布审核切换唯一方法指针。

当前协议为 Task v18、Review v5，读投影为 v9。工程验证和真实 RSI 证据分别记录于现有 context 与实跑文档。

| 阅读入口 | 用途 |
|---|---|
| [blueprint](docs/blueprint.md) | 目标、架构与文档导航 |
| [assembly-blueprint](docs/assembly-blueprint.md#9-剩余构建顺序与检查点) | 唯一施工顺序与退出条件 |
| [phase-g2-design](docs/phase-g2-design.md) | 当前任务运行合同 |
| [context](docs/context.md) | 未关闭问题、用户裁定与证据边界 |
| [standalone-dsh](docs/standalone-dsh.md) | 私有 DSH 环境、构建与验证命令 |

开发与验收使用 `/home/ROXY/singularity-next/`，旧 harness 仅作只读参考。

```sh
. /home/ROXY/singularity-next/env.sh
pnpm build
pnpm exec tsc -p assembly/tsconfig.json --noEmit
pnpm test
node scripts/gates.mjs --probe
```

装配产物由 `node assembly/build.mjs` 构建。`pnpm verify` 是**离线**回归（build + test + gates），
不启动浏览器也不调用模型：它全绿**不构成**产品合同已通过的证据。产品证据来自
[实跑测试](docs/e2e-testing.md) 的原生界面任务、会话、封存产物、判决及发布记录。

```sh
. /home/ROXY/singularity-next/env.sh
node scripts/deploy.mjs
dsh --profile singularity-next-web --host 127.0.0.1 --port 7331 --no-open
```

在原生界面提交领域目标与自然语言验收要求。入口接纳根 Task/Run；agent 自主探索、直接声明一次性子契约并逐层独立验收。根成功或失败后先返回业务结果，再封存轨迹，异步分析和评估方法候选。可靠赢家自动切换统一发布指针，后续任务固定使用该版本。Singularity map 与右侧 DSH 会话面板读取同一 committed snapshot。模型请求没有 campaign token 预算闸门；成本仅统计一次业务 root、子任务及独立验收截至提交的轨迹，RSI 分析、提案及发布审核用量不参与比较；读取 `token-meter` 的原生 `tokenUsage` 投影，封存至 `subject.json` 的 `summary.usage` 和逐会话 `tokenUsage`，RSI 与 `node scripts/usage-report.mjs <subject.json>` 读取同一统计，口径与 `ui-chat` 的 StatsPills 一致。缺失 usage 遵循原生投影语义，不补算，也不停止模型请求。

连续运行使用 `node scripts/rsi-campaign.mjs <experiment-directory> [轮数，默认 5]`，读取实验的 `experiment.json`、`request.txt` 和宿主登录入口，每轮等待业务与 RSI 完成后创建全新 root/session/工作区，沿用最新发布 method；进度写入 `campaign.json`。新宿主可用 `singularity-assembly.methodFile` 指定经验证的初始 method JSON。RSI 通过 `singularity_read` 的 `roots` 查本 campaign 已关闭轮次，再用 `rootId` 分别查询 `sessions`、`usage`、`steps`，或用 `trajectory` 与 `ref=sessionId` 分页列出事件索引，再指定 `eventSeq` 按字节回读正文。`subject` 同样按字节读取本节点的封存任务材料，跟随 `next` 直到 `complete`；历史不自动注入提示词。RSI 将候选 JSON 交给 `singularity_propose_method({path})`，运行时绑定基线与轮号，先做结构检查和独立泄漏审查，拒绝时返回修订原因；通过后复用已封存业务基线、隔离试跑并自动选择和审核发布。无赢家时原会话读取结果后修订再提案。

所有模型调用（包括父背景、压缩和 RSI）失败后固定每 5 分钟重试，首次调用后最多再试 20 次；耗尽后只报告 provider 不稳定并结束整张图，不向节点传播 provider 失败。面板显示「一键重启」，使用原始根任务、模型配置和工作目录创建新图，重试次数归零，旧图记录和证据保留；宿主重启后仍可操作。主动取消不触发 provider 重试。

委派区分必须验收的 `required` 责任与可择优、可停止的 `exploration` 分支。父背景默认生成结构化 checkpoint；`singularity_memory` 提供可读分支的统一分页目录，标出本节点继承背景，按 ref 自行选择阅读全文。单会话上下文压缩由 DSH 原生 BasicCompaction 管理。CPU 快速回归使用 `deployment/domain/polybench` 的 PolyBench/C 3mm：仅提供参考 C、固定评测入口与任务声明，最多 4 核、4 线程，数值正确且实测加速至少 1.20 倍即可交付。SHA256 领域仅提供一份 RTL、固定 Yosys 综合指导和必要任务声明，面积及功能由独立审核按实际证据验收。
