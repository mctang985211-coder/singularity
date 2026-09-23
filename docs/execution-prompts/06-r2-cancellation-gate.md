# R2：查询不得重新打开取消中的执行闸

你是本票的指挥与实现 agent。完成代码修复、验证和 guide 同步，不仅提出方案；只执行建设计划第 7 项 Q1，验收后停止。

## 2026-09-24 进度审核补充返工合同

`250a04f` / `edfcce3` 修复了查询在 cancelGraph 返回前回填的窗口，但 Q1 尚未关闭。最新审核基线 `0400d25`（与 edfcce3 内容相同），外层 `9f33ddc`。不重做已通过的路径，只补下面已复现的同一查询竞态：

1. 真实 active 根运行，调用 `runForSession`；call-through spy 在 `task.runIn` 已读回旧 active 对象后，用 Promise 屏障暂停该调用返回，仅暂停第一笔目标读取。
2. 真实 `cancelGraph` 完整结束；从真实 store 确认 run=cancelled，gate=terminal。
3. 释放旧查询并 await；现实现得到 gate=active，预期 terminal，测试确定性失败。这是一次取消、一个普通查询，无需并发 cancel 或私有状态注入。

C1 必须追加此跨完成点反例，并通过真实工具执行管线断言旧查询返回后写/spawn 仍被拒、工具体零副作用。保留原取消窗口内的读写测试、C2 恢复与 C3 正常 active 正例。测试以显式屏障控制，finally 释放与收尾。

修复要处理“读取期间状态已变化”的结果适用性，不能仅判断应用结果时是否仍在 closingStores；不要单纯延迟清理集合、追加 sleep 或再次盲读，也不要用永久禁止相位更新破坏恢复。优先沿已有绑定/闸所有权保证旧查询不得撤销新屏障；新增机制须有本反例需要，不建设通用状态平台。原交付列出的其他并发边界不因记录就自动被证明安全，核对与本次修复直接有关的路径；没有可达证据不扩张任务。

达到本补充反例和原 C1–C4 后再提交进度审核，本票不执行 R1。

## 输入与范围

- 工作区：`/home/ROXY/code/bb_work/harness/packages/singularity`；外层：`/home/ROXY/code/bb_work/harness`。
- A0 Q2/Q3 已经进度审核验收，被审交付 `cce3157`，外层备份 `2c299b7`；开工核实实际 HEAD 和后续改动，不回退。
- 主代理读取本目录 [公共合同](README.md)、[主 guide](../singularity-harness-guide.md) 当前状态及 §5.12–5.13、[唯一计划](../2026-09-20-vrtc-code-change-plan.md) 第 7 行和「补救交付复核」Q1。按公共合同先保存相关未提交基线。
- 只修查询回填旧状态导致取消/收敛写闸失效的可达缺陷。保留 R2 已完成的 marker 顺序、无用途 API 清理及 A0 来源/恢复保障；不重做这些工作，不实施 R1/A2，不调用真实模型。

## 已确认的问题

`task-runtime/src/index.ts` 的 `cancelGraph` 先将 session 闸置为 terminal，再等待驱动结束及持久化取消。此间 store 的 run 仍可能为 running/active。允许执行的 `task_proposal_read` 经 `proposalStoreFor → runForSession → lookupRun → gatePhaseFromStore`，会把内存闸回填成 active；随后写入或 `graph_spawn` 再次获准。

主要定位：上述函数、`task-runtime/src/gate.ts`、`agent-singularity/src/tools/` 的提案读取接线，以及 `tests/integration/` 中执行闸、取消与恢复测试。函数名是定位锚，行号以 checkout 为准。

## 固定行为合同

