# 第 11 项 A4 收尾返工：恢复屏障 ready 后再唤醒问答 Agent

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **待验收**（交付方最高可填状态），2026-09-26 |
| 执行 agent / 任务链接 | 收尾返工实现代理；[收尾返工 prompt](../execution-prompts/11-a4-barrier-wake-rework.md)、[二次进度审核](2026-09-26-a4-second-progress-review.md)、[计划 F.1](../2026-09-20-vrtc-code-change-plan.md) |
| 基线 | Singularity `97abf30`、外层 `8080691c8b`（票面写 `ee3a4bd` / `3dc320d`；实际树各多一个仅文档的二次审核提交，内容为审核记录与本 prompt 本身）；动手前两树干净，外层仅 `thirdparty/deepseek-harness` 的既有未跟踪文件（未触碰） |
| 交付版本 | Singularity `97abf30 → d7c0c50`（实现+测试），文档提交紧随其后（同一票）；外层指针提交见交付报告 |
| 范围 | 只改恢复屏障的唤醒时序及其直接调用方、测试与文档；未动 DSH、未收钱模型、未推送 |

## 竞态机制（复核结论与票面一致）

`adoptRoot`（`task-runtime/src/index.ts:1813`）先建屏障并把 store 置 `recovering`，再 await 屏障体；屏障内的 `reconcileStore` 在过去直接执行「问答投递 + 未 claim 唤醒」块：`reconcileQuestionDeliveries`（`task-runtime/src/question.ts:662`）经 agent-runtime `messages.ts` 对 live 目标 `agent.steer`，`wakeUnclaimedQuestionMessages` 经 runtime `notify` 对持有未读消息的 Session `agent.followup`。DSH 的 steer/followup 对 idle Agent 即开一个 turn，因此被唤醒会话的**首笔模型请求**可以在 store 仍 `recovering` 时到达业务入口（`task_answer`/`task_ask_parent`/`task_submit_result` 都先过 `assertRecoveryReady`），被具名拒绝；ready 之后框架不重试、也不再唤醒该会话。原有冷恢复用例把首发工具调用停在 `adoptRoot` 返回之后（`recovered.promise`），因此没有覆盖这个交错——本轮用不等待屏障的 scripted 首请求把该交错固定成反例。

## 修复形状

**一个 store 的屏障在其 `recovering` 期间拥有唤醒决定权，形状与它已拥有的 `pendingDrivers` 相同（进程内、非持久、失败即丢）：**

- `StoreRecoveryState` 新增 `pendingQuestionDelivery`（延迟的投递+唤醒遍）与 `pendingNotices`（同一次屏障内要发的 owner notice，按登记顺序）。
- `reconcileStore` 把该块抽成 `deliverQuestions`：store 无在飞屏障（显式 `reconcileStore` 调用、测试）时**语义与今天完全相同**，立即执行并返回报告；屏障 `recovering` 时登记为延迟动作（同一屏障内第二次对账覆盖前一次，两者都重读持久事实）；屏障已取消则不登记、不投递。
- `adoptRoot` 成功路径在 `initializeStoreGates` 之后：非取消时先按序发出延迟 notice、再 `await` 一次延迟投递遍，然后才 `release(...)`（延迟动作只等 steer/followup 调用本身，不等模型回合；放在 release 之前，保持 `adoptRoot` 返回「屏障交还一步完成」的既有可观测时序，A4-2 的 gate decisionToken 用例依赖它）；`state.cancelled` 时一并丢弃；屏障失败时清空两者，不唤醒模型。
- 两条与问答投递同类的**恢复期 owner notice**（根契约激活 `index.ts:3515`、recovery 重绑 `index.ts:4434`）改走同一 latch 的 `notifyWhenReady`：notice 就是一次 `followup` 唤醒，而它告知的正是「你可以在本 store 上开始工作」，在 store 未 ready 时送达会被恢复门拒绝且无人再唤醒。无屏障时该方法即原 `notify`，行为不变。
- 投递/唤醒失败沿用原「warn 不失败整遍」语义；`reportUnsettledQuestionDeliveries` 的 warn 保留在延迟动作内。

### 屏障体内模型唤醒点枚举（`adoptRootThroughBarrier` / `reconcileStore` / `reconcileProposals` / `resumeAdoptedWorker` 链路）

