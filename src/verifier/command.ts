/**
 * The generic verifier command runner: one invocation, the bytes that were there, one verdict.
 *
 * **Execution is a port, and that is not a detail.** No module under `src/` may name a process
 * executor — a general executor runs whatever a string says, a shell redirection into a file among
 * them, and this stack's medium is DSH session persistence. So the runner decides *what* to run and
 * the deployment performs it: `runVerifierCommand` is handed a {@link VerifierProcess} and hands it a
 * {@link VerifierInvocation} that already says whether a shell is involved. The CLI over this runner
 * (`scripts/verifier-command.mjs`) wires the real `spawn`; a spec wires a fake and observes the
 * decision directly, which is the point of naming it.
 *
 * Five properties are the whole of the judgement:
 *
 * 1. **The verdict is the exit code, and nothing else.** Zero passes; anything else fails, including
 *    an invocation the deployment could not start at all (`exitCode: null`), which fails closed so a
 *    command that never ran is never a pass. The reader's account of that travels in the detail.
 * 2. **The artifact is hashed after the run.** The digest names the bytes the verdict was formed on,
 *    so it is read from disk once the process is gone, never carried in from before it.
 * 3. **The inputs are hashed after the run**, for the same reason and in declaration order: the bytes
 *    reported are the bytes that were there when the judgement was formed.
 * 4. **A string runs through a shell; an argv is spawned directly.** The distinction belongs to the
 *    command's own shape: a command line is a shell's business, an argv is not, and joining an argv
 *    into a shell line would reinterpret its arguments.
 * 5. **A missing artifact or input is a named refusal.** Bytes that cannot be read cannot be hashed,
 *    and a judgement that named no bytes would be an empty success — the one outcome this module
 *    exists to make impossible.
 *
 * The refusal codes are the ones that already mean these failures everywhere else: a shape that is
 * not a request is `malformed-payload`, and bytes that are not there are `evidence-input-mismatch`,
 * exactly as `production.ts` refuses the same two files on the in-process path. No new code is
 * invented, because a refusal code is protocol, not a detail of this adapter.
 *
 * @module singularity-core/verifier/command
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import { assertClosedKeys } from '../protocol/envelope.ts'
import { refuse } from '../protocol/refusal.ts'
import type { ProductionInput, VerifierCommand } from './production.ts'

/**
 * The declared input, in the shape `production.ts` owns: a name, the digest claimed for it, and the
 * absolute path its bytes will be read from. Named here as well as there because this module's
 * callers hand inputs in, and one shape with one owner is what keeps the two from drifting.
 */
export type VerifierCommandInput = ProductionInput

/** Everything one execution needs. `inputs` absent means the judgement declared none. */
export interface VerifierCommandRequest {
  /** A shell command line, or an argv spawned without a shell. */
  readonly command: VerifierCommand
  /** Absolute path of the artifact the verdict is formed on; hashed after the run. */
  readonly artifactPath: string
  readonly inputs?: readonly VerifierCommandInput[]
}

/** One invocation as the runner decided it: a shell line, or an argv that needs no shell. */
export type VerifierInvocation =
  | { readonly shell: true; readonly command: string }
  | { readonly shell: false; readonly argv: readonly [string, ...string[]] }

/**
 * What running one invocation reported. `exitCode: null` means it never started, and `failure` says
 * why — the two halves of "the command did not run", which is a failed judgement rather than a
 * thrown one. Not exported: the shape is the port's, and a deployment implements it by context.
 */
interface VerifierProcessOutcome {
  readonly exitCode: number | null
  readonly stderr: string
  readonly failure?: string
}

/** The execution port. The deployment wires it; nothing under `src/` can perform it. */
export type VerifierProcess = (invocation: VerifierInvocation) => Promise<VerifierProcessOutcome>

/** What one execution reported: the verdict, the bytes it was formed on, and one line of why. */
export interface VerifierCommandResult {
  readonly verdict: 'pass' | 'fail'
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

/**
 * The command, read as one of its two shapes.
 *
 * The tuple type is what lets the invocation name a program without a second, unreachable guard: a
 * non-empty argv has a first element, and that is what the check above establishes.
 */
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

/** The declared inputs, closed and read literally: an absent member stays absent, not invented. */
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

/** The real content digest of one file's bytes, or a named refusal when there are none. */
async function digestOfFile(path: string, what: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch (error) {
    refuse('evidence-input-mismatch', `${what} could not be read (${messageOf(error)}); a judgement cannot name bytes that are not there`)
  }
}

/** Every input's real digest, in the order the inputs were declared, all read after the run. */
async function hashInputs(inputs: readonly VerifierCommandInput[]): Promise<readonly { name: string; digest: string }[]> {
  const digests: { name: string; digest: string }[] = []
  for (const input of inputs) digests.push({ name: input.name, digest: await digestOfFile(input.path, `input "${input.name}"`) })
  return digests
}

/** One line, bounded: a detail a receipt can carry without becoming a log of its own. */
function clip(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 240 ? oneLine : `…${oneLine.slice(-240)}`
}

/** What the reader needs to see why this verdict is this verdict. */
function describe(invocation: VerifierInvocation, outcome: VerifierProcessOutcome, inputs: readonly VerifierCommandInput[]): string {
  const line = invocation.shell ? invocation.command : invocation.argv.join(' ')
  const declared = inputs.length === 0 ? 'no declared inputs' : `declared inputs ${inputs.map(input => `${input.name}=${input.digest.slice(0, 12)}…`).join(', ')}`
  const where =
    outcome.exitCode === null ? `did not run${outcome.failure === undefined ? '' : ` (${outcome.failure})`}` : `exited ${outcome.exitCode}`
  const noise = outcome.stderr.trim() === '' ? '' : `; stderr: ${clip(outcome.stderr)}`
  return `"${line}" ${where}; ${declared}${noise}`
}

/**
 * Execute one request through the deployment's process port and report the judgement.
 *
 * The request's shape is decided before the port is asked anything, so a value that is not a request
 * never reaches a process. The invocation is then decided from the command's own shape, the process
 * is run, and only then are the artifact and the inputs read.
 */
export async function runVerifierCommand(request: VerifierCommandRequest, runProcess: VerifierProcess): Promise<VerifierCommandResult> {
  const source = requireRecord(request, 'request')
  assertClosedKeys(source, REQUEST_MEMBERS, 'request')
  const command = requireCommand(source['command'], 'request.command')
  const artifactPath = requireText(source['artifactPath'], 'request.artifactPath')
  const inputs = readInputs(source['inputs'])

  const invocation: VerifierInvocation = typeof command === 'string' ? { shell: true, command } : { shell: false, argv: command }
  const outcome = await runProcess(invocation)
  const artifactDigest = await digestOfFile(artifactPath, `the artifact ${artifactPath}`)
  const inputDigests = await hashInputs(inputs)

  return {
    verdict: outcome.exitCode === 0 ? 'pass' : 'fail',
    artifactDigest,
    inputDigests,
    detail: describe(invocation, outcome, inputs),
  }
}
