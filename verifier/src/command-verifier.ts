import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { AcceptanceCriterion, VerificationMode, VerificationResult } from '@dangosys/dsh-singularity-task'
import { sampleCriterion, type Verifier, type VerifierSelftest, type VerifyRequest } from './types.ts'

const EXECUTABLE_MODES: readonly VerificationMode[] = ['deterministic', 'simulation', 'measurement']

/** Grace the subprocess provider's own termination procedure gets to end a timed-out command's process range. */
const TERMINATION_GRACE_MS = 5000

interface CommandOutcome {
  exitCode?: number
  timedOut?: boolean
  error?: Error
}

/**
 * The confined policy one criterion command runs under: the deployment's own
 * mode, rooted at the workspace the command runs in — that workspace is the one
 * subtree a confined command may write. `undefined` means the resolved policy
 * grants full access, so the command runs unconfined.
 */
function confinedPolicy(resolved: SandboxExecutionPolicy | undefined, cwd: string): SandboxPolicy | undefined {
  if (resolved?.mode === 'danger-full-access') return undefined
  return { mode: resolved?.mode === 'read-only' ? 'read-only' : 'workspace-write', workspaceRoot: cwd }
}

/** Resolve once one piped stream has no writer left, so an outcome never settles before its output reached the log. */
function drained(stream: Readable | undefined): Promise<void> {
  return new Promise(resolve => {
    if (stream === undefined || stream.readableEnded) {
      resolve()
      return
    }
    stream.once('end', () => resolve())
    stream.once('close', () => resolve())
  })
}

/** Kill the command and everything it started: `shell: true` forks compound commands, and the negative-pid kill reaches the tree. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** The one line a log carries when the command itself wrote nothing — an empty log makes a failure undiagnosable. */
function outcomeLine(outcome: CommandOutcome): string {
  if (outcome.error !== undefined) return outcome.error.message
  if (outcome.timedOut === true) return '(no output) timed out'
  return `(no output) exit code ${outcome.exitCode ?? 'unknown'}`
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number | undefined,
  logPath: string,
): Promise<CommandOutcome> {
  return new Promise(resolveOutcome => {
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = createWriteStream(logPath)
    let outputBytes = 0
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
      })
      stream.pipe(log, { end: false })
    }
    let timedOut = false
    let settled = false
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            killTree(child)
          }, timeoutMs)
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      // The log holds exactly what the command wrote; only a command that wrote
      // nothing leaves room for the outcome line, so a silent failure is still
      // readable and nothing the command said is ever changed.
      if (outputBytes === 0) log.write(`${outcomeLine(outcome)}\n`)
      log.end(() => resolveOutcome(outcome))
    }
    child.on('error', error => finish({ error }))
    child.on('close', code => finish(code === null ? { timedOut } : { exitCode: code, timedOut }))
  })
}

/**
 * Run one confined command through the subprocess seam, piping its output into
 * the criterion log exactly as the unconfined path does. Termination is the
 * provider's own managed-range procedure, so a timed-out command's whole tree
 * dies with it.
 */
function runConfined(
  subprocess: SubprocessRuntime,
  argv: readonly string[],
  cwd: string,
  timeoutMs: number | undefined,
  logPath: string,
): Promise<CommandOutcome> {
  return new Promise(resolveOutcome => {
    let handle
    try {
      handle = subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: TERMINATION_GRACE_MS,
      })
    } catch (error) {
      resolveOutcome({ error: messageError(error) })
      return
    }
    const log = createWriteStream(logPath)
    let outputBytes = 0
    const ends: Promise<void>[] = []
    for (const stream of [handle.stdout, handle.stderr]) {
      stream?.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
      })
      stream?.pipe(log, { end: false })
      ends.push(drained(stream))
    }
    let timedOut = false
    let settled = false
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            handle.terminate()
          }, timeoutMs)
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      // The log holds exactly what the command wrote; only a command that wrote
      // nothing leaves room for the outcome line, so a silent failure is still
      // readable and nothing the command said is ever changed.
      if (outputBytes === 0) log.write(`${outcomeLine(outcome)}\n`)
      log.end(() => resolveOutcome(outcome))
    }
    handle.done.then(
      outcome =>
        void Promise.all(ends).then(() =>
          finish(outcome.exitCode === null ? { timedOut } : { exitCode: outcome.exitCode, timedOut }),
        ),
      error => finish({ error: messageError(error) }),
    )
  })
}

