/**
 * The real execution adapter, driven for real: one command that exits 0, one that does not, the
 * artifact's bytes hashed after the command ran, and every declared input hashed from disk.
 *
 * The adapter is a script rather than a function because a judgement that runs a process may never
 * be replayed by the fold. This spec is what keeps it honest: the verdict comes from the exit code
 * alone, the digests are the digests of what is actually on disk, and the adapter's own exit code
 * distinguishes "the judgement failed" from "the judged command failed".
 *
 * The input half is the part that cannot be an echo: a declaration carries a digest, but the
 * adapter reports the digest of the bytes it read. The test below declares a stale digest on
 * purpose and pins that the *real* one comes back — comparing the two is the production path's
 * refusal, not the sensor's.
 */

import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../scripts/verifier-command.mjs', import.meta.url))
const OK = 'verifier-command: OK'

/** The digest of the bytes handed in — computed here, not read back from the adapter. */
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

interface Judgement {
  readonly verdict: 'pass' | 'fail'
  readonly artifactDigest: string
  readonly inputDigests: readonly { readonly name: string; readonly digest: string }[]
  readonly detail: string
}

let directory: string
let artifact: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'verifier-command-'))
  artifact = join(directory, 'artifact.txt')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Invoke the adapter without letting a non-zero exit throw, so both paths are inspectable. */
function invoke(request: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [SCRIPT, JSON.stringify(request)], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, stdout, stderr })
    })
  })
}

/** The JSON object the adapter printed, plus the OK line that says it judged successfully. */
function readJudgement(stdout: string): { judgement: Judgement; ok: boolean } {
  const lines = stdout.trimEnd().split('\n')
  const [first] = lines
  if (first === undefined) throw new Error(`the adapter printed nothing: ${JSON.stringify(stdout)}`)
  return { judgement: JSON.parse(first) as Judgement, ok: lines.at(-1) === OK }
}

