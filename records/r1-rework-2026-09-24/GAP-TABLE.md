# R1 补验证返工（2026-09-24）差距表

本文件只覆盖建设计划第 8 项 R1 的**无模型返工**：判据两处漏验、缓存写缺报口径、以及用既有原始证据对本次 S3 的独立语义重判。原始冻结合同、原判据哈希、原始 S3 日志/产物/ledger 全部只读，修正一律另存于本目录。

- 返工基线：Singularity `8795a4e`、外层 harness `53c3a69212`（两个工作区干净，外层仅既有的 `thirdparty/deepseek-harness` 脏标记）。
- 交付提交：Singularity `a85a05c`（本计划 / 主 guide / 执行入口的文档交付）、外层指针 `963b84ca1a`；均为本地提交，未推送。
- 本轮**未发起任何网关调用**、未改生产代码、未实施 A2/A1/A4。
- 原始证据树 `/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/` 与 `/home/ROXY/code/bb_work/r1-evidence-2026-09-23/` 事后逐文件哈希比对不变（见 `accounting/frozen-trees-manifest.txt` 与两个 `archive-*.sha256`）。

## 判决矩阵（原判据 vs 修订判据，原始记录只读重放）

判据模块：`s3-criteria/1` = 冻结版（sha256 `4ce8095c…`，未改，仍在归档）；`s3-criteria/2` = 修订版（`criteria/s3-criteria-rev2.ts`，sha256 `83d9ee31…`）。语义输入一律是显式复核记录，两个模块读同一份记录、同一份复核。

| 记录 | 复核记录 | `s3-criteria/1` | `s3-criteria/2` |
|---|---|---|---|
| 原 S3（`r1-evidence-2026-09-23/s3/driver.json`） | 归档 `adjudication/original-s3.json` | **fail**（S1×4+S2） | **fail**（同上，逐条一致） |
| 本次 S3（归档 `evidence/s3/driver.json`） | 归档 `adjudication/s3-run.json`（原复核） | pass / path2-limited-goal | pass / path2-limited-goal |
| 本次 S3（同上） | **本轮 `adjudication/s3-run-rejudged.json`**（独立重判） | **inconclusive**（`left plain unknown: quarter`） | **inconclusive**（同上） |

原始数据：`criteria/verdicts/matrix.json`（含双方模块与输入的 sha256）。**修订版没有改变任何一个既有判决**——S3 的 pass 无法维持是**语义重判**的结果，不是判据版本的结果；修订版关闭的是漏验通道（见下，C1/C2 反例证明它们此前确实会放过）。

## V1–V6 逐项

| 编号 | 原交付结论 | 本轮结论 | 证据路径 |
|---|---|---|---|
| **V1 夹具接线** | 成立 | **保留成立**（未重做）：真实 `hitl_ask` → `userQuestions` → 固定答复 → 会话 `tool/result` 逐字一致；记录失败不改产品路径 | 归档 `driver/r1-stack.ts`、`driver/r1-wiring.spec.ts`；本轮独立复核在 strace 下重跑同一接线用例，0 次 AF_INET/connect（`REVIEW-independent.md`） |
| **V2 判据有效** | 漏两处：M1 不与冻结答复比对；M3 一个 pass 抵消其余必需项 | **已修并钉住**：`s3-criteria/2` 最小副本，仅两处改动（`criteria/s3-criteria-rev2.diff` 268 行，`patch` 回放与原文件逐字节相同）；每项必需检查都进入最终 verdict | 反例：`criteria/s3-criteria-rev2.spec.ts` + `criteria/verdicts/counterexamples.json`；红证据 `criteria/verdicts/c1c2-red-before-fix.txt`；独立复核另做 4000 例差分扫描（0 处放松、200 处更严）与两组“去掉修复即复绿”的变异 |
| **V3 真实补验证** | 判 pass / path2-limited-goal | **不能维持：重判为 inconclusive（不得 pass）**；归档尝试记为“未通过（无法判定）”，S3 的季度条件未被用户确认，契约 `assumptions[0]` 的 `current/final quarter` 两种读法同时成立 | 重判：`adjudication/s3-run-rejudged.{json,md}`（sha256 `48af143e…`，全部引用在判据自身的 citation ledger 中解析成立）；判决：`criteria/verdicts/matrix.json` |
| **V4 不可用分支** | 成立 | **保留成立**（未重做）：澄清失败/未答复的故障注入是判据/夹具级验证，已明确标注，不宣称生产通用语义闸 | 归档 `driver/r1-wiring.spec.ts` 的注入用例；本轮 `criteria/verdicts/*` 未改动这些事实 |
| **V5 实验账** | 记为“缓存写 0” | **更正为“未报告”**：本次 15 条 normalised usage 对应的原始 `assistant/message.usage` 对象**全部没有** `cacheWriteTokens` 键（同一对象里 `cacheReadTokens`/`reasoningTokens` 是真报的，含真 0）；该项不可求和，不写 0；末次无 usage 的请求仍记缺失 | `accounting/cache-write-recompute.{py,txt}`、`accounting/V5-account-correction.{json,md}`；独立复核自行重数得 15/15，且 `totalTokens == input+output+cacheRead` 在 15 条上全部成立 |
| **V6 历史更正** | 下界 ≥175461 token / ≥58 次调用 / 含缓存 ≥501349 | **保留不变**（未重算、未外推）；补一条：旧轮的 cache-write 列同样是**未报告**（36 条原始 usage 对象 0 条带该键），因此旧轮不存在 cache-write 下界 | `accounting/V5-account-correction.md` §5、`accounting/V5-account-correction.json:historicalUnchanged` |

