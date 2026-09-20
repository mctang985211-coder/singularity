import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CAPABILITIES } from '../../../task-runtime/src/index.ts'
import { defineCapabilityListTool } from '../../src/tools/capability-list.ts'
import { defineTaskDecomposeTool } from '../../src/tools/task-decompose.ts'
import { defineTaskDiagnoseTool } from '../../src/tools/task-diagnose.ts'
import { defineTaskReadTool } from '../../src/tools/task-read.ts'
import { defineTaskReviewPackTool } from '../../src/tools/task-review-pack.ts'
import { defineTaskStatusTool } from '../../src/tools/task-status.ts'
import { defineTaskVerifyTool } from '../../src/tools/task-verify.ts'

const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }

const rootTask = {
  taskId: 't-root',
  parentTaskId: undefined,
  objective: 'Build the feature',
  depth: 0,
  acceptanceCriteria: [
    {
      criterionId: 'root-children-verified',
      description: 'all mandatory children verified',
      verificationMode: 'composite',
      requiredEvidence: [],
      mandatory: true,
    },
  ],
  requestedCapabilities: [],
  decompositionStatus: 'decomposed',
  status: 'running',
  runIds: ['r-root'],
  childTaskIds: ['t-child-1'],
}

const childTask = {
  taskId: 't-child-1',
  parentTaskId: 't-root',
  objective: 'Implement the parser',
  depth: 1,
  acceptanceCriteria: [
    {
      criterionId: 'ac1-1',
      description: 'parses the fixtures',
      verificationMode: 'deterministic',
      command: 'pnpm test',
      requiredEvidence: [],
      mandatory: true,
    },
  ],
  requestedCapabilities: [],
  decompositionStatus: 'leaf',
  status: 'verified',
  runIds: ['r-child-1'],
  childTaskIds: [],
}

const workerTask = {
  ...childTask,
  taskId: 't-worker',
  status: 'running',
  runIds: ['r-worker'],
  childTaskIds: [],
}

const rootRun = {
  runId: 'r-root',
  taskId: 't-root',
  sessionId: 'root-1',
  capabilitySnapshot: [],
  artifacts: [],
  verifierResults: [],
  status: 'running',
  startedAt: '2026-09-16T00:00:00.000Z',
}

const childRun = { ...rootRun, runId: 'r-child-1', taskId: 't-child-1', sessionId: 's-child', status: 'verified' }
const workerRun = { ...rootRun, runId: 'r-worker', taskId: 't-worker', sessionId: 's-worker', status: 'running' }

const snapshot = {
  version: 1 as const,
  id: 'sg-t-root-1',
  tasks: [rootTask, childTask],
  runs: [rootRun, childRun],
  edges: [],
  evidence: [
    {
      evidenceId: 'ev-1',
      taskRunId: 'r-child-1',
      taskId: 't-child-1',
      artifacts: [],
      verifierResults: [],
      claims: [],
      generatedAt: '2026-09-16T00:01:00.000Z',
    },
  ],
  handoffs: [],
  reviews: [
    {
      taskId: 't-child-1',
      runId: 'r-child-1',
      sessionId: 's-child',
      outcome: 'verified',
      evidenceRefs: ['ev-1'],
      anomalies: [],
    },
  ],
  diagnoses: [], obligations: [],
  capabilities: {},
}

function fixture() {
  const services: Record<string, unknown> = {}
  const ctx = {
    graphs: { graphForSession: vi.fn(async (_sessionId: string) => graph) },
    task: {
      openStore: vi.fn(async (_storeId: string) => snapshot),
      snapshotIn: vi.fn(async (_storeId: string) => snapshot),
      markRunStatusIn: vi.fn(async () => {}),
      recordDiagnosisIn: vi.fn(async () => {}),
    },
    taskRuntime: {
      runForSession: vi.fn(async (sessionId: string) => ({
        storeId: 'sg-t-root-1',
        task: sessionId === 'root-1' ? rootTask : workerTask,
        run: sessionId === 'root-1' ? rootRun : workerRun,
      })),
      decomposeAndRun: vi.fn(),
      listCapabilities: vi.fn(() => structuredClone(DEFAULT_CAPABILITIES)),
      verifyTimeoutMs: 1234,
    },
    get: (name: string) => services[name],
  }
  return { ctx, services }
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as never
}

