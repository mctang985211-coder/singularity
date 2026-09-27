/**
 * The assembled tool surface of the root-agent plugin (R0): which tools land on
 * the global layer for a given deployment configuration.
 *
 * The switch is the composition, not a permission check inside a tool: with
 * `evolution` off, the nine `evolution_*` tools are never registered, so no
 * agent surface — the root's allow-list, a spawned worker's grant, or the
 * un-granted worker that keeps the global layer — can call one, and the ledger
 * behind them is unreachable rather than merely discouraged. Turning it on
 * leaves the previous assembly untouched: the same names the deployment has
 * always had, plus the root's own intake (A0), which no switch gates.
 *
 * Every case mounts the real plugin on a real context with sibling stubs for
 * its injected services, the way the loader mounts them, so what is asserted is
 * the plugin's own registration, not a fixture's list.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {} from '@dangosys/dsh-singularity-evolution'
import { DEFAULT_EVOLUTION, SingularityAgent } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

/** The nine tools the switch gates; nothing else on the surface depends on it. */
const EVOLUTION_TOOLS = [
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_rollback',
  'evolution_list',
]

/** The twenty-two tools every composition registers, whatever the switch says (`escalate` included). */
const ALWAYS_TOOLS = [
  'graph_mark_ready',
  'graph_spawn',
  'hitl_ask',
  'hitl_approve',
  'task_read',
  'capability_list',
  'context_read',
  'task_intake',
  'task_decompose',
  'task_proposal_read',
  'task_proposal_continue',
  'task_proposal_cancel',
  'task_status',
  'task_submit_result',
  'task_ask_parent',
  'task_answer',
  'task_cancel',
  'task_verify',
  'task_review_pack',
  'task_review_agent',
  'task_diagnose',
  'escalate',
]

/** A sibling plugin providing one injected service, standing in for what the profile mounts beside this one. */
function stub(name: string, value: object) {
  return class extends Service {
    constructor(ctx: Context) {
      super(ctx, name)
      Object.assign(this, value)
    }
  }
}

/**
 * Mounts the plugin on a real context: the dependencies it injects are siblings
 * of its own, and the tool registry is the deployment's (here, a map that keeps
 * what the plugin registered).
 */
