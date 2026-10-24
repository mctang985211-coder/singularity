# 接手入口

> 文档归档范围：历史记录。适用协议和证据仅限原文明确记录；未冻结的版本不推断。当前行为见[架构入口](architecture.md)，分类和来源见[文档目录](documentation-index.md)。

更新：2026-10-23。当前 Task v25 / Strategy v9 / Measure v5 / Review v5 / snapshot v13，仅新图。[简化审查与实跑](prompt-simplification-20261023.md)记录单一节点 policy、共享预算、RSI 减量和 env setup 的验证边界。下文实验属于 2026-10-20 的 Task v23，整体审查基线 `4314487`、修复起点 `7bd91bb`。

1. [Task / Workflow RSI 终局计划](task-first-domain-rsi-plan.md)：架构、T00–T16 与未完成出口，唯一施工顺序在第 9.1 节。
2. [RSI agent 工作合同](rsi-agent-contract.md)：派生 phase、异步提案、分页读取、JSON 与审核用途。
3. [RSI 修复取证](rsi-repair-evidence.md)：原生输入/输出、根因、修改、回归与新模型实跑记录。

`184556` 业务根失败；RSI 报告通过却六槽零评测。原生记录定位到预测节点与证据 session 的错误耦合、评测前要求迁移证明、critic 混淆 before/after、acceptance 混淆审核用途，以及同步工具调用/恢复依赖作者重发的问题。本轮保留已有输入、隔离、取消修复，没有回退 Git。

现在 `kind=search` 是短状态与动作入口，资产、authoring 规则和详细 feedback 按需分页。`propose_method` 静态预检后冻结附件并立即返回 screening；宿主自动继续 critic/selftest/evaluation，按事实 seq 幂等恢复作者。待办期间关闭作者模型 step、写入、提案和提交。状态仅由现有 Task/Run/batch/round 事实派生，没有第二个状态库。下游尚未启动的真实 Task 可以列为预测对象；无关 Task 和不可读证据仍拒绝。自有 evolve 评测轨迹支持显式 rootId，不再误路由到历史业务根。

新 letters 运行 `rsi-repair-letters-20261019-2025` 已自主完成两轮实际测评、独立发布、指针切换和作者自动恢复；最终报告独立验收通过，源根 RSI completed，后续业务根消费发布方法并 accepted。它是单输入单次生命周期诊断，不证明迁移。Buckyball 运行 `buckyball-rsi-repair-20261019-204028` 在 cutoff551 已 completed / insufficient-evidence：两候选、一轮测评、报告 accepted、无发布。A 没有质量收益且成本增加 43.66%；B 的一次 trial 被错误子合同及 runtime 归因丢失。公开输入现只含任务规范和摘要，完整私有验证清单仅 verifier 可读；子验收/业务失败沿责任传播为 business，真正 runtime/取消仍缺测。969 项回归、7 gates、新生成六题真实 RISC-V/BEMU 正反例和两个探针通过，未新跑模型 RSI。最终状态与原生序号以取证文档为准。历史运行和冻结 checkout 不回写；host.log 含私有 token，不公开。

独立报告验收可读提交前封存的当前根、本搜索 evolve 证据和已筛选提案引用的封存历史页；不扩展私有 split、其它 search 或后续事件。无待办时可以如实提交无改进/证据不足报告；报告 accepted、轮次完成和实测迁移分别判断。

Buckyball 六题合成 C/ISA+BEMU suite 与独立 scalar oracle 已具备；完整逐题 pilot 入口仍未接通，experiment 只提交首个 evolve 根，合法候选才触发 split 矩阵。每 split 一族不足最少三族统计门。真实陌生任务收益、MLIR/RTL/PPA、另一机器复现和论文出口仍未验收。
