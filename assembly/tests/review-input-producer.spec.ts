import { fileURLToPath } from 'node:url'
import { testProjections } from './seam.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createReviewCommands } from '../../src/review/commands.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { bindCaller, callerOf, declareCaller, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { startAttempt } from '../src/attempt.ts'
import { readScopeOf } from '../src/coordination.ts'
import { loadDomain } from '../src/domain.ts'
import { sha256 } from '../src/ids.ts'
import { createMethod, loadMethod, seedMethod } from '../src/method.ts'
import { spawnProcess } from '../src/process.ts'
import { historyOf, readForAgent, readTrajectory } from '../src/read.ts'
import { acceptanceSubject } from '../src/review.ts'
import { submit } from '../src/submission.ts'
import { templateDeclaration } from '../src/template.ts'
import { attachmentsAt, agentFor, execFor, fakeExecution, FakePersistence } from './seam.ts'
import { fixtureReview } from './review-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const event = (seq: number): SessionEvent => ({ seq: SessionSeq(seq), time: seq, type: 'turn/end', data: {} }) as SessionEvent

it('reviews only the exact direct producer Run and its sealed transcript despite later same-byte Runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-producer-')); roots.push(root)
  const apparatus = await openApparatus('producer-scope', root,
    await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
    new FakePersistence() as never, attachmentsAt(root), testProjections)
  const method = await seedMethod(apparatus)
  const addTask = async (taskId: string, inputs: TaskContract['inputs']) => {
    const agent = agentFor(taskId, taskId), caller = callerOf(agent)
    await bindCaller(apparatus, caller)
    const commands = apparatus.tasks.forAgent(caller.agentId)
    const contract: TaskContract = { goal: `Produce evidence for ${taskId}`, artifact: 'answer.txt', inputs,
      criteria: [{ criterionId: 'accurate', statement: 'The result accurately reflects its inputs.' }] }
    await commands.admit({ commandId: 'admit:' + taskId, taskId, contract })
    await commands.assign({ commandId: 'assign:' + taskId, taskId, agentId: caller.agentId })
    const run = await startAttempt(apparatus, caller, taskId, 'first', method)
    return { taskId, agent, caller, commands, run }
  }
  const nativeEvents = new Map<string, SessionEvent[]>()
  const finish = async (task: Awaited<ReturnType<typeof addTask>>, run: typeof task.run, text: string, events: SessionEvent[]) => {
    nativeEvents.set(task.caller.sessionId, events)
    await writeFile(join(run.bubble!.workspace.ref, 'answer.txt'), text)
    const execution = { ...fakeExecution(() => undefined), sealTranscript: async () => ({
      sessionId: task.caller.sessionId, eventCount: events.length,
      digest: digestOf({ sessionId: task.caller.sessionId, eventCount: events.length, events }),
    }) }
    await submit(apparatus, execution, task.caller, execFor(task.agent, run.runId),
      { taskId: task.taskId, path: 'answer.txt' }, new AbortController().signal, fixtureReview(apparatus))
  }
  const upstream = await addTask('upstream', [])
  await finish(upstream, upstream.run, 'upstream evidence', [event(0)])
  const producer = await addTask('producer', [{ name: 'upstream.txt', source: { kind: 'artifact', taskId: upstream.taskId } }])
  await finish(producer, producer.run, 'verified producer evidence', [event(0)])
  const peer = await addTask('peer', [])
  await finish(peer, peer.run, 'unrelated evidence', [])
  const consumer = await addTask('consumer', [{ name: 'prior.txt', source: { kind: 'artifact', taskId: producer.taskId } }])
  expect(consumer.run.bubble!.inputs[0]!.producerRunId).toBe(producer.run.runId)

  // The consumer selected its source before this same-byte producer attempt existed.
  const later = await startAttempt(apparatus, producer.caller, producer.taskId, 'later', method)
  await finish(producer, later, 'verified producer evidence', [event(0), event(1)])
  const artifact = await apparatus.attachments.saveFile({ name: 'answer.txt', data: Buffer.from('consumer result') })
  await consumer.commands.submitRun({ commandId: 'seal:consumer', taskId: consumer.taskId, runId: consumer.run.runId,
    submission: { requestId: 'consumer', requestDigest: sha256('consumer'), artifactDigest: sha256('consumer result'),
      inputDigests: consumer.run.bubble!.inputs.map(({ name, digest }) => ({ name, digest })),
      files: { artifact, inputs: consumer.run.bubble!.inputs.map(({ name, attachment }) => ({ name, attachment: attachment! })) },
      source: { sessionId: 'consumer', eventCount: 0, digest: digestOf({ sessionId: 'consumer', eventCount: 0, events: [] }) },
    } })
  const subject = await acceptanceSubject(apparatus, consumer.taskId, taskStateOf(apparatus, consumer.taskId).runs[consumer.run.runId]!, [])
  expect(subject.inputProducers).toMatchObject([{ name: 'prior.txt', taskId: 'producer', runId: producer.run.runId,
    source: { eventCount: 1 }, evidence: [{ reviewId: expect.any(String), verdict: 'pass' }] }])
  expect(subject.inputProducers[0]!.artifactDigest).toBe(consumer.run.bubble!.inputs[0]!.digest)
  const reviewId = 'consumer-review', reviewerId = 'independent-reviewer', key = declareCaller(apparatus, reviewerId)
  await apparatus.agents.open({ commandId: 'agent:' + reviewerId, agentId: reviewerId, sessionId: reviewerId, role: 'review' })
  const bytes = Buffer.from(JSON.stringify(subject))
  const reviewInput = {
    target: { kind: 'acceptance' as const, taskId: consumer.taskId, runId: consumer.run.runId,
      contractDigest: taskStateOf(apparatus, consumer.taskId).contractDigest!, artifactDigest: sha256('consumer result') },
    subject: await apparatus.attachments.saveFile({ name: 'subject.json', data: bytes }), subjectDigest: sha256(bytes),
    criteria: taskStateOf(apparatus, consumer.taskId).contract!.criteria,
    agentId: reviewerId, sessionId: reviewerId, identity: apparatus.store.identityOf(key)!,
    workspace: join(root, 'review'), model: consumer.run.bubble!.model, method,
  }
  await createReviewCommands(apparatus.store).start('start:' + reviewId, reviewId, reviewInput)
  const reading = { ...apparatus, persistence: { open: async (sessionId: string) => ({
    read: async () => ({ events: nativeEvents.get(sessionId) ?? [] }), close: async () => undefined,
  }) } as never }
  expect((await readScopeOf(reading, reviewerId)).visible).toEqual(new Set(['consumer', 'producer']))
  const held = await readForAgent(reading, reviewerId, { kind: 'task', ref: 'producer' }) as {
    contract: TaskContract; parent: unknown; decomposition: unknown; runs: { runId: string; evidence: unknown[] }[]
  }
  expect(held.contract.inputs[0]!.source).toEqual({ kind: 'artifact', taskId: 'upstream' })
  expect(held.parent).toBeNull(); expect(held.decomposition).toBeNull()
  expect(held.runs.map((run) => run.runId)).toEqual([producer.run.runId])
  expect(held.runs[0]!.evidence).toEqual(subject.inputProducers[0]!.evidence)
  expect(await readForAgent(reading, reviewerId, { kind: 'artifact', ref: 'producer' }))
    .toMatchObject({ runId: producer.run.runId, text: 'verified producer evidence' })
  await expect(readForAgent(reading, reviewerId, { kind: 'artifact', ref: 'producer', runId: later.runId }))
    .rejects.toThrow('outside this frozen input producer scope')
  expect(await readTrajectory(reading, reviewerId, 'producer')).toMatchObject([{ seq: 0, type: event(0).type }])
  expect(await readTrajectory(reading, reviewerId, 'producer', 1)).toEqual([])
  for (const taskId of ['upstream', 'peer']) {
    await expect(readForAgent(reading, reviewerId, { kind: 'task', ref: taskId })).rejects.toThrow('outside this evidence scope')
    await expect(readTrajectory(reading, reviewerId, taskId)).rejects.toThrow('outside the frozen evidence scope')
  }
  const history = await historyOf(reading, [], reviewerId)
  expect(history.tasks.find((task) => task.taskId === 'producer')!.runs.map((run) => run.runId)).toEqual([producer.run.runId])
  const summary = await readForAgent(reading, reviewerId) as { tasks: { taskId: string; children: unknown[]; runs: { runId: string }[] }[] }
  expect(summary.tasks.find((task) => task.taskId === 'producer')).toMatchObject({ children: [], runs: [{ runId: producer.run.runId }] })

  // New method and transcript evidence after the subject seal do not widen the read capability.
  const loaded = await loadMethod(apparatus, method)
  const newMethod = await createMethod(apparatus, { ...loaded.assets,
    templates: [...loaded.domain.templates.values()].map((template, index) =>
      index === 0 ? { ...templateDeclaration(template), guidance: 'A new method for a later attempt.' } : templateDeclaration(template)) })
  const newest = await startAttempt(apparatus, producer.caller, producer.taskId, 'newest', newMethod)
  await finish(producer, newest, 'verified producer evidence', [event(0), event(1), event(2)])
  await expect(readForAgent(reading, reviewerId, { kind: 'method', ref: newMethod.digest })).rejects.toThrow('outside this frozen evidence scope')
  expect(await readTrajectory(reading, reviewerId, 'producer')).toMatchObject([{ seq: 0, type: event(0).type }])
  nativeEvents.set('producer', [{ ...event(0), time: 99 }])
  await expect(readTrajectory(reading, reviewerId, 'producer')).rejects.toThrow('sealed transcript changed')

  // Two named inputs may deliberately pin different verified Runs of the same producer.
  const names = ['first.txt', 'second.txt'], selectedRuns = [producer.run.runId, later.runId]
  const contract: TaskContract = { goal: 'Compare two sealed attempts', artifact: 'answer.txt',
    inputs: names.map((name) => ({ name, source: { kind: 'artifact', taskId: 'producer' } })),
    criteria: [{ criterionId: 'accurate', statement: 'Compare only the declared attempts.' }] }
  await consumer.commands.admit({ commandId: 'admit:multi', taskId: 'multi', contract })
  await consumer.commands.assign({ commandId: 'assign:multi', taskId: 'multi', agentId: consumer.caller.agentId })
  await consumer.commands.startRun({ commandId: 'start:multi', taskId: 'multi', runId: 'multi-run', purpose: 'solve', revision: method })
  const inputs = names.map((name, index) => ({ ...consumer.run.bubble!.inputs[0]!, name, producerRunId: selectedRuns[index]! }))
  await consumer.commands.openBubble({ commandId: 'bubble:multi', taskId: 'multi', runId: 'multi-run', inputs,
    workspace: { kind: 'dir', ref: root }, model: consumer.run.bubble!.model, tools: [], conditions: [] })
  await consumer.commands.submitRun({ commandId: 'seal:multi', taskId: 'multi', runId: 'multi-run', submission: {
    requestId: 'multi', requestDigest: sha256('multi'), artifactDigest: sha256('consumer result'), inputDigests: inputs,
    files: { artifact, inputs: inputs.map(({ name, attachment }) => ({ name, attachment: attachment! })) },
    source: { sessionId: 'consumer', eventCount: 0, digest: digestOf({ sessionId: 'consumer', eventCount: 0, events: [] }) },
  } })
  const multiSubject = Buffer.from(JSON.stringify(await acceptanceSubject(apparatus, 'multi', taskStateOf(apparatus, 'multi').runs['multi-run']!, [])))
  await createReviewCommands(apparatus.store).start('start:multi-review', 'multi-review', { ...reviewInput,
    target: { ...reviewInput.target, taskId: 'multi', runId: 'multi-run', contractDigest: taskStateOf(apparatus, 'multi').contractDigest! },
    criteria: contract.criteria,
    subject: await apparatus.attachments.saveFile({ name: 'subject.json', data: multiSubject }), subjectDigest: sha256(multiSubject),
  })
  await expect(readForAgent(reading, reviewerId, { kind: 'artifact', ref: 'producer' })).rejects.toThrow('explicit runId')
  expect(await readForAgent(reading, reviewerId, { kind: 'artifact', ref: 'producer', runId: later.runId }))
    .toMatchObject({ runId: later.runId, text: 'verified producer evidence' })
  expect((await readScopeOf(reading, reviewerId)).frozenProducers.get('producer')!.map((producer) => producer.runId)).toEqual(selectedRuns)
  await apparatus.store.close()
})
