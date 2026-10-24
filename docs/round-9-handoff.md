# round-9-handoff.md —— 第八轮三条 blocking 的处理，逐条：怎么复现、改了什么、**还剩什么没抓住**

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

> 历史交接记录，不参与当前施工；接手入口见 [handoff](handoff.md)。 历史正文按基线保留。

**这份文件是交回材料，不是审查报告。** 第九轮审查请对着**它的提交**独立重跑；这里每个"已关"都
带一个可复核的构造，每个"没关"都带一个数字。

三条 blocking 全部动手了，但**只有两条是"关掉"**。第二条我做不到，原因写在它自己那一节里，
**并且我没有把它写成已关**：第八轮那句过度宣称我是删掉了（那句话现在是假的会更好查），
但**五处读者仍然没有实验**，这条**开着**，而且它现在缺的不是一句措辞，是一个预算决定。

---

## B1 —— 缩进的三反引号：**已关**

**复现（第八轮原文构造）**：真实树副本 + 真实 `.git`，往 `docs/handoff.md` 追加下面三行。
**这里是描述而不是引用**，因为把那段原文贴进这份文档，它自己就会被检查器报出来 ——
B1 修好之后，这份文档是第一个撞上那条新规则的文档：

| 第几行 | 四个空格之后 |
|---|---|
| 第 1 行 | 三个反引号（一个**缩进的**开启标记） |
| 第 2 行 | 一句计数声明：一个数、一个计数词、再一个数、再一个计数词（这里不复述它，复述它就等于把那条被藏起来的声明抄进这份文档） |
| 第 3 行 | 三个反引号（一个**缩进的**闭合标记） |

**改动前**：检查器报 `gates: OK` —— 平衡的缩进标记被当成围栏，中间那句计数被跳过。
**改动后**：检查器报 `gates: 2 of 21 failed`，恰好三行 findings
（第八轮在 `2ef5b90616b2758fa6a0036528cbd7f01cd19198` 上的那次读数）：

- `docs/handoff.md:68 indents a fence delimiter …`
- 第 69 行：`states a count in prose`，引用的正是上表第 2 行那句
- `docs/handoff.md:70 indents a fence delimiter …`

