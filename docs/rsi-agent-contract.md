# RSI agent 工作合同

更新：2026-10-19。本文说明现有提案、审核与报告入口，不新增工具、报告解析器或候选状态机。解析边界以 [rsi-proposal.ts](../assembly/src/rsi-proposal.ts)、[method.ts](../assembly/src/method.ts)、[review.ts](../assembly/src/review.ts) 为准。

## 工作顺序

1. 每次开始、恢复或上下文压缩后，先调用 `singularity_read({"kind":"method"})`，不带旧 `ref`。读取当前 `reference`、`nextRound`、`feedback`、`cases`、`proposal.drafts`、`proposal.template` 和 `reportTemplate`。宿主为工作中的 RSI 作者在当前 workspace 生成至多三份完整提案草稿，`proposal.drafts` 返回 `{path,created}`；已有文件不覆盖，`created=false` 时先查看文件中的已做修改。`proposal.template` 是当前完整内容参考，不要求 Agent 重抄。工具的 `kind` 必填，不能只传 `ref/eventSeq`。
2. 用 `singularity_read({"kind":"subject"})` 读取冻结任务，沿返回的 `next` 字节偏移直到 `complete=true`。按需读取 `trajectory` 索引，复制真实 `sessionId` 与索引条目的 `seq`，再带 `eventSeq` 读取对应事件正文；正文同样按字节分页。摘要是线索，不代替原始证据。
3. 从可核查发现提出一个独立机制。保留有证据的成功行为，写出可观察触发条件、反例和迁移假设。一个机制可有相互依赖的多处改动；允许有来源的公开领域接口、常量、工具路径和参数化方法，不把旧题答案、任务 ID、输出或按题分支写入 Method。
4. 选择 `proposal.drafts[].path`，用原生 `edit` 填写 `analysis`、`edit` 元数据，并仅改必要的 Method 字段；禁止用 `write` 整份重写或手工重抄完整资产。保留完整资产，根模板的 `inputs/artifact/criteria/checks` 冻结。Method 的所有模板都不得出现 `initial`：真实初始源码由宿主从冻结 Task/Case 的同 ID 模板提供，不重抄、不修补 seed。选好 1–3 份完成的草稿后，调用 `singularity_propose_method({"paths":["<草稿实际path>"]})`，服从 `nextRound` 的剩余槽、探索槽与 prune 要求。
5. 返回真实 `roundId` 且结果待定时结束当前 turn，等待宿主恢复，不轮询或自行执行业务实验。恢复后重读当前 Method 与反馈。没有批次或评估待定时，按实际事实写 `report.json`，再调用 `singularity_submit({"path":"report.json"})`。没有改进和证据不足都可如实结束。

先处理 `proposal.pending`：`kind=batch` 时按其中的原 `paths` 恢复提交，宿主使用已冻结字节，不编辑或替换该批；`kind=evaluation` 时结束 turn 等待宿主反馈。这两种情况都不生成新草稿。

草稿路径相对当前 workspace，形式为 `proposal-<method revisionId>-<已接纳批次数+1>-<slot>.json`；Method 或已接纳批次变化后使用新路径，静态拒绝后继续原地 `edit`。全批静态拒绝不冻结、不扣槽，按返回的具体字段和修复提示修正；不要删除冻结的根契约字段或未改资产绕过错误。若错误指出 `initial`，删除这个不属于 Method 的字段。零扣槽只说明没有候选入场，不表示已完成实验，也不表示宿主死锁。入场后的证据无效、拒绝、重复或执行失败仍扣槽，`repair=0`。

## Proposal JSON

下例只说明 `analysis/edit/method` 三段格式，所有 `<...>` 和 `eventSeq:null` 都必须替换。实际从宿主已落盘的完整草稿编辑，**不要复制下例重新造文件，也不要照抄空数组删除资产**。数组留空表示真实删除，必须在 `changes` 声明并接受审核。`method` 始终包含完整资产，保留未修改的策略段落、模板、Skill 和 Tool；不另设 patch 格式。

```json
{
  "analysis": {
    "failure_modes": [
      {
        "mode": "<稳定且唯一的机制名>",
        "description": "<观察到的通用失效机制>",
        "needed_instead": "<需要的行为>",
        "evidence": [{ "sessionId": "<真实sessionId>", "eventSeq": null, "from": 0, "count": 8192 }]
      }
    ],
    "capability_gaps": [],
    "success_habits": []
  },
  "edit": {
    "hypothesis": "<可被证据反驳的机制假设>",
    "targets_mode": "<上面同一个机制名>",
    "why_not_lower_lever": "<为何这一改动层级足够或必要>",
    "trigger_condition": "<可观察的适用条件>",
    "changes": [{ "asset": "workflow", "target": "workflowGuidance" }],
    "predicted_affected": ["<引文session对应的真实taskId>"],
    "predicted_cases": ["<从cases复制的evolve caseId>"],
    "predicted_families": [],
    "retroactive_check": {
      "corrective": "<如何改变已观察失败>",
      "preservative": "<为何已成功行为得以保留>",
      "transfer": "<为何可用于同域陌生任务，尚非已测结论>"
    },
    "regression_risk": "<不适用条件与可能退化>"
  },
  "method": {
    "workflowGuidance": "<基于完整基线修改的通用workflow策略>",
    "templates": [],
    "skills": [],
    "tools": []
  }
}
```

