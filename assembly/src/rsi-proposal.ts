import { nativeEventRef, type NativeEventRef } from '../../src/review/evidence.ts'
import { searchHistory } from './rsi-history.ts'
import { sealedBytes } from './sealed.ts'
import { readFile } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import { structuralEditsOf, structuralEditDetailsOf } from '../../src/strategy/edits.ts'
import type { StructuralEdit } from '../../src/strategy/protocol.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { taskRelations } from '../../src/task/tree.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import type { Domain } from './domain.ts'
import { taskStateOf } from './apparatus.ts'
import { assertImprovementOwner } from './improvement.ts'
import {
  assertMethodShape,
  createMethod,
  loadMethod,
  parseMethod,
  methodEnvironment,
  bindingsForContract,
  type MethodAssets,
} from './method.ts'
import type { Suite } from '../../src/measure/suite.ts'
import { assertActive } from './coordination.ts'
import { readForAgent } from './read.ts'
import { reviewSubject } from './review.ts'
import { assertRunFile } from './workspace.ts'
import { inside, list, record, text } from './shape.ts'
import { sha256 } from './ids.ts'
import {
  rsiDesignReference,
  rsiAnalysisRules,
  rsiProposalRules,
  rsiCriticRequirements,
  rsiProposalCriteria,
} from './rsi-policy.ts'

/** Proposal metadata is frozen in the native review subject, never in the business method. */
export type RsiEvidence = NativeEventRef
interface FailureMode {
  readonly mode: string
  readonly description: string
  readonly needed_instead: string
  readonly evidence: readonly RsiEvidence[]
}
interface CapabilityGap {
  readonly gap: string
  readonly description: string
  readonly evidence: readonly RsiEvidence[]
}
interface SuccessHabit {
  readonly habit: string
  readonly description: string
  readonly risk_if_broken: string
  readonly evidence: readonly RsiEvidence[]
}
export interface RsiProposal {
  readonly analysis: {
    readonly failure_modes: readonly FailureMode[]
    readonly capability_gaps: readonly CapabilityGap[]
    readonly success_habits: readonly SuccessHabit[]
  }
  readonly edit: {
    readonly hypothesis: string
    readonly targets_mode: string
    readonly trigger_condition: string
    readonly changes: readonly StructuralEdit[]
    readonly predicted_affected: readonly string[]
    readonly predicted_cases: readonly string[]
    readonly predicted_families: readonly string[]
    readonly regression_risk: string
  }
  readonly method: MethodAssets
}

export const RSI_PROPOSAL_FORMAT = `Fill search.authoring.proposal and save a proposal JSON file. Replace <...> and evidence eventSeq:null with observed data; remove unobserved finding rows.
{analysis:{failure_modes:FailureMode[],capability_gaps:CapabilityGap[],success_habits:SuccessHabit[]},edit:Edit}. There is no top-level method field: the host applies your edits to the current assets.
Evidence = {sessionId:string,eventSeq:integer,rootId?:string,from?:integer,count?:integer}. Read trajectory ref=sessionId to select a real index seq; copy it into REQUIRED eventSeq and read that event. from/count alone is an index range, not evidence. For historical evidence also copy rootId. The critic sees only the cited UTF-8 page (from defaults to 0, count to 8192; from>=0, count 4..8192); select sufficient bytes.
FailureMode = {mode:string,description:string,needed_instead:string,evidence:Evidence[]}.
CapabilityGap = {gap:string,description:string,evidence:Evidence[]}.
SuccessHabit = {habit:string,description:string,risk_if_broken:string,evidence:Evidence[]}.
At least one evidenced finding is needed; other lists may be []. Names must be unique across all three lists; targets_mode copies one exact name. Keep mechanisms reusable; public domain knowledge with sources is allowed, task-instance details stay in evidence.
Edit = {hypothesis:string,targets_mode:string,trigger_condition:string,changes:{asset:'workflow'|'template'|'skill'|'tool',target:string,value:string|object|null}[],predicted_affected:string[],predicted_cases?:string[],predicted_families?:string[],regression_risk:string}.
Each change must alter one unique asset. workflow target='workflowGuidance', value=the new string. template target=id, skill/tool target=name: value contains only changed fields, merged with the existing asset; new assets require all fields from the method format. Omitted fields/assets remain byte-for-byte unchanged; arrays within value replace that field. value:null deletes the named asset (workflow becomes empty); a null field deletes that optional field. Never include template initial: source belongs to frozen Tasks. Root inputs/artifact/criteria/checks remain frozen. Example: changes:[{asset:'template',target:'root',value:{guidance:'Delegate one bounded implementation.'}}]. A new Skill/Tool also needs a reachable contract/template binding; merely storing it does not make agents use it.
predicted_affected contains nonempty unique actual Task IDs in the cited workflow, not Run/session/agent IDs. A downstream Task need not have started or have its own cited session. With a suite, predicted_cases and/or predicted_families must name at least one evolve ID from search.cases; otherwise [] is legal. Do not add task answers or proposal metadata to method assets.`

