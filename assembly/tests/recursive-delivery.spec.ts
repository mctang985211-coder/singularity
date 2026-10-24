import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { TaskContract } from '../../src/task/contract.ts'
import { callerOf, declareCaller, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { startAttempt } from '../src/attempt.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { sealedBytes } from '../src/sealed.ts'
import { submit, type SubmissionInput } from '../src/submission.ts'
import { decompose, propose } from '../src/surfaces.ts'
import { coordinationOf, waitingReason } from '../src/coordination.ts'
import { fixtureReview } from './review-fixture.ts'
import { agentFor, attachmentsAt, execFor, fakeExecution, FakePersistence, factsOf, testProjections } from './seam.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const contract = (goal: string, inputs: TaskContract['inputs'] = []): TaskContract => ({
  goal,
  artifact: 'result.bin',
  inputs,
  criteria: [{ criterionId: 'complete', statement: goal }],
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'recursive-delivery-'))
  const medium = new FakePersistence()
  const domain = await loadDomain(fileURLToPath(new URL('../../domain/reference', import.meta.url)), spawnProcess)
  let apparatus = await openApparatus(
    'recursive',
    directory,
    domain,
    medium as never,
    attachmentsAt(directory),
    testProjections,
  )
  cleanups.push(async () => {
    await apparatus.store.close()
    await rm(directory, { recursive: true, force: true })
  })
  const rootAgent = agentFor('root', 'root')
  const root = await propose(apparatus, callerOf(rootAgent), 'start', {
    contract: contract('Deliver the complete integrated package'),
    learning: false,
  })
  const node = (taskId: string) => {
    const task = taskStateOf(apparatus, taskId)
    declareCaller(apparatus, task.responsibility!.agentId)
    const agent = agentFor(task.responsibility!.agentId, task.responsibility!.agentId)
    return { agent, caller: callerOf(agent), task, run: Object.values(task.runs).at(-1)! }
  }
  const send = async (
    taskId: string,
    input: Omit<SubmissionInput, 'taskId'> | { path: string } | { sourceTaskId: string; sourceRunId: string },
    verdict: 'pass' | 'fail' = 'pass',
  ) => {
    const current = node(taskId)
    return submit(
      apparatus,
      fakeExecution(() => undefined),
      current.caller,
      execFor(current.agent, 'submit-' + current.run.runId),
      { ...input, taskId } as SubmissionInput,
      new AbortController().signal,
      fixtureReview(apparatus, verdict),
    )
  }
  const delegate = async (
    parentId: string,
    children: { key: string; contract: TaskContract; dependsOn?: string[] }[],
  ) => {
    await decompose(apparatus, { advance: async () => [] }, node(parentId).caller, {
      taskId: parentId,
      children: children.map(child => ({
        ...child,
        dependsOn: child.dependsOn ?? [],
        supports: ['complete'],
        maxRuns: 1,
        requirement: 'required' as const,
      })),
    })
    return taskStateOf(apparatus, parentId)
      .decomposition!.children.slice(-children.length)
      .map(edge => edge.taskId)
  }
  const start = async (id: string) => startAttempt(apparatus, node(id).caller, id, 'start-' + id, root.method)
  return {
    root,
    medium,
    node,
    send,
    delegate,
    start,
    get apparatus() {
      return apparatus
    },
    cold: async () => {
      await apparatus.store.close()
      apparatus = await openApparatus(
        'recursive',
        directory,
        domain,
        medium as never,
        attachmentsAt(directory),
        testProjections,
      )
    },
  }
}

it.each([
  [2, Buffer.from('Large text with complete UTF-8 字节\n'.repeat(3000))],
  [3, Buffer.from([0, 255, 128, 13, 10, 0, 192, 254])],
  [3, Buffer.from('Three-level text delivery\n')],
  [2, Buffer.from([255, 0, 127, 200])],
])('delivers sealed bytes through %i levels with separate acceptance and cold recovery', async (depth, bytes) => {
  const h = await setup()
  const chain = [h.root.taskId]
  for (let level = 1; level < depth; level++) {
    const [id] = await h.delegate(chain.at(-1)!, [
      { key: 'part-' + level, contract: contract('Complete narrower responsibility at level ' + level) },
    ])
    await h.start(id!)
    chain.push(id!)
  }
  const leaf = h.node(chain.at(-1)!)
  await writeFile(join(leaf.run.bubble!.workspace.ref, leaf.task.contract!.artifact), bytes)
  await h.send(leaf.task.taskId, { path: leaf.task.contract!.artifact })
  await writeFile(join(leaf.run.bubble!.workspace.ref, leaf.task.contract!.artifact), 'mutated workspace')
  await h.cold()
  for (let level = chain.length - 2; level >= 0; level--) {
    const source = h.node(chain[level + 1]!)
    expect(
      await h.send(chain[level]!, { sourceTaskId: source.task.taskId, sourceRunId: source.run.runId }),
    ).toMatchObject({ phase: 'verified' })
    const parent = h.node(chain[level]!)
    expect(await sealedBytes(h.apparatus, parent.run.submission!.files.artifact)).toEqual(bytes)
  }
  expect(factsOf(h.medium).filter(fact => fact.kind === 'review/started')).toHaveLength(depth)
})

