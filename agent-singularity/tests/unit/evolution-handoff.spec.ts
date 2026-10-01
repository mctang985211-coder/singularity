/**
 * A6 interface ④, unit level: the hand-off rules, the supervisor role in the
 * coordination ledger, and the consumption entry.
 *
 * What these cases pin:
 *
 * 1. **The named stops.** A conclusion without suggestions, a deployment with the
 *    evolution chain off, a suggestion naming a target type this build does not
 *    record, and one it refuses by name (a tool, a verifier, a preset, a runtime
 *    policy) all leave the hand-off exactly as it was: no claim, no spawn, no
 *    budget spent — and the pack's line names why.
 * 2. **One hand-off, one supervisor.** A repeat returns the identity the ledger
 *    already holds (after a "restart" too — a second read of the same file), a
 *    claim that never reached model input is not an identity and is settled
 *    `interrupted`, and a diagnosis asked for under another hand-off content is
 *    refused by name.
 * 3. **The coordinator's plane.** The grant carries the candidate chain,
 *    `task_recover` and the read tools, and carries no business write, no shell,
 *    no spawn and no decide/apply/rollback — a supervisor prepares evidence for a
 *    person, it never approves or applies a promotion itself.
 * 4. **The first request.** It names the real source, its outcome, the diagnosis
 *    and the hand-off identity, and it says which two candidate surfaces exist.
 *
 * The ledger here is the real file (`$DSH_HOME/review-agents/agents.jsonl`) and
 * the reviews are driven through the real entry; only the agent plane is a stub,
 * because what a coordinator *is* is its delegation row, its grant and its first
 * request.
 * @module tests/unit/evolution-handoff
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  startSupervisorHandoff,
  type HandoffConsumption,
} from '../../src/coordination/evolution-handoff.ts'
import {
  COORDINATION_PRESET,
  SUPERVISOR_BASELINE,
  handoffDecision,
  handoffPreflight,
  handoffSourceOf,
  supervisorGrant,
  supervisorHandoffDigest,
  supervisorPrompt,
} from '../../src/coordination/handoff-rules.ts'
import { REVIEWER_PRESET } from '../../src/coordination/review-run.ts'

const ROOT = 's-root'
const STORE = `sg-t-${ROOT}`

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

/** The agent plane a consumption needs: the root's live agent, and a spawn that runs `beforePrompt` as the real one does. */
function fixture(options: { enabled?: boolean; spawnFails?: boolean } = {}) {
  const spawns: { sessionId: string; name: string; prompt: string; agentPreset: string; grant: unknown }[] = []
  const snapshots = new Map<string, { diagnoses: Diagnosis[]; reviews: unknown[] }>()
  snapshots.set(STORE, { diagnoses: [], reviews: [] })
  const rootAgent = { id: ROOT }
  const ctx = {
    get(name: string): unknown {
      if (name === 'singularityEvolution') return { enabled: options.enabled ?? true }
      if (name === 'agents') return { get: (id: string) => (id === ROOT ? rootAgent : undefined) }
      if (name === 'graphs') return { list: async () => [{ rootSessionId: ROOT }] }
      return undefined
    },
    task: {
      snapshotIn: async (storeId: string) => structuredClone(snapshots.get(storeId) ?? { diagnoses: [], reviews: [] }),
    },
    agentRuntime: {
      spawn: vi.fn(async (_parent: unknown, request: Record<string, unknown>) => {
        spawns.push({
          sessionId: String(request.sessionId),
          name: String(request.name),
          prompt: ((request.prompt as { text: string }[])[0] ?? { text: '' }).text,
          agentPreset: String(request.agentPreset),
          grant: request.grant,
        })
        await (request.beforePrompt as () => Promise<void>)()
        if (options.spawnFails === true) throw new Error('the deployment cannot spawn a coordinator')
        return { agent: { id: String(request.sessionId), cancel: () => {}, whenIdle: async () => {}, session: { snapshotEvents: () => [] } } }
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
  if (previousLedger === undefined) delete process.env.SINGULARITY_REVIEW_LEDGER_DIR
  else process.env.SINGULARITY_REVIEW_LEDGER_DIR = previousLedger
  if (previousBudget === undefined) delete process.env.SINGULARITY_REVIEW_AGENT_BUDGET
  else process.env.SINGULARITY_REVIEW_AGENT_BUDGET = previousBudget
  rmSync(ledgerDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('the hand-off rules', () => {
  it('answers a conclusion without suggestions, a switched-off chain, an unknown target and a refused one, each by name', () => {
    const budget = { used: 0, max: 1 }
    const attempts: never[] = []
    const noSuggestions = diagnosis({ proposals: [] })
    expect(handoffDecision({ enabled: true, diagnosis: noSuggestions, attempts, budget })).toMatchObject({ kind: 'stopped', code: 'no-suggestions' })
    expect(handoffDecision({ enabled: false, diagnosis: diagnosis(), attempts, budget })).toMatchObject({ kind: 'stopped', code: 'evolution-off' })

    // A name outside the recorded vocabulary: the child never reasoned about a
    // surface this build has.
    const unknown = diagnosis({ proposals: [{ targetType: 'quantum', targetId: 'x', rationale: 'y' }] })
    const unknownDecision = handoffDecision({ enabled: true, diagnosis: unknown, attempts, budget })
    expect(unknownDecision).toMatchObject({ kind: 'stopped', code: 'unsupported-target' })
    expect((unknownDecision as { reason: string }).reason).toContain('quantum')

    // A recorded surface this build has no executor for: it would need a new
    // authorization, which the harness refuses to grant itself.
    for (const targetType of ['tool', 'verifier', 'agent_preset', 'runtime_policy']) {
      const decision = handoffDecision({
        enabled: true,
        diagnosis: diagnosis({ proposals: [{ targetType, targetId: 'x', rationale: 'y' }] }),
        attempts,
        budget,
      })
      expect(decision, targetType).toMatchObject({ kind: 'stopped', code: 'requires-new-authority' })
    }
    // The two surfaces this build does execute open the hand-off.
    for (const targetType of ['skill', 'capability']) {
      expect(handoffDecision({
        enabled: true,
        diagnosis: diagnosis({ proposals: [{ targetType, targetId: 'x', rationale: 'y' }] }),
        attempts,
        budget,
      })).toEqual({ kind: 'start' })
    }
    expect(handoffPreflight({ enabled: true, diagnosis: diagnosis() })).toBeUndefined()
  })

  it('answers with the supervisor a hand-off already has, before anything else is looked at', () => {
    const attempt = {
      role: 'supervisor' as const,
      source: { taskId: 't-root', runId: 'r-1' },
      requestKey: null,
      reason: null,
      diagnosisId: 'd-1',
      sessionId: 's-supervisor',
      actor: ROOT,
      at: '2026-09-28T00:00:00.000Z',
      started: true,
      settlement: undefined,
    }
    // Even with the chain off and the allowance spent, a started hand-off answers
    // with its own identity: the fact is durable and nothing re-decides it.
    expect(handoffDecision({ enabled: false, diagnosis: diagnosis(), attempts: [attempt], budget: { used: 9, max: 1 } }))
      .toEqual({ kind: 'started', sessionId: 's-supervisor', at: '2026-09-28T00:00:00.000Z' })
    // A claim that never reached model input is not an identity — it is in flight.
    expect(handoffDecision({
      enabled: true,
      diagnosis: diagnosis(),
      attempts: [{ ...attempt, started: false, sessionId: 's-claim' }],
      budget: { used: 9, max: 1 },
    })).toEqual({ kind: 'in-flight', sessionId: 's-claim' })
    // The allowance is the same one a reviewer consumes, and its name says so.
    const spent = handoffDecision({ enabled: true, diagnosis: diagnosis(), attempts: [], budget: { used: 1, max: 1 } })
    expect(spent).toMatchObject({ kind: 'stopped', code: 'budget-exhausted' })
    expect((spent as { reason: string }).reason).toContain('1/1')
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

  it('states the hand-off, the real source and the two executable surfaces in the first request', () => {
    const prompt = supervisorPrompt({ diagnosis: diagnosis(), sourceRef: 't-root#r-1', sourceOutcome: 'failed' })
    expect(prompt).toContain('supervisor')
    expect(prompt).toContain('diagnosis d-1 about task t-root')
    expect(prompt).toContain('source t-root#r-1, whose review settled failed')
    expect(prompt).toContain('capability new-row')
    expect(prompt).toContain('task_recover')
    expect(prompt).toContain('evolution_replay')
    expect(prompt).toContain('you never call evolution_decide, evolution_apply or evolution_rollback')
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
    const f = fixture()
    const first = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(first.result).toBe('started')
    // The default allowance is one run for the store, reviewer and supervisor
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

  it('scans a store\'s pending hand-offs: every diagnosis with suggestions is taken up, a conclusion is not', async () => {
    const f = fixture()
    f.snapshots.set(STORE, {
      diagnoses: [diagnosis(), diagnosis({ diagnosisId: 'd-2', proposals: [] })],
      reviews: [{ taskId: 't-root', runId: 'r-1', outcome: 'failed' }],
    })
    expect(await handoffDelegatorOf(f.ctx, STORE)).toMatchObject({ sessionId: ROOT })
    const report = await consumePendingHandoffs(f.ctx, STORE)
    // Only the diagnosis with suggestions is a hand-off at all: the conclusion
    // without one is not touched, and no attempt is written for it.
    expect(report.consumptions).toEqual([expect.objectContaining({ diagnosisId: 'd-1', result: 'started' })])
    expect(f.spawns).toHaveLength(1)
    expect((await readReviewAgentAttempts(STORE)).map(attempt => attempt.diagnosisId)).toEqual(['d-1'])
  })

  it('does not fabricate a delegator: a store whose graph session is not live is skipped by name', async () => {
    const ctx = {
      get(name: string): unknown {
        if (name === 'singularityEvolution') return { enabled: true }
        if (name === 'graphs') return { list: async () => [{ rootSessionId: 's-elsewhere' }] }
        if (name === 'agents') return { get: () => undefined }
        return undefined
      },
      task: { snapshotIn: async () => ({ diagnoses: [diagnosis()], reviews: [] }) },
      agentRuntime: { spawn: vi.fn() },
    } as unknown as Context
    const report = await consumePendingHandoffs(ctx, STORE)
    expect(report.skipped).toContain('root session')
    expect(report.consumptions).toEqual([expect.objectContaining({ result: 'stopped' })])
  })
})

describe('the consumption as a caller renders it', () => {
  it('answers with a named stop before the ledger is touched when the chain is off', async () => {
    const f = fixture({ enabled: false })
    const consumption: HandoffConsumption = await startSupervisorHandoff(f.ctx, {
      storeId: STORE,
      diagnosis: diagnosis(),
      delegator: { sessionId: ROOT, agent: f.rootAgent as never },
      sourceRef: 't-root#r-1',
      sourceOutcome: 'failed',
    })
    expect(consumption).toMatchObject({ result: 'stopped', code: 'evolution-off' })
    expect(ledgerRows()).toEqual([])
    expect(f.spawns).toEqual([])
  })
})
