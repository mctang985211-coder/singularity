import { describe, expect, test } from 'vitest'
import type { RunProviderBinding, TaskInstance, TaskRun } from '../../../task/src/types.ts'
import { buildHandoff, renderWorkerPrompt } from '../../src/handoff.ts'
import { renderWorkerContract } from '../../src/contract.ts'

const NOW = '2026-09-16T00:00:00.000Z'

/** `Config.allowRuntimeDecomposition` on/off, as `decomposeAndRun` hands them to the renderer. */
const POLICY = { allowRuntimeDecomposition: true }
const POLICY_OFF = { allowRuntimeDecomposition: false }

/** The phrase only the switch-on rule carries: the door itself, not the tool's name. */
const RUNTIME_SPLIT = 'admits a task\'s own decomposition'

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

  test('carries the caller-declared assumptions into the envelope', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0 }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
      assumptions: ['a cycle-accurate reference model (BEMU) exists', 'dependency evidence "e-1" is verified and available as a reference'],
    })
    expect(handoff.assumptions).toEqual([
      'a cycle-accurate reference model (BEMU) exists',
      'dependency evidence "e-1" is verified and available as a reference',
    ])
  })

  test('renders the assumptions list into the prompt when the handoff carries one', () => {
    const assumptions = ['dependency evidence "e-1" is verified and available as a reference']
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0 }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
      assumptions,
    })
    const prompt = renderWorkerPrompt(handoff, task(), POLICY)
    expect(prompt).toContain('## Assumptions')
    expect(prompt).toContain('- dependency evidence "e-1" is verified and available as a reference')
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
    const prompt = renderWorkerPrompt(handoff, task(), POLICY)
    expect(prompt).toContain('implement the feature')
    expect(prompt).toContain('| ac1-1 | deterministic | yes | unit tests pass | pnpm test | — |')
    expect(prompt).toContain('| ac1-2 | review | no | reviewed | — | — |')
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

  test('opens the runtime-split door to both branches when the deployment admits it', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })

    const decomposable = renderWorkerPrompt(handoff, task({ decompositionStatus: 'decomposable' }), POLICY)
    expect(decomposable).toContain('## This task is decomposable')
    expect(decomposable).toContain('Do not carry the work to completion yourself')
    expect(decomposable).toContain('`task_decompose`')
    expect(decomposable).toContain('RFC §36')
    expect(decomposable).toContain('the nested verification settles this task')
    expect(decomposable).toContain('| ac1-1 | deterministic | yes | unit tests pass | pnpm test | — |')
    expect(decomposable).toContain(RUNTIME_SPLIT)

    // A leaf child: no "you were admitted to split" block, but the rules say the
    // node may still decide for itself — and what a refusal means.
    const leaf = renderWorkerPrompt(handoff, task(), POLICY)
    expect(leaf).not.toContain('## This task is decomposable')
    expect(leaf).not.toContain('was admitted as decomposable')
    expect(leaf).toContain(RUNTIME_SPLIT)
    expect(leaf).toContain('call `task_decompose` yourself')
    expect(leaf).toContain('a refusal names the rule that blocked it')
    expect(leaf).toContain('a task may split only once')
    expect(leaf.length).toBeLessThan(4000)
  })

  test('keeps both branches silent about decomposition when the switch is off', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })

    const leaf = renderWorkerPrompt(handoff, task(), POLICY_OFF)
    expect(leaf).not.toContain('task_decompose')
    expect(leaf).not.toContain('decompos')
    expect(leaf).not.toContain(RUNTIME_SPLIT)

    // A parent-declared decomposable child is still admitted by its status
    // alone, so its block stays; only the runtime-split rule is absent.
    const decomposable = renderWorkerPrompt(handoff, task({ decompositionStatus: 'decomposable' }), POLICY_OFF)
    expect(decomposable).toContain('## This task is decomposable')
    expect(decomposable).not.toContain(RUNTIME_SPLIT)
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
      const prompt = renderWorkerPrompt(handoff, task({ decompositionStatus }), POLICY)
      expect(prompt).toContain('## Parent session')
      expect(prompt).toContain('The session that delegated this task is `root-session`.')
      expect(prompt).toContain('`session_event_read` (one `seq`)')
      expect(prompt).toContain('`session_trace` (lineage and neighborhood)')
      expect(prompt).toContain('Full-text search is disabled in this deployment, so read parent events by sequence.')
      expect(prompt).not.toContain('undefined')
      expect(prompt.length).toBeLessThan(4000)
    }
  })

  test('tells both child branches to re-read their contract and the tree, and to self-check with task_verify', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })

    for (const decompositionStatus of ['leaf', 'decomposable'] as const) {
      const prompt = renderWorkerPrompt(handoff, task({ decompositionStatus }), POLICY)
      expect(prompt).toContain('re-read your own contract and run with `task_read`')
      expect(prompt).toContain('whole tree with `task_status`')
      expect(prompt).toContain('`task_verify` re-runs the verifier as a self-check')
      expect(prompt).toContain('it never changes task status')
      expect(prompt).toContain('the final verdict stays with the verifier')
    }
  })

  test('shows the declared protected inputs in the criteria table', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })
    const guarded = task({
      acceptanceCriteria: [
        {
          criterionId: 'ac1-1',
          description: 'unit tests pass',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'pnpm test',
          protectedInputs: [
            { path: 'tests/check.sh', sha256: 'a'.repeat(64) },
            { path: 'thresholds.json', sha256: 'b'.repeat(64) },
          ],
        },
        // the second criterion declares none: the cell says so rather than
        // leaving the column blank, which would read like a dropped value
        task().acceptanceCriteria[1]!,
      ],
    })

    const prompt = renderWorkerPrompt(handoff, guarded, POLICY)

    expect(prompt).toContain('| criterion | mode | mandatory | description | command | protected inputs |')
    expect(prompt).toContain('| ac1-1 | deterministic | yes | unit tests pass | pnpm test | tests/check.sh, thresholds.json |')
    expect(prompt).toContain('| ac1-2 | review | no | reviewed | — | — |')
  })

  test('states the protected-input rule in both switch branches, next to the command rule', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })

    for (const options of [POLICY, POLICY_OFF]) {
      const prompt = renderWorkerPrompt(handoff, task(), options)
      // The rule is not about decomposition, so it survives the switch being
      // off, and it sits with the other execution rules.
      expect(prompt, JSON.stringify(options)).toContain(
        '- A criterion\'s declared protected inputs must not be modified: the verifier re-checks their identity before judging, ' +
        'and a changed or missing input fails the criterion, naming the path.',
      )
      expect(prompt).toContain('- Where a criterion lists a command, make that command exit 0 in the checkout.')
    }
  })
})

