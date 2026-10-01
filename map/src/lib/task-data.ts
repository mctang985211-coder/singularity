import type {
  SnapshotCollection,
  TaskInstanceWire,
  TaskProposalWire,
  TaskRunWire,
  TaskSnapshotWire,
} from '../types'

function isIndex<T>(value: SnapshotCollection<T>): value is Readonly<Record<string, T>> {
  return !Array.isArray(value)
}

/** Normalize a projection collection to an array. The snapshot may index records by id or list them. */
export function asArray<T>(value?: SnapshotCollection<T>): T[] {
  if (value === undefined) return []
  return isIndex(value) ? Object.values(value) : [...value]
}

export interface TaskNode {
  readonly task: TaskInstanceWire
  readonly depth: number
  readonly children: TaskNode[]
}

/** Build the decomposition tree from `parentTaskId`, falling back to a parent's `childTaskIds`. */
export function taskTree(snapshot: TaskSnapshotWire | null): TaskNode[] {
  const tasks = asArray(snapshot?.tasks)
  const byId = new Map(tasks.map(task => [task.taskId, task]))
  const inferred = new Map<string, string>()
  for (const task of tasks) {
    for (const childId of task.childTaskIds ?? []) {
      if (byId.has(childId) && !inferred.has(childId)) inferred.set(childId, task.taskId)
    }
  }
  const parentOf = (task: TaskInstanceWire): string | undefined => {
    const parentId = task.parentTaskId ?? inferred.get(task.taskId)
    return parentId !== undefined && byId.has(parentId) && parentId !== task.taskId ? parentId : undefined
  }
  const children = new Map<string, TaskInstanceWire[]>()
  const roots: TaskInstanceWire[] = []
  for (const task of tasks) {
    const parentId = parentOf(task)
    if (parentId === undefined) {
      roots.push(task)
      continue
    }
    const list = children.get(parentId)
    if (list === undefined) children.set(parentId, [task])
    else list.push(task)
  }
  const seen = new Set<string>()
  const build = (task: TaskInstanceWire, depth: number): TaskNode => {
    seen.add(task.taskId)
    const nested = (children.get(task.taskId) ?? [])
      .filter(child => !seen.has(child.taskId))
      .map(child => build(child, depth + 1))
    return { task, depth, children: nested }
  }
  return roots.map(task => build(task, 0))
}

export function runsOf(task: TaskInstanceWire, runs: readonly TaskRunWire[]): TaskRunWire[] {
  const ids = new Set(task.runIds ?? [])
  return runs.filter(run => run.taskId === task.taskId || ids.has(run.runId))
}

export function proposalsOf(snapshot: TaskSnapshotWire | null): TaskProposalWire[] {
  const value = snapshot?.proposals
  if (value === undefined) return []
  if (Array.isArray(value)) return [...(value as readonly TaskProposalWire[])]
  const index = value as {
    all?: readonly TaskProposalWire[]
    byId?: Readonly<Record<string, TaskProposalWire>>
  }
  if (Array.isArray(index.all)) return [...(index.all as readonly TaskProposalWire[])]
  return index.byId === undefined ? [] : Object.values(index.byId)
}

export function shortId(id: string, keep = 12): string {
  return id.length <= keep ? id : `${id.slice(0, keep)}…`
}
