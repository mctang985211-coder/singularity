/**
 * Preparing a task workspace: what is staged, and what is deliberately left alone.
 *
 * Every case drives the real loader over a real declaration on disk, so the bytes under test are bytes a
 * deployment would run — not literals this file chose.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/submission.ts'
import { prepareWorkspace } from '../src/workspace.ts'

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

let scratch: string | undefined

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

/** A `source` domain on disk: one protected input, and a seed the submission edits in place. */
async function sourceDomain(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'assembly-ws-spec-'))
  scratch = dir
  await writeFile(join(dir, 'verifier.mjs'), 'process.exit(0)\n', 'utf8')
  await writeFile(join(dir, 'seed.v'), 'the original source\n', 'utf8')
  await writeFile(join(dir, 'input.txt'), 'the protected material\n', 'utf8')
  await writeFile(
    join(dir, 'task.json'),
    JSON.stringify({
      inputs: [{ path: 'in/protected.txt', from: 'input.txt' }],
      workspace: { submission: 'source', file: 'rtl/edited.v', artifact: 'rtl/edited.v', initial: 'seed.v' },
      criteria: [{ criterionId: 'built', statement: 'it builds', verifier: 'built' }],
      verifiers: [
        {
          ref: 'built',
          version: '1',
          program: 'verifier.mjs',
          args: ['{artifact}', '{input}'],
          selftest: [
            { name: 'accepts', expected: 'pass', artifact: 'input.txt', argv: ['input.txt', 'input.txt'] },
            { name: 'rejects', expected: 'fail', artifact: 'seed.v', argv: ['seed.v', 'input.txt'] },
          ],
        },
      ],
    }),
    'utf8',
  )
  return dir
}

const workspaceOf = async (): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), 'assembly-ws-out-'))
  scratch = workspace
  return workspace
}

describe('preparing a workspace', () => {
  it('stages the declared inputs, and the seed at the path a submission is judged on', async () => {
    const domain = await loadDomain(await sourceDomain(), spawnProcess)
    const workspace = await workspaceOf()
    await prepareWorkspace(domain, workspace)
    expect([await readFile(join(workspace, 'in', 'protected.txt'), 'utf8'), await readFile(join(workspace, 'rtl', 'edited.v'), 'utf8')]).toEqual([
      'the protected material\n',
      'the original source\n',
    ])
  })

  it('stages the bytes it digested even when the declared source has changed since', async () => {
    const dir = await sourceDomain()
    const domain = await loadDomain(dir, spawnProcess)
    // The deployment's material changes under it, which is the only situation where "read the source
    // again" and "write what was digested" disagree.
    await writeFile(join(dir, 'input.txt'), 'something else entirely\n', 'utf8')
    const workspace = await workspaceOf()
    await prepareWorkspace(domain, workspace)
    const staged = await readFile(join(workspace, 'in', 'protected.txt'))
    expect([sha256(staged), staged.toString('utf8')]).toEqual([domain.inputs[0]?.digest, 'the protected material\n'])
  })

  it('leaves a submission in place when the workspace is prepared again', async () => {
    const domain = await loadDomain(await sourceDomain(), spawnProcess)
    const workspace = await workspaceOf()
    await prepareWorkspace(domain, workspace)
    await writeFile(join(workspace, 'rtl', 'edited.v'), 'what the model produced\n', 'utf8')
    await prepareWorkspace(domain, workspace)
    // A boot re-prepares the workspaces of in-flight runs, so a second prepare happens after a model has
    // worked: restoring the seed would make a settled attempt's artifact disagree with its own digest.
    expect(await readFile(join(workspace, 'rtl', 'edited.v'), 'utf8')).toBe('what the model produced\n')
  })
})
