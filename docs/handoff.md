# 交接一页纸（本文件按交接重写）

> 给接手者的最短路径。**不要重新读全部文档，按下面的顺序读。**
> 本页最后更新：2026-10-09，交接给**阶段 A 收口**的接手者。

---

## 1. 五分钟纠正认知（读这三处就够）

| 顺序 | 读什么 | 读完你会知道 |
|---|---|---|
| 1 | 本文件 §2 | RRSI 的**六处纠错**——如果你脑子里的 RRSI 是"每轮 k 个候选 + critic 预筛 + novelty 计数"，那是错的 |
| 2 | [`context.md`](context.md) §0 + §3 | 已定决策（不要重新讨论）；每个反例的状态与回归位置 |
| 3 | [`context.md`](context.md) §4.1 | F01 承载实验的结论——它决定了阶段 A 的剩余工作怎么做 |

**然后**（只在需要时）：[`blueprint.md`](blueprint.md) §2.3 = RRSI 逐行接线状态（32 行表）；[`rrsi-upstream-reference.md`](rrsi-upstream-reference.md) = 上游逐行对照；[`adr/0001`](adr/0001-rrsi-port-boundary.md) = 为什么引进了 RRSI 却不运行它；[`review.md`](review.md) = 第一轮审核与 K1/K2。

---

## 2. RRSI 的六处纠错（读源码后才成立的）

1. **`m` vs `k`**：**每轮 `cfg.m` 个候选**（`loop.py:292`），**`k` 是每任务 trial 数**（`config.py:60-61`）。默认 `T=20, k=2, m=2`——**两者都是 2，所以"每轮 k 个候选"这个说法极易写错**（我写过）。
2. **正则化不在公式里，在机械约束里**：`done()` 回弹（预算/保留槽/`component ∈ K`/六个必填字段，`propose.py:328-369`）、critic 后**按 diff 再验**保留槽（`loop.py:523-530`）、四条测量前具名门（`:495,550,566,599`）、`predicted_affected` 命中率（`:159-178`）、`ΔS` 冻结（`history.py:91-92`）、`S*` 只随 winner 动（`loop.py:335`）。**旧仓只搬了公式、把约束全丢了**——这是它 `novelty ≡ 1` 的根因。
3. **critic 是两层且只管意图**：确定性预检（凭据 + 领域 patterns）命中即拒、不进 LLM；LLM 层**六条具名理由**，并明说"**运行期正确性不是你的职责**，确定性 compile/smoke 在你之后处理"（`critic.py:50-102`）。`smoke` 是**活性门，不是选择规则**（`loop.py:562`）。
4. **有一条证据管线，不是"缺两个文件"**：选轨迹（最差任务的 **worst** trial + 最好任务的 **best** trial，`n_fail=22`/`n_success=6`，`loop.py:134-150`）→ **只读 digester 子代理**（工具 jail、三套 schema、6000 字符硬顶）→ **analyst 三镜报告**（failure_modes/capability_gaps/success_habits，**跨轮累积模式名**）→ 归因 scoreboard。
5. **历史是一条 edit 一条记录**（`history.py:36-38,83`），带显式轮次 `t` 与 `variant`；**`ΔS`/`ΔC` 在测量时刻冻结**（`:91-92`）；**`S*` 是"已接受 head 轨迹"的最大值**（`loop.py:363`），被拒候选永不抬高它。端口用候选序号/history 长度充当 round——要改成显式轮次。
6. **`novelty` 的去重**：`set(edit_components)`（`components.py:107`）→ **两条同机制编辑的 novelty 是 1**，两条**不同**结构机制才是 2。`K` 是 **9 个 harness 组件**（不是资产类别），`K_STR` 是其中 4 个。

---

## 3. 阶段 A 的剩余工作（照做，别重新设计）

前置结论见 [`context.md`](context.md) §4.1。**四条硬约束**：① DSH 运行时事件词表是**仓内生成**的，仓外插件的事件按构造不在表内；② `SessionEventMap` 类型增强**运行时不可见**；③ `ignorable: true` 是唯一机制，而**活跃写入缝设不了它**；④ 未标记的未知类型会让**整份会话永久不可读**。

因此控制 store 的形态是固定的：

| # | 做什么 | 退出条件（可机械判定） |
|---|---|---|
| A1 | 选一个**已知的、log-only（非 surface）**的 DSH 事件类型；`data` 承载 `{protocol:'singularity.control', version, kind, payload}` | 新进程能重放我们自己的事实；未知内层 kind/version/字段由**我们**具名拒绝 |
| A2 | 活会话写入用 `ctx.sessions.get(id).append(knownType, envelope)` + **`await ctx.sessions.flush(session)`**；`flush` 返回 `false` 即**当作失败**（无持久化监听者参与） | 屏障失败不返回成功 |
| A3 | 非活会话：自己开 `write` 句柄 + `append` + `await handle.flush()` + `close()` | 同上 |
| A4 | `ProtocolLog` 降为**纯内存测试后端**（保留它对纯函数测试的价值），文件存储实现删除 | 门禁 `single-durable-writer` 收紧为"**零持久写者**"后仍全绿 |
| A5 | 补**我们自己的双进程控制 store 探针** | 第二个进程拿 `SessionAlreadyOwnedError`；杀持有者后立即接管；提交后/答复前崩溃可识别原结果 |

**禁止**：从 registry 装 `@deepseek-ai/*`（npm 上是 `0.0.1-rc.1`，本地是 `0.2.0-rc.2`）；借用一个已知 DSH 事件名塞不相符的业务载荷；从活跃缝设置 `ignorable`。

A 完成后进 **阶段 B**（真实执行纵切：最小 E3 + Task 分解与责任 + 初始不可变 Revision + 最小 Bubble + 真实 verifier 与固定来源 receipt），**K1 检查点在 B 完成后**。

---

## 4. 不要重新讨论的

- **三层划分**（DSH 存储 / 我们只做协议纪律 / 领域载荷）——review §5 已确认。
- **RRSI 只移植决策层**——[ADR-0001](adr/0001-rrsi-port-boundary.md)。**五处有意收紧**（`rounds−1` 退火、+25% 成本上界、删 `w_n·ν`、`ΔC` 未知拒绝、适配器核验替代 diff 分类）是判断不是遗漏，**不要"修好"它们**，各需一个反例测试。
- **`storageDomain` 不预建**——当前无真实用途。
- **旧仓冻结为行为参照**，不迁移只约束旧包结构的测试。

## 5. 门禁纪律（每次提交都要过）

`pnpm verify` = `tsc --noEmit` + `vitest run` + `node scripts/gates.mjs && node scripts/gates.mjs --probe`。
**新增门禁必须同时给出让它失败的探针**——自检已经抓到两个真实缺陷（一条捷径使某门禁永不可能失败；剥离字符串后写者检测失效）。当前 7 条门禁 + 自检全绿，55 测试。
