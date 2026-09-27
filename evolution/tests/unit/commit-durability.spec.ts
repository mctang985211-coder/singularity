/**
 * K2 durability: the three durable facts of one commit — the recoverable source
 * bytes, the ledger line and the production rename — and the order the commit
 * makes them durable in.
 *
 * The commit contract says exactly which fact may depend on which: the bytes a
 * recovery would write again are *already durable* before the intent line that
 * names them exists; the intent line is durable before production is touched;
 * the rename over production is durable before the completion is recorded. A
 * process that dies inside that order is recoverable — production holds one
 * complete version and the ledger explains what was underway. A process that
 * dies outside it is not: production carrying the new version with no recorded
 * intent is the state the design forbids, and a commit that cannot make its own
 * record durable must stop by name rather than report success.
 *
 * ## The injection boundary
 *
 * The `vi.mock('node:fs/promises', ...)` layer below wraps the real module —
 * every call still reaches the real filesystem — and adds two things:
 *
 * 1. an ordered log of the durable-relevant operations: `open` (with its
 *    flags), the payload head of every `write`, every `fsync` (with the path of
 *    the handle it was called on), `rename`, `rm` and `mkdir`. A case can
 *    therefore assert which durable fact is established before which other one,
 *    and read the ledger bytes back from the file itself;
 * 2. one deterministic failure rule: the next call with a chosen operation and
 *    path throws a test-owned message, so a chosen `open`, `fsync` or `rename`
 *    can be made to fail at exactly one point.
 *
 * What the layer models: which durable operation the code issues, on which path,
 * in which order, and what the code does when one of them fails. What it does
 * not model: a real power cut, the kernel page cache, storage write reordering,
 * or whether a byte that reached the filesystem is physically on the platter. An
 * injected `fsync` failure means "the call reported failure"; it never means "the
 * data was lost", and the ledger bytes the assertions read are the bytes the
 * process wrote in this same run. The durability claim itself comes from the
 * *issued* operations: a line that is written, fsynced, and whose directory is
 * fsynced before anything depends on it, is the strongest ordering a process can
 * establish without failing the machine — and it is exactly what a power cut
 * needs to preserve the line.
 *
 * The layer replaces fs operations only. The service, its fold, its store and
 * the commit path are the real ones; the fixtures walk a proposal to
 * decided(PROMOTE) through the service's own entries, exactly as
 * `evolution.spec.ts` does for the commit cases there.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import type { Config, GateAnswers, ProposeInput } from '../../src/evolution.ts'
import { SKILL_SIDECAR_FILE } from '@dangosys/dsh-singularity-task-runtime'
import { commitIntent, sha256Hex } from '../../src/commit.ts'
import type { CommitHost, CommitRequest } from '../../src/commit.ts'
import { buildExperimentReport, directoryDigest, experimentIdOf, experimentLineage, experimentReportPath } from '../../src/experiment.ts'
import type { FrozenExperiment, FrozenProviderIdentity, FrozenSample, ModelSelection } from '../../src/replay.ts'
import { digestOf, EXPERIMENT_COMPARER_VERSION, frozenDigestOf, modelSelectionOf, protectedInputsDigest } from '../../src/replay.ts'

/* ------------------------------------------------------------------------ *
 * The injected fs layer: an ordered op log and one deterministic failure.   *
 * ------------------------------------------------------------------------ */

/** One durable-relevant fs call, in the order the code issued it. */
interface FsOp {
  /** The operation: `open`, `write`, `fsync`, `rename`, `rm`, `mkdir` or a read the hook watches. */
  op: string
  /** The absolute path the operation names (for `rename`, its destination). */
  path: string
  /** The flags of an `open`, the source of a `rename`, or the first characters of a write payload. */
  detail?: string
}

const fsLayer = vi.hoisted(() => ({
  /** Every durable-relevant call since the last {@link clearLayer}. */
  ops: [] as { op: string; path: string; detail?: string }[],
  /**
   * The failure rules in force, if any: a matching call throws, and a rule stays
   * armed until it is cleared. For a `write`, `afterBytes` makes it a *mid-write*
   * failure — that many bytes of the payload really reach the file and then the
   * call reports the failure, which is the fragment a full or failing disk leaves
   * behind. Rules are listed rather than single so one case can fail two steps of
   * the same recovery (the write, and the truncate that would undo it).
   */
  fails: [] as { op: string; path: string; message: string; fired: boolean; afterBytes?: number }[],
  /**
   * A short-write rule: a `write` of `path` accepts at most `bytes` bytes per
   * call and reports how many it took — the filesystem behaviour `writeFile`'s
   * own write-all loop exists for.
   */
  shortWrite: undefined as undefined | { path: string; bytes: number },
  /** A hook called after every read of `path` returns — how a case changes a file between two reads of it. */
  onRead: undefined as undefined | ((path: string, reads: number) => Promise<void> | void),
  reads: new Map<string, number>(),
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const record = (op: string, path: string, detail?: string): void => {
    fsLayer.ops.push(detail === undefined ? { op, path } : { op, path, detail })
  }
  /**
   * The armed rule for one operation on one path. `partial` picks the rule that
   * fails *after* part of the payload landed (a mid-write failure) rather than
   * before the call does anything.
   */
  const ruleFor = (op: string, path: string, partial: boolean): { message: string; fired: boolean; afterBytes?: number } | undefined =>
    fsLayer.fails.find(rule => rule.op === op && rule.path === path && (rule.afterBytes !== undefined) === partial)
  const maybeFail = (op: string, path: string): void => {
    const rule = ruleFor(op, path, false)
    if (rule !== undefined) {
      rule.fired = true
      throw new Error(rule.message)
    }
  }
  /** A write payload as text, so a short write can be modelled on any handle. */
  const payloadOf = (data: unknown): string =>
    typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
  /** The first characters of a payload, enough to tell one ledger line from another. */
  const headOf = (payload: string): string => (payload.length > 120 ? `${payload.slice(0, 120)}…` : payload)
  /**
   * A real handle with its durable operations logged: `sync`/`datasync` as the
   * fsync of the path the handle was opened on, `write`/`writeFile` with the
   * payload head, and `truncate` with the length it was asked for. A single-call
   * `write` also honours the short-write rule, which is what a filesystem that
   * accepted only part of the payload returns; the write-all primitive
   * (`writeFile`) is left alone, exactly as the real one is. A mid-write failure
   * rule lets that prefix really reach the file and then reports the failure.
   */
  const wrap = (handle: FileHandle, path: string): FileHandle => new Proxy(handle, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') return value
      if (property === 'sync' || property === 'datasync') {
        return async (): Promise<void> => {
          record('fsync', path)
          maybeFail('fsync', path)
          await (value as () => Promise<void>).call(target)
        }
      }
      if (property === 'write' || property === 'writeFile') {
        return async (data: unknown, ...rest: unknown[]): Promise<unknown> => {
          const payload = payloadOf(data)
          record('write', path, headOf(payload))
          const rule = ruleFor('write', path, true)
          if (rule !== undefined) {
            rule.fired = true
            await (value as (...args: unknown[]) => Promise<unknown>).call(target, payload.slice(0, rule.afterBytes), ...rest)
            throw new Error(rule.message)
          }
          maybeFail('write', path)
          const short = fsLayer.shortWrite
          if (property === 'write' && short !== undefined && short.path === path) {
            return await (value as (...args: unknown[]) => Promise<unknown>).call(target, payload.slice(0, short.bytes), ...rest)
          }
          return await (value as (...args: unknown[]) => Promise<unknown>).call(target, data, ...rest)
        }
      }
      if (property === 'truncate') {
        return async (length: number): Promise<void> => {
          record('truncate', path, String(length))
          maybeFail('truncate', path)
          await (value as (length: number) => Promise<void>).call(target, length)
        }
      }
      return (value as (...args: unknown[]) => unknown).bind(target)
    },
  }) as FileHandle
  const open = actual.open as unknown as (path: string, flags: string, mode?: number) => Promise<FileHandle>
  const rename = actual.rename as unknown as (from: string, to: string) => Promise<void>
  const readFileActual = actual.readFile as unknown as (path: string, options?: unknown) => Promise<unknown>
  const rmActual = actual.rm as unknown as (path: string, options?: unknown) => Promise<void>
  const mkdirActual = actual.mkdir as unknown as (path: string, options?: unknown) => Promise<string | undefined>
  return {
    ...actual,
    open: async (path: string, flags?: string, mode?: number) => {
      const asPath = String(path)
      record('open', asPath, String(flags))
      maybeFail('open', asPath)
      return wrap(await open(asPath, flags ?? 'r', mode), asPath)
    },
    rename: async (from: string, to: string) => {
      const asPath = String(to)
      record('rename', asPath, String(from))
      maybeFail('rename', asPath)
      await rename(String(from), asPath)
    },
    rm: async (path: string, options?: unknown) => {
      const asPath = String(path)
      record('rm', asPath)
      maybeFail('rm', asPath)
      await rmActual(asPath, options)
    },
    mkdir: async (path: string, options?: unknown) => {
      record('mkdir', String(path))
      return await mkdirActual(String(path), options)
    },
    readFile: async (path: string, options?: unknown) => {
      const asPath = String(path)
      record('read', asPath)
      const bytes = await readFileActual(asPath, options)
      const reads = (fsLayer.reads.get(asPath) ?? 0) + 1
      fsLayer.reads.set(asPath, reads)
      await fsLayer.onRead?.(asPath, reads)
      return bytes
    },
  } as typeof actual
})

