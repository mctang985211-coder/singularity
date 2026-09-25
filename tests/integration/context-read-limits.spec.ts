import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskEvent } from '../../task/src/index.ts'
import { CONTEXT_OUTPUT_LIMIT_BYTES } from '../../context/src/index.ts'
import { startAssemblyStack, type AssemblyStack } from '../support/assembly-stack.ts'

/** The smallest fixture that is really over the bound: the bound plus a few KB. */
const OVER_BOUND_BYTES = CONTEXT_OUTPUT_LIMIT_BYTES + 5_000

/**
 * Q3/Q4 (2026-09-25 rework), at the tool door the model actually calls: the real
 * `context_read` and `task_status` adapters over the real context read core, the
 * real store and the real session log. The unit cases in
 * `context/tests/unit/reads.spec.ts` pin the fields (`hasMore`, `nextOffset`,
 * `source`); what this file adds is the text a model would be handed, through
 * the deployment's own registry, for the two shapes the review named:
 *
 * - a session whose log answers one window and then fails, and a single session
 *   event larger than the bound;
 * - a task whose summary line is larger than the bound, at `limit: 1` and inside
 *   a larger page.
 *
 * The property both halves hold is the same: a page either advances and says
 * where to continue, or it refuses by name and says what to do instead. Nothing
 * is cut, nothing is passed over silently, and every refusal names the record it
 * is about.
 */

/** What one tool call answered. */
interface ToolAnswer {
  readonly isError: boolean
  readonly text: string
}

const stacks: AssemblyStack[] = []

async function boot(options: Parameters<typeof startAssemblyStack>[0] = {}): Promise<AssemblyStack> {
  const stack = await startAssemblyStack(options)
  stacks.push(stack)
  return stack
}

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    await Promise.race([
      stack.dispose({ remove: stack.dir.includes('singularity-assembly-') }),
      new Promise(resolve => { setTimeout(resolve, 2_000).unref() }),
    ])
  }
  vi.unstubAllEnvs()
})

