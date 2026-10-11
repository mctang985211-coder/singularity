/**
 * Scheduling: which sub-tasks get a child session, in what order, and what that session is told.
 *
 * The opener is a port, so these cases drive `createScheduler` with a fake that records what it was
 * asked to open. That is the only way to assert this without a model: the real opener builds a DSH child
 * agent and runs a turn, and a turn's content is the model's, not this module's. What belongs to this
 * module is *when* a session is opened and *what* it is told, and both are exact here.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChildSession, ChildSessionRequest } from '../../src/runtime/child-session.ts'
import { asyncRefusalOf } from '../../tests/fixtures.ts'
import { loadDomain } from '../src/domain.ts'
import { declareCaller, openApparatus } from '../src/apparatus.ts'
import { createScheduler } from '../src/scheduler.ts'
import { spawnProcess } from '../src/submission.ts'
import { FakePersistence, agentFor } from './seam.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A child-session port that records instead of opening: one instruction per request, captured. */
function recorder() {
  const opened: { agentId: string; cwd: string; instruction: string }[] = []
  const open = async (request: ChildSessionRequest): Promise<ChildSession> => {
    const record = { agentId: request.agentId, cwd: request.cwd, instruction: '' }
    opened.push(record)
    return {
      agentId: request.agentId,
      sessionId: `singularity:agent:${request.agentId}`,
      resumed: false,
      agent: {} as never,
      // The instruction is delivered here, not in the request: delivery is what starts a turn, and a
      // turn starts after `open` has resolved.
      say: async text => {
        record.instruction = text
      },
      stop: () => undefined,
    }
  }
  return { opened, open }
}

/**
 * One apparatus whose plan the cases build through the real commands.
 *
 * The children are admitted for every case: `ready` means the plan's child has a contract, so a case that
 * wanted a `missing` child would be testing the tree's projection rather than this module.
 */
async function apparatusWith(children: readonly { taskId: string; dependsOn: readonly string[]; supports: readonly string[]; maxRuns: number }[]) {
  root = await mkdtemp(join(tmpdir(), 'assembly-scheduler-'))
  const domain = await loadDomain(REAL, spawnProcess)
  const apparatus = await openApparatus('lib-1', root, domain, new FakePersistence() as never)
  const contractOf = (goal: string) => ({ goal, inputs: [domain.inputs[0]!.path], criteria: [domain.criterion] })
  // The agent is bound the way the assembly binds a caller: a key in the store's trusted table, and a node
  // naming the session that backs it. `assign` reads both, so an unbound agent is refused, not invented.
  declareCaller(apparatus, 'agent-1')
  await apparatus.agents.open({ commandId: 'agent:agent-1', agentId: 'agent-1', sessionId: 'session-1', role: 'root' })
  await apparatus.tasks.admit({ commandId: 'admit-parent', taskId: 'task-parent', contract: contractOf('report the count') })
  await apparatus.tasks.assign({ commandId: 'assign-parent', taskId: 'task-parent', agentId: 'agent-1' })
  for (const child of children) await apparatus.tasks.admit({ commandId: `admit-${child.taskId}`, taskId: child.taskId, contract: contractOf(`do ${child.taskId}`) })
  // The plan is the holder's act (`task/decomposed` requires it), so it is written through the holder's own
  // bound surface — the same way the driver writes one on a model's behalf.
  await apparatus.tasks.forAgent('agent-1').decompose({ commandId: 'plan', parentTaskId: 'task-parent', children })
  return apparatus
}

