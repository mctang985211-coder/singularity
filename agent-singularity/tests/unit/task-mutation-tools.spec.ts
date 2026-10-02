import { describe, expect, it, vi } from 'vitest'
import { defineTaskDecomposeTool } from '../../src/tools/task-decompose.ts'
import { defineTaskAnswerTool } from '../../src/tools/task-answer.ts'
import { defineTaskAskParentTool } from '../../src/tools/task-ask-parent.ts'
import { defineTaskCancelTool } from '../../src/tools/task-cancel.ts'
import { defineTaskDiagnoseTool } from '../../src/tools/task-diagnose.ts'
import { defineTaskIntakeTool } from '../../src/tools/task-intake.ts'
import { defineTaskReadTool } from '../../src/tools/task-read.ts'
import { defineTaskReviewPackTool } from '../../src/tools/task-review-pack.ts'
import { defineTaskStatusTool } from '../../src/tools/task-status.ts'
import { defineTaskSubmitResultTool } from '../../src/tools/task-submit-result.ts'
import { defineTaskVerifyTool } from '../../src/tools/task-verify.ts'
import { fixture, exec, workerTask, workerRun } from './task-tools.fixture.ts'

describe('task_decompose', () => {
  const children = [
    {
      objective: 'Implement the parser',
      acceptanceCriteria: [{ description: 'parses the fixtures', command: 'pnpm test' }],
    },
    {
      objective: 'Write the docs',
      acceptanceCriteria: [{ description: 'docs build', command: 'pnpm docs:build' }],
      dependsOn: [0],
    },
  ]

  /** The submission the runtime would record, as the service reports it back. */
  function submission(overrides: Record<string, unknown> = {}) {
    return {
      proposalId: 'p-1',
      status: 'ready' as const,
      policy: 'off' as const,
      existing: false,
      detail: 'recorded',
      ...overrides,
    }
  }

  it('proposes the batch and continues it, rendering the admitted children', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1', 't-child-2'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, {
      agent: { id: 'root-1' },
      signal,
    } as never)) as string

    // The tool composes the runtime's two entries — the submission carries the
    // caller's own key options, the continuation is what admits the batch.
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children },
      { exec: { signal } },
    )
    expect(ctx.taskRuntime.continueProposal).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-1', 'root-1', {})
    // The tool returns at admission (A3 §3.1) and says so: it reports the batch
    // that was admitted, not outcomes nobody has produced yet.
    expect(result).toContain('decomposed t-root into 2 children (batch b-r-root-p-1):')
    expect(result).toContain('- child 1: t-child-1')
    expect(result).toContain('- child 2: t-child-2')
    expect(result).toContain('does not wait for the batch')
  })

  it('states the contract the caller is under while the batch runs', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    // The model-visible behaviour contract (§3.8, K1 §2): the batch id, the phase
    // the caller is now in, what is still allowed, and that the batch end hands
    // execution back without submitting anything — everything the caller needs to
    // not write into the children's checkout and to know the submission is its own.
    expect(result).toContain('The runtime owns batch b-r-root-p-1 now')
    expect(result).toContain('You are in phase waiting_children')
    expect(result).toContain('run together with its batch with `task_cancel` if abandoning this run')
    expect(result).toContain('Writes, shell commands, another decomposition and a submission of your own are refused')
    expect(result).toContain('The batch end reaches you as a message')
    expect(result).toContain('nothing is submitted on your behalf')
    expect(result).toContain('hand this task in yourself with `task_submit_result`')
    // The replaced guidance is gone: the runtime never submits on the caller's
    // behalf, so the caller is never told to leave the submission to it.
    expect(result).not.toContain('submits this task for verification')
    expect(result).not.toContain('needs no submission from you')
  })

  it('registers the call id so the batch drain does not wait for the asking call', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', children }, {
      agent: { id: 'root-1' },
      signal,
      callId: 'call-7',
    } as never)

    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children },
      { exec: { signal, callId: 'call-7' } },
    )
    // Only the call id rides the continuation: the submission's signal dies with
    // the submission, and a caller that aborts afterwards cannot stop a batch
    // the store already decided about.
    expect(ctx.taskRuntime.continueProposal).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-1', 'root-1', {
      exec: { callId: 'call-7' },
    })
  })

  it('returns the admission rejection as error text instead of throwing', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockRejectedValue(
      new Error('task-runtime: admission rejected decomposition of "t-root":\n- child 0 has no acceptance criteria'),
    )
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string
    expect(result).toContain('task_decompose rejected:')
    expect(result).toContain('admission rejected decomposition of "t-root"')
    expect(result).toContain('child 0 has no acceptance criteria')
    // A refused batch is refused before anything was proposed: no continuation.
    expect(ctx.taskRuntime.continueProposal).not.toHaveBeenCalled()
  })

  it('returns the runtime rejection of an unknown declared contract version as error text', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockRejectedValue(
      new Error(
        'task-runtime: contract rejected decomposition of "t-root":\n- unknown contract version 2: this runtime writes version 1',
      ),
    )
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', contractVersion: 2, children }, {
      agent: { id: 'root-1' },
      signal,
    } as never)) as string
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', contractVersion: 2, children },
      { exec: { signal } },
    )
    expect(result).toContain('task_decompose rejected:')
    expect(result).toContain('unknown contract version 2')
  })

  it('sends no requestKey, supersedes or contractVersion key when the caller declares none', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', children }, exec('root-1'))

    // Deep equality alone also accepts a present key holding undefined, so the
    // omissions are asserted on the keys — of the spec and of the options.
    const options = ctx.taskRuntime.submitDecompositionProposal.mock.calls[0]![5] as Record<string, unknown>
    expect(Object.keys(options).sort()).toEqual(['exec'])
    expect(
      Object.keys(ctx.taskRuntime.submitDecompositionProposal.mock.calls[0]![4] as Record<string, unknown>).sort(),
    ).toEqual(['children', 'reason'])
  })

  it('lifts a declared requestKey and supersedes out of the batch into the submission options', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(
      submission({ existing: true, status: 'pending_review', policy: 'all' }),
    )
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'pending_review',
      detail: 'proposal "p-1" is waiting for a review; only a decision on the record advances it (§6)',
    })
    ctx.taskRuntime.proposalIn.mockResolvedValue({ proposalId: 'p-1', status: 'pending_review', policy: 'all' })
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute(
      { reason: 'split the work', children, requestKey: 'rk-mine', supersedes: 'p-old' },
      exec('root-1'),
    )

    // The two keys are options of the submission, not batch fields: passing them
    // inside the spec would make the runtime refuse them as undeclared fields.
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children },
      { requestKey: 'rk-mine', supersedes: 'p-old', exec: expect.objectContaining({}) },
    )
  })

  it('declares requestKey and supersedes on the schema, and keeps the batch open for the runtime', async () => {
    const { ctx } = await fixture()
    const tool = defineTaskDecomposeTool(ctx as never)
    const parameters = (tool.parameters as { properties: Record<string, { type: unknown; description?: string }> })
      .properties

    expect(parameters.requestKey?.type).toBe('string')
    expect(parameters.requestKey?.description).toContain('the runtime derives one')
    expect(parameters.requestKey?.description).toContain('new key')
    expect(parameters.supersedes?.type).toBe('string')
    expect(parameters.supersedes?.description).toContain('record is kept')
    expect(parameters.supersedes?.description).toContain('does not transfer')
  })

  it('passes declared criterion ids and child constraints through untouched', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const declared = [
      {
        objective: 'Implement the parser',
        acceptanceCriteria: [
          { criterionId: 'parse-fixtures', description: 'parses the fixtures', command: 'pnpm test' },
        ],
        constraints: ['no network access', 'write only inside the env checkout'],
      },
    ]
    const tool = defineTaskDecomposeTool(ctx as never)
    await tool.execute({ reason: 'split the work', children: declared }, { agent: { id: 'root-1' }, signal } as never)
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children: declared },
      { exec: { signal } },
    )
  })

  it('declares protectedInputs on the criterion schema and passes the declared paths through untouched', async () => {
    const { ctx } = await fixture()
    const signal = new AbortController().signal
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(submission())
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-1',
      status: 'admitted',
      batchId: 'b-r-root-p-1',
      childTaskIds: ['t-child-1'],
      detail: 'admitted as batch b-r-root-p-1',
    })
    const tool = defineTaskDecomposeTool(ctx as never)

    // The schema is the model-facing half of the contract: the declared paths
    // are a per-criterion string array, and the description says who fixes the
    // identity, who re-checks it, and that only declared paths are protected.
    const criteria = (
      tool.parameters as {
        properties: {
          children: {
            items: {
              properties: {
                acceptanceCriteria: {
                  items: {
                    properties: Record<string, { type: unknown; items?: { type: unknown }; description?: string }>
                  }
                }
              }
            }
          }
        }
      }
    ).properties.children.items.properties.acceptanceCriteria.items.properties
    expect(criteria.protectedInputs?.type).toBe('array')
    expect(criteria.protectedInputs?.items?.type).toBe('string')
    expect(criteria.protectedInputs?.description).toContain('SHA-256')
    expect(criteria.protectedInputs?.description).toContain('before judging')
    expect(criteria.protectedInputs?.description).toContain('Only declared paths are protected')

    const declared = [
      {
        objective: 'Implement the parser',
        acceptanceCriteria: [
          {
            description: 'parses the fixtures',
            command: 'tests/check.sh',
            protectedInputs: ['tests/check.sh', 'thresholds.json'],
          },
        ],
      },
    ]
    await tool.execute({ reason: 'split the work', children: declared }, { agent: { id: 'root-1' }, signal } as never)
    expect(ctx.taskRuntime.submitDecompositionProposal).toHaveBeenCalledExactlyOnceWith(
      'sg-t-root-1',
      't-root',
      'r-root',
      'root-1',
      { reason: 'split the work', children: declared },
      { exec: { signal } },
    )
  })

  it('reports a batch waiting for its review, naming the proposal and the policy on its record', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(
      submission({ existing: false, status: 'pending_review', policy: 'all' }),
    )
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-9',
      status: 'pending_review',
      detail: 'proposal "p-9" is waiting for a review; only a decision on the record advances it (§6)',
    })
    ctx.taskRuntime.proposalIn.mockResolvedValue({ proposalId: 'p-9', status: 'pending_review', policy: 'all' })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    // §5–§6: the caller learns that nothing ran, what holds the batch, and that
    // neither another submission nor a wait in this call is the way forward.
    expect(result).toContain('task_decompose is waiting for a review')
    expect(result).toContain('p-9')
    expect(result).toContain('policy all')
    expect(ctx.taskRuntime.proposalIn).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-9')
    expect(result).toContain('has not been decomposed')
    expect(result).toContain('no worker was spawned')
    expect(result).toContain('`task_proposal_read`')
    expect(result).toContain('the runtime continues the batch')
    expect(result).toContain('a revision is new content')
    expect(result).toContain('Do not re-submit the same content while it waits')
    // A waiting batch is not an error: the answer is the guidance, not a refusal.
    expect(result).not.toContain('task_decompose rejected')
  })

  it('names the policy the proposal was born under, read from the record', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(
      submission({ status: 'pending_review', policy: 'off' }),
    )
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-9',
      status: 'pending_review',
      detail: 'waiting',
    })
    // A proposal born under `off` and tightened into review keeps its birth
    // policy on the record, and the tool reports the record, not the config.
    ctx.taskRuntime.proposalIn.mockResolvedValue({ proposalId: 'p-9', status: 'pending_review', policy: 'off' })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string
    expect(result).toContain('policy off')
  })

  it('says the policy could not be read back rather than inventing one', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(
      submission({ status: 'pending_review', policy: 'all' }),
    )
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-9',
      status: 'pending_review',
      detail: 'waiting',
    })
    ctx.taskRuntime.proposalIn.mockRejectedValue(new Error('task: unknown proposal "p-9"'))
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string
    expect(result).toContain('policy unknown')
    expect(result).toContain('task_decompose is waiting for a review')
  })

  it('names a proposal that was decided against, and points at the revision route', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitDecompositionProposal.mockResolvedValue(
      submission({ existing: true, status: 'rejected', policy: 'all' }),
    )
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-3',
      status: 'rejected',
      detail: 'proposal "p-3" is rejected; nothing was admitted and nothing is dispatched',
      reason: 'the owner refused this batch through the approval channel',
    })
    const tool = defineTaskDecomposeTool(ctx as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    expect(result).toContain('task_decompose rejected: decomposition of "t-root" is rejected (proposal p-3)')
    expect(result).toContain('the owner refused this batch through the approval channel')
    expect(result).toContain('never runs: revise it')
    expect(ctx.taskRuntime.proposalIn).not.toHaveBeenCalled()
  })

  it('asks no human itself: a refused batch reaches no approval channel', async () => {
    const { ctx } = await fixture()
    const approval = { request: vi.fn() }
    const withApproval = { ...ctx, approval }
    ctx.taskRuntime.submitDecompositionProposal.mockRejectedValue(
      new Error(
        'task-runtime: admission rejected decomposition of "t-root":\n- child 0 declares no acceptance criteria',
      ),
    )
    const tool = defineTaskDecomposeTool(withApproval as never)
    const result = (await tool.execute({ reason: 'split the work', children }, exec('root-1'))) as string

    // §5: a bad batch never reaches a person. The tool takes no human decision
    // itself, and the runtime refuses the batch before a proposal exists.
    expect(result).toContain('task_decompose rejected:')
    expect(approval.request).not.toHaveBeenCalled()
    expect(ctx.taskRuntime.continueProposal).not.toHaveBeenCalled()
  })
})

