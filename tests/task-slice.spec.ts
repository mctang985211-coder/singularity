/**
 * The vertical slice, happy path: a contract is admitted, a run starts pinned to a revision,
 */

import { describe, expect, it } from 'vitest'

import {
  contractDigest,
  foldSubject,
  MemoryLog,
  projectReceipt,
  projectTask,
  receiptDigest,
  renderTaskForAgent,
  type RefusalCode,
  TASK_KINDS,
  TASK_PROTOCOL,
  TASK_VERSION,
  type ReceiptView,
  type ProtocolRegistry,
  type TaskState,
  type TaskView,
} from '../src/index.ts'
import { refusalOf } from './fixtures.ts'
import {
  admitted,
  ARTIFACT,
  assigned,
  BUBBLE_INPUTS,
  bubbleOpened,
  contract,
  failed,
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
  verified,
} from './task-fixtures.ts'

/**
 * The two consumption bases, spelled here rather than imported: the projection names them once
 */
const DECLARED_BASIS = 'declared'
const JUDGED_BASIS = 'judged'

/** Run the whole slice and fold it. */
async function slice(): Promise<{ registry: ProtocolRegistry; log: MemoryLog; state: TaskState }> {
  const registry = taskRegistry()
  const log = new MemoryLog(registry, { subjects: SUBJECTS })
  for (const command of sliceCommands()) await log.emit(command)

  const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
  if (state === undefined) throw new Error('the slice must fold to a task state')
  return { registry, log, state }
}

