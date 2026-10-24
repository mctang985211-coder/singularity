import type { NodeRole } from './prompts.ts'

const reads = ['read', 'read_image', 'glob', 'grep']
const evidence = ['singularity_read', 'singularity_memory', 'singularity_submit']
const coordination = ['singularity_decompose_task', 'singularity_answer']
const execution = [
  'bash',
  'pwsh',
  'write',
  'edit',
  'job_output',
  'job_list',
  'job_kill',
  'skill',
  'web_fetch',
  'web_search',
]

/** Closed capability vocabulary shared by registration, prompt assembly and execution. */
export const roleTools: Record<NodeRole | 'method-review', ReadonlySet<string>> = {
  root: new Set([...reads, ...evidence, ...coordination, 'singularity_stop_explorations', 'singularity_retry_task']),
  task: new Set([
    ...reads,
    ...execution,
    ...evidence,
    ...coordination,
    'singularity_stop_explorations',
    'singularity_retry_task',
    'singularity_ask_parent',
    'singularity_run_method',
  ]),
  review: new Set([...reads, ...execution, ...evidence, ...coordination]),
  improve: new Set(['read', 'write', 'edit', 'glob', 'grep', ...evidence, 'singularity_propose_method']),
  'method-review': new Set(['read', 'glob', 'grep', 'singularity_read', 'singularity_submit']),
}

export interface ToolState {
  readonly role: NodeRole | 'method-review'
  readonly waiting?: boolean
  readonly canPlan?: boolean | undefined
  readonly closed?: boolean
  readonly search?:
    undefined | { readonly canPropose: boolean; readonly canSubmit: boolean; readonly executionPhase: string }
}
export function toolsFor(state: ToolState): ReadonlySet<string> {
  const allowed = new Set(roleTools[state.role])
  if (state.waiting || state.closed) {
    const waiting = new Set([
      ...reads,
      'singularity_read',
      'singularity_memory',
      'singularity_answer',
      'singularity_ask_parent',
      'singularity_stop_explorations',
      'singularity_retry_task',
      // Cleanup remains possible; job_output (including wait:true) is unavailable.
      'job_list',
      'job_kill',
      ...(state.canPlan && !state.closed ? ['singularity_decompose_task'] : []),
    ])
    for (const name of allowed) if (!waiting.has(name)) allowed.delete(name)
  }
  if (state.search !== undefined) {
    if (!state.search.canPropose) allowed.delete('singularity_propose_method')
    if (!state.search.canSubmit) allowed.delete('singularity_submit')
    if (state.search.executionPhase !== 'ready') {
      allowed.delete('write')
      allowed.delete('edit')
    }
  }
  return allowed
}

/** One native section can describe several tools. Never retain a partly false section. */
const sectionTools: Record<string, readonly string[]> = {
  'tool:jobs': ['job_output', 'job_list', 'job_kill'],
  'tool:skill': ['skill'],
}
export function sectionAllowed(name: string, allowed: ReadonlySet<string>): boolean {
  const owners = sectionTools[name] ?? (name.startsWith('tool:') ? [name.slice(5)] : [])
  return owners.every(tool => allowed.has(tool))
}

export const methodReviewTools = roleTools['method-review']
export const improvementTools = roleTools.improve
