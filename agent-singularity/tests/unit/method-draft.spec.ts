/**
 * `method_draft` against a real environment library and the real v5 ledger: what
 * it refuses without writing anything, and what one accepted candidate leaves
 * behind.
 */
import { describe, expect, it } from 'vitest'
import { defineMethodDraftTool } from '../../src/tools/method-draft.ts'
import { DECLARED_EDIT, skillPayload, skillText, methodWorld } from './method-tools.fixture.ts'

const draftTool = (ctx: never) => defineMethodDraftTool(ctx)

describe('method_draft', () => {
  it('refuses a candidate written against a base revision the pointer has left, and writes nothing', async () => {
    const world = await methodWorld()
    try {
      const answer = (await draftTool(world.ctx as never).execute(
        {
          kind: 'skill',
          identity: 'verify',
          edits: [DECLARED_EDIT],
          editPayload: skillPayload('# candidate'),
          rationale: 'answer the observed failure',
          sourceRefs: ['diagnosis:d1'],
          expectedBaseRevision: 'r9999',
          round: 0,
          critic: { verdict: 'accept', reason: 'structure and hypothesis hold', evidenceRefs: ['diagnosis:d1'] },
        },
        world.exec as never,
      )) as string
      expect(answer).toContain('method_draft rejected')
      expect(answer).toContain('r9999')
      expect(world.calls.createDraft).toBeUndefined()
      expect(await world.ledgerText()).toBe('')
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 1 })
    } finally {
      await world.dispose()
    }
  })

  it('refuses more independent edits than the round budget allows, before any draft exists', async () => {
    const world = await methodWorld()
    try {
      const answer = (await draftTool(world.ctx as never).execute(
        {
          kind: 'skill',
          identity: 'verify',
          edits: [DECLARED_EDIT, { ...DECLARED_EDIT, id: 'e2', mechanism: 'text' }],
          editPayload: skillPayload('# candidate'),
          rationale: 'two mechanisms at once',
          sourceRefs: ['diagnosis:d1'],
          expectedBaseRevision: 'r0001',
          // The last round's budget is exactly one edit.
          round: 19,
          critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
        },
        world.exec as never,
      )) as string
      expect(answer).toContain('exceed the round 19 budget of 1')
      expect(answer).toContain('no evaluation budget was consumed')
      expect(world.calls.createDraft).toBeUndefined()
      expect(await world.ledgerText()).toBe('')
    } finally {
      await world.dispose()
    }
  })

  it('refuses a candidate with no independent critic, names that absence, and records nothing', async () => {
    const world = await methodWorld()
    try {
      const answer = (await draftTool(world.ctx as never).execute(
        {
          kind: 'skill',
          identity: 'verify',
          edits: [DECLARED_EDIT],
          editPayload: skillPayload('# candidate'),
          rationale: 'no critic available this round',
          sourceRefs: ['diagnosis:d1'],
          expectedBaseRevision: 'r0001',
          round: 0,
        },
        world.exec as never,
      )) as string
      expect(answer).toContain('critic-missing')
      expect(answer).toContain('This round carries no independent critic verdict')
      expect(world.calls.createDraft).toBe(1)
      expect(await world.ledgerText()).toBe('')
      // The refused draft directory is gone: a screened-out candidate leaves no
      // half-written region behind.
      const drafts = await world.draft('d0001')
      expect(drafts).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })

  it('records one accepted candidate as a draft line and leaves the pointer alone', async () => {
    const world = await methodWorld()
    try {
      const answer = (await draftTool(world.ctx as never).execute(
        {
          kind: 'skill',
          identity: 'verify',
          edits: [DECLARED_EDIT],
          editPayload: skillPayload('# candidate: verify the acceptance'),
          rationale: 'the observed failure is a missing check',
          sourceRefs: ['diagnosis:d1', 'task:t1#r1'],
          expectedBaseRevision: 'r0001',
          round: 0,
          critic: { verdict: 'accept', reason: 'the hypothesis is one mechanism and the asset parses', evidenceRefs: ['diagnosis:d1'] },
        },
        world.exec as never,
      )) as string
      expect(answer).toContain('recorded as draft d0001')
      expect(answer).toContain('bundle level: no')
      expect(answer).toContain('no production change; next: method_evaluate')
      const lines = (await world.ledgerText()).trim().split('\n').map(line => JSON.parse(line) as { kind: string; draftId?: string })
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ kind: 'draft', draftId: 'd0001' })
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 1 })
      expect(world.calls.publishRevision).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })

  it('refuses a candidate whose asset does not parse, naming the structural finding', async () => {
    const world = await methodWorld()
    try {
      const answer = (await draftTool(world.ctx as never).execute(
        {
          kind: 'skill',
          identity: 'verify',
          edits: [DECLARED_EDIT],
          editPayload: skillPayload('# wrong name', 'other'),
          rationale: 'a candidate the adapter cannot represent',
          sourceRefs: ['diagnosis:d1'],
          expectedBaseRevision: 'r0001',
          round: 0,
          critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
        },
        world.exec as never,
      )) as string
      expect(answer).toContain('method_draft rejected')
      expect(answer).toContain('frontmatter name must match')
      expect(await world.ledgerText()).toBe('')
    } finally {
      await world.dispose()
    }
  })

  it('refuses a capability row that grants a skill the candidate does not carry, as a structure finding', async () => {
    const world = await methodWorld()
    try {
      const answer = (await draftTool(world.ctx as never).execute(
        {
          kind: 'capability',
          identity: 'method:verify',
          edits: [{ ...DECLARED_EDIT, mechanism: 'capability' }],
          editPayload: JSON.stringify({ entry: { skills: ['verify'], tools: ['skill'] } }),
          rationale: 'a row whose provider the candidate does not carry',
          sourceRefs: ['diagnosis:d1'],
          expectedBaseRevision: 'r0001',
          round: 0,
          critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
        },
        world.exec as never,
      )) as string
      expect(answer).toContain('structure-failed')
      expect(answer).toContain('holds no skill')
      expect(await world.ledgerText()).toBe('')
      expect(await world.draft('d0001')).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })

  it('refuses an undeclared parameter rather than ignoring it', async () => {
    const world = await methodWorld()
    try {
      const answer = (await draftTool(world.ctx as never).execute(
        { kind: 'skill', identity: 'verify', edits: [DECLARED_EDIT], editPayload: skillPayload('# c'), rationale: 'r', sourceRefs: ['d:1'], expectedBaseRevision: 'r0001', round: 0, approved: true },
        world.exec as never,
      )) as string
      expect(answer).toContain('undeclared parameter')
      expect(await world.ledgerText()).toBe('')
    } finally {
      await world.dispose()
    }
  })
})
