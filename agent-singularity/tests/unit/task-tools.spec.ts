import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_CAPABILITIES, WorkspaceBusyError } from '../../../task-runtime/src/index.ts'
import { graphRegistry, mountContextReadCore, sessionQueryReads } from '../../../tests/support/context-plane.ts'
import { defineCapabilityListTool } from '../../src/tools/capability-list.ts'
import { defineTaskDecomposeTool } from '../../src/tools/task-decompose.ts'
import { defineTaskAnswerTool } from '../../src/tools/task-answer.ts'
import { defineTaskAskParentTool } from '../../src/tools/task-ask-parent.ts'
import { defineTaskCancelTool } from '../../src/tools/task-cancel.ts'
import { defineTaskDiagnoseTool } from '../../src/tools/task-diagnose.ts'
import { defineTaskIntakeTool } from '../../src/tools/task-intake.ts'
import { defineTaskReadTool } from '../../src/tools/task-read.ts'
import { defineTaskReviewPackTool } from '../../src/tools/task-review-pack.ts'
import { defineTaskStatusTool } from '../../src/tools/task-status.ts'
import { defineTaskSubmitResultTool } from '../../src/tools/task-submit-result.ts'
import { defineTaskVerifyTool } from '../../src/tools/task-verify.ts'

const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }

