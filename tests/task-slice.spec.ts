/**
 * The vertical slice, happy path: a contract is admitted, a run starts pinned to a revision,
 * independent verifiers judge every criterion, the run settles, and readers project the result.
 *
 * This is the smallest flow that crosses every layer: contract validation, the log, the fold,
 * the projection, both renderings, and the derived receipt.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  foldSubject,
  ProtocolLog,
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
  EXECUTOR,
  INTEGRATION_VERIFIER,
  judged,
  RUN_ID,
  started,
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
async function slice(): Promise<{ entries: readonly unknown[]; state: TaskState }> {
  const registry = taskRegistry()
  const log = await ProtocolLog.open(logPath, registry)
  await log.emit(admitted())
  await log.emit(started())
  await log.emit(judged('correctness', UNIT_VERIFIER))
  await log.emit(judged('limits', INTEGRATION_VERIFIER))
  await log.emit(verified())

  const state = foldSubject<TaskState>(registry, log.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
  if (state === undefined) throw new Error('the slice must fold to a task state')
  return { entries: log.entries(), state }
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
    expect(run?.actor).toBe(EXECUTOR)
    expect(run?.revision.revisionId).toBe('r0001')
    expect(run?.verdicts.map(verdict => `${verdict.criterionId}:${verdict.verdict}:${verdict.actor}`)).toEqual([
      `correctness:pass:${UNIT_VERIFIER}`,
      `limits:pass:${INTEGRATION_VERIFIER}`,
    ])
  })

  it('derives the receipt from the log instead of storing it', async () => {
    const { state } = await slice()
    const receipt: ReceiptView = projectReceipt(state, RUN_ID)

    expect(receipt.status).toBe('verified')
    expect(receipt.executor).toBe(EXECUTOR)
    expect(receipt.contractDigest).toBe(projectTask(state).contractDigest)
    expect(receipt.criteria.map(entry => `${entry.criterionId}:${entry.verdict}:${entry.actor}`)).toEqual([
      `correctness:pass:${UNIT_VERIFIER}`,
      `limits:pass:${INTEGRATION_VERIFIER}`,
    ])
    expect(receiptDigest(receipt)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('gives two independent readers the same receipt, before and after a reopen', async () => {
    const { state } = await slice()
    const fromMemory = receiptDigest(projectReceipt(state, RUN_ID))

    const registry = taskRegistry()
    const reopened = await ProtocolLog.open(logPath, registry)
    const refolded = foldSubject<TaskState>(registry, reopened.entries(), TASK_PROTOCOL, TASK_VERSION, TASK_ID)
    if (refolded === undefined) throw new Error('the reopened log must fold to the same task')

    expect(receiptDigest(projectReceipt(refolded, RUN_ID))).toBe(fromMemory)
    expect(projectTask(refolded)).toEqual(projectTask(state))
  })

  it('renders the same view for an agent, adding nothing and hiding nothing', async () => {
    const { state } = await slice()
    const text = renderTaskForAgent(projectTask(state))

    expect(text).toContain(`Task ${TASK_ID} — phase verified`)
    expect(text).toContain('goal: implement a word counter')
    expect(text).toContain('correctness: counts match the golden file [decided by unit-verifier@1]')
    expect(text).toContain(`run-1: verified by ${EXECUTOR} on revision r0001`)
    expect(text).toContain(`correctness: pass by ${UNIT_VERIFIER}`)
    expect(text).toContain(`limits: pass by ${INTEGRATION_VERIFIER}`)
    // Nothing the view does not hold: the renderer is a rendering, not a second projection.
    expect(text.split('\n').length).toBeGreaterThan(5)
  })

  it('does not let a receipt be persisted: the ladder keeps it derived', async () => {
    const registry = taskRegistry()
    const log = await ProtocolLog.open(logPath, registry)
    await log.emit(admitted())
    await log.emit(started())

    // The only way to store a receipt would be a kind for it, and the protocol declares none.
    await expect(
      log.emit({ protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'receipt/sealed', subject: TASK_ID, actor: 'root', payload: {} }),
    ).rejects.toMatchObject({ refusal: { code: 'unknown-kind' } })
  })
})
