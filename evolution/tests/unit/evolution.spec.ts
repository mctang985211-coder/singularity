import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityConfig, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import {
  SKILL_SIDECAR_FILE,
  registryRevision,
  serializeSkillSidecar,
  sidecarWithSkillMd,
  skillContentDigest,
  skillContractDigest,
} from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService } from '../../src/evolution.ts'
import type { Config, GateAnswers, ProposeInput } from '../../src/evolution.ts'
import type { CommitStage, ReconcileOutcome } from '../../src/commit.ts'
import {
  buildExperimentReport,
  directoryDigest,
  experimentIdOf,
  experimentLineage,
  experimentReportPath,
} from '../../src/experiment/record.ts'
import type { FrozenExperiment, FrozenProviderIdentity, FrozenSample, SkillContentIdentity } from '../../src/replay.ts'
import {
  digestOf,
  EXPERIMENT_COMPARER_VERSION,
  frozenDigestOf,
  modelSelectionOf,
  protectedInputsDigest,
} from '../../src/replay.ts'
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
  return {
    capabilities: [],
    registryRevision: FIXTURE_REGISTRY_REVISION,
    candidateRegistryRevision: FIXTURE_REGISTRY_REVISION,
    mcpServers: [],
    preset: null,
    skills: [],
  }
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
    data: {
      header: { config: { provider: FIXTURE_SELECTION.provider, model: FIXTURE_SELECTION.model } },
      reason: 'initial',
    },
  }
}

/** One side's run row, with the provider binding the gate compares to the frozen identity. */
function fixtureSideRun(input: {
  runId: string
  taskId: string
  outcome: string
  at: string
}): Record<string, unknown> {
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
  if (rows === undefined)
    throw new Error('this service was not built on fixtureCtx(), so it has no promotion store to fill')
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

/**
 * The production fixture contents (K3). Prepare reads the production object
 * through the same loader a provider check uses, so a fixture production
 * `SKILL.md` must be a loadable file — frontmatter included — and every case
 * that only needs "some production bytes" says so through one of these.
 */
const PRODUCTION_V1 = skillText('# old verify skill')
const PRODUCTION_OLD = skillText('old skill text')
const PRODUCTION_REPLACED = skillText('# the production skill the candidate replaces')
const PRODUCTION_CHAMPION = skillText('champion')

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

vi.mock('node:fs/promises', async importOriginal => {
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
    const decided = await svc.decide(
      's1',
      'KEEP_FOR_FURTHER_RESEARCH',
      'root-1',
      'approval:call-1',
      'approved by human',
    )
    expect(decided.status).toBe('decided')
    expect(decided.decision).toBe('KEEP_FOR_FURTHER_RESEARCH')
    expect(decided.decisionNote).toBe('approved by human')
    expect(decided.decisionApprovalRef).toBe('approval:call-1')
    expect(decided.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
    ])
  })

  it('rejects state-machine skips: gate on proposed, decide on candidate, candidate twice', async () => {
    const { svc } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow('cannot record "gated"')
    await expect(svc.decide('s1', 'REJECT', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "decided"')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(
      svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') }),
    ).rejects.toThrow('cannot record "candidate"')
    await expect(svc.propose(skillProposal, 'root-1')).rejects.toThrow('already exists')
    // and an unprepared candidate cannot gate: prepared is the one next state
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow(
      /cannot record "gated".*evolution_prepare/,
    )
  })

  it('rejects moves on an unknown proposal id', async () => {
    const svc = await service()
    await expect(
      svc.candidate('ghost', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') }),
    ).rejects.toThrow('unknown proposal "ghost"')
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
    await expect(svc.candidate('s1', { verifier: 1 as never }, 'root-1', mutation)).rejects.toThrow(
      'versionSet["verifier"]',
    )
  })

  it('requires all six gate answers and existence-checked regression evidence refs', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await expect(svc.gate('s1', { ...gateAnswers([reportPath]), targetFailureFixed: '' }, 'root-1')).rejects.toThrow(
      'Target failure fixed',
    )
    await expect(svc.gate('s1', gateAnswers([]), 'root-1')).rejects.toThrow('at least one evidence ref')
    await expect(svc.gate('s1', gateAnswers([reportPath, 'no/such/path.log']), 'root-1')).rejects.toThrow(
      'no known evidence id and no existing path',
    )
    // a resolver id (task-store evidence) also satisfies existence — checked, never executed
    await svc.gate('s1', gateAnswers([reportPath, 'evidence-r1-abc']), 'root-1', async ref => ref === 'evidence-r1-abc')
    expect((await svc.get('s1')).status).toBe('gated')
  })

  it('requires human-approval evidence on decide and records it on the ledger line', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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
    expect(lines.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      'proposed',
      'proposed',
      'candidate',
    ])
    // close: drain writes, reopen a fresh service on the same root, replay must fold to the same state
    const reopened = reopenLike(first, { modelSelection: () => FIXTURE_SELECTION, root })
    expect(await reopened.list()).toEqual(live)
    expect((await reopened.get('s1')).status).toBe('candidate')
    expect((await reopened.get('p2')).level).toBe('L4')
  })

  it('announces each durable append with its proposal, and nothing when the write refuses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const changes: string[] = []
    const ctx = fixtureCtx() as unknown as { emit: (name: string, payload: { proposalId: string }) => void }
    ctx.emit = (name, payload) => {
      if (name === 'evolution/change') changes.push(payload.proposalId)
    }
    const svc = new EvolutionService(ctx as never, { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(proposal, 'root-1')
    expect(changes).toEqual(['p1'])
    // A refused write announced nothing: the duplicate never reached the ledger.
    await expect(svc.propose(proposal, 'root-1')).rejects.toThrow('already exists')
    expect(changes).toEqual(['p1'])
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
    const forged = { formatVersion: 4, kind: 'decided', proposalId: 'p1', decision: 'PROMOTE', actor: 'x', at: 'now' }
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
          {
            // A diagnosis written after A5 opened the target-type vocabulary:
            // a suggestion Evolution has no executor (and no vocabulary) for.
            diagnosisId: 'd-unknown',
            taskId: 't1',
            observedFailure: 'the reviewer prompt never names the empty-input case',
            scope: 'this task',
            localizedCause: 'the request is underspecified',
            evidenceRefs: ['ev-1'],
            reviewRefs: ['t1#r1'],
            confidence: 'low',
            proposals: [
              { targetType: 'prompt_template', targetId: 'reviewer', rationale: 'name the empty-input case' },
            ],
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

  /** The next-step line follows the two candidate kinds this build supports. */
  it('evolution_propose points skill and capability proposals at evolution_candidate', async () => {
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
    expect(suggestion).toContain('next: evolution_candidate')
    expect(suggestion).toContain('exactly one whole capability row')
    expect(suggestion).not.toContain('next: evolution_prepare')
    expect((await svc.get('cap-suggestion')).status).toBe('proposed')

    const replacement = (await tool.execute({ ...skillProposal }, exec('root-1'))) as string
    expect(replacement).toContain('next: evolution_candidate')

    // The next-step line is wording, not a lifecycle: both proposals still hold
    // only their own `proposed` line until evolution_candidate is called.
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
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
        {
          proposalId: 'p2',
          level: 'L2',
          baseVersion: 'v3',
          targetId: 'x',
          fromDiagnosis: { diagnosisId: 'd1', proposalIndex: 0 },
        },
        exec('root-1'),
      ),
    ).rejects.toThrow('do not pass both')
    const missing = (await tool
      .execute({ proposalId: 'p2', level: 'L2', baseVersion: 'v3' }, exec('root-1'))
      .catch((error: Error) => String(error))) as string
    expect(missing).toContain('required without fromDiagnosis')
  })

  /**
   * The other half of A5's open vocabulary: a diagnosis may carry any target
   * type, and Evolution — which owns the mutation surfaces it can execute —
   * re-validates at the conversion entry. A transcription it cannot execute is
   * refused by name, before the ledger is touched, so a suggestion no executor
   * can take up never becomes an EvolutionProposal.
   */
  it('evolution_propose refuses a diagnosis proposal whose target type it cannot execute, with zero ledger writes', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    expect(existsSync(join(svc.root, 'proposals.jsonl'))).toBe(false)

    const rejected = (await tool
      .execute(
        {
          proposalId: 'p-unsupported',
          level: 'L2',
          baseVersion: 'v3',
          fromDiagnosis: { diagnosisId: 'd-unknown', proposalIndex: 0 },
        },
        exec('root-1'),
      )
      .catch((error: Error) => String(error))) as string
    expect(rejected).toContain('prompt_template')
    expect(rejected).toContain('d-unknown')
    expect(rejected).toContain('targetType')

    // Nothing was recorded: no proposal, no ledger line, no sandbox.
    expect(await svc.list()).toEqual([])
    expect(existsSync(join(svc.root, 'proposals.jsonl'))).toBe(false)
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
  })

  it('evolution_propose rejects a targetType outside the frozen vocabulary', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const rejected = (await tool
      .execute({ ...proposal, targetType: 'prompt' }, exec('root-1'))
      .catch((error: Error) => String(error))) as string
    expect(rejected).toContain('targetType')
    expect(await svc.list()).toEqual([])
  })

  it('evolution tools reject a call carrying no agent identity', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await expect(defineEvolutionProposeTool(ctx).execute({ ...proposal }, {} as never)).rejects.toThrow(
      'missing agent id',
    )
    await expect(
      defineEvolutionCandidateTool(ctx).execute(
        {
          proposalId: 'p1',
          versionSet: VERSION_SET,
          mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
        },
        {} as never,
      ),
    ).rejects.toThrow('missing agent id')
    await expect(defineEvolutionPrepareTool(ctx).execute({ proposalId: 'p1' }, {} as never)).rejects.toThrow(
      'missing agent id',
    )
    expect(await svc.list()).toEqual([])
  })

  it('evolution_candidate and evolution_prepare move the skill proposal and stay ledger-only', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const candidate = (await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )) as string
    expect(candidate).toContain('[candidate] version set: taskDefinition=v3, verifier=v1')
    const prepared = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(prepared).toContain('[prepared] sandbox:')
    expect(prepared).toContain('next: evolution_replay')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('evolution_candidate refuses a mutation of the shape this build does not write, recording nothing', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const before = await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')
    // The old bookkeeping shape matches neither candidate kind, so the service
    // refuses it before the ledger is reached.
    const rejected = (await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ baseVersion: 'v3', definition: { objective: 'x' } }),
      },
      exec('root-1'),
    )) as string
    expect(rejected).toContain('evolution_candidate rejected:')
    expect(rejected).toContain('skill mutation has unknown key "baseVersion"')
    expect(await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('evolution_candidate takes a capability mutation of the one-whole-row shape through the model surface', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    const accepted = (await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 'c1',
        versionSet: { capabilityTable: 'config.yml#doc1' },
        mutationJson: JSON.stringify({ rows: { research: { skills: ['verify'], tools: ['filesystem'] } } }),
      },
      exec('root-1'),
    )) as string
    expect(accepted).toContain('[candidate]')
    expect(accepted).toContain('evolution_prepare')
    const stored = await svc.get('c1')
    expect(stored.status).toBe('candidate')
    expect(stored.mutation).toEqual({ rows: { research: { skills: ['verify'], tools: ['filesystem'] } } })
  })

  it('evolution_gate rejects evidence refs unknown to the task store and the disk', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx, approval } = toolCtx(svc, 'allowed-once')
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new verify skill') }),
      },
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
    expect(request.reason).toContain(
      `3. Existing regression maintained? full suite replayed green [evidence: ${reportPath}]`,
    )
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
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
      const { ctx, approval } = toolCtx(svc, outcome)
      await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
      await defineEvolutionCandidateTool(ctx).execute(
        {
          proposalId: 's1',
          versionSet: VERSION_SET,
          mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
        },
        exec('root-1'),
      )
      await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
      const { reportPath } = await recordSkillExperiment(svc, 's1')
      await defineEvolutionGateTool(ctx).execute({ proposalId: 's1', ...gateAnswers([reportPath]) }, exec('root-1'))
      const result = (await defineEvolutionDecideTool(ctx).execute(
        { proposalId: 's1', decision: 'REJECT' },
        exec('root-1'),
      )) as string
      expect(approval.request).toHaveBeenCalledOnce()
      expect(result).toContain('no decision recorded')
      expect(result).toContain('stays gated')
      expect((await svc.get('s1')).status).toBe('gated')
      const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      expect(
        lines.map(line => (JSON.parse(line) as { kind: string }).kind).filter(kind => !kind.startsWith('experiment_')),
      ).toEqual(['proposed', 'candidate', 'prepared', 'gated'])
    },
  )

  it('evolution_decide refuses a proposal that is not gated, without asking the human', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 'p1', decision: 'REJECT' },
      exec('root-1'),
    )) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(result).toContain('is proposed; only a gated proposal can be decided')
  })

  it('evolution_list filters and renders derived history', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc, 'rejected')
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionProposeTool(ctx).execute(
      {
        ...proposal,
        proposalId: 'p2',
        targetType: 'verifier',
        targetId: 'verifier:1',
        level: 'L4',
        sourceRefs: ['evidence:ev-1'],
      },
      exec('root-1'),
    )
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('x') }),
      },
      exec('root-1'),
    )
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
  await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_REPLACED)
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
 * (§F.2; A6 adds the capability lifecycle beside it, with its own rules and its
 * own gate — `capability-candidate.spec.ts`). Every other proposal stays
 * `proposed` forever, which is the expected end state.
 */
describe('EvolutionService candidate admission (S4-E 收尾, A6)', () => {
  it.each([
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
    await svc.propose(
      { ...proposal, proposalId: 'w1', targetType: 'workflow_policy', targetId: 'workflow:1' },
      'root-1',
    )
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
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
    expect(decided.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
    ])
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new skill text') })
    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.status).toBe('prepared')
    expect(prepared.prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      // P2: the identity is the SHA-256 of the exact materialized bytes
      skillContent: {
        name: 'verify',
        sha256: createHash('sha256').update(skillText('new skill text'), 'utf8').digest('hex'),
      },
      // P3: the production baseline digest, from the same read as the snapshot
      skillBaseline: { name: 'verify', sha256: createHash('sha256').update(PRODUCTION_OLD, 'utf8').digest('hex') },
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
    })
    expect(await readFile(join(root, 'sandbox', 's1', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(
      skillText('new skill text'),
    )
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(
      PRODUCTION_OLD,
    )
  })

  it('snapshots the exact production bytes used for the baseline digest', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    // A loadable production object (K3: prepare reads it through the loader)
    // whose bytes are compared exactly at the end, so "the digest is the
    // snapshot's" cannot be read off two different reads.
    const bytes = Buffer.from(skillText('# the production bytes the champion must be'), 'utf8')
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), bytes)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('new') })
    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.prepared?.skillBaseline?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'))).toEqual(bytes)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'))).toEqual(bytes)
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
    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow(/production skill .*verify\/SKILL\.md" does not exist/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
  })

  it('confines every write to the sandbox dir; production roots stay untouched', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new skill text') })
    await svc.prepare('s1', 'root-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_OLD)
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
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
      skillBaseline: { name: 'verify', sha256: createHash('sha256').update(PRODUCTION_OLD, 'utf8').digest('hex') },
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
    })
  })

  it('fails loud when a prepared record lies about mechanical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    const forged = {
      formatVersion: 4,
      kind: 'prepared',
      proposalId: 's1',
      sandbox: 'sandbox/s1',
      mechanical: false,
      champion: 'captured',
      files: ['x'],
      actor: 'x',
      at: 'now',
    }
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
      formatVersion: 4,
      kind: 'candidate',
      proposalId: 's1',
      versionSet: {},
      mutation: { name: 'verify', content: skillText('x') },
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forgedCandidate)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('at least one version')

    // an empty gate answer would never survive gate()
    const root2 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot2 = join(root2, 'skills')
    await mkdir(join(skillRoot2, 'verify'), { recursive: true })
    await writeFile(join(skillRoot2, 'verify', 'SKILL.md'), PRODUCTION_REPLACED)
    const svc2 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: root2,
      skillRoot: skillRoot2,
    })
    await svc2.propose(skillProposal, 'root-1')
    await svc2.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    // A gated record is legal only after the one transition a candidate admits,
    // so the live entries walk to prepared and the forged line lands on top.
    await svc2.prepare('s1', 'root-1')
    const emptyAnswer = {
      formatVersion: 4,
      kind: 'gated',
      proposalId: 's1',
      gate: { ...gateAnswers(['ev-1']), targetFailureFixed: '' },
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root2, 'proposals.jsonl'), `${JSON.stringify(emptyAnswer)}\n`, { flag: 'a' })
    const reopened2 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: root2,
      skillRoot: skillRoot2,
    })
    await expect(reopened2.list()).rejects.toThrow('Target failure fixed')

    // zero regression evidence refs would never survive gate() either
    const root3 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot3 = join(root3, 'skills')
    await mkdir(join(skillRoot3, 'verify'), { recursive: true })
    await writeFile(join(skillRoot3, 'verify', 'SKILL.md'), PRODUCTION_REPLACED)
    const svc3 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: root3,
      skillRoot: skillRoot3,
    })
    await svc3.propose(skillProposal, 'root-1')
    await svc3.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc3.prepare('s1', 'root-1')
    const noEvidence = {
      formatVersion: 4,
      kind: 'gated',
      proposalId: 's1',
      gate: gateAnswers([]),
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root3, 'proposals.jsonl'), `${JSON.stringify(noEvidence)}\n`, { flag: 'a' })
    const reopened3 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: root3,
      skillRoot: skillRoot3,
    })
    await expect(reopened3.list()).rejects.toThrow('at least one evidence ref')
  })
})

