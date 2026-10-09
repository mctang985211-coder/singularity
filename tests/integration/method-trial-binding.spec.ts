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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rootTaskStoreId } from '../../task/src/index.ts'
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
      // The pointer never moved: the candidate is trialled, not published.
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
    } finally {
      driver.stop()
    }
  }, 60_000)
})
