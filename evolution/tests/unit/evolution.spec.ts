import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityConfig, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService } from '../../src/evolution.ts'
import type { Config, GateAnswers, ProposeInput } from '../../src/evolution.ts'
import type { ExperimentSampleRecord } from '../../src/experiment.ts'
import { buildExperimentReport, directoryDigest, experimentIdOf, experimentLineage, experimentReportPath } from '../../src/experiment.ts'
import type { FrozenExperiment, FrozenProviderIdentity, FrozenSample, ModelSelection, SkillContentIdentity } from '../../src/replay.ts'
import { digestOf, EXPERIMENT_COMPARER_VERSION, frozenDigestOf, modelSelectionOf, protectedInputsDigest } from '../../src/replay.ts'
import { defineEvolutionApplyTool } from '../../../agent-singularity/src/tools/evolution-apply.ts'
import { defineEvolutionCandidateTool } from '../../../agent-singularity/src/tools/evolution-candidate.ts'
import { defineEvolutionDecideTool } from '../../../agent-singularity/src/tools/evolution-decide.ts'
import { defineEvolutionGateTool } from '../../../agent-singularity/src/tools/evolution-gate.ts'
import { defineEvolutionListTool } from '../../../agent-singularity/src/tools/evolution-list.ts'
import { defineEvolutionPrepareTool } from '../../../agent-singularity/src/tools/evolution-prepare.ts'
import { defineEvolutionProposeTool } from '../../../agent-singularity/src/tools/evolution-propose.ts'
import { defineEvolutionReplayTool } from '../../../agent-singularity/src/tools/evolution-replay.ts'
import { defineEvolutionRollbackTool } from '../../../agent-singularity/src/tools/evolution-rollback.ts'
import { compareReplaySides } from '../../src/replay.ts'

/**
 * The task-store rows a promotion fixture's gate re-reads. `fixtureCtx()` owns
 * one set per service and exposes it through `ctx.promotionStore`, so
 * {@link recordSkillExperiment} can settle the sides a skill promotion is judged
 * on and the gate finds exactly those rows when it goes looking.
 */
interface FixtureRows {
  tasks: Record<string, unknown>[]
  runs: Record<string, unknown>[]
  reviews: Record<string, unknown>[]
  evidence: Record<string, unknown>[]
  /** The session logs the gate re-reads a side's real requests from, by session id. */
  sessions: Map<string, unknown[]>
}

/** The one model selection every fixture service resolves — the one the experiments below freeze. */
const FIXTURE_SELECTION = modelSelectionOf({ provider: 'p', model: 'm' })!
const FIXTURE_MODEL = FIXTURE_SELECTION.label
/** The registry revision the fixture's production configuration resolves to (frozen and bound alike). */
const FIXTURE_REGISTRY_REVISION = 'r'.repeat(64)
/** The judge every sample criterion of a frozen experiment pins, as the fixture's registry declares it. */
const FIXTURE_JUDGE = { ref: 'command', version: '1' } as const

/** The provider identity the fixture's production configuration resolves to (no rows, no skills). */
function fixtureProviderIdentity(): FrozenProviderIdentity {
  return { capabilities: [], registryRevision: FIXTURE_REGISTRY_REVISION, mcpServers: [], preset: null, skills: [] }
}

/**
 * The `request/header` event one fixture side's session log carries — the shape
 * the live loop appends for a request it really made, recorded here for the
 * sides this fixture settles by hand (the real-loop evidence lives in
 * `tests/integration/s4e-q3-freeze-binding.spec.ts`).
 */
function fixtureRequestHeader(seq = 1): Record<string, unknown> {
  return {
    type: 'request/header',
    seq,
    time: 0,
    data: { header: { config: { provider: FIXTURE_SELECTION.provider, model: FIXTURE_SELECTION.model } }, reason: 'initial' },
  }
}

/** One side's run row, with the provider binding the gate compares to the frozen identity. */
function fixtureSideRun(input: { runId: string; taskId: string; outcome: string; at: string }): Record<string, unknown> {
  return {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: `s-${input.runId}`,
    status: input.outcome,
    startedAt: input.at,
    providerBinding: { registryRevision: FIXTURE_REGISTRY_REVISION, capabilities: [], skills: [], mcpServers: [] },
  }
}

function fixtureCtx() {
  const promotionStore: FixtureRows = { tasks: [], runs: [], reviews: [], evidence: [], sessions: new Map() }
  return {
    reflect: { provide: () => {} },
    effect: () => {},
    // The capability registry a promotion check reads (S1-C item 3): the rows
    // the capability fixtures below replace, one skill name at a time.
    taskRuntime: { listCapabilities: () => structuredClone(FIXTURE_CAPABILITIES) },
    // The verifier vocabulary the same check judges execution sidecars against:
    // the three built-ins, as a real deployment's registry reports them after
    // `ready()`, with the versions their verdicts are stamped with.
    verifier: {
      ready: async () => {},
      verifierIds: () => [...VERIFIER_VOCABULARY],
      verifierVersions: () => Object.fromEntries(VERIFIER_VOCABULARY.map(id => [id, '1'])),
    },
    // The session plane the model half of the gate reads (S4-E §Q3): the logs
    // `recordSkillExperiment` filled, one event list per session id.
    sessionQuery: {
      readSession: async (sessionId: string) => {
        const events = promotionStore.sessions.get(sessionId)
        if (events === undefined) throw new Error(`missing session ${sessionId}`)
        return { session: { id: sessionId }, inheritedEventCount: 0, events }
      },
    },
    // The store the promotion gate re-reads (`task.openStore`): the same rows
    // `recordSkillExperiment` fills, so a skill promotion is judged on evidence
    // this fixture actually wrote.
    promotionStore,
    task: { openStore: async () => ({ ...promotionStore, diagnoses: [], obligations: [] }) },
  } as never
}

/**
 * The stub context one fixture service was built on. A second service over the
 * same ledger must be built on the *same* context — `fixtureCtx()` owns the store
 * rows a recorded experiment is re-read through, so a fresh context would hold an
 * empty store and the gate would find no sides at all.
 */
function ctxOf(svc: EvolutionService): never {
  return (svc as unknown as { ctx: never }).ctx
}

/** A second service over the same ledger and store rows as `svc`. */
function reopenLike(svc: EvolutionService, config: Config): EvolutionService {
  return new EvolutionService(ctxOf(svc), config)
}

/** The refusal message of one call, or `''` when it resolved. */
async function refusalOf(action: Promise<unknown>): Promise<string> {
  try {
    await action
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The production roots one fixture service writes to. */
type ProductionRoots = { root: string; skillRoot: string }

/** The report path of a skill proposal's recorded experiment — the evidence its gate must cite. */
async function experimentReportPathOf(svc: EvolutionService, proposalId = 's1'): Promise<string> {
  const [experiment] = await svc.experiments(proposalId)
  if (experiment === undefined) throw new Error(`proposal "${proposalId}" has no recorded experiment`)
  return experiment.report
}

/** The mutable store rows behind one fixture service. */
function promotionRows(svc: EvolutionService): FixtureRows {
  const rows = (svc as unknown as { ctx: { promotionStore?: FixtureRows } }).ctx.promotionStore
  if (rows === undefined) throw new Error('this service was not built on fixtureCtx(), so it has no promotion store to fill')
  return rows
}

/**
 * The skill a capability fixture's row grants. A name no deployment installs,
 * so discovery from the harness process's own roots can only ever find the copy
 * this suite wrote into the pinned skill home — a promotion check that asked
 * the machine instead of the table would make these tests machine-dependent.
 */
const CAPABILITY_FIXTURE_SKILL = 'capability-fixture-skill'

/**
 * The row the provider-check fixtures replace, and the skill it grants: both
 * named so no deployment can collide with them, and the row carrying the tools
 * an execution fixture needs — the covering set a promotion check reads off the
 * row that grants the provider.
 */
const PROMOTION_ROW = 'promotion-fixture-capability'
const PROMOTION_SKILL = 'promotion-fixture-skill'

/**
 * The verifier vocabulary every fixture context reports, as a real registry
 * lists its built-ins after `ready()`.
 */
const VERIFIER_VOCABULARY = ['command', 'composite', 'review']

/**
 * The capability table the fixture context's runtime registry answers with. The
 * capability tests replace one row at a time, so the table holds the rows they
 * start from; a replaced row is folded in by the promotion check itself.
 */
const FIXTURE_CAPABILITIES: Readonly<Record<string, CapabilityConfig>> = {
  research: { preset: 'standard' },
  [PROMOTION_ROW]: { skills: [PROMOTION_SKILL], tools: ['filesystem', 'bash'] },
}

/**
 * A loadable `SKILL.md` for a promotion test: the frontmatter `readSkillFile`
 * requires, plus whatever body the test is actually about. S1-C item 3 holds a
 * promoted candidate to the same validator admission uses, so a candidate no
 * worker could load is refused — the frontmatter here is what makes these
 * fixtures candidates a promotion may legitimately write.
 */
function skillText(body: string, name = 'verify'): string {
  return `---\nname: ${name}\ndescription: candidate skill for a promotion test\n---\n\n${body}`
}

/** The pinned skill home a capability fixture installs into is per-test; un-pin it however the test ends. */
afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * P2-D race seam: wraps `node:fs/promises.readFile` so a test can replace a
 * candidate SKILL.md on disk immediately after a read of it completes. Inert
 * unless a test arms `onCandidateRead` — every other call passes straight
 * through to the real fs.
 */
const candidateReadHooks = vi.hoisted(() => ({
  onCandidateRead: undefined as undefined | ((path: string, readCount: number) => Promise<void> | void),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const read = actual.readFile as (path: unknown, options?: unknown) => Promise<unknown>
  let candidateReads = 0
  return {
    ...actual,
    readFile: async (path: unknown, options?: unknown) => {
      const bytes = await read(path, options)
      const asPath = String(path)
      if (asPath.includes(`${sep}sandbox${sep}`) && asPath.endsWith(`${sep}SKILL.md`)) {
        candidateReads += 1
        await candidateReadHooks.onCandidateRead?.(asPath, candidateReads)
      }
      return bytes
    },
  } as typeof actual
})

async function service() {
  const root = await mkdtemp(join(tmpdir(), 'evolution-'))
  return new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
}

const proposal: ProposeInput = {
  proposalId: 'p1',
  targetType: 'task_definition',
  targetId: 'build:1',
  baseVersion: 'v3',
  level: 'L2',
  rationale: 'the acceptance command never feeds empty input',
  sourceRefs: ['diagnosis:d1'],
}

function gateAnswers(refs: string[]): GateAnswers {
  return {
    targetFailureFixed: 'empty-input fixture now passes',
    originalAcceptanceMaintained: 'original criteria unchanged and green',
    existingRegressionMaintained: 'full suite replayed green',
    noUnacceptableSideEffects: 'diff touches one command only',
    holdoutPerformanceAcceptable: 'held-out fixtures pass',
    resourceCostAcceptable: 'same runtime as baseline',
    regressionEvidenceRefs: refs,
  }
}

const VERSION_SET = { taskDefinition: 'v3', verifier: 'v1' }

/** The candidate content identity prepare recorded for a skill proposal. */
async function skillIdentity(svc: EvolutionService, proposalId: string): Promise<SkillContentIdentity> {
  return (await svc.get(proposalId)).prepared!.skillContent!
}

describe('EvolutionService ledger', () => {
  it('walks proposed → candidate → prepared → gated → decided and derives history from appended records', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
    const decided = await svc.decide('s1', 'KEEP_FOR_FURTHER_RESEARCH', 'root-1', 'approval:call-1', 'approved by human')
    expect(decided.status).toBe('decided')
    expect(decided.decision).toBe('KEEP_FOR_FURTHER_RESEARCH')
    expect(decided.decisionNote).toBe('approved by human')
    expect(decided.decisionApprovalRef).toBe('approval:call-1')
    expect(decided.history.map(entry => entry.status)).toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided'])
  })

  it('rejects state-machine skips: gate on proposed, decide on candidate, candidate twice', async () => {
    const { svc } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow('cannot record "gated"')
    await expect(svc.decide('s1', 'REJECT', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "decided"')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') }))
      .rejects.toThrow('cannot record "candidate"')
    await expect(svc.propose(skillProposal, 'root-1')).rejects.toThrow('already exists')
    // and an unprepared candidate cannot gate: prepared is the one next state
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow(/cannot record "gated".*evolution_prepare/)
  })

  it('rejects moves on an unknown proposal id', async () => {
    const svc = await service()
    await expect(svc.candidate('ghost', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') }))
      .rejects.toThrow('unknown proposal "ghost"')
    await expect(svc.get('ghost')).rejects.toThrow('unknown proposal "ghost"')
  })

  it('enforces required fields: baseVersion, level, at least one sourceRef', async () => {
    const svc = await service()
    await expect(svc.propose({ ...proposal, baseVersion: ' ' }, 'root-1')).rejects.toThrow('baseVersion')
    await expect(svc.propose({ ...proposal, level: 'L9' as never }, 'root-1')).rejects.toThrow('unknown level')
    await expect(svc.propose({ ...proposal, sourceRefs: [] }, 'root-1')).rejects.toThrow('at least one source')
    await expect(svc.propose({ ...proposal, sourceRefs: ['ok', ''] }, 'root-1')).rejects.toThrow('sourceRefs[1]')
  })

  it('enforces a complete non-empty version set on candidate', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    const mutation = { name: 'verify', content: skillText('x') }
    await expect(svc.candidate('s1', {}, 'root-1', mutation)).rejects.toThrow('at least one version')
    await expect(svc.candidate('s1', { verifier: ' ' }, 'root-1', mutation)).rejects.toThrow('versionSet["verifier"]')
    await expect(svc.candidate('s1', { verifier: 1 as never }, 'root-1', mutation)).rejects.toThrow('versionSet["verifier"]')
  })

  it('requires all six gate answers and existence-checked regression evidence refs', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await expect(svc.gate('s1', { ...gateAnswers([reportPath]), targetFailureFixed: '' }, 'root-1')).rejects.toThrow('Target failure fixed')
    await expect(svc.gate('s1', gateAnswers([]), 'root-1')).rejects.toThrow('at least one evidence ref')
    await expect(svc.gate('s1', gateAnswers([reportPath, 'no/such/path.log']), 'root-1')).rejects.toThrow('no known evidence id and no existing path')
    // a resolver id (task-store evidence) also satisfies existence — checked, never executed
    await svc.gate('s1', gateAnswers([reportPath, 'evidence-r1-abc']), 'root-1', async ref => ref === 'evidence-r1-abc')
    expect((await svc.get('s1')).status).toBe('gated')
  })

  it('requires human-approval evidence on decide and records it on the ledger line', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
    await expect(svc.decide('s1', 'KEEP_FOR_FURTHER_RESEARCH', 'root-1', '')).rejects.toThrow('approvalRef')
    expect((await svc.get('s1')).status).toBe('gated')
    await svc.decide('s1', 'KEEP_FOR_FURTHER_RESEARCH', 'root-1', 'approval:call-1', 'approved by human')
    const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'decided', approvalRef: 'approval:call-1' })
    expect((await svc.get('s1')).decisionApprovalRef).toBe('approval:call-1')
    // and the fold after reopen keeps the ref
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root: svc.root, skillRoot })
    expect((await reopened.get('s1')).decisionApprovalRef).toBe('approval:call-1')
  })

  it('is append-only and immutable: duplicate ids rejected, replay after reopen matches the live fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const first = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await first.propose(skillProposal, 'root-1')
    await first.propose({ ...proposal, proposalId: 'p2', targetType: 'verifier', level: 'L4' }, 'root-1')
    await first.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(first.propose(skillProposal, 'root-1')).rejects.toThrow('already exists')
    const live = await first.list()
    // three lines on disk, one per record, never rewritten
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'proposed', 'candidate'])
    // close: drain writes, reopen a fresh service on the same root, replay must fold to the same state
    const reopened = reopenLike(first, { modelSelection: () => FIXTURE_SELECTION, root })
    expect(await reopened.list()).toEqual(live)
    expect((await reopened.get('s1')).status).toBe('candidate')
    expect((await reopened.get('p2')).level).toBe('L4')
  })

  it('fails loudly on a corrupt ledger line instead of silently drifting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(proposal, 'root-1')
    await writeFile(join(root, 'proposals.jsonl'), 'not json\n', { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('corrupt ledger line 2')
  })

  it('fails loudly when a hand-written line violates the state machine on read-back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(proposal, 'root-1')
    const forged = { formatVersion: 2, kind: 'decided', proposalId: 'p1', decision: 'PROMOTE', actor: 'x', at: 'now' }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('cannot record "decided"')
  })
})