describe('evolution_prepare tool', () => {
  it('evolution_candidate accepts a structured skill mutation and points at evolution_prepare', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const result = (await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: { skill: 'v2' },
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
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
      { proposalId: 's1', versionSet: VERSION_SET, mutationJson: JSON.stringify({ name: 'a/b', content: 'x' }) },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_candidate rejected:')
    expect(result).toContain('mutation.name')
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('evolution_prepare materializes the skill candidate and snapshots the champion SKILL.md', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('proposal s1 [prepared]')
    expect(result).toContain('wrote skills/verify/SKILL.md')
    expect(result).toContain('champion snapshot: captured under champion/')
    expect(result).toContain('production baseline: verify sha256:')
    expect(result).toContain('production was not touched')
    expect(await readFile(join(svc.root, 'sandbox', 's1', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(
      skillText('# new'),
    )
    expect(await readFile(join(svc.root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(
      PRODUCTION_V1,
    )
  })

  it('evolution_prepare refuses a production skill that does not exist, writing nothing', async () => {
    const { svc, root } = await serviceWithRoots()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('evolution_prepare rejected:')
    expect(result).toContain('does not exist')
    expect(result).toContain('a new skill cannot be evaluated or promoted by this path')
    expect(result).not.toContain('create the skill in production')
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
    // The candidate tool's schema requires `mutationJson`, so a call carrying none
    // is refused before the tool body runs and never reaches the ledger.
    await expect(
      defineEvolutionCandidateTool(ctx).execute({ proposalId: 's1', versionSet: VERSION_SET }, exec('root-1')),
    ).rejects.toThrow('missing required property "mutationJson"')
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
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )
    const result = (await defineEvolutionGateTool(ctx).execute(
      { proposalId: 's1', ...gateAnswers(['ev-1']) },
      exec('root-1'),
    )) as string
    expect(result).toContain('cannot record "gated"')
    expect(result).toContain('evolution_prepare')
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('evolution_list renders the prepared status with sandbox path and champion state', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )
    await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const list = defineEvolutionListTool(ctx)
    const all = (await list.execute({}, exec('root-1'))) as string
    expect(all).toContain('- s1 [prepared] L2 skill verify (base v1)')
    expect(all).toContain('mutation: skill mutation recorded')
    expect(all).toContain(`sandbox: ${svc.root}/sandbox/s1 (2 files, guidance (SKILL.md), champion snapshot captured`)
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
    await expect(svc.gate('s1', gateAnswers([evidenceFile]), 'root-1')).rejects.toThrow(
      `must cite its experiment report "${reportPath}"`,
    )
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
    await expect(svc.gate('s1', gateAnswers([reportPath]), 'root-1')).rejects.toThrow(
      'no longer exists under the ledger root',
    )
  })

  it('gates a skill candidate on a completed experiment only', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await requireProductionSkill(skillRoot)
    await svc.prepare('s1', 'root-1')
    await expect(svc.gate('s1', gateAnswers(['sandbox/s1/replay-report.json']), 'root-1')).rejects.toThrow(
      'has no two-sided experiment',
    )
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('folds a ledger holding a recorded experiment back to the same view after reopen', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
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
  const base = {
    taskId: 't1',
    outcome: 'verified' as const,
    criteria: [{ criterionId: 'ac1', verdict: 'pass' as const }],
  }

  it('matching sides compare not-worse with verdictMatch', () => {
    const result = compareReplaySides(base, { ...base })
    expect(result).toEqual({ verdictMatch: true, criteriaDiff: [], relation: 'not-worse' })
  })

  it('a failed candidate against a verified champion is worse', () => {
    const result = compareReplaySides(base, {
      ...base,
      outcome: 'failed',
      criteria: [{ criterionId: 'ac1', verdict: 'fail' }],
    })
    expect(result.relation).toBe('worse')
    expect(result.verdictMatch).toBe(false)
    expect(result.criteriaDiff).toEqual([{ criterionId: 'ac1', champion: 'pass', candidate: 'fail' }])
  })

  it('a shared criterion flipping pass → fail is a regression even when the outcome holds', () => {
    const result = compareReplaySides(
      {
        ...base,
        criteria: [
          { criterionId: 'ac1', verdict: 'pass' },
          { criterionId: 'ac2', verdict: 'fail' },
        ],
      },
      {
        ...base,
        outcome: 'failed',
        criteria: [
          { criterionId: 'ac1', verdict: 'fail' },
          { criterionId: 'ac2', verdict: 'fail' },
        ],
      },
    )
    // failed vs failed ranks equal, but ac1 flipped pass → fail
    expect(result.relation).toBe('worse')
  })

  it('a candidate fixing a failed champion is not-worse', () => {
    const champion = {
      taskId: 't1',
      outcome: 'failed' as const,
      criteria: [{ criterionId: 'ac1', verdict: 'fail' as const }],
    }
    const result = compareReplaySides(champion, {
      taskId: 't1',
      outcome: 'verified',
      criteria: [{ criterionId: 'ac1', verdict: 'pass' }],
    })
    expect(result.relation).toBe('not-worse')
    expect(result.verdictMatch).toBe(false)
  })

  it('an added criterion makes the contract comparison inconclusive', () => {
    const result = compareReplaySides(base, {
      ...base,
      criteria: [
        { criterionId: 'ac1', verdict: 'pass' },
        { criterionId: 'ac2', verdict: 'pass' },
      ],
    })
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
  acceptanceCriteria: [
    {
      criterionId: 'ac1-1',
      description: 'works',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    },
  ],
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
 * The capability table the fixture's production configuration holds, and the
 * content digest its pre-check reports for the skill the candidate replaces
 * (K3): one row granting one guidance skill.
 */
const FIXTURE_CAPABILITY_TABLE = { research: { skills: ['verify'], preset: 'standard' } }
const FIXTURE_PROVIDER_CONTENT_DIGEST = skillContentDigest({
  skillMdSha256: createHash('sha256').update(PRODUCTION_V1, 'utf8').digest('hex'),
  resources: [],
})

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
  const replayTask = vi.fn(
    async (_storeId: string, championTaskId: string, replayOptions: ReplayTaskOptions, _caller: string) => {
      replayed += 1
      const taskId = `t-replay-${replayed}`
      const runId = `r-replay-${replayed}`
      const criterionId = championTaskId === 't-fail' ? 'ac-fix' : 'ac-holdout'
      const candidateSide = replayOptions.overlay !== undefined
      const outcome = candidateSide || criterionId !== 'ac-fix' ? ('verified' as const) : ('failed' as const)
      store.settle(taskId, runId, criterionId, outcome, String(replayOptions.lineage))
      return {
        taskId,
        runId,
        status: outcome,
        durationMs: 3,
        criteria: [
          {
            criterionId,
            verdict: outcome === 'verified' ? ('pass' as const) : ('fail' as const),
            verifierId: FIXTURE_JUDGE.ref,
            verifierVersion: FIXTURE_JUDGE.version,
          },
        ],
      }
    },
  )
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    approval: { request: vi.fn(async () => 'allowed-once') },
    graphs: { graphForSession: vi.fn(async () => graph) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    taskRuntime: {
      // The production configuration the samples' rows resolve to (K3): the row
      // grants the skill the candidate replaces, as guidance — the provider list
      // the frozen candidate registry revision is defined over.
      listCapabilities: vi.fn(() => ({ research: { skills: ['verify'], preset: 'standard' } })),
      capabilityProviderReport: vi.fn(async () => ({
        capabilities: [
          {
            capability: 'research',
            skills: [
              {
                valid: true,
                name: 'verify',
                role: 'guidance',
                contractDigest: null,
                contentDigest: FIXTURE_PROVIDER_CONTENT_DIGEST,
              },
            ],
          },
        ],
        revision: registryRevision(FIXTURE_CAPABILITY_TABLE, [{ name: 'verify', contractDigest: null }]),
      })),
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
  const production = options.production ?? PRODUCTION_V1
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(join(skillRoot, 'verify', 'SKILL.md'), production)
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n')
  await svc.propose(skillProposal, 'root-1')
  await svc.candidate('s1', { skill: 'v2' }, 'root-1', {
    name: 'verify',
    content: options.candidate ?? SKILL_CANDIDATE,
  })
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
        diagnoses: [],
        obligations: [],
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
      acceptanceCriteria: [
        {
          criterionId,
          description: 'works',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'true',
          verifierRef: FIXTURE_JUDGE.ref,
        },
      ],
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
      criteria: [
        {
          criterionId,
          verdict: outcome === 'verified' ? 'pass' : 'fail',
          verifierId: FIXTURE_JUDGE.ref,
          verifierVersion: FIXTURE_JUDGE.version,
        },
      ],
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
  interface Row {
    [key: string]: unknown
  }
  const tasks: Row[] = [
    championTask,
    FAILED_SAMPLE.task as Row,
    HOLDOUT_SAMPLE.task as Row,
    REGRESSION_SAMPLE.task as Row,
  ]
  const runs: Row[] = [FAILED_SAMPLE.run as Row, HOLDOUT_SAMPLE.run as Row, REGRESSION_SAMPLE.run as Row]
  const reviews: Row[] = [
    championReview,
    FAILED_SAMPLE.review as Row,
    HOLDOUT_SAMPLE.review as Row,
    REGRESSION_SAMPLE.review as Row,
  ]
  return {
    sessions,
    snapshot: () => ({
      tasks: [...tasks],
      runs: [...runs],
      reviews: [...reviews],
      diagnoses: [],
      obligations: [],
      evidence: [],
    }),
    /**
     * Record one side a replay settled: task, run and the terminal review the
     * report reads, plus the two durable facts the promotion gate re-reads
     * (S4-E §Q3) — the run's provider binding, and the request its session log
     * records.
     */
    settle(
      taskId: string,
      runId: string,
      criterionId: string,
      outcome: 'verified' | 'failed',
      lineage: string,
      request?: { provider: string; model: string },
    ) {
      const settled = sampleCase(taskId, runId, criterionId, outcome)
      tasks.push({ ...settled.task, parentTaskId: undefined, objective: `[${lineage}] ${taskId}` })
      runs.push({
        ...(settled.run as Row),
        providerBinding: { registryRevision: FIXTURE_REGISTRY_REVISION, capabilities: [], skills: [], mcpServers: [] },
      })
      const selection = request ?? { provider: FIXTURE_SELECTION.provider, model: FIXTURE_SELECTION.model }
      sessions.set(String((settled.run as { sessionId?: unknown }).sessionId), [
        {
          type: 'request/header',
          seq: 1,
          time: 0,
          data: { header: { config: selection }, reason: 'initial' },
        },
      ])
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

  it('refuses a capability proposal that was never prepared: no run, no sandbox and no ledger write', async () => {
    const svc = await service()
    const replayTask = vi.fn(async () => ({ ...replayOutcome }))
    const { ctx } = replayToolCtx(svc, replayTask)
    const tool = defineEvolutionReplayTool(ctx)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    const before = await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')

    // A capability candidate is evaluable here since A6 — and only once it is
    // prepared, because the two-sided experiment mounts the row and the new skill
    // prepare froze. An unprepared proposal never reaches a run.
    const refused = (await tool.execute(
      { proposalId: 'c1', taskIds: ['t-champ'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(refused).toContain('evolution_replay rejected:')
    // The capability target type is no longer what this tool refuses: what it
    // refuses here is the sample derivation, which happens before anything is
    // read from the ledger — the fixture store holds no failed case to reproduce.
    expect(refused).toMatch(/none of taskIds has a failed latest review/)
    expect(refused).not.toMatch(/prepared skill object candidate only/)
    expect(replayTask).not.toHaveBeenCalled()
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
    expect(await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('c1')).status).toBe('proposed')
  })

  it('walks a skill candidate through the two-sided experiment: four sides, the sandbox overlay only on the candidate side', async () => {
    const { svc, root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    const result = (await replayTool.execute(
      {
        proposalId: 's1',
        taskIds: ['t-fail'],
        holdoutTaskIds: ['t-holdout'],
        budget: { maxTokens: 5_000, note: 'the fixture budget' },
      },
      exec('root-1'),
    )) as string

    // The answer renders the experiment: both sides of every sample, and the
    // baseline named as this experiment's own new run.
    expect(result).toContain('proposal s1 [experiment] skill verify — verdict: fixed')
    expect(result).toContain(
      't-fail [observed-failure] baseline failed → candidate verified (ac-fix fail→pass) — fixed',
    )
    expect(result).toContain(
      't-holdout [holdout] baseline verified → candidate verified (no criterion diff) — maintained',
    )
    expect(result).toContain('report: sandbox/s1/exp-')
    expect(result).not.toContain('champion')

    // Four runs: every sample twice, the baseline under the production
    // configuration and the candidate under the sandbox's skills dir.
    expect(replayTask).toHaveBeenCalledTimes(4)
    const sides = replayTask.mock.calls.map(call => [call[1], call[2].overlay === undefined ? 'baseline' : 'candidate'])
    expect(sides).toEqual([
      ['t-fail', 'baseline'],
      ['t-fail', 'candidate'],
      ['t-holdout', 'baseline'],
      ['t-holdout', 'candidate'],
    ])
    for (const [storeId, _sample, options, caller] of replayTask.mock.calls.map(
      call => call as unknown as [string, string, ReplayTaskOptions, string],
    )) {
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
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    const started = lines.find(line => line.kind === 'experiment_started') as { frozen: Record<string, any> }
    expect(started.frozen.candidate).toEqual(experiment.identity)
    expect(started.frozen.productionBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(PRODUCTION_V1, 'utf8').digest('hex'),
    })
    expect(
      started.frozen.samples.map((sample: { taskId: string; role: string }) => [sample.taskId, sample.role]),
    ).toEqual([
      ['t-fail', 'observed-failure'],
      ['t-holdout', 'holdout'],
    ])
    expect(started.frozen.snapshot.sourceDir).toBe(experiment.workspace)
    expect(started.frozen.snapshot.digest).toBe(snapshotDigest({ 'input.txt': 'the frozen input\n' }))
    expect(started.frozen.model).toEqual(FIXTURE_SELECTION)
    expect(started.frozen.budget).toEqual({ maxTokens: 5_000, note: 'the fixture budget' })
    expect(started.frozen.overlay.baseline).toContain('none')
    // The candidate's line names the complete object the sandbox root is loaded
    // from (K3), never a bare root a reader could mistake for one file.
    expect(started.frozen.overlay.candidate).toBe(
      'extraSkillRoots: [sandbox/s1/skills] — the complete candidate object: the guidance object "verify" (SKILL.md alone, no sidecar), ' +
        "loaded whole through the runtime's own discovery",
    )
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
    const message = await refusalOf(
      svc.runExperiment(
        {
          proposalId: 's1',
          samples: [
            { taskId: 't-fail', role: 'observed-failure' },
            { taskId: 't-holdout', role: 'holdout' },
          ],
          snapshot: { sourceDir: workspace },
          model: FIXTURE_SELECTION,
          budget: { wallTimeMs: 60_000 } as never,
          repetition: 0,
        },
        'root-1' as never,
        'root-1',
      ),
    )
    expect(message).toContain('wallTimeMs')
    expect(message).toMatch(/removed/)

    // The model's own entry refuses it at the schema boundary — the field is no
    // longer declared, so the call never reaches the service — and neither call
    // left a ledger line or started a run.
    const answer = await refusalOf(
      replayTool.execute(
        {
          proposalId: 's1',
          taskIds: ['t-fail'],
          holdoutTaskIds: ['t-holdout'],
          budget: { wallTimeMs: 60_000 },
        },
        exec('root-1'),
      ),
    )
    expect(answer).toContain('budget.wallTimeMs')
    expect(answer).toContain('not a declared property')
    expect(replayTask).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(ledgerBefore)
  })

  it('reuses every settled side when the same skill call is repeated: no run, no new ledger line', async () => {
    const { root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    const first = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(replayTask).toHaveBeenCalledTimes(4)

    const second = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(second).toBe(first)
    expect(replayTask).toHaveBeenCalledTimes(4)
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string })
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
    const noFailure = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-regression'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(noFailure).toContain('evolution_replay rejected:')
    expect(noFailure).toContain('no observed failure for this candidate to fix')

    const noHoldout = (await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'] }, exec('root-1'))) as string
    expect(noHoldout).toContain('holdoutTaskIds must name at least one task that did not select this candidate')

    expect(replayTask).not.toHaveBeenCalled()
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string })
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
  options: {
    failure?: { baseline?: string; candidate?: string }
    holdout?: { baseline?: string; candidate?: string }
    budget?: Record<string, unknown>
  } = {},
): Promise<{ reportPath: string; experimentId: string }> {
  const proposal = await svc.get(proposalId)
  const candidate = proposal.prepared!.skillContent!
  const baseline = proposal.prepared!.skillBaseline!
  const rows = promotionRows(svc)
  const workspace = join(await mkdtemp(join(tmpdir(), 'evolution-promotion-')), 'env')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'input.txt'), 'the frozen input\n')
  const samples: FrozenSample[] = []
  const sample = (
    taskId: string,
    role: FrozenSample['role'],
    criterionId: string,
    command: string,
    outcome: 'verified' | 'failed',
  ) => {
    const acceptanceCriteria = [
      {
        criterionId,
        description: 'works',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command,
        verifierRef: FIXTURE_JUDGE.ref,
      },
    ]
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
      criteria: [
        {
          criterionId,
          verificationMode: 'deterministic',
          command,
          protectedInputsDigest: protectedInputsDigest([]),
          verifierRef: FIXTURE_JUDGE.ref,
          verifierVersion: FIXTURE_JUDGE.version,
          verifierAnchor: `registered verifier "${FIXTURE_JUDGE.ref}" declares version "${FIXTURE_JUDGE.version}"`,
        },
      ],
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
    formatVersion: 4,
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
    const settlements =
      entry.taskId === 't-fail'
        ? { baseline: options.failure?.baseline ?? 'failed', candidate: options.failure?.candidate ?? 'verified' }
        : { baseline: options.holdout?.baseline ?? 'verified', candidate: options.holdout?.candidate ?? 'verified' }
    for (const side of ['baseline', 'candidate'] as const) {
      const settlement = settlements[side] as 'verified' | 'failed' | 'cancelled'
      const lineage = experimentLineage(experimentId, entry.taskId, side)
      const taskId = `t-${entry.taskId}-${side}`
      const runId = `r-${entry.taskId}-${side}`
      const verdict: 'pass' | 'fail' | 'inconclusive' =
        settlement === 'verified' ? 'pass' : settlement === 'failed' ? 'fail' : 'inconclusive'
      const criteria = [
        {
          criterionId: entry.criteria[0]!.criterionId,
          verdict,
          verifierId: FIXTURE_JUDGE.ref,
          verifierVersion: FIXTURE_JUDGE.version,
        },
      ]
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
      rows.evidence.push({
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId,
        artifacts: [],
        verifierResults: [],
        claims: [],
        generatedAt: at,
      })
      rows.reviews.push({
        taskId,
        runId,
        outcome: settlement,
        evidenceRefs: [`e-${runId}`],
        anomalies: [],
        criteria,
      })
      await svc.recordExperimentSample({
        formatVersion: 4,
        kind: 'experiment_sample',
        proposalId,
        experimentId,
        preparedContentDigest: digestOf(candidate),
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
        cost:
          settlement === 'verified' || settlement === 'failed'
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
    const champion = {
      taskId: 'before',
      outcome: 'failed' as const,
      criteria: [{ criterionId: 'a', verdict: 'fail' as const, command: 'test' }],
    }
    expect(compareReplaySides(champion, { ...champion, criteria: [] }).relation).toBe('inconclusive')
    expect(
      compareReplaySides(champion, { ...champion, criteria: [{ ...champion.criteria[0]!, command: 'true' }] }).relation,
    ).toBe('inconclusive')
  })

  it('blocks a regressing holdout before human approval while allowing rejection', async () => {
    const { svc } = await serviceWithProduction()
    const { ctx, approval } = toolCtx(svc)
    // A skill candidate whose holdout degraded: the experiment is complete and
    // gated, and the promotion is what refuses.
    const id = skillProposal.proposalId
    await mkdir(join(svc.skillRoot, 'verify'), { recursive: true })
    await writeFile(join(svc.skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate(id, VERSION_SET, 'root-1', { name: 'verify', content: skillText('new') })
    await svc.prepare(id, 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, id, { holdout: { candidate: 'failed' } })
    await svc.gate(id, gateAnswers([reportPath]), 'root-1')
    expect(
      await defineEvolutionDecideTool(ctx).execute({ proposalId: id, decision: 'PROMOTE' }, exec('root-1')),
    ).toContain('rejected:')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get(id)).status).toBe('gated')
    await svc.decide(id, 'REJECT', 'root-1', 'approval:reject')
    expect((await svc.get(id)).decision).toBe('REJECT')
  })

  it.each(['decide', 'apply'])(
    'refuses a tampered experiment report at %s, including after service reopen',
    async stage => {
      const { svc, root, skillRoot } = await serviceWithProduction()
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_CHAMPION)
      await svc.propose(skillProposal, 'root-1')
      await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('candidate') })
      await svc.prepare('s1', 'root-1')
      const { reportPath } = await recordSkillExperiment(svc, 's1')
      await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
      if (stage === 'apply') await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:decide')
      await appendFile(join(root, reportPath), '\n')
      const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
      const action =
        stage === 'decide'
          ? reopened.decide('s1', 'PROMOTE', 'root-1', 'approval:decide')
          : reopened.apply('s1', 'root-1', 'approval:apply')
      await expect(action).rejects.toThrow('is not the report its ledger records recompute to')
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_CHAMPION)
    },
  )
})

describe('EvolutionService apply/rollback state machine', () => {
  it('walks decided(PROMOTE) → applied → rolledback and derives the full history', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.proposal.status).toBe('applied')
    expect(applied.proposal.applied).toEqual({
      targets: [join(skillRoot, 'verify', 'SKILL.md')],
      approvalRef: 'approval:call-1',
    })
    const rolledback = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(rolledback.proposal.status).toBe('rolledback')
    // A skill candidate's evaluation is the experiment, not a `replayed` line.
    expect(rolledback.proposal.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
      'applied',
      'rolledback',
    ])
  })

  it.each(['REJECT', 'KEEP_FOR_FURTHER_RESEARCH'] as const)(
    'refuses apply on a decided %s proposal',
    async decision => {
      const { svc, skillRoot } = await serviceWithProduction()
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
      await svc.propose(skillProposal, 'root-1')
      await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
      await svc.prepare('s1', 'root-1')
      await recordSkillExperiment(svc, 's1')
      await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
      await svc.decide('s1', decision, 'root-1', 'approval:call-1')
      await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(
        `cannot record "applied" — the recorded decision is ${decision}; only a PROMOTE decision can be applied`,
      )
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    },
  )

  it('refuses apply before the decision, a repeated apply, rollback before apply, and a repeated rollback', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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
    await expect(svc.rollback('s1', 'root-1', 'approval:call-3')).rejects.toThrow(
      'is rolledback; cannot record "rolledback"',
    )
  })

  it('refuses apply for an L4 skill candidate, pointing at the manual path', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(
      svc,
      { ...skillProposal, proposalId: 's-l4', level: 'L4' },
      { name: 'verify', content: skillText('# new') },
    )
    await expect(svc.apply('s-l4', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
  })

  it('replays a ledger with applied and rolledback records to the same fold after reopen', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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

  it('writes one v4 ledger through the whole walk, with no older vocabulary in any line', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await svc.rollback('s1', 'root-1', 'approval:call-2')

    const raw = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    const records = raw.map(line => JSON.parse(line) as { formatVersion: number; kind: string })
    // Every line this build writes declares the ledger's own format version.
    expect(records.map(record => record.formatVersion)).toEqual(records.map(() => 4))
    // The lifecycle plus the experiment family — and no `replayed` record.
    expect(records.map(record => record.kind)).toEqual(
      expect.arrayContaining([
        'proposed',
        'candidate',
        'prepared',
        'experiment_started',
        'experiment_sample',
        'gated',
        'decided',
        'commit_intent',
        'applied',
        'commit_intent',
        'rolledback',
      ]),
    )
    expect(records.map(record => record.kind)).not.toContain('replayed')
    expect(raw.join('\n')).not.toContain('"replayed"')

    // The reopen folds the v4 ledger to the same state the live service holds.
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    expect(await reopened.list()).toEqual(await svc.list())
    expect((await reopened.get('s1')).history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
      'applied',
      'rolledback',
    ])
    expect(await reopened.experiments('s1')).toHaveLength(1)
  })

  it('fails loudly on a forged applied record: wrong base state or a malformed payload', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot, PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc.prepare('s1', 'root-1')
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'REJECT', 'root-1', 'approval:call-1')
    const forged = {
      formatVersion: 4,
      kind: 'applied',
      proposalId: 's1',
      targets: ['/x'],
      approvalRef: 'approval:call-9',
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.list()).rejects.toThrow('cannot record "applied"')

    const root2 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot2 = join(root2, 'skills')
    await productionSkill(skillRoot2, PRODUCTION_OLD)
    const svc2 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: join(root2, 'evolution'),
      skillRoot: skillRoot2,
    })
    await svc2.propose(skillProposal, 'root-1')
    await svc2.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc2.prepare('s1', 'root-1')
    const { reportPath: svc2Report } = await recordSkillExperiment(svc2, 's1')
    await svc2.gate('s1', gateAnswers([svc2Report]), 'root-1')
    await svc2.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    const malformed = {
      formatVersion: 4,
      kind: 'applied',
      proposalId: 's1',
      targets: [],
      approvalRef: '',
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(svc2.root, 'proposals.jsonl'), `${JSON.stringify(malformed)}\n`, { flag: 'a' })
    const reopened2 = reopenLike(svc2, {
      modelSelection: () => FIXTURE_SELECTION,
      root: svc2.root,
      skillRoot: skillRoot2,
    })
    await expect(reopened2.list()).rejects.toThrow('malformed target list')
  })
})

describe('EvolutionService apply/rollback production writes', () => {
  it('applies a skill mutation over the production SKILL.md and rolls it back to the champion bytes', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })

    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('# new verify skill'))
    // The guidance object is one file, and the commit replaces exactly it. A
    // directory holding a file the object does not cover no longer reaches
    // apply: prepare refuses it by name (K3), so there is no auxiliary file for
    // a write to leave beside the replaced one.
    expect(applied.targets).toEqual([join(skillRoot, 'verify', 'SKILL.md')])

    await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
  })

  it('refuses a hand-written lifecycle of another target type at its first line', async () => {
    const { svc, root } = await serviceWithProduction()
    // The fold admits exactly what the current entries write: a skill candidate
    // or a capability candidate, each in the shape its own lifecycle records. A
    // hand-written capability lifecycle of the shape a ledger written before
    // this build holds — the old `{ name, entry }` mutation and the bookkeeping
    // prepare that shape carried — is refused at load, at the candidate line,
    // before anything is read from it: no live entry can produce it, since this
    // build's `candidate` admits the one-whole-row shape only.
    await svc.propose(capabilityProposal, 'root-1')
    await appendFile(
      join(root, 'proposals.jsonl'),
      [
        {
          formatVersion: 4,
          kind: 'candidate',
          proposalId: 'c1',
          versionSet: { capabilityTable: 'config.yml#doc1' },
          mutation: capabilityMutation,
          actor: 'root-1',
          at: '2026-09-20T00:00:01.000Z',
        },
        {
          formatVersion: 4,
          kind: 'prepared',
          proposalId: 'c1',
          sandbox: null,
          mechanical: false,
          champion: 'none',
          files: [],
          actor: 'root-1',
          at: '2026-09-20T00:00:02.000Z',
        },
        {
          formatVersion: 4,
          kind: 'gated',
          proposalId: 'c1',
          gate: gateAnswers(['sandbox/c1/replay-report.json']),
          actor: 'root-1',
          at: '2026-09-20T00:00:04.000Z',
        },
        {
          formatVersion: 4,
          kind: 'decided',
          proposalId: 'c1',
          decision: 'PROMOTE',
          approvalRef: 'approval:legacy-decide',
          actor: 'root-1',
          at: '2026-09-20T00:00:05.000Z',
        },
        {
          formatVersion: 4,
          kind: 'applied',
          proposalId: 'c1',
          targets: ['legacy apply'],
          approvalRef: 'approval:legacy-apply',
          actor: 'root-1',
          at: '2026-09-20T00:00:06.000Z',
        },
      ]
        .map(line => JSON.stringify(line))
        .join('\n') + '\n',
    )
    const verbatim = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('capability-row-invalid')
    await expect(reopened.get('c1')).rejects.toThrow('capability-row-invalid')
    // Nothing was read out of it and nothing was written beside it: the refused
    // file keeps its bytes, and the state machine is never reached.
    await expect(reopened.rollback('c1', 'root-1', 'approval:call-2')).rejects.toThrow('capability-row-invalid')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(verbatim)
  })
})

/* ------------------------------------------------------------------ */
/* P2: single-file skill candidate content binding. prepare records    */
/* the SHA-256 of the materialized SKILL.md; the replay report, every   */
/* gate, and the apply write re-verify that exact content.              */
/* ------------------------------------------------------------------ */

const SKILL_CANDIDATE = skillText('# new verify skill\n\nwith a trailing newline')
const skillCandidateFile = (root: string, proposalId = 's1') =>
  join(root, 'sandbox', proposalId, 'skills', 'verify', 'SKILL.md')

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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    // the digest is over the exact file bytes — no trim, no newline conversion
    expect(identity).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(SKILL_CANDIDATE, 'utf8').digest('hex'),
    })
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
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
      'applied',
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

    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    const started = lines.find(line => line.kind === 'experiment_started') as { frozen: Record<string, any> }
    expect(started.frozen.candidate).toEqual(experiment.identity)
    expect(started.frozen.productionBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(PRODUCTION_V1, 'utf8').digest('hex'),
    })
    expect(experiment.identity.sha256).not.toBe(
      createHash('sha256').update('# production rewritten\n', 'utf8').digest('hex'),
    )
    // the overlay is the sandbox candidate, never the production skill
    expect(replayTask.mock.calls.filter(call => call[2].overlay !== undefined)).toHaveLength(2)
    expect(replayTask.mock.calls.every(call => call[2].lineage?.startsWith('evolution-experiment:'))).toBe(true)
  })

  it('P2-B: a candidate modified after prepare is refused before any run, tool and service alike', async () => {
    const { svc, root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    await writeFile(skillCandidateFile(root), 'tampered after prepare\n')

    const viaTool = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(viaTool).toContain('evolution_replay rejected:')
    expect(viaTool).toContain('no longer matches the content identity recorded at prepare')
    expect(replayTask).not.toHaveBeenCalled()

    // the same refusal through the service's own candidate read — the shared
    // identity check every promotion stage and the experiment's pre-run check use
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow(
      'no longer matches the content identity recorded at prepare',
    )
    expect((await svc.get('s1')).status).toBe('prepared')
    expect(existsSync(join(root, 'sandbox', 's1', 'replay-report.json'))).toBe(false)
  })

  it('keeps the candidate bytes out of production through the whole experiment, whatever the runs do', async () => {
    const { root, skillRoot, replayTask, replayTool } = await preparedSkillExperiment()
    // The experiment writes into its own sandboxes and sandbox workspaces only;
    // a run that rearranges its own workspace cannot reach the production skill.
    await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))
    expect(replayTask).toHaveBeenCalledTimes(4)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    expect(existsSync(join(root, 'sandbox', 's1', 'replay-report.json'))).toBe(false)
  })

  it('P2-B: a candidate modified after the replay is refused at decide and apply, with no successful-promotion state', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten after the replay\n')

    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(
      'no longer matches the content identity',
    )
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect((await svc.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    expect((await svc.get('s1')).status).toBe('decided')

    // the candidate file itself as a symlink is refused at replay time
    await rm(verifyDir)
    await mkdir(verifyDir, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), 'external content\n')
    await symlink(join(outside, 'SKILL.md'), skillCandidateFile(root))
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow('is a symbolic link')
  })

  it("P2-D: a commit stops by name when the source is replaced after the write's own read", async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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
      // deterministically, with no sleep-based race; the commit's own re-read of
      // the source it is about to name in the intent is a fourth read, and that
      // is the one the replacement is caught by.
      if (reads === 3) {
        fired += 1
        await writeFile(candidate, replacement)
      }
    }
    let message: string
    try {
      message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
    } finally {
      candidateReadHooks.onCandidateRead = undefined
    }
    expect(fired).toBe(1)
    // The source an intent names must be re-verifiable *before* the intent is
    // recorded: a source that changed after the caller's own verified read stops
    // the commit by name, so nothing is written and no line is recorded.
    expect(message).toMatch(/does not hold the bytes its commit recorded/)
    expect(message).toMatch(/no line is recorded/)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    expect(await readFile(candidate, 'utf8')).toBe(replacement)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect((await svc.get('s1')).openIntent).toBeUndefined()
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
    expect(JSON.parse(await readFile(join(root, reportPath), 'utf8')).formatVersion).toBe(3)
  })

  it('P2-F: a reopened service enforces the same identity checks', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten across a restart\n')

    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(
      'no longer matches the content identity',
    )
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect((await reopened.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
  })

  it('P2-G: an illegitimate candidate is refused before the human is asked', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten before the human review\n')

    const { ctx, approval } = toolCtx(svc)
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_decide rejected:')
    expect(result).toContain('no longer matches the content identity')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
  })

  it('P2-G: a candidate changed while the human approval is pending is refused by the service recheck', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_decide rejected:')
    expect(result).toContain('no longer matches the content identity')
    expect((await svc.get('s1')).status).toBe('gated')
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
  })

  it('P2-G: the apply tool rechecks the identity after its own approval and writes nothing on a changed candidate', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
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

const P3_BASELINE = skillText('# production verify skill')
const P3_CANDIDATE_A = skillText('# candidate A')
const P3_CANDIDATE_B = skillText('# candidate B')
const P3_CONFLICT_GUIDANCE = 'create a new candidate from the current production state and re-evaluate it'
const skillProductionFile = (skillRoot: string, name = 'verify') => join(skillRoot, name, 'SKILL.md')

/** Walk a skill proposal under a fresh id to decided(PROMOTE) against the production state as it stands. */
async function walkSkillToDecided(svc: EvolutionService, proposalId: string, content: string) {
  await walkToDecided(svc, { ...skillProposal, proposalId }, { name: 'verify', content })
}

async function ledgerKinds(root: string): Promise<string[]> {
  return (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { kind: string }).kind)
}