const rootTask = {
  taskId: 't-root',
  definitionRef: { taskType: 'root', version: 1 },
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
  definitionRef: { taskType: 'subtask', version: 1 },
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
  tasks: [rootTask, childTask, workerTask],
  runs: [rootRun, childRun, workerRun],
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

/** The store one read runs against, with the patches a spec applies to it. */
interface StoreFixture {
  /** The snapshot every read of this fixture resolves through. */
  snapshot: typeof snapshot
  /** Replace one task record, the way the store's own protocol would have written it. */
  patchTask(taskId: string, patch: Record<string, unknown>): void
  /** Replace one run record. */
  patchRun(runId: string, patch: Record<string, unknown>): void
}

/**
 * The read plane every tool case runs against (A2): the real `singularityContext`
 * mounted over a store whose records a spec patches, the graph registry facts the
 * caller resolution reads, and the runtime's read-only observation surface. The
 * tools are adapters over that service, so what a case asserts is the deployment's
 * own read path — one store, one rendering — and never a fixture's copy of it.
 */
async function fixture(options: { storeError?: Error; sessions?: Map<string, SessionEvent[]> } = {}) {
  const services: Record<string, unknown> = {}
  // A real cordis context, so the read core is mounted through the deployment's
  // own plugin entry (`[Service.init]` registers the assembly listener) and the
  // tools resolve their services the way a loaded deployment does.
  const context = new Context()
  const store: StoreFixture = {
    snapshot: structuredClone(snapshot),
    patchTask(taskId, patch) {
      store.snapshot.tasks = store.snapshot.tasks.map(task => (task.taskId === taskId ? { ...task, ...patch } : task))
    },
    patchRun(runId, patch) {
      store.snapshot.runs = store.snapshot.runs.map(run => (run.runId === runId ? { ...run, ...patch } : run))
    },
  }
  const sessions = options.sessions ?? new Map<string, SessionEvent[]>()
  const ctx: Record<string, unknown> = {
    graphs: graphRegistry({
      graphForSession: async () => ({
        id: graph.id,
        name: graph.name,
        envId: graph.envId,
        rootSessionId: graph.rootSessionId,
        graphStoreId: 'sg-g-root',
        layoutStoreId: 'sg-l-root',
      }),
      members: () => ['root-1', 's-child', 's-worker'],
    }),
    task: {
      openStore: vi.fn(async (_storeId: string) => {
        if (options.storeError !== undefined) throw options.storeError
        return store.snapshot
      }),
      snapshotIn: vi.fn(async (_storeId: string) => store.snapshot),
      markRunStatusIn: vi.fn(async () => {}),
      recordDiagnosisIn: vi.fn(async () => {}),
    },
    taskRuntime: {
      // The read-only surface the read core is allowed to use...
      recoveryStatus: vi.fn(async (_storeId: string) => ({ status: 'ready' })),
      readRunBinding: vi.fn(async (_binding: unknown) => undefined),
      allowsRuntimeDecomposition: () => true,
      gate: { phaseOf: (_sessionId: string) => undefined },
      // ...and the execution entries the other tools of this spec drive.
      runForSession: vi.fn(async (sessionId: string) => ({
        storeId: 'sg-t-root-1',
        task: sessionId === 'root-1' ? rootTask : sessionId === 's-child' ? childTask : workerTask,
        run: sessionId === 'root-1' ? rootRun : sessionId === 's-child' ? childRun : workerRun,
      })),
      intakeRootContract: vi.fn(),
      submitDecompositionProposal: vi.fn(),
      continueProposal: vi.fn(),
      proposalIn: vi.fn(),
      cancelProposal: vi.fn(),
      listCapabilities: vi.fn(() => structuredClone(DEFAULT_CAPABILITIES)),
      capabilityProviderReport: vi.fn(async (_sessionId: string) => providerReport()),
      verifyTimeoutMs: 1234,
    },
    sessionQuery: sessionQueryReads(sessionId => sessions.get(String(sessionId))),
    get: (name: string) => services[name],
  }
  for (const [name, value] of Object.entries(ctx)) {
    if (name === 'get') continue
    context.provide(name, value as never)
  }
  // A service a spec injects later (a verifier, an env builder) lands on the
  // context the same way the loader would provide it.
  for (const name of ['verifier', 'envBuilder', 'sessions', 'jobs', 'approval', 'userQuestions']) {
    Object.defineProperty(ctx, name, {
      get: () => services[name],
      set: (value: unknown) => { services[name] = value; context.provide(name, value as never) },
      enumerable: true,
    })
  }
  // The read core and its assembly, mounted where the deployment's bundle mounts
  // them; the tools below are its adapters, and they read it off the context they
  // are defined with.
  const service = await mountContextReadCore(context)
  Object.assign(ctx, { singularityContext: service })
  return { ctx, context, services, store, sessions }
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as never
}

describe('task_read', () => {
  it('returns the root task contract and child statuses for the root session', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(ctx.task.openStore).toHaveBeenCalledExactlyOnceWith('sg-t-root-1')
    expect(result).toContain('store sg-t-root-1 of graph "graph1"')
    expect(result).toContain('task t-root [running/decomposed] depth 0')
    expect(result).toContain('objective: Build the feature')
    expect(result).toContain('- root-children-verified [composite, mandatory] all mandatory children verified')
    // Each child of the root view is one line: its own status, its latest run
    // with the phase the store recorded, and the evidence and review it holds.
    expect(result).toContain('- t-child-1 [verified] Implement the parser (run: verified — phase submitted evidence: [ev-1] review: verified)')
  })

  it('returns the own task and run for a worker session', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    // The caller is resolved from the store's own run record, never from the
    // runtime's lookup (A2): the read door does not reconcile, and the resolution
    // is the one store read the answer rests on.
    expect(ctx.taskRuntime.runForSession).not.toHaveBeenCalled()
    expect(ctx.task.openStore).toHaveBeenCalledExactlyOnceWith('sg-t-root-1')
    expect(result).toContain('task t-worker [running/leaf] depth 1')
    expect(result).toContain('objective: Implement the parser')
    expect(result).toContain('- ac1-1 [deterministic, mandatory] parses the fixtures — $ pnpm test')
    expect(result).toContain('run r-worker [running]')
  })

  it('renders the stored contract assumptions and constraints when the task has a contract', async () => {
    const { ctx, store } = await fixture()
    store.patchTask('t-worker', {
      contract: {
        contractVersion: 1,
        objective: workerTask.objective,
        acceptanceCriteria: workerTask.acceptanceCriteria,
        assumptions: ['the fixtures are checked in'],
        constraints: ['no network access'],
        requiredCapabilities: [],
      },
    })
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(result).toContain('assumptions:\n- the fixtures are checked in')
    expect(result).toContain('constraints:\n- no network access')
  })

  it('renders a worker task without a contract exactly as before, inventing nothing', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(result).not.toContain('assumptions:')
    expect(result).not.toContain('constraints:')
  })

  it('renders the declared protected inputs on a worker criterion line', async () => {
    const { ctx, store } = await fixture()
    store.patchTask('t-worker', {
      acceptanceCriteria: [
        {
          ...workerTask.acceptanceCriteria[0]!,
          protectedInputs: [
            { path: 'tests/check.sh', sha256: 'a'.repeat(64) },
            { path: 'thresholds.json', sha256: 'b'.repeat(64) },
          ],
        },
      ],
    })
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(result).toContain(
      '- ac1-1 [deterministic, mandatory] parses the fixtures — $ pnpm test [protected inputs: tests/check.sh, thresholds.json]',
    )
  })

  it('renders no protected-input suffix for a criterion that declares none', async () => {
    const { ctx } = await fixture()
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

  async function boundWorkerFixture(read: unknown) {
    const h = await fixture()
    h.store.patchRun('r-worker', { providerBinding: workerBinding })
    h.ctx.taskRuntime.readRunBinding = vi.fn(async () => read) as never
    return h
  }

  it('renders the providers this run was bound to, and re-checks them against the record', async () => {
    const { ctx } = await boundWorkerFixture({
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
    const { ctx } = await boundWorkerFixture({
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
    const { ctx } = await fixture()
    ctx.taskRuntime.readRunBinding = vi.fn() as never
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(ctx.taskRuntime.readRunBinding).not.toHaveBeenCalled()
    expect(result).not.toContain('bound')
    expect(result).not.toContain('not readable')
  })

  it('renders the declared protected inputs on the root line too', async () => {
    const { ctx, store } = await fixture()
    store.patchTask('t-root', {
      acceptanceCriteria: [
        { ...rootTask.acceptanceCriteria[0]!, protectedInputs: [{ path: 'tests/check.sh', sha256: 'a'.repeat(64) }] },
      ],
    })
    const tool = defineTaskReadTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(result).toContain(
      '- root-children-verified [composite, mandatory] all mandatory children verified [protected inputs: tests/check.sh]',
    )
  })

  /**
   * The coordination phase (A3 §3.8): where the caller's own run stands in the
   * protocol, and what an old record looks like — a reader is never told
   * `active` about a run nobody can admit work for.
   */
  async function workerRunFixture(run: Record<string, unknown>) {
    const h = await fixture()
    h.store.patchRun('r-worker', run)
    return h
  }

  it('renders the phase of an active run, with its no-progress marking', async () => {
    const { ctx } = await workerRunFixture({
      noProgress: { kind: 'unsubmitted-idle', rounds: 2, factCount: 7, markedAt: '2026-09-16T00:02:00.000Z' },
    })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain(
      'run r-worker [running] — phase active; no-progress round 2 (unsubmitted-idle) started 2026-09-16T00:00:00.000Z',
    )
  })

  it('renders the batch a waiting run is waiting on', async () => {
    const { ctx } = await workerRunFixture({ executionPhase: 'waiting_children', batchId: 'b-r-worker-p-1' })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain('run r-worker [running] — phase waiting_children; batch b-r-worker-p-1 started')
  })

  it('names no batch on a run that got its execution back, however many batches it ended', async () => {
    // K1 §2: `run.batchId` is the *current unfinished* batch. A run that returned
    // to `active` after a batch end shows the phase it is in and no batch id, even
    // though its own record still accumulates the batches it admitted — the history
    // stays the run record's own fact, read by reference (`context_read`), never a
    // guess this line makes.
    const { ctx } = await workerRunFixture({
      executionPhase: 'active',
      batches: [{ batchId: 'b-r-worker-p-1', proposalId: 'p-1', memberTaskIds: ['t-child-1'] }],
    })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain('run r-worker [running] — phase active started')
    expect(result).not.toContain('batch b-r-worker-p-1')
  })

  it('renders what a submitted run handed in, with the evidence it named', async () => {
    const { ctx } = await workerRunFixture({
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
    const { ctx } = await workerRunFixture({ executionPhase: undefined })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain('needs-recovery (an old record: it was created before coordination phases')
    expect(result).toContain('cancel this task tree to recover')
    expect(result).not.toContain('phase active')
  })

  it('adds no phase to a terminal run that predates the field', async () => {
    const { ctx } = await workerRunFixture({ executionPhase: undefined, status: 'verified' })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string
    expect(result).toContain('run r-worker [verified] started 2026-09-16T00:00:00.000Z')
    expect(result).not.toContain('needs-recovery')
    expect(result).not.toContain('phase ')
  })

  it('renders each child run line of the root view with its own phase', async () => {
    const { ctx, store } = await fixture()
    store.patchTask('t-child-1', { status: 'running' })
    store.patchRun('r-child-1', { status: 'running', executionPhase: 'waiting_children', batchId: 'b-r-child-1-p-1' })
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('root-1'))) as string
    // The child's own line carries the phase its run is in, and the batch id it
    // waits on is the run record's own fact (read by reference, `context_read`):
    // a summary line carries the phase and the status, not the whole record.
    expect(result).toContain('- t-child-1 [running] Implement the parser (run: running — phase waiting_children')
    // The root's own line is still its own run's: the child's phase is the
    // child's, and one line never borrows another run's phase.
    expect(result).toMatch(/run r-root \[running\] — phase active/)
    expect((store.snapshot.runs.find(run => run.runId === 'r-child-1'))?.batchId).toBe('b-r-child-1-p-1')
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

  /** The submission the runtime would record, as the service reports it back. */
  function submission(overrides: Record<string, unknown> = {}) {
    return { proposalId: 'p-1', status: 'ready' as const, policy: 'off' as const, existing: false, detail: 'recorded', ...overrides }
  }

  it('proposes the batch and continues it, rendering the admitted children', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1', 't-child-2'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, { agent: { id: 'root-1' }, signal } as never)) as string

    // The tool composes the runtime's two entries — the submission carries the
    // caller's own key options, the continuation is what admits the batch.
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children },
      { exec: { signal } },
    )
    expect(ctx.taskRuntime.continueProposal).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-1', 'root-1', {})
    // The tool returns at admission (A3 §3.1) and says so: it reports the batch
    // that was admitted, not outcomes nobody has produced yet.
    expect(result).toContain('decomposed t-root into 2 children (batch b-r-root-p-1):')
    expect(result).toContain('- child 1: t-child-1')
    expect(result).toContain('- child 2: t-child-2')
    expect(result).toContain('does not wait for the batch')
  })

  it('states the contract the caller is under while the batch runs', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    // The model-visible behaviour contract (§3.8, K1 §2): the batch id, the phase
    // the caller is now in, what is still allowed, and that the batch end hands
    // execution back without submitting anything — everything the caller needs to
    // not write into the children's checkout and to know the submission is its own.
    expect(result).toContain('The runtime owns batch b-r-root-p-1 now')
    expect(result).toContain('You are in phase waiting_children')
    expect(result).toContain('`task_cancel`')
    expect(result).toContain('Writes, shell commands, another decomposition and a submission of your own are refused')
    expect(result).toContain('The batch end reaches you as a message')
    expect(result).toContain('nothing is submitted on your behalf')
    expect(result).toContain('hand this task in yourself with `task_submit_result`')
    // The replaced guidance is gone: the runtime never submits on the caller's
    // behalf, so the caller is never told to leave the submission to it.
    expect(result).not.toContain('submits this task for verification')
    expect(result).not.toContain('needs no submission from you')
  })

  it('registers the call id so the batch drain does not wait for the asking call', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', children }, { agent: { id: 'root-1' }, signal, callId: 'call-7' } as never)

    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children },
      { exec: { signal, callId: 'call-7' } },
    )
    // Only the call id rides the continuation: the submission's signal dies with
    // the submission, and a caller that aborts afterwards cannot stop a batch
    // the store already decided about.
    expect(ctx.taskRuntime.continueProposal).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-1', 'root-1', { exec: { callId: 'call-7' } })
  })

  it('returns the admission rejection as error text instead of throwing', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockRejectedValue(
      new Error('task-runtime: admission rejected decomposition of "t-root":\n- child 0 has no acceptance criteria'),
    )
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string
    expect(result).toContain('task_decompose rejected:')
    expect(result).toContain('admission rejected decomposition of "t-root"')
    expect(result).toContain('child 0 has no acceptance criteria')
    // A refused batch is refused before anything was proposed: no continuation.
    expect(ctx.taskRuntime.continueProposal).not.toHaveBeenCalled()
  })

  it('returns the runtime rejection of an unknown declared contract version as error text', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockRejectedValue(
      new Error('task-runtime: contract rejected decomposition of "t-root":\n- unknown contract version 2: this runtime writes version 1'),
    )
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute(
      { reason: 'split the work', contractVersion: 2, children },
      { agent: { id: 'root-1' }, signal } as never,
    )) as string
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', contractVersion: 2, children },
      { exec: { signal } },
    )
    expect(result).toContain('task_decompose rejected:')
    expect(result).toContain('unknown contract version 2')
  })

  it('sends no requestKey, supersedes or contractVersion key when the caller declares none', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', children }, exec('root-1'))

    // Deep equality alone also accepts a present key holding undefined, so the
    // omissions are asserted on the keys — of the spec and of the options.
    const options = ctx.taskRuntime.submitDecompositionProposal.mock.calls[0]![5] as Record<string, unknown>
    expect(Object.keys(options).sort()).toEqual(['exec'])
    expect(Object.keys(ctx.taskRuntime.submitDecompositionProposal.mock.calls[0]![4] as Record<string, unknown>).sort())
      .toEqual(['children', 'reason'])
  })

  it('lifts a declared requestKey and supersedes out of the batch into the submission options', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission({ existing: true, status: 'pending_review', policy: 'all' }))
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'pending_review',
      detail: 'proposal "p-1" is waiting for a review; only a decision on the record advances it (§6)',
    })
    ctx.taskRuntime.proposalIn.mockResolvedValue({ proposalId: 'p-1', status: 'pending_review', policy: 'all' })
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute(
      { reason: 'split the work', children, requestKey: 'rk-mine', supersedes: 'p-old' },
      exec('root-1'),
    )

    // The two keys are options of the submission, not batch fields: passing them
    // inside the spec would make the runtime refuse them as undeclared fields.
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children },
      { requestKey: 'rk-mine', supersedes: 'p-old', exec: expect.objectContaining({}) },
    )
  })

  it('declares requestKey and supersedes on the schema, and keeps the batch open for the runtime', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskDecomposeTool(ctx as never)
    const parameters = (tool.parameters as { properties: Record<string, { type: unknown; description?: string }> }).properties

    expect(parameters.requestKey?.type).toBe('string')
    expect(parameters.requestKey?.description).toContain('the runtime derives one')
    expect(parameters.requestKey?.description).toContain('new key')
    expect(parameters.supersedes?.type).toBe('string')
    expect(parameters.supersedes?.description).toContain('record is kept')
    expect(parameters.supersedes?.description).toContain('does not transfer')
  })

  it('passes declared criterion ids and child constraints through untouched', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const declared = [
      {
        objective: 'Implement the parser',
        acceptanceCriteria: [{ criterionId: 'parse-fixtures', description: 'parses the fixtures', command: 'pnpm test' }],
        constraints: ['no network access', 'write only inside the env checkout'],
      },
    ]
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', children: declared }, { agent: { id: 'root-1' }, signal } as never)
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children: declared },
      { exec: { signal } },
    )
  })

  it('declares protectedInputs on the criterion schema and passes the declared paths through untouched', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
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
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children: declared },
      { exec: { signal } },
    )
  })

  it('reports a batch waiting for its review, naming the proposal and the policy on its record', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission({ existing: false, status: 'pending_review', policy: 'all' }))
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-9',
      status: 'pending_review',
      detail: 'proposal "p-9" is waiting for a review; only a decision on the record advances it (§6)',
    })
    ctx.taskRuntime.proposalIn.mockResolvedValue({ proposalId: 'p-9', status: 'pending_review', policy: 'all' })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    // §5–§6: the caller learns that nothing ran, what holds the batch, and that
    // neither another submission nor a wait in this call is the way forward.
    expect(result).toContain('task_decompose is waiting for a review')
    expect(result).toContain('p-9')
    expect(result).toContain('policy all')
    expect(ctx.taskRuntime.proposalIn).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-9')
    expect(result).toContain('has not been decomposed')
    expect(result).toContain('no worker was spawned')
    expect(result).toContain('`task_proposal_read`')
    expect(result).toContain('the runtime continues the batch')
    expect(result).toContain('a revision is new content')
    expect(result).toContain('Do not re-submit the same content while it waits')
    // A waiting batch is not an error: the answer is the guidance, not a refusal.
    expect(result).not.toContain('task_decompose rejected')
  })

  it('names the policy the proposal was born under, read from the record', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission({ status: 'pending_review', policy: 'off' }))
    ctx.taskRuntime.continueProposal.mockResolvedValue({ proposalId: 'p-9', status: 'pending_review', detail: 'waiting' })
    // A proposal born under `off` and tightened into review keeps its birth
    // policy on the record, and the tool reports the record, not the config.
    ctx.taskRuntime.proposalIn.mockResolvedValue({ proposalId: 'p-9', status: 'pending_review', policy: 'off' })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string
    expect(result).toContain('policy off')
  })

  it('says the policy could not be read back rather than inventing one', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission({ status: 'pending_review', policy: 'all' }))
    ctx.taskRuntime.continueProposal.mockResolvedValue({ proposalId: 'p-9', status: 'pending_review', detail: 'waiting' })
    ctx.taskRuntime.proposalIn.mockRejectedValue(new Error('task: unknown proposal "p-9"'))
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string
    expect(result).toContain('policy unknown')
    expect(result).toContain('task_decompose is waiting for a review')
  })

  it('names a proposal that was decided against, and points at the revision route', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission({ existing: true, status: 'rejected', policy: 'all' }))
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-3',
      status: 'rejected',
      detail: 'proposal "p-3" is rejected; nothing was admitted and nothing is dispatched',
      reason: 'the owner refused this batch through the approval channel',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    expect(result).toContain('task_decompose rejected: decomposition of "t-root" is rejected (proposal p-3)')
    expect(result).toContain('the owner refused this batch through the approval channel')
    expect(result).toContain('never runs: revise it')
    expect(ctx.taskRuntime.proposalIn).not.toHaveBeenCalled()
  })

  it('asks no human itself: a refused batch reaches no approval channel', async () => {
    const { ctx } = await fixture()
    const approval = { request: vi.fn() }
    const withApproval = { ...ctx, approval }
    ctx.taskRuntime.submitDecompositionProposal.mockRejectedValue(
      new Error('task-runtime: admission rejected decomposition of "t-root":\n- child 0 declares no acceptance criteria'),
    )
    const tool = defineTaskDecomposeTool(withApproval as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    // §5: a bad batch never reaches a person. The tool takes no human decision
    // itself, and the runtime refuses the batch before a proposal exists.
    expect(result).toContain('task_decompose rejected:')
    expect(approval.request).not.toHaveBeenCalled()
    expect(ctx.taskRuntime.continueProposal).not.toHaveBeenCalled()
  })
})

