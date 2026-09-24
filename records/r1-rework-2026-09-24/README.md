# R1 补验证返工（2026-09-24，无模型）

第 8 项 R1 的进度审核返工：只做**判据修正与既有证据重判**，不发网关调用、不改生产代码、不实施 A2。

- 合同：[执行 prompt 末节「进度审核返工补充」](../../harness/packages/singularity/docs/execution-prompts/07-r1-supplemental-validation.md)（原首次执行合同与其冻结场景仍是历史依据）。
- 交付提交：Singularity `a85a05c`（文档）、外层指针 `963b84ca1a`；本地提交，未推送。
- 结论速览（详见 `GAP-TABLE.md`）：V1/V4/V6 证据保留；V2 的两处漏验已最小修复并以反例钉住（修订判据 `s3-criteria/2`，sha256 `83d9ee31…`，不改动归档的冻结版 `4ce8095c…`）；V5 的“缓存写 0”更正为“未报告”；**本轮真实 S3 尝试重判为 inconclusive（不得 pass）**，因此 R1 保持返工，并按返工补充第 4 条提出最小生产修复触发点（本轮不实施）。

## 布局

| 目录 | 内容 |
|---|---|
| `criteria/` | 修订判据 `s3-criteria-rev2.ts`、最小 diff、两处定向反例与重放矩阵、真实接线的合法正例、README、`verdicts/`（红/绿证据与判决矩阵） |
| `accounting/` | 缓存写缺报的重算脚本、原始输出、更正记录、冻结树清单（未改动证明） |
| `adjudication/` | 对归档本次 S3 的独立语义重判（JSON + 说明），供判据消费 |
| `REVIEW-independent.md` | 独立复核报告（非实现者；变异探针、4000 例差分扫描、strace 网络核对、归档哈希核对） |
| `GAP-TABLE.md` | V1–V6 差距表、未关闭项、最小生产修复触发点、交付哈希与重放命令 |

## 只读边界

归档 `/home/ROXY/code/bb_work/r1-supplemental-2026-09-24/`（冻结合同、判据、原 S3 日志/产物、ledger）与 `/home/ROXY/code/bb_work/r1-evidence-2026-09-23/` 全程只读；两棵树的逐文件哈希在返工前后比对不变（`accounting/frozen-trees-manifest.txt`）。

## 本轮没有做的事

未调用真实模型（含冒烟）、未实施 A2/A1/A4、未改生产代码或仓库测试、未覆盖任何旧证据、未新建 benchmark/评估平台、未推送。判据的语义面仍是显式独立复核，不是生产通用语义闸。
