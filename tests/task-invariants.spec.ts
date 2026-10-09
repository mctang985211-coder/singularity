/**
 * The task protocol's invariants, each refused by name — plus the two regressions the reviewer's
 * counterexamples established: a closed payload is not silently widened, and explaining an old
 * fact never depends on what this deployment can run today.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  assertContract,
  assertContractShape,
  foldSubject,
  MemoryLog,
  projectReceipt,
  projectTask,
  REFUSAL_CODES,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRegistryOf,
  verifierRoleOf,
  type RefusalCode,
  type TaskState,
} from '../src/index.ts'
import { asyncRefusalOf, newLogPath, refusalOf } from './fixtures.ts'
import {
  admitted,
  ARTIFACT,
  contract,
  INTEGRATION_IMPLEMENTATION,
  INTEGRATION_VERIFIER,
  judged,
  REVISION,
  RUN_ID,
  SCHEDULER,
  sliceCommands,
  started,
  SUBJECTS,
  TASK_ID,
  taskRegistry,
  UNIT_IMPLEMENTATION,
  UNIT_VERIFIER,
  VERIFIERS,
  verified,
} from './task-fixtures.ts'

let logPath: string

beforeEach(async () => {
  logPath = await newLogPath()
})

/** A log that already carries an admitted, running task. */
async function running(): Promise<MemoryLog> {
  const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
  await log.emit(admitted())
  await log.emit(started())
  return log
}

describe('the verifier boundary', () => {
  it('refuses a verdict whose implementation is not the criterion\'s', async () => {
    const log = await running()
    // 'limits' names the integration verifier; the unit verifier may not decide it.
    const refusal = await asyncRefusalOf(() => log.emit(judged('limits', UNIT_VERIFIER)))
    expect(refusal.code).toBe<RefusalCode>('wrong-verifier')
    expect(refusal.detail).toContain('integration-verifier@1')
  })

  it('refuses a verdict from different code behind the same verifier name', async () => {
    const log = await running()
    // The criterion names `unit-verifier@1` implemented by UNIT_IMPLEMENTATION. A deployment that
    // rebuilt that verifier under the same name and version is *different code*, and its verdict
    // must not inherit the criterion's acceptance. A ref and a version cannot express this; the
    // digest can, which is why the criterion and the verdict both carry one.
    const refusal = await asyncRefusalOf(() =>
      log.emit(judged('correctness', UNIT_VERIFIER, 'pass', { implementationDigest: INTEGRATION_IMPLEMENTATION })),
    )
    expect(refusal.code).toBe<RefusalCode>('wrong-verifier')
    expect(refusal.detail).toContain('names the implementation')
  })

  it('refuses a deployment that binds one identity to both the executor and a verifier', async () => {
    // The executor and the verifier are different roles, but one identity holds both. Role
    // separation alone would pass this, so the identity is checked too.
    const shared = { scheduler: 'shared-identity', [verifierRoleOf({ verifierRef: UNIT_VERIFIER, verifierVersion: '1' })]: 'shared-identity' }
    const log = new MemoryLog(taskRegistry(), { subjects: shared })
    await log.emit(admitted())
    await log.emit(started())

    const refusal = await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER)))
    expect(refusal.code).toBe<RefusalCode>('self-reported-evidence')
    expect(refusal.detail).toContain('cannot also judge')
  })

  it('refuses a second verdict on one criterion', async () => {
    const log = await running()
    await log.emit(judged('correctness', UNIT_VERIFIER, 'fail'))

    const refusal = await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER, 'pass')))
    expect(refusal.code).toBe<RefusalCode>('evidence-conflict')
  })
})

describe('settlement', () => {
  it('refuses to verify while a criterion has no passing verdict, and names it', async () => {
    const log = await running()
    await log.emit(judged('correctness', UNIT_VERIFIER))

    const refusal = await asyncRefusalOf(() => log.emit(verified()))
    expect(refusal.code).toBe<RefusalCode>('unadjudicated-criterion')
    expect(refusal.detail).toContain('"limits" has no passing verdict from integration-verifier@1')
  })

  it('refuses to verify when a criterion was judged failing, however many passed', async () => {
    const log = await running()
    await log.emit(judged('correctness', UNIT_VERIFIER, 'pass'))
    await log.emit(judged('limits', INTEGRATION_VERIFIER, 'fail'))

    expect((await asyncRefusalOf(() => log.emit(verified()))).code).toBe<RefusalCode>('unadjudicated-criterion')
  })

  it('refuses any further fact once a run has settled', async () => {
    const log = await running()
    await log.emit({ commandId: 'f1', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'run/failed', subject: TASK_ID, payload: { runId: RUN_ID, reason: 'no golden file' } })

    expect((await asyncRefusalOf(() => log.emit(verified()))).code).toBe<RefusalCode>('illegal-transition')
    expect((await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER)))).code).toBe<RefusalCode>('illegal-transition')
  })
})

