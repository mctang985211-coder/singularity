# adversarial-review-8.md —— 第八轮：审的是 `00f861f8d017f7d049f37aa3e317b410fbe46c05`（HEAD）。机制仍然是真的，围着它的三条规则各有一个新出口

**`00f861f8d017f7d049f37aa3e317b410fbe46c05` 的干净副本。只读；基线全部自己重测。**

- `node scripts/gates.mjs` → **21/21 绿**；`node scripts/gates.mjs --probe` → `gate self-test: OK`
- `vitest run` → **327 passed / 29 files**（与 `tree-baseline.json` 的 327 / 29 一致）
- 干净副本：`git archive HEAD | tar -x -C /tmp/r8`，另复制 `.git`（否则 `tree-inventory` 因为 `git rev-list` 失败而全红——见 A2 的附带结果）
- 我自己独立重算了预算算式（`src` 37 文件 / 8,767 行，收费 50 文件 / 16,460 行，未收费 33 文件 / 7,147 行，`floor(1.88×8767)−16460 = 21`）——**与门禁打印的每个数字逐位相同**，且**全树没有任何文件同时不在"收费"与"未收费"两张表里**。

**裁决：三条 blocking，都在它宣称关掉的那条规则上，不在机制上。**

---

## BLOCKING

### B1 —— 围栏规则仍然被"标记不是围栏"击败：一对**缩进的**三反引号藏住任何计数
这一轮把"纯翻转"换成"记录开启符、只有同字符且不短于它才闭合、长于三个按名字拒绝"。
**它没有处理围栏标记的缩进**：`FENCE = /^\s*(\`{3,}|~{3,})(.*)$/` 允许前导空白，于是

- 四个空格起的 ` ```` ` 被当成开启符 → **按名字开火**（这一轮修的是这个）；
- 四个空格起的 ` ``` ` **既不被拒绝、又照常开关围栏** —— 而它在任何渲染器里都是**缩进代码块**，
  不是围栏。三反引号是这份仓库引用输出的**标准拼法**，所以这不是绕路，是正常修改。

**实测（`/tmp/r8a`，真实树副本 + 真实 `.git`，对照同时跑）**：往 `docs/handoff.md` 追加

```
    ```
    the tree has 99 gates and 5 spec files
    ```
```

→ **`gates: OK — 21 gates passed`**。
**对照**：同一行去掉那对标记（`    the tree has 99 gates and 5 spec files`）→
`FAIL tree-inventory`，`docs/handoff.md:68 states a count in prose …`。**一对缩进标记就是全部差别。**

这不是假设：`docs/f-evidence.md:132-134` **今天就已经**是一对缩进的三反引号，
门禁现在把它读成围栏（幸好里面只有一句 `domain-probe: …`，没有计数）。
所以那个"行首标记"的规则在这棵树里**已经**在按缩进代码块工作，只是还没人把计数放进去。

**第六轮的限界是"围栏**不闭合**会开火，所以一个 ``` 不能豁免后文"；这条限界没变，也不管用** ——
一对**平衡的**缩进标记什么都不报，豁免中间任意多行。**"平衡的三字符围栏仍然引用其内容"这句话现在比事实宽**：
平衡的三字符**缩进**标记引用的是一段代码块，而门禁把它当引用输出跳过。

### B2 —— `nested.workspace` / `metric` / `weights` / `run` / `outcomes` 的读者**被放宽**，而全套测试与 21 条门禁全绿
这一轮把"嵌套读者被放宽会被抓住"变成账本里的一条声明（`protocol-nested-reader-widened`），
我独立复核了它：`node scripts/mutate.mjs protocol-nested-reader-widened` → `caught`，
而且是**树里的 spec** 抓的（`tests/measure-slice.spec.ts`）。**这条声明是真的，但它只对它点名的那个读者为真。**

我把同一条规则用在**别**的已声明嵌套形状上（每条各一份副本，只改一处 `assertClosedKeys(x, members, …)`
为 `assertClosedKeys(x, [...members, 'note'], …)`，再跑**全套** vitest）：

