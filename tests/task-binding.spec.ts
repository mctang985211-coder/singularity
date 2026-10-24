/**
 * Responsibility and the input binding: the two rules that make "who worked on this" and "what was
 * it judged against" answerable after the fact.
 *
 * Responsibility is the new work here — the frozen repo recorded it and never enforced it, so
 * nothing stopped a parent from continuing work it had just delegated. The teeth are that
 * `run/started` accepts only the current holder's identity, which makes a transfer observable
 * rather than decorative.
 */

import { describe, expect, it } from 'vitest'

import {
  type EmitInput,
  foldSubject,
  MemoryLog,
  type RefusalCode,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskContract,
  type TaskState,
} from '../src/index.ts'
import { contextDigestOf } from '../src/measure/protocol.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'
import {
  ARTIFACT,
  BUBBLE_CONDITIONS,
  BUBBLE_MODEL,
  BUBBLE_TOOLS,
  REVISION,
  SCHEDULER,
  SUBJECTS,
  TASK_ID,
  contract,
  taskRegistry,
  UNIT_VERIFIER,
} from './task-fixtures.ts'

let counter = 0
function fact(kind: string, payload: unknown): EmitInput {
  counter += 1
  return {
    commandId: `bind-${counter}`,
    protocol: TASK_PROTOCOL,
    version: TASK_VERSION,
    kind,
    subject: TASK_ID,
    payload,
  }
}

const admitted = (value: TaskContract = contract()): EmitInput => fact(TASK_KINDS.admitted, { contract: value })
const assigned = (agentId: string, agentIdentity: string): EmitInput =>
  fact(TASK_KINDS.assigned, { agentId, agentIdentity })
const reassigned = (from: string, agentId: string, agentIdentity: string): EmitInput =>
  fact(TASK_KINDS.reassigned, { from, agentId, agentIdentity })
const started = (): EmitInput => fact(TASK_KINDS.runStarted, { purpose: 'solve', runId: 'run-1', revision: REVISION })
const INPUTS = [{ name: 'fixture/words.txt', digest: 'f'.repeat(64) }]
const bubble = (inputs = INPUTS): EmitInput =>
  fact(TASK_KINDS.bubbleOpened, {
    runId: 'run-1',
    inputs,
    workspace: { kind: 'git', ref: 'refs/heads/main' },
    model: BUBBLE_MODEL,
    tools: BUBBLE_TOOLS,
    conditions: BUBBLE_CONDITIONS,
  })

/** The same declaration with one member replaced, for the cases that must be refused. */
const bubbleWith = (overrides: Record<string, unknown>): EmitInput =>
  fact(TASK_KINDS.bubbleOpened, {
    runId: 'run-1',
    inputs: INPUTS,
    workspace: { kind: 'git', ref: 'refs/heads/main' },
    model: BUBBLE_MODEL,
    tools: BUBBLE_TOOLS,
    conditions: BUBBLE_CONDITIONS,
    ...overrides,
  })
const judged = (
  options: { runId?: string; inputDigests?: readonly { readonly name: string; readonly digest: string }[] } = {},
): EmitInput =>
  fact(TASK_KINDS.evidenceProduced, {
    reviewId: 'review-1',
    runId: options.runId ?? 'run-1',
    criterionId: 'correctness',
    verdict: 'pass',
    verifierRef: UNIT_VERIFIER,
    verifierVersion: '1',
    implementationDigest: 'd'.repeat(64),
    artifactDigest: ARTIFACT,
    inputDigests: options.inputDigests ?? INPUTS,
  })

function logWith(subjects: Record<string, string> = SUBJECTS): MemoryLog {
  return new MemoryLog(taskRegistry(), { subjects })
}

