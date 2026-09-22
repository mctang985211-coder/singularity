import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CAPABILITIES } from '../../../task-runtime/src/index.ts'
import { defineCapabilityListTool } from '../../src/tools/capability-list.ts'
import { defineTaskDecomposeTool } from '../../src/tools/task-decompose.ts'
import { defineTaskCancelTool } from '../../src/tools/task-cancel.ts'
import { defineTaskDiagnoseTool } from '../../src/tools/task-diagnose.ts'
import { defineTaskReadTool } from '../../src/tools/task-read.ts'
import { defineTaskReviewPackTool } from '../../src/tools/task-review-pack.ts'
import { defineTaskStatusTool } from '../../src/tools/task-status.ts'
import { defineTaskSubmitResultTool } from '../../src/tools/task-submit-result.ts'
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
  // A run the A3 protocol would have created: born `active`. A fixture run that
  // carries no phase is an old record, and the readers say so (see the
  // phase-rendering tests).
  executionPhase: 'active' as const,
  startedAt: '2026-09-16T00:00:00.000Z',
}

const childRun = {
  ...rootRun,
  runId: 'r-child-1',
  taskId: 't-child-1',
  sessionId: 's-child',
  status: 'verified',
  // The path every verified run took: it submitted, and the verdict followed.
  executionPhase: 'submitted' as const,
}
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

/**
 * The provider report `capability_list` renders: one accepted row per role, one
 * refused row, and one row that grants no skill — the shapes the renderer has to
 * say something honest about.
 */
function providerReport() {
  return {
    capabilities: [
      {
        capability: 'design-ball',
        skills: [{
          valid: true,
          role: 'guidance',
          name: 'ball-align',
          directory: '/skills/ball-align',
          content: { skillMdSha256: 'a'.repeat(64), resources: [] },
          contentDigest: 'b'.repeat(64),
          uncovered: [],
        }],
      },
      {
        capability: 'verify-ball-functional',
        skills: [{
          valid: true,
          role: 'execution-provider',
          name: 'verify',
          directory: '/skills/verify',
          capabilities: ['verify-ball-functional'],
          precondition: 'the bbdev server is loaded',
          inputs: [],
          outputs: [],
          requiredTools: ['bash'],
          verifierRef: 'command',
          contractDigest: 'c'.repeat(64),
          content: { skillMdSha256: 'd'.repeat(64), resources: [] },
          contentDigest: 'e'.repeat(64),
        }],
      },
      {
        capability: 'integrate-model',
        skills: [{
          valid: false,
          name: 'workload-tests',
          directory: '/skills/workload-tests',
          defects: [{ code: 'content-mismatch', detail: 'SKILL.md is not the declared content' }],
        }],
      },
      { capability: 'research', skills: [] },
    ],
    roots: ['/env/.agents/skills', '/dsh-home/skills'],
  }
}

