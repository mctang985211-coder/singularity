/**
 * A completed two-sided experiment, recorded for a skill proposal on a real run
 * stack — the shape `evolution_replay` writes, composed by a fixture so a spec
 * that is about something else (a version move, a provider check, the promotion
 * entries) can start from evidence that already stands.
 *
 * Everything durable is real: the sample tasks, runs, review records and
 * evidence bundles are written through the store's own service, the ledger lines
 * go through `EvolutionService`'s own write entries (which re-validate them), and
 * the report is the report `buildExperimentReport` recomputes from those records,
 * serialized the way the orchestrator serializes it. What is not real is the
 * *execution*: the sides are settled rows, not runs this fixture performed. The
 * real orchestration — the tool, the runtime, the spawn, the verifier — is proven
 * in `tests/integration/evolution-replay-experiment.spec.ts` and
 * `tests/integration/experiment-runner.spec.ts`.
 *
 * The frozen block is the whole object K3 freezes, and the two sides' run
 * bindings are the ones the freeze expects: one capability row granting the skill
 * under improvement, one provider entry per side, the runtime's own
 * `registryRevision` for each side (the candidate's with the improved skill's own
 * declaration digest substituted), and each side's run binding carrying a real
 * snapshot of the bytes that side loaded — so the promotion gate re-proves the
 * frozen object from those bytes exactly as it does for a live experiment.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { RunProviderBinding, RunSkillBinding } from '../../task/src/index.ts'
import { SKILL_SIDECAR_FILE, registryRevision, skillContentDigest } from '../../task-runtime/src/index.ts'
import type { CapabilityConfig } from '../../task-runtime/src/index.ts'
import type { EvolutionService } from '../../evolution/src/index.ts'
import {
  buildExperimentReport,
  digestOf,
  directoryDigest,
  EXPERIMENT_COMPARER_VERSION,
  experimentIdOf,
  experimentLineage,
  experimentReportPath,
  frozenDigestOf,
  preparedContentDigestOf,
  protectedInputsDigest,
} from '../../evolution/src/index.ts'
import type {
  ExperimentBudget,
  ExperimentSampleRecord,
  FrozenExperiment,
  FrozenProviderIdentity,
  FrozenProviderSkill,
  FrozenSample,
  ModelSelection,
  SkillContentIdentity,
} from '../../evolution/src/index.ts'
import type { RunStack } from './run-stack.ts'

type Settlement = 'verified' | 'failed' | 'cancelled'

/**
 * The services the fixture writes through, named by capability rather than by
 * harness shape: a RunStack (through {@link promotionExperimentContext}) and a
 * hand-built stack (a raw `Context` plus its own `TaskService`) both satisfy it.
 */
export interface PromotionExperimentContext {
  /** The context whose `sessionPersistence` can mint the fixture store's own session. */
  readonly ctx: unknown
  /** The task store the samples and sides are written through. */
  readonly task: {
    openStore(storeId: string): Promise<unknown>
    createTaskIn(storeId: string, task: never, actor: string): Promise<void>
    admitTaskIn(storeId: string, taskId: string, actor: string, options?: { decompositionStatus?: 'leaf' | 'decomposable' }): Promise<void>
    startRunIn(storeId: string, run: never, actor: string): Promise<void>
    markRunStatusIn(storeId: string, taskId: string, runId: string, status: string, actor: string, detail?: unknown): Promise<void>
    recordEvidenceIn(storeId: string, bundle: never, actor: string): Promise<void>
    recordReviewIn(storeId: string, review: never, actor: string): Promise<void>
  }
  /** A directory the fixture may write the frozen snapshot into. */
  readonly scratch: string
  /** A working directory for the store's own session header. */
  readonly cwd: string
  /** The store the experiment names and its sides live in. */
  readonly storeId: string
}

/** The context one RunStack offers: its own store for a dedicated fixture root. */
export function promotionExperimentContext(h: RunStack, rootSession = 's-promotion-fixture'): PromotionExperimentContext {
  return {
    ctx: h.ctx,
    task: h.task as unknown as PromotionExperimentContext['task'],
    scratch: h.workspace,
    cwd: h.checkout,
    storeId: rootTaskStoreId(rootSession),
  }
}