describe('task_submit_result', () => {
  const submission = { summary: 'the parser passes the fixtures', evidenceRefs: ['ev-1'], notes: 'nothing left open' }

  it('passes the submission and the call registration id to the runtime, and renders the verdict', async () => {
    const { ctx } = await fixture()
    const submitResult = vi.fn(async () => ({ status: 'verified', detail: 'run "r-worker" submitted and verified.' }))
    ctx.taskRuntime.submitResult = submitResult as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    const result = (await tool.execute(submission, {
      agent: { id: 's-worker' },
      signal: new AbortController().signal,
      callId: 'call-7',
    } as never)) as string

    // The call id is what keeps the drain from waiting for the call that asked
    // for it (A3 §3.3), so it has to travel with the submission.
    expect(submitResult).toHaveBeenCalledExactlyOnceWith('s-worker', submission, { callId: 'call-7' })
    expect(result).toBe('task_submit_result verified: run "r-worker" submitted and verified.')
  })

  it('sends no callId key when the caller is not a registered tool call', async () => {
    const { ctx } = await fixture()
    const submitResult = vi.fn(async () => ({ status: 'verified', detail: 'ok' }))
    ctx.taskRuntime.submitResult = submitResult as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    await tool.execute({ summary: 'done' }, exec('s-worker'))

    expect(Object.keys(submitResult.mock.calls[0]![2] as Record<string, unknown>)).toEqual([])
  })

  it('requires a non-empty summary on the model-facing schema', async () => {
    const tool = defineTaskSubmitResultTool((await fixture()).ctx as never)
    const parameters = tool.parameters as {
      properties: Record<string, { type: unknown; required?: boolean; items?: { type: unknown } }>
    }
    expect(parameters.properties.summary?.type).toBe('string')
    expect((tool.parameters as { required?: string[] }).required).toEqual(['summary'])
    expect(parameters.properties.evidenceRefs?.type).toBe('array')
    expect(parameters.properties.evidenceRefs?.items?.type).toBe('string')
    expect(parameters.properties.notes?.type).toBe('string')
    // The description is the model-facing half of the protocol: the submission
    // is the action that ends the run, and idle is not a substitute for it.
    expect(tool.description).toContain('An idle session is not a completion')
    expect(tool.description).toContain('verifier')
  })

  it("answers a late or repeated submission with the runtime's own conclusion, not an error", async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitResult = vi.fn(async () => ({
      status: 'submitted',
      detail:
        'run "r-worker" already submitted: the parser passes at 2026-09-16T00:03:00.000Z. A second submission changes nothing.',
    })) as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    const result = (await tool.execute(submission, exec('s-worker'))) as string

    expect(result).toContain('task_submit_result submitted:')
    expect(result).toContain('already submitted')
    expect(result).toContain('changes nothing')
    expect(result).not.toContain('rejected')
  })

  it('returns the protocol refusal as text instead of throwing', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.submitResult = vi.fn(async () => {
      throw new Error(
        'task-runtime: run "r-worker" is waiting on its child batch (b-r-worker-p-1); a parent cannot submit while its children are still running',
      )
    }) as never
    const tool = defineTaskSubmitResultTool(ctx as never)
    const result = (await tool.execute(submission, exec('s-worker'))) as string

    expect(result).toContain('task_submit_result rejected:')
    expect(result).toContain('waiting on its child batch')
  })
})