/** The table the rendering test checks: the three verdict shapes above plus a row that grants no skill. */
const RENDER_TABLE = {
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'verify-ball-functional': { skills: ['verify'], preset: 'bb-verify', mcpServers: ['bbdev'] },
  'integrate-model': { skills: ['workload-tests'] },
  research: { preset: 'standard' },
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
      capabilityProviderReport: vi.fn(async (_sessionId: string) => providerReport()),
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
    expect(result).toContain('- t-child-1 [verified/leaf] run r-child-1 [verified] — phase submitted Implement the parser')
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

  it('renders the stored contract assumptions and constraints when the task has a contract', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.runForSession.mockImplementation(async () => ({
      storeId: 'sg-t-root-1',
      task: {
        ...workerTask,
        contract: {
          contractVersion: 1,
          objective: workerTask.objective,
          acceptanceCriteria: workerTask.acceptanceCriteria,
          assumptions: ['the fixtures are checked in'],
          constraints: ['no network access'],
          requiredCapabilities: [],
        },
      },
      run: workerRun,
    }) as never)
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(result).toContain('assumptions:\n- the fixtures are checked in')
    expect(result).toContain('constraints:\n- no network access')
  })

  it('renders a worker task without a contract exactly as before, inventing nothing', async () => {
    const { ctx } = fixture()
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(result).not.toContain('assumptions:')
    expect(result).not.toContain('constraints:')
  })

  it('renders the declared protected inputs on a worker criterion line', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.runForSession.mockImplementation(async () => ({
      storeId: 'sg-t-root-1',
      task: {
        ...workerTask,
        acceptanceCriteria: [
          {
            ...workerTask.acceptanceCriteria[0]!,
            protectedInputs: [
              { path: 'tests/check.sh', sha256: 'a'.repeat(64) },
              { path: 'thresholds.json', sha256: 'b'.repeat(64) },
            ],
          },
        ],
      },
      run: workerRun,
    }) as never)
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(result).toContain(
      '- ac1-1 [deterministic, mandatory] parses the fixtures — $ pnpm test [protected inputs: tests/check.sh, thresholds.json]',
    )
  })

  it('renders no protected-input suffix for a criterion that declares none', async () => {
    const { ctx } = fixture()
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(result).not.toContain('protected inputs')
  })

  /**
   * The run the caller is executing, as the store recorded it (S1-C stage 3):
   * the same summary the spawn's contract block carries, read back from the run
   * record and re-checked against the bytes the run was bound to. A view that
   * fell back to the production skill path when the snapshot was gone would tell
   * the worker it is running content it is not.
   */
  const workerBinding = {
    registryRevision: 'a'.repeat(64),
    capabilities: ['design-ball'],
    skills: [
      {
        name: 'ball-align',
        role: 'guidance' as const,
        capabilities: ['design-ball'],
        description: 'Align a Buckyball Ball across layers',
        contractDigest: null,
        contentDigest: 'b'.repeat(64),
        uncovered: [] as string[],
      },
    ],
    mcpServers: [],
    snapshotRoot: '/dsh/singularity/run-bindings/sg-t-root-1/r-worker/skills',
  }

  function boundWorkerFixture(read: unknown) {
    const { ctx } = fixture()
    ctx.taskRuntime.runForSession.mockImplementation(async () => ({
      storeId: 'sg-t-root-1',
      task: workerTask,
      run: { ...workerRun, providerBinding: workerBinding },
    }) as never)
    ctx.taskRuntime.readRunBinding = vi.fn(async () => read) as never
    return { ctx }
  }

  it('renders the providers this run was bound to, and re-checks them against the record', async () => {
    const { ctx } = boundWorkerFixture({
      skills: [{ name: 'ball-align', role: 'guidance', readable: true, defects: [] }],
      defects: [],
    })
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(ctx.taskRuntime.readRunBinding).toHaveBeenCalledExactlyOnceWith(workerBinding)
    expect(result).toContain('design-ball')
    expect(result).toContain('ball-align')
    expect(result).toContain('guidance')
    expect(result).toContain('Align a Buckyball Ball across layers')
    expect(result).toContain('bbbbbbbbbbbb')
    // The snapshot was read back and matched: no refusal line is invented.
    expect(result).not.toContain('not readable')
  })

  it('reports bound content that is not readable by name, never a silent fallback', async () => {
    const { ctx } = boundWorkerFixture({
      skills: [{ name: 'ball-align', role: 'guidance', readable: false, defects: ['SKILL.md is not the recorded content: recorded bb…, read cc…'] }],
      defects: ['skill "ball-align": SKILL.md is not the recorded content: recorded bb…, read cc…'],
    })
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(result).toContain('not readable')
    expect(result).toContain('ball-align')
    expect(result).toContain('SKILL.md is not the recorded content')
    // The record's identity is still shown — what the run was bound to is a
    // fact, and the refusal is about the bytes on disk now.
    expect(result).toContain('bbbbbbbbbbbb')
  })

  it('renders nothing extra for a run that carries no binding claim', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.readRunBinding = vi.fn() as never
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(ctx.taskRuntime.readRunBinding).not.toHaveBeenCalled()
    expect(result).not.toContain('bound')
    expect(result).not.toContain('not readable')
  })

  it('renders the declared protected inputs on the root line too', async () => {
    const { ctx } = fixture()
    ctx.task.openStore.mockResolvedValue({
      ...snapshot,
      tasks: [
        {
          ...rootTask,
          acceptanceCriteria: [
            { ...rootTask.acceptanceCriteria[0]!, protectedInputs: [{ path: 'tests/check.sh', sha256: 'a'.repeat(64) }] },
          ],
        },
        childTask,
      ],
    })
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(result).toContain('- root-children-verified [composite] all mandatory children verified [protected inputs: tests/check.sh]')
  })

  /**
   * The coordination phase (A3 §3.8): where the caller's own run stands in the
   * protocol, and what an old record looks like — a reader is never told
   * `active` about a run nobody can admit work for.
   */
  function workerRunFixture(run: Record<string, unknown>) {
    const { ctx } = fixture()
    ctx.taskRuntime.runForSession.mockImplementation(async () => ({
      storeId: 'sg-t-root-1',
      task: workerTask,
      run: { ...workerRun, ...run },
    }) as never)
    return { ctx }
  }

  it('renders the phase of an active run, with its no-progress marking', async () => {
    const { ctx } = workerRunFixture({
      noProgress: { kind: 'unsubmitted-idle', rounds: 2, factCount: 7, markedAt: '2026-09-16T00:02:00.000Z' },
    })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain(
      'run r-worker [running] — phase active; no-progress round 2 (unsubmitted-idle) started 2026-09-16T00:00:00.000Z',
    )
  })

  it('renders the batch a waiting run is waiting on', async () => {
    const { ctx } = workerRunFixture({ executionPhase: 'waiting_children', batchId: 'b-t-worker' })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain('run r-worker [running] — phase waiting_children; batch b-t-worker started')
  })

  it('renders what a submitted run handed in, with the evidence it named', async () => {
    const { ctx } = workerRunFixture({
      executionPhase: 'submitted',
      submission: {
        summary: 'children verified and the suite passes',
        evidenceRefs: ['ev-1', 'ev-2'],
        notes: 'nothing left open',
        submittedAt: '2026-09-16T00:03:00.000Z',
        origin: 'worker',
      },
    })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain(
      'run r-worker [running] — phase submitted; submitted by worker at 2026-09-16T00:03:00.000Z: ' +
      '"children verified and the suite passes"; evidence [ev-1, ev-2]; notes: nothing left open started',
    )
  })

  it('renders a running run with no phase as the old record it is, not as active', async () => {
    const { ctx } = workerRunFixture({ executionPhase: undefined })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain('needs-recovery (an old record: it was created before coordination phases')
    expect(result).toContain('cancel this task tree to recover')
    expect(result).not.toContain('phase active')
  })

  it('adds no phase to a terminal run that predates the field', async () => {
    const { ctx } = workerRunFixture({ executionPhase: undefined, status: 'verified' })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain('run r-worker [verified] started 2026-09-16T00:00:00.000Z')
    expect(result).not.toContain('needs-recovery')
    expect(result).not.toContain('phase ')
  })

  it('renders each child run line of the root view with its own phase', async () => {
    const { ctx } = fixture()
    ctx.task.openStore.mockResolvedValue({
      ...snapshot,
      tasks: [rootTask, { ...childTask, status: 'running' }],
      runs: [rootRun, { ...childRun, status: 'running', executionPhase: 'waiting_children', batchId: 'b-t-child-1' }],
    })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(result).toContain(
      '- t-child-1 [running/leaf] run r-child-1 [running] — phase waiting_children; batch b-t-child-1 Implement the parser',
    )
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
    ctx.taskRuntime.decomposeAndRun.mockResolvedValue({ batchId: 'b-t-root', childTaskIds: ['t-child-1', 't-child-2'] })
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
    // The tool returns at admission (A3 §3.1) and says so: it reports the batch
    // that was admitted, not outcomes nobody has produced yet.
    expect(result).toContain('decomposed t-root into 2 children (batch b-t-root):')
    expect(result).toContain('- child 1: t-child-1')
    expect(result).toContain('- child 2: t-child-2')
    expect(result).toContain('does not wait for the batch')
  })

  it('states the contract the caller is under while the batch runs', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.decomposeAndRun.mockResolvedValue({ batchId: 'b-t-root', childTaskIds: ['t-child-1'] })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    // The model-visible behaviour contract (§3.8): the batch id, the phase the
    // caller is now in, what is still allowed, and that settlement is announced
    // — everything the caller needs to not write into the children's checkout.
    expect(result).toContain('The runtime owns batch b-t-root now')
    expect(result).toContain('You are in phase waiting_children')
    expect(result).toContain('`task_cancel`')
    expect(result).toContain('Writes, shell commands, another decomposition and a submission of your own are refused')
    expect(result).toContain('You are notified when the batch settles')
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

  it('passes a declared contract version through to decomposeAndRun', async () => {
    const { ctx } = fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.decomposeAndRun.mockResolvedValue({ batchId: 'b-t-root', childTaskIds: ['t-child-1'] })
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', contractVersion: 1, children }, { agent: { id: 'root-1' }, signal } as never)
    expect(ctx.taskRuntime.decomposeAndRun).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', contractVersion: 1, children },
      { signal },
    )
    // The key rides along only when declared: the pass-through test above omits it and stays unchanged.
    expect(Object.keys(ctx.taskRuntime.decomposeAndRun.mock.calls[0]![4] as Record<string, unknown>).sort())
      .toEqual(['children', 'contractVersion', 'reason'])
  })

  it('sends no contractVersion key when the caller declares none', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.decomposeAndRun.mockResolvedValue({ batchId: 'b-t-root', childTaskIds: ['t-child-1'] })
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', children }, exec('root-1'))
    // Deep equality alone also accepts a present key holding undefined, so the omission is asserted on the keys.
    expect(Object.keys(ctx.taskRuntime.decomposeAndRun.mock.calls[0]![4] as Record<string, unknown>).sort())
      .toEqual(['children', 'reason'])
  })

  it('returns the runtime rejection of an unknown declared contract version as error text', async () => {
    const { ctx } = fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.decomposeAndRun.mockRejectedValue(
      new Error('task-runtime: contract rejected decomposition of "t-root":\n- unknown contract version 2: this runtime writes version 1'),
    )
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute(
      { reason: 'split the work', contractVersion: 2, children },
      { agent: { id: 'root-1' }, signal } as never,
    )) as string
    expect(ctx.taskRuntime.decomposeAndRun).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', contractVersion: 2, children },
      { signal },
    )
    expect(result).toContain('task_decompose rejected:')
    expect(result).toContain('unknown contract version 2')
  })

  it('passes declared criterion ids and child constraints through untouched', async () => {
    const { ctx } = fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.decomposeAndRun.mockResolvedValue({ batchId: 'b-t-root', childTaskIds: ['t-child-1'] })
    const declared = [
      {
        objective: 'Implement the parser',
        acceptanceCriteria: [{ criterionId: 'parse-fixtures', description: 'parses the fixtures', command: 'pnpm test' }],
        constraints: ['no network access', 'write only inside the env checkout'],
      },
    ]
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', children: declared }, { agent: { id: 'root-1' }, signal } as never)
    expect(ctx.taskRuntime.decomposeAndRun).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children: declared },
      { signal },
    )
  })

  it('declares protectedInputs on the criterion schema and passes the declared paths through untouched', async () => {
    const { ctx } = fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.decomposeAndRun.mockResolvedValue({ batchId: 'b-t-root', childTaskIds: ['t-child-1'] })
    const tool = defineTaskDecomposeTool(ctx as never)

    // The schema is the model-facing half of the contract: the declared paths
    // are a per-criterion string array, and the description says who fixes the
    // identity, who re-checks it, and that only declared paths are protected.
    const criteria = (tool.parameters as {
      properties: { children: { items: { properties: { acceptanceCriteria: { items: { properties: Record<string, { type: unknown; items?: { type: unknown }; description?: string }> } } } } } }
    }).properties.children.items.properties.acceptanceCriteria.items.properties
    expect(criteria.protectedInputs?.type).toBe('array')
    expect(criteria.protectedInputs?.items?.type).toBe('string')
    expect(criteria.protectedInputs?.description).toContain('SHA-256')
    expect(criteria.protectedInputs?.description).toContain('before judging')
    expect(criteria.protectedInputs?.description).toContain('Only declared paths are protected')

    const declared = [
      {
        objective: 'Implement the parser',
        acceptanceCriteria: [{
          description: 'parses the fixtures',
          command: 'tests/check.sh',
          protectedInputs: ['tests/check.sh', 'thresholds.json'],
        }],
      },
    ]
    await tool.execute({ reason: 'split the work', children: declared }, { agent: { id: 'root-1' }, signal } as never)
    expect(ctx.taskRuntime.decomposeAndRun).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children: declared },
      { signal },
    )
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
    expect(result).toContain('task machinery: task_read, task_status, task_decompose, task_submit_result, task_cancel, task_verify, capability_list')
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

  it('renders the provider verdict of every declared skill under its capability row', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.listCapabilities.mockReturnValue(structuredClone(RENDER_TABLE))
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string

    // The pre-check runs for the calling session — the same viewpoint admission
    // would discover from — and only once.
    expect(ctx.taskRuntime.capabilityProviderReport).toHaveBeenCalledExactlyOnceWith('root-1')
    // A skill with no sidecar is guidance, and says so rather than looking like
    // a provider that failed.
    expect(result).toContain('    providers: ball-align → guidance (no sidecar; loadable guidance, not an execution provider; content: bbbbbbbbbbbb)')
    // An execution provider names the verifier that judges it and the tools it needs.
    expect(result).toContain('verify → execution-provider (verifier: command; requires: bash; content: eeeeeeeeeeee)')
    // A refused provider is not hidden: the defect code and its reason are shown.
    expect(result).toContain('workload-tests → invalid (content-mismatch: SKILL.md is not the declared content)')
    // A row that grants no skill says that too, instead of rendering nothing.
    expect(result).toContain('    providers: (none — the capability grants no skill)')
    // The roots the verdicts were discovered from travel with them.
    expect(result).toContain('skill roots searched for this session: /env/.agents/skills, /dsh-home/skills')
    // The row lines themselves are unchanged by the addition.
    expect(result).toContain('- design-ball — tools: [filesystem → read, write, edit; bash → bash] skills: [ball-align]')
  })

  it('says the providers were not checked when the tool has no calling session to check for', async () => {
    const { ctx } = fixture()
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, { signal: new AbortController().signal } as never)) as string

    expect(ctx.taskRuntime.capabilityProviderReport).not.toHaveBeenCalled()
    expect(result).toContain('providers: (not checked — the tool was called without a calling session)')
    expect(result).not.toContain('skill roots searched for this session:')
  })
})

