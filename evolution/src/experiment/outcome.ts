import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { TaskSnapshot } from '@dangosys/dsh-singularity-task'
import { rebaseWorkspacePaths } from '@dangosys/dsh-singularity-task-runtime'
import type { ExperimentView, ExperimentLedger } from './freeze.ts'
import type { OutcomeModelCall } from './spec.ts'
import type { ExperimentReport, OutcomeMeasurement } from '../replay.ts'
import { canonicalJson, parseOutcomeJudgement, assertOutcomeEvaluation } from '../replay.ts'
import { buildExperimentReport, directoryDigest } from './record.ts'

const OUTPUT_LIMIT = 1024 * 1024

/** Grace the subprocess provider's own termination procedure gets to end a measurement's process range. */
const TERMINATION_GRACE_MS = 5000

/**
 * The policy one sample's measurement runs under: the deployment's own mode,
 * rooted at that sample side's workspace. The measured workspace is exactly
 * the subtree the confinement must keep writable, because a measurement may
 * write the artifacts the frozen digest is taken over. `undefined` means the
 * resolved policy grants full access, so the measurement runs unconfined.
 */
function measurementPolicy(resolved: SandboxExecutionPolicy | undefined, cwd: string): SandboxPolicy | undefined {
  if (resolved?.mode === 'danger-full-access') return undefined
  return { mode: resolved?.mode === 'read-only' ? 'read-only' : 'workspace-write', workspaceRoot: cwd }
}

/** Resolve once one piped stream has no writer left, so a measurement is never read before it finished writing. */
function drained(stream: Readable | undefined): Promise<void> {
  return new Promise(resolve => {
    if (stream === undefined || stream.readableEnded) {
      resolve()
      return
    }
    stream.once('end', () => resolve())
    stream.once('close', () => resolve())
  })
}

async function measure(
  ctx: Context | undefined,
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  signal?.throwIfAborted()
  const sandbox = ctx?.get?.('sandbox')
  const subprocess = ctx?.get?.('subprocess')
  if (ctx !== undefined && sandbox !== undefined && subprocess !== undefined) {
    const policy = measurementPolicy(ctx.get('sandboxPolicy')?.resolve(), cwd)
    if (policy !== undefined) {
      const confined = await sandbox.confine(['/bin/sh', '-c', command], policy)
      return measureConfined(subprocess, confined.argv, cwd, signal)
    }
  }
  return measureDirect(command, cwd, signal)
}

/** Measure one command through the subprocess seam: termination is the provider's own managed-range procedure. */
function measureConfined(
  subprocess: SubprocessRuntime,
  argv: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveResult, reject) => {
    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: TERMINATION_GRACE_MS,
      })
    } catch (error) {
      reject(error)
      return
    }
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const sizes = { stdout: 0, stderr: 0 }
    let failure: Error | undefined
    const stop = (error: Error) => {
      failure ??= error
      handle.terminate()
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      handle[stream]?.on('data', (chunk: Buffer) => {
        sizes[stream] += chunk.length
        if (sizes[stream] > OUTPUT_LIMIT) stop(new Error(`evolution: measurement ${stream} exceeded 1 MiB; no truncated evidence was accepted`))
        else output[stream].push(chunk)
      })
    }
    const abort = () => stop(new Error('evolution: outcome measurement cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timeout = setTimeout(() => stop(new Error('evolution: outcome measurement exceeded 300s')), 300_000)
    const settle = (error?: Error, code?: number | null): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else if (code === null || code === undefined) reject(new Error('evolution: outcome measurement did not report an exit code'))
      else resolveResult({ stdout: Buffer.concat(output.stdout).toString('utf8'), stderr: Buffer.concat(output.stderr).toString('utf8'), exitCode: code })
    }
    handle.done.then(
      outcome =>
        void Promise.all([drained(handle.stdout), drained(handle.stderr)]).then(() => {
          if (failure !== undefined) settle(failure)
          else if (outcome.exitCode === null) settle(new Error(`evolution: outcome measurement terminated by ${outcome.signal ?? 'a signal'}`))
          else settle(undefined, outcome.exitCode)
        }),
      error => settle(error instanceof Error ? error : new Error(String(error))),
    )
  })
}

/** Measure one command this package spawns itself, for a context that mounts no confinement seam. */
function measureDirect(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
  ctx?: Context
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
  const usagePath = resolve(ledger.root, `${directory}/outcome-usage.json`)
  let judgeUsage: import('@dangosys/dsh-singularity-task').ReviewTokenUsage | undefined
  await mkdir(resolve(ledger.root, directory), { recursive: true })
  // A crash leaves this marker. Unknown executions/responses must not be silently repeated.
  let existingResponse: string | undefined
  try { existingResponse = await readFile(responsePath, 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let fixedInput: string
  if (existingResponse !== undefined) {
    fixedInput = await readFile(resolve(ledger.root, evidencePath), 'utf8')
    try { judgeUsage = JSON.parse(await readFile(usagePath, 'utf8')) ?? undefined }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
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
          const command = view.frozen.snapshot.rebaseFrom === undefined ? measurement.command
            : rebaseWorkspacePaths(measurement.command, view.frozen.snapshot.rebaseFrom, detail.workspace)
          const result = await measure(input.ctx, command, detail.workspace, input.signal)
          measurements.push({
            ref: `${sample.taskId}/${side}/${measurement.id}`,
            sampleTaskId: sample.taskId,
            side,
            id: measurement.id,
            command,
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
    const judged = await input.judge(plan.judge.model, plan.judge.prompt, fixedInput, input.signal)
    existingResponse = typeof judged === 'string' ? judged : judged.response
    judgeUsage = typeof judged === 'string' ? undefined : judged.usage
    await writeFile(usagePath, canonicalJson(judgeUsage ?? null), { flag: 'wx' })
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
    ...(judgeUsage === undefined ? {} : { judgeUsage }),
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
  if (evaluation.judgeUsage !== undefined &&
      canonicalJson(JSON.parse(await readFile(resolve(root, expectedDirectory, 'outcome-usage.json'), 'utf8'))) !== canonicalJson(evaluation.judgeUsage))
    throw new Error('evolution: saved independent judge token usage changed')
  const parsed = JSON.parse(evidence) as { measurements: OutcomeMeasurement[] }
  for (const sample of report.samples) {
    for (const side of ['baseline', 'candidate'] as const) {
      const measurements = parsed.measurements.filter(item => item.sampleTaskId === sample.taskId && item.side === side)
      const expected = report.frozen.evaluation!.measurements
      if (measurements.length !== expected.length || measurements.some((item, index) =>
        item.id !== expected[index]!.id || item.command !== (report.frozen.snapshot.rebaseFrom === undefined ? expected[index]!.command
          : rebaseWorkspacePaths(expected[index]!.command, report.frozen.snapshot.rebaseFrom, sample[side].workspace)) ||
        item.workspace !== sample[side].workspace || item.ref !== `${sample.taskId}/${side}/${item.id}` || item.exitCode !== 0))
        throw new Error('evolution: outcome measurements do not match the frozen commands or a command failed')
      const current = await directoryDigest(sample[side].workspace)
      if (measurements.some(item => item.workspaceDigest !== current))
        throw new Error('evolution: outcome workspace artifacts changed after the saved measurements')
    }
  }
}