/**
 * Forget the log, disarm every failure rule, the short-write rule and the read
 * hook: the next phase starts from a clean layer.
 */
function clearLayer(): void {
  fsLayer.ops.length = 0
  fsLayer.fails.length = 0
  fsLayer.shortWrite = undefined
  fsLayer.onRead = undefined
  fsLayer.reads.clear()
}

/**
 * Arm one failure rule: a matching `op` on exactly `path` throws `message`, until
 * the layer is cleared. `afterBytes` makes a write fail mid-payload: that many
 * bytes reach the file, then the call reports the failure. Rules accumulate, so a
 * case can fail two steps of one recovery (the write, and the truncate-back).
 */
function failOn(op: string, path: string, message: string, afterBytes?: number): void {
  fsLayer.fails.push({ op, path, message, fired: false, ...(afterBytes === undefined ? {} : { afterBytes }) })
}

/** The index of the first logged op matching `predicate` after `after` (or -1): the order is read, never sorted. */
function opIndex(predicate: (op: FsOp) => boolean, after = -1): number {
  return fsLayer.ops.findIndex((op, index) => index > after && predicate(op))
}

/** The op log as `op path` lines — how a failure is reported when an order assertion breaks. */
function opLog(): string {
  return fsLayer.ops.map(entry => `${entry.op} ${entry.path}`).join('\n')
}

afterEach(() => {
  clearLayer()
})

/* ------------------------------------------------------------------------ *
 * Fixture: a real service, a real ledger, a real production file, walked    *
 * to decided(PROMOTE). Copied from the fixture pattern of                   *
 * `evolution.spec.ts`, which owns the same walk for the commit cases there  *
 * (the experiment evidence is written through the service's own entries;    *
 * this file needs no store, runtime or model of its own beyond that).       *
 * ------------------------------------------------------------------------ */

/** A production `SKILL.md` body every fixture starts from. */
const PRODUCTION_BODY = '# production verify skill'
/** The candidate body every fixture commits. */
const CANDIDATE_BODY = '# new verify skill\n\nwith a trailing newline'
/** The production path one commit writes. */
const targetOf = (skillRoot: string) => join(skillRoot, 'verify', 'SKILL.md')
/** The two sandbox sources a commit may name, relative to the ledger root: the candidate an apply writes, the champion a rollback restores. */
const CANDIDATE_SOURCE = 'sandbox/s1/skills/verify/SKILL.md'
const CHAMPION_SOURCE = 'sandbox/s1/champion/skills/verify/SKILL.md'

const FIXTURE_SELECTION = modelSelectionOf({ provider: 'p', model: 'm' })!
const FIXTURE_REGISTRY_REVISION = 'r'.repeat(64)
const FIXTURE_JUDGE = { ref: 'command', version: '1' } as const
const VERIFIER_VOCABULARY = ['command', 'composite', 'review']
/** The capability table a fixture context answers with; a fixture candidate declares no sidecar. */
const FIXTURE_CAPABILITIES: Readonly<Record<string, unknown>> = { research: { preset: 'standard' } }

/** The service config every fixture service is built with: the deployment selection the experiment freezes. */
const FIXTURE_CONFIG = { modelSelection: (): ModelSelection | undefined => FIXTURE_SELECTION }

/** The task-store rows a promotion gate re-reads. */
interface FixtureRows {
  tasks: Record<string, unknown>[]
  runs: Record<string, unknown>[]
  reviews: Record<string, unknown>[]
  evidence: Record<string, unknown>[]
  sessions: Map<string, unknown[]>
}

/** The stub context one fixture service runs on: the capability registry, the verifier vocabulary, the store rows. */
function fixtureCtx() {
  const promotionStore: FixtureRows = { tasks: [], runs: [], reviews: [], evidence: [], sessions: new Map() }
  return {
    reflect: { provide: () => {} },
    effect: () => {},
    taskRuntime: { listCapabilities: () => structuredClone(FIXTURE_CAPABILITIES) },
    verifier: {
      ready: async () => {},
      verifierIds: () => [...VERIFIER_VOCABULARY],
      verifierVersions: () => Object.fromEntries(VERIFIER_VOCABULARY.map(id => [id, '1'])),
    },
    sessionQuery: {
      readSession: async (sessionId: string) => {
        const events = promotionStore.sessions.get(sessionId)
        if (events === undefined) throw new Error(`missing session ${sessionId}`)
        return { session: { id: sessionId }, inheritedEventCount: 0, events }
      },
    },
    promotionStore,
    task: { openStore: async () => ({ ...promotionStore, diagnoses: [], obligations: [] }) },
  } as never
}

/** The stub context one fixture service was built on, so a second service reads the same store rows. */
function ctxOf(svc: EvolutionService): never {
  return (svc as unknown as { ctx: never }).ctx
}

/** A second service over the same ledger and store rows as `svc`. */
function reopenLike(svc: EvolutionService, config: Config): EvolutionService {
  return new EvolutionService(ctxOf(svc), config)
}