提交前核对：

- 三类 finding 的 `mode` / `gap` / `habit` 全局唯一；`targets_mode` 精确引用其中一个。每条 finding 至少一个真实事件引用；未观察到成功时 `success_habits` 可为空，不能虚构。
- `eventSeq` 是原生事件 `seq`，不能用步骤号或仅有 `from/count` 的索引范围代替。`from` 是 UTF-8 字节边界，`count` 为 4–8192；复制足够正文，长证据可列多个页面。历史跨根证据须加真实 `rootId`，当前根引用也允许该字段。`predicted_affected` 是被引 session 对应的 Task ID，不是 run、agent 或 session ID。
- `changes` 与完整基线的实际差异完全一致，每个变化资产仅声明一次。Workflow target 为 `workflowGuidance`，模板为 `id`，Skill/Tool 为 `name`。上例只适用于实际仅改 workflow 的候选。
- 根模板的冻结字段不是提案改进对象。修改 workflow、Skill 或 Tool 时，原生 `edit` 应只匹配对应字段，不能连带重写根契约。`method.templates[*].initial` 不属于 Method，出现即拒绝；宿主持有真实源码字节，不要求 Agent 复制 `+`、转义或末尾换行。不接纳携带旧 `initial` 的 Method 格式。
- 有 suite 时，`predicted_cases` / `predicted_families` 至少一个非空，只选当前 `cases` 中的 evolve ID；没有 suite 时两者可为空。不猜测私有 validation/heldout 内容。
- 静态检查只校验声明。证据是否可读、约束是否满足、机制是否有用和成本是否改善，仍由入场后的宿主检查、critic 与独立测评决定。

## Report JSON

这是推荐结构，由冻结的 `improvement-reported` 标准进行独立验收；没有新增专用 report parser。从运行时 `reportTemplate` 开始填写。`results` 只记实际 round 事实与可核查数字，无 round 时用 `[]`，未测数字用 `null`；区分草稿静态拒绝、已扣槽失败、已测未选中和真实发布，不把报告通过说成改进成功。提交次数、文件数与各类拒绝次数必须按实际工具记录逐项核对；一次调用可含多个文件，不能靠印象估计，也不能把不同拒绝写成同一错误。

```json
{
  "summary": "<截至提交前的实际结论>",
  "evidence": [{ "sessionId": "<真实sessionId>", "eventSeq": null }],
  "changes": ["<实际尝试的机制与对应资产，未尝试则空数组>"],
  "results": [],
  "preserved_behavior": ["<有证据支持的保留行为，未知则说明>"],
  "limitations": ["<缺失观察、未测数字、采样噪声与归因限制>"],
  "transfer": {
    "status": "not-tested-before-submission",
    "detail": "报告先封存，随后由宿主按条件执行独立validation和publication审核；此处不预报结果。"
  }
}
```

`results` 的有测量项可写为 `{"roundId":"<真实roundId>","outcome":"<已提交的实际结果>","qualityDelta":null,"costRatio":null,"detail":"<具体观察及测量限制>"}`；数字只能来自对应测评事实，必要时说明度量方向与单位。反复通过同一题不证明迁移。业务成本只比较新业务根、其后代及独立验收；RSI 分析、提案、审核、编排与发布费用保持分开。

报告文件先封存，再按 suite 与冻结 champion 条件触发宿主的 validation、heldout 与允许的 publication，最后进行报告验收。因此作者只能陈述提交前可见事实；最终学习终局以随后持久化的 transfer、发布指针和 search 投影为准，不能提前填写“已验证迁移”或“已发布”。

## Review JSON

Acceptance、proposal critic 与 publication 使用同一输出形状。复制该次 dispatch 给出的真实 `subjectDigest`，对每个实际 criterion 恰好写一个 finding；proposal 当前有六项，publication 当前为 `publication-approved`，acceptance 按任务冻结标准。不要从另一种审核复制固定清单。

```json
{
  "subjectDigest": "<dispatch中的真实subjectDigest>",
  "findings": [
    {
      "criterionId": "<该次实际criterionId>",
      "verdict": "unknown",
      "detail": "<具体判断、依据与仍缺的证据>",
      "evidence": ["<subject.json中的具体位置或可读证据引用>"]
    }
  ]
}
```

`verdict` 只能取 `pass`、`fail`、`partial`、`unknown` 中的一个，模板默认 `unknown` 是合法值。每条 `detail` 必须有内容，evidence 使用真实引用字符串。写 `review.json` 后调用 `singularity_submit({"path":"review.json"})`；诚实的 fail/unknown 也能完成审核。

先把 `subject` 全部分页读完。Proposal critic 使用其中冻结的实际 diff、机制与原生证据页面，不求解、不执行、不修复候选；publication 判断冻结的独立比较、资产消费和完整成本。只有 acceptance 可按需委派取证，且不能把保护检查的非 pass 改成 pass。输出合同不要求额外的总 verdict 或模型自行决定发布。
