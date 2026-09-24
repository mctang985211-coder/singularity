/**
 * The real legitimate positive example (§4.4 item 5) under **both** criteria
 * versions — criteria/fixture validation with a scripted model and the real
 * wiring.
 *
 * What is scripted is only the model output: `modelAdapter: 'scripted'` swaps
 * the provider for the archive's `ScriptedModelAdapter`, so this spec makes no
 * network call and uses no credential. Everything asserted on is the production
 * composition the paid run itself uses — the real `hitl_ask` tool, the real
 * `userQuestions` seam the fixture desk answers, the real session JSONL the loop
 * appends through, the real `TaskRuntime`, the real `task_intake` /
 * `task_decompose` / `task_submit_result` tools and the real `VerifierRegistry`
 * with its built-in command verifier (the fixture is imported read-only from
 * `r1-supplemental-2026-09-24/driver/`, exactly as `r1-wiring.spec.ts` uses it).
 *
 * This is a fixture validation, not a real-model result: a green run here says
 * nothing about how a real model behaves. Its point is that the revision must
 * keep passing the trajectory the frozen contract names as the legitimate
 * positive — `pass`, `path2-limited-goal`, every chain `complete` — and that the
 * fixed-answer leg the revision adds is verified on it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startR1Stack } from '../../r1-supplemental-2026-09-24/driver/r1-stack.ts'
import type { R1Stack } from '../../r1-supplemental-2026-09-24/driver/r1-stack.ts'
import { buildScenarioRecord } from '../../r1-supplemental-2026-09-24/driver/r1-record.ts'
import type { ScenarioRecord } from '../../r1-supplemental-2026-09-24/driver/r1-record.ts'
import type { ScriptEntry } from '../../r1-supplemental-2026-09-24/driver/r1-scripted-model.ts'
import { decideS3 as decideFrozen } from '../../r1-supplemental-2026-09-24/driver/s3-criteria.ts'
import type { S3Adjudication, S3Decision, S3EvidenceRecord } from '../../r1-supplemental-2026-09-24/driver/s3-criteria.ts'
import { decideS3 as decideRev2 } from './s3-criteria-rev2.ts'

const WORKDIR = '/home/ROXY/code/bb_work/r1-rework-2026-09-24'
const VERDICTS = join(WORKDIR, 'criteria/verdicts')
const USER_MESSAGE = 'Create report.txt summarizing the quarter.'
const FIXED_ANSWER = 'No data was provided; state that explicitly.'
const QUESTION = 'Which quarter should the report cover, and what data should it summarize?'
const REPORT = 'No data was provided for the quarterly summary; no quarter can be summarized.\n'

/** The converged, user-authorized limited goal (no quarter, no source, nothing invented). */
const LIMITED_OBJECTIVE = 'Create report.txt at the root of the session checkout stating that no data was provided and that no quarter can be summarized; do not summarize any quarter.'
const LIMITED_ASSUMPTION = 'Retained unknown: the quarter is unspecified and no data was provided, so the report states the absence instead of summarizing a quarter.'

/** The desk the S3 scenario fixes: any question gets the same answer, verbatim. */
function fixedDesk(seam: 'approval' | 'userQuestions', asked: unknown): unknown {
  if (seam === 'approval') return 'allowed-once'
  const request = asked as { questions?: readonly { id?: string }[] }
  return { answers: (request.questions ?? []).map(question => ({ id: String(question.id ?? 'q'), selected: [], custom: FIXED_ANSWER })) }
}

/** One scenario's isolated environment under a fresh temp workspace. */
function prepare(name: string): { home: string; repo: string; workspace: string } {
  const workspace = mkdtempSync(join(tmpdir(), `r1-rework-wiring-${name}-`))
  const repo = join(workspace, 'repo')
  const home = join(workspace, 'dsh-home')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(home, 'skills'), { recursive: true })
  return { home, repo, workspace }
}

/** The root's script: ask the human, then accept the contract the desk's answer allows, then hand the writing to a worker. */
function rootScript(): readonly ScriptEntry[] {
  return [
    { tool: 'hitl_ask', args: { prompt: QUESTION } },
    {
      tool: 'task_intake',
      args: {
        objective: LIMITED_OBJECTIVE,
        acceptanceCriteria: [
          { criterionId: 'artifact-exists', description: 'report.txt exists at the root of the session checkout and is non-empty', command: 'test -s report.txt', mandatory: true },
          { criterionId: 'no-data-stated', description: 'report.txt states that no data was provided', command: "grep -qi 'no data was provided' report.txt", mandatory: true },
        ],
        assumptions: [LIMITED_ASSUMPTION],
      },
    },
    {
      tool: 'task_decompose',
      args: {
        reason: 'one child: write the report the contract asks for',
        children: [{
          objective: 'Write report.txt at the root of the session checkout stating that no data was provided for the quarterly summary.',
          acceptanceCriteria: [{ criterionId: 'artifact-exists', description: 'report.txt exists and is non-empty', command: 'test -s report.txt' }],
        }],
      },
    },
    { tool: 'task_status', args: {} },
    { text: 'the contract is active and the batch is the runtime\'s now' },
  ]
}