| 嵌套形状（声明处） | 读者 | 全套 327 测试 |
|---|---|---|
| `task@5 bubble/opened.inputs` | `bubble.ts` `inputList` | **抓到**（measure-slice **和** task-binding 两处开火） |
| `task@5 task/decomposed.children` | `decomposition.ts` `child` | 抓到 |
| `task@5 bubble/opened.tools` | `bubble.ts` `toolList` | 抓到 |
| `task@5 task/admitted.contract`（含其下 criteria） | `contract.ts` | 抓到 |
| `measure@3 evaluation/opened.{baseline,candidate}`、`run/started.revision` 等 | `shape.ts` `revisionRef` | 抓到 |
| **`task@5 bubble/opened.workspace`** | `bubble.ts:183` | **没抓到** |
| **`measure@3 evaluation/opened.metric`** | `measure/protocol.ts:168` `metricOf` | **没抓到** |
| **`measure@3 evaluation/opened.weights`** | `measure/protocol.ts:179` `weightsOf` | **没抓到** |
| **`measure@3 evaluation/opened.run`** | `measure/protocol.ts:297` | **没抓到** |
| **`strategy@5 round/decided.outcomes`** | `strategy/protocol.ts:250` | **没抓到** |

五条都是 `Test Files 29 passed (29)`、`Tests 327 passed (327)`。
最干净的一条我还在**带 `.git` 的副本上跑了整条门禁**：`mut-workspace-widened` →
`gates: OK — 21 gates passed`，而**没有任何测试**注意到 `nested.workspace` 的读者现在接受未声明成员。

**为什么这仍然是"声明集 vs 强制集"的老病**：门禁每次运行打印
`the closed shapes a kind declares there (… task@5 bubble/opened (inputs, tools, workspace) …)
are enforced by the readers that name them, one level down`。**对 workspace、metric、weights、run、outcomes，
这句话在这个提交上已经不是真的**：读者只是"被交给"了那个集合，没有任何东西要求它**只用**那个集合。
第六轮 BLOCKING #2 的"声明说了、读者没被声明强制"在顶层已被 `defineKind` 关掉；
**在嵌套这一层它原样开着，只是这一轮终于有一条声明去问它，而那条声明只问了八个集合里的一个**。

**限界说对了一半**："只有 spec 探到的那个嵌套读者被行使"——**实际是八个声明集合里有两个形（inputs / revision / criterion 那一族）
有覆盖，四个形完全没有**；`inputs` 那条还有第二条 spec（`task-binding.spec.ts`
的 `closes each verdict input with the set the declaration names, not a wider one`），
所以"被 spec 探到"的覆盖面比账本那条声明读起来更宽，剩下的四个形比它读起来更空。

### B3 —— 耐用性规则仍然只按**名字的拼法**认写者，而"读者只读"这条规则本身可以先被放宽
这一轮新增：`export` 子句、`node:child_process`、`process.getBuiltinModule`。
我把检测器**逐字从 `scripts/gates.mjs:398-453` 切出来**（不重写它），喂合成的文件集，实测：

- **抓住**：`export { writeFile } from 'node:fs/promises'`、`export { writeFile as readFile } from …`（别名也在子句里，所以被报）、
  `export * from 'node:child_process'`、`import { execFileSync } from 'node:child_process'`、
  `process.getBuiltinModule('node:fs/promises')`、`createRequire`、`await import('node:fs/promises')`。
  **第七轮那两条构造是真的关了。**
- **抓不到，而且写真的发生**：`import { writeFile as readFile } from 'node:fs/promises'` 的同模块用法、
  以及**两条规则分开都合法、合起来是写**的构造。规则是"从 fs 模块导入的名字必须只读"、
  "`node:child_process` 整块拒绝"——**没有任何规则说"从一个只读名字里能调用出写"**。

那个别名出口我**不**算 blocking（子句扫描抓到它，名字是别名也照抓）。
**这一轮的规则边界是真的**，`gates.mjs:43-51` 的新措辞（"green means no write this scan can name,
never that no write happened"）我逐句核过，**是真的**，比上一版诚实。

**仍然 blocking 的是它的适用范围**：检测器只跑 `src/`（`if (!file.startsWith('src/')) continue`）。
于是"这棵树不持久化写"这句话里，**`tests/` 与 `scripts/` 从来不在扫描范围**，而这棵树自己的规则是
"绝对规则，不是带一条豁免的白名单"。**实测**：把**第七轮那条已经被抓住的构造原样**放进
`tests/seed.spec.ts`（`import { writeFile } from 'node:fs/promises'` + 模块级 `await writeFile(…)`）
→ 21 条门禁**没有一条**会报它，因为唯一能报它的那条检测器在 `src/` 之外不工作，
而 `tests/` 的唯一门禁是 `spec-density`（expect/it 比值）。**规则说的是"任何模块"，实现是"src 下的模块"。** 这是第六轮 #3 同一形状的第三次出现，只是这次门开在目录上，不是拼写上。

