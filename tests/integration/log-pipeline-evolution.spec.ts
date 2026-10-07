/**
 * Scripted failure repair for the log-pipeline world: a child stage fails its
 * real checker, the diagnosis is delivered to the responsible parent run, a
 * supervisor runs the whole evolution chain through the deployment's tools, the
 * repaired template is published as version 2, and the parent replan consumes it.
 *
 * Everything except the model is the real deployment: the real TaskRuntime,
 * AgentRuntime, verifier registry (with the command verifier), evolution plane
 * and approval seam. What is asserted is the chain the production code walks.
 *
 * @module tests/integration/log-pipeline-evolution
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { buildExperimentReport } from '../../evolution/src/index.ts'
import { responsibleParentRun } from '../../agent-singularity/src/coordination/handoff-rules.ts'
import { scanFailedReviewSources } from '../../agent-singularity/src/coordination/review-scan.ts'
import { rootTaskStoreId, type AcceptanceCriterion } from '../../task/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'
import { aggregateTemplate, CHECKER, CASE_1, checkoutTools, LOG_CONSTRAINTS, registerLogLibrary, stageCriteria } from '../support/log-pipeline.ts'

const ROOT = 's-root'
const OPERATOR = 's-operator'
const STORE = rootTaskStoreId(ROOT)
const PROPOSAL = 'p-repair-aggregate'
const AGGREGATE = 'aggregate-event-stats'
/** The frozen failing sample: a coordinator whose reproduction really re-runs the pipeline stages. Its id's first two characters (`tf`) are what the replayed spawn name exposes. */
const FIX_SAMPLE = 'tf-fix-pipeline'
const FIX_SAMPLE_RUN = 'r-fix-pipeline-history'
/** The holdout: a verified leaf whose reproduction passes on both sides. Its id's first two characters (`th`) are what the replayed spawn name exposes. */
const HOLDOUT_SAMPLE = 'th-holdout-parse'
const HOLDOUT_RUN = 'r-holdout-parse-history'

/** The reviewer's answer: a task_definition proposal for the internally inconsistent aggregate template. */
const REVIEW_REPLY = '```json\n'
  + '{"observation":"the aggregate stage produced a stats.json the fixed checker refutes",'
  + '"conclusion":"the aggregate-event-stats template objective asks for a byLevel field while its criterion requires perLevel",'
  + '"confidence":"high","proposals":[{"targetType":"task_definition","targetId":"aggregate-event-stats",'
  + '"rationale":"correcting the template objective to perLevel removes the contradiction the real checker exposes"}]}\n```'

const cell = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

interface Cells {
  /** Resolved by the spec once the repaired template is applied, releasing the parent's replan. */
  readonly applied: Promise<void>
  readonly resolveApplied: () => void
}

const dirs: string[] = []
afterEach(async () => {
  await disposeScriptedLoops()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'log-pipeline-evolution-'))
  dirs.push(dir)
  return dir
}

/** The parse module a stage worker (or a replayed holdout) authors. */
const PARSE_SOURCE = [
  "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
  "const log = process.argv[2] ?? 'events.log'",
  "const events = readFileSync(log, 'utf8').split('\\n').filter(line => line.trim() !== '').map(line => {",
  "  const [ts, level, ...rest] = line.split(' ')",
  "  return { ts, level, message: rest.join(' ') }",
  "})",
  "mkdirSync('out', { recursive: true })",
  "writeFileSync('out/events.json', JSON.stringify(events, null, 2))",
  '',
].join('\n')

/** The aggregate module: the field name is the one the template objective names. */
function aggregateSource(defective: boolean): string {
  const field = defective ? 'byLevel' : 'perLevel'
  return [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "const events = JSON.parse(readFileSync('out/events.json', 'utf8'))",
    `const ${field} = { INFO: 0, WARN: 0, ERROR: 0 }`,
    `for (const event of events) ${field}[event.level] += 1`,
    'const total = events.length',
    `const errorRate = Number((${field}.ERROR / total).toFixed(3))`,
    `writeFileSync('out/stats.json', JSON.stringify({ total, ${field}, errorRate }, null, 2))`,
    '',
  ].join('\n')
}

