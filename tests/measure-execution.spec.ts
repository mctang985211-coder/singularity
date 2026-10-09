/**
 * The production measurement, driven with real files, a real program and the real adapter.
 *
 * Every test writes a measurement program to disk, runs it through `scripts/measure-runner.mjs` in a
 * real process, and observes the bytes it left behind. Nothing is mocked: the program records that it
 * ran in a marker file, so "the implementation actually ran" is a byte on disk rather than a call, and
 * each refusal that must happen *before* it runs is pinned by the marker's absence.
 *
 * The measurement *port* is the only thing a test supplies: execution is deliberately a port in
 * `src/`, and where the subject is a measurement check, that port is still the real adapter.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AcceptanceCriterion } from '../src/task/contract.ts'
import type { BubbleInput } from '../src/task/bubble.ts'
import type { VerifierImplementation, VerifierInput, VerifierVerdict } from '../src/verifier/implementation.ts'
import type { ProductionExecution, VerifierCommand } from '../src/verifier/production.ts'
import {
  runMeasurement,
  type MeasuredNumber,
  type MeasurementOutcome,
  type MeasurementRequest,
  type MissedMeasurement,
  type RealMeasurement,
} from '../src/measure/execution.ts'
import { asyncRefusalOf } from './fixtures.ts'

const ADAPTER = fileURLToPath(new URL('../scripts/measure-runner.mjs', import.meta.url))
const OK = 'measure-runner: OK'
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The measurement program itself, as real bytes on disk. It records the label it was run under in a
 * marker file, writes its artifact, prints its number, and exits non-zero for a `failing` label or a
 * BAD input — so one program produces a trial, a miss, and both selftest verdicts.
 */
const PROGRAM_SOURCE = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const [inputPath, artifactPath, markerPath, label, quality, cost] = process.argv.slice(2)
if (markerPath !== undefined && markerPath !== '') appendFileSync(markerPath, \`\${label}\\n\`)
const text = readFileSync(inputPath, 'utf8')
if (label === 'failing' || text.includes('BAD')) process.exit(1)
writeFileSync(artifactPath, text.trim().toUpperCase())
console.log(JSON.stringify(cost === undefined ? { quality: Number(quality) } : { quality: Number(quality), cost: Number(cost) }))
`

const INPUT_NAME = 'in/words.txt'
const ARTIFACT_NAME = 'out/artifact.txt'
const INPUT_BYTES = 'GOOD three words'

let directory: string
let workspace: string
let program: string
let marker: string
let input: string
let artifact: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'measure-execution-'))
  workspace = join(directory, 'workspace')
  await mkdir(join(workspace, 'in'), { recursive: true })
  await mkdir(join(workspace, 'out'), { recursive: true })
  program = join(directory, 'measure.mjs')
  marker = join(directory, 'ran.log')
  input = join(workspace, INPUT_NAME)
  artifact = join(workspace, ARTIFACT_NAME)
  await writeFile(program, PROGRAM_SOURCE, 'utf8')
  await writeFile(input, INPUT_BYTES, 'utf8')
  // The program overwrites this, so the post-execution digest cannot be a pre-execution read.
  await writeFile(artifact, 'stale bytes written before the program ran', 'utf8')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Run one process for real without letting a non-zero exit throw. */
function runProcess(file: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })
}

/** What the program recorded, or an empty string when it never ran. */
async function markerLabels(): Promise<string> {
  try {
    return await readFile(marker, 'utf8')
  } catch {
    return ''
  }
}

/** The digest of the program's own bytes, as a deployment would declare it. */
async function programDigest(): Promise<string> {
  return sha256(await readFile(program))
}

/**
 * The real measurement port: run the command through the real adapter, then report the digest of the
 * bytes that were executed. The digest is read from the program file, not accepted from a caller.
 */
