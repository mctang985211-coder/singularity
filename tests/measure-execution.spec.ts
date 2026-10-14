/**
 * The production measurement, driven with real files, a real program and the real adapter.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { VerifierCriterion } from '../src/task/contract.ts'
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
  return new Promise((resolve) => {
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
 */
function realMeasurement(): RealMeasurement {
  return async (execution: ProductionExecution): Promise<MeasuredNumber | MissedMeasurement> => {
    const request = {
      command: typeof execution.command === 'string' ? execution.command : execution.command.join(' '),
      artifactPath: execution.artifactPath,
      inputs: execution.inputs.map((entry) => ({ name: entry.name, digest: entry.digest, path: entry.path })),
    }
    const result = await runProcess(process.execPath, [ADAPTER, JSON.stringify(request)])
    if (result.code !== 0) throw new Error(`the adapter could not measure: ${result.stderr}`)
    const [line] = result.stdout.trimEnd().split('\n')
    if (line === undefined) throw new Error('the adapter printed nothing')
    const reported = JSON.parse(line) as { quality: number; cost?: number; missed?: string; detail: string }
    const implementationDigest = await programDigest()
    if (reported.missed !== undefined) return { reason: reported.missed }
    return { quality: reported.quality, ...(reported.cost === undefined ? {} : { cost: reported.cost }), implementationDigest, detail: reported.detail,
    }
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
  const argv = [process.execPath, program, input, artifact, marker, label, quality, ...(cost === undefined ? [] : [cost]),
  ]
  return argv.map((entry) => `"${entry}"`).join(' ')
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
        { name: 'accepts a good input', expected: 'pass', input: { subject: good, artifactDigest: sha256('good'), inputs: [] },
        },
        { name: 'rejects a bad input', expected: 'fail', input: { subject: bad, artifactDigest: sha256('bad'), inputs: [] },
        },
      ],
    },
    judge: selftestJudge,
    ...overrides,
  }
}

