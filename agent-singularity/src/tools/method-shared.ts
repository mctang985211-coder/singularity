/**
 * The method tool surface's shared seams: one environment plane, one method
 * ledger plane and the strategy's pure functions, plus the two parsers every
 * method tool runs before it does anything — which graph the caller belongs to,
 * and which mode that graph's own record puts method publication in.
 *
 * Nothing here moves an effective pointer: that is `method_publish` and
 * `method_rollback`, and the grant is what decides whether an agent holds them.
 *
 * @module @dangosys/dsh-singularity-agent/tools/method-shared
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_STRATEGY_POLICY,
  adapterFor,
  admit,
  aggregateEvaluation,
  calibrateNoise,
  cohortDigestOf,
  createDraft as createLedgerDraft,
  digestOf,
  discardDraft as discardLedgerDraft,
  editBudget as strategyEditBudget,
  environmentHomeOf,
  evaluate as evaluateDraft,
  evaluationOf as evaluationOfDraft,
  evaluationSourcesOf,
  exploration,
  foldHistory,
  foldMethods,
  markPublished as markPublishedDraft,
  markRolledback as markRolledbackDraft,
  methodList as methodListOf,
  openMethodLedger,
  refutationFor,
  renderHistory,
  revisionViewOf,
  scaleOf,
  screenBeforeMeasurement,
  sideMeasurementOf,
  stallFlag,
  strategyDecisionOf,
  validateEvaluation,
} from '@dangosys/dsh-singularity-evolution'
import type {
  Admission,
  AggregateScore,
  CandidateFact,
  CandidateMeasurement,
  CriticVerdict,
  DraftRequest,
  DraftView,
  EvaluationBudget,
  EvaluationFact,
  EvaluationReport,
  EvaluationRules,
  HistoryFacts,
  HistoryView,
  InputSnapshot,
  MechanismKind,
  MethodAssetKind,
  MethodListFilter,
  ModelSelection,
  NoiseCalibration,
  OutcomeEvaluationPlan,
  OutcomeModelCall,
  PlannedSample,
  RefutationFact,
  RevisionRef,
  Screen,
  StrategyDecisionRecord,
  StrategyPolicy,
  VersionFact,
} from '@dangosys/dsh-singularity-evolution'
import { optionalService, readEnvironmentDraft, readRevision } from '@dangosys/dsh-singularity-task-runtime'
import type {
  EnvironmentDraft,
  EnvironmentEdit,
  EnvironmentPointerIntent,
  EnvironmentPointerReconcile,
  EnvironmentRevision,
  EnvironmentView,
  LibraryRoots,
  PublishOutcome,
  PublishRequest,
} from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-graphs'

/**
 * One method change, as the console reads it off the event stream. The id is
 * whichever store moved: a draft, a published revision, or the pointer switch a
 * publication or rollback opened. The producer is the method plane; the console
 * re-reads `/singularity/methods` when one arrives rather than assembling a
 * projection from the frame.
 */
export interface MethodsChangeFrame {
  readonly draftId?: string
  readonly revisionId?: string
  readonly intentId?: string
  readonly actor?: string
  readonly at?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A method store moved: a draft, a measurement, a publication or a pointer switch. */
    'methods/change'(frame: MethodsChangeFrame): void
  }
}

/** Which decision path a graph's own record puts method publication in. */
export type MethodMode = 'auto' | 'manual'

/** Who answered a publication approval, as the ledger and the completion record it. */
export type MethodDecider = 'human' | 'operator' | 'platform_policy'

/** The tools that move a library's effective pointer; only a round supervisor's grant carries them. */
export const METHOD_AUTHORITY_TOOLS: readonly string[] = ['method_publish', 'method_rollback']

/** What a root may do with a method: look at it, and propose one. */
export const METHOD_ROOT_BASELINE: readonly string[] = ['method_list', 'method_draft']

/** The supervisor's method surface: the whole draft → evaluate → publish/discard/rollback path, plus the read. */
export const METHOD_SUPERVISOR_BASELINE: readonly string[] = [
  'method_list',
  'method_draft',
  'method_evaluate',
  'method_publish',
  'method_discard',
  'method_rollback',
]

/** The graph identity every method tool resolves from the caller's own binding. */
export interface MethodGraphView {
  readonly id: string
  readonly rootSessionId: string
  readonly libraryId: string
  readonly rsi?: { readonly humanReview?: boolean }
}

