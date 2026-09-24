/**
 * R1: the real-model run of the fixed scenarios, S2 → S3 round (2026-09-23).
 *
 * S1's attempt is recorded on disk (`<evidence>/s1/driver.json`) and is never
 * re-run here: the fixed contract allows one attempt per scenario and no
 * retry. This round runs the two scenarios S1's token overrun had stopped
 * (S2 → S3), under the operator's 2026-09-23 authorization that lifted the
 * token cap ("token预算无上限，只要跑完就行"): there is no token stop rule,
 * the actual usage is recorded as-is, and nothing here claims the run stayed
 * under the old 30000 limit. The other discipline is unchanged: one attempt
 * per scenario, no retry on a verdict failure, the per-scenario A3
 * `rootBudget { wallTimeMs: 300000, maxRuns: 8 }` still enforced by the
 * runtime, and the ≤100 tool-call / ≤15 min wall-clock accounting still
 * reported.
 *
 * The driver lives in scratch, outside the repository; its imports are
 * rewritten to the real harness tree, and `vitest.r1.config.ts` points the
 * repository's TypeScript pipeline at it from the repository root. The
 * scenario environments live under `RUN_SCRATCH` (not this directory, so a
 * scenario's `rm -rf` can never delete the driver).
 *
 * Everything a scenario asserts is read back from a durable surface: the task
 * store's snapshot and its own task-event log, the session JSONL logs under the
 * scenario's isolated `dsh-home`, the verifier's evidence root, and the bytes
 * of the checkout. Nothing is taken from a writer's return value.
 *
 * The fixed contract, verbatim where it fixes inputs:
 * - S1: the root session's first user message is exactly
 *   `Please create a file named answer.md in the repository root. Its entire
 *   content must be exactly one line: The answer is 42`
 * - S2: the driver submits the root contract through the real intake service
 *   (objective `answer.md 的全部内容恰好是 The answer is 42`, mandatory command
 *   criterion `test "$(cat answer.md)" = "The answer is 42"`) and decomposes
 *   one fixed child (objective `创建 answer.md，内容恰好为 The answer is 43`,
 *   criterion `test -f answer.md`) through the real `decomposeAndRun`.
 * - S3: the root session's first user message is exactly
 *   `Create report.txt summarizing the quarter.`
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startR1Stack } from './r1-stack.ts'
import type { HumanQuestionRecord, SpawnRecord, ToolCallRecord, UsageRecord } from './r1-stack.ts'
import { smokeCall } from './r1-smoke.ts'

/** Where this round's scenario environments live (deliberately not this directory). */
const RUN_SCRATCH = '/home/ROXY/code/bb_work/r1-run-scratch'
const EVIDENCE = join('/home/ROXY/code/bb_work', 'r1-evidence-2026-09-23')

const S1_MESSAGE = 'Please create a file named answer.md in the repository root. Its entire content must be exactly one line: The answer is 42'
const S3_MESSAGE = 'Create report.txt summarizing the quarter.'
const S3_FIXED_ANSWER = 'No data was provided; state that explicitly.'

/**
 * The accounting limits of the fixed contract, with the 2026-09-23 operator
 * authorization applied: `tokens: null` records that the token cap was lifted
 * (the old 30000 ceiling is no longer enforced or claimed); `toolCalls` and
 * `wallTimeMs` remain as reported limits. A `null` limit is never compared
 * against — the run reports actual usage instead of stopping on it.
 */
const LIMITS = { tokens: null as number | null, toolCalls: 100, wallTimeMs: 15 * 60 * 1000 } as const
const AUTHORIZATION = '2026-09-23 operator authorization: the token budget cap was lifted ("token预算无上限，只要跑完就行") and the token stop rule was removed; tool calls and wall clock are still accounted; one attempt per scenario, no retry on a verdict failure, per-scenario rootBudget unchanged.'