/** Rewrite a live ledger as a P2-era one: the prepared line loses `skillBaseline`, the field P3 added. */
async function dropBaselineField(root: string) {
  const path = join(root, 'proposals.jsonl')
  const lines = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(line => {
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
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'))).toEqual(
      Buffer.from(P3_BASELINE, 'utf8'),
    )

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
  ])(
    'P3-B: production %s is refused at apply, tool and service alike, and keeps its new state',
    async (_label, next) => {
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
      expect((await svc.readSkillCandidate('s1')).skillMd).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
      expect((await svc.get('s1')).history.map(entry => entry.status)).toEqual([
        'proposed',
        'candidate',
        'prepared',
        'gated',
        'decided',
      ])
    },
  )

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
    const brandNew = skillText('# a brand new production skill')
    await productionSkill(skillRoot, brandNew)
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(brandNew)
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
    expect(stale.history.map(entry => entry.status)).toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided'])
    expect((await svc.readSkillCandidate('s2')).skillMd).toEqual(Buffer.from(P3_CANDIDATE_B, 'utf8'))
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
    const humanDeciding = new Promise<void>(resolve => {
      deciding = resolve
    })
    const granted = new Promise<void>(resolve => {
      grant = resolve
    })
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
      name: 'verify',
      sha256: createHash('sha256').update(P3_BASELINE, 'utf8').digest('hex'),
    })
    expect(reloaded.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
    ])
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

  it('K2: rollback restores the champion snapshot of the version this proposal applied, and refuses a target a later writer changed', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.proposal.status).toBe('applied')
    expect(await ledgerKinds(root)).toEqual(expect.arrayContaining(['commit_intent', 'applied']))

    // A target that no longer carries what this proposal applied — here an
    // external edit, in practice a later proposal's apply — is not rolled back
    // over: rollback would restore a baseline on top of a version newer than the
    // one it is undoing. Nothing is written, no intent is recorded, and the
    // proposal stays applied with the external bytes untouched.
    await writeFile(skillProductionFile(skillRoot), '# edited after the apply\n')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-2')).rejects.toThrow(
      /does not hold the content proposal "s1" applied/,
    )
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# edited after the apply\n')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('applied')
    expect((await svc.get('s1')).rolledback).toBeUndefined()
    expect(await svc.openIntentTargets()).toEqual([])

    // Put production back to exactly what this proposal applied and the
    // rollback goes through, restoring the prepare-time champion byte for byte.
    await writeFile(skillProductionFile(skillRoot), P3_CANDIDATE_A)
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
      formatVersion: 4,
      kind: 'prepared',
      proposalId: 's1',
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      skillContent: { name: 'verify', sha256: 'a'.repeat(64) },
      files: ['x'],
      skillBaseline: { name: 'verify', sha256: 'not-a-digest' },
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    await expect(
      new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root }).list(),
    ).rejects.toThrow('no valid skillBaseline identity')
  })

  /**
   * A6/EVO-2: the composed identity a capability prepare freezes is three whole-file
   * digests of the deployment's table file — and nothing else of it, because that
   * file carries the deployment's credentials. A hand-forged line that gets one of
   * the three wrong is refused at the fold exactly as a live append would be.
   */
  it('A6: a malformed capabilityTable on a capability prepared record fails the fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-forge-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(capabilityProposal, 'root-1')
    const entry = { preset: 'standard', skills: [CAPABILITY_FIXTURE_SKILL] }
    await svc.candidate('c1', VERSION_SET, 'root-1', { rows: { research: entry } })
    const forged = {
      formatVersion: 4,
      kind: 'prepared',
      proposalId: 'c1',
      sandbox: 'sandbox/c1',
      mechanical: true,
      champion: 'absent',
      capabilityRow: { name: 'research', entry, digest: digestOf(entry) },
      capabilityBaseline: null,
      capabilityTable: { baselineSha256: 'a'.repeat(64), applySha256: 'not-a-digest', rollbackSha256: 'b'.repeat(64) },
      files: ['x'],
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    await expect(
      new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root }).list(),
    ).rejects.toThrow('no valid capabilityTable.applySha256')
  })

  it('A6: a capabilityTable on a skill prepared record fails the fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-forge-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    const forged = {
      formatVersion: 4,
      kind: 'prepared',
      proposalId: 's1',
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      skillContent: { name: 'verify', sha256: 'a'.repeat(64) },
      skillBaseline: { name: 'verify', sha256: 'b'.repeat(64) },
      capabilityTable: { baselineSha256: 'a'.repeat(64), applySha256: 'a'.repeat(64), rollbackSha256: 'a'.repeat(64) },
      files: ['x'],
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    await expect(
      new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root }).list(),
    ).rejects.toThrow('capability table identity')
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
    await appendFile(
      join(svc.root, 'proposals.jsonl'),
      [
        {
          formatVersion: 4,
          kind: 'candidate',
          proposalId,
          versionSet: { x: 'v1' },
          mutation: { baseVersion: 'v3', definition: { objective: 'the legacy definition' } },
          actor: 'root-1',
          at: '2026-09-20T00:00:01.000Z',
        },
        {
          formatVersion: 4,
          kind: 'prepared',
          proposalId,
          sandbox: null,
          mechanical: false,
          champion: 'none',
          files: [],
          actor: 'root-1',
          at: '2026-09-20T00:00:02.000Z',
        },
        {
          formatVersion: 4,
          kind: 'gated',
          proposalId,
          gate: gateAnswers([`sandbox/${proposalId}/replay-report.json`]),
          actor: 'root-1',
          at: '2026-09-20T00:00:04.000Z',
        },
        {
          formatVersion: 4,
          kind: 'decided',
          proposalId,
          decision: 'PROMOTE',
          approvalRef: 'approval:legacy-decide',
          actor: 'root-1',
          at: '2026-09-20T00:00:05.000Z',
        },
      ]
        .map(line => JSON.stringify(line))
        .join('\n') + '\n',
    )
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    expect((await svc.get('s1')).status).toBe('rolledback')
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'evolution_apply writes nothing when the approval comes back %s',
    async outcome => {
      const { svc, ctx, skillRoot } = await toolCtxWithProduction(outcome)
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
      await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
      const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
      expect(result).toContain('nothing written')
      expect(result).toContain('stays decided')
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
      expect((await svc.get('s1')).status).toBe('decided')
      const ledger = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).not.toContain('applied')
    },
  )

  it('evolution_rollback writes nothing when the human rejects it', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction('allowed-once')
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    const applyTool = defineEvolutionApplyTool(ctx)

    await svc.propose(skillProposal, 'root-1')
    expect((await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string).toContain(
      'proposal s1 is proposed; only a decided proposal can be applied',
    )

    await walkToDecided(
      svc,
      { ...skillProposal, proposalId: 's-l4', level: 'L4' },
      { name: 'verify', content: skillText('# new') },
    )
    expect((await applyTool.execute({ proposalId: 's-l4' }, exec('root-1'))) as string).toContain(
      'L4 harness evolution has no executor',
    )

    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_OLD)
  })

  it('refuses a legacy decided record of another target type at the entry, before the human is asked', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    const applyTool = defineEvolutionApplyTool(ctx)

    await svc.propose(skillProposal, 'root-1')
    expect((await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string).toContain(
      'proposal s1 is proposed; only a decided proposal can be applied',
    )

    await walkToDecided(
      svc,
      { ...skillProposal, proposalId: 's-l4', level: 'L4' },
      { name: 'verify', content: skillText('# new') },
    )
    expect((await applyTool.execute({ proposalId: 's-l4' }, exec('root-1'))) as string).toContain(
      'L4 harness evolution has no executor',
    )

    // A task_definition PROMOTE can no longer be *recorded* — `candidate`
    // refuses the target type by name and the fold refuses the same hand-written
    // shape at its first line — so the only thing an older ledger's decided
    // record reaches is that entry refusal: no human is asked and nothing is
    // written.
    const roots: ProductionRoots = { root: svc.root, skillRoot }
    await svc.propose(proposal, 'root-1')
    const legacyLedger = await legacyDecidedLedger(svc, 'p1', roots)
    await expect(legacyLedger.list()).rejects.toThrow('targets "task_definition"')
    const viaTool = (await defineEvolutionApplyTool({ ...(ctx as object), evolution: legacyLedger } as never).execute(
      { proposalId: 'p1' },
      exec('root-1'),
    )) as string
    expect(viaTool).toContain('evolution_apply rejected:')
    expect(viaTool).toContain('targets "task_definition"')

    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_OLD)
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
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
async function writeSkillDirectory(
  directory: string,
  name: string,
  content: string,
  shape: SkillShape = {},
): Promise<string> {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), content)
  if (shape.sidecar === undefined) return directory
  const identity = { skillMdSha256: sha256Of(content), resources: [] }
  const declared =
    shape.sidecar === 'execution'
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
      {
        formatVersion: 4,
        kind: 'candidate',
        proposalId,
        versionSet: { capabilityTable: 'config.yml#doc1' },
        mutation: capabilityMutation,
        actor: 'root-1',
        at: '2026-09-20T00:00:01.000Z',
      },
      {
        formatVersion: 4,
        kind: 'prepared',
        proposalId,
        sandbox: null,
        mechanical: false,
        champion: 'none',
        files: [],
        actor: 'root-1',
        at: '2026-09-20T00:00:02.000Z',
      },
      {
        formatVersion: 4,
        kind: 'gated',
        proposalId,
        gate: gateAnswers([`sandbox/${proposalId}/replay-report.json`]),
        actor: 'root-1',
        at: '2026-09-20T00:00:04.000Z',
      },
    ]
      .map(line => JSON.stringify(line))
      .join('\n') + '\n',
  )
}

