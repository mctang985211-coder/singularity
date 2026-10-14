# F 交回材料：固定领域任务集上的对照证据

> 历史受控领域 fixture 实测，不证明当前产品方法进化或正式领域效果；当前验收规范见 [spec-policy](spec-policy.md)。 历史正文按基线保留。

> 对应 [`review.md`](review.md) §5 阶段 F 的退出条件："恢复/边界行为满足新契约，真实质量和成本满足冻结标准"。
> 复现命令：`node scripts/domain-probe.mjs`（自报的检查数由探针自己打印，本文件不复述它）。
> **F 没有新增协议，也没有改一行 `src/`**：交付物是 `tests/fixtures/f-domain.json`、
> `scripts/domain-probe.mjs` 与本文。缝的复核结论见最后一节。
> **尚未观测的项单列在最后，不混进已通过的条目。**
> **本文不写"N 条变异抓住了"**：每条变异声明住在 `mutation-baseline.json`，用
> `node scripts/mutate.mjs <id>` 按需重跑（§5）；门禁 `mutation-claims` 每次检查这些声明是否仍然可跑。
>
> 第四轮审查后本文件的修订（每一处都是删掉一句不成立的声明，或把它改成可被证伪的读法）：
> ① 标记行与读数行不再说 "one caliber"（solve 集是在**每任务一条**口径下测的）；
> ② §1.5 里"另有 51 条事实在截止范围之上"是算术上不可能的，已删除（截止就是整条日志，上面是 0 条），
> 探针里两条 `x === x` 的检查同时删除；③ §2 里"工具被重建会改变真实口径摘要——正是 R08 防的"是**假的**，
> 已删除，改为记录这个限制（工具摘要两侧都由运行时字节算出）；④ §4 标题原说本阶段不碰
> `scripts/gates.mjs`，而 F 那次提交**确实**加了接线那一行，已改正；⑤ "故意更差的修订被拒"改成"被本探针
> 读成未达标"（没有任何产品机制拒绝更差的修订）；⑥ 冻结标准只有一个所有者。
> ⑦ §5 的变异表搬进 `mutation-baseline.json` 的 20 条声明，逐行对照见 §5.1；
> **其中一条原记为"抓住了"的变异实测没有被抓住**，单列在 §5.2（`mutate:fw-direction-sign-ignored`），不修规则、也不假装它成立。
> ⑧（本轮）⑦ 记的那条残留**已关闭**，且没有把声明改弱去迎合结果：探针多了一条检查，让读数句的动词与
> 排序符号对着 **view 自己携带的 direction** 检查，于是那个构造被抓住（`node scripts/mutate.mjs fw-direction-sign-ignored`
> 打印 `caught`，即 `mutate:fw-direction-sign-ignored` 已被抓住）；§5.2 保留原构造与修复前后的两次读数。§2 的仪器检查同样补了一个**能区分**"数命名"与
> "读文件"的样本，第六轮用锚定正则（`/-t[0-9]+$/`）击败的那条构造现在失败了。

## 0. 一句话结论

在**内容摘要冻结**的 3 个领域任务上，**逐任务一条口径**（`caliberDigestOf` 逐位相等，且等于 fixture 自己
冻的那一条），fixture 的**已发布方法**相对 **H0 基线**在 solve 集上质量 +0.75、每 trial 成本 +0.098
（上限 0.15），**达标**；同一标准的 holdout 集读数另记、**未达标**（真缺一个 trial）；一个**故意更差**
的修订被如实读成**低于标准**。这些数字不是被测函数算出来的期望值：期望值来自 fixture 的任务布局与
方法文件的手算，实测值由真实进程打印。

"更好"是 fixture 的 `metric.direction` 说的，不是本探针假定的：`verdictOf` 的增益是
`sgn(direction) · (候选质量 − 基线质量)`，`lower` 就是"数更小者胜"。第四轮审查把 fixture 的
direction 翻成 `lower`、用仓库自己的 `digestOf` 重算摘要、改掉探针里那一处字面量，探针就为"它自己
声明更差的方法"报出 `met true`；现在同样的构造读成 `gain −0.75`、`met false`、退出码 1
（可重跑：`node scripts/mutate.mjs fw-direction-flipped`）。**这条修复的残留本轮已关闭**：探针原来
没有任何检查比较"读数句的动词"与"它自己算出的排序"，所以把符号强制成常量可以让全部检查自洽；现在
读数句的动词、排序符号与**view 自己携带的 direction** 必须互相一致（§5.2 记了构造与修法）。

## 1. 六条断言的观测值