## 未关闭项（R1 保持返工）

1. **归档 S3 尝试未通过。** 记录为“未通过/无法判定”，不重跑、不改题、不挑结果；一次尝试纪律不变。
2. **最小生产修复触发点（本轮只提出，不实施）**：
   - 现象：用户侧固定答复只回答了数据问题；根模型仍把自己认定为“会改变范围与验收”的条件（`s-root.jsonl:17` 自述）用 `assumptions[0]` 定成 `treats it generically as the current/final quarter`，随后激活契约。
   - 落点：`agent-runtime/src/prompts/root.prompts.ts` 的根角色 prompt（契约段落）与 `agent-singularity/src/tools/task-intake.ts` 的 `assumptions` 字段说明。A0 设计 §10 已写“会改变目标、范围或验收的歧义用已有 root 澄清渠道解决，未解决不能当已确认要求激活”，prompt/字段说明没有写出这条边界（“假设不等于确认，也不得为未确认的交付定义条件选定取值”）。
   - 边界：这是行为面的提示词级最小修补，不加语义分类器、不加运行时闸；其效果**只能**由新的真实模型尝试检验，本轮未授权、也未实施。
3. **后续真实模型重验必须另行固定**：输入、判据（应冻结 `s3-criteria/2` 或其后继并记哈希）、独立证据目录、次数与预算，经任务授权后执行；不得沿用本次 attempt 目录覆盖结果。
4. **判断题仍在**：若复核者把 `assumptions[0]` 首句读作干净的保留，季度会标 `retained-unknown`，该轨迹会 pass。本轮按冻结合同的“无法判定→inconclusive≠pass”记录，未把该分歧判成已解决（`REVIEW-independent.md` 亦明确要求把它作为 live 分歧上报）。
5. **发现一处既有的间歇测试失败（非本票缺陷，未修）**：`tests/integration/a3-recovery.spec.ts` 的取消中验收用例在并行负载下 `vi.waitFor` 超时（见下表）。它与本次零生产改动无关，属该用例自身的时序稳健性问题，如实记录并留给该区域所有者。

## 本轮检查（主代理实跑）

| 检查 | 结果 |
|---|---|
| `packages/singularity` `pnpm build` | 通过；`git status` 无 lib/源码改动 |
| 外层 unit（`--project unit packages/singularity`） | 44 文件 / **1461 项**通过 |
| 外层 integration（`--project integration packages/singularity`） | 38 文件 / **268 项**通过；本轮 5 次全量中 1 次间歇失败（见下） |
| 既有间歇失败（与本轮零生产改动无关） | `tests/integration/a3-recovery.spec.ts`「refuses the evidence a cancelled run's late verifier tries to record」在并行负载下 `vi.waitFor` 超时（`expected 'admitted' to be 'verifying'`，默认 1 s）；单跑该文件 3/3 全绿、全量 4/5 全绿。属该用例的时序稳健性问题，超出本票范围，如实记录并留给该区域所有者，不在此票修复 |
| `pnpm run verify-persistence` | OK，4 个事件根匹配 |
| `agent-singularity` `pnpm exec tsc --noEmit` | exit 0，零输出 |
| `git diff --check` | 干净 |
| 仓库外修订判据套件 | 3 文件 / **14 项**通过（含真实接线的合法正例；strace 核对 0 次出站连接） |
| 归档树完整性 | 两棵树逐文件哈希比对不变 |

## 本轮交付物与哈希

| 路径 | sha256 |
|---|---|
| `criteria/s3-criteria-rev2.ts` | `83d9ee3141c52f0548c62b3e9cf68c6af7d006d5d08a859b37ff0baee602d1c9` |
| `criteria/s3-criteria-rev2.diff` | `5032972491764bfbfae55e30ac30306c0941830dbb5bd4d263887775073aca2a` |
| `adjudication/s3-run-rejudged.json` | `48af143e18f1bffce11335ac6678b5098195e2e83bda9892055607ecf250cbd1` |
| `accounting/V5-account-correction.md` | `9e2ad4f9e63499ef57b8ca9585074ea334ecf6904afe0bb6798b15b725628b03` |
| `accounting/V5-account-correction.json` | `f78c93e54f89c248f86a0d65c76bef594093540a5beabf794104e6cf0d7e1296` |
| `criteria/README.md` | `fbad03bc8def23706f7b659ffaf6925d2e1cab161f494ff0e032e1741404e236` |
| `REVIEW-independent.md` | `6dae98a3b5722d9420a62d6a8a82e82434a8f2c2cfb2f8f307ed43563bb78495` |

重放命令（确定性、无收费、可重复）：

```sh
cd /home/ROXY/code/bb_work/harness
pnpm exec vitest run --config /home/ROXY/code/bb_work/r1-rework-2026-09-24/criteria/vitest.rev2.config.ts   # 3 文件 / 14 项
python3 /home/ROXY/code/bb_work/r1-rework-2026-09-24/accounting/cache-write-recompute.py
```

独立复核（非实现者子代理，只读 + 变异探针 + 4000 例差分 + strace 网络核对）：`REVIEW-independent.md`，结论“本轮主张成立，未能证伪”；复核发现的两处文档级缺陷已由指挥方更正并复跑（`criteria/README.md` 的 C2b 标签行；`accounting/V5-account-correction.{md,json}` 把 `s-root.jsonl:63` 错称为 “inbox splice”，实际是投递的 `user/message`，splice 在 `:59`/`:61`）。
