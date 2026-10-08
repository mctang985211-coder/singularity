/**
 * `method_list`: the one read of the method's state, and a pure one — no
 * environment write is reached and the effective pointer is never moved.
 */
import { describe, expect, it } from 'vitest'
import { defineMethodListTool } from '../../src/tools/method-list.ts'
import { defineMethodDraftTool } from '../../src/tools/method-draft.ts'
import { DECLARED_EDIT, methodWorld, skillPayload } from './method-tools.fixture.ts'

const listTool = (ctx: never) => defineMethodListTool(ctx)

async function draftOne(world: Awaited<ReturnType<typeof methodWorld>>): Promise<void> {
  await defineMethodDraftTool(world.ctx as never).execute(
    {
      kind: 'skill',
      identity: 'verify',
      edits: [DECLARED_EDIT],
      editPayload: skillPayload('# candidate'),
      rationale: 'a candidate to list',
      sourceRefs: ['diagnosis:d1'],
      expectedBaseRevision: 'r0001',
      round: 0,
      critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
    },
    world.exec as never,
  )
}

describe('method_list', () => {
  it('reports the active version, the mode, the drafts and the search state without writing anything', async () => {
    const world = await methodWorld({ humanReview: false })
    try {
      await draftOne(world)
      const answer = (await listTool(world.ctx as never).execute({}, world.exec as never)) as string
      expect(answer).toContain('method state — library g1 (environment-revision)')
      expect(answer).toContain('active revision r0001 g1')
      expect(answer).toContain('mode auto; policy rrsi-strategy@1')
      expect(answer).toContain('drafts (1)')
      expect(answer).toContain('- d0001 [draft] skill verify candidate')
      expect(answer).toContain('history: nothing measured yet')
      expect(answer).toContain('trial: no Run is explicitly trying a candidate')
      expect(answer).toContain('next: method_draft')
      // A pure read: no environment write was reached and the pointer stands.
      expect(world.calls.createDraft).toBe(1)
      expect(world.calls.publishRevision).toBeUndefined()
      expect(world.calls.removeEnvironmentDraft).toBeUndefined()
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 1 })
    } finally {
      await world.dispose()
    }
  })

  it('shows a candidate an explicit trial binds, separately from the effective revision', async () => {
    const world = await methodWorld({ runs: [{ runId: 'run-9', trialCandidateRef: 'd0001' }] })
    try {
      await draftOne(world)
      const answer = (await listTool(world.ctx as never).execute({}, world.exec as never)) as string
      expect(answer).toContain('(tried by 1 run(s): run-9)')
      expect(answer).toContain('trial: d0001 tried by run-9 (a trial never moves the active revision)')
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 1 })
    } finally {
      await world.dispose()
    }
  })

  it('filters by kind, status and identity without changing what the pointer says', async () => {
    const world = await methodWorld()
    try {
      await draftOne(world)
      expect(await listTool(world.ctx as never).execute({ kind: 'capability' }, world.exec as never)).toContain('drafts (0)')
      expect(await listTool(world.ctx as never).execute({ status: 'evaluated' }, world.exec as never)).toContain('drafts (0)')
      expect(await listTool(world.ctx as never).execute({ identity: 'verify' }, world.exec as never)).toContain('drafts (1)')
    } finally {
      await world.dispose()
    }
  })

  it('reads a read-only library without refusing: a sealed graph is still legible', async () => {
    const world = await methodWorld({ readOnly: true })
    try {
      const answer = (await listTool(world.ctx as never).execute({}, world.exec as never)) as string
      expect(answer).toContain('[read-only]')
    } finally {
      await world.dispose()
    }
  })

  it('refuses an undeclared parameter rather than ignoring it', async () => {
    const world = await methodWorld()
    try {
      expect(await listTool(world.ctx as never).execute({ everything: true }, world.exec as never)).toContain('undeclared parameter')
    } finally {
      await world.dispose()
    }
  })
})
