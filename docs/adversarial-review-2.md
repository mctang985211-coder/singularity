# adversarial-review-2.md —— 对着蓝图 §3 的六条根因做对抗性审查（第二轮）

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

**审的是 HEAD `0bde3e4`。审查者只读、不改仓库；所有测量在 `/tmp` 的 `git archive` 干净副本上做。**
跑过：`tsc` 干净、298 测试 / 26 文件、18/18 门禁、`--probe`、`cd-probe`（92 事实 / 99 检查）、
E1 投影的 3 次变异（全 caught）、5 个对抗构造 + 3 个门禁绕过副本（都带反向对照）。

**审查者的结论：F1、F2 会挡住发布；F3–F5 挡住对应的声明/检查点，不挡构建。**

> 本文件是**观测记录**，不是待办清单。做了哪些修、以及为什么，看提交历史与 `context.md`。

---

## 一、六条根因的裁决（**按代码判，不按文档判**）

| 根因 | 裁决 | 机制（"我们很小心"不算机制） |
|---|---|---|
| 1 形状繁殖没有门禁 | **kind 层：不存在**；**载荷字段层：存在（F4）**；声明写法可绕过（F5） | 一个信封、每族一个 registry、账本双向比对**活的** registry、保证词表闭合。但账本只比 `(protocol, version, kind)`，**看不见载荷形状变化** |
| 2 自建上游已有的东西 | **以缩减形式存在（F7）**；持久化那一半是真的没有 | `no-durable-writer` 是绝对的，`MemoryLog` 只在内存里 |
| 3 契约声明了没有消费者 | **存在**：F1（语义，最严重）、F9、F2 的"消费"标签 | —— |
| 4 该由数据结构保证的事交给提示词 | **作为提示词：不存在**（`src` 里没有提示词文本、没有 LLM）；**新形式存在（F3）** | 不变量都在 reducer 与提交区（责任门、判决的角色+身份、一槽一观测、指针 CAS，全部有人读）。但**两个不变量吃调用方给的表，其中一个会静默失效** |
| 5 RRSI 只引进一半 | **基本关闭** | 显式轮次、m 候选、argmax、冻结增量都被 cd-probe 两轮真实执行覆盖；novelty 读真实发布（E1，审查者重跑 3/9 变异全 caught）。**记录在案的开放项**：E2 消费登记、E3 轮次结案 |
| 6 两次大重构没换掉根因 | **机制是真的**：18 条门禁（10 静态检测器 + 自检、8 条行为探针在自动路径上、2 条棘轮） | F4/F5/F6 是它的实测漏洞；**而文件/测试/门禁清单仍然是散文，而且又错了** |

---

## 二、Blocking

**F1 —— `metric.direction` 被声明、校验、进摘要，然后没有任何读者：声明"越低越好"的一轮会选出更差的那个。**
`src/strategy/plan.ts:51,104-106,127`（声明/校验/存储）· `src/strategy/view.ts:345`（`projectRound` 只把
`plan.weights` 传进 `select`）· `src/strategy/decision.ts:240-245,214-227`（`select`/`judge` 按原始 quality 排序，
`direction` 不是参数）。**实测**：经真实 reducer 开一轮，`metric:{unit:'error-rate',direction:'lower'}`，
两个候选 0.9 与 0.5，`projectRound` 给出 `winner 0`——即更差的那个。`direction` 在 `src` 里没有读者，
也没有任何 spec 用过 `'higher'` 以外的值。**根因 3 的新位置，也是 C 阶段核心声明上的错误接受。**

