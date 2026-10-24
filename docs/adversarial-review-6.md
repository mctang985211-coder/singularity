# adversarial-review-6.md —— 第六轮：攻击"声明而非采样"这个判断本身

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

**审的是 `e8c1c70` 的干净副本。只读；基线全部自己重测过。**
**审查者的裁决：机制选择没错，但"一个来源"现在是三个。**

> "I do not think the mechanism choice is wrong — reading a declared value is right, and
> round three-to-five's class really is gone from the top-level set — but 'one source' is
> currently three: the rule object's `members` (enforced), the same array read later
> (enforced live), and the `nested` values (declared, printed, not enforced)."

---

## BLOCKING

### #1 —— 品牌可以**被复制**，于是"不是 defineKind 造的规则会被注册表拒绝"是假的，第五轮的 BLOCKING 1 **逐字复现**
`defineKind` 返回的是普通对象字面量，品牌 `[DECLARED]: true` 是**自有可枚举 symbol 属性**；
对象展开会复制自有可枚举 symbol。所以 `{ ...rule, parse: 另一个解析器 }` **保留品牌和 `members`，却换掉了边界**，
而 `assertDeclaredShape` 检查的是**标记，不是来源**。

**复现**：`return { ...sealed, parse: runStartedPayload }`（同一解析器 + 读 `operatorNote`，reducer 带进 state）
→ 注册表报 `rule.members = ["runId","revision"]`、账本比对 ok、**真实 `MemoryLog` 接受并折叠**该事实、
**21/21 门禁全绿、323/323 测试全绿**。
对照：第五轮那个构造（解析器内部条件式 `assertClosedKeys`）**确实是惰性的**（包装器在它跑之前就拒了）；
而**诚实地**把成员加宽会正确开火。**所以第五轮在自己的构造上关掉了，又被"标记可复制"重新打开。**

**自检的那条腿测的是"缺失"，不是"来源"** —— 它造一个**没有**标记的规则，而不是展开一个**有**标记的。
**修法**：用**身份**而不是可复制的标记（`WeakSet` 装 `defineKind` 造出的规则），并补一条"展开一个已品牌规则"的自检腿。

### #2 —— 嵌套成员集**声明了但没被声明强制**：21 个 `nested` 值里 **8 个没有读者**
`defineKind` 只把 `members` 应用到原始载荷；`nested` 只是**交给解析器**，而门禁只记录它的**键**
（`Object.keys(rule.nested)`），**从不记录值**；账本里也没有嵌套集。
实测 13 个经解析器第三参数读取，**这 8 个没有**：`measure@3 evaluation/opened.judgement`、
`measure@3 trial/recorded.inputDigests`、`strategy@5 candidate/submitted.revision`、
`task@5 bubble/opened.inputs`、`bubble/opened.tools`、`evidence/produced.inputDigests`、
`task/admitted.contract`、`task/decomposed.children`。

A/B（都 `tsc` 干净）：
- **只改声明**：`nested: { inputs: ['name'] }` 而 `inputList` 仍强制 `['name','digest']` → **21/21 全绿**；
  声明说得比解析器接受的**少**，没有东西报告。
- **只改读者**：`assertClosedKeys(source, [...BUBBLE_INPUT_MEMBERS, 'note'], at)` → `rule.nested.inputs` 仍读 `["name","digest"]`，
  **真实 log 接受**带 `note` 的 `bubble/opened`，**21/21 全绿**，而运行说明仍把 `task@5 bubble/opened (inputs, tools, workspace)` 列为已强制。

**这和提交消息说它对修订 pin 已经消除的"同一形状的第二份副本"是同一个病。**

---

## HIGH

### #3 —— 耐用性不变量仍然没有被强制：两条写路径，21/21 全绿
- **(a) 转发子句不是检测器能读到的 import**。它的正则要求 `import` 这个 token，所以
  `export { writeFile } from 'node:fs/promises'`（在 `shape.ts`）+ `import { writeFile } from './shape.ts'`（在 `run.ts`）
  是**看不见**的 → 21/21 全绿，**而模块级的写在门禁运行时真的被执行了**（文件确实出现）。**文件数中性。**
- **(b)** `execFileSync('sh', ['-c', 'echo … > /tmp/…'])` → 21/21 全绿，文件被写。

> 提交里那句新话（"sweep 会 import 每个模块，所以模块级的写会在门禁运行时真的发生"）
> **作为描述是真的，作为屏障是无用的：写发生了，没有任何门禁记录下来。**

