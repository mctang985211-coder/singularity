/**
 * Verifier registry: per-mode dispatch, built-in verifiers, and EvidenceBundle construction.
 * @module dsh-singularity-verifier
 */

import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  AcceptanceCriterion,
  EvidenceBundle,
  EvidenceClaim,
  RunId,
  TaskSnapshot,
  VerificationMode,
  VerificationResult,
} from '@dangosys/dsh-singularity-task'
import { CommandVerifier } from './command-verifier.ts'
import { CompositeVerifier, judgeCompositeCriterion } from './composite-verifier.ts'
import { protectedInputDefects } from './protected-inputs.ts'
import { ReviewVerifier } from './review-verifier.ts'
import type {
  Verifier,
  VerifierSelftestSample,
  VerifierSelftestStore,
  VerifyRequest,
} from './types.ts'
export type {
  Verifier,
  VerifierSelftest,
  VerifierSelftestSample,
  VerifierSelftestStore,
  VerifyRequest,
} from './types.ts'
export { CommandVerifier } from './command-verifier.ts'
export { CompositeVerifier, judgeCompositeCriterion } from './composite-verifier.ts'
export type { CompositeTaskSource } from './composite-verifier.ts'
export { ReviewVerifier } from './review-verifier.ts'
export { protectedInputDefects } from './protected-inputs.ts'

/** Caps for the log-tail excerpt a review record carries: enough to read the failure, small enough to keep a record lean. */
export const LOG_TAIL_MAX_LINES = 40
export const LOG_TAIL_MAX_CHARS = 2048
/** Read window for large logs: the tail of a failure lives at the end of the file. */
const LOG_TAIL_READ_BYTES = 64 * 1024

declare module '@deepseek-ai/cordis' {
  interface Context {
    verifier: VerifierRegistry
  }
}

/** Plugin config; every field optional — the constructor resolves defaults. */
export interface Config {
  /**
   * Root directory for verifier evidence logs. Omitted resolves to
   * `$DSH_HOME/task-evidence`, falling back to `<repo root>/.dsh/task-evidence`
   * when `DSH_HOME` is unset. Run logs land in `<evidenceRoot>/<storeId>/<runId>/`.
   */
  evidenceRoot?: string
}

/** Per-call overrides for {@link VerifierRegistry.verifyRun}. */
export interface VerifyRunOptions {
  /** Absolute working directory for criterion commands; defaults to the process cwd. */
  cwd?: string
  /** Per-command timeout in milliseconds, forwarded to the verifier. */
  timeoutMs?: number
}

/** Options for {@link VerifierRegistry.register}. */
export interface RegisterOptions {
  /**
   * Explicit test-double declaration: the only channel that skips the
   * executable selftest gate. A test double stands in for a judge without being
   * one — a fixture whose verdicts the test dictates — and cannot prove a
   * discrimination it does not have. Passing this is the caller's stated
   * intent, logged as one warning; nothing infers it. A missing or descriptive
   * selftest is refused like any other, so no production registration can slip
   * through this gate by omission.
   */
  testDouble?: true
}

function defaultEvidenceRoot(): string {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  return join(process.env.DSH_HOME ?? join(repoRoot, '.dsh'), 'task-evidence')
}

/** How a value reads back in a refusal when the declaration is malformed. */
function described(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value) && value.length === 0) return 'an empty array'
  const json = JSON.stringify(value)
  return json === undefined ? String(value) : json
}

/** How a sample is named in a refusal: by its name when it has one, by position otherwise. */
function sampleWho(sample: VerifierSelftestSample, index: number): string {
  return typeof sample.name === 'string' && sample.name.trim().length > 0 ? `sample "${sample.name}"` : `sample #${index}`
}

/** The thrown error's message, or the value itself when it is not an error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The shape defects of one sample, as readable reasons: the fields the gate
 * needs to execute the sample and to know what a healthy judge returns for it.
 * Collected rather than thrown, so one refusal names every malformed sample.
 * A shape defect refuses registration *before* execution — a sample the gate
 * cannot read is never run as a guess.
 */