const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }

function toolCtx(svc: EvolutionService, approvalOutcome: string = 'allowed-once') {
  // The mock carries the request shape so a case can read back what the human
  // was actually asked (`mock.calls[0][0]`) without a cast to `never`.
  const approval = { request: vi.fn(async (_request: { reason: string; toolName: string }) => approvalOutcome) }
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    evolution: svc,
    approval,
    graphs: { graphForSession: vi.fn(async () => graph) },
    taskRuntime: { listCapabilities: vi.fn(() => structuredClone(FIXTURE_CAPABILITIES)), applyCapabilityRow: vi.fn() },
    // The vocabulary a promotion check judges execution sidecars against.
    verifier: { ready: async () => {}, verifierIds: () => [...VERIFIER_VOCABULARY] },
    task: {
      openStore: vi.fn(async () => ({
        diagnoses: [
          {
            diagnosisId: 'd1',
            taskId: 't1',
            observedFailure: 'ac fails',
            scope: 'this task',
            localizedCause: 'empty input never fed',
            evidenceRefs: ['ev-1'],
            reviewRefs: ['t1#r1'],
            confidence: 'medium',
            proposals: [{ targetType: 'task_definition', targetId: 'build:1', rationale: 'add empty-input fixture' }],
          },
        ],
        evidence: [{ evidenceId: 'ev-1' }],
      })),
    },
  }
  return { ctx: ctx as never, approval }
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

describe('evolution tools', () => {
  it('evolution_propose registers manually and records a suggestion', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const result = (await tool.execute({ ...proposal }, exec('root-1'))) as string
    expect(result).toContain('proposal p1 registered [proposed] L2 task_definition build:1 (base v3)')
    expect(result).toContain('nothing was executed or changed')
    expect((await svc.get('p1')).status).toBe('proposed')
  })

  /**
   * The review's suggestion-only counterexample: the next-step line follows the
   * target type. A skill proposal is the one this build promotes, so it points
   * at evolution_candidate; any other target type is a recorded suggestion with
   * no next step at all, and no lifecycle entry is written for it.
   */
  it('evolution_propose points a skill replacement at evolution_candidate and no other proposal anywhere', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const suggestion = (await tool.execute(
      {
        proposalId: 'cap-suggestion',
        targetType: 'capability',
        targetId: 'research',
        baseVersion: '1',
        level: 'L2',
        rationale: 'record a suggestion',
        sourceRefs: ['diagnosis:d1'],
      },
      exec('root-1'),
    )) as string
    expect(suggestion).toContain('proposal cap-suggestion registered [proposed] L2 capability research (base 1)')
    expect(suggestion).toContain('stays a recorded suggestion')
    expect(suggestion).not.toContain('next: evolution_candidate')
    expect(suggestion).not.toContain('next: evolution_prepare')
    expect((await svc.get('cap-suggestion')).status).toBe('proposed')

    const replacement = (await tool.execute({ ...skillProposal }, exec('root-1'))) as string
    expect(replacement).toContain('next: evolution_candidate')

    // The next-step line is wording, not a lifecycle: either proposal's ledger
    // holds its own `proposed` line and nothing else.
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).toEqual(['proposed', 'proposed'])
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
  })

  it('evolution_propose transcribes from a recorded diagnosis and refuses mixed input', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const result = (await tool.execute(
      { proposalId: 'p1', level: 'L2', baseVersion: 'v3', fromDiagnosis: { diagnosisId: 'd1', proposalIndex: 0 } },
      exec('root-1'),
    )) as string
    expect(result).toContain('task_definition build:1')
    const saved = await svc.get('p1')
    expect(saved.rationale).toBe('add empty-input fixture')
    expect(saved.sourceRefs).toEqual(['diagnosis:d1'])
    await expect(
      tool.execute(
        { proposalId: 'p2', level: 'L2', baseVersion: 'v3', targetId: 'x', fromDiagnosis: { diagnosisId: 'd1', proposalIndex: 0 } },
        exec('root-1'),
      ),
    ).rejects.toThrow('do not pass both')
    const missing = (await tool.execute(
      { proposalId: 'p2', level: 'L2', baseVersion: 'v3' },
      exec('root-1'),
    ).catch((error: Error) => String(error))) as string
    expect(missing).toContain('required without fromDiagnosis')
  })

  it('evolution_propose rejects a targetType outside the frozen vocabulary', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const rejected = (await tool.execute(
      { ...proposal, targetType: 'prompt' },
      exec('root-1'),
    ).catch((error: Error) => String(error))) as string
    expect(rejected).toContain('targetType')
    expect(await svc.list()).toEqual([])
  })

  it('evolution tools reject a call carrying no agent identity', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await expect(defineEvolutionProposeTool(ctx).execute({ ...proposal }, {} as never)).rejects.toThrow('missing agent id')
    await expect(
      defineEvolutionCandidateTool(ctx).execute(
        { proposalId: 'p1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new') } },
        {} as never,
      ),
    ).rejects.toThrow('missing agent id')
    await expect(defineEvolutionPrepareTool(ctx).execute({ proposalId: 'p1' }, {} as never)).rejects.toThrow('missing agent id')
    expect(await svc.list()).toEqual([])
  })

  it('evolution_candidate and evolution_prepare move the skill proposal and stay ledger-only', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const candidate = (await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new') } },
      exec('root-1'),
    )) as string
    expect(candidate).toContain('[candidate] version set: taskDefinition=v3, verifier=v1')
    const prepared = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(prepared).toContain('[prepared] sandbox:')
    expect(prepared).toContain('next: evolution_replay')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('evolution_candidate refuses a non-skill proposal by name, recording nothing', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    const before = await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')
    const refused = (await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 'p1', versionSet: VERSION_SET, mutation: { baseVersion: 'v3', definition: { objective: 'x' } } },
      exec('root-1'),
    )) as string
    expect(refused).toContain('evolution_candidate rejected:')
    expect(refused).toContain('cannot become a candidate in this build')
    expect(await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('p1')).status).toBe('proposed')
  })

  it('evolution_gate rejects evidence refs unknown to the task store and the disk', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new') } },
      exec('root-1'),
    )
    await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    const result = (await defineEvolutionGateTool(ctx).execute(
      { proposalId: 's1', ...gateAnswers([reportPath, 'ev-ghost']) },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_gate rejected:')
    expect(result).toContain('ev-ghost')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('evolution_decide records only after a human approve through the native approval seam', async () => {
    // A skill candidate: the one target type whose PROMOTE this build grants.
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const { ctx, approval } = toolCtx(svc, 'allowed-once')
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new verify skill') } },
      exec('root-1'),
    )
    await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await defineEvolutionGateTool(ctx).execute({ proposalId: 's1', ...gateAnswers([reportPath]) }, exec('root-1'))
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE', note: 'looks right' },
      exec('root-1'),
    )) as string
    expect(approval.request).toHaveBeenCalledOnce()
    const request = approval.request.mock.calls[0]![0] as { reason: string; toolName: string }
    expect(request.toolName).toBe('evolution_decide')
    expect(request.reason).toContain('proposal s1')
    expect(request.reason).toContain(`3. Existing regression maintained? full suite replayed green [evidence: ${reportPath}]`)
    expect(request.reason).toContain('proposed decision: PROMOTE — looks right')
    expect(result).toContain('proposal s1 [decided] PROMOTE — looks right')
    expect(result).toContain('nothing applied yet; evolution_apply (second human gate) takes it to production')
    expect((await svc.get('s1')).status).toBe('decided')
    // the decided ledger line carries the approval call id, the applied/rolledback shape
    const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'decided', approvalRef: 'approval:call-1' })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'evolution_decide records nothing when the approval comes back %s',
    async outcome => {
      const { svc, skillRoot } = await serviceWithProduction()
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
      const { ctx, approval } = toolCtx(svc, outcome)
      await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
      await defineEvolutionCandidateTool(ctx).execute(
        { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new') } },
        exec('root-1'),
      )
      await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
      const { reportPath } = await recordSkillExperiment(svc, 's1')
      await defineEvolutionGateTool(ctx).execute({ proposalId: 's1', ...gateAnswers([reportPath]) }, exec('root-1'))
      const result = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 's1', decision: 'REJECT' }, exec('root-1'))) as string
      expect(approval.request).toHaveBeenCalledOnce()
      expect(result).toContain('no decision recorded')
      expect(result).toContain('stays gated')
      expect((await svc.get('s1')).status).toBe('gated')
      const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      expect(lines.map(line => (JSON.parse(line) as { kind: string }).kind).filter(kind => !kind.startsWith('experiment_')))
        .toEqual(['proposed', 'candidate', 'prepared', 'gated'])
    },
  )

  it('evolution_decide refuses a proposal that is not gated, without asking the human', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    const result = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 'p1', decision: 'REJECT' }, exec('root-1'))) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(result).toContain('is proposed; only a gated proposal can be decided')
  })

  it('evolution_list filters and renders derived history', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc, 'rejected')
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionProposeTool(ctx).execute(
      { ...proposal, proposalId: 'p2', targetType: 'verifier', targetId: 'verifier:1', level: 'L4', sourceRefs: ['evidence:ev-1'] },
      exec('root-1'),
    )
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('x') } }, exec('root-1'))
    const list = defineEvolutionListTool(ctx)
    const all = (await list.execute({}, exec('root-1'))) as string
    expect(all).toContain('evolution ledger (2):')
    expect(all).toContain('- p2 [proposed] L4 verifier verifier:1 (base v3)')
    expect(all).toContain('- s1 [candidate] L2 skill verify (base v1)')
    expect(all).toContain('history: proposed by root-1')
    const filtered = (await list.execute({ status: 'candidate' }, exec('root-1'))) as string
    expect(filtered).toContain('evolution ledger (1):')
    expect(filtered).toContain('s1')
    expect(filtered).not.toContain('p2')
    const byTarget = (await list.execute({ targetType: 'verifier' }, exec('root-1'))) as string
    expect(byTarget).toContain('evolution ledger (1):')
    expect(byTarget).toContain('p2')
  })
})


const skillProposal: ProposeInput = {
  proposalId: 's1',
  targetType: 'skill',
  targetId: 'verify',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the skill never mentions empty-input fixtures',
  sourceRefs: ['diagnosis:d1'],
}

const presetProposal: ProposeInput = {
  proposalId: 'pr1',
  targetType: 'agent_preset',
  targetId: 'bb-verify',
  baseVersion: 'v1',
  level: 'L3',
  rationale: 'the preset lacks the check skill',
  sourceRefs: ['diagnosis:d1'],
}

const capabilityProposal: ProposeInput = {
  proposalId: 'c1',
  targetType: 'capability',
  targetId: 'research',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'research needs the verify skill',
  sourceRefs: ['diagnosis:d1'],
}

const capabilityMutation = { name: 'research', entry: { preset: 'standard', skills: [CAPABILITY_FIXTURE_SKILL] } }

/** Service whose ledger root and production skills root all live in one fresh temp dir. */
async function serviceWithRoots() {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
  return { svc, dir, root, skillRoot }
}

/**
 * Install the production `SKILL.md` a prepare replaces. This build prepares a
 * replacement of an existing single-file skill only — a production target that
 * is not there is refused before any sandbox or ledger write — so every fixture
 * that walks to `prepared` needs one on disk first.
 */
async function requireProductionSkill(skillRoot: string): Promise<void> {
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# the production skill the candidate replaces\n')
}

describe('EvolutionService mutation schemas', () => {
  it('accepts the skill mutation — the only candidate mutation this build admits', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'new SKILL.md text' })
    expect((await svc.get('s1')).mutation).toEqual({ name: 'verify', content: 'new SKILL.md text' })
  })

  it.each([
    ['a name with a separator', { name: 'a/b', content: 'x' }, 'mutation.name'],
    ['a traversing name', { name: '..', content: 'x' }, 'mutation.name'],
    ['an empty content', { name: 'verify', content: ' ' }, 'mutation.content'],
    ['an unknown key', { name: 'verify', content: 'x', extra: 1 }, 'unknown key "extra"'],
  ])('rejects a skill mutation with %s', async (_label, mutation, message) => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await expect(svc.candidate('s1', VERSION_SET, 'root-1', mutation)).rejects.toThrow(message as string)
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('rejects a non-object mutation for the skill candidate', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    for (const mutation of ['text', ['x'], null]) {
      await expect(svc.candidate('s1', VERSION_SET, 'root-1', mutation)).rejects.toThrow('mutation must be an object')
    }
  })
})

/**
 * S4-E 收尾: the candidate lifecycle is a single-file skill replacement and
 * nothing else. `evolution_propose` (and a Diagnosis) may still record any
 * targetType as a suggestion, but a recorded suggestion never becomes a
 * candidate: the first durable write is refused by name, so no non-skill
 * proposal reaches a sandbox, an experiment or a promotion in this build
 * (§F.2; A6 introduces the capability evaluation). Non-skill proposals stay
 * `proposed` forever, which is the expected end state.
 */
describe('EvolutionService candidate admission is skill-only (S4-E 收尾)', () => {
  it.each([
    ['capability', capabilityProposal, capabilityMutation],
    ['agent_preset', presetProposal, { presetId: 'bb-verify', files: [{ path: 'preset.yml', content: 'x' }] }],
    ['task_definition', proposal, { baseVersion: 'v3', definition: { objective: 'new' } }],
  ] as const)('refuses a %s candidate by name, before the first ledger write', async (targetType, input, mutation) => {
    const svc = await service()
    await svc.propose(input, 'root-1')
    const before = await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')

    const message = await refusalOf(svc.candidate(input.proposalId, VERSION_SET, 'root-1', mutation))
    expect(message).toContain('cannot become a candidate in this build')
    expect(message).toContain(`"${targetType}"`)
    // Nothing was appended, nothing was materialized, and the proposal stays the
    // recorded suggestion it was.
    expect(await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    const proposalAfter = await svc.get(input.proposalId)
    expect(proposalAfter.status).toBe('proposed')
    expect(proposalAfter.mutation).toBeUndefined()
    expect(proposalAfter.history.map(entry => entry.status)).toEqual(['proposed'])
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
  })

  it('refuses a bookkeeping-only suggestion the same way, recording only the proposal', async () => {
    const svc = await service()
    await svc.propose({ ...proposal, proposalId: 'w1', targetType: 'workflow_policy', targetId: 'workflow:1' }, 'root-1')
    const message = await refusalOf(svc.candidate('w1', VERSION_SET, 'root-1', { sketch: 'free-form' }))
    expect(message).toContain('cannot become a candidate in this build')
    expect((await svc.get('w1')).status).toBe('proposed')
  })

  it('still lets a skill candidate carry the structured mutation', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    const recorded = await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    expect(recorded.status).toBe('candidate')
    expect(recorded.mutation).toEqual({ name: 'verify', content: skillText('x') })
  })
})


