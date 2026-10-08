/**
 * Receipt construction and the views derived from it. Pure: it reads the store
 * snapshot and the session facts the sealer gathered, and writes nothing.
 * @module dsh-singularity-task-runtime/receipt
 */

import { canonicalize, criteriaDigestOf, executionReceiptDigest, sha256Hex, TERMINAL_RUN_STATUSES } from '@dangosys/dsh-singularity-task'
import type {
  ExecutionReceipt,
  ReceiptCompleteness,
  ReceiptMissingFact,
  ReceiptRequestCount,
  ReceiptRunModelUse,
  ReceiptSkillUse,
  ReceiptTemplateUse,
  ReviewCriterion,
  ReviewTokenUsage,
  RevisionPin,
  RunId,
  TaskRun,
  TaskSnapshot,
} from '@dangosys/dsh-singularity-task'
import type { SessionFacts } from './session-facts.ts'
import { decompositionMatches } from './session-facts.ts'

/** What the sealer hands the builder: the store's own records plus the session facts it gathered. */
export interface ReceiptBuildInput {
  readonly storeId: string
  readonly snapshot: TaskSnapshot
  readonly run: TaskRun
  readonly drain: 'in-process' | 'reconciled' | 'unconfirmed'
  /** Session facts per run of the sealed subtree; a missing entry means no log could be read for that run. */
  readonly sessionFacts: ReadonlyMap<RunId, SessionFacts>
  /** The environment revision this run is bound to, with its manifest digest. */
  readonly revision: RevisionPin
  readonly sealedAt: string
}

/** What one build attempt settled as; `refused` names a missing precondition and the sealer retries later. */
export type ReceiptBuildResult =
  | { readonly status: 'built'; readonly receipt: ExecutionReceipt }
  | { readonly status: 'refused'; readonly reason: string }

/** The execution subtree one run froze: itself first, then every descendant, in store order. */
export function executionSubtree(snapshot: TaskSnapshot, runId: RunId): readonly RunId[] {
  const found = new Set<RunId>([runId])
  for (;;) {
    const size = found.size
    for (const run of snapshot.runs) {
      if (run.parentRunId !== undefined && found.has(run.parentRunId)) found.add(run.runId)
    }
    if (found.size === size) break
  }
  return snapshot.runs.filter(run => found.has(run.runId)).map(run => run.runId)
}

/** One run's model use, from the facts its session log yielded. */
function modelUseOf(run: TaskRun, facts: SessionFacts | undefined): ReceiptRunModelUse {
  const base = { runId: run.runId, ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }) }
  // A birth-submitted replay never had a worker: there is no worker log to read,
  // which is a fact about the run rather than a reading failure.
  if (run.submission?.origin === 'runtime') return { ...base, status: 'no-worker', requests: [], logEvents: 0 }
  if (facts === undefined || facts.logEvents === undefined) return { ...base, status: 'unavailable', requests: [], logEvents: 0 }
  return { ...base, status: 'observed', requests: (facts.modelRequests ?? []) as readonly ReceiptRequestCount[], logEvents: facts.logEvents }
}

/** One run's skill consumption: what its binding granted, and what its log shows being loaded. */
function skillUseOf(run: TaskRun, facts: SessionFacts | undefined): ReceiptSkillUse {
  const bound = (run.providerBinding?.skills ?? []).map(skill => ({
    name: skill.name,
    role: skill.role,
    contentDigest: skill.contentDigest,
    contractDigest: skill.contractDigest,
  }))
  const loaded = [...new Set(facts?.skillCalls ?? [])]
  const granted = new Set(bound.map(skill => skill.name))
  return { runId: run.runId, bound, loaded, loadedOutsideGrant: loaded.filter(name => !granted.has(name)) }
}

/**
 * Every consumed task-template batch of the sealed subtree, with the session
 * observation that the batch's own call was really made: a batch admitted from a
 * template must be able to show the call that asked for it.
 */
function templateUseOf(snapshot: TaskSnapshot, run: TaskRun, facts: SessionFacts | undefined): ReceiptTemplateUse[] {
  const entries: ReceiptTemplateUse[] = []
  for (const batch of run.batches ?? []) {
    const proposal = snapshot.proposals?.byId[batch.proposalId]
    if (proposal === undefined || proposal.kind === 'root') continue
    const identity = proposal.identity
    if (identity.templateRef === undefined) continue
    const observation: ReceiptTemplateUse['observation'] =
      facts === undefined || facts.decompositions === undefined
        ? 'unavailable'
        : facts.decompositions.some(fact =>
            decompositionMatches(
              fact,
              { templateRef: identity.templateRef, templateParameters: identity.templateParameters ?? {} },
              [batch.batchId, batch.proposalId],
            ),
          )
          ? 'observed'
          : 'not-observed'
    entries.push({
      runId: run.runId,
      proposalId: batch.proposalId,
      batchId: batch.batchId,
      templateRef: identity.templateRef,
      templateParameters: (identity.templateParameters ?? {}) as Readonly<Record<string, unknown>>,
      childTaskIds: [...batch.memberTaskIds],
      observation,
    })
  }
  return entries
}

