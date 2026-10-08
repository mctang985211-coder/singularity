/**
 * `method_rollback`: restoring a revision this library published before, under
 * the same compare-and-swap and one-approval discipline a publish runs under,
 * against a library whose pointer really moved.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createEnvironmentDraft,
  freezeEnvironmentDraft,
  publishEnvironmentRevision,
  stageEnvironmentEdit,
} from '../../../task-runtime/src/environment/index.ts'
import { defineMethodRollbackTool } from '../../src/tools/method-rollback.ts'
import { DECLARED_EDIT, methodWorld, skillPayload, skillText } from './method-tools.fixture.ts'
import { defineMethodDraftTool } from '../../src/tools/method-draft.ts'

const rollbackTool = (ctx: never) => defineMethodRollbackTool(ctx)

/** Move the pointer to a frozen candidate the ledger does not know, so a rollback has a real state to undo. */
async function publishCandidate(world: Awaited<ReturnType<typeof methodWorld>>): Promise<string> {
  const draft = await createEnvironmentDraft(world.library, { basedOn: 'r0001', actor: 's-supervisor' })
  await stageEnvironmentEdit(world.library, draft.draftId, {
    kind: 'skill',
    edit: { name: 'verify', skillMd: skillText('# a published candidate'), expectedVersion: 0, actor: 's-supervisor' },
  })
  const frozen = await freezeEnvironmentDraft(world.library, draft.draftId)
  const outcome = await publishEnvironmentRevision(
    { library: world.library },
    { direction: 'publish', source: { kind: 'revision', revisionId: frozen.manifest.revisionId }, expected: { revisionId: 'r0001', generation: 1 }, actor: 's-supervisor' },
  )
  return outcome.pointer.revisionId
}

async function draftOne(world: Awaited<ReturnType<typeof methodWorld>>): Promise<void> {
  await defineMethodDraftTool(world.ctx as never).execute(
    {
      kind: 'skill',
      identity: 'verify',
      edits: [DECLARED_EDIT],
      editPayload: skillPayload('# candidate'),
      rationale: 'a candidate whose base revision is the one a rollback restores',
      sourceRefs: ['diagnosis:d1'],
      expectedBaseRevision: 'r0001',
      round: 0,
      critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
    },
    world.exec as never,
  )
}

