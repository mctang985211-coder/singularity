import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { AGENT_PROTOCOL, type AgentState } from '../../src/agent/protocol.ts'
import { digestOf, type Envelope } from '../../src/protocol/envelope.ts'
import { REVIEW_PROTOCOL, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION, type RunState, type TaskState } from '../../src/task/protocol.ts'
import type { Apparatus } from '../src/apparatus.ts'
import { sha256 } from '../src/ids.ts'
import { mountCampaignMemory } from '../src/index.ts'
import { memoryCallsOf } from '../src/memory-call.ts'
import { readMemoryForAgent } from '../src/memory-view.ts'
import { parentMemoryRefOf, prepareParentMemory, readParentMemory } from '../src/parent-memory.ts'
import type { MemoryContext, MemoryDraft } from '../src/memory.ts'
import { linkRsiMemory, rsiMemorySourceOf } from '../src/rsi-memory.ts'

const nativeRequire = createRequire('/home/ROXY/singularity-next/dsh/node_modules/@deepseek-ai/dsh-agent-loop/package.json')
const { default: SystemPrompt } = await import(nativeRequire.resolve('@deepseek-ai/dsh-system-prompt')) as typeof import('@deepseek-ai/dsh-system-prompt')
const { default: SessionProjections } = await import(nativeRequire.resolve('@deepseek-ai/dsh-session-projection')) as typeof import('@deepseek-ai/dsh-session-projection')

const roots: string[] = [], contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const scope: MemoryContext['scope'] = { kind: 'task', taskId: 'memory-task', runId: 'memory-run',
  contractDigest: 'c'.repeat(64), method: { environmentId: 'memory-methods', revisionId: 'method-pinned', digest: 'd'.repeat(64) } }
const proof = { taskId: 'verified-producer', runId: 'verified-run' }
const hostProof = { ...proof, status: 'verified' as const, artifactDigest: 'e'.repeat(64) }
const authority = 'The frozen artifact must contain the independently verified count.'
const draft: MemoryDraft = { decisions: ['Reuse the verified producer artifact.'], evidenceRefs: [proof],
  hypotheses: ['A direct integration may avoid another investigation.'], openQuestions: ['Does the integration preserve every input?'],
  exclusions: ['Do not repeat the delegated extraction.'] }

class MemoryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  response: string = JSON.stringify(draft)
  toolOutput = false
  summaryFinish = true
  summaryUsage = true
  summaryError = false
  duringSummary?: () => void
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 200_000 } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const summary = options.messages[0]?.content.some(block => block.type === 'text' && block.text.startsWith('Summarize parent conversation data'))
    if (summary) this.duringSummary?.()
    if (summary && this.summaryError) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '{"decisions":[' }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'upstream_error: stream_read_error' } } }
      return
    }
    if (summary && this.toolOutput) {
      const id = ToolCallId('forged-memory-tool-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'memory_fixture_write', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'memory_fixture_write', arguments: '{}' } }
      yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 10, totalTokens: 70 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = summary ? this.response : 'A provisional working observation; the frozen contract remains authoritative.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    if (!summary || this.summaryUsage) yield { type: 'usage', usage: { inputTokens: 60, outputTokens: 10, totalTokens: 70 } }
    if (!summary || this.summaryFinish) yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'memory-native-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  mountCampaignMemory(ctx)
  const execute = vi.fn(async () => 'unexpected tool execution')
  ctx.tools.register(defineTool({ name: 'memory_fixture_write', description: 'A tool which a summarizer must never call.',
    parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute }))
  const context: MemoryContext = { scope, evidenceRefs: [hostProof], excludedTexts: [authority] }
  const memoryContext = vi.fn(async (): Promise<MemoryContext> => structuredClone(context))
  ctx.provide('singularity', { memoryContext } as unknown as Context['singularity'])
  const adapter = new MemoryAdapter()
  ctx.llm.registerAdapter(['memory-test'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('memory-native'), { provider: 'memory-test', model: 'test', maxTokens: 256 }, { cwd: root })
  const send = async (label: string) => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
      text: `${label}: ${'An exploratory observation with no change to the frozen contract. '.repeat(180)}` }] }))
    await agent.whenIdle()
    expect(await ctx.sessions.flush(agent.session)).toBe(true)
  }
  await send('original investigation')
  await send('delegation outcome')
  return { root, ctx, agent, adapter, context, memoryContext, execute, send }
}

async function durableEvents(ctx: Context, agent: Agent): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(agent.session.id, 'read')
  try { return (await handle.read()).events }
  finally { await handle.close() }
}

async function prepare(h: Awaited<ReturnType<typeof fixture>>, context = h.context, inherited?: Awaited<ReturnType<typeof readParentMemory>>) {
  return prepareParentMemory(h.ctx, h.agent, { memoryId: context.scope.kind === 'task' ? `memory:${context.scope.taskId}/${context.scope.runId}` : context.scope.reviewId,
    context, focus: 'Integrate the independently verified producer.', maxTokens: 4096, signal: new AbortController().signal,
    ...(inherited === undefined ? {} : { inherited }) })
}

