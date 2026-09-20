import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'

export type HitlKind = 'ask' | 'approve'

export interface HitlPending {
  readonly id: string
  readonly kind: HitlKind
  readonly prompt: string
  readonly sessionId: string
  readonly createdAt: number
}

export type HitlAnswer =
  | { readonly kind: 'ask'; readonly text: string }
  | { readonly kind: 'approve'; readonly decision: 'approve' | 'reject' }

declare module '@deepseek-ai/cordis' {
  interface Context {
    hitl: HitlService
  }
  interface Events {
    'hitl/change'(pending: readonly HitlPending[]): void
  }
}

interface Waiter {
  readonly pending: HitlPending
  readonly resolve: (answer: HitlAnswer) => void
  readonly reject: (error: Error) => void
  readonly dispose: () => void
}

/**
 * The canvas answerer on the native interaction seams: root tools ask through
 * `ctx.userQuestions` / `ctx.approval` (audit events and fail-closed semantics
 * live there), and this service is the answerer that bridges those waterfalls
 * onto the pending-card store the canvas UI polls over `GET/POST
 * /singularity/hitl` and the `hitl/change` SSE. A card the canvas cannot
 * present faithfully (a multi-question batch) is delegated to `next()`, so the
 * native NO_PROVIDER / 'unavailable' fail-closed path stays intact.
 *
 * Both listeners are registered with `prepend`, ahead of every listener
 * already on the event. The gateway's mux forwarder (api-remotes) claims
 * `approval/request` by position and parks the request until a browser mux
 * client answers or delegates; with zero clients attached it never calls
 * `next()`, so a later listener never sees the request at all (guide §4.2
 * #17). Claiming first makes this service the decision surface either way;
 * the native answerer chain below it is untouched.
 */
export class HitlService extends Service {
  static inject = ['userQuestions', 'approval']

  private readonly waiters = new Map<string, Waiter>()
  private readonly lifetime = new AbortController()

  constructor(ctx: Context) {
    super(ctx, 'hitl')
    ctx.effect(() => () => this.lifetime.abort(new Error('hitl: service disposed')), 'hitl: waiters')
    ctx.on('user-questions/request', async (request, next) => {
      if (request.questions.length !== 1) return next()
      const question = request.questions[0]!
      const text = await this.enqueue(request.agent?.id ?? 'unknown', 'ask', question.question, request.signal)
      if (text.kind !== 'ask') throw new Error('hitl: expected ask answer')
      return { answers: [{ id: question.id, selected: [], custom: text.text }] }
    }, { prepend: true })
    ctx.on('approval/request', async request => {
      const prompt = request.reason ?? `Approve ${request.toolName}?`
      const answer = await this.enqueue(request.agent.id, 'approve', prompt, request.signal)
      if (answer.kind !== 'approve') throw new Error('hitl: expected approve answer')
      return answer.decision === 'approve' ? 'allowed-once' : 'rejected'
    }, { prepend: true })
  }

  list(): readonly HitlPending[] {
    return [...this.waiters.values()].map(w => w.pending)
  }

  answer(id: string, answer: HitlAnswer): void {
    const waiter = this.waiters.get(id)
    if (waiter === undefined) throw new Error(`hitl: unknown request "${id}"`)
    if (waiter.pending.kind !== answer.kind) {
      throw new Error(`hitl: kind mismatch for "${id}"`)
    }
    if (answer.kind === 'ask' && answer.text.trim().length === 0) {
      throw new Error('hitl: empty ask answer')
    }
    if (answer.kind === 'approve' && answer.decision !== 'approve' && answer.decision !== 'reject') {
      throw new Error('hitl: invalid approval decision')
    }
    waiter.dispose()
    this.waiters.delete(id)
    waiter.resolve(answer)
    this.ctx.emit('hitl/change', this.list())
  }

  private enqueue(sessionId: string, kind: HitlKind, prompt: string, callerSignal?: AbortSignal): Promise<HitlAnswer> {
    const signal = callerSignal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([callerSignal, this.lifetime.signal])
    signal.throwIfAborted()
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('hitl: missing session id')
    }
    const id = randomUUID()
    const pending: HitlPending = { id, kind, prompt, sessionId, createdAt: Date.now() }
    const abort = () => {
      this.waiters.get(id)!.reject(signal.reason)
      this.waiters.delete(id)
      this.ctx.emit('hitl/change', this.list())
    }
    const promise = new Promise<HitlAnswer>((resolve, reject) => {
      this.waiters.set(id, { pending, resolve, reject, dispose: () => signal.removeEventListener('abort', abort) })
      signal.addEventListener('abort', abort, { once: true })
    })
    this.ctx.emit('hitl/change', this.list())
    return promise.finally(() => signal.removeEventListener('abort', abort))
  }
}

export default HitlService
