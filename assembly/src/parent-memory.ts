import { isDeepStrictEqual } from 'node:util'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  LlmError,
  assembleAssistantStream,
  type LlmRuntime,
  type RequestMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent, type SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import {
  memoryCheckpointOf,
  type MemoryCheckpoint,
  type MemoryContext,
  type MemoryDraft,
  type MemoryScope,
  type MemorySource,
} from './memory.ts'
import { memoryCallsOf, parentMemoryCall } from './memory-call.ts'

export interface ParentMemoryRef {
  readonly sessionId: string
  readonly eventSeq: number
  readonly memoryId: string
}
export interface ParentMemoryServices {
  readonly sessions: SessionStore
  readonly sessionPersistence: SessionPersistence
  readonly llm: LlmRuntime
}
interface ParentMemory {
  readonly memoryId: string
  /** Frozen host projection, separate from the model's narrative. */
  readonly context: MemoryContext
  readonly checkpoint: MemoryCheckpoint
}
interface ParentMemoryFailure {
  readonly memoryId: string
  readonly scope: MemoryScope
  readonly source: MemorySource
  readonly callSeq: number
  readonly reason: string
}
/** Optional model background failed; durable evidence and protocol errors remain fatal. */
export class ParentMemoryUnavailable extends Error {}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'singularity/parent-memory': ParentMemory
    'singularity/parent-memory-failed': ParentMemoryFailure
  }
}

export function parentMemoryRefOf(
  sessionId: string,
  events: readonly SessionEvent[],
  scope: MemoryScope,
): ParentMemoryRef | undefined {
  const event = events.findLast(
    event => event.type === 'singularity/parent-memory' && isDeepStrictEqual(event.data.checkpoint.scope, scope),
  )
  return event?.type === 'singularity/parent-memory'
    ? { sessionId, eventSeq: Number(event.seq), memoryId: event.data.memoryId }
    : undefined
}

