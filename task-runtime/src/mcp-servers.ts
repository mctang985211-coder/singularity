/**
 * The deployment MCP registry: the table a capability's `mcpServers`
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
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** Per-tool-call deadline handed to mcp-client; defaults to the client default (60 s). */
  toolCallTimeoutMs?: number
}

/** Parse deployment and candidate definitions through one schema and namespace policy. */
export function parseMcpServerRegistry(value: unknown): Record<string, McpServerTemplate> {
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
  const fail = (where: string, detail: string): never => { throw new Error(`task-runtime: MCP ${where} ${detail}`) }
  const string = (item: unknown, where: string, nonempty = false): string => {
    if (typeof item !== 'string' || item.includes('\0') || (nonempty && item.trim().length === 0))
      fail(where, 'must be a string without NUL bytes' + (nonempty ? ' and must be non-empty' : ''))
    return item as string
  }
  if (!record(value)) fail('registry', 'must be an object')
  const registry: Record<string, McpServerTemplate> = {}
  const namespaces = new Set<string>()
  const fields = ['serverName', 'description', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs']
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail(`registry key ${JSON.stringify(key)}`, 'must be a safe name')
    if (!record(raw)) fail(`server ${key}`, 'must be an object')
    const item = raw as Record<string, unknown>
    for (const field of Object.keys(item)) if (!fields.includes(field)) fail(`server ${key}`, `declares unknown field ${field}`)
    const serverName = string(item.serverName, `${key}.serverName`, true)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) fail(`${key}.serverName`, 'must match [A-Za-z0-9_-]{1,32}')
    if (namespaces.has(serverName)) fail(`${key}.serverName`, `duplicates namespace ${serverName}`)
    namespaces.add(serverName)
    const template: McpServerTemplate = {
      serverName, description: string(item.description, `${key}.description`, true), command: string(item.command, `${key}.command`, true),
    }
    if (item.args !== undefined) {
      if (!Array.isArray(item.args)) fail(`${key}.args`, 'must be an array')
      template.args = (item.args as unknown[]).map(arg => string(arg, `${key}.args`))
    }
    if (item.env !== undefined) {
      if (!record(item.env)) fail(`${key}.env`, 'must be an object')
      template.env = Object.fromEntries(Object.entries(item.env as Record<string, unknown>).map(([name, val]) => {
        if (!name || /[=\0]/.test(name)) fail(`${key}.env`, 'has an invalid variable name')
        return [name, string(val, `${key}.env.${name}`)]
      }))
    }
    if (item.cwd !== undefined) template.cwd = string(item.cwd, `${key}.cwd`, true)
    if (item.toolCallTimeoutMs !== undefined) {
      if (!Number.isSafeInteger(item.toolCallTimeoutMs) || (item.toolCallTimeoutMs as number) <= 0)
        fail(`${key}.toolCallTimeoutMs`, 'must be a positive safe integer')
      template.toolCallTimeoutMs = item.toolCallTimeoutMs as number
    }
    for (const field of [template.command, ...(template.args ?? []), ...Object.values(template.env ?? {}), ...(template.cwd === undefined ? [] : [template.cwd])]) {
      if (ANY_PLACEHOLDER_LIKE.test(field.replace(PLACEHOLDER, ''))) fail(`server ${key}`, 'carries an unknown environment placeholder')
    }
    registry[key] = template
  }
  return registry
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
  registry: Readonly<Record<string, McpServerTemplate>>,
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
