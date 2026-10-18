import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_WORKFLOW_LIMITS } from '../../src/task/budget.ts'
import { TASK_PROTOCOL, TASK_VERSION } from '../../src/task/protocol.ts'
import { openApparatus, callerOf, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { improvementTaskId, startImprovement } from '../src/improvement.ts'
import { spawnProcess } from '../src/process.ts'
import { propose } from '../src/surfaces.ts'
import { attachmentsAt, FakePersistence, agentFor, factsOf, testProjections } from './seam.ts'

const native = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/runtime/child-session.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/runtime/child-session.ts')>(),
  openChildSession: native.open,
}))
const roots: string[] = []
afterEach(async () => {
  native.open.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('freezes the RSI workflow bounds before its first Run and preserves them across startup recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bounded-improvement-'))
  roots.push(root)
  const medium = new FakePersistence(), parent = agentFor('business', 'business')
  const mount = async () => openApparatus('bounded-improvement', root,
    await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess),
    medium as never, attachmentsAt(root), testProjections)
  let apparatus = await mount()
  try {
    const proposal = await propose(apparatus, callerOf(parent), 'root', { goal: 'inspect protected letters' })
    await apparatus.tasks.forAgent(parent.id).failRun({ commandId: 'business-ended', taskId: proposal.taskId,
      runId: proposal.runId, cause: 'business', reason: 'fixture stopped without an answer' })
    await apparatus.store.emit({ commandId: 'close-business', protocol: TASK_PROTOCOL, version: TASK_VERSION,
      kind: 'task/closed', subject: proposal.taskId, as: `agent:${parent.id}`,
      payload: { runId: proposal.runId, reason: 'failed' } })
    await apparatus.store.emit({ commandId: 'rsi-pending', protocol: TASK_PROTOCOL, version: TASK_VERSION,
      kind: 'rsi/status', subject: proposal.taskId, payload: { status: 'pending', detail: 'fixture analysis' } })
    const trace = await apparatus.attachments.saveFile({ name: 'trajectory.json',
      data: Buffer.from(JSON.stringify({ root: { taskId: proposal.taskId, runId: proposal.runId }, summary: {} })) })
    await apparatus.store.emit({ commandId: 'rsi-running', protocol: TASK_PROTOCOL, version: TASK_VERSION,
      kind: 'rsi/status', subject: proposal.taskId, payload: { status: 'running', detail: 'sealed fixture', trace } })
    native.open.mockRejectedValue(new Error('native startup unavailable'))
    const start = () => startImprovement(apparatus, {}, parent, proposal.taskId, proposal.runId, new AbortController().signal)
    await expect(start()).rejects.toThrow('native startup unavailable')
    const analysisId = native.open.mock.calls[0]![1].agentId as string
    expect(analysisId).toBe(improvementTaskId(proposal.taskId, proposal.runId))
    expect(improvementTaskId(proposal.taskId, 'another-run')).not.toBe(analysisId)
    const before = taskStateOf(apparatus, analysisId), run = Object.values(before.runs).at(-1)!
    expect(before.workflowLimits).toEqual(DEFAULT_WORKFLOW_LIMITS)
    expect(before.search).toMatchObject({ runId: run.runId, maxProposals: 6 })
    const facts = factsOf(medium).filter(fact => fact.subject === analysisId)
    const frozen = facts.find(fact => fact.kind === 'workflow/limits-frozen')!
    expect(frozen.seq).toBeLessThan(facts.find(fact => fact.kind === 'run/started')!.seq)
    expect(frozen.payload).toEqual(DEFAULT_WORKFLOW_LIMITS)
    await apparatus.store.close()
    apparatus = await mount()
    await expect(start()).rejects.toThrow('native startup unavailable')
    expect(native.open.mock.calls[1]![1].agentId).toBe(analysisId)
    expect(taskStateOf(apparatus, analysisId).workflowLimits).toEqual(DEFAULT_WORKFLOW_LIMITS)
    expect(Object.keys(taskStateOf(apparatus, analysisId).runs)).toEqual([run.runId])
    expect(factsOf(medium).filter(fact => fact.subject === analysisId && fact.kind === 'workflow/limits-frozen'))
      .toEqual([frozen])
  } finally { await apparatus.store.close() }
})
