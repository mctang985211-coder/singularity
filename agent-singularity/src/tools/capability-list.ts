import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CapabilityConfig, CapabilityProviderPrecheck, SkillProviderVerdict } from '@dangosys/dsh-singularity-task-runtime'
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

/** The first 12 hex of a content digest: enough to match two listings by eye, not a wall of hex. */
function shortDigest(digest: string): string {
  return digest.slice(0, 12)
}

/**
 * One skill's provider verdict, in the words the pre-check uses: the role it
 * was accepted as — an execution provider, loadable knowledge, plain guidance —
 * or `invalid` with every named defect, so a model reading this before it
 * dispatches sees the same conclusion admission will reach.
 */
function renderProvider(verdict: SkillProviderVerdict): string {
  if (!verdict.valid) {
    return `${verdict.name} → invalid (${verdict.defects.map(item => `${item.code}: ${item.detail}`).join('; ')})`
  }
  if (verdict.role === 'execution-provider') {
    const tools = verdict.requiredTools.length === 0 ? 'none declared' : verdict.requiredTools.join(', ')
    return `${verdict.name} → execution-provider (verifier: ${verdict.verifierRef}; requires: ${tools}; content: ${shortDigest(verdict.contentDigest)})`
  }
  if (verdict.role === 'knowledge') {
    return `${verdict.name} → knowledge (no execution verifier by design; content: ${shortDigest(verdict.contentDigest)})`
  }
  return `${verdict.name} → guidance (no sidecar; loadable guidance, not an execution provider; content: ${shortDigest(verdict.contentDigest)})`
}

/**
 * The provider line under one capability row: every skill's verdict, or the
 * fact that the row grants none. `rows` is the pre-check's own output, so an
 * error message or a missing skill cannot be papered over here.
 *
 * A row the pre-check refused *as a row* — the capability an open evolution
 * commit intent moves (A6) — has no verdicts to show: it was not resolved, and
 * that refusal is what the model has to see before it picks this name for a
 * batch admission will reject.
 */
function renderProviders(row: CapabilityProviderPrecheck | undefined): string {
  if (row === undefined) return 'providers: (not checked)'
  const refusals = row.refusals ?? []
  if (refusals.length > 0) {
    return `providers: (refused — ${refusals.map(item => `${item.code}: ${item.detail}`).join('; ')})`
  }
  if (row.skills.length === 0) return 'providers: (none — the capability grants no skill)'
  return `providers: ${row.skills.map(renderProvider).join(' · ')}`
}

export function defineCapabilityListTool(ctx: Context) {
  return defineTool({
    name: 'capability_list',
    description:
      'List the capability names the task runtime can grant, with the tools/skills/agent preset each one carries and the ' +
      'provider verdict for every skill it declares. ' +
      'Call this before task_decompose to pick requiredCapabilities: a name outside this list is a capability gap, ' +
      'and the gap rejects the whole decomposition batch unless that child is declared decomposable.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
    execute: async (_args, exec) => {
      const capabilities = ctx.taskRuntime.listCapabilities()
      const names = Object.keys(capabilities)
      if (names.length === 0) return 'no capabilities configured'
      // The provider verdicts come from the same pre-check admission runs, from
      // this caller's own discovery viewpoint: a skill that is missing or
      // unusable is visible here, before a batch is proposed and refused.
      const caller = exec.agent?.id
      const report = typeof caller === 'string' && caller.length > 0
        ? await ctx.taskRuntime.capabilityProviderReport(caller)
        : undefined
      const verdicts = new Map((report?.capabilities ?? []).map(row => [row.capability, row]))
      const lines = names.flatMap(name => {
        const entry = capabilities[name]!
        const mcp = renderMcpServers(entry)
        const grants = [
          renderTools(entry),
          `skills: [${(entry.skills ?? []).join(', ')}]`,
          ...(entry.preset !== undefined ? [`preset: ${entry.preset}`] : []),
          ...(mcp === '' ? [] : [mcp]),
          renderPermission(entry),
        ]
        return [
          `- ${name} — ${grants.join(' ')}`,
          `    ${report === undefined ? 'providers: (not checked — the tool was called without a calling session)' : renderProviders(verdicts.get(name))}`,
        ]
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
        'provider verdicts are the same pre-check admission runs, from this session\'s own skill roots: execution-provider means the skill carries an execution sidecar whose verifier is registered and whose required tools its capabilities grant; knowledge and guidance are loadable but never count as an execution provider; invalid means admission refuses a batch that requires this capability, with the defects shown.',
        ...(report === undefined ? [] : [`skill roots searched for this session: ${report.roots.join(', ')}`]),
        'mcpServers grant whole MCP servers (never single tools): each mounts as one mcp-client instance on the worker at spawn, bound to that run\'s environment checkout; a server that cannot start fails the spawn loudly.',
        'permissions: a capability that declares none leaves the worker on the deployment default (danger-full-access); flipping the default is blocked until worker approvals reliably reach the canvas (#17 in the working guide).',
      ].join('\n')
    },
  })
}