**F2 —— receipt 可以声称一个它不是从那里推导出来的 cutoff，而它的"消费"是 bubble 的声明。**
`src/task/view.ts:176-199`（`cutoff` 是自由参数，只拒非整数与 <1，`:179-180`），而文档在 `:76-80` 声称
"accounts for exactly these facts … checkable instead of assumed"、在 `:86-93` 声称报的是
"what the attempt actually consumed"（`:196-199` 复制 `run.bubble.inputs`）。
**认证它的两行**：`scripts/slice-b.mjs:381`（`receipt.cutoff === cutoff`，右边就是探针自己传的参数）
与 `:382`；并作为 K1 通过项写在 `docs/k1-evidence.md:20`（"真实消费"）。
**实测**（6 条事实、verdict 是第 4 条）：`projectReceipt(stateAtHead, RUN_ID, 1)` 返回
`{cutoff:1, status:'verified', verdict:'pass', artifactDigest:<seq 4 的 verdict>}`；`cutoff:9999` 在 6 条事实的
日志上被接受。`tests/task-slice.spec.ts:111` 声称"非已提交边界的 cutoff 会被拒"，实际只试了 `0`。
**这是本项目第四个"不可能失败的断言"**——两操作数是同一个数，外加把声明当消费。

---

## 三、High

- **F3 —— "执行者不能度量自己的 run"这道检查在调用方身份表不全时自动关闭。**
  `src/measure/commands.ts:77` 存了**第二份**角色→身份表；`:293-298` 做
  `const actor = options.subjects[role]; if (actor === run.actor) refuse(...)`。角色不在那张表里时
  `actor` 是 `undefined`，比较为假，**不拒**；而 store 自己那张表（另一个对象）照样盖上 `actor` 并发出 fact。
  docstring `:70-76` 用**store 的表**来论证这张表，两者从不比对。**源码确认，未执行。**
  这正是 `context.md` §12x 记为"已修"的那个缺陷。
- **F4 —— 形状账本看不见载荷形状变化，"加字段⇒升版本"没有机制。**
  `protocol-baseline.json` + `gates.mjs:325-330,485-513` 只比 `(protocol, version, kind)`。
  在副本里给 `task@4/run/started` 加一个可选 `operatorNote`、**不升版本**：`tsc` 干净、**18/18 全绿**。
- **F5 —— `gates.mjs` 的第三处弱点（三个都带反向对照）**：
  - `protocol-inventory`：`declaredProtocols()`（`:436-451`）只 import 名字字面为 `protocol.ts` 的文件并调用
    导出的 `declare*Protocol`；唯一的兜底是正则 `/\.declare\s*[<(]/`（`:474`）。副本里用 `FOLD['declare']('sneak',1,…)`
    在 `src/strategy/published-assets.ts` 里加了一个**活的**协议+kind 并被生产代码折叠 → **18/18 全绿**。
    对照：写成 `FOLD.declare(...)` 同一行 → 门禁正确报错。
  - `no-unreferenced-export`（`:238-264`）是**文本**匹配：给 `decision.ts` 加 `export const revisions = 0`
    /`winner = 0`（无 importer）仍算被引用，因为这两个词作为成员名在别处出现 → 门禁 ok。
    对照：`export const zzUnreferencedProbe` → 门禁报错。**旧仓那 197 处导出的病，只在名字唯一时才抓得住。**
  - `no-durable-writer`（`:213-235`）只匹配静态 `import … from 'node:fs*'`；`await import('node:fs/promises')`
    写文件它看不见。
  - 结构性：8 条行为门禁的自检（`:780-788`）只喂合成字符串给 `scriptFindings`，**从不真的跑到脚本**。
    （但脚本是承重的：审查者准备 F4 时塞进一个多余的 `undefined` 载荷成员，8 条里有 5 条转红。）
