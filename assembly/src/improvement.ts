import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { assertContiguous } from '@deepseek-ai/dsh-session-persistence'
import { digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { openChildSession, type ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { declareCaller, taskStateOf, type Apparatus } from './apparatus.ts'
import { startAttempt, workspaceOf } from './attempt.ts'
import { contractFor } from './inputs.ts'
import { historyOf } from './read.ts'
import { domainForRun, loadMethod, methodOfRun, publishedMethod } from './method.ts'
import { sha256 } from './ids.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { IMPROVEMENT_TEMPLATE, SUBJECT_INPUT } from './review.ts'
import { taskSessionsOf } from './evaluation-cost.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { nativeTokensOf } from './budget.ts'
const owners = new WeakMap<Apparatus, Map<string, Awaited<ReturnType<typeof openChildSession>>>>()
export function assertImprovementOwner(apparatus: Apparatus, agentId: string): void {
  const cut = apparatus.store.load()
  const tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  let task = [...tasks.values()].findLast(task => task.responsibility?.agentId === agentId)
  const active = task === undefined ? undefined : Object.values(task.runs).at(-1)
  if (active?.status !== 'running' || active.stage !== 'working') refuse('illegal-transition', 'evaluation requires a working improvement Task/Run')
  while (task !== undefined) {
    const run = Object.values(task.runs).at(-1)!
    const manifest = cut.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!.revisions[run.revision.revisionId]!.manifest as { purpose: string; relatedTo?: { taskId: string; runId: string } }
    if (manifest.purpose === 'improve') {
      const root = tasks.get(manifest.relatedTo!.taskId)!
      if (root.runs[manifest.relatedTo!.runId]!.status !== 'verified') refuse('illegal-transition', 'the protected root has not passed independent acceptance')
      return
    }
    task = [...tasks.values()].find(parent => parent.decomposition?.children.some(child => child.taskId === task!.taskId))
  }
  refuse('not-responsible', 'only the accepted root\'s improvement task tree may evaluate and automatically publish candidates')
}
export async function explorationOf(apparatus: Apparatus, taskId: string, runId: string): Promise<Buffer> {
  const history = await historyOf(apparatus, [], taskStateOf(apparatus, taskId).responsibility!.agentId)
  const sessions: { sessionId: string; eventCount: number; digest: string; events: readonly SessionEvent[] }[] = []
  for (const sessionId of taskSessionsOf(apparatus, taskId)) {
    const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
    try {
      const { events } = await handle.read()
      assertContiguous(handle.id, events, 0)
      for (const task of history.tasks) for (const run of task.runs) {
        const source = run.source
        if (source?.sessionId !== sessionId) continue
        if (events.length < source.eventCount || digestOf({ sessionId, eventCount: source.eventCount, events: events.slice(0, source.eventCount) }) !== source.digest)
          refuse('digest-mismatch', 'sealed exploration transcript changed')
      }
      const eventCount = events.length
      sessions.push({ sessionId, eventCount, digest: digestOf({ sessionId, eventCount, events }), events })
    } finally { await handle.close() }
  }
  const states = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const summary = {
    root: { taskId, runId },
    definitions: history.methods.map(({ reference, assets }) => ({ reference,
      templates: assets.templates.map(raw => {
        const template = raw as import('./read.ts').TemplateDeclaration
        return { id: template.id, goal: template.goal, applicability: template.applicability,
          decomposition: template.decomposition, input: template.input, criterion: template.criterion,
          skills: template.skills, capabilities: template.capabilities }
      }) })),
    tasks: history.tasks.map(task => ({ taskId: task.taskId, template: task.contract.template,
      goal: task.goal, sessionId: task.sessionId, decomposition: task.decomposition,
      runs: task.runs.map(run => {
        const state = states.get(task.taskId)!.runs[run.runId]!
        return { runId: run.runId, method: methodOfRun(apparatus, state), status: run.status,
          failureCause: run.failureCause, failureReason: run.failureReason, verdicts: run.verdicts,
          artifact: state.submission === undefined ? null : { digest: state.submission.artifactDigest, ref: state.submission.files.artifact },
          consumed: state.consumed, source: run.source }
      }) })),
    sessions: sessions.map(({ sessionId, eventCount, digest, events }, index) => ({
      sessionId, eventCount, digest, tokens: nativeTokensOf(events), events: `sessions[${index}].events` })),
  }
  return Buffer.from(JSON.stringify({ root: { taskId, runId }, summary, history, sessions }))
}
export async function startImprovement(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent,
  taskId: string, runId: string, signal: AbortSignal): Promise<void> {
  const id = `improve-${sha256(`${taskId}/${runId}`).slice(0, 24)}`
  let improving = owners.get(apparatus)
  if (improving === undefined) { improving = new Map(); owners.set(apparatus, improving) }
  if (improving.has(id)) return
  const existing = apparatus.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, id)
  const existingRun = existing === undefined ? undefined : Object.values(existing.runs).at(-1)
  if (existingRun !== undefined && existingRun.status !== 'running') return
  const frozen = existingRun === undefined ? undefined : await domainForRun(apparatus, existingRun)
  const trace = frozen === undefined ? Buffer.from(JSON.stringify({ ...JSON.parse((await explorationOf(apparatus, taskId, runId)).toString('utf8')),
    incumbent: publishedMethod(apparatus) }))
    : Buffer.from(frozen.inputs.find(input => input.ref === SUBJECT_INPUT)!.bytes)
  const rootRun = taskStateOf(apparatus, taskId).runs[runId]!
  const method = methodOfRun(apparatus, rootRun)!
  const loaded = (await loadMethod(apparatus, method)).domain
  const template = loaded.templates.get(IMPROVEMENT_TEMPLATE)!
  const input = { ref: SUBJECT_INPUT, digest: sha256(trace), bytes: trace, sourcePath: '' }
  const domain = { ...loaded, inputs: [...loaded.inputs.filter(held => held.ref !== SUBJECT_INPUT), input] }
  const agentId = String(agentSessionIdOf(id))
  declareCaller(apparatus, agentId)
  await apparatus.agents.open({ commandId: `agent:${agentId}`, agentId, sessionId: agentId, role: 'improve' })
  const commands = apparatus.tasks.forAgent(agentId)
  await commands.admit({ commandId: `admit:${id}`, taskId: id, contract: { ...contractFor(domain, template, template.goal), assets: method } })
  await commands.assign({ commandId: `assign:${id}`, taskId: id, agentId })
  const run = await startAttempt(apparatus, { agentId, sessionId: agentId, model: rootRun.bubble!.model }, id, id, method, { domain, purpose: 'improve', relatedTo: { taskId, runId } })
  const session = await openChildSession(seams, { agentId: id, cwd: workspaceOf(apparatus, id, run.runId), parent,
    model: run.bubble!.model, signal, message: schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
      parentTaskId: taskId, taskId: id, runId: run.runId, factSeq: 0 }, JSON.stringify({
      taskId: id, runId: run.runId, contract: taskStateOf(apparatus, id).contract, revision: method,
      summary: JSON.parse(trace.toString('utf8')).summary,
      evidenceReading: 'Start with this structural summary. Read relevant task artifacts and specific sessions[i].events segments from subject.json before proposing a mechanism; the frozen full trace is available on demand.',
      trace: 'subject.json', output: { subjectDigest: sha256(trace), verdict: 'pass | fail | partial | unknown', detail: 'Actual improvement evidence and result' },
    })) })
  improving.set(id, session)
}
export async function closeImprovements(apparatus: Apparatus): Promise<void> {
  const improving = owners.get(apparatus)
  if (improving === undefined) return
  for (const [id, session] of improving) { session.stop(); await session.close(); improving.delete(id) }
}