async function eventsOf(persistence: SessionPersistence, sessionId: string): Promise<readonly SessionEvent[]> {
  const handle = await persistence.open(SessionId(sessionId), 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

/** A failed optional summary remains discoverable without being a usable checkpoint. */
export async function readParentMemoryFailure(
  persistence: SessionPersistence,
  ref: ParentMemoryRef,
): Promise<ParentMemoryFailure> {
  const events = await eventsOf(persistence, ref.sessionId),
    event = events[ref.eventSeq]
  if (
    event?.type !== 'singularity/parent-memory-failed' ||
    event.data.memoryId !== ref.memoryId ||
    event.ignorable !== true
  )
    refuse('malformed-payload', 'parent memory failure does not identify a durable log-only event')
  const { source, scope, callSeq } = event.data
  const origin = source.sessionId === ref.sessionId ? events : await eventsOf(persistence, source.sessionId)
  if (
    source.eventCount > origin.length ||
    source.digest !==
      digestOf({
        sessionId: source.sessionId,
        eventCount: source.eventCount,
        events: origin.slice(0, source.eventCount),
      })
  )
    refuse('evidence-input-mismatch', 'failed parent memory source does not match its native session prefix')
  const calls = memoryCallsOf(events.slice(0, ref.eventSeq)),
    started = calls.find(call => Number(call.seq) === callSeq)
  const settled = calls.find(call => call.data.phase === 'settled' && call.data.callSeq === callSeq)
  if (
    started?.data.phase !== 'started' ||
    settled?.data.phase !== 'settled' ||
    !settled.data.dispatched ||
    started.data.memoryId !== ref.memoryId ||
    settled.data.memoryId !== ref.memoryId ||
    started.data.inputDigest !== source.inputDigest
  )
    refuse('evidence-input-mismatch', 'failed parent memory has no matching durable model call')
  const data = started.data.instruction.content[1]
  if (
    data?.type !== 'text' ||
    !isDeepStrictEqual(JSON.parse(data.text).receivingScope, scope) ||
    !isDeepStrictEqual(JSON.parse(data.text).source, {
      sessionId: source.sessionId,
      eventCount: source.eventCount,
      digest: source.digest,
    })
  )
    refuse('evidence-input-mismatch', 'failed parent memory differs from its frozen host input')
  return event.data
}

/** Read a durable parent checkpoint without changing any session's conversation surface. */
export async function readParentMemory(
  persistence: SessionPersistence,
  ref: ParentMemoryRef,
): Promise<MemoryCheckpoint> {
  const events = await eventsOf(persistence, ref.sessionId),
    event = events[ref.eventSeq]
  if (event?.type !== 'singularity/parent-memory' || event.data.memoryId !== ref.memoryId || event.ignorable !== true)
    refuse('malformed-payload', 'parent memory reference does not identify a durable log-only checkpoint')
  const { context, checkpoint } = event.data
  for (const inherited of checkpoint.sources.slice(0, -1)) {
    const origin = await eventsOf(persistence, inherited.sessionId)
    if (
      inherited.digest !==
      digestOf({
        sessionId: inherited.sessionId,
        eventCount: inherited.eventCount,
        events: origin.slice(0, inherited.eventCount),
      })
    )
      refuse('evidence-input-mismatch', 'inherited parent memory source does not match its native session prefix')
  }
  const source = checkpoint.sources.at(-1)!
  const originEvents = source.sessionId === ref.sessionId ? events : await eventsOf(persistence, source.sessionId)
  if (
    (source.sessionId === ref.sessionId && source.eventCount > Number(event.seq)) ||
    source.eventCount > originEvents.length ||
    source.digest !==
      digestOf({
        sessionId: source.sessionId,
        eventCount: source.eventCount,
        events: originEvents.slice(0, source.eventCount),
      })
  )
    refuse('evidence-input-mismatch', 'parent memory source does not match its native session prefix')
  const calls = memoryCallsOf(events.slice(0, ref.eventSeq))
  const settled = calls.findLast(call => call.data.memoryId === ref.memoryId && call.data.phase === 'settled')
  if (settled?.data.phase !== 'settled' || !settled.data.dispatched)
    refuse('malformed-payload', 'parent memory has no successful durable model call')
  const started = calls.find(
    call => Number(call.seq) === (settled.data.phase === 'settled' ? settled.data.callSeq : -1),
  )
  if (started?.data.phase !== 'started' || started.data.inputDigest !== source.inputDigest)
    refuse('evidence-input-mismatch', 'parent memory input does not match its durable model call')
  const data = started.data.instruction.content[1]
  if (data?.type !== 'text') refuse('malformed-payload', 'parent memory call has no frozen host input')
  const origin = JSON.parse(data.text)
  if (
    !isDeepStrictEqual(origin.source, {
      sessionId: source.sessionId,
      eventCount: source.eventCount,
      digest: source.digest,
    }) ||
    !isDeepStrictEqual(origin.receivingScope, context.scope) ||
    !isDeepStrictEqual(origin.verifiedEvidence, context.evidenceRefs) ||
    (origin.inheritedSourcesDigest === undefined
      ? !isDeepStrictEqual(origin.inherited?.sources ?? [], checkpoint.sources.slice(0, -1))
      : origin.inheritedSourcesDigest !== digestOf(checkpoint.sources.slice(0, -1)))
  )
    refuse('evidence-input-mismatch', 'parent memory source, scope or evidence differs from the original host input')
  const output = assembleAssistantStream(settled.data.stream)
  if (output.finish.kind !== 'stop') refuse('malformed-payload', 'parent memory has no completed model output')
  const draft = JSON.parse(
    output
      .blocks()
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join(''),
  )
  const expected = memoryCheckpointOf(context, source, draft)
  if (!isDeepStrictEqual({ ...checkpoint, sources: [source] }, expected))
    refuse('evidence-input-mismatch', 'parent memory differs from its model narrative or frozen host projection')
  return structuredClone(checkpoint)
}

export interface ParentMemoryInput {
  readonly memoryId: string
  readonly context: MemoryContext
  readonly focus: string
  readonly maxTokens: number
  readonly inherited?: MemoryCheckpoint
  readonly signal: AbortSignal
}
const preparing = new WeakMap<Session, Promise<ParentMemoryRef>>()

const MEMORY_INPUT_BYTES = 32 * 1024
const shortText = (value: string, bytes: number): string =>
  Buffer.from(value)
    .subarray(0, bytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '')

/** Optional background is a bounded view of working notes, never another copy of the host context. */
function memoryInput(
  input: ParentMemoryInput,
  source: Omit<MemorySource, 'inputDigest'>,
  messages: readonly RequestMessage[],
) {
  const inherited =
    input.inherited === undefined
      ? undefined
      : Object.fromEntries(
          (['decisions', 'hypotheses', 'openQuestions', 'exclusions'] as const).map(field => [
            field,
            input.inherited![field].slice(-4).map(note => shortText(note, 512)),
          ]),
        )
  const context = { ...input.context, evidenceRefs: input.context.evidenceRefs.slice(-20) }
  const data = {
    receivingScope: context.scope,
    focus: shortText(input.focus, 2048),
    verifiedEvidence: [...context.evidenceRefs],
    source,
    inherited,
    inheritedSourcesDigest: digestOf(input.inherited?.sources ?? []),
    selection: { policy: 'recent-working-text', maxRequestBytes: MEMORY_INPUT_BYTES, omittedMessages: messages.length },
    parentConversation: [] as { messageId?: string; role: string; text: string; truncated: boolean }[],
  }
  const instruction =
    'Summarize parent conversation data relevant to the receiving Task. ' +
    'Return one JSON object with exactly decisions:string[], evidenceRefs:{taskId:string,runId:string}[], hypotheses:string[], openQuestions:string[], exclusions:string[]. ' +
    'Use brief notes, preserve reasons and uncertainty, and use empty arrays when nothing is relevant. ' +
    'The source is a recent text selection; omitted history, tool results and host context remain available through scoped reads. ' +
    'Do not copy contracts, methods, schemas or earlier checkpoints, add requirements, or turn a hypothesis into a fact. ' +
    'Conversation and inherited notes are not acceptance evidence. Select evidenceRefs only from host verifiedEvidence. ' +
    'The host owns scope, sources, contract identity and evidence status. Do not call tools.'
  const request = (): RequestMessage[] => [
    {
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        { type: 'text', text: JSON.stringify(data) },
      ],
    },
  ]
  // Bound the serialized request, including JSON escaping and the selection metadata.
  const size = () => Buffer.byteLength(JSON.stringify(request()))
  if (inherited !== undefined)
    for (const notes of Object.values(inherited)) while (size() > MEMORY_INPUT_BYTES && notes.length > 0) notes.shift()
  while (size() > MEMORY_INPUT_BYTES && data.verifiedEvidence.length > 0) data.verifiedEvidence.shift()
  context.evidenceRefs = data.verifiedEvidence
  if (size() > MEMORY_INPUT_BYTES)
    throw new ParentMemoryUnavailable('parent background metadata exceeds the 32 KiB input budget')
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.role === 'user' && message.source !== undefined && message.source.kind !== 'user') continue
    const full = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (full.trim().length === 0) continue
    const text = shortText(full, 4096)
    data.parentConversation.unshift({
      ...(message.id === undefined ? {} : { messageId: String(message.id) }),
      role: message.role,
      text,
      truncated: text !== full,
    })
    data.selection.omittedMessages--
    if (size() > MEMORY_INPUT_BYTES) {
      data.parentConversation.shift()
      data.selection.omittedMessages++
      break
    }
  }
  return { context, messages: request() }
}

