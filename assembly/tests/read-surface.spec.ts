import { fileURLToPath } from 'node:url'
import { testProjections } from './seam.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { openApparatus, callerOf, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { propose, decompose } from '../src/surfaces.ts'
import { startAttempt } from '../src/attempt.ts'
import { submit } from '../src/submission.ts'
import { historyOf, readArtifact, waitForTask, readForAgent } from '../src/read.ts'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ChildSession } from '../../src/runtime/child-session.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import { TASK_PROTOCOL, TASK_VERSION } from '../../src/task/protocol.ts'
import { fixtureReview } from './review-fixture.ts'
import { attachmentsAt, FakePersistence, agentFor, execFor, fakeExecution, factsOf } from './seam.ts'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'free-task-'))
  roots.push(root)
  const medium = new FakePersistence(),
    apparatus = await openApparatus(
      'free',
      root,
      await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess),
      medium as never,
      attachmentsAt(root), testProjections,
    ),
    agent = agentFor('worker', 'worker'),
    caller = callerOf(agent),
    proposal = await propose(apparatus, caller, 'root', { goal: 'count' })
  return { apparatus, agent, caller, proposal, medium }
}
it('runs and independently reviews a one-off investigation without minting a method Revision', async () => {
  const h = await setup(),
    method = taskStateOf(h.apparatus, h.proposal.taskId).runs[h.proposal.runId]!.revision
  const before = factsOf(h.medium).filter((f) => f.kind === 'revision/created').length
  const plan = await decompose(h.apparatus, { advance: async () => [] }, h.caller, {
    taskId: h.proposal.taskId,
    children: [
      {
        key: 'investigate',
        contract: {
          goal: 'test whether punctuation changes the ASCII count',
          artifact: 'finding.json',
          inputs: [],
          criteria: [
            { criterionId: 'finding', statement: 'a reproducible experiment supports or refutes the hypothesis' },
          ],
        },
        dependsOn: [],
        supports: ['letters'],
        maxRuns: 1, requirement: 'required' as const,
      },
    ],
  })
  const parent = taskStateOf(h.apparatus, plan.taskId),
    childId = parent.decomposition!.children[0]!.taskId,
    child = taskStateOf(h.apparatus, childId),
    id = child.responsibility!.agentId,
    caller = { ...h.caller, agentId: id, sessionId: id },
    agent = agentFor(id, id)
  const run = await startAttempt(h.apparatus, caller, childId, 'investigate', method)
  await writeFile(
    join(run.bubble!.workspace.ref, 'finding.json'),
    JSON.stringify({
      hypothesis: false,
      evidence: 'ASCII counting ignores punctuation: a! and a each contain 1 letter',
    }),
  )
  expect(
    (
      await submit(
        h.apparatus, fakeExecution(() => undefined), caller, execFor(agent, 'answer'),
        { taskId: childId, path: 'finding.json' },
        new AbortController().signal,
        fixtureReview(h.apparatus),
      )
    ).verdict,
  ).toBe('pass')
  expect(child.contract!.template).toBeUndefined()
  expect(factsOf(h.medium).filter((f) => f.kind === 'revision/created')).toHaveLength(before)
  const history = await historyOf(h.apparatus, [], h.caller.agentId)
  expect(history.tasks.find((t) => t.taskId === childId)).not.toHaveProperty('goal')
  expect(history.tasks.find((t) => t.taskId === childId)!.runs[0]!.artifact).toMatchObject({ name: 'finding.json' })
  expect((await readArtifact(h.apparatus, childId)).text).toContain('hypothesis')
  const terminal = factsOf(h.medium).findLast((fact) => fact.subject === childId && fact.kind === 'run/verified')!
  const events: SessionEvent[] = []
  const message = schedulerMessage({ kind: 'singularity', purpose: 'plan-outcome', controlId: h.apparatus.controlId,
    parentTaskId: h.proposal.taskId, taskId: childId, runId: run.runId, factSeq: terminal.seq }, 'child evidence settled')
  let waits = 0
  const session = { sessionId: h.caller.sessionId, wait: async () => {
    waits++
    if (waits === 2) events.push({ seq: SessionSeq(events.length), time: 0, type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [message] } } as SessionEvent)
    if (waits === 3) events.push({ seq: SessionSeq(events.length), time: 0, type: 'user/message', data: message } as SessionEvent)
    if (waits === 4) {
      await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), '35')
      await submit(
        h.apparatus,
        fakeExecution(() => undefined),
        h.caller,
        execFor(h.agent, 'answer'),
        { taskId: h.proposal.taskId, path: h.proposal.contract.artifact },
        new AbortController().signal,
        fixtureReview(h.apparatus),
      )
    }
  } } as ChildSession
  const persistence = { open: async () => ({ read: async () => ({ events }), close: async () => undefined }) } as unknown as SessionPersistence
  expect((await waitForTask({ ...h.apparatus, persistence }, h.proposal.taskId, session, new AbortController().signal)).status)
    .toBe('verified')
  expect(waits).toBe(4)
  await h.apparatus.store.close()
})
it('refuses exact ancestor responsibilities even under fresh child keys and template provenance', async () => {
  const h = await setup(),
    contract = h.proposal.contract
  await expect(
    decompose(h.apparatus, { advance: async () => [] }, h.caller, {
      taskId: h.proposal.taskId,
      children: [{ key: 'again', contract, dependsOn: [], supports: ['letters'], maxRuns: 1, requirement: 'required' as const }],
    }),
  ).rejects.toThrow('repeats an ancestor')
  expect(factsOf(h.medium).filter((f) => f.kind === 'task/admitted')).toHaveLength(1)
  await h.apparatus.store.close()
})
it('waits for a committed round outcome to enter and finish its native turn before diagnosing a missing report', async () => {
  const h = await setup(),
    analysis = await propose(h.apparatus, { ...h.caller, agentId: 'analysis', sessionId: 'analysis' }, 'analysis',
      { goal: 'analyze methods' }, { purpose: 'improve', relatedTo: { taskId: h.proposal.taskId, runId: h.proposal.runId } })
  const fact = (commandId: string, kind: string, payload: unknown, as?: string) => h.apparatus.store.emit({
    commandId, kind, protocol: TASK_PROTOCOL, version: TASK_VERSION, subject: analysis.taskId, payload,
    ...(as === undefined ? {} : { as }),
  })
  const method = taskStateOf(h.apparatus, analysis.taskId).runs[analysis.runId]!.revision
  await fact('request:notification', 'rsi/round-requested', {
    runId: analysis.runId, roundId: 'notification', round: 1, incumbent: method, candidates: [method],
  }, 'agent:analysis')
  const outcome = await fact('round-settled:notification', 'rsi/round-settled',
    { roundId: 'notification', status: 'failed', error: 'insufficient evidence' })
  const message = schedulerMessage({ kind: 'singularity', purpose: 'plan-outcome', controlId: h.apparatus.controlId,
    parentTaskId: analysis.taskId, taskId: analysis.taskId, runId: analysis.runId, factSeq: outcome.seq }, 'outcome')
  const events: SessionEvent[] = []
  const persistence = { open: async () => ({ read: async () => ({ events }), close: async () => undefined }) } as unknown as SessionPersistence
  let waits = 0
  const session = { sessionId: 'analysis', wait: async () => {
    waits++
    if (waits === 2) events.push({ seq: SessionSeq(events.length), time: 0, type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [message] } } as SessionEvent)
    if (waits === 3) events.push({ seq: SessionSeq(events.length), time: 0, type: 'user/message', data: message } as SessionEvent)
    if (waits === 4) events.push({ seq: SessionSeq(events.length), time: 0, type: 'turn/end', data: {} } as SessionEvent)
  } } as ChildSession
  await expect(waitForTask({ ...h.apparatus, persistence }, analysis.taskId, session, new AbortController().signal))
    .resolves.toMatchObject({ status: 'failed', failureCause: 'business', failureReason: expect.stringContaining('stopped without submitting') })
  expect(waits).toBe(4)
  await h.apparatus.store.close()
})