async function criterion(overrides: Partial<VerifierCriterion> = {}): Promise<VerifierCriterion> {
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
    // One read of the trial, the whole shape at once: a length check on `inputDigests` or a separate
    // "not the stale bytes" check would only restate what this says.
    expect(outcome.trial).toEqual({
      quality: 0.75,
      cost: 2,
      implementationDigest: await programDigest(),
      artifactDigest: sha256(INPUT_BYTES.toUpperCase()),
      inputDigests: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }],
      detail: expect.any(String),
    })
    // Hashed after the program overwrote it, not before: the digest names the bytes on disk, never
    // the stale ones written before the run.
    expect(sha256(await readFile(artifact))).toBe(outcome.trial.artifactDigest)
    expect(await markerLabels()).toContain('measured')
    // A cost nobody reported stays absent rather than becoming 0.
    const uncosted = await runMeasurement(await request({ command: commandFor('measured', '0.5') }))
    if (uncosted.kind !== 'trial') throw new Error('expected a trial')
    expect([uncosted.trial.quality, 'cost' in uncosted.trial]).toEqual([0.5, false])
  })

  it('reports a program that produced no number as a miss, never as a zero', async () => {
    const outcome = await runMeasurement(await request({ command: commandFor('failing', '0.9') }))
    if (outcome.kind !== 'missed') throw new Error('expected a miss')
    // One reason, naming both facts: the program exited non-zero and produced no number.
    expect([outcome.reason.includes('exited 1'), outcome.reason.includes('produced no number')]).toEqual([true, true])
    // The program really ran; only its number is absent, and the artifact it never wrote is not
    // hashed as if it had.
    expect(await markerLabels()).toContain('failing')
  })

  it('does not find an implementation rebuilt under the same ref@version but different bytes', async () => {
    const rebuilt = await heldImplementation({ implementationDigest: sha256('rebuilt implementation bytes') })
    const refusal = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [rebuilt] })))
    expect(refusal).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('rebuilt') })
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
          { name: 'accepts a good input', expected: 'pass', input: { subject: good, artifactDigest: sha256('good'), inputs: [] },
          },
          { name: 'rejects a bad input', expected: 'fail', input: { subject: bad, artifactDigest: sha256('bad'), inputs: [] },
          },
          { name: 'rejects the same bad input twice', expected: 'pass', input: { subject: bad, artifactDigest: sha256('bad'), inputs: [] },
          },
        ],
      },
    })
    const refusal = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [lying] })))
    expect(refusal).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('rejects the same bad input twice'),
    })
    // The selftest ran the samples for real, and the measured run was never reached.
    const labels = await markerLabels()
    expect([labels.includes('sample'), labels.includes('measured')]).toEqual([true, false])
  })

  it('refuses a one-sided declaration, and one whose selftest cannot run at all', async () => {
    const good = join(directory, 'sample-good.txt')
    await writeFile(good, 'GOOD sample', 'utf8')
    const oneSided = await heldImplementation({
      selftest: { samples: [{ name: 'accepts a good input', expected: 'pass', input: { subject: good, artifactDigest: sha256('good'), inputs: [] },
          },
        ],
      },
    })
    const sided = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [oneSided] })))
    const broken = await heldImplementation({
      judge: async () => {
        throw new Error('the measurement program is missing')
      },
    })
    const unrunnable = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [broken] })))
    // The same refusal for both, each naming its own defect: no sample expected to fail, and a judge that could not run.
    expect([sided, unrunnable]).toMatchObject([
      { code: 'unregistered-verifier', detail: expect.stringContaining('no sample expected to fail') },
      { code: 'unregistered-verifier', detail: expect.stringContaining('could not run') },
    ])
    expect(await markerLabels()).toBe('')
  })

  it("refuses a number from an implementation whose bytes are not the metric's", async () => {
    const held = await heldImplementation()
    // The criterion is read *before* the rebuild, so it names the bytes that were held then.
    const declared = await criterion()
    // A rebuild that keeps the behaviour but not the bytes: the selftest still passes, and the digest
    // the real port reports no longer matches what the metric named.
    await writeFile(program, `${PROGRAM_SOURCE}// rebuilt without changing behaviour\n`, 'utf8')
    const refusal = await asyncRefusalOf(async () => runMeasurement(await request({ implementations: [held], metric: declared })),
    )
    expect(refusal).toMatchObject({ code: 'wrong-verifier', detail: expect.stringContaining(declared.implementationDigest.slice(0, 12)),
    })
    // The rebuilt implementation really did run; the refusal is about *which* implementation ran.
    expect(await markerLabels()).toContain('measured')
  })

  it('refuses input bytes that are not the declared bytes, before any run', async () => {
    await writeFile(input, 'tampered after the bubble declared its digest', 'utf8')
    const refusal = await asyncRefusalOf(async () => runMeasurement(await request()))
    expect(refusal).toMatchObject({ code: 'evidence-input-mismatch', detail: expect.stringContaining(INPUT_NAME) })
    // The selftest ran, but the measured run was never reached.
    expect(await markerLabels()).not.toContain('measured')
  })

  it('refuses an artifact that cannot be read after the run, by name', async () => {
    // The program runs; the artifact is then taken away before the digest can be read, so there are
    // no bytes this measurement could be bound to.
    const vanishing: RealMeasurement = async (execution) => {
      const reported = await realMeasurement()(execution)
      await rm(execution.artifactPath, { force: true })
      return reported
    }
    const removed = await asyncRefusalOf(async () => runMeasurement(await request({ measure: vanishing })))
    expect(removed).toMatchObject({ code: 'evidence-input-mismatch', detail: expect.stringContaining('artifact') })
    expect(await markerLabels()).toContain('measured')
  })

  it('refuses a request that is not the frozen shape, by name', async () => {
    const codeOf = async (body: MeasurementRequest) => (await asyncRefusalOf(() => runMeasurement(body))).code
    const duplicated = await request({ inputs: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }, { name: INPUT_NAME, digest: sha256('other bytes') },
      ],
    })
    // Five ways of not being the frozen shape — a digest that is not one, no measure port, an escaping
    // path, an absolute input name, a repeated name — are one refusal under the payload's own name.
    const refused = await Promise.all([
      codeOf(await request({ inputs: [{ name: INPUT_NAME, digest: 'not-a-digest' }] })),
      codeOf(await request({ measure: undefined as unknown as RealMeasurement })),
      codeOf(await request({ artifactPath: '../outside.txt' })),
      codeOf(await request({ inputs: [{ name: input, digest: sha256(INPUT_BYTES) }] })),
      codeOf(duplicated),
    ])
    expect(refused).toEqual(['malformed-payload', 'malformed-payload', 'malformed-payload', 'malformed-payload', 'malformed-payload',
    ])
    // A metric's shape is the contract's rule, so the refusal is the contract's own name for it.
    expect(await codeOf(await request({ metric: await criterion({ implementationDigest: 'short' }) }))).toBe('malformed-contract',
    )
  })

  it('refuses a port report that is neither a number nor a named miss', async () => {
    const lying = (report: MeasuredNumber | MissedMeasurement): RealMeasurement => async () => report
    const notANumber = await asyncRefusalOf(async () => runMeasurement(await request({ measure: lying({ quality: '0.9' as unknown as number, implementationDigest: await programDigest() }),
        }),
      ),
    )
    expect(notANumber).toMatchObject({ code: 'malformed-payload', detail: expect.stringContaining('quality') })
    const reasonless = await asyncRefusalOf(async () => runMeasurement(await request({ measure: lying({ reason: '' }) })),
    )
    expect(reasonless.code).toBe('malformed-payload')
  })
})

