/**
 * The independent legacy reader: pure composition over read-only doors, no
 * service handle and no write path. A graph without a protocol marker is
 * history, and this is the one reader that shows its shape.
 * @module dsh-singularity-graphs/read/legacy
 */

import type { GraphSnapshot, LayoutSnapshot } from '@dangosys/dsh-singularity-graph'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { graphAccessWire } from '../wire.ts'
import type { LegacyCompletionWire, LegacyGraphViewWire } from '../wire.ts'
import type { GraphRecord } from '../types.ts'

/** What a read-only door answers: a missing store reports `exists:false` instead of being created. */
export type ReadOnlyDoorAnswer<TSnapshot> =
  | { readonly exists: false }
  | { readonly exists: true; readonly snapshot: TSnapshot }

/** The only read door this reader uses: the store set's own zero-write snapshot. */
export interface ReadOnlySnapshotDoor<TSnapshot> {
  snapshotReadOnly(id: string): Promise<ReadOnlyDoorAnswer<TSnapshot>>
}

/** The graph and layout services' door: the same zero-write snapshot, named by those two services' own method. */
export interface ReadOnlySnapshotDoorIn<TSnapshot> {
  snapshotReadOnlyIn(id: string): Promise<ReadOnlyDoorAnswer<TSnapshot>>
}

/** The legacy evolution facts one graph holds, as the old ledger projects them. */
export interface LegacyEvolutionFacts {
  readonly proposals: readonly unknown[]
  readonly experiments: readonly unknown[]
}

/** Where one legacy graph's records are read; every door is read-only and nothing here writes. */
export interface LegacyReadDeps {
  readonly graph: ReadOnlySnapshotDoorIn<GraphSnapshot>
  readonly layout: ReadOnlySnapshotDoorIn<LayoutSnapshot>
  readonly task: ReadOnlySnapshotDoor<TaskSnapshot>
  /** The old evolution ledger's own reader, projected verbatim; absent when this deployment keeps none. */
  readonly legacyEvolution?: (graphKey: string) => Promise<LegacyEvolutionFacts>
  /** The old completion formats (note prefix / fenced JSON), read for history display only. */
  readonly legacyCompletions?: (graphKey: string) => Promise<readonly LegacyCompletionWire[]>
}

/** The kind of store a read drew on; a refusal names it so the missing source is auditable. */
type SourceKind = 'topology' | 'layout' | 'tasks'

/** One door read, with a failure named by the source it came from. */
async function readDoor<T>(
  kind: SourceKind,
  graphId: string,
  read: () => Promise<ReadOnlyDoorAnswer<T>>,
): Promise<ReadOnlyDoorAnswer<T>> {
  try {
    return await read()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`graphs: reading the ${kind} of legacy graph "${graphId}" failed: ${detail}`)
  }
}

/**
 * One legacy graph's whole history: its registry record, the three stores it may
 * hold, and the old evolution and completion records, each kept verbatim. The
 * stores are read in a fixed order (topology, layout, tasks) through read-only
 * doors, so a read creates nothing and a missing store is reported rather than
 * treated as a failure. `writable` is `false` by construction: no caller can
 * mistake this projection for a write path.
 */
export async function readLegacyGraph(deps: LegacyReadDeps, graph: GraphRecord): Promise<LegacyGraphViewWire> {
  const key = rootTaskStoreId(graph.rootSessionId)
  const topology = await readDoor('topology', graph.id, () => deps.graph.snapshotReadOnlyIn(graph.graphStoreId))
  const layout = await readDoor('layout', graph.id, () => deps.layout.snapshotReadOnlyIn(graph.layoutStoreId))
  const tasks = await readDoor('tasks', graph.id, () => deps.task.snapshotReadOnly(key))
  const evolution = deps.legacyEvolution === undefined ? undefined : await deps.legacyEvolution(key)
  const completions = deps.legacyCompletions === undefined ? [] : await deps.legacyCompletions(key)
  return {
    formatVersion: 'legacy-v1',
    writable: false,
    graph,
    access: graphAccessWire(graph),
    topology: topology.exists ? topology.snapshot : null,
    layout: layout.exists ? layout.snapshot : null,
    tasks: tasks.exists ? tasks.snapshot : null,
    proposals: evolution?.proposals ?? [],
    experiments: evolution?.experiments ?? [],
    completions,
    sources: [
      { id: graph.graphStoreId, kind: 'topology', exists: topology.exists },
      { id: graph.layoutStoreId, kind: 'layout', exists: layout.exists },
      { id: key, kind: 'tasks', exists: tasks.exists },
    ],
  }
}
