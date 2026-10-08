/**
 * The two completion tools over the real runtime: only the session the platform
 * assigned a work item to may conclude it, the diagnosis a reviewer records is
 * the one the store holds and the review pack shows, and a concluded session's
 * write access is closed at execution time.
 *
 * Every call below goes through the real tool registry, so a refusal asserted
 * here is the refusal a model would meet, and the seal is the execution guard it
 * would hit.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RootContractSpec } from '../../task-runtime/src/index.ts'
import { reviewerGrant } from '../../agent-singularity/src/coordination/roles.ts'
import { appendAssignment, readCoordinationRows, type CoordinationAssignment } from '../../agent-singularity/src/coordination/store.ts'
import { disposeRunStacks, startRunStack, type RunStack } from '../support/run-stack.ts'

const ROOT = 's-root' as SessionId
const GRAPH = 'g1'
const SUPERVISOR = 's-sup' as SessionId
const REVIEWER = 's-rev' as SessionId

let coordination: string
let previous: string | undefined

beforeEach(() => {
  coordination = mkdtempSync(join(tmpdir(), 'coordination-tools-'))
  previous = process.env.SINGULARITY_COORDINATION_DIR
  process.env.SINGULARITY_COORDINATION_DIR = coordination
})

afterEach(async () => {
  await disposeRunStacks()
  if (previous === undefined) delete process.env.SINGULARITY_COORDINATION_DIR
  else process.env.SINGULARITY_COORDINATION_DIR = previous
  rmSync(coordination, { recursive: true, force: true })
})

const contract = (objective: string): RootContractSpec => ({
  objective,
  requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [{ criterionId: 'goal', description: `${objective} is delivered`, command: 'true' }],
})

/** The row the driver writes before it spawns; a case that drives a session by hand writes it itself. */
async function assign(input: {
  readonly sessionId: SessionId
  readonly role: 'supervisor' | 'reviewer'
  readonly taskId: string
  readonly runId: string
}): Promise<void> {
  const subject =
    input.role === 'supervisor'
      ? { kind: 'round' as const, businessRound: 1, searchRound: 1, source: { taskId: input.taskId, runId: input.runId } }
      : { kind: 'review' as const, businessRound: 1, source: { taskId: input.taskId, runId: input.runId }, requestKey: null }
  const row: CoordinationAssignment = {
    formatVersion: 1,
    kind: 'assignment',
    graphId: GRAPH,
    storeId: `sg-t-${String(ROOT)}`,
    epoch: 1,
    role: input.role,
    subject,
    sessionId: String(input.sessionId),
    actor: String(ROOT),
    digest: `digest-${String(input.sessionId)}`,
    at: '2026-10-08T00:00:00.000Z',
  }
  await appendAssignment(row)
}

/**
 * One review session, spawned the way `task_review_agent` spawns it: the
 * reviewer's own role and grant, so `reviewer_complete` is on its surface.
 */
async function reviewerAgent(h: RunStack, sessionId: SessionId): Promise<Agent> {
  const handle = await h.agentRuntime.spawn(h.rootAgent(ROOT), {
    sessionId,
    name: 'reviewer',
    agentPreset: 'standard',
    coordinationRole: 'reviewer',
    grant: reviewerGrant(),
    permissionPreset: 'danger-full-access',
    prompt: [{ type: 'text', text: 'review the recorded source' }],
  })
  return handle.agent
}

/** A store whose root run has settled verified, with the review a completion cites. */
async function settledTree(): Promise<{ h: RunStack; taskId: string; runId: string }> {
  const h = await startRunStack({ roots: [ROOT], tools: true })
  const root = await h.root(ROOT, contract('deliver the answer'))
  const submitted = await h.runtime.submitResult(ROOT, { summary: 'the answer is delivered' })
  expect(submitted.status).toBe('verified')
  return { h, taskId: root.taskId, runId: root.runId }
}

