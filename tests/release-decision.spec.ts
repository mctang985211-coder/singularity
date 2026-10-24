import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlSessionStore } from '../src/control/session-store.ts'
import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_VERSION,
  type EnvironmentState,
} from '../src/environment/protocol.ts'
import {
  declareMeasureProtocol,
  MEASURE_KINDS,
  MEASURE_PROTOCOL,
  MEASURE_VERSION,
  type EvaluationState,
} from '../src/measure/protocol.ts'
import { caliberDigestOf, projectEvaluation } from '../src/measure/view.ts'
import { digestOf } from '../src/protocol/envelope.ts'
import { foldSubjects } from '../src/protocol/fold.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { refuse } from '../src/protocol/refusal.ts'
import { createReleaseCommands } from '../src/release/commands.ts'
import {
  declareReleaseProtocol,
  RELEASE_KINDS,
  RELEASE_PROTOCOL,
  RELEASE_VERSION,
  type ReleaseState,
} from '../src/release/protocol.ts'
import { createStrategyCommands } from '../src/strategy/commands.ts'
import {
  declareStrategyProtocol,
  STRATEGY_KINDS,
  STRATEGY_PROTOCOL,
  STRATEGY_VERSION,
} from '../src/strategy/protocol.ts'
import {
  declareTaskProtocol,
  TASK_PROTOCOL,
  TASK_VERSION,
  verifierRoleOf,
  type RevisionRef,
  type TaskState,
} from '../src/task/protocol.ts'
import { asyncRefusalOf } from './fixtures.ts'

const metric = {
  criterionId: 'quality',
  statement: 'quality score',
  verifierRef: 'meter',
  verifierVersion: '1',
  implementationDigest: 'a'.repeat(64),
}
const calibration = { floor: 0.01, source: 'declared' as const }
const deployments: { context: Context; root: string; store: ControlSessionStore }[] = []
afterEach(async () => {
  for (const h of deployments.splice(0)) {
    await h.store.close()
    await h.context.fiber.dispose()
    await rm(h.root, { recursive: true, force: true })
  }
})

