/**
 * `task_budget_extend`: the card a person decides from, and the host identity the
 * question was asked under (K4).
 *
 * Why a tool and not a service entry: the decision is a person's, and the
 * workspace's rule for a person's decision is the native approval seam — the ask,
 * its rendering and the channel's own `approval/asked` + `approval/decided` audit
 * are the tool plane's. Everything else is the runtime's
 * (`TaskRuntime.extendRootBudget`, plus the callback
 * `TaskRuntime.registerRootBudgetApproval` holds): which session may ask, what
 * the store configures, what is in force, what the request would become, whether
 * the key is already answered, and whether this deployment has anyone to ask at
 * all. This file therefore adds exactly two things: a card a human can decide
 * from ({@link renderAsk}) and the callback the assembly installs once
 * ({@link defineRootBudgetApproval}), which puts that card through the native
 * channel and answers the runtime with the channel's own decision.
 *
 * Why one call and never a reference: the tool hands the runtime the request and
 * the host execution it runs under, and nothing else — no binding, no digest, no
 * approval reference, no callId argument — because those are exactly the fields a
 * caller could use to go around the person. The request key is the idempotency
 * key and is never read as authorization; an argument undeclared here is refused
 * by name rather than dropped ({@link undeclaredParameters}). The reference the
 * store keeps is `approval:<callId>` — the host's own identity for the call the
 * question was asked under — and it is an audit reference, never a credential:
 * nothing in the runtime would accept it as one.
 *
 * What an extension is not, said on the card because the person is deciding it:
 * the raise moves ceilings. It starts no run, resumes none, re-opens no task,
 * clears no usage, and does not un-terminal a stopped tree — the tree runs again
 * only through the existing execution entries, whose admissions then read the
 * approved total. That is also why this tool is reachable by a root session that
 * is already terminal: a tree that spent its allowance is exactly the tree whose
 * owner has to be able to extend it.
 * @module @dangosys/dsh-singularity-agent/tools/budget-extend
 */

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
import { undeclaredParameters } from './proposal-parameters.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

/** The whole argument surface: the request key and the approved run total. */
const DECLARED_PARAMETERS = ['requestKey', 'maxRuns'] as const

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_budget_extend: missing agent id')
  return id
}

/**
 * The run ceiling in force, or the words that say there is none. An
 * absent ceiling is not zero and not infinity: this deployment sets no limit
 * there, and a card that printed a number would be inventing one.
 */
function inForce(value: number | undefined): string {
  return value === undefined ? 'none' : String(value)
}

/** The run-count raise this request names, as a recorded answer prints it. */
function raiseLines(proposal: BudgetExtensionProposal): string[] {
  const raise = proposal.maxRuns
  return raise === undefined ? [] : [`- maxRuns: ${raise.previous} → ${raise.next}`]
}

/**
 * The card a person decides from (K4): the store and the tree the raise belongs
 * to, the request's own key and identity, the runs the store already holds, the
 * run ceiling in force beside the deployment's configured ceiling, and the
 * total approving would put in place.
 *
 * The usage is on the card because the ceiling is what is being moved and the
 * count is what it is measured against: a raise from 10 to 20 when 18 runs exist
 * is two runs of headroom, and a person who is not told that is deciding blind.
 * There is no binding on it and no token standing in for one: the decision is not
 * read back out of anything a caller could quote — the callback that renders this
 * card is the one the runtime asks, and what it is told is what gets recorded.
 */
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
      const caller = sessionId(exec)

      // One call, and the whole decision inside it: the runtime validates the
      // root identity, derives the store, answers a repeat from the record,
      // freezes the complete reading, asks the approval this assembly installed
      // (`defineRootBudgetApproval`) and commits only an actual
      // `allowed-once`. This tool hands over the request and the host execution
      // the call runs under — no reading, no call id argument, no reference —
      // and never asks the channel itself: a throw here is the answer, not
      // something to retry around.
      let result: RootBudgetExtensionResult
      try {
        result = await ctx.taskRuntime.extendRootBudget(caller, { callId: exec.callId, execution: exec }, {
          requestKey: args.requestKey,
          maxRuns: args.maxRuns,
        })
      } catch (error) {
        return `task_budget_extend rejected: ${error instanceof Error ? error.message : String(error)}`
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

/**
 * The one approval a budget extension is granted through: the callback the
 * assembly installs on the runtime once, and the only place a person's answer to
 * `task_budget_extend` exists.
 *
 * The question goes through the native DSH approval seam the deployment already
 * runs for every other human decision, under the host's own call id: the card is
 * the ask's reason, the host execution's agent is who is asked — and whose
 * session log the channel's `approval/asked` + `approval/decided` pair is
 * written to — and the host execution's own signal is what withdraws the
 * question. Only the channel's `'allowed-once'` allows a raise, and the reference
 * it answers with is `approval:<callId>`: the host's identity for the call the
 * question was asked under, an audit reference and never a credential.
 *
 * A person who says no, a question withdrawn before they could answer it, and a
 * deployment with nobody to ask are one shape here — `refused` — because they
 * mean the same thing to the tree: the ceiling stays where it is. A channel that
 * throws is deliberately left to propagate (the runtime's caller reports it as a
 * rejection) so a failure of the channel can never read as an approval.
 */
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
    // identity of the host execution, and the reference minted below is the very
    // same string, so the brand is an annotation rather than a fact to
    // re-establish.
    const callId = ask.host.callId as ToolRunContext['callId']
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'task_budget_extend',
      callId,
      reason: renderAsk(ask),
      signal: host?.signal,
    })
    if (outcome === 'allowed-once') return { kind: 'allowed', reference: `approval:${String(callId)}` }
    const why = outcome === 'rejected'
      ? 'the human rejected it'
      : outcome === 'cancelled'
        ? 'the question was cancelled before the human answered it'
        : 'no approval answerer was available to put the question to a person'
    return { kind: 'refused', reason: why }
  }
}
