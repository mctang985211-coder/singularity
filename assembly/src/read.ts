import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type RunSubmission, type TaskState } from '../../src/task/protocol.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { projectReceipt, projectTask, type ReceiptView, type RunView, type TaskView } from '../../src/task/view.ts'
import type { RoundDecision } from '../../src/strategy/view.ts'
import type { Apparatus } from './apparatus.ts'
import { methodEnvironment, type MethodAssets } from './method.ts'
import { sealedBytes } from './sealed.ts'
import type { TaskTemplate } from './template.ts'

export interface TemplateDeclaration {
  readonly id: string
  readonly goal: string
  readonly input: TaskTemplate['input']
  readonly workspace: { readonly submission: 'program' | 'source'; readonly file: string; readonly artifact: string }
  readonly criterion: { readonly criterionId: string; readonly statement: string; readonly verifier: string }
}
export function templateDeclaration(template: TaskTemplate): TemplateDeclaration {
  return { id: template.id, goal: template.goal, input: template.input,
    workspace: { submission: template.submission, file: template.file, artifact: template.artifact },
    criterion: { criterionId: template.criterion.criterionId, statement: template.criterion.statement, verifier: template.criterion.verifierRef } }
}

export interface ReadRun extends RunView {
  readonly receipt: ReceiptView | null
  readonly program: string | null
  readonly artifact: string | null
  readonly source: RunSubmission['source'] | null
}
export interface ReadTask extends Omit<TaskView, 'runs'> {
  readonly contract: TaskContract
  readonly agentId: string | null
  readonly sessionId: string | null
  readonly decomposition: TaskState['decomposition'] | null
  readonly runs: readonly ReadRun[]
}
export interface MethodHistory {
  readonly tasks: readonly ReadTask[]
  readonly methods: readonly { readonly reference: RevisionRef; readonly assets: MethodAssets }[]
  readonly decisions: readonly RoundDecision[]
}

export async function readTask(apparatus: Apparatus, state: TaskState): Promise<ReadTask> {
  const view = projectTask(state)
  const committed = apparatus.store.load()
  const owner = state.responsibility === undefined ? undefined : committed.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, state.responsibility.agentId)
  const runs = await Promise.all(view.runs.map(async run => {
    const submission = state.runs[run.runId]!.submission
    const [program, artifact] = submission === undefined ? [null, null] : await Promise.all([
      sealedBytes(apparatus, submission.files.program).then(bytes => bytes.toString('utf8')),
      sealedBytes(apparatus, submission.files.artifact).then(bytes => bytes.toString('utf8')),
    ])
    return { ...run, program, artifact, source: submission?.source ?? null,
      receipt: run.status === 'running' ? null : projectReceipt(apparatus.registry, committed.entries(), state.taskId, run.runId) }
  }))
  return { ...view, contract: state.contract!, agentId: state.responsibility?.agentId ?? null,
    sessionId: owner?.sessionId ?? null, decomposition: state.decomposition ?? null, runs }
}

export async function historyOf(apparatus: Apparatus, decisions: readonly RoundDecision[]): Promise<MethodHistory> {
  const committed = apparatus.store.load()
  const tasks = await Promise.all([...committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
    .filter(task => task.contract !== undefined).map(task => readTask(apparatus, task)))
  const library = committed.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus))
  const methods = library === undefined ? [] : Object.values(library.revisions).map(revision => ({
    reference: { environmentId: library.environmentId, revisionId: revision.revisionId, digest: revision.contentDigest }, assets: revision.manifest as MethodAssets,
  }))
  return { tasks, methods, decisions }
}
