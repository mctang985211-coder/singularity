# dsh-singularity-map

Purpose: Serve the Singularity map SPA — the operator console for a graph: a React Flow canvas, task/run observability, proposal review and global HITL, the Evolution ledger and its experiments, recovery status, verifier criteria, graph switching, chat and HITL bridging over postMessage, and node geometry writes.

Package: `@dangosys/dsh-singularity-map`

Dependencies: React 19, @xyflow/react, zustand, react-markdown, remark-gfm

config.yaml: none

### Tools

none

### Web APIs

none (consumes `/singularity/*` — graph, layout, hitl, graphs, graph-envs, task, task/proposals/decide, evolution, recovery, review and the `events` SSE stream; the built SPA is served by graph-web under `/singularity/map/`)

### Service state

none (browser SPA; state lives in a zustand store)

## Design notes

- Not a cordis plugin: there is no `cordis.patch.yml`, no `src/index.ts`, and no server `apply`.
- `src/types.ts` is a deliberate local fork of the per-graph wire types (agent topology and canvas geometry, both canonical in `@dangosys/dsh-singularity-graph`): the browser bundle stays free of the server-side cordis / `@deepseek-ai/dsh-session` type graph, and only carries the fields the canvas consumes (`groups`, `memberOf` and `transcriptId` are not part of it).
- React Flow's `Node<T>` requires `T extends Record<string, unknown>`, so the xyflow-facing aliases (`FlowNode`, the `AgentNode` component's node type) intersect `AgentData` with `Record<string, unknown>`; `AgentData` itself stays an explicit-field interface.
- `src/panels/index.ts` exports the tab registry (`PanelDef[]`): App renders `PANELS` as tabs, so later waves append panels there without editing `App.tsx`. `PANELS` holds the canvas, tasks, proposals, evolution, recovery and verifier panels; the canvas view is one registry entry like any other.
- The Tasks and Proposals panels read the graph's native task store (`GET /singularity/task`, decisions through `POST /singularity/task/proposals/decide`, criterion logs through `GET /singularity/review`); the Evolution panel reads `/singularity/evolution` (empty arrays while the chain is off) and the Recovery panel reads `/singularity/recovery` (its reconcile report stays null, the barrier's deferred work appears only while the backend process holds one). `task` and `evolution` SSE frames refetch those panels, and only when the panel's data was already loaded.
- The shell owns boot and the event stream; panels are mounted only for the active tab, so switching tabs never drops the SSE connection. `src/components/GraphSwitcher.tsx` lists, selects, creates and deletes graphs from `/singularity/graphs`; an in-SPA switch rewrites `?graphId=` and reboots.
- The task store id is `sg-t-<rootSessionId>` (the convention of `rootTaskStoreId` in the task package), derived from the selected graph unless the URL carries an explicit `?storeId=`.
- canvas-view owns the iframe; the map receives `singularity:open` / `singularity:prompt` / `singularity:transcript` messages and replies with `singularity:prompt-result` / `singularity:session-error`. Node geometry is persisted through `PUT /singularity/layout?graphId=`.
