# dsh-singularity-canvas-view

[English](README.md) | 中文

功能：把 Singularity map 挂成 shell 原生页面：在左侧栏注册 `sidebar.panellist` 入口，并在 root 作用域的 `main` 槽注册 `singularity` 面板承载 map iframe，同时维护 session 对话桥接。graph 管理位于 map SPA 内部。

包名：`@dangosys/dsh-singularity-canvas-view`

依赖：slots、locale、sessions（客户端）；服务端无依赖（空 apply）

依赖的config.yaml配置：无

### 可调用Tools

无

### 注册的 Web API：

无（消费 `/singularity/graph` 校验 prompt 提交，并承载 `/singularity/map/` SPA）

### 维护的 Service 状态

无（仅浏览器端挂载；Web 客户端模块为 `src/frontend/client.js`，由 `scripts/build-client.mjs` 复制到 `lib/client.js`）

## 设计说明

- 只有一处构造：客户端注册左侧栏入口（`sidebar.panellist` id `singularity`，order 30，label 来自 `singularity-canvas-view` locale 命名空间），以及与之匹配的 `main` 面板，面板内是 `/singularity/map/` iframe。侧栏负责绘制行并切换面板，canvas-view 自身不再绘制任何 overlay、切换药丸或 graph 列表。
- 客户端与 map iframe 通过 postMessage 通信：向 frame 发送 `singularity:open` / `singularity:prompt`，接收 `singularity:transcript` / `singularity:prompt-result` / `singularity:session-error`。host 采用 frame 上报的 `graphId` 并在每次回复中回传；非法入站消息只记录日志，不从 window listener 抛出。transcript 行由持久 session 事件、session 的持久 `inbox` projection 与本地提交回声共同投影而来。
- 桥接在 iframe 首次引用 session 时 retain 一份精确引用（`sessions.retain(id, { source: 'canvasView' })`，并等待 `reference.ready`），在切换 graph 与面板卸载时 release；`binding(id)` 仅在引用存活期间借用。`chatGeneration` 守护异步竞态：面板卸载或 frame 切换 graph 时丢弃过期绑定（包括仍在等待引用的绑定），卸载同时 release 引用并释放 event / session / inbox-projection 订阅。
- 本包是浏览器客户端模块（`dsh.client.platform = web`），不是 Node service；它消费的服务端路由全部由 graph-web 提供。
- 客户端名册边（`dsh.client.inject`）只声明本 bundle 真正需要的行：`@deepseek-ai/dsh-client-ui-layout` 与 `@deepseek-ai/dsh-client-ui-sidebar`（`main` 与 `sidebar.panellist` 槽的声明方）以及 `@deepseek-ai/dsh-client-locale`；React 与 sessions 由 shell 的模块表提供，不额外声明。
