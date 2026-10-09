/**
 * `method_publish` against a real library and the real ledger: the pointer
 * compare-and-swap, what a candidate the frozen strategy refused does (and does
 * not) consume, and that a candidate the pre-publish re-check cannot support is
 * refused before anyone is asked.
 */
import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineMethodPublishTool } from '../../src/tools/method-publish.ts'
import { forgeEvaluation, methodWorld } from './method-tools.fixture.ts'

const publishTool = (ctx: never) => defineMethodPublishTool(ctx)

describe('method_publish', () => {
  it('refuses a pointer anyone else moved, naming both states, and asks nobody', async () => {
    const world = await methodWorld()
    try {
      const answer = (await publishTool(world.ctx as never).execute(
        { draftId: 'd0001', expectedActiveRevision: 'r0001', expectedGeneration: 7 },
        world.exec as never,
      )) as string
      expect(answer).toContain('method_publish rejected')
      expect(answer).toContain('the active pointer is r0001 g1')
      expect(answer).toContain('r0001 g7')
      expect(world.approvals).toHaveLength(0)
      expect(world.calls.publishRevision).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })

  it('refuses a draft that carries no evaluation, before anything is asked', async () => {
    const world = await methodWorld()
    try {
      const { defineMethodDraftTool } = await import('../../src/tools/method-draft.ts')
      await defineMethodDraftTool(world.ctx as never).execute(
        {
          kind: 'skill',
          identity: 'verify',
          edits: [{ id: 'e1', mechanism: 'skill', targets: ['skills/verify/SKILL.md'] }],
          editPayload: JSON.stringify({ skillMd: '---\nname: verify\ndescription: a fixture skill for the method tools\n---\n\n# candidate\n' }),
          rationale: 'a candidate with no measurement yet',
          sourceRefs: ['diagnosis:d1'],
          expectedBaseRevision: 'r0001',
          round: 0,
          critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
        },
        world.exec as never,
      )
      const answer = (await publishTool(world.ctx as never).execute(
        { draftId: 'd0001', expectedActiveRevision: 'r0001', expectedGeneration: 1 },
        world.exec as never,
      )) as string
      expect(answer).toContain('carries no evaluation')
      expect(world.approvals).toHaveLength(0)
    } finally {
      await world.dispose()
    }
  })

  it('refuses a candidate the frozen strategy did not admit without requesting an approval', async () => {
    const world = await methodWorld()
    try {
      const forged = await forgeEvaluation(world, { cost: 'unknown' })
      const evaluated = (await (await import('../../src/tools/method-evaluate.ts')).defineMethodEvaluateTool(world.ctx as never).execute(
        {
          draftId: forged.draftId,
          round: 0,
          samples: [{ taskId: 't1', role: 'observed-failure' }],
          quality: { metricId: 'acceptance', extractor: 'acceptance' },
          repetition: 2,
          input: { sourceDir: '/tmp/in' },
        },
        world.exec as never,
      )) as string
      expect(evaluated).toContain('admission: cost-inconclusive')

      const answer = (await publishTool(world.ctx as never).execute(
        { draftId: forged.draftId, expectedActiveRevision: 'r0001', expectedGeneration: 1 },
        world.exec as never,
      )) as string
      expect(answer).toContain('did not admit this candidate')
      expect(answer).toContain('consumes no approval')
      expect(world.approvals).toHaveLength(0)
      expect(world.calls.publishRevision).toBeUndefined()
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 1 })
    } finally {
      await world.dispose()
    }
  })

  it('refuses before asking when the pre-publish re-check cannot support the candidate', async () => {
    const world = await methodWorld()
    try {
      const forged = await forgeEvaluation(world, { cost: 'reported' })
      await (await import('../../src/tools/method-evaluate.ts')).defineMethodEvaluateTool(world.ctx as never).execute(
        {
          draftId: forged.draftId,
          round: 0,
          samples: [{ taskId: 't1', role: 'observed-failure' }],
          quality: { metricId: 'acceptance', extractor: 'acceptance' },
          repetition: 2,
          input: { sourceDir: '/tmp/in' },
        },
        world.exec as never,
      )
      const answer = (await publishTool(world.ctx as never).execute(
        { draftId: forged.draftId, expectedActiveRevision: 'r0001', expectedGeneration: 1 },
        world.exec as never,
      )) as string
      expect(answer).toContain('the pre-publish re-check')
      expect(answer).toContain('no approval was requested')
      expect(world.approvals).toHaveLength(0)
      expect(world.calls.publishRevision).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })

  it('refuses a read-only view — a legacy or sealed library takes no publication', async () => {
    const world = await methodWorld({ readOnly: true })
    try {
      const answer = (await publishTool(world.ctx as never).execute(
        { draftId: 'd0001', expectedActiveRevision: 'r0001', expectedGeneration: 1 },
        world.exec as never,
      )) as string
      expect(answer).toContain('read-only')
      expect(world.approvals).toHaveLength(0)
    } finally {
      await world.dispose()
    }
  })

  it('publishes an admitted candidate after exactly one approval, and the ledger records the switch', async () => {
    const world = await methodWorld({ answer: 'allowed-once' })
    try {
      const forged = await forgeEvaluation(world, { cost: 'reported', publishable: true })
      const evaluated = (await (await import('../../src/tools/method-evaluate.ts')).defineMethodEvaluateTool(world.ctx as never).execute(
        {
          draftId: forged.draftId,
          round: 0,
          samples: [{ taskId: 't1', role: 'observed-failure' }],
          quality: { metricId: 'acceptance', extractor: 'acceptance' },
          repetition: 2,
          input: { sourceDir: '/tmp/in' },
        },
        world.exec as never,
      )) as string
      expect(evaluated).toContain('admission:')
      expect(evaluated).not.toContain('did not admit')

      const answer = (await publishTool(world.ctx as never).execute(
        { draftId: forged.draftId, expectedActiveRevision: 'r0001', expectedGeneration: 1 },
        world.exec as never,
      )) as string
      expect(answer).toContain('published: active revision')
      expect(answer).toContain('superseded: r0001')
      expect(answer).toContain('new Runs admit against this revision')
      expect(world.approvals).toHaveLength(1)
      expect(world.approvals[0]!.toolName).toBe('method_publish')
      expect(world.calls.publishRevision).toBe(1)
      const pointer = await world.pointer()
      expect(pointer?.generation).toBe(2)
      expect(pointer?.revisionId).not.toBe('r0001')
      const kinds = (await world.ledgerText()).trim().split('\n').map(line => JSON.parse(line) as { kind: string })
      expect(kinds.at(-1)!.kind).toBe('published')
    } finally {
      await world.dispose()
    }
  })

  it('refuses a pointer swapped between the approval and the switch — the approval binds the state it was shown', async () => {
    let world: Awaited<ReturnType<typeof methodWorld>>
    world = await methodWorld({
      answer: 'allowed-once',
      duringApproval: async () => {
        // A third party moves the pointer while the approval is open: same revision, one generation on.
        const active = await world.revision('r0001')
        await writeFile(
          join(world.library.root, 'pointer.json'),
          `${JSON.stringify(
            {
              formatVersion: 1,
              libraryId: world.library.id,
              revisionId: 'r0001',
              manifestDigest: active!.manifest.contentDigest,
              generation: 2,
              publishedAt: '2026-10-08T00:00:00.000Z',
              publishedBy: 's-third-party',
            },
            null,
            2,
          )}\n`,
          'utf8',
        )
      },
    })
    try {
      const forged = await forgeEvaluation(world, { cost: 'reported', publishable: true })
      await (await import('../../src/tools/method-evaluate.ts')).defineMethodEvaluateTool(world.ctx as never).execute(
        {
          draftId: forged.draftId,
          round: 0,
          samples: [{ taskId: 't1', role: 'observed-failure' }],
          quality: { metricId: 'acceptance', extractor: 'acceptance' },
          repetition: 2,
          input: { sourceDir: '/tmp/in' },
        },
        world.exec as never,
      )
      const answer = (await publishTool(world.ctx as never).execute(
        { draftId: forged.draftId, expectedActiveRevision: 'r0001', expectedGeneration: 1 },
        world.exec as never,
      )) as string
      expect(answer).toContain('no pointer moved')
      expect(answer).toContain('the pointer is now r0001 g2')
      expect(answer).toContain('the approval is spent and no second one is requested')
      expect(world.approvals).toHaveLength(1)
      expect(world.calls.publishRevision).toBeUndefined()
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 2 })
      expect(await world.ledgerText()).not.toContain('"published"')
    } finally {
      await world.dispose()
    }
  })
})