| # | 断言 | 结果 | 观测与证据 |
|---|---|---|---|
| 1 | 两侧 evaluation 都开盘，且 `caliberDigestOf` **相等**——同一个问题问了两遍 | ✅ | 每个任务两侧各开盘一次，6 条口径摘要逐位相等；且**等于从 fixture 现场重算的那一条**（`frozenCaliberInputs`：fixture 的 model/conditions/任务 inputs + 工具字节摘要 + fixture 的 metric/weights/trials/judgement）。三个任务的口径摘要各不相同（一个任务的 inputs 是问题的一部分），文件顶部打印 `caliber 17c89bfe…`。**"没开盘"与"开盘了"分开**：`caliberDigestOf` 对未开盘状态返回 `undefined`，与另一条 `undefined` 不相等——"两处都缺"不是"两边一样"。 |
| 2 | 每个任务每侧有 `trials` 次**真实执行**，缺失**显式表示**而非丢掉 | ✅ | 7 条 plan × `trials: 2` = 14 个计划槽位；测量程序自己的 marker 记录 **14 次真实尝试**（`selector` 与 `meter` 各 14 次），其中 1 次 `exit 3` 不产数字，被记为 `trial/missed`（slot 1，理由含 `exited 3`），**观测数因此是 13**。每个槽位都能说出自己的结局：`observed + missing.length === denominator`。缺槽位的那一侧 `admissible: false` 且理由点名 slot 1——不是一个被悄悄当成 0 的分数。 |
| 3 | holdout 与 solve **分别记录**，**不得混池** | ✅ | fixture 里 `sets.solve = [f-task-one, f-task-two]`、`sets.holdout = [f-task-three]`；每条 verdict 带自己的 set，聚合**按集合各算一次**，从不相加。反例读数：若混池，gain 会是 0.75、quality 会是 1.00，而两个真实读数分别是 solve `+0.75 / 1.00` 与 holdout `+0.25 / 0.50`——混池会**刚好**读成 solve 的数字，于是"留出集另有其数"这件事会消失。 |
| 4 | 冻结的 `standards` 判定"是否达标"，**低于标准就是没达标** | ✅ | 三条读数各有自己的标准对象（标准随结论走，不靠一个全局量）：solve `+0.75 > 0.1` 且每 trial 成本 +0.098 ≤ 0.15 → **met**；holdout `+0.25`、真缺一个 trial → **not met**；故意更差的修订 `-0.25` → **not met**。三个方向都被证明是活的，而不是"接线了"：把质量门槛抬到观测增益本身（0.75）→ 判为未达标（`>` 不是 `>=`）；把成本上限压到 0 → 同一批测量判为未达标；去掉缺槽位的惩罚项 → 未完成的读数会多出 0.5 而**看起来**达标。**标准只有一个所有者**：判决读的与结论身份记的是同一个绑定（`fixture.standards`），探针里那条 `fixture.frozen.standards ?? fixture.standards` 已删除——正是它让"结论身份命名的标准"和"真正判决的标准"可以是两个。 |
| 5 | 同一批 entries 重放得到**同一结论** | ✅ | 结论身份 = `digestOf({ fixture 摘要, H0 修订内容摘要, 发布修订内容摘要, standards })`；两个修订摘要是**两个不同的内容**。重放：整条日志的 entries 重新 fold、重新聚合，得到的结论摘要与首次逐位相同。**这里原来写着"另有 51 条事实在截止范围之上"——那是算术上不可能的**（总共 51 条，截止就是 51，上面是 0 条），对应的两条检查（`entries.length === cutoff`，同一个纯读者读两次、中间没有写者）已删除：它们不可能失败，而标签断言的与事实相反。结论身份**覆盖判定本身**：把任一 verdict 的 `met` 翻过来，摘要就变；且结论摘要与"手写重建的同一结论体"逐位相等——所以它覆盖的是结论，不是 `digestOfConclusion` 自己和自己相等。 |
| 6 | **方向参与判决**：`metric.direction` 说的是"哪个方向更好"，而增益按它读 | ✅ | 探针里 `direction` 现在只有一个读者（`verdictOf` 的 `directionSign`），判决前先检查它确实是 `higher`/`lower` 而非被默认。三个独立读法：① `verdict.gain < 0` 与两侧 view 的原始质量按 `directionSign` 重排的结果一致；② 把 fixture 翻成 `lower` 并重算摘要后，solve `gain` 由 `+0.75` 变 `−0.75`、`met` 由 `true` 变 `false`、退出码 1，而**同一构造在修复前报 51/51、退出码 0、打印 "beats H0"**（可重跑：`node scripts/mutate.mjs fw-direction-flipped`）；③ 用未翻转的 fixture 把符号反过来 → 失败（`node scripts/mutate.mjs fw-direction-sign-inverted`）。**"读了方向再把符号丢掉"由一个专门的检查挡住**：读数句的动词、排序符号、以及每个 view 自己携带的 `direction` 必须互相一致（检查名以 "every view carries the direction this readout is written in" 开头），所以一个常量符号会与它排序的那些 view 冲突（`node scripts/mutate.mjs fw-direction-sign-ignored`）。这句在上一轮是**假的**：原表写"改成常量 `1` → 5 项失败"，实测是全绿（§5.2）。**缺槽位的扣分也按方向带符号**（`worstCaseGain = gain − sgn(direction)·missingShare`）：否则在 `lower` 下，从一个负增益里减掉 0.5 会把候选**推向**门槛而不是推离它。 |

## 2. fixture 的形状与身份