describe('task_status', () => {
  it('renders a compact task tree for the caller graph', async () => {
    const { ctx } = fixture()
    const tool = defineTaskStatusTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(ctx.task.openStore).toHaveBeenCalledExactlyOnceWith('sg-t-root-1')
    expect(result).toContain('graph graph1 task tree (2 tasks):')
    expect(result).toContain('t-root [running] Build the feature (run: running — phase active)')
    expect(result).toContain('  t-child-1 [verified] Implement the parser (run: verified — phase submitted evidence: [ev-1] review: verified)')
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

  it('renders each run\'s coordination phase, and needs-recovery for a run with no phase', async () => {
    const { ctx } = fixture()
    ctx.task.openStore.mockResolvedValue({
      ...snapshot,
      tasks: [rootTask, { ...childTask, status: 'running' }],
      runs: [
        // An old record: running, no phase. It is reported as what it is, not as active.
        { ...rootRun, executionPhase: undefined },
        { ...childRun, status: 'running', executionPhase: 'submitted' },
      ],
    })
    const result = (await defineTaskStatusTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(result).toContain('t-root [running] Build the feature (run: running — needs-recovery (old record without a coordination phase))')
    expect(result).toContain('  t-child-1 [running] Implement the parser (run: running — phase submitted')
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

  /**
   * The version a run executed against, next to the run ids the reviews already
   * cite (S1-C item 4): the pack reports the record — registry revision,
   * providers with their short content digests, the mounted servers and the
   * snapshot path — without re-reading the snapshot, which is the job of the
   * entries that act on it. A run that carries no binding contributes no line.
   */
  it('names what each run of the task was bound to, and nothing for a run without a binding', async () => {
    const { ctx } = fixture()
    const bound = {
      ...nestedSnapshot(),
      runs: [
        {
          ...rootRun,
          status: 'verified',
          providerBinding: {
            registryRevision: 'a'.repeat(64),
            capabilities: ['design-ball', 'research'],
            skills: [{
              name: 'ball-align',
              role: 'knowledge',
              capabilities: ['design-ball'],
              description: 'Align a Ball',
              contractDigest: 'b'.repeat(64),
              contentDigest: 'c'.repeat(64),
              uncovered: [],
            }],
            mcpServers: [{ serverName: 'bbdev', templateDigest: 'd'.repeat(64) }],
            snapshotRoot: '/dsh/singularity/run-bindings/sg-t-root-1/r-root/skills',
          },
        },
        { ...childRun, status: 'failed' },
      ],
    }
    ctx.task.openStore.mockResolvedValue(bound)
    const tool = defineTaskReviewPackTool(ctx as never)

    const rootPack = (await tool.execute({ taskId: 't-root' }, exec('root-1'))) as string
    expect(rootPack).toContain(
      `- run r-root [verified] bound registry ${'a'.repeat(12)}: ball-align [knowledge] content ${'c'.repeat(12)} contract ${'b'.repeat(12)}; mcp bbdev; snapshot /dsh/singularity/run-bindings/sg-t-root-1/r-root/skills`,
    )

    // The child's run carries no binding: its review line and the pack around it
    // are exactly what they were before the field existed.
    const childPack = (await tool.execute({ taskId: 't-child-1' }, exec('root-1'))) as string
    expect(childPack).not.toContain('bound registry')
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

  it('shows the deciding judge and its version on the criterion line', async () => {
    const { ctx } = fixture()
    const full = nestedSnapshot()
    const target = full.reviews.find(item => item.taskId === 't-child-1')!
    Object.assign(target, {
      criteria: [
        { criterionId: 'ac1-1', verdict: 'fail', verifierId: 'command', verifierVersion: '1', command: 'pnpm test', exitCode: 1 },
        { criterionId: 'ac1-2', verdict: 'inconclusive', verifierId: 'review' },
        { criterionId: 'ac1-3', verdict: 'pass' },
      ],
    })
    ctx.task.openStore.mockResolvedValue(full)
    const tool = defineTaskReviewPackTool(ctx as never)
    const pack = (await tool.execute({ taskId: 't-child-1' }, exec('root-1'))) as string

    expect(pack).toContain('criterion ac1-1: fail [command@1] exit 1 — $ pnpm test')
    expect(pack).toContain('criterion ac1-2: inconclusive [review]')
    // a record written before the judge was recorded renders exactly as before
    expect(pack).toContain('criterion ac1-3: pass')
    expect(pack).not.toContain('criterion ac1-3: pass [')
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
    expect(status).toContain('t-child-1 [verified] Implement the parser (run: verified — phase submitted evidence: [ev-1] review: verified diag: 1)')
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

describe('task_submit_result', () => {
  const submission = { summary: 'the parser passes the fixtures', evidenceRefs: ['ev-1'], notes: 'nothing left open' }

  it('passes the submission and the call registration id to the runtime, and renders the verdict', async () => {
    const { ctx } = fixture()
    const submitResult = vi.fn(async () => ({ status: 'verified', detail: 'run "r-worker" submitted and verified.' }))
    ctx.taskRuntime.submitResult = submitResult as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    const result = (await tool.execute(submission, {
      agent: { id: 's-worker' },
      signal: new AbortController().signal,
      callId: 'call-7',
    } as never)) as string

    // The call id is what keeps the drain from waiting for the call that asked
    // for it (A3 §3.3), so it has to travel with the submission.
    expect(submitResult).toHaveBeenCalledExactlyOnceWith('s-worker', submission, { callId: 'call-7' })
    expect(result).toBe('task_submit_result verified: run "r-worker" submitted and verified.')
  })

  it('sends no callId key when the caller is not a registered tool call', async () => {
    const { ctx } = fixture()
    const submitResult = vi.fn(async () => ({ status: 'verified', detail: 'ok' }))
    ctx.taskRuntime.submitResult = submitResult as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    await tool.execute({ summary: 'done' }, exec('s-worker'))

    expect(Object.keys(submitResult.mock.calls[0]![2] as Record<string, unknown>)).toEqual([])
  })

  it('requires a non-empty summary on the model-facing schema', () => {
    const tool = defineTaskSubmitResultTool(fixture().ctx as never)
    const parameters = tool.parameters as {
      properties: Record<string, { type: unknown; required?: boolean; items?: { type: unknown } }>
    }
    expect(parameters.properties.summary?.type).toBe('string')
    expect((tool.parameters as { required?: string[] }).required).toEqual(['summary'])
    expect(parameters.properties.evidenceRefs?.type).toBe('array')
    expect(parameters.properties.evidenceRefs?.items?.type).toBe('string')
    expect(parameters.properties.notes?.type).toBe('string')
    // The description is the model-facing half of the protocol: the submission
    // is the action that ends the run, and idle is not a substitute for it.
    expect(tool.description).toContain('An idle session is not a completion')
    expect(tool.description).toContain('verifier')
  })

  it('answers a late or repeated submission with the runtime\'s own conclusion, not an error', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.submitResult = vi.fn(async () => ({
      status: 'submitted',
      detail: 'run "r-worker" already submitted: the parser passes at 2026-09-16T00:03:00.000Z. A second submission changes nothing.',
    })) as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    const result = (await tool.execute(submission, exec('s-worker'))) as string

    expect(result).toContain('task_submit_result submitted:')
    expect(result).toContain('already submitted')
    expect(result).toContain('changes nothing')
    expect(result).not.toContain('rejected')
  })

  it('returns the protocol refusal as text instead of throwing', async () => {
    const { ctx } = fixture()
    ctx.taskRuntime.submitResult = vi.fn(async () => {
      throw new Error('task-runtime: run "r-worker" is waiting on its child batch (b-t-worker); a parent cannot submit while its children are still running')
    }) as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    const result = (await tool.execute(submission, exec('s-worker'))) as string

    expect(result).toContain('task_submit_result rejected:')
    expect(result).toContain('waiting on its child batch')
  })
})

describe('task_cancel', () => {
  function waitingRun() {
    const { ctx } = fixture()
    ctx.taskRuntime.runForSession.mockImplementation(async () => ({
      storeId: 'sg-t-root-1',
      task: workerTask,
      run: { ...workerRun, executionPhase: 'waiting_children', batchId: 'b-t-worker' },
    }) as never)
    return { ctx }
  }

  it('cancels the batch this run waits on and reports the settlement', async () => {
    const { ctx } = waitingRun()
    const cancelBatch = vi.fn(async () => [
      { taskId: 't-child-1', runId: 'r-child-1', status: 'cancelled' },
      { taskId: 't-child-2', status: 'blocked' },
    ])
    ctx.taskRuntime.cancelBatch = cancelBatch as never
    const tool = defineTaskCancelTool(ctx as never)
    const result = (await tool.execute({ reason: 'the plan changed' }, exec('s-worker'))) as string

    expect(cancelBatch).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'b-t-worker', 's-worker')
    expect(result).toContain('cancelled batch b-t-worker (the plan changed):')
    expect(result).toContain('- t-child-1: cancelled run r-child-1')
    expect(result).toContain('- t-child-2: blocked')
  })

  it('says there is no batch in flight and changes nothing when the run holds none', async () => {
    const { ctx } = fixture()
    const cancelBatch = vi.fn()
    ctx.taskRuntime.cancelBatch = cancelBatch as never
    const tool = defineTaskCancelTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(result).toContain('no batch is in flight for run "r-worker"')
    expect(result).toContain('phase active')
    expect(result).toContain('nothing was changed')
    expect(cancelBatch).not.toHaveBeenCalled()
  })

  it('returns the runtime refusal as text instead of throwing', async () => {
    const { ctx } = waitingRun()
    ctx.taskRuntime.cancelBatch = vi.fn(async () => {
      throw new Error('task-runtime: batch "b-t-worker" is not being driven by this process')
    }) as never
    const tool = defineTaskCancelTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(result).toContain('task_cancel rejected:')
    expect(result).toContain('not being driven by this process')
  })

  it('declares the reason as an optional parameter', () => {
    const tool = defineTaskCancelTool(fixture().ctx as never)
    const parameters = tool.parameters as { properties: Record<string, { type: unknown }>; required?: string[] }
    expect(parameters.properties.reason?.type).toBe('string')
    expect(parameters.required ?? []).not.toContain('reason')
  })
})

describe('missing agent identity', () => {
  it.each([
    ['task_read', () => defineTaskReadTool(fixture().ctx as never), {}],
    ['task_status', () => defineTaskStatusTool(fixture().ctx as never), {}],
    ['task_submit_result', () => defineTaskSubmitResultTool(fixture().ctx as never), { summary: 'done' }],
    ['task_cancel', () => defineTaskCancelTool(fixture().ctx as never), {}],
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
