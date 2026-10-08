/**
 * `method_discard`: closing a candidate asks nobody, records why, removes the
 * working directory and never touches the effective pointer.
 */
import { describe, expect, it } from 'vitest'
import { defineMethodDiscardTool } from '../../src/tools/method-discard.ts'
import { DECLARED_EDIT, forgeEvaluation, methodWorld, skillPayload } from './method-tools.fixture.ts'
import { defineMethodDraftTool } from '../../src/tools/method-draft.ts'

const discardTool = (ctx: never) => defineMethodDiscardTool(ctx)

async function draftOne(world: Awaited<ReturnType<typeof methodWorld>>, body = '# candidate'): Promise<void> {
  await defineMethodDraftTool(world.ctx as never).execute(
    {
      kind: 'skill',
      identity: 'verify',
      edits: [DECLARED_EDIT],
      editPayload: skillPayload(body),
      rationale: 'a candidate to close',
      sourceRefs: ['diagnosis:d1'],
      expectedBaseRevision: 'r0001',
      round: 0,
      critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
    },
    world.exec as never,
  )
}

describe('method_discard', () => {
  it('records the refusal, removes the draft directory, asks nobody and leaves the pointer alone', async () => {
    const world = await methodWorld()
    try {
      await draftOne(world)
      const answer = (await discardTool(world.ctx as never).execute(
        { draftId: 'd0001', outcome: 'unmeasured-declined', reason: 'the model found the hypothesis already covered' },
        world.exec as never,
      )) as string
      expect(answer).toContain('discarded skill verify (draft d0001) as unmeasured-declined')
      expect(answer).toContain('never measured')
      expect(answer).toContain('no approval was required')
      expect(answer).toContain('the draft working directory was removed')
      expect(world.approvals).toHaveLength(0)
      expect(await world.draft('d0001')).toBeUndefined()
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 1 })
      const lines = (await world.ledgerText()).trim().split('\n').map(line => JSON.parse(line) as { kind: string; reason?: string })
      expect(lines.map(line => line.kind)).toEqual(['draft', 'discard'])
      expect(lines[1]!.reason).toContain('unmeasured-declined: the model found the hypothesis already covered')
    } finally {
      await world.dispose()
    }
  })

  it('refuses a falsified candidate with no evidence to cite', async () => {
    const world = await methodWorld()
    try {
      await draftOne(world)
      const answer = (await discardTool(world.ctx as never).execute(
        { draftId: 'd0001', outcome: 'falsified', reason: 'the mechanism cannot hold' },
        world.exec as never,
      )) as string
      expect(answer).toContain('must cite the evidenceRefs that falsified it')
      expect((await world.ledgerText()).trim().split('\n')).toHaveLength(1)
    } finally {
      await world.dispose()
    }
  })

  it('refuses a draft that is already discarded, naming the recorded reason', async () => {
    const world = await methodWorld()
    try {
      await draftOne(world)
      await discardTool(world.ctx as never).execute({ draftId: 'd0001', outcome: 'pruned', reason: 'first' }, world.exec as never)
      const answer = (await discardTool(world.ctx as never).execute(
        { draftId: 'd0001', outcome: 'pruned', reason: 'again' },
        world.exec as never,
      )) as string
      expect(answer).toContain('is already discarded')
      expect((await world.ledgerText()).trim().split('\n')).toHaveLength(2)
    } finally {
      await world.dispose()
    }
  })

  it('keeps a measured refusal on the ledger as the evidence the candidate was refused on', async () => {
    const world = await methodWorld()
    try {
      const forged = await forgeEvaluation(world, { cost: 'unknown' })
      const answer = (await discardTool(world.ctx as never).execute(
        { draftId: forged.draftId, outcome: 'measured-rejected', reason: 'cost inconclusive' },
        world.exec as never,
      )) as string
      expect(answer).toContain(`the evaluation ${forged.evaluationId} stays on the ledger`)
      expect(world.approvals).toHaveLength(0)
    } finally {
      await world.dispose()
    }
  })

  it('names the outcome vocabulary rather than accepting an arbitrary one', async () => {
    const world = await methodWorld()
    try {
      await expect(discardTool(world.ctx as never).execute({ draftId: 'd0001', outcome: 'gone', reason: 'x' }, world.exec as never)).rejects.toThrow(/must be one of/)
    } finally {
      await world.dispose()
    }
  })
})
