/**
 * A4 delivery acceptance (plan §F.1, second sub-goal) on a real deployment
 * skeleton: the real `AgentLoop` with the real durable Inbox, the real
 * `session-persistence-jsonl` bytes, the real `SessionStore`, the real
 * `SessionQueryEngine`, and the real `AgentRuntime` service — the three entry
 * points A4's third sub-goal calls.
 *
 * What is replaced, and why:
 * - **the model** — one scripted adapter answers every request with a text block
 *   and ends its turn. A real turn is exactly what "the target's driver consumed
 *   the message" needs, and the model's words are not the subject;
 * - **the graph/layout/preset planes** — the delivery path never touches them
 *   (it reads Sessions, not graphs), so they are minimal stand-ins carrying the
 *   seams `AgentRuntime`'s constructor and `inject` list name.
 *
 * The crash points are states of the *durable artifact*, produced the way the
 * deployment produces them and read back by a second boot over the same
 * directory (the shape `a3-recovery.spec.ts` established). Where a killed
 * process's lost write buffer is the difference between two states, the fixture
 * removes those bytes from the artifact and says so at the drop site.
 *
 * What is asserted is always the artifact's own bytes — never a live buffer:
 * `durableCopies` folds them itself, independently of the module under test.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { SessionId, SESSION_FORMAT_VERSION } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import type { SessionEvent } from '../../../../thirdparty/deepseek-harness/packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../../../thirdparty/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import SessionQueryEngine from '../../../../thirdparty/deepseek-harness/packages/session-query/session-query/lib/index.js'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '../../../../thirdparty/deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import { LlmAdapter, ToolCallId, createUserMessage } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '../../../../thirdparty/deepseek-harness/packages/llm/llm/lib/index.js'
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { AgentRuntime } from '../../agent-runtime/src/index.ts'
import {
  MessageDeliveryRefusal,
  ensureAgentMessageDelivered,
  questionMessageText,
  readToolCallBody,
  reconcileAgentMessageDeliveries,
} from '../../agent-runtime/src/messages.ts'
import type { AgentMessageIntent, MessageDeliveryDeps } from '../../agent-runtime/src/messages.ts'

const PROVIDER = 'fake'
const MODEL = 'fake-1'
const PARENT = 's-parent'
const SENDER = 's-child'
const QUESTION_ID = 'q-abc'
const MESSAGE_ID = 'm-question-abc'

/** One scripted model: every request is answered with one text block and a finished turn. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'noted' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'noted' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * The real query engine over the real log. Only the two full-text search faces
 * are refused: they are a different subject (and need an index backend), while
 * every exact read this spec relies on is the shipped implementation.
 */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not part of this fixture'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not part of this fixture'))
  }
}

/** The driver-owned claim the production loop performs before a request is assembled. */
interface ClaimingInbox {
  claim(target: InboxTarget, turn: number): UserMessage[]
}

/** One boot of the deployment skeleton over one directory; a second boot over it is a restart. */
class Boot {
  private constructor(
    readonly dir: string,
    readonly ctx: Context,
    private readonly harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>,
    /** Every handle this process took, so a crash releases exactly what a dying process's descriptors would. */
    private readonly handles: { close: () => Promise<void> }[],
  ) {}

