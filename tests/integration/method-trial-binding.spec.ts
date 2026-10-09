/**
 * A supervisor's `trialCandidateRef` on the real deployment: the completion the
 * supervisor records names one unpublished candidate, the coordination driver
 * carries it into the next round's recovery request, and the runtime binds that
 * round to the candidate's bytes while the active pointer never moves. A round
 * completed without a trial binds the active revision exactly as before.
 *
 * Everything except the model is the deployment's own: the real DSH loop with a
 * scripted provider, the real `TaskRuntime` (its environment library, drafts and
 * pointer on a real disk), the real task store, and the real coordination file.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { bubbleMethodRevisionOf, bubbleWorkspacePath } from '../../task-runtime/src/service/bubble.ts'
import { libraryRoots, readRevision } from '../../task-runtime/src/environment/index.ts'
import { CoordinationDriver } from '../../agent-singularity/src/coordination/driver.ts'
import { roundRequestKey } from '../../agent-singularity/src/coordination/rounds.ts'
import { disposeScriptedLoops, startScriptedLoop, type ScriptEntry, type ScriptedLoop } from '../support/scripted-loop.ts'

const ROOT = 's-root'
const GRAPH = 'g1'
const RSI = { task: 'keep the delivered answer method improving', iterationRounds: 4, humanReview: false }

const criterion = (command: string) => [{ criterionId: 'goal', description: 'the delivered answer holds', command, verifierRef: 'command' }]

/** A minimal `SKILL.md` the environment draft staging accepts. */
const skillMd = (body: string): string => `---\nname: trial-skill\ndescription: a candidate skill the next round trials\n---\n\n${body}\n`

let coordination: string
let previous: string | undefined

beforeEach(() => {
  coordination = mkdtempSync(join(tmpdir(), 'method-trial-binding-'))
  previous = process.env.SINGULARITY_COORDINATION_DIR
  process.env.SINGULARITY_COORDINATION_DIR = coordination
})

afterEach(async () => {
  await disposeScriptedLoops()
  if (previous === undefined) delete process.env.SINGULARITY_COORDINATION_DIR
  else process.env.SINGULARITY_COORDINATION_DIR = previous
  rmSync(coordination, { recursive: true, force: true })
})

/** Freeze one unpublished candidate revision on the graph's own library, through the runtime's own draft entries. */
async function freezeCandidate(h: ScriptedLoop, baseRevisionId: string): Promise<string> {
  const draft = await h.runtime.createDraft(ROOT, { basedOn: baseRevisionId, purpose: 'a candidate the next round trials' })
  await h.runtime.stageDraftEdit(ROOT, draft.draftId, {
    kind: 'skill',
    edit: { name: 'trial-skill', skillMd: skillMd('# a trialled answer'), expectedVersion: 0, actor: 's-supervisor' },
  })
  const frozen = await h.runtime.freezeDraft(ROOT, draft.draftId)
  return frozen.manifest.revisionId
}