describe('task_read', () => {
  it('returns the root task contract and child statuses for the root session', async () => {
    const { ctx } = fixture()
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(ctx.task.openStore).toHaveBeenCalledExactlyOnceWith('sg-t-root-1')
    expect(result).toContain('root task t-root [running/decomposed]')
    expect(result).toContain('objective: Build the feature')
    expect(result).toContain('root-children-verified [composite] all mandatory children verified')
    expect(result).toContain('- t-child-1 [verified/leaf] run r-child-1 [verified] Implement the parser')
  })

  it('returns the own task and run for a worker session', async () => {
    const { ctx } = fixture()
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(ctx.taskRuntime.runForSession).toHaveBeenCalledExactlyOnceWith('s-worker')
    expect(result).toContain('task t-worker [running] depth 1')
    expect(result).toContain('objective: Implement the parser')
    expect(result).toContain('- ac1-1 [deterministic, mandatory] parses the fixtures — $ pnpm test')
    expect(result).toContain('run r-worker [running]')
  })
})

describe('task_decompose', () => {
  const children = [
    {
      objective: 'Implement the parser',
      acceptanceCriteria: [{ description: 'parses the fixtures', command: 'pnpm test' }],
    },
    {
      objective: 'Write the docs',
      acceptanceCriteria: [{ description: 'docs build', command: 'pnpm docs:build' }],
      dependsOn: [0],
    },
  ]

  it('passes the spec through to decomposeAndRun and renders per-child results', async () => {
    const { ctx } = fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.decomposeAndRun.mockResolvedValue([
      { taskId: 't-child-1', runId: 'r-1', status: 'verified', evidenceId: 'ev-1' },
      { taskId: 't-child-2', status: 'blocked' },
    ])
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, { agent: { id: 'root-1' }, signal } as never)) as string
    expect(ctx.taskRuntime.decomposeAndRun).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children },
      { signal },
    )
    expect(result).toContain('decomposed t-root into 2 children:')
    expect(result).toContain('- t-child-1: verified run r-1 evidence ev-1')
    expect(result).toContain('- t-child-2: blocked')
  })

  it('returns the admission rejection as error text instead of throwing', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.decomposeAndRun.mockRejectedValue(
      new Error('task-runtime: admission rejected decomposition of "t-root":\n- child 0 has no acceptance criteria'),
    )
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string
    expect(result).toContain('task_decompose rejected:')
    expect(result).toContain('admission rejected decomposition of "t-root"')
    expect(result).toContain('child 0 has no acceptance criteria')
  })
})

describe('capability_list', () => {
  it('renders the registry with each label resolved to the tools it grants', async () => {
    const { ctx } = fixture()
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(ctx.taskRuntime.listCapabilities).toHaveBeenCalledOnce()
    expect(result).toContain(`capabilities (${Object.keys(DEFAULT_CAPABILITIES).length}):`)
    expect(result).toContain('- design-ball — tools: [filesystem → read, write, edit; bash → bash] skills: [ball-align]')
    expect(result).toContain('- verify-ball-functional — tools: [] skills: [verify] preset: bb-verify mcpServers: [bbdev]')
    expect(result).toContain('- research — tools: [] skills: [] preset: standard')
    expect(result).toContain('- analyze-waveform — tools: [] skills: [waveform]')
  })

  it('states the baseline, the fail-closed tool rule, the skill boundary, and the permission posture', async () => {
    const { ctx } = fixture()
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string

    expect(result).toContain('worker baseline (every capability worker keeps these on top of its grants): ')
    expect(result).toContain('bash')
    expect(result).toContain('baseline labels: ')
    // The machinery line is rendered from WORKER_BASELINE_TOOLS, so it cannot drift from the grant.
    expect(result).toContain('task machinery: task_read, task_status, task_decompose, task_verify')
    expect(result).toContain('tool grants are fail-closed: ')
    expect(result).toContain('skill grants are not exclusive: DSH has no per-agent skill hiding')
    expect(result).toContain('mcpServers grant whole MCP servers')
    expect(result).toContain('leaves the worker on the deployment default (danger-full-access)')
    expect(result).toContain('- design-chip — tools: [] skills: [chip-designer] permission: (none — the worker keeps danger-full-access)')
  })

  it('flags a label outside the vocabulary instead of resolving it silently', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.listCapabilities.mockReturnValue({ broken: { tools: ['filesystem', 'filesytem'] } })
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(result).toContain('- broken — tools: [filesystem → read, write, edit; filesytem → (unknown label)] skills: []')
  })
})