describe('capability_list', () => {
  it('renders the registry with each label resolved to the tools it grants', async () => {
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string

    expect(result).toContain('worker baseline (every capability worker keeps these on top of its grants): ')
    expect(result).toContain('bash')
    expect(result).toContain('baseline labels: ')
    // The machinery line is rendered from WORKER_BASELINE_TOOLS, so it cannot drift from the grant.
    // The machinery line is rendered from WORKER_BASELINE_TOOLS, so it cannot
    // drift from the grant — and the raw cross-session readers are not part of it
    // (A2): `context_read` is the reference reader a worker gets instead.
    expect(result).toContain(
      'task machinery: task_read, task_status, context_read, task_decompose, task_submit_result, task_cancel, task_verify, capability_list, ' +
      'task_proposal_read, task_proposal_continue, task_proposal_cancel',
    )
    expect(result).toContain('baseline labels: filesystem, bash, jobs, search, skill, ask-user;')
    expect(result).not.toContain('session-history')
    expect(result).toContain('tool grants are fail-closed: ')
    expect(result).toContain('skill grants are not exclusive: DSH has no per-agent skill hiding')
    expect(result).toContain('mcpServers grant whole MCP servers')
    expect(result).toContain('leaves the worker on the deployment default (danger-full-access)')
    expect(result).toContain('- design-chip — tools: [] skills: [chip-designer] permission: (none — the worker keeps danger-full-access)')
  })

  it('flags a label outside the vocabulary instead of resolving it silently', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.listCapabilities.mockReturnValue({ broken: { tools: ['filesystem', 'filesytem'] } })
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(result).toContain('- broken — tools: [filesystem → read, write, edit; filesytem → (unknown label)] skills: []')
  })

  it('renders the provider verdict of every declared skill under its capability row', async () => {
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, { signal: new AbortController().signal } as never)) as string

    expect(ctx.taskRuntime.capabilityProviderReport).not.toHaveBeenCalled()
    expect(result).toContain('providers: (not checked — the tool was called without a calling session)')
    expect(result).not.toContain('skill roots searched for this session:')
  })
})

