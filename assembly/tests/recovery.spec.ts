/**
 * Recovery: what a mount does with the attempts the last process left in flight, and what closing is
 * allowed to touch. Every case reads the committed log, because that is what a restart continues.
 */

import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { TASK_KINDS } from '../../src/task/protocol.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { loadDomain } from '../src/domain.ts'
import { openDriver } from '../src/driver.ts'
import { spawnProcess } from '../src/submission.ts'
import { agentFor, execFor, factsOf, kindsOf, mount, serviceOf, FakePersistence } from './seam.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const COUNTING = "import { readFileSync } from 'node:fs'\nprocess.stdout.write(String((readFileSync(process.argv[2], 'utf8').match(/[A-Za-z]/g) ?? []).length))\n"
const config = (workspaceRoot: string, domainDir = REAL) => ({ controlId: 'lib-1', domainDir, workspaceRoot })

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A fresh workspace root, kept for the whole case so a second mount rebuilds nothing. */
async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'assembly-recovery-'))
  return root
}

describe('a mount that finds an attempt in flight', () => {
  it('settles a run whose verdict was recorded but whose settlement was lost', async () => {
    const workspaceRoot = await tempRoot()
    const first = await mount(config(workspaceRoot))
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await serviceOf(first.ctx).forCall(execFor(agent, 'call-1')).propose({ goal: 'g', input: 'alpha beta' })
    first.medium.failAppendOf(TASK_KINDS.runVerified)
    const lost = await asyncRefusalOf(() => serviceOf(first.ctx).forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING }))

    const second = await mount(config(workspaceRoot), first.medium)
    const status = await serviceOf(second.ctx).forCall(execFor(agent, 'call-3')).status({ taskId: proposal.taskId })
    expect([lost.code, status.phase, status.receipt?.status]).toEqual(['write-not-durable', 'verified', 'verified'])
  })

  it('settles a run whose frozen artifact is gone, failed by a name', async () => {
    const workspaceRoot = await tempRoot()
    const first = await mount(config(workspaceRoot))
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await serviceOf(first.ctx).forCall(execFor(agent, 'call-1')).propose({ goal: 'g', input: 'alpha beta' })
    first.medium.failAppendOf(TASK_KINDS.evidenceProduced)
    await asyncRefusalOf(() => serviceOf(first.ctx).forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING }))
    await rm(join(proposal.workspace, 'report.txt'))

    const second = await mount(config(workspaceRoot), first.medium)
    const failed = factsOf(second.medium).find(fact => fact.kind === TASK_KINDS.runFailed)
    expect([failed?.actor, (failed?.payload as { reason?: string }).reason?.includes('gone')]).toEqual(['lib-1:agent:agent-7', true])
  })

  it('settles a run whose frozen input changed, failed by a name, and still completes the mount', async () => {
    const workspaceRoot = await tempRoot()
    const first = await mount(config(workspaceRoot))
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await serviceOf(first.ctx).forCall(execFor(agent, 'call-1')).propose({ goal: 'g', input: 'alpha beta' })
    first.medium.failAppendOf(TASK_KINDS.evidenceProduced)
    await asyncRefusalOf(() => serviceOf(first.ctx).forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING }))
    await writeFile(join(proposal.workspace, 'in', 'source.txt'), 'a different input')

    const second = await mount(config(workspaceRoot), first.medium)
    const failed = factsOf(second.medium).find(fact => fact.kind === TASK_KINDS.runFailed)
    const status = await serviceOf(second.ctx).forCall(execFor(agent, 'call-3')).status({ taskId: proposal.taskId })
    expect([(failed?.payload as { reason?: string }).reason?.includes('no longer hashes'), status.phase]).toEqual([true, 'failed'])
  })

  it('settles a run frozen against an input this deployment no longer declares, and still opens', async () => {
    const workspaceRoot = await tempRoot()
    const first = await mount(config(workspaceRoot))
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await serviceOf(first.ctx).forCall(execFor(agent, 'call-1')).propose({ goal: 'g', input: 'alpha beta' })
    first.medium.failAppendOf(TASK_KINDS.evidenceProduced)
    await asyncRefusalOf(() => serviceOf(first.ctx).forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING }))

    // The same deployment, later, declaring a different input: the run it left in flight was frozen
    // against the old declaration and cannot be judged again here.
    const moved = join(workspaceRoot, 'domain-elsewhere')
    await cp(REAL, moved, { recursive: true })
    const declaration = JSON.parse(await readFile(join(moved, 'task.json'), 'utf8'))
    await writeFile(join(moved, 'task.json'), JSON.stringify({ ...declaration, inputs: ['in/elsewhere.txt'] }))

    const second = await mount(config(workspaceRoot, moved), first.medium)
    const failed = factsOf(second.medium).find(fact => fact.kind === TASK_KINDS.runFailed)
    const status = await serviceOf(second.ctx).forCall(execFor(agent, 'call-3')).status({ taskId: proposal.taskId })
    expect([(failed?.payload as { reason?: string }).reason?.includes('no longer declares'), status.phase]).toEqual([true, 'failed'])
  })

  it('leaves a settled task exactly as it found it', async () => {
    const workspaceRoot = await tempRoot()
    const first = await mount(config(workspaceRoot))
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await serviceOf(first.ctx).forCall(execFor(agent, 'call-1')).propose({ goal: 'g', input: 'alpha beta' })
    await serviceOf(first.ctx).forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    const committed = first.medium.events.length
    const second = await mount(config(workspaceRoot), first.medium)
    expect([second.medium.events.length, kindsOf(second.medium).includes(TASK_KINDS.runFailed)]).toEqual([committed, false])
  })
})

describe('closing the driver', () => {
  it('releases the writer only, leaving the workspace and the facts where they are', async () => {
    const workspaceRoot = await tempRoot()
    const medium = new FakePersistence()
    const domain = await loadDomain(REAL, spawnProcess)
    const driver = await openDriver({ controlId: 'lib-1', workspaceRoot, domain, persistence: medium as never })
    const agent = agentFor('agent-7', 'session-9')
    const proposal = await driver.forCall(execFor(agent, 'call-1')).propose({ goal: 'g', input: 'alpha beta' })
    await driver.forCall(execFor(agent, 'call-2')).submit({ taskId: proposal.taskId, program: COUNTING })
    await driver.close()

    const reopened = await openDriver({ controlId: 'lib-1', workspaceRoot, domain, persistence: medium as never })
    const status = await reopened.forCall(execFor(agent, 'call-3')).status({ taskId: proposal.taskId })
    await expect(access(join(proposal.workspace, 'report.txt'))).resolves.toBeUndefined()
    expect([status.phase, status.receipt?.status]).toEqual(['verified', 'verified'])
    await reopened.close()
  })
})
