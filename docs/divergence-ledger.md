# RRSI 决策差异与证据范围

更新：2026-10-24。当前 Strategy v10 / Measure v6 / Task v27 / Review v8。
对照为 [google-research/rrsi](https://github.com/google-research/rrsi) `be50316e1db05914068a973f322770ef08ed7ba1`（Apache-2.0）。当前架构见[architecture](architecture.md)。

本账本区分纯决策函数与生产装配。`node scripts/strategy-vectors.mjs` 比较的是 `noveltyOf/select` 对冻结输入的输出；它不运行宿主、领域任务、退火调度或迁移实验。`port-adapted` 必须解释实际分歧；`deterministic/upstream-native` 必须与冻结对照一致。向量和反例源码是可运行记录，历史测试数量与旧 mutation 结果不作为当前验证声明。

| 差异 | 当前行为与理由 | 冻结向量 |
|---|---|---|
| 资产分类 | 宿主以实际资产 diff 核对声明；纯 `noveltyOf` 接收已核对的资产类，不按源码路径猜测 upstream component。 | `novelty.no-declaration`、`novelty.diff-signal-missed` |
| 模板属于方法资产 | 当前可演化 workflow、template、skill、tool；template 在 upstream component 分类中没有直接对应项。 | `novelty.template-class` |
| 成本只作加法统计 | 按 2026-10-24 用户要求，已记录用量相加，缺样本只作审计；没有成本上限或未知成本门禁。质量增益仍可获胜，成本下降仍可支持收益。原向量 id 保留，期望与标签按当前规则更新，upstream 冻结结果不改写。 | `selection.cost.blocked`；`select.cost.capped`、`select.cost.unknown.gaining` 现与对照一致 |
| 成本不能否决质量收益 | 噪声带内只把已记录成本下降作为收益，不把上涨或缺样本作为惩罚；噪声带外的质量增益直接准入。中性且无已记录收益仍保留 incumbent。 | `select.noise.inside-band.costly`、`select.no-winner`、`select.cost.unknown.in-band` |
| 新颖性不是收益 | novelty 不进入准入分数，也不打破质量平局；按 slot 稳定选择，不依赖完成顺序。 | `select.in-band.novelty-cannot-buy`、`select.tie.slot-order`、`select.tie.novelty-ignored` |
| 缺测不能当作得分 | 质量计划分母固定，缺测使 quality 为 null、比较不可准入；成本独立累加已记录部分。 | `select.measurement.incomplete`、`select.measurement.incomplete.only` |
| 历史质量下界 | 纯函数仍可按冻结权重接受成本下降支持的噪声带内收益；生产 `projectRound` 在相同 campaign/caliber 的冻结历史上执行 S* floor。 | `select.sstar-floor.absent` |

保护约束不参与加权补偿；每个已冻结 gain 按 slot 归属，不能按新生产 head 重算。没有可准入赢家时保留 incumbent。相关可执行反例在 [strategy-decision](../tests/strategy-decision.spec.ts)、[strategy-round](../tests/strategy-round.spec.ts)、[strategy-direction](../tests/strategy-direction.spec.ts) 和 [published-assets](../tests/published-assets.spec.ts)。

## 已移除的历史机制

旧账本中的 `editBudgetFor` 退火、gate 资产和强制 exploratory 槽不属于当前协议。当前使用最多六个候选槽、每批 1–3 个单机制提案；没有资产覆盖配额、停滞强制删除或候选 gate。历史实现和当时的 mutation 结果保留在 Git，不作为生产行为说明。

当前 mutation 的操作、锚点与拒绝见证仅由 [mutation-baseline.json](../mutation-baseline.json) 定义，可用 `node scripts/mutate.mjs --list` 查看，按需显式执行。`pnpm verify` 执行其中指定的一条提交门禁；不把清单检查说成全部 mutation 已运行。
