/** The trigger shape both automatic scans install: work off the caller's path, and a graph that becomes active as the moment to run it. @module @dangosys/dsh-singularity-agent/trigger */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-graphs'
import { message } from '../shared.ts'

/** Run one scan off the caller's path; a rejection is a line under `label`, never a throw nobody awaits. */
export function backgroundScan(log: (line: string) => void, label: string, work: () => Promise<unknown>): void {
  void work().catch((error: unknown) => {
    log(`${label}: the scan could not run (${message(error)})`)
  })
}

/** Install one deployment's graph-activation scan: a graph that becomes active has `work` run for it in the background. */
export function installGraphSelectedScan(
  ctx: Context,
  options: { readonly log: (line: string) => void; readonly label: string },
  work: (graph: { readonly rootSessionId: string }) => Promise<unknown>,
): () => void {
  const dispose = ctx.on('graphs/selected', graph => {
    backgroundScan(options.log, options.label, () => work(graph))
  })
  return () => dispose()
}
