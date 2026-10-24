# RSI agent 工作合同

更新：2026-10-24（Task v27 / Review v8 / snapshot v15；仅新图）。节点 system policy 的唯一来源为 [prompts.ts](../assembly/src/prompts.ts)，本文用于人类查阅接口，不附加给 agent。本文说明现有提案、审核与报告入口。`kind=search` 是已有 read 工具的短投影；状态仅从既有 Task/Run/batch/round 事实派生，不新增状态库。解析边界以 [rsi-proposal.ts](../assembly/src/rsi-proposal.ts)、[method.ts](../assembly/src/method.ts)、[review.ts](../assembly/src/review.ts) 为准。

Singularity 的业务顺序是：root 最少委派 → Task 在自己的 workspace 生成产物 → submit 封存 → 宿主独立验收 → 父任务复用已验证产物。只读参考仓库不是共享工作区；补丁中的目标路径不是可写宿主路径；跨任务交接使用声明的 artifact inputs。RSI 在业务结束后读取这些冻结事实，提案由独立 critic 筛选、宿主跑新业务对照；报告通过与方法收益是两回事。

root 只能把子节点凭其声明输入与工具可履行的责任冻结进子合同。宿主私有检查在封存提交后执行，不是要求子 Agent 执行的命令或额外证明标准。Buckyball 公开输入只给 repository/source/policy 与不透明摘要；完整检查清单只向 verifier 挂载。必需子任务因验收或业务未达标导致父失败时保留业务原因，测评记为失败观察；实际 runtime/取消继续记为基础设施缺测。不能因一条不可执行的子标准，把候选的 workflow 失败隐藏成环境故障。

取证子任务的 protected `source` 必须从当前 contract/template 或审核 dispatch 的 `evidenceInputs` 原样复制；`name` 只决定子工作区内的路径。未知 ref 或错误 digest 在整批准入前拒绝，不留下子节点，按返回的可用来源改正后重提。准入后的方法加载、输入解析和准备失败记录为失败 Run；连 `startRun` 都被预算等约束拒绝时，所属父 Run/Review 明确失败，不能等待不存在的执行。

critic 收到的是宿主审核投影：`comparison` 首先列出实际修改字段的 before/after，`baseline` 为修改前 Method，`assets` 为修改后 Method，`changes` 为实际 diff；`edit.changes` 只保留已验证的资产键，作者字段 `value` 已应用并省略。不能按作者提交 schema 将此投影判为缺字段。proposal/report 作者模板只向 RSI 作者返回。

审核节点直接调用 `singularity_submit({findings:[{criterionId,verdict,detail,evidence}]})`。Agent 不写 `review.json`，不提交目标、身份或摘要；宿主从当前冻结 ReviewRun 生成带 `reviewId/target/subjectDigest` 的封存结果。工具 schema 与服务边界均拒绝 Agent 增写绑定字段。每项 criterion 恰好判定一次，已有 protected 非 pass 检查仍不能被改判 pass；重复提交相同判定幂等，不同判定冲突。

审核 dispatch 只附该用途的 `guidance`，并提供实际 `criteria`、`method`、文件路径和 `reads`。`kind=method` 不带 ref 即读当前固定版本；`kind=trajectory` 不带 ref 列出可以直接调用的会话与页参数。提案审核可读宿主已冻结的引用页，不能沿引用任意读取其它事件或历史；报告审核同样只读封存时可用的证据。提案和发布审核仅保留 read/glob/grep、证据读取与判定提交，工作区只读；业务验收审核保留必要的独立执行能力。

## 工作顺序

