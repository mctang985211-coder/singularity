/**
 * The vertical slice, happy path: a contract is admitted, a run starts pinned to a revision,
 * independent verifiers judge every criterion, the run settles, and readers project the result.
 *
 * This is the smallest flow that crosses every layer: contract validation, the log's emitter and
 * command discipline, the fold, the projection, both renderings, and the derived receipt.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  foldSubject,
  MemoryLog,
  projectReceipt,
  projectTask,
  receiptDigest,
  renderTaskForAgent,
  TASK_PROTOCOL,
  TASK_VERSION,
  type ReceiptView,
  type RunView,
  type TaskState,
  type TaskView,
} from '../src/index.ts'
import { newLogPath } from './fixtures.ts'
import {
  admitted,
  ARTIFACT,
  INTEGRATION_VERIFIER,
  judged,
  RUN_ID,
  SCHEDULER,
  sliceCommands,
  started,
  SUBJECTS,
  TASK_ID,
  taskRegistry,
  UNIT_VERIFIER,
  verified,
} from './task-fixtures.ts'

let logPath: string

beforeEach(async () => {
  logPath = await newLogPath()
})

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

    expect(view.taskId).toBe(TASK_ID)
    expect(view.goal).toBe('implement a word counter')
    expect(view.phase).toBe('verified')
    expect(view.criteria.map(criterion => criterion.criterionId)).toEqual(['correctness', 'limits'])
    expect(view.runs).toHaveLength(1)

    const run: RunView | undefined = view.runs[0]
    expect(run?.status).toBe('verified')
    expect(run?.emitter).toBe('scheduler')
    expect(run?.actor).toBe(SCHEDULER)
    expect(run?.revision.revisionId).toBe('r0001')
    expect(run?.verdicts.map(verdict => `${verdict.criterionId}:${verdict.verdict}:${verdict.decidedBy}`)).toEqual([
      `correctness:pass:${UNIT_VERIFIER}@1`,
      `limits:pass:${INTEGRATION_VERIFIER}@1`,
    ])
    // Every verdict pins the artifact content it was formed on.
    expect(run?.verdicts.every(verdict => verdict.artifactDigest === ARTIFACT)).toBe(true)
  })

  it('reports an admitted task with no run as awaiting a run, not as failed', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit(admitted())

    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')
    const view = projectTask(state)

    expect(view.phase).toBe('awaiting-run')
    expect(view.runs).toEqual([])
    expect(renderTaskForAgent(view)).toContain('awaiting a run')
  })

  it('derives the receipt from the log instead of storing it', async () => {
    const { state } = await slice()
    const receipt: ReceiptView = projectReceipt(state, RUN_ID)

    expect(receipt.status).toBe('verified')
    expect(receipt.executor).toEqual({ emitter: 'scheduler', actor: SCHEDULER })
    expect(receipt.contractDigest).toBe(projectTask(state).contractDigest)
    expect(receipt.criteria.map(entry => `${entry.criterionId}:${entry.verdict}:${entry.verifierRef}@${entry.verifierVersion}`)).toEqual([
      `correctness:pass:${UNIT_VERIFIER}@1`,
      `limits:pass:${INTEGRATION_VERIFIER}@1`,
    ])
    expect(receipt.criteria.every(entry => entry.artifactDigest === ARTIFACT)).toBe(true)
    expect(receiptDigest(receipt)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives two independent readers the same receipt, before and after adopting the facts', async () => {
    const { log, state } = await slice()
    const fromMemory = receiptDigest(projectReceipt(state, RUN_ID))

    // What a durable medium hands back must fold to the same task, and agree on the receipt.
    const registry = taskRegistry()
    const adopted = MemoryLog.adopt(log.entries(), registry, { subjects: SUBJECTS })
    const refolded = foldSubject<TaskState>(registry, adopted.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (refolded === undefined) throw new Error('the adopted facts must fold to the same task')

    expect(receiptDigest(projectReceipt(refolded, RUN_ID))).toBe(fromMemory)
    expect(projectTask(refolded)).toEqual(projectTask(state))
  })

  it('renders the same view for an agent, adding nothing and hiding nothing', async () => {
    const { state } = await slice()
    const text = renderTaskForAgent(projectTask(state))

    expect(text).toContain(`Task ${TASK_ID} — phase verified`)
    expect(text).toContain('goal: implement a word counter')
    expect(text).toContain('correctness: counts match the golden file [decided by unit-verifier@1]')
    expect(text).toContain(`run-1: verified by ${SCHEDULER} (role scheduler) on revision r0001`)
    expect(text).toContain(`correctness: pass by ${UNIT_VERIFIER}@1 on artifact bbbbbbbbbbbb…`)
  })

  it('does not let a receipt be persisted: the vocabulary keeps it derived', async () => {
    const log = new MemoryLog(taskRegistry(), { subjects: SUBJECTS })
    await log.emit(admitted())
    await log.emit(started())

    // The only way to store a receipt would be a kind for it, and the protocol declares none.
    await expect(
      log.emit({ commandId: 'receipt', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'receipt/sealed', subject: TASK_ID, payload: {} }),
    ).rejects.toMatchObject({ refusal: { code: 'unknown-kind' } })
  })

  it('keeps a failure with no recorded reason reported as none, not as an invented sentence', async () => {
    const registry = taskRegistry()
    const log = new MemoryLog(registry, { subjects: SUBJECTS })
    await log.emit(admitted())
    await log.emit(started())
    await log.emit(judged('correctness', UNIT_VERIFIER, 'fail'))
    await log.emit({ commandId: 'fail-1', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'run/failed', subject: TASK_ID, payload: { runId: RUN_ID } })

    const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (state === undefined) throw new Error('expected a folded task')
    expect(projectTask(state).phase).toBe('failed')
    expect(projectTask(state).runs[0]?.failureReason).toBeNull()
    expect(projectReceipt(state, RUN_ID).status).toBe('failed')
  })
})
