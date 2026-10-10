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
import { join, resolve } from 'node:path'

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
/**
 * The system task the simulator names the file that called it for, and why this program reads it.
 *
 * The comparison belongs to the testbench, and the graded module shares the simulator's process with
 * it. So a module that prints the pass line itself *and* ends the simulation in the same initial block
 * satisfies both of this program's other checks — stdout carries the line, vvp exits zero — while not
 * one word was ever compared. Measured: a module holding only
 * `$display("*** sha256_w_mem self-check passed: 3 blocks, 192 words"); $finish;` passed here before
 * this rule existed.
 *
 * vvp reports which file called the task (`<file>:<line>: $finish called at <time>`), so the rule is
 * read off the run rather than searched for in the source text: a text scan of the graded file is
 * evaded by one `` `include ``, which the simulator still compiles. Every finish the run attributes
 * must name the testbench, because the testbench is the only party allowed to end this simulation —
 * and if the graded module ended it, the comparison never ran.
 *
 * `$finish` only, never `$stop`: a stop pauses and the batch run continues into the comparison anyway
 * — measured, the testbench still reached its own pass line — so a stop cannot end a judgement, and
 * rejecting it would refuse a module that merely left a debugger stop behind.
 */
const FINISH = /^(.+?):\d+: \$finish called at /gm

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
  // The third check, and the one the two above cannot make: whoever ended this simulation. Together
  // with the pass line, a module that prints it and then ends the run at time 0 satisfies both checks
  // above while comparing nothing, so the ending has to be the testbench's own.
  const ended = [...simulation.stdout.matchAll(FINISH)]
  const strangers = ended.map(match => resolve(match[1])).filter(file => file !== resolve(inputPath))
  if (strangers.length > 0) {
    console.error(
      `functional: the run was ended by ${strangers[0]}, not by the testbench ${resolve(inputPath)}; the graded module is judged on the values it drives, and a module that ends the simulation before the comparison ran was never judged`,
    )
    process.exit(1)
  }
  console.log(`functional: ${PASS}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
