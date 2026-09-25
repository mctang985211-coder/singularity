# 第 9 项 A2+A1 进度审核返工

你是 Singularity 第 9 项的返工实现主代理。只修[进度审核 Q1–Q4](../history/2026-09-25-a2-a1-progress-review.md)的可达缺陷并重验 A2+A1；**本票未验收，不开始第 11 项 A4**。

工作区：`/home/ROXY/code/bb_work/harness/packages/singularity`；外层：`/home/ROXY/code/bb_work/harness`。先读[公共执行合同](README.md)、[计划唯一表与 D/E 节](../2026-09-20-vrtc-code-change-plan.md)、[原 A2 prompt](09-a2-a1-context.md)及[交付记录](../history/2026-09-25-a2-a1-delivery-record.md)。原实现与已成立证据保留；修改前检查两仓状态并建立 Git 基线。返工完成后停在进度审核。

## 定向修复与验收

1. **Q1，模型请求必须有可信契约。** 对已发布/已委派的 worker、root、reviewer，在 graph 查询异常、Task store 不可读、ledger 冲突或不可读时，真实 DSH `system-prompt/assemble` 具名失败且模型输入计数为零；诊断性无 agent 组装与确实不属 Singularity 的普通 session 保持原行为。图查询异常不得改写为“没有图”，`unbound` 不能无条件视为允许装配。冷/热工具读取保持纯读，恢复仍只走显式屏障。
2. **Q2，reviewer 委派者归属。** `ReviewerBindingRecord.actor` 与被委派 graph 的实际成员/来源核对；他图、未知或读取失败的 actor 不能使 reviewer 获得该 graph 读取域。测试既要有已发布同域 actor 的合法正例，也要有他图 actor × 已运行 reviewer 的真实装配和 `context_read` 拒绝反例；不能靠模型自报或用户传入 id 授权。
3. **Q3，Session 详情不可丢。** 用真实 Session query 形状注入“第一窗口成功、后续窗口读失败”和“单个事件正文超过 16 KiB”两例。中途失败返回具名不可读，不能把局部事件当完整成功页；大事件不得截断后把 `nextOffset` 推过尚未展示的正文。保持 `context_read` 四参数与 16 KiB 单次界限，提供可核验的续读引用/路径；若 DSH 现有引用无法在冻结接口下表达事件内续读，明确报告最小合同冲突并保持返工，不以不可续读的裁剪声称完成。
4. **Q4，状态分页必须推进。** 单条超长 task 摘要在 `limit=1` 和较大页中均不能返回 `hasMore=true` 且 `nextOffset` 不变。单条放不下时具名超限并指向该 task 的 `context_read` 详情；正常分页仍按 taskId 稳定排序、可完整走到末页，合法短条目不被跳过。

先在现有代码上写能失败的公开入口反例，再做最小修复。Q1/Q2 穿过真实装配、工具和授权路径；Q3/Q4 核对结果文本、来源、`hasMore/nextOffset` 和可续读性。保留 A2-1～A2-6 原有测试、R2 两条取消交错、重启首写闸与旧数据行为，不削弱拒绝规则。只对本票实际触及的 400 行以上文件说明职责变化；不要因为 `projections.ts` 长就机械切分，也不要加第二套缓存、权限表或恢复状态机。

若委派，每人只领一个可独立验收的缺陷组并明确文件所有权；你负责共享接口、整票集成、全量检查与两个 guide。先运行定向红/绿，再按公共合同顺序完成 `pnpm build`、外层 unit/integration、`verify-persistence`、`agent-singularity` 类型检查与 `git diff --check`；必要时独立复核新反例和保留行为。更新[主 guide](../singularity-harness-guide.md)、[唯一计划](../2026-09-20-vrtc-code-change-plan.md)和审核记录，记录被审 SHA、实际测试数量与未覆盖项。Q1–Q4 及 A2-1～A2-6 全部成立才填“交付待进度审核”；仍有合同冲突或失败就保持“返工”并说明。不要付费调用模型、推送或部署。
