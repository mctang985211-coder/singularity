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
import type { Apparatus } from './apparatus.ts'
import type { Domain } from './domain.ts'
import { taskStateOf } from './apparatus.ts'
import { assertImprovementOwner } from './improvement.ts'
import { assertMethodShape, createMethod, loadMethod, parseMethod, methodEnvironment, bindingsForContract, type MethodAssets } from './method.ts'
import type { Suite } from '../../src/measure/suite.ts'
import { assertActive } from './coordination.ts'
import { readForAgent } from './read.ts'
import { reviewSubject } from './review.ts'
import { assertRunFile } from './workspace.ts'
import { inside, list, record, text } from './shape.ts'
import { sha256 } from './ids.ts'
import { rsiDesignReference, rsiAnalysisRules, rsiProposalRules, rsiCriticRequirements, rsiProposalCriteria } from './rsi-policy.ts'

/** Proposal metadata is frozen in the native review subject, never in the business method. */
export interface RsiEvidence {
  readonly sessionId: string
  readonly eventSeq: number
  readonly rootId?: string
  readonly from?: number
  readonly count?: number
}
interface FailureMode { readonly mode: string; readonly description: string; readonly needed_instead: string; readonly evidence: readonly RsiEvidence[] }
interface CapabilityGap { readonly gap: string; readonly description: string; readonly evidence: readonly RsiEvidence[] }
interface SuccessHabit { readonly habit: string; readonly description: string; readonly risk_if_broken: string; readonly evidence: readonly RsiEvidence[] }
export interface RsiProposal {
  readonly analysis: { readonly failure_modes: readonly FailureMode[]; readonly capability_gaps: readonly CapabilityGap[]; readonly success_habits: readonly SuccessHabit[] }
  readonly edit: {
    readonly hypothesis: string
    readonly targets_mode: string
    readonly why_not_lower_lever: string
    readonly trigger_condition: string
    readonly changes: readonly StructuralEdit[]
    readonly predicted_affected: readonly string[]
    readonly predicted_cases: readonly string[]
    readonly predicted_families: readonly string[]
    readonly retroactive_check: { readonly corrective: string; readonly preservative: string; readonly transfer: string }
    readonly regression_risk: string
  }
  readonly method: MethodAssets
}

export const RSI_PROPOSAL_FORMAT = `Fill proposal.template and save a proposal JSON file, not a bare method. Replace all <...> and null placeholders with observed data; remove unobserved finding rows.
{analysis:{failure_modes:FailureMode[],capability_gaps:CapabilityGap[],success_habits:SuccessHabit[]},edit:Edit,method:Method}.
Evidence = {sessionId:string,eventSeq:integer,rootId?:string,from?:integer,count?:integer}. Read trajectory ref=sessionId to select a real index seq; copy it into REQUIRED eventSeq and read that event. from/count alone is an index range, not evidence. For historical evidence also copy rootId. The critic sees only the cited UTF-8 page (from defaults to 0, count to 8192; from>=0, count 4..8192); select sufficient bytes.
FailureMode = {mode:string,description:string,needed_instead:string,evidence:Evidence[]}.
CapabilityGap = {gap:string,description:string,evidence:Evidence[]}.
SuccessHabit = {habit:string,description:string,risk_if_broken:string,evidence:Evidence[]}.
At least one evidenced finding is needed; other lists may be []. Names must be unique across all three lists; targets_mode copies one exact name. Keep mechanisms reusable; public domain knowledge with sources is allowed, task-instance details stay in evidence.
Edit = {hypothesis:string,targets_mode:string,why_not_lower_lever:string,trigger_condition:string,changes:{asset:'workflow'|'template'|'skill'|'tool',target:string}[],predicted_affected:string[],predicted_cases?:string[],predicted_families?:string[],retroactive_check:{corrective:string,preservative:string,transfer:string},regression_risk:string}.
ONE independent mechanism per candidate. changes must name each actual changed asset exactly once: workflow target='workflowGuidance', template target=id, skill/tool target=name. predicted_affected contains nonempty unique actual Task IDs belonging to the cited sessions, not Run/session/agent IDs. With a suite, predicted_cases and/or predicted_families must name at least one evolve ID from cases; otherwise [] is legal. Counterfactuals cover correction, preservation and unfamiliar-task transfer. template.method is the complete current Method: modify it, retain unchanged assets, and follow the method format in this response. Empty arrays delete assets; an unchanged method is invalid. Do not add undeclared fields, task answers or proposal metadata to method.`

