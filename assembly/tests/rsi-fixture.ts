import type { MethodAssets } from '../src/method.ts'
import type { RsiProposal } from '../src/rsi-proposal.ts'
import { structuralEditsOf } from '../../src/strategy/edits.ts'

export function rsiProposal(baseline: MethodAssets, method: MethodAssets, taskId: string, sessionId: string): RsiProposal {
  const evidence = [{ sessionId, eventSeq: 0 }]
  return { analysis: {
    failure_modes: [{ mode: 'repeated_inspection', description: 'Inspecting identical frozen material adds repeated context without new evidence.',
      needed_instead: 'Reuse established evidence when the input identity is unchanged.', evidence }],
    capability_gaps: [],
    success_habits: [{ habit: 'independent_acceptance', description: 'Submitted artifacts receive independent acceptance.',
      risk_if_broken: 'A self-reported result might be mistaken for acceptance.', evidence }],
  }, edit: { hypothesis: 'Reusing sufficient frozen evidence avoids repeated inspection while preserving independent acceptance.',
    targets_mode: 'repeated_inspection', why_not_lower_lever: 'The redundant step follows guidance, so a conditional instruction is appropriate.',
    trigger_condition: 'The identical frozen input has already been inspected.', changes: structuralEditsOf(baseline, method),
    predicted_affected: [taskId], predicted_cases: [], predicted_families: [], retroactive_check: {
      corrective: 'The cited execution could reuse an established input identity instead of inspecting it again.',
      preservative: 'Independent acceptance remains mandatory and unchanged.',
      transfer: 'Evidence identity checking applies to unfamiliar inputs and does not prescribe a solution.',
    }, regression_risk: 'New or changed inputs must still be inspected.' }, method }
}
