import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const { nextCampaignStep } = await import(fileURLToPath(new URL('../scripts/rsi-campaign.mjs', import.meta.url)))
const reference = { revisionId: 'published', digest: '1'.repeat(64) }
const state = { rounds: 5, iterations: [{ sessionId: 'fresh-root-session' }] }
const snapshot = (status: string, method = reference) => ({
  tasks: [{ taskId: 'root', sessionId: 'fresh-root-session', rsi: { status, detail: 'report settled' } }],
  methods: [{ published: true, reference: method }, { published: false, reference: { revisionId: 'rejected' } }],
})

it('waits for the full RSI report, then starts a fresh root with the published method only', () => {
  for (const status of ['pending', 'running']) expect(nextCampaignStep(state, snapshot(status))).toEqual({ kind: 'wait' })
  expect(nextCampaignStep(state, { tasks: [], methods: [] })).toEqual({ kind: 'wait' })
  expect(nextCampaignStep(state, snapshot('completed'))).toEqual({ kind: 'start', previousRootId: 'root', method: reference })
  const winner = { revisionId: 'new-winner', digest: '2'.repeat(64) }
  expect(nextCampaignStep(state, snapshot('completed', winner)).method).toEqual(winner)
  expect(nextCampaignStep({ rounds: 5, iterations: [] }, snapshot('running'))).toEqual({ kind: 'start', method: reference })
})

it('finishes only at the requested count, and surfaces RSI failures without starting another root', () => {
  expect(nextCampaignStep({ ...state, rounds: 1 }, snapshot('completed'))).toEqual({ kind: 'complete', rootId: 'root' })
  expect(() => nextCampaignStep(state, snapshot('failed'))).toThrow('RSI failed')
  expect(() => nextCampaignStep(state, snapshot('cancelled'))).toThrow('RSI cancelled')
  expect(() => nextCampaignStep(state, { ...snapshot('completed'), methods: [] })).toThrow('No published method')
})