export interface PromotionExperimentOptions {
  proposalId: string
  /**
   * The structured model selection the deployment resolves — the one the
   * experiment freezes, the one each side's session log records as its request,
   * and the one the promotion gate re-reads (S4-E §Q3).
   */
  selection: ModelSelection
  /** The observed-failure sample's two sides. Default: reproduced on the baseline, fixed by the candidate. */
  failure?: { baseline?: Settlement; candidate?: Settlement }
  /** The holdout sample's two sides. Default: both verified. */
  holdout?: { baseline?: Settlement; candidate?: Settlement }
  budget?: ExperimentBudget
  /** A protected input the failure sample's criterion declares, written into the frozen snapshot. */
  protectedInput?: { path: string; bytes: string }
}

/**
 * The capability row this fixture's samples request: one row granting the skill
 * under improvement, so the frozen provider identity resolves exactly the
 * provider the candidate replaces — the entry the candidate side's registry
 * revision substitutes (K3). A sample whose rows resolve no provider has no
 * candidate revision to freeze, and `evolution_replay` refuses it.
 */
const FIXTURE_ROW = 'promotion-fixture-row'

/** The judge every sample criterion pins, as the deployment's own registry declares it. */
const FIXTURE_JUDGE = { ref: 'command', version: '1' } as const

/** The capability table this fixture's frozen identity is read over: the one row above, granting the improved skill. */
function fixtureTable(name: string): Readonly<Record<string, CapabilityConfig>> {
  return { [FIXTURE_ROW]: { skills: [name] } }
}

/** One object identity as the frozen provider list carries it; the sidecar's presence *is* the role. */
function fixtureProviderSkill(identity: SkillContentIdentity): FrozenProviderSkill {
  return {
    name: identity.name,
    role: identity.contract === undefined ? 'guidance' : 'execution-provider',
    contractDigest: identity.contract?.contractDigest ?? null,
    contentDigest: skillContentDigest({ skillMdSha256: identity.sha256, resources: [] }),
  }
}

/**
 * The provider identity this fixture's production configuration resolves to: the
 * one row above, and the improved skill it grants, read in each of the two
 * versions the experiment compares. Both registry revisions are the runtime's
 * own `registryRevision` over that table — the production one over the
 * production object, the candidate's over the same list with the improved
 * skill's declaration digest substituted — exactly the pair `evolution_replay`
 * freezes. A guidance object leaves both equal, because nothing about the list
 * moves.
 */
function fixtureProviderIdentity(candidate: SkillContentIdentity, baseline: SkillContentIdentity): FrozenProviderIdentity {
  const table = fixtureTable(candidate.name)
  const production = [fixtureProviderSkill(baseline)]
  return {
    capabilities: [FIXTURE_ROW],
    registryRevision: registryRevision(table, production),
    candidateRegistryRevision: registryRevision(table, [fixtureProviderSkill(candidate)]),
    mcpServers: [],
    preset: null,
    skills: production,
  }
}

/** One side's run binding: the frozen row, that side's own revision, and the one skill the row grants. */
function fixtureRunBinding(input: {
  identity: SkillContentIdentity
  registryRevision: string
  snapshotRoot: string
}): RunProviderBinding {
  const skill = fixtureProviderSkill(input.identity)
  const bound: RunSkillBinding = {
    name: skill.name,
    role: skill.role,
    capabilities: [FIXTURE_ROW],
    description: `${skill.name} fixture skill`,
    contractDigest: skill.contractDigest,
    contentDigest: skill.contentDigest,
    uncovered: [],
  }
  return {
    registryRevision: input.registryRevision,
    capabilities: [FIXTURE_ROW],
    skills: [bound],
    mcpServers: [],
    snapshotRoot: input.snapshotRoot,
  }
}

/**
 * Materialize one side's object where its run binding says it loaded it
 * (`<snapshotRoot>/<name>/SKILL.md`, and the sidecar beside it when the object has
 * one), copying the proposal's own materialized files byte for byte: the
 * champion snapshot for a baseline side, the prepared sandbox for a candidate
 * side. The promotion gate re-proves the frozen object from exactly these bytes,
 * so a fixture that only recorded digests would stand on nothing.
 */
