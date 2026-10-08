/**
 * The one parser of a persisted Session log. Every reader that needs a session
 * fact — the review record's dimensions, a Run's execution receipt, the
 * consumption evidence of a task template — reads it from here, so the same log
 * cannot be parsed two ways.
 * @module dsh-singularity-task-runtime/session-facts
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReviewTokenUsage, ReviewToolCall } from '@dangosys/dsh-singularity-task'
import type { ReceiptRequestIdentity } from '@dangosys/dsh-singularity-task'

/** The human-facing tools: calling one is a person's intervention, not the worker's own work. */
export const HUMAN_TOOLS: ReadonlySet<string> = new Set(['hitl_ask', 'hitl_approve', 'ask_user_question'])

/** One calling configuration and how many requests the session made under it. */
export interface ModelRequestFact {
  readonly identity: ReceiptRequestIdentity
  readonly count: number
}

/** One `task_decompose` call a session made, with the text its successful result carried. */
export interface DecompositionCallFact {
  readonly callId: string
  readonly arguments: string
  /** The matching `tool/result`'s text, when the call succeeded and the result carried text. */
  readonly resultText?: string
}

/** Everything one persisted session log says, in the one shape every reader consumes. */
export interface SessionFacts {
  /** Whole-session token buckets from the session's `tokenUsage` projection, when the caller could read one. */
  readonly tokens?: ReviewTokenUsage
  /** Tool traffic the log shows; absent when no log was readable. */
  readonly toolCalls?: { readonly calls: readonly ReviewToolCall[]; readonly failures: number }
  /** Skill names the session really loaded (a successful `skill` call, or a `task-skills` injection), in order, duplicates preserved. */
  readonly skillCalls?: readonly string[]
  readonly humanInterventions?: number
  readonly compactions?: number
  /** Distinct request identities in first-appearance order. */
  readonly modelRequests?: readonly ModelRequestFact[]
  /** The session's `task_decompose` calls. */
  readonly decompositions?: readonly DecompositionCallFact[]
  /** Events the persisted log held; `undefined` means no log could be read at all (which is not the same as an empty log). */
  readonly logEvents?: number
  /** The last event's time as an ISO timestamp (the log's own `time` is epoch milliseconds), for judging whether it has already passed a run's terminal boundary. */
  readonly lastEventAt?: string
}

/** Whether one tool result reported a failure. */
export function toolResultFailed(data: {
  error?: unknown
  message?: { isError?: boolean }
}): boolean {
  if (data.error !== undefined) return true
  return data.message?.isError === true
}

/** The `name` a `skill` tool call asked to load, when its arguments name one. */
export function skillNameFrom(rawArguments: string): string | undefined {
  try {
    const parsed = JSON.parse(rawArguments) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/** One `request/header` event's calling configuration, as the identity it is. */
function requestIdentityOf(event: SessionEvent): ReceiptRequestIdentity | undefined {
  const config = (
    event.data as {
      header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown; maxTokens?: unknown } }
    }
  ).header?.config
  if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined
  return {
    provider: config.provider,
    model: config.model,
    ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
  }
}

/** The text one `tool/result` carried, when it succeeded and held any. */
function resultTextOf(event: SessionEvent): string | undefined {
  if (toolResultFailed(event.data as { error?: unknown; message?: { isError?: boolean } })) return undefined
  const message = (event.data as { message?: { content?: readonly { type?: unknown; text?: unknown }[] } }).message
  const text = (message?.content ?? [])
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('')
  return text.length === 0 ? undefined : text
}

/** The call id one `tool/result` answers, in either shape the log and older records use. */
function answeredCallId(event: SessionEvent): unknown {
  const message = (event.data as { message?: { toolCallId?: unknown; source?: { callId?: unknown } } }).message
  return message?.toolCallId ?? message?.source?.callId
}

/** The result event that answers one call, when the log holds one. */
function resultFor(events: readonly SessionEvent[], callId: string): SessionEvent | undefined {
  return events.find(event => event.type === 'tool/result' && String(answeredCallId(event)) === callId)
}

