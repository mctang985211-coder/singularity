import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { refuse } from '../../src/protocol/refusal.ts'

const described = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value

function record(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('malformed-declaration', `${where} must be an object, got ${described(value)}`)
  return value as Record<string, unknown>
}
function list(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) refuse('malformed-declaration', `${where} must be a list, got ${described(value)}`)
  return value
}
function nonEmpty(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-declaration', `${where} must be a non-empty string, got ${described(value)}`)
  return value
}
const text = (source: Record<string, unknown>, key: string, where: string): string =>
  nonEmpty(source[key], `${where}.${key}`)

async function readBytes(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    refuse(
      'malformed-declaration',
      `${what} (${path}) could not be read (${error instanceof Error ? error.message : String(error)}); declared material that is not there cannot be run`,
    )
  }
}
function inside(root: string, name: string, where: string): string {
  if (isAbsolute(name))
    refuse(
      'malformed-declaration',
      `${where} is ${JSON.stringify(name)}, an absolute path; a declared name lives inside the tree it belongs to`,
    )
  const within = relative(resolve(root), resolve(root, name))
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within))
    refuse('malformed-declaration', `${where} is ${JSON.stringify(name)}, which resolves outside ${root}`)
  return resolve(root, name)
}
export { record, list, nonEmpty, text, readBytes, inside }