`tests/fixtures/f-domain.json`（103 行，纯 JSON）：

```json
{ "domain", "tasks": [ { "taskId", "goal", "inputs": [2 个文件], "criteria": [契约判据] } ],
  "frozen": { "revisions": { "baseline" | "published" | "below-bar": { "revisionId", "methods": {任务: {file, tag}} } },
              "model", "tools": [{name, version}], "conditions",
              "metric": { measured: {criterionId, statement, verifierRef, verifierVersion}, unit, direction },
              "judgement": [一条硬约束], "weights": {quality, cost}, "trials": 2 },
  "standards": { "minQualityGain": 0.1, "maxCostIncrease": 0.15 },
  "sets": { "solve": [2 个任务], "holdout": [1 个任务] },
  "contentDigest": "2284f3b8…" }
```

- **内容摘要即对照身份**：`contentDigest = digestOf(去掉该成员后的整个 body)`，
  `2284f3b8d3a470246c8099c7c45e923a63ec0cc854a34897bbc19fdafdb5336b`。探针用被测代码的
  `digestOf` 重算并与 fixture 声明、与探针里手写的字面量**三方比对**；该字面量另外用一段独立的
  Python 实现复核过。改动 fixture 的任何一位都会让这三个检查变红，直到有人重新手写那个字面量。
- **fixture 里冻的是工具的"名字 + 版本"，不是工具的字节——这是一个限制，不是一项被守住的检查。**
  这里原来写着："摘要取自磁盘上真实程序的字节，因此一个工具被重建（名字不变、字节变了）会改变真实
  口径摘要——那正是 R08 要防的事"。**后半句是假的**，第四轮审查用构造证明了：探针的 `frozenTools`
  由**运行时**的 `sha256(meterProgram)` 构建，`frozenCaliberInputs` 由 `frozenTools` 构建，所以改仪器
  会让**两边一起动**，口径比较永远不会因此失败；审查把 meter 换成**从不打开参照文件**的实现（只数
  探针自己的 `-t<N>` 命名再除以硬编码 4），fixture 一字未动，**51/51 通过**。
  现在的处置是两条，都不是"补一句声明"：
  1. **删掉那句声明**。工具摘要两侧都由运行时字节算出，这是 fixture 的形状决定的；把仪器字节冻进
     fixture 会引入一个新的所有者，F 没有做这件事，也不声称做了。
  2. **加一条能被证伪的检查**：同一个参照文件下，指向七个内容不同的文件（参照文件本身、它的三个词、
     两个词、一个词、没有、三个词加一个**不在任何参照里**的同名式词、以及**另一个任务**的一个目标词），
     仪器必须给出 `1 / 0.75 / 0.5 / 0.25 / 0 / 0.75 / 0`。
     **这条检查的覆盖面本轮被修过一次，修的是检查而不是声明。** 第六轮用**锚定**正则（`/-t[0-9]+$/`）
     击败了原来的六个样本：`…-t1absent` 不以数字结尾，锚定计数不数它，于是构造读
     `1 / 0.75 / 0.5 / 0.25 / 0 / 0.75`——**与手算逐位相同，52 项全绿**（本文件上一轮却写着这条检查
     能挡住"从不读参照文件、只数命名"这一类，那句话当时是假的）。现在第七个样本是**别的任务的目标词**：
     它以 `-t<数字>` 结尾，锚定计数照样数它（读成 `0.25`），而读文件的仪器在这个任务的参照里找不到它
     （读成 `0`）。于是"数命名"的两种写法（不锚定数到 `1`、锚定数到 `0.25`）都在这条检查上失败，而
     两者都不需要仪器做"读文件"以外的任何事；实测见 §5.2 的方法（两种构造各在 `/tmp` 副本上跑过）。
  这条检查证明的是"仪器在按文件内容产数"，**不是**"仪器字节被冻结"：一个把分词结果**按参照文件过滤**
   的实现（或把除数从参照长度推出来的实现）仍会与真仪器在这七个读数上一致，这一点写进"尚未观测"，
   不当作已解决。
- **方法文件是探针按 fixture 的 tag 生成的**（`mid` = 只选 1 个目标词；`strong` = 选全部目标词；
  `weak` = 什么都不选），它们的字节摘要进修订清单，由 `environment@2` 的 reducer 自己算。
- **solve / holdout 分开**是 fixture 里唯一的"流程性"成员，也是 R08 那条规矩的载体：进入过对照的数据
  不再是留出证据。探针的 ledger 逐条列出每个 plan 属于哪个集合，因此"哪个任务被谁测过"是读得出来的。

## 3. 三个任务、两把尺子的实测量

| 任务 | 集合 | H0 质量 | 发布方法质量 | 增益 | 每 trial 成本 |
|---|---|---|---|---|---|
| f-task-one | solve | 0.25 | 1.00 | +0.75 | 0.013 → 0.111 |
| f-task-two | solve | 0.25 | 1.00 | +0.75 | 0.013 → 0.111 |
| f-task-three | holdout | 0.25 | 0.50（1 次观测 / 2 个槽位） | +0.25，**不完整** | — |
| f-task-two（`below-bar` 修订） | solve | 0.25 | 0.00 | −0.25 | 0.013 → 0.000 |

