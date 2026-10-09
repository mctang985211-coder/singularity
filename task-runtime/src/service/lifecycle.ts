/**
 * Runtime lifecycle: construction, provider load, capability rows and gates.
 */

import type { TaskRuntime } from './runtime.ts'
import type { CapabilityManifest } from '@dangosys/dsh-singularity-task'
import { type CapabilityConfig } from '../capability.ts'
import { ExecutionGate } from '../gate.ts'
import { message } from '../helpers.ts'
import { providerDefectLines } from '../provider-precheck.ts'
import type { RootBudgetConfig } from '../root-budget.ts'
import type { BudgetConfig } from '../orchestration/types.ts'
import { DEFAULT_SUPERVISION, type ProviderLoadReport, type SupervisionConfig } from '../config.ts'
import * as svcEnv from './env.ts'
import * as svcRootRecovery from './root-recovery.ts'

export function assertClosedRootBudget(budget: RootBudgetConfig | undefined): void {
  if (budget === undefined) return
  const known = new Set(['maxRuns', 'maxConcurrentWrites'])
  const unknown = Object.keys(budget).filter(key => !known.has(key))
  if (unknown.length === 0) return
  throw new Error(
    `task-runtime: rootBudget names [${unknown.join(', ')}], which this deployment does not enforce; ` +
      'a hard limit that cannot be executed refuses to start rather than running under a promise nobody keeps',
  )
}

export function assertGeneratedTaskReview(policy: unknown): void {
  if (policy === undefined || policy === 'off' || policy === 'all') return
  throw new Error(
    `task-runtime: generatedTaskReview is ${JSON.stringify(policy)}; the review policy is "off" or "all" ` +
      '(§5 defines no other mode, and a policy this build cannot execute refuses to start rather than admitting unreviewed batches)',
  )
}

/** Refuse a supervision policy this build cannot read: an unread member is a typo, and a cap is a whole count at or above zero. */
export function assertSupervisionConfig(policy: unknown): void {
  if (policy === undefined) return
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('task-runtime: supervision must be an object with the round-cap and allowance members')
  }
  const known = new Set(['maxRecoveryRounds', 'maxImprovementRounds', 'coordinationBudget'])
  const unknown = Object.keys(policy).filter(key => !known.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `task-runtime: supervision names [${unknown.join(', ')}], which this policy does not declare; ` +
        'a member nobody reads refuses to start rather than being silently ignored',
    )
  }
  const record = policy as Record<string, unknown>
  for (const name of ['maxRecoveryRounds', 'maxImprovementRounds', 'coordinationBudget'] as const) {
    const value = record[name]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < (name === 'coordinationBudget' ? 1 : 0)) {
      throw new Error(
        `task-runtime: supervision.${name} is ${JSON.stringify(value)}; it must be a whole ${name === 'coordinationBudget' ? 'count of at least 1' : 'count of at least 0'}`,
      )
    }
  }
}

/**
 * The policy in force: the `singularitySupervision` service a deployment exposes (the way `singularityEvolution` carries
 * the chain switch) over this plugin's own config, per member; a value that is not a usable count reads as its default.
 * These are the backstop a graph that runs no RSI loop runs under — a store whose graph declares its own round count is
 * answered through {@link improvementCapFor}.
 */