describe('task_cancel', () => {
  async function waitingRun() {
    const { ctx } = await fixture()
    ctx.taskRuntime.runForSession.mockImplementation(
      async () =>
        ({
          storeId: 'sg-t-root-1',
          task: workerTask,
          run: { ...workerRun, executionPhase: 'waiting_children', batchId: 'b-r-worker-p-1' },
        }) as never,
    )
    return { ctx }
  }

  it('cancels the batch this run waits on and reports the settlement', async () => {
    const { ctx } = await waitingRun()
    const cancelBatch = vi.fn(async () => [
      { taskId: 't-child-1', runId: 'r-child-1', status: 'cancelled' },
      { taskId: 't-child-2', status: 'blocked' },
    ])
    ctx.taskRuntime.cancelBatch = cancelBatch as never
    const tool = defineTaskCancelTool(ctx as never)
    const result = (await tool.execute({ reason: 'the plan changed' }, exec('s-worker'))) as string

    expect(cancelBatch).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'b-r-worker-p-1', 's-worker')
    expect(result).toContain('cancelled batch b-r-worker-p-1 (the plan changed):')
    expect(result).toContain('- t-child-1: cancelled run r-child-1')
    expect(result).toContain('- t-child-2: blocked')
  })

  it('says there is no batch in flight and changes nothing when the run holds none', async () => {
    const { ctx } = await fixture()
    const cancelBatch = vi.fn()
    ctx.taskRuntime.cancelBatch = cancelBatch as never
    const tool = defineTaskCancelTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(result).toContain('no batch is in flight for run "r-worker"')
    expect(result).toContain('phase active')
    expect(result).toContain('nothing was changed')
    expect(cancelBatch).not.toHaveBeenCalled()
  })

  it('returns the runtime refusal as text instead of throwing', async () => {
    const { ctx } = await waitingRun()
    ctx.taskRuntime.cancelBatch = vi.fn(async () => {
      throw new Error('task-runtime: batch "b-r-worker-p-1" is not being driven by this process')
    }) as never
    const tool = defineTaskCancelTool(ctx as never)
    const result = (await tool.execute({}, exec('s-worker'))) as string

    expect(result).toContain('task_cancel rejected:')
    expect(result).toContain('not being driven by this process')
  })

  it('declares the reason as an optional parameter', async () => {
    const tool = defineTaskCancelTool((await fixture()).ctx as never)
    const parameters = tool.parameters as { properties: Record<string, { type: unknown }>; required?: string[] }
    expect(parameters.properties.reason?.type).toBe('string')
    expect(parameters.required ?? []).not.toContain('reason')
  })
})