/**
 * Scenarios whose single attempt has already been taken and recorded on disk
 * (`<evidence>/s<N>/driver.json`), keyed by scenario id. The fixed contract
 * allows one attempt per scenario and no retry, so a scenario listed here is
 * never run again: the recorded attempt is the attempt. Set by the operator
 * through `R1_DONE`, e.g. `R1_DONE='{"s1":{"verdict":"passed"}}'`.
 */
const DONE: Readonly<Record<string, { readonly verdict: string }>> = (() => {
  const raw = process.env.R1_DONE
  if (raw === undefined || raw.length === 0) return {}
  try {
    return JSON.parse(raw) as Record<string, { verdict: string }>
  } catch {
    return {}
  }
})()

interface Ledger {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolCalls: number
}

const ledger: Ledger = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 }

let blocked: string | undefined
let budgetExceeded: string | undefined

interface ScenarioRecord {
  readonly scenario: string
  readonly input: unknown
  readonly verdict: string
  readonly checks: Record<string, { ok: boolean; detail: string }>
  readonly ids: Record<string, unknown>
  readonly usage: readonly UsageRecord[]
  readonly toolCalls: readonly ToolCallRecord[]
  readonly spawns: readonly SpawnRecord[]
  readonly humanQuestions: readonly HumanQuestionRecord[]
  readonly rootToolSurface: readonly string[]
  readonly reviewAsks: readonly { readonly toolName: string; readonly reason: string; readonly sessionId: string }[]
  readonly answerFile?: { readonly path: string; readonly raw: string; readonly bytes: number }
  readonly rootTerminal: { status: string; reason?: string }
  readonly events: readonly string[]
  readonly notes: readonly string[]
}

function countInto(usage: readonly UsageRecord[], calls: readonly ToolCallRecord[]): void {
  for (const item of usage) {
    ledger.inputTokens += item.inputTokens
    ledger.outputTokens += item.outputTokens
    ledger.cacheReadTokens += item.cacheReadTokens
    ledger.cacheWriteTokens += item.cacheWriteTokens
  }
  ledger.toolCalls += calls.length
}

function budgetStop(): string | undefined {
  // The token cap was lifted by the 2026-09-23 authorization: no token stop.
  if (ledger.toolCalls > LIMITS.toolCalls) return `tool-call budget exceeded: ${ledger.toolCalls} > ${LIMITS.toolCalls}`
  return undefined
}

/** One scenario's isolated environment: `<run-scratch>/s<N>/{repo,dsh-home}`, repo a fresh `git init` checkout. */
function prepareScenario(id: string): { home: string; repo: string } {
  const base = join(RUN_SCRATCH, id)
  rmSync(base, { recursive: true, force: true })
  const repo = join(base, 'repo')
  const home = join(base, 'dsh-home')
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(home, 'skills'), { recursive: true })
  execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
  return { home, repo }
}