function sampleShapeDefects(sample: VerifierSelftestSample, index: number): string[] {
  const named = typeof sample.name === 'string' && sample.name.trim().length > 0
  const who = sampleWho(sample, index)
  const defects: string[] = []
  if (!named) defects.push(`sample #${index} has no name`)
  if (sample.role !== 'positive' && sample.role !== 'negative') {
    defects.push(`${who} has no valid role (got ${described(sample.role)})`)
  } else if (sample.role === 'positive' && sample.expect !== 'pass' && sample.expect !== 'not-pass') {
    defects.push(`${who} (role positive) must expect "pass" or "not-pass" (got ${described(sample.expect)})`)
  } else if (sample.role === 'negative' && sample.expect !== 'fail' && sample.expect !== 'not-pass') {
    // A negative sample expecting `pass` could only ever be satisfied by a
    // judge that cannot tell the sides apart, so it proves nothing.
    defects.push(`${who} (role negative) must expect "fail" or "not-pass" (got ${described(sample.expect)})`)
  }
  const criterion = sample.criterion as AcceptanceCriterion | undefined
  if (criterion === null || typeof criterion !== 'object'
    || typeof criterion.criterionId !== 'string' || criterion.criterionId.trim().length === 0) {
    defects.push(`${who} has no criterion carrying a criterionId`)
  }
  const store = sample.store as VerifierSelftestStore | undefined
  if (store !== undefined && (store === null || typeof store !== 'object' || !Array.isArray(store.children))) {
    defects.push(`${who} declares a store view without children`)
  }
  return defects
}

/**
 * The one result validation production dispatch and the selftest gate share,
 * so the rules cannot drift: exactly one result, for this criterion, signed by
 * this verifier, in a known status, with no `unknownKind` on a status that
 * cannot carry one. Plugins cross a runtime boundary — their TypeScript return
 * type is not validation. Throws the refusal text both callers report.
 */
function validatedResult(verifier: Verifier, criterion: AcceptanceCriterion, results: unknown): VerificationResult {
  const result = Array.isArray(results) && results.length === 1 ? results[0] as VerificationResult | undefined : undefined
  if (result === undefined || result === null || typeof result !== 'object'
    || result.criterionId !== criterion.criterionId || result.verifierId !== verifier.id
    || !['pass', 'fail', 'inconclusive'].includes(result.status)
    || (result.unknownKind !== undefined
      && (result.status !== 'inconclusive' || !['task', 'verifier'].includes(result.unknownKind)))) {
    throw new Error(`verifier "${verifier.id}" must return exactly one valid result for criterion "${criterion.criterionId}" with its own verifierId`)
  }
  return result
}

/** Whether a sample's verdict matches what it declared: `not-pass` accepts any status but `pass`. */
function sampleMissed(sample: VerifierSelftestSample, status: VerificationResult['status']): boolean {
  if (sample.expect === 'pass') return status !== 'pass'
  if (sample.expect === 'fail') return status !== 'fail'
  return status === 'pass'
}

/**
 * The store view a selftest sample declares, as the snapshot a store-reading
 * judgement sees: the sample's children, runs, and evidence, with every other
 * part of a snapshot empty. A sample proves the judgement, not the store.
 */
function sampleSnapshot(store: VerifierSelftestStore): TaskSnapshot {
  return {
    version: 1,
    id: 'verifier-selftest',
    tasks: store.children,
    runs: store.runs ?? [],
    edges: [],
    evidence: store.evidence ?? [],
    handoffs: [],
    reviews: [],
    diagnoses: [],
    obligations: [],
    capabilities: {},
  }
}

export class VerifierRegistry extends Service {
  static inject = ['task']
  static Config: z<Config> = z.object({
    evidenceRoot: z.string(),
  })