describe('missing agent identity', () => {
  it.each([
    ['task_read', async () => defineTaskReadTool((await fixture()).ctx as never), {}],
    ['task_status', async () => defineTaskStatusTool((await fixture()).ctx as never), {}],
    [
      'task_intake',
      async () => defineTaskIntakeTool((await fixture()).ctx as never),
      { objective: 'ship it', acceptanceCriteria: [] },
    ],
    ['task_submit_result', async () => defineTaskSubmitResultTool((await fixture()).ctx as never), { summary: 'done' }],
    ['task_cancel', async () => defineTaskCancelTool((await fixture()).ctx as never), {}],
    ['task_verify', async () => defineTaskVerifyTool((await fixture()).ctx as never), {}],
    [
      'task_review_pack',
      async () => defineTaskReviewPackTool((await fixture()).ctx as never),
      { taskId: 't-child-1', runId: 'r-child-1' },
    ],
    [
      'task_ask_parent',
      async () => defineTaskAskParentTool((await fixture()).ctx as never),
      { requestKey: 'k1', question: 'which contract holds?' },
    ],
    [
      'task_answer',
      async () => defineTaskAnswerTool((await fixture()).ctx as never),
      { questionId: 'q-1', requestKey: 'a1', answer: 'this one', resolves: true },
    ],
    [
      'task_diagnose',
      async () => defineTaskDiagnoseTool((await fixture()).ctx as never),
      {
        taskId: 't-child-1',
        diagnosisId: 'd1',
        observedFailure: 'f',
        scope: 's',
        localizedCause: 'c',
        confidence: 'medium',
      },
    ],
  ])('%s rejects a call with no agent identity', async (_name, make, args) => {
    const tool = await make()
    for (const exec of [{}, { agent: { id: '' }, signal: new AbortController().signal }]) {
      await expect(tool.execute(args, exec as never)).rejects.toThrow('missing agent id')
    }
  })
})