describe('only the agent currently answerable may start work', () => {
  it('refuses to start work nobody is responsible for', async () => {
    const log = logWith()
    await log.emit(admitted())
    const refusal = await asyncRefusalOf(() => log.emit(started()))
    expect(refusal).toMatchObject({
      code: 'not-responsible',
      detail: expect.stringContaining('no agent is responsible'),
    })
  })

  it('refuses a second assignment, because a change of hands is a transfer', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))
    const refusal = await asyncRefusalOf(() => log.emit(assigned('agent-2', SCHEDULER)))
    expect(refusal).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('transfer') })
  })

  it('refuses a transfer that names the wrong holder, or the same one', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))

    const wrongHolder = await asyncRefusalOf(() => log.emit(reassigned('agent-elsewhere', 'agent-2', 'runtime-2')))
    expect(wrongHolder).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('current holder') })

    const sameAgent = await asyncRefusalOf(() => log.emit(reassigned('agent-1', 'agent-1', 'runtime-2')))
    expect(sameAgent).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('already holds it') })
  })

  it('refuses a transfer emitted under an identity that is not the holder', async () => {
    // The `from` member names the right agent, so the only thing wrong is who is acting: this deployment's
    // table resolves the emitter to an identity the assignment never named. Handing work to somebody else
    // is a decision about one's own responsibility, so an actor that does not hold the task has nothing to
    // hand over — and the transfer's `from` cannot catch that, because a request may say anything.
    const log = logWith({ ...SUBJECTS, scheduler: 'runtime-elsewhere' })
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))
    const refusal = await asyncRefusalOf(() => log.emit(reassigned('agent-1', 'agent-2', 'runtime-elsewhere')))
    expect(refusal).toMatchObject({ code: 'not-responsible', detail: expect.stringContaining(SCHEDULER) })
  })

  it('refuses the previous holder after a transfer, and lets the new one work', async () => {
    // The original holder cannot continue: this is the invariant the frozen repo never had.
    const original = logWith()
    await original.emit(admitted())
    await original.emit(assigned('agent-1', SCHEDULER))
    await original.emit(reassigned('agent-1', 'agent-2', 'runtime-2'))
    const refusal = await asyncRefusalOf(() => original.emit(started()))
    expect(refusal).toMatchObject({ code: 'not-responsible', detail: expect.stringContaining('agent-2') })

    // The new holder works in a deployment whose identity *is* that agent, which is what recovery
    // with a different trusted identity looks like: the same facts, re-stamped from the table this
    // deployment now holds. Both the assignment and the transfer carry the identity the successor's
    // own log stamps, because a transfer is the holder's act and the holder is whoever `assigned`
    // last named.
    const successor = logWith({ scheduler: 'runtime-2' })
    await successor.emit(admitted())
    await successor.emit(assigned('agent-1', 'runtime-2'))
    await successor.emit(reassigned('agent-1', 'agent-2', 'runtime-2'))
    const admittedRun = await successor.emit(started())
    expect(admittedRun.kind).toBe(TASK_KINDS.runStarted)
  })
})

describe('the execution context says what actually ran', () => {
  it('keeps provider and model names separate when either contains a slash', async () => {
    const log = logWith()
    for (const command of [admitted(), assigned('agent-1', SCHEDULER), started()]) await log.emit(command)
    const model = { provider: 'provider/region', model: 'model/name' }
    await log.emit(bubbleWith({ model }))
    const state = foldSubject<TaskState>(taskRegistry(), log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    const recorded = state!.runs['run-1']!.bubble!
    expect(recorded.model).toEqual(model)
    expect(contextDigestOf(recorded)).not.toBe(
      contextDigestOf({ ...recorded, model: { provider: 'provider', model: 'region/model/name' } }),
    )
  })

  it.each([
    'provider/model',
    {},
    { provider: 'provider' },
    { model: 'model' },
    { provider: '', model: 'model' },
    { provider: 'provider', model: '' },
    { provider: 3, model: 'model' },
    { provider: 'provider', model: 'model', route: 'extra' },
  ])('refuses an incomplete or widened model route %j before committing', async model => {
    const log = logWith()
    for (const command of [admitted(), assigned('agent-1', SCHEDULER), started()]) await log.emit(command)
    expect(await asyncRefusalOf(() => log.emit(bubbleWith({ model })))).toMatchObject({ code: 'malformed-payload' })
    expect(log.count).toBe(3)
  })

  it('refuses a bubble that cannot name its model, its tools or its conditions', () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    log.emit(admitted())
    log.emit(assigned('agent-1', SCHEDULER))
    log.emit(started())

    // Each omission is a different unrecorded condition, and each is refused by name rather than
    // defaulted: a context that cannot say what ran is not a context a later decision may rest on.
    for (const member of ['model', 'tools', 'conditions']) {
      const payload = {
        runId: 'run-1',
        inputs: INPUTS,
        workspace: { kind: 'git', ref: 'refs/heads/main' },
        model: BUBBLE_MODEL,
        tools: BUBBLE_TOOLS,
        conditions: BUBBLE_CONDITIONS,
      } as Record<string, unknown>
      delete payload[member]
      const refusal = refusalOf(() => log.emit(fact(TASK_KINDS.bubbleOpened, payload)))
      expect(`${member}: ${refusal.code}`).toBe(`${member}: malformed-payload`)
    }

    // The tool shape is closed: a widened tool is refused, not trimmed.
    const widened = refusalOf(() => log.emit(bubbleWith({ tools: [{ ...BUBBLE_TOOLS[0], note: 'extra' }] })))
    expect(widened).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('closed') })

    // A tool's content identity is a digest, not a version string that happens to look right.
    expect(
      refusalOf(() => log.emit(bubbleWith({ tools: [{ name: 'count', version: '1', implementationDigest: 'v1' }] })))
        .code,
    ).toBe<RefusalCode>('malformed-payload')
    // Two tools under one name are one tool, and a repeated condition is stated once.
    expect(refusalOf(() => log.emit(bubbleWith({ tools: [BUBBLE_TOOLS[0], BUBBLE_TOOLS[0]] }))).code).toBe<RefusalCode>(
      'malformed-payload',
    )
    expect(refusalOf(() => log.emit(bubbleWith({ conditions: ['no-network', 'no-network'] }))).code).toBe<RefusalCode>(
      'malformed-payload',
    )
    // The workspace is closed by `nested.workspace`, the set the declaration hands that reader.
    expect(
      refusalOf(() => log.emit(bubbleWith({ workspace: { kind: 'git', ref: 'refs/heads/main', note: 'extra' } }))).code,
    ).toBe<RefusalCode>('malformed-payload')
    expect(log.entries()).toHaveLength(3)
  })

  it('keeps the manifest on the run, so a reader can say what the execution could reach', () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    log.emit(admitted())
    log.emit(assigned('agent-1', SCHEDULER))
    log.emit(started())
    log.emit(bubble())

    const state = foldSubject<TaskState>(taskRegistry(), log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    expect([
      state?.runs['run-1']?.bubble?.model,
      state?.runs['run-1']?.bubble?.tools,
      state?.runs['run-1']?.bubble?.conditions,
    ]).toEqual([BUBBLE_MODEL, BUBBLE_TOOLS, BUBBLE_CONDITIONS])
  })
})

