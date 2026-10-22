import { fileURLToPath } from 'node:url'
import { testProjections } from './seam.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { openApparatus, callerOf, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { propose } from '../src/surfaces.ts'
import { submit, judgeAndRecord } from '../src/submission.ts'
import { repair } from '../src/repair.ts'
import { fixtureReview } from './review-fixture.ts'
import { attachmentsAt, FakePersistence, agentFor, execFor, fakeExecution, factsOf } from './seam.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-recovery-'))
  roots.push(root)
  const domain = await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess),
    medium = new FakePersistence(),
    apparatus = await openApparatus('recovery', root, domain, medium as never, attachmentsAt(root), testProjections)
  const agent = agentFor('worker', 'worker'),
    caller = callerOf(agent),
    proposal = await propose(apparatus, caller, 'root', { goal: 'count' })
  await writeFile(join(proposal.workspace, proposal.contract.artifact), '35')
  const send = () =>
    submit(
      apparatus,
      fakeExecution(() => undefined),
      caller,
      execFor(agent, 'submit'),
      { taskId: proposal.taskId, path: proposal.contract.artifact },
      new AbortController().signal,
      fixtureReview(apparatus),
    )
  return { root, domain, medium, apparatus, proposal, send }
}
describe('recovery uses the same sealed responsibility and review', () => {
  it.each(['review/started', 'review/completed', 'evidence/produced', 'run/verified'])(
    'resumes after interrupted %s without a new Task, Run, ReviewRun or submission',
    async (kind) => {
      const h = await setup()
      h.medium.failAppendOf(kind)
      await expect(h.send()).rejects.toThrow('write-not-durable')
      await h.apparatus.store.close()
      const sealed = taskStateOf(h.apparatus, h.proposal.taskId).runs[h.proposal.runId]!.submission
      await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), '0')
      const restored = await openApparatus('recovery', h.root, h.domain, h.medium as never, attachmentsAt(h.root), testProjections)
      await repair(restored, async (taskId, run) => {
        await judgeAndRecord(restored, taskId, run, new AbortController().signal, fixtureReview(restored))
        return true
      })
      expect(taskStateOf(restored, h.proposal.taskId).runs[h.proposal.runId]).toMatchObject({
        status: 'verified',
        submission: sealed,
      })
      for (const event of ['run/started', 'run/submitted', 'review/started', 'review/completed', 'run/verified'])
        expect(
          factsOf(h.medium).filter((e) => e.kind === event),
          event,
        ).toHaveLength(1)
      const count = h.medium.events.length
      await repair(restored, async () => {
        throw Error('terminal Run must not be reviewed again')
      })
      expect(h.medium.events).toHaveLength(count)
      await restored.store.close()
    },
  )
  it('preserves working state when artifact sealing never committed and continues the same Run', async () => {
    const h = await setup()
    h.medium.failAppendOf('run/submitted')
    await expect(h.send()).rejects.toThrow('write-not-durable')
    await h.apparatus.store.close()
    const restored = await openApparatus('recovery', h.root, h.domain, h.medium as never, attachmentsAt(h.root), testProjections)
    await repair(restored, async () => false)
    expect(taskStateOf(restored, h.proposal.taskId).runs[h.proposal.runId]!.stage).toBe('working')
    expect(factsOf(h.medium).filter((e) => e.kind === 'run/started')).toHaveLength(1)
    await restored.store.close()
  })
  it('reuses a completed honest fail judgment after settlement interruption', async () => {
    const h = await setup()
    await writeFile(join(h.proposal.workspace, h.proposal.contract.artifact), '0')
    h.medium.failAppendOf('run/failed')
    await expect(h.send()).rejects.toThrow()
    await h.apparatus.store.close()
    const restored = await openApparatus('recovery', h.root, h.domain, h.medium as never, attachmentsAt(h.root), testProjections)
    await repair(restored, async (taskId, run) => {
      await judgeAndRecord(restored, taskId, run, new AbortController().signal, fixtureReview(restored))
      return true
    })
    expect(taskStateOf(restored, h.proposal.taskId).runs[h.proposal.runId]!.status).toBe('failed')
    expect(factsOf(h.medium).filter((e) => e.kind === 'review/completed')).toHaveLength(1)
    expect(factsOf(h.medium).filter((e) => e.kind === 'review/failed')).toHaveLength(0)
    await restored.store.close()
  })
})

it('refuses missing sealed artifacts before replaying independent judgment', async () => {
  const h = await setup()
  h.medium.failAppendOf('review/started')
  await expect(h.send()).rejects.toThrow('write-not-durable')
  await h.apparatus.store.close()
  const sealed = taskStateOf(h.apparatus, h.proposal.taskId).runs[h.proposal.runId]!.submission!
  await rm(attachmentsAt(h.root).fileHostPath(sealed.files.artifact))
  const restored = await openApparatus('recovery', h.root, h.domain, h.medium as never, attachmentsAt(h.root), testProjections)
  let restoredJudgment = false
  await expect(
    repair(restored, async () => {
      restoredJudgment = true
      return false
    }),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' })
  expect(restoredJudgment).toBe(false)
  expect(taskStateOf(restored, h.proposal.taskId).runs[h.proposal.runId]!.status).toBe('running')
  await restored.store.close()
})
it('refuses changed working inputs without inventing a recovered outcome', async () => {
  const h = await setup()
  await writeFile(join(h.proposal.workspace, 'in/source.txt'), 'changed')
  await expect(repair(h.apparatus, async () => false)).rejects.toThrow('working input changed')
  expect(factsOf(h.medium).some((f) => f.kind === 'run/verified')).toBe(false)
  await h.apparatus.store.close()
})
