import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { ProtocolRefusal, refuse } from '../../src/protocol/refusal.ts'
import type { RunState, TaskState } from '../../src/task/protocol.ts'
import { REVIEW_DIGEST, REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import type { TaskView } from '../../src/task/view.ts'
import { runVerifierCommand } from '../../src/verifier/command.ts'
import { runProductionVerdict, type ProductionVerdict } from '../../src/verifier/production.ts'
import { taskStateOf, type Apparatus, type Caller } from './apparatus.ts'
import { commandOf, templateOf } from './domain.ts'
import type { Execution } from './execution.ts'
import { sha256 } from './ids.ts'
import { spawnProcess } from './process.ts'
import { sealFiles, withSealedWorkspace, sealedBytes } from './sealed.ts'
import type { ReviewWitness } from './review.ts'
import { assertRunFile } from './workspace.ts'
import { loadMethod } from './method.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'

export type AcceptanceReview = (taskId: string, run: RunState,
  checks: readonly ProductionVerdict[],
) => Promise<ReviewWitness>

export interface Submission {
  readonly taskId: string
  readonly runId: string
  readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly detail: string
  readonly artifactDigest: string | null
  readonly phase: TaskView['phase']
  readonly dispatchError?: { readonly parentTaskId: string
    readonly taskId: string
    readonly runId: string | null
    readonly detail: string }
}
export type SubmissionInput = { readonly taskId: string } & (
  { readonly path: string } | { readonly sourceTaskId: string; readonly sourceRunId: string }
)
export async function submit(apparatus: Apparatus, execution: Execution, caller: Caller, exec: ToolRunContext,
  request: SubmissionInput,
  signal: AbortSignal,
  review: AcceptanceReview,
  prepare?: () => Promise<void>,
): Promise<Submission> {
  const state = taskStateOf(apparatus, request.taskId)
  const path = 'path' in request ? request.path : state.contract!.artifact
  if (path !== state.contract!.artifact)
    refuse('malformed-declaration', 'submit the artifact declared in this Task contract')
  const requestId = 'submit-' + sha256(JSON.stringify([apparatus.controlId, caller.sessionId, String(exec.callId)]))
  const requestDigest = sha256(JSON.stringify(request))
  const recorded = Object.values(state.runs).find((run) => run.request?.id === requestId)
  if (recorded !== undefined) {
    if (recorded.request!.digest !== requestDigest) refuse('command-conflict', 'submission changed its request')
    if (recorded.status !== 'running') return answerOf(state, recorded.runId)
    refuse('illegal-transition', 'submission is in flight')
  }
  if (state.responsibility?.agentId !== caller.agentId)
    refuse('not-responsible', 'caller does not own this Task')
  const run = Object.values(state.runs).find((run) => run.status === 'running' && run.stage === 'working')
  if (run === undefined) refuse('illegal-transition', 'Task has no working Run')
  let source: RunState | undefined
  if ('sourceTaskId' in request) {
    const agent = apparatus.store.load().stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, caller.agentId)
    if (agent?.role !== 'root' || !state.decomposition?.children.some(child => child.taskId === request.sourceTaskId))
      refuse('not-responsible', 'root submission requires an artifact from its delegated direct child')
    source = taskStateOf(apparatus, request.sourceTaskId).runs[request.sourceRunId]
    if (source?.status !== 'verified') refuse('illegal-transition', 'root submission requires an exact verified child Run')
  }
  const commands = apparatus.tasks.forAgent(caller.agentId)
  let release: (() => void) | undefined
  try {
    const workspace = run.bubble!.workspace.ref
    release = await execution.drain(exec)
    signal.throwIfAborted()
    await assertRunFile(workspace, path)
    if (source !== undefined) {
      const target = join(workspace, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await sealedBytes(apparatus, source.submission!.files.artifact))
    }
    const inputDigests = await Promise.all(run.bubble!.inputs.map(async (input) => ({ name: input.name, digest: sha256(await readFile(join(workspace, input.name))),
      })),
    )
    if (
      inputDigests.some(
        (input) => input.digest !== run.bubble!.inputs.find((frozen) => frozen.name === input.name)!.digest,
      )
    )
      refuse('evidence-input-mismatch', 'workspace input differs from the frozen snapshot')
    const files = await sealFiles(apparatus, run, path, workspace)
    // Only a valid, frozen submission may trigger external validation. Rejected calls
    // leave the working Run available for correction and never end its search.
    await prepare?.()
    signal.throwIfAborted()
    const transcript = await execution.sealTranscript(exec)
    signal.throwIfAborted()
    await commands.submitRun({ commandId: 'seal:' + requestId, taskId: request.taskId, runId: run.runId,
      submission: { requestId, requestDigest,
        artifactDigest: files.artifact.attachmentId.slice('sha256:'.length), inputDigests,
        files,
        source: transcript,
      },
    })
    release()
    release = undefined
    await judgeAndRecord(apparatus, request.taskId, taskStateOf(apparatus, request.taskId).runs[run.runId]!, signal, review,
    )
    await apparatus.tasks.settle(
      { commandId: `settle:${request.taskId}/${run.runId}`, taskId: request.taskId, runId: run.runId }, 'agent:' + caller.agentId,
    )
  } catch (error) {
    const current = taskStateOf(apparatus, request.taskId).runs[run.runId]!
    if (
      !signal.aborted &&
      current.status === 'running' &&
      current.stage === 'submitted' &&
      !(error instanceof ProtocolRefusal && error.refusal.code === 'write-not-durable')
    )
      await commands.failRun({
        commandId: 'submit-failed:' + requestId, taskId: request.taskId, runId: run.runId, reason: String(error),
      })
    throw error
  } finally { release?.() }
  return answerOf(taskStateOf(apparatus, request.taskId), run.runId)
}

