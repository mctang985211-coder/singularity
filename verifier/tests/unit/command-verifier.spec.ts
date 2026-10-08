import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { AcceptanceCriterion } from '../../../task/src/types.ts'
import type { VerifyRequest } from '../../src/types.ts'
import { CommandVerifier } from '../../src/command-verifier.ts'

/** A context without the deployment's confinement services: this suite judges the command path itself. */
const UNCONFINED = {} as never

function criterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    criterionId: 'c1',
    description: 'exits zero',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    ...overrides,
  }
}

async function setup() {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'verifier-evidence-'))
  const cwd = await mkdtemp(join(tmpdir(), 'verifier-cwd-'))
  const verifier = new CommandVerifier(UNCONFINED, evidenceRoot)
  const request = (criteria: AcceptanceCriterion[], timeoutMs?: number): VerifyRequest => ({
    taskId: 't1',
    runId: 'r1',
    criteria,
    cwd,
    logDir: join(evidenceRoot, 'sg-t-root', 'r1'),
    timeoutMs,
  })
  return { evidenceRoot, cwd, verifier, request }
}

describe('CommandVerifier', () => {
  test('supports executable modes only', async () => {
    const { verifier } = await setup()
    expect(verifier.supports('deterministic')).toBe(true)
    expect(verifier.supports('simulation')).toBe(true)
    expect(verifier.supports('measurement')).toBe(true)
    expect(verifier.supports('review')).toBe(false)
    expect(verifier.supports('formal')).toBe(false)
    expect(verifier.supports('composite')).toBe(false)
  })

  test('exit code 0 passes and merges stdout with stderr into a relative-referenced log', async () => {
    const { evidenceRoot, verifier, request } = await setup()
    const [result] = await verifier.verify(
      request([
        criterion({ command: "node -e \"process.stdout.write('out'); process.stderr.write('err'); process.exit(0)\"" }),
      ]),
    )
    expect(result.status).toBe('pass')
    expect(result.exitCode).toBe(0)
    expect(result.verifierId).toBe('command')
    expect(result.logRef).toBe('sg-t-root/r1/c1.log')
    expect(isAbsolute(result.logRef!)).toBe(false)
    const log = await readFile(join(evidenceRoot, result.logRef!), 'utf8')
    expect(log).toContain('out')
    expect(log).toContain('err')
  })

  test('non-zero exit code fails', async () => {
    const { verifier, request } = await setup()
    const [result] = await verifier.verify(request([criterion({ command: 'node -e "process.exit(1)"' })]))
    expect(result.status).toBe('fail')
    expect(result.exitCode).toBe(1)
    expect(result.logRef).toBe('sg-t-root/r1/c1.log')
  })

  test('timeout kills the command and reports inconclusive', async () => {
    const { verifier, request } = await setup()
    const [result] = await verifier.verify(
      request([criterion({ command: 'node -e "setTimeout(() => {}, 30000)"' })], 200),
    )
    expect(result.status).toBe('inconclusive')
    expect(result.details).toContain('timeout')
    expect(result.exitCode).toBeUndefined()
  })

  test('missing command is inconclusive and writes no log', async () => {
    const { verifier, request } = await setup()
    const [result] = await verifier.verify(request([criterion()]))
    expect(result.status).toBe('inconclusive')
    expect(result.details).toBe('criterion has no command')
    expect(result.logRef).toBeUndefined()
  })

  test('every inconclusive is a task-side unknown: the command was missing or never finished', async () => {
    const { verifier, request } = await setup()
    const [noCommand] = await verifier.verify(request([criterion()]))
    expect(noCommand).toMatchObject({ status: 'inconclusive', unknownKind: 'task' })
    const [timedOut] = await verifier.verify(
      request([criterion({ command: 'node -e "setTimeout(() => {}, 30000)"' })], 200),
    )
    expect(timedOut).toMatchObject({ status: 'inconclusive', unknownKind: 'task' })
  })

  test('the declared selftest samples are distinguished for real (KISS §12 step 2)', async () => {
    const { verifier, request } = await setup()
    const samples = verifier.selftest.samples
    expect(samples.some(sample => sample.role === 'positive')).toBe(true)
    expect(samples.some(sample => sample.role === 'negative')).toBe(true)
    for (const sample of samples) {
      const [result] = await verifier.verify(request([sample.criterion]))
      const judged = result.status === 'pass' ? 'pass' : result.status === 'fail' ? 'fail' : 'not-pass'
      expect(
        judged,
        `sample "${sample.name}" (${sample.role}) expected ${sample.expect}, judged ${result.status}`,
      ).toBe(sample.expect)
    }
  })

  test('criterion ids are sanitized for log file names', async () => {
    const { verifier, request } = await setup()
    const [result] = await verifier.verify(
      request([criterion({ criterionId: 'build/test:one', command: 'node -e "process.exit(0)"' })]),
    )
    expect(result.logRef).toBe('sg-t-root/r1/build_test_one.log')
  })

  test('a short timeout kills the command tree the shell forked, not just the shell', async () => {
    const { verifier, request } = await setup()
    const started = Date.now()
    const [result] = await verifier.verify(request([criterion({ command: `${SLEEP_MARKER} && true` })], 300))
    const elapsedMs = Date.now() - started

    expect(result.status).toBe('inconclusive')
    expect(result.details).toBe('timeout after 300ms')
    expect(result.exitCode).toBeUndefined()
    expect(elapsedMs).toBeLessThan(2000)
    expect(liveProcesses(SLEEP_MARKER)).toEqual([])
  })

  test('a non-zero exit with no output still leaves a diagnosable log', async () => {
    const { evidenceRoot, verifier, request } = await setup()
    const [result] = await verifier.verify(request([criterion({ command: 'exit 2' })]))
    expect(result.status).toBe('fail')
    expect(result.exitCode).toBe(2)
    // An empty log is what made a failure undiagnosable: the outcome line is
    // written by the verifier, never by the command.
    expect(await readFile(join(evidenceRoot, result.logRef!), 'utf8')).toBe('(no output) exit code 2\n')
  })

  test('a silent success and a silent timeout carry their outcome in the log too', async () => {
    const { evidenceRoot, verifier, request } = await setup()
    const [passed] = await verifier.verify(request([criterion({ command: 'true' })]))
    expect(passed.status).toBe('pass')
    expect(await readFile(join(evidenceRoot, passed.logRef!), 'utf8')).toBe('(no output) exit code 0\n')

    const [timedOut] = await verifier.verify(
      request([criterion({ command: `${SLEEP_MARKER} && true` })], 300),
    )
    expect(timedOut.status).toBe('inconclusive')
    expect(await readFile(join(evidenceRoot, timedOut.logRef!), 'utf8')).toBe('(no output) timed out\n')
  })

  test('a command that never started leaves the spawn error in its log', async () => {
    const { evidenceRoot, verifier, request } = await setup()
    const [result] = await verifier.verify({
      ...request([criterion({ command: 'true' })]),
      cwd: join(evidenceRoot, 'there-is-no-such-directory'),
    })
    expect(result.status).toBe('inconclusive')
    expect(result.details).toContain('ENOENT')
    expect(await readFile(join(evidenceRoot, result.logRef!), 'utf8')).toBe(`${result.details}\n`)
  })

  test('what the command itself wrote is the log, line for line', async () => {
    const { evidenceRoot, verifier, request } = await setup()
    const [result] = await verifier.verify(request([criterion({ command: 'printf "only this\\n"; exit 3' })]))
    expect(result.status).toBe('fail')
    expect(await readFile(join(evidenceRoot, result.logRef!), 'utf8')).toBe('only this\n')
  })
})

