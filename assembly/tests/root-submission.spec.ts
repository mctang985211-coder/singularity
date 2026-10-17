import { testProjections } from './seam.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { callerOf, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { decompose, propose } from '../src/surfaces.ts'
import { startAttempt } from '../src/attempt.ts'
import { submit } from '../src/submission.ts'
import { fixtureReview } from './review-fixture.ts'
import { attachmentsAt, agentFor, execFor, factsOf, fakeExecution, FakePersistence } from './seam.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'root-submission-'))
  roots.push(workspace)
  const medium = new FakePersistence()
  const domain = await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess)
  const apparatus = await openApparatus('root-submission', workspace, domain, medium as never, attachmentsAt(workspace), testProjections)
  const agent = agentFor('root', 'root'), caller = callerOf(agent)
  const root = await propose(apparatus, caller, 'root', { goal: 'Coordinate the complete letter count' })
  const execution = fakeExecution(() => undefined)
  const send = (sourceTaskId: string, sourceRunId: string) => submit(apparatus, execution, caller, execFor(agent, 'root-submit'),
    { taskId: root.taskId, sourceTaskId, sourceRunId }, new AbortController().signal, fixtureReview(apparatus))
  const delegate = async () => {
    await decompose(apparatus, { advance: async () => [] }, caller, {
      taskId: root.taskId, children: [{ key: 'count', dependsOn: [], supports: ['letters'], maxRuns: 1, requirement: 'required' as const,
        contract: { goal: 'Count the supplied ASCII letters for integration', artifact: 'child/report.txt',
          inputs: root.contract.inputs, criteria: [{ criterionId: 'counted', statement: 'Report the decimal ASCII letter count' }] },
      }],
    })
    const id = taskStateOf(apparatus, root.taskId).decomposition!.children[0]!.taskId
    const childAgent = agentFor(taskStateOf(apparatus, id).responsibility!.agentId, taskStateOf(apparatus, id).responsibility!.agentId)
    const childCaller = callerOf(childAgent)
    const run = await startAttempt(apparatus, childCaller, id, 'child-run', root.method)
    const complete = async (content = '35\n') => {
      const file = join(run.bubble!.workspace.ref, 'child/report.txt')
      await mkdir(join(run.bubble!.workspace.ref, 'child'), { recursive: true })
      await writeFile(file, content)
      await submit(apparatus, execution, childCaller, execFor(childAgent, 'child-submit'),
        { taskId: id, path: 'child/report.txt' }, new AbortController().signal, fixtureReview(apparatus))
      return file
    }
    return { id, run, complete }
  }
  return { apparatus, medium, root, send, delegate }
}

it('cannot submit a root without delegating or reuse an unrelated Task', async () => {
  const h = await setup(), before = factsOf(h.medium)
  await expect(h.send(h.root.taskId, h.root.runId)).rejects.toMatchObject({ refusal: { code: 'not-responsible' } })
  expect(factsOf(h.medium)).toEqual(before)
  await h.apparatus.store.close()
})

it('requires the exact verified child Run before changing the root artifact', async () => {
  const h = await setup(), child = await h.delegate(), before = factsOf(h.medium)
  for (const runId of [child.run.runId, 'missing-run'])
    await expect(h.send(child.id, runId)).rejects.toMatchObject({ refusal: { code: 'illegal-transition' } })
  expect(factsOf(h.medium)).toEqual(before)
  await h.apparatus.store.close()
})

it('copies sealed child bytes rather than its mutable workspace and still independently checks the root', async () => {
  const h = await setup(), child = await h.delegate(), file = await child.complete()
  await writeFile(file, 'tampered live workspace\n')
  expect(await h.send(child.id, child.run.runId)).toMatchObject({ verdict: 'pass', phase: 'verified' })
  expect(await readFile(join(h.root.workspace, h.root.contract.artifact), 'utf8')).toBe('35\n')
  const reviews = factsOf(h.medium).filter(fact => fact.kind === 'review/started')
  expect(reviews).toHaveLength(2)
  const before = factsOf(h.medium)
  await h.send(child.id, child.run.runId)
  expect(factsOf(h.medium)).toEqual(before)
  await h.apparatus.store.close()
})

it('does not turn child verification into a pass for the complete root result', async () => {
  const h = await setup(), child = await h.delegate()
  await child.complete('36\n')
  expect(taskStateOf(h.apparatus, child.id).runs[child.run.runId]!.status).toBe('verified')
  expect(await h.send(child.id, child.run.runId)).toMatchObject({ verdict: 'fail', phase: 'failed' })
  await h.apparatus.store.close()
})