---

## HIGH

### H1 —— 那一行"不能与 git 核对"的声明现在是**假的**，而它就在活文档里
`docs/context.md:660-665`（§13 的边界 (2)(3)）仍然写着：

> 提交号**不与 git 核对**（门禁只读这棵树、不读历史），所以给活数字挂一个像提交号的东西是**写下来的限制**…
> （3）`RECORD_DOCS` 整体声明为"过去某次提交的记录"（**六份**审查/审核文档）…

**两句都不再成立**：这一轮让 `RECORD_DOCS` 逐条走 `git rev-list --all` 可达性校验（我复核：`namesHeldCommit`
对六份旧记录都判真、`docs/adversarial-review-7.md` 也在名单里，所以是**七份**）。§13 的勘误只改了
"三份 vs 六份"那个**实例**（`docs/context.md:716-719`），没改这两句**规则描述**。
**门禁读不到这一句**（它不是计数声明），所以一条被这一轮推翻的规则说明留在活文档里没人管——
正是这份仓库一直在抓的形状："记录说的是旧的规则"。

### H2 —— "行级 token 不核对"这条边界比印出来的更宽：**整份记录文件的豁免只要求*任意* token 可达**
我按它自己的规则把两份记录逐 token 查了（`git rev-parse <t>^{commit}`，91 个提交）：

- **七份记录全都点了本树的至少一个提交** —— **第七轮那条 finding 的实例确实是错的，实现方的更正成立**
  （`review.md` 唯一在本树的 token 是 `798c6d9`，第七轮用 `cat-file -e` 没看见可达性）。
- 但**同一条规则的另一半是**：`countClaimFindings` 对声明为记录的文件只要**文本里任何位置**有一个
  可达 token 就 `continue`（`gates.mjs:843`）。**它不要求那份文档是那次提交的记录，也不要求文档里的数字与那次提交有关。**
  一份自称"`docs/adversarial-review-9.md`，审的是 `3e9ae5d`"、里面写 `999 gates, 5 files, 12 tests`
  的新文档，**整文件豁免**，因为文本里有一个真提交号。**这是这条豁免在"最紧的一版"上剩下的宽度**：
  文件级只要一个真 token，行级只要一个 token 形状。前者比后者宽，而前者**只写在代码里**，没印在运行说明上
  （打印的那句说的是"each verified against git to name a commit this repository holds"）。

### H3 —— 账本里 14/38 条声明的"见证"是 `"×"`：**它不锁定任何一条用例**
这一轮选的固定声明 `protocol-copied-rule-refused` 用的正是 `"×"`（`mutation-baseline.json`）。
38 条声明里 20 个不同的见证串，其中 **14 条的见证就是 `"×"`**（`tests/gate.spec.ts`、`task-binding`、
`task-tree`、`published-assets`、`control-barrier`、`measure-slice` 那几条）。
`mutate.mjs` 的判定是"非零退出**且**输出里出现见证串"；`"×"` 是 vitest **任何**失败用例前面都印的字符。
于是这 14 条声明的实际内容是"**这个文件里至少有一条用例失败**"，不是"这条规则被问到并且拒绝了"。
**我无法在不改仓库的前提下实测这一点**（需要把断言搬走或加一条无关失败用例），所以这条**标为推断**：
从 `mutate.mjs:74-80` 的判定代码直接读出，不是观测到的。
**它对 A5 那个问题给出的答案是**：固定一条声明买到的，恰好是账本里最弱的那种判定；
而**没有任何门禁检查见证串是否具名**（`mutationClaimFindings` 只查锚点恰好一次、文档与 id 双向），
所以把见证换成更弱的串是一次**没有任何门禁会说话**的编辑。

---

## MEDIUM

### M1 —— `unchargedFiles()` 的推导是对的，但它把 `tests/` 下**没被收费的**文件从披露清单里漏掉了
我独立重走了一遍：全树 120 个文件，`src/` 37 + 收费 50 + 未收费 33 = 120，**没有文件落在两张表之外**；
33 文件 / 7,147 行与打印逐位相同。**披露是完整的**（`docs/**`、`README.md`、四本账本、`package.json`、
`tsconfig.json`、`vitest.config.ts`、`pnpm-lock.yaml`、`tests/vectors/**`、`.gitignore` 全在）。
**但实现是** `unchargedFiles()` 只列 `!file.startsWith('src/') && !charged.has(file)`，而 `charged` 里
`tests/` 的成员只有 `.ts` 与 `tests/fixtures/**`。所以**现在** `tests/` 下若有 `zz-big.json` 或
`tests/vectors/*.json` 之外的任何非 `.ts` 文件，它**不收费、也不在披露清单里**——
`tests/vectors/strategy-decision-vectors.json`（503 行）之所以在清单上，纯因为它的路径不匹配
`tests/fixtures/**` 而匹配了"既不在 src 也不在 charged"。**今天清单是对的，规则不是**：
`grep -q 'tests/'` 这一类过滤只要有人加一个 `tests/data/zz-big.json`（503 行也一样）就会静默掉出两张表。