/** The environment revision plane's model-facing seam, one method per runtime entry it uses. */
export interface EnvironmentPlane {
  activeEnvironmentView(sessionId: string, options?: { readonly trialCandidateRef?: string }): Promise<EnvironmentView>
  activeRevisionFor(sessionId: string): Promise<EnvironmentRevision>
  /** The roots of the library a caller's own graph is served from — the library's own root, never the active revision's directory. */
  libraryRootsForSession(sessionId: string): Promise<LibraryRoots>
  createDraft(sessionId: string, request: { readonly basedOn?: string; readonly purpose?: string }): Promise<EnvironmentDraft>
  stageDraftEdit(sessionId: string, draftId: string, edit: EnvironmentEdit): Promise<EnvironmentDraft>
  removeEnvironmentDraft(sessionId: string, draftId: string): Promise<void>
  freezeDraft(sessionId: string, draftId: string): Promise<EnvironmentRevision>
  publishRevision(sessionId: string, request: PublishRequest): Promise<PublishOutcome>
  rollbackRevision(sessionId: string, request: PublishRequest): Promise<PublishOutcome>
  openPointerIntent(sessionId: string): Promise<EnvironmentPointerIntent | null>
  reconcilePointer(sessionId: string): Promise<EnvironmentPointerReconcile[]>
}

/** What one candidate's structure check found, and the files it changed. */
export interface PrepareStructureResult {
  readonly ok: boolean
  readonly findings: readonly string[]
  readonly change: { readonly kind: MethodAssetKind; readonly identity: string; readonly before: string | null; readonly after: string }
  readonly files: readonly { readonly path: string; readonly sha256: string }[]
}

/** What one structure check is run against: the candidate's own facts, before any ledger line exists. */
export interface PrepareStructureInput {
  readonly draftId: string
  readonly kind: MethodAssetKind
  readonly identity: string
  readonly baseRevision: RevisionRef
  readonly candidateRevision: { readonly revisionId: string; readonly digest: string }
  readonly rationale: string
  readonly sourceRefs: readonly string[]
  readonly actor: string
}

/** What one evaluation call asks the one pipeline for. */
export interface MethodEvaluateInput {
  readonly draftId: string
  /** The frozen cohort: both sides of every sample, named by the caller and never derived here. */
  readonly samples: readonly { readonly taskId: string; readonly role: PlannedSample['role'] }[]
  readonly input: InputSnapshot
  readonly rules: EvaluationRules
  readonly budget: EvaluationBudget
  readonly repetition: number
  readonly model: ModelSelection
  readonly evaluation?: OutcomeEvaluationPlan
  readonly judge?: OutcomeModelCall
  readonly maxParallel?: number
}

/** What one pre-publish re-check settled. */
export interface PrePublishVerdict {
  readonly guards: readonly { readonly id: string; readonly passed: boolean }[]
  readonly verdict: string
}

/** The method ledger plane: the v5 ledger, the one evaluation pipeline and the strategy's landed decision. */
export interface MethodLedgerPlane {
  readonly libraryId: string
  readonly root: string
  view(draftId: string): Promise<DraftView>
  list(filter?: MethodListFilter): Promise<readonly DraftView[]>
  evaluationOf(draftId: string): Promise<EvaluationReport | undefined>
  prepareStructure(input: PrepareStructureInput): Promise<PrepareStructureResult>
  createDraft(request: DraftRequest): Promise<DraftView>
  evaluate(input: MethodEvaluateInput, signal?: AbortSignal): Promise<EvaluationReport>
  decisionFor(draftId: string): Promise<StrategyDecisionRecord | undefined>
  recordDecision(report: EvaluationReport): Promise<StrategyDecisionRecord>
  validatePrePublish(report: EvaluationReport): Promise<PrePublishVerdict>
  discardDraft(input: { readonly draftId: string; readonly reason: string; readonly actor: string }): Promise<DraftView>
  markPublished(input: {
    readonly draftId: string
    readonly revisionId: string
    readonly supersededRevisionId: string | null
    readonly intentId: string
    readonly approvalRef?: string
    readonly actor: string
  }): Promise<void>
  markRolledback(input: {
    readonly draftId: string | null
    readonly revisionId: string
    readonly supersededRevisionId: string | null
    readonly intentId: string
    readonly approvalRef?: string
    readonly actor: string
  }): Promise<void>
  history(): Promise<HistoryFacts>
}

