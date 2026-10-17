import { expect, it } from 'vitest'
import { parseRsiProposal } from '../src/rsi-proposal.ts'
import type { MethodAssets } from '../src/method.ts'
import { rsiProposal } from './rsi-fixture.ts'

const baseline: MethodAssets = { rootTemplate: 'root', templates: [{ id: 'root', guidance: 'Inspect inputs.' }], skills: [], tools: [] }
function fixture() {
  const method: MethodAssets = { ...baseline, templates: [{ id: 'root', guidance: 'Reuse an inspection only when its frozen input identity matches.' }] }
  return rsiProposal(baseline, method, 'task', 'session')
}

it('requires evidenced analysis, an attributable diff and corrective/preservative/transfer counterfactuals', () => {
  const proposal = fixture()
  expect(parseRsiProposal(proposal, baseline)).toEqual(proposal)
  expect(() => parseRsiProposal(proposal.method, baseline)).toThrow('RSI proposal')
  for (const field of ['corrective', 'preservative', 'transfer'] as const) {
    const invalid = { ...proposal, edit: { ...proposal.edit,
      retroactive_check: { ...proposal.edit.retroactive_check, [field]: '' } } }
    expect(() => parseRsiProposal(invalid, baseline)).toThrow(`retroactive_check.${field}`)
  }
})

it('rejects unsupported mechanisms, missing success protection, empty evidence and undeclared changes', () => {
  const proposal = fixture()
  expect(() => parseRsiProposal({ ...proposal, edit: { ...proposal.edit, targets_mode: 'not_in_analysis' } }, baseline)).toThrow('evidenced mode')
  expect(() => parseRsiProposal({ ...proposal, analysis: { ...proposal.analysis, success_habits: [] } }, baseline)).toThrow('success habit')
  expect(() => parseRsiProposal({ ...proposal, analysis: { ...proposal.analysis,
    failure_modes: [{ ...proposal.analysis.failure_modes[0], evidence: [] }] } }, baseline)).toThrow('native evidence')
  expect(() => parseRsiProposal({ ...proposal, edit: { ...proposal.edit, changes: [] } }, baseline)).toThrow('actual method diff')
  expect(() => parseRsiProposal({ ...proposal, method: baseline }, baseline)).toThrow('actual method diff')
})