  /** Absolute evidence root resolved at construction. */
  readonly evidenceRoot: string
  private readonly verifiers = new Map<string, Verifier>()
  private readonly composite: CompositeVerifier
  private readyPromise?: Promise<void>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'verifier')
    this.evidenceRoot = resolve(config.evidenceRoot ?? defaultEvidenceRoot())
    this.composite = new CompositeVerifier(ctx.task)
  }

  /**
   * Register the three built-ins through the same executable selftest gate
   * every other judge passes. Cordis calls this after construction
   * (`Service.init`); {@link verifyRun} awaits it too, so a caller that never
   * awaited it still gets a readied registry.
   *
   * Idempotent — the first call does the work, every later call awaits the same
   * promise (a rejection stays a rejection: a built-in that fails its own
   * selftest must not become registrable on a retry). Fail closed until it
   * resolves: the registry holds no verifiers yet, so a dispatch that somehow
   * got ahead of it would find no judge and refuse rather than judge with a
   * half-built vocabulary.
   */
  async ready(): Promise<void> {
    this.readyPromise ??= this.registerBuiltins()
    return this.readyPromise
  }

  private async registerBuiltins(): Promise<void> {
    await this.register(new CommandVerifier(this.evidenceRoot))
    await this.register(this.composite)
    await this.register(new ReviewVerifier())
  }

  /**
   * Add a verifier; later registrations win mode dispatch. Returns the
   * disposer. Every registration goes through the executable selftest gate
   * (KISS §4.3, V2-1): the verifier must declare positive and negative samples
   * and then prove, by returning the declared verdict for each, that it can
   * tell the sides apart. A registration that misses a sample — or declares a
   * set the gate cannot execute — is refused with a readable reason naming the
   * verifier and every missed or malformed sample, and is not added. The
   * conclusion is the gate's, taken from executing the samples; a verifier's
   * own description of itself is never consulted.
   *
   * The one exception is the caller's explicit `{ testDouble: true }` — the
   * only skip-the-gate channel, for tests and fixtures that stand in for a
   * judge without being one. It is declared, never inferred, and logged as one
   * warning so the skip is visible in the run that took it.
   */
  async register(verifier: Verifier, options: RegisterOptions = {}): Promise<() => void> {
    if (this.verifiers.has(verifier.id)) throw new Error(`verifier: duplicate verifier "${verifier.id}"`)
    if (options.testDouble === true) {
      this.warn(`verifier "${verifier.id}" registered as a test double: the executable selftest gate is skipped by the caller's explicit declaration`)
    } else {
      await this.selftestGate(verifier)
    }
    this.verifiers.set(verifier.id, verifier)
    return () => {
      this.verifiers.delete(verifier.id)
    }
  }

  /**
   * The executable selftest gate. Two refusals reach the caller, both naming
   * the verifier: `cannot be registered` for a declaration the gate could not
   * execute (missing, empty, one-sided, or malformed samples, or a store view
   * only the registry's own composite judge can be run against), and
   * `selftest failed` for samples that executed and were missed.
   */
  private async selftestGate(verifier: Verifier): Promise<void> {
    const declared = verifier.selftest
    if (declared === undefined) {
      throw new Error(`verifier "${verifier.id}" cannot be registered: no executable selftest samples (KISS §4.3)`)
    }
    const samples = declared.samples
    if (!Array.isArray(samples) || samples.length === 0) {
      throw new Error(`verifier "${verifier.id}" cannot be registered: selftest.samples must be a non-empty array (got ${described(samples)})`)
    }
    const defects: string[] = []
    for (const [index, raw] of samples.entries()) {
      const sample = raw as VerifierSelftestSample | null
      if (sample === null || typeof sample !== 'object') {
        defects.push(`sample #${index} is not an object`)
        continue
      }
      defects.push(...sampleShapeDefects(sample, index))
      // A store-reading sample needs a judge the registry can run against that
      // store view; its own composite instance is the only one there is, so any
      // other judge's store sample is unexecutable here — refused, never
      // silently skipped as if it had passed.
      if (sample.store !== undefined && verifier !== this.composite) {
        defects.push(`${sampleWho(sample, index)} declares a store view, which only the registry's composite judge can execute`)
      }
    }
    if (!samples.some(sample => (sample as { role?: unknown } | null)?.role === 'positive')) {
      defects.push('no sample declares role "positive"')
    }
    if (!samples.some(sample => (sample as { role?: unknown } | null)?.role === 'negative')) {
      defects.push('no sample declares role "negative"')
    }
    if (defects.length > 0) {
      throw new Error(`verifier "${verifier.id}" cannot be registered: ${defects.join('; ')}`)
    }
    const misses = await this.executeSamples(verifier, samples as VerifierSelftestSample[])
    if (misses.length > 0) throw new Error(`verifier "${verifier.id}" selftest failed: ${misses.join('; ')}`)
  }

  /**
   * Execute the declared samples in order and collect every miss. Each sample
   * is judged the way production judges it — through `verify` for a
   * criterion-only judge, through the shared composite judgement over the
   * sample's declared store view for the registry's own composite instance —
   * and validated by the same rules production applies. Samples run against a
   * scratch cwd and log dir under the evidence root, so a command sample
   * really spawns and everything it writes stays inside evidenceRoot.
   */
  private async executeSamples(verifier: Verifier, samples: readonly VerifierSelftestSample[]): Promise<string[]> {
    const cwd = join(this.evidenceRoot, 'selftest', 'cwd')
    await mkdir(cwd, { recursive: true })
    const misses: string[] = []
    for (const [index, sample] of samples.entries()) {
      const where = `${sampleWho(sample, index)} (role ${sample.role})`
      const store = sample.store
      const logDir = join(this.evidenceRoot, 'selftest', verifier.id, String(index))
      let judged: VerificationResult[]
      try {
        judged = store === undefined
          ? await verifier.verify({ taskId: 'verifier-selftest', runId: 'verifier-selftest', criteria: [sample.criterion], cwd, logDir })
          : [await judgeCompositeCriterion(sample.criterion, store.children, async () => sampleSnapshot(store))]
      } catch (error) {
        misses.push(`${where} threw: ${messageOf(error)}`)
        continue
      }
      let result: VerificationResult
      try {
        result = validatedResult(verifier, sample.criterion, judged)
      } catch (error) {
        misses.push(`${where} produced no valid result: ${messageOf(error)}`)
        continue
      }
      if (sampleMissed(sample, result.status)) {
        const details = result.details === undefined ? '' : ` (details: ${result.details})`
        misses.push(`${where} expected "${sample.expect}" but the judge returned "${result.status}"${details}`)
      }
    }
    return misses
  }

  /** The registered verifier ids, sorted — the vocabulary a criterion's `verifierRef` may name. */
  verifierIds(): string[] {
    return [...this.verifiers.keys()].sort()
  }

  /** Best-effort warn through the cordis logger when one is mounted; tests and minimal contexts may not have it. */
  private warn(message: string): void {
    const logger = (this.ctx as { logger?: (name: string) => { warn(format: string): void } }).logger
    logger?.('verifier').warn(message)
  }

  /** Cordis runs this after construction: the built-ins are gated before the service is usable. */
  async [Service.init](): Promise<void> {
    await this.ready()
  }

  /**
   * Verify one run: dispatch each acceptance criterion of the run's task to a
   * verifier supporting its mode, assemble an EvidenceBundle (one claim per
   * result), record it through the task service, and return it. Marking the
   * run verified or failed is the caller's job and must come after this call.
   */
  async verifyRun(storeId: string, runId: RunId, options: VerifyRunOptions = {}): Promise<EvidenceBundle> {
    await this.ready()
    const run = await this.ctx.task.runIn(storeId, runId)
    const task = await this.ctx.task.taskIn(storeId, run.taskId)
    const request: VerifyRequest = {
      taskId: task.taskId,
      runId,
      criteria: [],
      cwd: options.cwd ?? process.cwd(),
      logDir: join(this.evidenceRoot, storeId, runId),
      timeoutMs: options.timeoutMs,
    }
    const results: VerificationResult[] = []
    for (const criterion of task.acceptanceCriteria) {
      results.push(...(await this.verifyCriterion(storeId, request, criterion)))
    }
    const evidenceId = `evidence-${runId}-${randomUUID()}`
    const bundle: EvidenceBundle = {
      evidenceId,
      taskRunId: runId,
      taskId: task.taskId,
      artifacts: [...run.artifacts],
      verifierResults: results,
      claims: results.map(result => this.claim(evidenceId, result)),
      generatedAt: new Date().toISOString(),
    }
    await this.ctx.task.recordEvidenceIn(storeId, bundle, 'verifier')
    return bundle
  }

  private async verifyCriterion(storeId: string, request: VerifyRequest, criterion: AcceptanceCriterion): Promise<VerificationResult[]> {
    // An explicit `verifierRef` pins the judge by id (admission already
    // rejected unknown ids, but a store can predate the registry or a replay
    // can bypass admission); absent, dispatch by mode as before.
    const verifier = criterion.verifierRef === undefined
      ? this.findVerifier(criterion.verificationMode)
      : this.verifiers.get(criterion.verifierRef)
    if (verifier === undefined) {
      // The judge is missing — a verifier-side unknown (KISS §4.3 UNKNOWN_VERIFIER).
      return [{
        criterionId: criterion.criterionId,
        status: 'inconclusive',
        verifierId: criterion.verifierRef ?? 'verifier',
        details: criterion.verifierRef === undefined
          ? `no verifier supports mode "${criterion.verificationMode}"`
          : `no verifier registered with id "${criterion.verifierRef}"`,
        unknownKind: 'verifier',
      }]
    }
    if (!verifier.supports(criterion.verificationMode)) {
      return [{
        criterionId: criterion.criterionId,
        status: 'inconclusive',
        verifierId: verifier.id,
        details: `verifier "${verifier.id}" does not support mode "${criterion.verificationMode}"`,
        unknownKind: 'verifier',
      }]
    }
    const protectedInputs = criterion.protectedInputs
    if ((protectedInputs?.length ?? 0) > 0) {
      // The verdict rests on these inputs; an input that moved since admission
      // means the product in front of the judge is not the one that was
      // admitted to be judged. Refused before anything is dispatched, so a
      // rewritten acceptance script can never be the thing that passes.
      const defects = await protectedInputDefects(request.cwd, protectedInputs!)
      if (defects.length > 0) {
        return [this.stampVersion(verifier, {
          criterionId: criterion.criterionId,
          status: 'fail',
          verifierId: verifier.id,
          details: defects.join('; '),
        })]
      }
    }
    let results: VerificationResult[]
    try {
      // Evidence mappings remain mandatory even when a plugin owns mode dispatch.
      if ((criterion.childEvidence?.length ?? 0) > 0 && verifier !== this.composite) {
        const mapped = await this.composite.verifyIn(storeId, { ...request, criteria: [criterion] })
        // The map is judged by the registry's own composite instance, so that
        // instance — not the plugin that never ran — is what its verdict is
        // attributed to.
        if (mapped[0]!.status !== 'pass') return mapped.map(result => this.stampVersion(this.composite, result))
      }
      results = verifier instanceof CompositeVerifier
        ? await verifier.verifyIn(storeId, { ...request, criteria: [criterion] })
        : await verifier.verify({ ...request, criteria: [criterion] })
      // Plugins cross a runtime boundary: their TypeScript return type is not validation.
      validatedResult(verifier, criterion, results)
    } catch (error) {
      // The judge itself broke — a verifier-side unknown, never a task failure.
      return [{
        criterionId: criterion.criterionId,
        status: 'inconclusive',
        verifierId: verifier.id,
        details: error instanceof Error ? error.message : String(error),
        unknownKind: 'verifier',
      }]
    }
    return results.map(result => this.normalizeLogRef(this.stampVersion(verifier, result)))
  }

  /**
   * Stamp the registered instance's version onto one verdict (KISS §8.2): a
   * verdict can only be recalled against the instance that actually judged, so
   * the version recorded is this instance's — a plugin-supplied
   * `verifierVersion` is always discarded, and an instance that declares none
   * acquires none.
   */
  private stampVersion(verifier: Verifier, result: VerificationResult): VerificationResult {
    const stamped: VerificationResult = { ...result }
    delete stamped.verifierVersion
    if (verifier.version !== undefined) stamped.verifierVersion = verifier.version
    return stamped
  }

  private findVerifier(mode: VerificationMode): Verifier | undefined {
    const registered = [...this.verifiers.values()]
    for (let index = registered.length - 1; index >= 0; index -= 1) {
      if (registered[index]!.supports(mode)) return registered[index]!
    }
    return undefined
  }

  private normalizeLogRef(result: VerificationResult): VerificationResult {
    if (result.logRef === undefined || !isAbsolute(result.logRef)) return result
    const rel = relative(this.evidenceRoot, result.logRef)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`verifier: logRef "${result.logRef}" escapes evidenceRoot`)
    }
    return { ...result, logRef: rel }
  }

  /**
   * Tail excerpt of one criterion log (logRef relative to evidenceRoot),
   * bounded by LOG_TAIL_MAX_LINES and LOG_TAIL_MAX_CHARS, for a failed review
   * record to carry. `undefined` when the log is missing or unreadable — a
   * record must never fail to write because a log is gone.
   */
  async logTail(logRef: string): Promise<string | undefined> {
    const path = resolve(this.evidenceRoot, logRef)
    if (path !== this.evidenceRoot && !path.startsWith(this.evidenceRoot + sep)) {
      throw new Error(`verifier: logRef "${logRef}" escapes evidenceRoot`)
    }
    let handle
    try {
      handle = await open(path, 'r')
    } catch {
      return undefined
    }
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, LOG_TAIL_READ_BYTES)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      const lines = buffer.toString('utf8').split('\n')
      let excerpt = lines.slice(-LOG_TAIL_MAX_LINES).join('\n').trimEnd()
      if (excerpt.length > LOG_TAIL_MAX_CHARS) excerpt = excerpt.slice(-LOG_TAIL_MAX_CHARS)
      return excerpt.length === 0 ? undefined : excerpt
    } finally {
      await handle.close()
    }
  }

  private claim(evidenceId: string, result: VerificationResult): EvidenceClaim {
    return {
      claimId: `${evidenceId}#${result.criterionId}`,
      criterionId: result.criterionId,
      status: result.status,
      verifierId: result.verifierId,
      ...(result.verifierVersion === undefined ? {} : { verifierVersion: result.verifierVersion }),
      artifactRefs: [],
      details: result.details,
      ...(result.unknownKind === undefined ? {} : { unknownKind: result.unknownKind }),
    }
  }
}

export default VerifierRegistry
