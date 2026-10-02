/**
 * A6 interface ④, unit level: the hand-off rules, the supervisor role in the
 * coordination ledger, and the consumption entry.
 *
 * What these cases pin:
 *
 * 1. **Every diagnosis is a hand-off.** A conclusion without suggestions still
 *    starts a supervisor, no evolution service needs to be mounted, and the only
 *    named stops left are the store's allowance, the source's round cap and a
 *    conflicting hand-off content.
 * 2. **One hand-off, one supervisor.** A repeat returns the identity the ledger
 *    already holds (after a "restart" too), a claim that never reached model
 *    input or a started supervisor no process runs is recovered `interrupted`
 *    and re-delegable, and a diagnosis asked for under another hand-off content
 *    is refused by name.
 * 3. **The attempt settles.** A supervisor that issued a recovery settles
 *    `recorded` naming the run, one that closed explicitly settles `closed` with
 *    its reason, and one that ended with neither settles `interrupted`.
 * 4. **The coordinator's plane.** The grant carries the candidate chain,
 *    `task_recover` and the read tools, and carries no business write, no shell,
 *    no spawn and no decide/apply/rollback.
 * 5. **The first request.** It names the real source, its outcome, the diagnosis,
 *    the prior round's review facts as read-only text, and the close path.
 *
 * The ledger here is the real file (`$DSH_HOME/review-agents/agents.jsonl`) and
 * the reviews are driven through the real entry; only the agent plane is a stub,
 * because what a coordinator *is* is its delegation row, its grant and its first
 * request.
 * @module tests/unit/evolution-handoff
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Diagnosis } from '@dangosys/dsh-singularity-task'
import {
  admitReviewAgent,
  readReviewAgentAttempts,
  readSupervisorDelegation,
  readSupervisorHandoff,
  reviewAgentLedgerFile,
} from '../../src/coordination/ledger.ts'
import {
  consumePendingHandoffs,
  handoffDelegatorOf,
  renderConsumption,
  startSupervisorHandoff,
} from '../../src/coordination/evolution-handoff.ts'
import {
  COORDINATION_PRESET,
  SUPERVISOR_BASELINE,
  closeOutcomeOf,
  handoffDecision,
  handoffSourceOf,
  handoffStateLine,
  renderSupervisorReviewFacts,
  supervisorGrant,
  supervisorHandoffDigest,
  supervisorPrompt,
} from '../../src/coordination/handoff-rules.ts'
import { REVIEWER_PRESET } from '../../src/coordination/review-run.ts'
import { configureSupervision } from '../../src/coordination/supervision.ts'

const ROOT = 's-root'
const STORE = `sg-t-${ROOT}`

/** The close every stub supervisor's last message carries unless a case says otherwise. */
const CLOSE_REPLY = 'no further round is justified.\n```json\n{"outcome":"closed","reason":"no further round is justified"}\n```'

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    diagnosisId: 'd-1',
    taskId: 't-root',
    observedFailure: 'the second member never verified',
    scope: 'the root goal of this store',
    localizedCause: 'the capability the member needed was never granted',
    evidenceRefs: ['ev-1'],
    reviewRefs: ['t-root#r-1'],
    confidence: 'high',
    proposals: [{ targetType: 'capability', targetId: 'new-row', rationale: 'the member needs this capability' }],
    ...overrides,
  }
}

interface StoreSnapshot {
  diagnoses: Diagnosis[]
  reviews: unknown[]
  runs: unknown[]
  tasks: unknown[]
}

/**
 * The agent plane a consumption needs: the root's live agent, and a spawn whose
 * handle ends with `reply` (`null` = no assistant text at all). No
 * `singularityEvolution` service is mounted: nothing here may require it.
 */
