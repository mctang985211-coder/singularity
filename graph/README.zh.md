# dsh-singularity-graph

[English](README.md) | 中文

功能：持久化单 graph 平面 —— Agent 拓扑（agents / groups / edges）与会话画布几何（sessionId → CanvasNode），并向画布与 runtime 暴露 `ctx.graph` 与 `ctx.layout`。

包名：`@dangosys/dsh-singularity-graph`

依赖：sessionPersistence

依赖的config.yaml配置：拓扑服务可选 `storeId`（默认 graph-idle）；`./layout` 子路径入口有自己的可选 `storeId`（默认 layout-idle）

### 可调用Tools

无

### 注册的 Web API：

无

### 维护的 Service 状态

1. ctx.graph：snapshot / snapshotIn / switchStore / clearActive / addAgent / setStatus / addGroup / addMember / addEdge / commit（以及各自的 `*In` 作用域版本）

2. 事件 `graph/change`：提交后广播 GraphSnapshot

3. ctx.layout：snapshot / snapshotIn / setIn / switchStore / clearActive 画布几何

4. 事件 `layout/change`：每次提交后广播 LayoutSnapshot

5. 持久化的 `graph/event` 与 `layout/event`（SessionEventMap）：重放即逐条 `GraphState.apply` / `LayoutState.apply`，两个 payload 根都登记在 `docs/persistence-schema.json`。

## 设计说明

单 graph 的两个 store 共用 `@dangosys/dsh-singularity-task` 的 `EventStoreSet`（`src/service/store.ts`）：带头打开/创建、重放校验、串行写入、每次提交广播与释放。拓扑 store 是 `graph/event` + `GraphState` + `graph/change`；layout store —— 已并入本包，作为 `./layout` 入口 —— 是 `layout/event` + `LayoutState` + `layout/change`，并覆盖工厂的拒绝文案以保持 layout 措辞逐字节不变（如 `layout: invalid store id <id>`）。

默认 store 在构造期、任何调用方出现之前就打开，因此还没有人 await 它。打开失败保留给真正需要该 store 的调用方观察，而不是浮到进程级 unhandled rejection —— harness 会把它当作致命加载失败：某一代无法迁移的 store 不应决定整个 harness 能否启动。

一个 layout store 对应一个 session-persistence session（`storeId`，默认 `layout-idle`）。`node/remove` 保留在可重放的事件词汇中，尽管当前服务只写 `node/set`；已持久化的 store 可继续原样重放。CanvasNode 在所有进程内调用点都有类型约束，因此 reducer 不再重复校验形状。
