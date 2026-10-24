import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { type ReviewRun, type Finding } from '../../src/review/protocol.ts'
import type { ChildSessionSeams } from '../../src/runtime/child-session.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import { type RevisionRef } from '../../src/task/protocol.ts'
import type { TaskView } from '../../src/task/view.ts'
import { type Apparatus } from './apparatus.ts'
import type { BubbleWorld } from './bubble.ts'
import { type AnswerChild, type AskParent } from './coordination.ts'
import type { Domain } from './domain.ts'
import type { Admission, Execution, TurnFailureHandler } from './execution.ts'
import { type MemoryReadInput } from './memory-view.ts'
import { type MemoryContext } from './memory.ts'
import { type ReadInput } from './read.ts'
import { type ReviewWitness } from './review.ts'
import { type RsiMemoryInput } from './rsi-memory.ts'
import { rsiState } from './rsi-state.ts'
import { type ControlSnapshot } from './snapshot.ts'
import { type Submission, type SubmissionInput } from './submission.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    singularity: TaskService
  }
}
export interface TaskService {
  cancel(input: {
    readonly sessionId: string
    readonly taskId?: string
  }): Promise<{ readonly status: 'cancelled'; readonly taskId: string }>
  inheritRsi(input: RsiMemoryInput): Promise<void>
  forCall(exec: ToolRunContext): AgentTaskSurface
  read(): Promise<ControlSnapshot>
  mountSkills(agent: Agent): Promise<void>
  world(agentId: string): BubbleWorld
  memoryContext(agentId: string): Promise<MemoryContext>
}
export interface AgentTaskSurface {
  memory(input?: MemoryReadInput): Promise<unknown>
  stopExplorations(input: {
    readonly taskIds: readonly string[]
    readonly reason: string
    readonly requestKey: string
  }): Promise<unknown>
  askParent(input: AskParent): Promise<unknown>
  answer(input: AnswerChild): Promise<unknown>
  retry(input: { readonly taskId: string }): Promise<Proposal>
  runMethod(input: {
    readonly taskId: string
    readonly tool: string
    readonly candidatePath?: string
  }): Promise<{ artifact: string }>
  proposeMethod(input: { readonly paths: readonly string[] }): Promise<unknown>
  history(input?: ReadInput): Promise<unknown>
  decompose(input: DecomposeInput): Promise<PlanRecord>
  submit(input: SubmissionInput | { readonly findings: readonly Finding[] }): Promise<Submission | ReviewWitness>
  current(): string
}
export interface PlannedChild {
  readonly key: string
  readonly contract: TaskContract
  readonly dependsOn: readonly string[]
  readonly supports: readonly string[]
  readonly maxRuns: number
  readonly requirement: 'required' | 'exploration'
  readonly handoff?: import('../../src/task/decomposition.ts').DecompositionChild['handoff']
}
export interface DecomposeInput {
  readonly taskId: string
  readonly children: readonly PlannedChild[]
}
export interface PlanRecord {
  readonly taskId: string
  readonly opened: readonly string[]
  readonly next: string
}
export interface Proposal {
  readonly taskId: string
  readonly runId: string
  readonly workspace: string
  readonly contract: TaskContract
  readonly phase: TaskView['phase']
  readonly method: RevisionRef
}
export interface DriverOptions {
  readonly initialMethod?: unknown
  readonly attachments: Apparatus['attachments']
  readonly projections: Apparatus['projections']
  readonly controlId: string
  readonly workspaceRoot: string
  readonly evaluationParallelism?: number
  readonly domain: Domain
  readonly persistence: SessionPersistence
  readonly seams: ChildSessionSeams
  readonly execution: (admission: Admission, onTurnFailure: TurnFailureHandler) => Execution
}
export interface TaskDriver extends TaskService {
  stepBudget(
    agentId: string,
    session?: import('@deepseek-ai/dsh-session').Session,
  ): Promise<
    | { readonly rootId: string; readonly steps: number; readonly maxSteps: number; readonly remainingSteps: number }
    | undefined
  >
  rsiState(agentId: string): ReturnType<typeof rsiState>
  prepareMemory(agent: Agent): Promise<void>
  failed(agentId: string): boolean
  reviewTarget(agentId: string): ReviewRun['target'] | undefined
  responsibility(
    agentId: string,
  ): { readonly waiting: string | null; readonly canPlan: boolean; readonly closed: boolean } | undefined
  enter(
    agent: Agent,
    messages: readonly UserMessage[],
    model: { provider: string; model: string },
  ): Promise<UserMessage | undefined>
  activate(sessionId: string): Promise<void>
  close(): Promise<void>
}
