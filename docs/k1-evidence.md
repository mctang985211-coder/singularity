# K1 交回材料：逐条证据

> 对应 [`review.md`](review.md) §6 的 K1 12 场景。每条的形态是**观测**，不是声明：给出跑什么、看到什么、证据在哪一行。
> 复现命令：`pnpm verify`（= `tsc --noEmit` + `vitest run` + `node scripts/gates.mjs` + `node scripts/gates.mjs --probe`；测试与门禁的**条数**由这两条命令自己打印，规模数字在 `tree-baseline.json`）、`node scripts/control-probe.mjs`、`node scripts/slice-b.mjs`、`node scripts/recovery-probe.mjs`。
> 其中三条是**门禁**，不是"记得要跑"的脚本：`control-store-probe`、`root-child-slice`、`recovery-probe`；三条都各自有一个合成失败探针（`node scripts/gates.mjs --probe`）。
> **尚未观测的项单列在最后，不混进已通过的条目。**

| # | 场景 | 结果 | 观测与证据 |
|---|---|---|---|
| 1 | 独立进程重开控制 store | ✅ | `scripts/control-probe.mjs`：持有者被杀后，后继进程打开同一 control id，读回**全部**已提交事实并重新 fold（§3/§4）。自有扩展事实可解释：`tests/control-store.spec.ts` › *round-trips a record through a real session file and a second store*。未知内层 kind/version/字段各具名拒绝：同文件 › *refuses an unknown inner kind, version and field, each by name*（5 个用例，含载体版本与 kind 不一致）。**不占用 agent 的第二个 transcript 写句柄**：控制记录写在**由 control id 派生的自有 session**（`controlSessionIdOf`）里，且同文件 › *keeps the medium cursor and its own chain apart when the session holds a foreign event* 证明它能与外来事件共处一个物理日志而不误认归属。 |
| 2 | 两个进程竞争、杀死持有者 | ✅ | `scripts/control-probe.mjs` §2：第二个写者立刻拿到 `SessionAlreadyOwnedError`（不阻塞），read 句柄不受影响；`kill -9` 之后后继立即取得所有权（内核释放 flock）。`scripts/recovery-probe.mjs` 每个边界都复核一次："the successor takes over the write lease immediately after the kill"（实测毫秒级，阈值 5s）。 |
| 3 | 同进程并发准入或更新 | ✅（B 范围内的形态） | 串行提交无重复序号：`tests/gate.spec.ts` › *serializes concurrent commits*。**恰好一方提交**：`tests/task-commands.spec.ts` › *refuses work once the plan budget is spent, and admits exactly one of two concurrent starts* —— 并发两个 `startRun` 打在同一预算为 1 的子任务上，`Promise.allSettled` 后**恰好一个 fulfilled、一个 rejected**，落盘只有一个 run。该用例**变异证明**：把读 cut 取在排队之前（即"先检查后入队"）→ 两个都通过，用例失败。**诚实边界**：review 里"同一 expected head 的冲突"指的是环境指针的 CAS，那属于阶段 D（唯一指针切换）；B 证明的是同一临界区内对已提交 cut 的串行判定。 |
| 4 | 持久化屏障失败；成功提交后答复前杀进程 | ✅ | 前者：`tests/control-barrier.spec.ts` —— 屏障失败**不返回成功**；结果不确定时**所有**后续提交具名拒绝（含同 commandId 重送）；只有显式 close/open 且新屏障成功后才采纳介质记录并识别原结果；崩溃丢掉未确认前缀时**不发明结果**。后者：`tests/control-store.spec.ts` › *recovers a lost reply by re-delivering the same command id, and refuses a different request under it*（同 commandId 同请求返回原事实、异请求 `command-conflict`）。跨进程形态：`scripts/recovery-probe.mjs` 在结算边界杀进程后，**重送 verdict 命令返回死者已提交的那条事实且不产生第二条**。 |
| 5 | 身份伪造与协议非法输入 | ✅（审批者身份属 D） | agent 无法声明验证器身份：`tests/task-invariants.spec.ts` › *refuses a verdict whose implementation is not the criterion's*；同一身份绑两个角色也被拒 › *refuses a deployment that binds one identity to both the executor and a verifier*；**agent 拿不到裁决方法**：`tests/task-commands.spec.ts` › *offers an agent no way to produce one*（`forAgent` 的键集合被逐一断言，且 `'recordVerdict' in asAgent === false`）。未知字段/错误类型/原型 key/拒绝声明不污染状态：`tests/task-invariants.spec.ts` › *refuses an unknown payload member instead of accepting it*、*refuses a wrong-typed optional member instead of normalizing it away*；`tests/gate.spec.ts` 的 E08 回归（`toString`/`constructor`/`__proto__` 当 kind，声明全有或全无）。**诚实边界**：审批者身份依赖 E6 原生审批，属阶段 D。 |
| 6 | 根节点提出并执行分解 | ✅ | `scripts/slice-b.mjs`：根任务 `task-report` 提出分解为两个真实子任务（`task-count`、`task-limits`），后者 `dependsOn` 前者、各支持父契约的一条判据；两者都有明确执行责任（`task/assigned`）。依赖推进：子任务在依赖 verified 之前既不能启动也不被报告为 ready，拒绝语句引用计划本身（"waiting for "task-count" (ready) to verify"）。**责任转移后原节点不能继续同项工作**：`tests/task-binding.spec.ts` › *refuses the previous holder after a transfer, and lets the new one work*（转移后旧持有人启动 run → `not-responsible`，且点名新持有人；新持有人在身份为它的部署里可以启动）。 |
| 7 | 真实验证器处理具体产物 | ✅ | `scripts/slice-b.mjs`：判据命名的实现摘要 = **真实验证器程序的字节摘要**；验证器**真的被 spawn** 去读产物并裁决（exit code 0/1）；记录的 `artifactDigest` 是**执行之后**磁盘上字节的摘要（同脚本逐条断言）。换掉产物 → 旧 verdict 不放行（`tests/verifier-production.spec.ts` + slice 的 artifact swap 观测）；换掉**验证器实现** → 该部署不再持有那个摘要 → `unregistered-verifier`（slice 与 production spec 的 t3）。输入被换 → `evidence-input-mismatch`（production spec 的 t2，且**在判官被问到之前**就拒绝）。"实际执行过"不是声称：判官报告的是**它在判决时刻从程序字节算出的**摘要（`tests/verifier-production.spec.ts:107,127`），而不是回显判据里的值——整个链条若回显就构成循环论证，我复核过这一点。 |
| 8 | 准入后方法版本更新 | ✅ | `tests/task-revision-pinning.spec.ts`：在途 run 保留自己的 revision（pin 是 run 启动时刻的事实）；新 run 可以**显式**选择新 revision 并按其记录；同 id 异内容被环境 reducer 拒绝为 `revision-conflict`（用例直接驱动，不靠注释）。修订不可变与幂等：`tests/environment-revision.spec.ts`（摘要**由 reducer 自己算**、同 id 同内容幂等、异内容拒绝、篡改即拒）。 |
| 9 | 在执行和结算边界 SIGKILL | ✅ | `scripts/recovery-probe.mjs`：**两个边界各杀一次真实进程**（不同 session）。每个边界都观察到：后继立即取得写租约；**同一** control session；死者提交的事实逐条可读且**没有多也没有少**；责任（agentId + 身份）、revision pin、bubble 声明的输入**原样存活**；重放已提交命令**不追加第二条**；**已提交结果不重复创建或结算**。执行边界：死者**什么都没裁决**（evidence 为空），后继完成且只完成一次。结算边界：死者已提交的 verdict **恰好一条**，重送其命令返回**同一事实**，后继结算不产生第二个 run。 |
| 10 | 子任务失败或耗尽既定预算 | ✅ | 停止是真的：`scripts/slice-b.mjs` 在预算耗尽后**再次 start 被命令边界拒绝**，拒绝语句是计划自己的话（`budget exhausted: 1 of 1 declared runs used without a verified run`）；`tests/task-tree.spec.ts` › *refuses work once the plan budget is spent…*（并发形态）、*blocks a dependent on a dependency that ended without verifying, naming it*、*propagates a stopped dependency through a chain, naming each link*（停止沿链具名传播）。**父任务不会提前完成**：slice 断言父的 `complete === false` 且未被接受的判据具名为 `null`；tree spec › *does not accept a criterion whose supporting sub-task merely stopped*（变异证明：把未 verified 的子任务算作接受判据 → 该用例失败）。**不隐式扩大预算**：`maxRuns` 在分解事实里且没有任何 kind 能改大它。 |
| 11 | 完成后追加会话消息、卸载当前验证器 | ✅ | **固定来源 receipt 摘要不变**：`tests/task-slice.spec.ts` › *does not move a receipt at a cutoff because unrelated facts arrived later* —— 同一 cutoff 下，之后提交的其它事实不改变摘要；而"另一个 cutoff 是另一份账"也被断言（把 cutoff 做成常量会让 3 条用例失败）。receipt 带 **cutoff** 与**真实消费**（输入 + workspace）与每条判据的**产物摘要**。**历史按受支持版本重放**与**新执行缺实现拒绝**分开：`tests/task-invariants.spec.ts` › *folds a log whose verifiers this deployment no longer holds identities for*（无验证器身份的部署仍能解释历史）与 `tests/task-invariants.spec.ts` › *refuses an unrunnable verifier at admission, while the same contract still replays*（同一份契约：准入拒绝、重放通过）。 |
| **真实模型调用** | ✅ | `scripts/model-smoke.mjs` 两段，都是**真实模型**。**§1 一次真实补全**：挂载宿主 profile 真正配置的那条路由（`dsh-credentials-local` 读 `~/.dsh/.credentials.yaml` 的 `COMMANDCODE_API_KEY` + `dsh-llm` 运行时 + `dsh-llm-pi-ai` 的 `commandcode` provider，`openai-completions`，模型 `deepseek/deepseek-v4.1-flash`），实测 16 chunks、`finish` 无错误、答案 `"four"`、约 2.5–4.8s。**§2 一次真实模型驱动的 agent turn**：挂载 runtime track 用的同一组插件（persistence/sessions/agents/llm/tools/systemPrompt/projections/**agentLoop**），但**不注册桩适配器**，改挂真实路由；`ctx.agents.create({sessionId, meta, agentOptions:{provider:'commandcode', model}})` → `agent.followup(createUserMessage(...))` → `await agent.whenIdle()`。实测事件序列 `agent/inbox/spliced, turn/start, …, system/message, user/message, request/header, request/context, assistant/message, step/end, turn/end`，且从**记录的 `assistant/message` 事件本身**读出模型产出的文本 `"four"`（不是从便利访问器拿的）。断言只有结构性：turn 走完、session 里有一条模型产出的 assistant 消息、文本非空；**不依赖模型说了哪个词**。**刻意不做门禁**：依赖网络与凭据，做成每次提交都跑的门禁会因为与改动无关的原因失败。 |
| **真实模型 × 真实任务的同一条管线** | ✅ | `scripts/rsi-live.mjs`，**一条管线，且住在计划里**：根任务持契约并跑基线，**模型在受托子任务 `attempt-1` 的 run 里干活**（run 经 `forAgent` 命令面启动——就绪、预算、责任门是任何 agent 的 run 要过的那几道；`attempt-2` `dependsOn` `attempt-1`，未验证前启动被命令边界拒绝且点名依赖）→ **真实模型写出产物本身 → 判据自己的验证器（被 spawn 的真实进程）判决 → `task@5` 把判决记一次、run 随判决结算 → `measure@4` 记数字并引用那条判决的摘要 → round 按读数选优 → 原生审批 → 指针 compare-and-swap 移动 → 每棵子树一条 receipt 从固定来源推导，判据摘要与 constraint 的 citation 逐位同源**。一次完整运行的全部事实在 [`live-campaign.md`](live-campaign.md) 与 [`live-campaign.jsonl`](live-campaign.jsonl)（53 条），读数逐条可查：incumbent 打印 234、验证器 **fail**（quality 0，run 结算 failed）→ 模型写的程序打印 171、验证器 **pass**（quality 1，run 结算 verified，根的 `counted` 判据 `satisfiedBy: attempt-1`），指针 `r0000 → r0001`；约束检查 `met true` 且引用的判决摘要 `6caa4625…` 与 receipt 的判据条目落在**同一个产物** `fc68f3b1…` 上（结算前缀与全量前缀各推导一份 receipt，重开后同摘要）；第二轮模型换了个写法、读数相同，**没赢，指针不动**。断言全是结构性的，**没有一条依赖模型说了哪个词**——正是 review 要求的那条边界。 |
| 12 | agent、API/UI 读取同一已提交截止范围 | ✅ | 唯一投影：`projectTask` / `projectTree` / `projectReceipt` 是仅有的读投影，agent 渲染与 UI 消费**同一个对象**（`tests/task-slice.spec.ts` › *renders the same view for an agent, adding nothing and hiding nothing*）。**未启动 Task 不显示失败**：`tests/task-slice.spec.ts` › *reports an admitted task with no run as awaiting a run, not as failed*；`tests/task-tree.spec.ts` › *keeps a child that has not started out of the blocked list*。**读路径不追加、不启动工作**：`tests/control-barrier.spec.ts` › *offers no write capability or shared mutable state through a read*（`load()` 返回固定读 cut，类型上就没有写方法；对返回值做 `Reflect.set` 也不影响内部状态）。 |

## 尚未观测（保留未完成状态）

| 项 | 为什么未完成 | 具体缺口 |
|---|---|---|
| 若实际部署需要 group/router | review §6 说"若实际部署需要，把唯一公开端点和同会话恢复纳入 K1；无当前消费者的完整嵌套组能力不作为提前建平台的理由"。 | 上游实测：**没有**通用 group 服务，也没有 group router（证据见 `context.md` §10）。B 因此不建；`ctx.subagents` 的 spawn/fork 与可继续子代理存在但当前无消费者。 |
| 场景 3 的 expected-head CAS | 那属于阶段 D 的"唯一指针切换"。 | B 已把**唯一条件更新**留给 D（门禁 `single-conditional-owner` 在 `src/` 内断言至多一个），B 范围内证明的是临界区串行与"恰好一方提交"。 |

## 故障恢复结果（场景 4/9 的合并读数）

两个边界各一次真实 SIGKILL，**21 项检查全过**（`scripts/recovery-probe.mjs`）：

- 执行边界：死者提交 9 条事实、**尚未裁决任何判据**；后继接手 → 事实逐条一致 → 重放已提交命令不追加 → 完成裁决与结算**各一次**。
- 结算边界：死者提交 10 条事实（含 verdict）；后继接手 → 已提交 verdict **恰好一条**且保留其产物摘要 → 重送该命令返回同一事实 → 结算不产生第二个 run。

**这个探针抓到了命令边界的一个真实缺陷**：前置条件原先在 store 解析命令身份**之前**求值，于是重送一条已提交的命令会被"状态已经变了"重新判定并拒绝——丢失答复因此**无法通过命令面恢复**。修法是把前置条件放进 append 路径（身份之后、reducer 之前）。变异证明：把顺序改回去，探针以那句拒绝失败。

上面这段是 **K1 交回时（`c26c0be`）的观测值**，保持原样不改：证据文档里的数字是"当时看到
的东西"，不是"现在应该成立的东西"。控制路径收敛（`docs/debugging.md` §1）之后重跑的值记在
本文件末尾，**门禁从 11 条变成 10 条是合并删除，不是覆盖率下降**。

## `pnpm verify` 输出

```
$ npx tsc --noEmit
(no output, exit 0)

$ npx vitest run
 Test Files  18 passed (18)
      Tests  177 passed (177)

$ node scripts/gates.mjs && node scripts/gates.mjs --probe
gates: 11 gates over 42 files
  ok  no-export-star / no-durable-writer / no-unreferenced-export / no-duplicate-type-body
  ok  source-size / single-conditional-owner / dsh-alignment
  ok  control-store-probe / root-child-slice / recovery-probe / vertical-slice-smoke
gates: OK — 11 gates passed
gate self-test: OK — every static detector can fail

$ node scripts/control-probe.mjs
failures: 0
gaps: 0
```

---

## 收敛之后的重跑（控制路径：一条决定/记录路径、一个队列、O(1) 提交）

```
$ npx tsc --noEmit                         # 且 noUnusedLocals / noUnusedParameters 已打开
(no output, exit 0)
$ npx vitest run
 Test Files  18 passed (18)
      Tests  181 passed (181)
$ node scripts/gates.mjs
gates: OK — 10 gates passed
$ node scripts/gates.mjs --probe
gate self-test: OK — every static detector can fail
```

- **门禁 11 → 10**：`vertical-slice-smoke` 与 `tests/task-slice.spec.ts` 的 11 个用例逐条重合
  （9 条 check 全部已被覆盖），且 `slice-b`/`control-probe`/`recovery-probe` 三个真实进程探针
  已经在跑同一个"经 `src/index.ts` 起的进程"。删掉的是**重复的那一条**，不是覆盖。
- **提交的 reducer 调用数：50 条事实 2550 → 50（1 次/提交）**；被拒绝的命令 101 → 1。
- **200 条事实的提交耗时 2250ms → 430ms**，且每条耗时不再随日志长度增长（介质自身在 200 条时
  是 301ms，我们已贴在地板上）。
- **`recovery-probe` 的"修订固定存活"断言**：先证明旧断言在*抹掉 `environmentId`* 的变异下
  仍然报 `ok`（三元式第一分支恒假），再换成逐字段比较；同一变异下新断言 `FAIL` 并打出三方读数。
