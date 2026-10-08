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
import { DEFAULT_METHOD_TOOLS, SingularityAgent } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'
import {
  configureSupervision,
  DEFAULT_SUPERVISION,
  registerGraphImprovementCap,
  supervisionSettings,
  unregisterGraphImprovementCap,
} from '../../src/coordination/supervision.ts'

/** The six tools the switch gates; nothing else on the surface depends on it. */
const METHOD_TOOLS = [
  'method_list',
  'method_draft',
  'method_evaluate',
  'method_publish',
  'method_discard',
  'method_rollback',
]

/**
 * The twenty-seven tools every composition registers, whatever the switch says
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
  'supervisor_complete',
  'reviewer_complete',
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
    ['singularityContext', { registerCoordinationBindingSource: () => () => {} }],
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
  it('registers the always-on tools plus the six method tools on the shipped default', async () => {
    const { tools } = await mount()
    expect(DEFAULT_METHOD_TOOLS).toBe('on')

    for (const name of [...ALWAYS_TOOLS, ...METHOD_TOOLS]) expect(tools.has(name), name).toBe(true)
    expect(tools.size).toBe(ALWAYS_TOOLS.length + METHOD_TOOLS.length)
    // The name is the surface: a gate written as an internal permission check
    // would still leave all the method tools reachable by an un-granted worker.
    expect([...tools.keys()].filter(name => name.startsWith('method_')).sort()).toEqual([...METHOD_TOOLS].sort())
  })

  it('registers no method tool when the deployment withholds them', async () => {
    const { tools } = await mount({ methodTools: 'off' })
    for (const name of ALWAYS_TOOLS) expect(tools.has(name), name).toBe(true)
    for (const name of METHOD_TOOLS) expect(tools.has(name), name).toBe(false)
    expect(tools.size).toBe(ALWAYS_TOOLS.length)
    expect([...tools.keys()].filter(name => name.startsWith('method_'))).toEqual([])
  })

  it('refuses a switch value this build does not implement, naming the member', async () => {
    await expect(mount({ methodTools: 'sometimes' } as unknown as Config)).rejects.toThrow(/methodTools/)
    await expect(mount({ methodTools: true } as unknown as Config)).rejects.toThrow(/methodTools/)
  })

  it('refuses a configuration member this plugin does not read, naming it', async () => {
    await expect(mount({ methodTools: 'off', methodToolsEnabled: true } as unknown as Config))
      .rejects.toThrow(/methodToolsEnabled/)
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
    await mount({ methodTools: 'off', supervision: { coordinationBudget: 3 } } as Config)
    expect(supervisionSettings()).toEqual({ coordinationBudget: 3 })

    // A member nobody reads refuses to start, exactly as a top-level typo does.
    await expect(mount({ methodTools: 'off', supervision: { coordinationBudgets: 3 } } as unknown as Config))
      .rejects.toThrow(/coordinationBudgets/)
    // The two round caps this deployment no longer declares are refused too: the
    // RSI loop opens the rounds its graph names, and the runtime's own constant
    // is the backstop for every other store.
    await expect(mount({ methodTools: 'off', supervision: { maxRecoveryRounds: 1000 } } as unknown as Config))
      .rejects.toThrow(/maxRecoveryRounds/)

    // The resolved policy is exposed where a sibling reads it: the coordination
    // allowance the ledger reads, and the per-store cap the runtime's
    // `iteration-cap` check reads.
    const exposed = await mount({ methodTools: 'off', supervision: { coordinationBudget: 3 } } as Config)
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
    const read = (ctx: Context): boolean => ctx.get('singularityMethods')?.enabled ?? false

    const off = await mount({ methodTools: 'off' })
    expect(read(off.ctx)).toBe(false)
    await off.ctx.fiber.dispose()
    expect(off.ctx.get('singularityMethods')).toBeUndefined()

    const on = await mount()
    expect(read(on.ctx)).toBe(true)
    await on.ctx.fiber.dispose()
  })

  it('no longer reads a publication-approval policy: every apply asks the native approval seam', async () => {
    // The switch is gone (F): a graph's `rsi.humanReview` decides whether the
    // approval card is answered by a person or resolved on the spot, so this
    // composition declares no policy of its own and a config that still names
    // one is a member nobody reads.
    await expect(mount({ methodTools: 'on', publicationApproval: 'auto' } as unknown as Config)).rejects.toThrow(
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
    const { ctx, home } = await mount({ methodTools: 'on' })
    const evolution = ctx.get('evolution')
    expect(evolution?.repoRoot).toBe(fileURLToPath(new URL('../../../../../', import.meta.url)))
    // and the data roots still resolve off DSH_HOME, exactly as before
    expect(evolution?.root).toBe(resolve(join(home, 'evolution')))
    expect(evolution?.file).toBe(resolve(join(home, 'evolution', 'proposals.jsonl')))
    await ctx.fiber.dispose()
  })

  it('describes the six method tools in the one-approval protocol terms the supervisor runs', async () => {
    // These descriptions are the model's only statement of what this build can
    // do: a candidate is measured before it is published, exactly one approval
    // shows the complete difference and the pointer switch, and a candidate the
    // frozen strategy refused consumes no approval at all.
    const { tools } = await mount()
    for (const name of METHOD_TOOLS) expect(tools.has(name), name).toBe(true)
    const publish = tools.get('method_publish') as unknown as { description: string }
    expect(publish.description).toContain('compare-and-swap')
    expect(publish.description).toContain('exactly one approval')
    expect(publish.description).toContain('did not admit')
    const draft = tools.get('method_draft') as unknown as { description: string }
    expect(draft.description).toContain('edit budget')
    expect(draft.description).toContain('screened before any measurement')
    const evaluate = tools.get('method_evaluate') as unknown as { description: string }
    expect(evaluate.description).toContain('three independent repetitions')
    const discard = tools.get('method_discard') as unknown as { description: string }
    expect(discard.description).toContain('No approval is requested')
    for (const name of METHOD_TOOLS) {
      const tool = tools.get(name) as unknown as { description: string }
      expect(tool.description, name).not.toMatch(/nine-step|gate answer/i)
    }
  })
})
