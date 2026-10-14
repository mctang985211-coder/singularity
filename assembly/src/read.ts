import { setTimeout } from 'node:timers/promises'
import type { ChildSession } from '../../src/runtime/child-session.ts'
import { projectTree } from '../../src/task/tree.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { Envelope } from '../../src/protocol/envelope.ts'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, type EnvironmentState } from '../../src/environment/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RevisionRef, type RunState, type RunSubmission, type TaskState } from '../../src/task/protocol.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { projectReceipt, projectTask, type ReceiptView, type RunView, type TaskView } from '../../src/task/view.ts'
import type { RoundDecision } from '../../src/strategy/view.ts'
import { taskStateOf, type Apparatus } from './apparatus.ts'
import { domainForRun, methodEnvironment, methodOfRun, type MethodAssets } from './method.ts'
import { SUBJECT_INPUT } from './review.ts'
import { sealedBytes } from './sealed.ts'
import type { TaskTemplate } from './template.ts'

export interface TemplateDeclaration {
  readonly id: string
  readonly goal: string
  readonly applicability?: string
  readonly decomposition?: TaskTemplate['decomposition']
  readonly skills: readonly string[]
  readonly capabilities: readonly string[]
  readonly input: TaskTemplate['input']
  readonly workspace: { readonly submission: 'program' | 'source'; readonly file: string; readonly artifact: string; readonly initialContent?: string }
  readonly criterion: { readonly criterionId: string; readonly statement: string; readonly verifier: string }
}
export function templateDeclaration(template: TaskTemplate): TemplateDeclaration {
  return { id: template.id, skills: template.skills, capabilities: template.capabilities, goal: template.goal, input: template.input,
    ...(template.applicability === undefined ? {} : { applicability: template.applicability }),
    ...(template.decomposition === undefined ? {} : { decomposition: template.decomposition }),
    workspace: { submission: template.submission, file: template.file, artifact: template.artifact, ...(template.initial === undefined ? {} : { initialContent: Buffer.from(template.initial.bytes).toString('utf8') }) },
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

export async function readScopeOf(apparatus: Apparatus, agentId?: string, committed = apparatus.store.load()) {
  const states = committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  let visible: Set<string> | undefined
  const revisions = new Set<string>()
  let audit = agentId === undefined
  if (agentId !== undefined) {
    const owner = [...states.values()].findLast(task => task.responsibility?.agentId === agentId)
    if (owner === undefined) refuse('not-responsible', 'history requires an assigned Task')
    visible = new Set()
    const collect = (id: string): void => {
      if (visible!.has(id)) return
      visible!.add(id)
      for (const child of states.get(id)!.decomposition?.children ?? []) collect(child.taskId)
    }
    collect(owner.taskId)
    const run = Object.values(owner.runs).at(-1)!
    const execution = committed.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, run.revision.environmentId)!.revisions[run.revision.revisionId]!
    const purpose = (execution.manifest as { purpose: string }).purpose
    audit = purpose === 'improve' || purpose === 'review'
    if (audit) {
      const domain = await domainForRun(apparatus, run)
      const input = domain.inputs.find(input => input.ref === SUBJECT_INPUT)!
      const subject = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as {
        taskId?: string; root?: { taskId: string }; revision?: RevisionRef; basis?: RevisionRef; incumbent?: RevisionRef;
        trace?: { records: readonly Envelope[] };
      }
      if (subject.taskId !== undefined) collect(subject.taskId)
      if (subject.root !== undefined) collect(subject.root.taskId)
      if (subject.revision !== undefined) revisions.add(subject.revision.digest)
      if (subject.basis !== undefined) revisions.add(subject.basis.digest)
      if (subject.incumbent !== undefined) revisions.add(subject.incumbent.digest)
      for (const fact of subject.trace?.records ?? []) if (fact.protocol === TASK_PROTOCOL && states.has(fact.subject)) collect(fact.subject)
    }
    for (const id of visible) for (const task of states.values()) for (const held of Object.values(task.runs)) {
      const execution = committed.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, held.revision.environmentId)!.revisions[held.revision.revisionId]!
      const context = execution.manifest as { purpose: string; relatedTo?: { taskId: string } }
      if (purpose === 'improve' && context.purpose === 'review') {
        const input = (await domainForRun(apparatus, held)).inputs.find(input => input.ref === SUBJECT_INPUT)!
        const subject = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as { purpose?: string }
        if (subject.purpose === 'publication') continue
      }
      if (context.relatedTo?.taskId === id && (context.purpose === 'review' || (purpose === 'improve' && context.purpose === 'evaluation'))) collect(task.taskId)
    }
    for (const id of visible) for (const held of Object.values(states.get(id)!.runs)) {
      const method = methodOfRun(apparatus, held)
      if (method !== undefined) revisions.add(method.digest)
      if (!audit) continue
      const domain = await domainForRun(apparatus, held)
      const input = domain.inputs.find(input => input.ref === SUBJECT_INPUT)
      if (input === undefined) continue
      const subject = JSON.parse(Buffer.from(input.bytes).toString('utf8')) as { revision?: RevisionRef }
      if (subject.revision !== undefined) revisions.add(subject.revision.digest)
    }
  }
  return { visible, revisions, audit }
}

export async function historyOf(apparatus: Apparatus, decisions: readonly RoundDecision[], agentId?: string): Promise<MethodHistory> {
  const committed = apparatus.store.load()
  const states = committed.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const { visible, revisions, audit } = await readScopeOf(apparatus, agentId, committed)
  const tasks = await Promise.all([...states.values()]
    .filter(task => task.contract !== undefined && (visible === undefined || visible.has(task.taskId))).map(task => readTask(apparatus, task)))
  const library = committed.stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, methodEnvironment(apparatus))
  const methods = library === undefined ? [] : Object.values(library.revisions).filter(revision => visible === undefined || revisions.has(revision.contentDigest)).map(revision => ({
    reference: { environmentId: library.environmentId, revisionId: revision.revisionId, digest: revision.contentDigest }, assets: revision.manifest as MethodAssets,
  }))
  return { tasks, methods, decisions: audit ? decisions : [] }
}

export async function waitForTask(apparatus: Apparatus, taskId: string, session: ChildSession, signal: AbortSignal): Promise<RunState> {
  while (true) {
    await session.wait()
    signal.throwIfAborted()
    const task = taskStateOf(apparatus, taskId)
    const run = Object.values(task.runs).at(-1)!
    if (run.status !== 'running') return run
    if (task.decomposition === undefined) refuse('illegal-transition', 'the native agent stopped without submitting its working Run')
    const tree = projectTree(apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)).find(tree => tree.parentTaskId === taskId)!
    if (tree.children.some(child => child.status === 'missing'))
      refuse('illegal-transition', 'delegated work has no admitted contract')
    await setTimeout(100, undefined, { signal })
  }
}
