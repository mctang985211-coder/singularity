import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { assertClosedKeys, assertLosslessJson, digestOf } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { EvaluationWeights } from '../../src/measure/protocol.ts'
import type { BubbleTool } from '../../src/task/bubble.ts'
import type { TaskContract, VerifierCriterion } from '../../src/task/contract.ts'
import { sha256 } from './ids.ts'
import { list, record, text } from './shape.ts'

/** Raw domain observations stay separate from the calculator's aggregate score. */
export interface DomainMeasurementReport {
  readonly quality: number
  readonly metrics: Readonly<Record<string, { readonly value: number; readonly unit: string }>>
  readonly detail?: string
}
/** The candidate was measured but is ineligible; unavailable apparatus must still throw. */
export interface DomainMeasurementFailure {
  readonly status: 'business-failure'
  readonly reason: string
}
export type DomainMeasurementOutcome = number | DomainMeasurementReport | DomainMeasurementFailure
export interface DomainMeasurementContext {
  readonly taskId: string
  readonly runId: string
  readonly contract: TaskContract
}
export interface DomainMeasurement {
  readonly module: string
  readonly baseline: number
  readonly criterion: VerifierCriterion
  readonly unit: string
  readonly direction: 'higher' | 'lower'
  readonly tools: readonly BubbleTool[]
  readonly conditions: readonly string[]
  /** User-reviewed coefficients, reference values and formula documentation, without a core DSL. */
  readonly parameters?: Readonly<Record<string, unknown>>
  readonly evaluation?: { readonly weights: EvaluationWeights; readonly noiseFloor: number }
  measure(source: string, signal: AbortSignal, context?: DomainMeasurementContext): Promise<DomainMeasurementOutcome>
}

function finite(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) refuse('malformed-payload', `${where} must be finite`)
  return value
}

function reportOf(raw: unknown, baseline: number): DomainMeasurementOutcome {
  if (typeof raw === 'number') return finite(raw / baseline, 'domain measurement quality')
  const report = record(raw, 'domain measurement report')
  if (Object.hasOwn(report, 'status')) {
    assertClosedKeys(report, ['status', 'reason'], 'domain measurement failure', 'malformed-payload')
    if (report['status'] !== 'business-failure' || typeof report['reason'] !== 'string' || !report['reason'].trim())
      refuse('malformed-payload', 'measurement failure requires business-failure and a nonempty reason')
    return { status: 'business-failure', reason: report['reason'] }
  }
  assertClosedKeys(report, ['quality', 'metrics', 'detail'], 'domain measurement report', 'malformed-payload')
  const metrics = record(report['metrics'], 'domain measurement metrics')
  const values = Object.fromEntries(Object.entries(metrics).map(([name, raw]) => {
    if (!name.trim()) refuse('malformed-payload', 'measurement metric names must be nonempty')
    const metric = record(raw, `measurement metric ${name}`)
    assertClosedKeys(metric, ['value', 'unit'], `measurement metric ${name}`, 'malformed-payload')
    return [name, { value: finite(metric['value'], `measurement metric ${name}.value`), unit: text(metric, 'unit', `measurement metric ${name}`) }]
  }))
  if (report['detail'] !== undefined && typeof report['detail'] !== 'string') refuse('malformed-payload', 'measurement detail must be text')
  return { quality: finite(finite(report['quality'], 'domain measurement quality') / baseline, 'normalized domain quality'), metrics: values,
    ...(report['detail'] === undefined ? {} : { detail: report['detail'] as string }) }
}

