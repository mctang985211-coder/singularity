import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import type { ExperimentView, ExperimentLedger } from './freeze.ts'
import type { OutcomeModelCall } from './spec.ts'
import type { ExperimentReport, OutcomeMeasurement } from '../replay.ts'
import { canonicalJson, parseOutcomeJudgement, assertOutcomeEvaluation } from '../replay.ts'
import { buildExperimentReport, directoryDigest } from './record.ts'

const OUTPUT_LIMIT = 1024 * 1024

async function measure(command: string, cwd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  signal?.throwIfAborted()
  return new Promise((resolveResult, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const sizes = { stdout: 0, stderr: 0 }
    let failure: Error | undefined
    const stop = (error: Error) => {
      failure ??= error
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error) }
      }
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        sizes[stream] += chunk.length
        if (sizes[stream] > OUTPUT_LIMIT) stop(new Error(`evolution: measurement ${stream} exceeded 1 MiB; no truncated evidence was accepted`))
        else output[stream].push(chunk)
      })
    }
    const abort = () => stop(new Error('evolution: outcome measurement cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timeout = setTimeout(() => stop(new Error('evolution: outcome measurement exceeded 300s')), 300_000)
    child.once('error', error => { failure = error })
    child.once('close', (code, killedBy) => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (failure !== undefined) reject(failure)
      else if (code === null) reject(new Error(`evolution: outcome measurement terminated by ${killedBy}`))
      else resolveResult({ stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'), exitCode: code })
    })
  })
}

/** One saved input and one independent model response. Published judgements are never sampled again. */
export async function judgeExperiment(input: {
  ledger: ExperimentLedger
  view: ExperimentView
  snapshot: TaskSnapshot
  actor: string
  judge?: OutcomeModelCall
  signal?: AbortSignal
}): Promise<void> {
  const { ledger, view, snapshot } = input
  if (view.frozen.objective !== 'llm-outcome' || view.judged !== undefined) return
  const plan = view.frozen.evaluation!
  if (input.judge === undefined || ledger.recordExperimentJudged === undefined)
    throw new Error('evolution: llm-outcome needs the independent model caller and durable judgement writer')
  const report = buildExperimentReport(view)
  const samples = report.samples.map(({ verdict: _verdict, ...sample }) => sample)
  const directory = dirname(view.report)
  const evidencePath = `${directory}/outcome-input.json`
  const responsePath = resolve(ledger.root, `${directory}/outcome-response.json`)
  await mkdir(resolve(ledger.root, directory), { recursive: true })
  // A crash leaves this marker. Unknown executions/responses must not be silently repeated.
  let existingResponse: string | undefined
  try { existingResponse = await readFile(responsePath, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let fixedInput: string
  if (existingResponse !== undefined) {
    fixedInput = await readFile(resolve(ledger.root, evidencePath), 'utf8')
  } else {
    try { await writeFile(resolve(ledger.root, `${directory}/outcome.pending`), view.frozenDigest, { flag: 'wx' }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('evolution: measurement or judgement has an unknown interrupted result; use a new repetition rather than silently rerunning it')
      throw error
    }
    const measurements: OutcomeMeasurement[] = []
    for (const sample of samples) {
      for (const side of ['baseline', 'candidate'] as const) {
        const detail = sample[side]
        for (const measurement of plan.measurements) {
          const result = await measure(measurement.command, detail.workspace, input.signal)
          measurements.push({
            ref: `${sample.taskId}/${side}/${measurement.id}`,
            sampleTaskId: sample.taskId,
            side,
            id: measurement.id,
            command: measurement.command,
            workspace: detail.workspace,
            workspaceDigest: await directoryDigest(detail.workspace),
            ...result,
          })
        }
      }
    }
    // Freeze the final measured workspace, including files a measurement itself produced.
    for (const measurement of measurements) measurement.workspaceDigest = await directoryDigest(measurement.workspace)
    const contracts = view.frozen.samples.map(sample => {
      const task = snapshot.tasks.find(item => item.taskId === sample.taskId)!
      return { taskId: task.taskId, objective: task.objective, acceptanceCriteria: task.acceptanceCriteria }
    })
    fixedInput = canonicalJson({ frozenDigest: view.frozenDigest, plan, contracts, samples, measurements })
    await writeFile(resolve(ledger.root, evidencePath), fixedInput, { flag: 'wx' })
    existingResponse = await input.judge(plan.judge.model, plan.judge.prompt, fixedInput, input.signal)
    await writeFile(responsePath, existingResponse, { flag: 'wx' })
  }
  const evaluation = {
    input: fixedInput,
    inputDigest: sha256Hex(fixedInput),
    evidencePath,
    evidenceDigest: sha256Hex(fixedInput),
    response: existingResponse,
    responseDigest: sha256Hex(existingResponse),
    judgement: parseOutcomeJudgement(existingResponse, fixedInput),
  }
  // Validate before append; the fold also checks this response against its frozen side facts.
  assertOutcomeEvaluation(evaluation)
  await ledger.recordExperimentJudged({
    formatVersion: 4,
    kind: 'experiment_judged',
    proposalId: view.proposalId,
    experimentId: view.experimentId,
    evaluation,
    actor: input.actor,
    at: new Date().toISOString(),
  })
}

/** Gate/apply consumes the saved judgement and the exact measured files, without invoking a model or command. */
export async function assertOutcomeEvidence(root: string, report: ExperimentReport): Promise<void> {
  if (report.frozen.objective !== 'llm-outcome') return
  const evaluation = report.evaluation
  if (evaluation === undefined) throw new Error('evolution: llm-outcome experiment has no saved independent judgement')
  const expectedDirectory = `sandbox/${report.proposalId}/exp-${report.experimentId}`
  if (evaluation.evidencePath !== `${expectedDirectory}/outcome-input.json`)
    throw new Error('evolution: outcome evidence path is outside this experiment')
  const evidence = await readFile(resolve(root, evaluation.evidencePath), 'utf8')
  const response = await readFile(resolve(root, expectedDirectory, 'outcome-response.json'), 'utf8')
  if (evidence !== evaluation.input || sha256Hex(evidence) !== evaluation.evidenceDigest || response !== evaluation.response)
    throw new Error('evolution: saved outcome input or full judge response changed')
  const parsed = JSON.parse(evidence) as { measurements: OutcomeMeasurement[] }
  for (const sample of report.samples) {
    for (const side of ['baseline', 'candidate'] as const) {
      const measurements = parsed.measurements.filter(item => item.sampleTaskId === sample.taskId && item.side === side)
      const expected = report.frozen.evaluation!.measurements
      if (measurements.length !== expected.length || measurements.some((item, index) =>
        item.id !== expected[index]!.id || item.command !== expected[index]!.command ||
        item.workspace !== sample[side].workspace || item.ref !== `${sample.taskId}/${side}/${item.id}` || item.exitCode !== 0))
        throw new Error('evolution: outcome measurements do not match the frozen commands or a command failed')
      const current = await directoryDigest(sample[side].workspace)
      if (measurements.some(item => item.workspaceDigest !== current))
        throw new Error('evolution: outcome workspace artifacts changed after the saved measurements')
    }
  }
}
