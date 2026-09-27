/**
 * `task_budget_extend`: ask a person to raise the tree's own execution ceilings,
 * and record the raise they approved (K4).
 *
 * Why a tool and not a service entry: the decision is a person's, and the
 * workspace's rule for a person's decision is the native approval seam — the
 * ask, its rendering and the `approval:<callId>` reference are the tool plane's.
 * The runtime owns everything else (`TaskRuntime.budgetExtensionDraft` /
 * `extendRootBudget`): which session may ask, what the store configures, what is
 * in force, what the request would become, and whether the reading it was
 * approved against is still the one in force. This file therefore adds exactly
 * two things — a card a human can decide from, and the channel's reference
 * travelling back into the record.
 *
 * Why the reference and never a flag: the committing entry takes the channel's
 * own fact and refuses an empty one, so no argument of this tool may be shaped
 * like an approval. A model that wants a raise has to ask a person for it; there
 * is no parameter here that can claim one, and an undeclared key is refused by
 * name rather than dropped ({@link undeclaredParameters}).
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
import type { RootBudgetExtensionDraft } from '@dangosys/dsh-singularity-task-runtime'
import { undeclaredParameters } from './proposal-parameters.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

/** The whole argument surface: the request key and the two totals. There is deliberately no third member. */
const DECLARED_PARAMETERS = ['requestKey', 'maxRuns', 'deadlineAt'] as const

/** The two ceilings a tree's budget is measured in, in the order the card and the record print them. */
type Dimension = 'maxRuns' | 'deadlineAt'
const DIMENSIONS: readonly Dimension[] = ['maxRuns', 'deadlineAt']

function sessionId(exec: ToolRunContext): string {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('task_budget_extend: missing agent id')
  return id
}

/**
 * The value one dimension is under, or the words that say there is none. An
 * absent ceiling is not zero and not infinity: this deployment sets no limit
 * there, and a card that printed a number would be inventing one.
 */
function inForce(value: number | string | undefined): string {
  return value === undefined ? 'none' : String(value)
}

/** The raise this request asks of one dimension, when it names that dimension at all. */
function raiseOf(proposal: BudgetExtensionProposal, dimension: Dimension): { readonly previous: number | string; readonly next: number | string } | undefined {
  return dimension === 'maxRuns' ? proposal.maxRuns : proposal.deadlineAt
}

/** One dimension's raise as a line, in the order the dimensions are printed. */
function raiseLines(proposal: BudgetExtensionProposal): string[] {
  return DIMENSIONS.flatMap(dimension => {
    const raise = raiseOf(proposal, dimension)
    return raise === undefined ? [] : [`- ${dimension}: ${String(raise.previous)} → ${String(raise.next)}`]
  })
}

/**
 * The card a person decides from (K4): the store and the tree the raise belongs
 * to, the request's own identity, the runs the store already holds, each
 * ceiling as it stands now — the approved total in force and the deployment's
 * own configuration beside it — and, for the dimensions this request names, the
 * total that approving would put in place.
 *
 * The usage is on the card because the ceiling is what is being moved and the
 * count is what it is measured against: a raise from 10 to 20 when 18 runs exist
 * is two runs of headroom, and a person who is not told that is deciding blind.
 */
function renderAsk(draft: RootBudgetExtensionDraft, proposal: BudgetExtensionProposal): string {
  return [
    `Budget extension of the tree in store "${draft.storeId}" — root task ${draft.rootTaskId}, asked by its root coordination session ${draft.rootSessionId}.`,
    `request key "${proposal.requestKey}" (identity ${proposal.requestDigest})`,
    `runs the store already holds: ${draft.runsUsed} — an approved total replaces the ceiling, never this count`,
    'ceilings now (the approved total in force first, the ceiling this deployment configures in parentheses):',
    ...DIMENSIONS.map(dimension => {
      const raise = raiseOf(proposal, dimension)
      const now = `${dimension}: ${inForce(draft.effective[dimension])} in force (deployment configures ${inForce(draft.configured[dimension])})`
      return raise === undefined
        ? `- ${now} — this request does not name it`
        : `- ${now} → approves a total of ${String(raise.next)}`
    }),
    'approving records ONE budget-extension event on this store: the tree keeps its runs, its tasks and its history, no run starts or resumes, nothing is re-opened, and the approved total becomes the ceiling every later admission reads.',
    'rejecting or cancelling records nothing and changes no ceiling.',
  ].join('\n')
}

