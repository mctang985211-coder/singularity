import { describe, expect, test } from 'vitest'
import type { TaskInstance, TaskRun } from '../../../task/src/types.ts'
import { buildHandoff } from '../../src/handoff.ts'
import { renderWorkerContract, WORKER_CONTRACT_CLOSE, WORKER_CONTRACT_OPEN } from '../../src/contract.ts'

const NOW = '2026-09-16T00:00:00.000Z'

function task(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    taskId: 'c1',
    definitionRef: { taskType: 'subtask', version: 1 },
    parentTaskId: 'root',
    objective: 'implement the feature',
    depth: 1,
    acceptanceCriteria: [
      { criterionId: 'ac1-1', description: 'unit tests pass', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'pnpm test' },
      { criterionId: 'ac1-2', description: 'reviewed', verificationMode: 'review', requiredEvidence: [], mandatory: false },
    ],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'admitted',
    runIds: [],
    childTaskIds: [],
    ...overrides,
  }
}

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    runId: 'r-root',
    taskId: 'root',
    sessionId: 'root-session',
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...overrides,
  }
}

/** The envelope the orchestrator builds at delegation, so the fixture cannot drift from `buildHandoff`. */
function handoffOf(child: TaskInstance, init: Partial<Parameters<typeof buildHandoff>[0]> = {}) {
  return buildHandoff({
    parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
    parentRun: run(),
    childTask: child,
    reason: 'split the work',
    callerSessionId: 'root-session',
    ...init,
  })
}

const child = task()
const handoff = handoffOf(child)

describe('renderWorkerContract', () => {
  test('opens and closes with the stable markers, naming the task and its decomposition status', () => {
    const rendered = renderWorkerContract(child, handoff)
    expect(rendered.startsWith(`${WORKER_CONTRACT_OPEN} task="c1" decomposition="leaf">\n`)).toBe(true)
    expect(rendered).toContain(`\n${WORKER_CONTRACT_CLOSE}\n`)
    expect(rendered.endsWith('\n')).toBe(false)
  })

  test('carries the objective and every acceptance criterion with the fields a verifier judges', () => {
    const rendered = renderWorkerContract(child, handoff)
    expect(rendered).toContain('implement the feature')
    for (const row of [
      '| ac1-1 | deterministic | yes | unit tests pass | pnpm test |',
      '| ac1-2 | review | no | reviewed | — |',
    ]) expect(rendered, row).toContain(row)
  })

  test('renders the handoff envelope, marking empty lists rather than dropping them', () => {
    const rendered = renderWorkerContract(child, handoffOf(child, { constraints: ['no network'], decisions: ['use pnpm'] }))
    expect(rendered).toContain('- Parent objective: ship the release')
    expect(rendered).toContain('- Reason for delegation: split the work')
    expect(rendered).toContain('- Constraints:\n  - no network')
    expect(rendered).toContain('- Decisions already made:\n  - use pnpm')
    expect(rendered).toContain('- Assumptions: (none)')
    expect(rendered).toContain('- Open questions: (none)')
  })

  test('says where the authority lives, so a compacted spawn prompt does not outrank it', () => {
    expect(renderWorkerContract(child, handoff)).toContain('`task_read` reads the same store')
  })

  test('is a pure function of the contract: the same task and handoff render byte-identically', () => {
    // This is the property the loop's unchanged-text check rests on: identical
    // text means the projection commits nothing, so a projected contract costs
    // no session events after the first step.
    expect(renderWorkerContract(child, handoff)).toBe(renderWorkerContract(child, handoff))
  })

  test('renders a changed criterion and a changed decomposition status differently', () => {
    const base = renderWorkerContract(child, handoff)
    const changed = renderWorkerContract(task({
      decompositionStatus: 'decomposable',
      acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'unit tests pass', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'pnpm test --run' }],
    }), handoff)
    expect(changed).not.toBe(base)
    expect(changed).toContain('decomposition="decomposable"')
    expect(changed).toContain('| ac1-1 | deterministic | yes | unit tests pass | pnpm test --run |')
  })
})
