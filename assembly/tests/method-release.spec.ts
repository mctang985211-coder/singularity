import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { beforeEach, expect, it, vi } from 'vitest'
import { digestOf } from '../../src/protocol/envelope.ts'
import { matrixOf, parseSuite } from '../../src/measure/suite.ts'
import { MEASURE_PROTOCOL, type EvaluationState } from '../../src/measure/protocol.ts'
import { TASK_PROTOCOL, type TaskState } from '../../src/task/protocol.ts'
import type { TransferState } from '../../src/task/transfer.ts'
import type { Apparatus } from '../src/apparatus.ts'
import { releaseMethod } from '../src/method-release.ts'

const ports = vi.hoisted(() => ({ draft: vi.fn(), review: vi.fn(), approve: vi.fn(), publish: vi.fn() }))
vi.mock('../../src/release/commands.ts', () => ({ createReleaseCommands: () => ({
  draftFromDecision: ports.draft, approveReview: ports.approve, publish: ports.publish,
}) }))
vi.mock('../src/method.ts', () => ({ methodEnvironment: () => 'methods',
  publishedMethod: () => ({ environmentId: 'methods', revisionId: 'h0', digest: 'a'.repeat(64) }),
  loadMethod: async () => ({ assets: { workflowGuidance: '', templates: [], skills: [], tools: [] } }),
}))
vi.mock('../src/review.ts', () => ({ reviewSubject: ports.review }))
vi.mock('../src/sealed.ts', () => ({ sealedBytes: async () => Buffer.from('{}') }))

const h0 = { environmentId: 'methods', revisionId: 'h0', digest: 'a'.repeat(64) }
const h1 = { ...h0, revisionId: 'h1', digest: 'b'.repeat(64) }
const profile = 'c'.repeat(64), roundId = 'campaign:validation'
const suite = parseSuite({ version: 1, suiteId: 'frozen', failureQuality: 0,
  cases: ['a', 'b', 'c'].map(id => ({ caseId: id, familyId: id, sourceId: id, split: 'validation', trials: 2, weight: 1,
    hardGuards: [], contract: { goal: id, artifact: 'result.txt', inputs: [], criteria: [{ criterionId: 'correct', statement: 'correct' }] } })) })

