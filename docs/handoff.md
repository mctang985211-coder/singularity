# 交接一页纸（本文件按交接重写）

> 给接手者的最短路径。**不要重新读全部文档，按下面的顺序读。**
> 本页最后更新：2026-10-09，A 提交边界纠正，B 部分实现、K1 待完成。
> （2026-10-10：只把 §5 里两处过期的计数换成指针——`tree-inventory` 现在会扫每一份文档的计数声明；
> 正文其余部分仍是 10-09 当时的状态，没有重写。）

---

## 1. 五分钟纠正认知（读这几处就够）

| 顺序 | 读什么 | 读完你会知道 |
|---|---|---|
| 1 | 本文件 §2 | RRSI 的**六处纠错**——如果你脑子里的 RRSI 是"每轮 k 个候选 + critic 预筛 + novelty 计数"，那是错的 |
| 2 | [`context.md`](context.md) §0 + §3 | 已定决策（不要重新讨论）；每个反例的状态与回归位置 |
| 3 | [`context.md`](context.md) §4.1 + §12 | 控制 store 的形态与提交纪律：可见不等于持久化确认，读取没有写权限 |
| 4 | [`context.md`](context.md) §8 | 旧仓**行为**参照（证据 A）：哪些行为抄、哪些形状丢、哪些注释在说谎 |
| 5 | [`phase-b-design.md`](phase-b-design.md) | 阶段 B 的设计：事实面、不变量、强制点、消费者、明确不做 |

**然后**（只在需要时）：[`blueprint.md`](blueprint.md) §2.3 = RRSI 逐行接线状态；[`rrsi-upstream-reference.md`](rrsi-upstream-reference.md) = 上游逐行对照；[`legacy-behaviour-reference.md`](legacy-behaviour-reference.md) = 旧仓逐条 `path:line`；[`adr/0001`](adr/0001-rrsi-port-boundary.md)；[`review.md`](review.md) = 第一轮审核与 K1/K2。

---

## 2. RRSI 的六处纠错（读源码后才成立的）

1. **`m` vs `k`**：**每轮 `cfg.m` 个候选**（`loop.py:292`），**`k` 是每任务 trial 数**（`config.py:60-61`）。默认 `T=20, k=2, m=2`——**两者都是 2，所以"每轮 k 个候选"这个说法极易写错**（我写过）。
2. **正则化不在公式里，在机械约束里**：`done()` 回弹（预算/保留槽/`component ∈ K`/六个必填字段，`propose.py:328-369`）、critic 后**按 diff 再验**保留槽（`loop.py:523-530`）、四条测量前具名门（`:495,550,566,599`）、`predicted_affected` 命中率（`:159-178`）、`ΔS` 冻结（`history.py:91-92`）、`S*` 只随 winner 动（`loop.py:335`）。**旧仓只搬了公式、把约束全丢了**——这是它 `novelty ≡ 1` 的根因。
3. **critic 是两层且只管意图**：确定性预检（凭据 + 领域 patterns）命中即拒、不进 LLM；LLM 层**六条具名理由**，并明说"**运行期正确性不是你的职责**，确定性 compile/smoke 在你之后处理"（`critic.py:50-102`）。`smoke` 是**活性门，不是选择规则**（`loop.py:562`）。
4. **有一条证据管线，不是"缺两个文件"**：选轨迹（最差任务的 **worst** trial + 最好任务的 **best** trial，`n_fail=22`/`n_success=6`，`loop.py:134-150`）→ **只读 digester 子代理**（工具 jail、三套 schema、6000 字符硬顶）→ **analyst 三镜报告**（failure_modes/capability_gaps/success_habits，**跨轮累积模式名**）→ 归因 scoreboard。
5. **历史是一条 edit 一条记录**（`history.py:36-38,83`），带显式轮次 `t` 与 `variant`；**`ΔS`/`ΔC` 在测量时刻冻结**（`:91-92`）；**`S*` 是"已接受 head 轨迹"的最大值**（`loop.py:363`），被拒候选永不抬高它。
6. **`novelty` 的去重**：`set(edit_components)`（`components.py:107`）→ **两条同机制编辑的 novelty 是 1**。`K` 是 **9 个 harness 组件**（不是资产类别）。

