# A2+A1 进度审核（2026-09-25）

结论：**第 9 项返工，暂不派 A4**。被审实现为 `4a510ed`、`f90d05b`、`0f41d91`、`6e0f651`，交付说明提交于 `c851eff`；审核修改前备份为 Singularity `7ce7b9b`、外层 `a6fbb50`。原[交付记录](2026-09-25-a2-a1-delivery-record.md)中的实现方 PASS 与测试数字保留为当时事实，不能覆盖下列可达反例。

| 编号 / 原合同 | 代码证据与结果 | 返工完成条件 |
|---|---|---|
| Q1 / A2-3、A2-5 | `context/src/bindings.ts:301-305` 吞掉 graph 查询异常，已绑定 worker 可被误归为 unbound；`context/src/assembly.ts:159-161` 随后照常发模型请求，缺失根/本人契约。已运行 reviewer 的 ledger 冲突或不可读也走同一放行分支 | 区分真正不属于 Singularity 图的请求与绑定/读取故障；后者首请求及后续请求均具名拒绝、零模型输入，诊断工具仍能报告原因 |
| Q2 / A2-2、A2-5 | `context/src/bindings.ts:393-419` 只比对 reviewer ledger 的 root store，没有核实 `actor` 属于该 graph；他图 actor 的记录仍可授权读取 | 用真实委派来源验证 actor 与 graph 一致；错域、未知或不可读时拒绝，既有同域 reviewer 正例保持 |
| Q3 / A2-3、A2-5 | `context/src/projections.ts:941-952` 在多事件读取中途失败时返回局部成功页；`:967-985` 遇单个超过 16 KiB 的 Session 事件会剪掉正文后半，却把 offset 推过该事件，余文永久不可读。原交付记录已注明后一边界，但没有续读路径 | 失败不能伪装成完整成功；超限事件须可继续取回或明确保持未读并报告冻结接口冲突，不能跳过丢失部分后判本票通过 |
| Q4 / A2-3、A2-5 | `context/src/projections.ts:657-673` 的单条 task 摘要超出余量时，`shown=0`、`hasMore=true`、`nextOffset=offset`，后续调用永远返回同一页 | 每个成功的 `hasMore` 页必须前进；单条无法放入时具名超限并给可读取该 task 的引用，不能循环或静默漏项 |

本轮只读审查了 A2 合同、实现、交付记录和新测试；独立复跑 context 单测 5 文件 / 58 项、context 装配集成 1 文件 / 8 项，以及恢复/取消/worker 契约集成 3 文件 / 29 项，全部通过。这些既有用例没有覆盖 Q1–Q4。未运行真实付费模型；本票仍用确定性真实 DSH 装配和故障注入验收。

返工使用[定向 prompt](../execution-prompts/09-a2-a1-review-rework.md)。仅修改反例涉及的绑定、投影、装配及必要测试/工具说明；保留已成立的显式恢复、同域读取、原始 Session 工具封闭和职责迁移。返工提交后重新独立审核 A2-1～A2-6 及旧数据/取消回归，整组通过才把唯一表改为“已验收”。
