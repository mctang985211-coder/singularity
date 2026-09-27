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
  'context_read',
  'glob',
  'grep',
  'hitl_approve',
  'hitl_ask',
  'read',
  'read_image',
  'skill',
  'task_answer',
  'task_ask_parent',
  'task_budget_extend',
  'task_cancel',
  'task_diagnose',
  'task_proposal_cancel',
  'task_proposal_read',
  'task_read',
  'task_review_agent',
  'task_review_pack',
  'task_status',
  'web_fetch',
]

/** Tools the protocol closes in every non-active phase; the samples name their category. */
const WRITE_TOOLS = ['write', 'edit', 'bash', 'job_list', 'job_kill', 'graph_spawn', 'evolution_apply', 'subagent_spawn', 'task_decompose', 'task_submit_result', 'task_verify', 'task_proposal_continue']

/** The two question tools, named on their own so the rows about them read as what they are (A4 §F.1). */
const QUESTION_TOOLS = ['task_ask_parent', 'task_answer']

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

  test('classifies the review agent with the reads it concludes from, not with the budget that stopped the tree', () => {
    // K4: the review chain reads one task's facts, publishes one read-only
    // reviewer and records its judgement as a Diagnosis — the same category
    // `task_review_pack` and `task_diagnose` are in, one step further along. The
    // bound on a review is the reviewer's own per-store allowance and watchdog
    // (the tool's, `review-agent-ledger`), never the business budget that left
    // the tree terminal — so the classification has to hold in exactly the
    // phases a stopped tree's own session is in.
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'waiting_children')
    expect(gate.decide('s-1', 'task_review_agent')).toEqual({ allow: true })
    gate.setPhase('s-1', 'submitted')
    expect(gate.decide('s-1', 'task_review_agent')).toEqual({ allow: true })
    gate.setTerminal('s-1')
    expect(gate.decide('s-1', 'task_review_agent')).toEqual({ allow: true })

    // The entries around it stay where the contract put them: work is still a
    // late call in the same phase, and the review is not work the drain waits
    // for (its reviewer writes nothing to the checkout).
    const write = gate.decide('s-1', 'task_decompose')
    expect(write.allow).toBe(false)
    if (write.allow) throw new Error('unreachable')
    expect(write.reason).toContain('late call')
    gate.trackAllowed('s-1', 'c-1', 'task_review_agent')
    gate.trackAllowed('s-1', 'c-2', 'task_decompose')
    expect(gate.inFlightWrites('s-1')).toEqual([{ callId: 'c-2', name: 'task_decompose' }])
  })

  test('admits the budget raise a person approved in every phase, and never the work it does not do', () => {
    // K4: the one entry in this list that appends a store fact. It is coordination
    // because of what it is not — the committing entry starts no run, resumes
    // none, re-opens no task and touches no checkout — and because the caller is
    // the root coordination session of a tree that may already have stopped: a
    // spent tree is exactly the tree whose owner has to be able to ask for more
    // ("终态亦可调用"). The fact itself is the person's, refused by the runtime
    // when the channel's reference is empty.
    const gate = new ExecutionGate()
    for (const phase of ['active', 'waiting_children', 'submitted'] as const) {
      gate.setPhase('s-1', phase)
      expect(gate.decide('s-1', 'task_budget_extend'), phase).toEqual({ allow: true })
    }
    gate.setTerminal('s-1')
    expect(gate.decide('s-1', 'task_budget_extend')).toEqual({ allow: true })

    // The same phases still close work, and the question block does not lift a
    // write: the entry is a narrow door, not an open gate.
    gate.setQuestionsBlocked('s-1', true)
    expect(gate.decide('s-1', 'task_decompose').allow).toBe(false)
    expect(gate.decide('s-1', 'task_budget_extend')).toEqual({ allow: true })
    // Nor is it a write the drain waits for: it holds no workspace and settles
    // in one store commit.
    gate.trackAllowed('s-1', 'c-1', 'task_budget_extend')
    gate.trackAllowed('s-1', 'c-2', 'graph_spawn')
    expect(gate.inFlightWrites('s-1')).toEqual([{ callId: 'c-2', name: 'graph_spawn' }])
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

describe('the question block (A4 §F.1)', () => {
  test('denies the writes an active run would otherwise be free to make, and says why', () => {
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'active')
    gate.setQuestionsBlocked('s-1', true)
    expect(gate.questionsBlocked('s-1')).toBe(true)
    for (const tool of QUESTION_TOOLS) expect(gate.decide('s-1', tool)).toEqual({ allow: true })
    expect(gate.decide('s-1', 'task_read')).toEqual({ allow: true })
    expect(gate.decide('s-1', 'context_read')).toEqual({ allow: true })
    for (const tool of ['write', 'bash', 'graph_spawn', 'task_decompose', 'task_submit_result', 'task_proposal_continue']) {
      const decision = gate.decide('s-1', tool)
      expect(decision.allow).toBe(false)
      if (decision.allow) throw new Error('unreachable')
      // The phase is still `active`, so the reason must not claim a phase closed
      // anything — it names the question, and it says an answer is what ends it.
      expect(decision.reason).toContain('waiting on an unresolved blocking question')
      expect(decision.reason).toContain('phase is "active"')
      expect(decision.reason).toContain(`"${tool}" is denied`)
      expect(decision.reason).not.toContain('produce effects are closed')
      expect(decision.reason).not.toContain('late call')
    }
    // Releasing the block restores exactly the phase's own rule and nothing more.
    gate.setQuestionsBlocked('s-1', false)
    expect(gate.questionsBlocked('s-1')).toBe(false)
    for (const tool of [...WRITE_TOOLS, 'some_future_tool']) expect(gate.decide('s-1', tool)).toEqual({ allow: true })
  })

  test('never opens a gate: a blocked waiting_children parent answers and still cannot write', () => {
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'waiting_children')
    gate.setQuestionsBlocked('s-1', true)
    expect(gate.decide('s-1', 'task_answer')).toEqual({ allow: true })
    for (const tool of ['write', 'bash', 'task_decompose', 'task_submit_result']) {
      expect(gate.decide('s-1', tool).allow).toBe(false)
    }
    // Every blocking question answered: the phase rule is what remains, and it
    // still denies the writes — an answer never turns a waiting parent back into
    // an active one.
    gate.setQuestionsBlocked('s-1', false)
    for (const tool of ['write', 'bash', 'task_decompose']) expect(gate.decide('s-1', tool).allow).toBe(false)
    expect(gate.decide('s-1', 'task_read')).toEqual({ allow: true })
  })

  test('a phase change keeps the question block: the batch end hands back active, never a licence to write', () => {
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'waiting_children')
    gate.setQuestionsBlocked('s-1', true)

    // The batch ended: the run is active again (K1 §2) and its own question is
    // still unresolved. `active` is the *phase* the handback gives back; the
    // block is a separate fact about the run, and the phase writer never moves
    // it in either direction.
    gate.setPhase('s-1', 'active')
    expect(gate.phaseOf('s-1')).toBe('active')
    expect(gate.questionsBlocked('s-1')).toBe(true)
    const denied = gate.decide('s-1', 'write')
    expect(denied.allow).toBe(false)
    expect(denied.allow === false ? denied.reason : '').toContain('waiting on an unresolved blocking question')
    expect(denied.allow === false ? denied.reason : '').toContain('phase is "active"')

    // A phase that only the store implies keeps it too: only the terminal states
    // clear the flag, because an open question requires both runs to be running.
    const applied = new ExecutionGate()
    applied.setPhase('s-2', 'waiting_children')
    applied.setQuestionsBlocked('s-2', true)
    expect(applied.applyStorePhase('s-2', 'active', applied.decisionToken('s-2'))).toBe(true)
    expect(applied.questionsBlocked('s-2')).toBe(true)

    gate.setQuestionsBlocked('s-1', false)
    for (const tool of ['write', 'task_decompose', 'task_submit_result']) expect(gate.decide('s-1', tool)).toEqual({ allow: true })
  })

  test('a session with no phase is not gated by a block either (the gate handles runs, not sessions in the abstract)', () => {
    const gate = new ExecutionGate()
    gate.setQuestionsBlocked('s-1', true)
    expect(gate.decide('s-1', 'write')).toEqual({ allow: true })
  })

  test('a terminal run is blocked by nothing, and the terminal writers clear the flag', () => {
    const gate = new ExecutionGate()
    gate.setPhase('s-1', 'active')
    gate.setQuestionsBlocked('s-1', true)
    gate.setTerminal('s-1')
    expect(gate.questionsBlocked('s-1')).toBe(false)
    const late = gate.decide('s-1', 'bash')
    expect(late.allow).toBe(false)
    if (late.allow) throw new Error('unreachable')
    expect(late.reason).toContain('This is a late call')
    expect(late.reason).not.toContain('blocking question')

    const applied = new ExecutionGate()
    applied.setQuestionsBlocked('s-2', true)
    expect(applied.applyStorePhase('s-2', 'terminal', applied.decisionToken('s-2'))).toBe(true)
    expect(applied.questionsBlocked('s-2')).toBe(false)
  })

  test('a store-derived block respects the decision token, exactly as a store-derived phase does', () => {
    const gate = new ExecutionGate()
    // The read starts here (the token the recovery pass takes before reading)...
    const token = gate.decisionToken('s-1')
    gate.setPhase('s-1', 'active')
    // ...and the ask this process committed lands while it is in flight, so the
    // stale snapshot's "not blocked" may not lift a block this process wrote.
    gate.setQuestionsBlocked('s-1', true)
    expect(gate.applyStoreQuestionsBlocked('s-1', false, token)).toBe(false)
    expect(gate.questionsBlocked('s-1')).toBe(true)
    // A read taken after the decision is current again, and applies.
    expect(gate.applyStoreQuestionsBlocked('s-1', false, gate.decisionToken('s-1'))).toBe(true)
    expect(gate.questionsBlocked('s-1')).toBe(false)
    // A store-derived block is not a decision of its own: the two decisions
    // above (the phase and the ask) are the whole count.
    expect(gate.decisionToken('s-1')).toBe(2)
  })
})