/** The private commit host the service builds for its own commits: reached by cast, as the fixture's other private reads are. */
function commitHostOf(svc: EvolutionService): CommitHost {
  return (svc as unknown as { commitHost(): CommitHost }).commitHost()
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

/** The mutable store rows behind one fixture service. */
function promotionRows(svc: EvolutionService): FixtureRows {
  const rows = (svc as unknown as { ctx: { promotionStore?: FixtureRows } }).ctx.promotionStore
  if (rows === undefined) throw new Error('this service was not built on fixtureCtx(), so it has no promotion store to fill')
  return rows
}

/** SHA-256 of text, computed here so the code under test is never confirmed against itself. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** A loadable `SKILL.md`: the frontmatter the provider admission requires, plus the body under test. */
function skillText(body: string, name = 'verify'): string {
  return `---\nname: ${name}\ndescription: candidate skill for a commit durability test\n---\n\n${body}`
}

const SKILL_CANDIDATE = skillText(CANDIDATE_BODY)
/** The production object's bytes: loadable text, because prepare reads production through the loader (K3). */
const PRODUCTION_BASELINE = skillText(PRODUCTION_BODY)

const skillProposal: ProposeInput = {
  proposalId: 's1',
  targetType: 'skill',
  targetId: 'verify',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the skill never mentions empty-input fixtures',
  sourceRefs: ['diagnosis:d1'],
}

const VERSION_SET = { skill: 'v2' }

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

/** The `request/header` event one fixture side's session log carries — the model the gate compares. */
function fixtureRequestHeader(): Record<string, unknown> {
  return {
    type: 'request/header',
    seq: 1,
    time: 0,
    data: { header: { config: { provider: FIXTURE_SELECTION.provider, model: FIXTURE_SELECTION.model } }, reason: 'initial' },
  }
}

/**
 * Record one completed two-sided experiment for a prepared skill proposal: the
 * two frozen samples, the four settled sides with the store rows that back them,
 * the ledger's experiment lines and the report on disk — the shape
 * `evolution_replay` writes, composed the way `evolution.spec.ts` composes it so
 * a later stage (the commit) starts from evidence that already stands.
 */
async function recordSkillExperiment(svc: EvolutionService, proposalId = 's1'): Promise<{ reportPath: string; experimentId: string }> {
  const proposal = await svc.get(proposalId)
  const candidate = proposal.prepared!.skillContent!
  const baseline = proposal.prepared!.skillBaseline!
  const rows = promotionRows(svc)
  const workspace = join(await mkdtemp(join(tmpdir(), 'evolution-durability-')), 'env')
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
    budget: {},
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
    const settlements = entry.taskId === 't-fail'
      ? { baseline: 'failed', candidate: 'verified' }
      : { baseline: 'verified', candidate: 'verified' }
    for (const side of ['baseline', 'candidate'] as const) {
      const settlement = settlements[side] as 'verified' | 'failed'
      const lineage = experimentLineage(experimentId, entry.taskId, side)
      const taskId = `t-${entry.taskId}-${side}`
      const runId = `r-${entry.taskId}-${side}`
      const criteria = [{
        criterionId: entry.criteria[0]!.criterionId,
        verdict: settlement === 'verified' ? 'pass' as const : 'fail' as const,
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
      rows.reviews.push({ taskId, runId, outcome: settlement, evidenceRefs: [`e-${runId}`], anomalies: [], criteria })
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
        cost: { status: 'reported', metrics: { toolCalls: { calls: 1, failures: 0 } } },
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

/** A production skill root holding one real `SKILL.md`, the champion every fixture starts from. */
async function productionSkill(skillRoot: string): Promise<void> {
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(targetOf(skillRoot), PRODUCTION_BASELINE)
}

/**
 * A production fixture walked to decided(PROMOTE) through the service's own
 * entries: production holds the champion, the sandbox holds the candidate and
 * its champion snapshot, and the proposal's experiment evidence stands.
 */
async function decidedSkillFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-durability-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  await productionSkill(skillRoot)
  const svc = new EvolutionService(fixtureCtx(), { ...FIXTURE_CONFIG, root, skillRoot })
  await svc.propose(skillProposal, 'root-1')
  await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: SKILL_CANDIDATE })
  await svc.prepare('s1', 'root-1')
  const { reportPath } = await recordSkillExperiment(svc, 's1')
  await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
  await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
  clearLayer()
  return { svc, dir, root, skillRoot }
}

/** Every ledger line, parsed, oldest first — the file itself, never the service's memory. */
async function ledgerLinesOf(root: string): Promise<Record<string, any>[]> {
  return (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, any>)
}

/** Every ledger line's kind, oldest first. */
async function ledgerKinds(root: string): Promise<string[]> {
  return (await ledgerLinesOf(root)).map(line => line.kind as string)
}

/**
 * The directories a durable source needs fsynced for its *path* to survive: the
 * directory that holds it, then every ancestor up to and including the ledger
 * root — inside-out, which is the order the commit fsyncs them in.
 */
function sourceDirectories(root: string, source: string): string[] {
  const directories: string[] = []
  for (let directory = dirname(source); ; directory = dirname(directory)) {
    directories.push(directory)
    if (directory === root || dirname(directory) === directory) break
  }
  return directories
}

/**
 * The durable order of one commit, asserted from the layer's own log: the
 * recoverable source is fsynced — its file, and then *every* directory on its
 * chain up to and including the ledger root, or the intent could outlive the
 * path it names — before the intent line is written; the intent's line and its
 * directory are fsynced before the rename; the rename and its directory fsync
 * come before the completion line. Every fact here is about an operation the code
 * issued, which is what a power cut needs to preserve the line.
 */
function expectDurableOrder(input: {
  source: string
  ledger: string
  root: string
  target: string
  completionKind: 'applied' | 'rolledback'
}): void {
  const { source, ledger, root, target, completionKind } = input
  const sourceFsync = opIndex(op => op.op === 'fsync' && op.path === source)
  const intentWrite = opIndex(op => op.op === 'write' && op.path === ledger && op.detail?.includes('"kind":"commit_intent"') === true)
  expect(sourceFsync, `the source file is fsynced:\n${opLog()}`).toBeGreaterThanOrEqual(0)
  expect(intentWrite, `the intent line is written:\n${opLog()}`).toBeGreaterThanOrEqual(0)
  expect(sourceFsync, `the source file is fsynced before the intent line:\n${opLog()}`).toBeLessThan(intentWrite)

  // The whole chain, asserted as a set and in inside-out order: the source's own
  // directory, then each ancestor up to and including the ledger root, all before
  // the intent line that names that source.
  const chain = sourceDirectories(root, source)
  expect(chain.at(-1), `the source chain reaches the ledger root:\n${opLog()}`).toBe(root)
  const chainFsyncs = chain.map(directory => opIndex(op => op.op === 'fsync' && op.path === directory))
  for (const [index, directory] of chain.entries()) {
    expect(chainFsyncs[index], `the directory "${directory}" on the source chain is fsynced:\n${opLog()}`)
      .toBeGreaterThanOrEqual(0)
    expect(chainFsyncs[index], `"${directory}" is fsynced before the intent line:\n${opLog()}`).toBeLessThan(intentWrite)
    if (index > 0) {
      expect(chainFsyncs[index], `the chain is fsynced inside-out ("${directory}" after "${chain[index - 1]}"):\n${opLog()}`)
        .toBeGreaterThan(chainFsyncs[index - 1]!)
    }
  }

  const intentFileFsync = opIndex(op => op.op === 'fsync' && op.path === ledger, intentWrite)
  const intentDirFsync = opIndex(op => op.op === 'fsync' && op.path === root, intentWrite)
  const rename = opIndex(op => op.op === 'rename' && op.path === target)
  expect(intentFileFsync, `the intent line is fsynced:\n${opLog()}`).toBeGreaterThan(intentWrite)
  expect(intentDirFsync, `the ledger directory is fsynced:\n${opLog()}`).toBeGreaterThan(intentWrite)
  expect(rename, `the rename comes after the intent is durable:\n${opLog()}`).toBeGreaterThan(intentFileFsync)
  expect(rename).toBeGreaterThan(intentDirFsync)

  const targetDirFsync = opIndex(op => op.op === 'fsync' && op.path === dirname(target), rename)
  const completionWrite = opIndex(
    op => op.op === 'write' && op.path === ledger && op.detail?.includes(`"kind":"${completionKind}"`) === true,
  )
  expect(rename, `the rename happens:\n${opLog()}`).toBeGreaterThanOrEqual(0)
  expect(targetDirFsync, `the rename is fsynced before the completion:\n${opLog()}`).toBeGreaterThan(rename)
  expect(completionWrite, `the completion lands after the rename:\n${opLog()}`).toBeGreaterThan(targetDirFsync)
}

describe('K2 durability: the source, the intent line and the rename', () => {
  it('fsyncs the recoverable source before the intent line, and the rename before the completion', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const target = targetOf(skillRoot)

    const outcome = await svc.apply('s1', 'root-1', 'approval:call-1')

    expect(outcome.recovered).toBeUndefined()
    expectDurableOrder({
      source: join(root, CANDIDATE_SOURCE),
      ledger,
      root,
      target,
      completionKind: 'applied',
    })
    // The ledger bytes, read back from the file: the intent binds the identity of
    // the bytes production now holds.
    const lines = await ledgerLinesOf(root)
    expect(lines.map(line => line.kind).slice(-2)).toEqual(['commit_intent', 'applied'])
    const intent = lines.at(-2)!
    expect(intent).toMatchObject({
      intentId: 's1/apply',
      proposalId: 's1',
      direction: 'apply',
      files: [{
        target,
        source: CANDIDATE_SOURCE,
        baselineSha256: sha256Of(PRODUCTION_BASELINE),
        contentSha256: sha256Of(SKILL_CANDIDATE),
      }],
    })
    expect(sha256Hex(await readFile(target))).toBe(intent.files[0].contentSha256)
  })

  it('makes a rollback\'s champion snapshot durable before its own intent', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const target = targetOf(skillRoot)
    clearLayer()

    await svc.rollback('s1', 'root-1', 'approval:call-2')

    expectDurableOrder({
      source: join(root, CHAMPION_SOURCE),
      ledger: join(root, 'proposals.jsonl'),
      root,
      target,
      completionKind: 'rolledback',
    })
    expect(await readFile(target, 'utf8')).toBe(PRODUCTION_BASELINE)
    expect((await ledgerKinds(root)).slice(-2)).toEqual(['commit_intent', 'rolledback'])
  })

  it('fsyncs every directory the first append created, and the parent that names the outermost one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evolution-durability-'))
    const root = join(dir, 'fresh', 'evolution')
    const svc = new EvolutionService(fixtureCtx(), { ...FIXTURE_CONFIG, root, skillRoot: join(dir, 'skills') })

    await svc.propose(skillProposal, 'root-1')

    // `mkdir` created `dir/fresh` and `dir/fresh/evolution`; every one of them,
    // and the directory that names the outermost one, must be fsynced, or a
    // power cut can take the ledger file with the directory that holds it.
    const ledgerFsync = opIndex(op => op.op === 'fsync' && op.path === join(root, 'proposals.jsonl'))
    const createdFsync = opIndex(op => op.op === 'fsync' && op.path === root)
    const outerFsync = opIndex(op => op.op === 'fsync' && op.path === join(dir, 'fresh'))
    const parentFsync = opIndex(op => op.op === 'fsync' && op.path === dir)
    expect(ledgerFsync, opLog()).toBeGreaterThanOrEqual(0)
    expect(createdFsync, `the created ledger directory is fsynced:\n${opLog()}`).toBeGreaterThanOrEqual(0)
    expect(outerFsync, `the first directory mkdir created is fsynced:\n${opLog()}`).toBeGreaterThanOrEqual(0)
    expect(parentFsync, `the parent that names it is fsynced:\n${opLog()}`).toBeGreaterThanOrEqual(0)
    expect(createdFsync).toBeGreaterThan(ledgerFsync)
    expect(outerFsync).toBeGreaterThan(createdFsync)
    expect(parentFsync).toBeGreaterThan(outerFsync)
    expect(await ledgerKinds(root)).toEqual(['proposed'])
  })

  it('refuses a commit whose ledger line cannot be fsynced, and records no completion', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const target = targetOf(skillRoot)
    const before = await readFile(ledger)

    failOn('fsync', ledger, 'simulated ledger fsync failure')
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated ledger fsync failure/)
    expect(message).toContain(ledger)
    expect(message).toMatch(/not durable/)
    // Production never moved: the line that would have justified the write is
    // not durable, so the write must not have happened.
    expect(await readFile(target, 'utf8')).toBe(PRODUCTION_BASELINE)
    // The ledger holds exactly the intent the failed append wrote — the bytes
    // reached the file before the fsync that failed — and no completion was
    // recorded, ever. The pre-commit bytes are still the file's prefix.
    const after = await readFile(ledger)
    expect(after.subarray(0, before.length)).toEqual(before)
    expect(after.subarray(before.length).toString('utf8').endsWith('\n')).toBe(true)
    expect(await ledgerKinds(root)).toContain('commit_intent')
    expect((await ledgerLinesOf(root)).filter(line => line.kind === 'commit_intent')).toEqual([
      expect.objectContaining({ intentId: 's1/apply', proposalId: 's1', direction: 'apply' }),
    ])
    expect(await ledgerKinds(root)).not.toContain('applied')
    // And what the file holds is also what memory holds, so a later call in this
    // process settles that intent instead of appending a second one.
    expect((await svc.get('s1')).openIntent?.intentId).toBe('s1/apply')
    expect(await svc.openIntentTargets()).toEqual([target])
  })

  it('leaves the ledger exactly as it was when the line cannot be written at all', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const target = targetOf(skillRoot)
    const before = await readFile(ledger)

    // A write that fails *mid-payload*: part of the line reaches the file and then
    // the call reports the failure — the fragment a full or failing disk leaves,
    // and a fragment no record explains.
    failOn('write', ledger, 'simulated mid-write failure', 20)
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated mid-write failure/)
    expect(message).toContain(ledger)
    expect(message).toMatch(/not durable/)
    // The ledger is byte-identical to what it held before the call: the fragment
    // was truncated away, so nothing claims a line that is not whole.
    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(target, 'utf8')).toBe(PRODUCTION_BASELINE)
    expect((await svc.get('s1')).openIntent).toBeUndefined()

    // A later, successful commit appends exactly its two complete lines over the
    // untouched prefix, and the ledger a restarted process reads still folds.
    clearLayer()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const after = await readFile(ledger)
    expect(after.subarray(0, before.length)).toEqual(before)
    const tail = after.subarray(before.length).toString('utf8')
    expect(tail.split('\n')).toHaveLength(3)
    const lines = tail.split('\n').slice(0, -1).map(line => JSON.parse(line) as Record<string, any>)
    expect(lines.map(line => line.kind)).toEqual(['commit_intent', 'applied'])
    const reopened = reopenLike(svc, { ...FIXTURE_CONFIG, root, skillRoot })
    expect((await reopened.get('s1')).status).toBe('applied')
    expect(await readFile(target, 'utf8')).toBe(SKILL_CANDIDATE)
  })

  it('says the ledger may hold a partial line when a failed write cannot be rolled back', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const target = targetOf(skillRoot)
    const before = await readFile(ledger)

    // Both ends of the same failure: the write puts part of the line in the file
    // and then reports, and the truncate that would undo it fails too. There is
    // nothing honest left to claim but the truth — and the error says it.
    failOn('write', ledger, 'simulated mid-write failure', 20)
    failOn('truncate', ledger, 'simulated truncate failure')
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated mid-write failure/)
    expect(message).toMatch(/simulated truncate failure/)
    expect(message).toContain(ledger)
    expect(message).toMatch(/could not be truncated back/)
    expect(message).toMatch(/may hold a partial line no record explains/)
    expect(message).toMatch(/not durable/)
    // Distinct from the branch where the rollback worked: that one reports the
    // file is back to the length it started from, and this one must not.
    expect(message).not.toMatch(/the ledger is back to the/)

    // Memory claims nothing — the line never reached the file whole — and no
    // write it would have justified happened.
    expect((await svc.get('s1')).openIntent).toBeUndefined()
    expect(await svc.openIntentTargets()).toEqual([])
    expect(await readFile(target, 'utf8')).toBe(PRODUCTION_BASELINE)
    // The honest state the message describes: the prefix is untouched and the
    // fragment really is there, unparseable — a ledger no process can fold until
    // a human settles it. (So this case reads the bytes, never `ledgerKinds`: a
    // fragment is exactly what that fold refuses.)
    const after = await readFile(ledger)
    expect(after.subarray(0, before.length)).toEqual(before)
    const fragment = after.subarray(before.length).toString('utf8')
    expect(fragment.length).toBeGreaterThan(0)
    expect(() => JSON.parse(fragment)).toThrow()
  })

  it('refuses a commit whose production directory cannot be fsynced after the rename, keeping the intent open', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const target = targetOf(skillRoot)

    failOn('fsync', dirname(target), 'simulated production directory fsync failure')
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated production directory fsync failure/)
    expect(message).toContain(dirname(target))
    expect(message).toContain(target)
    expect(message).toMatch(/may or may not be durable/)
    expect(message).toMatch(/intent stays open/)
    expect(message).toMatch(/no completion is recorded/)
    expect(message).toMatch(/must not be treated as settled/)
    // No completion, an intent that is still open, and production holding one of
    // the two complete versions — the rename landed, so it is the committed one.
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect((await svc.get('s1')).openIntent?.intentId).toBe('s1/apply')
    expect(await svc.openIntentTargets()).toEqual([target])
    expect(await readFile(target, 'utf8')).toBe(SKILL_CANDIDATE)

    // A recovery must not record that completion while the rename still cannot be
    // made durable: the completion is the claim that production holds the
    // committed content *durably*, and the directory fsync is the only thing that
    // makes a rename durable. With the same failure armed for the recovery, the
    // reconciliation stops by name — no completion, the intent still open.
    const recovery = await refusalOf(svc.reconcile())
    expect(recovery).toMatch(/simulated production directory fsync failure/)
    expect(recovery).toContain(dirname(target))
    expect(recovery).toContain(target)
    expect(recovery).toMatch(/completion is not recorded/)
    expect(recovery).toMatch(/intent stays open/)
    expect(recovery).toMatch(/must not be treated as settled/)
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect((await svc.get('s1')).openIntent?.intentId).toBe('s1/apply')
    expect(await svc.openIntentTargets()).toEqual([target])
    expect(await readFile(target, 'utf8')).toBe(SKILL_CANDIDATE)

    // Once the directory can be fsynced the same service settles it: production
    // already carries the committed content, so only the completion is recorded —
    // exactly once.
    clearLayer()
    expect(await svc.reconcile()).toEqual([{
      intentId: 's1/apply',
      proposalId: 's1',
      direction: 'apply',
      targets: [target],
      result: 'completed-written',
    }])
    expect(await readFile(target, 'utf8')).toBe(SKILL_CANDIDATE)
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
    expect(await svc.reconcile()).toEqual([])
  })

  it('writes the whole ledger line even when one write call comes up short', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)
    // A filesystem that accepts only part of the payload in one write call: the
    // line must still land whole, because a truncated JSON line is a ledger no
    // process can load. `writeFile` writes the whole payload in as many calls as
    // that takes; one unchecked `write` would leave the fragment below.
    fsLayer.shortWrite = { path: ledger, bytes: 12 }

    await svc.apply('s1', 'root-1', 'approval:call-1')

    const after = await readFile(ledger)
    expect(after.subarray(0, before.length)).toEqual(before)
    const tail = after.subarray(before.length).toString('utf8')
    expect(tail.split('\n')).toHaveLength(3)
    const lines = tail.split('\n').slice(0, -1).map(line => JSON.parse(line) as Record<string, any>)
    expect(lines.map(line => line.kind)).toEqual(['commit_intent', 'applied'])
    // The ledger a restarted process reads still folds: a fragment would fail the
    // load by name.
    const reopened = reopenLike(svc, { ...FIXTURE_CONFIG, root, skillRoot })
    expect((await reopened.get('s1')).status).toBe('applied')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(SKILL_CANDIDATE)
  })

  it('refuses a commit whose source cannot be fsynced, before any line is recorded', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)

    failOn('fsync', join(root, CANDIDATE_SOURCE), 'simulated source fsync failure')
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated source fsync failure/)
    expect(message).toContain(join(root, CANDIDATE_SOURCE))
    expect(message).toMatch(/no line is recorded/)
    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
  })

  it('refuses a commit whose stale staging file cannot be swept, before anything is staged', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const directory = dirname(targetOf(skillRoot))
    const stale = join(directory, '.SKILL.md.tmp-4242-deadbeef')
    await writeFile(stale, '# a staging file a killed attempt left behind\n')
    const before = await readFile(join(root, 'proposals.jsonl'))

    failOn('rm', stale, 'simulated staging sweep failure')
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated staging sweep failure/)
    expect(message).toContain(stale)
    expect(message).toMatch(/stale staging file/)
    // The sweep failure stops the commit before it stages its own bytes:
    // production still holds the old version, the leftover is still there, and
    // no completion was recorded. The intent line was appended before the write
    // (that is the commit order), so it is the last line the ledger holds — and
    // nothing else was added.
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
    expect(existsSync(stale)).toBe(true)
    const after = await readFile(join(root, 'proposals.jsonl'))
    expect(after.subarray(0, before.length)).toEqual(before)
    const kinds = await ledgerKinds(root)
    expect(kinds.at(-1)).toBe('commit_intent')
    expect(kinds).not.toContain('applied')
  })
})

