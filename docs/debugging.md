# debugging.md —— 这一轮六处缺陷的根因与可复用的检查法

本文件记录的是**方法**，不是流水账。每一节的结构固定：**症状 → 为什么它不是"改这里"能修的 → 引发它的构想错误 → 最小代价的修法 → 以后怎么在写之前就看见它**。

入口一句话，先记住：

> **信任只在一个边界上建立一次；之后所有的读都是对已验证值的投影。**
>
> 这一轮六处缺陷里有四处，是同一个错误的四种长相：**为了拿一个"已经算好了的值"，又从头重放了一遍。**

---

## 0. 处理顺序（不要跳步）

用户给的顺序是对的，每一步都能否掉后面一步的结论：

1. **确认存在**。不是读代码觉得像，而是**量出来**：数不变量的执行次数，不看耗时（见 §1.1）。
2. **确认必要**。它真的会发生吗？触发条件是常规路径还是理论路径？把触发条件写成一句话；写不出来就是没确认。
3. **确认位置**。不只是能看到的那行门禁/断言，而是**最开始让它长成这样的那个构想**。看见 `slice.mjs` 多余，要问"当初为什么会有两个纵切"。
4. **最小代价优化，而不是补丁**。判据：改完之后，**原来那部分代码是被删掉的**。删不掉就说明还停在打补丁。
5. **不许 helper**。如果一个修法需要引入一个新函数把旧逻辑包起来，那说明真正的错误在那段旧逻辑的**归属**上——它放错了模块，或者它本来就不该存在。
6. **每条新规则都要有变异证明**（§4）。写不出让它失败的变异，等于没写。
7. **固化**。就是这份文件。

---

## 1. 第一类：用重放换一个已经算好的值

### 症状

- 每提交一条事实要跑 **51 次 reducer**（50 条事实 → **2550 次**）；正确值是 **1 次**。
- 一条**被拒绝**的命令也要跑 **101 次 reducer**——其中 100 次是在算一个**没人读**的 cut。
- 每次提交的耗时随日志长度线性增长：100 条 6.3ms/条、200 条 11.3ms/条。
- 三个队列层层包裹（命令层 → store → MemoryLog），而其中两个可以不存在。

### 为什么不是"改这里"

看 `session-store.ts` 会想"把 `structuredClone` 换成浅拷贝"。但 `structuredClone` 只是**表象**：真正在付账的是"每次提交都重新 `adopt` 整份日志"，而之所以这样做，是因为需要一个**丢弃得起的暂存状态**。

看 `commands.ts` 会想"把 `command()` 里那个没用的 cut 参数去掉"。但去掉之后 cut 还是在 `require` 里被重算一次：真正的错误是 **cut 的构造方式和读取时机**。

### 构想错误

两句话，都是同一个：

1. **"fold 是唯一事实来源" 被读成了 "所以每次读都要 fold"。**
   fold 确实是唯一事实来源；但**已经算过的 fold 不需要再算**。`MemoryLog.#states` 本来就是增量 fold 的结果，`stateOf` 是 O(1) 的。我却把它当成"内部缓存"，让每个读者从 `entries()` 重新 fold 一遍。
2. **"提交前必须私有地准备状态" 被实现成了 "复制整份日志"。**
   私有准备是对的意图；错的是手段。需要私有的只有**那一条新事实**，不是整份日志。

### 最小代价修法（原代码直接删掉）

| 位置 | 原来 | 现在 |
|---|---|---|
| `MemoryLog` | `emit` = 队列 + `#commit` | **`decide`（判全部规则、封信封、不记录）+ `record`（记录）**；`emit` 是两者的组合，给没有自己介质的调用方 |
| `MemoryLog` | 一个 `#queue`（`#commit` 里没有 `await`，队列是多余的） | **删除**。没有 await，JS 的 run-to-completion 就是临界区 |
| `ControlSessionStore.#commit` | `adopt(clone(entries))` → emit → 介质 → `adopt(clone(entries+1))` | `decide` → 介质 → `record`。**两次全量重放删除**，`#ownSeq` 字段删除 |
| `ControlSessionStore.load()` | `structuredClone` 每个信封与每个状态 | 冻结写入值，读时共享；`load()` 变成一个真正的 **cut**（`stateAt(p,v,s,cut)`） |
| `task/commands.ts` | 自己的队列 + 每命令预先构造一整个 `Cut` | **队列与预构造删除**。前置条件作为 `require` 交给 store 的串行区，在其中按需读取 |
| `task/tree.ts` 的宽读 | `foldSubjects(registry, log.entries(), ...)` | `load().statesOf(p, v)`，且 `Cut.tasks()` / `Cut.environments()` 是**惰性函数**：不需要树的命令不付这个钱 |

