import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import type { BubbleInput } from '../../src/task/bubble.ts'
import type { RunState, TaskState } from '../../src/task/protocol.ts'
import { type TaskView } from '../../src/task/view.ts'
import { runVerifierCommand } from '../../src/verifier/command.ts'
import { runProductionVerdict } from '../../src/verifier/production.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { workspaceOf } from './attempt.ts'
import { commandOf } from './domain.ts'
import type { Execution } from './execution.ts'
import { sha256 } from './ids.ts'
import { spawnProcess } from './process.ts'

export interface Submission {
  readonly taskId: string
  readonly runId: string
  readonly verdict: 'pass' | 'fail'
  readonly detail: string
  readonly artifactDigest: string | null
  readonly phase: TaskView['phase']
  readonly dispatchError?: string
}
export async function submit(apparatus: Apparatus, execution: Execution, caller: Caller, exec: ToolRunContext,
  request: { readonly taskId: string; readonly program: string }, signal: AbortSignal): Promise<Submission> {
  const state = taskStateOf(apparatus, request.taskId)
  const requestId = 'submit-' + sha256(JSON.stringify([apparatus.controlId, caller.sessionId, String(exec.callId)]))
  const requestDigest = sha256(JSON.stringify(request))
  const recorded = Object.values(state.runs).find(run => run.request?.id === requestId)
  if (recorded !== undefined) {
    if (recorded.request!.digest !== requestDigest) refuse('command-conflict', 'this submission was committed with different content')
    if (recorded.status !== 'running') return answerOf(apparatus, state, recorded.runId)
    refuse('illegal-transition', 'this submission is in flight; do not execute it again')
  }
  if (state.responsibility?.agentId !== caller.agentId)
    refuse('not-responsible', 'the caller is not responsible for this task')
  const run = Object.values(state.runs).find(run => run.status === 'running')
  if (run === undefined) refuse('illegal-transition', 'the task has no working Run; propose a new attempt before submitting')
  const commands = apparatus.tasks.forAgent(caller.agentId)
  const reservation = await commands.beginSubmission({ commandId: requestId, taskId: request.taskId, runId: run.runId, requestId, requestDigest })
  if (!reservation.fresh) refuse('illegal-transition', 'this submission is in flight; do not execute it again')
  const workspace = workspaceOf(apparatus, request.taskId, run.runId)
  let executionFailure: string | undefined
  try {
    await execution.drain(exec)
    signal.throwIfAborted()
    const filePath = join(workspace, apparatus.domain.file)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, request.program, 'utf8')
    if (apparatus.domain.submission === 'program') {
      const output = await spawnProcess({ shell: false, argv: [process.execPath, filePath, join(workspace, apparatus.domain.inputs[0]!.path)] }, signal)
      await writeFile(join(workspace, apparatus.domain.artifact), output.stdout, 'utf8')
      executionFailure = output.failure
    }
    const inputDigests = await Promise.all(apparatus.domain.inputs.map(async input => ({ name: input.path, digest: sha256(await readFile(join(workspace, input.path))) })))
    const programDigest = sha256(await readFile(filePath))
    if (programDigest !== sha256(request.program)) refuse('evidence-input-mismatch', 'the executed program changed its submitted source')
    await commands.submitRun({ commandId: 'seal:' + requestId, taskId: request.taskId, runId: run.runId,
      submission: { requestId, requestDigest, programDigest, artifactDigest: sha256(await readFile(join(workspace, apparatus.domain.artifact))), inputDigests,
        source: await execution.sealTranscript(exec), ...(executionFailure === undefined ? {} : { executionFailure }) } })
  } catch (error) {
    if (taskStateOf(apparatus, request.taskId).runs[run.runId]!.stage === 'submitting')
      await commands.failRun({ commandId: 'submission-failed:' + requestId, taskId: request.taskId, runId: run.runId, reason: String(error) })
    throw error
  }
  if (executionFailure !== undefined) {
    await commands.failRun({ commandId: 'execution-failed:' + requestId, taskId: request.taskId, runId: run.runId, reason: executionFailure })
    return answerOf(apparatus, taskStateOf(apparatus, request.taskId), run.runId)
  }
  try {
    await judgeAndRecord(apparatus, request.taskId, run, signal)
    await apparatus.tasks.settle({ commandId: 'settle:' + request.taskId + '/' + run.runId, taskId: request.taskId, runId: run.runId }, 'agent:' + caller.agentId)
  } catch (error) {
    if (error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') throw error
    if (taskStateOf(apparatus, request.taskId).runs[run.runId]!.status === 'running') {
      try { await commands.failRun({ commandId: 'verification-failed:' + requestId, taskId: request.taskId, runId: run.runId, reason: 'verification-failed: ' + String(error) }) }
      catch (failure) { throw new AggregateError([error, failure], 'verification and failure persistence failed') }
    }
    throw error
  }
  return answerOf(apparatus, taskStateOf(apparatus, request.taskId), run.runId)
}

export async function judgeAndRecord(apparatus: Apparatus, taskId: string, run: RunState, signal?: AbortSignal): Promise<void> {
  const { domain } = apparatus
  const workspace = workspaceOf(apparatus, taskId, run.runId)
  const declared: BubbleInput = run.bubble!.inputs[0]!
  const judged = await runProductionVerdict({ runId: run.runId, criterion: domain.criterion, implementations: domain.verifiers,
    inputs: [declared], workspace, artifactPath: domain.artifact,
    command: commandOf(domain.verifier, join(workspace, domain.artifact), join(workspace, declared.name)),
    runJudge: async execution => {
      const implementationDigest = sha256(await readFile(domain.verifier.program))
      const ran = await runVerifierCommand({ command: execution.command, artifactPath: execution.artifactPath, inputs: execution.inputs }, invocation => spawnProcess(invocation, signal))
      return { verdict: ran.verdict, implementationDigest, detail: ran.detail }
    } })
  await apparatus.tasks.recordVerdict({ commandId: 'verdict:' + taskId + '/' + run.runId, taskId,
    verdict: { runId: run.runId, criterionId: judged.criterionId, verdict: judged.verdict, implementationDigest: judged.implementationDigest,
      artifactDigest: judged.artifactDigest, inputDigests: judged.inputDigests, ...(judged.detail === undefined ? {} : { detail: judged.detail }) } })
}

export function answerOf(apparatus: Apparatus, state: TaskState, runId: string): Submission {
  const run = state.runs[runId]!
  const evidence = run.evidence.find(entry => entry.criterionId === apparatus.domain.criterion.criterionId)
  return { taskId: state.taskId, runId, verdict: run.status === 'verified' ? 'pass' : 'fail', detail: run.failureReason ?? evidence?.detail ?? '',
    artifactDigest: evidence?.artifactDigest ?? run.submission?.artifactDigest ?? null, phase: run.status }
}
