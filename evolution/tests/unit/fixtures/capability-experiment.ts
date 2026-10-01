/**
 * A completed two-sided **capability** experiment, recorded for a prepared
 * capability candidate (A6) — the shape the evaluation runner writes.
 *
 * Everything durable is real in the way the unit level can be: the ledger lines
 * go through `EvolutionService`'s own write entries (which re-validate them), the
 * store rows are the shape the task store holds, and the report is the report
 * `buildExperimentReport` recomputes from those records. What is not real is the
 * *execution*: the sides are settled rows, not runs a runtime performed — the
 * real orchestration is proven in `tests/integration/capability-experiment.spec.ts`.
 *
 * The two shapes this fixture records are the two the gate must read:
 *
 * - the **baseline side is `not-admitted`**: the production table does not hold
 *   the sample's row, so no run exists for it, no champion and no failure run is
 *   invented, and the record is the runtime's own refusal with the gap it stands
 *   for;
 * - the **candidate side is a real run**: a replayed task of the experiment's own
 *   lineage, settled `verified` by the registered judge, bound to the overlay's
 *   own provider identity, with the new skill's bytes re-provable from its run
 *   snapshot.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import { registryRevision, SKILL_SIDECAR_FILE, skillContentDigest } from '@dangosys/dsh-singularity-task-runtime'
import type { EvolutionProposal, EvolutionService } from '../../../src/evolution.ts'
import type { ExperimentSampleRecord, ExperimentStartedRecord } from '../../../src/experiment/spec.ts'
import { preparedContentDigestOf } from '../../../src/experiment/freeze.ts'
import {
  buildExperimentReport,
  directoryDigest,
  experimentIdOf,
  experimentLineage,
  experimentReportPath,
} from '../../../src/experiment/record.ts'
import type {
  ExperimentReport,
  FrozenCapability,
  FrozenCapabilitySide,
  FrozenExperiment,
  FrozenSample,
  ModelSelection,
} from '../../../src/replay.ts'
import { digestOf, EXPERIMENT_COMPARER_VERSION, frozenDigestOf, protectedInputsDigest } from '../../../src/replay.ts'

/** One store row, as the fake store holds it: the fixture writes what the gate reads, never a typed copy. */
export type StoreRow = Record<string, unknown>

export interface CapabilityExperimentStore {
  tasks: StoreRow[]
  runs: StoreRow[]
  reviews: StoreRow[]
  evidence: StoreRow[]
}

/** What a fixture has to hand the recorder: the ledger root, the store, the snapshot and the model. */
export interface CapabilityExperimentHost {
  readonly root: string
  readonly skillRoot: string
  /** The production capability table, as the runtime would report it. */
  readonly registry: Record<string, CapabilityConfig>
  /** The fake store the sides' facts are written into. */
  readonly rows: CapabilityExperimentStore
  /** The session logs the sides' requests are written into (session id → events). */
  readonly sessions: Map<string, SessionEvent[]>
  /** The frozen input snapshot both workspaces are built from (must exist). */
  readonly workspace: string
  readonly selection: ModelSelection
}

export interface CapabilityExperimentOptions {
  /**
   * What the baseline side records. Default: `not-admitted` when prepare captured
   * no row for this candidate (the production table does not hold it — the A6
   * gap), and `reproduce` when it did (the row it replaces really runs: the
   * observed failure reproduces on the baseline, the holdout stays verified).
   */
  baseline?: 'not-admitted' | 'reproduce' | 'verified' | 'failed'
  /** What the candidate side records. Default `verified`. */
  candidate?: 'verified' | 'failed'
  /**
   * Whether the frozen sample records the production configuration's refusal
   * (default: exactly when the baseline side is `not-admitted`). Setting it
   * against the baseline's own settlement is how a tamper case records a side
   * the frozen block says could never have run.
   */
  admission?: boolean
  /** Sample task ids whose candidate side records `failed` (a degraded holdout). */
  candidateFailures?: readonly string[]
  /**
   * Write no task, run, review or evidence for the candidate sides, while their
   * records still claim a settlement — the shape a report claiming a run the
   * store never held has (admission that never reached an execution).
   */
  omitCandidateRuns?: boolean
  /** The verifier version the sides' verdicts carry (default `1`, the frozen one). */
  sideVerifierVersion?: string
  /** The registry revision the candidate side's run binding carries (default: the frozen overlay revision). */
  bindingRevision?: string
  /** Replace the refusal a `not-admitted` baseline records (a tamper case). */
  refusal?: Partial<ExperimentSampleRecord['admission']>
  /** Leave the candidate side's run binding without the new skill (a tamper case). */
  dropBoundSkill?: boolean
  /** Let the candidate side cite no snapshot root (a tamper case). */
  omitSnapshotRoot?: boolean
}

