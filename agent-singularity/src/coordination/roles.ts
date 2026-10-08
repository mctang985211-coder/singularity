/**
 * The tool surface one coordination session runs under, in one place: the
 * read-only baseline every coordination role shares, the two completion tools,
 * and the grants the driver spawns with. Who may call what is decided here and
 * nowhere else.
 *
 * @module @dangosys/dsh-singularity-agent/coordination/roles
 */

import type { WorkerGrant } from '@dangosys/dsh-singularity-agent-runtime'

/** The host preset both coordination roles are composed from; the runtime installs the role's own policy. */
export const COORDINATION_PRESET = 'singularity-coordinator'

/** The read-only investigation surface: what a coordination session may still do after writes are closed. */
export const COORDINATION_READ_ONLY: readonly string[] = [
  'task_review_pack',
  'task_read',
  'task_status',
  'context_read',
  'capability_list',
  'task_template_list',
  'method_list',
  'skill',
  'read',
  'glob',
  'grep',
]

/** The host preset a review session is composed from — the same composition, a different role. */
export const REVIEWER_PRESET = COORDINATION_PRESET

/**
 * The method tools a supervisor needs. Until the method tool surface lands
 * (`tools/method-shared.ts` owns `METHOD_SUPERVISOR_BASELINE`), this constant
 * holds the evolution chain that plays that role today; the name is the seam, so
 * the switch is one import.
 */
export const METHOD_SUPERVISOR_BASELINE: readonly string[] = [  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_list',
]

/** The reviewer's whole surface: read-only, plus its own completion tool. */
export const REVIEWER_BASELINE: readonly string[] = [...COORDINATION_READ_ONLY, 'task_review_agent', 'reviewer_complete']

/** The supervisor's surface: the read-only investigation tools, the method tools and its own completion tool. */
export const SUPERVISOR_BASELINE: readonly string[] = [
  ...COORDINATION_READ_ONLY,
  'task_library',
  'task_review_agent',
  ...METHOD_SUPERVISOR_BASELINE,
  'supervisor_complete',
]

/** The grant one review session is spawned with. */
export function reviewerGrant(): WorkerGrant {
  return { capabilities: [], baseline: REVIEWER_BASELINE, keepPresetTools: false }
}

/** The grant one round's supervisor is spawned with. */
export function supervisorGrant(): WorkerGrant {
  return { capabilities: [], baseline: SUPERVISOR_BASELINE, keepPresetTools: false }
}