口径（`f-task-one`）：`17c89bfe513208c79aa7bc2578b280eedd1ab903155e9ef9e8e4bd1b9c660ecc`。
51 条事实、53 项检查、7 条 plan（6 条两侧 + 1 条故意更差）。

**为什么 holdout 不达标是设计而不是意外**：holdout 那一侧的计划里有一个槽位真的失败（meter `exit 3`），
观测只有一次。`quality = 观测和 / 计划分母`，所以一次完美观测在分母 2 下读成 0.5——诚实的方向；而
`met` 要求候选侧不缺槽位，于是它读成**未达标**。这条读数同时是断言 2 与断言 4 的证据。

## 4. 门禁接线（协调者做；接线那一行是 F 那次提交加的）

**更正**：本节标题原来写"本阶段不碰 `scripts/gates.mjs`"，而 F 的那次提交（`8b07482`）**确实改了这个
文件**——它在 `SCRIPT_GATES` 里加了一行接线，就是下面这一行，且只加了这一行（`git show --stat 8b07482`
里 `scripts/gates.mjs | 1 +`）。"F 没改 `src/`"仍然成立，"F 没碰门禁"不成立。

`SCRIPT_GATES` 里的**marker 行**用：

```js
{ name: 'domain-comparison', label: 'the domain comparison probe', script: 'scripts/domain-probe.mjs', markers: ['domain-probe: OK'] }
```

- 通过时最后一行原文：`domain-probe: OK — the published method beats H0 on the frozen solve set under the fixture's per-task calibers, and the frozen standards say so`
  （这句随方向变：fixture 声明 `lower` 时动词换成 `is beaten by`，所以 marker 前缀 `domain-probe: OK` 是
  稳定的那一半，接线读的正是它。）
- **合成失败会长这样**（`scriptFindings` 读 marker + 退出码）。任一检查为假时探针打印
  `  FAIL  <检查名> — <读数>`，每条断言都带它自己的观测值，最后是这一段（引用的输出一律顶格起围栏：
  缩进的标记在渲染器里是代码块而不是围栏，门禁第八轮之后按 finding 报它）：

```

domain-probe: 1 check(s) failed: the two sides of every task freeze one caliber, digit for digit

```

  并且退出码为 1；marker 行不再出现，于是门禁同时命中"没有 marker"和"退出码非 0"两件事。探针的
  自检腿（`gates.mjs --probe`）用 `'ok\nsome checks failed\n'` 这种合成输出即可让它失败——它读的正是
  这两样东西。协调者若还要一条更严格的腿，可以把 marker 换成更长的整句；建议不要，因为探针的读数
  行会随版本变化。

## 5. 变异证明：声明在 `mutation-baseline.json`，按需在副本上重跑

**这里不再写"哪条变异被抓住了"这种句子。** 第三、四轮都记过同一件事：它点名不了任何脚本，所以在仓库内
无法复核。现在每条声明都有可跑的产物，形状是 `{ id, rule, edits, run, witness }`——编辑（每处先断言
"在树里恰好出现一次"）、判定命令、以及失败时必须打印的见证串：

```
node scripts/mutate.mjs --list    # 每条声明的规则
node scripts/mutate.mjs <id>      # 跑一条
node scripts/mutate.mjs --all     # 全跑（分钟级；刻意不进每次提交，那不是门禁该付的代价）
```

`scripts/mutate.mjs` **只写副本**：把树拷到系统临时目录、在副本上改、在副本上判定、删掉副本——
本仓没有任何路径被打开写入，所以"逐字节还原"是性质而不是承诺（早先那条车道是改工作树再写回原字节，
那种形状会在别的东西同时移动时丢工作）。判定口径是 `docs/debugging.md` §4 再加一条：
**非零退出且打印该声明点名的见证串**才算抓住；套件加载失败/收集失败记为 `broken`（不算抓住），
命令通过记为 `MISSED`。

门禁 `mutation-claims` 每次提交检查两件事，**不跑变异**：每条声明的锚文本在树里**恰好出现一次**
（否则这条声明已经不再改任何东西——这正是旧声明烂掉的方式），以及本文与 `context.md` 里**用英文
结果词写出变异结果**的那一行必须点到一条已登记的 id；反向也查，登记的 id 必须有文档点名。
（本文因此不再用那个词：声明与结果分开了，表里只写"哪条声明"，判决由 `node scripts/mutate.mjs` 打印——
它打印的判决词与本文的中文措辞不是同一个字符串，这正是那条门禁的检查面，也是它的限度。）
**它抓不到**：换个说法的结果声明（"全绿"、"19/19"）、**提交信息里的声明**（门禁读不到 git 历史）、
以及"这次变异改的是被计算的值还是断言的形状"——那是作者的事（同一份 `debugging.md` §4），
所以每条声明都写着自己攻击的规则，harness 每次把规则打在判决旁边。