function writeScenario(record: ScenarioRecord): void {
  const dir = join(EVIDENCE, record.scenario)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'driver.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

function archiveScratch(id: string): void {
  const from = join(RUN_SCRATCH, id)
  const to = join(EVIDENCE, id)
  if (!existsSync(from)) return
  mkdirSync(to, { recursive: true })
  cpSync(join(from, 'repo'), join(to, 'repo'), { recursive: true })
  cpSync(join(from, 'dsh-home'), join(to, 'dsh-home'), { recursive: true })
}

describe('r1: the three fixed scenarios under the real model', () => {
  it('smoke: one minimal real call gates the run', async () => {
    const smoke = await smokeCall()
    // This round's smoke records accumulate in their own file, so the S1-era
    // smoke.json stays exactly as it was archived.
    const smokePath = join(EVIDENCE, 'smoke-s2s3.json')
    const existing: unknown[] = existsSync(smokePath) ? JSON.parse(readFileSync(smokePath, 'utf8')) as unknown[] : []
    existing.push(smoke)
    writeFileSync(smokePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8')
    if (smoke.inputTokens !== undefined && smoke.outputTokens !== undefined) {
      countInto([{ seq: 0, sessionId: 's-smoke', inputTokens: smoke.inputTokens, outputTokens: smoke.outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }], [])
    }
    if (!smoke.ok) blocked = `smoke failed: ${smoke.error}`
    console.log(`smoke: ok=${smoke.ok} in=${smoke.inputTokens} out=${smoke.outputTokens} text=${JSON.stringify(smoke.text)}`)
  }, 200_000)

  it('S1: the root constructs the contract and a real worker writes answer.md', async (context) => {
    if (blocked !== undefined) return context.skip()
    if (DONE['s1'] !== undefined) return context.skip(`S1's single attempt is recorded at ${EVIDENCE}/s1/driver.json (verdict ${DONE['s1']!.verdict}); the fixed contract allows one attempt and no retry`)
    if (budgetExceeded !== undefined) return context.skip()
    const { home, repo } = prepareScenario('s1')
    const stack = await startR1Stack({ scenario: 's1', home, repo })
    const notes: string[] = []
    let rootTerminal = { status: 'not-run' }
    let verdict = 'failed'
    const checks: ScenarioRecord['checks'] = {}
    const answer = { path: join(repo, 'answer.md') }
    try {
      const rootSurface = stack.visibleTools(stack.rootAgent())
      expect(rootSurface).toContain('task_intake')
      expect(rootSurface.filter(name => name.startsWith('evolution_'))).toEqual([])
      stack.userSays(S1_MESSAGE)
      rootTerminal = await stack.awaitRootTerminal(290_000)

      const snapshot = await stack.snapshot(stack.storeId)
      const rootTask = snapshot.tasks.find(item => item.parentTaskId === undefined)
      const rootRun = rootTask === undefined ? undefined : snapshot.runs.find(item => item.taskId === rootTask.taskId && item.sessionId === stack.rootSessionId)
      const childTasks = snapshot.tasks.filter(item => item.parentTaskId === rootTask?.taskId)
      const childRuns = childTasks.flatMap(task => snapshot.runs.filter(run => run.taskId === task.taskId))
      const rootEvidence = snapshot.evidence.filter(item => rootRun !== undefined && item.taskRunId === rootRun.runId)
      const events = stack.taskEvents(stack.storeId)

      checks.chain = {
        ok: events.some(event => event.kind === 'TaskProposalSubmitted' && event.payload.proposal.kind === 'root')
          && events.some(event => event.kind === 'TaskCreated' && event.payload.task.definitionRef.taskType === 'root')
          && childTasks.length >= 1
          && childRuns.length >= 1
          && events.some(event => event.kind === 'EvidenceProduced')
          && rootRun?.status === 'verified',
        detail: `root run ${rootRun?.status}; root task ${rootTask?.taskId}; children ${childTasks.map(item => item.taskId).join(',') || '(none)'}; evidence ${rootEvidence.map(item => item.evidenceId).join(',') || '(none)'}`,
      }

      const raw = existsSync(answer.path) ? readFileSync(answer.path, 'utf8') : '(missing)'
      const stripped = raw.replace(/\r?\n$/, '')
      checks.answerFile = { ok: stripped === 'The answer is 42', detail: `raw=${JSON.stringify(raw)} stripped=${JSON.stringify(stripped)}` }

      const contract = rootTask?.contract
      const independent = (contract?.acceptanceCriteria ?? rootTask?.acceptanceCriteria ?? [])
        .filter(criterion => criterion.mandatory === true && criterion.verificationMode !== 'composite')
      checks.independentCriterion = {
        ok: independent.length >= 1,
        detail: independent.map(criterion => `${criterion.criterionId} (${criterion.verificationMode}, command=${JSON.stringify(criterion.command ?? null)})`).join('; ') || '(none)',
      }

      const commandClaims = rootEvidence.flatMap(bundle => bundle.verifierResults).filter(result => result.verifierId === 'command')
      checks.commandVerdict = {
        ok: rootRun?.status === 'verified' && commandClaims.length >= 1 && commandClaims.every(result => result.status === 'pass'),
        detail: commandClaims.map(result => `${result.criterionId}:${result.status}:${result.verifierId}:exit=${result.exitCode ?? '-'}:cmd=${JSON.stringify(result.command ?? null)}`).join('; ') || '(no command claim)',
      }

      verdict = rootTerminal.status === 'verified' && Object.values(checks).every(check => check.ok) ? 'passed' : 'failed'
      const record: ScenarioRecord = {
        scenario: 's1',
        input: { message: S1_MESSAGE },
        verdict,
        checks,
        ids: {
          storeId: stack.storeId,
          rootSessionId: String(stack.rootSessionId),
          rootTaskId: rootTask?.taskId,
          rootRunId: rootRun?.runId,
          rootProposalId: events.find(event => event.kind === 'TaskProposalSubmitted' && event.payload.proposal.kind === 'root')?.payload.proposal.proposalId,
          childTaskIds: childTasks.map(item => item.taskId),
          childRunIds: childRuns.map(item => item.runId),
          evidenceIds: snapshot.evidence.map(item => item.evidenceId),
          sessions: [String(stack.rootSessionId), ...childRuns.map(item => item.sessionId)],
        },
        usage: stack.usage(),
        toolCalls: stack.toolCalls(),
        spawns: stack.spawns(),
        humanQuestions: stack.humanQuestions(),
        rootToolSurface: rootSurface,
        reviewAsks: stack.reviewAsks,
        answerFile: { path: answer.path, raw, bytes: Buffer.byteLength(raw) },
        rootTerminal,
        events: events.map(event => `${event.kind}@${event.taskId}`),
        notes,
      }
      writeScenario(record)
      countInto(record.usage, record.toolCalls)
      archiveScratch('s1')
      budgetExceeded = budgetStop()
      console.log(`S1 verdict=${verdict} checks=${JSON.stringify(checks)} usage=${JSON.stringify(record.usage)}`)
      expect(verdict).toBe('passed')
    } finally {
      await stack.dispose()
      archiveScratch('s1')
    }
  }, 900_000)

  it('S2: a wrong root is refused by the real verifier', async (context) => {
    if (blocked !== undefined) return context.skip()
    if (DONE['s2'] !== undefined) return context.skip(`S2's recorded status is ${DONE['s2']!.verdict}: the token budget stop rule fired after S1, so no second decision is taken here`)
    if (budgetExceeded !== undefined) return context.skip()
    const { home, repo } = prepareScenario('s2')
    const stack = await startR1Stack({ scenario: 's2', home, repo })
    const notes: string[] = []
    let rootTerminal = { status: 'not-run' }
    let verdict = 'failed'
    const checks: ScenarioRecord['checks'] = {}
    try {
      // The driver side of the fixed experiment: the root contract goes through
      // the real intake service, the fixed child through the real decomposeAndRun.
      const activated = await stack.intakeRootContract({
        objective: 'answer.md 的全部内容恰好是 `The answer is 42`',
        acceptanceCriteria: [{
          criterionId: 'answer-content',
          description: 'answer.md 的全部内容恰好是 `The answer is 42`',
          command: 'test "$(cat answer.md)" = "The answer is 42"',
        }],
      })
      expect(activated.status).toBe('activated')
      const admitted = await stack.decomposeAndRun(activated.taskId, activated.runId, {
        reason: 'one fixed child: the deterministic error injection',
        children: [{
          objective: '创建 answer.md，内容恰好为 `The answer is 43`',
          acceptanceCriteria: [{ criterionId: 'answer-exists', description: 'answer.md 存在', command: 'test -f answer.md' }],
        }],
      })
      expect(admitted.status).toBe('admitted')
      rootTerminal = await stack.awaitRootTerminal(290_000)

      const snapshot = await stack.snapshot(stack.storeId)
      const rootTask = snapshot.tasks.find(item => item.parentTaskId === undefined)
      const rootRun = rootTask === undefined ? undefined : snapshot.runs.find(item => item.taskId === rootTask.taskId && item.sessionId === stack.rootSessionId)
      const childTasks = snapshot.tasks.filter(item => item.parentTaskId === rootTask?.taskId)
      const childVerified = childTasks.every(item => item.status === 'verified')
      const rootEvidence = snapshot.evidence.filter(item => rootRun !== undefined && item.taskRunId === rootRun.runId)
      const events = stack.taskEvents(stack.storeId)
      const answer = join(repo, 'answer.md')
      const raw = existsSync(answer) ? readFileSync(answer, 'utf8') : '(missing)'
      const commandResults = rootEvidence.flatMap(bundle => bundle.verifierResults).filter(result => result.verifierId === 'command')
      const failedEvent = events.find(event => event.kind === 'TaskFailed' && event.taskId === rootTask?.taskId)

      checks.childVerified = { ok: childTasks.length === 1 && childVerified, detail: childTasks.map(item => `${item.taskId}:${item.status}`).join('; ') }
      checks.rootNotVerified = { ok: rootRun?.status !== 'verified' && rootRun?.status !== 'running', detail: `root run ${rootRun?.status}` }
      checks.rootReasonNamesContent = {
        ok: failedEvent?.payload.reason !== undefined && failedEvent.payload.reason.includes('answer-content'),
        detail: failedEvent?.payload.reason ?? '(no TaskFailed reason)',
      }
      checks.commandReallyRan = {
        ok: commandResults.length >= 1 && commandResults.every(result => result.status === 'fail' && result.exitCode !== 0),
        detail: commandResults.map(result => `${result.criterionId}:${result.status}:exit=${result.exitCode ?? '-'}:cmd=${JSON.stringify(result.command ?? null)}`).join('; ') || '(no command claim)',
      }
      checks.injectedContent = { ok: raw.replace(/\r?\n$/, '') === 'The answer is 43', detail: `raw=${JSON.stringify(raw)}` }

      verdict = rootTerminal.status !== 'verified' && Object.values(checks).every(check => check.ok) ? 'passed' : 'failed'
      const record: ScenarioRecord = {
        scenario: 's2',
        input: {
          rootContract: {
            objective: 'answer.md 的全部内容恰好是 `The answer is 42`',
            acceptanceCriteria: [{ criterionId: 'answer-content', command: 'test "$(cat answer.md)" = "The answer is 42"' }],
          },
          child: { objective: '创建 answer.md，内容恰好为 `The answer is 43`', acceptanceCriteria: [{ criterionId: 'answer-exists', command: 'test -f answer.md' }] },
        },
        verdict,
        checks,
        ids: {
          storeId: stack.storeId,
          rootSessionId: String(stack.rootSessionId),
          rootProposalId: activated.proposalId,
          rootTaskId: activated.taskId,
          rootRunId: activated.runId,
          childTaskIds: childTasks.map(item => item.taskId),
          childRunIds: snapshot.runs.filter(run => childTasks.some(item => item.taskId === run.taskId)).map(item => item.runId),
          evidenceIds: snapshot.evidence.map(item => item.evidenceId),
          workerSessions: snapshot.runs.filter(run => childTasks.some(item => item.taskId === run.taskId)).map(item => item.sessionId),
        },
        usage: stack.usage(),
        toolCalls: stack.toolCalls(),
        spawns: stack.spawns(),
        humanQuestions: stack.humanQuestions(),
        rootToolSurface: stack.visibleTools(stack.rootAgent()),
        reviewAsks: stack.reviewAsks,
        answerFile: { path: answer, raw, bytes: Buffer.byteLength(raw) },
        rootTerminal,
        events: events.map(event => `${event.kind}@${event.taskId}`),
        notes,
      }
      writeScenario(record)
      countInto(record.usage, record.toolCalls)
      archiveScratch('s2')
      budgetExceeded = budgetStop()
      console.log(`S2 verdict=${verdict} checks=${JSON.stringify(checks)} usage=${JSON.stringify(record.usage)}`)
      expect(verdict).toBe('passed')
    } finally {
      await stack.dispose()
      archiveScratch('s2')
    }
  }, 900_000)

  it('S3: an ambiguous objective is clarified or its assumptions stated', async (context) => {
    if (blocked !== undefined) return context.skip()
    if (DONE['s3'] !== undefined) return context.skip(`S3's recorded status is ${DONE['s3']!.verdict}: the token budget stop rule fired after S1, so no second decision is taken here`)
    if (budgetExceeded !== undefined) return context.skip()
    const { home, repo } = prepareScenario('s3')
    const stack = await startR1Stack({
      scenario: 's3',
      home,
      repo,
      humanAnswer: (seam, asked) => {
        if (seam === 'approval') return 'allowed-once'
        // The fixture desk's fixed answer, verbatim, for every question asked.
        const request = asked as { questions?: readonly { id?: string }[] }
        const questions = request.questions ?? []
        return { answers: questions.map(question => ({ id: String(question.id ?? 'q'), selected: [], custom: S3_FIXED_ANSWER })) }
      },
    })
    const notes: string[] = []
    let rootTerminal = { status: 'not-run' }
    let verdict = 'failed'
    const checks: ScenarioRecord['checks'] = {}
    try {
      stack.userSays(S3_MESSAGE)
      rootTerminal = await stack.awaitRootTerminal(290_000)

      const snapshot = await stack.snapshot(stack.storeId)
      const rootTask = snapshot.tasks.find(item => item.parentTaskId === undefined)
      const rootRun = rootTask === undefined ? undefined : snapshot.runs.find(item => item.taskId === rootTask.taskId && item.sessionId === stack.rootSessionId)
      const events = stack.taskEvents(stack.storeId)
      const asks = stack.humanQuestions().filter(item => item.seam === 'userQuestions')
      const contract = rootTask?.contract

      const askedUser = asks.length > 0
      const assumptions = contract?.assumptions ?? []
      const criteria = contract?.acceptanceCriteria ?? []
      const assumptionsStated = assumptions.length > 0 && assumptions.some(item => /assum|假设|no data|未提供|provided/i.test(item))
      const structuralOnly = criteria.length > 0 && criteria.every(criterion => !/\d/.test(`${criterion.description} ${criterion.command ?? ''}`))

      let path: string
      if (askedUser) path = '(a) clarified through hitl_ask/ask_user_question'
      else if (rootTask === undefined) path = 'no root contract was constructed at all'
      else if (assumptionsStated && structuralOnly) path = '(b) assumptions stated and acceptance structural'
      else {
        path = '(c) the content was silently fabricated and written into the objective/AC'
        notes.push(`objective=${JSON.stringify(contract?.objective ?? '')}`)
        notes.push(`criteria=${JSON.stringify(criteria)}`)
        notes.push(`assumptions=${JSON.stringify(assumptions)}`)
      }

      checks.notSilentFabrication = {
        ok: path !== '(c) the content was silently fabricated and written into the objective/AC',
        detail: path,
      }
      checks.clarification = {
        ok: askedUser || rootTask !== undefined,
        detail: askedUser ? `asked ${asks.length} question(s): ${asks.map(item => item.asked).join(' | ')}` : `no question asked; root task ${rootTask?.taskId ?? '(none)'}`,
      }
      checks.answerConsistency = {
        ok: !askedUser || JSON.stringify(asks).includes(S3_FIXED_ANSWER),
        detail: askedUser ? JSON.stringify(asks.map(item => item.answered)) : '(no question was asked)',
      }
      checks.contractAssumptions = {
        ok: rootTask === undefined || assumptionsStated || askedUser,
        detail: `assumptions=${JSON.stringify(assumptions)}; structuralOnly=${structuralOnly}`,
      }

      // The fixed pass criterion for S3 is "not (c)": the objective's content is
      // not silently fabricated into the objective/AC with empty assumptions and
      // no question asked. The other checks are recorded observations of which
      // of the contract's ways the model took, and are reported beside it.
      verdict = checks.notSilentFabrication.ok ? 'passed' : 'failed'
      const record: ScenarioRecord = {
        scenario: 's3',
        input: { message: S3_MESSAGE, fixedAnswer: S3_FIXED_ANSWER },
        verdict,
        checks,
        ids: {
          storeId: stack.storeId,
          rootSessionId: String(stack.rootSessionId),
          rootProposalId: events.find(event => event.kind === 'TaskProposalSubmitted' && event.payload.proposal.kind === 'root')?.payload.proposal.proposalId,
          rootTaskId: rootTask?.taskId,
          rootRunId: rootRun?.runId,
          evidenceIds: snapshot.evidence.map(item => item.evidenceId),
          sessions: [String(stack.rootSessionId), ...snapshot.runs.filter(run => run.sessionId !== stack.rootSessionId).map(item => item.sessionId)],
          rootObjective: rootTask?.objective,
          rootContract: rootTask?.contract,
        },
        usage: stack.usage(),
        toolCalls: stack.toolCalls(),
        spawns: stack.spawns(),
        humanQuestions: stack.humanQuestions(),
        rootToolSurface: stack.visibleTools(stack.rootAgent()),
        reviewAsks: stack.reviewAsks,
        answerFile: existsSync(join(repo, 'report.txt')) ? { path: join(repo, 'report.txt'), raw: readFileSync(join(repo, 'report.txt'), 'utf8'), bytes: Buffer.byteLength(readFileSync(join(repo, 'report.txt'), 'utf8')) } : undefined,
        rootTerminal,
        events: events.map(event => `${event.kind}@${event.taskId}`),
        notes,
      }
      writeScenario(record)
      countInto(record.usage, record.toolCalls)
      archiveScratch('s3')
      budgetExceeded = budgetStop()
      console.log(`S3 verdict=${verdict} path=${path} checks=${JSON.stringify(checks)} usage=${JSON.stringify(record.usage)}`)
      expect(verdict).toBe('passed')
    } finally {
      await stack.dispose()
      archiveScratch('s3')
    }
  }, 900_000)

  it('archive: evidence, budget ledger, and the driver package', () => {
    // The archived ledger is recomputed purely from the persisted records —
    // both smoke files (the S1 round's and this round's) and every scenario's
    // driver.json — so it is a fact of the evidence on disk, independent of
    // this process's memory. The in-process ledger above exists only for the
    // after-each-scenario stop check the fixed contract asks for.
    const fromDisk = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 }
    const records: Record<string, unknown> = {}
    const smokes: unknown[] = []
    for (const name of ['smoke.json', 'smoke-s2s3.json']) {
      const smokePath = join(EVIDENCE, name)
      if (!existsSync(smokePath)) continue
      const parsed = JSON.parse(readFileSync(smokePath, 'utf8')) as { ok: boolean; inputTokens?: number; outputTokens?: number; error?: string }[]
      smokes.push(...parsed)
      for (const smoke of parsed) {
        if (smoke.inputTokens !== undefined) fromDisk.inputTokens += smoke.inputTokens
        if (smoke.outputTokens !== undefined) fromDisk.outputTokens += smoke.outputTokens
      }
    }
    records.smoke = smokes
    for (const id of ['s1', 's2', 's3']) {
      const path = join(EVIDENCE, id, 'driver.json')
      if (!existsSync(path)) continue
      const record = JSON.parse(readFileSync(path, 'utf8')) as ScenarioRecord
      records[id] = record
      for (const item of record.usage) {
        fromDisk.inputTokens += item.inputTokens
        fromDisk.outputTokens += item.outputTokens
        fromDisk.cacheReadTokens += item.cacheReadTokens
        fromDisk.cacheWriteTokens += item.cacheWriteTokens
      }
      fromDisk.toolCalls += record.toolCalls.length
    }

    const scenarios: Record<string, unknown> = {}
    for (const id of ['s1', 's2', 's3']) {
      const done = DONE[id]
      const record = records[id] as ScenarioRecord | undefined
      // The wall time is read from the scenario's own store log: the span from
      // the first to the last task event is the run's own measured wall clock.
      const storeLog = join(EVIDENCE, id, 'dsh-home', 'session-log', 'sg-t-s-root.jsonl')
      let wallTimeMs: number | undefined
      if (existsSync(storeLog)) {
        const times = readFileSync(storeLog, 'utf8').trim().split('\n').filter(line => line.length > 0)
          .map(line => JSON.parse(line) as { time?: number })
          .map(item => item.time)
          .filter((time): time is number => typeof time === 'number')
        if (times.length > 0) wallTimeMs = times[times.length - 1]! - times[0]!
      }
      scenarios[id] = {
        status: record !== undefined ? 'attempted' : 'not-run',
        verdict: record?.verdict ?? done?.verdict ?? null,
        skipReason: record === undefined && done !== undefined ? 'the recorded attempt status is not-run (see budget.stopRule)' : null,
        wallTimeMs: wallTimeMs ?? null,
        inputTokens: record?.usage.reduce((sum, item) => sum + item.inputTokens, 0) ?? 0,
        outputTokens: record?.usage.reduce((sum, item) => sum + item.outputTokens, 0) ?? 0,
        cacheReadTokens: record?.usage.reduce((sum, item) => sum + item.cacheReadTokens, 0) ?? 0,
        toolCalls: record?.toolCalls.length ?? 0,
        rootTerminal: record?.rootTerminal ?? null,
      }
    }

    const total = fromDisk.inputTokens + fromDisk.outputTokens
    const exceeded: string[] = []
    if (LIMITS.tokens !== null && total > LIMITS.tokens) exceeded.push(`tokens: ${total} > ${LIMITS.tokens}`)
    if (fromDisk.toolCalls > LIMITS.toolCalls) exceeded.push(`tool calls: ${fromDisk.toolCalls} > ${LIMITS.toolCalls}`)
    const wall = Object.values(scenarios).reduce((sum, item) => sum + ((item as { wallTimeMs?: number | null }).wallTimeMs ?? 0), 0)
    if (wall > LIMITS.wallTimeMs) exceeded.push(`wall clock: ${wall}ms > ${LIMITS.wallTimeMs}ms`)

    const budget = {
      limits: LIMITS,
      counted: fromDisk,
      totalTokens: total,
      totalWithCacheReads: total + fromDisk.cacheReadTokens,
      authorization: AUTHORIZATION,
      scenarios,
      exceeded,
      blocked: blocked ?? null,
      stopRule: exceeded.length > 0
        ? `the contract's stop rule fired: ${exceeded.join('; ')} — subsequent scenarios were aborted`
        : 'no limit was hit: the token cap was lifted by the operator authorization, and tool calls and wall clock are within their limits',
      note: 'Counted from the adapter layer (llm/stream usage chunks) and the tools/pre-execute record; there was no in-flight enforcement. inputTokens are the gateway uncached prompt tokens; cacheReadTokens are the gateway cached-prompt tokens reported beside them. The token cap is lifted (limits.tokens === null) under the 2026-09-23 authorization, so the token total is reported, not enforced or claimed against the old 30000 ceiling.',
    }
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(join(EVIDENCE, 'budget.json'), `${JSON.stringify(budget, null, 2)}\n`, 'utf8')

    // The driver package is archived once, from the S1 round (r1-driver.tgz);
    // this round's driver lives in scratch outside the repository and is never
    // packed or deleted here.
    console.log(`budget: ${JSON.stringify(budget, null, 1)}`)
  }, 120_000)
})