/** The one admission rule, as the strategy states it (kept here so the tool layer names the shape once). */
export interface AdmitInput {
  readonly candidate: CandidateMeasurement
  readonly incumbent: AggregateScore
  readonly incumbentScope: string
  readonly bestQuality: number
  readonly calibration: NoiseCalibration
  readonly guards: readonly string[]
  readonly policy: StrategyPolicy
}

/** The strategy's pure functions, resolved where they are used and nowhere re-implemented. */
export interface StrategyPlane {
  readonly policy: StrategyPolicy
  editBudget(round: number, policy: StrategyPolicy): number
  screenBeforeMeasurement(input: Parameters<typeof screenBeforeMeasurement>[0]): Screen
  aggregateEvaluation(input: Parameters<typeof aggregateEvaluation>[0]): AggregateScore
  calibrateNoise(evals: Parameters<typeof calibrateNoise>[0], policy: StrategyPolicy): NoiseCalibration
  admit(input: AdmitInput): Admission
  foldHistory(facts: HistoryFacts, policy: StrategyPolicy, now: number): HistoryView
  renderHistory(view: HistoryView, limit: number): ReturnType<typeof renderHistory>
  stallFlag(trajectory: readonly number[], t: number, window: number, band: number): 0 | 1
  exploration(t: number, stall: 0 | 1, tried: readonly MechanismKind[], reservedDrafts: number): ReturnType<typeof exploration>
  refutationFor(facts: HistoryFacts, libraryId: string, contentDigest: string): ReturnType<typeof refutationFor>
  criticOf(verdict: CriticVerdict | undefined): CriticVerdict | undefined
}

/** The graph registry the method tools resolve their caller through. */
interface GraphRegistry {
  graphForSession(sessionId: SessionId): Promise<{ id: string; rootSessionId: SessionId; rsi?: Record<string, unknown> | null }>
}

function graphRegistry(ctx: Context): GraphRegistry {
  const graphs = optionalService<GraphRegistry>(ctx, 'graphs')
  if (graphs === undefined) {
    throw new Error(
      'method tools: this deployment offers no graph registry, so no method tool can resolve its graph; nothing was read or changed',
    )
  }
  return graphs
}

/** The graph one caller belongs to: its identity, its library and its own method settings. */
export async function methodGraphFor(ctx: Context, caller: string): Promise<MethodGraphView> {
  const graph = await graphRegistry(ctx).graphForSession(SessionId(caller))
  const rootSessionId = String(graph.rootSessionId)
  return {
    id: String(graph.id),
    rootSessionId,
    // A library's id is its graph root's session id: the same segment the
    // environment store names its directory with.
    libraryId: rootSessionId,
    ...(graph.rsi == null ? {} : { rsi: { humanReview: graph.rsi.humanReview === true } }),
  }
}

/**
 * The whole rsi configuration one method approval binds, digested: a graph
 * whose rsi is cleared or replaced while the approval is open is not the
 * configuration the approval was granted under, and the switch refuses.
 */
export async function methodRsiStampFor(ctx: Context, caller: string): Promise<string> {
  const graph = await graphRegistry(ctx).graphForSession(SessionId(caller))
  return digestOf({ rsi: graph.rsi ?? null })
}

/** The mode one graph's record puts method publication in. Mode is never an argument. */
export async function methodModeFor(ctx: Context, caller: string): Promise<MethodMode> {
  const graph = await methodGraphFor(ctx, caller)
  return graph.rsi?.humanReview === false ? 'auto' : 'manual'
}

/** Who answers: an unmanned graph's publication is the platform policy's, not a person's. */
export function deciderFor(mode: MethodMode): MethodDecider {
  return mode === 'auto' ? 'platform_policy' : 'human'
}

