import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, vi } from 'vitest'
import type { CapabilityConfig, ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import { registryRevision, skillContentDigest } from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService } from '../../src/evolution.ts'
import type { Config, GateAnswers, ProposeInput } from '../../src/evolution.ts'
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
import { defineEvolutionReplayTool } from '../../../agent-singularity/src/tools/evolution-replay.ts'

/**
 * The task-store rows a promotion fixture's gate re-reads. `fixtureCtx()` owns
 * one set per service and exposes it through `ctx.promotionStore`, so
 * {@link recordSkillExperiment} can settle the sides a skill promotion is judged
 * on and the gate finds exactly those rows when it goes looking.
 */
export interface FixtureRows {
  tasks: Record<string, unknown>[]
  runs: Record<string, unknown>[]
  reviews: Record<string, unknown>[]
  evidence: Record<string, unknown>[]
  /** The session logs the gate re-reads a side's real requests from, by session id. */
  sessions: Map<string, unknown[]>
}

/** The one model selection every fixture service resolves — the one the experiments below freeze. */
export const FIXTURE_SELECTION = modelSelectionOf({ provider: 'p', model: 'm' })!

/** The registry revision the fixture's production configuration resolves to (frozen and bound alike). */
export const FIXTURE_REGISTRY_REVISION = 'r'.repeat(64)

/** The judge every sample criterion of a frozen experiment pins, as the fixture's registry declares it. */
export const FIXTURE_JUDGE = { ref: 'command', version: '1' } as const

