# Singularity 重构蓝图

架构初稿：2026-10-11，基线 `35b0c7c`。最新整体审查：2026-10-17，基线 `4314487`。本页保留现有架构边界；后续施工顺序与目标设计以 [Task / Workflow RSI 终局计划](task-first-domain-rsi-plan.md) 为准。

## 1. 产品目标与范围

Task 是可独立交付、验收和追责的 workflow 节点。Workflow 由 Task 的责任、依赖、贡献和产物关系组成，复用同一 control 事实，不另设运行时。方法学习的目标包括节点定义、分解粒度、关系组织和配套 Skill/Tool。

现行方法通过短 `workflowGuidance` 与可选 TaskTemplate、Skill、Tool 表达组织与求解方法。业务节点收到固定方法与全局方向，关系概览从同一 committed cut 投影。用户提供完整 Task 契约，领域提供保护输入、可选模板、独立验收与度量；内核保证责任、版本、来源和决定可判定。评测用于检验 workflow 演化，普通业务无需先定义任务集。多任务 case×trial 与独立迁移发布链路已实现；真实领域迁移效果仍待验证。

本次交付私有独立 DSH 上的 G1/G2/G3、读面板、恢复与发布验证。完整 canvas、group/router、任意多图另定合同。
G3 进化求解方法；RTL 是任务产物，其正确性/面积用于评测方法。直接优化 RTL 仍走普通 Task/Run。
工程闭环与回归必须通过；真实领域质量/成本按冻结验收标准单独报告达标/未达标，token 用量仅使用 DSH 原生轮后统计，不作为执行闸门。

## 2. 内核对象与所有权

| 对象 | 责任 |
|---|---|
| Task | workflow 中的责任节点；冻结契约、分解与依赖，父最终产物独立验收 |
| Run | 对 Task 的一次完整求解；固定 revision/输入，终态封存来源 |
| Workflow（投影） | 同一根任务的责任树与依赖/产物关系；没有第二份持久节点状态 |
| Agent | 一个可继续的准确 DSH session；责任与父子关系由事实表达 |
| Method / Revision | workflow 策略、TaskTemplate、Skill、Tool，共用评估/批准/发布路径 |
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
| core | 单一控制存储、Task v24、Strategy v9、Measure v5、Review v5；批次预算、历史搜索头/S*、suite 矩阵与配对校准、冻结迁移 | 外部模型/工具来源不能靠本地声明完全证明 |
| G1/G2 | 完整契约、可选模板、workflow 策略/方向、独立审核、整图预算、增量规划、恢复/取消、snapshot v13 | 新协议真实模型协调行为与领域运行 |
| G3 | 异步有界稀疏搜索、case/family 反馈、suite 的独立 validation/heldout、发布审核和唯一指针、CLI 报告 | 无 suite 发布尚未强制迁移；CLI 未逐题运行完整 pilot；实际迁移/消融效果待独立领域包验证 |

领域实现不进入 core/assembly 或产品 spec。主仓只保留 `domain/reference` 给 env setup 阅读；领域包在用户 staging 生成，经审核后显式选择部署。2026-10-22 的结构修复和逐包验收见[计划第 9 节](task-first-domain-rsi-plan.md#9-详细实施任务)。

核心基础与原生装配生命周期保留；模型请求的 retry、错误分类与最终失败直接由 DSH 处理，Task 只消费原生 turn/end；无自定义 provider 拦截与整图重启机制。[context](context.md) 只记录未关闭问题和证据边界，历史“通过”不代表新合同通过。
代码/测试/门禁数量不用于推算完成率。体积是审查信号；每条新增状态/规则需有真实生产者、消费者和行为反例。

## 4. 当前文档的唯一职责

| 文档 | 内容 |
|---|---|
| [Task / Workflow RSI 终局计划](task-first-domain-rsi-plan.md) | 节点/图/方法定义、全局与局部上下文、T00–T16 工作包及唯一验收出口 |
| [assembly-blueprint](assembly-blueprint.md) | 现有装配边界与历史工作包，不再维护新施工排序 |
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
