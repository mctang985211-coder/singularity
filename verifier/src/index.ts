/**
 * Verifier registry: per-mode dispatch, built-in verifiers, and EvidenceBundle construction.
 * @module dsh-singularity-verifier
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
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

export type { VerificationMode, VerificationResult, Verifier, VerifyRequest } from '@dangosys/dsh-singularity-task'
export { CommandVerifier } from './command-verifier.ts'
export { CompositeVerifier } from './composite-verifier.ts'
export type { CompositeTaskSource } from './composite-verifier.ts'
export { ReviewVerifier } from './review-verifier.ts'

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

  /** Add a verifier; later registrations win mode dispatch. Returns the disposer. */
  register(verifier: Verifier): () => void {
    if (this.verifiers.has(verifier.id)) throw new Error(`verifier: duplicate verifier "${verifier.id}"`)
    this.verifiers.set(verifier.id, verifier)
    return () => {
      this.verifiers.delete(verifier.id)
    }
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
    const verifier = this.findVerifier(criterion.verificationMode)
    if (verifier === undefined) {
      return [{
        criterionId: criterion.criterionId,
        status: 'inconclusive',
        verifierId: 'verifier',
        details: `no verifier supports mode "${criterion.verificationMode}"`,
      }]
    }
    let results: VerificationResult[]
    try {
      results = verifier instanceof CompositeVerifier
        ? await verifier.verifyIn(storeId, { ...request, criteria: [criterion] })
        : await verifier.verify({ ...request, criteria: [criterion] })
    } catch (error) {
      return [{
        criterionId: criterion.criterionId,
        status: 'inconclusive',
        verifierId: verifier.id,
        details: error instanceof Error ? error.message : String(error),
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

  private claim(evidenceId: string, result: VerificationResult): EvidenceClaim {
    return {
      claimId: `${evidenceId}#${result.criterionId}`,
      criterionId: result.criterionId,
      status: result.status,
      verifierId: result.verifierId,
      artifactRefs: [],
      details: result.details,
    }
  }
}

export default VerifierRegistry
