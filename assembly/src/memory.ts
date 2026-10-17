import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { digest, record, text } from '../../src/task/shape.ts'
import type { Apparatus } from './apparatus.ts'
import { readScopeOf } from './coordination.ts'
import type { MethodAssets } from './method.ts'
import type { TaskTemplate } from './template.ts'

export interface MemoryEvidenceRef {
  readonly taskId: string
  readonly runId: string
  readonly status: 'verified'
  readonly artifactDigest: string
}
export interface MemorySource {
  readonly sessionId: string
  readonly eventCount: number
  readonly digest: string
  readonly inputDigest: string
}
export type MemoryScope = {
  readonly kind: 'task'
  readonly taskId: string
  readonly runId: string
  readonly contractDigest: string
  readonly method: RevisionRef
} | {
  readonly kind: 'review'
  readonly reviewId: string
  readonly subjectDigest: string
  readonly method: RevisionRef
}
export interface MemoryContext {
  readonly scope: MemoryScope
  readonly evidenceRefs: readonly MemoryEvidenceRef[]
  /** Host-only exact-repeat filter; never put these authority texts into the summary request. */
  readonly excludedTexts: readonly string[]
}
/** Model working notes, never acceptance evidence or an amendment to a frozen contract. */
export interface MemoryDraft {
  readonly decisions: readonly string[]
  readonly evidenceRefs: readonly Pick<MemoryEvidenceRef, 'taskId' | 'runId'>[]
  readonly hypotheses: readonly string[]
  readonly openQuestions: readonly string[]
  readonly exclusions: readonly string[]
}
export interface MemoryCheckpoint extends Omit<MemoryDraft, 'evidenceRefs'> {
  readonly formatVersion: 1
  readonly scope: MemoryScope
  readonly sources: readonly MemorySource[]
  readonly evidenceRefs: readonly MemoryEvidenceRef[]
}

/** Project references and authoritative text from the same native responsibility read scope. */
export async function memoryContextOf(apparatus: Apparatus, agentId: string): Promise<MemoryContext> {
  const cut = apparatus.store.load(), tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const node = cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, agentId)
  if (node === undefined)
    refuse('not-responsible', 'memory requires an assigned Task Run or independent Review')
  const reviews = [...cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].filter(
    (review) => review.agentId === agentId && review.sessionId === node.sessionId,
  )
  const review = reviews.at(-1)
  const task = [...tasks.values()].findLast((task) => task.responsibility?.agentId === agentId
    && Object.values(task.runs).at(-1)?.actor === task.responsibility.agentIdentity)
  const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
  if (review === undefined && (task === undefined || run === undefined))
    refuse('not-responsible', 'memory requires an assigned Task Run or independent Review')
  const scope: MemoryScope = review === undefined ? {
    kind: 'task', taskId: task!.taskId, runId: run!.runId, contractDigest: task!.contractDigest!, method: { ...run!.revision },
  } : { kind: 'review', reviewId: review.reviewId, subjectDigest: review.subjectDigest, method: { ...review.method } }
  const { visible, frozenProducers } = await readScopeOf(apparatus, agentId, cut)
  const evidenceRefs: MemoryEvidenceRef[] = [], excludedTexts = new Set<string>()
  for (const state of tasks.values()) {
    if (!visible!.has(state.taskId)) continue
    const contract = frozenProducers.get(state.taskId)?.[0]?.contract ?? state.contract!
    for (const value of [contract.goal, JSON.stringify(contract), ...contract.criteria.map((criterion) => criterion.statement)])
      excludedTexts.add(value.trim())
    const producers = frozenProducers.get(state.taskId)
    const verified = producers === undefined ? Object.values(state.runs).filter((run) => run.status === 'verified' && run.submission !== undefined) : producers
    for (const run of verified) evidenceRefs.push({ taskId: state.taskId, runId: run.runId,
      status: 'verified', artifactDigest: 'artifactDigest' in run ? run.artifactDigest : run.submission!.artifactDigest })
  }
  if (review !== undefined) for (const criterion of review.criteria) excludedTexts.add(criterion.statement.trim())
  const revision = cut.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, scope.method.environmentId)?.revisions[scope.method.revisionId]
  if (revision?.contentDigest !== scope.method.digest) refuse('unknown-revision', 'memory method does not match its pinned revision')
  const assets = revision.manifest as MethodAssets
  excludedTexts.add(JSON.stringify(assets))
  for (const skill of assets.skills) excludedTexts.add(skill.content.trim())
  for (const tool of assets.tools) excludedTexts.add(tool.source.trim())
  // Active method manifests passed assembly admission; this projection needs no asset materialization.
  for (const template of assets.templates as readonly Pick<TaskTemplate, 'goal' | 'guidance' | 'criteria'>[]) {
    excludedTexts.add(JSON.stringify(template))
    excludedTexts.add(template.goal.trim())
    if (template.guidance !== undefined) excludedTexts.add(template.guidance.trim())
    for (const criterion of template.criteria) excludedTexts.add(criterion.statement.trim())
  }
  return { scope, evidenceRefs, excludedTexts: [...excludedTexts] }
}