function realMeasurement(): RealMeasurement {
  return async (execution: ProductionExecution): Promise<MeasuredNumber | MissedMeasurement> => {
    const request = {
      command: typeof execution.command === 'string' ? execution.command : execution.command.join(' '),
      artifactPath: execution.artifactPath,
      inputs: execution.inputs.map(entry => ({ name: entry.name, digest: entry.digest, path: entry.path })),
    }
    const result = await runProcess(process.execPath, [ADAPTER, JSON.stringify(request)])
    if (result.code !== 0) throw new Error(`the adapter could not measure: ${result.stderr}`)
    const [line] = result.stdout.trimEnd().split('\n')
    if (line === undefined) throw new Error('the adapter printed nothing')
    const reported = JSON.parse(line) as { quality: number; cost?: number; missed?: string; detail: string }
    const implementationDigest = await programDigest()
    if (reported.missed !== undefined) return { reason: reported.missed }
    return { quality: reported.quality, ...(reported.cost === undefined ? {} : { cost: reported.cost }), implementationDigest, detail: reported.detail }
  }
}

let sampleArtifacts = 0
/** The declaration's selftest judge: the same real program, run over the sample's input file. */
async function selftestJudge(sample: VerifierInput): Promise<VerifierVerdict> {
  sampleArtifacts += 1
  const scratch = join(directory, `sample-artifact-${sampleArtifacts}`)
  const result = await runProcess(process.execPath, [program, sample.subject, scratch, marker, 'sample', '0'])
  return { verdict: result.code === 0 ? 'pass' : 'fail' }
}

/** The shell line for one measured run: real argv, a real label, and a number to print. */
function commandFor(label: string, quality = '0.75', cost?: string): VerifierCommand {
  const argv = [process.execPath, program, input, artifact, marker, label, quality, ...(cost === undefined ? [] : [cost])]
  return argv.map(entry => `"${entry}"`).join(' ')
}

/** One held implementation, with whatever a test wants to vary. */
async function heldImplementation(overrides: Partial<VerifierImplementation> = {}): Promise<VerifierImplementation> {
  const good = join(directory, 'sample-good.txt')
  const bad = join(directory, 'sample-bad.txt')
  await writeFile(good, 'GOOD sample', 'utf8')
  await writeFile(bad, 'BAD sample', 'utf8')
  return {
    ref: 'command',
    version: '1',
    implementationDigest: await programDigest(),
    selftest: {
      samples: [
        { name: 'accepts a good input', expected: 'pass', input: { subject: good, artifactDigest: sha256('good'), inputs: [] } },
        { name: 'rejects a bad input', expected: 'fail', input: { subject: bad, artifactDigest: sha256('bad'), inputs: [] } },
      ],
    },
    judge: selftestJudge,
    ...overrides,
  }
}

async function criterion(overrides: Partial<AcceptanceCriterion> = {}): Promise<AcceptanceCriterion> {
  return {
    criterionId: 'quality',
    statement: 'the artifact holds the upper-cased input',
    verifierRef: 'command',
    verifierVersion: '1',
    implementationDigest: await programDigest(),
    ...overrides,
  }
}

async function request(overrides: Partial<MeasurementRequest> = {}): Promise<MeasurementRequest> {
  return {
    metric: await criterion(),
    implementations: [await heldImplementation()],
    inputs: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }],
    workspace,
    artifactPath: ARTIFACT_NAME,
    command: commandFor('measured', '0.75', '2'),
    measure: realMeasurement(),
    ...overrides,
  }
}

