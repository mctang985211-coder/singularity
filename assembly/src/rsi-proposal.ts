import { readFile } from 'node:fs/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { assertClosedKeys, digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { structuralEditsOf, structuralEditDetailsOf } from '../../src/strategy/edits.ts'
import type { StructuralEdit } from '../../src/strategy/protocol.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import type { RoundRequest } from '../../src/task/lifecycle.ts'
import { ENVIRONMENT_KINDS, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION } from '../../src/environment/protocol.ts'
import { RELEASE_KINDS, RELEASE_PROTOCOL, RELEASE_VERSION, type ReleaseDraft } from '../../src/release/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { taskStateOf } from './apparatus.ts'
import { assertImprovementOwner } from './improvement.ts'
import { createMethod, loadMethod, bindingsForContract, type MethodAssets } from './method.ts'
import { contractFor } from './inputs.ts'
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
At least one success habit must be preserved. Descriptions are entity-free mechanisms; task details belong only in evidence.
Edit = {hypothesis:string,targets_mode:string,why_not_lower_lever:string,trigger_condition:string,changes:{asset:'template'|'skill'|'tool',target:string}[],predicted_affected:string[],retroactive_check:{corrective:string,preservative:string,transfer:string},regression_risk:string}.
The edit budget is ONE independent mechanism; dependent changes may span multiple assets. Declare every changed asset exactly once. targets_mode names an analysis mode/gap/habit. predicted_affected names actual Task ids in the cited evidence. The three counterfactuals explain correction, preservation and transfer to an unfamiliar task. method is the complete Method JSON. Metadata and task evidence must never be copied into method assets.`

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
  if (success_habits.length === 0) refuse('malformed-declaration', 'RRSI analysis must preserve at least one evidenced success habit')
  const labels = [...failure_modes.map(row => row.mode), ...capability_gaps.map(row => row.gap), ...success_habits.map(row => row.habit)]
  if (new Set(labels).size !== labels.length) refuse('malformed-declaration', 'analysis mode/gap/habit names must be unique')
  const row = record(proposal['edit'], 'edit')
  assertClosedKeys(row, ['hypothesis', 'targets_mode', 'why_not_lower_lever', 'trigger_condition', 'changes', 'predicted_affected', 'retroactive_check', 'regression_risk'], 'edit', 'malformed-declaration')
  const targets_mode = text(row, 'targets_mode', 'edit')
  if (!labels.includes(targets_mode)) refuse('malformed-declaration', 'edit must target an evidenced mode, gap or success habit')
  const changes = objects(row['changes'], ['asset', 'target'], 'edit.changes').map(change => {
    const asset = text(change, 'asset', 'change')
    if (!['template', 'skill', 'tool'].includes(asset)) refuse('malformed-declaration', 'unknown changed asset class')
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
  const check = record(row['retroactive_check'], 'retroactive_check')
  assertClosedKeys(check, ['corrective', 'preservative', 'transfer'], 'retroactive_check', 'malformed-declaration')
  return { analysis: { failure_modes, capability_gaps, success_habits }, method, edit: {
    hypothesis: text(row, 'hypothesis', 'edit'), targets_mode, why_not_lower_lever: text(row, 'why_not_lower_lever', 'edit'),
    trigger_condition: text(row, 'trigger_condition', 'edit'), changes, predicted_affected,
    retroactive_check: { corrective: text(check, 'corrective', 'retroactive_check'), preservative: text(check, 'preservative', 'retroactive_check'), transfer: text(check, 'transfer', 'retroactive_check') },
    regression_risk: text(row, 'regression_risk', 'edit') } }
}

/** RRSI done() -> critic -> evaluation request. No parallel state store or model-controlled round ids. */
export async function proposeRsiMethod(apparatus: Apparatus, seams: ChildSessionSeams, agent: Agent,
  agentId: string, input: { readonly path: string }, signal: AbortSignal) {
  assertImprovementOwner(apparatus, agentId)
  const cut = apparatus.store.load(), tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION),
    agents = cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
  const task = [...tasks.values()].findLast(task => task.responsibility?.agentId === agentId)!, run = Object.values(task.runs).at(-1)!
  const workspace = run.bubble!.workspace.ref
  await assertRunFile(workspace, input.path)
  const incumbent = taskStateOf(apparatus, run.relatedTo!.taskId).runs[run.relatedTo!.runId]!.revision
  const baseline = await loadMethod(apparatus, incumbent)
  const proposal = parseRsiProposal(JSON.parse(await readFile(inside(workspace, input.path, 'proposal path'), 'utf8')), baseline.assets)
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
  const revision = await createMethod(apparatus, proposal.method)
  const current = taskStateOf(apparatus, task.taskId)
  const previous = current.rounds?.find(request => request.candidates.some(candidate => candidate.digest === revision.digest))
  if (previous !== undefined) return { roundId: previous.roundId, status: previous.status, revision }
  if (current.rounds?.some(request => request.status === 'pending'))
    refuse('illegal-transition', 'read the pending round outcome before proposing another candidate')
  assertActive(apparatus, task.taskId)
  const candidate = await loadMethod(apparatus, revision)
  const rootBindings = (loaded: typeof baseline) => bindingsForContract(
    contractFor(loaded.domain, loaded.domain.templates.get(loaded.assets.rootTemplate)!, task.contract!.goal), loaded.assets).tools
  if (digestOf(rootBindings(baseline)) !== digestOf(rootBindings(candidate)))
    refuse('caliber-mismatch', 'proposal changes root-bound Tools; bind helpers only to delegated Tasks')
  const screen = await reviewSubject(apparatus, seams, agent, `proposal:${task.taskId}:${digestOf(proposal)}`, {
    purpose: 'proposal', designReference: rsiDesignReference, baseline: baseline.assets, assets: candidate.assets,
    analysis: proposal.analysis, edit: proposal.edit, nativeEvidence,
    changes: structuralEditDetailsOf(baseline.assets, candidate.assets),
    requirements: rsiCriticRequirements,
  }, signal, incumbent, false, rsiProposalCriteria,
  { kind: 'proposal', environmentId: revision.environmentId, revisionId: revision.revisionId, assetsDigest: revision.digest })
  if (screen.verdict !== 'pass') return { status: 'rejected', revision, reviewId: screen.reviewId, reason: screen.detail }
  const roundId = `round-${sha256(`${task.taskId}/${revision.digest}`).slice(0, 24)}`
  const commandId = `round-request:${roundId}`
  await apparatus.store.emit(() => {
    // Screening awaits native sessions. Allocate against the committed state inside
    // the existing write queue, and preserve the original number on redelivery.
    const prior = apparatus.store.committedOf(commandId)?.payload as Omit<RoundRequest, 'status' | 'error'> | undefined
    const requests = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .flatMap(task => task.rounds ?? [])
    return { commandId, protocol: TASK_PROTOCOL, version: TASK_VERSION,
      kind: 'rsi/round-requested', subject: task.taskId, as: `agent:${agentId}`,
      payload: prior ?? { roundId, round: Math.max(0, ...requests.map(request => request.round)) + 1,
        incumbent, candidates: [revision], runId: run.runId } }
  }, () => assertActive(apparatus, task.taskId))
  const request = taskStateOf(apparatus, task.taskId).rounds!.find(request => request.roundId === roundId)!
  return { roundId, status: request.status, revision, reviewId: screen.reviewId }
}

/** A truthful no-winner observation is feedback for another attempt, never RSI completion. */
export function assertRsiReportReady(apparatus: Apparatus, task: TaskState): void {
  const run = Object.values(task.runs).at(-1)!
  if (run.purpose !== 'improve') return
  const rounds = new Set(task.rounds?.filter(round => round.status === 'completed').map(round => round.roundId))
  const entries = apparatus.store.load().entries()
  const published = entries.some((entry, index) => {
    if (entry.protocol !== RELEASE_PROTOCOL || entry.version !== RELEASE_VERSION || entry.kind !== RELEASE_KINDS.drafted) return false
    const draft = entry.payload as ReleaseDraft
    const basis = draft.basis
    if (basis.kind !== 'decision' || !rounds.has(basis.roundId)) return false
    const approved = entries.findIndex((fact, approvedIndex) => approvedIndex > index &&
      fact.protocol === RELEASE_PROTOCOL && fact.version === RELEASE_VERSION && fact.kind === RELEASE_KINDS.approved &&
      fact.subject === entry.subject && (fact.payload as { draftDigest: string }).draftDigest === draft.draftDigest)
    return approved >= 0 && entries.slice(approved + 1).some(fact =>
      fact.protocol === ENVIRONMENT_PROTOCOL && fact.version === ENVIRONMENT_VERSION && fact.kind === ENVIRONMENT_KINDS.pointerSwitched &&
      fact.subject === entry.subject && (fact.payload as { to: string; expected: string }).to === draft.revisionId &&
      (fact.payload as { expected: string }).expected === basis.expected)
  })
  if (!published) refuse('illegal-transition', 'RSI has no approved published winner; revise the mechanism using the recorded outcome and propose again')
}
