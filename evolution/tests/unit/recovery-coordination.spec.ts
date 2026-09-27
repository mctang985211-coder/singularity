/**
 * A6: the recovery coordination entry (`EvolutionService.coordinateRecovery`) —
 * what the evolution plane checks before the runtime is asked to open a failed
 * root task's new attempt, and what it refuses by name.
 *
 * The chain is fixed (plan §F.4): the tool adapter → this entry → the runtime's
 * execution-recovery entry, and each layer re-checks its own rules. What is
 * checked *here*: the caller is the supervisor the ledger recorded for this
 * diagnosis and the hand-off's store is the caller's own; the diagnosis exists in
 * that store and names the store's root task; the source is in a failing state (a
 * success is not recovered, and this build has no comparator for "faster"); a
 * capability change the diagnosis stands on is approved and applied; a pure
 * artifact gap needs no proposal but the rows it uses must resolve; and the
 * diagnosis never has two attempts at once.
 *
 * What is *not* claimed here: the store's own facts (the failed run, the contract,
 * the providers, the ceilings, the idempotency of the key) are the runtime's
 * re-check, and the tests for those live with the runtime. This spec's fake
 * runtime records what it was asked, so a refusal is proven to have opened
 * nothing.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Diagnosis } from '@dangosys/dsh-singularity-task'
import type { CapabilityConfig } from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService } from '../../src/evolution.ts'
import { capabilityRowDigest } from '../../src/capability-candidate.ts'
import type { Config, SupervisorDelegation } from '../../src/evolution.ts'

const STORE = 'sg-t-s-root'
const ROOT_SESSION = 's-root'
const SUPERVISOR = 's-supervisor'
const DIAGNOSIS = 'd-1'

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    diagnosisId: DIAGNOSIS,
    taskId: 't-root',
    observedFailure: 'the member never verified',
    scope: 'the root goal',
    localizedCause: 'the capability was missing',
    evidenceRefs: ['ev-1'],
    reviewRefs: ['t-root#r-1'],
    confidence: 'high',
    proposals: [{ targetType: 'capability', targetId: 'new-row', rationale: 'the member needs it' }],
    ...overrides,
  }
}

interface FixtureOptions {
  /** The diagnosis the store holds (default: the capability-gap one). */
  readonly diagnosis?: Diagnosis
  /** The source task's status (default `failed`). */
  readonly sourceStatus?: string
  /** The source task's own runs, as the store holds them. */
  readonly runs?: readonly { runId: string; taskId: string; status: string; recovery?: Record<string, unknown> }[]
  readonly requestedCapabilities?: readonly string[]
  /** The delegation the ledger answers with (default: the supervisor of this diagnosis). */
  readonly delegation?: SupervisorDelegation | undefined
  /** Mount the task store / the graph registry / the runtime at all. */
  readonly services?: { task?: boolean; graphs?: boolean; runtime?: boolean }
  /** The deployment's capability table (the "rows the production uses"). */
  readonly table?: Record<string, CapabilityConfig>
  /** Whether the delegation source is wired at all. */
  readonly wireDelegation?: boolean
  /** Ledger lines written through the service's own entries before the call. */
  readonly ledger?: (svc: EvolutionService) => Promise<void>
}

