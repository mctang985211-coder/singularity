import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { refuse } from '../../src/protocol/refusal.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { openChildSession, type ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { recordedVerdictDigest, TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import type { ProductionVerdict } from '../../src/verifier/production.ts'
import type { RunState } from '../../src/task/protocol.ts'
import { declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { startAttempt, workspaceOf } from './attempt.ts'
import type { Domain } from './domain.ts'
import { contractFor } from './inputs.ts'
import { runIdOf, sha256 } from './ids.ts'
import { spawnProcess } from './process.ts'
import { readTemplate } from './template.ts'
import { verifierOf } from './verifiers.ts'
import { sealedBytes } from './sealed.ts'
import { waitForTask } from './read.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { domainForRun, loadMethod, methodOfRun, publishedMethod, seedMethod } from './method.ts'

export const SUBJECT_INPUT = 'singularity-subject'
export const REVIEW_TEMPLATE = 'singularity-review'
export const IMPROVEMENT_TEMPLATE = 'singularity-improvement'

export function reviewScopeFor(subject: unknown) {
  const purpose = (subject as { purpose?: string }).purpose
  if (purpose === 'asset-admission') return {
    stage: 'asset-admission',
    goal: 'Decide whether the exact changed assets are safe and usable for exploration under the frozen protected input and acceptance. Review only introduced contract, binding, path and executable defects; record unverified claims without performing domain exploration.',
    stoppingRule: 'Inspect the frozen changes and supplied evidence. Use declared verifier samples for changed executables and at most one discriminating probe per concrete suspected introduced usability defect. Submit once each admission question has a finding. Missing measurement recipes remain unverified; never invent recipes, reproduce historical area baselines, sweep candidates or search for matching numbers.',
  }
  return { stage: purpose === 'publication' ? 'publication' : 'acceptance',
    goal: purpose === 'publication'
      ? 'Judge publication of the exact frozen draft using its recorded independent acceptance, asset consumption, evaluation and complete cost evidence.'
      : 'Judge the exact submitted result against its frozen contract, verifier verdict and evidence; cite concrete counterexamples or missing acceptance evidence.',
    stoppingRule: 'Resolve the exact assignment from its evidence and justified checks, then submit a decision. Do not solve or optimize a new domain candidate, repair the subject, or launch RSI.',
  }
}

export interface ReviewWitness {
  readonly taskId: string
  readonly runId: string
  readonly subjectDigest: string
  readonly artifactDigest: string
  readonly evidenceDigest: string
  readonly agentId: string
  readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly detail: string
}
export async function acceptanceSubject(apparatus: Apparatus, taskId: string, run: RunState, judgement: ProductionVerdict) {
  const subject = { taskId, runId: run.runId, contract: taskStateOf(apparatus, taskId).contract,
    artifact: (await sealedBytes(apparatus, run.submission!.files.artifact)).toString('utf8'),
    artifactDigest: run.submission!.artifactDigest, judgement,
    inputs: await Promise.all(run.submission!.files.inputs.map(async input => ({ name: input.name,
      content: (await sealedBytes(apparatus, input.attachment)).toString('utf8') }))) }
  const operationId = `accept:${taskId}/${run.runId}`
  const reviews = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .flatMap(task => task.responsibility === undefined ? [] : Object.values(task.runs).filter(held =>
      held.runId === runIdOf(apparatus.controlId, task.responsibility!.agentId, operationId) && held.failureCause !== 'runtime'))
  if (reviews.length > 1) refuse('command-conflict', 'acceptance has multiple independent review Runs')
  if (reviews.length === 0) return subject
  const input = (await domainForRun(apparatus, reviews[0]!)).inputs.find(input => input.ref === SUBJECT_INPUT)!
  const frozen = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as typeof subject
  const identity = ({ judgement: { detail: _detail, ...verdict }, ...held }: typeof subject) => ({ ...held, judgement: verdict })
  if (digestOf(identity(frozen)) !== digestOf(identity(subject)))
    refuse('command-conflict', 'acceptance recovery changed its frozen subject or structured execution verdict')
  return frozen
}
export async function addReviewVerifier(domain: Domain, workspaceRoot: string): Promise<Domain> {
  const root = join(workspaceRoot, 'infrastructure', 'review')
  await mkdir(root, { recursive: true })
  const source = join(dirname(createRequire(import.meta.url).resolve('@dangosys/dsh-singularity-next/package.json')), 'review.mjs')
  await writeFile(join(root, 'review.mjs'), await readFile(source))
  const subject = Buffer.from(JSON.stringify({ purpose: 'review fixture' }))
  await writeFile(join(root, 'subject.json'), subject)
  for (const verdict of ['pass', 'fail']) await writeFile(join(root, `${verdict}.json`), JSON.stringify({ subjectDigest: sha256(subject), verdict, detail: `fixture ${verdict}` }))
  const verifier = await verifierOf(root, { ref: 'independent-review', version: '1', program: 'review.mjs', args: ['{artifact}', '{input}'],
    selftest: ['pass', 'fail'].map(expected => ({ name: expected, artifact: `${expected}.json`, argv: [`${expected}.json`, 'subject.json'], expected })) }, 'independent-review', spawnProcess)
  const verifiers = [...domain.verifiers, verifier]
  const templates = new Map(domain.templates)
  for (const [id, goal, artifact, criterionId, statement] of [
    [REVIEW_TEMPLATE, 'Independently decide the exact frozen review assignment at its stated stage. Apply reviewScope and the immutable contract, distinguish blocking requirements from nonblocking findings, and submit the decision once justified checks resolve the assignment. Do not execute the domain responsibilities described in the reviewed assets.', 'review.json', 'review-approved', 'Independent approval bound to the exact subject'],
    [IMPROVEMENT_TEMPLATE, 'Use actual failed and successful exploration evidence to improve reusable domain TaskTemplate, Skill and Tool mechanisms. Explain each change, evidence, trigger, predicted effects on the protected task, preserved successes and transfer limits. Learn methods rather than store task answers or winner RTL. Compare independent baseline and candidate solves under the unchanged root requirements and distinguish actual asset use from availability. Report measured improvement, no winner or budget exhaustion truthfully.', 'report.json', 'improvement-reported', 'Report the actual improvement result against the exact trace'],
  ] as const) templates.set(id, await readTemplate(domain.dir, { id, goal,
    input: { name: 'subject.json', source: { kind: 'protected', ref: SUBJECT_INPUT } },
    workspace: { submission: 'source', file: artifact, artifact }, criterion: { criterionId, statement, verifier: verifier.ref } }, verifiers, 'infrastructure template'))
  return { ...domain, templates, inputs: [...domain.inputs, { ref: SUBJECT_INPUT, digest: sha256(subject), bytes: subject, sourcePath: '' }],
    references: [...domain.references, root], verifiers }
}
export async function reviewSubject(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent,
  operationId: string, subject: unknown, signal: AbortSignal, method?: RevisionRef, requirePass = true): Promise<ReviewWitness> {
  const bytes = Buffer.from(JSON.stringify(subject))
  const subjectDigest = sha256(bytes)
  const id = `review-${sha256(`${apparatus.controlId}/${operationId}/${subjectDigest}`).slice(0, 24)}`
  const agentId = String(agentSessionIdOf(id))
  const existing = apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, id)
  const previous = existing === undefined ? undefined : Object.values(existing.runs).at(-1)
  method = previous === undefined ? method ?? publishedMethod(apparatus) ?? await seedMethod(apparatus)
    : methodOfRun(apparatus, previous)!
  const loaded = (await loadMethod(apparatus, method)).domain
  const template = loaded.templates.get(REVIEW_TEMPLATE)!
  const reviewScope = reviewScopeFor(subject)
  const input = { ref: SUBJECT_INPUT, digest: subjectDigest, bytes, sourcePath: '' }
  const domain = { ...loaded, inputs: [...loaded.inputs.filter(held => held.ref !== SUBJECT_INPUT), input] }
  declareCaller(apparatus, agentId)
  await apparatus.agents.open({ commandId: `agent:${agentId}`, agentId, sessionId: agentId, role: 'review' })
  const commands = apparatus.tasks.forAgent(agentId)
  await commands.admit({ commandId: `admit:${id}`, taskId: id, contract: { ...contractFor(domain, template,
    existing === undefined ? reviewScope.goal : existing.contract!.goal), assets: method } })
  await commands.assign({ commandId: `assign:${id}`, taskId: id, agentId })
  const route = parent.session.requestHeader()?.config ?? parent.options
  if (route.provider === undefined || route.model === undefined) refuse('malformed-declaration', 'reviewer has no model route')
  const owner = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .findLast(task => task.responsibility?.agentId === String(parent.id))
  const ownerRun = owner === undefined ? undefined : Object.values(owner.runs).at(-1)
  await startAttempt(apparatus, { agentId, sessionId: agentId, model: { provider: route.provider, model: route.model } }, id, operationId, method, { domain, purpose: 'review',
    ...(ownerRun === undefined ? {} : { relatedTo: { taskId: owner!.taskId, runId: ownerRun.runId } }) })
  let run = Object.values(taskStateOf(apparatus, id).runs).at(-1)!
  const witness = async (): Promise<ReviewWitness> => {
    const state = taskStateOf(apparatus, id)
    const settled = state.runs[run.runId]!
    const evidence = settled.evidence.find(held => held.criterionId === template.criterion.criterionId && held.artifactDigest === settled.submission?.artifactDigest)
    if (settled.status === 'running' || settled.submission === undefined || evidence === undefined || settled.failureCause === 'runtime')
      refuse('unapproved-revision', `independent review ${id} produced no decision: ${settled.failureReason ?? settled.status}`)
    const content = (await sealedBytes(apparatus, settled.submission.files.artifact)).toString('utf8')
    let decision: { subjectDigest: string; verdict: ReviewWitness['verdict']; detail: string }
    try { decision = JSON.parse(content) as typeof decision }
    catch (error) { refuse('unapproved-revision', `independent review ${id} has a malformed decision: ${String(error)}`) }
    if (decision.subjectDigest !== subjectDigest || evidence.verdict !== decision.verdict || (requirePass && settled.status !== 'verified'))
      refuse('unapproved-revision', 'review does not approve this exact subject: ' + decision.detail)
    return { taskId: id, runId: run.runId, subjectDigest, agentId, verdict: decision.verdict, detail: decision.detail,
      artifactDigest: settled.submission!.artifactDigest,
      evidenceDigest: recordedVerdictDigest(state, 'independent review', { runId: run.runId, criterionId: template.criterion.criterionId, artifactDigest: settled.submission!.artifactDigest }) }
  }
  if (run.status !== 'running') return witness()
  const session = await openChildSession(seams, { agentId: id, cwd: workspaceOf(apparatus, id, run.runId), parent, preset: 'singularity-review',
    model: run.bubble!.model, signal, message: schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
      parentTaskId: String(parent.id), taskId: id, runId: run.runId, factSeq: 0 }, JSON.stringify({
      taskId: id, runId: run.runId, contract: taskStateOf(apparatus, id).contract,
      assignmentPurpose: 'review',
      reviewScope,
      subjectDigest, subject: 'subject.json', output: { file: template.artifact,
        envelope: { subjectDigest, verdict: 'pass | fail | partial | unknown', detail: 'Findings and evidence for the exact assignment' },
        deliverables: 'Include all additional artifact fields requested by the frozen assignment in subject.json.',
        submission: 'Call singularity_submit_program with this taskId and the complete JSON source text. File writes, present and chat messages do not submit or settle the Run.' },
    })) })
  const stop = () => session.stop()
  signal.addEventListener('abort', stop, { once: true })
  try {
    run = await waitForTask(apparatus, id, session, signal)
    return await witness()
  } catch (error) {
    if (taskStateOf(apparatus, id).runs[run.runId]!.status === 'running')
      await commands.failRun({ commandId: `review-failed:${id}/${run.runId}`, taskId: id, runId: run.runId, reason: String(error) })
    throw error
  } finally { signal.removeEventListener('abort', stop); session.stop(); await session.close() }
}
