# Task / Skill 自改进实现

本次施工采用 `2026-10-03-supervisor-task-dag-kiss-audit.md` 的最小闭环，并以独立 worktree 分轮提交。历史审计描述的是修改前的事实。

## 第一轮：入口、职责和契约

- 删除 `singularity-reviewer` preset，唯一协调宿主为 `singularity-coordinator`；runtime 分别装配 reviewer 和 supervisor 的稳定政策。Supervisor 可以请求已有 decide/apply 人审，审批模式为 ask。
- 默认仅复盘失败。普通 child 诊断交回真实父 Run；共享变更才启动 supervisor。已有 proposal 状态承接候选等待、审批、应用及重启，恢复 Run 保存实际 proposalIds，child 变更应用后唤醒真实父 Run。
- Task 模板是 `<id>@<version>.json`，带适用条件、原始参数 schema 和完整契约。实例固定模板引用、参数、最终 contractDigest；Skill 与实际能力固定到 Run。优先检索模板，无适用者仍可提交标准新契约，均走同一 normalize/admission。
- 模板库默认位于 `$DSH_HOME/singularity/task-templates`（未设置时为 `~/.dsh/singularity/task-templates`）。模型通过 `task_template_list` 查看；人工初始化可调用 runtime 的 append-only `registerTaskTemplate`。
- 不可结算的 mandatory review/formal 判据在准入拒绝；显式支持该 mode 的注册 verifier 可以结算，composite 保留。根契约缺能力时记录由根负责的义务，不丢弃目标；执行叶节点仍须具备声明能力。
- 删除核心中的 BB MCP 表，唯一服务器定义来自部署 `mcpServers` 配置。`capability_list` 显示可接入服务器；worker 的真实外部 echo MCP 调用已验证。BB 定义保留在部署配置和唯一测试数据中。
- 义务满足只认显式匹配 criterion id 的最新 verified Run 与 passing evidence。声明 capability、记录缺口均不能当作已满足。
- 删除六个超长旧测试文件，按原 describe 边界迁移到小文件，同内容 fixture 仅保留一份；原 562 个用例标题和 82 个 describe 正文已核对一致。`check:source-size` 检查每个手写源文件不超过 2000 行，并接入 build。

## 验证口径

构建会刷新仓库跟踪的 `lib/` 运行时产物。单元与集成回归从独立 worktree 运行；集成中的模型、审批回应有脚本化替身，MCP 使用实际 stdio 子进程。通过这些测试能证明入口、持久化、授权、消息和实验协议可执行，不能代替真实大模型长期自主分解质量的评估。

第二轮继续接通 Task 模板 Evolution 与成功源的成本比较；不引入缓存、通用原子性 gate、标量 V 或记忆平台。
