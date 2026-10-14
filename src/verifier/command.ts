import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ProductionInput, VerifierCommand } from './production.ts'

export type VerifierCommandInput = ProductionInput

export interface VerifierCommandRequest {
    readonly command: VerifierCommand
    readonly artifactPath: string
  readonly inputs?: readonly VerifierCommandInput[]
}

export type VerifierInvocation =
  | { readonly shell: true; readonly command: string }
  | { readonly shell: false; readonly argv: readonly [string, ...string[]] }

interface VerifierProcessOutcome {
  readonly exitCode: number | null
  readonly stderr: string
  readonly failure?: string
}

export type VerifierProcess = (invocation: VerifierInvocation) => Promise<VerifierProcessOutcome>

export interface VerifierCommandResult {
  readonly verdict: 'pass' | 'fail' | 'partial' | 'unknown'
  readonly artifactDigest: string
  readonly inputDigests: readonly { readonly name: string; readonly digest: string }[]
  readonly detail: string
}

const REQUEST_MEMBERS = ['command', 'artifactPath', 'inputs'] as const
const INPUT_MEMBERS = ['name', 'digest', 'path'] as const

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    refuse('malformed-payload', `${field} must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`)
  return value as Record<string, unknown>
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    refuse('malformed-payload', `${field} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
  return value
}

function requireCommand(value: unknown, field: string): string | readonly [string, ...string[]] {
  if (typeof value === 'string') return requireText(value, field)
  if (Array.isArray(value) && value.length > 0) {
    const argv = value.map((entry, index) => requireText(entry, `${field}[${index}]`))
    return argv as [string, ...string[]]
  }
  refuse(
    'malformed-payload',
    `${field} must be a non-empty command line or a non-empty argv array, got ${JSON.stringify(value ?? null)}; a string runs through a shell, an array is spawned directly`,
  )
}

function readInputs(raw: unknown): readonly VerifierCommandInput[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) refuse('malformed-payload', 'request.inputs must be an array of {name, digest, path}')
  return raw.map((entry, index) => {
    const where = `request.inputs[${index}]`
    const input = requireRecord(entry, where)
    assertClosedKeys(input, INPUT_MEMBERS, where)
    const path = requireText(input['path'], `${where}.path`)
    if (!isAbsolute(path))
      refuse('malformed-payload', `${where}.path must be an absolute path, got ${JSON.stringify(path)}; the adapter reads bytes, not names`)
    return { name: requireText(input['name'], `${where}.name`), digest: requireText(input['digest'], `${where}.digest`), path }
  })
}

async function digestOfFile(path: string, what: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch (error) {
    refuse('evidence-input-mismatch', `${what} could not be read (${messageOf(error)}); a judgement cannot name bytes that are not there`)
  }
}

async function hashInputs(inputs: readonly VerifierCommandInput[]): Promise<readonly { name: string; digest: string }[]> {
  const digests: { name: string; digest: string }[] = []
  for (const input of inputs) digests.push({ name: input.name, digest: await digestOfFile(input.path, `input "${input.name}"`) })
  return digests
}

function clip(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 240 ? oneLine : `…${oneLine.slice(-240)}`
}

function describe(invocation: VerifierInvocation, outcome: VerifierProcessOutcome, inputs: readonly VerifierCommandInput[]): string {
  const line = invocation.shell ? invocation.command : invocation.argv.join(' ')
  const declared = inputs.length === 0 ? 'no declared inputs' : `declared inputs ${inputs.map(input => `${input.name}=${input.digest.slice(0, 12)}…`).join(', ')}`
  const where =
    outcome.exitCode === null ? `did not run${outcome.failure === undefined ? '' : ` (${outcome.failure})`}` : `exited ${outcome.exitCode}`
  const noise = outcome.stderr.trim() === '' ? '' : `; stderr: ${clip(outcome.stderr)}`
  return `"${line}" ${where}; ${declared}${noise}`
}

export async function runVerifierCommand(request: VerifierCommandRequest, runProcess: VerifierProcess): Promise<VerifierCommandResult> {
  const source = requireRecord(request, 'request')
  assertClosedKeys(source, REQUEST_MEMBERS, 'request')
  const command = requireCommand(source['command'], 'request.command')
  const artifactPath = requireText(source['artifactPath'], 'request.artifactPath')
  const inputs = readInputs(source['inputs'])

  const invocation: VerifierInvocation = typeof command === 'string' ? { shell: true, command } : { shell: false, argv: command }
  const outcome = await runProcess(invocation)
  if (outcome.failure !== undefined || outcome.exitCode === null)
    throw new Error(outcome.failure ?? 'verifier execution ended without an exit code')
  const artifactDigest = await digestOfFile(artifactPath, `the artifact ${artifactPath}`)
  const inputDigests = await hashInputs(inputs)

  return {
    verdict: outcome.exitCode === 0 ? 'pass' : outcome.exitCode === 3 ? 'partial' : outcome.exitCode === 4 ? 'unknown' : outcome.exitCode === 1 ? 'fail' : 'unknown',
    artifactDigest,
    inputDigests,
    detail: describe(invocation, outcome, inputs),
  }
}
