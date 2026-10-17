import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AGENT_PROTOCOL, AGENT_VERSION, type AgentState } from '../../src/agent/protocol.ts'
import { REVIEW_PROTOCOL, REVIEW_VERSION, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type TaskState } from '../../src/task/protocol.ts'
import type { ControlReadCut } from '../../src/control/session-store.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { Apparatus } from './apparatus.ts'
import { readScopeOf } from './coordination.ts'
import type { MemoryScope } from './memory.ts'
import { readParentMemory, type ParentMemoryRef } from './parent-memory.ts'
import { rsiMemorySourceOf } from './rsi-memory.ts'

export interface MemoryReadInput {
  readonly ref?: string
  readonly from?: number
  readonly count?: number
}
interface MemoryEntry {
  readonly ref: string
  readonly preparedFor: MemoryScope
  readonly goal: string
  readonly runStatus: TaskState['runs'][string]['status']
  readonly currentRun: boolean
  readonly source: { readonly kind: 'task' | 'review'; readonly id: string; readonly sessionId: string; readonly eventCount: number }
}

/** Responsibility transfers change the live owner, not the native provenance of existing background. */
export function parentMemorySessionsOf(cut: ControlReadCut, parent: { kind: 'task' | 'review'; id: string; agentId: string }): readonly string[] {
  const agents = new Set([parent.agentId])
  if (parent.kind === 'task') for (const fact of cut.entriesOf(TASK_PROTOCOL, TASK_VERSION))
    if (fact.subject === parent.id && fact.kind === 'task/reassigned') agents.add((fact.payload as { from: string }).from)
  return [...agents].map(agentId => cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, agentId)!.sessionId)
}

