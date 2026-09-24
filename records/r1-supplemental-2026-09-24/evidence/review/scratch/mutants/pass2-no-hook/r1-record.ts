/**
 * The scenario record: one run's raw facts, in the shape the frozen criteria
 * read (`driver/s3-criteria.ts:S3EvidenceRecord`) and the shape the evidence
 * directory archives.
 *
 * Everything here is a read of a durable surface — the tool-call accounting, the
 * desk record, the session JSONL under the scenario's isolated `dsh-home`, the
 * task store's snapshot — never a writer's return value. The verdict is *not*
 * computed here: the run writes facts, and the frozen criteria decide afterwards.
 */

import { existsSync, readFileSync } from 'node:fs'
import type { R1Stack } from './r1-stack.ts'

/** One delivered file's bytes, as the checkout holds them. */
export interface ScenarioArtifact {
  readonly path: string
  readonly raw: string
  readonly bytes: number
}

/** The ids one attempt produced, read back from the store. */
export interface ScenarioIds {
  readonly storeId: string
  readonly rootSessionId: string
  readonly rootTaskId?: string
  readonly rootRunId?: string
  readonly rootProposalId?: string
  readonly evidenceIds: readonly string[]
  readonly sessions: readonly string[]
  readonly childTaskIds: readonly string[]
  readonly childRunIds: readonly string[]
  readonly rootObjective?: string
  readonly rootContract?: unknown
}

/** One attempt's raw evidence. */
export interface ScenarioRecord {
  readonly schemaVersion: 'r1-scenario-record/1'
  readonly scenario: string
  readonly input: unknown
  readonly ids: ScenarioIds
  readonly usage: readonly unknown[]
  readonly toolCalls: readonly unknown[]
  readonly spawns: readonly unknown[]
  readonly humanQuestions: readonly unknown[]
  readonly clarifications: readonly unknown[]
  readonly sessionLogs: Readonly<Record<string, string>>
  readonly rootContract?: unknown
  readonly rootToolSurface: readonly string[]
  readonly evidence: readonly unknown[]
  readonly reviews: readonly unknown[]
  readonly artifacts: readonly ScenarioArtifact[]
  readonly rootTerminal: { readonly status: string; readonly reason?: string }
  readonly events: readonly string[]
  readonly reviewAsks: readonly unknown[]
  readonly recordErrors: readonly string[]
  readonly notes: readonly string[]
}

export interface BuildRecordOptions {
  readonly scenario: string
  readonly input: unknown
  /** Candidate paths to archive as artifacts; a path that does not exist is not an artifact. */
  readonly artifactPaths?: readonly string[]
  readonly rootTerminal: { readonly status: string; readonly reason?: string }
  readonly notes?: readonly string[]
}

/** Build one attempt's record from the stack and the store, after the root run has settled. */
export async function buildScenarioRecord(stack: R1Stack, options: BuildRecordOptions): Promise<ScenarioRecord> {
  const snapshot = await stack.snapshot(stack.storeId)
  const rootTask = snapshot.tasks.find(item => item.parentTaskId === undefined)
  const rootRun = rootTask === undefined ? undefined : snapshot.runs.find(item => item.taskId === rootTask.taskId && item.sessionId === String(stack.rootSessionId))
  const childTasks = snapshot.tasks.filter(item => item.parentTaskId !== undefined)
  const childRuns = childTasks.flatMap(task => snapshot.runs.filter(run => run.taskId === task.taskId))
  const events = stack.taskEvents(stack.storeId)
  const sessions = [String(stack.rootSessionId), ...snapshot.runs.map(run => String(run.sessionId)).filter(id => id !== String(stack.rootSessionId))]

  const artifacts = (options.artifactPaths ?? []).flatMap(path => existsSync(path)
    ? [{ path, raw: readFileSync(path, 'utf8'), bytes: Buffer.byteLength(readFileSync(path, 'utf8')) }]
    : [])

  const sessionLogs: Record<string, string> = {}
  for (const sessionId of new Set(sessions)) sessionLogs[sessionId] = stack.logBytes(sessionId)

  const rootContract = rootTask === undefined
    ? undefined
    : rootTask.contract ?? { objective: rootTask.objective, acceptanceCriteria: rootTask.acceptanceCriteria }

  type TaskEvent = ReturnType<R1Stack['taskEvents']>[number]
  const rootProposal = events.find((event): event is Extract<TaskEvent, { kind: 'TaskProposalSubmitted' }> => event.kind === 'TaskProposalSubmitted')
  const rootProposalId = rootProposal?.payload.proposal.kind === 'root' ? rootProposal.payload.proposal.proposalId : undefined

  const notes = [...(options.notes ?? [])]
  notes.push(`the adapter boundary saw ${stack.requestsOf(String(stack.rootSessionId)).length} model request(s) for the root session`)

  return {
    schemaVersion: 'r1-scenario-record/1',
    scenario: options.scenario,
    input: options.input,
    ids: {
      storeId: stack.storeId,
      rootSessionId: String(stack.rootSessionId),
      ...(rootTask === undefined ? {} : { rootTaskId: rootTask.taskId, rootObjective: rootTask.objective, rootContract: rootTask.contract }),
      ...(rootRun === undefined ? {} : { rootRunId: rootRun.runId }),
      ...(rootProposalId === undefined ? {} : { rootProposalId }),
      evidenceIds: snapshot.evidence.map(item => String(item.evidenceId)),
      sessions,
      childTaskIds: childTasks.map(item => String(item.taskId)),
      childRunIds: childRuns.map(item => String(item.runId)),
    },
    usage: stack.usage(),
    toolCalls: stack.toolCalls(),
    spawns: stack.spawns(),
    humanQuestions: stack.humanQuestions(),
    clarifications: stack.clarifications(),
    sessionLogs,
    ...(rootContract === undefined ? {} : { rootContract }),
    rootToolSurface: stack.visibleTools(stack.rootAgent()),
    evidence: snapshot.evidence,
    reviews: snapshot.reviews,
    artifacts,
    rootTerminal: { status: options.rootTerminal.status, ...(options.rootTerminal.reason === undefined ? {} : { reason: options.rootTerminal.reason }) },
    events: events.map(event => `${event.kind}@${event.taskId}`),
    reviewAsks: stack.reviewAsks,
    recordErrors: stack.recordErrors(),
    notes,
  }
}
