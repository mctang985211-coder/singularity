import type { EnvRecord } from '@dangosys/dsh-env-builder'

/** What the root is told when a graph is created (A0 §1.1): the setup work, not the graph's goal. */
export function setupPromptText(graphId: string, env: EnvRecord): string {
  const pending = env.components.filter(component => component.status === 'installing')
  const present = env.components.filter(component => component.status !== 'installing')
  const names = (components: typeof env.components) =>
    components.map(component => `${component.owner}/${component.repo}`).join(', ')
  const presentLine = present.length === 0 ? '' : `\nAlready present: ${names(present)}.`
  return `Set up Singularity graph ${graphId}. Environment ${env.id} is at ${env.path}.
Planned repositories: ${names(pending) || '(none)'}.${presentLine}

Install and register planned repositories through graph_spawn, then call graph_mark_ready. An empty workspace is ready immediately. After setup, explore the user's objective and measures, read this graph's task_library, and establish the task_intake contract for this execution. Record useful goals, decomposition paths and experience as TaskTemplates or Skills in the graph library; the supervisor reviews them during iteration.`
}
