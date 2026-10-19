# 接手入口

更新：2026-10-19。整体审查基线 `4314487`；当前 Task v23 / Strategy v9 / Measure v5 / Review v5 / snapshot v13，仅用于新图。

1. [Task / Workflow RSI 终局计划](task-first-domain-rsi-plan.md)：架构、T00–T16 与未完成出口，唯一施工顺序在第 9.1 节。
2. [RSI agent 工作合同](rsi-agent-contract.md)：实际流程、标准 JSON、真实失败记录和证据边界。
3. [context](context.md)、[blueprint](blueprint.md)、[spec-policy](spec-policy.md)：当前状态、已确认合同和验证规范。

最新实跑 `buckyball-commandcode-rsi-20261019-124254` 已取消、宿主已停止，原始记录保留。root/task 的角色指导实际送达；父合同却要求写只读参考仓库，repair 已产出补丁后进入无人处理的提权审批。旧 `003416` 的 RSI 同样收到了流程，但重抄完整 Method 损坏六份冻结源码。不能把这些失败归结为“没发 system prompt”或模型无法编写修复。

`02016c5` 回退 `9e655ce`，删除上一轮草稿与源码继承改造，再按实际证据修复：业务角色明确仅 workspace 可写、跨任务通过 sealed artifacts/声明输入交接、宿主独立验收；Bubble 使用原生 never 审批立即拒绝越权。RSI 提案只写 analysis 与 edit.changes，每项包含 value，宿主保留未改资产与源码。`kind=method` 返回当前 assets、pending、nextRound、feedback 和 JSON 模板；不再生成草稿文件或要求重抄完整 Method。静态拒绝定位字段、不扣槽，冻结后失败扣槽，最多 6 槽、repair=0。

报告审核读取提交前封存的当前根、本 search evolve 证据和已筛选提案实际引用的历史证据页；历史只开放封存字节范围，私有 split、其他 search、后续事件与未引用页面不扩权。待评估时新批次在入场前拒绝、不扣槽，原批次仍可恢复。报告通过、候选入场和实测收益分别判断。

本轮验证结果见计划第 2.2 节。尚未用付费模型重跑修复版本；原生测试适配器证明指令和 schema 送达，不证明模型必然遵守。

Buckyball C/ISA+BEMU 环境、六题合成案例和独立 scalar oracle 已具备。完整 pilot 逐题入口仍未接通；experiment 只提交首个 evolve 根，有效候选才触发完整 split 测评矩阵。每 split 一族不足最少三族统计门。复杂任务收敛、迁移收益、MLIR/RTL/PPA、另一机器复现与论文出口仍未验收，T12–T16 的边界以计划为准。

历史运行与冻结 checkout 不改写。`host.log` 含私有 token，不公开；provider 重试交给 DSH 原生。旧图不迁移，下一次实跑使用新 checkout 与 control。
