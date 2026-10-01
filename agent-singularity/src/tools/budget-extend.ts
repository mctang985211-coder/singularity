/** `task_budget_extend`: the card a person decides from, and the host identity the question was asked under (K4). @module @dangosys/dsh-singularity-agent/tools/budget-extend */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { BudgetExtensionProposal, TaskBudgetExtension } from '@dangosys/dsh-singularity-task'
import type {
  RootBudgetApproval,
  RootBudgetApprovalAsk,
  RootBudgetExtensionResult,
} from '@dangosys/dsh-singularity-task-runtime'
import { denialReason, message, sessionId, text, undeclaredParameters } from '../shared.ts'

/** The whole argument surface: the request key and the approved run total. */
const DECLARED_PARAMETERS = ['requestKey', 'maxRuns'] as const

/** The run ceiling in force, or the words that say there is none. An absent ceiling is not zero and not infinity: this deployment sets no limit there, and a card that printed a number would be inventing one. */
function inForce(value: number | undefined): string {
  return value === undefined ? 'none' : String(value)
}

/** The run-count raise this request names, as a recorded answer prints it. */
function raiseLines(proposal: BudgetExtensionProposal): string[] {
  const raise = proposal.maxRuns
  return raise === undefined ? [] : [`- maxRuns: ${raise.previous} → ${raise.next}`]
}

/** The card a person decides from (K4): the store and the tree the raise belongs to, the request's own key and identity, the runs the store already holds, the run ceiling in force beside the deployment's. */
function renderAsk(ask: RootBudgetApprovalAsk): string {
  const proposal = ask.proposal
  return [
    `Budget extension of the tree in store "${ask.storeId}" — root task ${ask.rootTaskId}, asked by its root coordination session ${ask.rootSessionId}.`,
    `request key "${proposal.requestKey}" (identity ${proposal.requestDigest})`,
    `runs the store already holds: ${ask.runsUsed} — an approved total replaces the ceiling, never this count`,
    'run ceiling now (the approved total in force first, the ceiling this deployment configures in parentheses):',
    `- maxRuns: ${inForce(ask.effective.maxRuns)} in force (deployment configures ${inForce(ask.configured.maxRuns)}) → approves a total of ${proposal.maxRuns!.next}`,
    'approving records ONE budget-extension event on this store: the tree keeps its runs, its tasks and its history, no run starts or resumes, nothing is re-opened, and the approved total becomes the ceiling every later admission reads.',
    'rejecting or cancelling records nothing and changes no ceiling.',
  ].join('\n')
}

/** The record as both the approved and the already-recorded answer print it: the raises, and the audit reference they were recorded under. */
function renderRecord(record: TaskBudgetExtension): string[] {
  return [
    ...raiseLines(record),
    `approval on the record: ${record.approvalRef} — asked by ${record.requestedBy} at ${record.recordedAt}`,
  ]
}

export function defineTaskBudgetExtendTool(ctx: Context) {
  return defineTool({
    name: 'task_budget_extend',
    description:
      'Ask a human to raise the run ceiling bounding this tree\'s execution, and record the raise they approve. State the ' +
      'total you want in force, never a difference: maxRuns is the WHOLE approved run count (a positive whole number, not "add five"), ' +
      'maxRuns is required; a run ceiling this deployment leaves unlimited is refused, as is any total that is not ' +
      'above the ceiling in force. The request is shown to a human with the store, the run ceiling and the runs already used, and ' +
      'only their explicit approval records anything — a rejection, a cancellation or an unavailable answerer writes nothing. ' +
      'A request key already recorded with the same totals is answered from the record without asking again; the same key at ' +
      'different totals is refused. A raise starts no run, resumes none, re-opens nothing and does not clear the runs already ' +
      'counted — it moves ceilings only. There is no argument here that approves anything or stands in for somebody\'s ' +
      'approval, and the store is derived from your session: only a graph\'s root coordination session can call this, and it may ' +
      'do so after its tree stopped.',
    parameters: {
      requestKey: {
        type: 'string',
        required: true,
        description: 'Stable key this request is answered under; a retry after a crash carries the same key and is answered from the recorded raise',
      },
      maxRuns: {
        type: 'number',
        required: true,
        description: 'The whole approved run count once the human approves — a positive whole number above the ceiling in force, never an increment',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, DECLARED_PARAMETERS, 'task_budget_extend')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'task_budget_extend')

      // One call, and the whole decision inside it: the runtime validates the
      // root identity, derives the store, answers a repeat from the record,
      let result: RootBudgetExtensionResult
      try {
        result = await ctx.taskRuntime.extendRootBudget(caller, { callId: exec.callId, execution: exec }, {
          requestKey: args.requestKey,
          maxRuns: args.maxRuns,
        })
      } catch (error) {
        return `task_budget_extend rejected: ${message(error)}`
      }

      if (result.answeredFromRecord) {
        return [
          `task_budget_extend: request key "${result.record.requestKey}" is already recorded on store "${result.storeId}" (root task ${result.rootTaskId}) — ` +
          'answered from the record; no human was asked and nothing was appended.',
          ...renderRecord(result.record),
        ].join('\n')
      }
      return [
        `task_budget_extend: approved and recorded on store "${result.storeId}" (root task ${result.rootTaskId})`,
        `request key "${result.record.requestKey}" (identity ${result.record.requestDigest})`,
        ...renderRecord(result.record),
        'no run started, none resumed, no task changed and no terminal run re-opened; the runs already counted still count against the approved total.',
      ].join('\n')
    },
  })
}

/** The one approval a budget extension is granted through: the callback the assembly installs on the runtime once, and the only place a person's answer to `task_budget_extend` exists. */
export function defineRootBudgetApproval(ctx: Context): RootBudgetApproval {
  return async ask => {
    const execution = ask.host.execution
    const host = typeof execution === 'object' && execution !== null ? execution as Partial<ToolRunContext> : undefined
    const agent = host?.agent
    if (agent === undefined) {
      return { kind: 'refused', reason: 'the host execution names no agent, so there is nobody to put the question to' }
    }
    // The call the question is asked under, in the type the channel's request
    // carries it in: the runtime already validated this string as the non-empty
    const callId = ask.host.callId as ToolRunContext['callId']
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'task_budget_extend',
      callId,
      reason: renderAsk(ask),
      signal: host?.signal,
    })
    if (outcome === 'allowed-once') return { kind: 'allowed', reference: `approval:${String(callId)}` }
    return {
      kind: 'refused',
      reason: denialReason(outcome, {
        cancelled: 'the question was cancelled before the human answered it',
        unavailable: 'no approval answerer was available to put the question to a person',
      }),
    }
  }
}