| 唤醒点 | 判定 | 处置 |
|---|---|---|
| `reconcileQuestionDeliveries` → `agent.steer`（`agent-runtime/src/messages.ts:348`，由 `task-runtime/src/index.ts:5527/5531` 调用） | **同类**：向 live Session 投递问答正文并开会话 | 纳入延迟动作 |
| `wakeUnclaimedQuestionMessages` → `notify`（`index.ts:5622`） | **同类**：对持有已持久未 claim 消息的 idle Session 发 notice 唤醒 | 纳入延迟动作 |
| `activateRootContract` 的激活 notice（`index.ts:3515`） | **同类**：屏障内（`reconcileProposals` → `continueProposalIn`）激活根后向 live 根会话发 notice，notice 正文直接邀请 `decompose`/`submit` | 走 `notifyWhenReady`（同一 latch） |
| `rebindActivatedRoot` 的重绑 notice（`index.ts:4434`） | **同类**：同上，恢复重绑已提交激活的根 | 走 `notifyWhenReady`（同一 latch） |
| `settleRunFromRuntime` / `settleSubmittedRun` 的结算 notice（`orchestrate.ts:2844→2865`、`:2457/2471→2508`） | **不同类**：`onRunSettled`（`runSettledFromRuntime` → `executionGate.setTerminal`）先于 notice 执行，被唤醒模型若调业务工具得到的是「相位 terminal」的正确拒绝，不是 `recovering` | 不改 |
| `startBatchDriver` 注册的批次 driver（`index.ts:4872`） | 已有 latch（`pendingDrivers`/`released`），且 prompt 明确不算 | 不改 |
| `requestProposalReview`（`index.ts:4083`） | 经 `ctx.approval` 向 owner 会话/人发问，不是 runtime 对 live 会话的 steer/followup/notify；其后的决策写入是人/渠道自己的写入口，被 `recovering` 拒绝时保留 `pending_review`、由下一次激活重问 | 不改（见保留边界） |
| `resumeAdoptedWorkerSession`（`index.ts:5677`）/ `worker-resume.ts` | 复核：模块内无 `followup`/`steer`，恢复不唤醒（唤醒由投递/notice 决定） | 不改 |
| `drainSession`（`gate.ts:422`） | 复核：只 kill/wait 受管 jobs，无模型唤醒 | 不改 |

结论：屏障体内会 steer/followup/notify live 会话的调用点共 4 个，其中 2 个问答投递/唤醒源是本票主体，另 2 个根激活 notice 同类并与之一并收口；其余（结算 notice、已有 latch 的 driver、审批渠道发问）经上述依据排除。

## 验收对应

新增 `tests/integration/a4-question-cold-recovery.spec.ts` 的 `describe('a recovery wake waits for the ready handle (A4 §F.1)')`（`:1530`，6 例），复用同一真实 fixture（真实 Task store、DSH Session/inbox、AgentLoop、runtime gate、shipped 工具）。每例的 scripted 首请求就是「醒来后要做的合法业务调用」，**不使用 `recovered.promise` 一类等待器**；为保证交错确定，用例持住屏障在「对账遍返回之后」的第一次 store 读（`cancellation-gate.spec.ts` 对同一屏障用过的同一种读保持手段），先看该窗口内有没有请求被服务，再释放。

| 要求 | 入口 / 用例 | 结果 |
|---|---|---|
| 恢复补投唤醒后的首笔业务调用不被拒（屏障未 ready 时不得唤醒） | `delivers the recovered question only once its store is ready…`（`:1621`；崩溃点①意图已持久未投递） | 旧代码：首笔 `task_answer` 被具名拒绝 `the store is recovering — its recovery barrier is still running`；修后：首笔调用成功、同一 Session/Run 完成问答与批次，`copiesOf` 两侧各 1 |
| 已 flush 未 claim 的 pending 在 ready 后唤醒 | `wakes a durable unread delivery only once its store is ready…`（`:1691`；崩溃点③） | 旧代码：屏障内已被唤醒；修后：`woken=false`，notice 在 ready 后送达，首笔 `task_answer` 成功，inbox 仍恰好一份 |
| answer 侧补投后下一请求可见，且子的首笔调用合法 | `carries a recovered answer to the child…`（`:1760`） | 旧代码：屏障内唤醒子会话；修后：首笔 `task_submit_result` 成功，答案进子的实际请求，子 run `verified`、父批次结算 |
| 屏障失败：不发起模型请求、无业务写入、意图保留、下一次显式激活可补投 | `drops the wake when the barrier fails…`（`:1845`；注入「对账遍后 store 不可读」使 `initializeStoreGates` 失败） | 旧代码：失败前已投递（`copiesOf=1`）；修后：`copiesOf=0`、零请求、问题仍在记录，第二次 `adoptRoot` 补投且首笔调用成功 |
| 屏障取消：不唤醒、不写、意图保留 | `drops the wake when the barrier is cancelled…`（`:1890`；持住屏障时跑真实 `cancelGraph`） | 旧代码：取消前对账遍已投递（`copiesOf=1`）；修后：`copiesOf=0`、问答正文从未进入根请求、问题记录原样保留 |
| 同类唤醒（根激活 notice）同样只在 ready 后 | `holds the activation notice for the ready handle too…`（`:1926`；review 策略下 `intake` 留下 pending 提案，决策经 store 自己的入口落账后崩溃） | 旧代码：notice 在屏障内唤醒根（`woken=true`）；修后：`woken=false`，恢复自行激活一个根 task/run，根首笔 `task_decompose` 成功 |

