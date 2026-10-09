# spec-policy.md —— spec 只锁调用方看得见的行为

> **一句话**：spec 的规模由**对外表面**决定，不由源码规模决定。spec 逼近 src 的行数，
> 说明它锁的是内部结构；而内部结构一改，spec 就红——于是每次重构都要改 spec，
> 于是没人敢重构。这正是旧仓"两次大重构都没换掉根因"的一个直接成因。

## 0. 实测基线（2026-10-09，提交 `5911165`）

| | 行数 |
|---|---|
| `src/**/*.ts` | **7,878** |
| `tests/**/*.ts`（含 691 行 fixture） | **6,909** |
| 比值 | **0.88** |

最密的几个文件（`expect` 数 / `it` 数）：`control-barrier` 7.8、`measure-slice` 6.8、
`verifier-command` 6.2、`control-store` 5.8、`framing` 4.1。

**目标**：比值 ≤ **0.6**，每用例 `expect` ≤ **4**。当前闸值 **0.90 / 8**——**只能降不能升**；
每次动到某个 spec 就顺手把它压到目标，然后下调闸值。这不是 grandfather 名单，是**棘轮**：
闸值写在 `scripts/gates.mjs` 里，降闸是提交的一部分。

**闸已经证明能抓住真实树**（把闸值临时调到目标值跑出来的原文）：

```
FAIL  spec-budget
        the specs are 6934 lines against 7912 of source (0.88, budget 0.6)
FAIL  spec-density
        tests/control-barrier.spec.ts asserts 47 times in 6 test(s) (7.8 each, budget 4)
        tests/control-store.spec.ts asserts 35 times in 6 test(s) (5.8 each, budget 4)
        tests/framing.spec.ts asserts 77 times in 19 test(s) (4.1 each, budget 4)
        tests/measure-execution.spec.ts asserts 33 times in 7 test(s) (4.7 each, budget 4)
        tests/measure-slice.spec.ts asserts 75 times in 11 test(s) (6.8 each, budget 4)
        tests/task-revision-pinning.spec.ts asserts 6 times in 1 test(s) (6.0 each, budget 4)
        tests/verifier-command.spec.ts asserts 37 times in 6 test(s) (6.2 each, budget 4)
```

**这就是下一轮的待办清单**：要压到目标还要删约 **2,300** 行 spec。删法的判据只有一条——
**这条断言说不出一个外部事实，就删它**（最常见的是同一个"没有变持久"在一个用例里断言三遍）。

## 1. 只锁调用方看得见的行为

看得见的只有四样：**返回值、持久状态、事件顺序、对外调用**。

- 返回值 → `expect(结果)`，直接断言那个值。
- 改状态 → **先做完，再读公开状态**（`store.load()`、`foldSubject`），不要去读内部字段。
- 命令外部世界 → **只断言发出的消息**，并且**只 mock 那一层**（`tests/control-barrier.spec.ts`
  的 `BarrierPersistence` 就是这个模式的样板：它是 DSH 持久化缝，断言 `events`/`durable` 合法）。
- **私有函数、内部调用、内部数据结构：不写 spec。** 需要写，说明它该被公开调用方间接观察到，
  或者它根本不该存在。

## 2. 一个行为一条断言

一个 `it()` 说**一件**事。同一件外部事实在一个用例里断言三次，是三次维护成本、零额外信息。

## 3. 什么时候写

**写**，当且仅当：**返回值、持久状态、事件顺序或对外调用会变，而且现有 spec 还不会红。**

优先级：**边界 → 错误路径 → 失败无副作用 → 已修过的契约**。
（最后一条指：修过的缺陷必须有一条钉住它的 spec，否则它会回来。）

**不写**：为了行数、为了"看起来覆盖到了"、为了证明实现细节、为了给一条已经不可达的分支留念。

## 4. 重构之后

- **行为没变却红了 → 删掉这条 spec。** 它锁的是内部结构，不是行为。
- **覆盖率红但说不出对应的外部事实 → 删代码，不补测试。**
  （说不出外部事实的那段代码，就是没有外部事实支撑的代码。补测试只会把无用的东西焊死。）

## 5. 机制（不是自觉）

两条闸，都在 `scripts/gates.mjs`：

| 闸 | 拦住的屎 |
|---|---|
| `spec-budget` | spec 总行数 ÷ src 总行数超过棘轮值 |
| `spec-density` | 某个 spec 文件的 `expect` ÷ `it` 超过棘轮值——一个用例塞了太多行为 |

两条都有合成失败探针（`--probe`），和其余门禁一样：**没失败过的闸不算闸**。

## 6. 和 `debugging.md` 的关系

`docs/debugging.md` §4 讲的是"写了规则必须证明它能失败"。这一份讲的是**反过来**：
**不是所有能写下来的东西都值得钉住**。两份合起来的判据是一句话：

> 每条规则都要有变异证明，**每条 spec 都要能说出它锁的那个外部事实**。
> 说不出事实的 spec 删掉，说不出事实的代码也删掉。

## 7. 不要为了过闸而拆用例

`expect ÷ it` 是**代理指标**，不是规则本身。规则是"一个行为一条断言"。两者的差别在这里：

- 三行断言在说**同一个**外部事实（最常见：同一个"没有变持久"断言三遍）→ **删掉多余的两行**。
  这是压指标的唯一正确方式。
- 三行断言在说**三件不同**的外部事实 → 那是三个行为，测验用例本来就该分开，或者本来就该留着。

**把一件事实拆进两个 `it()` 来提高比值，是把这个闸变成有害的东西**：两半现在必须一起改，
维护成本翻倍，而外部事实一条都没多。发现这种情况，按"重构后行为没变却红了"处理——
删掉被拆出来的那一条。

## 8. 共用工作树时的提交纪律（协调者）

四条并行工作流写同一棵工作树时，`git add -A` 会把**别人正在写的东西**一起提交：本轮就发生过
一次提交抓到 `round-probe.mjs` 的中间破损状态，以及一次提交的消息没覆盖它实际包含的改动
（两条 measure 规则落在了一个讲"记录状态"的提交里）。

规矩：**只在验证全绿的点提交**，提交前用 `git show --stat` 核对自己写下的消息是否覆盖了
diff 里的全部文件。多个工作流同时写一个仓库时，"消息与内容不符"是必然会发生的默认结果，
不是意外。
