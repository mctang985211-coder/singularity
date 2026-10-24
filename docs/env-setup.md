# RSI 环境准备：按表验证的普通 DSH session

`singularity env setup` 是 RSI 之前的配置入口。信息不完整时使用 `--interactive`：启动私有 DSH 自带的 Web profile，并通过官方 `session/create`、`session/prompt` 创建一个普通 `env-setup` session。用户在 DSH 官方 TODO 和提问窗口中选择配置、补充资料、提出审核意见；修改在同一个 session 中完成。不连接已有 Singularity 宿主，不创建业务 Task 或启动 RSI。

交互 preset 只启用普通文件、搜索、shell、`todo_write` 和 `ask_user_question` 工具。没有额外调度器、子 Agent、Skill、角色指令或领域求解方法。省略 `--interactive` 则保留原生 headless 批处理入口：它没有答题界面，遇到必须由用户决定的缺项应报告阻塞，不能猜测后继续。

先配置授权的私有 DSH 安装（见 [standalone-dsh](standalone-dsh.md)），明确选择独立 `DSH_HOME` 和模型路由。环境准备无需部署或构建 Singularity 插件：

```sh
export DSH_HOME=/path/to/private-setup-home
node scripts/singularity.mjs env setup /path/to/request.md --interactive \
  --workspace /path/to/new-staging \
  --patch /path/to/model-route.yml
```

`--workspace` 必须位于 Singularity checkout 之外。可以预先放入需要审核、修正的领域素材；同一 staging 只创建一次 session。交互模式自动选择本机空闲端口并打开原生 Web UI；选择命令打印的 env-setup session。命令保持前台运行，Ctrl+C 停止这个准备宿主，配置和原生对话保留。新的请求使用新的目录。普通 DSH 的权限配置沿用其环境变量；`--patch` 只放模型路由等普通 DSH 配置，不能包含 `singularity-assembly`。命令启动前检查 effective config，拒绝挂载 Singularity 插件或角色。

`ENV_SETUP_CONTEXT.md` 中只有一张按顺序填写的配置表和最小接口说明。builder 先用官方 `todo_write` 建立六项 TODO，加上最后一项用户审核，每次只进行一项；具体配置值及验证命令/证据保存在 `.env-setup/config.json`，不成为 RSI 的提示词或方法资产。

| 顺序 | 填什么 | 完成依据 |
|---|---|---|
| 1. tasks | 用户任务、来源版本、交付物、family/source/split、权重、trials、正式迁移或冒烟范围 | 不编造任务或独立性，覆盖与用户选择一致 |
| 2. runtime | 实际可用的解释器/工具、CPU/GPU、线程、超时和预算 | 在真实 Bubble 内探测；评测并行度为 1 |
| 3. acceptance | 返回值、声明输出、允许的原地修改、容差、尺寸和 seed | 先让每个保留的基线通过正确性；源码与元数据冲突交给用户决策 |
| 4. scoring | 单位、方向、基线、目标、公式、hard guard、失败/缺测、质量/成本权重和噪声 | 校准与候选使用相同计时和重置方式；错误候选返回 business-failure，装置故障抛错 |
| 5. visibility | 本题 protected inputs、公共参考/评分器、私有 suite/检查 | 宿主评分使用现有 spawnProcess 显式 Bubble；describe 不列出私有题目 |
| 6. verification | 清单及实际 CLI、宿主 measurement、有效/错误/畸形/缺失候选、越权读取的验证 | 保留原始证据，通过 env check，工具名不能与 core 的 node 重复 |

问题只问用户拥有的选择和无法通过本地检查解决的歧义；已给出的答案直接复用。用官方 `ask_user_question` 批量给出相关选项，推荐项放首位，保留自定义回答。基线无效、需要删题、改变输出约定/容差或降为冒烟时，提交证据让用户选择；不能静默处理。问题窗口使用原生 timed 模式，120 秒前台等待结束后仍可在同一 session 回答；pending、跳过、取消都不是同意，依赖答案的 TODO 保持未完成。

六项通过后，在同一窗口展示已填写配置、实际文件、范围变化、验证结果和限制，请用户选择“完成审核 / 提出修改 / 暂缓”。修改只重验受影响部分；通过后停止增加功能和文档。签署精确文件摘要仍由外部 `env approve` 完成，builder 不自行签署自己的产物。

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

