import { describe, expect, test } from 'vitest'
import type { TaskInstance, TaskRun } from '../../../task/src/types.ts'
import { buildHandoff, renderWorkerPrompt } from '../../src/handoff.ts'

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
    artifacts: [{ artifactId: 'a1', kind: 'spec', uri: 'docs/spec.md' }],
    verifierResults: [],
    status: 'running',
    startedAt: NOW,
    ...overrides,
  }
}

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
})

describe('renderWorkerPrompt', () => {
  test('renders objective, criteria table with commands, and the handoff envelope', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
      constraints: ['do not touch the public API'],
      openQuestions: ['which store backend?'],
    })
    const prompt = renderWorkerPrompt(handoff, task())
    expect(prompt).toContain('implement the feature')
    expect(prompt).toContain('| ac1-1 | deterministic | yes | unit tests pass | pnpm test |')
    expect(prompt).toContain('| ac1-2 | review | no | reviewed | — |')
    expect(prompt).toContain('Parent objective: ship the release')
    expect(prompt).toContain('Reason for delegation: split the work')
    expect(prompt).toContain('- do not touch the public API')
    expect(prompt).toContain('- which store backend?')
    expect(prompt).toContain('never declare completion yourself')
    expect(prompt).toContain('## Parent session')
    expect(prompt).toContain('The session that delegated this task is `root-session`')
    expect(prompt).toContain('`session_event_read`')
    expect(prompt).toContain('`session_trace`')
    expect(prompt).toContain('Full-text search is disabled in this deployment')
    expect(prompt.length).toBeLessThan(4000)
  })

  test('tells a decomposable child to split further and says nothing of it to a leaf child', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })

    const decomposable = renderWorkerPrompt(handoff, task({ decompositionStatus: 'decomposable' }))
    expect(decomposable).toContain('## This task is decomposable')
    expect(decomposable).toContain('Do not carry the work to completion yourself')
    expect(decomposable).toContain('`task_decompose`')
    expect(decomposable).toContain('RFC §36')
    expect(decomposable).toContain('the nested verification settles this task')
    expect(decomposable).toContain('| ac1-1 | deterministic | yes | unit tests pass | pnpm test |')
    expect(decomposable.length).toBeLessThan(4000)

    const leaf = renderWorkerPrompt(handoff, task())
    expect(leaf).not.toContain('decomposable')
    expect(leaf).not.toContain('task_decompose')
    expect(leaf).not.toContain('RFC §36')
  })

  test('gives both child branches the delegating session and the exact-read route to it', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })

    for (const decompositionStatus of ['leaf', 'decomposable'] as const) {
      const prompt = renderWorkerPrompt(handoff, task({ decompositionStatus }))
      expect(prompt).toContain('## Parent session')
      expect(prompt).toContain('The session that delegated this task is `root-session`.')
      expect(prompt).toContain('`session_event_read` (one `seq`)')
      expect(prompt).toContain('`session_trace` (lineage and neighborhood)')
      expect(prompt).toContain('Full-text search is disabled in this deployment, so read parent events by sequence.')
      expect(prompt).not.toContain('undefined')
      expect(prompt.length).toBeLessThan(4000)
    }
  })
})