/**
 * The run's binding in the two worker-facing renders (S1-C item 4): the spawn
 * prompt and the contract block must say the same thing about the same run, and
 * a run without a binding must render exactly as it did before the field
 * existed. Both texts come from one function, so this asserts the wiring, not
 * the wording.
 */
describe('the chosen implementation in the spawn prompt and the contract block', () => {
  const binding: RunProviderBinding = {
    registryRevision: 'a'.repeat(64),
    capabilities: ['design-ball', 'research'],
    skills: [{
      name: 'ball-align',
      role: 'knowledge',
      capabilities: ['design-ball'],
      description: 'Align a Buckyball Ball across layers',
      contractDigest: 'c'.repeat(64),
      contentDigest: 'd'.repeat(64),
      uncovered: [],
    }],
    mcpServers: [{ serverName: 'bbdev', templateDigest: 'e'.repeat(64) }],
    snapshotRoot: '/dsh/singularity/run-bindings/sg-t-root/r-1/skills',
  }

  test('both views carry the section, byte-identical, from the one renderer', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })

    const prompt = renderWorkerPrompt(handoff, task(), { ...POLICY, binding })
    const contract = renderWorkerContract(task(), handoff, binding)
    for (const text of [prompt, contract]) {
      expect(text).toContain('## Implementation chosen for this run')
      expect(text).toContain('capability `design-ball` → skill `ball-align` [knowledge]')
      expect(text).toContain('capability `research`: no provider skill')
      expect(text).toContain('Align a Buckyball Ball across layers')
      expect(text).toContain('`bbdev`')
      expect(text).toContain('read with the `skill` tool')
    }
    // Neither view carries the body, and neither makes a readability claim it
    // has not established.
    expect(prompt).not.toContain('not readable')
    expect(contract).not.toContain('not readable')
  })

  test('a run with no binding renders both views exactly as before', () => {
    const handoff = buildHandoff({
      parentTask: task({ taskId: 'root', parentTaskId: undefined, depth: 0, objective: 'ship the release' }),
      parentRun: run(),
      childTask: task(),
      reason: 'split the work',
      callerSessionId: 'root-session',
    })

    for (const text of [
      renderWorkerPrompt(handoff, task(), POLICY),
      renderWorkerContract(task(), handoff),
      renderWorkerPrompt(handoff, task(), { ...POLICY, binding: undefined }),
      renderWorkerContract(task(), handoff, undefined),
    ]) {
      expect(text).not.toContain('## Implementation chosen for this run')
      expect(text).not.toContain('registry revision')
    }
  })
})
