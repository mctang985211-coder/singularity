# dsh-singularity-graph-web

[中文](README.zh.md) | English

Purpose: HTTP + SSE surface for one graph's view, the graphs registry, environments, HITL, and the map SPA.

Package: `@dangosys/dsh-singularity-graph-web`

Dependencies: graph, layout, graphs, envBuilder, webServer, hitl (soft: task, taskRuntime, verifier) (types: agent, map, evolution and context for the legacy reader and the view service)

config.yaml: none

### Tools

none

### Web APIs

- `GET/POST /singularity/graphs`
- `POST /singularity/graphs/:id/{select,ready,delete}`
- `GET /singularity/graph-envs`, `POST /singularity/repo-check`
- `GET /singularity/graph?graphId=:id` (metadata + access mode + topology + layout), `GET/PUT /singularity/layout?graphId=:id`
- `GET /singularity/view?graphId=:id` (the one read model: access, active revision, latest evaluation, derived progress; `&summary=1` for access + progress alone)
- `GET /singularity/graphs/:id/history` (a sealed legacy graph's records, verbatim and read-only)
- `GET /singularity/events?graphId=:id` (SSE full snapshots for one graph), `GET/POST /singularity/hitl`
- `GET /singularity/map/` (static SPA)
- `GET /singularity/task?storeId=:id` (native task snapshot)
- `GET /singularity/recovery?storeId=:id` (recovery status), `GET /singularity/review?storeId=:id&runId=:id` (run record + log tail)

### Service state

1. SSE frames: `snapshot` (on subscribe and on the client's own graph/layout change: the canvas projection plus the unified read model), `graphs`, `hitl`, `task` (store invalidation on `task/change`), `methods` (method-store invalidation on `methods/change`), `pr-chat/path`, `pr-chat/sent`

2. no ctx service

## Design notes

Every route shares the prologue in `web/libs/http.ts`: `guardMethod` for the 405 answer, `fail` for the error body (the message, status 400, or 409 where a route declares one), and `graphIdOf`/`queryOf` for the `graphId` and `storeId`/`runId` query parameters. `GET /singularity/graphs` decorates each record with its environment's `owner/repo` components, its protocol `access` mode, and the read model's `progress` and `evaluation`; when this deployment mounts no fact producer for that read model the list still serves, and the refusal the service named (`viewError: { error, source }`) travels with it. The environment list marks availability with the graphs package's own reuse predicate.

`GET /singularity/view` reads the one projection (`ctx.singularityGraphView`, the context package's `GraphViewService`) that the tool plane reads too: the same revision, evaluation and derived progress, so Web and tools cannot disagree. A graph without the protocol marker is answered `409 { error: 'graph-sealed', graphId, reason, history }` — the caller is told to read `/singularity/graphs/<id>/history` instead — and a missing fact producer is a `503 { error, source }`, never a default. The history route is the one that serves a sealed graph: it assembles the read-only doors (the registry's `snapshotReadOnlyIn`, the layout service's, the task service's `snapshotReadOnly`, the old evolution ledger and the old review ledger) and answers `LegacyGraphViewWire` with `writable: false`; a current-protocol graph is refused there with a pointer back to the view route. Both live under the one `/singularity/graphs` prefix owner (`graphs.ts` dispatches the `history` action to `history.ts`), because the route table gives a prefix one owner. `GET /singularity/graph`, `GET /singularity/layout` and `GET /singularity/task` read through those same zero-write doors, and every write path on a graph (`PATCH` pins, `select`, `ready`, `PUT` layout) refuses a sealed graph before it commits anything.

The events route registers the SSE stream, mirrors the current HITL pending list as its first frame, and forwards named events (`hitl`, `task`, `methods`, `pr-chat/path`, `pr-chat/sent`) verbatim; `graphs/change` re-snapshots graphs still present and ends the streams of removed ones. A client keeps only the graph id it subscribed to: each `snapshot` frame is read from the registry and the read model at push time, so the console holds no graph record of its own. The map route serves the built SPA from `@dangosys/dsh-singularity-map/dist` behind a path-escape guard.

The console routes read the task plane softly (`optionalService`): `GET /singularity/task` answers the store's own snapshot read through the zero-write door (`{ snapshot: null }` for a store that does not exist, `503 { error, source }` when no task service is mounted). `GET /singularity/recovery` pairs `recoveryStatus` with the live barrier's deferred work (`wokenSessions`, `pendingNotices`, `pendingBatchResults`, `cancelled` — present only while this process holds a barrier for the store) and a null `reconcile` (the facade caches no report, and its `reconcileStore` pass is a mutation a GET must not run); `GET /singularity/review` returns the run's `ReviewRecord` and a fresh `logTail` of its first criterion log through the verifier registry, null when that registry is absent.