export function supervisionSettings(self: TaskRuntime): SupervisionConfig {
  const provided = self.softService<Partial<SupervisionConfig>>('singularitySupervision')
  const configured = self.config.supervision
  const whole = (value: number | undefined, fallback: number, floor: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= floor ? Math.floor(value) : fallback
  return {
    maxRecoveryRounds: whole(
      provided?.maxRecoveryRounds,
      whole(configured?.maxRecoveryRounds, DEFAULT_SUPERVISION.maxRecoveryRounds, 0),
      0,
    ),
    maxImprovementRounds: whole(
      provided?.maxImprovementRounds,
      whole(configured?.maxImprovementRounds, DEFAULT_SUPERVISION.maxImprovementRounds, 0),
      0,
    ),
    coordinationBudget: whole(
      provided?.coordinationBudget,
      whole(configured?.coordinationBudget, DEFAULT_SUPERVISION.coordinationBudget, 1),
      1,
    ),
  }
}

/**
 * The **improvement-round cap in force for one store**. The deployment policy is
 * the default (see {@link supervisionSettings}), but a store whose graph runs an
 * RSI loop declares its own round count through the same exposure
 * (`singularitySupervision.maxImprovementRoundsFor`, answered from the graph's
 * `rsi.iterationRounds`) — so a platform-scheduled loop may open exactly the
 * rounds its graph names, while every store without one keeps the deployment's
 * cap unchanged. An unusable answer reads as no answer: the policy stands.
 */
export function improvementCapFor(self: TaskRuntime, storeId: string): number {
  const specific = roundCapAnswer(self, 'maxImprovementRoundsFor', storeId)
  if (specific !== undefined) return specific
  return supervisionSettings(self).maxImprovementRounds
}

/**
 * The **recovery-round cap in force for one store**: the same graph-declared
 * round count as {@link improvementCapFor}. The platform RSI loop is the only
 * caller that opens a recovery any more, and a store whose graph schedules it
 * opens exactly the rounds its graph names; a store no graph declared keeps the
 * runtime's own constant.
 */
export function recoveryCapFor(self: TaskRuntime, storeId: string): number {
  const specific = roundCapAnswer(self, 'maxRecoveryRoundsFor', storeId)
  if (specific !== undefined) return specific
  return supervisionSettings(self).maxRecoveryRounds
}

/** One store's answer from the supervision exposure, or `undefined` when nothing usable is exposed. */
function roundCapAnswer(
  self: TaskRuntime,
  method: 'maxImprovementRoundsFor' | 'maxRecoveryRoundsFor',
  storeId: string,
): number | undefined {
  const provided = self.softService<{
    maxImprovementRoundsFor?: (storeId: string) => unknown
    maxRecoveryRoundsFor?: (storeId: string) => unknown
  }>('singularitySupervision')
  const specific = provided?.[method]?.(storeId)
  return typeof specific === 'number' && Number.isFinite(specific) && specific >= 0 ? Math.floor(specific) : undefined
}

export async function unload(self: TaskRuntime): Promise<void> {
  /**
   * The unload invalidates every recovery handle first (A2 §E): a driver
   * parked behind a barrier would otherwise hold the await below on a
   */
  for (const storeId of [...self.storeRecovery.keys()]) svcRootRecovery.invalidateStoreRecovery(self, storeId)
  self.storeRecovery.clear()
  const entries = [...self.drivers.values()]
  for (const entry of entries) entry.controller.abort()
  await Promise.all(
    entries.map(entry =>
      entry.promise.catch(error => {
        warn(self, `unload: a driver did not settle cleanly (${message(error)})`)
        return []
      }),
    ),
  )
  self.drivers.clear()
  for (const sessionId of self.startedSessions) self.executionGate.setTerminal(sessionId)
  try {
    await self.workspaces.close()
  } catch (error) {
    warn(self, `unload: workspace markers could not be released (${message(error)})`)
  }
}

export async function serviceInit(self: TaskRuntime): Promise<void> {
  await providerLoadReport(self)
  /**
   * The tool-execution gate's wiring (A3 §3.3): one decision per call before
   * anything runs, one settle per call when its result arrives. Both are
   */
  self.context.effect(() => {
    const offPre = self.context.on(
      'tools/pre-execute',
      async (exec, next) => {
        const sessionId = exec.agent?.id
        if (sessionId === undefined) return await next()
        const gatedName = exec.name === 'task_library' && typeof exec.arguments === 'object' && exec.arguments !== null && (exec.arguments as { action?: string }).action === 'read' ? 'task_read' : exec.name
        const decision = self.executionGate.decide(String(sessionId), gatedName)
        if (!decision.allow) return { kind: 'deny', reason: decision.reason }
        // Only an allowed call is registered: a denied call never runs, so
        // waiting for its result would wait for work that does not exist.
        self.executionGate.trackAllowed(String(sessionId), String(exec.callId), exec.name)
        return await next()
      },
      { prepend: true },
    )
    const offResult = self.context.on('tools/result', exec => {
      self.executionGate.settled(String(exec.callId))
    })
    return () => {
      // A minimal context (tests, a harness) may not hand back a disposer for
      // an event it never dispatches; that is not an error to raise at unload.
      if (typeof offPre === 'function') offPre()
      if (typeof offResult === 'function') offResult()
    }
  })
}

export async function providerLoadReport(self: TaskRuntime): Promise<ProviderLoadReport> {
  self.providerLoad ??= scanConfiguredProviders(self)
  return self.providerLoad
}

async function scanConfiguredProviders(self: TaskRuntime): Promise<ProviderLoadReport> {
  let report: ProviderLoadReport
  try {
    const precheck = await svcEnv.providerPrecheck(self, Object.keys(self.config.capabilities), { cwd: process.cwd() })
    report = { precheck, defects: providerDefectLines(precheck) }
  } catch (error) {
    report = { defects: [], failed: message(error) }
  }
  reportProviderLoad(self, report)
  return report
}

function reportProviderLoad(self: TaskRuntime, report: ProviderLoadReport): void {
  const roots = report.precheck?.roots ?? []
  if (report.failed !== undefined) {
    warn(
      self,
      `config load: the capability provider scan could not run (${report.failed}); the deployment starts, and admission ` +
        'still refuses a batch whose provider cannot be judged',
    )
    return
  }
  if (report.defects.length === 0) return
  warn(
    self,
    `config load: ${report.defects.length} provider defect${report.defects.length === 1 ? '' : 's'} in the effective capability table ` +
      `(roots: ${roots.join(', ')}); reported, not enforced — this process's own roots are not the worker's, so a skill ` +
      "reachable from a run's checkout may legitimately be missing here. Admission refuses a batch that names one of these.",
  )
  for (const line of report.defects) warn(self, `config load: ${line}`)
}

export function warn(self: TaskRuntime, message: string): void {
  const logger = (self.context as { logger?: (name: string) => { warn(format: string): void } }).logger
  logger?.('task-runtime').warn(message)
}

export function verifyTimeoutMs(self: TaskRuntime): number {
  return self.config.verifyTimeoutMs
}

export function budget(self: TaskRuntime): Readonly<BudgetConfig> {
  return { ...self.config.budget }
}

export function generatedTaskReview(self: TaskRuntime): 'off' | 'all' {
  return self.config.generatedTaskReview
}

export function gate(self: TaskRuntime): ExecutionGate {
  return self.executionGate
}

export function listCapabilities(self: TaskRuntime): Readonly<Record<string, CapabilityConfig>> {
  return structuredClone(self.config.capabilities)
}

