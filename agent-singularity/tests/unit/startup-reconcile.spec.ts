/**
 * The plugin's startup boundary after the v4 settle retired. The legacy
 * evolution ledger stays mounted — the task runtime's own activation barrier
 * reconciles its commit intents when a graph is taken over — but this plugin
 * no longer settles them at mount: it reads the ledger once, refusing by name
 * when it holds a line this build does not read, and otherwise leaves the
 * timeline exactly where the barrier will pick it up. What is real here: the
 * `EvolutionService`, the ledger file under a pinned `$DSH_HOME`, and the plugin
 * the loader mounts.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_METHOD_TOOLS, SingularityAgent } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

const PROPOSAL_ID = 's1'
const SKILL = 'verify'
const CANDIDATE = skillText('# the candidate version\n')
const BASELINE = skillText('# the production version\n')

function skillText(body: string): string {
  return `---\nname: ${SKILL}\ndescription: a fixture skill for the startup boundary\n---\n\n${body}`
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A loadable ledger of a skill proposal walked to decided(PROMOTE), plus the lines handed in. */
function ledgerLines(home: string, extra: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const target = join(home, 'skills', SKILL, 'SKILL.md')
  const common = { formatVersion: 4, proposalId: PROPOSAL_ID, actor: 'root-1' }
  return [
    {
      ...common, kind: 'proposed', targetType: 'skill', targetId: SKILL, baseVersion: 'v1', level: 'L2',
      rationale: 'the skill never mentions the empty-input fixture', sourceRefs: ['diagnosis:d1'],
      at: '2026-09-27T00:00:00.000Z',
    },
    {
      ...common, kind: 'candidate', versionSet: { skill: 'v2' }, mutation: { name: SKILL, content: CANDIDATE },
      at: '2026-09-27T00:00:01.000Z',
    },
    {
      ...common, kind: 'prepared', sandbox: `sandbox/${PROPOSAL_ID}`, mechanical: true, champion: 'captured',
      skillContent: { name: SKILL, sha256: sha256Of(CANDIDATE) },
      skillBaseline: { name: SKILL, sha256: sha256Of(BASELINE) },
      files: [`skills/${SKILL}/SKILL.md`, `champion/skills/${SKILL}/SKILL.md`], at: '2026-09-27T00:00:02.000Z',
    },
    {
      ...common, kind: 'gated', at: '2026-09-27T00:00:03.000Z',
      gate: {
        targetFailureFixed: 'the empty-input fixture now passes',
        originalAcceptanceMaintained: 'the original criteria are unchanged and green',
        existingRegressionMaintained: 'the full suite replayed green',
        noUnacceptableSideEffects: 'the diff touches one command only',
        holdoutPerformanceAcceptable: 'the held-out fixtures pass',
        resourceCostAcceptable: 'same runtime as the baseline',
        regressionEvidenceRefs: [`sandbox/${PROPOSAL_ID}/replay-report.json`],
      },
    },
    { ...common, kind: 'decided', decision: 'PROMOTE', approvalRef: 'approval:decide', at: '2026-09-27T00:00:04.000Z' },
    {
      formatVersion: 4, kind: 'commit_intent', intentId: `${PROPOSAL_ID}/apply`, proposalId: PROPOSAL_ID, direction: 'apply',
      approvalRef: 'approval:call-7',
      files: [{
        target, baselineSha256: sha256Of(BASELINE), contentSha256: sha256Of(CANDIDATE),
        source: `sandbox/${PROPOSAL_ID}/skills/${SKILL}/SKILL.md`,
      }],
      actor: 'root-1', at: '2026-09-27T00:00:05.000Z',
    },
    ...extra,
  ]
}

/** A sibling plugin providing one injected service, standing in for what the profile mounts beside this one. */
function stub(name: string, value: object) {
  return class extends Service {
    constructor(ctx: Context) {
      super(ctx, name)
      Object.assign(this, value)
    }
  }
}

const workspaces: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true })
})

/**
 * A temp `$DSH_HOME` holding the ledger and the files a commit touches
 * (`<home>/evolution` and `<home>/skills`, the roots the plugin's own service
 * resolves), a real context with the plugin's injected siblings, and the mount
 * itself.
 */
