import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  capabilitySnapshot,
  resolveCapabilities,
  resolvePermission,
  resolvePreset,
  resolveToolLabels,
  workerBaseline,
  TOOL_LABELS,
  WORKER_BASELINE_TOOLS,
  type CapabilityConfig,
  type PermissionSpec,
} from '../../src/capability.ts'
import { TaskRuntime } from '../../src/index.ts'

/**
 * The capability table a deployment configures (`config.yml`, document 1) —
 * the runtime ships none of its own, so the rows under test stand here the way
 * the deployment spells them.
 */
const DEPLOYMENT_CAPABILITIES: Readonly<Record<string, CapabilityConfig>> = {
  'design-chip': { skills: ['chip-designer'] },
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'check-ball-registration': { skills: ['check'], mcpServers: ['bbdev'] },
  'verify-ball-functional': { skills: ['verify'], mcpServers: ['bbdev'] },
  'run-bemu-regression': { skills: ['verify'], mcpServers: ['bbdev'] },
  'run-verilator-regression': { skills: ['verify'], mcpServers: ['bbdev'] },
  'run-uvm-regression': { skills: ['verify'], mcpServers: ['bbdev'] },
  'measure-ppa': { skills: ['verify'], mcpServers: ['bbdev'] },
  'build-chip-config': { mcpServers: ['bbdev'] },
  'build-compiler': { mcpServers: ['bbdev'] },
  'build-workload': { mcpServers: ['bbdev'] },
  'build-kernel': { mcpServers: ['bbdev'] },
  'integrate-model': { skills: ['model-integration'] },
  'analyze-waveform': { skills: ['waveform'], mcpServers: ['waveform'] },
  research: { preset: 'standard' },
}

/**
 * The skill a capability row grants in this file. A name no deployment installs,
 * so the replacement check (S1-C item 3, D6) can only ever discover the copy
 * this suite wrote into a pinned `$DSH_HOME/skills`.
 */
const ROW_SKILL = 'capability-row-fixture-skill'

let workspace: string
let home: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'capability-row-'))
  home = join(workspace, 'home')
  await mkdir(join(home, 'skills'), { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(workspace, { recursive: true, force: true })
})

/**
 * Install the one skill this file's rows grant: a `SKILL.md` whose frontmatter
 * declares the granted name, plus — when a sidecar is asked for — a declaration
 * whose content identity is the digest of exactly those bytes. The digest is
 * computed here, so the validator is never confirmed against itself.
 */
