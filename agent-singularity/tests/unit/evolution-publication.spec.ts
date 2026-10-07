import { describe, expect, it, vi } from 'vitest'
import { defineEvolutionDecideTool } from '../../src/tools/evolution-decide.ts'
import { defineEvolutionApplyTool } from '../../src/tools/evolution-apply.ts'

function fixture(answer = 'allowed-once') {
  const proposal = { proposalId: 'p-method', status: 'gated', targetType: 'skill', targetId: 'method', level: 'L2',
    mutation: { name: 'method', content: 'candidate bytes' }, sourceRefs: [], baseVersion: 'v1', rationale: 'measured improvement',
    versionSet: { skill: 'v2' }, gate: { regressionEvidenceRefs: ['sandbox/p-method/replay-report.json'], targetFailureFixed: 'two-sided real outcome improved' } }
  const evolution = {
    skillRoot: '/methods',
    get: vi.fn(async () => proposal),
    checkPromotion: vi.fn(async () => ({ providers: [] })),
    checkProductionBaseline: vi.fn(async () => {}),
    decide: vi.fn(async (_id, decision) => Object.assign(proposal, { status: 'decided', decision })),
    apply: vi.fn(async () => ({ proposal: Object.assign(proposal, { status: 'applied' }), targets: ['/methods/method/SKILL.md'], providers: [] })),
  }
  const approval = { request: vi.fn(async () => answer) }
  // No `singularityEvolution` exposure is mounted: the approval is not gated on a deployment policy anymore.
  const ctx = { evolution, approval, get: () => undefined }
  const exec = { agent: { id: 'supervisor' }, callId: 'call-1', signal: new AbortController().signal }
  return { ctx: ctx as never, exec: exec as never, proposal, evolution, approval }
}

describe('Evolution model decision and production authorization', () => {
  it('asks for the decision itself, then asks once more for the exact publication', async () => {
    const f = fixture()
    expect(await defineEvolutionDecideTool(f.ctx).execute({ proposalId: 'p-method', decision: 'PROMOTE' }, f.exec)).toContain('[decided] PROMOTE')

    // The decision travels through the native approval seam under its own call id, and never in the model's own name.
    expect(f.approval.request).toHaveBeenCalledOnce()
    expect(f.approval.request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'evolution_decide', callId: 'call-1' }))
    expect(f.approval.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('proposed decision: PROMOTE') }))
    expect(f.approval.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('measured improvement') }))
    expect(f.evolution.decide).toHaveBeenCalledWith('p-method', 'PROMOTE', 'supervisor', 'approval:call-1', undefined)
    expect(f.evolution.apply).not.toHaveBeenCalled()

    expect(await defineEvolutionApplyTool(f.ctx).execute({ proposalId: 'p-method' }, f.exec)).toContain('[applied]')
    expect(f.approval.request).toHaveBeenCalledTimes(2)
    expect(f.approval.request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'evolution_apply', reason: expect.stringContaining('candidate bytes') }))
    expect(f.approval.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('sandbox/p-method/replay-report.json') }))
    expect(f.evolution.apply).toHaveBeenCalledWith('p-method', 'supervisor', 'approval:call-1')
  })

  it('records no decision when the human refuses it, before anything is written', async () => {
    const f = fixture('rejected')
    const refused = (await defineEvolutionDecideTool(f.ctx).execute({ proposalId: 'p-method', decision: 'PROMOTE' }, f.exec)) as string
    expect(f.approval.request).toHaveBeenCalledOnce()
    expect(refused).toContain('no decision recorded')
    expect(refused).toContain('stays gated')
    expect(f.evolution.decide).not.toHaveBeenCalled()
    expect(f.proposal.status).toBe('gated')
  })

  it('keeps a refused publication decided and performs no production write', async () => {
    const f = fixture('allowed-once')
    await defineEvolutionDecideTool(f.ctx).execute({ proposalId: 'p-method', decision: 'PROMOTE' }, f.exec)
    f.approval.request.mockResolvedValue('rejected')
    expect(await defineEvolutionApplyTool(f.ctx).execute({ proposalId: 'p-method' }, f.exec)).toContain('nothing written')
    expect(f.proposal.status).toBe('decided')
    expect(f.evolution.apply).not.toHaveBeenCalled()
  })

  it.each(['cancelled', 'unavailable'])('asks for the publication regardless of any deployment policy, and refuses %s without a write', async outcome => {
    const f = fixture(outcome)
    Object.assign(f.proposal, { status: 'decided', decision: 'PROMOTE' })
    const result = (await defineEvolutionApplyTool(f.ctx).execute({ proposalId: 'p-method' }, f.exec)) as string
    expect(f.approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('nothing written')
    expect(f.evolution.checkPromotion).toHaveBeenCalled()
    expect(f.evolution.checkProductionBaseline).toHaveBeenCalledOnce()
    expect(f.evolution.apply).not.toHaveBeenCalled()
  })
})
