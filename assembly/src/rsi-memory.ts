import { isDeepStrictEqual } from 'node:util'
import { SessionId, type SessionStore } from '@deepseek-ai/dsh-session'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import { record, nonEmpty } from './shape.ts'

export interface RsiMemoryInput { readonly sessionId: string; readonly previousRootId: string }
/** Explicit campaign provenance, never a spawn/decomposition edge or business evidence. */
interface RsiMemoryLink {
  readonly controlId: string
  readonly previousRootId: string
  readonly taskId: string
  readonly runId: string
  readonly sessionId: string
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap { 'singularity/rsi-predecessor': RsiMemoryLink }
}

function previousRsi(apparatus: Apparatus, previousRootId: string) {
  const cut = apparatus.store.load(), tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const root = tasks.get(previousRootId)
  if (root?.rsi?.status !== 'completed') refuse('illegal-transition', 'RSI memory requires the previous root RSI to have completed')
  const task = [...tasks.values()].find(candidate => Object.values(candidate.runs).some(run =>
    run.purpose === 'improve' && run.relatedTo?.taskId === previousRootId && run.relatedTo.runId === root.closure!.runId))!
  const run = Object.values(task.runs).at(-1)!
  if (task.closure === undefined || run.status !== 'verified')
    refuse('evidence-input-mismatch', 'completed RSI memory source has no accepted closed report')
  const sessionId = cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, task.responsibility!.agentId)!.sessionId
  return { task, run, sessionId }
}

/** Called by the authenticated campaign driver before prompting its fresh business root. */
export async function linkRsiMemory(apparatus: Apparatus, sessions: SessionStore, input: RsiMemoryInput): Promise<void> {
  const raw = record(input, 'RSI memory link')
  assertClosedKeys(raw, ['sessionId', 'previousRootId'], 'RSI memory link')
  nonEmpty(raw['sessionId'], 'sessionId'); nonEmpty(raw['previousRootId'], 'previousRootId')
  const session = sessions.get(SessionId(input.sessionId))
  const source = previousRsi(apparatus, input.previousRootId)
  const link: RsiMemoryLink = { controlId: apparatus.controlId, previousRootId: input.previousRootId,
    taskId: source.task.taskId, runId: source.run.runId, sessionId: source.sessionId }
  let events
  if (session === undefined) {
    const handle = await apparatus.persistence.open(SessionId(input.sessionId), 'read')
    try { events = (await handle.read()).events } finally { await handle.close() }
  } else events = session.snapshotEvents()
  const prior = events.filter(event => event.type === 'singularity/rsi-predecessor')
  if (prior.length > 0) {
    if (prior.length !== 1 || !isDeepStrictEqual(prior[0]!.data, link))
      refuse('evidence-input-mismatch', 'campaign RSI predecessor changed')
  } else {
    if (session === undefined) refuse('not-responsible', 'new RSI memory links require the exact live root session')
    if ([...apparatus.store.load().statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION).values()]
      .some(task => task.responsibility?.agentId === input.sessionId) || events.some(event => event.type === 'user/message'))
      refuse('illegal-transition', 'campaign RSI predecessor must be assigned before the new business root starts')
    session.append('singularity/rsi-predecessor', link, { ignorable: true })
  }
  if (session !== undefined && !(await sessions.flush(session))) refuse('write-not-durable', 'campaign RSI predecessor has no native durability listener')
}

/** Only the new RSI may cross the root boundary, following its explicit frozen campaign link. */
export async function rsiMemorySourceOf(apparatus: Apparatus, agentId: string) {
  const cut = apparatus.store.load(), tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const task = [...tasks.values()].findLast(task => task.responsibility?.agentId === agentId)
  const run = task === undefined ? undefined : Object.values(task.runs).at(-1)
  if (run?.purpose !== 'improve') return undefined
  const root = tasks.get(run.relatedTo!.taskId)!
  const node = cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, root.responsibility!.agentId)!
  const handle = await apparatus.persistence.open(SessionId(node.sessionId), 'read')
  try {
    const links = (await handle.read()).events.filter(event => event.type === 'singularity/rsi-predecessor')
    if (links.length === 0) return undefined
    if (links.length !== 1 || links[0]!.ignorable !== true) refuse('evidence-input-mismatch', 'campaign must have one durable RSI predecessor')
    const link = links[0]!.data, raw = record(link, 'RSI predecessor')
    assertClosedKeys(raw, ['controlId', 'previousRootId', 'taskId', 'runId', 'sessionId'], 'RSI predecessor')
    const source = previousRsi(apparatus, link.previousRootId)
    if (link.controlId !== apparatus.controlId || link.previousRootId === root.taskId || link.taskId !== source.task.taskId ||
        link.runId !== source.run.runId || link.sessionId !== source.sessionId)
      refuse('evidence-input-mismatch', 'campaign RSI predecessor does not match its closed Task/Run and native session')
    return source
  } finally { await handle.close() }
}
