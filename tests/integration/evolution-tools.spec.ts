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
 * Mounts the real root-agent plugin on a real context, with the deployment's
 * evolution chain explicitly ON (`{ evolution: 'on' }`). Every dependency is a
 * sibling plugin of its own, the way the loader mounts `dsh-base` next to this
 * bundle; the evolution ledger's service is the plugin's own, so nothing stands
 * in for it, and every tool under test is the one the plugin registered.
 *
 * The switch is not incidental to this spec: with the shipped default (off) the
 * nine `evolution_*` tools are never registered, so `tools.get('evolution_*')`
 * is undefined here by construction. These cases are the other half of R0 — the
 * explicit opt-in keeps the previous chain, validation, approvals and history
 * exactly as they were.
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
  // The caller session's own workspace: what the skill experiment freezes as its
  // input snapshot (`TaskRuntime.workspacePathFor`), and — with the store below —
  // the world a two-sided experiment reads before it refuses or runs.
  const workspace = join(home, 'env')
  await mkdir(join(workspace, 'nested'), { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n')
  const dependencies: ReadonlyArray<readonly [string, object]> = [
    ['tools', registry.service],
    ['graphs', { graphForSession: async () => ({ id: 'g1', envId: 'env1', rootSessionId: 'root-1' }) }],
    ['agentRuntime', {}],
    // The deployment's default model identity: what the two-sided experiment
    // freezes as the model its runs share (the caller agent's own selection where
    // the session has one, this otherwise).
    ['agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) }],
    ['task', {
      openStore: async () => ({
        // `t-champ`/`t-holdout` are the verified terminal tasks the v1 replay
        // cases name; `t-fail` carries the failed latest review the skill
        // experiment reads an observed-failure sample's role from.
        tasks: ['t-champ', 't-holdout', 't-fail'].map(taskId => ({
          taskId,
          definitionRef: { taskType: 'subtask', version: 1 },
          parentTaskId: 't-root',
          objective: 'champion work',
          depth: 1,
          acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'works', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
          requestedCapabilities: ['research'],
          decompositionStatus: 'leaf',
          status: taskId === 't-fail' ? 'failed' : 'verified',
          runIds: [`r-${taskId}`],
          childTaskIds: [],
        })),
        reviews: ['t-champ', 't-holdout', 't-fail'].map(taskId => ({
          taskId,
          runId: `r-${taskId}`,
          outcome: taskId === 't-fail' ? 'failed' : 'verified',
          evidenceRefs: ['ev-champ'],
          anomalies: [],
          durationMs: 42,
          criteria: [{ criterionId: 'ac1-1', verdict: taskId === 't-fail' ? 'fail' : 'pass', command: 'true', exitCode: 0 }],
        })),
        evidence: [{ evidenceId: 'ev-champ' }],
        diagnoses: [], obligations: [],
      }),
    }],
    ['taskRuntime', {
      listCapabilities: () => ({ research: { preset: 'standard' } }),
      replayTask,
      applyCapabilityRow: vi.fn(),
      workspacePathFor: async () => workspace,
      // The plugin installs its root-budget approval (K4) on the runtime at
      // construction, and the terminal-review listener its automatic review
      // trigger rides (A5); nothing this spec drives asks for either.
      registerRootBudgetApproval: () => () => {},
      registerTerminalReviewListener: () => () => {},
    }],
    // The read core the root-agent plugin injects (A2). This spec's subjects are
    // the evolution ledger and the approval seam, and every tool it drives is an
    // `evolution_*` or `hitl_*` one — nothing here reads context. The read core's
    // own consumers are the `context` package's specs and
    // `tests/integration/context-assembly.spec.ts`, so this sibling provides the
    // one call the plugin makes at load time (registering its reviewer binding
    // source) and nothing else.
    ['singularityContext', { registerReviewerBindingSource: () => () => {} }],
    ['userQuestions', userQuestions],
    ['approval', approval],
  ]
  for (const [name, value] of dependencies) await ctx.plugin(Stub(name, value))
  // The one deployment choice this spec has to state out loud: the chain it
  // drives is the one the deployment opted into.
  await ctx.plugin(SingularityAgent, { evolution: 'on' })
  return { tools: registry.tools, approval, userQuestions, home, replayTask, workspace }
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
 * could load is refused — and the same is true of the *production* object
 * `evolution_prepare` freezes, which is why every case below installs one.
 */
function skillText(body: string, name = 'verify'): string {
  return `---\nname: ${name}\ndescription: candidate skill for a promotion test\n---\n\n${body}`
}

/** The production version every promotion case replaces: one loadable guidance object. */
const PRODUCTION_SKILL = skillText('# old verify skill')

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

it('points skill and capability proposals at candidate lifecycles without changing production', async () => {
  const { tools, home } = await mountAgent()
  try {
    const propose = tools.get('evolution_propose')!
    const suggestion = (await propose.execute({
      proposalId: 'p-cap-suggestion',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'capability',
      targetId: 'research',
      rationale: 'research needs the verify skill',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))) as string
    expect(suggestion).toContain('proposal p-cap-suggestion registered [proposed] L2 capability research (base v1)')
    expect(suggestion).toContain('next: evolution_candidate')
    expect(suggestion).toContain('exactly one whole capability row')

    // The skill branch still asks for a same-name replacement object.
    const replacement = (await propose.execute({
      proposalId: 'p-skill-1',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: 'verify',
      rationale: 'the skill never mentions empty-input fixtures',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))) as string
    expect(replacement).toContain('proposal p-skill-1 registered [proposed] L2 skill verify (base v1)')
    expect(replacement).toContain('next: evolution_candidate')

    // The next-step line is wording, not a lifecycle: both proposals are ledger
    // records and nothing more — no candidate, no sandbox.
    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'proposed'])
    expect(existsSync(join(home, 'evolution', 'sandbox'))).toBe(false)
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

it('refuses a capability mutation of the shape this build does not write, at the call: no candidate, no sandbox', async () => {
  const { tools, home } = await mountAgent()
  try {
    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    const prepare = tools.get('evolution_prepare')!
    const gate = tools.get('evolution_gate')!
    const list = tools.get('evolution_list')!

    await propose.execute({
      proposalId: 'p-cap-1',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'capability',
      targetId: 'research',
      rationale: 'research needs the verify skill',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))

    // The tool accepts JSON text, then the service checks the whole mutation.
    const refused = await candidate.execute({
      proposalId: 'p-cap-1',
      versionSet: { capabilityTable: 'config.yml#doc1' },
      mutationJson: JSON.stringify({ name: 'research', entry: { preset: 'standard', skills: ['verify'] } }),
    }, exec('root-1')) as string
    expect(refused).toContain('evolution_candidate rejected:')
    expect((await list.execute({}, exec('root-1'))) as string).toContain('p-cap-1 [proposed]')

    const prepared = await prepare.execute({ proposalId: 'p-cap-1' }, exec('root-1'))
    expect(prepared).toContain('evolution_prepare rejected:')
    expect(prepared).toContain('cannot record "prepared"')

    const gated = await gate.execute({
      proposalId: 'p-cap-1',
      targetFailureFixed: 'a',
      originalAcceptanceMaintained: 'b',
      existingRegressionMaintained: 'c',
      noUnacceptableSideEffects: 'd',
      holdoutPerformanceAcceptable: 'e',
      resourceCostAcceptable: 'f',
      regressionEvidenceRefs: ['/tmp/x'],
    }, exec('root-1'))
    expect(gated).toContain('cannot record "gated"')

    // Only the proposal itself, and no sandbox anywhere near it.
    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed'])
    expect(existsSync(join(home, 'evolution', 'sandbox'))).toBe(false)

    const listed = await list.execute({ status: 'proposed' })
    expect(listed).toContain('p-cap-1 [proposed]')
  } finally {
    vi.unstubAllEnvs()
  }
})

it('accepts model-authored JSON text as one capability candidate and binds a new skill to its exact content', async () => {
  const { tools, home } = await mountAgent()
  try {
    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    await propose.execute({
      proposalId: 'p-cap-json', level: 'L2', baseVersion: 'v1', targetType: 'capability',
      targetId: 'research', rationale: 'add the missing provider', sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))
    const content = '---\nname: release-provider\ndescription: Produce the release artifact.\n---\n\n# Release provider\n'
    const mutationJson = JSON.stringify({
      rows: { research: { skills: ['release-provider'] } },
      skill: {
        name: 'release-provider', content,
        sidecar: {
          precondition: 'a release task is present', inputs: [], outputs: [],
          requiredTools: [], verifier: { ref: 'command' },
        },
      },
    })
    const malformed = await candidate.execute({
      proposalId: 'p-cap-json', versionSet: { capabilityTable: 'v1' }, mutationJson: '{"rows":',
    }, exec('root-1')) as string
    expect(malformed).toContain('evolution_candidate rejected:')
    const forged = await candidate.execute({
      proposalId: 'p-cap-json', versionSet: { capabilityTable: 'v1' },
      mutationJson: JSON.stringify({
        ...JSON.parse(mutationJson),
        skill: { ...JSON.parse(mutationJson).skill, sidecar: { content: { skillMdSha256: '0'.repeat(64), resources: [] } } },
      }),
    }, exec('root-1')) as string
    expect(forged).toContain('sidecar.content is not an authorable field')
    expect((await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    const result = await candidate.execute({
      proposalId: 'p-cap-json', versionSet: { capabilityTable: 'v1' }, mutationJson,
    }, exec('root-1')) as string
    expect(result).toContain('proposal p-cap-json [candidate]')
    const lines = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    const recorded = JSON.parse(lines[1]!) as { mutation: { skill: { sidecar: { content: { skillMdSha256: string, resources: unknown[] } } } } }
    expect(recorded.mutation.skill.sidecar.content).toEqual({
      skillMdSha256: createHash('sha256').update(content).digest('hex'), resources: [],
    })
  } finally {
    vi.unstubAllEnvs()
  }
})
it('refuses a tampered skill candidate through the plugin, leaving production and the ledger untouched', async () => {
  const { tools, home, replayTask } = await mountAgent()
  try {
    const championDir = join(home, 'skills', 'verify')
    await mkdir(championDir, { recursive: true })
    await writeFile(join(championDir, 'SKILL.md'), PRODUCTION_SKILL)

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
    const candidateOut = (await candidate.execute({
      proposalId: 'p-skill-2',
      versionSet: { skill: 'v2' },
      mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new verify skill') }),
    }, exec('root-1'))) as string
    expect(candidateOut).toContain('proposal p-skill-2 [candidate] version set: skill=v2')
    expect(candidateOut).toContain('mutation recorded — next: evolution_prepare')
    const preparedOut = (await prepare.execute({ proposalId: 'p-skill-2' }, exec('root-1'))) as string
    expect(preparedOut).toContain('proposal p-skill-2 [prepared] sandbox:')
    expect(preparedOut).toContain('champion snapshot: captured under champion/')
    expect(preparedOut).toContain('production baseline: verify sha256:')
    expect(preparedOut).toContain('next: evolution_replay')
    // the candidate changes after prepare — the service identity check must refuse it
    await writeFile(join(home, 'evolution', 'sandbox', 'p-skill-2', 'skills', 'verify', 'SKILL.md'), 'tampered\n')

    const rejected = await replay.execute({ proposalId: 'p-skill-2', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))
    expect(rejected).toContain('evolution_replay rejected:')
    expect(rejected).toContain('no longer matches the content identity')
    expect(await readFile(join(championDir, 'SKILL.md'), 'utf8')).toBe(PRODUCTION_SKILL)
    // nothing ran and nothing was recorded: the two-sided experiment re-verifies
    // the candidate before its first run, and no experiment line reached the ledger
    expect(replayTask).not.toHaveBeenCalled()
    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'candidate', 'prepared'])
    expect(existsSync(join(home, 'evolution', 'sandbox', 'p-skill-2', 'replay-report.json'))).toBe(false)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('refuses a skill call the two-sided experiment cannot honour, without running or recording anything', async () => {
  const { tools, home, replayTask } = await mountAgent()
  try {
    const championDir = join(home, 'skills', 'verify')
    await mkdir(championDir, { recursive: true })
    await writeFile(join(championDir, 'SKILL.md'), PRODUCTION_SKILL)

    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    const prepare = tools.get('evolution_prepare')!
    const replay = tools.get('evolution_replay')!

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
      mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new verify skill') }),
    }, exec('root-1'))
    // P3: prepare records the production baseline digest on the ledger line
    const prepared = await prepare.execute({ proposalId: 'p-skill-3' }, exec('root-1'))
    expect(prepared).toContain('production baseline: verify sha256:')
    const preparedRecord = JSON.parse((await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n').at(-1)!)
    expect(preparedRecord.skillBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(PRODUCTION_SKILL, 'utf8').digest('hex'),
    })

    // A skill candidate is evaluated by a two-sided experiment, so the call must
    // name a failure and a holdout: history supplies the roles, and a call that
    // names no failure is refused by name before anything runs.
    const noFailure = await replay.execute({ proposalId: 'p-skill-3', taskIds: ['t-champ'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))
    expect(noFailure).toContain('evolution_replay rejected:')
    expect(noFailure).toContain('no observed failure for this candidate to fix')
    const noHoldout = await replay.execute({ proposalId: 'p-skill-3', taskIds: ['t-fail'] }, exec('root-1'))
    expect(noHoldout).toContain('holdoutTaskIds must name at least one task that did not select this candidate')
    expect(replayTask).not.toHaveBeenCalled()
    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'candidate', 'prepared'])
  } finally {
    vi.unstubAllEnvs()
  }
})

it('refuses a skill gate without an experiment through the tools, leaving the ledger at prepared', async () => {
  const { tools, home, approval } = await mountAgent()
  try {
    const championDir = join(home, 'skills', 'verify')
    await mkdir(championDir, { recursive: true })
    await writeFile(join(championDir, 'SKILL.md'), PRODUCTION_SKILL)

    const propose = tools.get('evolution_propose')!
    const candidate = tools.get('evolution_candidate')!
    const prepare = tools.get('evolution_prepare')!
    const gate = tools.get('evolution_gate')!
    const answers = {
      targetFailureFixed: 'a', originalAcceptanceMaintained: 'b', existingRegressionMaintained: 'c',
      noUnacceptableSideEffects: 'd', holdoutPerformanceAcceptable: 'e', resourceCostAcceptable: 'f',
      regressionEvidenceRefs: ['ev-champ'],
    }

    // A skill candidate gates on its experiment: with none recorded, the gate is
    // refused and only the ledger's three lifecycle lines exist.
    await propose.execute({
      proposalId: 'p-skill-eval4',
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: 'verify',
      rationale: 'the skill never mentions empty-input fixtures',
      sourceRefs: ['diagnosis:d1'],
    }, exec('root-1'))
    await candidate.execute({
      proposalId: 'p-skill-eval4',
      versionSet: { skill: 'v2' },
      mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new verify skill') }),
    }, exec('root-1'))
    const prepared = await prepare.execute({ proposalId: 'p-skill-eval4' }, exec('root-1'))
    expect(prepared).toContain('production baseline: verify sha256:')
    const refusedGate = await gate.execute({ proposalId: 'p-skill-eval4', ...answers }, exec('root-1'))
    expect(refusedGate).toContain('evolution_gate rejected:')
    expect(refusedGate).toContain('has no two-sided experiment')
    // and the same proposal cannot be decided on a gate it never answered
    const decide = tools.get('evolution_decide')!
    const refusedDecide = await decide.execute({ proposalId: 'p-skill-eval4', decision: 'PROMOTE' }, exec('root-1'))
    expect(refusedDecide).toContain('evolution_decide rejected:')
    expect(approval.request).not.toHaveBeenCalled()

    const ledger = (await readFile(join(home, 'evolution', 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(ledger).not.toContain('decided')
    expect(ledger).not.toContain('applied')
    expect(ledger).not.toContain('gated')
  } finally {
    vi.unstubAllEnvs()
  }
})