/** One seeded child task whose summary line is far past the output bound. */
async function oversizedTask(stack: AssemblyStack, storeId: string, parentTaskId: string): Promise<string> {
  const taskId = 't-enormous'
  await stack.task.createTaskIn(storeId, {
    taskId,
    definitionRef: { taskType: 'subtask', version: 1 },
    parentTaskId,
    objective: `an objective no page can carry ${'z'.repeat(OVER_BOUND_BYTES)}`,
    depth: 1,
    acceptanceCriteria: [{
      criterionId: 'ac-enormous',
      description: 'it holds',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 's-root')
  await stack.task.admitTaskIn(storeId, taskId, 's-root', { decompositionStatus: 'leaf' })
  return taskId
}

/** One child task with a summary line that fits, so a page can still show it. */
async function ordinaryTask(stack: AssemblyStack, storeId: string, taskId: string, parentTaskId: string): Promise<void> {
  await stack.task.createTaskIn(storeId, {
    taskId,
    definitionRef: { taskType: 'subtask', version: 1 },
    parentTaskId,
    objective: `${taskId}: a summary that fits a page`,
    depth: 1,
    acceptanceCriteria: [{
      criterionId: `${taskId}-ac`,
      description: 'it holds',
      verificationMode: 'deterministic',
      requiredEvidence: [],
      mandatory: true,
      command: 'true',
    }],
    requestedCapabilities: [],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 's-root')
  await stack.task.admitTaskIn(storeId, taskId, 's-root', { decompositionStatus: 'leaf' })
}

/** The task ids one status page listed, in order, from the page's own lines. */
function listed(text: string): string[] {
  return [...text.matchAll(/^- (t-[a-z0-9-]+) \[/gm)].map(match => match[1] as string)
}

describe('the status page a model is handed (Q4)', () => {
  it('refuses an entry no page can carry by name, points at its own record, and still reaches the end of the scope', async () => {
    const stack = await boot({ worker: async () => {} })
    const storeId = stack.storeIdOf('s-root')
    await stack.seedLog('s-root', ['ship the release'])
    const root = await stack.runtime.intakeRootContract(storeId, 's-root', {
      objective: 'ship the release',
      acceptanceCriteria: [{ criterionId: 'root-goal', description: 'the release is shipped', command: 'true' }],
    })
    await ordinaryTask(stack, storeId, 't-aaa', root.taskId)
    const oversized = await oversizedTask(stack, storeId, root.taskId)
    // One more short task *after* it, so the oversized entry sits in the middle
    // of the scope and the walk below has to get past it either way.
    await ordinaryTask(stack, storeId, 't-zzz', root.taskId)
    const tasks = (await stack.snapshot(storeId)).tasks.map(task => task.taskId).sort()
    const index = tasks.indexOf(oversized)
    expect(index).toBeGreaterThan(0)
    expect(index).toBeLessThan(tasks.length - 1)

    // A page whose *first* entry is the oversized one: the same page would be
    // returned for the same offset forever, so it refuses by name instead — and
    // names both ways forward.
    const alone = await stack.call('s-root', 'task_status', { scope: 'graph', offset: index, limit: 1 })
    expect(alone.text).toContain('task_status context-too-large')
    expect(alone.text).toContain(oversized)
    expect(alone.text).toContain('`context_read` kind:"task" ref:"t-enormous"')
    expect(alone.text).toContain(`offset ${index + 1}`)
    expect(alone.text).not.toContain('more: yes — continue with offset ' + index + '\n')

    // The reference the refusal gives is real: the record itself reads, in pages.
    const record = await stack.call('s-root', 'context_read', { kind: 'task', ref: oversized })
    expect(record.isError).toBe(false)
    expect(record.text).toContain(`# context_read task ${oversized}`)
    expect(record.text).toContain('more of this record follows')
    expect(record.text).toContain('an objective no page can carry')

    // And the listing still reaches its end: pages advance, the oversized entry
    // is named rather than skipped, and the caller's own explicit jump past it
    // (the offset the refusal gave) continues the walk.
    const seen: string[] = []
    let offset = 0
    for (let page = 0; page < 20; page += 1) {
      const answer: ToolAnswer = await stack.call('s-root', 'task_status', { scope: 'graph', offset, limit: 2 })
      expect(answer.text).not.toContain('more: yes — continue with offset ' + offset + '\n')
      if (answer.text.includes('context-too-large')) {
        expect(answer.text).toContain(oversized)
        offset += 1
        continue
      }
      seen.push(...listed(answer.text))
      if (answer.text.includes('this is the end of the scope')) break
      const next = /more: yes — continue with offset (\d+)/.exec(answer.text)
      expect(next, answer.text).not.toBeNull()
      offset = Number(next![1])
    }
    expect(seen).toContain('t-aaa')
    expect(seen.filter(id => id === oversized)).toHaveLength(0)
    expect(seen.length).toBe(tasks.length - 1)
  })
})

describe('the session page a model is handed (Q3)', () => {
  it('refuses an event larger than the bound by name instead of cutting it, and stops a later one at its own seq', async () => {
    const stack = await boot({ worker: async () => {} })
    const giant = 'y'.repeat(OVER_BOUND_BYTES)
    await stack.seedLog('s-root', ['the first event', giant])

    // The oversized event is the page's first: nothing of it is shown, and the
    // refusal says why there is no second page inside one event.
    const first = await stack.call('s-root', 'context_read', { kind: 'session', ref: 's-root', offset: 1, limit: 1 })
    expect(first.text).toContain('context_read context-too-large')
    expect(first.text).toContain('event seq 1')
    expect(first.text).toContain(`does not fit one ${CONTEXT_OUTPUT_LIMIT_BYTES}-byte page`)
    // The refusal names the event and hands back the reference that reads it
    // (Q3 closure): the listing's own cursor passes the event and shows none of
    // its text, which the refusal says outright rather than implying a read.
    expect(first.text).toContain('ref:{"sessionId":"s-root","seq":1}')
    expect(first.text).toContain('none of its text is shown')
    expect(first.text).toContain('offset 2')
    expect(first.text).toMatch(/not a way to read/i)
    expect(first.text).not.toContain(giant)

    // A page that meets it *after* an event it can carry ends before it, at the
    // oversized event's own seq — never past it.
    const stopped = await stack.call('s-root', 'context_read', { kind: 'session', ref: 's-root', offset: 0, limit: 2 })
    expect(stopped.isError).toBe(false)
    expect(stopped.text).toContain('seq 0 | user/message')
    expect(stopped.text).toContain('the first event')
    expect(stopped.text).toMatch(/more follows from seq 1\b/)
    // The page that stops before the event names that event's own reference too.
    expect(stopped.text).toContain('ref:{"sessionId":"s-root","seq":1}')
    expect(stopped.text).not.toContain(giant)
    expect(stopped.text).not.toContain('more follows from seq 2')

    // Asking at that seq is the named refusal again, and only the caller's own
    // explicit skip moves the read past it.
    const atGiant = await stack.call('s-root', 'context_read', { kind: 'session', ref: 's-root', offset: 1, limit: 2 })
    expect(atGiant.text).toContain('context_read context-too-large')
    const past = await stack.call('s-root', 'context_read', { kind: 'session', ref: 's-root', offset: 2, limit: 2 })
    expect(past.isError).toBe(false)
    expect(past.text).toContain('at or past the end of the log')
  })

  it('never hands back a half-read page when the log stops answering mid-page', async () => {
    const stack = await boot({ worker: async () => {} })
    // More events than one session-query window carries, so the read really needs
    // a second window.
    await stack.seedLog('s-root', Array.from({ length: 60 }, (_value, index) => `event ${index}`))
    // The session plane's own read, failing on its second window: the first
    // window answers, the page cannot be completed, and half a log is not a page.
    const query = stack.ctx.get('sessionQuery') as unknown as {
      readEvent: (request: { sessionId: string; seq: number; before?: number; after?: number }, signal?: AbortSignal) => Promise<unknown>
    }
    const read = query.readEvent.bind(query)
    let windows = 0
    query.readEvent = async (request, signal) => {
      windows += 1
      if (windows === 2) throw new Error('the session log backend stopped answering')
      return await read(request, signal)
    }

    const answer = await stack.call('s-root', 'context_read', { kind: 'session', ref: 's-root', offset: 0, limit: 100 })
    expect(windows).toBe(2)
    expect(answer.text).toContain('context_read unreadable')
    expect(answer.text).toContain('could not be read at seq 50')
    expect(answer.text).toContain('Nothing partial is returned')
    expect(answer.text).not.toContain('event 0')
    expect(answer.text).not.toContain('events shown')
  })
})
