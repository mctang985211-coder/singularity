/**
 * The console's method read surface: the effective revision, every draft with the
 * evaluation it settled and the admission it was given, the publication approvals
 * still waiting for an answer, and the pointer switch an operator is watching.
 *
 * Every fact comes from the same two stores the `method_*` tools read — the
 * library's v5 method ledger and the environment revision plane — and the
 * graph-level projection is the one `GraphViewService` hands out, so what the
 * console shows and what a model is told cannot drift apart. Nothing here writes
 * and nothing here decides: a publication is answered through the existing HITL
 * card (`POST /singularity/hitl`), whose body is the text `method_publish`
 * rendered — a second publication path is exactly the duplicate this refactor
 * removes.
 *
 * @module @dangosys/dsh-singularity-graph-web/web/api/methods
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_STRATEGY_POLICY,
  cohortDigestOf,
  evaluationOf,
  evaluationSourcesOf,
  foldHistory,
  methodList,
  openMethodLedger,
  scaleOf,
  sideMeasurementOf,
} from '@dangosys/dsh-singularity-evolution'
import type {
  Admission,
  CandidateFact,
  DraftView,
  EvaluationFact,
  EvaluationPlan,
  EvaluationReport,
  EvaluationSources,
  HistoryFacts,
  HistoryView,
  MethodAssetKind,
  MethodListFilter,
  RefutationFact,
  StrategyDecisionRecord,
  TrialResult,
  VersionFact,
} from '@dangosys/dsh-singularity-evolution'
import type {} from '@dangosys/dsh-singularity-graphs'
import type { GraphViewWire } from '@dangosys/dsh-singularity-graphs/wire'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import { readEnvironmentDraft, readRevision } from '@dangosys/dsh-singularity-task-runtime'
import type {
  EnvironmentLibrary,
  EnvironmentPointerIntent,
  EnvironmentView,
  LibraryRoots,
} from '@dangosys/dsh-singularity-task-runtime'
import type { MethodsChangeFrame } from '@dangosys/dsh-singularity-agent'
import { fail, graphIdOf, guardMethod, messageOf, sendJson, urlOf } from '../libs/http.ts'

/**
 * The one wire shape a method change carries. The producer — the method plane in
 * `@dangosys/dsh-singularity-agent` — declares both the shape and the
 * `methods/change` event, so this boundary re-exports the type rather than
 * declaring a second copy that could drift.
 */
export type { MethodsChangeFrame }

export const METHODS_PATH = '/singularity/methods'

/** The SSE frame name a method change is broadcast under, beside `hitl` and `task`. */
export const METHODS_EVENT = 'methods'

/** The statuses and asset classes this surface filters by, exactly as `method_list` does. */
const STATUSES: readonly DraftView['status'][] = ['draft', 'evaluated', 'discarded', 'published']
const KINDS: readonly MethodAssetKind[] = ['skill', 'task-template', 'capability']

/** The file a draft's landed strategy decision sits in: beside the report it recomputes from. */
const DECISION_FILE = 'strategy-decision.json'

/** Revision-directory bookkeeping no asset difference counts as an asset. */
const METADATA_FILES = new Set(['manifest.json', 'draft.json'])

/** The one SSE sink a method change is published to; `GraphBroadcast` satisfies it. */
export interface MethodBroadcaster {
  publishEvent(name: string, value: unknown): void
}

/** The graph registry this boundary resolves a library through. */
interface GraphRegistry {
  get(graphId: string): Promise<{ readonly id: string; readonly rootSessionId: string }>
}

/** The environment plane's read entries, resolved from the runtime alone. */
interface MethodEnvironment {
  libraryForSession(sessionId: string): Promise<EnvironmentLibrary>
  activeEnvironmentView(sessionId: string): Promise<EnvironmentView>
  openPointerIntent(sessionId: string): Promise<EnvironmentPointerIntent | null>
}

/** The one projection of a graph's read state, as `GraphViewService` serves it. */
interface GraphViewReader {
  view(graphId: string): Promise<GraphViewWire>
}

/** The slice of a HITL card this boundary reads: a rendered approval awaiting an answer. */
interface HitlCard {
  readonly id: string
  readonly kind: string
  readonly prompt: string
  readonly sessionId: string
  readonly createdAt: number
}

/** One publication approval a person has not answered yet. */
export interface PublicationApproval {
  readonly id: string
  readonly sessionId: string
  readonly createdAt: number
  readonly prompt: string
}