/** The author supplies edits and evidence; the host owns the complete Method. */
export function rsiProposalTemplate() {
  return {
    analysis: {
      failure_modes: [
        {
          mode: '<unique-finding-name>',
          description: '<observed reusable failure mechanism>',
          needed_instead: '<needed behavior, separate from the proposed implementation>',
          evidence: [{ sessionId: '<sessionId from subject or readable history>', eventSeq: null }],
        },
      ],
      capability_gaps: [],
      success_habits: [],
    },
    edit: {
      hypothesis: '<one attributable mechanism>',
      targets_mode: '<unique-finding-name>',
      trigger_condition: '<observable condition>',
      changes: [],
      predicted_affected: ['<actual Task ID in the cited workflow>'],
      predicted_cases: [],
      predicted_families: [],
      regression_risk: '<counterexample or observation that would refute the hypothesis>',
    },
  }
}

function applyChanges(baseline: MethodAssets, changes: readonly Record<string, unknown>[]): MethodAssets {
  const method = structuredClone(baseline) as unknown as Record<string, unknown>
  const seen = new Set<string>()
  for (const [index, change] of changes.entries()) {
    const path = `edit.changes[${index}]`,
      asset = text(change, 'asset', path),
      target = text(change, 'target', path)
    if (!['workflow', 'template', 'skill', 'tool'].includes(asset))
      refuse('malformed-declaration', `${path}.asset must be workflow, template, skill or tool`)
    if (seen.has(`${asset}:${target}`))
      refuse('malformed-declaration', `${path} repeats ${asset}:${target}; edit each asset once`)
    seen.add(`${asset}:${target}`)
    if (!Object.hasOwn(change, 'value'))
      refuse('malformed-declaration', `${path}.value is required; use changed fields or explicit null for deletion`)
    const value = change['value']
    if (asset === 'workflow') {
      if (target !== 'workflowGuidance' || (value !== null && typeof value !== 'string'))
        refuse('malformed-declaration', `${path} workflow target must be workflowGuidance with a string or null value`)
      method['workflowGuidance'] = value ?? ''
      continue
    }
    const key = asset === 'template' ? 'id' : 'name',
      field = `${asset}s`
    const assets = method[field] as Record<string, unknown>[]
    const at = assets.findIndex(entry => entry[key] === target)
    if (value === null) {
      if (at < 0) refuse('malformed-declaration', `${path} cannot delete missing ${asset}:${target}`)
      assets.splice(at, 1)
      continue
    }
    const patch = record(value, `${path}.value`)
    if (Object.hasOwn(patch, key) && patch[key] !== target)
      refuse('malformed-declaration', `${path}.value.${key} must match target ${target}`)
    if (asset === 'template' && Object.hasOwn(patch, 'initial'))
      refuse(
        'malformed-declaration',
        `${path}.value.initial is frozen Task source; omit it, the host preserves its exact bytes`,
      )
    const next = { ...(at < 0 ? {} : assets[at]), [key]: target }
    for (const [name, content] of Object.entries(patch)) {
      if (content === null) delete next[name]
      else next[name] = content
    }
    if (
      asset === 'tool' &&
      at < 0 &&
      typeof next['source'] === 'string' &&
      (typeof next['description'] !== 'string' || !next['description'].trim())
    )
      refuse(
        'malformed-declaration',
        'new Method Tools require description: purpose, when to use, and input/candidate file',
      )
    if (at < 0) assets.push(next)
    else assets[at] = next
  }
  assertMethodShape(method)
  return method
}

