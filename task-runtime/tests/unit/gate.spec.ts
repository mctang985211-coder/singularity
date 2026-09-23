import { describe, expect, test } from 'vitest'
import { COORDINATION_ALLOWED, DRAIN_KILL_REASON, ExecutionGate } from '../../src/gate.ts'
import type { JobsView, JobsViewEntry } from '../../src/gate.ts'

/**
 * The coordination gate as a state machine: what a session's phase lets through,
 * and what the drain reports when the session's work does not stop. Nothing here
 * touches a store or a service — the jobs service is a fake whose calls are
 * recorded, because the question these tests answer is "what does the gate
 * believe it confirmed", not "does DSH's job registry work".
 */

/** The contract's allow-list, written out once so an accidental addition to the module is a failure here. */
const CONTRACT_ALLOWED = [
  'ask_user_question',
  'capability_list',
  'glob',
  'grep',
  'hitl_approve',
  'hitl_ask',
  'read',
  'read_image',
  'session_event_read',
  'session_search',
  'session_trace',
  'skill',
  'task_cancel',
  'task_diagnose',
  'task_proposal_cancel',
  'task_proposal_read',
  'task_read',
  'task_review_pack',
  'task_status',
  'web_fetch',
]

/** Tools the protocol closes in every non-active phase; the samples name their category. */
const WRITE_TOOLS = ['write', 'edit', 'bash', 'job_list', 'job_kill', 'graph_spawn', 'evolution_apply', 'subagent_spawn', 'task_decompose', 'task_submit_result', 'task_verify', 'task_proposal_continue']

interface FakeJob {
  id: string
  status: string
  detail?: string
}

interface JobsBehaviour {
  listThrows?: string
  killThrows?: string
  waitThrows?: string
  /** The status a job reports after a kill — the producer's own transition, e.g. `killed` or a `stopping` that has not finished. */
  settleOnKill?: Record<string, string>
}

/** A jobs service whose listing never settles the jobs on its own unless a test changes the map. */
function fakeJobs(initial: FakeJob[], behaviour: JobsBehaviour = {}) {
  const statuses = new Map(initial.map(job => [job.id, job.status]))
  const killed: { id: string; agent: unknown; reason: string | undefined }[] = []
  const waited: { id: string; timeoutMs: number }[] = []
  const service: JobsView = {
    list(agent?: unknown): readonly JobsViewEntry[] {
      if (behaviour.listThrows !== undefined) throw new Error(behaviour.listThrows)
      void agent
      return initial.map(job => ({ id: job.id, status: statuses.get(job.id) as string, ...(job.detail === undefined ? {} : { detail: job.detail }) }))
    },
    kill(id: string, agent?: unknown, reason?: string): unknown {
      if (behaviour.killThrows !== undefined) throw new Error(behaviour.killThrows)
      killed.push({ id, agent, reason })
      const settled = behaviour.settleOnKill?.[id]
      if (settled !== undefined) statuses.set(id, settled)
      return 'requested'
    },
    async wait(id: string, timeoutMs: number): Promise<{ status: string; detail?: string }> {
      if (behaviour.waitThrows !== undefined) throw new Error(behaviour.waitThrows)
      waited.push({ id, timeoutMs })
      return { status: statuses.get(id) as string }
    },
  }
  return { service, killed, waited }
}