async function fixture(options: FixtureOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-coordination-'))
  const delegation = 'delegation' in options
    ? options.delegation
    : { rootStoreId: STORE, taskId: 't-root', diagnosisId: DIAGNOSIS, sessionId: SUPERVISOR, actor: ROOT_SESSION, at: '2026-09-28T00:00:00.000Z' }
  const recoverRootTask = vi.fn(async (storeId: string, request: Record<string, unknown>, caller: Record<string, unknown>) => ({
    attempt: 'started' as const,
    storeId,
    sourceTaskId: String(request.sourceTaskId),
    sourceDiagnosisId: String(request.sourceDiagnosisId),
    requestKey: String(request.requestKey),
    runId: 'r-recovery',
    sessionId: 's-recovery',
    status: 'running' as const,
    reusedMembers: [],
    detail: `opened ${String(request.requestKey)}`,
    caller: String(caller.sessionId),
  }))
  const services = options.services ?? {}
  const ctx = {
    reflect: { provide: () => {} },
    get(name: string): unknown {
      if (name === 'task' && services.task !== false) {
        return {
          openStore: async () => ({
            tasks: [{
              taskId: 't-root',
              parentTaskId: undefined,
              objective: 'ship the release',
              depth: 0,
              acceptanceCriteria: [{ criterionId: 'root-goal', description: 'holds', mandatory: true, command: 'true' }],
              requestedCapabilities: options.requestedCapabilities ?? [],
              decompositionStatus: 'leaf',
              status: options.sourceStatus ?? 'failed',
              runIds: ['r-1'],
              childTaskIds: [],
            }, {
              taskId: 't-member',
              parentTaskId: 't-root',
              objective: 'a member',
              depth: 1,
              acceptanceCriteria: [],
              requestedCapabilities: [],
              decompositionStatus: 'leaf',
              status: 'failed',
              runIds: [],
              childTaskIds: [],
            }],
            runs: options.runs ?? [{ runId: 'r-1', taskId: 't-root', status: 'failed' }],
            reviews: [],
            evidence: [],
            edges: [],
            handoffs: [],
            diagnoses: options.diagnosis === null ? [] : [options.diagnosis ?? diagnosis()],
            obligations: [],
            capabilities: {},
          }),
        }
      }
      if (name === 'graphs' && services.graphs !== false) {
        return { graphForSession: async () => ({ id: 'g1', name: 'graph', envId: 'env1', rootSessionId: ROOT_SESSION, graphStoreId: 'sg-g', layoutStoreId: 'sg-l' }) }
      }
      if (name === 'taskRuntime' && services.runtime !== false) {
        return { listCapabilities: () => structuredClone(options.table ?? {}), recoverRootTask }
      }
      return undefined
    },
    effect: () => {},
  } as never
  const config: Config = {
    root: join(dir, 'evolution'),
    skillRoot: join(dir, 'skills'),
    modelSelection: () => ({ provider: 'p', model: 'm', label: 'p/m' }),
    ...(options.wireDelegation === false ? {} : {
      supervisorDelegation: async (sessionId: string, diagnosisId: string) =>
        delegation !== undefined && delegation.sessionId === sessionId && delegation.diagnosisId === diagnosisId ? delegation : undefined,
    }),
  }
  const svc = new EvolutionService(ctx, config)
  if (options.ledger === undefined) return { svc, recoverRootTask, dir, config }
  // The ledger a case fixes has to be on disk *before* the service under test
  // loads it: this instance is the writer, and a second one reads the file back.
  await options.ledger(svc)
  const reopened = new EvolutionService(ctx, config)
  return { svc: reopened, recoverRootTask, dir, config }
}

/**
 * One capability proposal in the ledger, carried to the state a case needs. The
 * states beyond `proposed` are written as the lines the fold admits for them:
 * `decided` and `applied` are reachable only through a real gate and commit, so
 * the fixture records the record this entry reads (a ledger is a file of records
 * — what the entry under test reads is `status`, `applied` and `rolledback`).
 */
