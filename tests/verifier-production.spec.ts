/**
 * The production verdict, driven with real files and real commands.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { VerifierCriterion } from '../src/task/contract.ts'
import type { VerifierImplementation, VerifierInput, VerifierVerdict } from '../src/verifier/implementation.ts'
import {
  runProductionVerdict,
  type JudgedVerdict,
  type ProductionExecution,
  type ProductionInput,
  type ProductionVerdict,
  type ProductionVerdictRequest,
  type RealJudge,
  type VerifierCommand,
} from '../src/verifier/production.ts'
import { asyncRefusalOf } from './fixtures.ts'

const ADAPTER = fileURLToPath(new URL('../scripts/verifier-command.mjs', import.meta.url))

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The verifier implementation itself, as real bytes on disk. It records the label it was run under
 */
const VERIFIER_SOURCE = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const [inputPath, artifactPath, markerPath, label] = process.argv.slice(2)
if (markerPath !== undefined && markerPath !== '') appendFileSync(markerPath, \`\${label}\\n\`)
const text = readFileSync(inputPath, 'utf8')
writeFileSync(artifactPath, text.trim())
process.exit(text.includes('BAD') ? 1 : 0)
`

const INPUT_NAME = 'in/words.txt'
const ARTIFACT_NAME = 'out/artifact.txt'

let directory: string
let workspace: string
let program: string
let marker: string
let input: string
let artifact: string
let inputBytes: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'verifier-production-'))
  workspace = join(directory, 'workspace')
  await mkdir(join(workspace, 'in'), { recursive: true })
  await mkdir(join(workspace, 'out'), { recursive: true })
  program = join(directory, 'verifier.mjs')
  marker = join(directory, 'ran.log')
  input = join(workspace, INPUT_NAME)
  artifact = join(workspace, ARTIFACT_NAME)
  inputBytes = 'GOOD three words'
  await writeFile(program, VERIFIER_SOURCE, 'utf8')
  await writeFile(input, inputBytes, 'utf8')
  // The command overwrites this, so the post-execution digest cannot be a pre-execution read.
  await writeFile(artifact, 'stale bytes written before the command ran', 'utf8')
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

/** What the verifier program recorded, or an empty string when it never ran. */
async function markerLabels(): Promise<string> {
  try {
    return await readFile(marker, 'utf8')
  } catch {
    return ''
  }
}

/** The digest of the verifier program's own bytes, as a deployment would declare it. */
async function programDigest(): Promise<string> {
  return sha256(await readFile(program))
}

/**
 * The real judge port: run the command through the real adapter, then report the digest of the
 */
function realJudge(): RealJudge {
  return async (execution: ProductionExecution): Promise<JudgedVerdict> => {
    const request = {
      command: typeof execution.command === 'string' ? execution.command : execution.command.join(' '),
      artifactPath: execution.artifactPath,
      inputs: execution.inputs.map((entry: ProductionInput) => ({ name: entry.name, digest: entry.digest, path: entry.path,
      })),
    }
    const result = await runProcess(process.execPath, [ADAPTER, JSON.stringify(request)])
    if (result.code !== 0) throw new Error(`the adapter could not judge: ${result.stderr}`)
    const [line] = result.stdout.trimEnd().split('\n')
    if (line === undefined) throw new Error('the adapter printed nothing')
    const judged = JSON.parse(line) as { verdict: 'pass' | 'fail'; detail: string }
    return { verdict: judged.verdict, implementationDigest: await programDigest(), detail: judged.detail }
  }
}

let sampleArtifacts = 0

/** The declaration's selftest judge: the same real program, run over the sample's input file. */
async function selftestJudge(sample: VerifierInput): Promise<VerifierVerdict> {
  sampleArtifacts += 1
  const scratch = join(directory, `sample-artifact-${sampleArtifacts}`)
  const result = await runProcess(process.execPath, [program, sample.subject, scratch, marker, 'sample'])
  return { verdict: result.code === 0 ? 'pass' : 'fail' }
}

/** The criterion's run, as the request's command: real argv, real paths, a real marker label. */
function criterionCommand(): VerifierCommand {
  return `"${process.execPath}" "${program}" "${input}" "${artifact}" "${marker}" criterion`
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
    criterionId: 'correctness',
    statement: 'the artifact is the trimmed input',
    verifierRef: 'command',
    verifierVersion: '1',
    implementationDigest: await programDigest(),
    ...overrides,
  }
}

