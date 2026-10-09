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
  MemoryLog,
  type RefusalCode,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type TaskContract,
} from '../src/index.ts'
import { asyncRefusalOf } from './fixtures.ts'
import { ARTIFACT, REVISION, SCHEDULER, SUBJECTS, TASK_ID, contract, taskRegistry, UNIT_VERIFIER } from './task-fixtures.ts'

let counter = 0
function fact(kind: string, payload: unknown): EmitInput {
  counter += 1
  return { commandId: `bind-${counter}`, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind, subject: TASK_ID, payload }
}

const admitted = (value: TaskContract = contract()): EmitInput => fact(TASK_KINDS.admitted, { contract: value })
const assigned = (agentId: string, agentIdentity: string): EmitInput => fact(TASK_KINDS.assigned, { agentId, agentIdentity })
const reassigned = (from: string, agentId: string, agentIdentity: string): EmitInput => fact(TASK_KINDS.reassigned, { from, agentId, agentIdentity })
const started = (): EmitInput => fact(TASK_KINDS.runStarted, { runId: 'run-1', revision: REVISION })
const INPUTS = [{ name: 'fixture/words.txt', digest: 'f'.repeat(64) }]
const bubble = (inputs = INPUTS): EmitInput => fact(TASK_KINDS.bubbleOpened, { runId: 'run-1', inputs, workspace: { kind: 'git', ref: 'refs/heads/main' } })
const judged = (options: { runId?: string; inputDigests?: readonly { readonly name: string; readonly digest: string }[] } = {}): EmitInput =>
  fact(TASK_KINDS.evidenceProduced, {
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
    expect(refusal.code).toBe<RefusalCode>('not-responsible')
    expect(refusal.detail).toContain('no agent is responsible')
  })

  it('refuses a second assignment, because a change of hands is a transfer', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))
    const refusal = await asyncRefusalOf(() => log.emit(assigned('agent-2', SCHEDULER)))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('transfer')
  })

  it('refuses a transfer that names the wrong holder, or the same one', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))

    const wrongHolder = await asyncRefusalOf(() => log.emit(reassigned('agent-elsewhere', 'agent-2', 'runtime-2')))
    expect(wrongHolder.code).toBe<RefusalCode>('illegal-transition')
    expect(wrongHolder.detail).toContain('current holder')

    const sameAgent = await asyncRefusalOf(() => log.emit(reassigned('agent-1', 'agent-1', 'runtime-2')))
    expect(sameAgent.code).toBe<RefusalCode>('illegal-transition')
    expect(sameAgent.detail).toContain('already holds it')
  })

  it('refuses the previous holder after a transfer, and lets the new one work', async () => {
    // The original holder cannot continue: this is the invariant the frozen repo never had.
    const original = logWith()
    await original.emit(admitted())
    await original.emit(assigned('agent-1', SCHEDULER))
    await original.emit(reassigned('agent-1', 'agent-2', 'runtime-2'))
    const refusal = await asyncRefusalOf(() => original.emit(started()))
    expect(refusal.code).toBe<RefusalCode>('not-responsible')
    expect(refusal.detail).toContain('agent-2')

    // The new holder works in a deployment whose scheduler identity *is* that agent, which is what
    // recovery with a different agent looks like: same facts, different trusted identity.
    const successor = logWith({ scheduler: 'runtime-2' })
    await successor.emit(admitted())
    await successor.emit(assigned('agent-1', SCHEDULER))
    await successor.emit(reassigned('agent-1', 'agent-2', 'runtime-2'))
    const admittedRun = await successor.emit(started())
    expect(admittedRun.kind).toBe(TASK_KINDS.runStarted)
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
    const swapped = await asyncRefusalOf(() => log.emit(judged({ inputDigests: [{ name: 'fixture/words.txt', digest: 'a'.repeat(64) }] })))
    expect(swapped.code).toBe<RefusalCode>('evidence-input-mismatch')

    // A different number of inputs is refused too: "the same inputs" is total, not partial.
    const extra = await asyncRefusalOf(() => log.emit(judged({ inputDigests: [...INPUTS, { name: 'other', digest: 'a'.repeat(64) }] })))
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
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('execution context was never declared')
  })

  it('refuses a second execution context for one run, and one for a settled run', async () => {
    const log = logWith()
    await log.emit(admitted())
    await log.emit(assigned('agent-1', SCHEDULER))
    await log.emit(started())
    await log.emit(bubble())
    const twice = await asyncRefusalOf(() => log.emit(bubble()))
    expect(twice.code).toBe<RefusalCode>('illegal-transition')
    expect(twice.detail).toContain('second execution context')

    const settled = logWith()
    await settled.emit(admitted())
    await settled.emit(assigned('agent-1', SCHEDULER))
    await settled.emit(started())
    await settled.emit(fact(TASK_KINDS.runFailed, { runId: 'run-1', reason: 'gave up' }))
    const late = await asyncRefusalOf(() => settled.emit(bubble()))
    expect(late.code).toBe<RefusalCode>('illegal-transition')
    expect(late.detail).toContain('already settled')
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
})
