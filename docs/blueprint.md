# Singularity 重构蓝图

日期：2026-10-11。复核基线：`35b0c7c`。本页定义总目标与架构；施工顺序只在 [assembly-blueprint §9](assembly-blueprint.md#9-剩余构建顺序与检查点) 维护。

## 1. 产品目标与范围

Singularity 为 agent 提供领域任务运行基建，将工作中形成的 TaskTemplate、Skill、Tool 经可比较实验和独立审核发布，
使后续 Run 实际消费已发布方法。领域提供目标、输入、独立验收与度量；内核保证责任、版本、来源和决定可判定。

本次交付私有独立 DSH 上的 G1/G2/G3、读面板、恢复与发布验证。完整 canvas、group/router、任意多图另定合同。
G3 进化求解方法；RTL 是任务产物，其正确性/面积用于评测方法。直接优化 RTL 仍走普通 Task/Run。
工程闭环与回归必须通过；真实领域质量/成本按冻结验收标准单独报告达标/未达标，token 用量仅使用 DSH 原生轮后统计，不作为执行闸门。

## 2. 内核对象与所有权

| 对象 | 责任 |
|---|---|
| Task | 不可变领域契约、责任、分解与依赖；父最终产物独立验收 |
| Run | 对 Task 的一次完整求解；固定 revision/输入，终态封存来源 |
| Agent | 一个可继续的准确 DSH session；责任与父子关系由事实表达 |
| Method / Revision | TaskTemplate、Skill、Tool 的内容版本；共用评估/批准/发布路径 |
| ReviewRun / Evidence | 独立会话对冻结对象逐条判断；测量固定真实实现，执行者不能自判 |
| Release | 绑定 committed 决定和独立审核依据，切换前重检准确 head |

DSH 拥有会话、transcript、独占写租约、持久化、模型/工具执行与原生 Web UI。
core 拥有领域事实、命令不变量和读投影；assembly 通过显式端口编排副作用并管理自建 handle/disposer；
领域部署声明装置，client 展示同源投影。运行细节见 [装配边界](assembly-blueprint.md#2-所有权与复用边界)。

共用一个信封、ControlSessionStore、提交队列、fold、版本闸和拒绝合同；领域各有事实语义，不合成巨大 reducer。
不建立第二份任务状态、恢复 JSON、通知账本或方法发布流程。内存可保存已验证投影和 live handle，但不能决定责任、尝试、预算或完成。
RRSI 只提供决定与正则化约束；执行复用 DSH/Task/Bubble，见 [ADR0001](adr/0001-rrsi-port-boundary.md)。

## 3. 当前交付状态

| 部分 | 已有 | 尚未通过的出口 |
|---|---|---|
| core | 单一控制存储、Task v17、Review v4、直接方法绑定、必需责任与可停止探索、measure/strategy/release | 最终工程验证与真实边界证据 |
| G1/G2 | 一次性契约、独立审核、角色工具、父背景按需读取、产物依赖、同会话恢复、snapshot v9 | 新协议真实领域运行 |
| G3 | 异步持久请求、独立双侧测评、唯一发布指针 | 小领域决定、SHA256、真实发布与后续消费 |

核心基础保留；装配生命周期需修正。[context](context.md) 只记录未关闭问题和证据边界，历史“通过”不代表新合同通过。
代码/测试/门禁数量不用于推算完成率。体积是审查信号；每条新增状态/规则需有真实生产者、消费者和行为反例。

## 4. 当前文档的唯一职责

| 文档 | 内容 |
|---|---|
| [agent-brief](agent-brief.md) | 交给执行者的任务书：实测状态、已知缺陷、工作包顺序与开发纪律 |
| [round-10-plan](round-10-plan.md) | 本轮实测缺陷、当前能力状态与 W10—W14 工作包 |
| [assembly-blueprint](assembly-blueprint.md) | 装配边界、剩余工作包及验收出口 |
| [phase-g2-design](phase-g2-design.md) | 当前 G2 行为与领域/运行端口合同 |
| [context](context.md) | 用户裁定索引、未关闭问题、实测边界；每轮替换当前状态，不追加历史 |
| [standalone-dsh](standalone-dsh.md) | 私有宿主及真实可运行命令 |
| [spec-policy](spec-policy.md) | 唯一验证规范：TDD、行为目标、反例与门禁边界 |
| [tdd-seams](tdd-seams.md) | 当前施工接口检查表，不另设审批流程或阶段计划 |
| [debugging](debugging.md) | 故障定位、修复与注释清理方法 |
| [handoff](handoff.md) | 接手阅读顺序，不复制计划 |

## 5. 按需查证的历史与外部规格

[review](review.md)、adversarial-review 系列、[assembly-review](assembly-review.md)、[assembly-g1](assembly-g1.md)、
[k1-evidence](k1-evidence.md)、[f-evidence](f-evidence.md) 保留固定基线的实测记录。
[phase-b-design](phase-b-design.md)、[phase-cd-design](phase-cd-design.md)、[round-9-handoff](round-9-handoff.md)、
[g2-gates-handoff](g2-gates-handoff.md) 是历史设计/交接，不参与当前施工。
这些记录中的路径、行号和小节号对应当时基线；旧文档原文用 `git show <commit>:<path>` 查证，不并入当前契约。

[legacy-behaviour-reference](legacy-behaviour-reference.md) 用于旧仓行为对照；[rrsi-upstream-reference](rrsi-upstream-reference.md)
与 [divergence-ledger](divergence-ledger.md) 用于固定上游规格和已接受分歧。
当前结构与证据元数据由仓内 protocol/tree/mutation/DSH baselines 及其脚本持有；文档不重复数字或账本载荷。