describe('EvolutionService prepared state machine', () => {
  it('walks candidate(mutation) → prepared → the recorded experiment → gated → decided for a skill candidate', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new') })
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.prepare('s1', 'root-1')
    const { reportPath, experimentId } = await recordSkillExperiment(svc, 's1')
    // The evaluation is the experiment family, not a lifecycle transition: the
    // proposal stays prepared, with a completed experiment beside it.
    expect((await svc.get('s1')).status).toBe('prepared')
    expect(experimentId).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.parse(await readFile(join(root, reportPath), 'utf8')).proposalId).toBe('s1')
    await svc.gate('s1', gateAnswers([evidenceFile, reportPath]), 'root-1')
    const decided = await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    expect(decided.status).toBe('decided')
    expect(decided.history.map(entry => entry.status)).toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided'])
  })

  it('rejects gate on a mutation-carrying candidate until it is prepared', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow(/cannot record "gated".*prepared/)
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('refuses a mutation-less candidate, and a repeated prepare', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# the production skill this candidate replaces\n')
    await svc.propose(skillProposal, 'root-1')
    // §F.2: no shell flow. A candidate carrying nothing to materialize and
    // evaluate is refused before the first candidate line, so no later entry
    // has anything to reach.
    await expect(svc.candidate('s1', VERSION_SET, 'root-1', undefined)).rejects.toThrow('mutation must be an object')
    expect((await svc.get('s1')).status).toBe('proposed')
    await svc.propose({ ...skillProposal, proposalId: 's2' }, 'root-1')
    await svc.candidate('s2', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s2', 'root-1')
    await expect(svc.prepare('s2', 'root-1')).rejects.toThrow('cannot record "prepared"')
  })
})

describe('EvolutionService sandbox materialization', () => {
  it('materializes a skill mutation and snapshots the champion SKILL.md', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old skill text')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new skill text') })
    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.status).toBe('prepared')
    expect(prepared.prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      // P2: the identity is the SHA-256 of the exact materialized bytes
      skillContent: { name: 'verify', sha256: createHash('sha256').update(skillText('new skill text'), 'utf8').digest('hex') },
      // P3: the production baseline digest, from the same read as the snapshot
      skillBaseline: { name: 'verify', sha256: createHash('sha256').update('old skill text', 'utf8').digest('hex') },
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
    })
    expect(await readFile(join(root, 'sandbox', 's1', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('new skill text'))
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe('old skill text')
  })

  it('refuses a prepare whose production skill does not exist, writing nothing', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('new') })
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    // §F.2: this build prepares and promotes a replacement of an existing
    // single-file SKILL.md. A target that is not there has nothing to replace,
    // so it is refused before any sandbox or ledger write — the rejection names
    // the missing production file.
    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow(
      /production skill .*verify\/SKILL\.md" does not exist/,
    )
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
  })

  it('confines every write to the sandbox dir; production roots stay untouched', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old skill text')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new skill text') })
    await svc.prepare('s1', 'root-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('old skill text')
    expect((await readdir(root)).sort()).toEqual(['proposals.jsonl', 'sandbox'])
    expect(await readdir(join(root, 'sandbox'))).toEqual(['s1'])
  })

  it('rejects an unsafe proposalId at prepare time, writing nothing', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose({ ...skillProposal, proposalId: '../escape' }, 'root-1')
    await svc.candidate('../escape', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(svc.prepare('../escape', 'root-1')).rejects.toThrow('proposalId')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect((await svc.get('../escape')).status).toBe('candidate')
  })
})

describe('EvolutionService fold on read-back', () => {
  it('replays a ledger with prepared records to the same fold as the live service', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new') })
    await svc.prepare('s1', 'root-1')
    const live = await svc.list()
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    expect(await reopened.list()).toEqual(live)
    expect((await reopened.get('s1')).prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      // P2: the content identity survives the reopen unchanged
      skillContent: { name: 'verify', sha256: createHash('sha256').update(skillText('new'), 'utf8').digest('hex') },
      // P3: and so does the production baseline digest
      skillBaseline: { name: 'verify', sha256: createHash('sha256').update('old', 'utf8').digest('hex') },
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
    })
  })

  it('fails loud when a prepared record lies about mechanical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    const forged = { formatVersion: 2, kind: 'prepared', proposalId: 's1', sandbox: 'sandbox/s1', mechanical: false, champion: 'captured', files: ['x'], actor: 'x', at: 'now' }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('mechanical')
  })

  it('fails loud on a forged candidate or gated record: the fold reruns the write-path payload checks', async () => {
    // an empty version set would never survive candidate() — and a candidate is
    // only a skill candidate here, so the forged line rides a skill proposal
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    const forgedCandidate = {
      formatVersion: 2, kind: 'candidate', proposalId: 's1', versionSet: {},
      mutation: { name: 'verify', content: skillText('x') }, actor: 'x', at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forgedCandidate)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('at least one version')

    // an empty gate answer would never survive gate()
    const root2 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot2 = join(root2, 'skills')
    await mkdir(join(skillRoot2, 'verify'), { recursive: true })
    await writeFile(join(skillRoot2, 'verify', 'SKILL.md'), '# the production skill the candidate replaces\n')
    const svc2 = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root: root2, skillRoot: skillRoot2 })
    await svc2.propose(skillProposal, 'root-1')
    await svc2.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    // A gated record is legal only after the one transition a candidate admits,
    // so the live entries walk to prepared and the forged line lands on top.
    await svc2.prepare('s1', 'root-1')
    const emptyAnswer = { formatVersion: 2, kind: 'gated', proposalId: 's1', gate: { ...gateAnswers(['ev-1']), targetFailureFixed: '' }, actor: 'x', at: 'now' }
    await writeFile(join(root2, 'proposals.jsonl'), `${JSON.stringify(emptyAnswer)}\n`, { flag: 'a' })
    const reopened2 = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root: root2, skillRoot: skillRoot2 })
    await expect(reopened2.list()).rejects.toThrow('Target failure fixed')

    // zero regression evidence refs would never survive gate() either
    const root3 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot3 = join(root3, 'skills')
    await mkdir(join(skillRoot3, 'verify'), { recursive: true })
    await writeFile(join(skillRoot3, 'verify', 'SKILL.md'), '# the production skill the candidate replaces\n')
    const svc3 = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root: root3, skillRoot: skillRoot3 })
    await svc3.propose(skillProposal, 'root-1')
    await svc3.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc3.prepare('s1', 'root-1')
    const noEvidence = { formatVersion: 2, kind: 'gated', proposalId: 's1', gate: gateAnswers([]), actor: 'x', at: 'now' }
    await writeFile(join(root3, 'proposals.jsonl'), `${JSON.stringify(noEvidence)}\n`, { flag: 'a' })
    const reopened3 = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root: root3, skillRoot: skillRoot3 })
    await expect(reopened3.list()).rejects.toThrow('at least one evidence ref')
  })
})


describe('evolution_prepare tool', () => {
  it('evolution_candidate accepts a structured skill mutation and points at evolution_prepare', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const result = (await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: { skill: 'v2' }, mutation: { name: 'verify', content: skillText('# new') } },
      exec('root-1'),
    )) as string
    expect(result).toContain('[candidate] version set: skill=v2')
    expect(result).toContain('next: evolution_prepare')
    expect((await svc.get('s1')).mutation).toEqual({ name: 'verify', content: skillText('# new') })
  })

  it('evolution_candidate surfaces a schema violation without recording', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const result = (await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'a/b', content: 'x' } },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_candidate rejected:')
    expect(result).toContain('mutation.name')
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('evolution_prepare materializes the skill candidate and snapshots the champion SKILL.md', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new') } },
      exec('root-1'),
    )
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('proposal s1 [prepared]')
    expect(result).toContain('wrote skills/verify/SKILL.md')
    expect(result).toContain('champion snapshot: captured under champion/')
    expect(result).toContain('production baseline: verify sha256:')
    expect(result).toContain('production was not touched')
    expect(await readFile(join(svc.root, 'sandbox', 's1', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('# new'))
    expect(await readFile(join(svc.root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
  })

  it('evolution_prepare refuses a production skill that does not exist, writing nothing', async () => {
    const { svc, root } = await serviceWithRoots()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new') } },
      exec('root-1'),
    )
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('evolution_prepare rejected:')
    expect(result).toContain('does not exist')
    // No sandbox and no ledger line: the refusal lands before the first write.
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('evolution_prepare rejects an unknown proposal, and a candidate the entry never accepted', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionPrepareTool(ctx)
    const missing = (await tool.execute({ proposalId: 'ghost' }, exec('root-1'))) as string
    expect(missing).toContain('evolution_prepare rejected:')
    expect(missing).toContain('unknown proposal "ghost"')
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    // The candidate tool's schema makes `mutation` required, so a call carrying
    // none is refused before the tool body runs and never reaches the ledger —
    // there is no candidate line for prepare to act on.
    await expect(
      defineEvolutionCandidateTool(ctx).execute({ proposalId: 's1', versionSet: VERSION_SET }, exec('root-1')),
    ).rejects.toThrow('missing required property "mutation"')
    expect((await svc.get('s1')).status).toBe('proposed')
    const result = (await tool.execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('cannot record "prepared"')
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('evolution_gate rejects a mutation-carrying candidate until it is prepared', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new') } },
      exec('root-1'),
    )
    const result = (await defineEvolutionGateTool(ctx).execute({ proposalId: 's1', ...gateAnswers(['ev-1']) }, exec('root-1'))) as string
    expect(result).toContain('cannot record "gated"')
    expect(result).toContain('evolution_prepare')
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('evolution_list renders the prepared status with sandbox path and champion state', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'verify', content: skillText('# new') } },
      exec('root-1'),
    )
    await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const list = defineEvolutionListTool(ctx)
    const all = (await list.execute({}, exec('root-1'))) as string
    expect(all).toContain('- s1 [prepared] L2 skill verify (base v1)')
    expect(all).toContain('mutation: skill mutation recorded')
    expect(all).toContain(`sandbox: ${svc.root}/sandbox/s1 (2 files, champion snapshot captured`)
    expect(all).not.toContain('mechanical')
    expect(all).not.toContain('champion: null')
    expect(all).toContain('history: proposed by root-1')
    const filtered = (await list.execute({ status: 'prepared' }, exec('root-1'))) as string
    expect(filtered).toContain('evolution ledger (1):')
    const gated = (await list.execute({ status: 'gated' }, exec('root-1'))) as string
    expect(gated).toBe('evolution ledger: no proposals match')
  })
})


describe('EvolutionService: the two-sided experiment is the gate evidence', () => {
  it('requires the gate of a skill candidate to cite its experiment report, and the report to still exist', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await requireProductionSkill(skillRoot)
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await expect(svc.gate('s1', gateAnswers([evidenceFile]), 'root-1'))
      .rejects.toThrow(`must cite its experiment report "${reportPath}"`)
    await svc.gate('s1', gateAnswers([evidenceFile, reportPath]), 'root-1')
    expect((await svc.get('s1')).status).toBe('gated')
  })

  it('fails the gate when the experiment report was deleted after the experiment', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    const { rm } = await import('node:fs/promises')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await requireProductionSkill(skillRoot)
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await rm(join(root, reportPath))
    await expect(svc.gate('s1', gateAnswers([reportPath]), 'root-1'))
      .rejects.toThrow('no longer exists under the ledger root')
  })

  it('gates a skill candidate on a completed experiment only', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await requireProductionSkill(skillRoot)
    await svc.prepare('s1', 'root-1')
    await expect(svc.gate('s1', gateAnswers(['sandbox/s1/replay-report.json']), 'root-1'))
      .rejects.toThrow('has no two-sided experiment')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('folds a ledger holding a recorded experiment back to the same view after reopen', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s1', 'root-1')
    await recordSkillExperiment(svc, 's1')
    const live = await svc.list()
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    expect(await reopened.list()).toEqual(live)
    // The evaluation is not a lifecycle transition: the proposal is prepared, and
    // the experiment family folds back beside it.
    expect((await reopened.get('s1')).status).toBe('prepared')
    expect((await reopened.experiments('s1')).map(view => view.experimentId)).toHaveLength(1)
  })

})

describe('replay comparison', () => {
  const base = { taskId: 't1', outcome: 'verified' as const, criteria: [{ criterionId: 'ac1', verdict: 'pass' as const }] }

  it('matching sides compare not-worse with verdictMatch', () => {
    const result = compareReplaySides(base, { ...base })
    expect(result).toEqual({ verdictMatch: true, criteriaDiff: [], relation: 'not-worse' })
  })

  it('a failed candidate against a verified champion is worse', () => {
    const result = compareReplaySides(base, { ...base, outcome: 'failed', criteria: [{ criterionId: 'ac1', verdict: 'fail' }] })
    expect(result.relation).toBe('worse')
    expect(result.verdictMatch).toBe(false)
    expect(result.criteriaDiff).toEqual([{ criterionId: 'ac1', champion: 'pass', candidate: 'fail' }])
  })

  it('a shared criterion flipping pass → fail is a regression even when the outcome holds', () => {
    const result = compareReplaySides(
      { ...base, criteria: [{ criterionId: 'ac1', verdict: 'pass' }, { criterionId: 'ac2', verdict: 'fail' }] },
      { ...base, outcome: 'failed', criteria: [{ criterionId: 'ac1', verdict: 'fail' }, { criterionId: 'ac2', verdict: 'fail' }] },
    )
    // failed vs failed ranks equal, but ac1 flipped pass → fail
    expect(result.relation).toBe('worse')
  })

  it('a candidate fixing a failed champion is not-worse', () => {
    const champion = { taskId: 't1', outcome: 'failed' as const, criteria: [{ criterionId: 'ac1', verdict: 'fail' as const }] }
    const result = compareReplaySides(champion, { taskId: 't1', outcome: 'verified', criteria: [{ criterionId: 'ac1', verdict: 'pass' }] })
    expect(result.relation).toBe('not-worse')
    expect(result.verdictMatch).toBe(false)
  })

  it('an added criterion makes the contract comparison inconclusive', () => {
    const result = compareReplaySides(base, { ...base, criteria: [{ criterionId: 'ac1', verdict: 'pass' }, { criterionId: 'ac2', verdict: 'pass' }] })
    expect(result.relation).toBe('inconclusive')
    expect(result.verdictMatch).toBe(false)
    expect(result.criteriaDiff).toEqual([{ criterionId: 'ac2', candidate: 'pass' }])
  })

  it('a cancelled candidate run is inconclusive, not worse', () => {
    const result = compareReplaySides(base, { ...base, outcome: 'cancelled' as const })
    expect(result.relation).toBe('inconclusive')
  })
})

/** A terminal champion task plus its review record, as the replay tool's store fixture. */
const championTask = {
  taskId: 't-champ',
  definitionRef: { taskType: 'subtask', version: 1 },
  parentTaskId: 't-parent',
  objective: 'champion objective',
  depth: 1,
  acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'works', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
  requestedCapabilities: ['research'],
  decompositionStatus: 'leaf',
  status: 'verified',
  runIds: ['r-champ'],
  childTaskIds: [],
}
const championReview = {
  taskId: 't-champ',
  runId: 'r-champ',
  sessionId: 's-champ',
  outcome: 'verified',
  evidenceRefs: ['ev-champ'],
  anomalies: [],
  durationMs: 42,
  criteria: [{ criterionId: 'ac1-1', verdict: 'pass', command: 'true', exitCode: 0 }],
}

/**
 * A skill candidate prepared against a production `SKILL.md`, plus the caller
 * workspace and the store the two-sided experiment reads. The replay mock
 * records each side the way the store would: the baseline fails the criterion
 * the production bytes cannot satisfy, the candidate (the side carrying the
 * sandbox overlay) passes every criterion.
 *
 * The ledger service is built on *this* fixture's context, not the v1 stubs':
 * the experiment resolves its graph, store and runtime from the service's own
 * context, so the same object carries them for the tool above it.
 */
