/**
 * The generic verifier command runner: one invocation, the bytes that were there, one verdict.
 *
 * The runner may not spawn anything itself — no module under `src/` may name a process executor — so
 * execution is a port and this spec hands it a fake. That is the stronger test, not the weaker one:
 * the *decision* (shell line or argv, verdict from the exit code, what is read after the run) is
 * observed directly, and `tests/verifier-command.spec.ts` drives the real `spawn` through the CLI.
 *
 * Nothing here is an echo of the request: the fake process writes the artifact and the input, so a
 * digest taken before the run could only fail to be read at all.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  runVerifierCommand,
  type VerifierCommandInput,
  type VerifierCommandRequest,
  type VerifierCommandResult,
  type VerifierInvocation,
  type VerifierProcess,
} from '../src/index.ts'
import { asyncRefusalOf } from './fixtures.ts'

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
/** A process that ran and exited with this code. */
const exited = (exitCode: number, stderr = ''): VerifierProcess => async () => ({ exitCode, stderr })

let directory: string
let artifact: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'verifier-runner-'))
  artifact = join(directory, 'artifact.txt')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('the verifier command runner', () => {
  it('judges an exit code of 0 as pass, hashing the artifact the process left behind', async () => {
    // The artifact does not exist until the process has run, so only a digest read after it can be
    // this digest — and a runner that read first would have refused instead.
    const port: VerifierProcess = async () => {
      await writeFile(artifact, 'after', 'utf8')
      return { exitCode: 0, stderr: '' }
    }

    const result: VerifierCommandResult = await runVerifierCommand({ command: 'write it', artifactPath: artifact, inputs: [] }, port)

    expect([result.verdict, result.artifactDigest]).toEqual(['pass', sha256('after')])
  })

  it('judges a non-zero exit as fail, and reports the input bytes that were there after the run', async () => {
    const input = join(directory, 'input.txt')
    const port: VerifierProcess = async () => {
      await writeFile(input, 'changed', 'utf8')
      await writeFile(artifact, 'broken', 'utf8')
      return { exitCode: 3, stderr: 'the report is wrong' }
    }
    const inputs: readonly VerifierCommandInput[] = [{ name: 'input.txt', digest: sha256('before'), path: input }]
    const request: VerifierCommandRequest = { command: 'judge it', artifactPath: artifact, inputs }

    const result = await runVerifierCommand(request, port)

    expect([result.verdict, result.artifactDigest, result.inputDigests]).toEqual([
      'fail',
      sha256('broken'),
      [{ name: 'input.txt', digest: sha256('changed') }],
    ])
  })

  it("decides the invocation from the command's shape: a string through a shell, an argv without one", async () => {
    await writeFile(artifact, 'artifact', 'utf8')
    const invocations: VerifierInvocation[] = []
    const port: VerifierProcess = async invocation => {
      invocations.push(invocation)
      return { exitCode: 0, stderr: '' }
    }

    await runVerifierCommand({ command: 'true', artifactPath: artifact, inputs: [] }, port)
    await runVerifierCommand({ command: ['true', ';', 'false'], artifactPath: artifact, inputs: [] }, port)

    expect(invocations).toEqual([
      { shell: true, command: 'true' },
      { shell: false, argv: ['true', ';', 'false'] },
    ])
  })

  it('refuses an artifact that is not there, by name, instead of an empty success', async () => {
    const absent = join(directory, 'not-there.txt')

    // The process exited 0 and the judgement still cannot be formed, because no digest exists.
    const refusal = await asyncRefusalOf(() => runVerifierCommand({ command: 'true', artifactPath: absent, inputs: [] }, exited(0)))

    expect([refusal.code, refusal.detail.includes(absent)]).toEqual(['evidence-input-mismatch', true])
  })

  it('refuses an input whose bytes are not there, by name', async () => {
    await writeFile(artifact, 'artifact', 'utf8')

    const refusal = await asyncRefusalOf(() =>
      runVerifierCommand(
        { command: 'true', artifactPath: artifact, inputs: [{ name: 'words.txt', digest: sha256('x'), path: join(directory, 'missing.txt') }] },
        exited(0),
      ),
    )

    expect([refusal.code, refusal.detail.includes('words.txt')]).toEqual(['evidence-input-mismatch', true])
  })

  it('rejects verifier execution failure without producing an acceptance verdict', async () => {
    await writeFile(artifact, 'artifact', 'utf8')
    const port: VerifierProcess = async () => ({ exitCode: null, stderr: '', failure: 'spawn nope ENOENT' })

    await expect(runVerifierCommand({ command: 'nope', artifactPath: artifact, inputs: [] }, port)).rejects.toThrow('spawn nope ENOENT')
  })

  it('rejects runtime failure even when an invocation reports exit zero', async () => {
    await writeFile(artifact, 'artifact', 'utf8')
    await expect(runVerifierCommand({ command: 'true', artifactPath: artifact }, async () => ({
      exitCode: 0, stderr: '', failure: 'process output limit',
    }))).rejects.toThrow('process output limit')
  })
})
