import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { prepareWorkspace } from '../src/workspace.ts'

const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A `source` domain on disk: one protected input, and a seed the submission edits in place. */
async function sourceDomain(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'assembly-ws-spec-'))
  roots.push(dir)
  await writeFile(join(dir, 'verifier.mjs'), 'process.exit(0)\n', 'utf8')
  await writeFile(join(dir, 'seed.v'), 'the original source\n', 'utf8')
  await writeFile(join(dir, 'input.txt'), 'the protected material\n', 'utf8')
  await writeFile(
    join(dir, 'task.json'),
    JSON.stringify({
      rootTemplate: 'edit',
      inputs: [{ ref: 'protected', from: 'input.txt' }],
      templates: [{ id: 'edit', goal: 'edit source', input: { name: 'in/protected.txt', source: { kind: 'protected', ref: 'protected' } },
        workspace: { submission: 'source', file: 'rtl/edited.v', artifact: 'rtl/edited.v', initial: 'seed.v' },
        criterion: { criterionId: 'built', statement: 'it builds', verifier: 'built' } }],
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
  roots.push(workspace)
  return workspace
}

describe('preparing a workspace', () => {
  it('stages the declared inputs, and the seed at the path a submission is judged on', async () => {
    const domain = await loadDomain(await sourceDomain(), spawnProcess)
    const workspace = await workspaceOf()
    await prepareWorkspace(domain.templates.get(domain.rootTemplate)!, [{ name: 'in/protected.txt', source: {kind: 'protected', ref: 'protected', digest: domain.inputs[0]!.digest}, digest: domain.inputs[0]!.digest, read: async () => domain.inputs[0]!.bytes }], workspace)
    expect([await readFile(join(workspace, 'in', 'protected.txt'), 'utf8'), await readFile(join(workspace, 'rtl', 'edited.v'), 'utf8')]).toEqual([
      'the protected material\n',
      'the original source\n',
    ])
  })

  it('stages the bytes it digested even when the declared source has changed since', async () => {
    const dir = await sourceDomain()
    const domain = await loadDomain(dir, spawnProcess)
    await writeFile(join(dir, 'input.txt'), 'something else entirely\n', 'utf8')
    const workspace = await workspaceOf()
    await prepareWorkspace(domain.templates.get(domain.rootTemplate)!, [{ name: 'in/protected.txt', source: {kind: 'protected', ref: 'protected', digest: domain.inputs[0]!.digest}, digest: domain.inputs[0]!.digest, read: async () => domain.inputs[0]!.bytes }], workspace)
    const staged = await readFile(join(workspace, 'in', 'protected.txt'))
    expect([sha256(staged), staged.toString('utf8')]).toEqual([domain.inputs[0]?.digest, 'the protected material\n'])
  })

  it('refuses to prepare an existing Run workspace and preserves its frozen files', async () => {
    const domain = await loadDomain(await sourceDomain(), spawnProcess)
    const workspace = await workspaceOf()
    await prepareWorkspace(domain.templates.get(domain.rootTemplate)!, [{ name: 'in/protected.txt', source: {kind: 'protected', ref: 'protected', digest: domain.inputs[0]!.digest}, digest: domain.inputs[0]!.digest, read: async () => domain.inputs[0]!.bytes }], workspace)
    await writeFile(join(workspace, 'rtl', 'edited.v'), 'what the model produced\n', 'utf8')
    await expect(prepareWorkspace(domain.templates.get(domain.rootTemplate)!, [{ name: 'in/protected.txt', source: {kind: 'protected', ref: 'protected', digest: domain.inputs[0]!.digest}, digest: domain.inputs[0]!.digest, read: async () => domain.inputs[0]!.bytes }], workspace)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(workspace, 'rtl', 'edited.v'), 'utf8')).toBe('what the model produced\n')
  })
})
