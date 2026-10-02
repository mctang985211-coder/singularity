import { describe, expect, it, vi } from 'vitest'
import { defineTaskAnswerTool } from '../../src/tools/task-answer.ts'
import { defineTaskAskParentTool } from '../../src/tools/task-ask-parent.ts'
import { fixture } from './task-tools.fixture.ts'

/**
 * The two question tools from the tool side (A4 §F.1, sub-goal ③c): the schema
 * the model writes, the caller's own identity, the arguments the runtime entry
 * receives, and the answer rendered back.
 *
 * What these cases pin, and nothing else: no parameter names a recipient or an
 * authorization (identity is the caller's run and the store's parent relation),
 * the tool hands the runtime its *own* registration id as the citation and never
 * a body, a refusal from the runtime is rendered rather than thrown, and a
 * delivery that could not be made is reported as a retry rather than as a
 * failure. The store, the gate and the delivery are the runtime's, and are
 * covered where they live (`tests/integration/a4-question-*.spec.ts`).
 */
describe('task_ask_parent', () => {
  /** One question call as the loop dispatches it: the caller's own session and its own call id. */
  function questionExec(sessionId: string, callId = `call-${sessionId}-1`) {
    return { agent: { id: sessionId }, callId, signal: new AbortController().signal }
  }

  /** One stored question, as the store hands it back after an ask. */
  function asked(overrides: Record<string, unknown> = {}) {
    return {
      question: {
        questionId: 'q-abc',
        childRunId: 'r-worker',
        parentRunId: 'r-root',
        requestKey: 'k1',
        questionDigest: 'a'.repeat(64),
        questionRef: { sessionId: 's-worker', seq: 7 },
        messageId: 'm-question-abc',
        blocking: true,
        askedAt: '2026-09-25T00:00:00.000Z',
        ...overrides,
      },
      created: true,
      delivery: { messageId: 'm-question-abc', status: 'delivered' },
    }
  }

  /** The tool with the runtime entry stubbed to one outcome, and the spy every case asserts on. */
  async function askTool(outcome: unknown) {
    const { ctx } = await fixture()
    const ask = vi.fn(async () => outcome)
    ctx.taskRuntime.askParentQuestion = ask as never
    return { tool: defineTaskAskParentTool(ctx as never), ctx, ask }
  }

  it('declares exactly the three parameters of the fixed shape, and nothing that could name an addressee', () => {
    const tool = defineTaskAskParentTool(fixture().ctx as never)
    const parameters = tool.parameters as { properties: Record<string, { type?: unknown }>; required?: string[] }

    expect(Object.keys(parameters.properties).sort()).toEqual(['blocking', 'question', 'requestKey'])
    expect(parameters.required).toEqual(['requestKey', 'question'])
    expect(parameters.properties.blocking?.type).toBe('boolean')
    // The addressee is the store's derivation from the caller's own run, and the
    // authorization is the gate's: no name on this surface (and nothing in the
    // JSON schema the model is shown) may read as either.
    expect(
      Object.keys(parameters.properties).some(name =>
        /recipient|parent|target|^to$|run|session|auth|force/i.test(name),
      ),
    ).toBe(false)
    expect(JSON.stringify(parameters)).not.toContain('recipient')
  })

  it('refuses an undeclared key by name, before the runtime is called', async () => {
    const { tool, ask } = await askTool(asked())

    const result = (await tool.execute(
      { requestKey: 'k1', question: 'which contract holds?', recipient: 's-root' },
      questionExec('s-worker'),
    )) as string
    expect(result).toContain('task_ask_parent rejected: undeclared parameter "recipient"')
    expect(result).toContain('no argument that names a recipient')
    expect(result).toContain('Nothing was asked and nothing was sent')
    expect(ask).not.toHaveBeenCalled()
  })

  it("forwards its own call id and the model's arguments to the runtime, and never a body of its own", async () => {
    const { tool, ask } = await askTool(asked())
    await tool.execute(
      { requestKey: 'k1', question: 'which contract holds?', blocking: false },
      questionExec('s-worker', 'call-9'),
    )

    expect(ask).toHaveBeenCalledExactlyOnceWith('s-worker', { callId: 'call-9', requestKey: 'k1', blocking: false })
  })

  it("leaves an absent blocking declaration absent, so the protocol's own default is what gets recorded", async () => {
    const { tool, ask } = await askTool(asked())
    await tool.execute({ requestKey: 'k1', question: 'which contract holds?' }, questionExec('s-worker'))

    expect(ask).toHaveBeenCalledExactlyOnceWith('s-worker', { callId: 'call-s-worker-1', requestKey: 'k1' })
  })

  it('renders a blocking question as the wait it creates, with the identity the store recorded', async () => {
    const { tool } = await askTool(asked())
    const result = (await tool.execute(
      { requestKey: 'k1', question: 'which contract holds?' },
      questionExec('s-worker'),
    )) as string

    expect(result).toContain('question q-abc recorded for your direct parent (run r-root)')
    expect(result).toContain("message m-question-abc is in your parent's session")
    expect(result).toContain('This run is now blocked on that answer')
    expect(result).toContain('`task_submit_result` are refused until an answer with `resolves: true` is recorded')
    expect(result).toContain('Stop the work that would write and end this step')
    expect(result).toContain('The answer arrives as a message in this session and in your context')
  })

  it('renders a non-blocking question as no wait at all, and a repeat as the record already held', async () => {
    const { tool } = await askTool({
      ...asked({ blocking: false }),
      created: false,
      delivery: { messageId: 'm-question-abc', status: 'already-present' },
    })
    const result = (await tool.execute({ requestKey: 'k1', question: 'a note' }, questionExec('s-worker'))) as string

    expect(result).toContain("message m-question-abc was already in your parent's session, so nothing was sent twice")
    expect(result).toContain('This is the question the same request key already recorded, word for word')
    expect(result).toContain('This run is not blocked')
    expect(result).not.toContain('This run is now blocked')
  })

  it('reports an unreachable parent as a retry the recovery pass makes, never as a failure and never as "ask again"', async () => {
    const { tool } = await askTool({ ...asked(), delivery: { messageId: 'm-question-abc', status: 'unavailable' } })
    const result = (await tool.execute(
      { requestKey: 'k1', question: 'which contract holds?' },
      questionExec('s-worker'),
    )) as string

    expect(result).toContain('question q-abc recorded')
    expect(result).toContain(
      "message m-question-abc is not delivered yet: your parent's session is not live in this process",
    )
    expect(result).toContain('recovery delivers that same identity when the parent is back')
    expect(result).toContain('do not ask the same question again under a new request key')
  })

  it("reports a delivery that could not be settled with the runtime's own reason", async () => {
    const { tool } = await askTool({
      ...asked(),
      delivery: { messageId: 'm-question-abc', status: 'refused', reason: 'the question body could not be read back' },
    })
    const result = (await tool.execute(
      { requestKey: 'k1', question: 'which contract holds?' },
      questionExec('s-worker'),
    )) as string

    expect(result).toContain('could not be delivered (the question body could not be read back)')
    expect(result).toContain('The question is on the record')
  })

  it("renders the runtime's refusal instead of throwing it", async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.askParentQuestion = vi.fn(async () => {
      throw new Error(
        'task-runtime: task "t-worker" has no parent task; a root or parentless replay task cannot ask a parent',
      )
    }) as never
    const result = (await defineTaskAskParentTool(ctx as never).execute(
      { requestKey: 'k1', question: 'who owns me?' },
      questionExec('s-worker'),
    )) as string

    expect(result).toContain('task_ask_parent rejected:')
    expect(result).toContain('has no parent task')
  })

  it('refuses a call that carries no registration id, because it has no body to cite', async () => {
    const { tool, ask } = await askTool(asked())
    await expect(
      tool.execute({ requestKey: 'k1', question: 'q' }, { agent: { id: 's-worker' } } as never),
    ).rejects.toThrow('task_ask_parent: this call carries no registration id')
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('task_answer', () => {
  /** One question call as the loop dispatches it: the caller's own session and its own call id. */
  function questionExec(sessionId: string, callId = `call-${sessionId}-1`) {
    return { agent: { id: sessionId }, callId, signal: new AbortController().signal }
  }

  /** One recorded answer, as answering a question hands it back. */
  function answered(resolves: boolean, overrides: Record<string, unknown> = {}) {
    return {
      answer: {
        answerId: 'a-xyz',
        questionId: 'q-abc',
        parentRunId: 'r-root',
        requestKey: 'a1',
        answerDigest: 'b'.repeat(64),
        answerRef: { sessionId: 's-root', seq: 11 },
        messageId: 'm-answer-xyz',
        resolves,
        answeredAt: '2026-09-25T00:00:00.000Z',
        ...overrides,
      },
      created: true,
      delivery: { messageId: 'm-answer-xyz', status: 'delivered' },
    }
  }

  async function answerTool(outcome: unknown) {
    const { ctx } = await fixture()
    const answer = vi.fn(async () => outcome)
    ctx.taskRuntime.answerParentQuestion = answer as never
    return { tool: defineTaskAnswerTool(ctx as never), ctx, answer }
  }

  it('declares exactly the four parameters of the fixed shape, with resolves required and no default', () => {
    const tool = defineTaskAnswerTool(fixture().ctx as never)
    const parameters = tool.parameters as { properties: Record<string, { type?: unknown }>; required?: string[] }

    expect(Object.keys(parameters.properties).sort()).toEqual(['answer', 'questionId', 'requestKey', 'resolves'])
    expect(parameters.required).toEqual(['questionId', 'requestKey', 'answer', 'resolves'])
    expect(parameters.properties.resolves?.type).toBe('boolean')
    expect(
      Object.keys(parameters.properties).some(name =>
        /recipient|child|target|run|session|auth|approve|grant|category|kind/i.test(name),
      ),
    ).toBe(false)
    expect(JSON.stringify(parameters)).not.toContain('recipient')
  })

  it('refuses an undeclared key by name, before the runtime is called', async () => {
    const { tool, answer } = await answerTool(answered(true))

    const result = (await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'this one', resolves: true, childSessionId: 's-child' },
      questionExec('s-root'),
    )) as string
    expect(result).toContain('task_answer rejected: undeclared parameter "childSessionId"')
    expect(result).toContain('no argument that names a recipient')
    expect(answer).not.toHaveBeenCalled()
  })

  it("forwards its own call id and the model's declaration, and nothing else", async () => {
    const { tool, answer } = await answerTool(answered(false))
    await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'not yet', resolves: false },
      questionExec('s-root', 'call-12'),
    )

    expect(answer).toHaveBeenCalledExactlyOnceWith('s-root', {
      callId: 'call-12',
      questionId: 'q-abc',
      requestKey: 'a1',
      resolves: false,
    })
  })

  it('renders a resolving answer as the release of exactly that question, adding no claim about the words', async () => {
    const { tool } = await answerTool(answered(true))
    const result = (await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'this one', resolves: true },
      questionExec('s-root'),
    )) as string

    expect(result).toContain('answer a-xyz recorded for question q-abc')
    expect(result).toContain("message m-answer-xyz is in the asking run's session")
    expect(result).toContain('`resolves: true` releases exactly that question')
    expect(result).toContain('another question of its own keeps it blocked')
    expect(result).toContain('It changes no contract, no permission and no task state')
    expect(result).toContain('the framework does not vouch for what the answer says')
  })

  it('renders a non-resolving answer as a question still open', async () => {
    const { tool } = await answerTool(answered(false))
    const result = (await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'not yet', resolves: false },
      questionExec('s-root'),
    )) as string

    expect(result).toContain('`resolves: false` keeps the question open')
    expect(result).toContain('the asking run stays blocked on it')
  })

  it('reports an unreachable asking run as a retry the recovery pass makes', async () => {
    const { tool } = await answerTool({
      ...answered(true),
      delivery: { messageId: 'm-answer-xyz', status: 'unavailable' },
    })
    const result = (await tool.execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'this one', resolves: true },
      questionExec('s-root'),
    )) as string

    expect(result).toContain('answer a-xyz recorded')
    expect(result).toContain("is not delivered yet: the asking run's session is not live in this process")
    expect(result).toContain('recovery delivers that same identity')
    expect(result).toContain('do not answer the same question again under a new request key')
  })

  it("renders the runtime's refusal instead of throwing it", async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.answerParentQuestion = vi.fn(async () => {
      throw new Error('task-runtime: answer from run "r-other" refused: question "q-abc" is addressed to run "r-root"')
    }) as never
    const result = (await defineTaskAnswerTool(ctx as never).execute(
      { questionId: 'q-abc', requestKey: 'a1', answer: 'x', resolves: true },
      questionExec('s-worker'),
    )) as string

    expect(result).toContain('task_answer rejected:')
    expect(result).toContain('is addressed to run "r-root"')
  })

  it('refuses a call that carries no registration id, because it has no body to cite', async () => {
    const { tool, answer } = await answerTool(answered(true))
    await expect(
      tool.execute({ questionId: 'q-abc', requestKey: 'a1', answer: 'x', resolves: true }, {
        agent: { id: 's-root' },
      } as never),
    ).rejects.toThrow('task_answer: this call carries no registration id')
    expect(answer).not.toHaveBeenCalled()
  })
})
