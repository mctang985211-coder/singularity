# RSI 环境准备：一个普通 DSH session

`singularity env setup` 是 RSI 之前的配置入口。它直接调用私有 DSH 自带的 `headless` profile，创建全新的普通顶层 session；一个回合可以使用普通工具调查、写文件和执行验证，最终回答后退出。它不连接 Singularity 宿主，不创建 Task、Bubble、控制日志或 RSI。没有第二套 Agent 调度器。

先配置授权的私有 DSH 安装（见 [standalone-dsh](standalone-dsh.md)），明确选择独立 `DSH_HOME` 和模型路由。环境准备无需部署或构建 Singularity 插件：

```sh
export DSH_HOME=/path/to/private-setup-home
node scripts/singularity.mjs env setup /path/to/request.md \
  --workspace /path/to/new-staging \
  --patch /path/to/model-route.yml
```

`--workspace` 必须位于 Singularity checkout 之外。可以预先放入需要审核、修正的领域素材；同一 staging 只启动一次 session。新的请求使用新的目录。普通 DSH 的权限配置沿用其环境变量；需要跨仓读取参考或调用工具时，使用经过用户授权的原生 DSH 权限配置。`--patch` 可省略，此时使用该 home 的普通 headless 模型配置。它应只包含模型路由等普通 DSH 配置，不能使用包含 `singularity-assembly` 的运行补丁。命令启动前读取 effective config，拒绝挂载 Singularity 插件或角色的配置。

原生进程的临时目录位于 staging 的 `.env-setup/tmp-*`，成功或失败退出后都会清理；会话事件与环境文件保留。入口清除继承的 Git checkout/index/object 环境变量，并以 staging 及其父目录的真实路径设置 `GIT_CEILING_DIRECTORIES`，防止 Git 向上发现 `/home` 等父仓库并快照无关文件。Git 会忽略与初始工作目录相同的 ceiling，因此这里需要同时列出父目录。显式在真实 checkout 中执行 `git -C /path/to/checkout` 仍然可用。

示例路由结构如下，凭据保存在私有 home 或环境变量，不能写入补丁和配置包：

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-provider:
        apiKeyEnv: MY_PROVIDER_KEY
        api: openai-completions
        baseURL: https://provider.example/v1/
        models:
          - id: my-model
            contextWindow: 128000
            maxTokens: 16000
- id: agent-default-model
  config:
    provider: my-provider
    model: my-model
```

默认只生成同领域多任务的内容、验收标准、固定评分策略和供 Agent 试分的必要工具。任务直接放入 suite 的 contract，区分 evolve/validation/heldout 的 family 与 source；这些 contract 表达“做什么、怎样算完成”，不预先决定怎么求解。

用户未明确要求时，不生成 Method、Skill、TaskTemplate、decomposition、workflowGuidance、独立 root Task 文件、求解器、启动脚本或验证框架。领域声明仍名为 `task.json`；未使用的 `inputs`、`templates`、`verifiers` 可省略，不生成空占位资产。宿主已有空 Method seed，后续由 Singularity 自行探索 RSI。

`ENV_SETUP_CONTEXT.md` 直接给出最小 domain/suite/contract 结构和独立验收语义，附四个接口的源码摘要供扩展时查阅；源码不是阅读清单，不再默认引导阅读节点 system prompt、方法资产或模板示例。正式发布比较的每个 split 需要至少三个独立 family、每 case 两次 trial；更小的 suite 仅作冒烟。普通 Task 的评分可用现有通过/criteria 计分，数值目标才需要 measurement。公开试分 CLI 放在 domain 的只读 `references` 子树，用 shell 调用，无需 Method Tool/Skill；suite 和私有检查不得放入公开子树。

评分定义单位、归一化、允许的折中和失败/缺测处理；goal 与硬性 criteria 应保持一致，不要求全局最优或不断产生新高分。用少量已知有效/无效样例检查加载和评分，不搜索更优解。评分规则与调用帮助放在 scorer 的代码/帮助/schema 中，任务内容引用调用命令。检查结果、限制和依赖版本直接进入原生最终答复，由 `.env-setup/run.json` 保留；不默认生成 `SETUP_REVIEW.md` 或重复的评分手册。评测并行度为 1。领域工具的代理指标须如实标明含义，例如 Yosys/OpenSTA 估计不能称为实际布线后 PPA。

配置清单示例：

```json
{
  "version": 1,
  "domain": "domain",
  "files": [
    "setup-manifest.json",
    "domain/task.json",
    "domain/suite.json",
    "domain/public/score.mjs"
  ]
}
```

`files` 列全实际使用的输入、评分代码与参数。所有路径相对 staging；文件和中间目录不得为符号链接。仅用户要求时生成独立 Task 或审核文档，可加可选 `task`/`review` 字段并把文件列入 `files`；已有清单仍可批准。外部依赖记录路径、版本，不由清单复制或冻结，使用前须核对。日志、缓存和临时检查不进入评测依据；未列入清单的文件不受摘要保护。

准备过程的 `.env-setup/` 保存输入提示、effective config、原生 JSON 事件、诊断日志和终局 session 身份。它只是本次普通 session 的记录。模型最终回答和退出码会写入 `run.json`；完成准备仍显示 `approval: pending`。诊断文件可能含领域资料，目录默认只允许当前用户访问。

审核实际文件并作必要修正后，执行一次：

```sh
node scripts/singularity.mjs env approve /path/to/new-staging --reviewer your-name
```

该命令只读取清单、校验路径并记录精确 SHA256，写入 `environment-approval.json`。它不代替人工审核、不执行评分代码、不部署、不启动 RSI，也不覆盖已有批准记录。代理不能批准自己的产物；若用户明确授权协调者代为验收，协调者可以注明授权身份后执行本命令。批准记录应与实验报告一起保留，启动前应比对文件摘要。之后使用现有 `doctor --domain`、宿主部署与 `experiment run` 流程；Task 运行时只获得声明允许的资料。

失败不会改用另一个 Agent 或自动开始实验。检查 `.env-setup/diagnostics.log` 和 `events.jsonl` 后，修复问题并在新 staging 中重新开始；模型未产生完整包时不能执行批准。

## 领域代码归属

仓库的 [domain/reference](../domain/README.md) 展示可选模板和验证器，供需要这些接口时参考，不是默认生成清单。领域文件均放在 staging，不加入 Singularity 源码或产品 spec。部署显式设置 `SINGULARITY_DOMAIN`。已有环境的 `verify.mjs` 仍可由 `pnpm verify:domain -- /path/to/environment` 显式执行；builder 默认不生成它。