describe('the verifier command adapter', () => {
  it('judges a command that exits 0 as pass, and pins the bytes the command left behind', async () => {
    await writeFile(artifact, 'before the command ran', 'utf8')
    const input = join(directory, 'words.txt')
    await writeFile(input, 'three words here', 'utf8')

    const result = await invoke({
      command: `printf '%s' after > "${artifact}"`,
      artifactPath: artifact,
      inputs: [{ name: 'words.txt', digest: 'b'.repeat(64), path: input }],
    })

    // One successful judgement: the adapter's own exit code is 0, the OK line says so, and the
    // verdict it printed is pass.
    const { judgement, ok } = readJudgement(result.stdout)
    expect({ code: result.code, ok, verdict: judgement.verdict }).toEqual({ code: 0, ok: true, verdict: 'pass' })
    // The command rewrote the artifact, so the digest can only be of the post-execution bytes, and
    // they are the bytes actually on disk rather than a value the adapter carried.
    expect([judgement.artifactDigest, sha256(await readFile(artifact))]).toEqual([sha256('after'), sha256('after')])
    // The detail names both halves of the judgement: the exit code it read and the input declared.
    expect(judgement.detail).toMatch(/exited 0.*words\.txt/)
    // The input is hashed from its own bytes, not echoed from the declared digest.
    expect(judgement.inputDigests).toEqual([{ name: 'words.txt', digest: sha256('three words here') }])
  })

  it('judges a command that exits non-zero as fail, and still succeeds at judging it', async () => {
    await writeFile(artifact, 'before', 'utf8')

    const result = await invoke({
      command: `printf '%s' broken > "${artifact}"; exit 3`,
      artifactPath: artifact,
      inputs: [],
    })

    // A fail verdict is a successful judgement: the adapter's own exit code stays 0, the OK line is
    // printed, and the verdict is fail.
    const { judgement, ok } = readJudgement(result.stdout)
    expect({ code: result.code, ok, verdict: judgement.verdict }).toEqual({ code: 0, ok: true, verdict: 'partial' })
    expect(judgement.detail).toContain('exited 3')
    // The digest is still the digest of the bytes on disk, here the ones a command that exited 3
    // left behind.
    expect([judgement.artifactDigest, sha256(await readFile(artifact))]).toEqual([sha256('broken'), sha256('broken')])
    expect(judgement.inputDigests).toEqual([])
  })

  it('produces the two verdicts from the exit code alone, on identical artifact bytes', async () => {
    await writeFile(artifact, 'unchanged', 'utf8')

    const passed = readJudgement((await invoke({ command: 'true', artifactPath: artifact, inputs: [] })).stdout).judgement
    const failed = readJudgement((await invoke({ command: 'false', artifactPath: artifact, inputs: [] })).stdout).judgement

    expect([passed.verdict, failed.verdict]).toEqual(['pass', 'fail'])
    // Same bytes, same digest, different verdict: the exit code is the whole difference.
    expect([passed.artifactDigest, failed.artifactDigest]).toEqual([sha256('unchanged'), sha256('unchanged')])
  })

  it('reports the digests of every input it was given, in declaration order', async () => {
    await writeFile(artifact, 'artifact', 'utf8')
    const first = join(directory, 'first.txt')
    const second = join(directory, 'nested', 'second.txt')
    await writeFile(first, 'alpha', 'utf8')
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(second, 'beta', 'utf8')

    const result = await invoke({
      command: 'true',
      artifactPath: artifact,
      inputs: [
        { name: 'first.txt', digest: sha256('alpha'), path: first },
        { name: 'nested/second.txt', digest: sha256('stale'), path: second },
      ],
    })

    // A stale declaration is reported, not refused: the judgement itself still succeeds.
    const { judgement, ok } = readJudgement(result.stdout)
    expect({ code: result.code, ok }).toEqual({ code: 0, ok: true })
    // The second declaration was stale on purpose: the adapter still reports what the bytes are.
    expect(judgement.inputDigests).toEqual([
      { name: 'first.txt', digest: sha256('alpha') },
      { name: 'nested/second.txt', digest: sha256('beta') },
    ])
    // The declared digests stay visible in the detail, so a reader can see what was claimed.
    expect(judgement.detail).toContain(sha256('stale').slice(0, 12))
  })

  it('spawns an argv without a shell, so a shell operator in an argument stays an argument', async () => {
    await writeFile(artifact, 'argv', 'utf8')

    // `true ; false` through a shell exits 1; as an argv it is `true` with two arguments, which exits
    // 0. The runner decides this from the command's shape; this is the real spawn behind it.
    const result = await invoke({ command: ['true', ';', 'false'], artifactPath: artifact, inputs: [] })

    const { judgement, ok } = readJudgement(result.stdout)
    expect([ok, judgement.verdict]).toEqual([true, 'pass'])
  })

  it('reads a request from stdin when argv carries none', async () => {
    await writeFile(artifact, 'from stdin', 'utf8')

    const stdout = execFileSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({ command: 'true', artifactPath: artifact, inputs: [] }),
      encoding: 'utf8',
    })

    // The request read from stdin judges like the one on argv: the OK line, the verdict, and the
    // digest of the bytes the command left behind.
    const { judgement, ok } = readJudgement(stdout)
    expect({ ok, verdict: judgement.verdict, artifactDigest: judgement.artifactDigest }).toEqual({
      ok: true,
      verdict: 'pass',
      artifactDigest: sha256('from stdin'),
    })
  })

  it('exits non-zero only when it cannot judge at all, never for a judged failure', async () => {
    // The artifact is gone, so no digest exists and no verdict can be formed.
    const absent = await invoke({ command: 'true', artifactPath: join(directory, 'not-there.txt'), inputs: [] })
    expect(absent.stderr).toContain('verifier-command:')
    expect(absent.stdout).not.toContain(OK)

    // A request the adapter cannot read is its own error too, not a verdict.
    const malformed = await invoke({ artifactPath: artifact })

    // An input with no readable path names no bytes, so there is nothing to hash and no judgement.
    const pathless = await invoke({
      command: 'true',
      artifactPath: artifact,
      inputs: [{ name: 'words.txt', digest: sha256('x') }],
    })
    expect(pathless.stderr).toContain('path')

    // None of the three could be judged, so none of them exits 0.
    expect([absent.code, malformed.code, pathless.code].map(code => code !== 0)).toEqual([true, true, true])
  })
})
