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
 */

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
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
  protectedInputsDigest,
} from '../../evolution/src/index.ts'
import type { ExperimentBudget, ExperimentSampleRecord, FrozenExperiment, FrozenSample } from '../../evolution/src/index.ts'
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
  /** The model identity the deployment resolves (the one the promotion gate re-reads). */
  model: string
  /** The observed-failure sample's two sides. Default: reproduced on the baseline, fixed by the candidate. */
  failure?: { baseline?: Settlement; candidate?: Settlement }
  /** The holdout sample's two sides. Default: both verified. */
  holdout?: { baseline?: Settlement; candidate?: Settlement }
  budget?: ExperimentBudget
  /** A protected input the failure sample's criterion declares, written into the frozen snapshot. */
  protectedInput?: { path: string; bytes: string }
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
      `the fixture can only record an experiment for a prepared skill candidate replacing an existing SKILL.md ` +
      `(proposal "${proposalId}" has ${candidate === undefined ? 'no candidate identity' : 'no production baseline'})`,
    )
  }
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
      requestedCapabilities: [],
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
        requiredCapabilities: [],
      }),
      criteria: [{
        criterionId: input.criterionId,
        verificationMode: 'deterministic',
        command: input.command,
        protectedInputsDigest: protectedInputsDigest(acceptance.protectedInputs ?? []),
      }],
      observed: { outcome: input.outcome, runId },
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
    candidate: { name: candidate.name, sha256: candidate.sha256 },
    productionBaseline: { name: baseline.name, sha256: baseline.sha256 },
    model: options.model,
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
    formatVersion: 1,
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
      const criteria = [{ criterionId, verdict, verifierId: 'command', verifierVersion: '1' }] as const
      await context.task.createTaskIn(storeId, {
        taskId,
        definitionRef: { taskType: 'root', version: 1 },
        objective: `[${lineage}] ${sample.taskId}`,
        depth: 0,
        acceptanceCriteria: [],
        requestedCapabilities: [],
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
      }, 'tester')
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
        formatVersion: 1,
        kind: 'experiment_sample',
        proposalId,
        experimentId,
        preparedContentDigest: candidate.sha256,
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