### M2 —— `tree-inventory` 在**没有 `.git` 的树**上对七份记录全红，而错误信息把原因说成了别的事
在一个"干净副本 = 归档解包"的环境里（我第一遍就是这样跑的：`git archive | tar -x`），
`repositoryCommits()` 读不到 `git`，返回 `undefined`，于是**所有声明为记录的文件都被判"没有点名本树的提交"**，
再加上逐行扫描，`tree-inventory` 报 **24 条 finding**。这本身是 fail-closed、可以接受；
**不能接受的是那句附带说明**：`(git could not list this repository's commits, so no record can be verified)`
——它在 "git 说没有" 和 "这里没有 git" 之间不分。一次 CI 或评审里常见的解包检出，
会把七份记录全部报成"不是记录"。**这条是我自己的第一次基线运行里观测到的**（命令与输出见上）。

### M3 —— `--probe` 的预算腿只查"收得多"，不查"披露得全"
`ok evidence-budget charges every file under scripts/, whatever its name or suffix (.probes/zz-big.mjs, notes.txt, …)`
是这一轮新增的腿，是真的。但 **`unchargedFiles()` 这条新的推导没有腿**：
自检里没有任何一处对"未收费清单"喂一个合成形状看它是否漏掉（例如 `tests/data/x.json`）。
这一轮的提交信息把"披露是推导出来的、所以不会漂"当作性质，而它只是**代码里的一个 `filter`**。

---

## 对 A/B/C 三问的直接回答

**A（各处 close 对各自的构造）**
- 围栏：第七轮那条**四反引号**构造真的关了（我复现：` ```` ` 平衡 → 2 条 finding，含"按名字拒绝"）。
  **缩进这条开着**（B1）。
- 记录：可达性校验真的在（我复核了七份记录，实例更正也成立），**但整文件豁免只要任意一个真 token**（H2），
  而"不与 git 核对"的**文档描述过期**（H1）。
- 耐用性：三条新门真的在（第七轮两条构造实测被拒），**目录范围这条开着**（B3）。
- 预算：收费与未收费两张表**今天是完整的**，推导算式我逐位复核（`21` = `floor(1.88×8767)−16460`），
  **披露规则有一个 `tests/` 的缝**（M1），自检没有它的腿（M3）。
- 提交时变异：**一条固定声明买到的判定是账本里最弱的那一类**（H3）；
  38 条声明的分布是 `domain-probe` 21 条、五个 spec 文件 14 条、三条探针/两条 spec 各 1-2 条，
  **没有一条打在 11 个静态检测器自己身上**；三条机制声明都由 spec 抓（我复核了全部三条）。

**B（上一轮新增的三条机制声明）**：**三条我都独立跑了，三条都是 `caught`，而且都由树里的 spec 抓**，
不是门禁那条合成腿。**但我为另一个嵌套形写了变异：五条不被抓**（B2）。**限界比声明里写的更宽**。

**C（不可能失败的断言家族）**：**四个旧成员全部消失，本提交新增 class-1：0**。
四个替代我独立验了**两个能被变异打红**（`environment-binding.spec.ts` 的
`returns it at the time its creating fact was stamped with` 在把 `at: envelope.at` 改成常量后失败；
`strategy-decision.spec.ts` 那条在把 reason 改成常量后失败，并带红另外 5 个用例）。
**另外两个的等价变异会被别的断言一起接住，所以我无法证明它们单独失败**——但两者都读真实状态、
都不是同义反复（`round-probe` 比对索引、`cd-probe` 比对摘录与投影），**我按"可达但未证明"记**。
- **家族现在：4 已知 → 0 已知，无新成员。**（这是七轮里第一次净减少。）
- **"不给门禁"那个论证：成立，但它的算术错了一处。** 我用同一个词法形状
  （`.length > 0` / `toBeDefined()` / `every(Boolean)` / `toBeTruthy()`）扫全树：**30 处**会开火
  （不是"~21"），其中 7 处在 `gates.mjs` 自己里。而它会**漏掉四分之二**：
  四个旧站点里 `environment-binding.spec.ts:72` 与 `strategy-decision.spec.ts:183` 带 `.length > 0`（会打中），
  `round-probe.mjs:263` 与 `cd-probe.mjs:763` 是 `.every(...)` 里的合取项（同一条规则也会打中——所以"会漏掉一个"低估了）。
  **结论**：不是"第五轮拖延"，因为**替代品已经有了**（变异账本），真正的缺口是 H3 那种**弱见证**，
  不是"没有门禁"。**该修的是见证串，不是再加一条词法门禁。**