describe('payloads are closed', () => {
  it('refuses an unknown contract member and a missing explicit member', () => {
    const verifiers = verifierRegistryOf(VERIFIERS)
    const widened = { ...contract(), extra: 'typo' }
    expect(refusalOf(() => assertContract(widened, 'contract', verifiers)).code).toBe<RefusalCode>('malformed-contract')

    const withoutInputs = { goal: 'g', criteria: contract().criteria }
    expect(refusalOf(() => assertContract(withoutInputs, 'contract', verifiers)).code).toBe<RefusalCode>('malformed-contract')

    const criterionWidened = { ...contract(), criteria: [{ ...contract().criteria[0], note: 'extra' }] }
    expect(refusalOf(() => assertContract(criterionWidened, 'contract', verifiers)).code).toBe<RefusalCode>('malformed-contract')
  })

  it('refuses an unknown payload member instead of accepting it', async () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    const refusal = await asyncRefusalOf(() => log.emit({ ...admitted(), payload: { contract: contract(), approvedBy: 'me' } }))
    expect(refusal.code).toBe<RefusalCode>('malformed-payload')
    expect(refusal.detail).toContain('approvedBy')
  })

  it('refuses a wrong-typed optional member instead of normalizing it away', async () => {
    const log = await running()
    // The reviewer's counterexample: `detail: 123` silently became the empty string.
    const refusal = await asyncRefusalOf(() =>
      log.emit({ ...judged('correctness', UNIT_VERIFIER), payload: { ...(judged('correctness', UNIT_VERIFIER).payload as object), detail: 123 } }),
    )
    expect(refusal.code).toBe<RefusalCode>('malformed-payload')
    expect(refusal.detail).toContain('detail')
  })

  it('refuses a revision reference whose digest is not a content digest', async () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    await log.emit(admitted())
    const refusal = await asyncRefusalOf(() =>
      log.emit({ ...started(), payload: { runId: RUN_ID, revision: { ...REVISION, digest: 'not-a-digest' } } }),
    )
    expect(refusal.code).toBe<RefusalCode>('malformed-payload')
    expect(refusal.detail).toContain('sha256')
  })
})

describe('replay never consults what this deployment can run today', () => {
  it('refuses an unrunnable verifier at admission, while the same contract still replays', async () => {
    const current = verifierRegistryOf([`${UNIT_VERIFIER}@1`])
    const named = contract()

    // Admitting now: a criterion this deployment cannot run is not an acceptance condition today.
    const refusal = refusalOf(() => assertContract(named, 'contract', current))
    expect(refusal.code).toBe<RefusalCode>('unregistered-verifier')

    // Explaining a recorded contract: pure shape, so history stays readable. The reviewer's
    // counterexample had this call refuse with an empty registry.
    expect(assertContractShape(named, 'contract')).toEqual(named)
  })

  it('refuses a criterion whose implementation this deployment does not hold, at the same name and version', () => {
    // The name and version are exactly the criterion's; only the code behind them differs. This is
    // the deployment-side half of the same guarantee, and the reason `has` takes a digest: a
    // deployment that rebuilt `unit-verifier@1` must not be able to claim it can decide a criterion
    // that named the old code.
    const rebuilt = verifierRegistryOf([`${UNIT_VERIFIER}@1#${INTEGRATION_IMPLEMENTATION}`])
    const refusal = refusalOf(() => assertContract(contract(), 'contract', rebuilt))
    expect(refusal.code).toBe<RefusalCode>('unregistered-verifier')
    expect(refusal.detail).toContain('implemented by')
  })

  it('folds a log whose verifiers this deployment no longer holds identities for', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    for (const command of sliceCommands()) await log.emit(command)

    // A later deployment holds no verifier identity at all, yet the recorded facts still explain.
    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')
    expect(projectTask(state).phase).toBe('verified')
    expect(REFUSAL_CODES).toContain('unregistered-verifier')
  })
})

describe('what the protocol does not know', () => {
  it('refuses an unknown run and an unknown criterion', async () => {
    const log = await running()
    expect((await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER, 'pass', { runId: 'run-ghost' })))).code).toBe<RefusalCode>('unknown-run')
    expect((await asyncRefusalOf(() => log.emit(judged('ghost-criterion', UNIT_VERIFIER)))).code).toBe<RefusalCode>('unknown-criterion')
    expect((await asyncRefusalOf(() => log.emit(verified('run-ghost')))).code).toBe<RefusalCode>('unknown-run')
  })

  it('refuses to derive a receipt for a run that has not settled', async () => {
    const registry = taskRegistry()
    const log = await running()
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
    expect(verifierRoleOf({ verifierRef: 'x', verifierVersion: '1' })).toBe('verifier:x@1')
    expect(SCHEDULER).not.toBe(UNIT_VERIFIER)
  })
})