describe('task_status', () => {
  it('renders a compact task tree for the caller graph', async () => {
    const { ctx } = fixture()
    const tool = defineTaskStatusTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(ctx.task.openStore).toHaveBeenCalledExactlyOnceWith('sg-t-root-1')
    expect(result).toContain('graph graph1 task tree (2 tasks):')
    expect(result).toContain('t-root [running] Build the feature (run: running)')
    expect(result).toContain('  t-child-1 [verified] Implement the parser (run: verified evidence: [ev-1] review: verified)')
  })

  it('renders the localized cause of a failed review', async () => {
    const { ctx } = fixture()
    ctx.task.openStore.mockResolvedValue({
      ...snapshot,
      tasks: [{ ...rootTask, status: 'failed' }, { ...childTask, status: 'failed' }],
      runs: [rootRun, { ...childRun, status: 'failed' }],
      reviews: [
        {
          taskId: 't-child-1',
          runId: 'r-child-1',
          sessionId: 's-child',
          outcome: 'failed',
          evidenceRefs: ['ev-1'],
          anomalies: [],
          localizedCause: 'mandatory criteria not satisfied: ac1-1 fail',
        },
      ],
    })
    const tool = defineTaskStatusTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(result).toContain('review: failed — mandatory criteria not satisfied: ac1-1 fail')
  })

  it('appends failing criterion ids and exit codes when the failed review carries criteria', async () => {
    const { ctx } = fixture()
    ctx.task.openStore.mockResolvedValue({
      ...snapshot,
      tasks: [{ ...rootTask, status: 'failed' }, { ...childTask, status: 'failed' }],
      runs: [rootRun, { ...childRun, status: 'failed' }],
      reviews: [
        {
          taskId: 't-child-1',
          runId: 'r-child-1',
          sessionId: 's-child',
          outcome: 'failed',
          evidenceRefs: ['ev-1'],
          anomalies: [],
          localizedCause: 'mandatory criteria not satisfied: ac1-1 fail',
          criteria: [
            { criterionId: 'ac1-1', verdict: 'fail', command: 'pnpm test', exitCode: 1, logRef: 'sg-t-root-1/r-child-1/ac1-1.log' },
            { criterionId: 'ac1-2', verdict: 'pass', command: 'true', exitCode: 0 },
          ],
        },
      ],
    })
    const tool = defineTaskStatusTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(result).toContain('review: failed — mandatory criteria not satisfied: ac1-1 fail [ac1-1 exit 1]')
  })

  it('renders the blocking anomaly of a runless blocked review', async () => {
    const { ctx } = fixture()
    ctx.task.openStore.mockResolvedValue({
      ...snapshot,
      tasks: [rootTask, { ...childTask, status: 'blocked', runIds: [] }],
      runs: [rootRun],
      reviews: [
        {
          taskId: 't-child-1',
          outcome: 'blocked',
          evidenceRefs: [],
          anomalies: ['dependencies [t-other] did not verify'],
          relatedTaskIds: ['t-other'],
        },
      ],
    })
    const tool = defineTaskStatusTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(result).toContain('review: blocked — dependencies [t-other] did not verify')
  })
})

