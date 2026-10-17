/** Native TS contract, adapted from RRSI analyst/propose/critic at the pinned design reference. */
export const rsiDesignReference = {
  repository: 'https://github.com/google-research/rrsi',
  commit: 'be50316e1db05914068a973f322770ef08ed7ba1',
} as const

export const rsiAnalysisRules = [
  'Separate recurring failure modes, missing capabilities and successful habits. Attach native event references to every finding.',
  'Merge findings with the same cause, separate distinct causes, and prioritize the observed impact. Preserve stable names across RSI rounds.',
  'Describe mechanisms independently of task names, files, constants and answers. Keep concrete observations only in evidence references.',
  'Distinguish observation from a hypothesis. Read targeted evidence to resolve contradictions; an inherited summary is not proof.',
  'Record successful behavior that a change must preserve. The analysis describes the problem; the edit separately proposes a solution.',
] as const

export const rsiProposalRules = [
  'Propose one independent, attributable mechanism; its dependent changes may span several assets. Declare exactly the assets changed by the actual diff.',
  'Connect the mechanism to an evidenced finding. State a checkable trigger and predict which cited Tasks it affects.',
  'Explain why an instruction is sufficient or why a stronger implementation is needed. Choose the lever from evidence, without a preference for deletion.',
  'Provide three counterfactuals: how the observed failure would change, why successful behavior survives, and how the mechanism applies to unfamiliar tasks.',
  'Keep task identifiers, captured contents, benchmark answers and per-task recipes outside the method. Every execution must solve its own fresh contract and inputs.',
  'Repair a rejected proposal using its specific objections. A measured no-winner result requires a different proposal, rather than a claim of completion.',
] as const

/** Every criterion gets its own supported finding; one failure rejects the proposal before execution. */
export const rsiProposalCriteria = [
  { criterionId: 'proposal-safe', statement: 'The mechanism remains useful on an unfamiliar task in the same domain. Reject task names, task-specific values, fixed solution recipes, captured artifacts and task-identity branches in changed method content. Repeating the same template is insufficient evidence of transfer.' },
  { criterionId: 'proposal-mechanism', statement: 'The stated hypothesis addresses a cited failure mode, capability gap or success habit; the trigger, predicted affected Tasks and corrective/preservative/transfer counterfactuals are supported. The declarations cover exactly one independent mechanism and every actual asset change.' },
  { criterionId: 'proposal-preservation', statement: 'The method preserves evidenced success habits and required runtime safeguards. Reject inert changes and removal of error handling, termination, isolation or verification without a working replacement. Saving tokens alone does not establish improvement.' },
  { criterionId: 'proposal-integrity', statement: 'Protected inputs, evaluation rules, model and root-bound tools remain fixed. Reject attempts to identify, influence or bypass the grader, fabricate acceptance, or substitute a benchmark-specific answer for solving the contract.' },
  { criterionId: 'proposal-memory', statement: 'Cross-round history and memory remain RSI-only working notes. The method cannot persist or inject prior task files, tool outputs, computed answers or task-keyed solutions into fresh business or acceptance sessions.' },
  { criterionId: 'proposal-bounded', statement: 'The candidate is executable within native role capabilities and has bounded business work and explicit failure paths. Root reads, delegates and submits verified child artifacts; it cannot run commands, write source or invoke implementation tools.' },
] as const

export const rsiCriticRequirements = rsiProposalCriteria.map(criterion => criterion.statement).join('\n') +
  '\nJudge the actual changed content and its evidence. Existing task-specific content is not permission to copy that recipe into a new path. Claims of transfer are hypotheses until tested. Return concrete objections for repair; do not solve or benchmark the business task.'