describe('K2 durability: the source the intent would name', () => {
  it('stops a commit whose source changed between the verified read and the intent', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const source = join(root, CANDIDATE_SOURCE)
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)
    let fired = 0
    // apply reads the candidate several times — the promotion's identity read,
    // its provider check, and the write's own read — and only after the last of
    // those is the commit's own re-read of the source left. The source is
    // replaced exactly then, with no sleep-based race, so the bytes the commit
    // would name are no longer the bytes it verified.
    fsLayer.onRead = async (path, reads) => {
      if (path !== source || reads !== 3) return
      fired += 1
      await writeFile(source, '# replaced between the verified read and the intent\n')
    }

    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(fired).toBe(1)
    expect(message).toMatch(/does not hold the bytes its commit recorded/)
    expect(message).toMatch(/no line is recorded/)
    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
  })

  it('stops an apply whose source is gone before it runs, recording no intent', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)
    await rm(join(root, CANDIDATE_SOURCE))

    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/is missing under/)
    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
  })

  it('refuses a commit whose source chain cannot be fsynced, naming the directory that failed', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    // A directory *between* the source's own directory and the ledger root: the
    // chain the commit fsyncs so the source's path — not only its bytes — survives
    // a power cut. Its failure is the same named stop as the file's.
    const link = join(root, 'sandbox', 's1', 'skills')
    const before = await readFile(ledger)

    failOn('fsync', link, 'simulated source chain fsync failure')
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated source chain fsync failure/)
    expect(message).toContain(link)
    expect(message).toContain(CANDIDATE_SOURCE)
    expect(message).toMatch(/no line is recorded and nothing is written/)
    // Nothing recorded, nothing written, memory claims nothing.
    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses a recoverable source that resolves outside the ledger root, or is the root', async () => {
    const { svc, dir, root, skillRoot } = await decidedSkillFixture()
    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), SKILL_CANDIDATE)
    const before = await readFile(join(root, 'proposals.jsonl'))
    const host = commitHostOf(svc)
    const bytes = Buffer.from(SKILL_CANDIDATE, 'utf8')
    const request = (source: string): CommitRequest => ({
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:call-1',
      files: [{
        target: targetOf(skillRoot),
        baselineSha256: sha256Of(PRODUCTION_BASELINE),
        contentSha256: sha256Of(SKILL_CANDIDATE),
        source,
      }],
      actor: 'root-1',
    })

    // A real file, holding exactly the committed bytes — but outside the root
    // the intent resolves against: refused by name, before anything is read or
    // written.
    const escaping = await refusalOf(commitIntent(host, request('../outside/SKILL.md'), [bytes]))
    expect(escaping).toContain('../outside/SKILL.md')
    expect(escaping).toMatch(/is not inside the ledger root/)
    expect(escaping).toMatch(/nothing is written/)

    // And a source that *is* the root: a commit names bytes, never a directory.
    const rootItself = await refusalOf(commitIntent(host, request('.'), [bytes]))
    expect(rootItself).toMatch(/is not inside the ledger root/)
    expect(rootItself).toMatch(/nothing is written/)

    expect(await readFile(join(root, 'proposals.jsonl'))).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
  })

  it('refuses a commit target outside the production skill root, before anything is written', async () => {
    const { svc, dir, root, skillRoot } = await decidedSkillFixture()
    const outside = join(dir, 'outside', 'SKILL.md')
    await mkdir(dirname(outside), { recursive: true })
    await writeFile(outside, '# a stranger, not a production skill\n')
    const before = await readFile(join(root, 'proposals.jsonl'))
    const host = commitHostOf(svc)
    // A hand-built request whose target escapes the skill root: reachable
    // directly through the exported `commitIntent` (apply/rollback confine the
    // target when they build the request), and it must be refused before the
    // intent is recorded and before the bytes are staged anywhere.
    const request: CommitRequest = {
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:call-1',
      files: [{
        target: outside,
        baselineSha256: sha256Of(PRODUCTION_BASELINE),
        contentSha256: sha256Of(SKILL_CANDIDATE),
        source: CANDIDATE_SOURCE,
      }],
      actor: 'root-1',
    }

    const message = await refusalOf(commitIntent(host, request, [Buffer.from(SKILL_CANDIDATE, 'utf8')]))

    expect(message).toContain(outside)
    expect(message).toMatch(/is not inside the production skill root/)
    expect(message).toMatch(/replaces the fixed file set of one skill object under that root/)
    expect(await readFile(outside, 'utf8')).toBe('# a stranger, not a production skill\n')
    expect(await readdir(dirname(outside))).toEqual(['SKILL.md'])
    expect(await readFile(join(root, 'proposals.jsonl'))).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
  })

  it('blocks a forged intent whose source escapes the ledger root, writing nothing', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const target = targetOf(skillRoot)
    // A hand-forged line the live commit path would refuse: the fold checks the
    // shape of an intent, not where its source resolves — so the recovery path
    // is what must refuse it, and it must write nothing while doing so.
    const ledger = join(root, 'proposals.jsonl')
    const lines = (await readFile(ledger, 'utf8')).trim().split('\n')
    lines.push(JSON.stringify({
      formatVersion: 4,
      kind: 'commit_intent',
      intentId: 's1/apply',
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:call-0',
      files: [{
        target,
        baselineSha256: sha256Of(PRODUCTION_BASELINE),
        contentSha256: sha256Of(SKILL_CANDIDATE),
        source: '../../outside/SKILL.md',
      }],
      actor: 'root-1',
      at: '2026-09-26T00:00:05.000Z',
    }))
    await writeFile(ledger, `${lines.join('\n')}\n`)
    const reopened = reopenLike(svc, { ...FIXTURE_CONFIG, root, skillRoot })

    const outcomes = await reopened.reconcile()

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ intentId: 's1/apply', targets: [target], result: 'blocked' })
    expect(outcomes[0]!.detail).toMatch(/no longer readable as the bytes it committed/)
    expect(outcomes[0]!.detail).toContain('../../outside/SKILL.md')
    expect(await readFile(target, 'utf8')).toBe(PRODUCTION_BASELINE)
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')
  })
})

