# singularity-core

面向领域任务的 RSI 内核与 DSH 插件。TaskTemplate、Skill、Tool 共用不可变 Revision，经独立审核与真实评估自动发布，供下一次任务消费。

复核基线 `35b0c7c`：核心原语已存在，G1/G2 需要修正并重新验收，G3 产品闭环待接。

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

在原生界面提交领域目标与自然语言验收要求。入口接纳根 Task/Run；agent 自主探索、追加分解、逐层独立验收，根通过后独立改进节点读取真实轨迹并评估资产候选。可靠赢家自动切换统一发布指针，后续任务固定使用该版本。Singularity map 与右侧 DSH 会话面板读取同一 committed snapshot。