/** One draft as the console reads it: the ledger's own view, plus the admission it was given. */
export interface MethodDraftWire {
  readonly draftId: string
  readonly kind: MethodAssetKind
  readonly identity: string
  readonly status: DraftView['status']
  readonly baseRevision: DraftView['draft']['baseRevision']
  readonly candidateRevision: DraftView['draft']['candidateRevision']
  readonly rationale: string
  readonly sourceRefs: readonly string[]
  readonly actor: string
  readonly at: string
  /** The evaluation the ledger records for this draft — identity and verdict, never a recomputation. */
  readonly evaluation: DraftView['evaluation'] | null
  readonly admission: Admission | null
  readonly published: DraftView['published'] | null
  readonly rolledback: DraftView['rolledback'] | null
  readonly discardReason: string | null
  /** How many settled sides the ledger records for this draft; the report pairs them per sample. */
  readonly trialSides: number
  /** Every record that moved this draft, oldest first. */
  readonly trail: DraftView['history']
}

/** One file of a candidate's difference against the revision it was written against. */
export interface RevisionFileDiffFile {
  readonly path: string
  readonly change: 'added' | 'updated' | 'removed'
  readonly sha256: string
}

/**
 * The candidate's difference at file identity level. The unified text of the same
 * difference is the approval card's, rendered once by `renderPublishReason` — the
 * console reads that card through `/singularity/hitl` rather than a second copy.
 */
export interface RevisionFileDiff {
  readonly from: string | null
  readonly to: string
  readonly files: readonly RevisionFileDiffFile[]
  readonly digest: string
}

export interface MethodsListPayload {
  readonly graphId: string
  readonly libraryId: string
  /** The effective version, as the method tools read it through the environment plane. */
  readonly environment: EnvironmentView
  readonly drafts: readonly MethodDraftWire[]
  readonly history: HistoryView
  /** The pointer switch that is in flight, if any; a retry of its publication continues it. */
  readonly intent: EnvironmentPointerIntent | null
  readonly approvals: readonly PublicationApproval[]
  /** The graph-level projection, when this deployment's `GraphViewService` can answer. */
  readonly view: GraphViewWire | null
  /** Why the graph-level projection could not answer; never a default standing in for one. */
  readonly viewRefusal: string | null
}

export interface MethodDetailPayload {
  readonly graphId: string
  readonly libraryId: string
  readonly environment: EnvironmentView
  readonly status: DraftView['status']
  readonly draft: DraftView['draft']
  readonly plan: EvaluationPlan | null
  readonly planDigest: string | null
  readonly trials: readonly TrialResult[]
  readonly evaluation: DraftView['evaluation'] | null
  /** The report the evaluation settled, read back and checked against the ledger's own digest. */
  readonly report: EvaluationReport | null
  readonly decision: StrategyDecisionRecord | null
  readonly admission: Admission | null
  readonly diff: RevisionFileDiff | null
  readonly intent: EnvironmentPointerIntent | null
}

function graphRegistryOf(ctx: Context): GraphRegistry {
  const graphs = optionalService<GraphRegistry>(ctx, 'graphs')
  if (graphs === undefined) {
    throw new Error('methods: this deployment offers no graph registry, so a graph id cannot be resolved to its library')
  }
  return graphs
}

function methodEnvironmentOf(ctx: Context): MethodEnvironment {
  const runtime = optionalService<Partial<MethodEnvironment>>(ctx, 'taskRuntime')
  if (runtime === undefined) {
    throw new Error('methods: this deployment offers no task runtime, so no revision, draft or pointer can be read')
  }
  const bind = <K extends keyof MethodEnvironment>(member: K): MethodEnvironment[K] => {
    const value = runtime[member]
    if (typeof value !== 'function') {
      throw new Error(`methods: this deployment's task runtime offers no ${String(member)}, so the library cannot be read`)
    }
    return (value as (...args: unknown[]) => unknown).bind(runtime) as MethodEnvironment[K]
  }
  return {
    libraryForSession: bind('libraryForSession'),
    activeEnvironmentView: bind('activeEnvironmentView'),
    openPointerIntent: bind('openPointerIntent'),
  }
}

/**
 * The graph-level projection, or the reason it could not answer. A projection
 * that names a missing fact producer is reported as such: the console shows the
 * pointer facts this boundary read itself and the refusal beside nothing, never a
 * default that looks like a view.
 */
