/** One piece of platform work run off the caller's path. @module @dangosys/dsh-singularity-agent/trigger */

import { message } from '../shared.ts'

/** Run one scan off the caller's path; a rejection is a line under `label`, never a throw nobody awaits. */
export function backgroundScan(log: (line: string) => void, label: string, work: () => Promise<unknown>): void {
  void work().catch((error: unknown) => {
    log(`${label}: the scan could not run (${message(error)})`)
  })
}