红证据（最终测试文件 + 未修复的 `task-runtime/src/index.ts`）：该 describe **6/6 全败**，主例给出上述具名 `recovering` 拒绝，其余为「屏障内已被唤醒 / 失败前已投递 / 取消前已投递」断言；修复后 6/6 通过（`git checkout` 单文件回退取红，随后恢复）。共享路径（投递 `steer` 与两种 notice）用调用链 + 上表代表例证明，未做四点×两相位×两模式的笛卡尔积。

## 正常、拒绝、取消、重启、replay 行为

- **正常执行（无恢复）**：`task_ask_parent`/`task_answer`/`task_submit_result` 的入口、顺序、投递与 gate 语义未改；`notifyWhenReady` 无屏障时即 `notify`。
- **直接 `reconcileStore` 调用（测试/编排）**：store 无在飞屏障时立即执行投递并返回同一报告结构（`questionDeliveries` 仍按 messageId 逐条给出 `delivered`/`already-present`/`unavailable`/`refused`），幂等规则不变（已在 inbox/history 不重复投递；pending 未 claim 的 ready 后由 notice 唤醒）。
- **拒绝路径**：目标不 live 仍 `unavailable`、零副作用；正文引用不可读仍逐条 `refused` 且不失败整遍；warn 语义与位置不变。
- **取消 / 卸载**：`invalidateStoreRecovery` 仍置 `cancelled`、停摆 `pendingDrivers`；延迟的投递与 notice 不再发出（用例 5 断言问答正文零进入、无写入），持久意图留在 Task 记录。
- **重启**：失败/取消后下一次显式 `adoptRoot` 重跑同一决定（用例 4 断言第二次激活补投成功）；重复激活仍幂等（同一 messageId 至多一份）。
- **replay**：replay 树内真实父子的问答恢复走同一条 `reconcileStore` 路径（既有 `:1387` 用例覆盖 replay run 被恢复、问题一次投递、答案进子请求），本轮未改 replay runner，也未要求 replay driver 自身跨重启续跑（A6/S2-R）。

## 持久兼容性

本轮**未新增或修改任何持久事件类型**：变更只落在 `task-runtime/src` 的进程内恢复 handle 与 `notify` 路由，`docs/persistence-schema.json`、四个自定义 Session 事件与任务事件均未变；`pnpm run verify-persistence` 实跑通过（无需 `--write`，无新记录）。恢复的持久事实来源不变：投递/唤醒的决定每次都从 Task 持久意图现读现算，延迟动作不是第二份状态。

## 保留边界（本票不覆盖）

- 全体 worker 的通用热恢复、并发恢复泛化属 S2-R。
- replay driver 自身的实验恢复/预算续跑属 A6/S2-R；点②「入箱未 flush」仍按既有记录以移除 artifact 尾部字节模拟（真实 append-through 后端无法自造该状态）。
- 阻塞确立前已放行的同 step 在途写仍按 A3 相位语义处理（gate 的 drain 语义未改）。
- 审批渠道（`requestProposalReview` → `ProposalReviewChannel`）在恢复中重新发问后，人/渠道记录的决策若在 store 未 ready 时到达，仍会被 `assertRecoveryReady` 具名拒绝、提案保留 `pending_review`、由人重新决定或下一次激活重问——那是人/渠道自己的写入口，不是 runtime 对 live 会话的唤醒，本票未改。
- 未跑真实付费模型；未推送；未部署。

## 实跑检查（主代理串行，全部为实跑结果）

- `pnpm build`（Singularity 12 包）：通过（先于一切读产物的测试；lib 产物随源码提交）。
- `pnpm vitest run --project unit packages/singularity`：**52 文件 / 1689 测试全通过**。
- `pnpm vitest run --project integration packages/singularity`：**49 文件 / 364 测试全通过**（原 358 + 本票新增 6；含 A4-1～A4-5、a4-worker-resume、a3-recovery、cancellation-gate、root-intake-recovery、proposal-recovery 等）。
- 红绿定向：新 describe 在未修复的 `task-runtime/src/index.ts`（单文件回退，其余不动）上 **6/6 失败**，恢复修复后 6/6 通过；同文件另 9 例全程通过。
- `pnpm run verify-persistence`：OK（4 event roots 与 `docs/persistence-schema.json` 一致；未 `--write`，无新记录）。
- `agent-singularity` 的 `pnpm exec tsc --noEmit`：exit 0（无输出）。
- `git diff --check`：干净。
- 未运行：付费模型、推送、部署。已知环境噪声：`worker-contract.spec.ts` 单文件耗时较长（约 25s），与本票改动无关，随全量通过。

## 文档同步

主 guide（当前进度、当前阶段判断、§1.4 归属表、§3 后续闭环、§5.16 的「尚待收口」改为当前事实与机制一句话、§5.16 已知边界、G12、§5.11 段的相关句、首表相关行）、计划文首唯一表第 11 行（**待验收**，注明本轮收口唤醒时序）与派发段、`docs/execution-prompts/README.md` 当前项与 `progress-review-and-dispatch.md` 的派发状态、本记录。

## 下一项

第 12 项 S4-E；前置 = 本票经进度审核验收。本票未开始 S4-E/A5/A6。
