import { describe, expect, it, vi } from 'vitest'
import { defineEvolutionDecideTool } from '../../src/tools/evolution-decide.ts'
import { defineEvolutionApplyTool } from '../../src/tools/evolution-apply.ts'

function fixture(policy: 'ask' | 'auto' = 'ask', answer = 'allowed-once') {
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
  const ctx = { evolution, approval, get: (name: string) => name === 'singularityEvolution' ? { publicationApproval: policy } : undefined }
  const exec = { agent: { id: 'supervisor' }, callId: 'call-1', signal: new AbortController().signal }
  return { ctx: ctx as never, exec: exec as never, proposal, evolution, approval }
}

describe('Evolution model decision and publication authorization', () => {
  it('records PROMOTE without an approval, then asks once for the exact publication', async () => {
    const f = fixture()
    expect(await defineEvolutionDecideTool(f.ctx).execute({ proposalId: 'p-method', decision: 'PROMOTE' }, f.exec)).toContain('[decided] PROMOTE')
    expect(f.evolution.decide).toHaveBeenCalledWith('p-method', 'PROMOTE', 'supervisor', 'decision:call-1', undefined)
    expect(f.approval.request).not.toHaveBeenCalled()
    expect(f.evolution.apply).not.toHaveBeenCalled()
    expect(await defineEvolutionApplyTool(f.ctx).execute({ proposalId: 'p-method' }, f.exec)).toContain('[applied]')
    expect(f.approval.request).toHaveBeenCalledOnce()
    expect(f.approval.request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'evolution_apply', reason: expect.stringContaining('candidate bytes') }))
    expect(f.approval.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('sandbox/p-method/replay-report.json') }))
    expect(f.evolution.apply).toHaveBeenCalledWith('p-method', 'supervisor', 'approval:call-1')
  })

  it('records explicit deployment preauthorization while retaining promotion and production-baseline checks', async () => {
    const f = fixture('auto', 'rejected')
    await defineEvolutionDecideTool(f.ctx).execute({ proposalId: 'p-method', decision: 'PROMOTE' }, f.exec)
    expect(await defineEvolutionApplyTool(f.ctx).execute({ proposalId: 'p-method' }, f.exec)).toContain('preauthorized:singularity-agent.publicationApproval=auto:call-1')
    expect(f.approval.request).not.toHaveBeenCalled()
    expect(f.evolution.checkPromotion).toHaveBeenCalled()
    expect(f.evolution.checkProductionBaseline).toHaveBeenCalledOnce()
    expect(f.evolution.apply).toHaveBeenCalledWith('p-method', 'supervisor', 'preauthorized:singularity-agent.publicationApproval=auto:call-1')
  })

  it('keeps a refused publication decided and performs no production write', async () => {
    const f = fixture('ask', 'rejected')
    await defineEvolutionDecideTool(f.ctx).execute({ proposalId: 'p-method', decision: 'PROMOTE' }, f.exec)
    expect(await defineEvolutionApplyTool(f.ctx).execute({ proposalId: 'p-method' }, f.exec)).toContain('nothing written')
    expect(f.proposal.status).toBe('decided')
    expect(f.evolution.apply).not.toHaveBeenCalled()
  })
})
