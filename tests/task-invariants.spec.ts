/**
 * The task protocol's invariants, each refused by name.
 *
 * The three that matter most are the ones a weaker design would state in a prompt instead of a
 * reducer: a criterion is decided by the verifier it names, an executor never judges its own
 * run, and a run settles verified only when every criterion has a passing verdict.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  assertContract,
  foldSubject,
  ProtocolLog,
  projectReceipt,
  projectTask,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRegistryOf,
  type RefusalCode,
  type TaskState,
} from '../src/index.ts'
import { asyncRefusalOf, newLogPath, refusalOf } from './fixtures.ts'
import {
  admitted,
  contract,
  failed,
  INTEGRATION_VERIFIER,
  judged,
  RUN_ID,
  started,
  TASK_ID,
  taskRegistry,
  UNIT_VERIFIER,
  VERIFIERS,
  verified,
} from './task-fixtures.ts'

let logPath: string

beforeEach(async () => {
  logPath = await newLogPath()
})

/** Refuse one emission against a log that already carries an admitted, running task. */
async function runningTask(): Promise<ProtocolLog> {
  const log = await ProtocolLog.open(logPath, taskRegistry())
  await log.emit(admitted())
  await log.emit(started())
  return log
}

describe('the verifier boundary', () => {
  it('refuses a verdict from an actor that is not the criterion\'s named verifier', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    await log.emit(started())

    // 'limits' names the integration verifier; the unit verifier may not decide it.
    const refusal = await asyncRefusalOf(() => log.emit(judged('limits', UNIT_VERIFIER)))
    expect(refusal.code).toBe<RefusalCode>('self-reported-evidence')
    expect(refusal.detail).toContain('integration-verifier')
  })

  it('refuses an executor judging its own run, even when the executor is a registered verifier', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    // The run is executed by the very session that is also the registered unit verifier.
    await log.emit(started(RUN_ID, UNIT_VERIFIER))

    const refusal = await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER)))
    expect(refusal.code).toBe<RefusalCode>('self-reported-evidence')
    expect(refusal.detail).toContain('cannot also decide')
  })

  it('refuses a second verdict on one criterion', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    await log.emit(started())
    await log.emit(judged('correctness', UNIT_VERIFIER, 'fail'))

    const refusal = await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER, 'pass')))
    expect(refusal.code).toBe<RefusalCode>('evidence-conflict')
  })
})

describe('settlement', () => {
  it('refuses to verify while a criterion has no passing verdict, and names it', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    await log.emit(started())
    await log.emit(judged('correctness', UNIT_VERIFIER))

    const refusal = await asyncRefusalOf(() => log.emit(verified()))
    expect(refusal.code).toBe<RefusalCode>('unadjudicated-criterion')
    expect(refusal.detail).toContain('"limits" has no passing verdict from integration-verifier')
  })

  it('refuses to verify when a criterion was judged failing, however many passed', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    await log.emit(started())
    await log.emit(judged('correctness', UNIT_VERIFIER, 'pass'))
    await log.emit(judged('limits', INTEGRATION_VERIFIER, 'fail'))

    expect((await asyncRefusalOf(() => log.emit(verified()))).code).toBe<RefusalCode>('unadjudicated-criterion')
  })

  it('refuses any further fact once a run has settled', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    await log.emit(started())
    await log.emit(failed())
    expect((await asyncRefusalOf(() => log.emit(verified()))).code).toBe<RefusalCode>('illegal-transition')
    expect((await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER)))).code).toBe<RefusalCode>('illegal-transition')
  })

  it('takes the failure path to a failed phase and a failed receipt', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    await log.emit(started())
    await log.emit(judged('correctness', UNIT_VERIFIER, 'fail'))
    await log.emit(failed('the golden file never matched'))

    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')
    expect(projectTask(state).phase).toBe('failed')
    expect(projectReceipt(state, RUN_ID).status).toBe('failed')
    expect(projectTask(state).runs[0]?.failureReason).toBe('the golden file never matched')
  })
})

describe('the contract boundary', () => {
  it('refuses a contract nothing would decide', () => {
    const registry = verifierRegistryOf(VERIFIERS)
    const refusal = refusalOf(() => assertContract({ goal: 'g', criteria: [] }, 'contract', registry))
    expect(refusal.code).toBe<RefusalCode>('malformed-contract')
    expect(refusal.detail).toContain('at least one acceptance criterion')
  })

  it('refuses a criterion whose verifier is not registered at the version it names', () => {
    const registry = verifierRegistryOf(VERIFIERS)
    const bad = contract()
    const refusal = refusalOf(() =>
      assertContract(
        { ...bad, criteria: [{ ...bad.criteria[0], verifierRef: 'ghost-verifier' }] },
        'contract',
        registry,
      ),
    )
    expect(refusal.code).toBe<RefusalCode>('unregistered-verifier')
  })

  it('refuses a duplicate criterion id and a criterion with no statement', () => {
    const registry = verifierRegistryOf(VERIFIERS)
    const bad = contract()
    expect(
      refusalOf(() => assertContract({ ...bad, criteria: [bad.criteria[0], bad.criteria[0]] }, 'contract', registry)).code,
    ).toBe<RefusalCode>('malformed-contract')
    expect(
      refusalOf(() => assertContract({ ...bad, criteria: [{ ...bad.criteria[0], statement: '' }] }, 'contract', registry)).code,
    ).toBe<RefusalCode>('malformed-contract')
  })

  it('refuses a run before the task carries a contract', async () => {
    const refusal = await (async () => {
      const log = await ProtocolLog.open(logPath, taskRegistry())
      return asyncRefusalOf(() => log.emit(started()))
    })()
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
  })

  it('refuses a second contract: a later contract is a different task', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    const refusal = await asyncRefusalOf(() => log.emit(admitted()))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('different task')
  })
})

describe('what the protocol does not know', () => {
  it('refuses an unknown run and an unknown criterion', async () => {
    const log = await runningTask()
    expect((await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER, 'pass', 'run-ghost')))).code).toBe<RefusalCode>(
      'unknown-run',
    )
    expect((await asyncRefusalOf(() => log.emit(judged('ghost-criterion', UNIT_VERIFIER)))).code).toBe<RefusalCode>('unknown-criterion')
    expect((await asyncRefusalOf(() => log.emit(verified('run-ghost')))).code).toBe<RefusalCode>('unknown-run')
  })

  it('refuses to derive a receipt for a run that has not settled', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    await log.emit(started())
    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')

    const refusal = refusalOf(() => projectReceipt(state, RUN_ID))
    expect(refusal.code).toBe<RefusalCode>('illegal-transition')
    expect(refusal.detail).toContain('still running')
    expect(refusalOf(() => projectReceipt(state, 'run-ghost')).code).toBe<RefusalCode>('unknown-run')
  })

  it('declares exactly the five kinds this slice needs, and no receipt kind', () => {
    const registry = taskRegistry()
    expect(registry.kindsOf(TASK_PROTOCOL, TASK_VERSION)).toEqual([
      TASK_KINDS.evidenceProduced,
      TASK_KINDS.runFailed,
      TASK_KINDS.runStarted,
      TASK_KINDS.runVerified,
      TASK_KINDS.admitted,
    ])
    expect(Object.values(TASK_KINDS)).not.toContain('receipt/sealed')
  })
})
