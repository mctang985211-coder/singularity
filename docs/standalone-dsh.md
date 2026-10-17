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
    .credentials.yaml            refs 表，现为 DEEPSEEK_API_KEY 与 YINGJUN_API_KEY（600 权限）
  env.sh                唯一的接线点：source 它，之后所有 dsh 相关进程都在这套环境里
  dsh-source/           隔离 DSH 源码，Session.append 暴露既有 ignorable 日志标记
  dsh-session-log-only.patch       可审查的 Session 源补丁
  dsh-session-log-only-install.mjs 编译、测试并安装私有 Session 的重放入口
```

父背景 memory 默认在子 Task 执行前生成；`singularity_memory()` 从原生日志分页投影可读分支的统一目录，inherited 标出本节点父背景引用，传 ref 按需读取完整 checkpoint。目录标明适用 Task/Run、来源截止位置和当前状态，不额外调用模型；root 看整树、普通节点沿用任务可见范围且不跨根、独立审核只看自己取证分支。摘要不自动注入子 system prompt。单 Session 超过上下文阈值的压缩由原生 BasicCompaction 决定，assembly 不定制其摘要。父背景与四个 preset 的原生摘要输出上限均为 32768 tokens，轮次结束后统一读取 token-meter 的 tokenUsage 原生投影，与 ui-chat 的 StatsPills 使用同一计费桶总和，不另计辅助调用；缺失 usage 不停止执行。父背景调用及 checkpoint 以原始 stream 写入会话 log-only 事件，供证据回读。

私有 Session 使用上述最小源补丁；`node /home/ROXY/singularity-next/dsh-session-log-only-install.mjs` 可重放编译、定向测试及安装，摘要和命令记录于同目录 dsh-session-log-only-evidence.json。它不更改会话格式版本、模型 surface 或全局安装。裸重装原始 rc.2 后，必须重放此补丁才能使用当前 assembly。

私有 DSH 另用 `node /home/ROXY/singularity-next/dsh-memory-pressure-install.mjs` 重放 TokenMeter 与 BasicCompaction 修复，源补丁、命令和产物摘要位于同目录 dsh-memory-pressure.patch、dsh-memory-pressure-evidence.json。相同请求配置优先采用供应商实际 usage；上下文替换或图片 offload 后清除旧计价基准，重新估算当前内容。自动压力压缩失败终止当前回合，截断保留 `MAX_TOKENS`，不继续执行任务或逐步重试。安装只覆盖这两个私有包，并校验 Session 补丁产物未变。

## env.sh 导出的变量

| 变量 | 值 | 作用 |
|---|---|---|
| `PATH`（前插） | `…/dsh/node_modules/.bin` | `dsh` 命令解析到私有安装 |
| `DSH_CONTROL_INSTALLED` | `…/dsh/node_modules/@deepseek-ai` | 探针的模块 resolve hook（[dsh-control-runtime.mjs](../scripts/dsh-control-runtime.mjs)）从这里解析全部 `@deepseek-ai/*` |
| `DSH_HOME` | `…/home` | credentials-local 读 `$DSH_HOME/.credentials.yaml`；任何会话/存储状态落这里 |

运行前统一 source env.sh。当前探针 hook 在变量缺省时也解析到本私有安装/home，**不会回到全局安装**；
`PATH` 中的裸 dsh 与探针显式解析入口是不同接线，不能据 hook 缺省安全就省略 env.sh。

## 用法

```sh
. /home/ROXY/singularity-next/env.sh
cd /home/ROXY/code/singularity-core
pnpm build
pnpm test
pnpm gates
node scripts/deploy.mjs
dsh --profile singularity-next-web --host 127.0.0.1 --port 7331 --no-open
```

从原生界面提交领域任务和自然语言验收要求，节点通过普通 DSH 主 agent 会话自主执行。root 只协调与受限只读，必须委派实现；子责任显式区分 `required` 与可停止的 `exploration`。断点核对 Task/Run、封存产物、独立判决、资产使用和发布记录。离线回归不能证明领域效果。

部署出来的 profile 在 `home/profiles/singularity-next-web/`（`scripts/deploy.mjs` 整目录重写；linked root
指向本 checkout 的 `assembly/`）。模型路由与领域目录都写在 `deployment/profile/cordis.patch.yml`，
凭据仍只在本 home 的 `.credentials.yaml`。

## 历史环境实测（2026-10-11；不代表本轮新合同通过）

- `dsh --version` → **0.2.0-rc.2**（与全局安装、harness checkout 三方同版本，将来接
  profile 契约零落差）；
## 当前验收与完成边界

当前协议为 Task v17、Review v4、snapshot v9。本轮修复父背景 memory、任务责任投影和可停止探索，精简 SHA256 领域；冻结 Task v15 的 max 思考 SHA256 实跑 `/home/ROXY/singularity-next/sha256-max-20261015-154731/` 已因原生压缩提前触发、四次摘要截断仍继续执行而停止，父背景 checkpoint 成功，尚无任务验收结论。原始事件、停止记录及计价前后复演见该目录 anomaly-diagnosis.json。前一 Task v14 冻结实跑和本轮工程验证状态、费用与效果边界统一见 [context.md §18](context.md#18-g1g2-接手审核与用户裁定2026-10-11基线-35b0c7c)，不以旧构建的绿色结果代表新协议通过。

SHA256 领域只保留 `sha256.v`、`yosys.md`、`task.json`。指导提供固定综合命令，未变 RTL 的完整 top 面积已实测为 64858.4544 µm²；没有自动面积 measurement 或预写 checker，独立审核依据实际综合和行为证据验收。RSI 的通用 pass 质量不能冒充面积收益。

G1/G2/G3 与最终发布验收按 [assembly-blueprint.md §9](assembly-blueprint.md#9-剩余构建顺序与检查点) 交付，真实领域改进和发布后消费分别验收。

## 环境边界

- **不要**把 `DSH_HOME` 指回 `~/.dsh` 或 `harness/.dsh`，也**不要**在另两个 home 里找
  本环境的会话——本环境的任何落盘状态只在 `home/`；
- 私有安装升级 = 改 env.sh 旁的版本锁定重新 `npm install`，**不做** in-place 更新全局或
  harness 的任何文件；
- **本次 G1/G2/G3 全部在私有独立 DSH 完成**，不以旧 harness 启动或集成为前置；旧仓只读参考。
- 最终验收使用隔离测试 home/profile 装载被验证的同一插件产物，保留私有凭据来源；不重写已有用户会话或全局配置。
- 本轮使用 max 思考，没有 campaign token 预算闸门；轮后汇总原生 tokenUsage 投影，与 ui-chat 的 StatsPills 使用同一口径，包含审核会话的投影。发布需独立审核和真实评估通过。