**可删性的检验**：这次修改的净效果是**删代码**——两个队列、两次全量重放、一个字段、一个预构造的 cut、一个重复的形状读取器、一个纯内存纵切脚本、一条门禁、一处遗留测试设施、17 处未使用声明。

### 以后怎么先看见它

**量不变量，不要看耗时。** 耗时会被 fsync、JIT、机器负载淹没；不变量次数是确定的整数。

```js
// 把 registry.ruleFor 包一层，数 reduce 被调几次
const orig = registry.ruleFor.bind(registry)
let n = 0
registry.ruleFor = (...a) => { const r = orig(...a); return { ...r, reduce: (...x) => { n += 1; return r.reduce(...x) } } }
```

然后问一个问题：

> **这个数字随日志长度增长吗？**

- 一次提交应该是 **1**。是 51 就是这一类缺陷。
- 一次读（cut）在**头部**应该是 **0**（已算好）。是 O(n) 就是这一类缺陷。
- 拒绝一条命令应该是 **1**（判完就抛）。是 101 就是这一类缺陷。

这把"性能优化"变成了**不变量数量的断言**，可以写进测试、可以在 review 里一眼看出，不需要基准测试环境。

### 副产品：一条设计判据

**一个队列只有在跨越一次真正的 await 时才需要存在。** 
`MemoryLog` 的队列是它还是异步提交时留下的；`commands.ts` 的队列是它还在自己读 cut 时留下的。两者都不再跨越 await，于是都是遗留物。删掉它们不是"省一点开销"，而是**把串行区的所有权收敛到唯一一个真的需要它的地方**——控制 store 的提交区。

---

## 2. 第二类：不可能触发的规则

### 症状

`record()` 里有两道守卫，读起来都有意义：

```ts
if (!decision.fresh)        refuse(...)   // "已经提交过的命令没有东西可记录"
const pending = DECIDED.get(decision)
if (pending === undefined || pending.log !== this) refuse(...)
```

### 为什么不是"给它补个测试"

变异证明（§4）把第一道守卫关掉，**19 个用例全过**。原因是结构性的：`decide` 只在 `fresh: true` 那条路径上写 `DECIDED`，所以**任何 `fresh === false` 的 decision 必然也没有 `DECIDED` 条目**——第二道守卫已经拒绝了它，而且拒绝的理由**更准确**（"这个日志没有一条待记录的该事实"）。

**一条永远不可能触发的规则不是规则。** 补一个测试让它"能失败"是打补丁；正确做法是**删掉它**。

### 最小代价修法

两道守卫合成一道，并把消息写成对三种情形都准确的一句话：

```ts
const pending = DECIDED.get(decision)
if (pending === undefined || pending.log !== this)
  refuse('illegal-transition', `${...} is not a fact this log decided and has yet to record; ...`)
```

`Decision.fresh` 保留，但它现在的职责只有一条：**告诉调用方要不要写介质**。不再兼任守卫。

### 以后怎么先看见它

写完一道守卫，问：

> **在它之前，有没有代码已经保证了它的条件？**

具体到此处的信号是：守卫用了一个**读起来像状态**的词（`fresh`），而真正的状态是另一个结构（`DECIDED` 里有没有）。**同一个条件有两个表示，就会有两次检查，其中一次是死的。**

---

## 3. 第三类：不可能成立的断言

### 症状

`recovery-probe.mjs` 里"修订固定存活"的检查：

```js
check('the revision pin survived the kill',
  task?.runs?.[RUN]?.revision?.digest === reported.facts.find(f => f.kind === 'run/started')?.digest
    ? true
    : task?.runs?.[RUN] !== undefined)
```