1. 每次开始、恢复或压缩后，先调用 `singularity_read({"kind":"search"})`。短结果给出 `executionPhase`、`searchOutcome`、`reportReview`、`publication`、`businessOutcome`、`next`、`pending`、剩余槽、`nextRound`、evolve `cases`、反馈摘要和 `authoring.ref` 入口。`screening/evaluating/validating/reporting` 时结束 turn，宿主负责推进；`ready` 才能提出新机制或提交报告。工具 `kind` 必填。
2. 读取 `kind=subject`，沿 `next` 字节偏移直到 `complete=true`。按需读 `trajectory` 索引，复制真实 sessionId 与 seq，再带 `eventSeq` 读事件正文；索引和摘要不能代替原生正文。`kind=method` 读当前资产，带 `from/count` 可按 UTF-8 字节分页；其中不再混入搜索状态、提案模板与完整反馈。
3. 第一次编辑前读取 `kind=search,ref=authoring` 的全部页面，其中的 `authoring.proposal/report` 提供可填写模板，同页包含 proposal/report 规则和 Method 格式。从可核查发现提出一个独立机制，保留已证成功行为，写出可观察触发条件、反例与迁移假设。允许带来源的公开领域知识和参数化程序；旧题答案、任务 ID、输出与按题分支留在证据中。
4. 填写 `search.authoring.proposal`，只在 `edit.changes` 写需要改的字段；宿主保留其它资产与冻结源码。保存 1–3 份 JSON，调用 `singularity_propose_method({"paths":["proposal.json"]})`。服从 `nextRound` 的剩余槽；不再要求触及新资产类型或停滞时强制删除。按实证选择最小充分改动，可删冗余指导，无须为了填槽新增 Skill/Tool。整批静态拒绝不冻结、不扣槽；入场后的无效、拒绝、重复或执行失败仍扣槽，`repair=0`。
5. 准入仅冻结通过预检的 bytes，立即返回 `status=screening` 和 `batchId`，不等待 critic 或测评。随后结束 turn；宿主从附件执行 critic → selftest → evaluation，并以已提交事实恢复作者。重启同样继续冻结批次，不需要模型重发 paths；改写或删除原提案文件不影响已冻结工作。待定期间模型不可新写文件、提案或交报告。
6. 恢复后重读 search；用 `kind=search,ref=feedback` 分页读取具体拒绝、审核发现和测量，用 `kind=round,ref=roundId` 检查结果。只有无待办时才按实际事实填写 `search.authoring.report`，写 report.json 后 `singularity_submit({"path":"report.json"})`。无赢家和证据不足均可如实结束，不要求搜到成功。

| 派生 phase | 事实依据 | 下一步由谁执行 |
|---|---|---|
| ready | Run working，且没有未结批次/轮次 | 作者取证、编辑、提案或报告 |
| screening | 存在未结冻结批次 | 宿主独立 critic 与 selftest |
| evaluating | 存在 pending round | 宿主冷启动业务对照与决定 |
| validating / reporting | 报告已封存，私有验证或报告验收待完成 | 宿主推进 |
| completed / failed / cancelled | 独立报告判断已结束 / 运行故障 / 取消 | 终局，不重新开放作者写入；业务与测量事实另见五项投影 |

准入、工具 schema、动态上下文和调度使用同一派生状态。三项 proposal criteria 分别检查证据与机制、完整性与隔离、保持与可执行性；筛查不能在评测前要求已测迁移，最终发布仍必须经过原有测量和独立审核。状态含义以[当前架构](architecture.md)为准。

## 分类读取与返回合同

| 调用示例 | 返回形状 |
|---|---|
| `{"kind":"search"}` | 结构化状态、五项结果、剩余槽、反馈目录与 authoring.ref；仅 RSI 作者可读。 |
| `{"kind":"search","ref":"authoring"}` | textPage；拼接完整 text 后得到提案/报告模板、格式与规则。feedback 使用相同分页形状。 |
| `{"kind":"subject"}` | subjectDigest + textPage，读取冻结 subject。 |
| `{"kind":"trajectory","ref":"<sessionId>"}` | 原生事件索引；不是事件正文或验收证明。 |
| `{"kind":"trajectory","ref":"<sessionId>","eventSeq":7}` | seq、type + textPage；引用中另有 from/count 时复用相同页范围。 |
| `{"kind":"method"}` | 业务节点的固定 Method 上下文，或审核/RSI 的 reference、assets；审核不会收到作者模板。审核/RSI 显式分页时返回 reference + textPage。 |

