/**
 * The startup reconciliation (K2-3, §E): the plugin mounts, and before it is
 * ready every commit intent its ledger left open is settled against what
 * production actually holds.
 *
 * The switch is not part of that question. `evolution: 'off'` removes the nine
 * model-facing tools — the composition R0 asks for — and changes nothing about
 * recovery: production is reconciled whether or not the deployment ever exposes
 * the chain, which is exactly the point of wiring it into the plugin's own
 * startup rather than into a tool. What is real here: the `EvolutionService`, the
 * ledger file under a pinned `$DSH_HOME`, the sandbox and production `SKILL.md`
 * files, the atomic write and its read-back, and the plugin the loader mounts.
 * The blocked and unreadable cases are the two the wiring has to tell apart — one
 * reported by name over a deployment that still starts, one the reason a mount
 * fails.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EVOLUTION, SingularityAgent } from '../../src/index.ts'
import type { Config } from '../../src/index.ts'

const PROPOSAL_ID = 's1'
const SKILL = 'verify'
const CANDIDATE = skillText('# the candidate version\n')
const BASELINE = skillText('# the production version\n')
const THIRD_PARTY = skillText('# a version no commit of this proposal wrote\n')

function skillText(body: string): string {
  return `---\nname: ${SKILL}\ndescription: a fixture skill for the startup reconciliation\n---\n\n${body}`
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
  return { ctx, tools, home, target: join(home, 'skills', SKILL, 'SKILL.md'), warnings, mount: loading }
}

/** Every ledger line's `kind`, oldest first — the file itself, never the service's memory. */
async function ledgerKinds(home: string): Promise<string[]> {
  return (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    .map(line => (JSON.parse(line) as { kind: string }).kind)
}

describe('SingularityAgent startup reconciliation', () => {
  it('settles an open commit intent before the plugin is ready, with the tool switch off', async () => {
    const open = await mount({ ledger: home => ledgerLines(home, []) })
    expect(DEFAULT_EVOLUTION).toBe('off')
    await open.mount

    // The recovery ran even though this deployment exposes no evolution tool at
    // all (the switch is the composition, not a licence to leave production
    // inconsistent with its ledger).
    expect([...open.tools.keys()].filter(name => name.startsWith('evolution_'))).toEqual([])
    expect(await readFile(open.target, 'utf8')).toBe(CANDIDATE)
    expect(await ledgerKinds(open.home)).toEqual([
      'proposed', 'candidate', 'prepared', 'gated', 'decided', 'commit_intent', 'applied',
    ])
    expect(open.warnings).toEqual([])
    await open.ctx.fiber.dispose()
  })

  it('starts anyway when an intent cannot be settled, and reports it by name', async () => {
    // A third party replaced production after the commit recorded its baseline:
    // the recovery must not overwrite it, and a deployment must not refuse to run
    // because of it — the admission gate is what keeps the target out of use.
    const blocked = await mount({ ledger: home => ledgerLines(home, []), production: THIRD_PARTY })
    await expect(blocked.mount).resolves.toBeDefined()

    expect(await readFile(blocked.target, 'utf8')).toBe(THIRD_PARTY)
    expect(await ledgerKinds(blocked.home)).toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided', 'commit_intent'])
    const warnings = blocked.warnings
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`${PROPOSAL_ID}/apply`)
    expect(warnings[0]).toContain(`apply of proposal "${PROPOSAL_ID}"`)
    expect(warnings[0]).toContain(blocked.target)
    expect(warnings[0]).toContain('could not be settled')
    expect(warnings[0]).toContain('a third party changed it')
    await blocked.ctx.fiber.dispose()
  })

  it('refuses to become ready when the ledger cannot be read, naming the cause', async () => {
    // A ledger this build does not read (here a v1 line, the shape a deployment
    // upgraded from an older release carries) is not a `blocked` commit: the
    // reconciliation never happened, and the plugin fails its own load with the
    // reason rather than serving a deployment whose production is anyone's guess.
    const unreadable = await mount({
      ledger: () => [{ formatVersion: 1, kind: 'proposed', proposalId: PROPOSAL_ID, actor: 'root-1', at: '2026-09-01T00:00:00.000Z' }],
    })
    await expect(unreadable.mount).rejects.toThrow(/could not be reconciled at startup/)
    // The reason the reconciliation could not run is part of the same refusal.
    const refusal = await Promise.resolve(unreadable.mount).then(
      () => '',
      (error: Error) => error.message,
    )
    expect(refusal).toMatch(/formatVersion 1/)
  })

  it('mounts with no ledger at all, and with no open intent', async () => {
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