it('ends an idle RSI Run without a submission or pending coordination instead of polling indefinitely', async () => {
  const h = await setup()
  const analysis = await propose(h.apparatus, { ...h.caller, agentId: 'analysis', sessionId: 'analysis' }, 'idle-analysis',
    { goal: 'analyze methods' }, { purpose: 'improve', relatedTo: { taskId: h.proposal.taskId, runId: h.proposal.runId } })
  let waits = 0
  const session = { sessionId: 'analysis', wait: async () => { waits++ } } as ChildSession
  const persistence = { open: async () => ({ read: async () => ({ events: [] }), close: async () => undefined }) } as unknown as SessionPersistence
  const wait = () => waitForTask({ ...h.apparatus, persistence }, analysis.taskId, session, new AbortController().signal)
  try {
    await expect(wait()).resolves.toMatchObject({ status: 'failed', failureCause: 'business',
      failureReason: 'the native agent stopped without submitting after coordination settled' })
    expect(waits).toBe(1)
    const failures = factsOf(h.medium).filter(fact => fact.subject === analysis.taskId && fact.kind === 'run/failed')
    expect(failures).toHaveLength(1)
    await expect(wait()).resolves.toMatchObject({ runId: analysis.runId, status: 'failed' })
    expect(factsOf(h.medium).filter(fact => fact.subject === analysis.taskId && fact.kind === 'run/failed')).toEqual(failures)
  } finally { await h.apparatus.store.close() }
})


