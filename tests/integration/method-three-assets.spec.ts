/**
 * The three asset kinds the method chain evolves, each proved against the
 * runtime's own records rather than the pipeline's say-so:
 *
 * - a first Skill is measured only when the candidate side's sealed receipt
 *   shows the skill granted AND loaded by the run that claims it;
 * - a capability the active revision cannot admit is measured by the runtime's
 *   own admission refusal — the baseline side never spawns, the candidate side
 *   really runs under the candidate revision's row, and the non-compensatory
 *   guard refuses the evaluation rather than reading a refusal as a verdict;
 * - a task template is measured only when the candidate side really
 *   instantiated it — an observed `task_decompose` naming the pinned template,
 *   with real children — while the parent's own acceptance stayed judged by the
 *   frozen verifiers, not by the candidate.
 *
 * Everything except the model is the deployment's own: the real DSH loop with a
 * scripted provider, the real `TaskRuntime` (its environment library, drafts
 * and pointer on a real disk, real child spawns for the template batch), the
 * real task store, and the real method ledger.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { taskTemplateDigest } from '../../task/src/index.ts'
import { libraryRoots } from '../../task-runtime/src/environment/index.ts'
import { parseTaskTemplate } from '../../task-runtime/src/index.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'
import {
  ROOT,
  SUPERVISOR,
  SKILL_MD,
  criterion,
  draftIdOf,
  lastCall,
  ledgerRecords,
  reportPathOf,
  settledCalls,
  startMethodChain,
  waitForCalls,
} from './method-chain.fixture.ts'

afterEach(async () => {
  await disposeScriptedLoops()
})

/** The `method_evaluate` entry every scenario's supervisor runs, over the root's settled task. */
function evaluateEntry(h: () => ScriptedLoop, root: () => { taskId: string }, inputDir: () => string): ScriptEntry {
  return {
    tool: 'method_evaluate',
    args: () => ({
      draftId: draftIdOf(h()),
      round: 0,
      samples: [{ taskId: root().taskId, role: 'observed-success' }],
      quality: { metricId: 'acceptance', extractor: 'acceptance' },
      repetition: 0,
      input: { sourceDir: inputDir() },
      maxParallel: 1,
    }),
  }
}

const publishEntry = (h: () => ScriptedLoop): ScriptEntry => ({
  tool: 'method_publish',
  args: () => ({ draftId: draftIdOf(h()), expectedActiveRevision: 'r0001', expectedGeneration: 1 }),
})

/** One loop wired for a method chain over a root task begun with the given contract. */
async function startChain(
  requiredCapabilities: readonly string[],
  supervisorDraft: ScriptEntry,
  workerScript: (h: ScriptedLoop, sessionId: string, replayOrder: number) => readonly ScriptEntry[],
): Promise<{ h: ScriptedLoop; root: { storeId: string; taskId: string; runId: string } }> {
  let h!: ScriptedLoop
  let root!: { storeId: string; taskId: string; runId: string }
  let inputDir!: string
  h = await startScriptedLoop({
    evolution: { ledgerRoot: mkdtempSync(join(tmpdir(), 'method-assets-')) },
    supervisors: [SUPERVISOR],
    approvalAnswer: () => 'allowed-once',
    script: (sessionId, index): readonly ScriptEntry[] => {
      if (sessionId === SUPERVISOR) {
        return [supervisorDraft, evaluateEntry(() => h, () => root, () => inputDir), publishEntry(() => h), { text: 'done' }]
      }
      if (index === 0) return [{ tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
      // Replay workers spawn in the plan's own order (maxParallel 1): baseline,
      // candidate, then any child the candidate's own batch admitted.
      const replayOrder = h.spawns.filter(spawn => spawn.sessionId !== SUPERVISOR).findIndex(spawn => spawn.sessionId === sessionId)
      return workerScript(h, sessionId, replayOrder)
    },
  })
  inputDir = join(h.workspace, 'eval-input')
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'input.txt'), 'the frozen input\n', { encoding: 'utf8' })
  root = await h.begin({
    objective: 'deliver the answer',
    requiredCapabilities: [...requiredCapabilities],
    acceptanceCriteria: criterion('true'),
  })
  await h.agent(ROOT).whenIdle()
  expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified')
  return { h, root }
}