/** A scaffold, never invented evidence or a partial Method patch. */
export function rsiProposalTemplate(method: MethodAssets) {
  return {
    analysis: {
      failure_modes: [{ mode: '<unique-finding-name>', description: '<observed reusable failure mechanism>',
        needed_instead: '<needed behavior, separate from the proposed implementation>',
        evidence: [{ sessionId: '<sessionId from subject or readable history>', eventSeq: null }] }],
      capability_gaps: [], success_habits: [],
    },
    edit: { hypothesis: '<one attributable mechanism>', targets_mode: '<unique-finding-name>',
      why_not_lower_lever: '<why this instruction/implementation is sufficient>',
      trigger_condition: '<observable condition>', changes: [],
      predicted_affected: ['<actual Task ID of a cited session>'], predicted_cases: [], predicted_families: [],
      retroactive_check: { corrective: '<how cited failure would change>', preservative: '<why observed successful behavior survives>',
        transfer: '<how the mechanism applies to unfamiliar tasks>' },
      regression_risk: '<counterexample or observation that would refute the hypothesis>' },
    method: structuredClone(method),
  }
}

export const RSI_REPORT_FORMAT = `Recommended report.json structure: fill reportTemplate with facts known BEFORE submission. evidence uses the proposal Evidence shape; changes and preserved_behavior list supported mechanisms/behaviors. results contains actual {roundId,outcome,qualityDelta,costRatio,detail} records; use [] if no round ran and null for missing numbers, never zero. Distinguish structural refusal, critic rejection and measured no-winner. State missing coverage and attribution limits. With a suite, private validation and resulting publication run after this file is sealed: transfer.status='not-tested-before-submission' is honest; final host outcomes are separate committed facts. This report is independently reviewed, not a proposal or a publication approval.`
export const RSI_REPORT_TEMPLATE = {
  summary: '<search result supported by facts known before submission>',
  evidence: [], changes: [], results: [], preserved_behavior: [], limitations: [],
  transfer: { status: 'not-tested-before-submission', detail: 'Suite private validation and resulting publication run after this report is sealed; final results are host facts.' },
} as const

export const rsiProposalContract = { designReference: rsiDesignReference, format: RSI_PROPOSAL_FORMAT,
  analysisRules: rsiAnalysisRules, proposalRules: rsiProposalRules,
  adaptation: 'One RSI agent performs analysis and proposal, with one independent mechanism per candidate. Asset changes replace upstream source-component tags. history and previous-RSI memory are RSI-only, optional reads. Runtime owns screening, cold candidate solve, selection and approved publication.' }

