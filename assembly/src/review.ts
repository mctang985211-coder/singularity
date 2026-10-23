import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { openChildSession, type ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { createReviewCommands } from '../../src/review/commands.ts'
import {
  REVIEW_PROTOCOL,
  REVIEW_VERSION,
  readFindings,
  type ReviewRun,
  type ReviewTarget,
  type Finding,
} from '../../src/review/protocol.ts'
import { childSettled, projectPlan } from '../../src/task/tree.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import type { AcceptanceCriterion } from '../../src/task/contract.ts'
import type { RevisionRef, RunState } from '../../src/task/protocol.ts'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import { declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { publishedMethod, seedMethod } from './method.ts'
import { sealedBytes } from './sealed.ts'
import { sha256 } from './ids.ts'
import { schedulerMessage } from '../../src/runtime/task-message.ts'
import { assertRunFile } from './workspace.ts'
import type { ProductionVerdict } from '../../src/verifier/production.ts'
import { outcomesAnswered, planOutcomeOf } from './read.ts'
import { reviewInputsOf } from './inputs.ts'
import { searchView } from './rsi-history.ts'
import { foldSubjects } from '../../src/protocol/fold.ts'
import { STRATEGY_PROTOCOL, STRATEGY_VERSION, type RoundState } from '../../src/strategy/protocol.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { projectEvaluation } from '../../src/measure/view.ts'
import { pairedReport } from '../../src/measure/paired.ts'
import type { ControlSnapshot } from './snapshot.ts'
import type { RsiEvidence } from './rsi-proposal.ts'
import type { textPage } from './pages.ts'
import { digestOf } from '../../src/protocol/envelope.ts'

export const SUBJECT_INPUT = 'singularity-subject'
// RRSI critic.py reviews intent/content before evaluation; it never solves a task.
export const methodReviewTools = new Set(['read', 'glob', 'grep', 'write', 'edit', 'singularity_read', 'singularity_submit'])
export interface ReviewWitness {
  readonly reviewId: string
  readonly subjectDigest: string
  readonly artifactDigest: string
  readonly agentId: string
  readonly verdict: Finding['verdict']
  readonly detail: string
  readonly findings: readonly Finding[]
}
export function reviewOf(apparatus: Apparatus, agentId: string): ReviewRun | undefined {
  return [...apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].findLast(
    (r) => r.agentId === agentId,
  )
}
export interface FrozenInputProducer {
  readonly name: string
  readonly taskId: string
  readonly contract: NonNullable<TaskState['contract']>
  readonly runId: string
  readonly revision: RevisionRef
  readonly status: 'verified'
  readonly artifact: FileAttachmentRef
  readonly artifactDigest: string
  readonly source: NonNullable<RunState['submission']>['source']
  readonly evidence: RunState['evidence']
}
export interface FrozenRsiEvidence {
  readonly cutoff: number
  readonly rootId: string | null
  readonly sourceTrace: FileAttachmentRef | null
  readonly citations: readonly { readonly reference: RsiEvidence
    readonly page: ReturnType<typeof textPage> & { readonly seq: number; readonly type: string } }[]
  readonly rounds: readonly {
    readonly request: NonNullable<TaskState['rounds']>[number]
    readonly snapshot: ControlSnapshot['rounds'][number] | null
    readonly evaluations: readonly EvaluationState[]
  }[]
}

/** The report can cite only evidence available before its own submission, not later validation. */
async function reportEvidence(apparatus: Apparatus, taskId: string, run: RunState): Promise<FrozenRsiEvidence> {
  const facts = apparatus.store.load().entries()
  const submitted = facts.find(fact => fact.subject === taskId && fact.kind === 'run/submitted' &&
    (fact.payload as { runId: string }).runId === run.runId)
  if (submitted === undefined) refuse('illegal-transition', 'report evidence requires a sealed submission')
  const entries = facts.filter(fact => fact.seq <= submitted.seq)
  const tasks = foldSubjects<TaskState>(apparatus.registry, entries, TASK_PROTOCOL, TASK_VERSION)
  const strategies = foldSubjects<RoundState>(apparatus.registry, entries, STRATEGY_PROTOCOL, STRATEGY_VERSION)
  const measurements = foldSubjects<EvaluationState>(apparatus.registry, entries, MEASURE_PROTOCOL, MEASURE_VERSION)
  const reviews = foldSubjects<ReviewRun>(apparatus.registry, entries, REVIEW_PROTOCOL, REVIEW_VERSION)
  const task = tasks.get(taskId)!, citations = new Map<string, FrozenRsiEvidence['citations'][number]>()
  const revisions = new Set(task.search?.batches?.flatMap(batch => batch.outcomes.flatMap(outcome => outcome.revision?.digest ?? [])))
  for (const digest of revisions) {
    const reviewId = `review-${sha256(`${apparatus.controlId}/proposal:${taskId}:${digest}`).slice(0, 24)}`
    const review = reviews.get(reviewId)
    if (review?.target.kind !== 'proposal' || review.target.assetsDigest !== digest) continue
    const subject = JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8')) as { nativeEvidence?: FrozenRsiEvidence['citations'] }
    for (const citation of subject.nativeEvidence ?? []) citations.set(digestOf(citation), citation)
  }
  const rootId = run.relatedTo?.taskId ?? null
  return { cutoff: submitted.seq + 1, rootId, sourceTrace: rootId === null ? null : tasks.get(rootId)?.rsi?.trace ?? null,
    citations: [...citations.values()],
    rounds: (tasks.get(taskId)!.rounds ?? []).filter(request => request.runId === run.runId).map(request => {
      const strategy = strategies.get(request.roundId)
      const evaluations = [...measurements.values()].filter(state => (state.matrix === undefined || state.matrix.split === 'evolve') &&
        (state.evaluationId === `${request.roundId}:bootstrap:evaluation` ||
          state.evaluationId.startsWith(`${request.roundId}:`) && /^\d+:candidate:evaluation$/.test(state.evaluationId.slice(request.roundId.length + 1))))
      const baseline = evaluations.find(state => state.evaluationId === `${request.roundId}:bootstrap:evaluation`)
      return { request, evaluations, snapshot: strategy === undefined ? null : {
        roundId: strategy.roundId, plan: strategy.plan, submissions: strategy.submissions, decision: strategy.decision ?? null,
        evaluations: evaluations.map(state => ({ evaluationId: state.evaluationId, state, report: projectEvaluation(state),
          paired: baseline?.matrix && state.matrix && state !== baseline ? pairedReport(baseline, state) : null })),
      } }
    }) }
}
export async function acceptanceSubject(apparatus: Apparatus, taskId: string, run: RunState,
  checks: readonly ProductionVerdict[],
) {
  const task = taskStateOf(apparatus, taskId)
  const inputProducers: FrozenInputProducer[] = task.contract!.inputs.flatMap((input) => {
    if (input.source.kind !== 'artifact') return []
    const bound = run.bubble?.inputs.find((bound) => bound.name === input.name)
    const attachment = run.submission!.files.inputs.find((file) => file.name === input.name)?.attachment
    const producer = taskStateOf(apparatus, input.source.taskId)
    const held = bound?.producerRunId === undefined ? undefined : producer.runs[bound.producerRunId]
    if (held?.status !== 'verified' || held.submission === undefined || attachment === undefined ||
      attachment.attachmentId !== `sha256:${bound?.digest}` || held.submission.artifactDigest !== bound?.digest)
      refuse('evidence-input-mismatch', `input "${input.name}" has no exact verified producer Run binding`)
    return [{ name: input.name, taskId: producer.taskId, contract: producer.contract!, runId: held.runId,
      revision: held.revision, status: 'verified', artifact: held.submission.files.artifact,
      artifactDigest: held.submission.artifactDigest, source: held.submission.source, evidence: held.evidence }]
  })
  return {
    purpose: 'acceptance',
    taskId, runId: run.runId, contract: task.contract,
    artifact: run.submission!.files.artifact,
    artifactDigest: run.submission!.artifactDigest,
    checks,
    inputs: run.submission!.files.inputs,
    inputProducers,
    ...(run.purpose === 'improve' ? { rsiEvidence: await reportEvidence(apparatus, taskId, run) } : {}),
    ...(task.search === undefined ? {} : { search: searchView(apparatus, task), rounds: task.rounds ?? [], transfer: task.transfer ?? null }),
    source: run.submission!.source,
    contributions: task.decomposition?.children.map((child) => {
      const state = taskStateOf(apparatus, child.taskId)
      const held = Object.values(state.runs).findLast((run) => run.status === 'verified') ?? Object.values(state.runs).at(-1)
      return { taskId: child.taskId, goal: state.contract!.goal, supports: child.supports,
        runId: held?.runId, status: held?.status, artifact: held?.submission?.files.artifact,
        artifactDigest: held?.submission?.artifactDigest, source: held?.submission?.source, evidence: held?.evidence }
    }) ?? [],
  }
}
export function witnessOf(review: ReviewRun): ReviewWitness {
  if (review.status !== 'completed')
    refuse('unapproved-revision', 'review has no completed judgment: ' + review.failure)
  const findings = review.findings!
  const verdict = findings.every((f) => f.verdict === 'pass')
    ? 'pass'
    : findings.some((f) => f.verdict === 'fail')
      ? 'fail'
      : findings.some((f) => f.verdict === 'unknown')
        ? 'unknown'
        : 'partial'
  return {
    reviewId: review.reviewId,
    subjectDigest: review.subjectDigest,
    artifactDigest: review.result!.attachmentId.slice(7),
    agentId: review.agentId,
    verdict,
    findings,
    detail: findings.map((f) => `${f.criterionId}: ${f.detail}`).join('\n'),
  }
}
export async function submitReview(apparatus: Apparatus, review: ReviewRun, path: string): Promise<ReviewWitness> {
  declareCaller(apparatus, review.agentId)
  if (review.status === 'completed') return witnessOf(review)
  if (path !== 'review.json') refuse('malformed-declaration', 'write the final judgment to review.json')
  await assertRunFile(review.workspace, path)
  const bytes = await readFile(join(review.workspace, path))
  const result = JSON.parse(bytes.toString('utf8')) as { subjectDigest: string; findings: unknown }
  if (result.subjectDigest !== review.subjectDigest)
    refuse('evidence-input-mismatch', 'judgment changed its frozen subject')
  const findings = readFindings(result.findings)
  const subject = JSON.parse((await sealedBytes(apparatus, review.subject)).toString('utf8')) as {
    checks?: readonly ProductionVerdict[]
  }
  for (const check of subject.checks ?? [])
    if (check.verdict !== 'pass' && findings.some((f) => f.criterionId === check.criterionId && f.verdict === 'pass'))
      refuse('unapproved-revision', 'a passing judgment cannot override a failed protected check')
  await createReviewCommands(apparatus.store).complete(
    `review-complete:${review.reviewId}`,
    review.reviewId,
    findings,
    await apparatus.attachments.saveFile({ name: path, data: bytes }),
    `agent:${review.agentId}`,
  )
  return witnessOf(apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, review.reviewId)!)
}
export async function reviewSubject(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent,
  operationId: string, subject: unknown, signal: AbortSignal, method?: RevisionRef, requirePass = true,
  criteria?: readonly AcceptanceCriterion[],
  target?: ReviewTarget,
): Promise<ReviewWitness> {
  const bytes = Buffer.from(JSON.stringify(subject, null, 2))
  const subjectDigest = sha256(bytes)
  const reviewId = `review-${sha256(`${apparatus.controlId}/${operationId}`).slice(0, 24)}`
  let review = apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)
  const commands = createReviewCommands(apparatus.store)
  if (review === undefined) {
    const data = subject as {
      taskId?: string
      runId?: string
      draft?: { revisionId: string; draftDigest: string; contentDigest: string }
      assets?: unknown
    }
    if (target === undefined) {
      if (data.taskId !== undefined && data.runId !== undefined) {
        const task = taskStateOf(apparatus, data.taskId)
        target = {
          kind: 'acceptance',
          taskId: data.taskId,
          runId: data.runId,
          contractDigest: task.contractDigest!,
          artifactDigest: task.runs[data.runId]!.submission!.artifactDigest,
        }
        criteria = task.contract!.criteria
      } else {
        const draft = data.draft!
        target = {
          kind: 'publication',
          environmentId: `${apparatus.controlId}:methods`,
          revisionId: draft.revisionId,
          draftDigest: draft.draftDigest,
          assetsDigest: draft.contentDigest,
        }
        criteria = [
          {
            criterionId: 'publication-approved',
            statement:
              'The exact frozen candidate is a reusable domain method supported by independent comparable results, actual asset use and complete costs under the protected requirements.',
          },
        ]
      }
    }
    const id = String(agentSessionIdOf(reviewId))
    const key = declareCaller(apparatus, id)
  await apparatus.agents.open({ commandId: `agent:${id}`, agentId: id, sessionId: id, role: 'review' })
  const route = parent.session.requestHeader()?.config ?? parent.options
  if (route.provider === undefined || route.model === undefined) refuse('malformed-declaration', 'reviewer requires an explicit model route')
    method ??= publishedMethod(apparatus) ?? (await seedMethod(apparatus))
    await commands.start(`review-start:${reviewId}`, reviewId, {
      target,
      criteria: criteria!,
      subject: await apparatus.attachments.saveFile({ name: 'subject.json', data: bytes }),
      subjectDigest,
      agentId: id,
      sessionId: id,
      identity: apparatus.store.identityOf(key)!,
      workspace: join(apparatus.workspaceRoot, 'reviews', reviewId),
      method, model: { provider: route.provider, model: route.model },
    })
    review = apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!
  }
  if (review.subjectDigest !== subjectDigest)
    refuse('command-conflict', 'review recovery changed the frozen assignment')
  declareCaller(apparatus, review.agentId)
  if (review.status === 'failed') refuse('unapproved-revision', 'review execution failed: ' + review.failure)
  if (review.status === 'running') {
    let session: Awaited<ReturnType<typeof openChildSession>> | undefined
    const stop = () => session?.stop()
    try {
    await mkdir(review.workspace, { recursive: true })
    await restoreFrozen(review.workspace, 'subject.json', await sealedBytes(apparatus, review.subject))
    const data = subject as {
      artifact?: import('@deepseek-ai/dsh-attachment').FileAttachmentRef
      inputs?: readonly { name: string; attachment: import('@deepseek-ai/dsh-attachment').FileAttachmentRef }[]
    }
    for (const [name, ref] of [
      ...(data.artifact === undefined ? [] : [['submitted-artifact', data.artifact] as const]),
      ...(data.inputs ?? []).map((input) => [join('inputs', input.name), input.attachment] as const),
    ]) {
      await restoreFrozen(review.workspace, name, await sealedBytes(apparatus, ref))
    }
    session = await openChildSession(seams, {
      agentId: reviewId,
      cwd: review.workspace,
      parent,
      preset: 'singularity-review',
      model: review.model, signal, message: schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
      parentTaskId: operationId,
          taskId: reviewId,
          runId: reviewId,
          factSeq: 0,
        },
        JSON.stringify({
          reviewId,
          purpose: review.target.kind,
          assignment: 'subject.json',
          criteria: review.criteria,
          subjectDigest,
          artifact: data.artifact === undefined ? undefined : 'submitted-artifact',
          inputs: (data.inputs ?? []).map(({ name }) => ({ name, path: join('inputs', name) })),
          evidenceInputs: reviewInputsOf(review, data).map(({ name, source }) => ({ name, source })),
          output: {
            path: 'review.json',
            template: {
              subjectDigest,
              findings: review.criteria.map((c) => ({
                criterionId: c.criterionId,
                verdict: 'unknown',
                detail: '<supported finding or exact missing evidence>',
                evidence: ['<actual subject field, native page or file reference>'],
              })),
            },
          },
        }),
      ),
    })
  signal.addEventListener('abort', stop, { once: true })
      while (
        apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!.status === 'running'
      ) {
        await session.wait()
        signal.throwIfAborted()
        const held = apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!
        const plan = projectPlan(
            held.reviewId,
            held.criteria,
            held.children,
            apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION),
          )
        if (held.status === 'running' && plan.children.every(childSettled) &&
          (plan.children.length === 0 || await outcomesAnswered(apparatus, session.sessionId,
            held.reviewId, [planOutcomeOf(apparatus, plan)!.seq])))
            refuse('illegal-transition', 'reviewer stopped without a judgment')
        if (held.status === 'running') await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } catch (error) {
      if (
        !signal.aborted &&
        !(error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') &&
        apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!.status === 'running'
      )
        await commands.fail(`review-failed:${reviewId}`, reviewId, String(error))
    throw error
  } finally { signal.removeEventListener('abort', stop)
      session?.stop()
      await session?.close()
    }
  }
  const witness = witnessOf(apparatus.store.load().stateOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION, reviewId)!)
  if (requirePass && witness.verdict !== 'pass') refuse('unapproved-revision', witness.detail)
  return witness
}

async function restoreFrozen(workspace: string, name: string, bytes: Buffer): Promise<void> {
  await assertRunFile(workspace, name)
  const path = join(workspace, name)
  await mkdir(join(path, '..'), { recursive: true })
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (sha256(await readFile(path)) !== sha256(bytes))
      refuse('digest-mismatch', 'frozen review evidence changed: ' + name)
  }
}