  static async open(dir: string): Promise<Boot> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    // The real backend the deployment mounts; every restart re-reads its bytes.
    const persistence = new JsonlSessionPersistence(ctx, { root: dir, compression: 'none' })
    const handles: { close: () => Promise<void> }[] = []
    const backend = persistence as unknown as {
      create: (...args: never[]) => Promise<{ close: () => Promise<void> }>
      open: (...args: never[]) => Promise<{ close: () => Promise<void> }>
    }
    const originalCreate = backend.create.bind(persistence)
    const originalOpen = backend.open.bind(persistence)
    backend.create = async (...args: never[]) => {
      const handle = await originalCreate(...args)
      handles.push(handle)
      return handle
    }
    backend.open = async (...args: never[]) => {
      const handle = await originalOpen(...args)
      handles.push(handle)
      return handle
    }
    ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter())
    await ctx.plugin(TestSessionQuery)
    const harness = await mountAgentLoopTestHarness(ctx)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: PROVIDER, model: MODEL }) })
    ctx.provide('agentPresets', { defaultId: 'standard', mount: async () => {}, resolve: async () => ({}) })
    ctx.provide('permissionPresets', { set: () => {}, resolve: () => ({}) })
    ctx.provide('layout', { setIn: async () => {} })
    ctx.provide('graph', {
      snapshotIn: async () => ({ version: 1, id: 'g', roots: [], agents: [], groups: [], edges: [] }),
      commitIn: async () => {},
      setStatusIn: async () => {},
      addAgentIn: async () => {},
    })
    new AgentRuntime(ctx)
    return new Boot(dir, ctx, harness, handles)
  }

  /** Create one live Session, the way a spawn does. */
  async create(sessionId: string): Promise<Agent> {
    return await this.harness.create(SessionId(sessionId), { provider: PROVIDER, model: MODEL })
  }

  /**
   * Create one live Session and materialize its artifact, so a restart finds a
   * Session that existed rather than one that was never written at all.
   */
  async createDurable(sessionId: string): Promise<Agent> {
    const agent = await this.create(sessionId)
    await this.ctx.sessions.flush(agent.session)
    return agent
  }

  /** Bring one persisted Session back live — what the recovery path does before it retries delivery. */
  async resume(sessionId: string): Promise<Agent> {
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: { provider: PROVIDER, model: MODEL },
    })
    return handle.agent
  }

  /** The durable artifact one Session owns: the bytes a second boot would read. */
  artifact(sessionId: string): string {
    const suffix = join(sessionId, `session.v${SESSION_FORMAT_VERSION}.jsonl`)
    const found = readdirSync(this.dir, { recursive: true })
      .map(entry => join(this.dir, String(entry)))
      .find(path => path.endsWith(suffix))
    if (found === undefined) throw new Error(`no artifact for session "${sessionId}" under ${this.dir}`)
    return found
  }

  /** An orderly shutdown: every handle drains, so the artifact is what a tidy process leaves. */
  async close(): Promise<void> {
    await this.ctx.fiber.dispose()
  }

  /**
   * A process that died: the durability barrier runs for every live Session,
   * then every descriptor the store held is released. The context itself is not
   * disposed — a driver parked on a promise that will never settle is exactly
   * the state a killed process leaves, and disposing would wait for it.
   */
  async crash(): Promise<void> {
    for (const session of this.ctx.sessions.list()) await this.ctx.sessions.flush(session)
    for (const handle of this.handles.splice(0)) await handle.close()
  }

  /** Park every model request after the claimed batch left the inbox and before history takes it. */
  parkRequests(): { claimed: Promise<void>; release: () => void } {
    const gate = Promise.withResolvers<void>()
    const claim = Promise.withResolvers<void>()
    this.ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      await gate.promise
      return next()
    })
    this.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      if (agent.id === SessionId(PARENT) && message.id === MESSAGE_ID) claim.resolve()
    })
    return { claimed: claim.promise, release: () => gate.resolve() }
  }
}

/**
 * One identity's durable copies in a Session's artifact, folded from the bytes
 * alone: model-visible history entries, and the pending inbox entries the splices
 * still describe. The fold is the test's own, so a module that duplicated a
 * delivery shows up as two.
 */
function durableCopies(artifact: string, messageId: string): { history: number; pending: number } {
  const inbox: Record<InboxTarget, string[]> = { 'next-turn': [], 'next-step': [] }
  let history = 0
  for (const line of readFileSync(artifact, 'utf8').split('\n')) {
    if (line === '') continue
    const event = JSON.parse(line) as SessionEvent
    if (event.type === 'user/message') {
      if ((event as SessionEvent & { type: 'user/message' }).data.id === messageId) history += 1
      continue
    }
    if (event.type !== 'agent/inbox/spliced') continue
    const splice = (event as SessionEvent & { type: 'agent/inbox/spliced' }).data
    inbox[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted.map(message => String(message.id)))
  }
  return {
    history,
    pending: [...inbox['next-turn'], ...inbox['next-step']].filter(id => id === messageId).length,
  }
}

/** How many durable copies of one identity a Session's artifact holds, in any form. */
function copyCount(artifact: string, messageId: string): number {
  const copies = durableCopies(artifact, messageId)
  return copies.history + copies.pending
}

/** The single history entry one identity has in a Session's artifact. */
function historyEntry(artifact: string, messageId: string): UserMessage | undefined {
  for (const line of readFileSync(artifact, 'utf8').split('\n')) {
    if (line === '') continue
    const event = JSON.parse(line) as SessionEvent
    if (event.type === 'user/message' && (event as SessionEvent & { type: 'user/message' }).data.id === messageId) {
      return (event as SessionEvent & { type: 'user/message' }).data as UserMessage
    }
  }
  return undefined
}