function objects(value: unknown, fields: readonly string[], where: string) {
  return list(value, where).map((raw, index) => {
    const row = record(raw, `${where}[${index}]`)
    assertClosedKeys(row, fields, `${where}[${index}]`, 'malformed-declaration')
    return row
  })
}
function evidence(value: unknown, where: string): readonly RsiEvidence[] {
  const refs = objects(value, ['sessionId', 'eventSeq', 'rootId', 'from', 'count'], where).map((row, index) => {
    const path = `${where}[${index}]`
    if (!Number.isSafeInteger(row['eventSeq']) || (row['eventSeq'] as number) < 0)
      refuse('malformed-declaration', `${path}.eventSeq is required and must be a nonnegative integer; copy seq from a trajectory index entry. from/count without eventSeq selects an index, not a native event page`)
    if (row['from'] !== undefined && (!Number.isSafeInteger(row['from']) || (row['from'] as number) < 0))
      refuse('malformed-declaration', `${path}.from must be a nonnegative UTF-8 byte offset`)
    if (row['count'] !== undefined && (!Number.isSafeInteger(row['count']) || (row['count'] as number) < 4 || (row['count'] as number) > 8192))
      refuse('malformed-declaration', `${path}.count must be an integer from 4 to 8192 UTF-8 bytes`)
    return { sessionId: text(row, 'sessionId', path), eventSeq: row['eventSeq'] as number,
      ...(row['rootId'] === undefined ? {} : { rootId: text(row, 'rootId', path) }),
      ...(row['from'] === undefined ? {} : { from: row['from'] as number }),
      ...(row['count'] === undefined ? {} : { count: row['count'] as number }) }
  })
  if (refs.length === 0) refuse('malformed-declaration', `${where} needs at least one native evidence reference`)
  return refs
}
export function parseRsiProposal(raw: unknown, baseline: MethodAssets, suite?: Suite): RsiProposal {
  const proposal = record(raw, 'RSI proposal')
  assertClosedKeys(proposal, ['analysis', 'edit', 'method'], 'RSI proposal', 'malformed-declaration')
  const analysis = record(proposal['analysis'], 'analysis')
  assertClosedKeys(analysis, ['failure_modes', 'capability_gaps', 'success_habits'], 'analysis', 'malformed-declaration')
  const failure_modes = objects(analysis['failure_modes'], ['mode', 'description', 'needed_instead', 'evidence'], 'analysis.failure_modes')
    .map((row, index) => { const path = `analysis.failure_modes[${index}]`
      return { mode: text(row, 'mode', path), description: text(row, 'description', path),
        needed_instead: text(row, 'needed_instead', path), evidence: evidence(row['evidence'], `${path}.evidence`) } })
  const capability_gaps = objects(analysis['capability_gaps'], ['gap', 'description', 'evidence'], 'analysis.capability_gaps')
    .map((row, index) => { const path = `analysis.capability_gaps[${index}]`
      return { gap: text(row, 'gap', path), description: text(row, 'description', path), evidence: evidence(row['evidence'], `${path}.evidence`) } })
  const success_habits = objects(analysis['success_habits'], ['habit', 'description', 'risk_if_broken', 'evidence'], 'analysis.success_habits')
    .map((row, index) => { const path = `analysis.success_habits[${index}]`
      return { habit: text(row, 'habit', path), description: text(row, 'description', path),
        risk_if_broken: text(row, 'risk_if_broken', path), evidence: evidence(row['evidence'], `${path}.evidence`) } })
  const labels = new Map<string, string>()
  for (const [section, key] of [['failure_modes', 'mode'], ['capability_gaps', 'gap'], ['success_habits', 'habit']] as const)
    for (const [index, row] of (analysis[section] as Record<string, unknown>[]).entries()) {
      const path = `analysis.${section}[${index}].${key}`, label = row[key] as string, previous = labels.get(label)
      if (previous !== undefined) refuse('malformed-declaration', `${path} repeats ${previous} (${JSON.stringify(label)}); analysis mode/gap/habit names must be unique across all three lists`)
      labels.set(label, path)
    }
  const row = record(proposal['edit'], 'edit')
  assertClosedKeys(row, ['hypothesis', 'targets_mode', 'why_not_lower_lever', 'trigger_condition', 'changes', 'predicted_affected', 'predicted_cases', 'predicted_families', 'retroactive_check', 'regression_risk'], 'edit', 'malformed-declaration')
  const targets_mode = text(row, 'targets_mode', 'edit')
  if (!labels.has(targets_mode)) refuse('malformed-declaration', 'edit.targets_mode must target an evidenced mode, gap or success habit')
  const changes = objects(row['changes'], ['asset', 'target'], 'edit.changes').map((change, index) => {
    const path = `edit.changes[${index}]`, asset = text(change, 'asset', path)
    if (!['workflow', 'template', 'skill', 'tool'].includes(asset)) refuse('malformed-declaration', `${path}.asset must be workflow, template, skill or tool`)
    return { asset: asset as StructuralEdit['asset'], target: text(change, 'target', path) }
  })
  const method = proposal['method']
  assertMethodShape(method)
  const actual = structuralEditsOf(baseline, method)
  const keys = (edits: readonly StructuralEdit[]) => edits.map(edit => `${edit.asset}:${edit.target}`).sort()
  if (actual.length === 0 || digestOf(keys(changes)) !== digestOf(keys(actual)))
    refuse('malformed-declaration', `edit.changes must match the actual method diff exactly; expected ${JSON.stringify(actual)}, received ${JSON.stringify(changes)}. Retain unchanged assets in the complete method; declare every changed asset once`)
  const predicted_affected = list(row['predicted_affected'], 'edit.predicted_affected').map((id, index) => {
    if (typeof id !== 'string' || !id) refuse('malformed-declaration', `edit.predicted_affected[${index}] must name a Task id`)
    return id
  })
  if (predicted_affected.length === 0 || new Set(predicted_affected).size !== predicted_affected.length)
    refuse('malformed-declaration', 'edit.predicted_affected must name a nonempty unique set of affected Tasks')
  const predictions = (field: string) => {
    const values = row[field] === undefined ? [] : list(row[field], `edit.${field}`)
    if (values.some(v => typeof v !== 'string' || !v) || new Set(values).size !== values.length) refuse('malformed-declaration', `edit.${field} requires unique nonempty IDs`)
    return values as string[]
  }
  const predicted_cases = predictions('predicted_cases'), predicted_families = predictions('predicted_families')
  const cases = suite?.cases.filter(c => c.split === 'evolve')
  if (cases && (!predicted_cases.length && !predicted_families.length ||
    predicted_cases.some(id => !cases.some(c => c.caseId === id)) || predicted_families.some(id => !cases.some(c => c.familyId === id))))
    refuse('malformed-declaration', `edit.predicted_cases or edit.predicted_families must name frozen evolve IDs: ${JSON.stringify(cases.map(c => ({ caseId: c.caseId, familyId: c.familyId })))}`)
  const check = record(row['retroactive_check'], 'edit.retroactive_check')
  assertClosedKeys(check, ['corrective', 'preservative', 'transfer'], 'edit.retroactive_check', 'malformed-declaration')
  return { analysis: { failure_modes, capability_gaps, success_habits }, method, edit: {
    hypothesis: text(row, 'hypothesis', 'edit'), targets_mode, why_not_lower_lever: text(row, 'why_not_lower_lever', 'edit'),
    trigger_condition: text(row, 'trigger_condition', 'edit'), changes, predicted_affected, predicted_cases, predicted_families,
    retroactive_check: { corrective: text(check, 'corrective', 'edit.retroactive_check'), preservative: text(check, 'preservative', 'edit.retroactive_check'), transfer: text(check, 'transfer', 'edit.retroactive_check') },
    regression_risk: text(row, 'regression_risk', 'edit') } }
}

