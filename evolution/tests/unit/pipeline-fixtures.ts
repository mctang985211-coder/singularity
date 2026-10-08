/**
 * The pipeline's own fixtures: one graph library with a baseline and a candidate
 * revision, a task store whose replayed sides settle the way the fixture says,
 * and the runtime's real receipt builder for every settled run. A spec therefore
 * exercises `plan → run → validate → score → report` against receipts the
 * deployment's own sealer would have produced, not against hand-written objects.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { AcceptanceCriterion, ExecutionReceipt, ReviewRecord, RunProviderBinding, TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { buildExecutionReceipt } from '@dangosys/dsh-singularity-task-runtime'
import type { ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type { SessionFacts } from '@dangosys/dsh-singularity-task-runtime'
import type { MethodLedger } from '../../src/draft/draft.ts'
import type { EvolutionRecordV5 } from '../../src/ledger/records.ts'
import type { EvaluationRuntime, EvaluationSources } from '../../src/pipeline/sources.ts'
import { digestOf } from '../../src/shared.ts'
import type { RevisionView } from '../../src/types.ts'

export const ROOT_SESSION = 's-root'
export const STORE = rootTaskStoreId(ROOT_SESSION)
export const LIBRARY = ROOT_SESSION
export const MODEL = { provider: 'test-provider', model: 'test-model', label: 'test-provider/test-model' }
export const SAMPLE = 'case-a'
export const CANDIDATE_SKILL = 'repair-guidance'
export const BASELINE_REVISION = 'r0001'
export const CANDIDATE_REVISION = 'c-d0001'

/** The one criterion the fixture's sample is judged by. */
export const CRITERION: AcceptanceCriterion = {
  criterionId: 'c1',
  description: 'the answer file holds 42',
  command: 'test "$(cat answer.txt)" = 42',
  verificationMode: 'deterministic',
  mandatory: true,
  requiredEvidence: [],
  verifierRef: 'command',
} as AcceptanceCriterion

/** What one side of one sample settles as. */
export interface SideScript {
  readonly outcome: 'verified' | 'failed'
  readonly tokens: number
  readonly skills?: readonly string[]
}

export interface PipelineWorld {
  readonly sources: EvaluationSources
  readonly ledger: MethodLedger & { records(): readonly EvolutionRecordV5[] }
  readonly inputDir: string
  readonly reports: string[]
  readonly replays: { side: 'baseline' | 'candidate'; taskId: string; options: ReplayTaskOptions }[]
  readonly snapshot: () => TaskSnapshot
  readonly receipts: Map<string, ExecutionReceipt>
  dispose(): Promise<void>
  /** The configuration a spec changes between two evaluations. */
  setSide(side: 'baseline' | 'candidate', script: SideScript): void
}

function revisionView(input: {
  revisionId: string
  skillRoot: string
  taskTemplatesRoot: string
  skills: readonly string[]
  row?: string
}): RevisionView {
  return {
    ref: { revisionId: input.revisionId, digest: digestOf({ revision: input.revisionId }), libraryId: LIBRARY },
    root: input.skillRoot,
    skillRoot: input.skillRoot,
    taskTemplatesRoot: input.taskTemplatesRoot,
    skills: input.skills.map(name => ({
      name,
      version: 1,
      contentDigest: digestOf({ skill: name }),
      contractDigest: null,
      status: 'temporary' as const,
    })),
    templates: [],
    capabilityRows: {
      'execute-task': { skills: ['task-coordination'], tools: ['filesystem'] },
      ...(input.row === undefined ? {} : { [input.row]: { skills: [CANDIDATE_SKILL], tools: ['skill'] } }),
    },
    mcpServers: {},
  }
}