async function request(overrides: Partial<ProductionVerdictRequest> = {}): Promise<ProductionVerdictRequest> {
  return {
    runId: 'run-1',
    criterion: await criterion(),
    implementations: [await heldImplementation()],
    inputs: [{ name: INPUT_NAME, digest: sha256(inputBytes) }],
    workspace,
    artifactPath: ARTIFACT_NAME,
    command: criterionCommand(),
    runJudge: realJudge(),
    ...overrides,
  }
}

describe('the production verdict', () => {
  it('forms the verdict from the real exit code and pins the artifact after execution', async () => {
    const verdict: ProductionVerdict = await runProductionVerdict(await request())

    // The frozen evidence shape, with the digests of the bytes that were actually read.
    expect(verdict).toEqual({
      runId: 'run-1',
      criterionId: 'correctness',
      verdict: 'pass',
      verifierRef: 'command',
      verifierVersion: '1',
      implementationDigest: await programDigest(),
      artifactDigest: sha256('GOOD three words'),
      inputDigests: [{ name: INPUT_NAME, digest: sha256(inputBytes) }],
      detail: expect.any(String),
    })
    // Hashed after the command overwrote it, not before: the bytes on disk are the post-run bytes the verdict names.
    expect(sha256(await readFile(artifact))).toBe(verdict.artifactDigest)
    // The command really ran, and it was the criterion's run rather than only the selftest's.
    expect(await markerLabels()).toContain('criterion')

    // A judged failure is a result, not a refusal: the same path returns `fail` with its artifact.
    await writeFile(input, 'BAD three words', 'utf8')
    const failed = await runProductionVerdict(
      await request({ inputs: [{ name: INPUT_NAME, digest: sha256('BAD three words') }], command: criterionCommand() }),
    )
    expect([failed.verdict, failed.artifactDigest]).toEqual(['fail', sha256('BAD three words')])
  })

  it('refuses input bytes that are not the declared bytes, before any real run', async () => {
    await writeFile(input, 'tampered after the bubble declared its digest', 'utf8')

    const refusal = await asyncRefusalOf(async () => runProductionVerdict(await request()))

    expect(refusal).toMatchObject({
      code: 'evidence-input-mismatch',
      detail: expect.stringContaining(INPUT_NAME),
    })
    // The selftest ran, but the criterion's own command was never reached.
    expect(await markerLabels()).not.toContain('criterion')
  })

  it('does not find an implementation rebuilt under the same ref@version but different bytes', async () => {
    const rebuilt = await heldImplementation({ implementationDigest: sha256('rebuilt implementation bytes') })

    const refusal = await asyncRefusalOf(async () => runProductionVerdict(await request({ implementations: [rebuilt] })),
    )

    expect(refusal).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('rebuilt') })
    // Not a single execution: the rebuilt code must not run at all, not merely be reported later.
    expect(await markerLabels()).toBe('')
  })

  it('refuses a selftest that disagrees with its own declaration, before any real run', async () => {
    const good = join(directory, 'sample-good.txt')
    const bad = join(directory, 'sample-bad.txt')
    await writeFile(good, 'GOOD sample', 'utf8')
    await writeFile(bad, 'BAD sample', 'utf8')
    // The declaration claims both verdicts (so the shape gate passes) and then lies about one
    // sample: the real program produces `fail` for a bad input, and the sample claims `pass`.
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

    const refusal = await asyncRefusalOf(async () => runProductionVerdict(await request({ implementations: [lying] })))

    expect(refusal).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('rejects the same bad input twice'),
    })
    // The selftest itself ran the samples for real; the criterion's run did not.
    expect(await markerLabels()).toContain('sample')
    expect(await markerLabels()).not.toContain('criterion')
  })

  it('refuses a one-sided declaration before running anything, because it cannot produce both verdicts', async () => {
    const good = join(directory, 'sample-good.txt')
    await writeFile(good, 'GOOD sample', 'utf8')
    const oneSided = await heldImplementation({
      selftest: { samples: [{ name: 'accepts a good input', expected: 'pass', input: { subject: good, artifactDigest: sha256('good'), inputs: [] },
          },
        ],
      },
    })

    const refusal = await asyncRefusalOf(async () => runProductionVerdict(await request({ implementations: [oneSided] })),
    )

    expect(refusal).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('no sample expected to fail'),
    })
    expect(await markerLabels()).toBe('')
  })

  it('refuses a declaration whose selftest cannot run at all, by name', async () => {
    const broken = await heldImplementation({
      judge: async () => {
        throw new Error('the judge binary is missing')
      },
    })

    const refusal = await asyncRefusalOf(async () => runProductionVerdict(await request({ implementations: [broken] })))

    expect(refusal).toMatchObject({ code: 'unregistered-verifier', detail: expect.stringContaining('could not run') })
    expect(await markerLabels()).toBe('')
  })

  it("refuses a verdict from an implementation whose bytes are not the criterion's", async () => {
    const held = await heldImplementation()
    // The criterion is read *before* the rebuild, so it names the bytes that were held then.
    const declaredCriterion = await criterion()
    const declared = declaredCriterion.implementationDigest
    // A rebuild that keeps the behaviour but not the bytes: the selftest still passes, and the
    // digest the real judge reports no longer matches what the criterion named.
    await writeFile(program, `${VERIFIER_SOURCE}// rebuilt without changing behaviour\n`, 'utf8')

    const refusal = await asyncRefusalOf(async () =>
      runProductionVerdict(await request({ implementations: [held], criterion: declaredCriterion })),
    )

    expect(refusal).toMatchObject({ code: 'wrong-verifier', detail: expect.stringContaining(declared.slice(0, 12)) })
    // The rebuilt implementation really did run; the refusal is about *which* implementation ran.
    expect(await markerLabels()).toContain('criterion')
  })

  it('refuses an artifact that cannot be read after execution, by name', async () => {
    // The command runs and its verdict is formed; the artifact is then taken away before the digest
    // can be read, so there are no bytes this verdict could be bound to.
    const vanishing: RealJudge = async (execution: ProductionExecution): Promise<JudgedVerdict> => {
      const judged = await realJudge()(execution)
      await rm(execution.artifactPath, { force: true })
      return judged
    }
    const removed = await asyncRefusalOf(async () => runProductionVerdict(await request({ runJudge: vanishing })))

    // The judged command really ran; only the binding to what it left behind is refused.
    expect(await markerLabels()).toContain('criterion')

    // An artifact that never existed is refused the same way, not as a bare read error. The judge
    // here is a stub on purpose: this case is about this path's own read, not about the adapter,
    // which hashes the artifact itself and would stop even earlier.
    const absentJudge: RealJudge = async (): Promise<JudgedVerdict> => ({
      verdict: 'pass',
      implementationDigest: await programDigest(),
    })
    const absent = await asyncRefusalOf(async () =>
      runProductionVerdict(await request({ artifactPath: 'out/never-written.txt', runJudge: absentJudge })),
    )
    // This path's own refusal, under the same name, for the artifact taken away and the one never written.
    expect([removed, absent]).toMatchObject([
      { code: 'evidence-input-mismatch', detail: expect.stringContaining('artifact') },
      { code: 'evidence-input-mismatch' },
    ])
  })

  it('refuses a request that is not the frozen shape, by name', async () => {
    const badDigest = await request({ inputs: [{ name: INPUT_NAME, digest: 'not-a-digest' }] })
    const noJudge = await request({ runJudge: undefined as unknown as RealJudge })
    const escaping = await request({ artifactPath: '../outside.txt' })
    const absolute = await request({ inputs: [{ name: input, digest: sha256(inputBytes) }] })
    const duplicated = await request({
      inputs: [
        { name: INPUT_NAME, digest: sha256(inputBytes) },
        { name: INPUT_NAME, digest: sha256('other bytes') },
      ],
    })

    // Five ways of not being the frozen shape — a digest that is not one, no judge port, an escaping
    // artifact path, an absolute input name, a repeated input name — are one decision at the shape
    // gate, refused under the payload's own name, and none of them is run.
    const refused = await Promise.all(
      [badDigest, noJudge, escaping, absolute, duplicated].map(async (payload) => (await asyncRefusalOf(() => runProductionVerdict(payload))).code,
      ),
    )
    expect(refused).toEqual(['malformed-payload', 'malformed-payload', 'malformed-payload', 'malformed-payload', 'malformed-payload',
    ])

    // A criterion's shape is the contract's rule, so the refusal is the contract's own name for
    // it: the production path reads that shape, it does not own a second copy of it.
    const badCriterion = await request({ criterion: await criterion({ implementationDigest: 'short' }) })
    expect((await asyncRefusalOf(() => runProductionVerdict(badCriterion))).code).toBe('malformed-contract')
  })
})
