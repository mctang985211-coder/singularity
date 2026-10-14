# context.md —— 当前接手状态

本页在每轮结束时**替换当前状态**，只保留未关闭问题、已批准合同索引和证据边界。
历史解释从固定基线实测记录与 Git 查证；剩余施工顺序只在 [assembly-blueprint §9](assembly-blueprint.md#9-剩余构建顺序与检查点) 维护。

## 18. G1/G2 接手审核与用户裁定（2026-10-11，基线 `35b0c7c`）

### 18.1 用户裁定与长期约束

以 `/home/ROXY/code/docs` 的 KISS 目标为准；旧 Singularity 只读参考，开发和运行使用 `/home/ROXY/singularity-next/`。所有节点拥有独立 DSH 主会话，保留文件、命令、编程和 Skill 能力。模型自主分解和探索，不预制候选、解答、子树、轮次或工具顺序。

Task 只声明目标、冻结输入、交付物和可判断的标准。模板是可选来源；审核实现归独立 ReviewRun。执行节点不参与方法治理，改进归根任务关闭后的 RSI 链。历史实验只读，新实验使用新协议，不建兼容桥。

SHA256 仅修改 `sha256_w_mem.v`，保持端口、复位、SHA224/SHA256 功能和逐周期时序；完整 core 面积基线 64858.4544 µm²，改善至少 1%。完整候选原生成本含提案、求解、验收与最终发布审核，最多为基线 125%。累计预算 3 亿 tokens，high reasoning；缺失 usage 明确停止，保守上界预留仍扣原预算，不当成实际候选费用。

### 18.2 当前状态与效果验收边界

- 基于 `f892376` 的 Task v10、Review v1、snapshot v6 历史验证包含 657 项测试、7 项协议门禁和五个离线探针；提示与工具说明修正另经构建、43 项方法/分解测试和 32 项读面/分解测试复验。该历史结果不代表当前 Task v12、Review v2、snapshot v7 的验证，也不证明领域收益。
- 当前 Task v12、Review v2、snapshot v7 的完整 verify 通过 674 项测试与 7 项门禁；等待责任的 `assembly-m26-parent-waits-for-a-running-child` 变异被捕获。测试覆盖问答持久化、真实 Cordis Skill scope、方法固定版本、按文件工具授权、证据分页、审核贡献引用、原父 Run 通知及已提交孩子的冷恢复；验证日志位于实验目录 core-v12-final-verify.log，离线检查不等于复杂任务收敛。
- 隔离实例位于 `/home/ROXY/singularity-next/task-rsi-20261014-core-v10/`。`letters3` 根 `task-0ba8dbedac505bea` 独立审核通过；RSI `improve-6a418dd39b84a823e81c73da` 自主提交候选、完成独立双侧测评并决定无赢家，报告经 `review-05005d3b91989f6d1016295b` 通过，control seq 73 记录 completed。该实例费用 3,866,739 tokens，无未知 usage；它证明流程闭环，未发布新方法，也不证明复杂任务机制有效。
- 首次 SHA256 根 `task-e2f97f93931e506f` 包办探索，最终记录 80 次 bash、2 次 singularity_read、零分解；按用户纠正中断，未提交验收。已知费用 4,592,384 tokens，取消产生 1 条未知 usage，按声明上下文和输出上限保守预留 1,131,072；该预留不是实际可比较候选费用，旧实例不继续调用。
- `sha256-task`、`sha256-plan` 提示验证仍延后分解至基线测量之后，已中断，各保守预留 1 条未知 usage。当前 `sha256-workflow` 使用 high reasoning，启动额度 67,663,909 tokens，继承累计费用保守上界 232,336,091。根 `task-92e516555123d8df` 先给计划，第一个工具为分解；control seq 15 形成 schedule `task-35e120a79d93827d` → integration `task-833f0219b5daacbd`，均支持父标准。根及 schedule 随后收到用户纠正的原生 steer，交付路径见 `workflow-correction-delivery-*.json`，不将该干预冒充默认提示的独立行为证明。
- 原历史实例和已中断实例只读。累计费用详见实验目录 `inherited-accounting.json`、各 `*-experiment.json` 和原生事件；当前实例费用继续扣同一余额。不改写未知 usage，不另加预算。
- SHA256 workflow 的保存终点：26 个任务、9 次分解、8 次提交、6 次通过、1 次失败、1 次审核未完成；根任务未提交。9 个分解没有 handoff，父子问答为零；方法消费事实仅 4 条。费用 53,854,161 tokens；该旧接线实例只读，不把局部审核冒充根闭环。逐任务审计入口为实验目录 core-v12-audit.json。
- 待完成：新接线的原生端到端验证及复杂 SHA256 的协作效果验收。无赢家、无候选、证据不足、未达标或预算不足均如实记录。

### 18.3 当前结构边界

TaskContract = goal / artifact / inputs / criteria / optional template；一次性责任可选择 skills / capabilities，模板责任只使用固定模板的选择；criteria 仅有稳定 ID 与效果。测量实现仍单独固定 verifier ref、version、implementation digest。一次性契约直接调度，子任务关联父标准，精确重复的祖先契约和输入拒绝；模板来源不参与重复规避。

Run 直接固定方法版本，Bubble 冻结输入附件、模型、工具、工作区和作用域。提交以路径封存实际字节，`working → submitted` 为唯一提交路径；独立审核绑定准确产物和标准，执行者不能自判。审核的 fail 是完成判断，运行失败另记。取证子 Task 各自独立审核，ReviewRun 不触发审核审核者。

执行、审核、RSI 各有小接口面。默认只送当前职责、相关方法摘要和依赖引用；产物正文不进入任务历史，按 UTF-8 字节分页读取（默认 16384，最大 32768）；轨迹按事件分页（默认 20，最大 100）。模板索引按需分页返回名称与目标（默认 20，最大 100），按 ID 读取定义，不扩大 Skill / Tool 授权。完整方法归 RSI 或独立审核按引用读取。候选格式仅随 RSI 按需读取返回。子任务继承方法，普通执行节点不能创建或切换候选。

执行提示要求任何工具前先规划责任、交付与依赖；非原子任务的第一个工具必须为分解，未知范围由调查 Task 解决，不以摸底延迟分解。仅有一个有界结果、没有独立未决责任时可说明原子性后直接执行，一个最终文件不足以证明原子性。候选机制、正确性调查或测量异常形成独立可判断的证据时必须成为 Task；本地小实验仅限当前原子责任内部。父节点等待已审核子证据，保留证据如何影响选择和集成。RSI 学习这套 TaskTemplate 工作流及其绑定的 Skill、Tool，作为完整方法版本测评并切换同一指针；不增加计划协议或分解配额。

### 18.4 终局、异步推进与恢复

Run 失败不立即等于 Task 关闭：根 agent 可在当前回合重试；静默且没有新的 working Run 时才关闭根。成功、失败和预算终止都可进入后续分析，evaluation 根不触发 RSI。审核尚未委派取证任务时没有计划通知；冷恢复已提交的孩子仅恢复原会话与独立验收，不给执行者重发求解指令，验收完成后从新 fold 推进依赖。

业务结果返回后，后台等待相关原生会话静默并 flush，封存完整轨迹和费用，再启动独立分析。RSI 提交持久化 round 请求立即返回；宿主从现有 measure / strategy / release 事实继续，复用 trial、审核、决定和唯一发布指针。通知使用现有带身份的原生消息恢复，不另建工作流或状态文件。未执行 RSI 必须说明原因。

### 18.5 不要重建的基础

保留单一信封、ControlSessionStore、append 队列、fold、闭合 schema、版本门、身份检查、不可变附件与证据绑定。内存仅管理资源，不代表业务进度；前端读取同一 committed projection。Web 根借用宿主会话，自建会话 disposer 归创建者，卸载可中断后台等待。

部署 seed 直接初始化当前方法。候选只做结构、绑定、工具样例和受保护边界检查；任务审核与最终发布审核独立保留。发布要求 committed 决定、独立见证、实际方法消费、成本上限及匹配 expected pointer。

方法绑定贯穿上下文、原生 Skill provider、singularity_run_method 和 Bubble 工具挂载。执行不从整个方法库授权：Skill 来自当前 Task 的固定选择；Tool 只有绑定文件可挂载，Bubble 记录同一方法版本和实现摘要。未覆盖 capability 明确列为 gap，不扩大方法授权。

定向反例包括 `mutate:core-w1-single-active-run`、`mutate:core-w1-sealed-request-digest`、`mutate:core-w2-receipt-terminal-cutoff`、`mutate:core-w2-receipt-every-sequence`。变异细节由现有 baseline 持有。

### 18.6 现有证据入口

变异的编辑、run、witness 和结果由 [mutation baseline](../mutation-baseline.json) 持有，本文只保留阅读中有用的反例入口；不要求逐项在文档复制全部变异标识。
其余入口在 [F 实测](f-evidence.md)、[G1 实测](assembly-g1.md)、[G2 合同的基线入口](phase-g2-design.md#8-原-g2-变异记录的证据边界)；它们不证明新合同已实现。

| 范围 | 现有标识 |
|---|---|
| 任务/输入/依赖 | `mutate:task-responsibility-gate`, `mutate:task-verdict-input-binding`, `mutate:task-any-terminal-satisfies`, `mutate:task-unverified-child-accepts`, `mutate:task-only-missing-propagates` |
| 提交屏障与重送 | `mutate:control-barrier-ignored`, `mutate:recovery-precondition-before-identity` |
| 发布资产与历史 | `mutate:round-novelty-publish-removed` |
| 协议成员与读者 | `mutate:protocol-copied-rule-refused`, `mutate:protocol-nested-reader-widened`, `mutate:protocol-post-declare-push`, `mutate:protocol-nested-workspace-reader-widened`, `mutate:protocol-nested-metric-reader-widened`, `mutate:protocol-nested-weights-reader-widened`, `mutate:protocol-nested-run-reader-widened`, `mutate:protocol-nested-outcome-reader-widened`, `mutate:protocol-nested-verdict-reader-widened` |

完整历史原文用 `git show 35b0c7c:docs/context.md` 查证。当前合同/状态不追加逐轮解释，关闭问题从本页移除并留在提交历史。


### 18.7 旧协作能力的逐项去向

| 旧能力与源码入口 | Core 处理 | 当前接线及理由 |
|---|---|---|
| Task 契约、依赖 DAG、冻结输入与验收（task / task-runtime） | 保留并加强 | Task / Run / Bubble / Review 单一控制日志；子支持不替代父验收，负面调查仍可独立通过。 |
| 结构化 handoff（task-runtime/src/handoff.ts） | 替代 | 委派事实仅保存 context 与已验证 evidence 引用；父目标、标准、supports、同级责任和准确父 Run 从同一 fold 装配。决策、范围排除、假设及未决问题由 context 交接，不复制父会话或再存一份 handoff 索引。 |
| 有范围的任务与历史读取（context/src/reads/guards.ts、context/src/session） | 简化保留 | 自身分支、祖先、直接关系、交接及回答引用；增加直接同级责任可见性以复用证据，同级后代仍受边界限制。正文/轨迹分页，审核读取冻结前缀，跨根拒绝。 |
| 持久化父子问答（task-runtime/src/service/questions.ts） | 简化保留 | question / answer 绑定双方准确 Run，requestKey 幂等；阻塞问题关闭执行与提交，现有原生 inbox 恢复投递，不新增问答文件、第二消息队列或状态索引。 |
| Task→Skill/Tool capability manifest（task-runtime/src/capability.ts） | 替代 | 固定方法内按模板或一次性契约选择；上下文、provider、调用授权和文件挂载一致。部署原生基础工具仍由 DSH 提供；旧动态 preset / permission / MCP 准入链未恢复，领域部署与 Bubble 约束替代，不把未实现 capability 当已授权。 |
| Run waiting_children 与 batch settlement（task-runtime/src/orchestration/batch.ts、settlement.ts） | 替代 | 等待从子事实、问题和 round 推导，命令与原生执行共用一个判定；不重复存协调 phase。委派期间父不继续执行或开新分解，运行失败停止未完后代，不自动接管。 |
| 子证据回交与原 Run 恢复（task-runtime/src/orchestration/observe.ts、replay.ts） | 保留并简化 | 同批责任全部终止后交回成果引用与审核证据，通知绑定父 Run；同一事实去重，重试父 Run 有独立通知身份。已提交孩子冷恢复只继续验收，不重启求解。父审核收到贡献、封存轨迹及审核引用以判断证据如何参与集成。 |
| 独立审核、轨迹与 RSI 发布（verifier / evolution / environment） | 保留与替代 | 任务和发布审核独立；真实 Task 责任、问答、资产消费、成本和轨迹用于 RSI。单一方法指针替代独立资产准入链；旧版源码存在机制不作为整体可靠性证据。 |
