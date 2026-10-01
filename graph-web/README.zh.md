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
- `GET /singularity/graph?graphId=:id`（元数据 + 拓扑 + 布局），`GET/PUT /singularity/layout?graphId=:id`
- `GET /singularity/events?graphId=:id`（单图完整快照 SSE），`GET/POST /singularity/hitl`
- `GET /singularity/map/`（静态 SPA）
- `GET /singularity/task?storeId=:id`（原生 task 快照），`POST /singularity/task/proposals/decide`
- `GET /singularity/evolution`，`GET /singularity/evolution/:id`
- `GET /singularity/recovery?storeId=:id`（恢复状态），`GET /singularity/review?storeId=:id&runId=:id`（运行记录 + 日志尾部）

### 维护的 Service 状态

1. SSE 帧：`snapshot`（订阅时以及 graph/layout 变化时推送完整视图）、`graphs`、`hitl`、`task`（`task/change` 时推送 store 失效提示）、`evolution`（`evolution/change` 时推送账本失效提示，携带 proposal id）、`pr-chat/path`、`pr-chat/sent`

2. 不提供 ctx 服务

### 设计说明

控制台路由以软依赖方式读取 task 平面（`optionalService`）：`GET /singularity/task` 原样透传 task 快照，本进程打不开的 store 返回 404 JSON 错误；`POST /singularity/task/proposals/decide` 将 `approve`/`reject` 映射到 `decideProposal`（决策者记为 `operator`），`continue` 映射到 `continueProposal`，`cancel` 映射到 `cancelProposal`，proposal 所属会话取自 proposal 记录本身；领域拒绝以 HTTP 200 返回 `{ ok: false, error }`，只有格式错误的请求才用非 2xx。`GET /singularity/recovery` 返回 `recoveryStatus` 以及仍在进程内的屏障待办（`wokenSessions`、`pendingNotices`、`pendingBatchResults`、`cancelled`，仅当本进程持有该 store 的屏障时出现），`reconcile` 恒为 null（facade 不缓存报告，且其 `reconcileStore` 是 GET 不得执行的变更流程）；`GET /singularity/review` 返回该 run 的 `ReviewRecord`，并通过 verifier 注册表重新读取其首个 criterion 日志的 `logTail`，注册表缺失时为 null。`GET /singularity/evolution` 返回 `list()` 与 `experiments()`，当 `ctx.singularityEvolution.enabled` 为 false 或未挂载账本时返回空数组；详情路由返回 `get(id)`，未知 id 返回 404 JSON 错误。
