import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { AGENT_PROTOCOL, type AgentState } from '../../src/agent/protocol.ts'
import { ENVIRONMENT_PROTOCOL, type EnvironmentState } from '../../src/environment/protocol.ts'
import { REVIEW_PROTOCOL, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, type RunState, type TaskState } from '../../src/task/protocol.ts'
import type { TaskContract } from '../../src/task/contract.ts'
import type { Apparatus } from '../src/apparatus.ts'
import { sha256 } from '../src/ids.ts'
import { memoryCheckpointOf, memoryContextOf, type MemoryContext, type MemoryDraft, type MemorySource } from '../src/memory.ts'
import type { FrozenInputProducer } from '../src/review.ts'

const method = { environmentId: 'methods', revisionId: 'pinned', digest: '1'.repeat(64) }
const scope: MemoryContext['scope'] = { kind: 'task', taskId: 'consumer', runId: 'current', contractDigest: '2'.repeat(64), method }
const context: MemoryContext = {
  scope,
  evidenceRefs: [{ taskId: 'producer', runId: 'selected', status: 'verified', artifactDigest: '6'.repeat(64) }],
  excludedTexts: ['Deliver the bounded count', 'The count must match the frozen bytes', 'Read the verified producer'],
}
const source: MemorySource = { sessionId: 'consumer-session', eventCount: 7, digest: '3'.repeat(64), inputDigest: '4'.repeat(64) }
const draft: MemoryDraft = { decisions: [], evidenceRefs: [], hypotheses: [], openQuestions: [], exclusions: [] }

describe('a structured checkpoint contains working notes and exact references', () => {
  it('consolidates exact notes without copying authority text, truncating findings or certifying hypotheses', () => {
    const finding = 'A bounded experiment disproved the punctuation hypothesis. '.repeat(500)
    const model = { decisions: ['Deliver the bounded count', ' Use the reviewed extraction ', 'Use the reviewed extraction'],
      evidenceRefs: [{ taskId: 'producer', runId: 'selected' }, { taskId: 'producer', runId: 'selected' }],
      hypotheses: ['The count must match the frozen bytes', 'A boundary case may change the result'],
      openQuestions: ['Which input encoding was intended?', 'Which input encoding was intended?'],
      exclusions: ['Read the verified producer', finding] }
    const before = JSON.stringify({ context, source, model })
    const checkpoint = memoryCheckpointOf(context, source, model)
    expect(Object.keys(checkpoint).sort()).toEqual(['decisions', 'evidenceRefs', 'exclusions', 'formatVersion', 'hypotheses', 'openQuestions', 'scope', 'sources'])
    expect(checkpoint).toMatchObject({ formatVersion: 1, scope: context.scope, sources: [source],
      decisions: ['Use the reviewed extraction'], evidenceRefs: context.evidenceRefs,
      hypotheses: ['A boundary case may change the result'], openQuestions: ['Which input encoding was intended?'], exclusions: [finding.trim()] })
    expect(checkpoint).not.toHaveProperty('verdict')
    expect(checkpoint).not.toHaveProperty('contract')
    expect(JSON.stringify({ context, source, model })).toBe(before)
    expect(() => memoryCheckpointOf(context, source, checkpoint)).toThrow('unknown member')
  })

  it.each([
    ['a rewritten scope', { ...draft, scope: { taskId: 'another' } }],
    ['a copied contract', { ...draft, contract: { goal: 'another requirement' } }],
    ['a missing section', { decisions: [], evidenceRefs: [], hypotheses: [], exclusions: [] }],
    ['empty notes', { ...draft, decisions: ['  '] }],
    ['nontext notes', { ...draft, hypotheses: [true] }],
    ['invented certainty', { ...draft, evidenceRefs: [{ taskId: 'producer', runId: 'selected', verified: true }] }],
    ['a different Run', { ...draft, evidenceRefs: [{ taskId: 'producer', runId: 'later' }] }],
    ['an unrelated Task', { ...draft, evidenceRefs: [{ taskId: 'unrelated', runId: 'selected' }] }],
  ])('rejects %s instead of silently repairing a malformed checkpoint', (_label, supplied) => {
    expect(() => memoryCheckpointOf(context, source, supplied)).toThrow()
  })

  it.each([
    { ...source, digest: 'unsealed' },
    { ...source, inputDigest: 'unknown' },
    { ...source, eventCount: -1 },
    { ...source, eventCount: 1.5 },
    { ...source, sessionId: '' },
    { ...source, transcript: 'copied body' },
  ])('requires a closed source with exact native transcript and compaction input digests', (supplied) => {
    expect(() => memoryCheckpointOf(context, supplied, draft)).toThrow()
  })
})

const contract = (goal: string, inputs: TaskContract['inputs'] = []): TaskContract => ({ goal, artifact: 'answer.txt', inputs,
  criteria: [{ criterionId: 'accurate', statement: 'The result accurately reflects its inputs.' }] })