async function mount(config?: Config) {
  const home = await mkdtemp(join(tmpdir(), 'singularity-assembly-'))
  vi.stubEnv('DSH_HOME', home)
  const tools = new Map<string, { name: string }>()
  const ctx = new Context()
  const dependencies: ReadonlyArray<readonly [string, object]> = [
    ['tools', {
      register(tool: { name: string }) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    }],
    ['graphs', {}],
    ['agentRuntime', {}],
    ['task', {}],
    ['taskRuntime', {}],
    ['singularityContext', { registerReviewerBindingSource: () => () => {} }],
    ['userQuestions', {}],
    ['approval', { request: vi.fn(async () => 'allowed-once') }],
  ]
  for (const [name, value] of dependencies) await ctx.plugin(stub(name, value))
  if (config === undefined) {
    await ctx.plugin(SingularityAgent)
  } else {
    await ctx.plugin(SingularityAgent, config)
  }
  return { ctx, tools, home }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('SingularityAgent assembly', () => {
  it('registers the twenty-two unconditional tools and no evolution tool on the shipped default', async () => {
    const { tools } = await mount()
    expect(DEFAULT_EVOLUTION).toBe('off')

    for (const name of ALWAYS_TOOLS) expect(tools.has(name), name).toBe(true)
    for (const name of EVOLUTION_TOOLS) expect(tools.has(name), name).toBe(false)
    expect(tools.size).toBe(ALWAYS_TOOLS.length)
    // The name is the surface: a gate written as an internal permission check
    // would still leave all thirty-one reachable by an un-granted worker.
    expect([...tools.keys()].filter(name => name.startsWith('evolution_'))).toEqual([])
  })

  it('registers all thirty-one tools when the deployment turns evolution on', async () => {
    const { tools } = await mount({ evolution: 'on' })
    for (const name of [...ALWAYS_TOOLS, ...EVOLUTION_TOOLS]) expect(tools.has(name), name).toBe(true)
    expect(tools.size).toBe(ALWAYS_TOOLS.length + EVOLUTION_TOOLS.length)
  })

  it('refuses a switch value this build does not implement, naming the member', async () => {
    await expect(mount({ evolution: 'sometimes' } as unknown as Config)).rejects.toThrow(/evolution/)
    await expect(mount({ evolution: true } as unknown as Config)).rejects.toThrow(/evolution/)
  })

  it('refuses a configuration member this plugin does not read, naming it', async () => {
    await expect(mount({ evolution: 'off', evolutionEnabled: true } as unknown as Config))
      .rejects.toThrow(/evolutionEnabled/)
  })

  it('exposes the parsed switch on the context, for a sibling assembly to read softly', async () => {
    // How the root assembly reads it (agent-runtime, at root creation): a soft
    // query, so a composition with no singularity agent plugin reads the
    // absence as off rather than failing to load.
    const read = (ctx: Context): boolean => ctx.get('singularityEvolution')?.enabled ?? false

    const off = await mount()
    expect(read(off.ctx)).toBe(false)
    await off.ctx.fiber.dispose()
    expect(off.ctx.get('singularityEvolution')).toBeUndefined()

    const on = await mount({ evolution: 'on' })
    expect(read(on.ctx)).toBe(true)
    await on.ctx.fiber.dispose()
  })

  it('hands the evolution ledger the harness repo root, so its default roots stay where they were', async () => {
    // The ledger's defaults hang off the harness root (`<repoRoot>/.dsh`,
    // `<repoRoot>/config.yml`). That root used to be derived inside the ledger
    // module; since S4-E the lifecycle lives in
    // `@dangosys/dsh-singularity-evolution`, whose own depth is different — so
    // the assembly computes it at the depth the ledger used to sit at, and
    // passes it in. This spec's own five-level path names the same directory.
    const { ctx, home } = await mount({ evolution: 'on' })
    const evolution = ctx.get('evolution')
    expect(evolution?.repoRoot).toBe(fileURLToPath(new URL('../../../../../', import.meta.url)))
    // and the data roots still resolve off DSH_HOME, exactly as before
    expect(evolution?.root).toBe(resolve(join(home, 'evolution')))
    expect(evolution?.file).toBe(resolve(join(home, 'evolution', 'proposals.jsonl')))
    await ctx.fiber.dispose()
  })

  it('advertises no experiment wall clock on the evolution_replay budget', async () => {
    // The experiment has one optional ceiling left (`maxTokens`): a model reading
    // this schema must not see a wall-clock field, and a caller that still sends
    // one is refused by the service before the first write rather than run
    // without the window it named.
    const { tools } = await mount({ evolution: 'on' })
    const replay = tools.get('evolution_replay') as unknown as {
      parameters: { properties: Record<string, { properties?: Record<string, unknown> }> }
    }
    expect(Object.keys(replay.parameters.properties.budget!.properties!)).toEqual(['maxTokens', 'note'])
    expect(JSON.stringify(replay.parameters)).not.toContain('wallTimeMs')
  })

  it('declares the candidate mutation required on the model surface, in whole-object terms', async () => {
    // `evolution_candidate` admits one shape: a same-name improvement of an
    // existing skill, whose full replacement `SKILL.md` text the mutation
    // carries. The model surface has to say so — the schema requires the
    // mutation instead of leaving a mutation-less call to be refused after the
    // fact, the mutation's own text says an execution skill's sidecar is derived
    // rather than submitted, and a suggestion-only proposal is named as
    // something that never becomes a candidate.
    const { tools } = await mount({ evolution: 'on' })
    const candidate = tools.get('evolution_candidate') as unknown as {
      description: string
      parameters: { required: string[]; properties: Record<string, { description?: string }> }
    }
    expect(candidate.parameters.required).toContain('mutation')
    expect(candidate.parameters.required).toContain('versionSet')
    expect(candidate.parameters.properties.mutation!.description).toContain('{ name, content }')
    expect(candidate.parameters.properties.mutation!.description).toContain('derived from production at evolution_prepare')
    expect(candidate.description).toContain('This build admits one candidate lifecycle')
    expect(candidate.description).toContain('a suggestion never becomes a candidate')
  })

  it('describes all nine evolution tools in whole-object terms, with no single-file claim left', async () => {
    // K3-5: these descriptions are the model's only statement of what this build
    // can do, and every one of them used to say "single-file" — a model reading
    // that would look for a build that refuses to update an execution skill, or
    // would try to submit a sidecar itself. The phrase is gone from all nine
    // surfaces.
    const { tools } = await mount({ evolution: 'on' })
    for (const name of EVOLUTION_TOOLS) {
      const tool = tools.get(name) as unknown as { description: string }
      expect(tool.description, name).not.toMatch(/single-file|single file/i)
    }
    const apply = tools.get('evolution_apply') as unknown as { description: string }
    expect(apply.description).toContain('the `SKILL.md` and, for an execution skill, the `SKILL.contract.json` beside it')
    const rollback = tools.get('evolution_rollback') as unknown as { description: string }
    expect(rollback.description).toContain('the `SKILL.md`, plus the `SKILL.contract.json` when it declares an')
    const prepare = tools.get('evolution_prepare') as unknown as { description: string }
    expect(prepare.description).toContain('the model never submits a sidecar')
    const replay = tools.get('evolution_replay') as unknown as { description: string }
    expect(replay.description).toContain('the `SKILL.contract.json` beside it')
    const list = tools.get('evolution_list') as unknown as { description: string }
    expect(list.description).toContain('every production file it commits')
  })
})