describe('a verdict is bound to the inputs the run declared', () => {
  it('refuses a verdict formed on inputs the run never declared', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))
    await log.emit(started())
    await log.emit(bubble())

    // A different digest for the same input name: the input was swapped after the run began.
    const swapped = await asyncRefusalOf(() =>
      log.emit(judged({ inputDigests: [{ name: 'fixture/words.txt', digest: 'a'.repeat(64) }] })),
    )
    expect(swapped.code).toBe<RefusalCode>('evidence-input-mismatch')

    // A different number of inputs is refused too: "the same inputs" is total, not partial.
    const extra = await asyncRefusalOf(() =>
      log.emit(judged({ inputDigests: [...INPUTS, { name: 'other', digest: 'a'.repeat(64) }] })),
    )
    expect(extra.code).toBe<RefusalCode>('evidence-input-mismatch')

    // The declared inputs still pass, so the rule refuses the substitution rather than the verdict.
    await log.emit(judged())
    expect(log.entries()).toHaveLength(5)
  })

  it('refuses to judge a run whose execution context was never declared', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))
    await log.emit(started())
    const refusal = await asyncRefusalOf(() => log.emit(judged()))
    expect(refusal).toMatchObject({
      code: 'illegal-transition',
      detail: expect.stringContaining('execution context was never declared'),
    })
  })

  it('refuses a second execution context for one run, and one for a settled run', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))
    await log.emit(started())
    await log.emit(bubble())
    const twice = await asyncRefusalOf(() => log.emit(bubble()))
    expect(twice).toMatchObject({
      code: 'illegal-transition',
      detail: expect.stringContaining('second execution context'),
    })

    const settled = logWith()
    await settled.emit(admitted())
    await settled.emit(assigned('agent-1', SCHEDULER))
    await settled.emit(started())
    await settled.emit(fact(TASK_KINDS.runFailed, { runId: 'run-1', cause: 'runtime', reason: 'gave up' }))
    const late = await asyncRefusalOf(() => settled.emit(bubble()))
    expect(late).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('already settled') })
  })

  it('refuses a bubble whose inputs are malformed, each by name', async () => {
    for (const [label, inputs] of [
      ['a non-array', 'not-an-array'],
      ['a repeated input name', [...INPUTS, ...INPUTS]],
      ['a digest that is not a digest', [{ name: 'fixture/words.txt', digest: 'nope' }]],
      ['an unknown member', [{ name: 'fixture/words.txt', digest: 'f'.repeat(64), note: 'extra' }]],
    ] as const) {
      const log = logWith()
      await log.emit(admitted())
      await log.emit(assigned('agent-1', SCHEDULER))
      await log.emit(started())
      const refusal = await asyncRefusalOf(() => log.emit(bubble(inputs as never)))
      expect(`${label}: ${refusal.code}`).toBe(`${label}: malformed-payload`)
    }
  })

  /**
   * The nested entry, not a copy in the reader. `evidence/produced` declares
   * `nested: { inputDigests }` and hands it to `inputList`; a reader that widened itself by one member
   * would accept this entry while the declaration still printed `["name","digest"]`, which is the
   * sixth review's second direction. The bubble leg above names the same member for `bubble/opened`,
   * and this one names it for the verdict's own list.
   */
  it('closes each verdict input with the set the declaration names, not a wider one', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))
    await log.emit(started())
    await log.emit(bubble())
    const widened = await asyncRefusalOf(() =>
      log.emit(
        judged({ inputDigests: [{ name: 'fixture/words.txt', digest: 'f'.repeat(64), note: 'extra' }] as never }),
      ),
    )
    expect(widened).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('note') })
  })
})
