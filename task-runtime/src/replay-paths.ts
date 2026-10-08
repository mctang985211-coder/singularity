import { isAbsolute, resolve } from 'node:path'

/** Relocate declared workspace paths, retaining every other contract value. */
export function rebaseWorkspacePaths<T>(value: T, from: string, to: string): T {
  if (!isAbsolute(from) || !isAbsolute(to) || resolve(from) === '/')
    throw new Error('replay: workspace mapping requires absolute roots and a specific source directory')
  const source = resolve(from)
  const target = resolve(to)
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Only complete path prefixes: /project/input moves, /project-other stays.
  const prefix = new RegExp(`(^|[\\s"'\\x60=(:,])${escaped}(?=/|$|[\\s"'\\x60),;])`, 'g')
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return item.replace(prefix, (_match, before: string) => before + target)
    if (Array.isArray(item)) return item.map(visit)
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]))
    return item
  }
  return visit(value) as T
}