/**
 * Walk one skill proposal to `gated` with the sandbox candidate holding
 * `content`, its experiment recorded. `install` writes the production object the
 * candidate replaces — a plain guidance skill by default, or an execution object
 * when a case needs a two-file one (K3: whether the candidate has a sidecar is
 * decided by production, not by the candidate).
 */
async function skillCandidateGated(
  svc: EvolutionService,
  content: string,
  proposalId = 's1',
  install: () => Promise<void> = async () => {
    await productionSkill(svc.skillRoot)
  },
): Promise<SkillContentIdentity> {
  // §F.2 evaluates a *replacement*: the fixture needs a production SKILL.md for
  // the candidate to replace, or the experiment has nothing to evaluate against.
  await install()
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
 * The capability lifecycle a ledger written before this build holds — the old
 * `{ name, entry }` mutation with the bookkeeping prepare that shape carried —
 * is refused at the fold, at its candidate line: this build's capability
 * candidate is one whole row plus an optional new execution skill
 * (`capability-candidate.spec.ts`), so the old shape is a mutation no live entry
 * writes and no fold admits. The refusal reaches the tools the same way, and
 * nothing is read out of the file to decide it.
 */
describe('a capability lifecycle written in the old shape is refused at the fold', () => {
  it('refuses a hand-written gated capability lifecycle at the entry, writing nothing', async () => {
    const { svc, configFile } = await serviceWithProduction()
    const before = await readFile(configFile, 'utf8')
    await capabilityGatedLedger(svc, 'c2')
    const forged = reopenLike(svc, {
      modelSelection: () => FIXTURE_SELECTION,
      root: svc.root,
      skillRoot: svc.skillRoot,
    })

    // The fold admits what the live entries write: a capability lifecycle in a
    // shape no live entry produces cannot be folded from a file either, so no
    // `gated` capability proposal exists to decide.
    await expect(forged.list()).rejects.toThrow('capability-row-invalid')
    await expect(forged.get('c2')).rejects.toThrow('capability-row-invalid')
    await expect(forged.decide('c2', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow('capability-row-invalid')

    // Through the tools the same refusal reaches the caller, still without a
    // human being asked for a proposal that cannot be promoted.
    const { ctx, approval } = toolCtx(forged)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 'c2', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('capability-row-invalid')
    const viaApplyTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 'c2' }, exec('root-1'))) as string
    expect(viaApplyTool).toContain('evolution_apply rejected:')
    expect(viaApplyTool).toContain('capability-row-invalid')
    expect(approval.request).not.toHaveBeenCalled()

    // Nothing was read out of the refused file and config.yml is byte-identical
    // to what it was.
    expect(await readFile(configFile, 'utf8')).toBe(before)
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
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
    await appendFile(
      join(svc.root, 'proposals.jsonl'),
      [
        {
          formatVersion: 4,
          kind: 'decided',
          proposalId: 'c2',
          decision: 'PROMOTE',
          approvalRef: 'approval:legacy',
          actor: 'root-1',
          at: '2026-09-20T00:00:05.000Z',
        },
        {
          formatVersion: 4,
          kind: 'applied',
          proposalId: 'c2',
          targets: [`${configFile} — document 1 task-runtime capabilities row "research"`],
          approvalRef: 'approval:apply',
          actor: 'root-1',
          at: '2026-09-20T00:00:06.000Z',
        },
      ]
        .map(line => JSON.stringify(line))
        .join('\n') + '\n',
    )
    const before = await readFile(configFile, 'utf8')
    const reopened = reopenLike(svc, {
      modelSelection: () => FIXTURE_SELECTION,
      root: svc.root,
      skillRoot: svc.skillRoot,
    })

    await expect(reopened.list()).rejects.toThrow('capability-row-invalid')
    await expect(reopened.get('c2')).rejects.toThrow('capability-row-invalid')
    await expect(reopened.apply('c2', 'root-1', 'approval:call-1')).rejects.toThrow('capability-row-invalid')
    const { ctx, approval } = toolCtx(reopened)
    const viaApplyTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 'c2' }, exec('root-1'))) as string
    expect(viaApplyTool).toContain('evolution_apply rejected:')
    expect(viaApplyTool).toContain('capability-row-invalid')
    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(configFile, 'utf8')).toBe(before)
  })
})

describe('skill candidate provider pre-check (S1-C item 3)', () => {
  /** The production execution object a two-file candidate is prepared against. */
  const executionProduction =
    (skillRoot: string, content: string, shape: SkillShape = {}) =>
    async (): Promise<void> => {
      await writeSkillDirectory(join(skillRoot, 'verify'), 'verify', content, {
        sidecar: 'execution',
        verifierRef: 'command',
        capabilities: [PROMOTION_ROW],
        requiredTools: ['bash'],
        ...shape,
      })
    }

  it('refuses an execution candidate whose verifier is unregistered, at decide, through the tool and at the service entry', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate claiming execution')
    // The production object — and therefore the derived candidate — declares a
    // verifier this deployment never registered: the declaration is a valid
    // shape, and only the provider check can refuse it.
    const identity = await skillCandidateGated(
      svc,
      content,
      's1',
      executionProduction(skillRoot, skillText('# production with a ghost verifier'), {
        verifierRef: 'ghost-verifier',
      }),
    )
    expect(identity.contract).toBeDefined()

    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(/verifier-unknown/)
    expect((await svc.get('s1')).status).toBe('gated')
    // P2's identity check still passes — both candidate files are the ones
    // prepare froze — so it is the provider check that refuses, which is what
    // P2 could not see.
    const candidate = await svc.readSkillCandidate('s1')
    expect(candidate.skillMd).toEqual(Buffer.from(content, 'utf8'))
    expect(candidate.sidecar).toBeDefined()
    expect(identity.sha256).toBe(sha256Of(content))

    const { ctx, approval } = toolCtx(svc)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('verifier-unknown')
    expect(approval.request).not.toHaveBeenCalled()

    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is gated')
    // Nothing written, nothing recorded: production still holds the baseline, and
    // no `applied` line was taken.
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses a candidate whose provider requires tools its declared capability does not grant', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate needing a shell')
    await skillCandidateGated(
      svc,
      content,
      's1',
      executionProduction(skillRoot, skillText('# production needing a shell'), {
        // `research` is in the table and grants no tools at all.
        capabilities: ['research'],
      }),
    )

    await expect(svc.checkPromotion('s1')).rejects.toThrow(/tool-not-covered/)
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it.each([
    [
      'an execution sidecar',
      {
        sidecar: 'execution',
        verifierRef: 'command',
        capabilities: [PROMOTION_ROW],
        requiredTools: ['bash'],
      } as SkillShape,
    ],
    ['a knowledge sidecar', { sidecar: 'knowledge' } as SkillShape],
  ])('refuses a sidecar that appears beside a guidance candidate: %s', async (_label, shape) => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# a guidance candidate that gains a declaration')
    await skillCandidateGated(svc, content)
    // The object prepare froze is guidance — one file. A sidecar of any kind
    // appearing afterwards is a different object, and the shape is part of the
    // identity: production would receive a pair the experiment never evaluated.
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, shape)

    const refusal = await svc
      .checkPromotion('s1')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain('SKILL.contract.json')
    expect(refusal).toContain('the content identity recorded at prepare is guidance')

    // decide(PROMOTE), the tool before it asks a human, and the service entry
    // refuse alike: no decision recorded, no approval burned, no production write.
    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(
      'the content identity recorded at prepare is guidance',
    )
    expect((await svc.get('s1')).status).toBe('gated')
    const { ctx, approval } = toolCtx(svc)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('the content identity recorded at prepare is guidance')
    expect(approval.request).not.toHaveBeenCalled()
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('decided')
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses a candidate carrying a resource this executor would never write', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate with a reference file')
    await skillCandidateGated(svc, content)
    const directory = skillCandidateDirectory(root)
    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(join(directory, 'references', 'notes.md'), 'a file this executor would never write\n')

    const refusal = await svc
      .checkPromotion('s1')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain('"references/"')
    expect(refusal).toContain('one skill object is a fixed file set')
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
    await skillCandidateGated(
      svc,
      content,
      's1',
      executionProduction(skillRoot, skillText('# production execution skill')),
    )

    // Same ledger, same sandbox, but a context with no verifier service: the ref
    // cannot be proven registered, so the candidate is refused rather than
    // assumed valid — the same refusal admission gives the same situation.
    const bare = new EvolutionService(
      {
        reflect: { provide: () => {} },
        effect: () => {},
        taskRuntime: { listCapabilities: () => structuredClone(FIXTURE_CAPABILITIES) },
      } as never,
      { root, skillRoot },
    )
    await expect(bare.checkPromotion('s1')).rejects.toThrow(/verifier registry cannot be listed/)
    expect(await ledgerKinds(root)).not.toContain('applied')
  })

  it('refuses the apply tool before asking the human when a sidecar appears after the decision', async () => {
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
    expect(refused).toContain('the content identity recorded at prepare is guidance')
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
    expect(result).toContain('the content identity recorded at prepare is guidance')
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })
})

