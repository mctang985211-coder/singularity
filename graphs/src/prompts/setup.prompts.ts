import type { EnvRecord } from '@dangosys/dsh-env-builder'

/**
 * What the root is told when a graph is created (A0 §1.1): the setup work, and
 * nothing that could pass for the graph's goal.
 *
 * The paragraph used to leave the root's objective implicit by calling
 * `task_decompose` "reserved for the user objective" — but a graph no longer
 * arrives with a task whose objective is the graph's own name, so a root that
 * read that line would go looking for one. Setup is not the goal, and the goal
 * is accepted through `task_intake`: this text says both, and names no
 * decomposition of setup work.
 */
export function setupPromptText(graphId: string, env: EnvRecord): string {
  const pending = env.components.filter(component => component.status === 'installing')
  const present = env.components.filter(component => component.status !== 'installing')
  const names = (components: typeof env.components) =>
    components.map(component => `${component.owner}/${component.repo}`).join(', ')
  const presentLine =
    present.length === 0 ? '' : `\nAlready present (do not reinstall): ${names(present)}.`
  return `Set up Singularity graph ${graphId}. Environment ${env.id} is at ${env.path}.
Planned repositories: ${names(pending) || '(none)'}.${presentLine}

This setup work is not the graph's goal: the goal is the user's own objective, and when the user states it, accept it with task_intake — before that the graph has no root task, so task_read reports the session as not activated and there is nothing to decompose. For each planned repository, delegate installation and registration to a worker with graph_spawn — never with task_decompose, which only has a task to work on once a root contract has been accepted. The worker must install it with bash according to the repository instructions and then call env_register_component. If a worker needs human input, you may use hitl_ask or hitl_approve. When all setup workers complete successfully, call graph_mark_ready. If there are no planned repositories, call graph_mark_ready immediately.`
}
