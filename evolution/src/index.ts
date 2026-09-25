/**
 * The evolution plane: candidates, their replay evidence, and human-approved
 * applies/rollbacks (guide §1.4, S4-E).
 *
 * One owner for the whole lifecycle. The append-only ledger
 * (`<root>/proposals.jsonl`), its fold and state machine, the sandbox
 * materialization under `<root>/sandbox/<proposalId>/`, the replay report
 * schema and the experiment that produces one, the production write behind
 * apply/rollback, and the capability-row surgery those writes perform all live
 * here. The model-facing `evolution_*` tools
 * (`@dangosys/dsh-singularity-agent`) are adapters: they declare schemas,
 * extract the caller, ask the human through the native approval seam, and
 * render what this package decided. Task-runtime executes runs; it does not
 * decide what a candidate is or whether it may be promoted.
 *
 * Dependency direction (guide §1.4): this package depends on `task` and
 * `task-runtime`; neither they nor `agent-runtime` import it back.
 * @module dsh-singularity-evolution
 */

export * from './config-edit.ts'
export * from './evolution.ts'
export * from './prepare-champion.ts'
export * from './replay-experiment.ts'
export * from './replay.ts'

export { default } from './evolution.ts'
