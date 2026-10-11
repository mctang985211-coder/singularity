import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import { openChildSession } from '../../src/runtime/child-session.ts'
import { closeAgentSession } from '../../src/runtime/agent-session.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { refuse } from '../../src/protocol/refusal.ts'
import { recordedVerdictDigest, type RevisionRef } from '../../src/task/protocol.ts'
import { callerOf, taskStateOf, type Apparatus } from './apparatus.ts'
import type { SolveResult } from './evolution.ts'
import { propose } from './surfaces.ts'
import { sha256 } from './ids.ts'
import { loadMethod } from './method.ts'

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
  return messages.reduce((total, event) => {
    const { usage } = event.data
    if (usage === undefined) refuse('illegal-transition', 'native token usage is missing; cost cannot be fabricated')
    if (usage.totalTokens === undefined) refuse('illegal-transition', 'native usage.totalTokens is missing; exact token cost is unknown')
    return total + usage.totalTokens
  }, 0)
}

export function createNativeSolve(apparatus: Apparatus, seams: ChildSessionSeams, parent: Agent, signal: AbortSignal) {
  return async ({ revision, operationId }: { revision: RevisionRef; operationId: string }): Promise<SolveResult> => {
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
        operationId, { goal: `Method evaluation ${operationId}`, method: revision })
      taskId = trial.taskId
      runId = trial.runId
      child.post(createUserMessage({ source: { kind: 'singularity-method-solve', controlId: apparatus.controlId, operationId, taskId, runId },
        content: [{ type: 'text', text: [
        `Solve the existing Task ${taskId}, Run ${runId}, in ${trial.workspace}.`,
        'Goal: ' + taskStateOf(apparatus, taskId).contract!.goal,
        'Use singularity_run_method once with this taskId, then submit its returned program unchanged through singularity_submit_program.',
        'This is a controlled Method evaluation. The independent verifier must judge the exact method even if it fails.',
        'Do not repair or replace the method, propose another task, decompose, or call evolve/release. Finish after submission.',
      ].join('\n') }] }))
      await child.wait()
      signal.throwIfAborted()
      const task = taskStateOf(apparatus, taskId)
      const run = task.runs[runId]!
      if (run.status === 'running') refuse('illegal-transition', 'the native solve stopped without submitting its working Run')
      if (run.failureCause === 'runtime') refuse('illegal-transition', `the native solve failed at runtime: ${run.failureReason}`)
      const method = await loadMethod(apparatus, revision)
      if (run.submission!.programDigest !== sha256(method.assets.tool))
        refuse('evidence-input-mismatch', 'the native solve submission differs from its pinned Method tool')
      if (!(['template', 'skill', 'tool'] as const).every(asset => run.consumed.some(entry => entry.method === asset)))
        refuse('illegal-transition', 'the native solve did not consume its pinned template, skill and tool')
      const handle = await apparatus.persistence.open(child.agent.session.id, 'read')
      let events: readonly SessionEvent[]
      try { events = (await handle.read()).events } finally { await handle.close() }
      const criterionId = task.contract!.criteria[0]!.criterionId
      const artifactDigest = run.submission!.artifactDigest
      const evidenceDigest = recordedVerdictDigest(task, 'native method solve', { runId, criterionId, artifactDigest })
      const evidence = run.evidence.find(entry => entry.criterionId === criterionId && entry.artifactDigest === artifactDigest)!
      return { taskId, runId, quality: run.status === 'verified' ? 1 : 0, cost: tokensOf(events),
        artifactDigest, inputDigests: run.submission!.inputDigests,
        implementationDigest: evidence.implementationDigest,
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