describe('the task slice', () => {
  it('admits a contract, runs it, and settles verified on its own acceptance', async () => {
    const { state } = await slice()
    const view: TaskView = projectTask(state)

    // One read of the view: the admitted contract, the phase it settled in, its criteria in contract
    // order, and its one run - pinned to a revision by the trusted scheduler identity.
    expect(view).toMatchObject({ taskId: TASK_ID, goal: 'implement a word counter', phase: 'verified', criteria: [{ criterionId: 'correctness' }, { criterionId: 'limits' }], runs: [{ status: 'verified', emitter: 'scheduler', actor: SCHEDULER, revision: { revisionId: 'r0001' } }], })
    // Every verdict names the verifier that decided it and pins the artifact content it was formed on.
    expect(view.runs[0]?.verdicts.map(verdict => [verdict.criterionId, verdict.verdict, verdict.decidedBy, verdict.artifactDigest])).toEqual([
      ['correctness', 'pass', `${UNIT_VERIFIER}@1`, ARTIFACT],
      ['limits', 'pass', `${INTEGRATION_VERIFIER}@1`, ARTIFACT],
    ])
  })

  it('reports an admitted task with no run as awaiting a run, not as failed', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit(admitted())

    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')
    const view = projectTask(state)

    // A phase is never inferred from absence: a contract with no run is awaiting one, not failed.
    expect([view.phase, view.runs]).toEqual(['awaiting-run', []])
    expect(renderTaskForAgent(view)).toContain('awaiting a run')
  })

  it('derives the receipt from the log instead of storing it', async () => {
    const { registry, log } = await slice()
    const held = log.entries()
    const receipt: ReceiptView = projectReceipt(registry, held, TASK_ID, RUN_ID)

    // The receipt answers to the contract it is derived under - digested here from the contract the
    // fixture admitted, not read back out of the state the projection also reads - and its bound is
    // the seven facts the slice committed, a hand-counted literal rather than the array's length.
    expect(receipt).toMatchObject({ status: 'verified', executor: { emitter: 'scheduler', actor: SCHEDULER }, contractDigest: contractDigest(contract()), cutoff: 7 })
    // Re-deriving from the prefix the bound names gives the same receipt: the two are one computation.
    expect(receiptDigest(projectReceipt(registry, held.slice(0, receipt.cutoff), TASK_ID, RUN_ID))).toBe(receiptDigest(receipt))
    // Each criterion carries the verifier that decided it and the artifact content it judged.
    expect(receipt.criteria.map(entry => [entry.criterionId, entry.verdict, `${entry.verifierRef}@${entry.verifierVersion}`, entry.artifactDigest])).toEqual([
      ['correctness', 'pass', `${UNIT_VERIFIER}@1`, ARTIFACT],
      ['limits', 'pass', `${INTEGRATION_VERIFIER}@1`, ARTIFACT],
    ])
    // Both criteria were judged on the declared inputs, so the consumption is the judged one.
    expect(receipt.consumption).toEqual({ basis: 'judged', inputs: BUBBLE_INPUTS, workspace: { kind: 'git', ref: 'refs/heads/main' } })
  })

  it('refuses to derive a receipt from an array that is not the log prefix it names, and derives the same receipt from the genuine prefix', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    // The slice's own facts, each followed by a fact about another task: the run's two verdicts land
    // at seq 8 and 10 and its settlement at 12, so the shape below is the one the review executed.
    for (const [index, fact] of sliceCommands().entries()) {
      await log.emit(fact)
      await log.emit({
        commandId: `elsewhere-${index}`,
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        kind: TASK_KINDS.admitted,
        subject: `task-elsewhere-${index}`,
        payload: { contract: contract() },
      })
    }
    const held = log.entries()
    const taskFacts = held.filter(entry => entry.subject === TASK_ID)
    expect([held.length, taskFacts.map(entry => entry.seq)]).toEqual([14, [0, 2, 4, 6, 8, 10, 12]])

    expect(projectReceipt(registry, held, TASK_ID, RUN_ID).cutoff).toBe(13)

    // A filtered array is not the prefix the receipt would name: its own sequence numbers show the
    // facts in between, and asking for a receipt from it asks for one whose bound covers facts it
    // does not hold. That is refused rather than re-labelled, because a receipt *is* the claim that
    // its bound accounts for exactly the facts it was folded from.
    expect(refusalOf(() => projectReceipt(registry, taskFacts, TASK_ID, RUN_ID))).toMatchObject({
      code: 'chain-broken',
      detail: expect.stringContaining('prefix'),
    })

    // Recommitting these commands into another log gives them a different control source.
    const prefix = new MemoryLog(registry, { subjects: SUBJECTS })
    for (const fact of taskFacts.map(entry => ({ ...entry, commandId: `prefix-${entry.seq}` }))) await prefix.emit(fact)
    expect(projectReceipt(registry, prefix.entries(), TASK_ID, RUN_ID).cutoff).toBe(7)
    expect(receiptDigest(projectReceipt(registry, prefix.entries(), TASK_ID, RUN_ID))).not.toBe(receiptDigest(projectReceipt(registry, held, TASK_ID, RUN_ID)))
  })

  it('reports judged as "a verdict exists", the one bit the log establishes, not as "bytes were read"', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit(admitted())
    await log.emit(assigned())
    // Two attempts at the same task, judged differently: the first is failed with nothing decided on
    // it, the second is judged on the bubble's own input digests and settles verified.
    await log.emit(started('run-unjudged'))
    await log.emit(bubbleOpened('run-unjudged'))
    await log.emit(failed('the attempt ended before anything was judged', 'run-unjudged'))
    await log.emit(started('run-judged'))
    await log.emit(bubbleOpened('run-judged'))
    await log.emit(judged('correctness', UNIT_VERIFIER, 'pass', { runId: 'run-judged' }))
    await log.emit(judged('limits', INTEGRATION_VERIFIER, 'pass', { runId: 'run-judged' }))
    await log.emit(verified('run-judged'))

    const declared = projectReceipt(registry, log.entries(), TASK_ID, 'run-unjudged')
    const judgedReceipt = projectReceipt(registry, log.entries(), TASK_ID, 'run-judged')

    // The inputs are the same list on both bases, because `assertInputsBound` refuses a verdict whose
    // inputs are not exactly the run's declared ones. So the judged list cannot testify about bytes:
    // it *is* the declaration, echoed back. What the two receipts differ by is the one bit.
    expect(judgedReceipt.consumption.inputs).toEqual(declared.consumption.inputs)
    expect(judgedReceipt.consumption).toEqual({ ...declared.consumption, basis: JUDGED_BASIS })
    expect([declared.consumption.basis, judgedReceipt.consumption.basis]).toEqual([DECLARED_BASIS, JUDGED_BASIS])

    // And the bit is the whole observable content: it is what tells a reader a verdict exists at all.
    // Neither receipt says the digest was hashed from disk rather than copied from the declaration,
    // which is exactly what the projection claims and no more.
    expect(receiptDigest(judgedReceipt)).not.toBe(receiptDigest(declared))
    expect(judgedReceipt.consumption.inputs).toEqual(BUBBLE_INPUTS)
  })

  it('derives no receipt from facts that stop before the run settled', async () => {
    const { registry, log } = await slice()
    const held = log.entries()

    // A reader whose facts stop before the settlement holds a run that has not settled yet, and that
    // prefix has no receipt in it. Deriving one anyway would carry the settlement the prefix does not
    // hold - a receipt whose own evidence lies above the bound it claims to account for.
    expect(refusalOf(() => projectReceipt(registry, held.slice(0, held.length - 1), TASK_ID, RUN_ID))).toMatchObject({
      code: 'illegal-transition',
      detail: expect.stringContaining('still running'),
    })
  })

  it('derives no receipt from a prefix that holds no fact of the task', async () => {
    const { registry, log } = await slice()

    // One fact of a seven-fact log holds no contract, no run and no verdict, so no receipt can be
    // derived from it. The free parameter this replaces accepted "1" beside a head state and handed
    // back the seq-4 verdict under a one-fact claim.
    expect(refusalOf(() => projectReceipt(registry, log.entries().slice(0, 1), TASK_ID, RUN_ID)).code).toBe<RefusalCode>('unknown-run')
  })

  it('reports a run nothing has judged as consuming what it declared, not what it read', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit(admitted())
    await log.emit(assigned())
    await log.emit(started())
    await log.emit(bubbleOpened())
    await log.emit(failed('the attempt ended before anything was judged'))

    // The bubble declared inputs and no verdict was ever formed on them: the receipt reports the
    // attempt's own declaration as a declaration, with the workspace declared beside it.
    expect(projectReceipt(registry, log.entries(), TASK_ID, RUN_ID).consumption).toEqual({
      basis: 'declared',
      inputs: BUBBLE_INPUTS,
      workspace: { kind: 'git', ref: 'refs/heads/main' },
    })
  })

  it('reports a run that declared no execution context as having consumed nothing, not as unknown', async () => {
    // A run that failed before a bubble was opened has nothing declared and nothing judged, which is a
    // fact about the attempt rather than a missing value to be invented.
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit(admitted())
    await log.emit(assigned())
    await log.emit(started())
    await log.emit(failed('no context was ever declared'))

    expect(projectReceipt(registry, log.entries(), TASK_ID, RUN_ID).consumption).toEqual({ basis: 'declared', inputs: [], workspace: null })
  })

  it('gives two independent readers the same receipt, before and after adopting the facts', async () => {
    const { registry, log, state } = await slice()
    const fromMemory = receiptDigest(projectReceipt(registry, log.entries(), TASK_ID, RUN_ID))

    // What a durable medium hands back must fold to the same task under a second deployment's own
    // declarations, and agree on the receipt.
    const adoptedRegistry = taskRegistry()
    const adopted = MemoryLog.adopt(log.entries(), adoptedRegistry, { subjects: SUBJECTS })
    const refolded = foldSubject<TaskState>(adoptedRegistry, adopted.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (refolded === undefined) throw new Error('the adopted facts must fold to the same task')

    expect(receiptDigest(projectReceipt(adoptedRegistry, adopted.entries(), TASK_ID, RUN_ID))).toBe(fromMemory)
    expect(projectTask(refolded)).toEqual(projectTask(state))
  })

  it('renders the same view for an agent, adding nothing and hiding nothing', async () => {
    const { state } = await slice()
    const view = projectTask(state)
    const text = renderTaskForAgent(view)

    // The reading is the view line for line: the same contract and admission time, the implementation's
    // own digest (so a reader sees *which* code decided a criterion rather than only the name a
    // deployment could re-point), and the run with its environment as well as its revision (a revision
    // id is unique only within one). A line added or hidden anywhere fails the equality.
    expect(text).toBe([
      `Task ${TASK_ID} — phase verified`,
      `  goal: implement a word counter`,
      `  contract ${view.contractDigest.slice(0, 12)}… admitted by ${SCHEDULER} at ${view.admittedAt}`,
      `  criteria (2):`,
      `    - correctness: counts match the golden file [decided by ${UNIT_VERIFIER}@1 implemented by ${UNIT_IMPLEMENTATION.slice(0, 12)}…]`,
      `    - limits: rejects input over 1 MiB [decided by ${INTEGRATION_VERIFIER}@1 implemented by ${contract().criteria[1]!.implementationDigest.slice(0, 12)}…]`,
      `  runs (1):`,
      `    - ${RUN_ID}: verified by ${SCHEDULER} (role scheduler) on ${REVISION.environmentId} revision ${REVISION.revisionId} (${REVISION.digest.slice(0, 12)}…)`,
      `        correctness: pass by ${UNIT_VERIFIER}@1 on artifact ${ARTIFACT.slice(0, 12)}…`,
      `        limits: pass by ${INTEGRATION_VERIFIER}@1 on artifact ${ARTIFACT.slice(0, 12)}…`,
    ].join('\n'))
  })

  it('does not let a receipt be persisted: the vocabulary keeps it derived', async () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    await log.emit(admitted())
    await log.emit(assigned())
    await log.emit(started())

    // The only way to store a receipt would be a kind for it, and the protocol declares none.
    const refusal = refusalOf(() =>
      log.emit({ commandId: 'receipt', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'receipt/sealed', subject: TASK_ID, payload: {} }),
    )
    expect(refusal.code).toBe<RefusalCode>('unknown-kind')
  })

  it('keeps a failure with no recorded reason reported as none, not as an invented sentence', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit(admitted())
    await log.emit(assigned())
    await log.emit(started())
    await log.emit(bubbleOpened())
    await log.emit(judged('correctness', UNIT_VERIFIER, 'fail'))
    await log.emit({ commandId: 'fail-1', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'run/failed', subject: TASK_ID, payload: { runId: RUN_ID } })

    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')
    // Both readings of the settled run say failed, rather than reading a failure out of a missing value ...
    expect([projectTask(state).phase, projectReceipt(registry, log.entries(), TASK_ID, RUN_ID).status]).toEqual(['failed', 'failed'])
    // ... and the failure recorded no reason, so the projection reports none instead of inventing one.
    expect(projectTask(state).runs[0]?.failureReason).toBeNull()
  })
})