describe('K2 durability: the staging file, and a real fs failure', () => {
  it('removes the stale staging files of this target and leaves every other entry alone', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const directory = dirname(targetOf(skillRoot))
    const stale = join(directory, '.SKILL.md.tmp-4242-deadbeef')
    const otherTarget = join(directory, '.other.md.tmp-4242-deadbeef')
    const plain = join(directory, 'notes.txt')
    await writeFile(stale, '# a staging file a killed attempt left behind\n')
    await writeFile(otherTarget, '# another target\'s staging file, or a stranger\'s\n')
    await writeFile(plain, '# a file nobody staged\n')

    await svc.apply('s1', 'root-1', 'approval:call-1')

    // This target's own leftover is gone, and only it: the sweep is confined to
    // the target's directory and the target's own staging prefix.
    expect(existsSync(stale)).toBe(false)
    expect(await readFile(otherTarget, 'utf8')).toBe('# another target\'s staging file, or a stranger\'s\n')
    expect(await readFile(plain, 'utf8')).toBe('# a file nobody staged\n')
    // Swept before the new staging file is created, and production holds exactly
    // the committed version.
    const swept = opIndex(op => op.op === 'rm' && op.path === stale)
    const stagedOpen = opIndex(op => op.op === 'open' && op.path.startsWith(join(directory, '.SKILL.md.tmp-')) && op.detail === 'wx')
    expect(swept).toBeGreaterThanOrEqual(0)
    expect(stagedOpen).toBeGreaterThan(swept)
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(SKILL_CANDIDATE)
    expect((await readdir(directory)).filter(entry => entry.includes('.tmp-'))).toEqual(['.other.md.tmp-4242-deadbeef'])
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
  })

  it('sweeps this target\'s staging leftovers when a settlement only records a completion', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const directory = dirname(targetOf(skillRoot))
    const target = targetOf(skillRoot)
    // The rename landed but its directory fsync failed: production already holds
    // the committed bytes and the intent is still open — the shape a settlement
    // settles with a completion alone.
    failOn('fsync', directory, 'simulated production directory fsync failure')
    await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
    expect(await readFile(target, 'utf8')).toBe(SKILL_CANDIDATE)
    // A staging file of this target that a killed attempt left beside it, and a
    // stranger's file: the settlement must remove the one and not touch the other.
    const stale = join(directory, '.SKILL.md.tmp-4242-deadbeef')
    const otherTarget = join(directory, '.other.md.tmp-4242-deadbeef')
    await writeFile(stale, '# a staging file a killed attempt left behind\n')
    await writeFile(otherTarget, '# another target\'s staging file, or a stranger\'s\n')
    clearLayer()

    expect(await svc.reconcile()).toEqual([{
      intentId: 's1/apply',
      proposalId: 's1',
      direction: 'apply',
      targets: [target],
      result: 'completed-written',
    }])

    expect(existsSync(stale)).toBe(false)
    expect(await readFile(otherTarget, 'utf8')).toBe('# another target\'s staging file, or a stranger\'s\n')
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe(SKILL_CANDIDATE)
    // The sweep runs *before* the completion is recorded, so a settlement that
    // cannot sweep stops while the intent is still open (and a later
    // reconciliation can retry it) instead of recording a completion over a
    // leftover nothing is looking at any more.
    const swept = opIndex(op => op.op === 'rm' && op.path === stale)
    const completion = opIndex(
      op => op.op === 'write' && op.path === join(root, 'proposals.jsonl') && op.detail?.includes('"kind":"applied"') === true,
    )
    expect(swept).toBeGreaterThanOrEqual(0)
    expect(completion).toBeGreaterThan(swept)
  })

  it('stops a completion-only settlement when a staging leftover cannot be swept', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const directory = dirname(targetOf(skillRoot))
    const target = targetOf(skillRoot)
    // The same shape the case above settles: the rename landed, its directory
    // fsync failed, so production already holds the committed bytes and the
    // intent is still open.
    failOn('fsync', directory, 'simulated production directory fsync failure')
    await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
    expect(await readFile(target, 'utf8')).toBe(SKILL_CANDIDATE)
    const stale = join(directory, '.SKILL.md.tmp-4242-deadbeef')
    await writeFile(stale, '# a staging file a killed attempt left behind\n')
    clearLayer()
    failOn('rm', stale, 'simulated settlement sweep failure')

    const message = await refusalOf(svc.reconcile())

    expect(message).toMatch(/simulated settlement sweep failure/)
    expect(message).toContain(stale)
    expect(message).toMatch(/stale staging file/)
    expect(message).toMatch(/stops by name/)
    // The settlement stopped: no completion line, the intent still open, the
    // leftover still there, production unchanged — a later reconciliation can
    // retry it.
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect((await svc.get('s1')).openIntent?.intentId).toBe('s1/apply')
    expect(await svc.openIntentTargets()).toEqual([target])
    expect(existsSync(stale)).toBe(true)
    expect(await readFile(target, 'utf8')).toBe(SKILL_CANDIDATE)

    // With the sweep possible again the same intent settles exactly once.
    clearLayer()
    expect(await svc.reconcile()).toEqual([{
      intentId: 's1/apply',
      proposalId: 's1',
      direction: 'apply',
      targets: [target],
      result: 'completed-written',
    }])
    expect(existsSync(stale)).toBe(false)
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
    expect(await svc.reconcile()).toEqual([])
  })

  it('fails by name when the ledger path is a directory, leaving production untouched and no completion', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    await rm(ledger)
    await mkdir(ledger)

    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/^evolution: /)
    expect(message).toContain(ledger)
    expect(message).toMatch(/not durable/)
    expect(await readdir(ledger)).toEqual([])
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
  })

  it('appends exactly the lines it wrote, with no duplicate and no short line', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)

    await svc.apply('s1', 'root-1', 'approval:call-1')

    const after = await readFile(ledger)
    // Append-only: every byte the ledger held before the commit is still the
    // file's prefix, and the commit added exactly two complete lines.
    expect(after.subarray(0, before.length)).toEqual(before)
    const tail = after.subarray(before.length).toString('utf8')
    expect(tail.endsWith('\n')).toBe(true)
    const appended = tail.split('\n')
    expect(appended).toHaveLength(3)
    const lines = appended.slice(0, -1).map(line => JSON.parse(line) as Record<string, any>)
    expect(lines.map(line => line.kind)).toEqual(['commit_intent', 'applied'])
    expect(lines[1]).toMatchObject({ intentId: 's1/apply', targets: [targetOf(skillRoot)], approvalRef: 'approval:call-1' })
    // One intent and one completion in the whole ledger, and production holds the
    // verified candidate bytes.
    const kinds = await ledgerKinds(root)
    expect(kinds.filter(kind => kind === 'commit_intent')).toHaveLength(1)
    expect(kinds.filter(kind => kind === 'applied')).toHaveLength(1)
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(SKILL_CANDIDATE)
  })
})

