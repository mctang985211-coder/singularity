import type { MethodAssets } from '../src/method.ts'
import { structuralEditsOf } from '../../src/strategy/edits.ts'
import { digestOf } from '../../src/protocol/envelope.ts'

export function rsiProposal(baseline: MethodAssets, method: MethodAssets, taskId: string, sessionId: string) {
  const evidence = [{ sessionId, eventSeq: 0 }]
  return {
    analysis: {
      failure_modes: [
        {
          mode: 'repeated_inspection',
          description: 'Inspecting identical frozen material adds repeated context without new evidence.',
          needed_instead: 'Reuse established evidence when the input identity is unchanged.',
          evidence,
        },
      ],
      capability_gaps: [],
      success_habits: [
        {
          habit: 'independent_acceptance',
          description: 'Submitted artifacts receive independent acceptance.',
          risk_if_broken: 'A self-reported result might be mistaken for acceptance.',
          evidence,
        },
      ],
    },
    edit: {
      hypothesis:
        'Reusing sufficient frozen evidence avoids repeated inspection while preserving independent acceptance.',
      targets_mode: 'repeated_inspection',
      trigger_condition: 'The identical frozen input has already been inspected.',
      changes: structuralEditsOf(baseline, method).map(edit => {
        if (edit.asset === 'workflow') return { ...edit, value: method.workflowGuidance }
        const field = `${edit.asset}s` as 'templates' | 'skills' | 'tools',
          key = edit.asset === 'template' ? 'id' : 'name'
        const find = (assets: MethodAssets) =>
          assets[field].find(raw => (raw as Record<string, unknown>)[key] === edit.target) as
            Record<string, unknown> | undefined
        const before = find(baseline),
          after = find(method)
        return {
          ...edit,
          value:
            after === undefined
              ? null
              : Object.fromEntries(
                  [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])]
                    .filter(name => name !== key && digestOf(before?.[name] ?? null) !== digestOf(after[name] ?? null))
                    .map(name => [name, after[name] ?? null]),
                ),
        }
      }),
      predicted_affected: [taskId],
      predicted_cases: [],
      predicted_families: [],
      regression_risk: 'New or changed inputs must still be inspected.',
    },
  }
}
