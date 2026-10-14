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
import { commandOf, templateOf } from './domain.ts'
import type { Execution } from './execution.ts'
import { sha256 } from './ids.ts'
import { spawnProcess } from './process.ts'
import { sealFiles, withSealedWorkspace } from './sealed.ts'
import { domainForRun } from './method.ts'
import type { ReviewWitness } from './review.ts'
import type { ProductionVerdict } from '../../src/verifier/production.ts'
import { assertRunFile } from './workspace.ts'

export type AcceptanceReview = (taskId: string, run: RunState, judgement: ProductionVerdict) => Promise<ReviewWitness | undefined>

export interface Submission {
  readonly taskId: string
  readonly runId: string
  readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly detail: string
  readonly artifactDigest: string | null
  readonly phase: TaskView['phase']
  readonly dispatchError?: { readonly parentTaskId: string; readonly taskId: string; readonly runId: string | null; readonly detail: string }
}
export async function submit(apparatus: Apparatus, execution: Execution, caller: Caller, exec: ToolRunContext,
  request: { readonly taskId: string; readonly program: string }, signal: AbortSignal, review?: AcceptanceReview): Promise<Submission> {
  const state = taskStateOf(apparatus, request.taskId)
  const requestId = 'submit-' + sha256(JSON.stringify([apparatus.controlId, caller.sessionId, String(exec.callId)]))
  const requestDigest = sha256(JSON.stringify(request))
  const recorded = Object.values(state.runs).find(run => run.request?.id === requestId)
  if (recorded !== undefined) {
    if (recorded.request!.digest !== requestDigest) refuse('command-conflict', 'this submission was committed with different content')
    if (recorded.status !== 'running') return answerOf(state, recorded.runId)
    refuse('illegal-transition', 'this submission is in flight; do not execute it again')
  }
  if (state.responsibility?.agentId !== caller.agentId)
    refuse('not-responsible', 'the caller is not responsible for this task')
  const run = Object.values(state.runs).find(run => run.status === 'running')
  if (run === undefined) refuse('illegal-transition', 'the Task has no working Run; retry its failed Run before submitting')
  const domain = await domainForRun(apparatus, run)
  const template = templateOf(domain, state.contract!.template)
  const commands = apparatus.tasks.forAgent(caller.agentId)
  const reservation = await commands.beginSubmission({ commandId: requestId, taskId: request.taskId, runId: run.runId, requestId, requestDigest })
  if (!reservation.fresh) refuse('illegal-transition', 'this submission is in flight; do not execute it again')
  const workspace = workspaceOf(apparatus, request.taskId, run.runId)
  let executionFailure: string | undefined
  try {
    await execution.drain(exec)
    signal.throwIfAborted()
    for (const name of [template.file, template.artifact, ...run.bubble!.inputs.map(input => input.name)])
      await assertRunFile(workspace, name)
    const filePath = join(workspace, template.file)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, request.program, 'utf8')
    if (template.submission === 'program') {
      const output = await spawnProcess({ shell: false, argv: [process.execPath, filePath, join(workspace, template.input.name)] }, signal, workspace, { root: workspace, writable: true, protected: run.bubble!.inputs.map(input => join(workspace, input.name)), references: [domain.dir, ...domain.references] })
      await assertRunFile(workspace, template.artifact)
      await writeFile(join(workspace, template.artifact), output.stdout, 'utf8')
      executionFailure = output.failure ?? (output.exitCode === 0 ? undefined : `process-execution-failed: exited ${output.exitCode}`)
    }
    const inputDigests = await Promise.all(run.bubble!.inputs.map(async input => ({ name: input.name, digest: sha256(await readFile(join(workspace, input.name))) })))
    const programDigest = sha256(await readFile(filePath))
    if (programDigest !== sha256(request.program)) refuse('evidence-input-mismatch', 'the executed program changed its submitted source')
    await commands.submitRun({ commandId: 'seal:' + requestId, taskId: request.taskId, runId: run.runId,
      submission: { requestId, requestDigest, programDigest, artifactDigest: sha256(await readFile(join(workspace, template.artifact))), inputDigests,
        files: await sealFiles(apparatus, run, template, workspace),
        source: await execution.sealTranscript(exec), ...(executionFailure === undefined ? {} : { executionFailure }) } })
  } catch (error) {
    if (taskStateOf(apparatus, request.taskId).runs[run.runId]!.stage === 'submitting')
      await commands.failRun({ commandId: 'submission-failed:' + requestId, taskId: request.taskId, runId: run.runId, reason: String(error) })
    throw error
  }
  if (executionFailure !== undefined) {
    await commands.failRun({ commandId: 'execution-failed:' + requestId, taskId: request.taskId, runId: run.runId, reason: executionFailure })
    return answerOf(taskStateOf(apparatus, request.taskId), run.runId)
  }
  try {
    await judgeAndRecord(apparatus, request.taskId, taskStateOf(apparatus, request.taskId).runs[run.runId]!, signal, review)
    await apparatus.tasks.settle({ commandId: 'settle:' + request.taskId + '/' + run.runId, taskId: request.taskId, runId: run.runId }, 'agent:' + caller.agentId)
  } catch (error) {
    if (error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable') throw error
    if (taskStateOf(apparatus, request.taskId).runs[run.runId]!.status === 'running') {
      try { await commands.failRun({ commandId: 'verification-failed:' + requestId, taskId: request.taskId, runId: run.runId, reason: 'verification-failed: ' + String(error) }) }
      catch (failure) { throw new AggregateError([error, failure], 'verification and failure persistence failed') }
    }
    throw error
  }
  return answerOf(taskStateOf(apparatus, request.taskId), run.runId)
}