const REPORT_SOURCE = [
  "import { readFileSync, writeFileSync } from 'node:fs'",
  "const stats = JSON.parse(readFileSync('out/stats.json', 'utf8'))",
  "writeFileSync('out/report.md', ['# Log Report', 'Total: ' + stats.total, 'INFO: ' + stats.perLevel.INFO, 'WARN: ' + stats.perLevel.WARN, 'ERROR: ' + stats.perLevel.ERROR, 'Error rate: ' + stats.errorRate].join('\\n') + '\\n')",
  '',
].join('\n')

/** The template ref one `task_template_list` answer holds for the entry whose objective starts with `prefix`. */
function templateRefFrom(calls: readonly { sessionId: string; name: string; result?: { text: string } }[], prefix: string) {
  const listing = calls.filter(call => call.name === 'task_template_list' && call.result !== undefined).at(-1)
  const text = listing?.result?.text ?? ''
  const entries = text.startsWith('{') ? (JSON.parse(text) as { entries?: { kind: string; objective?: string; templateRef?: unknown }[] }).entries ?? [] : []
  const match = entries.find(entry => entry.kind === 'template' && (entry.objective ?? '').startsWith(prefix))
  if (match?.templateRef === undefined) throw new Error(`no task_template_list answer named a template whose objective starts with ${JSON.stringify(prefix)}`)
  return match.templateRef
}

