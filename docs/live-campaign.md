# live-campaign.md —— 第一次"模型在分解出的子任务里干活、receipt 与测量引用同一条判决"的 RSI 回合

**这是一次真实运行的记录，不是设计。** 全部事实（本轮 53 条）原样保存在 [`live-campaign.jsonl`](live-campaign.jsonl)
（`singularity:control:rsi-live` 会话的 JSONL 记录，从探测进程写出的那份直接拷来，未编辑）。
复现：`node scripts/rsi-live.mjs`（要网络与凭据，**刻意不是门禁**）；下面每个数字都能从那份日志里读出来。

## 这次跑的是什么（**一条管线，工作在计划里面**）

| 角色 | 谁 |
|---|---|
| 持契约、跑基线的 | 根任务 `live-task`：自己跑库里的程序（两条基线 run），并声明分解 |
| 干活的 | **两个受托子任务**：`attempt-1`、`attempt-2`，都声明支持根的 `counted` 判据；**第二个依赖第一个**——第二轮的提示词带第一轮的判决与读数，计划说的就是实际的工作顺序 |
| 写产物的 | **真实模型**，`commandcode` / `deepseek/deepseek-v4.1-flash`，走部署自己的路由 |
| 启动 run 的 | **agent 自己的命令面**（`forAgent().startRun/openBubble`）：就绪门、预算门、责任检查都是任何 agent 的 run 要过的那几道，不是探针写死的事实 |
| 判决产物的 | 判据自己的验证器，**被 spawn 的真实进程**（读产物与输入、自己算一遍、exit code 就是判决） |
| 记判决的 | `task@5` 的 `evidence/produced`，**只记一次**；run 随判决**结算**（`run/verified` ×3、`run/failed` ×1） |
| 记数字的 | `measure@4`：两次真实 trial + 硬约束检查，检查里带的是**判决的摘要**（citation） |
| 留下账目的 | 每棵子树一条 **receipt**：从已提交前缀推导（结算前缀一份、全量前缀一份），读的是 constraint 引用的**同一条判决** |

## 读数（逐条取自日志，53 条事实）

| 事实 | 值 |
|---|---|
| 计划 | 根分解为 `attempt-1`（`supports: [counted]`, `maxRuns: 1`）与 `attempt-2`（**`dependsOn: [attempt-1]`**）；`attempt-2` 在 `attempt-1` verified 之前启动 → `illegal-transition`，拒绝语句点名 `attempt-1` |
| `r0000` 的判决（incumbent，根自己的基线 run） | 程序打印 `234`，验证器 **fail**（输入里 letters 是 171）→ quality **0**，run 结算 **failed** |
| `r0001` 的判决（**模型第一次回答**，住在 `attempt-1` 的 run 里） | 它写了逐字符判字母的程序，打印 `171`，验证器 **pass** → quality **1**，run 结算 **verified** |
| 约束检查的引用 | `verdict.evidenceDigest = 6caa4625…`、`artifactDigest = fc68f3b1…`——与 receipt 里那条判据**逐位相同** |
| 第一轮决定 | `winner 0`；指针 `"r0000" → r0001`，compare-and-swap |
| 树的裁决 | 根的 `counted` 判据 `satisfiedBy: attempt-1`——记在**声明支持它的那个已验证子任务**名下 |
| receipt | `attempt-1` 那条 run 的 receipt：从**结算前缀**推导 status **verified**、`cutoff` 等于前缀长度、`consumption.basis: judged`、输入与声明逐位一致；从全量前缀再推导一份，判据摘要不变 |
| 第二轮（`attempt-2` 的 run） | 模型换了个写法（`process.stdout.write`），也打印 `171`、也 **pass** → quality **1**，**与 incumbent 相同** |
| 第二轮决定 | `winner null`——没有改进，**指针不动**；`attempt-2` 的 receipt 读它自己的判决 |
| 重开 | 会话重开后同一前缀再推导 receipt → **同一摘要**；head 与两轮决定也全部复现 |

## 这次跑出来的机制事实

1. **计划的门是真的，而且是活的**：`attempt-2` 在依赖未验证时被**命令边界**拒绝（不是探针转述），
   而第二轮真实发生时它已经 ready——依赖边就是"第二轮消费第一轮"这件事本身。
2. **receipt 与 constraint 引用同一条判决**：receipt 的判据条目、constraint 的 citation、
   `recordedVerdictDigest` 的再询问——三者是同一个事实的三次阅读，两次前缀推导给出同样的摘要。
3. **每棵子树一个模型产物、一条 receipt**：`attempt-1` 与 `attempt-2` 各持一条已结算 run 与一条
   从固定来源推导的 receipt；根判据记在子任务名下，而根自己的基线 run 不抢这个功劳。
4. **两个方向都观测到了**：一次真实改进让指针移动（0 → 1），一次真实"没改进"让它不动（1 = 1）。

## 没观测到什么（保持未观测）

- **模型会不会重复同一个答案**：一次一个样本。第二轮换了个写法，读数相同，于是没赢。
- **方法的普遍更优**：171 是**这个输入**上的读数。
- **模型"学会了"**：一次反馈到一次输出，不构成学习曲线。
- **谁批准了**：`ctx.approval` 是真实服务、真实审计对，但**这个进程里没有人**。
