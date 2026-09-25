# 第 11 项 A4（父子澄清）执行与验收记录

| 字段 | 填写内容 |
|---|---|
| 状态、最近更新日期 | **待验收**（交付方最高可填状态），2026-09-25 |
| 执行 agent / 任务链接 | 实现主代理 + 6 个串行子代理（①task 事实 / ②agent-runtime 投递 / ③a task-runtime / ③b context / ③c 工具与回路 / replay 工作区修复）+ 3 个独立复核代理 + 1 个收敛修复代理；[A4 派发 prompt](../execution-prompts/11-a4-parent-child-clarification.md)、[计划 F.1](../2026-09-20-vrtc-code-change-plan.md) |
| 开始日期 / 验收日期 | 2026-09-25 / 待进度审核 |
| 前置验收记录 | 第 9 项 A2+A1 已验收（[进度审核](2026-09-25-a2-a1-progress-review.md)）；施工时实际 HEAD 已前进：Singularity `bf686f4`（验收时为 `2ec39d1`）、外层 `4714cb2`（验收时为 `aa23e6c`），两仓无 AGENTS.md，Singularity 工作树干净，DSH 子模块 gitlink 与钉版 `0d1f500` 一致 |
| 修改前基线 | Singularity `bf686f4` / 外层 `4714cb2` |
| 交付版本 | Singularity `829718e`（7 条提交：`84baa2e`→`03ddfa3`→`b010e47`→`bc73995`→`5695556`→`d8e2d12`→`829718e`）/ 外层子模块指针提交见本记录末节 |
| 派发前五问审核 | 主代理派 5 路 explore 探查后按「作用→必要→DSH→开源→KISS」逐件裁决：**原计划全件保留、不删件不扩 scope**，并带 7 项实现级修正（DSH pending inbox 按 messageId 去重的纠偏、freezeMessage 自建消息零 DSH 改动、闸不加相位机制、旧字段保留声明停止写入、root 补动态平面、A4-5 精确靶点两处、agent-team mailbox 只作算法范本）。开源检索确认无可照抄实现（上游故意不做子代理阻塞提问） |

## 验收项对应（验收编号 → 实现入口 → 测试位置与结果）

**A4-1（父子/三层问答无死锁、实际模型请求可见、三账一致）**
→ 工具 `agent-singularity/src/tools/task-ask-parent.ts`、`task-answer.ts`；编排 `task-runtime/src/question.ts:484,526`；投递 `agent-runtime/src/messages.ts:292`；呈现 `context/src/projections.ts:720`（`singularity:questions` context，worker 与 root 均接线）
→ `tests/integration/a4-question-loop.spec.ts`（3 例：二层问答双方实际请求可见、non-blocking 全程放行、三层转问孙→中→root→中→孙逐级无死锁；每处断言 Task 记录身份 = DSH `user/message` messageId 与 `agent-message/relay` 来源 = 闸结果；连跑 5 次稳定）。通过。

**A4-2（乱序作答/非阻塞/resolves:false/拒绝面/零副作用/replay）**
→ `tests/integration/a4-question-coordination.spec.ts`（12 例：双阻塞乱序只解各自、`blocking:false` 不阻塞、同 key 同内容返回原记录且 `already-present` 恰好一条、伪造 callId/他 Session/篡改 requestKey/blocking/questionId/resolves/ask 冒充 answer 全具名拒绝零副作用、parentless replay ask 具名拒绝零副作用、阻塞等待到点按根截止取消、无 Run 绑定具名拒绝、被问方终态释放问方闸）；`task/tests/unit/questions.spec.ts`（61 例：reducer/幂等/拒绝表/重开/旧字段）；`tests/integration/a4-question-loop.spec.ts`（waiting_children 全程无写权）。replay 真实父子正例见下「跨入口/组合反例」。通过。

**A4-3（四崩溃点/两种相位/普通与 replay）**
→ `tests/integration/a4-question-delivery.spec.ts`（13 例：意图已持久未投递 / 入箱未 flush / 入箱已 flush / claim 后未请求模型，均真 JSONL 同目录重开、冷字节读回「恰好一份、同一 messageId」；重复 ensure 第二次 `already-present`；来源不可读三类具名失败；unavailable 零字节变化）；`tests/integration/a4-question-recovery.spec.ts`（7 例：active 与 waiting_children 问答等待 run 恢复不取消、补投递、闸重建、无问答在途 run 仍取消的反例、迟到 answer 不复活、补投失败告警）。未覆盖：answer 侧跨重启补投仅单测分类覆盖（与 question 共用同一 ensure 路径）；四崩溃点无 replay 版本。通过（未覆盖项如实保留）。

