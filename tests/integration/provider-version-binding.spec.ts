import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolutionService } from '../../agent-singularity/src/evolution.ts'
import { defineEvolutionApplyTool } from '../../agent-singularity/src/tools/evolution-apply.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { canonicalize } from '../../task/src/contract.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { TaskEvent, TaskInstance } from '../../task/src/index.ts'
import type { CapabilityConfig, DecomposeSpec } from '../../task-runtime/src/index.ts'
import { disposeRunStacks, skillText, startRunStack, writeGuidanceSkill, type RunStack } from '../support/run-stack.ts'

/**
 * S1-C item 4 across the whole stack, with a real write to production in the
 * middle: a run is admitted and loads its bound bytes, `evolution_apply` writes a
 * new version of the same skill into the single skill root both discovery and the
 * evolution ledger read, and then three readers have to agree.
 *
 * What is real: the store and reducer, the runtime's admission, pre-check, run
 * binding and snapshot materialization, the real `AgentRuntime.spawn` with the
 * real skill layer, the real `EvolutionService` ledger (propose → candidate →
 * prepare → gate → decide → apply, with the real `evolution_apply` tool writing
 * production and mirroring a capability row into the running table), and the real
 * filesystem. What is scripted, and why: the replay report — a real replay needs
 * a model-free re-execution of the champion, and the executed-report fixture is
 * the shape `evolution_replay` records (the same shortcut
 * `provider-promotion.spec.ts` takes); and the model loop, replaced by the agent
 * factory's `setup` the way the other binding specs do.
 *
 * Why the apply is pointed at `<home>/skills`: that directory is one of the roots
 * the worker's own discovery walks (`skillRootsFor`), which is where a deployment
 * keeps its shared skills — so "the new version is in production" and "the next
 * admission discovers it" are the same fact instead of two fixtures agreeing by
 * construction.
 *
 * Everything asserted is read back from a durable surface: the store's own run
 * object and events, the bytes on disk, or the registration the worker's own skill
 * layer resolves.
 */

const ROW = 'design-ball'
/** A fixture name no deployment installs, so the machine running the suite cannot decide a verdict here. */
const SKILL = 's1c-binding-fixture-skill'
const ROOT_A = 's-root-a' as SessionId
const ROOT_B = 's-root-b' as SessionId
const V1 = 'VERSION ONE BODY'
const V2 = 'VERSION TWO BODY'

const CONFIG_FIXTURE = [
  '- id: task-runtime',
  '  config:',
  '    capabilities:',
  '      research: { preset: standard }',
  '',
  '---',
  'api:',
  '  upstream: https://example.invalid',
  '',
].join('\n')

afterEach(async () => {
  await disposeRunStacks()
})

/** The evolution ledger of one test, pointed at the skill root discovery also reads. */
function evolutionOf(h: RunStack): EvolutionService {
  return new EvolutionService(h.ctx, {
    root: join(h.workspace, 'evolution'),
    skillRoot: join(h.home, 'skills'),
    presetRoot: join(h.workspace, 'production-presets'),
    configFile: join(h.workspace, 'config.yml'),
  })
}

function child(objective: string, requiredCapabilities: readonly string[]): DecomposeSpec['children'][number] {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    requiredCapabilities: requiredCapabilities as string[],
  }
}

/** Admit one child under a root session and return the runs that settled. */
async function runOne(h: RunStack, sessionId: SessionId = ROOT_A, capability = ROW): Promise<{ storeId: string; taskId: string; runId: string }> {
  const root = await h.root(sessionId)
  const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, sessionId, {
    reason: 'split the work',
    children: [child('align the ball', [capability])],
  })
  const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  return { storeId: root.storeId, taskId: outcomes[0]!.taskId, runId: outcomes[0]!.runId! }
}

/** The body the worker's own skill layer holds for one skill, as the registry serves it. */
async function registeredSkill(h: RunStack, agent: Agent, name: string): Promise<{ content: string; path?: string }> {
  const skill = await h.ctx.skills.get(name, { scope: agent, cwd: h.checkout })
  if (skill === undefined) throw new Error(`the worker's skill layer holds no "${name}"`)
  return skill as { content: string; path?: string }
}