it('combines declared sibling inputs in an integration child, then independently accepts every parent', async () => {
  const h = await setup()
  const [middle] = await h.delegate(h.root.taskId, [
    { key: 'package', contract: contract('Assemble both independently produced byte sequences') },
  ])
  await h.start(middle!)
  const [left, right, integration] = await h.delegate(middle!, [
    { key: 'left', contract: contract('Produce the left byte sequence') },
    { key: 'right', contract: contract('Produce the right byte sequence') },
    {
      key: 'integrate',
      dependsOn: ['left', 'right'],
      contract: contract('Concatenate left then right', [
        { name: 'left.bin', source: { kind: 'artifact', taskId: 'left' } },
        { name: 'right.bin', source: { kind: 'artifact', taskId: 'right' } },
      ]),
    },
  ])
  expect(waitingReason(h.apparatus, middle!)).toBeDefined()
  for (const [id, content] of [
    [left!, Buffer.from([0, 255])],
    [right!, Buffer.from([200, 1])],
  ] as const) {
    const run = await h.start(id)
    await writeFile(join(run.bubble!.workspace.ref, 'result.bin'), content)
    await h.send(id, { path: 'result.bin' })
  }
  const combined = await h.start(integration!)
  const workspace = combined.bubble!.workspace.ref
  await writeFile(
    join(workspace, 'result.bin'),
    Buffer.concat(await Promise.all(['left.bin', 'right.bin'].map(name => readFile(join(workspace, name))))),
  )
  await h.send(integration!, { path: 'result.bin' })
  expect(await h.send(middle!, { sourceTaskId: integration!, sourceRunId: combined.runId })).toMatchObject({
    phase: 'verified',
  })
  expect(await h.send(h.root.taskId, { sourceTaskId: middle!, sourceRunId: h.node(middle!).run.runId })).toMatchObject({
    phase: 'verified',
  })
  expect(await sealedBytes(h.apparatus, h.node(h.root.taskId).run.submission!.files.artifact)).toEqual(
    Buffer.from([0, 255, 200, 1]),
  )
  expect(factsOf(h.medium).filter(fact => fact.kind === 'review/started')).toHaveLength(5)
})

it('rejects wrong, unverified and non-direct sources without writes, and never inherits child acceptance', async () => {
  const h = await setup()
  const [middle] = await h.delegate(h.root.taskId, [
    { key: 'middle', contract: contract('Complete a narrower package') },
  ])
  await h.start(middle!)
  const [leaf] = await h.delegate(middle!, [{ key: 'leaf', contract: contract('Produce candidate evidence') }])
  const leafRun = await h.start(leaf!)
  const before = factsOf(h.medium)
  await expect(h.send(middle!, { sourceTaskId: leaf!, sourceRunId: leafRun.runId })).rejects.toThrow('exact verified')
  await expect(h.send(middle!, { sourceTaskId: leaf!, sourceRunId: 'wrong-run' })).rejects.toThrow('exact verified')
  await expect(h.send(h.root.taskId, { sourceTaskId: leaf!, sourceRunId: leafRun.runId })).rejects.toThrow(
    'direct child',
  )
  expect(factsOf(h.medium)).toEqual(before)
  await writeFile(join(leafRun.bubble!.workspace.ref, 'result.bin'), 'evidence')
  await h.send(leaf!, { path: 'result.bin' })
  expect(await h.send(middle!, { sourceTaskId: leaf!, sourceRunId: leafRun.runId }, 'fail')).toMatchObject({
    verdict: 'fail',
    phase: 'failed',
  })
  expect(h.node(leaf!).run.status).toBe('verified')
})

it('keeps atomic execution available and rejects repeated ancestor responsibilities', async () => {
  const h = await setup()
  const [middle] = await h.delegate(h.root.taskId, [
    { key: 'atomic', contract: contract('Produce one bounded answer') },
  ])
  await h.start(middle!)
  expect(coordinationOf(h.apparatus, middle!).responsibility).toMatchObject({
    canExecute: true,
    remaining: { assessAtomicity: true },
  })
  await expect(h.delegate(middle!, [{ key: 'copy', contract: h.node(middle!).task.contract! }])).rejects.toThrow(
    'ancestor responsibility',
  )
  await writeFile(join(h.node(middle!).run.bubble!.workspace.ref, 'result.bin'), 'done')
  expect(await h.send(middle!, { path: 'result.bin' })).toMatchObject({ phase: 'verified' })
  expect(h.node(middle!).task.decomposition).toBeUndefined()
})
