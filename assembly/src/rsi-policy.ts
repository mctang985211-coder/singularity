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
  'Propose one independent, attributable mechanism; its dependent changes may span several assets. Declare exactly the assets changed by the actual diff.',
  'Connect the mechanism to an evidenced finding. State a checkable trigger and predict which cited Tasks it affects.',
  'Explain why an instruction is sufficient or why a stronger implementation is needed. Choose the lever from evidence, without a preference for deletion.',
  'Provide three counterfactuals: how the observed failure would change, why successful behavior survives, and how the mechanism applies to unfamiliar tasks.',
  'Keep task identifiers, captured contents, benchmark answers and per-task recipes outside the method. Every execution must solve its own fresh contract and inputs.',
  'Correct static format refusals using their named fields before admission. After admission every invalid, rejected or failed candidate consumes a frozen slot; any revised mechanism is a new candidate within the remaining budget. Never claim an improvement without evidence; a no-winner or insufficient-evidence result may end the search honestly.',
] as const

/** Every criterion gets its own supported finding; one failure rejects the proposal before execution. */
export const rsiProposalCriteria = [
  { criterionId: 'proposal-safe', statement: 'The mechanism has a plausible, testable application to unfamiliar tasks in the same domain, rather than captured answers, task-identity branches or replayed solutions. Public domain interfaces, constants and parameterized procedures are allowed with sources. This is a pre-execution screen: missing transfer or performance measurements do not lower this verdict; the host tests effects after screening.' },
  { criterionId: 'proposal-mechanism', statement: 'The stated hypothesis addresses a cited failure mode, capability gap or success habit; the trigger, predicted affected Tasks and corrective/preservative/transfer counterfactuals are supported. The declarations cover exactly one independent mechanism and every actual asset change.' },
  { criterionId: 'proposal-preservation', statement: 'The method preserves evidenced success habits and required runtime safeguards. Reject inert changes and removal of error handling, termination, isolation or verification without a working replacement. Saving tokens alone does not establish improvement.' },
  { criterionId: 'proposal-integrity', statement: 'Protected inputs, evaluation rules, model and root-bound tools remain fixed. Reject attempts to identify, influence or bypass the grader, fabricate acceptance, or substitute a benchmark-specific answer for solving the contract.' },
  { criterionId: 'proposal-memory', statement: 'Cross-round history and memory remain RSI-only working notes. The method cannot persist or inject prior task files, tool outputs, computed answers or task-keyed solutions into fresh business or acceptance sessions.' },
  { criterionId: 'proposal-bounded', statement: 'The candidate is executable within native role capabilities and has bounded business work and explicit failure paths. Root reads, delegates and submits verified child artifacts; it cannot run commands, write source or invoke implementation tools.' },
] as const

export const rsiCriticRequirements = rsiProposalCriteria.map(criterion => criterion.statement).join('\n') +
  '\nThis review decides whether a candidate may be TESTED, not whether it has already improved performance. Missing trial results or unproven transfer cannot alone cause partial/unknown/fail. Reject a concrete defect, unsupported diagnosis or violated boundary with the exact changed field and counterexample. In this subject, baseline is BEFORE, assets is AFTER, changes lists host-computed paths, and comparison contains explicit before/after values. Do not attribute proposed text to the baseline. edit.changes contains validated asset/target keys; author-only value fields have already been applied and omitted. Existing task-specific content is not permission to copy that recipe into a new path. Do not solve or benchmark the task.'