/** One entry that blocks until the caller's own run is handed back `active` (its batch has ended). */
function waitForActiveRun(loop: () => ScriptedLoop, sessionId: string): ScriptEntry {
  return {
    waitFor: async () => {
      const deadline = Date.now() + 120_000
      for (;;) {
        const { run } = await loop().runForSession(sessionId)
        if (run.executionPhase === 'active') return
        if (Date.now() > deadline) {
          throw new Error(`the run bound to ${sessionId} never returned active (phase ${String(run.executionPhase)})`)
        }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    },
  }
}

/** The scripted deployment's one model: every session branch runs the real tools from here. */
function buildScript(h: () => ScriptedLoop, cells: Cells): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, _index) => {
    const loop = h()
    const name = loop.spawns.find(spawn => String(spawn.sessionId) === sessionId)?.name ?? ''
    if (String(sessionId) === OPERATOR) {
      return [
        { tool: 'evolution_decide', args: { proposalId: PROPOSAL, decision: 'PROMOTE', note: 'the two-sided experiment fixes the frozen failure' } },
        { tool: 'evolution_apply', args: { proposalId: PROPOSAL } },
        { text: 'operator: decided and applied' },
      ]
    }
    if (String(sessionId) === ROOT) {
      return [
        { tool: 'task_template_list' },
        {
          tool: 'task_decompose',
          args: calls => ({
            reason: 'own the analytics pipeline as one responsibility',
            children: [{ templateRef: templateRefFrom(calls, 'Own the log-analytics pipeline') }],
          }),
        },
        { text: 'root: the pipeline batch is running' },
        // The activation notice and the `begin` message open turns of their own,
        // so the submit waits on the store's own phase rather than on a turn count.
        waitForActiveRun(h, ROOT),
        { tool: 'task_submit_result', args: { summary: 'the pipeline delivered the three stage artifacts' } },
        { text: 'root: handed in' },
      ]
    }
    if (name.startsWith('supervisor for ')) {
      const diagnosisId = name.slice('supervisor for '.length)
      return [
        {
          tool: 'evolution_propose',
          args: {
            proposalId: PROPOSAL,
            level: 'L2',
            baseVersion: '1',
            targetType: 'task_definition',
            targetId: AGGREGATE,
            rationale: 'the aggregate template objective contradicts its fixed acceptance criterion',
            sourceRefs: [`diagnosis:${diagnosisId}`],
          },
        },
        {
          tool: 'evolution_candidate',
          args: {
            proposalId: PROPOSAL,
            versionSet: { [AGGREGATE]: '2' },
            mutationJson: JSON.stringify({ template: aggregateTemplate({ version: 2 }) }),
          },
        },
        { tool: 'evolution_prepare', args: { proposalId: PROPOSAL } },
        { tool: 'evolution_replay', args: { proposalId: PROPOSAL, taskIds: [FIX_SAMPLE], holdoutTaskIds: [HOLDOUT_SAMPLE] } },
        {
          tool: 'evolution_gate',
          args: calls => {
            const replay = calls.filter(call => call.name === 'evolution_replay').at(-1)
            const report = /report: (\S+)/.exec(replay?.result?.text ?? '')?.[1]
            return {
              proposalId: PROPOSAL,
              targetFailureFixed: 'the frozen failing reproduction passes on the candidate library',
              originalAcceptanceMaintained: 'the fixed checker and the parent oracle are unchanged',
              existingRegressionMaintained: 'the holdout reproduction passes on both libraries',
              noUnacceptableSideEffects: 'one appended template file, isolated side libraries',
              holdoutPerformanceAcceptable: 'the holdout passes on both sides',
              resourceCostAcceptable: 'recorded from the runs',
              regressionEvidenceRefs: report === undefined ? [] : [report],
            }
          },
        },
        // The same turn stays open through the apply, so the supervisor does not
        // go idle on a `gated` proposal: when it ends, the deployment notifies the
        // failed child's responsible parent to replan.
        { waitFor: () => cells.applied },
        { text: 'supervisor: the repair is applied; the responsible parent is notified' },
      ]
    }
    if (name.startsWith('review ')) return [{ text: REVIEW_REPLY }, { text: 'review: recorded' }]
    if (name.startsWith('Own the log-analytics pipeline')) {
      return [
        { tool: 'task_template_list' },
        { tool: 'task_decompose', args: calls => ({ templateRef: templateRefFrom(calls, 'Own the log-analytics pipeline'), templateParameters: {} }) },
        { text: 'pipeline: the stage batch is running' },
        // The failed batch handed this run back active; the repair has to be in
        // force before the replan binds the current template version.
        { waitFor: () => cells.applied },
        { tool: 'task_template_list' },
        {
          tool: 'task_decompose',
          args: calls => ({
            reason: 're-run the failed stage against the repaired template',
            children: [
              { templateRef: templateRefFrom(calls, 'Author aggregate.mjs') },
              { templateRef: templateRefFrom(calls, 'Author report.mjs'), dependsOn: [0] },
            ],
          }),
        },
        { text: 'pipeline: the repaired batch is running' },
        waitForActiveRun(h, sessionId),
        { tool: 'task_submit_result', args: { summary: 'the pipeline stages were re-run against the repaired template' } },
        { text: 'pipeline: handed in' },
      ]
    }
    // A replayed side: the lineage-prefixed spawn name exposes the sample id's
    // first two characters, which is what tells the two samples apart.
    if (name.startsWith('[evolution-experiment:')) {
      if (name.includes(':th')) {
        return [
          { waitFor: async () => { await writeFile(join(String(loop.agent(sessionId).session.header.cwd), 'parse.mjs'), PARSE_SOURCE) } },
          { tool: 'bash', args: { command: 'node parse.mjs events.log' } },
          { tool: 'task_submit_result', args: { summary: 'the holdout parsed the protected log' } },
          { text: 'holdout: handed in' },
        ]
      }
      return [
        { tool: 'task_template_list' },
        {
          tool: 'task_decompose',
          args: calls => ({
            reason: 'reproduce the three pipeline stages under this frozen library',
            children: [
              { templateRef: templateRefFrom(calls, 'Author parse.mjs') },
              { templateRef: templateRefFrom(calls, 'Author aggregate.mjs'), dependsOn: [0] },
              { templateRef: templateRefFrom(calls, 'Author report.mjs'), dependsOn: [1] },
            ],
          }),
        },
        { text: 'reproduction: the stage batch is running' },
        { tool: 'task_submit_result', args: { summary: 'the reproduction is handed in' } },
        { text: 'reproduction: handed in' },
      ]
    }
    if (name.startsWith('Author parse.mjs')) {
      return [
        { waitFor: async () => { await writeFile(join(String(loop.agent(sessionId).session.header.cwd), 'parse.mjs'), PARSE_SOURCE) } },
        { tool: 'bash', args: { command: 'node parse.mjs events.log' } },
        { tool: 'task_submit_result', args: { summary: 'delivered parse.mjs and out/events.json' } },
        { text: 'parse: handed in' },
      ]
    }
    if (name.startsWith('Author aggregate.mjs')) {
      return [
        {
          waitFor: async () => {
            const { task } = await loop.runForSession(sessionId)
            const objective = task.contract?.objective ?? task.objective
            await writeFile(join(String(loop.agent(sessionId).session.header.cwd), 'aggregate.mjs'), aggregateSource(objective.includes('byLevel')))
          },
        },
        { tool: 'bash', args: { command: 'node aggregate.mjs' } },
        { tool: 'task_submit_result', args: { summary: 'delivered aggregate.mjs and out/stats.json' } },
        { text: 'aggregate: handed in' },
      ]
    }
    if (name.startsWith('Author report.mjs')) {
      return [
        { waitFor: async () => { await writeFile(join(String(loop.agent(sessionId).session.header.cwd), 'report.mjs'), REPORT_SOURCE) } },
        { tool: 'bash', args: { command: 'node report.mjs' } },
        { tool: 'task_submit_result', args: { summary: 'delivered report.mjs and out/report.md' } },
        { text: 'report: handed in' },
      ]
    }
    return [{ text: 'idle' }]
  }
}

