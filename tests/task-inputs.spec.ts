import { UNIT_VERIFIER } from './task-fixtures.ts'
import { UNIT_IMPLEMENTATION } from './task-fixtures.ts'
import { reviewedVerdict } from './command-fixtures.ts'
import { describe, expect, it } from 'vitest'

import {
  assertContractShape,
  CONTRACT_MEMBERS,
  foldSubject,
  MemoryLog,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskState,
} from '../src/index.ts'
import { AGENT, commandsFor, createRevision, deployment, openAgent, pin } from './command-fixtures.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'
import {
  admitted,
  ARTIFACT,
  assigned,
  BUBBLE_INPUTS,
  bubbleOpened,
  contract,
  fileAttachment,
  started,
  SUBJECTS,
  TASK_ID,
  taskRegistry,
} from './task-fixtures.ts'

const TEMPLATE = { id: 'word-counter', digest: '1'.repeat(64) }
const PROTECTED = {
  name: 'fixture/words.txt',
  source: { kind: 'protected', ref: 'words', digest: 'f'.repeat(64) },
} as const
const typedContract = (inputs: readonly unknown[] = [PROTECTED]) => ({ ...contract(), template: TEMPLATE, inputs })

describe('the task fixes its template and input sources at admission', () => {
  it('records typed sources and permits a task with no inputs', () => {
    for (const inputs of [[PROTECTED], []]) {
      const declared = typedContract(inputs)
      expect(assertContractShape(declared, 'contract', CONTRACT_MEMBERS)).toEqual(declared)
    }
  })

  it.each([
    ['template digest', { ...typedContract(), template: { ...TEMPLATE, digest: 'v1' } }],
    ['template widening', { ...typedContract(), template: { ...TEMPLATE, path: 'template.json' } }],
    ['string input', typedContract(['fixture/words.txt'])],
    ['repeated input', typedContract([PROTECTED, PROTECTED])],
    ['input widening', typedContract([{ ...PROTECTED, digest: 'f'.repeat(64) }])],
    ['unknown source', typedContract([{ name: PROTECTED.name, source: { kind: 'workspace', ref: 'words' } }])],
    ['protected digest', typedContract([{ ...PROTECTED, source: { ...PROTECTED.source, digest: 'later' } }])],
    ['protected widening', typedContract([{ ...PROTECTED, source: { ...PROTECTED.source, taskId: 'producer' } }])],
    [
      'artifact widening',
      typedContract([
        { name: 'in/artifact.txt', source: { kind: 'artifact', taskId: 'producer', digest: 'f'.repeat(64) } },
      ]),
    ],
    ['missing producer', typedContract([{ name: 'in/artifact.txt', source: { kind: 'artifact' } }])],
  ])('refuses %s instead of normalizing its declaration', (_label, declared) => {
    expect(refusalOf(() => assertContractShape(declared, 'contract', CONTRACT_MEMBERS)).code).toBe('malformed-contract')
  })

  it('refuses its own artifact as an input before recording a Task', async () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    const declared = typedContract([{ name: 'in/artifact.txt', source: { kind: 'artifact', taskId: TASK_ID } }])
    expect(await asyncRefusalOf(() => log.emit({ ...admitted(), payload: { contract: declared } }))).toMatchObject({
      code: 'malformed-contract',
      detail: expect.stringContaining('own artifact'),
    })
    expect(log.count).toBe(0)
  })
})

describe('a Bubble binds exactly the inputs its Task declared', () => {
  it.each([
    ['missing', []],
    ['extra', [...BUBBLE_INPUTS, { name: 'extra.txt', digest: 'e'.repeat(64) }]],
    ['renamed', [{ name: 'another.txt', digest: PROTECTED.source.digest }]],
    ['changed protected bytes', [{ name: PROTECTED.name, digest: 'e'.repeat(64) }]],
    ['producer Run on protected bytes', [{ ...BUBBLE_INPUTS[0]!, producerRunId: 'p1' }]],
  ])('refuses %s inputs without opening an execution context', async (_label, inputs) => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    await log.emit({ ...admitted(), payload: { contract: typedContract() } })
    await log.emit(assigned())
    await log.emit(started())
    const before = log.count
    const fact = bubbleOpened()
    expect(
      await asyncRefusalOf(() => log.emit({ ...fact, payload: { ...(fact.payload as object), inputs } })),
    ).toMatchObject({ code: 'evidence-input-mismatch' })
    expect(log.count).toBe(before)
    expect(
      foldSubject<TaskState>(taskRegistry(), log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)?.runs['run-1']
        ?.bubble,
    ).toBeUndefined()
  })
})