### 5.1 原表逐行迁到哪条声明

| 规则 | 变异 | 声明 |
|---|---|---|
| fixture 内容摘要即对照身份 | 挪动一个冻结成员（`minQualityGain` 0.1→0.2），声明的摘要不动 | `mutate:fw-fixture-standard-moved` |
| 同上 | 让 `computedDigest` 与 body 差一位 | `mutate:fw-fixture-digest-moved` |
| 同上 | 把探针里手写的字面量改成全 0 | `mutate:fw-pinned-literal-zeroed` |
| 两侧口径是 fixture 冻的那条 | 只把 fixture 的 `metric.direction` 改成 `lower`（摘要不重算） | `mutate:fw-direction-unpinned` |
| 同上 | 用别的 model 名去算 fixture 口径 | `mutate:fw-caliber-model-swapped` |
| 同上 | fixture 的判据 id 改成 `bounded-other` | `mutate:fw-criterion-unknown`（探针在 `checkConstraint` 处以 `unknown-criterion` 具名中止——是拒绝，不是静默通过） |
| `trials` 次真实执行 | 把"测量程序自己记的尝试数"改成 off-by-one | `mutate:fw-trials-attempts-off-by-one` |
| 缺失显式表示 | 取消埋下的 miss（`modesOf` 不再返回 `fail`） | `mutate:fw-miss-not-planted` |
| 槽位核算 | `observed + missing === denominator` 改成 `denominator >= 0` | `mutate:fw-slot-accounting-constant` |
| 同上 | 缺槽位不再点名 slot | `mutate:fw-miss-slot-unnamed` |
| holdout 与 solve 分开 | 把 holdout 集合换成 solve 集合 | `mutate:fw-holdout-becomes-solve` |
| 同上 | 混池对照不再是另一个数 | `mutate:fw-pooling-indistinguishable` |
| 标准判定达标 | `>` 改成 `>=`（门槛抬到恰好等于观测增益） | `mutate:fw-bar-equality` |
| 同上 | 成本上限不再生效 | `mutate:fw-cost-ceiling-dead` |
| 同上 | 缺槽位不再扣分 | `mutate:fw-missing-floor-dropped` |
| 结论身份覆盖判定 | 摘要里去掉 `met`，只留 `taskId`/`gain` | `mutate:fw-conclusion-drops-answer` |
| 同上 | 结论不再点名两个修订 | `mutate:fw-conclusion-drops-revisions` |
| 方向参与判决 | fixture 翻成 `lower` + 用仓库 `digestOf` 重算摘要 + 改探针字面量 | `mutate:fw-direction-flipped` |
| 同上 | 用未翻转的 fixture，把符号反过来 | `mutate:fw-direction-sign-inverted` |
| 同上 | fixture 翻成 `lower` + 重算摘要，再把 `directionSign` 强制成常量 `1`（"读了方向但不用"） | `mutate:fw-direction-sign-ignored`（第六轮记在案、本轮修好；构造与前后两次读数见 §5.2） |
| 仪器在按文件内容产数 | meter 换成**从不打开参照文件**、只数 `-t<N>`（不锚定）再除以 4 的实现（审查的 BL-2 构造） | `mutate:fw-meter-never-reads-reference`（锚定写法 `/-t[0-9]+$/` 是同一条声明的另一种拼法，本轮的第七个样本让它也失败，见 §2 与 §5.2） |

每条的实测判决不在本文里复述——`node scripts/mutate.mjs --all` 打印的就是它，连同它抓到的检查名。
原表每行的"（N 项失败）"也一并去掉：那个数字随探针的检查数漂，而它从来不是这条声明的内容。

### 5.2 本轮关闭的残留：复现、修法、以及修复前后的两次读数

上一轮这里记的是一条**复现出来了但没被抓住**的变异：原表把"把 `directionSign` 改成常量为 `1`
（读了方向但不用）"记为**抓住了（5 项失败）**，**实测不是**。它当时是 `mutate:fw-direction-sign-ignored`，
账本里带 `expect: "missed"`。本轮把它**变成一条正常声明**（去掉 `expect`，加上见证串），并先修好
探针再跑它——顺序是刻意的：`expect: "missed"` 的语义是"这条修改没被任何东西抓住"，如果只是把它删掉，
账本会把它当普通声明，而它照样会打印 `MISSED`。**修的是检查，不是声明。**

**构造（账本里的四条编辑，逐字可跑）**：① fixture 的 `metric.direction` 由 `higher` 改成 `lower`；
②③ fixture 里声明的 `contentDigest` 与探针里手写的那个字面量都换成按仓库自己的 `digestOf` 重算的值
（不改这一处，探针会因为摘要不符先失败，构造就测不到要看的东西）；④ 把
`const directionSign = direction === 'lower' ? -1 : 1` 换成 `const directionSign = 1`。

**修复前**（本轮在 `/tmp` 副本上实测；当时的探针就是上一提交 `da79600` 里的那一份，把
`scripts/domain-probe.mjs` 换回该提交即可重跑同一个构造）：

