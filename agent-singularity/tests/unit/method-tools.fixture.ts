/**
 * A method-tool world: a real environment library on disk (its initial revision,
 * drafts, pointer and pointer intent) driven through the same environment
 * functions the runtime's service layer calls, a real v5 method ledger, and a
 * scripted graph/task store. The six `method_*` tools therefore run their own
 * code against real files, and what a spec asserts is a real write or a real
 * absence of one.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  createEnvironmentDraft,
  discardEnvironmentDraft,
  ensureInitialRevision,
  freezeEnvironmentDraft,
  libraryRoots,
  openPointerIntent,
  publishEnvironmentRevision,
  readEnvironmentDraft,
  readPointer,
  readRevision,
  reconcileEnvironmentPointer,
  rollbackEnvironmentRevision,
  stageEnvironmentEdit,
} from '../../../task-runtime/src/environment/index.ts'
import type {
  EnvironmentCommitHost,
  EnvironmentDraft,
  EnvironmentEdit,
  EnvironmentPointerIntent,
  EnvironmentPointerReconcile,
  EnvironmentRevision,
  LibraryRoots,
  PublishOutcome,
  PublishRequest,
} from '../../../task-runtime/src/environment/index.ts'

export const GRAPH = 'g1'
export const CALLER = 's-supervisor'

/** The environment view one library's pointer resolves to, read exactly as the service layer projects it. */
async function viewOf(library: LibraryRoots, protocol: 'environment-revision' | 'legacy' | 'uninitialized'): Promise<Record<string, unknown>> {
  const pointer = await readPointer(library)
  if (pointer === null) {
    return { libraryId: library.id, revisionId: 'legacy', generation: 0, manifestDigest: 'legacy', readOnly: true, protocol, skills: [], taskTemplates: [] }
  }
  const revision = await readRevision(library, pointer.revisionId)
  if (revision === undefined) throw new Error(`environment: the pointer names revision "${pointer.revisionId}", which is absent`)
  return {
    libraryId: library.id,
    revisionId: revision.manifest.revisionId,
    generation: pointer.generation,
    manifestDigest: revision.manifest.contentDigest,
    readOnly: false,
    protocol,
    skills: revision.manifest.skills,
    taskTemplates: revision.manifest.taskTemplates,
  }
}

/** The scripted deployment one method-tool spec runs against. */
export interface MethodWorld {
  readonly home: string
  readonly library: LibraryRoots
  readonly ctx: Record<string, unknown>
  readonly exec: Record<string, unknown>
  /** How many times each environment entry was called. */
  readonly calls: Record<string, number>
  /** Every approval request the tools made, in order. */
  readonly approvals: { toolName?: string; callId?: string; reason?: string }[]
  /** Every event this world's context emitted, in order, as `emit(name, frame)` recorded it. */
  readonly frames: { readonly name: string; readonly frame: unknown }[]
  /** The sealed receipts this world's task store serves; a spec pushes the ones its forged trials cite. */
  readonly storeReceipts: unknown[]
  /** The graph's own rsi settings, as `methodModeFor` reads them. */
  readonly rsi: { humanReview: boolean; strategy?: 'regularized' | 'unregularized' }
  revision: (revisionId: string) => Promise<EnvironmentRevision | undefined>
  draft: (draftId: string) => Promise<EnvironmentDraft | undefined>
  pointer: () => Promise<{ revisionId: string; generation: number } | null>
  intent: () => Promise<EnvironmentPointerIntent | null>
  ledgerText: () => Promise<string>
  dispose: () => Promise<void>
}

