import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context, Service } from '../../../../thirdparty/deepseek-harness/vendor/cordis/lib/index.js'
import { SingularityAgent } from '../../agent-singularity/src/index.ts'

interface RegisteredTool {
  name: string
  execute(args: Record<string, unknown>, exec?: unknown): unknown
}

/** Stand-in for the tools registry: collects what the plugin registers, so the test drives the real tools. */
function toolRegistry() {
  const tools = new Map<string, RegisteredTool>()
  return {
    tools,
    service: {
      register(tool: RegisteredTool) {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
  }
}

/**
 * Mounts the real root-agent plugin on a real context. Every dependency is a
 * sibling plugin of its own, the way the loader mounts `dsh-base` next to this
 * bundle; the evolution ledger's service is the plugin's own, so nothing stands
 * in for it, and every tool under test is the one the plugin registered.
 */
async function mountAgent() {
  const home = await mkdtemp(join(tmpdir(), 'singularity-evolution-'))
  vi.stubEnv('DSH_HOME', home)
  const registry = toolRegistry()
  const approval = { request: vi.fn(async () => 'allowed-once') }
  const userQuestions = { ask: vi.fn(async () => ({ answers: [{ id: 'hitl-ask', selected: [], custom: 'buckyball' }] })) }
  const replayTask = vi.fn(async (_storeId: string, championTaskId: string, _options: unknown, _caller: string) => ({
    taskId: `t-replay-${championTaskId}`,
    runId: `r-replay-${championTaskId}`,
    status: 'verified',
    durationMs: 7,
    criteria: [{ criterionId: 'ac1-1', verdict: 'pass', command: 'true', exitCode: 0 }],
  }))
  const ctx = new Context()
  const dependencies: ReadonlyArray<readonly [string, object]> = [
    ['tools', registry.service],
    ['graphs', { graphForSession: async () => ({ id: 'g1', envId: 'env1', rootSessionId: 'root-1' }) }],
    ['agentRuntime', {}],
    ['task', {
      openStore: async () => ({
        tasks: ['t-champ', 't-holdout'].map(taskId => ({
          taskId,
          definitionRef: { taskType: 'subtask', version: 1 },
          parentTaskId: 't-root',
          objective: 'champion work',
          depth: 1,
          acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'works', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
          requestedCapabilities: ['research'],
          decompositionStatus: 'leaf',
          status: 'verified',
          runIds: [`r-${taskId}`],
          childTaskIds: [],
        })),
        reviews: ['t-champ', 't-holdout'].map(taskId => ({
          taskId,
          runId: `r-${taskId}`,
          outcome: 'verified',
          evidenceRefs: ['ev-champ'],
          anomalies: [],
          durationMs: 42,
          criteria: [{ criterionId: 'ac1-1', verdict: 'pass', command: 'true', exitCode: 0 }],
        })),
        evidence: [{ evidenceId: 'ev-champ' }],
        diagnoses: [], obligations: [],
      }),
    }],
    ['taskRuntime', { listCapabilities: () => ({ research: { preset: 'standard' } }), replayTask, applyCapabilityRow: vi.fn() }],
    ['userQuestions', userQuestions],
    ['approval', approval],
  ]
  for (const [name, value] of dependencies) await ctx.plugin(Stub(name, value))
  await ctx.plugin(SingularityAgent)
  return { tools: registry.tools, approval, userQuestions, home, replayTask }
}

/** A sibling plugin providing one service, standing in for a harness plugin the profile also mounts. */
function Stub(name: string, value: object) {
  return class extends Service {
    constructor(ctx: Context) {
      super(ctx, name)
      Object.assign(this, value)
    }
  }
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

/**
 * A loadable `SKILL.md` for a promotion test: the frontmatter `readSkillFile`
 * requires, plus the body a test is about. The promotion checks hold a candidate
 * to the same validator admission uses (S1-C item 3), so a candidate no worker
 * could load is refused.
 */
function skillText(body: string, name = 'verify'): string {
  return `---\nname: ${name}\ndescription: candidate skill for a promotion test\n---\n\n${body}`
}

it('drives evolution_propose and evolution_list through the plugin context onto the ledger', async () => {
  const { tools, home } = await mountAgent()
  try {
    const propose = tools.get('evolution_propose')!
    const list = tools.get('evolution_list')!
    expect(propose).toBeDefined()
    expect(list).toBeDefined()

    const registered = await propose.execute({
      proposalId: 'p-plugin-1',
      level: 'L2',
      baseVersion: 'v3',
      targetType: 'verifier',
      targetId: 'verifier:build',
      rationale: 'the acceptance command never feeds empty input',
      sourceRefs: ['evidence:ev-1'],
    }, exec('root-1'))
    expect(registered).toContain('proposal p-plugin-1 registered [proposed] L2 verifier verifier:build (base v3)')

    // The ledger is the service's own file under $DSH_HOME — the model-visible
    // answer and the persisted line must agree.
    const ledger = await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')
    expect(JSON.parse(ledger.trim())).toMatchObject({
      kind: 'proposed',
      proposalId: 'p-plugin-1',
      actor: 'root-1',
    })

    const listed = await list.execute({ status: 'proposed' })
    expect(listed).toContain('evolution ledger (1):')
    expect(listed).toContain('p-plugin-1 [proposed] L2 verifier verifier:build (base v3)')
  } finally {
    vi.unstubAllEnvs()
  }
})

it('resolves the interaction services the hitl tools ask through, from the same plugin context', async () => {
  const { tools, approval, userQuestions } = await mountAgent()
  try {
    const approve = tools.get('hitl_approve')!
    await expect(approve.execute({ prompt: 'Promote p-plugin-1?' }, exec('root-1'))).resolves.toBe('approve')
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'hitl_approve', reason: 'Promote p-plugin-1?' }))

    const ask = tools.get('hitl_ask')!
    await expect(ask.execute({ prompt: 'Which repo?' }, exec('root-1'))).resolves.toBe('buckyball')
    expect(userQuestions.ask).toHaveBeenCalledWith(expect.objectContaining({
      questions: [{ id: 'hitl-ask', question: 'Which repo?' }],
    }))
  } finally {
    vi.unstubAllEnvs()
  }
})

