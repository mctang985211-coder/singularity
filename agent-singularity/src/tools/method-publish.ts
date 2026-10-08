/**
 * `method_publish`: the one place a method candidate becomes the effective
 * revision. The tool reads the pointer, refuses a candidate the frozen strategy
 * did not admit — without asking anyone — re-runs the pre-publish check, asks for
 * exactly one approval showing the complete difference, re-checks after the
 * approval, and then hands the switch to the pointer transaction under the
 * expected-state compare-and-swap the approval displayed.
 *
 * @module @dangosys/dsh-singularity-agent/tools/method-publish
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Admission, StrategyDecisionRecord } from '@dangosys/dsh-singularity-evolution'
import { denialReason, message, sessionId, text, undeclaredParameters } from '../shared.ts'
import {
  candidateRevisionOf,
  deciderFor,
  environmentPlaneOf,
  methodLedgerPlaneOf,
  methodModeFor,
} from './method-shared.ts'
import { diffOfRevisions, renderDiff, renderPublishOutcome, renderPublishReason, renderRecoveredIntent } from './method-render.ts'

const PARAMETERS = ['draftId', 'expectedActiveRevision', 'expectedGeneration', 'reason'] as const

/** The admission one draft's landed decision holds, or a refusal naming what is missing. */
function admissionOf(decision: StrategyDecisionRecord | undefined, draftId: string): Admission | string {
  if (decision === undefined) {
    return `no landed strategy decision covers draft "${draftId}"; a candidate is measured (method_evaluate) before it is published`
  }
  const admission = decision.admissions.find(entry => entry.candidateId === draftId)
  if (admission === undefined) return `the landed strategy decision names no admission for draft "${draftId}"`
  if (!admission.admissible) {
    return (
      `the frozen strategy did not admit this candidate (${admission.reasonCode}) — ${admission.reason}; ` +
      'a refused candidate consumes no approval, so none was requested'
    )
  }
  return admission
}

