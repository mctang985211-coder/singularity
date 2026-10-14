import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { openChildSession } from '../../src/runtime/child-session.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { schedulerMessage } from './scheduler-message.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { recordedVerdictDigest, TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { callerOf, taskStateOf, type Apparatus } from './apparatus.ts'
import type { SolveResult } from './evolution.ts'
import { propose } from './surfaces.ts'
import { workspaceOf } from './attempt.ts'
import { sha256 } from './ids.ts'
import { waitForTask } from './read.ts'
import { sealedBytes } from './sealed.ts'
import { nativeTokensOf } from './budget.ts'
import { domainForRun } from './method.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { taskSessionsOf, evaluationCostSummaryOf, type EvaluationCostBasis, type ProposalCost } from './evaluation-cost.ts'

export function tokensOf(events: readonly SessionEvent[]): number {
  const messages = events.filter(event => event.type === 'assistant/message')
  if (messages.length === 0) refuse('illegal-transition', 'the solve has no native model messages to measure')
  return nativeTokensOf(events)
}

export interface SolveMeasurement {
  readonly digest: string
  measure(source: string, signal: AbortSignal): Promise<number>
}

export function createNativeSolve(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent, signal: AbortSignal,
  measurement?: SolveMeasurement, proposal?: ProposalCost) {
  return async ({ revision, operationId, started }: { revision: RevisionRef; operationId: string;
    started: (run: { taskId: string; runId: string }) => Promise<void> }): Promise<SolveResult> => {
    signal.throwIfAborted()
    const id = `trial-${sha256(`${apparatus.controlId}/${operationId}`).slice(0, 24)}`
    const caller = callerOf(parent)
    const sessionId = String(agentSessionIdOf(id))
    let child: Awaited<ReturnType<typeof openChildSession>> | undefined
    const cancel = () => child?.stop()
    signal.addEventListener('abort', cancel, { once: true })
    let taskId: string | undefined
    let runId: string | undefined
    try {
      const owner = [...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
        .findLast(task => task.responsibility?.agentId === String(parent.id))!
      const ownerRun = Object.values(owner.runs).at(-1)!
      const tasks = apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
      let root = owner
      while (true) {
        const run = Object.values(root.runs).at(-1)!
        const execution = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!.revisions[run.revision.revisionId]!
        const relatedTo = (execution.manifest as { relatedTo?: { taskId: string } }).relatedTo
        const ancestor = relatedTo === undefined ? [...tasks.values()].find(task => task.decomposition?.children.some(child => child.taskId === root.taskId)) : tasks.get(relatedTo.taskId)
        if (ancestor === undefined) break
        root = ancestor
      }
      const trial = await propose(apparatus, { agentId: sessionId, sessionId, model: caller.model },
        operationId, { goal: root.contract!.goal, method: revision },
        { purpose: 'evaluation', relatedTo: { taskId: owner.taskId, runId: ownerRun.runId } })
      taskId = trial.taskId
      runId = trial.runId
      await started({ taskId, runId })
      let run = Object.values(taskStateOf(apparatus, taskId).runs).at(-1)!
      runId = run.runId
      const workspace = workspaceOf(apparatus, taskId, runId)
      const message = schedulerMessage({ kind: 'singularity', purpose: 'dispatch', controlId: apparatus.controlId,
        parentTaskId: String(parent.id), taskId, runId, factSeq: 0 }, [
        `Solve the existing Task ${taskId}, Run ${runId}, in ${workspace}.`,
        'Goal: ' + taskStateOf(apparatus, taskId).contract!.goal,
        `Submission kind: ${trial.submission}. Input contents:\n${trial.inputContent}`,
        ...(trial.initialSource === null ? [] : [`Initial source:\n${trial.initialSource}`]),
        `Supported TaskTemplates:\n${JSON.stringify(trial.templates)}`,
        'After brief reconnaissance, establish independently checkable candidate-family or validation responsibilities as Tasks before their extended search or repeated experiment batches. Use the pinned recipe or a suitable custom batch. Children perform portions of the remaining work; reuse their sealed results to assemble your final artifact. Parent independent acceptance does not require repeating child exploration. Keep all work within the declared experiment limits.',
        'This evaluation Run pins the indicated Revision and protected acceptance requirements.',
        'Complete this assigned domain solve. Its owning improvement Task handles the RSI part of the human request.',
      ].join('\n'))
      if (run.status === 'running') {
        child = await openChildSession(seams, { agentId: id, cwd: workspace, parent, model: caller.model, message, signal })
        signal.throwIfAborted()
        run = await waitForTask(apparatus, taskId, child, signal)
        runId = run.runId
      }
      const task = taskStateOf(apparatus, taskId)
      if (run.status === 'running') refuse('illegal-transition', 'the native solve stopped without submitting its working Run')
      if (run.failureCause === 'runtime') refuse('illegal-transition', `the native solve failed at runtime: ${run.failureReason}`)
      const sessions = taskSessionsOf(apparatus, taskId)
      let cost = 0
      const sessionCosts: EvaluationCostBasis['sessions'][number][] = []
      for (const sessionId of sessions) {
        const handle = await apparatus.persistence.open(sessionId as Agent['session']['id'], 'read')
        try {
          const { events } = await handle.read()
          const tokens = tokensOf(events)
          cost += tokens
          sessionCosts.push({ sessionId, end: events.length, tokens })
        } finally { await handle.close() }
      }
      if (proposal?.candidates.includes(revision.digest)) for (const task of apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()) for (const run of Object.values(task.runs)) {
        const execution = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!.revisions[run.revision.revisionId]!
        if ((execution.manifest as { purpose: string }).purpose !== 'review') continue
        const domain = await domainForRun(apparatus, run)
        const frozen = domain.inputs.find(held => held.ref === 'singularity-subject')!
        const subject = JSON.parse(Buffer.from(frozen.bytes).toString('utf8')) as { revision?: RevisionRef }
        if (subject.revision?.digest !== revision.digest) continue
        for (const sessionId of taskSessionsOf(apparatus, task.taskId)) {
          if (sessions.has(sessionId)) continue
          sessions.add(sessionId)
          const handle = await apparatus.persistence.open(sessionId as Agent['session']['id'], 'read')
          try {
            const { events } = await handle.read()
            const tokens = tokensOf(events)
            cost += tokens
            sessionCosts.push({ sessionId, end: events.length, tokens })
          } finally { await handle.close() }
        }
      }
      let share = 0
      if (proposal !== undefined) {
        const slot = proposal.candidates.indexOf(revision.digest)
        if (slot >= 0) share = Math.floor(proposal.tokens / proposal.candidates.length) + (slot < proposal.tokens % proposal.candidates.length ? 1 : 0)
      }
      cost += share
      const costBasis = proposal === undefined ? undefined : { proposal: { ...proposal, share }, sessions: sessionCosts }
      const criterionId = task.contract!.criteria[0]!.criterionId
      const artifactDigest = run.submission!.artifactDigest
      const evidenceDigest = recordedVerdictDigest(task, 'native method solve', { runId, criterionId, artifactDigest })
      const evidence = run.evidence.find(entry => entry.criterionId === criterionId && entry.artifactDigest === artifactDigest)!
      const quality = measurement === undefined ? (run.status === 'verified' ? 1 : 0)
        : await measurement.measure((await sealedBytes(apparatus, run.submission!.files.artifact)).toString('utf8'), signal)
      const met = run.status === 'verified' && (measurement === undefined || quality <= 0.99)
      return { taskId, runId, quality, met, cost, ...(costBasis === undefined ? {} : { costBasis, costSummary: await evaluationCostSummaryOf(apparatus, costBasis) }),
        artifactDigest, inputDigests: run.submission!.inputDigests,
        implementationDigest: measurement?.digest ?? evidence.implementationDigest, acceptanceDigest: evidence.implementationDigest,
        verdict: { criterionId, evidenceDigest, artifactDigest } }
    } catch (error) {
      if (taskId !== undefined && runId !== undefined && taskStateOf(apparatus, taskId).runs[runId]!.status === 'running')
        await apparatus.tasks.forAgent(sessionId).failRun({ commandId: `${operationId}:runtime-failed`, taskId, runId, reason: String(error) })
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      if (child !== undefined) { child.stop(); await child.close() }
    }
  }
}