/* ------------------------------------------------------------------------ *
 * K3 durability: the commit covers the whole skill object — two files, two *
 * sources, two renames, two directory fsyncs, one intent and one           *
 * completion. The order and the named stops are the K2 discipline applied  *
 * per file; the recovery finishes a pair the process died between.         *
 * ------------------------------------------------------------------------ */

/** The production sidecar path beside the `SKILL.md` one commit writes. */
const sidecarTargetOf = (skillRoot: string) => join(skillRoot, 'verify', SKILL_SIDECAR_FILE)
/** The second sandbox source a two-file commit names, relative to the ledger root. */
const SIDECAR_CANDIDATE_SOURCE = 'sandbox/s1/skills/verify/SKILL.contract.json'
const SIDECAR_CHAMPION_SOURCE = 'sandbox/s1/champion/skills/verify/SKILL.contract.json'

/** The production declaration for one `SKILL.md` body: a valid execution sidecar, `resources: []`. */
function declarationOf(skillMd: string): Record<string, unknown> {
  return {
    contractVersion: 1,
    type: 'execution',
    // `research` is a row the fixture registry holds and grants no tools, so the
    // candidate's derived declaration is one the provider check accepts.
    capabilities: ['research'],
    precondition: 'the fixture skill is installed where discovery looks',
    inputs: [],
    outputs: [],
    requiredTools: [],
    verifier: { ref: 'command' },
    content: { skillMdSha256: sha256Of(skillMd), resources: [] },
  }
}