```
  solve   baseline 0.2500 -> published 1.0000, gain 0.7500 (floor 0.7500) → met true
domain-probe: OK — the published method is beaten by H0 on the frozen solve set under the fixture's per-task calibers, and the frozen standards say so
```

退出码 0、52 项全绿。**为什么没抓住**：探针自己的检查**全部**写成同一个 `directionSign` 的函数，把符号
强制成常量让它们**自洽**；标记行的动词是唯一直接读 `direction` 的地方，读数自相矛盾而**没有任何检查
反对它**。这是第四轮 BL-1 修复的残留：修复让方向**进入**判决，却没有让"读了方向、然后把符号丢掉"
变成可观测的。原始 BL-1 构造（忽略方向的消费者）确实被 `fw-direction-flipped` 抓住，"符号反过来"被
`fw-direction-sign-inverted` 抓住，所以**那两件本来就是好的**；这一件是新的、更窄的残余。

**修法**：让符号**对着 view 自己携带的 direction** 检查，而不是只对着探针自己的常量。探针里已经有
两样东西可以互相对照——`view.direction`（由 `projectEvaluation` 从折好的日志里读回，也是口径摘要的
一个成员）与增益的符号——于是新增一条检查（检查名以 `every view carries the direction this readout is
written in` 开头），要求三件事同时成立：① 探针读的每一条 view 都携带同一个 direction，且就是 fixture
声明的那一个；② `directionSign` 正是这个 direction 蕴含的符号（`lower → −1`，其余 → `+1`）；③ 读数句
用的动词**就是它自己算出的排序蕴含的那个词**（正增益 → "beats"，负增益 → "is beaten by"，相等 → 两个
都不是，于是检查失败）。这样常量符号必然与它排序的那些 view 冲突，而动词也不可能活过它自己的数字。

**修复后**（同一构造，实测）：

```
  FAIL  every view carries the direction this readout is written in, and the sign is that direction's rather than a constant — views carry ["lower"], fixture says "lower", directionSign 1, solve gain 0.75, verb "is beaten by"
domain-probe: 1 check(s) failed: every view carries the direction this readout is written in, and the sign is that direction's rather than a constant
```

退出码 1，`domain-probe: OK` 不再出现（门禁的 marker 腿因此也命中）。harness 的判决由
`node scripts/mutate.mjs fw-direction-sign-ignored` 打印 `caught`（`mutate:fw-direction-sign-ignored` 不再是记录在案的失效），见证串即上面那条检查名。
**一个仍未观测的边界**：这条检查证明的是"排序与读数句是同一个声明"，不是"fixture 声明的方向是对的"——
方向是否如实描述这个度量，仍然只有 fixture 的作者能回答（"尚未观测"里那一条仍然成立）。

**同一形状的另一种拼法：仪器那条检查。** 第六轮用**锚定**正则 `/-t[0-9]+$/` 击败了 §2 的仪器检查
（`…-t1absent` 不以数字结尾，锚定计数不数它），构造读 `1 / 0.75 / 0.5 / 0.25 / 0 / 0.75`——与手算逐位
相同、52 项全绿，而 meter **从未打开参照文件**。本轮加了一个**能区分**的样本（另一个任务的一个目标词，
以 `-t<数字>` 结尾但不在本任务的任何参照里），同一构造现在读 `… / 0.25` 对手算 `… / 0`，那条检查失败、
退出码 1。修的是**检查**（声明没有改弱）：本文件 §2 现在只说它抓住了"数命名"的两种拼法，仍然
**不说**它能抓住"按参照文件过滤分词结果"或"协同改动"。

**其余修正**：
- 原表"同上 | 结论把每个答案都翻过来仍算同一条"与"结论身份覆盖判定 | 摘要里去掉 `met`"是**同一次变异的两面**，
  合并为 `mutate:fw-conclusion-drops-answer`。
- 原表"槽位核算 | 改 off-by-one 也被抓住"没有独立的变异（就是同一条算术的另一种写法），**删除**。
- 原表"冻结标准只有一个所有者 | …**修复后不可表达**"**不是一次变异**，是一段论证：把两个绑定拆开在修复后
  **不可表达**，所以没有可注入的东西。它现在仍是探针里的一句结构检查（判决与结论身份必须是同一个对象），
  它的边界（抓代码演化，抓不到协同改动）留在"尚未观测"里，不再混在变异表里冒充一次实验。
- 原表末段说"这三条对照改的都是**被计算的值**"（方向、符号、仪器）。**在方向那条上当时不成立**；
  方向那条本轮修好（见上），符号与仪器两条一直成立，这段话现在对三条都成立。


**过程中被变异/自检抓出的三个真缺陷**（都不是"补个测试"，是改代码）：

1. **埋下的 miss 从来没发生**：`modesOf` 用的是 `side === 'published' && taskId === holdoutSet[0]`，
   但这一版里那一侧的名字已经统一成 `below-bar`，条件恒假，于是"缺一个 trial"的读数其实来自别处。
   是**探针自己的程序日志计数器**（`meter:run:` 行数 vs 计划槽位数）先报的警；修好之后 14 次尝试对
   13 次观测。这也解释了为什么"缺失显式表示"这条断言原先能过：它检查的是**声明**，不是**发生过**。