async function setup(quality = 0.8, decide = true, report = true) {
  const root = await mkdtemp(join(tmpdir(), 'release-decision-'))
  const context = new Context()
  await context.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const registry = new ProtocolRegistry()
  declareEnvironmentProtocol(registry)
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  declareReleaseProtocol(registry)
  declareTaskProtocol(registry)
  const store = await ControlSessionStore.open({
    persistence: context.sessionPersistence,
    controlId: 'release-decision',
    registry,
    subjects: {
      environment: 'environment',
      publisher: 'publisher',
      scheduler: 'scheduler',
      strategy: 'strategy',
      approver: 'approval',
      [verifierRoleOf(metric)]: 'meter',
    },
  })
  deployments.push({ context, root, store })
  const revision = async (revisionId: string): Promise<RevisionRef> => {
    const manifest = { skill: revisionId }
    await store.emit({
      commandId: revisionId,
      protocol: ENVIRONMENT_PROTOCOL,
      version: ENVIRONMENT_VERSION,
      kind: ENVIRONMENT_KINDS.revisionCreated,
      subject: 'library',
      payload: { revisionId, manifest },
    })
    return { environmentId: 'library', revisionId, digest: digestOf(manifest) }
  }
  const baseline = await revision('baseline')
  const candidate = await revision('candidate')
  const releases = createReleaseCommands({ store })
  const release = () => store.load().stateOf<ReleaseState>(RELEASE_PROTOCOL, RELEASE_VERSION, 'library')!
  const approve = async (commandId: string) =>
    store.emit({
      commandId,
      protocol: RELEASE_PROTOCOL,
      version: RELEASE_VERSION,
      kind: RELEASE_KINDS.approved,
      subject: 'library',
      payload: {
        revisionId: release().revisionId,
        draftDigest: release().draftDigest,
        approvedBy: 'reviewer',
        approvalId: commandId,
      },
    })
  await releases.draft({ commandId: 'bootstrap', revision: baseline })
  await approve('bootstrap-approved')
  await releases.publish({ commandId: 'bootstrap-published', environmentId: 'library', expected: '', to: 'baseline' })
  const evaluate = async (evaluationId: string, target: RevisionRef, score: number) => {
    await store.emit({
      commandId: evaluationId + ':open',
      protocol: MEASURE_PROTOCOL,
      version: MEASURE_VERSION,
      kind: MEASURE_KINDS.evaluationOpened,
      subject: evaluationId,
      payload: {
        baseline,
        candidate: target,
        run: { taskId: evaluationId, runId: 'run' },
        context: 'b'.repeat(64),
        metric: { measured: metric, unit: 'points', direction: 'higher' },
        weights: { quality: 1, cost: 1 },
        trials: 1,
        judgement: [],
      },
    })
    await store.emit({
      commandId: evaluationId + ':trial',
      protocol: MEASURE_PROTOCOL,
      version: MEASURE_VERSION,
      kind: MEASURE_KINDS.trialRecorded,
      subject: evaluationId,
      payload: {
        slot: 0,
        quality: score,
        cost: 1,
        artifactDigest: 'c'.repeat(64),
        inputDigests: [],
        verifierRef: metric.verifierRef,
        verifierVersion: metric.verifierVersion,
        implementationDigest: metric.implementationDigest,
      },
    })
  }
  await evaluate('baseline-evaluation', baseline, 0.5)
  const baselineEvaluation = store
    .load()
    .stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'baseline-evaluation')!
  const strategy = createStrategyCommands({
    store,
    calibration,
    measuresAt: cut => ({
      entries: cut.entries(),
      evaluationOf: evaluationId => {
        const state = cut.stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
        return state?.candidate === undefined
          ? undefined
          : {
              evaluationId,
              ...projectEvaluation(state),
              caliberDigest: caliberDigestOf(state)!,
              baseline: state.baseline!,
              candidate: state.candidate,
            }
      },
      incumbentBelow: (pin, cutoff) => {
        const states = foldSubjects<EvaluationState>(
          registry,
          cut.entries().filter(fact => fact.seq < cutoff),
          MEASURE_PROTOCOL,
          MEASURE_VERSION,
        )
        const state = [...states.values()].find(state => state.candidate?.revisionId === pin.revisionId)
        const view = state === undefined ? undefined : projectEvaluation(state)
        return view === undefined || view.quality === null ? null : { quality: view.quality, cost: view.cost }
      },
    }),
  })
  await strategy.openRound({
    campaignId: 'test-campaign',
    commandId: 'round-open',
    roundId: 'round',
    round: 1,
    incumbent: baseline,
    candidates: 1,
    historyCutoff: store.load().entries().length,
    caliber: caliberDigestOf(baselineEvaluation)!,
    weights: { quality: 1, cost: 1 },
  })
  if (report) await evaluate('candidate-evaluation', candidate, quality)
  await strategy.submitCandidate({
    commandId: 'candidate-submit',
    roundId: 'round',
    slot: 0,
    revision: candidate,
    evaluationId: 'candidate-evaluation',
    edits: [{ asset: 'skill', target: 'count' }],
  })
  const decision = decide ? await strategy.decideRound({ commandId: 'round-decide', roundId: 'round' }) : undefined
  return { store, registry, releases, release, approve, decision, baseline, candidate, evaluate }
}