async function preparedSkillExperiment(options: { candidate?: string; production?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const workspace = join(root, 'env')
  const store = experimentStore()
  let replayed = 0
  const replayTask = vi.fn(async (
    _storeId: string,
    championTaskId: string,
    replayOptions: ReplayTaskOptions,
    _caller: string,
  ) => {
    replayed += 1
    const taskId = `t-replay-${replayed}`
    const runId = `r-replay-${replayed}`
    const criterionId = championTaskId === 't-fail' ? 'ac-fix' : 'ac-holdout'
    const candidateSide = replayOptions.overlay !== undefined
    const outcome = candidateSide || criterionId !== 'ac-fix' ? 'verified' as const : 'failed' as const
    store.settle(taskId, runId, criterionId, outcome, String(replayOptions.lineage))
    return {
      taskId,
      runId,
      status: outcome,
      durationMs: 3,
      criteria: [{ criterionId, verdict: outcome === 'verified' ? 'pass' as const : 'fail' as const, verifierId: FIXTURE_JUDGE.ref, verifierVersion: FIXTURE_JUDGE.version }],
    }
  })
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    approval: { request: vi.fn(async () => 'allowed-once') },
    graphs: { graphForSession: vi.fn(async () => graph) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    taskRuntime: {
      listCapabilities: vi.fn(() => ({ research: { preset: 'standard' } })),
      // The runtime's own pre-check the freeze reads the provider identity from
      // (S4-E §Q3): the fixture's production configuration resolves no rows.
      capabilityProviderReport: vi.fn(async () => ({ capabilities: [], revision: FIXTURE_REGISTRY_REVISION })),
      replayTask,
      workspacePathFor: vi.fn(async () => workspace),
    },
    task: { openStore: vi.fn(async () => store.snapshot()) },
    verifier: {
      ready: async () => {},
      verifierIds: () => [...VERIFIER_VOCABULARY],
      verifierVersions: () => Object.fromEntries(VERIFIER_VOCABULARY.map(id => [id, FIXTURE_JUDGE.version])),
    },
    sessionQuery: {
      readSession: async (sessionId: string) => {
        const events = store.sessions.get(sessionId)
        if (events === undefined) throw new Error(`missing session ${sessionId}`)
        return { session: { id: sessionId }, inheritedEventCount: 0, events }
      },
    },
  }
  const svc = new EvolutionService(ctx as never, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
  Object.assign(ctx, { evolution: svc })
  const production = options.production ?? '# old verify skill\n'
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(join(skillRoot, 'verify', 'SKILL.md'), production)
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n')
  await svc.propose(skillProposal, 'root-1')
  await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: options.candidate ?? SKILL_CANDIDATE })
  const identity = (await svc.prepare('s1', 'root-1')).prepared!.skillContent!
  return {
    svc,
    root,
    skillRoot,
    workspace,
    identity,
    store,
    replayTask,
    replayTool: defineEvolutionReplayTool(ctx as never),
    experiment: { workspace, identity },
  }
}

/**
 * The recursive content digest of a directory holding exactly `entries`, as the
 * experiment defines its input snapshot: `<relative path>\0<sha256>` lines,
 * sorted by path, hashed together. Computed here, so the frozen identity is
 * never confirmed against the implementation that produced it.
 */
function snapshotDigest(entries: Record<string, string>): string {
  const lines = Object.entries(entries)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([rel, bytes]) => `${rel}\0${createHash('sha256').update(bytes).digest('hex')}`)
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

/** Tool context whose taskRuntime.replayTask is a mock and whose store holds the champion fixture. */
function replayToolCtx(svc: EvolutionService, replayTask: ReturnType<typeof vi.fn>) {
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    evolution: svc,
    approval: { request: vi.fn(async () => 'allowed-once') },
    graphs: { graphForSession: vi.fn(async () => graph) },
    taskRuntime: {
      listCapabilities: vi.fn(() => ({ research: { preset: 'standard' } })),
      replayTask,
    },
    task: {
      openStore: vi.fn(async () => ({
        tasks: [championTask],
        reviews: [championReview],
        diagnoses: [], obligations: [],
        evidence: [{ evidenceId: 'ev-champ' }],
      })),
    },
  }
  return { ctx: ctx as never }
}