export async function methodWorld(
  options: {
    /** The answer every approval request receives. */
    readonly answer?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    /** Runs inside the approval window, before the answer is returned — the one place a third party can still move the pointer. */
    readonly duringApproval?: () => Promise<void> | void
    readonly humanReview?: boolean
    /** The graph-level strategy switch the ledger plane resolves its policy from. */
    readonly strategy?: 'regularized' | 'unregularized'
    readonly trialCandidateRef?: string
    /** Serve the library as read-only (a legacy layout, or a sealed graph). */
    readonly readOnly?: boolean
    /** Runs the store reports, so a spec can bind an explicit trial. */
    readonly runs?: readonly { runId: string; trialCandidateRef?: string }[]
  } = {},
): Promise<MethodWorld> {
  const home = await mkdtemp(join(tmpdir(), 'singularity-method-'))
  const library = libraryRoots(GRAPH, home)
  await ensureInitialRevision(library, { actor: 's-root' })
  const calls: Record<string, number> = {}
  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  const approvals: { toolName?: string; callId?: string; reason?: string }[] = []

  const host: EnvironmentCommitHost = { library }
  const storeReceipts: unknown[] = []
  const runtime = {
    config: { environmentRevisionRoot: home },
    activeEnvironmentView: async (sessionId: string, viewOptions: { trialCandidateRef?: string } = {}) => {
      count('activeEnvironmentView')
      void sessionId
      const view = await viewOf(library, options.readOnly === true ? 'legacy' : 'environment-revision')
      return {
        ...view,
        readOnly: options.readOnly === true || viewOptions.trialCandidateRef !== undefined,
        ...(viewOptions.trialCandidateRef === undefined ? {} : { trialCandidateRef: viewOptions.trialCandidateRef }),
      }
    },
    activeRevisionFor: async () => {
      count('activeRevisionFor')
      const revision = await readRevision(library, (await readPointer(library))!.revisionId)
      if (revision === undefined) throw new Error('environment: no active revision')
      return revision
    },
    libraryRootsForSession: async () => {
      count('libraryRootsForSession')
      return { id: library.id, root: library.root }
    },
    // The runtime carries both read entries: the roots pair the method tools
    // resolve against, and the library view the graph-web console binds.
    libraryForSession: async () => {
      count('libraryForSession')
      return { id: library.id, root: library.root, protocol: 'environment-revision', taskTemplatesRoot: join(library.root, 'task-templates'), skillRoot: join(library.root, 'skills') }
    },
    createDraft: async (_sessionId: string, request: { basedOn?: string; purpose?: string; reuse?: boolean }) => {
      count('createDraft')
      return await createEnvironmentDraft(library, {
        ...(request.basedOn === undefined ? {} : { basedOn: request.basedOn }),
        ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
        actor: CALLER,
      })
    },
    stageDraftEdit: async (_sessionId: string, draftId: string, edit: EnvironmentEdit) => {
      count('stageDraftEdit')
      return await stageEnvironmentEdit(library, draftId, edit)
    },
    removeEnvironmentDraft: async (_sessionId: string, draftId: string) => {
      count('removeEnvironmentDraft')
      await discardEnvironmentDraft(library, draftId)
    },
    freezeDraft: async (_sessionId: string, draftId: string) => {
      count('freezeDraft')
      return await freezeEnvironmentDraft(library, draftId)
    },
    publishRevision: async (_sessionId: string, request: PublishRequest): Promise<PublishOutcome> => {
      count('publishRevision')
      return await publishEnvironmentRevision(host, request)
    },
    rollbackRevision: async (_sessionId: string, request: PublishRequest): Promise<PublishOutcome> => {
      count('rollbackRevision')
      return await rollbackEnvironmentRevision(host, request)
    },
    openPointerIntent: async (): Promise<EnvironmentPointerIntent | null> => {
      count('openPointerIntent')
      return await openPointerIntent(library)
    },
    reconcilePointer: async (): Promise<EnvironmentPointerReconcile[]> => {
      count('reconcilePointer')
      return await reconcileEnvironmentPointer(host)
    },
  }

  const rsi = {
    humanReview: options.humanReview ?? false,
    ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
  }
  const frames: { name: string; frame: unknown }[] = []
  const ctx: Record<string, unknown> = {
    taskRuntime: runtime,
    task: { openStore: async () => ({ tasks: [], runs: options.runs ?? [], reviews: [], diagnoses: [], evidence: [], obligations: [], capabilities: {}, receipts: storeReceipts }) },
    graphs: { graphForSession: async () => ({ id: GRAPH, rootSessionId: SessionId(GRAPH), rsi }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    llm: undefined,
    approval: {
      request: vi.fn(async (request: { toolName?: string; callId?: string; reason?: string }) => {
        approvals.push({ toolName: request.toolName, callId: request.callId, reason: request.reason })
        await options.duringApproval?.()
        return options.answer ?? 'allowed-once'
      }),
    },
    get: (name: string) => (name === 'singularityMethods' ? { enabled: true } : undefined),
    emit: (name: string, frame: unknown) => {
      frames.push({ name, frame })
    },
    llmStream: undefined,
  }
  const exec = { agent: { id: CALLER }, callId: 'call-1', signal: new AbortController().signal }

  return {
    home,
    library,
    ctx,
    exec,
    calls,
    approvals,
    frames,
    rsi,
    storeReceipts,
    revision: (revisionId: string) => readRevision(library, revisionId),
    draft: (draftId: string) => readEnvironmentDraft(library, draftId),
    pointer: async () => {
      const pointer = await readPointer(library)
      return pointer === null ? null : { revisionId: pointer.revisionId, generation: pointer.generation }
    },
    intent: () => openPointerIntent(library),
    ledgerText: () => readFile(join(library.root, 'methods.jsonl'), 'utf8').catch(() => ''),
    dispose: async () => {
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** A minimal `SKILL.md` this build's parser accepts. */export function skillText(body: string, name = 'verify'): string {
  return `---\nname: ${name}\ndescription: a fixture skill for the method tools\n---\n\n${body}\n`
}

/** The smallest declared edit a candidate can carry. */
export const DECLARED_EDIT = {
  id: 'e1',
  mechanism: 'skill',
  hypothesis: 'the candidate skill answers the observed failure',
  targets: ['skills/verify/SKILL.md'],
}

/** The draft payload for one skill candidate. */
export function skillPayload(body: string, name = 'verify'): string {
  return JSON.stringify({ skillMd: skillText(body, name) })
}

/** The revision reference one side of a forged plan carries: the revision the library really holds. */
function revisionRef(revisionId: string, digest: string): { revisionId: string; digest: string; libraryId: string } {
  return { revisionId, digest, libraryId: GRAPH }
}

/**
 * Forge one evaluated draft: draft the candidate through the real tool, then
 * write the plan and evaluation lines and the report the pipeline would have
 * written. The pipeline's own `evaluate` returns a recorded report without
 * re-running anything, so `method_evaluate` over this draft exercises the real
 * read-back and decision path while the measurement itself stays out of scope.
 */
export async function forgeEvaluation(
  world: MethodWorld,
  options: { readonly cost?: 'reported' | 'unknown'; readonly candidateBody?: string; readonly publishable?: boolean } = {},
): Promise<{ draftId: string; evaluationId: string; reportDigest: string }> {
  const { defineMethodDraftTool } = await import('../../src/tools/method-draft.ts')
  const { digestOf, evaluationReportDigest, foldMethods, openMethodLedger, reportPathOf } = await import('@dangosys/dsh-singularity-evolution')
  const drafted = (await defineMethodDraftTool(world.ctx as never).execute(
    {
      kind: 'skill',
      identity: 'verify',
      edits: [DECLARED_EDIT],
      editPayload: skillPayload(options.candidateBody ?? '# candidate: check the acceptance'),
      rationale: 'answer the observed failure',
      sourceRefs: ['diagnosis:d1'],
      expectedBaseRevision: 'r0001',
      round: 0,
      critic: { verdict: 'accept', reason: 'one mechanism, the asset parses', evidenceRefs: ['diagnosis:d1'] },
    },
    world.exec as never,
  )) as string
  const draftId = /draft (d[0-9]{4})/.exec(drafted)?.[1]
  if (draftId === undefined) throw new Error(`the fixture could not forge an evaluation: ${drafted}`)
  const ledger = await openMethodLedger({ root: world.library.root, libraryId: world.library.id })
  const view = foldMethods(ledger.records()).get(draftId)!
  const baseline = view.draft.baseRevision
  const candidate = view.draft.candidateRevision
  const cost = (tokens: number) =>
    options.cost === 'unknown'
      ? ({ status: 'unknown', reason: 'no sealed receipt reports tokens' } as const)
      : ({ status: 'reported', tokens: { uncachedInputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } as const)
  const trial = (side: 'baseline' | 'candidate') => ({
    sampleTaskId: 't1',
    side,
    role: 'observed-failure' as const,
    outcome: side === 'candidate' ? ('verified' as const) : ('failed' as const),
    receipt: {
      receiptId: `rc-${side}`,
      digest: (side === 'baseline' ? 'c' : 'd').repeat(64),
      runId: `run-${side}`,
      criteria: [],
      evidenceRefs: [],
      cost: cost(side === 'baseline' ? 150 : 140),
      boundRevision: side === 'baseline' ? baseline.revisionId : candidate.revisionId,
      boundModel: 'p/m',
      workspace: `/tmp/${side}`,
      workspaceDigest: options.publishable === true ? 'f'.repeat(64) : 'e'.repeat(64),
      complete: true,
    },
    actor: CALLER,
    at: '2026-10-08T00:00:00.000Z',
  })
  const candidateSkill =
    options.publishable === true
      ? await (async () => {
          // The candidate revision directory materializes only at publish, so the entry's digests
          // are recomputed here exactly as `applySkillEdit` computes them from the staged bytes.
          const { sha256Hex } = await import('@dangosys/dsh-singularity-task')
          const { skillContentDigest } = await import('../../../task-runtime/src/skill-contract.ts')
          const skillMd = skillText(options.candidateBody ?? '# candidate: check the acceptance')
          return {
            name: 'verify',
            role: 'execution-provider' as const,
            contractDigest: null,
            contentDigest: skillContentDigest({ skillMdSha256: sha256Hex(skillMd), resources: [] }),
          }
        })()
      : undefined
  if (options.publishable === true) {
    // The receipts the validator re-reads from the store: the digests the trials cite, the facts
    // the proofs require (the candidate side granted and really loaded the first-version skill).
    world.storeReceipts.push(
      { runId: 'run-baseline', taskId: 't1', digest: 'c'.repeat(64), completeness: { missing: [] }, skills: [], templates: [] },
      {
        runId: 'run-candidate',
        taskId: 't1',
        digest: 'd'.repeat(64),
        completeness: { missing: [] },
        skills: [{ runId: 'run-candidate', bound: [{ name: 'verify' }], loaded: ['verify'], loadedOutsideGrant: [] }],
        templates: [],
      },
    )
  }
  const model = { provider: 'p', model: 'm', label: 'p/m' }
  const sidePlan = (side: 'baseline' | 'candidate', revisionId: string, digest: string) => ({
    side,
    revision: revisionRef(revisionId, digest),
    capabilities: [],
    registryRevision: side === 'baseline' ? 'reg-1' : 'reg-2',
    mcpServers: [],
    preset: null,
    skills:
      side === 'candidate' && candidateSkill !== undefined
        ? [{ name: 'verify', role: 'execution-provider' as const, contractDigest: candidateSkill.contractDigest, contentDigest: candidateSkill.contentDigest }]
        : [],
    model,
    acceptance: [],
  })
  const plan = {
    planId: 'plan-1',
    draftId,
    kind: 'skill' as const,
    libraryId: GRAPH,
    sides: {
      baseline: sidePlan('baseline', baseline.revisionId, baseline.digest),
      candidate: sidePlan('candidate', candidate.revisionId, candidate.digest),
    },
    samples: [{ taskId: 't1', role: 'observed-failure' as const, contractDigest: '1'.repeat(64), criteria: [], observed: { outcome: 'failed' as const, runId: 'run-baseline' } }],
    input: { sourceDir: '/tmp/in', digest: 'f'.repeat(64) },
    rules: { quality: { metricId: 'acceptance', direction: 'higher-is-better' as const, extractor: 'acceptance' }, guards: [] },
    budget: {},
    repetition: 2,
    overlay: { baseline: 'a'.repeat(64), candidate: 'b'.repeat(64) },
    schemaVersion: 'evaluation-plan@1' as const,
  }
  const evaluationId = 'eval-1'
  const trials = [{ sampleTaskId: 't1', role: 'observed-failure' as const, baseline: trial('baseline'), candidate: trial('candidate'), verdict: 'fixed' as const }]
  const score =
    options.publishable === true
      ? // The publishable report's score is the one the pipeline itself recomputes from these trials.
        (
          await import('@dangosys/dsh-singularity-evolution')
        ).scoreEvaluation({ plan: plan as never, trials: trials as never, repeats: 3, noiseBand: 0.02 })
      : {
          quality: { baseline: 0, candidate: 1, delta: 1, unit: 'acceptance-success-rate' },
          cost:
            options.cost === 'unknown'
              ? ({ status: 'unknown', reason: 'no sealed receipt reports tokens' } as const)
              : ({ status: 'reported', baselineTokens: 150, candidateTokens: 140, relativeDelta: -0.0667 } as const),
          uncertainty: { basis: 'repeated-trials' as const, repeats: 3, noiseBand: 0.02 },
          inconclusive: options.cost === 'unknown',
        }
  const report = {
    formatVersion: 5 as const,
    draftId,
    evaluationId,
    planId: plan.planId,
    libraryId: GRAPH,
    kind: 'skill' as const,
    at: '2026-10-08T00:00:00.000Z',
    plan,
    planDigest: digestOf(plan),
    trials,
    score,
    guards: [],
    verdict: 'fixed' as const,
  }
  const reportPath = reportPathOf(draftId, evaluationId)
  await ledger.append({ formatVersion: 5, kind: 'plan', draftId, evaluationId, plan, planDigest: digestOf(plan), report: reportPath, actor: CALLER, at: '2026-10-08T00:00:00.000Z' })
  await ledger.append({ formatVersion: 5, kind: 'trial', draftId, evaluationId, trial: report.trials[0]!.baseline })
  await ledger.append({ formatVersion: 5, kind: 'trial', draftId, evaluationId, trial: report.trials[0]!.candidate })
  await ledger.append({
    formatVersion: 5,
    kind: 'evaluation',
    draftId,
    evaluationId,
    report: reportPath,
    reportDigest: evaluationReportDigest(report as never),
    verdict: 'fixed',
    scoreDigest: digestOf(report.score),
    actor: CALLER,
    at: '2026-10-08T00:00:00.000Z',
  })
  const absolute = join(world.library.root, reportPath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, `${JSON.stringify(report)}\n`, 'utf8')
  return { draftId, evaluationId, reportDigest: evaluationReportDigest(report as never) }
}
