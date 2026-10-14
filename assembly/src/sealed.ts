import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunState, RunSubmission } from '../../src/task/protocol.ts'
import { refuse } from '../../src/protocol/refusal.ts'
import type { Apparatus } from './apparatus.ts'
import { assertRunFile } from './workspace.ts'
import { sha256 } from './ids.ts'

export async function sealedBytes(apparatus: Apparatus, ref: FileAttachmentRef): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  for await (const chunk of apparatus.attachments.readFileStream(ref)) chunks.push(chunk)
  const bytes = Buffer.concat(chunks)
  if (`sha256:${sha256(bytes)}` !== ref.attachmentId) refuse('digest-mismatch', 'sealed attachment bytes changed')
  return bytes
}

export async function sealFiles(apparatus: Apparatus, run: RunState,
  artifact: string,
  workspace: string,
): Promise<RunSubmission['files']> {
  await assertRunFile(workspace, artifact)
  return {
    artifact: await apparatus.attachments.saveFile({ name: artifact, data: await readFile(join(workspace, artifact)) }),
    inputs: run.bubble!.inputs.map((input) => ({ name: input.name, attachment: input.attachment! })),
  }
}

export async function withSealedWorkspace<T>(apparatus: Apparatus, run: RunState,
  artifact: string,
  judge: (workspace: string) => Promise<T>,
): Promise<T> {
  const workspace = await mkdtemp(join(apparatus.workspaceRoot, 'judged-'))
  try {
    const files = run.submission!.files
    const copies: readonly (readonly [string, FileAttachmentRef])[] = [
      [artifact, files.artifact],
      ...files.inputs.map((input) => [input.name, input.attachment] as const),
    ]
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