async function installExecutionSkill(sidecar?: {
  verifierRef: string
  capabilities: readonly string[]
  requiredTools: readonly string[]
}): Promise<string> {
  const directory = join(home, 'skills', ROW_SKILL)
  await mkdir(directory, { recursive: true })
  const skillMd = `---\nname: ${ROW_SKILL}\ndescription: fixture skill for the capability replacement check\n---\n\n# ${ROW_SKILL}\n`
  await writeFile(join(directory, 'SKILL.md'), skillMd)
  if (sidecar === undefined) return directory
  await writeFile(
    join(directory, 'SKILL.contract.json'),
    `${JSON.stringify(
      {
        contractVersion: 1,
        type: 'execution',
        capabilities: [...sidecar.capabilities],
        precondition: 'the fixture skill is installed where discovery looks',
        inputs: [],
        outputs: [],
        requiredTools: [...sidecar.requiredTools],
        verifier: { ref: sidecar.verifierRef },
        content: { skillMdSha256: createHash('sha256').update(skillMd, 'utf8').digest('hex'), resources: [] },
      },
      null,
      2,
    )}\n`,
  )
  return directory
}

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
    const manifest = resolveCapabilities(['design-chip', 'verify-ball-functional'], DEPLOYMENT_CAPABILITIES)
    expect(manifest.closure).toBe('closed')
    expect(manifest.missing).toEqual([])
    expect(manifest.capabilities['design-chip']).toEqual({ skills: ['chip-designer'], tools: [] })
    expect(manifest.capabilities['verify-ball-functional']).toEqual({
      skills: ['verify'],
      tools: [],
      mcpServers: ['bbdev'],
    })
  })

  test('gap closure lists every missing name and keeps the hits', () => {
    const manifest = resolveCapabilities(['design-chip', 'no-such-cap', 'also-missing'], DEPLOYMENT_CAPABILITIES)
    expect(manifest.closure).toBe('gap')
    expect(manifest.missing).toEqual(['no-such-cap', 'also-missing'])
    expect(Object.keys(manifest.capabilities)).toEqual(['design-chip'])
  })

  test('an empty requirement list is trivially closed', () => {
    const manifest = resolveCapabilities([], DEPLOYMENT_CAPABILITIES)
    expect(manifest).toEqual({ capabilities: {}, missing: [], closure: 'closed' })
  })

  test('the runtime ships no capability table: an unconfigured deployment is a named gap for every name', () => {
    expect(resolveCapabilities(['design-chip', 'research'], {})).toEqual({
      capabilities: {},
      missing: ['design-chip', 'research'],
      closure: 'gap',
    })
  })

  test('the deployment table maps each capability to its method skills and MCP servers', () => {
    expect(DEPLOYMENT_CAPABILITIES['design-ball']).toEqual({ skills: ['ball-align'], tools: ['filesystem', 'bash'] })
    expect(DEPLOYMENT_CAPABILITIES['check-ball-registration']).toEqual({ skills: ['check'], mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['verify-ball-functional']).toEqual({ skills: ['verify'], mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['run-bemu-regression']).toEqual({ skills: ['verify'], mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['run-verilator-regression']).toEqual({ skills: ['verify'], mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['run-uvm-regression']).toEqual({ skills: ['verify'], mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['measure-ppa']).toEqual({ skills: ['verify'], mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['build-chip-config']).toEqual({ mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['build-compiler']).toEqual({ mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['build-workload']).toEqual({ mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['build-kernel']).toEqual({ mcpServers: ['bbdev'] })
    expect(DEPLOYMENT_CAPABILITIES['integrate-model']).toEqual({ skills: ['model-integration'] })
    expect(DEPLOYMENT_CAPABILITIES['analyze-waveform']).toEqual({ skills: ['waveform'], mcpServers: ['waveform'] })
    expect(DEPLOYMENT_CAPABILITIES['research']).toEqual({ preset: 'standard' })
  })

  test('a config override replaces the default registry', () => {
    const manifest = resolveCapabilities(['research'], { research: { skills: ['web'] } })
    expect(manifest.capabilities['research']).toEqual({ skills: ['web'], tools: [] })
  })
})

describe('TaskRuntime.applyCapabilityRow (W16 evolution apply/rollback seam)', () => {
  function runtime(table: Readonly<Record<string, CapabilityConfig>> = {}): TaskRuntime {
    // The verifier vocabulary a replacement's execution providers are judged
    // against, resolved softly from the context: the three built-ins.
    const ctx = {
      reflect: { provide: () => {} },
      effect: () => {},
      verifier: { ready: async () => {}, verifierIds: () => ['command', 'composite', 'review'] },
    }
    return new TaskRuntime(ctx as never, { capabilities: { ...table } } as never)
  }

  test('replaces a row whole, adds a new one, removes one — resolution sees each immediately', async () => {
    await installExecutionSkill()
    const rt = runtime()
    await rt.applyCapabilityRow('research', { preset: 'standard', skills: [ROW_SKILL] })
    expect(rt.listCapabilities()['research']).toEqual({ preset: 'standard', skills: [ROW_SKILL] })
    expect(resolveCapabilities(['research'], rt.listCapabilities()).capabilities['research']).toEqual({
      preset: 'standard',
      skills: [ROW_SKILL],
      tools: [],
    })
    await rt.applyCapabilityRow('new-cap', { tools: ['bash'] })
    expect(rt.listCapabilities()['new-cap']).toEqual({ tools: ['bash'] })
    await rt.applyCapabilityRow('research', null)
    expect(rt.listCapabilities()['research']).toBeUndefined()
    // the removal stayed on this runtime's own table — the core ships no table,
    // so a runtime built without a deployment config starts empty
    expect(runtime().listCapabilities()).toEqual({})
  })

  test('a rollback restores the champion row after the candidate ruled', async () => {
    await installExecutionSkill()
    const rt = runtime()
    await rt.applyCapabilityRow('research', { preset: 'standard', skills: [ROW_SKILL] })
    await rt.applyCapabilityRow('research', { preset: 'standard' })
    expect(rt.listCapabilities()['research']).toEqual({ preset: 'standard' })
  })

  test('refuses a replacement whose provider skill is not discoverable, leaving the running table unchanged', async () => {
    const rt = runtime({ research: { preset: 'standard' } })
    const before = rt.listCapabilities()
    const refusal = await rt
      .applyCapabilityRow('research', { skills: ['no-such-provider-skill'] })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain('capability "research"')
    expect(refusal).toContain('skill "no-such-provider-skill"')
    expect(refusal).toContain('skill-missing')
    expect(rt.listCapabilities()).toEqual(before)
    expect(rt.listCapabilities()['research']).toEqual({ preset: 'standard' })
  })

  test('refuses a replacement whose execution provider is unusable, and names every defect', async () => {
    await installExecutionSkill({ verifierRef: 'ghost-verifier', capabilities: ['research'], requiredTools: [] })
    const rt = runtime()
    const before = rt.listCapabilities()
    const unknownVerifier = await rt
      .applyCapabilityRow('research', { skills: [ROW_SKILL] })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(unknownVerifier).toContain('verifier-unknown')
    expect(unknownVerifier).toContain('ghost-verifier')
    expect(rt.listCapabilities()).toEqual(before)

    // The same row with a registered verifier but tools the row does not grant.
    await installExecutionSkill({ verifierRef: 'command', capabilities: ['research'], requiredTools: ['bash'] })
    const uncoveredTools = await rt
      .applyCapabilityRow('research', { skills: [ROW_SKILL], tools: ['filesystem'] })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(uncoveredTools).toContain('tool-not-covered')
    expect(rt.listCapabilities()).toEqual(before)

    // And the row the same checks accept lands, whole.
    await rt.applyCapabilityRow('research', { skills: [ROW_SKILL], tools: ['filesystem', 'bash'] })
    expect(rt.listCapabilities()['research']).toEqual({ skills: [ROW_SKILL], tools: ['filesystem', 'bash'] })
  })

  test('removes a row without asking about providers — the rollback path removes, it never replaces', async () => {
    const rt = runtime()
    // `null` needs no discovery at all: no skill is checked, and a name that is
    // not there is a no-op rather than a refusal.
    await rt.applyCapabilityRow('absent-capability', null)
    await rt.applyCapabilityRow('research', null)
    expect(rt.listCapabilities()['research']).toBeUndefined()
    expect(Object.keys(rt.listCapabilities())).not.toContain('absent-capability')
  })
})

describe('tool labels', () => {
  test('a label expands to the real DSH tool names it grants', () => {
    expect(resolveToolLabels('design-ball', ['filesystem', 'bash'])).toEqual(['read', 'write', 'edit', 'bash'])
    expect(resolveToolLabels('design-ball', ['jobs'])).toEqual(['job_output', 'job_list', 'job_kill'])
    expect(resolveToolLabels('design-ball', [])).toEqual([])
  })

  test('resolution expands labels, so the manifest carries real names', () => {
    const manifest = resolveCapabilities(['design-ball'], DEPLOYMENT_CAPABILITIES)
    expect(manifest.capabilities['design-ball']!.tools).toEqual(['read', 'write', 'edit', 'bash'])
  })

  test('an unknown label rejects the whole resolution and names the vocabulary', () => {
    expect(() => resolveCapabilities(['typo'], { typo: { tools: ['filesytem'] } })).toThrow(
      /capability "typo" declares unknown tool label "filesytem"; known labels: /,
    )
    expect(() => resolveCapabilities(['typo'], { typo: { tools: ['filesytem'] } })).toThrow(
      /ask-user, bash, filesystem/,
    )
    expect(() => resolveCapabilities(['typo'], { typo: { tools: ['filesytem'] } })).toThrow(
      /skill, subagent, todo, web/,
    )
  })

  test('every shipped label resolves to a non-empty name list', () => {
    for (const [label, names] of Object.entries(TOOL_LABELS)) {
      expect(names.length, label).toBeGreaterThan(0)
      expect(
        names.every(name => name.length > 0),
        label,
      ).toBe(true)
    }
    // `run_code` is reserved by the tools registry: naming it in a filter throws.
    expect(Object.values(TOOL_LABELS).flat()).not.toContain('run_code')
  })

  test('the worker baseline is the expanded labels plus the task machinery, and nothing else', () => {
    const baseline = workerBaseline()
    expect(baseline).toEqual([
      'read',
      'write',
      'edit',
      'bash',
      'job_output',
      'job_list',
      'job_kill',
      'glob',
      'grep',
      'skill',
      'ask_user_question',
      'task_read',
      'task_status',
      'context_read',
      'task_decompose',
      'task_submit_result',
      'task_cancel',
      'task_verify',
      'capability_list',
      'task_proposal_read',
      'task_proposal_continue',
      'task_proposal_cancel',
      // A4 §F.1: the two halves of the parent/child question protocol — the one
      // coordination a blocked run still needs, and the answer its own child may
      // need from it.
      'task_ask_parent',
      'task_answer',
    ])
    expect(baseline).toEqual([...new Set(baseline)])
    // The task machinery is the tail, in the order WORKER_BASELINE_TOOLS declares.
    expect(baseline.slice(-WORKER_BASELINE_TOOLS.length)).toEqual([...WORKER_BASELINE_TOOLS])
    // History reads go through context_read, the one reader authorized by the
    // caller's graph domain: the raw cross-session tools it replaced are sealed
    // at execution and appear in no baseline.
    for (const sealed of ['session_event_read', 'session_event_trace', 'session_trace', 'session_search']) {
      expect(baseline, sealed).not.toContain(sealed)
    }
    // Growth happens through task_decompose admission; the graph surface is never a worker's.
    expect(baseline).not.toContain('graph_spawn')
    expect(baseline).not.toContain('graph_mark_ready')
    // The T2/T3 proposal tools are task-domain coordination, not platform
    // management: a worker can read, continue and withdraw what it proposed, and
    // holds no tool that could decide a proposal or reach the platform surface.
    expect(WORKER_BASELINE_TOOLS).toEqual(
      expect.arrayContaining(['task_proposal_read', 'task_proposal_continue', 'task_proposal_cancel']),
    )
    // The question tools are task-domain coordination of the same kind: a worker
    // asks its direct parent and answers a child it was asked by, and nothing
    // about them reaches the platform surface.
    expect(WORKER_BASELINE_TOOLS).toEqual(expect.arrayContaining(['task_ask_parent', 'task_answer']))
    for (const platformTool of [
      'hitl_ask',
      'hitl_approve',
      'evolution_decide',
      'task_review_pack',
      'task_diagnose',
      'escalate',
      'graph_spawn',
    ]) {
      expect(baseline, platformTool).not.toContain(platformTool)
    }
  })
})

describe('manifest flattening', () => {
  test('capabilitySnapshot dedupes and sorts granted skills and tools', () => {
    const manifest = resolveCapabilities(['design-ball', 'design-chip'], DEPLOYMENT_CAPABILITIES)
    expect(capabilitySnapshot(manifest)).toEqual(['ball-align', 'bash', 'chip-designer', 'edit', 'read', 'write'])
  })

  test('capabilitySnapshot marks granted MCP servers as mcp:<name>', () => {
    const manifest = resolveCapabilities(['check-ball-registration', 'build-kernel'], DEPLOYMENT_CAPABILITIES)
    expect(capabilitySnapshot(manifest)).toEqual(['check', 'mcp:bbdev'])
  })

  test('resolvePreset uses the declared preset, or the default when none is declared', () => {
    const withPreset = resolveCapabilities(['design-chip', 'research'], DEPLOYMENT_CAPABILITIES)
    expect(resolvePreset(withPreset, 'fallback')).toBe('standard')
    const withoutPreset = resolveCapabilities(['design-chip'], DEPLOYMENT_CAPABILITIES)
    expect(resolvePreset(withoutPreset, 'fallback')).toBe('fallback')
    expect(resolvePreset(withoutPreset)).toBeUndefined()
  })

  test('capabilities sharing a preset compose independently of requirement order', () => {
    const registry = {
      build: { preset: 'cordis', tools: ['bash'] },
      verify: { preset: 'cordis', skills: ['verify'] },
    }
    for (const required of [
      ['build', 'verify'],
      ['verify', 'build'],
    ]) {
      const manifest = resolveCapabilities(required, registry)
      expect(resolvePreset(manifest, 'standard')).toBe('cordis')
      expect(capabilitySnapshot(manifest)).toEqual(['bash', 'verify'])
    }
  })

  test('conflicting presets are rejected during resolution in either requirement order', () => {
    const registry = { research: { preset: 'standard' }, verify: { preset: 'cordis' } }
    for (const required of [
      ['research', 'verify'],
      ['verify', 'research'],
    ]) {
      expect(() => resolveCapabilities(required, registry)).toThrow(
        'conflicting capability presets: research -> standard, verify -> cordis; one worker requires one preset',
      )
    }
  })

  test('a directly supplied manifest cannot hide a conflict behind the default preset', () => {
    expect(() =>
      resolvePreset(
        {
          capabilities: {
            research: { skills: [], tools: [], preset: 'standard' },
            verify: { skills: [], tools: [], preset: 'cordis' },
          },
          missing: [],
          closure: 'closed',
        },
        'standard',
      ),
    ).toThrow(/conflicting capability presets/)
  })
})

describe('capability MCP server grants', () => {
  test('a declared server name lands on the manifest entry', () => {
    const manifest = resolveCapabilities(['check-ball-registration'], DEPLOYMENT_CAPABILITIES)
    expect(manifest.capabilities['check-ball-registration']!.mcpServers).toEqual(['bbdev'])
  })

  test('an unknown server name rejects the whole resolution, naming the vocabulary', () => {
    expect(() => resolveCapabilities(['typo'], { typo: { mcpServers: ['ghost'] } })).toThrow(
      'capability "typo" declares unknown MCP server "ghost"; known servers: bbdev, waveform',
    )
  })

  test('an empty mcpServers array normalizes to absence on the manifest', () => {
    const manifest = resolveCapabilities(['design-ball'], DEPLOYMENT_CAPABILITIES)
    expect(manifest.capabilities['design-ball']).not.toHaveProperty('mcpServers')
  })
})

describe('resolvePermission', () => {
  test('undefined when no matched capability declares a permission', () => {
    const manifest = resolveCapabilities(['design-chip'], DEPLOYMENT_CAPABILITIES)
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
    expect(resolvePermission(resolveCapabilities(['loose', 'mid', 'tight'], registry), permissionSpecs)).toBe(
      'read-only',
    )
    expect(resolvePermission(resolveCapabilities(['tight', 'loose'], registry), permissionSpecs)).toBe('read-only')
  })

  test('the approval knob breaks sandbox ties in favor of ask', () => {
    const registry = {
      loose: { permission: 'danger-full-access' },
      asking: { permission: 'unconfined-ask' },
    }
    expect(resolvePermission(resolveCapabilities(['loose', 'asking'], registry), permissionSpecs)).toBe(
      'unconfined-ask',
    )
  })

  test('an unknown preset name fails loud instead of being skipped', () => {
    const manifest = resolveCapabilities(['broken'], { broken: { permission: 'nope' } })
    expect(() => resolvePermission(manifest, permissionSpecs)).toThrow('unknown preset "nope"')
  })
})