/* ------------------------------------------------------------------ */
/* K2: one commit per production write — the intent is persisted first, */
/* the target is replaced atomically, and the completion closes the      */
/* intent. An interruption between any two of those leaves exactly one   */
/* open intent, and `reconcile` settles it from what production actually */
/* holds. These cases run over real files, a real ledger and a real      */
/* service; the only injected seam is Config.commitProbe — an in-process */
/* throw *at* a durable stage, not a process exit. The durable-operation */
/* seam (which fs call is issued when, and what a failing one does) is   */
/* `commit-durability.spec.ts`; the process-exit evidence is the         */
/* real-SIGKILL cases of `tests/integration/k2-evolution-commit.spec.ts`. */
/* ------------------------------------------------------------------ */

/** The production file every commit fixture writes. */
const COMMIT_TARGET = (skillRoot: string) => join(skillRoot, 'verify', 'SKILL.md')
const CANDIDATE_SOURCE = 'sandbox/s1/skills/verify/SKILL.md'
const CHAMPION_SOURCE = 'sandbox/s1/champion/skills/verify/SKILL.md'

/**
 * The service config that stops one commit at `stage` — the typed test seam, and
 * only that: the probe throws an ordinary in-process error, which aborts the
 * commit exactly where it stands (no later stage of the commit runs). It is a
 * window-injection seam, **not** a process exit, and it proves nothing about
 * process exits: `writeFileAtomic`'s own `catch` still runs here and removes the
 * staging file it had written. The process-exit evidence is the real-SIGKILL
 * cases of `tests/integration/k2-evolution-commit.spec.ts`; what a durable
 * operation does when it fails is `commit-durability.spec.ts`.
 */
function crashAt(stage: CommitStage): Pick<Config, 'commitProbe'> {
  return {
    commitProbe: seen => {
      if (seen === stage) throw new Error(`in-process probe throw after ${seen} — a throw, not a process exit`)
    },
  }
}

/** The commit stages an interrupt window is opened at, and the state production is left in for each. */
const INTERRUPTED_STAGES = ['intent-recorded', 'write-staged', 'write-renamed'] as const

/**
 * A production fixture walked to decided(PROMOTE): production holds the
 * champion, the sandbox holds the candidate, its champion snapshot and a
 * completed experiment. `probe` opens an interrupt window on that service — an
 * in-process throw at one stage, not a process exit (see {@link crashAt}).
 */
async function decidedSkillFixture(candidate: string = SKILL_CANDIDATE, probe?: CommitStage) {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-commit-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  await productionSkill(skillRoot)
  const svc = new EvolutionService(fixtureCtx(), {
    modelSelection: () => FIXTURE_SELECTION,
    root,
    skillRoot,
    ...(probe === undefined ? {} : crashAt(probe)),
  })
  await walkToDecided(svc, skillProposal, { name: 'verify', content: candidate })
  return { svc, dir, root, skillRoot }
}

/** A second service over the same ledger, store rows and roots, with an interrupt window of its own. */
function reopenWithProbe(
  svc: EvolutionService,
  roots: { root: string; skillRoot: string },
  probe?: CommitStage,
): EvolutionService {
  return reopenLike(svc, {
    modelSelection: () => FIXTURE_SELECTION,
    root: roots.root,
    skillRoot: roots.skillRoot,
    ...(probe === undefined ? {} : crashAt(probe)),
  })
}

/** Every ledger line, parsed, oldest first — the file itself, never the service's memory. */
async function ledgerLinesOf(root: string): Promise<Record<string, any>[]> {
  return (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, any>)
}

/** A production target that no fixture root owns — the fold touches no disk. */
const FORGED_TARGET = '/production/skills/verify/SKILL.md'
const FORGED_INTENT = 's1/apply'

/** The ledger lines of a decided(PROMOTE) skill proposal, as the fixture's own entries write them. */
function decidedLines(extra: readonly Record<string, unknown>[] = []): Record<string, unknown>[] {
  const common = { formatVersion: 4, proposalId: 's1', actor: 'root-1' }
  return [
    {
      ...common,
      kind: 'proposed',
      targetType: 'skill',
      targetId: 'verify',
      baseVersion: 'v1',
      level: 'L2',
      rationale: 'the fixture row',
      sourceRefs: ['diagnosis:d1'],
      at: '2026-09-26T00:00:00.000Z',
    },
    {
      ...common,
      kind: 'candidate',
      versionSet: { skill: 'v2' },
      mutation: { name: 'verify', content: SKILL_CANDIDATE },
      at: '2026-09-26T00:00:01.000Z',
    },
    {
      ...common,
      kind: 'prepared',
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      skillContent: { name: 'verify', sha256: sha256Of(SKILL_CANDIDATE) },
      skillBaseline: { name: 'verify', sha256: sha256Of(P3_BASELINE) },
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
      at: '2026-09-26T00:00:02.000Z',
    },
    {
      ...common,
      kind: 'gated',
      gate: gateAnswers(['sandbox/s1/experiment-report.json']),
      at: '2026-09-26T00:00:03.000Z',
    },
    { ...common, kind: 'decided', decision: 'PROMOTE', approvalRef: 'approval:decide', at: '2026-09-26T00:00:04.000Z' },
    ...extra,
  ]
}

/** One `commit_intent` line, as an apply commit writes it, with `over` replacing any member. */
function intentLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 4,
    kind: 'commit_intent',
    intentId: FORGED_INTENT,
    proposalId: 's1',
    direction: 'apply',
    approvalRef: 'approval:decide',
    files: [
      {
        target: FORGED_TARGET,
        baselineSha256: sha256Of(P3_BASELINE),
        contentSha256: sha256Of(SKILL_CANDIDATE),
        source: CANDIDATE_SOURCE,
      },
    ],
    actor: 'root-1',
    at: '2026-09-26T00:00:05.000Z',
    ...over,
  }
}

/** The one `files` entry of {@link intentLine}, as a case reads it back for comparison. */
function intentFile(): Record<string, string> {
  return {
    target: FORGED_TARGET,
    baselineSha256: sha256Of(P3_BASELINE),
    contentSha256: sha256Of(SKILL_CANDIDATE),
    source: CANDIDATE_SOURCE,
  }
}

/** The `applied` line that closes {@link intentLine}, as the commit writes it. */
function appliedLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 4,
    kind: 'applied',
    proposalId: 's1',
    targets: [FORGED_TARGET],
    approvalRef: 'approval:decide',
    intentId: FORGED_INTENT,
    actor: 'root-1',
    at: '2026-09-26T00:00:06.000Z',
    ...over,
  }
}

/** A ledger holding exactly `lines`, and a service over it. */
async function ledgerFixture(
  lines: readonly Record<string, unknown>[],
): Promise<{ svc: EvolutionService; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-commit-fold-'))
  const root = join(dir, 'evolution')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'proposals.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return {
    svc: new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root,
      skillRoot: join(dir, 'skills'),
    }),
    root,
  }
}

describe('K2: commit intents in the fold', () => {
  it('refuses a completion that closes no open intent, naming what it would have closed', async () => {
    const { svc, root } = await ledgerFixture(decidedLines([appliedLine()]))
    const err = await svc.list().then(
      () => undefined,
      (error: Error) => error,
    )
    expect(String((err as Error).message)).toMatch(/closes no open commit intent/)
    // Refused at load: the bytes stay exactly as written, and a second instance
    // reaches the same verdict.
    expect((await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(6)
    await expect(
      reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot: svc.skillRoot }).list(),
    ).rejects.toThrow(/closes no open commit intent/)
  })

  it('refuses a completion that carries no intentId at all', async () => {
    const withoutIntentId = { ...appliedLine() }
    delete withoutIntentId.intentId
    const { svc } = await ledgerFixture(decidedLines([intentLine(), withoutIntentId]))
    await expect(svc.list()).rejects.toThrow(/names no commit intent/)
  })

  it.each([
    ['another intent id', appliedLine({ intentId: 's1/apply-again' }), /but the open intent of that proposal is/],
    ['another approval', appliedLine({ approvalRef: 'approval:somebody-else' }), /not the approval the open intent/],
    [
      'another target',
      appliedLine({ targets: ['/production/skills/other/SKILL.md'] }),
      /but the open intent .* commits/,
    ],
  ])('refuses a completion that closes its intent with %s', async (_label, line, expected) => {
    const { svc } = await ledgerFixture(decidedLines([intentLine(), line]))
    await expect(svc.list()).rejects.toThrow(expected as RegExp)
  })

  it('refuses a rolledback record that closes no open intent — the apply completion already closed it', async () => {
    const { svc } = await ledgerFixture(
      decidedLines([
        intentLine(),
        appliedLine(),
        { ...appliedLine(), kind: 'rolledback', intentId: 's1/rollback', at: '2026-09-26T00:00:07.000Z' },
      ]),
    )
    await expect(svc.list()).rejects.toThrow(/closes no open commit intent/)
  })

  it('refuses a second open intent for one proposal, whatever it names', async () => {
    const { svc } = await ledgerFixture(decidedLines([intentLine(), intentLine({ at: '2026-09-26T00:00:07.000Z' })]))
    await expect(svc.list()).rejects.toThrow(/already has the open commit intent "s1\/apply"/)
  })

  it('refuses an intent id that is not derived from the proposal and direction', async () => {
    const { svc } = await ledgerFixture(decidedLines([intentLine({ intentId: 's1' })]))
    await expect(svc.list()).rejects.toThrow(/an intent's id is "<proposalId>\/<direction>"/)
  })

  it.each([
    ['apply', 'decided', ['proposed', 'candidate', 'prepared', 'gated'], /needs proposal "s1" to be decided/],
    [
      'rollback',
      'applied',
      ['proposed', 'candidate', 'prepared', 'gated', 'decided'],
      /needs proposal "s1" to be applied/,
    ],
  ] as const)('requires the state a %s intent commits (%s)', async (direction, _state, kinds, expected) => {
    const lines = decidedLines().slice(0, kinds.length)
    const intent =
      direction === 'apply'
        ? intentLine({ at: '2026-09-26T00:00:05.000Z' })
        : intentLine({ intentId: 's1/rollback', direction: 'rollback', at: '2026-09-26T00:00:05.000Z' })
    const { svc } = await ledgerFixture([...lines, intent])
    await expect(svc.list()).rejects.toThrow(expected as RegExp)
  })

  it.each([
    ['no source', { files: [{ ...intentFile(), source: undefined }] }, /file 0 has no source/],
    [
      'a digest that is not a digest',
      { files: [{ ...intentFile(), baselineSha256: 'not-a-digest' }] },
      /file 0 has no valid baselineSha256/,
    ],
    ['a direction this build has no commit for', { direction: 'revert' }, /declares direction "revert"/],
    [
      'a relative target',
      { files: [{ ...intentFile(), target: 'skills/verify/SKILL.md' }] },
      /an intent names the absolute production paths/,
    ],
    [
      'a file that is not the object',
      { files: [{ ...intentFile(), target: '/production/skills/verify/README.md' }] },
      /the file set of one skill object is ordered and fixed/,
    ],
    [
      'a sidecar of another directory',
      { files: [intentFile(), { ...intentFile(), target: '/production/skills/other/SKILL.contract.json' }] },
      /the files of one skill object live in one directory/,
    ],
    ['three files', { files: [intentFile(), intentFile(), intentFile()] }, /a fixed file set of one or two files/],
    ['no file list at all', { files: [] }, /a fixed file set of one or two files/],
  ])('refuses a commit intent with %s', async (_label, over, expected) => {
    const { svc } = await ledgerFixture(decidedLines([intentLine(over)]))
    await expect(svc.list()).rejects.toThrow(expected as RegExp)
  })

  it("folds an open intent back as the proposal's own openIntent, and clears it at the completion", async () => {
    const open = await ledgerFixture(decidedLines([intentLine()]))
    const proposal = await open.svc.get('s1')
    expect(proposal.status).toBe('decided')
    expect(proposal.openIntent).toEqual({
      intentId: FORGED_INTENT,
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:decide',
      files: [intentFile()],
      actor: 'root-1',
      at: '2026-09-26T00:00:05.000Z',
    })
    // A commit intent is not a lifecycle transition: the history is the one the
    // lifecycle records wrote.
    expect(proposal.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
    ])
    expect((await open.svc.list())[0]!.openIntent?.intentId).toBe(FORGED_INTENT)
    expect(await open.svc.openIntentTargets()).toEqual([FORGED_TARGET])

    const closed = await ledgerFixture(decidedLines([intentLine(), appliedLine()]))
    const settled = await closed.svc.get('s1')
    expect(settled.status).toBe('applied')
    expect(settled.openIntent).toBeUndefined()
    expect(settled.applied).toEqual({ targets: [FORGED_TARGET], approvalRef: 'approval:decide' })
    expect(await closed.svc.openIntentTargets()).toEqual([])
  })
})

