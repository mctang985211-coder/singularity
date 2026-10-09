# dsh-singularity-map

Purpose: Serve the Singularity map SPA — the operator console for a graph: a React Flow canvas, task/run observability, the graph's method read model, global HITL, recovery status, verifier criteria, graph switching, chat and HITL bridging over postMessage, node geometry writes, and the read-only history of a sealed legacy graph.

Package: `@dangosys/dsh-singularity-map`

Dependencies: React 19, @xyflow/react, zustand, react-markdown, remark-gfm (types: `@dangosys/dsh-singularity-graphs/wire` for the graph read model)

config.yaml: none

### Tools

none

### Web APIs

none (consumes `/singularity/*` — graph, view, layout, hitl, graphs, graphs/<id>/history, graph-envs, task, recovery, review and the `events` SSE stream; the built SPA is served by graph-web under `/singularity/map/`)

### Service state

none (browser SPA; state lives in a zustand store)

## Design notes

- Not a cordis plugin: there is no `cordis.patch.yml`, no `src/index.ts`, and no server `apply`.
- `src/types.ts` is a deliberate local fork of the per-graph wire types (agent topology and canvas geometry, both canonical in `@dangosys/dsh-singularity-graph`): the browser bundle stays free of the server-side cordis / `@deepseek-ai/dsh-session` type graph, and only carries the fields the canvas consumes (`groups`, `memberOf` and `transcriptId` are not part of it).
- React Flow's `Node<T>` requires `T extends Record<string, unknown>`, so the xyflow-facing aliases (`FlowNode`, the `AgentNode` component's node type) intersect `AgentData` with `Record<string, unknown>`; `AgentData` itself stays an explicit-field interface.
- `src/panels/index.ts` exports `panelsFor(mode)`: the tab registry is a function of the open graph's access mode, and App renders the list it returns. A current-protocol graph shows canvas, view, methods, tasks, recovery and verifier; a sealed legacy graph shows history and nothing else, so no panel that could write is even registered. `src/components/GraphSwitcher.tsx` exports `headControls(mode)` for the same reason: Settings and Delete are not rendered for a sealed graph.
- The View panel reads `/singularity/view` — the one read model (access mode, active revision, latest evaluation, derived progress) that the tool plane reads too — and the Tasks panel shows the same derived progress beside its counts. The Tasks and Verifier panels read the graph's native task store (`GET /singularity/task`, criterion logs through `GET /singularity/review`); the Recovery panel reads `/singularity/recovery` (its reconcile report stays null, the barrier's deferred work appears only while the backend process holds one). The `task` and `methods` SSE frames refetch those panels, and only when the panel's data was already loaded.
- A sealed legacy graph opens as history instead of as a canvas: `boot()` reads `/singularity/graph`, and when the answer's `access.mode` is `legacy-readonly` it reads `/singularity/graphs/<id>/history` and stops — no canvas snapshot, no event stream, no session. `switchGraph` reads the registry's own `access` before deciding, so it posts no `select` for a sealed graph (selection is a write, and the route refuses it anyway). Every write the store offers (`moveNode`, `sendPrompt`, `answerHitl`, `updateGraphSettings`) refuses with a named error while the open graph is sealed, so no request is issued even if a control were reachable.
- Iteration rounds appear as extra runs under their task: a run whose `recovery` record exists carries a small badge next to its status — `↻ recovery · round N` or `↻ improve · round N`, where N is the run's 1-based position in the task's `runIds` and the label reads `TaskRun.recovery.kind` (`improvement`; anything else, including an absent kind, reads as an ordinary `recovery`). Runs the projection lists without a task keep the badge without a round number.
- The shell owns boot and the event stream; panels are mounted only for the active tab, so switching tabs never drops the SSE connection. `src/components/GraphSwitcher.tsx` lists, selects, creates and deletes graphs from `/singularity/graphs`; an in-SPA switch rewrites `?graphId=` and reboots, while a boot with no `?graphId` (a freshly opened page) adopts the registry's `selectedId` so the selected graph opens instead of the empty canvas.
- The focus panel's stored width is a clamped preference, never a render error: a stale or sub-minimum `localStorage` value falls back to the default, and a resize can only store a width at or above the minimum.
- The task store id is `sg-t-<rootSessionId>` (the convention of `rootTaskStoreId` in the task package), derived from the selected graph unless the URL carries an explicit `?storeId=`.
- canvas-view owns the iframe; the map receives `singularity:open` / `singularity:prompt` / `singularity:transcript` messages and replies with `singularity:prompt-result` / `singularity:session-error`. Opening a node sends its spawn edge's parent session (`parentSessionId`) so a child opens under its durable subagent address; a transcript carrying `readOnly: true` locks the focus composer to that node. Node geometry is persisted through `PUT /singularity/layout?graphId=`.