/**
 * Drop every event line, keeping the header: what a killed process leaves when
 * its appends were still only in the write buffer that died with it.
 */
function dropEventLines(artifact: string): void {
  const header = readFileSync(artifact, 'utf8').split('\n')[0] ?? ''
  writeFileSync(artifact, `${header}\n`)
}

const dirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-a4-delivery-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The intent one recorded question yields: the store's identity, the two Sessions, and the body. */
function questionIntent(overrides: Partial<AgentMessageIntent> = {}): AgentMessageIntent {
  return {
    targetSessionId: SessionId(PARENT),
    senderSessionId: SessionId(SENDER),
    messageId: MESSAGE_ID,
    text: questionMessageText(QUESTION_ID, 'which contract holds?'),
    ...overrides,
  }
}

/** The service's own dependency set, with any capability replaceable — the fault-injection seam of a crash. */
function depsOf(boot: Boot, overrides: Partial<MessageDeliveryDeps> = {}): MessageDeliveryDeps {
  return {
    agents: boot.ctx.agents,
    sessions: boot.ctx.sessions,
    sessionQuery: boot.ctx.sessionQuery,
    ...overrides,
  }
}

/** One refusal raised by an attempt, or `undefined` when it settled. */
async function refusalOf(attempt: Promise<unknown>): Promise<MessageDeliveryRefusal | undefined> {
  const outcome = await attempt.then(() => undefined, (error: unknown) => error)
  if (outcome === undefined) return undefined
  expect(outcome).toBeInstanceOf(MessageDeliveryRefusal)
  return outcome as MessageDeliveryRefusal
}

describe('quoted body source (A4-4)', () => {
  it('reads back a real flushed tool/call from the sending Session', async () => {
    const boot = await Boot.open(workspace())
    const sender = await boot.create(SENDER)
    const body = JSON.stringify({ requestKey: 'k-1', question: 'which contract holds?', blocking: true })
    const seq = sender.session.seq
    sender.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-1'),
      name: 'task_ask_parent',
      arguments: body,
    })

    await expect(boot.ctx.agentRuntime.readToolCallBody({ sessionId: SessionId(SENDER), seq }))
      .resolves.toEqual({ name: 'task_ask_parent', arguments: body })
    await boot.close()
  })

  it('refuses a forged Session id, an out-of-range seq, and an event that is not a tool call, by name', async () => {
    const boot = await Boot.open(workspace())
    const sender = await boot.create(SENDER)
    const callSeq = sender.session.seq
    sender.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: ToolCallId('call-1'),
      name: 'task_ask_parent',
      arguments: '{}',
    })
    const textSeq = sender.session.seq
    sender.session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: 'not a call' }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )

    const cases = [
      { ref: { sessionId: SessionId('s-nowhere'), seq: 0 }, code: 'source-session-missing' },
      { ref: { sessionId: SessionId(SENDER), seq: callSeq + 7 }, code: 'source-event-missing' },
      { ref: { sessionId: SessionId(SENDER), seq: textSeq }, code: 'source-not-tool-call' },
    ]

    for (const one of cases) {
      const refusal = await refusalOf(boot.ctx.agentRuntime.readToolCallBody(one.ref))
      expect(refusal?.code).toBe(one.code)
    }
    await boot.close()
  })

  it('refuses to witness a Session that has no durability barrier at all', async () => {
    // A deployment without a session-persistence backend: the Session is live and
    // holds the event, but nothing can say the bytes are durable.
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter())
    const harness = await mountAgentLoopTestHarness(ctx)
    const sender = await harness.create(SessionId(SENDER), { provider: PROVIDER, model: MODEL })
    const seq = sender.session.seq
    sender.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'task_ask_parent', arguments: '{}' })

    const refusal = await refusalOf(readToolCallBody(
      { agents: ctx.agents, sessions: ctx.sessions, sessionQuery: ctx.sessionQuery },
      { sessionId: SessionId(SENDER), seq },
    ))

    expect(refusal?.code).toBe('source-not-durable')
    await ctx.fiber.dispose()
  })
})