1. 当前进程正在取消或收敛时，查询不能用较旧的持久化状态解除已生效的写入屏障；允许的协调读取仍应可用。
2. 新进程/缺失绑定时仍从 store 恢复正确的执行限制，尤其是 waiting_children 和终态；不能简单删掉恢复同步获得通过。
3. 合法 active 执行、正常生命周期迁移与既有在途调用/job drain 仍有效。不要给全部状态强行排一个单调等级，也不要把任意历史 gate 永久锁死；先区分恢复绑定与本进程在途屏障的职责，再作最小修改。
4. 优先使用已有 gate、绑定和驱动所有权。只有具体反例证明现有信息不足才增加最小状态，并说明建立、解除和清理位置；不建新调度器、事件体系或通用锁框架。

## 验收

| 编号 | 必须提供的证据 |
|---|---|
| C1 取消交错 | 用明确 Promise 屏障暂停真实 cancelGraph，在已关闸但尚未持久化取消的窗口，经真实 tools.execute 调用允许的 task_proposal_read；读取成功，前后写入/spawn 均被拒绝，工具体零副作用。释放屏障并等待取消完成，读回终态与清理结果。该测试必须先在未修复实现上因闸被重开而失败 |
| C2 恢复正例 | 新实例/重开 store 后，waiting_children 及终态的写入仍被拒绝，允许的协调读取仍可执行；覆盖实际绑定入口，不只测私有 helper |
| C3 正常执行 | 合法 active 下写入可用，正常分解/提交/结束的既有回归通过，证明没有以全部拒绝修复问题 |
| C4 相关窗口 | 沿同一回填函数检查提交、分解等已支持收敛入口；若同样存在落盘前窗口，加入对应确定性反例并修复；若不存在，给出调用顺序依据，不枚举假想并发场景 |

可复用 `tests/support/scripted-loop.ts`，按 A0 夹具接口记录真实来源的用户请求。模型输出可 scripted；被验的 runtime、store、gate、提案读取及工具执行管线必须真实。写工具体可用计数 stand-in 检查是否被调用，并如实说明；不得声称已验证真实文件写入。故障注入只控制等待点，不能替换被验判定。禁止用 sleep、延长超时或碰运气循环制造竞态；finally 释放屏障并收尾所有 promise/fixture。

## 工作分配与停止规则

主代理先写简短的“问题 → 入口 → C1–C4”映射，再实施。需要委派时，先只派一个子目标“Q1 修复 + 定向回归”，交接上述合同和必要函数/测试位置；子代理不承担全仓审查、所有指南更新或全量检查。实现交接后，另派一个只读复核目标“查询与取消/恢复组合是否满足 C1–C4”。主代理负责整票集成、全量验证和文档。出现上下文紧张就交接已完成、证据、剩余一个目标和未结束进程，只续跑剩余项。

本票不要求外网研究、不重做架构审查、不按行数瘦身、不增加预设未来情形。验收通过即收尾；新增工作必须能指向本票合同的具体失败轨迹。必要修复超出授权时记录阻塞，不偷偷扩成整张后续票，也不通过降低验收关闭问题。

## 验证与交付

先跑定向反例并记录红/绿原因；集成完成后在 Singularity 跑一次 `pnpm build`，完成后在外层跑 `pnpm vitest run --project unit packages/singularity` 和 `pnpm vitest run --project integration packages/singularity`；再按公共合同执行 `verify-persistence`、`git diff --check` 和 agent-singularity 的 `pnpm exec tsc --noEmit`。无新修改或新失败不重复全量测试。持久化合同若变化，按既有规则记录兼容性，不盲目刷新指纹。

主代理必须更新最重要的 `docs/singularity-harness-guide.md`：当前结论、取消/恢复实际保证、源码与测试锚、剩余边界；同步 `docs/2026-09-20-vrtc-code-change-plan.md` 第 7 行及验收记录、`docs/execution-prompts/README.md` 当前入口。保留原 R2 和 R1 历史证据，新增本次结果，不覆盖原失败记录。不另建竞争排期或庞大审查报告。

交付：修改前/被审版本、C1–C4 结果与测试位置、实际命令和数量、独立复核发现及关闭证据、模拟与未覆盖范围、Git 状态。未实际独立复核不得声称已复核。完成后停在第 7 项待进度审核；下一项是 R1 Q4/Q5 补验证，须另行派发，本票不执行。