describe('K2: the commit — intent, atomic write, completion', () => {
  it('applies through one commit: the intent line precedes the applied line, and production carries the verified candidate', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const outcome = await svc.apply('s1', 'root-1', 'approval:call-1')
    const target = COMMIT_TARGET(skillRoot)

    expect(outcome.recovered).toBeUndefined()
    expect(outcome.targets).toEqual([target])
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect(await ledgerKinds(root)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'experiment_started',
      'experiment_sample',
      'experiment_sample',
      'experiment_sample',
      'experiment_sample',
      'gated',
      'decided',
      'commit_intent',
      'applied',
    ])
    const intent = (await ledgerLinesOf(root)).find(line => line.kind === 'commit_intent')!
    expect(intent).toMatchObject({
      intentId: 's1/apply',
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:call-1',
      files: [
        {
          target,
          baselineSha256: sha256Of(P3_BASELINE),
          contentSha256: sha256Of(SKILL_CANDIDATE),
          source: CANDIDATE_SOURCE,
        },
      ],
      actor: 'root-1',
    })
    const applied = (await ledgerLinesOf(root)).find(line => line.kind === 'applied')!
    expect(applied).toMatchObject({ intentId: 's1/apply', targets: [target], approvalRef: 'approval:call-1' })
    expect((await svc.get('s1')).status).toBe('applied')
    expect((await svc.get('s1')).openIntent).toBeUndefined()
    expect(await svc.openIntentTargets()).toEqual([])
    // The commit stages its bytes beside the target and renames them over it:
    // nothing of the staging file survives a successful commit.
    expect((await readdir(join(skillRoot, 'verify'))).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('rolls back through one commit: the intent names the applied content as the baseline and the snapshot as the content', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const outcome = await svc.rollback('s1', 'root-1', 'approval:call-2')
    const target = COMMIT_TARGET(skillRoot)

    expect(outcome.recovered).toBeUndefined()
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    expect((await ledgerKinds(root)).slice(-4)).toEqual(['commit_intent', 'applied', 'commit_intent', 'rolledback'])
    const intents = (await ledgerLinesOf(root)).filter(line => line.kind === 'commit_intent')
    expect(intents[1]).toMatchObject({
      intentId: 's1/rollback',
      direction: 'rollback',
      approvalRef: 'approval:call-2',
      files: [
        {
          target,
          baselineSha256: sha256Of(SKILL_CANDIDATE),
          contentSha256: sha256Of(P3_BASELINE),
          source: CHAMPION_SOURCE,
        },
      ],
    })
    expect((await ledgerLinesOf(root)).find(line => line.kind === 'rolledback')).toMatchObject({
      intentId: 's1/rollback',
      targets: [target],
      approvalRef: 'approval:call-2',
    })
  })

  it('refuses a rollback whose target no longer holds what the proposal applied, before any intent is recorded', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(COMMIT_TARGET(skillRoot), '# a later writer moved this target\n')

    await expect(svc.rollback('s1', 'root-1', 'approval:call-2')).rejects.toThrow(
      /does not hold the content proposal "s1" applied/,
    )
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe('# a later writer moved this target\n')
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses a rollback whose champion snapshot no longer hashes to the recorded baseline, before any intent is recorded', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(join(root, CHAMPION_SOURCE), '# the snapshot was damaged\n')

    await expect(svc.rollback('s1', 'root-1', 'approval:call-2')).rejects.toThrow(
      /champion snapshot .* no longer hashes/,
    )
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await readFile(COMMIT_TARGET(skillRoot))).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses to roll an earlier proposal back over a later one that changed the same target', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    await svc.apply('s1', 'root-1', 'approval:call-1')
    // The second candidate is prepared against what the first one applied.
    await walkSkillToDecided(svc, 's2', P3_CANDIDATE_B)
    await svc.apply('s2', 'root-1', 'approval:call-2')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_CANDIDATE_B)

    // s1's rollback would restore a baseline on top of a version newer than the
    // one it is undoing: it stops by name, writes nothing and records no intent.
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-3')).rejects.toThrow(
      /does not hold the content proposal "s1" applied/,
    )
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_CANDIDATE_B)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('applied')
    expect(await svc.openIntentTargets()).toEqual([])

    // The later proposal's own rollback restores exactly what it applied over.
    await svc.rollback('s2', 'root-1', 'approval:call-4')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_CANDIDATE_A)
    expect((await svc.get('s2')).status).toBe('rolledback')
  })

  it('refuses a drifted production baseline in the commit path, recording no intent', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await writeFile(COMMIT_TARGET(skillRoot), '# moved since prepare\n')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(/changed since prepare/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it("refuses a second apply on a target another proposal's open intent names, and admits one once that intent is settled", async () => {
    const fixture = await decidedSkillFixture(P3_CANDIDATE_A)
    const { svc, root, skillRoot } = fixture
    const target = COMMIT_TARGET(skillRoot)
    // s2 is prepared against the bytes s1 recorded as the baseline: its own
    // baseline check cannot see s1's unfinished commit, only the open intent can.
    await walkSkillToDecided(svc, 's2', P3_CANDIDATE_B)
    const baselineSha256 = sha256Of(P3_BASELINE)
    expect((await svc.get('s1')).prepared!.skillBaseline!.sha256).toBe(baselineSha256)
    expect((await svc.get('s2')).prepared!.skillBaseline!.sha256).toBe(baselineSha256)

    const crashing = reopenWithProbe(svc, fixture, 'intent-recorded')
    expect(await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))).toContain(
      'in-process probe throw after intent-recorded',
    )
    const reopened = reopenWithProbe(svc, fixture)
    const interrupted = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    expect((await ledgerKinds(root)).at(-1)).toBe('commit_intent')
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')

    // The second commit is refused by name, before it reads or moves anything.
    const refusal = await refusalOf(reopened.apply('s2', 'root-1', 'approval:call-2'))
    expect(refusal).toContain("another proposal's unsettled intent")
    expect(refusal).toContain(dirname(target))
    expect(refusal).toContain('s1/apply')
    expect(refusal).toContain('"s1"')
    expect(refusal).toContain('nothing was written and no commit intent was recorded')
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(interrupted)
    expect((await reopened.get('s2')).status).toBe('decided')
    expect((await reopened.get('s2')).openIntent).toBeUndefined()
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')

    // Settling s1's intent from what production holds admits commits again.
    expect((await reopened.reconcile()).map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    expect((await reopened.get('s1')).status).toBe('applied')
    expect(await reopened.openIntentTargets()).toEqual([])

    // s2's baseline is the pre-commit bytes: the ordinary check still refuses it.
    const settled = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    expect(await refusalOf(reopened.apply('s2', 'root-1', 'approval:call-2'))).toContain('changed since prepare')
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(settled)

    // A proposal prepared against the recovered production commits normally.
    await walkSkillToDecided(reopened, 's3', P3_CANDIDATE_B)
    const outcome = await reopened.apply('s3', 'root-1', 'approval:call-3')
    expect(outcome.targets).toEqual([target])
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_B, 'utf8'))
    expect((await reopened.get('s3')).status).toBe('applied')
  })

  it("refuses a rollback on a target another proposal's open intent names, leaving production and the ledger untouched", async () => {
    const fixture = await decidedSkillFixture(P3_CANDIDATE_A)
    const { svc, root, skillRoot } = fixture
    const target = COMMIT_TARGET(skillRoot)
    await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    // s2 is prepared against what s1 applied; its unfinished apply is what stands
    // between s1's rollback and the target.
    await walkSkillToDecided(svc, 's2', P3_CANDIDATE_B)

    const crashing = reopenWithProbe(svc, fixture, 'intent-recorded')
    expect(await refusalOf(crashing.apply('s2', 'root-1', 'approval:call-2'))).toContain(
      'in-process probe throw after intent-recorded',
    )
    const reopened = reopenWithProbe(svc, fixture)
    const interrupted = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    expect((await reopened.get('s2')).openIntent?.intentId).toBe('s2/apply')
    expect(await reopened.openIntentTargets()).toEqual([target])

    const refusal = await refusalOf(reopened.rollback('s1', 'root-1', 'approval:call-3'))
    expect(refusal).toContain("another proposal's unsettled intent")
    expect(refusal).toContain(dirname(target))
    expect(refusal).toContain('s2/apply')
    expect(refusal).toContain('"s2"')
    expect(refusal).toContain('direction "apply"')
    expect(refusal).toContain('nothing was written and no commit intent was recorded')
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(interrupted)
    expect((await reopened.get('s1')).status).toBe('applied')
    expect((await reopened.get('s1')).openIntent).toBeUndefined()
  })
})

describe('K2: recovery — an interruption between two durable writes leaves one open intent', () => {
  /** Walk one direction to the state a commit starts from, throw inside it at `stage`, and reopen. */
  async function interrupted(direction: 'apply' | 'rollback', stage: CommitStage) {
    const fixture = await decidedSkillFixture()
    if (direction === 'rollback') await fixture.svc.apply('s1', 'root-1', 'approval:call-1')
    const approval = direction === 'apply' ? 'approval:call-1' : 'approval:call-2'
    const crashing = reopenWithProbe(fixture.svc, fixture, stage)
    const message = await refusalOf(
      direction === 'apply' ? crashing.apply('s1', 'root-1', approval) : crashing.rollback('s1', 'root-1', approval),
    )
    expect(message).toContain(`in-process probe throw after ${stage}`)
    const reopened = reopenWithProbe(fixture.svc, fixture)
    return { ...fixture, reopened, approval }
  }

  it.each(INTERRUPTED_STAGES)('settles an apply interrupted after %s from production itself', async stage => {
    const { root, skillRoot, reopened } = await interrupted('apply', stage)
    const target = COMMIT_TARGET(skillRoot)
    // The ledger holds the intent and no completion; production holds the old
    // bytes except in the window where the rename already landed.
    const interruptedKinds = await ledgerKinds(root)
    expect(interruptedKinds.at(-1)).toBe('commit_intent')
    expect(interruptedKinds).not.toContain('applied')
    expect(await readFile(target, 'utf8')).toBe(stage === 'write-renamed' ? SKILL_CANDIDATE : P3_BASELINE)
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')
    expect(await reopened.openIntentTargets()).toEqual([target])

    // A crash after the rename must not write production a second time.
    await utimes(target, new Date('2001-01-01T00:00:00.000Z'), new Date('2001-01-01T00:00:00.000Z'))
    const pinned = (await stat(target)).mtimeMs

    const outcomes = await reopened.reconcile()
    expect(outcomes).toEqual([
      {
        intentId: 's1/apply',
        proposalId: 's1',
        direction: 'apply',
        targets: [target],
        result: stage === 'write-renamed' ? 'completed-written' : 'completed-redone',
      },
    ])
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    if (stage === 'write-renamed') expect((await stat(target)).mtimeMs).toBe(pinned)
    else expect((await stat(target)).mtimeMs).not.toBe(pinned)

    // Exactly one completion row, the intent closed, and repeating the
    // reconciliation costs nothing.
    const settled = await ledgerKinds(root)
    expect(settled.filter(kind => kind === 'applied')).toHaveLength(1)
    expect(settled.filter(kind => kind === 'commit_intent')).toHaveLength(1)
    expect((await reopened.get('s1')).status).toBe('applied')
    expect((await reopened.get('s1')).openIntent).toBeUndefined()
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    expect(await reopened.reconcile()).toEqual([])
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
  })

  it.each(INTERRUPTED_STAGES)('settles a rollback interrupted after %s from production itself', async stage => {
    const { root, skillRoot, reopened } = await interrupted('rollback', stage)
    const target = COMMIT_TARGET(skillRoot)
    const interruptedKinds = await ledgerKinds(root)
    expect(interruptedKinds.at(-1)).toBe('commit_intent')
    expect(interruptedKinds).not.toContain('rolledback')
    expect(await readFile(target, 'utf8')).toBe(stage === 'write-renamed' ? P3_BASELINE : SKILL_CANDIDATE)

    const outcomes = await reopened.reconcile()
    expect(outcomes).toEqual([
      {
        intentId: 's1/rollback',
        proposalId: 's1',
        direction: 'rollback',
        targets: [target],
        result: stage === 'write-renamed' ? 'completed-written' : 'completed-redone',
      },
    ])
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    const settled = await ledgerKinds(root)
    expect(settled.filter(kind => kind === 'rolledback')).toHaveLength(1)
    expect(settled.filter(kind => kind === 'commit_intent')).toHaveLength(2)
    expect((await reopened.get('s1')).status).toBe('rolledback')
    expect((await reopened.get('s1')).openIntent).toBeUndefined()
  })

  it('leaves a completed commit with nothing to settle: no open intent, no line, no write', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const reopened = reopenWithProbe(svc, { root, skillRoot })
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const target = COMMIT_TARGET(skillRoot)
    const mtime = (await stat(target)).mtimeMs

    expect(await reopened.openIntentTargets()).toEqual([])
    expect(await reopened.reconcile()).toEqual([])
    expect(await reopened.reconcile()).toEqual([])
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
    expect((await stat(target)).mtimeMs).toBe(mtime)
  })

  it('does not read a leftover staging file as an applied result', async () => {
    const { root, skillRoot, reopened } = await interrupted('apply', 'write-staged')
    const target = COMMIT_TARGET(skillRoot)
    // A crash can leave the staged bytes beside the target; they are not the
    // result, and production — which still holds the old bytes — is what the
    // reconciliation reads.
    const staging = join(skillRoot, 'verify', '.SKILL.md.tmp-9999-deadbeef')
    await writeFile(staging, SKILL_CANDIDATE)

    const outcomes = await reopened.reconcile()
    expect(outcomes.map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
  })

  it('settles the recorded intent when apply is called again, without a second approval or a second commit', async () => {
    const { root, skillRoot, reopened } = await interrupted('apply', 'write-staged')
    const target = COMMIT_TARGET(skillRoot)

    const again = await reopened.apply('s1', 'root-1', 'approval:call-9')
    expect(again.recovered).toBe('redone')
    expect(again.targets).toEqual([target])
    expect(again.proposal.status).toBe('applied')
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    // The completion closes the intent with the grant the intent recorded, not
    // the one this retry passed.
    const applied = (await ledgerLinesOf(root)).filter(line => line.kind === 'applied')
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ approvalRef: 'approval:call-1', intentId: 's1/apply' })
    expect((await ledgerKinds(root)).filter(kind => kind === 'commit_intent')).toHaveLength(1)
  })

  it('settles a rollback retry that finds the write already done, recording only the completion', async () => {
    const { root, skillRoot, reopened } = await interrupted('rollback', 'write-renamed')
    const target = COMMIT_TARGET(skillRoot)
    await utimes(target, new Date('2001-01-01T00:00:00.000Z'), new Date('2001-01-01T00:00:00.000Z'))
    const pinned = (await stat(target)).mtimeMs

    const again = await reopened.rollback('s1', 'root-1', 'approval:call-9')
    expect(again.recovered).toBe('written')
    expect(again.proposal.status).toBe('rolledback')
    expect((await stat(target)).mtimeMs).toBe(pinned)
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
  })

  it('is exactly once: the retry that follows a settled commit is refused by the state machine and adds no line', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const crashing = reopenWithProbe(svc, { root, skillRoot }, 'intent-recorded')
    await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
    const reopened = reopenWithProbe(svc, { root, skillRoot })
    expect((await reopened.reconcile()).map(outcome => outcome.result)).toEqual(['completed-redone'])

    const settled = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(
      'is applied; cannot record "applied"',
    )
    await expect(reopened.rollback('s1', 'root-1', 'approval:call-2')).resolves.toBeDefined()
    await expect(reopened.rollback('s1', 'root-1', 'approval:call-3')).rejects.toThrow(
      'is rolledback; cannot record "rolledback"',
    )
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).not.toBe(settled)
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await ledgerKinds(root)).filter(kind => kind === 'rolledback')).toHaveLength(1)
  })
})

describe('K2: a source that is gone, or a target a third party touched, stops the commit by name', () => {
  it.each(['apply', 'rollback'] as const)(
    'blocks a %s whose target a third party rewrote, leaving the intent open and nothing written',
    async direction => {
      const fixture = await decidedSkillFixture()
      if (direction === 'rollback') await fixture.svc.apply('s1', 'root-1', 'approval:call-1')
      const { root, skillRoot } = fixture
      const crashing = reopenWithProbe(fixture.svc, fixture, 'intent-recorded')
      await refusalOf(
        direction === 'apply'
          ? crashing.apply('s1', 'root-1', 'approval:call-1')
          : crashing.rollback('s1', 'root-1', 'approval:call-2'),
      )
      const reopened = reopenWithProbe(fixture.svc, fixture)
      const target = COMMIT_TARGET(skillRoot)
      await writeFile(target, '# a third party rewrote production\n')
      const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')

      const outcomes = await reopened.reconcile()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({
        intentId: `s1/${direction}`,
        proposalId: 's1',
        direction,
        targets: [target],
        result: 'blocked',
      })
      expect(outcomes[0]!.detail).toMatch(/a third party changed it/)
      expect(outcomes[0]!.detail).toMatch(/the intent stays open/)
      expect(await readFile(target, 'utf8')).toBe('# a third party rewrote production\n')
      expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
      // The intent is still there, so a loader that refuses while it is open keeps
      // refusing, and the retry that names it gets the same stop thrown.
      expect((await reopened.get('s1')).openIntent?.intentId).toBe(`s1/${direction}`)
      expect(await reopened.openIntentTargets()).toEqual([target])
      const retry =
        direction === 'apply'
          ? reopened.apply('s1', 'root-1', 'approval:call-1')
          : reopened.rollback('s1', 'root-1', 'approval:call-2')
      await expect(retry).rejects.toThrow(/a third party changed it/)
    },
  )

  it.each(['apply', 'rollback'] as const)('blocks a %s whose recoverable source is gone', async direction => {
    const fixture = await decidedSkillFixture()
    if (direction === 'rollback') await fixture.svc.apply('s1', 'root-1', 'approval:call-1')
    const { root } = fixture
    const crashing = reopenWithProbe(fixture.svc, fixture, 'intent-recorded')
    await refusalOf(
      direction === 'apply'
        ? crashing.apply('s1', 'root-1', 'approval:call-1')
        : crashing.rollback('s1', 'root-1', 'approval:call-2'),
    )
    const reopened = reopenWithProbe(fixture.svc, fixture)
    await rm(join(root, direction === 'apply' ? CANDIDATE_SOURCE : CHAMPION_SOURCE))
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    const outcomes = await reopened.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ intentId: `s1/${direction}`, result: 'blocked' })
    expect(outcomes[0]!.detail).toMatch(/recoverable source .* is no longer readable as the bytes it committed/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
    expect((await reopened.get('s1')).openIntent?.intentId).toBe(`s1/${direction}`)
    await expect(reopened.reconcile()).resolves.toHaveLength(1)
  })

  it('blocks an intent whose production target disappeared', async () => {
    const { root, skillRoot, reopened } = await (async () => {
      const fixture = await decidedSkillFixture()
      const crashing = reopenWithProbe(fixture.svc, fixture, 'intent-recorded')
      await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
      return { ...fixture, reopened: reopenWithProbe(fixture.svc, fixture) }
    })()
    const target = COMMIT_TARGET(skillRoot)
    await rm(target)

    const [outcome] = await reopened.reconcile()
    expect(outcome).toMatchObject({ result: 'blocked' })
    expect(outcome!.detail).toMatch(/is missing — it holds neither the state before the commit/)
    expect(existsSync(target)).toBe(false)
    expect(await ledgerKinds(root)).not.toContain('applied')
  })

  it('keeps the open-intent query pure: reading it neither writes nor settles anything', async () => {
    const fixture = await decidedSkillFixture()
    const { root, skillRoot } = fixture
    const crashing = reopenWithProbe(fixture.svc, fixture, 'intent-recorded')
    await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const target = COMMIT_TARGET(skillRoot)

    const reopened = reopenWithProbe(fixture.svc, fixture)
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
    expect(await readFile(target, 'utf8')).toBe(P3_BASELINE)
  })
})