/** Install a production execution object: `SKILL.md` plus the sidecar that declares exactly those bytes. */
async function productionObject(skillRoot: string, body: string): Promise<void> {
  await mkdir(join(skillRoot, 'verify'), { recursive: true })
  await writeFile(targetOf(skillRoot), body)
  await writeFile(sidecarTargetOf(skillRoot), `${JSON.stringify(declarationOf(body), null, 2)}\n`)
}

/** A production execution fixture walked to decided(PROMOTE) through the service's own entries. */
async function objectDecidedFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-durability-object-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  await productionObject(skillRoot, PRODUCTION_BASELINE)
  const svc = new EvolutionService(fixtureCtx(), { ...FIXTURE_CONFIG, root, skillRoot })
  await svc.propose(skillProposal, 'root-1')
  await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: SKILL_CANDIDATE })
  await svc.prepare('s1', 'root-1')
  const { reportPath } = await recordSkillExperiment(svc, 's1')
  await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
  await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
  clearLayer()
  return { svc, dir, root, skillRoot }
}

/** The derived candidate sidecar the sandbox must hold for the fixture's candidate body. */
async function expectedCandidateSidecar(root: string): Promise<string> {
  return (await readFile(join(root, SIDECAR_CANDIDATE_SOURCE), 'utf8'))
}