/** The environment plane, resolved from the runtime alone; a deployment without one is refused by name. */
export function environmentPlaneOf(ctx: Context): EnvironmentPlane {
  const runtime = optionalService<Partial<EnvironmentPlane>>(ctx, 'taskRuntime')
  if (runtime === undefined) {
    throw new Error(
      'method tools: this deployment offers no task runtime, so no environment revision can be read or drafted; nothing was read or changed',
    )
  }
  const bind = <K extends keyof EnvironmentPlane>(member: K): EnvironmentPlane[K] => {
    const value = runtime[member]
    if (typeof value !== 'function') {
      throw new Error(
        `method tools: this deployment's task runtime offers no ${String(member)}, so the environment plane cannot answer; nothing was changed`,
      )
    }
    return (value as (...args: unknown[]) => unknown).bind(runtime) as EnvironmentPlane[K]
  }
  return {
    activeEnvironmentView: bind('activeEnvironmentView'),
    activeRevisionFor: bind('activeRevisionFor'),
    libraryRootsForSession: bind('libraryRootsForSession'),
    createDraft: bind('createDraft'),
    stageDraftEdit: bind('stageDraftEdit'),
    removeEnvironmentDraft: bind('removeEnvironmentDraft'),
    freezeDraft: bind('freezeDraft'),
    publishRevision: bind('publishRevision'),
    rollbackRevision: bind('rollbackRevision'),
    openPointerIntent: bind('openPointerIntent'),
    reconcilePointer: bind('reconcilePointer'),
  }
}

/** The strategy's pure functions, as one bundle; the policy defaults to the frozen first-version one. */
export function strategyPlaneOf(policy: StrategyPolicy = DEFAULT_STRATEGY_POLICY): StrategyPlane {
  return {
    policy,
    editBudget: (round, chosen) => strategyEditBudget(round, { rounds: chosen.rounds, ...chosen.editBudget }),
    screenBeforeMeasurement,
    aggregateEvaluation,
    calibrateNoise,
    admit,
    foldHistory,
    renderHistory,
    stallFlag,
    exploration,
    refutationFor,
    criticOf: verdict => verdict,
  }
}

/** The path one strategy decision record is written to: beside the report it recomputes from. */
export function decisionPathOf(root: string, draftId: string, evaluationId: string): string {
  return join(root, 'evaluations', draftId, evaluationId, 'strategy-decision.json')
}

/**
 * The prospective candidate revision one draft holds, read from the draft's own
 * directory. A draft the evaluation already measured was frozen instead — its
 * candidate is read with `readRevision`, and this returns undefined for it.
 */
export async function candidateRevisionOf(library: LibraryRoots, draftId: string): Promise<EnvironmentRevision | undefined> {
  const draft = await readEnvironmentDraft(library, draftId)
  if (draft === undefined) return undefined
  return {
    manifest: draft.manifest,
    root: draft.root,
    skillRoot: join(draft.root, 'skills'),
    taskTemplatesRoot: join(draft.root, 'task-templates'),
  }
}

/**
 * The method ledger plane, bound to the caller's own graph library. Every entry
 * opens the library's ledger again, so a line another process appended between
 * two calls is read rather than cached past.
 */
