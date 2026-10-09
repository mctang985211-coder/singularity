# tdd-seams.md —— E/F 的构建顺序：先认缝，再一个切片一个切片地写

来源：`mattpocock-skills-zh-CN/skills/engineering/tdd`（red → green loop 的 reference）。
本文件只记它与本项目**冲突或互补**的地方，以及 E/F 提议的缝（seams）。**缝没被确认之前不写任何 test。**

## 0. 一处必须先说清的冲突

你的指令是"**先写 spec 固定好想要的功能，再让人进去实现**"。引用的这份 skill 把那个顺序
**明确列为反模式**：

> **Horizontal slicing**：先写所有 tests，再写所有 implementation。批量 tests 验证的是*想象中的*
> behavior：你测试的是东西的 *shape*，不是 user-facing behavior；tests 会对真实变化迟钝，并在理解
> implementation 前承诺 test structure。改用 **vertical slices**：一个 test → 一个 implementation →
> repeat，每个 test 都是回应上一轮学习的 **tracer bullet**。

**冲突的解法（我提议这样理解你的意图）**，因为两者其实各自对了一半：

| 层次 | 谁先 | 为什么 |
|---|---|---|
| **缝**（公开边界、载荷形状、语义规则） | **先定，并且要你确认** | skill 明说："只测试预先认可的 seams。写任何 test 前，先写下要测试的 seams 并与用户确认。" 这就是你说的"先固定想要的功能"——固定在**缝**这一层。 |
| **每个缝的 spec 与实现** | **一个切片一次**：先写会红的 spec，再写刚好让它绿的实现 | 这就是你说的"先 spec 后实现"——在**切片**这一层成立。 |

所以最终顺序是：**认缝（含你签字）→ 按缝排优先级 → 每个缝走一遍 red→green → 全部绿之后统一 refactor**
（skill：refactoring 不属于 red→green loop，属 review 阶段）。

**与 `docs/spec-policy.md` 的关系**：完全一致。skill 的"好 test 只经 public interface 验 behavior"
就是我们那条"只锁调用方看得见的行为"；skill 的 seam 就是我们说的"公开表面"。
**但要加一条**：skill 的 seam 是"预先与用户确认过的边界"，比"调用方看得见"更严——
**没被确认的缝，不写 test**。

## 1. 从这份 skill 直接采用的四条

1. **红先于绿。** 先写会失败的 test，再写刚好够让它通过的代码；不预判未来的 test，不加投机功能。
2. **一次一个切片。** 一个缝、一个 test、一个最小实现。
3. **反模式清单当 review 项用**：
   - *implementation-coupled*：mock 内部协作者、测 private、走 side channel 验状态；特征是
     **行为没变而 refactor 后 test 红**（= `docs/spec-policy.md` §4 的"删掉它"）。
   - *tautological*：expected value 用和代码同样的方式算出来（`expect(add(a,b)).toBe(a+b)`、把常量
     断言成它自己）。**expected 必须来自独立来源**：已知正确的字面量、手算样例、或 spec。
   - *horizontal slicing*：见上。
4. **refactor 不属于 loop**，绿了之后单独一次。

## 2. E/F 的缝（**待你确认；确认前不动 test**）

顺序按"下游依赖上游"排。每条给：缝在哪、调用方看见什么、为什么值得一条 test。

### E —— RRSI 闭环（`review.md` §5：至少两轮完整执行；保留与失败能结案；第二轮读第一轮；历史不被新 head 改写）

| # | 缝 | 调用方看见什么 | 为什么优先 |
|---|---|---|---|
| E1 | **发布登记**（`release@1` 或指针切换的新成员/新 kind） | 一条事实说"某环境 head 指向某修订，该修订声明的资产类是 X、Y"，**资产类绑定到修订内容摘要**，reducer 校验它与清单一致 | 补掉已记账的缺口：`acceptedAssetsBelow`（novelty 的历史输入）**今天没有承载它的事实**，两个 wiring 各发明了一套约定，而 `noveltyOf` 喂给 selection——两套约定能从同一条日志得出两个胜者。R03 要求历史输入冻结在事实里 |
| E2 | **消费登记** | 一条事实说"某次 run 实际加载/调用了哪个方法、哪个版本、来源是什么"；没被任何 run 消费过的已发布方法**可见为未消费** | R08 最后一段：只证明 Run 钉住某 revision，**不能**证明其中某个 Skill/Tool 被使用 |
| E3 | **轮次结案** | `round/decided` 加上"为什么结案"（有胜者 / 无胜者保留 incumbent / 停滞），每个槽位的处置与理由已有 | R01："无胜者也要记录本轮轨迹"；停滞要是**事实**而不是推断 |
| E4 | **探索消费者** | 保留探索槽**实际约束候选生产**（已有一半：非 exploratory 不能占保留槽）；第 N 轮的探索结果进入第 N+1 轮的计划 | R05：停滞后 reserved exploration slots 应实际约束候选生产，**并有失败反例** |
| E5 | **剪枝消费者** | 一个"移除已接受结构"的候选可提交、可度量、可采纳 | R05：剪枝建议应真的能产生移除已接受结构的候选并重新评估 |
| E6 | **两轮闭环** | 第二轮的生产决策读第一轮事实；同一截止范围重放生成**相同**决策；后续 head 移动**不改写**历史增益 | R04 + R03；`cd-probe` 已证一半，K2 要完整两轮 |

### F —— 替代旧栈（`review.md` §5：恢复/边界行为满足新契约，真实质量和成本满足冻结标准）

| # | 缝 | 调用方看见什么 | 为什么优先 |
|---|---|---|---|
| F1 | **冻结领域任务集** | 一组任务，各自的契约与判据，**冻结的模型配置与预算** | R08：evolve 集、发布前回归集、独立留出/OOD 任务**分别记录** |
| F2 | **同口径对照** | 同一任务集、同模型配置、同预算下的对照测量，缺失按冻结槽位计划表示 | R09 第 249 行：避免把"函数已接线"当成"正则化有效" |
| F3 | **行为回归** | 新契约下的恢复/边界行为逐条重放（复用 `control-probe`/`recovery-probe`/`cd-probe` 的读数） | F 的退出条件前半句 |

## 3. 走法（每个缝一遍）

1. 写这条缝的 spec：**只经公开边界**，expected 来自独立来源（手算数、已知正确的字面量、协议冻结文本）。
2. 跑它，**看着它红**，把红的原因记下来（红的理由必须是"功能还没实现"，不是"接口不存在"）。
3. 写刚好让它绿的实现。不加未来要用的成员、不为预判的 test 留钩子。
4. 跑全量：`tsc`、`npx vitest run`、`node scripts/gates.mjs`。
5. **变异证明**：把这条规则的那一行关掉，确认刚才的 spec 红（`docs/debugging.md` §4）。
6. 下一个缝。

全部绿之后：一次独立的 refactor + review（skill：refactor 不属于 loop）。
