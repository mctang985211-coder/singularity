/** The proposal state machine: which transition each status admits, and the vocabulary it refuses a wrong-state call by.
 * @module dsh-singularity-evolution/ledger/state-machine */

import { join } from 'node:path'
import { SKILL_SIDECAR_FILE } from '@dangosys/dsh-singularity-task-runtime'

import type { EvolutionDecision, EvolutionProposal, EvolutionStatus, SkillMutation } from '../types.ts'
import { APPLYABLE_TARGET_TYPES, EVOLUTION_DECISIONS } from '../types.ts'

/** Whether a decided proposal's `applied` record is admissible: a PROMOTE decision, a level below L4, a mechanically moveable target and a materialized sandbox. */
export function applyable(proposal: EvolutionProposal): boolean {
  return (
    proposal.decision === 'PROMOTE' &&
    proposal.level !== 'L4' &&
    APPLYABLE_TARGET_TYPES.includes(proposal.targetType) &&
    proposal.prepared?.sandbox != null
  )
}

/** The state machine. A candidate is a mutation — a materialized one in this build, so `prepared` is the one state it admits. */
export function nextStates(proposal: EvolutionProposal): readonly EvolutionStatus[] {
  switch (proposal.status) {
    case 'proposed':
      return ['candidate']
    case 'candidate':
      return ['prepared']
    case 'prepared':
      // A skill candidate gates straight from prepared: its evaluation is the
      // experiment, which does not move the proposal.
      return ['gated']
    case 'gated':
      return ['decided']
    case 'decided':
      return applyable(proposal) ? ['applied'] : []
    case 'applied':
      return ['rolledback']
    case 'rolledback':
      return []
  }
}

/** The one transition check shared by live appends and replay, so an illegal migration reads identically in both. */
export function assertTransition(current: EvolutionProposal, kind: EvolutionStatus): void {
  if (nextStates(current).includes(kind)) return
  const hint =
    current.status === 'candidate'
      ? ' — record "prepared" first (evolution_prepare), the sandbox materialization this candidate\'s mutation needs'
      : current.status === 'decided' && kind === 'applied'
        ? current.decision !== 'PROMOTE'
          ? ` — the recorded decision is ${current.decision}; only a PROMOTE decision can be applied`
          : ' — only a materialized skill mutation at L1–L3 applies in this build'
        : ''
  throw new Error(`evolution: proposal "${current.proposalId}" is ${current.status}; cannot record "${kind}"${hint}`)
}

/** Declining an open candidate writes no production bytes and needs no successful experiment. */
export function assertDecisionTransition(
  current: EvolutionProposal,
  decision: EvolutionDecision,
  note?: string,
): void {
  if (!EVOLUTION_DECISIONS.includes(decision))
    throw new Error(`evolution: decision must be one of ${EVOLUTION_DECISIONS.join(' / ')}`)
  if (decision !== 'PROMOTE' && ['proposed', 'candidate', 'prepared'].includes(current.status)) {
    if (typeof note !== 'string' || !note.trim())
      throw new Error('evolution: settling an ungated proposal with REJECT or KEEP_FOR_FURTHER_RESEARCH requires a reason in note')
    return
  }
  assertTransition(current, 'decided')
}

/** The production write targets of an apply (and its matching rollback), for the commit's fixed file set and for audit. */
export function applyTargets(proposal: EvolutionProposal, roots: { skillRoot: string; taskTemplatesRoot?: () => string }, direction: 'apply' | 'rollback' = 'apply'): string[] {
  if (proposal.targetType === 'task_definition') {
    const candidate = proposal.prepared?.templateCandidate?.template
    if (candidate === undefined || roots.taskTemplatesRoot === undefined) return []
    const version = direction === 'rollback' && proposal.prepared?.templateBaseline != null ? candidate.version + 1 : candidate.version
    return [join(roots.taskTemplatesRoot(), `${candidate.id}@${version}.json`)]
  }
  if (proposal.targetType === 'capability') {
    const content = proposal.prepared?.skillContent
    if (content === undefined) return []
    const files = [join(roots.skillRoot, content.name, 'SKILL.md')]
    if (content.contract !== undefined) files.push(join(roots.skillRoot, content.name, SKILL_SIDECAR_FILE))
    return files
  }
  if (proposal.targetType !== 'skill') return []
  const name = (proposal.mutation as SkillMutation).name
  const files = [join(roots.skillRoot, name, 'SKILL.md')]
  if (proposal.prepared?.skillContent?.contract !== undefined) {
    files.push(join(roots.skillRoot, name, SKILL_SIDECAR_FILE))
  }
  const resources = [...(proposal.prepared?.skillContent?.resources ?? []), ...(proposal.prepared?.skillBaseline?.resources ?? [])]
  for (const path of [...new Set(resources.map(resource => resource.path))]) files.push(join(roots.skillRoot, name, path))
  return files
}