export async function judgeAndRecord(apparatus: Apparatus, taskId: string, run: RunState, signal?: AbortSignal, review?: AcceptanceReview): Promise<void> {
  const domain = await domainForRun(apparatus, run)
  const template = templateOf(domain, taskStateOf(apparatus, taskId).contract!.template)
  const declared: BubbleInput = run.bubble!.inputs[0]!
  const judged = await withSealedWorkspace(apparatus, run, template, workspace => runProductionVerdict({ runId: run.runId, criterion: template.criterion, implementations: domain.verifiers,
    inputs: [declared], workspace, artifactPath: template.artifact,
    command: commandOf(template.verifier, join(workspace, template.artifact), join(workspace, declared.name)),
    runJudge: async execution => {
      const implementationDigest = sha256(await readFile(template.verifier.program))
      const ran = await runVerifierCommand({ command: execution.command, artifactPath: execution.artifactPath, inputs: execution.inputs }, invocation => spawnProcess(invocation, signal, workspace, { root: workspace, writable: false, protected: [], references: [domain.dir, ...domain.references] }))
      return { verdict: ran.verdict, implementationDigest, detail: ran.detail }
    } }))
  const witness = judged.verdict === 'pass' ? await review?.(taskId, run, judged) : undefined
  await apparatus.tasks.recordVerdict({ commandId: 'verdict:' + taskId + '/' + run.runId, taskId,
    verdict: { runId: run.runId, criterionId: judged.criterionId, verdict: witness?.verdict ?? judged.verdict, implementationDigest: judged.implementationDigest,
      artifactDigest: judged.artifactDigest, inputDigests: judged.inputDigests,
      detail: witness === undefined ? judged.detail ?? '' : JSON.stringify({ execution: judged.detail, independentReview: witness }) } })
}

export function answerOf(state: TaskState, runId: string): Submission {
  const run = state.runs[runId]!
  const evidence = run.evidence.find(entry => entry.criterionId === state.contract!.criteria[0]!.criterionId)
  return { taskId: state.taskId, runId, verdict: evidence?.verdict ?? 'unknown', detail: run.failureReason ?? evidence?.detail ?? '',
    artifactDigest: evidence?.artifactDigest ?? run.submission?.artifactDigest ?? null, phase: run.status }
}
