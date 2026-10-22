# 私有 DSH 环境与可移植安装

本仓使用 DSH 0.2.0-rc.2，固定上游 tag `dsh-v0.2.0-rc.2` 与 commit `639ed015397290b3745d163aafe02ffee4aa3f84`。log-only、memory-pressure、pending-only wake 三项源码补丁统一保存在 [third_party/dsh](../third_party/dsh/)，补丁顺序、SHA256、包版本及运行产物摘要统一由 [dsh-baseline.json](../dsh-baseline.json) 固定。版本相同的原始 registry 包不能替代它。

`build-private-dsh` 要求空目标目录：克隆固定 tag 并核对 commit，验证并应用补丁，按上游锁文件和 pnpm 11.7.0 安装依赖，从源码构建 native、全部 host/client 生产项目与 Web，然后校验 baseline。生产项目逐一类型检查；上游聚合配置包含的历史测试 mock 不参与产物构建，wake、log-only 和 pressure 行为由独立回归检查。构建记录保存在目标的 `build-record.json`。可设置 `DSH_SOURCE_REPOSITORY` 使用本地 Git 镜像，commit 校验保持相同。脚本不修改已有宿主、不自动部署，也不自动更新 baseline 来接受差异。

`setup:host` 只校验包版本与列出的产物摘要，生成本地解析配置；编译产物 patch 路径已删除。宿主自身授权及第三方通知随源码/安装保留。本项目 `private: true`、`UNLICENSED` 不替第三方重新授予权利。

使用 Linux、Node ≥22.19.0 和 pnpm 11.18.0。普通离线验证不需要模型密钥：

```sh
pnpm install --frozen-lockfile
pnpm build-private-dsh -- /path/to/new-private-dsh
pnpm setup:host /path/to/new-private-dsh/installed/node_modules/@deepseek-ai
pnpm run doctor
pnpm verify
```

`setup:host` 生成 `.singularity/dsh` 链接和 `.singularity/tsconfig.host.json`，二者均不入 Git。TypeScript、Vitest、构建、gates 和 standalone 探针使用同一显式宿主；移动 checkout 后重新执行该命令即可。也可设置 `DSH_CONTROL_INSTALLED` 指向安装目录，构建会更新本地配置。缺依赖会显示安装动作，不退回全局安装或 registry。

| 变量 | 用途 |
|---|---|
| `DSH_CONTROL_INSTALLED` | 授权的私有 `node_modules/@deepseek-ai` 目录；未设置时读取 checkout 本地配置 |
| `SINGULARITY_DOMAIN` | 部署时显式指定经审核的领域目录，内含 `task.json`；无内置默认领域 |
| `DSH_HOME` | 独立宿主 home；凭据和原生日志保存在此；禁止指向全局 `~/.dsh` |
| `DSH_BIN` | 可选的私有 dsh 可执行路径；默认从同一安装推导 |
| `SINGULARITY_URL` | CLI 连接的宿主 URL，默认 `http://127.0.0.1:7331` |
| `SINGULARITY_TOKEN` | 宿主当前启动 token；只用于交换原生会话 cookie |
| `SINGULARITY_COOKIE` | 可替代 token 的有效原生 cookie；CLI 不把凭据写入报告 |

未设置 `DSH_HOME` 的 standalone 离线探针使用 checkout 的 `.singularity/home`。正式部署必须明确设置独立 `DSH_HOME`：

```sh
export DSH_HOME=/path/to/private-home
export DSH_CONTROL_INSTALLED=/path/to/new-private-dsh/installed/node_modules/@deepseek-ai
export SINGULARITY_DOMAIN=/path/to/reviewed-environment/domain
pnpm build
node scripts/deploy.mjs
node scripts/host-runtime.mjs --host 127.0.0.1 --port 7331 --no-open
```

`deploy.mjs` 在构建摘要验证通过后重建该 home 下的 `profiles/singularity-next-web/`，把插件链接到当前 checkout。模型路由来自 `deployment/profile/cordis.patch.yml`，领域目录由 `SINGULARITY_DOMAIN` 显式传入；凭据只进入私有 home。换机器时先调整领域的外部参考和工具路径，`doctor --domain` 会指出不可读的资料。

`host-runtime.mjs` 仍启动同一原生 DSH 宿主，默认使用 `singularity-next-web`；额外的 `--patch`、端口等参数继续传给 DSH。它把 `TMPDIR/TMP/TEMP` 指向 `$DSH_HOME/.singularity-runtime/tmp-*`，用 Linux `flock` 防止同一 home 同时启动两个受管宿主。正常或失败退出后清理临时目录；启动器被强制终止时，锁由仍在运行的原生宿主持有，直到宿主退出，下次启动再清理遗留临时目录。会话、封存产物、测量与审核记录不在清理范围内。

启动器最后追加 `deployment/runtime.patch.yml`，关闭网页编辑器的整仓库 Git 快照；Singularity 使用自己的封存产物和原生持久化证据。Git ceiling 同时覆盖启动目录、home 及其父目录，防止独立运行目录误识别用户主目录的 Git 仓库。原生子会话传递 parent/origin/delegationDepth，以保持 DSH 的生命周期所有权和子会话行为。不要通过直接运行旧宿主命令绕过这套临时目录管理。

模型启动后使用 `pnpm run doctor --host` 检查原生模型目录及 snapshot。必须保留 `run`，因为 `pnpm doctor` 是 pnpm 自带命令。项目诊断不会调用模型。没有 route、凭据不可用、401/403 或领域缺项会给出具体失败；CLI 不自动重试鉴权或配置错误。

任务、实验和报告命令见 [README](../README.md)。CLI 和网页复用相同 session/create、session/prompt、Task 取消服务及 committed snapshot，命令不会再创建执行器、队列或实验状态库。取消先提交 Task 终局，再停止下游责任。相同 request-id 的准确重发由原生 prompt 幂等处理；改题目或配置应使用新 request-id。

当前协议和实现状态以[终局计划](task-first-domain-rsi-plan.md)为准。`pnpm verify` 是工程回归，真实 Task、恢复、发布和迁移结论依据[实跑测试](e2e-testing.md)。历史 `singularity-next` 运行目录及使用量证据保留在 [context](context.md)，不证明当前协议已通过领域验收。

`pnpm verify` 的基础前提是 Node/pnpm、重建的 DSH、Linux、Git 与 Bubblewrap，不调用模型或领域 EDA/benchmark。实际领域工具链的验证由 `pnpm verify:domain -- /path/to/environment` 显式执行；缺入口会明确 SKIP，不作为领域成功。仓库仅保留 [标准参考](../domain/README.md)，领域任务和适配器均属于外部环境包。
