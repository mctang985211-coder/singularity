# adversarial-review-3.md —— 第三轮：攻击上一轮的修复

**审的是 `9eb755c` 的干净副本。审查只读；测量全在 `/tmp` 副本上做。**
基线：`tsc` 干净、308 测试 / 28 文件、`node scripts/gates.mjs` **18/18**。

> 本文件是**观测记录**。做了哪些修看提交历史与 `context.md`。

---

## Blocking

### B1 —— receipt 的 `cutoff` 仍然是调用方选的数，只是从参数挪进了数组长度
`src/task/view.ts:239`（`cutoff: entries.length`）＋ `foldSubject`（`src/protocol/fold.ts:70-77`）
**不检查 seq 连续性、不要求是前缀**，只按数组顺序 reduce。于是"界不是我推导出来的那个数"仍然可构造，
而且比传错参数更隐蔽：**调用方选数组**。

**实测**（7 条 slice 事实与 7 条外来 subject 事实交错，task 事实落在 seq 1,3,5,7,9,11,13）：
- 全日志：`cutoff=14`
- `entries.filter(e => e.subject === TASK_ID)`：**`cutoff=7`**，`basis='judged'`，
  而两个 verdict 在 **seq 9、11**、结算在 **seq 13**——**receipt 报的界低于它自己的证据**。

这正是上一轮 F2 的同一形状（"cutoff 1 携带 seq-4 verdict"），而 docstring 承诺的
"never a number a caller states beside those facts" 不成立。**修法一行**：
`cutoff = 1 + max(seq of the facts actually folded for this subject)`——**事实的函数**，不是数组长度。
（缓解：仓库内所有调用方都传全日志，所以这是**保证层**的缺陷，不是已有的误算。）

### B2 —— 「执行者不能度量/认证自己的 run」吃调用方给的**第二张表**（上一轮 F3，**本轮已执行**）
`src/measure/commands.ts:77` 存第二份 role→identity 表，`:293-298` 拿它比。
docstring 用 **store 的**表来论证**这张**表，而 store 不暴露自己的表（只有 options 与一处透传），
所以部署**被迫**维护第二份，且没有任何东西比对二者。

**A/B 实测**（同一 store、同一批事实，只换 measure 服务的表）：
```
CONTROL trial : REFUSED self-reported-evidence (role verifier:meter@1)
CONTROL check : REFUSED self-reported-evidence (role verifier:bounds@1)
ATTACK  trial : ACCEPTED (fact seq 5)      ← 服务表里只留 { scheduler: EXECUTOR }
ATTACK  check : ACCEPTED (fact seq 6)
ATTACK  folded: observed=[{slot:0,quality:1,…}] checks=[{criterionId:'limits',met:true}]
```
后果：C 的退出条件「高分但越界拒绝」退化成**「除非候选人自己检查自己」**。
仓库自带 wiring 把**同一个对象**传给两处，所以探针抓不到——**缺陷在 API 的形状**。

---

## High

### H1 —— `measure@3` 的 `metric.direction` 也是死声明，而且与 round 的 direction **从不比对**
`src/measure/protocol.ts:86` 声明、`:172-175` 校验、`caliberOf`（`src/measure/view.ts:147-151`）折进摘要——
然后全仓唯一的 direction 读者是 `src/strategy/view.ts` 的四处 `plan.metric.direction`。
**这是第五个"不可能失败的声明"**，形状与上一轮 F1 一模一样。

**实测**：真实 measure 事实声明 `lower`，真实 plan 声明 `higher`，`plan.caliber` 取自那些 evaluation
自己的 `caliberDigestOf`（证明是**同一次测量**）→ 两个方向都合法、都被持久化、
**没有任何拒绝**，ranking 只跟 plan，而且真发了一条 `round/decided: winner 1`。

**修法**：direction 属于**测量**，不属于轮次计划。**删掉 `plan.metric.direction`，从 evaluation 的
metric 取**——因为一轮内 caliber 必须一致（已强制），所以方向天然唯一，**两个声明不一致这件事
变得不可表达**。

---

## Medium