/** A criterion in the shape the store records for a real admitted one. */
function criterion(criterionId: string, command: string): AcceptanceCriterion {
  return {
    criterionId,
    description: 'it holds',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    command,
    verifierRef: 'command',
  }
}

/**
 * Write one terminal sample straight into the store through the store's own
 * service: the historical record a task_definition experiment locates its case
 * by. `outcome` is what its latest review says — the role rule reads exactly that.
 */
async function writeSample(h: ScriptedLoop, input: {
  taskId: string
  runId: string
  objective: string
  acceptance: AcceptanceCriterion
  requiredCapabilities: string[]
  outcome: 'verified' | 'failed'
}): Promise<void> {
  const contract = {
    contractVersion: 1 as const,
    objective: input.objective,
    acceptanceCriteria: [input.acceptance],
    assumptions: [],
    constraints: [...LOG_CONSTRAINTS],
    requiredCapabilities: [...input.requiredCapabilities],
    templateScope: [['logs']],
  }
  await h.task.createTaskIn(STORE, {
    taskId: input.taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: input.objective,
    depth: 0,
    acceptanceCriteria: [input.acceptance],
    requestedCapabilities: [...input.requiredCapabilities],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    contract,
  }, 'tester')
  await h.task.admitTaskIn(STORE, input.taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(STORE, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: `s-${input.taskId}`,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, input.taskId, input.runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(STORE, {
    evidenceId: `e-${input.runId}`,
    taskRunId: input.runId,
    taskId: input.taskId,
    artifacts: [],
    verifierResults: [{
      criterionId: input.acceptance.criterionId,
      status: input.outcome === 'verified' ? 'pass' : 'fail',
      verifierId: 'command',
      ...(input.outcome === 'failed' ? { exitCode: 1 } : { exitCode: 0 }),
    }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(STORE, input.taskId, input.runId, input.outcome, 'tester', {
    ...(input.outcome === 'failed' ? { reason: 'the aggregate stage contradicted the fixed checker' } : {}),
  })
  await h.task.recordReviewIn(STORE, {
    taskId: input.taskId,
    runId: input.runId,
    sessionId: `s-${input.taskId}`,
    outcome: input.outcome,
    evidenceRefs: [`e-${input.runId}`],
    anomalies: [`the historical sample "${input.taskId}" locates`],
    ...(input.outcome === 'failed' ? { localizedCause: 'the aggregate stage contradicted the fixed checker' } : {}),
    criteria: [{ criterionId: input.acceptance.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
  }, 'tester')
}

/** The two frozen samples every case evaluates. */
async function writeSamples(h: ScriptedLoop): Promise<void> {
  await writeSample(h, {
    taskId: FIX_SAMPLE,
    runId: FIX_SAMPLE_RUN,
    objective: 'Reproduce the failing log-analytics pipeline work over events.log',
    acceptance: criterion('pipeline-result', 'node checks/verify.mjs pipeline'),
    requiredCapabilities: ['coordinate-tasks'],
    outcome: 'failed',
  })
  await writeSample(h, {
    taskId: HOLDOUT_SAMPLE,
    runId: HOLDOUT_RUN,
    objective: 'Parse the protected log as an independent holdout',
    acceptance: criterion('parse-result', 'node checks/verify.mjs parse'),
    requiredCapabilities: ['local-files'],
    outcome: 'verified',
  })
}

/** Whether one session's durable log holds the identity of one delivered message. */
function holdsMessage(h: ScriptedLoop, sessionId: string, messageId: string): boolean {
  return h.eventsOf(sessionId).some(event => {
    const data = event.data as { id?: string; inserted?: readonly { id?: string }[] }
    if ((event.type === 'user/message' || event.type === 'agent/inbox/spliced') && data.id === messageId) return true
    return event.type === 'agent/inbox/spliced' && (data.inserted ?? []).some(message => message.id === messageId)
  })
}

/** The ledger's own lines, read from disk (the append-only file, never the service's memory). */
function ledgerKinds(ledgerRoot: string): string[] {
  const file = join(ledgerRoot, 'proposals.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => String((JSON.parse(line) as { kind: string }).kind))
}

async function run(): Promise<void> {
  const ledgerRoot = join(scratch(), 'evolution')
  const applied = cell<void>()
  const cells: Cells = { applied: applied.promise, resolveApplied: applied.resolve }
  let h!: ScriptedLoop
  h = await startScriptedLoop({
    roots: [ROOT, OPERATOR],
    capabilities: {
      'coordinate-tasks': { skills: ['task-coordination'] },
      'local-files': { skills: ['task-execution'], tools: ['filesystem'] },
    },
    script: (sessionId, index) => buildScript(() => h, cells)(sessionId, index),
    evolution: { ledgerRoot },
    // The evolution asks are held for the spec to answer: the person's two gates.
    approvalAnswer: ask => (ask.toolName.startsWith('evolution_') ? undefined : 'allowed-once'),
    tools: checkoutTools(),
  })
  mkdirSync(join(h.checkout, 'checks'), { recursive: true })
  writeFileSync(join(h.checkout, 'events.log'), CASE_1)
  writeFileSync(join(h.checkout, 'checks/verify.mjs'), CHECKER)
  // The defective library: the aggregate template asks for `byLevel` while its
  // criterion is the fixed `node checks/verify.mjs aggregate` (which wants `perLevel`).
  await registerLogLibrary(h.runtime, { aggregate: 'defective' })

  const root = await h.begin({
    objective: 'Own the log-analytics pipeline and deliver its three stage artifacts from events.log.',
    acceptanceCriteria: stageCriteria('pipeline'),
    requiredCapabilities: ['coordinate-tasks'],
    templateScope: [['logs']],
    constraints: LOG_CONSTRAINTS,
  })

  // ── the defective stage fails the real checker ───────────────────────────
  const aggregateTask = await vi.waitFor(async () => {
    const found = (await h.snapshot(STORE)).tasks.find(task => task.templateRef?.id === AGGREGATE)
    expect(found).toBeDefined()
    return found!
  }, { timeout: 60_000, interval: 25 })
  await vi.waitFor(async () => expect((await h.task.taskIn(STORE, aggregateTask.taskId)).status).toBe('failed'), { timeout: 60_000, interval: 25 })
  expect(aggregateTask.templateRef?.version).toBe(1)
  expect(aggregateTask.contract?.objective).toContain('byLevel')
  const aggregateRun = (await h.snapshot(STORE)).runs.filter(run => run.taskId === aggregateTask.taskId).at(-1)!
  const verdict = (await h.snapshot(STORE)).evidence
    .filter(item => item.taskRunId === aggregateRun.runId)
    .flatMap(item => item.verifierResults)
    .find(item => item.criterionId === 'aggregate-result')!
  expect(verdict.verifierId).toBe('command')
  expect(verdict.status).toBe('fail')
  expect(verdict.exitCode).not.toBe(0)
  expect(readFileSync(join(h.workspace, 'evidence', verdict.logRef!), 'utf8')).toContain('stats.json does not match')
  const pipelineTask = (await h.snapshot(STORE)).tasks.find(task => task.templateRef?.id === 'log-analytics-pipeline')!
  const parseTask = (await h.snapshot(STORE)).tasks.find(task => task.templateRef?.id === 'parse-log-events')!
  await vi.waitFor(async () => expect((await h.task.taskIn(STORE, parseTask.taskId)).status).toBe('verified'), { timeout: 60_000, interval: 25 })

  // ── the frozen samples the experiment will evaluate ──────────────────────
  const pipelineRun = (await h.snapshot(STORE)).runs.filter(run => run.taskId === pipelineTask.taskId).at(-1)!
  const runBeforeRepair = structuredClone(aggregateRun)
  await writeSamples(h)

  // ── the review produces the diagnosis and delivers it to the parent ──────
  await vi.waitFor(async () => {
    const snapshot = await h.snapshot(STORE)
    expect(snapshot.reviews.some(review => review.taskId === aggregateTask.taskId && review.outcome === 'failed')).toBe(true)
  }, { timeout: 30_000, interval: 25 })
  const scan = await scanFailedReviewSources(h.ctx, STORE, { source: { taskId: aggregateTask.taskId, runId: aggregateRun.runId } })
  expect(scan.entries[0]?.result).toBe('started')
  const diagnosis = (await h.snapshot(STORE)).diagnoses.find(item => item.taskId === aggregateTask.taskId)!
  expect(diagnosis.proposals.map(proposal => [proposal.targetType, proposal.targetId])).toEqual([['task_definition', AGGREGATE]])
  const parent = responsibleParentRun(await h.snapshot(STORE), diagnosis)!
  expect(parent.taskId).toBe(pipelineTask.taskId)
  expect(parent.runId).toBe(pipelineRun.runId)
  // The diagnosis went to the pipeline run that delegated the failed child — not
  // to the graph root, and no new root was spun for it.
  expect(holdsMessage(h, parent.sessionId, `m-diagnosis-${diagnosis.diagnosisId}`)).toBe(true)
  expect(holdsMessage(h, root.sessionId, `m-diagnosis-${diagnosis.diagnosisId}`)).toBe(false)

  // ── the scripted supervisor runs the whole evolution chain ───────────────
  const gated = await vi.waitFor(async () => {
    const proposal = await h.ctx.evolution.get(PROPOSAL)
    expect(proposal.status, JSON.stringify(h.calls.filter(call => call.name.startsWith('evolution_')).map(call => [call.name, call.result?.text?.slice(0, 200)]))).toBe('gated')
    return proposal
  }, { timeout: 120_000, interval: 25 })
  expect(gated.targetType).toBe('task_definition')
  const [experiment] = await h.ctx.evolution.experiments(PROPOSAL)
  const report = buildExperimentReport(experiment!)
  expect(report.verdict).toBe('fixed')
  const fixSample = report.samples.find(sample => sample.taskId === FIX_SAMPLE)!
  expect(fixSample.baseline.outcome).toBe('failed')
  expect(fixSample.candidate.outcome).toBe('verified')
  const holdout = report.samples.find(sample => sample.taskId === HOLDOUT_SAMPLE)!
  expect([holdout.baseline.outcome, holdout.candidate.outcome]).toEqual(['verified', 'verified'])

  // ── the model decides and a person approves publication ───────────────────
  h.userSays('decide and apply the repair', OPERATOR)
  await vi.waitFor(() => expect(h.review.asks.some(ask => ask.toolName === 'evolution_apply')).toBe(true), { timeout: 60_000, interval: 25 })
  h.review.answer(h.review.asks.findIndex(ask => ask.toolName === 'evolution_apply'), 'allowed-once')
  await vi.waitFor(async () => expect((await h.ctx.evolution.get(PROPOSAL)).status).toBe('applied'), { timeout: 60_000, interval: 25 })
  const library = h.runtime.config.taskTemplatesRoot!
  expect(JSON.parse(readFileSync(join(library, `${AGGREGATE}@1.json`), 'utf8')).contract.objective).toContain('byLevel')
  expect(JSON.parse(readFileSync(join(library, `${AGGREGATE}@2.json`), 'utf8')).contract.objective).toContain('perLevel')

  // ── the parent replans and consumes version 2 ────────────────────────────
  // Releasing the apply lets the parent replan and the supervisor finish; the
  // runtime then wakes the parent with the durable applied-change message.
  cells.resolveApplied()
  await vi.waitFor(() => expect(holdsMessage(h, parent.sessionId, `m-evolution-${PROPOSAL}-${parent.runId}`)).toBe(true), { timeout: 60_000, interval: 25 })
  await vi.waitFor(async () => expect((await h.task.taskIn(STORE, root.taskId)).status).toBe('verified'), { timeout: 120_000, interval: 25 })
  const final = await h.snapshot(STORE)
  expect(final.tasks.find(task => task.taskId === pipelineTask.taskId)?.status).toBe('verified')
  const aggregateTasks = final.tasks.filter(task => task.parentTaskId === pipelineTask.taskId && task.templateRef?.id === AGGREGATE)
  expect(aggregateTasks.map(task => task.templateRef?.version)).toEqual([1, 2])
  expect(aggregateTasks.map(task => task.status)).toEqual(['failed', 'verified'])
  // History is frozen: the old failed run and its version-1 binding are untouched.
  expect(final.runs.find(run => run.runId === aggregateRun.runId)).toEqual(runBeforeRepair)
  expect(final.tasks.find(task => task.taskId === aggregateTask.taskId)?.templateRef?.version).toBe(1)
  expect(final.tasks.find(task => task.taskId === aggregateTask.taskId)?.contract?.objective).toContain('byLevel')
  // The publish appended a version; it did not overwrite the defective content.
  expect(ledgerKinds(ledgerRoot)).toEqual([
    'proposed', 'candidate', 'prepared', 'experiment_started',
    'experiment_sample', 'experiment_sample', 'experiment_sample', 'experiment_sample',
    'gated', 'decided', 'commit_intent', 'applied',
  ])
  await h.dispose()
}

it('repairs a defective Task template through the scripted supervisor and consumes version 2 on the parent replan', async () => {
  await run()
}, 180_000)
