import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import type { VerifierProcess } from '../../src/verifier/command.ts'
import { loadDomain } from '../src/domain.ts'
import { sha256 } from '../src/ids.ts'
import { spawnProcess } from '../src/process.ts'

const DIR = fileURLToPath(new URL('../../deployment/domain/sha256', import.meta.url))
const MEASUREMENT = new URL('../../deployment/domain/sha256/measurement.mjs', import.meta.url).href
const SEED_DIGEST = '0b4de636364625e34e771bb26363d24f4a4bcae6579d0f8cd3e86d7e5c14354a'
const runProcess: VerifierProcess = async () => { throw new Error('loading a declaration must not run a process') }
const domain = await loadDomain(DIR, runProcess)
const template = domain.templates.get(domain.rootTemplate)!

it('declares a real area root and a schedule-to-integration chain with independent acceptance', () => {
  expect(domain.rootTemplate).toBe('sha256-area')
  expect([...domain.templates.keys()]).toEqual(['sha256-area', 'sha256-schedule', 'sha256-integration'])
  expect(domain.templates.get('sha256-schedule')!.input.source).toEqual({ kind: 'protected', ref: 'requirements' })
  expect(domain.templates.get('sha256-integration')!.input.source).toEqual({ kind: 'artifact', template: 'sha256-schedule' })
  expect(domain.verifiers.map(verifier => verifier.ref)).toEqual(['core-functional', 'w-schedule', 'core-integration'])
  expect(new Set([...domain.templates.values()].map(template => template.criterion.criterionId)).size).toBe(3)
})

it('starts the source template at the upstream module bytes and judges the submitted source itself', () => {
  expect([template.submission, template.file, template.artifact, sha256(template.initial!.bytes)])
    .toEqual(['source', 'rtl/sha256_w_mem.v', 'rtl/sha256_w_mem.v', SEED_DIGEST])
})

it('binds the protected requirement, upstream seed and fixed apparatus to the root', () => {
  const source = template.input.source
  expect(source).toEqual({ kind: 'protected', ref: 'requirements' })
  const input = domain.inputs.find(input => input.ref === 'requirements')!
  const declared = JSON.parse(Buffer.from(input.bytes).toString('utf8'))
  expect(declared.upstream.commit).toBe('837c5cc396f001d18f2c765721c585716eb439ae')
  expect(sha256(declared.seed.source)).toBe(SEED_DIGEST)
  expect(declared.editable).toEqual(['sha256_w_mem.v'])
  expect(declared.preserve).toEqual(['ports', 'reset', 'SHA224', 'SHA256', 'cycle timing'])
  expect(template.verifier.selftest.samples[0]!.input.inputs).toEqual([{ name: template.input.name, digest: input.digest }])
  expect(template.input.name).toBe('protected.json')
})

it('each independent verifier accepts the upstream source and rejects its declared bad samples', async () => {
  const live = await loadDomain(DIR, spawnProcess)
  for (const verifier of live.verifiers) {
    for (const sample of verifier.selftest.samples) {
      const outcome = await verifier.judge(sample.input)
      expect(outcome.verdict, `${verifier.ref}: ${sample.name}: ${outcome.detail}`).toBe(sample.expected)
    }
  }
}, 60_000)

it('loads the frozen tools and measures normalized complete top area through the public domain port', async () => {
  const measurement = await import(MEASUREMENT)
  const declared = await measurement.describe()
  expect(declared).toMatchObject({ baselineArea: 64858.4544, unit: 'um2', direction: 'lower' })
  expect(declared.digest).toMatch(/^[0-9a-f]{64}$/)
  expect(declared.tools.map((tool: { name: string }) => tool.name)).toEqual(['iverilog', 'vvp', 'yosys', 'abc', 'sky130hd'])
  expect(domain.measurement).toMatchObject({ baseline: declared.baselineArea, tools: declared.tools, conditions: declared.conditions,
    criterion: { implementationDigest: declared.digest }, unit: declared.unit, direction: declared.direction })
  expect(await domain.measurement!.measure(Buffer.from(template.initial!.bytes).toString('utf8'), new AbortController().signal)).toBeCloseTo(1, 8)
  expect(declared.baselineArea).toBeGreaterThan(35163.7248 + 27689.056)
}, 60_000)

it('aborts area measurement through its explicit signal', async () => {
  const measurement = await import(MEASUREMENT)
  const controller = new AbortController()
  controller.abort(new Error('cancel the real synthesis'))
  await expect(measurement.measure(Buffer.from(template.initial!.bytes).toString('utf8'), controller.signal))
    .rejects.toThrow('cancel the real synthesis')
})

it('reports synthesis failure without fabricating an area', async () => {
  const measurement = await import(MEASUREMENT)
  await expect(measurement.measure('module sha256_w_mem; this is not RTL; endmodule')).rejects.toThrow()
})
