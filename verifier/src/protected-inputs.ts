import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sha256Hex } from '@dangosys/dsh-singularity-task'
import type { ProtectedInputRef } from '@dangosys/dsh-singularity-task'

/** Every defect among `inputs` read against `cwd`: a declared path that is missing, unreadable, or changed. */
export async function protectedInputDefects(cwd: string, inputs: readonly ProtectedInputRef[]): Promise<string[]> {
  const defects: string[] = []
  for (const input of inputs) {
    const path = input.path
    const admitted = input.sha256
    let bytes: Buffer
    try {
      bytes = await readFile(resolve(cwd, path))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      defects.push(`protected input "${path}" is missing or unreadable: ${reason}`)
      continue
    }
    const digest = sha256Hex(bytes)
    if (digest !== admitted) {
      defects.push(`protected input "${path}" changed since admission (admitted sha256 ${admitted}, now ${digest})`)
    }
  }
  return defects
}