describe('K3 durability: two files, two sources, one intent', () => {
  it('fsyncs both sources — each file and its directory chain — before the intent line', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const ledger = join(root, 'proposals.jsonl')

    await svc.apply('s1', 'root-1', 'approval:call-1')

    for (const source of [CANDIDATE_SOURCE, SIDECAR_CANDIDATE_SOURCE]) {
      const abs = join(root, source)
      const fileSync = opIndex(op => op.op === 'fsync' && op.path === abs)
      const lineWrite = opIndex(op => op.op === 'write' && op.path === ledger)
      expect(fileSync, `no fsync of ${source}\n${opLog()}`).toBeGreaterThanOrEqual(0)
      expect(lineWrite, `the intent line write is missing\n${opLog()}`).toBeGreaterThan(fileSync)
      for (const directory of sourceDirectories(root, abs)) {
        const directorySync = opIndex(op => op.op === 'fsync' && op.path === directory, fileSync)
        expect(directorySync, `no fsync of ${directory} after ${source}\n${opLog()}`).toBeGreaterThan(fileSync)
        expect(directorySync, `the chain of ${source} is not durable before the intent\n${opLog()}`).toBeLessThan(lineWrite)
      }
    }
    // Both files are in place and the pair is the derived one.
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(SKILL_CANDIDATE)
    expect(await readFile(sidecarTargetOf(skillRoot), 'utf8')).toBe(await expectedCandidateSidecar(root))
  })

  it('writes, renames and fsyncs the two files in intent order, after the intent line', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const skillTarget = targetOf(skillRoot)
    const sidecarTarget = sidecarTargetOf(skillRoot)
    const ledger = join(root, 'proposals.jsonl')

    await svc.apply('s1', 'root-1', 'approval:call-1')

    const intentLine = opIndex(op => op.op === 'write' && op.path === ledger)
    const skillRename = opIndex(op => op.op === 'rename' && op.path === skillTarget)
    const skillDirectory = opIndex(op => op.op === 'fsync' && op.path === dirname(skillTarget))
    const sidecarRename = opIndex(op => op.op === 'rename' && op.path === sidecarTarget)
    const sidecarDirectory = opIndex(op => op.op === 'fsync' && op.path === dirname(sidecarTarget), sidecarRename)
    // The intent is on disk before anything moves, the pair moves in the order
    // the intent lists it, and each rename is made durable before the next file
    // is staged.
    expect(intentLine).toBeGreaterThanOrEqual(0)
    expect(skillRename).toBeGreaterThan(intentLine)
    expect(skillDirectory).toBeGreaterThan(skillRename)
    expect(sidecarRename).toBeGreaterThan(skillDirectory)
    expect(sidecarDirectory).toBeGreaterThan(sidecarRename)
    expect(opLog()).not.toBe('')
  })

  it('stops by name when the second file\u2019s source drifted before the intent, writing nothing', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)
    const productionSidecar = await readFile(sidecarTargetOf(skillRoot), 'utf8')
    const sidecarBytes = await readFile(join(root, SIDECAR_CANDIDATE_SOURCE))
    // The request is built from the digests the sandbox held, then the second
    // source is replaced: the bytes the intent would name are no longer the
    // bytes the commit verified, so the whole pair stops before a line is
    // recorded or a file is written.
    const host = commitHostOf(svc)
    const request: CommitRequest = {
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:call-1',
      files: [
        { target: targetOf(skillRoot), baselineSha256: sha256Of(PRODUCTION_BASELINE), contentSha256: sha256Of(SKILL_CANDIDATE), source: CANDIDATE_SOURCE },
        { target: sidecarTargetOf(skillRoot), baselineSha256: sha256Of(productionSidecar), contentSha256: sha256Hex(sidecarBytes), source: SIDECAR_CANDIDATE_SOURCE },
      ],
      actor: 'root-1',
    }
    await writeFile(join(root, SIDECAR_CANDIDATE_SOURCE), '# a sidecar nobody recorded\n')

    const message = await refusalOf(commitIntent(host, request, [Buffer.from(SKILL_CANDIDATE, 'utf8'), sidecarBytes]))

    expect(message).toContain(SIDECAR_CANDIDATE_SOURCE)
    expect(message).toMatch(/does not hold the bytes its commit recorded/)
    expect(message).toMatch(/no line is recorded and nothing is written/)
    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
    // The sidecar is untouched: the commit stopped before it staged anything.
    expect(await readFile(sidecarTargetOf(skillRoot), 'utf8')).toBe(productionSidecar)
  })

  it('refuses a commit whose second source is not durable before the intent, naming the file', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)

    failOn('fsync', join(root, SIDECAR_CANDIDATE_SOURCE), 'simulated sidecar source fsync failure')
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated sidecar source fsync failure/)
    expect(message).toContain(SIDECAR_CANDIDATE_SOURCE)
    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
  })

  it('stops by name when the second file\u2019s rename fails, leaving a mixed pair the recovery finishes', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const skillTarget = targetOf(skillRoot)
    const sidecarTarget = sidecarTargetOf(skillRoot)
    const beforeSidecar = await readFile(sidecarTarget)

    failOn('rename', sidecarTarget, 'simulated sidecar rename failure')
    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated sidecar rename failure/)
    // The intent is open and nothing is recorded as settled: the SKILL.md moved,
    // the sidecar did not — the mixed pair the ledger explains.
    expect(await ledgerKinds(root)).toContain('commit_intent')
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect(await readFile(skillTarget, 'utf8')).toBe(SKILL_CANDIDATE)
    expect(await readFile(sidecarTarget)).toEqual(beforeSidecar)

    clearLayer()
    const outcomes = await svc.reconcile()
    expect(outcomes.map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(sidecarTarget, 'utf8')).toBe(await expectedCandidateSidecar(root))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
  })

  it('stops by name when the second file\u2019s directory cannot be fsynced after its rename', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const skillTarget = targetOf(skillRoot)
    const sidecarTarget = sidecarTargetOf(skillRoot)
    const directory = dirname(sidecarTarget)
    // Arm the failure only once the first file has landed: the read-back of
    // `SKILL.md` runs after its own rename, so arming there lands the rule on the
    // *second* file's directory fsync — the same directory, the second time.
    fsLayer.onRead = async () => {
      if (fsLayer.ops.some(op => op.op === 'rename' && op.path === skillTarget)) {
        failOn('fsync', directory, 'simulated sidecar directory fsync failure')
      }
    }

    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/simulated sidecar directory fsync failure/)
    expect(message).toContain(directory)
    expect(message).toMatch(/not\s+a settled commit|is not a settled commit/)
    // No completion: the rename that may not be durable is not a settled commit.
    expect(await ledgerKinds(root)).toContain('commit_intent')
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect(await readFile(sidecarTarget, 'utf8')).toBe(await expectedCandidateSidecar(root))

    clearLayer()
    expect((await svc.reconcile()).map(outcome => outcome.result)).toEqual(['completed-written'])
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
  })

  it('records no completion when the whole-object verification refuses: the intent stays open', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const skillTarget = targetOf(skillRoot)
    const sidecarTarget = sidecarTargetOf(skillRoot)
    // After the second file is renamed and read back, the production sidecar
    // disappears (a third party, injected at the read that precedes the whole
    // object check): production is no longer one loadable object, so the
    // completion must not be recorded.
    fsLayer.onRead = async () => {
      if (fsLayer.ops.some(op => op.op === 'rename' && op.path === sidecarTarget)) {
        await rm(sidecarTarget, { force: true })
      }
    }

    const message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))

    expect(message).toMatch(/not as the execution-provider its committed file set describes/)
    expect(await ledgerKinds(root)).toContain('commit_intent')
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect((await svc.get('s1')).openIntent?.intentId).toBe('s1/apply')

    // The open intent is the record a recovery reads: the sidecar a third party
    // removed is reported by name, nothing is overwritten and no completion lands.
    clearLayer()
    const [outcome] = await svc.reconcile()
    expect(outcome!.result).toBe('blocked')
    expect(outcome!.detail).toContain(sidecarTarget)
    expect(outcome!.detail).toMatch(/is missing/)
    expect(await ledgerKinds(root)).not.toContain('applied')
  })

  it('sweeps each file\u2019s own staging prefix and never another target\u2019s', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const directory = dirname(targetOf(skillRoot))
    const skillStale = join(directory, '.SKILL.md.tmp-4242-deadbeef')
    const sidecarStale = join(directory, `.${SKILL_SIDECAR_FILE}.tmp-4242-deadbeef`)
    await writeFile(skillStale, '# a staging file of the first file\n')
    await writeFile(sidecarStale, '# a staging file of the second file\n')

    await svc.apply('s1', 'root-1', 'approval:call-1')

    // Each file sweeps its own prefix, and only its own: a leftover of the same
    // prefix is gone, and the directory holds the pair and nothing else.
    expect(existsSync(skillStale)).toBe(false)
    expect(existsSync(sidecarStale)).toBe(false)
    expect((await readdir(directory)).sort()).toEqual(['SKILL.contract.json', 'SKILL.md'])
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(SKILL_CANDIDATE)
    expect(await readFile(sidecarTargetOf(skillRoot), 'utf8')).toBe(await expectedCandidateSidecar(root))
  })

  it('refuses a two-file intent whose sources or targets leave their roots, writing nothing', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)
    const host = commitHostOf(svc)
    const bytes = [Buffer.from(SKILL_CANDIDATE, 'utf8'), await readFile(join(root, SIDECAR_CANDIDATE_SOURCE))]
    const productionSidecar = await readFile(sidecarTargetOf(skillRoot), 'utf8')
    const request = (over: Partial<CommitRequest['files'][number]>): CommitRequest => ({
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:call-1',
      files: [
        {
          target: targetOf(skillRoot),
          baselineSha256: sha256Of(PRODUCTION_BASELINE),
          contentSha256: sha256Of(SKILL_CANDIDATE),
          source: CANDIDATE_SOURCE,
        },
        {
          target: sidecarTargetOf(skillRoot),
          baselineSha256: sha256Of(productionSidecar),
          contentSha256: sha256Hex(bytes[1]!),
          source: SIDECAR_CANDIDATE_SOURCE,
          ...over,
        },
      ],
      actor: 'root-1',
    })

    const escapingSource = await refusalOf(commitIntent(host, request({ source: '../outside/SKILL.contract.json' }), bytes))
    expect(escapingSource).toContain('../outside/SKILL.contract.json')
    expect(escapingSource).toMatch(/is not inside the ledger root/)

    const escapingTarget = await refusalOf(commitIntent(host, request({ target: join('..', 'outside', SKILL_SIDECAR_FILE) }), bytes))
    expect(escapingTarget).toMatch(/is not inside the production skill root/)

    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
  })

  it('refuses bytes that do not match the second file\u2019s recorded digest, writing nothing', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)
    const host = commitHostOf(svc)
    const skillBytes = Buffer.from(SKILL_CANDIDATE, 'utf8')
    const sidecar = await readFile(sidecarTargetOf(skillRoot), 'utf8')
    const request: CommitRequest = {
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:call-1',
      files: [
        { target: targetOf(skillRoot), baselineSha256: sha256Of(PRODUCTION_BASELINE), contentSha256: sha256Of(SKILL_CANDIDATE), source: CANDIDATE_SOURCE },
        { target: sidecarTargetOf(skillRoot), baselineSha256: sha256Of(sidecar), contentSha256: sha256Of('# not the sidecar it claims'), source: SIDECAR_CANDIDATE_SOURCE },
      ],
      actor: 'root-1',
    }

    const message = await refusalOf(commitIntent(host, request, [skillBytes, await readFile(join(root, SIDECAR_CANDIDATE_SOURCE))]))

    expect(message).toContain(sidecarTargetOf(skillRoot))
    expect(message).toMatch(/not the content identity/)
    expect(await readFile(ledger)).toEqual(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
  })

  it('rolls the pair back only when both files still hold what the proposal applied', async () => {
    const { svc, root, skillRoot } = await objectDecidedFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const ledger = join(root, 'proposals.jsonl')
    const before = await readFile(ledger)
    await writeFile(sidecarTargetOf(skillRoot), '# a later writer moved the sidecar\n')

    const message = await refusalOf(svc.rollback('s1', 'root-1', 'approval:call-2'))

    expect(message).toContain(sidecarTargetOf(skillRoot))
    expect(message).toContain('does not hold the content proposal "s1" applied')
    expect(await readFile(ledger)).toEqual(before)
    expect(await svc.openIntentTargets()).toEqual([])
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(SKILL_CANDIDATE)

    const rollbackIntent = await (async () => {
      await writeFile(sidecarTargetOf(skillRoot), await expectedCandidateSidecar(root))
      return svc.rollback('s1', 'root-1', 'approval:call-2')
    })()
    expect(rollbackIntent.targets).toEqual([targetOf(skillRoot), sidecarTargetOf(skillRoot)])
    expect(await readFile(targetOf(skillRoot), 'utf8')).toBe(PRODUCTION_BASELINE)
    const lines = await ledgerLinesOf(root)
    expect(lines.filter(line => line.kind === 'rolledback')).toHaveLength(1)
    const rollbackFiles = lines.find(line => line.kind === 'commit_intent' && line.direction === 'rollback')!.files as { source: string }[]
    expect(rollbackFiles.map(file => file.source)).toEqual([CHAMPION_SOURCE, SIDECAR_CHAMPION_SOURCE])
  })
})
