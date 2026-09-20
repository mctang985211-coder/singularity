/**
 * Verifier registry: per-mode dispatch, built-in verifiers, and EvidenceBundle construction.
 * @module dsh-singularity-verifier
 */

import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@dangosys/dsh-singularity-task'
import type {
  AcceptanceCriterion,
  EvidenceBundle,
  EvidenceClaim,
  RunId,
  VerificationMode,
  VerificationResult,
  Verifier,
  VerifyRequest,
} from '@dangosys/dsh-singularity-task'
import { CommandVerifier } from './command-verifier.ts'
import { CompositeVerifier } from './composite-verifier.ts'
import { ReviewVerifier } from './review-verifier.ts'

export type { VerificationMode, VerificationResult, Verifier, VerifierSelftest, VerifyRequest } from '@dangosys/dsh-singularity-task'
export { CommandVerifier } from './command-verifier.ts'
export { CompositeVerifier } from './composite-verifier.ts'
export type { CompositeTaskSource } from './composite-verifier.ts'
export { ReviewVerifier } from './review-verifier.ts'

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

function defaultEvidenceRoot(): string {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
  return join(process.env.DSH_HOME ?? join(repoRoot, '.dsh'), 'task-evidence')
}

export class VerifierRegistry extends Service {
  static inject = ['task']
  static Config: z<Config> = z.object({
    evidenceRoot: z.string(),
  })

  /** Absolute evidence root resolved at construction. */
  readonly evidenceRoot: string
  private readonly verifiers = new Map<string, Verifier>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'verifier')
    this.evidenceRoot = resolve(config.evidenceRoot ?? defaultEvidenceRoot())
    this.register(new CommandVerifier(this.evidenceRoot))
    this.register(new CompositeVerifier(ctx.task))
    this.register(new ReviewVerifier())
  }

  /**
   * Add a verifier; later registrations win mode dispatch. Returns the
   * disposer. A registration without a `selftest` (KISS §4.3) is logged as a
   * warning, not refused — soft until every built-in verifier carries one,
   * so existing test doubles keep registering; flipping to a hard refusal is
   * a deliberate later step.
   */
  register(verifier: Verifier): () => void {
    if (this.verifiers.has(verifier.id)) throw new Error(`verifier: duplicate verifier "${verifier.id}"`)
    if (verifier.selftest === undefined) {
      this.warn(`verifier "${verifier.id}" registered without a selftest (no declared positive/negative known samples)`)
    }
    this.verifiers.set(verifier.id, verifier)
    return () => {
      this.verifiers.delete(verifier.id)
    }
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

  /**
   * Verify one run: dispatch each acceptance criterion of the run's task to a
   * verifier supporting its mode, assemble an EvidenceBundle (one claim per
   * result), record it through the task service, and return it. Marking the
   * run verified or failed is the caller's job and must come after this call.
   */
  async verifyRun(storeId: string, runId: RunId, options: VerifyRunOptions = {}): Promise<EvidenceBundle> {
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
    let results: VerificationResult[]
    try {
      results = verifier instanceof CompositeVerifier
        ? await verifier.verifyIn(storeId, { ...request, criteria: [criterion] })
        : await verifier.verify({ ...request, criteria: [criterion] })
      // Plugins cross a runtime boundary: their TypeScript return type is not validation.
      const result = Array.isArray(results) && results.length === 1 ? results[0] : undefined
      if (result === undefined || result === null || typeof result !== 'object'
        || result.criterionId !== criterion.criterionId || result.verifierId !== verifier.id
        || !['pass', 'fail', 'inconclusive'].includes(result.status)
        || (result.unknownKind !== undefined
          && (result.status !== 'inconclusive' || !['task', 'verifier'].includes(result.unknownKind)))) {
        throw new Error(`verifier "${verifier.id}" must return exactly one valid result for criterion "${criterion.criterionId}" with its own verifierId`)
      }
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
    return results.map(result => this.normalizeLogRef(result))
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
      artifactRefs: [],
      details: result.details,
      ...(result.unknownKind === undefined ? {} : { unknownKind: result.unknownKind }),
    }
  }
}

export default VerifierRegistry