describe('task_status', () => {
  it('renders a compact task tree for the caller graph', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskStatusTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(ctx.task.openStore).toHaveBeenCalledExactlyOnceWith('sg-t-root-1')
    expect(result).toContain('graph: graph1 "graph1" — store sg-t-root-1')
    expect(result).toContain('entries in scope: 2')
    expect(result).toContain('- t-root [running] Build the feature (run: running — phase active) [you]')
    expect(result).toContain(
      '- t-child-1 [verified] Implement the parser (run: verified — phase submitted evidence: [ev-1] review: verified) [direct child]',
    )
  })

  it('renders the localized cause of a failed review', async () => {
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
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
    expect(result).toContain(
      '- t-root [running] Build the feature (run: running — needs-recovery (old record without a coordination phase))',
    )
    expect(result).toContain('- t-child-1 [running] Implement the parser (run: running — phase submitted')
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
    const { ctx, services } = await fixture()
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
    const { ctx, services } = await fixture()
    const verifyRun = vi.fn(async () => bundle)
    services['verifier'] = { verifyRun }
    const tool = defineTaskVerifyTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(verifyRun).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'r-worker', { timeoutMs: 1234 })
    expect(ctx.task.markRunStatusIn).not.toHaveBeenCalled()
    expect(result).toContain('self-check, status unchanged')
  })

  it('refuses to run the verifier without a deadline when the runtime exposes no positive timeout', async () => {
    const { ctx, services } = await fixture()
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
    const { ctx, services } = await fixture()
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
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
    ctx.task.openStore.mockResolvedValue(nestedSnapshot())
    const tool = defineTaskReviewPackTool(ctx as never)

    const rootPack = (await tool.execute({ taskId: 't-root', runId: 'r-root' }, exec('root-1'))) as string
    expect(rootPack).toContain('review pack for task t-root [verified] depth 0')
    expect(rootPack).toContain('review t-root#r-root [verified]')
    expect(rootPack).toContain('- t-child-1 [failed]: review t-child-1#r-child-1: failed — mandatory criteria not satisfied: ac1-1 fail')
    expect(rootPack).toContain('- t-child-2 [blocked]: review t-child-2#no-run: blocked — dependencies [t-child-1] did not verify')
    expect(rootPack).toContain('diagnoses (0)')

    const childPack = (await tool.execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec('root-1'))) as string
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

    const blockedPack = (await tool.execute({ taskId: 't-child-2', runId: null }, exec('root-1'))) as string
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
    const { ctx } = await fixture()
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

    const rootPack = (await tool.execute({ taskId: 't-root', runId: 'r-root' }, exec('root-1'))) as string
    expect(rootPack).toContain(
      `- run r-root [verified] bound registry ${'a'.repeat(12)}: ball-align [knowledge] content ${'c'.repeat(12)} contract ${'b'.repeat(12)}; mcp bbdev; snapshot /dsh/singularity/run-bindings/sg-t-root-1/r-root/skills`,
    )

    // The child's run carries no binding: its review line and the pack around it
    // are exactly what they were before the field existed.
    const childPack = (await tool.execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec('root-1'))) as string
    expect(childPack).not.toContain('bound registry')
  })

  it('renders the metrics line and each dimension fact, and nothing for the dimensions the record omits', async () => {
    const { ctx } = await fixture()
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
    const pack = (await tool.execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec('root-1'))) as string

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
    const { ctx } = await fixture()
    const tool = defineTaskReviewPackTool(ctx as never)
    await expect(tool.execute({ taskId: 'ghost', runId: 'r-ghost' }, exec('root-1'))).rejects.toThrow('unknown task "ghost"')
  })

  it('shows the deciding judge and its version on the criterion line', async () => {
    const { ctx } = await fixture()
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
    const pack = (await tool.execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec('root-1'))) as string

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
    const { ctx } = await fixture()
    const tool = defineTaskDiagnoseTool(ctx as never)
    const result = (await tool.execute(args, exec('root-1'))) as string
    expect(ctx.task.recordDiagnosisIn).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', args, 'root-1')
    expect(result).toContain('diagnosis d1 recorded for task t-child-1 [medium]')
    expect(result).toContain('cause: the fixtures never feed empty input')
    expect(result).toContain('suggestions only — none auto-executes')
    expect(result).toContain('- task_definition build:1: add an empty-input fixture to the acceptance command')
  })

  it('round-trips: a recorded diagnosis shows up in the next review pack and in task_status', async () => {
    const { ctx } = await fixture()
    const state = structuredClone(snapshot)
    ctx.task.openStore.mockImplementation(async () => state)
    ctx.task.recordDiagnosisIn.mockImplementation(async (_storeId: string, diagnosis: never) => {
      state.diagnoses.push(diagnosis)
    })
    const result = (await defineTaskDiagnoseTool(ctx as never).execute(args, exec('root-1'))) as string
    expect(result).toContain('diagnosis d1 recorded')
    const pack = (await defineTaskReviewPackTool(ctx as never).execute({ taskId: 't-child-1', runId: 'r-child-1' }, exec('root-1'))) as string
    expect(pack).toContain('diagnoses (1):')
    expect(pack).toContain('- d1 [medium] the fixtures never feed empty input')
    const status = (await defineTaskStatusTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(status).toContain('t-child-1 [verified] Implement the parser (run: verified — phase submitted evidence: [ev-1] review: verified diag: 1)')
    expect(status).not.toContain('diag: 0')
  })

  it('returns store rejections as error text instead of throwing', async () => {
    const { ctx } = await fixture()
    ctx.task.recordDiagnosisIn.mockRejectedValue(new Error('task: diagnosis "d1" already exists'))
    const tool = defineTaskDiagnoseTool(ctx as never)
    const result = (await tool.execute(args, exec('root-1'))) as string
    expect(result).toBe('task_diagnose rejected: task: diagnosis "d1" already exists')
  })

  it('records a proposal whose targetType the old vocabulary never held, and refuses an empty one', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskDiagnoseTool(ctx as never)
    // The diagnosis does not freeze a target-type vocabulary (A5): a suggestion
    // that names a surface this build has no executor for is a recorded
    // suggestion, and whether anything can execute it is decided where it would
    // be executed (evolution_propose/fromDiagnosis), not here.
    const recorded = (await tool.execute(
      { ...args, proposals: [{ targetType: 'prompt_template', targetId: 'reviewer', rationale: 'name the empty-input case' }] },
      exec('root-1'),
    )) as string
    expect(recorded).toContain('- prompt_template reviewer: name the empty-input case')
    expect(ctx.task.recordDiagnosisIn).toHaveBeenCalledOnce()

    ctx.task.recordDiagnosisIn.mockClear()
    const rejected = (await tool.execute(
      { ...args, proposals: [{ targetType: '  ', targetId: 'x', rationale: 'y' }] },
      exec('root-1'),
    ).catch((error: Error) => String(error))) as string
    expect(rejected).toContain('targetType')
    expect(ctx.task.recordDiagnosisIn).not.toHaveBeenCalled()
  })

  it('names the observedFailure slot the postmortem observation, in the schema and in the description', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskDiagnoseTool(ctx as never)
    const parameters = (tool.parameters as {
      properties: Record<string, { type?: unknown; description?: string; items?: { properties?: Record<string, Record<string, unknown>> } }>
    }).properties

    expect(tool.description).toContain('postmortem observation')
    expect(parameters.observedFailure?.description).toContain('postmortem observation')
    // The proposal target type is an open string on the model-facing schema: no
    // enum, because the vocabulary is not this tool's to freeze (A5).
    expect(parameters.proposals?.items?.properties?.targetType).toMatchObject({ type: 'string' })
    expect(parameters.proposals?.items?.properties?.targetType).not.toHaveProperty('enum')
  })

  it('rejects a proposals payload that is not an array of proposal objects and persists nothing', async () => {
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
    const submitResult = vi.fn(async () => ({ status: 'verified', detail: 'ok' }))
    ctx.taskRuntime.submitResult = submitResult as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    await tool.execute({ summary: 'done' }, exec('s-worker'))

    expect(Object.keys(submitResult.mock.calls[0]![2] as Record<string, unknown>)).toEqual([])
  })

  it('requires a non-empty summary on the model-facing schema', async () => {
    const tool = defineTaskSubmitResultTool((await fixture()).ctx as never)
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
    const { ctx } = await fixture()
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
    const { ctx } = await fixture()
    ctx.taskRuntime.submitResult = vi.fn(async () => {
      throw new Error('task-runtime: run "r-worker" is waiting on its child batch (b-r-worker-p-1); a parent cannot submit while its children are still running')
    }) as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    const result = (await tool.execute(submission, exec('s-worker'))) as string

    expect(result).toContain('task_submit_result rejected:')
    expect(result).toContain('waiting on its child batch')
  })
})

