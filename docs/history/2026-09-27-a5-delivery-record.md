# A5 + S2-E 交付与验收记录（失败自动、成功按需，共用诊断链）

| 字段 | 内容 |
|---|---|
| 状态、最近更新日期 | **待验收**；2026-09-27 交付 |
| 执行 agent / 任务链接 | 实现主代理 + 串行子代理①②③④ + 独立审核子代理 ×1（两轮）+ 公共检查子代理；合同 [A5 prompt](../execution-prompts/13-a5-s2-e-diagnosis.md) 与计划 F.3 |
| 前置验收记录 | K1～K4 已验收；K4 最终审核 [2026-09-27-k4-review.md](2026-09-27-k4-review.md)，消费其 `admitReviewAgent`/有效预算接口，未重建额度机制 |
| 修改前基线 | Singularity `c7e0658`；外层 `bd94b53`；两树干净（外层 `thirdparty/deepseek-harness` 未跟踪项未动） |
| 交付版本 | Singularity 实现提交 `f1a6771`（代码+测试+lib+persistence 记录）；文档同步与本记录随其后文档提交；外层子模块指针提交见外层 log |
| 实际检查 | 见下文「最终公共检查」节 |
| 未解决缺陷 / 阻塞 | 见「未闭合项」节；无阻断缺陷 |
| 最终验收结论 | 实现方自评待验收；REV-1～REV-5 独立审核 PASS（含一项 FAIL 同票返工闭合） |
| 下一项 | A6（第 14 项）；前置＝本票外部验收 |

## REV-1～REV-5：入口 → 外部结果 → 拒绝副作用 → 定向红绿

- **REV-1**（失败自动/成功零自动/显式与终态根会话同链/根过期可受理/reviewer 额度耗尽拒绝）：入口＝终态提交 `task-runtime/src/orchestrate.ts:1101` fire-and-forget → `agent-singularity/src/review-agent-scan.ts:scanFailedReviewSources`（另 `graphs/selected` 激活扫描）与显式 `tools/review-agent.ts` → 唯一实现 `review-agent-run.ts`。外部结果：`tests/integration/a5-failure-auto-trigger.spec.ts:571`（模型零响应时 Gap/Review 可读且自动受理）、`k4-review-after-deadline.spec.ts:321`（deadline 停树后自动受理）、`:186`（终态根会话经真 gate 调用）。拒绝副作用：成功源零 spawn（`a5:231`）；额度耗尽具名未启动零 claim/spawn 旧计数保留（`review-agent-attempts.spec.ts:421`、`k4-review-ledger-restart:109`）。红绿：红 `failedSourcesOf` 禁用后 `expected [] to have length 1`；绿后 15/15。
- **REV-2**（首请求含源 outcome/关注点/可自主取证；跨 graph/错 run/缺 Review 零 claim/spawn；成功源不造假失败）：入口＝`review-agent-run.ts` 首请求组装 + `tools/review-agent.ts:229-239` 源校验（claim 前）。外部结果：`a5:849`（reviewer 经真 context_read 读兄弟/证据/历史）、`a5:294`（verified 源真实观察、`proposals:[]`、无 judgements）。拒绝副作用：错 run/未知任务/无 Review 时 `ledgerText()===''` 且 spawn 未调（`review-agent-attempts.spec.ts:235`）。
- **REV-3**（去重/新键/同键冲突/崩溃恢复/不造假 Diagnosis）：入口＝ledger v2（claim/started/settled）+ `admitReviewAgent` 区内 plan→claim→spawn。外部结果：`a5:639`（在途竞争仅 1 claim/1 session/1 spawn）、`k4-review-ledger-restart:123`（真第二进程：started 孤儿记 interrupted、新键受理、计数不退款）、`review-agent.spec.ts:930`（settle 窗口内不提前受理新键、恰一条终结行）。拒绝副作用：同键异内容具名拒绝零写、超时/坏输出 settle interrupted 零伪造 Diagnosis（`k4-review-after-deadline:273` store diagnoses 逐字不变）。
- **REV-4**（开放 targetType/pending 三态/成功源不变）：入口＝`task/src/types.ts` targetType 非空 string、`tools/task-review-pack.ts:handoffMark`、`tools/evolution-propose.ts:96`。外部结果：`task-service.spec.ts:521`（未知 targetType 重开读回）、`evolution.spec.ts:552`（fromDiagnosis 不支持目标具名拒绝、ledger 零写）、`a5:294`（成功源 tasks/runs/reviews 逐字节相等）。红绿：13+2 例红（九类白名单拒绝/伪造诊断/pending 缺失）→ 全绿。
- **REV-5**（唯一终态写入/reviewer 失败不阻止结算/无第二扫描）：全仓唯一 `recordReviewIn` 生产调用点 `orchestrate.ts:1080`；`notifyTerminalReview` 不 await（`task-runtime/src/index.ts:2829-2864`）；`a5:392/412`（reviewer 挂起/ledger 不可写时结算照常）；grep 证据：reviewer 取证面无 sessionQuery 直扫。持久化：[a5-diagnosis-open-target](../persistence-changes/2026-09-27-a5-diagnosis-open-target.md)（version-bump，顶层指纹未动、兼容性推理与回滚限制已写明）。

