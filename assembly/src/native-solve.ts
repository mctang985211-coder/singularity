import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { openChildSession } from '../../src/runtime/child-session.ts'
import { closeAgentSession } from '../../src/runtime/agent-session.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setTimeout } from 'node:timers/promises'
import { refuse } from '../../src/protocol/refusal.ts'
import { recordedVerdictDigest, TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type TaskState } from '../../src/task/protocol.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { projectTree } from '../../src/task/tree.ts'
import { callerOf, taskStateOf, type Apparatus } from './apparatus.ts'
import type { SolveResult } from './evolution.ts'
import { propose } from './surfaces.ts'
import { sha256 } from './ids.ts'
import { sealedBytes } from './sealed.ts'
import { nativeTokensOf } from './budget.ts'

interface MethodSolveSource {
  readonly kind: 'singularity-method-solve'
  readonly controlId: string
  readonly operationId: string
  readonly taskId: string
  readonly runId: string
}
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'singularity-method-solve': MethodSolveSource }
}

export function tokensOf(events: readonly SessionEvent[]): number {
  const messages = events.filter(event => event.type === 'assistant/message')
  if (messages.length === 0) refuse('illegal-transition', 'the solve has no native model messages to measure')
  return nativeTokensOf(events)
}

export interface SolveMeasurement {
  readonly digest: string
  measure(source: string, signal: AbortSignal): Promise<number>
}

export function createNativeSolve(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent, signal: AbortSignal, measurement?: SolveMeasurement) {
  return async ({ revision, operationId, started }: { revision: RevisionRef; operationId: string;
    started: (run: { taskId: string; runId: string }) => Promise<void> }): Promise<SolveResult> => {
    signal.throwIfAborted()
    const id = `trial-${sha256(`${apparatus.controlId}/${operationId}`).slice(0, 24)}`
    const caller = callerOf(parent)
    const child = await openChildSession(seams, { agentId: id, parent,
      cwd: apparatus.workspaceRoot, model: caller.model, compose: () => undefined })
    const cancel = () => child.stop()
    signal.addEventListener('abort', cancel, { once: true })
    let taskId: string | undefined
    let runId: string | undefined
    try {
      const trial = await propose(apparatus, { agentId: String(child.agent.id), sessionId: String(child.agent.session.id), model: caller.model },
        operationId, { goal: apparatus.domain.templates.get(apparatus.domain.rootTemplate)!.goal, method: revision })
      taskId = trial.taskId
      runId = trial.runId
      await started({ taskId, runId })
      child.post(createUserMessage({ source: { kind: 'singularity-method-solve', controlId: apparatus.controlId, operationId, taskId, runId },
        content: [{ type: 'text', text: [
        `Solve the existing Task ${taskId}, Run ${runId}, in ${trial.workspace}.`,
        'Goal: ' + taskStateOf(apparatus, taskId).contract!.goal,
        `Submission kind: ${trial.submission}. Input contents:\n${trial.inputContent}`,
        ...(trial.initialSource === null ? [] : [`Initial source:\n${trial.initialSource}`]),
        `Supported TaskTemplates:\n${JSON.stringify(trial.templates)}`,
        'Consume your pinned Skill and call singularity_run_method for its auxiliary tool. Use its output to reason, test or generate your own final source.',
        'You may decompose this existing Task using the declared templates. Wait for delegated work, read its sealed results, then submit your own final answer for independent acceptance.',
        'The Method assets are frozen for this experiment; the answer is produced by your solve. Do not propose another root, create/evolve/release Methods, or change acceptance.',
        'Finish after the existing parent Task has a settled final result.',
      ].join('\n') }] }))
      await child.wait()
      const deadline = Date.now() + 900_000
      while (taskStateOf(apparatus, taskId).runs[runId]!.status === 'running') {
        const task = taskStateOf(apparatus, taskId)
        if (task.decomposition === undefined) refuse('illegal-transition', 'the native solve stopped without submitting its working Run')
        const tree = projectTree(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)).find(tree => tree.parentTaskId === taskId)!
        if (tree.children.some(child => ['stopped', 'blocked', 'missing'].includes(child.status)))
          refuse('illegal-transition', 'the native solve could not complete its delegated work')
        if (Date.now() >= deadline) refuse('illegal-transition', 'the native solve exceeded its bounded completion deadline')
        await setTimeout(100, undefined, { signal })
        await child.wait()
      }
      await child.wait()
      signal.throwIfAborted()
      const task = taskStateOf(apparatus, taskId)
      const run = task.runs[runId]!
      if (run.status === 'running') refuse('illegal-transition', 'the native solve stopped without submitting its working Run')
      if (run.failureCause === 'runtime') refuse('illegal-transition', `the native solve failed at runtime: ${run.failureReason}`)
      if (!(['template', 'skill', 'tool'] as const).every(asset => run.consumed.some(entry => entry.method === asset)))
        refuse('illegal-transition', 'the native solve did not consume its pinned template, skill and tool')
      const cut = apparatus.store.load()
      const related = new Set([taskId, ...(task.decomposition?.children.map(child => child.taskId) ?? [])])
      const nodes = cut.statesOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION)
      const sessions = new Set([...cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()].filter(task => related.has(task.taskId))
        .map(task => nodes.get(task.responsibility!.agentId)!.sessionId))
      let cost = 0
      for (const sessionId of sessions) {
        const handle = await apparatus.persistence.open(sessionId as Agent['session']['id'], 'read')
        try { cost += tokensOf((await handle.read()).events) } finally { await handle.close() }
      }
      const criterionId = task.contract!.criteria[0]!.criterionId
      const artifactDigest = run.submission!.artifactDigest
      const evidenceDigest = recordedVerdictDigest(task, 'native method solve', { runId, criterionId, artifactDigest })
      const evidence = run.evidence.find(entry => entry.criterionId === criterionId && entry.artifactDigest === artifactDigest)!
      const quality = measurement === undefined ? (run.status === 'verified' ? 1 : 0)
        : await measurement.measure((await sealedBytes(apparatus, run.submission!.files.artifact)).toString('utf8'), signal)
      return { taskId, runId, quality, met: run.status === 'verified', cost,
        artifactDigest, inputDigests: run.submission!.inputDigests,
        implementationDigest: measurement?.digest ?? evidence.implementationDigest, acceptanceDigest: evidence.implementationDigest,
        verdict: { criterionId, evidenceDigest, artifactDigest } }
    } catch (error) {
      if (taskId !== undefined && runId !== undefined && taskStateOf(apparatus, taskId).runs[runId]!.status === 'running')
        await apparatus.tasks.forAgent(String(child.agent.id)).failRun({ commandId: `${operationId}:runtime-failed`, taskId, runId, reason: String(error) })
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      child.stop()
      await closeAgentSession(id)
    }
  }
}
