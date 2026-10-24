import { expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { AGENT_PROTOCOL, type AgentState } from '../../src/agent/protocol.ts'
import { REVIEW_PROTOCOL, type ReviewRun } from '../../src/review/protocol.ts'
import { TASK_PROTOCOL, type TaskState } from '../../src/task/protocol.ts'
import type { Apparatus } from '../src/apparatus.ts'
import { readForAgent } from '../src/read.ts'
import { testProjections } from './seam.ts'
import { nativeTurn } from './usage-fixture.ts'

function fixture() {
  const method = { environmentId: 'methods', revisionId: 'seed', digest: '1'.repeat(64) }
  const task = (taskId: string, purpose = 'solve', status = 'verified', relatedTo?: string) =>
    ({
      taskId,
      responsibility: { agentId: taskId },
      runs: {
        run: {
          runId: 'run',
          purpose,
          status,
          stage: 'working',
          revision: method,
          ...(relatedTo === undefined ? {} : { relatedTo: { taskId: relatedTo, runId: 'run' } }),
        },
      },
    }) as unknown as TaskState
  const closed = (taskId: string, rsi: string) =>
    ({
      ...task(taskId),
      closure: { runId: 'run', reason: 'accepted' },
      rsi: { status: rsi, detail: 'settled' },
    }) as TaskState
  const tasks = new Map<string, TaskState>([
    ['old', closed('old', 'completed')],
    [
      'old-rsi',
      {
        ...task('old-rsi', 'improve', 'verified', 'old'),
        rounds: [
          { roundId: 'round-old', round: 3, runId: 'run', incumbent: method, candidates: [], status: 'completed' },
        ],
      },
    ],
    ['trial', task('trial', 'evaluation', 'verified', 'old-rsi')],
    ['current', closed('current', 'running')],
    ['rsi', task('rsi', 'improve', 'running', 'current')],
    ['other', closed('other', 'running')],
    ['open', task('open', 'solve', 'running')],
    ['review-evidence', task('review-evidence')],
  ])
  const reviews = new Map([
    [
      'acceptance',
      {
        reviewId: 'acceptance',
        target: { kind: 'acceptance', taskId: 'old' },
        children: [],
        sessionId: 'acceptance-session',
      },
    ],
    [
      'publication',
      {
        reviewId: 'publication',
        target: { kind: 'publication', draftDigest: 'old-draft' },
        status: 'completed',
        children: [{ taskId: 'review-evidence' }],
        sessionId: 'publication-session',
      },
    ],
    [
      'foreign-publication',
      {
        reviewId: 'foreign-publication',
        target: { kind: 'publication', draftDigest: 'other-draft' },
        status: 'completed',
        children: [],
        sessionId: 'foreign-publication-session',
      },
    ],
  ]) as unknown as Map<string, ReviewRun>
  const agents = new Map<string, AgentState>([
    ...[...tasks.keys()].map(
      id => [id, { agentId: id, sessionId: `${id}-session`, role: id.includes('rsi') ? 'improve' : 'root' }] as const,
    ),
    ...[...reviews.values()].map(
      review => [review.reviewId, { agentId: review.reviewId, sessionId: review.sessionId, role: 'review' }] as const,
    ),
  ] as unknown as [string, AgentState][])
  const events = nativeTurn(23)
  const logs = new Map([...agents.values()].map(agent => [agent.sessionId, events]))
  const opened: string[] = [],
    closedHandles: string[] = []
  const apparatus = {
    projections: testProjections,
    store: {
      load: () => ({
        statesOf: (protocol: string) =>
          protocol === TASK_PROTOCOL
            ? tasks
            : protocol === AGENT_PROTOCOL
              ? agents
              : protocol === REVIEW_PROTOCOL
                ? reviews
                : new Map(),
        stateOf: (protocol: string, _version: number, id: string) =>
          protocol === TASK_PROTOCOL ? tasks.get(id) : agents.get(id),
        entries: () =>
          ['old', 'other'].map(id => ({
            kind: 'release/drafted',
            payload: {
              draftDigest: `${id}-draft`,
              basis: { kind: 'decision', roundId: `round-${id}` },
            },
          })),
      }),
    },
    persistence: {
      open: async (id: string) => {
        opened.push(id)
        return {
          header: { id, version: SESSION_FORMAT_VERSION, createdAt: 0, isSeeded: false },
          inheritedEventCount: SessionLogOffset(0),
          read: async (from = 0, count?: number) => ({
            events: logs.get(id)!.slice(from, count === undefined ? undefined : from + count),
          }),
          close: async () => {
            closedHandles.push(id)
          },
        }
      },
    },
  } as unknown as Apparatus
  return {
    apparatus,
    tasks,
    opened,
    closedHandles,
    events,
    read: (input: Parameters<typeof readForAgent>[2]) => readForAgent(apparatus, 'rsi', input),
  }
}

it('offers RSI a closed-root directory and includes business, evaluation and publication review sessions', async () => {
  const h = fixture()
  expect(await h.read({ kind: 'roots' })).toMatchObject({ total: 2, items: [{ rootId: 'old' }, { rootId: 'current' }] })
  expect(h.opened).toEqual([])
  const directory = (await h.read({ kind: 'sessions', rootId: 'old' })) as { items: { sessionId: string }[] }
  expect(directory.items.map(row => row.sessionId)).toEqual([
    'old-session',
    'acceptance-session',
    'old-rsi-session',
    'trial-session',
    'publication-session',
    'review-evidence-session',
  ])
  expect(directory.items[0]).toEqual({ sessionId: 'old-session', eventCount: 5, role: 'root', taskId: 'old' })
  for (const row of directory.items) {
    expect(row).not.toHaveProperty('tokenUsage')
    expect(row).not.toHaveProperty('steps')
  }
  expect(await h.read({ kind: 'sessions', rootId: 'current' })).toMatchObject({
    items: [{ sessionId: 'current-session' }],
  })
  expect(h.closedHandles).toEqual(h.opened)
})

it('returns native usage, native step counts and trajectory pages as independent queries', async () => {
  const h = fixture()
  expect(await h.read({ kind: 'usage', rootId: 'old', ref: 'old-session' })).toMatchObject({
    total: 1,
    items: [
      {
        sessionId: 'old-session',
        source: 'token-meter/tokenUsage',
        tokens: 23,
        tokenUsage: { uncachedInputTokens: 23, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
  })
  expect(await h.read({ kind: 'steps', rootId: 'old', ref: 'old-session' })).toMatchObject({
    items: [{ sessionId: 'old-session', steps: 1, turns: 1, toolCalls: 0 }],
  })
  expect(await h.read({ kind: 'trajectory', rootId: 'old', ref: 'old-session', from: 1, count: 2 })).toMatchObject(
    h.events.slice(1, 3).map(({ seq, time, type }) => ({ seq, time, type })),
  )
  expect(await h.read({ kind: 'sessions', rootId: 'old', from: 2, count: 1 })).toMatchObject({
    total: 6,
    from: 2,
    items: [{ sessionId: 'old-rsi-session' }],
  })
  expect(h.closedHandles).toEqual(h.opened)
})

it('keeps history unavailable to workers, reviewers and sessions outside the selected closed root', async () => {
  const h = fixture()
  for (const agentId of ['old', 'acceptance', 'stranger'])
    await expect(readForAgent(h.apparatus, agentId, { kind: 'roots' })).rejects.toThrow('working RSI')
  for (const rootId of ['open', 'other'])
    await expect(h.read({ kind: 'sessions', rootId })).rejects.toThrow('closed subject')
  for (const ref of ['rsi-session', 'other-session', 'foreign-publication-session'])
    await expect(h.read({ kind: 'trajectory', rootId: 'old', ref })).rejects.toThrow('outside the selected root')
  for (const count of [0, 101]) await expect(h.read({ kind: 'roots', count })).rejects.toThrow('history pages')
  await expect(h.read({ kind: 'trajectory', rootId: 'old' })).rejects.toThrow('requires ref')
  expect(h.opened).toEqual([])
})

it('indexes large native events and reconstructs their exact JSON through bounded UTF-8 pages', async () => {
  const h = fixture()
  const original = h.events.find(event => event.type === 'assistant/message')!
  if (original.type !== 'assistant/message') throw new Error('expected native assistant event')
  const event = {
    ...original,
    data: {
      ...original.data,
      message: { ...original.data.message, content: [{ type: 'text' as const, text: '证据🙂\n'.repeat(20_000) }] },
    },
  }
  h.events[2] = event
  const index = await h.read({ kind: 'trajectory', rootId: 'old', ref: 'old-session' })
  expect(JSON.stringify(index).length).toBeLessThan(2000)
  expect(index).toEqual(expect.arrayContaining([expect.objectContaining({ seq: 2, bytes: expect.any(Number) })]))
  let from = 0,
    text = ''
  while (true) {
    const page = (await h.read({
      kind: 'trajectory',
      rootId: 'old',
      ref: 'old-session',
      eventSeq: 2,
      from,
      count: 8192,
    })) as { next: number; complete: boolean; text: string }
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(8192)
    expect(page.text).not.toContain('\ufffd')
    text += page.text
    if (page.complete) break
    expect(page.next).toBeGreaterThan(from)
    from = page.next
  }
  expect(JSON.parse(text)).toEqual(event)
  expect(text).toBe(JSON.stringify(event, null, 2))
  await expect(h.read({ kind: 'trajectory', rootId: 'old', ref: 'old-session', eventSeq: 99 })).rejects.toThrow(
    'outside this readable trajectory',
  )
  await expect(
    h.read({ kind: 'trajectory', rootId: 'old', ref: 'old-session', eventSeq: 2, count: 8193 }),
  ).rejects.toThrow('8192')
  const byteOffset = Buffer.from(text).indexOf(Buffer.from('证据')) + 1
  await expect(
    h.read({ kind: 'trajectory', rootId: 'old', ref: 'old-session', eventSeq: 2, from: byteOffset }),
  ).rejects.toThrow('UTF-8')
})
