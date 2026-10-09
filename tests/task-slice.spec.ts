/**
 * The vertical slice, happy path: a contract is admitted, a run starts pinned to a revision,
 * independent verifiers judge every criterion, the run settles, and readers project the result.
 *
 * This is the smallest flow that crosses every layer: contract validation, the log's emitter and
 * command discipline, the fold, the projection, both renderings, and the derived receipt.
 */

import { describe, expect, it } from 'vitest'

import {
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
} from './task-fixtures.ts'

/** Run the whole slice and fold it. */
async function slice(): Promise<{ log: MemoryLog; state: TaskState }> {
  const registry = taskRegistry()
  const log = new MemoryLog(registry, { subjects: SUBJECTS })
  for (const command of sliceCommands()) await log.emit(command)

  const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
  if (state === undefined) throw new Error('the slice must fold to a task state')
  return { log, state }
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
    const { log, state } = await slice()
    const receipt: ReceiptView = projectReceipt(state, RUN_ID, log.entries().length)

    // The receipt names the facts it accounts for (the committed cutoff) and the contract it answers
    // to, and its identity is a content digest - so "fixed source" is a property a reader can check.
    expect(receipt).toMatchObject({ status: 'verified', executor: { emitter: 'scheduler', actor: SCHEDULER }, contractDigest: projectTask(state).contractDigest, cutoff: log.entries().length, })
    // Each criterion carries the verifier that decided it and the artifact content it judged.
    expect(receipt.criteria.map(entry => [entry.criterionId, entry.verdict, `${entry.verifierRef}@${entry.verifierVersion}`, entry.artifactDigest])).toEqual([
      ['correctness', 'pass', `${UNIT_VERIFIER}@1`, ARTIFACT],
      ['limits', 'pass', `${INTEGRATION_VERIFIER}@1`, ARTIFACT],
    ])
    // What the attempt actually consumed: the declared inputs and the workspace it executed in.
    expect(receipt.consumption).toEqual({ inputs: BUBBLE_INPUTS, workspace: { kind: 'git', ref: 'refs/heads/main' } })
    expect(receiptDigest(receipt)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives a different receipt for the same run at a different committed cutoff', async () => {
    const { log, state } = await slice()
    const atCutoff = receiptDigest(projectReceipt(state, RUN_ID, log.entries().length))
    // One fewer fact is a different accounting: same run, different set of facts answered for.
    expect(receiptDigest(projectReceipt(state, RUN_ID, log.entries().length - 1))).not.toBe(atCutoff)
    // A cutoff that is not a committed bound is refused rather than rounded to one.
    expect(refusalOf(() => projectReceipt(state, RUN_ID, 0)).code).toBe<RefusalCode>('malformed-payload')
  })

  it('does not move a receipt at a cutoff because unrelated facts arrived later', async () => {
    const { log, state } = await slice()
    const cutoff = log.entries().length
    const before = receiptDigest(projectReceipt(state, RUN_ID, cutoff))

    // A fact about another task, committed after the cutoff, is outside what this receipt accounts
    // for - so the receipt for the same cutoff is unchanged, and a reader can rely on that.
    await log.emit({
      commandId: 'other-task',
      protocol: TASK_PROTOCOL,
      version: TASK_VERSION,
      kind: TASK_KINDS.admitted,
      subject: 'task-elsewhere',
      payload: { contract: contract() },
    })

    const refolded = foldSubject<TaskState>(taskRegistry(), log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (refolded === undefined) throw new Error('expected the task to still fold')
    expect(receiptDigest(projectReceipt(refolded, RUN_ID, cutoff))).toBe(before)
    // Reading it again at the new cutoff is a different accounting, which is the point of naming one.
    expect(receiptDigest(projectReceipt(refolded, RUN_ID, log.entries().length))).not.toBe(before)
  })

  it('reports a run that declared no execution context as having consumed nothing, not as unknown', async () => {
    // A run that failed before a bubble was opened has an empty consumption, which is a fact about
    // the attempt rather than a missing value to be invented.
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit(admitted())
    await log.emit(assigned())
    await log.emit(started())
    await log.emit(failed('no context was ever declared'))
    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')
    const receipt = projectReceipt(state, RUN_ID, log.entries().length)
    expect(receipt.consumption).toEqual({ inputs: [], workspace: null })
  })

  it('gives two independent readers the same receipt, before and after adopting the facts', async () => {
    const { log, state } = await slice()
    const fromMemory = receiptDigest(projectReceipt(state, RUN_ID, log.entries().length))

    // What a durable medium hands back must fold to the same task, and agree on the receipt.
    const registry = taskRegistry()
    const adopted = MemoryLog.adopt(log.entries(), registry, { subjects: SUBJECTS })
    const refolded = foldSubject<TaskState>(registry, adopted.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (refolded === undefined) throw new Error('the adopted facts must fold to the same task')

    expect(receiptDigest(projectReceipt(refolded, RUN_ID, log.entries().length))).toBe(fromMemory)
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
    expect([projectTask(state).phase, projectReceipt(state, RUN_ID, log.entries().length).status]).toEqual(['failed', 'failed'])
    // ... and the failure recorded no reason, so the projection reports none instead of inventing one.
    expect(projectTask(state).runs[0]?.failureReason).toBeNull()
  })
})
