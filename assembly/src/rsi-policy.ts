/** Native TS contract, adapted from RRSI analyst/propose/critic at the pinned design reference. */
export const rsiDesignReference = {
  repository: 'https://github.com/google-research/rrsi',
  commit: 'be50316e1db05914068a973f322770ef08ed7ba1',
} as const

export const rsiAnalysisRules = [
  'Separate recurring failure modes, missing capabilities and successful habits. Attach native event references to every finding.',
  'Merge findings with the same cause, separate distinct causes, and prioritize the observed impact. Preserve stable names across RSI rounds.',
  'Describe reusable mechanisms, not task identities or captured answers. Public domain interfaces, constants, tool paths and parameterized procedures are allowed with sources; keep task-instance details in evidence references.',
  'Distinguish observation from a hypothesis. Read targeted evidence to resolve contradictions; an inherited summary is not proof.',
  'Record successful behavior that a change must preserve. The analysis describes the problem; the edit separately proposes a solution.',
] as const

export const rsiProposalRules = [
  'Connect each edit to the analysis and cite its native evidence. The proposal criteria below are the authoritative mechanism, integrity and preservation requirements.',
  'Correct static format refusals using their named fields before admission. After admission every invalid, rejected or failed candidate consumes a frozen slot; a revision is a new candidate within the remaining budget.',
] as const

/** Every criterion gets its own supported finding; one failure rejects the proposal before execution. */
export const rsiProposalCriteria = [
  {
    criterionId: 'proposal-mechanism',
    statement:
      'The cited native evidence supports the diagnosis and one attributable, reusable mechanism in the actual diff. Its trigger and expected effect are plausible; unsupported or inert edits do not qualify. Public domain interfaces and parameterized procedures are allowed with sources.',
  },
  {
    criterionId: 'proposal-integrity',
    statement:
      'The diff contains no captured answers, task-identity branches, replayed solutions, grader manipulation or fabricated acceptance. Prior task files, outputs and task-keyed recipes cannot enter fresh business or acceptance sessions through assets or memory; RSI history remains working notes.',
  },
  {
    criterionId: 'proposal-preservation',
    statement:
      'The mechanism preserves evidenced successes, isolation, verification, termination and explicit failure paths, and is executable within native role capabilities. Root coordinates and submits verified child artifacts; implementation belongs to delegated Tasks. Claimed savings do not justify removing safeguards without a working replacement.',
  },
] as const

export const rsiCriticRequirements =
  'baseline is BEFORE, assets is AFTER, changes lists host-computed paths, and comparison contains before/after values. edit.changes contains validated asset/target keys; author-only values have already been applied and omitted. Cite the exact changed field and counterexample for a defect. The host checks format, diff coverage, bindings, identities and budget; experiments determine performance and transfer.'
