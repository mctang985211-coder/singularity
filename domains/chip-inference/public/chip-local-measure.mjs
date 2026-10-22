// Public local measurement Tool used by the initial Method.
//
// The tool only drives the frozen public evaluator; it accepts no candidate-
// reported PPA and does not write into the source tree. The score comes from
// public/score.mjs, which is also imported by the domain measurement module.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function main() {
  const paths = process.argv.slice(2)
  if (paths.length < 2) throw new Error('Pass the frozen workload input and the candidate path to chip-local-measure')
  const workloadPath = resolve(paths[0])
  const candidate = resolve(paths.at(-1))
  const workload = JSON.parse((await readFile(workloadPath)).toString('utf8'))
  if (typeof workload.caseId !== 'string' || workload.caseId.length === 0) throw new Error('workload has no caseId')
  const manifest = JSON.parse(await readFile(resolve(ROOT, 'external-tools.json'), 'utf8'))
  const policy = JSON.parse(await readFile(resolve(ROOT, 'scoring-policy.json'), 'utf8'))
  const references = JSON.parse(await readFile(resolve(ROOT, 'public/references.json'), 'utf8'))
  const reference = references[workload.caseId]
  if (reference === undefined) throw new Error('no frozen baseline reference for ' + workload.caseId)
  const { contributions } = await import(pathToFileURL(resolve(ROOT, 'public/score.mjs')).href)

  let stdout
  try {
    ;({ stdout } = await promisify(execFile)(manifest.python,
      [resolve(ROOT, 'public/evaluate.py'), candidate, workload.caseId, '--workload', workloadPath],
      { timeout: 160000, maxBuffer: 2 * 1024 * 1024 }))
  } catch (error) {
    if (error.code === 1) {
      let failure
      try { failure = JSON.parse(String(error.stdout ?? '')) } catch { throw error }
      if (failure.status === 'fail' && typeof failure.detail === 'string') {
        process.stdout.write(JSON.stringify({
          status: 'fail', quality: 0, guards: false, caseId: workload.caseId,
          detail: failure.detail, evidenceScope: 'Local RTL and pre-layout cell estimates only; invalid candidate is not scored.',
        }) + '\n')
        return
      }
    }
    throw error
  }
  const observed = JSON.parse(stdout)
  const sourceBytes = await readFile(candidate)
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  if (observed.sourceSha256 !== sourceSha256) throw new Error('evaluator measured different candidate bytes')
  if (observed.caseId !== workload.caseId) throw new Error('evaluator measured a different frozen case')
  const c = contributions(observed, reference, policy.weights)
  process.stdout.write(JSON.stringify({
    ...observed,
    latency_ns: c.latencyNs,
    quality: c.quality,
    ratios: { latency: c.latencyRatio, area: c.areaRatio },
    contributions: { latency: c.latencyContribution, area: c.areaContribution, logScore: c.logScore },
    evidenceScope: 'Local INT8 operator only: module Verilator + mapped Yosys cell area + ideal-clock OpenSTA. Pre-layout, not routed silicon PPA; not model inference. Default-activity power is unscored.',
  }) + '\n')
}

await main()