- **M1 —— `lower` 下 floor 的 reason string 把门槛算反了**（决策对，写给人看的数错 2×band）。
  实测（incumbent 0.9、band 0.05、候选 1.05）：消息说门槛 **0.85**，真实门槛 **0.95**；
  尾巴 "a cost saving below the floor is not a gain" 在 `lower` 下也是反的。
  **同一处的 spec 也把规则记错**：`tests/strategy-direction.spec.ts:76-80` 的注释描述的规则
  不是它实际测的（0.95 被拒是 `select` 的 in-band 规则，不是 floor）。
- **M2 —— receipt 的 `judged` 只是"有 verdict 这条事实"，不是"字节被读过"**。
  `assertInputsBound` 强制 verdict 的 `inputDigests` **等于** bubble 的声明，所以两份列表按构造恒等；
  实测直接把 verdict 发进日志（没读任何字节、digest 抄 bubble）→ `basis=judged`。docstring 的
  "the digests the production verifier hashed from the bytes it actually read" 不是 log 能证明的。

---

## 「不可能失败的检查」完整清单（在 `b0f4c50` 上同样成立）

**第 1 类：可证明不可能失败**（源码 + 类型推断，未做变异——把值变空会让 payload 读取先拒，测不到）
- `tests/environment-binding.spec.ts:72` —— `revision.at.length > 0` 与 `true` 比（`at` 是 envelope 字段，
  `requireText` 要求非空）。**三个已知成员里唯一真正不可失败的。**
- `tests/strategy-decision.spec.ts:183` —— `entry.reason.length > 0`（由非空字面量构造 + `text()` 拒空）。
- `scripts/round-probe.mjs:263` —— 同一条的合取项（**新成员，此前未被点名**）。
- `scripts/cd-probe.mjs:763` —— 同上的两个合取项（**新成员**）。

**第 2 类：输入缺席／空集，expected 是默认值**（可失败，但只对"凭空造值"失败）：
`strategy-decision.spec.ts:104,114`（`noveltyOf([],…)===0`）、`environment-binding.spec.ts:123`（空输入→空输出）、
`task-tree.spec.ts:225`、`verifier-command.spec.ts:110`（**在断言自己的输入**）、
`measure-execution.spec.ts:228,272` 与 `verifier-production.spec.ts:240,278,291`
（`markerLabels()` 读不到文件就 `return ''`，于是"程序跑了但早崩"与"没跑"同样绿）。

**第 3 类：弱但可达**：`control-store.spec.ts:175`（`toBeDefined()`）、
`control-probe.mjs:273`（标签说 "still fold to the same state"，第二合取项只是存在性）。

---

## 上一轮「未验证」项的复核：**F4、F5a、F5b、F5c 全部复现**

| 项 | 结果 |
|---|---|
| F4 加载荷成员不升版本 | **复现**：`release/drafted` 加可选 `authorNote`，`RELEASE_VERSION` 仍 1 → `tsc` 干净、**18/18 全绿** |
| F5a 活协议绕过 `protocol-inventory` | **复现**：`SNEAK['declare']('sneak',1,…)` 声明活协议并被本文件读取 → **18/18 全绿**（正则抓不到中括号形式） |
| F5b `no-unreferenced-export` 文本匹配 | **复现**：加 `export const revisions = 0`（无 importer）→ 门禁 ok（该词作为成员名在别处出现） |
| F5c `no-durable-writer` 看不见动态 import | **复现**：`await import('node:fs/promises')` + `writeFile` → **18/18 全绿** |

**变异复核（审查者自己重跑，非复述）**：`published-assets` 的 a/b/c 三条**全 caught 且只被为各条修正
写的那条用例抓到**；E3 两条 caught；direction 三处调用点各一条 caught（**这三处是真承重的**）。
**明确无法核实**：仓库里没有变异脚本，所以"S2 分解四条"、`task@4` 的"六条"、`control-barrier` 自身、
`cd-probe` 的 novelty 反事实——**只能说未复核，不能说它们假**。

**另标注（未执行，算待办不算 finding）**：`Calibration.source` 的 `'measured'` 没有任何事实支撑
（`readCalibration` 只要求 `floor ≥ 0` 且 `source ∈ {measured,declared}`），而它压在 C 的退出条件
「真实重复与噪声依据」上。