export interface RecordedCapabilityExperiment {
  readonly experimentId: string
  readonly frozen: FrozenExperiment
  readonly report: ExperimentReport
  readonly reportPath: string
  readonly failureSample: string
  readonly holdoutSample: string
  /** The overlay revision the candidate side's binding must carry. */
  readonly overlayRevision: string
  /** The candidate side's run id, for the cases that tamper with it. */
  readonly candidateRunIds: Readonly<Record<string, string>>
  /** The frozen provider identity the candidate side was compared against. */
  readonly candidateProvider: FrozenCapabilitySide
}

const FAILURE_SAMPLE = 't-cap-fix'
const HOLDOUT_SAMPLE = 't-cap-holdout'
const VERIFIER_VERSION = '1'

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The `request/header` event one side's session log carries, in the shape the live loop appends. */
function requestHeader(selection: ModelSelection, seq: number): SessionEvent {
  return {
    type: 'request/header',
    seq,
    time: 0,
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
  } as unknown as SessionEvent
}

/**
 * Record one completed capability experiment for a prepared candidate: the
 * historical samples, the frozen block, both sides' records, the report file —
 * all through the service's own write path.
 */
export async function recordCapabilityExperiment(
  svc: EvolutionService,
  host: CapabilityExperimentHost,
  proposal: EvolutionProposal,
  options: CapabilityExperimentOptions = {},
): Promise<RecordedCapabilityExperiment> {
  const prepared = proposal.prepared
  const rowIdentity = prepared?.capabilityRow
  const sandbox = prepared?.sandbox
  if (rowIdentity === undefined || sandbox == null) {
    throw new Error(`fixture: proposal "${proposal.proposalId}" is not a materialized capability prepare`)
  }
  const newSkill = prepared?.skillContent
  const production = proposal.targetId
  const row: FrozenCapability = {
    row: { name: rowIdentity.name, entry: rowIdentity.entry, digest: rowIdentity.digest },
    baseline:
      prepared?.capabilityBaseline == null
        ? null
        : {
            name: prepared!.capabilityBaseline!.name,
            entry: prepared!.capabilityBaseline!.entry,
            digest: prepared!.capabilityBaseline!.digest,
          },
    sourceRefs: [...proposal.sourceRefs],
  }
  const overlayTable: Record<string, CapabilityConfig> = { ...host.registry, [row.row.name]: row.row.entry }
  const skills: FrozenCapabilitySide['skills'] =
    newSkill === undefined
      ? []
      : [
          {
            name: newSkill.name,
            role: 'execution-provider',
            contractDigest: newSkill.contract?.contractDigest ?? null,
            contentDigest: skillContentDigest({ skillMdSha256: newSkill.sha256, resources: [] }),
          },
        ]
  const overlayRevision = registryRevision(
    overlayTable,
    skills.map(skill => ({ name: skill.name, contractDigest: skill.contractDigest })),
  )
  const requiredRows = [production]
  const candidateProvider: FrozenCapabilitySide = {
    capabilities: requiredRows,
    registryRevision: overlayRevision,
    mcpServers: [],
    preset: null,
    skills,
  }
  const historical = [
    { taskId: FAILURE_SAMPLE, role: 'observed-failure' as const, criterionId: 'ac-cap', outcome: 'failed' as const },
    { taskId: HOLDOUT_SAMPLE, role: 'holdout' as const, criterionId: 'ac-cap-keep', outcome: 'verified' as const },
  ]
  const baselineMode = options.baseline ?? (row.baseline === null ? 'not-admitted' : 'reproduce')
  const recordsAdmission = options.admission ?? baselineMode === 'not-admitted'
  // The production configuration's own side identity, for the case whose
  // baseline really runs (a row production already holds). This fixture's
  // production side grants the rows it requests and resolves no provider object
  // (the deployment's production skills are the integration spec's subject), so
  // the binding it writes and the identity it freezes agree by construction.
  const productionSide: FrozenCapabilitySide = {
    capabilities: requiredRows,
    registryRevision: registryRevision(host.registry, []),
    mcpServers: [],
    preset: null,
    skills: [],
  }
  const samples: FrozenSample[] = []
  for (const sample of historical) {
    const acceptanceCriteria = [
      {
        criterionId: sample.criterionId,
        description: 'works',
        verificationMode: 'deterministic',
        requiredEvidence: [],
        mandatory: true,
        command: 'true',
        verifierRef: 'command',
      },
    ]
    host.rows.tasks.push({
      taskId: sample.taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      objective: `${sample.taskId} objective`,
      depth: 1,
      acceptanceCriteria,
      requestedCapabilities: [...requiredRows],
      decompositionStatus: 'leaf',
      status: sample.outcome,
      runIds: [`r-history-${sample.taskId}`],
      childTaskIds: [],
    })
    host.rows.reviews.push({
      taskId: sample.taskId,
      runId: `r-history-${sample.taskId}`,
      outcome: sample.outcome,
      evidenceRefs: [],
      anomalies: [],
      criteria: [{ criterionId: sample.criterionId, verdict: sample.outcome === 'verified' ? 'pass' : 'fail' }],
    })
    samples.push({
      taskId: sample.taskId,
      role: sample.role,
      contractDigest: digestOf({
        objective: `${sample.taskId} objective`,
        acceptanceCriteria,
        requiredCapabilities: requiredRows,
      }),
      criteria: [
        {
          criterionId: sample.criterionId,
          verificationMode: 'deterministic',
          command: 'true',
          protectedInputsDigest: protectedInputsDigest([]),
          verifierRef: 'command',
          verifierVersion: VERIFIER_VERSION,
          verifierAnchor: `registered verifier "command" declares version "${VERIFIER_VERSION}"`,
        },
      ],
      observed: { outcome: sample.outcome, runId: `r-history-${sample.taskId}` },
      ...(recordsAdmission
        ? {
            admission: {
              source: 'capability-gap' as const,
              required: [...requiredRows],
              missing: [...requiredRows],
              reason:
                `the effective capability table does not hold ${requiredRows.map(name => JSON.stringify(name)).join(', ')}, so the production ` +
                "configuration cannot admit this sample (the runtime's own resolution reports a closure gap)",
            },
          }
        : { provider: { ...productionSide, candidateRegistryRevision: productionSide.registryRevision } }),
      candidateProvider,
    })
  }
  const frozen: FrozenExperiment = {
    proposalId: proposal.proposalId,
    repetition: 0,
    ...(newSkill === undefined ? {} : { candidate: newSkill }),
    capability: row,
    model: host.selection,
    budget: {},
    samples,
    snapshot: { sourceDir: host.workspace, digest: await directoryDigest(host.workspace) },
    comparerVersion: EXPERIMENT_COMPARER_VERSION,
    overlay: {
      baseline: 'none — the baseline runs under the production configuration',
      candidate: `capabilityOverrides: { "${row.row.name}": the prepared row }`,
    },
  }
  const frozenDigest = frozenDigestOf(frozen)
  const experimentId = experimentIdOf(proposal.proposalId, frozenDigest)
  const reportPath = experimentReportPath(proposal.proposalId, experimentId)
  const records: ExperimentSampleRecord[] = []
  const candidateRunIds: Record<string, string> = {}
  const sideJudgeVersion = options.sideVerifierVersion ?? VERIFIER_VERSION
  for (const sample of samples) {
    const baselineOutcome =
      baselineMode === 'reproduce' ? (sample.role === 'observed-failure' ? 'failed' : 'verified') : baselineMode
    if (baselineOutcome === 'not-admitted') {
      records.push({
        formatVersion: 4,
        kind: 'experiment_sample',
        proposalId: proposal.proposalId,
        experimentId,
        preparedContentDigest: preparedContentDigestOf(frozen),
        sampleTaskId: sample.taskId,
        side: 'baseline',
        repetition: 0,
        outcome: 'not-admitted',
        evidenceRefs: [],
        criteria: [],
        workspace: join(host.root, 'sandbox', proposal.proposalId, `exp-${experimentId}`, sample.taskId, 'baseline'),
        cost: {
          status: 'unknown',
          reason: 'the runtime refused this side at admission, so no run exists and no cost was reported for it',
        },
        admission: {
          source: 'capability-gap',
          proposalId: proposal.proposalId,
          sourceRefs: [...proposal.sourceRefs],
          required: [...requiredRows],
          missing: [...requiredRows],
          reason: `task-runtime: replay of "${sample.taskId}" cannot run: capability gap [${requiredRows.join(', ')}] under the overlay`,
          ...options.refusal,
        },
        actor: 'root-1',
        at: '2026-09-26T00:00:00.000Z',
      })
      continue
    }
    const taskId = `t-${sample.taskId}-baseline`
    const runId = `r-${sample.taskId}-baseline`
    const criterionId = sample.criteria[0]!.criterionId
    const verdict = baselineOutcome === 'verified' ? 'pass' : 'fail'
    const snapshotRoot = join(host.root, 'run-snapshots', sample.taskId, 'baseline')
    host.rows.tasks.push({
      taskId,
      definitionRef: { taskType: 'subtask', version: 1 },
      objective: `[${experimentLineage(experimentId, sample.taskId, 'baseline')}] ${sample.taskId}`,
      depth: 1,
      acceptanceCriteria: [
        {
          criterionId,
          description: 'works',
          verificationMode: 'deterministic',
          requiredEvidence: [],
          mandatory: true,
          command: 'true',
        },
      ],
      requestedCapabilities: [...requiredRows],
      decompositionStatus: 'leaf',
      status: baselineOutcome,
      runIds: [runId],
      childTaskIds: [],
    })
    host.rows.runs.push({
      runId,
      taskId,
      sessionId: `s-${runId}`,
      status: baselineOutcome,
      startedAt: '2026-09-26T00:00:00.000Z',
      providerBinding: {
        registryRevision: productionSide.registryRevision,
        capabilities: [...requiredRows],
        skills: [],
        mcpServers: [],
        snapshotRoot,
      },
    })
    host.sessions.set(`s-${runId}`, [requestHeader(frozen.model, 1)])
    host.rows.evidence.push({
      evidenceId: `e-${runId}`,
      taskRunId: runId,
      taskId,
      artifacts: [],
      verifierResults: [],
      claims: [],
      generatedAt: '2026-09-26T00:00:00.000Z',
    })
    host.rows.reviews.push({
      taskId,
      runId,
      outcome: baselineOutcome,
      evidenceRefs: [`e-${runId}`],
      anomalies: [],
      criteria: [{ criterionId, verdict, verifierId: 'command', verifierVersion: sideJudgeVersion }],
    })
    records.push({
      formatVersion: 4,
      kind: 'experiment_sample',
      proposalId: proposal.proposalId,
      experimentId,
      preparedContentDigest: preparedContentDigestOf(frozen),
      sampleTaskId: sample.taskId,
      side: 'baseline',
      repetition: 0,
      taskId,
      runId,
      outcome: baselineOutcome,
      reviewRef: `${taskId}#${runId}`,
      evidenceRefs: [`e-${runId}`],
      criteria: [{ criterionId, verdict, verifierId: 'command', verifierVersion: sideJudgeVersion }],
      workspace: join(host.root, 'sandbox', proposal.proposalId, `exp-${experimentId}`, sample.taskId, 'baseline'),
      initialDigest: frozen.snapshot.digest,
      cost: { status: 'unknown', reason: 'the fixture reports no metrics' },
      actor: 'root-1',
      at: '2026-09-26T00:00:00.000Z',
    })
  }
  for (const sample of samples) {
    const candidateOutcome =
      options.candidateFailures?.includes(sample.taskId) === true ? 'failed' : (options.candidate ?? 'verified')
    const taskId = `t-${sample.taskId}-candidate`
    const runId = `r-${sample.taskId}-candidate`
    candidateRunIds[sample.taskId] = runId
    const criterionId = sample.criteria[0]!.criterionId
    const verdict = candidateOutcome === 'verified' ? 'pass' : 'fail'
    const writeStore = options.omitCandidateRuns !== true
    if (writeStore)
      host.rows.tasks.push({
        taskId,
        definitionRef: { taskType: 'subtask', version: 1 },
        objective: `[${experimentLineage(experimentId, sample.taskId, 'candidate')}] ${sample.taskId}`,
        depth: 1,
        acceptanceCriteria: [
          {
            criterionId,
            description: 'works',
            verificationMode: 'deterministic',
            requiredEvidence: [],
            mandatory: true,
            command: 'true',
          },
        ],
        requestedCapabilities: [...requiredRows],
        decompositionStatus: 'leaf',
        status: candidateOutcome,
        runIds: [runId],
        childTaskIds: [],
      })
    let snapshotRoot: string | undefined = join(host.root, 'run-snapshots', sample.taskId, 'candidate')
    if (newSkill !== undefined) {
      const source = join(host.root, 'sandbox', proposal.proposalId, 'skills', newSkill.name)
      await mkdir(join(snapshotRoot, newSkill.name), { recursive: true })
      await writeFile(join(snapshotRoot, newSkill.name, 'SKILL.md'), await readFile(join(source, 'SKILL.md')))
      if (newSkill.contract !== undefined) {
        await writeFile(
          join(snapshotRoot, newSkill.name, SKILL_SIDECAR_FILE),
          await readFile(join(source, SKILL_SIDECAR_FILE)),
        )
      }
    }
    if (options.omitSnapshotRoot === true) snapshotRoot = undefined
    if (writeStore)
      host.rows.runs.push({
        runId,
        taskId,
        sessionId: `s-${runId}`,
        status: candidateOutcome,
        startedAt: '2026-09-26T00:00:00.000Z',
        providerBinding: {
          registryRevision: options.bindingRevision ?? overlayRevision,
          capabilities: [...requiredRows],
          skills:
            options.dropBoundSkill === true
              ? []
              : skills.map(skill => ({
                  name: skill.name,
                  role: skill.role,
                  capabilities: [row.row.name],
                  description: 'fixture provider',
                  contractDigest: skill.contractDigest,
                  contentDigest: skill.contentDigest,
                  uncovered: [],
                })),
          mcpServers: [],
          ...(snapshotRoot === undefined ? {} : { snapshotRoot }),
        },
      })
    host.sessions.set(`s-${runId}`, [requestHeader(frozen.model, 1)])
    if (writeStore)
      host.rows.evidence.push({
        evidenceId: `e-${runId}`,
        taskRunId: runId,
        taskId,
        artifacts: [],
        verifierResults: [],
        claims: [],
        generatedAt: '2026-09-26T00:00:00.000Z',
      })
    if (writeStore)
      host.rows.reviews.push({
        taskId,
        runId,
        outcome: candidateOutcome,
        evidenceRefs: [`e-${runId}`],
        anomalies: [],
        criteria: [{ criterionId, verdict, verifierId: 'command', verifierVersion: sideJudgeVersion }],
      })
    records.push({
      formatVersion: 4,
      kind: 'experiment_sample',
      proposalId: proposal.proposalId,
      experimentId,
      preparedContentDigest: preparedContentDigestOf(frozen),
      sampleTaskId: sample.taskId,
      side: 'candidate',
      repetition: 0,
      taskId,
      runId,
      outcome: candidateOutcome,
      reviewRef: `${taskId}#${runId}`,
      evidenceRefs: [`e-${runId}`],
      criteria: [{ criterionId, verdict, verifierId: 'command', verifierVersion: sideJudgeVersion }],
      workspace: join(host.root, 'sandbox', proposal.proposalId, `exp-${experimentId}`, sample.taskId, 'candidate'),
      initialDigest: frozen.snapshot.digest,
      cost: { status: 'unknown', reason: 'the fixture reports no metrics' },
      actor: 'root-1',
      at: '2026-09-26T00:00:00.000Z',
    })
  }
  const started: ExperimentStartedRecord = {
    formatVersion: 4,
    kind: 'experiment_started',
    proposalId: proposal.proposalId,
    experimentId,
    frozen,
    frozenDigest,
    budget: { ...frozen.budget },
    report: reportPath,
    storeId: 'sg-t-root-1',
    actor: 'root-1',
    at: '2026-09-26T00:00:00.000Z',
  }
  await svc.recordExperimentStart(started)
  for (const record of records) await svc.recordExperimentSample(record)
  const report = buildExperimentReport(await svc.experiment(experimentId))
  const abs = join(host.root, reportPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return {
    experimentId,
    frozen,
    report,
    reportPath,
    failureSample: FAILURE_SAMPLE,
    holdoutSample: HOLDOUT_SAMPLE,
    overlayRevision,
    candidateRunIds,
    candidateProvider,
  }
}