function fixture() {
  const matrix = matrixOf(suite, 'validation', profile)
  const evaluation = (candidate: typeof h0, cost: number): { -readonly [K in keyof EvaluationState]: EvaluationState[K] } => ({
    evaluationId: candidate === h0 ? `${roundId}:bootstrap:evaluation` : `${roundId}:0:candidate:evaluation`,
    baseline: h0, candidate, matrix, trials: matrix.slots.length, checks: [], judgement: [], missed: [],
    metric: { measured: { criterionId: 'quality', statement: 'Protected quality', verifierRef: 'oracle',
      verifierVersion: '1', implementationDigest: 'e'.repeat(64) }, unit: 'score', direction: 'higher' },
    observed: matrix.slots.map((_, slot) => ({ slot, quality: 1, cost, artifactDigest: 'd'.repeat(64), inputDigests: [],
      implementationDigest: 'e'.repeat(64), verifierRef: 'oracle', verifierVersion: '1', guardsMet: true })),
  })
  let transfer: TransferState = { baseline: h0, champion: h1, suiteDigest: digestOf(suite), executionProfileDigest: profile,
    roundId, consumed: true, outcome: 'improved', report: { attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`), name: 'transfer-report.json', bytes: 2 } }
  const baseline = evaluation(h0, 100), candidate = evaluation(h1, 50)
  const evaluations = new Map([[baseline.evaluationId, baseline], [candidate.evaluationId, candidate]])
  let status = 'running', rootStatus = 'running'
  const task = () => ({ taskId: 'campaign', transfer, runs: { analysis: { status, stage: 'working', relatedTo: { taskId: 'root', runId: 'business' } } } })
  const root = () => ({ taskId: 'root', runs: {}, rsi: { status: rootStatus } })
  const apparatus = { domain: { suite }, store: { load: () => ({ statesOf: (protocol: string) =>
    protocol === TASK_PROTOCOL ? new Map([['campaign', task() as unknown as TaskState]]) : protocol === MEASURE_PROTOCOL ? evaluations : new Map(),
    stateOf: (_protocol: string, _version: number, subject: string) => subject === 'root' ? root() : task(),
  }) } } as unknown as Apparatus
  ports.draft.mockResolvedValue({ payload: { revisionId: h1.revisionId, contentDigest: h1.digest, draftDigest: 'f'.repeat(64),
    basis: { kind: 'decision', evaluationId: candidate.evaluationId, expected: h0.revisionId } } })
  return { baseline, candidate, fail: () => { status = 'failed' }, endRoot: (outcome: string) => { rootStatus = outcome },
    change: (edit: Partial<TransferState>) => { transfer = { ...transfer, ...edit } },
    release: () => releaseMethod(apparatus, {}, {} as never, 'release', { roundId }, new AbortController().signal) }
}

beforeEach(() => {
  Object.values(ports).forEach(port => port.mockReset())
  ports.review.mockResolvedValue({ reviewId: 'independent-publication-review' })
})

it('publishes only after recomputing independent paired evidence for the frozen champion', async () => {
  const held = fixture()
  await expect(held.release()).resolves.toMatchObject({ revision: h1, approvalId: 'independent-publication-review' })
  expect(ports.review).toHaveBeenCalledOnce()
  expect(ports.approve).toHaveBeenCalledOnce()
  expect(ports.publish).toHaveBeenCalledWith(expect.objectContaining({ expected: 'h0', to: 'h1' }))
})

it.each(['entry', 'review', 'approval'] as const)('refuses publication when its analysis ends at %s', async boundary => {
  const held = fixture()
  if (boundary === 'entry') held.fail()
  if (boundary === 'review') ports.review.mockImplementation(async () => { held.fail(); return { reviewId: 'completed-review' } })
  if (boundary === 'approval') ports.approve.mockImplementation(async () => { held.fail() })
  await expect(held.release()).rejects.toThrow('publication requires its working RSI Run')
  expect(ports.publish).not.toHaveBeenCalled()
})

it.each(['cancelled', 'failed'] as const)('refuses publication while its root RSI is %s even if analysis is still working', async outcome => {
  const held = fixture()
  ports.approve.mockImplementation(async () => { held.endRoot(outcome) })
  await expect(held.release()).rejects.toThrow('publication requires its running root RSI')
  expect(ports.publish).not.toHaveBeenCalled()
})

it.each(['evolve', 'suite', 'profile', 'baseline', 'champion', 'unconsumed', 'regression', 'missing-cost', 'truncated-matrix', 'failed-guard', 'unknown-trial'] as const)(
  'rejects a declared improved transfer with incompatible %s evidence before review/publication', async fault => {
    const held = fixture()
    if (fault === 'evolve') {
      held.baseline.matrix = { ...held.baseline.matrix!, split: 'evolve' }
      held.candidate.matrix = held.baseline.matrix
    }
    if (fault === 'suite') held.change({ suiteDigest: '0'.repeat(64) })
    if (fault === 'profile') held.change({ executionProfileDigest: '0'.repeat(64) })
    if (fault === 'baseline') held.change({ baseline: h1 })
    if (fault === 'champion') held.change({ champion: h0 })
    if (fault === 'unconsumed') held.change({ consumed: false })
    if (fault === 'regression') held.candidate.observed = held.candidate.observed.map(t => ({ ...t, quality: .5 }))
    if (fault === 'missing-cost') held.candidate.observed = held.candidate.observed.map(({ cost: _, ...t }) => t)
    if (fault === 'truncated-matrix') {
      held.baseline.matrix = { ...held.baseline.matrix!, slots: held.baseline.matrix!.slots.slice(0, 2) }
      held.candidate.matrix = held.baseline.matrix
      held.baseline.observed = held.baseline.observed.slice(0, 2)
      held.candidate.observed = held.candidate.observed.slice(0, 2)
    }
    if (fault === 'failed-guard') held.candidate.observed = held.candidate.observed.map((t, i) => ({ ...t, guardsMet: i !== 0 }))
    if (fault === 'unknown-trial') {
      held.candidate.observed = held.candidate.observed.slice(1)
      held.candidate.missed = [{ slot: 0, reason: 'provider unavailable', verifierRef: 'oracle', verifierVersion: '1' }]
    }
    await expect(held.release()).rejects.toThrow('unapproved-revision')
    expect(ports.review).not.toHaveBeenCalled()
    expect(ports.approve).not.toHaveBeenCalled()
    expect(ports.publish).not.toHaveBeenCalled()
  },
)