/**
 * The root contract's two doors, from the tool side (A0 stage C): accepting one
 * (`task_intake`) and reading the session off the store while none has been
 * accepted (`task_read`/`task_status`). The tool normalizes nothing, judges
 * nothing and activates nothing — every rule stays in the runtime — so what it
 * owes the caller is a closed schema, the caller's own identity checked before
 * any service call, and three answers rendered as they are: activated, waiting
 * for a review, or refused by name.
 */
describe('task_intake', () => {
  const rootContract = {
    objective: 'Ship the release artifact',
    acceptanceCriteria: [
      {
        description: 'the release artifact exists and is published',
        command: 'make release',
        mode: 'deterministic',
        mandatory: true,
      },
    ],
    assumptions: ['the checkout is on the release branch'],
    constraints: ['no network access'],
    requiredCapabilities: ['design-ball'],
    requestKey: 'rk-intake-1',
  }

  function rootExec(sessionId = 'root-1') {
    return exec(sessionId) as unknown as { agent: { id: string }; signal: AbortSignal }
  }

  it('declares a closed criterion object and no parameter that could approve anything', () => {
    const tool = defineTaskIntakeTool(fixture().ctx as never)
    const parameters = tool.parameters as {
      properties: Record<
        string,
        { items?: { additionalProperties?: boolean; properties?: Record<string, { enum?: readonly string[] }> } }
      >
      required?: string[]
    }
    expect(Object.keys(parameters.properties).sort()).toEqual([
      'acceptanceCriteria',
      'assumptions',
      'constraints',
      'contractVersion',
      'objective',
      'requestKey',
      'requiredCapabilities',
      'supersedes',
      'templateParameters',
      'templateRef',
    ])
    expect(parameters.required).toBeUndefined()
    // The review is the only thing that moves a contract, so no parameter, and
    // nothing the prompt/schema says about one, may read as a way to approve.
    expect(Object.keys(parameters.properties).some(name => /approv|decid|review|force/i.test(name))).toBe(false)

    const criteria = parameters.properties.acceptanceCriteria!.items!
    expect(criteria.additionalProperties).toBe(false)
    expect(Object.keys(criteria.properties!).sort()).toEqual([
      'acceptsArtifact',
      'command',
      'criterionId',
      'description',
      'heuristic',
      'mandatory',
      'mode',
      'protectedInputs',
      'requiredEvidence',
      'requiresArtifact',
      'verifierRef',
    ])
    expect(criteria.properties!.mode!.enum).toEqual([
      'deterministic',
      'simulation',
      'formal',
      'measurement',
      'review',
      'composite',
    ])
    // The one field of a decomposition criterion this tool does not declare: a
    // childEvidence map names positions in a batch, and a root contract is
    // submitted before any batch exists. The runtime would accept the key; the
    // schema refuses it instead of letting a model declare a map nothing can
    // ever judge.
    expect(Object.keys(criteria.properties!)).not.toContain('childEvidence')
  })

  it('accepts the contract through the runtime and renders the activated root', async () => {
    const { ctx } = await fixture()
    const intake = vi.fn(async () => ({
      status: 'activated',
      proposalId: 'p-root-1',
      taskId: 't-root-new',
      runId: 'r-root-new',
      detail: 'store "sg-t-root-1" activated root task "t-root-new" with run "r-root-new"',
    }))
    ctx.taskRuntime.intakeRootContract = intake as never
    const call = rootExec()
    const { requestKey, ...spec } = rootContract
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, call as never)) as string

    expect(intake).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'root-1', spec, {
      requestKey,
      exec: { signal: call.signal },
    })
    expect(result).toContain(
      'task_intake activated the root contract of session "root-1": root task t-root-new, root run r-root-new (proposal p-root-1)',
    )
    expect(result).toContain('task_read')
    expect(result).toContain('task_decompose')
  })

  it('renders a contract waiting for review as a proposal id, with no root task and nothing spawned', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => ({
      status: 'pending_review',
      proposalId: 'p-root-wait',
      detail: 'the review was put to the owner session "root-1" through the approval channel',
    })) as never
    ctx.taskRuntime.proposalIn = vi.fn(async () => ({ proposalId: 'p-root-wait', policy: 'all' })) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('task_intake is waiting for a review: proposal p-root-wait (policy all)')
    expect(result).toContain('no root task exists')
    expect(result).toContain('Nothing was activated and no worker was spawned')
    expect(result).toContain('`task_proposal_read`')
    expect(result).toContain('`supersedes`')
    expect(result).toContain('Do not re-submit the same content')
    expect(result).toContain('before the contract is activated')
    expect(result).not.toContain('root task t-')
  })

  it('passes the runtime refusal through, adding no claim about what was written', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error(
        'task-runtime: root contract rejected:\n- root contract requires at least one mandatory acceptance criterion judged by ' +
          'something other than the composite conjunction',
      )
    }) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toBe(
      'task_intake rejected: task-runtime: root contract rejected:\n- root contract requires at least one mandatory acceptance criterion judged by ' +
        'something other than the composite conjunction',
    )
  })

  it('refuses to re-intake a store that already holds a root task, naming the rule', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error(
        'task-runtime: store "sg-t-root-1" already holds root task "t-root", so a root contract cannot be intaken here',
      )
    }) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('already holds root task "t-root"')
    expect(result).toBe(
      'task_intake rejected: task-runtime: store "sg-t-root-1" already holds root task "t-root", so a root contract cannot be intaken here',
    )
  })

  it('passes a refusal through even when the store cannot be read back', async () => {
    const { ctx } = await fixture()
    ctx.taskRuntime.intakeRootContract = vi.fn(async () => {
      throw new Error(
        'task-runtime: the intake of a root contract for session "root-1" was cancelled before anything was persisted',
      )
    }) as never
    ctx.task.openStore = vi.fn(async () => {
      throw new Error('task: invalid persisted event at seq 3')
    }) as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('root-1'))) as string

    expect(result).toContain('task_intake rejected:')
    expect(result).toContain('invalid persisted event at seq 3')
    expect(result).toContain('cannot be read')
  })

  it('refuses a caller that is not the root session, by name, and calls nothing', async () => {
    const { ctx } = await fixture()
    const intake = vi.fn()
    ctx.taskRuntime.intakeRootContract = intake as never
    const result = (await defineTaskIntakeTool(ctx as never).execute(rootContract, exec('s-worker'))) as string

    expect(result).toContain('task_intake rejected: session "s-worker"')
    expect(result).toContain('"root-1"')
    expect(intake).not.toHaveBeenCalled()
  })

  it('hands a key it does not declare to the runtime instead of dropping it', async () => {
    const { ctx } = await fixture()
    // There is no approval parameter here, and there must be no path that
    // swallows one either: a key this tool does not declare rides along to the
    // runtime, which refuses it by name before a proposal exists (§7: nothing
    // may quietly accept an approval-shaped argument).
    const intake = vi.fn(async () => ({
      status: 'activated',
      proposalId: 'p-root-1',
      taskId: 't-root-new',
      runId: 'r-root-new',
      detail: 'activated',
    }))
    ctx.taskRuntime.intakeRootContract = intake as never
    await defineTaskIntakeTool(ctx as never).execute({ ...rootContract, approved: true }, exec('root-1'))

    const spec = (intake.mock.calls[0] as unknown as unknown[])[2] as Record<string, unknown>
    expect(spec.approved).toBe(true)
  })
})

