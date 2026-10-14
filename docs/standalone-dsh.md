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

从原生界面提交领域任务和自然语言验收要求，节点通过普通 DSH 主 agent 会话自主执行。本轮按用户要求，确认真实执行启动后停止监控，由用户报告断点；收到断点后核对 Task/Run、封存产物、独立判决、资产使用和发布记录。离线回归不能证明领域效果。

部署出来的 profile 在 `home/profiles/singularity-next-web/`（`scripts/deploy.mjs` 整目录重写；linked root
指向本 checkout 的 `assembly/`）。模型路由与领域目录都写在 `deployment/profile/cordis.patch.yml`，
凭据仍只在本 home 的 `.credentials.yaml`。

## 历史环境实测（2026-10-11；不代表本轮新合同通过）

- `dsh --version` → **0.2.0-rc.2**（与全局安装、harness checkout 三方同版本，将来接
  profile 契约零落差）；
## 当前验收与完成边界

本轮以 `67c7ffe` 和现有未提交改动为基线，清理后全量回归曾通过（61 个文件、706 项）。本次恢复修复未新增或运行 spec，typecheck、构建、摘要、gates 与 diff 检查通过。新构建已部署并重启私有 DSH，原改进会话已重发同一冻结 evolve 请求，原候选 Run 的 seq418/419 已成功执行工作区核查；基线 trial 未重复。确认候选实际执行后已停止监控。最新检查点和费用见 [context.md §18](context.md#18-g1g2-接手审核与用户裁定2026-10-11基线-35b0c7c)。
21:14 的两路独立求解/验收链构建已就绪，相关 111 项回归及现有检查通过；当前宿主仍执行 19:17 装载的构建，未再次中断单候选。下一次启动装载并行实现；真实两路重叠和吞吐待后续批次验证。
G1/G2/G3 与最终发布验收按 [assembly-blueprint.md §9](assembly-blueprint.md#9-剩余构建顺序与检查点) 交付，当前没有候选结果或 RSI 赢家发布完成事实。

## 环境边界

- **不要**把 `DSH_HOME` 指回 `~/.dsh` 或 `harness/.dsh`，也**不要**在另两个 home 里找
  本环境的会话——本环境的任何落盘状态只在 `home/`；
- 私有安装升级 = 改 env.sh 旁的版本锁定重新 `npm install`，**不做** in-place 更新全局或
  harness 的任何文件；
- **本次 G1/G2/G3 全部在私有独立 DSH 完成**，不以旧 harness 启动或集成为前置；旧仓只读参考。
- 最终验收使用隔离测试 home/profile 装载被验证的同一插件产物，保留私有凭据来源；不重写已有用户会话或全局配置。
- 本轮使用 high 思考与 3 亿原生 tokens 总预算，包含审核成本。发布需独立审核和真实评估通过。
