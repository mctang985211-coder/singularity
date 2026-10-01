/**
 * The MCP server registry: the code-level table a capability's `mcpServers`
 * names resolve against, and the per-env materialization of those names into
 */

import type { McpServerSpec } from '@dangosys/dsh-singularity-agent-runtime'

/**
 * The env binding one spawn resolves server templates against. Produced by
 * `OrchestrateEnv.resolveMcpEnv` from the graph's env record; absent when the
 */
export interface McpEnvBinding {
  /** The environment root (`environment/projectN`). */
  envRoot: string
  /** The checkout path of one planned repository (`<envRoot>/<owner>/<repo>`), or undefined when the env has no such component. */
  checkout(repo: string): string | undefined
}

/**
 * One registered MCP server, before env binding. Any string field may carry
 * `{envRoot}` or `{repoRoot:<repo>}` placeholders; a server whose template is
 */
export interface McpServerTemplate {
  /**
   * The namespace the server's tools publish under (`mcp__<serverName>__<tool>`).
   * Must satisfy mcp-client's `[A-Za-z0-9_-]{1,32}` and stay unique per worker.
   */
  serverName: string
  /** What the server covers, for `capability_list` and table reviewers. */
  description: string
  command: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
  /** Per-tool-call deadline handed to mcp-client; defaults to the client default (60 s). */
  toolCallTimeoutMs?: number
}

/**
 * The servers a capability may name. `bbdev` is the buckyball checkout's own
 * FastMCP server (45 tools, submit/poll-shaped to stay under the per-call
 */
export const MCP_SERVER_REGISTRY: Readonly<Record<string, McpServerTemplate>> = {
  bbdev: {
    serverName: 'bbdev',
    description:
      'buckyball bbdev MCP server (build/simulate/validate; submit + task_status poll) from the env checkout',
    command: '{repoRoot:buckyball}/scripts/claude/run_mcp_server.sh',
    args: [],
    cwd: '{repoRoot:buckyball}',
  },
  waveform: {
    serverName: 'waveform',
    description:
      'buckyball waveform-mcp server (VCD/FST open/read, signal hierarchy, event search) from the env checkout',
    command: '{repoRoot:buckyball}/thirdparty/waveform-mcp/target/release/waveform-mcp',
    args: [],
    cwd: '{repoRoot:buckyball}',
  },
}

/** Every MCP server name one resolved manifest grants, first-declaration order, duplicates dropped. */
export function manifestMcpServers(manifest: { capabilities: Record<string, { mcpServers?: string[] }> }): string[] {
  const names: string[] = []
  for (const entry of Object.values(manifest.capabilities)) {
    for (const name of entry.mcpServers ?? []) if (!names.includes(name)) names.push(name)
  }
  return names
}

const PLACEHOLDER = /\{(envRoot|repoRoot:[^{}]+)\}/g
const ANY_PLACEHOLDER_LIKE = /\{[^{}]*\}/

/**
 * Substitute the placeholders of one template field. `{envRoot}` is the env
 * root; `{repoRoot:<repo>}` is that env's checkout of `<repo>`. An env-free
 */
function substitute(template: string, binding: McpEnvBinding | undefined, serverName: string): string {
  if (!ANY_PLACEHOLDER_LIKE.test(template)) return template
  const leftover = template.replace(PLACEHOLDER, '')
  if (ANY_PLACEHOLDER_LIKE.test(leftover)) {
    throw new Error(
      `task-runtime: MCP server "${serverName}" template "${template}" carries a placeholder outside {envRoot}/{repoRoot:<repo>}`,
    )
  }
  if (binding === undefined) {
    throw new Error(
      `task-runtime: MCP server "${serverName}" needs an env binding ({envRoot}/{repoRoot} template) but this run's session has none`,
    )
  }
  return template.replace(PLACEHOLDER, (whole, key: string) => {
    if (key === 'envRoot') return binding.envRoot
    const repo = key.slice('repoRoot:'.length)
    const checkout = binding.checkout(repo)
    if (checkout === undefined) {
      throw new Error(
        `task-runtime: MCP server "${serverName}" binds {repoRoot:${repo}} but this run's env (${binding.envRoot}) has no "${repo}" checkout`,
      )
    }
    return checkout
  })
}

/**
 * Materialize one manifest's MCP grants into mount-ready specs.
 * @param manifest - the resolved capability manifest (server names already validated at admission).
 */
export function resolveMcpServerSpecs(
  manifest: { capabilities: Record<string, { mcpServers?: string[] }> },
  binding: McpEnvBinding | undefined,
  registry: Readonly<Record<string, McpServerTemplate>> = MCP_SERVER_REGISTRY,
): McpServerSpec[] {
  const names = manifestMcpServers(manifest)
  const specs: McpServerSpec[] = []
  for (const name of names) {
    const template = registry[name]
    if (template === undefined) {
      throw new Error(
        `task-runtime: capability manifest grants unknown MCP server "${name}"; known servers: ${Object.keys(registry).sort().join(', ')}`,
      )
    }
    specs.push({
      serverName: template.serverName,
      command: substitute(template.command, binding, name),
      args: (template.args ?? []).map(arg => substitute(arg, binding, name)),
      env: Object.fromEntries(
        Object.entries(template.env ?? {}).map(([key, value]) => [key, substitute(value, binding, name)]),
      ),
      cwd: template.cwd === undefined ? (binding?.envRoot ?? '') : substitute(template.cwd, binding, name),
      ...(template.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: template.toolCallTimeoutMs }),
    })
  }
  return specs
}
