import type { CapabilityManifest } from '@dangosys/dsh-singularity-task'
import { MCP_SERVER_REGISTRY } from './mcp-servers.ts'

/**
 * Reject MCP server names outside the registry, the same discipline
 * {@link resolveToolLabels} applies to labels: named vocabulary in the error,
 * whole resolution rejected before anything is persisted or spawned.
 */
function assertKnownMcpServers(capability: string, names: readonly string[]): void {
  for (const name of names) {
    if (MCP_SERVER_REGISTRY[name] === undefined) {
      throw new Error(
        `task-runtime: capability "${capability}" declares unknown MCP server "${name}"; known servers: ${Object.keys(MCP_SERVER_REGISTRY).sort().join(', ')}`,
      )
    }
  }
}

/** One capability entry as held in plugin Config (arrays optional pre-validation). */
export interface CapabilityConfig {
  skills?: string[]
  tools?: string[]
  preset?: string
  /** Permission preset (`permissionPresets` table key) granted when a task requires this capability. */
  permission?: string
  /**
   * MCP server names (keys of `MCP_SERVER_REGISTRY` in `./mcp-servers.ts`)
   * granted when a task requires this capability; each mounts as one
   * mcp-client instance on the worker's own scope at spawn, bound to that
   * run's env checkout. Unknown names reject the resolution, exactly like
   * unknown tool labels.
   */
  mcpServers?: string[]
}

/**
 * Capability tool labels → the real DSH tool names each label grants.
 *
 * A capability table is authored against what the WORK needs, not against
 * whichever names a given harness release registers: `filesystem` stays
 * `filesystem` while DSH's file tools are `read`/`write`/`edit`. This table is
 * the whole vocabulary — a label outside it is rejected at admission — and its
 * values are the names that reach the worker's tool filter. Each value is the
 * `name` the registering tool plugin declares:
 *
 * | label             | registers in                                                        |
 * | ----------------- | ------------------------------------------------------------------- |
 * | filesystem        | `fs/tool-fs` (`read.ts:78`, `write.ts:73`, `edit.ts:85`)             |
 * | search            | `fs/tool-fs-search` (`glob.ts:313`, `grep.ts:285`)                  |
 * | bash              | `shell/tool-bash` (`index.ts:242`)                                  |
 * | jobs              | `jobs/tool-jobs` (`index.ts:302,342,362`)                           |
 * | skill             | `skill/tool-skill` (`index.ts:82`)                                  |
 * | session-history   | `session-query/tool-session-query` (`index.ts:109,96,86`)           |
 * | ask-user          | `interaction/tool-ask-user` (`index.ts:21`)                         |
 * | web               | `web/tool-web` (`fetch.ts:459`, `search.ts:326`)                    |
 * | todo              | `todo/tool-todo` (`index.ts:147`)                                   |
 * | goal              | `goal/tool-goal` (`index.ts:195,207,234`)                           |
 * | subagent          | `subagent/tool-subagent` (`index.ts:380`), `.../tool-subagent-control` (`index.ts:29,77`, `list-agents.ts:93`) |
 *
 * Paths are relative to `thirdparty/deepseek-harness/packages/`.
 *
 * A label only carries names a composition can be expected to mount; a
 * capability-declared name the worker's own composition does not offer fails
 * that spawn loudly (`agent-runtime/src/grants.ts`), which is the point — the
 * capability asked for a tool the composition cannot give. `read_image` is
 * deliberately NOT in `filesystem`: `tool-fs` registers it only while
 * `attachments` is mounted (`fs/tool-fs/src/index.ts:70-73`), so granting it
 * would make every filesystem capability depend on a plane it never names.
 * `bash` is likewise absent on a Windows deployment, where the standard preset
 * disables `tool-bash`.
 */
