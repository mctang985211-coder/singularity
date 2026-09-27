import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@dangosys/dsh-singularity-graphs'
import type {} from '@dangosys/dsh-singularity-task'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import type { ProposalTargetType } from '@dangosys/dsh-singularity-task'

const text = (value: string) => [{ type: 'text' as const, text: value }]

const TARGET_TYPES: readonly ProposalTargetType[] = [
  'skill', 'tool', 'capability', 'task_definition', 'decomposition_policy',
  'agent_preset', 'workflow_policy', 'verifier', 'runtime_policy',
]

const TARGET_TYPE_SET: ReadonlySet<string> = new Set<string>(TARGET_TYPES)

function isProposalTargetType(value: unknown): value is ProposalTargetType {
  return typeof value === 'string' && TARGET_TYPE_SET.has(value)
}

function sessionId(exec: ToolRunContext): SessionId {
  const id = exec.agent?.id
  if (typeof id !== 'string' || id.length === 0) throw new Error('evolution_propose: missing agent id')
  return id
}

export function defineEvolutionProposeTool(ctx: Context) {
  return defineTool({
    name: 'evolution_propose',
    description:
      'Register an EvolutionProposal in the evolution ledger (status: proposed). Pure bookkeeping: nothing here executes ' +
      'or changes production. This build has one promotion path — a proposal that improves an existing skill under its own ' +
      'name (the whole loadable object: `SKILL.md`, plus the `SKILL.contract.json` beside it when the skill declares an ' +
      'execution provider) goes through evolution_candidate (carrying the full replacement text), evolution_prepare, ' +
      'evolution_replay (the two-sided experiment), evolution_gate, and a human-approved evolution_decide plus ' +
      'evolution_apply. Every other target type stays a recorded suggestion and is never opened as a candidate, so it is ' +
      'never evaluated and never promoted. ' +
      'Fill targetType/targetId/rationale manually, or pass fromDiagnosis to transcribe one proposal out of a recorded ' +
      'diagnosis (task_diagnose). baseVersion, level, and at least one sourceRef (diagnosisId / reviewRef / evidenceId) are required.',
    parameters: {
      proposalId: { type: 'string', required: true, description: 'Unique id for this proposal; a duplicate id is rejected' },
      level: {
        type: 'string',
        required: true,
        enum: ['L1', 'L2', 'L3', 'L4'],
        description: 'Evolution level (L1 execution adaptation / L2 capability / L3 workflow / L4 harness); every level goes through human review, with no exemption',
      },
      baseVersion: { type: 'string', required: true, description: 'Version of the target this proposal starts from' },
      targetType: { type: 'string', enum: TARGET_TYPES, description: 'The mutation surface the proposal points at (required unless fromDiagnosis)' },
      targetId: { type: 'string', description: 'Name of the concrete target (required unless fromDiagnosis)' },
      rationale: { type: 'string', description: 'Why this change would address the diagnosed cause (required unless fromDiagnosis)' },
      sourceRefs: { type: 'array', items: { type: 'string' }, description: 'Sources this proposal rests on (diagnosisId / reviewRef / evidenceId)' },
      fromDiagnosis: {
        type: 'object',
        additionalProperties: false,
        description: 'Transcribe targetType/targetId/rationale from one proposal of a recorded diagnosis',
        properties: {
          diagnosisId: { type: 'string', required: true, description: 'Recorded diagnosis id' },
          proposalIndex: { type: 'number', required: true, description: 'Index into the diagnosis proposals array (0-based)' },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (args, exec) => {
      const caller = sessionId(exec)
      let targetType = args.targetType
      let targetId = args.targetId
      let rationale = args.rationale
      const sourceRefs = [...(args.sourceRefs ?? [])]
      if (args.fromDiagnosis !== undefined) {
        if (targetType !== undefined || targetId !== undefined || rationale !== undefined) {
          throw new Error('evolution_propose: fromDiagnosis already supplies targetType/targetId/rationale — do not pass both')
        }
        const graph = await ctx.graphs.graphForSession(caller)
        const snapshot = await ctx.task.openStore(rootTaskStoreId(graph.rootSessionId))
        const diagnosis = snapshot.diagnoses.find(item => item.diagnosisId === args.fromDiagnosis!.diagnosisId)
        if (diagnosis === undefined) throw new Error(`evolution_propose: unknown diagnosis "${args.fromDiagnosis.diagnosisId}"`)
        const proposal = diagnosis.proposals[args.fromDiagnosis.proposalIndex]
        if (proposal === undefined) {
          throw new Error(`evolution_propose: diagnosis "${diagnosis.diagnosisId}" has no proposal #${args.fromDiagnosis.proposalIndex}`)
        }
        targetType = proposal.targetType
        targetId = proposal.targetId
        rationale = proposal.rationale
        sourceRefs.unshift(`diagnosis:${diagnosis.diagnosisId}`)
      } else if (targetType === undefined || targetId === undefined || rationale === undefined) {
        throw new Error('evolution_propose: targetType, targetId and rationale are required without fromDiagnosis')
      }
      if (!isProposalTargetType(targetType)) {
        throw new Error(`evolution_propose: targetType must be one of ${TARGET_TYPES.join(' / ')}, got "${String(targetType)}"`)
      }
      try {
        const proposal = await ctx.evolution.propose(
          {
            proposalId: args.proposalId,
            targetType,
            targetId,
            baseVersion: args.baseVersion,
            level: args.level,
            rationale,
            sourceRefs,
          },
          caller,
        )
        const skillReplacement =
          'ledger entry only — nothing was executed or changed; next: evolution_candidate, carrying the full replacement ' +
          "text of the existing skill's SKILL.md — the only input a candidate submits, because an execution skill's " +
          'SKILL.contract.json is derived from production at evolution_prepare (only its content.skillMdSha256 is ' +
          'recomputed, so a content update cannot move a capability, a required tool or a verifier)'
        const recordedSuggestion =
          `ledger entry only — nothing was executed or changed; this build executes one promotion path only — replacing an ` +
          `existing skill object under its own name — so a "${proposal.targetType}" proposal stays a recorded suggestion: it cannot become ` +
          'a candidate, is never evaluated, and is never promoted'
        return [
          `proposal ${proposal.proposalId} registered [proposed] ${proposal.level} ${proposal.targetType} ${proposal.targetId} (base ${proposal.baseVersion})`,
          `rationale: ${proposal.rationale}`,
          `sourceRefs: [${proposal.sourceRefs.join(', ')}]`,
          proposal.targetType === 'skill' ? skillReplacement : recordedSuggestion,
        ].join('\n')
      } catch (error) {
        return `evolution_propose rejected: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
