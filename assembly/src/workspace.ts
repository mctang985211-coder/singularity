import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PreparedInput } from './inputs.ts'
import type { TaskTemplate } from './template.ts'

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