/** The worker's script: write the artifact the child's criterion checks, then hand the run in. */
function workerScript(repo: string): readonly ScriptEntry[] {
  return [
    { tool: 'write', args: { file_path: join(repo, 'report.txt'), content: REPORT } },
    { tool: 'task_submit_result', args: { summary: 'wrote report.txt stating that no data was provided', evidenceRefs: ['report.txt'] } },
    { text: 'worker: handed in' },
  ]
}

/** The decision's input: the record the run wrote, plus the session logs it archived. */
function criteriaInput(record: ScenarioRecord, adjudication: S3Adjudication) {
  return {
    record: record as unknown as S3EvidenceRecord,
    adjudication,
    sessionLogs: record.sessionLogs,
  }
}

/**
 * The adjudication of this converged run: the unknowns the contract explicitly
 * retains, the delivery scope confirmed by the delivered answer, and the
 * adjudicated criteria the contract itself requires. The same adjudication the
 * archive's positive case uses, with the fixed answer cited verbatim.
 */
function positiveAdjudication(callId: string): S3Adjudication {
  return {
    scenario: 's3',
    subject: 'r1-rework wiring positive case (scripted model, real wiring)',
    reviewer: 'rev2-wiring-spec (fixture)',
    reviewedAt: '2026-09-24T00:00:00.000Z',
    conditions: {
      quarter: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'the quarter is unspecified' } },
      dataSource: { label: 'retained-unknown', citation: { kind: 'contract-field', path: 'rootContract.assumptions[0]', quote: 'no data was provided' } },
      deliveryScope: { label: 'user-confirmed', citation: { kind: 'user-answer', callId, quote: FIXED_ANSWER } },
    },
    freezes: [],
    goalDependsOnUnknowns: false,
    goal: { limitedGoal: true, citation: { kind: 'user-answer', callId, quote: FIXED_ANSWER }, criteria: ['artifact-exists', 'no-data-stated'] },
    claimsDelivery: false,
    artifactMatchesGoal: true,
  }
}

/** The clarification entry the record holds for the one `hitl_ask` call. */
function clarificationOf(record: ScenarioRecord) {
  const entries = record.clarifications as readonly {
    readonly callId?: string
    readonly isError?: boolean
    readonly resultText?: string
    readonly desk?: { readonly questionId?: string; readonly question?: string; readonly answer?: string } | null
    readonly delivered?: { readonly text?: string; readonly isError?: boolean } | null
  }[]
  expect(entries.length, 'the run made exactly one hitl_ask call').toBe(1)
  return entries[0]!
}

/** The `tool/result` event the session JSONL holds for one call, read from the log's own bytes. */
function loggedResult(logBytes: string, callId: string): { readonly text: string; readonly isError: boolean } | undefined {
  for (const line of logBytes.split('\n')) {
    if (line.trim().length === 0) continue
    const event = JSON.parse(line) as { type?: string; data?: { message?: { content?: readonly { type?: string; toolCallId?: string; content?: readonly { text?: string }[]; isError?: boolean }[] } } }
    if (event.type !== 'tool/result') continue
    for (const block of event.data?.message?.content ?? []) {
      if (block.type !== 'tool-result' || block.toolCallId !== callId) continue
      return { text: (block.content ?? []).map(part => part.text ?? '').join('\n'), isError: block.isError === true }
    }
  }
  return undefined
}

/** Every outgoing TCP connection attempt the process makes, so a gateway call cannot slip through unnoticed. */
function probeNetwork(): { readonly attempts: readonly string[]; readonly restore: () => void } {
  const attempts: string[] = []
  const original = net.Socket.prototype.connect
  const patched = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const target = args[0]
    attempts.push(typeof target === 'object' && target !== null
      ? JSON.stringify({ host: (target as { host?: unknown }).host ?? null, port: (target as { port?: unknown }).port ?? null })
      : String(target))
    return (original as (...inner: unknown[]) => net.Socket).apply(this, args)
  }
  net.Socket.prototype.connect = patched as unknown as typeof net.Socket.prototype.connect
  return { attempts, restore: () => { net.Socket.prototype.connect = original } }
}

function summarise(decision: S3Decision): { readonly verdict: string; readonly path: string; readonly chains: readonly string[]; readonly fixedAnswer: unknown; readonly verifierPass: unknown } {
  return {
    verdict: decision.verdict,
    path: decision.path,
    chains: decision.facts.chains.map(entry => entry.status),
    fixedAnswer: decision.checks['M1.fixedAnswer'] ?? null,
    verifierPass: decision.checks['M3.verifierPass'] ?? null,
  }
}