export function defineMethodPublishTool(ctx: Context) {
  return defineTool({
    name: 'method_publish',
    description:
      'Publish one evaluated candidate as this library\'s effective revision. The expected active revision and generation are ' +
      'required: they are the compare-and-swap pair the approval shows, and a pointer anyone else moved refuses this call. A ' +
      'candidate the frozen strategy did not admit is refused here without asking anyone. Otherwise exactly one approval is ' +
      'requested, showing the complete asset difference, the evaluation and the exact version switch; after it is granted the ' +
      'graph, the pointer and the pre-publish check are re-read, and only then does the pointer transaction run. An open pointer ' +
      'intent for this same candidate is continued without a second approval.',
    parameters: {
      draftId: { type: 'string', required: true, description: 'The evaluated draft to publish' },
      expectedActiveRevision: { type: 'string', required: true, description: 'The active revision id the approval displays' },
      expectedGeneration: { type: 'integer', required: true, description: 'The pointer generation the approval displays' },
      reason: { type: 'string', description: 'Anything the approver should know beyond the rendered evidence' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args as Record<string, unknown>, PARAMETERS, 'method_publish')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'method_publish')
      const agent = exec.agent
      if (agent === undefined) throw new Error('method_publish: missing agent')
      try {
        if (typeof args.draftId !== 'string' || args.draftId.length === 0) throw new Error('draftId is required')
        if (typeof args.expectedActiveRevision !== 'string' || args.expectedActiveRevision.length === 0) {
          throw new Error('expectedActiveRevision is required: the approval displays the pointer this publication replaces')
        }
        if (!Number.isInteger(args.expectedGeneration) || (args.expectedGeneration as number) < 0) {
          throw new Error('expectedGeneration is required: the second half of the pointer compare-and-swap pair')
        }
        const env = environmentPlaneOf(ctx)
        const ledger = await methodLedgerPlaneOf(ctx, caller)
        const view = await env.activeEnvironmentView(caller)
        if (view.readOnly) {
          return `method_publish rejected: library "${view.libraryId}" is read-only (${view.protocol}); nothing was written`
        }
        if (view.revisionId !== args.expectedActiveRevision || view.generation !== args.expectedGeneration) {
          return [
            `method_publish rejected: the active pointer is ${view.revisionId} g${view.generation}, not the approved`,
            `${args.expectedActiveRevision} g${String(args.expectedGeneration)} — a third party moved it (or the approval displayed a stale pointer).`,
            'nothing was written; re-read the library and approve the switch that is actually in front of you.',
          ].join(' ')
        }

        const intent = await env.openPointerIntent(caller)
        if (intent !== null) {
          const mine =
            intent.direction === 'publish' &&
            intent.draftId === args.draftId &&
            intent.expected?.revisionId === args.expectedActiveRevision
          if (!mine) {
            return [
              `method_publish rejected: pointer intent ${intent.intentId} (${intent.direction} → ${intent.next.revisionId}) is open,`,
              'so this library is mid-switch for another candidate; nothing was written. Settle it (restart, or a retry of the tool that opened it) first.',
            ].join(' ')
          }
          // The intent this draft's own publication left open binds the approval
          // it was granted: it is settled, and nobody is asked again.
          const results = await env.reconcilePointer(caller)
          const settled = results.find(entry => entry.intentId === intent.intentId)
          if (settled === undefined) {
            return `method_publish: no pointer moved — the open intent ${intent.intentId} reported no outcome; nothing was written`
          }
          if (settled.result !== 'blocked') {
            await ledger.markPublished({
              draftId: args.draftId,
              revisionId: intent.next.revisionId,
              supersededRevisionId: intent.expected?.revisionId ?? null,
              intentId: intent.intentId,
              ...(intent.approvalRef === undefined ? {} : { approvalRef: intent.approvalRef }),
              actor: caller,
            })
          }
          const recoveredMode = await methodModeFor(ctx, caller)
          return [...renderRecoveredIntent(intent, settled), `mode ${recoveredMode}; decided by ${deciderFor(recoveredMode)}`].join('\n')
        }

        const report = await ledger.evaluationOf(args.draftId)
        if (report === undefined) {
          return `method_publish rejected: draft "${args.draftId}" carries no evaluation; only a measured candidate is published. Nothing was written.`
        }
        const decision = await ledger.decisionFor(args.draftId)
        const admission = admissionOf(decision, args.draftId)
        if (typeof admission === 'string') {
          return `method_publish rejected: ${admission}. Nothing was written and no approval was requested.`
        }
        if (decision === undefined) throw new Error('unreachable: a missing decision was refused above')

        try {
          await ledger.validatePrePublish(report)
        } catch (error) {
          return [
            `method_publish rejected: the pre-publish re-check of report ${report.evaluationId} refused this candidate — ${message(error)};`,
            'nothing was written and no approval was requested.',
          ].join(' ')
        }

        const draft = await ledger.view(args.draftId)
        const mode = await methodModeFor(ctx, caller)
        const decider = deciderFor(mode)
        const library = { id: ledger.libraryId, root: ledger.root }
        const baselineRevision = await env.activeRevisionFor(caller).catch(() => undefined)
        const candidateRevision = await candidateRevisionOf(library, args.draftId)
        if (candidateRevision === undefined) {
          return `method_publish rejected: draft "${args.draftId}" has no draft directory; nothing was written.`
        }
        const diff = renderDiff(
          await diffOfRevisions(baselineRevision ?? null, candidateRevision).catch(() => ({
            from: baselineRevision?.manifest.revisionId ?? null,
            to: candidateRevision.manifest.revisionId,
            files: [],
            digest: 'unavailable',
          })),
        )
        const pointer = { revisionId: view.revisionId, generation: view.generation, manifestDigest: view.manifestDigest }
        const approvalRef = `approval:${exec.callId}`
        {
          const reason = renderPublishReason({
            draft: draft.draft,
            report,
            admission,
            calibration: decision.calibration,
            diff,
            pointer,
            candidate: { revisionId: candidateRevision.manifest.revisionId, manifestDigest: candidateRevision.manifest.contentDigest },
            mode,
            rollbackToRevisionId: view.revisionId,
            decider,
            ...(typeof args.reason === 'string' && args.reason.length > 0 ? { extra: [`note: ${args.reason}`] } : {}),
          })
          const outcome = await ctx.approval.request({
            agent,
            toolName: 'method_publish',
            callId: exec.callId,
            reason,
            signal: exec.signal,
          })
          if (outcome !== 'allowed-once') {
            return `method_publish: no pointer moved — ${denialReason(outcome)}; draft ${args.draftId} stays evaluated and nothing was written`
          }
        }

        // The approval is the human's for the state they were shown. Re-read the
        // graph's own mode, the pointer and the report before writing: a graph the
        // approval window reconfigured, or a pointer that moved, refuses here
        // rather than switching to something nobody approved.
        const [recheck, recheckMode] = await Promise.all([env.activeEnvironmentView(caller), methodModeFor(ctx, caller)])
        if (recheck.revisionId !== args.expectedActiveRevision || recheck.generation !== args.expectedGeneration) {
          return [
            `method_publish: no pointer moved — the pointer is now ${recheck.revisionId} g${recheck.generation}, not the approved`,
            `${args.expectedActiveRevision} g${String(args.expectedGeneration)}; the approval is spent and no second one is requested.`,
          ].join(' ')
        }
        if (recheckMode !== mode) {
          return `method_publish: no pointer moved — this graph's method mode changed from ${mode} to ${recheckMode} while the approval was open.`
        }
        try {
          await ledger.validatePrePublish(report)
        } catch (error) {
          return `method_publish: no pointer moved — the post-approval re-check refused this candidate — ${message(error)}`
        }

        const published = await env.publishRevision(caller, {
          direction: 'publish',
          source: { kind: 'draft', draftId: args.draftId },
          expected: { revisionId: args.expectedActiveRevision, generation: args.expectedGeneration as number },
          approvalRef,
          actor: caller,
        })
        await ledger.markPublished({
          draftId: args.draftId,
          revisionId: published.pointer.revisionId,
          supersededRevisionId: published.supersededRevisionId,
          intentId: published.completion.intentId,
          approvalRef,
          actor: caller,
        })
        return [...renderPublishOutcome(published, mode, decider)].join('\n')
      } catch (error) {
        return `method_publish rejected: ${message(error)}`
      }
    },
  })
}
