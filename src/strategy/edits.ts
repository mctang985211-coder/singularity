import { digestOf } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import { record, text } from '../task/shape.ts'
import type { StructuralEdit } from './protocol.ts'

/** Compare the structural asset keys; unrelated manifest fields contribute no edit class. */
export function structuralEditsOf(baseline: unknown, candidate: unknown): readonly StructuralEdit[] {
  const contents = (raw: unknown): Record<string, unknown> =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const before = contents(baseline)
  const after = contents(candidate)
  const templatesOf = (content: Record<string, unknown>): Map<string, string> => {
    if (!Object.hasOwn(content, 'templates')) return new Map()
    if (!Array.isArray(content['templates'])) refuse('malformed-declaration', 'structural templates must be an array')
    return new Map(
      content['templates'].map(raw => {
        const template = record(raw, 'structural template')
        return [text(template, 'id', 'structural template'), digestOf(raw)]
      }),
    )
  }
  const left = templatesOf(before)
  const right = templatesOf(after)
  const edits: StructuralEdit[] = [...new Set([...left.keys(), ...right.keys()])]
    .sort()
    .filter(id => left.get(id) !== right.get(id))
    .map(target => ({ asset: 'template', target }))
  for (const asset of ['skill', 'tool'] as const) {
    const assetsOf = (content: Record<string, unknown>): Map<string, string> => {
      if (!Object.hasOwn(content, asset + 's')) return new Map()
      const list = content[asset + 's']
      if (!Array.isArray(list)) refuse('malformed-declaration', `structural ${asset}s must be an array`)
      return new Map(
        list.map(raw => {
          const held = record(raw, `structural ${asset}`)
          return [text(held, 'name', `structural ${asset}`), digestOf(raw)]
        }),
      )
    }
    const left = assetsOf(before),
      right = assetsOf(after)
    for (const target of [...new Set([...left.keys(), ...right.keys()])].sort())
      if (left.get(target) !== right.get(target)) edits.push({ asset, target })
  }
  if (before['workflowGuidance'] !== after['workflowGuidance'])
    edits.push({ asset: 'workflow', target: 'workflowGuidance' })
  return edits
}

/** Audit projection only; strategy decisions still use the structural asset edits above. */
export function structuralEditDetailsOf(
  baseline: { templates: readonly unknown[]; skills: readonly unknown[]; tools: readonly unknown[] },
  candidate: { templates: readonly unknown[]; skills: readonly unknown[]; tools: readonly unknown[] },
): readonly (StructuralEdit & { readonly paths: readonly string[] })[] {
  const differences = (left: unknown, right: unknown, path: string): string[] => {
    if (left === undefined || right === undefined) return left === right ? [] : [path || '$']
    if (digestOf(left) === digestOf(right)) return []
    if (Array.isArray(left) && Array.isArray(right))
      return Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
        differences(left[index], right[index], `${path}[${index}]`),
      ).flat()
    if (
      left !== null &&
      right !== null &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const a = left as Record<string, unknown>,
        b = right as Record<string, unknown>
      return [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .sort()
        .flatMap(key => differences(a[key], b[key], path === '' ? key : `${path}.${key}`))
    }
    return [path || '$']
  }
  return structuralEditsOf(baseline, candidate).map(edit => {
    if (edit.asset === 'workflow') return { ...edit, paths: ['workflowGuidance'] }
    const asset = edit.asset
    const key = asset === 'template' ? 'id' : 'name'
    const find = (assets: typeof baseline) =>
      assets[`${asset}s`].find(raw => (raw as Record<string, unknown>)[key] === edit.target)
    return { ...edit, paths: differences(find(baseline), find(candidate), '') }
  })
}