/** The one executed-report shape the replay entry accepts; this file is about the version move, not about running a replay. */
function replayReport(proposalId: string, targetType: 'capability' | 'skill', candidateContent?: { name: string; sha256: string }): unknown {
  const side = (taskId: string) => ({ taskId, runId: `r-${taskId}`, outcome: 'verified', criteria: [{ criterionId: 'ac1', verdict: 'pass' }] })
  return {
    formatVersion: 1,
    proposalId,
    targetType,
    at: new Date().toISOString(),
    mode: 'executed',
    observed: [{
      taskId: 't-champ',
      candidateTaskId: 't-candidate',
      champion: side('t-champ'),
      candidate: side('t-candidate'),
      verdictMatch: true,
      criteriaDiff: [],
      relation: 'not-worse',
    }],
    holdout: {
      executed: true,
      tasks: [{
        taskId: 't-holdout',
        candidateTaskId: 't-holdout-candidate',
        champion: side('t-holdout'),
        candidate: side('t-holdout-candidate'),
        verdictMatch: true,
        criteriaDiff: [],
        relation: 'not-worse',
      }],
    },
    verdict: 'not-worse',
    ...(targetType === 'skill' && candidateContent !== undefined ? { candidateContent } : {}),
  }
}

function gateAnswers(refs: string[]) {
  return {
    targetFailureFixed: 'the fixture now passes',
    originalAcceptanceMaintained: 'original criteria unchanged and green',
    existingRegressionMaintained: 'full suite replayed green',
    noUnacceptableSideEffects: 'one file changes',
    holdoutPerformanceAcceptable: 'held-out fixtures pass',
    resourceCostAcceptable: 'same runtime as baseline',
    regressionEvidenceRefs: refs,
  }
}

function exec(agent: Agent, callId: string) {
  return { agent, callId, signal: new AbortController().signal } as never
}

/**
 * Walk one skill candidate for `name` from `proposed` to `applied` through the real
 * service entries, then apply it with the real tool — the one entry that also
 * mirrors a capability row into the running table.
 */
async function applySkillVersion(h: RunStack, name: string, content: string, proposalId = 'p-skill-1'): Promise<string> {
  const svc = evolutionOf(h)
  await svc.propose({
    proposalId,
    targetType: 'skill',
    targetId: name,
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the skill should carry the newer wording',
    sourceRefs: ['diagnosis:d1'],
  }, ROOT_A)
  await svc.candidate(proposalId, { skill: 'v2' }, ROOT_A, { name, content })
  await svc.prepare(proposalId, ROOT_A)
  const identity = (await svc.get(proposalId)).prepared!.skillContent!
  await svc.replay(proposalId, ROOT_A, replayReport(proposalId, 'skill', identity))
  await svc.gate(proposalId, gateAnswers([`sandbox/${proposalId}/replay-report.json`]), ROOT_A)
  await svc.decide(proposalId, 'PROMOTE', ROOT_A, 'approval:decide')
  const applied = (await defineEvolutionApplyTool(h.ctx).execute({ proposalId }, exec(h.rootAgent(ROOT_A), 'call-apply'))) as string
  expect(applied).toContain('[applied]')
  return applied
}

