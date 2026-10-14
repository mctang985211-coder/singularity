import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { PreparedInput } from './inputs.ts'
import type { TaskTemplate } from './template.ts'
import { refuse } from '../../src/protocol/refusal.ts'

export async function assertRunFile(workspace: string, name: string): Promise<void> {
  let path = workspace
  for (const part of relative(workspace, join(workspace, name)).split(sep)) {
    path = join(path, part)
    try {
      if ((await lstat(path)).isSymbolicLink()) refuse('evidence-input-mismatch', 'Run submission path contains a symbolic link: ' + path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export async function prepareWorkspace(template: TaskTemplate, inputs: readonly PreparedInput[], workspace: string): Promise<void> {
  for (const input of inputs) {
    const target = join(workspace, input.name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await input.read(), { flag: 'wx' })
  }
  if (template.initial === undefined) return
  const seed = join(workspace, template.file)
  await mkdir(dirname(seed), { recursive: true })
  await writeFile(seed, template.initial.bytes, { flag: 'wx' })
}