export const RSI_REPORT_FORMAT = `Recommended report.json structure: fill search.authoring.report with facts known BEFORE submission. evidence uses the proposal Evidence shape. Reviewers can verify the sealed business root, pre-submission evolve measurements and exact pages cited in screened proposals; other history is background. changes and preserved_behavior list supported mechanisms/behaviors. results cites tested rounds as {roundId,detail}; use [] if none ran. The host supplies frozen outcomes, scores and costs to reviewers; reference them instead of duplicating or recomputing numbers. Distinguish structural refusal, critic rejection and measured no-winner; state coverage and attribution limits. With a suite, private validation/publication follow sealing: transfer.status='not-tested-before-submission'; the host records final outcomes. This report has independent acceptance.`
export const RSI_REPORT_TEMPLATE = {
  summary: '<search result supported by facts known before submission>',
  evidence: [],
  changes: [],
  results: [],
  preserved_behavior: [],
  limitations: [],
  transfer: {
    status: 'not-tested-before-submission',
    detail:
      'Suite private validation and resulting publication run after this report is sealed; final results are host facts.',
  },
} as const

export const rsiProposalContract = {
  designReference: rsiDesignReference,
  format: RSI_PROPOSAL_FORMAT,
  analysisRules: rsiAnalysisRules,
  proposalRules: rsiProposalRules,
  criteria: rsiProposalCriteria,
  adaptation:
    'One RSI agent performs analysis and proposal, with one independent mechanism per candidate. Asset changes replace upstream source-component tags. history and previous-RSI memory are RSI-only, optional reads. Runtime owns screening, cold candidate solve, selection and approved publication.',
}

function comparisonOf(before: MethodAssets, after: MethodAssets) {
  return structuralEditsOf(before, after).map(edit => {
    if (edit.asset === 'workflow') return { ...edit, before: before.workflowGuidance, after: after.workflowGuidance }
    const field = `${edit.asset}s` as 'templates' | 'skills' | 'tools',
      key = edit.asset === 'template' ? 'id' : 'name'
    const find = (assets: MethodAssets) =>
      assets[field].find(raw => (raw as Record<string, unknown>)[key] === edit.target) as
        Record<string, unknown> | undefined
    const a = find(before),
      b = find(after)
    const fields = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(
      name => digestOf(a?.[name] ?? null) !== digestOf(b?.[name] ?? null),
    )
    const select = (asset: typeof a) =>
      asset === undefined ? null : Object.fromEntries(fields.map(name => [name, asset[name] ?? null]))
    return { ...edit, before: select(a), after: select(b) }
  })
}

