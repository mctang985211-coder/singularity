# adversarial-review-4.md —— 第四轮：A–F 全齐之后

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

**审的是 `8b07482` 的干净副本。只读；测量全在 `/tmp` 副本上做。**
基线复核：`tsc` 干净、323 测试 / 29 文件、**19/19 门禁**、`--probe` OK、`domain-probe` 51/51。

**审查者的结论：BL-1、BL-3 会挡这个阶段；BL-2、BL-4 同类，也应挡。**

---

## BLOCKING

### BL-1 —— F 的 `met` **不看方向**：它为一个"自己 fixture 声明更差"的方法报告"胜过 H0"
`scripts/domain-probe.mjs:743` `gain = candidate.quality - baseline.quality`；
`:749` `met = complete && worstCaseGain > bars.minQualityGain && withinCost`；
`:970` 标记行。**整个探针里 `direction` 只出现在第 330 行**（透传给 `openEvaluation`），
**从不参与判决** —— 尽管 `EvaluationView.direction` 存在并写明"两个方向不一致就是两个 caliber，不可池化"。

**构造**：只把 fixture 的 `frozen.metric.direction` 由 `"higher"` 改成 `"lower"`，用仓库自己的
`digestOf` 重算摘要，改探针那一处字面量。**没有别的改动，没有 src 改动，没有换方法。**
```
solve 0.2500 -> 1.0000, gain 0.7500 -> met true
domain-probe: OK — the published method beats H0 …        (51 checks, exit 0)
node scripts/gates.mjs → 19 gates passed
```
在 fixture 自己冻结的口径下，published（1.0000）**比 H0（0.2500）更差**，探针说 `met true`。
caliber 检查照样通过（方向在两侧的 caliber 里，所以两侧仍然"逐位冻结同一个口径"）。
**这就是 F 自己的退出条件上的错误接受，且零源码改动即可达成。**
（旁证：`f-evidence.md:101` 把一条 direction 变异记为 "caught"，但实测"改 fixture 不更新字面量"
恰好也是 3 处失败 —— 那次变异很可能只是撞了摘要钉子。**变异脚本不在仓库，无法复核。**）

### BL-2 —— 仪器的字节只跟自己比：一个**从不读参照文件**的 meter 通过全部 51 项
`docs/f-evidence.md:46-48` 声称"工具被重建（同名不同字节）会改变真实 caliber 摘要 —— 这正是 R08 防的"。
**这是假的。** `frozenTools`（`domain-probe.mjs:403-406`）由**运行时**的 `sha256(meterProgram)` 构建，
`frozenCaliberInputs`（`:582-594`）由 `frozenTools` 构建，bubble 也是。**两边一起动**，所以改仪器不可能让它失败。

**构造**：把 `METER_SOURCE` 换成**从不读 `referencePath`**、只数探针自己的 `-t<N>` 命名约定再除以硬编码 4 的实现。
fixture 不动 → `domain-probe: OK`（51/51，exit 0），而 fixture 的判据说"选择要恢复任务输入的参照词"。
**F 提供的每一项检查仍然通过**，包括手算值那一项，因为它就是照着复现这四个数造出来的。
（缓解：selftest 确实抓到过一个**真坏**的 meter（`reference.length` → `unregistered-verifier`），
所以 selftest 只保证"产出一个数／产不出数"，**从不保证"在量参照"**。）

### BL-3 —— `acceptedMembers()` 把**一条分支**的集合当成"该 kind 的成员集"：第三轮的 F4 绕过对新关闭仍然有效
`gates.mjs:531-546` 只喂**一个**载荷（`{__gate_unknown_member__: true}`），从拒绝里取出 `known:` 列表当闭合集。
于是**接受集依赖载荷的解析器**会被报成"探针没走到的那条分支"的集合。

**构造**：`src/task/run.ts` 的 `runStartedKind` parse 里按 `source['revision'] !== undefined` 条件闭合，
reducer 把 `operatorNote` 带进 `RunState`。→ `tsc` 干净、**19/19 全绿**、账本仍写 `["revision","runId"]`；
**经真实 store 提交并折叠**：`state run fields` 里出现 `operatorNote`。
**所以"加成员不升版本"仍然可达，而账本和每一条门禁都说形状是闭合的两成员。**
机制确实不是"第二份真相"，但它是**一条分支的一个样本**，而它的声明（"该 kind 的载荷成员集"）比这宽。

