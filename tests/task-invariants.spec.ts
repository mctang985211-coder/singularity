/**
 * The task protocol's invariants, each refused by name — plus the two regressions the reviewer's
 * counterexamples established: a closed payload is not silently widened, and explaining an old
 * fact never depends on what this deployment can run today.
 */

import { describe, expect, it } from 'vitest'

import {
  assertContract,
  assertContractShape,
  foldSubject,
  MemoryLog,
  projectReceipt,
  projectTask,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRegistryOf,
  verifierRoleOf,
  type RefusalCode,
  type TaskState,
} from '../src/index.ts'
import { asyncRefusalOf, refusalOf } from './fixtures.ts'
import {
  admitted,
  assigned,
  bubbleOpened,
  contract,
  INTEGRATION_IMPLEMENTATION,
  INTEGRATION_VERIFIER,
  judged,
  REVISION,
  RUN_ID,
  sliceCommands,
  started,
  SUBJECTS,
  TASK_ID,
  taskRegistry,
  UNIT_VERIFIER,
  VERIFIERS,
  verified,
} from './task-fixtures.ts'

/** A log that already carries an admitted, assigned, running task with its execution context. */
async function running(): Promise<MemoryLog> {
  const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
  await log.emit(admitted())
  await log.emit(assigned())
  await log.emit(started())
  await log.emit(bubbleOpened())
  return log
}

describe('the verifier boundary', () => {
  it('refuses a verdict whose implementation is not the criterion\'s', async () => {
    const log = await running()
    // 'limits' names the integration verifier; the unit verifier may not decide it.
    expect(await asyncRefusalOf(() => log.emit(judged('limits', UNIT_VERIFIER)))).toMatchObject({ code: 'wrong-verifier', detail: expect.stringContaining('integration-verifier@1') })
  })

  it('refuses a verdict from different code behind the same verifier name', async () => {
    const log = await running()
    // The criterion names `unit-verifier@1` implemented by UNIT_IMPLEMENTATION. A deployment that
    // rebuilt that verifier under the same name and version is *different code*, and its verdict
    // must not inherit the criterion's acceptance. A ref and a version cannot express this; the
    // digest can, which is why the criterion and the verdict both carry one.
    expect(await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER, 'pass', { implementationDigest: INTEGRATION_IMPLEMENTATION })))).toMatchObject({ code: 'wrong-verifier', detail: expect.stringContaining('names the implementation') })
  })

  it('refuses a deployment that binds one identity to both the executor and a verifier', async () => {
    // The executor and the verifier are different roles, but one identity holds both. Role
    // separation alone would pass this, so the identity is checked too.
    const shared = { scheduler: 'shared-identity', [verifierRoleOf({ verifierRef: UNIT_VERIFIER, verifierVersion: '1' })]: 'shared-identity' }
    const log = new MemoryLog(taskRegistry(), { subjects: shared })
    await log.emit(admitted())
    // Responsibility is held by the same identity too: the point of the case is that role
    // separation alone must not be enough, so both roles resolve to one identity.
    await log.emit(assigned(undefined, 'shared-identity'))
    await log.emit(started())
    await log.emit(bubbleOpened())

    expect(await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER)))).toMatchObject({ code: 'self-reported-evidence', detail: expect.stringContaining('cannot also judge') })
  })

  it('refuses a second verdict on one criterion', async () => {
    const log = await running()
    await log.emit(judged('correctness', UNIT_VERIFIER, 'fail'))
    expect((await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER, 'pass')))).code).toBe<RefusalCode>('evidence-conflict')
  })
})

describe('settlement', () => {
  it('refuses to verify while a criterion has no passing verdict, and names it', async () => {
    const log = await running()
    await log.emit(judged('correctness', UNIT_VERIFIER))

    expect(await asyncRefusalOf(() => log.emit(verified()))).toMatchObject({ code: 'unadjudicated-criterion', detail: expect.stringContaining('"limits" has no passing verdict from integration-verifier@1') })
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

    expect([(await asyncRefusalOf(() => log.emit(verified()))).code, (await asyncRefusalOf(() => log.emit(judged('correctness', UNIT_VERIFIER)))).code]).toEqual(['illegal-transition', 'illegal-transition'])
  })
})