async function materializeSideObject(input: {
  ledgerRoot: string
  proposalId: string
  name: string
  side: 'baseline' | 'candidate'
  snapshotRoot: string
  identity: SkillContentIdentity
}): Promise<void> {
  const { ledgerRoot, proposalId, name, side, snapshotRoot, identity } = input
  const from = join(ledgerRoot, 'sandbox', proposalId, side === 'candidate' ? 'skills' : 'champion/skills', name)
  const to = join(snapshotRoot, name)
  await mkdir(to, { recursive: true })
  for (const file of ['SKILL.md', ...(identity.contract === undefined ? [] : [SKILL_SIDECAR_FILE])]) {
    await writeFile(join(to, file), await readFile(join(from, file)))
  }
}

/**
 * The session one side's run was placed under, minted through the deployment's
 * own persistence and given the one `request/header` event the live loop would
 * have appended for a request on `selection` — the durable record the promotion
 * gate re-reads (S4-E §Q3). A deployment whose `sessionPersistence` cannot mint
 * a session makes this fixture fail loudly rather than write a side with no
 * request evidence.
 */
async function writeSideSession(context: PromotionExperimentContext, sessionId: string, selection: ModelSelection): Promise<void> {
  const persistence = (context.ctx as {
    get(name: string): {
      create(header: unknown): Promise<{ append(events: readonly unknown[]): Promise<void>; close?(): Promise<void> }>
    }
  }).get('sessionPersistence')
  const handle = await persistence.create({ id: sessionId, cwd: context.cwd, agentPreset: 'standard' })
  await handle.append([{
    type: 'request/header',
    seq: 0,
    time: Date.now(),
    data: {
      header: {
        config: {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          ...(selection.maxTokens === undefined ? {} : { maxTokens: selection.maxTokens }),
        },
      },
      reason: 'initial',
    },
  }])
}

/**
 * Record one completed experiment for a prepared skill proposal and write its
 * report, so the promotion gate has evidence it accepts. The caller must have
 * proposed, candidated and prepared the proposal first, on the same service.
 */