describe('COORDINATION_ALLOWED', () => {
  test('is exactly the coordination list the protocol names', () => {
    expect([...COORDINATION_ALLOWED].sort()).toEqual(CONTRACT_ALLOWED)
  })

  test('classifies the T2/T3 proposal tools with their task-domain siblings', () => {
    // The classification is the contract: reading a proposal and withdrawing
    // one's own batch are the looking-at and the ending of what this run asked
    // for; continuing one can admit a batch, so it is a write exactly as
    // `task_decompose` is.
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'waiting_children')
    expect(gate.decide('s-1', 'task_proposal_read')).toEqual({ allow: true })
    expect(gate.decide('s-1', 'task_proposal_cancel')).toEqual({ allow: true })
    const denied = gate.decide('s-1', 'task_proposal_continue')
    expect(denied.allow).toBe(false)
    if (denied.allow) throw new Error('unreachable')
    expect(denied.reason).toContain('"task_proposal_continue" is denied')

    // A waiting proposal is drained like any other write: a continuation in
    // flight is work the phase change has to wait for.
    expect(gate.inFlightWrites('s-1')).toEqual([])
    gate.trackAllowed('s-1', 'c-1', 'task_proposal_continue')
    gate.trackAllowed('s-1', 'c-2', 'task_proposal_read')
    expect(gate.inFlightWrites('s-1')).toEqual([{ callId: 'c-1', name: 'task_proposal_continue' }])
  })

  test('classifies the root intake as the write it is, by leaving it out of the list', () => {
    // `task_intake` (A0 §1.9, stage C) writes a proposal and can activate a root
    // task, so it is a write — and a write is exactly what *not* being in this
    // table means: the default decision for a non-active phase is a refusal, and
    // adding the name here would be the only way to open the gate for it. The
    // classification needs no rule of its own; the assertion is that no future
    // edit puts it in by accident.
    expect(COORDINATION_ALLOWED.has('task_intake')).toBe(false)
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'waiting_children')
    const denied = gate.decide('s-1', 'task_intake')
    expect(denied.allow).toBe(false)
    if (denied.allow) throw new Error('unreachable')
    expect(denied.reason).toContain('"task_intake" is denied')
    // A late intake on a terminal root is refused the same way, and names itself
    // as the late call it is (§1.8).
    gate.setTerminal('s-1')
    const late = gate.decide('s-1', 'task_intake')
    expect(late.allow).toBe(false)
    if (late.allow) throw new Error('unreachable')
    expect(late.reason).toContain('late call')
    expect(gate.decide('s-1', 'task_read')).toEqual({ allow: true })
  })
})

describe('ExecutionGate.decide', () => {
  test('a session with no phase is not gated at all', () => {
    const gate = new ExecutionGate()
    expect(gate.phaseOf('s-1')).toBeUndefined()
    for (const tool of [...WRITE_TOOLS, ...CONTRACT_ALLOWED]) expect(gate.decide('s-1', tool)).toEqual({ allow: true })
  })

  test('an active run is still deciding its own work, so everything passes', () => {
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'active')
    for (const tool of [...WRITE_TOOLS, ...CONTRACT_ALLOWED, 'some_future_tool']) expect(gate.decide('s-1', tool)).toEqual({ allow: true })
  })

  for (const phase of ['waiting_children', 'submitted'] as const) {
    test(`${phase} lets the coordination list through and denies every write by name`, () => {
      const gate = new ExecutionGate()
      gate.setPhase('s-1', phase)
      for (const tool of CONTRACT_ALLOWED) expect(gate.decide('s-1', tool)).toEqual({ allow: true })
      for (const tool of [...WRITE_TOOLS, 'some_future_tool']) {
        const decision = gate.decide('s-1', tool)
        expect(decision.allow).toBe(false)
        if (decision.allow) throw new Error('unreachable')
        expect(decision.reason).toContain(`phase "${phase}"`)
        expect(decision.reason).toContain(`"${tool}" is denied`)
        expect(decision.reason).toContain('task_read')
        expect(decision.reason).not.toContain('late call')
      }
    })
  }

  test('a terminal run denies writes as late calls and still allows the reads', () => {
    const gate = new ExecutionGate()
    gate.setTerminal('s-1')
    expect(gate.phaseOf('s-1')).toBe('terminal')
    expect(gate.decide('s-1', 'task_read')).toEqual({ allow: true })
    expect(gate.decide('s-1', 'task_cancel')).toEqual({ allow: true })
    const decision = gate.decide('s-1', 'bash')
    expect(decision.allow).toBe(false)
    if (decision.allow) throw new Error('unreachable')
    expect(decision.reason).toContain('phase "terminal"')
    expect(decision.reason).toContain('"bash" is denied')
    expect(decision.reason).toContain('This is a late call')
  })
})