function objects(value: unknown, fields: readonly string[], where: string) {
  return list(value, where).map((raw, index) => {
    const row = record(raw, `${where}[${index}]`)
    assertClosedKeys(row, fields, `${where}[${index}]`, 'malformed-declaration')
    return row
  })
}
function evidence(value: unknown, where: string): readonly RsiEvidence[] {
  const refs = list(value, where).map((raw, index) =>
    nativeEventRef(raw, `${where}[${index}]`, 'malformed-declaration'),
  )
  if (refs.length === 0) refuse('malformed-declaration', `${where} needs at least one native evidence reference`)
  return refs
}
export function parseRsiProposal(raw: unknown, baseline: MethodAssets, suite?: Suite): RsiProposal {
  const proposal = record(raw, 'RSI proposal')
  assertClosedKeys(proposal, ['analysis', 'edit'], 'RSI proposal', 'malformed-declaration')
  const analysis = record(proposal['analysis'], 'analysis')
  assertClosedKeys(
    analysis,
    ['failure_modes', 'capability_gaps', 'success_habits'],
    'analysis',
    'malformed-declaration',
  )
  const failure_modes = objects(
    analysis['failure_modes'],
    ['mode', 'description', 'needed_instead', 'evidence'],
    'analysis.failure_modes',
  ).map((row, index) => {
    const path = `analysis.failure_modes[${index}]`
    return {
      mode: text(row, 'mode', path),
      description: text(row, 'description', path),
      needed_instead: text(row, 'needed_instead', path),
      evidence: evidence(row['evidence'], `${path}.evidence`),
    }
  })
  const capability_gaps = objects(
    analysis['capability_gaps'],
    ['gap', 'description', 'evidence'],
    'analysis.capability_gaps',
  ).map((row, index) => {
    const path = `analysis.capability_gaps[${index}]`
    return {
      gap: text(row, 'gap', path),
      description: text(row, 'description', path),
      evidence: evidence(row['evidence'], `${path}.evidence`),
    }
  })
  const success_habits = objects(
    analysis['success_habits'],
    ['habit', 'description', 'risk_if_broken', 'evidence'],
    'analysis.success_habits',
  ).map((row, index) => {
    const path = `analysis.success_habits[${index}]`
    return {
      habit: text(row, 'habit', path),
      description: text(row, 'description', path),
      risk_if_broken: text(row, 'risk_if_broken', path),
      evidence: evidence(row['evidence'], `${path}.evidence`),
    }
  })
  const labels = new Map<string, string>()
  for (const [section, key] of [
    ['failure_modes', 'mode'],
    ['capability_gaps', 'gap'],
    ['success_habits', 'habit'],
  ] as const)
    for (const [index, row] of (analysis[section] as Record<string, unknown>[]).entries()) {
      const path = `analysis.${section}[${index}].${key}`,
        label = row[key] as string,
        previous = labels.get(label)
      if (previous !== undefined)
        refuse(
          'malformed-declaration',
          `${path} repeats ${previous} (${JSON.stringify(label)}); analysis mode/gap/habit names must be unique across all three lists`,
        )
      labels.set(label, path)
    }
  const row = record(proposal['edit'], 'edit')
  assertClosedKeys(
    row,
    [
      'hypothesis',
      'targets_mode',
      'trigger_condition',
      'changes',
      'predicted_affected',
      'predicted_cases',
      'predicted_families',
      'regression_risk',
    ],
    'edit',
    'malformed-declaration',
  )
  const targets_mode = text(row, 'targets_mode', 'edit')
  if (!labels.has(targets_mode))
    refuse('malformed-declaration', 'edit.targets_mode must target an evidenced mode, gap or success habit')
  const edits = objects(row['changes'], ['asset', 'target', 'value'], 'edit.changes')
  const method = applyChanges(baseline, edits)
  const changes = edits.map(change => ({
    asset: change['asset'] as StructuralEdit['asset'],
    target: change['target'] as string,
  }))
  const actual = structuralEditsOf(baseline, method)
  const keys = (edits: readonly StructuralEdit[]) => edits.map(edit => `${edit.asset}:${edit.target}`).sort()
  if (actual.length === 0 || digestOf(keys(changes)) !== digestOf(keys(actual)))
    refuse(
      'malformed-declaration',
      'edit.changes must produce a nonempty actual method diff; remove unchanged edits and change each asset once',
    )
  const predicted_affected = list(row['predicted_affected'], 'edit.predicted_affected').map((id, index) => {
    if (typeof id !== 'string' || !id)
      refuse('malformed-declaration', `edit.predicted_affected[${index}] must name a Task id`)
    return id
  })
  if (predicted_affected.length === 0 || new Set(predicted_affected).size !== predicted_affected.length)
    refuse('malformed-declaration', 'edit.predicted_affected must name a nonempty unique set of affected Tasks')
  const predictions = (field: string) => {
    const values = row[field] === undefined ? [] : list(row[field], `edit.${field}`)
    if (values.some(v => typeof v !== 'string' || !v) || new Set(values).size !== values.length)
      refuse('malformed-declaration', `edit.${field} requires unique nonempty IDs`)
    return values as string[]
  }
  const predicted_cases = predictions('predicted_cases'),
    predicted_families = predictions('predicted_families')
  const cases = suite?.cases.filter(c => c.split === 'evolve')
  if (
    cases &&
    ((!predicted_cases.length && !predicted_families.length) ||
      predicted_cases.some(id => !cases.some(c => c.caseId === id)) ||
      predicted_families.some(id => !cases.some(c => c.familyId === id)))
  )
    refuse(
      'malformed-declaration',
      `edit.predicted_cases or edit.predicted_families must name frozen evolve IDs: ${JSON.stringify(cases.map(c => ({ caseId: c.caseId, familyId: c.familyId })))}`,
    )
  return {
    analysis: { failure_modes, capability_gaps, success_habits },
    method,
    edit: {
      hypothesis: text(row, 'hypothesis', 'edit'),
      targets_mode,
      trigger_condition: text(row, 'trigger_condition', 'edit'),
      changes,
      predicted_affected,
      predicted_cases,
      predicted_families,
      regression_risk: text(row, 'regression_risk', 'edit'),
    },
  }
}