### BL-4 —— 两个不可加载的模块靠第三轮那个文本模式兜着；而**不可加载的 `protocol.ts` 无人兜底，且打印出来的说明说反了**
`gates.mjs:1226`：`unaccounted = files.filter(f => src/ && !/(^|\/)protocol\.ts$/.test(f) && !observedSites.has(f))`。
两个独立洞：
- **(a) 中括号拼写 + 不可加载模块**：把第三轮的绕过搬进 `src/runtime/agent-session.ts`（它在加载期用它）
  → **19/19 全绿**。对照：**同一段**插进可加载的 `src/strategy/published-assets.ts` → `gates: 2 of 19 failed`。
  **两边都证明了：能加载的地方它是机制，不能加载的地方它是那个被击败过的同一段文本模式**；
  而 `--probe` 还把这个 miss 打成成功：`ok the text net handled the same declaration spelled with brackets (0 findings)`。
- **(b) 新的 `src/runtime/protocol.ts` 两个机制都看不见**：它 value-import DSH 包（所以 sweep 加载不了），
  用 `HIDDEN['declare'](…)` 在加载期声明 `hidden@1` → **19/19 全绿**，
  而打印的说明是"their declarations are read as text, not observed"——**对这个文件是假的**：
  `protocol.ts` 被从 `unaccounted` 里过滤掉了，`declarationTextFindings` 根本不会跑它。
  A/B：同一文件用 `import type`（于是可加载）→ 门禁报红；用 value import → 静默。
  **声明的常规居所，是唯一一个"加载不了就零覆盖"的地方，而唯一的公开说明断言相反。**

---

## HIGH

- **H-1 —— `no-unreferenced-export` 仍有一条"背书"路径：barrel 再导出算作绑定。**
  `gates.mjs:325-338` 把 `export { X } from './y.ts'` 记为**对 y.ts 的绑定**（只有 `declaredExports` 排除再导出）。
  于是**任何经 `src/index.ts` 再导出的东西永远不会被报**，无论多死。
  实测：加 `export const zzOrphanProbe = 1` 到 `decision.ts` **并**在 `index.ts` 里再导出它 → **19/19 OK**；
  只在 `decision.ts` 加 → 门禁报错。**我的提交消息声称这个环已经关掉（"counting it twice would let a barrel
  file vouch for a name nothing uses"）——只在声明侧关了。**
- **H-2 —— `no-durable-writer` 抓不住它自己注释里点名的那个拼法。**
  `gates.mjs:294-306` 只要动态 import 的**第一个 token** 是引号字面量就放行，
  于是 `await import('node:' + 'fs/promises')` 被读成 `'node:'`。实测 → **tsc 干净、19/19 OK**；
  写成字面量则报错。**注释 `:296-297` 说正因拼接拼法才拒绝这个构造 —— 它没有拒绝。**
- **H-3 —— 新的行为门禁的全部判决是对 stdout 的子串匹配，而自检仍然从不真的跑到脚本。**
  `SCRIPT_GATES` 现在 9 条；自检（`:1198-1206`）仍然喂合成字符串。
  实测：把 982 行的 `domain-probe.mjs` 换成**打印标记行的一行残桩** → `ok domain-comparison`、
  **19/19 全绿**、`--probe` 还报 `ok domain-comparison fired`。
  **它分不出探针和残桩，而这一条门禁现在覆盖 F 的全部退出条件。**
- **H-4 —— F 的探针里两条新的"不可能失败"，加一条算术上不可能的文档声明。**
  - `:243` `check('the fixture says "TBD" …', declared !== 'TBD')` —— 由 `:242` 蕴含（sha256 永远不是 `'TBD'`），
    **不可能成为第一个失败**，却计入 51。
  - `:931-932` `check('and there are facts above the cutoff …', entries.length === cutoff)` ——
    `cutoff` 是 25 行前从同一个纯读者读出来的，中间没有写者，谓词是 `x === x`，
    **而标签断言的与事实相反**。插桩实测：`cutoff=51 lengthNow=51 above=0`。
    于是"重放"其实在整份日志上做，**根本不是关于截止范围的断言**；
    而 `f-evidence.md:25` 的"另有 51 条事实在截止范围之上"**算术上不可能**（总共 51 条，截止就是 51）。

---

## MEDIUM

