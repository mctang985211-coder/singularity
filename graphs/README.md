# dsh-singularity-graphs

Purpose: Registry of graphs, each binding one environment and one root session; exactly one graph is active in the process.

Package: `@dangosys/dsh-singularity-graphs`

Dependencies: sessionPersistence, graph, layout, agentRuntime, envBuilder, taskRuntime (resolved lazily), task

config.yaml: none

### Tools

none

### Web APIs

none

### Service state

1. ctx.graphs: snapshot / current / get / view / list / select / create / markReady / graphForSession / remove

2. events `graphs/change`: emit GraphsSnapshot after commit; `graphs/selected`: emit the activated GraphRecord

3. `SessionNotInGraphError` carries code `graph-session-not-found` when no graph's store holds the session

4. `view(id)` also answers `access` (the graph's protocol mode) and `null` for a store this process never opened; `readLegacyGraph(deps, graph)` (exported from the package) is the one reader of a sealed graph's old records

## Design notes

The registry is event-sourced on the `graphs/event` session log (single store `graphs-registry`); the in-memory `GraphsState` replays it on open, and every mutation commits events before it becomes visible.

`create` resolves the environment first (reuse by id, by workspace label, or by exact repo match among unbound, session-free, repository-carrying environments), then creates the root and registers the graph before activating it. A graph creates no task: registration happens before the recovery barrier (`adoptRoot`), so a barrier failure leaves the graph registered and selected with its reason visible, and the same activation entry serves boot recovery of the selected graph.

`taskRuntime` is resolved through `ctx.get` at call time instead of `static inject`, because task-runtime injects graphs; a deployment without the runtime refuses activation by name, and `remove` simply has nothing to cancel.

A graph's protocol is a creation property (`protocol: { id: 'singularity/graph@2', version: 2, since }`) and its absence is what makes a graph sealed legacy history — there is no third state and no migration write. Every write that acts on one graph (`select`, `markReady`, `setPins`) resolves its record through the one gate (`assertCurrentGraph`) and answers `GraphSealedError` (`code: 'graph-sealed'`) before committing anything; a sealed graph is never activated, not even at boot with it selected. Reads go the other way: `view` and `graphForSession` read the graph and layout stores through the zero-write door (`snapshotReadOnlyIn`), so a read of a graph this process never opened answers `null`/`{ exists: false }` instead of creating a store. `remove` archives a sealed graph from the registry alone — it stops no graph, cancels no task and cleans no environment, because all three would be writes on history.