describe('task_verify', () => {
  const bundle = {
    evidenceId: 'ev-self-1',
    taskRunId: 'r-worker',
    taskId: 't-worker',
    artifacts: [],
    verifierResults: [
      { criterionId: 'ac1-1', status: 'pass', verifierId: 'command', command: 'pnpm test', exitCode: 0 },
    ],
    claims: [],
    generatedAt: '2026-09-16T00:02:00.000Z',
  }

  it('re-runs the verifier with the graph env cwd and records no status', async () => {
    const { ctx, services } = fixture()
    const verifyRun = vi.fn(async () => bundle)
    services['verifier'] = { verifyRun }
    services['envBuilder'] = { store: { get: (envId: string) => ({ path: `/envs/${envId}` }) } }
    const tool = defineTaskVerifyTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(ctx.taskRuntime.runForSession).toHaveBeenCalledExactlyOnceWith('s-worker')
    expect(verifyRun).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'r-worker', { cwd: '/envs/project1', timeoutMs: 1234 })
    expect(ctx.task.markRunStatusIn).not.toHaveBeenCalled()
    expect(result).toContain('self-check, status unchanged')
    expect(result).toContain('- ac1-1: pass by command — $ pnpm test exit 0')
  })

  it('omits cwd when the env checkout cannot be resolved', async () => {
    const { ctx, services } = fixture()
    const verifyRun = vi.fn(async () => bundle)
    services['verifier'] = { verifyRun }
    const tool = defineTaskVerifyTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(verifyRun).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'r-worker', { timeoutMs: 1234 })
    expect(ctx.task.markRunStatusIn).not.toHaveBeenCalled()
    expect(result).toContain('self-check, status unchanged')
  })

  it('refuses to run the verifier without a deadline when the runtime exposes no positive timeout', async () => {
    const { ctx, services } = fixture()
    const verifyRun = vi.fn(async () => bundle)
    services['verifier'] = { verifyRun }
    ;(ctx.taskRuntime as { verifyTimeoutMs?: number }).verifyTimeoutMs = 0
    const tool = defineTaskVerifyTool(ctx as never)
    await expect(tool.execute({}, exec('s-worker'))).rejects.toThrow(
      'task_verify: task runtime exposes no positive verifyTimeoutMs (got 0); refusing to run the verifier without a deadline',
    )
    expect(verifyRun).not.toHaveBeenCalled()
  })

  it('returns a friendly error for a finished run without calling the verifier', async () => {
    const { ctx, services } = fixture()
    const verifyRun = vi.fn(async () => bundle)
    services['verifier'] = { verifyRun }
    ctx.taskRuntime.runForSession.mockResolvedValue({ storeId: 'sg-t-root-1', task: childTask, run: childRun })
    const tool = defineTaskVerifyTool(ctx as never)
    const result = (await tool.execute({}, exec('s-child'))) as string
    expect(verifyRun).not.toHaveBeenCalled()
    expect(result).toContain('run r-child-1 of task t-child-1 is verified')
    expect(result).toContain('while the run is running')
  })

  it('fails loudly when the verifier service is not loaded', async () => {
    const { ctx } = fixture()
    const tool = defineTaskVerifyTool(ctx as never)
    await expect(tool.execute({}, exec('s-worker'))).rejects.toThrow('verifier service is not loaded')
  })
})