左边的 `revision.digest` 是**环境修订的内容摘要**（`digestOf(manifest)`）；右边的 `.digest` 是**信封自身的摘要**（`sha256(canonicalJson(body))`）。两者相等需要哈希碰撞。所以三元表达式的第一个分支**恒假**，这个 check 实际上只在断言"存在一个 run"。

**它从来没失败过，因为它不可能失败。**

### 变异证明（这一步是必须的）

把 run 记录的 pin 里的 `environmentId` 抹成 `''`：

```
旧断言：  ok    the revision pin survived the kill        ← 探针说没事
新断言：  FAIL  the revision pin survived the kill, field for field — read {"environmentId":""...};
                the dead process pinned {"environmentId":"library-1"...};
                the environment records "d3f5347..."
```

### 最小代价修法

不是"换成 `toEqual`"，而是**把两个独立读数都写进断言**，并让失败时把三方都打出来：

```js
const recorded = cut.stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)?.revisions?.[REVISION]
const revision = task?.runs?.[RUN]?.revision
check('the revision pin survived the kill, field for field',
  JSON.stringify(revision) === JSON.stringify(reported.pin) && revision?.digest === recorded?.contentDigest,
  `read ${...}; the dead process pinned ${...}; the environment records ${...}`)
```

同时让 holder 在握手行里报告它**固定的是什么**（`pin`/`inputs`），这样"存活"是**两个进程读数的比较**，而不是对单个读数的打量。

### 以后怎么先看见它

三种句式，见到就地停下：

1. `x === y ? true : z` —— **三元里有一个分支是常量，那个断言就是假的**。这里 `? true : z` 等于"x===y 时不算数"。
2. **两个操作数来自不同命名空间**：一边是"内容摘要"，一边是"信封摘要"；一边是"revision id"，一边是"task id"。同名不同物是这类断言的主要来源。**把变量的来源写进变量名**（`revision.contentDigest` vs `fact.digest`，而不是两个都叫 `digest`）。
3. **断言里出现"存在即通过"**：`!== undefined`、`length > 0`、`toBeTruthy()`。它们通常是在回避"到底该等于什么"。

---

## 4. 变异证明的配方（每条新规则都要做）

> **没失败过的门禁不算门禁；没失败过的断言不算断言。**

流程固定四步，**自动化**（`/tmp/mutate.py` 那种脚本，别手改）：

1. 找到规则里**承重的那一行**（不是整个函数）。
2. 用最小改动让它失效：`if (x)` → `if (false)`、`Object.freeze` → `void value`、删除一个分支。
3. 跑**最相关的那一个 spec**（不是全量，这样失败归属清楚）。
4. **恢复**。

判定：

| 输出 | 含义 |
|---|---|
| `caught`（有 failed） | 规则是活的 |
| `MISSED` | **规则是死的**——按 §2 删掉它，或者按 §3 修断言 |
| `no test summary` | 变异把文件改成了语法错误，这次测量无效，换一个变异点 |

这一轮 7 条新规则全部有了变异证明；也正是这套流程当场抓出了 §2 那道死守卫。**"MISSED" 不是一个要补测试的信号，是一个要删代码的信号。**

### 附带的一条操作纪律

写"批量改文件"的脚本时，**每一次替换都要 `assert` 旧文本存在**。

这一轮我犯过一次：改 `recovery-probe.mjs` 的脚本里有一处旧文本没匹配上，`str.replace` **静默返回原文**，脚本照样写回文件。结果是 holder 的报告改了、断言没改——探针"通过"了一轮，通过的还是那个假断言。是后来 `git diff` 才发现的。

```python
assert old in s, 'the site moved'      # 不加这一行，就等于没改
s = s.replace(old, new, 1)
```

---

## 5. 第四类：跑了却把结果丢掉的检查

### 症状

`gates.mjs --probe`：

```js
const results = scan(files, { raw, code })       // 跑全部 11 条门禁
for (const { name, findings } of results) {
  if (name === 'vertical-slice-smoke' || ...) {   // 然后跳过读真实树的那 4 条
    console.log(`  skip  ${name}`); continue
  }
```