export async function recordPromotionExperiment(
  context: PromotionExperimentContext,
  svc: EvolutionService,
  options: PromotionExperimentOptions,
): Promise<{ reportPath: string; experimentId: string }> {
  const { proposalId } = options
  const proposal = await svc.get(proposalId)
  const candidate = proposal.prepared?.skillContent
  const baseline = proposal.prepared?.skillBaseline
  if (candidate === undefined || baseline === undefined) {
    throw new Error(
      `the fixture can only record an experiment for a prepared skill candidate replacing an existing skill object ` +
      `(proposal "${proposalId}" has ${candidate === undefined ? 'no candidate identity' : 'no production baseline'})`,
    )
  }
  const provider = fixtureProviderIdentity(candidate, baseline)
  const storeId = context.storeId
  // A store's own session is named after the store id (`TaskService.allocate`):
  // minting it (and opening the store) here is what keeps this fixture's rows in
  // an evidence store of their own instead of a store a live batch is settling in.
  const persistence = (context.ctx as { get(name: string): { create(header: unknown): Promise<unknown> } }).get('sessionPersistence')
  await persistence.create({ id: storeId, cwd: context.cwd, agentPreset: 'standard' })
  await context.task.openStore(storeId)
  const snapshotDir = join(context.scratch, 'promotion-snapshot', proposalId)
  const protectedInput = options.protectedInput
  await mkdir(snapshotDir, { recursive: true })
  await writeFile(join(snapshotDir, 'input.txt'), 'the frozen input\n', 'utf8')
  if (protectedInput !== undefined) await writeFile(join(snapshotDir, protectedInput.path), protectedInput.bytes, 'utf8')

  const samples: FrozenSample[] = []
  const writeSample = async (input: {
    taskId: string
    role: FrozenSample['role']
    criterionId: string
    command: string
    outcome: 'verified' | 'failed'
  }) => {
    const acceptance: AcceptanceCriterion = {
      criterionId: input.criterionId,
      description: 'it holds',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: input.command,
      verifierRef: FIXTURE_JUDGE.ref,
      ...(protectedInput === undefined || input.role !== 'observed-failure'
        ? {}
        : { protectedInputs: [{ path: protectedInput.path, sha256: createHash('sha256').update(protectedInput.bytes).digest('hex') }] }),
    }
    const runId = `r-history-${input.taskId}`
    await context.task.createTaskIn(storeId, {
      taskId: input.taskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: `${input.taskId} objective`,
      depth: 0,
      acceptanceCriteria: [acceptance],
      requestedCapabilities: [FIXTURE_ROW],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 'tester')
    await context.task.admitTaskIn(storeId, input.taskId, 'tester', { decompositionStatus: 'leaf' })
    await context.task.startRunIn(storeId, {
      runId,
      taskId: input.taskId,
      sessionId: `s-${input.taskId}`,
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, 'tester')
    await context.task.markRunStatusIn(storeId, input.taskId, runId, 'verifying', 'tester')
    await context.task.recordEvidenceIn(storeId, {
      evidenceId: `e-${runId}`,
      taskRunId: runId,
      taskId: input.taskId,
      artifacts: [],
      verifierResults: [{ criterionId: input.criterionId, status: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }, 'tester')
    await context.task.markRunStatusIn(storeId, input.taskId, runId, input.outcome, 'tester')
    await context.task.recordReviewIn(storeId, {
      taskId: input.taskId,
      runId,
      sessionId: `s-${input.taskId}`,
      outcome: input.outcome,
      evidenceRefs: [],
      anomalies: [],
      ...(input.outcome === 'failed' ? { localizedCause: 'the historical case failed' } : {}),
      criteria: [{ criterionId: input.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail' }],
    }, 'tester')
    samples.push({
      taskId: input.taskId,
      role: input.role,
      contractDigest: digestOf({
        objective: `${input.taskId} objective`,
        acceptanceCriteria: [acceptance],
        requiredCapabilities: [FIXTURE_ROW],
      }),
      criteria: [{
        criterionId: input.criterionId,
        verificationMode: 'deterministic',
        command: input.command,
        protectedInputsDigest: protectedInputsDigest(acceptance.protectedInputs ?? []),
        verifierRef: FIXTURE_JUDGE.ref,
        verifierVersion: FIXTURE_JUDGE.version,
        verifierAnchor: `registered verifier "${FIXTURE_JUDGE.ref}" declares version "${FIXTURE_JUDGE.version}"`,
      }],
      observed: { outcome: input.outcome, runId },
      provider,
    })
  }
  // Sample ids are scoped to the proposal: one fixture records several
  // experiments into one store, and the sample id is the case identity.
  const failSample = `t-fail-${proposalId}`
  const holdoutSample = `t-holdout-${proposalId}`
  await writeSample({ taskId: failSample, role: 'observed-failure', criterionId: 'ac-fix', command: 'test -f fix.txt', outcome: 'failed' })
  await writeSample({ taskId: holdoutSample, role: 'holdout', criterionId: 'ac-holdout', command: 'test -f holdout.txt', outcome: 'verified' })

  const frozen: FrozenExperiment = {
    proposalId,
    repetition: 0,
    candidate: {
      name: candidate.name,
      sha256: candidate.sha256,
      ...(candidate.contract === undefined ? {} : { contract: { ...candidate.contract } }),
    },
    productionBaseline: {
      name: baseline.name,
      sha256: baseline.sha256,
      ...(baseline.contract === undefined ? {} : { contract: { ...baseline.contract } }),
    },
    model: options.selection,
    budget: { ...(options.budget ?? {}) },
    samples,
    snapshot: { sourceDir: snapshotDir, digest: await directoryDigest(snapshotDir) },
    comparerVersion: EXPERIMENT_COMPARER_VERSION,
    overlay: { baseline: 'none — the baseline runs under the production configuration', candidate: `extraSkillRoots: [sandbox/${proposalId}/skills]` },
  }
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(proposalId, frozenDigest)
  const reportPath = experimentReportPath(proposalId, experimentId)
  const at = new Date().toISOString()
  await svc.recordExperimentStart({
    formatVersion: 4,
    kind: 'experiment_started',
    proposalId,
    experimentId,
    frozen,
    frozenDigest,
    budget: { ...frozen.budget },
    report: reportPath,
    storeId,
    actor: 'tester',
    at,
  })
  // The binding snapshot root each side's run records: one directory per side
  // under this fixture's own scratch, holding the bytes that side loaded.
  const bindingRoot = join(context.scratch, 'promotion-bindings', proposalId, experimentId)
  for (const sample of samples) {
    const settlements = sample.taskId === failSample
      ? { baseline: options.failure?.baseline ?? 'failed', candidate: options.failure?.candidate ?? 'verified' }
      : { baseline: options.holdout?.baseline ?? 'verified', candidate: options.holdout?.candidate ?? 'verified' }
    for (const side of ['baseline', 'candidate'] as const) {
      const settlement: Settlement = settlements[side]
      const lineage = experimentLineage(experimentId, sample.taskId, side)
      const taskId = `t-${sample.taskId}-${side}`
      const runId = `r-${sample.taskId}-${side}`
      const criterionId = sample.criteria[0]!.criterionId
      const verdict = settlement === 'verified' ? 'pass' : settlement === 'failed' ? 'fail' : 'inconclusive'
      const criteria = [{
        criterionId,
        verdict,
        verifierId: FIXTURE_JUDGE.ref,
        verifierVersion: FIXTURE_JUDGE.version,
      }] as const
      const snapshotRoot = join(bindingRoot, sample.taskId, side, 'skills')
      await materializeSideObject({
        ledgerRoot: svc.root,
        proposalId,
        name: candidate.name,
        side,
        snapshotRoot,
        identity: side === 'candidate' ? candidate : baseline,
      })
      await context.task.createTaskIn(storeId, {
        taskId,
        definitionRef: { taskType: 'root', version: 1 },
        objective: `[${lineage}] ${sample.taskId}`,
        depth: 0,
        acceptanceCriteria: [],
        requestedCapabilities: [FIXTURE_ROW],
        decompositionStatus: 'leaf',
        status: 'created',
        runIds: [],
        childTaskIds: [],
      }, 'tester')
      await context.task.admitTaskIn(storeId, taskId, 'tester', { decompositionStatus: 'leaf' })
      await context.task.startRunIn(storeId, {
        runId,
        taskId,
        sessionId: `s-${runId}`,
        capabilitySnapshot: [],
        artifacts: [],
        verifierResults: [],
        status: 'running',
        startedAt: at,
        providerBinding: fixtureRunBinding({
          identity: side === 'candidate' ? candidate : baseline,
          // Each side binds its own expectation: the production revision for the
          // baseline, the one that absorbs the improved skill's moved declaration
          // for the candidate (K3).
          registryRevision: side === 'candidate' ? provider.candidateRegistryRevision : provider.registryRevision,
          snapshotRoot,
        }),
      }, 'tester')
      await writeSideSession(context, `s-${runId}`, options.selection)
      if (settlement !== 'cancelled') {
        await context.task.recordEvidenceIn(storeId, {
          evidenceId: `e-${runId}`,
          taskRunId: runId,
          taskId,
          artifacts: [],
          verifierResults: [{ criterionId, status: verdict, verifierId: 'command' }],
          claims: [],
          generatedAt: at,
        }, 'tester')
        await context.task.markRunStatusIn(storeId, taskId, runId, 'verifying', 'tester')
        await context.task.markRunStatusIn(storeId, taskId, runId, settlement, 'tester')
        await context.task.recordReviewIn(storeId, {
          taskId,
          runId,
          sessionId: `s-${runId}`,
          outcome: settlement,
          evidenceRefs: [`e-${runId}`],
          anomalies: [],
          ...(settlement === 'failed' ? { localizedCause: 'the fixture side failed' } : {}),
          criteria: [...criteria],
        }, 'tester')
      }
      const record: ExperimentSampleRecord = {
        formatVersion: 4,
        kind: 'experiment_sample',
        proposalId,
        experimentId,
        preparedContentDigest: preparedContentDigestOf({ candidate }),
        sampleTaskId: sample.taskId,
        side,
        repetition: 0,
        taskId,
        runId,
        outcome: settlement,
        reviewRef: `${taskId}#${runId}`,
        evidenceRefs: settlement === 'cancelled' ? [] : [`e-${runId}`],
        criteria: settlement === 'cancelled' ? [] : [...criteria],
        workspace: join(svc.root, 'sandbox', proposalId, `exp-${experimentId}`, sample.taskId, side),
        initialDigest: frozen.snapshot.digest,
        cost: { status: 'reported', metrics: { toolCalls: { calls: 1, failures: 0 } } },
        actor: 'tester',
        at,
      }
      await svc.recordExperimentSample(record)
    }
  }
  const report = buildExperimentReport(await svc.experiment(experimentId))
  const abs = join(svc.root, reportPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return { reportPath, experimentId }
}
