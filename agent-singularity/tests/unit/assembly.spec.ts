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
import {
  configureSupervision,
  DEFAULT_SUPERVISION,
  registerGraphImprovementCap,
  supervisionSettings,
  unregisterGraphImprovementCap,
} from '../../src/coordination/supervision.ts'

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

/**
 * The twenty-five tools every composition registers, whatever the switch says
 * (`escalate` included). No task-recovery tool exists in this deployment (F):
 * round scheduling belongs to the platform RSI loop driver, which calls the
 * runtime's own recovery entry directly.
 */
const ALWAYS_TOOLS = [
  'graph_mark_ready',
  'graph_spawn',
  'hitl_ask',
  'hitl_approve',
  'task_read',
  'capability_list',
  'task_library',
  'task_template_list',
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
  'task_budget_extend',
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
 * what the plugin registered). `taskRuntime` is the one dependency this
 * composition registers callbacks on at construction — the root-budget approval
 * (K4) and the terminal-review listener the RSI loop driver rides (F) — so its
 * default here accepts and forgets one each, and a case that cares about the
 * installation passes its own recorder.
 */
async function mount(
  config?: Config,
  taskRuntime: object = { registerRootBudgetApproval: () => () => {}, registerTerminalReviewListener: () => () => {} },
) {
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
    ['taskRuntime', taskRuntime],
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
  configureSupervision(undefined)
  vi.unstubAllEnvs()
})