/** Build one world: a store, two revisions, a ledger and the seams the pipeline reads. */
export async function pipelineWorld(input: { baseline: SideScript; candidate: SideScript; withAdmissionGap?: boolean }): Promise<PipelineWorld> {
  const root = await mkdtemp(join(tmpdir(), 'evolution-pipeline-'))
  const inputDir = join(root, 'input')
  await mkdir(inputDir, { recursive: true })
  await writeFile(join(inputDir, 'answer.txt'), '41\n', 'utf8')
  const scripts = new Map<'baseline' | 'candidate', SideScript>([
    ['baseline', input.baseline],
    ['candidate', input.candidate],
  ])
  const baselineRevision = revisionView({
    revisionId: BASELINE_REVISION,
    skillRoot: join(root, 'revisions', BASELINE_REVISION, 'skills'),
    taskTemplatesRoot: join(root, 'revisions', BASELINE_REVISION, 'task-templates'),
    skills: ['task-coordination'],
  })
  const candidateRevision = revisionView({
    revisionId: CANDIDATE_REVISION,
    skillRoot: join(root, 'revisions', CANDIDATE_REVISION, 'skills'),
    taskTemplatesRoot: join(root, 'revisions', CANDIDATE_REVISION, 'task-templates'),
    skills: ['task-coordination', CANDIDATE_SKILL],
    row: `method:${CANDIDATE_SKILL}`,
  })

  const records: EvolutionRecordV5[] = []
  const ledger = {
    libraryId: LIBRARY,
    records: () => records as readonly EvolutionRecordV5[],
    append: async (record: EvolutionRecordV5) => {
      records.push(record)
    },
  }

  const receipts = new Map<string, ExecutionReceipt>()
  const reports: string[] = []
  const replays: PipelineWorld['replays'] = []
  const tasks: Record<string, unknown>[] = [
    {
      taskId: SAMPLE,
      definitionRef: { taskType: 'task', version: 1 },
      objective: 'deliver an answer',
      depth: 0,
      acceptanceCriteria: [CRITERION],
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'leaf',
      status: 'failed',
      runIds: ['run-historical'],
      childTaskIds: [],
    },
  ]
  const runs: TaskRun[] = [
    {
      runId: 'run-historical',
      taskId: SAMPLE,
      sessionId: 'session-historical',
      capabilitySnapshot: ['execute-task'],
      status: 'failed',
      startedAt: '2026-10-07T00:00:00.000Z',
    } as unknown as TaskRun,
  ]
  const reviews: ReviewRecord[] = [
    {
      taskId: SAMPLE,
      runId: 'run-historical',
      sessionId: 'session-historical',
      outcome: 'failed',
      evidenceRefs: ['evidence:historical'],
      anomalies: [],
      criteria: [{ criterionId: 'c1', verdict: 'fail', verifierId: 'command', verifierVersion: '3' }],
    } as unknown as ReviewRecord,
  ]

  /** One settled side: its own task, run, review and the receipt the runtime's own builder seals. */
  const settleSide = (side: 'baseline' | 'candidate', workspace: string): ReplayRunOutcome => {
    const script = scripts.get(side)!
    const taskId = `replay-${side}`
    const runId = `run-${side}`
    const revisionId = side === 'candidate' ? CANDIDATE_REVISION : BASELINE_REVISION
    const granted = script.skills ?? (side === 'candidate' ? ['task-coordination', CANDIDATE_SKILL] : ['task-coordination'])
    const providerBinding = {
      environmentRevisionId: revisionId,
      registryRevision: side === 'candidate' ? 'rev-candidate' : 'rev-baseline',
      capabilities: ['execute-task'],
      skills: granted.map(name => ({ name, role: 'guidance' as const, contentDigest: digestOf({ skill: name }), contractDigest: null })),
      mcpServers: [],
      preset: null,
      ...(side === 'candidate' ? { trialCandidateRef: CANDIDATE_REVISION } : {}),
    } as unknown as RunProviderBinding
    tasks.push({
      taskId,
      definitionRef: { taskType: 'task', version: 1 },
      objective: `[evolution-eval] ${SAMPLE}`,
      depth: 0,
      acceptanceCriteria: [CRITERION],
      requestedCapabilities: ['execute-task'],
      decompositionStatus: 'leaf',
      status: script.outcome,
      runIds: [runId],
      childTaskIds: [],
    })
    const run: TaskRun = {
      runId,
      taskId,
      sessionId: `session-${side}`,
      capabilitySnapshot: granted,
      placement: { workspacePath: workspace },
      providerBinding,
      environmentRevisionId: revisionId,
      ...(side === 'candidate' ? { trialCandidateRef: CANDIDATE_REVISION } : {}),
      status: script.outcome,
      startedAt: '2026-10-08T00:00:00.000Z',
      taskTemplatesRoot: join(root, 'revisions', revisionId, 'task-templates'),
    } as unknown as TaskRun
    runs.push(run)
    reviews.push({
      taskId,
      runId,
      sessionId: run.sessionId,
      outcome: script.outcome,
      evidenceRefs: [`evidence:${runId}`],
      anomalies: [],
      criteria: [{ criterionId: 'c1', verdict: script.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command', verifierVersion: '3', command: CRITERION.command }],
      metrics: {
        tokens: { uncachedInputTokens: script.tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        toolCalls: { calls: 1, failures: 0 },
      },
    } as unknown as ReviewRecord)
    const snapshot = snapshotOf()
    const facts = new Map<string, SessionFacts>([
      [
        runId,
        {
          logEvents: 4,
          modelRequests: [{ identity: { provider: MODEL.provider, model: MODEL.model }, count: 1 }],
          skillCalls: granted,
          toolCalls: { calls: [], failures: 0 },
        },
      ],
    ])
    const built = buildExecutionReceipt({
      storeId: STORE,
      snapshot,
      run,
      drain: 'in-process',
      sessionFacts: facts,
      revision: { revisionId, digest: digestOf({ revision: revisionId }) },
      sealedAt: '2026-10-08T00:00:01.000Z',
    })
    if (built.status !== 'built') throw new Error(`fixture: the receipt of ${runId} was refused: ${built.reason}`)
    receipts.set(runId, built.receipt)
    return {
      taskId,
      runId,
      status: script.outcome,
      workspace,
      criteria: [{ criterionId: 'c1', verdict: script.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command', verifierVersion: '3' }],
    }
  }

  const snapshotOf = (): TaskSnapshot =>
    ({
      version: 1,
      id: STORE,
      tasks,
      runs,
      edges: [],
      evidence: [],
      handoffs: [],
      reviews,
      diagnoses: [],
      obligations: [],
      capabilities: {},
      receipts: [...receipts.values()],
    }) as unknown as TaskSnapshot

  const precheck = (side: 'baseline' | 'candidate') => ({
    revision: side === 'candidate' ? 'rev-candidate' : 'rev-baseline',
    capabilities: [
      {
        capability: 'execute-task',
        skills: [
          { valid: true, name: 'task-coordination', role: 'guidance', contentDigest: digestOf({ skill: 'task-coordination' }), contractDigest: null },
          ...(side === 'candidate'
            ? [{ valid: true, name: CANDIDATE_SKILL, role: 'guidance', contentDigest: digestOf({ skill: CANDIDATE_SKILL }), contractDigest: null }]
            : []),
        ],
        refusals: [],
      },
    ],
  })

  const runtime: EvaluationRuntime = {
    storeOfSession: async () => STORE,
    activeRevision: async () => baselineRevision,
    revision: async (_sessionId, revisionId) =>
      revisionId === CANDIDATE_REVISION ? candidateRevision : revisionId === BASELINE_REVISION ? baselineRevision : (() => {
        throw new Error(`fixture: no revision "${revisionId}"`)
      })(),
    capabilitiesForSession: async () => baselineRevision.capabilityRows,
    capabilityProviderReport: async () => precheck('baseline'),
    precheckCapabilityTable: async () => precheck('candidate'),
    mcpServers: () => ({}),
    maxActiveWorkers: () => 2,
    async replayTask(_storeId, _sampleTaskId, options): Promise<ReplayRunOutcome> {
      const side: 'baseline' | 'candidate' = options.trialCandidateRef === undefined ? 'baseline' : 'candidate'
      const workspace = options.workspace?.path ?? join(root, 'workspace', side)
      await mkdir(workspace, { recursive: true })
      replays.push({ side, taskId: `replay-${side}`, options })
      return settleSide(side, workspace)
    },
  }

  const sources: EvaluationSources = {
    ledger,
    runtime,
    tasks: {
      openStore: async () => snapshotOf(),
      receiptFor: async (_storeId, runId) => receipts.get(runId),
    },
    verifierVocabulary: async () => ({ ids: ['command'], versions: { command: '3' } }),
    root: join(root, 'evolution'),
    libraryId: LIBRARY,
    caller: ROOT_SESSION,
  }
  return {
    sources,
    ledger,
    inputDir,
    reports,
    replays,
    snapshot: snapshotOf,
    receipts,
    setSide: (side, script) => scripts.set(side, script),
    async dispose() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** The draft the fixture evaluates: one first Skill in one candidate revision. */
export function firstSkillDraft(): import('../../src/types.ts').MethodDraft {
  return {
    draftId: 'd0001',
    kind: 'skill',
    identity: CANDIDATE_SKILL,
    baseRevision: { revisionId: BASELINE_REVISION, digest: digestOf({ revision: BASELINE_REVISION }), libraryId: LIBRARY },
    candidateRevision: { revisionId: CANDIDATE_REVISION, digest: digestOf({ revision: CANDIDATE_REVISION }), files: [] },
    rationale: 'the candidate writes the answer the criterion asks for',
    sourceRefs: ['diagnosis:d1'],
    actor: 'supervisor',
    at: '2026-10-08T00:00:00.000Z',
  }
}

/** The one evaluation call every pipeline spec starts from. */
export function evaluateInput(world: PipelineWorld) {
  return {
    draftId: 'd0001',
    samples: [{ taskId: SAMPLE, role: 'observed-failure' as const }],
    input: { sourceDir: world.inputDir },
    model: MODEL,
    rules: { quality: { metricId: 'acceptance', direction: 'higher-is-better' as const, extractor: 'original-acceptance' }, guards: [] },
    budget: { note: 'fixture' },
    actor: 'supervisor',
  }
}

/** Record the draft on the fixture's own ledger, so the write doors fold it. */
export async function recordDraft(world: PipelineWorld): Promise<void> {
  const draft = firstSkillDraft()
  await world.ledger.append({
    formatVersion: 5,
    kind: 'draft',
    draftId: draft.draftId,
    libraryId: LIBRARY,
    assetKind: draft.kind,
    identity: draft.identity,
    baseRevision: draft.baseRevision,
    candidateRevision: draft.candidateRevision,
    rationale: draft.rationale,
    sourceRefs: [...draft.sourceRefs],
    actor: draft.actor,
    at: draft.at,
  })
}