/** One terminal sample task and its review record, as the two-sided experiment's store holds them. */
function sampleCase(taskId: string, runId: string, criterionId: string, outcome: 'verified' | 'failed') {
  return {
    task: {
      taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: 't-parent',
      objective: `${taskId} objective`,
      depth: 1,
      acceptanceCriteria: [{
        criterionId,
        description: 'works',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
        verifierRef: FIXTURE_JUDGE.ref,
      }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: outcome,
      runIds: [runId],
      childTaskIds: [],
    },
    run: { runId, taskId, sessionId: `s-${taskId}`, status: outcome, startedAt: '2026-09-26T00:00:00.000Z' },
    review: {
      taskId,
      runId,
      sessionId: `s-${taskId}`,
      outcome,
      evidenceRefs: [`ev-${taskId}`],
      anomalies: [],
      ...(outcome === 'failed' ? { localizedCause: 'the fixture case failed' } : {}),
      criteria: [{
        criterionId,
        verdict: outcome === 'verified' ? 'pass' : 'fail',
        verifierId: FIXTURE_JUDGE.ref,
        verifierVersion: FIXTURE_JUDGE.version,
      }],
    },
  }
}

const FAILED_SAMPLE = sampleCase('t-fail', 'r-fail', 'ac-fix', 'failed')
const HOLDOUT_SAMPLE = sampleCase('t-holdout', 'r-holdout', 'ac-holdout', 'verified')
const REGRESSION_SAMPLE = sampleCase('t-regression', 'r-regression', 'ac-keep', 'verified')

/**
 * A store the experiment can walk: the samples the caller names, and the side
 * each replay settles, appended the way the store itself would have recorded it
 * (the orchestrator re-reads the store after every run and records what it
 * finds there, so a fixture that did not append would record nothing).
 */
function experimentStore() {
  const sessions = new Map<string, unknown[]>()
  interface Row { [key: string]: unknown }
  const tasks: Row[] = [championTask, FAILED_SAMPLE.task as Row, HOLDOUT_SAMPLE.task as Row, REGRESSION_SAMPLE.task as Row]
  const runs: Row[] = [FAILED_SAMPLE.run as Row, HOLDOUT_SAMPLE.run as Row, REGRESSION_SAMPLE.run as Row]
  const reviews: Row[] = [championReview, FAILED_SAMPLE.review as Row, HOLDOUT_SAMPLE.review as Row, REGRESSION_SAMPLE.review as Row]
  return {
    sessions,
    snapshot: () => ({ tasks: [...tasks], runs: [...runs], reviews: [...reviews], diagnoses: [], obligations: [], evidence: [] }),
    /**
     * Record one side a replay settled: task, run and the terminal review the
     * report reads, plus the two durable facts the promotion gate re-reads
     * (S4-E §Q3) — the run's provider binding, and the request its session log
     * records.
     */
    settle(taskId: string, runId: string, criterionId: string, outcome: 'verified' | 'failed', lineage: string, request?: { provider: string; model: string }) {
      const settled = sampleCase(taskId, runId, criterionId, outcome)
      tasks.push({ ...settled.task, parentTaskId: undefined, objective: `[${lineage}] ${taskId}` })
      runs.push({
        ...(settled.run as Row),
        providerBinding: { registryRevision: FIXTURE_REGISTRY_REVISION, capabilities: [], skills: [], mcpServers: [] },
      })
      const selection = request ?? { provider: FIXTURE_SELECTION.provider, model: FIXTURE_SELECTION.model }
      sessions.set(String((settled.run as { sessionId?: unknown }).sessionId), [{
        type: 'request/header',
        seq: 1,
        time: 0,
        data: { header: { config: selection }, reason: 'initial' },
      }])
      reviews.push(settled.review as Row)
    },
  }
}

const replayOutcome = {
  taskId: 't-cand',
  runId: 'r-cand',
  status: 'verified' as const,
  durationMs: 5,
  criteria: [{ criterionId: 'ac1-1', verdict: 'pass' as const, command: 'true', exitCode: 0 }],
}

describe('evolution_replay tool', () => {
  it('rejects an unknown proposal, running nothing', async () => {
    const svc = await service()
    const replayTask = vi.fn(async () => ({ ...replayOutcome }))
    const { ctx } = replayToolCtx(svc, replayTask)
    const tool = defineEvolutionReplayTool(ctx)
    const missing = (await tool.execute({ proposalId: 'ghost', taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(missing).toContain('unknown proposal "ghost"')
    expect(replayTask).not.toHaveBeenCalled()
  })

  it('refuses a non-skill proposal by name: no run, no sandbox and no ledger write', async () => {
    const svc = await service()
    const replayTask = vi.fn(async () => ({ ...replayOutcome }))
    const { ctx } = replayToolCtx(svc, replayTask)
    const tool = defineEvolutionReplayTool(ctx)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    const before = await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')

    const refused = (await tool.execute({ proposalId: 'c1', taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(refused).toContain('evolution_replay rejected:')
    expect(refused).toContain('"capability"')
    expect(refused).toMatch(/single-file SKILL\.md candidate/)
    // A refused call runs nothing and writes nothing: the tool is the model's
    // entry, so a target type with no evaluator must not reach the experiment.
    expect(replayTask).not.toHaveBeenCalled()
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
    expect(await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('c1')).status).toBe('proposed')
  })

  it('walks a skill candidate through the two-sided experiment: four sides, the sandbox overlay only on the candidate side', async () => {
    const { svc, root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    const result = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'], budget: { maxTokens: 5_000, note: 'the fixture budget' } },
      exec('root-1'),
    )) as string

    // The answer renders the experiment: both sides of every sample, and the
    // baseline named as this experiment's own new run.
    expect(result).toContain('proposal s1 [experiment] skill verify — verdict: fixed')
    expect(result).toContain('t-fail [observed-failure] baseline failed → candidate verified (ac-fix fail→pass) — fixed')
    expect(result).toContain('t-holdout [holdout] baseline verified → candidate verified (no criterion diff) — maintained')
    expect(result).toContain('report: sandbox/s1/exp-')
    expect(result).not.toContain('champion')

    // Four runs: every sample twice, the baseline under the production
    // configuration and the candidate under the sandbox's skills dir.
    expect(replayTask).toHaveBeenCalledTimes(4)
    const sides = replayTask.mock.calls.map(call => [call[1], call[2].overlay === undefined ? 'baseline' : 'candidate'])
    expect(sides).toEqual([
      ['t-fail', 'baseline'], ['t-fail', 'candidate'],
      ['t-holdout', 'baseline'], ['t-holdout', 'candidate'],
    ])
    for (const [storeId, _sample, options, caller] of replayTask.mock.calls.map(call => call as unknown as [string, string, ReplayTaskOptions, string])) {
      expect(storeId).toBe('sg-t-root-1')
      expect(caller).toBe('root-1')
      expect(options.workspace?.path).toContain(join('sandbox', 's1'))
      expect(options.lineage).toContain('evolution-experiment:')
    }
    for (const call of replayTask.mock.calls.filter(call => call[2].overlay !== undefined)) {
      expect(call[2].overlay).toEqual({ extraSkillRoots: [join(root, 'sandbox', 's1', 'skills')] })
    }

    // The frozen block binds what ran: the candidate bytes, the production
    // baseline, the roles, the snapshot both workspaces were built from, the
    // structured model selection and the budget the call named.
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const started = lines.find(line => line.kind === 'experiment_started') as { frozen: Record<string, any> }
    expect(started.frozen.candidate).toEqual(experiment.identity)
    expect(started.frozen.productionBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update('# old verify skill\n', 'utf8').digest('hex'),
    })
    expect(started.frozen.samples.map((sample: { taskId: string; role: string }) => [sample.taskId, sample.role]))
      .toEqual([['t-fail', 'observed-failure'], ['t-holdout', 'holdout']])
    expect(started.frozen.snapshot.sourceDir).toBe(experiment.workspace)
    expect(started.frozen.snapshot.digest).toBe(snapshotDigest({ 'input.txt': 'the frozen input\n' }))
    expect(started.frozen.model).toEqual(FIXTURE_SELECTION)
    expect(started.frozen.budget).toEqual({ maxTokens: 5_000, note: 'the fixture budget' })
    expect(started.frozen.overlay.baseline).toContain('none')
    expect(started.frozen.overlay.candidate).toBe('extraSkillRoots: [sandbox/s1/skills]')
    expect(lines.filter(line => line.kind === 'experiment_sample')).toHaveLength(4)

    // The proposal lifecycle does not move: a skill experiment is evidence, and
    // what may be promoted from it is the promotion gate's question.
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('refuses the removed experiment wall clock at the service and at the tool, before any write or run', async () => {
    const { svc, root, replayTask, replayTool, workspace } = await preparedSkillExperiment()
    const ledgerBefore = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    // A direct service call carries the removed field: the freeze refuses it by
    // name rather than running the experiment without the window it named.
    const message = await refusalOf(svc.runExperiment({
      proposalId: 's1',
      samples: [
        { taskId: 't-fail', role: 'observed-failure' },
        { taskId: 't-holdout', role: 'holdout' },
      ],
      snapshot: { sourceDir: workspace },
      model: FIXTURE_SELECTION,
      budget: { wallTimeMs: 60_000 } as never,
      repetition: 0,
    }, 'root-1' as never, 'root-1'))
    expect(message).toContain('wallTimeMs')
    expect(message).toMatch(/removed/)

    // The model's own entry refuses it at the schema boundary — the field is no
    // longer declared, so the call never reaches the service — and neither call
    // left a ledger line or started a run.
    const answer = await refusalOf(replayTool.execute({
      proposalId: 's1',
      taskIds: ['t-fail'],
      holdoutTaskIds: ['t-holdout'],
      budget: { wallTimeMs: 60_000 },
    }, exec('root-1')))
    expect(answer).toContain('budget.wallTimeMs')
    expect(answer).toContain('not a declared property')
    expect(replayTask).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(ledgerBefore)
  })

  it('reuses every settled side when the same skill call is repeated: no run, no new ledger line', async () => {
    const { root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    const first = (await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))) as string
    expect(replayTask).toHaveBeenCalledTimes(4)

    const second = (await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))) as string
    expect(second).toBe(first)
    expect(replayTask).toHaveBeenCalledTimes(4)
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string })
    expect(lines.filter(line => line.kind === 'experiment_started')).toHaveLength(1)
    expect(lines.filter(line => line.kind === 'experiment_sample')).toHaveLength(4)

    // A higher repetition is the explicit new experiment §F.2 allows: four new
    // sides under its own frozen block.
    const third = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'], repetition: 1 },
      exec('root-1'),
    )) as string
    expect(third).not.toBe(first)
    expect(third).toContain('repetition 1')
    expect(replayTask).toHaveBeenCalledTimes(8)
    expect(experiment.identity.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('refuses a skill call with no failed sample or with an empty holdout, running nothing', async () => {
    const { root, replayTask, replayTool } = await preparedSkillExperiment()
    const noFailure = (await replayTool.execute({ proposalId: 's1', taskIds: ['t-regression'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))) as string
    expect(noFailure).toContain('evolution_replay rejected:')
    expect(noFailure).toContain('no observed failure for this candidate to fix')

    const noHoldout = (await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'] }, exec('root-1'))) as string
    expect(noHoldout).toContain('holdoutTaskIds must name at least one task that did not select this candidate')

    expect(replayTask).not.toHaveBeenCalled()
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string })
    expect(lines.map(line => line.kind)).toEqual(['proposed', 'candidate', 'prepared'])
  })

})


/* ------------------------------------------------------------------ */
/* W16: decided(PROMOTE) → applied → rolledback — the apply/rollback   */
/* mechanism with its own human-approval gate (guide §2.7.7/§2.9.2).   */
/* ------------------------------------------------------------------ */

/** Two-document config.yml fixture; document 2 carries a decoy `research:` row to prove edits never cross the `---`. */
const CONFIG_FIXTURE = [
  '# Copy to config.yml, fill values.',
  '# Document 1: the profile patch list.',
  '- id: github-bot',
  '  config:',
  '    orgs: {}',
  '',
  '# Singularity task runtime row.',
  '- id: task-runtime',
  '  config:',
  '    # capability name → skills / tool labels / agent preset',
  '    capabilities:',
  '      design-chip: { skills: [chip-designer] }',
  '      research: { preset: standard }',
  '    defaultPreset: standard',
  '',
  '---',
  '# Document 2: the api block.',
  'api:',
  '  upstream: https://example.invalid',
  '  key: sk-test',
  '  research: { preset: decoy }',
  '',
].join('\n')

/**
 * Service whose ledger root, production skills root and config.yml fixture all
 * live in one fresh temp dir. The config fixture is a file on disk the
 * capability-era paths used to read; the service no longer knows about it, so
 * the cases that assert "nothing wrote config.yml" read the same local path.
 */
async function serviceWithProduction() {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const configFile = join(dir, 'config.yml')
  await writeFile(configFile, CONFIG_FIXTURE)
  const home = await installCapabilityFixtureSkill(dir)
  const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
  return { svc, dir, root, skillRoot, configFile, home }
}

/**
 * Install the one skill the capability fixtures' rows grant, in a pinned skill
 * home, and point `$DSH_HOME` / `$HOME` at it: the promotion check that judges a
 * capability row discovers the row's skills from the harness process's own roots
 * (S1-C item 3), so the copy this suite wrote has to be the one it finds — not
 * whatever the machine running the suite happens to have installed. The skill
 * declares no sidecar: loadable guidance, which carries no execution claim and
 * therefore no verifier or tool requirement for the row's tests to satisfy.
 */
async function installCapabilityFixtureSkill(dir: string): Promise<string> {
  const home = join(dir, 'home')
  const directory = join(home, 'skills', CAPABILITY_FIXTURE_SKILL)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    `---\nname: ${CAPABILITY_FIXTURE_SKILL}\ndescription: the skill a capability fixture row grants\n---\n\n# ${CAPABILITY_FIXTURE_SKILL}\n`,
  )
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
  return home
}

/**
 * Record one completed two-sided experiment for a prepared skill proposal: the
 * two frozen samples, the four settled sides with the store rows that back
 * them, the ledger's experiment lines and the report on disk — the shape
 * `evolution_replay` writes, composed here so a test about a later stage (the
 * gate, decide, apply, rollback) starts from evidence that already stands.
 *
 * The real orchestration — the tool, the runtime, the verifier and the store —
 * is proven in `evolution/tests/unit/skill-promotion-gate.spec.ts` and in
 * `tests/integration/evolution-replay-experiment.spec.ts`; this helper is for the
 * stages after it. `failure`/`holdout` let a case pick the sides' settlements;
 * the default is a clean fix (the failure reproduced on the baseline and fixed
 * by the candidate, the holdout maintained).
 */
async function recordSkillExperiment(
  svc: EvolutionService,
  proposalId = 's1',
  options: { failure?: { baseline?: string; candidate?: string }; holdout?: { baseline?: string; candidate?: string }; budget?: Record<string, unknown> } = {},
): Promise<{ reportPath: string; experimentId: string }> {
  const proposal = await svc.get(proposalId)
  const candidate = proposal.prepared!.skillContent!
  const baseline = proposal.prepared!.skillBaseline!
  const rows = promotionRows(svc)
  const workspace = join(await mkdtemp(join(tmpdir(), 'evolution-promotion-')), 'env')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n')
  const samples: FrozenSample[] = []
  const sample = (taskId: string, role: FrozenSample['role'], criterionId: string, command: string, outcome: 'verified' | 'failed') => {
    const acceptanceCriteria = [{
      criterionId,
      description: 'works',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command,
      verifierRef: FIXTURE_JUDGE.ref,
    }]
    rows.tasks.push({
      taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      parentTaskId: 't-parent',
      objective: `${taskId} objective`,
      depth: 1,
      acceptanceCriteria,
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: outcome,
      runIds: [`r-history-${taskId}`],
      childTaskIds: [],
    })
    samples.push({
      taskId,
      role,
      contractDigest: digestOf({ objective: `${taskId} objective`, acceptanceCriteria, requiredCapabilities: [] }),
      criteria: [{
        criterionId,
        verificationMode: 'deterministic',
        command,
        protectedInputsDigest: protectedInputsDigest([]),
        verifierRef: FIXTURE_JUDGE.ref,
        verifierVersion: FIXTURE_JUDGE.version,
        verifierAnchor: `registered verifier "${FIXTURE_JUDGE.ref}" declares version "${FIXTURE_JUDGE.version}"`,
      }],
      observed: { outcome, runId: `r-history-${taskId}` },
      provider: fixtureProviderIdentity(),
    })
  }
  sample('t-fail', 'observed-failure', 'ac-fix', 'test -f fix.txt', 'failed')
  sample('t-holdout', 'holdout', 'ac-holdout', 'test -f holdout.txt', 'verified')
  const frozen: FrozenExperiment = {
    proposalId,
    repetition: 0,
    candidate,
    productionBaseline: baseline,
    model: FIXTURE_SELECTION,
    budget: { ...(options.budget ?? {}) },
    samples,
    snapshot: { sourceDir: workspace, digest: await directoryDigest(workspace) },
    comparerVersion: EXPERIMENT_COMPARER_VERSION,
    overlay: { baseline: 'none', candidate: `extraSkillRoots: [sandbox/${proposalId}/skills]` },
  }
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(proposalId, frozenDigest)
  const reportPath = experimentReportPath(proposalId, experimentId)
  const at = '2026-09-26T00:00:00.000Z'
  await svc.recordExperimentStart({
    formatVersion: 2,
    kind: 'experiment_started',
    proposalId,
    experimentId,
    frozen,
    frozenDigest,
    budget: { ...frozen.budget },
    report: reportPath,
    storeId: 'sg-t-root-1',
    actor: 'root-1',
    at,
  })
  for (const entry of samples) {
    const settlements = entry.taskId === 't-fail'
      ? { baseline: options.failure?.baseline ?? 'failed', candidate: options.failure?.candidate ?? 'verified' }
      : { baseline: options.holdout?.baseline ?? 'verified', candidate: options.holdout?.candidate ?? 'verified' }
    for (const side of ['baseline', 'candidate'] as const) {
      const settlement = settlements[side] as 'verified' | 'failed' | 'cancelled'
      const lineage = experimentLineage(experimentId, entry.taskId, side)
      const taskId = `t-${entry.taskId}-${side}`
      const runId = `r-${entry.taskId}-${side}`
      const verdict: 'pass' | 'fail' | 'inconclusive' = settlement === 'verified' ? 'pass' : settlement === 'failed' ? 'fail' : 'inconclusive'
      const criteria = [{
        criterionId: entry.criteria[0]!.criterionId,
        verdict,
        verifierId: FIXTURE_JUDGE.ref,
        verifierVersion: FIXTURE_JUDGE.version,
      }]
      rows.tasks.push({
        taskId,
        definitionRef: { taskType: 'subtask', version: 1 },
        objective: `[${lineage}] ${entry.taskId}`,
        depth: 1,
        acceptanceCriteria: [],
        requestedCapabilities: [],
        decompositionStatus: 'leaf',
        status: settlement,
        runIds: [runId],
        childTaskIds: [],
      })
      rows.runs.push(fixtureSideRun({ runId, taskId, outcome: settlement, at }))
      rows.sessions.set(`s-${runId}`, [fixtureRequestHeader()])
      rows.evidence.push({ evidenceId: `e-${runId}`, taskRunId: runId, taskId, artifacts: [], verifierResults: [], claims: [], generatedAt: at })
      rows.reviews.push({
        taskId,
        runId,
        outcome: settlement,
        evidenceRefs: [`e-${runId}`],
        anomalies: [],
        criteria,
      })
      await svc.recordExperimentSample({
        formatVersion: 2,
        kind: 'experiment_sample',
        proposalId,
        experimentId,
        preparedContentDigest: candidate.sha256,
        sampleTaskId: entry.taskId,
        side,
        repetition: 0,
        taskId,
        runId,
        outcome: settlement,
        reviewRef: `${taskId}#${runId}`,
        evidenceRefs: [`e-${runId}`],
        criteria,
        workspace: join(svc.root, 'sandbox', proposalId, `exp-${experimentId}`, entry.taskId, side),
        initialDigest: frozen.snapshot.digest,
        cost: settlement === 'verified' || settlement === 'failed'
          ? { status: 'reported', metrics: { toolCalls: { calls: 1, failures: 0 } } }
          : { status: 'unknown', reason: 'the run never settled, so it reported no cost' },
        ...(settlement === 'cancelled' ? { reason: 'the run settled cancelled' } : {}),
        actor: 'root-1',
        at,
      })
    }
  }
  const report = buildExperimentReport(await svc.experiment(experimentId))
  const abs = join(svc.root, reportPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`)
  return { reportPath, experimentId }
}

/**
 * Walk a skill proposal to decided(PROMOTE) at the service level (the tools add
 * their own approval gate): propose → candidate → prepare → the completed
 * two-sided experiment → gate → decide. This build admits a skill candidate
 * only, so there is no other walk to take.
 */
async function walkToDecided(svc: EvolutionService, input: ProposeInput, mutation: unknown) {
  await svc.propose(input, 'root-1')
  await svc.candidate(input.proposalId, VERSION_SET, 'root-1', mutation)
  await svc.prepare(input.proposalId, 'root-1')
  const { reportPath } = await recordSkillExperiment(svc, input.proposalId)
  await svc.gate(input.proposalId, gateAnswers([reportPath]), 'root-1')
  await svc.decide(input.proposalId, 'PROMOTE', 'root-1', 'approval:call-0')
}

describe('replay evidence integrity and promotion', () => {
  it('holds changed commands and omitted failed criteria inconclusive', () => {
    const champion = { taskId: 'before', outcome: 'failed' as const, criteria: [{ criterionId: 'a', verdict: 'fail' as const, command: 'test' }] }
    expect(compareReplaySides(champion, { ...champion, criteria: [] }).relation).toBe('inconclusive')
    expect(compareReplaySides(champion, { ...champion, criteria: [{ ...champion.criteria[0]!, command: 'true' }] }).relation).toBe('inconclusive')
  })

  it('blocks a regressing holdout before human approval while allowing rejection', async () => {
    const { svc } = await serviceWithProduction()
    const { ctx, approval } = toolCtx(svc)
    // A skill candidate whose holdout degraded: the experiment is complete and
    // gated, and the promotion is what refuses.
    const id = skillProposal.proposalId
    await mkdir(join(svc.skillRoot, 'verify'), { recursive: true })
    await writeFile(join(svc.skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate(id, VERSION_SET, 'root-1', { name: 'verify', content: skillText('new') })
    await svc.prepare(id, 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, id, { holdout: { candidate: 'failed' } })
    await svc.gate(id, gateAnswers([reportPath]), 'root-1')
    expect(await defineEvolutionDecideTool(ctx).execute({ proposalId: id, decision: 'PROMOTE' }, exec('root-1'))).toContain('rejected:')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get(id)).status).toBe('gated')
    await svc.decide(id, 'REJECT', 'root-1', 'approval:reject')
    expect((await svc.get(id)).decision).toBe('REJECT')
    },
  )

  it.each(['decide', 'apply'])(
    'refuses a tampered experiment report at %s, including after service reopen', async stage => {
      const { svc, root, skillRoot } = await serviceWithProduction()
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'champion')
      await svc.propose(skillProposal, 'root-1')
      await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('candidate') })
      await svc.prepare('s1', 'root-1')
      const { reportPath } = await recordSkillExperiment(svc, 's1')
      await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
      if (stage === 'apply') await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:decide')
      await appendFile(join(root, reportPath), '\n')
      const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
      const action = stage === 'decide'
        ? reopened.decide('s1', 'PROMOTE', 'root-1', 'approval:decide')
        : reopened.apply('s1', 'root-1', 'approval:apply')
      await expect(action).rejects.toThrow('is not the report its ledger records recompute to')
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('champion')
    },
  )
})

describe('EvolutionService apply/rollback state machine', () => {
  it('walks decided(PROMOTE) → applied → rolledback and derives the full history', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.proposal.status).toBe('applied')
    expect(applied.proposal.applied).toEqual({ targets: [join(skillRoot, 'verify', 'SKILL.md')], approvalRef: 'approval:call-1' })
    const rolledback = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(rolledback.proposal.status).toBe('rolledback')
    // A skill candidate's evaluation is the experiment, not a `replayed` line.
    expect(rolledback.proposal.history.map(entry => entry.status)).toEqual([
      'proposed', 'candidate', 'prepared', 'gated', 'decided', 'applied', 'rolledback',
    ])
  })

  it.each(['REJECT', 'KEEP_FOR_FURTHER_RESEARCH'] as const)('refuses apply on a decided %s proposal', async decision => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc.prepare('s1', 'root-1')
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', decision, 'root-1', 'approval:call-1')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(
      `cannot record "applied" — the recorded decision is ${decision}; only a PROMOTE decision can be applied`,
    )
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
  })

  it('refuses apply before the decision, a repeated apply, rollback before apply, and a repeated rollback', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    await svc.prepare('s1', 'root-1')
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "rolledback"')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is applied; cannot record "applied"')
    await svc.rollback('s1', 'root-1', 'approval:call-2')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-3')).rejects.toThrow('is rolledback; cannot record "rolledback"')
  })

  it('refuses apply for an L4 skill candidate, pointing at the manual path', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, { ...skillProposal, proposalId: 's-l4', level: 'L4' }, { name: 'verify', content: skillText('# new') })
    await expect(svc.apply('s-l4', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
  })

  it('replays a ledger with applied and rolledback records to the same fold after reopen', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await svc.rollback('s1', 'root-1', 'approval:call-2')
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    const folded = await reopened.get('s1')
    expect(folded.status).toBe('rolledback')
    expect(folded.applied?.approvalRef).toBe('approval:call-1')
    expect(folded.rolledback?.approvalRef).toBe('approval:call-2')
    // proposed, candidate, prepared, gated, decided, applied, rolledback — a
    // skill candidate's evaluation is the experiment, not a lifecycle line.
    expect(folded.history).toHaveLength(7)
  })

  it('writes one v2 ledger through the whole walk, with no v1 vocabulary in any line', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await svc.rollback('s1', 'root-1', 'approval:call-2')

    const raw = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    const records = raw.map(line => JSON.parse(line) as { formatVersion: number; kind: string })
    // Every line this build writes declares the ledger's own format version.
    expect(records.map(record => record.formatVersion)).toEqual(records.map(() => 2))
    // The lifecycle plus the experiment family — and no `replayed` record.
    expect(records.map(record => record.kind)).toEqual(expect.arrayContaining([
      'proposed', 'candidate', 'prepared', 'experiment_started', 'experiment_sample', 'gated', 'decided', 'applied', 'rolledback',
    ]))
    expect(records.map(record => record.kind)).not.toContain('replayed')
    expect(raw.join('\n')).not.toContain('"replayed"')

    // The reopen folds the v2 ledger to the same state the live service holds.
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    expect(await reopened.list()).toEqual(await svc.list())
    expect((await reopened.get('s1')).history.map(entry => entry.status)).toEqual([
      'proposed', 'candidate', 'prepared', 'gated', 'decided', 'applied', 'rolledback',
    ])
    expect(await reopened.experiments('s1')).toHaveLength(1)
  })

  it('fails loudly on a forged applied record: wrong base state or a malformed payload', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot, '# old\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc.prepare('s1', 'root-1')
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'REJECT', 'root-1', 'approval:call-1')
    const forged = { formatVersion: 2, kind: 'applied', proposalId: 's1', targets: ['/x'], approvalRef: 'approval:call-9', actor: 'x', at: 'now' }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.list()).rejects.toThrow('cannot record "applied"')

    const root2 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot2 = join(root2, 'skills')
    await productionSkill(skillRoot2, '# old\n')
    const svc2 = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root: join(root2, 'evolution'), skillRoot: skillRoot2 })
    await svc2.propose(skillProposal, 'root-1')
    await svc2.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc2.prepare('s1', 'root-1')
    const { reportPath: svc2Report } = await recordSkillExperiment(svc2, 's1')
    await svc2.gate('s1', gateAnswers([svc2Report]), 'root-1')
    await svc2.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    const malformed = { formatVersion: 2, kind: 'applied', proposalId: 's1', targets: [], approvalRef: '', actor: 'x', at: 'now' }
    await writeFile(join(svc2.root, 'proposals.jsonl'), `${JSON.stringify(malformed)}\n`, { flag: 'a' })
    const reopened2 = reopenLike(svc2, { modelSelection: () => FIXTURE_SELECTION, root: svc2.root, skillRoot: skillRoot2 })
    await expect(reopened2.list()).rejects.toThrow('malformed target list')
  })
})

describe('EvolutionService apply/rollback production writes', () => {
  it('applies a skill mutation over the production SKILL.md and rolls it back to the champion bytes', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await writeFile(join(skillRoot, 'verify', 'reference.md'), '# aux file the snapshot never captured\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })

    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('# new verify skill'))
    // file-level semantics: auxiliary files the champion snapshot never captured stay put
    expect(await readFile(join(skillRoot, 'verify', 'reference.md'), 'utf8')).toBe('# aux file the snapshot never captured\n')
    expect(applied.targets).toEqual([join(skillRoot, 'verify', 'SKILL.md')])

    await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    expect(await readFile(join(skillRoot, 'verify', 'reference.md'), 'utf8')).toBe('# aux file the snapshot never captured\n')
  })

  it('refuses a hand-written lifecycle of another target type at its first line', async () => {
    const { svc, root } = await serviceWithProduction()
    // The v2 fold admits exactly what the current entries write: a skill
    // candidate and nothing else. A hand-written capability lifecycle — the
    // shape a ledger written before this build holds, with the bookkeeping
    // prepare that shape carried — is refused at load, at the candidate line,
    // before anything is read from it. No live entry can produce it: this
    // build's `candidate` admits a skill candidate only.
    await svc.propose(capabilityProposal, 'root-1')
    await appendFile(
      join(root, 'proposals.jsonl'),
      [
        { formatVersion: 2, kind: 'candidate', proposalId: 'c1', versionSet: { capabilityTable: 'config.yml#doc1' }, mutation: capabilityMutation, actor: 'root-1', at: '2026-09-20T00:00:01.000Z' },
        { formatVersion: 2, kind: 'prepared', proposalId: 'c1', sandbox: null, mechanical: false, champion: 'none', files: [], actor: 'root-1', at: '2026-09-20T00:00:02.000Z' },
        { formatVersion: 2, kind: 'gated', proposalId: 'c1', gate: gateAnswers(['sandbox/c1/replay-report.json']), actor: 'root-1', at: '2026-09-20T00:00:04.000Z' },
        { formatVersion: 2, kind: 'decided', proposalId: 'c1', decision: 'PROMOTE', approvalRef: 'approval:legacy-decide', actor: 'root-1', at: '2026-09-20T00:00:05.000Z' },
        { formatVersion: 2, kind: 'applied', proposalId: 'c1', targets: ['legacy apply'], approvalRef: 'approval:legacy-apply', actor: 'root-1', at: '2026-09-20T00:00:06.000Z' },
      ].map(line => JSON.stringify(line)).join('\n') + '\n',
    )
    const verbatim = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('targets "capability"')
    await expect(reopened.get('c1')).rejects.toThrow('targets "capability"')
    // Nothing was read out of it and nothing was written beside it: the refused
    // file keeps its bytes, and the state machine is never reached.
    await expect(reopened.rollback('c1', 'root-1', 'approval:call-2')).rejects.toThrow('targets "capability"')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(verbatim)
  })
})

/* ------------------------------------------------------------------ */
/* P2: single-file skill candidate content binding. prepare records    */
/* the SHA-256 of the materialized SKILL.md; the replay report, every   */
/* gate, and the apply write re-verify that exact content.              */
/* ------------------------------------------------------------------ */

const SKILL_CANDIDATE = skillText('# new verify skill\n\nwith a trailing newline')
const skillCandidateFile = (root: string, proposalId = 's1') => join(root, 'sandbox', proposalId, 'skills', 'verify', 'SKILL.md')

/** propose → candidate → prepare a skill proposal; returns the recorded content identity. */
async function prepareSkill(svc: EvolutionService, content: string = SKILL_CANDIDATE) {
  await svc.propose(skillProposal, 'root-1')
  await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content })
  const prepared = await svc.prepare('s1', 'root-1')
  return prepared.prepared!.skillContent!
}

describe('skill candidate content binding (P2)', () => {
  it('P2-A: an untouched candidate walks prepare → replay → gate → decide → apply with byte-identical production content', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const identity = await prepareSkill(svc)
    // the digest is over the exact file bytes — no trim, no newline conversion
    expect(identity).toEqual({ name: 'verify', sha256: createHash('sha256').update(SKILL_CANDIDATE, 'utf8').digest('hex') })
    expect(await readFile(skillCandidateFile(root), 'utf8')).toBe(SKILL_CANDIDATE)
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('s1', gateAnswers([evidenceFile, reportPath]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    await svc.apply('s1', 'root-1', 'approval:call-1')

    // production content is byte-equal to the verified candidate bytes
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'))).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    // the experiment's frozen block names exactly the prepared identity
    expect(JSON.parse(await readFile(join(root, reportPath), 'utf8')).frozen.candidate).toEqual(identity)
    const applied = await svc.get('s1')
    expect(applied.status).toBe('applied')
    expect(applied.prepared!.skillContent).toEqual(identity)
    expect(applied.history.map(entry => entry.status)).toEqual([
      'proposed', 'candidate', 'prepared', 'gated', 'decided', 'applied',
    ])
  })

  it('P2-A: the experiment binds the report to the verified candidate and the prepare-time production baseline, never to production rewritten since', async () => {
    const { root, skillRoot, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    // rewriting production must not move either identity: the candidate is
    // re-verified in the sandbox, and the baseline was captured at prepare
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# production rewritten\n')
    const result = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(result).toContain('proposal s1 [experiment] skill verify — verdict: fixed')

    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    const started = lines.find(line => line.kind === 'experiment_started') as { frozen: Record<string, any> }
    expect(started.frozen.candidate).toEqual(experiment.identity)
    expect(started.frozen.productionBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update('# old verify skill\n', 'utf8').digest('hex'),
    })
    expect(experiment.identity.sha256).not.toBe(createHash('sha256').update('# production rewritten\n', 'utf8').digest('hex'))
    // the overlay is the sandbox candidate, never the production skill
    expect(replayTask.mock.calls.filter(call => call[2].overlay !== undefined)).toHaveLength(2)
    expect(replayTask.mock.calls.every(call => call[2].lineage?.startsWith('evolution-experiment:'))).toBe(true)
  })

  it('P2-B: a candidate modified after prepare is refused before any run, tool and service alike', async () => {
    const { svc, root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    await writeFile(skillCandidateFile(root), 'tampered after prepare\n')

    const viaTool = (await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))) as string
    expect(viaTool).toContain('evolution_replay rejected:')
    expect(viaTool).toContain('no longer matches the content identity recorded at prepare')
    expect(replayTask).not.toHaveBeenCalled()

    // the same refusal through the service's own candidate read — the shared
    // identity check every promotion stage and the experiment's pre-run check use
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow('no longer matches the content identity recorded at prepare')
    expect((await svc.get('s1')).status).toBe('prepared')
    expect(existsSync(join(root, 'sandbox', 's1', 'replay-report.json'))).toBe(false)
  })

  it('keeps the candidate bytes out of production through the whole experiment, whatever the runs do', async () => {
    const { root, skillRoot, replayTask, replayTool } = await preparedSkillExperiment()
    // The experiment writes into its own sandboxes and sandbox workspaces only;
    // a run that rearranges its own workspace cannot reach the production skill.
    await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))
    expect(replayTask).toHaveBeenCalledTimes(4)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    expect(existsSync(join(root, 'sandbox', 's1', 'replay-report.json'))).toBe(false)
  })

  it('P2-B: a candidate modified after the replay is refused at decide and apply, with no successful-promotion state', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten after the replay\n')

    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow('no longer matches the content identity')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect((await svc.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('decided')
    expect(kinds).not.toContain('applied')
  })

  it('P2-C: refuses a deleted candidate and a directory in its place', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await requireProductionSkill(skillRoot)
    await prepareSkill(svc)
    await rm(skillCandidateFile(root))
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow('is missing under')

    await mkdir(skillCandidateFile(root))
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow('is not a regular file')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('P2-C: refuses a symlinked candidate file or ancestor and never writes the link target', async () => {
    const { svc, dir, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), 'external content\n')
    // the skill directory itself becomes a symlink to the outside target
    const verifyDir = join(root, 'sandbox', 's1', 'skills', 'verify')
    await rm(verifyDir, { recursive: true, force: true })
    await symlink(outside, verifyDir)
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is a symbolic link')
    expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('external content\n')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    expect((await svc.get('s1')).status).toBe('decided')

    // the candidate file itself as a symlink is refused at replay time
    await rm(verifyDir)
    await mkdir(verifyDir, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), 'external content\n')
    await symlink(join(outside, 'SKILL.md'), skillCandidateFile(root))
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow('is a symbolic link')
  })

  it('P2-D: apply writes exactly the verified bytes when the source is replaced mid-read', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const candidate = skillCandidateFile(root)
    const replacement = 'replaced after the candidate read\n'
    let reads = 0
    let fired = 0
    candidateReadHooks.onCandidateRead = async path => {
      if (path !== candidate) return
      reads += 1
      // apply reads the candidate three times — checkPromotion's identity read,
      // the promotion's provider check (S1-C item 3), and the write's own read.
      // The source is replaced only after that last read completes,
      // deterministically, with no sleep-based race.
      if (reads === 3) {
        fired += 1
        await writeFile(candidate, replacement)
      }
    }
    try {
      await svc.apply('s1', 'root-1', 'approval:call-1')
    } finally {
      candidateReadHooks.onCandidateRead = undefined
    }
    expect(fired).toBe(1)
    // production carries the verified bytes; the replacement never reached it
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'))).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect(await readFile(candidate, 'utf8')).toBe(replacement)
    // and the replaced source can no longer verify for any later stage
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.checkPromotion('s1')).rejects.toThrow('no longer matches the content identity')
  })

  it('P2-E: the crate the experiment freezes names the prepared candidate identity', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await requireProductionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    expect(identity.sha256).toMatch(/^[a-f0-9]{64}$/)
    // A recorded experiment whose frozen identity is not the prepared bytes is
    // refused at the promotion gate: the evidence belongs to other content.
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    const frozen = JSON.parse(await readFile(join(root, reportPath), 'utf8'))
    expect(frozen.frozen.candidate).toEqual(identity)
    expect(JSON.parse(await readFile(join(root, reportPath), 'utf8')).formatVersion).toBe(2)
  })

  it('P2-F: a reopened service enforces the same identity checks', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten across a restart\n')

    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow('no longer matches the content identity')
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect((await reopened.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
  })

  it('P2-G: an illegitimate candidate is refused before the human is asked', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten before the human review\n')

    const { ctx, approval } = toolCtx(svc)
    const result = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 's1', decision: 'PROMOTE' }, exec('root-1'))) as string
    expect(result).toContain('evolution_decide rejected:')
    expect(result).toContain('no longer matches the content identity')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
  })

  it('P2-G: a candidate changed while the human approval is pending is refused by the service recheck', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')

    // The approval mock is the controllable hook: it rewrites the candidate
    // while the human is deciding, then grants. The service entry rechecks.
    const approval = {
      request: vi.fn(async () => {
        await writeFile(skillCandidateFile(root), 'rewritten while the human decided\n')
        return 'allowed-once' as const
      }),
    }
    const base = toolCtx(svc)
    const ctx = { ...(base.ctx as unknown as Record<string, unknown>), approval } as never
    const result = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 's1', decision: 'PROMOTE' }, exec('root-1'))) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_decide rejected:')
    expect(result).toContain('no longer matches the content identity')
    expect((await svc.get('s1')).status).toBe('gated')
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
  })

  it('P2-G: the apply tool rechecks the identity after its own approval and writes nothing on a changed candidate', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const approval = {
      request: vi.fn(async () => {
        await writeFile(skillCandidateFile(root), 'rewritten while the human decided\n')
        return 'allowed-once' as const
      }),
    }
    const base = toolCtx(svc)
    const ctx = { ...(base.ctx as unknown as Record<string, unknown>), approval } as never
    const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('no longer matches the content identity')
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('applied')
  })

})

/* ------------------------------------------------------------------ */
/* P3: the production baseline must not have moved. prepare records the  */
/* SHA-256 of the production SKILL.md from the same single read that     */
/* produced the champion snapshot; the apply seams compare the live      */
/* production target against it and refuse a stale candidate instead of  */
/* overwriting a production skill that changed. Serial single-process    */
/* calls only — no cross-process lock, no atomic compare-and-swap.       */
/* ------------------------------------------------------------------ */

const P3_BASELINE = '# production verify skill\n'
const P3_CANDIDATE_A = skillText('# candidate A')
const P3_CANDIDATE_B = skillText('# candidate B')
const P3_CONFLICT_GUIDANCE = 'create a new candidate from the current production state and re-evaluate it'
const skillProductionFile = (skillRoot: string, name = 'verify') => join(skillRoot, name, 'SKILL.md')

/** Walk a skill proposal under a fresh id to decided(PROMOTE) against the production state as it stands. */
async function walkSkillToDecided(svc: EvolutionService, proposalId: string, content: string) {
  await walkToDecided(svc, { ...skillProposal, proposalId }, { name: 'verify', content })
}

async function ledgerKinds(root: string): Promise<string[]> {
  return (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    .map(line => (JSON.parse(line) as { kind: string }).kind)
}

/** Rewrite a live ledger as a P2-era one: the prepared line loses `skillBaseline`, the field P3 added. */
async function dropBaselineField(root: string) {
  const path = join(root, 'proposals.jsonl')
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => {
    const record = JSON.parse(line)
    if (record.kind === 'prepared') delete record.skillBaseline
    return JSON.stringify(record)
  })
  await writeFile(path, `${lines.join('\n')}\n`)
}

/** A production skill root holding one real SKILL.md, the champion of every P3 fixture. */
async function productionSkill(skillRoot: string, text: string = P3_BASELINE) {
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(skillProductionFile(skillRoot), text)
}

describe('production baseline check (P3)', () => {
  it('P3-A: an unchanged champion with every P2 prerequisite applies and writes the verified candidate bytes', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    // the baseline is the digest of the production bytes, taken from the same
    // single read that produced the champion snapshot — the two cannot disagree
    const prepared = await svc.get('s1')
    expect(prepared.prepared!.skillBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(P3_BASELINE, 'utf8').digest('hex'),
    })
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md')))
      .toEqual(Buffer.from(P3_BASELINE, 'utf8'))

    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    // the precheck the apply tool runs before asking a human passes untouched
    await svc.checkProductionBaseline('s1')

    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.targets).toEqual([join(skillRoot, 'verify', 'SKILL.md')])
    expect(await readFile(skillProductionFile(skillRoot))).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect((await svc.get('s1')).status).toBe('applied')
    expect(await ledgerKinds(root)).toContain('applied')
  })

  it.each([
    ['modified after prepare', 'rewritten in production\n'],
    ['deleted after prepare', null],
  ])('P3-B: production %s is refused at apply, tool and service alike, and keeps its new state', async (_label, next) => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    if (next === null) await rm(skillProductionFile(skillRoot))
    else await writeFile(skillProductionFile(skillRoot), next)

    // the tool refuses before the human is asked — no approval is burned
    const { ctx, approval } = toolCtx(svc)
    const viaTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(viaTool).toContain('evolution_apply rejected:')
    expect(viaTool).toContain(P3_CONFLICT_GUIDANCE)
    expect(approval.request).not.toHaveBeenCalled()

    // and a direct service call cannot bypass the same check
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(
      next === null ? /no longer exists/ : /changed since prepare/,
    )
    expect((await svc.get('s1')).status).toBe('decided')
    expect((await svc.get('s1')).applied).toBeUndefined()
    expect(await ledgerKinds(root)).not.toContain('applied')
    // production keeps whatever it now holds: the modified bytes, or the absence
    expect(existsSync(skillProductionFile(skillRoot))).toBe(next !== null)
    if (next !== null) expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(next)
    // the candidate, its report and its history are preserved for a fresh proposal
    expect(await svc.readSkillCandidate('s1')).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect((await svc.get('s1')).history.map(entry => entry.status))
      .toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided'])
  })

  it('P3-C: a brand-new skill has no production state to be prepared against, so prepare refuses it and production is preserved', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: P3_CANDIDATE_A })
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    // §F.2: the two-sided experiment evaluates a replacement of an existing
    // SKILL.md — promoting a brand-new skill is not what its evidence can show.
    // The refusal lands at prepare, before any sandbox or ledger write, so no
    // proposal can ever walk a new skill towards a promotion.
    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow(/production skill .* does not exist/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect(await ledgerKinds(root)).not.toContain('prepared')
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect(existsSync(skillProductionFile(skillRoot))).toBe(false)

    // Production created afterwards is left exactly as it is: nothing resumed
    // this candidate, and the refusal never touched production.
    await productionSkill(skillRoot, '# a brand new production skill\n')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# a brand new production skill\n')
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('P3-D: a production target that became a directory, a file symlink, or an ancestor symlink is refused', async () => {
    const { svc, dir, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), 'external content\n')

    // 1. the SKILL.md path becomes a directory
    await rm(skillProductionFile(skillRoot))
    await mkdir(skillProductionFile(skillRoot))
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is no longer a readable regular file')
    await expect(svc.checkProductionBaseline('s1')).rejects.toThrow('is no longer a readable regular file')
    await rm(skillProductionFile(skillRoot), { recursive: true })

    // 2. the SKILL.md path becomes a symbolic link to a file outside the skill root
    await symlink(join(outside, 'SKILL.md'), skillProductionFile(skillRoot))
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is a symbolic link')
    expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('external content\n')
    await rm(skillProductionFile(skillRoot))

    // 3. an ancestor (the skill directory itself) becomes a symbolic link
    await rm(join(skillRoot, 'verify'), { recursive: true, force: true })
    await symlink(outside, join(skillRoot, 'verify'))
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is a symbolic link')
    expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('external content\n')

    // every refusal left the proposal decided with no applied record
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('P3-E: two candidates from one champion apply serially; the second is refused and the first result stands', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    await walkSkillToDecided(svc, 's2', P3_CANDIDATE_B)
    // both were evaluated and approved against the same production baseline
    expect((await svc.get('s1')).prepared!.skillBaseline).toEqual((await svc.get('s2')).prepared!.skillBaseline)

    const { ctx, approval } = toolCtx(svc)
    const first = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(first).toContain('proposal s1 [applied] L2 skill verify')
    expect(approval.request).toHaveBeenCalledOnce()

    const second = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's2' }, exec('root-1'))) as string
    expect(second).toContain('evolution_apply rejected:')
    expect(second).toContain('changed since prepare')
    expect(second).toContain(P3_CONFLICT_GUIDANCE)
    // the second never reaches the human: one approval for the whole serial run
    expect(approval.request).toHaveBeenCalledOnce()

    // production keeps the first result; the second candidate changed nothing
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_CANDIDATE_A)
    expect((await svc.get('s1')).status).toBe('applied')
    const stale = await svc.get('s2')
    expect(stale.status).toBe('decided')
    expect(stale.applied).toBeUndefined()
    expect(stale.prepared!.skillBaseline!.sha256).toBe(createHash('sha256').update(P3_BASELINE, 'utf8').digest('hex'))
    expect(stale.history.map(entry => entry.status))
      .toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided'])
    expect(await svc.readSkillCandidate('s2')).toEqual(Buffer.from(P3_CANDIDATE_B, 'utf8'))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
  })

  it('P3-F: a baseline that moved before the human review is refused without asking for approval', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    await writeFile(skillProductionFile(skillRoot), '# moved before the review\n')

    const { ctx, approval } = toolCtx(svc)
    const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('changed since prepare')
    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# moved before the review\n')
  })

  it('P3-F: a baseline that moves while the approval is pending is refused by the recheck after the grant', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)

    // Controllable promises, no sleeps: the approval stub reports that the
    // human is deciding, then waits for the test to release the grant.
    let deciding: () => void = () => {}
    let grant: () => void = () => {}
    const humanDeciding = new Promise<void>(resolve => { deciding = resolve })
    const granted = new Promise<void>(resolve => { grant = resolve })
    const approval = {
      request: vi.fn(async () => {
        deciding()
        await granted
        return 'allowed-once' as const
      }),
    }
    const base = toolCtx(svc)
    const ctx = { ...(base.ctx as unknown as Record<string, unknown>), approval } as never
    const applying = defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))

    await humanDeciding
    await writeFile(skillProductionFile(skillRoot), '# moved while the human was deciding\n')
    grant()
    const result = (await applying) as string

    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('changed since prepare')
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await ledgerKinds(root)).not.toContain('applied')
    // production keeps the externally edited bytes — no overwrite, no merge
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# moved while the human was deciding\n')
  })

  it('P3-G: a reopened service identifies the same production-baseline conflict', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    await writeFile(skillProductionFile(skillRoot), '# moved across a restart\n')

    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('changed since prepare')
    await expect(reopened.checkProductionBaseline('s1')).rejects.toThrow('changed since prepare')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# moved across a restart\n')
    const reloaded = await reopened.get('s1')
    expect(reloaded.status).toBe('decided')
    expect(reloaded.applied).toBeUndefined()
    expect(reloaded.prepared!.skillBaseline).toEqual({
      name: 'verify', sha256: createHash('sha256').update(P3_BASELINE, 'utf8').digest('hex'),
    })
    expect(reloaded.history.map(entry => entry.status))
      .toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided'])
  })

  it('P3-G: a P2 content change is still refused next to the baseline check', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    // the candidate bytes change while the production baseline stays identical
    await writeFile(skillCandidateFile(root), 'rewritten candidate\n')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('no longer matches the content identity')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(root)).not.toContain('applied')
  })

  it('P3-G: rollback keeps its overwrite semantics and restores the champion snapshot after a later external change', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.proposal.status).toBe('applied')

    // an external edit lands after the apply; rollback still restores the
    // prepare-time champion snapshot byte-for-byte (strategy unchanged by P3)
    await writeFile(skillProductionFile(skillRoot), '# edited after the apply\n')
    const rolledback = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(rolledback.proposal.status).toBe('rolledback')
    expect(await readFile(skillProductionFile(skillRoot))).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    expect((await svc.get('s1')).applied!.approvalRef).toBe('approval:call-1')
    expect((await svc.get('s1')).rolledback!.approvalRef).toBe('approval:call-2')
  })

  it('P3-G: a prepared record with no recorded baseline is refused at the entry instead of defaulting to match', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    // the P2-era shape: skillContent recorded, skillBaseline absent
    await dropBaselineField(root)
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })

    // The record never folds: a prepare without its production baseline is not a
    // shape this build's entries write, so there is no state an apply could be
    // reached from — and nothing defaults a missing baseline to a match.
    await expect(reopened.list()).rejects.toThrow('no valid skillBaseline identity')
    await expect(reopened.get('s1')).rejects.toThrow('no valid skillBaseline identity')
    await expect(reopened.checkProductionBaseline('s1')).rejects.toThrow('no valid skillBaseline identity')
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('no valid skillBaseline identity')

    // The refusal costs nothing: no human is asked, production keeps its bytes
    // and the ledger keeps the malformed line byte for byte.
    const { ctx, approval } = toolCtx(reopened)
    const viaTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(viaTool).toContain('evolution_apply rejected:')
    expect(viaTool).toContain('no valid skillBaseline identity')
    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_BASELINE)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
  })

  it('P3-G: a malformed skillBaseline on a skill prepared record fails the fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-forge-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    const forged = {
      formatVersion: 2, kind: 'prepared', proposalId: 's1', sandbox: 'sandbox/s1', mechanical: true, champion: 'captured',
      skillContent: { name: 'verify', sha256: 'a'.repeat(64) },
      files: ['x'], skillBaseline: { name: 'verify', sha256: 'not-a-digest' }, actor: 'x', at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    await expect(new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root }).list()).rejects.toThrow('no valid skillBaseline identity')
  })
})

describe('evolution_apply / evolution_rollback tools', () => {
  /** toolCtx on top of a production-fixture service (capability champion resolves from the taskRuntime mock). */
  /**
   * Hand-write the legacy decided(PROMOTE) lifecycle of a non-skill proposal —
   * a candidate, its bookkeeping prepare, its gate and the decision, all v2
   * records — into the ledger. This build's fold refuses that shape at its
   * candidate line, so what the returned service proves is the entry refusal:
   * no live entry writes a lifecycle of another target type.
   */
  async function legacyDecidedLedger(
    svc: EvolutionService,
    proposalId: string,
    roots: ProductionRoots,
  ): Promise<EvolutionService> {
    await appendFile(join(svc.root, 'proposals.jsonl'), [
      { formatVersion: 2, kind: 'candidate', proposalId, versionSet: { x: 'v1' }, mutation: { baseVersion: 'v3', definition: { objective: 'the legacy definition' } }, actor: 'root-1', at: '2026-09-20T00:00:01.000Z' },
      { formatVersion: 2, kind: 'prepared', proposalId, sandbox: null, mechanical: false, champion: 'none', files: [], actor: 'root-1', at: '2026-09-20T00:00:02.000Z' },
      { formatVersion: 2, kind: 'gated', proposalId, gate: gateAnswers([`sandbox/${proposalId}/replay-report.json`]), actor: 'root-1', at: '2026-09-20T00:00:04.000Z' },
      { formatVersion: 2, kind: 'decided', proposalId, decision: 'PROMOTE', approvalRef: 'approval:legacy-decide', actor: 'root-1', at: '2026-09-20T00:00:05.000Z' },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    return reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, ...roots })
  }

  async function toolCtxWithProduction(approvalOutcome: string = 'allowed-once') {
    const production = await serviceWithProduction()
    const { ctx, approval } = toolCtx(production.svc, approvalOutcome)
    return { ...production, ctx, approval }
  }

  it('applies and rolls back a skill through both human approvals, with the targets named in the reason and the record', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })

    const applyTool = defineEvolutionApplyTool(ctx)
    const applied = (await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(applied).toContain('proposal s1 [applied] L2 skill verify — PROMOTE in effect')
    expect(applied).toContain(`  - ${join(skillRoot, 'verify', 'SKILL.md')}`)
    expect(applied).toContain('effective immediately — the skill filesystem watches the skill root')
    expect(applied).toContain('human approval: approval:call-1 — rollback with evolution_rollback')
    expect(approval.request).toHaveBeenCalledOnce()
    const request = approval.request.mock.calls[0]![0] as { reason: string; toolName: string }
    expect(request.toolName).toBe('evolution_apply')
    expect(request.reason).toContain('Evolution apply for proposal s1 (L2 skill verify, base v1)')
    expect(request.reason).toContain('recorded decision: PROMOTE')
    expect(request.reason).toContain(`  - ${join(skillRoot, 'verify', 'SKILL.md')}`)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('# new verify skill'))

    const ledger = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    const appliedRecord = JSON.parse(ledger.at(-1)!) as { kind: string; targets: string[]; approvalRef: string }
    expect(appliedRecord.kind).toBe('applied')
    expect(appliedRecord.targets).toEqual([join(skillRoot, 'verify', 'SKILL.md')])
    expect(appliedRecord.approvalRef).toBe('approval:call-1')

    const rollbackTool = defineEvolutionRollbackTool(ctx)
    const rolledback = (await rollbackTool.execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(rolledback).toContain('proposal s1 [rolledback] L2 skill verify — champion restored')
    expect(approval.request).toHaveBeenCalledTimes(2)
    const rollbackRequest = approval.request.mock.calls[1]![0] as { reason: string; toolName: string }
    expect(rollbackRequest.toolName).toBe('evolution_rollback')
    expect(rollbackRequest.reason).toContain('this restores the champion snapshot')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    expect((await svc.get('s1')).status).toBe('rolledback')
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'evolution_apply writes nothing when the approval comes back %s',
    async outcome => {
      const { svc, ctx, skillRoot } = await toolCtxWithProduction(outcome)
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
      await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
      const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
      expect(result).toContain('nothing written')
      expect(result).toContain('stays decided')
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
      expect((await svc.get('s1')).status).toBe('decided')
      const ledger = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).not.toContain('applied')
    },
  )

  it('evolution_rollback writes nothing when the human rejects it', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction('allowed-once')
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    approval.request.mockResolvedValue('rejected')
    const result = (await defineEvolutionRollbackTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('nothing written')
    expect(result).toContain('stays applied')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('# new verify skill'))
    expect((await svc.get('s1')).status).toBe('applied')
  })

  it('refuses without asking the human: non-decided and L4', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old\n')
    const applyTool = defineEvolutionApplyTool(ctx)

    await svc.propose(skillProposal, 'root-1')
    expect((await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string)
      .toContain('proposal s1 is proposed; only a decided proposal can be applied')

    await walkToDecided(svc, { ...skillProposal, proposalId: 's-l4', level: 'L4' }, { name: 'verify', content: skillText('# new') })
    expect((await applyTool.execute({ proposalId: 's-l4' }, exec('root-1'))) as string)
      .toContain('L4 harness evolution has no executor')

    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old\n')
  })

  it('refuses a legacy decided record of another target type at the entry, before the human is asked', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old\n')
    const applyTool = defineEvolutionApplyTool(ctx)

    await svc.propose(skillProposal, 'root-1')
    expect((await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string)
      .toContain('proposal s1 is proposed; only a decided proposal can be applied')

    await walkToDecided(svc, { ...skillProposal, proposalId: 's-l4', level: 'L4' }, { name: 'verify', content: skillText('# new') })
    expect((await applyTool.execute({ proposalId: 's-l4' }, exec('root-1'))) as string)
      .toContain('L4 harness evolution has no executor')

    // A task_definition PROMOTE can no longer be *recorded* — `candidate`
    // refuses the target type by name and the fold refuses the same hand-written
    // shape at its first line — so the only thing an older ledger's decided
    // record reaches is that entry refusal: no human is asked and nothing is
    // written.
    const roots: ProductionRoots = { root: svc.root, skillRoot }
    await svc.propose(proposal, 'root-1')
    const legacyLedger = await legacyDecidedLedger(svc, 'p1', roots)
    await expect(legacyLedger.list()).rejects.toThrow('targets "task_definition"')
    const viaTool = (await defineEvolutionApplyTool({ ...(ctx as object), evolution: legacyLedger } as never).execute({ proposalId: 'p1' }, exec('root-1'))) as string
    expect(viaTool).toContain('evolution_apply rejected:')
    expect(viaTool).toContain('targets "task_definition"')

    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old\n')
  })

  it('evolution_rollback refuses a proposal that is not applied, without asking the human', async () => {
    const { svc, ctx, approval } = await toolCtxWithProduction()
    await svc.propose(skillProposal, 'root-1')
    const result = (await defineEvolutionRollbackTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(result).toContain('is proposed; only an applied proposal can be rolled back')
  })

  it('evolution_list renders applied and rolledback with their targets and approval refs', async () => {
    const { svc, ctx, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new') })
    await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    await defineEvolutionRollbackTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const listed = (await defineEvolutionListTool(ctx).execute({ status: 'rolledback' }, exec('root-1'))) as string
    expect(listed).toContain('- s1 [rolledback PROMOTE] L2 skill verify (base v1)')
    expect(listed).toContain(`applied: [${join(skillRoot, 'verify', 'SKILL.md')}] (approval approval:call-1)`)
    expect(listed).toContain('rolled back:')
    expect(listed).toContain('history: proposed by root-1')
  })
})

/* ------------------------------------------------------------------ */
/* S1-C item 3: the provider pre-check every promotion entry shares.     */
/* A capability row and a skill candidate are judged by the same         */
/* `validateSkillProvider` admission and config load run, so             */
/* `evolution_apply` is not the only defence: decide(PROMOTE), the tool   */
/* before it asks a human, and the service entry immediately before the   */
/* production write all refuse an unusable provider — and a refusal       */
/* writes nothing, records nothing and burns no approval.                 */
/* ------------------------------------------------------------------ */

/** What a fixture skill directory declares about itself. */
interface SkillShape {
  /** `execution` carries a verifier ref and required tools; `knowledge` carries neither; omitted writes `SKILL.md` alone (guidance). */
  sidecar?: 'execution' | 'knowledge'
  verifierRef?: string
  capabilities?: readonly string[]
  requiredTools?: readonly string[]
}

/** SHA-256 of text, computed here so the validator is never confirmed against itself. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Write one skill directory as every provider check reads it: a `SKILL.md`
 * whose frontmatter declares the granted name, plus — when the shape asks for
 * one — a sidecar whose declared content identity is the digest of exactly
 * those bytes.
 */
async function writeSkillDirectory(directory: string, name: string, content: string, shape: SkillShape = {}): Promise<string> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), content)
  if (shape.sidecar === undefined) return directory
  const identity = { skillMdSha256: sha256Of(content), resources: [] }
  const declared = shape.sidecar === 'execution'
    ? {
        contractVersion: 1,
        type: 'execution',
        capabilities: [...(shape.capabilities ?? [])],
        precondition: 'the fixture skill is installed where discovery looks',
        inputs: [],
        outputs: [],
        requiredTools: [...(shape.requiredTools ?? [])],
        verifier: { ref: shape.verifierRef },
        content: identity,
      }
    : {
        contractVersion: 1,
        type: 'knowledge',
        source: 'this test fixture',
        scope: 'promotion-entry behaviour only',
        content: identity,
        contentCheck: { kind: 'command', command: 'true' },
      }
  await writeFile(join(directory, 'SKILL.contract.json'), `${JSON.stringify(declared, null, 2)}\n`)
  return directory
}

/**
 * Append the hand-written gated capability lifecycle — a candidate carrying the
 * capability mutation with the bookkeeping prepare of its shape, then its gate
 * — to the fixture's ledger. That shape is what a ledger written before this
 * build holds; this build's fold refuses it at the candidate line, so these
 * cases pin the entry refusal: the state is not reachable through the live
 * entries, and a hand-written file cannot smuggle it in either.
 */
async function capabilityGatedLedger(svc: EvolutionService, proposalId: string): Promise<void> {
  await svc.propose({ ...capabilityProposal, proposalId }, 'root-1')
  await appendFile(
    join(svc.root, 'proposals.jsonl'),
    [
      { formatVersion: 2, kind: 'candidate', proposalId, versionSet: { capabilityTable: 'config.yml#doc1' }, mutation: capabilityMutation, actor: 'root-1', at: '2026-09-20T00:00:01.000Z' },
      { formatVersion: 2, kind: 'prepared', proposalId, sandbox: null, mechanical: false, champion: 'none', files: [], actor: 'root-1', at: '2026-09-20T00:00:02.000Z' },
      { formatVersion: 2, kind: 'gated', proposalId, gate: gateAnswers([`sandbox/${proposalId}/replay-report.json`]), actor: 'root-1', at: '2026-09-20T00:00:04.000Z' },
    ].map(line => JSON.stringify(line)).join('\n') + '\n',
  )
}

/** Walk one skill proposal to `gated` with the sandbox candidate holding `content`, its experiment recorded. */
async function skillCandidateGated(svc: EvolutionService, content: string, proposalId = 's1'): Promise<SkillContentIdentity> {
  // §F.2 evaluates a *replacement*: the fixture needs a production SKILL.md for
  // the candidate to replace, or the experiment has nothing to evaluate against.
  await productionSkill(svc.skillRoot)
  await svc.propose({ ...skillProposal, proposalId }, 'root-1')
  await svc.candidate(proposalId, VERSION_SET, 'root-1', { name: 'verify', content })
  await svc.prepare(proposalId, 'root-1')
  const identity = (await svc.get(proposalId)).prepared!.skillContent!
  const { reportPath } = await recordSkillExperiment(svc, proposalId)
  await svc.gate(proposalId, gateAnswers([reportPath]), 'root-1')
  return identity
}

/** The sandbox directory a skill candidate's own files live in. */
function skillCandidateDirectory(root: string, proposalId = 's1', name = 'verify'): string {
  return join(root, 'sandbox', proposalId, 'skills', name)
}

/**
 * The capability promotion path this describe used to exercise is gone: this
 * build's evaluator is the two-sided experiment for a single-file skill
 * replacement, so a capability row has no evaluator and its PROMOTE is refused
 * by name (§F.2 EVAL-4). What used to be the promotion-time provider check for a
 * replaced row lives on where it still has real consumers — `TaskRuntime`'s
 * registry mirror (`applyCapabilityRow`) and the admission pre-check — and is
 * covered by `task-runtime/tests/unit/capability.spec.ts` and
 * `tests/integration/provider-promotion.spec.ts`.
 */
describe('capability promotion has no evaluator (EVAL-4)', () => {
  it('refuses a hand-written gated capability lifecycle at the entry, writing nothing', async () => {
    const { svc, configFile } = await serviceWithProduction()
    const before = await readFile(configFile, 'utf8')
    await capabilityGatedLedger(svc, 'c2')
    const forged = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root: svc.root, skillRoot: svc.skillRoot })

    // The fold admits what the live entries write, and this build's `candidate`
    // admits a skill candidate only: a capability lifecycle cannot be folded
    // from a file either, so no `gated` capability proposal exists to decide.
    await expect(forged.list()).rejects.toThrow('targets "capability"')
    await expect(forged.get('c2')).rejects.toThrow('targets "capability"')
    await expect(forged.decide('c2', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow('targets "capability"')

    // Through the tools the same refusal reaches the caller, still without a
    // human being asked for a proposal that cannot be promoted.
    const { ctx, approval } = toolCtx(forged)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 'c2', decision: 'PROMOTE' }, exec('root-1'))) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('targets "capability"')
    const viaApplyTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 'c2' }, exec('root-1'))) as string
    expect(viaApplyTool).toContain('evolution_apply rejected:')
    expect(viaApplyTool).toContain('targets "capability"')
    expect(approval.request).not.toHaveBeenCalled()

    // Nothing was read out of the refused file and config.yml is byte-identical
    // to what it was.
    expect(await readFile(configFile, 'utf8')).toBe(before)
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('decided')
    expect(kinds).not.toContain('applied')
  })

  it('refuses an applied capability record at the entry, before an apply can read it', async () => {
    const { svc, configFile } = await serviceWithProduction()
    await capabilityGatedLedger(svc, 'c2')
    // The decided and applied lines an older ledger holds sit on top of the same
    // lifecycle; the refusal lands at the candidate line, so no apply entry ever
    // reads the decision or the applied record.
    await appendFile(join(svc.root, 'proposals.jsonl'), [
      { formatVersion: 2, kind: 'decided', proposalId: 'c2', decision: 'PROMOTE', approvalRef: 'approval:legacy', actor: 'root-1', at: '2026-09-20T00:00:05.000Z' },
      { formatVersion: 2, kind: 'applied', proposalId: 'c2', targets: [`${configFile} — document 1 task-runtime capabilities row "research"`], approvalRef: 'approval:apply', actor: 'root-1', at: '2026-09-20T00:00:06.000Z' },
    ].map(line => JSON.stringify(line)).join('\n') + '\n')
    const before = await readFile(configFile, 'utf8')
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root: svc.root, skillRoot: svc.skillRoot })

    await expect(reopened.list()).rejects.toThrow('targets "capability"')
    await expect(reopened.get('c2')).rejects.toThrow('targets "capability"')
    await expect(reopened.apply('c2', 'root-1', 'approval:call-1')).rejects.toThrow('targets "capability"')
    const { ctx, approval } = toolCtx(reopened)
    const viaApplyTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 'c2' }, exec('root-1'))) as string
    expect(viaApplyTool).toContain('evolution_apply rejected:')
    expect(viaApplyTool).toContain('targets "capability"')
    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(configFile, 'utf8')).toBe(before)
  })
})

describe('skill candidate provider pre-check (S1-C item 3)', () => {
  it('refuses an execution candidate whose verifier is unregistered, at decide, through the tool and at the service entry', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate claiming execution')
    const identity = await skillCandidateGated(svc, content)
    // The candidate's own sandbox directory carries an execution sidecar whose
    // verifier names nothing the deployment registered.
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
      sidecar: 'execution',
      verifierRef: 'ghost-verifier',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })

    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(/verifier-unknown/)
    expect((await svc.get('s1')).status).toBe('gated')
    // P2's identity check still passes — the candidate bytes did not move — so
    // it is the provider check that refuses, which is what P2 could not see.
    expect(await svc.readSkillCandidate('s1')).toEqual(Buffer.from(content, 'utf8'))
    expect(identity.sha256).toBe(sha256Of(content))

    const { ctx, approval } = toolCtx(svc)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 's1', decision: 'PROMOTE' }, exec('root-1'))) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('verifier-unknown')
    expect(approval.request).not.toHaveBeenCalled()

    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is gated')
    // Nothing written, nothing recorded: production still holds the baseline, and
    // no `applied` line was taken.
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses a candidate whose provider requires tools its declared capability does not grant', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate needing a shell')
    await skillCandidateGated(svc, content)
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
      sidecar: 'execution',
      verifierRef: 'command',
      // `research` is in the table and grants no tools at all.
      capabilities: ['research'],
      requiredTools: ['bash'],
    })

    await expect(svc.checkPromotion('s1')).rejects.toThrow(/tool-not-covered/)
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it.each([
    ['an execution sidecar', { sidecar: 'execution', verifierRef: 'command', capabilities: [PROMOTION_ROW], requiredTools: ['bash'] } as SkillShape],
    ['a knowledge sidecar', { sidecar: 'knowledge' } as SkillShape],
  ])('refuses a candidate carrying %s: the executor promotes single-file SKILL.md candidates only', async (_label, shape) => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# a candidate the single-file executor cannot carry')
    await skillCandidateGated(svc, content)
    // The declaration is well formed — an execution candidate even passes the
    // provider validator — and that is precisely the claim a promotion must not
    // make: production would receive SKILL.md and nothing else.
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, shape)

    const refusal = await svc.checkPromotion('s1').catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain('"SKILL.contract.json"')
    expect(refusal).toContain('promotes single-file SKILL.md candidates only')
    expect(refusal).not.toContain('execution-provider')

    // decide(PROMOTE), the tool before it asks a human, and the service entry
    // refuse alike: no decision recorded, no approval burned, no production write.
    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow('single-file SKILL.md candidates only')
    expect((await svc.get('s1')).status).toBe('gated')
    const { ctx, approval } = toolCtx(svc)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 's1', decision: 'PROMOTE' }, exec('root-1'))) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('single-file SKILL.md candidates only')
    expect(approval.request).not.toHaveBeenCalled()
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('decided')
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses the apply tool before asking the human when a sidecar appears after the decision', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate that gains a carryable-by-nobody sidecar')
    await skillCandidateGated(svc, content)
    // Decided while it was the single file the executor promotes; the declaration
    // that appears afterwards is exactly what production would not receive.
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
      sidecar: 'execution',
      verifierRef: 'command',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })

    const { ctx, approval } = toolCtx(svc)
    const refused = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(refused).toContain('evolution_apply rejected:')
    expect(refused).toContain('single-file SKILL.md candidates only')
    expect(refused).not.toContain('execution-provider')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses a candidate carrying a resource the executor would not write, sidecar or not', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate with a reference file')
    await skillCandidateGated(svc, content)
    const directory = skillCandidateDirectory(root)
    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(join(directory, 'references', 'notes.md'), 'a file this executor would never write\n')

    const refusal = await svc.checkPromotion('s1').catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain('"references/"')
    expect(refusal).toContain('promotes single-file SKILL.md candidates only')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect((await svc.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('promotes a candidate with no sidecar as guidance, keeping the P2/P3 path intact', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    const content = skillText('# guidance candidate')
    await skillCandidateGated(svc, content)

    const check = await svc.checkPromotion('s1')
    expect(check.providers).toMatchObject([{ name: 'verify', role: 'guidance' }])
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.providers).toMatchObject([{ name: 'verify', role: 'guidance' }])
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(content)
  })

  it('refuses a provider that cannot be judged because the verifier registry is unlistable (fail-closed)', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# execution candidate on a deployment with no verifier service')
    await skillCandidateGated(svc, content)
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
      sidecar: 'execution',
      verifierRef: 'command',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })

    // Same ledger, same sandbox, but a context with no verifier service: the ref
    // cannot be proven registered, so the candidate is refused rather than
    // assumed valid — the same refusal admission gives the same situation.
    const bare = new EvolutionService(
      { reflect: { provide: () => {} }, effect: () => {}, taskRuntime: { listCapabilities: () => structuredClone(FIXTURE_CAPABILITIES) } } as never,
      { root, skillRoot },
    )
    await expect(bare.checkPromotion('s1')).rejects.toThrow(/verifier registry cannot be listed/)
    expect(await ledgerKinds(root)).not.toContain('applied')
  })

  it('refuses the apply before asking the human when a sidecar appears after the decision', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# guidance candidate that gains a sidecar')
    await skillCandidateGated(svc, content)
    // The candidate is guidance when it is decided; nothing about its bytes
    // changes afterwards — only a declaration the reviewed version did not have.
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
      sidecar: 'execution',
      verifierRef: 'ghost-verifier',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })

    const { ctx, approval } = toolCtx(svc)
    const refused = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(refused).toContain('evolution_apply rejected:')
    expect(refused).toContain('verifier-unknown')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses at the service entry when the sidecar appears while the human is deciding', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate that gains a sidecar while the human decides')
    await skillCandidateGated(svc, content)
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const approval = {
      request: vi.fn(async () => {
        await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
          sidecar: 'execution',
          verifierRef: 'ghost-verifier',
          capabilities: [PROMOTION_ROW],
          requiredTools: ['bash'],
        })
        return 'allowed-once' as const
      }),
    }
    const base = toolCtx(svc)
    const ctx = { ...(base.ctx as unknown as Record<string, unknown>), approval } as never

    const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('verifier-unknown')
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })
})
