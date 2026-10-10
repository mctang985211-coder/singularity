#!/usr/bin/env node
/**
 * The functional criterion's implementation: compile the graded module with the protected testbench,
 * simulate it, and pass on the testbench's own pass line.
 *
 * The comparison belongs to the testbench, not to this program. The testbench drives `init`/`round`/
 * `next` and compares `w` round by round against a message schedule that `tools/w-schedule.mjs`
 * printed only after it had reproduced three published NIST digests. This program's whole judgement
 * is whether that comparison reached its pass line, so a compile error, a crash, or a testbench that
 * quietly stops early is a fail — and never a pass for printing something plausible.
 *
 * Usage: node functional.mjs <artifact> <input>
 * Exit 0 = pass, non-zero = fail, with a one-line reason on stderr.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const [artifactPath, inputPath] = process.argv.slice(2)
if (artifactPath === undefined || inputPath === undefined) {
  console.error('functional: usage: functional.mjs <artifact> <input>')
  process.exit(2)
}

const IVERILOG = `${process.env.HOME}/.nix-profile/bin/iverilog`
const VVP = `${process.env.HOME}/.nix-profile/bin/vvp`
/** The testbench's top module and the one line it prints when every word of every block matched. */
const TOP = 'tb_sha256_w_mem_selfcheck'
const PASS = '*** sha256_w_mem self-check passed: 3 blocks, 192 words'

/** The first non-empty line, clipped: a reason a report can carry without becoming a log. */
function reason(text) {
  const line = String(text).split('\n').map(entry => entry.trim()).find(entry => entry !== '') ?? 'no output'
  return line.length <= 200 ? line : `${line.slice(0, 200)}…`
}

/** One tool, its streams collected. A tool that cannot start reports no output and a null status. */
function run(command) {
  try {
    return { status: 0, stdout: execFileSync(command[0], command.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }) }
  } catch (error) {
    return { status: error.status ?? null, stdout: error.stdout ?? '' }
  }
}

const work = mkdtempSync(join(tmpdir(), 'sha256-functional-'))
try {
  const image = join(work, 'tb.vvp')
  const compile = run([IVERILOG, '-g2012', '-s', TOP, '-o', image, artifactPath, inputPath])
  if (compile.status !== 0) {
    console.error(`functional: iverilog exited ${compile.status} on ${artifactPath} with ${inputPath}; the testbench never ran`)
    process.exit(1)
  }
  const simulation = run([VVP, image])
  // Both halves are required: the pass line, and a zero exit. The testbench's failing path ends in
  // `$fatal`, so a submission cannot buy a pass by printing the pass line itself — the comparison
  // still reaches its failure and the simulator still exits non-zero.
  if (simulation.status !== 0 || !simulation.stdout.includes(PASS)) {
    console.error(`functional: the testbench did not pass (vvp exited ${simulation.status}): ${reason(simulation.stdout)}`)
    process.exit(1)
  }
  console.log(`functional: ${PASS}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