const PRODUCER = 'producer'
const CONSUMER = 'consumer'
const INPUT = 'in/extraction.txt'
type ProducerStage = 'missing' | 'working' | 'submitted' | 'sealed-verified' | 'sealed-failed'

async function inputDeployment(stage: ProducerStage, sourceTaskId = PRODUCER) {
  const live = await deployment()
  await createRevision(live)
  await openAgent(live)
  const commands = commandsFor(live)
  const producerContract = { ...typedContract(), criteria: contract().criteria.slice(0, 1) }
  if (stage !== 'missing') {
    await commands.admit({ commandId: 'admit-producer', taskId: PRODUCER, contract: producerContract })
    await commands.assign({ commandId: 'assign-producer', taskId: PRODUCER, agentId: AGENT })
    await commands.startRun({
      purpose: 'solve',
      commandId: 'start-producer',
      taskId: PRODUCER,
      runId: 'p1',
      revision: pin(live),
    })
    await commands.openBubble({
      commandId: 'bubble-producer',
      taskId: PRODUCER,
      runId: 'p1',
      inputs: BUBBLE_INPUTS,
      workspace: { kind: 'dir', ref: '/producer' },
      model: { provider: 'test', model: 'model' },
      tools: [],
      conditions: [],
    })
    if (stage !== 'working') {
      await commands.submitRun({
        commandId: 'seal-producer',
        taskId: PRODUCER,
        runId: 'p1',
        submission: {
          requestId: 'submit-producer',
          requestDigest: '2'.repeat(64),
          artifactDigest: ARTIFACT,
          inputDigests: BUBBLE_INPUTS,
          files: {
            artifact: fileAttachment(ARTIFACT, 'artifact.json'),
            inputs: BUBBLE_INPUTS.map(input => ({
              name: input.name,
              attachment: fileAttachment(input.digest, 'words.txt'),
            })),
          },
          source: { sessionId: 'producer-session', eventCount: 0, digest: '4'.repeat(64) },
        },
      })
    }
    if (stage === 'sealed-verified' || stage === 'sealed-failed') {
      const criterion = producerContract.criteria[0]!
      await reviewedVerdict(live, commands, {
        commandId: 'judge-producer',
        taskId: PRODUCER,
        verdict: {
          reviewId: 'review-1',
          verifierRef: UNIT_VERIFIER,
          verifierVersion: '1',
          runId: 'p1',
          criterionId: criterion.criterionId,
          implementationDigest: UNIT_IMPLEMENTATION,
          verdict: stage === 'sealed-failed' ? 'fail' : 'pass',
          artifactDigest: ARTIFACT,
          inputDigests: BUBBLE_INPUTS,
        },
      })
      await commands.settle({ commandId: 'settle-producer', taskId: PRODUCER, runId: 'p1' })
    }
  }
  await commands.admit({
    commandId: 'admit-consumer',
    taskId: CONSUMER,
    contract: {
      ...typedContract([{ name: INPUT, source: { kind: 'artifact', taskId: sourceTaskId } }]),
      criteria: producerContract.criteria,
    },
  })
  await commands.assign({ commandId: 'assign-consumer', taskId: CONSUMER, agentId: AGENT })
  await commands.startRun({
    purpose: 'solve',
    commandId: 'start-consumer',
    taskId: CONSUMER,
    runId: 'c1',
    revision: pin(live),
  })
  const bubble = (digest = ARTIFACT, producerRunId: string | undefined = 'p1') =>
    commands.openBubble({
      commandId: 'bubble-consumer',
      taskId: CONSUMER,
      runId: 'c1',
      inputs: [{ name: INPUT, digest, ...(producerRunId === undefined ? {} : { producerRunId }) }],
      workspace: { kind: 'dir', ref: '/consumer' },
      model: { provider: 'test', model: 'model' },
      tools: [],
      conditions: [],
    })
  return { live, commands, bubble }
}