**A4-4（父离线恢复/截止取消/来源具名失败/正文只在 Session/来源非 human/零新 Graph 边/旧字段）**
→ 父离线：`a4-question-recovery.spec.ts`（恢复重启后补投送达）；根截止取消：`a4-question-coordination.spec.ts:491-551`；来源不可读：`a4-question-delivery.spec.ts`（`source-event-missing`/`source-not-tool-call`/`source-not-durable`）；伪造引用落库前拒绝：`a4-question-coordination.spec.ts:422-439`；正文只在发送/收件 Session（Task 只存 ref+digest，digest 绑定断言「records the cited bytes themselves」）；来源非 human：`a4-question-loop.spec.ts` 多处断言 `source={kind:'agent-message',form:'relay',senderSessionId}`；零新 Graph 边：本票 diff 不触 graph/graphs 包；旧字段：`task/tests/unit/questions.spec.ts`（旧含 question-id 字段事件回放可读、`changeRunPhaseIn` 对新写入具名拒绝、新事件不含这两字段）。通过。

**A4-5（结算唯一所有者）**
→ 收敛前 `task-runtime/src/index.ts:4573-4611` 与 `:5186-5211` 两处内联终态（子 blocked + 父 markRunStatusIn + 内联 recordReviewIn）；收敛后均调 `orchestrate.ts` 的 `blockUnstartedChildren` + `settleRunFromRuntime`（env-less 路径经窄 `RuntimeSettlementEnv`）。证据：`grep markRunStatusIn|recordReviewIn task-runtime/src/index.ts` = 0；普通（submitResult/批次子/父自动提交）、replay（criteria/spawning）、取消恢复（6 个 settleRunFromRuntime 调用点）均经同一所有者；独立复核 C 逐链核对成立。范围外保留：`orchestrate.ts` replay 异常分支约 6 处内联终态序列（同一所有者内，归后续票，见「未解决缺陷/遗留」）。通过。

## 实际检查（主代理整票集成后实跑，构建与测试串行）

- `pnpm build`（Singularity 工作区，12 包）：通过，各包 lib 产物入库。
- `pnpm vitest run --project unit packages/singularity`：**51 文件 / 1662 测试全通过**。
- `pnpm vitest run --project integration packages/singularity`：**47 文件 / 340 测试全通过**。
- `pnpm run verify-persistence`：OK（4 个事件根与 `docs/persistence-schema.json` 一致）。
- `git diff --check`：干净。
- `pnpm exec tsc --noEmit`（agent-singularity）：**0 错误**（基线不回升）。task-runtime/agent-runtime 的既有基线错误（10/2 条）逐条比对无新增。
- 未运行项：真实付费模型实验（本票不授权）、推送/部署（禁止）。

## 跨入口/组合反例（先红后绿的关键反例）

- **重复投递反例**（②）：临时令重试 fold 失效 → 同一 messageId 两次投递产生两条 `user/message`（history:2）；修复后第二次 `already-present`、冷读恰好 1 条。
- **replay×工作区前置缺陷**（③a 发现、`d8e2d12` 修复）：spawning replay 内 worker 经 shipped `task_decompose` 分解被 `WorkspaceBusyError` 拒绝（`claimReplayWorkspace` 的层无 taskId，祖先走查对 parentless replay 无解）。修复：层写入 replay task 的 taskId（`task-runtime/src/index.ts:5739`）。修复前两处独立复现失败，修复后 `tests/integration/a4-question-coordination.spec.ts`「carries a question from the child the replay really decomposed, through the shipped tools」走通「真实分解→子问 replay→replay 答」全工具路径；`tests/integration/a3-workspace.spec.ts` 层身份用例同步。这使 F.1「replay 中真实 Task 父子为正例」有真实生产路径支撑。
- **闸缓存失配**（复核 C-D1、`829718e` 修复）：被问方终态而问方仍 running 时 `blockingQuestionsOf` 已空但闸 flag 不刷新，问方被永久拒写。修复前定向用例红（`questionsBlocked(child)===true` 与派生为空矛盾），修复后 `releaseAskingSessions` 作为第四个重算时刻挂在 `settleRunFromRuntime`（await）与 `onRunSettled` 钩子，问方恢复写/提交权。
- **阻塞 idle 免无进展**：`noProgressRounds:1` 下阻塞 idle worker 不被 `RunProgressMarked`、最终只被 wallTime 停（删掉 `orchestrate.ts:1325-1329` 豁免则该例红）。

## 既有复杂度处置（本票触及的 400 行以上文件）

- `task/src/types.ts`（1256）、`task/src/service/state.ts`（1841）、`task/src/index.ts`（829）：**原地扩展**——task 是问答事实唯一所有者，按 A3 先例接线；领域逻辑独立成新模块 `task/src/question.ts`（302 行），不拆分这三文件。
- `task-runtime/src/index.ts`（约 6.3k）：**只收敛本票触及的两处内联终态**（A4-5），新增限于装配/入口/只读派生调用；不顺手拆全部（F.1/E 节明文）。`task-runtime/src/orchestrate.ts`（约 2.6k）：结算单一所有者保持 `settleSubmittedRun`/`settleRunFromRuntime`；replay 异常分支内联终态归后续票。
- 新增模块 `agent-runtime/src/messages.ts`（449 行，投递/对账唯一主体）、`task-runtime/src/question.ts`（编排唯一主体）；context 的 `projections.ts`/`assembly.ts`/`render.ts` 原地扩展（投影同层惯例）。
- 无迁出承诺未清：本票无声明迁出后保留双轨的职责；旧 `pendingQuestionIds/blockingQuestionIds` 声明保留（旧事件可读）、新写入停止（同一持久版本决策，记录见下）。