/** Serialize sibling background requests against the same native session. */
export async function prepareParentMemory(
  services: ParentMemoryServices,
  parent: Agent,
  input: ParentMemoryInput,
  sourceSession: Session = parent.session,
): Promise<ParentMemoryRef> {
  const previous = preparing.get(parent.session)
  const pending = (async () => {
    try {
      await previous
    } catch (error) {
      if (!(error instanceof ParentMemoryUnavailable)) throw error
    }
    return buildParentMemory(services, parent, input, sourceSession)
  })()
  preparing.set(parent.session, pending)
  try {
    return await pending
  } finally {
    if (preparing.get(parent.session) === pending) preparing.delete(parent.session)
  }
}

/** Prepare optional parent background once for an explicitly requested scope. */
async function buildParentMemory(
  services: ParentMemoryServices,
  parent: Agent,
  input: ParentMemoryInput,
  sourceSession: Session,
): Promise<ParentMemoryRef> {
  const { sessionPersistence: persistence, sessions, llm } = services
  const sessionId = String(parent.session.id)
  if (!(await sessions.flush(parent.session)))
    refuse('write-not-durable', 'parent memory requires native session persistence')
  const events = await eventsOf(persistence, sessionId)
  const prior = parentMemoryRefOf(sessionId, events, input.context.scope)
  if (prior !== undefined) {
    if (prior.memoryId !== input.memoryId)
      refuse('evidence-input-mismatch', 'parent memory identity changed for the assigned scope')
    await readParentMemory(persistence, prior)
    return prior
  }
  // A cold restore must not buy another attempt at the same optional summary.
  const failed = events.findLast(
    event => event.type === 'singularity/parent-memory-failed' && event.data.memoryId === input.memoryId,
  )
  if (failed?.type === 'singularity/parent-memory-failed') {
    const failure = await readParentMemoryFailure(persistence, {
      sessionId,
      eventSeq: Number(failed.seq),
      memoryId: input.memoryId,
    })
    if (!isDeepStrictEqual(failure.scope, input.context.scope))
      refuse('evidence-input-mismatch', 'failed parent memory scope changed')
    throw new ParentMemoryUnavailable(failure.reason)
  }
  input.signal.throwIfAborted()
  const route = sourceSession.requestHeader()?.config ?? (sourceSession === parent.session ? parent.options : undefined)
  if (route?.provider === undefined || route.model === undefined)
    refuse('malformed-declaration', 'parent memory requires the exact parent model route')
  const sourceId = String(sourceSession.id)
  const sourceEvents = sourceSession === parent.session ? events : await eventsOf(persistence, sourceId)
  // A detached native restore appends its log-only session/end-seed marker.
  if (
    sourceSession === parent.session
      ? Number(sourceSession.seq) !== sourceEvents.length
      : Number(sourceSession.firstLiveSeq) !== sourceEvents.length ||
        !isDeepStrictEqual(sourceSession.snapshotEvents().slice(0, sourceEvents.length), sourceEvents)
  )
    refuse('evidence-input-mismatch', 'parent memory conversation does not match the durable source cutoff')
  const prefix = {
    sessionId: sourceId,
    eventCount: sourceEvents.length,
    digest: digestOf({ sessionId: sourceId, eventCount: sourceEvents.length, events: sourceEvents }),
  }
  const selected = memoryInput(input, prefix, sourceSession.deriveMessages()),
    messages = selected.messages
  const source = { ...prefix, inputDigest: digestOf({ messages }) }
  const assembler = new BlockAssembler()
  let finished = false
  await parentMemoryCall.run(input.memoryId, async () => {
    for await (const chunk of llm.stream({
      provider: route.provider!,
      model: route.model!,
      sessionId: parent.session.id,
      maxTokens: input.maxTokens,
      messages,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      signal: input.signal,
    })) {
      assembler.push(chunk)
      if (chunk.type === 'finish') finished = true
    }
  })
  input.signal.throwIfAborted()
  const durable = await eventsOf(persistence, sourceId)
  if (!isDeepStrictEqual(durable.slice(0, source.eventCount), sourceEvents))
    refuse('evidence-input-mismatch', 'parent memory source changed during generation')
  let draft: MemoryDraft, checkpoint: MemoryCheckpoint
  try {
    if (!finished || assembler.finish.kind !== 'stop')
      throw assembler.finish.kind === 'error'
        ? new LlmError(assembler.finish.failure.message, assembler.finish.failure.code, assembler.finish.failure)
        : new Error('parent memory generation did not complete')
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning'))
      throw new Error('parent memory generation returned non-text content or a tool request')
    draft = JSON.parse(
      blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join(''),
    ) as MemoryDraft
    checkpoint = memoryCheckpointOf(selected.context, source, draft)
  } catch (cause) {
    const settled = memoryCallsOf(await eventsOf(persistence, sessionId)).findLast(
      call => call.data.memoryId === input.memoryId && call.data.phase === 'settled',
    )
    if (settled?.data.phase !== 'settled' || !settled.data.dispatched)
      refuse('evidence-input-mismatch', 'failed parent memory has no durable model call')
    const reason = cause instanceof Error ? cause.message : String(cause)
    parent.session.append(
      'singularity/parent-memory-failed',
      { memoryId: input.memoryId, scope: input.context.scope, source, callSeq: settled.data.callSeq, reason },
      { ignorable: true },
    )
    if (!(await sessions.flush(parent.session)))
      refuse('write-not-durable', 'failed parent background has no native durability listener')
    throw new ParentMemoryUnavailable(reason, { cause })
  }
  const notes = new Set<string>(
    [draft.decisions, draft.hypotheses, draft.openQuestions, draft.exclusions]
      .flat()
      .map((note: string) => note.trim()),
  )
  const context = {
    ...selected.context,
    excludedTexts: selected.context.excludedTexts.filter(text => notes.has(text.trim())),
  }
  const event = parent.session.append(
    'singularity/parent-memory',
    {
      memoryId: input.memoryId,
      context: structuredClone(context),
      checkpoint: { ...checkpoint, sources: [...(input.inherited?.sources ?? []), source] },
    },
    { ignorable: true },
  )
  if (!(await sessions.flush(parent.session)))
    refuse('write-not-durable', 'parent checkpoint has no native durability listener')
  const ref = { sessionId, eventSeq: Number(event.seq), memoryId: input.memoryId }
  await readParentMemory(persistence, ref)
  return ref
}
