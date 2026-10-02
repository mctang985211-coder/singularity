import { describe, expect, it } from 'vitest'
import { sha256Of } from '../support/run-stack.ts'
import {
  sharedDirectory,
  decidedWorld,
  applyThroughTool,
  P1,
  productionObject,
  sideState,
  kindsOf,
  ledgerLines,
  ROOT_A,
  boot,
  ledgerBytes,
  intentFiles,
  commitTargets,
  SKILL,
  stagedNow,
} from './k3-skill-unit.fixture.ts'

/* ------------------------------------------------------------------------- *
 * K3-4 — the real process exit
 * ------------------------------------------------------------------------- */

/** The nine tools this build registers; K3-5 asserts the chain really went through all of them. */
const EVOLUTION_TOOLS = [
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_rollback',
  'evolution_list',
] as const

/* ------------------------------------------------------------------------- *
 * K3-5 — the current format, the whole-object rollback, and the nine tools
 * ------------------------------------------------------------------------- */

describe('K3-5: the current ledger format reads back, and the whole object rolls back through the tools', () => {
  it('reopens the formatVersion 4 ledger, rolls both files back, and drives all nine tools on the execution object', async () => {
    const directory = await sharedDirectory()
    const world = await decidedWorld(directory)
    const h = world.s.h
    await applyThroughTool(world.s, P1)
    expect(await productionObject(h)).toEqual(sideState(world, 'candidate'))
    expect(kindsOf(await ledgerLines(h)).slice(-2)).toEqual(['commit_intent', 'applied'])

    // The reopen: a new process image over the same directory. Every line it reads
    // is the one format this build writes, and the proposal is applied with nothing open.
    await h.runtime.submitResult(ROOT_A, { summary: 'the first boot hands its checkout back' })
    const reopened = await boot({ workspace: directory })
    const h2 = reopened.h
    const lines = await ledgerLines(h2)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(line => line.formatVersion === 4)).toBe(true)
    expect((await reopened.svc.get(P1)).status).toBe('applied')
    expect((await reopened.svc.get(P1)).openIntent).toBeUndefined()
    expect(await reopened.svc.openIntentTargets()).toEqual([])
    expect(await productionObject(h2)).toEqual(sideState(world, 'candidate'))

    // The read tool on the reopened process's own surface: the applied proposal is
    // listed, and the query writes nothing.
    const beforeList = await ledgerBytes(h2)
    const listed = await reopened.call('evolution_list', {})
    expect(listed.isError, listed.text).toBe(false)
    expect(listed.text).toContain(P1)
    expect(await ledgerBytes(h2)).toBe(beforeList)

    // The rollback: the champion snapshot restored as one two-file commit.
    const rolledback = await reopened.call('evolution_rollback', { proposalId: P1 })
    expect(rolledback.isError, rolledback.text).toBe(false)
    expect(rolledback.text).toContain('champion restored')
    expect(await productionObject(h2)).toEqual(sideState(world, 'production'))
    const settled = await ledgerLines(h2)
    expect(kindsOf(settled).slice(-2)).toEqual(['commit_intent', 'rolledback'])
    const reverting = settled.filter(line => line.kind === 'commit_intent').at(-1)!
    expect(intentFiles(reverting).map(file => file.target)).toEqual(commitTargets(h2))
    expect(intentFiles(reverting)[0]).toMatchObject({
      baselineSha256: sha256Of(world.candidateBody),
      contentSha256: world.production.identity.sha256,
      source: `sandbox/${P1}/champion/skills/${SKILL}/SKILL.md`,
    })
    const completion = settled.at(-1)!
    expect(completion).toMatchObject({ targets: commitTargets(h2), intentId: `${P1}/rollback` })
    expect(completion.approvalRef).toBe(reverting.approvalRef)
    expect(settled.every(line => line.formatVersion === 4)).toBe(true)
    expect((await reopened.svc.get(P1)).status).toBe('rolledback')
    expect(await reopened.svc.openIntentTargets()).toEqual([])
    expect(await stagedNow(h2)).toEqual([])

    // A further rollback is the state machine's answer, not a second write.
    const afterRollback = await ledgerBytes(h2)
    const again = await reopened.call('evolution_rollback', { proposalId: P1 })
    expect(again.text).toContain('is rolledback; only an applied proposal can be rolled back')
    expect(await ledgerBytes(h2)).toBe(afterRollback)
    expect(kindsOf(await ledgerLines(h2)).slice(-2)).toEqual(['commit_intent', 'rolledback'])

    // The whole chain went through the nine tools themselves, each driven at least
    // once: no step of it is a service call the tools could not have made.
    const driven = new Set([...world.s.called, ...reopened.called])
    expect([...EVOLUTION_TOOLS].filter(name => !driven.has(name))).toEqual([])
  }, 240_000)
})