/** The provider identity the fixture's production configuration resolves to (no rows, no skills). */
export function fixtureProviderIdentity(): FrozenProviderIdentity {
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
export function fixtureRequestHeader(seq = 1): Record<string, unknown> {
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
export function fixtureSideRun(input: {
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

export function fixtureCtx() {
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
export function ctxOf(svc: EvolutionService): never {
  return (svc as unknown as { ctx: never }).ctx
}

/** A second service over the same ledger and store rows as `svc`. */
export function reopenLike(svc: EvolutionService, config: Config): EvolutionService {
  return new EvolutionService(ctxOf(svc), config)
}

/** The refusal message of one call, or `''` when it resolved. */
export async function refusalOf(action: Promise<unknown>): Promise<string> {
  try {
    await action
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The report path of a skill proposal's recorded experiment — the evidence its gate must cite. */
export async function experimentReportPathOf(svc: EvolutionService, proposalId = 's1'): Promise<string> {
  const [experiment] = await svc.experiments(proposalId)
  if (experiment === undefined) throw new Error(`proposal "${proposalId}" has no recorded experiment`)
  return experiment.report
}

/** The mutable store rows behind one fixture service. */
export function promotionRows(svc: EvolutionService): FixtureRows {
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
export const CAPABILITY_FIXTURE_SKILL = 'capability-fixture-skill'

/**
 * The row the provider-check fixtures replace, and the skill it grants: both
 * named so no deployment can collide with them, and the row carrying the tools
 * an execution fixture needs — the covering set a promotion check reads off the
 * row that grants the provider.
 */
export const PROMOTION_ROW = 'promotion-fixture-capability'

export const PROMOTION_SKILL = 'promotion-fixture-skill'

/**
 * The verifier vocabulary every fixture context reports, as a real registry
 * lists its built-ins after `ready()`.
 */
export const VERIFIER_VOCABULARY = ['command', 'composite', 'review']

/**
 * The capability table the fixture context's runtime registry answers with. The
 * capability tests replace one row at a time, so the table holds the rows they
 * start from; a replaced row is folded in by the promotion check itself.
 */
export const FIXTURE_CAPABILITIES: Readonly<Record<string, CapabilityConfig>> = {
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
export function skillText(body: string, name = 'verify'): string {
  return `---\nname: ${name}\ndescription: candidate skill for a promotion test\n---\n\n${body}`
}

/**
 * The production fixture contents (K3). Prepare reads the production object
 * through the same loader a provider check uses, so a fixture production
 * `SKILL.md` must be a loadable file — frontmatter included — and every case
 * that only needs "some production bytes" says so through one of these.
 */
export const PRODUCTION_V1 = skillText('# old verify skill')

export const PRODUCTION_OLD = skillText('old skill text')

export const PRODUCTION_REPLACED = skillText('# the production skill the candidate replaces')

/** The pinned skill home a capability fixture installs into is per-test; un-pin it however the test ends. */
afterEach(() => {
  vi.unstubAllEnvs()
})

export async function service() {
  const root = await mkdtemp(join(tmpdir(), 'evolution-'))
  return new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
}

export const proposal: ProposeInput = {
  proposalId: 'p1',
  targetType: 'task_definition',
  targetId: 'build:1',
  baseVersion: 'v3',
  level: 'L2',
  rationale: 'the acceptance command never feeds empty input',
  sourceRefs: ['diagnosis:d1'],
}

export function gateAnswers(refs: string[]): GateAnswers {
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

export const VERSION_SET = { taskDefinition: 'v3', verifier: 'v1' }

export const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }

export function toolCtx(svc: EvolutionService, approvalOutcome: string = 'allowed-once') {
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

export function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

export const skillProposal: ProposeInput = {
  proposalId: 's1',
  targetType: 'skill',
  targetId: 'verify',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the skill never mentions empty-input fixtures',
  sourceRefs: ['diagnosis:d1'],
}

export const capabilityProposal: ProposeInput = {
  proposalId: 'c1',
  targetType: 'capability',
  targetId: 'research',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'research needs the verify skill',
  sourceRefs: ['diagnosis:d1'],
}

export const capabilityMutation = {
  name: 'research',
  entry: { preset: 'standard', skills: [CAPABILITY_FIXTURE_SKILL] },
}

/** Service whose ledger root and production skills root all live in one fresh temp dir. */
export async function serviceWithRoots() {
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
export async function requireProductionSkill(skillRoot: string): Promise<void> {
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_REPLACED)
}

/** A terminal champion task plus its review record, as the replay tool's store fixture. */
export const championTask = {
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

export const championReview = {
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
export const FIXTURE_CAPABILITY_TABLE = { research: { skills: ['verify'], preset: 'standard' } }

export const FIXTURE_PROVIDER_CONTENT_DIGEST = skillContentDigest({
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
export async function preparedSkillExperiment(options: { candidate?: string; production?: string } = {}) {
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

/** One terminal sample task and its review record, as the two-sided experiment's store holds them. */
export function sampleCase(taskId: string, runId: string, criterionId: string, outcome: 'verified' | 'failed') {
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

export const FAILED_SAMPLE = sampleCase('t-fail', 'r-fail', 'ac-fix', 'failed')

export const HOLDOUT_SAMPLE = sampleCase('t-holdout', 'r-holdout', 'ac-holdout', 'verified')

export const REGRESSION_SAMPLE = sampleCase('t-regression', 'r-regression', 'ac-keep', 'verified')

/**
 * A store the experiment can walk: the samples the caller names, and the side
 * each replay settles, appended the way the store itself would have recorded it
 * (the orchestrator re-reads the store after every run and records what it
 * finds there, so a fixture that did not append would record nothing).
 */
export function experimentStore() {
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

/* ------------------------------------------------------------------ */
/* W16: decided(PROMOTE) → applied → rolledback — the apply/rollback   */
/* mechanism with its own human-approval gate (guide §2.7.7/§2.9.2).   */
/* ------------------------------------------------------------------ */

/** Two-document config.yml fixture; document 2 carries a decoy `research:` row to prove edits never cross the `---`. */
export const CONFIG_FIXTURE = [
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
export async function serviceWithProduction() {
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
export async function installCapabilityFixtureSkill(dir: string): Promise<string> {
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
export async function recordSkillExperiment(
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
export async function walkToDecided(svc: EvolutionService, input: ProposeInput, mutation: unknown) {
  await svc.propose(input, 'root-1')
  await svc.candidate(input.proposalId, VERSION_SET, 'root-1', mutation)
  await svc.prepare(input.proposalId, 'root-1')
  const { reportPath } = await recordSkillExperiment(svc, input.proposalId)
  await svc.gate(input.proposalId, gateAnswers([reportPath]), 'root-1')
  await svc.decide(input.proposalId, 'PROMOTE', 'root-1', 'approval:call-0')
}

/* ------------------------------------------------------------------ */
/* P2: single-file skill candidate content binding. prepare records    */
/* the SHA-256 of the materialized SKILL.md; the replay report, every   */
/* gate, and the apply write re-verify that exact content.              */
/* ------------------------------------------------------------------ */

export const SKILL_CANDIDATE = skillText('# new verify skill\n\nwith a trailing newline')

/* ------------------------------------------------------------------ */
/* P3: the production baseline must not have moved. prepare records the  */
/* SHA-256 of the production SKILL.md from the same single read that     */
/* produced the champion snapshot; the apply seams compare the live      */
/* production target against it and refuse a stale candidate instead of  */
/* overwriting a production skill that changed. Serial single-process    */
/* calls only — no cross-process lock, no atomic compare-and-swap.       */
/* ------------------------------------------------------------------ */

export const P3_BASELINE = skillText('# production verify skill')

export const P3_CANDIDATE_A = skillText('# candidate A')

export const P3_CANDIDATE_B = skillText('# candidate B')

export const skillProductionFile = (skillRoot: string, name = 'verify') => join(skillRoot, name, 'SKILL.md')

/** Walk a skill proposal under a fresh id to decided(PROMOTE) against the production state as it stands. */
export async function walkSkillToDecided(svc: EvolutionService, proposalId: string, content: string) {
  await walkToDecided(svc, { ...skillProposal, proposalId }, { name: 'verify', content })
}

export async function ledgerKinds(root: string): Promise<string[]> {
  return (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { kind: string }).kind)
}

/** A production skill root holding one real SKILL.md, the champion of every P3 fixture. */
export async function productionSkill(skillRoot: string, text: string = P3_BASELINE) {
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(skillProductionFile(skillRoot), text)
}

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
export interface SkillShape {
  /** `execution` carries a verifier ref and required tools; `knowledge` carries neither; omitted writes `SKILL.md` alone (guidance). */
  sidecar?: 'execution' | 'knowledge'
  verifierRef?: string
  capabilities?: readonly string[]
  requiredTools?: readonly string[]
}

/** SHA-256 of text, computed here so the validator is never confirmed against itself. */
export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Write one skill directory as every provider check reads it: a `SKILL.md`
 * whose frontmatter declares the granted name, plus — when the shape asks for
 * one — a sidecar whose declared content identity is the digest of exactly
 * those bytes.
 */
export async function writeSkillDirectory(
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
 * Walk one skill proposal to `gated` with the sandbox candidate holding
 * `content`, its experiment recorded. `install` writes the production object the
 * candidate replaces — a plain guidance skill by default, or an execution object
 * when a case needs a two-file one (K3: whether the candidate has a sidecar is
 * decided by production, not by the candidate).
 */
export async function skillCandidateGated(
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
export function skillCandidateDirectory(root: string, proposalId = 's1', name = 'verify'): string {
  return join(root, 'sandbox', proposalId, 'skills', name)
}

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
export const COMMIT_TARGET = (skillRoot: string) => join(skillRoot, 'verify', 'SKILL.md')

export const CANDIDATE_SOURCE = 'sandbox/s1/skills/verify/SKILL.md'

export const CHAMPION_SOURCE = 'sandbox/s1/champion/skills/verify/SKILL.md'

/** The commit stages an interrupt window is opened at, and the state production is left in for each. */
export const INTERRUPTED_STAGES = ['intent-recorded', 'write-staged', 'write-renamed'] as const

/** Every ledger line, parsed, oldest first — the file itself, never the service's memory. */
export async function ledgerLinesOf(root: string): Promise<Record<string, any>[]> {
  return (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, any>)
}

/** A production target that no fixture root owns — the fold touches no disk. */
export const FORGED_TARGET = '/production/skills/verify/SKILL.md'

export const FORGED_INTENT = 's1/apply'

/** The ledger lines of a decided(PROMOTE) skill proposal, as the fixture's own entries write them. */
export function decidedLines(extra: readonly Record<string, unknown>[] = []): Record<string, unknown>[] {
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
export function intentLine(over: Record<string, unknown> = {}): Record<string, unknown> {
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
export function intentFile(): Record<string, string> {
  return {
    target: FORGED_TARGET,
    baselineSha256: sha256Of(P3_BASELINE),
    contentSha256: sha256Of(SKILL_CANDIDATE),
    source: CANDIDATE_SOURCE,
  }
}

/** The `applied` line that closes {@link intentLine}, as the commit writes it. */
export function appliedLine(over: Record<string, unknown> = {}): Record<string, unknown> {
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
export async function ledgerFixture(
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
