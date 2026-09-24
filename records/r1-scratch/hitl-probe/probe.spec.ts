/**
 * Model-free probe: execute the real hitl_ask tool through the registry with a
 * live root agent, to locate where the S3 scenario's `Error: cannot get property
 * "toJSON" without inject` came from. No model call is made.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startR1Stack } from './r1-stack.ts'

describe('hitl_ask seam probe', () => {
  it('executes the real hitl_ask with the fixture desk', async () => {
    const base = '/home/ROXY/code/bb_work/r1-probe-run'
    rmSync(base, { recursive: true, force: true })
    const repo = join(base, 'repo')
    const home = join(base, 'dsh-home')
    mkdirSync(repo, { recursive: true })
    mkdirSync(join(home, 'skills'), { recursive: true })
    const stack = await startR1Stack({
      scenario: 'probe',
      home,
      repo,
      humanAnswer: (seam, asked) => {
        if (seam === 'approval') return 'allowed-once'
        const request = asked as { questions?: readonly { id?: string }[] }
        return { answers: (request.questions ?? []).map(q => ({ id: String(q.id ?? 'q'), selected: [], custom: 'No data was provided; state that explicitly.' })) }
      },
    })
    try {
      const agent = stack.rootAgent()
      const result = await stack.ctx.tools.execute({
        callId: 'probe-hitl-1' as never,
        name: 'hitl_ask',
        arguments: { prompt: 'probe: which quarter?' },
        agent: agent as never,
        signal: new AbortController().signal,
      })
      console.log('hitl_ask result isError=', result.isError, 'text=', JSON.stringify((result.content ?? []).map(b => (b as { text?: string }).text).join('\n')))
      console.log('recorded humanQuestions=', JSON.stringify(stack.humanQuestions()))
      expect(result.isError).toBe(false)
    } finally {
      await stack.dispose()
    }
  }, 120_000)
})
