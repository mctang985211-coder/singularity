import { vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { type CapabilityConfig } from '../../../task-runtime/src/index.ts'
import { graphRegistry, mountContextReadCore, sessionQueryReads } from '../../../tests/support/context-plane.ts'

export const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }

export const rootTask = {
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

export const childTask = {
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

export const workerTask = {
  ...childTask,
  taskId: 't-worker',
  status: 'running',
  runIds: ['r-worker'],
  childTaskIds: [],
}

export const rootRun = {
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

export const childRun = {
  ...rootRun,
  runId: 'r-child-1',
  taskId: 't-child-1',
  sessionId: 's-child',
  status: 'verified',
  // The path every verified run took: it submitted, and the verdict followed.
  executionPhase: 'submitted' as const,
}

export const workerRun = { ...rootRun, runId: 'r-worker', taskId: 't-worker', sessionId: 's-worker', status: 'running' }

export const snapshot = {
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
  diagnoses: [],
  obligations: [],
  capabilities: {},
}

/**
 * The provider report `capability_list` renders: one accepted row per role, one
 * refused row, and one row that grants no skill — the shapes the renderer has to
 * say something honest about.
 */
export function providerReport() {
  return {
    capabilities: [
      {
        capability: 'design-ball',
        skills: [
          {
            valid: true,
            role: 'guidance',
            name: 'ball-align',
            directory: '/skills/ball-align',
            content: { skillMdSha256: 'a'.repeat(64), resources: [] },
            contentDigest: 'b'.repeat(64),
            uncovered: [],
          },
        ],
      },
      {
        capability: 'verify-ball-functional',
        skills: [
          {
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
          },
        ],
      },
      {
        capability: 'integrate-model',
        skills: [
          {
            valid: false,
            name: 'model-integration',
            directory: '/skills/model-integration',
            defects: [{ code: 'content-mismatch', detail: 'SKILL.md is not the declared content' }],
          },
        ],
      },
      { capability: 'research', skills: [] },
    ],
    roots: ['/env/.agents/skills', '/dsh-home/skills'],
  }
}

/** The table the capability_list cases check: the three verdict shapes above plus a row that grants no skill. */
export const RENDER_TABLE: Readonly<Record<string, CapabilityConfig>> = {
  'design-chip': { skills: ['chip-designer'] },
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'verify-ball-functional': { skills: ['verify'], mcpServers: ['bbdev'] },
  'analyze-waveform': { skills: ['waveform'], mcpServers: ['waveform'] },
  'integrate-model': { skills: ['model-integration'] },
  research: { preset: 'standard' },
}

/** The store one read runs against, with the patches a spec applies to it. */
export interface StoreFixture {
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
export async function fixture(
  options: { storeError?: Error; storeMissing?: true; sessions?: Map<string, SessionEvent[]> } = {},
) {
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
      // The zero-write read door the read core uses: a store that is not there
      // answers `exists:false`, and one that cannot be replayed throws by name.
      snapshotReadOnly: vi.fn(async (_storeId: string) => {
        if (options.storeMissing === true) return { exists: false as const }
        if (options.storeError !== undefined) throw options.storeError
        return { exists: true as const, snapshot: store.snapshot }
      }),
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
      envPathForSession: vi.fn(async (_sessionId: string): Promise<string | undefined> => undefined),
      intakeRootContract: vi.fn(),
      submitDecompositionProposal: vi.fn(),
      continueProposal: vi.fn(),
      proposalIn: vi.fn(),
      cancelProposal: vi.fn(),
      listCapabilities: vi.fn(() => structuredClone(RENDER_TABLE)),
      capabilitiesForSession: vi.fn(async (_sessionId: string) => structuredClone(RENDER_TABLE)),
      listMcpServers: vi.fn(() => ({})),
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
      set: (value: unknown) => {
        services[name] = value
        context.provide(name, value as never)
      },
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

export function exec(sessionId: string) {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as never
}
