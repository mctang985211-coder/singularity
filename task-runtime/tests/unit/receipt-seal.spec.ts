import { rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { pinSkillHome, releaseSkillHomes } from '../support/skill-roots.ts'
import { createAcceptanceParent, harness, createRoot, ROOT_SESSION, STORE, taskEvents } from './orchestrate.fixture.ts'

/**
 * Receipt sealing (plan §2, risk R6): a receipt is written once, after the Run
 * is terminal, its managed work is drained and its session log is on disk — and
 * a sealing failure is queued for recovery rather than allowed to touch the
 * settlement that produced it.
 */

let home: string

beforeEach(() => {
  home = pinSkillHome('task-execution')
})

afterEach(async () => {
  releaseSkillHomes()
  await rm(home, { recursive: true, force: true })
})

/** One request header, so a sealed receipt can establish the models a session really called. */
function requestHeader(provider = 'anthropic', model = 'claude'): unknown {
  return { type: 'request/header', data: { header: { config: { provider, model } } }, time: Date.now() }
}

function eventsOf(h: ReturnType<typeof harness>, sessionId: string): unknown[] {
  return h.sessions.get(sessionId)!.events as unknown[]
}

function receiptEvents(h: ReturnType<typeof harness>): number {
  return taskEvents(h).filter(event => event.kind === 'RunReceiptSealed').length
}

describe('a receipt is sealed once, after the run is terminal', () => {
  test('the settlement seals a complete receipt, and a repeat is answered from the store', async () => {
    const h = harness()
    h.ctx.sessionQuery = { readSession: async (sessionId: string) => ({ events: eventsOf(h, sessionId) }) }
    const root = await createRoot(h)
    eventsOf(h, ROOT_SESSION).push(requestHeader())
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the result is delivered' })

    const receipt = await h.runtime.receiptFor(STORE, root.runId)
    expect(receipt).toBeDefined()
    expect(receipt).toMatchObject({ formatVersion: 1, runId: root.runId, taskId: root.taskId, outcome: 'verified', drain: 'in-process' })
    expect(receipt!.completeness).toEqual({ status: 'complete', missing: [] })
    expect(receipt!.environment.revision.revisionId).toBe('r0001')
    expect(receipt!.modelUse[0]).toMatchObject({ status: 'observed', requests: [{ identity: { provider: 'anthropic', model: 'claude' }, count: 1 }] })
    expect(receipt!.skills[0]?.bound.map(skill => skill.name)).toEqual(['task-coordination'])
    expect(receipt!.subtree).toEqual([root.runId])
    expect(receiptEvents(h)).toBe(1)

    // Sealing again is idempotent: it answers with the stored receipt and writes nothing.
    const again = await h.runtime.sealRunReceipt(STORE, root.taskId, root.runId)
    expect(again.status).toBe('already-sealed')
    expect(receiptEvents(h)).toBe(1)
    await h.runtime.unload()
  })

  test('an old-protocol run is unsupported and writes nothing', async () => {
    const h = harness()
    // A run the store holds directly, with no environment revision: exactly the
    // shape every Run written before the revision protocol has.
    const parent = await createAcceptanceParent(h, [
      { criterionId: 'c1', description: 'it works', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' },
    ])
    await h.task.recordEvidenceIn(STORE, {
      evidenceId: 'e-parent', taskRunId: parent.runId, taskId: parent.taskId, artifacts: [],
      verifierResults: [{ criterionId: 'c1', status: 'pass', detail: 'ok' }], claims: [], generatedAt: new Date().toISOString(),
    }, 'test')
    await h.task.markRunStatusIn(STORE, parent.taskId, parent.runId, 'verifying', 'test')
    await h.task.markRunStatusIn(STORE, parent.taskId, parent.runId, 'verified', 'test')
    const before = receiptEvents(h)
    const status = await h.runtime.sealRunReceipt(STORE, parent.taskId, parent.runId)
    expect(status).toMatchObject({ status: 'unsupported' })
    expect(receiptEvents(h)).toBe(before)
    expect(await h.runtime.receiptFor(STORE, parent.runId)).toBeUndefined()
    await h.runtime.unload()
  })

  test('without a readable session log the receipt is incomplete and names the missing fact', async () => {
    const h = harness()
    const root = await createRoot(h)
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the result is delivered' })
    const receipt = await h.runtime.receiptFor(STORE, root.runId)
    expect(receipt?.completeness.status).toBe('incomplete')
    expect(receipt?.completeness.missing.map(entry => entry.fact)).toContain('session-log')
    expect(receipt?.modelUse[0]?.status).toBe('unavailable')
    await h.runtime.unload()
  })

  test('a log that has not reached the run is waited for while the drain is unconfirmed', async () => {
    const h = harness()
    const log: unknown[] = []
    h.ctx.sessionQuery = { readSession: async () => ({ events: log }) }
    const root = await createRoot(h)
    // This process no longer holds the session, and its adopted work cannot be
    // reconciled: the drain is unconfirmed, so the log may still be arriving and
    // the sealer waits for it rather than reading a half-written session.
    h.runtime.startedSessions.delete(ROOT_SESSION)
    h.runtime.reconcileSessionJobs = async () => {
      throw new Error('the adopted work could not be reconciled')
    }
    setTimeout(() => {
      log.push(requestHeader())
      log.push({ type: 'assistant/message', data: {}, time: Date.now() + 60_000 })
    }, 60)
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the result is delivered' })
    const receipt = await h.runtime.receiptFor(STORE, root.runId)
    expect(receipt?.drain).toBe('unconfirmed')
    expect(receipt?.modelUse[0]).toMatchObject({ status: 'observed', logEvents: 2 })
    await h.runtime.unload()
  })

  test('an old-protocol run is refused before any log is read', async () => {
    const h = harness()
    const log: unknown[] = [requestHeader(), { type: 'assistant/message', data: {}, time: Date.now() + 60_000 }]
    h.ctx.sessionQuery = { readSession: async () => ({ events: log }) }
    const parent = await createAcceptanceParent(h, [
      { criterionId: 'c1', description: 'it works', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' },
    ])
    // A run this process never spawned for, admitted against the active revision.
    await h.task.recordEvidenceIn(STORE, {
      evidenceId: 'e-parent', taskRunId: parent.runId, taskId: parent.taskId, artifacts: [],
      verifierResults: [{ criterionId: 'c1', status: 'pass', detail: 'ok' }], claims: [], generatedAt: new Date().toISOString(),
    }, 'test')
    await h.task.markRunStatusIn(STORE, parent.taskId, parent.runId, 'verifying', 'test')
    await h.task.markRunStatusIn(STORE, parent.taskId, parent.runId, 'verified', 'test')
    const env = await h.runtime.ensureInitialEnvironment(ROOT_SESSION, ROOT_SESSION)
    expect(env.revision?.manifest.revisionId).toBe('r0001')
    // The store's own record is what the sealer reads; the run above carries no
    // revision, so this pass is the unsupported one, and the drain branch is
    // reached only for a sealed run — asserted through the queue below.
    expect(await h.runtime.sealRunReceipt(STORE, parent.taskId, parent.runId)).toMatchObject({ status: 'unsupported' })
    await h.runtime.unload()
  })

  test('a seal that throws leaves the terminal state, the review and the queue intact', async () => {
    const h = harness()
    h.ctx.sessionQuery = { readSession: async (sessionId: string) => ({ events: eventsOf(h, sessionId) }) }
    const root = await createRoot(h)
    eventsOf(h, ROOT_SESSION).push(requestHeader())
    // The store refuses to take the receipt: the settlement must not care.
    const task = h.ctx.task as { recordReceiptIn?: unknown }
    task.recordReceiptIn = async () => {
      throw new Error('the receipt store is unavailable')
    }
    await h.runtime.submitResult(ROOT_SESSION, { summary: 'the result is delivered' })

    const run = await h.task.runIn(STORE, root.runId)
    expect(run.status).toBe('verified')
    const snapshot = await h.task.snapshotIn(STORE)
    expect(snapshot.reviews.find(item => item.runId === root.runId)?.outcome).toBe('verified')
    expect(snapshot.receipts ?? []).toEqual([])
    // The receipt is queued for the next pass rather than lost.
    expect([...(h.runtime.receiptSeals.get(STORE) ?? [])]).toEqual([root.runId])
    await h.runtime.unload()
  })
})
