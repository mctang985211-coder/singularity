import { pathToFileURL } from 'node:url'
import { assertClosedKeys } from '../../src/protocol/envelope.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { BubbleTool } from '../../src/task/bubble.ts'
import type { AcceptanceCriterion } from '../../src/task/contract.ts'
import { list, record, text } from './shape.ts'

export interface DomainMeasurement {
  readonly module: string
  readonly baseline: number
  readonly criterion: AcceptanceCriterion
  readonly unit: string
  readonly direction: 'higher' | 'lower'
  readonly tools: readonly BubbleTool[]
  readonly conditions: readonly string[]
  measure(source: string, signal: AbortSignal): Promise<number>
}

export async function loadMeasurement(path: string): Promise<DomainMeasurement> {
  const module: unknown = await import(pathToFileURL(path).href)
  const ports = record(module, 'domain measurement')
  if (typeof ports['describe'] !== 'function' || typeof ports['measure'] !== 'function')
    refuse('malformed-declaration', 'domain measurement must export describe and measure functions')
  const description: unknown = await ports['describe']()
  const declared = record(description, 'measurement description')
  assertClosedKeys(declared, ['baselineArea', 'digest', 'tools', 'conditions', 'unit', 'direction'], 'measurement description', 'malformed-declaration')
  const baseline = declared['baselineArea']
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
      implementationDigest: text(tool, 'implementationDigest', 'measurement tool') }
  })
  const conditions = list(declared['conditions'], 'measurement conditions').map(raw => {
    if (typeof raw !== 'string') refuse('malformed-declaration', 'measurement conditions must be strings')
    return raw
  })
  const measure = ports['measure'] as (source: string, signal: AbortSignal) => Promise<unknown>
  return { module: path, baseline, direction, tools, conditions, unit: text(declared, 'unit', 'measurement description'),
    criterion: { criterionId: 'domain-quality', statement: 'Measure the submitted implementation under the frozen domain apparatus',
      verifierRef: 'domain-measurement', verifierVersion: '1', implementationDigest: digest },
    measure: async (source, signal) => {
      const value = await measure(source, signal)
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        refuse('malformed-payload', 'domain measurement did not produce a finite positive value')
      return value / baseline
    } }
}