async function parseCandidate(domain: Domain, content: string, baseline: MethodAssets) {
  const raw = record(JSON.parse(content), 'RSI proposal')
  // No assetRoot: parse declarations without materializing or executing candidate tools.
  // Validate nested fields before the diff can mistake omissions for deletions.
  const proposal = parseRsiProposal(raw, baseline, domain.suite)
  const candidate = await parseMethod(domain, proposal.method)
  return { proposal, candidate }
}

/** RRSI done() -> critic -> evaluation request. No parallel state store or model-controlled round ids. */
async function screenRsiMethod(
  apparatus: Apparatus,
  seams: ChildSessionSeams,
  agent: Agent,
  agentId: string,
  input: { readonly content: string; readonly incumbent: import('../../src/task/protocol.ts').RevisionRef },
  signal: AbortSignal,
) {
  assertImprovementOwner(apparatus, agentId)
  const cut = apparatus.store.load(),
    tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION),
    agents = cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
  const task = [...tasks.values()].findLast(task => task.responsibility?.agentId === agentId)!,
    run = Object.values(task.runs).at(-1)!
  const incumbent = input.incumbent
  const baseline = await loadMethod(apparatus, incumbent)
  const { proposal, candidate } = await parseCandidate(apparatus.domain, input.content, baseline.assets)
  const sources = [
    ...proposal.analysis.failure_modes,
    ...proposal.analysis.capability_gaps,
    ...proposal.analysis.success_habits,
  ].flatMap(mode => mode.evidence)
  const nativeEvidence: { reference: RsiEvidence; page: unknown }[] = []
  for (const ref of new Map(sources.map(ref => [digestOf(ref), ref])).values()) {
    const page = await readForAgent(apparatus, agentId, {
      kind: 'trajectory',
      ref: ref.sessionId,
      eventSeq: ref.eventSeq,
      from: ref.from ?? 0,
      count: ref.count ?? 8192,
      ...(ref.rootId === undefined ? {} : { rootId: ref.rootId }),
    })
    nativeEvidence.push({ reference: ref, page })
  }
  const graph = taskRelations(tasks),
    citedSessions = new Set(sources.map(ref => ref.sessionId))
  const citedTasks = [...tasks.values()]
    .filter(
      task =>
        task.responsibility !== undefined &&
        citedSessions.has(agents.get(task.responsibility.agentId)?.sessionId ?? ''),
    )
    .map(task => task.taskId)
  for (const review of cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values())
    if (review.target.kind === 'acceptance' && citedSessions.has(review.sessionId))
      citedTasks.push(review.target.taskId)
  const citedRoots = new Set(citedTasks.map(id => graph.rootOf(id)))
  const affected = [...tasks.keys()].filter(id => citedRoots.has(graph.rootOf(id)))
  for (const taskId of proposal.edit.predicted_affected)
    if (!affected.includes(taskId))
      refuse(
        'evidence-input-mismatch',
        `edit.predicted_affected includes ${JSON.stringify(taskId)} outside the workflow of cited native evidence. Allowed Task IDs: ${JSON.stringify(affected)}`,
      )
  const digest = digestOf(candidate.assets)
  const revision = { environmentId: methodEnvironment(apparatus), revisionId: `method-${digest.slice(0, 24)}`, digest }
  const current = taskStateOf(apparatus, task.taskId)
  const attempted = current.search?.batches
    ?.flatMap(batch => batch.outcomes)
    .find(outcome => outcome.revision?.digest === digest)
  if (attempted !== undefined) return { status: 'duplicate', revision, reason: attempted.detail }
  signal.throwIfAborted()
  assertActive(apparatus, task.taskId)
  const rootBindings = (loaded: typeof baseline) =>
    bindingsForContract(taskStateOf(apparatus, run.relatedTo!.taskId).contract!, loaded.assets).tools
  if (digestOf(rootBindings(baseline)) !== digestOf(rootBindings(candidate)))
    refuse('caliber-mismatch', 'proposal changes root-bound Tools; bind helpers only to delegated Tasks')
  let screen: import('./review.ts').ReviewWitness
  try {
    screen = await reviewSubject(
      apparatus,
      seams,
      agent,
      `proposal:${task.taskId}:${digest}`,
      {
        purpose: 'proposal',
        comparison: comparisonOf(baseline.assets, candidate.assets),
        designReference: rsiDesignReference,
        baseline: baseline.assets,
        assets: candidate.assets,
        analysis: proposal.analysis,
        edit: proposal.edit,
        nativeEvidence,
        changes: structuralEditDetailsOf(baseline.assets, candidate.assets),
        requirements: rsiCriticRequirements,
      },
      signal,
      incumbent,
      false,
      rsiProposalCriteria,
      {
        kind: 'proposal',
        environmentId: revision.environmentId,
        revisionId: revision.revisionId,
        assetsDigest: revision.digest,
      },
    )
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') throw error
    return { status: 'screen-failed', revision, reason: String(error) }
  }
  if (screen.verdict !== 'pass') {
    return { status: 'rejected', revision, reviewId: screen.reviewId, reason: screen.detail }
  }
  signal.throwIfAborted()
  try {
    await createMethod(apparatus, candidate.assets)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') throw error
    return { status: 'smoke-failed', revision, reason: String(error) }
  }
  return { status: 'evaluation-requested', revision, reviewId: screen.reviewId }
}

