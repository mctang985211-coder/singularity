# 实跑测试方法与 G2 卡点归因（2026-10-11）

## 一、实跑测试的具体方法

**前置（一次性确认）**：

- 私有 DSH 环境：`. /home/ROXY/singularity-next/env.sh`（PATH、`DSH_HOME` 指向私有 home、yingjun 路由四变量）；
- 无其他 dsh 进程占用同一 home（`pgrep -af "dsh --profile"` 只应看到自己的）；
- 插件产物新鲜：`node assembly/build.mjs`（门禁 `assembly-built` 会查，stale 直接报）。

**日常验证循环**（每轮全部跑，显式复核 exit code）：

```bash
. /home/ROXY/singularity-next/env.sh
cd /home/ROXY/code/singularity-core
node assembly/build.mjs      # 重编 lib（探针挂的是这份产物）
npx tsc --noEmit             # 类型，0 错
npx vitest run               # 432 用例
node scripts/gates.mjs       # 26 条门禁，exit 0 为过
```

**26 条门禁里真正的"实跑"部分**：

- 9 条行为探针（`control-probe` / `slice-b` / `recovery` / `strategy-vectors` / `measure` / `round` /
  `release` / `cd` / `domain`）：真实 JSONL 控制 store、真实 core 命令、临时工作区，不调真模型；
- **2 条真端到端浏览器门禁**：
  - `panel-probe`：启动真部署 profile → Playwright 真开浏览器 → 真 UI 新会话 → 驱动根 prompt →
    断言面板/读路由/工具读的是**同一个 cut**；
  - `subtask-probe`：真模型一整轮——propose → decompose → **真子 DSH 会话被开出来** → 子模型真调
    工具干活 → 从已落盘的控制日志与子会话日志断言：计划提交、依赖成立、每 ready 子一个会话、
    指令已送达、无身份拒绝。判决走 letters 判据验证器，receipt 经读路由可读。

单跑探针：`node scripts/panel-probe.mjs`（`--screenshot <path>` 可留证）。探针开头自动清理自己
control 的旧账，结尾 SIGKILL 自己起的 server。

**判绿看最后一行 `xxx-probe: OK`，不要信管道后的 exit code。**

## 二、G2 执行者为什么卡了这么久

五个原因叠加，按权重排：

1. **脏环境掩埋真根因**。两个手动启动的主部署 server（无 overlay）在私有 home 上活了 3+ 小时，
   与探针共写同一 home。超时、日志污染、误判混在一起——表象是"探针不稳定"，实际是环境在动。
   **教训：手动起的部署用完必须关；跑探针前先确认 home 上没有别的 dsh 进程。**
2. **locale 根因不可见**。app 无显式偏好时把 UI 语言委托浏览器，Playwright 默认 context 继承
   系统 zh-CN，探针的英文定位器全部失配。不做"钉 locale 对照实验"这个根因不会自己浮出来。
   现已修：三个浏览器探针钉 `locale: 'en-US'`。
3. **三条门禁互锁的磨盘**。修探针加行 → budget 红 → 删行 → spec 破。必须先拿到一条腿的确定绿
   再动下一条，不能在三扇门之间循环。
4. **失败时无诊断信息可看**。gates 失败 tail 只有 3 行，探针 stderr 里 `zstd -dc` 自带的进度行
   恰好 3 行，真实失败被完全掩埋，只能盲猜重跑。现已加宽到 15 行。
5. **模型漫游没和协议缺陷分开**。子模型会读兄弟任务、嵌套分解、烧预算重试。一次红跑的失败里
   混着三类问题：真缺口（嵌套未拒绝）、断言混渥（把围栏正常工作当缺陷）、作用域靠运气
   （父 id 只在拒绝文本里碰巧出现）。分类修，不要合并修。

结构性背景：G2 的证据腿是真浏览器+真模型门禁，一轮全量 gates 10-15 分钟，慢同步点（等父回合
结束，max 思考强度下 3-15+ 分钟波动）让偶然性与确定性 bug 混在一起。subtask-probe 现已改为
轮询主张事实（计划已提交 + 子首回合完成，读已落盘日志），不再等父回合结束。