/** The submitting worker's own account, contrasted with the references the store backs. */
function claimsOf(run: TaskRun, evidenceRefs: readonly string[]): ExecutionReceipt['review']['claims'] {
  if (run.submission === undefined) return null
  const backed = new Set(evidenceRefs)
  const submitted = [...run.submission.evidenceRefs]
  return { submitted, backed: submitted.filter(ref => backed.has(ref)), unbacked: submitted.filter(ref => !backed.has(ref)) }
}

/** Build one Run's receipt from the store's records and the session facts handed in. */
export function buildExecutionReceipt(input: ReceiptBuildInput): ReceiptBuildResult {
  const { snapshot, run } = input
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    return { status: 'refused', reason: `run "${run.runId}" is ${run.status}; only a terminal run is sealed` }
  }
  const task = snapshot.tasks.find(item => item.taskId === run.taskId)
  if (task === undefined) return { status: 'refused', reason: `run "${run.runId}" names unknown task "${run.taskId}"` }

  const subtree = executionSubtree(snapshot, run.runId)
  const members = subtree.flatMap(runId => snapshot.runs.filter(candidate => candidate.runId === runId))
  const factsOf = (runId: RunId): SessionFacts | undefined => input.sessionFacts.get(runId)

  const review = snapshot.reviews.find(item => item.runId === run.runId)
  const recordedCriteria: readonly ReviewCriterion[] = review?.criteria ?? []
  const reviewRef = review === undefined ? null : `${review.taskId}#${run.runId}`

  const missing: { fact: ReceiptMissingFact; detail: string }[] = []
  const modelUse = members.map(member => modelUseOf(member, factsOf(member.runId)))
  const unreadable = members.filter(member => modelUse.find(entry => entry.runId === member.runId)?.status === 'unavailable')
  if (unreadable.length > 0) {
    missing.push({
      fact: 'session-log',
      detail: `no persisted session log could be read for run${unreadable.length > 1 ? 's' : ''} ${unreadable.map(member => member.runId).join(', ')}`,
    })
  }
  // A log that could not be read establishes no request identity either: both
  // facts are recorded, so a consumer asking for one is refused by name.
  const withoutRequests = modelUse.filter(entry => entry.status !== 'observed' || entry.requests.length === 0)
  if (withoutRequests.length > 0) {
    const readable = withoutRequests.filter(entry => entry.status === 'observed').map(entry => entry.runId)
    const unreadable = withoutRequests.filter(entry => entry.status !== 'observed').map(entry => entry.runId)
    const parts: string[] = []
    if (readable.length > 0) parts.push(`the persisted log of run${readable.length > 1 ? 's' : ''} ${readable.join(', ')} records no request header`)
    if (unreadable.length > 0) parts.push(`no request identity could be read for run${unreadable.length > 1 ? 's' : ''} ${unreadable.join(', ')}`)
    missing.push({ fact: 'model-requests', detail: parts.join('; ') })
  }
  const templates = members.flatMap(member => templateUseOf(snapshot, member, factsOf(member.runId)))
  const unavailable = templates.filter(entry => entry.observation === 'unavailable')
  if (unavailable.length > 0) {
    missing.push({
      fact: 'template-consumption',
      detail: `no persisted session log could be read to confirm ${unavailable.length} template consumption${unavailable.length > 1 ? 's' : ''}`,
    })
  }
  const stillRunning = members.filter(member => !TERMINAL_RUN_STATUSES.has(member.status))
  if (stillRunning.length > 0) {
    missing.push({
      fact: 'subtree-usage',
      detail: `run${stillRunning.length > 1 ? 's' : ''} ${stillRunning.map(member => member.runId).join(', ')} of the sealed subtree had not reached a terminal state, so its usage is unknown`,
    })
  }
  if (input.drain === 'unconfirmed') {
    missing.push({ fact: 'drain', detail: 'the run\'s managed work was not confirmed stopped before sealing' })
  }
  if (reviewRef === null) {
    missing.push({ fact: 'review', detail: `the store holds no terminal review for run "${run.runId}"` })
  }

  const digestOf = (value: unknown): string => sha256Hex(canonicalize(value))
  const withoutDigest: Omit<ExecutionReceipt, 'digest'> = {
    formatVersion: 1,
    runId: run.runId,
    taskId: run.taskId,
    storeId: input.storeId,
    ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
    ...(run.parentRunId === undefined ? {} : { parentRunId: run.parentRunId }),
    outcome: run.status,
    contract: {
      contractDigest: task.contractDigest ?? null,
      criteriaDigest: criteriaDigestOf(task.acceptanceCriteria),
      requestedCapabilities: [...task.requestedCapabilities],
    },
    environment: {
      revision: input.revision,
      bindingDigest: run.providerBinding === undefined ? null : digestOf(run.providerBinding),
      providerRegistryRevision: run.providerBinding?.registryRevision ?? null,
      templatesRoot: run.taskTemplatesRoot ?? null,
      preset: run.agentPreset ?? null,
    },
    input: {
      workspacePath: run.placement?.workspacePath ?? null,
      snapshotPath: run.placement?.inputSnapshotPath ?? null,
      snapshotDigest: run.placement?.inputSnapshotDigest ?? null,
    },
    review: {
      reviewRef,
      criteria: recordedCriteria.map(item => ({ ...item })),
      criteriaDigest: criteriaDigestOf(recordedCriteria),
      evidenceRefs: [...(review?.evidenceRefs ?? [])],
      anomalies: [...(review?.anomalies ?? [])],
      claims: claimsOf(run, review?.evidenceRefs ?? []),
    },
    modelUse,
    skills: members.map(member => skillUseOf(member, factsOf(member.runId))),
    templates,
    subtree: [...subtree],
    drain: input.drain,
    completeness: { status: 'complete', missing: [] } satisfies ReceiptCompleteness,
    sealedAt: input.sealedAt,
  }
  const complete: Omit<ExecutionReceipt, 'digest'> = {
    ...withoutDigest,
    completeness: { status: missing.length === 0 ? 'complete' : 'incomplete', missing },
  }
  const receipt: ExecutionReceipt = { ...complete, digest: '' }
  return { status: 'built', receipt: { ...receipt, digest: executionReceiptDigest(receipt) } }
}