describe('artifact inputs require a verified, sealed producer at the command boundary', () => {
  it('does not substitute another verified Task even when its artifact has the expected digest', async () => {
    const { bubble } = await inputDeployment('sealed-verified', 'another-producer')
    expect(await asyncRefusalOf(bubble)).toMatchObject({
      code: 'evidence-input-mismatch',
      detail: expect.stringContaining('another-producer'),
    })
  })

  it.each(['missing', 'working', 'submitted', 'sealed-failed'] as const)(
    'refuses the %s producer without recording a Bubble',
    async stage => {
      const { live, bubble } = await inputDeployment(stage)
      const before = live.store.load().entries().length
      expect(await asyncRefusalOf(bubble)).toMatchObject({
        code: 'evidence-input-mismatch',
        detail: expect.stringContaining(PRODUCER),
      })
      expect(live.store.load().entries()).toHaveLength(before)
    },
  )

  it('refuses bytes from a different artifact even after its producer verifies', async () => {
    const { live, bubble } = await inputDeployment('sealed-verified')
    expect(await asyncRefusalOf(() => bubble('5'.repeat(64)))).toMatchObject({ code: 'evidence-input-mismatch' })
    expect(
      live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, CONSUMER)?.runs['c1']?.bubble,
    ).toBeUndefined()
    await bubble()
    expect(
      live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, CONSUMER)?.runs['c1']?.bubble?.inputs,
    ).toEqual([{ name: INPUT, digest: ARTIFACT, producerRunId: 'p1' }])
  })

  it.each(['', 'unknown-run'])(
    'refuses producer Run %j even when another verified Run has matching bytes',
    async runId => {
      const { bubble } = await inputDeployment('sealed-verified')
      expect(await asyncRefusalOf(() => bubble(ARTIFACT, runId))).toMatchObject({
        code: runId === '' ? 'malformed-payload' : 'evidence-input-mismatch',
      })
    },
  )

  it('requires an explicit producer Run without guessing from its digest', async () => {
    const { commands } = await inputDeployment('sealed-verified')
    expect(
      await asyncRefusalOf(() =>
        commands.openBubble({
          commandId: 'bubble-missing-source',
          taskId: CONSUMER,
          runId: 'c1',
          inputs: [{ name: INPUT, digest: ARTIFACT }],
          workspace: { kind: 'dir', ref: '/consumer' },
          model: { provider: 'test', model: 'model' },
          tools: [],
          conditions: [],
        }),
      ),
    ).toMatchObject({ code: 'evidence-input-mismatch' })
  })

  it('retains the selected verified Run when another Run later verifies the same bytes', async () => {
    const { live, commands, bubble } = await inputDeployment('sealed-verified')
    await commands.startRun({
      commandId: 'start-p2',
      taskId: PRODUCER,
      runId: 'p2',
      purpose: 'solve',
      revision: pin(live),
    })
    await commands.openBubble({
      commandId: 'bubble-p2',
      taskId: PRODUCER,
      runId: 'p2',
      inputs: BUBBLE_INPUTS,
      workspace: { kind: 'dir', ref: '/p2' },
      model: { provider: 'test', model: 'model' },
      tools: [],
      conditions: [],
    })
    const original = live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, PRODUCER)!.runs['p1']!
      .submission!
    await commands.submitRun({
      commandId: 'seal-p2',
      taskId: PRODUCER,
      runId: 'p2',
      submission: {
        ...original,
        requestId: 'p2',
        requestDigest: '5'.repeat(64),
        source: { ...original.source, eventCount: 1 },
      },
    })
    expect(await asyncRefusalOf(() => bubble(ARTIFACT, 'p2'))).toMatchObject({ code: 'evidence-input-mismatch' })
    await reviewedVerdict(live, commands, {
      commandId: 'judge-p2',
      taskId: PRODUCER,
      verdict: {
        runId: 'p2',
        reviewId: 'review-p2',
        criterionId: contract().criteria[0]!.criterionId,
        verifierRef: UNIT_VERIFIER,
        verifierVersion: '1',
        implementationDigest: UNIT_IMPLEMENTATION,
        verdict: 'pass',
        artifactDigest: ARTIFACT,
        inputDigests: BUBBLE_INPUTS,
      },
    })
    await commands.settle({ commandId: 'settle-p2', taskId: PRODUCER, runId: 'p2' })
    await bubble()
    expect(
      live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, CONSUMER)!.runs['c1']!.bubble!.inputs[0],
    ).toEqual({ name: INPUT, digest: ARTIFACT, producerRunId: 'p1' })
  })

  it('observes a producer settlement committed ahead of it in the same queue', async () => {
    const { live, commands, bubble } = await inputDeployment('submitted')
    const criterion = contract().criteria[0]!
    await reviewedVerdict(live, commands, {
      commandId: 'judge-producer',
      taskId: PRODUCER,
      verdict: {
        reviewId: 'review-1',
        verifierRef: UNIT_VERIFIER,
        verifierVersion: '1',
        runId: 'p1',
        criterionId: criterion.criterionId,
        implementationDigest: UNIT_IMPLEMENTATION,
        verdict: 'pass',
        artifactDigest: ARTIFACT,
        inputDigests: BUBBLE_INPUTS,
      },
    })
    await Promise.all([commands.settle({ commandId: 'settle-producer', taskId: PRODUCER, runId: 'p1' }), bubble()])
    expect(
      live.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, CONSUMER)?.runs['c1']?.bubble?.inputs[0]
        ?.digest,
    ).toBe(ARTIFACT)
  })
})
