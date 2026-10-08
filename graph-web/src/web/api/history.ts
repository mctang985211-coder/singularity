/**
 * The legacy history route: one sealed graph's records, verbatim and read-only —
 * its registry record, the three stores it may hold, the old evolution ledger
 * and the old completion rows. Nothing here writes, adopts, restores or
 * publishes; every store is read through the zero-write door.
 * @module dsh-singularity-graph-web/api/history
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { graphAccessWire, readLegacyGraph } from '@dangosys/dsh-singularity-graphs'
import type { LegacyReadDeps } from '@dangosys/dsh-singularity-graphs'
import { environmentHomeOf, readLegacyMethodsSync } from '@dangosys/dsh-singularity-evolution'
import type { LegacyCompletionWire } from '@dangosys/dsh-singularity-graphs/wire'
import type { TaskService } from '@dangosys/dsh-singularity-task'
import { libraryRoots, optionalService } from '@dangosys/dsh-singularity-task-runtime'
import type { TaskRuntime } from '@dangosys/dsh-singularity-task-runtime'
import { sendJson } from '../libs/http.ts'
import { failRead, readSourceUnavailable } from './view.ts'

/** The action the `/singularity/graphs` dispatcher serves for history; it owns one graph id and its response. */
export type GraphAction = (id: string, req: IncomingMessage, res: ServerResponse) => Promise<void>

/** The file names one library's old evolution ledger may carry, newest writing first. */
function legacyEvolutionFiles(roots: string): readonly string[] {
  return [join(roots, 'evolution', 'proposals.jsonl'), join(roots, 'methods.jsonl')]
}

/**
 * One candidate file's legacy projection, or none when the file is not a legacy
 * ledger at all: a v5 file belongs to the current protocol, so it is neither
 * folded here nor allowed to refuse the history the sealed graph does hold.
 */
async function legacyLedgerOf(file: string): Promise<readonly unknown[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  if (text.split('\n').some(line => line.includes('"formatVersion":5'))) return []
  return readLegacyMethodsSync(text)
}

/** The old review ledger the pre-protocol rounds wrote their completion notes into. */
function legacyCompletionsFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'review-agents', 'agents.jsonl')
}

/** One old-ledger row as a legacy completion row, or nothing when the row carries no settled note. */
export function legacyCompletionOf(row: unknown, graphKey?: string): LegacyCompletionWire | undefined {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  const record = row as Record<string, unknown>
  if (record.kind !== 'settled') return undefined
  const note = record.note
  if (typeof note !== 'string' || note.trim().length === 0) return undefined
  if (typeof record.taskId !== 'string' || typeof record.sessionId !== 'string') return undefined
  if (graphKey !== undefined && typeof record.rootStoreId === 'string' && record.rootStoreId !== graphKey) return undefined
  return {
    format: 'legacy-v1',
    sessionId: record.sessionId,
    taskId: record.taskId,
    note,
    recordedAt: typeof record.at === 'string' ? record.at : '',
  }
}

/** Every legacy completion row one old ledger holds; a file that does not exist holds none. */
export async function legacyCompletionsOf(file: string, graphKey: string): Promise<readonly LegacyCompletionWire[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const rows: LegacyCompletionWire[] = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim().length === 0) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      throw new Error(`singularity/history: corrupt ledger line ${index + 1} in the legacy review ledger`)
    }
    const row = legacyCompletionOf(raw, graphKey)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

/**
 * The read doors one legacy history draws on: the registry, the graph and layout
 * services' zero-write doors, the task service's own, and the old ledgers whose
 * files this deployment may still keep.
 */
export function legacyReadDeps(ctx: Context, rootSessionId: string): LegacyReadDeps {
  const task = optionalService<TaskService>(ctx, 'task')
  if (task === undefined) {
    throw readSourceUnavailable(
      'task',
      "singularity/history: this deployment mounts no task store, so a legacy graph's task store cannot be read",
    )
  }
  const runtime = optionalService<TaskRuntime>(ctx, 'taskRuntime')
  const libraryRoot = runtime === undefined ? undefined : libraryRoots(rootSessionId, environmentHomeOf(runtime)).root
  return {
    graph: ctx.graph,
    layout: ctx.layout,
    task,
    ...(libraryRoot === undefined
      ? {}
      : {
          legacyEvolution: async () => {
            for (const file of legacyEvolutionFiles(libraryRoot)) {
              const proposals = await legacyLedgerOf(file)
              if (proposals.length > 0) return { proposals, experiments: [] }
            }
            return { proposals: [], experiments: [] }
          },
        }),
    legacyCompletions: async key => await legacyCompletionsOf(legacyCompletionsFile(), key),
  }
}

/**
 * The history read for one graph: a current-protocol graph is refused with a
 * pointer to the view route, a sealed one is projected verbatim and answered
 * `writable: false`.
 */
export function registerHistory(ctx: Context): GraphAction {
  return async (id, _req, res) => {
    try {
      const graph = await ctx.graphs.get(id)
      // A current-protocol graph is not history: it is refused before a single
      // store is opened, so nothing is read on a route that cannot serve it.
      if (graphAccessWire(graph).mode === 'current') {
        sendJson(res, 409, {
          error: 'graph-not-sealed',
          graphId: id,
          view: `/singularity/view?graphId=${encodeURIComponent(id)}`,
        })
        return
      }
      sendJson(res, 200, await readLegacyGraph(legacyReadDeps(ctx, String(graph.rootSessionId)), graph))
    } catch (error) {
      failRead(res, error)
    }
  }
}
