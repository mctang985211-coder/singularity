/**
 * A6 interface ② end to end, on the real deployment: the two-sided **capability**
 * experiment — the real task store, `TaskRuntime.replayTask` with its own
 * admission chain, the real `AgentRuntime.spawn` over the real skill plane, and
 * the real `VerifierRegistry` with its command verifier.
 *
 * What the spec pins, and why each assertion is read from a durable surface:
 *
 * 1. **The baseline is really refused.** The samples require a capability row the
 *    effective table does not hold, so the baseline side is offered to the
 *    runtime, the runtime's own admission chain refuses it, and the ledger
 *    records `not-admitted` with that refusal and the gap it stands for — no
 *    Task, no Run, no Review, no champion and no failure run invented in its
 *    place.
 * 2. **The candidate really runs.** The candidate side mounts the prepared
 *    row and the prepared skill through the overlay, executes on the real store
 *    and passes the frozen judge (the registered `command` verifier) — the fix is
 *    a run, never an admission that merely went through.
 * 3. **The gate reads that evidence.** `checkPromotion` passes only on a clean
 *    `fixed` verdict whose baseline records are the frozen refusals and whose
 *    candidate sides are real verified runs, and `decide(PROMOTE)` then reaches
 *    the human-decision state.
 *
 * The model loop is replaced by run-stack's worker hook — the scripted worker
 * reads the skill bytes its own spawn would have loaded and does what they say.
 * Everything else is the deployment's own: the store, the runtime, the verifier,
 * the ledger.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CapabilityConfig, Config } from '../../task-runtime/src/index.ts'
import { SKILL_SIDECAR_FILE, serializeSkillSidecar } from '../../task-runtime/src/index.ts'
import { EvolutionService } from '../../evolution/src/index.ts'
import type { GateAnswers, ProposeInput } from '../../evolution/src/index.ts'
import { modelSelectionOf } from '../../evolution/src/index.ts'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import { supervisorDelegationSource } from '../../agent-singularity/src/review-agent-ledger.ts'
import { readSupervisorHandoff } from '../../agent-singularity/src/review-agent-ledger.ts'
import { startSupervisorHandoff } from '../../agent-singularity/src/evolution-handoff.ts'
import { defineTaskRecoverTool } from '../../agent-singularity/src/tools/task-recover.ts'
import { readFile as readConfig } from 'node:fs/promises'
import { writeCapabilityConfig } from '../support/capability-config.ts'
import { disposeRunStacks, ScriptedBudgetApproval, startRunStack, type RunStack } from '../support/run-stack.ts'

const ROOT = 's-root' as SessionId
const PROPOSAL = 'p-cap'
/** The row the samples require and production does not hold — the gap the candidate closes. */
const ROW = 'capability-experiment-row'
/** The skill the candidate's row grants, written into the sandbox and loaded by the candidate's own spawn. */
const SKILL = 'capability-experiment-skill'
/** The evidence file the candidate skill's body tells its worker to write. */
const ANSWER = 'fixed.txt'
/** The row the fixture deployment already holds, so the new row's tools are inside the authorized plane. */
const STORE_ROW = 'capability-experiment-store-row'
const STORE_SKILL = 'capability-experiment-store-skill'
const STORE_ENTRY: CapabilityConfig = { skills: [STORE_SKILL], tools: ['filesystem'] }

const SELECTION = modelSelectionOf({ provider: 'scripted', model: 'run-stack' })!

/** The refusal a recovery gets while the capability it stands on is not yet in force. */
const RowInForce = 'capability change this hand-off depends on'

/** The candidate skill's `SKILL.md`: a loadable object whose body is what the scripted worker does. */
function skillText(body: string): string {
  return `---\nname: ${SKILL}\ndescription: capability experiment fixture skill\n---\n\n${body}\n`
}

const CANDIDATE_TEXT = skillText(`WRITE:${ANSWER}`)
const CANDIDATE_BODY = `WRITE:${ANSWER}`
const PRODUCTION_TEXT = skillText('WRITE:nothing.txt')

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The new skill's execution declaration: the row grants it, and the registered `command` verifier judges it. */
function sidecar(content: string, row: string = ROW): unknown {
  return {
    contractVersion: 1,
    type: 'execution',
    capabilities: [row],
    precondition: 'the fixture gap is present',
    inputs: [],
    outputs: [],
    requiredTools: ['read', 'write'],
    verifier: { ref: 'command' },
    content: { skillMdSha256: sha256Hex(content), resources: [] },
  }
}

const proposal: ProposeInput = {
  proposalId: PROPOSAL,
  targetType: 'capability',
  targetId: ROW,
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the store has no capability that grants the skill this case needs',
  sourceRefs: ['diagnosis:d-cap'],
}

function gateAnswers(refs: string[]): GateAnswers {
  return {
    targetFailureFixed: 'the fixture case passes on the candidate',
    originalAcceptanceMaintained: 'the acceptance identity is unchanged',
    existingRegressionMaintained: 'the holdout still passes',
    noUnacceptableSideEffects: 'one row and one new skill directory',
    holdoutPerformanceAcceptable: 'the held-out case still passes',
    resourceCostAcceptable: 'recorded, not inferred',
    regressionEvidenceRefs: refs,
  }
}