describe('task_cancel', () => {
  async function waitingRun() {
    const { ctx } = await fixture()
    ctx.taskRuntime.runForSession.mockImplementation(async () => ({
      storeId: 'sg-t-root-1',
      task: workerTask,
      run: { ...workerRun, executionPhase: 'waiting_children', batchId: 'b-r-worker-p-1' },
    }) as never)
    return { ctx }
  }

  it('cancels the batch this run waits on and reports the settlement', async () => {
    const { ctx } = await waitingRun()
    const cancelBatch = vi.fn(async () => [
      { taskId: 't-child-1', runId: 'r-child-1', status: 'cancelled' },
      { taskId: 't-child-2', status: 'blocked' },
    ])
    ctx.taskRuntime.cancelBatch = cancelBatch as never
    const tool = defineTaskCancelTool(ctx as never)
    const result = (await tool.execute({ reason: 'the plan changed' }, exec('s-worker'))) as string

    expect(cancelBatch).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'b-r-worker-p-1', 's-worker')
    expect(result).toContain('cancelled batch b-r-worker-p-1 (the plan changed):')
    expect(result).toContain('- t-child-1: cancelled run r-child-1')
    expect(result).toContain('- t-child-2: blocked')
  })

  it('says there is no batch in flight and changes nothing when the run holds none', async () => {
    const { ctx } = await fixture()
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
    const { ctx } = await waitingRun()
    ctx.taskRuntime.cancelBatch = vi.fn(async () => {
      throw new Error('task-runtime: batch "b-r-worker-p-1" is not being driven by this process')
    }) as never
    const tool = defineTaskCancelTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(result).toContain('task_cancel rejected:')
    expect(result).toContain('not being driven by this process')
  })

  it('declares the reason as an optional parameter', async () => {
    const tool = defineTaskCancelTool((await fixture()).ctx as never)
    const parameters = tool.parameters as { properties: Record<string, { type: unknown }>; required?: string[] }
    expect(parameters.properties.reason?.type).toBe('string')
    expect(parameters.required ?? []).not.toContain('reason')
  })
})

describe('missing agent identity', () => {
  it.each([
    ['task_read', async () => defineTaskReadTool((await fixture()).ctx as never), {}],
    ['task_status', async () => defineTaskStatusTool((await fixture()).ctx as never), {}],
    ['task_intake', async () => defineTaskIntakeTool((await fixture()).ctx as never), { objective: 'ship it', acceptanceCriteria: [] }],
    ['task_submit_result', async () => defineTaskSubmitResultTool((await fixture()).ctx as never), { summary: 'done' }],
    ['task_cancel', async () => defineTaskCancelTool((await fixture()).ctx as never), {}],
    ['task_verify', async () => defineTaskVerifyTool((await fixture()).ctx as never), {}],
    ['task_review_pack', async () => defineTaskReviewPackTool((await fixture()).ctx as never), { taskId: 't-child-1', runId: 'r-child-1' }],
    ['task_ask_parent', async () => defineTaskAskParentTool((await fixture()).ctx as never), { requestKey: 'k1', question: 'which contract holds?' }],
    ['task_answer', async () => defineTaskAnswerTool((await fixture()).ctx as never), { questionId: 'q-1', requestKey: 'a1', answer: 'this one', resolves: true }],
    ['task_diagnose', async () => defineTaskDiagnoseTool((await fixture()).ctx as never), {
      taskId: 't-child-1',
      diagnosisId: 'd1',
      observedFailure: 'f',
      scope: 's',
      localizedCause: 'c',
      confidence: 'medium',
    }],
  ])('%s rejects a call with no agent identity', async (_name, make, args) => {
    const tool = await make()
    for (const exec of [{}, { agent: { id: '' }, signal: new AbortController().signal }]) {
      await expect(tool.execute(args, exec as never)).rejects.toThrow('missing agent id')
    }
  })
})

/**
 * The root contract's two doors, from the tool side (A0 stage C): accepting one
 * (`task_intake`) and reading the session off the store while none has been
 * accepted (`task_read`/`task_status`). The tool normalizes nothing, judges
 * nothing and activates nothing — every rule stays in the runtime — so what it
 * owes the caller is a closed schema, the caller's own identity checked before
 * any service call, and three answers rendered as they are: activated, waiting
 * for a review, or refused by name.
 */