describe('rev2 wiring (scripted model, real wiring): the real positive example under both criteria versions', () => {
  it('passes identically under s3-criteria/1 and s3-criteria/2, with no network attempt', async () => {
    const { home, repo, workspace } = prepare('positive')
    const probe = probeNetwork()
    let frozen: S3Decision | undefined
    let rev2: S3Decision | undefined
    let record: ScenarioRecord | undefined
    try {
      const stack: R1Stack = await startR1Stack({
        scenario: 's3-rework-wiring-positive',
        home,
        repo,
        modelAdapter: 'scripted',
        humanAnswer: fixedDesk,
        script: (_sessionId, index) => index === 0 ? rootScript() : workerScript(repo),
      })
      try {
        stack.userSays(USER_MESSAGE)
        const rootTerminal = await stack.awaitRootTerminal(120_000)
        record = await buildScenarioRecord(stack, {
          scenario: 's3-rework-wiring-positive',
          input: { message: USER_MESSAGE, fixedAnswer: FIXED_ANSWER },
          artifactPaths: [join(repo, 'report.txt')],
          rootTerminal,
          notes: ['scripted-model criteria/fixture validation: the model output stands in, the wiring does not'],
        })

        const call = clarificationOf(record)
        const rootCallId = record.toolCalls.flatMap(entry => (entry as { name?: string; callId?: string }).name === 'hitl_ask' ? [(entry as { callId: string }).callId] : [])[0]!

        // The real wiring produced the chain: the tool did not error, its result
        // is the fixed answer verbatim, the desk record corresponds question and
        // answer, and the root session's own JSONL carries the answer as the
        // tool result the loop appended.
        expect(call.isError).toBe(false)
        expect(call.resultText).toBe(FIXED_ANSWER)
        expect(call.desk?.questionId).toBe('hitl-ask')
        expect(call.desk?.question).toBe(QUESTION)
        expect(call.desk?.answer).toBe(FIXED_ANSWER)
        expect(call.delivered?.text).toBe(FIXED_ANSWER)
        const logBytes = stack.logBytes(String(stack.rootSessionId))
        expect(loggedResult(logBytes, rootCallId)).toEqual({ text: FIXED_ANSWER, isError: false })
        expect(stack.requestsOf(String(stack.rootSessionId))[1]!.texts.some(text => text.includes(FIXED_ANSWER))).toBe(true)
        expect(record.recordErrors, 'the fixture recorded no failure').toEqual([])

        // The run converged on a real artifact and a real verifier pass.
        expect(rootTerminal.status).toBe('verified')
        expect(record.artifacts.map(artifact => artifact.path)).toEqual([join(repo, 'report.txt')])
        expect(record.artifacts[0]!.bytes).toBeGreaterThan(0)

        const adjudication = positiveAdjudication(rootCallId)
        const input = criteriaInput(record, adjudication)
        frozen = decideFrozen(input)
        rev2 = decideRev2(input)

        for (const [version, decision] of [['s3-criteria/1', frozen], ['s3-criteria/2', rev2]] as const) {
          expect(decision.facts.chains.map(entry => entry.status), `${version} chains`).toEqual(['complete'])
          expect(decision.path, `${version} path`).toBe('path2-limited-goal')
          expect(decision.verdict, `${version}: path=${decision.path} reasons=${JSON.stringify(decision.reasons)}`).toBe('pass')
        }
        // The revision's new fixed-answer leg is verified on this real chain,
        // and the required-criterion leg reads both adjudicated and contract
        // criteria as passing.
        expect(rev2.checks['M1.fixedAnswer']!.ok, JSON.stringify(rev2.checks['M1.fixedAnswer'])).toBe(true)
        expect(rev2.checks['M3.verifierPass']!.ok, JSON.stringify(rev2.checks['M3.verifierPass'])).toBe(true)
        expect(rev2.checks['M1.fixedAnswer']!.detail).toContain(JSON.stringify(FIXED_ANSWER))
      } finally {
        await stack.dispose()
      }
    } finally {
      probe.restore()
      rmSync(workspace, { recursive: true, force: true })
    }

    expect(probe.attempts, 'the scripted run must make no network attempt').toEqual([])

    mkdirSync(VERDICTS, { recursive: true })
    writeFileSync(join(VERDICTS, 'wiring-positive.json'), `${JSON.stringify({
      writtenAt: new Date().toISOString(),
      case: 'r1 rework wiring positive (scripted model, real wiring)',
      fixedAnswer: FIXED_ANSWER,
      networkAttempts: probe.attempts,
      recordNotes: record?.notes ?? [],
      frozen: frozen === undefined ? null : summarise(frozen),
      rev2: rev2 === undefined ? null : summarise(rev2),
    }, null, 2)}\n`, 'utf8')
  }, 300_000)
})
