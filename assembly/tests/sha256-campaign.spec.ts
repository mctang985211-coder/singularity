import { expect, it } from 'vitest'
const { campaignPrompt, campaignBudget, nativeAccounting, stageWitness, comparisonSummary }: {
  campaignPrompt(stage: string, round?: number): string
  campaignBudget: { rootSolves: number; children: number; childRuns: number; nativeTokens: number }
  nativeAccounting(sessions: readonly { sessionId: string; events: readonly unknown[] }[]): { tokens: number | null; unknown: readonly { sessionId: string; seq: number }[] }
  stageWitness(sessions: readonly unknown[], cutoff: ReadonlyMap<string, number>, prompt: string): { entered: boolean; finished: boolean }
  comparisonSummary(trials: readonly unknown[]): { outcome: string; incumbent: { functionalPassRate: number }; relativeAreaChange: number }
} = await import(new URL('../../scripts/sha256-campaign.mjs', import.meta.url).href)

it('starts from a real design requirement without supplying a solution or Method assets', () => {
  const prompt = campaignPrompt('explore')
  expect(prompt).toContain('singularity_propose_task')
  expect(prompt).toContain('sha256_w_mem')
  expect(prompt).toContain('same goal')
  expect(prompt).not.toContain('module sha256_w_mem(')
  expect(prompt).not.toContain('good1')
  expect(prompt).not.toContain('baseline-plus-one')
  expect(campaignBudget).toEqual({ rootSolves: 28, children: 2, childRuns: 2, nativeTokens: 1500000 })
})
it('ignores prior ended turns until the exact new input crosses its native cutoff', () => {
  const prior = { sessionId: 's', events: [{ seq: 0, type: 'turn/end' }] }
  const cutoff = new Map([['s', 1]])
  expect(stageWitness([prior], cutoff, 'new')).toEqual({ entered: false, finished: false })
  prior.events.push({ seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'new' }] } } as never)
  expect(stageWitness([prior], cutoff, 'new')).toEqual({ entered: true, finished: false })
  prior.events.push({ seq: 2, type: 'turn/end' })
  expect(stageWitness([prior], cutoff, 'new')).toEqual({ entered: true, finished: true })
})
it('reports real area improvement only outside the declared band with full functional acceptance', () => {
  const trials = ['incumbent', 'published'].flatMap(label => [1, 2].map(trial => ({ label, trial,
    receipt: { status: 'verified' }, area: label === 'incumbent' ? 100 : 98, accounting: { tokens: 10 } })))
  expect(comparisonSummary(trials)).toMatchObject({ outcome: 'improved', relativeAreaChange: -0.02, incumbent: { functionalPassRate: 1 } })
  trials[2]!.receipt.status = 'failed'
  expect(comparisonSummary(trials).outcome).toBe('not-improved')
  trials[2]!.receipt.status = 'verified'
  trials[2]!.area = trials[3]!.area = 99.5
  expect(comparisonSummary(trials).outcome).toBe('not-improved')
})
it('requires real exploration history before the model creates its own methods', () => {
  for (const round of [1, 2]) {
    const prompt = campaignPrompt('round', round)
    expect(prompt.indexOf('singularity_method_history')).toBeLessThan(prompt.indexOf('singularity_create_method'))
    expect(prompt).toContain('two distinct candidates')
    expect(prompt).toContain('Do not fabricate a failing baseline')
    expect(prompt).toContain('Do not release')
  }
})
it('counts unsuccessful native provider attempts and reports missing usage as unknown', () => {
  const sessions = [{ sessionId: 's', events: [
    { type: 'assistant/message', seq: 0, data: { usage: { totalTokens: 10 } } },
    { type: 'assistant/attempt', seq: 1, data: { stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { totalTokens: 5 } } }] } },
  ] }]
  expect(nativeAccounting(sessions)).toEqual({ tokens: 15, unknown: [] })
  sessions[0]!.events.push({ type: 'assistant/attempt', seq: 2, data: { stream: [] } })
  expect(nativeAccounting(sessions)).toEqual({ tokens: null, unknown: [{ sessionId: 's', seq: 2 }] })
})