describe('release@3 binds committed strategy decisions', () => {
  it('drafts only the committed winner and binds its report, decision/calibration citation and expected head', async () => {
    const h = await setup()
    const draft = await h.releases.draftFromDecision({ commandId: 'decision-draft', roundId: 'round' })
    const report = h.store.load().stateOf<EvaluationState>(MEASURE_PROTOCOL, MEASURE_VERSION, 'candidate-evaluation')!
    const basis = {
      kind: 'decision',
      roundId: 'round',
      decisionSeq: h.decision!.seq,
      decisionDigest: h.decision!.digest,
      evaluationId: 'candidate-evaluation',
      reportDigest: digestOf(report),
      expected: 'baseline',
    }
    expect(draft.payload).toEqual({
      revisionId: 'candidate',
      contentDigest: h.candidate.digest,
      draftDigest: digestOf({ revision: h.candidate, basis }),
      basis,
    })
    expect(await h.releases.draftFromDecision({ commandId: 'decision-draft', roundId: 'round' })).toBe(draft)
    expect(h.registry.versionsOf(RELEASE_PROTOCOL)).toEqual([3])
  })

  it.each(['preview', 'no-winner'] as const)(
    'refuses a %s without replacing the approved bootstrap draft',
    async state => {
      const h = await setup(state === 'no-winner' ? 0.4 : 0.8, state !== 'preview')
      const before = h.release()
      expect(
        await asyncRefusalOf(() => h.releases.draftFromDecision({ commandId: 'decision-draft', roundId: 'round' })),
      ).toMatchObject({ code: 'illegal-transition' })
      expect(h.release()).toEqual(before)
    },
  )

  it('publishes the bound winner after approval while late reports do not rewrite its basis', async () => {
    const h = await setup()
    await h.releases.draftFromDecision({ commandId: 'decision-draft', roundId: 'round' })
    const basis = h.release().basis
    await h.evaluate('late-evaluation', h.candidate, 0.1)
    await h.approve('decision-approved')
    await h.releases.publish({
      commandId: 'decision-publish',
      environmentId: 'library',
      expected: 'baseline',
      to: 'candidate',
    })
    expect(h.release().basis).toEqual(basis)
    expect(
      h.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, 'library')!.pointer,
    ).toBe('candidate')
  })

  it('refuses publication after the expected head moves and cannot rebase the approved decision', async () => {
    const h = await setup()
    await h.releases.draftFromDecision({ commandId: 'decision-draft', roundId: 'round' })
    await h.approve('decision-approved')
    await h.store.emit({
      commandId: 'head-moved',
      protocol: ENVIRONMENT_PROTOCOL,
      version: ENVIRONMENT_VERSION,
      kind: ENVIRONMENT_KINDS.pointerSwitched,
      subject: 'library',
      payload: { expected: 'baseline', to: 'candidate' },
    })
    expect(
      await asyncRefusalOf(() =>
        h.releases.publish({
          commandId: 'decision-publish',
          environmentId: 'library',
          expected: 'candidate',
          to: 'candidate',
        }),
      ),
    ).toMatchObject({ code: 'illegal-transition' })
  })

  it.each(['cancelled', 'failed', 'analysis-failed'] as const)(
    'checks queued %s facts before committing publication',
    async outcome => {
      const h = await setup()
      await h.releases.draftFromDecision({ commandId: 'decision-draft', roundId: 'round' })
      await h.approve('decision-approved')
      const taskFact = (subject: string, kind: string, payload: unknown) =>
        h.store.emit({
          commandId: `${subject}:${kind}:${h.store.load().entries().length}`,
          protocol: TASK_PROTOCOL,
          version: TASK_VERSION,
          subject,
          kind,
          payload,
        })
      for (const taskId of ['root', 'analysis']) {
        await taskFact(taskId, 'task/admitted', {
          contract: {
            goal: taskId,
            artifact: 'report.txt',
            inputs: [],
            criteria: [{ criterionId: 'complete', statement: 'complete the task' }],
          },
        })
        await taskFact(taskId, 'task/assigned', { agentId: taskId, agentIdentity: 'scheduler' })
        await taskFact(taskId, 'run/started', {
          runId: 'run',
          revision: h.baseline,
          purpose: taskId === 'root' ? 'solve' : 'improve',
          ...(taskId === 'analysis' ? { relatedTo: { taskId: 'root', runId: 'run' } } : {}),
        })
      }
      await taskFact('root', 'run/failed', { runId: 'run', cause: 'business', reason: 'no answer' })
      await taskFact('root', 'task/closed', { runId: 'run', reason: 'failed' })
      await taskFact('root', 'rsi/status', { status: 'pending', detail: 'queued analysis' })
      await taskFact('root', 'rsi/status', {
        status: 'running',
        detail: 'analysis started',
        trace: { attachmentId: `sha256:${'d'.repeat(64)}`, name: 'subject.json', bytes: 2 },
      })
      const task = (taskId: string) => h.store.load().stateOf<TaskState>(TASK_PROTOCOL, TASK_VERSION, taskId)!
      const active = () => {
        if (task('root').rsi?.status !== 'running' || task('analysis').runs['run']!.status !== 'running')
          refuse('illegal-transition', 'publication requires active analysis')
      }
      const releases = createReleaseCommands({ store: h.store, require: active })
      const end =
        outcome === 'analysis-failed'
          ? taskFact('analysis', 'run/failed', { runId: 'run', cause: 'runtime', reason: 'provider failed' })
          : taskFact('root', 'rsi/status', { status: outcome, detail: 'analysis ended' })
      // The terminal fact is queued, but ordinary reads still see the previous committed cut.
      expect(task('root').rsi!.status).toBe('running')
      expect(task('analysis').runs['run']!.status).toBe('running')
      active()
      const results = await Promise.allSettled([
        end,
        releases.publish({
          commandId: 'queued-publish',
          environmentId: 'library',
          expected: 'baseline',
          to: 'candidate',
        }),
      ])
      expect(results[0]!.status).toBe('fulfilled')
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: {
          refusal: {
            code: 'illegal-transition',
            detail: 'publication requires active analysis',
          },
        },
      })
      expect(
        h.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, 'library')!.pointer,
      ).toBe('baseline')
      expect(
        h.store
          .load()
          .entries()
          .some(fact => fact.commandId === 'queued-publish'),
      ).toBe(false)
    },
  )

  it('refuses a committed winner whose evaluation report is missing from its decision cut', async () => {
    const h = await setup(0.8, false, false)
    await h.store.emit({
      commandId: 'unbacked-decision',
      protocol: STRATEGY_PROTOCOL,
      version: STRATEGY_VERSION,
      kind: STRATEGY_KINDS.roundDecided,
      subject: 'round',
      payload: { winner: 0, outcomes: [{ slot: 0, admitted: true, reason: 'selected' }], calibration },
    })
    expect(
      await asyncRefusalOf(() => h.releases.draftFromDecision({ commandId: 'decision-draft', roundId: 'round' })),
    ).toMatchObject({ code: 'illegal-transition', detail: expect.stringContaining('no evaluation report') })
  })

  it('rechecks a hand-framed approved report binding before switching the head', async () => {
    const h = await setup()
    const draft = await h.releases.draftFromDecision({ commandId: 'decision-draft', roundId: 'round' })
    const payload = draft.payload as { basis: NonNullable<ReleaseState['basis']> }
    const basis = { ...payload.basis, reportDigest: 'f'.repeat(64) }
    const forged = { ...(draft.payload as object), basis, draftDigest: digestOf({ revision: h.candidate, basis }) }
    await h.store.emit({
      commandId: 'forged-draft',
      protocol: RELEASE_PROTOCOL,
      version: RELEASE_VERSION,
      kind: RELEASE_KINDS.drafted,
      subject: 'library',
      payload: forged,
    })
    await h.approve('forged-approved')
    expect(
      await asyncRefusalOf(() =>
        h.releases.publish({
          commandId: 'forged-publish',
          environmentId: 'library',
          expected: 'baseline',
          to: 'candidate',
        }),
      ),
    ).toMatchObject({ code: 'stale-approval' })
    expect(
      h.store.load().stateOf<EnvironmentState>(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, 'library')!.pointer,
    ).toBe('baseline')
  })

  it('refuses release version 1 instead of interpreting an approval that only bound target content', async () => {
    const h = await setup()
    expect(
      await asyncRefusalOf(() =>
        h.store.emit({
          commandId: 'old-draft',
          protocol: RELEASE_PROTOCOL,
          version: 1,
          kind: RELEASE_KINDS.drafted,
          subject: 'library',
          payload: { revisionId: 'candidate', draftDigest: h.candidate.digest },
        }),
      ),
    ).toMatchObject({ code: 'version-mismatch' })
  })
})