async function graphViewOf(
  ctx: Context,
  graphId: string,
): Promise<{ readonly view: GraphViewWire | null; readonly refusal: string | null }> {
  const service = optionalService<GraphViewReader>(ctx, 'singularityGraphView')
  if (service === undefined) {
    return { view: null, refusal: 'no graph view service is mounted in this deployment' }
  }
  try {
    return { view: await service.view(graphId), refusal: null }
  } catch (error) {
    return { view: null, refusal: messageOf(error) }
  }
}

/**
 * The publication approvals this process is holding an answer for. A publication
 * approval is one HITL card, and its body is the text the tool rendered, so the
 * card that names a publication is read off that text rather than a second store.
 */
function publicationApprovals(ctx: Context): readonly PublicationApproval[] {
  const hitl = optionalService<{ list(): readonly HitlCard[] }>(ctx, 'hitl')
  if (hitl === undefined) return []
  return hitl
    .list()
    .filter(
      card =>
        card.kind === 'approve' &&
        (card.prompt.startsWith('Method publish for ') || card.prompt.startsWith('Method rollback of library ')),
    )
    .map(card => ({ id: card.id, sessionId: card.sessionId, createdAt: card.createdAt, prompt: card.prompt }))
}

/** The landed strategy decision of one draft, read where the strategy writes it. */
async function decisionOf(root: string, view: DraftView): Promise<StrategyDecisionRecord | undefined> {
  if (view.evaluation === undefined) return undefined
  const path = join(dirname(resolve(root, view.evaluation.reportPath)), DECISION_FILE)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return JSON.parse(text) as StrategyDecisionRecord
}

/**
 * The compact history the strategy folds, from the same facts the `method_list`
 * tool assembles: the drafts of the v5 ledger, the reports they settled, the
 * landed admissions and the revisions this library published. The v5 draft line
 * carries no declared edits — the report already froze the hypothesis — so the
 * candidate facts carry none here either.
 */