export async function loadMeasurement(path: string): Promise<DomainMeasurement> {
  const moduleDigest = sha256(await readFile(path))
  const url = pathToFileURL(path)
  url.searchParams.set('implementation', moduleDigest)
  const module: unknown = await import(url.href)
  const ports = record(module, 'domain measurement')
  if (typeof ports['describe'] !== 'function' || typeof ports['measure'] !== 'function')
    refuse('malformed-declaration', 'domain measurement must export describe and measure functions')
  const description: unknown = await ports['describe']()
  const declared = record(description, 'measurement description')
  assertClosedKeys(declared, ['baseline', 'digest', 'tools', 'conditions', 'unit', 'direction', 'parameters', 'evaluation'], 'measurement description', 'malformed-declaration',
  )
  const baseline = declared['baseline']
  if (typeof baseline !== 'number' || !Number.isFinite(baseline) || baseline <= 0)
    refuse('malformed-declaration', 'measurement baseline must be a finite positive value')
  const digest = text(declared, 'digest', 'measurement description')
  if (!/^[a-f0-9]{64}$/.test(digest)) refuse('malformed-declaration', 'measurement implementation digest must be sha256')
  const direction = text(declared, 'direction', 'measurement description')
  if (direction !== 'higher' && direction !== 'lower') refuse('malformed-declaration', 'measurement direction must be higher or lower')
  const tools = list(declared['tools'], 'measurement tools').map((raw, index) => {
    const tool = record(raw, `measurement tools[${index}]`)
    assertClosedKeys(tool, ['name', 'version', 'implementationDigest'], 'measurement tool', 'malformed-declaration')
    return { name: text(tool, 'name', 'measurement tool'), version: text(tool, 'version', 'measurement tool'),
      implementationDigest: text(tool, 'implementationDigest', 'measurement tool'),
    }
  })
  const conditions = list(declared['conditions'], 'measurement conditions').map((raw) => {
    if (typeof raw !== 'string') refuse('malformed-declaration', 'measurement conditions must be strings')
    return raw
  })
  const parameters = declared['parameters'] === undefined ? undefined : record(declared['parameters'], 'measurement parameters')
  if (parameters !== undefined) assertLosslessJson(parameters, 'measurement parameters')
  let evaluation: DomainMeasurement['evaluation']
  if (declared['evaluation'] !== undefined) {
    const policy = record(declared['evaluation'], 'measurement evaluation')
    assertClosedKeys(policy, ['weights', 'noiseFloor'], 'measurement evaluation', 'malformed-declaration')
    const weights = record(policy['weights'], 'measurement weights')
    assertClosedKeys(weights, ['quality', 'cost'], 'measurement weights', 'malformed-declaration')
    if (typeof weights['quality'] !== 'number' || !Number.isFinite(weights['quality']) || weights['quality'] <= 0 ||
      typeof weights['cost'] !== 'number' || !Number.isFinite(weights['cost']) || weights['cost'] < 0 ||
      typeof policy['noiseFloor'] !== 'number' || !Number.isFinite(policy['noiseFloor']) || policy['noiseFloor'] < 0)
      refuse('malformed-declaration', 'measurement weights require positive quality, nonnegative cost and nonnegative finite noiseFloor')
    evaluation = { weights: { quality: weights['quality'], cost: weights['cost'] }, noiseFloor: policy['noiseFloor'] }
  }
  // Bind both the actual calculator bytes and its declared apparatus/coefficients. A formula with
  // changed weights is a new measurement even when its external tool digest did not change.
  if (sha256(await readFile(path)) !== moduleDigest)
    refuse('malformed-declaration', 'measurement module changed while loading; freeze it before evaluation')
  const implementationDigest = digestOf({ module: moduleDigest, description: declared })
  const measure = ports['measure'] as (source: string, signal: AbortSignal, context?: DomainMeasurementContext) => Promise<unknown>
  return { module: path, baseline, direction, tools, conditions, unit: text(declared, 'unit', 'measurement description'),
    ...(parameters === undefined ? {} : { parameters: JSON.parse(JSON.stringify(parameters)) as Record<string, unknown> }),
    ...(evaluation === undefined ? {} : { evaluation }),
    criterion: { criterionId: 'domain-quality', statement: 'Measure the submitted implementation under the frozen domain apparatus',
      verifierRef: 'domain-measurement', verifierVersion: '1', implementationDigest,
    },
    measure: async (source, signal, context) => {
      signal.throwIfAborted()
      const value = await measure(source, signal, context)
      signal.throwIfAborted()
      return reportOf(value, baseline)
    },
  }
}
