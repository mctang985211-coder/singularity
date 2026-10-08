/** The evolution plane: the proposal ledger, experiments, promotion, commit.
 * @module dsh-singularity-evolution */

export * from './evolution.ts'
export * from './experiment/spec.ts'
export * from './experiment/freeze.ts'
export * from './experiment/record.ts'
export * from './experiment/runner.ts'
export * from './experiment/workspace.ts'
export * from './replay.ts'
export * from './replay/snapshot.ts'
export * from './capability-candidate.ts'
export * from './task-definition.ts'
export * from './strategy/index.ts'
export { assertDecisionTransition } from './ledger/state-machine.ts'

export { default } from './evolution.ts'