describe('task_intake', () => {
  const rootContract = {
    objective: 'Ship the release artifact',
    acceptanceCriteria: [
      { description: 'the release artifact exists and is published', command: 'make release', mode: 'deterministic', mandatory: true },
    ],
    assumptions: ['the checkout is on the release branch'],
    constraints: ['no network access'],
    requiredCapabilities: ['design-ball'],
    requestKey: 'rk-intake-1',
  }

  function rootExec(sessionId = 'root-1') {
    return exec(sessionId) as unknown as { agent: { id: string }; signal: AbortSignal }
  }

  it('declares a closed criterion object and no parameter that could approve anything', () => {
    const tool = defineTaskIntakeTool(fixture().ctx as never)
    const parameters = tool.parameters as {
      properties: Record<string, { items?: { additionalProperties?: boolean; properties?: Record<string, { enum?: readonly string[] }> } }>
      required?: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual([
      'acceptanceCriteria',
      'assumptions',
      'constraints',
      'contractVersion',
      'objective',
      'requestKey',
      'requiredCapabilities',
      'supersedes',
    ])
    expect(parameters.required).toEqual(['objective', 'acceptanceCriteria'])
    // The review is the only thing that moves a contract, so no parameter, and
    // nothing the prompt/schema says about one, may read as a way to approve.
    expect(Object.keys(parameters.properties).some(name => /approv|decid|review|force/i.test(name))).toBe(false)

    const criteria = parameters.properties.acceptanceCriteria!.items!
    expect(criteria.additionalProperties).toBe(false)
    expect(Object.keys(criteria.properties!).sort()).toEqual([
      'acceptsArtifact',
      'command',
      'criterionId',
      'description',
      'heuristic',
      'mandatory',
      'mode',
      'protectedInputs',
      'requiredEvidence',
      'requiresArtifact',
      'verifierRef',
    ])
    expect(criteria.properties!.mode!.enum).toEqual([
      'deterministic', 'simulation', 'formal', 'measurement', 'review', 'composite',
    ])
    // The one field of a decomposition criterion this tool does not declare: a
    // childEvidence map names positions in a batch, and a root contract is
    // submitted before any batch exists. The runtime would accept the key; the
    // schema refuses it instead of letting a model declare a map nothing can
    // ever judge.
    expect(Object.keys(criteria.properties!)).not.toContain('childEvidence')
  })

  it('accepts the contract through the runtime and renders the activated root', async () => {
    const { ctx } = await fixture()
    const intake = vi.fn(async () => ({
      status: 'activated',
      proposalId: 'p-root-1',
      taskId: 't-root-new',
      runId: 'r-root-new',
      detail: 'store "sg-t-root-1" activated root task "t-root-new" with run "r-root-new"',
    }))
    ctx.taskRuntime.intakeRootContract = intake as never
    const call = rootExec()
    const { requestKey, ...spec } = rootContract
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, call as never)) as string

    expect(intake).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'root-1', spec, {
      requestKey,
      exec: { signal: call.signal },
    })
    expect(result).toContain('task_intake activated the root contract of session "root-1": root task t-root-new, root run r-root-new (proposal p-root-1)')
    expect(result).toContain('task_read')
    expect(result).toContain('task_decompose')
  })

  it('renders a contract waiting for review as a proposal id, with no root task and nothing spawned', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => ({
      status: 'pending_review',
      proposalId: 'p-root-wait',
      detail: 'the review was put to the owner session "root-1" through the approval channel',
    })) as never
    ctx.taskRuntime.proposalIn = vi.fn(async () => ({ proposalId: 'p-root-wait', policy: 'all' })) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('task_intake is waiting for a review: proposal p-root-wait (policy all)')
    expect(result).toContain('no root task exists')
    expect(result).toContain('Nothing was activated and no worker was spawned')
    expect(result).toContain('`task_proposal_read`')
    expect(result).toContain('`supersedes`')
    expect(result).toContain('Do not re-submit the same content')
    expect(result).toContain('before the contract is activated')
    expect(result).not.toContain('root task t-')
  })

  it('names the runtime refusal and the root-specific rules, having written nothing', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error(
        'task-runtime: root contract rejected:\n- root contract requires at least one mandatory acceptance criterion judged by ' +
        'something other than the composite conjunction',
      )
    }) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('task_intake rejected: task-runtime: root contract rejected:')
    expect(result).toContain('at least one mandatory acceptance criterion')
    expect(result).toContain('Nothing was written')
    expect(result).toContain('new graph')
  })

  it('refuses to re-intake a store that already holds a root task, naming the terminal rule', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error(
        'task-runtime: store "sg-t-root-1" already holds root task "t-root", so a root contract cannot be intaken here',
      )
    }) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('already holds root task "t-root"')
    expect(result).toContain('terminal')
    expect(result).toContain('Nothing was written')
  })

  /**
   * The two refusal shapes, told apart by the store (stage-D defect 2). The
   * intake writes the proposal first and activates it second, and the activation
   * claims the checkout before it commits — so a refusal can leave the
   * `TaskProposalSubmitted` behind (the workspace-conflict path), and a text
   * claiming "nothing was written" there would be exactly wrong: the record is
   * what a retry is answered by, and the caller has to know it is there.
   */
  function recordedProposalFor(
    objective: string,
    criteria: readonly { description: string }[] = rootContract.acceptanceCriteria,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      kind: 'root',
      proposalId: 'p-root-recorded',
      requestKey: 'rk-intake-1',
      status: 'ready',
      policy: 'off',
      identity: { contractVersion: 1, storeId: 'sg-t-root-1', rootSessionId: 'root-1', requestKey: 'rk-intake-1', contractDigest: 'c'.repeat(64) },
      contract: { contractVersion: 1, objective, acceptanceCriteria: criteria, assumptions: [], constraints: [], requiredCapabilities: [] },
      proposalDigest: 'd'.repeat(64),
      admissionContext: { maxDepth: 3, maxChildren: 8, auditOnly: {} },
      admissionContextDigest: 'e'.repeat(64),
      reviewContext: { capabilityManifestDigest: 'f'.repeat(64), verifiers: [] },
      reviewContextDigest: 'a'.repeat(64),
      createdAt: '2026-09-23T00:00:00.000Z',
      ...overrides,
    }
  }

  /** The fixture's store as the read-back after a refusal sees it: the given proposals, and nothing else. */
  function storeHolding(proposals: readonly unknown[]) {
    return { proposals: { all: proposals, byId: {}, byRequestKey: {}, byParentTask: {} } }
  }

  it('says the contract is already on the record when the activation is what failed', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new WorkspaceBusyError(
        '/env/checkout',
        { kind: 'run', storeId: 'sg-t-other', taskId: 't-other', runId: 'r-other', since: '2026-09-23T00:00:00.000Z' },
        undefined,
        'the root contract cannot claim a checkout another live run holds',
      )
    }) as never
    ctx.task.openStore = vi.fn(async () => ({ ...snapshot, ...storeHolding([recordedProposalFor(rootContract.objective)]) })) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('task_intake rejected: workspace /env/checkout is busy')
    expect(result).toContain('p-root-recorded')
    expect(result).toContain('ready')
    // The record is the retry's address, both ways in, and the read side works
    // before the root exists (defect 1).
    expect(result).toContain('same proposal')
    expect(result).toContain('task_proposal_continue')
    expect(result).toContain('task_proposal_read')
    expect(result).not.toContain('Nothing was written')
  })

  it('matches a record by the objective the caller sent when the call carried no key of its own', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error('workspace /env/checkout is busy: held by kind run store sg-t-other')
    }) as never
    ctx.task.openStore = vi.fn(async () => ({
      ...snapshot,
      ...storeHolding([recordedProposalFor(rootContract.objective, rootContract.acceptanceCriteria, {
        proposalId: 'p-root-derived',
        requestKey: 'rk-derived',
      })]),
    })) as never
    const { requestKey: _key, ...withoutKey } = rootContract
    const result = (await defineTaskIntakeTool(ctx as never).execute(withoutKey, exec('root-1'))) as string

    expect(result).toContain('p-root-derived')
    expect(result).not.toContain('Nothing was written')
  })

  it('does not read another contract\'s record as this one, even under the same objective', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error('task-runtime: root contract rejected:\n- root contract objective must not be blank')
    }) as never
    // Same goal, other criteria: the objective alone is not the contract, and a
    // text that claimed *this* contract was recorded would send the caller to a
    // record that is not its own.
    ctx.task.openStore = vi.fn(async () => ({
      ...snapshot,
      ...storeHolding([recordedProposalFor(rootContract.objective, [{ description: 'something else entirely' }], { proposalId: 'p-other', requestKey: 'rk-other' })]),
    })) as never
    const { requestKey: _key, ...withoutKey } = rootContract
    const result = (await defineTaskIntakeTool(ctx as never).execute(withoutKey, exec('root-1'))) as string

    expect(result).toContain('Nothing was written')
    expect(result).not.toContain('p-other')
  })

  it('still says nothing was written when the store holds no proposal for this contract', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error('task-runtime: root contract rejected:\n- root contract objective must not be blank')
    }) as never
    // An open proposal for a *different* contract does not make this refusal a
    // recorded one: the caller's own contract was never written.
    ctx.task.openStore = vi.fn(async () => ({
      ...snapshot,
      ...storeHolding([recordedProposalFor('a goal somebody else asked for', [{ description: 'the other goal is met' }], { proposalId: 'p-other', requestKey: 'rk-other' })]),
    })) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('task-runtime: root contract rejected:')
    expect(result).toContain('Nothing was written')
    expect(result).not.toContain('p-other')
  })

  it('says nothing was written when the store does not exist yet', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error('task-runtime: root contract rejected:\n- root contract acceptanceCriteria must be an array')
    }) as never
    ctx.task.openStore = vi.fn(async () => {
      throw new Error('task: store "sg-t-root-1" does not exist')
    }) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('Nothing was written')
  })

  it('reports a store it cannot read back instead of claiming nothing was written', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error('task-runtime: the intake of a root contract for session "root-1" was cancelled before anything was persisted')
    }) as never
    ctx.task.openStore = vi.fn(async () => {
      throw new Error('task: invalid persisted event at seq 3')
    }) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    // The caller is resolved through the read core first (A2), so the answer is
    // that core's named refusal: the domain store cannot be read, with the store's
    // own reason — and nothing was written.
    expect(result).toContain('task_intake rejected:')
    expect(result).toContain('invalid persisted event at seq 3')
    expect(result).toContain('cannot be read')
    expect(result).toContain('nothing was written')
  })

  it('refuses a caller that is not the root session, by name, and calls nothing', async () => {
    const { ctx } = await fixture()
    const intake = vi.fn()
    ctx.taskRuntime.intakeRootContract = intake as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('s-worker'))) as string

    expect(result).toContain('task_intake rejected: session "s-worker"')
    expect(result).toContain('"root-1"')
    expect(intake).not.toHaveBeenCalled()
  })

  it('hands a key it does not declare to the runtime instead of dropping it', async () => {
    const { ctx } = await fixture()
    // There is no approval parameter here, and there must be no path that
    // swallows one either: a key this tool does not declare rides along to the
    // runtime, which refuses it by name before a proposal exists (§7: nothing
    // may quietly accept an approval-shaped argument).
    const intake = vi.fn(async () => ({
      status: 'activated',
      proposalId: 'p-root-1',
      taskId: 't-root-new',
      runId: 'r-root-new',
      detail: 'activated',
    }))
    ctx.taskRuntime.intakeRootContract = intake as never
    await defineTaskIntakeTool(ctx as never).execute({ ...rootContract, approved: true }, exec('root-1'))

    const spec = (intake.mock.calls[0] as unknown as unknown[])[2] as Record<string, unknown>
    expect(spec.approved).toBe(true)
  })
})

