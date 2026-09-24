/** Pinpoint which member of the ask request breaks JSON.stringify. No model call. */
import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startR1Stack } from './r1-stack.ts'

describe('stringify probe', () => {
  it('finds the member whose toJSON access throws', async () => {
    const base = '/home/ROXY/code/bb_work/r1-probe-run2'
    rmSync(base, { recursive: true, force: true })
    const repo = join(base, 'repo')
    const home = join(base, 'dsh-home')
    mkdirSync(repo, { recursive: true })
    mkdirSync(join(home, 'skills'), { recursive: true })
    const stack = await startR1Stack({ scenario: 'probe2', home, repo, humanAnswer: () => ({ answers: [] }) })
    try {
      const agent = stack.rootAgent() as Record<string, unknown>
      const signal = new AbortController().signal
      for (const [name, value] of [['questions', [{ id: 'q', question: 'x' }]], ['agent', agent], ['signal', signal]] as const) {
        try {
          JSON.stringify(value)
          console.log(`stringify(${name}): ok`)
        } catch (error) {
          console.log(`stringify(${name}): THROWS ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // And what the tool itself passes: a plain object holding the agent.
      try {
        JSON.stringify({ questions: [{ id: 'hitl-ask', question: 'x' }], agent, signal })
        console.log('stringify(request-shape): ok')
      } catch (error) {
        console.log(`stringify(request-shape): THROWS ${error instanceof Error ? error.message : String(error)}`)
      }
      expect(true).toBe(true)
    } finally {
      await stack.dispose()
    }
  }, 120_000)
})
