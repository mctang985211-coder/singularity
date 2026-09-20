import { describe, expect, test } from 'vitest'
import {
  capabilitySnapshot,
  resolveCapabilities,
  resolvePermission,
  resolvePreset,
  resolveToolLabels,
  workerBaseline,
  TOOL_LABELS,
  WORKER_BASELINE_TOOLS,
  type PermissionSpec,
} from '../../src/capability.ts'
import { DEFAULT_CAPABILITIES, TaskRuntime } from '../../src/index.ts'

const PERMISSION_BUNDLES: Record<string, PermissionSpec> = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  'unconfined-ask': { sandbox: 'danger-full-access', approval: 'ask' },
}

function permissionSpecs(name: string): PermissionSpec {
  const spec = PERMISSION_BUNDLES[name]
  if (spec === undefined) throw new Error(`permission: unknown preset "${name}"`)
  return spec
}

describe('resolveCapabilities', () => {
  test('closed closure when every required capability has an entry', () => {
    const manifest = resolveCapabilities(['design-chip', 'verify-ball-functional'], DEFAULT_CAPABILITIES)
    expect(manifest.closure).toBe('closed')
    expect(manifest.missing).toEqual([])
    expect(manifest.capabilities['design-chip']).toEqual({ skills: ['chip-designer'], tools: [] })
    expect(manifest.capabilities['verify-ball-functional']).toEqual({
      skills: ['verify'], tools: [], preset: 'bb-verify', mcpServers: ['bbdev'],
    })
  })

  test('gap closure lists every missing name and keeps the hits', () => {
    const manifest = resolveCapabilities(['design-chip', 'no-such-cap', 'also-missing'], DEFAULT_CAPABILITIES)
    expect(manifest.closure).toBe('gap')
    expect(manifest.missing).toEqual(['no-such-cap', 'also-missing'])
    expect(Object.keys(manifest.capabilities)).toEqual(['design-chip'])
  })

  test('an empty requirement list is trivially closed', () => {
    const manifest = resolveCapabilities([], DEFAULT_CAPABILITIES)
    expect(manifest).toEqual({ capabilities: {}, missing: [], closure: 'closed' })
  })

  test('the buckyball defaults ship the plan-mandated mapping', () => {
    expect(DEFAULT_CAPABILITIES['design-ball']).toEqual({ skills: ['ball-align'], tools: ['filesystem', 'bash'] })
    expect(DEFAULT_CAPABILITIES['check-ball-registration']).toEqual({ skills: ['check'], mcpServers: ['bbdev'] })
    expect(DEFAULT_CAPABILITIES['verify-ball-functional']).toEqual({ skills: ['verify'], preset: 'bb-verify', mcpServers: ['bbdev'] })
    expect(DEFAULT_CAPABILITIES['run-bemu-regression']).toEqual({ skills: ['verify'], preset: 'bb-verify', mcpServers: ['bbdev'] })
    expect(DEFAULT_CAPABILITIES['run-verilator-regression']).toEqual({ skills: ['verify', 'waveform'], preset: 'bb-verify', mcpServers: ['bbdev'] })
    expect(DEFAULT_CAPABILITIES['build-chip-config']).toEqual({ mcpServers: ['bbdev'] })
    expect(DEFAULT_CAPABILITIES['build-compiler']).toEqual({ mcpServers: ['bbdev'] })
    expect(DEFAULT_CAPABILITIES['build-workload']).toEqual({ mcpServers: ['bbdev'] })
    expect(DEFAULT_CAPABILITIES['build-kernel']).toEqual({ mcpServers: ['bbdev'] })
    expect(DEFAULT_CAPABILITIES['integrate-model']).toEqual({ skills: ['workload-tests'] })
    expect(DEFAULT_CAPABILITIES['analyze-waveform']).toEqual({ skills: ['waveform'] })
    expect(DEFAULT_CAPABILITIES['research']).toEqual({ preset: 'standard' })
  })

  test('a config override replaces the default registry', () => {
    const manifest = resolveCapabilities(['research'], { research: { skills: ['web'] } })
    expect(manifest.capabilities['research']).toEqual({ skills: ['web'], tools: [] })
  })
})

