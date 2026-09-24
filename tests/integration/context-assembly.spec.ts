import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAW_SESSION_READ_DENIAL } from '../../agent-runtime/src/index.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

/**
 * The assembled request (A2 §D/§9), on a real deployment: the caller's graph
 * domain, the store's records and the deployment's own sections are what a
 * session's model request is assembled from — no spawn, no cache, no second copy
 * of the contract.
 *
 * What each case proves, and why it is the assembled request that proves it:
 *
 * (a) A three-layer real chain — root → child → grandchild — assembled for the
 *     grandchild carries the root's goal and hard constraints, the grandchild's
 *     own complete contract and the handoff the parent wrote; the sibling's
 *     evidence and review are one reference read away, while the related view
 *     pushes only the caller's own relations.
 * (b) Two graphs in one checkout cannot read each other: a store record of
 *     another graph is refused by name, a session of another graph is refused
 *     before its log is touched, and the four raw cross-session readers are
 *     denied at execution however they were mounted.
 * (c) The contract survives a process: a fresh runtime over the same JSONL log
 *     assembles the contract for a session it never spawned, after `adoptRoot`
 *     and with no `spawn` call at all.
 * (d) A replay's briefing is its own objective, never the champion root's.
 * (e) A reviewer reads the delegated contract, marked review-only, once its
 *     ledger row is durable; a reviewer whose ledger cannot be written gets zero
 *     model input.
 * (f) Neither a read nor a repeated assembly is a side effect: the store's event
 *     count, the gate's phase and the deployment's counters are unchanged, and an
 *     unchanged projection assembles byte for byte the same text.
 *
 * Everything but the model provider is the deployment's own code — the real
 * JSONL log, the real `system-prompt/assemble` waterfall, the real stores, the
 * real context read core and the real tool plane — and every assertion reads a
 * durable surface: the assembled sections, the run-context snapshot, a tool's
 * answer, the store's own events.
 */

/** Every stack a case booted, so a failing case cannot leak a workspace. */
const stacks: AssemblyStack[] = []

async function boot(options: Parameters<typeof startAssemblyStack>[0] = {}): Promise<AssemblyStack> {
  const stack = await startAssemblyStack(options)
  stacks.push(stack)
  return stack
}

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await Promise.race([stack.dispose({ remove: stack.dir.includes('singularity-assembly-') }), new Promise(resolve => { setTimeout(resolve, 2_000).unref() })])
  }
  vi.unstubAllEnvs()
})

/** One criterion a command settles. */
const criterion = (command: string, description = `the command ${command} exits 0`) => ({ description, command })

/** The root contract these cases run under (A0 §1.2): a goal, a criterion, and the hard constraints. */
function rootContract(objective: string, constraints: readonly string[] = []) {
  return {
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
    constraints: [...constraints],
  }
}

/**
 * A chain of three layers, driven through the deployment's own entries: the root
 * contract is accepted, the root decomposes into one child, and that child
 * decomposes further into the grandchild whose request the cases assemble.
 */