const proposalQueues = new WeakMap<Apparatus, Map<string, Promise<unknown>>>()
export function proposeRsiMethod(
  apparatus: Apparatus,
  agentId: string,
  input: { readonly paths: readonly string[] },
  signal: AbortSignal,
) {
  let queue = proposalQueues.get(apparatus)
  if (!queue) {
    queue = new Map()
    proposalQueues.set(apparatus, queue)
  }
  const pending = (queue.get(agentId) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => admitBatch(apparatus, agentId, input, signal))
  queue.set(agentId, pending)
  return pending
}

/** One bounded batch is one round. Slot failures remain facts and never become extra draws. */
async function admitBatch(
  apparatus: Apparatus,
  agentId: string,
  input: { readonly paths: readonly string[] },
  signal: AbortSignal,
) {
  assertImprovementOwner(apparatus, agentId)
  if (
    !Array.isArray(input.paths) ||
    input.paths.length < 1 ||
    input.paths.length > 3 ||
    new Set(input.paths).size !== input.paths.length
  )
    refuse('malformed-declaration', 'provide one to three distinct proposal paths')
  const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].findLast(
    t => t.responsibility?.agentId === agentId,
  )!
  const run = Object.values(task.runs).at(-1)!,
    workspace = run.bubble!.workspace.ref
  // An interrupted batch owns immutable proposal bytes, even if its workspace files changed.
  const pending = task.search?.batches?.find(batch => !batch.settled)
  if (pending)
    return {
      admitted: true,
      status: 'screening',
      batchId: pending.batchId,
      slotsConsumed: pending.slots.length,
      next: 'End the turn; the host resumes the frozen batch without another tool call.',
    }
  const slots: {
    path: string
    contentDigest: string
    proposal: import('@deepseek-ai/dsh-attachment').FileAttachmentRef
  }[] = []
  const drafts: { path: string; bytes: Buffer; contentDigest: string }[] = []
  for (const path of input.paths) {
    await assertRunFile(workspace, path)
    const bytes = await readFile(inside(workspace, path, 'proposal path'))
    drafts.push({ path, bytes, contentDigest: sha256(bytes) })
  }
  const batchId = `batch-${digestOf(drafts.map(s => s.contentDigest)).slice(0, 24)}`
  const existing = task.search?.batches?.find(b => b.batchId === batchId)
  const roundId = `round-${sha256(`${task.taskId}/${batchId}`).slice(0, 24)}`
  if (existing?.settled) {
    const request = task.rounds?.find(r => r.roundId === roundId)
    return {
      batchId,
      ...(request === undefined ? {} : { roundId }),
      admitted: true,
      slotsConsumed: existing.slots.length,
      status: request?.status ?? existing.outcomes[0]?.status ?? 'no-candidates',
      revision: existing.outcomes.find(o => o.revision)?.revision,
      reason: existing.outcomes[0]?.detail,
      slots: existing.outcomes,
    }
  }
  const evaluating = task.rounds?.find(round => round.status === 'pending')
  if (evaluating)
    refuse(
      'illegal-transition',
      `evaluation ${evaluating.roundId} is pending; end the turn and wait for host feedback. No new batch admitted; no candidate slots consumed`,
    )
  const history = searchHistory(apparatus, task)
  const incumbent = existing?.incumbent ?? history.incumbent
  {
    const baseline = await loadMethod(apparatus, incumbent)
    // Static draft checks reveal no evidence, critic or trial outcome. Check the whole
    // batch before admitting any slot, then freeze exactly the bytes that passed.
    for (const draft of drafts) {
      try {
        await parseCandidate(apparatus.domain, draft.bytes.toString('utf8'), baseline.assets)
      } catch (error) {
        const detail =
          error instanceof SyntaxError
            ? `invalid JSON: ${error.message}`
            : error instanceof ProtocolRefusal && error.refusal.code !== 'write-not-durable'
              ? error.refusal.detail
              : undefined
        if (detail === undefined) throw error
        refuse(
          'malformed-declaration',
          `${draft.path}: ${detail}. Batch not admitted; no candidate slots consumed. Fix the named fields and resubmit the batch.`,
        )
      }
    }
    signal.throwIfAborted()
    for (const draft of drafts)
      slots.push({
        path: draft.path,
        contentDigest: draft.contentDigest,
        proposal: await apparatus.attachments.saveFile({ name: draft.path, data: draft.bytes }),
      })
  }
  if (!existing)
    await searchFact(
      apparatus,
      task,
      'rsi/batch-opened',
      { batchId, incumbent, slots, historyCutoff: history.directives.historyCutoff },
      batchId,
    )
  return {
    batchId,
    admitted: true,
    status: 'screening',
    slotsConsumed: slots.length,
    next: 'End the turn. The host screens these frozen bytes and evaluates approved candidates; it will resume you.',
  }
}