2. **成本上限是死条款**：`maxCostIncrease: 0.0` 时 published 每 trial 贵 0.098，于是 solve 侧永远
   `met: false`，而成本项永远不可能成为判定的分水岭。修法不是删掉成本算术，而是把标准取成**诚实的
   上限**（0.15，允许的质量换成本），再补一条"上限压到 0 时同一批测量不达标"的对照——成本项现在
   在某个地方真的决定结论。
3. **槽位核算恒真**：`observed + missing.length === denominator` 只被喂过配平的行，于是它的答案是个
   常量。补上两条故意短一格的对照行（`[true, true, false, false]`）之后它才是活的。

> 一条给下一轮的教训：**变异改的必须是"被计算的值"，不是"断言里的形状"**。第一轮里我把
> `x === y` 改成 `x === x`、把空列表清空、给不可能失败的分支加条件——那些是**无效实验**，
> 它们报 `MISSED` 不代表规则是死的（`docs/debugging.md` §4 的 `no test summary` 同一类）。
> 第二轮全部改成"移动一个真实读数"之后，19 条里 19 条都有意义，上面三个缺陷也是这么浮出来的。

## 尚未观测（保留未完成状态）

| 项 | 为什么未完成 | 具体缺口 |
|---|---|---|
| **数字不是真模型产出的** | 测量**路径**是真的：真进程、真产物、执行之后才取产物摘要、按字节摘要解析实现、selftest 两个方向都跑。但方法文件是**探针自撰**的，fixture 里的 `model` 是一个声明的名字，本进程里**没有任何模型调用**。 | 观测到的是"在一条冻结口径下，fixture 的发布方法产出的数字胜过它的基线方法"，**不是**"真实模型变好了"。真实模型效果由私有 DSH 的自主 RTL 运行判断。这也正是 R09 那句"避免把函数已接线当成正则化有效"的诚实边界——本阶段证明的是"即使接线正确，读数也由冻结标准判定"，不是"正则化有效"。 |
| **行为回归就是既有四个探针** | F 的退出条件前半句是"恢复/边界行为满足新契约"。F **不新增回归机制**：回归就是 `scripts/control-probe.mjs`、`scripts/recovery-probe.mjs`、`scripts/slice-b.mjs`、`scripts/cd-probe.mjs`（其中三条已是门禁）。 | 这四个探针在**本次未改一行 `src/`** 的前提下全绿（本次实测：`control-probe` failures 0 / gaps 0；`slice-b`、`recovery-probe`、`cd-probe` 各自 OK）。因为 F 没动 `src/`，它们绿并不构成"新契约下"的新证据——它只证明 F 没有破坏已有行为。 |
| **"部署替代"本身** | `docs/tdd-seams.md` §6.4 明确不做：删旧栈、迁旧数据、通用沙箱、group/router、任何新编排。 | F 给的是"能不能替代"的**读数**，不是一次不可逆的切换。旧栈仍在，证据只覆盖"新契约下同口径对照成立"。 |
| **solve 集只有 2 个任务、`trials: 2`** | 冻结任务集是 fixture，规模由人选定。 | 这里的对照是**方法级**的（同一任务、同一输入、同一装置，只换修订），因此任务数只影响"能读到多少噪声"，不影响"两边问的是不是同一个问题"。真实部署的 OOD 迁移效果仍需要真实模型 + 更大的任务集。 |
| **"故意更差的修订被拒"不是产品行为** | 没有任何产品机制拒绝更差的修订：`measure@3` 照样接受 `below-bar` 那一侧、照开盘、照记两次 trial、硬约束也照过；`src/` 里没有"选出更好的修订"这件事，F 也没加。 | 被观测到的是**本探针的判决**读成"未达标"（`gain < 0`、`met false`），和聚合一样是**实验的**读数，不是产品不变式。`README`/提交信息里凡出现"被拒（refused）"的措辞，都应读成"这条对照把它读成未达标"。 |
| **仪器（meter/selector/bounds）的字节没有被 fixture 冻结** | `frozenTools` 由**运行时** `sha256(meterProgram)` 构建，两端口径摘要一起动，所以"工具被重建"永远不会让口径比较失败——这不是 R08 挡住的事，本文件 §2 已把原来那句假声明删掉。 | 现有检查只能证明"仪器在按文件内容产数"（七个不同内容的文件 → `1 / 0.75 / 0.5 / 0.25 / 0 / 0.75 / 0`），能挡住"从不读参照文件、只数 `-t<N>`"这一类**的两种拼法**（不锚定与锚定，后者是第六轮用来击败上一版检查的构造，本轮的第七个样本让它也失败）；**挡不住**"把分词结果按参照文件过滤"或"把除数从参照长度推出来"的实现，也挡不住协同改动。要真正冻住仪器需要新的所有者（把仪器字节或摘要写进 fixture），F 没做，也没声称做了。 |
| **结论身份的"标准所有者唯一"没有摘要钉子** | 标准成员住在**探针**里（`fixture.standards` 一个绑定），不在被钉住的 fixture 里，所以没有"改了就红"的钉子。 | 这条检查能抓**代码演化**（将来把绑定拆成两处会红），抓不到"绑定、结论、fixture 一起改到自洽"。审查的 M-1 构造（让判决读 `frozen.standards`、结论读 `standards`）在修复后**不可表达**——不是因为被检查住了，而是因为只有一个所有者。 |
| **方向断言挡的是"读错符号"，不是"fixture 说错方向"** | `met` 是"在这条冻结口径与这套冻结标准下，候选是否更好"，不是"候选客观上更好"。一个**故意**把 direction 写成 `lower` 并重算摘要的 fixture，语义上自洽，探针只能如实读它。 | 观测到的是"探针不再忽略方向"：同样的数字在 `higher` 下 `met true`、在 `lower` 下 `met false`、退出码 1。它**不是**"方向被外部验证过"。真实方向的来源仍是 fixture 的作者。**另有一处未观测**：翻成 `lower` 之后那几项失败是"这套方法在这个方向下确实更差"，所以这次构造证明的是**拒绝**，不是"一个真正 `lower` 的 fixture 能跑通"——后者需要另一套方法文件（更小的数才是好的），F 没有造它。**上一轮记的那条更窄缺口（读了方向再把符号丢掉）本轮已关闭**：读数句的动词、排序符号与 view 自己携带的 direction 现在必须一致，构造见 §5.2（`mutate:fw-direction-sign-ignored`）。仍未观测的是**另一件事**：这条检查证明"排序与读数句是同一个声明"，不证明"fixture 声明的方向如实描述了这个度量"——后者只有 fixture 的作者能回答。 |
| **cost 的语义是本探针选的** | 度量单位与权重在 fixture 里冻结，`costPerTrial` 是本探针按"每 trial 均值"读的（避免 `trials` 一动就挪动上限）。 | 领域侧的"成本"（token、墙钟、钱）没有接进来；这里冻的是 `sum(选中词长)/1000`。换单位会换数字，不换结论结构。 |