describe('a new version in production and the runs that are already bound (S1-C)', () => {
  it('leaves the in-flight run on v1, binds v2 to a new run, and serves the old run from its own snapshot', async () => {
    const config: Record<string, CapabilityConfig> = { [ROW]: { skills: [SKILL], tools: ['filesystem'] } }
    const h = await startRunStack({ capabilities: config, roots: [ROOT_A, ROOT_B], tools: true })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V1)

    const first = await runOne(h, ROOT_A)
    const firstRun = await h.task.runIn(first.storeId, first.runId)
    const firstBinding = firstRun.providerBinding!
    expect(firstBinding.skills.map(skill => skill.name)).toEqual([SKILL])
    expect(firstBinding.skills[0]!.role).toBe('guidance')
    const firstWorker = h.agent(firstRun.sessionId as SessionId)!
    expect((await registeredSkill(h, firstWorker, SKILL)).content).toContain(V1)
    expect((await registeredSkill(h, firstWorker, SKILL)).path!.startsWith(firstBinding.snapshotRoot!)).toBe(true)
    expect((await h.runtime.readRunBinding(firstBinding))?.defects).toEqual([])

    // The new version goes to production through the real apply, in the one skill
    // root discovery also reads.
    await applySkillVersion(h, SKILL, skillText(V2, SKILL))
    expect(await readFile(join(h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(skillText(V2, SKILL))

    // The in-flight run keeps what it loaded: the record, the snapshot bytes and
    // the worker's own layer all still say v1.
    const stillBound = await h.task.runIn(first.storeId, first.runId)
    expect(stillBound.providerBinding).toEqual(firstBinding)
    expect((await registeredSkill(h, firstWorker, SKILL)).content).toContain(V1)
    expect(await readFile(join(firstBinding.snapshotRoot!, SKILL, 'SKILL.md'), 'utf8')).toContain(V1)
    expect((await h.runtime.readRunBinding(firstBinding))?.defects).toEqual([])

    // A run admitted afterwards binds the new bytes: a version change is a new run,
    // never a hot swap of the old one.
    const second = await runOne(h, ROOT_B)
    const secondBinding = (await h.task.runIn(second.storeId, second.runId)).providerBinding!
    expect(secondBinding.skills[0]!.contentDigest).not.toBe(firstBinding.skills[0]!.contentDigest)
    expect(secondBinding.snapshotRoot).not.toBe(firstBinding.snapshotRoot)
    const secondWorker = h.agent((await h.task.runIn(second.storeId, second.runId)).sessionId as SessionId)!
    expect((await registeredSkill(h, secondWorker, SKILL)).content).toContain(V2)
    expect((await h.runtime.readRunBinding(secondBinding))?.defects).toEqual([])
  })

  it('does not hot-swap a worker that is still running when the new version lands', async () => {
    const config: Record<string, CapabilityConfig> = { [ROW]: { skills: [SKILL], tools: ['filesystem'] } }
    let h!: RunStack
    /** What the running worker's own skill layer held at the moment production moved. */
    let heldWhileRunning: string | undefined
    let productionWhileRunning: string | undefined
    let applied = false
    h = await startRunStack({
      capabilities: config,
      roots: [ROOT_A, ROOT_B],
      tools: true,
      worker: async (_sessionId: SessionId, agent: Agent) => {
        if (applied) return
        applied = true
        // The new version lands in the middle of this worker's run — the case the
        // plan's "apply does not hot-swap an in-flight run" is about.
        await applySkillVersion(h, SKILL, skillText(V2, SKILL))
        heldWhileRunning = (await registeredSkill(h, agent, SKILL)).content
        productionWhileRunning = await readFile(join(h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')
      },
    })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V1)

    const first = await runOne(h, ROOT_A)
    const firstRun = await h.task.runIn(first.storeId, first.runId)
    const binding = firstRun.providerBinding!

    // At that moment: production already held v2, and the worker was still on v1.
    expect(productionWhileRunning).toBe(skillText(V2, SKILL))
    expect(heldWhileRunning).toContain(V1)
    expect(heldWhileRunning).not.toContain(V2)

    // The run still settled through the real verifier against its own binding, and
    // after the fact every view of it still describes v1.
    expect(firstRun.status).toBe('verified')
    expect((await h.task.runIn(first.storeId, first.runId)).providerBinding).toEqual(binding)
    expect(await readFile(join(binding.snapshotRoot!, SKILL, 'SKILL.md'), 'utf8')).toContain(V1)
    expect((await h.runtime.readRunBinding(binding))?.defects).toEqual([])
    const worker = h.agent(firstRun.sessionId as SessionId)!
    expect((await registeredSkill(h, worker, SKILL)).content).toContain(V1)
    // …while a run admitted after the apply loads v2, because that is what it was
    // admitted against.
    const second = await runOne(h, ROOT_B)
    const secondBinding = (await h.task.runIn(second.storeId, second.runId)).providerBinding!
    expect(secondBinding.skills[0]!.contentDigest).not.toBe(binding.skills[0]!.contentDigest)
    expect((await registeredSkill(h, h.agent((await h.task.runIn(second.storeId, second.runId)).sessionId as SessionId)!, SKILL)).content).toContain(V2)
  })

  it('refuses an old run whose snapshot was edited or removed by name, and never falls back to production', async () => {
    const config: Record<string, CapabilityConfig> = { [ROW]: { skills: [SKILL], tools: ['filesystem'] } }
    const h = await startRunStack({ capabilities: config, roots: [ROOT_A, ROOT_B], tools: true })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V1)

    const first = await runOne(h, ROOT_A)
    const firstRun = await h.task.runIn(first.storeId, first.runId)
    const binding = firstRun.providerBinding!
    const worker = h.agent(firstRun.sessionId as SessionId)!
    await applySkillVersion(h, SKILL, skillText(V2, SKILL))

    // Read back while the record still resolves: v1, located in its own snapshot.
    const located = await h.runtime.readRunBinding(binding)
    expect(located?.defects).toEqual([])
    expect(located!.skills[0]!.readable).toBe(true)

    // The same summary the contract block and the spawn prompt render, read through
    // the real `task_read` the worker would call.
    const before = await h.call(worker, 'task_read', {})
    expect(before.isError).toBe(false)
    expect(before.text).toContain(`capability \`${ROW}\` → skill \`${SKILL}\` [guidance]`)
    expect(before.text).toContain(`content ${binding.skills[0]!.contentDigest.slice(0, 12)}`)
    expect(before.text).toContain('registry revision:')

    // A rewritten snapshot is reported by name and the production path is named as
    // no substitute — the run is not silently served the version that landed after it.
    const snapshotSkill = join(binding.snapshotRoot!, SKILL, 'SKILL.md')
    await writeFile(snapshotSkill, skillText('TAMPERED BODY', SKILL))
    const edited = await h.runtime.readRunBinding(binding)
    expect(edited!.skills[0]!.readable).toBe(false)
    expect(edited!.defects.join('\n')).toContain(SKILL)
    expect(edited!.defects.join('\n')).toContain('content-mismatch')
    const afterEdit = await h.call(worker, 'task_read', {})
    expect(afterEdit.text).toContain('Bound content is not readable')
    expect(afterEdit.text).toContain('content-mismatch')
    expect(afterEdit.text).toContain(snapshotSkill)
    // The record's own identity is still v1: the view never re-renders production's.
    expect(afterEdit.text).toContain(`content ${binding.skills[0]!.contentDigest.slice(0, 12)}`)

    // Removed is the same refusal, naming the path that is gone.
    await rm(binding.snapshotRoot!, { recursive: true, force: true })
    const missing = await h.runtime.readRunBinding(binding)
    expect(missing!.skills[0]!.readable).toBe(false)
    expect(missing!.defects.join('\n')).toContain(binding.snapshotRoot!)
    const afterRemoval = await h.call(worker, 'task_read', {})
    expect(afterRemoval.text).toContain(binding.snapshotRoot!)
    expect(afterRemoval.text).toContain('Bound content is not readable')

    // The record itself is never rewritten by a failed re-read: the store still
    // holds the run that names v1, and the refusal is about that record.
    expect((await h.task.runIn(first.storeId, first.runId)).providerBinding).toEqual(binding)
    expect(h.runtime.readRunBinding(binding)).toBeDefined()

    // A run admitted now binds v2 — the deployment moved on, and that is exactly
    // what the old run must not be served instead of its own bytes.
    const second = await runOne(h, ROOT_B)
    const secondBinding = (await h.task.runIn(second.storeId, second.runId)).providerBinding!
    expect(secondBinding.skills[0]!.contentDigest).not.toBe(binding.skills[0]!.contentDigest)
    expect((await h.runtime.readRunBinding(secondBinding))?.defects).toEqual([])
    // The refusal did not touch production either: v2 stands where the apply put it.
    expect(await readFile(join(h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(skillText(V2, SKILL))

    // A live worker keeps what it loaded, whatever the snapshot's fate.
    expect((await registeredSkill(h, worker, SKILL)).content).toContain(V1)
  })

  it('leaves the accepted task contract untouched when the capability row that carried it is replaced', async () => {
    const narrow: Record<string, CapabilityConfig> = { [ROW]: { skills: [SKILL], tools: ['filesystem'] } }
    const h = await startRunStack({ capabilities: narrow, roots: [ROOT_A, ROOT_B], tools: true })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V1)
    await writeFile(join(h.workspace, 'config.yml'), CONFIG_FIXTURE, 'utf8')

    const first = await runOne(h, ROOT_A)
    const beforeTask = await h.task.taskIn(first.storeId, first.taskId)
    const beforeRun = await h.task.runIn(first.storeId, first.runId)
    const firstRevision = beforeRun.providerBinding!.registryRevision
    const beforeContract = canonicalize({
      objective: beforeTask.objective,
      acceptanceCriteria: beforeTask.acceptanceCriteria,
      requestedCapabilities: beforeTask.requestedCapabilities,
      contract: beforeTask.contract,
      decompositionStatus: beforeTask.decompositionStatus,
    })
    const beforeManifest = h.events(first.storeId)
      .find((event): event is Extract<TaskEvent, { kind: 'CapabilityResolved' }> => event.kind === 'CapabilityResolved' && event.taskId === first.taskId)!
    expect(beforeManifest.payload.manifest.capabilities[ROW]!.tools).not.toContain('bash')

    // The legal replacement row: same skill, a wider tool plane.
    const svc = evolutionOf(h)
    const row: CapabilityConfig = { skills: [SKILL], tools: ['filesystem', 'bash'] }
    await svc.propose({
      proposalId: 'p-row-1',
      targetType: 'capability',
      targetId: ROW,
      baseVersion: 'v1',
      level: 'L2',
      rationale: 'the row should grant the shell its skill needs',
      sourceRefs: ['diagnosis:d1'],
    }, ROOT_A)
    await svc.candidate('p-row-1', { capabilityTable: 'config.yml#doc1' }, ROOT_A, { name: ROW, entry: row })
    await svc.prepare('p-row-1', ROOT_A, { capabilityEntry: h.runtime.listCapabilities()[ROW] ?? null })
    await svc.replay('p-row-1', ROOT_A, replayReport('p-row-1', 'capability'))
    await svc.gate('p-row-1', gateAnswers(['sandbox/p-row-1/replay-report.json']), ROOT_A)
    await svc.decide('p-row-1', 'PROMOTE', ROOT_A, 'approval:decide')
    const applied = (await defineEvolutionApplyTool(h.ctx).execute({ proposalId: 'p-row-1' }, exec(h.rootAgent(ROOT_A), 'call-row-apply'))) as string
    expect(applied).toContain('[applied]')
    expect(applied).toContain('runtime registry row replaced')

    // The row moved in config.yml and in the running table…
    expect(await readFile(join(h.workspace, 'config.yml'), 'utf8')).toContain(`      ${ROW}: { skills: [${SKILL}], tools: [filesystem, bash] }\n`)
    expect(h.runtime.listCapabilities()[ROW]).toEqual(row)

    // …and the accepted task's contract and acceptance criteria are the very same
    // fields, with the projections still agreeing with the contract (the relation
    // the store's own `assertContract` enforces on every write).
    const afterTask = await h.task.taskIn(first.storeId, first.taskId)
    expect(canonicalize({
      objective: afterTask.objective,
      acceptanceCriteria: afterTask.acceptanceCriteria,
      requestedCapabilities: afterTask.requestedCapabilities,
      contract: afterTask.contract,
      decompositionStatus: afterTask.decompositionStatus,
    })).toBe(beforeContract)
    expect(afterTask.objective).toBe(afterTask.contract!.objective)
    expect(canonicalize(afterTask.acceptanceCriteria)).toBe(canonicalize(afterTask.contract!.acceptanceCriteria))
    expect(canonicalize(afterTask.requestedCapabilities)).toBe(canonicalize(afterTask.contract!.requiredCapabilities))

    // The old run's binding is untouched by the row replacement, and still readable.
    expect((await h.task.runIn(first.storeId, first.runId)).providerBinding).toEqual(beforeRun.providerBinding)
    expect((await h.runtime.readRunBinding(beforeRun.providerBinding!))?.defects).toEqual([])
    // The old task's manifest stays what it was admitted with: the row did not
    // rewrite an accepted task's record of what it was granted.
    const afterManifest = h.events(first.storeId)
      .find((event): event is Extract<TaskEvent, { kind: 'CapabilityResolved' }> => event.kind === 'CapabilityResolved' && event.taskId === first.taskId)!
    expect(afterManifest).toEqual(beforeManifest)

    // A new decomposition resolves against the new row — same skill, wider plane,
    // a different registry revision.
    const second = await runOne(h, ROOT_B)
    const secondRun = await h.task.runIn(second.storeId, second.runId)
    const secondManifest = h.events(second.storeId)
      .find((event): event is Extract<TaskEvent, { kind: 'CapabilityResolved' }> => event.kind === 'CapabilityResolved' && event.taskId === second.taskId)!
    expect(secondManifest.payload.manifest.capabilities[ROW]!.tools).toContain('bash')
    expect(secondRun.providerBinding!.registryRevision).not.toBe(firstRevision)
    // The provider's identity did not move with the row: the same bytes are bound.
    expect(secondRun.providerBinding!.skills[0]!.contentDigest).toBe(beforeRun.providerBinding!.skills[0]!.contentDigest)
  })

  it('refuses to re-enter a run whose bound content is gone rather than adopt the version production holds now', async () => {
    const config: Record<string, CapabilityConfig> = { [ROW]: { skills: [SKILL], tools: ['filesystem'] } }
    const h = await startRunStack({ capabilities: config, roots: [ROOT_A], tools: true })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V1)
    const storeId = rootTaskStoreId(ROOT_A)
    // The state a restart finds: one admitted root task with a run bound to this
    // session whose snapshot is not on disk any more.
    const snapshotRoot = join(h.home, 'singularity', 'run-bindings', storeId, 'r-gone', 'skills')
    await h.task.createStore(storeId)
    const rootTaskId = 't-root-seeded'
    const rootTask: TaskInstance = {
      taskId: rootTaskId,
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'ship the release',
      depth: 0,
      acceptanceCriteria: [{ criterionId: 'root-children-verified', description: 'all mandatory children verified', verificationMode: 'composite', requiredEvidence: [], mandatory: true }],
      requestedCapabilities: [],
      decompositionStatus: 'decomposable',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }
    await h.task.createTaskIn(storeId, rootTask, ROOT_A)
    await h.task.admitTaskIn(storeId, rootTaskId, ROOT_A, { decompositionStatus: 'decomposable' })
    await h.task.startRunIn(storeId, {
      runId: 'r-gone',
      taskId: rootTaskId,
      sessionId: ROOT_A,
      capabilitySnapshot: [SKILL],
      providerBinding: {
        registryRevision: 'a'.repeat(64),
        capabilities: [ROW],
        skills: [{
          name: SKILL,
          role: 'guidance',
          capabilities: [ROW],
          description: 'a skill the deployment used to hold',
          contractDigest: null,
          contentDigest: 'b'.repeat(64),
          uncovered: [],
        }],
        mcpServers: [],
        snapshotRoot,
      },
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, ROOT_A)
    const recorded = (await h.task.runIn(storeId, 'r-gone')).providerBinding
    const eventsBefore = h.events(storeId)

    // Production moves on through the real apply: v2 stands at the skill root.
    await applySkillVersion(h, SKILL, skillText(V2, SKILL), 'p-skill-reentry')
    expect(await readFile(join(h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(skillText(V2, SKILL))

    // Re-entry refuses, naming the skill and the path the record points at…
    await expect(h.runtime.createRootTask(storeId, { objective: 'ship the release', rootSessionId: ROOT_A }, ROOT_A))
      .rejects.toThrow(new RegExp(SKILL))
    await expect(h.runtime.createRootTask(storeId, { objective: 'ship the release', rootSessionId: ROOT_A }, ROOT_A))
      .rejects.toThrow(new RegExp(snapshotRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    // …and nothing moved: the run still names its own content, no event was
    // appended, and production still holds v2 rather than being rewritten back.
    expect((await h.task.runIn(storeId, 'r-gone')).providerBinding).toEqual(recorded)
    expect(h.events(storeId)).toEqual(eventsBefore)
    expect(await readFile(join(h.home, 'skills', SKILL, 'SKILL.md'), 'utf8')).toBe(skillText(V2, SKILL))
    expect(h.spawns).toHaveLength(0)
  })
})