### #4 —— 仪器检查又被另一种计数器击败，而**记录的界限比事实窄**
一个**从不打开 `referencePath`**、数 `/-t[0-9]+$/` 并除以硬编码 4 的 meter → **52/52 通过、exit 0**，
而它的标签还在说"这个数是在读被指向的文件里的词，不是在读探针自己的命名"。
**`docs/f-evidence.md:237` 声称这一类是被抓住的** —— 它没有被抓住。**一个"已记录的抓住类"没有被抓住。**

### #5 —— 声明站点的界限比说明里写的更宽
说明只点名 `X['declare'](…)`。**解构调用** `const { declare } = registry; declare('zzalias', 1, {…})`
在未到达的函数里 → 两个机制都看不见 → **21/21 全绿，而声明是活的。**

---

## MEDIUM

- **#6** `export declare namespace` **两个读者都不枚举**（加载器只看见值导出，`declaredExports` 没有 namespace 分支）。
- **#7** 入口点规则的**假阳性无法被记录**：`export const zzBarrelValue = digestOf({n:1})` 在 `src/index.ts` 里被报"没有别的模块绑定"，
  而 `PUBLISHED_WITHOUT_CONSUMER` **覆盖不了它**（记录收缩检查要求 `published.has(key)`，而记录里只有**转发目标**）。
  docstring 承认了这个假阳性，**但没承认门禁自己给的建议（"记进 PUBLISHED_WITHOUT_CONSUMER 或删掉导出"）对它是不可能的**。
- **#8** 账本每种 kind **只比对一次声明**（`if (!merged.kinds.has(kind.name))` 保留首次观测），
  而 `sites` 收集全部；已有两个模块各自建 registry 并声明 task@5 / strategy@5，于是**不一致的第二份声明是被忽略的那份**。
- **#9** 门禁在 `declare` 时**快照**声明数组，而强制读的是**活的**那个 → 在 `declare` 之后 push 进 `RUN_STARTED_MEMBERS`
  → 21/21 全绿，而放宽后的边界**接受了** `{runId, revision, operatorNote}`。

---

## 一条**我自己**无法复核的声称

审查者在提交消息里找不到"the replacement is net minus sixteen lines"的任何读法：该提交自身 numstat 是 **+598/−365（净 +233）**，
`scripts/gates.mjs` 是 **+247/−183（净 +64）**。

**它是对的。** 那个 −16 是工作流**隔离统计**出来的数字，**不在提交里**，所以从仓库**无法复核**。
我的提交消息因此包含了一条这个项目一直在拒绝的那类声称 —— **它已被改正**，写进本文件与 `context.md`。

---

## 已知未关项（复核结果）

- **D1 `fw-direction-sign-ignored`：仍然开着**（手工验过）。fixture 翻成 `lower`、两个摘要字面量重算、`directionSign = 1`
  → 探针 **exit 0**，同时打印 `solve … gain 0.7500 → met true` 与 "the published method is **beaten by** H0"。
  **对 F 的含义**：今天的判决不错（活的 fixture 是 `higher`，活的方向也对），
  但 **F 的退出条件在 fixture 的取向上不是承重的** —— 任何常量符号都满足全部 52 条检查，
  所以探针**分不出"在声明的方向上更好"与"在一个被假定的方向上更好"**。
  **应当把 F 的判决记为"以一个没有任何检查确立的方向为前提"，而不是据此抬高棘轮。**
- **D2 文档账本仍只覆盖两个文件，且比记录的更宽**：`blueprint.md` 仍写"15 文件"、仍列已删除的 `src/protocol/log.ts`、
  仍写"10 条门禁"（实际 2,040 行 / 21 门禁）。**上一轮没有记录的是**：`docs/k1-evidence.md` 也带着四处未检查的计数声称。
- **D3 evidence-budget 仍然只差一个 `mkdir`**：`scripts/zz-big.mjs` 5,000 行会红，`scripts/probes/zz-big.mjs` 同样 5,000 行不会。

## 「不可能失败的断言」家族

**存活（4，行号未变）**：`environment-binding.spec.ts:72`、`strategy-decision.spec.ts:183`、`round-probe.mjs:263`、`cd-probe.mjs:763`。
**已修（2，读码确认）**：domain-probe 的 `declared !== 'TBD'` 与那对 cutoff 同义反复。
**本提交新增 class-1：无**；新增的 `gate.spec.ts` 那条腿**可失败**（两种拒绝都实测开火）。
**仍存的弱谓词**：`domain-probe.mjs:371`（绝对标签对六个样本）、`:1088`（标签说"每一件事实"，谓词只比条数）、`:440`/`:325`（`every(Boolean)` 在空集上空洞通过）。
