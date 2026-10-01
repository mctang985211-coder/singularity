# dsh-singularity-graph-web

[中文](README.zh.md) | English

Purpose: HTTP + SSE surface for one graph's view, the graphs registry, environments, HITL, and the map SPA.

Package: `@dangosys/dsh-singularity-graph-web`

Dependencies: graph, layout, graphs, envBuilder, webServer, hitl (soft: task, taskRuntime, verifier, evolution) (types: agent, map)

config.yaml: none

### Tools

none

### Web APIs

- `GET/POST /singularity/graphs`
- `POST /singularity/graphs/:id/{select,ready,delete}`
- `GET /singularity/graph-envs`, `POST /singularity/repo-check`
- `GET /singularity/graph?graphId=:id` (metadata + topology + layout), `GET/PUT /singularity/layout?graphId=:id`
- `GET /singularity/events?graphId=:id` (SSE full snapshots for one graph), `GET/POST /singularity/hitl`
- `GET /singularity/map/` (static SPA)
- `GET /singularity/task?storeId=:id` (native task snapshot), `POST /singularity/task/proposals/decide`
- `GET /singularity/evolution`, `GET /singularity/evolution/:id`
- `GET /singularity/recovery?storeId=:id` (recovery status), `GET /singularity/review?storeId=:id&runId=:id` (run record + log tail)

### Service state

1. SSE frames: `snapshot` (full view on subscribe and on graph/layout change), `graphs`, `hitl`, `task` (store invalidation on `task/change`), `evolution` (ledger invalidation on `evolution/change`, carrying the proposal id), `pr-chat/path`, `pr-chat/sent`

2. no ctx service

## Design notes

Every route shares the prologue in `web/libs/http.ts`: `guardMethod` for the 405 answer, `fail` for the error body (the message, status 400, or 409 where a route declares one), and `graphIdOf`/`queryOf` for the `graphId` and `storeId`/`runId` query parameters. `GET /singularity/graphs` decorates each record with its environment's `owner/repo` components; the environment list marks availability with the graphs package's own reuse predicate.

The events route registers the SSE stream, mirrors the current HITL pending list as its first frame, and forwards named events (`hitl`, `task`, `evolution`, `pr-chat/path`, `pr-chat/sent`) verbatim; `graphs/change` re-snapshots graphs still present and ends the streams of removed ones. The map route serves the built SPA from `@dangosys/dsh-singularity-map/dist` behind a path-escape guard.

The console routes read the task plane softly (`optionalService`): `GET /singularity/task` passes the native snapshot through and answers 404 with a JSON error for a store this process cannot open; `POST /singularity/task/proposals/decide` maps `approve`/`reject` onto `decideProposal` (decider `operator`), `continue` onto `continueProposal`, and `cancel` onto `cancelProposal`, taking the session a proposal belongs to from the proposal record, and answers domain refusals as `{ ok: false, error }` with HTTP 200 (non-2xx only for a malformed request). `GET /singularity/recovery` pairs `recoveryStatus` with the live barrier's deferred work (`wokenSessions`, `pendingNotices`, `pendingBatchResults`, `cancelled` — present only while this process holds a barrier for the store) and a null `reconcile` (the facade caches no report, and its `reconcileStore` pass is a mutation a GET must not run); `GET /singularity/review` returns the run's `ReviewRecord` and a fresh `logTail` of its first criterion log through the verifier registry, null when that registry is absent. `GET /singularity/evolution` serves `list()` and `experiments()` and answers empty arrays when `ctx.singularityEvolution.enabled` is false or no ledger is mounted; the detail route serves `get(id)` and answers 404 with a JSON error for an unknown id.