/** Whether one `task_decompose` call is the one a committed batch records: same reference, same parameters, a successful result naming the batch. */
export function decompositionMatches(
  fact: DecompositionCallFact,
  wanted: { readonly templateRef: unknown; readonly templateParameters: unknown },
  names: readonly string[],
): boolean {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(fact.arguments) as Record<string, unknown>
  } catch {
    return false
  }
  if (args.reason !== undefined || args.children !== undefined) return false
  if (JSON.stringify(args.templateRef ?? null) !== JSON.stringify(wanted.templateRef ?? null)) return false
  const parameters = wanted.templateParameters ?? {}
  if (JSON.stringify(args.templateParameters ?? {}) !== JSON.stringify(parameters)) return false
  if (fact.resultText === undefined) return false
  return names.some(name => fact.resultText!.includes(name))
}

/** The dedup key of one request identity: the four fields that make two requests the same call configuration. */
function identityKey(identity: ReceiptRequestIdentity): string {
  return JSON.stringify([identity.provider, identity.model, identity.reasoningEffort ?? null, identity.maxTokens ?? null])
}

/** Parse one session's events and token reading into the facts every reader consumes. One parse, one meaning. */
export function sessionFactsOf(events: readonly SessionEvent[], tokens?: ReviewTokenUsage): SessionFacts {
  const calls = new Map<string, number>()
  const humanCallIds: string[] = []
  const approvalCallIds = new Set<string>()
  const skillCalls: string[] = []
  const requestedSkills = new Map<string, string>()
  const requestCounts = new Map<string, { identity: ReceiptRequestIdentity; count: number }>()
  const decompositions: DecompositionCallFact[] = []
  let failures = 0
  let approvals = 0
  let compactions = 0
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = event.data.source as { kind?: string; names?: unknown }
      if (source.kind === 'task-skills' && Array.isArray(source.names)) {
        for (const name of source.names) if (typeof name === 'string') skillCalls.push(name)
      }
    } else if (event.type === 'request/header') {
      const identity = requestIdentityOf(event)
      if (identity !== undefined) {
        const key = identityKey(identity)
        const prior = requestCounts.get(key)
        requestCounts.set(key, { identity, count: (prior?.count ?? 0) + 1 })
      }
    } else if (event.type === 'tool/call') {
      const name = event.data.name
      if (typeof name !== 'string') continue
      calls.set(name, (calls.get(name) ?? 0) + 1)
      const callId = String(event.data.callId)
      if (HUMAN_TOOLS.has(name)) humanCallIds.push(callId)
      if (name === 'skill') {
        const skill = skillNameFrom(event.data.arguments)
        if (skill !== undefined) requestedSkills.set(callId, skill)
      }
      if (name === 'task_decompose') {
        const result = resultFor(events, callId)
        const text = result === undefined ? undefined : resultTextOf(result)
        decompositions.push({
          callId,
          arguments: String(event.data.arguments ?? ''),
          ...(text === undefined ? {} : { resultText: text }),
        })
      }
    } else if (event.type === 'tool/result') {
      if (toolResultFailed(event.data)) failures += 1
      else if (event.data.message !== undefined) {
        const skill = requestedSkills.get(String(event.data.message.source.callId))
        if (skill !== undefined) skillCalls.push(skill)
      }
    } else if (event.type === 'approval/asked') {
      approvals += 1
      if (typeof event.data.callId === 'string') approvalCallIds.add(event.data.callId)
    } else if ((event.type as string) === 'compaction/start') {
      // Written by the compaction plugin, whose event map this package does not load.
      compactions += 1
    }
  }
  const last = events.at(-1) as { time?: unknown } | undefined
  return {
    ...(tokens === undefined ? {} : { tokens }),
    toolCalls: {
      calls: [...calls].map(([name, count]) => ({ name, count })).sort((left, right) => left.name.localeCompare(right.name)),
      failures,
    },
    skillCalls,
    humanInterventions: approvals + humanCallIds.filter(id => !approvalCallIds.has(id)).length,
    compactions,
    modelRequests: [...requestCounts.values()].map(entry => ({ identity: entry.identity, count: entry.count })),
    decompositions,
    logEvents: events.length,
    ...(typeof last?.time === 'number' ? { lastEventAt: new Date(last.time).toISOString() } : {}),
  }
}