function run(runId: string, status: RunState['status'] = 'running'): RunState {
  return { runId, status, stage: status === 'running' ? 'working' : 'submitted', emitter: 'agent', actor: 'executor',
    revision: method, purpose: 'solve', startedAt: '2026-10-15T00:00:00Z', evidence: [], consumed: [],
    ...(status !== 'verified' ? {} : { submission: { requestId: runId, requestDigest: '5'.repeat(64), artifactDigest: '6'.repeat(64),
      inputDigests: [], files: { artifact: { attachmentId: AttachmentId(`sha256:${'6'.repeat(64)}`), name: 'answer.txt', bytes: 4 }, inputs: [] },
      source: { sessionId: 'producer', eventCount: 1, digest: '7'.repeat(64) },
    } }),
  }
}
function projection(review?: ReviewRun, producers: readonly FrozenInputProducer[] = []) {
  const tasks: TaskState[] = [
    { taskId: 'consumer', contract: contract('Deliver the bounded count', [{ name: 'prior.txt', source: { kind: 'artifact', taskId: 'producer' } }]),
      contractDigest: '2'.repeat(64), responsibility: { agentId: 'consumer-agent', agentIdentity: 'consumer-identity', assignedAt: 'now' },
      runs: { current: { ...run('current'), actor: 'consumer-identity' } } },
    { taskId: 'producer', contract: contract('Extract the frozen input', [{ name: 'upstream.txt', source: { kind: 'artifact', taskId: 'upstream' } }]),
      runs: { selected: run('selected', 'verified'), later: run('later', 'verified'), unfinished: run('unfinished') } },
    { taskId: 'upstream', contract: contract('A separate upstream responsibility'), runs: { verified: run('verified', 'verified') } },
    { taskId: 'unrelated', contract: contract('An unrelated responsibility'), runs: { verified: run('verified', 'verified') } },
  ]
  const environment: EnvironmentState = { environmentId: 'methods', revisions: { pinned: { revisionId: 'pinned', contentDigest: method.digest,
    at: 'now', manifest: { rootTemplate: 'bounded', templates: [{ goal: 'Deliver the bounded count', guidance: 'Read the verified producer',
      criteria: tasks[0]!.contract!.criteria }], skills: [{ name: 'count', description: 'ASCII counting', capabilities: [], requiredTools: [],
        content: 'Preserve the source order while extracting ASCII letters.' }], tools: [] } } } }
  const bytes = Buffer.from(JSON.stringify({ inputProducers: producers }))
  const held = new Map(tasks.map((task) => [task.taskId, task]))
  const reviews = new Map(review === undefined ? [] : [[review.reviewId, review]])
  const agents = new Map<string, AgentState>([
    ['consumer-agent', { agentId: 'consumer-agent', role: 'root', sessionId: 'consumer-session', openedAt: 'now' }],
    ['reviewer', { agentId: 'reviewer', role: 'review', sessionId: 'reviewer-session', openedAt: 'now' }],
  ])
  const apparatus = { store: { load: () => ({
    statesOf: (protocol: string) => protocol === TASK_PROTOCOL ? held : protocol === REVIEW_PROTOCOL ? reviews : new Map(),
    stateOf: (protocol: string, _version: number, id: string) => protocol === ENVIRONMENT_PROTOCOL ? environment
      : protocol === AGENT_PROTOCOL ? agents.get(id) : held.get(id),
  }), identityOf: (key: string) => key === 'agent:consumer-agent' ? 'consumer-identity' : key === 'agent:reviewer' ? 'reviewer-identity' : undefined },
    attachments: { readFileStream: async function* () { yield bytes } } } as unknown as Apparatus
  return { apparatus, tasks, bytes, held, reviews, agents }
}

it('projects the current contract identity and only readable verified Runs without adding body text', async () => {
  const { apparatus, tasks } = projection()
  const held = await memoryContextOf(apparatus, 'consumer-agent')
  expect(held.scope).toEqual(context.scope)
  expect(held.evidenceRefs).toEqual(['selected', 'later'].map(runId => ({ taskId: 'producer', runId, status: 'verified', artifactDigest: '6'.repeat(64) })))
  expect(held.excludedTexts).toEqual(expect.arrayContaining(['Deliver the bounded count', 'Read the verified producer', tasks[0]!.contract!.criteria[0]!.statement]))
  expect(() => memoryCheckpointOf(held, source, { ...draft, evidenceRefs: [{ taskId: 'producer', runId: 'unfinished' }] })).toThrow('visible verified Run scope')
  expect(memoryCheckpointOf(held, source, { ...draft, decisions: ['The unfinished Run is verified'] }).evidenceRefs).toEqual([])
  expect(memoryCheckpointOf(held, source, { ...draft, decisions: [JSON.stringify(tasks[0]!.contract)] }).decisions).toEqual([])
  expect(memoryCheckpointOf(held, source, { ...draft, decisions: ['Preserve the source order while extracting ASCII letters.'] }).decisions).toEqual([])
  expect(tasks[0]!.runs['current']!.consumed).toEqual([])
  await expect(memoryContextOf(apparatus, 'stranger')).rejects.toThrow('assigned Task Run')
})