/**
 * The state a root session reads before any contract is accepted (A0 §1.5): the
 * store may not exist at all and needs no root task, so both readers answer a
 * named state plus whatever proposal is open — and never an objective. A graph
 * name standing where a goal belongs is exactly what A0 removed.
 */
describe('the root activation view', () => {
  const waitingProposal = {
    kind: 'root',
    proposalId: 'p-root-wait',
    requestKey: 'rk-root',
    status: 'pending_review',
    policy: 'all',
    identity: {
      contractVersion: 1,
      storeId: 'sg-t-root-1',
      rootSessionId: 'root-1',
      requestKey: 'rk-root',
      contractDigest: 'c'.repeat(64),
    },
    contract: {
      contractVersion: 1,
      objective: 'Ship the release artifact',
      acceptanceCriteria: [],
      assumptions: [],
      constraints: [],
      requiredCapabilities: [],
    },
    proposalDigest: 'd'.repeat(64),
    admissionContext: { maxDepth: 3, maxChildren: 8, auditOnly: {} },
    admissionContextDigest: 'e'.repeat(64),
    reviewContext: { capabilityManifestDigest: 'f'.repeat(64), verifiers: [] },
    reviewContextDigest: 'a'.repeat(64),
    createdAt: '2026-09-23T00:00:00.000Z',
  }

  async function emptyStore(proposals: readonly unknown[] = []) {
    const h = await fixture()
    h.store.snapshot = {
      ...h.store.snapshot,
      tasks: [],
      runs: [],
      evidence: [],
      reviews: [],
      proposals: { all: proposals, byId: {}, byRequestKey: {}, byParentTask: {} },
    } as never
    return h
  }

  it('task_read answers the named state and the open proposal, with no objective anywhere', async () => {
    const { ctx } = await emptyStore([waitingProposal])
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('root-1'))) as string

    expect(result).toContain('not activated')
    expect(result).toContain('no root contract has been accepted')
    expect(result).toContain('p-root-wait')
    expect(result).toContain('pending_review')
    expect(result).toContain('task_intake')
    expect(result).toContain('task_decompose')
    expect(result).not.toContain('objective:')
    expect(result).not.toContain('task t-root')
  })

  it('task_status answers the same state rather than an empty tree', async () => {
    const { ctx } = await emptyStore([{ ...waitingProposal, status: 'ready', policy: 'off' }])
    const result = (await defineTaskStatusTool(ctx as never).execute({}, exec('root-1'))) as string

    expect(result).toContain('not activated')
    expect(result).toContain('p-root-wait')
    expect(result).toContain('ready')
    expect(result).toContain('task_intake')
    expect(result).not.toContain('task tree')
  })

  it('reads a store that does not exist yet as the same state, not as an error', async () => {
    const { ctx } = await fixture({ storeError: new Error('task: store "sg-t-root-1" does not exist') })

    const read = (await defineTaskReadTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(read).toContain('not activated')
    expect(read).toContain('does not exist yet')
    const status = (await defineTaskStatusTool(ctx as never).execute({}, exec('root-1'))) as string
    expect(status).toContain('not activated')
  })

  it('keeps a session with no run of its own off the root store view', async () => {
    const { ctx } = await emptyStore([])
    const result = (await defineTaskReadTool(ctx as never).execute({}, exec('s-worker'))) as string

    // A store with no run naming this session is no contract for it: the caller
    // is a published member with nothing of its own, refused by name — never the
    // root's view, which belongs to the graph's root session alone.
    expect(result).toContain('task_read unbound:')
    expect(result).toContain('no Run of its own')
    expect(result).not.toContain('not activated')
  })
})
