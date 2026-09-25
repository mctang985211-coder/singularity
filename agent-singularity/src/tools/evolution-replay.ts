/**
 * `evolution_replay` (guide §2.7.6, W15): run a prepared mechanical mutation's
 * replay — the candidate against this graph's historical terminal tasks (the
 * champions) — and record the comparison.
 *
 * The experiment itself (champion records, the per-targetType replay path, the
 * report and its ledger record) lives in
 * `@dangosys/dsh-singularity-evolution`; this adapter declares the tool, takes
 * the caller's identity from the live call, and renders the result.
 * @module dsh-singularity-agent/tools/evolution-replay
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import { PRESET_REPLAY_MANUAL_REASON, runReplayExperiment } from '@dangosys/dsh-singularity-evolution'
import type { ReplayExperimentResult, ReplayTaskComparison } from '@dangosys/dsh-singularity-evolution'

const text = (value: string) => [{ type: 'text' as const, text: value }]

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_replay: missing agent id')
  return id
}

function renderCriterionDiff(diff: ReplayTaskComparison['criteriaDiff']): string {
  if (diff.length === 0) return 'no criterion diff'
  return diff.map(item => `${item.criterionId} ${item.champion ?? '—'}→${item.candidate ?? '—'}`).join(', ')
}

/** The comparison groups as the caller reads them: one line per task, champion side first. */
function renderResult(result: ReplayExperimentResult): string {
  if (result.manual) {
    return [
      `proposal ${result.proposalId} [replayed] manual — nothing was executed`,
      PRESET_REPLAY_MANUAL_REASON,
      `report: ${result.reportPath}`,
      'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
    ].join('\n')
  }
  const renderGroup = (title: string, group: readonly ReplayTaskComparison[]) => [
    `${title} (${group.length}):`,
    ...group.map(item =>
      `  ${item.taskId} champion ${item.champion.outcome} → candidate ${item.candidate!.outcome} ` +
      `(${renderCriterionDiff(item.criteriaDiff)}) — ${item.relation}`),
  ]
  return [
    `proposal ${result.proposalId} [replayed] ${result.targetType} ${result.targetId} — verdict: ${result.report.verdict}`,
    ...renderGroup('observed', result.observed),
    result.holdout.length === 0
      ? 'holdout: not run (no holdoutTaskIds given)'
      : renderGroup('holdout', result.holdout).join('\n'),
    `report: ${result.reportPath}`,
    'comparison only — the replay ran as new evolution-replay tasks; the historical tree and production were not changed',
    'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
  ].join('\n')
}

export function defineEvolutionReplayTool(ctx: Context) {
  return defineTool({
    name: 'evolution_replay',
    description:
      'Replay a prepared mechanical EvolutionProposal against this graph\'s historical terminal tasks (status: replayed). ' +
      'Per targetType: capability re-runs each champion task with the mutation entry as a per-run capability overlay, ' +
      'skill re-runs with the sandbox skills/ shadowing production for the replay worker, task_definition re-runs the ' +
      'candidate definition\'s criteria through the verifier alone (deterministic criteria replay, no worker), and ' +
      'agent_preset is manual in v1 (the preset roster cannot mount sandbox presets) — nothing executes and the report ' +
      'says so. Every replayed task is a new parentless task tagged evolution-replay:<proposalId>; the historical tree ' +
      'and production are never touched. Writes sandbox/<proposalId>/replay-report.json and records the ledger entry; ' +
      'cite that path in evolution_gate\'s regressionEvidenceRefs.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Prepared proposal (mechanical mutation) to replay' },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Champion task ids (terminal: verified/failed) to replay against — the observed set',
      },
      holdoutTaskIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Champion task ids replayed the same way but reported as the held-out group',
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      try {
        const result = await runReplayExperiment(
          { evolution: ctx.evolution, graphs: ctx.graphs, task: ctx.task, taskRuntime: ctx.taskRuntime },
          {
            proposalId: args.proposalId,
            taskIds: (args.taskIds as unknown[]).map(id => String(id)),
            holdoutTaskIds: ((args.holdoutTaskIds as unknown[] | undefined) ?? []).map(id => String(id)),
            caller,
            signal: exec.signal,
          },
        )
        return renderResult(result)
      } catch (error) {
        return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
