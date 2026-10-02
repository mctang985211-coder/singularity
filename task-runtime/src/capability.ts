import type { CapabilityManifest } from '@dangosys/dsh-singularity-task'
import type { McpServerTemplate } from './mcp-servers.ts'

/**
 * Reject MCP server names outside the registry, the same discipline
 * {@link resolveToolLabels} applies to labels: named vocabulary in the error,
 */
/** Reject a name outside a closed vocabulary, naming the vocabulary in the refusal. */
function assertKnownName(
  capability: string,
  kind: string,
  knownLabel: string,
  knownNames: readonly string[],
  name: string,
): void {
  if (knownNames.includes(name)) return
  throw new Error(
    `task-runtime: capability "${capability}" declares unknown ${kind} "${name}"; ${knownLabel}: ${[...knownNames].sort().join(', ')}`,
  )
}

/** One capability entry as held in plugin Config (arrays optional pre-validation). */
export interface CapabilityConfig {
  skills?: string[]
  tools?: string[]
  preset?: string
  /** Permission preset (`permissionPresets` table key) granted when a task requires this capability. */
  permission?: string
  /**
   * MCP server names from the deployment registry
   * granted when a task requires this capability; each mounts as one
   */
  mcpServers?: string[]
}

/**
 * Capability tool labels → the real DSH tool names each label grants.
 * A capability table is authored against what the WORK needs, not against
 */
export const TOOL_LABELS: Readonly<Record<string, readonly string[]>> = {
  filesystem: ['read', 'write', 'edit'],
  search: ['glob', 'grep'],
  bash: ['bash'],
  jobs: ['job_output', 'job_list', 'job_kill'],
  skill: ['skill'],
  'ask-user': ['ask_user_question'],
  web: ['web_fetch', 'web_search'],
  todo: ['todo_write'],
  goal: ['get_goal', 'create_goal', 'update_goal'],
  subagent: ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents'],
}

/**
 * Expand one capability's tool labels into real DSH tool names.
 * @param capability - capability name, named in the rejection.
 */
export function resolveToolLabels(capability: string, labels: readonly string[]): string[] {
  return labels.flatMap(label => {
    assertKnownName(capability, 'tool label', 'known labels', Object.keys(TOOL_LABELS), label)
    return [...TOOL_LABELS[label]!]
  })
}

/**
 * The capability-worker baseline: what every worker needs whatever its
 * capabilities are, because its own prompt tells it to use these. Every entry
 */
export const WORKER_BASELINE_LABELS: readonly string[] = ['filesystem', 'bash', 'jobs', 'search', 'skill', 'ask-user']

/**
 * Baseline tool names that are not a capability label: the task machinery the
 * worker prompt calls. They are exactly the Layer-0 universal control tools the
 */
export const WORKER_BASELINE_TOOLS: readonly string[] = [
  'task_read',
  'task_status',
  'context_read',
  'task_decompose',
  'task_submit_result',
  'task_cancel',
  'task_verify',
  'capability_list',
  'task_template_list',
  'task_proposal_read',
  'task_proposal_continue',
  'task_proposal_cancel',
  'task_ask_parent',
  'task_answer',
]

/**
 * Every real tool name a capability worker keeps on top of what its
 * capabilities declare.
 */
export function workerBaseline(): string[] {
  return [...new Set([...resolveToolLabels('worker baseline', WORKER_BASELINE_LABELS), ...WORKER_BASELINE_TOOLS])]
}

/**
 * Resolve required capability names against the configured registry.
 * A required name that has an entry contributes its skills/tools/preset to the
 */