于是 `pnpm gates` 里那 3 个端到端脚本**被完整跑了两遍**，第一遍的结论被丢掉。修复不是"在循环里 `continue` 得更早"，而是**在执行之前筛选**：

```js
const scored = DETECTORS.filter(d => d.realTree !== true)   // 先筛，再跑
```

并且把 `realTree` 标在**检测器自己的声明上**，而不是写成一个名字列表——名字列表会漂移，声明不会。

### 以后怎么先看见它

> **"先生成再过滤"里，生成侧的代价如果是 I/O、子进程或全量重放，那这个过滤就是错的。**

顺带一条：`--probe` 现在会打印一行它**没有**跑哪些门禁、以及那几条各有独立探针，所以"跳过"是**被报告的**，不是被隐去的。

---

## 6. 第五类：被自己的死变量养着的遗留设施

### 症状

四个纯内存 spec 里都有：

```ts
let logPath: string
beforeEach(async () => { logPath = await newLogPath() })   // 建一个真实临时目录
```

`logPath` **一次都没被读过**。`framing.spec.ts` 里那个 `beforeEach` 干脆是空的。`newLogPath` 是 `MemoryLog` **还是持久日志**那个年代的遗留物；搬到 DSH 持久化之后，测试不再需要它，但变量留着，于是每个 spec 都在磁盘上建一个没人用、没人删的目录。

同样的长相还有 13 处未使用的 import/局部变量，以及 `vitest.config.ts` 里重复的 alias。

### 最小代价修法

**不是逐个删了了事**——那只是把这一次清干净。真正的最小代价是**让这一类缺陷不可能再出现**：

```jsonc
// tsconfig.json
"noUnusedLocals": true,
"noUnusedParameters": true
```

一行配置，17 处诊断一次性变成**编译错误**。然后：

- 删 `newLogPath`（连带 `mkdtemp`/`tmpdir`/`join` 三个 import）；
- 删四个 spec 的 `logPath` 与 `beforeEach`；
- 删 13 处未使用声明；
- 删 `vitest.config.ts` 的重复 alias。

### 为什么这条不是"洁癖"

旧仓的根因之一是**"形状繁殖没有门禁"**：加一个格式零成本，删一个要人工审计，于是长出 12 个持久化格式和 197 处无人引用的导出。

`no-unreferenced-export` 管住了**导出**那一半。**导入/局部变量那一半一直没有门禁**——而出 13 处这样的残留只需要几轮编辑。它们是同一场病的另一半，现在两半都有闸了。

### 以后怎么先看见它

> **一个没有门禁约束的维度，一定会长回来。**

发现一类残留时，先问"能不能变成编译器/门禁的错"，能就先做这一步，再做清理。

---

## 7. 一次真实的静默失败（值得单独记）

**批量编辑脚本的静默 no-op**（§4 末尾那条）。它的可怕之处不是改错了，而是**改了一半**：

- holder 那一侧的改动生效了（报告里多了 `pin`/`inputs`）；
- 断言那一侧的改动没生效（旧文本不匹配）；
- 脚本正常退出，探针正常通过，**通过的还是那个假断言**。

发现它靠的是 `git diff --stat` 里那个"6 +++++-"与预期不符。

**纪律**：批量改文件之后，**用 `git diff` 核对行数**，不要相信退出码。改脚本时，**每次替换都 assert**。

---

## 8. 收尾清单（这一类重构的固定动作）

- [ ] 每一处报告都**量过**，不是"看着像"。
- [ ] 每一处的**根因**写成一句"我当初把 X 理解成了 Y"。
- [ ] 修法是**删代码**为主；删不掉就回去重看第 3 步。
- [ ] 没有新增 helper：没有"把旧逻辑包起来"的新函数。
- [ ] 每条新规则有**变异证明**；`MISSED` 的当场删规则。
- [ ] `tsc`（含 `noUnusedLocals`/`noUnusedParameters`）干净。
- [ ] 全量测试 + 全部门禁 + `--probe` + 三个真实进程探针 + 真实模型冒烟全绿。
- [ ] 文档同步：**文件清单、门禁数、测试数、脚本名**（这些数字在 `context.md`/`blueprint.md` 里出现过，改代码不改文档等于制造下一条假断言）。