it('automatically prepares optional parent background without compressing or injecting the child conversation', async () => {
  const h = await fixture(), before = await durableEvents(h.ctx, h.agent), surface = h.agent.session.deriveMessages()
  const ref = await prepare(h), events = await durableEvents(h.ctx, h.agent)
  const checkpoint = await readParentMemory(h.ctx.sessionPersistence, ref)
  expect(checkpoint).toMatchObject({ formatVersion: 1, scope, decisions: draft.decisions, evidenceRefs: [hostProof] })
  expect(checkpoint.sources).toEqual([{ sessionId: String(h.agent.session.id), eventCount: before.length,
    digest: digestOf({ sessionId: String(h.agent.session.id), eventCount: before.length, events: before }),
    inputDigest: checkpoint.sources[0]!.inputDigest }])
  expect(events.filter(event => event.type.startsWith('compaction/'))).toEqual([])
  expect(h.agent.session.deriveMessages()).toEqual(surface)
  expect(memoryCallsOf(events)).toHaveLength(2)
  const request = h.adapter.requests.at(-1)!
  expect(request.purpose).toBeUndefined()
  expect(request.tools).toBeUndefined()
  expect(request.messages).toHaveLength(1)
  expect(h.execute).not.toHaveBeenCalled()
  expect(parentMemoryRefOf(String(h.agent.session.id), events, scope)).toEqual(ref)
  expect(await prepare(h)).toEqual(ref)
  expect(h.adapter.requests).toHaveLength(3)
})

it('carries ancestor background into the next summary even when the parent never reads it', async () => {
  const h = await fixture(), prior = await prepare(h), inherited = await readParentMemory(h.ctx.sessionPersistence, prior)
  const next: MemoryContext = { ...h.context, scope: { ...scope, kind: 'task', taskId: 'grandchild', runId: 'grandchild-run' } as MemoryContext['scope'] }
  const ref = await prepare(h, next, inherited)
  const checkpoint = await readParentMemory(h.ctx.sessionPersistence, ref)
  expect(checkpoint.scope).toEqual(next.scope)
  expect(checkpoint.sources).toHaveLength(2)
  const request = h.adapter.requests.at(-1)!, data = request.messages[0]!.content[1]!
  expect(data.type === 'text' ? JSON.parse(data.text).inherited : null).toEqual(inherited)
  expect(h.agent.session.deriveMessages().some(message => JSON.stringify(message).includes('formatVersion'))).toBe(false)
  const forged = structuredClone(await durableEvents(h.ctx, h.agent)), event = forged[ref.eventSeq]!
  if (event.type !== 'singularity/parent-memory') throw new Error('missing descendant checkpoint')
  Object.assign(event.data.checkpoint, { sources: event.data.checkpoint.sources.slice(1) })
  const persistence = { open: async () => ({ read: async () => ({ events: forged }), close: async () => undefined }) } as unknown as Context['sessionPersistence']
  await expect(readParentMemory(persistence, ref)).rejects.toThrow('differs from the original host input')
})

it.each([
  ['malformed JSON', () => '{', /JSON/],
  ['forged evidence', () => JSON.stringify({ ...draft, evidenceRefs: [{ taskId: 'unverified', runId: 'claimed-by-parent' }] }), /visible verified/],
  ['forged status', () => JSON.stringify({ ...draft, evidenceRefs: [{ ...proof, status: 'verified' }] }), /unknown member/],
])('rejects %s while retaining exact model usage', async (_label, output, expected) => {
  const h = await fixture(); h.adapter.response = output()
  await expect(prepare(h)).rejects.toThrow(expected)
  const events = await durableEvents(h.ctx, h.agent)
  expect(events.filter(event => event.type === 'singularity/parent-memory')).toEqual([])
})

it('does not execute summarizer tool requests', async () => {
  const h = await fixture(); h.adapter.toolOutput = true
  await expect(prepare(h)).rejects.toThrow('did not complete')
  expect(h.execute).not.toHaveBeenCalled()
})

it('propagates a malformed summary to queued scopes without publishing checkpoints', async () => {
  const h = await fixture(); h.adapter.response = '{'
  const sibling = { ...h.context, scope: { ...scope, kind: 'task' as const, taskId: 'sibling', runId: 'sibling-run' } }
  const results = await Promise.allSettled([prepare(h), prepare(h, sibling)])
  expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect((await durableEvents(h.ctx, h.agent)).filter(event => event.type === 'singularity/parent-memory')).toEqual([])
})

it('propagates persistence failure instead of treating it as an unavailable optional summary', async () => {
  const h = await fixture(), failure = new Error('native persistence flush failed')
  const flush = h.ctx.sessions.flush.bind(h.ctx.sessions)
  vi.spyOn(h.ctx.sessions, 'flush').mockImplementationOnce(flush).mockRejectedValueOnce(failure)
  await expect(prepare(h)).rejects.toBe(failure)
})

