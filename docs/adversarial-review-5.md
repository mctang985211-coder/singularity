# adversarial-review-5.md —— 第五轮：第四轮的修复被推翻

**审的是 `87f3a88`。只读；测量在 `/tmp` 干净副本上做。**
**结论：两条 blocking，都在"上一轮宣布已修"的东西里。**

---

## BLOCKING 1 —— BL-3 没关：载荷族只按**解析器自己命名过**的成员增长

第四轮的修法是"走一族载荷"（先单独放探针成员，再把探针成员与**迄今命名过的每个成员**并置，到不动点）。
**于是解析器从未命名过的成员永远不会被采样**，`conditional` 也就永远不会被报出来。

**构造**（`src/task/run.ts`）：
```ts
const note = source['operatorNote']
assertClosedKeys(source, note === undefined ? ['runId','revision'] : ['runId','revision','operatorNote'], where)
```
→ `tsc` 干净、**19/19 全绿**、账本仍写 `["revision","runId"]`、门禁自己的探针读到 `known: runId, revision`；
而**经真实 `MemoryLog`**，一条带 `operatorNote` 的 `run/started` **被接受并折叠进 `RunState`**。
对照：第四轮那个"按**已命名**成员条件"的形状**仍然被抓到** —— 所以机制只覆盖了它自己那个例子。
**每次运行打印的那句话因此对这个解析器是假的。**

## BLOCKING 2 —— BL-4 没关：文本网是按**文件**跳过的，不是按声明

`unaccounted = files.filter(f => src/ && !observedSites.has(f))` ——
**一个被观测到的声明豁免整个文件**，而 `*/protocol.ts` 全都在 `observedSites` 里（实测就是那八个）。

**构造**：在 `src/task/protocol.ts` 里放一个**没有 load 走到**的导出函数，内含
`registry.declare<…>('zzhidden', 1, {…})`（**点号拼写**）→ `tsc` 干净、**19/19 全绿**，
而它是**活的**：`zzhidden@1 zzhidden/leaked` 能经真实 log 提交。
对照：同一函数搬到 `src/task/zz-hidden.ts`（无被观测站点）→ 文本网正确报错。
**所以打印的"只有点号拼写才被文本网覆盖"这句话，对那八个文件是假的。**

附带：note 里点名的两个模块**什么都不声明**（归因是空的）；桩**可以被骗**
（把加载期声明藏在 `typeof dshAgent.AgentRegistry?.version === 'string'` 后面，桩下为假 → 19/19 全绿，
而运行仍宣称"它们加载期声明的东西是被观测到的"）；且**愈合不传播**。

---

## HIGH

- **H-3 被一个 6 行的"镜像感知"残桩绕过**：`existsSync('src-absent')` 为真时打印标记并 `exit 3`，
  否则 `exit 0` → **19/19 全绿**，而它什么都不判。**镜像给自己打了标签，所以这个绕过是从 `gates.mjs` 里抄出来一个常量。**
  （**这条是已声明的限制**，note 里承认了这个形状，所以它不是假声明。）
  有用的反面结果：**去"治愈"那个共享镜像不会让腿失效，反而让它对治愈者和之后每条脚本门禁开火（6/19 红）—— fail-closed。** 成本可忽略。
- **H-1 可以用三种拼法重开，而记录可以绕过**（都 `tsc` 干净、19/19 全绿、对照都红）：
  `export const a = 1, b = 2`（只枚举第一个 declarator）、`export default 1`、
  `export const {a,b} = {…}`；而最便宜的是**在 `src/index.ts` 加一行用不到的 import** ——
  barrel 就"绑定"了那个名字，`PUBLISHED_WITHOUT_CONSUMER` 根本不用动。
- **H-2 的后继**：`createRequire(import.meta.url)('node:fs/promises').writeFile(…)` → `tsc` 干净、19/19，
  **而且门禁那次运行自己把文件写了**（sweep 会 import 每个 src 模块 → 执行模块级代码）。
- **evidence-budget：便宜的跑法只挪了一个 `mkdir`** —— `scripts/` 下 5,000 行会红，
  `scripts/probes/` 下同样的 5,000 行 **19/19 全绿**；`docs/**` 也不收费。
- **BL-2 只对它命名的那个构造成立**：把"从不读参照"的 meter 的正则**加锚**（`/-t[0-9]+$/`）→ **52/52 全过**。
  **检查的标签比它的谓词宽。**

---

## 两笔债

- **变异脚本：已关，独立复核过。** 审查者自己跑 `node scripts/mutate.mjs --all` →
  `35 claim(s): 34 caught, 1 recorded miss(es), 0 not`；harness 只写 tmpdir；锚点腐烂检查有牙齿。
- **文档账本：只关了一半。** `tree-baseline.json` + `tree-inventory` 覆盖 **两个**文件
  （`CLAIM_DOCS = ['docs/context.md','docs/f-evidence.md']`）。
  往 `context.md` 里塞一句"本树有 12 门禁"会红，**同一句塞进 `blueprint.md` 不红** ——
  而第二轮 F6 点名的正是 `blueprint.md`：它今天仍写着"15 文件"、仍列着已删除的 `src/protocol/log.ts`、
  仍写"`gates.mjs` | 492 | **10 条门禁**"（实际 1,973 行 / 21 门禁）。

---

## 「不可能失败的断言」家族

**存活（4，行号未变）**：`environment-binding.spec.ts:72`、`strategy-decision.spec.ts:183`、
`round-probe.mjs:263`、`cd-probe.mjs:763`（后两条：`reason` 经 `text()` 折叠，空串在检查跑之前就被拒）。
**已修（2）**：domain-probe 的 `declared !== 'TBD'` 与那对 cutoff 同义反复。
**新的 class-1：无可证明者。** 新的弱谓词：meter 那条；`:1088`（跨重开只比事实**条数**，标签说的是同一性）；
`:440`（`every(Boolean)` 在空方法表上空洞通过）。

---

## 协调者的判断：**"采样推断成员集"这个机制本身是错的**

四轮下来一个清晰的模式：**每一轮把门禁收紧，下一轮就证明那个收紧不完备**，
而门禁已经长到 **1,973 行**。根因不是哪一处没关严，而是**机制选错了**：

> 让门禁去**探测解析器的行为**来推断闭合成员集，等于让门禁成为"一个有 bug 的程序去建模另一个程序的运行时行为" ——
> 于是每一轮都要为上一轮的建模缺口再打一层补丁，而补丁本身又是一个可被条件绕过的模型。

**按项目自己的两条原则，正解是反过来的：**
- "**该由数据结构保证的，不要交给约定**" —— 闭合成员集应当是**声明出来的一个值**，不是推断出来的行为；
- "**能用固定端口交流的不要使用内部量**" —— 门禁现在读的是解析器的**内部行为**（喂它一个载荷看它怎么反应），
  而不是它对外承诺的一个**值**。

所以：**每种 kind 显式声明自己的闭合成员集（一个常量），`assertClosedKeys` 用它，门禁直接读它。**
两者从此**不可能不一致**，因为只有一个。采样、条件分支、不动点、族遍历全部删除。

代价：触及每个 kind 的解析器（四个 src 域）。**收益：门禁不再需要"猜"，也不再需要为猜错打补丁——删掉的比加上的多。**
这正是"宁少勿多"和"做之前先想有没有更简单的办法"。
