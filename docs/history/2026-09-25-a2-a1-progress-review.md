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

## 返工结果（实现侧应答，2026-09-25）

定向返工已按 [prompt](../execution-prompts/09-a2-a1-review-rework.md) 完成并留下[返工记录](2026-09-25-a2-a1-rework-record.md)（提交 `bee6a96` + 复核响应 `6ae5aa0`）：

- **Q1 关闭**：绑定事实读取失败（graph 查询异常、域 store 不可读、ledger 冲突/不可读）现由 `system-prompt/assemble` 具名拒绝，模型输入为零（真实 loop + 计数 adapter 证据）；图查询异常不再被读成“没有图”，`unbound` 不再无条件放行；诊断组装与确实不属 Singularity 的会话保持原行为。
- **Q2 关闭**：`ReviewerBindingRecord.actor` 与所委派 graph 的实际成员表核对；他图 actor、未知 actor、成员表读取失败均不授权，同域已发布 actor 的合法正例保留。
- **Q4 关闭**：状态页首条目放不下即具名 `context-too-large`（点名 task、给 `context_read` 引用与 `offset+1`），不再返回同 offset 的停滞页。
- **Q3 部分关闭**：中途读失败返回具名 `unreadable`（不再返回局部成功页）；>16 KiB 单事件不再被截断跳过，页面收尾行由预留守住（模型收到的每一页都能说出续读位置）——但**事件内续读在冻结四参数下不可表达**（DSH 的读取单位是整个事件），本票报告最小合同修订选项并按要求保持返工，见返工记录“未关闭子项”。
- **独立复核及其响应**：未参与实现的子代理只读审计了返工提交，Q1–Q4 判 PASS 并发现三处可达缺口（store 报“不存在”时已绑定 worker 降级为无契约装配、接近上限的页面丢失两行续读线索、非有限分页输入的停滞页）与两处边界；三处缺口已在复核响应提交中修复并有红/绿反例，边界已记录待裁决，详见返工记录“独立复核”一节。

本审核记录中的原反例描述保持原样，用于对照；上方第 1 行结论所写的“返工”仍有效，后续复审与裁决见下节。Q3 单事件续读实现并经整组验收前，状态不会改变。

## 返工复审与架构裁决（2026-09-25）

被审基线为 Singularity `0fc8bc6`；复审实现为 `bee6a96`、`6ae5aa0`、文档提交 `4115a85`。复审修改前备份为 Singularity `0133e5b`、外层 harness `8420485`。两名独立只读审查者分别核对合同和代码职责；主审复跑定向 unit 2 文件/59 项、integration 2 文件/5 项，均通过。实现方全量 build、unit、integration、persistence 和类型检查的数字见[返工记录](2026-09-25-a2-a1-rework-record.md)，本次没有为增加测试次数重跑全仓。

结论：**Q1/Q2/Q4 与 Q3 的中途窗口失败关闭；Q3 的超长单事件续读不通过，第 9 项维持返工，A4 不可派。** 代码 `context/src/projections.ts` 的首个超长事件返回 `context-too-large`，只给 `offset=seq+1`；该 offset 跳过整个事件，不能取得正文。真实工具门测试也只证明拒绝与跳过。执行方诚实报告了冻结接口冲突，未伪称整票通过。

计划所有者现固定最小修订：同一四参数工具中，`ref:sessionId` 保留事件列表；`ref:{sessionId,seq}` 定位单事件并按已有可见正文的 UTF-8 字节分页。授权仍从 live caller 与目标 Session 的 graph 成员关系取得，不能由引用授权。详细行为、16 KiB 边界与验收已写入[计划 D 节](../2026-09-20-vrtc-code-change-plan.md)，当前唯一可派发的是[Q3 收尾 prompt](../execution-prompts/09-a2-a1-q3-closure.md)。这项裁决不改变本轮未通过的事实，也不降低原 Q3 验收。

审查时另注意到 `bindings.ts` 的图边列表空值回退和 `projections.ts` 一个未用常量；没有证据表明它们是正常持久轨迹的验收阻断。后续触及相同代码时可顺手去除，但不另开结构整理任务。
