/**
 * A6 EVO-2: the **capability row** half of an open commit intent, on the real
 * deployment (plan §F.4 "生产半成品不准入", "第三方变化具名停止").
 *
 * The K2/K3 open-intent gate matches a provider by the *directory* an intent's
 * file set lives in, so a capability commit that moves **one row and no file**
 * (an L1 candidate composing capabilities the store already grants) is invisible
 * to ordinary admission. The durable table is published before the in-process
 * registry, and the row-keyed open-intent gate covers either side of an
 * interrupted publication. This spec pins both protections:
 *
 * 1. **A refused config write leaves no usable row.** A capability apply that
 *    stops at the table-file seam (a third party's bytes landed under it) leaves
 *    no row in the process and preserves the third party's file. The report
 *    refuses the open row by name, and a real batch requiring the absent row is
 *    rejected before a task, a run or evidence exists.
 * 2. **The write's last observation is the one before the rename.** A third
 *    party's write injected at the staged seam (after the drift gate, before the
 *    rename) is refused as `capability-table-changed`: its bytes are what the
 *    file keeps, and no row it would have overwritten becomes usable.
 * 3. **A published row under an open intent stays unusable.** If the row and
 *    file landed but the completion did not, a real batch is rejected by the
 *    open-intent gate before any task, run or evidence exists.
 * 4. **The settled state admits, the rollback removes.** A completed apply has
 *    the row in the registry, in the file, and admissible; the person's rollback
 *    takes it out of all three.
 * 5. **A restart does not clear an open intent.** A second deployment booted over
 *    the same directory — the same table the file holds, a new service instance
 *    over the same ledger — still refuses the row the open intent names; only the
 *    explicit reconciliation settles it, and the row is admitted afterwards.
 *
 * Everything is read back from a durable surface: the ledger file, the
 * deployment's own `config.yml`, the runtime's effective table, and the store.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CapabilityConfig } from '../../task-runtime/src/index.ts'
import { SKILL_SIDECAR_FILE, providerRefusals, serializeSkillSidecar } from '../../task-runtime/src/index.ts'
import type { CapabilityProviderPrecheck, ProviderPrecheck } from '../../task-runtime/src/provider-precheck.ts'
import { EvolutionService, modelSelectionOf } from '../../evolution/src/index.ts'
import type { ProposeInput } from '../../evolution/src/index.ts'
import type { AcceptanceCriterion } from '../../task/src/index.ts'
import { writeCapabilityConfig } from '../support/capability-config.ts'
import { disposeRunStacks, startRunStack, type RunStack } from '../support/run-stack.ts'

const ROOT = 's-root' as SessionId
const PROPOSAL = 'p-row-gate'
/** The row the samples require and the production table does not hold: the gap the candidate closes. */
const ROW = 'a6-gate-row'
/** The deployment's own row, the tool plane that authorizes the candidate's row, and the guidance it grants. */
const STORE_ROW = 'a6-gate-store-row'
const STORE_SKILL = 'a6-gate-guidance'
const STORE_ENTRY: CapabilityConfig = { skills: [STORE_SKILL], tools: ['filesystem'] }
/** The production execution object the candidate's row grants — exactly what a row-only L1 candidate composes. */
const SKILL = 'a6-gate-skill'
/** The file the skill's body tells its worker to write, and the criterion reads. */
const ANSWER = 'gate-answer.txt'
/** The row-only candidate's whole mutation: one row, no file at all. */
const ROW_ENTRY: CapabilityConfig = { skills: [SKILL], tools: ['filesystem'] }

const SELECTION = modelSelectionOf({ provider: 'scripted', model: 'run-stack' })!