export const TOOL_LABELS: Readonly<Record<string, readonly string[]>> = {
  filesystem: ['read', 'write', 'edit'],
  search: ['glob', 'grep'],
  bash: ['bash'],
  jobs: ['job_output', 'job_list', 'job_kill'],
  skill: ['skill'],
  'session-history': ['session_event_read', 'session_event_trace', 'session_trace'],
  'ask-user': ['ask_user_question'],
  web: ['web_fetch', 'web_search'],
  todo: ['todo_write'],
  goal: ['get_goal', 'create_goal', 'update_goal'],
  subagent: ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents'],
}

/**
 * Expand one capability's tool labels into real DSH tool names.
 * @param capability - capability name, named in the rejection.
 * @param labels - the labels the capability declares.
 * @returns every real tool name the labels grant, in declaration order.
 * @throws when a label is not in {@link TOOL_LABELS}; the error lists the vocabulary.
 */
export function resolveToolLabels(capability: string, labels: readonly string[]): string[] {
  return labels.flatMap(label => {
    const expanded = TOOL_LABELS[label]
    if (expanded === undefined) {
      throw new Error(
        `task-runtime: capability "${capability}" declares unknown tool label "${label}"; known labels: ${Object.keys(TOOL_LABELS).sort().join(', ')}`,
      )
    }
    return [...expanded]
  })
}

/**
 * The capability-worker baseline: what every worker needs whatever its
 * capabilities are, because its own prompt tells it to use these. Every entry
 * cites the prompt line that needs it (`handoff.ts:renderWorkerPrompt`, plus
 * the shell tool's own guidance for `jobs`):
 *
 * - `filesystem` — "Do the work" / "Keep changes scoped to this task" (`:135-137`).
 * - `bash` — "Where a criterion lists a command, make that command exit 0 in the checkout" (`:136`).
 * - `jobs` — that same command is often long-running, and `bash`'s own description
 *   tells the model to collect background output with `job_output`/`job_kill`.
 * - `search` — locate the code the work touches.
 * - `skill` — without the loader the granted skills are unreachable, and
 *   `tool-skill` only injects the catalog when its tool is visible.
 * - `session-history` — "Read it exactly with `session_event_read` … or `session_trace`" (`:119`).
 * - `ask-user` — "Need a human decision? Ask with `ask_user_question`" (`:137`).
 *
 * A composition that offers none of them (the `bb-verify` node mounts no shell)
 * simply keeps what it has: see `agent-runtime/src/grants.ts`.
 */
export const WORKER_BASELINE_LABELS: readonly string[] = [
  'filesystem',
  'bash',
  'jobs',
  'search',
  'skill',
  'session-history',
  'ask-user',
]

/**
 * Baseline tool names that are not a capability label: the task machinery the
 * worker prompt calls. They are exactly the Layer-0 universal control tools the
 * frozen material fixes for every agent (`细化想法4.md:724-738`: `task_read`,
 * `task_decompose`, `task_status`, and the verifier tool this deployment names
 * `task_verify`) — L0 is the "every node, whatever it works on" layer, so a
 * worker keeps it whatever its capabilities declare.
 *
 * They are listed here individually, unlike the labels above, because these tools
 * are registered on the GLOBAL layer rather than a capability or preset plane
 * (`agent-singularity/src/index.ts`): the grant filter only keeps an inherited
 * tool the allow-list names (`agent-runtime/src/grants.ts:99`), and there is no
 * label that could expand to them.
 *
 * Every entry cites the prompt or tool contract that needs it:
 * - `capability_list`: `task_decompose` asks callers to discover valid capability
 *   names before proposing children, including recursively spawned workers.
 * - `task_decompose` — "Call `task_decompose` instead, with a `reason` and the child task list" (`handoff.ts:87`),
 *   and for a `leaf` worker whose deployment runs with `Config.allowRuntimeDecomposition` on,
 *   the runtime-split rule (`handoff.ts:127`) that opens the same tool to it.
 * - `task_read` — "re-read your own contract and run with `task_read`" (`handoff.ts:140`).
 * - `task_status` — the same line: the whole tree with `task_status` (`handoff.ts:140`).
 * - `task_verify` — "Before you finish, `task_verify` re-runs the verifier as a self-check" (`handoff.ts:141`).
 *
 * `graph_spawn` is deliberately NOT here, even though the deployment registers
 * it for the root: it reaches the graph without Task Admission and returns the
 * child's last assistant text as its result, which breaks frozen invariants #2
 * ("Task 可以自由生成，但必须通过 Task Admission") and #6 ("Parent 必须消费
 * evidence，而不是直接相信 child natural-language result")
 * (`细化想法4.md:2075`, `:2079`); such a node has no task record, so no evidence,
 * no review, and nothing `task_status` or the parent's composite criterion can
 * see. Nodes grow by their worker calling `task_decompose`, which admits the
 * batch and has the orchestrator spawn each child. Every worker holds that tool
 * whatever its `decompositionStatus`; whether a `leaf` task's own call is
 * admitted is the runtime's decision, not the tool plane's
 * (`Config.allowRuntimeDecomposition`, `index.ts:DEFAULT_ALLOW_RUNTIME_DECOMPOSITION`).
 */