/** The execution usage one receipt covers: the口径 of a run subtree's tokens and tool calls. */
export interface ExecutionUsage {
  readonly status: 'reported' | 'unknown'
  readonly reason?: string
  readonly runIds: readonly string[]
  readonly tokens?: ReviewTokenUsage
  readonly toolCalls?: { readonly calls: number; readonly failures: number }
  /** Runs whose counters are not terminal or not whole numbers, for diagnosis. */
  readonly incompleteRuns: readonly string[]
}

/**
 * Aggregate a sealed subtree's usage from the store's review metrics — never by
 * walking `parentRunId` now: the members are the ones the receipt froze, so a
 * later replay cannot be counted into a run that had already settled.
 */
export function executionUsage(snapshot: TaskSnapshot, receipt: ExecutionReceipt): ExecutionUsage {
  const members = receipt.subtree.flatMap(runId => snapshot.runs.filter(run => run.runId === runId))
  const incompleteRuns: string[] = []
  let calls = 0
  let failures = 0
  let completeCalls = true
  let completeTokens = true
  const tokens: ReviewTokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const run of members) {
    const record = snapshot.reviews.find(item => item.runId === run.runId && item.taskId === run.taskId)
    // A member that is not terminal has no whole reading at all: neither its
    // token buckets nor its call counters are final yet.
    const terminal = TERMINAL_RUN_STATUSES.has(run.status)
    const counters = record?.metrics?.toolCalls
    if (!terminal || counters === undefined ||
      !Number.isSafeInteger(counters.calls) || counters.calls < 0 ||
      !Number.isSafeInteger(counters.failures) || counters.failures < 0) {
      completeCalls = false
      if (!incompleteRuns.includes(run.runId)) incompleteRuns.push(run.runId)
    } else {
      calls += counters.calls
      failures += counters.failures
    }
    const usage = record?.metrics?.tokens
    if (!terminal || usage === undefined || Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0)) {
      completeTokens = false
      if (!incompleteRuns.includes(run.runId)) incompleteRuns.push(run.runId)
    } else {
      for (const key of Object.keys(tokens) as (keyof ReviewTokenUsage)[]) tokens[key] += usage[key]
    }
  }
  const runIds = members.map(run => run.runId)
  if (!Number.isSafeInteger(calls) || !Number.isSafeInteger(failures)) {
    return { status: 'unknown', reason: 'the sealed subtree tool-call counters exceed safe integer range', runIds, incompleteRuns }
  }
  if (!completeCalls && !completeTokens) {
    return {
      status: 'unknown',
      reason: `run${incompleteRuns.length > 1 ? 's' : ''} ${incompleteRuns.join(', ')} in the sealed subtree carr${incompleteRuns.length > 1 ? 'y' : 'ies'} incomplete token and tool-call counters`,
      runIds,
      incompleteRuns,
    }
  }
  return {
    status: 'reported',
    runIds,
    ...(completeTokens ? { tokens } : {}),
    ...(completeCalls ? { toolCalls: { calls, failures } } : {}),
    incompleteRuns,
  }
}

/** Refuse a receipt that cannot establish the facts a consumer needs, naming them. */
export function requireReceiptFacts(
  receipt: ExecutionReceipt,
  facts: readonly ReceiptMissingFact[],
  where: string,
): void {
  const absent = facts.filter(fact => receipt.completeness.missing.some(entry => entry.fact === fact))
  if (absent.length === 0) return
  const details = receipt.completeness.missing.filter(entry => absent.includes(entry.fact))
  throw new Error(
    `${where}: the execution receipt of run "${receipt.runId}" is incomplete — it cannot establish ${absent.join(', ')} ` +
      `(${details.map(entry => entry.detail).join('; ')}); a fact that was never established is never assumed`,
  )
}
