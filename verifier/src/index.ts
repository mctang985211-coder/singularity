/** @module dsh-singularity-verifier */

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
import {
  LOG_TAIL_MAX_CHARS,
  LOG_TAIL_MAX_LINES,
  type Verifier,
  type VerifierSelftestSample,
  type VerifierSelftestStore,
  type VerifyRequest,
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

/** Read window for large logs: the tail of a failure lives at the end of the file. */
const LOG_TAIL_READ_BYTES = 64 * 1024

declare module '@deepseek-ai/cordis' {
  interface Context {
    verifier: VerifierRegistry
  }
}

/** Plugin config; every field optional — the constructor resolves defaults. */
export interface Config {
  /** Root for verifier evidence logs; omitted resolves to `$DSH_HOME/task-evidence`, else `<repo>/.dsh/task-evidence`. */
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
interface RegisterOptions {
  /** The explicit test-double declaration: the only channel that skips the executable selftest gate. */
  testDouble?: true
}

function defaultEvidenceRoot(): string {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  return join(process.env.DSH_HOME ?? join(repoRoot, '.dsh'), 'task-evidence')
}

/** The thrown error's message, or the value itself when it is not an error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The one result check production dispatch and the selftest gate share: one result, this criterion, this verifier. */
function validatedResult(verifier: Verifier, criterion: AcceptanceCriterion, results: unknown): VerificationResult {
  const result =
    Array.isArray(results) && results.length === 1 ? (results[0] as VerificationResult | undefined) : undefined
  if (
    result === undefined ||
    result === null ||
    typeof result !== 'object' ||
    result.criterionId !== criterion.criterionId ||
    result.verifierId !== verifier.id
  ) {
    throw new Error(
      `verifier "${verifier.id}" must return exactly one valid result for criterion "${criterion.criterionId}" with its own verifierId`,
    )
  }
  return result
}

/** Whether a sample's verdict matches what it declared: `not-pass` accepts any status but `pass`. */
function sampleMissed(sample: VerifierSelftestSample, status: VerificationResult['status']): boolean {
  if (sample.expect === 'pass') return status !== 'pass'
  if (sample.expect === 'fail') return status !== 'fail'
  return status === 'pass'
}

/** The store view a sample declares, as the snapshot a store-reading judgement sees; the sample proves the judgement, not the store. */
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

  /** Register the three built-ins through the executable selftest gate; idempotent, and fail-closed until it resolves. */
  async ready(): Promise<void> {
    this.readyPromise ??= this.registerBuiltins()
    return this.readyPromise
  }

  private async registerBuiltins(): Promise<void> {
    await this.register(new CommandVerifier(this.evidenceRoot))
    await this.register(this.composite)
    await this.register(new ReviewVerifier())
  }

  /** Add a verifier (later registrations win mode dispatch) and return its disposer; the selftest gate runs first. */
  async register(verifier: Verifier, options: RegisterOptions = {}): Promise<() => void> {
    if (this.verifiers.has(verifier.id)) throw new Error(`verifier: duplicate verifier "${verifier.id}"`)
    if (options.testDouble === true) {
      this.warn(
        `verifier "${verifier.id}" registered as a test double: the executable selftest gate is skipped by the caller's explicit declaration`,
      )
    } else {
      await this.selftestGate(verifier)
    }
    this.verifiers.set(verifier.id, verifier)
    return () => {
      this.verifiers.delete(verifier.id)
    }
  }

  /** The executable selftest gate: an unexecutable declaration is refused by name, a missed sample fails registration. */
  private async selftestGate(verifier: Verifier): Promise<void> {
    const declared = verifier.selftest
    if (declared === undefined) {
      throw new Error(`verifier "${verifier.id}" cannot be registered: no executable selftest samples (KISS §4.3)`)
    }
    const samples = declared.samples
    const defects: string[] = []
    // A store-reading sample needs the registry's own composite judge, the only one it can run against a store view.
    for (const sample of samples) {
      if (sample.store !== undefined && verifier !== this.composite) {
        defects.push(
          `sample "${sample.name}" declares a store view, which only the registry's composite judge can execute`,
        )
      }
    }
    if (!samples.some(sample => sample.role === 'positive')) defects.push('no sample declares role "positive"')
    if (!samples.some(sample => sample.role === 'negative')) defects.push('no sample declares role "negative"')
    if (defects.length > 0) {
      throw new Error(`verifier "${verifier.id}" cannot be registered: ${defects.join('; ')}`)
    }
    const misses = await this.executeSamples(verifier, samples)
    if (misses.length > 0) throw new Error(`verifier "${verifier.id}" selftest failed: ${misses.join('; ')}`)
  }

  /** Execute the declared samples in order and collect every miss, judged the way production judges them. */
  private async executeSamples(verifier: Verifier, samples: readonly VerifierSelftestSample[]): Promise<string[]> {
    const cwd = join(this.evidenceRoot, 'selftest', 'cwd')
    await mkdir(cwd, { recursive: true })
    const misses: string[] = []
    for (const [index, sample] of samples.entries()) {
      const where = `sample "${sample.name}" (role ${sample.role})`
      const store = sample.store
      const logDir = join(this.evidenceRoot, 'selftest', verifier.id, String(index))
      let judged: VerificationResult[]
      try {
        judged =
          store === undefined
            ? await verifier.verify({
                taskId: 'verifier-selftest',
                runId: 'verifier-selftest',
                criteria: [sample.criterion],
                cwd,
                logDir,
              })
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

  /** The version each registered verifier declares, by id; an instance declaring none is absent from the map. */
  verifierVersions(): Record<string, string> {
    const versions: Record<string, string> = {}
    for (const [id, verifier] of this.verifiers) {
      if (verifier.version !== undefined) versions[id] = verifier.version
    }
    return versions
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

  /** Verify one run: dispatch each criterion, assemble an EvidenceBundle, record it, and return it. */
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

  private async verifyCriterion(
    storeId: string,
    request: VerifyRequest,
    criterion: AcceptanceCriterion,
  ): Promise<VerificationResult[]> {
    // `verifierRef` pins the judge by id; absent, dispatch by mode. A store can predate the registry or bypass admission.
    const verifier =
      criterion.verifierRef === undefined
        ? this.findVerifier(criterion.verificationMode)
        : this.verifiers.get(criterion.verifierRef)
    if (verifier === undefined) {
      // The judge is missing — a verifier-side unknown (KISS §4.3 UNKNOWN_VERIFIER).
      return [
        {
          criterionId: criterion.criterionId,
          status: 'inconclusive',
          verifierId: criterion.verifierRef ?? 'verifier',
          details:
            criterion.verifierRef === undefined
              ? `no verifier supports mode "${criterion.verificationMode}"`
              : `no verifier registered with id "${criterion.verifierRef}"`,
          unknownKind: 'verifier',
        },
      ]
    }
    if (!verifier.supports(criterion.verificationMode)) {
      return [
        {
          criterionId: criterion.criterionId,
          status: 'inconclusive',
          verifierId: verifier.id,
          details: `verifier "${verifier.id}" does not support mode "${criterion.verificationMode}"`,
          unknownKind: 'verifier',
        },
      ]
    }
    const protectedInputs = criterion.protectedInputs
    if ((protectedInputs?.length ?? 0) > 0) {
      // The verdict rests on these inputs: one that moved since admission is not the one admitted to be judged.
      const defects = await protectedInputDefects(request.cwd, protectedInputs!)
      if (defects.length > 0) {
        return [
          this.stampVersion(verifier, {
            criterionId: criterion.criterionId,
            status: 'fail',
            verifierId: verifier.id,
            details: defects.join('; '),
          }),
        ]
      }
    }
    let results: VerificationResult[]
    try {
      // Evidence mappings remain mandatory even when a plugin owns mode dispatch; the registry's composite judges them.
      if ((criterion.childEvidence?.length ?? 0) > 0 && verifier !== this.composite) {
        const mapped = await this.composite.verifyIn(storeId, { ...request, criteria: [criterion] })
        if (mapped[0]!.status !== 'pass') return mapped.map(result => this.stampVersion(this.composite, result))
      }
      results =
        verifier instanceof CompositeVerifier
          ? await verifier.verifyIn(storeId, { ...request, criteria: [criterion] })
          : await verifier.verify({ ...request, criteria: [criterion] })
      // Plugins cross a runtime boundary: their TypeScript return type is not validation.
      validatedResult(verifier, criterion, results)
    } catch (error) {
      // The judge itself broke — a verifier-side unknown, never a task failure.
      return [
        {
          criterionId: criterion.criterionId,
          status: 'inconclusive',
          verifierId: verifier.id,
          details: error instanceof Error ? error.message : String(error),
          unknownKind: 'verifier',
        },
      ]
    }
    return results.map(result => this.normalizeLogRef(this.stampVersion(verifier, result)))
  }

  /** Stamp the registered instance's version onto one verdict (KISS §8.2); a plugin-supplied version is discarded. */
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

  /** Tail excerpt of one criterion log, capped by the two LOG_TAIL limits; `undefined` when the log is missing. */
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
