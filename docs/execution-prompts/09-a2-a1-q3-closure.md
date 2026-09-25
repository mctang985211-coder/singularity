# 第 9 项 A2+A1：Q3 单事件续读收尾

你是 Singularity 第 9 项的返工实现主代理。工作区为 `/home/ROXY/code/bb_work/harness/packages/singularity`，外层仓库为 `/home/ROXY/code/bb_work/harness`。只完成本票遗留的 Q3 大事件续读及整组回归；**第 9 项仍未验收，不开始 A4**。

本票读取上限以[唯一计划 D 节](../2026-09-20-vrtc-code-change-plan.md)的 2026-09-25 追加裁决为准：单次完整输出最多 50000 字节，字节窗口与省略措辞复用 `@deepseek-ai/dsh-output-retention`；旧复审记录中的 16 KiB 是当时实现事实。

先读[公共执行合同](README.md)、[唯一计划 D/E 节](../2026-09-20-vrtc-code-change-plan.md)、[复审记录](../history/2026-09-25-a2-a1-progress-review.md)和[返工记录](../history/2026-09-25-a2-a1-rework-record.md)的 Q3 部分。核对两仓状态与 AGENTS.md，按公共合同在修改前建立 Git 基线。`4115a85` 是上次复审的被审代码，不代替施工时的实际 HEAD；其 Q1/Q2/Q4 和 Q3 中途读失败的已通过反例应保留。

## 固定交付

同一个 `context_read({kind,ref,offset?,limit?})` 保持四参数：

1. `kind:"session", ref:"<sessionId>"` 仍按事件 seq/条数分页。事件放不下时页面停在该 seq，文本给出精确的 `ref:{sessionId,seq}` 续读方式；不把 `nextOffset` 推过未展示的事件，不建议把跳过事件当成取得正文。短事件和列表正常页沿旧语义工作。
2. `kind:"session", ref:{sessionId,seq}` 精确读取一个事件。`offset` 默认为 0，`limit` 为该事件**可见正文**的 UTF-8 字节页量；正文定义为现有 `extractSessionEventText(event)` 的结果，不重新规定原始 Session JSON 的显示格式。用 DSH `sessionQuery.readEvent({sessionId,seq,before:0,after:0})` 取源并核对目标 seq。正文只在这一条路径内按字节分页，不建索引、缓存、持久游标或第五参数。
3. 每页先从 live caller 解析 graph 并核对目标 Session 是该 graph 已发布成员，然后才能读 DSH。跨图、未知成员、成员读取失败、缺失事件或源读取失败均具名返回，不能泄露正文。单事件 seq/offset 必须是非负安全整数、limit 是正安全整数；显式 limit 钳在 4～50000 字节，缺省用上限。非法引用/数值具名拒绝且不读 DSH。非空正文的 offset 在 UTF-8 字符中间或大于等于字节长度时具名 `stale-reference`；空正文只接受 offset 0 的终页。
4. 单事件**成功页**的模型可见文本是含 `sessionId,seq,offset,nextOffset,hasMore,body` 的 JSON 对象；`body` 是原文片段，不含页眉。返回 `ProjectedRead` 的续读字段与可见 JSON 一致。按 `nextOffset` 连续取页并拼接各页 `body` 必须逐字符还原正文，尾页说明可返回列表 `offset=seq+1`。每页整个 JSON 经转义后仍不超过 50000 字节；极端转义密度也不能破界或停在原 offset。字节窗口、UTF-8 边界和省略措辞调用 DSH 现有库，不在 context 复制算法；游标与按行预算仍由 context 负责。

主要落点：`context/src/projections.ts` 的 session 读取和页面边界、`ContextReadQuery` 类型、`agent-singularity/src/tools/context-read.ts` schema/薄适配，以及原有单测和真实工具门集成。权限事实仍在 context，工具不复制过滤或授权；task、task-runtime、Graph 持久格式和 DSH 原始工具封闭不改。触及的大文件按实际职责说明保留或收敛理由，不因行数机械拆分。

## 验收与停止

- **Q3-1**：真实 Session 日志里一个超过 50000 字节、含中文和需 JSON 转义字符的事件，从列表得到精确对象引用；经真实 `context_read` 工具逐页读取，`body` 拼接与 `extractSessionEventText` 原文完全相同，所有成功页不超过 50000 字节、`nextOffset` 严格前进，尾页返回列表后可读下一事件。
- **Q3-2**：同 cwd 的他图事件，即使知道 `{sessionId,seq}` 也被拒绝且 DSH 不读正文；缺失/过期 seq、非法 ref、非字符边界 offset、越界 offset、源读取失败均具名且无正文。保留字符串 ref、短事件、第二窗口失败、50000 字节边界及 Q4 正反例。
- **整组闸**：复验 Q1/Q2/Q4 与 A2-1～A2-6 的既有真实装配、工具、恢复、取消、旧数据用例；原拒绝规则保留，单次上限按计划 D 节的 50000 字节裁决验收。先写能在已提交代码失败的 Q3 公开入口反例，再做最小实现。按公共合同由主代理顺序完成 build、unit、integration、persistence、类型检查和 diff 检查，并记录实际数量与未覆盖项。独立复核只接一个风险组，主代理负责整票判断。

完成后更新[主 guide](../singularity-harness-guide.md)、[唯一计划](../2026-09-20-vrtc-code-change-plan.md)及本次交付记录，提交 Singularity 与外层子模块指针，**停在进度审核**。只有 Q1–Q4、A2-1～A2-6 和公共检查全部有证据才填“待验收”；存在任何缺口继续填“返工”，不能通过改弱合同或把未展示正文改称范围外结案。不调用付费模型、不推送、不部署。