/** One command-settled criterion, as a sample task carries it. */
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

/** Write one terminal sample straight into the store through the store's own service. */
async function writeSample(h: RunStack, storeId: string, input: {
  taskId: string
  runId: string
  objective: string
  acceptance: AcceptanceCriterion
  outcome: 'verified' | 'failed'
}): Promise<void> {
  await h.task.createTaskIn(storeId, {
    taskId: input.taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: input.objective,
    depth: 0,
    acceptanceCriteria: [input.acceptance],
    requestedCapabilities: [ROW],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
    // The sample is a task of its own (a parentless one), so a recovery can be
    // opened for it: the original contract is what the new attempt is bound to.
    contract: {
      contractVersion: 1,
      objective: input.objective,
      acceptanceCriteria: [input.acceptance],
      assumptions: [],
      constraints: [],
      requiredCapabilities: [ROW],
    },
  }, 'tester')
  await h.task.admitTaskIn(storeId, input.taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(storeId, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: `s-${input.taskId}`,
    capabilitySnapshot: [],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(storeId, {
    evidenceId: `e-${input.runId}`,
    taskRunId: input.runId,
    taskId: input.taskId,
    artifacts: [],
    verifierResults: [{ criterionId: input.acceptance.criterionId, status: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, input.outcome, 'tester', {
    ...(input.outcome === 'failed' ? { reason: 'the capability could not run this case at all' } : {}),
  })
  await h.task.recordReviewIn(storeId, {
    taskId: input.taskId,
    runId: input.runId,
    sessionId: `s-${input.taskId}`,
    outcome: input.outcome,
    evidenceRefs: [`e-${input.runId}`],
    anomalies: [`the historical run sample "${input.taskId}" locates`],
    ...(input.outcome === 'failed' ? { localizedCause: 'no provider could run this case' } : {}),
    criteria: [{ criterionId: input.acceptance.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
  }, 'tester')
}

interface Fixture {
  h: RunStack
  evolution: EvolutionService
  storeId: string
  snapshotDir: string
  /** The deployment's own `config.yml`, whose capability table a commit writes (A6). */
  configFile: string
}

/**
 * One capability experiment fixture: a deployment whose table holds one
 * unrelated row (and the tool plane that row authorizes), a production skill
 * root, a prepared capability candidate — the row the samples need plus the new
 * execution skill it grants — and two terminal samples, the failed case the
 * candidate is meant to fix and a holdout.
 */
async function fixture(options: { rootBudget?: Config['rootBudget']; rowOnly?: boolean } = {}): Promise<Fixture> {
  const rowOnly = options.rowOnly === true
  // The provider a row-only candidate's row grants: the **production** execution
  // object itself (no new skill is carried), whose body names the file its worker
  // writes — so the case's verdict rests on the object the row really loads.
  const rowOnlySkill = 'capability-row-only-skill'
  const rowOnlyText = skillText(`WRITE:${ANSWER}`).replace(SKILL, rowOnlySkill)
  const rowOf = (): Record<string, CapabilityConfig> => rowOnly
    ? { [ROW]: { skills: [rowOnlySkill], tools: ['filesystem'] } }
    : { [ROW]: { skills: [SKILL], tools: ['filesystem'] } }
  let h!: RunStack
  h = await startRunStack({
    roots: [ROOT],
    capabilities: { [STORE_ROW]: STORE_ENTRY },
    ...(options.rootBudget === undefined ? {} : { rootBudget: { ...options.rootBudget } }),
    worker: async (sessionId: SessionId, agent: Agent) => {
      const { task, run } = await h.runtime.runForSession(sessionId)
      // A child works in its parent's checkout; the fixture's own root run — the
      // one this spec activates — is left to the cases. A **recovery attempt** is
      // a root run of its own and is *not* skipped: it is the run whose worker has
      // to load the row's provider.
      if (task.parentTaskId !== undefined || (run.parentRunId === undefined && run.recovery === undefined)) return
      const request = h.spawns.find(item => String(item.sessionId) === String(sessionId))
      const roots = [...(request?.grant?.skillRoots ?? []), join(h.home, 'skills')]
      const names = [SKILL, rowOnlySkill]
      for (const root of roots) {
        for (const name of names) {
          const body = await readFile(join(root, name, 'SKILL.md'), 'utf8').catch(() => '')
          if (body.length === 0) continue
          for (const file of [ANSWER, 'nothing.txt']) {
            if (!body.includes(`WRITE:${file}`)) continue
            await writeFile(join(agent.session.header.cwd, file), `${file}\n`)
          }
          return
        }
      }
    },
  })
  const skillRoot = join(h.home, 'skills')
  await mkdir(join(skillRoot, STORE_SKILL), { recursive: true })
  await writeFile(join(skillRoot, STORE_SKILL, 'SKILL.md'), PRODUCTION_TEXT)
  if (rowOnly) {
    // The object the new row grants: an execution provider of *both* rows, so the
    // deployment's own row may keep granting it and the candidate row may add a
    // second way to reach the same object.
    const directory = join(skillRoot, rowOnlySkill)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), rowOnlyText)
    await writeFile(join(directory, SKILL_SIDECAR_FILE), serializeSkillSidecar({
      contractVersion: 1,
      type: 'execution',
      capabilities: [STORE_ROW, ROW],
      precondition: 'the fixture gap is present',
      inputs: [],
      outputs: [],
      requiredTools: ['read', 'write'],
      verifier: { ref: 'command' },
      content: { skillMdSha256: sha256Hex(rowOnlyText), resources: [] },
    } as never))
  }
  // The capability table's own file (A6): the apply writes the row it commits
  // here before it records the completion, so a restart loads what the commit
  // installed.
  const configFile = await writeCapabilityConfig(join(h.workspace, 'config.yml'), { [STORE_ROW]: STORE_ENTRY })
  const evolution = new EvolutionService(h.ctx, {
    root: join(h.workspace, 'evolution'),
    skillRoot,
    modelSelection: () => SELECTION,
    capabilityConfig: configFile,
    // The hand-off consumption and the recovery entry read the coordinator's
    // delegation from the coordination ledger (A6); this deployment turns the
    // chain on, which is what the consumption reads.
    supervisorDelegation: supervisorDelegationSource().read,
  })
  h.ctx.provide('singularityEvolution', { enabled: true })
  await evolution.propose(proposal, ROOT)
  await evolution.candidate(PROPOSAL, { capabilityTable: 'config.yml#doc' }, ROOT, rowOnly
    ? { rows: rowOf() }
    : { rows: rowOf(), skill: { name: SKILL, content: CANDIDATE_TEXT, sidecar: sidecar(CANDIDATE_TEXT) } })
  await evolution.prepare(PROPOSAL, ROOT)

  const first = await h.root(ROOT, {
    objective: 'evaluate the capability candidate',
    acceptanceCriteria: [{ criterionId: 'root-goal', description: 'delivered', command: 'true' }],
  })
  const snapshotDir = join(h.workspace, 'snapshot')
  await mkdir(snapshotDir, { recursive: true })
  await writeFile(join(snapshotDir, 'input.txt'), 'the frozen input\n')
  await writeSample(h, first.storeId, {
    taskId: 't-cap-fix',
    runId: 'r-cap-fix-history',
    objective: `the case needs the ${ROW} capability`,
    acceptance: criterion('ac-cap-fix', `test -f ${ANSWER}`),
    outcome: 'failed',
  })
  await writeSample(h, first.storeId, {
    taskId: 't-cap-holdout',
    runId: 'r-cap-holdout-history',
    objective: 'a held-out case the candidate must not break',
    acceptance: criterion('ac-cap-holdout', `test -f ${ANSWER}`),
    outcome: 'verified',
  })
  return { h, evolution, storeId: first.storeId, snapshotDir, configFile }
}

afterEach(async () => {
  await disposeRunStacks()
})

describe('A6: the two-sided capability experiment on the real deployment', () => {
  it('refuses the missing-provider baseline at admission, runs the candidate for real, and gates on that evidence', async () => {
    const f = await fixture()
    const before = await f.h.snapshot(f.storeId)
    const result = await f.evolution.runExperiment({
      proposalId: PROPOSAL,
      samples: [
        { taskId: 't-cap-fix', role: 'observed-failure' },
        { taskId: 't-cap-holdout', role: 'holdout' },
      ],
      snapshot: { sourceDir: f.snapshotDir },
      model: SELECTION,
      budget: { note: 'the fixture budget — no token ceiling, so no side has to report metrics' },
      repetition: 0,
    }, ROOT, ROOT)

    // --- the report: the gap is the baseline, the candidate is the fix ---
    expect(result.report.verdict).toBe('fixed')
    expect(result.report.samples.map(sample => sample.verdict)).toEqual(['fixed', 'maintained'])
    const fix = result.report.samples[0]!
    expect(fix.baseline.outcome).toBe('not-admitted')
    expect(fix.baseline.taskId).toBeUndefined()
    expect(fix.baseline.runId).toBeUndefined()
    expect(fix.baseline.admission).toMatchObject({
      source: 'capability-gap',
      proposalId: PROPOSAL,
      sourceRefs: ['diagnosis:d-cap'],
      required: [ROW],
      missing: [ROW],
    })
    // The refusal is the runtime's own, produced when the side was really
    // offered to it — never a description this plane wrote for it.
    expect(fix.baseline.admission!.reason).toContain('task-runtime:')
    expect(fix.baseline.admission!.reason).toContain('capability gap')
    expect(fix.baseline.evidenceRefs).toEqual([])
    // The candidate really executed and passed the registered judge.
    expect(fix.candidate.outcome).toBe('verified')
    expect(fix.candidate.criteria).toEqual([expect.objectContaining({ criterionId: 'ac-cap-fix', verdict: 'pass', verifierId: 'command' })])
    expect(result.report.samples[1]!.candidate.outcome).toBe('verified')

    // --- the store: one new replay per sample (the candidate side), and no
    // baseline replay at all — nothing was invented in the refused side's place.
    const after = await f.h.snapshot(f.storeId)
    const created = after.tasks.filter(task => !before.tasks.some(previous => previous.taskId === task.taskId))
    expect(created).toHaveLength(2)
    for (const task of created) expect(task.objective).toContain(':candidate] ')
    expect(after.tasks.some(task => task.objective.includes(':baseline] '))).toBe(false)
    // The candidate's own run wrote the answer the criterion asks for, in its
    // own workspace built from the frozen input.
    const candidateWorkspace = fix.candidate.workspace
    expect(existsSync(join(candidateWorkspace, ANSWER))).toBe(true)
    expect(await readFile(join(candidateWorkspace, 'input.txt'), 'utf8')).toBe('the frozen input\n')

    // --- the ledger: one record per side, the baseline one carrying the refusal ---
    const ledger = (await readFile(join(f.h.workspace, 'evolution', 'proposals.jsonl'), 'utf8'))
      .split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    const baselineRecords = ledger.filter(line => line.kind === 'experiment_sample' && line.side === 'baseline')
    expect(baselineRecords).toHaveLength(2)
    for (const record of baselineRecords) {
      expect(record.outcome).toBe('not-admitted')
      expect(record.taskId).toBeUndefined()
      expect(record.runId).toBeUndefined()
      expect(record.initialDigest).toBeUndefined()
    }

    // --- re-running the experiment reuses every settled side and writes nothing new ---
    const spawnsBefore = f.h.spawns.length
    const again = await f.evolution.runExperiment({
      proposalId: PROPOSAL,
      samples: [
        { taskId: 't-cap-fix', role: 'observed-failure' },
        { taskId: 't-cap-holdout', role: 'holdout' },
      ],
      snapshot: { sourceDir: f.snapshotDir },
      model: SELECTION,
      budget: { note: 'the fixture budget — no token ceiling, so no side has to report metrics' },
      repetition: 0,
    }, ROOT, ROOT)
    expect(JSON.stringify(again.report)).toBe(JSON.stringify(result.report))
    expect(f.h.spawns.length).toBe(spawnsBefore)

    // --- the gate reads it: only this evidence promotes, and the human decides ---
    const evidence = await f.evolution.checkPromotion(PROPOSAL)
    expect(evidence.providers).toHaveLength(1)
    await f.evolution.gate(PROPOSAL, gateAnswers([result.reportPath]), ROOT)
    expect((await f.evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:decide')).status).toBe('decided')
  })

  it('leaves production untouched while the gate is refused, and commits the row and the object once it passes', async () => {
    const f = await fixture()
    const skillRoot = join(f.h.home, 'skills')
    const before = await readFile(join(f.h.workspace, 'evolution', 'proposals.jsonl'), 'utf8')
    // Nothing has been evaluated yet: the promotion preflight every promotion
    // entry runs is refused by name, and no decision, commit or production write
    // exists.
    const refusal = await f.evolution.checkPromotion(PROPOSAL).then(() => '', error => String(error))
    expect(refusal).toContain('carries no two-sided experiment')
    const afterRefusal = await readFile(join(f.h.workspace, 'evolution', 'proposals.jsonl'), 'utf8')
    expect(afterRefusal).toBe(before)
    expect(existsSync(join(skillRoot, SKILL))).toBe(false)
    expect(f.h.runtime.listCapabilities()[ROW]).toBeUndefined()

    // With the real evidence recorded, the same entry reaches `decided` and the
    // apply writes the row through the runtime's own seam.
    const result = await f.evolution.runExperiment({
      proposalId: PROPOSAL,
      samples: [
        { taskId: 't-cap-fix', role: 'observed-failure' },
        { taskId: 't-cap-holdout', role: 'holdout' },
      ],
      snapshot: { sourceDir: f.snapshotDir },
      model: SELECTION,
      budget: { note: 'the fixture budget — no token ceiling, so no side has to report metrics' },
      repetition: 0,
    }, ROOT, ROOT)
    await f.evolution.gate(PROPOSAL, gateAnswers([result.reportPath]), ROOT)
    await f.evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:decide')
    const outcome = await f.evolution.apply(PROPOSAL, ROOT, 'approval:apply')
    expect(outcome.targets).toEqual([
      join(skillRoot, SKILL, 'SKILL.md'),
      join(skillRoot, SKILL, SKILL_SIDECAR_FILE),
    ])
    expect(await readFile(join(skillRoot, SKILL, 'SKILL.md'), 'utf8')).toBe(CANDIDATE_TEXT)
    expect(await readFile(join(skillRoot, SKILL, SKILL_SIDECAR_FILE), 'utf8')).toBe(serializeSkillSidecar(sidecar(CANDIDATE_TEXT) as never))
    expect(f.h.runtime.listCapabilities()[ROW]).toEqual({ skills: [SKILL], tools: ['filesystem'] })
  })
})

describe('A6: the capability experiment refuses what it cannot evaluate', () => {
  it('refuses a candidate whose own overlay does not resolve the samples, before any run', async () => {
    const f = await fixture()
    const before = await f.h.snapshot(f.storeId)
    // Another candidate whose row grants another name than the samples require:
    // its overlay resolves nothing for these cases, so the candidate side could
    // not run them — a candidate that cannot run the case it is evaluated on
    // proves nothing, and the experiment is refused before it runs.
    await f.evolution.propose({ ...proposal, proposalId: 'p-other', targetId: 'another-row', sourceRefs: ['diagnosis:d2'] }, ROOT)
    const otherText = skillText('WRITE:other.txt').replace(SKILL, 'another-skill')
    await f.evolution.candidate('p-other', { capabilityTable: 'config.yml#doc' }, ROOT, {
      rows: { 'another-row': { skills: ['another-skill'], tools: ['filesystem'] } },
      skill: { name: 'another-skill', content: otherText, sidecar: sidecar(otherText, 'another-row') },
    })
    await f.evolution.prepare('p-other', ROOT)
    const refusal = await f.evolution.runExperiment({
      proposalId: 'p-other',
      samples: [
        { taskId: 't-cap-fix', role: 'observed-failure' },
        { taskId: 't-cap-holdout', role: 'holdout' },
      ],
      snapshot: { sourceDir: f.snapshotDir },
      model: SELECTION,
      budget: {},
      repetition: 0,
    }, ROOT, ROOT).then(() => '', error => String(error))
    expect(refusal).toContain('which the candidate overlay does not resolve')
    const after = await f.h.snapshot(f.storeId)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs).toHaveLength(before.runs.length)
  })
})
describe('A6: an applied capability is what a supervisor\'s recovery rests on', () => {
  it('writes the row into the config table, and opens the failed root\'s new attempt only after it is in force', async () => {
    const f = await fixture()
    const diagnosis = {
      diagnosisId: 'd-cap',
      taskId: 't-cap-fix',
      observedFailure: 'the case never ran: no provider could settle its criterion',
      scope: 'the failed case in this store',
      localizedCause: `the deployment grants no capability for ${ROW}`,
      evidenceRefs: ['e-r-cap-fix-history'],
      reviewRefs: ['t-cap-fix#r-cap-fix-history'],
      confidence: 'high' as const,
      proposals: [{ targetType: 'capability', targetId: ROW, rationale: `the case needs the ${ROW} capability` }],
    }
    await f.h.task.recordDiagnosisIn(f.storeId, diagnosis, 'tester')

    // ── the hand-off: delegated to one supervisor, which is the only caller the
    // recovery entry accepts ──────────────────────────────────────────────────
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', mkdtempSync(join(tmpdir(), 'a6-capability-ledger-')))
    const handoff = await startSupervisorHandoff(f.h.ctx, {
      storeId: f.storeId,
      diagnosis,
      delegator: { sessionId: ROOT, agent: f.h.rootAgent(ROOT) },
      sourceRef: 't-cap-fix#r-cap-fix-history',
      sourceOutcome: 'failed',
    })
    expect(handoff).toMatchObject({ result: 'started' })
    const supervisor = String((handoff as { sessionId: string }).sessionId)
    expect(await readSupervisorHandoff(f.storeId, 'd-cap')).toMatchObject({ sessionId: supervisor, actor: String(ROOT) })

    // ── before the change is in force: refused by name, and no run is opened ──
    const beforeApply = (await f.h.snapshot(f.storeId)).runs.length
    const refused = await f.evolution.coordinateRecovery(
      { sourceDiagnosisId: 'd-cap', requestKey: 'k-cap' },
      { sessionId: supervisor },
    ).then(() => '', error => String(error))
    expect(refused).toContain(RowInForce)
    expect((await f.h.snapshot(f.storeId)).runs).toHaveLength(beforeApply)

    // ── the promotion, for real: the report, the gate, the decision, the apply ─
    const result = await f.evolution.runExperiment({
      proposalId: PROPOSAL,
      samples: [
        { taskId: 't-cap-fix', role: 'observed-failure' },
        { taskId: 't-cap-holdout', role: 'holdout' },
      ],
      snapshot: { sourceDir: f.snapshotDir },
      model: SELECTION,
      budget: { note: 'the fixture budget — no token ceiling, so no side has to report metrics' },
      repetition: 0,
    }, ROOT, ROOT)
    await f.evolution.gate(PROPOSAL, gateAnswers([result.reportPath]), ROOT)
    await f.evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:decide')
    await f.evolution.apply(PROPOSAL, ROOT, 'approval:apply')
    // The applied row is in the deployment's own table *and* in the file a restart
    // loads: the commit persisted one row, left every other byte alone, and kept
    // the second document's key where it was.
    expect(f.h.runtime.listCapabilities()[ROW]).toEqual({ skills: [SKILL], tools: ['filesystem'] })
    const config = await readConfig(f.configFile, 'utf8')
    expect(config).toContain(`"${ROW}": {"skills":["${SKILL}"],"tools":["filesystem"]}`)
    expect(config).toContain(`${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem] }`)
    expect(config).toContain('key: sk-fixture-do-not-print-me')

    // The fixture's own root run has to have settled before an attempt claims the
    // same checkout: the workspace holder is released when a run ends, and this
    // stack's worker hook does not submit for the root the fixture activated.
    await f.h.runtime.submitResult(ROOT, { summary: 'the fixture goal is done' })
    await vi.waitFor(async () => {
      const own = (await f.h.snapshot(f.storeId)).runs.find(run => run.sessionId === String(ROOT))
      expect(own?.status).not.toBe('running')
    }, { timeout: 20_000, interval: 25 })

    // ── the same call now opens the attempt, through the tool the supervisor has ─
    const tool = defineTaskRecoverTool(f.h.ctx)
    const answer = (await tool.execute(
      { sourceDiagnosisId: 'd-cap', requestKey: 'k-cap' },
      { agent: { id: supervisor }, callId: 'call-recover', signal: new AbortController().signal } as never,
    )) as string
    expect(answer).toContain('a new attempt was opened')
    const attempt = (await f.h.snapshot(f.storeId)).runs.find(run => run.recovery !== undefined)
    expect(attempt).toBeDefined()
    expect(attempt!.taskId).toBe('t-cap-fix')
    expect(attempt!.recovery).toMatchObject({ sourceDiagnosisId: 'd-cap', requestKey: 'k-cap', sourceRunId: 'r-cap-fix-history' })
    // The old failure is untouched, and a repeat returns the same attempt.
    expect((await f.h.snapshot(f.storeId)).runs.find(run => run.runId === 'r-cap-fix-history')!.status).toBe('failed')
    const again = (await tool.execute(
      { sourceDiagnosisId: 'd-cap', requestKey: 'k-cap' },
      { agent: { id: supervisor }, callId: 'call-recover-2', signal: new AbortController().signal } as never,
    )) as string
    expect(again).toContain('already named an attempt')
    expect((await f.h.snapshot(f.storeId)).runs.filter(run => run.recovery !== undefined)).toHaveLength(1)
  })
})

/** The two samples every case in this file evaluates, as the experiment's own spec. */
function experimentSpec(f: Fixture) {
  return {
    proposalId: PROPOSAL,
    samples: [
      { taskId: 't-cap-fix', role: 'observed-failure' as const },
      { taskId: 't-cap-holdout', role: 'holdout' as const },
    ],
    snapshot: { sourceDir: f.snapshotDir },
    model: SELECTION,
    budget: { note: 'the fixture budget — no token ceiling, so no side has to report metrics' },
    repetition: 0,
  }
}

/** The ledger's own lines, read from disk (the append-only file, never the service's memory). */
async function ledgerLines(f: Fixture): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(f.h.workspace, 'evolution', 'proposals.jsonl'), 'utf8')
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/**
 * One coordinator's hand-off for a diagnosis of this store, as the consumption
 * writes it: the ledger row the recovery entry reads its caller against.
 */
async function supervisorFor(f: Fixture, diagnosis: Record<string, unknown>): Promise<string> {
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', mkdtempSync(join(tmpdir(), 'a6-composition-ledger-')))
  const handoff = await startSupervisorHandoff(f.h.ctx, {
    storeId: f.storeId,
    diagnosis: diagnosis as never,
    delegator: { sessionId: ROOT, agent: f.h.rootAgent(ROOT) },
    sourceRef: `${diagnosis.taskId}#${String(diagnosis.reviewRefs === undefined ? 'r-cap-fix-history' : (diagnosis.reviewRefs as string[])[0]?.split('#')[1])}`,
    sourceOutcome: 'failed',
  })
  expect(handoff).toMatchObject({ result: 'started' })
  return String((handoff as { sessionId: string }).sessionId)
}

/** The fixture's own root run has to settle before an attempt claims its checkout (§3.4). */
async function releaseFixtureCheckout(f: Fixture): Promise<void> {
  await f.h.runtime.submitResult(ROOT, { summary: 'the fixture goal is done' })
  await vi.waitFor(async () => {
    const own = (await f.h.snapshot(f.storeId)).runs.find(run => run.sessionId === String(ROOT))
    expect(own?.status).not.toBe('running')
  }, { timeout: 20_000, interval: 25 })
}

describe('A6 EVO-2/EVO-3: a row-only capability candidate — one row, no new skill', () => {
  it('is evaluated on the provider the row grants, applied as one row, and recovered into an attempt that loads it', async () => {
    const f = await fixture({ rowOnly: true })
    const prepared = await f.evolution.get(PROPOSAL)
    // What is prepared is the row and nothing else: no new object, no sandbox skill.
    expect(prepared.prepared?.capabilityRow?.name).toBe(ROW)
    expect(prepared.prepared?.skillContent).toBeUndefined()
    expect(prepared.prepared?.files).toEqual([`capability/${ROW}.json`])

    // The evaluation: the production configuration refuses the baseline, and the
    // candidate side really runs — on the *existing* object its row grants, which
    // is what the run's own binding and workspace show.
    const result = await f.evolution.runExperiment(experimentSpec(f), ROOT, ROOT)
    expect(result.report.verdict).toBe('fixed')
    const fix = result.report.samples.find(sample => sample.taskId === 't-cap-fix')!
    expect(fix.baseline.outcome).toBe('not-admitted')
    expect(fix.baseline.admission).toMatchObject({ source: 'capability-gap', required: [ROW], missing: [ROW] })
    expect(fix.candidate.outcome).toBe('verified')
    const candidateRun = (await f.h.snapshot(f.storeId)).runs.find(run => run.runId === fix.candidate.runId)!
    expect(candidateRun.providerBinding?.skills.map(skill => skill.name)).toEqual(['capability-row-only-skill'])
    expect(existsSync(join(String(fix.candidate.workspace), ANSWER))).toBe(true)

    // The promotion: the report, the gate, the person's decision, the apply — one row.
    await f.evolution.gate(PROPOSAL, gateAnswers([result.reportPath]), ROOT)
    await f.evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:decide')
    const applied = await f.evolution.apply(PROPOSAL, ROOT, 'approval:apply')
    expect(applied.targets).toEqual([])
    expect(f.h.runtime.listCapabilities()[ROW]).toEqual({ skills: ['capability-row-only-skill'], tools: ['filesystem'] })
    const config = await readFile(f.configFile, 'utf8')
    expect(config).toContain(`"${ROW}": {"skills":["capability-row-only-skill"],"tools":["filesystem"]}`)
    expect(config).toContain(`${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem] }`)

    // The recovery: the coordinator opens the failed sample's new attempt, and the
    // attempt is admissible only because the row is in force — its worker loads the
    // provider the row grants and passes the original criterion.
    const diagnosis = {
      // The diagnosis the fixture's proposal already names (`sourceRefs`), so the
      // recovery entry associates this hand-off with the applied row.
      diagnosisId: 'd-cap',
      taskId: 't-cap-fix',
      observedFailure: 'the case never ran: no provider could settle its criterion',
      scope: 'the failed case in this store',
      localizedCause: `the deployment grants no capability for ${ROW}`,
      evidenceRefs: ['e-r-cap-fix-history'],
      reviewRefs: ['t-cap-fix#r-cap-fix-history'],
      confidence: 'high' as const,
      proposals: [{ targetType: 'capability', targetId: ROW, rationale: `the case needs the ${ROW} capability` }],
    }
    await f.h.task.recordDiagnosisIn(f.storeId, diagnosis, 'tester')
    const supervisor = await supervisorFor(f, diagnosis as unknown as Record<string, unknown>)
    await releaseFixtureCheckout(f)
    const tool = defineTaskRecoverTool(f.h.ctx)
    const answer = (await tool.execute(
      { sourceDiagnosisId: 'd-cap', requestKey: 'k-row' },
      { agent: { id: supervisor }, callId: 'call-row', signal: new AbortController().signal } as never,
    )) as string
    expect(answer).toContain('a new attempt was opened')
    const attempt = (await f.h.snapshot(f.storeId)).runs.find(run => run.recovery !== undefined)!
    expect(attempt.taskId).toBe('t-cap-fix')
    // This fixture has no model loop, so the spec plays the driver of the
    // attempt's turn: the runtime spawns the worker, and the *turn* is what the
    // loop would run (the worker body writes the file its loaded skill names and
    // the fixture hands the run in).
    await f.h.agent(attempt.sessionId)!.whenIdle!()
    await vi.waitFor(async () => {
      expect((await f.h.snapshot(f.storeId)).runs.find(run => run.runId === attempt.runId)?.status).toBe('verified')
    }, { timeout: 30_000, interval: 25 })
    // The old failure is untouched, and the deployment holds one new row and no new
    // object at all.
    const final = await f.h.snapshot(f.storeId)
    expect(final.runs.find(run => run.runId === 'r-cap-fix-history')?.status).toBe('failed')
    expect(final.runs.filter(run => run.taskId === 't-cap-fix')).toHaveLength(2)
  }, 120_000)
})

describe('A6 EVO-3/EVO-4: a rolled-back capability is not in force for a recovery', () => {
  it('refuses the recovery by name after the rollback, opening no run', async () => {
    const f = await fixture()
    // A promotion that really happened, then the person's rollback: the row and
    // the new object it installed are undone, and the ledger says so.
    const result = await f.evolution.runExperiment(experimentSpec(f), ROOT, ROOT)
    await f.evolution.gate(PROPOSAL, gateAnswers([result.reportPath]), ROOT)
    await f.evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:decide')
    await f.evolution.apply(PROPOSAL, ROOT, 'approval:apply')
    expect(f.h.runtime.listCapabilities()[ROW]).toBeDefined()
    await f.evolution.rollback(PROPOSAL, ROOT, 'approval:rollback')
    expect(f.h.runtime.listCapabilities()[ROW]).toBeUndefined()
    expect(existsSync(join(f.h.workspace, 'evolution', 'sandbox', PROPOSAL, 'skills', SKILL))).toBe(true)

    const diagnosis = {
      // The same diagnosis id the fixture's proposal rests on, so this hand-off is
      // associated with the proposal that was applied and then rolled back.
      diagnosisId: 'd-cap',
      taskId: 't-cap-fix',
      observedFailure: 'the case never ran: no provider could settle its criterion',
      scope: 'the failed case in this store',
      localizedCause: `the deployment grants no capability for ${ROW}`,
      evidenceRefs: ['e-r-cap-fix-history'],
      reviewRefs: ['t-cap-fix#r-cap-fix-history'],
      confidence: 'high' as const,
      proposals: [{ targetType: 'capability', targetId: ROW, rationale: `the case needs the ${ROW} capability` }],
    }
    await f.h.task.recordDiagnosisIn(f.storeId, diagnosis, 'tester')
    const supervisor = await supervisorFor(f, diagnosis as unknown as Record<string, unknown>)
    const runsBefore = (await f.h.snapshot(f.storeId)).runs.length
    const refused = await f.evolution.coordinateRecovery(
      { sourceDiagnosisId: 'd-cap', requestKey: 'k-rolled-back' },
      { sessionId: supervisor },
    ).then(() => '', error => String(error))
    expect(refused).toContain('capability change this hand-off depends on')
    expect(refused).toContain('rolled back')
    expect(refused).toContain('nothing was started')
    expect((await f.h.snapshot(f.storeId)).runs).toHaveLength(runsBefore)
  }, 120_000)
})

describe('A6 EVO-5: the experiment\'s business runs count against the store\'s own ceiling', () => {
  it('refuses the experiment at the ceiling with nothing raised, then runs for the person who raises it', async () => {
    // The ceiling holds exactly the runs the fixture already spent: the root's own
    // run and the two historical samples.
    const f = await fixture({ rootBudget: { maxRuns: 3 } })
    const person = new ScriptedBudgetApproval(true)
    person.install(f.h)
    const before = await f.h.snapshot(f.storeId)
    const eventsBefore = f.h.events(f.storeId).length
    expect(before.runs).toHaveLength(3)
    expect(before.budgetExtensions?.all ?? []).toEqual([])

    const refused = await f.evolution.runExperiment(experimentSpec(f), ROOT, ROOT).then(() => '', error => String(error))
    expect(refused).toContain('the root budget allows 3 run(s)')
    expect(refused).toContain('for root')
    // Zero admission: not a task, not a run, not an event — and no ceiling moved.
    // The experiment asked nobody for a raise either: a ceiling moves only through
    // K4's own human entry, never because a candidate wanted one.
    expect(await f.h.snapshot(f.storeId)).toEqual(before)
    expect(f.h.events(f.storeId)).toHaveLength(eventsBefore)
    expect(person.asks).toEqual([])

    // The person raises it, through the one entry that records an approval.
    const pending = f.h.runtime.extendRootBudget(
      String(ROOT),
      { callId: 'call-raise', execution: { agent: { id: String(ROOT) }, signal: new AbortController().signal } },
      { requestKey: 'k-raise', maxRuns: 5 },
    )
    await vi.waitFor(() => expect(person.asks).toHaveLength(1), { timeout: 20_000, interval: 25 })
    expect(person.asks[0]!.runsUsed).toBe(3)
    person.allow()
    const granted = await pending
    expect(granted.record.maxRuns).toEqual({ previous: 3, next: 5 })
    const raised = await f.h.snapshot(f.storeId)
    expect(raised.budgetExtensions).toBeDefined()

    // The same experiment now runs: the candidate side is the run the ceiling had
    // no room for, and the count it spends is the store's own.
    const result = await f.evolution.runExperiment(experimentSpec(f), ROOT, ROOT)
    expect(result.report.verdict).toBe('fixed')
    expect(result.report.samples.find(sample => sample.taskId === 't-cap-fix')!.candidate.outcome).toBe('verified')
    const after = await f.h.snapshot(f.storeId)
    expect(after.runs).toHaveLength(5)

    // Where the spend is recorded: the ceiling the person granted is the one in
    // force and the experiment appended no extension of its own; the model cost of
    // every side is an evolution-ledger fact.
    expect(after.budgetExtensions).toEqual(raised.budgetExtensions)
    const kinds = f.h.events(f.storeId).map(event => event.kind).filter(kind => kind === 'TaskBudgetExtended')
    expect(kinds).toHaveLength(1)
    const samples = (await ledgerLines(f)).filter(line => line.kind === 'experiment_sample')
    expect(samples).toHaveLength(4)
    for (const sample of samples) {
      const cost = sample.cost as { status: string; reason?: string }
      expect(['reported', 'unknown']).toContain(cost.status)
      if (cost.status === 'unknown') expect(typeof cost.reason).toBe('string')
    }
    expect(samples.filter(sample => sample.side === 'baseline').every(sample => (sample.cost as { status: string }).status === 'unknown')).toBe(true)
  }, 120_000)
})