function fixture(options: {
  spawnFails?: boolean
  reply?: string | null
  runs?: readonly unknown[]
  reviews?: readonly unknown[]
  tasks?: readonly unknown[]
} = {}) {
  const reply = options.reply === null ? undefined : options.reply ?? CLOSE_REPLY
  const spawns: { sessionId: string; name: string; prompt: string; agentPreset: string; grant: unknown }[] = []
  const snapshots = new Map<string, StoreSnapshot>()
  snapshots.set(STORE, {
    diagnoses: [],
    reviews: [...(options.reviews ?? [])],
    runs: [...(options.runs ?? [])],
    tasks: [...(options.tasks ?? [])],
  })
  const rootAgent = { id: ROOT }
  const ctx = {
    get(name: string): unknown {
      if (name === 'agents') return { get: (id: string) => (id === ROOT ? rootAgent : undefined) }
      if (name === 'graphs') return { list: async () => [{ rootSessionId: ROOT }] }
      return undefined
    },
    graphs: { graphForSession: async () => ({ id: 'g1', rootSessionId: ROOT }) },
    task: {
      snapshotIn: async (storeId: string) => structuredClone(snapshots.get(storeId) ?? { diagnoses: [], reviews: [], runs: [], tasks: [] }),
    },
    agentRuntime: {
      spawn: vi.fn(async (_parent: unknown, request: Record<string, unknown>) => {
        const name = String(request.name)
        spawns.push({
          sessionId: String(request.sessionId),
          name,
          prompt: ((request.prompt as { text: string }[])[0] ?? { text: '' }).text,
          agentPreset: String(request.agentPreset),
          grant: request.grant,
        })
        await (request.beforePrompt as () => Promise<void>)()
        if (options.spawnFails === true) throw new Error('the deployment cannot spawn a coordinator')
        const events = reply === undefined
          ? []
          : [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } }]
        return {
          agent: {
            id: String(request.sessionId),
            cancel: () => {},
            whenIdle: async () => {},
            session: { snapshotEvents: () => events },
          },
        }
      }),
    },
  }
  return { ctx: ctx as unknown as Context, spawns, snapshots, rootAgent }
}

function ledgerRows(): Record<string, unknown>[] {
  let text: string
  try {
    text = readFileSync(reviewAgentLedgerFile(), 'utf8')
  } catch {
    return []
  }
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

function rowsOfKind(kind: string): Record<string, unknown>[] {
  return ledgerRows().filter(row => row.kind === kind)
}

let ledgerDir: string
let previousLedger: string | undefined
let previousBudget: string | undefined

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), 'evolution-handoff-'))
  previousLedger = process.env.SINGULARITY_REVIEW_LEDGER_DIR
  previousBudget = process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  process.env.SINGULARITY_REVIEW_LEDGER_DIR = ledgerDir
  delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
})

