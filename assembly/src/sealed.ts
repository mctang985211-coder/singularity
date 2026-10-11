import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { RunState, RunSubmission } from '../../src/task/protocol.ts'
import type { Apparatus } from './apparatus.ts'
import type { TaskTemplate } from './template.ts'

export async function sealedBytes(apparatus: Apparatus, ref: FileAttachmentRef): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of apparatus.attachments.readFileStream(ref)) chunks.push(chunk)
  return Buffer.concat(chunks)
}

export async function sealFiles(apparatus: Apparatus, run: RunState, template: TaskTemplate, workspace: string): Promise<RunSubmission['files']> {
  const save = async (name: string): Promise<FileAttachmentRef> =>
    apparatus.attachments.saveFile({ name: basename(name), data: await readFile(join(workspace, name)) })
  return { program: await save(template.file), artifact: await save(template.artifact),
    inputs: await Promise.all(run.bubble!.inputs.map(async input => ({ name: input.name, attachment: await save(input.name) }))) }
}

export async function withSealedWorkspace<T>(apparatus: Apparatus, run: RunState, template: TaskTemplate,
  judge: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(apparatus.workspaceRoot, 'judged-'))
  try {
    const files = run.submission!.files
    const copies = new Map([[template.file, files.program], [template.artifact, files.artifact],
      ...files.inputs.map(input => [input.name, input.attachment] as const)])
    for (const [name, ref] of copies) {
      const path = join(workspace, name)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, await sealedBytes(apparatus, ref), { flag: 'wx', mode: 0o400 })
    }
    return await judge(workspace)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}