## 6. 缝的复核：**零 src 改动，缝成立**

**结论：F 的缝成立，没有发现必须改 `src/` 的地方。** 逐条对照 `docs/tdd-seams.md` §6：

- **`frozen` 就是一次 `measure@3` 的 caliber**：成立。`caliberOf`/`caliberDigestOf` 直接吃
  `EvaluationState` 的 `context/metric/weights/trials/judgement`，fixture 冻的正是这五样（`context`
  由 bubble 声明重算）。**"同口径"因此不需要新概念**，两侧相等就是同一个问题。唯一需要说明的是
  **`context` 含 inputs**（`measure@3` 起），所以每个任务的口径摘要天然不同——这不是缝的缺陷，
  是"一个任务自己的输入是问题的一部分"，探针按任务分别重算口径即可。
- **跨任务聚合不需要新投影**：成立，而且这是刻意的。`projectEvaluation` 给的是**一条** evaluation 的
  读数；"发布方法赢了"是**实验的**读数，探针自己聚合（`aggregateOf` / `verdictOf`）。放进 `src/`
  反而会把它变成产品不变量，而那是一个跨任务的统计判断。
- **"真开一个 run + bubble、真跑测量程序"用现有表面就够**：成立。`task@5` 的
  `run/started` + `bubble/opened`、`measure@3` 的 4 个 kind、`scripts/measure-runner.mjs` 适配器，
  一行没改就用上了；`measure` 命令面还替探针挡掉了"执行者自己报数"和"实现不在本部署"两条。
- **"缺失按冻结槽位计划显式表示"是现成的**：`trial/missed` 是一个 kind，`projectEvaluation` 会把它
  变成具名 `missing`，`admissible: false` 且理由点名槽位。F 不需要为它加任何东西。
- **一处需要记下的限制（不是缝错，是口径的性质）**：`caliberDigestOf` 相等**只**说明两条 evaluation
  问的是同一个问题；它**不**说明两侧的**预算/轮次**相同。fixture 里没有预算成员，因为
  `measure@3` 的 caliber 里也没有——"同预算"目前只能靠"两侧都跑同一个 fixture 的 `trials`"来体现。
  如果将来要冻结 token 预算之类的量，那会是**新的口径成员**（`measure@4` 或 fixture 侧的新成员），
  而不是 F 现在能悄悄做到的。**F 没有把这个缺口当成已解决**。

**没有新增协议、没有新增 helper 模块、没有新增拒绝码。** 唯一的代码是探针 `scripts/domain-probe.mjs`
（它的行数不在本文复述：那是 `evidence-budget` 每次打印的分子的一部分），唯一的 spec 增量是 **0 行**：
没有新增任何 `tests/*.spec.ts`，当时那条按 spec 行数收费的门禁一分未动（它后来因分子里不只有 spec
而改名 `evidence-budget`，比值由门禁自己打印）。
