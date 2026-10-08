/**
 * `method_discard`: close one candidate without publishing it. The ledger line is
 * written first (the refusal is the evidence), then the draft's working
 * directory is removed. No approval is involved, and the effective pointer is
 * never touched.
 *
 * @module @dangosys/dsh-singularity-agent/tools/method-discard
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { message, sessionId, text, undeclaredParameters } from '../shared.ts'
import { environmentPlaneOf, methodLedgerPlaneOf } from './method-shared.ts'
import { renderDiscard } from './method-render.ts'

const PARAMETERS = ['draftId', 'outcome', 'reason', 'evidenceRefs'] as const

/** The outcomes a discard may name; only a measured one answers a question the round asked. */
const OUTCOMES = ['measured-rejected', 'unmeasured-declined', 'falsified', 'duplicate', 'pruned'] as const

export function defineMethodDiscardTool(ctx: Context) {
  return defineTool({
    name: 'method_discard',
    description:
      'Discard one candidate: record why it is refused and remove its working directory. No approval is requested and the active ' +
      'revision never moves. Name the outcome — measured-rejected for a candidate the frozen strategy refused, unmeasured-declined ' +
      'for one declined before measurement and therefore not counted against the measured history, falsified, duplicate or pruned. ' +
      'A falsified candidate must cite the evidence that falsified it.',
    parameters: {
      draftId: { type: 'string', required: true, description: 'The draft to discard' },
      outcome: { type: 'string', required: true, enum: [...OUTCOMES], description: 'Why this candidate is closed' },
      reason: { type: 'string', required: true, description: 'The refusal, in the words the history will show' },
      evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'Required for falsified: the evidence that falsified this candidate' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args as Record<string, unknown>, PARAMETERS, 'method_discard')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'method_discard')
      try {
        if (typeof args.draftId !== 'string' || args.draftId.length === 0) throw new Error('draftId is required')
        const outcome = args.outcome as string
        if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) throw new Error(`outcome must be one of ${OUTCOMES.join(' | ')}`)
        if (typeof args.reason !== 'string' || args.reason.trim().length === 0) throw new Error('reason must be non-empty free text')
        const evidenceRefs = Array.isArray(args.evidenceRefs) ? (args.evidenceRefs as string[]) : []
        if (outcome === 'falsified' && evidenceRefs.length === 0) {
          throw new Error('a falsified candidate must cite the evidenceRefs that falsified it; a refutation without evidence is not one')
        }
        const ledger = await methodLedgerPlaneOf(ctx, caller)
        const view = await ledger.view(args.draftId)
        if (view.status === 'published') {
          return (
            `method_discard rejected: draft "${args.draftId}" is published as revision ${view.published?.revisionId}; ` +
            'a published revision is restored with method_rollback, not discarded'
          )
        }
        if (view.status === 'discarded') {
          return `method_discard rejected: draft "${args.draftId}" is already discarded (${view.discardReason ?? 'no reason recorded'})`
        }
        const recorded = await ledger.discardDraft({
          draftId: args.draftId,
          reason: `${outcome}: ${args.reason}${evidenceRefs.length === 0 ? '' : ` [evidence: ${evidenceRefs.join(', ')}]`}`,
          actor: caller,
        })
        const env = environmentPlaneOf(ctx)
        const cleaned = await env.removeEnvironmentDraft(caller, args.draftId).then(
          () => true,
          error => {
            // The ledger line is the durable fact; a draft directory that was
            // already gone is not a reason to lose the refusal. Anything else is.
            if (/is absent; nothing to discard/.test(message(error))) return false
            throw error
          },
        )
        return [
          ...renderDiscard(recorded, outcome, args.reason),
          cleaned ? 'the draft working directory was removed' : 'the draft working directory was already absent',
        ].join('\n')
      } catch (error) {
        return `method_discard rejected: ${message(error)}`
      }
    },
  })
}