it('drives candidate(mutation) → prepare through the plugin, materializing only under $DSH_HOME/evolution/sandbox', async () => {
  const { tools, home } = await mountAgent()
  try {
    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    const prepare = tools.get('evolution_prepare')!
    const gate = tools.get('evolution_gate')!
    const list = tools.get('evolution_list')!
    expect(prepare).toBeDefined()

    await propose.execute({
      proposalId: 'p-cap-1',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'capability',
      targetId: 'research',
      rationale: 'research needs the verify skill',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))
    const candidateOut = await candidate.execute({
      proposalId: 'p-cap-1',
      versionSet: { capabilityTable: 'config.yml#doc1' },
      mutation: { name: 'research', entry: { preset: 'standard', skills: ['verify'] } },
    }, exec('root-1'))
    expect(candidateOut).toContain('next: evolution_prepare')

    // a mutation-carrying candidate cannot gate before it is prepared
    const gatedEarly = await gate.execute({
      proposalId: 'p-cap-1',
      targetFailureFixed: 'a',
      originalAcceptanceMaintained: 'b',
      existingRegressionMaintained: 'c',
      noUnacceptableSideEffects: 'd',
      holdoutPerformanceAcceptable: 'e',
      resourceCostAcceptable: 'f',
      regressionEvidenceRefs: ['/tmp/x'],
    }, exec('root-1'))
    expect(gatedEarly).toContain('cannot record "gated"')

    const prepared = await prepare.execute({ proposalId: 'p-cap-1' }, exec('root-1'))
    expect(prepared).toContain('proposal p-cap-1 [prepared]')
    expect(prepared).toContain('champion snapshot: captured')
    // W19: the research row exists in the repo's config.yml, so the champion is config-text sourced
    expect(prepared).toContain('config.yml row source text')

    const sandbox = join(home, 'evolution', 'sandbox', 'p-cap-1')
    const patch = await readFile(join(sandbox, 'capability-table.patch.yml'), 'utf8')
    expect(patch).toContain('whole-row replacement')
    expect(JSON.parse(patch.trim().split('\n').at(-1)!)).toEqual({ research: { preset: 'standard', skills: ['verify'] } })
    const champion = await readFile(join(sandbox, 'champion', 'capability-table.entry.yml'), 'utf8')
    expect(JSON.parse(champion.trim().split('\n').at(-1)!)).toEqual({ research: { preset: 'standard' } })
    const championSource = await readFile(join(sandbox, 'champion', 'capability-table.source.txt'), 'utf8')
    expect(championSource).toContain('research:')

    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'candidate', 'prepared'])

    const listed = await list.execute({ status: 'prepared' })
    expect(listed).toContain('p-cap-1 [prepared]')
    expect(listed).toContain('sandbox')
  } finally {
    vi.unstubAllEnvs()
  }
})


