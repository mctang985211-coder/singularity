# 私有 DSH 环境与可移植安装

本仓构建和运行使用独立的 DSH 安装与 home。依赖是 DSH 0.2.0-rc.2，源码基线为 `639ed015397290b3745d163aafe02ffee4aa3f84`，另含 Session log-only 与 TokenMeter/BasicCompaction memory-pressure 两项私有补丁。版本号相同的原始 registry 包不能替代这份构建。

[dsh-baseline.json](../dsh-baseline.json) 记录精确包版本、补丁 SHA256 和所需运行产物 SHA256。`setup:host` 校验这些摘要，只接受由有权提供该依赖的人交付的安装，不下载、不重写安装目录。补丁源码和重放脚本当前由私有环境持有，仓库尚不能独立重建私有宿主；这仍是公开可复现交付的外部前提。宿主自身授权及其第三方通知应随依赖交付保留。本项目 `private: true`、`UNLICENSED` 不替任何第三方重新授予权利。

使用 Linux、Node ≥22.19.0 和 pnpm 11.18.0。普通离线验证不需要模型密钥：

```sh
pnpm install --frozen-lockfile
pnpm setup:host /path/to/private-dsh/node_modules/@deepseek-ai
pnpm run doctor
pnpm verify
```

`setup:host` 生成 `.singularity/dsh` 链接和 `.singularity/tsconfig.host.json`，二者均不入 Git。TypeScript、Vitest、构建、gates 和 standalone 探针使用同一显式宿主；移动 checkout 后重新执行该命令即可。也可设置 `DSH_CONTROL_INSTALLED` 指向安装目录，构建会更新本地配置。缺依赖会显示安装动作，不退回全局安装或 registry。

| 变量 | 用途 |
|---|---|
| `DSH_CONTROL_INSTALLED` | 授权的私有 `node_modules/@deepseek-ai` 目录；未设置时读取 checkout 本地配置 |
| `DSH_HOME` | 独立宿主 home；凭据和原生日志保存在此；禁止指向全局 `~/.dsh` |
| `DSH_BIN` | 可选的私有 dsh 可执行路径；默认从同一安装推导 |
| `SINGULARITY_URL` | CLI 连接的宿主 URL，默认 `http://127.0.0.1:7331` |
| `SINGULARITY_TOKEN` | 宿主当前启动 token；只用于交换原生会话 cookie |
| `SINGULARITY_COOKIE` | 可替代 token 的有效原生 cookie；CLI 不把凭据写入报告 |

未设置 `DSH_HOME` 的 standalone 离线探针使用 checkout 的 `.singularity/home`。正式部署必须明确设置独立 `DSH_HOME`：

```sh
export DSH_HOME=/path/to/private-home
export DSH_CONTROL_INSTALLED=/path/to/private-dsh/node_modules/@deepseek-ai
pnpm build
node scripts/deploy.mjs
/path/to/private-dsh/node_modules/.bin/dsh --profile singularity-next-web --host 127.0.0.1 --port 7331 --no-open
```

`deploy.mjs` 在构建摘要验证通过后重建该 home 下的 `profiles/singularity-next-web/`，把插件链接到当前 checkout。模型路由和领域目录来自 `deployment/profile/cordis.patch.yml`；凭据只进入私有 home。换机器时先调整领域的外部参考和工具路径，`doctor --domain` 会指出不可读的资料。

模型启动后使用 `pnpm run doctor --host` 检查原生模型目录及 snapshot。必须保留 `run`，因为 `pnpm doctor` 是 pnpm 自带命令。项目诊断不会调用模型。没有 route、凭据不可用、401/403 或领域缺项会给出具体失败；CLI 不自动重试鉴权或配置错误。

任务、实验和报告命令见 [README](../README.md)。CLI 和网页复用相同 session/create、session/prompt、Task 取消服务及 committed snapshot，命令不会再创建执行器、队列或实验状态库。取消先提交 Task 终局，再停止下游责任。相同 request-id 的准确重发由原生 prompt 幂等处理；改题目或配置应使用新 request-id。

当前协议和实现状态以[终局计划](task-first-domain-rsi-plan.md)为准。`pnpm verify` 是工程回归，真实 Task、恢复、发布和迁移结论依据[实跑测试](e2e-testing.md)。历史 `singularity-next` 运行目录及使用量证据保留在 [context](context.md)，不证明当前协议已通过领域验收。