describe('the production measurement', () => {
  it('measures by running the real program, and pins the bytes it left behind', async () => {
    const outcome: MeasurementOutcome = await runMeasurement(await request())
    if (outcome.kind !== 'trial') throw new Error(`expected a trial, got a miss: ${outcome.reason}`)
    const inputDigests: readonly BubbleInput[] = outcome.trial.inputDigests
    expect(outcome.trial).toMatchObject({
      quality: 0.75,
      cost: 2,
      implementationDigest: await programDigest(),
      artifactDigest: sha256(INPUT_BYTES.toUpperCase()),
      inputDigests: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }],
    })
    expect(inputDigests).toHaveLength(1)
    // Hashed after the program overwrote it, not before: the post-run bytes name the measurement.
    expect(outcome.trial.artifactDigest).not.toBe(sha256('stale bytes written before the program ran'))
    expect(sha256(await readFile(artifact))).toBe(outcome.trial.artifactDigest)
    expect(await markerLabels()).toContain('measured')
    // A cost nobody reported stays absent rather than becoming 0.
    const uncosted = await runMeasurement(await request({ command: commandFor('measured', '0.5') }))
    if (uncosted.kind !== 'trial') throw new Error('expected a trial')
    expect(uncosted.trial.quality).toBe(0.5)
    expect('cost' in uncosted.trial).toBe(false)
  })

  it('reports a program that produced no number as a miss, never as a zero', async () => {
    const outcome = await runMeasurement(await request({ command: commandFor('failing', '0.9') }))
    if (outcome.kind !== 'missed') throw new Error('expected a miss')
    expect(outcome.reason).toContain('exited 1')
    expect(outcome.reason).toContain('produced no number')
    // The program really ran; only its number is absent, and the artifact it never wrote is not
    // hashed as if it had.
    expect(await markerLabels()).toContain('failing')
  })

  it('does not find an implementation rebuilt under the same ref@version but different bytes', async () => {
    const rebuilt = await heldImplementation({ implementationDigest: sha256('rebuilt implementation bytes') })
    const refusal = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [rebuilt] })))
    expect(refusal.code).toBe('unregistered-verifier')
    expect(refusal.detail).toContain('rebuilt')
    // Not a single execution: the rebuilt code must not run at all, not merely be reported later.
    expect(await markerLabels()).toBe('')
  })

  it('refuses a selftest that disagrees with its own declaration, before the measured run', async () => {
    const good = join(directory, 'sample-good.txt')
    const bad = join(directory, 'sample-bad.txt')
    await writeFile(good, 'GOOD sample', 'utf8')
    await writeFile(bad, 'BAD sample', 'utf8')
    // The declaration claims both outcomes (so the shape gate passes) and then lies about one: the
    // real program exits non-zero for a BAD input, and the sample claims it passes.
    const lying = await heldImplementation({
      selftest: {
        samples: [
          { name: 'accepts a good input', expected: 'pass', input: { subject: good, artifactDigest: sha256('good'), inputs: [] } },
          { name: 'rejects a bad input', expected: 'fail', input: { subject: bad, artifactDigest: sha256('bad'), inputs: [] } },
          { name: 'rejects the same bad input twice', expected: 'pass', input: { subject: bad, artifactDigest: sha256('bad'), inputs: [] } },
        ],
      },
    })
    const refusal = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [lying] })))
    expect(refusal.code).toBe('unregistered-verifier')
    expect(refusal.detail).toContain('rejects the same bad input twice')
    expect(await markerLabels()).toContain('sample')
    expect(await markerLabels()).not.toContain('measured')
  })

  it('refuses a one-sided declaration, and one whose selftest cannot run at all', async () => {
    const good = join(directory, 'sample-good.txt')
    await writeFile(good, 'GOOD sample', 'utf8')
    const oneSided = await heldImplementation({
      selftest: { samples: [{ name: 'accepts a good input', expected: 'pass', input: { subject: good, artifactDigest: sha256('good'), inputs: [] } }] },
    })
    const sided = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [oneSided] })))
    expect(sided.code).toBe('unregistered-verifier')
    expect(sided.detail).toContain('no sample expected to fail')
    const broken = await heldImplementation({
      judge: async () => {
        throw new Error('the measurement program is missing')
      },
    })
    const unrunnable = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [broken] })))
    expect(unrunnable.code).toBe('unregistered-verifier')
    expect(unrunnable.detail).toContain('could not run')
    expect(await markerLabels()).toBe('')
  })

  it("refuses a number from an implementation whose bytes are not the metric's", async () => {
    const held = await heldImplementation()
    // The criterion is read *before* the rebuild, so it names the bytes that were held then.
    const declared = await criterion()
    // A rebuild that keeps the behaviour but not the bytes: the selftest still passes, and the digest
    // the real port reports no longer matches what the metric named.
    await writeFile(program, `${PROGRAM_SOURCE}// rebuilt without changing behaviour\n`, 'utf8')
    const refusal = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [held], metric: declared })))
    expect(refusal.code).toBe('wrong-verifier')
    expect(refusal.detail).toContain(declared.implementationDigest.slice(0, 12))
    // The rebuilt implementation really did run; the refusal is about *which* implementation ran.
    expect(await markerLabels()).toContain('measured')
  })

  it('refuses input bytes that are not the declared bytes, before any run', async () => {
    await writeFile(input, 'tampered after the bubble declared its digest', 'utf8')
    const refusal = await asyncRefusalOf(async () => runMeasurement(await request()))
    expect(refusal.code).toBe('evidence-input-mismatch')
    expect(refusal.detail).toContain(INPUT_NAME)
    // The selftest ran, but the measured run was never reached.
    expect(await markerLabels()).not.toContain('measured')
  })

  it('refuses an artifact that cannot be read after the run, by name', async () => {
    // The program runs; the artifact is then taken away before the digest can be read, so there are
    // no bytes this measurement could be bound to.
    const vanishing: RealMeasurement = async execution => {
      const reported = await realMeasurement()(execution)
      await rm(execution.artifactPath, { force: true })
      return reported
    }
    const removed = await asyncRefusalOf(async () => runMeasurement(await request({ measure: vanishing })))
    expect(removed.code).toBe('evidence-input-mismatch')
    expect(removed.detail).toContain('artifact')
    expect(await markerLabels()).toContain('measured')
  })

  it('refuses a request that is not the frozen shape, by name', async () => {
    const codeOf = async (body: MeasurementRequest) => (await asyncRefusalOf(() => runMeasurement(body))).code
    expect(await codeOf(await request({ inputs: [{ name: INPUT_NAME, digest: 'not-a-digest' }] }))).toBe('malformed-payload')
    expect(await codeOf(await request({ measure: undefined as unknown as RealMeasurement }))).toBe('malformed-payload')
    expect(await codeOf(await request({ artifactPath: '../outside.txt' }))).toBe('malformed-payload')
    expect(await codeOf(await request({ inputs: [{ name: input, digest: sha256(INPUT_BYTES) }] }))).toBe('malformed-payload')
    const duplicated = await request({ inputs: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }, { name: INPUT_NAME, digest: sha256('other bytes') }] })
    expect(await codeOf(duplicated)).toBe('malformed-payload')
    // A metric's shape is the contract's rule, so the refusal is the contract's own name for it.
    expect(await codeOf(await request({ metric: await criterion({ implementationDigest: 'short' }) }))).toBe('malformed-contract')
  })

  it('refuses a port report that is neither a number nor a named miss', async () => {
    const lying = (report: MeasuredNumber | MissedMeasurement): RealMeasurement => async () => report
    const notANumber = await asyncRefusalOf(async () => runMeasurement(await request({ measure: lying({ quality: '0.9' as unknown as number, implementationDigest: await programDigest() }) })))
    expect(notANumber.code).toBe('malformed-payload')
    expect(notANumber.detail).toContain('quality')
    const reasonless = await asyncRefusalOf(async () => runMeasurement(await request({ measure: lying({ reason: '' }) })))
    expect(reasonless.code).toBe('malformed-payload')
  })
})