describe('K2: a real write failure is not a mock — the intent stays open and reconciliation finishes the job', () => {
  it('throws on a target directory the process cannot write, records no completion, and completes once it can', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const target = COMMIT_TARGET(skillRoot)
    const directory = join(skillRoot, 'verify')
    await chmod(directory, 0o555)
    let message: string
    try {
      message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
      expect(message).toMatch(/EACCES|permission denied/i)
      // The intent is the record of the attempt; the write failed, so there is
      // no completion, no change to production, and the open intent stands.
      expect(await ledgerKinds(root)).toContain('commit_intent')
      expect(await ledgerKinds(root)).not.toContain('applied')
      expect(await readFile(target, 'utf8')).toBe(P3_BASELINE)
      expect((await svc.get('s1')).openIntent?.intentId).toBe('s1/apply')
      expect(await svc.openIntentTargets()).toEqual([target])
    } finally {
      await chmod(directory, 0o755)
    }

    const outcomes = await svc.reconcile()
    expect(outcomes.map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * K3: the whole skill object — the fixed file set, the derivation,     *
 * and the two-file commit. Prepare freezes `SKILL.md` and, for an      *
 * execution object, the `SKILL.contract.json` beside it; the candidate *
 * sidecar is *derived* from production (only its content digest        *
 * moves), and the commit writes, verifies and recovers both files      *
 * together.                                                            *
 * ------------------------------------------------------------------ */

const SKILL_DIR = (root: string, proposalId = 's1', name = 'verify') =>
  join(root, 'sandbox', proposalId, 'skills', name)
const CHAMPION_DIR = (root: string, proposalId = 's1', name = 'verify') =>
  join(root, 'sandbox', proposalId, 'champion', 'skills', name)
const SIDECAR_TARGET = (skillRoot: string, name = 'verify') => join(skillRoot, name, SKILL_SIDECAR_FILE)
const SIDECAR_CANDIDATE_SOURCE = 'sandbox/s1/skills/verify/SKILL.contract.json'
const SIDECAR_CHAMPION_SOURCE = 'sandbox/s1/champion/skills/verify/SKILL.contract.json'

/** The declaration a sidecar file holds, as the loader and the derivation read it. */
function declaredSidecar(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>
}

/** The candidate sidecar the derivation produces: the production declaration with only its content digest moved. */
function derivedSidecar(productionSidecarText: string, candidateSkillMd: string): string {
  return serializeSkillSidecar(
    sidecarWithSkillMd(declaredSidecar(productionSidecarText) as never, sha256Of(candidateSkillMd)),
  )
}

/** The policy-bearing statements of a sidecar, for the "only the digest moves" assertions. */
function sidecarPolicy(text: string): Record<string, unknown> {
  const declared = declaredSidecar(text)
  return {
    contractVersion: declared.contractVersion,
    type: declared.type,
    capabilities: declared.capabilities,
    precondition: declared.precondition,
    inputs: declared.inputs,
    outputs: declared.outputs,
    requiredTools: declared.requiredTools,
    verifier: declared.verifier,
    resources: declared.content.resources,
  }
}

/** Install a production execution object: the `SKILL.md` and a sidecar whose identity covers exactly those bytes. */
async function productionExecutionObject(skillRoot: string, content: string, shape: SkillShape = {}): Promise<void> {
  await writeSkillDirectory(join(skillRoot, 'verify'), 'verify', content, {
    sidecar: 'execution',
    verifierRef: 'command',
    capabilities: [PROMOTION_ROW],
    requiredTools: ['bash'],
    ...shape,
  })
}

/** A production fixture walked to decided(PROMOTE) over an execution object; `probe` opens an interrupt window. */
async function executionDecidedFixture(
  options: {
    production?: string
    candidate?: string
    shape?: SkillShape
    probe?: (stage: CommitStage, target?: string) => void
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-object-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const production = options.production ?? skillText('# production execution skill')
  const candidate = options.candidate ?? skillText('# candidate execution skill')
  await productionExecutionObject(skillRoot, production, options.shape)
  const svc = new EvolutionService(fixtureCtx(), {
    modelSelection: () => FIXTURE_SELECTION,
    root,
    skillRoot,
    ...(options.probe === undefined ? {} : { commitProbe: options.probe }),
  })
  await walkToDecided(svc, skillProposal, { name: 'verify', content: candidate })
  const productionSidecar = await readFile(SIDECAR_TARGET(skillRoot), 'utf8')
  return { svc, dir, root, skillRoot, production, candidate, productionSidecar }
}

/** Reopen one fixture over the same roots with a target-aware interrupt window of its own. */
function reopenWithObjectProbe(
  svc: EvolutionService,
  roots: { root: string; skillRoot: string },
  probe?: (stage: CommitStage, target?: string) => void,
): EvolutionService {
  return reopenLike(svc, {
    modelSelection: () => FIXTURE_SELECTION,
    root: roots.root,
    skillRoot: roots.skillRoot,
    ...(probe === undefined ? {} : { commitProbe: probe }),
  })
}

/** A probe that throws at one stage, optionally only for the file the test names. */
function crashAtObject(
  stage: CommitStage,
  forFile?: 'skillMd' | 'sidecar',
): (seen: CommitStage, target?: string) => void {
  const wanted = forFile === undefined ? undefined : forFile === 'skillMd' ? 'SKILL.md' : SKILL_SIDECAR_FILE
  return (seen, target) => {
    if (seen !== stage) return
    if (wanted !== undefined && !(target ?? '').endsWith(wanted)) return
    throw new Error(
      `in-process probe throw after ${seen}${target === undefined ? '' : ` for ${target}`} — a throw, not a process exit`,
    )
  }
}

describe('K3: prepare freezes the whole skill object', () => {
  it('materializes both files, derives the candidate sidecar, and records both identities', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const production = skillText('# production execution skill')
    const candidate = skillText('# candidate execution skill')
    await productionExecutionObject(skillRoot, production)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: candidate })
    const prepared = await svc.prepare('s1', 'root-1')

    const productionSidecar = await readFile(SIDECAR_TARGET(skillRoot), 'utf8')
    const expectedCandidateSidecar = derivedSidecar(productionSidecar, candidate)
    expect(prepared.prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      skillContent: {
        name: 'verify',
        sha256: sha256Of(candidate),
        contract: {
          sha256: sha256Of(expectedCandidateSidecar),
          contractDigest: skillContractDigest(declaredSidecar(expectedCandidateSidecar) as never),
        },
      },
      skillBaseline: {
        name: 'verify',
        sha256: sha256Of(production),
        contract: {
          sha256: sha256Of(productionSidecar),
          contractDigest: skillContractDigest(declaredSidecar(productionSidecar) as never),
        },
      },
      files: [
        'skills/verify/SKILL.md',
        `skills/verify/${SKILL_SIDECAR_FILE}`,
        'champion/skills/verify/SKILL.md',
        `champion/skills/verify/${SKILL_SIDECAR_FILE}`,
      ],
    })

    // The sandbox holds the candidate text and the derived declaration — the
    // production policy with exactly one field moved.
    expect(await readFile(join(SKILL_DIR(root), 'SKILL.md'), 'utf8')).toBe(candidate)
    const sandboxSidecar = await readFile(join(SKILL_DIR(root), SKILL_SIDECAR_FILE), 'utf8')
    expect(sandboxSidecar).toBe(expectedCandidateSidecar)
    expect(sidecarPolicy(sandboxSidecar)).toEqual(sidecarPolicy(productionSidecar))
    expect(declaredSidecar(sandboxSidecar).content.skillMdSha256).toBe(sha256Of(candidate))
    expect(declaredSidecar(productionSidecar).content.skillMdSha256).toBe(sha256Of(production))

    // The champion snapshot is the production pair, byte for byte.
    expect(await readFile(join(CHAMPION_DIR(root), 'SKILL.md'), 'utf8')).toBe(production)
    expect(await readFile(join(CHAMPION_DIR(root), SKILL_SIDECAR_FILE), 'utf8')).toBe(productionSidecar)
  })

  it('refuses a production knowledge sidecar by name, writing nothing', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await writeSkillDirectory(join(skillRoot, 'verify'), 'verify', skillText('# knowledge production skill'), {
      sidecar: 'knowledge',
    })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# candidate') })

    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow(/carries a knowledge sidecar/)
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect(await ledgerKinds(root)).not.toContain('prepared')
  })

  it('refuses an execution sidecar that declares resources, naming them, writing nothing', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# production skill with a reference')
    const directory = join(skillRoot, 'verify')
    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(join(directory, 'references', 'notes.md'), 'the declared resource\n')
    await writeFile(join(directory, 'SKILL.md'), content)
    await writeFile(
      join(directory, SKILL_SIDECAR_FILE),
      `${JSON.stringify(
        {
          contractVersion: 1,
          type: 'execution',
          capabilities: [PROMOTION_ROW],
          precondition: 'the fixture skill is installed where discovery looks',
          inputs: [],
          outputs: [],
          requiredTools: ['bash'],
          verifier: { ref: 'command' },
          content: {
            skillMdSha256: sha256Of(content),
            resources: [{ path: 'references/notes.md', sha256: sha256Of('the declared resource\n') }],
          },
        },
        null,
        2,
      )}\n`,
    )
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# candidate') })

    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow(/declares 1 resource\(s\) \("references\/notes.md"\)/)
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
  })

  it('refuses a production directory the loader refuses: an undeclared file, or bytes a declaration does not cover', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# production execution skill')
    await productionExecutionObject(skillRoot, content)
    // A file the declaration does not name: "mostly covered" is not an object.
    await writeFile(join(skillRoot, 'verify', 'notes.txt'), 'a file nobody declared\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# candidate') })

    const refusal = await refusalOf(svc.prepare('s1', 'root-1'))
    expect(refusal).toContain('is not the loadable object its files claim')
    expect(refusal).toContain('notes.txt')
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)

    // The other direction: the declaration no longer covers the bytes.
    await rm(join(skillRoot, 'verify', 'notes.txt'))
    await writeFile(
      SIDECAR_TARGET(skillRoot),
      `${JSON.stringify(
        {
          contractVersion: 1,
          type: 'execution',
          capabilities: [PROMOTION_ROW],
          precondition: 'the fixture skill is installed where discovery looks',
          inputs: [],
          outputs: [],
          requiredTools: ['bash'],
          verifier: { ref: 'command' },
          content: { skillMdSha256: sha256Of(skillText('# another skill entirely')), resources: [] },
        },
        null,
        2,
      )}\n`,
    )
    const drifted = await refusalOf(svc.prepare('s1', 'root-1'))
    expect(drifted).toContain('is not the loadable object its files claim')
    expect(drifted).toContain('SKILL.md is not the declared content')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
  })

  it('refuses a guidance production directory holding a file beyond SKILL.md, where no declaration exists to reject it', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const directory = join(skillRoot, 'verify')
    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(join(directory, 'references', 'notes.md'), 'a reference nobody declared\n')
    await writeFile(join(directory, 'SKILL.md'), skillText('# production guidance skill'))
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# candidate') })

    // No sidecar, so the loader has nothing to hold the directory to: the file
    // is reported as a resource the identity does not cover, and prepare must
    // refuse it rather than freeze the SKILL.md alone and call it the object.
    const refusal = await refusalOf(svc.prepare('s1', 'root-1'))
    expect(refusal).toContain('references/notes.md')
    expect(refusal).toContain('nothing was written')
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
  })
})

describe('K3: P2 and P3 hold the whole object', () => {
  it('refuses a candidate whose SKILL.md or sidecar moved after prepare, before any write', async () => {
    for (const file of ['SKILL.md', SKILL_SIDECAR_FILE] as const) {
      const fixture = await executionDecidedFixture()
      const { svc, root, skillRoot } = fixture
      const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
      const moved =
        file === 'SKILL.md'
          ? skillText('# the candidate SKILL.md moved after prepare')
          : derivedSidecar(fixture.productionSidecar, skillText('# a sidecar derived from other bytes'))
      await writeFile(join(SKILL_DIR(root), file), moved)

      const refusal = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
      expect(refusal).toContain('no longer matches the content identity recorded at prepare')
      expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
      expect(await ledgerKinds(root)).not.toContain('applied')
      expect(await ledgerKinds(root)).not.toContain('commit_intent')
      expect(await svc.openIntentTargets()).toEqual([])
    }
  })

  it('refuses a candidate whose recorded sidecar is missing, and one whose guidance identity gained one', async () => {
    // Recorded sidecar deleted: the object is incomplete.
    const execution = await executionDecidedFixture()
    await rm(join(SKILL_DIR(execution.root), SKILL_SIDECAR_FILE))
    expect(await refusalOf(execution.svc.checkPromotion('s1'))).toContain('cannot be read as a real file')

    // Guidance identity, sidecar added: a different object than the one frozen.
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const content = skillText('# guidance candidate')
    await skillCandidateGated(svc, content)
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
      sidecar: 'execution',
      verifierRef: 'command',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })
    expect(await refusalOf(svc.checkPromotion('s1'))).toContain('the content identity recorded at prepare is guidance')
  })

  it('refuses a candidate sidecar whose declaration moved: the derivation, not the file, is the contract', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, candidate } = fixture
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const productionSidecar = declaredSidecar(fixture.productionSidecar)
    // The candidate's sidecar with an escalated declaration — a patch the model
    // never submits, forged here to prove the promotion refuses it.
    const escalated = serializeSkillSidecar({
      ...productionSidecar,
      requiredTools: [...productionSidecar.requiredTools, 'job_output'],
      content: { skillMdSha256: sha256Of(candidate), resources: [] },
    } as never)
    await writeFile(join(SKILL_DIR(root), SKILL_SIDECAR_FILE), escalated)

    const refusal = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
    // The bytes moved, so the P2 identity refuses it first — either way the
    // promotion stops by name with nothing written and nothing recorded.
    expect(refusal).toMatch(/no longer matches the content identity recorded at prepare/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(fixture.production)
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses a production sidecar that moved after prepare, and one that appeared beside a guidance baseline', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot } = fixture
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const declared = declaredSidecar(fixture.productionSidecar)
    await writeFile(
      SIDECAR_TARGET(skillRoot),
      serializeSkillSidecar({
        ...declared,
        requiredTools: [...declared.requiredTools, 'job_output'],
      } as never),
    )

    const refusal = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
    expect(refusal).toContain('sidecar')
    expect(refusal).toContain('changed since prepare')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')

    // The other direction: production grows a sidecar the baseline never had.
    const guidance = await serviceWithProduction()
    await productionSkill(guidance.skillRoot)
    await skillCandidateGated(guidance.svc, skillText('# guidance candidate'))
    await guidance.svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    const sidecarBefore = await readFile(join(guidance.root, 'proposals.jsonl'), 'utf8')
    await writeSkillDirectory(join(guidance.skillRoot, 'verify'), 'verify', P3_BASELINE, {
      sidecar: 'execution',
      verifierRef: 'command',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })
    expect(await refusalOf(guidance.svc.apply('s1', 'root-1', 'approval:call-1'))).toContain(
      'now carries a SKILL.contract.json the baseline prepare recorded did not have',
    )
    expect(await readFile(join(guidance.root, 'proposals.jsonl'), 'utf8')).toBe(sidecarBefore)
  })

  it('refuses a promotion and a rollback whose champion sidecar no longer hashes to the recorded baseline', async () => {
    // The promotion door: the champion snapshot's sidecar half is what the
    // candidate's declaration is derived from, so a moved snapshot is refused
    // before a human is asked and before anything is written.
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot } = fixture
    const championSidecar = join(CHAMPION_DIR(root), SKILL_SIDECAR_FILE)
    const beforePromotion = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(
      championSidecar,
      derivedSidecar(fixture.productionSidecar, skillText('# a sidecar derived from other bytes')),
    )
    const promotionRefusal = await refusalOf(svc.checkPromotion('s1'))
    expect(promotionRefusal).toContain('no longer holds the sidecar bytes prepare recorded')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(beforePromotion)
    expect(await svc.openIntentTargets()).toEqual([])

    // The rollback door: restore the snapshot, apply for real, then damage the
    // sidecar half — the rollback refuses before any intent is recorded, and
    // production keeps both files of the applied object.
    await writeFile(championSidecar, fixture.productionSidecar)
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const beforeRollback = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(championSidecar, derivedSidecar(fixture.productionSidecar, skillText('# the snapshot was damaged')))
    const rollbackRefusal = await refusalOf(svc.rollback('s1', 'root-1', 'approval:call-2'))
    expect(rollbackRefusal).toMatch(/champion snapshot .* no longer hashes/)
    expect(rollbackRefusal).toContain(SKILL_SIDECAR_FILE)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(beforeRollback)
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(fixture.candidate)
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(
      derivedSidecar(fixture.productionSidecar, fixture.candidate),
    )
    expect(await svc.openIntentTargets()).toEqual([])
  })
})

/**
 * The derivation re-check is the promotion gate's own line of defence, and this
 * describe reaches it directly.
 *
 * Through the model-facing entries the branch is unreachable: a sandbox sidecar
 * anybody touches trips P2's byte check first. What it really guards is the
 * *hand-forged ledger* path: a prepared record whose candidate-sidecar identity
 * is self-consistent with the swapped bytes (the exact-byte digest and the
 * canonical declaration digest both match them), but whose declaration is not
 * the production object's. The fold validates shapes and P2 compares bytes with
 * the record, so both pass — only re-deriving the sidecar from the champion's
 * own bytes plus the candidate `SKILL.md` digest can tell the two apart.
 */