describe('payloads are closed', () => {
  it('refuses an unknown contract member and a missing explicit member', () => {
    const verifiers = verifierRegistryOf(VERIFIERS)
    const widened = { ...contract(), extra: 'typo' }
    const withoutInputs = { goal: 'g', criteria: contract().criteria }
    const criterionWidened = { ...contract(), criteria: [{ ...contract().criteria[0], note: 'extra' }] }
    expect([widened, withoutInputs, criterionWidened].map(payload => refusalOf(() => assertContract(payload, 'contract', verifiers)).code)).toEqual(['malformed-contract', 'malformed-contract', 'malformed-contract'])
  })

  it('refuses an unknown payload member instead of accepting it', async () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    expect(await asyncRefusalOf(() => log.emit({ ...admitted(), payload: { contract: contract(), approvedBy: 'me' } }))).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('approvedBy') })
  })

  it('refuses a wrong-typed optional member instead of normalizing it away', async () => {
    const log = await running()
    // The reviewer's counterexample: `detail: 123` silently became the empty string.
    const refusal = await asyncRefusalOf(() => log.emit({ ...judged('correctness', UNIT_VERIFIER), payload: { ...(judged('correctness', UNIT_VERIFIER).payload as object), detail: 123 } }))
    expect(refusal).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('detail') })
  })

  it('refuses a revision reference whose digest is not a content digest', async () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    await log.emit(admitted())
    expect(await asyncRefusalOf(() => log.emit({ ...started(), payload: { runId: RUN_ID, revision: { ...REVISION, digest: 'not-a-digest' } } }))).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('sha256') })
  })
})

describe('replay never consults what this deployment can run today', () => {
  it('refuses an unrunnable verifier at admission, while the same contract still replays', async () => {
    const current = verifierRegistryOf([`${UNIT_VERIFIER}@1`])
    const named = contract()
    // Admitting now: a criterion this deployment cannot run is not an acceptance condition today.
    expect(refusalOf(() => assertContract(named, 'contract', current)).code).toBe<RefusalCode>('unregistered-verifier')
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
    expect(refusalOf(() => assertContract(contract(), 'contract', rebuilt))).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('implemented by') })
  })

  it('folds a log whose verifiers this deployment no longer holds identities for', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    for (const command of sliceCommands()) await log.emit(command)

    // A later deployment holds no verifier identity at all, yet the recorded facts still explain.
    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')
    expect(projectTask(state).phase).toBe('verified')
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
    const log = await running()
    const held = log.entries()
    const registry = taskRegistry()
    // The facts handed in are the whole input: a prefix that stops before the settlement yields no
    // receipt, and a run the facts never mention has none either.
    expect(refusalOf(() => projectReceipt(registry, held, TASK_ID, RUN_ID))).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('still running') })
    expect(refusalOf(() => projectReceipt(registry, held, TASK_ID, 'run-ghost')).code).toBe<RefusalCode>('unknown-run')
  })

  it('declares exactly the ten kinds this slice needs, and no receipt kind', () => {
    // Sorted, because `kindsOf` sorts: `evidence/produced` < `method/consumed` < `run/*` < `task/*`.
    expect(taskRegistry().kindsOf(TASK_PROTOCOL, TASK_VERSION)).toEqual([
      TASK_KINDS.bubbleOpened,
      TASK_KINDS.evidenceProduced,
      TASK_KINDS.methodConsumed,
      TASK_KINDS.runFailed,
      TASK_KINDS.runStarted,
      TASK_KINDS.runVerified,
      TASK_KINDS.admitted,
      TASK_KINDS.assigned,
      TASK_KINDS.decomposed,
      TASK_KINDS.reassigned,
    ])
  })
})