/** Normalize exact repeats, reject forged evidence references, and bind the host-owned source. */
export function memoryCheckpointOf(context: MemoryContext, source: MemorySource, draft: unknown): MemoryCheckpoint {
  const raw = record(draft, 'memory draft')
  assertClosedKeys(raw, ['decisions', 'evidenceRefs', 'hypotheses', 'openQuestions', 'exclusions'], 'memory draft')
  const supplied = record(source, 'memory source')
  assertClosedKeys(supplied, ['sessionId', 'eventCount', 'digest', 'inputDigest'], 'memory source')
  const eventCount = supplied['eventCount']
  if (!Number.isSafeInteger(eventCount) || (eventCount as number) < 0)
    refuse('malformed-payload', 'memory source.eventCount must be a nonnegative safe integer')
  const excluded = new Set(context.excludedTexts.map((text) => text.trim()))
  const notes = (field: 'decisions' | 'hypotheses' | 'openQuestions' | 'exclusions'): readonly string[] => {
    const values = raw[field]
    if (!Array.isArray(values)) refuse('malformed-payload', `memory draft.${field} must be a string array`)
    const kept = new Set<string>()
    for (const value of values) {
      if (typeof value !== 'string' || value.trim().length === 0)
        refuse('malformed-payload', `memory draft.${field} contains an empty or non-string note`)
      const note = value.trim()
      if (!excluded.has(note)) kept.add(note)
    }
    return [...kept]
  }
  const refs = raw['evidenceRefs']
  if (!Array.isArray(refs)) refuse('malformed-payload', 'memory draft.evidenceRefs must be an array of verified Task/Run references')
  const evidenceRefs: MemoryEvidenceRef[] = []
  for (const entry of refs) {
    const held = record(entry, 'memory evidence reference')
    assertClosedKeys(held, ['taskId', 'runId'], 'memory evidence reference')
    const ref = { taskId: text(held, 'taskId', 'memory evidence reference'), runId: text(held, 'runId', 'memory evidence reference') }
    const allowed = context.evidenceRefs.find((allowed) => allowed.taskId === ref.taskId && allowed.runId === ref.runId)
    if (allowed === undefined)
      refuse('not-responsible', 'memory evidence reference is outside the visible verified Run scope')
    if (!evidenceRefs.some((existing) => existing.taskId === ref.taskId && existing.runId === ref.runId)) evidenceRefs.push({ ...allowed })
  }
  return { formatVersion: 1, scope: { ...context.scope, method: { ...context.scope.method } }, sources: [{
    sessionId: text(supplied, 'sessionId', 'memory source'), eventCount: eventCount as number,
    digest: digest(supplied, 'digest', 'memory source'), inputDigest: digest(supplied, 'inputDigest', 'memory source'),
  }], decisions: notes('decisions'), evidenceRefs, hypotheses: notes('hypotheses'), openQuestions: notes('openQuestions'), exclusions: notes('exclusions') }
}
