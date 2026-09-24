# 第 9 项 A2+A1：Agent 状态上下文

历史执行合同：本票已于 2026-09-25 **交付待进度审核**（交付 `4a510ed`/`f90d05b`/`0f41d91`/`6e0f651`，证据与未覆盖范围见[交付记录](../history/2026-09-25-a2-a1-delivery-record.md)）。本文件保留原始实现要求供审核对照，不再派发；进度审核通过后按唯一执行表进入第 11 项 A4。

## 可直接续跑的 prompt

```text
你是 Singularity 第 9 项 A2+A1 的实现主代理。交付一个完整的 Agent 状态上下文组；
不要把内部交接当成已完成阶段，也不要实施第 11 项 A4 或后续演进功能。

工作区：/home/ROXY/code/bb_work/harness/packages/singularity
外层仓库：/home/ROXY/code/bb_work/harness

先读：
1. docs/singularity-harness-guide.md 的当前状态与 §1.4–1.5。
2. docs/2026-09-20-vrtc-code-change-plan.md 的唯一执行表、D 节与 E 节
   “A2+A1：读取路径不能再承担恢复”；此处是冻结的行为、归属与验收合同。
3. docs/execution-prompts/README.md 的公共执行合同、
   docs/execution-prompts/task-dispatch-template.md 的实施约束及 A2+A1 示例。

前置：核对 R1/R3 验收记录和实际提交，检查 AGENTS.md 与两仓状态，修改前建立
Git 基线。R1 仓库外证据目录只读。若前置事实不成立，停下并报告，不自行重做前票。
第 9 项已经开始：先核对 `4a510ed` 的显式恢复/纯读拆分与后续提交，将它作为
子目标交接事实，不把该提交当作 A2-1～A2-6 的整组验收；只续做尚未交付的职责。

目标：Agent 在真实请求中获取已接受的根目标/硬约束、本人完整契约、真实贡献；
能在同 graph 域内按引用读取依赖验收、证据和历史，跨 graph 拒绝。读取不推进
Task 生命周期；显式恢复先于首个业务输入和写动作。压缩、重启、普通运行与 replay
均从权威事实重建，不留旧渲染双轨。

固定归属：新 context 包负责授权读取、相关性投影、引用、输出界限和 DSH 异步
system-prompt/assemble 接线；task 保持持久事实，task-runtime 保持恢复、执行闸和
提交，agent-runtime 保持身份及稳定角色政策；agent-singularity 的工具只做薄适配。
不建 memory 数据库、第二份 Task store、全局知识索引或 allowedActions 状态机。

执行顺序（接口先交接，每次子代理只领一个子目标；主代理拥有整票集成）：
1. 将 graph create/activate/启动恢复汇入 E 节显式恢复屏障，完成对账、gate 与
   driver 登记后才放行业务输入。冷查询与纯读取不再调用 reconcile/回填；直接
   执行未就绪具名拒绝。处理屏障失败、取消和重试，不等待 driver 的模型输出。
2. 建 context 的可信 session→graph→store 绑定、同域读取、默认相关投影和
   context_read。reviewer 无业务 Run 时从既有 ledger 核实委派；普通/replay 的
   首请求不依赖 spawn 返回后才补的内存缓存。按 D 节冻结的三工具 schema 和
   16 KiB 界限实现，核心契约超限具名拒绝，不静默裁剪。
3. task_read/task_status 改为同一读源的适配器；移走旧跨记录渲染和 handoff 的
   上下文渲染，保留 runtime 的持久 handoff 数据与执行绑定校验。普通、replay、
   恢复和无 Run reviewer 的实际 prompt 请求一起接线。Singularity 有效工具面
   与 pre-execute 同时封住 D 节列出的跨 Session 原始读取旁路。
4. 主代理完成独立组合验收、公共构建与回归，更新主 guide、唯一计划和派发入口，
   记录基线/交付提交、未覆盖范围后停在进度审核。

验收编号不得拆票提前通过：
- A2-1：三层真实 Task 链的实际请求含根目标/硬约束、本人完整契约和贡献；
  兄弟依赖的验收/证据可按引用读，无关历史默认不推但同域可读。
- A2-2：同 cwd 两个 graph 不能互读，猜 id 与原始 Session 工具不能绕过；
  reviewer 按真实委派域读取，不冒充 root 或业务 Run。
- A2-3：压缩/重启后从来源恢复，replay 不串根；未激活、等待、终态、缺失、
  无绑定、失效引用和超限都有明确结果；重复装配不累加动态事实。
- A2-4：冷/热查询与实际 prompt 装配零审批、spawn、verifier 和 Task 状态写入；
  重启后首写受闸，普通/replay 首请求不等 spawn 后缓存；保留 R2 取消反例。
- A2-5：三个入口遵守 D 节冻结 schema；reviewer 绑定失败零模型输入；
  恢复失败阻断新执行但诊断可读，重复激活不重复 driver，waiting_children
  恢复不自锁，直接服务调用不能旁路恢复门。
- A2-6：本组迁出的筛选/上下文渲染/引用读取由 context 的真实工具和请求消费者
  接管，旧位置无同一职责的生产实现、旧调用或同名转发；runtime 的执行绑定校验、
  持久 handoff 与恢复闸仍由原所有者承担。按调用链核对，不按行数或导出数验收。

以真实 DSH 请求装配、工具调用、历史读取和持久重开测试这些行为；确定性协议
验证无需付费模型。拒绝路径检查零意外写入/派发/审核副作用。不要为通过测试
放宽授权、删旧反例、保留旧渲染转发层或预设 Agent 的查因/修复策略。

若委派，按上述 1→2→3→4 交接，每个子代理只读相关合同、拥有明确文件/接口、
只跑定向验证且不得改共享 guide；不把整组跨包工作转给一人。上下文不足时交接
当前提交、已改接口、已跑证据、唯一剩余目标后续跑，主代理保留整票验收责任。

按公共合同依次运行 pnpm build、外层 unit/integration、verify-persistence、
git diff --check 和 agent-singularity tsc --noEmit。记录实际数量、失败轨迹、
未覆盖项、既有复杂度处置（本票触及文件的保留/迁出/删除及旧位置）与独立复核。
全部 A2-1～A2-6 和迁移删除通过才填“交付待进度审核”；
任何合同缺口保留返工并停下。不推送、不部署、不开展未授权模型实验。
```
