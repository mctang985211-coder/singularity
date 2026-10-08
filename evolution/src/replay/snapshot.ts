import { isAbsolute, normalize, resolve } from 'node:path'

export interface ExperimentSnapshot {
  sourceDir: string
  /** Explicit files or subdirectories needed for this comparison; omission selects the whole input. */
  paths?: string[]
  /** Original contract workspace root to relocate into each independent side. */
  rebaseFrom?: string
}

export function normalizeSnapshotPaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.some(path =>
    typeof path !== 'string' || !path || isAbsolute(path) || path.split('/').includes('..') || normalize(path) === '.'))
    throw new Error('experiment: snapshot.paths must name non-empty relative files or directories inside sourceDir')
  const paths = [...new Set((value as string[]).map(path => normalize(path).replace(/\/$/, '')))].sort()
  return paths.filter(path => !paths.some(parent => path !== parent && path.startsWith(`${parent}/`)))
}

export function normalizeSnapshot(snapshot: ExperimentSnapshot): ExperimentSnapshot {
  if (typeof snapshot.sourceDir !== 'string' || !snapshot.sourceDir.trim())
    throw new Error('experiment: snapshot.sourceDir must name an input directory')
  const paths = normalizeSnapshotPaths(snapshot.paths)
  if (snapshot.rebaseFrom !== undefined && (typeof snapshot.rebaseFrom !== 'string' || !isAbsolute(snapshot.rebaseFrom) || resolve(snapshot.rebaseFrom) === '/'))
    throw new Error('experiment: snapshot.rebaseFrom must name the original absolute workspace directory')
  return {
    sourceDir: resolve(snapshot.sourceDir),
    ...(paths === undefined ? {} : { paths }),
    ...(snapshot.rebaseFrom === undefined ? {} : { rebaseFrom: resolve(snapshot.rebaseFrom) }),
  }
}