const proposal: ProposeInput = {
  proposalId: PROPOSAL,
  targetType: 'capability',
  targetId: ROW,
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the store has no capability that grants the provider this case needs',
  sourceRefs: ['diagnosis:d-row-gate'],
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
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

/** The table file's own write seam, wide enough to name the staged seam this spec injects at. */
type TableProbe = (stage: string, row: string) => void

interface Fixture {
  readonly h: RunStack
  readonly evolution: EvolutionService
  readonly workspace: string
  readonly configFile: string
  /** The root task this image activated; absent on a reuse boot, which starts nothing. */
  readonly root?: { storeId: string; taskId: string; runId: string }
  readonly ledgerLines: () => Promise<Record<string, unknown>[]>
}

/** The two historical samples the frozen experiment compares on both sides. */
const SAMPLES = [
  { taskId: 't-cap-fix', role: 'observed-failure' as const },
  { taskId: 't-cap-holdout', role: 'holdout' as const },
]

/**
 * Boot one deployment image over `workspace`: the real store, runtime and agent
 * plane, a production execution object the candidate's row grants, the
 * deployment's own `config.yml` (whose table a commit writes), and the real
 * `EvolutionService` over `<workspace>/evolution` with the table write's probe.
 * The service registers itself on the stack's context, so the runtime's own
 * admission reads resolve the ledger the commits write.
 *
 * `chain: 'reuse'` boots the image and nothing else: the directory already holds
 * the deployment's files, the ledger and the records a previous image wrote, and
 * a restart must not rewrite any of them (rewriting the table file would be a
 * third party's move of the file the open intent is compared against).
 */
async function boot(
  workspace: string,
  options: { probe?: TableProbe; commitProbe?: (stage: string) => void; chain?: 'fresh' | 'reuse' } = {},
): Promise<Fixture> {
  let h!: RunStack
  h = await startRunStack({
    workspace,
    roots: [ROOT],
    capabilities: { [STORE_ROW]: STORE_ENTRY },
    worker: async (sessionId: SessionId, agent: Agent) => {
      const { task, run } = await h.runtime.runForSession(sessionId)
      // A child works in its parent's checkout; the fixture's own root run is
      // left to the cases, while a replayed sample is the run whose worker has
      // to load the row's provider.
      if (task.parentTaskId !== undefined || (run.parentRunId === undefined && run.recovery === undefined)) return
      const request = h.spawns.find(item => String(item.sessionId) === String(sessionId))
      const roots = [...(request?.grant?.skillRoots ?? []), join(h.home, 'skills')]
      for (const root of roots) {
        const body = await readFile(join(root, SKILL, 'SKILL.md'), 'utf8').catch(() => '')
        if (body.length === 0) continue
        if (!body.includes(`WRITE:${ANSWER}`)) return
        await writeFile(join(agent.session.header.cwd, ANSWER), `${ANSWER}\n`)
        return
      }
    },
  })
  const skillRoot = join(h.home, 'skills')
  const configFile = join(workspace, 'config.yml')
  if (options.chain !== 'reuse') {
    await mkdir(join(skillRoot, STORE_SKILL), { recursive: true })
    await writeFile(join(skillRoot, STORE_SKILL, 'SKILL.md'), `---\nname: ${STORE_SKILL}\ndescription: the deployment's own guidance\n---\n\n# guidance\n`)
    // The object the new row grants: a production execution provider of *both*
    // rows, so the deployment's own row may keep granting it and the candidate
    // row adds a second way to reach the same object.
    const directory = join(skillRoot, SKILL)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${SKILL}\ndescription: the provider the new row grants\n---\n\nWRITE:${ANSWER}\n`)
    await writeFile(join(directory, SKILL_SIDECAR_FILE), serializeSkillSidecar({
      contractVersion: 1,
      type: 'execution',
      capabilities: [STORE_ROW, ROW],
      precondition: 'the case needs the row',
      inputs: [],
      outputs: [],
      requiredTools: ['read', 'write'],
      verifier: { ref: 'command' },
      content: { skillMdSha256: sha256Hex(await readFile(join(directory, 'SKILL.md'), 'utf8')), resources: [] },
    } as never))
    await writeCapabilityConfig(configFile, { [STORE_ROW]: STORE_ENTRY })
  }
  const evolution = new EvolutionService(h.ctx, {
    root: join(workspace, 'evolution'),
    skillRoot,
    modelSelection: () => SELECTION,
    capabilityConfig: configFile,
    ...(options.probe === undefined ? {} : { capabilityConfigProbe: options.probe as never }),
    ...(options.commitProbe === undefined ? {} : { commitProbe: options.commitProbe }),
  })
  if (options.chain === 'reuse') {
    return {
      h,
      evolution,
      workspace,
      configFile,
      ledgerLines: async () => {
        const text = await readFile(join(workspace, 'evolution', 'proposals.jsonl'), 'utf8')
        return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
      },
    }
  }
  const root = await h.root(ROOT, {
    objective: 'gate the capability row', requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'root-goal', description: 'delivered', command: 'true' }],
  })
  const snapshotDir = join(workspace, 'snapshot')
  await mkdir(snapshotDir, { recursive: true })
  await writeFile(join(snapshotDir, 'input.txt'), 'the frozen input\n')
  await writeSample(h, root.storeId, {
    taskId: 't-cap-fix',
    runId: 'r-cap-fix-history',
    objective: `the case needs the ${ROW} capability`,
    acceptance: criterion('ac-cap-fix', `test -f ${ANSWER}`),
    outcome: 'failed',
  })
  await writeSample(h, root.storeId, {
    taskId: 't-cap-holdout',
    runId: 'r-cap-holdout-history',
    objective: 'a held-out case the candidate must not break',
    acceptance: criterion('ac-cap-holdout', `test -f ${ANSWER}`),
    outcome: 'verified',
  })

  await evolution.propose(proposal, ROOT)
  await evolution.candidate(PROPOSAL, { capabilityTable: 'config.yml#doc' }, ROOT, { rows: { [ROW]: ROW_ENTRY } })
  const prepared = await evolution.prepare(PROPOSAL, ROOT)
  expect(prepared.prepared?.skillContent).toBeUndefined()
  // The gate reads a real two-sided experiment: the production configuration
  // refuses the baseline (the row is not in the table), and the candidate side
  // really runs on the provider the row grants.
  const experiment = await evolution.runExperiment({
    proposalId: PROPOSAL,
    samples: SAMPLES,
    snapshot: { sourceDir: snapshotDir },
    model: SELECTION,
    budget: { note: 'the fixture budget — no token ceiling, so no side has to report metrics' },
    repetition: 0,
  }, ROOT, ROOT)
  await evolution.gate(PROPOSAL, {
    targetFailureFixed: 'the fixture case passes on the candidate',
    originalAcceptanceMaintained: 'the acceptance identity is unchanged',
    existingRegressionMaintained: 'the holdout still passes',
    noUnacceptableSideEffects: 'one row',
    holdoutPerformanceAcceptable: 'the held-out case still passes',
    resourceCostAcceptable: 'recorded, not inferred',
    regressionEvidenceRefs: [experiment.reportPath],
  }, ROOT)
  await evolution.decide(PROPOSAL, 'PROMOTE', ROOT, 'approval:decide')
  return {
    h,
    evolution,
    workspace,
    configFile,
    root,
    ledgerLines: async () => {
      const text = await readFile(join(workspace, 'evolution', 'proposals.jsonl'), 'utf8')
      return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
    },
  }
}

/** The row-level refusals one pre-check reported for a row (empty when it reported none). */
function rowRefusals(report: ProviderPrecheck, capability: string): string[] {
  const row: CapabilityProviderPrecheck | undefined = report.capabilities.find(item => item.capability === capability)
  return (row?.refusals ?? []).map(defect => defect.code)
}

/** The refusal message of one call, or `''` when it resolved. */
async function refusalOf(action: Promise<unknown>): Promise<string> {
  try {
    await action
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Whether any `applied` line closed an intent (the completion the commit never wrote). */
async function applied(f: Fixture): Promise<Record<string, unknown>[]> {
  return (await f.ledgerLines()).filter(line => line.kind === 'applied')
}

const dirs: string[] = []

/** One deployment directory, reused by a second boot when a case restarts. */
function workspaceDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'a6-row-gate-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await disposeRunStacks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('A6 EVO-2: a capability row under an open commit intent', () => {
  it('is never admissible after the table write is refused, and no completion is recorded', async () => {
    const workspace = workspaceDirectory()
    let thirdParty = ''
    let rewritten = false
    const f = await boot(workspace, {
      probe: stage => {
        if (stage !== 'before-write' || rewritten) return
        rewritten = true
        writeFileSync(f.configFile, thirdParty, 'utf8')
      },
    })
    // The third party's move lands at the seam the commit's own drift gate reads,
    // so the write is refused rather than carried over.
    const before = await readFile(f.configFile, 'utf8')
    thirdParty = before.replace(
      `      ${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem] }`,
      `      ${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem] }\n      a6-third-party-row: { skills: [${STORE_SKILL}] }`,
    )
    expect(thirdParty).not.toBe(before)

    const refusal = await refusalOf(f.evolution.apply(PROPOSAL, ROOT, 'approval:apply'))
    expect(rewritten).toBe(true)
    expect(refusal).toContain('capability-table-changed')
    // The config-first publication stops before the runtime table moves, and
    // the deployment's file keeps exactly the third party's bytes.
    expect(f.h.runtime.listCapabilities()[ROW]).toBeUndefined()
    expect(await readFile(f.configFile, 'utf8')).toBe(thirdParty)
    expect(await applied(f)).toHaveLength(0)
    expect((await f.evolution.get(PROPOSAL)).openIntent?.intentId).toBe(`${PROPOSAL}/apply`)

    // Ordinary admission does not admit it. The row itself is refused by name —
    // there is no skill to key the refusal on, and no directory: the row is what
    // an open capability intent moves.
    const report = await f.h.runtime.capabilityProviderReport(ROOT, [ROW])
    expect(rowRefusals(report, ROW)).toEqual(['commit-intent-open'])
    expect(providerRefusals(report).join('\n')).toContain(`capability "${ROW}"`)
    expect(providerRefusals(report).join('\n')).toContain('commit-intent-open')

    // …and a real batch that requires the row is rejected before anything is
    // written: no task, no run, no evidence.
    const root = f.root!
    const beforeAdmission = await f.h.snapshot(root.storeId)
    const batchRefusal = await refusalOf(f.h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'the child needs the row',
      children: [{
        objective: `use ${ROW}`,
        acceptanceCriteria: [{ description: `the ${ROW} provider runs`, command: 'true' }],
        requiredCapabilities: [ROW],
      }],
    }))
    expect(batchRefusal).toContain('capability gap')
    expect(batchRefusal).toContain(ROW)
    const afterAdmission = await f.h.snapshot(root.storeId)
    expect(afterAdmission.tasks).toHaveLength(beforeAdmission.tasks.length)
    expect(afterAdmission.runs).toHaveLength(beforeAdmission.runs.length)
    expect(afterAdmission.evidence).toHaveLength(beforeAdmission.evidence.length)
  })

  it('refuses a third party\'s write injected at the staged seam, keeping its bytes and the row unusable', async () => {
    const workspace = workspaceDirectory()
    let thirdParty = ''
    let rewritten = false
    const f = await boot(workspace, {
      probe: stage => {
        if (stage !== 'staged' || rewritten) return
        rewritten = true
        writeFileSync(f.configFile, thirdParty, 'utf8')
      },
    })
    const before = await readFile(f.configFile, 'utf8')
    thirdParty = before.replace(
      `      ${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem] }`,
      `      ${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem] }\n      a6-third-party-row: { skills: [${STORE_SKILL}] }`,
    )
    expect(thirdParty).not.toBe(before)

    const refusal = await refusalOf(f.evolution.apply(PROPOSAL, ROOT, 'approval:apply'))
    expect(rewritten).toBe(true)
    expect(refusal).toContain('capability-table-changed')
    // The verification ran after the seam and immediately before the rename: the
    // file keeps the third party's bytes exactly, and the runtime row has not
    // been installed.
    expect(await readFile(f.configFile, 'utf8')).toBe(thirdParty)
    expect(f.h.runtime.listCapabilities()[ROW]).toBeUndefined()
    expect(await applied(f)).toHaveLength(0)
    expect((await f.evolution.get(PROPOSAL)).openIntent?.intentId).toBe(`${PROPOSAL}/apply`)
    expect(rowRefusals(await f.h.runtime.capabilityProviderReport(ROOT, [ROW]), ROW)).toEqual(['commit-intent-open'])
  })

  it('refuses a published row before its completion is recorded, without admitting a batch', async () => {
    const f = await boot(workspaceDirectory(), {
      commitProbe: stage => {
        if (stage === 'commit-verified') throw new Error('fixture: the process died before the completion was recorded')
      },
    })
    expect(await refusalOf(f.evolution.apply(PROPOSAL, ROOT, 'approval:apply'))).toContain('fixture: the process died')
    expect(f.h.runtime.listCapabilities()[ROW]).toEqual(ROW_ENTRY)
    expect(await readFile(f.configFile, 'utf8')).toContain(`"${ROW}": {"skills":["${SKILL}"],"tools":["filesystem"]}`)
    expect(await applied(f)).toHaveLength(0)
    expect((await f.evolution.get(PROPOSAL)).openIntent?.intentId).toBe(`${PROPOSAL}/apply`)
    expect(rowRefusals(await f.h.runtime.capabilityProviderReport(ROOT, [ROW]), ROW)).toEqual(['commit-intent-open'])

    const root = f.root!
    const before = await f.h.snapshot(root.storeId)
    const refusal = await refusalOf(f.h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, ROOT, {
      reason: 'the child needs the published row',
      children: [{
        objective: `use ${ROW}`,
        acceptanceCriteria: [{ description: `the ${ROW} provider runs`, command: 'true' }],
        requiredCapabilities: [ROW],
      }],
    }))
    expect(refusal).toContain('commit-intent-open')
    expect(refusal).toContain(`capability "${ROW}"`)
    const after = await f.h.snapshot(root.storeId)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.runs).toHaveLength(before.runs.length)
    expect(after.evidence).toHaveLength(before.evidence.length)
  })

  it('admits the row after the settled apply, and takes it out of table and file on the rollback', async () => {
    const f = await boot(workspaceDirectory())
    const baseline = await readFile(f.configFile, 'utf8')
    const outcome = await f.evolution.apply(PROPOSAL, ROOT, 'approval:apply')
    expect(outcome.targets).toEqual([])
    expect(f.h.runtime.listCapabilities()[ROW]).toEqual(ROW_ENTRY)
    expect(await applied(f)).toHaveLength(1)
    const appliedFile = await readFile(f.configFile, 'utf8')
    expect(appliedFile).toContain(`"${ROW}": {"skills":["${SKILL}"],"tools":["filesystem"]}`)
    expect(appliedFile).toContain(`${STORE_ROW}: { skills: [${STORE_SKILL}], tools: [filesystem] }`)

    // The settled row is the one admission resolves: no row-level refusal, and
    // the provider the row grants is the execution object it names.
    const report = await f.h.runtime.capabilityProviderReport(ROOT, [ROW])
    expect(rowRefusals(report, ROW)).toEqual([])
    expect(providerRefusals(report)).toEqual([])

    // The person's rollback takes the row out of the registry and out of the
    // file, and the deployment is left exactly as the baseline described it.
    const rolled = await f.evolution.rollback(PROPOSAL, ROOT, 'approval:rollback')
    expect(rolled.targets).toEqual([])
    expect(f.h.runtime.listCapabilities()[ROW]).toBeUndefined()
    // This candidate added the row, so its rollback removes the very line the
    // apply wrote: the file the deployment had is the file it has again.
    const rolledFile = await readFile(f.configFile, 'utf8')
    expect(rolledFile).not.toContain(`"${ROW}"`)
    expect(rolledFile).toBe(baseline)

    // The intent is settled and nothing grants the row any more: admission
    // identifies an unknown capability rather than an open commit.
    expect((await f.evolution.get(PROPOSAL)).openIntent).toBeUndefined()
    const afterRollback = await f.h.runtime.capabilityProviderReport(ROOT, [ROW])
    expect(rowRefusals(afterRollback, ROW)).toEqual(['capability-unknown'])
    expect(afterRollback.capabilities.flatMap(row => row.skills)).toEqual([])
  })

  it('still refuses the row after a restart, and admits it once the reconciliation settles the intent', async () => {
    const workspace = workspaceDirectory()
    let stopped = false
    const f = await boot(workspace, {
      probe: stage => {
        if (stage !== 'before-write' || stopped) return
        stopped = true
        throw new Error('fixture: the process died before the table file was written')
      },
    })
    const baseline = await readFile(f.configFile, 'utf8')
    expect(await refusalOf(f.evolution.apply(PROPOSAL, ROOT, 'approval:apply'))).toContain('fixture: the process died')
    expect(f.h.runtime.listCapabilities()[ROW]).toBeUndefined()
    expect(await readFile(f.configFile, 'utf8')).toBe(baseline)
    expect(await applied(f)).toHaveLength(0)

    // The restart: the first image is gone (its descriptors with it) and a second
    // one boots over the same directory. Its table is the one the file holds —
    // which does not carry the row — and the ledger still holds the open intent.
    await disposeRunStacks()
    const restarted = await boot(workspace, { chain: 'reuse' })
    expect(restarted.h.runtime.listCapabilities()[ROW]).toBeUndefined()
    expect(rowRefusals(await restarted.h.runtime.capabilityProviderReport(ROOT, [ROW]), ROW)).toEqual(['commit-intent-open'])
    expect((await restarted.evolution.get(PROPOSAL)).openIntent?.intentId).toBe(`${PROPOSAL}/apply`)

    // Only the explicit reconciliation settles it — and then the row is in the
    // registry, in the file and admissible.
    const outcomes = await restarted.evolution.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]!.result, outcomes[0]!.detail ?? '').toBe('completed-redone')
    expect(restarted.h.runtime.listCapabilities()[ROW]).toEqual(ROW_ENTRY)
    expect(await readFile(restarted.configFile, 'utf8')).toContain(`"${ROW}": {"skills":["${SKILL}"],"tools":["filesystem"]}`)
    expect(rowRefusals(await restarted.h.runtime.capabilityProviderReport(ROOT, [ROW]), ROW)).toEqual([])
    const report = await restarted.h.runtime.capabilityProviderReport(ROOT, [ROW])
    expect(providerRefusals(report)).toEqual([])
    expect(report.capabilities.find(row => row.capability === ROW)!.skills.map(skill => (skill.valid ? skill.role : 'invalid'))).toEqual(['execution-provider'])
    expect(existsSync(join(workspace, 'evolution', 'sandbox', PROPOSAL, 'capability', `${ROW}.json`))).toBe(true)
  })
})
