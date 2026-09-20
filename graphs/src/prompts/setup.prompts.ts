import type { EnvRecord } from '@dangosys/dsh-env-builder'

export function setupPromptText(graphId: string, env: EnvRecord): string {
  const pending = env.components.filter(component => component.status === 'installing')
  const present = env.components.filter(component => component.status !== 'installing')
  const names = (components: typeof env.components) =>
    components.map(component => `${component.owner}/${component.repo}`).join(', ')
  const presentLine =
    present.length === 0 ? '' : `\nAlready present (do not reinstall): ${names(present)}.`
  return `Set up Singularity graph ${graphId}. Environment ${env.id} is at ${env.path}.
Planned repositories: ${names(pending) || '(none)'}.${presentLine}

For each planned repository, delegate installation and registration to a worker with graph_spawn — never with task_decompose, which is reserved for the user objective and whose root allowance is a single call. The worker must install it with bash according to the repository instructions and then call env_register_component. If a worker needs human input, you may use hitl_ask or hitl_approve. When all setup workers complete successfully, call graph_mark_ready. If there are no planned repositories, call graph_mark_ready immediately.`
}