describe('which sub-tasks get a session', () => {
  it('opens exactly the ready one, and hands it its own goal, workspace and criterion', async () => {
    const apparatus = await apparatusWith([
      { taskId: 'child-a', dependsOn: [], supports: ['letters'], maxRuns: 1 },
      { taskId: 'child-b', dependsOn: ['child-a'], supports: ['letters'], maxRuns: 1 },
    ])
    const { opened, open } = recorder()
    const scheduler = createScheduler(apparatus, {} as never, open)

    // a is ready and b waits on it, so exactly one session exists after one advance.
    const asked = await scheduler.advance(agentFor('agent-1', 'session-1'))
    expect(asked).toEqual(['child-a'])
    expect(opened).toHaveLength(1)
    // The instruction is the contract's, not a literal in this module: it names the sub-task's own goal,
    // its own workspace, and the criterion the deployment declared.
    const instruction = opened[0]!.instruction
    expect([instruction.includes('child-a'), instruction.includes('do child-a'), instruction.includes('letters'), instruction.includes(opened[0]!.cwd)]).toEqual([true, true, true, true])
  })

  it('does not open a second session for a sub-task that already has one', async () => {
    const apparatus = await apparatusWith([{ taskId: 'child-a', dependsOn: [], supports: ['letters'], maxRuns: 1 }])
    const { opened, open } = recorder()
    const scheduler = createScheduler(apparatus, {} as never, open)
    await scheduler.advance(agentFor('agent-1', 'session-1'))
    await scheduler.advance(agentFor('agent-1', 'session-1'))
    // Idempotent by construction: the set of live sessions is the state, so a boot, a reload and a second
    // caller all converge on the sessions that should exist rather than opening a second one each.
    expect(opened).toHaveLength(1)
  })

  it('refuses to advance with no parent agent, by name', async () => {
    const apparatus = await apparatusWith([{ taskId: 'child-a', dependsOn: [], supports: ['letters'], maxRuns: 1 }])
    const scheduler = createScheduler(apparatus, {} as never, recorder().open)
    const refusal = await asyncRefusalOf(() => scheduler.advance(undefined))
    expect(refusal).toMatchObject({ code: 'malformed-declaration', detail: expect.stringContaining('no parent agent') })
  })

  it('leaves a session that could not be instructed out of its own set, so the next advance retries it', async () => {
    const apparatus = await apparatusWith([{ taskId: 'child-a', dependsOn: [], supports: ['letters'], maxRuns: 1 }])
    let attempts = 0
    const open = async (request: ChildSessionRequest): Promise<ChildSession> => {
      attempts += 1
      if (attempts === 1) throw new Error('the child could not be composed')
      return {
        agentId: request.agentId,
        sessionId: `singularity:agent:${request.agentId}`,
        resumed: false,
        agent: {} as never,
        say: async () => undefined,
        stop: () => undefined,
      }
    }
    const scheduler = createScheduler(apparatus, {} as never, open)
    // A child that cannot be started is reported by the scan and does not abort it: the failure is named
    // on stderr, the plan is left alone, and the returned set is what actually opened. That is the rule
    // that keeps a settle from turning one child's bad luck into the model's submission failing.
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk))
      return true
    })
    let first: readonly string[]
    try {
      first = await scheduler.advance(agentFor('agent-1', 'session-1'))
    } finally {
      spy.mockRestore()
    }
    expect([first, written.filter(line => line.includes('could not be started')).length]).toEqual([[], 1])
    // And the failed child is not remembered as a live session — a child whose instruction never landed
    // holds no lease this process can address again — so the next advance tries it again.
    const second = await scheduler.advance(agentFor('agent-1', 'session-1'))
    expect([attempts, second]).toEqual([2, ['child-a']])
  })

  it('re-scans after a settle, and only under a parent it was advanced with', async () => {
    const apparatus = await apparatusWith([
      { taskId: 'child-a', dependsOn: [], supports: ['letters'], maxRuns: 1 },
      { taskId: 'child-b', dependsOn: ['child-a'], supports: ['letters'], maxRuns: 1 },
    ])
    const { opened, open } = recorder()
    const scheduler = createScheduler(apparatus, {} as never, open)
    const parent = agentFor('agent-1', 'session-1')

    // Only `a` is ready, so only `a` opens: the dependency holds and `b` waits.
    expect(await scheduler.advance(parent)).toEqual(['child-a'])
    // Advancing again opens nothing new, and the re-scan after a settle finds no newly ready child while
    // `a` is unverified — the half a naive "advance on any settle" would get wrong, because a dependency
    // is satisfied by a *verified* run and by nothing else.
    expect(await scheduler.advance(parent)).toEqual([])
    expect(await scheduler.settled()).toEqual([])
    expect(opened).toHaveLength(1)
  })

  it('writes the material the sub-task is judged on before it is told the workspace is ready', async () => {
    const apparatus = await apparatusWith([{ taskId: 'child-a', dependsOn: [], supports: ['letters'], maxRuns: 1 }])
    const { opened, open } = recorder()
    const scheduler = createScheduler(apparatus, {} as never, open)
    await scheduler.advance(agentFor('agent-1', 'session-1'))
    // The instruction says the workspace is prepared, so the bytes must already be there: a child told to
    // work in a directory the deployment has not staged would fail for a reason nobody could see.
    const staged = await readFile(join(opened[0]!.cwd, 'in', 'source.txt'), 'utf8')
    expect(staged).toBe(await readFile(join(REAL, 'samples', 'source.txt'), 'utf8'))
  })
})
