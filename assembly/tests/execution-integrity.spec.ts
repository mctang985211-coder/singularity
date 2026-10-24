import { fileURLToPath } from 'node:url'
import { testProjections } from './seam.ts'
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { openApparatus, callerOf, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { propose } from '../src/surfaces.ts'
import { readTask } from '../src/read.ts'
import { submit } from '../src/submission.ts'
import { sealedBytes } from '../src/sealed.ts'
import { fixtureReview } from './review-fixture.ts'
import { attachmentsAt, FakePersistence, agentFor, execFor, fakeExecution } from './seam.ts'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'sealed-submission-'))
  roots.push(root)
  const medium = new FakePersistence(),
    apparatus = await openApparatus(
      'submission',
      root,
      await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
      medium as never,
      attachmentsAt(root),
      testProjections,
    )
  const agent = agentFor('worker', 'worker'),
    caller = callerOf(agent),
    proposal = await propose(apparatus, caller, 'root', { goal: 'count' })
  const send = (id = 'submit') =>
    submit(
      apparatus,
      fakeExecution(() => undefined),
      caller,
      execFor(agent, id),
      { taskId: proposal.taskId, path: proposal.contract.artifact },
      new AbortController().signal,
      fixtureReview(apparatus),
    )
  return { apparatus, proposal, medium, send, caller, agent }
}
describe('sealed file submission', () => {
  it('refuses a second submission during review without failing the already sealed Run', async () => {
    const h = await setup()
    await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), '35')
    let reviewing!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => {
      reviewing = resolve
    })
    const release = new Promise<void>(resolve => {
      finish = resolve
    })
    const judge = fixtureReview(h.apparatus)
    const pending = submit(
      h.apparatus,
      fakeExecution(() => undefined),
      h.caller,
      execFor(h.agent, 'first'),
      { taskId: h.proposal.taskId, path: h.proposal.contract.artifact },
      new AbortController().signal,
      async (...args) => {
        reviewing()
        await release
        return judge(...args)
      },
    )
    await started
    try {
      await expect(h.send('second')).rejects.toThrow('no working Run')
      expect(taskStateOf(h.apparatus, h.proposal.taskId).runs[h.proposal.runId]).toMatchObject({
        status: 'running',
        stage: 'submitted',
      })
    } finally {
      finish()
    }
    expect((await pending).verdict).toBe('pass')
    await h.apparatus.store.close()
  })
  it('judges the actual artifact and reuses its committed answer after workspace deletion', async () => {
    const h = await setup()
    await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), '35')
    const answer = await h.send()
    expect(answer.verdict).toBe('pass')
    const run = taskStateOf(h.apparatus, h.proposal.taskId).runs[h.proposal.runId]!
    expect((await sealedBytes(h.apparatus, run.submission!.files.artifact)).toString()).toBe('35')
    expect(run.submission!.files).not.toHaveProperty('program')
    const count = h.medium.events.length
    await rm(h.proposal.workspace, { recursive: true })
    expect(await h.send()).toEqual(answer)
    expect(h.medium.events).toHaveLength(count)
    expect(
      (await readTask(h.apparatus, taskStateOf(h.apparatus, h.proposal.taskId))).runs.at(-1)!.receipt?.source
        ?.sessionId,
    ).toBe('worker')
    await h.apparatus.store.close()
  })
  it('finishes a negative review and a failed acceptance without failing the reviewer Run', async () => {
    const h = await setup()
    await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), '0')
    expect((await h.send()).verdict).toBe('fail')
    const reviews = h.apparatus.store
      .load()
      .entries()
      .filter(e => e.kind === 'review/completed')
    expect(reviews).toHaveLength(1)
    expect(
      h.apparatus.store
        .load()
        .entries()
        .some(e => e.kind === 'review/failed'),
    ).toBe(false)
    await h.apparatus.store.close()
  })
  it('refuses changed frozen inputs and symbolic artifact paths', async () => {
    const h = await setup()
    await writeFile(join(h.proposal.workspace, 'in/source.txt'), 'changed')
    await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), '35')
    await expect(h.send()).rejects.toThrow('evidence-input-mismatch')
    expect(
      h.apparatus.store
        .load()
        .entries()
        .some(e => e.kind === 'review/started'),
    ).toBe(false)
    await h.apparatus.store.close()
    const s = await setup()
    const outside = join(s.proposal.workspace, 'outside')
    await writeFile(outside, '35')
    await symlink(outside, join(s.proposal.workspace, s.proposal.contract.artifact))
    await expect(s.send()).rejects.toThrow('symbolic link')
    expect(await readFile(outside, 'utf8')).toBe('35')
    await s.apparatus.store.close()
  })
  it('refuses executor-generated approval as acceptance evidence', async () => {
    const h = await setup(),
      run = taskStateOf(h.apparatus, h.proposal.taskId).runs[h.proposal.runId]!
    await expect(
      h.apparatus.tasks.recordVerdict({
        commandId: 'self',
        taskId: h.proposal.taskId,
        verdict: {
          runId: run.runId,
          criterionId: 'letters',
          reviewId: 'invented',
          verifierRef: 'independent-review',
          verifierVersion: '1',
          implementationDigest: '1'.repeat(64),
          verdict: 'pass',
          artifactDigest: '2'.repeat(64),
          inputDigests: run.bubble!.inputs,
        },
      }),
    ).rejects.toThrow('self-reported-evidence')
    await h.apparatus.store.close()
  })
})
