#!/usr/bin/env node
/**
 * The area metric's implementation: synthesize the graded module under one pinned yosys invocation
 * and print the hierarchy's chip area as the single JSON line the measurement adapter reads.
 *
 * A number is a measurement only against an apparatus, so the apparatus is pinned here:
 *
 * - **The liberty is pinned by content digest.** The same file name can hold another library, and a
 *   number from it is not a worse number — it is no number. A mismatched digest is a named miss.
 * - **`stat -liberty <lib> -hierarchy` is pinned.** Without `-hierarchy`, the area printed for the
 *   module is its **local** area, which moves when identical logic is partitioned into a child module:
 *   the lab's `Chip area for module` reads ~18% smaller exactly when the hierarchy's total area goes
 *   up. In hierarchy mode the same line is the total including submodules, which the flat and the
 *   partitioned forms of one design agree on.
 * - **The file list and its order are pinned** to the graded source alone: the module is
 *   self-contained, and naming a second file would let a submission bring in a definition of its own.
 *
 * Usage: node area.mjs <artifact>
 * Exit 0 with `{"quality": <um^2>}` as the only stdout line; non-zero with a one-line reason on
 * stderr and nothing on stdout otherwise. Both verdict by exit code and the JSON line are contracts:
 * a verifier judges by exit code, and `scripts/measure-runner.mjs` reads the last stdout line.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [artifactPath] = process.argv.slice(2)
if (artifactPath === undefined) {
  console.error('area: usage: area.mjs <artifact>')
  process.exit(2)
}

const YOSYS = `${process.env.HOME}/.nix-profile/bin/yosys`
/** The one library this domain's numbers are measured against; it stays in the lab tree it belongs to. */
const LIBERTY = `${process.env.HOME}/singularity-next/labs/sky130hd-lib/sky130hd_tt_025C_1v80.lib`
const LIBERTY_DIGEST = 'ec0e1067a35c8bf20b11e58d1e8ac53326067e4dac84a125cc1b917a3518d0d9'
const TOP = 'sha256_w_mem'

/** A miss: no number is printed, the reason names what was wrong, and the exit code says so. */
function miss(why) {
  console.error(`area: ${why}`)
  process.exit(1)
}

/** The first non-empty line, clipped: a reason a report can carry without becoming a log. */
function reason(text) {
  const lines = String(text).split('\n').map(entry => entry.trim()).filter(entry => entry !== '')
  const line = lines.find(entry => entry.startsWith('ERROR: ')) ?? lines.find(entry => entry.startsWith('Warning: ')) ?? lines[0] ?? 'no output'
  return line.length <= 200 ? line : `${line.slice(0, 200)}…`
}

let library
try {
  library = readFileSync(LIBERTY)
} catch (error) {
  miss(`the pinned liberty ${LIBERTY} cannot be read (${error instanceof Error ? error.message : String(error)}); no library, no area`)
}
const found = createHash('sha256').update(library).digest('hex')
if (found !== LIBERTY_DIGEST)
  miss(`the library at ${LIBERTY} hashes to ${found}, not the pinned ${LIBERTY_DIGEST}; an area against another library is not this measurement`)

const script = [
  `read_liberty -lib ${LIBERTY}`,
  `read_verilog ${artifactPath}`,
  `synth -top ${TOP}`,
  `dfflibmap -liberty ${LIBERTY}`,
  `abc -liberty ${LIBERTY}`,
  `stat -liberty ${LIBERTY} -hierarchy`,
].join('; ')

let log
try {
  log = execFileSync(YOSYS, ['-p', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })
} catch (error) {
  // yosys logs its passes to stdout and its errors to stderr; the reason a run produced no number is
  // usually on the second stream, so both are offered to the reader.
  miss(`yosys exited ${error.status ?? 'without a status'} on ${artifactPath}: ${reason(`${error.stderr ?? ''}\n${error.stdout ?? ''}`)}`)
}

// Hierarchy mode prints the module's total area, so this one line answers for the whole design no
// matter how the submission partitioned it. Two lines for one module name would mean the log is not
// the one this program pinned, and a missing line means the design had no area at all.
const areas = [...log.matchAll(/Chip area for module '\\sha256_w_mem': ([0-9.]+)/g)]
if (areas.length !== 1) miss(`yosys printed ${areas.length} area lines for module '${TOP}'; this program reads exactly the one hierarchy total, so ${areas.length === 0 ? 'a design with no area is no measurement' : 'an ambiguous log is no measurement'}`)

console.log(JSON.stringify({ quality: Number(areas[0][1]) }))