describe('K3: the derivation check refuses a forged ledger whose prepared sidecar is not production\u2019s', () => {
  it('refuses a hand-written prepared identity covering an escalated sidecar, before P2\u2019s wording could', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, productionSidecar, candidate } = fixture
    const sidecarPath = join(SKILL_DIR(root), SKILL_SIDECAR_FILE)
    expect(await readFile(sidecarPath, 'utf8')).toBe(derivedSidecar(productionSidecar, candidate))

    // The swapped declaration: the production policy with one more tool added
    // that the capability table *does* grant (`read` expands from the fixture
    // row's labels), so the provider validator stays silent — a real widening
    // of what the skill demands, and the forged identity below covers exactly
    // these bytes.
    const escalated = serializeSkillSidecar({
      ...declaredSidecar(productionSidecar),
      requiredTools: [...declaredSidecar(productionSidecar).requiredTools, 'read'],
      content: { skillMdSha256: sha256Of(candidate), resources: [] },
    } as never)
    const escalatedIdentity = {
      sha256: sha256Of(escalated),
      contractDigest: skillContractDigest(declaredSidecar(escalated) as never),
    }
    await writeFile(sidecarPath, escalated)

    // The hand-forged ledger: every real line kept, and only the prepared
    // record's candidate-sidecar half replaced by the swapped bytes' own
    // identity. The shape is flawless — hex64 digests, the baseline half
    // untouched — which is exactly the attack surface.
    const lines = await ledgerLinesOf(root)
    const prepared = lines.find(line => line.kind === 'prepared')!
    prepared.skillContent.contract = escalatedIdentity
    await writeFile(join(root, 'proposals.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)

    const forged = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })

    // The fold accepts the record — no fold defence stands between this ledger
    // and the promotion gate.
    const folded = await forged.get('s1')
    expect(folded.prepared!.skillContent!.contract).toEqual(escalatedIdentity)
    // The baseline half is the real one, untouched: the forged record is
    // self-consistent, not visibly broken.
    expect(folded.prepared!.skillBaseline!.contract).toEqual({
      sha256: sha256Of(productionSidecar),
      contractDigest: skillContractDigest(declaredSidecar(productionSidecar) as never),
    })
    // P2 accepts the pair too: the sandbox sidecar really is the bytes the
    // record names, so nothing but the derivation re-check is left.
    expect((await forged.readSkillCandidate('s1')).sidecar!.toString('utf8')).toBe(escalated)

    const ledgerBefore = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const message = await refusalOf(forged.checkPromotion('s1'))
    expect(message).toContain('not the declaration derived from production')
    expect(message).toContain('required tools')
    expect(message).not.toContain('no longer matches the content identity recorded at prepare')

    // apply runs the same check before any intent is recorded or any byte is
    // written: production and the ledger stay exactly as they were.
    const applied = await refusalOf(forged.apply('s1', 'root-1', 'approval:call-1'))
    expect(applied).toContain('not the declaration derived from production')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(ledgerBefore)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(productionSidecar)
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(production)
  })
})

describe('K3: the two-file commit', () => {
  it('applies both files as one commit and rolls the pair back', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, candidate, productionSidecar } = fixture
    const expectedAppliedSidecar = derivedSidecar(productionSidecar, candidate)
    const outcome = await svc.apply('s1', 'root-1', 'approval:call-1')
    const skillTarget = COMMIT_TARGET(skillRoot)
    const sidecarTarget = SIDECAR_TARGET(skillRoot)

    expect(outcome.targets).toEqual([skillTarget, sidecarTarget])
    expect(await readFile(skillTarget, 'utf8')).toBe(candidate)
    const appliedSidecar = await readFile(sidecarTarget, 'utf8')
    expect(appliedSidecar).toBe(expectedAppliedSidecar)
    expect(sidecarPolicy(appliedSidecar)).toEqual(sidecarPolicy(productionSidecar))

    const intent = (await ledgerLinesOf(root)).find(line => line.kind === 'commit_intent')!
    expect(intent.files).toEqual([
      {
        target: skillTarget,
        baselineSha256: sha256Of(production),
        contentSha256: sha256Of(candidate),
        source: CANDIDATE_SOURCE,
      },
      {
        target: sidecarTarget,
        baselineSha256: sha256Of(productionSidecar),
        contentSha256: sha256Of(expectedAppliedSidecar),
        source: SIDECAR_CANDIDATE_SOURCE,
      },
    ])
    const applied = (await ledgerLinesOf(root)).find(line => line.kind === 'applied')!
    expect(applied.targets).toEqual([skillTarget, sidecarTarget])
    expect((await svc.get('s1')).status).toBe('applied')
    expect(await svc.openIntentTargets()).toEqual([])
    expect((await readdir(join(skillRoot, 'verify'))).filter(entry => entry.includes('.tmp-'))).toEqual([])

    const rolled = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(rolled.targets).toEqual([skillTarget, sidecarTarget])
    expect(await readFile(skillTarget, 'utf8')).toBe(production)
    expect(await readFile(sidecarTarget, 'utf8')).toBe(productionSidecar)
    const rollbackIntent = (await ledgerLinesOf(root)).filter(line => line.kind === 'commit_intent')[1]!
    expect(rollbackIntent.files.map((file: { source: string }) => file.source)).toEqual([
      CHAMPION_SOURCE,
      SIDECAR_CHAMPION_SOURCE,
    ])
    expect((await ledgerLinesOf(root)).find(line => line.kind === 'rolledback')!.targets).toEqual([
      skillTarget,
      sidecarTarget,
    ])
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses a rollback whose sidecar no longer holds what the proposal applied, before any intent', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production } = fixture
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(
      SIDECAR_TARGET(skillRoot),
      derivedSidecar(fixture.productionSidecar, skillText('# a third party rewrote the sidecar')),
    )

    const refusal = await refusalOf(svc.rollback('s1', 'root-1', 'approval:call-2'))
    expect(refusal).toContain('does not hold the content proposal "s1" applied')
    expect(refusal).toContain(SIDECAR_TARGET(skillRoot))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await svc.openIntentTargets()).toEqual([])
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).not.toBe(production)
  })

  it('names the rewritten file when a commit stops, for either file of the pair', async () => {
    for (const file of ['SKILL.md', SKILL_SIDECAR_FILE] as const) {
      const fixture = await executionDecidedFixture()
      const { svc, root, skillRoot } = fixture
      const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('intent-recorded'))
      await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
      const reopened = reopenWithObjectProbe(svc, fixture)
      const target = file === 'SKILL.md' ? COMMIT_TARGET(skillRoot) : SIDECAR_TARGET(skillRoot)
      await writeFile(target, '# a third party rewrote this file\n')
      const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

      const [outcome] = await reopened.reconcile()
      expect(outcome!.result).toBe('blocked')
      expect(outcome!.targets).toEqual([COMMIT_TARGET(skillRoot), SIDECAR_TARGET(skillRoot)])
      expect(outcome!.detail).toContain(target)
      expect(outcome!.detail).toContain('a third party changed it')
      expect(await readFile(target, 'utf8')).toBe('# a third party rewrote this file\n')
      expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
      expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')
    }
  })

  it.each([
    ['intent-recorded', undefined, 'completed-redone'],
    ['write-staged', undefined, 'completed-redone'],
    // The plain window is between the two renames: SKILL.md landed, the sidecar
    // has not, so the recovery finishes the pair (`completed-redone`).
    ['write-renamed', undefined, 'completed-redone'],
    // After the *second* rename every file is in place: only the record is missing.
    ['write-renamed', 'sidecar', 'completed-written'],
    ['commit-verified', undefined, 'completed-written'],
  ] as const)(
    'settles an apply interrupted after %s%s with both files and one completion row',
    async (stage, forFile, expected) => {
      const fixture = await executionDecidedFixture()
      const { svc, root, skillRoot, candidate, productionSidecar } = fixture
      const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject(stage, forFile))
      expect(await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))).toContain(
        `in-process probe throw after ${stage}`,
      )
      const reopened = reopenWithObjectProbe(svc, fixture)
      expect((await ledgerKinds(root)).at(-1)).toBe('commit_intent')

      const outcomes = await reopened.reconcile()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.targets).toEqual([COMMIT_TARGET(skillRoot), SIDECAR_TARGET(skillRoot)])
      expect(outcomes[0]!.result).toBe(expected)
      expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(derivedSidecar(productionSidecar, candidate))
      expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(candidate)
      const settledKinds = await ledgerKinds(root)
      expect(settledKinds.filter(kind => kind === 'applied')).toHaveLength(1)
      const applied = (await ledgerLinesOf(root)).find(line => line.kind === 'applied')!
      expect(applied.targets).toEqual([COMMIT_TARGET(skillRoot), SIDECAR_TARGET(skillRoot)])
      expect((await reopened.get('s1')).openIntent).toBeUndefined()
    },
  )

  it('finishes the mixed window: only SKILL.md renamed, then the sidecar written by the recovery', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, candidate, productionSidecar } = fixture
    // Between the two renames: the SKILL.md is the new version, the sidecar
    // still the old one — a pair no loader accepts, and exactly the state the
    // ledger intent explains.
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('write-renamed', 'skillMd'))
    expect(await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))).toContain(
      'in-process probe throw after write-renamed',
    )
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(candidate)
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).not.toBe(derivedSidecar(productionSidecar, candidate))

    const reopened = reopenWithObjectProbe(svc, fixture)
    const [outcome] = await reopened.reconcile()
    expect(outcome!.result).toBe('completed-redone')
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(candidate)
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(derivedSidecar(productionSidecar, candidate))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await reopened.get('s1')).openIntent).toBeUndefined()
    expect(await reopened.reconcile()).toEqual([])
    expect(production).not.toBe(candidate)
  })

  it('settles a commit interrupted after every write verified: only the completion is recorded', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, candidate } = fixture
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('commit-verified'))
    expect(await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))).toContain(
      'in-process probe throw after commit-verified',
    )
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(candidate)
    expect(await ledgerKinds(root)).not.toContain('applied')

    const reopened = reopenWithObjectProbe(svc, fixture)
    const [outcome] = await reopened.reconcile()
    expect(outcome!.result).toBe('completed-written')
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await ledgerLinesOf(root)).find(line => line.kind === 'applied')!.targets).toEqual([
      COMMIT_TARGET(skillRoot),
      SIDECAR_TARGET(skillRoot),
    ])
    expect(await reopened.reconcile()).toEqual([])
  })

  it.each(INTERRUPTED_STAGES)('settles a rollback interrupted after %s over the pair', async stage => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, productionSidecar } = fixture
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject(stage))
    await refusalOf(crashing.rollback('s1', 'root-1', 'approval:call-2'))
    const reopened = reopenWithObjectProbe(svc, fixture)

    const outcomes = await reopened.reconcile()
    // Same windows as an apply: the plain `write-renamed` window is between the
    // two renames, so the recovery finishes the pair.
    expect(outcomes.map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(production)
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(productionSidecar)
    expect((await ledgerKinds(root)).filter(kind => kind === 'rolledback')).toHaveLength(1)
    expect((await ledgerLinesOf(root)).find(line => line.kind === 'rolledback')!.targets).toEqual([
      COMMIT_TARGET(skillRoot),
      SIDECAR_TARGET(skillRoot),
    ])
  })

  it('blocks both proposals of one skill directory: the per-object gate matches the directory, not one file', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot } = fixture
    await walkToDecided(
      svc,
      { ...skillProposal, proposalId: 's2' },
      { name: 'verify', content: skillText('# the second candidate') },
    )
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('intent-recorded'))
    await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
    const reopened = reopenWithObjectProbe(svc, fixture)
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    const refusal = await refusalOf(reopened.apply('s2', 'root-1', 'approval:call-2'))
    expect(refusal).toContain("another proposal's unsettled intent")
    expect(refusal).toContain(dirname(SIDECAR_TARGET(skillRoot)))
    expect(refusal).toContain('s1/apply')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)

    // Settling the first proposal's intent admits commits again — and the second
    // proposal's own baseline check then refuses it, because production moved.
    expect((await reopened.reconcile()).map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await reopened.openIntentTargets()).toEqual([])
    expect(await refusalOf(reopened.apply('s2', 'root-1', 'approval:call-2'))).toContain('changed since prepare')
  })

  it('reports the blocked intent, instead of throwing, when the production directory cannot be listed', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, productionSidecar } = fixture
    const skillTarget = COMMIT_TARGET(skillRoot)
    const sidecarTarget = SIDECAR_TARGET(skillRoot)
    const directory = join(skillRoot, 'verify')
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('intent-recorded'))
    await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))

    // One open intent, nothing written: both files still hold the baseline, and
    // the intent names them.
    const ledgerBefore = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const entriesBefore = (await readdir(directory)).sort()
    expect(await ledgerKinds(root)).toContain('commit_intent')
    expect(await readFile(skillTarget, 'utf8')).toBe(production)
    expect(await readFile(sidecarTarget, 'utf8')).toBe(productionSidecar)

    // The window this pins: every file the intent names is still readable one by
    // one (the directory keeps `x`), but the directory itself cannot be listed —
    // so what else it holds is unknowable to the pre-write object check. That is
    // a refusal to *report*, not an exception to throw: a recovery that threw
    // here would abort the whole batch over one directory, and the caller would
    // never see the named reason.
    const reopened = reopenWithObjectProbe(svc, fixture)
    await chmod(directory, 0o300)
    let outcomes: ReconcileOutcome[] = []
    try {
      outcomes = await reopened.reconcile()
    } catch (error) {
      throw new Error(
        `reconcile() threw instead of reporting a blocked intent: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      await chmod(directory, 0o755)
    }

    expect(outcomes).toHaveLength(1)
    const [outcome] = outcomes
    expect(outcome!.result).toBe('blocked')
    expect(outcome!.targets).toEqual([skillTarget, sidecarTarget])
    expect(outcome!.detail).toContain('cannot be read to check what it holds')
    expect(outcome!.detail).toContain(directory)
    expect(outcome!.detail).toContain('the intent stays open')
    expect(outcome!.detail).toContain('nothing is written')

    // Zero writes: the same ledger bytes (no completion line was appended), the
    // same two files, the same directory entries, and the intent still open.
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(ledgerBefore)
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied' || kind === 'rolledback')).toEqual([])
    expect(await readFile(skillTarget, 'utf8')).toBe(production)
    expect(await readFile(sidecarTarget, 'utf8')).toBe(productionSidecar)
    expect((await readdir(directory)).sort()).toEqual(entriesBefore)
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')
    expect(await reopened.openIntentTargets()).toEqual([skillTarget, sidecarTarget])

    // The fresh path over the same obstacle, on a world whose proposal has no
    // open intent: the commit path turns the same reason into its own named stop
    // before the intent line, so the refusal is the commit's words and not the
    // directory read's.
    const fresh = await executionDecidedFixture()
    const freshDirectory = join(fresh.skillRoot, 'verify')
    const freshBefore = await readFile(join(fresh.root, 'proposals.jsonl'), 'utf8')
    await chmod(freshDirectory, 0o300)
    let refusal: string
    try {
      refusal = await refusalOf(fresh.svc.apply('s1', 'root-1', 'approval:call-1'))
    } finally {
      await chmod(freshDirectory, 0o755)
    }
    expect(refusal).toContain('cannot be read to check what it holds')
    expect(refusal).toContain(freshDirectory)
    expect(refusal).toContain('nothing was written')
    expect(await readFile(join(fresh.root, 'proposals.jsonl'), 'utf8')).toBe(freshBefore)
    expect(await ledgerKinds(fresh.root)).not.toContain('commit_intent')
    expect(await readFile(COMMIT_TARGET(fresh.skillRoot), 'utf8')).toBe(fresh.production)
    expect((await fresh.svc.get('s1')).status).toBe('decided')
  })
})

describe('K3: fold invariants for the two-file object', () => {
  it("refuses a completion whose target list is not the intent's file set, in order", async () => {
    const twoFile = intentLine({
      files: [intentFile(), { ...intentFile(), target: '/production/skills/verify/SKILL.contract.json' }],
    })
    const reordered = appliedLine({ targets: ['/production/skills/verify/SKILL.contract.json', FORGED_TARGET] })
    const { svc } = await ledgerFixture(decidedLines([twoFile, reordered]))
    await expect(svc.list()).rejects.toThrow(/a completion records the exact file set its intent committed/)

    const { svc: short } = await ledgerFixture(decidedLines([twoFile, appliedLine()]))
    await expect(short.list()).rejects.toThrow(/a completion records the exact file set its intent committed/)
  })

  it('refuses a prepared record whose candidate and baseline identities disagree about the object shape', async () => {
    const lines = decidedLines()
    const prepared = lines[2] as Record<string, unknown>
    const fixture = await ledgerFixture([
      ...lines.slice(0, 2),
      {
        ...prepared,
        skillContent: {
          name: 'verify',
          sha256: sha256Of(SKILL_CANDIDATE),
          contract: { sha256: sha256Of('a sidecar'), contractDigest: sha256Of('a digest') },
        },
      },
      ...lines.slice(3),
    ])
    await expect(fixture.svc.list()).rejects.toThrow(/mixes object shapes/)
  })

  it('refuses a prepared record whose contract half is malformed', async () => {
    const lines = decidedLines()
    const prepared = lines[2] as Record<string, unknown>
    const fixture = await ledgerFixture([
      ...lines.slice(0, 2),
      {
        ...prepared,
        skillBaseline: {
          name: 'verify',
          sha256: sha256Of(P3_BASELINE),
          contract: { sha256: 'not-a-digest', contractDigest: sha256Of('x') },
        },
      },
      ...lines.slice(3),
    ])
    await expect(fixture.svc.list()).rejects.toThrow(/skillBaseline\.contract must be \{ sha256, contractDigest \}/)
  })
})