describe('in-flight registration', () => {
  test('counts only names outside the allow-list, and settles by call id', () => {
    const gate = new ExecutionGate()
    gate.trackAllowed('s-1', 'c-1', 'bash')
    gate.trackAllowed('s-1', 'c-2', 'read')
    gate.trackAllowed('s-2', 'c-3', 'write')
    expect(gate.inFlightWrites('s-1')).toEqual([{ callId: 'c-1', name: 'bash' }])
    expect(gate.inFlightWrites('s-2')).toEqual([{ callId: 'c-3', name: 'write' }])
    gate.settled('c-1')
    expect(gate.inFlightWrites('s-1')).toEqual([])
    // A denied call never registers, so its result event is a no-op.
    expect(() => gate.settled('never-tracked')).not.toThrow()
  })
})

describe('drainSession', () => {
  test('returns confirmed when nothing is in flight', async () => {
    const gate = new ExecutionGate()
    expect(await gate.drainSession('s-1', { timeoutMs: 20 })).toEqual({ confirmed: true })
  })

  test('an in-flight write that never settles times out, named', async () => {
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'submitted')
    gate.trackAllowed('s-1', 'c-1', 'bash')
    const started = Date.now()
    const result = await gate.drainSession('s-1', { timeoutMs: 30 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(result.confirmed).toBe(false)
    if (result.confirmed) throw new Error('unreachable')
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]).toContain('bash')
    expect(result.pending[0]).toContain('c-1')
  })

  test('settling the write confirms the drain', async () => {
    const gate = new ExecutionGate()
    gate.trackAllowed('s-1', 'c-1', 'write')
    setTimeout(() => gate.settled('c-1'), 20)
    expect(await gate.drainSession('s-1', { timeoutMs: 500 })).toEqual({ confirmed: true })
  })

  test('the coordinating call itself is excluded, so the drain cannot wait for its caller', async () => {
    const gate = new ExecutionGate()
    gate.trackAllowed('s-1', 'c-submit', 'task_submit_result')
    expect(await gate.drainSession('s-1', { timeoutMs: 20, excludeCallId: 'c-submit' })).toEqual({ confirmed: true })
    // Everything else still counts, so the exclusion is not a blanket escape.
    gate.trackAllowed('s-1', 'c-write', 'bash')
    const result = await gate.drainSession('s-1', { timeoutMs: 20, excludeCallId: 'c-submit' })
    expect(result.confirmed).toBe(false)
    if (result.confirmed) throw new Error('unreachable')
    expect(result.pending[0]).toContain('c-write')
  })

  test('kills a live job and confirms it once the wait reports a terminal status', async () => {
    const gate = new ExecutionGate()
    const jobs = fakeJobs([{ id: 'bash-1', status: 'running' }], { settleOnKill: { 'bash-1': 'killed' } })
    const result = await gate.drainSession('s-1', { timeoutMs: 100, jobs: jobs.service, agent: { sessionId: 's-1' } })
    expect(result).toEqual({ confirmed: true })
    expect(jobs.killed).toEqual([{ id: 'bash-1', agent: { sessionId: 's-1' }, reason: DRAIN_KILL_REASON }])
    expect(jobs.waited).toHaveLength(1)
    expect(jobs.waited[0].id).toBe('bash-1')
    expect(jobs.waited[0].timeoutMs).toBeLessThanOrEqual(100)
  })

  test('a job that is still stopping after the kill is unconfirmed and named', async () => {
    const gate = new ExecutionGate()
    const jobs = fakeJobs([{ id: 'bash-2', status: 'running', detail: 'sleep 600' }], { settleOnKill: { 'bash-2': 'stopping' } })
    const result = await gate.drainSession('s-1', { timeoutMs: 100, jobs: jobs.service, agent: 'agent' })
    expect(result.confirmed).toBe(false)
    if (result.confirmed) throw new Error('unreachable')
    expect(result.pending).toHaveLength(1)
    expect(result.pending[0]).toContain('bash-2')
    expect(result.pending[0]).toContain('stopping')
  })

  test('terminal jobs are left alone and do not consume the window', async () => {
    const gate = new ExecutionGate()
    const jobs = fakeJobs([{ id: 'bash-3', status: 'completed' }, { id: 'bash-4', status: 'failed' }, { id: 'bash-5', status: 'killed' }])
    expect(await gate.drainSession('s-1', { timeoutMs: 50, jobs: jobs.service, agent: 'agent' })).toEqual({ confirmed: true })
    expect(jobs.killed).toEqual([])
    expect(jobs.waited).toEqual([])
  })

  test('reports both a hanging call and a hanging job, each named', async () => {
    const gate = new ExecutionGate()
    gate.trackAllowed('s-1', 'c-1', 'bash')
    const jobs = fakeJobs([{ id: 'bash-6', status: 'running' }], { settleOnKill: { 'bash-6': 'stopping' } })
    const result = await gate.drainSession('s-1', { timeoutMs: 30, jobs: jobs.service, agent: 'agent' })
    expect(result.confirmed).toBe(false)
    if (result.confirmed) throw new Error('unreachable')
    expect(result.pending).toHaveLength(2)
    expect(result.pending.some(line => line.includes('c-1'))).toBe(true)
    expect(result.pending.some(line => line.includes('bash-6'))).toBe(true)
  })

  test('a job that could not be killed is named rather than assumed stopped', async () => {
    const gate = new ExecutionGate()
    const jobs = fakeJobs([{ id: 'bash-7', status: 'running' }], { killThrows: 'foreign job' })
    const result = await gate.drainSession('s-1', { timeoutMs: 50, jobs: jobs.service, agent: 'agent' })
    expect(result.confirmed).toBe(false)
    if (result.confirmed) throw new Error('unreachable')
    expect(result.pending[0]).toContain('bash-7')
    expect(result.pending[0]).toContain('foreign job')
  })

  test('a wait that threw is unconfirmed, not a stop', async () => {
    const gate = new ExecutionGate()
    const jobs = fakeJobs([{ id: 'bash-8', status: 'running' }], { waitThrows: 'invalid input' })
    const result = await gate.drainSession('s-1', { timeoutMs: 50, jobs: jobs.service, agent: 'agent' })
    expect(result.confirmed).toBe(false)
    if (result.confirmed) throw new Error('unreachable')
    expect(result.pending[0]).toContain('invalid input')
  })

  test('a jobs listing that threw is unconfirmed, not "no jobs"', async () => {
    const gate = new ExecutionGate()
    const jobs = fakeJobs([], { listThrows: 'service disposed' })
    const result = await gate.drainSession('s-1', { timeoutMs: 50, jobs: jobs.service, agent: 'agent' })
    expect(result.confirmed).toBe(false)
    if (result.confirmed) throw new Error('unreachable')
    expect(result.pending[0]).toContain('service disposed')
  })

  test('skips the jobs step when the deployment has no service or no agent', async () => {
    const gate = new ExecutionGate()
    const jobs = fakeJobs([{ id: 'bash-9', status: 'running' }])
    expect(await gate.drainSession('s-1', { timeoutMs: 20, jobs: jobs.service })).toEqual({ confirmed: true })
    expect(await gate.drainSession('s-1', { timeoutMs: 20, agent: 'agent' })).toEqual({ confirmed: true })
    expect(jobs.killed).toEqual([])
  })

  test('a job that answers with a non-terminal status is unconfirmed and named', async () => {
    const gate = new ExecutionGate()
    const jobs = fakeJobs([{ id: 'bash-10', status: 'running' }])
    // The wait resolves in time, but the status is not terminal: an answer from
    // the service is not the same as a stopped job.
    const result = await gate.drainSession('s-1', { timeoutMs: 40, jobs: jobs.service, agent: 'agent' })
    expect(result.confirmed).toBe(false)
    if (result.confirmed) throw new Error('unreachable')
    expect(result.pending[0]).toContain('bash-10')
    expect(result.pending[0]).toContain('running')
  })
})
