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
import { taskStateOf } from './apparatus.ts'
import { assertImprovementOwner } from './improvement.ts'
import { createMethod, loadMethod, parseMethod, methodEnvironment, bindingsForContract, type MethodAssets } from './method.ts'
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

export const RSI_PROPOSAL_FORMAT = `Proposal JSON (not a bare method):
{analysis:{failure_modes:FailureMode[],capability_gaps:CapabilityGap[],success_habits:SuccessHabit[]},edit:Edit,method:Method}.
Evidence = {sessionId:string,eventSeq:integer,rootId?:string,from?:integer,count?:integer}; rootId is required for historical evidence from another business root. Cite a sufficient native UTF-8 event page (from defaults to 0, count to 8192, maximum 8192 bytes). The host freezes that exact page for the independent critic, without granting history access.
FailureMode = {mode:string,description:string,needed_instead:string,evidence:Evidence[]}.
CapabilityGap = {gap:string,description:string,evidence:Evidence[]}.
SuccessHabit = {habit:string,description:string,risk_if_broken:string,evidence:Evidence[]}.
Record success habits only when observed; an all-failed run may have none. Descriptions are entity-free mechanisms; task details belong only in evidence.
Edit = {hypothesis:string,targets_mode:string,why_not_lower_lever:string,trigger_condition:string,changes:{asset:'workflow'|'template'|'skill'|'tool',target:string}[],predicted_affected:string[],predicted_cases?:string[],predicted_families?:string[],retroactive_check:{corrective:string,preservative:string,transfer:string},regression_risk:string}.
The edit budget is ONE independent mechanism; dependent changes may span multiple assets. Declare every changed asset exactly once. targets_mode names an analysis mode/gap/habit. predicted_affected names actual Task ids in the cited evidence. For suite experiments, predict nonempty evolve case/family IDs using predicted_cases/predicted_families; these stable IDs drive measured feedback. The three counterfactuals explain correction, preservation and transfer to an unfamiliar task. method is the complete Method JSON. Metadata and task evidence must never be copied into method assets.`

export const rsiProposalContract = { designReference: rsiDesignReference, format: RSI_PROPOSAL_FORMAT,
  analysisRules: rsiAnalysisRules, proposalRules: rsiProposalRules,
  adaptation: 'One RSI agent performs analysis and proposal, with one independent mechanism per candidate. Asset changes replace upstream source-component tags. history and previous-RSI memory are RSI-only, optional reads. Runtime owns screening, cold candidate solve, selection and approved publication.' }

