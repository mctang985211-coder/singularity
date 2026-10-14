# 私有 DSH 实跑测试

开发、构建 peers 和产品运行都使用 `/home/ROXY/singularity-next/`。旧 harness 只供只读参考。
真实运行加载私有 `singularity-next-web` profile 与本仓库已构建插件；会话与原始证据保留在专用 home。

## 一轮代码验证

```bash
cd /home/ROXY/code/singularity-core
pnpm build
pnpm test
pnpm gates
git diff --check
```

构建检查 core、assembly 和前端类型，装载导出并核对产物摘要。回归与门禁不启动模型，不作为实际领域验收证据。

## 浏览器验收入口

```bash
. /home/ROXY/singularity-next/env.sh
node scripts/deploy.mjs
dsh --profile singularity-next-web --host 127.0.0.1 --port 7331 --no-open
```

从原生界面提交 RTL 目标和自然语言验收要求，不续发阶段指令。模型自主创建方法资产、复用模板或追加自由任务，编写程序并逐层验收。所有节点使用公开 create/resume 的普通主 agent 会话，Bubble 保护输入、验收程序和其他任务历史。

检查间隔为 20 分钟。依据准确会话、committed snapshot、封存附件与正式 receipt 定位问题；不得伪造模型流程。恢复使用原会话、原 Run 与冻结目录，封存后的程序不重复执行。图、依赖、能力缺口、验收及 RSI 记录取同一状态前缀，节点直接连接自己的原生会话。

## Method 进化与原生发布验收

统一 TaskTemplate、Skill、Tool Revision 经过独立审核和验收程序正反例执行后冻结。本轮可显式使用已审核的未发布 Revision；每个 Run 固定准确版本及真实资产使用，发布指针变化不影响在途任务。审核和改进通用模板属于统一 Revision，具体对象作为冻结输入。根验收通过后，独立改进节点读取真实探索轨迹、自主提出候选并调用评估原语。独立验证与发布审核通过的赢家自动固化，后续任务使用统一发布版本。

## 证据边界

本轮优化仅改变 `sha256_w_mem.v`，保护完整 core/K、端口、复位、SHA224/SHA256 功能与逐周期时序。整核面积基线为 64858.4544 µm²，同工具、库和输入下至少改善 1%。包含审核的原生 token 成本增幅上限为 25%；每批提案成本均摊到候选，各候选另计自身资产审核、求解、验收与最终发布审核。总预算为 3 亿 tokens，high 思考。没有固定子树、轮次或候选数量。

领域效果以真实执行的任务、产物、独立判决、原生 usage 和发布记录为据。无赢家、未改善、证据不足或预算耗尽如实报告。旧受控演示与离线测试不能代替当前自主任务链与 RSI 验收。
