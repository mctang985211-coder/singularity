import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { ToolRuntime, defineTool, type ToolExecutionInput, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { createExecution, type Admission, type TurnFailure } from '../src/execution.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function harness(admission: Admission = () => undefined, onTurnFailure: (failure: TurnFailure) => void = () => undefined) {
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => undefined })
  const agents = new AgentRegistry(ctx)
  const tools = new ToolRuntime(ctx)
  const sessions = new SessionStore(ctx)
  const session = sessions.create(SessionId('root'))
  const agent = { id: session.id, session, ctx } as unknown as Agent
  const leave = agents.enter(agent, undefined)
  const execution = createExecution(ctx, admission, onTurnFailure)
  const input = (name: string, callId: string, extra: Partial<ToolExecutionInput> = {}): ToolExecutionInput => ({
    name, callId: ToolCallId(callId), arguments: {}, agent, signal: new AbortController().signal, ...extra,
  })
  const register = (name: string, execute: (exec: ToolRunContext) => Promise<string>) => tools.register(defineTool({
    name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (_args, exec) => execute(exec),
  }))
  return { ctx, agents, sessions, session, tools, agent, execution, input, register, leave }
}

describe('the DSH execution port', () => {
  it('forwards agent runtime errors through the failure port once per exact live turn', async () => {
    const failures: TurnFailure[] = []
    const h = harness(undefined, failure => { failures.push(failure) })
    h.session.append('turn/start', { turn: 1 })
    h.ctx.emit('agent/error', { agent: h.agent, turn: 1, step: 0, error: new Error('checkpoint flush failed') })
    expect(failures).toHaveLength(1)
    h.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'checkpoint flush failed' } } })
    h.ctx.emit('agent/error', { agent: { ...h.agent }, turn: 2, step: 0, error: new Error('stale agent') })
    expect(failures).toMatchObject([{ sessionId: 'root', turn: 1, reason: { kind: 'error', error: { message: 'checkpoint flush failed' } } }])
    await h.execution.close()
    h.ctx.emit('agent/error', { agent: h.agent, turn: 2, step: 0, error: new Error('after close') })
    expect(failures).toHaveLength(1)
  })

  it('forwards error and abort endings from the exact live agent session through one failure port', async () => {
    const failures: TurnFailure[] = []
    const h = harness(undefined, failure => { failures.push(failure) })
    h.session.append('turn/start', { turn: 1 })
    const error = { kind: 'error' as const, error: { message: 'stream_read_error', code: 'PI_AI_ERROR' } }
    const ended = h.session.append('turn/end', { turn: 1, reason: error })
    h.session.append('turn/start', { turn: 2 })
    const aborted = { kind: 'aborted' as const, reason: { kind: 'user' as const } }
    const cancelled = h.session.append('turn/end', { turn: 2, reason: aborted })
    expect(failures).toEqual([
      { sessionId: 'root', turn: 1, seq: Number(ended.seq), reason: error },
      { sessionId: 'root', turn: 2, seq: Number(cancelled.seq), reason: aborted },
    ])
    await h.execution.close()
  })

  it('does not turn unrelated sessions, normal endings, or replay repair markers into runtime failures', async () => {
    const failures: TurnFailure[] = []
    const h = harness(undefined, failure => { failures.push(failure) })
    const unrelated = h.sessions.create(SessionId('unrelated'))
    unrelated.append('turn/start', { turn: 1 })
    unrelated.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'other failure', code: 'UNKNOWN' } } })
    for (const [index, kind] of (['completed', 'blocked', 'max-tokens', 'interrupted', 'forked'] as const).entries()) {
      h.session.append('turn/start', { turn: index + 1 })
      h.session.append('turn/end', { turn: index + 1, reason: { kind } })
    }
    expect(failures).toEqual([])
    await h.execution.close()
    h.session.append('turn/start', { turn: 6 })
    h.session.append('turn/end', { turn: 6, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(failures).toEqual([])
  })

  it('rejects a stale session whose id now belongs to another registry agent', async () => {
    const failures: TurnFailure[] = []
    const h = harness(undefined, failure => { failures.push(failure) })
    h.leave()
    const replacement = { ...h.agent, session: Session.create(h.session.id) } as Agent
    h.agents.enter(replacement, undefined)
    h.session.append('turn/start', { turn: 1 })
    h.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(failures).toEqual([])
    await h.execution.close()
  })

  it('removes the failure feed before its own cancellation drains borrowed work', async () => {
    const failures: TurnFailure[] = []
    const h = harness(undefined, failure => { failures.push(failure) })
    const started = deferred()
    h.session.append('turn/start', { turn: 1 })
    h.register('write', async exec => {
      h.execution.assertCaller(exec)
      started.resolve()
      await new Promise<void>(resolve => exec.signal.addEventListener('abort', () => {
        h.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
        resolve()
      }, { once: true }))
      return 'write'
    })
    const pending = h.tools.execute(h.input('write', 'write'))
    await started.promise
    await h.execution.close()
    await pending
    expect(failures).toEqual([])
  })

  it('accepts the exact registry agent and rejects a replacement object with the same identity', async () => {
    const h = harness()
    h.register('bind', async exec => {
      expect(h.execution.assertCaller(exec)).toBe(h.agent)
      expect(() => h.execution.assertCaller({ ...exec, agent: { ...h.agent } })).toThrow('unknown-emitter-role')
      expect(() => h.execution.assertCaller({ ...exec, agent: undefined } as unknown as ToolRunContext)).toThrow('unknown-emitter-role')
      return 'bound'
    })
    expect((await h.tools.execute(h.input('bind', 'bind'))).isError).toBe(false)
    await h.execution.close()
  })

  it('checks the committed admission decision after policy and leaves read calls available', async () => {
    let submitted = false
    const h = harness(exec => submitted && exec.name !== 'status' ? 'run admission is closed' : undefined)
    const calls: string[] = []
    h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    for (const name of ['write', 'status']) h.register(name, async exec => { h.execution.assertCaller(exec); calls.push(name); return name })
    expect((await h.tools.execute(h.input('write', 'before'))).isError).toBe(false)
    submitted = true
    const denied = await h.tools.execute(h.input('write', 'after'))
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{ type: 'text', text: expect.stringContaining('run admission is closed') }])
    expect((await h.tools.execute(h.input('status', 'status'))).isError).toBe(false)
    expect(calls).toEqual(['write', 'status'])
    await h.execution.close()
  })

  it('refuses an earlier granted call that reaches dispatch after the run closes', async () => {
    let submitted = false
    const h = harness(() => submitted ? 'run admission is closed' : undefined)
    const granted = deferred()
    const continueDispatch = deferred()
    let wrote = false
    h.ctx.on('tools/execute', async (_exec, next) => { granted.resolve(); await continueDispatch.promise; return await next() }, { prepend: true })
    h.register('write', async () => { wrote = true; return 'write' })
    const pending = h.tools.execute(h.input('write', 'write'))
    await granted.promise
    submitted = true
    continueDispatch.resolve()
    expect((await pending).isError).toBe(true)
    expect(wrote).toBe(false)
    await h.execution.close()
  })

  it('drains a sibling execution without waiting for submit or its enclosing transport', async () => {
    const h = harness()
    const siblingStarted = deferred()
    const releaseSibling = deferred()
    const submitStarted = deferred()
    const submitDrained = deferred()
    h.register('write', async () => { siblingStarted.resolve(); await releaseSibling.promise; return 'write' })
    h.register('submit', async exec => {
      h.execution.assertCaller(exec)
      submitStarted.resolve()
      await h.execution.drain(exec)
      submitDrained.resolve()
      return 'submit'
    })
    h.register('transport', async exec => {
      const extra = { parent: exec.token, rootCallId: exec.rootCallId }
      const sibling = h.tools.execute(h.input('write', 'sibling', extra))
      await siblingStarted.promise
      const submit = h.tools.execute(h.input('submit', 'submit', extra))
      await submitStarted.promise
      const raced = await Promise.race([submitDrained.promise.then(() => 'drained'), Promise.resolve('still writing')])
      expect(raced).toBe('still writing')
      releaseSibling.resolve()
      await Promise.all([sibling, submit])
      return 'transport'
    })
    expect((await h.tools.execute(h.input('transport', 'transport'))).isError).toBe(false)
    await h.execution.close()
  })

  it('surfaces an in-flight dispatch failure to the submit that drains it', async () => {
    const h = harness()
    const started = deferred()
    const fail = deferred()
    const draining = deferred()
    h.ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'write') { started.resolve(); await fail.promise; throw new Error('dispatch drain failed') }
      return await next()
    })
    h.register('write', async () => 'unused')
    h.register('submit', async exec => {
      h.execution.assertCaller(exec)
      draining.resolve()
      await h.execution.drain(exec)
      return 'submit'
    })
    const writer = h.tools.execute(h.input('write', 'writer'))
    await started.promise
    const submitted = h.tools.execute(h.input('submit', 'submit'))
    await draining.promise
    fail.resolve()
    const [writeResult, submitResult] = await Promise.all([writer, submitted])
    expect([writeResult.isError, submitResult.isError]).toEqual([true, true])
    expect(submitResult.content).toEqual([{ type: 'text', text: expect.stringContaining('dispatch drain failed') }])
    await h.execution.close()
  })

  it('cancels and drains only granted work on close while the borrowed agent stays live', async () => {
    const h = harness()
    const started = deferred()
    let stopped = false
    h.register('write', async exec => {
      h.execution.assertCaller(exec)
      started.resolve()
      await new Promise<void>(resolve => exec.signal.addEventListener('abort', () => { stopped = true; resolve() }, { once: true }))
      return 'write'
    })
    const inFlight = h.tools.execute(h.input('write', 'write'))
    await started.promise
    const firstClose = h.execution.close()
    await firstClose
    expect(h.execution.close()).toBe(firstClose)
    expect(stopped).toBe(true)
    expect(h.agents.get(h.agent.id)).toBe(h.agent)
    expect((await inFlight).isError).toBe(true)
    expect(() => h.execution.assertCaller({ agent: h.agent } as ToolRunContext)).toThrow('illegal-transition')
  })
})