describe('method_rollback', () => {
  it('asks once, restores the revision this library published before, and records the completion', async () => {
    const world = await methodWorld({ humanReview: false })
    try {
      await draftOne(world)
      const active = await publishCandidate(world)
      const answer = (await rollbackTool(world.ctx as never).execute(
        { toRevisionId: 'r0001', expectedActiveRevision: active, expectedGeneration: 2, reason: 'the candidate regressed a criterion' },
        world.exec as never,
      )) as string
      expect(answer).toContain('published: active revision r0001 g3')
      expect(answer).toContain('superseded: ')
      expect(answer).toContain('mode auto; decided by platform_policy')
      expect(answer).toContain('next Runs admit against "r0001"')
      expect(world.approvals).toHaveLength(1)
      expect(world.approvals[0]!.toolName).toBe('method_rollback')
      // The approval showed the reverse difference, the exact switch and the reason.
      expect(world.approvals[0]!.reason).toContain('Method rollback of library g1')
      expect(world.approvals[0]!.reason).toContain(`version switch: active ${active} g2`)
      expect(world.approvals[0]!.reason).toContain('reason: the candidate regressed a criterion')
      expect(world.approvals[0]!.reason).toContain('nothing has been written yet')
      expect(world.calls.rollbackRevision).toBe(1)
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 3 })
      const kinds = (await world.ledgerText()).trim().split('\n').map(line => JSON.parse(line) as { kind: string })
      expect(kinds.at(-1)!.kind).toBe('rolledback')
    } finally {
      await world.dispose()
    }
  })

  it('refuses a pointer anyone else moved, naming both states, and asks nobody', async () => {
    const world = await methodWorld()
    try {
      await draftOne(world)
      const active = await publishCandidate(world)
      const answer = (await rollbackTool(world.ctx as never).execute(
        { toRevisionId: 'r0001', expectedActiveRevision: active, expectedGeneration: 5, reason: 'stale' },
        world.exec as never,
      )) as string
      expect(answer).toContain('method_rollback rejected')
      expect(answer).toContain('the active pointer is')
      expect(world.approvals).toHaveLength(0)
      expect(world.calls.rollbackRevision).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })

  it('refuses a revision this library never held as effective', async () => {
    const world = await methodWorld()
    try {
      await draftOne(world)
      const active = await publishCandidate(world)
      const answer = (await rollbackTool(world.ctx as never).execute(
        { toRevisionId: 'r0002', expectedActiveRevision: active, expectedGeneration: 2, reason: 'adopt something else' },
        world.exec as never,
      )) as string
      expect(answer).toContain('was never effective in library "g1"')
      expect(world.approvals).toHaveLength(0)
      expect(world.calls.rollbackRevision).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })

  it('refuses the revision already in effect rather than switching to itself', async () => {
    const world = await methodWorld()
    try {
      const answer = (await rollbackTool(world.ctx as never).execute(
        { toRevisionId: 'r0001', expectedActiveRevision: 'r0001', expectedGeneration: 1, reason: 'no-op' },
        world.exec as never,
      )) as string
      expect(answer).toContain('is the revision already in effect')
      expect(world.approvals).toHaveLength(0)
    } finally {
      await world.dispose()
    }
  })

  it('refuses an approval that was not granted, leaving the pointer where it stood', async () => {
    const world = await methodWorld({ answer: 'rejected' })
    try {
      await draftOne(world)
      const active = await publishCandidate(world)
      const answer = (await rollbackTool(world.ctx as never).execute(
        { toRevisionId: 'r0001', expectedActiveRevision: active, expectedGeneration: 2, reason: 'refused' },
        world.exec as never,
      )) as string
      expect(answer).toContain('no pointer moved')
      expect(answer).toContain('the human rejected it')
      expect(world.approvals).toHaveLength(1)
      expect(world.calls.rollbackRevision).toBeUndefined()
      expect(await world.pointer()).toEqual({ revisionId: active, generation: 2 })
    } finally {
      await world.dispose()
    }
  })

  it('continues an open rollback intent without asking a second approval, and refuses an unrelated one', async () => {
    const world = await methodWorld()
    try {
      await draftOne(world)
      const active = await publishCandidate(world)
      const target = await world.revision('r0001')
      // A process killed between its intent and its switch leaves exactly this line.
      await writeFile(
        join(world.library.root, 'pointer-intent.json'),
        `${JSON.stringify(
          {
            formatVersion: 1,
            intentId: `${world.library.id}/g3/r0001`,
            libraryId: world.library.id,
            direction: 'rollback',
            expected: { revisionId: active, generation: 2 },
            next: { revisionId: 'r0001', manifestDigest: target!.manifest.contentDigest },
            approvalRef: 'approval:earlier-call',
            actor: 's-supervisor',
            at: '2026-10-08T00:00:00.000Z',
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      const continued = (await rollbackTool(world.ctx as never).execute(
        { toRevisionId: 'r0001', expectedActiveRevision: active, expectedGeneration: 2, reason: 'settle the intent' },
        world.exec as never,
      )) as string
      expect(continued).toContain('no second approval was requested')
      expect(world.approvals).toHaveLength(0)
      expect(await world.pointer()).toEqual({ revisionId: 'r0001', generation: 3 })
    } finally {
      await world.dispose()
    }
  })

  it('refuses an intent that names another switch rather than hijacking it', async () => {
    const world = await methodWorld()
    try {
      await draftOne(world)
      const active = await publishCandidate(world)
      await writeFile(
        join(world.library.root, 'pointer-intent.json'),
        `${JSON.stringify(
          {
            formatVersion: 1,
            intentId: `${world.library.id}/g3/r0002`,
            libraryId: world.library.id,
            direction: 'rollback',
            expected: { revisionId: active, generation: 2 },
            next: { revisionId: 'r0002', manifestDigest: 'a'.repeat(64) },
            actor: 's-supervisor',
            at: '2026-10-08T00:00:00.000Z',
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      const answer = (await rollbackTool(world.ctx as never).execute(
        { toRevisionId: 'r0001', expectedActiveRevision: active, expectedGeneration: 2, reason: 'a different switch is open' },
        world.exec as never,
      )) as string
      expect(answer).toContain('pointer intent')
      expect(answer).toContain('is open')
      expect(world.approvals).toHaveLength(0)
      expect(world.calls.rollbackRevision).toBeUndefined()
    } finally {
      await world.dispose()
    }
  })
})
