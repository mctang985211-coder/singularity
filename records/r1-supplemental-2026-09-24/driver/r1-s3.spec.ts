/**
 * R1 supplemental (Q4/Q5): S3's **single** attempt under the real model.
 *
 * This spec is the paid run, and it is deliberately **not** in the
 * deterministic include list (`vitest.r1-config`): run it explicitly with
 *
 *   cd /home/ROXY/code/bb_work/harness && pnpm exec vitest run \
 *     --config /home/ROXY/code/bb_work/r1-supplemental-2026-09-24/driver/vitest.r1-run.config.ts
 *
 * What it does, in order: one minimal connectivity smoke (the run's gate,
 * archived under `evidence/smoke-1/`; a failure blocks the attempt without
 * consuming it), then one attempt of the fixed scenario through the real stack —
 * the real `hitl_ask` tool, the fixed fixture desk, the real session JSONL, the
 * real `TaskRuntime`, the real verifier — with the production `DeepSeekAdapter`
 * over the configured gateway.
 *
 * What it does **not** do: it computes no scenario verdict. It writes the raw
 * facts (`evidence/s3/driver.json`), the run's own accounting
 * (`evidence/s3/run-meta.json`) and the scenario tree, and the frozen criteria
 * (`driver/s3-criteria.ts`) judge them afterwards against an independent
 * semantic review. The API key is never printed or persisted: every string that
 * reaches an artifact passes `redact` first, and the credential appears only as
 * the gateway's base URL and the key's length.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startR1Stack } from './r1-stack.ts'
import { buildScenarioRecord } from './r1-record.ts'
import { smokeCall } from './r1-smoke.ts'
import type { SmokeResult } from './r1-smoke.ts'
import { MODEL, PROVIDER, REASONING_EFFORT, gateway } from './r1-env.ts'

/** This round's roots: the driver in `driver/`, the scenario scratch under `run/`, evidence under `evidence/`. */
const WORKDIR = '/home/ROXY/code/bb_work/r1-supplemental-2026-09-24'
const DRIVER = join(WORKDIR, 'driver')
const RUN_SCRATCH = join(WORKDIR, 'run')
const EVIDENCE = join(WORKDIR, 'evidence')
const SINGULARITY = '/home/ROXY/code/bb_work/harness/packages/singularity'

const S3_MESSAGE = 'Create report.txt summarizing the quarter.'
const S3_FIXED_ANSWER = 'No data was provided; state that explicitly.'

/** The frozen soft accounting (§3): post-hoc, never an in-flight limit. */
const LIMITS = { toolCalls: 100, wallTimeMs: 15 * 60 * 1000 } as const

/** The smoke's own record, read by the attempt's `run-meta.json`. */
let smoke: SmokeResult | undefined
let blocked: string | undefined

/** One scenario's isolated environment: `<run-scratch>/s3/{repo,dsh-home}`, repo a fresh `git init` checkout. */
function prepareScenario(): { home: string; repo: string } {
  const base = join(RUN_SCRATCH, 's3')
  rmSync(base, { recursive: true, force: true })
  const repo = join(base, 'repo')
  const home = join(base, 'dsh-home')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(home, 'skills'), { recursive: true })
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  return { home, repo }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The driver's own files, hashed into `run-meta.json` so the evidence names the exact code that ran. */
function driverHashes(): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const name of readdirSync(DRIVER).sort()) {
    if (!name.endsWith('.ts') && !name.endsWith('.json')) continue
    hashes[name] = sha256(join(DRIVER, name))
  }
  return hashes
}