/** The record as both the approved and the already-recorded answer print it: the raises, and who approved them. */
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
      'Ask a human to raise the ceiling(s) bounding this tree\'s execution, and record the raise they approve. State the ' +
      'total you want in force, never a difference: maxRuns is the WHOLE approved run count (a positive whole number, not "add five"), ' +
      'deadlineAt is the absolute instant the tree must stop by (for example 2026-09-28T09:00:00.000Z, never "two more hours"). ' +
      'At least one of the two is required; a dimension this deployment leaves unlimited is refused, as is any total that is not ' +
      'above the ceiling in force. The request is shown to a human with the store, both ceilings and the runs already used, and ' +
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
        description: 'The whole approved run count once the human approves — a positive whole number above the ceiling in force, never an increment',
      },
      deadlineAt: {
        type: 'string',
        description: 'The approved deadline as an absolute instant in UTC (e.g. 2026-09-28T09:00:00.000Z), later than the one in force — never a duration',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args, DECLARED_PARAMETERS, 'task_budget_extend')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec)
      const agent = exec.agent
      if (agent === undefined) throw new Error('task_budget_extend: missing agent')

      // The query first, and it writes nothing: every shape rule, bound and
      // staleness check is the runtime's, applied against the store's own facts,
      // so a request that could never run is refused before a person is asked.
      let draft: RootBudgetExtensionDraft
      try {
        draft = await ctx.taskRuntime.budgetExtensionDraft(caller, {
          requestKey: args.requestKey,
          ...(args.maxRuns === undefined ? {} : { maxRuns: args.maxRuns }),
          ...(args.deadlineAt === undefined ? {} : { deadlineAt: args.deadlineAt }),
        })
      } catch (error) {
        return `task_budget_extend rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      if (draft.outcome.kind === 'refused') {
        return `task_budget_extend refused: ${draft.outcome.reason}; no human was asked and nothing was written`
      }
      if (draft.outcome.kind === 'recorded') {
        return [
          `task_budget_extend: request key "${draft.outcome.record.requestKey}" is already recorded on store "${draft.storeId}" — answered from the record; no human was asked and nothing was appended.`,
          ...renderRecord(draft.outcome.record),
        ].join('\n')
      }

      const proposal = draft.outcome.proposal
      const outcome = await ctx.approval.request({
        agent,
        toolName: 'task_budget_extend',
        callId: exec.callId,
        reason: renderAsk(draft, proposal),
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') {
        const why = outcome === 'rejected'
          ? 'the human rejected it'
          : outcome === 'cancelled'
            ? 'the request was cancelled before the human decided'
            : 'no approval answerer available'
        return `task_budget_extend: no extension recorded — ${why}; the ceilings are unchanged and no run started or resumed`
      }

      // The approved totals exactly as the card showed them, the reading the
      // query reported, and the channel's own reference: the committing entry
      // re-judges all three inside the store's write queue, so a ceiling that
      // moved between the ask and the answer is refused rather than re-based.
      try {
        const record = await ctx.taskRuntime.extendRootBudget(caller, {
          requestKey: proposal.requestKey,
          ...(proposal.maxRuns === undefined ? {} : { maxRuns: proposal.maxRuns.next }),
          ...(proposal.deadlineAt === undefined ? {} : { deadlineAt: proposal.deadlineAt.next }),
          baseline: draft.effective,
          approvalRef: `approval:${exec.callId}`,
        })
        return [
          `task_budget_extend: approved and recorded on store "${draft.storeId}" (root task ${draft.rootTaskId})`,
          `request key "${record.requestKey}" (identity ${record.requestDigest})`,
          ...renderRecord(record),
          'no run started, none resumed, no task changed and no terminal run re-opened; the runs already counted still count against the approved total.',
        ].join('\n')
      } catch (error) {
        return `task_budget_extend rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