export async function methodLedgerPlaneOf(ctx: Context, caller: string): Promise<MethodLedgerPlane> {
  const env = environmentPlaneOf(ctx)
  const resolved = await env.libraryRootsForSession(caller)
  const library: LibraryRoots = { id: resolved.id, root: resolved.root }
  const policy = DEFAULT_STRATEGY_POLICY

  const open = async () => {
    const ledger = await openMethodLedger({ root: library.root, libraryId: library.id })
    const sources = evaluationSourcesOf({ ctx, caller, root: library.root, libraryId: library.id, ledger })
    return { ledger, sources }
  }

  const viewOf = async (draftId: string): Promise<DraftView> => {
    const { ledger } = await open()
    const view = foldMethods(ledger.records()).get(draftId)
    if (view === undefined) throw new Error(`evolution: unknown draft "${draftId}"`)
    return view
  }

  const reportOf = async (view: DraftView): Promise<EvaluationReport | undefined> => {
    if (view.evaluation === undefined) return undefined
    const { sources } = await open()
    return await evaluationOfDraft(sources, view.draft.draftId)
  }

  /**
   * Announce one method change on the deployment's event bus, after the write
   * that caused it has landed and never before. The console subscribes to it and
   * re-reads `/singularity/methods`; the projection is never assembled here.
   */
  const announce = (frame: MethodsChangeFrame): void => {
    ctx.emit('methods/change', frame)
  }

  return {
    libraryId: library.id,
    root: library.root,
    view: viewOf,
    async list(filter) {
      const { sources } = await open()
      return methodListOf(sources, filter)
    },
    async evaluationOf(draftId) {
      const view = await viewOf(draftId)
      return await reportOf(view)
    },
    async prepareStructure(input) {
      return await prepareStructureFor(library, input)
    },
    async createDraft(request) {
      const { ledger } = await open()
      const created = await createLedgerDraft(ledger, request)
      announce({ draftId: created.draft.draftId, actor: created.draft.actor, at: created.draft.at })
      return created
    },
    async evaluate(input, signal) {
      // The pipeline reads both sides from frozen revision directories, so an
      // unevaluated draft's candidate is frozen here, once, before the first
      // trial: measurement never runs against a directory that can still move.
      const view = await viewOf(input.draftId)
      if (view.evaluation === undefined && (await readRevision(library, view.draft.candidateRevision.revisionId)) === undefined) {
        await env.freezeDraft(caller, input.draftId)
      }
      const { sources } = await open()
      const report = await evaluateDraft(sources, {
        draftId: input.draftId,
        samples: input.samples,
        input: input.input,
        model: input.model,
        rules: input.rules,
        budget: input.budget,
        repetition: input.repetition,
        ...(input.evaluation === undefined ? {} : { evaluation: input.evaluation }),
        ...(input.judge === undefined ? {} : { judge: input.judge }),
        ...(signal === undefined ? {} : { signal }),
        ...(input.maxParallel === undefined ? {} : { maxParallel: input.maxParallel }),
        policy,
        actor: caller,
      })
      announce({ draftId: report.draftId, actor: caller, at: report.at })
      return report
    },
    async decisionFor(draftId) {
      const view = await viewOf(draftId)
      if (view.evaluation === undefined) return undefined
      return await readDecision(decisionPathOf(library.root, draftId, view.evaluation.evaluationId))
    },
    async recordDecision(report) {
      const decision = deriveDecision(report, policy)
      await writeJson(decisionPathOf(library.root, report.draftId, report.evaluationId), decision)
      return decision
    },
    async validatePrePublish(report) {
      const { sources } = await open()
      const outcome = await validateEvaluation({ report, sources, mode: 'pre-publish' })
      return {
        guards: outcome.guards.map(guard => ({ id: guard.id, passed: guard.ok })),
        verdict: outcome.verdict,
      }
    },
    async discardDraft(input) {
      const { ledger } = await open()
      const discarded = await discardLedgerDraft(ledger, input)
      const at = discarded.history[discarded.history.length - 1]?.at ?? new Date().toISOString()
      announce({ draftId: discarded.draft.draftId, actor: input.actor, at })
      return discarded
    },
    async markPublished(input) {
      const { sources } = await open()
      await markPublishedDraft(sources, input)
      announce({
        draftId: input.draftId,
        revisionId: input.revisionId,
        intentId: input.intentId,
        actor: input.actor,
        at: new Date().toISOString(),
      })
    },
    async markRolledback(input) {
      const { sources } = await open()
      await markRolledbackDraft(sources, input)
      announce({
        ...(input.draftId === null ? {} : { draftId: input.draftId }),
        revisionId: input.revisionId,
        intentId: input.intentId,
        actor: input.actor,
        at: new Date().toISOString(),
      })
    },
    async history() {
      const { ledger, sources } = await open()
      return await historyFactsOf(ledger, sources, policy)
    },
  }
}

