import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import { TOOL_LABELS, workerBaseline, WORKER_BASELINE_LABELS, WORKER_BASELINE_TOOLS } from '@dangosys/dsh-singularity-task-runtime'

const text = (value: string) => [{ type: 'text' as const, text: value }]

/**
 * `filesystem → read, write, edit, read_image` — the label kept, the real DSH
 * names it resolves to shown, so a reader can see what a worker is actually
 * granted. A label outside the vocabulary is shown as such and is what
 * admission rejects when the capability is next resolved.
 */
function renderTools(entry: CapabilityConfig): string {
  const labels = entry.tools ?? []
  if (labels.length === 0) return 'tools: []'
  const declared = labels
    .map(label => (TOOL_LABELS[label] === undefined ? `${label} → (unknown label)` : `${label} → ${TOOL_LABELS[label]!.join(', ')}`))
    .join('; ')
  return `tools: [${declared}]`
}

function renderPermission(entry: CapabilityConfig): string {
  return entry.permission === undefined ? 'permission: (none — the worker keeps danger-full-access)' : `permission: ${entry.permission}`
}

function renderMcpServers(entry: CapabilityConfig): string {
  const servers = entry.mcpServers ?? []
  if (servers.length === 0) return ''
  return `mcpServers: [${servers.join(', ')}] (mounted per worker at spawn, bound to the run's env checkout; tools appear as mcp__<server>__<tool>)`
}

export function defineCapabilityListTool(ctx: Context) {
  return defineTool({
    name: 'capability_list',
    description:
      'List the capability names the task runtime can grant, with the tools/skills/agent preset each one carries. ' +
      'Call this before task_decompose to pick requiredCapabilities: a name outside this list is a capability gap, ' +
      'and the gap rejects the whole decomposition batch unless that child is declared decomposable.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async () => {
      const capabilities = ctx.taskRuntime.listCapabilities()
      const names = Object.keys(capabilities)
      if (names.length === 0) return 'no capabilities configured'
      const lines = names.map(name => {
        const entry = capabilities[name]!
        const mcp = renderMcpServers(entry)
        const grants = [
          renderTools(entry),
          `skills: [${(entry.skills ?? []).join(', ')}]`,
          ...(entry.preset !== undefined ? [`preset: ${entry.preset}`] : []),
          ...(mcp === '' ? [] : [mcp]),
          renderPermission(entry),
        ]
        return `- ${name} — ${grants.join(' ')}`
      })
      return [
        `capabilities (${names.length}):`,
        ...lines,
        '',
        `worker baseline (every capability worker keeps these on top of its grants): ${workerBaseline().join(', ')}`,
        `baseline labels: ${WORKER_BASELINE_LABELS.join(', ')}; task machinery: ${WORKER_BASELINE_TOOLS.join(', ')}`,
        '',
        'tool labels: a capability declares labels (filesystem, bash, …); each expands to the DSH tool names shown after "→".',
        'tool grants are fail-closed: a worker sees its capabilities\' tools plus the baseline plus (when a capability names its own preset) that preset\'s whole tool plane — nothing else from the global layer.',
        'skill grants are not exclusive: DSH has no per-agent skill hiding, so a granted skill is registered for that worker alone and guaranteed loadable, but the worker\'s skill catalog still lists every skill its composition can discover.',
        'mcpServers grant whole MCP servers (never single tools): each mounts as one mcp-client instance on the worker at spawn, bound to that run\'s environment checkout; a server that cannot start fails the spawn loudly.',
        'permissions: a capability that declares none leaves the worker on the deployment default (danger-full-access); flipping the default is blocked until worker approvals reliably reach the canvas (#17 in the working guide).',
      ].join('\n')
    },
  })
}
