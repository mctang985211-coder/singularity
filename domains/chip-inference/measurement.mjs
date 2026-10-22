// Domain-owned measurement adapter. The arithmetic lives in public/score.mjs so
// the worker feedback Tool and the sealed measurement use exactly one formula.
import { createHash } from 'node:crypto'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertWeights,
  calculate as scoreCalculate,
  contributions as scoreContributions,
} from '../public/score.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = JSON.parse(await readFile(new URL('../external-tools.json', import.meta.url), 'utf8'))
const parameters = JSON.parse(await readFile(new URL('../scoring-policy.json', import.meta.url), 'utf8'))
const references = JSON.parse(await readFile(new URL('../private-oracle/references.json', import.meta.url), 'utf8'))
assertWeights(parameters.weights)
if (typeof parameters.noiseFloor !== 'number' || !Number.isFinite(parameters.noiseFloor) || parameters.noiseFloor < 0)
  throw new Error('scoring-policy noiseFloor must be a nonnegative finite number')

const apparatusPaths = [
  '../public/evaluate.py',
  '../public/oracle.cpp',
  '../public/score.mjs',
  '../public/chip-local-measure.mjs',
  '../public/references.json',
  '../private-oracle/references.json',
  '../external-tools.json',
  '../scoring-policy.json',
  '../model-specs/provenance.json',
  './task.json',
  './suite.json',
  './verifier.mjs',
  './inputs/accelerator.sv',
  ...Object.keys(references).sort().map(key => `./inputs/${key}.json`),
]

async function apparatusDigest() {
  const rows = []
  for (const path of apparatusPaths) rows.push([path, hash(await readFile(new URL(path, import.meta.url)))])
  return hash(JSON.stringify(rows))
}

export async function describe() {
  return {
    baseline: 1,
    unit: 'relative-score',
    direction: 'higher',
    digest: await apparatusDigest(),
    tools: manifest.files.map(tool => ({
      name: tool.name,
      version: manifest.versions[tool.name] ?? manifest.technology.corner,
      implementationDigest: tool.sha256,
    })),
    conditions: [
      'Same-family local INT8 dot-product PE pilot. All eight cases share one accelerator responsibility lineage; this is not domain transfer, model inference or checkpoint execution.',
      'Independent C++ signed-byte reference; arbitrary source is recomputed in a fresh module-level Verilator build using the protected workload bytes. Yosys maps standard cells and OpenSTA estimates setup timing at SKY130 HD TT 1.8V 25C.',
      'No physical placement/routing, SRAM/macros, clock tree, SoC, attention, model lowering, checkpoint, audio quality or measured-silicon claim is in scope.',
      'Default-activity OpenSTA power is diagnostic only and has zero score weight. It is not workload activity, energy or complete PPA.',
      'The candidate is remeasured in a new temporary directory with the frozen evaluator; no candidate-reported PPA is accepted.',
    ],
    parameters: { ...parameters, references },
    evaluation: { weights: { quality: 1, cost: 0 }, noiseFloor: parameters.noiseFloor },
  }
}

export function calculate(observed, reference) {
  return scoreCalculate(observed, reference, parameters.weights)
}

export function contributions(observed, reference) {
  return scoreContributions(observed, reference, parameters.weights)
}

export async function measure(source, signal, context) {
  signal.throwIfAborted()
  const sourceIdentity = context?.contract?.inputs?.find(input => input.name === 'inputs/workload.json')?.source
  const key = sourceIdentity?.ref?.replace(/-workload$/, '')
  const reference = key === undefined ? undefined : references[key]
  if (key === undefined || reference === undefined)
    throw new Error('measurement requires a frozen case workload ref')
  if (sourceIdentity.kind !== 'protected') throw new Error('measurement workload must be a protected input')
  const workloadPath = fileURLToPath(new URL(`./inputs/${key}.json`, import.meta.url))
  const workloadBytes = await readFile(workloadPath)
  const inputSha256 = hash(workloadBytes)
  if (inputSha256 !== sourceIdentity.digest || inputSha256 !== reference.inputDigest)
    throw new Error('measurement workload bytes differ from the frozen case identity')
  const workload = JSON.parse(workloadBytes.toString('utf8'))
  if (workload.caseId !== key) throw new Error('frozen workload caseId differs from its reference key')
  const sourceSha256 = hash(Buffer.from(source, 'utf8'))

  const temp = await mkdtemp(join(tmpdir(), 'singularity-chip-measure-'))
  try {
    const artifact = join(temp, 'accelerator.sv')
    await writeFile(artifact, source)
    let stdout
    try {
      ;({ stdout } = await promisify(execFile)(manifest.python,
        [fileURLToPath(new URL('../public/evaluate.py', import.meta.url)), artifact, key, '--workload', workloadPath],
        { signal, timeout: 160000, maxBuffer: 2 * 1024 * 1024 }))
    } catch (error) {
      if (error.code === 1) {
        let failure
        try { failure = JSON.parse(String(error.stdout ?? '')) } catch { throw error }
        if (failure.status === 'fail' && typeof failure.detail === 'string')
          return { status: 'business-failure', reason: failure.detail }
      }
      throw error
    }
    const result = JSON.parse(stdout)
    if (result.status !== undefined) throw new Error('evaluator returned no successful measurement: ' + JSON.stringify(result))
    if (result.caseId !== key) throw new Error('evaluator measured a different frozen case')
    if (result.sourceSha256 !== sourceSha256) throw new Error('evaluator measured different candidate bytes')
    const c = scoreContributions(result, reference, parameters.weights)
    return {
      quality: c.quality,
      metrics: {
        cycles: { value: c.cycles, unit: 'cycles' },
        area: { value: c.areaUm2, unit: 'um^2' },
        criticalPeriod: { value: c.criticalPeriodNs, unit: 'ns' },
        latency: { value: c.latencyNs, unit: 'ns' },
        latencyContribution: { value: c.latencyContribution, unit: 'ln-ratio-weighted' },
        areaContribution: { value: c.areaContribution, unit: 'ln-ratio-weighted' },
        quality: { value: c.quality, unit: 'relative-score' },
        ...(result.default_activity_power_w === undefined ? {} : {
          defaultActivityPower: { value: result.default_activity_power_w, unit: 'W-estimated-unscored' },
        }),
      },
      detail: 'Recomputed ' + key + '; source=' + result.sourceSha256
        + '; latencyLogContribution=' + String(c.latencyContribution)
        + '; areaLogContribution=' + String(c.areaContribution)
        + '; arithmetic, short-dot and backpressure checks passed.'
        + ' Pre-layout library estimates; default-activity power excluded.',
    }
  } finally { await rm(temp, { recursive: true, force: true }) }
}