function objects(value: unknown, fields: readonly string[], where: string) {
  return list(value, where).map((raw, index) => {
    const row = record(raw, `${where}[${index}]`)
    assertClosedKeys(row, fields, where, 'malformed-declaration')
    return row
  })
}
function evidence(value: unknown): readonly RsiEvidence[] {
  const refs = objects(value, ['sessionId', 'eventSeq', 'rootId', 'from', 'count'], 'analysis evidence').map(row => {
    if (!Number.isSafeInteger(row['eventSeq']) || (row['eventSeq'] as number) < 0)
      refuse('malformed-declaration', 'evidence eventSeq must identify a native event')
    return { sessionId: text(row, 'sessionId', 'evidence'), eventSeq: row['eventSeq'] as number,
      ...(row['rootId'] === undefined ? {} : { rootId: text(row, 'rootId', 'evidence') }),
      ...(row['from'] === undefined ? {} : { from: row['from'] as number }),
      ...(row['count'] === undefined ? {} : { count: row['count'] as number }) }
  })
  if (refs.length === 0) refuse('malformed-declaration', 'every analysis finding needs native evidence')
  return refs
}
export function parseRsiProposal(raw: unknown, baseline: MethodAssets): RsiProposal {
  const proposal = record(raw, 'RSI proposal')
  assertClosedKeys(proposal, ['analysis', 'edit', 'method'], 'RSI proposal', 'malformed-declaration')
  const analysis = record(proposal['analysis'], 'analysis')
  assertClosedKeys(analysis, ['failure_modes', 'capability_gaps', 'success_habits'], 'analysis', 'malformed-declaration')
  const failure_modes = objects(analysis['failure_modes'], ['mode', 'description', 'needed_instead', 'evidence'], 'failure_modes')
    .map(row => ({ mode: text(row, 'mode', 'failure mode'), description: text(row, 'description', 'failure mode'),
      needed_instead: text(row, 'needed_instead', 'failure mode'), evidence: evidence(row['evidence']) }))
  const capability_gaps = objects(analysis['capability_gaps'], ['gap', 'description', 'evidence'], 'capability_gaps')
    .map(row => ({ gap: text(row, 'gap', 'capability gap'), description: text(row, 'description', 'capability gap'), evidence: evidence(row['evidence']) }))
  const success_habits = objects(analysis['success_habits'], ['habit', 'description', 'risk_if_broken', 'evidence'], 'success_habits')
    .map(row => ({ habit: text(row, 'habit', 'success habit'), description: text(row, 'description', 'success habit'),
      risk_if_broken: text(row, 'risk_if_broken', 'success habit'), evidence: evidence(row['evidence']) }))
  const labels = [...failure_modes.map(row => row.mode), ...capability_gaps.map(row => row.gap), ...success_habits.map(row => row.habit)]
  if (new Set(labels).size !== labels.length) refuse('malformed-declaration', 'analysis mode/gap/habit names must be unique')
  const row = record(proposal['edit'], 'edit')
  assertClosedKeys(row, ['hypothesis', 'targets_mode', 'why_not_lower_lever', 'trigger_condition', 'changes', 'predicted_affected', 'predicted_cases', 'predicted_families', 'retroactive_check', 'regression_risk'], 'edit', 'malformed-declaration')
  const targets_mode = text(row, 'targets_mode', 'edit')
  if (!labels.includes(targets_mode)) refuse('malformed-declaration', 'edit must target an evidenced mode, gap or success habit')
  const changes = objects(row['changes'], ['asset', 'target'], 'edit.changes').map(change => {
    const asset = text(change, 'asset', 'change')
    if (!['workflow', 'template', 'skill', 'tool'].includes(asset)) refuse('malformed-declaration', 'unknown changed asset class')
    return { asset: asset as StructuralEdit['asset'], target: text(change, 'target', 'change') }
  })
  const method = record(proposal['method'], 'proposal method') as unknown as MethodAssets
  const actual = structuralEditsOf(baseline, method)
  const keys = (edits: readonly StructuralEdit[]) => edits.map(edit => `${edit.asset}:${edit.target}`).sort()
  if (actual.length === 0 || digestOf(keys(changes)) !== digestOf(keys(actual)))
    refuse('malformed-declaration', 'declared changes must match the actual method diff exactly, without inert or undeclared assets')
  const predicted_affected = list(row['predicted_affected'], 'predicted_affected').map((id) => {
    if (typeof id !== 'string' || !id) refuse('malformed-declaration', 'predicted_affected must name Task ids')
    return id
  })
  if (predicted_affected.length === 0 || new Set(predicted_affected).size !== predicted_affected.length)
    refuse('malformed-declaration', 'predict a nonempty unique set of affected Tasks')
  const predictions = (field: string) => {
    const values = row[field] === undefined ? [] : list(row[field], field)
    if (values.some(v => typeof v !== 'string' || !v) || new Set(values).size !== values.length) refuse('malformed-declaration', `${field} requires unique nonempty IDs`)
    return values as string[]
  }
  const predicted_cases = predictions('predicted_cases'), predicted_families = predictions('predicted_families')
  const check = record(row['retroactive_check'], 'retroactive_check')
  assertClosedKeys(check, ['corrective', 'preservative', 'transfer'], 'retroactive_check', 'malformed-declaration')
  return { analysis: { failure_modes, capability_gaps, success_habits }, method, edit: {
    hypothesis: text(row, 'hypothesis', 'edit'), targets_mode, why_not_lower_lever: text(row, 'why_not_lower_lever', 'edit'),
    trigger_condition: text(row, 'trigger_condition', 'edit'), changes, predicted_affected, predicted_cases, predicted_families,
    retroactive_check: { corrective: text(check, 'corrective', 'retroactive_check'), preservative: text(check, 'preservative', 'retroactive_check'), transfer: text(check, 'transfer', 'retroactive_check') },
    regression_risk: text(row, 'regression_risk', 'edit') } }
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
  const proposal = parseRsiProposal(JSON.parse(input.content), baseline.assets)
  const candidate = await parseMethod(apparatus.domain, proposal.method)
  const cases = apparatus.domain.suite?.cases.filter(c => c.split === 'evolve')
  if (cases && (!proposal.edit.predicted_cases.length && !proposal.edit.predicted_families.length ||
    proposal.edit.predicted_cases.some(id => !cases.some(c => c.caseId === id)) || proposal.edit.predicted_families.some(id => !cases.some(c => c.familyId === id))))
    refuse('malformed-declaration', 'suite predictions must name frozen evolve case/family IDs')
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
  if (!pending) for (const path of input.paths) {
    await assertRunFile(workspace, path)
    const bytes = await readFile(inside(workspace, path, 'proposal path'))
    slots.push({ path, contentDigest: sha256(bytes), proposal: await apparatus.attachments.saveFile({ name: path, data: bytes }) })
  }
  const batchId = pending?.batchId ?? `batch-${digestOf(slots.map(s => s.contentDigest)).slice(0, 24)}`
  const existing = task.search?.batches?.find(b => b.batchId === batchId)
  const roundId = `round-${sha256(`${task.taskId}/${batchId}`).slice(0, 24)}`
  if (existing?.settled) {
    const request = task.rounds?.find(r => r.roundId === roundId)
    return { batchId, roundId, status: request?.status ?? existing.outcomes[0]?.status ?? 'no-candidates', revision: existing.outcomes.find(o => o.revision)?.revision, reason: existing.outcomes[0]?.detail, slots: existing.outcomes }
  }
  const history = searchHistory(apparatus, task)
  const incumbent = existing?.incumbent ?? history.incumbent
  const round = task.rounds?.find(r => r.roundId === roundId)?.round ?? (task.rounds?.length ?? 0) + 1
  const untried = existing?.untried ?? history.directives.untried
  const prune = existing?.prune ?? history.directives.prune
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
  return { batchId, roundId, status: request?.status ?? batch.outcomes[0]?.status ?? 'no-candidates', revision: batch.outcomes.find(o => o.revision)?.revision, reason: batch.outcomes[0]?.detail, slots: batch.outcomes }
}


function searchFact(apparatus: Apparatus, task: TaskState, kind: string, payload: unknown, key: string) {
  return apparatus.store.emit({ commandId: `${kind}:${task.taskId}:${key}`, protocol: TASK_PROTOCOL, version: TASK_VERSION,
    kind, subject: task.taskId, as: `agent:${task.responsibility!.agentId}`, payload })
}