## 删除清单（符号 → 位置 → 依据）

latestReview 选源与 latest 别名（`tools/review-agent.ts`、`tools/task-review-pack.ts`，被精确源取代）；`computeEscalation`/`Escalation`/`EscalationBudget`/`EscalationReason`/`ESCALATION_REASONS`/review 版 `renderEscalation`/`capabilityGap`（`tools/review-escalation.ts`，准入不再需要阈值分类；保留 `REVIEW_AGENT_BUDGET_DEFAULT` 与 `renderJudgementDimensions`）；pack escalation 行与 `ReviewPackInput.escalation`；reducer 九类白名单（`task/src/service/state.ts`）与 `task-diagnose.ts` 的 TARGET_TYPES/isProposalTargetType/schema enum（targetType 开放）；`normalizeJudgements` 导出、`renderCause`、缺项填 unknown/空 refs 降级 unknown 两条伪造路径、`recorded` 的 timedOut/timeoutMs（`review-agent-run.ts`）；reviewer prompt 的 pack-only 限制与强制六维；`repairSettlement`（返工后由 ledger 自写终结事实取代）。escalation.ts（L4 人工台账）消费者仍在，未删。

## 独立审核（只读验收段+diff+证据，主动构造反例）

- 第一轮：REV-1/2/4/5 PASS；**REV-3 FAIL**——实测反例：claim+started 落账后进程死亡，源永久钉在 in-flight，新 requestKey 也无法再复盘（违反 F.3「崩溃后只恢复同一 session 或记 interrupted」）。同票返工（live 登记+区内恢复写+幂等 start）。
- 复审：FAIL 闭合 PASS——等价探针 P1–P6（孤儿新键受理 spawn、默认键读回 interrupted、计数不退款、真在途不误杀、start 幂等、扫描具名恢复）；556+29 定向用例全绿。另实测复现（3/3）settle 窗口竞态 O1 → 收紧（live 标记移到终结行落账后清除，finally 兜底）→ 第三轮核对 PASS（窗口内答 in-flight、零重复终结行；红：修复前 spawn 2 次）。
- 非阻断：O2（recorded/interrupted 标签反转窗口，静态可能、实测未复现，O1 修复后收窄，仅显示层）；README/render 陈旧文案已在交付前修掉。

## 最终公共检查（最终树，各一次）

`pnpm build` exit 0；unit **65 文件/2020 通过**；integration **64 文件/523 通过+2 门控跳过**，1 失败＝`proposal-review.spec.ts` 既有时序 flake（waitFor 窗口内 batchId 未落盘；单独复跑该 spec 15/15 绿，与 A5 无关，②④均曾观察）；`verify-persistence` 4 roots OK；`agent-singularity` `tsc --noEmit` exit 0；两仓 `git diff --check` 干净。

## 既有复杂度处置

触及的 400 行以上文件：`review-agent-ledger.ts` 247→716（行种类/尝试派生/决策/恢复，唯一写入口不变，无转发层）；`review-agent.ts` 343→264（执行体抽入 `review-agent-run.ts`，工具只剩校验/渲染）；新增 `review-agent-run.ts`（564，一条尝试唯一实现）与 `review-agent-scan.ts`（307，自动触发器）——按职责分家，不为降行数造转发层；`orchestrate.ts` 3458→3502 与 `task-runtime/src/index.ts` ~8104（只加 TerminalReviewFact/监听门，结算职责未动）；`state.ts` 2205（删 11 行白名单）；`types.ts` 1404（单字段+文档）。无第二事实源、无共享可变内部状态。

## 未闭合项（诚实列出）

replay driver 根自身跨重启续跑属 A6/S2-R（本票未触碰）；O2 残余窗口见上；`proposal-review.spec.ts` 时序 flake 未修（既有，建议后续票加宽 waitFor）；`countReviewAgentRuns` 现仅测试消费（K4 交付的展示查询，保留）；liveAttempts 是进程内事实，单 writer 前提不变（多进程共用 ledger home 不在本票）。
