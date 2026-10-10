/**
 * One attempt at a task: start it, run the program, judge the artifact, settle it, and repair an attempt
 * a crash left in flight; the criterion's own verifier runs through the process port that lives here.
 *
 * @module @dangosys/dsh-singularity-next/submission
 */

import { execFile, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { BubbleInput } from '../../src/task/bubble.ts'
import type { TaskState } from '../../src/task/protocol.ts'
import { projectTask, type TaskView } from '../../src/task/view.ts'
import { runVerifierCommand, type VerifierInvocation } from '../../src/verifier/command.ts'
import { runProductionVerdict } from '../../src/verifier/production.ts'
import { bindCaller, taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { commandOf } from './domain.ts'
import { runIdOf, sha256 } from './ids.ts'

/** What one submission produced, judged by the criterion's own implementation and recorded as facts. */
export interface Submission {
  readonly taskId: string
  readonly runId: string
  readonly verdict: 'pass' | 'fail'
  readonly detail: string
  /** The digest of the bytes judged, or null when no verdict was ever formed. */
  readonly artifactDigest: string | null
  readonly phase: TaskView['phase']
}
export function spawnProcess(invocation: VerifierInvocation): Promise<{ exitCode: number | null; stderr: string; failure?: string }> {
  return new Promise(resolve => {
    const child = invocation.shell
      ? spawn(invocation.command, { shell: true, stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn(invocation.argv[0], invocation.argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => resolve({ exitCode: null, stderr, failure: error.message }))
    child.on('close', code => resolve({ exitCode: code, stderr }))
  })
}
export function workspaceOf(apparatus: Apparatus, taskId: string): string {
  return join(apparatus.workspaceRoot, 'tasks', taskId)
}
export async function submit(apparatus: Apparatus, caller: Caller, callId: string, request: { readonly taskId: string; readonly program: string }): Promise<Submission> {
  const runId = runIdOf(apparatus.controlId, caller.sessionId, callId)
  const committed = taskStateOf(apparatus, request.taskId)
  // Only the holder may attempt the task, and this is checked before anything is written — including
  // before the caller is bound, so a refused caller leaves neither a node nor a revision behind.
  if (committed.responsibility?.agentId !== caller.agentId)
    refuse(
      'not-responsible',
      `task "${request.taskId}" is the responsibility of agent "${committed.responsibility?.agentId ?? 'nobody'}", so agent "${caller.agentId}" cannot submit to it`,
    )
  const key = await bindCaller(apparatus, caller)
  const recorded = committed.runs[runId]
  // A redelivery: this call's run is settled, so nothing below runs again.
  if (recorded !== undefined && recorded.status !== 'running') return answerOf(apparatus, committed, runId)
  // A redelivery whose run is still in flight is refused rather than re-run: the attempt is running,
  // and a second execution of one call could produce different bytes under the same command ids.
  if (recorded !== undefined)
    refuse(
      'illegal-transition',
      `run "${runId}" of task "${request.taskId}" is still running for this call; its attempt ends when it settles, and the next boot's repair settles an attempt this process left behind`,
    )

  const workspace = workspaceOf(apparatus, request.taskId)
  const inputPath = join(workspace, apparatus.domain.inputPath)
  const declared: BubbleInput = { name: apparatus.domain.inputPath, digest: await digestOf(inputPath, `the input of task "${request.taskId}"`) }
  // The revision is derived from the request, never from workspace bytes: a program may rewrite its own
  // input, and an id built from those bytes would make the retry a different command against siblings
  // the first delivery already committed.
  const basis = sha256(`${apparatus.domain.templateDigest}\u0000${request.taskId}`)
  const revisionId = `rev-${basis.slice(0, 16)}`
  await apparatus.environments.createRevision({
    commandId: `revision:${basis}`,
    environmentId: apparatus.controlId,
    revisionId,
    manifest: { taskTemplate: apparatus.domain.templateDigest, task: request.taskId },
  })

  const commands = apparatus.tasks.forAgent(caller.agentId)
  await commands.startRun({
    commandId: `start:${request.taskId}/${runId}`,
    taskId: request.taskId,
    runId,
    revision: { environmentId: apparatus.controlId, revisionId, digest: revisionDigestOf(apparatus, revisionId) },
  })
  await commands.openBubble({
    commandId: `bubble:${request.taskId}/${runId}`,
    taskId: request.taskId,
    runId,
    inputs: [declared],
    workspace: { kind: 'dir', ref: workspace },
    model: caller.model,
    tools: [{ name: 'node', version: process.version, implementationDigest: await toolchainDigest() }],
    conditions: [],
  })

  const programPath = join(workspace, apparatus.domain.program)
  await writeFile(programPath, request.program, 'utf8')
  await writeFile(join(workspace, apparatus.domain.artifact), await runProgram(programPath, inputPath), 'utf8')
  await judgeAndRecord(apparatus, request.taskId, runId, workspace, declared)
  await apparatus.tasks.settle({ commandId: `settle:${request.taskId}/${runId}`, taskId: request.taskId, runId }, key)
  return answerOf(apparatus, taskStateOf(apparatus, request.taskId), runId)
}
export async function judgeAndRecord(apparatus: Apparatus, taskId: string, runId: string, workspace: string, declared: BubbleInput): Promise<void> {
  const { domain } = apparatus
  const inputPath = join(workspace, domain.inputPath)
  const artifactPath = join(workspace, domain.artifact)
  const judged = await runProductionVerdict({
    runId,
    criterion: domain.criterion,
    implementations: domain.verifiers,
    inputs: [declared],
    workspace,
    artifactPath: domain.artifact,
    command: commandOf(domain.verifier, artifactPath, inputPath),
    // The digest of the bytes about to run, read here: a verifier rebuilt under this deployment must be
    // reported as a different implementation, never judged anyway.
    runJudge: async execution => {
      const implementationDigest = await digestOf(domain.verifier.program, 'the verifier implementation')
      const ran = await runVerifierCommand({ command: execution.command, artifactPath: execution.artifactPath, inputs: execution.inputs }, spawnProcess)
      return { verdict: ran.verdict, implementationDigest, detail: ran.detail }
    },
  })
  const verdict = { runId, criterionId: judged.criterionId, verdict: judged.verdict, implementationDigest: judged.implementationDigest, artifactDigest: judged.artifactDigest, inputDigests: judged.inputDigests, ...(judged.detail === undefined ? {} : { detail: judged.detail }) }
  await apparatus.tasks.recordVerdict({ commandId: `verdict:${taskId}/${runId}`, taskId, verdict })
}
export function answerOf(apparatus: Apparatus, state: TaskState, runId: string): Submission {
  const run = state.runs[runId]
  if (run === undefined) refuse('unknown-run', `task "${state.taskId}" holds no run "${runId}", so it has no result to return`)
  const evidence = run.evidence.find(entry => entry.criterionId === apparatus.domain.criterion.criterionId)
  return {
    taskId: state.taskId,
    runId,
    verdict: evidence?.verdict ?? 'fail',
    detail: evidence?.detail ?? run.failureReason ?? '',
    artifactDigest: evidence?.artifactDigest ?? null,
    phase: projectTask(state).phase,
  }
}
export function revisionDigestOf(apparatus: Apparatus, revisionId: string): string {
  const digest = apparatus.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, apparatus.controlId)?.revisions[revisionId]?.contentDigest
  if (digest === undefined)
    refuse('unknown-revision', `the revision "${revisionId}" this call created is not in the committed cut; a pin names the digest the environment holds, never one this layer computed for it`)
  return digest
}
/**
 * The toolchain digest, read once per process: the bytes this interpreter is running, never one read
 * again later that could name a binary replaced underneath it.
 */
let toolchain: Promise<string> | undefined
const toolchainDigest = (): Promise<string> => (toolchain ??= digestOf(process.execPath, 'the node toolchain'))

export const digestOnDisk = (path: string): Promise<string | undefined> => readFile(path).then(bytes => sha256(bytes), () => undefined)

/** Run the submitted program for real, with the input path as its only argument. */
function runProgram(programPath: string, inputPath: string): Promise<string> {
  return new Promise(resolve => {
    execFile(process.execPath, [programPath, inputPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (_error, stdout) => resolve(stdout))
  })
}
async function digestOf(path: string, what: string): Promise<string> {
  try {
    return sha256(await readFile(path))
  } catch (error) {
    refuse('evidence-input-mismatch', `${what} (${path}) could not be read (${error instanceof Error ? error.message : String(error)}); a run cannot be bound to bytes that are not there`)
  }
}
