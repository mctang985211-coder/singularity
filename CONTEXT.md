# Singularity

Singularity 用任务契约约束自主探索，以验证证据决定结果。可见节点承载执行，任务描述要达成的目标。

## 主路径（2026-10-08 RRSI 重构）

新图只有一条编排、评估和发布主路径：

```text
业务执行
  → supervisor 调查
  → 候选环境版本（method_draft）
  → 筛查、双侧评估与 RRSI 选择（method_evaluate）
  → 保留当前版本 / 显式试用 / 审批发布（method_publish · method_discard · method_rollback）
  → supervisor 显式结案（supervisor_complete）
  → 下一业务执行或结束
```

发布与回滚只切换一个生效版本指针（`expected.revisionId` + `expected.generation` 的 CAS，持久 intent + 原子写入 + fsync + 回读）；弃置不需审批。协调只持久保存 assignment 与 completion，正常结束却未调用完成工具记为协议失败，不再催问。没有协议标记（`singularity/graph@2`）的旧图封存只读：不 adopt、不恢复、不发布、不写进度。

## Language

**Task Contract（任务契约）**：任务的目标、约束和验收条件，描述什么结果可以接受。
_Avoid_: 步骤清单、Skill 调用脚本

**Task Instance（任务实例）**：针对具体目标接受的一份任务契约及其执行状态；可以由节点直接构造，不要求来自预设模板。
_Avoid_: 模板、一次工具调用

**Task Template（任务模板）**：可选复用的任务契约模式及其适用条件；实例化后仍须接受契约校验。
_Avoid_: 合法任务白名单、固定 workflow

**Task Proposal（任务提案）**：节点提出、尚未正式准入的任务契约或分解批次；供机器校验以及按策略进行的人类审核。
_Avoid_: 已运行任务、Method Draft、完成证据

**Contract Review（契约审核）**：确认一份具体任务提案是否值得按其目标、范围和验收条件执行。
_Avoid_: 产物验收、工具权限授权、模板晋升

**Context View（上下文视图）**：面向当前任务的根目标、契约、相关决定与证据的有来源视图；提供全局位置和必要细节的引用。
_Avoid_: 完整祖先聊天、可任意改写的共享记忆

**Task Question（任务澄清问题）**：执行节点就当前契约或必要信息向父任务提出、需要明确回答的可追踪问题。
_Avoid_: 人类审批、能力授权、执行完成

**Incident（诊断事项）**：由一组相关失败或缺口事实引起的有范围诊断工作，可关联多个受影响任务。
_Avoid_: 每个失败节点独立的新根因、已证实原因
_未落地_: 当前无源码或工具消费者；保留词汇，不建 incident 平台（guide §3）。

**TaskRun（任务执行）**：针对同一任务的一次执行尝试；其结果与所用能力属于这次尝试。
_Avoid_: Task、Session

**Agent Node（代理节点）**：图中可见的执行主体，拥有可继续的会话；它可以承担任务并提出子任务。
_Avoid_: 任务本身

**Obligation（未满足义务）**：契约尚未得到证据回答的问题，可能由现有产物、执行或进一步分解消解。
_Avoid_: 固定工序、必然要新建的子任务

**Capability（能力）**：完成某类义务所需的能力要求，不指定某一次执行必须采用哪份操作指导。
_Avoid_: Skill 名称、权限

**Skill（执行技能）**：实现能力的可复用方法，具有适用前提、输入输出和可验证的效果。
_Avoid_: Task、成功证据

**Knowledge Skill（知识型指导）**：以技能形式提供的领域知识、义务模板或判断参考；自身不证明任务完成。
_Avoid_: 已验证的执行能力

**Capability Manifest（能力清单）**：一次执行所选择的能力实现及其资源配置。
_Avoid_: 已经满足全部验收条件的证明

**Capability Gap（能力缺口）**：完成义务所需的能力路径尚不具备；必须显式记录和处置。
_Avoid_: 任务已经失败、允许自行扩大权限

**Artifact（产物）**：任务产生或使用的工程对象。
_Avoid_: Evidence

**Evidence（证据）**：验证器对特定产物是否满足特定验收条件给出的可追溯判断依据。
_Avoid_: Agent 自述、仅存在的文件

**Verifier（验证器）**：独立于执行过程、按验收条件裁决产物的机制。
_Avoid_: 执行者的完成声明

**Escalation（上报）**：把无法在当前能力、预算或裁判条件下解决的问题交给有权决策者。
_Avoid_: 自动提权、自动重试、Diagnosis

**Environment Revision（环境版本）**：不可变的方法环境快照——Skill 及资源、TaskTemplate 与图内 capability/MCP 清单，由 manifest 与内容摘要定位；Run 准入时固定版本，发布与回滚只切换一个生效指针。
_Avoid_: 就地编辑的库、手填的 versionSet

**Method Draft（方法草稿）**：一次方法变更的候选及其账本轨迹（draft → evaluated → discarded | published）；草稿不能覆盖生效版本，显式试用（trialCandidateRef）不推进指针。
_Avoid_: EvolutionProposal、模型手工串联的九步工具链

**Execution Receipt（执行凭证）**：运行时从真实记录生成、在 Run 终态封存的执行事实——原合同、环境版本、实际模型身份、模板/Skill 消费与用量；缺失事实标为 incomplete，调用方和模型不能自述"已通过"。
_Avoid_: 调用方自填的凭证、对同一会话事实的第二次扫描

**Evaluation Report（评估报告）**：一次冻结评估（双侧版本、输入、模型、原验收、评价规则与预算）的唯一报告；发布前经同一验证器重检。
_Avoid_: 多条晋升管线、以"最新一次实验"作为晋升依据

**Coordination Assignment / Completion（协同指派 / 结案）**：协同工作的唯一持久记录——spawn 前落盘 assignment，工作项结束由会话自己的完成工具（`supervisor_complete` / `reviewer_complete`）写 completion；正常结束未结案记协议失败。
_Avoid_: 输出文本解析、三次催问、第二份会话运行事实