async function threeLayers(stack: AssemblyStack): Promise<{
  storeId: string
  rootTaskId: string
  rootRunId: string
  childTaskId: string
  grandchildTaskId: string
  grandchildSession: string
}> {
  const rootSession = stack.roots[0]!
  const storeId = stack.storeIdOf(rootSession)
  await stack.seedLog(rootSession, ['ship the release'])
  const root = await stack.runtime.intakeRootContract(storeId, rootSession, rootContract('ship the release', [
    'never rewrite the accepted contract',
    'keep the public API stable',
  ]))
  const batch = await stack.runtime.decomposeAndRun(storeId, root.taskId, root.runId, rootSession, {
    reason: 'split the work',
    children: [{
      objective: 'child: build the bridge',
      acceptanceCriteria: [criterion('true')],
    }],
  } as never)
  const outcomes = await stack.runtime.awaitBatch(storeId, batch.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  const snapshot = await stack.snapshot(storeId)
  const childTask = snapshot.tasks.find(task => task.parentTaskId === root.taskId)!
  const grandchildTask = snapshot.tasks.find(task => task.parentTaskId === childTask.taskId)!
  const grandchildRun = snapshot.runs.find(run => run.taskId === grandchildTask.taskId)!
  return {
    storeId,
    rootTaskId: root.taskId,
    rootRunId: root.runId,
    childTaskId: childTask.taskId,
    grandchildTaskId: grandchildTask.taskId,
    grandchildSession: String(grandchildRun.sessionId),
  }
}

describe('the assembled request of a three-layer chain (A2-1)', () => {
  it('gives the grandchild the root goal and hard constraints, its own contract, and the handoff — while the sibling\'s evidence stays one reference away', async () => {
    const stack = await boot({
      worker: async sessionId => {
        // The middle layer is the one that decomposes further: its own turn asks
        // the deployment for the grandchild, exactly as a live worker would.
        const bound = await stack.runtime.runForSession(sessionId).catch(() => undefined)
        if (bound === undefined || bound.task.depth !== 1) return
        await stack.call(sessionId, 'task_decompose', {
          reason: 'the deck is a separate deliverable',
          children: [{ objective: 'grandchild: build the deck', acceptanceCriteria: [criterion('true')] }],
        })
      },
    })
    const chain = await threeLayers(stack)

    const prompt = await stack.prompt(chain.grandchildSession)
    // The root briefing: the accepted goal and the constraints its contract carries.
    expect(prompt).toContain('## Root objective and hard constraints')
    expect(prompt).toContain('ship the release')
    expect(prompt).toContain('never rewrite the accepted contract')
    expect(prompt).toContain('keep the public API stable')
    // The caller's own complete contract, criterion and command included.
    expect(prompt).toContain(`task ${chain.grandchildTaskId}`)
    expect(prompt).toContain('objective: grandchild: build the deck')
    expect(prompt).toContain('$ true')
    // The handoff the parent wrote for it: the delegation reason.
    expect(prompt).toContain('## Handoff')
    expect(prompt).toContain('reason for delegation: the deck is a separate deliverable')
    // One copy, and the section is the contract's own: the projection's header
    // appears exactly once however often the request is assembled.
    expect(prompt.split('# Immutable context (contract)')).toHaveLength(2)
    // The dynamic half rides the runtime-context plane, not the sections: the run
    // state is the snapshot's business, and the contract is not duplicated there.
    const snapshot = await stack.contextSnapshot(chain.grandchildSession)
    expect(snapshot).toContain('role: worker')
    expect(snapshot).toContain('gate phase:')
    expect(snapshot).not.toContain('## Handoff')

    // The dependency's records are readable by reference inside the same domain —
    // the evidence the sibling produced and the review that settled it.
    const state = await stack.snapshot(chain.storeId)
    const evidence = state.evidence.find(item => item.taskId === chain.childTaskId)!
    const review = state.reviews.find(item => item.taskId === chain.childTaskId)!
    const readEvidence = await stack.call(chain.grandchildSession, 'context_read', { kind: 'evidence', ref: evidence.evidenceId })
    expect(readEvidence.isError).toBe(false)
    expect(readEvidence.text).toContain(`evidence ${evidence.evidenceId}`)
    const readReview = await stack.call(chain.grandchildSession, 'context_read', {
      kind: 'review',
      ref: { taskId: chain.childTaskId, runId: review.runId },
    })
    expect(readReview.isError).toBe(false)
    expect(readReview.text).toContain(`review of task ${chain.childTaskId}`)

    // The default view pushes only the caller's own relations; the whole graph is
    // an explicit scope, and the unrelated objective is never in the default view.
    const related = await stack.call(chain.grandchildSession, 'task_status', {})
    expect(related.isError).toBe(false)
    expect(related.text).toContain(`- ${chain.grandchildTaskId}`)
    expect(related.text).toContain('entries in scope: 1')
    expect(related.text).not.toContain('ship the release')
    const graph = await stack.call(chain.grandchildSession, 'task_status', { scope: 'graph' })
    expect(graph.text).toContain('ship the release')
    expect(graph.text).toContain('entries in scope: 3')
  })
})

describe('two graphs in one checkout (A2-2)', () => {
  it('refuses another graph\'s records by name, refuses its sessions before the log, and seals the raw readers at execution', async () => {
    const stack = await boot({
      graphs: [
        { id: 'g1', rootSessionId: 's-root' },
        { id: 'g2', rootSessionId: 's-other', members: ['s-other-worker'] },
      ],
      worker: async () => {},
    })
    const storeA = stack.storeIdOf('s-root')
    const storeB = stack.storeIdOf('s-other')
    await stack.seedLog('s-root', ['ship the release'])
    const rootA = await stack.runtime.intakeRootContract(storeA, 's-root', rootContract('ship the release'))
    // The other graph's tree is seeded through the store's own entries: this case
    // is about the read domain, and one checkout has one writer — the deployment's
    // own workspace rule, which two live root trees in one directory would hit
    // before either read is attempted.
    await stack.task.createStore(storeB)
    await stack.task.createTaskIn(storeB, {
      taskId: 't-other',
      definitionRef: { taskType: 'subtask', version: 1 },
      objective: 'the other graph work',
      depth: 0,
      acceptanceCriteria: [{ criterionId: 'ac-other', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 's-other-worker')
    await stack.task.admitTaskIn(storeB, 't-other', 's-other-worker', { decompositionStatus: 'leaf' })
    await stack.task.startRunIn(storeB, {
      runId: 'r-other',
      taskId: 't-other',
      sessionId: 's-other-worker',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      executionPhase: 'active',
      startedAt: new Date().toISOString(),
    }, 's-other-worker')
    expect(storeA).not.toBe(storeB)

    // A record that lives in the other graph's store is not this caller's record:
    // the reference never widens the domain, and the refusal names the store.
    const foreignTask = await stack.call('s-root', 'context_read', { kind: 'task', ref: 't-other' })
    expect(foreignTask.isError).toBe(false)
    expect(foreignTask.text).toContain('not-found')
    expect(foreignTask.text).toContain('ids from another graph are not readable here')
    const foreignRun = await stack.call('s-other-worker', 'context_read', { kind: 'run', ref: rootA.runId })
    expect(foreignRun.text).toContain('not-found')

    // A session of the other graph is refused as cross-graph, before DSH is asked
    // anything about its log: membership is the graph store's own record.
    const foreignSession = await stack.call('s-root', 'context_read', { kind: 'session', ref: 's-other-worker' })
    expect(foreignSession.text).toContain('cross-graph')
    // Its own graph's session is readable.
    const ownSession = await stack.call('s-root', 'context_read', { kind: 'session', ref: 's-root' })
    expect(ownSession.isError).toBe(false)
    expect(ownSession.text).toContain('ship the release')

    // The four raw cross-session readers are mounted on this deployment's global
    // plane — and denied at execution for every Singularity agent.
    const agent = stack.root('s-root')
    for (const name of ['session_event_read', 'session_event_trace', 'session_trace', 'session_search']) {
      const denied = await stack.call('s-root', name)
      expect(denied.isError, name).toBe(true)
      expect(denied.text).toContain(RAW_SESSION_READ_DENIAL)
    }
    expect(stack.executed()).toEqual([])

    // A mount arriving after the spawn cannot lift it: the name is registered
    // again on the agent's own scope, and the guard still denies the call.
    const agentCtx = (agent as unknown as { ctx: { tools: { register: (tool: unknown) => void } } }).ctx
    agentCtx.tools.register({
      name: 'session_event_read',
      description: 'a later mount with the same name',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: unknown) => [{ type: 'text', text: value as string }] },
      execute: async () => 'a later mount answered',
    })
    const regranted = await stack.call('s-root', 'session_event_read')
    expect(regranted.isError).toBe(true)
    expect(regranted.text).toContain(RAW_SESSION_READ_DENIAL)
    expect(regranted.text).not.toContain('a later mount answered')
  })
})

describe('a restarted process (A2-3)', () => {
  it('assembles the persisted contract for a session it never spawned, after adoptRoot and with no spawn at all', async () => {
    const first = await boot({
      worker: async sessionId => {
        const bound = await first.runtime.runForSession(sessionId).catch(() => undefined)
        if (bound === undefined || bound.task.depth !== 1) return
        await first.call(sessionId, 'task_decompose', {
          reason: 'the deck is a separate deliverable',
          children: [{ objective: 'grandchild: build the deck', acceptanceCriteria: [criterion('true')] }],
        })
      },
    })
    const chain = await threeLayers(first)
    const members = (await first.snapshot(chain.storeId)).runs.map(run => String(run.sessionId))
    // The process dies: its handles close, the bytes stay.
    await first.crash()
    await first.dispose({ remove: false })

    const second = await boot({
      dir: first.dir,
      graphs: [{ id: 'g1', rootSessionId: 's-root', members }],
      worker: async () => {},
    })
    // The explicit recovery door, then the assembly of a session this process
    // never spawned: the contract comes from the store, not from a spawn hook.
    await second.runtime.adoptRoot(second.storeIdOf('s-root'), 's-root')
    expect(second.spawns).toEqual([])
    expect(second.agent(chain.grandchildSession)).toBeUndefined()

    const prompt = await second.prompt(chain.grandchildSession)
    expect(prompt).toContain('## Root objective and hard constraints')
    expect(prompt).toContain('ship the release')
    expect(prompt).toContain('## Handoff')
    expect(prompt).toContain('reason for delegation: the deck is a separate deliverable')
    expect(prompt).toContain(`task ${chain.grandchildTaskId}`)
    expect(prompt.split('# Immutable context (contract)')).toHaveLength(2)
  })
})

describe('a replay\'s briefing (A2-3)', () => {
  it('is the replay task\'s own objective, never the champion root\'s', async () => {
    const stack = await boot({ worker: async () => {} })
    const storeId = stack.storeIdOf('s-root')
    await stack.seedLog('s-root', ['ship the release'])
    await stack.runtime.intakeRootContract(storeId, 's-root', rootContract('ship the release'))
    // A champion: a task of its own lineage, one store over from the root.
    await stack.task.createTaskIn(storeId, {
      taskId: 't-champion',
      definitionRef: { taskType: 'root', version: 1 },
      objective: 'champion work',
      depth: 0,
      acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'it holds', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
      requestedCapabilities: [],
      decompositionStatus: 'leaf',
      status: 'created',
      runIds: [],
      childTaskIds: [],
    }, 's-root')
    await stack.task.admitTaskIn(storeId, 't-champion', 's-root', { decompositionStatus: 'leaf' })
    await stack.task.startRunIn(storeId, {
      runId: 'r-champion',
      taskId: 't-champion',
      sessionId: 's-champion',
      capabilitySnapshot: [],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    }, 's-root')
    await stack.task.markRunStatusIn(storeId, 't-champion', 'r-champion', 'verifying', 's-root')
    await stack.task.recordEvidenceIn(storeId, {
      evidenceId: 'e-r-champion',
      taskRunId: 'r-champion',
      taskId: 't-champion',
      artifacts: [],
      verifierResults: [{ criterionId: 'ac1-1', status: 'pass', verifierId: 'fixture-verifier' }],
      claims: [],
      generatedAt: new Date().toISOString(),
    }, 's-root')
    await stack.task.markRunStatusIn(storeId, 't-champion', 'r-champion', 'verified', 's-root')

    await stack.runtime.replayTask(storeId, 't-champion', { lineage: 'evolution-replay:p1' }, 's-root')
    const state = await stack.snapshot(storeId)
    const replayTask = state.tasks.find(task => task.objective.includes('[evolution-replay:p1]'))!
    const replayRun = state.runs.find(run => run.taskId === replayTask.taskId)!
    expect(replayRun.parentRunId).toBe('r-champion')

    const prompt = await stack.prompt(String(replayRun.sessionId))
    expect(prompt).toContain('role: replay')
    expect(prompt).toContain('replay lineage')
    expect(prompt).toContain(replayTask.objective)
    // The champion's own root objective is not this task's briefing.
    expect(prompt).not.toContain('ship the release')
  })
})

describe('a reviewer with no business run (A2-2)', () => {
  /** One store with a task whose review settled `failed` — the escalation signal a reviewer is spawned for. */
  async function failedTask(stack: AssemblyStack, rootSession: string): Promise<{ storeId: string; taskId: string }> {
    const storeId = stack.storeIdOf(rootSession)
    await stack.seedLog(rootSession, ['ship the release'])
    const root = await stack.runtime.intakeRootContract(storeId, rootSession, rootContract('ship the release'))
    const batch = await stack.runtime.decomposeAndRun(storeId, root.taskId, root.runId, rootSession, {
      reason: 'split the work',
      children: [{ objective: 'child that fails', acceptanceCriteria: [criterion('false')] }],
    } as never)
    const outcomes = await stack.runtime.awaitBatch(storeId, batch.batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed'])
    return { storeId, taskId: outcomes[0]!.taskId }
  }

  it('reads the delegated contract, marked review-only, once its ledger row is durable', async () => {
    const stack = await boot({ worker: async () => {} })
    const failed = await failedTask(stack, 's-root')
    const answer = await stack.call('s-root', 'task_review_agent', { taskId: failed.taskId })
    expect(answer.text).not.toContain('spawn failed')
    const reviewer = stack.spawns.at(-1)!
    expect(reviewer.beforePrompt).toBeDefined()

    const prompt = await stack.prompt(String(reviewer.sessionId))
    expect(prompt).toContain('role: reviewer')
    expect(prompt).toContain(`task ${failed.taskId}`)
    expect(prompt).toContain('review-only')
    expect(prompt).toContain('the contract above belongs to the task it was delegated to review')
    // The reviewer's surface is the read-only baseline: `context_read` instead of
    // the raw cross-session readers, and nothing that could decide anything.
    const reviewerAgent = stack.agent(String(reviewer.sessionId))!
    const names = stack.ctx.tools.schemas(reviewerAgent).map(schema => schema.name)
    expect(names).toContain('context_read')
    for (const sealed of ['session_event_read', 'session_event_trace', 'session_trace', 'session_search']) {
      expect(names).not.toContain(sealed)
    }
    for (const forbidden of ['bash', 'write', 'edit', 'graph_spawn', 'task_decompose', 'task_approve']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('spawns no reviewer whose ledger cannot be written: zero model input', async () => {
    const stack = await boot({ worker: async () => {} })
    const failed = await failedTask(stack, 's-root')
    // The ledger's home is a symlink to nothing: reading it answers "no ledger
    // yet" (so the escalation check passes), while writing the delegation the
    // spawn owes before its first request fails.
    symlinkSync(join(stack.dir, 'no-such-ledger-target'), join(stack.dir, 'ledger-link'))
    vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', join(stack.dir, 'ledger-link'))

    const answer = await stack.call('s-root', 'task_review_agent', { taskId: failed.taskId })
    expect(answer.text).toContain('spawn failed')
    expect(answer.text).toContain('ENOENT')
    const reviewer = stack.spawns.at(-1)!
    const sessionId = String(reviewer.sessionId)
    expect(stack.agent(sessionId) === undefined, 'the reviewer is no live agent').toBe(true)
    // Publication happened (the ledger is written after the node is a published
    // member), and the first model input is exactly what never happened: the
    // agent's own queue is empty.
    const followup = (stack.mintedAgent(sessionId) as unknown as { followup: { mock: { calls: unknown[] } } }).followup
    expect(followup.mock.calls.length, 'no model input').toBe(0)
    // The delegation the assembly would read is absent, so the request the
    // deployment never sent also has no contract: the ledger is the authority.
    const unbound = await stack.prompt(sessionId)
    expect(unbound.includes('review-only'), 'no delegation, no review-only contract').toBe(false)
    expect(unbound.includes(failed.taskId), 'and no delegated task either').toBe(false)
    void failed.storeId
  })
})

describe('reads and repeated assemblies are not side effects (A2-4/A2-3)', () => {
  it('changes no store event, no gate phase and no counter, and assembles the same bytes twice', async () => {
    const stack = await boot({ worker: async () => {} })
    const storeId = stack.storeIdOf('s-root')
    await stack.seedLog('s-root', ['ship the release'])
    const root = await stack.runtime.intakeRootContract(storeId, 's-root', rootContract('ship the release'))
    const before = (await stack.events(storeId)).length
    const phaseBefore = stack.runtime.gate.phaseOf('s-root')
    const spawnsBefore = stack.spawns.length

    // A cold read, a hot read, and two assemblies of the root's own request.
    const cold = await stack.call('s-root', 'task_read')
    expect(cold.isError).toBe(false)
    const hot = await stack.call('s-root', 'task_status', {})
    expect(hot.isError).toBe(false)
    expect((await stack.events(storeId)).length).toBe(before)
    expect(stack.runtime.gate.phaseOf('s-root')).toBe(phaseBefore)
    expect(stack.spawns.length).toBe(spawnsBefore)

    const first = await stack.prompt('s-root')
    const second = await stack.prompt('s-root')
    expect(second).toBe(first)
    const firstContext = await stack.contextSnapshot('s-root')
    const secondContext = await stack.contextSnapshot('s-root')
    expect(secondContext).toBe(firstContext)
    // The root's own request carries its contract, and only one copy of it: for a
    // root the projection's heading is the graph root's, not a worker's briefing.
    expect(first).toContain('## Your contract (graph root)')
    expect(first).toContain('objective: ship the release')
    expect(first.split('# Immutable context (contract)')).toHaveLength(2)
    expect((await stack.events(storeId)).length).toBe(before)
    expect(stack.spawns.length).toBe(spawnsBefore)
    expect(stack.executed()).toEqual([])
    expect(root.taskId).toBeDefined()

    // A read that refuses writes nothing either.
    const refused = await stack.call('s-root', 'context_read', { kind: 'task', ref: 't-does-not-exist' })
    expect(refused.text).toContain('not-found')
    expect((await stack.events(storeId)).length).toBe(before)
    expect(stack.spawns.length).toBe(spawnsBefore)
  })

  it('assembles nothing for a session outside the deployment\'s domain, and never for a diagnostic assembly', async () => {
    const stack = await boot({ worker: async () => {} })
    const prompt = await stack.prompt('s-stranger')
    expect(prompt).not.toContain('# Immutable context (contract)')
    const diagnostic = await stack.ctx.systemPrompt.assemble({})
    expect(diagnostic.sections.some(section => section.name === 'singularity:worker-contract')).toBe(false)
    expect(diagnostic.contexts.some(context => context.name === 'singularity:state')).toBe(false)
  })
})