- **M-1 —— 冻结标准有两个所有者，而结论身份命名的是没做决定的那个。**
  `:726` `standards = fixture.frozen.standards ?? fixture.standards`，而 `:886` 的 `conclusionInputOf()`
  记的是 `fixture.standards`。构造：`standards = {5.0, 0.0}`（被身份覆盖的那个）与
  `frozen.standards = {0.1, 0.15}`（真正决定的）→ **51/51 OK**。
  **同一个结论身份可以有不同答案 —— 身份不决定结论。**
- **M-2 —— `:306-307` 的标签远强于它的谓词。** 标签说"每个修订的方法文件都在盘上，且各被至少两个任务消费"；
  谓词只查 `keys.length > 0` 和一个在摘要钉住后恒为真的常量。**"谓词弱于标签"的形状。**
- **M-3 —— 标记行的 "under one caliber" 比事实宽（与预算缺口方向相反）。** 预算缺口是**诚实记录**了的，
  但 solve 是在**两个** caliber 下测的（每任务一个，因为任务的输入属于"问题"的一部分）；
  探针自己的读数写着"(one per task)"，**与标记行那句互相矛盾**。
- **M-4 —— 池化是"没做"，不是"被拒"。** `src/` 里根本没有跨任务投影，
  所以分隔靠的是这个脚本的数据流加每判决一个 `set` 标签；未来某次编辑报告 `[...solve, ...holdout]` 不会触发任何门禁。
  （结构性的部分是：池化集在 fixture 里不可表达，且 `:810` 会在池化数等于任一集合时失败。）
- **M-5 —— "故意做差的修订被拒"是探针的判决，不是拒绝。** 没有任何产品机制拒绝更差的修订。

## LOW

- **L-1** 文档账本仍在漂：`context.md:425` 写"290 测试 / 25 文件；18 门禁"，实际 **323 / 29 / 19**。
  第二轮 F6 要求"一行被检查的账本"，**至今没有**。
- **L-2** `f-evidence.md:70` 说"F 本阶段不碰 `scripts/gates.mjs`"，而 F 那次提交**确实**改了它（接线那一行）。
- **L-3** `no-unreferenced-export` 对 `.js` 说明符误报（tsc 能解析、`resolveModule` 不能）。今天不可达。
- **L-4** fixture 摘要是**单文件钉子**：改了 fixture 又重算那两个字面量就绿。**它抓事故，不抓深思熟虑的改动。**

---

## 六条根因的重新裁决（A–F 全齐）

1. **形状繁殖**：对可加载的顶层形状**已关闭**；**以三种实测方式仍然开着**（条件解析器 BL-3、
   不可加载的 `protocol.ts` BL-4b、嵌套形状限制已自行打印）。
2. **重建上游已有的**：**不存在**，无新实例（但见 H-2）。
3. **声明了没有消费者**：**仍然活着，连续第三轮** —— fixture 的 `metric.direction` 在 F 为消费口径而建的
   对照里**没有读者**（BL-1）；仪器没有消费者（BL-2）；标准有两个所有者（M-1）。
4. **该由数据结构保证的交给约定**：`src` 里没有提示词；**新形式** —— "更好的方向"现在走在数据里
   （`EvaluationView.direction`），**而最后一个消费者仍然套用约定**。
5. **RRSI 只引进一半**：方向读者已在 `strategy/view.ts` 落地（第三轮 H1 已修），
   **同一个半引进在往外一层重现** —— F，口径的最后一个消费者，忽略了为它而加的那个成员。
6. **两次重构没换掉根因**：门禁是真的（19 条，含 9 条行为）；**这一类存活 —— 见第 7 条。**

### **第七条模式（只有 F 存在之后才看得见）：成长与取证都搬到了门禁不看的地方**

`sourceFiles()`（`gates.mjs:39,59-77`）只扫 `src/` 与 `tests/` 的 `.ts`，
所以 **`scripts/`（15 个文件、7,149 行）和 `tests/fixtures/*.json` 不在任何检测器、任何行数预算、任何密度预算里** ——
而 `spec-budget` 对 `tests/*.spec.ts` 的每一行都收费，且已经卡在 **0.8487 / 0.85**。

**F 是第一个完全在这条车道里交付的阶段**：0 src 行、0 spec 行、982 行探针 + 一个 fixture，
而它的判决靠**子串匹配**读出（H-3）。

> "棘轮不只是没能约束新工作；**它让'加探针行'成了履行退出条件最便宜的路**，
> 而走了那条路的工作，恰恰是**判决可以被它所拥有的那个 fixture 反转**的工作。"

**This is a mechanism, not a moral.**