describe('TaskRuntime.applyCapabilityRow (W16 evolution apply/rollback seam)', () => {
  function runtime() {
    const ctx = { reflect: { provide: () => {} }, effect: () => {} }
    return new TaskRuntime(ctx as never)
  }

  test('replaces a row whole, adds a new one, removes one — resolution sees each immediately', () => {
    const rt = runtime()
    rt.applyCapabilityRow('research', { preset: 'standard', skills: ['verify'] })
    expect(rt.listCapabilities()['research']).toEqual({ preset: 'standard', skills: ['verify'] })
    expect(resolveCapabilities(['research'], rt.listCapabilities()).capabilities['research'])
      .toEqual({ preset: 'standard', skills: ['verify'], tools: [] })
    rt.applyCapabilityRow('new-cap', { tools: ['bash'] })
    expect(rt.listCapabilities()['new-cap']).toEqual({ tools: ['bash'] })
    rt.applyCapabilityRow('research', null)
    expect(rt.listCapabilities()['research']).toBeUndefined()
    // the shipped defaults are untouched — the runtime clones them at construction
    expect(DEFAULT_CAPABILITIES['research']).toEqual({ preset: 'standard' })
  })

  test('a rollback restores the champion row after the candidate ruled', () => {
    const rt = runtime()
    rt.applyCapabilityRow('research', { preset: 'standard', skills: ['verify'] })
    rt.applyCapabilityRow('research', { preset: 'standard' })
    expect(rt.listCapabilities()['research']).toEqual({ preset: 'standard' })
  })
})

describe('tool labels', () => {
  test('a label expands to the real DSH tool names it grants', () => {
    expect(resolveToolLabels('design-ball', ['filesystem', 'bash'])).toEqual(['read', 'write', 'edit', 'bash'])
    expect(resolveToolLabels('design-ball', ['jobs'])).toEqual(['job_output', 'job_list', 'job_kill'])
    expect(resolveToolLabels('design-ball', [])).toEqual([])
  })

  test('resolution expands labels, so the manifest carries real names', () => {
    const manifest = resolveCapabilities(['design-ball'], DEFAULT_CAPABILITIES)
    expect(manifest.capabilities['design-ball']!.tools).toEqual(['read', 'write', 'edit', 'bash'])
  })

  test('an unknown label rejects the whole resolution and names the vocabulary', () => {
    expect(() => resolveCapabilities(['typo'], { typo: { tools: ['filesytem'] } })).toThrow(
      /capability "typo" declares unknown tool label "filesytem"; known labels: /,
    )
    expect(() => resolveCapabilities(['typo'], { typo: { tools: ['filesytem'] } })).toThrow(/ask-user, bash, filesystem/)
    expect(() => resolveCapabilities(['typo'], { typo: { tools: ['filesytem'] } })).toThrow(/skill, subagent, todo, web/)
  })

  test('every shipped label resolves to a non-empty name list', () => {
    for (const [label, names] of Object.entries(TOOL_LABELS)) {
      expect(names.length, label).toBeGreaterThan(0)
      expect(names.every(name => name.length > 0), label).toBe(true)
    }
    // `run_code` is reserved by the tools registry: naming it in a filter throws.
    expect(Object.values(TOOL_LABELS).flat()).not.toContain('run_code')
  })

  test('the worker baseline is the expanded labels plus the task machinery, and nothing else', () => {
    const baseline = workerBaseline()
    expect(baseline).toEqual([
      'read', 'write', 'edit',
      'bash',
      'job_output', 'job_list', 'job_kill',
      'glob', 'grep',
      'skill',
      'session_event_read', 'session_event_trace', 'session_trace',
      'ask_user_question',
      'task_read', 'task_status', 'task_decompose', 'task_verify',
    ])
    expect(baseline).toEqual([...new Set(baseline)])
    // The task machinery is the tail, in the order WORKER_BASELINE_TOOLS declares.
    expect(baseline.slice(-WORKER_BASELINE_TOOLS.length)).toEqual([...WORKER_BASELINE_TOOLS])
    // Growth happens through task_decompose admission; the graph surface is never a worker's.
    expect(baseline).not.toContain('graph_spawn')
    expect(baseline).not.toContain('graph_mark_ready')
  })
})

