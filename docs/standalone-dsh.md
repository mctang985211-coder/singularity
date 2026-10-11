# 独立 DSH 环境（singularity-next）

**一套完全私有的 DSH 运行环境**：单独安装的 dsh、单独的 home，与全局实例（`~/.dsh`）和
harness 内实例（`harness/.dsh`）**零共享状态**。singularity-core 的探针、测试与真实模型
调用全部使用这里的私有安装与凭据。产品状态落专用 home；探针可以使用各自的临时测试 home/control，开发循环不碰其他 DSH 的状态。

## 布局

```text
/home/ROXY/singularity-next/
  dsh/                  私有 dsh 安装：npm 精确锁定 @deepseek-ai/dsh@0.2.0-rc.2
    node_modules/.bin/dsh        可执行入口（dsh --version 即 0.2.0-rc.2）
    node_modules/@deepseek-ai/   探针 resolve hook 的解析根（DSH_CONTROL_INSTALLED）
  home/                 专用 DSH_HOME：凭据与任何落盘状态只在这里
    .credentials.yaml            refs 表，现仅 YINGJUN_API_KEY（600 权限）
  env.sh                唯一的接线点：source 它，之后所有 dsh 相关进程都在这套环境里
```

## env.sh 导出的变量

| 变量 | 值 | 作用 |
|---|---|---|
| `PATH`（前插） | `…/dsh/node_modules/.bin` | `dsh` 命令解析到私有安装 |
| `DSH_CONTROL_INSTALLED` | `…/dsh/node_modules/@deepseek-ai` | 探针的模块 resolve hook（[dsh-control-runtime.mjs](../scripts/dsh-control-runtime.mjs)）从这里解析全部 `@deepseek-ai/*` |
| `DSH_HOME` | `…/home` | credentials-local 读 `$DSH_HOME/.credentials.yaml`；任何会话/存储状态落这里 |
| `SINGULARITY_LLM_PROVIDER` / `_MODEL` / `_BASE_URL` | `yingjun` / `deepseek-v4.1-flash` / `https://yingjun.xyz/v1` | [llm-route.mjs](../scripts/llm-route.mjs) 的路由覆盖 |
| `SINGULARITY_LLM_API` | `openai-responses` | 网关协议：Responses 端点（`<baseURL>/responses`） |
| `SINGULARITY_LLM_API_KEY_ENV` / `_REASONING` | `YINGJUN_API_KEY` / `max` | 凭据的 env 键名 + 思考强度（pi-ai 的 `GenerateOptions.reasoningEffort`） |

运行前统一 source env.sh。当前探针 hook 在变量缺省时也解析到本私有安装/home，**不会回到全局安装**；
模型路由缺省仍由 `llm-route.mjs` 的部署默认值决定，因此正式验收同时核对实际 session request header 的 provider/model。
`PATH` 中的裸 dsh 与探针显式解析入口是不同接线，不能据 hook 缺省安全就省略 env.sh。

## 用法

```sh
. /home/ROXY/singularity-next/env.sh
cd /home/ROXY/code/singularity-core
pnpm build                         # core 类型检查，不覆盖 assembly，不产出装配 JS
pnpm exec tsc -p assembly/tsconfig.json --noEmit
pnpm test                          # 单元/spec 回归
node scripts/gates.mjs --probe      # 静态门禁检测器自检
pnpm verify                        # build + test + gates：全部离线，不含任何探针
node scripts/model-smoke.mjs        # 真实模型冒烟
node scripts/rsi-live.mjs           # 脚本级 RSI 证据，不能代替产品闭环

# 装配层产品路径：构建 → 落私有 profile → 浏览器验证
node assembly/build.mjs
node scripts/deploy.mjs
node scripts/browser-probe.mjs            # 真实 Chromium + 真实模型：工具、判决、receipt
node scripts/browser-probe.mjs --recovery # 当前只在 propose turn 完成后重启，未覆盖在飞求解
node scripts/browser-probe.mjs --panel       # 真浏览器读面板与同 cut 一致
node scripts/browser-probe.mjs --decompose   # 真实依赖链：子任务产物进入后序输入
node scripts/browser-probe.mjs --submitted   # durable submitted 后真实 SIGKILL 恢复
node scripts/browser-probe.mjs --aborted     # 原生 Stop 的准确 session 失败出口
dsh --profile singularity-next-web --host 127.0.0.1 --port 7331 --no-open   # 手动点一次
```

`pnpm verify` 是**离线**回归：它不启动浏览器、不调用模型。任何「产品合同已通过」的结论只能来自上面
带 `--` 的探针，或来自最终的单命令验收（见 [assembly-blueprint §9](assembly-blueprint.md#9-剩余构建顺序与检查点)）。

部署出来的 profile 在 `home/profiles/singularity-next-web/`（`scripts/deploy.mjs` 整目录重写；linked root
指向本 checkout 的 `assembly/`）。模型路由与领域目录都写在 `deployment/profile/cordis.patch.yml`，
凭据仍只在本 home 的 `.credentials.yaml`。

## 历史环境实测（2026-10-11；不代表本轮新合同通过）

- `dsh --version` → **0.2.0-rc.2**（与全局安装、harness checkout 三方同版本，将来接
  profile 契约零落差）；
- `model-smoke.mjs` 在这套环境端到端通过：§1 真实补全（yingjun responses，4201ms，
  回答 `"four"`）+ §2 真实 agent turn（完整事件序列、session 持有模型产出的 assistant 消息）；
- **隔离证明**：冒烟后三方核对——独立 home 无会话残留（探针按纪律把会话写进各自的
  `mkdtemp` tmpdir，home 只供凭据读取）、`~/.dsh/sessions` 与 `harness/.dsh/sessions`
  的目录清单与运行前逐字相同。

## 当前验收与完成边界

基线 `35b0c7c` 的本轮复核已通过 core typecheck、assembly 独立 typecheck、spec 回归和门禁自检；
未重新部署、未运行真实模型、未重跑完整 `pnpm verify`。反例与当前探针缺口见 [context.md §18](context.md#18-g1g2-接手审核与用户裁定2026-10-11基线-35b0c7c)。
新 G1/G2/G3 与最终发布验收按 [assembly-blueprint.md §9](assembly-blueprint.md#9-剩余构建顺序与检查点) 交付，不能据上述历史 smoke 标为完成。

## 环境边界

- **不要**把 `DSH_HOME` 指回 `~/.dsh` 或 `harness/.dsh`，也**不要**在另两个 home 里找
  本环境的会话——本环境的任何落盘状态只在 `home/`；
- 私有安装升级 = 改 env.sh 旁的版本锁定重新 `npm install`，**不做** in-place 更新全局或
  harness 的任何文件；
- **本次 G1/G2/G3 全部在私有独立 DSH 完成**，不以旧 harness 启动或集成为前置；旧仓只读参考。
- 最终验收使用隔离测试 home/profile 装载被验证的同一插件产物，保留私有凭据来源；不重写已有用户会话或全局配置。
- 模型调用的有限预算与领域效果阈值在 G3 实验前冻结；探针自动批准不算真实 Web 人审。
