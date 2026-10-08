# dsh-singularity-graph-web

[English](README.md) | 中文

功能：单图视图、graphs 注册表、环境、HITL 与 map SPA 的 HTTP + SSE 接口。

包名：`@dangosys/dsh-singularity-graph-web`

依赖：graph、layout、graphs、envBuilder、webServer、hitl（软依赖：task、taskRuntime、verifier、evolution）（类型：agent、map）

依赖的config.yaml配置：无

### 可调用Tools

无

### 注册的 Web API：

- `GET/POST /singularity/graphs`
- `POST /singularity/graphs/:id/{select,ready,delete}`
- `GET /singularity/graph-envs`，`POST /singularity/repo-check`
- `GET /singularity/graph?graphId=:id`（元数据 + 访问模式 + 拓扑 + 布局），`GET/PUT /singularity/layout?graphId=:id`
- `GET /singularity/view?graphId=:id`（唯一读取模型：访问模式、当前版本、最近评估、派生进度；加 `&summary=1` 只返回访问模式与进度）
- `GET /singularity/graphs/:id/history`（封存旧图的记录，原样、只读）
- `GET /singularity/events?graphId=:id`（单图完整快照 SSE），`GET/POST /singularity/hitl`
- `GET /singularity/map/`（静态 SPA）
- `GET /singularity/task?storeId=:id`（原生 task 快照）
- `GET /singularity/recovery?storeId=:id`（恢复状态），`GET /singularity/review?storeId=:id&runId=:id`（运行记录 + 日志尾部）

### 维护的 Service 状态

1. SSE 帧：`snapshot`（订阅时以及该客户端自己那张图的 graph/layout 变化时推送：画布投影 + 统一读取模型）、`graphs`、`hitl`、`task`（`task/change` 时推送 store 失效提示）、`methods`（`methods/change` 时推送方法存储失效提示）、`pr-chat/path`、`pr-chat/sent`

2. 不提供 ctx 服务

### 设计说明

`GET /singularity/view` 读取唯一的读取投影（`ctx.singularityGraphView`，context 包的 `GraphViewService`）——工具面读的也是它：同一份当前版本、最近评估与派生进度，Web 与工具不可能不一致。无协议标记的图返回 `409 { error: 'graph-sealed', graphId, reason, history }`，把调用者指向 `/singularity/graphs/<id>/history`；缺少事实生产者返回 `503 { error, source }`，绝不返回默认值。历史路由是服务封存旧图的那一条：它组装只读门（注册表与布局服务的 `snapshotReadOnlyIn`、task 服务的 `snapshotReadOnly`、旧 evolution 账本与旧 review 账本），返回 `writable: false` 的 `LegacyGraphViewWire`；新协议图在那条路由上会被指向 view 路由。两条路由都挂在 `/singularity/graphs` 这一个 prefix 所有者下（`graphs.ts` 把 `history` 动作分派给 `history.ts`），因为路由表里一个 prefix 只能有一个所有者。`GET /singularity/graph`、`GET /singularity/layout`、`GET /singularity/task` 都走同一组零写门，而对图的每条写路径（`PATCH` 设置、`select`、`ready`、`PUT` 布局）都会在提交任何东西之前拒绝封存图。

控制台路由以软依赖方式读取 task 平面（`optionalService`）：`GET /singularity/task` 经零写门返回该 store 自己的快照（store 不存在时 `{ snapshot: null }`，未挂载 task 服务时 `503 { error, source }`）。`GET /singularity/recovery` 返回 `recoveryStatus` 以及仍在进程内的屏障待办（`wokenSessions`、`pendingNotices`、`pendingBatchResults`、`cancelled`，仅当本进程持有该 store 的屏障时出现），`reconcile` 恒为 null（facade 不缓存报告，且其 `reconcileStore` 是 GET 不得执行的变更流程）；`GET /singularity/review` 返回该 run 的 `ReviewRecord`，并通过 verifier 注册表重新读取其首个 criterion 日志的 `logTail`，注册表缺失时为 null。