- **F6 —— 文档账本又漂了，比被抓到的那次漂得更远。**
  HEAD 真相：65 个 `.ts`（src+tests）、298 测试 / 26 个 spec 文件、18 门禁、src 8,059 行、specs 6,694 行、
  比值 **0.831**（棘轮 0.85）。而 `context.md:298` 写 290/25、`:167` 写 44/181/10、`:317` 写 6,407/0.809
  （**往上**朝天花板走）、`:397` 那段记录上一次说谎的文字里又带着第三套过期数字；
  `blueprint.md:378-390` 仍列着已删除的 `src/protocol/log.ts` 与"gates.mjs 492 / 10 门禁"；
  `k1-evidence.md:4` 写 177 测试 / 11 门禁。**账本里没有行记录文件数/测试数/门禁数，所以这类声明仍无人检查。**

---

## 四、Medium

- **F7 —— 根因 2 的缩减形式。** `src/protocol/envelope.ts:46-52` 把 `seq`/`prevDigest`/`at`/`digest` 放进每个载荷；
  `src/protocol/memory-log.ts:119-141` 在 adopt 时再查一遍连续性与链；而**承载方本来就提供它们**
  （`src/control/session-store.ts:246-252` 写 `SessionSeq(#nextSeq)` 与 `Date.now()`）。
  `review.md:112`（U02）要求删掉这份重复的连续 seq 与摘要链。
- **F8 —— 承诺的 C/D 证据文档不存在。** `context.md:388` 与 `:460` 要求 `docs/c-evidence.md`；`docs/` 里没有，
  而 §12 声称 C/D 已落地并被门禁强制。
- **F9 —— 存了没人读的字段。** `RoundDecisionRecord.decidedBy`（`src/strategy/protocol.ts:102`，写于 `:332`）、
  `RoundState.openedBy`（`:110`，写于 `plan.ts:152`）在 `src` 中无人读；`ReleaseState.approvalId`
  （`src/release/protocol.ts:88,220`）只被探针/spec 读；`RoundPlan.metric.unit`（`plan.ts:127`）完全无读者。
- **F10 —— 残余项的记录尺寸过期。** `divergence-ledger.md:29` 与 `:49-54` 说 `S*` 下限"没有落脚点、
  没有行可关掉"；而 `src/strategy/view.ts:210-214` 已经实现了**轮级**下限（incumbent 冻结 quality − 当轮
  噪声带），并被 `round-probe`/`cd-probe` 断言。它不是上游那个精确的 `S*`，所以那行不算假，
  但**残余比记录的更小，账本没更新**。同理 `k1-evidence.md:29-30` 仍把"场景 3 的 expected-head CAS"记为
  未观测，而 `release-probe:328-331` 与 `cd-probe:833-836` 现在已经观测到它——**已失效但没标记**。

---

## 五、Low

- `derived-not-persistable` 是**运行时拒绝，不是门禁**；`src` 里没有任何 kind 声明 `derived: true`
  （只有 `tests/gate.spec.ts:106` 能碰到它）。而 `tdd-seams.md:68,107` 把它称作"门禁"——**措辞要改**。
- `context.md:301` 写"97 项检查"，cd-probe 实际打印 99。
- `context.md:298` 在"8 个真实进程探针"旁边写"9 条行为门禁"：`SCRIPT_GATES` 是 8 条，
  第 9 条真实树门禁是静态的 `dsh-alignment`。

---

## 六、审查者明确标注**未验证**的部分

- **F3 的运行时行为**（只有源码确认，没有执行，也没有测试存在）。
- **E1 剩下 6 条变异**与**整个 `decision.ts` 变异表**：仓库里没有可运行的产物，所以"N 个变异全 caught"
  这句话在仓库内**无法复核**。这是下一轮该补的：变异脚本要进仓库，不能只在 `/tmp`。
- 旧仓的"12 个格式 / 197 处导出"（超出范围）。
- cd-probe 的 99 检查是在**另一个工作流未提交的 E3 改动**存在时测的。

---

## 七、审查者的自评（值得保留的态度）

> "A root cause that is genuinely absent is a finding too — say what mechanism makes it absent,
> because 'we were careful' is not a mechanism."
>
> "Do not pad. The value of this review is in the findings that survive scrutiny, not in their number."