export function resolveCapabilities(
  required: readonly string[],
  registry: Readonly<Record<string, CapabilityConfig>>,
  mcpServers?: Readonly<Record<string, McpServerTemplate>>,
): CapabilityManifest {
  const capabilities: CapabilityManifest['capabilities'] = {}
  const missing: string[] = []
  for (const name of required) {
    const entry = registry[name]
    if (entry === undefined) {
      missing.push(name)
      continue
    }
    if (mcpServers !== undefined) for (const server of entry.mcpServers ?? [])
      assertKnownName(name, 'MCP server', 'known servers', Object.keys(mcpServers), server)
    capabilities[name] = {
      skills: [...(entry.skills ?? [])],
      tools: resolveToolLabels(name, entry.tools ?? []),
      ...(entry.preset !== undefined ? { preset: entry.preset } : {}),
      ...(entry.permission !== undefined ? { permission: entry.permission } : {}),
      ...(entry.mcpServers !== undefined && entry.mcpServers.length > 0 ? { mcpServers: [...entry.mcpServers] } : {}),
    }
  }
  const manifest: CapabilityManifest = { capabilities, missing, closure: missing.length > 0 ? 'gap' : 'closed' }
  // Admission and replay both resolve here before persisting tasks.
  resolvePreset(manifest)
  return manifest
}

/**
 * Flatten a manifest's granted skills and tools into a run's capability
 * snapshot; each granted MCP server rides along as an `mcp:<serverName>`
 */
export function capabilitySnapshot(manifest: CapabilityManifest): string[] {
  const granted = new Set<string>()
  for (const entry of Object.values(manifest.capabilities)) {
    for (const skill of entry.skills) granted.add(skill)
    for (const tool of entry.tools) granted.add(tool)
    for (const server of entry.mcpServers ?? []) granted.add(`mcp:${server}`)
  }
  return [...granted].sort()
}

/** One worker mounts one preset. Conflicting declarations are a configuration error. */
export function resolvePreset(manifest: CapabilityManifest, defaultPreset?: string): string | undefined {
  const declared = Object.entries(manifest.capabilities).filter(([, entry]) => entry.preset !== undefined)
  const presets = new Set(declared.map(([, entry]) => entry.preset!))
  if (presets.size > 1) {
    const detail = declared
      .map(([name, entry]) => `${name} -> ${entry.preset}`)
      .sort()
      .join(', ')
    throw new Error(`task-runtime: conflicting capability presets: ${detail}; one worker requires one preset`)
  }
  return declared[0]?.[1].preset ?? defaultPreset
}

/** One permission preset's knob bundle, as `permissionPresets.resolve` reports it. */
export interface PermissionSpec {
  sandbox: string
  approval: string
}

/**
 * Strictness order for conflicting capability permissions (strictest wins):
 * sandbox decides first (`read-only` > `workspace-write` > `danger-full-access`),
 */
const SANDBOX_STRICTNESS: Readonly<Record<string, number>> = {
  'read-only': 2,
  'workspace-write': 1,
  'danger-full-access': 0,
}
const APPROVAL_STRICTNESS: Readonly<Record<string, number>> = { ask: 1, never: 0 }

/**
 * The permission preset a spawned worker runs under: the strictest preset any
 * matched capability declares, or `undefined` when none declares one (the
 */
export function resolvePermission(
  manifest: CapabilityManifest,
  resolveSpec: (name: string) => PermissionSpec,
): string | undefined {
  const declared = [
    ...new Set(
      Object.values(manifest.capabilities).flatMap(entry => (entry.permission === undefined ? [] : [entry.permission])),
    ),
  ]
  if (declared.length === 0) return undefined
  const rank = (name: string): readonly [number, number] => {
    const spec = resolveSpec(name)
    const sandbox = SANDBOX_STRICTNESS[spec.sandbox]
    const approval = APPROVAL_STRICTNESS[spec.approval]
    if (sandbox === undefined || approval === undefined) {
      throw new Error(
        `permission preset "${name}" has an unrankable knob bundle (sandbox: ${spec.sandbox}, approval: ${spec.approval})`,
      )
    }
    return [sandbox, approval]
  }
  // Rank every declaration up front: resolving doubles as validation, and a
  // lone declared name must still fail loud when the registry rejects it.
  const ranked = declared.map(name => ({ name, rank: rank(name) }))
  return ranked.reduce((strictest, item) =>
    item.rank[0] > strictest.rank[0] || (item.rank[0] === strictest.rank[0] && item.rank[1] > strictest.rank[1])
      ? item
      : strictest,
  ).name
}