describe('task_review_pack', () => {
  function nestedSnapshot() {
    return {
      ...snapshot,
      tasks: [
        { ...rootTask, status: 'verified', childTaskIds: ['t-child-1', 't-child-2'] },
        { ...childTask, status: 'failed' },
        { ...childTask, taskId: 't-child-2', status: 'blocked', runIds: [], childTaskIds: [] },
      ],
      runs: [{ ...rootRun, status: 'verified' }, { ...childRun, status: 'failed' }],
      edges: [{ from: 't-child-1', to: 't-child-2' }],
      reviews: [
        { taskId: 't-root', runId: 'r-root', sessionId: 'root-1', outcome: 'verified', evidenceRefs: [], anomalies: [] },
        {
          taskId: 't-child-1',
          runId: 'r-child-1',
          sessionId: 's-child',
          outcome: 'failed',
          evidenceRefs: ['ev-1'],
          anomalies: [],
          localizedCause: 'mandatory criteria not satisfied: ac1-1 fail',
          durationMs: 42,
          criteria: [{ criterionId: 'ac1-1', verdict: 'fail', command: 'pnpm test', exitCode: 1, logRef: 'sg-t-root-1/r-child-1/ac1-1.log' }],
          logTail: 'line a\nline b',
        },
        {
          taskId: 't-child-2',
          outcome: 'blocked',
          evidenceRefs: [],
          anomalies: ['dependencies [t-child-1] did not verify'],
          blockedBy: [{ taskId: 't-child-1', outcome: 'failed' }],
          relatedTaskIds: ['t-child-1'],
        },
      ],
    }
  }

  it('assembles the nested pack: own reviews in full, parent and children summaries, dependency edges', async () => {
    const { ctx } = fixture()
    ctx.task.openStore.mockResolvedValue(nestedSnapshot())
    const tool = defineTaskReviewPackTool(ctx as never)

    const rootPack = (await tool.execute({ taskId: 't-root' }, exec('root-1'))) as string
    expect(rootPack).toContain('review pack for task t-root [verified] depth 0')
    expect(rootPack).toContain('review t-root#r-root [verified]')
    expect(rootPack).toContain('- t-child-1 [failed]: review t-child-1#r-child-1: failed — mandatory criteria not satisfied: ac1-1 fail')
    expect(rootPack).toContain('- t-child-2 [blocked]: review t-child-2#no-run: blocked — dependencies [t-child-1] did not verify')
    expect(rootPack).toContain('diagnoses (0)')

    const childPack = (await tool.execute({ taskId: 't-child-1' }, exec('root-1'))) as string
    expect(childPack).toContain('review t-child-1#r-child-1 [failed] duration 42ms evidence: [ev-1]')
    expect(childPack).toContain('cause: mandatory criteria not satisfied: ac1-1 fail')
    expect(childPack).toContain('criterion ac1-1: fail exit 1 — $ pnpm test log sg-t-root-1/r-child-1/ac1-1.log')
    expect(childPack).toContain('    line a')
    expect(childPack).toContain('    line b')
    // A record with neither addition renders neither block: absence is not printed as 0.
    expect(childPack).not.toContain('metrics:')
    expect(childPack).not.toContain('  dim ')
    expect(childPack).toContain('parent t-root [verified]: review t-root#r-root: verified')
    expect(childPack).toContain('dependencies: must verify first []; blocks [t-child-2]')

    const blockedPack = (await tool.execute({ taskId: 't-child-2' }, exec('root-1'))) as string
    expect(blockedPack).toContain('review t-child-2#no-run [blocked]')
    expect(blockedPack).toContain('blockedBy t-child-1 [failed]')
    expect(blockedPack).toContain('dependencies: must verify first [t-child-1]; blocks []')
  })

  it('renders the metrics line and each dimension fact, and nothing for the dimensions the record omits', async () => {
    const { ctx } = fixture()
    const full = nestedSnapshot()
    const target = full.reviews.find(item => item.taskId === 't-child-1')!
    Object.assign(target, {
      metrics: {
        tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 },
        toolCalls: { calls: 5, failures: 1 },
        humanInterventions: 2,
        retries: 0,
        evidenceLogs: 1,
      },
      dimensions: {
        outcomeCorrectness: { outcome: 'failed', criteriaCount: 1, unmetCriterionIds: ['ac1-1'] },
        taskSpecification: { objectivePresent: true, criteriaCount: 1, criteriaWithCommand: 1 },
        acceptance: { criteria: [{ criterionId: 'ac1-1', mode: 'deterministic', hasCommand: true, mandatory: true }] },
        // this task is the edge's source (`t-child-1` -> `t-child-2`), so it has one outgoing edge and none incoming
        decomposition: { depth: 1, decompositionStatus: 'leaf', childCount: 0, incomingEdges: 0, outgoingEdges: 1 },
        capabilityCoverage: { closure: 'closed', granted: ['bash', 'read'], missing: [] },
        skillFit: { granted: ['verify'], loaded: ['check'], loadedOutsideGrant: ['check'] },
        toolFit: { granted: ['bash', 'read'], called: [{ name: 'read', count: 2 }], calledOutsideGrant: ['web_search'] },
        contextEfficiency: {
          tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheWriteTokens: 10 },
          compactions: 1,
        },
      },
    })
    ctx.task.openStore.mockResolvedValue(full)
    const tool = defineTaskReviewPackTool(ctx as never)
    const pack = (await tool.execute({ taskId: 't-child-1' }, exec('root-1'))) as string

    expect(pack).toContain(
      'metrics: tokens in 1000/out 200/cache 50+10 (session-cumulative) — toolCalls 5 (1 failed) — '
      + 'humanInterventions 2 (session-scoped) — retries 0 (no retry branch exists yet; always 0) — evidenceLogs 1',
    )
    expect(pack).toContain('dim outcome correctness: failed, criteria 1, unmet [ac1-1]')
    expect(pack).toContain('dim task specification: objective present, criteria 1, with command 1')
    expect(pack).toContain('dim acceptance: ac1-1 deterministic +command')
    expect(pack).toContain('dim decomposition: depth 1, leaf, children 0, edges in/out 0/1')
    expect(pack).toContain('dim capability coverage: closed, granted [bash, read], missing []')
    expect(pack).toContain('dim skill fit: granted [verify], loaded [check], outside grant [check]')
    expect(pack).toContain('dim tool fit: granted [bash, read], called [read x2], outside grant [web_search]')
    expect(pack).toContain('dim context efficiency: tokens in/out 1000/200 compactions 1')
  })

  it('rejects an unknown task id', async () => {
    const { ctx } = fixture()
    const tool = defineTaskReviewPackTool(ctx as never)
    await expect(tool.execute({ taskId: 'ghost' }, exec('root-1'))).rejects.toThrow('unknown task "ghost"')
  })
})