it('drives the mechanical chain prepared → replayed → gated, with the gate requiring the replay report', async () => {
  const { tools, home, replayTask } = await mountAgent()
  try {
    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    const prepare = tools.get('evolution_prepare')!
    const replay = tools.get('evolution_replay')!
    const gate = tools.get('evolution_gate')!
    const list = tools.get('evolution_list')!
    expect(replay).toBeDefined()

    await propose.execute({
      proposalId: 'p-replay-1',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'capability',
      targetId: 'research',
      rationale: 'research needs the verify skill',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))
    await candidate.execute({
      proposalId: 'p-replay-1',
      versionSet: { capabilityTable: 'config.yml#doc1' },
      mutation: { name: 'research', entry: { preset: 'standard', skills: ['verify'] } },
    }, exec('root-1'))
    await prepare.execute({ proposalId: 'p-replay-1' }, exec('root-1'))

    // a prepared mechanical mutation cannot gate before the replay
    const gatedEarly = await gate.execute({
      proposalId: 'p-replay-1',
      targetFailureFixed: 'a', originalAcceptanceMaintained: 'b', existingRegressionMaintained: 'c',
      noUnacceptableSideEffects: 'd', holdoutPerformanceAcceptable: 'e', resourceCostAcceptable: 'f',
      regressionEvidenceRefs: ['ev-champ'],
    }, exec('root-1'))
    expect(gatedEarly).toContain('cannot record "gated"')
    expect(gatedEarly).toContain('evolution_replay')

    const replayed = await replay.execute({ proposalId: 'p-replay-1', taskIds: ['t-champ'] }, exec('root-1'))
    expect(replayed).toContain('proposal p-replay-1 [replayed] capability research — verdict: not-worse')
    expect(replayed).toContain('t-champ champion verified → candidate verified')
    expect(replayTask).toHaveBeenCalledOnce()
    expect(replayTask.mock.calls[0]![2]).toMatchObject({
      lineage: 'evolution-replay:p-replay-1',
      overlay: { capabilityOverrides: { research: { preset: 'standard', skills: ['verify'] } } },
    })

    // the report sits in the sandbox; the ledger carries the replayed record
    const report = JSON.parse(await readFile(join(home, 'evolution', 'sandbox', 'p-replay-1', 'replay-report.json'), 'utf8'))
    expect(report.mode).toBe('executed')
    expect(report.verdict).toBe('not-worse')
    expect(report.observed[0]).toMatchObject({ taskId: 't-champ', verdictMatch: true, relation: 'not-worse' })
    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'candidate', 'prepared', 'replayed'])

    // the gate must cite the replay report among its regression evidence
    const gatedMissing = await gate.execute({
      proposalId: 'p-replay-1',
      targetFailureFixed: 'a', originalAcceptanceMaintained: 'b', existingRegressionMaintained: 'c',
      noUnacceptableSideEffects: 'd', holdoutPerformanceAcceptable: 'e', resourceCostAcceptable: 'f',
      regressionEvidenceRefs: ['ev-champ'],
    }, exec('root-1'))
    expect(gatedMissing).toContain('must cite the replay report')
    const gated = await gate.execute({
      proposalId: 'p-replay-1',
      targetFailureFixed: 'a', originalAcceptanceMaintained: 'b', existingRegressionMaintained: 'c',
      noUnacceptableSideEffects: 'd', holdoutPerformanceAcceptable: 'e', resourceCostAcceptable: 'f',
      regressionEvidenceRefs: ['sandbox/p-replay-1/replay-report.json', 'ev-champ'],
    }, exec('root-1'))
    expect(gated).toContain('[gated] gate answered 6/6')

    const listed = await list.execute({ status: 'gated' })
    expect(listed).toContain('p-replay-1 [gated]')
    expect(listed).toContain('replayed: verdict not-worse')
  } finally {
    vi.unstubAllEnvs()
  }
})