export const WORKER_BASELINE_TOOLS: readonly string[] = ['task_read', 'task_status', 'task_decompose', 'task_verify', 'capability_list']

/**
 * Every real tool name a capability worker keeps on top of what its
 * capabilities declare.
 * @returns the expanded baseline, de-duplicated.
 */
export function workerBaseline(): string[] {
  return [...new Set([...resolveToolLabels('worker baseline', WORKER_BASELINE_LABELS), ...WORKER_BASELINE_TOOLS])]
}

/**
 * Resolve required capability names against the configured registry.
 * A required name that has an entry contributes its skills/tools/preset to the
 * manifest; a name without an entry lands in `missing`. Closure is `closed`
 * when nothing is missing, otherwise `gap`.
 *
 * Tool labels are expanded here, so the manifest carries the real DSH tool names
 * a worker is granted — and an unknown label rejects the whole resolution with
 * the vocabulary named, before anything is persisted or spawned. MCP server
 * names are validated against `MCP_SERVER_REGISTRY` the same way and copied
 * onto the manifest entry; the spawn seam binds them to the run's env.
 * @param required - capability names the caller requires.
 * @param registry - the configured capability table.
 * @returns the resolved manifest.
 * @throws when a matched capability declares a tool label outside {@link TOOL_LABELS}
 *   or an MCP server outside `MCP_SERVER_REGISTRY`.
 */
export function resolveCapabilities(
  required: readonly string[],
  registry: Readonly<Record<string, CapabilityConfig>>,
): CapabilityManifest {
  const capabilities: CapabilityManifest['capabilities'] = {}
  const missing: string[] = []
  for (const name of required) {
    const entry = registry[name]
    if (entry === undefined) {
      missing.push(name)
      continue
    }
    assertKnownMcpServers(name, entry.mcpServers ?? [])
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
 * marker, so the recorded grant shows the server plane too (the server's tools
 * themselves appear on the worker as `mcp__<serverName>__<tool>`).
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
  const declared = Object.entries(manifest.capabilities)
    .filter(([, entry]) => entry.preset !== undefined)
  const presets = new Set(declared.map(([, entry]) => entry.preset!))
  if (presets.size > 1) {
    const detail = declared.map(([name, entry]) => `${name} -> ${entry.preset}`).sort().join(', ')
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
 * approval breaks ties (`ask` > `never`), declaration order breaks what remains.
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
 * caller then keeps the default posture). `resolveSpec` (the permissionPresets
 * registry's `resolve`) doubles as existence validation — an unknown preset
 * name fails loudly here, before the spawn.
 */
export function resolvePermission(
  manifest: CapabilityManifest,
  resolveSpec: (name: string) => PermissionSpec,
): string | undefined {
  const declared = [...new Set(
    Object.values(manifest.capabilities).flatMap(entry => (entry.permission === undefined ? [] : [entry.permission])),
  )]
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