async function capabilityProposal(svc: EvolutionService, state: 'proposed' | 'decided'): Promise<void> {
  await svc.propose({
    proposalId: 'p-cap',
    targetType: 'capability',
    targetId: 'new-row',
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the member needs this capability',
    sourceRefs: [`diagnosis:${DIAGNOSIS}`],
  }, 'root-1')
  if (state === 'proposed') return
  // The states a case needs are written through the service's own record doors
  // where one exists. `decided` and beyond require the gate and the experiment,
  // so the fixture records the lines the fold admits for exactly this state —
  // what the entry under test reads is `status`, `applied` and `rolledback`.
  const file = svc.file
  const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`
  const base = { formatVersion: 4, proposalId: 'p-cap', actor: 'root-1', at: '2026-09-28T00:00:01.000Z' }
  const mutation = { rows: { 'new-row': { skills: ['the-skill'] } } }
  const { appendFile } = await import('node:fs/promises')
  await appendFile(file, line({ ...base, kind: 'candidate', versionSet: { capabilityTable: 'config.yml#doc1' }, mutation }))
  if (state === 'decided') {
    const entry = { skills: ['the-skill'] }
    await appendFile(file, line({
      ...base,
      kind: 'prepared',
      sandbox: 'sandbox/p-cap',
      mechanical: true,
      champion: 'absent',
      files: [],
      capabilityRow: { name: 'new-row', entry, digest: capabilityRowDigest(entry) },
      capabilityBaseline: null,
    }))
    await appendFile(file, line({
      ...base,
      kind: 'gated',
      gate: {
        targetFailureFixed: 'a', originalAcceptanceMaintained: 'b', existingRegressionMaintained: 'c',
        noUnacceptableSideEffects: 'd', holdoutPerformanceAcceptable: 'e', resourceCostAcceptable: 'f',
        regressionEvidenceRefs: ['sandbox/x'],
      },
    }))
    await appendFile(file, line({
      ...base,
      kind: 'decided',
      decision: 'PROMOTE',
      approvalRef: 'approval:decide',
    }))
  }
}

describe('the recovery coordination entry', () => {
  it('refuses a request that carries anything but the two ids, and one that carries none', async () => {
    const { svc, recoverRootTask } = await fixture()
    await expect(svc.coordinateRecovery(
      { sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1', approved: true } as never,
      { sessionId: SUPERVISOR },
    )).rejects.toThrow(/unknown field "approved"/)
    await expect(svc.coordinateRecovery({ sourceDiagnosisId: '', requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/sourceDiagnosisId must be a non-empty string/)
    await expect(svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: '' }))
      .rejects.toThrow(/non-empty caller session id/)
    expect(recoverRootTask).not.toHaveBeenCalled()
  })

  it('refuses a session that is not the hand-off\'s supervisor, and a delegation of another graph', async () => {
    const { svc, recoverRootTask } = await fixture()
    // The root, a worker, a reviewer: none of them is the coordinator the ledger
    // recorded for this diagnosis.
    await expect(svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: 's-root' }))
      .rejects.toThrow(/is not the supervisor of diagnosis/)
    // A delegation into another store: the hand-off was delegated in its own
    // graph, and a recovery never crosses that boundary.
    const otherGraph = await fixture({
      delegation: { rootStoreId: 'sg-t-other', taskId: 't-root', diagnosisId: DIAGNOSIS, sessionId: SUPERVISOR, actor: ROOT_SESSION, at: '2026-09-28T00:00:00.000Z' },
    })
    await expect(otherGraph.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/belongs to store "sg-t-s-root"/)
    expect(recoverRootTask).not.toHaveBeenCalled()
    expect(otherGraph.recoverRootTask).not.toHaveBeenCalled()
  })

  it('refuses when this deployment wires no delegation source at all: the identity cannot be proven, so nothing is opened', async () => {
    const { svc, recoverRootTask } = await fixture({ wireDelegation: false })
    await expect(svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/wires no supervisor-delegation source/)
    expect(recoverRootTask).not.toHaveBeenCalled()
  })

  it('refuses an unknown diagnosis, a diagnosis naming a child task, and a source that already succeeded', async () => {
    // The hand-off names a diagnosis of this store — the ledger says so — and the
    // store does not hold it: an id nothing recorded is not a hand-off.
    const unknown = await fixture({
      delegation: { rootStoreId: STORE, taskId: 't-root', diagnosisId: 'd-ghost', sessionId: SUPERVISOR, actor: ROOT_SESSION, at: '2026-09-28T00:00:00.000Z' },
    })
    await expect(unknown.svc.coordinateRecovery({ sourceDiagnosisId: 'd-ghost', requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/holds no diagnosis "d-ghost"/)
    expect(unknown.recoverRootTask).not.toHaveBeenCalled()

    const child = await fixture({ diagnosis: diagnosis({ taskId: 't-member' }) })
    await expect(child.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/is a child of "t-root"/)

    // A successful source: not recoverable, and the suggestion it carries has no
    // frozen comparator this build could judge it by.
    const verified = await fixture({ sourceStatus: 'verified', runs: [{ runId: 'r-1', taskId: 't-root', status: 'verified' }] })
    const refusal = await verified.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR })
      .then(() => '', error => String(error))
    expect(refusal).toContain('a successful source is not recovered')
    expect(refusal).toContain('faster or cheaper')
    expect(verified.recoverRootTask).not.toHaveBeenCalled()

    const running = await fixture({ sourceStatus: 'running', runs: [{ runId: 'r-1', taskId: 't-root', status: 'running' }] })
    await expect(running.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/never hot-swaps a live run/)
    expect(running.recoverRootTask).not.toHaveBeenCalled()
  })

  it('refuses a recovery whose capability change is not in force, naming the state', async () => {
    for (const [state, expected] of [['proposed', 'is proposed'], ['decided', 'PROMOTE-decided but not applied']] as const) {
      const f = await fixture({ requestedCapabilities: ['new-row'], ledger: svc => capabilityProposal(svc, state) })
      const refusal = await f.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR })
        .then(() => '', error => String(error))
      expect(refusal, state).toContain('capability change this hand-off depends on')
      expect(refusal, state).toContain(expected)
      expect(f.recoverRootTask, state).not.toHaveBeenCalled()
    }
  })

  it('opens the attempt of a pure artifact gap: no proposal at all, the source\'s own rows resolve', async () => {
    const f = await fixture({ table: { 'store-row': { skills: ['store-skill'] } }, requestedCapabilities: ['store-row'], diagnosis: diagnosis({ proposals: [], reviewRefs: ['t-root#r-1'] }) })
    const outcome = await f.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-artifact' }, { sessionId: SUPERVISOR })
    expect(outcome.attempt).toBe('started')
    expect(outcome.runId).toBe('r-recovery')
    expect(outcome.handoff).toEqual({ sessionId: SUPERVISOR, actor: ROOT_SESSION, diagnosisId: DIAGNOSIS })
    expect(outcome.coordination.join('\n')).toContain('no proposal')
    // The runtime was asked for the source the store holds, under the caller's key.
    expect(f.recoverRootTask).toHaveBeenCalledTimes(1)
    expect(f.recoverRootTask.mock.calls[0]![1]).toEqual({
      sourceTaskId: 't-root',
      sourceRunId: 'r-1',
      sourceDiagnosisId: DIAGNOSIS,
      requestKey: 'k-artifact',
    })
    expect(f.recoverRootTask.mock.calls[0]![2]).toMatchObject({ sessionId: SUPERVISOR })
  })

  it('refuses a pure artifact gap whose own capability rows do not resolve, before the runtime is asked', async () => {
    const f = await fixture({ table: {}, requestedCapabilities: ['missing-row'] })
    const refusal = await f.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR })
      .then(() => '', error => String(error))
    expect(refusal).toContain('missing-row')
    expect(refusal).toContain('a pure artifact gap is recoverable, a capability gap is not')
    expect(f.recoverRootTask).not.toHaveBeenCalled()
  })

  it('refuses a second key while an attempt of the diagnosis is in flight, and passes the same key through', async () => {
    const inFlight = [{
      runId: 'r-attempt',
      taskId: 't-root',
      status: 'running',
      recovery: { sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1', requestedAt: '2026-09-28T00:00:02.000Z', reusedMembers: [] },
    }]
    const f = await fixture({ runs: [{ runId: 'r-1', taskId: 't-root', status: 'failed' }, ...inFlight] })
    const refusal = await f.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-2' }, { sessionId: SUPERVISOR })
      .then(() => '', error => String(error))
    expect(refusal).toContain('already has a recovery attempt in flight')
    expect(refusal).toContain('k-1')
    expect(f.recoverRootTask).not.toHaveBeenCalled()
    // The same key is not this plane's to answer: the runtime holds the record
    // and answers it, so the call passes through.
    await f.svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR })
    expect(f.recoverRootTask).toHaveBeenCalledTimes(1)
  })

  it('refuses when the store, the graph or the runtime this entry needs is not there', async () => {
    await expect((await fixture({ services: { task: false } })).svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/offers no task store/)
    await expect((await fixture({ services: { graphs: false } })).svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/offers no graph registry/)
    await expect((await fixture({ services: { runtime: false } })).svc.coordinateRecovery({ sourceDiagnosisId: DIAGNOSIS, requestKey: 'k-1' }, { sessionId: SUPERVISOR }))
      .rejects.toThrow(/offers no execution-recovery entry/)
  })
})
