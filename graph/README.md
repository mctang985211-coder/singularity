# dsh-singularity-graph

[中文](README.zh.md) | English

Purpose: Persist the per-graph plane — agent topology (agents / groups / edges) and the session canvas geometry (sessionId → CanvasNode) — and expose `ctx.graph` and `ctx.layout` to canvas and runtime.

Package: `@dangosys/dsh-singularity-graph`

Dependencies: sessionPersistence

config.yaml: optional `storeId` for the topology service (default graph-idle); the `./layout` subpath entry takes its own optional `storeId` (default layout-idle)

### Tools

none

### Web APIs

none

### Service state

1. ctx.graph: snapshot / snapshotIn / switchStore / clearActive / addAgent / setStatus / addGroup / addMember / addEdge / commit (and their `*In` scoped twins)

2. event `graph/change`: broadcast GraphSnapshot after commit

3. ctx.layout: snapshot / snapshotIn / setIn / switchStore / clearActive for canvas geometry

4. event `layout/change`: broadcast LayoutSnapshot after each commit

5. persisted `graph/event` and `layout/event` (SessionEventMap): replay is one `GraphState.apply` / `LayoutState.apply` per record, and both payload roots are fingerprinted in `docs/persistence-schema.json`.

## Design notes

The per-graph stores share `EventStoreSet` from `@dangosys/dsh-singularity-task` (`src/service/store.ts`): open/create with header, replay validation, serial writes, per-commit broadcast and disposal. The topology store is `graph/event` over `GraphState` under `graph/change`; the layout store — folded into this package as the `./layout` entry — is `layout/event` over `LayoutState` under `layout/change`, and it overrides the factory's refusal texts to keep the layout wordings byte-identical (`layout: invalid store id <id>` and the like).

The configured default store opens before any caller exists, so nothing awaits that promise yet. A failed open is kept observable to the caller that finally needs the store instead of floating to the process-level unhandled-rejection handler, which the harness treats as a fatal load failure: an unmigratable predecessor generation of one store must not decide whether the whole harness boots.

One layout store is one session-persistence session (`storeId`, default `layout-idle`). `node/remove` remains in the replayed event vocabulary even though the live service only writes `node/set`; persisted stores keep replaying unchanged. CanvasNode values are typed at every in-process call site, so the reducer no longer re-validates shapes.