async function historyOf(input: {
  readonly sources: EvaluationSources
  readonly libraryId: string
  readonly drafts: readonly DraftReading[]
}): Promise<HistoryView> {
  const policy = DEFAULT_STRATEGY_POLICY
  const candidates: CandidateFact[] = input.drafts.map(({ view }, round) => ({
    candidateId: view.draft.draftId,
    libraryId: input.libraryId,
    contentDigest: view.draft.candidateRevision.digest,
    round,
    edits: [],
  }))
  const evaluations: EvaluationFact[] = []
  const refutations: RefutationFact[] = []
  const versions: VersionFact[] = []
  for (const [round, { view, admission }] of input.drafts.entries()) {
    const draftId = view.draft.draftId
    if (view.evaluation !== undefined) {
      const report = await evaluationOf(input.sources, draftId)
      evaluations.push({
        candidateId: draftId,
        scope: cohortDigestOf(report),
        measurement: sideMeasurementOf({ report, side: 'candidate', scale: scaleOf(report), policy }),
        verdict: report.verdict,
        evidenceRefs: [report.evaluationId],
      })
      if (admission !== null && !admission.admissible) {
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
      versions.push({
        round,
        libraryId: input.libraryId,
        revisionId: view.published.revisionId,
        contentDigest: view.draft.candidateRevision.digest,
      })
    }
  }
  const facts: HistoryFacts = { candidates, evaluations, consumption: [], refutations, versions }
  return foldHistory(facts, policy, candidates.length)
}

/** One draft the ledger holds, with the admission it was given. */
interface DraftReading {
  readonly view: DraftView
  readonly decision: StrategyDecisionRecord | undefined
  readonly admission: Admission | null
}

/** Everything the console reads of one graph's library, from the two stores the tools read. */
interface LibraryReading {
  readonly libraryId: string
  readonly root: string
  readonly environment: EnvironmentView
  readonly drafts: readonly DraftReading[]
  readonly history: HistoryView
  readonly intent: EnvironmentPointerIntent | null
  readonly view: GraphViewWire | null
  readonly viewRefusal: string | null
  readonly sources: EvaluationSources
}

async function readLibrary(ctx: Context, graphId: string, filter: MethodListFilter): Promise<LibraryReading> {
  const graph = await graphRegistryOf(ctx).get(graphId)
  const caller = String(graph.rootSessionId)
  const env = methodEnvironmentOf(ctx)
  // The caller is the graph's own root session: every method surface of one
  // graph resolves to the one library this call reads.
  const resolved = await env.libraryForSession(caller)
  const library: LibraryRoots = { id: resolved.id, root: resolved.root }
  const [environment, intent, projection] = await Promise.all([
    env.activeEnvironmentView(caller),
    env.openPointerIntent(caller),
    graphViewOf(ctx, graphId),
  ])
  // A graph under the legacy layout has history instead of a v5 ledger, and that
  // history is served by exactly one route.
  if (environment.protocol === 'legacy') {
    throw new Error(
      `methods: library "${environment.libraryId}" holds the legacy mutable layout, so it has a legacy method ledger and no v5 drafts; ` +
        `its history is read through GET /singularity/graphs/${graphId}/history`,
    )
  }
  const ledger = await openMethodLedger({ root: library.root, libraryId: library.id })
  const sources = evaluationSourcesOf({ ctx, caller, root: library.root, libraryId: library.id, ledger })
  // The history folds every draft of the library — the tool's own read does the
  // same, so a filter narrows the list the console shows, never the history it
  // reads the rounds and the stall count from.
  const everyDraft = methodList(sources, {})
  const readings = new Map<string, DraftReading>()
  for (const view of everyDraft) {
    const decision = await decisionOf(library.root, view)
    readings.set(view.draft.draftId, {
      view,
      decision,
      admission: decision?.admissions.find(entry => entry.candidateId === view.draft.draftId) ?? null,
    })
  }
  const shown = filter.kind === undefined && filter.status === undefined ? everyDraft : methodList(sources, filter)
  const drafts = shown.map(view => readings.get(view.draft.draftId)!)
  return {
    libraryId: library.id,
    root: library.root,
    environment,
    drafts,
    history: await historyOf({ sources, libraryId: library.id, drafts: [...readings.values()] }),
    intent,
    view: projection.view,
    viewRefusal: projection.refusal,
    sources,
  }
}

function draftWire(reading: DraftReading): MethodDraftWire {
  const { draft } = reading.view
  return {
    draftId: draft.draftId,
    kind: draft.kind,
    identity: draft.identity,
    status: reading.view.status,
    baseRevision: draft.baseRevision,
    candidateRevision: draft.candidateRevision,
    rationale: draft.rationale,
    sourceRefs: draft.sourceRefs,
    actor: draft.actor,
    at: draft.at,
    evaluation: reading.view.evaluation ?? null,
    admission: reading.admission,
    published: reading.view.published ?? null,
    rolledback: reading.view.rolledback ?? null,
    discardReason: reading.view.discardReason ?? null,
    trialSides: reading.view.trials.length,
    trail: reading.view.history,
  }
}

/** One revision directory's files by path; the ledger's own bookkeeping is not an asset. */
async function fileDigestsOf(root: string, prefix = ''): Promise<Map<string, string>> {
  let entries
  try {
    entries = await readdir(join(root, prefix), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  const files = new Map<string, string>()
  for (const entry of entries) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      for (const [nested, digest] of await fileDigestsOf(root, path)) files.set(nested, digest)
      continue
    }
    if (!entry.isFile() || METADATA_FILES.has(path)) continue
    files.set(path, createHash('sha256').update(await readFile(join(root, path))).digest('hex'))
  }
  return files
}

/** The candidate's difference at file identity level, in path order. */
async function fileDiffOf(input: {
  readonly from: string | null
  readonly fromRoot: string | null
  readonly to: string
  readonly toRoot: string
}): Promise<RevisionFileDiff> {
  const before = input.fromRoot === null ? new Map<string, string>() : await fileDigestsOf(input.fromRoot)
  const after = await fileDigestsOf(input.toRoot)
  const files: RevisionFileDiffFile[] = []
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(path)
    const now = after.get(path)
    if (was !== undefined && was === now) continue
    if (was === undefined) files.push({ path, change: 'added', sha256: now! })
    else if (now === undefined) files.push({ path, change: 'removed', sha256: was })
    else files.push({ path, change: 'updated', sha256: now })
  }
  return {
    from: input.from,
    to: input.to,
    files,
    digest: createHash('sha256')
      .update(files.map(file => `${file.change} ${file.path} ${file.sha256}`).join('\n'))
      .digest('hex'),
  }
}

/**
 * The candidate's difference against the revision it was written against. A
 * draft that already published is read from the frozen revision the pointer
 * holds; a draft still staged is read from its own directory, which only the
 * pointer transaction freezes.
 */
async function diffOf(library: LibraryRoots, view: DraftView): Promise<RevisionFileDiff | null> {
  const candidate =
    view.published === undefined
      ? await readEnvironmentDraft(library, view.draft.draftId)
      : await readRevision(library, view.published.revisionId)
  if (candidate === undefined) return null
  const baseline = await readRevision(library, view.draft.baseRevision.revisionId)
  return await fileDiffOf({
    from: view.draft.baseRevision.revisionId,
    fromRoot: baseline?.root ?? null,
    to: candidate.manifest.revisionId,
    toRoot: candidate.root,
  })
}

