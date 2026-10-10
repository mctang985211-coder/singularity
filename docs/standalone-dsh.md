# 独立 DSH 环境（singularity-next）

**一套完全私有的 DSH 运行环境**：单独安装的 dsh、单独的 home，与全局实例（`~/.dsh`）和
harness 内实例（`harness/.dsh`）**零共享状态**。singularity-core 的探针、测试与真实模型
调用全部走这里，开发循环不碰任何其他 DSH。

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

## env.sh 导出的六个变量

| 变量 | 值 | 作用 |
|---|---|---|
| `PATH`（前插） | `…/dsh/node_modules/.bin` | `dsh` 命令解析到私有安装 |
| `DSH_CONTROL_INSTALLED` | `…/dsh/node_modules/@deepseek-ai` | 探针的模块 resolve hook（[dsh-control-runtime.mjs](../scripts/dsh-control-runtime.mjs)）从这里解析全部 `@deepseek-ai/*` |
| `DSH_HOME` | `…/home` | credentials-local 读 `$DSH_HOME/.credentials.yaml`；任何会话/存储状态落这里 |
| `SINGULARITY_LLM_PROVIDER` / `_MODEL` / `_BASE_URL` | `yingjun` / `deepseek-v4.1-flash` / `https://yingjun.xyz/v1` | [llm-route.mjs](../scripts/llm-route.mjs) 的路由覆盖 |
| `SINGULARITY_LLM_API` | `openai-responses` | 网关协议：Responses 端点（`<baseURL>/responses`） |
| `SINGULARITY_LLM_API_KEY_ENV` / `_REASONING` | `YINGJUN_API_KEY` / `max` | 凭据的 env 键名 + 思考强度（pi-ai 的 `GenerateOptions.reasoningEffort`） |

不 source env.sh 时，llm-route 回到部署默认路由（commandcode），探针 hook 回到全局安装
`DSH_CONTROL_INSTALLED`——两套配置互不覆盖，谁也没写死谁。

## 用法

```sh
. /home/ROXY/singularity-next/env.sh
cd /home/ROXY/code/singularity-core
pnpm verify                 # 测试+门禁，无需网络
node scripts/model-smoke.mjs        # 真实模型冒烟（yingjun，已实测通过）
node scripts/rsi-live.mjs           # 全流程 RSI 回合（真实模型，消耗额度）
```

## 已验证（2026-10-11）

- `dsh --version` → **0.2.0-rc.2**（与全局安装、harness checkout 三方同版本，将来接
  profile 契约零落差）；
- `model-smoke.mjs` 在这套环境端到端通过：§1 真实补全（yingjun responses，4201ms，
  回答 `"four"`）+ §2 真实 agent turn（完整事件序列、session 持有模型产出的 assistant 消息）；
- **隔离证明**：冒烟后三方核对——独立 home 无会话残留（探针按纪律把会话写进各自的
  `mkdtemp` tmpdir，home 只供凭据读取）、`~/.dsh/sessions` 与 `harness/.dsh/sessions`
  的目录清单与运行前逐字相同。

## 边界（写下来，防止第三次踩）

- **不要**把 `DSH_HOME` 指回 `~/.dsh` 或 `harness/.dsh`，也**不要**在另两个 home 里找
  本环境的会话——本环境的任何落盘状态只在 `home/`；
- 私有安装升级 = 改 env.sh 旁的版本锁定重新 `npm install`，**不做** in-place 更新全局或
  harness 的任何文件；
- 与 harness 的集成是 **G2/G3 的事**，接入缝是 profile 契约（`assembly-blueprint.md` §8）：
  届时把构建好的 profile 包挂进宿主，而不是让开发循环依赖 harness 启动器
  （其 launcher 依赖 python≥3.7，本机是 3.6，本来就不能直接用）；
- yingjun 路由同样配置在 harness 的 `config.yml` 里（供旧 singularity 实例备选），两边
  各自持有一份凭据副本，删除/轮换其一不影响另一个。