**机制**：`FENCE` 从 `/^\s*(…)/` 收成 `/^(…)/`（**行首**才是围栏），另加一条
`INDENTED_FENCE = /^[ \t]+(`{3,}|~{3,})/` 把"缩进的标记"本身变成一个 finding ——
**它既不开启也不闭合**，所以四个空格不再决定这次扫描看见什么。

**树里本来就有一对**：`docs/f-evidence.md` 的 `domain-probe` 输出块原来缩进两个空格，
门禁此前把它当围栏读 —— 那一段里没有 `COUNT_CLAIM` 认得的拼法（`domain-probe: 1 check(s) failed`
里的 `1` 后面跟的不是计数词），所以它**碰巧**没有藏住任何东西。已改成**顶格起围栏**，
并在旁边写下为什么顶格。

**自检腿**：`gates.mjs --probe` 新增两条 —— 平衡的缩进对（**3 findings**：两个缩进标记 + 中间那行
计数被读成散文）、Tab 缩进的标记（**3 findings**：标记 + 计数 + 一个从此没人闭合的围栏）。

**明说不抓**：缩进**四格以上**在 Markdown 里同样是代码块，这里按同一规则报；但**行内的**反引号
（`` `x` ``）从来不参与围栏规则，一个行内代码段里的计数仍然扫不到 —— 这条限界没变。

---

## B2 —— 五处嵌套读者没有实验：**关了，代价是 5 行而不是 46 行**

**第八轮的实测我复核了，结论一致**：把 `assertClosedKeys(x, members, …)` 改成
`assertClosedKeys(x, [...members, 'note'], …)`，`workspace` / `metric` / `weights` / `run` / `outcomes`
五处**全套测试全绿**。原因是"读者会不会被放宽"只能由**喂它一个未声明成员的 spec**抓住，
而声明本身拦不住读者去 spread 一个新数组。

**门禁每次打印的那句先是改了，因为它是假的**：

> …are **enforced by** the readers that name them, one level down

改成

> …are **handed to** the readers that name them, one level down, and what closes each reader there is
> the spec that feeds it an undeclared member — a declaration is not what stops a reader from spreading one

**然后五处实验补上了，代价是 5 行。** 我先按"每条腿一个新 spec"估成 46 行（`measure-slice` +31、
`strategy-round` +5、`task-binding` +10），据此判断"树里只剩 1 行余量、付不起"并撤回。
**第九轮审查者指出那个估价是错的**：同样的实验写成**现有 `it()` 里的一行断言**只要 5 行
（三条在 `measure-slice` 的"refuses a plan …"里，一条在 `strategy-round` 的"refuses an unadmitted
winner …"里，一条在 `task-binding` 的"refuses a bubble …"里），全套仍绿。**他是对的，我照做了**：
每处读者一条一行断言，五条变异各自被抓住：

- `mutate:protocol-nested-workspace-reader-widened`
- `mutate:protocol-nested-metric-reader-widened`
- `mutate:protocol-nested-weights-reader-widened`
- `mutate:protocol-nested-run-reader-widened`
- `mutate:protocol-nested-outcome-reader-widened`

**撤回这个动作本身是我的错**：我把"我写的那版贵"当成了"这件事贵"，没有去找更便宜的写法就先放弃。

**这一条现在的准确状态**：五处读者各有一条 spec 喂它未声明成员，**门禁印的那句话现在是
逐字为真的**——十一个声明了嵌套形状的 kind 里，每一处被点名的读者都有这样一条 spec。
**另外仍然诚实的是**：声明本身依然拦不住读者 spread，关掉这件事的始终是 spec；
"违规的声明会被抓"这条**没有**被这一轮证明（实测：把 `nested.workspace` 声明放宽仍然全绿），
所以 `defineKind` 按路径强制那条方案 (a) 的否决理由依然是猜的，只是现在有数字了。

---

## B3 —— 耐用性规则只扫 `src/`：**规则没变宽，说法收窄到它能兑现的范围**

**第八轮的实测我复核了**：把第七轮**已经被抓住**的构造放进 `tests/seed.spec.ts`，全部门禁沉默。
但那不是"检测器漏了"，是**这条规则从来不是关于 `tests/` 的**：

- 测试与探针**必须**真的落到介质上才能行使沙箱 —— `tests/verifier-production.spec.ts` 写进一个
  它自己 `rm` 掉的 `mkdtemp` 目录，`tests/measure-execution.spec.ts` 同样；
- 所以"这棵树不持久化写"这句话**兑现不了**，而它此前是绝对口气印出来的。

**改动**：门禁名从 `no-durable-writer` 改成 **`src-names-no-durable-write`**，
六处打印文案从 "no module may write durably" 改成 "no module **under src/** may write durably"（计数由 `grep -c 'under src/'` 复核），
检测器上加一段说明作用域与理由。**检测器扫的范围一个字没动**（仍是 `src/`），
变的只有它承诺的东西 —— 这正是"绿的意思是这次扫描说不出一个写，从来不是没有写过"那句话的同一方向。

**明说不抓**：`tests/` 与 `scripts/` 里的持久写**不在规则里**，所以"某个测试往仓库里写了一个文件"
这件事**没有任何门禁会报**；规则管的是**产品**。

---

## 试过什么（**包括被撤回的**，因为撤回的理由本身是一份读数）

| 试的 | 结果 | 留没留 |
|---|---|---|
| 五条读者实验（按每条一个新 spec 写的 46 行版） | 全绿，且四条变异被抓住 | **撤回**，随后以 **5 行**的写法补回：贵的是我的写法，不是这件事 |
| 给五条实验各加一条变异声明（`mutation-baseline.json`） | 四条 `caught`，`run` 那条我也临时建过并确认 `caught` | **撤回**（没有实验的声明就是没有实验） |
| 把 `nested` 声明本身放宽（`nested.workspace` 加一个成员） | 读者的拒绝在**折叠之前**，所以照旧被抓住 | 不需要新声明 |
| `docs/f-evidence.md` 的缩进围栏改成顶格 | 门禁从"当围栏读"变成"当引用读"，内容没变 | **留下** |

**门禁自检**：`--probe` 全绿（含 B1 的两条新腿）。
**预算**：证据 `1.8798`（ratchet `1.88`，余量 **1 行**）。这一轮净增的证据全部在 `scripts/gates.mjs`
里（`docs/` 不计费），**没有从任何规格文件里删过一行**。

---

## 交给第九轮审查的问题

1. **B2 的 46 行**：是先抬 ratchet、还是换成框架强制、还是让这五处读者继续裸奔并把这笔账写死？
   我这一轮选的是第三条，理由是"不替预算做决定"，**这是个可以反驳的选择**。
2. **`INDENTED_FENCE` 会不会误报**：这棵树引用输出的标准拼法是顶格三反引号，但**列表里的引用块**
   天然会缩进 —— `docs/f-evidence.md` 那一处原来就是缩进两格的列表内容。**如果还有别处**，
   下一个缩进标记会不会把一份**本来正确**的文档报成 finding？第八轮的 B1 我按"标记必须是顶格"
   收紧了，代价是**列表里的围栏要拆开写**。
3. **门禁名的改动是否彻底**：`no-durable-writer` 这个名字还在 `docs/adversarial-review-2..7.md`
   里（那六份是**声明过的历史记录**，按规矩不追改）。**如果哪份活文档还在用旧名字描述现在的规则，
   那是一条新 finding** —— 我只改了 `docs/context.md`、`docs/phase-b-design.md` 两处。