默认只将用户提供的同领域任务整理为内容、验收标准、固定评分策略和供 Agent 试分的必要工具。builder 不自行编造任务、family、独立性或用户尚未给出的设计目标；缺少任务定义或 split 覆盖时报告缺项。任务直接放入 suite 的 contract，区分 evolve/validation/heldout 的 family 与 source；这些 contract 表达“做什么、怎样算完成”，不预先决定怎么求解。

用户参考资料在准备阶段进入：相关的公开技术文档放入只读 `references` 子树，case 特有的不可变资料作为声明并冻结摘要的 `inputs`。只建立必要索引，不默认复制整套 `.agents`，也不把其中角色、审批策略和旧工作流激活为节点指令；用户明确指定的强制交付条件应进入 contract。私有 validation/heldout 内容与答案不进入公共参考目录。具体芯片资料清单及四模型的统计限制见[启动说明](rsi-startup-and-chip-workloads.md)。

用户未明确要求时，不生成 Method、Skill、TaskTemplate、decomposition、workflowGuidance、独立 root Task 文件、求解器、启动脚本或验证框架。领域声明仍名为 `task.json`；未使用的 `inputs`、`templates`、`verifiers` 可省略，不生成空占位资产。宿主已有空 Method seed，后续由 Singularity 自行探索 RSI。

上下文附四个接口的源码摘要供扩展时查阅；源码不是阅读清单。正式发布比较的每个 split 需要至少三个独立 family、每 case 两次 trial；更小的 suite 仅作冒烟。普通 Task 的评分可用现有通过/criteria 计分，数值目标才需要 measurement。公开试分 CLI 放在 domain 的只读 `references` 子树，用 shell 调用，无需 Method Tool/Skill；suite 和私有检查不得放入公开子树。

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

`.env-setup/` 保存输入提示、配置表、effective config、检查报告和诊断日志，仅用于本次准备。headless 的原生 JSON 事件、最终回答和退出码写入本目录；交互模式在 `run.json` 记录 session 身份及不含凭据的地址，对话、TODO 和审核答案由该私有 home 的原生 Session 持久化。Web 启动凭据不写入这些记录。`approval: pending` 表示尚未签署环境包，不能仅凭模型自述认定已批准。

完成配置后执行：

```sh
node scripts/singularity.mjs env check /path/to/new-staging
```

它不调用模型、不启动任务，检查六项配置有值和证据、清单完整列出领域文件、真实 domain/suite 加载、输入摘要、工具重名、protected inputs 未被公共挂载、measurement 参数未包含私有 case ID；报告各 split 的 family/trial 覆盖，不足则标为 smoke-only，报告写入 `.env-setup/check.json`。这是结构检查，不能代替表中实际 Bubble、评分和数值正确性试验，也不能证明用户声称的 family 独立性。评分装置不一致应先修复，不能用不断追加提示词绕过。

审核实际文件并作必要修正后，执行一次：

```sh
node scripts/singularity.mjs env approve /path/to/new-staging --reviewer your-name
```

该命令对新 builder 包重跑 `env check`，再校验路径并记录精确 SHA256，写入 `environment-approval.json`；未使用配置表的旧包保留原有显式审核路径。它不代替人工审核，不调用 measure、不部署、不启动 RSI，也不覆盖已有批准记录。代理不能批准自己的产物；若用户明确授权协调者代为验收，协调者可以注明授权身份后执行本命令。批准记录应与实验报告一起保留，启动前比对文件摘要。

正常的补充信息、审核反馈和环境修改在交互 session 内继续，不需要重新构建一轮。原生进程启动失败时检查诊断；headless 异常退出后的重试仍使用新 staging。没有完整环境包和验证证据时不能批准，不自动改用其他 Agent 或开始实验。

## 领域代码归属

仓库的 [domain/reference](../domain/README.md) 展示可选模板和验证器，供需要这些接口时参考，不是默认生成清单。领域文件均放在 staging，不加入 Singularity 源码或产品 spec。部署显式设置 `SINGULARITY_DOMAIN`。已有环境的 `verify.mjs` 仍可由 `pnpm verify:domain -- /path/to/environment` 显式执行；builder 默认不生成它。