describe('the measurement adapter', () => {
  /** Invoke the adapter directly, without letting a non-zero exit throw. */
  function invoke(requestBody: unknown, onStdin = false): Promise<{ code: number; stdout: string; stderr: string }> {
    if (onStdin)
      return new Promise(resolve => {
        const child = execFile(process.execPath, [ADAPTER], { encoding: 'utf8' }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
        })
        child.stdin?.end(JSON.stringify(requestBody))
      })
    return runProcess(process.execPath, [ADAPTER, JSON.stringify(requestBody)])
  }

  it('reports the number, the artifact bytes and the input bytes it actually read', async () => {
    const result = await invoke({ command: commandFor('measured', '0.25', '7'), artifactPath: artifact, inputs: [{ name: INPUT_NAME, digest: 'b'.repeat(64), path: input }] })
    expect(result.code).toBe(0)
    const lines = result.stdout.trimEnd().split('\n')
    expect(lines.at(-1)).toBe(OK)
    const report = JSON.parse(lines[0] ?? '{}') as { quality: number; cost: number; artifactDigest: string; inputDigests: readonly BubbleInput[]; detail: string }
    expect(report.quality).toBe(0.25)
    expect(report.cost).toBe(7)
    expect(report.artifactDigest).toBe(sha256(INPUT_BYTES.toUpperCase()))
    // The input is hashed from its own bytes, not echoed from the declared digest.
    expect(report.inputDigests).toEqual([{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }])
    // The declared digest stays visible in the detail, so a reader can see what was claimed.
    expect(report.detail).toContain('b'.repeat(12))
  })

  it('leaves an unreported cost absent, and reports a failed program as a miss it still measured', async () => {
    const uncosted = await invoke({ command: commandFor('measured', '0.25'), artifactPath: artifact, inputs: [] })
    expect(uncosted.code).toBe(0)
    expect('cost' in (JSON.parse(uncosted.stdout.split('\n')[0] ?? '{}') as { cost?: number })).toBe(false)
    const missed = await invoke({ command: commandFor('failing'), artifactPath: artifact, inputs: [] })
    expect(missed.code).toBe(0)
    expect(missed.stdout).toContain(OK)
    expect(JSON.parse(missed.stdout.split('\n')[0] ?? '{}')).toMatchObject({ missed: expect.stringContaining('exited 1') })
  })

  it('exits non-zero only when it could not measure at all', async () => {
    // A program that exits 0 without a number is broken, not missable: it claims success and reports
    // nothing, so there is no outcome to record.
    const silent = await invoke({ command: `"${process.execPath}" -e ""`, artifactPath: artifact, inputs: [] })
    expect(silent.code).not.toBe(0)
    expect(silent.stderr).toContain('measure-runner:')
    expect(silent.stdout).not.toContain(OK)
    const absent = await invoke({ command: 'true', artifactPath: join(directory, 'not-there.txt'), inputs: [] })
    expect(absent.code).not.toBe(0)
    // An input with no readable path names no bytes, so there is nothing to hash.
    const pathless = await invoke({ command: 'true', artifactPath: artifact, inputs: [{ name: INPUT_NAME, digest: sha256('x') }] })
    expect(pathless.code).not.toBe(0)
    expect(pathless.stderr).toContain('path')
    const undeclared = await invoke({ command: 'true', artifactPath: artifact, inputs: [], verbose: true })
    expect(undeclared.code).not.toBe(0)
    expect(undeclared.stderr).toContain('undeclared member')
  })

  it('reads a request from stdin when argv carries none', async () => {
    const result = await invoke({ command: commandFor('measured', '0.5', '1'), artifactPath: artifact, inputs: [] }, true)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(OK)
    expect(JSON.parse(result.stdout.split('\n')[0] ?? '{}')).toMatchObject({ quality: 0.5, cost: 1, artifactDigest: sha256(INPUT_BYTES.toUpperCase()) })
  })
})