/** The root submits; the supervisor concludes with the completion tool, carrying the trial the spec named. */
function scriptOf(
  h: () => ScriptedLoop,
  root: () => { taskId: string; runId: string },
  trialCandidateRef?: () => string,
): (sessionId: string, index: number) => readonly ScriptEntry[] {
  return (sessionId, index): readonly ScriptEntry[] => {
    const name = h().spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
    if (name.startsWith('rsi supervisor')) {
      return [
        {
          tool: 'supervisor_complete',
          args: () => ({
            businessAction: 'continue',
            reason: 'the delivered method can be improved',
            evidenceRefs: [`${root().taskId}#${root().runId}`],
            ...(trialCandidateRef === undefined ? {} : { trialCandidateRef: trialCandidateRef() }),
          }),
        },
      ]
    }
    if (index === 0) return [{ tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
    return [{ text: 'idle' }]
  }
}

async function drive(h: ScriptedLoop): Promise<CoordinationDriver> {
  const driver = new CoordinationDriver(h.ctx, { log: () => {}, fallbackMs: 20, settleGraceMs: 500 })
  driver.install()
  await driver.wake(GRAPH)
  return driver
}

describe('a trial binding on the real deployment', () => {
  it('binds the next round to the candidate the completion named, while the active pointer never moves', async () => {
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    let candidateId!: string
    h = await startScriptedLoop({ rsi: RSI, script: scriptOf(() => h, () => root, () => candidateId) })
    root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()
    expect((await h.snapshot(root.storeId)).runs.find(run => run.runId === root.runId)?.status).toBe('verified')

    const before = await h.runtime.activeEnvironmentView(ROOT)
    candidateId = await freezeCandidate(h, before.revisionId)

    const driver = await drive(h)
    try {
      await vi.waitFor(
        async () => {
          const snapshot = await h.snapshot(root.storeId)
          const next = snapshot.runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 1, 2))
          expect(next).toBeDefined()
          // The trial's identity is recorded on the run, and the bytes its
          // providers were bound from are the candidate's — while the run's own
          // environment revision stays the active one.
          expect(next!.trialCandidateRef).toBe(candidateId)
          expect(next!.environmentRevisionId).toBe(before.revisionId)
          expect(next!.providerBinding?.environmentRevisionId).toBe(candidateId)
          expect(next!.providerBinding?.trialCandidateRef).toBe(candidateId)
        },
        { timeout: 20_000 },
      )
      // The trial round's bubble carries the candidate: its method volume is
      // the candidate's verified bytes and its manifest names the candidate,
      // while the active pointer never moved.
      const bubble = bubbleWorkspacePath(h.home, ROOT, 2)
      const candidate = await readRevision(libraryRoots(ROOT, h.home), candidateId)
      expect(bubbleMethodRevisionOf(bubble)).toEqual({ revisionId: candidateId, digest: candidate!.manifest.contentDigest })
      expect(readFileSync(join(bubble, '.bubble', 'method-volume', 'trial-skill', 'SKILL.md'), 'utf8')).toBe(
        skillMd('# a trialled answer'),
      )
      const after = await h.runtime.activeEnvironmentView(ROOT)
      expect({ revisionId: after.revisionId, generation: after.generation }).toEqual({
        revisionId: before.revisionId,
        generation: before.generation,
      })
    } finally {
      driver.stop()
    }
  }, 60_000)

  it('binds the active revision when the completion names no trial, even with a candidate frozen beside it', async () => {
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    h = await startScriptedLoop({ rsi: RSI, script: scriptOf(() => h, () => root) })
    root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()

    const before = await h.runtime.activeEnvironmentView(ROOT)
    await freezeCandidate(h, before.revisionId)

    const driver = await drive(h)
    try {
      await vi.waitFor(
        async () => {
          const snapshot = await h.snapshot(root.storeId)
          const next = snapshot.runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 1, 2))
          expect(next).toBeDefined()
          expect(next!.trialCandidateRef).toBeUndefined()
          expect(next!.environmentRevisionId).toBe(before.revisionId)
          expect(next!.providerBinding?.environmentRevisionId).toBe(before.revisionId)
          expect(next!.providerBinding?.trialCandidateRef).toBeUndefined()
        },
        { timeout: 20_000 },
      )
      // The round's bubble binds the same revision the run was admitted against.
      expect(bubbleMethodRevisionOf(bubbleWorkspacePath(h.home, ROOT, 2))?.revisionId).toBe(before.revisionId)
    } finally {
      driver.stop()
    }
  }, 60_000)

  it('carries the promoted revision in the next round’s bubble once a trialled candidate is published', async () => {
    let h!: ScriptedLoop
    let root!: { storeId: string; taskId: string; runId: string }
    let candidateId!: string
    // The round two run, recorded once the driver opened it: the second
    // supervisor's completion cites it.
    let round2: { taskId: string; runId: string } | undefined
    let supervisors = 0
    h = await startScriptedLoop({
      rsi: RSI,
      script: (sessionId, _index): readonly ScriptEntry[] => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('rsi supervisor')) {
          supervisors += 1
          const first = supervisors === 1
          return [
            {
              tool: 'supervisor_complete',
              args: () => ({
                businessAction: 'continue',
                reason: 'the delivered method can be improved',
                evidenceRefs: [`${(first ? root : (round2 ?? root)).taskId}#${(first ? root : (round2 ?? root)).runId}`],
                // The first round trials the candidate; the round after its
                // promotion names no trial — the candidate is what it inherits.
                ...(first ? { trialCandidateRef: candidateId } : {}),
              }),
            },
          ]
        }
        // The root and every round's recovery worker deliver and settle verified.
        return [{ tool: 'task_submit_result', args: { summary: 'the answer is delivered' } }, { text: 'delivered' }]
      },
    })
    root = await h.begin({
      objective: 'deliver the answer',
      requiredCapabilities: ['execute-task'],
      acceptanceCriteria: criterion('true'),
    })
    await h.agent(ROOT).whenIdle()

    const before = await h.runtime.activeEnvironmentView(ROOT)
    candidateId = await freezeCandidate(h, before.revisionId)

    const driver = await drive(h)
    try {
      // Round two trials the candidate; its bubble carries the candidate's bytes.
      await vi.waitFor(
        async () => {
          const snapshot = await h.snapshot(root.storeId)
          const next = snapshot.runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 1, 2))
          expect(next?.trialCandidateRef).toBe(candidateId)
          round2 = next === undefined ? round2 : { taskId: next.taskId, runId: next.runId }
        },
        { timeout: 20_000 },
      )
      expect(bubbleMethodRevisionOf(bubbleWorkspacePath(h.home, ROOT, 2))?.revisionId).toBe(candidateId)

      // The trial settles verified and the candidate is promoted: the pointer
      // moves to it through the runtime's own publish entry.
      await vi.waitFor(
        async () => {
          const settled = (await h.snapshot(root.storeId)).runs.find(run => run.runId === round2?.runId)
          expect(settled?.status).toBe('verified')
        },
        { timeout: 20_000 },
      )
      const published = await h.runtime.publishRevision(ROOT, {
        direction: 'publish',
        source: { kind: 'revision', revisionId: candidateId },
        expected: { revisionId: before.revisionId, generation: before.generation },
        actor: 's-supervisor',
      })
      expect(published.pointer.revisionId).toBe(candidateId)

      // Round three opens against the round the trial ran in: the bubble it is
      // materialized with carries the freshly published revision, and the run
      // opened into it binds the same bytes.
      await vi.waitFor(
        async () => {
          const snapshot = await h.snapshot(root.storeId)
          const third = snapshot.runs.find(run => run.recovery?.requestKey === roundRequestKey(GRAPH, 1, 3))
          expect(third).toBeDefined()
          expect(third!.trialCandidateRef).toBe(candidateId)
          expect(third!.providerBinding?.environmentRevisionId).toBe(candidateId)
        },
        { timeout: 20_000 },
      )
      expect(bubbleMethodRevisionOf(bubbleWorkspacePath(h.home, ROOT, 3))?.revisionId).toBe(candidateId)
      expect((await h.runtime.activeEnvironmentView(ROOT)).revisionId).toBe(candidateId)
    } finally {
      driver.stop()
    }
  }, 90_000)
})