it('propagates a shared persistence failure to queued summaries', async () => {
  const h = await fixture(), failure = new Error('native persistence unavailable')
  vi.spyOn(h.ctx.sessions, 'flush').mockRejectedValueOnce(failure)
  const sibling = { ...h.context, scope: { ...scope, kind: 'task' as const, taskId: 'sibling', runId: 'sibling-run' } }
  const results = await Promise.allSettled([prepare(h), prepare(h, sibling)])
  expect(results).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }])
})

it('removes padded authority repetitions without losing the canonical narrative on later reads', async () => {
  const h = await fixture()
  h.adapter.response = JSON.stringify({ ...draft, decisions: [`  ${authority}  `, '  Preserve the bounded finding.  '] })
  const ref = await prepare(h)
  expect((await readParentMemory(h.ctx.sessionPersistence, ref)).decisions).toEqual(['Preserve the bounded finding.'])
})

it('publishes valid parent background despite missing usage and allows later native calls', async () => {
  const h = await fixture(); h.adapter.summaryUsage = false
  const ref = await prepare(h)
  expect((await readParentMemory(h.ctx.sessionPersistence, ref)).decisions).toEqual(draft.decisions)
  const events = await durableEvents(h.ctx, h.agent)
  expect(events.filter(event => event.type === 'singularity/parent-memory')).toHaveLength(1)
  await h.send('continue after missing summary usage')
  expect(h.adapter.requests.at(-1)!.messages.some(message => JSON.stringify(message).includes('continue after missing summary usage'))).toBe(true)
})

it('validates checkpoint source and original model output on each optional read', async () => {
  const h = await fixture(), ref = await prepare(h), events = await durableEvents(h.ctx, h.agent)
  const fake = structuredClone(events), event = fake[ref.eventSeq]!
  if (event.type !== 'singularity/parent-memory') throw new Error('missing checkpoint')
  Object.assign(event.data.checkpoint, { decisions: ['A forged certainty.'] })
  const persistence = { open: async () => ({ read: async () => ({ events: fake }), close: async () => undefined }) } as unknown as Context['sessionPersistence']
  await expect(readParentMemory(persistence, ref)).rejects.toThrow('differs from its model narrative')
  Object.assign(event.data.checkpoint.sources[0]!, { digest: 'f'.repeat(64) })
  await expect(readParentMemory(persistence, ref)).rejects.toThrow('session prefix')
})

it('reads the persisted checkpoint after native session persistence is reopened', async () => {
  const h = await fixture(), ref = await prepare(h), original = await readParentMemory(h.ctx.sessionPersistence, ref)
  await h.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(h.ctx), 1)
  const restored = new Context(); contexts.push(restored)
  await restored.plugin(SessionStore)
  await restored.plugin(JsonlPersistence, { root: join(h.root, 'sessions'), compression: 'none' })
  expect(await readParentMemory(restored.sessionPersistence, ref)).toEqual(original)
})

