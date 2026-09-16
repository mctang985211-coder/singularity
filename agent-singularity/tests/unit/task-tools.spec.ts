import { describe, expect, it, vi } from 'vitest'
import { defineTaskDecomposeTool } from '../../src/tools/task-decompose.ts'
import { defineTaskReadTool } from '../../src/tools/task-read.ts'
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
    },
    taskRuntime: {
      runForSession: vi.fn(async (sessionId: string) => ({
        storeId: 'sg-t-root-1',
        task: sessionId === 'root-1' ? rootTask : workerTask,
        run: sessionId === 'root-1' ? rootRun : workerRun,
      })),
      decomposeAndRun: vi.fn(),
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

describe('task_status', () => {
  it('renders a compact task tree for the caller graph', async () => {
    const { ctx } = fixture()
    const tool = defineTaskStatusTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(ctx.task.openStore).toHaveBeenCalledExactlyOnceWith('sg-t-root-1')
    expect(result).toContain('graph graph1 task tree (2 tasks):')
    expect(result).toContain('t-root [running] Build the feature (run: running)')
    expect(result).toContain('  t-child-1 [verified] Implement the parser (run: verified evidence: [ev-1])')
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
    expect(verifyRun).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'r-worker', { cwd: '/envs/project1' })
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
    expect(verifyRun).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'r-worker', {})
    expect(ctx.task.markRunStatusIn).not.toHaveBeenCalled()
    expect(result).toContain('self-check, status unchanged')
  })

  it('fails loudly when the verifier service is not loaded', async () => {
    const { ctx } = fixture()
    const tool = defineTaskVerifyTool(ctx as never)
    await expect(tool.execute({}, exec('s-worker'))).rejects.toThrow('verifier service is not loaded')
  })
})
