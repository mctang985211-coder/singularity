# dsh-singularity-task

[English](README.md) | 中文

功能：持久化任务分解树、依赖 DAG、运行状态机、提案、问答与预算扩展，并向 runtime 暴露 task 服务。

包名：`@dangosys/dsh-singularity-task`

依赖：sessionPersistence

依赖的config.yaml配置：无

### 可调用Tools

无

### 注册的 Web API：

无

### 维护的 Service 状态

1. ctx.task：store 打开/创建（`createStore` / `openStore` / `snapshotIn` / `commitIn`），读取（`taskIn` / `runIn` / `runMembersIn` / `runMemberSlotsIn`），任务与运行生命周期写入（`createTaskIn` / `admitTaskIn` / `rejectTaskIn` / `admitBatchIn` / `admitRootProposalIn` / `startRunIn` / `markRunStatusIn` / `changeRunPhaseIn` / `markRunProgressIn` / `addDependencyIn` / `recordHandoffIn` / `askParentQuestionIn` / `answerParentQuestionIn`），记录写入（`recordEvidenceIn` / `recordReviewIn` / `recordDiagnosisIn` / `recordObligationIn`），提案写入（`submitProposalIn` / `decideProposalIn` / `changeProposalPhaseIn` / `consumeProposalIn`）与 `recordBudgetExtensionIn`。

2. 事件 `task/change`：提交后广播 TaskSnapshot。

3. 持久化的 `task/event`（SessionEventMap）：回放时每条记录执行一次 `TaskState.apply`；payload 根类型指纹记录在 `docs/persistence-schema.json`。

4. `EventStoreSet`（`src/service/store.ts`）：所有事件溯源 store 共用的工厂，封装 `sessionPersistence` 上的打开/创建与 header、回放校验、串行写入、每次提交后的变更广播与销毁，并由本包导出给图平面的各图存储复用。

## 设计说明

存储是事件溯源的：`TaskService` 为每个 store id 打开一个 session，把其中的 `task/event` 记录回放进 `TaskState.apply`，快照只有这一个所有者。每次写入都是一次 `commitIn`：在 store 唯一的写队列内先对克隆应用整批事件，只有 reducer 接受才追加，被拒绝的事件不会落库，并发调用者也无法把判断与追加交错。这套机制就是 `src/service/store.ts` 里共用的 `EventStoreSet` 工厂：同一份实现按事件类型、reducer 状态、快照与变更事件名参数化并包住 `sessionPersistence`；task 用 `task/event`、`TaskState` 与 `task/change` 实例化它，图平面（graph/layout/graphs）的各图存储将迁移到同一工厂。`compact`（工厂的追加步骤）丢弃值为 `undefined` 的键（与 `canonicalize` 共用 `definedKeys` 的同一条规则），因为 session 日志只接受可无损 JSON。

`TaskContract` 是所有创建入口统一适配的一份数据定义；任务的 `objective`、`acceptanceCriteria`、`requestedCapabilities` 是它的投影，reducer 拒绝两者不一致。内容身份彼此独立：`contractDigest`/`decompositionDigest` 描述"要求了什么"，`admissionContextDigest` 记录当时生效的限制，`reviewContextDigest` 记录这批任务当时解析到的能力清单与裁判实例（verifier 列表归一化排序，registry 顺序不影响身份）。准入时生成的 id 不进入任何摘要，因此重试保持同一身份。

一个批次由 `(parentRunId, proposalId)` 标识，`batchIdFor` 只是把这一对拼写出来：父任务会多次分解，每次准入把成员追加到父任务的 children、把一个批次追加到该运行的累积里，顺序稳定，后一批不会重排前一批。批次身份出现之前的旧记录三个字段都不带，按当时的分解语义读取，绝不被猜测补齐。

`ExecutionPhase` 是准入闸而非运行状态：`active → waiting_children` 在准入后关闭写闸，`waiting_children → active` 把执行交还，之后两种相位都可进入 `submitted`。协议之前没有相位的运行不被默认为 active——它唯一的合法延续是取消。恢复尝试（A6）是运行自己的 `recovery` 字段，"该尝试是否在途"由运行状态回答；`runMemberSlots` 把尝试钉住的兄弟成员与本批成员合并，`runMemberTaskIds` 是同一序列去掉空洞。

问答只记录身份与引用：`questionIdOf` 由提问运行与 requestKey 派生，`answerIdOf` 由问题与回答 key 派生，正文留在各自 Session。阻塞完全从问题记录派生，不落在相位、运行字段或第二份索引上；只有双方运行都在 running 时问题才算 open。

提案整份保存（每个子任务的规范化契约，而不只是摘要），因为审批、画布与重启后的复审都要只凭存储事实渲染。它的生命周期是一张状态表而非 task 状态；审批绑定 dossier 摘要与两个上下文指纹；consumption 与子任务（或根任务与根运行）在同一次提交里落库，因此崩溃后可以只凭日志恢复，一个提案也绝不会变成两批。

预算扩展按维度记录（生效上限 → 批准上限）这一对，外加当时展示给人的完整 reading。链检查在写队列内逐维进行：raise 必须写出真正生效的值，某维度的第一次 raise 声明部署自身配置的值，一个 requestKey 只对应一个请求，重复请求从记录答复。

`src/index.ts` 是 barrel 与服务门面；reducer 位于 `src/service/`：`state.ts` 持有 `TaskState` 类与任务/运行生命周期处理器，`questions.ts`、`records.ts`、`proposals.ts` 各持有自己的事实族，`store.ts` 提供 `EventStoreSet`（兄弟包 graph、layout、graphs 将复用的共享工厂），`checks/` 把形状、身份与迁移检查写成快照上的函数（`primitives.ts` 是共享叶子：拷贝、谓词、索引守卫、查找）。抽取出的检查只返回或抛错；没有第二个 store，也没有按事件种类持久化的状态。
