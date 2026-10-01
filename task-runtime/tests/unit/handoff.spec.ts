import { describe, expect, test } from 'vitest'
import type { TaskInstance, TaskRun } from '../../../task/src/types.ts'
import { buildHandoff } from '../../src/handoff.ts'

const NOW = '2026-09-16T00:00:00.000Z'

function task(overrides: Partial<TaskInstance> = {}): TaskInstance {
  return {
    taskId: 'c1',
    definitionRef: { taskType: 'subtask', version: 1 },
    parentTaskId: 'root',
    objective: 'implement the feature',
    depth: 1,
    acceptanceCriteria: [
      {
        criterionId: 'ac1-1',
        description: 'unit tests pass',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'pnpm test',
      },
      {
        criterionId: 'ac1-2',
        description: 'reviewed',
        verificationMode: 'review',
        requiredEvidence: [],
        mandatory: false,
      },
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
    artifacts: [{ artifactId: 'a1', kind: 'spec', uri: 'docs/spec.md' }],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...overrides,
  }
}

/**
 * The handoff envelope as DATA (A2): this module builds and persists the
 * envelope and nothing else. What a worker is shown from it is the context
 * package's projection (asserted through the context reads and the assembled
 * prompt), and the stable behaviour rules are the agent runtime's worker
 * policy section — the old `renderWorkerPrompt`/`renderWorkerContract` texts
 * are gone with the double-track they would have been.
 */
describe('buildHandoff', () => {
  test('carries the parent objective, reason, caller session, and defaults empty sections', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
      relevantEvidence: ['e-1'],
    })
    expect(handoff.parentTaskId).toBe('root')
    expect(handoff.parentRunId).toBe('r-root')
    expect(handoff.childTaskId).toBe('c1')
    expect(handoff.parentObjective).toBe('ship the release')
    expect(handoff.reasonForDelegation).toBe('split the work')
    expect(handoff.parentSessionRef).toBe('root-session')
    expect(handoff.relevantArtifacts).toEqual([{ artifactId: 'a1', kind: 'spec', uri: 'docs/spec.md' }])
    expect(handoff.relevantEvidence).toEqual(['e-1'])
    expect(handoff.constraints).toEqual([])
    expect(handoff.openQuestions).toEqual([])
    expect(handoff.handoffId).toMatch(/^h-/)
  })

  test('carries the caller-declared assumptions into the envelope', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0 }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
      assumptions: [
        'a cycle-accurate reference model (BEMU) exists',
        'dependency evidence "e-1" is verified and available as a reference',
      ],
    })
    expect(handoff.assumptions).toEqual([
      'a cycle-accurate reference model (BEMU) exists',
      'dependency evidence "e-1" is verified and available as a reference',
    ])
  })

  test("defaults the relevant artifacts to the parent run's own, copied", () => {
    const parentRun = run()
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0 }),
      parentRun,
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })
    expect(handoff.relevantArtifacts).toEqual(parentRun.artifacts)
    expect(handoff.relevantArtifacts).not.toBe(parentRun.artifacts)
    expect(handoff.decisions).toEqual([])
    expect(handoff.assumptions).toEqual([])
  })
})