describe('delivery to a live target', () => {
  it('delivers once, reports already-present on a repeat, and the target ends with exactly one copy', async () => {
    const boot = await Boot.open(workspace())
    const parent = await boot.create(PARENT)

    const first = await boot.ctx.agentRuntime.ensureAgentMessageDelivered(questionIntent())
    expect(first.status).toBe('delivered')
    // The target's own driver consumes the pending message into history, so the
    // repeat meets an identity that no longer sits in any inbox — the case DSH's
    // own pending-id check cannot catch.
    await parent.whenIdle()
    const second = await boot.ctx.agentRuntime.ensureAgentMessageDelivered(questionIntent())

    expect(second.status).toBe('already-present')
    expect(durableCopies(boot.artifact(PARENT), MESSAGE_ID)).toEqual({ history: 1, pending: 0 })
    await boot.close()
  })

  it('keeps a second delivery from landing while the first is still pending', async () => {
    const boot = await Boot.open(workspace())
    // A target whose driver is busy (a maintenance task) does not consume the
    // pending message: the durable state stays visible as one pending entry.
    const parent = await boot.create(PARENT)
    void parent.runMaintenance(() => new Promise(() => {}))
    const first = await boot.ctx.agentRuntime.ensureAgentMessageDelivered(questionIntent())
    const second = await boot.ctx.agentRuntime.ensureAgentMessageDelivered(questionIntent())

    expect(first.status).toBe('delivered')
    expect(second.status).toBe('already-present')
    expect(durableCopies(boot.artifact(PARENT), MESSAGE_ID)).toEqual({ history: 0, pending: 1 })
    await boot.crash()
  })

  it('attributes the delivered message to the sending Session, never to a person', async () => {
    const boot = await Boot.open(workspace())
    const parent = await boot.create(PARENT)
    await boot.ctx.agentRuntime.ensureAgentMessageDelivered(questionIntent())
    await parent.whenIdle()

    const delivered = historyEntry(boot.artifact(PARENT), MESSAGE_ID)

    expect(delivered?.source).toEqual({ kind: 'agent-message', form: 'relay', senderSessionId: SENDER })
    expect(delivered?.content).toEqual([{ type: 'text', text: questionMessageText(QUESTION_ID, 'which contract holds?') }])
    await boot.close()
  })

  it('reports unavailable with zero durable side effects when no live agent owns the target', async () => {
    const dir = workspace()
    const first = await Boot.open(dir)
    await first.createDurable(PARENT)
    await first.close()
    const artifact = first.artifact(PARENT)
    const before = readFileSync(artifact, 'utf8')

    const second = await Boot.open(dir)
    const delivery = await second.ctx.agentRuntime.ensureAgentMessageDelivered(questionIntent())

    expect(delivery.status).toBe('unavailable')
    expect(readFileSync(artifact, 'utf8')).toBe(before)
    await second.close()
  })
})

