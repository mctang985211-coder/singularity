import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { XV6_CHECKER } from '../support/xv6-locks.ts'

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Execute the shipped checker against a grader that can print passing verdicts
// before failing. This probes its process boundary without a RISC-V guest.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'xv6-checker-fault-'))
  directories.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, 'checks'))
  // Fake graders have no QEMU port; isolate their lock from real integration grading.
  writeFileSync(join(dir, 'checks', 'verify.sh'), XV6_CHECKER.replace('/tmp/xv6-lock-grader.lock', join(dir, 'grader.lock')))
  writeFileSync(join(dir, 'grade-lab-lock'), `import os, sys, time
stage = sys.argv[1] if len(sys.argv) > 1 else 'all'
print('kalloctest: test1: OK')
print('kalloctest: test2: OK')
print('bcachetest: test0: OK')
print('bcachetest: test1: OK')
print('usertests: OK')
print('Score: 70/70', flush=True)
if stage == os.environ.get('GRADE_FAULT_STAGE', 'all'):
    if os.environ.get('GRADE_FAULT') == 'timeout': time.sleep(10)
    if os.environ.get('GRADE_FAULT') == 'exit': sys.exit(1)
`)
  const run = (stage: string, env: Record<string, string> = {}) => {
    const result = spawnSync('/bin/bash', ['checks/verify.sh', stage], {
      cwd: dir, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
    })
    expect(result.error).toBeUndefined()
    return { status: result.status, output: result.stdout + result.stderr }
  }
  return { bin, run }
}

it('accepts a successful grader and rejects non-zero exit even after every verdict printed OK', () => {
  const { run } = fixture()
  expect(run('all')).toMatchObject({ status: 0 })
  const failed = run('all', { GRADE_FAULT: 'exit' })
  expect(failed.status).toBe(1)
  expect(failed.output).toContain('Score: 70/70')
  expect(failed.output).toContain('partial output cannot pass')
})

it('retains failure from the first modules grader when the second exits successfully', () => {
  const { run } = fixture()
  const failed = run('modules', { GRADE_FAULT: 'exit', GRADE_FAULT_STAGE: 'kalloctest' })
  expect(failed.status).toBe(1)
  expect(failed.output.match(/Score: 70\/70/g)?.length).toBeGreaterThanOrEqual(2)
  expect(failed.output).toContain('the grader exited 1')
})

it('rejects actual timeout of the first modules grader even after it printed passing verdicts', () => {
  const { bin, run } = fixture()
  // Retain GNU timeout semantics while shortening only this fixture's deadline.
  writeFileSync(join(bin, 'timeout'), '#!/bin/bash\nexec /usr/bin/timeout 1 "${@:2}"\n', { mode: 0o755 })
  const failed = run('modules', { GRADE_FAULT: 'timeout', GRADE_FAULT_STAGE: 'kalloctest' })
  expect(failed.status).toBe(1)
  expect(failed.output).toContain('the grader exited 124')
  expect(failed.output).toContain('stage modules FAILED')
})

it('refuses to invoke the grader when flock is unavailable', () => {
  const { bin, run } = fixture()
  for (const command of ['dirname', 'mktemp', 'rm']) symlinkSync(`/usr/bin/${command}`, join(bin, command))
  const refused = run('all', { PATH: bin })
  expect(refused.status).toBe(2)
  expect(refused.output).toContain('flock is required')
  expect(refused.output).not.toContain('Score: 70/70')
})
