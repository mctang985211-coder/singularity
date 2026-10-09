/**
 * `method_rollback`: restore a revision this library published before. Same shape
 * as a publish — the pointer's expected state is required, one approval is
 * requested showing the reverse difference and the exact version switch, the
 * pointer is re-read after approval, and the pointer transaction runs under the
 * compare-and-swap the approval displayed.
 *
 * @module @dangosys/dsh-singularity-agent/tools/method-rollback
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import { readRevision } from '@dangosys/dsh-singularity-task-runtime'
import { denialReason, message, sessionId, text, undeclaredParameters } from '../shared.ts'
import { deciderFor, environmentPlaneOf, methodLedgerPlaneOf, methodModeFor, methodRsiStampFor } from './method-shared.ts'
import { diffOfRevisions, renderDiff, renderPublishOutcome, renderRecoveredIntent, renderVersionSwitch } from './method-render.ts'

const PARAMETERS = ['toRevisionId', 'expectedActiveRevision', 'expectedGeneration', 'reason'] as const

export function defineMethodRollbackTool(ctx: Context) {
  return defineTool({
    name: 'method_rollback',
    description:
      'Restore one revision this library published before. The expected active revision and generation are the compare-and-swap ' +
      'pair the approval shows; a pointer anyone else moved refuses the call. One approval is requested, showing the reverse ' +
      'asset difference and the exact switch; after it is granted the graph, the pointer and the target revision are re-read ' +
      'before the pointer transaction runs. A revision this library never held as effective is refused by name.',
    parameters: {
      toRevisionId: { type: 'string', required: true, description: 'The revision to restore; it must have been effective in this library before' },
      expectedActiveRevision: { type: 'string', required: true, description: 'The active revision id the approval displays' },
      expectedGeneration: { type: 'integer', required: true, description: 'The pointer generation the approval displays' },
      reason: { type: 'string', required: true, description: 'Why this method is rolled back' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args as Record<string, unknown>, PARAMETERS, 'method_rollback')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'method_rollback')
      const agent = exec.agent
      if (agent === undefined) throw new Error('method_rollback: missing agent')
      try {
        if (typeof args.toRevisionId !== 'string' || args.toRevisionId.length === 0) throw new Error('toRevisionId is required')
        if (typeof args.expectedActiveRevision !== 'string' || args.expectedActiveRevision.length === 0) throw new Error('expectedActiveRevision is required')
        if (!Number.isInteger(args.expectedGeneration) || (args.expectedGeneration as number) < 0) throw new Error('expectedGeneration is required')
        if (typeof args.reason !== 'string' || args.reason.trim().length === 0) throw new Error('reason must be non-empty free text')

        const env = environmentPlaneOf(ctx)
        const ledger = await methodLedgerPlaneOf(ctx, caller)
        const view = await env.activeEnvironmentView(caller)
        if (view.readOnly) {
          return `method_rollback rejected: library "${view.libraryId}" is read-only (${view.protocol}); nothing was written`
        }
        if (view.revisionId !== args.expectedActiveRevision || view.generation !== args.expectedGeneration) {
          return [
            `method_rollback rejected: the active pointer is ${view.revisionId} g${view.generation}, not the approved`,
            `${args.expectedActiveRevision} g${String(args.expectedGeneration)}; nothing was written.`,
          ].join(' ')
        }
        if (args.toRevisionId === view.revisionId) {
          return `method_rollback rejected: "${args.toRevisionId}" is the revision already in effect; nothing was written`
        }

        const drafts = await ledger.list()
        const effective = new Set<string>()
        for (const draft of drafts) {
          effective.add(draft.draft.baseRevision.revisionId)
          if (draft.published !== undefined) effective.add(draft.published.revisionId)
        }
        if (!effective.has(args.toRevisionId)) {
          return (
            `method_rollback rejected: revision "${args.toRevisionId}" was never effective in library "${ledger.libraryId}" — ` +
            'a rollback restores a revision this library published, it does not adopt an arbitrary one; nothing was written'
          )
        }
        const library = { id: ledger.libraryId, root: ledger.root }
        const target = await readRevision(library, args.toRevisionId)
        if (target === undefined) {
          return `method_rollback rejected: library "${ledger.libraryId}" holds no revision "${args.toRevisionId}"; nothing was written`
        }

        const mode = await methodModeFor(ctx, caller)
        const graphStamp = await methodRsiStampFor(ctx, caller)
        const decider = deciderFor(mode)
        const current = await env.activeRevisionFor(caller).catch(() => undefined)
        const diff = renderDiff(
          await diffOfRevisions(current ?? null, target).catch(() => ({
            from: current?.manifest.revisionId ?? null,
            to: target.manifest.revisionId,
            files: [],
            digest: 'unavailable',
          })),
        )
        const reason = [
          `Method rollback of library ${ledger.libraryId}`,
          renderVersionSwitch({
            pointer: { revisionId: view.revisionId, generation: view.generation, manifestDigest: view.manifestDigest },
            candidate: { revisionId: target.manifest.revisionId, manifestDigest: target.manifest.contentDigest },
            mode,
          }),
          ...diff,
          `mode: ${mode === 'auto' ? `auto (the platform policy decides and records; the decider is ${decider})` : `manual (a human decides; the decider is ${decider})`}`,
          `reason: ${args.reason}`,
          'nothing has been written yet; the pointer moves only if this approval is granted and the post-approval re-check still passes',
        ].join('\n')

        const rolledBackDraft = drafts.find(draft => draft.published?.revisionId === view.revisionId)
        const intent = await env.openPointerIntent(caller)
        if (intent !== null) {
          const mine =
            intent.direction === 'rollback' &&
            intent.next.revisionId === args.toRevisionId &&
            intent.expected?.revisionId === args.expectedActiveRevision
          if (!mine) {
            return `method_rollback rejected: pointer intent ${intent.intentId} (${intent.direction} → ${intent.next.revisionId}) is open; nothing was written`
          }
          // The intent already binds the grant this switch was approved under: it
          // is settled, not asked for again.
          const results = await env.reconcilePointer(caller)
          const settled = results.find(entry => entry.intentId === intent.intentId)
          if (settled === undefined) {
            return `method_rollback: no pointer moved — the open intent ${intent.intentId} reported no outcome; nothing was written`
          }
          if (settled.result !== 'blocked') {
            await ledger.markRolledback({
              draftId: rolledBackDraft?.draft.draftId ?? null,
              revisionId: intent.next.revisionId,
              supersededRevisionId: intent.expected?.revisionId ?? null,
              intentId: intent.intentId,
              ...(intent.approvalRef === undefined ? {} : { approvalRef: intent.approvalRef }),
              actor: caller,
            })
          }
          return [...renderRecoveredIntent(intent, settled), `mode ${mode}; decided by ${decider}`].join('\n')
        }
        const approvalRef = `approval:${exec.callId}`
        const outcome = await ctx.approval.request({
          agent,
          toolName: 'method_rollback',
          callId: exec.callId,
          reason,
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          return `method_rollback: no pointer moved — ${denialReason(outcome)}; nothing was written`
        }

        const [recheck, recheckStamp] = await Promise.all([env.activeEnvironmentView(caller), methodRsiStampFor(ctx, caller)])
        if (recheck.revisionId !== args.expectedActiveRevision || recheck.generation !== args.expectedGeneration) {
          return [
            `method_rollback: no pointer moved — the pointer is now ${recheck.revisionId} g${recheck.generation}, not the approved`,
            `${args.expectedActiveRevision} g${String(args.expectedGeneration)}; the approval is spent and no second one is requested.`,
          ].join(' ')
        }
        if (recheckStamp !== graphStamp) {
          return `method_rollback: no pointer moved — this graph's rsi configuration was cleared or replaced while the approval was open; the approval is spent and no second one is requested.`
        }
        const targetAgain = await readRevision(library, args.toRevisionId)
        if (targetAgain === undefined || targetAgain.manifest.contentDigest !== target.manifest.contentDigest) {
          return `method_rollback: no pointer moved — revision "${args.toRevisionId}" changed or vanished while the approval was open.`
        }

        const rolledback = await env.rollbackRevision(caller, {
          direction: 'rollback',
          source: { kind: 'revision', revisionId: args.toRevisionId },
          expected: { revisionId: args.expectedActiveRevision, generation: args.expectedGeneration as number },
          approvalRef,
          actor: caller,
        })
        await ledger.markRolledback({
          draftId: rolledBackDraft?.draft.draftId ?? null,
          revisionId: rolledback.pointer.revisionId,
          supersededRevisionId: rolledback.supersededRevisionId,
          intentId: rolledback.completion.intentId,
          approvalRef,
          actor: caller,
        })
        return [
          ...renderPublishOutcome(rolledback, mode, decider),
          `next Runs admit against "${rolledback.pointer.revisionId}"; the candidate this rollback left stays on the ledger as its own record`,
        ].join('\n')
      } catch (error) {
        return `method_rollback rejected: ${message(error)}`
      }
    },
  })
}