it('drives a skill proposal to applied and rolledback through the plugin, production writes confined to $DSH_HOME/skills', async () => {
  const { tools, home, approval, replayTask } = await mountAgent()
  try {
    const championDir = join(home, 'skills', 'verify')
    await mkdir(championDir, { recursive: true })
    await writeFile(join(championDir, 'SKILL.md'), '# old verify skill\n')

    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    const prepare = tools.get('evolution_prepare')!
    const replay = tools.get('evolution_replay')!
    const gate = tools.get('evolution_gate')!
    const decide = tools.get('evolution_decide')!
    const apply = tools.get('evolution_apply')!
    const rollback = tools.get('evolution_rollback')!
    const list = tools.get('evolution_list')!
    expect(apply).toBeDefined()
    expect(rollback).toBeDefined()

    await propose.execute({
      proposalId: 'p-skill-1',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: 'verify',
      rationale: 'the skill never mentions empty-input fixtures',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))
    await candidate.execute({
      proposalId: 'p-skill-1',
      versionSet: { skill: 'v2' },
      mutation: { name: 'verify', content: skillText('# new verify skill') },
    }, exec('root-1'))
    await prepare.execute({ proposalId: 'p-skill-1' }, exec('root-1'))
    // P2: prepare records the SHA-256 of the materialized candidate bytes on the ledger line
    const preparedRecord = JSON.parse((await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n').at(-1)!)
    const candidateBytes = await readFile(join(home, 'evolution', 'sandbox', 'p-skill-1', 'skills', 'verify', 'SKILL.md'))
    expect(candidateBytes.toString('utf8')).toBe(skillText('# new verify skill'))
    expect(preparedRecord.skillContent).toEqual({ name: 'verify', sha256: createHash('sha256').update(candidateBytes).digest('hex') })

    await replay.execute({ proposalId: 'p-skill-1', taskIds: ['t-champ'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))
    // P2: the replay overlay points at the checked candidate and the report carries the same identity
    expect(replayTask.mock.calls[0]![2]).toMatchObject({
      lineage: 'evolution-replay:p-skill-1',
      overlay: { extraSkillRoots: [join(home, 'evolution', 'sandbox', 'p-skill-1', 'skills')] },
    })
    const replayedReport = JSON.parse(await readFile(join(home, 'evolution', 'sandbox', 'p-skill-1', 'replay-report.json'), 'utf8'))
    expect(replayedReport.candidateContent).toEqual(preparedRecord.skillContent)
    const gated = await gate.execute({
      proposalId: 'p-skill-1',
      targetFailureFixed: 'a', originalAcceptanceMaintained: 'b', existingRegressionMaintained: 'c',
      noUnacceptableSideEffects: 'd', holdoutPerformanceAcceptable: 'e', resourceCostAcceptable: 'f',
      regressionEvidenceRefs: ['sandbox/p-skill-1/replay-report.json', 'ev-champ'],
    }, exec('root-1'))
    expect(gated).toContain('[gated]')

    // decide and apply each burn their own human approval
    const decided = await decide.execute({ proposalId: 'p-skill-1', decision: 'PROMOTE' }, exec('root-1'))
    expect(decided).toContain('[decided] PROMOTE')
    const applied = await apply.execute({ proposalId: 'p-skill-1' }, exec('root-1'))
    expect(applied).toContain('proposal p-skill-1 [applied] L2 skill verify')
    expect(applied).toContain('effective immediately')
    expect(approval.request).toHaveBeenCalledTimes(2)
    expect((approval.request.mock.calls[1]![0] as { toolName: string }).toolName).toBe('evolution_apply')
    // P2: production receives the verified candidate bytes, byte for byte
    expect(await readFile(join(championDir, 'SKILL.md'))).toEqual(Buffer.from(skillText('# new verify skill'), 'utf8'))

    const rolledback = await rollback.execute({ proposalId: 'p-skill-1' }, exec('root-1'))
    expect(rolledback).toContain('proposal p-skill-1 [rolledback] L2 skill verify')
    expect(approval.request).toHaveBeenCalledTimes(3)
    expect(await readFile(join(championDir, 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')

    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind))
      .toEqual(['proposed', 'candidate', 'prepared', 'replayed', 'gated', 'decided', 'applied', 'rolledback'])

    const listed = await list.execute({ status: 'rolledback' })
    expect(listed).toContain('p-skill-1 [rolledback PROMOTE]')
    expect(listed).toContain('applied: [')
  } finally {
    vi.unstubAllEnvs()
  }
})

it('refuses a tampered skill candidate through the plugin, leaving production and the ledger untouched', async () => {
  const { tools, home } = await mountAgent()
  try {
    const championDir = join(home, 'skills', 'verify')
    await mkdir(championDir, { recursive: true })
    await writeFile(join(championDir, 'SKILL.md'), '# old verify skill\n')

    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    const prepare = tools.get('evolution_prepare')!
    const replay = tools.get('evolution_replay')!
    await propose.execute({
      proposalId: 'p-skill-2',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: 'verify',
      rationale: 'the skill never mentions empty-input fixtures',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))
    await candidate.execute({
      proposalId: 'p-skill-2',
      versionSet: { skill: 'v2' },
      mutation: { name: 'verify', content: skillText('# new verify skill') },
    }, exec('root-1'))
    await prepare.execute({ proposalId: 'p-skill-2' }, exec('root-1'))
    // the candidate changes after prepare — the service identity check must refuse it
    await writeFile(join(home, 'evolution', 'sandbox', 'p-skill-2', 'skills', 'verify', 'SKILL.md'), 'tampered\n')

    const rejected = await replay.execute({ proposalId: 'p-skill-2', taskIds: ['t-champ'] }, exec('root-1'))
    expect(rejected).toContain('evolution_replay rejected:')
    expect(rejected).toContain('no longer matches the content identity')
    expect(await readFile(join(championDir, 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'candidate', 'prepared'])
    expect(existsSync(join(home, 'evolution', 'sandbox', 'p-skill-2', 'replay-report.json'))).toBe(false)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('refuses a skill apply whose production baseline moved after prepare, through the plugin', async () => {
  const { tools, home, approval } = await mountAgent()
  try {
    const championDir = join(home, 'skills', 'verify')
    await mkdir(championDir, { recursive: true })
    await writeFile(join(championDir, 'SKILL.md'), '# old verify skill\n')

    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    const prepare = tools.get('evolution_prepare')!
    const replay = tools.get('evolution_replay')!
    const gate = tools.get('evolution_gate')!
    const decide = tools.get('evolution_decide')!
    const apply = tools.get('evolution_apply')!
    const list = tools.get('evolution_list')!

    await propose.execute({
      proposalId: 'p-skill-3',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: 'verify',
      rationale: 'the skill never mentions empty-input fixtures',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))
    await candidate.execute({
      proposalId: 'p-skill-3',
      versionSet: { skill: 'v2' },
      mutation: { name: 'verify', content: skillText('# new verify skill') },
    }, exec('root-1'))
    const prepared = await prepare.execute({ proposalId: 'p-skill-3' }, exec('root-1'))
    // P3: prepare records the production baseline digest on the ledger line
    expect(prepared).toContain('production baseline: verify sha256:')
    const preparedRecord = JSON.parse((await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n').at(-1)!)
    expect(preparedRecord.skillBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update('# old verify skill\n').digest('hex'),
    })

    await replay.execute({ proposalId: 'p-skill-3', taskIds: ['t-champ'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))
    await gate.execute({
      proposalId: 'p-skill-3',
      targetFailureFixed: 'a', originalAcceptanceMaintained: 'b', existingRegressionMaintained: 'c',
      noUnacceptableSideEffects: 'd', holdoutPerformanceAcceptable: 'e', resourceCostAcceptable: 'f',
      regressionEvidenceRefs: ['sandbox/p-skill-3/replay-report.json', 'ev-champ'],
    }, exec('root-1'))
    await decide.execute({ proposalId: 'p-skill-3', decision: 'PROMOTE' }, exec('root-1'))

    // the production skill changes after the candidate was prepared and approved
    await writeFile(join(championDir, 'SKILL.md'), '# edited in production\n')
    const rejected = await apply.execute({ proposalId: 'p-skill-3' }, exec('root-1'))
    expect(rejected).toContain('evolution_apply rejected:')
    expect(rejected).toContain('changed since prepare')
    expect(rejected).toContain('create a new candidate from the current production state')
    // the apply never reaches the human: only the decide approval was burned
    expect(approval.request).toHaveBeenCalledTimes(1)
    // production keeps the externally edited bytes
    expect(await readFile(join(championDir, 'SKILL.md'), 'utf8')).toBe('# edited in production\n')
    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind))
      .toEqual(['proposed', 'candidate', 'prepared', 'replayed', 'gated', 'decided'])
    const listed = await list.execute({ status: 'decided' })
    expect(listed).toContain('p-skill-3 [decided PROMOTE]')
    expect(listed).toContain('production baseline verify sha256:')
  } finally {
    vi.unstubAllEnvs()
  }
})
