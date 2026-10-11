import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChildSessionRequest, ChildSession } from '../../src/runtime/child-session.ts'
import { agentSessionIdOf } from '../../src/runtime/agent-session.ts'
import { bindCaller, declareCaller, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { createScheduler } from '../src/scheduler.ts'
import { contractFor } from '../src/inputs.ts'
import { loadDomain } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'
import { agentFor, factsOf, FakePersistence } from './seam.ts'

const domainDir = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'assembly-scheduler-'))
  roots.push(root)
  const domain = await loadDomain(domainDir, spawnProcess)
  const medium = new FakePersistence()
  const apparatus = await openApparatus('scheduler', root, domain, medium as never)
  const parent = agentFor('parent', 'parent-session')
  await bindCaller(apparatus, { agentId: parent.id, sessionId: parent.session.id, model: 'test/model' })
  const contract = contractFor(domain, domain.templates.get(domain.rootTemplate)!, 'count letters')
  await apparatus.tasks.admit({ commandId: 'parent-admit', taskId: 'parent-task', contract })
  await apparatus.tasks.assign({ commandId: 'parent-assign', taskId: 'parent-task', agentId: parent.id })
  const childId = String(agentSessionIdOf('child-task'))
  declareCaller(apparatus, childId)
  await apparatus.agents.open({ commandId: 'child-open', agentId: childId, sessionId: childId, role: 'child' })
  await apparatus.tasks.admit({ commandId: 'child-admit', taskId: 'child-task', contract })
  await apparatus.tasks.assign({ commandId: 'child-assign', taskId: 'child-task', agentId: childId })
  await apparatus.tasks.forAgent(parent.id).decompose({ commandId: 'plan', parentTaskId: 'parent-task',
    children: [{ taskId: 'child-task', dependsOn: [], supports: ['letters'], maxRuns: 1 }] })
  return { apparatus, parent, medium, childId }
}
function session(request: ChildSessionRequest, say: ChildSession['say'], stop = () => {}): ChildSession {
  const id = String(agentSessionIdOf(request.agentId))
  return { agentId: request.agentId, sessionId: id, resumed: false, agent: agentFor(id, id), say, stop }
}

describe('child runtime ownership', () => {
  it('starts the complete child Run before delivering its instruction', async () => {
    const { apparatus, parent, medium, childId } = await setup()
    let workspace: string | undefined
    const scheduler = createScheduler(apparatus, {}, async request => session(request, async text => {
      const run = Object.values(taskStateOf(apparatus, 'child-task').runs)[0]!
      expect(run).toMatchObject({ status: 'running', stage: 'working', actor: 'scheduler:agent:' + childId })
      expect(run.bubble?.workspace.ref).toBe(request.cwd)
      expect(text).toContain('count letters')
      workspace = request.cwd
    }))
    expect(await scheduler.advance(parent)).toEqual(['child-task'])
    expect(workspace).toContain('/runs/run-')
    expect(factsOf(medium).filter(fact => fact.kind === 'run/started')).toHaveLength(1)
    await scheduler.close()
  })
  it('returns create failure and records no successful dispatch', async () => {
    const { apparatus, parent } = await setup()
    const scheduler = createScheduler(apparatus, {}, async () => { throw new Error('create failed') })
    await expect(scheduler.advance(parent)).rejects.toThrow('create failed')
    expect(Object.values(taskStateOf(apparatus, 'child-task').runs)[0]).toMatchObject({ status: 'failed' })
  })
  it('returns delivery failure and releases the child handle', async () => {
    const { apparatus, parent } = await setup()
    const scheduler = createScheduler(apparatus, {}, async request => session(request, async () => { throw new Error('deliver failed') }))
    await expect(scheduler.advance(parent)).rejects.toThrow('deliver failed')
    expect(Object.values(taskStateOf(apparatus, 'child-task').runs)[0]).toMatchObject({ status: 'failed' })
    await expect(scheduler.close()).resolves.toBeUndefined()
  })
  it('surfaces close failure to its owner', async () => {
    const { apparatus, parent } = await setup()
    const scheduler = createScheduler(apparatus, {}, async request => session(request, async () => {}, () => { throw new Error('close failed') }))
    await scheduler.advance(parent)
    await expect(scheduler.close()).rejects.toThrow('child unload failed')
  })
  it('rejects an absent parent before opening a child', async () => {
    const { apparatus } = await setup()
    const scheduler = createScheduler(apparatus, {}, async () => { throw new Error('must not open') })
    await expect(scheduler.advance(undefined)).rejects.toThrow('no live parent')
  })
})