/** The draft filter one request asks for, refusing an unknown enum value by name. */
function filterOf(req: IncomingMessage): MethodListFilter {
  const params = urlOf(req).searchParams
  const kind = params.get('kind')
  if (kind !== null && kind.length > 0 && !KINDS.includes(kind as MethodAssetKind)) {
    throw new Error(`methods: unknown kind "${kind}"; this surface serves ${KINDS.join(', ')}`)
  }
  const status = params.get('status')
  if (status !== null && status.length > 0 && !STATUSES.includes(status as DraftView['status'])) {
    throw new Error(`methods: unknown status "${status}"; this surface serves ${STATUSES.join(', ')}`)
  }
  return {
    ...(kind === null || kind.length === 0 ? {} : { kind: kind as MethodAssetKind }),
    ...(status === null || status.length === 0 ? {} : { status: status as DraftView['status'] }),
  }
}

/** The graph id one request names; a request without one is refused rather than answered for the selected graph. */
function graphIdOrFail(req: IncomingMessage, res: ServerResponse): string | undefined {
  try {
    return graphIdOf(req, 'methods')
  } catch (error) {
    fail(res, error)
    return undefined
  }
}

async function serveList(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const graphId = graphIdOrFail(req, res)
  if (graphId === undefined) return
  let filter: MethodListFilter
  try {
    filter = filterOf(req)
  } catch (error) {
    fail(res, error)
    return
  }
  try {
    const reading = await readLibrary(ctx, graphId, filter)
    const payload: MethodsListPayload = {
      graphId,
      libraryId: reading.libraryId,
      environment: reading.environment,
      drafts: reading.drafts.map(draftWire),
      history: reading.history,
      intent: reading.intent,
      approvals: publicationApprovals(ctx),
      view: reading.view,
      viewRefusal: reading.viewRefusal,
    }
    sendJson(res, 200, payload)
  } catch (error) {
    fail(res, error)
  }
}

async function serveDetail(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const graphId = graphIdOrFail(req, res)
  if (graphId === undefined) return
  const draftId = decodeURIComponent(urlOf(req).pathname.slice(METHODS_PATH.length + 1))
  if (draftId.length === 0 || draftId.includes('/')) {
    sendJson(res, 404, { error: `methods: unknown path ${urlOf(req).pathname}` })
    return
  }
  try {
    const reading = await readLibrary(ctx, graphId, {})
    const found = reading.drafts.find(entry => entry.view.draft.draftId === draftId)
    if (found === undefined) {
      sendJson(res, 404, { error: `methods: unknown draft "${draftId}"` })
      return
    }
    const report =
      found.view.evaluation === undefined ? null : await evaluationOf(reading.sources, draftId)
    const payload: MethodDetailPayload = {
      graphId,
      libraryId: reading.libraryId,
      environment: reading.environment,
      status: found.view.status,
      draft: found.view.draft,
      plan: found.view.plan ?? null,
      planDigest: found.view.planDigest ?? null,
      trials: found.view.trials,
      evaluation: found.view.evaluation ?? null,
      report,
      decision: found.decision ?? null,
      admission: found.admission,
      diff: await diffOf({ id: reading.libraryId, root: reading.root }, found.view),
      intent: reading.intent,
    }
    sendJson(res, 200, payload)
  } catch (error) {
    fail(res, error)
  }
}

/**
 * The read routes: the library's method state, and one draft's evaluation. Both
 * are `GET` only — the console answers a publication through the HITL card the
 * tool already opened, and a second write path is what the refactor removes.
 */
export function registerMethods(ctx: Context): () => void {
  const stopList = ctx.webServer.register({
    kind: 'exact',
    path: METHODS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      await serveList(ctx, req, res)
    },
  })

  const stopDetail = ctx.webServer.register({
    kind: 'prefix',
    path: METHODS_PATH,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (!guardMethod(req, res, 'GET')) return
      await serveDetail(ctx, req, res)
    },
  })

  return () => {
    stopList()
    stopDetail()
  }
}

/**
 * Forward every method change onto the event stream, as `evolution/change` was
 * forwarded: the console re-reads `/singularity/methods` when one arrives.
 */
export function subscribeMethods(ctx: Context, broadcast: MethodBroadcaster): () => void {
  return ctx.on('methods/change', frame => broadcast.publishEvent(METHODS_EVENT, frame))
}
