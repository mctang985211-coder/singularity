/**
 * Runtime lifecycle: construction, provider load, capability rows and gates.
 */

import type { TaskRuntime } from './runtime.ts'
import { dirname, resolve } from 'node:path'
import type { CapabilityManifest } from '@dangosys/dsh-singularity-task'
import { resolveCapabilities, type CapabilityConfig } from '../capability.ts'
import { ExecutionGate } from '../gate.ts'
import { message } from '../helpers.ts'
import { precheckReplacedCapabilityRow, providerDefectLines } from '../provider-precheck.ts'
import type { EvolutionCommitLedger } from '../provider-precheck.ts'
import type { RootBudgetConfig } from '../root-budget.ts'
import type { BudgetConfig } from '../orchestration/types.ts'
import type { ProviderLoadReport } from '../config.ts'

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

export async function unload(self: TaskRuntime): Promise<void> {
  /**
   * The unload invalidates every recovery handle first (A2 §E): a driver
   * parked behind a barrier would otherwise hold the await below on a
   */
  for (const storeId of [...self.storeRecovery.keys()]) self.invalidateStoreRecovery(storeId)
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
        const decision = self.executionGate.decide(String(sessionId), exec.name)
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

export async function scanConfiguredProviders(self: TaskRuntime): Promise<ProviderLoadReport> {
  let report: ProviderLoadReport
  try {
    const precheck = await self.providerPrecheck(Object.keys(self.config.capabilities), { cwd: process.cwd() })
    report = { precheck, defects: providerDefectLines(precheck) }
  } catch (error) {
    report = { defects: [], failed: message(error) }
  }
  reportProviderLoad(self, report)
  return report
}

export function reportProviderLoad(self: TaskRuntime, report: ProviderLoadReport): void {
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

export function resolveCapabilitiesImpl(self: TaskRuntime, required: readonly string[]): CapabilityManifest {
  return resolveCapabilities(required, self.config.capabilities)
}

export function listCapabilities(self: TaskRuntime): Readonly<Record<string, CapabilityConfig>> {
  return structuredClone(self.config.capabilities)
}

export async function applyCapabilityRow(
  self: TaskRuntime,
  name: string,
  entry: CapabilityConfig | null,
  options: { commitTargets?: readonly string[]; commitRow?: string } = {},
): Promise<void> {
  if (entry === null) {
    const rest = { ...self.config.capabilities }
    delete rest[name]
    self.config.capabilities = rest
    return
  }
  await assertReplacementRow(self, name, entry, options)
  self.config.capabilities = { ...self.config.capabilities, [name]: structuredClone(entry) }
}

export async function assertReplacementRow(
  self: TaskRuntime,
  name: string,
  entry: CapabilityConfig,
  options: { commitTargets?: readonly string[]; commitRow?: string } = {},
): Promise<void> {
  const verifierRefs = await self.registeredVerifierIds()
  const ledger = self.softService<EvolutionCommitLedger>('evolution')
  const owned = new Set((options.commitTargets ?? []).map(target => dirname(resolve(target))))
  const exemptRow = options.commitRow
  const commitLedger =
    ledger === undefined || (owned.size === 0 && exemptRow === undefined)
      ? ledger
      : {
          ...(ledger.openIntentTargets === undefined
            ? {}
            : {
                openIntentTargets: async () =>
                  (await ledger.openIntentTargets!()).filter(target => !owned.has(dirname(resolve(target)))),
              }),
          ...(ledger.openIntentCapabilities === undefined
            ? {}
            : {
                openIntentCapabilities: async () =>
                  (await ledger.openIntentCapabilities!()).filter(row => row !== exemptRow),
              }),
        }
  const { refusals } = await precheckReplacedCapabilityRow({
    name,
    entry,
    table: self.config.capabilities,
    // The deployment's own viewpoint, the same one the evolution gate and the
    // load-time report ask from: this process knows its own skill roots.
    view: { cwd: process.cwd() },
    ...(verifierRefs === undefined ? {} : { verifierRefs }),
    ...(commitLedger === undefined ? {} : { commitLedger }),
  })
  if (refusals.length === 0) return
  throw new Error(
    `task-runtime: capability "${name}" was not replaced — the row grants providers that are not usable:\n` +
      refusals.map(line => `- ${line}`).join('\n'),
  )
}