afterEach(() => {
  configureSupervision(undefined)
  if (previousLedger === undefined) delete process.env.SINGULARITY_REVIEW_LEDGER_DIR
  else process.env.SINGULARITY_REVIEW_LEDGER_DIR = previousLedger
  if (previousBudget === undefined) delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  else process.env.SINGULARITY_REVIEW_AGENT_BUDGET = previousBudget
  rmSync(ledgerDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('the hand-off rules', () => {
  it('takes every recorded diagnosis as a hand-off, and stops by allowance or round cap by name', () => {
    const budget = { used: 0, max: 8 }
    const attempts: never[] = []
    // A conclusion without suggestions is a hand-off too; an unsupported target
    // type no longer stops anything — the supervisor decides what is executable.
    expect(handoffDecision({ diagnosis: diagnosis({ proposals: [] }), attempts, budget })).toEqual({ kind: 'start' })
    expect(handoffDecision({
      diagnosis: diagnosis({ proposals: [{ targetType: 'quantum', targetId: 'x', rationale: 'y' }] }),
      attempts,
      budget,
    })).toEqual({ kind: 'start' })

    const spent = handoffDecision({ diagnosis: diagnosis(), attempts, budget: { used: 8, max: 8 } })
    expect(spent).toMatchObject({ kind: 'stopped', code: 'budget-exhausted' })
    expect((spent as { reason: string }).reason).toContain('8/8')

    const capped = handoffDecision({
      diagnosis: diagnosis(),
      attempts,
      budget,
      rounds: { outcome: 'failed', recovered: 3, improved: 0, maxRecovery: 3, maxImprovement: 2 },
    })
    expect(capped).toMatchObject({ kind: 'stopped', code: 'iteration-cap' })
    expect((capped as { reason: string }).reason).toContain('3/3')

    const improvementCapped = handoffDecision({
      diagnosis: diagnosis(),
      attempts,
      budget,
      rounds: { outcome: 'verified', recovered: 0, improved: 2, maxRecovery: 3, maxImprovement: 2 },
    })
    expect(improvementCapped).toMatchObject({ kind: 'stopped', code: 'iteration-cap' })
    expect((improvementCapped as { reason: string }).reason).toContain('2/2')

    // The pack's own line: a conclusion without suggestions is pending, a
    // recorded outcome reads as taken up, and a close reads as settled.
    expect(handoffStateLine({ diagnosis: diagnosis({ proposals: [] }), attempts, budget })).toContain('pending')
    const settledAt = '2026-10-01T00:00:00.000Z'
    const recorded = [{
      role: 'supervisor' as const, source: { taskId: 't-root', runId: 'r-1' }, requestKey: null, reason: null,
      diagnosisId: 'd-1', sessionId: 's-1', actor: ROOT, at: settledAt, started: true,
      settlement: { status: 'recorded' as const, note: 'task_recover issued: run r-2', at: settledAt },
    }]
    expect(handoffStateLine({ diagnosis: diagnosis(), attempts: recorded, budget })).toContain('taken up — this hand-off is delegated to supervisor session s-1')
    const closed = [{ ...recorded[0]!, settlement: { status: 'closed' as const, note: 'no round is justified', at: settledAt } }]
    expect(handoffStateLine({ diagnosis: diagnosis(), attempts: closed, budget })).toContain('settled — supervisor session s-1 closed the hand-off: no round is justified')
  })

  it('answers with the supervisor a hand-off already has, its concluded outcome, or the running claim', () => {
    const at = '2026-09-28T00:00:00.000Z'
    const attempt = {
      role: 'supervisor' as const,
      source: { taskId: 't-root', runId: 'r-1' },
      requestKey: null,
      reason: null,
      diagnosisId: 'd-1',
      sessionId: 's-supervisor',
      actor: ROOT,
      at,
      started: true,
      settlement: undefined,
    }
    // Even with the allowance spent, an open started hand-off answers with its
    // own identity: the fact is durable and nothing re-decides it.
    expect(handoffDecision({ diagnosis: diagnosis(), attempts: [attempt], budget: { used: 9, max: 8 } }))
      .toEqual({ kind: 'started', sessionId: 's-supervisor', at })
    // A claim that never reached model input is not an identity — it is in flight.
    expect(handoffDecision({
      diagnosis: diagnosis(),
      attempts: [{ ...attempt, started: false, sessionId: 's-claim' }],
      budget: { used: 9, max: 8 },
    })).toEqual({ kind: 'in-flight', sessionId: 's-claim' })
    // A settled outcome is the hand-off's own: no new supervisor is started for it.
    expect(handoffDecision({
      diagnosis: diagnosis(),
      attempts: [{ ...attempt, settlement: { status: 'recorded', note: 'task_recover issued: run r-2', at } }],
      budget: { used: 9, max: 8 },
    })).toEqual({ kind: 'concluded', sessionId: 's-supervisor', status: 'recorded', note: 'task_recover issued: run r-2', at })
    expect(handoffDecision({
      diagnosis: diagnosis(),
      attempts: [{ ...attempt, settlement: { status: 'closed', note: 'no round is justified', at } }],
      budget: { used: 9, max: 8 },
    })).toMatchObject({ kind: 'concluded', status: 'closed' })
    // An interrupted attempt is a failure, not the hand-off's owner: it never
    // blocks a fresh start.
    expect(handoffDecision({
      diagnosis: diagnosis(),
      attempts: [{ ...attempt, settlement: { status: 'interrupted', note: 'gone', at } }],
      budget: { used: 0, max: 8 },
    })).toEqual({ kind: 'start' })
  })

  it('reads the close a supervisor declared, or nothing', () => {
    expect(closeOutcomeOf(CLOSE_REPLY)).toEqual({ reason: 'no further round is justified' })
    expect(closeOutcomeOf('```json\n{"outcome":"closed"}\n```')).toEqual({ reason: 'the supervisor closed the hand-off' })
    expect(closeOutcomeOf('prose with no block')).toBeUndefined()
    expect(closeOutcomeOf('```json\n{"outcome":"recovered"}\n```')).toBeUndefined()
    expect(closeOutcomeOf(undefined)).toBeUndefined()
  })

  it('reads the source a diagnosis names, and its identity changes with its suggestions', () => {
    expect(handoffSourceOf(diagnosis())).toEqual({ taskId: 't-root', runId: 'r-1' })
    expect(handoffSourceOf(diagnosis({ reviewRefs: ['t-root#no-run'] }))).toEqual({ taskId: 't-root', runId: null })
    // Another task's ref is not this diagnosis's source.
    expect(handoffSourceOf(diagnosis({ reviewRefs: ['t-other#r-9'] }))).toEqual({ taskId: 't-root', runId: null })
    const digest = supervisorHandoffDigest(STORE, diagnosis())
    expect(supervisorHandoffDigest(STORE, diagnosis())).toBe(digest)
    expect(supervisorHandoffDigest(STORE, diagnosis({ proposals: [] }))).not.toBe(digest)
    expect(supervisorHandoffDigest('sg-t-other', diagnosis())).not.toBe(digest)
  })

  it('gives the coordinator the candidate chain and the recovery entry — never a decision, an apply or a write', () => {
    const grant = supervisorGrant()
    expect(grant.keepPresetTools).toBe(false)
    expect([...grant.baseline].sort()).toEqual([...SUPERVISOR_BASELINE].sort())
    for (const allowed of ['task_recover', 'evolution_propose', 'evolution_candidate', 'evolution_prepare', 'evolution_replay', 'evolution_gate', 'task_review_pack', 'context_read']) {
      expect(grant.baseline, allowed).toContain(allowed)
    }
    for (const forbidden of ['evolution_decide', 'evolution_apply', 'evolution_rollback', 'bash', 'write', 'edit', 'jobs', 'subagent', 'graph_spawn', 'hitl_approve', 'task_decompose', 'task_submit_result']) {
      expect(grant.baseline, forbidden).not.toContain(forbidden)
    }
    // One persona for both coordination roles: the plane is the grant's, and a
    // second preset name nobody mounts would fail the spawn on a real deployment.
    expect(COORDINATION_PRESET).toBe(REVIEWER_PRESET)
  })

  it('renders the prior round facts read-only: criteria verdicts, derived passed/total and metrics', () => {
    const facts = renderSupervisorReviewFacts({
      taskId: 't-root',
      runId: 'r-1',
      outcome: 'failed',
      evidenceRefs: ['ev-1'],
      anomalies: [],
      criteria: [
        { criterionId: 'c1', verdict: 'pass' },
        { criterionId: 'c2', verdict: 'fail' },
      ],
      metrics: { toolCalls: { calls: 4, failures: 1 }, retries: 1 },
    } as never)
    expect(facts).toContain('review t-root#r-1 [failed]')
    expect(facts).toContain('criteria (1/2 passed): c1 pass; c2 fail')
    expect(facts).toContain('toolCalls 4 (1 failed)')
    expect(facts).toContain('retries 1')
  })

  it('states the hand-off, the real source, the prior facts and the close path in the first request', () => {
    const facts = 'review t-root#r-1 [failed]\ncriteria (1/2 passed): c1 pass; c2 fail'
    const prompt = supervisorPrompt({ diagnosis: diagnosis(), sourceRef: 't-root#r-1', sourceOutcome: 'failed', reviewFacts: facts })
    expect(prompt).toContain('supervisor')
    expect(prompt).toContain('diagnosis d-1 about task t-root')
    expect(prompt).toContain('source t-root#r-1, whose review settled failed')
    expect(prompt).toContain('capability new-row')
    expect(prompt).toContain('--- prior round review facts (read-only) ---')
    expect(prompt).toContain('criteria (1/2 passed)')
    expect(prompt).toContain('mode "improve"')
    expect(prompt).toContain('{"outcome":"closed","reason":"..."}')
    expect(prompt).toContain('task_recover')
    expect(prompt).toContain('evolution_replay')
    expect(prompt).toContain('you never call evolution_decide, evolution_apply or evolution_rollback')

    const bare = supervisorPrompt({ diagnosis: diagnosis({ proposals: [] }), sourceRef: 't-root#r-1', sourceOutcome: 'verified' })
    expect(bare).toContain('Its recorded suggestions: none')
    expect(bare).toContain('no review record could be read for this source')
  })
})

describe('the supervisor role in the coordination ledger', () => {
  it('plans by diagnosis, not by review source: a reviewer attempt never dedupes a hand-off and the other way round', async () => {
    // Two coordination runs of one store, both from the same allowance.
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '2')
    // A reviewer attempt of the same source (t-root#r-1) is in the ledger.
    const rows = await admitReviewAgent(STORE, async admission => {
      const request = {
        source: { taskId: 't-root', runId: 'r-1' },
        requestKey: null,
        reason: null,
        actor: ROOT,
        sessionId: 's-reviewer',
      }
      const { plan } = await admission.plan(request)
      await admission.claim(request)
      await admission.start({ taskId: 't-root', sessionId: 's-reviewer', actor: ROOT })
      return plan
    })
    expect(rows.kind).toBe('start')
    const attempts = await readReviewAgentAttempts(STORE)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({ role: 'reviewer', started: true })

    // The hand-off for the same source starts its own attempt: the two roles
    // never stand for one another, and the budget stays the one count.
    const f = fixture()
    const consumption = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(consumption).toMatchObject({ result: 'started' })
    const after = await readReviewAgentAttempts(STORE)
    expect(after.map(attempt => attempt.role).sort()).toEqual(['reviewer', 'supervisor'])
    const supervisorRows = ledgerRows().filter(row => row.kind === 'claim' && row.role === 'supervisor')
    expect(supervisorRows).toHaveLength(1)
    expect(supervisorRows[0]).toMatchObject({ diagnosisId: 'd-1', taskId: 't-root', runId: 'r-1', actor: ROOT, requestKey: null })
    expect((await readSupervisorHandoff(STORE, 'd-1'))!.sessionId).toBe((consumption as { sessionId: string }).sessionId)
    // The delegation is readable for the recovery entry's identity check.
    const delegation = await readSupervisorDelegation((consumption as { sessionId: string }).sessionId, 'd-1')
    expect(delegation).toMatchObject({ rootStoreId: STORE, taskId: 't-root', actor: ROOT, diagnosisId: 'd-1' })
    expect(await readSupervisorDelegation((consumption as { sessionId: string }).sessionId, 'd-2')).toBeUndefined()
  })

  it('answers a repeat from the ledger, after a restart too, and records no second spawn', async () => {
    const first = fixture()
    const started = await startSupervisorHandoff(first.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: first.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(started).toMatchObject({ result: 'started' })
    expect(first.spawns).toHaveLength(1)
    expect(first.spawns[0]!.agentPreset).toBe(COORDINATION_PRESET)

    // A second call in the same process, and a second process's read of the same
    // file, both answer with the same supervisor session.
    const again = await startSupervisorHandoff(fixture().ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: first.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(again).toEqual({ diagnosisId: 'd-1', result: 'existing', sessionId: (started as { sessionId: string }).sessionId })
    expect(ledgerRows().filter(row => row.kind === 'started')).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'claim')).toHaveLength(1)
  })

  it('settles a supervisor that issued a recovery as recorded, naming the run, and keeps answering with it', async () => {
    const recovery = {
      sourceDiagnosisId: 'd-1', requestKey: 'k-1', sourceRunId: 'r-1', requestedAt: '2026-10-01T00:00:00.000Z',
    }
    const f = fixture({ reply: null, runs: [{ runId: 'r-rec', taskId: 't-root', status: 'running', recovery }] })
    const started = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(started).toMatchObject({ result: 'started' })
    await vi.waitFor(() => expect(rowsOfKind('settled')).toHaveLength(1))
    const settled = rowsOfKind('settled')[0]!
    expect(settled).toMatchObject({ status: 'recorded', sessionId: (started as { sessionId: string }).sessionId })
    expect(String(settled.note)).toContain('task_recover issued: run r-rec')

    // The concluded hand-off still answers with its own supervisor, and never
    // starts a second one.
    const again = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(again).toEqual({ diagnosisId: 'd-1', result: 'existing', sessionId: (started as { sessionId: string }).sessionId })
    expect(f.spawns).toHaveLength(1)
  })

  it('settles a supervisor that closed explicitly with its reason', async () => {
    const f = fixture()
    const started = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(started).toMatchObject({ result: 'started' })
    await vi.waitFor(() => expect(rowsOfKind('settled')).toHaveLength(1))
    const settled = rowsOfKind('settled')[0]!
    expect(settled).toMatchObject({ status: 'closed', sessionId: (started as { sessionId: string }).sessionId })
    expect(settled.note).toBe('no further round is justified')
    // A closed hand-off is concluded: its supervisor stays its identity.
    expect((await readSupervisorHandoff(STORE, 'd-1'))!.sessionId).toBe((started as { sessionId: string }).sessionId)
  })

  it('settles a supervisor that ended without an outcome as interrupted, and re-delegates it', async () => {
    configureSupervision({ coordinationBudget: 2 })
    const f = fixture({ reply: null })
    const first = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(first).toMatchObject({ result: 'started' })
    await vi.waitFor(() => expect(rowsOfKind('settled')).toHaveLength(1))
    expect(rowsOfKind('settled')[0]).toMatchObject({ status: 'interrupted' })
    expect(String(rowsOfKind('settled')[0]!.note)).toContain('without issuing task_recover or closing')
    expect(await readSupervisorHandoff(STORE, 'd-1')).toBeUndefined()

    // The failure spent one coordination run, and the hand-off is delegable
    // again: a fresh supervisor is started under the remaining allowance.
    const second = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(second).toMatchObject({ result: 'started' })
    expect((second as { sessionId: string }).sessionId).not.toBe((first as { sessionId: string }).sessionId)
    expect(f.spawns).toHaveLength(2)
  })

  it('re-delegates a started supervisor whose process is gone', async () => {
    // The state a process killed after model input left: a claim and a started
    // row nobody is running any more. The old trap skipped it forever.
    configureSupervision({ coordinationBudget: 2 })
    writeFileSync(reviewAgentLedgerFile(), [
      JSON.stringify({
        formatVersion: 2, kind: 'claim', role: 'supervisor', rootStoreId: STORE, taskId: 't-root', runId: 'r-1',
        requestKey: null, reason: null, diagnosisId: 'd-1', handoffDigest: supervisorHandoffDigest(STORE, diagnosis()),
        sessionId: 's-dead', actor: ROOT, at: '2026-09-26T00:00:00.000Z',
      }),
      JSON.stringify({
        formatVersion: 2, kind: 'started', rootStoreId: STORE, taskId: 't-root', sessionId: 's-dead', actor: ROOT, at: '2026-09-26T00:00:01.000Z',
      }),
      '',
    ].join('\n'), 'utf8')
    const f = fixture()
    const consumption = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(consumption).toMatchObject({ result: 'started' })
    const attempts = await readReviewAgentAttempts(STORE)
    const dead = attempts.find(attempt => attempt.sessionId === 's-dead')!
    expect(dead.settlement).toMatchObject({ status: 'interrupted' })
    expect(String(dead.settlement!.note)).toContain('is gone')
    expect(f.spawns.filter(spawn => spawn.name.startsWith('supervisor'))).toHaveLength(1)
    // The dead attempt's spent run is not refunded, and the new attempt is the
    // hand-off's own.
    expect(await readSupervisorHandoff(STORE, 'd-1')).toMatchObject({ sessionId: (consumption as { sessionId: string }).sessionId })
  })

  it('refuses a capped source before any claim or spawn, for a failed and for a verified source', async () => {
    const recoveryRun = (index: number, kind: 'recovery' | 'improvement') => ({
      runId: `r-${kind}-${index}`,
      taskId: 't-root',
      status: 'failed',
      recovery: { kind, sourceDiagnosisId: 'd-1', requestKey: `k-${index}`, sourceRunId: 'r-1', requestedAt: '2026-10-01T00:00:00.000Z' },
    })
    const failed = fixture({ runs: [1, 2, 3].map(index => recoveryRun(index, 'recovery')) })
    const capped = await startSupervisorHandoff(failed.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: failed.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(capped).toMatchObject({ result: 'stopped', code: 'iteration-cap' })
    expect((capped as { reason: string }).reason).toContain('3/3')
    expect(ledgerRows()).toEqual([])
    expect(failed.spawns).toEqual([])

    const verified = fixture({
      runs: [1, 2].map(index => recoveryRun(index, 'improvement')),
      reviews: [{ taskId: 't-root', runId: 'r-1', outcome: 'verified' }],
    })
    const improvementCapped = await startSupervisorHandoff(verified.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: verified.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'verified',
    })
    expect(improvementCapped).toMatchObject({ result: 'stopped', code: 'iteration-cap' })
    expect((improvementCapped as { reason: string }).reason).toContain('2/2')
    expect(ledgerRows()).toEqual([])
    expect(verified.spawns).toEqual([])
  })

  it('refuses the same diagnosis under another hand-off content, by name', async () => {
    const first = fixture()
    const started = await startSupervisorHandoff(first.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: first.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(started).toMatchObject({ result: 'started' })
    // The same id carrying different suggestions is not the same hand-off: the
    // claim's digest disagrees, and nothing new is started.
    const other = fixture()
    const conflict = await admitReviewAgent(STORE, async admission => {
      const { plan } = await admission.plan({
        role: 'supervisor',
        source: { taskId: 't-root', runId: 'r-1' },
        requestKey: null,
        reason: null,
        diagnosisId: 'd-1',
        handoffDigest: 'a-different-hand-off',
        actor: ROOT,
        sessionId: 's-other',
      })
      return plan
    })
    expect(conflict.kind).toBe('refused')
    expect(conflict.code).toBe('request-key-conflict')
    expect(ledgerRows().filter(row => row.kind === 'started')).toHaveLength(1)
    expect(other.spawns).toHaveLength(0)
  })

  it('frees a hand-off whose supervisor could not be spawned: the failure is recorded, and a later consumption starts it', async () => {
    vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '2')
    const failing = fixture({ spawnFails: true })
    const failed = await startSupervisorHandoff(failing.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: failing.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(failed.result).toBe('failed')
    expect(ledgerRows().filter(row => row.kind === 'claim')).toHaveLength(1)
    // The started row was written before the spawn threw, so the run is spent —
    // and the attempt is settled `interrupted`, which is what says this hand-off
    // was not taken up.
    expect(ledgerRows().filter(row => row.kind === 'started')).toHaveLength(1)
    expect(ledgerRows().filter(row => row.kind === 'settled')).toHaveLength(1)
    expect(await readSupervisorHandoff(STORE, 'd-1')).toBeUndefined()
    // The failed attempt is over, not in flight: a later consumption takes the
    // hand-off up with a fresh claim, and the failed one spends nothing.
    const retry = fixture()
    const started = await startSupervisorHandoff(retry.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: retry.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(started).toMatchObject({ result: 'started' })
    expect(retry.spawns).toHaveLength(1)
    const attempts = await readReviewAgentAttempts(STORE)
    const supervisorAttempts = attempts.filter(attempt => attempt.role === 'supervisor')
    expect(supervisorAttempts).toHaveLength(2)
    // The failed spawn's started row stays on the record — that run was spent —
    // and exactly one attempt is the hand-off's coordinator.
    expect(supervisorAttempts.filter(attempt => attempt.started)).toHaveLength(2)
    expect(supervisorAttempts.filter(attempt => attempt.started && attempt.settlement === undefined)).toHaveLength(1)
    expect((await readSupervisorHandoff(STORE, 'd-1'))!.sessionId).toBe((started as { sessionId: string }).sessionId)
    const interrupted = supervisorAttempts.filter(attempt => attempt.settlement !== undefined)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]!.settlement).toMatchObject({ status: 'interrupted' })
  })

  it('refuses a new hand-off once the store\'s allowance is spent, with zero claim and zero spawn', async () => {
    configureSupervision({ coordinationBudget: 1 })
    const f = fixture()
    const first = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(first.result).toBe('started')
    // The configured allowance is one run for the store, reviewer and supervisor
    // alike: the second hand-off is stopped by name, with nothing written.
    const second = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis({ diagnosisId: 'd-2', proposals: [{ targetType: 'skill', targetId: 'verify', rationale: 'x' }] }),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(second).toMatchObject({ result: 'stopped', code: 'budget-exhausted' })
    expect(ledgerRows().filter(row => row.kind === 'claim')).toHaveLength(1)
    expect(f.spawns).toHaveLength(1)
  })

  it('scans a store\'s pending hand-offs: every diagnosis is taken up, suggestions or not', async () => {
    const f = fixture()
    // Nothing here mounts a `singularityEvolution` service: no hand-off requires
    // the evolution plane any more.
    expect((f.ctx as unknown as { get(name: string): unknown }).get('singularityEvolution')).toBeUndefined()
    f.snapshots.set(STORE, {
      diagnoses: [diagnosis(), diagnosis({ diagnosisId: 'd-2', proposals: [] })],
      reviews: [{ taskId: 't-root', runId: 'r-1', outcome: 'failed' }],
      runs: [],
      tasks: [],
    })
    expect(await handoffDelegatorOf(f.ctx, STORE)).toMatchObject({ sessionId: ROOT })
    const report = await consumePendingHandoffs(f.ctx, STORE)
    // Both diagnoses are hand-offs at all: the conclusion without a suggestion
    // starts its own supervisor too.
    expect(report.consumptions).toEqual([
      expect.objectContaining({ diagnosisId: 'd-1', result: 'started' }),
      expect.objectContaining({ diagnosisId: 'd-2', result: 'started' }),
    ])
    expect(f.spawns.filter(spawn => spawn.name.startsWith('supervisor'))).toHaveLength(2)
    expect((await readReviewAgentAttempts(STORE)).map(attempt => attempt.diagnosisId)).toEqual(['d-1', 'd-2'])
  })

  it('does not fabricate a delegator: a store whose graph session is not live is skipped by name', async () => {
    const ctx = {
      get(name: string): unknown {
        if (name === 'graphs') return { list: async () => [{ rootSessionId: 's-elsewhere' }] }
        if (name === 'agents') return { get: () => undefined }
        return undefined
      },
      task: { snapshotIn: async () => ({ diagnoses: [diagnosis()], reviews: [] }) },
      agentRuntime: { spawn: vi.fn() },
    } as unknown as Context
    const report = await consumePendingHandoffs(ctx, STORE)
    expect(report.skipped).toContain('root session')
    expect(report.consumptions).toEqual([expect.objectContaining({ result: 'stopped', code: 'no-delegator' })])
  })
})

describe('the consumption as a caller renders it', () => {
  it('renders every consumption shape with its named stop', () => {
    expect(renderConsumption({ diagnosisId: 'd-1', result: 'started', sessionId: 's-1' })).toContain('supervisor session s-1 started')
    expect(renderConsumption({ diagnosisId: 'd-1', result: 'existing', sessionId: 's-1' })).toContain('already delegated')
    expect(renderConsumption({ diagnosisId: 'd-1', result: 'stopped', code: 'iteration-cap', reason: 'capped' }))
      .toBe('diagnosis d-1 pending (iteration-cap) — capped')
    expect(renderConsumption({ diagnosisId: 'd-1', result: 'failed', reason: 'boom' })).toContain('could not be started: boom')
  })
})