it('projects current responsibility without granting earlier roots evidence rights', async () => {
  const { apparatus, tasks, held } = projection()
  const original = tasks[0]!
  held.set('consumer', { ...original, runs: {
    previous: { ...run('previous', 'failed'), actor: 'consumer-identity', revision: { ...method, revisionId: 'previous-method' } },
    current: original.runs['current']!,
  } })
  held.set('consumer', { ...held.get('consumer')!, responsibility: {
    agentId: 'another-agent', agentIdentity: 'another-identity', assignedAt: 'later',
  } })
  const next: TaskState = { taskId: 'next-root', contract: contract('Investigate a new root'), contractDigest: '9'.repeat(64),
    responsibility: original.responsibility!, runs: { next: { ...run('next'), actor: 'consumer-identity' } } }
  held.set(next.taskId, next)
  held.set('lookalike', { ...next, taskId: 'lookalike', responsibility: {
    agentId: 'another-agent', agentIdentity: 'another-identity', assignedAt: 'now',
  },
    runs: { foreign: { ...run('foreign'), actor: 'another-identity' } } })
  const current = await memoryContextOf(apparatus, 'consumer-agent')
  expect(current.scope).toEqual({ ...scope, taskId: 'next-root', runId: 'next', contractDigest: next.contractDigest })
  expect(current.evidenceRefs).toEqual([])
  expect(() => memoryCheckpointOf(current, source, { ...draft, evidenceRefs: [{ taskId: 'producer', runId: 'selected' }] })).toThrow('visible verified Run scope')
})

it('projects a cold historical responsibility without registering a live caller identity', async () => {
  const h = projection()
  Object.assign(h.apparatus.store, { identityOf: () => undefined })
  expect((await memoryContextOf(h.apparatus, 'consumer-agent')).scope).toEqual(context.scope)
  const task = h.held.get('consumer')!
  h.held.set('consumer', { ...task, runs: { current: { ...task.runs['current']!, actor: 'different-identity' } } })
  await expect(memoryContextOf(h.apparatus, 'consumer-agent')).rejects.toThrow('assigned Task Run')
})

it('preserves exact frozen producer Runs for an independent review even after a newer Run verifies', async () => {
  const seed = projection(), producer = seed.tasks[1]!, selected = producer.runs['selected']!
  const frozen: FrozenInputProducer = { name: 'prior.txt', taskId: 'producer', contract: producer.contract!, runId: selected.runId,
    revision: method, status: 'verified', artifact: selected.submission!.files.artifact, artifactDigest: selected.submission!.artifactDigest,
    source: selected.submission!.source, evidence: selected.evidence }
  const bytes = Buffer.from(JSON.stringify({ inputProducers: [frozen] }))
  const review: ReviewRun = { reviewId: 'acceptance', agentId: 'reviewer', identity: 'reviewer-identity', sessionId: 'reviewer-session',
    workspace: '/review', model: { provider: 'test', model: 'test' }, method, status: 'running', children: [],
    target: { kind: 'acceptance', taskId: 'consumer', runId: 'current', contractDigest: '2'.repeat(64), artifactDigest: '8'.repeat(64) },
    criteria: seed.tasks[0]!.contract!.criteria, subject: { attachmentId: AttachmentId(`sha256:${sha256(bytes)}`), name: 'subject.json', bytes: bytes.length },
    subjectDigest: sha256(bytes),
  }
  const { apparatus, reviews, agents } = projection(review, [frozen])
  const earlier = { ...review, reviewId: 'earlier-review', subjectDigest: '9'.repeat(64), method: { ...method, revisionId: 'earlier' } }
  reviews.clear()
  reviews.set(earlier.reviewId, earlier)
  reviews.set('different-session', { ...review, reviewId: 'different-session', sessionId: 'another-session' })
  reviews.set('different-identity', { ...review, reviewId: 'different-identity', identity: 'another-identity' })
  reviews.set('different-agent', { ...review, reviewId: 'different-agent', agentId: 'another-agent' })
  reviews.set(review.reviewId, review)
  const held = await memoryContextOf(apparatus, 'reviewer')
  expect(held.scope).toEqual({ kind: 'review', reviewId: review.reviewId, subjectDigest: review.subjectDigest, method })
  expect(held.evidenceRefs).toEqual(context.evidenceRefs)
  expect(memoryCheckpointOf(held, source, { ...draft, evidenceRefs: [{ taskId: 'producer', runId: 'selected' }] }).evidenceRefs)
    .toEqual(context.evidenceRefs)
  for (const ref of [{ taskId: 'producer', runId: 'later' }, { taskId: 'upstream', runId: 'verified' }])
    expect(() => memoryCheckpointOf(held, source, { ...draft, evidenceRefs: [ref] })).toThrow('visible verified Run scope')
  agents.set('reviewer', { ...agents.get('reviewer')!, sessionId: 'foreign-session' })
  await expect(memoryContextOf(apparatus, 'reviewer')).rejects.toThrow('assigned Task Run')
})