describe('recovery reconciliation across the four crash points', () => {
  it('(1) delivers a committed intent that was never delivered', async () => {
    const dir = workspace()
    const first = await Boot.open(dir)
    await first.createDurable(PARENT)
    await first.close()

    const second = await Boot.open(dir)
    await second.resume(PARENT)

    await expect(second.ctx.agentRuntime.reconcileAgentMessageDeliveries([questionIntent()]))
      .resolves.toEqual([{ messageId: MESSAGE_ID, status: 'delivered' }])
    expect(copyCount(second.artifact(PARENT), MESSAGE_ID)).toBe(1)

    await second.close()
  })

  it('(2) delivers after an interrupted flush whose bytes never reached the disk', async () => {
    const dir = workspace()
    const first = await Boot.open(dir)
    const parent = await first.create(PARENT)
    // The process died inside the barrier: the relay really happened (the target's
    // own turn consumed the message below), the receipt never did.
    const refusal = await refusalOf(ensureAgentMessageDelivered(
      depsOf(first, {
        sessions: {
          get: (id: SessionId) => first.ctx.sessions.get(id),
          flush: async () => { throw new Error('the process died inside the barrier') },
        },
      }),
      questionIntent(),
    ))
    expect(refusal?.code).toBe('target-not-durable')
    await parent.whenIdle()
    await first.close()
    expect(durableCopies(first.artifact(PARENT), MESSAGE_ID)).toEqual({ history: 1, pending: 0 })
    // ...and the write buffer that held every one of those appends died with the process.
    dropEventLines(first.artifact(PARENT))

    const second = await Boot.open(dir)
    await second.resume(PARENT)

    await expect(second.ctx.agentRuntime.reconcileAgentMessageDeliveries([questionIntent()]))
      .resolves.toEqual([{ messageId: MESSAGE_ID, status: 'delivered' }])
    expect(copyCount(second.artifact(PARENT), MESSAGE_ID)).toBe(1)

    await second.close()
  })

  it('(3) does not redeliver after the inbox append was flushed and the process died', async () => {
    const dir = workspace()
    const first = await Boot.open(dir)
    // A target whose driver is busy when the delivery lands: the flushed inbox
    // append is the durable state the crash leaves behind.
    const parent = await first.create(PARENT)
    void parent.runMaintenance(() => new Promise(() => {}))
    expect((await first.ctx.agentRuntime.ensureAgentMessageDelivered(questionIntent())).status).toBe('delivered')
    await first.crash()
    expect(durableCopies(first.artifact(PARENT), MESSAGE_ID)).toEqual({ history: 0, pending: 1 })

    const second = await Boot.open(dir)
    const resumed = await second.resume(PARENT)

    await expect(second.ctx.agentRuntime.reconcileAgentMessageDeliveries([questionIntent()]))
      .resolves.toEqual([{ messageId: MESSAGE_ID, status: 'already-present' }])
    // The pending message survived the restart exactly once, and the resumed
    // Session's own inbox is the record that says so.
    expect(resumed.inbox.nextStep.map(message => message.id)).toEqual([MESSAGE_ID])
    expect(durableCopies(second.artifact(PARENT), MESSAGE_ID)).toEqual({ history: 0, pending: 1 })

    await second.close()
  })

  it('(4) redelivers after the target claimed the message and history never took it', async () => {
    const dir = workspace()
    const first = await Boot.open(dir)
    const parent = await first.create(PARENT)
    // The production driver's claim: pending input leaves the inbox before the
    // request is assembled, and `user/message` is written only after assembly. The
    // parked request is the process dying inside that window.
    const parked = first.parkRequests()
    expect((await first.ctx.agentRuntime.ensureAgentMessageDelivered(questionIntent())).status).toBe('delivered')
    await parked.claimed
    await first.crash()
    expect(durableCopies(first.artifact(PARENT), MESSAGE_ID)).toEqual({ history: 0, pending: 0 })

    const second = await Boot.open(dir)
    const resumed = await second.resume(PARENT)

    await expect(second.ctx.agentRuntime.reconcileAgentMessageDeliveries([questionIntent()]))
      .resolves.toEqual([{ messageId: MESSAGE_ID, status: 'delivered' }])

    // The redelivered message is what the resumed target now consumes.
    await resumed.whenIdle()
    expect(durableCopies(second.artifact(PARENT), MESSAGE_ID)).toEqual({ history: 1, pending: 0 })

    await second.close()
  })

  it('reports one refused record without losing the others in the same pass', async () => {
    const dir = workspace()
    const first = await Boot.open(dir)
    await first.createDurable(PARENT)
    await first.close()

    const second = await Boot.open(dir)
    await second.resume(PARENT)
    const reports = await second.ctx.agentRuntime.reconcileAgentMessageDeliveries([
      questionIntent({ messageId: 'm-one', text: questionMessageText('q-one', 'first?') }),
      questionIntent({ targetSessionId: SessionId('s-absent'), messageId: 'm-two', text: questionMessageText('q-two', 'second?') }),
      questionIntent({ messageId: 'm-three', text: questionMessageText('q-three', 'third?') }),
    ])

    expect(reports).toEqual([
      { messageId: 'm-one', status: 'delivered' },
      { messageId: 'm-two', status: 'unavailable' },
      { messageId: 'm-three', status: 'delivered' },
    ])
    await second.close()
  })

  it('refuses by name, rather than pretending, when the deployment stores no Session bytes at all', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter())
    await ctx.plugin(TestSessionQuery)
    const harness = await mountAgentLoopTestHarness(ctx)
    await harness.create(SessionId(PARENT), { provider: PROVIDER, model: MODEL })

    const reports = await reconcileAgentMessageDeliveries(
      { agents: ctx.agents, sessions: ctx.sessions, sessionQuery: ctx.sessionQuery },
      [questionIntent()],
    )

    expect(reports).toHaveLength(1)
    expect(reports[0]?.status).toBe('refused')
    expect(reports[0]?.reason).toContain('has no durability barrier')
    await ctx.fiber.dispose()
  })
})