/**
 * The state a root session reads before any contract is accepted (A0 §1.5): the
 * store may not exist at all and needs no root task, so both readers answer a
 * named state plus whatever proposal is open — and never an objective. A graph
 * name standing where a goal belongs is exactly what A0 removed.
 */
describe('the root activation view', () => {
  const waitingProposal = {
    kind: 'root',
    proposalId: 'p-root-wait',
    requestKey: 'rk-root',
    status: 'pending_review',
    policy: 'all',
    identity: { contractVersion: 1, storeId: 'sg-t-root-1', rootSessionId: 'root-1', requestKey: 'rk-root', contractDigest: 'c'.repeat(64) },
    contract: { contractVersion: 1, objective: 'Ship the release artifact', acceptanceCriteria: [], assumptions: [], constraints: [], requiredCapabilities: [] },
    proposalDigest: 'd'.repeat(64),
    admissionContext: { maxDepth: 3, maxChildren: 8, auditOnly: {} },
    admissionContextDigest: 'e'.repeat(64),
    reviewContext: { capabilityManifestDigest: 'f'.repeat(64), verifiers: [] },
    reviewContextDigest: 'a'.repeat(64),
    createdAt: '2026-09-23T00:00:00.000Z',
  }

  async function emptyStore(proposals: readonly unknown[] = []) {
    const h = await fixture()
    h.store.snapshot = {
      ...h.store.snapshot,
      tasks: [],
      runs: [],
      evidence: [],
      reviews: [],
      proposals: { all: proposals, byId: {}, byRequestKey: {}, byParentTask: {} },
    } as never
    return h
  }

  it('task_read answers the named state and the open proposal, with no objective anywhere', async () => {
    const { ctx } = await emptyStore([waitingProposal])
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('root-1'))) as string

    expect(result).toContain('not activated')
    expect(result).toContain('no root contract has been accepted')
    expect(result).toContain('p-root-wait')
    expect(result).toContain('pending_review')
    expect(result).toContain('task_intake')
    expect(result).toContain('task_decompose')
    expect(result).not.toContain('objective:')
    expect(result).not.toContain('task t-root')
  })

  it('task_status answers the same state rather than an empty tree', async () => {
    const { ctx } = await emptyStore([{ ...waitingProposal, status: 'ready', policy: 'off' }])
    const result = (await defineTaskStatusTool(ctx as never).execute({}, exec('root-1'))) as string

    expect(result).toContain('not activated')
    expect(result).toContain('p-root-wait')
    expect(result).toContain('ready')
    expect(result).toContain('task_intake')
    expect(result).not.toContain('task tree')
  })

  it('reads a store that does not exist yet as the same state, not as an error', async () => {
    const { ctx } = await fixture({ storeError: new Error('task: store "sg-t-root-1" does not exist') })

    const read = (await defineTaskReadTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(read).toContain('not activated')
    expect(read).toContain('does not exist yet')
    const status = (await defineTaskStatusTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(status).toContain('not activated')
  })

  it('keeps a session with no run of its own off the root store view', async () => {
    const { ctx } = await emptyStore([])
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string

    // A store with no run naming this session is no contract for it: the caller
    // is a published member with nothing of its own, refused by name — never the
    // root's view, which belongs to the graph's root session alone.
    expect(result).toContain('task_read unbound:')
    expect(result).toContain('no Run of its own')
    expect(result).not.toContain('not activated')
  })
})

/**
 * The two question tools from the tool side (A4 §F.1, sub-goal ③c): the schema
 * the model writes, the caller's own identity, the arguments the runtime entry
 * receives, and the answer rendered back.
 *
 * What these cases pin, and nothing else: no parameter names a recipient or an
 * authorization (identity is the caller's run and the store's parent relation),
 * the tool hands the runtime its *own* registration id as the citation and never
 * a body, a refusal from the runtime is rendered rather than thrown, and a
 * delivery that could not be made is reported as a retry rather than as a
 * failure. The store, the gate and the delivery are the runtime's, and are
 * covered where they live (`tests/integration/a4-question-*.spec.ts`).
 */