describe('task_diagnose', () => {
  const args = {
    taskId: 't-child-1',
    diagnosisId: 'd1',
    observedFailure: 'ac1-1 fails on the fixtures',
    scope: 'this task only',
    localizedCause: 'the fixtures never feed empty input',
    evidenceRefs: ['ev-1'],
    reviewRefs: ['t-child-1#r-child-1'],
    confidence: 'medium',
    proposals: [{ targetType: 'task_definition', targetId: 'build:1', rationale: 'add an empty-input fixture to the acceptance command' }],
  }

  it('persists the diagnosis and reports proposals as suggestions only', async () => {
    const { ctx } = fixture()
    const tool = defineTaskDiagnoseTool(ctx as never)
    const result = (await tool.execute(args, exec('root-1'))) as string
    expect(ctx.task.recordDiagnosisIn).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', args, 'root-1')
    expect(result).toContain('diagnosis d1 recorded for task t-child-1 [medium]')
    expect(result).toContain('cause: the fixtures never feed empty input')
    expect(result).toContain('suggestions only — none auto-executes')
    expect(result).toContain('- task_definition build:1: add an empty-input fixture to the acceptance command')
  })

  it('round-trips: a recorded diagnosis shows up in the next review pack and in task_status', async () => {
    const { ctx } = fixture()
    const state = structuredClone(snapshot)
    ctx.task.openStore.mockImplementation(async () => state)
    ctx.task.recordDiagnosisIn.mockImplementation(async (_storeId: string, diagnosis: never) => {
      state.diagnoses.push(diagnosis)
    })
    const result = (await defineTaskDiagnoseTool(ctx as never).execute(args, exec('root-1'))) as string
    expect(result).toContain('diagnosis d1 recorded')
    const pack = (await defineTaskReviewPackTool(ctx as never).execute({ taskId: 't-child-1' }, exec('root-1'))) as string
    expect(pack).toContain('diagnoses (1):')
    expect(pack).toContain('- d1 [medium] the fixtures never feed empty input')
    const status = (await defineTaskStatusTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(status).toContain('t-child-1 [verified] Implement the parser (run: verified evidence: [ev-1] review: verified diag: 1)')
    expect(status).not.toContain('diag: 0')
  })

  it('returns store rejections as error text instead of throwing', async () => {
    const { ctx } = fixture()
    ctx.task.recordDiagnosisIn.mockRejectedValue(new Error('task: diagnosis "d1" already exists'))
    const tool = defineTaskDiagnoseTool(ctx as never)
    const result = (await tool.execute(args, exec('root-1'))) as string
    expect(result).toBe('task_diagnose rejected: task: diagnosis "d1" already exists')
  })

  it('rejects a proposal targetType outside the frozen vocabulary and persists nothing', async () => {
    const { ctx } = fixture()
    const tool = defineTaskDiagnoseTool(ctx as never)
    const rejected = (await tool.execute(
      { ...args, proposals: [{ targetType: 'prompt', targetId: 'x', rationale: 'y' }] },
      exec('root-1'),
    ).catch((error: Error) => String(error))) as string
    expect(rejected).toContain('targetType')
    expect(ctx.task.recordDiagnosisIn).not.toHaveBeenCalled()
  })

  it('rejects a proposals payload that is not an array of proposal objects and persists nothing', async () => {
    const { ctx } = fixture()
    const tool = defineTaskDiagnoseTool(ctx as never)
    for (const proposals of ['text', [{ targetType: 'skill' }]]) {
      const rejected = (await tool.execute(
        { ...args, proposals },
        exec('root-1'),
      ).catch((error: Error) => String(error))) as string
      expect(rejected).toContain('proposals')
    }
    expect(ctx.task.recordDiagnosisIn).not.toHaveBeenCalled()
  })
})

describe('missing agent identity', () => {
  it.each([
    ['task_read', () => defineTaskReadTool(fixture().ctx as never), {}],
    ['task_status', () => defineTaskStatusTool(fixture().ctx as never), {}],
    ['task_verify', () => defineTaskVerifyTool(fixture().ctx as never), {}],
    ['task_review_pack', () => defineTaskReviewPackTool(fixture().ctx as never), { taskId: 't-child-1' }],
    ['task_diagnose', () => defineTaskDiagnoseTool(fixture().ctx as never), {
      taskId: 't-child-1',
      diagnosisId: 'd1',
      observedFailure: 'f',
      scope: 's',
      localizedCause: 'c',
      confidence: 'medium',
    }],
  ])('%s rejects a call with no agent identity', async (_name, make, args) => {
    const tool = make()
    for (const exec of [{}, { agent: { id: '' }, signal: new AbortController().signal }]) {
      await expect(tool.execute(args, exec as never)).rejects.toThrow('missing agent id')
    }
  })
})
