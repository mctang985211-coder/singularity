/**
 * `method_list`: the one read of the method's state — the effective revision, the
 * drafts, which Runs are explicitly trying which candidate, the compact history
 * the strategy folds and what it suggests next. A pure read: no plane write is
 * called and no pointer is touched.
 *
 * @module @dangosys/dsh-singularity-agent/tools/method-list
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dangosys/dsh-singularity-graphs'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { optionalService } from '@dangosys/dsh-singularity-task-runtime'
import type { TaskRun, TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { DraftView, MethodAssetKind, MethodListFilter } from '@dangosys/dsh-singularity-evolution'
import { message, sessionId, text, undeclaredParameters } from '../shared.ts'
import { environmentPlaneOf, methodGraphFor, methodLedgerPlaneOf, methodModeFor, strategyPlaneOf } from './method-shared.ts'
import { renderDraftLine } from './method-render.ts'

const PARAMETERS = ['kind', 'status', 'identity', 'detail'] as const

/** The task store this graph's Runs live in, or nothing when the deployment offers no task service. */
async function snapshotFor(ctx: Context, caller: string): Promise<TaskSnapshot | undefined> {
  const task = optionalService<{ openStore(storeId: string): Promise<TaskSnapshot> }>(ctx, 'task')
  if (task === undefined) return undefined
  const graph = await methodGraphFor(ctx, caller)
  return await task.openStore(rootTaskStoreId(graph.rootSessionId)).catch(() => undefined)
}

/** Every Run that explicitly binds a candidate, by the candidate it binds. */
function trialBindings(runs: readonly TaskRun[]): Map<string, string[]> {
  const bindings = new Map<string, string[]>()
  for (const run of runs) {
    if (run.trialCandidateRef === undefined) continue
    bindings.set(run.trialCandidateRef, [...(bindings.get(run.trialCandidateRef) ?? []), run.runId])
  }
  return bindings
}

