/**
 * The three T2/T3 proposal tools: read a saved proposal, continue one this
 * session submitted, withdraw one before admission. Two properties matter as
 * much as the happy paths, and both are asserted here as reversals:
 *
 * - **No approval credential exists anywhere in this surface.** A DSH tool's
 *   parameter root is an implicitly open object, so a caller *can* send
 *   `approved: true`. The tool must refuse the undeclared key by name — not
 *   ignore it while running the call as if the batch had been approved.
 * - **A refusal has zero side effects.** Every path that says no returns text
 *   and touches nothing: no second service call, no write, no decision.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CapabilityManifest, TaskContract, TaskProposal } from '@dangosys/dsh-singularity-task'
import { defineTaskProposalCancelTool } from '../../src/tools/task-proposal-cancel.ts'
import { defineTaskProposalContinueTool } from '../../src/tools/task-proposal-continue.ts'
import { defineTaskProposalReadTool } from '../../src/tools/task-proposal-read.ts'

function contract(objective: string): TaskContract {
  return {
    contractVersion: 1,
    objective,
    acceptanceCriteria: [{
      criterionId: 'ac1-1',
      description: `${objective} works`,
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    }],
    assumptions: ['the checkout is writable'],
    constraints: ['no network access'],
    requiredCapabilities: [],
  }
}

function proposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    proposalId: 'p-7',
    requestKey: 'rk-7',
    status: 'pending_review',
    policy: 'all',
    identity: {
      contractVersion: 1,
      storeId: 'sg-t-root-1',
      parentTaskId: 't-root',
      parentRunId: 'r-root',
      callerSessionId: 'root-1',
      reason: 'split the work',
      children: [
        { contractDigest: 'a'.repeat(64), dependsOn: [], decomposable: false, requiresIndependentAcceptance: false },
      ],
    },
    batch: [{ contract: contract('Implement the parser'), dependsOn: [], decomposable: false, requiresIndependentAcceptance: false }],
    proposalDigest: 'b'.repeat(64),
    admissionContext: { maxDepth: 2, maxChildren: 4, auditOnly: {} },
    admissionContextDigest: 'c'.repeat(64),
    reviewContext: { capabilityManifestDigest: 'd'.repeat(64), verifiers: [{ verifierId: 'command' }] },
    reviewContextDigest: 'e'.repeat(64),
    createdAt: '2026-09-23T00:00:00.000Z',
    ...overrides,
  }
}

const manifest: CapabilityManifest = { capabilities: {}, missing: [], closure: 'closed' }

function fixture() {
  const ctx = {
    taskRuntime: {
      runForSession: vi.fn(async () => ({
        storeId: 'sg-t-root-1',
        task: { taskId: 't-root' },
        run: { runId: 'r-root' },
      })),
      proposalIn: vi.fn(async () => proposal()),
      continueProposal: vi.fn(async () => ({
        proposalId: 'p-7',
        status: 'admitted' as const,
        batchId: 'b-t-root',
        childTaskIds: ['t-child-1', 't-child-2'],
        detail: 'admitted as batch b-t-root',
      })),
      cancelProposal: vi.fn(async () => ({
        proposalId: 'p-7',
        outcome: 'cancelled' as const,
        status: 'cancelled' as const,
        detail: 'proposal "p-7" is cancelled',
      })),
    },
  }
  return ctx
}

function exec(sessionId = 'root-1') {
  return { agent: { id: sessionId }, signal: new AbortController().signal } as never
}

describe('task_proposal_read', () => {
  it('renders the stored record: status, policy, digests, the batch, the decision and the consumption', async () => {
    const ctx = fixture()
    ctx.taskRuntime.proposalIn.mockResolvedValue(proposal({
      status: 'admitted',
      updatedAt: '2026-09-23T00:05:00.000Z',
      decision: {
        outcome: 'approved',
        proposalDigest: 'b'.repeat(64),
        admissionContextDigest: 'c'.repeat(64),
        reviewContextDigest: 'e'.repeat(64),
        decidedBy: 'approval:root-1',
        decidedAt: '2026-09-23T00:04:00.000Z',
      },
      consumption: {
        proposalId: 'p-7',
        proposalDigest: 'b'.repeat(64),
        reviewContextDigest: 'e'.repeat(64),
        batchId: 'b-t-root',
        childTaskIds: ['t-child-1', 't-child-2'],
        admittedAt: '2026-09-23T00:05:00.000Z',
      },
    }))
    const tool = defineTaskProposalReadTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec())) as string

    expect(ctx.taskRuntime.proposalIn).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-7')
    expect(result).toContain('proposal p-7 [admitted] policy all')
    expect(result).toContain('Implement the parser')
    expect(result).toContain('ac1-1')
    expect(result).toContain('the checkout is writable')
    expect(result).toContain('no network access')
    expect(result).toContain('b'.repeat(64))
    expect(result).toContain('c'.repeat(64))
    expect(result).toContain('e'.repeat(64))
    expect(result).toContain('decision: approved by approval:root-1')
    expect(result).toContain('consumed as batch b-t-root')
    expect(result).toContain('- child 2: t-child-2')
    // The record is the only source: nothing here can claim a different status.
    expect(ctx.taskRuntime.continueProposal).not.toHaveBeenCalled()
  })

  it('says a decision has not been made yet while the batch waits', async () => {
    const ctx = fixture()
    const tool = defineTaskProposalReadTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec())) as string
    expect(result).toContain('pending_review')
    expect(result).toContain('decision: none yet')
  })

  it('renders the refusal reason of a rejected proposal', async () => {
    const ctx = fixture()
    ctx.taskRuntime.proposalIn.mockResolvedValue(proposal({
      status: 'rejected',
      decision: {
        outcome: 'rejected',
        proposalDigest: 'b'.repeat(64),
        admissionContextDigest: 'c'.repeat(64),
        decidedBy: 'approval:root-1',
        decidedAt: '2026-09-23T00:04:00.000Z',
        reason: 'the owner refused this batch through the approval channel',
      },
    }))
    const tool = defineTaskProposalReadTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec())) as string
    expect(result).toContain('decision: rejected')
    expect(result).toContain('the owner refused this batch through the approval channel')
  })

  it('refuses an approval credential by name, reading nothing', async () => {
    const ctx = fixture()
    const tool = defineTaskProposalReadTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7', approved: true } as never, exec())) as string

    expect(result).toContain('task_proposal_read rejected: undeclared parameter "approved"')
    expect(result).toContain('no argument that approves')
    expect(ctx.taskRuntime.proposalIn).not.toHaveBeenCalled()
    expect(ctx.taskRuntime.runForSession).not.toHaveBeenCalled()
  })

  it('declares exactly one parameter, so no approval field can be read as one', () => {
    const ctx = fixture()
    const tool = defineTaskProposalReadTool(ctx as never)
    const declared = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)
    expect(declared).toEqual(['proposalId'])
    for (const forbidden of ['approved', 'decision', 'decidedBy', 'approvalRef', 'status']) {
      expect(declared).not.toContain(forbidden)
    }
  })

  it('returns an unknown proposal id as text instead of throwing', async () => {
    const ctx = fixture()
    ctx.taskRuntime.proposalIn.mockRejectedValue(new Error('task: unknown proposal "p-404"'))
    const tool = defineTaskProposalReadTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-404' }, exec())) as string
    expect(result).toContain('task_proposal_read rejected:')
    expect(result).toContain('unknown proposal "p-404"')
  })
})

describe('task_proposal_continue', () => {
  it('continues as the calling session and renders the admitted batch', async () => {
    const ctx = fixture()
    const tool = defineTaskProposalContinueTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec('root-1'))) as string

    expect(ctx.taskRuntime.continueProposal).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-7', 'root-1', {})
    expect(result).toContain('was admitted as batch b-t-root')
    expect(result).toContain('- child 1: t-child-1')
    expect(result).toContain('- child 2: t-child-2')
  })

  it('registers the call id so the batch drain does not wait for the asking call', async () => {
    const ctx = fixture()
    const tool = defineTaskProposalContinueTool(ctx as never)
    await tool.execute({ proposalId: 'p-7' }, { agent: { id: 'root-1' }, signal: new AbortController().signal, callId: 'call-3' } as never)
    expect(ctx.taskRuntime.continueProposal).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-7', 'root-1', { exec: { callId: 'call-3' } })
  })

  it('reports a proposal still waiting as a state, not an error, and admits nothing', async () => {
    const ctx = fixture()
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-7',
      status: 'pending_review',
      detail: 'proposal "p-7" is waiting for a review; only a decision on the record advances it (§6)',
    })
    const tool = defineTaskProposalContinueTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec())) as string

    expect(result).toContain('proposal p-7 is pending_review')
    expect(result).toContain('Nothing was admitted and nothing is spawned while it waits')
    expect(result).toContain('`task_proposal_read`')
    expect(result).toContain('re-submitting the same content answers with this same proposal')
    expect(result).not.toContain('rejected:')
  })

  it('reports a terminal proposal with the reason it will never run', async () => {
    const ctx = fixture()
    ctx.taskRuntime.continueProposal.mockResolvedValue({
      proposalId: 'p-7',
      status: 'stale',
      detail: 'proposal "p-7" is stale; nothing was admitted and nothing is dispatched',
      reason: 'the batch no longer passes admission: the capability resolution moved',
    })
    const tool = defineTaskProposalContinueTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec())) as string

    expect(result).toContain('proposal p-7 is stale')
    expect(result).toContain('the capability resolution moved')
    expect(result).toContain('revise the batch and propose it again')
  })

  it('returns a service refusal as text, with nothing changed', async () => {
    const ctx = fixture()
    ctx.taskRuntime.continueProposal.mockRejectedValue(
      new Error('task-runtime: proposal "p-7" was submitted by session "root-1"; session "s-child" cannot continue it'),
    )
    const tool = defineTaskProposalContinueTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec('s-child'))) as string
    expect(result).toContain('task_proposal_continue rejected:')
    expect(result).toContain('cannot continue it')
  })

  it('refuses an approval credential by name, calling nothing', async () => {
    const ctx = fixture()
    const tool = defineTaskProposalContinueTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7', approved: true, decidedBy: 'me' } as never, exec())) as string

    expect(result).toContain('task_proposal_continue rejected: undeclared parameters "approved", "decidedBy"')
    expect(ctx.taskRuntime.continueProposal).not.toHaveBeenCalled()
    expect(ctx.taskRuntime.runForSession).not.toHaveBeenCalled()
  })
})

describe('task_proposal_cancel', () => {
  it('withdraws the proposal through the service, which decides who may', async () => {
    const ctx = fixture()
    const tool = defineTaskProposalCancelTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec('root-1'))) as string

    expect(ctx.taskRuntime.cancelProposal).toHaveBeenCalledExactlyOnceWith('sg-t-root-1', 'p-7', 'root-1')
    expect(result).toContain('proposal "p-7" is cancelled')
    expect(result).toContain('The record is kept')
  })

  it('returns the service refusal of a foreign caller as text, with nothing written', async () => {
    const ctx = fixture()
    ctx.taskRuntime.cancelProposal.mockRejectedValue(
      new Error('task-runtime: proposal "p-7" was submitted by session "root-1"; session "s-child" cannot withdraw it'),
    )
    const tool = defineTaskProposalCancelTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7' }, exec('s-child'))) as string
    expect(result).toContain('task_proposal_cancel rejected:')
    expect(result).toContain('cannot withdraw it')
  })

  it('refuses an approval credential by name, calling nothing', async () => {
    const ctx = fixture()
    const tool = defineTaskProposalCancelTool(ctx as never)
    const result = (await tool.execute({ proposalId: 'p-7', approvalRef: 'approval:call-1' } as never, exec())) as string
    expect(result).toContain('task_proposal_cancel rejected: undeclared parameter "approvalRef"')
    expect(ctx.taskRuntime.cancelProposal).not.toHaveBeenCalled()
  })

  it('declares exactly one parameter', () => {
    const ctx = fixture()
    const tool = defineTaskProposalCancelTool(ctx as never)
    expect(Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['proposalId'])
  })
})
