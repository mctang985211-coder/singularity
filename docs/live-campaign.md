# live-campaign.md —— 第一次由真实模型驱动、真实读数决定、指针真的移动的 RSI 回合

**这是一次真实运行的记录，不是设计。** 全部事实（本轮 43 条）原样保存在 [`live-campaign.jsonl`](live-campaign.jsonl)
（`singularity:control:rsi-live` 会话的 JSONL 记录，从探测进程写出的那份直接拷来，未编辑）。
复现：`node scripts/rsi-live.mjs`（要网络与凭据，**刻意不是门禁**）；下面每个数字都能从那份日志里读出来。

## 这次跑的是什么（**一条管线，不是两条**）

| 角色 | 谁 |
|---|---|
| 写产物的 | **真实模型**，`commandcode` / `deepseek/deepseek-v4.1-flash`，走部署自己的路由 |
| 判决产物的 | 判据自己的验证器，**被 spawn 的真实进程**（读产物与输入、自己算一遍、exit code 就是判决） |
| 记判决的 | `task@5` 的 `evidence/produced`，**只记一次** |
| 记数字的 | `measure@4`：两次真实 trial + 硬约束检查，而检查里带的是**判决的摘要**（citation） |
| 决定选谁的 | `strategy@5` 的 round：冻结 cutoff、冻结口径、按读数选优 |
| 移动指针的 | `release@1` 起草 + 原生 `ctx.approval` 批准 + `environment@2` 的 compare-and-swap |
| 模型看到什么 | `DOMAIN.md` + 输入。**看不到**验证器、meter、参考集、round、探针 |

**三条腿各归其主，两条管线在"证据"处会合**：判决住在 task，数字住在 measure，
而 measure 的约束检查**引用** task 那条判决的摘要，不复制它。引用是**被检查的**：
检查拒绝一条"关于别的字节"的判决（`evidence-input-mismatch`）。

## 读数（逐条取自日志，43 条事实）

| 事实 | 值 |
|---|---|
| 起始指针 | `"" → r0000`（库先落在一个"数字节"的朴素程序上） |
| `r0000` 的判决（incumbent，A/A 自测） | 程序打印 `234`，验证器 **fail**（输入里letters 是 171）→ quality **0** |
| `r0001` 的判决（**模型第一次回答**） | 它写了 `import { readFileSync } from 'node:fs'` + 逐字符判字母，打印 `171`，验证器 **pass** → quality **1** |
| 编译检查 | 约束检查 `met true`，它引用的判决摘要 `d76a5780b919…` 落在产物 `284de502c984…` 上 |
| 第一轮决定 | `winner 0`——唯一候选被采纳 |
| 指针 | `"r0000" → r0001`，compare-and-swap |
| **终点标志** | 指针新指的 `r0001` **被验证器 pass 过**、测量值 **1 > 0**，而它替换掉的 `r0000` 是 **fail** |
| 第二轮 incumbent | `r0001`：quality **1** |
| 第二轮候选 `r0002`（**模型第二次回答**） | 另一版字母计数，也打印 `171`、也 **pass** → quality **1**，**与 incumbent 相同** |
| 第二轮决定 | `winner null`——没有改进，**指针不动** |

## 这次跑出来的三件机制事实

1. **判决是验证器的，不是文件的**：`r0000` 打印了一个完全合理的数字（文件中确实有 234 字节），
   而验证器按**任务的定义**判它 fail。模型第一版甚至因为 ES module 里用 `require` 而**崩溃**，
   那也是 fail——两次都不是脚本替它说的。
2. **约束检查引用判决，而不是重判一次**：日志里 `constraint/checked` 带
   `verdict: { criterionId, evidenceDigest, artifactDigest }`，`evidenceDigest` 由 `task@5`
   自己给出（`recordedVerdictDigest`），检查的 bytes 与判决的 bytes 必须同一个，
   否则 `evidence-input-mismatch`。
3. **一次真实改进让指针移动，一次真实"没改进"让它不动**——两个方向都观测到了。

## 没观测到什么（保持未观测）

- **模型会不会重复同一个答案**：一次一个样本。第二轮换了个写法，读数相同，于是没赢。
- **方法的普遍更优**：171 是**这个输入**上的读数。
- **模型"学会了"**：一次反馈到一次输出，不构成学习曲线。
- **谁批准了**：`ctx.approval` 是真实服务、真实审计对，但**这个进程里没有人**。