/** The thrown error's message, or the value itself when it is not an error. */
function messageError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function logFileName(criterionId: string): string {
  return `${criterionId.replace(/[^A-Za-z0-9._-]/g, '_')}.log`
}

/** Runs each criterion's `command` through a shell and judges by exit code; output goes to the criterion log. */
export class CommandVerifier implements Verifier {
  readonly id = 'command'
  readonly version = '1'
  /** Known samples: an exit-zero command must come back `pass`, an exit-non-zero one must come back `fail`. */
  readonly selftest: VerifierSelftest = {
    samples: [
      {
        role: 'positive',
        name: 'a command that exits zero',
        criterion: sampleCriterion({ criterionId: 'selftest-exit-zero', command: 'true' }),
        expect: 'pass',
      },
      {
        role: 'negative',
        name: 'a command that exits non-zero',
        criterion: sampleCriterion({ criterionId: 'selftest-exit-non-zero', command: 'false' }),
        expect: 'fail',
      },
    ],
  }

  constructor(private readonly ctx: Context, private readonly evidenceRoot: string) {}

  supports(mode: VerificationMode): boolean {
    return EXECUTABLE_MODES.includes(mode)
  }

  async verify(req: VerifyRequest): Promise<VerificationResult[]> {
    return Promise.all(req.criteria.map(criterion => this.runCriterion(req, criterion)))
  }

  private async runCriterion(req: VerifyRequest, criterion: AcceptanceCriterion): Promise<VerificationResult> {
    const base = { criterionId: criterion.criterionId, verifierId: this.id, command: criterion.command }
    // Every inconclusive this verifier reports is task-side (KISS §4.3 UNKNOWN_TASK): never tested.
    if (criterion.command === undefined || criterion.command.trim() === '') {
      return { ...base, status: 'inconclusive', details: 'criterion has no command', unknownKind: 'task' }
    }
    await mkdir(req.logDir, { recursive: true })
    const logPath = join(req.logDir, logFileName(criterion.criterionId))
    const logRef = relative(this.evidenceRoot, logPath)
    const outcome = await this.execute(criterion.command, req.cwd, req.timeoutMs, logPath)
    if (outcome.error !== undefined) {
      return { ...base, status: 'inconclusive', logRef, details: outcome.error.message, unknownKind: 'task' }
    }
    if (outcome.timedOut === true) {
      return {
        ...base,
        status: 'inconclusive',
        logRef,
        details: `timeout after ${req.timeoutMs}ms`,
        unknownKind: 'task',
      }
    }
    return { ...base, status: outcome.exitCode === 0 ? 'pass' : 'fail', exitCode: outcome.exitCode, logRef }
  }

  /**
   * Run one criterion command in the workspace it judges. A context that mounts
   * the deployment's confinement seam runs it through that seam, under the
   * resolved mode rooted at `cwd`; a context without one spawns the command
   * itself, exactly as before.
   */
  private async execute(
    command: string,
    cwd: string,
    timeoutMs: number | undefined,
    logPath: string,
  ): Promise<CommandOutcome> {
    const sandbox = this.ctx.get?.('sandbox')
    const subprocess = this.ctx.get?.('subprocess')
    if (sandbox === undefined || subprocess === undefined) return runCommand(command, cwd, timeoutMs, logPath)
    const policy = confinedPolicy(this.ctx.get?.('sandboxPolicy')?.resolve(), cwd)
    if (policy === undefined) return runCommand(command, cwd, timeoutMs, logPath)
    const confined = await sandbox.confine(['bash', '-c', command], policy)
    return runConfined(subprocess, confined.argv, cwd, timeoutMs, logPath)
  }
}