describe('the three evolved asset kinds, consumed for real', () => {
  it('a first Skill publishes on the candidate side’s own grant-and-load proof', async () => {
    const { h, root } = await startMethodChain({})

    h.userSays('run the method chain', SUPERVISOR)
    await waitForCalls(h, 'method_publish', 1)

    // The evaluation's own account: the domain guard read the sealed receipt.
    const evaluation = lastCall(h, 'method_evaluate')
    expect(evaluation.result?.isError).not.toBe(true)
    expect(evaluation.result?.text).toContain('skill-consumed held — skill "verify" was granted and loaded by the candidate side')

    // The store's own records agree: the candidate replay run ran under the
    // candidate revision, and its receipt shows the skill bound by the run's
    // grant and loaded in the session's persisted log — not outside the grant.
    const snapshot = await h.snapshot(root.storeId)
    const candidateRun = snapshot.runs.find(run => run.trialCandidateRef === 'c-d0001')
    expect(candidateRun?.status).toBe('verified')
    const receipt = snapshot.receipts?.find(entry => entry.runId === candidateRun!.runId)
    const use = receipt?.skills.find(entry => entry.bound.some(skill => skill.name === 'verify'))
    expect(use?.loaded).toContain('verify')
    expect(use?.loadedOutsideGrant).toEqual([])

    // The measured candidate is what the pointer switched to.
    expect(lastCall(h, 'method_publish').result?.text).toContain('published: active revision c-d0001 g2')
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'c-d0001', generation: 2 })
  }, 90_000)

  it('a capability gap refuses the baseline at admission for real, runs the candidate under its own row, and the guard refuses the evaluation', async () => {
    // A capability row must grant a skill the candidate revision holds, so the
    // chain first publishes the skill (round one, the ordinary chain), then
    // drafts the missing row against the moved pointer (round two). The gapped
    // sample is the root's own task — its contract required the missing row
    // from the start, the intake recorded the obligation and ran it anyway —
    // and round one's clean sample is the child the root delegated the doable
    // part to.
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    let inputDir!: string
    let childTaskId = ''
    const draftIdAt = (occurrence: number): string => {
      const call = settledCalls(h, 'method_draft')[occurrence]
      const match = /draft (d[0-9]{4})/.exec(call?.result?.text ?? '')
      if (match === null) throw new Error(`no draft id in method_draft call ${occurrence}`)
      return match[1]!
    }
    h = await startScriptedLoop({
      evolution: { ledgerRoot: mkdtempSync(join(tmpdir(), 'method-assets-')) },
      supervisors: [SUPERVISOR],
      approvalAnswer: () => 'allowed-once',
      script: (sessionId, index): readonly ScriptEntry[] => {
        if (sessionId === SUPERVISOR) {
          return [
            {
              tool: 'method_draft',
              args: {
                kind: 'skill',
                identity: 'verify',
                edits: [{ id: 'e1', mechanism: 'skill', targets: ['skills/verify/SKILL.md'] }],
                editPayload: JSON.stringify({ skillMd: SKILL_MD }),
                rationale: 'the skill the observed failure answers',
                sourceRefs: ['diagnosis:d1'],
                expectedBaseRevision: 'r0001',
                round: 0,
                critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
              },
            },
            {
              tool: 'method_evaluate',
              args: () => {
                if (childTaskId === '') throw new Error('the root’s child has not been named yet')
                return {
                  draftId: draftIdAt(0),
                  round: 0,
                  samples: [{ taskId: childTaskId, role: 'observed-success' }],
                  quality: { metricId: 'acceptance', extractor: 'acceptance' },
                  repetition: 0,
                  input: { sourceDir: inputDir },
                  maxParallel: 1,
                }
              },
            },
            { tool: 'method_publish', args: () => ({ draftId: draftIdAt(0), expectedActiveRevision: 'r0001', expectedGeneration: 1 }) },
            {
              tool: 'method_draft',
              args: {
                kind: 'capability',
                identity: 'fly-to-moon',
                edits: [{ id: 'e1', mechanism: 'capability', targets: ['capabilities.json'] }],
                editPayload: JSON.stringify({ entry: { skills: ['verify'] } }),
                rationale: 'install the row the observed task’s contract requires',
                sourceRefs: ['diagnosis:d1'],
                expectedBaseRevision: 'c-d0001',
                round: 0,
                critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
              },
            },
            {
              tool: 'method_evaluate',
              args: () => ({
                draftId: draftIdAt(1),
                round: 0,
                samples: [{ taskId: root.taskId, role: 'observed-success' }],
                quality: { metricId: 'acceptance', extractor: 'acceptance' },
                repetition: 0,
                input: { sourceDir: inputDir },
                maxParallel: 1,
              }),
            },
            { tool: 'method_publish', args: () => ({ draftId: draftIdAt(1), expectedActiveRevision: 'c-d0001', expectedGeneration: 2 }) },
            { text: 'done' },
          ]
        }
        if (index === 0) {
          // The gapped root delegates the doable part to a child whose contract
          // the active table can admit, then hands in once the child verified.
          return [
            {
              tool: 'task_decompose',
              args: {
                reason: 'delegate the doable part',
                children: [
                  {
                    objective: 'deliver the doable part',
                    requiredCapabilities: ['execute-task'],
                    acceptanceCriteria: [{ description: 'the doable part holds', command: 'true' }],
                  },
                ],
              },
            },
            {
              waitFor: async () => {
                await vi.waitFor(
                  async () => {
                    const children = (await h.snapshot(root.storeId)).tasks.filter(task => task.parentTaskId === root.taskId)
                    expect(children).toHaveLength(1)
                    expect(children[0]!.status).toBe('verified')
                    childTaskId = children[0]!.taskId
                  },
                  { timeout: 30_000, interval: 100 },
                )
              },
            },
            { tool: 'task_submit_result', args: { summary: 'the answer is delivered' } },
            { text: 'delivered' },
          ]
        }
        // Spawns, in order: the root's own child, round one's baseline, round
        // one's candidate, then round two's candidate — round two's baseline
        // side never spawns, it is refused before any replay. Round one's
        // baseline spends the extra request the strategy's cost relief reads.
        const replayOrder = h.spawns.filter(spawn => spawn.sessionId !== SUPERVISOR).findIndex(spawn => spawn.sessionId === sessionId)
        return replayOrder === 1
          ? [{ tool: 'task_status', args: {} }, { tool: 'task_submit_result', args: { summary: 'replayed answer' } }, { text: 'done' }]
          : [{ tool: 'task_submit_result', args: { summary: 'replayed answer' } }, { text: 'done' }]
      },
    })
    inputDir = join(h.workspace, 'eval-input')
    mkdirSync(inputDir, { recursive: true })
    writeFileSync(join(inputDir, 'input.txt'), 'the frozen input\n', { encoding: 'utf8' })
    root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task', 'fly-to-moon'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()
    expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified')

    h.userSays('run the method chain', SUPERVISOR)
    await waitForCalls(h, 'method_publish', 2)

    // Round one is the ordinary chain: the skill measured and published, so the
    // pointer the capability draft builds on is the moved one.
    expect(lastCall(h, 'method_publish', 0).result?.text).toContain('published: active revision c-d0001 g2')

    // Round two's candidate side really ran, admitted through the candidate
    // revision's row: the runtime's own binding names the capability the active
    // revision does not hold.
    const snapshot = await h.snapshot(root.storeId)
    const replayed = snapshot.tasks.filter(task => task.objective.includes('evolution-eval:d0002'))
    expect(replayed).toHaveLength(1)
    const candidateRun = snapshot.runs.filter(run => run.taskId === replayed[0]!.taskId).at(-1)!
    expect(candidateRun.status).toBe('verified')
    expect(candidateRun.trialCandidateRef).toBe('c-d0002')
    expect(candidateRun.providerBinding?.capabilities).toContain('fly-to-moon')

    // The evaluation's own records: the baseline side carries the runtime's
    // verbatim admission refusal, the candidate side its real run — and the
    // non-compensatory guard refuses to read a refusal as a measured outcome.
    const evaluation = lastCall(h, 'method_evaluate', 1)
    expect(evaluation.result?.text).toContain('method_evaluate rejected')
    expect(evaluation.result?.text).toContain('an admission refusal is a gap in the plan, never a measured outcome')
    const trials = ledgerRecords(h)
      .filter(record => record.kind === 'trial' && record.draftId === 'd0002')
      .map(record => record.trial as Record<string, unknown>)
    expect(trials).toHaveLength(2)
    const baseline = trials.find(trial => trial.side === 'baseline')!
    expect(baseline.outcome).toBe('not-admitted')
    expect(baseline.admission).toMatchObject({ source: 'capability-gap', missing: ['fly-to-moon'] })
    expect(trials.find(trial => trial.side === 'candidate')?.outcome).toBe('verified')
    // No report and no decision were recorded for the refused evaluation: the
    // ledger holds its plan and its trials as evidence, nothing more.
    expect(ledgerRecords(h).some(record => record.kind === 'evaluation' && record.draftId === 'd0002')).toBe(false)

    // The publish that follows is refused before anyone is asked, and nothing
    // moved past round one's switch.
    const publish = lastCall(h, 'method_publish', 1)
    expect(publish.result?.text).toContain('method_publish rejected')
    expect(publish.result?.text).toContain('carries no evaluation')
    expect(h.review.asks.map(ask => ask.toolName)).toEqual(['method_publish'])
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'c-d0001', generation: 2 })
    expect(ledgerRecords(h).some(record => record.kind === 'published' && record.draftId === 'd0002')).toBe(false)
  }, 90_000)

  it('a task template publishes on an observed instantiation with the parent acceptance judged independently', async () => {
    const template = {
      id: 'split-work',
      version: 1,
      catalogPath: ['general'],
      appliesTo: ['the answer is built from one delegated part'],
      parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
      contract: {
        objective: 'the templated parent delivers the answer',
        requiredCapabilities: ['execute-task'],
        acceptanceCriteria: [{ criterionId: 'templated-goal', description: 'the templated answer holds', command: 'true', verifierRef: 'command' }],
      },
      decomposition: {
        reason: 'split the answer into its templated parts',
        children: [
          {
            objective: 'deliver the templated part',
            requiredCapabilities: ['execute-task'],
            acceptanceCriteria: [{ description: 'the templated part holds', command: 'true' }],
          },
        ],
      },
    }
    const { h, root } = await startChain(
      ['execute-task'],
      {
        tool: 'method_draft',
        args: {
          kind: 'task-template',
          identity: 'split-work',
          edits: [{ id: 'e1', mechanism: 'task-template', targets: ['task-templates/split-work@1.json'] }],
          editPayload: JSON.stringify({ template }),
          rationale: 'the decomposition the observed task should have used',
          sourceRefs: ['diagnosis:d1'],
          expectedBaseRevision: 'r0001',
          round: 0,
          critic: { verdict: 'accept', reason: 'holds', evidenceRefs: ['diagnosis:d1'] },
        },
      },
      (loop, _sessionId, replayOrder) => {
        if (replayOrder === 0) {
          // The baseline spends four extra requests: the cost relief the frozen
          // strategy admits the (larger but cheaper per side) candidate subtree from.
          return [
            { tool: 'task_status', args: {} },
            { tool: 'task_status', args: {} },
            { tool: 'task_status', args: {} },
            { tool: 'task_status', args: {} },
            { tool: 'task_submit_result', args: { summary: 'replayed answer' } },
            { text: 'done' },
          ]
        }
        if (replayOrder === 1) {
          // The candidate side instantiates the template for real: one
          // `task_decompose` naming the pinned reference — the digest read back
          // from the frozen candidate revision's own file, not from the draft
          // the caller wrote — then waits for its child to verify before
          // handing in, so the sealed subtree is whole.
          return [
            {
              tool: 'task_decompose',
              args: () => {
                const file = join(libraryRoots(ROOT, loop.home).root, 'revisions', 'c-d0001', 'task-templates', 'split-work@1.json')
                const stored = parseTaskTemplate(JSON.parse(readFileSync(file, 'utf8')))
                return { templateRef: { id: 'split-work', version: 1, digest: taskTemplateDigest(stored) }, templateParameters: {} }
              },
            },
            {
              waitFor: async () => {
                await vi.waitFor(
                  async () => {
                    const snap = await loop.snapshot(root.storeId)
                    const parent = snap.tasks.find(task => task.objective.includes('evolution-eval') && task.objective.includes(':candidate]'))
                    expect(parent).toBeDefined()
                    const children = snap.tasks.filter(task => task.parentTaskId === parent!.taskId)
                    expect(children).toHaveLength(1)
                    expect(children[0]!.status).toBe('verified')
                  },
                  { timeout: 30_000, interval: 100 },
                )
              },
            },
            { tool: 'task_submit_result', args: { summary: 'the templated answer is delivered' } },
            { text: 'done' },
          ]
        }
        // The child the template's decomposition admitted.
        return [{ tool: 'task_submit_result', args: { summary: 'the templated part' } }, { text: 'done' }]
      },
    )

    h.userSays('run the method chain', SUPERVISOR)
    await waitForCalls(h, 'method_publish', 1)

    // The evaluation's own account: the consumption proof and the guard.
    const evaluation = lastCall(h, 'method_evaluate')
    expect(evaluation.result?.isError).not.toBe(true)
    expect(evaluation.result?.text).toContain(
      'task-template-consumed held — template instantiated and observed (1 batch(es)), with the parent acceptance judged independently',
    )

    // The store's own records agree: the candidate replay really decomposed
    // into the template's child, the child really ran and verified, and the
    // sealed receipt shows the batch observed against the pinned reference.
    const snapshot = await h.snapshot(root.storeId)
    const parent = snapshot.tasks.find(task => task.objective.includes('evolution-eval') && task.objective.includes(':candidate]'))!
    const children = snapshot.tasks.filter(task => task.parentTaskId === parent.taskId)
    expect(children).toHaveLength(1)
    expect(children[0]!.status).toBe('verified')
    const parentRun = snapshot.runs.filter(run => run.taskId === parent.taskId).at(-1)!
    expect(parentRun.status).toBe('verified')
    expect(parentRun.trialCandidateRef).toBe('c-d0001')
    const receipt = snapshot.receipts?.find(entry => entry.runId === parentRun.runId)
    expect(receipt?.templates).toHaveLength(1)
    expect(receipt?.templates[0]).toMatchObject({
      templateRef: { id: 'split-work', version: 1 },
      observation: 'observed',
      childTaskIds: [children[0]!.taskId],
    })
    // The parent's own acceptance was judged by the frozen verifier, not
    // replaced by the candidate's: the sealed review carries its verdict.
    expect(receipt?.review.criteria).toContainEqual(expect.objectContaining({ criterionId: 'goal', verdict: 'pass' }))

    // The report's guards as the publish re-check will re-derive them.
    const report = JSON.parse(readFileSync(reportPathOf(h, 'd0001'), 'utf8')) as { guards: { id: string; ok: boolean }[] }
    expect(report.guards).toContainEqual(expect.objectContaining({ id: 'task-template-consumed', ok: true }))
    expect(report.guards).toContainEqual(expect.objectContaining({ id: 'independent-parent-acceptance', ok: true }))

    // The measured candidate is what the pointer switched to.
    expect(lastCall(h, 'method_publish').result?.text).toContain('published: active revision c-d0001 g2')
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'c-d0001', generation: 2 })
  }, 90_000)
})