describe('manifest flattening', () => {
  test('capabilitySnapshot dedupes and sorts granted skills and tools', () => {
    const manifest = resolveCapabilities(['design-ball', 'design-chip'], DEFAULT_CAPABILITIES)
    expect(capabilitySnapshot(manifest)).toEqual(['ball-align', 'bash', 'chip-designer', 'edit', 'read', 'write'])
  })

  test('capabilitySnapshot marks granted MCP servers as mcp:<name>', () => {
    const manifest = resolveCapabilities(['check-ball-registration', 'build-kernel'], DEFAULT_CAPABILITIES)
    expect(capabilitySnapshot(manifest)).toEqual(['check', 'mcp:bbdev'])
  })

  test('resolvePreset prefers the first capability preset, then the default', () => {
    const withPreset = resolveCapabilities(['design-chip', 'verify-ball-functional'], DEFAULT_CAPABILITIES)
    expect(resolvePreset(withPreset, 'fallback')).toBe('bb-verify')
    const withoutPreset = resolveCapabilities(['design-chip'], DEFAULT_CAPABILITIES)
    expect(resolvePreset(withoutPreset, 'fallback')).toBe('fallback')
    expect(resolvePreset(withoutPreset)).toBeUndefined()
  })
})

describe('capability MCP server grants', () => {
  test('a declared server name lands on the manifest entry', () => {
    const manifest = resolveCapabilities(['check-ball-registration'], DEFAULT_CAPABILITIES)
    expect(manifest.capabilities['check-ball-registration']!.mcpServers).toEqual(['bbdev'])
  })

  test('an unknown server name rejects the whole resolution, naming the vocabulary', () => {
    expect(() => resolveCapabilities(['typo'], { typo: { mcpServers: ['ghost'] } })).toThrow(
      'capability "typo" declares unknown MCP server "ghost"; known servers: bbdev',
    )
  })

  test('an empty mcpServers array normalizes to absence on the manifest', () => {
    const manifest = resolveCapabilities(['design-ball'], DEFAULT_CAPABILITIES)
    expect(manifest.capabilities['design-ball']).not.toHaveProperty('mcpServers')
  })
})

describe('resolvePermission', () => {
  test('undefined when no matched capability declares a permission', () => {
    const manifest = resolveCapabilities(['design-chip'], DEFAULT_CAPABILITIES)
    expect(resolvePermission(manifest, permissionSpecs)).toBeUndefined()
  })

  test('the single declared permission wins and is carried on the manifest entry', () => {
    const manifest = resolveCapabilities(['audited'], { audited: { permission: 'workspace-write' } })
    expect(manifest.capabilities['audited']).toEqual({ skills: [], tools: [], permission: 'workspace-write' })
    expect(resolvePermission(manifest, permissionSpecs)).toBe('workspace-write')
  })

  test('conflicting declarations settle on the strictest sandbox tier', () => {
    const registry = {
      loose: { permission: 'danger-full-access' },
      mid: { permission: 'workspace-write' },
      tight: { permission: 'read-only' },
    }
    expect(resolvePermission(resolveCapabilities(['loose', 'mid'], registry), permissionSpecs)).toBe('workspace-write')
    expect(resolvePermission(resolveCapabilities(['loose', 'mid', 'tight'], registry), permissionSpecs)).toBe('read-only')
    expect(resolvePermission(resolveCapabilities(['tight', 'loose'], registry), permissionSpecs)).toBe('read-only')
  })

  test('the approval knob breaks sandbox ties in favor of ask', () => {
    const registry = {
      loose: { permission: 'danger-full-access' },
      asking: { permission: 'unconfined-ask' },
    }
    expect(resolvePermission(resolveCapabilities(['loose', 'asking'], registry), permissionSpecs)).toBe('unconfined-ask')
  })

  test('an unknown preset name fails loud instead of being skipped', () => {
    const manifest = resolveCapabilities(['broken'], { broken: { permission: 'nope' } })
    expect(() => resolvePermission(manifest, permissionSpecs)).toThrow('unknown preset "nope"')
  })
})