/** Runtime-owned continuation. Recovery needs only the committed batch, never an author retry. */
export async function advanceRsiBatch(
  apparatus: Apparatus,
  seams: ChildSessionSeams,
  agent: Agent,
  taskId: string,
  signal: AbortSignal,
): Promise<void> {
  const task = taskStateOf(apparatus, taskId),
    agentId = task.responsibility!.agentId
  assertImprovementOwner(apparatus, agentId)
  const pending = task.search?.batches?.find(batch => !batch.settled)
  if (pending === undefined) return
  const { batchId, slots, incumbent } = pending
  const run = Object.values(task.runs).at(-1)!
  const roundId = `round-${sha256(`${task.taskId}/${batchId}`).slice(0, 24)}`
  const round = task.rounds?.find(r => r.roundId === roundId)?.round ?? (task.rounds?.length ?? 0) + 1
  for (const [slot, held] of slots.entries()) {
    if (
      taskStateOf(apparatus, task.taskId)
        .search!.batches!.find(b => b.batchId === batchId)!
        .outcomes.some(o => o.slot === slot)
    )
      continue
    let outcome: {
      status: string
      revision?: import('../../src/task/protocol.ts').RevisionRef
      reason?: string | undefined
      reviewId?: string
    }
    try {
      const content = (await sealedBytes(apparatus, held.proposal)).toString('utf8')
      outcome = await screenRsiMethod(apparatus, seams, agent, agentId, { content, incumbent }, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof SyntaxError)
        outcome = { status: 'invalid', reason: `invalid proposal JSON: ${error.message}` }
      else if (error instanceof ProtocolRefusal && error.refusal.code !== 'write-not-durable')
        outcome = { status: 'invalid', reason: error.refusal.detail }
      else if (error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') throw error
      else outcome = { status: 'screen-failed', reason: String(error) }
    }
    signal.throwIfAborted()
    await searchFact(
      apparatus,
      task,
      'rsi/batch-slot-settled',
      {
        batchId,
        slot,
        status: outcome.status,
        detail: outcome.reason ?? outcome.reviewId ?? outcome.status,
        ...(outcome.revision === undefined ? {} : { revision: outcome.revision }),
      },
      `${batchId}:${slot}`,
    )
  }
  const batch = taskStateOf(apparatus, task.taskId).search!.batches!.find(b => b.batchId === batchId)!
  const candidates = [
    ...new Map(
      batch.outcomes.filter(o => o.status === 'evaluation-requested').map(o => [o.revision!.digest, o.revision!]),
    ).values(),
  ]
  signal.throwIfAborted()
  if (candidates.length) {
    const commandId = `round-request:${roundId}`
    await apparatus.store.emit(
      {
        commandId,
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        kind: 'rsi/round-requested',
        subject: task.taskId,
        as: `agent:${agentId}`,
        payload: { roundId, round, incumbent, candidates, runId: run.runId },
      },
      () => assertActive(apparatus, task.taskId),
    )
  }
  await searchFact(apparatus, task, 'rsi/batch-ended', { batchId }, batchId)
}

function searchFact(apparatus: Apparatus, task: TaskState, kind: string, payload: unknown, key: string) {
  return apparatus.store.emit({
    commandId: `${kind}:${task.taskId}:${key}`,
    protocol: TASK_PROTOCOL,
    version: TASK_VERSION,
    kind,
    subject: task.taskId,
    as: `agent:${task.responsibility!.agentId}`,
    payload,
  })
}
