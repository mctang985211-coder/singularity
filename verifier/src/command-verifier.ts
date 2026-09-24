import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { AcceptanceCriterion, VerificationMode, VerificationResult } from '@dangosys/dsh-singularity-task'
import type { Verifier, VerifierSelftest, VerifyRequest } from './types.ts'

const EXECUTABLE_MODES: readonly VerificationMode[] = ['deterministic', 'simulation', 'measurement']

/** The criterion a selftest sample hands this verifier: the fields it reads, with the command the sample's verdict rests on. */
function sampleCriterion(criterionId: string, command: string): AcceptanceCriterion {
  return {
    criterionId,
    description: 'a selftest sample',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    command,
  }
}

interface CommandOutcome {
  exitCode?: number
  timedOut?: boolean
  error?: Error
}

/**
 * Kill the command and everything it started. `shell: true` spawns a shell that
 * forks compound commands (`a && b`): killing the shell alone leaves those
 * grandchildren alive and holding the stdio pipes open, so `close` — and with
 * it the timeout verdict — would still wait for them to finish on their own.
 * `detached: true` makes the shell a process-group leader, so the negative-pid
 * kill reaches the whole tree. Platforms without process groups fall back to
 * killing the shell.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number | undefined, logPath: string): Promise<CommandOutcome> {
  return new Promise(resolveOutcome => {
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const log = createWriteStream(logPath)
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    let timedOut = false
    let settled = false
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          killTree(child)
        }, timeoutMs)
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      log.end(() => resolveOutcome(outcome))
    }
    child.on('error', error => finish({ error }))
    child.on('close', code => finish(code === null ? { timedOut } : { exitCode: code, timedOut }))
  })
}

function logFileName(criterionId: string): string {
  return `${criterionId.replace(/[^A-Za-z0-9._-]/g, '_')}.log`
}

/**
 * Runs each criterion's `command` through a shell in the request cwd and
 * judges by exit code. Combined stdout+stderr goes to
 * `<logDir>/<criterionId>.log`; results reference it relative to evidenceRoot.
 */
export class CommandVerifier implements Verifier {
  readonly id = 'command'
  readonly version = '1'
  readonly owner = 'singularity'
  /**
   * Known samples the registry executes before it will register this judge
   * (KISS §4.3, V2-1): a command that exits zero must come back `pass`, one
   * that exits non-zero must come back `fail`. Both go through the same shell
   * path production uses, so the proof is this verifier's own exit-code
   * reading, executed — not a description of it.
   */
  readonly selftest: VerifierSelftest = {
    samples: [
      { role: 'positive', name: 'a command that exits zero', criterion: sampleCriterion('selftest-exit-zero', 'true'), expect: 'pass' },
      { role: 'negative', name: 'a command that exits non-zero', criterion: sampleCriterion('selftest-exit-non-zero', 'false'), expect: 'fail' },
    ],
  }

  constructor(private readonly evidenceRoot: string) {}

  supports(mode: VerificationMode): boolean {
    return EXECUTABLE_MODES.includes(mode)
  }

  async verify(req: VerifyRequest): Promise<VerificationResult[]> {
    return Promise.all(req.criteria.map(criterion => this.runCriterion(req, criterion)))
  }

  private async runCriterion(req: VerifyRequest, criterion: AcceptanceCriterion): Promise<VerificationResult> {
    const base = { criterionId: criterion.criterionId, verifierId: this.id, command: criterion.command }
    // Every inconclusive this verifier reports is task-side (KISS §4.3
    // UNKNOWN_TASK): the command was missing, never started, or timed out —
    // the criterion was never tested.
    if (criterion.command === undefined || criterion.command.trim() === '') {
      return { ...base, status: 'inconclusive', details: 'criterion has no command', unknownKind: 'task' }
    }
    await mkdir(req.logDir, { recursive: true })
    const logPath = join(req.logDir, logFileName(criterion.criterionId))
    const logRef = relative(this.evidenceRoot, logPath)
    const outcome = await runCommand(criterion.command, req.cwd, req.timeoutMs, logPath)
    if (outcome.error !== undefined) {
      return { ...base, status: 'inconclusive', logRef, details: outcome.error.message, unknownKind: 'task' }
    }
    if (outcome.timedOut === true) {
      return { ...base, status: 'inconclusive', logRef, details: `timeout after ${req.timeoutMs}ms`, unknownKind: 'task' }
    }
    return { ...base, status: outcome.exitCode === 0 ? 'pass' : 'fail', exitCode: outcome.exitCode, logRef }
  }
}
