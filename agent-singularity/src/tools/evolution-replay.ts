/**
 * `evolution_replay` (guide §2.7.6, W15): run a prepared mechanical mutation's
 * replay — the candidate against this graph's historical terminal tasks (the
 * champions) — and record the comparison. The replay is a comparison
 * experiment: it creates new parentless replay tasks (objective and review
 * anomalies tagged `evolution-replay:<proposalId>`), never edits the historical
 * tree, and never touches production.
 *
 * Per targetType:
 * - `capability`: the champion task re-runs through the real spawn + verify
 *   chain with the mutation's entry as a whole-row `capabilityOverrides`
 *   overlay for that run only.
 * - `skill`: same chain, with the sandbox's `skills/` dir as an
 *   `extraSkillRoots` overlay — the sandbox skill shadows the same-name
 *   production skill for the replay worker alone.
 * - `task_definition`: deterministic criteria replay — no worker spawn; the
 *   candidate definition's criteria run through the verifier in the graph env.
 * - `agent_preset`: manual in v1 — the agent-presets roster scans
 *   constructor-fixed roots and cannot mount a sandbox-materialized preset, so
 *   nothing executes and the report records the boundary honestly.
 *
 * The champion side of every comparison is the historical task's own terminal
 * review record (self-contained: outcome / criteria / durationMs), never a
 * re-execution. The report lands at `sandbox/<proposalId>/replay-report.json`
 * and the ledger's `replayed` record cites it; `evolution_gate` requires that
 * path in its regression evidence.
 *
 * Skill candidates are content-bound (P2): the candidate file is verified
 * against the SHA-256 prepare recorded before any run starts, the report names
 * that identity, and the service re-verifies the file after the runs before the
 * `replayed` record is written — a candidate that changed and stayed changed is
 * refused, not recorded.
 * @module dsh-singularity-agent/tools/evolution-replay
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  ReviewCriterion,
  ReviewRecord,
  TaskInstance,
  TaskSnapshot,
  VerificationMode,
} from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { ReplayRunOutcome, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import type {} from '@dangosys/dsh-singularity-task-runtime'
import type {
  CapabilityMutation,
  ReplayCriterionSummary,
  ReplayReport,
  ReplaySideSummary,
  ReplayTaskComparison,
} from '../evolution.ts'
import { compareReplaySides, overallReplayVerdict } from '../evolution.ts'

const text = (value: string) => [{ type: 'text' as const, text: value }]

/** The lineage tag every replay artifact (objective, review anomalies) carries. */
export function replayLineage(proposalId: string): string {
  return `evolution-replay:${proposalId}`
}

/** Why agent_preset replay is manual in v1 — recorded verbatim in the report. */
export const PRESET_REPLAY_MANUAL_REASON =
  'agent_preset replay is manual in v1: the agent-presets roster (AgentPresets.resolve/mount) scans constructor-fixed roots ' +
  'only and cannot mount a sandbox-materialized preset without reconfiguring the production service; review the sandbox ' +
  'composition under .agent-presets/ by hand and answer the gate accordingly'

const VERIFICATION_MODES: readonly VerificationMode[] = ['deterministic', 'simulation', 'formal', 'measurement', 'review', 'composite']

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_replay: missing agent id')
  return id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The terminal review record of a champion task's latest run — the comparison anchor. */
function championRecord(snapshot: TaskSnapshot, task: TaskInstance): ReviewRecord | undefined {
  const runId = task.runIds[task.runIds.length - 1]
  return snapshot.reviews.find(item => item.runId === runId)
}

function sideFromRecord(task: TaskInstance, record: ReviewRecord): ReplaySideSummary {
  return {
    taskId: task.taskId,
    ...(record.runId === undefined ? {} : { runId: record.runId }),
    outcome: record.outcome as ReplaySideSummary['outcome'],
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    criteria: (record.criteria ?? []).map((item: ReviewCriterion) => ({
      criterionId: item.criterionId,
      verdict: item.verdict,
      ...(item.command === undefined ? {} : { command: item.command }),
      ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    })),
  }
}

function sideFromOutcome(outcome: ReplayRunOutcome): ReplaySideSummary {
  return {
    taskId: outcome.taskId,
    runId: outcome.runId,
    outcome: outcome.status,
    ...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
    criteria: (outcome.criteria ?? []).map((item: ReviewCriterion) => ({
      criterionId: item.criterionId,
      verdict: item.verdict,
      ...(item.command === undefined ? {} : { command: item.command }),
      ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    })),
  }
}

/**
 * Normalize the candidate definition's contract for a deterministic criteria
 * replay. The definition is the free-form object the mutation carried; the
 * replay needs real criteria, so a missing/empty `acceptanceCriteria` or a
 * criterion without a `criterionId` fails loudly. Fields the definition omits
 * (objective / requiredCapabilities) fall back to the champion task's.
 */