describe('the measurement adapter', () => {
  /** Invoke the adapter directly, without letting a non-zero exit throw. */
  function invoke(requestBody: unknown, onStdin = false): Promise<{ code: number; stdout: string; stderr: string }> {
    if (onStdin)
      return new Promise((resolve) => {
        const child = execFile(process.execPath, [ADAPTER], { encoding: 'utf8' }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
        })
        child.stdin?.end(JSON.stringify(requestBody))
      })
    return runProcess(process.execPath, [ADAPTER, JSON.stringify(requestBody)])
  }

  it('reports the number, the artifact bytes and the input bytes it actually read', async () => {
    const result = await invoke({ command: commandFor('measured', '0.25', '7'), artifactPath: artifact, inputs: [{ name: INPUT_NAME, digest: 'b'.repeat(64), path: input }],
    })
    const lines = result.stdout.trimEnd().split('\n')
    const report = JSON.parse(lines[0] ?? '{}') as { quality: number
      cost: number
      artifactDigest: string
      inputDigests: readonly BubbleInput[]
      detail: string }
    // Exit 0 with the OK trailer, then one read of the whole report: the number, the cost, the bytes
    // of the artifact, the input hashed from its own bytes, the declared digest in the detail.
    expect([result.code, lines.at(-1)]).toEqual([0, OK])
    expect(report).toEqual({
      quality: 0.25,
      cost: 7,
      artifactDigest: sha256(INPUT_BYTES.toUpperCase()),
      inputDigests: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }],
      detail: expect.stringContaining('b'.repeat(12)),
    })
  })

  it('leaves an unreported cost absent, and reports a failed program as a miss it still measured', async () => {
    const uncosted = await invoke({ command: commandFor('measured', '0.25'), artifactPath: artifact, inputs: [] })
    const uncostedReport = JSON.parse(uncosted.stdout.split('\n')[0] ?? '{}') as { cost?: number }
    // The run succeeded, and its report carries no `cost` member at all rather than a zero.
    expect([uncosted.code, 'cost' in uncostedReport]).toEqual([0, false])
    // A failed program is a miss the adapter still measured: exit 0, the OK trailer, the reason.
    const missed = await invoke({ command: commandFor('failing'), artifactPath: artifact, inputs: [] })
    expect(missed).toMatchObject({ code: 0, stdout: expect.stringContaining(OK) })
    expect(JSON.parse(missed.stdout.split('\n')[0] ?? '{}')).toMatchObject({ missed: expect.stringContaining('exited 1'),
    })
  })

  it('exits non-zero only when it could not measure at all', async () => {
    // A program that exits 0 without a number is broken, not missable: it claims success and reports
    // nothing, so there is no outcome to record.
    const silent = await invoke({ command: `"${process.execPath}" -e ""`, artifactPath: artifact, inputs: [] })
    expect([silent.stdout.includes(OK), silent.stderr.includes('measure-runner:')]).toEqual([false, true])
    const absent = await invoke({ command: 'true', artifactPath: join(directory, 'not-there.txt'), inputs: [] })
    // An input with no readable path names no bytes, so there is nothing to hash.
    const pathless = await invoke({ command: 'true', artifactPath: artifact, inputs: [{ name: INPUT_NAME, digest: sha256('x') }],
    })
    const undeclared = await invoke({ command: 'true', artifactPath: artifact, inputs: [], verbose: true })
    // None of the four could measure, so none of them exits 0, and each names its own defect on stderr.
    expect([silent.code, absent.code, pathless.code, undeclared.code].map((code) => code !== 0)).toEqual([true, true, true, true,
    ])
    expect([pathless.stderr.includes('path'), undeclared.stderr.includes('undeclared member')]).toEqual([true, true])
  })

  it('reads a request from stdin when argv carries none', async () => {
    const result = await invoke({ command: commandFor('measured', '0.5', '1'), artifactPath: artifact, inputs: [] }, true,
    )
    // The request read from stdin measures like the one on argv: exit 0, the OK trailer, the report.
    expect(result).toMatchObject({ code: 0, stdout: expect.stringContaining(OK) })
    expect(JSON.parse(result.stdout.split('\n')[0] ?? '{}')).toMatchObject({ quality: 0.5, cost: 1, artifactDigest: sha256(INPUT_BYTES.toUpperCase()),
    })
  })
})