export function defineMethodListTool(ctx: Context) {
  return defineTool({
    name: 'method_list',
    description:
      'Read this library\'s method state: the effective revision and pointer, every draft with its status and last verdict, which ' +
      'Runs are explicitly trying which candidate, the compact history (measured rounds, and a bounded table of refusals that were ' +
      'never measured), what the strategy suggests next, and any pointer switch that is open. Use it before drafting a candidate and ' +
      'when deciding whether to publish, discard or stop searching. This tool only reads.',
    parameters: {
      kind: { type: 'string', enum: ['skill', 'task-template', 'capability'], description: 'Only drafts of this asset class' },
      status: { type: 'string', enum: ['draft', 'evaluated', 'discarded', 'published'], description: 'Only drafts in this state' },
      identity: { type: 'string', description: 'Only drafts for this asset identity' },
      detail: { type: 'string', enum: ['compact', 'full'], description: 'compact (default) renders the recent history; full renders every draft line' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const undeclared = undeclaredParameters(args as Record<string, unknown>, PARAMETERS, 'method_list')
      if (undeclared !== undefined) return undeclared
      const caller = sessionId(exec, 'method_list')
      try {
        const env = environmentPlaneOf(ctx)
        const ledger = await methodLedgerPlaneOf(ctx, caller)
        // The graph's own strategy switch: the history folds and steers under
        // the same policy the evaluations were measured with.
        const strategy = strategyPlaneOf(ledger.policy)
        const view = await env.activeEnvironmentView(caller)
        const mode = await methodModeFor(ctx, caller)
        const filter: MethodListFilter = {
          ...(args.kind === undefined ? {} : { kind: args.kind as MethodAssetKind }),
          ...(args.status === undefined ? {} : { status: args.status as DraftView['status'] }),
        }
        const drafts = (await ledger.list(filter)).filter(
          draft => args.identity === undefined || draft.draft.identity === args.identity,
        )
        const intent = await env.openPointerIntent(caller)
        const snapshot = await snapshotFor(ctx, caller)
        const bindings = trialBindings(snapshot?.runs ?? [])

        const facts = await ledger.history()
        const history = strategy.foldHistory(facts, strategy.policy, facts.candidates.length)
        const detail = args.detail === 'full' ? 'full' : 'compact'
        const rendered = strategy.renderHistory(history, detail === 'full' ? drafts.length + 1 : 8)
        const measuredEntries = history.entries.filter(entry => entry.measured)
        const stall = history.roundsWithoutQualityGain >= strategy.policy.stallRounds ? 1 : 0
        const exploration = strategy.exploration(facts.candidates.length, stall, history.triedMechanisms, strategy.policy.stall.reservedDrafts)

        const lines: string[] = [
          `method state — library ${view.libraryId} (${view.protocol})`,
          `  active revision ${view.revisionId} g${view.generation} (${view.manifestDigest.slice(0, 12)})${view.trialCandidateRef === undefined ? '' : `, trial candidate ${view.trialCandidateRef}`}${view.readOnly ? ' [read-only]' : ''}`,
          `  mode ${mode}; policy ${strategy.policy.version} (rounds ${strategy.policy.rounds}, trials ${strategy.policy.trials}, edit budget ${strategy.policy.editBudget.max}→${strategy.policy.editBudget.min})`,
          `drafts (${drafts.length})${detail === 'full' ? '' : ', most recent first'}:`,
          ...(drafts.length === 0
            ? ['  (none)']
            : (detail === 'full' ? drafts : drafts.slice(-8)).map(draft => {
                const trial = bindings.get(draft.draft.draftId)
                return `${renderDraftLine(draft)}${trial === undefined ? '' : ` (tried by ${trial.length} run(s): ${trial.join(', ')})`}`
              })),
          measuredEntries.length === 0
            ? `history: nothing measured yet${history.entries.length === 0 ? '' : ` (${history.entries.length} candidate(s) never measured, so the denominator stays empty)`}`
            : `history (scope ${history.scope || '(none)'}):`,
          ...(measuredEntries.length === 0
            ? []
            : rendered.map(
                entry =>
                  `  round ${entry.round} ${entry.candidateId} ${entry.measured ? (entry.deltaQuality === undefined ? 'measured' : `Δquality ${entry.deltaQuality.toFixed(4)}`) : 'not measured'} ` +
                  `→ ${entry.outcome}${entry.reasonCode === undefined ? '' : ` (${entry.reasonCode})`}`,
              )),
          `  best quality ${history.bestQuality === undefined ? '(none measured)' : history.bestQuality.toFixed(4)}; rounds without a quality gain ${history.roundsWithoutQualityGain}; steering ${history.steering}`,
          `  untouched candidate slots: ${exploration.reservedDrafts} of this round's candidates are reserved for untried mechanisms [${exploration.untried.join(', ')}]`,
          ...(bindings.size === 0
            ? ['trial: no Run is explicitly trying a candidate']
            : [`trial: ${[...bindings.entries()].map(([draftId, runs]) => `${draftId} tried by ${runs.join(', ')}`).join('; ')} (a trial never moves the active revision)`]),
          ...(history.simplificationCandidates.length === 0
            ? []
            : [`simplification suggestions (a deletion candidate is still measured on both sides before it publishes): ${history.simplificationCandidates.map(candidate => `${candidate.mechanism} via ${candidate.candidateIds.join(', ')}`).join('; ')}`]),
          ...(intent === null
            ? []
            : [`open pointer intent: ${intent.intentId} (${intent.direction} → ${intent.next.revisionId}, recorded ${intent.at}) — a switch is in flight; a retry of the publication that opened it continues it without a second approval`]),
          'next: method_draft (one candidate, its evidence and the budget) → method_evaluate (frozen cohort, ≥3 repetitions) → method_publish or method_discard',
        ]
        return lines.join('\n')
      } catch (error) {
        return `method_list rejected: ${message(error)}`
      }
    },
  })
}