function candidateContract(
  definition: unknown,
  champion: TaskInstance,
): { objective: string; acceptanceCriteria: AcceptanceCriterion[]; requiredCapabilities: string[] } {
  if (!isRecord(definition)) throw new Error('evolution_replay: the sandbox task-definition.json must hold an object')
  const rawCriteria = definition.acceptanceCriteria
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0) {
    throw new Error('evolution_replay: the candidate definition must carry a non-empty acceptanceCriteria array')
  }
  const acceptanceCriteria: AcceptanceCriterion[] = rawCriteria.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}] must be an object`)
    if (typeof raw.criterionId !== 'string' || raw.criterionId.length === 0) {
      throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].criterionId must be a non-empty string`)
    }
    const command = raw.command === undefined ? undefined : raw.command
    if (command !== undefined && typeof command !== 'string') {
      throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].command must be a string`)
    }
    const mode = raw.verificationMode ?? (command === undefined ? 'review' : 'deterministic')
    if (typeof mode !== 'string' || !VERIFICATION_MODES.includes(mode as VerificationMode)) {
      throw new Error(`evolution_replay: candidate acceptanceCriteria[${index}].verificationMode must be one of ${VERIFICATION_MODES.join(' / ')}`)
    }
    return {
      criterionId: raw.criterionId,
      description: typeof raw.description === 'string' ? raw.description : '',
      verificationMode: mode as VerificationMode,
      requiredEvidence: Array.isArray(raw.requiredEvidence) ? raw.requiredEvidence.filter((item): item is string => typeof item === 'string') : [],
      mandatory: typeof raw.mandatory === 'boolean' ? raw.mandatory : true,
      ...(command === undefined ? {} : { command }),
    }
  })
  return {
    objective: typeof definition.objective === 'string' && definition.objective.length > 0 ? definition.objective : champion.objective,
    acceptanceCriteria,
    requiredCapabilities: Array.isArray(definition.requiredCapabilities)
      ? definition.requiredCapabilities.filter((item): item is string => typeof item === 'string')
      : [...champion.requestedCapabilities],
  }
}

function renderCriterionDiff(diff: ReplayTaskComparison['criteriaDiff']): string {
  if (diff.length === 0) return 'no criterion diff'
  return diff.map(item => `${item.criterionId} ${item.champion ?? '—'}→${item.candidate ?? '—'}`).join(', ')
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
      let proposal
      try {
        proposal = await ctx.evolution.get(args.proposalId)
      } catch (error) {
        return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      if (proposal.status !== 'prepared') {
        return `evolution_replay rejected: proposal ${proposal.proposalId} is ${proposal.status}; only a prepared proposal can be replayed`
      }
      const prepared = proposal.prepared!
      if (!prepared.mechanical) {
        return `evolution_replay rejected: proposal ${proposal.proposalId} is bookkeeping-only (mechanical: false); nothing to replay — gate it directly with evolution_gate`
      }
      // P2 content binding: before anything executes, the candidate file must
      // still be the exact content prepare recorded (regular file, no symlinked
      // path, digest match). The overlay below shadows this same file for the
      // replay worker — never the production skill — so what runs is what was
      // checked. The service re-verifies after the runs, before the replayed
      // record is written.
      if (proposal.targetType === 'skill') {
        try {
          await ctx.evolution.readSkillCandidate(proposal.proposalId)
        } catch (error) {
          return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      const lineage = replayLineage(proposal.proposalId)

      // agent_preset: the v1 manual boundary — record it, execute nothing.
      if (proposal.targetType === 'agent_preset') {
        const report: ReplayReport = {
          formatVersion: 1,
          proposalId: proposal.proposalId,
          targetType: proposal.targetType,
          at: new Date().toISOString(),
          mode: 'manual',
          manualReason: PRESET_REPLAY_MANUAL_REASON,
          observed: [],
          holdout: { executed: false, tasks: [] },
          verdict: 'manual',
        }
        try {
          await ctx.evolution.replay(proposal.proposalId, caller, report)
        } catch (error) {
          return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`
        }
        return [
          `proposal ${proposal.proposalId} [replayed] manual — nothing was executed`,
          PRESET_REPLAY_MANUAL_REASON,
          `report: ${prepared.sandbox}/replay-report.json`,
          'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
        ].join('\n')
      }

      const taskIds = (args.taskIds as unknown[]).map(id => String(id))
      const holdoutIds = ((args.holdoutTaskIds as unknown[] | undefined) ?? []).map(id => String(id))
      if (taskIds.length === 0) return 'evolution_replay rejected: taskIds must name at least one champion task'
      if (new Set([...taskIds, ...holdoutIds]).size !== taskIds.length + holdoutIds.length) {
        return 'evolution_replay rejected: taskIds and holdoutTaskIds must not overlap or repeat'
      }

      let snapshot: TaskSnapshot
      let storeId: string
      try {
        const graph = await ctx.graphs.graphForSession(caller)
        storeId = rootTaskStoreId(graph.rootSessionId)
        snapshot = await ctx.task.openStore(storeId)
      } catch (error) {
        return `evolution_replay rejected: cannot open this graph\'s task store: ${error instanceof Error ? error.message : String(error)}`
      }

      // Validate every champion up front — a replay that starts must not die
      // halfway on a task that was never replayable.
      const champions = new Map<string, { task: TaskInstance; record: ReviewRecord }>()
      for (const taskId of [...taskIds, ...holdoutIds]) {
        const task = snapshot.tasks.find(item => item.taskId === taskId)
        if (task === undefined) return `evolution_replay rejected: unknown task "${taskId}" in this graph's task store`
        if (task.status !== 'verified' && task.status !== 'failed') {
          return `evolution_replay rejected: task "${taskId}" is ${task.status}; only a terminal (verified or failed) task can be a replay champion`
        }
        const record = championRecord(snapshot, task)
        if (record === undefined) {
          return `evolution_replay rejected: task "${taskId}" has no review record on its latest run; nothing to compare the candidate against`
        }
        champions.set(taskId, { task, record })
      }

      const sandboxAbs = join(ctx.evolution.root, prepared.sandbox!)
      const mutation = proposal.mutation
      const comparisons: { taskId: string; holdout: boolean; comparison: ReplayTaskComparison }[] = []
      try {
        for (const [taskId, holdout] of [...taskIds.map(id => [id, false] as const), ...holdoutIds.map(id => [id, true] as const)]) {
          const { task: champion, record } = champions.get(taskId)!
          let options: Pick<ReplayTaskOptions, 'overlay' | 'contract' | 'spawn'>
          if (proposal.targetType === 'capability') {
            const capability = mutation as CapabilityMutation
            options = { overlay: { capabilityOverrides: { [capability.name]: capability.entry } } }
          } else if (proposal.targetType === 'skill') {
            // The overlay root is exactly the dir holding the candidate file
            // verified above (`skills/<name>/SKILL.md`) — the replay worker
            // shadows the same-name production skill with it for that run only.
            options = { overlay: { extraSkillRoots: [join(sandboxAbs, 'skills')] } }
          } else if (proposal.targetType === 'task_definition') {
            const definition = JSON.parse(await readFile(join(sandboxAbs, 'task-definition.json'), 'utf8'))
            options = { contract: candidateContract(definition, champion), spawn: false }
          } else {
            throw new Error(`evolution_replay: targetType "${proposal.targetType}" has no replay path`)
          }
          const outcome = await ctx.taskRuntime.replayTask(storeId, taskId, { lineage, ...options, signal: exec.signal }, caller)
          const championSide = sideFromRecord(champion, record)
          const candidateSide = sideFromOutcome(outcome)
          comparisons.push({
            taskId,
            holdout,
            comparison: {
              taskId,
              candidateTaskId: outcome.taskId,
              champion: championSide,
              candidate: candidateSide,
              ...compareReplaySides(championSide, candidateSide),
            },
          })
        }
      } catch (error) {
        return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)} (no replay was recorded; ${comparisons.length} run(s) already settled stay in the task store as evidence)`
      }

      const observed = comparisons.filter(item => !item.holdout).map(item => item.comparison)
      const holdout = comparisons.filter(item => item.holdout).map(item => item.comparison)
      const report: ReplayReport = {
        formatVersion: 1,
        proposalId: proposal.proposalId,
        targetType: proposal.targetType,
        at: new Date().toISOString(),
        mode: 'executed',
        // P2: a skill report names the candidate content identity the runs went
        // through — the one verified above and re-verified by the service.
        ...(proposal.targetType === 'skill' ? { candidateContent: prepared.skillContent } : {}),
        observed,
        holdout: { executed: holdout.length > 0, tasks: holdout },
        verdict: overallReplayVerdict([...observed, ...holdout]),
      }
      let replayed
      try {
        replayed = await ctx.evolution.replay(proposal.proposalId, caller, report)
      } catch (error) {
        return `evolution_replay rejected: ${error instanceof Error ? error.message : String(error)}`
      }
      const renderGroup = (title: string, group: ReplayTaskComparison[]) => [
        `${title} (${group.length}):`,
        ...group.map(item =>
          `  ${item.taskId} champion ${item.champion.outcome} → candidate ${item.candidate!.outcome} ` +
          `(${renderCriterionDiff(item.criteriaDiff)}) — ${item.relation}`),
      ]
      return [
        `proposal ${replayed.proposalId} [replayed] ${proposal.targetType} ${proposal.targetId} — verdict: ${report.verdict}`,
        ...renderGroup('observed', observed),
        holdout.length === 0 ? 'holdout: not run (no holdoutTaskIds given)' : renderGroup('holdout', holdout).join('\n'),
        `report: ${replayed.replayed!.report}`,
        'comparison only — the replay ran as new evolution-replay tasks; the historical tree and production were not changed',
        'next: evolution_gate (cite the report path in regressionEvidenceRefs)',
      ].join('\n')
    },
  })
}
