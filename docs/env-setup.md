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

原生进程的临时目录位于 staging 的 `.env-setup/tmp-*`，成功或失败退出后都会清理；会话事件与审核文件保留。入口清除继承的 Git checkout/index/object 环境变量，并以 staging 及其父目录的真实路径设置 `GIT_CEILING_DIRECTORIES`，防止 Git 向上发现 `/home` 等父仓库并快照无关文件。Git 会忽略与初始工作目录相同的 ceiling，因此这里需要同时列出父目录。显式在真实 checkout 中执行 `git -C /path/to/checkout` 仍然可用。

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

入口生成 `ENV_SETUP_CONTEXT.md`，提供当前 checkout 的架构、Task、模板、领域、方法、suite、measurement 和宿主配置源码路径与启动时摘要。源码是格式依据；终局计划包含未实施设计，不能直接作为配置 schema。请求文件负责定义领域目标、允许的工具、参考源码、成本边界和禁止的操作。入口不内置 PPA 系数或预设领域任务。

Agent 需要生成 `SETUP_REVIEW.md`，解释任务范围、参考与版本、评分公式、参数/单位/归一化、各项加权贡献、失败与缺测规则、真实验证结果以及启动命令。评分应展示不同有效候选能产生可区分的结果，同时独立列出正确性门槛。使用 Yosys/OpenSTA 的估计必须说明库、约束和代理含义，不能称为实际布线后芯片 PPA。禁止执行的昂贵仿真应在请求里明确列出。

配置清单示例：

```json
{
  "version": 1,
  "domain": "domain",
  "task": "request.json",
  "review": "SETUP_REVIEW.md",
  "files": [
    "setup-manifest.json",
    "SETUP_REVIEW.md",
    "request.json",
    "domain/task.json",
    "domain/suite.json",
    "domain/measurement.mjs",
    "scoring-policy.json",
    "score-examples.json"
  ]
}
```

`files` 必须补全实际使用的评估器、私有 oracle、输入、方法/Skill/Tool、来源快照和参数文件。路径均相对 staging；文件和中间目录不能是符号链接。外部工具与源码引用在审核材料中记录路径、版本和修订号。它们不由该清单复制或冻结，部署前仍须检查其一致性。未列入清单的文件也不受摘要冻结保护。原生会话日志、构建缓存和临时产物不进入评测依据。

准备过程的 `.env-setup/` 保存输入提示、effective config、原生 JSON 事件、诊断日志和终局 session 身份。它只是本次普通 session 的记录。模型最终回答和退出码会写入 `run.json`；完成准备仍显示 `approval: pending`。诊断文件可能含领域资料，目录默认只允许当前用户访问。

审核实际文件并作必要修正后，执行一次：

```sh
node scripts/singularity.mjs env approve /path/to/new-staging --reviewer your-name
```

该命令只读取清单、校验路径并记录精确 SHA256，写入 `environment-approval.json`。它不代替人工审核、不执行评分代码、不部署、不启动 RSI，也不覆盖已有批准记录。代理不能批准自己的产物；若用户明确授权协调者代为验收，协调者可以注明授权身份后执行本命令。批准记录应与实验报告一起保留，启动前应比对文件摘要。之后使用现有 `doctor --domain`、宿主部署与 `experiment run` 流程；Task 运行时只获得声明允许的资料。

失败不会改用另一个 Agent 或自动开始实验。检查 `.env-setup/diagnostics.log` 和 `events.jsonl` 后，修复问题并在新 staging 中重新开始；模型未产生完整包时不能执行批准。