## 持久化变更

`docs/persistence-changes/2026-09-25-a4-questions.md` + `.schema.json`：新事件 `QuestionAsked`/`QuestionAnswered`（`TaskEventPayloads` 新成员，声明级指纹不变）；`TaskSnapshot.questions`「可选但本 build 恒有」（`proposals?` 先例）；决策 `same-version`；旧空 question-id 字段保留声明仅停止新写入（删属性会触发 version-bump，与「旧空字段可读」冲突）。`verify-persistence` 通过。

## 独立复核

三组并行（各只领一个风险组，被审 SHA `d8e2d12`，均实际读码并实跑定向测试）：

| 风险组 | 结论 | 缺陷与处置 |
|---|---|---|
| 来源/权限 | 满足 F.1；无模型可达绕过入口 | 3 个测试缺口（无 Run ask、resolves 篡改、digest 绑定）→ `829718e` 补齐并验证变异会红 |
| 投递/重启 | 固定顺序与四崩溃点「恰好一份」成立 | 1 项待票主判定（重启后非根父不复活）→ 主代理裁决：合规、记已知限制（见下）；3 建议中「补投失败无告警」→ `829718e` 修复（`reportUnsettledQuestionDeliveries`），余 2 项记录 |
| 阻塞写闸/结算 | 满足 F.1/A4-2/A4-5 | D1 闸缓存失配（应修）→ `829718e` 修复有红绿证据；D2 阻塞确立不 drain 在途（与 A3 在途语义一致）记录；D3 两例测试缺口 → `829718e` 补齐；D4 orchestrate replay 分支内联终态归后续票 |

收敛修复 `829718e` 后全量 unit/integration 重跑通过；三路复核均确认无阻断验收级缺陷。

## 文档同步

主 guide（当前进度、§1.4 归属表、§3 方向决定、§4.1 复核表、G12、新增 §5.16）、计划文首唯一表第 11 行（待验收）与派发段、agent-prompt-contracts（A4 段落启用状态）、`docs/execution-prompts/README.md` 当前项、本记录。历史快照未改。

## 模拟与未覆盖范围

scripted provider 只替代模型输出；Task store、DSH inbox/Session、执行闸、工具瀑布、context 装配、JSONL persistence 均为真实件。未覆盖：①answer 侧跨重启补投的集成级「恰好一份」（单测分类覆盖，与 question 共用同一 ensure/fold 路径）；②四崩溃点的 replay 版本（replay 问答正例为进程内用例 + 真实分解一例）；③真实模型效果实验（不属本票授权）；④R1 式场景不重复（协议层证据不声称提高成功率）。

## 未解决缺陷 / 已知限制（核实后如实记录，无阻断项）

1. **重启后非根父不复活**：三层转问的中间层（waiting_children worker）在进程重启后不会被拉回 live，该跳投递 `unavailable`、意图保留、激活入口重试；被收养的问答等待 run 的等待无独立 deadline watcher。依据：A3 已把 worker 会话续跑划给 S2-R（`docs/2026-09-22-a3-coordination-design.md:201`），F.1 本票字面为「暂不可达记 unavailable，保留意图，恢复入口重试；不自动造替代父」——按合同判合规；解除条件：S2-R（第 14 项）。
2. **阻塞确立不 drain 同 step 已放行的在途写**：与 A3 相位语义一致（先放行即在途、下一 barrier 收敛）；F.1 未要求 ask 处 drain。
3. **store 层 reducer 不拒未知键**（`commitIn` 原始事件门为既有设计）；生产写入仅 `task-runtime` 编排入口逐字段重建，伪造事实的投递会被正文重读校验具名拒绝。
4. **`orchestrate.ts` replay 异常分支约 6 处内联终态序列**：同一所有者内、index.ts 已清零，不违 A4-5；触发票：S4-E/A5 结算路径整理。
5. **恢复 pass 的问答分支只看 `blockingQuestionsOf`**：非根 active 父「被问未答」在现网不可达（父收到问题必先已分解→waiting_children），防御性记录。
6. **DSH 复用核查文档纠偏**：[2026-09-25-dsh-reuse-audit.md](2026-09-25-dsh-reuse-audit.md) 称「DSH 不按 messageId 去重」——实际 pending inbox 按 message.id 去重（重复抛 `already pending`，`dsh-agent-loop/inbox.ts:221-228`），仅已 claim/已进 history 不去重；本票已把该抛错用作幂等命中信号，历史文档保留原样。
7. agent-runtime/task-runtime 的 `tsc --noEmit` 既有基线错误（2/10 条）不变，与上一票相同。

## 最终验收结论

交付方结论：**待验收**（A4-1～A4-5 定向证据与公共检查齐，状态上限按合同留给进度审核）。

## 下一项

唯一顺序第 12 项 S4-E；前置 = 本票经进度审核验收。本票不开始 S4-E/A5/A6。