**三处 RRSI 死字段已被独立复核确认**（旧仓，无一处被证伪）：`incumbentMechanismCounts` 从不被生产调用方传入；`CandidateFact.edits` **被读**而生产侧恒 `[]` → **机制新颖度信号静默恒空**（比"字段没填"更坏）；`consumption` **连读者都没有**，可直接删。逐条 `path:line` 见 [`context.md`](context.md) §8。

---

## 3. 阶段 A 提交边界纠正；阶段 B 补齐到 K1

**A 的退出条件以纠正后的业务契约验收**：可读前缀不等于已提交；屏障失败后重送也不得未经确认返回成功。旧测试对重送成功的断言已撤回，见 context §12。

| 退出条件 | 证据 |
|---|---|
| 双进程互斥 | `scripts/control-probe.mjs` 第 2 节观测 |
| 并发命令正确 | 提交队列 + `gate.spec.ts` |
| **屏障失败不返回成功** | `tests/control-barrier.spec.ts`：首次/重复请求均拒绝；已提交读 cut 不变；恢复必须经过成功屏障 |
| 提交后/答复前崩溃可识别原结果 | `commandId` 进信封 + `adopt` 重建命令表；探针 4b（`failures: 0, gaps: 0`） |

**控制 store 的形态（不要再重新设计）**：它骑在**它自己的一个 DSH session** 上——事件类型 `plugin:singularity:control`，带 `ignorable: true`，用自己的 write 句柄 + `await handle.flush()`。**不要**借用那 59 个已知 DSH 类型中的任何一个：DSH 生成文件的原文写着"**仓外插件的扩展事件按构造不在表内**"，而**活跃写入缝设不了 `ignorable`**，未标记的未知类型会让**整份会话在下次打开时永久不可读**。DSH 只搬字节（信封形状、`ignorable` 成员、深冻结、`flush` 屏障、跨进程 lease），**每一个语义检查都是我们的**。

**阶段 B**：S1 与 S3 验证器部分已落地；继续 S2 分解/依赖、S4 Bubble 与输入绑定、S5 可信命令边界/责任/E3 生命周期、S6 真实执行与恢复。设计在 [`phase-b-design.md`](phase-b-design.md)：§2 已纠正为“局部 reducer + 跨实体串行命令检查 + 派生投影”；§5 要求最小预算停止；§6 按 K1 12 场景交回。独立 DSH 勘探实验不是产品执行闭环。**K1 通过后进入 C 的可信评估，再依次 D/E。**

**禁止**：从 registry 装 `@deepseek-ai/*`（npm 上是 `0.0.1-rc.1`，本地宿主是 `0.2.0-rc.2`，安装即大幅降级）；借用一个已知 DSH 事件名塞不相符的业务载荷；从活跃缝设置 `ignorable`；在没有第二个消费者之前新增扩展点。

---

## 4. 不要重新讨论的

- **三层划分**（DSH 存储 / 我们只做协议纪律 / 领域载荷）——review §5 已确认。
- **RRSI 只移植决策层**——[ADR-0001](adr/0001-rrsi-port-boundary.md)。**五处有意收紧**（`rounds−1` 退火、+25% 成本上界、删 `w_n·ν`、`ΔC` 未知拒绝、适配器核验替代 diff 分类）是判断不是遗漏，**不要"修好"它们**，各需一个反例测试。
- **`storageDomain` 不预建**；**旧仓冻结为行为参照**，只抄行为、不迁形状。
- **不建 group/router/嵌套组**（旧仓 `group/add` 无生产者、`routerFor` 无读者）；**不建通用沙箱平台**。

## 5. 门禁纪律（每次提交都要过）

`pnpm verify` = `tsc --noEmit` + `vitest run` + `node scripts/gates.mjs && node scripts/gates.mjs --probe`。
**新增门禁必须同时给出让它失败的探针**——自检已三次抓到真实缺陷（一条捷径使某门禁永不可能失败；剥离字符串后写者检测失效；对齐门禁的探针自身覆盖了一个已不存在的键）。**新增测试也要能用变异证明它真能失败**：把被测行为改坏，看它是否真的报错——`tests/control-barrier.spec.ts` 就是这么做的。当前**门禁与自检全绿**（条数与测试数见 `tree-baseline.json`，由 `tree-inventory` 每次与实测比对）；`scripts/control-probe.mjs` 现在也在门禁清单里——阶段 A 的退出条件此前不在任何自动路径上，v2 变更弄坏它时无人报警。
