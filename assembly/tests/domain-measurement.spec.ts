import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { loadMeasurement } from '../src/domain-measurement.ts'

const scratch: string[] = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
const description = {
  baseline: 1,
  digest: 'a'.repeat(64),
  tools: [],
  conditions: ['fixed reference'],
  unit: 'score',
  direction: 'higher',
}
async function calculator(declared: unknown, implementation = 'return Number(source)') {
  const dir = await mkdtemp(join(tmpdir(), 'domain-calculator-'))
  scratch.push(dir)
  const path = join(dir, 'measurement.mjs')
  await writeFile(
    path,
    `export const describe = () => (${JSON.stringify(declared)});\nexport async function measure(source, signal, context) { ${implementation} }\n`,
  )
  return loadMeasurement(path)
}

it('runs a user-defined weighted calculator and retains raw physical observations and units', async () => {
  const measurement = await calculator(
    {
      ...description,
      baseline: 2,
      parameters: {
        weights: { area: 0.35, delay: 0.65 },
        references: { area: 100, delay: 10 },
        formula: 'weighted normalized improvement',
      },
      evaluation: { weights: { quality: 1, cost: 0 }, noiseFloor: 0.005 },
    },
    `
    const { area, delay } = JSON.parse(source);
    return { quality: .35 * (100 / area) + .65 * (10 / delay),
      metrics: { area: { value: area, unit: 'um2' }, delay: { value: delay, unit: 'ns' } }, detail: context.contract.goal };
  `,
  )
  expect(measurement.evaluation).toEqual({ weights: { quality: 1, cost: 0 }, noiseFloor: 0.005 })
  expect(measurement.parameters).toMatchObject({ weights: { area: 0.35, delay: 0.65 } })
  const result = await measurement.measure('{"area":50,"delay":5}', new AbortController().signal, {
    taskId: 't',
    runId: 'r',
    contract: {
      goal: 'case-local goal',
      artifact: 'design.v',
      inputs: [],
      criteria: [{ criterionId: 'correct', statement: 'correct' }],
    },
  })
  expect(result).toEqual({
    quality: 1,
    metrics: { area: { value: 50, unit: 'um2' }, delay: { value: 5, unit: 'ns' } },
    detail: 'case-local goal',
  })
})

it('accepts finite zero and signed scores while preserving scalar baseline normalization', async () => {
  const measurement = await calculator({ ...description, baseline: 2 })
  for (const [source, expected] of [
    ['0', 0],
    ['-2', -1],
    ['3', 1.5],
  ] as const)
    expect(await measurement.measure(source, new AbortController().signal)).toBe(expected)
})

it('distinguishes a measured but physically ineligible candidate from unavailable apparatus', async () => {
  const measurement = await calculator(
    description,
    `
    if (source === 'valid-numeric-unsynthesizable') return { status: 'business-failure', reason: 'DC rejected a nonsynthesizable candidate construct' };
    throw Error('EDA tool unavailable');
  `,
  )
  expect(await measurement.measure('valid-numeric-unsynthesizable', new AbortController().signal)).toEqual({
    status: 'business-failure',
    reason: 'DC rejected a nonsynthesizable candidate construct',
  })
  await expect(measurement.measure('missing-tool', new AbortController().signal)).rejects.toThrow(
    'EDA tool unavailable',
  )
})

it('binds calculator bytes and reviewed parameters into the measurement identity', async () => {
  const first = await calculator({ ...description, parameters: { weights: { area: 0.35, delay: 0.65 } } })
  const same = await calculator({ ...description, parameters: { weights: { area: 0.35, delay: 0.65 } } })
  const changed = await calculator({ ...description, parameters: { weights: { area: 0.5, delay: 0.5 } } })
  const code = await calculator(
    { ...description, parameters: { weights: { area: 0.35, delay: 0.65 } } },
    'return Number(source) + 1',
  )
  expect(same.criterion.implementationDigest).toBe(first.criterion.implementationDigest)
  expect(changed.criterion.implementationDigest).not.toBe(first.criterion.implementationDigest)
  expect(code.criterion.implementationDigest).not.toBe(first.criterion.implementationDigest)
})

it('reloads changed calculator bytes instead of attributing an ESM cached implementation to a new digest', async () => {
  const first = await calculator(description)
  await writeFile(
    first.module,
    `export const describe = () => (${JSON.stringify(description)});\nexport const measure = async () => 7;\n`,
  )
  const changed = await loadMeasurement(first.module)
  expect(changed.criterion.implementationDigest).not.toBe(first.criterion.implementationDigest)
  expect(await changed.measure('1', new AbortController().signal)).toBe(7)
})

it.each([
  'return NaN',
  'return { quality: Infinity, metrics: {} }',
  'return { quality: 1, metrics: { area: { value: NaN, unit: "um2" } } }',
  'return { quality: 1, metrics: { area: { value: 1, unit: "um2", estimated: true } } }',
  'return { quality: 1, metrics: {}, unrelated: true }',
  'return { quality: 1, metrics: {}, detail: {} }',
  'return { status: "business-failure", reason: "synthesis failed", quality: 0 }',
  'return { status: "business-failure", reason: "synthesis failed", metrics: {} }',
  'return { status: "business-failure", reason: " " }',
  'return { status: "infrastructure-failure", reason: "EDA unavailable" }',
])('rejects malformed calculator output: %s', async implementation => {
  const measurement = await calculator(description, implementation)
  expect(await asyncRefusalOf(() => measurement.measure('1', new AbortController().signal))).toMatchObject({
    code: 'malformed-payload',
  })
})

it.each([
  { weights: { quality: 0, cost: 0 }, noiseFloor: 0 },
  { weights: { quality: 1, cost: -1 }, noiseFloor: 0 },
  { weights: { quality: 1, cost: 0 }, noiseFloor: -1 },
  { weights: { quality: 1, cost: 0, area: 1 }, noiseFloor: 0 },
])('rejects an invalid user-reviewed evaluation policy', async evaluation => {
  expect(await asyncRefusalOf(() => calculator({ ...description, evaluation }))).toMatchObject({
    code: 'malformed-declaration',
  })
})

it('honors cancellation even if the calculator returns a number after being cancelled', async () => {
  const measurement = await calculator(description, 'globalThis.abortCalculator(); return 1')
  const controller = new AbortController()
  const globals = globalThis as typeof globalThis & { abortCalculator?: () => void }
  globals.abortCalculator = () => controller.abort(new Error('measurement cancelled'))
  try {
    await expect(measurement.measure('1', controller.signal)).rejects.toThrow('measurement cancelled')
  } finally {
    delete globals.abortCalculator
  }
})