async function globalFixture() {
  const h = await fixture(), tasks = new Map<string, TaskState>(), reviews = new Map<string, ReviewRun>()
  const agents = new Map<string, AgentState>(), native = new Map<string, Agent>()
  const facts: Envelope[] = []
  const edge = (taskId: string) => ({ taskId, dependsOn: [], supports: ['accurate'], maxRuns: 2, requirement: 'required' as const })
  const addTask = async (taskId: string, parentId?: string, existing?: Agent) => {
    const agent = existing ?? await h.ctx.agentLoop.create(SessionId(`global-${taskId}`),
      { provider: 'memory-test', model: 'test', maxTokens: 256 }, { cwd: h.root })
    if (existing === undefined) {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Investigate ${taskId}.` }] }))
      await agent.whenIdle()
      expect(await h.ctx.sessions.flush(agent.session)).toBe(true)
    }
    const agentId = String(agent.id), runId = `${taskId}-run`
    agents.set(agentId, { agentId, role: parentId === undefined ? 'root' : 'task', sessionId: String(agent.session.id), openedAt: 'now' })
    native.set(taskId, agent)
    tasks.set(taskId, { taskId, contract: { goal: `Deliver ${taskId}.`, artifact: 'answer.txt', inputs: [],
      criteria: [{ criterionId: 'accurate', statement: 'Preserve the frozen inputs.' }] }, contractDigest: 'c'.repeat(64),
      responsibility: { agentId, agentIdentity: `identity:${agentId}`, assignedAt: 'now' },
      runs: { [runId]: { runId, actor: `identity:${agentId}`, emitter: 'agent', revision: scope.method,
        purpose: 'solve', status: 'running', stage: 'working', startedAt: 'now', evidence: [], consumed: [] } } })
    if (parentId !== undefined) {
      const parent = tasks.get(parentId), review = reviews.get(parentId)
      if (parent !== undefined) tasks.set(parentId, { ...parent, decomposition: {
        at: 'now', children: [...(parent.decomposition?.children ?? []), edge(taskId)] } })
      else if (review !== undefined) reviews.set(parentId, { ...review, children: [...review.children, edge(taskId)] })
      else throw new Error(`unknown parent ${parentId}`)
    }
    return agentId
  }
  const addReview = async (reviewId: string, targetTaskId = 'root') => {
    const agent = await h.ctx.agentLoop.create(SessionId(`global-${reviewId}`),
      { provider: 'memory-test', model: 'test', maxTokens: 256 }, { cwd: h.root })
    const agentId = String(agent.id), bytes = Buffer.from(JSON.stringify({ inputProducers: [] }))
    agents.set(agentId, { agentId, role: 'review', sessionId: String(agent.session.id), openedAt: 'now' })
    native.set(reviewId, agent)
    reviews.set(reviewId, { reviewId, agentId, identity: `identity:${agentId}`, sessionId: String(agent.session.id),
      workspace: h.root, model: { provider: 'memory-test', model: 'test' }, method: scope.method,
      status: 'running', children: [], subjectDigest: sha256(bytes),
      subject: { attachmentId: AttachmentId(`sha256:${sha256(bytes)}`), name: 'subject.json', bytes: bytes.length },
      target: { kind: 'acceptance', taskId: targetTaskId, runId: `${targetTaskId}-run`, contractDigest: 'c'.repeat(64), artifactDigest: 'a'.repeat(64) },
      criteria: tasks.get(targetTaskId)!.contract!.criteria })
    return agentId
  }
  const subject = Buffer.from(JSON.stringify({ inputProducers: [] }))
  const apparatus = { controlId: 'memory-campaign', persistence: h.ctx.sessionPersistence, attachments: { readFileStream: async function* () { yield subject } },
    store: { load: () => ({
      entriesOf: (protocol: string, version: number) => facts.filter(fact => fact.protocol === protocol && fact.version === version),
      statesOf: (protocol: string) => protocol === TASK_PROTOCOL ? tasks : protocol === REVIEW_PROTOCOL ? reviews : protocol === AGENT_PROTOCOL ? agents : new Map(),
      stateOf: (protocol: string, _version: number, id: string) => protocol === TASK_PROTOCOL ? tasks.get(id)
        : protocol === REVIEW_PROTOCOL ? reviews.get(id) : protocol === AGENT_PROTOCOL ? agents.get(id) : undefined,
    }) } } as unknown as Apparatus
  const checkpoint = async (taskId: string, parentId: string, runId = `${taskId}-run`) => {
    const context: MemoryContext = { ...h.context, scope: { kind: 'task', taskId, runId, contractDigest: 'c'.repeat(64), method: scope.method } }
    return prepareParentMemory(h.ctx, native.get(parentId)!, { memoryId: `global-memory:${taskId}/${runId}`, context,
      focus: tasks.get(taskId)!.contract!.goal, maxTokens: 4096, signal: new AbortController().signal })
  }
  const rootId = await addTask('root', undefined, h.agent)
  const leftId = await addTask('left', 'root'), rightId = await addTask('right', 'root')
  const leafId = await addTask('leaf', 'left'), nephewId = await addTask('nephew', 'right')
  const refs = new Map<string, Awaited<ReturnType<typeof checkpoint>>>()
  for (const [taskId, parentId] of [['left', 'root'], ['right', 'root'], ['leaf', 'left'], ['nephew', 'right']] as const)
    refs.set(taskId, await checkpoint(taskId, parentId))
  return { ...h, apparatus, tasks, reviews, agents, native, facts, addTask, addReview, checkpoint, refs, rootId, leftId, rightId, leafId, nephewId }
}

async function memoryDirectory(apparatus: Apparatus, agentId: string, input: { from?: number; count?: number } = {}) {
  const result = await readMemoryForAgent(apparatus, agentId, input)
  if (result.entries === undefined) throw new Error('expected memory directory')
  return result
}

it('hands normalized RSI memory to a fresh session across roots, with a cold source and no business or review access', async () => {
  const h = await globalFixture()
  const previousId = await h.addTask('previous-rsi'), previous = h.tasks.get('previous-rsi')!
  const previousRun = { ...previous.runs['previous-rsi-run']!, purpose: 'improve' as const, status: 'verified' as const,
    relatedTo: { taskId: 'root', runId: 'root-run' } }
  h.tasks.set('previous-rsi', { ...previous, runs: { [previousRun.runId]: previousRun },
    closure: { runId: previousRun.runId, reason: 'accepted' } })
  const root = h.tasks.get('root')!
  h.tasks.set('root', { ...root, closure: { runId: 'root-run', reason: 'accepted' }, rsi: { status: 'completed', detail: 'accepted RSI report' } })
  const fresh = await h.ctx.agentLoop.create(SessionId('next-business-root'), { provider: 'memory-test', model: 'test' }, { cwd: h.root })
  const input = { sessionId: String(fresh.session.id), previousRootId: 'root' }
  const rootSurface = fresh.session.deriveMessages()
  await linkRsiMemory(h.apparatus, h.ctx.sessions, input)
  await linkRsiMemory(h.apparatus, h.ctx.sessions, input)
  expect(fresh.session.deriveMessages()).toEqual(rootSurface)
  expect((await durableEvents(h.ctx, fresh)).filter(event => event.type === 'singularity/rsi-predecessor')).toHaveLength(1)
  const businessId = await h.addTask('next-root', undefined, fresh)
  const receiver = await h.ctx.agentLoop.create(SessionId('fresh-rsi-recipient'), { provider: 'memory-test', model: 'test' }, { cwd: h.root })
  const nextId = await h.addTask('next-rsi', undefined, receiver), next = h.tasks.get('next-rsi')!
  h.tasks.set('next-rsi', { ...next, runs: { 'next-rsi-run': { ...next.runs['next-rsi-run']!, purpose: 'improve',
    relatedTo: { taskId: 'next-root', runId: 'next-root-run' } } } })
  expect(nextId).not.toBe(previousId)
  expect((await rsiMemorySourceOf(h.apparatus, nextId))?.task.taskId).toBe('previous-rsi')
  const sourceAgent = h.native.get('previous-rsi')!, sourceEvents = await durableEvents(h.ctx, sourceAgent)
  const handle = await h.ctx.sessionPersistence.open(sourceAgent.session.id, 'read')
  const stored = await handle.read(); await handle.close()
  const cold = Session.create(handle.id, stored.events, handle.header, handle.inheritedEventCount)
  const before = receiver.session.deriveMessages()
  const context: MemoryContext = { ...h.context, scope: { kind: 'task', taskId: 'next-rsi', runId: 'next-rsi-run',
    contractDigest: 'c'.repeat(64), method: scope.method } }
  const summary = () => prepareParentMemory(h.ctx, receiver, { memoryId: 'rsi-handoff', context,
    focus: 'Preserve rejected mechanisms and measured round references.', maxTokens: 4096, signal: new AbortController().signal }, cold)
  const ref = await summary(), calls = h.adapter.requests.length
  const directory = await memoryDirectory(h.apparatus, nextId)
  expect(directory).toMatchObject({ inherited: ref.memoryId, total: 1, entries: [{ source: { kind: 'task', id: 'previous-rsi' } }] })
  expect(JSON.stringify(directory)).not.toContain(draft.decisions[0])
  const checkpoint = (await readMemoryForAgent(h.apparatus, nextId, { ref: directory.inherited! })).checkpoint!
  expect(checkpoint).toMatchObject({ scope: context.scope, decisions: draft.decisions,
    sources: [{ sessionId: String(sourceAgent.session.id), eventCount: sourceEvents.length }] })
  expect(receiver.session.deriveMessages()).toEqual(before)
  expect(await durableEvents(h.ctx, sourceAgent)).toEqual(sourceEvents)
  expect(await summary()).toEqual(ref)
  expect(h.adapter.requests).toHaveLength(calls)
  const reviewerId = await h.addReview('next-review', 'next-rsi')
  for (const caller of [businessId, h.leftId, reviewerId, previousId])
    await expect(readMemoryForAgent(h.apparatus, caller, { ref: ref.memoryId })).rejects.toThrow('outside this memory scope')
  const altered = structuredClone(sourceEvents)
  Object.assign(altered[0]!, { time: 1 })
  const persistence = { open: async (id: string) => ({ read: async () => ({ events:
    id === String(sourceAgent.session.id) ? altered : await durableEvents(h.ctx, receiver) }), close: async () => undefined }) } as unknown as Context['sessionPersistence']
  await expect(readParentMemory(persistence, ref)).rejects.toThrow('session prefix')
  await linkRsiMemory(h.apparatus, { get: () => undefined } as unknown as SessionStore, input)
  expect(await readParentMemory(h.ctx.sessionPersistence, ref)).toEqual(checkpoint)
  receiver.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue the new RSI investigation.' }] }))
  await receiver.whenIdle()
  expect(await h.ctx.sessions.flush(receiver.session)).toBe(true)
  expect(JSON.stringify(h.adapter.requests.at(-1)!.messages)).not.toContain(draft.decisions[0])
  // A third fresh RSI inherits the second checkpoint even if its source never consumed those notes.
  const secondRoot = h.tasks.get('next-root')!, secondRsi = h.tasks.get('next-rsi')!
  h.tasks.set('next-root', { ...secondRoot, closure: { runId: 'next-root-run', reason: 'accepted' }, rsi: { status: 'completed', detail: 'accepted RSI report' } })
  h.tasks.set('next-rsi', { ...secondRsi, closure: { runId: 'next-rsi-run', reason: 'accepted' }, runs: {
    'next-rsi-run': { ...secondRsi.runs['next-rsi-run']!, status: 'verified' } } })
  await expect(linkRsiMemory(h.apparatus, h.ctx.sessions, { ...input, previousRootId: 'next-root' })).rejects.toThrow('predecessor changed')
  const thirdRoot = await h.ctx.agentLoop.create(SessionId('third-business-root'), { provider: 'memory-test', model: 'test' }, { cwd: h.root })
  await linkRsiMemory(h.apparatus, h.ctx.sessions, { sessionId: String(thirdRoot.id), previousRootId: 'next-root' })
  await h.addTask('third-root', undefined, thirdRoot)
  const thirdId = await h.addTask('third-rsi'), third = h.tasks.get('third-rsi')!
  h.tasks.set('third-rsi', { ...third, runs: { 'third-rsi-run': { ...third.runs['third-rsi-run']!, purpose: 'improve',
    relatedTo: { taskId: 'third-root', runId: 'third-root-run' } } } })
  const secondHandle = await h.ctx.sessionPersistence.open(receiver.session.id, 'read')
  const secondStored = await secondHandle.read(); await secondHandle.close()
  const thirdScope = { kind: 'task' as const, taskId: 'third-rsi', runId: 'third-rsi-run', contractDigest: 'c'.repeat(64), method: scope.method }
  const thirdRef = await prepareParentMemory(h.ctx, h.native.get('third-rsi')!, { memoryId: 'third-rsi-handoff',
    context: { ...context, scope: thirdScope }, inherited: checkpoint, focus: 'Continue measured optimization.',
    maxTokens: 4096, signal: new AbortController().signal },
    Session.create(secondHandle.id, secondStored.events, secondHandle.header, secondHandle.inheritedEventCount))
  const thirdDirectory = await memoryDirectory(h.apparatus, thirdId)
  expect(thirdDirectory).toMatchObject({ inherited: thirdRef.memoryId, total: 1 })
  expect((await readParentMemory(h.ctx.sessionPersistence, thirdRef)).sources.map(source => source.sessionId))
    .toEqual([String(sourceAgent.id), String(receiver.id)])
  expect(new Set([previousId, nextId, thirdId]).size).toBe(3)
})

it('rejects RSI handoff before completion or after a recipient starts', async () => {
  const h = await globalFixture()
  await expect(linkRsiMemory(h.apparatus, h.ctx.sessions,
    { sessionId: String(h.agent.id), previousRootId: 'root' })).rejects.toThrow('previous root RSI to have completed')
  const previousId = await h.addTask('previous-rsi'), previous = h.tasks.get('previous-rsi')!
  h.tasks.set('previous-rsi', { ...previous, closure: { runId: 'previous-rsi-run', reason: 'accepted' }, runs: {
    'previous-rsi-run': { ...previous.runs['previous-rsi-run']!, purpose: 'improve', status: 'verified', relatedTo: { taskId: 'root', runId: 'root-run' } } } })
  const root = h.tasks.get('root')!
  h.tasks.set('root', { ...root, closure: { runId: 'root-run', reason: 'accepted' }, rsi: { status: 'completed', detail: 'accepted RSI report' } })
  await expect(linkRsiMemory(h.apparatus, h.ctx.sessions,
    { sessionId: String(h.agent.id), previousRootId: 'root' })).rejects.toThrow('before the new business root starts')
  expect(await rsiMemorySourceOf(h.apparatus, previousId)).toBeUndefined()
})

it('discovers every descendant checkpoint from the root, pages references, and reads narratives only by choice', async () => {
  const h = await globalFixture(), calls = h.adapter.requests.length
  const before = new Map(await Promise.all([...h.native].map(async ([id, agent]) => [id, await durableEvents(h.ctx, agent)] as const)))
  const first = await memoryDirectory(h.apparatus, h.rootId, { count: 2 })
  expect(first).toMatchObject({ inherited: null, from: 0, total: 4, nextFrom: 2 })
  const second = await memoryDirectory(h.apparatus, h.rootId, { from: first.nextFrom!, count: 2 })
  expect(second).toMatchObject({ from: 2, total: 4, nextFrom: null })
  const entries = [...first.entries, ...second.entries]
  expect(entries.map(entry => entry.preparedFor.kind === 'task' ? entry.preparedFor.taskId : 'review')).toEqual(['left', 'right', 'leaf', 'nephew'])
  expect(entries[2]).toMatchObject({ source: { kind: 'task', id: 'left', sessionId: String(h.native.get('left')!.session.id) } })
  expect(entries.every(entry => entry.currentRun && entry.runStatus === 'running')).toBe(true)
  expect(JSON.stringify(entries)).not.toContain(draft.decisions[0])
  const selected = await readMemoryForAgent(h.apparatus, h.rootId, { ref: entries[2]!.ref })
  expect(selected.checkpoint).toEqual(await readParentMemory(h.ctx.sessionPersistence, h.refs.get('leaf')!))
  expect(h.adapter.requests).toHaveLength(calls)
  for (const [id, agent] of h.native) {
    const after = await durableEvents(h.ctx, agent)
    expect(after).toEqual(before.get(id))
  }
})

it('lets a worker discover siblings and its descendants without exposing a sibling descendant or another root', async () => {
  const h = await globalFixture(), foreignRoot = await h.addTask('other-root')
  await h.addTask('foreign', 'other-root')
  const foreign = await h.checkpoint('foreign', 'other-root')
  const left = h.tasks.get('left')!
  h.tasks.set('left', { ...left, contract: { ...left.contract!, inputs: [
    { name: 'foreign.txt', source: { kind: 'artifact', taskId: 'foreign' } },
  ] } })
  const directory = await memoryDirectory(h.apparatus, h.leftId)
  expect(directory.inherited).toBe(h.refs.get('left')!.memoryId)
  expect(directory.entries.map(entry => entry.preparedFor.kind === 'task' ? entry.preparedFor.taskId : 'review')).toEqual(['left', 'right', 'leaf'])
  await expect(readMemoryForAgent(h.apparatus, h.leftId, { ref: h.refs.get('nephew')!.memoryId })).rejects.toThrow('outside this memory scope')
  for (const caller of [h.rootId, h.leftId])
    await expect(readMemoryForAgent(h.apparatus, caller, { ref: foreign.memoryId })).rejects.toThrow('outside this memory scope')
  expect((await memoryDirectory(h.apparatus, foreignRoot)).entries.map(entry => entry.ref)).toEqual([foreign.memoryId])
})

it('lets an improvement audit discover its subject and evaluation branches while retaining root and review boundaries', async () => {
  const h = await globalFixture(), audit = await h.addTask('improve'), improvement = h.tasks.get('improve')!
  const improveRun = improvement.runs['improve-run']!
  h.tasks.set('improve', { ...improvement, runs: { [improveRun.runId]: { ...improveRun, purpose: 'improve',
    relatedTo: { taskId: 'root', runId: 'root-run' } } } })
  await h.addTask('evaluation')
  const evaluation = h.tasks.get('evaluation')!, evaluationRun = evaluation.runs['evaluation-run']!
  h.tasks.set('evaluation', { ...evaluation, runs: { [evaluationRun.runId]: { ...evaluationRun, purpose: 'evaluation',
    relatedTo: { taskId: 'improve', runId: 'improve-run' } } } })
  await h.addTask('evaluation-child', 'evaluation')
  const trial = await h.checkpoint('evaluation-child', 'evaluation')
  await h.addTask('unrelated')
  await h.addTask('unrelated-child', 'unrelated')
  const unrelated = await h.checkpoint('unrelated-child', 'unrelated')
  await h.addReview('review')
  await h.addTask('review-child', 'review')
  const review = await h.checkpoint('review-child', 'review')
  const directory = await memoryDirectory(h.apparatus, audit)
  expect(directory.entries.map(entry => entry.ref)).toEqual([...h.refs.values()].map(ref => ref.memoryId).concat(trial.memoryId))
  expect((await readMemoryForAgent(h.apparatus, audit, { ref: trial.memoryId })).checkpoint?.scope)
    .toMatchObject({ taskId: 'evaluation-child' })
  for (const ref of [unrelated.memoryId, review.memoryId])
    await expect(readMemoryForAgent(h.apparatus, audit, { ref })).rejects.toThrow('outside this memory scope')
})

it('keeps independent review and evidence descendants within their own review memory lineage', async () => {
  const h = await globalFixture(), reviewer = await h.addReview('review')
  const evidence = await h.addTask('review-evidence', 'review')
  await h.addTask('review-descendant', 'review-evidence')
  const reviewRef = await h.checkpoint('review-evidence', 'review')
  const descendantRef = await h.checkpoint('review-descendant', 'review-evidence')
  await h.addReview('other-review')
  await h.addTask('other-evidence', 'other-review')
  const otherRef = await h.checkpoint('other-evidence', 'other-review')
  for (const caller of [reviewer, evidence]) {
    const directory = await memoryDirectory(h.apparatus, caller)
    expect(directory.entries.map(entry => entry.ref)).toEqual([reviewRef.memoryId, descendantRef.memoryId])
    expect(directory.entries[0]!.source).toMatchObject({ kind: 'review', id: 'review' })
    await expect(readMemoryForAgent(h.apparatus, caller, { ref: h.refs.get('left')!.memoryId })).rejects.toThrow('outside this memory scope')
    await expect(readMemoryForAgent(h.apparatus, caller, { ref: otherRef.memoryId })).rejects.toThrow('outside this memory scope')
  }
  await expect(readMemoryForAgent(h.apparatus, h.rootId, { ref: reviewRef.memoryId })).rejects.toThrow('outside this memory scope')
})

it('labels historical checkpoints with their actual Run status and chooses the latest inherited Run', async () => {
  const h = await globalFixture(), left = h.tasks.get('left')!, old = left.runs['left-run']!
  const next: RunState = { ...old, runId: 'left-retry', status: 'running' }
  h.tasks.set('left', { ...left, runs: { 'left-run': { ...old, status: 'failed', failureReason: 'retry required' }, 'left-retry': next } })
  const retry = await h.checkpoint('left', 'root', next.runId)
  const directory = await memoryDirectory(h.apparatus, h.leftId)
  expect(directory.inherited).toBe(retry.memoryId)
  expect(directory.entries.filter(entry => entry.preparedFor.kind === 'task' && entry.preparedFor.taskId === 'left'))
    .toMatchObject([{ runStatus: 'failed', currentRun: false }, { runStatus: 'running', currentRun: true }])
  expect((await readMemoryForAgent(h.apparatus, h.leftId, { ref: h.refs.get('left')!.memoryId })).checkpoint?.scope)
    .toMatchObject({ runId: 'left-run' })
})

it('reconstructs the global directory from native persistence after a cold reopen', async () => {
  const h = await globalFixture(), before = await memoryDirectory(h.apparatus, h.rootId)
  const expected = await readMemoryForAgent(h.apparatus, h.rootId, { ref: h.refs.get('leaf')!.memoryId })
  await h.ctx.fiber.dispose(); contexts.splice(contexts.indexOf(h.ctx), 1)
  const restored = new Context(); contexts.push(restored)
  await restored.plugin(SessionStore)
  await restored.plugin(JsonlPersistence, { root: join(h.root, 'sessions'), compression: 'none' })
  const apparatus = { ...h.apparatus, persistence: restored.sessionPersistence }
  expect(await memoryDirectory(apparatus, h.rootId)).toEqual(before)
  expect(await readMemoryForAgent(apparatus, h.rootId, { ref: h.refs.get('leaf')!.memoryId })).toEqual(expected)
})

it('retains checkpoints from the original parent session after responsibility transfers to another native agent', async () => {
  const h = await globalFixture(), before = await memoryDirectory(h.apparatus, h.rootId)
  const replacement = await h.addTask('replacement')
  h.tasks.delete('replacement')
  const left = h.tasks.get('left')!, previous = left.responsibility!
  const body = { protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'task/reassigned', subject: 'left',
    commandId: 'transfer-left', emitter: 'agent', actor: previous.agentIdentity, at: '2026-10-15T00:00:00.000Z',
    seq: 0, prevDigest: null, payload: { from: previous.agentId, agentId: replacement, agentIdentity: `identity:${replacement}` } }
  h.facts.push({ ...body, digest: digestOf(body) })
  h.tasks.set('left', { ...left, responsibility: { agentId: replacement, agentIdentity: `identity:${replacement}`, assignedAt: body.at } })
  expect(await memoryDirectory(h.apparatus, h.rootId)).toEqual(before)
  expect((await memoryDirectory(h.apparatus, replacement)).inherited).toBe(h.refs.get('left')!.memoryId)
  const leaf = await memoryDirectory(h.apparatus, h.leafId)
  expect(leaf.inherited).toBe(h.refs.get('leaf')!.memoryId)
  const detail = await readMemoryForAgent(h.apparatus, h.leafId, { ref: leaf.inherited! })
  expect(detail.entry?.source).toMatchObject({ kind: 'task', id: 'left', sessionId: String(h.native.get('left')!.session.id) })
  expect(detail.checkpoint).toEqual(await readParentMemory(h.ctx.sessionPersistence, h.refs.get('leaf')!))
})

it('validates the original native source when a globally discovered checkpoint is read', async () => {
  const h = await globalFixture(), ref = h.refs.get('leaf')!
  const events = structuredClone(await durableEvents(h.ctx, h.native.get('left')!)), event = events[ref.eventSeq]!
  if (event.type !== 'singularity/parent-memory') throw new Error('missing global checkpoint')
  Object.assign(event.data.checkpoint.sources.at(-1)!, { digest: 'f'.repeat(64) })
  const persistence = { open: async (sessionId: string, mode: string) => String(sessionId) === ref.sessionId
    ? { read: async () => ({ events }), close: async () => undefined }
    : h.ctx.sessionPersistence.open(SessionId(sessionId), mode as 'read') } as unknown as Context['sessionPersistence']
  const apparatus = { ...h.apparatus, persistence }
  expect((await memoryDirectory(apparatus, h.rootId)).entries.some(entry => entry.ref === ref.memoryId)).toBe(true)
  await expect(readMemoryForAgent(apparatus, h.rootId, { ref: ref.memoryId })).rejects.toThrow('session prefix')
})

it('rejects invalid memory queries and an assigned child whose inherited background was not prepared', async () => {
  const h = await globalFixture()
  for (const input of [{ from: -1 }, { from: 1.5 }, { count: 0 }, { count: 101 }, { ref: '' }, { ref: 'checkpoint', from: 0 }])
    await expect(readMemoryForAgent(h.apparatus, h.rootId, input)).rejects.toThrow('memory accepts')
  expect(await memoryDirectory(h.apparatus, h.rootId, { from: 99 })).toMatchObject({ entries: [], nextFrom: null, total: 4 })
  const unprepared = await h.addTask('unprepared', 'left')
  await expect(readMemoryForAgent(h.apparatus, unprepared)).rejects.toThrow('parent memory has not been prepared')
})