describe('task_ask_parent', () => {
  /** One question call as the loop dispatches it: the caller's own session and its own call id. */
  function questionExec(sessionId: string, callId = `call-${sessionId}-1`) {
    return { agent: { id: sessionId }, callId, signal: new AbortController().signal }
  }

  /** One stored question, as the store hands it back after an ask. */
  function asked(overrides: Record<string, unknown> = {}) {
    return {
      question: {
        questionId: 'q-abc',
        childRunId: 'r-worker',
        parentRunId: 'r-root',
        requestKey: 'k1',
        questionDigest: 'a'.repeat(64),
        questionRef: { sessionId: 's-worker', seq: 7 },
        messageId: 'm-question-abc',
        blocking: true,
        askedAt: '2026-09-25T00:00:00.000Z',
        ...overrides,
      },
      created: true,
      delivery: { messageId: 'm-question-abc', status: 'delivered' },
    }
  }

  /** The tool with the runtime entry stubbed to one outcome, and the spy every case asserts on. */
  async function askTool(outcome: unknown) {
    const { ctx } = await fixture()
    const ask = vi.fn(async () => outcome)
    ctx.taskRuntime.askParentQuestion = ask as never
    return { tool: defineTaskAskParentTool(ctx as never), ctx, ask }
  }

  it('declares exactly the three parameters of the fixed shape, and nothing that could name an addressee', () => {
    const tool = defineTaskAskParentTool(fixture().ctx as never)
    const parameters = tool.parameters as { properties: Record<string, { type?: unknown }>; required?: string[] }

    expect(Object.keys(parameters.properties).sort()).toEqual(['blocking', 'question', 'requestKey'])
    expect(parameters.required).toEqual(['requestKey', 'question'])
    expect(parameters.properties.blocking?.type).toBe('boolean')
    // The addressee is the store's derivation from the caller's own run, and the
    // authorization is the gate's: no name on this surface (and nothing in the
    // JSON schema the model is shown) may read as either.
    expect(Object.keys(parameters.properties).some(name => /recipient|parent|target|^to$|run|session|auth|force/i.test(name))).toBe(false)
    expect(JSON.stringify(parameters)).not.toContain('recipient')
  })

  it('refuses an undeclared key by name, before the runtime is called', async () => {
    const { tool, ask } = await askTool(asked())

    const result = (await tool.execute(
      { requestKey: 'k1', question: 'which contract holds?', recipient: 's-root' },
      questionExec('s-worker'),
    )) as string
    expect(result).toContain('task_ask_parent rejected: undeclared parameter "recipient"')
    expect(result).toContain('no argument that names a recipient')
    expect(result).toContain('Nothing was asked and nothing was sent')
    expect(ask).not.toHaveBeenCalled()
  })

  it('forwards its own call id and the model\'s arguments to the runtime, and never a body of its own', async () => {
    const { tool, ask } = await askTool(asked())
    await tool.execute({ requestKey: 'k1', question: 'which contract holds?', blocking: false }, questionExec('s-worker', 'call-9'))

    expect(ask).toHaveBeenCalledExactlyOnceWith('s-worker', { callId: 'call-9', requestKey: 'k1', blocking: false })
  })

  it('leaves an absent blocking declaration absent, so the protocol\'s own default is what gets recorded', async () => {
    const { tool, ask } = await askTool(asked())
    await tool.execute({ requestKey: 'k1', question: 'which contract holds?' }, questionExec('s-worker'))

    expect(ask).toHaveBeenCalledExactlyOnceWith('s-worker', { callId: 'call-s-worker-1', requestKey: 'k1' })
  })

  it('renders a blocking question as the wait it creates, with the identity the store recorded', async () => {
    const { tool } = await askTool(asked())
    const result = (await tool.execute({ requestKey: 'k1', question: 'which contract holds?' }, questionExec('s-worker'))) as string

    expect(result).toContain('question q-abc recorded for your direct parent (run r-root)')
    expect(result).toContain('message m-question-abc is in your parent\'s session')
    expect(result).toContain('This run is now blocked on that answer')
    expect(result).toContain('`task_submit_result` are refused until an answer with `resolves: true` is recorded')
    expect(result).toContain('Stop the work that would write and end this step')
    expect(result).toContain('The answer arrives as a message in this session and in your context')
  })

  it('renders a non-blocking question as no wait at all, and a repeat as the record already held', async () => {
    const { tool } = await askTool({
      ...asked({ blocking: false }),
      created: false,
      delivery: { messageId: 'm-question-abc', status: 'already-present' },
    })
    const result = (await tool.execute({ requestKey: 'k1', question: 'a note' }, questionExec('s-worker'))) as string

    expect(result).toContain('message m-question-abc was already in your parent\'s session, so nothing was sent twice')
    expect(result).toContain('This is the question the same request key already recorded, word for word')
    expect(result).toContain('This run is not blocked')
    expect(result).not.toContain('This run is now blocked')
  })

  it('reports an unreachable parent as a retry the recovery pass makes, never as a failure and never as "ask again"', async () => {
    const { tool } = await askTool({ ...asked(), delivery: { messageId: 'm-question-abc', status: 'unavailable' } })
    const result = (await tool.execute({ requestKey: 'k1', question: 'which contract holds?' }, questionExec('s-worker'))) as string

    expect(result).toContain('question q-abc recorded')
    expect(result).toContain('message m-question-abc is not delivered yet: your parent\'s session is not live in this process')
    expect(result).toContain('recovery delivers that same identity when the parent is back')
    expect(result).toContain('do not ask the same question again under a new request key')
  })

  it('reports a delivery that could not be settled with the runtime\'s own reason', async () => {
    const { tool } = await askTool({
      ...asked(),
      delivery: { messageId: 'm-question-abc', status: 'refused', reason: 'the question body could not be read back' },
    })
    const result = (await tool.execute({ requestKey: 'k1', question: 'which contract holds?' }, questionExec('s-worker'))) as string

    expect(result).toContain('could not be delivered (the question body could not be read back)')
    expect(result).toContain('The question is on the record')
  })

  it('renders the runtime\'s refusal instead of throwing it', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.askParentQuestion = vi.fn(async () => {
      throw new Error('task-runtime: task "t-worker" has no parent task; a root or parentless replay task cannot ask a parent')
    }) as never
    const result = (await defineTaskAskParentTool(ctx as never).execute(
      { requestKey: 'k1', question: 'who owns me?' },
      questionExec('s-worker'),
    )) as string

    expect(result).toContain('task_ask_parent rejected:')
    expect(result).toContain('has no parent task')
  })

  it('refuses a call that carries no registration id, because it has no body to cite', async () => {
    const { tool, ask } = await askTool(asked())
    await expect(tool.execute({ requestKey: 'k1', question: 'q' }, { agent: { id: 's-worker' } } as never))
      .rejects.toThrow('task_ask_parent: this call carries no registration id')
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('task_answer', () => {
  /** One question call as the loop dispatches it: the caller's own session and its own call id. */
  function questionExec(sessionId: string, callId = `call-${sessionId}-1`) {
    return { agent: { id: sessionId }, callId, signal: new AbortController().signal }
  }

  /** One recorded answer, as answering a question hands it back. */
  function answered(resolves: boolean, overrides: Record<string, unknown> = {}) {
    return {
      answer: {
        answerId: 'a-xyz',
        questionId: 'q-abc',
        parentRunId: 'r-root',
        requestKey: 'a1',
        answerDigest: 'b'.repeat(64),
        answerRef: { sessionId: 's-root', seq: 11 },
        messageId: 'm-answer-xyz',
        resolves,
        answeredAt: '2026-09-25T00:00:00.000Z',
        ...overrides,
      },
      created: true,
      delivery: { messageId: 'm-answer-xyz', status: 'delivered' },
    }
  }

  async function answerTool(outcome: unknown) {
    const { ctx } = await fixture()
    const answer = vi.fn(async () => outcome)
    ctx.taskRuntime.answerParentQuestion = answer as never
    return { tool: defineTaskAnswerTool(ctx as never), ctx, answer }
  }

  it('declares exactly the four parameters of the fixed shape, with resolves required and no default', () => {
    const tool = defineTaskAnswerTool(fixture().ctx as never)
    const parameters = tool.parameters as { properties: Record<string, { type?: unknown }>; required?: string[] }

    expect(Object.keys(parameters.properties).sort()).toEqual(['answer', 'questionId', 'requestKey', 'resolves'])
    expect(parameters.required).toEqual(['questionId', 'requestKey', 'answer', 'resolves'])
    expect(parameters.properties.resolves?.type).toBe('boolean')
    expect(Object.keys(parameters.properties).some(name => /recipient|child|target|run|session|auth|approve|grant|category|kind/i.test(name))).toBe(false)
    expect(JSON.stringify(parameters)).not.toContain('recipient')
  })

  it('refuses an undeclared key by name, before the runtime is called', async () => {
    const { tool, answer } = await answerTool(answered(true))

    const result = (await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'this one', resolves: true, childSessionId: 's-child' },
      questionExec('s-root'),
    )) as string
    expect(result).toContain('task_answer rejected: undeclared parameter "childSessionId"')
    expect(result).toContain('no argument that names a recipient')
    expect(answer).not.toHaveBeenCalled()
  })

  it('forwards its own call id and the model\'s declaration, and nothing else', async () => {
    const { tool, answer } = await answerTool(answered(false))
    await tool.execute({ questionId: 'q-abc', requestKey: 'a1', answer: 'not yet', resolves: false }, questionExec('s-root', 'call-12'))

    expect(answer).toHaveBeenCalledExactlyOnceWith('s-root', {
      callId: 'call-12',
      questionId: 'q-abc',
      requestKey: 'a1',
      resolves: false,
    })
  })

  it('renders a resolving answer as the release of exactly that question, adding no claim about the words', async () => {
    const { tool } = await answerTool(answered(true))
    const result = (await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'this one', resolves: true },
      questionExec('s-root'),
    )) as string

    expect(result).toContain('answer a-xyz recorded for question q-abc')
    expect(result).toContain('message m-answer-xyz is in the asking run\'s session')
    expect(result).toContain('`resolves: true` releases exactly that question')
    expect(result).toContain('another question of its own keeps it blocked')
    expect(result).toContain('It changes no contract, no permission and no task state')
    expect(result).toContain('the framework does not vouch for what the answer says')
  })

  it('renders a non-resolving answer as a question still open', async () => {
    const { tool } = await answerTool(answered(false))
    const result = (await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'not yet', resolves: false },
      questionExec('s-root'),
    )) as string

    expect(result).toContain('`resolves: false` keeps the question open')
    expect(result).toContain('the asking run stays blocked on it')
  })

  it('reports an unreachable asking run as a retry the recovery pass makes', async () => {
    const { tool } = await answerTool({ ...answered(true), delivery: { messageId: 'm-answer-xyz', status: 'unavailable' } })
    const result = (await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'this one', resolves: true },
      questionExec('s-root'),
    )) as string

    expect(result).toContain('answer a-xyz recorded')
    expect(result).toContain('is not delivered yet: the asking run\'s session is not live in this process')
    expect(result).toContain('recovery delivers that same identity')
    expect(result).toContain('do not answer the same question again under a new request key')
  })

  it('renders the runtime\'s refusal instead of throwing it', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.answerParentQuestion = vi.fn(async () => {
      throw new Error('task-runtime: answer from run "r-other" refused: question "q-abc" is addressed to run "r-root"')
    }) as never
    const result = (await defineTaskAnswerTool(ctx as never).execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'x', resolves: true },
      questionExec('s-worker'),
    )) as string

    expect(result).toContain('task_answer rejected:')
    expect(result).toContain('is addressed to run "r-root"')
  })

  it('refuses a call that carries no registration id, because it has no body to cite', async () => {
    const { tool, answer } = await answerTool(answered(true))
    await expect(tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'x', resolves: true },
      { agent: { id: 's-root' } } as never,
    )).rejects.toThrow('task_answer: this call carries no registration id')
    expect(answer).not.toHaveBeenCalled()
  })
})