describe('SingularityAgent assembly', () => {
  it('registers the twenty-five unconditional tools and no evolution tool on the shipped default', async () => {
    const { tools } = await mount()
    expect(DEFAULT_EVOLUTION).toBe('off')

    for (const name of ALWAYS_TOOLS) expect(tools.has(name), name).toBe(true)
    for (const name of EVOLUTION_TOOLS) expect(tools.has(name), name).toBe(false)
    expect(tools.size).toBe(ALWAYS_TOOLS.length)
    // The name is the surface: a gate written as an internal permission check
    // would still leave all thirty-four reachable by an un-granted worker.
    expect([...tools.keys()].filter(name => name.startsWith('evolution_'))).toEqual([])
  })

  it('registers all thirty-four tools when the deployment turns evolution on', async () => {
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

  it('resolves the supervision block over its shipped defaults, and refuses an unknown member of it by name', async () => {
    // The shipped default composes the shipped supervision policy: eight
    // coordination runs per store, and nothing else — the per-source round caps
    // belong to the runtime (and, for a store whose graph runs an RSI loop, to
    // the graph itself).
    await mount()
    expect(supervisionSettings()).toEqual(DEFAULT_SUPERVISION)
    expect(DEFAULT_SUPERVISION).toEqual({ coordinationBudget: 8 })

    // A partial block resolves against the defaults rather than blanking them.
    await mount({ evolution: 'off', supervision: { coordinationBudget: 3 } } as Config)
    expect(supervisionSettings()).toEqual({ coordinationBudget: 3 })

    // A member nobody reads refuses to start, exactly as a top-level typo does.
    await expect(mount({ evolution: 'off', supervision: { coordinationBudgets: 3 } } as unknown as Config))
      .rejects.toThrow(/coordinationBudgets/)
    // The two round caps this deployment no longer declares are refused too: the
    // RSI loop opens the rounds its graph names, and the runtime's own constant
    // is the backstop for every other store.
    await expect(mount({ evolution: 'off', supervision: { maxRecoveryRounds: 1000 } } as unknown as Config))
      .rejects.toThrow(/maxRecoveryRounds/)

    // The resolved policy is exposed where a sibling reads it: the coordination
    // allowance the ledger reads, and the per-store cap the runtime's
    // `iteration-cap` check reads.
    const exposed = await mount({ evolution: 'off', supervision: { coordinationBudget: 3 } } as Config)
    expect(exposed.ctx.get('singularitySupervision')).toMatchObject({ coordinationBudget: 3 })
    // A store an RSI loop declared reports that graph's own round count; a store
    // nobody declared reports no answer, so the runtime's constant stands.
    expect(exposed.ctx.singularitySupervision.maxImprovementRoundsFor('sg-t-elsewhere')).toBeUndefined()
    expect(exposed.ctx.singularitySupervision.maxRecoveryRoundsFor('sg-t-elsewhere')).toBeUndefined()
    registerGraphImprovementCap('sg-t-elsewhere', 5)
    expect(exposed.ctx.singularitySupervision.maxImprovementRoundsFor('sg-t-elsewhere')).toBe(5)
    // The driver is the only opener of a recovery any more, so the store's own
    // graph-declared count governs both kinds of round.
    expect(exposed.ctx.singularitySupervision.maxRecoveryRoundsFor('sg-t-elsewhere')).toBe(5)
    unregisterGraphImprovementCap('sg-t-elsewhere')
    await exposed.ctx.fiber.dispose()
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

  it('no longer reads a publication-approval policy: every apply asks the native approval seam', async () => {
    // The switch is gone (F): a graph's `rsi.humanReview` decides whether the
    // approval card is answered by a person or resolved on the spot, so this
    // composition declares no policy of its own and a config that still names
    // one is a member nobody reads.
    await expect(mount({ evolution: 'on', publicationApproval: 'auto' } as unknown as Config)).rejects.toThrow(
      /publicationApproval/,
    )
  })

  it('installs the root-budget approval on the runtime at construction, and uninstalls it with the plugin', async () => {
    // The one approval a budget extension can be granted through (K4) is wired
    // here, once: the runtime asks this callback for a person's decision and
    // commits only an actual `allowed-once`. It is registered through the
    // plugin's own effect, so unmounting this assembly takes the approval away
    // with it — a runtime left holding it would keep answering for a composition
    // that no longer exists.
    let installed: unknown
    const registered: unknown[] = []
    const { ctx } = await mount(undefined, {
      registerRootBudgetApproval: (approval: unknown) => {
        registered.push(approval)
        installed = approval
        return () => { if (installed === approval) installed = undefined }
      },
      // The other door this composition installs on the runtime (A5): the
      // terminal-review listener the RSI loop driver rides.
      registerTerminalReviewListener: () => () => {},
    })

    expect(registered).toHaveLength(1)
    expect(typeof registered[0]).toBe('function')

    // And it is the budget-extension callback, not any function: driving it puts
    // the card through the approval channel this deployment assembled, under the
    // host execution's own call, and answers the runtime with the grant that
    // channel's `allowed-once` means.
    const approval = ctx.get('approval') as unknown as { request: ReturnType<typeof vi.fn> }
    const decision = await (registered[0] as (ask: unknown) => Promise<unknown>)({
      storeId: 'sg-t-root-session',
      rootTaskId: 'root',
      rootSessionId: 'root-session',
      configured: { maxRuns: 10 },
      effective: { maxRuns: 10 },
      runsUsed: 3,
      proposal: { requestKey: 'k-1', requestDigest: 'd'.repeat(64), maxRuns: { previous: 10, next: 20 } },
      host: { callId: 'call-1', execution: { agent: { id: 'root-session' }, callId: 'call-1' } },
    })
    expect(decision).toEqual({ kind: 'allowed', reference: 'approval:call-1' })
    expect(approval.request).toHaveBeenCalledTimes(1)
    expect(approval.request.mock.calls[0]![0]).toMatchObject({ toolName: 'task_budget_extend', callId: 'call-1' })

    await ctx.fiber.dispose()
    expect(installed).toBeUndefined()
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

  it('declares the candidate mutation required on the model surface, in whole-object and whole-row terms (A6)', async () => {
    // `evolution_candidate` admits two shapes, and the model surface says which:
    // a same-name improvement of an existing skill (the full replacement
    // `SKILL.md` text, whose execution sidecar is *derived* at prepare rather
    // than submitted) and — A6 — one whole capability row with an optional new
    // execution skill. The mutation is required, the row carries its whole
    // configuration rather than a patch, and a suggestion-only proposal is named
    // as something that never becomes a candidate.
    const { tools } = await mount({ evolution: 'on' })
    const candidate = tools.get('evolution_candidate') as unknown as {
      description: string
      parameters: {
        required: string[]
        properties: Record<string, {
          description?: string
          type?: string
        }>
      }
    }
    expect(candidate.parameters.required).toContain('mutationJson')
    expect(candidate.parameters.required).toContain('versionSet')
    const mutation = candidate.parameters.properties.mutationJson!
    expect(mutation.type).toBe('string')
    expect(candidate.description).toContain('task_definition: {template:<complete canonical TaskTemplate>')
    expect(candidate.description).toContain('Skill:')
    expect(candidate.description).toContain('Capability:')
    expect(candidate.description).toContain('mcpServers?')
    expect(candidate.description).toContain('derived by this tool')
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
    for (const name of ['evolution_prepare', 'evolution_apply', 'evolution_rollback', 'evolution_decide']) {
      const tool = tools.get(name) as unknown as { description: string }
      expect(tool.description, name).toMatch(/Task template|Task candidate/)
      expect(tool.description, name).toContain('Skill')
      expect(tool.description, name).toContain('capability')
    }

  })
})
