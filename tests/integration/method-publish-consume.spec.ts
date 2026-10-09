/**
 * `method_draft` → `method_evaluate` → `method_publish` on the real deployment:
 * the evaluation freezes the draft, measures both sides through real replay
 * runs whose receipts carry real token readings, and the one approval switches
 * the pointer. A run started after the switch binds the new revision; the run
 * that produced the sample keeps the old one. A report file or a ledger line
 * edited after the evaluation fails the digest re-read, and nothing is written.
 *
 * Everything except the model is the deployment's own: the real DSH loop with a
 * scripted provider, the real `TaskRuntime` (its environment library, drafts
 * and pointer on a real disk), the real task store, and the real method ledger.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { libraryRoots } from '../../task-runtime/src/environment/index.ts'
import { disposeScriptedLoops } from '../support/scripted-loop.ts'
import {
  ROOT,
  lastCall,
  ledgerRecords,
  reportPathOf,
  startMethodChain,
  waitForCalls,
} from './method-chain.fixture.ts'

afterEach(async () => {
  await disposeScriptedLoops()
})

describe('the method chain on the real deployment', () => {
  it('publishes an evaluated skill candidate, and only runs started after the switch bind it', async () => {
    const { h, root } = await startMethodChain({ extraPublish: true })

    h.userSays('run the method chain', 's-supervisor')
    await waitForCalls(h, 'method_publish', 2)

    const published = lastCall(h, 'method_publish', 0)
    expect(published.result?.isError).not.toBe(true)
    expect(published.result?.text).toContain('published: active revision c-d0001 g2')

    // The pointer really switched, once, under exactly one approval.
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'c-d0001', generation: 2 })
    expect(h.review.asks.map(ask => ask.toolName)).toEqual(['method_publish'])

    // The ledger's last line is the publication, bound to the approval it was granted under.
    const records = ledgerRecords(h)
    const last = records[records.length - 1]!
    expect(last).toMatchObject({ kind: 'published', draftId: 'd0001', revisionId: 'c-d0001', supersededRevisionId: 'r0001' })
    expect(typeof last.approvalRef).toBe('string')

    // The repeat call met the moved pointer and was refused without a second approval.
    const repeated = lastCall(h, 'method_publish', 1)
    expect(repeated.result?.text).toContain('method_publish rejected')
    expect(repeated.result?.text).toContain('c-d0001 g2')

    // A run started after the switch binds the published revision; the sample's
    // own run keeps the revision it was produced under.
    const outcome = await h.runtime.replayTask(root.storeId, root.taskId, { lineage: 'post-publish-consume' }, ROOT)
    const snapshot = await h.snapshot(root.storeId)
    const replayed = snapshot.tasks.find(task => task.taskId === outcome.taskId)
    expect(replayed?.objective).toContain('post-publish-consume')
    const newRun = snapshot.runs.filter(run => run.taskId === outcome.taskId).at(-1)!
    await vi.waitFor(
      async () => {
        const settled = (await h.snapshot(root.storeId)).runs.find(run => run.runId === newRun.runId)
        expect(settled?.status).toBe('verified')
      },
      { timeout: 30_000, interval: 100 },
    )
    const settled = (await h.snapshot(root.storeId)).runs.find(run => run.runId === newRun.runId)!
    expect(settled.providerBinding?.environmentRevisionId).toBe('c-d0001')
    expect(settled.providerBinding?.trialCandidateRef).toBeUndefined()
    const oldRun = snapshot.runs.find(run => run.runId === root.runId)!
    expect(oldRun.providerBinding?.environmentRevisionId).toBe('r0001')
    expect(oldRun.providerBinding?.trialCandidateRef).toBeUndefined()
  }, 90_000)

  it('refuses a publication whose report bytes were edited after the evaluation, and writes nothing', async () => {
    const { h } = await startMethodChain({
      tamper: (loop, draftId) => {
        const path = reportPathOf(loop, draftId)
        const report = JSON.parse(readFileSync(path, 'utf8')) as { verdict?: unknown }
        report.verdict = 'regressed'
        writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      },
    })

    h.userSays('run the method chain', 's-supervisor')
    await waitForCalls(h, 'method_publish', 1)

    const call = lastCall(h, 'method_publish')
    expect(call.result?.text).toContain('method_publish rejected')
    expect(call.result?.text).toMatch(/reads [0-9a-f]{64}, not the [0-9a-f]{64} the ledger recorded/)
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'r0001', generation: 1 })
    // The digest failure is read back before any approval is spent.
    expect(h.review.asks).toHaveLength(0)
    expect(ledgerRecords(h).some(record => record.kind === 'published')).toBe(false)
  }, 90_000)

  it('refuses a publication whose ledger line was edited after the evaluation, and writes nothing', async () => {
    const { h } = await startMethodChain({
      tamper: loop => {
        const path = join(libraryRoots(ROOT, loop.home).root, 'methods.jsonl')
        const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim().length > 0)
        const index = lines.findIndex(line => (JSON.parse(line) as { kind?: unknown }).kind === 'evaluation')
        if (index < 0) throw new Error('no evaluation line in the ledger')
        const record = JSON.parse(lines[index]!) as Record<string, unknown>
        record.reportDigest = '0'.repeat(64)
        lines[index] = JSON.stringify(record)
        writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
      },
    })

    h.userSays('run the method chain', 's-supervisor')
    await waitForCalls(h, 'method_publish', 1)

    const call = lastCall(h, 'method_publish')
    expect(call.result?.text).toContain('method_publish rejected')
    expect(call.result?.text).toMatch(/reads [0-9a-f]{64}, not the [0-9a-f]{64} the ledger recorded/)
    const view = await h.runtime.activeEnvironmentView(ROOT)
    expect({ revisionId: view.revisionId, generation: view.generation }).toEqual({ revisionId: 'r0001', generation: 1 })
    expect(h.review.asks).toHaveLength(0)
    expect(ledgerRecords(h).some(record => record.kind === 'published')).toBe(false)
  }, 90_000)
})