describe('the completion tools', () => {
  it('refuses a session the platform never assigned a work item to', async () => {
    const { h, taskId, runId } = await settledTree()
    const supervisor = await h.supervisor(SUPERVISOR)
    const answer = await h.call(supervisor, 'supervisor_complete', {
      businessAction: 'finish',
      reason: 'nothing further is justified',
      evidenceRefs: [`${taskId}#${runId}`],
    })
    expect(answer.text).toContain('holds no coordination work item')
    expect(((await readCoordinationRows()) ?? []).filter(row => row.kind === 'completion')).toEqual([])

  })

  it('refuses each role calling the other role\'s tool', async () => {
    const { h, taskId, runId } = await settledTree()
    await assign({ sessionId: SUPERVISOR, role: 'supervisor', taskId, runId })
    await assign({ sessionId: REVIEWER, role: 'reviewer', taskId, runId })
    const supervisor = await h.supervisor(SUPERVISOR)
    const reviewer = await reviewerAgent(h, REVIEWER)
    const wrongWay = await h.call(reviewer, 'reviewer_complete', { observation: 'o', conclusion: 'c', confidence: 'low' })
    expect(wrongWay.isError).toBe(false)
    const mismatch = await h.call(reviewer, 'supervisor_complete', {
      businessAction: 'finish',
      reason: 'not my job',
      evidenceRefs: [`${taskId}#${runId}`],
    })
    // The reviewer's own surface does not carry the supervisor tool at all: the
    // role check inside the tool is the second line of defence, and this is the
    // first.
    expect(mismatch.text).toContain('supervisor_complete')
    const otherWay = await h.call(supervisor, 'reviewer_complete', { observation: 'o', conclusion: 'c', confidence: 'low' })
    expect(otherWay.text).toContain('reviewer_complete')
  })

  it('refuses evidence the store does not hold, and an action that disagrees with the round', async () => {
    const { h, taskId, runId } = await settledTree()
    await assign({ sessionId: SUPERVISOR, role: 'supervisor', taskId, runId })
    const supervisor = await h.supervisor(SUPERVISOR)
    const unknown = await h.call(supervisor, 'supervisor_complete', {
      businessAction: 'continue',
      reason: 'the method can be improved',
      evidenceRefs: ['t-nowhere#r-nowhere'],
    })
    // A refusal is a tool answer, not a throw: what matters is that it names the
    // reason and that nothing was written.
    expect(unknown.text).toContain('does not hold')
    // The round settled verified, so `recover` is not an action it can take.
    const disagreeing = await h.call(supervisor, 'supervisor_complete', {
      businessAction: 'recover',
      reason: 'repair it',
      evidenceRefs: [`${taskId}#${runId}`],
    })
    expect(disagreeing.text).toContain('does not agree with the round')
    expect(((await readCoordinationRows()) ?? []).filter(row => row.kind === 'completion')).toEqual([])
  })

  it('records the completion once, closes the session, and refuses writes while reads stay available', async () => {
    const { h, taskId, runId } = await settledTree()
    await assign({ sessionId: SUPERVISOR, role: 'supervisor', taskId, runId })
    const supervisor = await h.supervisor(SUPERVISOR)
    const answer = await h.call(supervisor, 'supervisor_complete', {
      businessAction: 'continue',
      reason: 'the delivered method can be improved',
      evidenceRefs: [`${taskId}#${runId}`],
    })
    expect(answer.isError, answer.text).toBe(false)
    expect(answer.text).toContain('supervisor_complete: continue')
    expect(answer.text).toContain('writes are closed')

    const completion = ((await readCoordinationRows()) ?? []).find(row => row.kind === 'completion')!
    expect(completion).toMatchObject({
      kind: 'completion',
      role: 'supervisor',
      sessionId: String(SUPERVISOR),
      result: expect.objectContaining({
        kind: 'completed',
        businessAction: 'continue',
        methodDecision: 'retain',
        // This graph declares no round count, so the search step this round can
        // claim is the last one it knows of.
        searchNext: 'stop',
      }),
    })

    // The seal is an execution-time refusal: the surface still offers `write`.
    const blocked = await h.call(supervisor, 'write', { path: 'note.txt', content: 'x' })
    expect(blocked.text).toContain('writes are closed')
    const read = await h.call(supervisor, 'task_read', {})
    expect(read.isError, read.text).toBe(false)

    // A repeat is answered from the record instead of writing a second completion.
    const repeat = await h.call(supervisor, 'supervisor_complete', {
      businessAction: 'finish',
      reason: 'second thoughts',
      evidenceRefs: [`${taskId}#${runId}`],
    })
    expect(repeat.text).toContain('already settled its work item')
    expect(((await readCoordinationRows()) ?? []).filter(row => row.kind === 'completion')).toHaveLength(1)
  })

  it('records the reviewer diagnosis the store and the review pack then hold', async () => {
    const { h, taskId, runId } = await settledTree()
    await assign({ sessionId: REVIEWER, role: 'reviewer', taskId, runId })
    const reviewer = await reviewerAgent(h, REVIEWER)
    const answer = await h.call(reviewer, 'reviewer_complete', {
      observation: 'the run verified on its first attempt',
      conclusion: 'the delivered method needed no repair, and one path could be shortened',
      confidence: 'medium',
      proposals: [{ targetType: 'skill', targetId: 'answer-method', rationale: 'shorten the verified path' }],
    })
    expect(answer.isError, answer.text).toBe(false)
    expect(answer.text).toContain(`diagnosis review-agent-${String(REVIEWER)} [medium] recorded`)

    const stored = (await h.snapshot(`sg-t-${String(ROOT)}`)).diagnoses.find(
      item => item.diagnosisId === `review-agent-${String(REVIEWER)}`,
    )
    expect(stored).toMatchObject({
      taskId,
      observedFailure: 'the run verified on its first attempt',
      confidence: 'medium',
      reviewRefs: [`${taskId}#${runId}`],
      proposals: [{ targetType: 'skill', targetId: 'answer-method', rationale: 'shorten the verified path' }],
    })
    expect(((await readCoordinationRows()) ?? []).some(row => row.kind === 'completion' && row.result.kind === 'reviewed')).toBe(true)

    // The work item the reviewer settled is on the record for the source, which
    // is what the review pack renders (asserted in `task-review-pack-judgements.spec.ts`).
    expect(((await readCoordinationRows()) ?? []).find(row => row.kind === 'completion')).toMatchObject({
      role: 'reviewer',
      result: { kind: 'reviewed', diagnosisId: `review-agent-${String(REVIEWER)}`, confidence: 'medium' },
    })
  })
})
