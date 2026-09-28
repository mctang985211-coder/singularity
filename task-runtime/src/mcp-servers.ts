/**
 * The MCP server registry: the code-level table a capability's `mcpServers`
 * names resolve against, and the per-env materialization of those names into
 * concrete stdio server specs.
 *
 * A capability declares server NAMES (registry keys), never paths: the bbdev
 * server and the waveform server both ship inside the per-env buckyball
 * checkout
 * (`environment/projectN/<owner>/<repo>`, owner included — forks included), so
 * a global preset file cannot name it. Resolution happens at spawn time: the
 * task runtime binds `{envRoot}` / `{repoRoot:<repo>}` placeholders from the
 * caller's graph environment (`OrchestrateEnv.resolveMcpEnv`), and the agent
 * runtime mounts each resolved spec as one mcp-client instance on the worker's
 * own scope, where its tools appear as `mcp__<serverName>__<tool>`
 * (`agent-runtime/src/grants.ts`).
 *
 * The registry is code, not config: a deployment edits it by editing this file
 * (and the matching capability rows), never by writing machine paths into
 * `config.yml`.
 * @module dsh-singularity-task-runtime/mcp-servers
 */

import type { McpServerSpec } from '@dangosys/dsh-singularity-agent-runtime'

/**
 * The env binding one spawn resolves server templates against. Produced by
 * `OrchestrateEnv.resolveMcpEnv` from the graph's env record; absent when the
 * caller's session has no graph env (root-side contexts, test harnesses).
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
 * placeholder-free binds no env and mounts the same everywhere.
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
 * timeout); `waveform` is that checkout's waveform-mcp build (VCD/FST reads,
 * stdio, seven signal/event tools). Both bind `{repoRoot:buckyball}`: the
 * worker's env must contain a buckyball checkout, and a capability that names
 * one on an env without it fails the spawn loudly.
 */
export const MCP_SERVER_REGISTRY: Readonly<Record<string, McpServerTemplate>> = {
  bbdev: {
    serverName: 'bbdev',
    description: 'buckyball bbdev MCP server (build/simulate/validate; submit + task_status poll) from the env checkout',
    command: '{repoRoot:buckyball}/scripts/claude/run_mcp_server.sh',
    args: [],
    cwd: '{repoRoot:buckyball}',
  },
  waveform: {
    serverName: 'waveform',
    description: 'buckyball waveform-mcp server (VCD/FST open/read, signal hierarchy, event search) from the env checkout',
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
 * field passes through untouched; an env-needing field with no binding, a repo
 * the env does not contain, or a placeholder outside the vocabulary all throw
 * — a miswired server must never mount partially.
 */
function substitute(template: string, binding: McpEnvBinding | undefined, serverName: string): string {
  if (!ANY_PLACEHOLDER_LIKE.test(template)) return template
  const leftover = template.replace(PLACEHOLDER, '')
  if (ANY_PLACEHOLDER_LIKE.test(leftover)) {
    throw new Error(`task-runtime: MCP server "${serverName}" template "${template}" carries a placeholder outside {envRoot}/{repoRoot:<repo>}`)
  }
  if (binding === undefined) {
    throw new Error(`task-runtime: MCP server "${serverName}" needs an env binding ({envRoot}/{repoRoot} template) but this run's session has none`)
  }
  return template.replace(PLACEHOLDER, (whole, key: string) => {
    if (key === 'envRoot') return binding.envRoot
    const repo = key.slice('repoRoot:'.length)
    const checkout = binding.checkout(repo)
    if (checkout === undefined) {
      throw new Error(`task-runtime: MCP server "${serverName}" binds {repoRoot:${repo}} but this run's env (${binding.envRoot}) has no "${repo}" checkout`)
    }
    return checkout
  })
}

/**
 * Materialize one manifest's MCP grants into mount-ready specs.
 * @param manifest - the resolved capability manifest (server names already validated at admission).
 * @param binding - the run's env binding, or undefined when the session has none.
 * @param registry - the template table; a parameter so tests can exercise bad
 *   templates (unknown placeholders) that the shipped registry must never hold.
 * @returns one spec per distinct granted server, in first-declaration order.
 * @throws when a granted name is outside the registry, when an
 *   env-needing server has no binding, or when its repo is absent from the env.
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