export async function judgeAndRecord(apparatus: Apparatus, taskId: string, run: RunState, signal: AbortSignal,
  review: AcceptanceReview,
): Promise<void> {
  const task = taskStateOf(apparatus, taskId)
  const contract = task.contract!
  const existing = [...apparatus.store.load().statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION).values()].find(
    (r) => r.target.kind === 'acceptance' && r.target.taskId === taskId && r.target.runId === run.runId,
  )
  const checks: ProductionVerdict[] =
    existing === undefined ? [] : JSON.parse((await sealedBytes(apparatus, existing.subject)).toString('utf8')).checks
  if (existing === undefined && contract.template !== undefined) {
    const { domain } = await loadMethod(apparatus, run.revision, contract.template)
    const template = templateOf(domain, contract.template)
    if (template.checks.length > 0) await withSealedWorkspace(apparatus, run, contract.artifact, async (workspace) => {
      for (const { criterion, verifier: checker, input: inputName } of template.checks) {
        const { name, digest } = run.bubble!.inputs.find(input => input.name === inputName)!
        const declared = { name, digest }
        checks.push(await runProductionVerdict({ runId: run.runId, criterion, implementations: domain.verifiers,
          inputs: [declared], workspace, artifactPath: contract.artifact,
          command: commandOf(checker, join(workspace, contract.artifact), join(workspace, declared.name)),
          runJudge: async (execution) => {
            const ran = await runVerifierCommand({ command: execution.command, artifactPath: execution.artifactPath, inputs: execution.inputs },
              (invocation) => spawnProcess(invocation, signal, workspace, { root: workspace, writable: false, protected: [], references: [domain.dir, ...domain.references, ...(domain.verifierReferences ?? []), checker.program] }))
            return { verdict: ran.verdict, implementationDigest: sha256(await readFile(checker.program)), detail: ran.detail }
          },
        }))
      }
    })
  }
  const witness = await review(taskId, run, checks)
  for (const finding of witness.findings) {
    if (taskStateOf(apparatus, taskId).runs[run.runId]!.evidence.some((e) => e.criterionId === finding.criterionId))
      continue
    await apparatus.tasks.recordVerdict({
      commandId: `verdict:${taskId}/${run.runId}/${finding.criterionId}`, taskId,
    verdict: { runId: run.runId, criterionId: finding.criterionId,
        reviewId: witness.reviewId,
        verdict: finding.verdict,
        verifierRef: 'independent-review',
        verifierVersion: '1',
        implementationDigest: REVIEW_DIGEST,
        artifactDigest: run.submission!.artifactDigest,
        inputDigests: run.bubble!.inputs.map(({ name, digest }) => ({ name, digest })),
        detail: JSON.stringify({ finding, checks, reviewId: witness.reviewId }),
      },
    })
  }
}

export function answerOf(state: TaskState, runId: string): Submission {
  const run = state.runs[runId]!
  const evidence = run.evidence
  const verdict =
    evidence.length === 0
      ? 'unknown'
      : evidence.every((e) => e.verdict === 'pass')
        ? 'pass'
        : evidence.some((e) => e.verdict === 'fail')
          ? 'fail'
          : evidence.some((e) => e.verdict === 'unknown')
            ? 'unknown'
            : 'partial'
  return {
    taskId: state.taskId,
    runId,
    verdict,
    detail: run.failureReason ?? evidence.map((e) => e.detail).join('\n'),
    artifactDigest: run.submission?.artifactDigest ?? null, phase: run.status,
  }
}
