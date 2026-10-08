import { describe, expect, it, vi } from 'vitest'
import { defineCapabilityListTool } from '../../src/tools/capability-list.ts'
import { defineTaskDiagnoseTool } from '../../src/tools/task-diagnose.ts'
import { defineTaskReadTool } from '../../src/tools/task-read.ts'
import { defineTaskReviewPackTool } from '../../src/tools/task-review-pack.ts'
import { defineTaskStatusTool } from '../../src/tools/task-status.ts'
import { defineTaskVerifyTool } from '../../src/tools/task-verify.ts'
import {
  fixture,
  exec,
  workerTask,
  rootTask,
  RENDER_TABLE,
  snapshot,
  childTask,
  rootRun,
  childRun,
} from './task-tools.fixture.ts'

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
    expect(result).toContain(
      '- t-child-1 [verified] Implement the parser (run: verified — phase submitted evidence: [ev-1] review: verified)',
    )
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
      skills: [
        {
          name: 'ball-align',
          role: 'guidance',
          readable: false,
          defects: ['SKILL.md is not the recorded content: recorded bb…, read cc…'],
        },
      ],
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
    expect(store.snapshot.runs.find(run => run.runId === 'r-child-1')?.batchId).toBe('b-r-child-1-p-1')
  })
})

describe('capability_list', () => {
  it('shows registered servers even before a capability grants them', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.capabilitiesForSession.mockResolvedValue({})
    ctx.taskRuntime.listMcpServers.mockReturnValue({ echo: { serverName: 'echo-fixture', description: 'Echo service', command: 'node' } })
    const result = await defineCapabilityListTool(ctx as never).execute({}, exec('root-1'))
    expect(result).toContain('registered MCP servers (1):')
    expect(result).toContain('- echo: Echo service (namespace mcp__echo-fixture__*)')
  })

  it('renders the registry with each label resolved to the tools it grants', async () => {
    const { ctx } = await fixture()
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(ctx.taskRuntime.capabilitiesForSession).toHaveBeenCalledExactlyOnceWith('root-1')
    expect(result).toContain(`capabilities (${Object.keys(RENDER_TABLE).length}):`)
    expect(result).toContain(
      '- design-ball — tools: [filesystem → read, write, edit; bash → bash] skills: [ball-align]',
    )
    expect(result).toContain('- verify-ball-functional — tools: [] skills: [verify] mcpServers: [bbdev]')
    expect(result).toContain('- research — tools: [] skills: [] preset: standard')
    expect(result).toContain('- analyze-waveform — tools: [] skills: [waveform] mcpServers: [waveform]')
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
      'task machinery: task_read, task_status, context_read, task_decompose, task_submit_result, task_cancel, task_verify, capability_list, task_template_list, ' +
        'task_library, task_proposal_read, task_proposal_continue, task_proposal_cancel, task_ask_parent, task_answer',
    )
    expect(result).toContain('baseline labels: filesystem, bash, jobs, search, skill, ask-user;')
    expect(result).not.toContain('session-history')
    expect(result).toContain('tool grants are fail-closed: ')
    expect(result).toContain('skill grants are not exclusive: DSH has no per-agent skill hiding')
    expect(result).toContain('mcpServers grant whole MCP servers')
    expect(result).toContain('leaves the worker on the deployment default (workspace-isolated)')
    expect(result).toContain(
      '- design-chip — tools: [] skills: [chip-designer] permission: (none — the worker keeps workspace-isolated)',
    )
  })

  it('flags a label outside the vocabulary instead of resolving it silently', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.capabilitiesForSession.mockResolvedValue({ broken: { tools: ['filesystem', 'filesytem'] } })
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string
    expect(result).toContain(
      '- broken — tools: [filesystem → read, write, edit; filesytem → (unknown label)] skills: []',
    )
  })

  it('renders the provider verdict of every declared skill under its capability row', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.capabilitiesForSession.mockResolvedValue(structuredClone(RENDER_TABLE))
    const tool = defineCapabilityListTool(ctx as never)
    const result = (await tool.execute({}, exec('root-1'))) as string

    // The pre-check runs for the calling session — the same viewpoint admission
    // would discover from — and only once.
    expect(ctx.taskRuntime.capabilityProviderReport).toHaveBeenCalledExactlyOnceWith('root-1')
    // A skill with no sidecar is guidance, and says so rather than looking like
    // a provider that failed.
    expect(result).toContain(
      '    providers: ball-align → guidance (no sidecar; loadable guidance, not an execution provider; content: bbbbbbbbbbbb)',
    )
    // An execution provider names the verifier that judges it and the tools it needs.
    expect(result).toContain('verify → execution-provider (verifier: command; requires: bash; content: eeeeeeeeeeee)')
    // A refused provider is not hidden: the defect code and its reason are shown.
    expect(result).toContain('model-integration → invalid (content-mismatch: SKILL.md is not the declared content)')
    // A row that grants no skill says that too, instead of rendering nothing.
    expect(result).toContain('    providers: (none — the capability grants no skill)')
    // The roots the verdicts were discovered from travel with them.
    expect(result).toContain('skill roots searched for this session: /env/.agents/skills, /dsh-home/skills')
    // The row lines themselves are unchanged by the addition.
    expect(result).toContain(
      '- design-ball — tools: [filesystem → read, write, edit; bash → bash] skills: [ball-align]',
    )
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
      tasks: [
        { ...rootTask, status: 'failed' },
        { ...childTask, status: 'failed' },
      ],
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
      tasks: [
        { ...rootTask, status: 'failed' },
        { ...childTask, status: 'failed' },
      ],
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
            {
              criterionId: 'ac1-1',
              verdict: 'fail',
              command: 'pnpm test',
              exitCode: 1,
              logRef: 'sg-t-root-1/r-child-1/ac1-1.log',
            },
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

  it("renders each run's coordination phase, and needs-recovery for a run with no phase", async () => {
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

  it('re-runs the verifier in the runtime-resolved workspace and records no status', async () => {
    const { ctx, services } = await fixture()
    const verifyRun = vi.fn(async () => bundle)
    services['verifier'] = { verifyRun }
    services['envBuilder'] = { store: { get: (envId: string) => ({ path: `/envs/${envId}` }) } }
    ctx.taskRuntime.envPathForSession.mockResolvedValue('/replays/candidate')
    const tool = defineTaskVerifyTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string
    expect(ctx.taskRuntime.runForSession).toHaveBeenCalledExactlyOnceWith('s-worker')
    expect(ctx.taskRuntime.envPathForSession).toHaveBeenCalledExactlyOnceWith('s-worker')
    expect(verifyRun).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'r-worker', {
      cwd: '/replays/candidate',
      timeoutMs: 1234,
    })
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
      runs: [
        { ...rootRun, status: 'verified' },
        { ...childRun, status: 'failed' },
      ],
      edges: [{ from: 't-child-1', to: 't-child-2' }],
      reviews: [
        {
          taskId: 't-root',
          runId: 'r-root',
          sessionId: 'root-1',
          outcome: 'verified',
          evidenceRefs: [],
          anomalies: [],
        },
        {
          taskId: 't-child-1',
          runId: 'r-child-1',
          sessionId: 's-child',
          outcome: 'failed',
          evidenceRefs: ['ev-1'],
          anomalies: [],
          localizedCause: 'mandatory criteria not satisfied: ac1-1 fail',
          durationMs: 42,
          criteria: [
            {
              criterionId: 'ac1-1',
              verdict: 'fail',
              command: 'pnpm test',
              exitCode: 1,
              logRef: 'sg-t-root-1/r-child-1/ac1-1.log',
            },
          ],
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

  it('assembles the exact source in full and navigates parent, children and dependency reviews by reference', async () => {
    const { ctx } = await fixture()
    ctx.task.openStore.mockResolvedValue(nestedSnapshot())
    const tool = defineTaskReviewPackTool(ctx as never)

    const rootPack = (await tool.execute({ taskId: 't-root', runId: 'r-root' }, exec('root-1'))) as string
    expect(rootPack).toContain('review pack for task t-root [verified] depth 0')
    expect(rootPack).toContain('review t-root#r-root [verified]')
    expect(rootPack).toContain('- task t-child-1 [failed] parent t-root; dependencies []; blocks [t-child-2]')
    expect(rootPack).toContain('review t-child-1#r-child-1 [failed]')
    expect(rootPack).toContain('- task t-child-2 [blocked] parent t-root; dependencies [t-child-1]')
    expect(rootPack).toContain('review t-child-2#no-run [blocked; no-run source]')
    expect(rootPack).not.toContain('    line a')
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
    expect(childPack).toContain('- task t-root [verified] parent none')
    expect(childPack).toContain('review t-root#r-root [verified]')
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
            skills: [
              {
                name: 'ball-align',
                role: 'knowledge',
                capabilities: ['design-ball'],
                description: 'Align a Ball',
                contractDigest: 'b'.repeat(64),
                contentDigest: 'c'.repeat(64),
                uncovered: [],
              },
            ],
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
        toolFit: {
          granted: ['bash', 'read'],
          called: [{ name: 'read', count: 2 }],
          calledOutsideGrant: ['web_search'],
        },
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
      'metrics: tokens in 1000/out 200/cache 50+10 (session-cumulative) — toolCalls 5 (1 failed) — ' +
        'humanInterventions 2 (session-scoped) — retries 0 (runs beyond the first; a recovery attempt is one) — evidenceLogs 1',
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
    await expect(tool.execute({ taskId: 'ghost', runId: 'r-ghost' }, exec('root-1'))).rejects.toThrow(
      'unknown task "ghost"',
    )
  })

  it('shows the deciding judge and its version on the criterion line', async () => {
    const { ctx } = await fixture()
    const full = nestedSnapshot()
    const target = full.reviews.find(item => item.taskId === 't-child-1')!
    Object.assign(target, {
      criteria: [
        {
          criterionId: 'ac1-1',
          verdict: 'fail',
          verifierId: 'command',
          verifierVersion: '1',
          command: 'pnpm test',
          exitCode: 1,
        },
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
    proposals: [
      {
        targetType: 'task_definition',
        targetId: 'build:1',
        rationale: 'add an empty-input fixture to the acceptance command',
      },
    ],
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
    const pack = (await defineTaskReviewPackTool(ctx as never).execute(
      { taskId: 't-child-1', runId: 'r-child-1' },
      exec('root-1'),
    )) as string
    expect(pack).toContain('diagnoses (1):')
    expect(pack).toContain('- d1 [medium] the fixtures never feed empty input')
    const status = (await defineTaskStatusTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(status).toContain(
      't-child-1 [verified] Implement the parser (run: verified — phase submitted evidence: [ev-1] review: verified diag: 1)',
    )
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
      {
        ...args,
        proposals: [{ targetType: 'prompt_template', targetId: 'reviewer', rationale: 'name the empty-input case' }],
      },
      exec('root-1'),
    )) as string
    expect(recorded).toContain('- prompt_template reviewer: name the empty-input case')
    expect(ctx.task.recordDiagnosisIn).toHaveBeenCalledOnce()

    ctx.task.recordDiagnosisIn.mockClear()
    const rejected = (await tool
      .execute({ ...args, proposals: [{ targetType: '  ', targetId: 'x', rationale: 'y' }] }, exec('root-1'))
      .catch((error: Error) => String(error))) as string
    expect(rejected).toContain('targetType')
    expect(ctx.task.recordDiagnosisIn).not.toHaveBeenCalled()
  })

  it('names the observedFailure slot the postmortem observation, in the schema and in the description', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskDiagnoseTool(ctx as never)
    const parameters = (
      tool.parameters as {
        properties: Record<
          string,
          { type?: unknown; description?: string; items?: { properties?: Record<string, Record<string, unknown>> } }
        >
      }
    ).properties

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
      const rejected = (await tool
        .execute({ ...args, proposals }, exec('root-1'))
        .catch((error: Error) => String(error))) as string
      expect(rejected).toContain('proposals')
    }
    expect(ctx.task.recordDiagnosisIn).not.toHaveBeenCalled()
  })
})