function singularitySha(): string {
  try {
    return execFileSync('git', ['-C', SINGULARITY, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch (error) {
    return `unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Copy a scenario's checkout and isolated home into its evidence directory. */
function archiveScenario(): void {
  const from = join(RUN_SCRATCH, 's3')
  const to = join(EVIDENCE, 's3')
  if (!existsSync(from)) return
  mkdirSync(to, { recursive: true })
  for (const name of ['repo', 'dsh-home'] as const) {
    if (existsSync(join(from, name))) cpSync(join(from, name), join(to, name), { recursive: true })
  }
}

describe('r1 supplemental: the smoke gate and S3\'s single attempt', () => {
  it('smoke: one minimal real call gates the attempt', async () => {
    const result = await smokeCall()
    smoke = result
    const dir = join(EVIDENCE, 'smoke-1')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'result.json'), `${JSON.stringify({ at: new Date().toISOString(), smoke: result }, null, 2)}\n`, 'utf8')
    if (!result.ok) blocked = `the smoke failed: ${result.error ?? 'no finish chunk'}`
    console.log(`smoke: ok=${result.ok} in=${result.inputTokens ?? '-'} out=${result.outputTokens ?? '-'} text=${JSON.stringify(result.text)}`)
  }, 200_000)

  it('S3: the single attempt of the fixed scenario', async (context) => {
    if (blocked !== undefined) return context.skip(blocked)
    if (existsSync(join(EVIDENCE, 's3', 'driver.json')) && process.env.R1_ALLOW_RERUN !== '1') {
      return context.skip('evidence/s3/driver.json exists: the fixed contract allows one attempt and no retry (set R1_ALLOW_RERUN=1 only to resume a broken run, never to pick a result)')
    }

    const { home, repo } = prepareScenario()
    const startedAt = Date.now()
    const startedIso = new Date(startedAt).toISOString()
    const stack = await startR1Stack({
      scenario: 's3',
      home,
      repo,
      humanAnswer: (seam, asked) => {
        if (seam === 'approval') return 'allowed-once'
        const request = asked as { questions?: readonly { id?: string }[] }
        return { answers: (request.questions ?? []).map(question => ({ id: String(question.id ?? 'q'), selected: [], custom: S3_FIXED_ANSWER })) }
      },
    })
    const notes: string[] = [
      'generatedTaskReview off, evolution off, rootBudget { wallTimeMs: 300000, maxRuns: 8 }; one attempt, no retry',
      'the scenario record is raw evidence: the verdict is decided afterwards by driver/s3-criteria.ts against an independent adjudication',
    ]
    let rootTerminal: { status: string; reason?: string } = { status: 'not-run', reason: 'the attempt did not reach the terminal wait' }
    try {
      stack.userSays(S3_MESSAGE)
      rootTerminal = await stack.awaitRootTerminal(290_000)
      notes.push(`root terminal: ${rootTerminal.status}${rootTerminal.reason === undefined ? '' : ` (${rootTerminal.reason})`}`)
    } finally {
      try {
        const record = await buildScenarioRecord(stack, {
          scenario: 's3',
          input: { message: S3_MESSAGE, fixedAnswer: S3_FIXED_ANSWER },
          artifactPaths: [join(repo, 'report.txt')],
          rootTerminal,
          notes,
        })
        const endedAt = Date.now()
        const usage = record.usage as readonly { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }[]
        const totals = {
          inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
          outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0),
          cacheReadTokens: usage.reduce((sum, item) => sum + item.cacheReadTokens, 0),
          cacheWriteTokens: usage.reduce((sum, item) => sum + item.cacheWriteTokens, 0),
        }
        const toolCalls = (record.toolCalls as readonly unknown[]).length
        const wallTimeMs = endedAt - startedAt
        const exceeded = [
          ...(toolCalls > LIMITS.toolCalls ? [`tool calls: ${toolCalls} > ${LIMITS.toolCalls}`] : []),
          ...(wallTimeMs > LIMITS.wallTimeMs ? [`wall clock: ${wallTimeMs}ms > ${LIMITS.wallTimeMs}ms`] : []),
        ]
        const runMeta = {
          startedAt: startedIso,
          endedAt: new Date(endedAt).toISOString(),
          wallTimeMs,
          scenario: 's3',
          input: { message: S3_MESSAGE, fixedAnswer: S3_FIXED_ANSWER },
          model: {
            adapter: 'DeepSeekAdapter (production)',
            provider: PROVIDER,
            model: MODEL,
            reasoningEffort: REASONING_EFFORT,
            gateway: gateway.baseUrl,
            credentialKeyLength: gateway.apiKey.length,
            note: 'the credential itself is never printed or persisted; only its length appears here',
          },
          singularitySha: singularitySha(),
          driverFiles: driverHashes(),
          budget: {
            hardInFlight: { rootBudget: { wallTimeMs: 300_000, maxRuns: 8 }, enforcedBy: 'A3 runtime' },
            soft: { limits: LIMITS, usage: totals, toolCalls, wallTimeMs, exceeded },
            tokens: null,
            tokenPolicy: 'the 2026-09-23 authorization (cap lifted) carries over; usage recorded in full, no claim against the old 30000 ceiling',
          },
          smoke: smoke === undefined
            ? { ran: false, result: null, blocked: blocked ?? null }
            : { ran: true, result: smoke, blocked: blocked ?? null },
          stopReason: blocked !== undefined
            ? `blocked: ${blocked}`
            : exceeded.length > 0
              ? `soft accounting exceeded: ${exceeded.join('; ')}`
              : `root terminal: ${rootTerminal.status}`,
          verdict: 'not computed here: driver/s3-criteria.ts decides from driver.json plus an independent adjudication',
        }
        mkdirSync(join(EVIDENCE, 's3'), { recursive: true })
        writeFileSync(join(EVIDENCE, 's3', 'driver.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
        writeFileSync(join(EVIDENCE, 's3', 'run-meta.json'), `${JSON.stringify(runMeta, null, 2)}\n`, 'utf8')
        console.log(`S3 attempt: root=${rootTerminal.status} toolCalls=${toolCalls} usage=${JSON.stringify(totals)} wallTimeMs=${wallTimeMs} clarifications=${(record.clarifications as readonly unknown[]).length}`)
      } finally {
        await stack.dispose()
        archiveScenario()
      }
    }

    // The run spec's own claim is only that the attempt happened and its
    // evidence landed; the verdict is not this spec's to take.
    expect(existsSync(join(EVIDENCE, 's3', 'driver.json'))).toBe(true)
    expect(existsSync(join(EVIDENCE, 's3', 'run-meta.json'))).toBe(true)
  }, 900_000)
})