async function parseCandidate(domain: Domain, content: string, baseline: MethodAssets) {
  const raw = record(JSON.parse(content), 'RSI proposal')
  // No assetRoot: parse declarations without materializing or executing candidate tools.
  // Validate nested fields before the diff can mistake omissions for deletions.
  const candidate = await parseMethod(domain, raw['method'])
  return { proposal: parseRsiProposal(raw, baseline, domain.suite), candidate }
}

/** RRSI done() -> critic -> evaluation request. No parallel state store or model-controlled round ids. */
async function screenRsiMethod(apparatus: Apparatus, seams: ChildSessionSeams, agent: Agent,
  agentId: string, input: { readonly content: string; readonly incumbent: import('../../src/task/protocol.ts').RevisionRef; readonly editBudget: number; readonly untried: readonly string[]; readonly prune: boolean }, signal: AbortSignal) {
  assertImprovementOwner(apparatus, agentId)
  const cut = apparatus.store.load(), tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION),
    agents = cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
  const task = [...tasks.values()].findLast(task => task.responsibility?.agentId === agentId)!, run = Object.values(task.runs).at(-1)!
  const incumbent = input.incumbent
  const baseline = await loadMethod(apparatus, incumbent)
  const { proposal, candidate } = await parseCandidate(apparatus.domain, input.content, baseline.assets)
  if (input.untried.length && !proposal.edit.changes.some(change => input.untried.includes(change.asset)))
    refuse('malformed-declaration', 'reserved exploration slot must touch an actually untried asset class')
  if (input.prune) {
    const removed = proposal.edit.changes.some(change => {
      if (change.asset === 'workflow') return baseline.assets.workflowGuidance !== '' && proposal.method.workflowGuidance === ''
      const key = change.asset === 'template' ? 'id' : 'name', field = `${change.asset}s` as 'templates' | 'skills' | 'tools'
      return baseline.assets[field].some(asset => (asset as Record<string, unknown>)[key] === change.target) &&
        !proposal.method[field].some(asset => (asset as Record<string, unknown>)[key] === change.target)
    })
    if (!removed) refuse('malformed-declaration', 'stalled search requires a real current-asset deletion in its prune slot')
  }

  const sources = [...proposal.analysis.failure_modes, ...proposal.analysis.capability_gaps, ...proposal.analysis.success_habits].flatMap(mode => mode.evidence)
  const nativeEvidence: { reference: RsiEvidence; page: unknown }[] = []
  for (const ref of new Map(sources.map(ref => [digestOf(ref), ref])).values()) {
    const page = await readForAgent(apparatus, agentId, { kind: 'trajectory', ref: ref.sessionId, eventSeq: ref.eventSeq,
      from: ref.from ?? 0, count: ref.count ?? 8192, ...(ref.rootId === undefined ? {} : { rootId: ref.rootId }) })
    nativeEvidence.push({ reference: ref, page })
  }
  for (const taskId of proposal.edit.predicted_affected) {
    const predicted = tasks.get(taskId)
    const node = predicted?.responsibility === undefined ? undefined : agents.get(predicted.responsibility.agentId)
    if (node === undefined || !sources.some(ref => node.sessionId === ref.sessionId)) refuse('evidence-input-mismatch', 'predicted_affected must name Tasks with cited native evidence')
  }
  const digest = digestOf(candidate.assets)
  const revision = { environmentId: methodEnvironment(apparatus), revisionId: `method-${digest.slice(0, 24)}`, digest }
  const current = taskStateOf(apparatus, task.taskId)
  const attempted = current.search?.batches?.flatMap(batch => batch.outcomes).find(outcome => outcome.revision?.digest === digest)
  if (attempted !== undefined)
    return { status: 'duplicate', revision, reason: attempted.detail }
  signal.throwIfAborted()
  assertActive(apparatus, task.taskId)
  const rootBindings = (loaded: typeof baseline) => bindingsForContract(
    taskStateOf(apparatus, run.relatedTo!.taskId).contract!, loaded.assets).tools
  if (digestOf(rootBindings(baseline)) !== digestOf(rootBindings(candidate)))
    refuse('caliber-mismatch', 'proposal changes root-bound Tools; bind helpers only to delegated Tasks')
  let screen: import('./review.ts').ReviewWitness
  try { screen = await reviewSubject(apparatus, seams, agent, `proposal:${task.taskId}:${digest}`, {
    purpose: 'proposal', designReference: rsiDesignReference, baseline: baseline.assets, assets: candidate.assets,
    analysis: proposal.analysis, edit: proposal.edit, nativeEvidence,
    changes: structuralEditDetailsOf(baseline.assets, candidate.assets),
    requirements: rsiCriticRequirements,
  }, signal, incumbent, false, rsiProposalCriteria,
  { kind: 'proposal', environmentId: revision.environmentId, revisionId: revision.revisionId, assetsDigest: revision.digest }) }
  catch (error) {
    signal.throwIfAborted()
    if (error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') throw error
    return { status: 'screen-failed', revision, reason: String(error) }
  }
  if (screen.verdict !== 'pass') {
    return { status: 'rejected', revision, reviewId: screen.reviewId, reason: screen.detail }
  }
  signal.throwIfAborted()
  try { await createMethod(apparatus, candidate.assets) }
  catch (error) {
    signal.throwIfAborted()
    if (error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') throw error
    return { status: 'smoke-failed', revision, reason: String(error) }
  }
  return { status: 'evaluation-requested', revision, reviewId: screen.reviewId }

}


const proposalQueues = new WeakMap<Apparatus, Map<string, Promise<unknown>>>()
export function proposeRsiMethod(apparatus: Apparatus, seams: ChildSessionSeams, agent: Agent,
  agentId: string, input: { readonly paths: readonly string[] }, signal: AbortSignal) {
  let queue = proposalQueues.get(apparatus)
  if (!queue) { queue = new Map(); proposalQueues.set(apparatus, queue) }
  const pending = (queue.get(agentId) ?? Promise.resolve()).catch(() => undefined)
    .then(() => proposeBatch(apparatus, seams, agent, agentId, input, signal))
  queue.set(agentId, pending)
  return pending
}

/** One bounded batch is one round. Slot failures remain facts and never become extra draws. */
async function proposeBatch(apparatus: Apparatus, seams: ChildSessionSeams, agent: Agent,
  agentId: string, input: { readonly paths: readonly string[] }, signal: AbortSignal) {
  assertImprovementOwner(apparatus, agentId)
  if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 3 || new Set(input.paths).size !== input.paths.length)
    refuse('malformed-declaration', 'provide one to three distinct proposal paths')
  const task = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].findLast(t => t.responsibility?.agentId === agentId)!
  const run = Object.values(task.runs).at(-1)!, workspace = run.bubble!.workspace.ref
  // An interrupted batch owns immutable proposal bytes, even if its workspace files changed.
  const pending = task.search?.batches?.find(batch => !batch.settled)
  if (pending && digestOf(pending.slots.map(slot => slot.path)) !== digestOf(input.paths))
    refuse('illegal-transition', `resume the frozen batch with paths ${JSON.stringify(pending.slots.map(slot => slot.path))}`)
  const slots = pending ? [...pending.slots] : []
  const drafts: { path: string; bytes: Buffer; contentDigest: string }[] = []
  if (!pending) for (const path of input.paths) {
    await assertRunFile(workspace, path)
    const bytes = await readFile(inside(workspace, path, 'proposal path'))
    drafts.push({ path, bytes, contentDigest: sha256(bytes) })
  }
  const batchId = pending?.batchId ?? `batch-${digestOf(drafts.map(s => s.contentDigest)).slice(0, 24)}`
  const existing = task.search?.batches?.find(b => b.batchId === batchId)
  const roundId = `round-${sha256(`${task.taskId}/${batchId}`).slice(0, 24)}`
  if (existing?.settled) {
    const request = task.rounds?.find(r => r.roundId === roundId)
    return { batchId, ...(request === undefined ? {} : { roundId }), admitted: true, slotsConsumed: existing.slots.length,
      status: request?.status ?? existing.outcomes[0]?.status ?? 'no-candidates', revision: existing.outcomes.find(o => o.revision)?.revision, reason: existing.outcomes[0]?.detail, slots: existing.outcomes }
  }
  const history = searchHistory(apparatus, task)
  const incumbent = existing?.incumbent ?? history.incumbent
  const round = task.rounds?.find(r => r.roundId === roundId)?.round ?? (task.rounds?.length ?? 0) + 1
  const untried = existing?.untried ?? history.directives.untried
  const prune = existing?.prune ?? history.directives.prune
  if (!pending) {
    const baseline = await loadMethod(apparatus, incumbent)
    // Static draft checks reveal no evidence, critic or trial outcome. Check the whole
    // batch before admitting any slot, then freeze exactly the bytes that passed.
    for (const draft of drafts) {
      try { await parseCandidate(apparatus.domain, draft.bytes.toString('utf8'), baseline.assets) }
      catch (error) {
        const detail = error instanceof SyntaxError ? `invalid JSON: ${error.message}`
          : error instanceof ProtocolRefusal && error.refusal.code !== 'write-not-durable' ? error.refusal.detail : undefined
        if (detail === undefined) throw error
        refuse('malformed-declaration', `${draft.path}: ${detail}. Batch not admitted; no candidate slots consumed. Fix the named fields and resubmit the batch.`)
      }
    }
    signal.throwIfAborted()
    for (const draft of drafts)
      slots.push({ path: draft.path, contentDigest: draft.contentDigest,
        proposal: await apparatus.attachments.saveFile({ name: draft.path, data: draft.bytes }) })
  }
  if (!existing) await searchFact(apparatus, task, 'rsi/batch-opened', { batchId, incumbent, editBudget: 1, slots,
    historyCutoff: history.directives.historyCutoff, untried, prune }, batchId)
  for (const [slot, held] of slots.entries()) {
    if (taskStateOf(apparatus, task.taskId).search!.batches!.find(b => b.batchId === batchId)!.outcomes.some(o => o.slot === slot)) continue
    let outcome: { status: string; revision?: import('../../src/task/protocol.ts').RevisionRef; reason?: string | undefined; reviewId?: string }
    try {
      const content = (await sealedBytes(apparatus, held.proposal)).toString('utf8')
      outcome = await screenRsiMethod(apparatus, seams, agent, agentId, { content, incumbent, editBudget: 1,
        untried: slots.length > 1 && slot === slots.length - 1 ? untried : [], prune: prune && slot === 0 }, signal)
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof SyntaxError) outcome = { status: 'invalid', reason: `invalid proposal JSON: ${error.message}` }
      else if (error instanceof ProtocolRefusal && error.refusal.code !== 'write-not-durable') outcome = { status: 'invalid', reason: error.refusal.detail }
      else throw error
    }
    signal.throwIfAborted()
    await searchFact(apparatus, task, 'rsi/batch-slot-settled', { batchId, slot, status: outcome.status,
      detail: outcome.reason ?? outcome.reviewId ?? outcome.status, ...(outcome.revision === undefined ? {} : { revision: outcome.revision }) }, `${batchId}:${slot}`)
  }
  const batch = taskStateOf(apparatus, task.taskId).search!.batches!.find(b => b.batchId === batchId)!
  const candidates = [...new Map(batch.outcomes.filter(o => o.status === 'evaluation-requested').map(o => [o.revision!.digest, o.revision!])).values()]
  signal.throwIfAborted()
  if (candidates.length) {
    const commandId = `round-request:${roundId}`
    await apparatus.store.emit({ commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'rsi/round-requested', subject: task.taskId,
      as: `agent:${agentId}`, payload: { roundId, round, incumbent, candidates, runId: run.runId } }, () => assertActive(apparatus, task.taskId))
  }
  await searchFact(apparatus, task, 'rsi/batch-ended', { batchId }, batchId)
  const request = taskStateOf(apparatus, task.taskId).rounds?.find(r => r.roundId === roundId)
  return { batchId, ...(request === undefined ? {} : { roundId }), admitted: true, slotsConsumed: batch.slots.length,
    status: request?.status ?? batch.outcomes[0]?.status ?? 'no-candidates', revision: batch.outcomes.find(o => o.revision)?.revision, reason: batch.outcomes[0]?.detail, slots: batch.outcomes }
}


function searchFact(apparatus: Apparatus, task: TaskState, kind: string, payload: unknown, key: string) {
  return apparatus.store.emit({ commandId: `${kind}:${task.taskId}:${key}`, protocol: TASK_PROTOCOL, version: TASK_VERSION,
    kind, subject: task.taskId, as: `agent:${task.responsibility!.agentId}`, payload })
}