textPage 固定为 `{from,next,complete,totalBytes,text}`。`from/next` 是 UTF-8 字节偏移，沿 next 读取到 complete=true；列表索引的分页单位仍是条目。服务错误返回命名 refusal，不用空结果代替越权。上述形状对应 [read.ts](../assembly/src/read.ts)，无需向通用工具 Schema 增添整本说明。

## Proposal JSON

下例是字段说明模板，所有 `<...>` 和证据的 `eventSeq:null` 都必须替换。每个 `changes` 项指定资产、名字和 `value`。已有资产只写变更字段；数组字段整体替换；`value:null` 删除该资产，字段为 null 删除该可选字段。workflow 的 value 为完整新策略字符串，或 null 清空。新资产须写齐必填字段。禁止提交顶层 `method` 或模板 `initial`；冻结源码由宿主保持原字节。

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
    "trigger_condition": "<可观察的适用条件>",
    "changes": [{ "asset": "workflow", "target": "workflowGuidance", "value": "<通用workflow策略>" }],
    "predicted_affected": ["<引文所在workflow的真实taskId>"],
    "predicted_cases": ["<从cases复制的evolve caseId>"],
    "predicted_families": [],
    "regression_risk": "<不适用条件与可能退化>"
  }
}
```

提交前核对：

- 三类 finding 的 `mode` / `gap` / `habit` 全局唯一；`targets_mode` 精确引用其中一个。每条 finding 至少一个真实事件引用；未观察到成功时 `success_habits` 可为空，不能虚构。
- `eventSeq` 是原生事件 `seq`，不能用步骤号或仅有 `from/count` 的索引范围代替。`from` 是 UTF-8 字节边界，`count` 为 4–8192；复制足够正文，长证据可列多个页面。历史跨根证据须加真实 `rootId`，当前根引用也允许该字段。`predicted_affected` 是被引 workflow 内的实际 Task ID，可包含尚未启动的下游节点；不是 run、agent 或 session ID。无效时错误返回允许的 Task ID，避免盲猜。
- `changes` 中每项必须实际改变一个唯一资产；其余内容由宿主保留。Workflow target 为 `workflowGuidance`，模板为 `id`，Skill/Tool 为 `name`。上例只适用于实际仅改 workflow 的候选。
- 有 suite 时，`predicted_cases` / `predicted_families` 至少一个非空，只选当前 `cases` 中的 evolve ID；没有 suite 时两者可为空。不猜测私有 validation/heldout 内容。
- 增加 Skill/Tool 时同时说明可达的 contract/template 如何绑定；只入库并不会自动使用。
- 静态检查只校验声明。证据是否可读、约束是否满足、机制是否有用和成本是否改善，仍由入场后的宿主检查、critic 与独立测评决定。


模板改指导和绑定 Skill 的最小改动形状（仍需完整 analysis/edit 证据字段）：

```json
[
  { "asset": "template", "target": "<模板id>", "value": { "guidance": "<新的通用指导>", "skills": ["<原有及新增Skill名字>"] } },
  { "asset": "skill", "target": "<新增Skill名字>", "value": { "description": "<触发条件>", "capabilities": [], "requiredTools": [], "content": "<通用步骤与停止条件>" } }
]
```

## Report JSON

这是推荐结构，由冻结的 `improvement-reported` 标准进行独立验收；没有新增专用 report parser。从 `kind=search,ref=authoring` 页的 `authoring.report` 开始填写。`results` 引用实际 round，无 round 时用 `[]`；宿主提供冻结数值，不要求作者重复抄写或重算。区分草稿静态拒绝、已扣槽失败、已测未选中和真实发布，不把报告通过说成改进成功。

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

`results` 的有测量项只需 `{"roundId":"<真实roundId>","detail":"<机制观察及测量限制>"}`。宿主已向 reviewer 提供对应冻结结果、分数和成本，作者引用 round，不再要求复制或重算数字；自行作出的数值断言仍须准确。反复通过同一题不证明迁移。业务成本只比较新业务根、其后代及独立验收；RSI 分析、提案、审核、编排与发布费用保持分开。

报告文件先封存，再按 suite 与冻结 champion 条件触发宿主的 validation、heldout 与允许的 publication，最后进行报告验收。因此作者只能陈述提交前可见事实；最终学习终局以随后持久化的 transfer、发布指针和 search 投影为准，不能提前填写“已验证迁移”或“已发布”。

## Review 提交

Acceptance、proposal critic 与 publication 直接向 `singularity_submit` 提交相同结构的参数，对 dispatch 中每个实际 criterion 恰好给出一个 finding。目标、身份和摘要由宿主绑定，不出现在 Agent 提交中。

```json
{
  "findings": [
    {
      "criterionId": "<该次实际criterionId>",
      "verdict": "unknown",
      "detail": "<具体判断、依据与仍缺的证据>",
      "evidence": ["subject.json:contract", {"sessionId":"<可读sessionId>","eventSeq":0}]
    }
  ]
}
```

`verdict` 只能取 `pass`、`fail`、`partial`、`unknown` 中的一个，默认 `unknown` 是合法值。每条 `detail` 必须有内容，evidence 使用 subject/file 引用字符串，或 `{sessionId,eventSeq,rootId?,from?,count?}` 原生事件引用；结构化引用在提交时核对冻结范围。明确合同失败或缺少必需证明判 fail/partial，无法解决的语义判断用 unknown。诚实的非 pass 也能完成审核。无需生成审核文件。

先把 `subject` 全部分页读完。Proposal critic 使用其中冻结的实际 diff、机制与原生证据页面，不求解、不执行、不修复候选；publication 判断冻结的独立比较、资产消费和已记录成本（缺样本只作审计，不构成门禁）。只有 acceptance 可按需委派取证，且不能把保护检查的非 pass 改成 pass。输出合同不要求额外的总 verdict 或模型自行决定发布。

## 实跑核查与修复边界

- `20261019-124254`：root、repair Task 的原生 `system/message` seq7 均收到对应角色指导。repair seq8 的子合同却要求写冻结 repository；seq238 已产出补丁，seq243 已核对源码一致，seq247 尝试提权 write，seq248 等待审批直到取消。问题是父合同与只读边界冲突，审批等待让错误无法及时返回。现在角色合同明确边界，Bubble 用原生 `never` 立即拒绝提权。
- `20261019-003416`：RSI seq7 收到 improve 流程，但完整 Method 转抄损坏六个模板的冻结源码。用实际提案重放增量编辑后，静态检查通过且六份源码保持原样；这只证明格式修复，不证明机制有效或收益。
- `20261019-184556`：业务根失败；RSI 报告通过，但六槽零评测。前三槽及第六槽被“预测节点必须拥有被引用 session”的错误前置条件阻断；两个 critic 拒绝中包含评测前要求迁移证明。具体原生引用、异步状态修复和新实跑证据见 [RSI 修复取证](rsi-repair-evidence.md)。
- 报告审核可读封存的当前业务轨迹、本 search 提交前的 evolve 测量，以及本 search 已筛选提案中实际引用的封存证据页。历史证据只开放已引用页及页内分页；其它 search、私有 split、未引用页面和后续事件不扩权。修复后 letters 已实际走通两轮测评、发布、恢复和最终报告验收；这不代替完整领域 pilot 与迁移验证，边界见取证文档。