/** One library's drafts, its reports and its versions, as the strategy's history folds them. */
async function historyFactsOf(
  ledger: Awaited<ReturnType<typeof openMethodLedger>>,
  sources: Parameters<typeof methodListOf>[0],
  policy: StrategyPolicy,
): Promise<HistoryFacts> {
  const views = [...foldMethods(ledger.records()).values()]
  const candidates: CandidateFact[] = views.map((view, index) => ({
    candidateId: view.draft.draftId,
    libraryId: view.libraryId,
    contentDigest: view.draft.candidateRevision.digest,
    round: index,
    // The v5 draft line carries the candidate's identity, not the model's
    // declared edits: the ledger keeps no second copy of a hypothesis the report
    // already froze.
    edits: [],
  }))
  const roundOf = new Map(candidates.map(candidate => [candidate.candidateId, candidate.round]))
  const evaluations: EvaluationFact[] = []
  const refutations: RefutationFact[] = []
  const versions: VersionFact[] = []
  for (const view of views) {
    const draftId = view.draft.draftId
    const round = roundOf.get(draftId) ?? 0
    if (view.evaluation !== undefined) {
      const report = await evaluationOfDraft(sources, draftId)
      evaluations.push({
        candidateId: draftId,
        scope: cohortDigestOf(report),
        measurement: sideMeasurementOf({ report, side: 'candidate', scale: scaleOf(report), policy }),
        verdict: report.verdict,
        evidenceRefs: [report.evaluationId],
      })
      const decision = await readDecision(decisionPathOf(ledger.root, draftId, report.evaluationId))
      const admission = decision?.admissions.find(entry => entry.candidateId === draftId)
      if (admission !== undefined && !admission.admissible) {
        refutations.push({
          candidateId: draftId,
          contentDigest: view.draft.candidateRevision.digest,
          reasonCode: admission.reasonCode,
          reason: admission.reason,
          evidenceRefs: [report.evaluationId],
          round,
        })
      }
    } else if (view.status === 'discarded') {
      refutations.push({
        candidateId: draftId,
        contentDigest: view.draft.candidateRevision.digest,
        reasonCode: 'not-measured',
        reason: view.discardReason ?? 'discarded without an evaluation',
        evidenceRefs: [],
        round,
      })
    }
    if (view.published !== undefined) {
      versions.push({ round, libraryId: view.libraryId, revisionId: view.published.revisionId, contentDigest: view.draft.candidateRevision.digest })
    }
  }
  return { candidates, evaluations, consumption: [], refutations, versions }
}

async function readDecision(path: string): Promise<StrategyDecisionRecord | undefined> {
  return await readJson<StrategyDecisionRecord>(path)
}

async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`evolution: ${path} is not readable JSON`)
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`, 'utf8')
}

/**
 * The structure check one candidate runs before anything measures it: the
 * adapter parses the asset the draft claims to change, against the frozen
 * baseline, and a shape it cannot represent is a refusal by name rather than a
 * finding nobody reads.
 */
async function prepareStructureFor(library: LibraryRoots, input: PrepareStructureInput): Promise<PrepareStructureResult> {
  const change = { kind: input.kind, identity: input.identity, before: null as string | null, after: input.candidateRevision.digest }
  // The candidate is the draft's own directory (only the pointer transaction
  // freezes it into a revision); the baseline is the revision it was written
  // against.
  const staged = await readEnvironmentDraft(library, input.draftId)
  const baseline = await readRevision(library, input.baseRevision.revisionId)
  if (staged === undefined || baseline === undefined) {
    return { ok: false, findings: ['the draft or its baseline revision is absent from the library'], change, files: [] }
  }
  const candidate: EnvironmentRevision = {
    manifest: staged.manifest,
    root: staged.root,
    skillRoot: join(staged.root, 'skills'),
    taskTemplatesRoot: join(staged.root, 'task-templates'),
  }
  const draft = {
    draftId: input.draftId,
    kind: input.kind,
    identity: input.identity,
    baseRevision: input.baseRevision,
    candidateRevision: { ...input.candidateRevision, files: [] },
    rationale: input.rationale,
    sourceRefs: [...input.sourceRefs],
    actor: input.actor,
    at: new Date().toISOString(),
  }
  try {
    const prepared = await adapterFor(input.kind).prepare({
      draft,
      revision: revisionViewOf(candidate),
      baseline: revisionViewOf(baseline),
    })
    return {
      ok: true,
      findings: [],
      change: prepared.change,
      files: prepared.files.map(file => ({ path: file.path, sha256: file.sha256 })),
    }
  } catch (error) {
    return {
      ok: false,
      findings: [error instanceof Error ? error.message : String(error)],
      change,
      files: [],
    }
  }
}

/** The one decision record a report yields, from the report's own baseline reading and the frozen policy. */
function deriveDecision(report: EvaluationReport, policy: StrategyPolicy): StrategyDecisionRecord {
  const scale = scaleOf(report)
  const baseline = sideMeasurementOf({ report, side: 'baseline', scale, policy })
  const incumbent = aggregateEvaluation(baseline)
  const calibration = calibrateNoise([baseline], policy)
  const history = foldHistory({ candidates: [], evaluations: [], consumption: [], refutations: [], versions: [] }, policy, 0)
  const guards = report.guards.filter(guard => !guard.ok).map(guard => guard.id)
  return strategyDecisionOf({
    report,
    policy,
    incumbent,
    bestQuality: incumbent.quality,
    calibration,
    history,
    guards,
    at: new Date().toISOString(),
  })
}