describe('CommandVerifier confinement', () => {
  /**
   * A deployment-shaped context: the real subprocess seam, and a sandbox seam
   * that records the argv and policy it was asked to confine. The deployment's
   * fallback root differs from the run's workspace on purpose — the policy the
   * verifier passes must carry the workspace the command runs in, because that
   * is the subtree the confinement keeps writable.
   */
  async function confinedSetup() {
    const evidenceRoot = await mkdtemp(join(tmpdir(), 'verifier-confined-evidence-'))
    const cwd = await mkdtemp(join(tmpdir(), 'verifier-confined-cwd-'))
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const confined: { argv: readonly string[]; policy: { mode: string; workspaceRoot: string } }[] = []
    ctx.provide('sandbox', {
      confine: async (argv: readonly string[], policy: { mode: string; workspaceRoot: string }) => {
        confined.push({ argv, policy })
        return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
      },
    } as never)
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: tmpdir() }) } as never)
    const verifier = new CommandVerifier(ctx, evidenceRoot)
    const request = (criteria: AcceptanceCriterion[], timeoutMs?: number): VerifyRequest => ({
      taskId: 't1',
      runId: 'r1',
      criteria,
      cwd,
      logDir: join(evidenceRoot, 'sg-t-root', 'r1'),
      timeoutMs,
    })
    return { evidenceRoot, cwd, verifier, request, confined }
  }

  test('a criterion command is confined in the workspace it judges and judged by its exit code', async () => {
    const { evidenceRoot, cwd, verifier, request, confined } = await confinedSetup()
    const [result] = await verifier.verify(request([criterion({ command: 'printf "confined\\n"; exit 0' })]))

    expect(confined).toEqual([
      { argv: ['bash', '-c', 'printf "confined\\n"; exit 0'], policy: { mode: 'workspace-write', workspaceRoot: cwd } },
    ])
    expect(result.status).toBe('pass')
    expect(await readFile(join(evidenceRoot, result.logRef!), 'utf8')).toBe('confined\n')
  })

  test('a confined timeout ends the command through the provider and still reports the timeout', async () => {
    const { verifier, request, confined } = await confinedSetup()
    const started = Date.now()
    const [result] = await verifier.verify(request([criterion({ command: SLEEP_MARKER })], 300))

    expect(confined).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result).toMatchObject({ status: 'inconclusive', details: 'timeout after 300ms' })
    expect(liveProcesses(SLEEP_MARKER)).toEqual([])
  })
})

/** A duration no other process shares, so the `ps` sweep cannot match a bystander. */
const SLEEP_MARKER = 'sleep 4.183'

function liveProcesses(marker: string): string[] {
  try {
    return execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' })
      .split('\n')
      .filter(line => line.includes(marker))
  } catch {
    return []
  }
}