it('reads large sealed findings in explicit UTF-8 pages without copying them into task history', async () => {
  const h = await setup()
  const text = '边界证据'.repeat(10_000)
  await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), text)
  await submit(h.apparatus, fakeExecution(() => undefined), h.caller, execFor(h.agent, 'large-report'),
    { taskId: h.proposal.taskId, path: h.proposal.contract.artifact }, new AbortController().signal, fixtureReview(h.apparatus))
  const history = await historyOf(h.apparatus, [], h.caller.agentId)
  expect(JSON.stringify(history.tasks)).not.toContain(text)
  let from = 0, read = ''
  while (from < Buffer.byteLength(text)) {
    const page = await readArtifact(h.apparatus, h.proposal.taskId, h.proposal.runId, from, 16_384)
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(16_384)
    read += page.text; from = page.next
  }
  expect(read).toBe(text)
  await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), 'changed after submission')
  expect((await readArtifact(h.apparatus, h.proposal.taskId, h.proposal.runId, 0, 12)).text).toBe('边界证据')
  await expect(readArtifact(h.apparatus, h.proposal.taskId, undefined, 1, 12)).rejects.toThrow('character boundary')
  await expect(readArtifact(h.apparatus, h.proposal.taskId, undefined, 0, 32769)).rejects.toThrow('32768')
  await expect(readArtifact(h.apparatus, h.proposal.taskId, 'foreign-run')).rejects.toThrow('no sealed artifact')
  await h.apparatus.store.close()
})

it('keeps validation and heldout Tasks outside proposer reads and prepared memory scope', async () => {
  const h = await setup()
  const caller = { ...h.caller, agentId: 'analysis', sessionId: 'analysis' }
  const analysis = await propose(h.apparatus, caller, 'analysis-private', { goal: 'analyze methods' },
    { purpose: 'improve', relatedTo: { taskId: h.proposal.taskId, runId: h.proposal.runId } })
  for (const split of ['evolve', 'validation', 'heldout'] as const) {
    const trial = await propose(h.apparatus, { ...h.caller, agentId: `trial-${split}`, sessionId: `trial-${split}` }, split,
      { goal: `private-${split}` }, { purpose: 'evaluation', relatedTo: { taskId: analysis.taskId, runId: analysis.runId },
        case: { caseId: split, familyId: split, split } })
    const request = readForAgent(h.apparatus, 'analysis', { kind: 'task', ref: trial.taskId })
    if (split === 'evolve') await expect(request).resolves.toMatchObject({ taskId: trial.taskId })
    else {
      await expect(request).rejects.toThrow('outside this evidence scope')
      await expect(readForAgent(h.apparatus, 'analysis', { kind: 'trajectory', rootId: trial.taskId,
        ref: `trial-${split}` })).rejects.toThrow('closed subject')
    }
    await expect(readForAgent(h.apparatus, `trial-${split}`, { kind: 'task', ref: trial.taskId })).resolves.toMatchObject({ taskId: trial.taskId })
  }
  await h.apparatus.store.close()
})
