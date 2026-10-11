import { expect, it } from 'vitest'
const { campaignPrompt, campaignBudget, nativeAccounting }: {
  campaignPrompt(stage: string, round?: number): string
  campaignBudget: { rootSolves: number; children: number; childRuns: number; nativeTokens: number }
  nativeAccounting(sessions: readonly { sessionId: string; events: readonly unknown[] }[]): { tokens: number | null; unknown: readonly { sessionId: string; seq: number }[] }
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