---

## D. 一个系统会做错的场景（跨阶段：记录 → 认证 → 发布）

**用两行文件把一次从未发生的测量写成"某个提交的记录"，并通过全部门禁与自检。**

1. 从最近的提交里取 `3e9ae5d`，但它恰好**没有**被任何东西核过内容；
2. 新建 `docs/adversarial-review-9.md`，第一行写
   `**审的是 \`3e9ae5d\` 的干净副本**`，正文写 `the tree measures 999 gates, 5 files, 12 tests`；
3. 编辑 `RECORD_DOCS` 加一行文件名（这是唯一的改动，也是唯一会被别的门禁注意到的地方——
   `gates.mjs` 被收费，加一行的代价是余量，不是红）。

**运行结果**：`tree-inventory` 的声明检查通过（文本里有可达提交），**整份文档不再被扫描**，
于是那三个与 `tree-baseline.json` 相差两个数量级的数字**在 21/21 全绿的状态下进入这棵树的记录集**，
而运行说明会把它数进 "minus N record(s) of past commits, each verified against git"。
**没有任何东西把"记录"与"那次提交的内容"对上**：可达性验的是**提交存在**，不是**记录为真**。
一份**从未发生过的评审**因此获得了与七份真实评审完全相同的地位。

**这一条我做成端到端可跑的形态给下一轮**：同一条路更便宜的一步（往 `docs/handoff.md` 追加一行
`the tree has 99 gates … measured at deadbeefcafe1234`）我已经实测：**`gates: OK — 21 gates passed`**，
对照（去掉那个 token）红。**记录文件那一版需要改 `RECORD_DOCS`，本轮只读，未执行，标为构造。**

## E. 排序

1. **B1**（一对缩进标记藏任何计数；改动 2 行、零 src）—— **挡**
2. **B2**（四个已声明嵌套形状没有读者强制，也没有变异问它；门禁打印的"enforced by the readers"是假的）—— **挡**
3. **B3**（"任何模块不得写"这条绝对规则只扫 `src/`；同一构造放进 `tests/` 全绿）—— **挡那句规则的范围**
4. **H3**（14 条声明的见证是 `"×"`；固定那条正是其中之一）—— High
5. **H1/H2**（文档描述过期；整文件豁免只要求任意真 token）—— High
6. **M1/M2/M3**，然后 C 的记账

## 我改了两处，都在 `docs/` 与一处声明，理由在这里

1. **本文件**（`docs/adversarial-review-8.md`）。
2. **`scripts/gates.mjs` 的 `RECORD_DOCS` 加了一行 `docs/adversarial-review-8.md`**：
   本轮第一次基线运行时 `tree-inventory` 的 9 条 finding 里 6 条落在这份文档自己的数字上，
   原因正是"要么点名一个已核对的提交，要么按本树的数字扫"。这份文档**确实**是它第一行点名的
   那次提交的记录（下面的每个读数都是在那次提交的副本上量的），所以它是**第八份记录**，
   与前面七份同一条路。**这不是把 H2 那条豁免拿来当便利**：我报的宽度是"整文件只需任意一个可达 token"，
   而这里用的是它本来的意思——评审文档记录它审的那次提交。（改动说明：这是本轮对仓库的唯一一次编辑，
   没有 `git write`，没有别的文件被碰。）

**我明确说的两件事**：**"一个来源"这个机制在这个提交上仍然是真的**（第七轮 22/22 的强制我未重跑，
但这一轮**没有动 `src/` 一行**——两个提交的 numstat 是 `mutation-baseline.json` + `scripts/gates.mjs`，
`src/` 与 `tests/` 零改动，所以任何对机制的改动都不在这个提交里）；
**变异账本里三条机制声明的确有 spec 抓，我独立复核过。**
**上面的发现全部是关于围着机制的三条规则（围栏、豁免、耐用性）与它们各自的边界，不是关于机制本身。**
