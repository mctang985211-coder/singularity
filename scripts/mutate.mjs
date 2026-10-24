#!/usr/bin/env node
/**
 * The mutation claims, runnable from inside the repository.
 *
 * Rounds three and four both recorded that every "N mutations, all caught" in this tree was
 * unverifiable from inside it, because the scripts lived in `/tmp`. The claims live in
 * `mutation-baseline.json` now — the edits, the command that judges them, the text a failure must
 * print — and this file runs one. **Nothing under this repository is opened for writing**: a claim is
 * applied to a copy of the tree in the system temporary directory, judged there, and the copy is
 * removed, so "restores byte-identically" is a property rather than a promise.
 *
 *   node scripts/mutate.mjs --list          every claim and the rule it attacks
 *   node scripts/mutate.mjs <id> [<id>...]  run those claims
 *   node scripts/mutate.mjs --all           run every claim (minutes: on demand, not a gate)
 *
 * `caught` = the command exited non-zero **and printed the witness the claim names**; a command that
 * never reached its checks (a suite that would not collect, a module that would not load) is
 * `broken`, never a catch. `MISSED` = the command passed, which is a finding about the rule, and a row
 * may carry `expect: "missed"` to record such a rule with its reproduction. Nothing here can tell
 * whether a mutation moved a computed value or only the shape of an assertion — the author's job
 * (`docs/debugging.md` §4), which is why each row states the rule it attacks and this file prints that
 * rule beside the verdict. The cheap half is checked on every commit by `mutation-claims`:
 * `docs/context.md` §13.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const LEDGER = 'mutation-baseline.json'
const claims = JSON.parse(readFileSync(join(ROOT, LEDGER), 'utf8')).claims

/** A copy of this tree, sharing nothing but the installed packages. */
function copyOfTree() {
  const copy = mkdtempSync(join(tmpdir(), 'mutate-'))
  cpSync(ROOT, copy, {
    recursive: true,
    filter: source => !source.split(sep).includes('node_modules') && !source.split(sep).includes('.git'),
  })
  symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'))
  return copy
}

/** Apply one claim's edits to the copy. Every anchor is asserted to occur exactly once. */
function apply(copy, claim) {
  for (const { file, find, replace } of claim.edits) {
    const path = join(copy, file)
    const text = readFileSync(path, 'utf8')
    const hits = text.split(find).length - 1
    if (hits !== 1) throw new Error(`${file}: the edit matches ${hits} times, and exactly one is required`)
    writeFileSync(path, text.replace(find, replace))
  }
}

/** What one claim's command did, with a non-zero exit reported rather than thrown. */
function judge(claim, copy) {
  const vitest = join(ROOT, 'node_modules/vitest/vitest.mjs')
  const [file, ...args] =
    claim.run.kind === 'vitest'
      ? [process.execPath, vitest, 'run', ...claim.run.args]
      : [process.execPath, ...claim.run.args]
  try {
    return {
      status: 0,
      output: execFileSync(file, args, {
        cwd: copy,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 600000,
      }),
    }
  } catch (error) {
    return {
      status: typeof error.status === 'number' ? error.status : 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`,
    }
  }
}

/** A command that never got as far as judging, which is not the same thing as a caught mutation. */
const NEVER_JUDGED = /Failed Suites|Startup Error|No test files found|PARSE_ERROR|Transform failed|Cannot find module/

function verdictOf(claim, { status, output }) {
  const recorded = claim.expect ?? 'caught'
  const log = join(tmpdir(), `mutate-${claim.id}.log`)
  writeFileSync(log, output)
  if (status === 0)
    return recorded === 'missed'
      ? { verdict: 'missed', detail: `not caught, as this row records; the full output is ${log}` }
      : {
          verdict: 'MISSED',
          detail: `the command passed under the mutation, so the rule this claim names is not what would catch it; the full output is ${log}`,
        }
  if (NEVER_JUDGED.test(output))
    return {
      verdict: 'broken',
      detail:
        'the command never reached its checks (a suite that would not collect or a module that would not load), which is not a catch',
    }
  if (!output.includes(claim.witness))
    return {
      verdict: 'broken',
      detail: `exited ${status} without printing the witness ${JSON.stringify(claim.witness)}, so it failed for another reason; the full output is ${log}`,
    }
  if (recorded === 'missed')
    return {
      verdict: 'BROKEN',
      detail:
        'this row records a mutation nothing catches, and the command now fails: the limitation is gone, so the row is out of date',
    }
  const evidence = [...output.matchAll(/^\s*(?:FAIL|×)\s+(.+)$/gm)].map(match => match[1].trim())
  return {
    verdict: 'caught',
    detail: evidence.slice(0, 2).join(' | ') || `exited ${status} and printed ${JSON.stringify(claim.witness)}`,
  }
}

function runOne(claim) {
  let copy
  try {
    copy = copyOfTree()
    apply(copy, claim)
    return { claim, ...verdictOf(claim, judge(claim, copy)) }
  } catch (error) {
    return { claim, verdict: 'unrunnable', detail: `${error?.message ?? error}` }
  } finally {
    if (copy !== undefined) rmSync(copy, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--list')) {
  for (const claim of claims) console.log(`  ${claim.id.padEnd(32)} ${claim.rule}`)
  console.log(
    `\n${claims.length} claim(s) in ${LEDGER}; every one runs in a copy of this tree, and no path under it is opened for writing`,
  )
  console.log('run one: node scripts/mutate.mjs <id>   run all: node scripts/mutate.mjs --all')
} else {
  const unknown = args.filter(arg => arg !== '--all' && !claims.some(claim => claim.id === arg))
  for (const id of unknown) console.log(`  ${id}: no claim with that id (see --list)`)
  const selected = args.includes('--all') ? claims : claims.filter(claim => args.includes(claim.id))
  console.log(
    `${selected.length} claim(s), each applied to its own copy of this tree; nothing here is written under the repository\n`,
  )
  const results = []
  for (const claim of selected) {
    const result = runOne(claim)
    results.push(result)
    console.log(`  ${result.verdict.padEnd(9)} ${claim.id.padEnd(32)} ${result.detail}`)
  }
  const failed = results.filter(result => result.verdict !== 'caught' && result.verdict !== 'missed')
  const missed = results.filter(result => result.verdict === 'missed')
  console.log(
    `\n${results.length} claim(s): ${results.length - failed.length - missed.length} caught, ${missed.length} recorded miss(es), ${failed.length} not`,
  )
  for (const { claim, verdict, detail } of failed)
    console.log(`  ${verdict.toUpperCase()}  ${claim.id} — ${claim.rule}: ${detail}`)
  process.exitCode = failed.length > 0 || unknown.length > 0 ? 1 : 0
}