/** Discover existing checkpoints from native logs; the directory is a read projection, not another memory store. */
export async function readMemoryForAgent(apparatus: Apparatus, agentId: string, input: MemoryReadInput = {}) {
  const from = input.from ?? 0, count = input.count ?? 20
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(count) || count < 1 || count > 100 ||
      (input.ref !== undefined && (input.ref.length === 0 || input.from !== undefined || input.count !== undefined)))
    refuse('malformed-declaration', 'memory accepts a checkpoint ref or a nonnegative offset and 1 to 100 directory entries')
  const cut = apparatus.store.load(), tasks = cut.statesOf<TaskState>(TASK_PROTOCOL, TASK_VERSION)
  const reviews = cut.statesOf<ReviewRun>(REVIEW_PROTOCOL, REVIEW_VERSION)
  const owner = [...tasks.values()].findLast(task => task.responsibility?.agentId === agentId)
  const review = [...reviews.values()].findLast(review => review.agentId === agentId)
  const { visible, audit } = await readScopeOf(apparatus, agentId, cut)
  const parents = new Map<string, { kind: 'task' | 'review'; id: string; agentId: string }>()
  for (const task of tasks.values()) for (const child of task.decomposition?.children ?? [])
    parents.set(child.taskId, { kind: 'task', id: task.taskId, agentId: task.responsibility!.agentId })
  for (const review of reviews.values()) for (const child of review.children)
    parents.set(child.taskId, { kind: 'review', id: review.reviewId, agentId: review.agentId })
  const boundary = (taskId: string): string => {
    let id = taskId, parent = parents.get(id)
    while (parent !== undefined && parent.kind === 'task') { id = parent.id; parent = parents.get(id) }
    return parent === undefined ? `task:${id}` : `review:${parent.id}`
  }
  const ownBoundary = review === undefined ? boundary(owner!.taskId) : `review:${review.reviewId}`
  // Frozen producer/artifact visibility does not grant access to the producer's working narrative.
  const allowed = [...tasks.values()].filter(task => visible!.has(task.taskId) &&
    (boundary(task.taskId) === ownBoundary || (audit && review === undefined &&
      !ownBoundary.startsWith('review:') && boundary(task.taskId).startsWith('task:'))))
  const sessions = new Map<string, readonly SessionEvent[]>()
  const entries: { entry: MemoryEntry; native: ParentMemoryRef }[] = []
  const predecessor = review === undefined ? await rsiMemorySourceOf(apparatus, agentId) : undefined
  if (predecessor !== undefined) {
    const node = cut.stateOf<AgentState>(AGENT_PROTOCOL, AGENT_VERSION, agentId)!
    const handle = await apparatus.persistence.open(SessionId(node.sessionId), 'read')
    try {
      const ownRun = Object.values(owner!.runs).at(-1)!
      for (const event of (await handle.read()).events) {
        if (event.type !== 'singularity/parent-memory') continue
        const scope = event.data.checkpoint.scope
        if (scope.kind !== 'task' || scope.taskId !== owner!.taskId || scope.runId !== ownRun.runId) continue
        const source = event.data.checkpoint.sources.at(-1)!
        if (event.ignorable !== true || scope.contractDigest !== owner!.contractDigest ||
            scope.method.environmentId !== ownRun.revision.environmentId || scope.method.revisionId !== ownRun.revision.revisionId ||
            scope.method.digest !== ownRun.revision.digest || source.sessionId !== predecessor.sessionId)
          refuse('evidence-input-mismatch', 'RSI memory does not match its receiving Run or explicit predecessor')
        entries.push({ native: { sessionId: node.sessionId, eventSeq: Number(event.seq), memoryId: event.data.memoryId },
          entry: { ref: event.data.memoryId, preparedFor: scope, goal: owner!.contract!.goal,
            runStatus: ownRun.status, currentRun: true,
            source: { kind: 'task', id: predecessor.task.taskId, sessionId: source.sessionId, eventCount: source.eventCount } } })
      }
      if (entries.length === 0) refuse('illegal-transition', 'previous RSI memory has not been prepared')
    } finally { await handle.close() }
  }
  for (const task of allowed) {
    const parent = parents.get(task.taskId)
    if (parent === undefined) continue
    for (const sessionId of parentMemorySessionsOf(cut, parent)) {
      let events = sessions.get(sessionId)
      if (events === undefined) {
        const handle = await apparatus.persistence.open(SessionId(sessionId), 'read')
        try { events = (await handle.read()).events } finally { await handle.close() }
        sessions.set(sessionId, events)
      }
      for (const event of events) {
        if (event.type !== 'singularity/parent-memory') continue
        const scope = event.data.checkpoint.scope
        if (scope.kind !== 'task' || scope.taskId !== task.taskId) continue
        const run = task.runs[scope.runId]
        if (event.ignorable !== true || run === undefined || scope.contractDigest !== task.contractDigest ||
            scope.method.environmentId !== run.revision.environmentId || scope.method.revisionId !== run.revision.revisionId ||
            scope.method.digest !== run.revision.digest)
          refuse('evidence-input-mismatch', 'memory directory checkpoint does not match its Task Run or parent session')
        const source = event.data.checkpoint.sources.at(-1)!
        if (source.sessionId !== sessionId)
          refuse('evidence-input-mismatch', 'memory directory checkpoint does not match its parent session')
        entries.push({ native: { sessionId, eventSeq: Number(event.seq), memoryId: event.data.memoryId },
          entry: { ref: event.data.memoryId,
            preparedFor: scope, goal: task.contract!.goal,
            runStatus: run.status, currentRun: Object.values(task.runs).at(-1)!.runId === run.runId,
            source: { kind: parent.kind, id: parent.id, sessionId,
              eventCount: source.eventCount } } })
      }
    }
  }
  if (new Set(entries.map(({ entry }) => entry.ref)).size !== entries.length)
    refuse('evidence-input-mismatch', 'memory directory contains duplicate checkpoint identities')
  if (input.ref !== undefined) {
    const selected = entries.find(({ entry }) => entry.ref === input.ref)
    if (selected === undefined) refuse('not-responsible', 'checkpoint is outside this memory scope')
    return { entry: selected.entry, checkpoint: await readParentMemory(apparatus.persistence, selected.native) }
  }
  const ownRun = owner === undefined ? undefined : Object.values(owner.runs).at(-1)
  const inherited = entries.find(({ entry }) => entry.preparedFor.kind === 'task' &&
    entry.preparedFor.taskId === owner?.taskId && entry.preparedFor.runId === ownRun?.runId)?.entry.ref ?? null
  if (review === undefined && owner !== undefined && parents.has(owner.taskId) && inherited === null)
    refuse('illegal-transition', 'assigned child parent memory has not been prepared')
  return { inherited, from, total: entries.length, nextFrom: from + count < entries.length ? from + count : null,
    entries: entries.slice(from, from + count).map(({ entry }) => entry) }
}