async function mount(options: {
  ledger?: (home: string) => readonly Record<string, unknown>[]
  production?: string
  config?: Config
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'singularity-startup-'))
  workspaces.push(home)
  vi.stubEnv('DSH_HOME', home)
  const root = join(home, 'evolution')
  await mkdir(join(root, 'sandbox', PROPOSAL_ID, 'skills', SKILL), { recursive: true })
  await writeFile(join(root, 'sandbox', PROPOSAL_ID, 'skills', SKILL, 'SKILL.md'), CANDIDATE)
  await mkdir(join(home, 'skills', SKILL), { recursive: true })
  await writeFile(join(home, 'skills', SKILL, 'SKILL.md'), options.production ?? BASELINE)
  if (options.ledger !== undefined) {
    await writeFile(join(root, 'proposals.jsonl'), `${options.ledger(home).map(line => JSON.stringify(line)).join('\n')}\n`)
  }

  const tools = new Map<string, { name: string }>()
  const ctx = new Context()
  // The warnings the plugin's own report lands on: cordis' default exporter
  // stops at INFO, so a `warn` needs an exporter that admits it — the threshold
  // the harness's worker host declares for the same reason.
  const warnings: string[] = []
  ctx.logger.exporter({
    levels: { default: 2 },
    export: message => {
      if (message.type === 'warn') warnings.push(String(message.args[0]))
    },
  })
  const dependencies: ReadonlyArray<readonly [string, object]> = [
    ['tools', { register(tool: { name: string }) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } }],
    ['graphs', {}],
    ['agentRuntime', {}],
    ['task', {}],
    ['taskRuntime', { registerRootBudgetApproval: () => () => {}, registerTerminalReviewListener: () => () => {} }],
    ['singularityContext', { registerCoordinationBindingSource: () => () => {} }],
    ['userQuestions', {}],
    ['approval', { request: vi.fn(async () => 'allowed-once') }],
  ]
  for (const [name, value] of dependencies) await ctx.plugin(stub(name, value))
  const loading = options.config === undefined ? ctx.plugin(SingularityAgent) : ctx.plugin(SingularityAgent, options.config)
  return {
    ctx,
    tools,
    home,
    target: join(home, 'skills', SKILL, 'SKILL.md'),
    /**
     * Every warning the mount reported except the two planes' own missing-view
     * lines: this fixture mounts no view service, and the assembly says where
     * assignments live and that no derived progress or method fact can be read
     * rather than degrading silently.
     */
    get warnings(): string[] {
      return warnings.filter(line => !line.startsWith('coordination:') && !line.includes('no singularityGraphView service'))
    },
    get allWarnings(): string[] {
      return warnings
    },
    mount: loading,
  }
}

/** Every ledger line's `kind`, oldest first — the file itself, never the service's memory. */
async function ledgerKinds(home: string): Promise<string[]> {
  return (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    .map(line => (JSON.parse(line) as { kind: string }).kind)
}

describe('SingularityAgent startup boundary', () => {
  it('mounts a deployment whose v4 ledger holds an open commit intent, and settles nothing at mount', async () => {
    const open = await mount({ ledger: home => ledgerLines(home, []) })
    expect(DEFAULT_METHOD_TOOLS).toBe('on')
    await open.mount

    // The v4 ledger is history the task runtime's own activation barrier
    // reconciles; this plugin no longer touches it — no `evolution_*` model tool
    // and no startup settle — so production and the ledger are left exactly where
    // they were found.
    expect([...open.tools.keys()].filter(name => name.startsWith('evolution_'))).toEqual([])
    expect(await readFile(open.target, 'utf8')).toBe(BASELINE)
    expect(await ledgerKinds(open.home)).toEqual([
      'proposed', 'candidate', 'prepared', 'gated', 'decided', 'commit_intent',
    ])
    expect(open.warnings).toEqual([])
    await open.ctx.fiber.dispose()
  })

  it('refuses to become ready when the ledger cannot be read, naming the cause', async () => {
    // A ledger this build does not read (here a v1 line, the shape a deployment
    // upgraded from an older release carries) is refused by the readiness gate:
    // the plugin fails its own load with the reason rather than serving a
    // deployment whose legacy history is unreadable.
    const unreadable = await mount({
      ledger: () => [{ formatVersion: 1, kind: 'proposed', proposalId: PROPOSAL_ID, actor: 'root-1', at: '2026-09-01T00:00:00.000Z' }],
    })
    await expect(unreadable.mount).rejects.toThrow(/could not be read at startup/)
    // The reason the read could not run is part of the same refusal.
    const refusal = await Promise.resolve(unreadable.mount).then(
      () => '',
      (error: Error) => error.message,
    )
    expect(refusal).toMatch(/formatVersion 1/)
  })

  it('mounts with no ledger at all, and with a fully applied one', async () => {
    const absent = await mount()
    await expect(absent.mount).resolves.toBeDefined()
    expect(await readFile(absent.target, 'utf8')).toBe(BASELINE)

    const complete = await mount({
      ledger: home => ledgerLines(home, [{
        formatVersion: 4, kind: 'applied', proposalId: PROPOSAL_ID, targets: [join(home, 'skills', SKILL, 'SKILL.md')],
        approvalRef: 'approval:call-7', intentId: `${PROPOSAL_ID}/apply`, actor: 'root-1', at: '2026-09-27T00:00:06.000Z',
      }]),
      production: CANDIDATE,
    })
    await expect(complete.mount).resolves.toBeDefined()
    expect(complete.warnings).toEqual([])
    await absent.ctx.fiber.dispose()
    await complete.ctx.fiber.dispose()
  })
})