describe('ExecutionGate.applyStorePhase', () => {
  test('applies a store-derived phase read under a current token', () => {
    const gate = new ExecutionGate()
    // A session this process has never decided has the token zero, and the phase
    // the store implies is what the session is gated as (a rebound session: the
    // gate is a handle on its run's phase, and the phase is the store's fact).
    expect(gate.decisionToken('s-1')).toBe(0)
    expect(gate.applyStorePhase('s-1', 'waiting_children', 0)).toBe(true)
    expect(gate.phaseOf('s-1')).toBe('waiting_children')
    // Applying a store-derived value is not a decision: the token still says
    // zero, so a later store-derived value read under the same token applies too.
    expect(gate.decisionToken('s-1')).toBe(0)
    expect(gate.applyStorePhase('s-1', 'submitted', 0)).toBe(true)
    expect(gate.phaseOf('s-1')).toBe('submitted')
    expect(gate.applyStorePhase('s-1', 'terminal', 0)).toBe(true)
    expect(gate.phaseOf('s-1')).toBe('terminal')
  })

  test('a decision bumps the token, and a value read before it is dropped', () => {
    const gate = new ExecutionGate()
    // The read starts here (the token a query takes before reading the store)...
    const token = gate.decisionToken('s-1')
    // ...and a decision lands while it is in flight: the run settled, or an
    // admission was committed, so the gate owns a phase the read does not know.
    gate.setPhase('s-1', 'waiting_children')
    expect(gate.decisionToken('s-1')).toBe(1)
    // The read now returns the record it held before that decision — `active`,
    // the older value — and it may not re-open a gate the decision closed.
    expect(gate.applyStorePhase('s-1', 'active', token)).toBe(false)
    expect(gate.phaseOf('s-1')).toBe('waiting_children')
    // The terminal writer is a decision too, and a store value taken under it
    // cannot lift the closure either.
    const afterDecision = gate.decisionToken('s-1')
    gate.setTerminal('s-1')
    expect(gate.decisionToken('s-1')).toBe(afterDecision + 1)
    expect(gate.applyStorePhase('s-1', 'active', afterDecision)).toBe(false)
    expect(gate.phaseOf('s-1')).toBe('terminal')
    // A read taken *after* the decision is current again: its token matches, so
    // the store's own record still moves the gate when the value is newer.
    expect(gate.applyStorePhase('s-1', 'active', gate.decisionToken('s-1'))).toBe(true)
    expect(gate.phaseOf('s-1')).toBe('active')
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
